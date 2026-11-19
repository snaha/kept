// What the C1 tools share: the scoring constants, vector maths and a cached read of the
// catalog projections. Nothing here leaves the process, and nothing returned holds a path.
// Types: tool-support.d.ts.
import { TRAIT_MAX, TRAIT_MIN } from './catalog-rules.js'
import { MAX_SEARCH_LIMIT } from './catalog-projection.js'

// Hybrid similarity (B0 round 2): sound similarity plus this bonus when two albums sit in
// the same top-level folder. Tuned on proxy 1 only, which stops improving at 0.3.
export const FOLDER_BONUS_WEIGHT = 0.3
// rank_tracks and build_queue blend the components a candidate has. Absent components do
// not dilute the score: the weights are renormalised over the ones present.
export const RANK_WEIGHTS = Object.freeze({ traits: 0.4, similarity: 0.4, novelty: 0.2 })
// find_similar blends only sound and history, and only when a novelty is asked for.
export const SIMILAR_WEIGHTS = Object.freeze({ similarity: 0.7, novelty: 0.3 })
// A candidate with nothing to score on sits in the middle.
export const NEUTRAL_SCORE = 0.5
// Plays that count as fully familiar: log2(31 + 1) = 5, the same curve as Dig's familiarity.
export const FULL_FAMILIARITY_PLAYS = 31
// A track vector counts this much against its album's score when ranking tracks of similar albums.
export const TRACK_VECTOR_SHARE = 0.5
export const SEARCH_FETCH_LIMIT = MAX_SEARCH_LIMIT
export const SCORE_PRECISION = 1e6
export const DEFAULT_MAX_PER_ALBUM = 2
export const ARTIST_SPACING = 3
export const ALBUM_SPACING = 5
// The candidate pool of a queue holds this many times the tracks asked for.
export const QUEUE_POOL_FACTOR = 4
export const MIN_POOL_ALBUMS = 20
const DETAIL_BATCH = 50
const FOLDER_DEPTH = 1

export const clampScore = value => Math.min(1, Math.max(0, value))
export const roundScore = value => Math.round(clampScore(value) * SCORE_PRECISION) / SCORE_PRECISION
export const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
export const normalName = value => (typeof value === 'string' ? value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim() : undefined)

// Cosine similarity of two vectors, or undefined when they cannot be compared.
export function cosine(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return undefined
  let dot = 0, normA = 0, normB = 0
  for (let index = 0; index < a.length; index++) {
    const x = a[index], y = b[index]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    dot += x * y
    normA += x * x
    normB += y * y
  }
  return normA === 0 || normB === 0 ? undefined : dot / Math.sqrt(normA * normB)
}

// Sound similarity 0..1 with the folder bonus, scaled so the best possible value is 1.
export const hybridScore = (similarity, sameFolder) => (Math.max(0, similarity) + (sameFolder ? FOLDER_BONUS_WEIGHT : 0)) / (1 + FOLDER_BONUS_WEIGHT)

export function familiarity(plays = 0) {
  return Math.min(1, Math.log2(plays + 1) / Math.log2(FULL_FAMILIARITY_PLAYS + 1))
}
// 1 when the item is what the novelty asks for: unplayed at novelty 1, well played at 0.
export const noveltyFit = (novelty, plays) => novelty * (1 - familiarity(plays)) + (1 - novelty) * familiarity(plays)

// 1 minus the mean distance to the targets over the traits the item has, or undefined when it has none of them.
export function traitFit(targets, traits) {
  const distances = Object.entries(targets ?? {}).flatMap(([name, target]) => (traits?.[name] ? [Math.abs(traits[name].value - target)] : []))
  return distances.length ? 1 - distances.reduce((sum, value) => sum + value, 0) / distances.length / (TRAIT_MAX - TRAIT_MIN) : undefined
}

// Weighted mean of the parts that are present.
export function blend(parts, weights) {
  let total = 0, weight = 0
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined) continue
    total += weights[name] * value
    weight += weights[name]
  }
  return weight === 0 ? undefined : total / weight
}

export const byScore = (a, b) => b.score - a.score || compareText(a.id ?? '', b.id ?? '')

const PAGE = 500

// A read of the catalog projections for the tools, kept while the catalog version stays the same
// and refreshed per album when only some albums changed. The top-level folder of an album is read
// from the location of its first track and is used only to compare albums, never returned.
export function createCatalogSnapshot(catalog) {
  let state
  const details = new Map()
  const folders = new Map()

  async function load() {
    const head = await catalog.listCatalogAlbums({ limit: 1 })
    if (state?.version === head.version) return state
    const albums = new Map()
    for (let offset = 0; ; offset += PAGE) {
      const page = await catalog.listCatalogAlbums({ offset, limit: PAGE })
      for (const album of page.albums) albums.set(album.id, album)
      if (!page.albums.length || offset + page.albums.length >= page.total) break
    }
    if (!state || head.version > state.version) state = snapshot(head.version, albums)
    return state
  }

  async function readDetail(album) {
    const cached = details.get(album.id)
    if (cached?.version === album.version) return cached
    const { album: fresh } = await catalog.getCatalogAlbum({ albumId: album.id })
    if (fresh && fresh.version >= (details.get(album.id)?.version ?? -1)) details.set(album.id, fresh)
    return fresh
  }

  async function loadTracks(albums) {
    const ordered = [...albums.values()]
    const tracks = new Map()
    for (let start = 0; start < ordered.length; start += DETAIL_BATCH) {
      const batch = await Promise.all(ordered.slice(start, start + DETAIL_BATCH).map(readDetail))
      for (const album of batch) {
        if (!album) continue
        for (const track of album.tracks) tracks.set(track.id, { track, albumId: album.id })
      }
    }
    return tracks
  }

  async function folder(album) {
    if (!album) return undefined
    const cached = folders.get(album.id)
    if (cached?.version === album.version) return cached.folder
    const first = (await readDetail(album))?.tracks[0]
    const { asset } = first ? await catalog.getAsset({ assetId: first.assetId }) : {}
    const location = [...(asset?.locations ?? [])].sort((a, b) => compareText(`${a.sourceId}/${a.path}`, `${b.sourceId}/${b.path}`))[0]
    const parts = location?.path.split('/') ?? []
    const value = parts.length > FOLDER_DEPTH ? `${location.sourceId}/${parts[0]}` : undefined
    if (album.version >= (folders.get(album.id)?.version ?? -1)) folders.set(album.id, { version: album.version, folder: value })
    return value
  }

  function snapshot(version, albums) {
    let tracks
    return {
      version,
      albums,
      async detail(albumId) {
        const album = albums.get(albumId)
        return album && readDetail(album)
      },
      async folders(albumIds) {
        const result = new Map()
        for (let start = 0; start < albumIds.length; start += DETAIL_BATCH) {
          const batch = albumIds.slice(start, start + DETAIL_BATCH)
          const values = await Promise.all(batch.map(id => folder(albums.get(id))))
          batch.forEach((id, index) => result.set(id, values[index]))
        }
        return result
      },
      // Includes offline tracks used as seeds. Built once per catalog version.
      tracks() {
        tracks ??= loadTracks(albums).catch(error => {
          tracks = undefined
          throw error
        })
        return tracks
      },
    }
  }
  return { load }
}
