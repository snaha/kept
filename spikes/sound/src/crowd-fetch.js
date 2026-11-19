// Fetches crowdsourced references for the library artists and albums into out/crowd/ (cached, gitignored).
// Sends only artist and album names to MusicBrainz, at most one request per second, with a generic User-Agent.
// Needs the analysed tracks in out/. Prints counts only.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadLibrary, normalise, OUT_DIR } from './library.js'

const CROWD_DIR = join(OUT_DIR, 'crowd')
const USER_AGENT = 'KeptResearch/0.1 ( https://github.com/ )'
const REQUEST_GAP_MS = 1100
const MIN_SCORE = 95
const SIMILAR_ALGORITHM = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30'
const VARIOUS_ARTISTS = 'various artists'
const HTTP_TOO_MANY = 503
const MAX_RETRIES = 4

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let lastRequest = 0

async function cached(name, url) {
  const file = join(CROWD_DIR, `${name}.json`)
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {}
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await sleep(Math.max(0, lastRequest + REQUEST_GAP_MS - Date.now()))
    lastRequest = Date.now()
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
    if (response.status === HTTP_TOO_MANY) {
      await sleep(REQUEST_GAP_MS * (attempt + 2))
      continue
    }
    const data = response.ok ? await response.json() : { error: response.status }
    await writeFile(file, JSON.stringify(data))
    return data
  }
  return { error: HTTP_TOO_MANY }
}

const query = text => encodeURIComponent(text)
const MB = 'https://musicbrainz.org/ws/2'
await mkdir(CROWD_DIR, { recursive: true })
const { albums } = await loadLibrary()

const artistNames = new Map(albums.map(album => [album.artistKey, album.artist]))
const artists = {}
for (const [artistKey, name] of artistNames) {
  if (artistKey === VARIOUS_ARTISTS) continue
  const found = await cached(`mb-artist-search-${artistKey.replace(/ /g, '_')}`, `${MB}/artist?query=${query(`artist:"${name.replace(/"/g, '')}"`)}&limit=3&fmt=json`)
  const top = found.artists?.[0]
  // Confident only when the search score is high and the name matches after normalisation.
  const aliases = top ? [top.name, top['sort-name'], ...(top.aliases ?? []).map(alias => alias.name)].map(normalise) : []
  const confident = Boolean(top) && top.score >= MIN_SCORE && aliases.includes(artistKey)
  artists[artistKey] = { confident, score: top?.score ?? 0, mbid: confident ? top.id : undefined }
}
for (const [artistKey, entry] of Object.entries(artists)) {
  if (!entry.mbid) continue
  const similar = await cached(`lb-similar-${entry.mbid}`, `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${entry.mbid}&algorithm=${SIMILAR_ALGORITHM}`)
  entry.similar = Array.isArray(similar) ? similar.map(row => ({ mbid: row.artist_mbid, name: row.name, score: row.score })) : []
  const detail = await cached(`mb-artist-${entry.mbid}`, `${MB}/artist/${entry.mbid}?inc=genres+tags&fmt=json`)
  entry.genres = (detail.genres ?? []).map(genre => ({ name: genre.name, count: genre.count }))
  entry.tags = (detail.tags ?? []).map(tag => ({ name: tag.name, count: tag.count }))
}

const releaseGroups = {}
for (const album of albums) {
  const artistEntry = artists[album.artistKey]
  if (!artistEntry?.mbid) continue
  const found = await cached(`mb-rg-search-${album.key.replace(/ /g, '_').slice(0, 80)}-${artistEntry.mbid}`, `${MB}/release-group?query=${query(`releasegroup:"${album.name.replace(/"/g, '')}" AND arid:${artistEntry.mbid}`)}&limit=3&fmt=json`)
  const top = found['release-groups']?.[0]
  const confident = Boolean(top) && top.score >= MIN_SCORE && normalise(top.title) === album.key
  if (!confident) {
    releaseGroups[album.key] = { confident: false }
    continue
  }
  const detail = await cached(`mb-rg-${top.id}`, `${MB}/release-group/${top.id}?inc=genres+tags&fmt=json`)
  releaseGroups[album.key] = { confident: true, mbid: top.id, genres: (detail.genres ?? []).map(genre => ({ name: genre.name, count: genre.count })), tags: (detail.tags ?? []).map(tag => ({ name: tag.name, count: tag.count })) }
}
await writeFile(join(CROWD_DIR, 'reference.json'), JSON.stringify({ artists, releaseGroups }))
const confidentArtists = Object.values(artists).filter(entry => entry.confident).length
console.log(`artists ${Object.keys(artists).length}, confident ${confidentArtists}, with similar list ${Object.values(artists).filter(entry => entry.similar?.length).length}`)
console.log(`albums ${albums.length}, confident release groups ${Object.values(releaseGroups).filter(entry => entry.confident).length}`)
