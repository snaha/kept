// C1: the four deterministic tools over injected services (the catalog projections, listening
// history and a FeatureSource). No LLM is involved: the UI calls them directly and an optional
// LLM drives the same ones through the descriptors in tool-contracts.js. Every ID in an output
// is checked against the catalog before it leaves, and anything unknown is dropped and counted.
// Types: tools.ts and tool-runner.d.ts.
import { DEFAULT_TOOL_RESULTS, validateToolInput, validateToolOutput } from './tool-contracts.js'
import {
  ALBUM_SPACING, ARTIST_SPACING, DEFAULT_MAX_PER_ALBUM, MIN_POOL_ALBUMS, NEUTRAL_SCORE, QUEUE_POOL_FACTOR, RANK_WEIGHTS, SEARCH_FETCH_LIMIT,
  SIMILAR_WEIGHTS, TRACK_VECTOR_SHARE, blend, compareText, cosine, createCatalogSnapshot, hybridScore, noveltyFit, normalName, roundScore, traitFit,
} from './tool-support.js'

const KINDS = ['album', 'track']

export const noFeatures = Object.freeze({
  method: { id: 'none', version: '0' },
  albumVectors: async () => new Map(),
  trackVectors: async () => new Map(),
})
export const noHistory = Object.freeze({ albumStats: async () => ({}) })

const ref = (kind, id) => ({ kind, id })
// A feature store that fails must not take the tools down: they fall back to traits and metadata.
const safely = async read => { try { return await read() } catch { return new Map() } }

// Where an album or track seed sits in the catalog, or undefined when it is not there.
async function resolveSeed(seed, ctx) {
  if (seed.kind === 'album') return ctx.snap.albums.has(seed.id) ? { albumId: seed.id } : undefined
  const found = (await ctx.snap.tracks()).get(seed.id)
  return found ? { albumId: found.albumId, assetId: found.track.assetId, occurrenceId: seed.id } : undefined
}

// The vector a seed stands for: its own for a track that has one, otherwise its album's.
async function seedVector(seed, ctx) {
  if (seed.assetId) {
    const own = (await safely(() => ctx.features.trackVectors([seed.assetId]))).get(seed.assetId)
    if (own) return own
  }
  return (await safely(() => ctx.features.albumVectors([seed.albumId]))).get(seed.albumId)
}

// Albums ordered by how well they match the seed: sound when the seed has a vector, else the
// traits both have, else the folder alone. One basis per list, so a list is never mixed.
async function similarAlbums(seed, ctx, { excludeArtist, albumIds }) {
  const { albums } = ctx.snap
  const seedAlbum = albums.get(seed.albumId)
  const seedArtist = excludeArtist ? normalName(seedAlbum?.artist) : undefined
  const candidates = [...albums.values()].filter(album => album.id !== seed.albumId && album.availability !== 'unavailable'
    && (!albumIds || albumIds.has(album.id))
    && !(seedArtist && normalName(album.artist) === seedArtist))
  const folders = await ctx.snap.folders([seed.albumId, ...candidates.map(album => album.id)])
  const seedFolder = folders.get(seed.albumId)
  const sameFolder = album => seedFolder !== undefined && folders.get(album.id) === seedFolder
  const vector = await seedVector(seed, ctx)
  if (vector) {
    const vectors = await safely(() => ctx.features.albumVectors(candidates.map(album => album.id)))
    const sound = candidates.flatMap(album => {
      const similarity = cosine(vector, vectors.get(album.id))
      return similarity === undefined ? [] : [{ id: album.id, score: hybridScore(similarity, sameFolder(album)), basis: 'sound' }]
    })
    if (sound.length) return sound
  }
  if (seedAlbum && Object.keys(seedAlbum.traits).length) {
    const targets = Object.fromEntries(Object.entries(seedAlbum.traits).map(([name, reading]) => [name, reading.value]))
    const traits = candidates.flatMap(album => {
      const fit = traitFit(targets, album.traits)
      return fit === undefined ? [] : [{ id: album.id, score: hybridScore(fit, sameFolder(album)), basis: 'traits' }]
    })
    if (traits.length) return traits
  }
  return candidates.filter(sameFolder).map(album => ({ id: album.id, score: 1, basis: 'metadata' }))
}

const sortScored = list => list.sort((a, b) => b.score - a.score || compareText(a.id, b.id))

async function searchCatalogTool(input, ctx) {
  const limit = input.limit ?? DEFAULT_TOOL_RESULTS
  const kinds = input.kinds ?? KINDS
  const { albums } = ctx.snap
  const keep = albumId => {
    const album = albums.get(albumId)
    if (!album) { ctx.dropped.count++; return false }
    if (input.favorite !== undefined && album.favorite !== input.favorite) return false
    return Object.entries(input.traits ?? {}).every(([name, range]) => {
      const value = album.traits[name]?.value
      return value !== undefined && value >= (range.min ?? -Infinity) && value <= (range.max ?? Infinity)
    })
  }
  const hits = []
  const addAlbum = album => {
    if (keep(album.id)) hits.push({ kind: 'album', id: album.id, albumId: album.id })
  }
  const addTrack = (track, albumId) => {
    if (track.availability === 'available' && keep(albumId)) hits.push({ kind: 'track', id: track.id, albumId })
  }
  if (input.query.trim() === '') {
    if (kinds.includes('album')) for (const album of albums.values()) addAlbum(album)
    if (kinds.includes('track')) for (const { track, albumId } of (await ctx.snap.tracks()).values()) addTrack(track, albumId)
  } else {
    // Finish the album lane before starting tracks. Each lane has its own projection offset.
    for (const kind of KINDS) {
      if (!kinds.includes(kind)) continue
      for (let offset = 0; hits.length < limit; offset += SEARCH_FETCH_LIMIT) {
        const found = await ctx.catalog.searchCatalog({ query: input.query, kinds: [kind], limit: SEARCH_FETCH_LIMIT, offset })
        if (kind === 'album') {
          for (const album of found.albums) addAlbum(album)
          if (found.albums.length < SEARCH_FETCH_LIMIT) break
        } else {
          for (const track of found.tracks) addTrack(track, track.albumId)
          if (found.tracks.length < SEARCH_FETCH_LIMIT) break
        }
      }
    }
  }
  const kept = hits.slice(0, limit)
  // Rank order from the projection becomes the score: first is 1, last is just above 0.
  return { results: kept.map((hit, index) => ({ ref: ref(hit.kind, hit.id), albumId: hit.albumId, score: (kept.length - index) / kept.length })) }
}

async function findSimilarTool(input, ctx) {
  const seed = await resolveSeed(input.seed, ctx)
  if (!seed) { ctx.dropped.count++; return { results: [] } }
  const limit = input.limit ?? DEFAULT_TOOL_RESULTS
  const kind = input.kind ?? input.seed.kind
  const stats = input.novelty === undefined ? undefined : await ctx.history.albumStats(ctx.snap.albums)
  const ranked = (await similarAlbums(seed, ctx, { excludeArtist: input.excludeSeedArtist ?? true })).map(item => ({
    ...item,
    score: input.novelty === undefined ? item.score : blend({ similarity: item.score, novelty: noveltyFit(input.novelty, stats?.[item.id]?.plays ?? 0) }, SIMILAR_WEIGHTS),
  }))
  sortScored(ranked)
  if (kind === 'album') return { results: ranked.slice(0, limit).map(item => ({ ref: ref('album', item.id), albumId: item.id, score: item.score, basis: item.basis })) }
  // Tracks of the best albums. A track with its own vector is also weighed on its sound.
  const vector = await seedVector(seed, ctx)
  const tracks = []
  for (const item of ranked.slice(0, limit)) {
    const detail = await ctx.snap.detail(item.id)
    const vectors = vector ? await safely(() => ctx.features.trackVectors((detail?.tracks ?? []).map(track => track.assetId))) : new Map()
    for (const track of detail?.tracks ?? []) {
      if (track.id === seed.occurrenceId || track.availability !== 'available') continue
      const own = cosine(vector, vectors.get(track.assetId))
      const score = own === undefined ? item.score : (1 - TRACK_VECTOR_SHARE) * item.score + TRACK_VECTOR_SHARE * Math.max(0, own)
      tracks.push({ id: track.id, albumId: item.id, score, basis: item.basis })
    }
  }
  return { results: sortScored(tracks).slice(0, limit).map(item => ({ ref: ref('track', item.id), albumId: item.albumId, score: item.score, basis: item.basis })) }
}

async function rankTracksTool(input, ctx, { allowedOccurrenceIds }) {
  const index = await ctx.snap.tracks()
  const { albums } = ctx.snap
  const stats = input.novelty === undefined ? undefined : await ctx.history.albumStats(albums)
  const wanted = []
  for (const id of new Set(input.occurrenceIds)) {
    const found = index.get(id)
    if (found?.track.availability !== 'available') ctx.dropped.count++
    else if (!allowedOccurrenceIds || allowedOccurrenceIds.has(id)) wanted.push(found)
  }
  const seed = input.similarTo ? await resolveSeed(input.similarTo, ctx) : undefined
  if (input.similarTo && !seed) ctx.dropped.count++
  const vector = seed && await seedVector(seed, ctx)
  const albumIds = [...new Set(wanted.map(item => item.albumId))]
  const folders = seed ? await ctx.snap.folders([seed.albumId, ...albumIds]) : new Map()
  const albumVectors = vector ? await safely(() => ctx.features.albumVectors(albumIds)) : new Map()
  const trackVectors = vector ? await safely(() => ctx.features.trackVectors(wanted.map(item => item.track.assetId))) : new Map()
  const scored = wanted.map(({ track, albumId }, order) => {
    const similarity = vector ? cosine(vector, trackVectors.get(track.assetId) ?? albumVectors.get(albumId)) : undefined
    const parts = {
      traits: traitFit(input.traits, albums.get(albumId)?.traits),
      similarity: similarity === undefined ? undefined : hybridScore(similarity, folders.get(seed.albumId) !== undefined && folders.get(albumId) === folders.get(seed.albumId)),
      novelty: input.novelty === undefined ? undefined : noveltyFit(input.novelty, stats?.[albumId]?.plays ?? 0),
    }
    return { id: track.id, albumId, order, score: blend(parts, RANK_WEIGHTS) ?? NEUTRAL_SCORE }
  })
  // Equal scores keep the order the caller gave.
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return { ranked: scored.slice(0, input.limit ?? scored.length).map(item => ({ occurrenceId: item.id, albumId: item.albumId, score: item.score })) }
}

// Seeds open the queue in order; the rest comes from albums like the seeds, best fit first, with
// no track twice, at most maxPerAlbum per album, and artists and albums kept apart. When the
// pool cannot keep them apart the spacing relaxes before the queue comes up short.
async function buildQueueTool(input, ctx, options) {
  const { albums } = ctx.snap
  const { allowedOccurrenceIds, matchingAlbumIds } = options
  if (allowedOccurrenceIds?.size === 0) return { occurrenceIds: [] }
  const stats = input.novelty === undefined ? undefined : await ctx.history.albumStats(albums)
  const length = options.targetLength ?? input.length
  const maxPerAlbum = input.maxPerAlbum ?? (matchingAlbumIds ? length : DEFAULT_MAX_PER_ALBUM)
  const seeds = []
  for (const item of input.seeds) {
    const seed = await resolveSeed(item, ctx)
    if (seed) seeds.push({ ...seed, kind: item.kind })
    else ctx.dropped.count++
  }
  if (!seeds.length) return { occurrenceIds: [] }
  // An album's pool score is its mean similarity to the seeds, a seed album counting 1 for itself.
  const pool = new Map()
  for (const seed of seeds) {
    pool.set(seed.albumId, (pool.get(seed.albumId) ?? 0) + 1)
    for (const item of await similarAlbums(seed, ctx, { excludeArtist: false, albumIds: matchingAlbumIds })) pool.set(item.id, (pool.get(item.id) ?? 0) + item.score)
  }
  // Exact requests can use matching tracks even when their albums lack similarity data.
  if (matchingAlbumIds) {
    for (const id of pool.keys()) if (!matchingAlbumIds.has(id)) pool.delete(id)
    for (const id of matchingAlbumIds) if (!pool.has(id)) pool.set(id, 0)
  }
  const ordered = sortScored([...pool].map(([id, total]) => ({ id, score: total / seeds.length })))
  const candidates = []
  // Counts what can actually be queued: an album gives at most maxPerAlbum tracks.
  let usable = 0
  for (const item of ordered) {
    if (usable >= Math.max(length, MIN_POOL_ALBUMS) * QUEUE_POOL_FACTOR) break
    const detail = await ctx.snap.detail(item.id)
    const album = albums.get(item.id)
    if (!detail || !album || album.availability === 'unavailable') continue
    const fit = traitFit(input.traits, album.traits)
    const novelty = input.novelty === undefined ? undefined : noveltyFit(input.novelty, stats?.[item.id]?.plays ?? 0)
    const score = blend({ similarity: item.score, traits: fit, novelty }, RANK_WEIGHTS)
    let fromAlbum = 0
    for (const track of detail.tracks) {
      if (track.availability !== 'available' || (allowedOccurrenceIds && !allowedOccurrenceIds.has(track.id))) continue
      fromAlbum++
      candidates.push({ id: track.id, albumId: item.id, artist: normalName(track.artist ?? album.artist), position: track.position, duration: track.duration ?? 0, score, albumScore: item.score })
    }
    usable += Math.min(fromAlbum, maxPerAlbum)
  }
  candidates.sort((a, b) => b.score - a.score || b.albumScore - a.albumScore || compareText(a.albumId, b.albumId) || a.position - b.position || compareText(a.id, b.id))
  const queue = []
  const taken = new Set()
  const perAlbum = new Map()
  let seconds = 0
  const done = () => queue.length >= length || (options.targetSeconds !== undefined && seconds >= options.targetSeconds)
  const take = candidate => {
    queue.push(candidate)
    taken.add(candidate.id)
    perAlbum.set(candidate.albumId, (perAlbum.get(candidate.albumId) ?? 0) + 1)
    seconds += candidate.duration
  }
  const open = candidate => !taken.has(candidate.id) && (perAlbum.get(candidate.albumId) ?? 0) < maxPerAlbum
  for (const seed of seeds) {
    if (done()) break
    const own = seed.occurrenceId ? candidates.find(candidate => candidate.id === seed.occurrenceId) : candidates.filter(candidate => candidate.albumId === seed.albumId).sort((a, b) => a.position - b.position)[0]
    if (own && open(own)) take(own)
  }
  // Spacing: no artist in the last ARTIST_SPACING picks and no album in the last ALBUM_SPACING, then no
  // immediate repeat, then none.
  const recent = count => (count === 0 ? [] : queue.slice(-count))
  const levels = [[ARTIST_SPACING, ALBUM_SPACING], [1, 1], [0, 0]]
  while (!done()) {
    let chosen
    for (const [artistGap, albumGap] of levels) {
      chosen = candidates.find(candidate => open(candidate)
        && !recent(artistGap).some(entry => candidate.artist !== undefined && entry.artist === candidate.artist)
        && !recent(albumGap).some(entry => entry.albumId === candidate.albumId))
      if (chosen) break
    }
    if (!chosen) break
    take(chosen)
  }
  return { occurrenceIds: queue.map(entry => entry.id), albumIds: queue.map(entry => entry.albumId) }
}

const TOOLS = { search_catalog: searchCatalogTool, find_similar: findSimilarTool, rank_tracks: rankTracksTool, build_queue: buildQueueTool }

// Keeps what the catalog holds. An album must be listed and a track must be in its album's
// detail, so a bogus ID from a feature store or a search index never leaves.
async function keepKnown(name, raw, ctx) {
  const { albums } = ctx.snap
  const known = async (kind, id, albumId) => kind === 'album'
    ? albums.has(id)
    : (await ctx.snap.detail(albumId))?.tracks.some(track => track.id === id)
  const strip = ({ albumId, ...rest }) => rest
  const filter = async (items, kindOf, idOf) => {
    const kept = []
    for (const item of items) {
      if (await known(kindOf(item), idOf(item), item.albumId)) kept.push(strip(item))
      else ctx.dropped.count++
    }
    return kept
  }
  if (name === 'search_catalog' || name === 'find_similar') return { results: await filter(raw.results, item => item.ref.kind, item => item.ref.id) }
  if (name === 'rank_tracks') return { ranked: await filter(raw.ranked, () => 'track', item => item.occurrenceId) }
  const kept = []
  const seen = new Set()
  for (const [index, id] of raw.occurrenceIds.entries()) {
    if (!seen.has(id) && await known('track', id, raw.albumIds[index])) { kept.push(id); seen.add(id) }
    else ctx.dropped.count++
  }
  return { occurrenceIds: kept }
}

const roundScores = output => JSON.parse(JSON.stringify(output, (key, value) => (key === 'score' ? roundScore(value) : value)))

export function createToolRunner({ catalog, features = noFeatures, history = noHistory } = {}) {
  const snap = createCatalogSnapshot(catalog)

  async function runWithSnapshot(name, input, resolveOptions) {
    validateToolInput(name, input)
    const snapshot = await snap.load()
    const ctx = { catalog, snap: snapshot, features, history, dropped: { count: 0 } }
    const options = resolveOptions ? await resolveOptions(snapshot) : undefined
    const raw = await TOOLS[name](input, ctx, options ?? {})
    const output = validateToolOutput(name, roundScores(await keepKnown(name, raw, ctx)))
    return { result: { name, output, dropped: ctx.dropped.count }, snapshot }
  }

  return {
    loadCatalog: snap.load,
    runWithSnapshot,
    // Checks the input against the contract, runs the tool, and returns only IDs that exist in the
    // catalog, with the number of rejected IDs. targetSeconds (build_queue) is
    // not part of the contract: it is for the UI, which may ask for a duration instead of a length.
    async run(name, input, options) {
      const { result } = await runWithSnapshot(name, input, options && (() => options))
      return result
    },
  }
}
