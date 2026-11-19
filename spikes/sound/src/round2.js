// Round 2: a hybrid of sound and the user's folders against the same-folder baseline on 20 new
// seeds, and a check sheet for the estimated traits. The folder weight is tuned on proxy 1 only.
// Prints numbers only; album names stay in out/.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadLibrary, OUT_DIR } from './library.js'
import { albumLabel, baselineAlbums, blindRows, estimateTraits, nearestAlbums, pickSeeds, withFolderBonus, writePage } from './lists.js'
import { trackRetrieval } from './retrieval.js'

const SEED_COUNT = 20
const PASS_SEEDS = 13
const TRAIT_PASS = 14
const FOLDER_WEIGHTS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1]
const REPRESENTATIONS = ['openl3', 'both']
const BAND_WIDTH = 20
const TRAIT_WORDS = {
  energy: ['very calm', 'calm', 'moderate', 'lively', 'very intense'],
  acoustic: ['fully electronic', 'mostly electronic', 'mixed', 'mostly acoustic', 'fully acoustic'],
  vocal: ['instrumental', 'mostly instrumental', 'some vocals', 'mostly vocals', 'vocals throughout'],
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)

const { albums, tracks, trackVectors, albumVectors } = await loadLibrary()
const albumFolders = albums.map(album => album.folder)
const trackFolders = tracks.map(track => albums[track.albumIndex].folder)

// Tune on proxy 1: the bonus applies between tracks exactly as it will between albums.
const tuning = []
for (const representation of REPRESENTATIONS) {
  for (const weight of FOLDER_WEIGHTS) {
    const result = trackRetrieval(albums, tracks, withFolderBonus(trackVectors[representation], trackFolders, weight))
    tuning.push({ representation, weight, sameAlbumTop1: result.sameAlbumTop1, sameAlbumInTop5: result.sameAlbumInTop5, sameArtistOtherAlbumTop1: result.sameArtistOtherAlbumTop1 })
  }
}
// Best proxy 1 value; ties go to the smallest weight, which leaves the most room for sound.
const chosen = tuning.reduce((best, row) => (row.sameAlbumTop1 > best.sameAlbumTop1 ? row : best))
const hybridVectors = withFolderBonus(albumVectors[chosen.representation], albumFolders, chosen.weight)

const firstRound = pickSeeds(albums, SEED_COUNT)
const seeds = pickSeeds(albums, SEED_COUNT, new Set(firstRound), new Set(firstRound.map(index => albums[index].artistKey)), 'round2:')
const rows = blindRows(albums, seeds, ['hybrid', 'folder'], index => nearestAlbums(albums, hybridVectors, index), index => baselineAlbums(albums, index))
const sheetPage = await writePage('blind-judging.html', 'blind-judging-2.html', {
  store: 'kept-b0-blind-sheet-2',
  lede: 'One blends how the music sounds with the folders you keep it in, the other is picked from the same folder.',
  names: ['hybrid', 'folder'],
  passSeeds: PASS_SEEDS,
  sheet: rows.map(({ seed, x, y, hybrid }) => ({ seed, x, y, key: Buffer.from(`first=${hybrid}`).toString('base64') })),
})

const traits = estimateTraits(albums)
const traitAlbums = pickSeeds(albums, SEED_COUNT, new Set(), new Set(), 'traits:')
const word = (axis, value) => TRAIT_WORDS[axis][Math.min(TRAIT_WORDS[axis].length - 1, Math.floor(value / BAND_WIDTH))]
const traitRows = traitAlbums.map(index => ({ album: albumLabel(albums[index]), ...Object.fromEntries(Object.keys(TRAIT_WORDS).map(axis => [axis, word(axis, traits[index][axis])])) }))
const traitsPage = await writePage('traits-check.html', 'traits-check.html', { store: 'kept-b0-traits-check', pass: TRAIT_PASS, scales: TRAIT_WORDS, rows: traitRows })

const summary = {
  tuning,
  chosen,
  seeds: seeds.length,
  seedFolders: Object.fromEntries([...new Set(albumFolders)].map(folder => [folder, seeds.filter(index => albums[index].folder === folder).length])),
  seedsSharedWithRoundOne: seeds.filter(index => firstRound.includes(index)).length,
  otherFolderAlbumsPerHybridList: mean(rows.map((row, n) => row.first.filter(j => albums[j].folder !== albums[seeds[n]].folder).length)),
  hybridAlbumsNotInSoundList: mean(rows.map((row, n) => row.first.filter(j => !nearestAlbums(albums, albumVectors[chosen.representation], seeds[n]).includes(j)).length)),
  meanListOverlap: mean(rows.map(row => row.overlap)),
  traitAlbums: traitRows.length,
  traitWordCounts: Object.fromEntries(Object.keys(TRAIT_WORDS).map(axis => [axis, TRAIT_WORDS[axis].map(name => traitRows.filter(row => row[axis] === name).length)])),
}
await writeFile(join(OUT_DIR, 'round2.json'), JSON.stringify({ summary, sheet: rows.map(({ first, second, ...row }) => row), traitRows }, undefined, 2))
console.log(JSON.stringify(summary, undefined, 2))
console.log(sheetPage)
console.log(traitsPage)
