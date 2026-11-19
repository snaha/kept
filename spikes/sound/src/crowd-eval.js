// Scores sound, hybrid, same-folder and random neighbour lists against crowdsourced references fetched by
// crowd-fetch.js, over every album with a usable reference. No weight is tuned here. Prints numbers only.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dot, loadLibrary, normalise, OUT_DIR } from './library.js'
import { baselineAlbums, estimateTraits, LIST_SIZE, nearestAlbums, withFolderBonus } from './lists.js'

const BOOTSTRAPS = 2000
const SEED = 20261120
const PERCENT = 100
const LOW_QUANTILE = 0.025
const HIGH_QUANTILE = 0.975
const MIN_GROUP = 3

// Keyword groups for the trait check; a tag is matched as a substring of an MB genre or tag name.
const TRAIT_KEYWORDS = {
  acoustic: { positive: ['acoustic', 'folk', 'classical', 'orchestral', 'piano', 'singer-songwriter', 'opera', 'chamber', 'baroque', 'concerto', 'sonata'], negative: ['electronic', 'techno', 'house', 'trance', 'synth', 'edm', 'idm', 'electro', 'industrial', 'dubstep'] },
  vocal: { positive: ['pop', 'hip hop', 'rap', 'soul', 'r&b', 'singer-songwriter', 'opera', 'choral', 'mass'], negative: ['instrumental', 'ambient', 'post-rock', 'classical', 'concerto', 'sonata', 'orchestral', 'piano'] },
  energy: { positive: ['metal', 'punk', 'hardcore', 'techno', 'trance', 'drum and bass', 'hard rock', 'dance', 'grunge'], negative: ['ambient', 'classical', 'folk', 'new age', 'downtempo', 'lullaby', 'sleep', 'piano', 'baroque'] },
}

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
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const percent = value => (value * PERCENT).toFixed(1)

const reference = JSON.parse(await readFile(join(OUT_DIR, 'crowd', 'reference.json'), 'utf8'))
const lastfm = JSON.parse(await readFile(join(OUT_DIR, 'crowd', 'lastfm.json'), 'utf8'))
const round2 = JSON.parse(await readFile(join(OUT_DIR, 'round2.json'), 'utf8'))
const { albums, albumVectors } = await loadLibrary()
const { representation, weight } = round2.summary.chosen
const albumFolders = albums.map(album => album.folder)
const sound = albumVectors[representation]
const hybrid = withFolderBonus(sound, albumFolders, weight)

// Reference (a): crowd-similar artists, symmetric, matched by MBID.
const mbidOf = albums.map(album => reference.artists[album.artistKey]?.mbid)
const similarSets = albums.map(album => new Set((reference.artists[album.artistKey]?.similar ?? []).map(row => row.mbid)))
const similar = (i, j) => Boolean(mbidOf[i]) && Boolean(mbidOf[j]) && (similarSets[i].has(mbidOf[j]) || similarSets[j].has(mbidOf[i]))
// Reference (b): a shared MB genre, from the artist's and the release group's genres.
const genreSets = albums.map(album => new Set([...(reference.artists[album.artistKey]?.genres ?? []), ...(reference.releaseGroups[album.key]?.genres ?? [])].map(genre => genre.name)))
const genre = (i, j) => [...genreSets[i]].some(name => genreSets[j].has(name))

// Reference (c): Last.fm similar artists, symmetric, matched by normalised name.
const lastfmSimilar = albums.map(album => new Set((lastfm.artists[album.artistKey]?.similar ?? []).map(row => normalise(row.name))))
const lastfmRelated = (i, j) => lastfmSimilar[i].has(albums[j].artistKey) || lastfmSimilar[j].has(albums[i].artistKey)

const candidates = i => albums.map((_, j) => j).filter(j => j !== i && albums[j].artistKey !== albums[i].artistKey)
const references = { 'ListenBrainz similar artists': similar, 'MB shared genre': genre, 'Last.fm similar artists': lastfmRelated }
const systems = {
  [`sound (${representation})`]: i => nearestAlbums(albums, sound, i),
  'sound (openl3 only)': i => nearestAlbums(albums, albumVectors.openl3, i),
  [`hybrid (w ${weight})`]: i => nearestAlbums(albums, hybrid, i),
  'same folder': i => baselineAlbums(albums, i),
}

const report = { coverage: { albums: albums.length }, references: {} }
const random = mulberry32(SEED)
for (const [name, related] of Object.entries(references)) {
  // Covered: at least one other-artist album is relevant, so precision can be above zero.
  const covered = albums.map((_, i) => i).filter(i => candidates(i).some(j => related(i, j)))
  const precision = {}
  for (const [system, list] of Object.entries(systems)) precision[system] = covered.map(i => list(i).filter(j => related(i, j)).length / LIST_SIZE)
  precision.random = covered.map(i => candidates(i).filter(j => related(i, j)).length / candidates(i).length)
  const rows = {}
  for (const [system, values] of Object.entries(precision)) {
    const samples = []
    for (let n = 0; n < BOOTSTRAPS; n++) {
      const picks = covered.map(() => Math.floor(random() * covered.length))
      samples.push({ p: mean(picks.map(k => values[k])), lift: mean(picks.map(k => values[k])) / mean(picks.map(k => precision.random[k])) })
    }
    const p = samples.map(sample => sample.p).sort((a, b) => a - b)
    const lift = samples.map(sample => sample.lift).sort((a, b) => a - b)
    rows[system] = { precisionAt5: percent(mean(values)), ci: [percent(quantile(p, LOW_QUANTILE)), percent(quantile(p, HIGH_QUANTILE))], lift: (mean(values) / mean(precision.random)).toFixed(2), liftCi: [quantile(lift, LOW_QUANTILE).toFixed(2), quantile(lift, HIGH_QUANTILE).toFixed(2)] }
  }
  const pairs = covered.reduce((sum, i) => sum + candidates(i).filter(j => related(i, j)).length, 0)
  report.references[name] = { coveredAlbums: covered.length, meanRelevantPerSeed: (pairs / covered.length).toFixed(1), rows }
}
report.coverage.artistsWithMbid = new Set(mbidOf.filter(Boolean)).size
report.coverage.albumsWithSimilarList = albums.filter((_, i) => similarSets[i].size).length
report.coverage.albumsWithGenre = genreSets.filter(set => set.size).length

// Traits: Last.fm tags (artist and album, count at least TAG_MIN) name an axis keyword or its opposite.
const TAG_MIN = 15
const RIDGE = 1
const lastfmTags = albums.map(album => [...(lastfm.artists[album.artistKey]?.tags ?? []), ...(lastfm.albums[album.key]?.tags ?? [])].filter(tag => tag.count >= TAG_MIN).map(tag => tag.name))
const has = (i, keywords) => lastfmTags[i].some(word => keywords.some(keyword => word.includes(keyword)))
const estimates = estimateTraits(albums)
function auc(scores, labels) {
  let wins = 0
  let pairs = 0
  for (const [p, lp] of labels.entries()) {
    if (lp <= 0) continue
    for (const [n, ln] of labels.entries()) {
      if (ln > 0) continue
      pairs++
      wins += scores[p] > scores[n] ? 1 : scores[p] === scores[n] ? 0.5 : 0
    }
  }
  return wins / pairs
}
function solve(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])
  for (let c = 0; c < n; c++) {
    const pivot = a.slice(c).reduce((best, row, k) => (Math.abs(row[c]) > Math.abs(a[c + best][c]) ? k : best), 0) + c
    ;[a[c], a[pivot]] = [a[pivot], a[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const factor = a[r][c] / a[c][c]
      for (let k = c; k <= n; k++) a[r][k] -= factor * a[c][k]
    }
  }
  return a.map((row, i) => row[n] / row[i])
}
// Kernel ridge on the album vectors, leaving out every album of the held-out artist.
function leaveArtistOut(indexes, labels, vectors) {
  return indexes.map(i => {
    const train = indexes.map((_, k) => k).filter(k => albums[indexes[k]].artistKey !== albums[i].artistKey)
    const gram = train.map(a => train.map(b => dot(vectors[indexes[a]], vectors[indexes[b]]) + (a === b ? RIDGE : 0)))
    const weights = solve(gram, train.map(k => labels[k]))
    return train.reduce((sum, k, t) => sum + weights[t] * dot(vectors[i], vectors[indexes[k]]), 0)
  })
}
const AXES = {
  acoustic: { positive: ['acoustic', 'folk', 'singer-songwriter', 'classical', 'piano', 'unplugged'], negative: ['electronic', 'electronica', 'techno', 'house', 'synth', 'industrial', 'idm', 'trance'] },
  vocal: { positive: ['vocalist', 'singer-songwriter', 'a cappella', 'vocal', 'pop', 'rap', 'hip-hop', 'opera'], negative: ['instrumental', 'ambient', 'post-rock', 'soundtrack', 'classical', 'piano'] },
  energy: { positive: ['energetic', 'metal', 'punk', 'hardcore', 'dance', 'party', 'upbeat'], negative: ['chill', 'calm', 'relaxing', 'mellow', 'ambient', 'sleep', 'lullaby', 'soft', 'slow'] },
}
report.traits = {}
for (const [axis, { positive, negative }] of Object.entries(AXES)) {
  const indexes = albums.map((_, i) => i).filter(i => has(i, positive) !== has(i, negative))
  const labels = indexes.map(i => (has(i, positive) ? 1 : -1))
  const positives = labels.filter(label => label > 0).length
  if (Math.min(positives, labels.length - positives) < MIN_GROUP) {
    report.traits[axis] = { positives, negatives: labels.length - positives, auc: 'too few' }
    continue
  }
  const heuristic = indexes.map(i => estimates[i][axis])
  const model = Object.fromEntries(['both', 'openl3', 'dsp'].map(name => [name, leaveArtistOut(indexes, labels, albumVectors[name])]))
  const interval = scores => {
    const samples = []
    for (let n = 0; n < BOOTSTRAPS; n++) {
      const picks = labels.map(() => Math.floor(random() * labels.length))
      const drawn = picks.map(k => labels[k])
      if (drawn.some(label => label > 0) && drawn.some(label => label < 0)) samples.push(auc(picks.map(k => scores[k]), drawn))
    }
    samples.sort((a, b) => a - b)
    return `${auc(scores, labels).toFixed(2)} (${quantile(samples, LOW_QUANTILE).toFixed(2)}-${quantile(samples, HIGH_QUANTILE).toFixed(2)})`
  }
  report.traits[axis] = { positives, negatives: labels.length - positives, heuristicAuc: interval(heuristic), modelAuc: Object.fromEntries(Object.entries(model).map(([name, scores]) => [name, interval(scores)])) }
}
console.log(JSON.stringify(report))
