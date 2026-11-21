// Loads analysed tracks and groups them into albums with comparable vectors.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const OUT_DIR = new URL('../out', import.meta.url).pathname
const MIN_ALBUM_TRACKS = 3
const Z_CLIP = 4
const EPSILON = 1e-12
const IGNORED_ALBUMS = new Set(['', 'unknown album'])
const IGNORED_ROOTS = new Set(['Music'])
const LOG_FEATURES = ['centroidHz', 'centroidStdHz', 'rolloffHz', 'flatness', 'highRatio', 'lowRatio', 'tempoBpm']
const LINEAR_FEATURES = ['loudnessDb', 'dynamicsDb', 'zcr', 'flux', 'onsetRate', 'tempoStrength', 'keyStrength', 'major', 'syllabicModulation']

export const normalise = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const mostCommon = values => {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? ''
}

export function unit(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) + EPSILON
  return Float64Array.from(vector, value => value / norm)
}
export const dot = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}
export function meanUnit(vectors) {
  const sum = new Float64Array(vectors[0].length)
  for (const vector of vectors) for (let i = 0; i < sum.length; i++) sum[i] += vector[i]
  return unit(sum)
}

/** Z-scores each column across rows, clipped, and returns unit rows. */
function standardise(rows) {
  const width = rows[0].length
  const means = new Float64Array(width)
  const stds = new Float64Array(width)
  for (const row of rows) for (let i = 0; i < width; i++) means[i] += row[i] / rows.length
  for (const row of rows) for (let i = 0; i < width; i++) stds[i] += (row[i] - means[i]) ** 2 / rows.length
  return rows.map(row => unit(row.map((value, i) => Math.max(-Z_CLIP, Math.min(Z_CLIP, (value - means[i]) / (Math.sqrt(stds[i]) + EPSILON))))))
}

export function decodeEmbedding(base64) {
  const bytes = Buffer.from(base64, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

/** Subtracts the collection mean and returns unit rows, ready for cosine similarity. */
export function centredUnit(embeddings) {
  const centre = new Float64Array(embeddings[0].length)
  for (const embedding of embeddings) for (let i = 0; i < centre.length; i++) centre[i] += embedding[i] / embeddings.length
  return embeddings.map(embedding => unit(Array.from(embedding, (value, i) => value - centre[i])))
}

export function featureRow(features) {
  return [...LOG_FEATURES.map(name => Math.log(features[name] + EPSILON)), ...LINEAR_FEATURES.map(name => features[name]), ...features.mfccMean, ...features.mfccStd]
}
export const FEATURE_NAMES = [...LOG_FEATURES, ...LINEAR_FEATURES]

export async function loadLibrary(prefix = 'tracks') {
  const names = (await readdir(OUT_DIR)).filter(name => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl')).sort()
  const raw = []
  for (const name of names) for (const line of (await readFile(join(OUT_DIR, name), 'utf8')).split('\n')) if (line) raw.push(JSON.parse(line))
  raw.sort((a, b) => (a.path < b.path ? -1 : 1))

  const groups = new Map()
  for (const track of raw) {
    const segments = track.path.split('/')
    const albumName = track.album || segments.at(-2) || ''
    if (IGNORED_ALBUMS.has(normalise(albumName))) continue
    const key = normalise(albumName)
    if (!groups.has(key)) groups.set(key, { key, name: albumName, tracks: [], titles: new Set() })
    const group = groups.get(key)
    const title = normalise(track.title || segments.at(-1))
    // The same recording in two formats or folders counts once.
    if (group.titles.has(title)) continue
    group.titles.add(title)
    group.tracks.push(track)
  }

  const albums = [...groups.values()].filter(group => group.tracks.length >= MIN_ALBUM_TRACKS).map(group => {
    const artists = group.tracks.map(track => track.albumArtist || track.artist)
    const uniform = new Set(artists.map(normalise)).size === 1
    const roots = group.tracks.map(track => track.path.split('/')[0]).filter(root => !IGNORED_ROOTS.has(root))
    const genres = new Set(group.tracks.flatMap(track => track.genre.split(/[,;/]/).map(normalise)).filter(Boolean))
    const artist = (uniform ? artists[0] : mostCommon(group.tracks.map(track => track.albumArtist).filter(Boolean))) || 'Various Artists'
    return { key: group.key, name: group.name, artist, artistKey: normalise(artist), folder: mostCommon(roots), genres: [...genres].sort(), tracks: group.tracks }
  }).sort((a, b) => (a.key < b.key ? -1 : 1))

  const tracks = albums.flatMap((album, albumIndex) => album.tracks.map(track => ({ ...track, albumIndex })))
  const dsp = standardise(tracks.map(track => featureRow(track.features)))
  const embeddings = tracks.map(track => decodeEmbedding(track.embedding))
  const openl3 = centredUnit(embeddings)
  const both = tracks.map((_, i) => unit([...dsp[i], ...openl3[i]]))
  const trackVectors = { dsp, openl3, both }

  const albumVectors = {}
  for (const [name, vectors] of Object.entries(trackVectors)) {
    albumVectors[name] = albums.map((_, albumIndex) => meanUnit(vectors.filter((_, i) => tracks[i].albumIndex === albumIndex)))
  }
  // Combined album vector: equal weight to each representation's album direction.
  albumVectors.both = albums.map((_, i) => unit([...albumVectors.dsp[i], ...albumVectors.openl3[i]]))
  return { rawCount: raw.length, albums, tracks, trackVectors, albumVectors }
}
