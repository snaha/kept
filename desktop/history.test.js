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

test('[history.retry-pagination] Repeated failed reads retry one older window until it completes', { timeout: 5000 }, async t => {
  const harness = await pagedHistory(t, 'night');
  const { module: m, controls, settle } = harness;
  for (let attempt = 0; attempt < 2; attempt++) {
    controls.failNext('list');
    await m.searchHistory('night', true);
    assert.equal(m.listeningHistory.entries.length, 150);
    assert.ok(m.listeningHistory.error);
  }
  controls.failNext('list');
  m.retryHistory();
  await settle();
  assert.equal(m.listeningHistory.entries.length, 150);
  assert.ok(m.listeningHistory.error);
  m.retryHistory();
  await settle();
  assert.equal(m.listeningHistory.entries.length, 200, 'failed attempts cannot accumulate extra requested pages');
  assert.equal(m.listeningHistory.error, '');
  await assertDurableOrder(harness, 'night');
  await m.searchHistory('night', true);
  assert.equal(m.listeningHistory.entries.length, 250);
  await assertDurableOrder(harness, 'night');
});

test('[history.play-during-pagination] A nonmatching play still completes the pending filtered window', { timeout: 5000 }, async t => {
  const harness = await pagedHistory(t, 'night');
  const { module: m, controls, settle } = harness;
  const olderPage = controls.holdNext('list', args => args.offset === 150);
  const older = m.searchHistory('night', true);
  assert.equal((await olderPage.started).error, undefined);
  const day = { ...night, id: 'day', queue: [{ ...night.queue[0], title: 'Day song' }] };
  m.recordHistory(day, 0, 0);
  olderPage.release();
  await older;
  await settle();
  assert.equal(m.listeningHistory.entries.length, 200);
  assert.equal(m.listeningHistory.total, 400, 'a nonmatching play cannot enter or increase the filtered view');
  assert.equal(m.listeningHistory.error, '');
  await assertDurableOrder(harness, 'night');
});

test('[history.write-retry] A failed play write preserves a pending older window through Retry', { timeout: 5000 }, async t => {
  const harness = await pagedHistory(t, '');
  const { module: m, controls, settle } = harness;
  controls.failNext('list');
  await m.searchHistory('', true);
  controls.failNext('write');
  m.recordHistory(night, 0, 0);
  const id = m.listeningHistory.entries[0].id;
  await assert.rejects(settle(), /Unsaved listening events/);
  assert.equal(m.listeningHistory.entries.length, 151);
  m.retryHistory();
  await settle();
  assert.equal(m.listeningHistory.entries.length, 201, 'the optimistic play shifts the pending older window');
  assert.equal(m.listeningHistory.total, 401);
  assert.equal(m.listeningHistory.entries.filter(entry => entry.id === id).length, 1);
  assert.equal(m.listeningHistory.error, '');
  await assertDurableOrder(harness, '');
});

for (const intent of ['new query', 'same-query reset', 'clear', 'account switch']) {
  test(`[history.clear-account] ${intent} cancels an obsolete pagination window`, { timeout: 5000 }, async t => {
    const harness = await pagedHistory(t, 'night');
    const { module: m, controls, settle } = harness;
    const page = controls.holdNext('list', args => args.offset === 150);
    const older = m.searchHistory('night', true);
    assert.equal((await page.started).error, undefined);
    let replacement;
    if (intent === 'clear') m.clearHistory();
    else if (intent === 'account switch') {
      m.session.username = 'other';
      m.loadHistory();
    } else replacement = m.searchHistory(intent === 'new query' ? 'song' : 'night');
    page.release();
    await older;
    await replacement;
    await settle();
    assert.equal(m.listeningHistory.error, '');
    assert.equal(m.listeningHistory.loading, false);
    if (intent === 'clear' || intent === 'account switch') {
      assert.equal(m.listeningHistory.entries.length, 0, 'a late page cannot resurrect rows from the previous view');
      controls.requests.length = 0;
      m.recordHistory(night, 0, 0);
      await settle();
      assert.equal(m.listeningHistory.total, 1);
      assert.equal(m.listeningHistory.entries.length, 1);
      const reads = controls.requests.filter(request => request.method === 'list').map(request => request.args);
      assert.deepEqual(reads.map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 50 }]);
    } else {
      assert.equal(m.listeningHistory.query, intent === 'new query' ? 'song' : 'night');
      assert.equal(m.listeningHistory.entries.length, 50, 'an explicit search owns its first-page window');
      await assertDurableOrder(harness, m.listeningHistory.query);
    }
  });
}

test('[history.search] Load older after a failed new search starts that query at its first page', { timeout: 5000 }, async t => {
  const harness = await pagedHistory(t, 'night');
  const { module: m, controls } = harness;
  controls.failNext('list');
  await m.searchHistory('song');
  assert.equal(m.listeningHistory.entries.length, 150, 'the successful prior view remains during the failed search');
  assert.ok(m.listeningHistory.error);
  await m.searchHistory('song', true);
  assert.equal(m.listeningHistory.entries.length, 50, 'the prior query length cannot become the new query offset');
  assert.equal(m.listeningHistory.error, '');
  await assertDurableOrder(harness, 'song');
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

test('play reconciliation uses one page at every loaded depth and preserves matching filtered tails', { timeout: 10000 }, async t => {
  const { module: m, database, controls } = await createHistoryHarness(t, { username: 'cost' });
  const reads = () => controls.requests.filter(request => request.method === 'list').map(request => request.args);
  const context = { id: 'night', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Night song', album: 'Album', cover: '', available: true }], order: 'normal', permutation: [] };
  const other = { ...context, id: 'day', queue: [{ ...context.queue[0], title: 'Day song' }] };
  await database.call('write', { version: 1, scope: 'desktop:cost', contexts: [context], entries: Array.from({ length: 450 }, (_, i) => ({ id: `seed-${i}`, contextId: context.id, index: 0, cursor: 0, playedAt: i + 1 })) });
  m.loadHistory(); await m.searchHistory('');
  for (const depth of [50, 150, 350, 450]) {
    await m.searchHistory('');
    while (m.listeningHistory.entries.length < depth) await m.searchHistory('', true);
    const before = m.listeningHistory.entries.map(entry => entry.id);
    const total = m.listeningHistory.total;
    controls.requests.length = 0;
    m.recordHistory(context, 0, 0);
    await m.historyStats(); await waitForHistory(m.listeningHistory);
    assert.deepEqual(reads().map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 50 }], `routine play at ${depth} rows reads exactly one page`);
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
  controls.requests.length = 0;
  m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(reads().length, 1); assert.equal(m.listeningHistory.hasMore, false);
  assert.equal(m.listeningHistory.entries.length, m.listeningHistory.total);
  await m.searchHistory('night'); await m.searchHistory('night', true); await m.searchHistory('night', true);
  const filtered = m.listeningHistory.entries.map(entry => entry.id);
  const total = m.listeningHistory.total;
  controls.requests.length = 0;
  m.recordHistory(other, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(reads().length, 1);
  assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), filtered);
  assert.equal(m.listeningHistory.total, total);
  controls.requests.length = 0;
  m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(reads().length, 1);
  assert.deepEqual(m.listeningHistory.entries.slice(1).map(entry => entry.id), filtered);
  assert.equal(m.listeningHistory.total, total + 1);
  assert.equal(new Set(m.listeningHistory.entries.map(entry => entry.id)).size, filtered.length + 1, 'authoritative page merges by event ID');
  controls.setFailure('write', new Error('disk unavailable'));
  m.recordHistory(context, 0, 0);
  await assert.rejects(m.historyStats(), /Unsaved/); await waitForHistory(m.listeningHistory);
  assert.ok(m.listeningHistory.error);
  controls.requests.length = 0;
  controls.setFailure('write'); m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.deepEqual(reads().map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 50 }], 'retry also reconciles one page');
  assert.equal(m.listeningHistory.entries.length, filtered.length + 2);
  assert.deepEqual(m.listeningHistory.entries.slice(2).map(entry => entry.id), filtered);
  assert.equal(m.listeningHistory.total, total + 2);
  assert.equal(m.listeningHistory.error, '');

  controls.setFailure('list', new Error('read unavailable'));
  const beforeReadFailure = m.listeningHistory.entries.map(entry => entry.id);
  m.recordHistory(context, 0, 0); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), beforeReadFailure, 'failed reconciliation keeps the successful filtered view');
  assert.ok(m.listeningHistory.error);
  controls.setFailure('list'); m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.deepEqual(m.listeningHistory.entries.slice(1).map(entry => entry.id), beforeReadFailure);

  const changedQuery = controls.holdNext('list');
  const daySearch = m.searchHistory('day'); await changedQuery.started;
  m.recordHistory(other, 0, 0);
  changedQuery.release(); await daySearch; await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(m.listeningHistory.total, 2);
  assert.equal(m.listeningHistory.entries.length, 2);
  assert.ok(m.listeningHistory.entries.every(entry => entry.context.queue[entry.index].title === 'Day song'), 'a play during a changed query cannot merge the previous query tail');

  const competingPlay = controls.holdNext('list');
  m.recordHistory(other, 0, 0); await competingPlay.started;
  m.recordHistory(other, 0, 0);
  competingPlay.release(); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(m.listeningHistory.total, 4);
  assert.equal(m.listeningHistory.entries.length, 4, 'a newer play supersedes a stale first-page response without losing either event');

  const beforeClear = controls.holdNext('list');
  m.recordHistory(other, 0, 0); await beforeClear.started;
  m.clearHistory(); beforeClear.release(); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(m.listeningHistory.total, 0); assert.equal(m.listeningHistory.entries.length, 0, 'late reconciliation cannot resurrect cleared entries');

  const beforeAccount = controls.holdNext('list');
  m.recordHistory(other, 0, 0); await beforeAccount.started;
  m.session.username = 'other'; m.loadHistory(); const otherSearch = m.searchHistory('');
  beforeAccount.release(); await otherSearch;
  assert.equal(m.listeningHistory.total, 0); assert.equal(m.listeningHistory.entries.length, 0, 'late reconciliation cannot cross accounts');
});

test('reconciliation drops a disconnected filtered tail so older pages remain contiguous', { timeout: 10000 }, async t => {
  const { module: m, database, controls } = await createHistoryHarness(t, { username: 'gap' });
  const context = { id: 'night', queue: [{ id: 'local:track:1', rawId: '1', source: 'local', title: 'Night song', cover: '', available: true }], order: 'normal', permutation: [] };
  await database.call('write', { version: 1, scope: 'desktop:gap', contexts: [context], entries: Array.from({ length: 160 }, (_, i) => ({ id: `seed-${i}`, contextId: context.id, index: 0, cursor: 0, playedAt: i + 1 })) });
  m.loadHistory(); await m.searchHistory('night'); await m.searchHistory('night', true);
  const before = m.listeningHistory.entries.map(entry => entry.id);
  controls.setFailure('list', new Error('read unavailable'));
  for (let i = 0; i < 60; i++) m.recordHistory(context, 0, 0);
  await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), before, 'failed reads retain the successful view');
  controls.setFailure('list'); m.retryHistory(); await m.historyStats(); await waitForHistory(m.listeningHistory);
  assert.equal(m.listeningHistory.entries.length, 50, 'a page with no connection to the loaded tail replaces it');
  assert.equal(m.listeningHistory.hasMore, true);
  await m.searchHistory('night', true);
  const expected = await database.call('list', { scope: 'desktop:gap', query: 'night', offset: 0, limit: 100 });
  assert.deepEqual(m.listeningHistory.entries.map(entry => entry.id), expected.entries.map(entry => entry.id), 'Load older plays returns exactly the next contiguous page');
  assert.equal(m.listeningHistory.total, 220);
});
