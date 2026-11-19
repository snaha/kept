import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MusicStore } from './music-store.js';
import { MusicDatabase } from './music-database.js';
const track = { id: 'local:track:1', rawId: '1', source: 'local', title: 'Déjà Vu', artist: 'An Artist', album: 'Original album', cover: '', available: true };
const context = (id, kind, title) => ({ id, queue: [track, { ...track }], origin: { id: `local:${kind}:${id}`, rawId: id, source: 'local', kind, title, cover: '' }, order: 'shuffle', permutation: [1, 0] });
const entry = (id, contextId, playedAt = 1000, index = 1) => ({ id, contextId, index, cursor: 0, playedAt });

test('SQLite history keeps source, duplicate position, search, old plays and migration across restarts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-'));
  const file = path.join(directory, 'music.sqlite');
  let store = new MusicStore(file);
  try {
    const playlist = context('playlist', 'playlist', 'Late night mix');
    const album = context('album', 'album', 'Original album');
    const entries = Array.from({ length: 135 }, (_, i) => entry(`play-${i}`, i % 2 ? 'playlist' : 'album', 1000 + i));
    store.write({ scope: 'a', contexts: [playlist, album], entries, importKey: 'legacy' });
    store.write({ scope: 'a', contexts: [playlist], entries: [entry('must-not-import', 'playlist')], importKey: 'legacy' });
    store.write({ scope: 'b', contexts: [playlist], entries: [entry('other-user', 'playlist')] });
    store.close(); store = new MusicStore(file);
    const first = store.list({ scope: 'a' });
    assert.equal(first.total, 135); assert.equal(first.entries.length, 50); assert.equal(first.hasMore, true);
    assert.equal(store.list({ scope: 'a', offset: 100 }).entries.length, 35);
    const playlistSearch = store.list({ scope: 'a', query: 'late night' });
    assert.equal(playlistSearch.total, 67);
    assert.equal(playlistSearch.entries[0].context.origin.kind, 'playlist');
    assert.equal(playlistSearch.entries[0].index, 1);
    assert.deepEqual(playlistSearch.entries[0].context.permutation, [1, 0]);
    assert.equal(store.list({ scope: 'a', query: 'deja' }).total, 135, 'accent insensitive search');
    assert.equal(store.list({ scope: 'a', query: '" NOT *' }).total, 0, 'FTS syntax is treated as words');
    assert.equal(store.list({ scope: 'b' }).total, 1, 'account isolation');
    playlist.queue.push({ ...track, id: 'local:track:2', rawId: '2' });
    store.write({ scope: 'a', contexts: [playlist], entries: [entries[1]] });
    assert.equal(store.list({ scope: 'a', query: 'late' }).entries[0].context.queue.length, 3, 'late pages update the snapshot');
    assert.equal(store.list({ scope: 'a' }).total, 135, 'idempotent writes');
    assert.throws(() => store.write({ scope: 'a', contexts: [context('rollback','album','Rollback')], entries: [entry('bad','rollback',1000,99)] }));
    assert.equal(store.db.prepare('SELECT count(*) n FROM history_contexts WHERE id=?').get('rollback').n, 0, 'bad batch rolls back context too');
    store.write({ scope: 'ties', contexts: [album], entries: [entry('z-first', 'album', 2000), entry('a-second', 'album', 2000)] });
    assert.deepEqual(store.list({ scope: 'ties' }).entries.map(e => e.id), ['a-second', 'z-first'], 'equal timestamps retain actual insertion order');
    store.clear({ scope: 'a' });
    store.write({ scope: 'a', contexts: [album], entries: [entries[0]], importKey: 'legacy' });
    assert.equal(store.list({ scope: 'a' }).total, 0, 'cleared history does not reimport');
    assert.equal(store.list({ scope: 'b' }).total, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('worker serializes writes and queries and closes only after queued writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-worker-'));
  const database = new MusicDatabase(path.join(directory, 'music.sqlite'));
  try {
    const write = database.call('write', { scope: 'a', contexts: [context('p','playlist','Mix')], entries: [entry('play','p')] });
    const result = database.call('list', { scope: 'a' });
    await write; assert.equal((await result).total, 1);
    await assert.rejects(database.call('write', { scope: 'a', contexts: [], entries: [entry('bad','missing')] }));
    assert.equal((await database.call('list', { scope: 'a' })).total, 1, 'worker survives invalid batch');
    const queued = database.call('write', { scope: 'a', contexts: [], entries: [entry('last-play', 'p', 2000)] });
    await database.close(); await queued;
    const reopened = new MusicStore(path.join(directory, 'music.sqlite'));
    try { assert.equal(reopened.list({ scope: 'a' }).total, 2, 'shutdown drains accepted writes'); } finally { reopened.close(); }
  } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('history rows carry an optional catalog ref of either kind and legacy rows still load', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-ref-'));
  const store = new MusicStore(path.join(directory, 'music.sqlite'));
  try {
    const asset = { ...track, id: 'local:track:occurrence:a:b', rawId: 'asset:b', catalogRef: { kind: 'asset', id: 'asset:b' } };
    const navidrome = { ...track, catalogRef: { kind: 'navidrome', id: '1' } };
    const mixed = { id: 'mixed', queue: [track, asset, navidrome], order: 'normal', permutation: [] };
    store.write({ scope: 'a', contexts: [mixed], entries: [entry('legacy', 'mixed', 1000, 0), entry('virtual', 'mixed', 2000, 1), entry('nd', 'mixed', 3000, 2)] });
    const rows = store.list({ scope: 'a' }).entries;
    assert.deepEqual(rows.map(row => row.id), ['nd', 'virtual', 'legacy']);
    assert.deepEqual(rows[1].context.queue[1].catalogRef, { kind: 'asset', id: 'asset:b' });
    assert.equal(rows[2].context.queue[0].catalogRef, undefined, 'a legacy row stays without a ref');
    const bad = { ...mixed, id: 'bad', queue: [{ ...track, catalogRef: { kind: 'file', id: '/etc/passwd' } }] };
    assert.throws(() => store.write({ scope: 'a', contexts: [bad], entries: [entry('bad-entry', 'bad', 4000, 0)] }), /Invalid history batch/);
    assert.equal(store.list({ scope: 'a' }).total, 3);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
