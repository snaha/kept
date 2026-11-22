// The analysis rule of the source registry, enforced where work is queued or run: audio and metadata
// of a source with analysisAllowed = false never reach features, training or similarity.
// Types: source-policy.d.ts.
import { catalogError } from './catalog-rules.js'
import { isSpotifyCatalogId } from './spotify-source.js'

export const isAnalysable = source => source?.policy?.analysisAllowed === true

// Throws 'invalid-source' for a source that is unknown or may not be analysed.
export function assertAnalysable(source, what = 'analysis') {
  if (!source) throw catalogError('invalid-source', `${what} refused: unknown source`)
  if (!isAnalysable(source)) throw catalogError('invalid-source', `${what} refused: ${source.id} is not allowed to be analysed`)
  return source
}

// Catalog IDs of provider playback entities (Spotify tracks). Tools and feature stores must skip them.
export const isUnanalysableId = id => isSpotifyCatalogId(id)
