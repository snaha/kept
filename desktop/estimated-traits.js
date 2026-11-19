// Estimated traits: a view over features.sqlite, never stored in library.sqlite.
// An estimate is not an observation and never a user decision, so it cannot overwrite or hide a value
// the user set: the window shows the hand value whenever there is one.
//
// Only energy ships (B0 traits check: 15 of 20 albums looked right; acoustic 11 and vocal 13 failed
// the bar of 14). The value is the album's percentile within this library, 0 to 100, which is the
// scale Dig's energy slider uses: 50 is a typical album of this library, 100 the most intense one.
import { dspFeatures } from './analysis/methods.js'

// The B0 heuristic, unchanged: louder, busier, brighter and less dynamic sounds more energetic.
export const ENERGY_WEIGHTS = Object.freeze({ loudnessDb: 1, onsetRate: 1, flux: 1, centroidHz: 0.5, dynamicsDb: -0.5 })
const PERCENT = 100
// With fewer albums a percentile says nothing about the collection.
export const MIN_ESTIMATE_ALBUMS = 5

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length

/** { albumId: { energy: { value } } } from the signal-processing vectors of the analysed albums. */
export function estimateEnergy(vectors) {
  const ids = Object.keys(vectors).sort()
  if (ids.length < MIN_ESTIMATE_ALBUMS) return {}
  const features = ids.map(id => dspFeatures(vectors[id]))
  const scores = ids.map(() => 0)
  for (const [name, weight] of Object.entries(ENERGY_WEIGHTS)) {
    const values = features.map(feature => feature[name])
    const centre = mean(values)
    const spread = Math.sqrt(mean(values.map(value => (value - centre) ** 2))) || 1
    values.forEach((value, i) => { scores[i] += weight * (value - centre) / spread })
  }
  const ranked = ids.map((id, i) => ({ id, score: scores[i] }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score)
  const estimates = {}
  let below = 0
  ranked.forEach(({ id, score }, i) => {
    if (i > 0 && score !== ranked[i - 1].score) below = i
    estimates[id] = { energy: { value: Math.round(PERCENT * below / (ids.length - 1)) } }
  })
  return estimates
}

/** The bridge's `estimates` dependency over a feature store of the current method. */
export function createEstimatedTraits({ features, method }) {
  const key = { method: method.id, version: method.version }
  return { estimate: async () => (await features.estimateAlbumEnergy(key)).albums }
}
