#!/usr/bin/env node
/** What Navidrome makes of a music folder: starts the app's Navidrome on the folder with a throwaway data folder
 *  and port, waits for the first scan, reads it back through the Subsonic and OpenSubsonic API and prints a JSON
 *  summary. Run it on the library and on an apply copy to see what the tags change in the server the app uses.
 *
 *    node scripts/navidrome-check.ts <music folder> [--navidrome ../desktop/bin/navidrome] [--port 4599] [--out file.json]
 *
 *  Navidrome only reads the music folder. External services are off, so covers and genres come from the files. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    navidrome: { type: 'string', default: process.env.NAVIDROME ?? resolve(import.meta.dirname, '../../desktop/bin/navidrome') },
    port: { type: 'string', default: '4599' },
    out: { type: 'string' },
  },
})
const folder = positionals[0]
if (!folder) throw new Error('usage: navidrome-check.ts <music folder> [--navidrome path] [--port n] [--out file]')

const USER = 'tagsmith'
const PASSWORD = 'tagsmith-check'
const API_VERSION = '1.16.1'
const POLL_MS = 250
const START_TIMEOUT_MS = 30_000
const SCAN_TIMEOUT_MS = 300_000
const ALBUM_PAGE = 500
const THUMB = 64

const base = `http://127.0.0.1:${values.port}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Contributor = { role: string; subRole?: string; artist: { name: string } }
type Song = {
  id: string
  title: string
  artist: string
  album: string
  path?: string
  year?: number
  genre?: string
  genres?: { name: string }[]
  musicBrainzId?: string
  replayGain?: { trackGain?: number; albumGain?: number; trackPeak?: number }
  contributors?: Contributor[]
}
type Album = { id: string; name: string; artist: string; year?: number; songCount: number; coverArt?: string; isCompilation?: boolean; musicBrainzId?: string; genres?: { name: string }[] }
type Lyrics = { structuredLyrics?: { synced: boolean; line: unknown[] }[] }

async function rest<T>(method: string, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams({ u: USER, p: PASSWORD, v: API_VERSION, c: 'tagsmith', f: 'json', ...params })
  const res = await fetch(`${base}/rest/${method}?${q}`)
  const body = (await res.json()) as { 'subsonic-response': T & { status: string; error?: { message: string } } }
  const r = body['subsonic-response']
  if (r.status !== 'ok') throw new Error(`${method}: ${r.error?.message ?? r.status}`)
  return r
}

async function until(what: string, timeout: number, ready: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await ready().catch(() => false)) return
    await sleep(POLL_MS)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const data = await mkdtemp(join(tmpdir(), 'tagsmith-navidrome-'))
const server = spawn(values.navidrome, [], {
  env: {
    ...process.env,
    ND_MUSICFOLDER: resolve(folder),
    ND_DATAFOLDER: data,
    ND_ADDRESS: '127.0.0.1',
    ND_PORT: values.port,
    ND_LOGLEVEL: 'error',
    ND_SCANNER_SCHEDULE: '0',
    ND_ENABLEEXTERNALSERVICES: 'false',
    ND_ENABLEINSIGHTSCOLLECTOR: 'false',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let log = ''
server.stderr.on('data', (b: Buffer) => (log += b.toString()))

try {
  await until('Navidrome to start', START_TIMEOUT_MS, async () => (await fetch(`${base}/app/`)).ok)
  const admin = await fetch(`${base}/auth/createAdmin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASSWORD }) })
  if (!admin.ok) throw new Error(`createAdmin: ${admin.status} ${await admin.text()}`)
  await rest('startScan', { fullScan: 'true' })
  await until('the scan', SCAN_TIMEOUT_MS, async () => !(await rest<{ scanStatus: { scanning: boolean } }>('getScanStatus')).scanStatus.scanning)

  const albums = (await rest<{ albumList2: { album?: Album[] } }>('getAlbumList2', { type: 'alphabeticalByName', size: String(ALBUM_PAGE) })).albumList2.album ?? []
  const songs: Song[] = []
  const covers: string[] = []
  for (const a of albums) {
    songs.push(...((await rest<{ album: { song?: Song[] } }>('getAlbum', { id: a.id })).album.song ?? []))
    // Navidrome answers a missing cover with its placeholder, a WebP; a real cover comes back as the file's JPEG or PNG
    const art = await fetch(`${base}/rest/getCoverArt?${new URLSearchParams({ u: USER, p: PASSWORD, v: API_VERSION, c: 'tagsmith', id: a.coverArt ?? a.id, size: String(THUMB) })}`)
    await art.arrayBuffer()
    if (!art.headers.get('content-type')?.includes('webp')) covers.push(a.name)
  }
  const lyrics = { synced: 0, plain: 0 }
  for (const s of songs) {
    const l = (await rest<{ lyricsList: Lyrics }>('getLyricsBySongId', { id: s.id })).lyricsList.structuredLyrics ?? []
    if (l.some((x) => x.synced)) lyrics.synced++
    else if (l.some((x) => x.line.length)) lyrics.plain++
  }
  const artists = (await rest<{ artists: { index?: { artist: { name: string }[] }[] } }>('getArtists')).artists.index?.flatMap((i) => i.artist) ?? []
  const playlists = (await rest<{ playlists: { playlist?: { name: string; songCount: number }[] } }>('getPlaylists')).playlists.playlist ?? []
  const role = (r: string) => songs.filter((s) => s.contributors?.some((c) => c.role === r))
  const genres = new Map<string, number>()
  for (const s of songs) if (s.genre) genres.set(s.genre, (genres.get(s.genre) ?? 0) + 1)

  const summary = {
    navidrome: (await rest<{ serverVersion?: string }>('ping')).serverVersion,
    folder: resolve(folder),
    songs: songs.length,
    albums: albums.length,
    artists: artists.length,
    compilations: albums.filter((a) => a.isCompilation).length,
    albumsWithCover: covers.length,
    songsWithYear: songs.filter((s) => s.year).length,
    songsWithGenre: songs.filter((s) => s.genre).length,
    songsWithMusicBrainzId: songs.filter((s) => s.musicBrainzId).length,
    songsWithReplayGain: songs.filter((s) => s.replayGain?.trackGain !== undefined && s.replayGain.trackGain !== 0).length,
    songsWithRemixer: role('remixer').length,
    songsWithDjMixer: role('djmixer').length,
    lyrics,
    playlists: playlists.map((p) => `${p.name} (${p.songCount})`),
    albumList: albums.map((a) => `${a.artist} - ${a.name}${a.year ? ` (${a.year})` : ''}: ${a.songCount} songs`),
    artistList: artists.map((a) => a.name).sort(),
    genres: Object.fromEntries([...genres].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  }
  const json = JSON.stringify(summary, null, 1) + '\n'
  if (values.out) await writeFile(values.out, json)
  else process.stdout.write(json)
} catch (e) {
  if (log) process.stderr.write(log)
  throw e
} finally {
  server.kill()
  await new Promise((r) => server.once('exit', r))
  await rm(data, { recursive: true, force: true })
}
