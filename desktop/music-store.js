import { validateHistoryRequest, isListeningContext } from '../shared/contracts.js';
import { DatabaseSync } from 'node:sqlite';

// Owned by Music, never by Navidrome. All calls run on the database worker.
export class MusicStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS history_contexts(scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS plays(scope TEXT NOT NULL, id TEXT NOT NULL, context_id TEXT NOT NULL, track_id TEXT NOT NULL, source TEXT NOT NULL, origin_id TEXT, origin_kind TEXT, queue_index INTEGER NOT NULL, cursor INTEGER NOT NULL, played_at INTEGER NOT NULL, PRIMARY KEY(scope,id), FOREIGN KEY(scope,context_id) REFERENCES history_contexts(scope,id));
      CREATE INDEX IF NOT EXISTS plays_recent ON plays(scope,played_at DESC);
      CREATE INDEX IF NOT EXISTS plays_track ON plays(scope,track_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS play_search USING fts5(scope UNINDEXED, id UNINDEXED, title, artist, album, origin, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS imports(scope TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS music_entities(scope TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,metadata TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS embeddings(scope TEXT NOT NULL,entity_id TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector BLOB NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,entity_id,model),FOREIGN KEY(scope,entity_id) REFERENCES music_entities(scope,id));`);
  }
  write(batch) {
    validateHistoryRequest('write', batch);
    const { scope, contexts, entries, importKey } = batch;
    if (typeof scope !== 'string' || !scope || scope.length > 2048 || !Array.isArray(contexts) || !Array.isArray(entries)) throw new Error('Invalid history batch');
    if (importKey && this.db.prepare('SELECT 1 FROM imports WHERE scope=? AND key=?').get(scope, importKey)) return;
    this.db.exec('BEGIN');
    try {
      const putContext = this.db.prepare('INSERT INTO history_contexts VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data');
      for (const context of contexts) {
        if (!context || typeof context.id !== 'string' || !Array.isArray(context.queue) || !['normal','shuffle','random'].includes(context.order) || !Array.isArray(context.permutation)) throw new Error('Invalid playback context');
        putContext.run(scope, context.id, JSON.stringify(context));
      }
      const put = this.db.prepare('INSERT OR IGNORE INTO plays VALUES(?,?,?,?,?,?,?,?,?,?)');
      const index = this.db.prepare('INSERT INTO play_search(scope,id,title,artist,album,origin) VALUES(?,?,?,?,?,?)');
      const entity = this.db.prepare('INSERT INTO music_entities VALUES(?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at');
      const cachedContexts = new Map(contexts.map(c => [c.id, c]));
      const getContext = this.db.prepare('SELECT data FROM history_contexts WHERE scope=? AND id=?');
      for (const entry of entries) {
        if (!cachedContexts.has(entry.contextId)) { const row = getContext.get(scope, entry.contextId); if (row) cachedContexts.set(entry.contextId, JSON.parse(row.data)); }
        const context = cachedContexts.get(entry.contextId);
        const track = context?.queue[entry.index];
        if (!track || typeof track.id !== 'string' || typeof track.rawId !== 'string' || typeof track.title !== 'string' || !['local', 'spotify'].includes(track.source) || typeof entry.id !== 'string' || !Number.isInteger(entry.index) || !Number.isInteger(entry.cursor) || !Number.isSafeInteger(entry.playedAt) || entry.playedAt <= 0 || entry.playedAt > 8640000000000000) throw new Error('Invalid listening event');
        const origin = track.playbackOrigin || context.origin;
        const result = put.run(scope, entry.id, entry.contextId, track.id, track.source, origin?.id ?? null, origin?.kind ?? null, entry.index, entry.cursor, entry.playedAt);
        if (result.changes) index.run(scope, entry.id, track.title, track.artist || '', track.album || '', origin?.title || '');
        entity.run(scope, track.id, track.source, 'track', JSON.stringify(track), entry.playedAt);
        if (origin) entity.run(scope, origin.id, origin.source, origin.kind, JSON.stringify(origin), entry.playedAt);
      }
      if (importKey) this.db.prepare('INSERT INTO imports VALUES(?,?)').run(scope, importKey);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(request) {
    validateHistoryRequest('list', request);
    const { scope, query = '', offset = 0 } = request;
    let { limit = 50 } = request;
    if (typeof scope !== 'string' || typeof query !== 'string' || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid history query');
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    const words = query.slice(0, 500).match(/[\p{L}\p{N}]+/gu) || [];
    const match = words.map(word => `"${word}"*`).join(' AND ');
    const filter = match ? ' AND p.id IN (SELECT id FROM play_search WHERE scope=? AND play_search MATCH ?)' : '';
    const params = match ? [scope, scope, match] : [scope];
    const total = this.db.prepare(`SELECT count(*) AS n FROM plays p WHERE p.scope=?${filter}`).get(...params).n;
    const rows = this.db.prepare(`SELECT p.id,p.queue_index AS 'index',p.cursor,p.played_at AS playedAt,p.context_id AS contextId FROM plays p WHERE p.scope=?${filter} ORDER BY p.played_at DESC,p.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const contexts = new Map();
    const getContext = this.db.prepare('SELECT data FROM history_contexts WHERE scope=? AND id=?');
    const entries = rows.map(({ contextId, ...entry }) => {
      if (!contexts.has(contextId)) contexts.set(contextId, (() => { const value = JSON.parse(getContext.get(scope, contextId).data); if (!isListeningContext(value)) throw new Error('Saved listening context is invalid'); return value; })());
      return { ...entry, context: contexts.get(contextId) };
    });
    return { entries, total, hasMore: offset + entries.length < total };
  }
  stats(request) {
    validateHistoryRequest('stats', request);
    const { scope } = request;
    if (typeof scope !== 'string' || !scope || scope.length > 2048) throw new Error('Invalid history scope');
    const counts = new Map();
    const add = (row) => { if (!row.id) return; const old = counts.get(row.id); counts.set(row.id, { plays: (old?.plays || 0) + row.plays, lastPlayed: Math.max(old?.lastPlayed || 0, row.lastPlayed) }); };
    for (const row of this.db.prepare('SELECT origin_id id,count(*) plays,max(played_at) lastPlayed FROM plays WHERE scope=? AND origin_id IS NOT NULL GROUP BY origin_id').all(scope)) add(row);
    for (const row of this.db.prepare(`SELECT json_extract(e.metadata,'$.albumId') id,count(*) plays,max(p.played_at) lastPlayed FROM plays p JOIN music_entities e ON e.scope=p.scope AND e.id=p.track_id WHERE p.scope=? AND json_extract(e.metadata,'$.albumId') IS NOT NULL AND (p.origin_id IS NULL OR p.origin_id<>json_extract(e.metadata,'$.albumId')) GROUP BY json_extract(e.metadata,'$.albumId')`).all(scope)) add(row);
    return Object.fromEntries(counts);
  }
  clear(request) {
    validateHistoryRequest('clear', request);
    const { scope } = request;
    this.db.exec('BEGIN');
    try {
      for (const table of ['play_search','plays','history_contexts']) this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
