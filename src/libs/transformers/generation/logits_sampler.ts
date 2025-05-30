/**
 * @module generation/logits_sampler
 */

import { Callable } from '../utils/generic';
import { Tensor, topk } from '../utils/tensor';

import { max, softmax } from '../utils/maths';
import { GenerationConfig } from './configuration_utils.js';

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * Sampler is a base class for all sampling methods used for text generation.
 */
export class LogitsSampler extends Callable {
  /**
   * Creates a new Sampler object with the specified generation config.
   * @param {GenerationConfig} generation_config The generation config.
   */
  generation_config: GenerationConfig;
  constructor(generation_config: GenerationConfig) {
    super();
    this.generation_config = generation_config;
  }

  /**
   * Executes the sampler, using the specified logits.
   * @param {Tensor} logits
   * @returns {Promise<[bigint, number][]>}
   */
  async _call(logits: Tensor) {
    // Sample from logits, of dims [batch, sequence_length, vocab_size].
    // If index is specified, sample from [batch, index, vocab_size].
    return this.sample(logits);
  }

  /**
   * Abstract method for sampling the logits.
   * @param {Tensor} logits
   * @throws {Error} If not implemented in subclass.
   * @returns {Promise<[bigint, number][]>}
   */
  async sample(logits: Tensor): Promise<[bigint, number][]> {
    throw Error('sample should be implemented in subclasses.');
  }

  /**
   * Returns the specified logits as an array, with temperature applied.
   * @param {Tensor} logits
   * @param {number} index
   * @returns {Float32Array}
   */
  getLogits(logits: Tensor, index: number) {
    var vocabSize = logits.dims.at(-1);

    var logs = /** @type {Float32Array} */ logits.data;

    if (index === -1) {
      logs = logs.slice(-vocabSize);
    } else {
      var startIndex = index * vocabSize;
      logs = logs.slice(startIndex, startIndex + vocabSize);
    }
    return logs;
  }

  /**
   * Selects an item randomly based on the specified probabilities.
   * @param {import("../transformers.js").DataArray} probabilities An array of probabilities to use for selection.
   * @returns {number} The index of the selected item.
   */
  randomSelect(probabilities: Float32Array) {
    // Return index of chosen item
    var sumProbabilities = 0;
    for (var i = 0; i < probabilities.length; ++i) {
      sumProbabilities += probabilities[i];
    }

    var r = Math.random() * sumProbabilities;
    for (var i = 0; i < probabilities.length; ++i) {
      r -= probabilities[i];
      if (r <= 0) {
        return i;
      }
    }
    return 0; // return first (most probable) as a fallback
  }

  /**
   * Returns a Sampler object based on the specified options.
   * @param {GenerationConfig} generation_config An object containing options for the sampler.
   * @returns {LogitsSampler} A Sampler object.
   */
  static getSampler(generation_config: GenerationConfig) {
    // - *greedy decoding*: `num_beams=1` and `do_sample=False`
    // - *contrastive search*: `penalty_alpha>0` and `top_k>1`
    // - *multinomial sampling*: `num_beams=1` and `do_sample=True`
    // - *beam-search decoding*: `num_beams>1` and `do_sample=False`
    // - *beam-search multinomial sampling*: `num_beams>1` and `do_sample=True`
    // - *diverse beam-search decoding*: `num_beams>1` and `num_beam_groups>1`
    // - *constrained beam-search decoding*: `constraints!=None` or `force_words_ids!=None`

    // NOTE: beam search is implemented directly into the generation function
    if (generation_config.do_sample) {
      return new MultinomialSampler(generation_config);
    } else if (generation_config.num_beams > 1) {
      return new BeamSearchSampler(generation_config);
    } else {
      if (generation_config.num_return_sequences > 1) {
        throw Error(
          `num_return_sequences has to be 1 when doing greedy search, but is ${generation_config.num_return_sequences}.`,
        );
      }
      return new GreedySampler(generation_config);
    }
  }
}

/**
 * Class representing a Greedy Sampler.
 */
class GreedySampler extends LogitsSampler {
  /**
   * Sample the maximum probability of a given logits tensor.
   * @param {Tensor} logits
   * @returns {Promise<[bigint, number][]>} An array with a single tuple, containing the index of the maximum value and a meaningless score (since this is a greedy search).
   */
  async sample(logits: Tensor): Promise<[bigint, number][]> {
    // NOTE: no need to do log_softmax here since we only take the maximum
    const argmax = max(logits.data as TypedArray)[1];

    // Note: score is meaningless in this context, since we are performing
    // greedy search (p = 1 => log(p) = 0)
    return [[BigInt(argmax), 0]];
  }
}

/**
 * Class representing a MultinomialSampler.
 */
class MultinomialSampler extends LogitsSampler {
  /**
   * Sample from the logits.
   * @param {Tensor} logits
   * @returns {Promise<[bigint, number][]>}
   */
  async sample(logits: Tensor): Promise<[bigint, number][]> {
    var k = logits.dims.at(-1); // defaults to vocab size
    if (this.generation_config.top_k > 0) {
      k = Math.min(this.generation_config.top_k, k);
    }

    // Get top k tokens
    const [v, i] = await topk(logits, k);

    // Compute softmax over logits
    const probabilities = softmax(/** @type {Float32Array} */ v.data);

    return Array.from({ length: this.generation_config.num_beams }, () => {
      const sampledIndex = this.randomSelect(probabilities as Float32Array);
      return [
        i.data[sampledIndex], // token id
        Math.log(probabilities[sampledIndex]), // score
      ];
    });
  }
}

/**
 * Class representing a BeamSearchSampler.
 */
class BeamSearchSampler extends LogitsSampler {
  /**
   * Sample from the logits.
   * @param {Tensor} logits
   * @returns {Promise<[bigint, number][]>}
   */
  async sample(logits: Tensor): Promise<[bigint, number][]> {
    var k = logits.dims.at(-1); // defaults to vocab size
    if (this.generation_config.top_k > 0) {
      k = Math.min(this.generation_config.top_k, k);
    }

    // Get top k tokens
    const [v, i] = await topk(logits, k);

    // Compute softmax over logits
    const probabilities = softmax(/** @type {Float32Array} */ v.data);

    return Array.from({ length: this.generation_config.num_beams }, (_, x) => {
      return [
        i.data[x], // token id
        Math.log(probabilities[x]), // score
      ];
    });
  }
}
