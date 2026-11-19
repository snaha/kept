import { routeSource, sourceConsentState } from '../shared/catalog-rules.js'
import { ACOUSTID_SOURCE, LADDER_POLICY, MUSICBRAINZ_SOURCE, digest } from '../shared/reconstruct.js'
import { discOfFolder } from '../shared/reconstruct-match.js'

// The reconstruction ladder's side of library.sqlite: the album-sized cluster a job works on, what
// each route concluded, the cached provider answers, and the one transaction that publishes a
// job's result through the ledger. Runs on the catalog worker, inside CatalogStore.

export const RECONSTRUCT_METHODS = Object.freeze(['reconstructionCluster', 'storeReconstruction', 'reconstructionQueue', 'reconstructionAttempts'])

// Entry for the MIGRATIONS list of catalog-store.js.
// route_attempts: the last run of the ladder for an album. provider_cache: answers of online
// sources, reduced to what their licence lets Kept keep. It can be fetched again.
export const RECONSTRUCT_MIGRATION = `
  CREATE TABLE route_attempts(album_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL, online INTEGER NOT NULL,
    retry INTEGER NOT NULL, blocked TEXT NOT NULL, needs TEXT NOT NULL, outcomes TEXT NOT NULL, catalog_version INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
  CREATE TABLE provider_cache(source_id TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, key)) STRICT;
  CREATE INDEX provider_cache_scope ON provider_cache(scope);
`

// A cluster stays album-sized even in a folder that holds a whole collection.
export const MAX_CLUSTER_TRACKS = 500
const SOURCES = [MUSICBRAINZ_SOURCE, ACOUSTID_SOURCE]
const AUTHOR_PREFIX = 'reconstruct:'
const ROUTE_PREFIX = 'reconstruct.'
const LIKE_ESCAPE = '\\'
// node:sqlite binds SQL NULL only from null and reads it back as null.
const SQL_NULL = null

const invalid = detail => new Error(`invalid-request: ${detail}`)
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = path => path.slice(path.lastIndexOf('/') + 1)
const likePrefix = dir => (dir ? `${dir.replace(/[\\%_]/g, character => LIKE_ESCAPE + character)}/%` : '%')
const isCount = value => Number.isSafeInteger(value) && value >= 0
const text = field => (typeof field?.value === 'string' && field.value.trim() ? field.value : undefined)

// Carries a refusal out of the transaction, which rolls back what the job had stored so far.
class Stale extends Error {}

export class ReconstructStore {
  constructor(store) { this.store = store }

  // Whether a route may use each online source, read from the registry and the consent decisions.
  permissions() {
    const { store } = this
    const consents = store.consents()
    return Object.fromEntries(SOURCES.map(definition => {
      const source = store.findSource(definition.id) ?? store.registerSource(definition)
      return [definition.id, routeSource({ ...source, consentState: sourceConsentState(source, consents) })]
    }))
  }

  // The place of an asset on disk: the location its album knows it by, else any location.
  locate(assetId, path) {
    const rows = this.store.all('SELECT source_id, path, availability FROM locations WHERE asset_id=? ORDER BY rowid', assetId)
    return rows.find(row => row.path === path && row.availability === 'available') ?? rows.find(row => row.availability === 'available') ?? rows[0]
  }

  latestObservation(subject, field) {
    return this.store.get('SELECT id FROM observations WHERE subject_kind=? AND subject_id=? AND field=? AND evidence_class=? ORDER BY seq DESC LIMIT 1',
      subject.kind, subject.id, field, 'deterministic')?.id
  }

  // The seed album, and the albums that share its folders or are the other discs of its set.
  // A folder is a hint, not a boundary: the ladder decides what belongs together.
  reconstructionCluster(request) {
    const { store } = this
    const seed = request?.albumId
    if (typeof seed !== 'string') throw invalid('album')
    return store.transaction(() => {
      const permissions = this.permissions()
      const version = store.version()
      const row = store.get('SELECT * FROM route_attempts WHERE album_id=?', seed)
      const previous = row && { inputHash: row.input_hash, policy: row.policy, status: row.status, online: Boolean(row.online), retry: Boolean(row.retry) }
      const members = store.get('SELECT 1 FROM albums WHERE id=?', seed) ? store.membersOf(seed) : []
      if (!members.length) return { seed, version, permissions, previous, albums: [], tracks: [], cache: [] }

      const albumIds = [seed]
      const seen = new Set()
      let room = MAX_CLUSTER_TRACKS - members.length
      for (const member of members) {
        const location = this.locate(member.assetId, member.path)
        if (!location) continue
        const dir = dirOf(location.path)
        // The other discs live beside a disc folder, under the same parent.
        const sets = discOfFolder(baseOf(dir)) === undefined ? [{ prefix: dir, near: other => other === dir }]
          : [{ prefix: dirOf(dir), near: other => other === dir || (dirOf(other) === dirOf(dir) && discOfFolder(baseOf(other)) !== undefined) }]
        for (const { prefix, near } of sets) {
          const key = `${location.source_id}/${prefix}`
          if (seen.has(key)) continue
          seen.add(key)
          const rows = store.all(`SELECT t.album_id, l.path FROM locations l JOIN album_tracks t ON t.asset_id=l.asset_id
            WHERE l.source_id=? AND l.path LIKE ? ESCAPE '${LIKE_ESCAPE}' ORDER BY l.path`, location.source_id, likePrefix(prefix))
          for (const neighbour of rows) {
            if (albumIds.includes(neighbour.album_id) || !near(dirOf(neighbour.path))) continue
            const size = store.get('SELECT count(*) AS total FROM album_tracks WHERE album_id=?', neighbour.album_id).total
            if (size > room) continue
            room -= size
            albumIds.push(neighbour.album_id)
          }
        }
      }

      const albums = [], tracks = []
      for (const id of albumIds) {
        const subject = { kind: 'album', id }
        const { fields } = store.describe(subject)
        albums.push({
          id, seq: store.get('SELECT seq FROM albums WHERE id=?', id).seq, title: text(fields.title), artist: text(fields.artist),
          year: Number.isSafeInteger(fields.year?.value) && fields.year.value > 0 ? fields.year.value : undefined,
          locks: store.all('SELECT field FROM field_locks WHERE subject_kind=? AND subject_id=? ORDER BY field', 'album', id).map(lock => lock.field),
          userFields: Object.entries(fields).filter(([, field]) => field.evidenceClass === 'user').map(([name]) => name).sort(),
          links: store.albumLinks(id).map(link => ({ sourceId: link.sourceId, externalId: link.externalId })),
          evidence: { title: this.latestObservation(subject, 'title'), artist: this.latestObservation(subject, 'artist') },
        })
        for (const member of id === seed ? members : store.membersOf(id)) {
          const asset = { kind: 'asset', id: member.assetId }
          const described = store.describe(asset).fields
          const location = this.locate(member.assetId, member.path)
          tracks.push({
            assetId: member.assetId, albumId: id, disc: member.disc, track: member.track, sourceId: location?.source_id ?? '', path: location?.path ?? member.path,
            available: location?.availability === 'available', title: text(described.title), artist: text(described.artist),
            duration: store.get('SELECT duration FROM assets WHERE id=?', member.assetId)?.duration ?? undefined,
            locks: store.all('SELECT field FROM field_locks WHERE subject_kind=? AND subject_id=? ORDER BY field', 'asset', member.assetId).map(lock => lock.field),
            userFields: Object.entries(described).filter(([, field]) => field.evidenceClass === 'user').map(([name]) => name).sort(),
            evidence: { title: this.latestObservation(asset, 'title') },
          })
        }
      }
      const cache = albumIds.flatMap(id => store.all('SELECT key, body FROM provider_cache WHERE source_id=? AND scope=?', MUSICBRAINZ_SOURCE.id, id))
        .map(entry => ({ key: entry.key, ...JSON.parse(entry.body) }))
      return { seed, version, permissions, previous, albums, tracks, cache }
    })
  }

  // The stored observation that already says this, else a new one.
  observe(observation, now) {
    const { store } = this
    const latest = store.get('SELECT id, value, observed_at FROM observations WHERE source_id=? AND subject_kind=? AND subject_id=? AND field=? ORDER BY observed_at DESC LIMIT 1',
      observation.sourceId, observation.subject.kind, observation.subject.id, observation.field)
    if (latest?.value === JSON.stringify(observation.value)) return latest.id
    const observedAt = latest && latest.observed_at >= now ? latest.observed_at + 1 : now
    return store.recordObservation({ sourceId: observation.sourceId, subject: observation.subject, field: observation.field, value: observation.value, observedAt }).id
  }

  // Publishes the result of one run of the ladder: its observations, its change sets through the
  // ledger, what each route concluded and what the providers answered. All of it or none.
  // result: what runLadder returned, plus version and albumIds of the cluster it read and the cache entries it fetched.
  storeReconstruction(request) {
    const { store } = this
    const { albumId, result, now } = request ?? {}
    if (typeof albumId !== 'string' || !result || typeof result !== 'object' || !isCount(now) || !isCount(result.version) || !Array.isArray(result.albumIds)) throw invalid('reconstruction')
    const body = () => {
      // The cluster was read at result.version. Anything of it that moved since makes every proposal stale.
      for (const id of result.albumIds) if (store.subjectVersion({ kind: 'album', id }) > result.version) throw new Stale()
      const observationIds = new Map((result.observations ?? []).map(observation => [observation.key, this.observe(observation, now)]))
      const committed = new Map(), commits = []
      let baseVersion = store.version()
      for (const proposal of result.changeSets ?? []) {
        const id = `${AUTHOR_PREFIX}${proposal.route}:${digest([albumId, proposal.operations])}`
        const waiting = proposal.dependsOn.filter(key => !committed.has(key))
        if (waiting.length) { commits.push({ id, route: proposal.route, status: 'skipped', reason: 'dependency-not-applied', summary: proposal.summary }); continue }
        const evidence = proposal.evidence.map(reference => ({
          supports: true, sourceId: reference.sourceId, observationId: reference.observation === undefined ? reference.observationId : observationIds.get(reference.observation),
        }))
        const outcome = store.commitChangeSet({
          id, author: { kind: 'job', id: `${AUTHOR_PREFIX}${albumId}`, route: `${ROUTE_PREFIX}${proposal.route}` }, operations: proposal.operations, evidence,
          dependsOn: proposal.dependsOn.map(key => committed.get(key)), baseVersion, committedAt: now, summary: proposal.summary,
        })
        if (outcome.status === 'rejected' && outcome.reason === 'stale') throw new Stale()
        if (outcome.status === 'applied') {
          committed.set(proposal.key, id)
          baseVersion = store.version()
        }
        commits.push({ id, route: proposal.route, status: outcome.status, reason: outcome.reason, replayed: outcome.replayed, summary: proposal.summary, operations: proposal.operations.length })
      }
      const version = store.flush()
      if (result.reused) {
        store.run('UPDATE route_attempts SET catalog_version=?, updated_at=? WHERE album_id=?', version, now, albumId)
        return { status: 'stored', commits, version }
      }
      store.run(`INSERT INTO route_attempts(album_id, input_hash, policy, status, online, retry, blocked, needs, outcomes, catalog_version, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(album_id) DO UPDATE SET input_hash=excluded.input_hash, policy=excluded.policy, status=excluded.status, online=excluded.online, retry=excluded.retry,
          blocked=excluded.blocked, needs=excluded.needs, outcomes=excluded.outcomes, catalog_version=excluded.catalog_version, updated_at=excluded.updated_at`,
      albumId, result.inputHash, result.policy, result.status, Number(Boolean(result.online)), Number(Boolean(result.retry)), JSON.stringify(result.blockedBy ?? []),
      JSON.stringify(result.needs ?? []), JSON.stringify(result.outcomes ?? []), version, now)
      for (const entry of result.cache ?? []) {
        store.run(`INSERT INTO provider_cache(source_id, key, scope, body, fetched_at) VALUES(?,?,?,?,?)
          ON CONFLICT(source_id, key) DO UPDATE SET scope=excluded.scope, body=excluded.body, fetched_at=excluded.fetched_at`,
        MUSICBRAINZ_SOURCE.id, entry.key, albumId, JSON.stringify({ value: entry.value }), now)
      }
      return { status: 'stored', commits, version }
    }
    try { return store.transaction(body) } catch (error) {
      if (error instanceof Stale) return { status: 'stale', version: store.version() }
      throw error
    }
  }

  // The albums the ladder has not seen as they are now: new or changed ones, those judged under an
  // older policy, those a failed route asked to retry, and those a consent the user has since
  // granted had blocked.
  reconstructionQueue(request = {}) {
    const { store } = this
    const limit = request.limit ?? SQL_NULL
    const granted = Object.entries(store.consents()).filter(([, state]) => state === 'granted').map(([key]) => key)
    const rows = store.all(`SELECT p.album_id, a.policy, a.retry, a.blocked, a.catalog_version, p.version FROM album_projection p
      LEFT JOIN route_attempts a ON a.album_id=p.album_id WHERE p.track_count > 0 ORDER BY p.seq`)
    const due = rows.filter(row => row.policy === SQL_NULL || row.policy !== LADDER_POLICY || row.version > row.catalog_version || row.retry === 1
      || JSON.parse(row.blocked).some(key => granted.includes(key)))
    return { albumIds: due.map(row => row.album_id).slice(0, limit ?? due.length), total: rows.length }
  }

  reconstructionAttempts(request = {}) {
    const rows = request.albumId === undefined ? this.store.all('SELECT * FROM route_attempts ORDER BY rowid') : this.store.all('SELECT * FROM route_attempts WHERE album_id=?', request.albumId)
    return {
      attempts: rows.map(row => ({
        albumId: row.album_id, inputHash: row.input_hash, policy: row.policy, status: row.status, online: Boolean(row.online), retry: Boolean(row.retry),
        blockedBy: JSON.parse(row.blocked), needs: JSON.parse(row.needs), outcomes: JSON.parse(row.outcomes), catalogVersion: row.catalog_version, updatedAt: row.updated_at,
      })),
    }
  }
}
