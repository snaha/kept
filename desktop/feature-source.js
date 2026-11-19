import { createCatalogSnapshot, normalName } from '../shared/tool-support.js'

// C1's FeatureSource over features.sqlite: the OpenL3 embeddings of the current method version,
// album vectors keyed by album anchor (the aggregate) and track vectors by asset. Assets of a source
// that forbids analysis have no row (the analyser removes them), so they never appear here.
export function createFeatureSource({ features, method }) {
  const key = { method: method.id, version: method.version }
  const read = async (call, request) => new Map(Object.entries((await call({ ...key, ...request })).vectors))
  return {
    method: { id: method.id, version: String(method.version) },
    albumVectors: albumIds => read(features.albumEmbeddings, { albumIds: [...albumIds] }),
    trackVectors: assetIds => read(features.trackEmbeddings, { assetIds: [...assetIds] }),
  }
}

export function createSoundSimilarity({ catalog, features, method }) {
  const snapshot = createCatalogSnapshot(catalog)
  const key = { method: method.id, version: method.version }
  return async albumId => {
    const { albums } = await snapshot.load()
    const seed = albums.get(albumId)
    if (!seed) return { analysed: false, albumIds: [] }
    const artist = normalName(seed.artist)
    const candidateIds = [...albums.values()].filter(album => album.id !== albumId && album.availability !== 'unavailable'
      && !(artist && normalName(album.artist) === artist)).map(album => album.id)
    return features.similarAlbums({ ...key, albumId, candidateIds })
  }
}
