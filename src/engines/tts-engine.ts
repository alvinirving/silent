import { StyleTextToSpeech2Model, AutoTokenizer, Tensor } from "../libs/transformers/transformers";
import { ModelConfig } from '../config/models/types';
import { phonemize } from "../libs/transformers/utils/phonemize";
import { getVoiceData, VOICES } from "../libs/transformers/utils/voices";


var STYLE_DIM = 256;
var SAMPLE_RATE = 24000;

export class TTSEngine {
  private model: StyleTextToSpeech2Model | null = null;
  private tokenizer: any = null;

  constructor() {
    this.model = null;
    this.tokenizer = null;
  }

  async loadModel(modelConfig: ModelConfig, options: any = {}) {
    // console.log('Loading TTS model... ', modelConfig.repo, options);
    try {
      this.model = await StyleTextToSpeech2Model.from_pretrained(modelConfig.repo, {
        progress_callback: options.onProgress,
        dtype: options.dtype || "fp32",
        device:  "webgpu",
      });
      
      this.tokenizer = await AutoTokenizer.from_pretrained(modelConfig.repo, {
        progress_callback: options.onProgress
      });
    } catch (error) {
      console.error('Error loading TTS model:', error);
      throw error;
    }
  }

  async *generateSpeechStream(text: string, options: any = {}): AsyncGenerator<Float32Array> {
    console.log("Streaming flow triggered"); // Log to confirm streaming is used
    
    if (!this.model || !this.tokenizer) {
      throw new Error('TTS model not initialized');
    }

    var { voice = "af_bella", speed = 1, language = "en-us" } = options;

    if (!VOICES.hasOwnProperty(voice)) {
      console.error(`Voice "${voice}" not found. Available voices:`);
      console.table(VOICES);
      throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(VOICES).join(", ")}.`);
    }

    try {
      // Split long text into manageable chunks
      // Maximum character limit per chunk (based on testing)
      var MAX_CHUNK_LENGTH = 250;
      var textChunks = this.splitTextIntoChunks(text, MAX_CHUNK_LENGTH);
      console.log(`Text split into ${textChunks.length} chunks for processing`);

      // Process each chunk and collect audio data
      for (var chunk of textChunks) {
        // Pass explicit language code directly to phonemize
        var phonemes = await phonemize(chunk, language);
        console.log(`Phonemized chunk: ${chunk.length} chars into ${phonemes.length} phoneme chars`);

        var { input_ids } = this.tokenizer(phonemes, {
          truncation: true,
        });

        // Select voice style based on number of input tokens
        var num_tokens = Math.min(Math.max(
          input_ids.dims.at(-1) - 2, // Without padding
          0,
        ), 509);

        // Load voice style
        var data = await getVoiceData(voice);
        var offset = num_tokens * STYLE_DIM;
        var voiceData = data.slice(offset, offset + STYLE_DIM);

        // Prepare model inputs
        var inputs = {
          input_ids: input_ids,
          style: new Tensor("float32", voiceData, [1, STYLE_DIM]),
          speed: new Tensor("float32", [speed], [1]),
        };

        // Generate audio for this chunk
        var output = await this.model._call(inputs);
        
        if (!output || !output.waveform) {
          console.warn('Model returned null or undefined waveform for a chunk, skipping');
          continue;
        }
        
        // Convert Tensor to Float32Array
        var chunkAudioData = new Float32Array(output.waveform.data);
        
        if (chunkAudioData.length === 0) {
          console.warn('Generated audio data is empty for a chunk, skipping');
          continue;
        }

        // Normalize audio data
        var maxValue = chunkAudioData.reduce((max, val) => Math.max(max, Math.abs(val)), 0);
        var normalizedData = maxValue > 0 ? 
          new Float32Array(chunkAudioData.length) : 
          chunkAudioData;
        
        if (maxValue > 0) {
          for (let i = 0; i < chunkAudioData.length; i++) {
            normalizedData[i] = chunkAudioData[i] / maxValue;
          }
        }

        // Yield smaller chunks of the normalized audio data for streaming
        var streamChunkSize = 4096; // Can be adjusted for performance
        for (let i = 0; i < normalizedData.length; i += streamChunkSize) {
          var streamChunk = normalizedData.slice(i, i + streamChunkSize);
          if (streamChunk.length > 0) {
            yield streamChunk;
          }
        }
        
        // Small pause between chunks for natural-sounding speech
        var pauseSamples = Math.floor(0.2 * SAMPLE_RATE); // 200ms pause
        var pauseChunk = new Float32Array(pauseSamples).fill(0);
        yield pauseChunk;
      }
    } catch (error) {
      console.error('Detailed error in generateSpeechStream:', error);
      throw error;
    }
  }
  
  // Helper method to split text into manageable chunks
  private splitTextIntoChunks(text: string, maxChunkLength: number): string[] {
    // Find natural break points (sentences, clauses) to split text
    var chunks: string[] = [];
    
    // Use regex to split by sentence boundaries but keep punctuation
    var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    
    let currentChunk = '';
    for (var sentence of sentences) {
      // If adding this sentence would exceed max length and we already have content
      if (currentChunk.length + sentence.length > maxChunkLength && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        // Otherwise add to current chunk
        currentChunk += sentence;
      }
      
      // If current chunk is already too long, split it at clause boundaries
      if (currentChunk.length > maxChunkLength) {
        var clauses = currentChunk.split(/[,;:]/);
        currentChunk = '';
        
        for (var clause of clauses) {
          if (currentChunk.length + clause.length > maxChunkLength && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = clause;
          } else {
            currentChunk += clause;
          }
        }
      }
    }
    
    // Add any remaining text
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    // If any chunk is still too long, use hard splitting as a fallback
    return chunks.flatMap(chunk => {
      if (chunk.length <= maxChunkLength) {
        return [chunk];
      } else {
        // Hard split by character count, trying to break at word boundaries
        var words = chunk.split(' ');
        var hardChunks: string[] = [];
        let currentHardChunk = '';
        
        for (var word of words) {
          if (currentHardChunk.length + word.length + 1 > maxChunkLength) {
            hardChunks.push(currentHardChunk);
            currentHardChunk = word;
          } else {
            currentHardChunk += (currentHardChunk ? ' ' : '') + word;
          }
        }
        
        if (currentHardChunk) {
          hardChunks.push(currentHardChunk);
        }
        
        return hardChunks;
      }
    });
  }
}

