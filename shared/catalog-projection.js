// The catalog read model as pure functions, shared by the fake and the SQLite service so
// both project and search alike. Types: catalog-projection.d.ts.

import { catalogError } from './catalog-rules.js'

// Bump when the shape of a projected album changes: stored projections are then rebuilt on open.
export const PROJECTION_FORMAT = 4
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100
export const CATALOG_SORTS = ['artist', 'title', 'added']
export const SEARCH_KINDS = ['album', 'artist', 'track']
export const MAX_REPORTED_DIFFERENCES = 20

const MARKS = /\p{M}+/gu
const WORD_BREAK = /[^\p{L}\p{N}]+/u
const fold = text => text.normalize('NFD').replace(MARKS, '').toLowerCase()
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Case and accents are ignored in sorting and in search.
export const sortKey = text => (typeof text === 'string' ? fold(text).trim() : '')
export const searchTerms = text => (typeof text === 'string' ? fold(text).split(WORD_BREAK).filter(Boolean) : [])
// Every term starts a word. Terms hold letters and digits only, so they need no escaping.
export const ftsQuery = terms => terms.map(term => `"${term}"*`).join(' ')
export const matchesTerms = (terms, ...texts) => {
  const words = texts.flatMap(searchTerms)
  return terms.length > 0 && terms.every(term => words.some(word => word.startsWith(term)))
}

const text = field => (typeof field?.value === 'string' && field.value.trim() ? field.value : undefined)
const year = field => (Number.isSafeInteger(field?.value) && field.value > 0 ? field.value : undefined)
// Album aliases are newest first so the window can find covers and recognize earlier IDs.
const providerLinks = (links, kind) => links.filter(link => link.kind === kind)
  .sort((a, b) => b.linkedAt - a.linkedAt || compareText(a.sourceId, b.sourceId) || compareText(a.externalId, b.externalId))
  .map(link => ({ sourceId: link.sourceId, externalId: link.externalId }))

// view: an AlbumView. assetOf: asset ID -> { duration, fields, availability, playbackLinks }. locks: locked
// field names. addedAt: when the anchor was created.
export function projectAlbum(view, assetOf, locks, addedAt) {
  const tracks = view.tracks.map(occurrence => {
    const asset = assetOf(occurrence.assetId)
    return {
      id: occurrence.id, albumId: occurrence.albumId, assetId: occurrence.assetId, position: occurrence.position, disc: occurrence.disc, track: occurrence.track,
      title: text(asset.fields.title), artist: text(asset.fields.artist), duration: asset.duration, availability: asset.availability,
      links: asset.playbackLinks,
    }
  })
  return {
    id: view.id, title: text(view.fields.title), artist: text(view.fields.artist), year: year(view.fields.year), genre: text(view.fields.genre),
    favorite: view.favorite, availability: view.availability, traits: view.traits, locks: [...locks].sort(), links: providerLinks(view.links, 'album'),
    addedAt, trackCount: tracks.length, tracks,
  }
}

export const albumSummary = ({ tracks, ...album }, version) => ({ ...album, version })
export const albumDetail = (album, version) => ({ ...album, version })

// What search indexes for one album: itself and each of its tracks. A track with no artist
// of its own is found by its album's.
export function searchRows(album) {
  if (!album.trackCount) return []
  return [
    { kind: 'album', id: album.id, albumId: album.id, title: album.title ?? '', artist: album.artist ?? '' },
    ...album.tracks.map(track => ({ kind: 'track', id: track.id, albumId: album.id, title: track.title ?? '', artist: track.artist ?? album.artist ?? '' })),
  ]
}

const SORT_KEYS = {
  artist: album => [sortKey(album.artist), album.year ?? 0, sortKey(album.title), album.id],
  title: album => [sortKey(album.title), sortKey(album.artist), album.id],
}
export function compareAlbums(sort) {
  const keys = SORT_KEYS[sort]
  return (a, b) => {
    const left = keys(a), right = keys(b)
    for (const [index, value] of left.entries()) {
      const order = typeof value === 'number' ? value - right[index] : compareText(value, right[index])
      if (order) return order
    }
    return 0
  }
}
export const compareTracks = (a, b) => compareText(sortKey(a.title), sortKey(b.title)) || compareText(a.id, b.id)
export const compareArtists = (a, b) => compareText(sortKey(a.name), sortKey(b.name)) || compareText(a.name, b.name)

export const MAX_CATALOG_QUERY_LENGTH = 200
export const MAX_TAG_LENGTH = 1000
const TAG_TEXTS = ['title', 'artist', 'album', 'albumArtist', 'genre']
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTagText = value => value === undefined || (typeof value === 'string' && value.length <= MAX_TAG_LENGTH)
export const isScanTags = tags => isObject(tags) && TAG_TEXTS.every(name => isTagText(tags[name])) && (tags.year === undefined || (Number.isSafeInteger(tags.year) && tags.year >= 0))

const mostCommon = values => {
  const counts = new Map()
  for (const value of values) if (value !== undefined && value !== '' && value !== 0) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best
  for (const [value, count] of counts) if (best === undefined || count > counts.get(best)) best = value
  return best
}
// What the tags of one scan say: a title and an artist per asset, and per anchor the album
// title, artist and year that most of its scanned files agree on.
// files: [{ assetId, tags }]. albumOf: asset ID -> its anchor, if any.
export function tagObservations(files, albumOf) {
  const found = [], groups = new Map()
  const add = (subject, field, value) => { if (value !== undefined && value !== '' && value !== 0) found.push({ subject, field, value }) }
  for (const { assetId, tags } of files) {
    if (!tags) continue
    const subject = { kind: 'asset', id: assetId }
    add(subject, 'title', tags.title)
    add(subject, 'artist', tags.artist)
    const albumId = albumOf(assetId)
    if (albumId !== undefined) groups.set(albumId, [...groups.get(albumId) ?? [], tags])
  }
  for (const [id, tags] of groups) {
    const subject = { kind: 'album', id }
    add(subject, 'title', mostCommon(tags.map(item => item.album)))
    add(subject, 'artist', mostCommon(tags.map(item => item.albumArtist || item.artist)))
    add(subject, 'year', mostCommon(tags.map(item => item.year)))
    add(subject, 'genre', mostCommon(tags.map(item => item.genre)))
  }
  return found
}

export function normalSearch(request) {
  const { query, kinds = SEARCH_KINDS, limit = DEFAULT_SEARCH_LIMIT, offset = 0 } = isObject(request) ? request : {}
  const valid = typeof query === 'string' && query.length <= MAX_CATALOG_QUERY_LENGTH && Array.isArray(kinds) && kinds.every(kind => SEARCH_KINDS.includes(kind))
    && Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_SEARCH_LIMIT && Number.isSafeInteger(offset) && offset >= 0
  if (!valid) throw catalogError('invalid-request', 'search')
  return { terms: searchTerms(query), kinds, limit, offset }
}
