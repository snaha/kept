import type { FeatureMethod, FeatureSource, FeatureVector } from './tools'

// albums by catalog album ID, tracks by asset ID. The fake also answers for IDs the catalog does not have.
export function createFakeFeatureSource(vectors?: { albums?: Record<string, FeatureVector>; tracks?: Record<string, FeatureVector>; method?: FeatureMethod }): FeatureSource
