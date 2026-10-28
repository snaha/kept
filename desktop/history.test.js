import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryHarness, waitForHistory } from './tests/history-harness.mjs';

test('frontend migrates to the worker, pages and searches history, isolates users and ignores stale reads', async t => {
  const { module: m, database, storage, controls } = await createHistoryHarness(t, { username: 'admin', stats: false });
  const bridge = window.musicHistory;
  const context = { id: 'context', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Song', album: 'Album', cover: 'signed-secret-artwork', available: true }], order: 'normal', permutation: [], origin: { id: 'local:playlist:p', rawId: 'p', source: 'local', kind: 'playlist', title: 'Night mix', cover: 'signed-secret-artwork' } };
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
  controls.setFailure('write', new Error('disk unavailable')); m.recordHistory(context, 0, 0); await m.searchHistory('');
  assert.equal(m.listeningHistory.entries.length, 101, 'failed write keeps the new play and loaded pages visible');
  assert.ok(m.listeningHistory.error);
  controls.setFailure('write'); m.retryHistory(); await m.historyStats();
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
});

const night = { id: 'night', queue: [{ id: 'local:track:night', rawId: 'night', source: 'local', title: 'Night song', album: 'Album', cover: '', available: true }], order: 'normal', permutation: [] };

async function pagedHistory(t, query) {
  const harness = await createHistoryHarness(t);
  const { module: m, database } = harness;
  await database.call('write', {
    version: 1, scope: 'desktop:history-test', contexts: [night],
    entries: Array.from({ length: 400 }, (_, i) => ({ id: `seed-${i}`, contextId: night.id, index: 0, cursor: 0, playedAt: i + 1 })),
  });
  m.loadHistory();
  await m.searchHistory(query);
  await m.searchHistory(query, true);
  await m.searchHistory(query, true);
  assert.equal(m.listeningHistory.entries.length, 150);
  return harness;
}

async function assertDurableOrder(harness, query) {
  const actual = harness.module.listeningHistory.entries.map(entry => entry.id);
  const expected = [];
  while (expected.length < actual.length) {
    const page = await harness.database.call('list', {
      scope: 'desktop:history-test', query, offset: expected.length,
      limit: Math.min(100, actual.length - expected.length),
    });
    assert.ok(page.entries.length, 'the visible window cannot exceed durable history');
    expected.push(...page.entries.map(entry => entry.id));
  }
  assert.deepEqual(actual, expected, 'the loaded window matches contiguous database order');
}

for (const query of ['', 'night']) {
  const view = query ? 'filtered' : 'unfiltered';
  test(`[history.retry-pagination] Retry completes a failed Load older request in ${view} history`, { timeout: 5000 }, async t => {
    const harness = await pagedHistory(t, query);
    const { module: m, controls, settle } = harness;
    const before = m.listeningHistory.entries.map(entry => entry.id);
    controls.failNext('list', new Error('older page unavailable'), args => args.offset === 150);
    await m.searchHistory(query, true);
    assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), before);
    assert.ok(m.listeningHistory.error);
    assert.equal(m.listeningHistory.loading, false);

    m.retryHistory();
    await settle();
    assert.equal(m.listeningHistory.entries.length, 200, 'Retry completes the requested window without another Load older click');
    assert.deepEqual(m.listeningHistory.entries.slice(0, 150).map(entry => entry.id), before);
    assert.equal(m.listeningHistory.error, '');
    assert.equal(m.listeningHistory.loading, false);
    assert.equal(m.listeningHistory.hasMore, true);
    await assertDurableOrder(harness, query);
  });

  test(`[history.play-during-pagination] A play preserves an outstanding Load older request in ${view} history`, { timeout: 5000 }, async t => {
    const harness = await pagedHistory(t, query);
    const { module: m, controls, settle } = harness;
    const olderPage = controls.holdNext('list', args => args.offset === 150);
    const older = m.searchHistory(query, true);
    const started = await olderPage.started;
    assert.equal(started.error, undefined);
    const refresh = controls.holdNext('list', args => args.offset === 0);
    m.recordHistory(night, 0, 0);
    olderPage.release();
    await older;
    const refreshing = await refresh.started;
    assert.equal(refreshing.error, undefined);
    assert.equal(m.listeningHistory.loading, true, 'the stale older response cannot clear the newer operation status');
    refresh.release();
    await settle();

    assert.ok(m.listeningHistory.entries.length >= 200, 'playback must still complete the pending 200-row window');
    assert.equal(m.listeningHistory.total, 401);
    assert.equal(m.listeningHistory.error, '');
    assert.equal(m.listeningHistory.loading, false);
    await assertDurableOrder(harness, query);
    // The following page must also connect: a row-count check alone misses gaps.
    await m.searchHistory(query, true);
    await assertDurableOrder(harness, query);
  });
}

test('[history.write-retry] A lost write acknowledgement retains the play and retries without duplication', { timeout: 5000 }, async t => {
  const harness = await pagedHistory(t, '');
  const { module: m, controls, settle } = harness;
  const write = controls.holdNext('write');
  m.recordHistory(night, 0, 0);
  const id = m.listeningHistory.entries[0].id;
  const committed = await write.started;
  assert.equal(committed.error, undefined);
  write.reject(new Error('write acknowledgement lost'));
  await assert.rejects(settle(), /Unsaved listening events/);
  assert.ok(m.listeningHistory.error);
  assert.equal(m.listeningHistory.entries[0].id, id);

  m.retryHistory();
  await settle();
  assert.equal(m.listeningHistory.total, 401);
  assert.equal(m.listeningHistory.entries.filter(entry => entry.id === id).length, 1);
  assert.equal(m.listeningHistory.error, '');
  await assertDurableOrder(harness, '');
});

test('history harness teardown releases held responses, stops its worker and restores globals', { timeout: 5000 }, async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const { module: m, controls, database, close } = await pagedHistory(t, 'night');
  const page = controls.holdNext('list');
  const pending = m.searchHistory('night', true);
  await page.started;
  await close();
  await pending;
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'window'), originalWindow);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), originalStorage);
  await assert.rejects(database.call('list', { scope: 'desktop:history-test' }), /closing|stopped/);
});
