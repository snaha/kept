// Fetches Last.fm similar artists and top tags for the library artists and albums into out/crowd/
// (cached, gitignored). Evaluation only: Last.fm terms rule out shipping this data. The key is read
// from the repository .env at runtime and never printed. Sends only artist and album names.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadLibrary, OUT_DIR } from './library.js'

const CROWD_DIR = join(OUT_DIR, 'crowd')
const USER_AGENT = 'KeptResearch/0.1 ( https://github.com/ )'
const REQUEST_GAP_MS = 260
const SIMILAR_LIMIT = 100
const VARIOUS_ARTISTS = 'various artists'
const MAX_RETRIES = 3

// The nearest .env above this folder; in a worktree that is the main checkout's.
function findEnvFile() {
  for (let dir = dirname(new URL(import.meta.url).pathname); dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, '.env'))) return join(dir, '.env')
  throw new Error('no .env found above the spike')
}
const env = await readFile(findEnvFile(), 'utf8')
const key = env.match(/^LASTFM_API_KEY=(.*)$/m)?.[1].replace(/['"]/g, '').trim()
if (!key) throw new Error('LASTFM_API_KEY missing from .env')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let lastRequest = 0

async function cached(name, params) {
  const file = join(CROWD_DIR, `lastfm-${name}.json`)
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {}
  const url = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({ ...params, api_key: key, format: 'json' })}`
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await sleep(Math.max(0, lastRequest + REQUEST_GAP_MS - Date.now()))
    lastRequest = Date.now()
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      const data = await response.json()
      await writeFile(file, JSON.stringify(data))
      return data
    } catch {
      await sleep(REQUEST_GAP_MS * (attempt + 2))
    }
  }
  return { error: 'failed' }
}
const slug = text => text.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
const tagsOf = data => (data.toptags?.tag ?? []).map(tag => ({ name: tag.name.toLowerCase(), count: Number(tag.count) }))

await mkdir(CROWD_DIR, { recursive: true })
const { albums } = await loadLibrary()
const result = { artists: {}, albums: {} }
for (const album of albums) {
  if (album.artistKey === VARIOUS_ARTISTS) continue
  if (!result.artists[album.artistKey]) {
    const similar = await cached(`similar-${slug(album.artistKey)}`, { method: 'artist.getSimilar', artist: album.artist, limit: String(SIMILAR_LIMIT), autocorrect: '0' })
    const tags = await cached(`tags-${slug(album.artistKey)}`, { method: 'artist.getTopTags', artist: album.artist, autocorrect: '0' })
    result.artists[album.artistKey] = { similar: (similar.similarartists?.artist ?? []).map(row => ({ name: row.name, match: Number(row.match) })), tags: tagsOf(tags) }
  }
  const tags = await cached(`album-${slug(album.artistKey)}-${slug(album.key)}`, { method: 'album.getTopTags', artist: album.artist, album: album.name, autocorrect: '0' })
  result.albums[album.key] = { tags: tagsOf(tags) }
}
await writeFile(join(CROWD_DIR, 'lastfm.json'), JSON.stringify(result))
const artists = Object.values(result.artists)
console.log(`artists ${artists.length}, with similar ${artists.filter(entry => entry.similar.length).length}, with tags ${artists.filter(entry => entry.tags.length).length}`)
console.log(`albums ${albums.length}, with album tags ${Object.values(result.albums).filter(entry => entry.tags.length).length}`)
