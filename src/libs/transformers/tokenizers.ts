import { Callable } from './utils/generic';

import { reverseDictionary, escapeRegExp, isIntegralNumber, mergeArrays, len, ProgressCallback } from './utils/core';

import { getModelJSON } from './utils/hub';

import { max, min, round } from './utils/maths';
import { Tensor } from './utils/tensor';

import { PriorityQueue, TokenLattice, CharTrie } from './utils/data-structures';

import { Template } from '@huggingface/jinja';
import { PretrainedOptions } from './utils/hub';
import { WHISPER_LANGUAGE_MAPPING } from './models/whisper/common_whisper';
import { PretrainedConfig } from './configs';

type TokenizerProperties = {
    legacy?: boolean;
};
type PretrainedTokenizerOptions = PretrainedOptions & TokenizerProperties;
/**
 * @typedef {Object} TokenizerProperties Additional tokenizer-specific properties.
 * @property {boolean} [legacy=false] Whether or not the `legacy` behavior of the tokenizer should be used.
 * @typedef {import('./utils/hub.js').PretrainedOptions & TokenizerProperties} PretrainedTokenizerOptions
 */

/**
 * Loads a tokenizer from the specified path.
 * @param {string} pretrained_model_name_or_path The path to the tokenizer directory.
 * @param {PretrainedTokenizerOptions} options Additional options for loading the tokenizer.
 * @returns {Promise<any[]>} A promise that resolves with information about the loaded tokenizer.
 */
async function loadTokenizer(pretrained_model_name_or_path: string, options: PretrainedTokenizerOptions) {
    var info = await Promise.all([
        getModelJSON(pretrained_model_name_or_path, 'tokenizer.json', true, options),
        getModelJSON(pretrained_model_name_or_path, 'tokenizer_config.json', true, options),
    ]);

    // Override legacy option if `options.legacy` is not null
    if (options.legacy !== null) {
        info[1].legacy = options.legacy;
    }
    return info;
}

/**
 * Helper function to split a string on a regex, but keep the delimiters.
 * This is required, because the JavaScript `.split()` method does not keep the delimiters,
 * and wrapping in a capturing group causes issues with existing capturing groups (due to nesting).
 * @param {string} text The text to split.
 * @param {RegExp} regex The regex to split on.
 * @returns {string[]} The split string.
 */
function regexSplit(text: string, regex: RegExp) {
    var result = [];
    let prev = 0;
    for (var match of text.matchAll(regex)) {
        var fullMatch = match[0];
        if (prev < match.index) {
            result.push(text.slice(prev, match.index));
        }
        if (fullMatch.length > 0) {
            result.push(fullMatch);
        }
        prev = match.index + fullMatch.length;
    }
    if (prev < text.length) {
        result.push(text.slice(prev));
    }
    return result;
}

/**
 * Helper method to construct a pattern from a config object.
 * @param {Object} pattern The pattern object.
 * @param {boolean} invert Whether to invert the pattern.
 * @returns {RegExp|null} The compiled pattern.
 */
function createPattern(pattern: { Regex: string; String: string }, invert = true) {
    if (pattern.Regex !== undefined) {
        // In certain cases, the pattern may contain unnecessary escape sequences (e.g., \# or \& or \~).
        // i.e., valid in Python (where the patterns are exported from) but invalid in JavaScript (where the patterns are parsed).
        // This isn't an issue when creating the regex w/o the 'u' flag, but it is when the 'u' flag is used.
        // For this reason, it is necessary to remove these backslashes before creating the regex.
        // See https://stackoverflow.com/a/63007777/13989043 for more information
        let regex = pattern.Regex.replace(/\\([#&~])/g, '$1'); // TODO: add more characters to this list if necessary

        // We also handle special cases where the regex contains invalid (non-JS compatible) syntax.
        for (var [key, value] of PROBLEMATIC_REGEX_MAP) {
            regex = regex.replaceAll(key, value);
        }

        return new RegExp(regex, 'gu');
    } else if (pattern.String !== undefined) {
        var escaped = escapeRegExp(pattern.String);
        // NOTE: if invert is true, we wrap the pattern in a group so that it is kept when performing .split()
        return new RegExp(invert ? escaped : `(${escaped})`, 'gu');
    } else {
        console.warn('Unknown pattern type:', pattern);
        return null;
    }
}

/**
 * Helper function to convert an Object to a Map
 * @param {Object} obj The object to convert.
 * @returns {Map<string, any>} The map.
 */
function objectToMap(obj: object) {
    return new Map(Object.entries(obj));
}

/**
 * Helper function to convert a tensor to a list before decoding.
 * @param {Tensor} tensor The tensor to convert.
 * @returns {number[]} The tensor as a list.
 */
function prepareTensorForDecode(tensor: Tensor) {
    var dims = tensor.dims;
    switch (dims.length) {
        case 1:
            return tensor.tolist();
        case 2:
            if (dims[0] !== 1) {
                throw new Error(
                    'Unable to decode tensor with `batch size !== 1`. Use `tokenizer.batch_decode(...)` for batched inputs.',
                );
            }
            return tensor.tolist()[0];
        default:
            throw new Error(`Expected tensor to have 1-2 dimensions, got ${dims.length}.`);
    }
}

/**
 * Clean up a list of simple English tokenization artifacts like spaces before punctuations and abbreviated forms
 * @param {string} text The text to clean up.
 * @returns {string} The cleaned up text.
 */
function clean_up_tokenization(text: string) {
    // Clean up a list of simple English tokenization artifacts
    // like spaces before punctuations and abbreviated forms
    return text
        .replace(/ \./g, '.')
        .replace(/ \?/g, '?')
        .replace(/ \!/g, '!')
        .replace(/ ,/g, ',')
        .replace(/ \' /g, "'")
        .replace(/ n\'t/g, "n't")
        .replace(/ \'m/g, "'m")
        .replace(/ \'s/g, "'s")
        .replace(/ \'ve/g, "'ve")
        .replace(/ \'re/g, "'re");
}

/**
 * Helper function to remove accents from a string.
 * @param {string} text The text to remove accents from.
 * @returns {string} The text with accents removed.
 */
function remove_accents(text: string) {
    return text.replace(/\p{M}/gu, '');
}

/**
 * Helper function to lowercase a string and remove accents.
 * @param {string} text The text to lowercase and remove accents from.
 * @returns {string} The lowercased text with accents removed.
 */
function lowercase_and_remove_accent(text: string) {
    return remove_accents(text.toLowerCase());
}

/**
 * Checks whether the given Unicode codepoint represents a CJK (Chinese, Japanese, or Korean) character.
 *
 * A "chinese character" is defined as anything in the CJK Unicode block:
 * https://en.wikipedia.org/wiki/CJK_Unified_Ideographs_(Unicode_block)
 *
 * Note that the CJK Unicode block is NOT all Japanese and Korean characters, despite its name.
 * The modern Korean Hangul alphabet is a different block, as is Japanese Hiragana and Katakana.
 * Those alphabets are used to write space-separated words, so they are not treated specially
 * and are handled like all other languages.
 *
 * @param {number|bigint} cp The Unicode codepoint to check.
 * @returns {boolean} True if the codepoint represents a CJK character, false otherwise.
 */
export function is_chinese_char(cp: number | bigint) {
    return (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x20000 && cp <= 0x2a6df) ||
        (cp >= 0x2a700 && cp <= 0x2b73f) ||
        (cp >= 0x2b740 && cp <= 0x2b81f) ||
        (cp >= 0x2b820 && cp <= 0x2ceaf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x2f800 && cp <= 0x2fa1f)
    );
}

/**
 * Helper function to fuse consecutive unknown tokens.
 * @param {string[]} arr The list of input tokens
 * @param {Map<string, any>} tokens_to_ids The mapping from tokens to token ids.
 * @param {number} unk_token_id The value to fuse on.
 * @private
 */
function fuse_unk(arr: string[], tokens_to_ids: Map<string, any>, unk_token_id: number) {
    var fused = [];
    let i = 0;
    while (i < arr.length) {
        fused.push(arr[i]);
        if ((tokens_to_ids.get(arr[i]) ?? unk_token_id) !== unk_token_id) {
            ++i;
            continue;
        }

        while (++i < arr.length && (tokens_to_ids.get(arr[i]) ?? unk_token_id) === unk_token_id) {
            if (tokens_to_ids.get(fused.at(-1)!) !== unk_token_id) {
                fused[fused.length - 1] += arr[i];
            }
        }
    }

    return fused;
}

/**
 * Split a string on whitespace.
 * @param {string} text The text to split.
 * @returns {string[]} The split string.
 */
function whitespace_split(text: string) {
    return text.match(/\S+/g) || [];
}

var PUNCTUATION_REGEX = '\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E';
var PUNCTUATION_ONLY_REGEX = new RegExp(`^[${PUNCTUATION_REGEX}]+$`, 'gu');
var BLOOM_SPLIT_CHARS = '.,!?\u2026\u3002\uff0c\u3001\u0964\u06d4\u060c';

// A mapping of regex patterns to their equivalent (but possibly longer) JS-compatible versions.
var PROBLEMATIC_REGEX_MAP = new Map([
    // This uses the case insensitive group modifier, which is not supported in JavaScript.
    // When parsing the regex, an "Invalid group" error is thrown.
    ["(?i:'s|'t|'re|'ve|'m|'ll|'d)", "(?:'([sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD]))"],

    // Used to override the default (invalid) regex of the bloom pretokenizer.
    // For more information, see https://github.com/huggingface/transformers.js/issues/94
    [` ?[^(\\s|[${BLOOM_SPLIT_CHARS}])]+`, ` ?[^\\s${BLOOM_SPLIT_CHARS}]+`],
]);

/**
 * Represent a token added by the user on top of the existing Model vocabulary.
 * AddedToken can be configured to specify the behavior they should have in various situations like:
 *   - Whether they should only match single words
 *   - Whether to include any whitespace on its left or right
 */
class AddedToken {
    /**
     * Creates a new instance of AddedToken.
     * @param {Object} config Added token configuration object.
     * @param {string} config.content The content of the added token.
     * @param {number} config.id The id of the added token.
     * @param {boolean} [config.single_word=false] Whether this token must be a single word or can break words.
     * @param {boolean} [config.lstrip=false] Whether this token should strip whitespaces on its left.
     * @param {boolean} [config.rstrip=false] Whether this token should strip whitespaces on its right.
     * @param {boolean} [config.normalized=false] Whether this token should be normalized.
     * @param {boolean} [config.special=false] Whether this token is special.
     */
    content: string;
    id: number;
    single_word?: boolean;
    lstrip?: boolean;
    rstrip?: boolean;
    special?: boolean;
    normalized?: boolean;
    constructor(config: {
        content: string;
        id: number;
        single_word?: boolean;
        lstrip?: boolean;
        rstrip?: boolean;
        special?: boolean;
        normalized?: boolean;
    }) {
        this.content = config.content;
        this.id = config.id;
        this.single_word = config.single_word ?? false;
        this.lstrip = config.lstrip ?? false;
        this.rstrip = config.rstrip ?? false;
        this.special = config.special ?? false;
        this.normalized = config.normalized ?? false;
    }
}

/**
 * Abstract base class for tokenizer models.
 *
 * @extends Callable
 */
export class TokenizerModel extends Callable {
    /**
     * Creates a new instance of TokenizerModel.
     * @param {Object} config The configuration object for the TokenizerModel.
     */
    vocab: string[];
    tokens_to_ids: Map<string, number>;
    unk_token_id: number | undefined;
    unk_token: string | undefined;
    end_of_word_suffix: string | undefined;
    fuse_unk: boolean;
    config: {
        vocab: string[];
        tokens_to_ids: Map<string, number>;
        unk_token_id: number | undefined;
        unk_token: string | undefined;
        end_of_word_suffix: string | undefined;
        fuse_unk: boolean;
    };

    constructor(config: {
        vocab: string[];
        tokens_to_ids: Map<string, number>;
        unk_token_id: number | undefined;
        unk_token: string | undefined;
        end_of_word_suffix: string | undefined;
        fuse_unk: boolean;
    }) {
        super();
        this.config = config;

        /** @type {string[]} */
        this.vocab = [];

        /**
         * A mapping of tokens to ids.
         * @type {Map<string, number>}
         */
        this.tokens_to_ids = new Map();

        this.unk_token_id = undefined;
        this.unk_token = undefined;
        this.end_of_word_suffix = undefined;

        /** @type {boolean} Whether to fuse unknown tokens when encoding. Defaults to false. */
        this.fuse_unk = this.config.fuse_unk ?? false;
    }

    /**
     * Instantiates a new TokenizerModel instance based on the configuration object provided.
     * @param {Object} config The configuration object for the TokenizerModel.
     * @param {...*} args Optional arguments to pass to the specific TokenizerModel constructor.
     * @returns {TokenizerModel} A new instance of a TokenizerModel.
     * @throws Will throw an error if the TokenizerModel type in the config is not recognized.
     */
    static fromConfig(
        config: {
            type: string;
            vocab: string[];
            tokens_to_ids: Map<string, number>;
            unk_token_id: number | undefined;
            unk_token: string | undefined;
            end_of_word_suffix: string | undefined;
            fuse_unk: boolean;
        },
        ...args: any[]
    ) {
        switch (config.type) {
            case 'WordPiece':
                return new WordPieceTokenizer(config);
            case 'Unigram':
                // @ts-ignore
                return new Unigram(config, ...args);
            case 'BPE':
                return new BPE(config as any);

            default:
                // Some tokenizers, like for google-t5/t5-small, do not have a `type` field.
                // In this case, we can infer the tokenizer type based on the structure of the `vocab` field.
                if (config.vocab) {
                    if (Array.isArray(config.vocab)) {
                        // config.vocab is of type `[string, number][]`
                        // @ts-ignore
                        return new Unigram(config, ...args);
                    } else {
                        // @ts-ignore
                        return new LegacyTokenizerModel(config, ...args);
                    }
                }
                throw new Error(`Unknown TokenizerModel type: ${config.type}`);
        }
    }

    /**
     * Internal function to call the TokenizerModel instance.
     * @param {string[]} tokens The tokens to encode.
     * @returns {string[]} The encoded tokens.
     */
    _call(tokens: string[]) {
        tokens = this.encode(tokens);
        if (this.fuse_unk) {
            // Fuse unknown tokens
            tokens = fuse_unk(tokens, this.tokens_to_ids, this.unk_token_id!);
        }
        return tokens;
    }

    /**
     * Encodes a list of tokens into a list of token IDs.
     * @param {string[]} tokens The tokens to encode.
     * @returns {string[]} The encoded tokens.
     * @throws Will throw an error if not implemented in a subclass.
     */
    encode(tokens: string[]): string[] {
        throw Error('encode should be implemented in subclass.');
    }

    /**
     * Converts a list of tokens into a list of token IDs.
     * @param {string[]} tokens The tokens to convert.
     * @returns {number[]} The converted token IDs.
     */
    convert_tokens_to_ids(tokens: string[]) {
        return tokens.map((t) => this.tokens_to_ids.get(t) ?? this.unk_token_id);
    }

    /**
     * Converts a list of token IDs into a list of tokens.
     * @param {number[]|bigint[]} ids The token IDs to convert.
     * @returns {string[]} The converted tokens.
     */
    convert_ids_to_tokens(ids: number[] | bigint[]) {
        return ids.map((i: number | bigint) => this.vocab[i as number] ?? this.unk_token);
    }
}

/**
 * A subclass of TokenizerModel that uses WordPiece encoding to encode tokens.
 * @extends TokenizerModel
 */
class WordPieceTokenizer extends TokenizerModel {
    /**
     * @param {Object} config The configuration object.
     * @param {Object} config.vocab A mapping of tokens to ids.
     * @param {string} config.unk_token The unknown token string.
     * @param {string} config.continuing_subword_prefix The prefix to use for continuing subwords.
     * @param {number} [config.max_input_chars_per_word=100] The maximum number of characters per word.
     */
    max_input_chars_per_word: number;
    constructor(config: any) {
        super(config as any);
        /**
         * A mapping of tokens to ids.
         * @type {Map<string, number>}
         */
        this.tokens_to_ids = objectToMap(config.vocab);

        /**
         * The id of the unknown token.
         * @type {number}
         */
        this.unk_token_id = this.tokens_to_ids.get(config.unk_token);

        /**
         * The unknown token string.
         * @type {string}
         */
        this.unk_token = config.unk_token;

        /**
         * The maximum number of characters allowed per word.
         * @type {number}
         */
        this.max_input_chars_per_word = config.max_input_chars_per_word ?? 100;

        /**
         * An array of tokens.
         * @type {string[]}
         */
        this.vocab = new Array(this.tokens_to_ids.size);
        for (var [key, value] of this.tokens_to_ids) {
            this.vocab[value] = key;
        }
    }

    /**
     * Encodes an array of tokens using WordPiece encoding.
     * @param {string[]} tokens The tokens to encode.
     * @returns {string[]} An array of encoded tokens.
     */
    encode(tokens: string[]): string[] {
        var outputTokens: string[] = [];
        for (var token of tokens) {
            var chars = [...token];
            if (chars.length > this.max_input_chars_per_word) {
                outputTokens.push(this.unk_token as string);
                continue;
            }

            let isUnknown = false;
            let start = 0;
            var subTokens = [];

            while (start < chars.length) {
                let end = chars.length;
                let currentSubstring = null;
                while (start < end) {
                    let substr = chars.slice(start, end).join('');

                    if (start > 0) {
                        substr = (this as any).config.continuing_subword_prefix + substr;
                    }
                    if (this.tokens_to_ids.has(substr)) {
                        currentSubstring = substr;
                        break;
                    }

                    --end;
                }
                if (currentSubstring === null) {
                    isUnknown = true;
                    break;
                }
                subTokens.push(currentSubstring);
                start = end;
            }
            if (isUnknown) {
                outputTokens.push(this.unk_token as string);
            } else {
                outputTokens.push(...subTokens);
            }
        }

        return outputTokens;
    }
}

/**
 * Class representing a Unigram tokenizer model.
 * @extends TokenizerModel
 */
class Unigram extends TokenizerModel {
    /**
     * Create a new Unigram tokenizer model.
     * @param {Object} config The configuration object for the Unigram model.
     * @param {number} config.unk_id The ID of the unknown token
     * @param {[string, number][]} config.vocab A 2D array representing a mapping of tokens to scores.
     * @param {Object} moreConfig Additional configuration object for the Unigram model.
     */
    unk_token_id: number | undefined;
    scores: number[];
    bos_token: string;
    eos_token: string;
    bos_token_id: number | undefined;
    eos_token_id: number | undefined;
    minScore: number | BigInt;
    unk_score: number | BigInt;
    trie: CharTrie;
    fuse_unk: boolean;

    constructor(
        config: {
            unk_id: number;
            vocab: [string, number][];
        },
        moreConfig: {
            eos_token: string;
        },
    ) {
        super(config as any);

        var vocabSize = config.vocab.length;
        this.vocab = new Array(vocabSize);
        /** @type {number[]} */
        this.scores = new Array(vocabSize);
        for (let i = 0; i < vocabSize; ++i) {
            [this.vocab[i], this.scores[i]] = config.vocab[i];
        }

        this.unk_token_id = config.unk_id;
        this.unk_token = this.vocab[config.unk_id];

        this.tokens_to_ids = new Map(this.vocab.map((x, i) => [x, i]));
        this.bos_token = ' '; // beginning of a sentence token

        this.bos_token_id = this.tokens_to_ids.get(this.bos_token); // NOTE: may be undefined
        this.eos_token = moreConfig.eos_token;

        this.eos_token_id = this.tokens_to_ids.get(this.eos_token);
        this.unk_token = this.vocab[this.unk_token_id];

        this.minScore = min(this.scores)[0];

        this.unk_score = Number(this.minScore) - 10.0;
        this.scores[this.unk_token_id] = this.unk_score;

        this.trie = new CharTrie();
        this.trie.extend(this.vocab);

        // NOTE: `fuse_unk` is hardcoded to true for Unigram models
        // See: https://github.com/huggingface/tokenizers/blob/b58227c7f1ccf8b73ee2268354336da56d91e492/tokenizers/src/models/unigram/model.rs#L119
        this.fuse_unk = true;
    }

    /**
     * Populates lattice nodes.
     * @param {TokenLattice} lattice The token lattice to populate with nodes.
     */
    populateNodes(lattice: TokenLattice) {
        var chars = lattice._chars;
        var mblen = 1;
        let beginPos = 0;
        while (beginPos < chars.length) {
            let hasSingleNode = false;

            var tokens = [];
            var sliced = chars.slice(beginPos).join('');
            var prefixedTokens = this.trie.commonPrefixSearch(sliced);
            for (var token of prefixedTokens) {
                tokens.push(token);
                var tokenId = this.tokens_to_ids.get(token);
                var tokenScore = this.scores[tokenId as number];
                var n = len(token);
                lattice.insert(beginPos, n, tokenScore, tokenId as number);
                if (!hasSingleNode && n === mblen) {
                    hasSingleNode = true;
                }
            }
            if (!hasSingleNode) {
                lattice.insert(beginPos, mblen, Number(this.unk_score), this.unk_token_id as number);
            }
            beginPos += mblen;
        }
    }

    /**
     * Encodes an array of tokens into an array of subtokens using the unigram model.
     *
     * @param {string} normalized The normalized string.
     * @returns {string[]} An array of subtokens obtained by encoding the input tokens using the unigram model.
     */
    tokenize(normalized: string) {
        var lattice = new TokenLattice(normalized, this.bos_token_id as number, this.eos_token_id as number);
        this.populateNodes(lattice);
        return lattice.tokens();
    }

    /**
     * Encodes an array of tokens using Unigram encoding.
     * @param {string[]} tokens The tokens to encode.
     * @returns {string[]} An array of encoded tokens.
     */
    encode(tokens: string[]) {
        var toReturn = [];
        for (var token of tokens) {
            var tokenized = this.tokenize(token);
            toReturn.push(...tokenized);
        }
        return toReturn;
    }
}

/**
 * Returns list of utf-8 byte and a mapping to unicode strings.
 * Specifically avoids mapping to whitespace/control characters the BPE code barfs on.
 * @returns {Object} Object with utf-8 byte keys and unicode string values.
 */
var BYTES_TO_UNICODE = (() => {
    // Returns list of utf-8 byte and a mapping to unicode strings.
    // We specifically avoids mapping to whitespace/control characters
    // the bpe code barfs on.

    var bs = [
        ...Array.from({ length: '~'.charCodeAt(0) - '!'.charCodeAt(0) + 1 }, (_, i) => i + '!'.charCodeAt(0)),
        ...Array.from({ length: '¬'.charCodeAt(0) - '¡'.charCodeAt(0) + 1 }, (_, i) => i + '¡'.charCodeAt(0)),
        ...Array.from({ length: 'ÿ'.charCodeAt(0) - '®'.charCodeAt(0) + 1 }, (_, i) => i + '®'.charCodeAt(0)),
    ];
    var cs = bs.slice();
    let n = 0;
    for (let b = 0; b < 256; ++b) {
        if (!bs.includes(b)) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    var ccs = cs.map((n) => String.fromCharCode(n));
    return Object.fromEntries(bs.map((b, i) => [b, ccs[i]]));
})();

var UNICODE_TO_BYTES = reverseDictionary(BYTES_TO_UNICODE);

/**
 * @typedef {Object} BPENode
 * @property {string} token The token associated with the node
 * @property {number} bias A positional bias for the node.
 * @property {number} [score] The score of the node.
 * @property {BPENode} [prev] The previous node in the linked list.
 * @property {BPENode} [next] The next node in the linked list.
 */

/**
 * BPE class for encoding text into Byte-Pair-Encoding (BPE) tokens.
 * @extends TokenizerModel
 */
class BPE extends TokenizerModel {
    /**
     * Create a BPE instance.
     * @param {Object} config The configuration object for BPE.
     * @param {Object} config.vocab A mapping of tokens to ids.
     * @param {string[]|[string, string][]} config.merges An array of BPE merges as strings.
     * @param {string} config.unk_token The unknown token used for out of vocabulary words.
     * @param {string} config.end_of_word_suffix The suffix to place at the end of each word.
     * @param {string} [config.continuing_subword_suffix] The suffix to insert between words.
     * @param {boolean} [config.byte_fallback=false] Whether to use spm byte-fallback trick (defaults to False)
     * @param {boolean} [config.ignore_merges=false] Whether or not to match tokens with the vocab before using merges.
     */
    ignore_merges: boolean;
    merges: [string, string][];
    bpe_ranks: Map<string, number>;
    end_of_word_suffix: string;
    continuing_subword_suffix: string | null;
    byte_fallback: boolean;
    cache: Map<string, string[]>;
    text_encoder: any;
    constructor(config: {
        vocab: string[];
        merges: string[] | [string, string][];
        unk_token: string;
        end_of_word_suffix: string;
        continuing_subword_suffix?: string;
        byte_fallback?: boolean;
        ignore_merges?: boolean;
    }) {
        super(config as any);

        /** @type {Map<string, number>} */
        this.tokens_to_ids = objectToMap(config.vocab);

        this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
        this.unk_token = config.unk_token;

        this.vocab = new Array(this.tokens_to_ids.size);
        for (var [key, value] of this.tokens_to_ids) {
            this.vocab[value] = key;
        }

        // Tokenizers >= 0.20.0 serializes BPE merges as a [string, string][] instead of a string[],
        // which resolves the ambiguity for merges containing spaces.
        var use_new_merge_format = Array.isArray(config.merges[0]);

        /** @type {[string, string][]} */
        this.merges = use_new_merge_format
            ? /** @type {[string, string][]} */ config.merges
            : config/** @type {string[]} */.merges
                .map((x) => /** @type {[string, string]} */(x as any).split(' ', 2));
        this.bpe_ranks = new Map(this.merges.map((x, i) => [JSON.stringify(x), i]));

        this.end_of_word_suffix = config.end_of_word_suffix;

        // NOTE: `continuing_subword_suffix` is custom (to support `BlenderbotSmallTokenizer`)
        this.continuing_subword_suffix = config.continuing_subword_suffix ?? null;

        this.byte_fallback = (this.config as any).byte_fallback ?? false;

        if (this.byte_fallback) {
            this.text_encoder = new TextEncoder();
        }

        this.ignore_merges = (this as any).config.ignore_merges ?? false;

        /** @type {Map<string, string[]>} */
        this.cache = new Map();
    }

    /**
     * Apply Byte-Pair-Encoding (BPE) to a given token. Efficient heap-based priority
     * queue implementation adapted from https://github.com/belladoreai/llama-tokenizer-js.
     * @param {string} token The token to encode.
     * @returns {string[]} The BPE encoded tokens.
     */
    bpe(token: string) {
        if (token.length === 0) {
            return [];
        }

        var cached = (this as any).cache.get(token);
        if (cached !== undefined) {
            return cached;
        }

        var word = Array.from(token);
        if (this.end_of_word_suffix) {
            word[word.length - 1] += this.end_of_word_suffix;
        }

        let result = [];
        if (word.length > 1) {
            // Create a priority queue to store the nodes that will be merged.
            // The comparator function compares the scores of the nodes.
            var queue = new PriorityQueue((a, b) => a.score < b.score);

            // Construct a doubly-linked list of nodes that will be inserted into the priority queue,
            // starting with the individual characters. We also populate each node with a positional
            // bias to break ties in the priority queue.
            let startingNode = {
                token: word[0],
                bias: 0,
                prev: null,
                next: null,
            };

            let previousNode: any = startingNode;
            for (let i = 1; i < word.length; ++i) {
                var currentNode = {
                    bias: i / word.length, // Add fractional component to break ties
                    token: word[i],
                    prev: previousNode,
                    next: null,
                };
                previousNode.next = currentNode;
                this._add_node(queue, previousNode);
                previousNode = currentNode;
            }

            while (!queue.isEmpty()) {
                // Get the next node with the highest priority
                var node = queue.pop();

                // Check that this merge is still possible
                if (node.deleted || !node.next || node.next.deleted) continue;

                // Here, we mark the current node (left side of the merge) and the next node (right side of the merge) as deleted.
                // This is because they will both be replaced by a new node representing the merge result.
                node.deleted = true;
                node.next.deleted = true;

                // Next, we fix the node that comes before the current node (i.e., left side of the merge).
                if (node.prev) {
                    // Make a shallow copy of the previous node
                    var newPreviousNode = { ...node.prev };

                    // Mark the old previous node as deleted. This avoids erroneous merges later,
                    // because there may still be references to this node in the priority queue.
                    node.prev.deleted = true;
                    node.prev = newPreviousNode;

                    // Update the reference of the previous node, by pointing its previous node to this new previous node.
                    if (newPreviousNode.prev) {
                        newPreviousNode.prev.next = newPreviousNode;
                    } else {
                        // If the previous of the previous node does not exist, it means that
                        // `newPreviousNode` must be the new `startingNode`.
                        startingNode = newPreviousNode;
                    }
                }

                // Create a new node which represents the result of the merge.
                var merged = {
                    token: node.token + node.next.token,
                    bias: node.bias,
                    prev: node.prev,
                    next: node.next.next,
                };

                // We now consider where we can add the new merged node to the priority queue:
                // 1. prev <-> merged
                if (merged.prev) {
                    merged.prev.next = merged;
                    this._add_node(queue, merged.prev);
                } else {
                    // If `merged.prev` does not exist, then `merged` must be the new `startingNode`.
                    startingNode = merged;
                }

                // 2. merged <-> next
                if (merged.next) {
                    merged.next.prev = merged;
                    this._add_node(queue, merged);
                }
            }

            // Traverse the linked list, starting from the `startingNode`, and collect the tokens.
            for (let currentNode: any = startingNode; currentNode !== null; currentNode = currentNode.next) {
                result.push(currentNode.token);
            }
        } else {
            result = word;
        }

        // Possibly append suffix
        if (this.continuing_subword_suffix) {
            // Do not append suffix to the last token
            for (let i = 0; i < result.length - 1; ++i) {
                result[i] += this.continuing_subword_suffix;
            }
        }

        // Save the result to the cache
        this.cache.set(token, result);

        return result;
    }

    /**
     * Helper function to add a node to the priority queue.
     * @param {PriorityQueue} queue
     * @param {BPENode} node
     * @private
     */
    _add_node(queue: any, node: any) {
        // `score` is a measure of the merge priority: lower means higher priority
        // We use the BPE rank as a measure of priority (i.e., the local of the merge in the merges list)
        // We also add a fractional component to the score to break ties (with the earlier character having higher priority)
        var rank = this.bpe_ranks.get(JSON.stringify([node.token, node.next.token]));
        if (rank !== undefined) {
            node.score = rank + node.bias;
            queue.push(node);
        }
    }

    /**
     * Encodes the input sequence of tokens using the BPE algorithm and returns the resulting subword tokens.
     * @param {string[]} tokens The input sequence of tokens to encode.
     * @returns {string[]} The resulting subword tokens after applying the BPE algorithm to the input sequence of tokens.
     */
    encode(tokens: string[]) {
        var outputTokens = [];

        for (var token of tokens) {
            if (this.ignore_merges && this.tokens_to_ids.has(token)) {
                outputTokens.push(token);
                continue;
            }
            var bpe_token_list = this.bpe(token);

            for (var t of bpe_token_list) {
                if (this.tokens_to_ids.has(t)) {
                    outputTokens.push(t);
                } else if (this.byte_fallback) {
                    var byteTokens = Array.from(this.text_encoder.encode(t)).map(
                        (x: any) => `<0x${x.toString(16).toUpperCase().padStart(2, '0')}>`,
                    );
                    if (byteTokens.every((x) => this.tokens_to_ids.has(x))) {
                        // Ensure the byte tokens are actually in the vocabulary, otherwise
                        // we fall back to the unknown token. For more information, see
                        // https://github.com/huggingface/transformers/issues/28096.
                        outputTokens.push(...byteTokens);
                    } else {
                        outputTokens.push(this.unk_token);
                    }
                } else {
                    outputTokens.push(this.unk_token);
                }
            }
        }

        return outputTokens;
    }
}

/**
 * Legacy tokenizer class for tokenizers with only a vocabulary.
 */
class LegacyTokenizerModel extends TokenizerModel {
    /**
     * Create a LegacyTokenizerModel instance.
     * @param {Object} config The configuration object for LegacyTokenizerModel.
     * @param {Object} config.vocab A (possibly nested) mapping of tokens to ids.
     * @param {Object} moreConfig Additional configuration object for the LegacyTokenizerModel model.
     */
    bos_token: string;
    eos_token: string;
    pad_token: string;
    unk_token: string;
    bos_token_id: number | undefined;
    eos_token_id: number | undefined;
    pad_token_id: number | undefined;
    unk_token_id: number | undefined;
    vocab: string[];
    constructor(
        config: {
            vocab: string[];
            target_lang?: string;
        },
        moreConfig: {
            bos_token: string;
            eos_token: string;
            target_lang?: any;
            pad_token?: any;
            unk_token?: any;
        },
    ) {
        super(config as any);

        /**@type {Map<string, number>} */
        this.tokens_to_ids = objectToMap(
            (moreConfig.target_lang ? config.vocab[moreConfig.target_lang] : config.vocab) as any,
        );

        this.bos_token = moreConfig.bos_token;
        this.bos_token_id = this.tokens_to_ids.get(this.bos_token);

        this.eos_token = moreConfig.eos_token;
        this.eos_token_id = this.tokens_to_ids.get(this.eos_token);

        this.pad_token = moreConfig.pad_token;
        this.pad_token_id = this.tokens_to_ids.get(this.pad_token);

        this.unk_token = moreConfig.unk_token;
        this.unk_token_id = this.tokens_to_ids.get(this.unk_token);

        this.vocab = new Array(this.tokens_to_ids.size);
        for (var [key, value] of this.tokens_to_ids) {
            this.vocab[value] = key;
        }
    }

    encode(tokens: string[]) {
        return tokens;
    }
}

/**
 * A base class for text normalization.
 * @abstract
 */
class Normalizer extends Callable {
    /**
     * @param {Object} config The configuration object for the normalizer.
     */
    config: any;
    constructor(config: { type: string }) {
        super();
        this.config = config;
    }

    /**
     * Factory method for creating normalizers from config objects.
     * @static
     * @param {Object} config The configuration object for the normalizer.
     * @returns {Normalizer} A Normalizer object.
     * @throws {Error} If an unknown Normalizer type is specified in the config.
     */
    static fromConfig(config: { type: string }) {
        if (config === null) return null;
        switch (config.type) {
            case 'BertNormalizer':
                return new BertNormalizer(config);
            case 'Precompiled':
                return new Precompiled(config);
            case 'Sequence':
                return new NormalizerSequence(config as any);
            case 'Replace':
                return new Replace(config);
            case 'NFC':
                return new NFC(config);
            case 'NFKC':
                return new NFKC(config);
            case 'NFKD':
                return new NFKD(config);
            case 'Strip':
                return new StripNormalizer(config);
            case 'StripAccents':
                return new StripAccents(config);
            case 'Lowercase':
                return new Lowercase(config);
            case 'Prepend':
                return new Prepend(config);
            default:
                throw new Error(`Unknown Normalizer type: ${config.type}`);
        }
    }

    /**
     * Normalize the input text.
     * @abstract
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     * @throws {Error} If this method is not implemented in a subclass.
     */
    normalize(text: string) {
        throw Error('normalize should be implemented in subclass.');
    }

    /**
     * Alias for {@link Normalizer#normalize}.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    _call(text: string) {
        return this.normalize(text);
    }
}

/**
 * Replace normalizer that replaces occurrences of a pattern with a given string or regular expression.
 * @extends Normalizer
 */
class Replace extends Normalizer {
    /**
     * Normalize the input text by replacing the pattern with the content.
     * @param {string} text The input text to be normalized.
     * @returns {string} The normalized text after replacing the pattern with the content.
     */
    normalize(text: string) {
        var pattern = createPattern(this.config.pattern);
        return pattern === null ? text : text.replaceAll(pattern, this.config.content);
    }
}

/**
 * A normalizer that applies Unicode normalization form C (NFC) to the input text.
 * @extends Normalizer
 */
class NFC extends Normalizer {
    /**
     * Normalize the input text by applying Unicode normalization form C (NFC).
     * @param {string} text The input text to be normalized.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        text = text.normalize('NFC');
        return text;
    }
}

/**
 * NFKC Normalizer.
 * @extends Normalizer
 */
class NFKC extends Normalizer {
    /**
     * Normalize text using NFKC normalization.
     * @param {string} text The text to be normalized.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        text = text.normalize('NFKC');
        return text;
    }
}
/**
 * NFKD Normalizer.
 * @extends Normalizer
 */
class NFKD extends Normalizer {
    /**
     * Normalize text using NFKD normalization.
     * @param {string} text The text to be normalized.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        text = text.normalize('NFKD');
        return text;
    }
}


/**
 * A normalizer that strips leading and/or trailing whitespace from the input text.
 */
class StripNormalizer extends Normalizer {
    /**
     * Strip leading and/or trailing whitespace from the input text.
     * @param {string} text The input text.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        if (this.config.strip_left && this.config.strip_right) {
            // Fast path to avoid an extra trim call
            text = text.trim();
        } else {
            if (this.config.strip_left) {
                text = text.trimStart();
            }
            if (this.config.strip_right) {
                text = text.trimEnd();
            }
        }
        return text;
    }
}

/**
 * StripAccents normalizer removes all accents from the text.
 * @extends Normalizer
 */
class StripAccents extends Normalizer {
    /**
     * Remove all accents from the text.
     * @param {string} text The input text.
     * @returns {string} The normalized text without accents.
     */
    normalize(text: string) {
        text = remove_accents(text);
        return text;
    }
}

/**
 * A Normalizer that lowercases the input string.
 * @extends Normalizer
 */
class Lowercase extends Normalizer {
    /**
     * Lowercases the input string.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        text = text.toLowerCase();
        return text;
    }
}

/**
 * A Normalizer that prepends a string to the input string.
 * @extends Normalizer
 */
class Prepend extends Normalizer {
    /**
     * Prepends the input string.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        text = this.config.prepend + text;
        return text;
    }
}

/**
 * A Normalizer that applies a sequence of Normalizers.
 * @extends Normalizer
 */
class NormalizerSequence extends Normalizer {
    /**
     * Create a new instance of NormalizerSequence.
     * @param {Object} config The configuration object.
     * @param {Object[]} config.normalizers An array of Normalizer configuration objects.
     */
    normalizers: any;
    constructor(config: {
        normalizers: {
            type: string;
        }[];
    }) {
        super(config as any);
        this.normalizers = config.normalizers.map((x: any) => Normalizer.fromConfig(x));
    }
    /**
     * Apply a sequence of Normalizers to the input text.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        return this.normalizers.reduce((t: string, normalizer: any) => {
            return normalizer.normalize(t);
        }, text);
    }
}

/**
 * A class representing a normalizer used in BERT tokenization.
 * @extends Normalizer
 */
class BertNormalizer extends Normalizer {
    /**
     * Adds whitespace around any CJK (Chinese, Japanese, or Korean) character in the input text.
     *
     * @param {string} text The input text to tokenize.
     * @returns {string} The tokenized text with whitespace added around CJK characters.
     */
    _tokenize_chinese_chars(text: string) {
        /* Adds whitespace around any CJK character. */
        var output = [];
        for (let i = 0; i < text.length; ++i) {
            var char = text[i];
            var cp = char.charCodeAt(0);
            if (is_chinese_char(cp)) {
                output.push(' ');
                output.push(char);
                output.push(' ');
            } else {
                output.push(char);
            }
        }
        return output.join('');
    }

    /**
     * Strips accents from the given text.
     * @param {string} text The text to strip accents from.
     * @returns {string} The text with accents removed.
     */
    stripAccents(text: string) {
        // "Mark, Nonspacing" (Mn)
        return text.normalize('NFD').replace(/\p{Mn}/gu, '');
    }

    /**
     * Checks whether `char` is a control character.
     * @param {string} char The character to check.
     * @returns {boolean} Whether `char` is a control character.
     * @private
     */
    _is_control(char: string) {
        switch (char) {
            case '\t':
            case '\n':
            case '\r':
                // These are technically control characters but we count them as whitespace characters.
                return false;

            default:
                // Check if unicode category starts with C:
                // Cc - Control
                // Cf - Format
                // Co - Private Use
                // Cs - Surrogate
                return /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u.test(char);
        }
    }

    /**
     * Performs invalid character removal and whitespace cleanup on text.
     * @param {string} text The text to clean.
     * @returns {string} The cleaned text.
     * @private
     */
    _clean_text(text: string) {
        var output = [];
        for (var char of text) {
            var cp = char.charCodeAt(0);
            if (cp === 0 || cp === 0xfffd || this._is_control(char)) {
                continue;
            }
            if (/^\s$/.test(char)) {
                // is whitespace
                output.push(' ');
            } else {
                output.push(char);
            }
        }
        return output.join('');
    }
    /**
     * Normalizes the given text based on the configuration.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        if (this.config.clean_text) {
            text = this._clean_text(text);
        }

        if (this.config.handle_chinese_chars) {
            text = this._tokenize_chinese_chars(text);
        }

        if (this.config.lowercase) {
            text = text.toLowerCase();

            if (this.config.strip_accents !== false) {
                text = this.stripAccents(text);
            }
        } else if (this.config.strip_accents) {
            text = this.stripAccents(text);
        }

        return text;
    }
}

/**
 * A callable class representing a pre-tokenizer used in tokenization. Subclasses
 * should implement the `pre_tokenize_text` method to define the specific pre-tokenization logic.
 * @extends Callable
 */
class PreTokenizer extends Callable {
    /**
     * Factory method that returns an instance of a subclass of `PreTokenizer` based on the provided configuration.
     *
     * @static
     * @param {Object} config A configuration object for the pre-tokenizer.
     * @returns {PreTokenizer} An instance of a subclass of `PreTokenizer`.
     * @throws {Error} If the provided configuration object does not correspond to any known pre-tokenizer.
     */
    static fromConfig(config: any) {
        if (config === null) return null;

        switch (config.type) {
            case 'BertPreTokenizer':
                return new BertPreTokenizer(config);
            case 'Sequence':
                return new PreTokenizerSequence(config);
            case 'Whitespace':
                return new WhitespacePreTokenizer(config);
            case 'WhitespaceSplit':
                return new WhitespaceSplit(config);
            case 'Metaspace':
                return new MetaspacePreTokenizer(config);

            case 'ByteLevel':
                return new ByteLevelPreTokenizer(config);
            case 'Split':
                return new SplitPreTokenizer(config);
            case 'Punctuation':
                return new PunctuationPreTokenizer(config);
            case 'Digits':
                return new DigitsPreTokenizer(config);
            case 'Replace':
                return new ReplacePreTokenizer(config);
            default:
                throw new Error(`Unknown PreTokenizer type: ${config.type}`);
        }
    }

    /**
     * Method that should be implemented by subclasses to define the specific pre-tokenization logic.
     *
     * @abstract
     * @param {string} text The text to pre-tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} The pre-tokenized text.
     * @throws {Error} If the method is not implemented in the subclass.
     */
    pre_tokenize_text(text: string, options: any) {
        throw Error('pre_tokenize_text should be implemented in subclass.');
    }

    /**
     * Tokenizes the given text into pre-tokens.
     * @param {string|string[]} text The text or array of texts to pre-tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of pre-tokens.
     */
    pre_tokenize(text: string | string[], options: any) {
        return (
            Array.isArray(text) ? text.map((x) => this.pre_tokenize_text(x, options)) : [this.pre_tokenize_text(text, options)]
        ).flat();
    }

    /**
     * Alias for {@link PreTokenizer#pre_tokenize}.
     * @param {string|string[]} text The text or array of texts to pre-tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of pre-tokens.
     */
    _call(text: string | string[], options: any) {
        return this.pre_tokenize(text, options);
    }
}

/**
 * @extends PreTokenizer
 */
class BertPreTokenizer extends PreTokenizer {
    /**
     * A PreTokenizer that splits text into wordpieces using a basic tokenization scheme
     * similar to that used in the original implementation of BERT.
     *
     * @param {Object} config The configuration object.
     */
    pattern: RegExp;
    constructor(config: {
        clean_text: boolean;
        handle_chinese_chars: boolean;
        lowercase: boolean;
        strip_accents: boolean;
    }) {
        super();
        // Construct a pattern which matches the rust implementation:
        // https://github.com/huggingface/tokenizers/blob/b4fcc9ce6e4ad5806e82826f816acfdfdc4fcc67/tokenizers/src/pre_tokenizers/bert.rs#L11
        // Equivalent to removing whitespace and splitting on punctuation (both \p{P} and other ascii characters)
        this.pattern = new RegExp(`[^\\s${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]`, 'gu');
    }
    /**
     * Tokenizes a single text using the BERT pre-tokenization scheme.
     *
     * @param {string} text The text to tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens.
     */
    pre_tokenize_text(text: string, options: any) {
        return text.trim().match(this.pattern) || [];
    }
}

/**
 * A pre-tokenizer that splits text into Byte-Pair-Encoding (BPE) subwords.
 * @extends PreTokenizer
 */
class ByteLevelPreTokenizer extends PreTokenizer {
    /**
     * Creates a new instance of the `ByteLevelPreTokenizer` class.
     * @param {Object} config The configuration object.
     */
    config: any;
    add_prefix_space: boolean;
    trim_offsets: boolean;
    use_regex: boolean;
    pattern: RegExp;
    byte_encoder: any;
    text_encoder: any;
    constructor(config: { add_prefix_space: boolean; trim_offsets: boolean }) {
        super();
        this.config = config;

        /**
         * @type {boolean} Whether to add a leading space to the first word.
         * This allows to treat the leading word just as any other word.
         */
        this.add_prefix_space = this.config.add_prefix_space;

        /**
         * @type {boolean} Whether the post processing step should trim offsets
         * to avoid including whitespaces.
         * @todo Use this in the pretokenization step.
         */
        this.trim_offsets = this.config.trim_offsets;

        /**
         * @type {boolean} Whether to use the standard GPT2 regex for whitespace splitting.
         * Set it to False if you want to use your own splitting. Defaults to true.
         */
        this.use_regex = this.config.use_regex ?? true;
        this.pattern = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

        this.byte_encoder = BYTES_TO_UNICODE;
        this.text_encoder = new TextEncoder();
    }

    /**
     * Tokenizes a single piece of text using byte-level tokenization.
     * @param {string} text The text to tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens.
     */
    pre_tokenize_text(text: string, options: any) {
        // Add a leading space if the option is enabled
        if (this.add_prefix_space && !text.startsWith(' ')) {
            text = ' ' + text;
        }

        // Split on whitespace and punctuation
        var tokens = this.use_regex ? text.match(this.pattern) || [] : [text];

        // Maps all our bytes to unicode strings, avoiding control tokens of the BPE (spaces in our case)
        return tokens.map((token) =>
            Array.from(this.text_encoder.encode(token), (byte) => this.byte_encoder[(byte as any)]).join(''),
        );
    }
}

/**
 * @typedef {'removed'|'isolated'|'mergedWithPrevious'|'mergedWithNext'|'contiguous'} SplitDelimiterBehavior
 */
type SplitDelimiterBehavior = 'removed' | 'isolated' | 'mergedWithPrevious' | 'mergedWithNext' | 'contiguous';
/**
 * Splits text using a given pattern.
 * @extends PreTokenizer
 */
class SplitPreTokenizer extends PreTokenizer {
    /**
     * @param {Object} config The configuration options for the pre-tokenizer.
     * @param {Object} config.pattern The pattern used to split the text. Can be a string or a regex object.
     * @param {string|undefined} config.pattern.String The string to use for splitting. Only defined if the pattern is a string.
     * @param {string|undefined} config.pattern.Regex The regex to use for splitting. Only defined if the pattern is a regex.
     * @param {SplitDelimiterBehavior} config.behavior The behavior to use when splitting.
     * @param {boolean} config.invert Whether to split (invert=false) or match (invert=true) the pattern.
     */
    config: any;
    pattern: any;
    constructor(config: { pattern: string | RegExp; behavior: SplitDelimiterBehavior; invert: boolean }) {
        super();
        this.config = config;
        // TODO support all behaviours (config.behavior)

        this.pattern = createPattern(this.config.pattern, this.config.invert);
    }

    /**
     * Tokenizes text by splitting it using the given pattern.
     * @param {string} text The text to tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens.
     */
    pre_tokenize_text(text: string, options: any) {
        if (this.pattern === null) {
            return [];
        }

        if (this.config.invert) {
            return text.match(this.pattern) || [];
        } else if (this.config.behavior?.toLowerCase() === 'removed') {
            return text.split(this.pattern).filter((x) => x);
        } else {
            return regexSplit(text, this.pattern);
        }
    }
}

/**
 * Splits text based on punctuation.
 * @extends PreTokenizer
 */
class PunctuationPreTokenizer extends PreTokenizer {
    /**
     * @param {Object} config The configuration options for the pre-tokenizer.
     * @param {SplitDelimiterBehavior} config.behavior The behavior to use when splitting.
     */
    config: any;
    pattern: RegExp;
    constructor(config: { behavior: SplitDelimiterBehavior }) {
        super();
        this.config = config;
        this.pattern = new RegExp(`[^${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]+`, 'gu');
    }

    /**
     * Tokenizes text by splitting it using the given pattern.
     * @param {string} text The text to tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens.
     */
    pre_tokenize_text(text: string, options: any) {
        return text.match(this.pattern) || [];
    }
}

/**
 * Splits text based on digits.
 * @extends PreTokenizer
 */
class DigitsPreTokenizer extends PreTokenizer {
    /**
     * @param {Object} config The configuration options for the pre-tokenizer.
     * @param {boolean} config.individual_digits Whether to split on individual digits.
     */
    config: any;
    pattern: RegExp;
    constructor(config: any) {
        super();
        this.config = config;

        // Construct a pattern which matches the rust implementation:
        var digit_pattern = `[^\\d]+|\\d${this.config.individual_digits ? '' : '+'}`;
        this.pattern = new RegExp(digit_pattern, 'gu');
    }

    /**
     * Tokenizes text by splitting it using the given pattern.
     * @param {string} text The text to tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens.
     */
    pre_tokenize_text(text: string, options: any) {
        return text.match(this.pattern) || [];
    }
}

/**
 * @typedef {Object} PostProcessedOutput
 * @property {string[]} tokens List of token produced by the post-processor.
 * @property {number[]} [token_type_ids] List of token type ids produced by the post-processor.
 */

/**
 * @typedef {Object} EncodingSingle
 * @property {number[]} input_ids List of token ids to be fed to a model.
 * @property {number[]} attention_mask List of token type ids to be fed to a model
 * @property {number[]} [token_type_ids] List of indices specifying which tokens should be attended to by the model
 */

/**
 * @extends Callable
 */
class PostProcessor extends Callable {
    /**
     * @param {Object} config The configuration for the post-processor.
     */
    config: any;
    constructor(config: any) {
        if (!config) {
            throw new Error('config is required');
        }
        super();
        this.config = config;
    }

    /**
     * Factory method to create a PostProcessor object from a configuration object.
     *
     * @param {Object} config Configuration object representing a PostProcessor.
     * @returns {PostProcessor} A PostProcessor object created from the given configuration.
     * @throws {Error} If an unknown PostProcessor type is encountered.
     */
    static fromConfig(config: any) {
        if (config === null) return null;
        switch (config.type) {
            case 'TemplateProcessing':
                return new TemplateProcessing(config);
            case 'ByteLevel':
                return new ByteLevelPostProcessor(config);
            case 'Sequence':
                return new PostProcessorSequence(config);
            default:
                throw new Error(`Unknown PostProcessor type: ${config.type}`);
        }
    }

    /**
     * Method to be implemented in subclass to apply post-processing on the given tokens.
     *
     * @param {Array} tokens The input tokens to be post-processed.
     * @param {...*} args Additional arguments required by the post-processing logic.
     * @returns {PostProcessedOutput} The post-processed tokens.
     * @throws {Error} If the method is not implemented in subclass.
     */
    post_process(tokens: string[], ...args: any[]) {
        throw Error('post_process should be implemented in subclass.');
    }

    /**
     * Alias for {@link PostProcessor#post_process}.
     * @param {Array} tokens The text or array of texts to post-process.
     * @param {...*} args Additional arguments required by the post-processing logic.
     * @returns {PostProcessedOutput} The post-processed tokens.
     */
    _call(tokens: string[], ...args: any[]) {
        return this.post_process(tokens, ...args);
    }
}


/**
 * A class representing a post processor used in tokenization.
 * @extends PostProcessor
 */
class TemplateProcessing extends PostProcessor {
    /**
     * Creates a new instance of `TemplateProcessing`.
     * @param {Object} config The configuration options for the post processor.
     * @param {Array} config.single The template for a single sequence of tokens.
     * @param {Array} config.pair The template for a pair of sequences of tokens.
     */
    single: Array<any>;
    pair: Array<any>;
    constructor(config: {
        single: Array<any>;
        pair: Array<any>;
    }) {
        super(config);

        this.single = config.single;
        this.pair = config.pair;
    }

    /**
     * Replaces special tokens in the template with actual tokens.
     * @param {string[]} tokens The list of tokens for the first sequence.
     * @param {string[]} [tokens_pair=null] The list of tokens for the second sequence (optional).
     * @returns {PostProcessedOutput} An object containing the list of tokens with the special tokens replaced with actual tokens.
     */
    post_process(tokens: string[], tokens_pair: string[] | null, {
        add_special_tokens = true,
    } = {}) {
        var type = tokens_pair === null ? this.single : this.pair

        let processedTokens: string[] = [];
        let types: number[] = [];
        for (var item of type) {
            if ('SpecialToken' in item) {
                if (add_special_tokens) {
                    processedTokens.push(item.SpecialToken.id);
                    types.push(item.SpecialToken.type_id);
                }
            } else if ('Sequence' in item) {
                if (item.Sequence.id === 'A') {
                    processedTokens = mergeArrays(processedTokens, tokens);
                    types = mergeArrays(types, new Array(tokens.length).fill(item.Sequence.type_id));

                } else if (item.Sequence.id === 'B') {
                    processedTokens = mergeArrays(processedTokens, (tokens_pair as string[]));
                    types = mergeArrays(types, new Array((tokens_pair as string[]).length).fill(item.Sequence.type_id));
                }
            }
        }
        return { tokens: processedTokens, token_type_ids: types };
    }
}


/**
 * A PostProcessor that returns the given tokens as is.
 * @extends PostProcessor
 */
class ByteLevelPostProcessor extends PostProcessor {
    /**
     * Post process the given tokens.
     * @param {string[]} tokens The list of tokens for the first sequence.
     * @param {string[]} [tokens_pair=null] The list of tokens for the second sequence (optional).
     * @returns {PostProcessedOutput} An object containing the post-processed tokens.
     */
    post_process(tokens: string[], tokens_pair = null) {
        if (tokens_pair) {
            tokens = mergeArrays(tokens, tokens_pair);
        }
        return { tokens };
    }
}

/**
 * A post-processor that applies multiple post-processors in sequence.
 */
class PostProcessorSequence extends PostProcessor {
    /**
     * Creates a new instance of PostProcessorSequence.
     * @param {Object} config The configuration object.
     * @param {Object[]} config.processors The list of post-processors to apply.
     */
    processors: any;
    constructor(config: any) {
        super(config as any);

        this.processors = config.processors.map((x: any) => PostProcessor.fromConfig(x));
    }

    /**
     * Post process the given tokens.
     * @param {string[]} tokens The list of tokens for the first sequence.
     * @param {string[]} [tokens_pair=null] The list of tokens for the second sequence (optional).
     * @returns {PostProcessedOutput} An object containing the post-processed tokens.
     */
    post_process(tokens: string[], tokens_pair: string[] | null = null, options: any = {}) {
        let token_type_ids;
        for (var processor of this.processors) {
            if (processor instanceof ByteLevelPostProcessor) {
                // Special case where we need to pass the tokens_pair to the post-processor
                var output = processor.post_process(tokens);
                tokens = output.tokens;
                if (tokens_pair) {
                    var pair_output = processor.post_process(tokens_pair);
                    tokens_pair = pair_output.tokens;
                }
            } else {
                var output = processor.post_process(tokens, tokens_pair, options);
                tokens = output.tokens;
                token_type_ids = output.token_type_ids;
            }
        }
        return { tokens, token_type_ids };
    }
}

/**
 * The base class for token decoders.
 * @extends Callable
 */
class Decoder extends Callable {
    /**
     * Creates an instance of `Decoder`.
     *
     * @param {Object} config The configuration object.
     */
    added_tokens: AddedToken[];
    end_of_word_suffix: string | null;
    trim_offsets: boolean;
    config: any;
    // x: any;
    constructor(config: any) {
        super();
        this.config = config;

        /** @type {AddedToken[]} */
        this.added_tokens = [];
        this.end_of_word_suffix = null;
        this.trim_offsets = config.trim_offsets;
    }

    /**
     * Creates a decoder instance based on the provided configuration.
     *
     * @param {Object} config The configuration object.
     * @returns {Decoder} A decoder instance.
     * @throws {Error} If an unknown decoder type is provided.
     */
    static fromConfig(config: any) {
        if (config === null) return null;
        switch (config.type) {
            case 'WordPiece':
                return new WordPieceDecoder(config);
            case 'Metaspace':
                return new MetaspaceDecoder(config);
            case 'ByteLevel':
                return new ByteLevelDecoder(config);

            case 'Replace':
                return new ReplaceDecoder(config);
            case 'ByteFallback':
                return new ByteFallback(config);
            case 'Fuse':
                return new FuseDecoder(config);
            case 'Strip':
                return new StripDecoder(config);

            case 'Sequence':
                return new DecoderSequence(config);

            case 'CTC':
                return new CTCDecoder(config);
            case 'BPEDecoder':
                return new BPEDecoder(config);
            default:
                throw new Error(`Unknown Decoder type: ${config.type}`);
        }
    }

    /**
     * Calls the `decode` method.
     *
     * @param {string[]} tokens The list of tokens.
     * @returns {string} The decoded string.
     */
    _call(tokens: string[]) {
        return this.decode(tokens);
    }

    /**
     * Decodes a list of tokens.
     * @param {string[]} tokens The list of tokens.
     * @returns {string} The decoded string.
     */
    decode(tokens: string[]) {
        return this.decode_chain(tokens).join('');
    }

    /**
     * Apply the decoder to a list of tokens.
     *
     * @param {string[]} tokens The list of tokens.
     * @returns {string[]} The decoded list of tokens.
     * @throws {Error} If the `decode_chain` method is not implemented in the subclass.
     */
    decode_chain(tokens: string[]) {
        throw Error('`decode_chain` should be implemented in subclass.');
    }
}

class ReplaceDecoder extends Decoder {
    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        var pattern = createPattern(this.config.pattern);
        return pattern === null ? tokens : tokens.map((token) => token.replaceAll(pattern, this.config.content));
    }
}

class ByteFallback extends Decoder {
    text_decoder: TextDecoder;

    constructor(config: any) {
        super(config as any);

        this.text_decoder = new TextDecoder();
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        var new_tokens = [];
        let previous_byte_tokens = [];

        for (var token of tokens) {
            let bytes = null;
            if (token.length === 6 && token.startsWith('<0x') && token.endsWith('>')) {
                var byte = parseInt(token.slice(3, 5), 16);
                if (!isNaN(byte)) {
                    bytes = byte;
                }
            }
            if (bytes !== null) {
                previous_byte_tokens.push(bytes);
            } else {
                if (previous_byte_tokens.length > 0) {
                    var string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
                    new_tokens.push(string);
                    previous_byte_tokens = [];
                }
                new_tokens.push(token);
            }
        }
        if (previous_byte_tokens.length > 0) {
            var string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
            new_tokens.push(string);
            previous_byte_tokens = [];
        }

        return new_tokens;
    }
}

/**
 * Fuse simply fuses all tokens into one big string.
 * It's usually the last decoding step anyway, but this decoder
 * exists incase some decoders need to happen after that step
 */
class FuseDecoder extends Decoder {
    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        return [tokens.join('')];
    }
}

class StripDecoder extends Decoder {
    content: string;
    start: number;
    stop: number;

    constructor(config: any) {
        super(config as any);

        this.content = this.config.content;
        this.start = this.config.start;
        this.stop = this.config.stop;
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        return tokens.map((token) => {
            let start_cut = 0;
            for (let i = 0; i < this.start; ++i) {
                if (token[i] === this.content) {
                    start_cut = i + 1;
                    continue;
                } else {
                    break;
                }
            }

            let stop_cut = token.length;
            for (let i = 0; i < this.stop; ++i) {
                var index = token.length - i - 1;
                if (token[index] === this.content) {
                    stop_cut = index;
                    continue;
                } else {
                    break;
                }
            }

            return token.slice(start_cut, stop_cut);
        });
    }
}

/**
 * A decoder that decodes a list of WordPiece tokens into a single string.
 * @extends Decoder
 */
class WordPieceDecoder extends Decoder {
    /**
     * Creates a new instance of WordPieceDecoder.
     * @param {Object} config The configuration object.
     * @param {string} config.prefix The prefix used for WordPiece encoding.
     * @param {boolean} config.cleanup Whether to cleanup the decoded string.
     */
    cleanup: boolean;
    constructor(config: any) {
        super(config as any);
        this.cleanup = config.cleanup;
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        return tokens.map((token, i) => {
            if (i !== 0) {
                if (token.startsWith(this.config.prefix)) {
                    // NOTE: .replace() is intended; only replace first occurrence
                    token = token.replace(this.config.prefix, '');
                } else {
                    token = ' ' + token;
                }
            }
            if (this.cleanup) {
                token = clean_up_tokenization(token);
            }

            return token;
        });
    }
}

/**
 * Byte-level decoder for tokenization output. Inherits from the `Decoder` class.
 * @extends Decoder
 */
class ByteLevelDecoder extends Decoder {
    /**
     * Create a `ByteLevelDecoder` object.
     * @param {Object} config Configuration object.
     */
    byte_decoder: Record<string, any>;
    text_decoder: TextDecoder;
    end_of_word_suffix: string | null;

    constructor(config: any) {
        super(config as any);

        this.byte_decoder = UNICODE_TO_BYTES;
        this.text_decoder = new TextDecoder('utf-8', {
            fatal: false,
            ignoreBOM: true,
        });

        this.end_of_word_suffix = null;
    }

    /**
     * Convert an array of tokens to string by decoding each byte.
     * @param {string[]} tokens Array of tokens to be decoded.
     * @returns {string} The decoded string.
     */
    convert_tokens_to_string(tokens: string[]) {
        var text = tokens.join('');
        var byteArray = new Uint8Array([...text].map((c) => this.byte_decoder[c]));
        var decoded_text = this.text_decoder.decode(byteArray);
        return decoded_text;
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        // TODO move to base class (like HF)
        // tokens === filtered_tokens

        // To avoid mixing byte-level and unicode for byte-level BPT
        // we need to build string separately for added tokens and byte-level tokens
        // cf. https://github.com/huggingface/transformers/issues/1133
        var sub_texts = [];
        let current_sub_text = [];
        for (var token of tokens) {
            // tokens sent here are already filtered, so we don't need to do this
            // if (skip_special_tokens && this.all_special_ids.includes(token)) {
            //     continue;
            // }

            if (this.added_tokens.find((x) => x.content === token) !== undefined) {
                if (current_sub_text.length > 0) {
                    sub_texts.push(this.convert_tokens_to_string(current_sub_text));
                    current_sub_text = [];
                }
                sub_texts.push(token);
            } else {
                current_sub_text.push(token);
            }
        }
        if (current_sub_text.length > 0) {
            sub_texts.push(this.convert_tokens_to_string(current_sub_text));
        }

        // TODO add spaces_between_special_tokens and clean_up_tokenization_spaces options

        return sub_texts;
    }
}

/**
 * The CTC (Connectionist Temporal Classification) decoder.
 * See https://github.com/huggingface/tokenizers/blob/bb38f390a61883fc2f29d659af696f428d1cda6b/tokenizers/src/decoders/ctc.rs
 */
class CTCDecoder extends Decoder {
    pad_token: string;
    word_delimiter_token: string;
    cleanup: boolean;

    constructor(config: any) {
        super(config as any);

        this.pad_token = this.config.pad_token;
        this.word_delimiter_token = this.config.word_delimiter_token;
        this.cleanup = this.config.cleanup;
    }
    /**
     * Converts a connectionist-temporal-classification (CTC) output tokens into a single string.
     * @param {string[]} tokens Array of tokens to be decoded.
     * @returns {string} The decoded string.
     */
    convert_tokens_to_string(tokens: string[]) {
        if (tokens.length === 0) return '';

        // group same tokens into non-repeating tokens in CTC style decoding
        var grouped_tokens = [tokens[0]];
        for (let i = 1; i < tokens.length; ++i) {
            if (tokens[i] !== grouped_tokens.at(-1)) {
                grouped_tokens.push(tokens[i]);
            }
        }

        // filter self.pad_token which is used as CTC-blank token
        var filtered_tokens = grouped_tokens.filter((token) => token !== this.pad_token);

        let text = filtered_tokens.join('');
        if (this.cleanup) {
            // cleanup and replace delimiter token
            text = clean_up_tokenization(text).replaceAll(this.word_delimiter_token, ' ').trim();
        }
        return text;
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        return [this.convert_tokens_to_string(tokens)];
    }
}

/**
 * Apply a sequence of decoders.
 * @extends Decoder
 */
class DecoderSequence extends Decoder {
    decoders: Decoder[];
    /**
     * Creates a new instance of DecoderSequence.
     * @param {Object} config The configuration object.
     * @param {Object[]} config.decoders The list of decoders to apply.
     */
    constructor(config: any) {
        super(config as any);
        this.decoders = config.decoders.map((x: any) => Decoder.fromConfig(x));
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        // Use reduce to apply each decoder to the tokens
        return this.decoders.reduce((toks: any, decoder: any) => {
            return decoder.decode_chain(toks);
        }, tokens);
    }
}

class BPEDecoder extends Decoder {
    suffix: string;
    constructor(config: any) {
        super(config as any);

        this.suffix = this.config.suffix;
    }
    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        return tokens.map((token, i) => {
            return token.replaceAll(this.suffix, i === tokens.length - 1 ? '' : ' ');
        });
    }
}

// Custom decoder for VITS
class VitsDecoder extends Decoder {
    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        let decoded = '';
        for (let i = 1; i < tokens.length; i += 2) {
            decoded += tokens[i];
        }
        return [decoded];
    }
}

/**
 * This PreTokenizer replaces spaces with the given replacement character, adds a prefix space if requested,
 * and returns a list of tokens.
 * @extends PreTokenizer
 */
class MetaspacePreTokenizer extends PreTokenizer {
    /**
     * @param {Object} config The configuration object for the MetaspacePreTokenizer.
     * @param {boolean} config.add_prefix_space Whether to add a prefix space to the first token.
     * @param {string} config.replacement The character to replace spaces with.
     * @param {string} [config.str_rep=config.replacement] An optional string representation of the replacement character.
     * @param {'first'|'never'|'always'} [config.prepend_scheme='always'] The metaspace prepending scheme.
     */
    addPrefixSpace: boolean;
    replacement: string;
    strRep: string;
    prepend_scheme: string;
    constructor(config: any) {
        super();

        this.addPrefixSpace = config.add_prefix_space;
        this.replacement = config.replacement;
        this.strRep = config.str_rep || this.replacement;
        this.prepend_scheme = config.prepend_scheme ?? 'always';
    }

    /**
     * This method takes a string, replaces spaces with the replacement character,
     * adds a prefix space if requested, and returns a new list of tokens.
     * @param {string} text The text to pre-tokenize.
     * @param {Object} [options] The options for the pre-tokenization.
     * @param {number} [options.section_index] The index of the section to pre-tokenize.
     * @returns {string[]} A new list of pre-tokenized tokens.
     */
    pre_tokenize_text(text: string, { section_index = undefined } = {}) {
        let normalized = text.replaceAll(' ', this.strRep);

        if (
            // We add a prefix space if:
            //  (1) The addPrefixSpace option is enabled and the normalized
            //      token does not already start with the replacement character.
            this.addPrefixSpace &&
            !normalized.startsWith(this.replacement) &&
            // and (2) either:
            //  (a) prepend_scheme is 'always'
            //  (b) prepend_scheme is 'first' and this is the first section
            (this.prepend_scheme === 'always' || (this.prepend_scheme === 'first' && section_index === 0))
        ) {
            normalized = this.strRep + normalized;
        }
        return [normalized];
    }
}

/**
 * MetaspaceDecoder class extends the Decoder class and decodes Metaspace tokenization.
 * @extends Decoder
 */
class MetaspaceDecoder extends Decoder {
    /**
     * Constructs a new MetaspaceDecoder object.
     * @param {Object} config The configuration object for the MetaspaceDecoder.
     * @param {boolean} config.add_prefix_space Whether to add a prefix space to the decoded string.
     * @param {string} config.replacement The string to replace spaces with.
     */
    addPrefixSpace: boolean;
    replacement: string;
    constructor(config: any) {
        super(config as any);

        this.addPrefixSpace = config.add_prefix_space;
        this.replacement = config.replacement;
    }

    /** @type {Decoder['decode_chain']} */
    decode_chain(tokens: string[]) {
        var result = [];
        for (let i = 0; i < tokens.length; ++i) {
            let normalized = tokens[i].replaceAll(this.replacement, ' ');
            if (this.addPrefixSpace && i == 0 && normalized.startsWith(' ')) {
                normalized = normalized.substring(1);
            }
            result.push(normalized);
        }
        return result;
    }
}

/**
 * A normalizer that applies a precompiled charsmap.
 * This is useful for applying complex normalizations in C++ and exposing them to JavaScript.
 * @extends Normalizer
 * @param {Object} config The configuration object for the Precompiled normalizer.
 * @param {Object} config.precompiled_charsmap The precompiled charsmap object.
 */
class Precompiled extends Normalizer {
    charsmap: any;
    /**
     * Create a new instance of Precompiled normalizer.
     * @param {Object} config The configuration object.
     * @param {any} config.precompiled_charsmap Precompiled chars mapping.
     */
    constructor(config: any) {
        super(config as any);
        this.charsmap = config.precompiled_charsmap;
    }

    /**
     * Normalizes the given text by applying the precompiled charsmap.
     * @param {string} text The text to normalize.
     * @returns {string} The normalized text.
     */
    normalize(text: string) {
        // As stated in the sentencepiece normalization docs (https://github.com/google/sentencepiece/blob/master/doc/normalization.md#use-pre-defined-normalization-rule),
        // there are 5 pre-defined normalization rules:
        //  1. nmt_nfkc: NFKC normalization with some additional normalization around spaces. (default)
        //  2. nfkc: original NFKC normalization.
        //  3. nmt_nfkc_cf: nmt_nfkc + Unicode case folding (mostly lower casing)
        //  4. nfkc_cf: nfkc + Unicode case folding.
        //  5. identity: no normalization
        //
        // For now, we only implement the default (nmt_nfkc).
        // See https://raw.githubusercontent.com/google/sentencepiece/master/data/nmt_nfkc.tsv for the full list of rules.
        // TODO: detect when a different `this.charsmap` is used.

        text = text.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/gm, ''); // Remove control characters
        text = text.replace(
            /[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/gm,
            '\u0020',
        ); // Replace certain characters with a space

        if (text.includes('\uFF5E')) {
            // To match the sentencepiece implementation 100%, we must handle a very strange edge-case.
            // For some reason, the "Fullwidth Tilde" character (\uFF5E) should not be converted to the standard Tilde character (\u007E).
            // However, NFKC normalization does do this conversion. As a result, we split the string on the Fullwidth Tilde character,
            // perform NFKC normalization on each substring, and then join them back together with the Fullwidth Tilde character.
            var parts = text.split('\uFF5E');
            text = parts.map((part) => part.normalize('NFKC')).join('\uFF5E');
        } else {
            text = text.normalize('NFKC');
        }

        return text;
    }
}

/**
 * A pre-tokenizer that applies a sequence of pre-tokenizers to the input text.
 * @extends PreTokenizer
 */
class PreTokenizerSequence extends PreTokenizer {
    /**
     * Creates an instance of PreTokenizerSequence.
     * @param {Object} config The configuration object for the pre-tokenizer sequence.
     * @param {Object[]} config.pretokenizers An array of pre-tokenizer configurations.
     */
    tokenizers: any[];
    config: any;
    constructor(config: any) {
        super();
        this.tokenizers = config.pretokenizers.map((x: any) => PreTokenizer.fromConfig(x));
        this.config = config;
    }

    /**
     * Applies each pre-tokenizer in the sequence to the input text in turn.
     * @param {string} text The text to pre-tokenize.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} The pre-tokenized text.
     */
    pre_tokenize_text(text: string, options: any) {
        // Use reduce to apply each tokenizer to the text
        return this.tokenizers.reduce(
            (preTokenizedText: any, tokenizer: any) => {
                return tokenizer.pre_tokenize(preTokenizedText, options);
            },
            [text],
        );
    }
}

/**
 * Splits on word boundaries (using the following regular expression: `\w+|[^\w\s]+`).
 */
class WhitespacePreTokenizer extends PreTokenizer {
    /**
     * Creates an instance of WhitespacePreTokenizer.
     * @param {Object} config The configuration object for the pre-tokenizer.
     */
    constructor(config: any) {
        super();
    }
    /**
     * Pre-tokenizes the input text by splitting it on word boundaries.
     * @param {string} text The text to be pre-tokenized.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens produced by splitting the input text on whitespace.
     */
    pre_tokenize_text(text: string, options: any) {
        return text.match(/\w+|[^\w\s]+/g) || [];
    }
}

/**
 * Splits a string of text by whitespace characters into individual tokens.
 * @extends PreTokenizer
 */
class WhitespaceSplit extends PreTokenizer {
    /**
     * Creates an instance of WhitespaceSplit.
     * @param {Object} config The configuration object for the pre-tokenizer.
     */
    constructor(config: any) {
        super();
    }
    /**
     * Pre-tokenizes the input text by splitting it on whitespace characters.
     * @param {string} text The text to be pre-tokenized.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens produced by splitting the input text on whitespace.
     */
    pre_tokenize_text(text: string, options: any) {
        return whitespace_split(text);
    }
}

// NOTE: `ReplacePreTokenizer` is custom (to support `BlenderbotSmallTokenizer`)
class ReplacePreTokenizer extends PreTokenizer {
    /**
     * @param {Object} config The configuration options for the pre-tokenizer.
     * @param {Object} config.pattern The pattern used to split the text. Can be a string or a regex object.
     * @param {string} config.content What to replace the pattern with.
     */
    pattern: any;
    content: string;
    config: {
        pattern: any;
        content: string;
    };
    constructor(config: any) {
        super();
        this.config = config;
        this.pattern = createPattern(this.config.pattern);
        this.content = this.config.content;
    }

    /**
     * Pre-tokenizes the input text by replacing certain characters.
     * @param {string} text The text to be pre-tokenized.
     * @param {Object} [options] Additional options for the pre-tokenization logic.
     * @returns {string[]} An array of tokens produced by replacing certain characters.
     */
    pre_tokenize_text(text: string, options: any) {
        if (this.pattern === null) {
            return [text];
        }
        return [text.replaceAll(this.pattern, this.config.content)];
    }
}

var SPECIAL_TOKEN_ATTRIBUTES = [
    'bos_token',
    'eos_token',
    'unk_token',
    'sep_token',
    'pad_token',
    'cls_token',
    'mask_token',
    // additional_special_tokens (TODO)
];

/**
 *
 * Helper function for padding values of an object, which are each arrays.
 * NOTE: No additional checks are made here for validity of arguments.
 * @param {Record<string, any[]>} item The input object.
 * @param {number} length The length to pad to.
 * @param {(key: string) => any} value_fn Determine the value to fill the array, based on its key.
 * @param {string} side Which side to pad the array.
 * @private
 */
function padHelper(item: Record<string, any[]>, length: number, value_fn: (key: string) => any, side: string) {
    for (var key of Object.keys(item)) {
        var diff = length - item[key].length;
        var value = value_fn(key);

        var padData = new Array(diff).fill(value);
        item[key] = side === 'right' ? mergeArrays(item[key], padData) : mergeArrays(padData, item[key]);
    }
}

/**
 * Helper function for truncating values of an object, which are each arrays.
 * NOTE: No additional checks are made here for validity of arguments.
 * @param {Record<string, any[]>} item The input object.
 * @param {number} length The length to truncate to.
 * @private
 */
function truncateHelper(item: Record<string, any[]>, length: number) {
    // Setting .length to a lower value truncates the array in-place:
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/length
    for (var key of Object.keys(item)) {
        item[key].length = length;
    }
}

/**
 * @typedef {Object} Message
 * @property {string} role The role of the message (e.g., "user" or "assistant" or "system").
 * @property {string} content The content of the message.
 */

type Message = {
    role: string;
    content: string;
};

export class PreTrainedTokenizer extends Callable {
    return_token_type_ids = false;

    padding_side = 'right';
    /**
     * Create a new PreTrainedTokenizer instance.
     * @param {Object} tokenizerJSON The JSON of the tokenizer.
     * @param {Object} tokenizerConfig The config of the tokenizer.
     */
    _tokenizer_config: any;
    pre_tokenizer: any;
    normalizer: any;
    model: any;
    post_processor: any;
    decoder: any;
    config: any;
    special_tokens: string[];
    added_tokens_regex: RegExp | null;
    mask_token: string | undefined;
    mask_token_id: number | undefined;
    pad_token: string | undefined;
    pad_token_id: number | undefined;
    sep_token: string | undefined;
    sep_token_id: number | undefined;
    unk_token: string | undefined;
    unk_token_id: number | undefined;
    bos_token: string | undefined;
    bos_token_id: number | undefined;
    eos_token: string | undefined;
    eos_token_id: number | undefined;
    model_max_length: number | undefined;
    remove_space: boolean;
    clean_up_tokenization_spaces: boolean;
    legacy: boolean;
    chat_template: any;
    _compiled_template_cache: Map<string, any>;
    all_special_ids: number[];
    added_tokens: AddedToken[];
    additional_special_tokens: string[];
    do_lowercase_and_remove_accent: boolean;
    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super();

        this._tokenizer_config = tokenizerConfig;
        // Construct parts of the tokenizer from the JSON
        this.normalizer = Normalizer.fromConfig(tokenizerJSON.normalizer);
        this.pre_tokenizer = PreTokenizer.fromConfig(tokenizerJSON.pre_tokenizer);
        this.model = TokenizerModel.fromConfig(tokenizerJSON.model, tokenizerConfig);
        this.post_processor = PostProcessor.fromConfig(tokenizerJSON.post_processor);
        this.decoder = Decoder.fromConfig(tokenizerJSON.decoder);

        // Add added_tokens to model
        this.special_tokens = [];
        this.all_special_ids = [];

        /** @type {AddedToken[]} */
        this.added_tokens = [];
        for (var addedToken of tokenizerJSON.added_tokens) {
            var token = new AddedToken(addedToken);
            this.added_tokens.push(token);

            this.model.tokens_to_ids.set(token.content, token.id);
            this.model.vocab[token.id] = token.content;

            if (token.special) {
                this.special_tokens.push(token.content);
                this.all_special_ids.push(token.id);
            }
        }

        // Update additional_special_tokens
        this.additional_special_tokens = tokenizerConfig.additional_special_tokens ?? [];
        this.special_tokens.push(...this.additional_special_tokens);
        this.special_tokens = [...new Set(this.special_tokens)]; // Remove duplicates

        if (this.decoder) {
            // Slight hack, but it prevents code duplication:
            this.decoder.added_tokens = this.added_tokens;

            // Another slight hack to add `end_of_word_suffix` (if present) to the decoder
            // This is needed for cases where BPE model and ByteLevel decoder are used
            // For more information, see https://github.com/huggingface/transformers.js/issues/74
            // TODO: save this to the decoder when exporting?
            this.decoder.end_of_word_suffix = this.model.end_of_word_suffix;
        }

        this.added_tokens_regex =
            this.added_tokens.length > 0
                ? new RegExp(
                    this.added_tokens
                        .slice()
                        // Sort by length (desc) to avoid early partial matches
                        .sort((a: any, b: any) => b.content.length - a.content.length)
                        .map((x: any) => `${x.lstrip ? '\\s*' : ''}(${escapeRegExp(x.content)})${x.rstrip ? '\\s*' : ''}`)
                        .join('|'),
                )
                : null;

        // Set mask token if present (otherwise will be undefined, which is fine)
        this.mask_token = this.getToken('mask_token');
        this.mask_token_id = this.model.tokens_to_ids.get(this.mask_token);

        this.pad_token = this.getToken('pad_token', 'eos_token');
        this.pad_token_id = this.model.tokens_to_ids.get(this.pad_token);

        this.sep_token = this.getToken('sep_token');
        this.sep_token_id = this.model.tokens_to_ids.get(this.sep_token);

        this.unk_token = this.getToken('unk_token');
        this.unk_token_id = this.model.tokens_to_ids.get(this.unk_token);

        this.bos_token = this.getToken('bos_token');
        this.bos_token_id = this.model.tokens_to_ids.get(this.bos_token);

        this.eos_token = this.getToken('eos_token');
        this.eos_token_id = this.model.tokens_to_ids.get(this.eos_token);

        this.model_max_length = tokenizerConfig.model_max_length;

        /** @type {boolean} Whether or not to strip the text when tokenizing (removing excess spaces before and after the string). */
        this.remove_space = tokenizerConfig.remove_space;

        this.clean_up_tokenization_spaces = tokenizerConfig.clean_up_tokenization_spaces ?? true;
        this.do_lowercase_and_remove_accent = tokenizerConfig.do_lowercase_and_remove_accent ?? false;

        if (tokenizerConfig.padding_side) {
            this.padding_side = tokenizerConfig.padding_side;
        }

        this.legacy = false;

        this.chat_template = tokenizerConfig.chat_template ?? null;
        if (Array.isArray(this.chat_template)) {
            // Chat templates are stored as lists of dicts with fixed key names,
            // we reconstruct that into a single dict while loading them.
            var chat_template = Object.create(null);
            for (var { name, template } of this.chat_template) {
                if (typeof name !== 'string' || typeof template !== 'string') {
                    throw new Error('Chat template must be a list of objects with "name" and "template" properties');
                }
                chat_template[name] = template;
            }
            this.chat_template = chat_template;
        }
        this._compiled_template_cache = new Map();
    }

    /**
     * Returns the value of the first matching key in the tokenizer config object.
     * @param {...string} keys One or more keys to search for in the tokenizer config object.
     * @returns {string|null} The value associated with the first matching key, or null if no match is found.
     * @throws {Error} If an object is found for a matching key and its __type property is not "AddedToken".
     * @private
     */
    getToken(...keys: string[]) {
        for (var key of keys) {
            var item = this._tokenizer_config[key];

            if (!item) continue;

            if (typeof item === 'object') {
                if (item.__type === 'AddedToken') {
                    return item.content;
                } else {
                    throw Error(`Unknown token: ${item}`);
                }
            } else {
                return item;
            }
        }
        return null;
    }

    /**
     * Loads a pre-trained tokenizer from the given `pretrained_model_name_or_path`.
     *
     * @param {string} pretrained_model_name_or_path The path to the pre-trained tokenizer.
     * @param {PretrainedTokenizerOptions} options Additional options for loading the tokenizer.
     *
     * @throws {Error} Throws an error if the tokenizer.json or tokenizer_config.json files are not found in the `pretrained_model_name_or_path`.
     * @returns {Promise<PreTrainedTokenizer>} A new instance of the `PreTrainedTokenizer` class.
     */
    static async from_pretrained(
        pretrained_model_name_or_path: string,
        {
            progress_callback = null,
            config = null,
            cache_dir = null,
            local_files_only = false,
            revision = 'main',
            legacy: boolean = false,
        } = {},
    ) {
        var info = await loadTokenizer(pretrained_model_name_or_path, {
            progress_callback,
            config,
            cache_dir,
            local_files_only,
            revision,
            legacy: false,
        });

        // @ts-ignore
        return new this(...info);
    }

    /**
     * @typedef {number[]|number[][]|Tensor} BatchEncodingItem
     *
     * @typedef {Object} BatchEncoding Holds the output of the tokenizer's call function.
     * @property {BatchEncodingItem} input_ids List of token ids to be fed to a model.
     * @property {BatchEncodingItem} attention_mask List of indices specifying which tokens should be attended to by the model.
     * @property {BatchEncodingItem} [token_type_ids] List of token type ids to be fed to a model.
     */

    /**
     * Encode/tokenize the given text(s).
     * @param {string|string[]} text The text to tokenize.
     * @param {Object} options An optional object containing the following properties:
     * @param {string|string[]} [options.text_pair=null] Optional second sequence to be encoded. If set, must be the same type as text.
     * @param {boolean|'max_length'} [options.padding=false] Whether to pad the input sequences.
     * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
     * @param {boolean} [options.truncation=null] Whether to truncate the input sequences.
     * @param {number} [options.max_length=null] Maximum length of the returned list and optionally padding length.
     * @param {boolean} [options.return_tensor=true] Whether to return the results as Tensors or arrays.
     * @param {boolean} [options.return_token_type_ids=null] Whether to return the token type ids.
     * @returns {BatchEncoding} Object to be passed to the model.
     */
    _call(
        // Required positional arguments
        text: string | string[],

        // Optional keyword arguments
        {
            text_pair = null,
            add_special_tokens = true,
            padding = false,
            truncation = null,
            max_length = null,
            return_tensor = true, // Different to HF
            return_token_type_ids = null,
        }: {
            text_pair?: string | string[] | null;
            add_special_tokens?: boolean;
            padding?: boolean | 'max_length';
            truncation?: boolean | null;
            max_length?: number | null;
            return_tensor?: boolean;
            return_token_type_ids?: boolean | null;
        } = {},
    ) {
        var isBatched = Array.isArray(text);

        /** @type {EncodingSingle[]} */
        let encodedTokens;

        if (isBatched) {
            if (text.length === 0) {
                throw Error('text array must be non-empty');
            }

            if (text_pair !== null) {
                if (!Array.isArray(text_pair)) {
                    throw Error('text_pair must also be an array');
                } else if (text.length !== text_pair.length) {
                    throw Error('text and text_pair must have the same length');
                }

                encodedTokens = text.map((t, i) =>
                    this._encode_plus(t, { text_pair: text_pair[i] as string | null, add_special_tokens, return_token_type_ids }),
                );
            } else {
                encodedTokens = text.map((x: string) => this._encode_plus(x, { add_special_tokens, return_token_type_ids }));
            }
        } else {
            if (text === null || text === undefined) {
                throw Error('text may not be null or undefined');
            }

            if (Array.isArray(text_pair)) {
                throw Error(
                    'When specifying `text_pair`, since `text` is a string, `text_pair` must also be a string (i.e., not an array).',
                );
            }

            // For single input, we just wrap in an array, and then unwrap later.
            encodedTokens = [this._encode_plus(text, { text_pair, add_special_tokens, return_token_type_ids })];
        }
        // At this point, tokens is batched: [batch_size, tokens]
        // However, array may be jagged. So, we pad to max_length

        if (max_length === null) {
            if (padding === 'max_length') {
                (max_length as any) = this.model_max_length;
            } else {
                // Calculate max length from sequences
                (max_length as any) = max(encodedTokens.map((x) => x.input_ids.length))[0];
            }
        } else {
            if (!truncation) {
                console.warn(
                    `Truncation was not explicitly activated but \`max_length\` is provided a specific value, please use \`truncation=true\` to explicitly truncate examples to max length.`,
                );
            }
        }

        // Ensure it is less than model max length
        max_length = Math.min((max_length as any), this.model_max_length ?? Infinity);

        if (padding || truncation) {
            // Perform padding and/or truncation
            for (let i = 0; i < encodedTokens.length; ++i) {
                if (encodedTokens[i].input_ids.length === max_length) {
                    continue;
                } else if (encodedTokens[i].input_ids.length > max_length) {
                    // possibly truncate
                    if (truncation) {
                        truncateHelper((encodedTokens[i] as any), max_length);
                    }
                } else {
                    // t.length < max_length
                    // possibly pad
                    if (padding) {
                        padHelper(
                            (encodedTokens[i] as any),
                            max_length,
                            (key) => (key === 'input_ids' ? this.pad_token_id : 0),
                            this.padding_side,
                        );
                    }
                }
            }
        }

        var result: any = {};

        if (return_tensor) {
            if (!(padding && truncation)) {
                // Not, guaranteed that all items have same length, so
                // we perform additional check

                if (
                    encodedTokens.some((x: any) => {
                        for (var key of Object.keys(x)) {
                            if (x[key].length !== (encodedTokens as any)[0][key]?.length) {
                                return true;
                            }
                        }
                        return false;
                    })
                ) {
                    throw Error(
                        'Unable to create tensor, you should probably activate truncation and/or padding ' +
                        "with 'padding=true' and 'truncation=true' to have batched tensors with the same length.",
                    );
                }
            }

            // Now we actually convert to tensor
            // NOTE: In the same way as the python library, we return a batched tensor, regardless of
            // whether we have a single input or multiple inputs.
            var dims = [encodedTokens.length, encodedTokens[0].input_ids.length];
            for (var key of Object.keys(encodedTokens[0])) {
                result[key] = new Tensor(
                    'int64',
                    BigInt64Array.from((encodedTokens as any).flatMap((x: any) => x[key]).map(BigInt)),
                    dims,
                );
            }
        } else {
            for (var key of Object.keys(encodedTokens[0])) {
                result[key] = encodedTokens.map((x: any) => x[key]);
            }

            // If not returning a tensor, we match the input type
            if (!isBatched) {
                // Input was not batched, so we unwrap
                for (var key of Object.keys(result)) {
                    result[key] = result[key][0];
                }
            }
        }

        return /** @type {BatchEncoding} */ result;
    }

    /**
     * Encodes a single text using the preprocessor pipeline of the tokenizer.
     *
     * @param {string|null} text The text to encode.
     * @returns {string[]|null} The encoded tokens.
     */
    _encode_text(text: string | null): any[] | null {
        if (text === null) return null;

        // Actual function which does encoding, for a single text
        // First, we take care of special tokens. Needed to avoid issues arising from
        // normalization and/or pretokenization (which may not preserve special tokens)
        var sections = this.added_tokens_regex ? text.split(this.added_tokens_regex).filter((x) => x) : [text];

        var tokens = sections
            .map((x: string, section_index: number) => {
                var addedToken = this.added_tokens.find((t: AddedToken) => t.content === x);
                if (addedToken !== undefined) {
                    // Ignore added tokens
                    return x;
                } else {
                    if (this.remove_space === true) {
                        x = x.trim().split(/\s+/).join(' ');
                    }
                    if (this.do_lowercase_and_remove_accent) {
                        x = lowercase_and_remove_accent(x);
                    }

                    if (this.normalizer !== null) {
                        x = this.normalizer(x);
                    }

                    // If, after normalization, this section is empty (e.g., trimming whitespace),
                    // we return an empty array
                    if (x.length === 0) {
                        return [];
                    }

                    var sectionTokens =
                        this.pre_tokenizer !== null
                            ? this.pre_tokenizer(x, {
                                section_index,
                            })
                            : [x];

                    var tokens = this.model(sectionTokens);

                    return tokens;
                }
            })
            .flat();

        return tokens;
    }

    /**
     * Encodes a single text or a pair of texts using the model's tokenizer.
     *
     * @param {string} text The text to encode.
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.text_pair=null] The optional second text to encode.
     * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
     * @param {boolean} [options.return_token_type_ids=null] Whether to return token_type_ids.
     * @returns {EncodingSingle} An object containing the encoded text.
     * @private
     */
    _encode_plus(
        text: string,
        {
            text_pair = null,
            add_special_tokens = true,
            return_token_type_ids = null,
        }: {
            text_pair?: string | null;
            add_special_tokens?: boolean;
            return_token_type_ids?: boolean | null;
        } = {},
    ) {
        var { tokens, token_type_ids } = this._tokenize_helper(text, { pair: text_pair, add_special_tokens });

        var input_ids = this.model.convert_tokens_to_ids(tokens);

        var result: any = {
            input_ids,
            attention_mask: new Array(input_ids.length).fill(1),
        };
        if ((return_token_type_ids ?? this.return_token_type_ids) && token_type_ids) {
            result.token_type_ids = token_type_ids;
        }
        return result;
    }

    /**
     * Internal helper function to tokenize a text, and optionally a pair of texts.
     * @param {string} text The text to tokenize.
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.pair=null] The optional second text to tokenize.
     * @param {boolean} [options.add_special_tokens=false] Whether or not to add the special tokens associated with the corresponding model.
     * @returns {{tokens: string[], token_type_ids?: number[]}} An object containing the tokens and optionally the token type IDs.
     */
    _tokenize_helper(
        text: string,
        {
            pair = null,
            add_special_tokens = false,
        }: {
            pair?: string | null;
            add_special_tokens?: boolean;
        } = {},
    ) {
        var tokens = this._encode_text(text);
        var tokens2 = this._encode_text(pair);

        return this.post_processor
            ? this.post_processor(tokens, tokens2, { add_special_tokens })
            : { tokens: mergeArrays(tokens ?? [], tokens2 ?? []) };
    }

    /**
     * Converts a string into a sequence of tokens.
     * @param {string} text The sequence to be encoded.
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.pair] A second sequence to be encoded with the first.
     * @param {boolean} [options.add_special_tokens=false] Whether or not to add the special tokens associated with the corresponding model.
     * @returns {string[]} The list of tokens.
     */
    tokenize(text: string, { pair = null, add_special_tokens = false } = {}) {
        return this._tokenize_helper(text, { pair, add_special_tokens }).tokens;
    }

    /**
     * Encodes a single text or a pair of texts using the model's tokenizer.
     *
     * @param {string} text The text to encode.
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.text_pair=null] The optional second text to encode.
     * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
     * @param {boolean} [options.return_token_type_ids=null] Whether to return token_type_ids.
     * @returns {number[]} An array of token IDs representing the encoded text(s).
     */
    encode(text: string, { text_pair = null, add_special_tokens = true, return_token_type_ids = null } = {}) {
        return this._encode_plus(text, {
            text_pair,
            add_special_tokens,
            return_token_type_ids,
        }).input_ids;
    }

    /**
     * Decode a batch of tokenized sequences.
     * @param {number[][]|Tensor} batch List/Tensor of tokenized input sequences.
     * @param {Object} decode_args (Optional) Object with decoding arguments.
     * @returns {string[]} List of decoded sequences.
     */
    batch_decode(batch: number[][] | Tensor, decode_args = {}) {
        if (batch instanceof Tensor) {
            batch = batch.tolist();
        }
        return batch.map((x) => this.decode(x, decode_args));
    }

    /**
     * Decodes a sequence of token IDs back to a string.
     *
     * @param {number[]|bigint[]|Tensor} token_ids List/Tensor of token IDs to decode.
     * @param {Object} [decode_args={}]
     * @param {boolean} [decode_args.skip_special_tokens=false] If true, special tokens are removed from the output string.
     * @param {boolean} [decode_args.clean_up_tokenization_spaces=true] If true, spaces before punctuations and abbreviated forms are removed.
     *
     * @returns {string} The decoded string.
     * @throws {Error} If `token_ids` is not a non-empty array of integers.
     */
    decode(token_ids: number[] | bigint[] | Tensor, decode_args = {}) {
        if (token_ids instanceof Tensor) {
            token_ids = prepareTensorForDecode(token_ids);
        }

        if (!Array.isArray(token_ids) || token_ids.length === 0 || !isIntegralNumber(token_ids[0])) {
            throw Error('token_ids must be a non-empty array of integers.');
        }

        return this.decode_single(token_ids, decode_args);
    }

    /**
     * Decode a single list of token ids to a string.
     * @param {number[]|bigint[]} token_ids List of token ids to decode
     * @param {Object} decode_args Optional arguments for decoding
     * @param {boolean} [decode_args.skip_special_tokens=false] Whether to skip special tokens during decoding
     * @param {boolean} [decode_args.clean_up_tokenization_spaces=null] Whether to clean up tokenization spaces during decoding.
     * If null, the value is set to `this.decoder.cleanup` if it exists, falling back to `this.clean_up_tokenization_spaces` if it exists, falling back to `true`.
     * @returns {string} The decoded string
     */
    decode_single(
        token_ids: number[] | bigint[] | Tensor,
        { skip_special_tokens = false, clean_up_tokenization_spaces = null },
    ) {
        let tokens = this.model.convert_ids_to_tokens(token_ids);
        if (skip_special_tokens) {
            tokens = tokens.filter((x: string) => !this.special_tokens.includes(x));
        }

        // If `this.decoder` is null, we just join tokens with a space:
        // https://github.com/huggingface/tokenizers/blob/8edec536a737cb04494b454805be16c020abb14f/tokenizers/src/tokenizer/mod.rs#L835
        /** @type {string} */
        let decoded = this.decoder ? this.decoder(tokens) : tokens.join(' ');

        // Slight hack, but prevents having to pass `skip_special_tokens` to
        // each call to `decode`, which would lead to code duplication.
        if (this.decoder && this.decoder.end_of_word_suffix) {
            decoded = decoded.replaceAll(this.decoder.end_of_word_suffix, ' ');
            if (skip_special_tokens) {
                decoded = decoded.trim();
            }
        }

        if (clean_up_tokenization_spaces ?? this.clean_up_tokenization_spaces) {
            decoded = clean_up_tokenization(decoded);
        }

        return decoded;
    }

    /**
     * Retrieve the chat template string used for tokenizing chat messages. This template is used
     * internally by the `apply_chat_template` method and can also be used externally to retrieve the model's chat
     * template for better generation tracking.
     *
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.chat_template=null]
     * A Jinja template or the name of a template to use for this conversion.
     * It is usually not necessary to pass anything to this argument,
     * as the model's template will be used by default.
     * @param {Object[]} [options.tools=null]
     * A list of tools (callable functions) that will be accessible to the model. If the template does not
     * support function calling, this argument will have no effect. Each tool should be passed as a JSON Schema,
     * giving the name, description and argument types for the tool. See our
     * [chat templating guide](https://huggingface.co/docs/transformers/main/en/chat_templating#automated-function-conversion-for-tool-use)
     * for more information.
     * @returns {string} The chat template string.
     */
    get_chat_template({ chat_template = null, tools = null } = {}) {
        // First, handle the cases when the model has a dict of multiple templates
        if (this.chat_template && typeof this.chat_template === 'object') {
            var template_dict = this.chat_template;

            if (chat_template !== null && Object.hasOwn(template_dict, chat_template)) {
                // The user can pass the name of a template to the chat template argument instead of an entire template
                chat_template = template_dict[chat_template];
            } else if (chat_template === null) {
                if (tools !== null && 'tool_use' in template_dict) {
                    chat_template = template_dict['tool_use'];
                } else if ('default' in template_dict) {
                    chat_template = template_dict['default'];
                } else {
                    throw Error(
                        `This model has multiple chat templates with no default specified! Please either pass a chat ` +
                        `template or the name of the template you wish to use to the 'chat_template' argument. Available ` +
                        `template names are ${Object.keys(template_dict).sort()}.`,
                    );
                }
            }
        } else if (chat_template === null) {
            // These are the cases when the model has a single template
            // priority: `chat_template` argument > `tokenizer.chat_template`
            if (this.chat_template) {
                chat_template = this.chat_template;
            } else {
                throw Error(
                    'Cannot use apply_chat_template() because tokenizer.chat_template is not set and no template ' +
                    'argument was passed! For information about writing templates and setting the ' +
                    'tokenizer.chat_template attribute, please see the documentation at ' +
                    'https://huggingface.co/docs/transformers/main/en/chat_templating',
                );
            }
        }
        return chat_template;
    }

    /**
     * Converts a list of message objects with `"role"` and `"content"` keys to a list of token
     * ids. This method is intended for use with chat models, and will read the tokenizer's chat_template attribute to
     * determine the format and control tokens to use when converting.
     *
     * See [here](https://huggingface.co/docs/transformers/chat_templating) for more information.
     *
     * **Example:** Applying a chat template to a conversation.
     *
     * ```javascript
     * import { AutoTokenizer } from "@huggingface/transformers";
     *
     * var tokenizer = await AutoTokenizer.from_pretrained("Xenova/mistral-tokenizer-v1");
     *
     * var chat = [
     *   { "role": "user", "content": "Hello, how are you?" },
     *   { "role": "assistant", "content": "I'm doing great. How can I help you today?" },
     *   { "role": "user", "content": "I'd like to show off how chat templating works!" },
     * ]
     *
     * var text = tokenizer.apply_chat_template(chat, { tokenize: false });
     * // "<s>[INST] Hello, how are you? [/INST]I'm doing great. How can I help you today?</s> [INST] I'd like to show off how chat templating works! [/INST]"
     *
     * var input_ids = tokenizer.apply_chat_template(chat, { tokenize: true, return_tensor: false });
     * // [1, 733, 16289, 28793, 22557, 28725, 910, 460, 368, 28804, 733, 28748, 16289, 28793, 28737, 28742, 28719, 2548, 1598, 28723, 1602, 541, 315, 1316, 368, 3154, 28804, 2, 28705, 733, 16289, 28793, 315, 28742, 28715, 737, 298, 1347, 805, 910, 10706, 5752, 1077, 3791, 28808, 733, 28748, 16289, 28793]
     * ```
     *
     * @param {Message[]} conversation A list of message objects with `"role"` and `"content"` keys,
     * representing the chat history so far.
     * @param {Object} options An optional object containing the following properties:
     * @param {string} [options.chat_template=null] A Jinja template to use for this conversion. If
     * this is not passed, the model's chat template will be used instead.
     * @param {Object[]} [options.tools=null]
     * A list of tools (callable functions) that will be accessible to the model. If the template does not
     * support function calling, this argument will have no effect. Each tool should be passed as a JSON Schema,
     * giving the name, description and argument types for the tool. See our
     * [chat templating guide](https://huggingface.co/docs/transformers/main/en/chat_templating#automated-function-conversion-for-tool-use)
     * for more information.
     * @param {Record<string, string>[]} [options.documents=null]
     * A list of dicts representing documents that will be accessible to the model if it is performing RAG
     * (retrieval-augmented generation). If the template does not support RAG, this argument will have no
     * effect. We recommend that each document should be a dict containing "title" and "text" keys. Please
     * see the RAG section of the [chat templating guide](https://huggingface.co/docs/transformers/main/en/chat_templating#arguments-for-RAG)
     * for examples of passing documents with chat templates.
     * @param {boolean} [options.add_generation_prompt=false] Whether to end the prompt with the token(s) that indicate
     * the start of an assistant message. This is useful when you want to generate a response from the model.
     * Note that this argument will be passed to the chat template, and so it must be supported in the
     * template for this argument to have any effect.
     * @param {boolean} [options.tokenize=true] Whether to tokenize the output. If false, the output will be a string.
     * @param {boolean} [options.padding=false] Whether to pad sequences to the maximum length. Has no effect if tokenize is false.
     * @param {boolean} [options.truncation=false] Whether to truncate sequences to the maximum length. Has no effect if tokenize is false.
     * @param {number} [options.max_length=null] Maximum length (in tokens) to use for padding or truncation. Has no effect if tokenize is false.
     * If not specified, the tokenizer's `max_length` attribute will be used as a default.
     * @param {boolean} [options.return_tensor=true] Whether to return the output as a Tensor or an Array. Has no effect if tokenize is false.
     * @param {boolean} [options.return_dict=true] Whether to return a dictionary with named outputs. Has no effect if tokenize is false.
     * @param {Object} [options.tokenizer_kwargs={}] Additional options to pass to the tokenizer.
     * @returns {string | Tensor | number[]| number[][]|BatchEncoding} The tokenized output.
     */
    apply_chat_template(
        conversation: Message[],
        {
            tools = null,
            documents = null,
            chat_template = null,
            add_generation_prompt = false,
            tokenize = true,
            padding = false,
            truncation = false,
            max_length = null,
            return_tensor = true,
            return_dict = false,
            tokenizer_kwargs = {},
            ...kwargs
        } = {},
    ) {
        chat_template = this.get_chat_template({ chat_template, tools });

        if (typeof chat_template !== 'string') {
            throw Error(`chat_template must be a string, but got ${typeof chat_template}`);
        }

        // Compilation function uses a cache to avoid recompiling the same template
        let compiledTemplate = this._compiled_template_cache.get(chat_template);
        if (compiledTemplate === undefined) {
            compiledTemplate = new Template(chat_template);
            this._compiled_template_cache.set(chat_template, compiledTemplate);
        }

        var special_tokens_map = Object.create(null);
        for (var key of SPECIAL_TOKEN_ATTRIBUTES) {
            var value = this.getToken(key);
            if (value) {
                special_tokens_map[key] = value;
            }
        }

        var rendered = compiledTemplate.render({
            messages: conversation,
            add_generation_prompt,
            tools,
            documents,
            ...special_tokens_map,
            ...kwargs,
        });

        if (tokenize) {
            var out = this._call(rendered, {
                add_special_tokens: false,
                padding,
                truncation,
                max_length,
                return_tensor,
                ...tokenizer_kwargs,
            });
            return return_dict ? out : (out as { input_ids: any }).input_ids;
        }

        return rendered;
    }
}

/**
 * BertTokenizer is a class used to tokenize text for BERT models.
 * @extends PreTrainedTokenizer
 */
export class BertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
/**
 * Albert tokenizer
 * @extends PreTrainedTokenizer
 */
export class AlbertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class MobileBertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class SqueezeBertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class DebertaTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class DebertaV2Tokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class HerbertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class ConvBertTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class RoFormerTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}
export class DistilBertTokenizer extends PreTrainedTokenizer { }
export class CamembertTokenizer extends PreTrainedTokenizer { }
export class XLMTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;

    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);
        console.warn(
            'WARNING: `XLMTokenizer` is not yet supported by Hugging Face\'s "fast" tokenizers library. Therefore, you may experience slightly inaccurate results.',
        );
    }
}
export class ElectraTokenizer extends PreTrainedTokenizer {
    return_token_type_ids = true;
}

export class T5Tokenizer extends PreTrainedTokenizer { }
export class GPT2Tokenizer extends PreTrainedTokenizer { }
export class BartTokenizer extends PreTrainedTokenizer { }
export class MBartTokenizer extends PreTrainedTokenizer {
    languageRegex: RegExp;
    language_codes: string[];
    lang_to_token: (x: string) => string;

    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        this.languageRegex = /^[a-z]{2}_[A-Z]{2}$/;
        this.language_codes = this.special_tokens.filter((x) => this.languageRegex.test(x));
        this.lang_to_token = (x) => x; // Identity function
    }

    /**
     * Helper function to build translation inputs for an `MBartTokenizer`.
     * @param {string|string[]} raw_inputs The text to tokenize.
     * @param {Object} tokenizer_options Options to be sent to the tokenizer
     * @param {Object} generate_kwargs Generation options.
     * @returns {Object} Object to be passed to the model.
     */
    _build_translation_inputs(raw_inputs: string | string[], tokenizer_options: any, generate_kwargs: any) {
        return _build_translation_inputs(this, raw_inputs, tokenizer_options, generate_kwargs);
    }
}
export class MBart50Tokenizer extends MBartTokenizer { } // NOTE: extends MBartTokenizer

export class RobertaTokenizer extends PreTrainedTokenizer { }

export class BloomTokenizer extends PreTrainedTokenizer { }

var SPIECE_UNDERLINE = '▁';

export class LlamaTokenizer extends PreTrainedTokenizer {
    padding_side = 'left';

    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        this.legacy = tokenizerConfig.legacy ?? true;
        if (!this.legacy) {
            // See https://github.com/huggingface/transformers/pull/24565 for more information
            this.normalizer = null;
            this.pre_tokenizer = new MetaspacePreTokenizer({
                replacement: SPIECE_UNDERLINE,
                add_prefix_space: true,
                prepend_scheme: 'first',
            });
        }
    }

    /**
     * Helper function to handle legacy encoding of SPM tokenizers.
     * Adapted from https://github.com/huggingface/transformers/blob/e6dcf8abd6f65bb4b6dfc1831b20d9ba49ce00e2/src/transformers/models/t5/tokenization_t5.py#L374-L387
     * @param {string} text The text to encode.
     * @returns {string[]} The encoded tokens.
     */
    _encode_text(text: string | null) {
        if (text === null) return null;

        if (this.legacy || text.length === 0) {
            return super._encode_text(text);
        }

        let tokens = super._encode_text(SPIECE_UNDERLINE + text.replaceAll(SPIECE_UNDERLINE, ' ')) ?? [];
        if (tokens.length > 1 && tokens[0] === SPIECE_UNDERLINE && this.special_tokens.includes(tokens[1])) {
            tokens = tokens.slice(1);
        }
        return tokens;
    }
}
export class CodeLlamaTokenizer extends PreTrainedTokenizer { }

export class XLMRobertaTokenizer extends PreTrainedTokenizer { }
export class MPNetTokenizer extends PreTrainedTokenizer { }

export class FalconTokenizer extends PreTrainedTokenizer { }

export class GPTNeoXTokenizer extends PreTrainedTokenizer { }

export class EsmTokenizer extends PreTrainedTokenizer { }

export class Qwen2Tokenizer extends PreTrainedTokenizer { }

export class GemmaTokenizer extends PreTrainedTokenizer { }

export class Grok1Tokenizer extends PreTrainedTokenizer { }

/**
 * Helper function to build translation inputs for an `NllbTokenizer` or `M2M100Tokenizer`.
 * @param {PreTrainedTokenizer} self The tokenizer instance.
 * @param {string|string[]} raw_inputs The text to tokenize.
 * @param {Object} tokenizer_options Options to be sent to the tokenizer
 * @param {Object} generate_kwargs Generation options.
 * @returns {Object} Object to be passed to the model.
 * @private
 */
function _build_translation_inputs(self: any, raw_inputs: any, tokenizer_options: any, generate_kwargs: any) {
    if (!('language_codes' in self) || !Array.isArray(self.language_codes)) {
        throw new Error('Tokenizer must have `language_codes` attribute set and it should be an array of language ids.');
    }
    if (!('languageRegex' in self) || !(self.languageRegex instanceof RegExp)) {
        throw new Error('Tokenizer must have `languageRegex` attribute set and it should be a regular expression.');
    }
    if (!('lang_to_token' in self) || typeof self.lang_to_token !== 'function') {
        throw new Error('Tokenizer must have `lang_to_token` attribute set and it should be a function.');
    }
    var src_lang_token = generate_kwargs.src_lang;
    var tgt_lang_token = generate_kwargs.tgt_lang;

    // Check that the target language is valid:
    if (!self.language_codes.includes(tgt_lang_token)) {
        throw new Error(
            `Target language code "${tgt_lang_token}" is not valid. Must be one of: {${self.language_codes.join(', ')}}`,
        );
    }

    // Allow `src_lang` to be optional. If not set, we'll use the tokenizer's default.
    if (src_lang_token !== undefined) {
        // Check that the source language is valid:
        if (!self.language_codes.includes(src_lang_token)) {
            throw new Error(
                `Source language code "${src_lang_token}" is not valid. Must be one of: {${self.language_codes.join(', ')}}`,
            );
        }

        // In the same way as the Python library, we override the post-processor
        // to force the source language to be first:
        for (var item of self.post_processor.config.single) {
            if ('SpecialToken' in item && self.languageRegex.test(item.SpecialToken.id)) {
                item.SpecialToken.id = self.lang_to_token(src_lang_token);
                break;
            }
        }
        // TODO: Do the same for pair?
    }

    // Override the `forced_bos_token_id` to force the correct language
    generate_kwargs.forced_bos_token_id = self.model.convert_tokens_to_ids([self.lang_to_token(tgt_lang_token)])[0];

    return self._call(raw_inputs, tokenizer_options);
}

/**
 * The NllbTokenizer class is used to tokenize text for NLLB ("No Language Left Behind") models.
 *
 * No Language Left Behind (NLLB) is a first-of-its-kind, AI breakthrough project
 * that open-sources models capable of delivering high-quality translations directly
 * between any pair of 200+ languages — including low-resource languages like Asturian,
 * Luganda, Urdu and more. It aims to help people communicate with anyone, anywhere,
 * regardless of their language preferences. For more information, check out their
 * [paper](https://arxiv.org/abs/2207.04672).
 *
 * For a list of supported languages (along with their language codes),
 * @see {@link https://github.com/facebookresearch/flores/blob/main/flores200/README.md#languages-in-flores-200}
 */
export class NllbTokenizer extends PreTrainedTokenizer {
    languageRegex: RegExp;
    language_codes: string[];
    lang_to_token: (x: string) => string;

    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        this.languageRegex = /^[a-z]{3}_[A-Z][a-z]{3}$/;
        this.language_codes = (this as any).special_tokens.filter((x: string) => this.languageRegex.test(x));
        this.lang_to_token = (x) => x; // Identity function
    }

    /**
     * Helper function to build translation inputs for an `NllbTokenizer`.
     * @param {string|string[]} raw_inputs The text to tokenize.
     * @param {Object} tokenizer_options Options to be sent to the tokenizer
     * @param {Object} generate_kwargs Generation options.
     * @returns {Object} Object to be passed to the model.
     */
    _build_translation_inputs(raw_inputs: any, tokenizer_options: any, generate_kwargs: any) {
        return _build_translation_inputs(this, raw_inputs, tokenizer_options, generate_kwargs);
    }
}

/**
 * The M2M100Tokenizer class is used to tokenize text for M2M100 ("Many-to-Many") models.
 *
 * M2M100 is a multilingual encoder-decoder (seq-to-seq) model trained for Many-to-Many
 * multilingual translation. It was introduced in this [paper](https://arxiv.org/abs/2010.11125)
 * and first released in [this](https://github.com/pytorch/fairseq/tree/master/examples/m2m_100) repository.
 *
 * For a list of supported languages (along with their language codes),
 * @see {@link https://huggingface.co/facebook/m2m100_418M#languages-covered}
 */
export class M2M100Tokenizer extends PreTrainedTokenizer {
    languageRegex: RegExp;
    language_codes: string[];
    lang_to_token: (x: string) => string;

    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        this.languageRegex = /^__[a-z]{2,3}__$/;
        this.language_codes = (this as any).special_tokens
            .filter((x: string) => this.languageRegex.test(x))
            .map((x: string) => x.slice(2, -2));
        this.lang_to_token = (x: string) => `__${x}__`;
    }

    /**
     * Helper function to build translation inputs for an `M2M100Tokenizer`.
     * @param {string|string[]} raw_inputs The text to tokenize.
     * @param {Object} tokenizer_options Options to be sent to the tokenizer
     * @param {Object} generate_kwargs Generation options.
     * @returns {Object} Object to be passed to the model.
     */
    _build_translation_inputs(raw_inputs: any, tokenizer_options: any, generate_kwargs: any) {
        return _build_translation_inputs(this, raw_inputs, tokenizer_options, generate_kwargs);
    }
}

/**
 * WhisperTokenizer tokenizer
 * @extends PreTrainedTokenizer
 */
export class WhisperTokenizer extends PreTrainedTokenizer {
    get timestamp_begin() {
        return (this as any).model.convert_tokens_to_ids(['<|notimestamps|>'])[0] + 1;
    }

    /**
     * Decodes automatic speech recognition (ASR) sequences.
     * @param {Array<{tokens: bigint[], token_timestamps?: number[], stride: number[]}>} sequences The sequences to decode.
     * @param {Object} options The options to use for decoding.
     * @returns {Array<string|{chunks?: undefined|Array<{language: string|null, timestamp: Array<number|null>, text: string}>}>} The decoded sequences.
     */
    _decode_asr(
        sequences: { tokens: bigint[]; token_timestamps?: number[]; stride: number[] }[],
        {
            return_timestamps = null,
            return_language = false,
            time_precision = null,
            force_full_sequences = true,
        }: any = {},
    ) {
        // Set force_full_sequences=false if you want streaming
        // TODO add support for `return_language`

        // Internal method meant to only be used by asr pipeline.
        // Handles all the little quirks specific to whisper to handle
        // the various options not allowed in other seq2seq models

        // =========== Overview ============
        // - iterate over all outputs
        // - all tokens within output
        // - Each token can be
        //   - language token
        //   - special token
        //   - timestamp token
        //   - text token
        // - We accumulate the text tokens.
        // - We split on end timestamps
        // - Lots of complexity comes from stride and timestamps

        if (time_precision === null) {
            throw Error('Must specify time_precision');
        }
        let last_language: string | null = null;

        var returnWordTimestamps = return_timestamps === 'word';

        function new_chunk() {
            return { language: last_language, 'timestamp': [null, null], text: '', words: [] };
        }

        // Welcome to the state machine!
        var chunks: any = [];
        let chunk = new_chunk();
        let time_offset = 0.0;
        var timestamp_begin = this.timestamp_begin;
        // Whisper timestamp tokens start from 0.00 and go to timestamp 30.00 in 0.02 increments.
        // We can calculate the last time stamp token as timestamp_begin plus the number of tokens
        // tokens from 0.00 to 30.00 which is 1500.
        var total_timestamp_tokens = 1500; // (30.00 - 0.00) / 0.02
        var timestamp_end = timestamp_begin + total_timestamp_tokens;

        let previous_tokens: number[] = [];
        let previous_token_timestamps: number[] = [];

        let skip = false;
        let right_stride_start = null;

        var all_special_ids = new Set((this as any).all_special_ids);

        for (var output of sequences) {
            // NOTE: python version has batches, so it uses [0]
            var token_ids = output.tokens;
            var token_timestamps = returnWordTimestamps ? output.token_timestamps : null;

            // These keep track of timestamps within strides, which need
            // to be skipped and resolve all tokens in a single chunk.
            let last_timestamp = null;
            let first_timestamp = timestamp_begin;

            if ('stride' in output) {
                var [chunk_len, stride_left, stride_right] = output.stride;

                // Offset the timings to account for the other `model_outputs`.
                time_offset -= stride_left;
                right_stride_start = chunk_len - stride_right;

                // Keeping track of timestamps within strides
                // We're going to NOT split on those, and delay until we're
                // out of BOTH stride. Otherwise lots of issues occur and
                // corner cases
                if (stride_left) {
                    first_timestamp = stride_left / time_precision + timestamp_begin;
                }

                if (stride_right) {
                    for (let i = token_ids.length - 1; i >= 0; --i) {
                        var token = Number(token_ids[i]);
                        if (token >= timestamp_begin) {
                            // There can be several token in the right stride
                            // But the last one is ALWAYS going to be skipped
                            if (last_timestamp !== null && (token - timestamp_begin) * time_precision < right_stride_start) {
                                break;
                            }
                            last_timestamp = token;
                        }
                    }
                }
            }

            let current_tokens: number[] = [];
            let current_token_timestamps: any | null = null;

            // - all tokens within output
            for (let i = 0; i < token_ids.length; ++i) {
                var token = Number(token_ids[i]);
                // 4 possible states for each token
                // - 1/ Language code
                // - 2/ all other special tokens (which we ignore)
                // - 3/ Timestamp
                // - 4/ Regular text

                if (all_special_ids.has(token)) {
                    var text = this.decode([token]);
                    var language = WHISPER_LANGUAGE_MAPPING.get(text.slice(2, -2));

                    if (language !== undefined) {
                        // 1/ Indeed some language
                        // TODO Handle when language is different from the previous
                        // one, and we cannot use timestamped tokens to create chunks
                        if (last_language !== null && language !== last_language && !return_timestamps) {
                            previous_tokens.push(...current_tokens);
                            var resolved_tokens = this.findLongestCommonSequence([previous_tokens], null)[0];
                            var resolved_text = this.decode(resolved_tokens ?? [], {});
                            chunk.text = resolved_text;
                            chunks.push(chunk);

                            // Flush all our temporary context
                            previous_tokens = [];
                            current_tokens = [];
                            chunk = new_chunk();
                        }

                        last_language = chunk.language = language as string;
                    } else {
                        // 2/ This is a regular special token, ignoring it
                    }
                } else if (token >= timestamp_begin && token <= timestamp_end) {
                    // 3/ Timestamp token
                    var time = (token - timestamp_begin) * time_precision + time_offset;
                    var rounded_time = round(time, 2);

                    if (last_timestamp !== null && token >= last_timestamp) {
                        // Whisper outputted a timestamp token, but it falls within
                        // our stride, so we're going to skip it for the time being
                        // and resolve this later
                        // Skip is necessary because timestamp tokens always come
                        // by pair, so we need to skip the next one too (which would mark the start of another chunk).
                        skip = true;
                    } else if (skip || (previous_tokens.length > 0 && token < first_timestamp)) {
                        skip = false;
                    } else if (chunk.timestamp[0] === null) {
                        chunk.timestamp[0] = rounded_time as any;
                    } else {
                        // This is the end of the timestamp chunk
                        if (rounded_time === chunk.timestamp[0]) {
                            // This is a bug in timestamp token output
                            // where we're taking the duplicate token
                            // as a stop where it should be a start.
                            // This is an issue in the underlying model output
                            // Let's just skip it so it becomes de-factor a start agin
                        } else {
                            chunk.timestamp[1] = rounded_time as any;

                            // Handling merges
                            previous_tokens.push(...current_tokens);

                            if (returnWordTimestamps && current_token_timestamps) {
                                previous_token_timestamps.push(...current_token_timestamps);
                            }
                            var [resolved_tokens, resolved_token_timestamps] = this.findLongestCommonSequence(
                                [previous_tokens],
                                [previous_token_timestamps],
                            );

                            var resolved_text = this.decode(resolved_tokens ?? [], {});
                            chunk.text = resolved_text;

                            if (returnWordTimestamps) {
                                chunk.words = this.collateWordTimestamps(resolved_tokens ?? [], [resolved_token_timestamps ?? []], last_language as string);
                            }

                            chunks.push(chunk);

                            // Flush all our temporary context
                            previous_tokens = [];
                            current_tokens = [];
                            previous_token_timestamps = [];
                            current_token_timestamps = [];
                            chunk = new_chunk();
                        }
                    }
                } else {
                    // 4/ Regular token
                    // We just append to the list of all tokens so we can handle
                    // merges later and decode into text.
                    current_tokens.push(token);

                    if (returnWordTimestamps) {
                        let start_time: number = round((token_timestamps as any)[i] + time_offset, 2);

                        let end_time: number | null = null;
                        if (i + 1 < (token_timestamps as any).length) {
                            end_time = round((token_timestamps as any)[i + 1] + time_offset, 2);

                            // Do not allow punctuation-only tokens to have a duration.
                            // This prevents long pauses from messing up the timestamps.
                            var decoded_text = this.decode([token], {});
                            if (PUNCTUATION_ONLY_REGEX.test(decoded_text)) {
                                // Add `time_precision` to avoid overlapping timestamps
                                end_time = round(Math.min(start_time + time_precision, end_time), 2);
                            }
                        } else {
                            // should never happen
                            end_time = null;
                        }
                        current_token_timestamps.push([(start_time), end_time]);
                    }
                }
            }

            if ('stride' in output) {
                var [chunk_len, stride_left, stride_right] = output.stride;
                time_offset += chunk_len - stride_right;
            }

            // Leftover tokens
            if (current_tokens.length > 0) {
                previous_tokens.push(...current_tokens);
                if (returnWordTimestamps && current_token_timestamps) {
                    previous_token_timestamps.push(...current_token_timestamps);
                }
            } else if (previous_tokens.every((p) => (p as any).length === 0)) {
                // Flushing previous tokens (END)"
                chunk = new_chunk();
                previous_tokens = [];
                current_tokens = [];
                previous_token_timestamps = [];
                current_token_timestamps = [];
            }
        }

        if (previous_tokens.length > 0) {
            if (force_full_sequences && return_timestamps) {
                // Last token should always be timestamps, so there shouldn't be
                // leftover
                throw new Error(
                    'Whisper did not predict an ending timestamp, which can happen if audio is cut off in the middle of a word. ' +
                    'Also make sure WhisperTimeStampLogitsProcessor was used during generation.',
                );
            }

            // Happens when we don't use timestamps
            var [resolved_tokens, resolved_token_timestamps] = this.findLongestCommonSequence(
                [previous_tokens],
                [previous_token_timestamps],
            );

            // Flushing previous tokens (FINAL)
            var resolved_text = this.decode((resolved_tokens as any), {});
            chunk.text = resolved_text;
            if (returnWordTimestamps) {
                chunk.words = this.collateWordTimestamps((resolved_tokens as any), (resolved_token_timestamps as any), last_language as any);
            }
            chunks.push(chunk);
        }

        let optional = Object.create(null);

        // Preparing and cleaning up the pipeline output
        var full_text = chunks.map(((chunk: any) => chunk.text)).join('');
        if (return_timestamps || return_language) {
            for (let i = 0; i < chunks.length; ++i) {
                var chunk = chunks[i];
                if (!return_timestamps) {
                    delete chunk['timestamp'];
                }

                if (!return_language) {
                    delete chunk['language'];
                }
            }
            if (returnWordTimestamps) {
                var new_chunks: any = [];
                for (var chunk of chunks) {
                    for (var word of chunk.words) {
                        new_chunks.push(word);
                    }
                }
                optional = { chunks: new_chunks };
            } else {
                optional = { chunks: chunks };
            }
        }
        return [full_text, optional];
    }

    /**
     * Finds the longest common sequence among the provided sequences.
     * @param {number[][]} sequences An array of sequences of token ids to compare.
     * @returns {number[][]} The longest common sequence found.
     * @throws {Error} If there is a bug within the function.
     * @private
     */
    findLongestCommonSequence(sequences: number[][], token_timestamp_sequences: number[][] | null = null) {
        // It would be much harder to do O(n) because of fault tolerance.
        // We actually have a really good property which is that the total sequence
        // MUST be those subsequences in order.
        // If token_timestamp_sequences is provided, will split those sequences in
        // exactly the same way.
        let leftSequence = sequences[0];
        let leftLength = leftSequence.length;
        let totalSequence = [];

        var use_token_timestamp_sequences =
            Array.isArray(token_timestamp_sequences) && token_timestamp_sequences.length > 0;
        let total_token_timestamp_sequence = use_token_timestamp_sequences ? [] : null;
        let left_token_timestamp_sequence = use_token_timestamp_sequences ? token_timestamp_sequences[0] : null;
        for (let i = 1; i < sequences.length; ++i) {
            var rightSequence = sequences[i];
            let max = 0.0;
            let maxIndices = [leftLength, leftLength, 0, 0];
            // Here we're sliding matches
            // [a, b, c, d]
            //          [c, d, f]
            // =        [c] == [d]

            // [a, b, c, d]
            //       [c, d, f]
            // =     [c, d] == [c, d]

            // [a, b, c, d]
            //    [c, d, f]

            // =  [b, c, d] == [c, d, f]

            // [a, b, c, d]
            // [c, d, f]

            // [a, b, c] == [c, d, f]

            // [a, b, c, d]
            // [d, f]

            // [a, b] == [d, f]

            // [a, b, c, d]
            // [f]

            // [a] == [f]

            var rightLength = rightSequence.length;
            for (let j = 1; j < leftLength + rightLength; ++j) {
                // Slightly convoluted because we don't want out of bound indices
                // This will be necessary for a small conflict resolution optimization
                // later
                var leftStart = Math.max(0, leftLength - j);
                var leftStop = Math.min(leftLength, leftLength + rightLength - j);
                var left = leftSequence.slice(leftStart, leftStop);
                var rightStart = Math.max(0, j - leftLength);
                var rightStop = Math.min(rightLength, j);
                var right = rightSequence.slice(rightStart, rightStop);
                if (left.length !== right.length) {
                    throw new Error(
                        'There is a bug within whisper `decode_asr` function, please report it. Dropping to prevent bad inference.',
                    );
                }

                let matches;
                if (use_token_timestamp_sequences) {
                    // Get length of longest subsequence of tokens that match
                    // and have timestamps that are in order
                    matches = left.filter(
                        (elem, idx) =>
                            elem === right[idx] &&
                            (left_token_timestamp_sequence as any)[leftStart + idx] <= (token_timestamp_sequences as any)[i][rightStart + idx],
                    ).length;
                } else {
                    matches = left.filter((elem, idx) => elem === right[idx]).length;
                }

                // epsilon to favor long perfect matches
                var eps = j / 10000.0;
                var matching = matches / j + eps;
                if (matches > 1 && matching > max) {
                    max = matching;
                    maxIndices = [leftStart, leftStop, rightStart, rightStop];
                }
            }
            var [leftStart, leftStop, rightStart, rightStop] = maxIndices;
            var leftMid = Math.floor((leftStop + leftStart) / 2);
            var rightMid = Math.floor((rightStop + rightStart) / 2);
            totalSequence.push(...leftSequence.slice(0, leftMid));
            leftSequence = rightSequence.slice(rightMid);
            leftLength = leftSequence.length;

            if (use_token_timestamp_sequences) {
                (total_token_timestamp_sequence as number[][]).push(...[left_token_timestamp_sequence?.slice(0, leftMid) ?? []]);
                left_token_timestamp_sequence = token_timestamp_sequences[i].slice(rightMid);
            }
        }
        totalSequence.push(...leftSequence);

        if (use_token_timestamp_sequences) {
            // Major change here
            (total_token_timestamp_sequence as number[][]).push(...[left_token_timestamp_sequence ?? []]);
            return [totalSequence, total_token_timestamp_sequence];
        } else {
            return [totalSequence, []];
        }
    }

    /** @private */
    collateWordTimestamps(tokens: number[], token_timestamps: number[][], language: string): any {
        var [words, _, token_indices] = this.combineTokensIntoWords(tokens, language);

        var timings = [];
        for (let i = 0; i < words.length; ++i) {
            var indices = token_indices[i];
            timings.push({
                text: words[i],
                timestamp: [token_timestamps[(indices as any).at(0)][0], token_timestamps[(indices as any).at(-1)][1]],
            });
        }
        return timings;
    }

    /**
     * Groups tokens by word. Returns a tuple containing a list of strings with the words,
     * and a list of `token_id` sequences with the tokens making up each word.
     * @param {number[]} tokens
     * @param {string} [language]
     * @param {string} prepend_punctionations
     * @param {string} append_punctuations
     *
     * @private
     */
    combineTokensIntoWords(
        tokens: number[],
        language: string,
        prepend_punctionations = '"\'"¡¿([{-',
        append_punctuations = '"\'.。,，!！?？:："")]}、',
    ) {
        language = language ?? 'english';

        let words, word_tokens, token_indices;

        if (['chinese', 'japanese', 'thai', 'lao', 'myanmar'].includes(language)) {
            // These languages don't typically use spaces.
            [words, word_tokens, token_indices] = this.splitTokensOnUnicode(tokens);
        } else {
            [words, word_tokens, token_indices] = this.splitTokensOnSpaces(tokens);
        }

        return this.mergePunctuations(words, word_tokens, token_indices, prepend_punctionations, append_punctuations);
    }

    /** @type {PreTrainedTokenizer['decode']} */
    decode(token_ids: number[] | bigint[] | Tensor, decode_args: any = {}) {
        let text;
        // @ts-ignore
        if (decode_args?.decode_with_timestamps) {
            if (token_ids instanceof Tensor) {
                token_ids = prepareTensorForDecode(token_ids);
            }
            text = this.decodeWithTimestamps(token_ids as number[], decode_args);
        } else {
            text = super.decode(token_ids, decode_args);
        }
        // TODO: implement offsets
        // if (decode_args.output_offsets) {
        //     let offsets = this.computeOffsets
        // }
        return text;
    }

    /**
     * @param {number[]|bigint[]} token_ids List of token IDs to decode.
     * @param {Object} decode_args Optional arguments for decoding
     * @private
     */
    decodeWithTimestamps(token_ids: number[] | bigint[], decode_args: any) {
        var time_precision = decode_args?.time_precision ?? 0.02;

        var timestamp_begin = (Array.from(this.all_special_ids).at(-1) ?? 0) + 1;
        /**@type {Array} */
        let outputs = Array<any>();
        for (let token of token_ids) {
            token = Number(token);
            if (token >= timestamp_begin) {
                var timestamp = ((token - timestamp_begin) * time_precision).toFixed(2);
                outputs.push(`<|${timestamp}|>`);
                outputs.push([]);
            } else {
                outputs[outputs.length - 1].push(token);
            }
        }
        outputs = outputs.map((s) => (typeof s === 'string' ? s : super.decode(s, decode_args)));

        return outputs.join('');
    }

    /**
     * Combine tokens into words by splitting at any position where the tokens are decoded as valid unicode points.
     * @param {number[]} tokens
     * @returns {*}
     * @private
     */
    splitTokensOnUnicode(tokens: number[]) {
        var decoded_full = this.decode(tokens, {
            // @ts-ignore
            decode_with_timestamps: true,
        });
        var replacement_char = '\uFFFD';

        var words = [];
        var word_tokens = [];
        var token_indices = [];
        let current_tokens = [];
        let current_indices = [];
        let unicode_offset = 0;

        for (let token_idx = 0; token_idx < tokens.length; ++token_idx) {
            var token = tokens[token_idx];

            current_tokens.push(token);
            current_indices.push(token_idx);

            var decoded = this.decode(current_tokens, {
                // @ts-ignore
                decode_with_timestamps: true,
            });

            if (
                !decoded.includes(replacement_char) ||
                decoded_full[unicode_offset + decoded.indexOf(replacement_char)] === replacement_char
            ) {
                words.push(decoded);
                word_tokens.push(current_tokens);
                token_indices.push(current_indices);
                current_tokens = [];
                current_indices = [];
                unicode_offset += decoded.length;
            }
        }

        return [words, word_tokens, token_indices];
    }

    /**
     * Combine tokens into words by splitting at whitespace and punctuation tokens.
     * @param {number[]} tokens
     * @private
     */
    splitTokensOnSpaces(tokens: number[]) {
        var [subwords, subword_tokens_list, subword_indices_list] = this.splitTokensOnUnicode(tokens);

        var words = [];
        var word_tokens = [];
        var token_indices = [];

        var punctuationRegex = new RegExp(`^[${PUNCTUATION_REGEX}]$`, 'gu');

        for (let i = 0; i < subwords.length; ++i) {
            var subword = subwords[i];
            var subword_tokens = subword_tokens_list[i];
            var subword_indices = subword_indices_list[i];

            // @ts-ignore
            var special = subword_tokens[0] >= this.model.tokens_to_ids.get('<|endoftext|>');
            var with_space = subword.startsWith(' ');
            var trimmed = subword.trim();
            var punctuation = punctuationRegex.test(trimmed);

            if (special || with_space || punctuation || words.length === 0) {
                words.push(subword);
                word_tokens.push(subword_tokens);
                token_indices.push(subword_indices);
            } else {
                var ix = words.length - 1;
                words[ix] += subword;
                word_tokens[ix].push(...subword_tokens);
                token_indices[ix].push(...subword_indices);
            }
        }

        return [words, word_tokens, token_indices];
    }

    /**
     * Merges punctuation tokens with neighboring words.
     * @param {string[]} words
     * @param {number[][]} tokens
     * @param {number[][]} indices
     * @param {string} prepended
     * @param {string} appended
     * @private
     */
    mergePunctuations(words: string[], tokens: number[][], indices: number[][], prepended: string, appended: string) {
        var newWords = structuredClone(words);
        var newTokens = structuredClone(tokens);
        var newIndices = structuredClone(indices);

        // prepend punctuations
        let i = newWords.length - 2;
        let j = newWords.length - 1;

        while (i >= 0) {
            if (newWords[i].startsWith(' ') && prepended.includes(newWords[i].trim())) {
                newWords[j] = newWords[i] + newWords[j];
                newTokens[j] = mergeArrays(newTokens[i], newTokens[j]);
                newIndices[j] = mergeArrays(newIndices[i], newIndices[j]);
                newWords[i] = '';
                newTokens[i] = [];
                newIndices[i] = [];
            } else {
                j = i;
            }
            --i;
        }

        // append punctuations
        i = 0;
        j = 1;
        while (j < newWords.length) {
            if (!newWords[i].endsWith(' ') && appended.includes(newWords[j])) {
                newWords[i] += newWords[j];
                newTokens[i] = mergeArrays(newTokens[i], newTokens[j]);
                newIndices[i] = mergeArrays(newIndices[i], newIndices[j]);
                newWords[j] = '';
                newTokens[j] = [];
                newIndices[j] = [];
            } else {
                i = j;
            }
            ++j;
        }

        return [newWords.filter((x) => x), newTokens.filter((x) => x.length > 0), newIndices.filter((x) => x.length > 0)];
    }
}
export class CodeGenTokenizer extends PreTrainedTokenizer { }
export class CLIPTokenizer extends PreTrainedTokenizer { }
export class SiglipTokenizer extends PreTrainedTokenizer { }

/**
 * @todo This model is not yet supported by Hugging Face's "fast" tokenizers library (https://github.com/huggingface/tokenizers).
 * Therefore, this implementation (which is based on fast tokenizers) may produce slightly inaccurate results.
 */
export class MarianTokenizer extends PreTrainedTokenizer {
    /**
     * Create a new MarianTokenizer instance.
     * @param {Object} tokenizerJSON The JSON of the tokenizer.
     * @param {Object} tokenizerConfig The config of the tokenizer.
     */
    supported_language_codes: string[];
    languageRegex: RegExp;
    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        this.languageRegex = /^(>>\w+<<)\s*/g;

        this.supported_language_codes = this.model.vocab.filter((x: string) => this.languageRegex.test(x));

        console.warn(
            'WARNING: `MarianTokenizer` is not yet supported by Hugging Face\'s "fast" tokenizers library. Therefore, you may experience slightly inaccurate results.',
        );
    }

    /**
     * Encodes a single text. Overriding this method is necessary since the language codes
     * must be removed before encoding with sentencepiece model.
     * @see https://github.com/huggingface/transformers/blob/12d51db243a00726a548a43cc333390ebae731e3/src/transformers/models/marian/tokenization_marian.py#L204-L213
     *
     * @param {string|null} text The text to encode.
     * @returns {Array} The encoded tokens.
     */
    _encode_text(text: string | null): any {
        if (text === null) return null;

        // Check if text starts with language code:
        var [matchInfo, ...remainder] = text.trim().split(this.languageRegex);

        if (remainder.length === 0) {
            // No language code, encode normally
            return super._encode_text(matchInfo);
        } else if (remainder.length === 2) {
            // Text starts with language code, so we do not encode it with sentencepiece.
            var [language, text] = remainder;

            if (!this.supported_language_codes.includes(language)) {
                console.warn(
                    `Unsupported language code "${language}" detected, which may lead to unexpected behavior. Should be one of: ${JSON.stringify(this.supported_language_codes)}`,
                );
            }
            return mergeArrays([language], (super._encode_text as any)(text));
        }
    }
}

export class Wav2Vec2CTCTokenizer extends PreTrainedTokenizer { }

export class BlenderbotTokenizer extends PreTrainedTokenizer { }
export class BlenderbotSmallTokenizer extends PreTrainedTokenizer { }

export class SpeechT5Tokenizer extends PreTrainedTokenizer { }

export class NougatTokenizer extends PreTrainedTokenizer { }

export class VitsTokenizer extends PreTrainedTokenizer {
    constructor(tokenizerJSON: any, tokenizerConfig: any) {
        super(tokenizerJSON, tokenizerConfig);

        // Custom decoder function
        this.decoder = new VitsDecoder({});
    }
}

export class CohereTokenizer extends PreTrainedTokenizer { }

export class MgpstrTokenizer extends PreTrainedTokenizer { }

/**
 * Helper class which is used to instantiate pretrained tokenizers with the `from_pretrained` function.
 * The chosen tokenizer class is determined by the type specified in the tokenizer config.
 *
 * @example
 * var tokenizer = await AutoTokenizer.from_pretrained('Xenova/bert-base-uncased');
 */
export class AutoTokenizer {
    static TOKENIZER_CLASS_MAPPING = {
        T5Tokenizer,
        DistilBertTokenizer,
        CamembertTokenizer,
        DebertaTokenizer,
        DebertaV2Tokenizer,
        BertTokenizer,
        HerbertTokenizer,
        ConvBertTokenizer,
        RoFormerTokenizer,
        XLMTokenizer,
        ElectraTokenizer,
        MobileBertTokenizer,
        SqueezeBertTokenizer,
        AlbertTokenizer,
        GPT2Tokenizer,
        BartTokenizer,
        MBartTokenizer,
        MBart50Tokenizer,
        RobertaTokenizer,
        WhisperTokenizer,
        CodeGenTokenizer,
        CLIPTokenizer,
        SiglipTokenizer,
        MarianTokenizer,
        BloomTokenizer,
        NllbTokenizer,
        M2M100Tokenizer,
        LlamaTokenizer,
        CodeLlamaTokenizer,
        XLMRobertaTokenizer,
        MPNetTokenizer,
        FalconTokenizer,
        GPTNeoXTokenizer,
        EsmTokenizer,
        Wav2Vec2CTCTokenizer,
        BlenderbotTokenizer,
        BlenderbotSmallTokenizer,
        SpeechT5Tokenizer,
        NougatTokenizer,
        VitsTokenizer,
        Qwen2Tokenizer,
        GemmaTokenizer,
        Grok1Tokenizer,
        CohereTokenizer,
        MgpstrTokenizer,

        // Base case:
        PreTrainedTokenizer,
    };

    /**
     * Instantiate one of the tokenizer classes of the library from a pretrained model.
     *
     * The tokenizer class to instantiate is selected based on the `tokenizer_class` property of the config object
     * (either passed as an argument or loaded from `pretrained_model_name_or_path` if possible)
     *
     * @param {string} pretrained_model_name_or_path The name or path of the pretrained model. Can be either:
     * - A string, the *model id* of a pretrained tokenizer hosted inside a model repo on huggingface.co.
     *   Valid model ids can be located at the root-level, like `bert-base-uncased`, or namespaced under a
     *   user or organization name, like `dbmdz/bert-base-german-cased`.
     * - A path to a *directory* containing tokenizer files, e.g., `./my_model_directory/`.
     * @param {PretrainedTokenizerOptions} options Additional options for loading the tokenizer.
     *
     * @returns {Promise<PreTrainedTokenizer>} A new instance of the PreTrainedTokenizer class.
     */
    static async from_pretrained(
        pretrained_model_name_or_path: string,
        {
            progress_callback = null,
            config = null,
            cache_dir = null,
            local_files_only = false,
            revision = 'main',
            legacy = undefined,
        }: {
            progress_callback?: null | ProgressCallback;
            config?: null | PretrainedConfig;
            cache_dir?: null | string;
            local_files_only?: boolean;
            revision?: string;
            legacy?: boolean;
        } = {},
    ) {
        var [tokenizerJSON, tokenizerConfig] = await loadTokenizer(pretrained_model_name_or_path, {
            progress_callback,
            config,
            cache_dir,
            local_files_only,
            revision,
            legacy,
        });

        // Some tokenizers are saved with the "Fast" suffix, so we remove that if present.
        var tokenizerName = tokenizerConfig.tokenizer_class?.replace(/Fast$/, '') ?? 'PreTrainedTokenizer';

        let cls = this.TOKENIZER_CLASS_MAPPING[tokenizerName as keyof typeof this.TOKENIZER_CLASS_MAPPING];
        if (!cls) {
            console.warn(`Unknown tokenizer class "${tokenizerName}", attempting to construct from base class.`);
            cls = PreTrainedTokenizer;
        }
        return new cls(tokenizerJSON, tokenizerConfig);
    }
}
