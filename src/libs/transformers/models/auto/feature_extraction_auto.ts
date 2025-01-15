import { FEATURE_EXTRACTOR_NAME, GITHUB_ISSUE_URL } from '../../utils/constants.js';
import { getModelJSON } from '../../utils/hub.js';
import { FeatureExtractor } from '../../base/feature_extraction_utils.js';
import * as AllFeatureExtractors from '../feature_extractors.js';

export class AutoFeatureExtractor {
  /** @type {typeof FeatureExtractor.from_pretrained} */
  static async from_pretrained(pretrained_model_name_or_path: string, options = {}) {
    let preprocessorConfig = await getModelJSON(pretrained_model_name_or_path, FEATURE_EXTRACTOR_NAME, true, options);

    // Determine feature extractor class
    let key = preprocessorConfig.feature_extractor_type;
    let feature_extractor_class = AllFeatureExtractors[key as keyof typeof AllFeatureExtractors];

    if (!feature_extractor_class) {
      throw new Error(`Unknown feature_extractor_type: '${key}'. Please report this at ${GITHUB_ISSUE_URL}.`);
    }

    // Instantiate feature extractor
    return new feature_extractor_class(preprocessorConfig);
  }
}
