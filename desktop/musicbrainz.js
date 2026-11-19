import { setTimeout as delay } from 'node:timers/promises'
import desktopPackage from './package.json' with { type: 'json' }

// The MusicBrainz client of the reconstruction ladder. It asks for core data only (CC0): releases,
// their tracklists, artist credits and release groups. Tags, genres and ratings are CC BY-NC-SA:
// they are never requested, and every answer is reduced to the fields below before anyone sees or
// stores it, so they cannot leak in through a search result either.
// What is sent: an album title, an artist name, a track title, or a MusicBrainz ID. Never a path,
// a file name or anything about the user.

export const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2'
// MusicBrainz allows one request a second for each application.
export const MIN_INTERVAL_MS = 1100
export const DEFAULT_REQUEST_BUDGET = 10
const RELEASE_SEARCH_LIMIT = 8
const RECORDING_SEARCH_LIMIT = 10
const RETRY_WAIT_MS = 2000
const MS_PER_SECOND = 1000
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY = 429
const HTTP_UNAVAILABLE = 503
// Words this long are also searched with one letter off, so 'Orchrad' finds 'Orchard'.
const FUZZY_FROM = 4
const LUCENE = /[+\-&|!(){}[\]^"~*?:\\/]/g
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isMbid = value => typeof value === 'string' && MBID.test(value)
const failure = (code, message) => Object.assign(new Error(message), { code })
const words = text => String(text).replace(LUCENE, ' ').split(/\s+/).filter(Boolean)
const exact = text => words(text).join(' ')
const fuzzy = text => words(text).map(word => (word.length >= FUZZY_FROM ? `${word}~` : word)).join(' ')
const creditOf = credit => (Array.isArray(credit) ? credit.map(part => `${part.name ?? ''}${part.joinphrase ?? ''}`).join('').trim() : '')
const text = value => (typeof value === 'string' ? value : '')

// The whole of what Kept keeps of a release.
export function reduceRelease(body) {
  return {
    id: text(body.id), title: text(body.title), artist: creditOf(body['artist-credit']), date: text(body.date), status: text(body.status),
    releaseGroupId: text(body['release-group']?.id) || undefined, firstReleaseDate: text(body['release-group']?.['first-release-date']) || undefined,
    media: (Array.isArray(body.media) ? body.media : []).map(medium => ({
      position: Number(medium.position) || 1,
      tracks: (Array.isArray(medium.tracks) ? medium.tracks : []).map(track => ({
        position: Number(track.position) || 0, title: text(track.title), length: Number(track.length ?? track.recording?.length) || 0, recordingId: text(track.recording?.id) || undefined,
      })),
    })),
  }
}
const releaseIds = body => (Array.isArray(body.releases) ? body.releases : []).map(release => release.id).filter(isMbid)
const recordingReleaseIds = body => (Array.isArray(body.recordings) ? body.recordings : []).flatMap(recording => releaseIds(recording))

// One request at a time for the whole process, whoever asks.
let queue = Promise.resolve()
let lastRequestAt = 0

// cache: Map of key -> reduced answer. offline: answer from the cache only, a miss throws 'cache-miss'.
// budget: requests this client may send; one more throws 'budget'.
export function createMusicBrainz({
  appVersion = desktopPackage.version, cache = new Map(), fetch = globalThis.fetch, sleep = delay,
  now = Date.now, budget = DEFAULT_REQUEST_BUDGET, offline = false, signal, intervalMs = MIN_INTERVAL_MS,
} = {}) {
  const userAgent = `Kept/${appVersion} ( ${desktopPackage.homepage} )`
  let sent = 0
  const fresh = new Map()

  const request = url => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw failure('aborted', 'Aborted')
        if (sent >= budget) throw failure('budget', 'The request budget of this album is spent')
        const wait = lastRequestAt + intervalMs - now()
        if (wait > 0) await sleep(wait)
        if (signal?.aborted) throw failure('aborted', 'Aborted')
        sent++
        lastRequestAt = now()
        let response
        try {
          response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal })
        } catch (error) { throw failure('network', `MusicBrainz could not be reached: ${error?.message ?? error}`) }
        if (response.ok) return await response.json()
        if (response.status === HTTP_NOT_FOUND) return undefined
        const busy = response.status === HTTP_UNAVAILABLE || response.status === HTTP_TOO_MANY
        if (!busy || attempt > 0) throw failure('network', `MusicBrainz answered ${response.status}`)
        await sleep(Number(response.headers.get('retry-after')) * MS_PER_SECOND || RETRY_WAIT_MS)
      }
    })
    queue = run.catch(() => {})
    return run
  }

  // missing answers are cached too, so a release that is not there is not asked for twice.
  const lookup = async (key, url, reduce) => {
    if (cache.has(key)) return cache.get(key).value
    if (offline) throw failure('cache-miss', key)
    const body = await request(url)
    const entry = { value: body === undefined ? undefined : reduce(body) }
    cache.set(key, entry)
    fresh.set(key, entry)
    return entry.value
  }
  const search = async (kind, limit, key, clauses, reduce) => {
    const ask = spell => lookup(`${key}:${spell.name}`, `${MUSICBRAINZ_API}/${kind}?query=${encodeURIComponent(clauses(spell.terms))}&fmt=json&limit=${limit}`, reduce)
    const found = await ask({ name: 'exact', terms: exact }) ?? []
    // The exact words first, so a real title is not crowded out. Then one letter off, for misspellings.
    return found.length ? found : await ask({ name: 'fuzzy', terms: fuzzy }) ?? []
  }

  return {
    // A release with its tracklist, or undefined when MusicBrainz has none under this ID.
    release(id) {
      if (!isMbid(id)) return Promise.resolve(undefined)
      return lookup(`release:${id}`, `${MUSICBRAINZ_API}/release/${id}?inc=recordings+artist-credits+release-groups&fmt=json`, reduceRelease)
    },
    // Release IDs, best first.
    searchReleases({ title, artist }) {
      const key = `search-release:${exact(title).toLowerCase()}|${exact(artist ?? '').toLowerCase()}`
      return search('release', RELEASE_SEARCH_LIMIT, key, terms => (artist ? `release:(${terms(title)}) AND artist:(${terms(artist)})` : `release:(${terms(title)})`), releaseIds)
    },
    // The IDs of the releases that hold a recording of this name by this artist.
    searchRecordings({ title, artist }) {
      const key = `search-recording:${exact(title).toLowerCase()}|${exact(artist).toLowerCase()}`
      return search('recording', RECORDING_SEARCH_LIMIT, key, terms => `recording:(${terms(title)}) AND artist:(${terms(artist)})`, recordingReleaseIds)
    },
    requests: () => sent,
    // What this client fetched, for the cache: [{ key, value? }].
    fresh: () => [...fresh].map(([key, entry]) => ({ key, value: entry.value })),
  }
}

// A cache as createMusicBrainz reads it, from stored entries [{ key, value? }].
export const cacheOf = entries => new Map((entries ?? []).map(entry => [entry.key, { value: entry.value }]))
