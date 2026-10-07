import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-svelte';
import { createRawSnippet, tick } from 'svelte';
import type { SubsonicAPI } from 'subsonic-api';
import { session } from './api.svelte';
import { library, addCollection, pick, setMode } from './library.svelte';
import { catalogSearch, startCatalogSearch, moreCatalogSearch, disposeCatalogSearch } from './catalog-search.svelte';
import { player, play, pause, moveQueue, enqueue, disposePlayback, beginCollectionOperation } from './player.svelte';
import { readJsonPreference, writePreference, retryPreferences, subscribePreferences } from './preferences';
import { reconcileBrowseOrder, orderedBrowseCollections } from './browse-view';
import { browseCollections, registerBrowseSource } from './browse-source';
import { isElementVisible } from './dom';
import { startRuntime } from './runtime';
import { ui } from './ui-style.svelte';
import { dig, coverRevision } from './discovery.svelte';
import { artworkFocusScope, restoreFocusOnClose, wrapArtworkTab } from './artwork-focus';
import DigPanel from './DigPanel.svelte';
import Queue from './Queue.svelte';
import CollectionDetails from './CollectionDetails.svelte';
import Settings from './Settings.svelte';
import Grid from './Grid.svelte';
import App from '../App.svelte';
import type { Collection, Track } from './music';

const tile: Collection = { id: 'local:album:a', rawId: 'a', source: 'local', kind: 'album', title: 'Album', sub: 'Artist', cover: '', count: 2, available: true };
const track: Track = { id: 'local:track:one', rawId: 'one', source: 'local', title: 'Song', cover: '', available: true, duration: 180 };
const child = (id = 'one', title = 'Song') => ({ id, title, albumId: 'a', album: 'Album', artist: 'Artist', duration: 180 });
const ok = <T,>(value: T) => ({ status: 'ok', ...value });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const api = (overrides: Record<string, unknown> = {}) => ({
  getPlaylists: vi.fn(async () => ok({ playlists: { playlist: [] } })),
  getAlbum: vi.fn(async () => ok({ album: { song: [child()] } })),
  getAlbumList2: vi.fn(async () => ok({ albumList2: { album: [] } })),
  search3: vi.fn(async () => ok({ searchResult3: { song: [child()] } })),
  scrobble: vi.fn(async () => ok({})), ...overrides,
}) as unknown as SubsonicAPI;
class TestAudio extends EventTarget {
  src = ''; paused = true; currentTime = 0; duration = 180; volume = 1;
  async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {} removeAttribute() { this.src = ''; }
}
beforeEach(() => {
  vi.stubGlobal('Audio', TestAudio);
  session.api = api(); session.username = crypto.randomUUID(); session.base = 'http://localhost:1234';
  library.tiles = []; library.revision = 0;
  player.queue = []; player.index = -1; player.order = 'normal'; player.collectionOperations = []; player.error = ''; player.loadingCollectionId = ''; player.queueTab = 'queue';
  player.queueOpen = false; player.shortcutsOpen = false;
});
afterEach(() => { cleanup(); disposeCatalogSearch(); disposePlayback(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('catalog generations and asynchronous intent', () => {
  it('reconciles unchanged-query refreshes, removing deleted results and preserving surviving order', async () => {
    startCatalogSearch('song', 'all');
    await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    expect(catalogSearch.tracks.map(t => t.rawId)).toEqual(['one']);
    const response = deferred<ReturnType<typeof ok>>();
    session.api = api({ search3: vi.fn(() => response.promise) });
    startCatalogSearch('song', 'all');
    expect(catalogSearch.tracks.map(t => t.rawId)).toEqual(['one']);
    response.resolve(ok({ searchResult3: { song: [child('two')] } }));
    await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    expect(catalogSearch.tracks.map(t => t.rawId)).toEqual(['two']);
  });
  it('refreshes all previously loaded pages before pruning and retains their order', async () => {
    const all = Array.from({ length: 120 }, (_, i) => child(String(i), `Song ${i}`));
    let refreshing = false; const lastPage = deferred<ReturnType<typeof ok>>();
    session.api = api({ search3: vi.fn(async (request: { songOffset: number; songCount: number }) => {
      if (refreshing && request.songOffset === 50) return lastPage.promise;
      return ok({ searchResult3: { song: all.slice(request.songOffset, request.songOffset + request.songCount) } });
    }) });
    startCatalogSearch('song', 'all'); await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    moreCatalogSearch(); await vi.waitFor(() => expect(catalogSearch.loading).toBe(false)); expect(catalogSearch.tracks).toHaveLength(100);
    refreshing = true;
    startCatalogSearch('song', 'all'); // Cancel a refresh before its debounce resolves.
    startCatalogSearch('song', 'all');
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(catalogSearch.tracks).toHaveLength(100); expect(catalogSearch.loading).toBe(true);
    lastPage.resolve(ok({ searchResult3: { song: all.slice(50, 100) } })); await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    expect(catalogSearch.tracks.map(t => t.rawId)).toEqual(all.slice(0, 100).map(t => t.id));
  });
  it('a new play selection releases superseded collection loading immediately', async () => {
    const delayed = deferred<ReturnType<typeof ok>>(); session.api = api({ getAlbum: vi.fn(() => delayed.promise) });
    const old = pick(tile); expect(player.requesting).toBe(true);
    play([track]); expect(player.requesting).toBe(false);
    delayed.resolve(ok({ album: { song: [child('stale')] } })); await old;
    expect(player.queue.map(t => t.rawId)).toEqual(['one']);
  });
  it('keeps the successful snapshot on a failed refresh and ignores a superseded response', async () => {
    startCatalogSearch('song', 'all'); await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    const late = deferred<ReturnType<typeof ok>>();
    session.api = api({ search3: vi.fn(() => late.promise) });
    startCatalogSearch('song', 'all'); await new Promise(resolve => setTimeout(resolve, 170));
    session.api = api({ search3: vi.fn(async () => { throw new Error('offline'); }) });
    startCatalogSearch('song', 'all'); await vi.waitFor(() => expect(catalogSearch.loading).toBe(false));
    late.resolve(ok({ searchResult3: { song: [child('stale')] } })); await tick();
    expect(catalogSearch.tracks.map(t => t.rawId)).toEqual(['one']); expect(catalogSearch.errors['Local music']).toBe('offline');
  });
  it('keeps loading owned by both queued adds, even while playback is paused', async () => {
    const first = deferred<ReturnType<typeof ok>>(), second = deferred<ReturnType<typeof ok>>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    session.api = api({ getAlbum: load });
    const a = addCollection(tile), b = addCollection(tile);
    expect(player.collectionOperations).toHaveLength(2);
    await pause(); expect(player.requesting).toBe(true);
    first.resolve(ok({ album: { song: [child()] } })); await a;
    expect(player.requesting).toBe(true); expect(load).toHaveBeenCalledTimes(2);
    second.resolve(ok({ album: { song: [child('two')] } })); await b;
    expect(player.requesting).toBe(false); expect(player.queue).toHaveLength(2); expect(player.playing).toBe(false);
  });
  it('does not append a delayed collection to a replacement queue', async () => {
    const response = deferred<ReturnType<typeof ok>>(); session.api = api({ getAlbum: vi.fn(() => response.promise) });
    const add = addCollection(tile); await tick();
    play([{ ...track, rawId: 'replacement', id: 'local:track:replacement' }]);
    response.resolve(ok({ album: { song: [child()] } })); await add;
    expect(player.queue.map(t => t.rawId)).toEqual(['replacement']); expect(player.requesting).toBe(false);
  });
  it('canceling one operation cannot clear another operation status', () => {
    const a = beginCollectionOperation('add', 'a'), b = beginCollectionOperation('add', 'b');
    a.finish(); expect(player.requesting).toBe(true); b.finish(); expect(player.requesting).toBe(false);
  });
  it('publishes a revision after a successful refresh even when the collection count stays constant', async () => {
    const before = library.revision; await setMode('albums', true); expect(library.revision).toBeGreaterThan(before);
  });
});

describe('component integration and occurrence identity', () => {
  it('preserves a queue row and keyboard focus after moving a duplicate occurrence', async () => {
    play([track, { ...track, rawId: 'two', id: 'local:track:two' }, track]);
    const ids = player.queue.map(t => t.queueEntryId); expect(new Set(ids).size).toBe(3);
    const options = createRawSnippet(() => ({ render: () => '<span></span>' }));
    render(Queue, { onclose: () => {}, palette: '', options }); await tick();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.track-menu')];
    const selected = buttons[2]; selected.focus(); moveQueue(2, 1); await tick();
    expect([...document.querySelectorAll('.track-menu')][1]).toBe(selected); expect(document.activeElement).toBe(selected);
    expect(player.queue[1].queueEntryId).toBe(ids[2]);
    enqueue([track]); expect(new Set(player.queue.map(t => t.queueEntryId)).size).toBe(4);
  });
  it('opens and closes queue actions when native popovers are unavailable', async () => {
    const show = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
    const hide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover');
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: undefined, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { value: undefined, configurable: true });
    try {
      play([track, track]); const options = createRawSnippet(() => ({ render: () => '<span></span>' }));
      render(Queue, { onclose: () => {}, palette: '', options }); await tick();
      const trigger = document.querySelector<HTMLButtonElement>('.track-menu')!; trigger.click(); await tick();
      const menu = document.querySelector<HTMLElement>('[data-queue-actions]:not([hidden])')!;
      expect(menu).not.toBeNull(); expect(menu.contains(document.activeElement)).toBe(true);
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
      expect(document.activeElement).toBe(trigger); expect(menu.hidden).toBe(true);
    } finally {
      if (show) Object.defineProperty(HTMLElement.prototype, 'showPopover', show);
      if (hide) Object.defineProperty(HTMLElement.prototype, 'hidePopover', hide);
    }
  });
  it('replaces failed queue artwork and retries when the cover URL changes', async () => {
    play([{ ...track, cover: '/invalid-queue-cover.png' }]);
    const options = createRawSnippet(() => ({ render: () => '<span></span>' }));
    render(Queue, { onclose: () => {}, palette: '', options }); await tick();
    const image = document.querySelector<HTMLImageElement>('.now-playing img.detail-cover')!;
    image.dispatchEvent(new Event('error')); await tick();
    expect(document.querySelector('.now-playing img.detail-cover')).toBeNull();
    expect(document.querySelector('.now-playing .empty-art')?.getAttribute('aria-label')).toBe('Artwork unavailable for Song');
    play([{ ...track, cover: '/replacement-queue-cover.png' }]); await tick();
    expect(document.querySelector('.now-playing img.detail-cover')?.getAttribute('src')).toBe('/replacement-queue-cover.png');
  });
  it('replaces failed album artwork with an accessible placeholder', async () => {
    render(CollectionDetails, { tile: { ...tile, cover: '/invalid-album-cover.png' }, onclose: () => {} }); await tick();
    const image = document.querySelector<HTMLImageElement>('.album-view img.detail-cover')!;
    image.dispatchEvent(new Event('error')); await tick();
    expect(document.querySelector('.album-view img.detail-cover')).toBeNull();
    expect(document.querySelector('.album-view .no-art')?.getAttribute('aria-label')).toBe('Artwork unavailable for Album');
  });
  it('ignores late artwork errors after the player and album details close', async () => {
    play([{ ...track, cover: '/late-queue-cover.png' }]);
    const options = createRawSnippet(() => ({ render: () => '<span></span>' }));
    render(Queue, { onclose: () => {}, palette: '', options }); await tick();
    const queueImage = document.querySelector<HTMLImageElement>('.now-playing img.detail-cover')!;
    cleanup();
    render(CollectionDetails, { tile: { ...tile, cover: '/late-album-cover.png' }, onclose: () => {} }); await tick();
    const albumImage = document.querySelector<HTMLImageElement>('.album-view img.detail-cover')!;
    cleanup();
    const warn = vi.spyOn(console, 'warn');
    queueImage.dispatchEvent(new Event('error')); albumImage.dispatchEvent(new Event('error')); await tick();
    expect(warn).not.toHaveBeenCalled();
  });
  it('refreshes open album details after a revision with an unchanged song count', async () => {
    const getAlbum = vi.fn().mockResolvedValueOnce(ok({ album: { song: [child('one', 'Old track')] } })).mockResolvedValueOnce(ok({ album: { song: [child('two', 'Replacement track')] } }));
    session.api = api({ getAlbum }); render(CollectionDetails, { tile, onclose: () => {} });
    await vi.waitFor(() => expect(document.querySelector('.track-list')?.textContent).toContain('Old track'));
    library.revision++; await vi.waitFor(() => expect(document.querySelector('.track-list')?.textContent).toContain('Replacement track'));
    expect(document.querySelector('.track-list')?.textContent).not.toContain('Old track');
  });
  it('keeps background ordering stable and applies explicit sort changes', () => {
    const a = tile, b = { ...tile, id: 'b' }, c = { ...tile, id: 'c' };
    const previous = { key: 'sort-a', ids: [a.id, b.id] };
    const next = reconcileBrowseOrder(previous, 'sort-a', [b, c, a]);
    expect(orderedBrowseCollections([b, c, a], next).map(t => t.id)).toEqual([a.id, b.id, c.id]);
    const removed = reconcileBrowseOrder(next, 'sort-a', [c, b]); expect(removed.ids).toEqual([b.id, c.id]);
    expect(reconcileBrowseOrder(removed, 'sort-b', [c, b]).ids).toEqual([c.id, b.id]);
  });
  it('reads the current browse source synchronously and disposes it', () => {
    let selected = [tile]; const dispose = registerBrowseSource(() => selected);
    expect(browseCollections([])).toEqual([tile]); selected = []; expect(browseCollections([tile])).toEqual([]);
    dispose(); expect(browseCollections([tile])).toEqual([tile]);
  });
  it('supports settings focus checks without checkVisibility', () => {
    const button = document.createElement('button'); document.body.append(button);
    Object.defineProperty(button, 'checkVisibility', { value: undefined });
    expect(isElementVisible(button)).toBe(true); button.style.display = 'none'; expect(isElementVisible(button)).toBe(false); button.remove();
  });
});

describe('guarded preferences', () => {
  it('recovers malformed saved JSON and retries failed writes', () => {
    const key = `test:${crypto.randomUUID()}`; localStorage.setItem(key, '{bad'); expect(readJsonPreference(key, { enabled: true })).toEqual({ enabled: true });
    let status = ''; const dispose = subscribePreferences(message => { status = message; });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    expect(writePreference(key, 'saved')).toBe(false); expect(status).not.toBe('');
    write.mockRestore(); retryPreferences(); expect(localStorage.getItem(key)).toBe('saved'); expect(status).toBe('');
    dispose(); localStorage.removeItem(key);
  });
});

it('starts side effects once and disposes preference subscriptions and pending playback', async () => {
  const original = ui.components; const write = vi.spyOn(Storage.prototype, 'setItem');
  const stop = startRuntime(); expect(startRuntime()).toBe(stop); await tick();
  ui.components = original === 'classic' ? 'studio' : 'classic'; await tick();
  expect(document.documentElement.dataset.components).toBe(ui.components);
  stop(); const writes = write.mock.calls.length;
  ui.components = original; await tick(); expect(write.mock.calls).toHaveLength(writes);
  expect(player.pending).toBe(false); expect(player.playing).toBe(false);
  stop();
});


describe('review regressions', () => {
  it('retains the cover fingerprint across auth salts and local port changes', () => {
    const cover = (id: string, port: number, salt: string) => `http://127.0.0.1:${port}/rest/getCoverArt?id=${id}&size=512&s=${salt}&t=token`;
    expect(coverRevision({ ...tile, cover: cover('album-one', 1234, 'old') })).toBe(coverRevision({ ...tile, cover: cover('album-one', 4321, 'new') }));
    expect(coverRevision({ ...tile, cover: cover('album-one', 1234, 'old') })).not.toBe(coverRevision({ ...tile, cover: cover('album-two', 1234, 'old') }));
    expect(coverRevision({ ...tile, cover: '/cover-v1.png' })).not.toBe(coverRevision({ ...tile, cover: '/cover-v2.png' }));
    expect(coverRevision({ ...tile, cover: 'https://example.com/cover-v1.png' })).not.toBe(coverRevision({ ...tile, cover: 'https://example.com/cover-v2.png' }));
  });
  it('owns one Dig pointer, commits cancellation and discards an unmounted draft', async () => {
    dig.mood = 50; dig.energy = 50; dig.moodOn = false;
    const view = render(DigPanel, { matches: 1, total: 1, tagged: 1, onrandom: () => {} }); await tick();
    const map = document.querySelector<HTMLButtonElement>('.mood-map')!;
    vi.spyOn(map, 'setPointerCapture').mockImplementation(() => {});
    const bounds = map.getBoundingClientRect();
    const event = (type: string, id: number, x: number) => new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: bounds.left + bounds.width * x, clientY: bounds.top + bounds.height * .2 });
    try {
      map.dispatchEvent(event('pointerdown', 1, .6));
      map.dispatchEvent(event('pointermove', 2, .9));
      map.dispatchEvent(event('pointerup', 2, .9));
      expect(dig.mood).toBe(50);
      map.dispatchEvent(event('pointercancel', 1, .6)); await tick();
      expect(dig.mood).toBe(60);
      map.dispatchEvent(event('pointerdown', 3, .8));
      await view.unmount(); await new Promise(requestAnimationFrame); await tick();
      expect(dig.mood).toBe(60);
    } finally { dig.mood = 50; dig.energy = 50; dig.moodOn = false; }
  });
  it('isolates covered Grid containers including newly inserted empty-library controls', async () => {
    const grid = render(Grid, { tiles: [tile], onpick: () => {}, hidden: false });
    await tick();
    const opener = document.querySelector<HTMLButtonElement>('.tile')!;
    opener.focus(); opener.click(); await tick();
    const background = document.querySelector<HTMLElement>('.scroll')!;
    const toolbar = document.querySelector<HTMLElement>('.browse')!;
    expect(background.inert).toBe(true); expect(toolbar.inert).toBe(true);
    expect(document.activeElement?.closest('.album-view')).not.toBeNull();
    // Background catalog changes can insert a whole new control container.
    await grid.rerender({ tiles: [] }); await tick();
    const empty = document.querySelector<HTMLElement>('.empty-library')!;
    expect(empty.inert).toBe(true);
    const reset = empty.querySelector<HTMLButtonElement>('button')!;
    reset.focus(); expect(document.activeElement).not.toBe(reset);
    document.querySelector<HTMLButtonElement>('[aria-label="Back to music"]')!.click(); await tick();
    expect(background.inert).toBe(false); expect(toolbar.inert).toBe(false); expect(empty.inert).toBe(false);
    reset.focus(); expect(document.activeElement).toBe(reset);
  });
  it('keeps the library and details interactive while non-modal shortcuts are open', async () => {
    render(Grid, { tiles: [tile], onpick: () => {}, hidden: false });
    player.shortcutsOpen = true; await tick();
    const opener = document.querySelector<HTMLButtonElement>('.tile')!;
    expect(document.querySelector<HTMLElement>('.scroll')!.inert).toBe(false);
    expect(document.querySelector<HTMLElement>('.browse')!.inert).toBe(false);
    opener.focus(); expect(document.activeElement).toBe(opener);
    opener.click(); await tick();
    const details = document.querySelector<HTMLElement>('.album-view')!;
    expect(details.inert).toBe(false);
    const back = details.querySelector<HTMLButtonElement>('[aria-label="Back to music"]')!;
    back.focus(); expect(document.activeElement).toBe(back);
    back.click(); await tick(); expect(document.querySelector('.album-view')).toBeNull();
    player.shortcutsOpen = false;
  });
  it('restores playback focus when the artwork opener has been removed', async () => {
    const opener = document.createElement('button');
    const overlay = document.createElement('section');
    const close = document.createElement('button'); overlay.append(close);
    const fallback = document.createElement('button'); fallback.className = 'bar-toggle';
    document.body.append(opener, overlay, fallback);
    try {
      opener.focus();
      const dispose = artworkFocusScope(overlay); await tick();
      opener.remove(); dispose(); overlay.remove(); await tick();
      expect(document.activeElement).toBe(fallback);
    } finally { opener.remove(); overlay.remove(); fallback.remove(); }
  });
  it('restores playback focus when artwork mounts without a focused opener', async () => {
    const overlay = document.createElement('section');
    const close = document.createElement('button'); overlay.append(close);
    const fallback = document.createElement('button'); fallback.className = 'bar-toggle';
    document.body.append(overlay, fallback);
    try {
      (document.activeElement as HTMLElement)?.blur();
      expect(document.activeElement).toBe(document.body);
      const dispose = artworkFocusScope(overlay); await tick();
      expect(document.activeElement).toBe(close);
      dispose(); overlay.remove(); await tick();
      expect(document.activeElement).toBe(fallback);
    } finally { overlay.remove(); fallback.remove(); }
  });
  it('wraps artwork Tab boundaries without taking ownership from a native dialog', async () => {
    const background = document.createElement('div'); background.inert = true;
    background.append(document.createElement('button'));
    const overlay = document.createElement('section'); overlay.className = 'artwork-view';
    const first = document.createElement('button'); overlay.append(first);
    const last = document.createElement('button');
    const dialog = document.createElement('dialog'); dialog.append(document.createElement('button'));
    document.body.append(background, overlay, last, dialog);
    try {
      last.focus();
      const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      wrapArtworkTab(forward); expect(forward.defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
      const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
      wrapArtworkTab(backward); expect(backward.defaultPrevented).toBe(true); expect(document.activeElement).toBe(last);
      dialog.showModal();
      const native = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      wrapArtworkTab(native); expect(native.defaultPrevented).toBe(false); expect(dialog.contains(document.activeElement)).toBe(true);
    } finally { dialog.close(); dialog.remove(); background.remove(); overlay.remove(); last.remove(); }
  });
  it('restores the artwork opener without scrolling and yields to a competing focus owner', async () => {
    const opener = document.createElement('button');
    const overlay = document.createElement('section');
    const close = document.createElement('button'); overlay.append(close);
    const next = document.createElement('button');
    document.body.append(opener, overlay, next);
    try {
      opener.focus();
      const restore = vi.spyOn(opener, 'focus');
      const dispose = artworkFocusScope(overlay);
      await tick(); expect(document.activeElement).toBe(close);
      dispose(); await tick();
      expect(document.activeElement).toBe(opener);
      expect(restore).toHaveBeenLastCalledWith({ preventScroll: true });
      const superseded = artworkFocusScope(overlay);
      next.focus(); await tick(); expect(document.activeElement).toBe(next);
      superseded(); await tick(); expect(document.activeElement).toBe(next);
      opener.focus();
      const canceled = artworkFocusScope(overlay);
      canceled(); await tick(); expect(document.activeElement).toBe(opener);
    } finally { opener.remove(); overlay.remove(); next.remove(); }
  });
  it('restores a nested artwork opener and never takes focus from an already open native dialog', async () => {
    const lower = document.createElement('section');
    const lowerButton = document.createElement('button'); lower.append(lowerButton);
    const upper = document.createElement('section');
    const upperButton = document.createElement('button'); upper.append(upperButton);
    const dialog = document.createElement('dialog');
    const input = document.createElement('input'); dialog.append(input);
    document.body.append(lower, upper, dialog);
    try {
      const disposeLower = artworkFocusScope(lower); await tick();
      expect(document.activeElement).toBe(lowerButton);
      const disposeUpper = artworkFocusScope(upper); await tick();
      expect(document.activeElement).toBe(upperButton);
      disposeUpper(); upper.remove(); await tick();
      expect(document.activeElement).toBe(lowerButton);
      dialog.showModal(); input.focus();
      const disposeCovered = artworkFocusScope(lower); await tick();
      expect(document.activeElement).toBe(input);
      disposeCovered(); disposeLower(); await tick();
      expect(document.activeElement).toBe(input);
    } finally { dialog.close(); dialog.remove(); lower.remove(); upper.remove(); }
  });
  it('mounts a bounded window of a large library and warms covers through one deduplicated pool', async () => {
    class TestImage extends EventTarget {
      static started: TestImage[] = []; onload: (() => void) | null = null; onerror: (() => void) | null = null; #src = '';
      get src() { return this.#src; } set src(value: string) { this.#src = value; if (value) TestImage.started.push(this); }
    }
    vi.stubGlobal('Image', TestImage);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...tile, id: `local:album:${i}`, rawId: String(i), title: `Album ${i}`, cover: `/cover-${i}.png` }));
    const view = render(Grid, { tiles: many(5000), onpick: () => {}, hidden: false }); await tick();
    expect(document.querySelectorAll('.tile-wrap').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.tile-wrap').length).toBeLessThan(400);
    expect(TestImage.started.length).toBe(6);
    await view.rerender({ tiles: many(4000) }); await tick();
    await view.rerender({ tiles: many(3000) }); await tick();
    expect(TestImage.started.length).toBe(6); // refreshed lists reuse the pool instead of starting six more loads each
    TestImage.started[0].onload!(); await tick();
    expect(TestImage.started.length).toBe(7);
    expect(new Set(TestImage.started.map(image => image.src)).size).toBe(7);
    await view.unmount(); await tick();
    expect(TestImage.started.slice(1).every(image => image.src === '')).toBe(true); // unmount aborts the loads still in flight
  });
  it('lets the real Settings modal own focus above Queue and restores the queue control', async () => {
    play([track]);
    render(Queue, { onclose: () => {}, palette: '', options: createRawSnippet(() => ({ render: () => '<div></div>' })) }); await tick();
    const opener = document.querySelector<HTMLButtonElement>('.now-playing button')!;
    opener.focus();
    const onclose = vi.fn();
    const settings = render(Settings, { coversOnly: false, motion: false, onclose }); await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.settings-dialog')!;
    expect(dialog.open).toBe(true); expect(dialog.contains(document.activeElement)).toBe(true);
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!;
    close.focus(); expect(document.activeElement).toBe(close);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    await settings.unmount(); await tick();
    expect(document.activeElement).toBe(opener);
  });
  it('previews a Dig drag without reranking until release and keeps keyboard control immediate', async () => {
    dig.mood = 50; dig.energy = 50; dig.moodOn = false;
    render(DigPanel, { matches: 1, total: 1, tagged: 1, onrandom: () => {} }); await tick();
    const map = document.querySelector<HTMLButtonElement>('.mood-map')!;
    vi.spyOn(map, 'setPointerCapture').mockImplementation(() => {});
    const bounds = map.getBoundingClientRect();
    const event = (type: string, x: number) => new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: bounds.left + bounds.width * x, clientY: bounds.top + bounds.height * .2 });
    map.dispatchEvent(event('pointerdown', .6));
    map.dispatchEvent(event('pointermove', .8));
    await new Promise(requestAnimationFrame); await tick();
    expect(dig.mood).toBe(50); expect(dig.energy).toBe(50);
    expect((map.querySelector('.point') as HTMLElement).style.left).toBe('80%');
    map.dispatchEvent(event('pointerup', .8)); await tick();
    expect(dig.mood).toBe(80); expect(dig.energy).toBe(80);
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await tick();
    expect(dig.mood).toBe(75);
    dig.mood = 50; dig.energy = 50; dig.moodOn = false;
  });
  it('restores shortcut focus to the still-interactive Queue', async () => {
    render(Queue, { onclose: () => {}, palette: '', options: createRawSnippet(() => ({ render: () => '<div></div>' })) });
    await tick();
    const opener = document.querySelector<HTMLButtonElement>('.now-playing button')!;
    opener.focus();
    const help = document.createElement('button'); document.body.append(help);
    try {
      const restore = restoreFocusOnClose(help, opener);
      player.shortcutsOpen = true; await tick();
      expect(document.querySelector<HTMLElement>('.now-playing')!.inert).toBe(false);
      help.focus();
      player.shortcutsOpen = false; restore(); help.remove(); await tick();
      expect(document.querySelector<HTMLElement>('.now-playing')!.inert).toBe(false);
      expect(document.activeElement).toBe(opener);
    } finally { player.shortcutsOpen = false; help.remove(); }
  });
  it('leaves playback and Queue controls available under non-modal shortcuts', async () => {
    const bar = document.createElement('div');
    const playback = document.createElement('button'); bar.append(playback); document.body.append(bar);
    try {
      render(Queue, { onclose: () => {}, palette: '', options: createRawSnippet(() => ({ render: () => '<div></div>' })) });
      await tick();
      const overlay = document.querySelector<HTMLElement>('.now-playing')!;
      playback.focus(); expect(document.activeElement).toBe(playback);
      player.shortcutsOpen = true; await tick(); expect(overlay.inert).toBe(false);
      const close = overlay.querySelector<HTMLButtonElement>('button')!;
      close.focus(); expect(document.activeElement).toBe(close);
      player.shortcutsOpen = false; await tick(); expect(overlay.inert).toBe(false);
      close.focus(); expect(document.activeElement).toBe(close);
    } finally { player.shortcutsOpen = false; bar.remove(); }
  });
  for (const [shortcut, init] of [['/', {}], ['k', { ctrlKey: true }]] as const) {
    it(`returns Escape from search opened with ${shortcut} in details to the opening tile`, async () => {
      session.api = api({ getAlbumList2: vi.fn(async () => ok({ albumList2: { album: [{ id: 'a', name: 'Album', artist: 'Artist', songCount: 1 }] } })) });
      render(App);
      await vi.waitFor(() => expect(document.querySelector('.tile')).not.toBeNull());
      const opener = document.querySelector<HTMLButtonElement>('.tile')!;
      opener.focus(); opener.click();
      await vi.waitFor(() => expect(document.activeElement?.closest('.album-view')).not.toBeNull());
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: shortcut, bubbles: true, cancelable: true, ...init }));
      await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Search library'));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await tick();
      expect(document.activeElement).toBe(document.querySelector('.tile'));
    });
  }
});
