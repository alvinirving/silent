/**
 * @file Helper module for mathematical processing.
 *
 * These functions and classes are only used internally,
 * meaning an end-user shouldn't need to access anything here.
 *
 * @module utils/maths
 */

/**
 * @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array} TypedArray
 * @typedef {BigInt64Array | BigUint64Array} BigTypedArray
 * @typedef {TypedArray | BigTypedArray} AnyTypedArray
 */

/**
 * @param {TypedArray} input
 */

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
type BigTypedArray = BigInt64Array | BigUint64Array;
type AnyTypedArray = TypedArray | BigTypedArray;

export function interpolate_data(
  input: TypedArray,
  [in_channels, in_height, in_width]: [number, number, number],
  [out_height, out_width]: [number, number],
  mode = 'bilinear',
  align_corners = false,
) {
  // TODO use mode and align_corners

  // Output image dimensions
  var x_scale = out_width / in_width;
  var y_scale = out_height / in_height;

  // Output image
  // @ts-ignore
  var out_img = new input.constructor(out_height * out_width * in_channels);

  // Pre-calculate strides
  var inStride = in_height * in_width;
  var outStride = out_height * out_width;

  for (let i = 0; i < out_height; ++i) {
    for (let j = 0; j < out_width; ++j) {
      // Calculate output offset
      var outOffset = i * out_width + j;

      // Calculate input pixel coordinates
      var x = (j + 0.5) / x_scale - 0.5;
      var y = (i + 0.5) / y_scale - 0.5;

      // Calculate the four nearest input pixels
      // We also check if the input pixel coordinates are within the image bounds
      let x1 = Math.floor(x);
      let y1 = Math.floor(y);
      var x2 = Math.min(x1 + 1, in_width - 1);
      var y2 = Math.min(y1 + 1, in_height - 1);

      x1 = Math.max(x1, 0);
      y1 = Math.max(y1, 0);

      // Calculate the fractional distances between the input pixel and the four nearest pixels
      var s = x - x1;
      var t = y - y1;

      // Perform bilinear interpolation
      var w1 = (1 - s) * (1 - t);
      var w2 = s * (1 - t);
      var w3 = (1 - s) * t;
      var w4 = s * t;

      // Calculate the four nearest input pixel indices
      var yStride = y1 * in_width;
      var xStride = y2 * in_width;
      var idx1 = yStride + x1;
      var idx2 = yStride + x2;
      var idx3 = xStride + x1;
      var idx4 = xStride + x2;

      for (let k = 0; k < in_channels; ++k) {
        // Calculate channel offset
        var cOffset = k * inStride;

        out_img[k * outStride + outOffset] =
          w1 * input[cOffset + idx1] +
          w2 * input[cOffset + idx2] +
          w3 * input[cOffset + idx3] +
          w4 * input[cOffset + idx4];
      }
    }
  }

  return out_img;
}

/**
 * Helper method to permute a `AnyTypedArray` directly
 * @template {AnyTypedArray} T
 * @param {T} array
 * @param {number[]} dims
 * @param {number[]} axes
 * @returns {[T, number[]]} The permuted array and the new shape.
 */
export function permute_data(array: TypedArray, dims: number[], axes: number[]) {
  // Calculate the new shape of the permuted array
  // and the stride of the original array
  var shape = new Array(axes.length);
  var stride = new Array(axes.length);

  for (let i = axes.length - 1, s = 1; i >= 0; --i) {
    stride[i] = s;
    shape[i] = dims[axes[i]];
    s *= shape[i];
  }

  // Precompute inverse mapping of stride
  var invStride = axes.map((_, i) => stride[axes.indexOf(i)]);

  // Create the permuted array with the new shape
  // @ts-ignore
  var permutedData = new array.constructor(array.length);

  // Permute the original array to the new array
  for (let i = 0; i < array.length; ++i) {
    let newIndex = 0;
    for (let j = dims.length - 1, k = i; j >= 0; --j) {
      newIndex += (k % dims[j]) * invStride[j];
      k = Math.floor(k / dims[j]);
    }
    permutedData[newIndex] = array[i];
  }

  return [permutedData, shape];
}

/**
 * Compute the softmax of an array of numbers.
 * @template {TypedArray|number[]} T
 * @param {T} arr The array of numbers to compute the softmax of.
 * @returns {T} The softmax array.
 */
export function softmax(arr: TypedArray | number[]) {
  // Compute the maximum value in the array
  var maxVal = max(arr)[0];

  // Compute the exponentials of the array values
  var exps = arr.map((x) => {
    if (typeof maxVal === 'bigint') {
      // Convert to Number only if within safe integer range
      if (maxVal <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Math.exp(Number(x) - Number(maxVal));
      }
      throw new Error('BigInt value exceeds safe number range for exponential calculation');
    }
    return Math.exp(Number(x) - maxVal);
  });

  // Compute the sum of the exponentials
  // @ts-ignore
  var sumExps = exps.reduce((acc, val) => acc + val, 0);

  // Compute the softmax values
  var softmaxArr = exps.map((x) => x / sumExps);

  return /** @type {T} */ softmaxArr;
}

/**
 * Calculates the logarithm of the softmax function for the input array.
 * @template {TypedArray|number[]} T
 * @param {T} arr The input array to calculate the log_softmax function for.
 * @returns {T} The resulting log_softmax array.
 */
export function log_softmax(arr: TypedArray | number[]) {
  // Compute the maximum value in the array
  var maxVal = max(arr)[0];

  // Compute the sum of the exponentials
  let sumExps = 0;
  for (let i = 0; i < arr.length; ++i) {
    if (typeof maxVal === 'bigint') {
      if (maxVal <= BigInt(Number.MAX_SAFE_INTEGER)) {
        sumExps += Math.exp(Number(arr[i]) - Number(maxVal));
      }
      throw new Error('BigInt value exceeds safe number range for exponential calculation');
    }
    sumExps += Math.exp(Number(arr[i]) - maxVal);
  }

  // Compute the log of the sum
  var logSum = Math.log(sumExps);

  // Compute the softmax values
  var logSoftmaxArr = arr.map((x) => {
    if (typeof maxVal === 'bigint') {
      return Number(x) - Number(maxVal) - logSum;
    }
    return Number(x) - maxVal - logSum;
  });

  return /** @type {T} */ logSoftmaxArr;
}

/**
 * Calculates the dot product of two arrays.
 * @param {number[]} arr1 The first array.
 * @param {number[]} arr2 The second array.
 * @returns {number} The dot product of arr1 and arr2.
 */
export function dot(arr1: number[], arr2: number[]) {
  let result = 0;
  for (let i = 0; i < arr1.length; ++i) {
    result += arr1[i] * arr2[i];
  }
  return result;
}

/**
 * Computes the cosine similarity between two arrays.
 *
 * @param {number[]} arr1 The first array.
 * @param {number[]} arr2 The second array.
 * @returns {number} The cosine similarity between the two arrays.
 */
export function cos_sim(arr1: number[], arr2: number[]) {
  // Calculate dot product of the two arrays
  var dotProduct = dot(arr1, arr2);

  // Calculate the magnitude of the first array
  var magnitudeA = magnitude(arr1);

  // Calculate the magnitude of the second array
  var magnitudeB = magnitude(arr2);

  // Calculate the cosine similarity
  var cosineSimilarity = dotProduct / (magnitudeA * magnitudeB);

  return cosineSimilarity;
}

/**
 * Calculates the magnitude of a given array.
 * @param {number[]} arr The array to calculate the magnitude of.
 * @returns {number} The magnitude of the array.
 */
export function magnitude(arr: number[]) {
  return Math.sqrt(arr.reduce((acc, val) => acc + val * val, 0));
}

/**
 * Returns the value and index of the minimum element in an array.
 * @template {number[]|bigint[]|AnyTypedArray} T
 * @param {T} arr array of numbers.
 * @returns {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} the value and index of the minimum element, of the form: [valueOfMin, indexOfMin]
 * @throws {Error} If array is empty.
 */
export function min(arr: number[] | bigint[] | TypedArray) {
  if (arr.length === 0) throw Error('Array must not be empty');
  let min = arr[0];
  let indexOfMin = 0;
  for (let i = 1; i < arr.length; ++i) {
    if (arr[i] < min) {
      min = arr[i];
      indexOfMin = i;
    }
  }
  return /** @type {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} */ [min, indexOfMin];
}

/**
 * Returns the value and index of the maximum element in an array.
 * @template {number[]|bigint[]|AnyTypedArray} T
 * @param {T} arr array of numbers.
 * @returns {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} the value and index of the maximum element, of the form: [valueOfMax, indexOfMax]
 * @throws {Error} If array is empty.
 */
export function max(arr: number[] | bigint[] | TypedArray) {
  if (arr.length === 0) throw Error('Array must not be empty');
  let max = arr[0];
  let indexOfMax = 0;
  for (let i = 1; i < arr.length; ++i) {
    if (arr[i] > max) {
      max = arr[i];
      indexOfMax = i;
    }
  }
  return /** @type {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} */ [max, indexOfMax];
}

function isPowerOfTwo(number: number) {
  // Check if the number is greater than 0 and has only one bit set to 1
  return number > 0 && (number & (number - 1)) === 0;
}

/**
 * Implementation of Radix-4 FFT.
 *
 * P2FFT class provides functionality for performing Fast Fourier Transform on arrays
 * which are a power of two in length.
 * Code adapted from https://www.npmjs.com/package/fft.js
 */
class P2FFT {
  /**
   * @param {number} size The size of the input array. Must be a power of two larger than 1.
   * @throws {Error} FFT size must be a power of two larger than 1.
   */
  private size: number;
  private _csize: number;
  private _width: number;
  private _bitrev: Int32Array;
  private table: Float64Array;

  constructor(size: number) {
    this.size = size | 0; // convert to a 32-bit signed integer
    if (this.size <= 1 || !isPowerOfTwo(this.size)) throw new Error('FFT size must be a power of two larger than 1');

    this._csize = size << 1;

    this.table = new Float64Array(this.size * 2);
    for (let i = 0; i < this.table.length; i += 2) {
      var angle = (Math.PI * i) / this.size;
      this.table[i] = Math.cos(angle);
      this.table[i + 1] = -Math.sin(angle);
    }

    // Find size's power of two
    let power = 0;
    for (let t = 1; this.size > t; t <<= 1) ++power;

    // Calculate initial step's width:
    //   * If we are full radix-4, it is 2x smaller to give inital len=8
    //   * Otherwise it is the same as `power` to give len=4
    this._width = power % 2 === 0 ? power - 1 : power;

    // Pre-compute bit-reversal patterns
    this._bitrev = new Int32Array(1 << this._width);
    for (let j = 0; j < this._bitrev.length; ++j) {
      this._bitrev[j] = 0;
      for (let shift = 0; shift < this._width; shift += 2) {
        var revShift = this._width - shift - 2;
        this._bitrev[j] |= ((j >>> shift) & 3) << revShift;
      }
    }
  }

  /**
   * Create a complex number array with size `2 * size`
   *
   * @returns {Float64Array} A complex number array with size `2 * size`
   */
  createComplexArray() {
    return new Float64Array(this._csize);
  }

  /**
   * Converts a complex number representation stored in a Float64Array to an array of real numbers.
   *
   * @param {Float64Array} complex The complex number representation to be converted.
   * @param {number[]} [storage] An optional array to store the result in.
   * @returns {number[]} An array of real numbers representing the input complex number representation.
   */
  fromComplexArray(complex: Float64Array, storage?: number[]) {
    var res = storage || new Array(complex.length >>> 1);
    for (let i = 0; i < complex.length; i += 2) res[i >>> 1] = complex[i];
    return res;
  }

  /**
   * Convert a real-valued input array to a complex-valued output array.
   * @param {Float64Array} input The real-valued input array.
   * @param {Float64Array} [storage] Optional buffer to store the output array.
   * @returns {Float64Array} The complex-valued output array.
   */
  toComplexArray(input: number[], storage?: Float64Array) {
    var res = storage || this.createComplexArray();
    for (let i = 0; i < res.length; i += 2) {
      res[i] = input[i >>> 1];
      res[i + 1] = 0;
    }
    return res;
  }

  /**
   * Performs a Fast Fourier Transform (FFT) on the given input data and stores the result in the output buffer.
   *
   * @param {Float64Array} out The output buffer to store the result.
   * @param {Float64Array} data The input data to transform.
   *
   * @throws {Error} Input and output buffers must be different.
   *
   * @returns {void}
   */
  transform(out: Float64Array, data: Float64Array) {
    if (out === data) throw new Error('Input and output buffers must be different');

    this._transform4(out, data, 1 /* DONE */);
  }

  /**
   * Performs a real-valued forward FFT on the given input buffer and stores the result in the given output buffer.
   * The input buffer must contain real values only, while the output buffer will contain complex values. The input and
   * output buffers must be different.
   *
   * @param {Float64Array} out The output buffer.
   * @param {Float64Array} data The input buffer containing real values.
   *
   * @throws {Error} If the input and output buffers are the same.
   */
  realTransform(out: Float64Array, data: Float64Array) {
    if (out === data) throw new Error('Input and output buffers must be different');

    this._realTransform4(out, data, 1 /* DONE */);
  }

  /**
   * Performs an inverse FFT transformation on the given `data` array, and stores the result in `out`.
   * The `out` array must be a different buffer than the `data` array. The `out` array will contain the
   * result of the transformation. The `data` array will not be modified.
   *
   * @param {Float64Array} out The output buffer for the transformed data.
   * @param {Float64Array} data The input data to transform.
   * @throws {Error} If `out` and `data` refer to the same buffer.
   * @returns {void}
   */
  inverseTransform(out: Float64Array, data: Float64Array) {
    if (out === data) throw new Error('Input and output buffers must be different');

    this._transform4(out, data, -1 /* DONE */);
    for (let i = 0; i < out.length; ++i) out[i] /= this.size;
  }

  /**
   * Performs a radix-4 implementation of a discrete Fourier transform on a given set of data.
   *
   * @param {Float64Array} out The output buffer for the transformed data.
   * @param {Float64Array} data The input buffer of data to be transformed.
   * @param {number} inv A scaling factor to apply to the transform.
   * @returns {void}
   */
  _transform4(out: Float64Array, data: Float64Array, inv: number) {
    // radix-4 implementation

    var size = this._csize;

    // Initial step (permute and transform)
    var width = this._width;
    let step = 1 << width;
    let len = (size / step) << 1;

    let outOff;
    let t;
    var bitrev = this._bitrev;
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        var off = bitrev[t];
        this._singleTransform2(data, out, outOff, off, step);
      }
    } else {
      // len === 8
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        var off = bitrev[t];
        this._singleTransform4(data, out, outOff, off, step, inv);
      }
    }

    // Loop through steps in decreasing order
    var table = this.table;
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1;
      var quarterLen = len >>> 2;

      // Loop through offsets in the data
      for (outOff = 0; outOff < size; outOff += len) {
        // Full case
        var limit = outOff + quarterLen - 1;
        for (let i = outOff, k = 0; i < limit; i += 2, k += step) {
          var A = i;
          var B = A + quarterLen;
          var C = B + quarterLen;
          var D = C + quarterLen;

          // Original values
          var Ar = out[A];
          var Ai = out[A + 1];
          var Br = out[B];
          var Bi = out[B + 1];
          var Cr = out[C];
          var Ci = out[C + 1];
          var Dr = out[D];
          var Di = out[D + 1];

          var tableBr = table[k];
          var tableBi = inv * table[k + 1];
          var MBr = Br * tableBr - Bi * tableBi;
          var MBi = Br * tableBi + Bi * tableBr;

          var tableCr = table[2 * k];
          var tableCi = inv * table[2 * k + 1];
          var MCr = Cr * tableCr - Ci * tableCi;
          var MCi = Cr * tableCi + Ci * tableCr;

          var tableDr = table[3 * k];
          var tableDi = inv * table[3 * k + 1];
          var MDr = Dr * tableDr - Di * tableDi;
          var MDi = Dr * tableDi + Di * tableDr;

          // Pre-Final values
          var T0r = Ar + MCr;
          var T0i = Ai + MCi;
          var T1r = Ar - MCr;
          var T1i = Ai - MCi;
          var T2r = MBr + MDr;
          var T2i = MBi + MDi;
          var T3r = inv * (MBr - MDr);
          var T3i = inv * (MBi - MDi);

          // Final values
          out[A] = T0r + T2r;
          out[A + 1] = T0i + T2i;
          out[B] = T1r + T3i;
          out[B + 1] = T1i - T3r;
          out[C] = T0r - T2r;
          out[C + 1] = T0i - T2i;
          out[D] = T1r - T3i;
          out[D + 1] = T1i + T3r;
        }
      }
    }
  }

  /**
   * Performs a radix-2 implementation of a discrete Fourier transform on a given set of data.
   *
   * @param {Float64Array} data The input buffer of data to be transformed.
   * @param {Float64Array} out The output buffer for the transformed data.
   * @param {number} outOff The offset at which to write the output data.
   * @param {number} off The offset at which to begin reading the input data.
   * @param {number} step The step size for indexing the input data.
   * @returns {void}
   */
  _singleTransform2(data: Float64Array, out: Float64Array, outOff: number, off: number, step: number) {
    // radix-2 implementation
    // NOTE: Only called for len=4

    var evenR = data[off];
    var evenI = data[off + 1];
    var oddR = data[off + step];
    var oddI = data[off + step + 1];

    out[outOff] = evenR + oddR;
    out[outOff + 1] = evenI + oddI;
    out[outOff + 2] = evenR - oddR;
    out[outOff + 3] = evenI - oddI;
  }

  /**
   * Performs radix-4 transformation on input data of length 8
   *
   * @param {Float64Array} data Input data array of length 8
   * @param {Float64Array} out Output data array of length 8
   * @param {number} outOff Index of output array to start writing from
   * @param {number} off Index of input array to start reading from
   * @param {number} step Step size between elements in input array
   * @param {number} inv Scaling factor for inverse transform
   *
   * @returns {void}
   */
  _singleTransform4(data: Float64Array, out: Float64Array, outOff: number, off: number, step: number, inv: number) {
    // radix-4
    // NOTE: Only called for len=8
    var step2 = step * 2;
    var step3 = step * 3;

    // Original values
    var Ar = data[off];
    var Ai = data[off + 1];
    var Br = data[off + step];
    var Bi = data[off + step + 1];
    var Cr = data[off + step2];
    var Ci = data[off + step2 + 1];
    var Dr = data[off + step3];
    var Di = data[off + step3 + 1];

    // Pre-Final values
    var T0r = Ar + Cr;
    var T0i = Ai + Ci;
    var T1r = Ar - Cr;
    var T1i = Ai - Ci;
    var T2r = Br + Dr;
    var T2i = Bi + Di;
    var T3r = inv * (Br - Dr);
    var T3i = inv * (Bi - Di);

    // Final values
    out[outOff] = T0r + T2r;
    out[outOff + 1] = T0i + T2i;
    out[outOff + 2] = T1r + T3i;
    out[outOff + 3] = T1i - T3r;
    out[outOff + 4] = T0r - T2r;
    out[outOff + 5] = T0i - T2i;
    out[outOff + 6] = T1r - T3i;
    out[outOff + 7] = T1i + T3r;
  }

  /**
   * Real input radix-4 implementation
   * @param {Float64Array} out Output array for the transformed data
   * @param {Float64Array} data Input array of real data to be transformed
   * @param {number} inv The scale factor used to normalize the inverse transform
   */
  _realTransform4(out: Float64Array, data: Float64Array, inv: number) {
    // Real input radix-4 implementation
    var size = this._csize;

    // Initial step (permute and transform)
    var width = this._width;
    let step = 1 << width;
    let len = (size / step) << 1;

    let outOff;
    let t;
    var bitrev = this._bitrev;
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        var off = bitrev[t];
        this._singleRealTransform2(data, out, outOff, off >>> 1, step >>> 1);
      }
    } else {
      // len === 8
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        var off = bitrev[t];
        this._singleRealTransform4(data, out, outOff, off >>> 1, step >>> 1, inv);
      }
    }

    // Loop through steps in decreasing order
    var table = this.table;
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1;
      var halfLen = len >>> 1;
      var quarterLen = halfLen >>> 1;
      var hquarterLen = quarterLen >>> 1;

      // Loop through offsets in the data
      for (outOff = 0; outOff < size; outOff += len) {
        for (let i = 0, k = 0; i <= hquarterLen; i += 2, k += step) {
          var A = outOff + i;
          var B = A + quarterLen;
          var C = B + quarterLen;
          var D = C + quarterLen;

          // Original values
          var Ar = out[A];
          var Ai = out[A + 1];
          var Br = out[B];
          var Bi = out[B + 1];
          var Cr = out[C];
          var Ci = out[C + 1];
          var Dr = out[D];
          var Di = out[D + 1];

          // Middle values
          var MAr = Ar;
          var MAi = Ai;

          var tableBr = table[k];
          var tableBi = inv * table[k + 1];
          var MBr = Br * tableBr - Bi * tableBi;
          var MBi = Br * tableBi + Bi * tableBr;

          var tableCr = table[2 * k];
          var tableCi = inv * table[2 * k + 1];
          var MCr = Cr * tableCr - Ci * tableCi;
          var MCi = Cr * tableCi + Ci * tableCr;

          var tableDr = table[3 * k];
          var tableDi = inv * table[3 * k + 1];
          var MDr = Dr * tableDr - Di * tableDi;
          var MDi = Dr * tableDi + Di * tableDr;

          // Pre-Final values
          var T0r = MAr + MCr;
          var T0i = MAi + MCi;
          var T1r = MAr - MCr;
          var T1i = MAi - MCi;
          var T2r = MBr + MDr;
          var T2i = MBi + MDi;
          var T3r = inv * (MBr - MDr);
          var T3i = inv * (MBi - MDi);

          // Final values
          out[A] = T0r + T2r;
          out[A + 1] = T0i + T2i;
          out[B] = T1r + T3i;
          out[B + 1] = T1i - T3r;

          // Output final middle point
          if (i === 0) {
            out[C] = T0r - T2r;
            out[C + 1] = T0i - T2i;
            continue;
          }

          // Do not overwrite ourselves
          if (i === hquarterLen) continue;

          var SA = outOff + quarterLen - i;
          var SB = outOff + halfLen - i;

          out[SA] = T1r - inv * T3i;
          out[SA + 1] = -T1i - inv * T3r;
          out[SB] = T0r - inv * T2r;
          out[SB + 1] = -T0i + inv * T2i;
        }
      }
    }

    // Complete the spectrum by adding its mirrored negative frequency components.
    var half = size >>> 1;
    for (let i = 2; i < half; i += 2) {
      out[size - i] = out[i];
      out[size - i + 1] = -out[i + 1];
    }
  }

  /**
   * Performs a single real input radix-2 transformation on the provided data
   *
   * @param {Float64Array} data The input data array
   * @param {Float64Array} out The output data array
   * @param {number} outOff The output offset
   * @param {number} off The input offset
   * @param {number} step The step
   *
   * @returns {void}
   */
  _singleRealTransform2(data: Float64Array, out: Float64Array, outOff: number, off: number, step: number) {
    // radix-2 implementation
    // NOTE: Only called for len=4

    var evenR = data[off];
    var oddR = data[off + step];

    out[outOff] = evenR + oddR;
    out[outOff + 1] = 0;
    out[outOff + 2] = evenR - oddR;
    out[outOff + 3] = 0;
  }

  /**
   * Computes a single real-valued transform using radix-4 algorithm.
   * This method is only called for len=8.
   *
   * @param {Float64Array} data The input data array.
   * @param {Float64Array} out The output data array.
   * @param {number} outOff The offset into the output array.
   * @param {number} off The offset into the input array.
   * @param {number} step The step size for the input array.
   * @param {number} inv The value of inverse.
   */
  _singleRealTransform4(data: Float64Array, out: Float64Array, outOff: number, off: number, step: number, inv: number) {
    // radix-4
    // NOTE: Only called for len=8
    var step2 = step * 2;
    var step3 = step * 3;

    // Original values
    var Ar = data[off];
    var Br = data[off + step];
    var Cr = data[off + step2];
    var Dr = data[off + step3];

    // Pre-Final values
    var T0r = Ar + Cr;
    var T1r = Ar - Cr;
    var T2r = Br + Dr;
    var T3r = inv * (Br - Dr);

    // Final values
    out[outOff] = T0r + T2r;
    out[outOff + 1] = 0;
    out[outOff + 2] = T1r;
    out[outOff + 3] = -T3r;
    out[outOff + 4] = T0r - T2r;
    out[outOff + 5] = 0;
    out[outOff + 6] = T1r;
    out[outOff + 7] = T3r;
  }
}

/**
 * NP2FFT class provides functionality for performing Fast Fourier Transform on arrays
 * which are not a power of two in length. In such cases, the chirp-z transform is used.
 *
 * For more information, see: https://math.stackexchange.com/questions/77118/non-power-of-2-ffts/77156#77156
 */
class NP2FFT {
  private _f: P2FFT;
  private bufferSize: number;
  private _a: number;
  private _chirpBuffer: Float64Array;
  private _buffer1: Float64Array;
  private _buffer2: Float64Array;
  private _outBuffer1: Float64Array;
  private _outBuffer2: Float64Array;
  private _slicedChirpBuffer: Float64Array;

  constructor(fft_length: number) {
    // Helper variables
    var a = 2 * (fft_length - 1);
    var b = 2 * (2 * fft_length - 1);
    var nextP2 = 2 ** Math.ceil(Math.log2(b));
    this.bufferSize = nextP2;
    this._a = a;

    // Define buffers
    // Compute chirp for transform
    var chirp = new Float64Array(b);
    var ichirp = new Float64Array(nextP2);
    this._chirpBuffer = new Float64Array(nextP2);
    this._buffer1 = new Float64Array(nextP2);
    this._buffer2 = new Float64Array(nextP2);
    this._outBuffer1 = new Float64Array(nextP2);
    this._outBuffer2 = new Float64Array(nextP2);

    // Compute complex exponentiation
    var theta = (-2 * Math.PI) / fft_length;
    var baseR = Math.cos(theta);
    var baseI = Math.sin(theta);

    // Precompute helper for chirp-z transform
    for (let i = 0; i < b >> 1; ++i) {
      // Compute complex power:
      var e = (i + 1 - fft_length) ** 2 / 2.0;

      // Compute the modulus and argument of the result
      var result_mod = Math.sqrt(baseR ** 2 + baseI ** 2) ** e;
      var result_arg = e * Math.atan2(baseI, baseR);

      // Convert the result back to rectangular form
      // and assign to chirp and ichirp
      var i2 = 2 * i;
      chirp[i2] = result_mod * Math.cos(result_arg);
      chirp[i2 + 1] = result_mod * Math.sin(result_arg);

      // conjugate
      ichirp[i2] = chirp[i2];
      ichirp[i2 + 1] = -chirp[i2 + 1];
    }
    this._slicedChirpBuffer = chirp.subarray(a, b);

    // create object to perform Fast Fourier Transforms
    // with `nextP2` complex numbers
    this._f = new P2FFT(nextP2 >> 1);
    this._f.transform(this._chirpBuffer, ichirp);
  }

  _transform(output: Float64Array, input: Float64Array, real: boolean) {
    var ib1 = this._buffer1;
    var ib2 = this._buffer2;
    var ob2 = this._outBuffer1;
    var ob3 = this._outBuffer2;
    var cb = this._chirpBuffer;
    var sb = this._slicedChirpBuffer;
    var a = this._a;

    if (real) {
      // Real multiplication
      for (let j = 0; j < sb.length; j += 2) {
        var j2 = j + 1;
        var j3 = j >> 1;

        var a_real = input[j3];
        ib1[j] = a_real * sb[j];
        ib1[j2] = a_real * sb[j2];
      }
    } else {
      // Complex multiplication
      for (let j = 0; j < sb.length; j += 2) {
        var j2 = j + 1;
        ib1[j] = input[j] * sb[j] - input[j2] * sb[j2];
        ib1[j2] = input[j] * sb[j2] + input[j2] * sb[j];
      }
    }
    this._f.transform(ob2, ib1);

    for (let j = 0; j < cb.length; j += 2) {
      var j2 = j + 1;

      ib2[j] = ob2[j] * cb[j] - ob2[j2] * cb[j2];
      ib2[j2] = ob2[j] * cb[j2] + ob2[j2] * cb[j];
    }
    this._f.inverseTransform(ob3, ib2);

    for (let j = 0; j < ob3.length; j += 2) {
      var a_real = ob3[j + a];
      var a_imag = ob3[j + a + 1];
      var b_real = sb[j];
      var b_imag = sb[j + 1];

      output[j] = a_real * b_real - a_imag * b_imag;
      output[j + 1] = a_real * b_imag + a_imag * b_real;
    }
  }

  transform(output: Float64Array, input: Float64Array) {
    this._transform(output, input, false);
  }

  realTransform(output: Float64Array, input: Float64Array) {
    this._transform(output, input, true);
  }

  get size(): number {
    return this.bufferSize;
  }
}

export class FFT {
  fft_length: number;
  isPowerOfTwo: boolean;
  fft: P2FFT | NP2FFT;
  outputBufferSize: number;

  constructor(fft_length: number) {
    this.fft_length = fft_length;
    this.isPowerOfTwo = isPowerOfTwo(fft_length);
    if (this.isPowerOfTwo) {
      this.fft = new P2FFT(fft_length);
      this.outputBufferSize = 2 * fft_length;
    } else {
      this.fft = new NP2FFT(fft_length);
      this.outputBufferSize = this.fft.size;
    }
  }

  realTransform(out: Float64Array, input: Float64Array) {
    this.fft.realTransform(out, input);
  }

  transform(out: Float64Array, input: Float64Array) {
    this.fft.transform(out, input);
  }
}

/**
 * Performs median filter on the provided data. Padding is done by mirroring the data.
 * @param {AnyTypedArray} data The input array
 * @param {number} windowSize The window size
 */
export function medianFilter(data: AnyTypedArray, windowSize: number) {
  if (windowSize % 2 === 0 || windowSize <= 0) {
    throw new Error('Window size must be a positive odd number');
  }

  // @ts-ignore
  var outputArray = new data.constructor(data.length);

  // @ts-ignore
  var buffer = new data.constructor(windowSize); // Reusable array for storing values

  var halfWindowSize = Math.floor(windowSize / 2);

  for (let i = 0; i < data.length; ++i) {
    let valuesIndex = 0;

    for (let j = -halfWindowSize; j <= halfWindowSize; ++j) {
      let index = i + j;
      if (index < 0) {
        index = Math.abs(index);
      } else if (index >= data.length) {
        index = 2 * (data.length - 1) - index;
      }

      buffer[valuesIndex++] = data[index];
    }

    buffer.sort();
    outputArray[i] = buffer[halfWindowSize];
  }

  return outputArray;
}

/**
 * Helper function to round a number to a given number of decimals
 * @param {number} num The number to round
 * @param {number} decimals The number of decimals
 * @returns {number} The rounded number
 */
export function round(num: number, decimals: number) {
  var pow = Math.pow(10, decimals);
  return Math.round(num * pow) / pow;
}

/**
 * Helper function to round a number to the nearest integer, with ties rounded to the nearest even number.
 * Also known as "bankers' rounding". This is the default rounding mode in python. For example:
 * 1.5 rounds to 2 and 2.5 rounds to 2.
 *
 * @param {number} x The number to round
 * @returns {number} The rounded number
 */
export function bankers_round(x: number) {
  var r = Math.round(x);
  var br = Math.abs(x) % 1 === 0.5 ? (r % 2 === 0 ? r : r - 1) : r;
  return br;
}

/**
 * Measures similarity between two temporal sequences (e.g., input audio and output tokens
 * to generate token-level timestamps).
 * @param {number[][]} matrix
 * @returns {number[][]}
 */
export function dynamic_time_warping(matrix: number[][]) {
  var output_length = matrix.length;
  var input_length = matrix[0].length;

  var outputShape = [output_length + 1, input_length + 1];

  var cost = Array.from({ length: outputShape[0] }, () => Array(outputShape[1]).fill(Infinity));
  cost[0][0] = 0;

  var trace = Array.from({ length: outputShape[0] }, () => Array(outputShape[1]).fill(-1));

  for (let j = 1; j < outputShape[1]; ++j) {
    for (let i = 1; i < outputShape[0]; ++i) {
      var c0 = cost[i - 1][j - 1];
      var c1 = cost[i - 1][j];
      var c2 = cost[i][j - 1];

      let c, t;
      if (c0 < c1 && c0 < c2) {
        c = c0;
        t = 0;
      } else if (c1 < c0 && c1 < c2) {
        c = c1;
        t = 1;
      } else {
        c = c2;
        t = 2;
      }
      cost[i][j] = matrix[i - 1][j - 1] + c;
      trace[i][j] = t;
    }
  }

  for (let i = 0; i < outputShape[1]; ++i) {
    // trace[0, :] = 2
    trace[0][i] = 2;
  }
  for (let i = 0; i < outputShape[0]; ++i) {
    // trace[:, 0] = 1
    trace[i][0] = 1;
  }

  // backtrace
  let i = output_length;
  let j = input_length;
  let text_indices = [];
  let time_indices = [];
  while (i > 0 || j > 0) {
    text_indices.push(i - 1);
    time_indices.push(j - 1);

    switch (trace[i][j]) {
      case 0:
        --i;
        --j;
        break;
      case 1:
        --i;
        break;
      case 2:
        --j;
        break;
      default:
        throw new Error(
          `Internal error in dynamic time warping. Unexpected trace[${i}, ${j}]. Please file a bug report.`,
        );
    }
  }

  text_indices.reverse();
  time_indices.reverse();

  return [text_indices, time_indices];
}
