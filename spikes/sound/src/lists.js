// Seed choice, neighbour lists, trait estimates and page writing shared by both sheet rounds.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dot, featureRow, FEATURE_NAMES, OUT_DIR } from './library.js'

export const LIST_SIZE = 5
const PERCENT = 100

export const hash = text => createHash('sha256').update(text).digest('hex')
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
const byHash = (albums, salt = '') => (a, b) => (hash(salt + albums[a].key) < hash(salt + albums[b].key) ? -1 : 1)
export const albumLabel = album => `${album.artist} — ${album.name}`

/**
 * Picks albums spread over the top-level folders in proportion to their sizes (genre tags are too
 * rare to spread over), in hash order, one per artist. `excluded` holds album indexes to skip, and
 * `usedArtists` artist keys that may not appear.
 */
export function pickSeeds(albums, count, excluded = new Set(), usedArtists = new Set(), salt = '') {
  const groups = new Map()
  for (const [index, album] of albums.entries()) {
    if (excluded.has(index)) continue
    if (!groups.has(album.folder)) groups.set(album.folder, [])
    groups.get(album.folder).push(index)
  }
  for (const group of groups.values()) group.sort(byHash(albums, salt))
  const seeds = []
  const artists = new Set(usedArtists)
  const taken = new Map([...groups.keys()].map(folder => [folder, 0]))
  while (seeds.length < Math.min(count, albums.length)) {
    // Largest-remainder turn taking keeps the seed mix proportional to the folder sizes.
    const folder = [...groups.keys()].filter(name => groups.get(name).length).sort((a, b) => taken.get(a) / (groups.get(a).length + taken.get(a)) - taken.get(b) / (groups.get(b).length + taken.get(b)) || (a < b ? -1 : 1))[0]
    if (!folder) break
    const index = groups.get(folder).shift()
    if (artists.has(albums[index].artistKey)) continue
    artists.add(albums[index].artistKey)
    taken.set(folder, taken.get(folder) + 1)
    seeds.push(index)
  }
  return seeds
}

/** Nearest albums by cosine similarity, excluding the album's own artist. */
export function nearestAlbums(albums, vectors, albumIndex) {
  return albums.map((_, j) => j)
    .filter(j => j !== albumIndex && albums[j].artistKey !== albums[albumIndex].artistKey)
    .sort((a, b) => dot(vectors[albumIndex], vectors[b]) - dot(vectors[albumIndex], vectors[a]))
    .slice(0, LIST_SIZE)
}

/** Baseline: same genre tag first, then the same top-level folder, in a hash order fixed per seed. */
export function baselineAlbums(albums, albumIndex) {
  const seed = albums[albumIndex]
  const shared = j => albums[j].genres.filter(genre => seed.genres.includes(genre)).length
  return albums.map((_, j) => j)
    .filter(j => j !== albumIndex && albums[j].artistKey !== seed.artistKey)
    .sort((a, b) => shared(b) - shared(a) || Number(albums[b].folder === seed.folder) - Number(albums[a].folder === seed.folder) || (hash(seed.key + albums[a].key) < hash(seed.key + albums[b].key) ? -1 : 1))
    .slice(0, LIST_SIZE)
}

/** Half the seeds, picked by hash order, show the first list as X. */
export function firstOnX(albums, seeds) {
  return new Set([...seeds].sort(byHash(albums, 'side:')).slice(0, Math.floor(seeds.length / 2)))
}

/** Appends a scaled one-hot folder code, so a dot product gains `weight` when two rows share a folder. */
export function withFolderBonus(vectors, folders, weight) {
  const names = [...new Set(folders)].sort()
  return vectors.map((vector, i) => Float64Array.from([...vector, ...names.map(name => (name === folders[i] ? Math.sqrt(weight) : 0))]))
}

/** Dig axis proxies as library percentiles (0–100). Heuristic: no hand-set traits exist to fit them to. */
export function estimateTraits(albums) {
  const columns = Object.fromEntries(FEATURE_NAMES.map((name, column) => [name, albums.map(album => mean(album.tracks.map(track => featureRow(track.features)[column])))]))
  const z = name => {
    const values = columns[name]
    const m = mean(values)
    const sd = Math.sqrt(mean(values.map(value => (value - m) ** 2))) || 1
    return values.map(value => (value - m) / sd)
  }
  const percentile = scores => scores.map(score => Math.round((PERCENT * scores.filter(other => other < score).length) / Math.max(scores.length - 1, 1)))
  const combine = weights => albums.map((_, i) => Object.entries(weights).reduce((sum, [name, weight]) => sum + weight * z(name)[i], 0))
  const proxies = {
    energy: percentile(combine({ loudnessDb: 1, onsetRate: 1, flux: 1, centroidHz: 0.5, dynamicsDb: -0.5 })),
    acoustic: percentile(combine({ highRatio: -1, flatness: -1, loudnessDb: -0.5, dynamicsDb: 0.5, flux: -0.5 })),
    vocal: percentile(combine({ syllabicModulation: 1, centroidStdHz: 0.5, lowRatio: -0.5 })),
  }
  return albums.map((album, i) => ({ album: albumLabel(album), energy: proxies.energy[i], acoustic: proxies.acoustic[i], vocal: proxies.vocal[i] }))
}

/** Fills a page template with a base64 JSON payload and writes it to out/. Returns the path. */
export async function writePage(template, fileName, payload) {
  const html = await readFile(new URL(`./${template}`, import.meta.url), 'utf8')
  const page = join(OUT_DIR, fileName)
  await writeFile(page, html.replace('__PAYLOAD__', Buffer.from(JSON.stringify(payload)).toString('base64')))
  return page
}

/**
 * Rows for a blind sheet comparing two list makers. `names` are the two labels shown after the
 * reveal; the first list's side is balanced over the seeds.
 */
export function blindRows(albums, seeds, names, firstList, secondList) {
  const onX = firstOnX(albums, seeds)
  return seeds.map(index => {
    const first = firstList(index)
    const second = secondList(index)
    const firstIsX = onX.has(index)
    return {
      seed: albumLabel(albums[index]),
      x: (firstIsX ? first : second).map(j => albumLabel(albums[j])),
      y: (firstIsX ? second : first).map(j => albumLabel(albums[j])),
      [names[0]]: firstIsX ? 'x' : 'y',
      overlap: first.filter(j => second.includes(j)).length,
      first,
      second,
    }
  })
}
