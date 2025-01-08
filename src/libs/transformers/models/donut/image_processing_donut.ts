import { ImageProcessor } from '../../base/image_processors_utils';

export class DonutImageProcessor extends ImageProcessor {
  pad_image(pixelData: any, imgDims: any, padSize: any, options = {}) {
    var [imageHeight, imageWidth, imageChannels] = imgDims;

    const image_mean = this.image_mean ?? [0.5, 0.5, 0.5];
    if (!Array.isArray(this.image_mean)) {
      image_mean = new Array(imageChannels).fill(image_mean);
    }

    const image_std = this.image_std;
    if (!Array.isArray(image_std)) {
      image_std = new Array(imageChannels).fill(image_mean);
    }

    var constant_values = image_mean.map((x, i) => -x / image_std[i]);

    return super.pad_image(pixelData, imgDims, padSize, constant_values, 'constant', true);
  }
}
export class DonutFeatureExtractor extends DonutImageProcessor {}
