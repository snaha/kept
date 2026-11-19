import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, transform } from 'esbuild';
import { compileModule } from '../frontend/tests/runes-compiler.mjs';
import { createCatalogBridge } from '../shared/catalog-bridge.js'
import { CatalogDatabase } from './catalog-database.js'

test('actual local player works without randomUUID: collections, audio, queue occurrences and history replay', async (t) => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })
  t.after(() => Object.defineProperty(globalThis, 'crypto', originalCrypto))
  const output = await build({
    stdin: { contents: `
      export * from './src/lib/player.svelte.ts'
      export { listeningHistory, clearHistory, loadHistory, searchHistory } from './src/lib/listening-history.svelte.ts'
      export { session } from './src/lib/api.svelte.ts'
      export { playbackResolver } from './src/lib/playback-ref.ts'
      export { library, setMode, pick, addCollection, grid as libraryGrid, songsOf } from './src/lib/library.svelte.ts'
      export { registerBrowseSource } from './src/lib/browse-source.ts'
      export { catalogSource, setCatalogEnabled } from './src/lib/catalog-source.svelte.ts'
    `, resolveDir: new URL('../frontend/', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', conditions: ['browser'],
    plugins: [{ name: 'svelte-runes', setup(builder) {
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const source = await transform(await readFile(path, 'utf8'), { loader: 'ts', target: 'es2023' });
        return { contents: compileModule(source.code, { filename: path, generate: 'client' }).js.code, loader: 'js' };
      });
    } }],
  });
  const storage = new Map(), audioElements = [];
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = {};
  globalThis.Audio = class extends EventTarget {
    currentTime = 0; duration = 180; src = ''; paused = true;
    constructor() { super(); audioElements.push(this); }
    async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    load() {} removeAttribute() { this.src = ''; }
  };
  globalThis.Image = class { set src(value) { queueMicrotask(() => this.onload?.()); } };
  const m = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
  const local = { id: 'local:track:1', rawId: '1', source: 'local', title: 'Local song', cover: '', duration: 180, available: true };
  const other = { ...local, id: 'local:track:2', rawId: '2', title: 'Second song' };
  const origin = { id: 'local:playlist:mix', rawId: 'mix', source: 'local', kind: 'playlist', title: 'Night mix', cover: '', count: 3, available: true };
  const child = track => ({ id: track.rawId, title: track.title, duration: track.duration });
  const response = value => ({ status: 'ok', ...value });
  const scrobbles = [];
  m.session.base = 'http://127.0.0.1:1234'; m.session.username = 'audit';
  m.session.api = {
    scrobble: async value => { scrobbles.push(value); return response({}); },
    getPlaylist: async () => response({ playlist: { entry: [child(local), child(other), child(local)] } }),
    getAlbumList2: async () => response({ albumList2: { album: [{ id: 'album', name: 'Local album', songCount: 2 }] } }),
    getPlaylists: async () => response({ playlists: { playlist: [{ id: 'mix', name: 'Night mix', songCount: 3 }] } }),
  };
  try {
    await m.pick(origin); await settle();
    assert.equal(m.player.playing, true); assert.deepEqual(m.player.queue.map(t => t.id), [local.id, other.id, local.id]);
    assert.equal(m.collectionPlayback(origin).listening, true);
    const collectionTracks = m.player.queue.map(track => ({ ...track }));
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 0), true);
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 2), false, 'only the selected duplicate occurrence is current');
    assert.equal(audioElements[0].paused, false); assert.match(audioElements[0].src, /id=1/);
    m.setVolume(42); assert.equal(audioElements[0].volume, .42); assert.equal(storage.get('music.volume'), '42');
    m.setVolume(200); assert.equal(m.player.volume, 100);
    await m.seek(.5); assert.equal(audioElements[0].currentTime, 90);
    audioElements[0].currentTime = 100; audioElements[0].dispatchEvent(new Event('timeupdate'));
    assert.equal(m.player.time, 100); assert.ok(scrobbles.some(entry => entry.submission));
    await m.pause(); assert.equal(m.player.playing, false);
    audioElements[0].dispatchEvent(new Event('play'));
    assert.equal(m.player.playing, false, 'a queued play event cannot undo a completed pause');
    await m.toggle(); assert.equal(m.player.playing, true);
    audioElements[0].dispatchEvent(new Event('pause'));
    assert.equal(m.player.playing, true, 'a queued pause event cannot undo a completed resume'); assert.equal(audioElements[0].currentTime, 100, 'resume preserves position');
    m.jump(2); await settle();
    const entry = m.listeningHistory.entries[0];
    assert.equal(entry.index, 2); assert.equal(entry.context.queue.length, 3); assert.equal(entry.context.origin.id, origin.id);
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 0), false);
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 2), true);
    m.moveQueue(0, 1); assert.equal(m.player.index, 2, 'reorder retains the current duplicate occurrence');
    m.removeQueue(0); assert.equal(m.player.index, 1);
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 2), true, 'collection occurrence survives queue edits');
    const version = m.enqueue([other]); assert.equal(m.player.queueOpen, true); assert.equal(m.player.playing, true);
    m.play([other]); await settle(); assert.equal(m.appendToSession([local], version), false, 'stale collection pages cannot extend a replacement queue');
    m.replayHistory(entry); await settle(); assert.equal(m.player.index, 2); assert.equal(m.player.queue.length, 3);
    assert.equal(m.player.song.playbackOrigin.id, origin.id);
    assert.equal(m.collectionTrackIsCurrent(origin, collectionTracks, 2), true, 'history replay retains the collection occurrence');
    await m.pause(); await m.addCollection(origin); assert.equal(m.player.playing, false, 'queueing a collection never starts playback');
    assert.equal(m.player.queue.length, 6);
    const queue = m.player.queue.map(t => t.id);
    await m.setMode('albums'); await m.setMode('playlists'); assert.deepEqual(m.player.queue.map(t => t.id), queue, 'browsing modes preserve the queue');
    m.play([{ ...local, available: false }]); assert.deepEqual(m.player.queue.map(t => t.id), queue, 'unavailable tracks retain the current queue');
    m.play([{ ...local, source: 'unsupported' }]); assert.deepEqual(m.player.queue.map(t => t.id), queue, 'unsupported saved sources retain the current queue');
    m.clearHistory(); assert.equal(m.listeningHistory.entries.length, 0);
    m.removeQueue(m.player.index); await settle(); assert.ok(m.player.song);
    const randomTrack = { ...other, id: 'local:track:random', rawId: 'random' };
    for (const cancel of [grid => m.setOrder('normal', () => grid), grid => m.setOrder('shuffle', () => grid), () => m.play([local]), () => m.enqueue([other]), () => m.jump(0), () => m.prev(), () => m.pause()]) {
      let resolveSong;
      const grid = { count: 1, key: 'deferred', find: () => 0, song: () => new Promise(resolve => { resolveSong = resolve; }) };
      m.setOrder('normal', () => grid);
      m.jumpRandom(() => grid);
      assert.equal(m.player.randomRequesting, true, 'random lookup responds immediately');
      await cancel(grid);
      assert.equal(m.player.randomRequesting, false, 'new intentions clear random loading immediately');
      const ids = m.player.queue.map(track => track.id);
      resolveSong(randomTrack); await settle();
      assert.deepEqual(m.player.queue.map(track => track.id), ids, 'cancelled random lookup cannot append a stale track');
      assert.equal(m.player.randomRequesting, false);
    }
    const gridForShuffle = { count: 0, key: 'unused', find: () => 0, song: async () => undefined };
    m.setOrder('shuffle', () => gridForShuffle);
    m.play([local, other, local, { ...other, rawId: '3', id: 'local:track:3' }, { ...other, rawId: '4', id: 'local:track:4' }]);
    await settle();
    const shuffledIds = m.listeningHistory.entries[0].context.permutation.map(index => m.player.queue[index].queueEntryId);
    m.next(); await settle();
    m.next(); await settle();
    const currentId = m.player.song.queueEntryId;
    m.moveQueue(0, 4);
    assert.equal(m.player.song.queueEntryId, currentId, 'moving a shuffled occurrence retains the current song');
    m.prev(); await settle();
    assert.equal(m.player.song.queueEntryId, shuffledIds[1], 'reorder retains shuffle previous history');
    m.next(); await settle();
    assert.equal(m.player.song.queueEntryId, shuffledIds[2]);
    m.removeQueue(m.player.queue.findIndex(track => track.queueEntryId === shuffledIds[4]));
    m.next(); await settle();
    assert.equal(m.player.song.queueEntryId, shuffledIds[3], 'removing another occurrence preserves the next shuffle song');
    m.prev(); await settle();
    m.removeQueue(m.player.index); await settle();
    assert.equal(m.player.song.queueEntryId, shuffledIds[3], 'removing the current shuffle song uses its existing successor');
    m.prev(); await settle();
    assert.equal(m.player.song.queueEntryId, shuffledIds[1], 'current removal retains the surviving visited order');
    m.setOrder('normal', () => gridForShuffle);
    const independentLoad = m.beginCollectionOperation('add', 'independent');
    const grid = { count: 1, key: 'separate-loading', find: () => 0, song: async () => randomTrack };
    m.jumpRandom(() => grid); m.setOrder('normal', () => grid); await settle();
    assert.equal(m.player.requesting, true, 'cancelling random loading does not clear an independent collection request');
    independentLoad.finish();
    // A virtual asset plays through its resolved stream while the queue keeps the catalog ref.
    m.playbackResolver.update({ kind: 'asset', id: 'asset:v1' }, { kind: 'navidrome-stream', songId: 'nd-song-v1' }, 1)
    const virtual = { ...local, id: 'local:track:occurrence:album:1:asset:v1', rawId: 'asset:v1', catalogRef: { kind: 'asset', id: 'asset:v1' }, title: 'Virtual song' };
    const unresolved = { ...virtual, id: 'local:track:occurrence:album:1:asset:v2', rawId: 'asset:v2', catalogRef: { kind: 'asset', id: 'asset:v2' } };
    m.play([virtual, local]); await settle();
    assert.match(audioElements[0].src, /id=nd-song-v1/, 'audio loads the playback ref, not the catalog ref');
    assert.deepEqual(m.player.queue[0].catalogRef, { kind: 'asset', id: 'asset:v1' });
    assert.ok(scrobbles.some(entry => entry.id === 'nd-song-v1'), 'scrobbles use the playback ref');
    const virtualEntry = m.listeningHistory.entries[0];
    assert.deepEqual(virtualEntry.context.queue[0].catalogRef, { kind: 'asset', id: 'asset:v1' }, 'history keeps the catalog ref');
    m.next(); await settle(); assert.match(audioElements[0].src, /id=1$|id=1&/, 'a legacy track still plays through its Navidrome id');
    m.replayHistory(virtualEntry); await settle(); assert.match(audioElements[0].src, /id=nd-song-v1/, 'history replay resolves the playback ref at play time');
    const stopped = audioElements[0].src;
    m.play([unresolved]); await settle();
    assert.match(m.player.error, /unavailable/, 'an unresolved asset reports unavailable'); assert.equal(audioElements[0].src, stopped, 'and never loads audio');

    const album = { id: 'album:partial', title: 'Orqevra', availability: 'partial', trackCount: 2, addedAt: 0, links: [] };
    const missing = { id: 'occurrence:absent', assetId: 'asset:absent', position: 0, availability: 'missing', links: [] };
    const survivor = { id: 'occurrence:survivor', assetId: 'asset:survivor', position: 1, availability: 'available',
      links: [{ sourceId: 'navidrome', externalId: 'nd-survivor' }] };
    const page = { albums: [album], total: 1 };

    for (const mode of ['default', 'random']) {
      await t.test(`${mode} Play skips missing occurrences while details retain them`, async test => {
        globalThis.window.musicCatalog = {
          catalogAlbums: async () => page,
          catalogAlbum: async () => ({ album: { ...album, tracks: [missing, survivor] }, version: 1 }),
        };
        const unwatch = m.registerBrowseSource(() => m.library.tiles);
        try {
          await m.setMode('albums');
          const [tile] = m.library.tiles;
          const tracks = await m.songsOf(tile);
          assert.deepEqual(tracks.map(track => track.available), [false, true]);
          const KEEP_DRAW_ORDER = 0.75
          let draw = KEEP_DRAW_ORDER
          if (mode === 'default') await m.pick(tile);
          else {
            m.play([local]); await settle();
            test.mock.method(Math, 'random', () => draw)
            m.jumpRandom(m.libraryGrid);
          }
          await settle();
          const previous = mode === 'random' ? [local.id] : [];
          assert.deepEqual(m.player.queue.map(track => track.id), [...previous, tracks[1].id]);
          assert.equal(m.player.song.playbackOriginIndex, 1);
          assert.equal(m.player.playing, true);
          if (mode === 'random') {
            draw = 0 // Start the next cycle with the playable occurrence.
            m.next()
            await settle()
            const currentId = m.player.song.queueEntryId
            draw = KEEP_DRAW_ORDER // The missing occurrence now straddles the cycle boundary.
            m.next()
            await settle()
            assert.equal(m.player.queue.length, previous.length + 3)
            assert.notEqual(m.player.song.queueEntryId, currentId)
            assert.equal(m.player.song.id, tracks[1].id)
            assert.equal(m.player.error, '')
          }
        } finally { unwatch(); delete globalThis.window.musicCatalog; }
      });
    }

    await t.test('refreshing saved history replays the surviving copy after a folder goes offline', async test => {
      const directory = mkdtempSync(path.join(tmpdir(), 'kept-history-stream-'))
      const database = new CatalogDatabase(path.join(directory, 'library.sqlite'))
      test.after(async () => {
        delete globalThis.window.musicCatalog
        delete globalThis.window.musicHistory
        await database.close()
        rmSync(directory, { recursive: true, force: true })
      })
      const policy = { analysisAllowed: true, network: 'none' }
      const source = { id: 'history-folder', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy }
      const copy = { ...source, id: 'history-copy' }
      const providerSourceId = 'navidrome'
      const { service } = database
      await service.registerSource(source)
      await service.registerSource(copy)
      await service.registerSource({ ...source, id: providerSourceId, kind: 'navidrome', label: 'Navidrome', policy: { ...policy, network: 'lan' } })
      const oldId = 'nd-a-copy', currentId = 'nd-z-survivor'
      const file = { path: 'Vrezomu.flac', contentHash: 'hash-history', size: 1, providerAlbumId: 'nd-history-album', providerTrackId: currentId }
      const scan = { sourceId: source.id, providerSourceId, observedAt: 1, rootAvailable: true, complete: true, files: [file] }
      const { assetIds: [assetId] } = await service.ingestScan(scan)
      await service.ingestScan({ ...scan, sourceId: copy.id, files: [{ ...file, providerTrackId: oldId }] })
      const track = { ...virtual, rawId: assetId, catalogRef: { kind: 'asset', id: assetId } }
      const entry = { id: 'saved-entry', playedAt: 1, context: { id: 'saved-context', queue: [track], order: 'normal', permutation: [] }, index: 0, cursor: 0 }
      globalThis.window.musicHistory = { list: async () => ({ entries: [entry], total: 1, hasMore: false }), write: async () => ({}) }
      globalThis.window.musicCatalog = createCatalogBridge(service)
      const replay = async expected => {
        await m.searchHistory()
        assert.equal(m.listeningHistory.error, '')
        m.replayHistory(m.listeningHistory.entries[0])
        await settle()
        assert.equal(new URL(audioElements[0].src).searchParams.get('id'), expected)
      }
      await replay(oldId)
      await service.ingestScan({ ...scan, sourceId: copy.id, observedAt: 2, rootAvailable: false, complete: false, files: [] })
      await replay(currentId)
    })

    await t.test('a pending catalog check cannot undo switching off', async () => {
      const held = Promise.withResolvers();
      let calls = 0;
      globalThis.window.musicCatalog = { catalogAlbums: () => { calls++; return held.promise; } };
      try {
        const older = m.setMode('albums');
        assert.equal(calls, 1);
        m.setCatalogEnabled(false);
        await m.setMode('albums');
        held.resolve(page);
        await older;
        assert.deepEqual([m.catalogSource.active, m.catalogSource.fallback], ['navidrome', 'off']);
        await m.setMode('albums', true);
        assert.deepEqual(m.library.tiles.map(tile => tile.rawId), ['album']);
        assert.equal(calls, 1);
      } finally { delete globalThis.window.musicCatalog; }
    });
  } finally { m.disposePlayback(); }
});
