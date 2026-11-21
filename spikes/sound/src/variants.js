// Cost reduction check: proxy 1 and cost for cheaper OpenL3 settings, on the tracks of the main run.
// Needs `analyse.js` runs named m256w6 (--mels 256 --windows 6) and m128w15 (--mels 128 --windows 15
// --keep-windows), plus single-process cost samples named solo-<variant>. Prints numbers only.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { centredUnit, decodeEmbedding, loadLibrary, OUT_DIR } from './library.js'
import { EMBEDDING_SIZE, thin } from './openl3.js'
import { trackRetrieval } from './retrieval.js'

const FULL_WINDOWS = 15
const REDUCED_WINDOWS = 6
const MS_PER_SECOND = 1000
const PERCENT = 100
const COST_RUNS = { 'm256 w15': 'solo', 'm256 w6': 'solo-m256w6', 'm128 w15': 'solo-m128w15', 'm128 w6': 'solo-m128w6', 'm256 w15 2 threads': 'solo-m256w15t2', 'm128 w6 2 threads': 'solo-m128w6t2' }

const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
async function readRun(prefix) {
  const names = (await readdir(OUT_DIR)).filter(name => new RegExp(`^${prefix}-\\d+\\.jsonl$`).test(name))
  const rows = []
  for (const name of names) for (const line of (await readFile(join(OUT_DIR, name), 'utf8')).split('\n')) if (line) rows.push(JSON.parse(line))
  return rows
}
function meanOf(windows) {
  const result = new Float32Array(EMBEDDING_SIZE)
  for (const window of windows) for (let i = 0; i < EMBEDDING_SIZE; i++) result[i] += window[i] / windows.length
  return result
}

const { albums, tracks, trackVectors } = await loadLibrary()
const byPath = async prefix => new Map((await readRun(prefix)).map(row => [row.path, row]))
const m256w6 = await byPath('m256w6')
const m128w15 = await byPath('m128w15')
const missing = tracks.filter(track => !m256w6.has(track.path) || !m128w15.has(track.path)).length
if (missing) throw new Error(`${missing} tracks of the main run are missing from the variant runs`)

const variants = {
  'm256 w15': trackVectors.openl3,
  'm256 w6': centredUnit(tracks.map(track => decodeEmbedding(m256w6.get(track.path).embedding))),
  'm128 w15': centredUnit(tracks.map(track => decodeEmbedding(m128w15.get(track.path).embedding))),
  'm128 w6': centredUnit(tracks.map(track => meanOf(thin(m128w15.get(track.path).windowEmbeddings.map(decodeEmbedding), REDUCED_WINDOWS / FULL_WINDOWS)))),
}
console.log(`tracks ${tracks.length}, albums ${albums.length}`)
for (const [name, vectors] of Object.entries(variants)) {
  const result = trackRetrieval(albums, tracks, vectors)
  console.log(`${name.padEnd(9)} same album top-1 ${(result.sameAlbumTop1 * PERCENT).toFixed(1)}%  lift ${result.lift.toFixed(1)}x  same artist, own album removed ${(result.sameArtistOtherAlbumTop1 * PERCENT).toFixed(1)}%`)
}
for (const [name, prefix] of Object.entries(COST_RUNS)) {
  const rows = await readRun(prefix)
  if (!rows.length) continue
  const cost = JSON.parse(await readFile(join(OUT_DIR, `${prefix}-5.cost.json`), 'utf8'))
  const seconds = key => mean(rows.map(row => row.timing[key])) / MS_PER_SECOND
  const openl3 = seconds('melMs') + seconds('inferMs')
  console.log(`${name.padEnd(19)} n ${rows.length}  decode ${(seconds('probeMs') + seconds('decodeMs')).toFixed(2)} s  openl3 ${openl3.toFixed(2)} s  windows ${mean(rows.map(row => row.timing.windows)).toFixed(1)}  peak RSS ${cost.peakRssMb.toFixed(0)} MB`)
}
