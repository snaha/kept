import path from 'node:path'
import { MUSICBRAINZ_SOURCE_ID, runLadder } from '../../shared/reconstruct.js'
import { createEmbeddedReader } from '../embedded-tags.js'
import { cacheOf, createMusicBrainz } from '../musicbrainz.js'

// One run of the reconstruction ladder over an album-sized cluster. payload: { cluster, roots },
// prepared by the main process when the job is claimed (reconstruct-jobs.js). Files are only read.
// The network is touched only by the MusicBrainz client, which the ladder calls only for a source
// the user permitted.
export default async ctx => {
  const { appVersion, cluster, roots = {} } = ctx.payload
  const reader = await createEmbeddedReader()
  const fileOf = track => (track.available && roots[track.sourceId] ? path.join(roots[track.sourceId], ...track.path.split('/')) : undefined)
  const cache = cacheOf(cluster.cache)
  const provider = cluster.permissions?.[MUSICBRAINZ_SOURCE_ID]?.status === 'permitted'
    ? createMusicBrainz({ appVersion, cache, signal: ctx.signal })
    : undefined
  const result = await runLadder(cluster, {
    rest: ctx.rest,
    readEmbedded: reader && (async track => {
      const file = fileOf(track)
      return file ? reader(file) : undefined
    }),
    provider,
    cachedProvider: createMusicBrainz({ cache, offline: true }),
  })
  return { ...result, version: cluster.version, albumIds: cluster.albums.map(album => album.id), cache: provider?.fresh() ?? [] }
}
