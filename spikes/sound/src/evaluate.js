// Automatic proxies, the 20-seed comparison and the blind judging page.
// Prints numbers only; album names stay in out/.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadLibrary, OUT_DIR } from './library.js'
import { baselineAlbums, blindRows, estimateTraits, nearestAlbums, pickSeeds, writePage } from './lists.js'
import { trackRetrieval } from './retrieval.js'

const SEED_COUNT = 20
const PASS_SEEDS = 13
const PERMUTATIONS = 1000
const PERMUTATION_SEED = 20261119
const REPRESENTATIONS = ['dsp', 'openl3', 'both']

const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}
function shuffled(values, random) {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = result[i]
    result[i] = result[j]
    result[j] = swap
  }
  return result
}

const library = await loadLibrary()
const { albums, tracks, trackVectors, albumVectors } = library

const retrieval = Object.fromEntries(REPRESENTATIONS.map(name => [name, trackRetrieval(albums, tracks, trackVectors[name])]))
const chosen = REPRESENTATIONS.reduce((best, name) => (retrieval[name].sameAlbumTop1 > retrieval[best].sameAlbumTop1 ? name : best))
const vectors = albumVectors[chosen]

const soundNeighbours = (albumIndex, vectorSet = vectors) => nearestAlbums(albums, vectorSet, albumIndex)

// Proxy 2: do sound neighbours share a label more often than chance (labels shuffled across albums)?
function agreement(labelsOf, vectorSet = vectors) {
  const labelled = albums.map((_, i) => i).filter(i => labelsOf(i).length)
  const neighbours = new Map(labelled.map(i => [i, soundNeighbours(i, vectorSet)]))
  const statistic = labels => mean(labelled.map(i => mean(neighbours.get(i).map(j => (labels[j].some(label => labels[i].includes(label)) ? 1 : 0)))))
  const labels = albums.map((_, i) => labelsOf(i))
  const observed = statistic(labels)
  const random = mulberry32(PERMUTATION_SEED)
  const samples = []
  for (let n = 0; n < PERMUTATIONS; n++) {
    // Shuffle among labelled albums only, so each still has a label to match.
    const order = shuffled(labelled, random)
    const permuted = [...labels]
    labelled.forEach((albumIndex, k) => { permuted[albumIndex] = labels[order[k]] })
    samples.push(statistic(permuted))
  }
  const chance = mean(samples)
  return { labelled: labelled.length, observed, chance, lift: observed / (chance || Number.EPSILON), p: (samples.filter(sample => sample >= observed).length + 1) / (PERMUTATIONS + 1) }
}

const genreAgreement = agreement(i => albums[i].genres)
const folderAgreement = Object.fromEntries(REPRESENTATIONS.map(name => [name, agreement(i => [albums[i].folder], albumVectors[name])]))

const seeds = pickSeeds(albums, SEED_COUNT)
const sheet = blindRows(albums, seeds, ['sound', 'tags'], soundNeighbours, index => baselineAlbums(albums, index)).map(({ first, second, ...row }, n) => ({
  ...row,
  genreMatches: second.filter(j => albums[j].genres.some(genre => albums[seeds[n]].genres.includes(genre))).length,
}))
const traits = estimateTraits(albums)

const summary = {
  tracksAnalysed: library.rawCount,
  tracksInAlbums: tracks.length,
  albums: albums.length,
  artists: new Set(albums.map(album => album.artistKey)).size,
  albumsWithGenreTag: albums.filter(album => album.genres.length).length,
  distinctGenreTags: new Set(albums.flatMap(album => album.genres)).size,
  folders: Object.fromEntries([...new Set(albums.map(album => album.folder))].map(folder => [folder, albums.filter(album => album.folder === folder).length])),
  retrieval,
  chosenRepresentation: chosen,
  genreAgreement,
  folderAgreement,
  seeds: seeds.length,
  seedsWithAnyGenreMatchInBaseline: sheet.filter(row => row.genreMatches > 0).length,
  meanListOverlap: mean(sheet.map(row => row.overlap)),
}
await writeFile(join(OUT_DIR, 'evaluation.json'), JSON.stringify({ summary, sheet, traits }, undefined, 2))

// --no-page leaves an already judged sheet alone.
if (!process.argv.includes('--no-page')) {
  console.log(await writePage('blind-judging.html', 'blind-judging.html', {
    store: 'kept-b0-blind-sheet',
    lede: 'One was built from how the music sounds, the other from tags.',
    names: ['sound', 'tags'],
    passSeeds: PASS_SEEDS,
    sheet: sheet.map(({ seed, x, y, sound }) => ({ seed, x, y, key: Buffer.from(`first=${sound}`).toString('base64') })),
    traits,
  }))
}
console.log(JSON.stringify(summary, undefined, 2))
