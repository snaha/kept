// In-memory FeatureSource for tests and for the UI before B1's features.sqlite store exists.
// Types: feature-fake.d.ts.
export function createFakeFeatureSource({ albums = {}, tracks = {}, method = { id: 'fake', version: '1' } } = {}) {
  const pick = (table, ids) => new Map(ids.filter(id => Object.hasOwn(table, id)).map(id => [id, table[id]]))
  return {
    method,
    albumVectors: async ids => pick(albums, ids),
    trackVectors: async ids => pick(tracks, ids),
  }
}
