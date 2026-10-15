import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, transform } from 'esbuild';
import { compileModule } from '../frontend/tests/runes-compiler.mjs';
import { MusicDatabase } from './music-database.js';

async function waitForHistory(history) {
  const deadline = Date.now() + 2000;
  while (history.loading) {
    assert.ok(Date.now() < deadline, 'history refresh did not settle');
    await new Promise(setImmediate);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function historyModule() {
  const output = await build({
    stdin: { contents: "export * from './src/lib/listening-history.svelte.ts'; export {session} from './src/lib/api.svelte.ts';", resolveDir: new URL('../frontend/', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', conditions: ['browser'],
    plugins: [{ name: 'runes', setup(builder) { builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = await transform(await readFile(path, 'utf8'), { loader: 'ts' });
      return { contents: compileModule(source.code, { filename: path, generate: 'client' }).js.code, loader: 'js' };
    }); } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
}

test('frontend migrates to the worker, pages and searches history, isolates users and ignores stale reads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-ui-'));
  const database = new MusicDatabase(path.join(directory, 'music.sqlite'));
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  let unavailable = false;
  const bridge = {
    write: args => unavailable ? Promise.reject(new Error('disk unavailable')) : database.call('write', args), list: args => database.call('list', args), clear: scope => database.call('clear', { scope }),
  };
  globalThis.window = { desktop: {}, musicHistory: bridge };
  const m = await historyModule();
  const context = { id: 'context', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Song', album: 'Album', cover: 'signed-secret-artwork', available: true }], order: 'normal', permutation: [], origin: { id: 'local:playlist:p', rawId: 'p', source: 'local', kind: 'playlist', title: 'Night mix', cover: 'signed-secret-artwork' } };
  try {
    m.session.base = 'http://127.0.0.1:1234'; m.session.username = 'admin';
    // Origin migration canonicalizes desktop history before the renderer loads it.
    const legacyKey = 'music.history.v1:desktop:admin';
    const legacy = JSON.stringify({ contexts: [context], entries: [{ id: 'legacy', contextId: context.id, index: 0, cursor: 0, playedAt: 1000 }] });
    storage.set(legacyKey, legacy);
    m.loadHistory();
    assert.equal(m.listeningHistory.entries.length, 1, 'legacy loads synchronously');
    for (let i = 0; i < 120; i++) m.recordHistory(context, 0, 0);
    await m.searchHistory('');
    assert.equal(m.listeningHistory.total, 121);
    assert.equal(m.listeningHistory.entries.length, 50);
    const persisted = await bridge.list({ scope: 'desktop:admin' });
    assert.ok((await bridge.list({ scope: 'desktop:admin', query: 'night', offset: 100 })).entries.some(entry => entry.id === 'legacy'), 'legacy entry reaches the durable journal');
    assert.equal(storage.get(legacyKey), legacy, 'migration retains the browser backup');
    assert.equal(persisted.entries[0].context.queue[0].cover, '', 'signed cover URL is not persisted');
    assert.equal(persisted.entries[0].context.origin.cover, '');
    await m.searchHistory('', true); assert.equal(m.listeningHistory.entries.length, 100);
    const oldestLoaded = m.listeningHistory.entries.at(-1).id;
    m.recordHistory(context, 0, 0);
    await m.historyStats();
    await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.entries.length, 101, 'recording playback preserves loaded history pages');
    assert.equal(m.listeningHistory.entries.at(-1).id, oldestLoaded);
    assert.equal(m.listeningHistory.hasMore, true);
    await m.searchHistory('night'); assert.equal(m.listeningHistory.total, 122);
    await m.searchHistory('absent'); assert.equal(m.listeningHistory.total, 0);
    m.recordHistory(context, 0, 0);
    assert.equal(m.listeningHistory.entries.length, 0, 'a nonmatching play never flashes into filtered history');
    await m.historyStats();
    m.session.base = 'http://127.0.0.1:4321'; m.loadHistory(); await m.searchHistory('');
    assert.equal(m.listeningHistory.total, 123, 'desktop history survives a port change');
    const stale = m.searchHistory('night');
    m.session.username = 'other'; m.loadHistory(); await m.searchHistory(''); await stale;
    assert.equal(m.listeningHistory.total, 0);
    m.session.username = 'admin'; m.loadHistory(); await m.searchHistory('');
    await m.searchHistory('', true);
    const oldestBeforeRetry = m.listeningHistory.entries.at(-1).id;
    unavailable = true; m.recordHistory(context, 0, 0); await m.searchHistory('');
    assert.equal(m.listeningHistory.entries.length, 101, 'failed write keeps the new play and loaded pages visible');
    assert.ok(m.listeningHistory.error);
    unavailable = false; m.retryHistory(); await m.historyStats();
    await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.total, 124, 'retry saves the original event without duplication');
    assert.equal(m.listeningHistory.entries.length, 101, 'retry itself preserves the loaded page window');
    assert.equal(m.listeningHistory.entries.at(-1).id, oldestBeforeRetry);
    assert.equal(m.listeningHistory.error, '');
    const beforeClear = m.searchHistory('night'); m.clearHistory(); await beforeClear; await m.searchHistory('');
    assert.equal(m.listeningHistory.total, 0, 'late reads do not undo clear');
    m.session.username = 'other'; m.loadHistory(); await m.searchHistory('');
    m.session.username = 'admin'; m.loadHistory(); await m.searchHistory('');
    assert.equal(m.listeningHistory.total, 0, 'migration never resurrects cleared history');
    m.clearHistory(); m.recordHistory(context, 0, 0); await m.searchHistory('');
    assert.equal(m.listeningHistory.total, 1, 'a play immediately after clear survives the asynchronous clear');
  } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('play reconciliation uses one page at every loaded depth and preserves matching filtered tails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-cost-'));
  const database = new MusicDatabase(path.join(directory, 'music.sqlite'));
  const requests = [];
  let unavailable = false;
  let readUnavailable = false;
  let gate;
  const bridge = {
    write: args => unavailable ? Promise.reject(new Error('disk unavailable')) : database.call('write', args),
    list: async args => {
      requests.push(args);
      if (readUnavailable) throw new Error('read unavailable');
      const pending = gate;
      gate = undefined;
      const result = await database.call('list', args);
      if (pending) { pending.started.resolve(); await pending.release.promise; }
      return result;
    },
    clear: scope => database.call('clear', { scope }),
    stats: args => database.call('stats', args),
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { desktop: {}, musicHistory: bridge };
  const m = await historyModule();
  const context = { id: 'night', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Night song', album: 'Album', cover: '', available: true }], order: 'normal', permutation: [] };
  const other = { ...context, id: 'day', queue: [{ ...context.queue[0], title: 'Day song' }] };
  try {
    m.session.username = 'cost';
    await database.call('write', { version: 1, scope: 'desktop:cost', contexts: [context], entries: Array.from({ length: 450 }, (_, i) => ({ id: `seed-${i}`, contextId: context.id, index: 0, cursor: 0, playedAt: i + 1 })) });
    m.loadHistory(); await m.searchHistory('');
    for (const depth of [50, 150, 350, 450]) {
      await m.searchHistory('');
      while (m.listeningHistory.entries.length < depth) await m.searchHistory('', true);
      const before = m.listeningHistory.entries.map(entry => entry.id);
      const total = m.listeningHistory.total;
      requests.length = 0;
      m.recordHistory(context, 0, 0);
      await m.historyStats(); await waitForHistory(m.listeningHistory);
      assert.deepEqual(requests.map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 50 }], `routine play at ${depth} rows reads exactly one page`);
      assert.deepEqual(m.listeningHistory.entries.slice(1).map(entry => entry.id), before, 'loaded rows keep their surviving order');
      assert.equal(m.listeningHistory.total, total + 1);
      assert.equal(m.listeningHistory.hasMore, m.listeningHistory.entries.length < total + 1);
      if (m.listeningHistory.hasMore) {
        const loaded = m.listeningHistory.entries.map(entry => entry.id);
        const next = await database.call('list', { scope: 'desktop:cost', query: '', offset: loaded.length, limit: 50 });
        await m.searchHistory('', true);
        assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), [...loaded, ...next.entries.map(entry => entry.id)], 'pagination after a connected reconciliation returns the next contiguous rows');
      }
    }
    // Fully loaded history stays fully loaded after insertion and reconciliation.
    while (m.listeningHistory.hasMore) await m.searchHistory('', true);
    requests.length = 0;
    m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(requests.length, 1); assert.equal(m.listeningHistory.hasMore, false);
    assert.equal(m.listeningHistory.entries.length, m.listeningHistory.total);
    await m.searchHistory('night'); await m.searchHistory('night', true); await m.searchHistory('night', true);
    const filtered = m.listeningHistory.entries.map(entry => entry.id);
    const total = m.listeningHistory.total;
    requests.length = 0;
    m.recordHistory(other, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(requests.length, 1);
    assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), filtered);
    assert.equal(m.listeningHistory.total, total);
    requests.length = 0;
    m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(requests.length, 1);
    assert.deepEqual(m.listeningHistory.entries.slice(1).map(entry => entry.id), filtered);
    assert.equal(m.listeningHistory.total, total + 1);
    assert.equal(new Set(m.listeningHistory.entries.map(entry => entry.id)).size, filtered.length + 1, 'authoritative page merges by event ID');
    unavailable = true;
    m.recordHistory(context, 0, 0);
    await assert.rejects(m.historyStats(), /Unsaved/); await waitForHistory(m.listeningHistory);
    assert.ok(m.listeningHistory.error);
    requests.length = 0;
    unavailable = false; m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.deepEqual(requests.map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 50 }], 'retry also reconciles one page');
    assert.equal(m.listeningHistory.entries.length, filtered.length + 2);
    assert.deepEqual(m.listeningHistory.entries.slice(2).map(entry => entry.id), filtered);
    assert.equal(m.listeningHistory.total, total + 2);
    assert.equal(m.listeningHistory.error, '');

    readUnavailable = true;
    const beforeReadFailure = m.listeningHistory.entries.map(entry => entry.id);
    m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), beforeReadFailure, 'failed reconciliation keeps the successful filtered view');
    assert.ok(m.listeningHistory.error);
    readUnavailable = false; m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.deepEqual(m.listeningHistory.entries.slice(1).map(entry => entry.id), beforeReadFailure);

    const changedQuery = { started: deferred(), release: deferred() }; gate = changedQuery;
    const daySearch = m.searchHistory('day'); await changedQuery.started.promise;
    m.recordHistory(other, 0, 0);
    changedQuery.release.resolve(); await daySearch; await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.total, 2);
    assert.equal(m.listeningHistory.entries.length, 2);
    assert.ok(m.listeningHistory.entries.every(entry => entry.context.queue[entry.index].title === 'Day song'), 'a play during a changed query cannot merge the previous query tail');

    const competingPlay = { started: deferred(), release: deferred() }; gate = competingPlay;
    m.recordHistory(other, 0, 0); await competingPlay.started.promise;
    m.recordHistory(other, 0, 0);
    competingPlay.release.resolve(); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.total, 4);
    assert.equal(m.listeningHistory.entries.length, 4, 'a newer play supersedes a stale first-page response without losing either event');

    const beforeClear = { started: deferred(), release: deferred() }; gate = beforeClear;
    m.recordHistory(other, 0, 0); await beforeClear.started.promise;
    m.clearHistory(); beforeClear.release.resolve(); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.total, 0); assert.equal(m.listeningHistory.entries.length, 0, 'late reconciliation cannot resurrect cleared entries');

    const beforeAccount = { started: deferred(), release: deferred() }; gate = beforeAccount;
    m.recordHistory(other, 0, 0); await beforeAccount.started.promise;
    m.session.username = 'other'; m.loadHistory(); const otherSearch = m.searchHistory('');
    beforeAccount.release.resolve(); await otherSearch;
    assert.equal(m.listeningHistory.total, 0); assert.equal(m.listeningHistory.entries.length, 0, 'late reconciliation cannot cross accounts');
  } finally { m.disposeHistory(); await m.historyStats(); await database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reconciliation drops a disconnected filtered tail so older pages remain contiguous', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-gap-'));
  const database = new MusicDatabase(path.join(directory, 'music.sqlite'));
  let readUnavailable = false;
  const bridge = {
    write: args => database.call('write', args),
    list: args => readUnavailable ? Promise.reject(new Error('read unavailable')) : database.call('list', args),
    clear: scope => database.call('clear', { scope }),
    stats: args => database.call('stats', args),
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { desktop: {}, musicHistory: bridge };
  const m = await historyModule();
  const context = { id: 'night', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Night song', cover: '', available: true }], order: 'normal', permutation: [] };
  try {
    m.session.username = 'gap';
    await database.call('write', { version: 1, scope: 'desktop:gap', contexts: [context], entries: Array.from({ length: 160 }, (_, i) => ({ id: `seed-${i}`, contextId: context.id, index: 0, cursor: 0, playedAt: i + 1 })) });
    m.loadHistory(); await m.searchHistory('night'); await m.searchHistory('night', true);
    const before = m.listeningHistory.entries.map(entry => entry.id);
    readUnavailable = true;
    for (let i = 0; i < 60; i++) m.recordHistory(context, 0, 0);
    await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), before, 'failed reads retain the successful view');
    readUnavailable = false; m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.equal(m.listeningHistory.entries.length, 50, 'a page with no connection to the loaded tail replaces it');
    assert.equal(m.listeningHistory.hasMore, true);
    await m.searchHistory('night', true);
    const expected = await database.call('list', { scope: 'desktop:gap', query: 'night', offset: 0, limit: 100 });
    assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), expected.entries.map(entry => entry.id), 'Load older plays returns exactly the next contiguous page');
    assert.equal(m.listeningHistory.total, 220);
  } finally { m.disposeHistory(); await m.historyStats().catch(() => {}); await database.close(); await rm(directory, { recursive: true, force: true }); }
});
