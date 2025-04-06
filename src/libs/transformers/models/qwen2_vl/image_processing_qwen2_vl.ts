import { ImageProcessor } from '../../base/image_processors_utils.js';
import { cat, Tensor } from '../../utils/tensor.js';

export class Qwen2VLImageProcessor extends ImageProcessor {
  async _call(images, ...args) {
    var { pixel_values, original_sizes, reshaped_input_sizes } = await super._call(images, ...args);

    let patches = pixel_values;

    // @ts-ignore
    var { temporal_patch_size, merge_size, patch_size } = this.config;
    if (patches.dims[0] === 1) {
      // Equivalent to np.tile(patches, (self.temporal_patch_size, 1, 1, 1))
      patches = cat(
        Array.from({ length: temporal_patch_size }, () => patches),
        0,
      );
    }

    var grid_t = patches.dims[0] / temporal_patch_size;
    var channel = patches.dims[1];
    var grid_h = Math.floor(patches.dims[2] / patch_size);
    var grid_w = Math.floor(patches.dims[3] / patch_size);

    var flatten_patches = patches
      .view(
        grid_t,
        temporal_patch_size,
        channel,
        Math.floor(grid_h / merge_size),
        merge_size,
        patch_size,
        Math.floor(grid_w / merge_size),
        merge_size,
        patch_size,
      )
      .permute(0, 3, 6, 4, 7, 2, 1, 5, 8)
      .view(grid_t * grid_h * grid_w, channel * temporal_patch_size * patch_size * patch_size);

    var image_grid_thw = new Tensor('int64', [grid_t, grid_h, grid_w], [1, 3]);

    return {
      pixel_values: flatten_patches,
      image_grid_thw,
      original_sizes,
      reshaped_input_sizes,
    };
  }
}
