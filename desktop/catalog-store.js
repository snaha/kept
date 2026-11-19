import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { JOB_METHODS, JOB_MIGRATION, JobQueue } from './job-queue.js'
import { RECONSTRUCT_METHODS, RECONSTRUCT_MIGRATION, ReconstructStore } from './reconstruct-store.js'
import { MAX_PLAYBACK_LINKS } from '../shared/catalog-bridge.js'
import {
  APPROVING_CLASSES, CONSENT_KEYS, TRAIT_FIELD_PREFIX, TRAIT_NAMES, USER_SOURCE, USER_SOURCE_ID, catalogError, isCatalogId,
  isTraitValue, propagateEvidenceClass, propagateLicence, sourceConsentState, traitOfField, validateSource,
} from '../shared/catalog-rules.js'
import { createLedger, trackNumbering } from '../shared/catalog-ledger.js'
import {
  CATALOG_SORTS, MAX_REPORTED_DIFFERENCES, MAX_TAG_LENGTH, PROJECTION_FORMAT, albumDetail, albumSummary, ftsQuery, isScanTags, normalSearch, projectAlbum, searchRows,
  sortKey, tagObservations,
} from '../shared/catalog-projection.js'

// The identity spine on SQLite (library.sqlite): user data that cannot be rebuilt.
// Every call runs on the catalog worker. Behaviour is fixed by shared/catalog-contract-suite.js.

export const DEFAULT_ALBUM_PAGE = 50
export const MAX_ALBUM_PAGE = 500
export const CATALOG_METHODS = Object.freeze([
  'registerSource', 'listSources', 'ingestScan', 'linkProvider', 'resolveProviderId', 'recordObservation',
  'recordUserDecision', 'getAlbum', 'getAsset', 'listAlbums', 'getConsent', 'setConsent',
  'commitChangeSet', 'undoChangeSet', 'undoField', 'getChangeSet', 'listChangeSets',
  'listCatalogAlbums', 'getCatalogAlbum', 'searchCatalog', 'getPlaybackLinks', 'rebuildProjections', 'verifyProjections',
])
// Not part of CatalogService: the scanner's memory of which file had which payload hash.
export const STORE_METHODS = Object.freeze([...CATALOG_METHODS, 'fileHashes', 'storeFileHashes', ...JOB_METHODS, ...RECONSTRUCT_METHODS])

// Entry n takes the schema from version n to n + 1. Never edit a released entry: add one.
const MIGRATIONS = [`
  CREATE TABLE sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, evidence_class TEXT NOT NULL, licence TEXT NOT NULL,
    analysis_allowed INTEGER NOT NULL, network TEXT NOT NULL, consent TEXT) STRICT;
  CREATE TABLE assets(id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, size INTEGER NOT NULL, duration REAL, UNIQUE(content_hash, size)) STRICT;
  CREATE TABLE locations(source_id TEXT NOT NULL REFERENCES sources(id), path TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
    availability TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(source_id, path)) STRICT;
  CREATE INDEX locations_asset ON locations(asset_id);
  CREATE TABLE albums(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
  CREATE TABLE album_tracks(asset_id TEXT PRIMARY KEY REFERENCES assets(id), album_id TEXT NOT NULL REFERENCES albums(id),
    disc INTEGER, track INTEGER, path TEXT NOT NULL) STRICT;
  CREATE INDEX album_tracks_album ON album_tracks(album_id);
  CREATE TABLE provider_links(source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL, external_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, evidence_class TEXT NOT NULL, linked_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, kind, external_id)) STRICT;
  CREATE INDEX provider_links_subject ON provider_links(subject_kind, subject_id);
  CREATE TABLE observations(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
    subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, observed_at INTEGER NOT NULL,
    evidence_class TEXT NOT NULL, licence TEXT NOT NULL, derived_from TEXT,
    UNIQUE(source_id, subject_kind, subject_id, field, observed_at)) STRICT;
  CREATE INDEX observations_subject ON observations(subject_kind, subject_id);
  CREATE TABLE user_decisions(id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    trait TEXT NOT NULL, value TEXT, decided_at INTEGER NOT NULL, UNIQUE(kind, subject_kind, subject_id, trait)) STRICT;
  CREATE TABLE file_hashes(source_id TEXT NOT NULL REFERENCES sources(id), path TEXT NOT NULL, file_size INTEGER NOT NULL,
    modified_ms REAL NOT NULL, content_hash TEXT NOT NULL, payload_size INTEGER NOT NULL, PRIMARY KEY(source_id, path)) STRICT;
`, `
  CREATE TABLE field_overrides(subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, field TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(subject_kind, subject_id, field)) STRICT;
  CREATE TABLE field_locks(subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, field TEXT NOT NULL, change_set_id TEXT NOT NULL,
    PRIMARY KEY(subject_kind, subject_id, field)) STRICT;
  CREATE TABLE change_sets(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, committed_at INTEGER NOT NULL,
    body TEXT NOT NULL) STRICT;
  CREATE TABLE change_keys(key TEXT NOT NULL, seq INTEGER NOT NULL REFERENCES change_sets(seq), PRIMARY KEY(key, seq)) STRICT, WITHOUT ROWID;
  CREATE TABLE change_suppressions(author TEXT NOT NULL, fingerprint TEXT NOT NULL, change_set_id TEXT NOT NULL, PRIMARY KEY(author, fingerprint)) STRICT;
  CREATE TABLE catalog_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
  CREATE TABLE album_projection(album_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, version INTEGER NOT NULL, track_count INTEGER NOT NULL,
    sort_artist TEXT NOT NULL, sort_title TEXT NOT NULL, year INTEGER, body TEXT NOT NULL) STRICT;
  CREATE INDEX album_projection_artist ON album_projection(sort_artist, year, sort_title);
  CREATE INDEX album_projection_title ON album_projection(sort_title, sort_artist);
  CREATE TABLE search_rows(row INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, album_id TEXT NOT NULL, artist TEXT NOT NULL,
    sort_title TEXT NOT NULL, sort_artist TEXT NOT NULL) STRICT;
  CREATE INDEX search_rows_album ON search_rows(album_id);
  CREATE VIRTUAL TABLE catalog_fts USING fts5(title, artist, tokenize='unicode61 remove_diacritics 2');
`,
// The persistent job queue (job-queue.js).
JOB_MIGRATION,
// What the reconstruction ladder concluded, and its provider cache (reconstruct-store.js).
RECONSTRUCT_MIGRATION,
`
  ALTER TABLE album_tracks ADD COLUMN scan_numbering INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE locations ADD COLUMN provider_source_id TEXT;
  ALTER TABLE locations ADD COLUMN provider_track_id TEXT;
  ALTER TABLE file_hashes ADD COLUMN file_version TEXT;
  CREATE INDEX search_rows_artist ON search_rows(artist, album_id);
`, `
  ALTER TABLE locations ADD COLUMN legacy_playback INTEGER NOT NULL DEFAULT 0;
  UPDATE locations SET legacy_playback=1 WHERE provider_source_id IS NULL AND provider_track_id IS NULL;
`]
export const CATALOG_SCHEMA_VERSION = MIGRATIONS.length

const SUBJECT_KINDS = ['album', 'asset']
const LINK_KINDS = ['album', 'track']
const CONSENT_VALUES = ['granted', 'denied']
const CONSENT_SUBJECT = 'consent'
const FIRST_DISC = 1
const CLASS_RANK = ['user', 'deterministic', 'model']
// node:sqlite binds SQL NULL only from null and reads it back as null.
const SQL_NULL = null
const toSql = value => value ?? SQL_NULL
const fromSql = value => value ?? undefined

const plain = value => JSON.parse(JSON.stringify(value))
const invalid = detail => catalogError('invalid-request', detail)
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isTime = isCount
const isText = value => typeof value === 'string' && value.length > 0
const optional = (value, check) => value === undefined || check(value)
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const availabilityOf = states => (states.includes('available') ? 'available' : states.includes('unavailable') ? 'unavailable' : 'missing')
const sourceOf = row => ({
  id: row.id, kind: row.kind, label: row.label, evidenceClass: row.evidence_class, licence: row.licence,
  policy: { analysisAllowed: Boolean(row.analysis_allowed), network: row.network, consent: fromSql(row.consent) },
})
const linkOf = row => ({
  sourceId: row.source_id, kind: row.kind, externalId: row.external_id, subject: { kind: row.subject_kind, id: row.subject_id },
  evidenceClass: row.evidence_class, linkedAt: row.linked_at,
})
const observationOf = row => ({
  id: row.id, sourceId: row.source_id, subject: { kind: row.subject_kind, id: row.subject_id }, field: row.field, value: JSON.parse(row.value),
  observedAt: row.observed_at, derivedFrom: row.derived_from === SQL_NULL ? undefined : JSON.parse(row.derived_from),
  evidenceClass: row.evidence_class, licence: row.licence,
})
const recordOf = row => ({ ...JSON.parse(row.body), seq: row.seq })
// Fixed text, chosen by a validated sort name.
const ALBUM_ORDER = {
  artist: 'a.sort_artist, coalesce(a.year, 0), a.sort_title, a.album_id',
  title: 'a.sort_title, a.sort_artist, a.album_id',
  added: 'a.seq',
}
const decisionOf = row => {
  const value = row.value === SQL_NULL ? undefined : JSON.parse(row.value)
  const base = { id: row.id, sourceId: USER_SOURCE_ID, kind: row.kind, decidedAt: row.decided_at }
  if (row.kind === 'consent') return { ...base, consent: row.subject_id, value }
  const subject = { kind: row.subject_kind, id: row.subject_id }
  return row.kind === 'trait' ? { ...base, subject, trait: row.trait, value } : { ...base, subject, value }
}

export class CatalogStore {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.statements = new Map()
    this.depth = 0
    this.dirty = new Set()
    this.ledger = createLedger(this)
    this.jobs = new JobQueue(this)
    this.reconstruct = new ReconstructStore(this)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
    this.run('INSERT OR IGNORE INTO sources(id, kind, label, evidence_class, licence, analysis_allowed, network) VALUES(?,?,?,?,?,?,?)',
      USER_SOURCE.id, USER_SOURCE.kind, USER_SOURCE.label, USER_SOURCE.evidenceClass, USER_SOURCE.licence, Number(USER_SOURCE.policy.analysisAllowed), USER_SOURCE.policy.network)
    // Projections written by another format, or never written, are rebuilt from the spine.
    if (this.meta('projection_format') !== PROJECTION_FORMAT) {
      this.transaction(() => {
        this.run('DELETE FROM album_projection')
        this.setMeta('projection_format', PROJECTION_FORMAT)
      })
      this.rebuildProjections()
    }
  }
  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get()
    if (version > CATALOG_SCHEMA_VERSION) throw new Error('This library was saved by a newer version of Kept. Update Kept to open it.')
    for (let next = version; next < CATALOG_SCHEMA_VERSION; next++) {
      // Not transaction(): that projects what changed, and the tables it needs may not exist yet.
      this.db.exec('BEGIN IMMEDIATE')
      try { this.db.exec(`${MIGRATIONS[next]}; PRAGMA user_version=${next + 1}; COMMIT;`) } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }
  schemaVersion() { return this.db.prepare('PRAGMA user_version').get().user_version }
  // The single entry point of the worker: plain JSON in, plain JSON out, as across IPC.
  call(method, request) {
    if (!STORE_METHODS.includes(method)) throw new Error('Unknown catalog operation')
    const input = request === undefined ? undefined : plain(request)
    const owner = JOB_METHODS.includes(method) ? this.jobs : RECONSTRUCT_METHODS.includes(method) ? this.reconstruct : this
    return plain(owner[method](input) ?? {})
  }
  close() { this.db.close() }

  statement(sql) {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }
  run(sql, ...values) { return this.statement(sql).run(...values.map(toSql)) }
  get(sql, ...values) { return this.statement(sql).get(...values.map(toSql)) }
  all(sql, ...values) { return this.statement(sql).all(...values.map(toSql)) }
  transaction(body) {
    if (this.depth) return body()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = body()
      if (this.dirty.size) this.flush()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.dirty.clear()
      throw error
    } finally { this.depth-- }
  }

  meta(key) { return this.get('SELECT value FROM catalog_meta WHERE key=?', key)?.value }
  setMeta(key, value) { this.run('INSERT INTO catalog_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value) }
  // The catalog version: it moves whenever a projected album changes.
  version() { return this.meta('version') ?? 0 }
  // Marks the album of a subject as changed. Its projection is brought up to date before the transaction commits.
  touch(subject) {
    const albumId = subject.kind === 'album' ? subject.id : this.albumOf(subject.id)
    if (albumId !== undefined) this.dirty.add(albumId)
  }
  subjectVersion(subject) {
    const albumId = subject.kind === 'album' ? subject.id : this.albumOf(subject.id)
    return albumId === undefined ? 0 : this.get('SELECT version FROM album_projection WHERE album_id=?', albumId)?.version ?? 0
  }
  project(id) {
    const locks = this.all('SELECT field FROM field_locks WHERE subject_kind=? AND subject_id=?', 'album', id).map(row => row.field)
    return projectAlbum(this.albumView(id), assetId => ({
      duration: fromSql(this.get('SELECT duration FROM assets WHERE id=?', assetId).duration), fields: this.describe({ kind: 'asset', id: assetId }).fields,
      availability: availabilityOf(this.all('SELECT availability FROM locations WHERE asset_id=?', assetId).map(row => row.availability)),
      playbackLinks: this.playbackLinksOf(assetId),
    }), locks, this.get('SELECT created_at FROM albums WHERE id=?', id).created_at)
  }
  index(album) {
    this.run('DELETE FROM catalog_fts WHERE rowid IN (SELECT row FROM search_rows WHERE album_id=?)', album.id)
    this.run('DELETE FROM search_rows WHERE album_id=?', album.id)
    for (const row of searchRows(album)) {
      const { lastInsertRowid } = this.run('INSERT INTO search_rows(kind, id, album_id, artist, sort_title, sort_artist) VALUES(?,?,?,?,?,?)',
        row.kind, row.id, row.albumId, row.artist, sortKey(row.title), sortKey(row.artist))
      this.run('INSERT INTO catalog_fts(rowid, title, artist) VALUES(?,?,?)', lastInsertRowid, row.title, row.artist)
    }
  }
  // Re-projects every touched album. An album that projects as before keeps its version,
  // so a scan that says nothing new makes no pending change stale.
  flush(reindex = false) {
    let version = this.version(), moved = false
    for (const id of this.dirty) {
      const album = this.get('SELECT seq FROM albums WHERE id=?', id)
      if (!album) continue
      const projected = this.project(id), body = JSON.stringify(projected)
      if (this.get('SELECT body FROM album_projection WHERE album_id=?', id)?.body === body) {
        if (reindex) this.index(projected)
        continue
      }
      if (!moved) version++
      moved = true
      this.run(`INSERT INTO album_projection(album_id, seq, version, track_count, sort_artist, sort_title, year, body) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(album_id) DO UPDATE SET version=excluded.version, track_count=excluded.track_count, sort_artist=excluded.sort_artist,
        sort_title=excluded.sort_title, year=excluded.year, body=excluded.body`,
      id, album.seq, version, projected.trackCount, sortKey(projected.artist), sortKey(projected.title), projected.year, body)
      this.index(projected)
    }
    this.dirty.clear()
    if (moved) this.setMeta('version', version)
    return version
  }

  consents() {
    const record = Object.fromEntries(CONSENT_KEYS.map(consent => [consent, 'not-asked']))
    for (const row of this.all('SELECT subject_id, value FROM user_decisions WHERE kind=?', 'consent')) record[row.subject_id] = JSON.parse(row.value)
    return record
  }
  findSource(id) {
    const row = typeof id === 'string' ? this.get('SELECT * FROM sources WHERE id=?', id) : undefined
    return row && sourceOf(row)
  }
  requireSource(id) {
    const source = this.findSource(id)
    if (!source) throw catalogError('unknown-source', String(id))
    return source
  }
  // A provider link is an identity claim, so a model source can never make one.
  requireProvider(id) {
    const source = this.requireSource(id)
    if (!APPROVING_CLASSES.includes(source.evidenceClass)) throw catalogError('model-cannot-link', source.id)
    return source
  }
  requireSubject(subject) {
    if (!isObject(subject) || !SUBJECT_KINDS.includes(subject.kind) || !isCatalogId(subject.id)) throw invalid('subject')
    const found = subject.kind === 'album' ? this.get('SELECT 1 FROM albums WHERE id=?', subject.id) : this.get('SELECT 1 FROM assets WHERE id=?', subject.id)
    if (!found) throw catalogError('unknown-subject', `${subject.kind} ${subject.id}`)
    return { kind: subject.kind, id: subject.id }
  }
  checkProviderId(request) {
    if (!isObject(request) || !LINK_KINDS.includes(request.kind) || !isText(request.externalId)) throw invalid('provider id')
  }
  findLink(sourceId, kind, externalId) {
    const row = this.get('SELECT * FROM provider_links WHERE source_id=? AND kind=? AND external_id=?', sourceId, kind, externalId)
    return row && linkOf(row)
  }
  // A link is projected with its subject. Only one that is new, or that names another subject, changes what is shown.
  putLink(source, kind, externalId, subject, linkedAt) {
    const current = this.findLink(source.id, kind, externalId)?.subject
    if (current?.id !== subject.id) for (const changed of [current, subject]) if (changed) this.touch(changed)
    this.run(`INSERT INTO provider_links(source_id, kind, external_id, subject_kind, subject_id, evidence_class, linked_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(source_id, kind, external_id) DO UPDATE SET subject_kind=excluded.subject_kind, subject_id=excluded.subject_id,
      evidence_class=excluded.evidence_class, linked_at=excluded.linked_at`, source.id, kind, externalId, subject.kind, subject.id, source.evidenceClass, linkedAt)
    return { sourceId: source.id, kind, externalId, subject, evidenceClass: source.evidenceClass, linkedAt }
  }
  albumOf(assetId) { return this.get('SELECT album_id FROM album_tracks WHERE asset_id=?', assetId)?.album_id }
  newAlbum(createdAt) {
    const id = `album:${randomUUID()}`
    this.run('INSERT INTO albums(id, created_at) VALUES(?,?)', id, createdAt)
    this.dirty.add(id)
    return id
  }
  // Writes, and marks the album as changed, only when the place really differs: a scan that
  // finds every track where it was projects nothing again.
  join(albumId, file) {
    const { changes } = this.run(`INSERT INTO album_tracks(asset_id, album_id, disc, track, path, scan_numbering) VALUES(?,?,?,?,?,1)
      ON CONFLICT(asset_id) DO UPDATE SET album_id=excluded.album_id, disc=excluded.disc, track=excluded.track, path=excluded.path, scan_numbering=1
      WHERE scan_numbering=0 OR album_id IS NOT excluded.album_id OR disc IS NOT excluded.disc OR track IS NOT excluded.track OR path IS NOT excluded.path`,
    file.assetId, albumId, file.disc, file.track, file.path)
    if (changes) this.dirty.add(albumId)
  }

  // Latest decision per (kind, subject, trait). A replay of an older decision changes nothing.
  decide(kind, subject, trait, value, decidedAt) {
    return this.transaction(() => {
      const current = this.get('SELECT * FROM user_decisions WHERE kind=? AND subject_kind=? AND subject_id=? AND trait=?', kind, subject.kind, subject.id, trait)
      if (current && current.decided_at > decidedAt) return decisionOf(current)
      const id = current?.id ?? `decision:${randomUUID()}`
      const stored = value === undefined ? SQL_NULL : JSON.stringify(value)
      if (!current || current.decided_at !== decidedAt || current.value !== stored) {
        this.run(`INSERT INTO user_decisions(id, kind, subject_kind, subject_id, trait, value, decided_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(kind, subject_kind, subject_id, trait) DO UPDATE SET value=excluded.value, decided_at=excluded.decided_at`,
        id, kind, subject.kind, subject.id, trait, stored, decidedAt)
        if (kind !== 'consent') this.touch(subject)
      }
      return decisionOf({ id, kind, subject_kind: subject.kind, subject_id: subject.id, trait, value: stored, decided_at: decidedAt })
    })
  }

  // User evidence outranks deterministic, which outranks model. Then the newest wins.
  describe(subject) {
    const best = new Map()
    for (const row of this.all('SELECT * FROM observations WHERE subject_kind=? AND subject_id=? ORDER BY seq', subject.kind, subject.id)) {
      const current = best.get(row.field)
      const rank = current ? CLASS_RANK.indexOf(row.evidence_class) - CLASS_RANK.indexOf(current.evidence_class) : -1
      if (rank < 0 || (rank === 0 && row.observed_at > current.observed_at)) best.set(row.field, row)
    }
    const traits = {}, fields = {}
    for (const [field, row] of best) {
      const value = JSON.parse(row.value), trait = traitOfField(field)
      if (trait) traits[trait] = { value, provenance: 'estimated', sourceId: row.source_id, licence: row.licence, observedAt: row.observed_at }
      else fields[field] = { value, evidenceClass: row.evidence_class, sourceId: row.source_id, licence: row.licence, observedAt: row.observed_at }
    }
    // A field set by an applied change set stands in front of what the sources observed.
    for (const row of this.all('SELECT field, body FROM field_overrides WHERE subject_kind=? AND subject_id=?', subject.kind, subject.id)) {
      const { value, evidenceClass, sourceId, licence, observedAt, changeSetId } = JSON.parse(row.body)
      fields[row.field] = { value, evidenceClass, sourceId, licence, observedAt, changeSetId }
    }
    let favorite = false
    for (const row of this.all('SELECT * FROM user_decisions WHERE subject_kind=? AND subject_id=? AND kind<>?', subject.kind, subject.id, 'consent')) {
      const { value } = decisionOf(row)
      if (row.kind === 'favorite') favorite = value === true
      else if (value !== undefined) traits[row.trait] = { value, provenance: 'hand-set', sourceId: USER_SOURCE_ID, licence: USER_SOURCE.licence, observedAt: row.decided_at }
    }
    return { favorite, traits, fields }
  }
  linksOf(subject) {
    return this.all('SELECT * FROM provider_links WHERE subject_kind=? AND subject_id=? ORDER BY rowid', subject.kind, subject.id).map(linkOf)
  }
  playbackLinksOf(assetId) {
    // A legacy scan recorded the streams for the asset and the files it saw at the same time.
    // Keep those links while that scan's copies are still available. The legacy data cannot
    // identify which stream survived if a copy from the same scan went offline.
    return this.all(`SELECT p.source_id AS sourceId, p.external_id AS externalId
      FROM locations l JOIN provider_links p ON p.source_id=l.provider_source_id AND p.external_id=l.provider_track_id
      AND p.kind='track' AND p.subject_kind='asset' AND p.subject_id=l.asset_id
      WHERE l.asset_id=? AND l.availability='available'
      UNION
      SELECT p.source_id, p.external_id
      FROM locations l JOIN provider_links p ON p.subject_kind='asset' AND p.subject_id=l.asset_id
      AND p.kind='track' AND p.linked_at=l.seen_at
      WHERE l.asset_id=? AND l.availability='available' AND l.legacy_playback=1
      AND NOT EXISTS (
        SELECT 1 FROM locations sibling
        WHERE sibling.asset_id=l.asset_id AND sibling.seen_at=l.seen_at AND sibling.availability<>'available'
      )
      ORDER BY sourceId, externalId`, assetId, assetId)
  }
  locationsOf(assetId) {
    return this.all('SELECT * FROM locations WHERE asset_id=? ORDER BY rowid', assetId)
      .map(row => ({ assetId: row.asset_id, sourceId: row.source_id, path: row.path, availability: row.availability, seenAt: row.seen_at }))
  }
  assetView(row) {
    const subject = { kind: 'asset', id: row.id }
    const locations = this.locationsOf(row.id)
    const refused = this.get('SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.asset_id=? AND s.analysis_allowed=0', row.id)
    return {
      id: row.id, contentHash: row.content_hash, size: row.size, duration: fromSql(row.duration), albumId: this.albumOf(row.id), ...this.describe(subject),
      availability: availabilityOf(locations.map(location => location.availability)), analysisAllowed: locations.length > 0 && !refused,
      locations, links: this.linksOf(subject), playbackLinks: this.playbackLinksOf(row.id),
    }
  }
  albumView(id) {
    const subject = { kind: 'album', id }
    const members = this.membersOf(id)
    members.sort((a, b) => (a.disc ?? FIRST_DISC) - (b.disc ?? FIRST_DISC) || (a.track ?? Infinity) - (b.track ?? Infinity) || compareText(a.path, b.path))
    const availability = this.statement('SELECT availability FROM locations WHERE asset_id=?')
    const states = new Set(members.map(member => availabilityOf(availability.all(member.assetId).map(row => row.availability))))
    const tracks = members.map(({ assetId, disc, track }, position) => ({ id: `occurrence:${id}:${assetId}`, albumId: id, assetId, position, disc, track }))
    return { id, ...this.describe(subject), availability: states.size > 1 && states.has('available') ? 'partial' : availabilityOf([...states]), tracks, links: this.linksOf(subject) }
  }

  checkSnapshot(snapshot) {
    if (!isObject(snapshot) || !isTime(snapshot.observedAt) || typeof snapshot.rootAvailable !== 'boolean' || typeof snapshot.complete !== 'boolean' || !Array.isArray(snapshot.files)) throw invalid('scan snapshot')
    for (const file of snapshot.files) {
      const valid = isObject(file) && isText(file.path) && isCatalogId(file.contentHash) && isCount(file.size) && optional(file.tags, isScanTags)
        && optional(file.duration, value => Number.isFinite(value) && value >= 0) && optional(file.disc, isCount) && optional(file.track, isCount)
        && optional(file.providerTrackId, isText) && optional(file.providerAlbumId, isText)
      if (!valid) throw invalid('scan file')
      if ((file.providerTrackId ?? file.providerAlbumId) !== undefined && snapshot.providerSourceId === undefined) throw invalid('provider ids need providerSourceId')
    }
  }
  // Decides the anchor of every file that names a provider album, one provider album at a time.
  // A known provider ID keeps its anchor. An unknown one that now covers every member of
  // exactly one anchor is a provider re-ID of that anchor. Anything else gets a new anchor
  // for the assets that have none, and is reported as a conflict for those that do.
  anchor(provider, observedAt, groups, conflicts) {
    const touched = new Set()
    for (const [providerAlbumId, files] of groups) {
      const linked = this.findLink(provider.id, 'album', providerAlbumId)?.subject.id
      const anchors = new Map(files.map(file => [file.assetId, this.albumOf(file.assetId)]))
      const anchored = new Set([...anchors.values()].filter(id => id !== undefined))
      const [only] = anchored
      const reId = linked === undefined && anchored.size === 1
        && this.all('SELECT asset_id FROM album_tracks WHERE album_id=?', only).every(row => anchors.has(row.asset_id))
      const loose = files.some(file => anchors.get(file.assetId) === undefined)
      const albumId = linked ?? (reId ? only : loose ? this.newAlbum(observedAt) : undefined)
      if (albumId !== undefined && linked === undefined) this.putLink(provider, 'album', providerAlbumId, { kind: 'album', id: albumId }, observedAt)
      for (const file of files) {
        const current = this.albumOf(file.assetId)
        if (current === undefined || current === albumId) this.join(albumId, file)
        else conflicts.push({ assetId: file.assetId, albumId: current, providerAlbumId, linkedAlbumId: albumId })
        touched.add(this.albumOf(file.assetId))
      }
    }
    return [...touched]
  }

  registerSource(input) {
    const { id, kind, label, evidenceClass, licence, policy } = validateSource(input)
    return this.transaction(() => {
      const current = this.findSource(id)
      if (current && (current.kind !== kind || current.evidenceClass !== evidenceClass || current.licence !== licence)) throw catalogError('source-identity-immutable', id)
      if (id !== USER_SOURCE_ID) {
        this.run(`INSERT INTO sources(id, kind, label, evidence_class, licence, analysis_allowed, network, consent) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET label=excluded.label, analysis_allowed=excluded.analysis_allowed, network=excluded.network, consent=excluded.consent`,
        id, kind, label, evidenceClass, licence, Number(policy.analysisAllowed), policy.network, policy.consent)
      }
      const source = this.findSource(id)
      return { ...source, consentState: sourceConsentState(source, this.consents()) }
    })
  }
  listSources() {
    const consents = this.consents()
    return { sources: this.all('SELECT * FROM sources ORDER BY rowid').map(sourceOf).map(source => ({ ...source, consentState: sourceConsentState(source, consents) })) }
  }
  ingestScan(snapshot) {
    this.checkSnapshot(snapshot)
    const source = this.requireSource(snapshot.sourceId)
    const provider = snapshot.providerSourceId === undefined ? undefined : this.requireProvider(snapshot.providerSourceId)
    return this.transaction(() => {
      if (!snapshot.rootAvailable) {
        for (const row of this.all('SELECT DISTINCT t.album_id FROM locations l JOIN album_tracks t ON t.asset_id=l.asset_id WHERE l.source_id=?', source.id)) this.dirty.add(row.album_id)
        this.run('UPDATE locations SET availability=? WHERE source_id=?', 'unavailable', source.id)
        return { assetIds: [], albumIds: [], conflicts: [] }
      }
      const known = snapshot.complete ? this.all('SELECT path, asset_id FROM locations WHERE source_id=? AND availability<>?', source.id, 'missing') : []
      const seen = new Set(), groups = new Map(), assetIds = [], tagged = [], changed = new Set()
      for (const file of snapshot.files) {
        const assetId = `asset:${file.contentHash}:${file.size}`
        tagged.push({ assetId, tags: file.tags })
        // A changed asset, duration, location or stream ID can change the projection.
        const located = this.get('SELECT asset_id, availability, provider_source_id, provider_track_id, legacy_playback, seen_at FROM locations WHERE source_id=? AND path=?', source.id, file.path)
        if (located && located.asset_id !== assetId) this.touch({ kind: 'asset', id: located.asset_id })
        const stored = this.run(`INSERT INTO assets(id, content_hash, size, duration) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET duration=excluded.duration WHERE excluded.duration IS NOT NULL AND duration IS NOT excluded.duration`,
        assetId, file.contentHash, file.size, file.duration)
        const providerId = file.providerTrackId === undefined ? undefined : provider.id
        if (stored.changes || located?.asset_id !== assetId || located.availability !== 'available' || located.legacy_playback
          || fromSql(located.provider_source_id) !== providerId || fromSql(located.provider_track_id) !== file.providerTrackId) changed.add(assetId)
        if (located?.legacy_playback) {
          this.run('UPDATE locations SET legacy_playback=0 WHERE asset_id=? AND seen_at=? AND legacy_playback=1', located.asset_id, located.seen_at)
        }
        this.run(`INSERT INTO locations(source_id, path, asset_id, availability, seen_at, provider_source_id, provider_track_id) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(source_id, path) DO UPDATE SET asset_id=excluded.asset_id, availability=excluded.availability, seen_at=excluded.seen_at,
          provider_source_id=excluded.provider_source_id, provider_track_id=excluded.provider_track_id, legacy_playback=0`,
        source.id, file.path, assetId, 'available', snapshot.observedAt, providerId, file.providerTrackId)
        seen.add(file.path)
        assetIds.push(assetId)
        if (file.providerTrackId !== undefined) this.putLink(provider, 'track', file.providerTrackId, { kind: 'asset', id: assetId }, snapshot.observedAt)
        if (file.providerAlbumId !== undefined) groups.set(file.providerAlbumId, [...groups.get(file.providerAlbumId) ?? [], { ...file, assetId }])
      }
      for (const { path, asset_id: assetId } of known) {
        if (seen.has(path)) continue
        this.run('UPDATE locations SET availability=? WHERE source_id=? AND path=?', 'missing', source.id, path)
        this.touch({ kind: 'asset', id: assetId })
      }
      const conflicts = []
      const albumIds = provider ? this.anchor(provider, snapshot.observedAt, groups, conflicts) : []
      for (const { subject, field, value } of tagObservations(tagged, assetId => this.albumOf(assetId))) this.observeTag(source, subject, field, value, snapshot.observedAt)
      for (const assetId of changed) this.touch({ kind: 'asset', id: assetId })
      return { assetIds, albumIds, conflicts }
    })
  }
  linkProvider(request) {
    this.checkProviderId(request)
    const source = this.requireProvider(request.sourceId)
    if (!isTime(request.linkedAt)) throw invalid('linkedAt')
    const subject = this.requireSubject(request.subject)
    if ((request.kind === 'album') !== (subject.kind === 'album')) throw invalid('link kind does not match its subject')
    return this.transaction(() => {
      const current = this.findLink(source.id, request.kind, request.externalId)
      if (current && current.subject.id !== subject.id) throw catalogError('link-conflict', `${request.externalId} is linked to ${current.subject.id}`)
      return current ?? this.putLink(source, request.kind, request.externalId, subject, request.linkedAt)
    })
  }
  resolveProviderId(request) {
    this.checkProviderId(request)
    this.requireSource(request.sourceId)
    return { subject: this.findLink(request.sourceId, request.kind, request.externalId)?.subject }
  }
  recordObservation(input) {
    if (!isObject(input) || !isText(input.field) || input.value === undefined || !isTime(input.observedAt) || !optional(input.derivedFrom, Array.isArray)) throw invalid('observation')
    const source = this.requireSource(input.sourceId)
    const subject = this.requireSubject(input.subject)
    if (input.field.startsWith(TRAIT_FIELD_PREFIX) && !(traitOfField(input.field) && isTraitValue(input.value))) throw invalid('trait observation')
    return this.transaction(() => {
      const inputs = (input.derivedFrom ?? []).map(id => {
        const row = typeof id === 'string' ? this.get('SELECT * FROM observations WHERE id=?', id) : undefined
        if (!row) throw catalogError('unknown-observation', String(id))
        return observationOf(row)
      })
      const current = this.get('SELECT id FROM observations WHERE source_id=? AND subject_kind=? AND subject_id=? AND field=? AND observed_at=?',
        source.id, subject.kind, subject.id, input.field, input.observedAt)
      const observation = {
        id: current?.id ?? `observation:${randomUUID()}`, sourceId: source.id, subject, field: input.field, value: input.value, observedAt: input.observedAt,
        derivedFrom: inputs.length ? inputs.map(item => item.id) : undefined,
        evidenceClass: propagateEvidenceClass(source.evidenceClass, inputs.map(item => item.evidenceClass)),
        licence: propagateLicence([source.licence, ...inputs.map(item => item.licence)]),
      }
      this.run(`INSERT INTO observations(id, source_id, subject_kind, subject_id, field, value, observed_at, evidence_class, licence, derived_from) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id, subject_kind, subject_id, field, observed_at) DO UPDATE SET value=excluded.value, evidence_class=excluded.evidence_class,
        licence=excluded.licence, derived_from=excluded.derived_from`,
      observation.id, source.id, subject.kind, subject.id, input.field, JSON.stringify(input.value), input.observedAt, observation.evidenceClass, observation.licence,
      observation.derivedFrom && JSON.stringify(observation.derivedFrom))
      this.touch(subject)
      return observation
    })
  }
  recordUserDecision(input) {
    if (!isObject(input) || !isTime(input.decidedAt)) throw invalid('decision')
    if (input.kind === 'consent') {
      if (!CONSENT_KEYS.includes(input.consent) || !CONSENT_VALUES.includes(input.value)) throw invalid('consent')
      return this.decide('consent', { kind: CONSENT_SUBJECT, id: input.consent }, '', input.value, input.decidedAt)
    }
    if (input.kind === 'favorite') {
      if (typeof input.value !== 'boolean') throw invalid('favorite')
      return this.decide('favorite', this.requireSubject(input.subject), '', input.value, input.decidedAt)
    }
    if (input.kind !== 'trait' || !TRAIT_NAMES.includes(input.trait) || !optional(input.value, isTraitValue)) throw invalid('decision')
    return this.decide('trait', this.requireSubject(input.subject), input.trait, input.value, input.decidedAt)
  }
  getAlbum(request) {
    const id = request?.albumId
    return { album: typeof id === 'string' && this.get('SELECT 1 FROM albums WHERE id=?', id) ? this.albumView(id) : undefined }
  }
  getAsset(request) {
    const row = typeof request?.assetId === 'string' ? this.get('SELECT * FROM assets WHERE id=?', request.assetId) : undefined
    return { asset: row && this.assetView(row) }
  }
  getPlaybackLinks(request) {
    const ids = request?.assetIds
    if (!Array.isArray(ids) || ids.length > MAX_PLAYBACK_LINKS || !ids.every(isCatalogId)) throw invalid('playback assets')
    const links = Object.fromEntries([...new Set(ids)].map(id => [id, this.playbackLinksOf(id)]))
    return { links, version: this.version() }
  }
  listAlbums(request = {}) {
    const { offset = 0, limit = DEFAULT_ALBUM_PAGE } = request
    if (!isCount(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ALBUM_PAGE) throw invalid('album page')
    // An anchor emptied by a merge or a split stays, for its links and for undo, but is not listed.
    const { total } = this.get('SELECT count(*) AS total FROM albums a WHERE EXISTS(SELECT 1 FROM album_tracks t WHERE t.album_id=a.id)')
    const rows = this.all('SELECT id FROM albums a WHERE EXISTS(SELECT 1 FROM album_tracks t WHERE t.album_id=a.id) ORDER BY seq LIMIT ? OFFSET ?', limit, offset)
    return { albums: rows.map(row => this.albumView(row.id)), total }
  }
  getConsent() { return this.consents() }
  setConsent(request) {
    this.recordUserDecision({ kind: 'consent', consent: request?.consent, value: request?.value, decidedAt: request?.decidedAt })
    return this.consents()
  }

  // A tag is observed again only when the scanned source says something new.
  observeTag(source, subject, field, value, observedAt) {
    const latest = this.get('SELECT value FROM observations WHERE source_id=? AND subject_kind=? AND subject_id=? AND field=? ORDER BY observed_at DESC LIMIT 1',
      source.id, subject.kind, subject.id, field)
    if (latest?.value !== JSON.stringify(value)) this.recordObservation({ sourceId: source.id, subject, field, value, observedAt })
  }

  // The ledger (shared/catalog-ledger.js) and the spine state it reads and writes.
  commitChangeSet(input) { return this.ledger.commitChangeSet(input) }
  undoChangeSet(request) { return this.ledger.undoChangeSet(request) }
  undoField(request) { return this.ledger.undoField(request) }
  getChangeSet(request) { return this.ledger.getChangeSet(request) }
  listChangeSets(request) { return this.ledger.listChangeSets(request) }
  findObservation(id) {
    const row = this.get('SELECT * FROM observations WHERE id=?', id)
    return row && observationOf(row)
  }
  memberOf(assetId) {
    const row = this.get('SELECT album_id, disc, track, path FROM album_tracks WHERE asset_id=?', assetId)
    return row && { albumId: row.album_id, disc: fromSql(row.disc), track: fromSql(row.track), path: row.path }
  }
  membersOf(albumId) {
    const rows = this.all('SELECT asset_id, disc, track, path FROM album_tracks WHERE album_id=? ORDER BY rowid', albumId)
    const numbering = trackNumbering(rows.map(row => row.asset_id), keys => this.changeSetsByKeys(keys))
    return rows.map(row => {
      const corrected = numbering.get(row.asset_id)
      return { assetId: row.asset_id, albumId, disc: corrected?.disc ?? fromSql(row.disc), track: corrected?.track ?? fromSql(row.track), path: row.path }
    })
  }
  setMember(assetId, place, restoring) {
    if (place) this.run(`INSERT INTO album_tracks(asset_id, album_id, disc, track, path) VALUES(?,?,?,?,?)
      ON CONFLICT(asset_id) DO UPDATE SET album_id=excluded.album_id, path=excluded.path,
      disc=CASE WHEN ? AND scan_numbering=0 THEN excluded.disc ELSE album_tracks.disc END,
      track=CASE WHEN ? AND scan_numbering=0 THEN excluded.track ELSE album_tracks.track END`,
    assetId, place.albumId, place.disc, place.track, place.path, Number(restoring), Number(restoring))
    else this.run('DELETE FROM album_tracks WHERE asset_id=?', assetId)
  }
  albumLinks(albumId) { return this.linksOf({ kind: 'album', id: albumId }).filter(link => link.kind === 'album') }
  setLink(link) { this.putLink({ id: link.sourceId, evidenceClass: link.evidenceClass }, link.kind, link.externalId, link.subject, link.linkedAt) }
  removeLink(sourceId, kind, externalId) {
    const current = this.findLink(sourceId, kind, externalId)
    if (current) this.touch(current.subject)
    this.run('DELETE FROM provider_links WHERE source_id=? AND kind=? AND external_id=?', sourceId, kind, externalId)
  }
  fieldValue(subject, field) { return this.describe(subject).fields[field]?.value }
  decision(kind, subject, trait) {
    const row = this.get('SELECT value, decided_at FROM user_decisions WHERE kind=? AND subject_kind=? AND subject_id=? AND trait=?', kind, subject.kind, subject.id, trait)
    return row && { value: row.value === SQL_NULL ? undefined : JSON.parse(row.value), decidedAt: row.decided_at }
  }
  // Unlike decide(), this writes whatever the time: an undo puts an older value back.
  setDecision(kind, subject, trait, value, decidedAt) {
    this.run(`INSERT INTO user_decisions(id, kind, subject_kind, subject_id, trait, value, decided_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(kind, subject_kind, subject_id, trait) DO UPDATE SET value=excluded.value, decided_at=excluded.decided_at`,
    `decision:${randomUUID()}`, kind, subject.kind, subject.id, trait, value === undefined ? SQL_NULL : JSON.stringify(value), decidedAt)
  }
  override(subject, field) {
    const row = this.get('SELECT body FROM field_overrides WHERE subject_kind=? AND subject_id=? AND field=?', subject.kind, subject.id, field)
    return row && JSON.parse(row.body)
  }
  setOverride(subject, field, value) {
    if (value === undefined) this.run('DELETE FROM field_overrides WHERE subject_kind=? AND subject_id=? AND field=?', subject.kind, subject.id, field)
    else {
      this.run(`INSERT INTO field_overrides(subject_kind, subject_id, field, body) VALUES(?,?,?,?)
        ON CONFLICT(subject_kind, subject_id, field) DO UPDATE SET body=excluded.body`, subject.kind, subject.id, field, JSON.stringify(value))
    }
  }
  lock(subject, field) {
    return this.get('SELECT change_set_id FROM field_locks WHERE subject_kind=? AND subject_id=? AND field=?', subject.kind, subject.id, field)?.change_set_id
  }
  setLock(subject, field, changeSetId) {
    if (changeSetId === undefined) this.run('DELETE FROM field_locks WHERE subject_kind=? AND subject_id=? AND field=?', subject.kind, subject.id, field)
    else {
      this.run(`INSERT INTO field_locks(subject_kind, subject_id, field, change_set_id) VALUES(?,?,?,?)
        ON CONFLICT(subject_kind, subject_id, field) DO UPDATE SET change_set_id=excluded.change_set_id`, subject.kind, subject.id, field, changeSetId)
    }
  }
  findChangeSet(id) {
    const row = this.get('SELECT seq, body FROM change_sets WHERE id=?', id)
    return row && recordOf(row)
  }
  insertChangeSet(record) {
    const { lastInsertRowid } = this.run('INSERT INTO change_sets(id, state, committed_at, body) VALUES(?,?,?,?)', record.id, record.state, record.committedAt, JSON.stringify(record))
    record.seq = Number(lastInsertRowid)
    for (const key of record.keys) this.run('INSERT INTO change_keys(key, seq) VALUES(?,?)', key, record.seq)
  }
  updateChangeSet(record) { this.run('UPDATE change_sets SET state=?, body=? WHERE id=?', record.state, JSON.stringify(record), record.id) }
  changeSetsByKeys(keys) {
    return this.all(`SELECT seq, body FROM change_sets WHERE seq IN (SELECT seq FROM change_keys WHERE key IN (SELECT value FROM json_each(?))) ORDER BY seq`, JSON.stringify(keys))
      .map(recordOf)
  }
  changeSetPage({ offset, limit }) {
    const { total } = this.get('SELECT count(*) AS total FROM change_sets')
    return { records: this.all('SELECT seq, body FROM change_sets ORDER BY seq DESC LIMIT ? OFFSET ?', limit, offset).map(recordOf), total }
  }
  suppression(author, fingerprint) { return this.get('SELECT change_set_id FROM change_suppressions WHERE author=? AND fingerprint=?', author, fingerprint)?.change_set_id }
  setSuppression(author, fingerprint, changeSetId) {
    this.run('INSERT INTO change_suppressions(author, fingerprint, change_set_id) VALUES(?,?,?) ON CONFLICT(author, fingerprint) DO UPDATE SET change_set_id=excluded.change_set_id',
      author, fingerprint, changeSetId)
  }

  // The read model. Rows are written by flush() in the transaction that changed them.
  listCatalogAlbums(request = {}) {
    const { offset = 0, limit = DEFAULT_ALBUM_PAGE, sort = 'artist', artist } = request
    if (!isCount(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ALBUM_PAGE || !CATALOG_SORTS.includes(sort)
      || !optional(artist, value => isText(value) && value.trim() && value.length <= MAX_TAG_LENGTH)) throw invalid('album page')
    const from = artist === undefined
      ? 'FROM album_projection a WHERE a.track_count>0'
      : 'FROM (SELECT DISTINCT album_id FROM search_rows WHERE artist=?) credited JOIN album_projection a USING (album_id)'
    const args = artist === undefined ? [] : [artist]
    const { total } = this.get(`SELECT count(*) AS total ${from}`, ...args)
    const rows = this.all(`SELECT body, version ${from} ORDER BY ${ALBUM_ORDER[sort]} LIMIT ? OFFSET ?`, ...args, limit, offset)
    return { albums: rows.map(row => albumSummary(JSON.parse(row.body), row.version)), total, version: this.version() }
  }
  getCatalogAlbum(request) {
    const row = typeof request?.albumId === 'string' ? this.get('SELECT body, version FROM album_projection WHERE album_id=?', request.albumId) : undefined
    return { album: row && albumDetail(JSON.parse(row.body), row.version), version: this.version() }
  }
  searchCatalog(request) {
    const { terms, kinds, limit, offset } = normalSearch(request)
    const result = { albums: [], artists: [], tracks: [], version: this.version() }
    if (!terms.length) return result
    const match = ftsQuery(terms)
    const found = `FROM catalog_fts JOIN search_rows r ON r.row=catalog_fts.rowid JOIN album_projection a ON a.album_id=r.album_id WHERE catalog_fts MATCH ?`
    if (kinds.includes('album')) {
      result.albums = this.all(`SELECT a.body, a.version ${found} AND r.kind='album' ORDER BY ${ALBUM_ORDER.artist} LIMIT ? OFFSET ?`, match, limit, offset)
        .map(row => albumSummary(JSON.parse(row.body), row.version))
    }
    if (kinds.includes('track')) {
      const parsed = new Map()
      result.tracks = this.all(`SELECT r.id, r.album_id, a.body ${found} AND r.kind='track' ORDER BY r.sort_title, r.id LIMIT ? OFFSET ?`, match, limit, offset).map(row => {
        if (!parsed.has(row.album_id)) parsed.set(row.album_id, JSON.parse(row.body))
        return parsed.get(row.album_id).tracks.find(track => track.id === row.id)
      })
    }
    if (kinds.includes('artist')) {
      result.artists = this.all(`SELECT r.artist AS name, count(DISTINCT r.album_id) AS albumCount ${found} GROUP BY r.artist ORDER BY r.sort_artist, r.artist LIMIT ? OFFSET ?`,
        `artist : (${match})`, limit, offset).map(row => ({ name: row.name, albumCount: row.albumCount }))
    }
    return result
  }
  // Projects every album again and rewrites the search index. Albums that project as before keep their version.
  rebuildProjections() {
    const started = performance.now()
    return this.transaction(() => {
      this.run('DELETE FROM catalog_fts')
      this.run('DELETE FROM search_rows')
      this.run('DELETE FROM album_projection WHERE album_id NOT IN (SELECT id FROM albums)')
      for (const { id } of this.all('SELECT id FROM albums')) this.dirty.add(id)
      const version = this.flush(true)
      const { albums, tracks } = this.get('SELECT count(*) AS albums, coalesce(sum(track_count), 0) AS tracks FROM album_projection WHERE track_count>0')
      return { albums, tracks, version, ms: Math.round(performance.now() - started) }
    })
  }
  verifyProjections() {
    const albums = this.all('SELECT id FROM albums ORDER BY seq')
    const differing = albums.map(row => row.id).filter(id => {
      const projected = this.project(id)
      const indexed = this.all('SELECT r.kind, r.id, catalog_fts.title, catalog_fts.artist FROM search_rows r JOIN catalog_fts ON catalog_fts.rowid=r.row WHERE r.album_id=? ORDER BY r.row', id)
      const expected = searchRows(projected).map(({ kind, id: rowId, title, artist }) => ({ kind, id: rowId, title, artist }))
      return this.get('SELECT body FROM album_projection WHERE album_id=?', id)?.body !== JSON.stringify(projected) || JSON.stringify(indexed) !== JSON.stringify(expected)
    })
    return { consistent: differing.length === 0, albums: albums.length, differing: differing.slice(0, MAX_REPORTED_DIFFERENCES) }
  }

  // What each file of a source hashed to, and the size and modification time it had then.
  fileHashes(request) {
    const source = this.requireSource(request?.sourceId)
    return {
      entries: this.all('SELECT * FROM file_hashes WHERE source_id=?', source.id)
        .map(row => ({ path: row.path, fileSize: row.file_size, modifiedMs: row.modified_ms, fileVersion: fromSql(row.file_version), contentHash: row.content_hash, size: row.payload_size })),
    }
  }
  // prune forgets the files of the source that are not listed.
  storeFileHashes(request) {
    const source = this.requireSource(request?.sourceId)
    if (!Array.isArray(request.entries) || !optional(request.prune, value => typeof value === 'boolean')) throw invalid('file hashes')
    for (const entry of request.entries) {
      if (!isObject(entry) || !isText(entry.path) || !isCount(entry.fileSize) || !Number.isFinite(entry.modifiedMs)
        || !optional(entry.fileVersion, isText) || !isCatalogId(entry.contentHash) || !isCount(entry.size)) throw invalid('file hash')
    }
    return this.transaction(() => {
      const kept = new Set(request.entries.map(entry => entry.path))
      if (request.prune) {
        for (const { path } of this.all('SELECT path FROM file_hashes WHERE source_id=?', source.id)) if (!kept.has(path)) this.run('DELETE FROM file_hashes WHERE source_id=? AND path=?', source.id, path)
      }
      for (const entry of request.entries) {
        this.run(`INSERT INTO file_hashes(source_id, path, file_size, modified_ms, content_hash, payload_size, file_version) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(source_id, path) DO UPDATE SET file_size=excluded.file_size, modified_ms=excluded.modified_ms,
          content_hash=excluded.content_hash, payload_size=excluded.payload_size, file_version=excluded.file_version`,
        source.id, entry.path, entry.fileSize, entry.modifiedMs, entry.contentHash, entry.size, entry.fileVersion)
      }
      return { stored: request.entries.length }
    })
  }
}
