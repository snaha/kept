// Mood-from-own-tags test: can a simple model predict the user's hand-set Dig traits from sound?
// Leave-one-out error of ridge and kNN against predicting the mean.
// Usage: node src/mood.js [traits.json]   traits.json maps a normalised album name to { mood, energy, acoustic, vocal }
//        node src/mood.js --self-check    proves the harness finds a planted signal and rejects noise
import { readFile } from 'node:fs/promises'
import { dot, featureRow, FEATURE_NAMES, loadLibrary } from './library.js'

const AXES = ['mood', 'energy', 'acoustic', 'vocal']
const MIN_TAGGED = 30
const LEARNABLE_GAIN = 0.15
const RIDGE_LAMBDA = 10
const K_NEIGHBOURS = 5
const SELF_CHECK_NOISE = 10
const SELF_CHECK_SEED = 7
const TRAIT_MAX = 100

const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)

function solve(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])
  for (let column = 0; column < n; column++) {
    let pivot = column
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    const swap = a[column]
    a[column] = a[pivot]
    a[pivot] = swap
    for (let row = column + 1; row < n; row++) {
      const factor = a[row][column] / a[column][column]
      for (let k = column; k <= n; k++) a[row][k] -= factor * a[column][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row--) x[row] = (a[row][n] - a[row].slice(row + 1, n).reduce((sum, value, k) => sum + value * x[row + 1 + k], 0)) / a[row][row]
  return x
}

function ridgePredict(trainX, trainY, testX) {
  const width = trainX[0].length
  const means = Array.from({ length: width }, (_, i) => mean(trainX.map(row => row[i])))
  const stds = Array.from({ length: width }, (_, i) => Math.sqrt(mean(trainX.map(row => (row[i] - means[i]) ** 2))) || 1)
  const scale = row => row.map((value, i) => (value - means[i]) / stds[i])
  const x = trainX.map(scale)
  const offset = mean(trainY)
  const gram = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) => x.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j ? RIDGE_LAMBDA : 0)))
  const weights = solve(gram, Array.from({ length: width }, (_, i) => x.reduce((sum, row, n) => sum + row[i] * (trainY[n] - offset), 0)))
  return offset + scale(testX).reduce((sum, value, i) => sum + value * weights[i], 0)
}

/** Leave-one-out mean absolute error for the mean baseline, ridge on scalar features and kNN on album vectors. */
export function crossValidate(rows, vectors, targets) {
  const errors = { baseline: [], ridge: [], knn: [] }
  for (let i = 0; i < rows.length; i++) {
    const others = rows.map((_, j) => j).filter(j => j !== i)
    const trainY = others.map(j => targets[j])
    const nearest = [...others].sort((a, b) => dot(vectors[i], vectors[b]) - dot(vectors[i], vectors[a])).slice(0, K_NEIGHBOURS)
    errors.baseline.push(Math.abs(mean(trainY) - targets[i]))
    errors.ridge.push(Math.abs(ridgePredict(others.map(j => rows[j]), trainY, rows[i]) - targets[i]))
    errors.knn.push(Math.abs(mean(nearest.map(j => targets[j])) - targets[i]))
  }
  return Object.fromEntries(Object.entries(errors).map(([name, values]) => [name, mean(values)]))
}

function report(axis, result) {
  const best = Math.min(result.ridge, result.knn)
  const gain = 1 - best / result.baseline
  console.log(`${axis.padEnd(9)} baseline MAE ${result.baseline.toFixed(1)}  ridge ${result.ridge.toFixed(1)}  kNN ${result.knn.toFixed(1)}  gain ${(gain * TRAIT_MAX).toFixed(0)}%  ${gain >= LEARNABLE_GAIN ? 'learnable' : 'not learnable'}`)
}

const library = await loadLibrary()
const rows = library.albums.map(album => FEATURE_NAMES.map((_, column) => mean(album.tracks.map(track => featureRow(track.features)[column]))))
const vectors = library.albumVectors.both

if (process.argv.includes('--self-check')) {
  let state = SELF_CHECK_SEED
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const loudness = rows.map(row => row[FEATURE_NAMES.indexOf('loudnessDb')])
  const lo = Math.min(...loudness)
  const hi = Math.max(...loudness)
  report('planted', crossValidate(rows, vectors, loudness.map(value => (TRAIT_MAX * (value - lo)) / (hi - lo) + SELF_CHECK_NOISE * (random() - 0.5))))
  report('noise', crossValidate(rows, vectors, rows.map(() => TRAIT_MAX * random())))
} else {
  const traits = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : {}
  const tagged = library.albums.map((album, index) => ({ index, traits: traits[album.key] })).filter(entry => entry.traits)
  console.log(`hand-tagged albums with analysed audio: ${tagged.length} (minimum ${MIN_TAGGED})`)
  if (tagged.length < MIN_TAGGED) console.log('too few tags: the mood test cannot run')
  else for (const axis of AXES) report(axis, crossValidate(tagged.map(entry => rows[entry.index]), tagged.map(entry => vectors[entry.index]), tagged.map(entry => entry.traits[axis])))
}
