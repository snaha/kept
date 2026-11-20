import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { byScore, cosine } from '../shared/tool-support.js'
import { indicatesUnavailableInput } from './analysis/decode.js'
import { estimateEnergy } from './estimated-traits.js'

// features.sqlite: what the analyser computed. Everything here can be computed again from the audio,
// so the file is disposable: a file that cannot be read is replaced, and deleting it only means the
// library is analysed again. Rows are keyed by asset, method and method version, so a new method or
// version never reads the numbers of an old one.
//   track_features     the embedding and the signal-processing vector of one asset (Float32 blobs)
//   album_features     their means over the tracks of an album anchor
//   analysis_outcomes  how the last analysis of an asset ended: done, refused, unreadable
//   methods            the configuration and licence each method version was computed with

export const FEATURE_SCHEMA_VERSION = 1
export const FEATURE_METHODS = Object.freeze([
  'registerMethod', 'putTrackFeatures', 'recordOutcome', 'pendingAssets', 'assetOutcomes', 'getTrackFeatures', 'getAlbumFeatures', 'listOutcomes',
  'aggregateAlbums', 'pruneMethods', 'featureCounts', 'albumEmbeddings', 'trackEmbeddings', 'estimateAlbumEnergy', 'similarAlbums',
])
// done and unreadable are facts about the audio. refused depends on a policy the user can change, so it is asked again.
export const FINAL_OUTCOMES = Object.freeze(['done', 'unreadable'])
export const OUTCOMES = Object.freeze([...FINAL_OUTCOMES, 'refused'])
const MAX_BATCH = 500
const SIMILAR_ALBUM_LIMIT = 5

const SCHEMA = `
  CREATE TABLE methods(method TEXT NOT NULL, method_version INTEGER NOT NULL, config TEXT NOT NULL, licence TEXT NOT NULL,
    evidence_class TEXT NOT NULL, PRIMARY KEY(method, method_version)) STRICT, WITHOUT ROWID;
  CREATE TABLE track_features(asset_id TEXT NOT NULL, method TEXT NOT NULL, method_version INTEGER NOT NULL, embedding BLOB NOT NULL,
    dsp BLOB NOT NULL, windows INTEGER NOT NULL, analysed_at INTEGER NOT NULL, PRIMARY KEY(asset_id, method, method_version)) STRICT, WITHOUT ROWID;
  CREATE TABLE album_features(album_id TEXT NOT NULL, method TEXT NOT NULL, method_version INTEGER NOT NULL, embedding BLOB NOT NULL,
    dsp BLOB NOT NULL, tracks INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(album_id, method, method_version)) STRICT, WITHOUT ROWID;
  CREATE TABLE analysis_outcomes(asset_id TEXT NOT NULL, method TEXT NOT NULL, method_version INTEGER NOT NULL, outcome TEXT NOT NULL,
    reason TEXT, at INTEGER NOT NULL, PRIMARY KEY(asset_id, method, method_version)) STRICT, WITHOUT ROWID;
`

// node:sqlite binds SQL NULL only from null and reads it back as null.
const SQL_NULL = null
const invalid = detail => new Error(`invalid-request: ${detail}`)
const isText = value => typeof value === 'string' && value.length > 0
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isVector = value => value instanceof Float32Array && value.length > 0
const blobOf = vector => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
const vectorOf = blob => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
const checkKey = request => {
  if (!request || !isText(request.method) || !isCount(request.version)) throw invalid('method')
}

export class FeatureStore {
  // A file from another schema, or one that is damaged, is thrown away: its content is regenerable.
  constructor(file) {
    try { this.open(file) } catch (error) {
      if (file === ':memory:') throw error
      try { this.db?.close() } catch { /* it was never open */ }
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
      this.open(file)
      this.rebuilt = true
    }
  }
  open(file) {
    this.db = new DatabaseSync(file)
    this.statements = new Map()
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get()
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE; ${SCHEMA}; PRAGMA user_version=${FEATURE_SCHEMA_VERSION}; COMMIT;`)
    else if (version !== FEATURE_SCHEMA_VERSION) throw new Error('features.sqlite has another schema')
    // Reads the tables once, so a damaged file fails here and not on the first job.
    this.featureCounts({})
  }
  close() { this.db.close() }
  // The single entry point of the worker thread. Float32Arrays cross as they are.
  call(method, request) {
    if (!FEATURE_METHODS.includes(method)) throw new Error('Unknown feature operation')
    return this[method](request) ?? {}
  }
  statement(sql) {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }
  run(sql, ...values) { return this.statement(sql).run(...values) }
  get(sql, ...values) { return this.statement(sql).get(...values) }
  all(sql, ...values) { return this.statement(sql).all(...values) }
  transaction(body) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // What a method version was computed with, and the licence its features inherit from the model.
  registerMethod(request) {
    checkKey(request)
    if (!isText(request.licence) || !request.config || typeof request.config !== 'object') throw invalid('method')
    this.run(`INSERT INTO methods(method, method_version, config, licence, evidence_class) VALUES(?,?,?,?,'model')
      ON CONFLICT(method, method_version) DO UPDATE SET config=excluded.config, licence=excluded.licence`,
    request.method, request.version, JSON.stringify(request.config), request.licence)
  }

  // Stores the features of one asset and marks its analysis as done.
  putTrackFeatures(request) {
    checkKey(request)
    if (!isText(request.assetId) || !isVector(request.embedding) || !isVector(request.dsp) || !isCount(request.windows) || !isCount(request.at)) throw invalid('track features')
    this.transaction(() => {
      this.run(`INSERT INTO track_features(asset_id, method, method_version, embedding, dsp, windows, analysed_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(asset_id, method, method_version) DO UPDATE SET embedding=excluded.embedding, dsp=excluded.dsp, windows=excluded.windows, analysed_at=excluded.analysed_at`,
      request.assetId, request.method, request.version, blobOf(request.embedding), blobOf(request.dsp), request.windows, request.at)
      this.setOutcome(request, 'done', undefined)
    })
  }
  setOutcome({ assetId, method, version, at }, outcome, reason) {
    this.run(`INSERT INTO analysis_outcomes(asset_id, method, method_version, outcome, reason, at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(asset_id, method, method_version) DO UPDATE SET outcome=excluded.outcome, reason=excluded.reason, at=excluded.at`,
    assetId, method, version, outcome, reason ?? SQL_NULL, at)
  }
  // refused or unreadable: there are no features, and this is why. Features an earlier analysis stored are removed
  // when the asset is refused: a source that forbids analysis keeps none.
  recordOutcome(request) {
    checkKey(request)
    if (!isText(request.assetId) || !['refused', 'unreadable'].includes(request.outcome) || !isCount(request.at)) throw invalid('outcome')
    const stored = this.get('SELECT outcome, reason FROM analysis_outcomes WHERE asset_id=? AND method=? AND method_version=?', request.assetId, request.method, request.version)
    if (stored?.outcome === request.outcome && (stored.reason ?? undefined) === request.reason) return { changed: false }
    return this.transaction(() => {
      this.run('DELETE FROM track_features WHERE asset_id=? AND method=? AND method_version=?', request.assetId, request.method, request.version)
      this.setOutcome(request, request.outcome, request.reason)
      return { changed: true }
    })
  }
  // Of the given assets, the ones this method version still has to analyse.
  pendingAssets(request) {
    return { assetIds: this.assetOutcomes(request).assets.filter(asset => asset.outcome === undefined).map(asset => asset.assetId) }
  }
  assetOutcomes(request) {
    checkKey(request)
    if (!Array.isArray(request.assetIds) || request.assetIds.length > MAX_BATCH || !request.assetIds.every(isText)) throw invalid('assets')
    const settled = FINAL_OUTCOMES.map(() => '?').join(',')
    return {
      assets: request.assetIds.map(assetId => {
        const final = this.get(`SELECT outcome, reason FROM analysis_outcomes WHERE asset_id=? AND method=? AND method_version=? AND outcome IN (${settled})`,
          assetId, request.method, request.version, ...FINAL_OUTCOMES)
        // Older builds recorded FFmpeg's unavailable-input errors as unreadable.
        const outcome = final?.outcome === 'unreadable' && indicatesUnavailableInput(final.reason) ? undefined : final?.outcome
        return { assetId, outcome }
      }),
    }
  }
  getTrackFeatures(request) {
    checkKey(request)
    const row = this.get('SELECT * FROM track_features WHERE asset_id=? AND method=? AND method_version=?', request.assetId, request.method, request.version)
    return { features: row && { assetId: row.asset_id, method: row.method, version: row.method_version, embedding: vectorOf(row.embedding), dsp: vectorOf(row.dsp), windows: row.windows, analysedAt: row.analysed_at } }
  }
  getAlbumFeatures(request) {
    checkKey(request)
    const row = this.get('SELECT * FROM album_features WHERE album_id=? AND method=? AND method_version=?', request.albumId, request.method, request.version)
    return { features: row && { albumId: row.album_id, method: row.method, version: row.method_version, embedding: vectorOf(row.embedding), dsp: vectorOf(row.dsp), tracks: row.tracks, updatedAt: row.updated_at } }
  }
  listOutcomes(request) {
    checkKey(request)
    const rows = request.outcome
      ? this.all('SELECT * FROM analysis_outcomes WHERE method=? AND method_version=? AND outcome=? ORDER BY asset_id', request.method, request.version, request.outcome)
      : this.all('SELECT * FROM analysis_outcomes WHERE method=? AND method_version=? ORDER BY asset_id', request.method, request.version)
    return { outcomes: rows.map(row => ({ assetId: row.asset_id, outcome: row.outcome, reason: row.reason ?? undefined, at: row.at })) }
  }

  // The album-level aggregate: the mean embedding and the mean signal-processing vector of the album's
  // analysed tracks. albums: [{ albumId, assetIds }] as the catalog has them now. An album with no
  // analysed track has no row. With complete, albums that are not listed lose theirs.
  aggregateAlbums(request) {
    checkKey(request)
    if (!Array.isArray(request.albums) || !isCount(request.at)) throw invalid('albums')
    for (const album of request.albums) if (!album || !isText(album.albumId) || !Array.isArray(album.assetIds) || !album.assetIds.every(isText)) throw invalid('album')
    const { method, version } = request
    const { written, removed } = this.transaction(() => {
      let written = 0
      let removed = 0
      const remove = albumId => {
        removed += Number(this.run('DELETE FROM album_features WHERE album_id=? AND method=? AND method_version=?', albumId, method, version).changes)
      }
      for (const { albumId, assetIds } of request.albums) {
        const rows = assetIds.map(assetId => this.get('SELECT embedding, dsp FROM track_features WHERE asset_id=? AND method=? AND method_version=?', assetId, method, version)).filter(Boolean)
        if (!rows.length) {
          remove(albumId)
          continue
        }
        const mean = column => {
          const vectors = rows.map(row => vectorOf(row[column]))
          const sum = new Float64Array(vectors[0].length)
          for (const vector of vectors) for (let i = 0; i < sum.length; i++) sum[i] += vector[i]
          return blobOf(Float32Array.from(sum, value => value / vectors.length))
        }
        const embedding = mean('embedding'), dsp = mean('dsp')
        const stored = this.get('SELECT embedding, dsp, tracks FROM album_features WHERE album_id=? AND method=? AND method_version=?', albumId, method, version)
        if (stored && stored.tracks === rows.length && Buffer.from(stored.embedding).equals(Buffer.from(embedding)) && Buffer.from(stored.dsp).equals(Buffer.from(dsp))) continue
        this.run(`INSERT INTO album_features(album_id, method, method_version, embedding, dsp, tracks, updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(album_id, method, method_version) DO UPDATE SET embedding=excluded.embedding, dsp=excluded.dsp, tracks=excluded.tracks, updated_at=excluded.updated_at`,
        albumId, method, version, embedding, dsp, rows.length, request.at)
        written++
      }
      if (request.complete) {
        const listed = new Set(request.albums.map(album => album.albumId))
        for (const { album_id: albumId } of this.all('SELECT album_id FROM album_features WHERE method=? AND method_version=?', method, version)) {
          if (!listed.has(albumId)) remove(albumId)
        }
      }
      return { written, removed }
    })
    if (written || removed) this.energyCache = undefined
    return { written }
  }

  // The embeddings of the given albums or assets under one method version, as { id: Float32Array } (ids without features are absent).
  albumEmbeddings(request) { return { vectors: this.embeddings('album_features', 'album_id', request, request.albumIds) } }
  trackEmbeddings(request) { return { vectors: this.embeddings('track_features', 'asset_id', request, request.assetIds) } }

  // Rank where the vectors live. The catalog supplies eligible IDs, and only the matches go back.
  similarAlbums({ albumId, candidateIds, ...key }) {
    const seed = this.albumEmbeddings({ ...key, albumIds: [albumId] }).vectors[albumId]
    if (!seed) return { analysed: false, albumIds: [] }
    const { vectors } = this.albumEmbeddings({ ...key, albumIds: candidateIds })
    const ranked = Object.entries(vectors).flatMap(([id, vector]) => {
      const similarity = cosine(seed, vector)
      return similarity === undefined ? [] : [{ id, score: Math.max(0, similarity) }]
    })
    return { analysed: true, albumIds: ranked.sort(byScore).slice(0, SIMILAR_ALBUM_LIMIT).map(({ id }) => id) }
  }

  embeddings(table, column, request, ids) {
    checkKey(request)
    if (!Array.isArray(ids) || !ids.every(isText)) throw invalid('ids')
    const vectors = {}
    for (let from = 0; from < ids.length; from += MAX_BATCH) {
      const chunk = ids.slice(from, from + MAX_BATCH)
      const rows = this.all(`SELECT ${column} AS id, embedding FROM ${table} WHERE method=? AND method_version=? AND ${column} IN (${chunk.map(() => '?').join(',')})`, request.method, request.version, ...chunk)
      for (const row of rows) vectors[row.id] = vectorOf(row.embedding)
    }
    return vectors
  }

  // Rank on the feature worker, reusing the result until committed album rows change.
  estimateAlbumEnergy(request) {
    checkKey(request)
    const { method, version } = request
    if (this.energyCache?.method === method && this.energyCache.version === version) return { albums: this.energyCache.albums }
    const rows = this.all('SELECT album_id, dsp FROM album_features WHERE method=? AND method_version=?', method, version)
    const albums = estimateEnergy(Object.fromEntries(rows.map(row => [row.album_id, vectorOf(row.dsp)])))
    this.energyCache = { method, version, albums }
    return { albums }
  }

  // Forgets every method version but the ones to keep: [{ method, version }].
  pruneMethods(request) {
    if (!Array.isArray(request?.keep)) throw invalid('keep')
    for (const key of request.keep) checkKey(key)
    const kept = new Set(request.keep.map(key => `${key.method}@${key.version}`))
    const { removed } = this.transaction(() => {
      let removed = 0
      for (const table of ['track_features', 'album_features', 'analysis_outcomes', 'methods']) {
        for (const row of this.all(`SELECT DISTINCT method, method_version FROM ${table}`)) {
          if (!kept.has(`${row.method}@${row.method_version}`)) removed += Number(this.run(`DELETE FROM ${table} WHERE method=? AND method_version=?`, row.method, row.method_version).changes)
        }
      }
      return { removed }
    })
    if (removed) this.energyCache = undefined
    return { removed }
  }
  featureCounts(request) {
    const where = request?.method === undefined ? ['', []] : [' WHERE method=? AND method_version=?', [request.method, request.version]]
    const count = table => this.get(`SELECT count(*) AS n FROM ${table}${where[0]}`, ...where[1]).n
    const outcomes = Object.fromEntries(this.all(`SELECT outcome, count(*) AS n FROM analysis_outcomes${where[0]} GROUP BY outcome`, ...where[1]).map(row => [row.outcome, row.n]))
    return { tracks: count('track_features'), albums: count('album_features'), outcomes }
  }
}
