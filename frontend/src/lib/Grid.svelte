<script lang="ts">
  import { keyboardScope } from './keyboard';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { createBrowseView } from './browse-view.svelte';
  import { registerBrowseSource } from './browse-source';
  import { readPreference, writePreference } from './preferences';
  import Icon from './ui/icon.svelte';
  import Button from './ui/button.svelte';
  import Slider from './ui/slider.svelte';
  import { toolbar } from './ui-style.svelte';
  import LibrarySelect from './ui/library-select.svelte';
  import ComponentStyles from './ComponentStyles.svelte';
  import noiseBackground from './noise-background.svg';
  import { Spring } from 'svelte/motion';
  import { library, setMode, type Mode, type Tile } from './library.svelte';
  import { session } from './api.svelte';
  import CatalogSearch from './CatalogSearch.svelte';
  import { catalogSearch, startCatalogSearch } from './catalog-search.svelte';
  import { player, collectionPlayback } from './player.svelte';
  import CollectionPlayback from './CollectionPlayback.svelte';
  import DigPanel from './DigPanel.svelte';
  import { catalog, dig, digActive, digScore, resetDig, metadata, warmColors, coverRevision } from './discovery.svelte';
  import CollectionDetails from './CollectionDetails.svelte';
  import Settings from './Settings.svelte';
  import { desktop } from './desktop.svelte';
  import { bg, importBackground, MATERIALS, randomBackground } from './background.svelte';

  let { tiles, onpick, activeId, hidden }: { tiles: Tile[]; onpick: (t: Tile) => void; activeId?: string; hidden: boolean } = $props();

  // Cover wall from Figma Current: quiet chrome, square artwork, separate open and play controls.
  function savedNumber(key: string, fallback: number, min: number, max: number) {
    const value = Number(readPreference(key, String(fallback)));
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
  }
  let cols = $state(savedNumber('grid.cols', 6, 1, 10));
  let advancedLayout = $state(false);
  function resizeGrid(value: number) { cols = 11 - value; gap = Math.round(24 + cols * 8); }
  let gap = $state(savedNumber('grid.gap', 48, 0, 160));
  let coversOnly = $state(readPreference('covers.only') === '1'); // off by default
  let motion = $state(readPreference('motion') === '1'); // off by default
  // 3D: the grid lies on a plane tilted back from the bottom edge and scrolls away into the distance, like a title crawl.
  // The views are picked in the 3D control set of the Display options
  const VIEWS = { off: 'Off', grid: 'Grid', jukebox: 'Jukebox', flow: 'Cover flow' } as const;
  type View = keyof typeof VIEWS;
  const saved3d = readPreference('grid.3d');
  let view3d = $state<View>(saved3d in VIEWS ? (saved3d as View) : saved3d === '1' ? 'grid' : 'off');
  let query = $state('');
  const searching = $derived(!!query.trim());
  // search results are a flat list that scrolls on its own, so a search leaves the 3D views until it is cleared
  const mode3d = $derived<View>(searching ? 'off' : view3d);
  const tilt = $derived(mode3d !== 'off');
  // the material never rides the tilted plane: textured, every tile of that huge plane has to be drawn, far more than the
  // GPU keeps, so it redraws them all on every frame (~250ms). It stays on the screen behind the plane instead
  const onCards = $derived(bg.scroll && !tilt);
  // loop: the tilted grid never ends, past the last album it starts again from the first
  let loop = $state(readPreference('grid.loop') === '1');
  // inf: with loop on, the columns repeat sideways too, so the plane has no edge in any direction
  let inf = $state(readPreference('grid.inf') === '1');
  // jukebox: a single row up the plane. The covers do not lie on it: each is tipped up off it, over the one behind
  const jukebox = $derived(mode3d === 'jukebox');
  // cover flow: a single row across the screen that scrolls sideways. The middle cover faces front, the rest are turned
  // toward it in a stack on either side
  const flow = $derived(mode3d === 'flow');
  const single = $derived(jukebox || flow);
  // reflect: the covers of a single row mirror faintly in the floor under them
  let reflect = $state(readPreference('grid.reflect') === '1');
  type BarMode = 'library' | 'filters' | 'layout' | 'look' | '3d' | 'theme';
  function closeModes() {
    if (document.activeElement?.matches(':focus-visible')) document.querySelector<HTMLButtonElement>('[aria-label="Choose toolbar mode"]')?.focus();
    toolbar.selecting = false;
  }
  function showMode(mode: BarMode) { toolbar.mode = mode; player.view = ''; closeModes(); }
  function backToSelector() { player.view = ''; toolbar.selecting = true; requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.mode-options button[aria-pressed=true]')?.focus()); }
  $effect(() => {
    writePreference('grid.cols', String(cols)); writePreference('grid.gap', String(gap));
    writePreference('covers.only', coversOnly ? '1' : '0'); writePreference('motion', motion ? '1' : '0');
    writePreference('grid.3d', view3d); writePreference('grid.loop', loop ? '1' : '0'); writePreference('grid.inf', inf ? '1' : '0'); writePreference('grid.reflect', reflect ? '1' : '0');
    writePreference('library.source', library.source);
  });
  let searchKind = $state('all');
  const searchAccount = $derived(JSON.stringify([session.base, session.username]));
  const catalogRevision = $derived(library.revision);
  $effect(() => {
    const term = query.trim().slice(0, 500), source = library.source;
    session.api; searchAccount; catalogRevision;
    return untrack(() => startCatalogSearch(term, source));
  });
  let artistFilter = $state('');
  const DEFAULT_SORT = 'artist';
  let sort = $state(DEFAULT_SORT), sortDirection = $state(1), sortRevision = $state(0), randomSeed = $state(Math.random());
  let showFilter = $state('all');
  let collectionMode = $derived<string>(library.mode);
  let colorOrder = $state.raw<Record<string, number>>({});
  $effect(() => { const tiles = sourceTiles; if (sort === 'color') untrack(() => warmColors(tiles)); });
  function applySort() { colorOrder = Object.fromEntries(sourceTiles.map(tile => [tile.id, catalog.colors[tile.id]?.hue ?? 361])); sortRevision++; filterChanged(); }
  function sortChanged() { if (sort === 'random') randomSeed = Math.random(); applySort(); }
  let favoritesOnly = $state(false);
  let details = $state.raw<Tile | null>(null);
  export function closeDetails() { details = null; }
  $effect(() => { if (player.queueOpen || player.visOpen || player.view === 'share') details = null; });
  const covered = $derived(!!details || player.queueOpen);
  const currentDetails = $derived.by(() => { const selected = details; return selected ? library.tiles.find(tile => tile.id === selected.id) || selected : null; });
  const filtersOpen = $derived(toolbar.mode === 'filters');
  let discoveryId = $state('');
  const activeFilters = $derived(Number(!!artistFilter) + Number(showFilter !== 'all') + Number(digActive()));
  function discover() {
    const candidates = shown.filter(t => t.id !== discoveryId);
    if (!candidates.length) return;
    const tile = candidates[Math.floor(Math.random() * candidates.length)];
    discoveryId = tile.id;
    const index = shown.findIndex(t => t.id === tile.id);
    if (tilt) seek((looping ? middle(period) : 0) + Math.floor(index / across) * pitch);
    else scroller?.scrollTo({ top: Math.floor(index / effectiveCols) * rowStep, behavior: 'instant' });
  }
  let filterHeight = $state(110);
  $effect(() => { const mode = library.mode; untrack(() => { artistFilter = ''; if (mode === 'playlists' && sort === 'recent') sort = 'library'; }); });
  const modeLabels: Record<Mode, string> = { albums: 'Albums', playlists: 'Playlists' };
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const sourceTiles = $derived(tiles.filter((t) => library.source === 'all' || t.source === library.source));
  const genres = $derived([...new Set(sourceTiles.flatMap(tile => metadata(tile).genres))].sort(collator.compare));
  const tagged = $derived(sourceTiles.filter(tile => !!catalog.items[tile.id]?.traits).length);
  const colorsReady = $derived(sourceTiles.filter(tile => tile.cover && catalog.colors[tile.id]?.colorReady && catalog.colors[tile.id]?.colorRevision === coverRevision(tile)).length);
  const artists = $derived([...new Set(sourceTiles.filter((t) => t.kind === 'album').map((t) => t.sub).filter(Boolean))].sort(collator.compare));
  const view = createBrowseView(() => ({
    tiles, source: library.source, query, artist: artistFilter, show: showFilter, favoritesOnly, coversOnly,
    sort, direction: sortDirection, randomSeed, colorOrder, digActive: digActive(),
    metadata, score: digScore, tagged: tile => !!catalog.items[tile.id]?.traits,
    plays: id => catalog.stats[id]?.plays || 0,
    key: JSON.stringify([library.mode, library.source, query, artistFilter, sort, sortDirection, sortRevision,
      randomSeed, showFilter, favoritesOnly, coversOnly, dig.moodOn, dig.mood, dig.energy, dig.familiarity, dig.acoustic, dig.vocal]),
  }));
  const shown = $derived(view.collections);
  onMount(() => registerBrowseSource(() => searching ? catalogSearch.collections : view.collections));
  function filterChanged() { scrollTop = 0; details = null; player.queueOpen = false; player.view = ''; scroller?.scrollTo({ top: 0, left: 0 }); front = 0; if (looping) seek(middle(period)); }
  function changeMode(mode: Mode) { artistFilter = ''; favoritesOnly = false; filterChanged(); void setMode(mode); }
  function changeSource() { artistFilter = ''; filterChanged(); }
  function resetFilters() { query = ''; artistFilter = ''; library.source = 'all'; sort = DEFAULT_SORT; sortDirection = 1; showFilter = 'all'; favoritesOnly = false; coversOnly = false; resetDig(); filterChanged(); }

  let viewportWidth = $state(innerWidth), viewportHeight = $state(innerHeight), scrollTop = $state(0);
  const pixelGap = $derived(Math.max(0.2, gap * (viewportWidth + (innerWidth - viewportWidth)) / 3312));
  const effectiveCols = $derived(Math.min(cols, Math.max(1, Math.floor(viewportWidth / 140))));
  const rowStep = $derived(Math.max(1, (viewportWidth - pixelGap * (effectiveCols + 1)) / effectiveCols + pixelGap));
  const totalRows = $derived(Math.ceil(shown.length / effectiveCols));
  // a bounded window of rows is mounted: a couple of viewports each side so a fling lands on mounted rows, while the
  // cover warming below primes the cache far beyond it. Mounting more makes every scroll step and warmed update dearer
  const BUFFER_VIEWPORTS = 2;
  const bufferRows = $derived(Math.ceil(BUFFER_VIEWPORTS * viewportHeight / rowStep));
  const firstRow = $derived(Math.max(0, Math.min(totalRows, Math.floor((scrollTop - filterHeight - pixelGap) / rowStep) - bufferRows)));
  const lastRow = $derived(Math.min(totalRows, Math.ceil((scrollTop + viewportHeight - filterHeight) / rowStep) + bufferRows));
  const visibleTiles = $derived(shown.slice(firstRow * effectiveCols, lastRow * effectiveCols));
  // Covers near the viewport load at once; the rest get their src only once warmed into the cache,
  // nearest to the current scroll position first, so a fling meets loaded images instead of a queue.
  const NEAR_VIEWPORTS = 1, WARM_PARALLEL = 6;
  const centerRow = $derived((scrollTop - filterHeight + viewportHeight / 2) / rowStep);
  const near = (index: number) => index < 0 || Math.abs(Math.floor(index / effectiveCols) - centerRow) <= NEAR_VIEWPORTS * viewportHeight / rowStep;
  // One pool of WARM_PARALLEL loads outlives list changes: a new list only replaces the queue, a load already in flight
  // finishes and counts for every list (a cover is the same cover), and no URL is loaded twice. Unmount releases them:
  // clearing src drops the reference, Chromium still finishes the request
  const warmed = new SvelteSet<string>(), loading = new Map<string, HTMLImageElement>();
  let queue: { i: number; u: string }[] = [], workers = 0, disposed = false;
  const preload = (u: string) => new Promise<void>((r) => { const i = new Image(); loading.set(u, i); i.onload = i.onerror = () => { loading.delete(u); r(); }; i.src = u; });
  // the scroll position is read when each cover is picked, so the queue follows the user.
  // ponytail: a scan of the queue per pick; sort it by distance once per list if a 10k library makes this show
  function nearest() {
    const center = untrack(() => centerRow) * untrack(() => effectiveCols);
    let best = 0, bestDistance = Infinity;
    for (let k = 0; k < queue.length; k++) { const d = Math.abs(queue[k].i - center); if (d < bestDistance) { best = k; bestDistance = d; } }
    return queue.splice(best, 1)[0].u;
  }
  async function warmer() {
    while (queue.length && !disposed) { const u = nearest(); if (!u || warmed.has(u) || loading.has(u)) continue; await preload(u); if (!disposed) warmed.add(u); }
    workers--;
  }
  function warmCovers(tiles: Tile[]) {
    queue = tiles.flatMap((t, i) => t.cover && !warmed.has(t.cover) ? [{ i, u: t.cover }] : []);
    while (workers < WARM_PARALLEL && queue.length) { workers++; void warmer(); }
  }
  $effect(() => { const tiles = shown; untrack(() => warmCovers(tiles)); });
  onDestroy(() => { disposed = true; queue = []; for (const i of loading.values()) i.src = ''; loading.clear(); });

  let scroller: HTMLDivElement;
  // Playback and background refreshes keep the user's scroll position.

  // subtle whole-grid drift with the mouse; native scroll does the rest
  const drift = new Spring({ x: 0, y: 0 }, { stiffness: 0.05, damping: 0.5 });
  // 3D: a sticky stage holds the plane in view while a spacer gives the page its scroll length, so native scrolling
  // (wheel, touch, scrollbar, keys) still drives it; the plane slides along itself by the scroll distance.
  // Only the covers on screen exist, placed one by one: rows up to DEPTH screens up the plane (deeper they are specks
  // under the top bar, and a plane that big overflows what the GPU keeps), and on each row the columns the view spans
  // at that depth. Cover flow scrolls sideways: there scrollTop holds the scrollLeft
  const pos = () => (flow ? scroller.scrollLeft : scroller.scrollTop);
  // sought: where the last seek went, so the scroll event it echoes is told apart from the user's own scrolling. A seek
  // lands on a whole pixel at or before its target, so the cover it aims at stands at the front and never a hair past it
  let sought = -1;
  const seek = (v: number) => { v = Math.floor(v); if (flow) scroller.scrollLeft = v; else scroller.scrollTop = v; sought = v; scrollTop = pos(); };
  const DEPTH = 5, SPAN = 1e7, TILT = 58, SIN = Math.sin((TILT * Math.PI) / 180);
  // the plane is wider than the screen so its far end still fills the width; its sides run off the bottom corners
  const PLANE_WIDTH = 1.6;
  // jukebox: how far a cover is tipped up off the plane, the distance between covers as a part of their size, and the
  // front cover's clearance above the player bar
  const LIFT = 22, STEP = 0.6, BASE = 140;
  // cover flow: how far the side covers are turned, and as parts of the cover size: the gap beside the middle cover,
  // the distance between covers in a stack, how far back the stacks stand, and the row's lift above mid-screen
  const TURN = 68, MID = 0.72, SIDE = 0.2, BACK = 0.45, FLOW_LIFT = 20;
  const looping = $derived(tilt && loop && shown.length > 0);
  const wrapping = $derived(looping && inf && !single);
  const across = $derived(single ? 1 : effectiveCols);
  const rows = $derived(Math.ceil(shown.length / across));
  const planeW = $derived(PLANE_WIDTH * viewportWidth);
  const tile = $derived(flow ? Math.min(viewportWidth * 0.4, viewportHeight * 0.5) : jukebox ? Math.min(viewportWidth * 0.5, viewportHeight * 0.8) : (planeW - (effectiveCols + 1) * pixelGap) / effectiveCols);
  const pitch = $derived(flow ? tile * SIDE * 1.5 : jukebox ? tile * STEP : tile + pixelGap);
  const period = $derived(rows * pitch);
  const mod = (a: number, n: number) => ((a % n) + n) % n;
  // looping: the page gets a scroll length nobody reaches the end of and the plane moves by the scroll modulo one pass
  // through the library, so the wrap never touches the scroll position and momentum carries straight through it
  const offset = $derived(looping ? mod(scrollTop, period) : scrollTop);
  const middle = (p: number) => SPAN / 2 - mod(SPAN / 2, p);
  // the album at the front, as a possibly fractional index into shown, kept up to date by scrolling. Whenever the period
  // changes (a resize, a view or loop switch, albums arriving from a scan) or a search ends, the plane seeks back to it,
  // so the front album never jumps somewhere unrelated. Looping starts in the middle of the page: whole passes, same view
  let front = 0;
  // the scrollbar gutter comes and goes with the views, and the width binding's observer does not see that
  $effect(() => { tilt; untrack(() => { viewportWidth = scroller.clientWidth; }); });
  $effect(() => { const p = period, on = looping; mode3d; if (!tilt) return; untrack(() => seek((on ? middle(p) : 0) + front / across * pitch)); });
  // a search in a 3D view starts its flat results at the top, not wherever the plane's long scroll was
  $effect(() => { if (searching) untrack(() => { if (view3d !== 'off') scroller?.scrollTo({ top: 0, left: 0 }); }); });
  // switching between the views keeps the album at the front where it is; from the flat grid the first row below the
  // toolbar moves to the front, and Off lands the flat grid on the front album's row
  function setView(next: View) {
    front = tilt ? offset / pitch * across : Math.max(0, Math.ceil((scroller.scrollTop - pixelGap) / rowStep)) * effectiveCols;
    view3d = next;
    if (next === 'off') requestAnimationFrame(() => { scroller.scrollTo({ top: Math.floor((Math.round(front) % Math.max(1, shown.length)) / effectiveCols) * rowStep, behavior: 'instant' }); scrollTop = pos(); });
  }
  // single row: the covers in view, each with its place p in the row counted in covers from the front one (jukebox) or
  // the middle one (cover flow). In the jukebox the one before the front (p < 0) is the cover leaving the row
  const discs = $derived.by(() => {
    const n = shown.length, out: { key: number; t: Tile; p: number }[] = [];
    if (!single || !n || !(pitch > 0)) return out;
    const at = offset / pitch, side = Math.ceil(viewportWidth / 2 / (SIDE * tile)) + 2;
    let k0 = Math.floor(at) - (flow ? side : 0), k1 = flow ? Math.ceil(at) + side : Math.floor((offset + DEPTH * viewportHeight) / pitch);
    if (!looping) { k0 = Math.max(0, k0); k1 = Math.min(n - 1, k1); }
    const kr = looping ? Math.floor(scrollTop / period) * n : 0;
    for (let k = k0; k <= k1; k++) out.push({ key: k + kr, t: shown[mod(k, n)], p: k - at });
    return out;
  });
  // the line on screen the front cover stands on. Cover flow is seen from the covers' mid-height, as in iTunes: the
  // side covers narrow evenly above and below, and their bottom edges rise toward the middle
  const floorY = $derived(flow ? (viewportHeight + tile) / 2 - FLOW_LIFT : viewportHeight - BASE);
  // where a cover of the row stands. Nearer covers paint over farther ones
  function pose(p: number) {
    if (flow) {
      const t = Math.max(-1, Math.min(1, p)); // the turn happens within one place of the middle
      return { z: -Math.round(Math.abs(p) * 10), o: 1, origin: '50% 50%',
        tf: `translateX(${(t * MID + (p - t) * SIDE) * tile}px) translateZ(${-Math.abs(t) * BACK * tile}px) rotateY(${-t * TURN}deg)` };
    }
    // hinged on its bottom edge: moved up the tilted plane, then tipped up off it. Passing the front it slides on down
    // off the screen and fades, gone by the time it is dropped
    const d = p * pitch;
    return { z: -Math.round(p), o: 1 - Math.max(0, -p), origin: '50% 100%', tf: `rotateX(${TILT}deg) translateY(${d < 0 ? -2 * d : -d}px) rotateX(${-LIFT}deg)` };
  }
  // cover flow comes to rest on a cover
  function onscrollend() {
    if (!flow || !(pitch > 0)) return;
    const to = Math.round(pos() / pitch) * pitch;
    if (Math.abs(to - pos()) > 1) scroller.scrollTo({ left: to, behavior: 'smooth' });
  }
  // the rows on screen with their covers. Keys count whole passes too, so crossing a seam keeps every node.
  // Each row is a layer of its own, and a far row is drawn small and scaled back up (k): it shows at a fraction of its
  // size, and at full size the rows together are more than the GPU keeps, so parts go undrawn
  // ponytail: a row is redrawn when it crosses a step. Add hysteresis if scrolling back and forth over one shows
  const bands = $derived.by(() => {
    const n = shown.length, out: { key: number; y: number; k: number; cells: { c: number; t: Tile; x: number }[] }[] = [];
    if (!tilt || single || !n || !(pitch > 0)) return out;
    // rows past the bottom edge are off screen, and partly behind the camera, where they break the browser's drawing
    // and hit testing of the whole plane
    let r0 = Math.floor((offset + viewportHeight * (1 - DEPTH) - pixelGap) / pitch), r1 = Math.floor((offset + viewportHeight) / pitch);
    if (!looping) { r0 = Math.max(0, r0); r1 = Math.min(rows - 1, r1); }
    const kr = looping ? Math.floor(scrollTop / period) * rows : 0;
    const xc = planeW / 2; // the plane point at the middle of the screen
    for (let r = r0; r <= r1; r++) {
      // size: how large the row shows, 1 at the bottom edge. Perspective is one screen height, the origin mid-screen
      const d = Math.max(0, offset + viewportHeight - (pixelGap + r * pitch + tile / 2));
      const size = 1 / (1 + (d * SIN) / viewportHeight), k = size > 0.6 ? 1 : size > 0.3 ? 2 : 4, cells = [];
      // the view widens with the distance up the plane. A row holds the columns in view at the far end of its step, so
      // they change only when it is redrawn anyway: dropping them one by one as it nears redraws it each time
      const half = viewportWidth / 2 / (k === 1 ? 0.6 : k === 2 ? 0.3 : 1 / (1 + DEPTH * SIN)) + pitch;
      let c0 = Math.floor((xc - half - pixelGap) / pitch), c1 = Math.floor((xc + half) / pitch);
      if (!wrapping) { c0 = Math.max(0, c0); c1 = Math.min(effectiveCols - 1, c1); }
      for (let c = c0; c <= c1; c++) {
        const i = mod(r, rows) * effectiveCols + mod(c, effectiveCols);
        if (!looping && i >= n) break;
        cells.push({ c, t: shown[i % n], x: pixelGap + c * pitch });
      }
      out.push({ key: r + kr, y: pixelGap + r * pitch, k, cells });
    }
    return out;
  });
  // the plane's shift along itself: scroll plus the mouse drift
  const shiftX = $derived(drift.current.x * -8), shiftY = $derived(-offset + drift.current.y * -6);
  // Both bars follow the app's idle timer. Hover, keyboard focus and open menus keep the top visible.
  const touchAtLoad = matchMedia('(hover: none), (pointer: coarse)').matches;
  let touch = $state(touchAtLoad);
  function ontouchstart() { touch = true; }
  // A dedicated play target expresses intent, even while chrome is idle.
  function pick(t: Tile) { onpick(t); }
  let rightView = $derived(player.viewFrom === 'right' ? player.view : '');
  let overBrowse = $state(false);
  let controlsFocused = $state(false);
  let pointerNearTop = $state(true), pointerObserved = $state(false), scrollRevealed = $state(false);
  let scrollRevealTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const barShown = $derived(dig.open || toolbar.selecting || toolbar.mode !== 'library' || controlsFocused || !!rightView || overBrowse || scrollRevealed || (!touch && pointerObserved && pointerNearTop) || (!hidden && !player.topHidden && (touch || pointerNearTop)));
  $effect(() => { if (!barShown) toolbar.selecting = false; });
  $effect(() => { document.documentElement.style.setProperty('--topbar', `${filterHeight}px`); });
  $effect(() => { document.documentElement.style.setProperty('--browsebar', `${barShown ? filterHeight : 0}px`); });
  $effect(() => { document.documentElement.style.setProperty('--sidebar', '0px'); });
  function chromeFocus(target: EventTarget | null) {
    controlsFocused = target instanceof Element && !!target.closest('.browse, .library-select-menu') && target.matches(':focus-visible');
    if (target instanceof Element && target.matches('[aria-label="Search library"]')) { details = null; toolbar.mode = 'library'; }
  }
  let settingsTab = $state('appearance');
  function open(view: 'settings') { settingsTab = 'appearance'; player.viewFrom = 'right'; player.view = rightView === view ? '' : view; closeModes(); }
  async function chooseMusicFolder() {
    try { await window.desktop!.changeFolder('add'); }
    catch (error) { library.error = (error as Error).message; }
  }
  function onmove(e: PointerEvent) {
    if (e.pointerType !== 'touch') {
      touch = false;
      pointerObserved = true;
      const near = e.clientY <= (barShown ? filterHeight + 28 : 48);
      if (near) { clearTimeout(leaveTimer); leaveTimer = undefined; pointerNearTop = true; }
      else if (!leaveTimer && pointerNearTop) leaveTimer = setTimeout(() => { pointerNearTop = false; leaveTimer = undefined; }, 220);
    }
    drift.target = motion ? { x: (e.clientX / innerWidth) * 2 - 1, y: (e.clientY / innerHeight) * 2 - 1 } : { x: 0, y: 0 };
  }
  function revealAtTop() {
    scrollRevealed = true;
    clearTimeout(scrollRevealTimer);
    scrollRevealTimer = setTimeout(() => (scrollRevealed = false), 1800);
  }
  onDestroy(() => { clearTimeout(leaveTimer); clearTimeout(scrollRevealTimer); });
  function onscroll(e: Event) {
    const next = (e.currentTarget as HTMLElement).scrollTop;
    if (!flow && next < scrollTop && next <= 4) revealAtTop();
    scrollTop = tilt ? pos() : next;
    if (tilt && Math.abs(pos() - sought) >= 1) front = offset / pitch * across;
  }
</script>

<div class="browse" inert={covered} class:hidden={!barShown} class:selecting={toolbar.selecting}
  onpointerenter={event => (overBrowse = event.pointerType === 'mouse')} onpointerleave={() => (overBrowse = false)} bind:clientHeight={filterHeight} role="region" aria-label="Library toolbar">
  <div class="compact-bar">
    <label class="browse-search"><Icon name="search" /><input type="search" aria-label="Search library" placeholder="Search albums, songs, artists…" maxlength="500" bind:value={query} oninput={filterChanged} onkeydown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); query = ''; filterChanged(); } }} aria-keyshortcuts="/ Control+k Meta+k" autocomplete="off" spellcheck="false" /></label>
    <button class="dig-trigger" disabled={searching} title={searching ? 'Clear search to use Dig' : undefined} aria-label="Dig into your music" aria-expanded={dig.open} aria-controls="dig-controls" class:selected={dig.open || digActive()} onclick={() => { dig.open = !dig.open; toolbar.mode = 'library'; toolbar.selecting = false; }}><Icon name="dig" /><span>Dig{digActive() ? ` · ${shown.length}` : ''}</span></button>
    <div class="library-controls" role="group" aria-label="Library filters and sorting">
    {#if searching}
      <div class="collection-filter"><LibrarySelect label="Search result type" bind:value={searchKind} onchange={() => scroller?.scrollTo({ top: 0 })} options={[{ value: 'all', label: 'All results' }, { value: 'song', label: 'Songs' }, { value: 'album', label: 'Albums' }, { value: 'artist', label: 'Artists' }, { value: 'playlist', label: 'Playlists' }]} /></div>
    {:else}
    <div class="collection-filter"><LibrarySelect label="Collection type" bind:value={collectionMode} onchange={() => { showFilter = 'all'; changeMode(collectionMode as Mode); }} options={[{ value: 'albums', label: 'Albums' }, { value: 'playlists', label: 'Playlists' }]} /></div>
    <div class="show-filter"><LibrarySelect label="Show music" bind:value={showFilter} onchange={filterChanged} options={[{ value: 'all', label: 'All music' }, { value: 'favorites', label: 'Favorites' }, { value: 'mood', label: 'Tagged for Dig' }, ...genres.map(genre => ({ value: `genre:${genre}`, label: genre }))]} /></div>
    <div class="sort-filter"><LibrarySelect label="Sort library" bind:value={sort} onchange={sortChanged} options={[{ value: 'title', label: 'Album title' }, { value: 'artist', label: 'Artist name' }, { value: 'year', label: 'Release year' }, { value: 'plays', label: 'Number of plays' }, { value: 'color', label: 'Cover color' }, { value: 'random', label: 'Random order' }, { value: 'recent', label: 'Recently added' }, { value: 'library', label: 'Library order' }]} /></div>
    <button class="sort-direction icon-button" aria-label="Reverse sort order" aria-pressed={sortDirection === -1} disabled={sort === 'random'} title="Reverse sort order" onclick={() => { sortDirection *= -1; applySort(); }}><Icon name="sort" /></button>
    {/if}
    </div>
    <label class="inline-size"><Icon name="display" /><Slider type="single" min={1} max={10} step={1} value={11 - cols} onValueChange={resizeGrid} aria-label="Grid size" /></label>
    <div class="bar-modes" class:expanded={toolbar.selecting}>
      <button class="icon-button" aria-label="Choose toolbar mode" aria-expanded={toolbar.selecting} aria-controls="toolbar-mode-options" title="Display options" onclick={() => (toolbar.selecting = !toolbar.selecting)}><Icon name="filter" /></button>
      <div class="mode-options" id="toolbar-mode-options" use:keyboardScope={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModes(); } }} inert={!toolbar.selecting}>
        {#each [['library', 'Library'], ['filters', 'Filters'], ['layout', 'Layout'], ['look', 'Background'], ['3d', '3D'], ['theme', 'Theme']] as [mode, label] (mode)}
          <button aria-label={label === 'Filters' ? 'Library filters' : label} aria-pressed={toolbar.mode === mode} onclick={() => showMode(mode as BarMode)}>{label}</button>
        {/each}
      </div>
    </div>
    <button class="icon-button settings-trigger" aria-label="Settings" aria-pressed={player.view === 'settings'} title="Settings" onclick={() => open('settings')}><Icon name="settings" /></button>
  </div>
  {#if dig.open && !searching}<DigPanel matches={shown.length} total={sourceTiles.length} {tagged} onrandom={discover} />{/if}
  {#if toolbar.mode !== 'library'}
    <div class="secondary-controls"><button class="icon-button" aria-label="Back to library" onclick={() => { toolbar.mode = 'library'; toolbar.selecting = false; }}><Icon name="back" /></button>
    {#if filtersOpen}
      <div class="filter-tray">
        {#if !searching && library.mode === 'albums'}<LibrarySelect label="Filter by artist" bind:value={artistFilter} onchange={filterChanged} options={[{ value: '', label: 'All artists' }, ...artists.map(name => ({ value: name, label: name }))]} />{/if}
        <Button variant="ghost" size="sm" onclick={resetFilters}><Icon name="reset" /> Reset filters</Button>
        <span class="library-count">{searching ? 'Search covers every collection type' : `${shown.length} of ${sourceTiles.length} ${library.mode}`}</span>
      </div>
    {:else if toolbar.mode === 'layout'}
      <div class="controls">
        {#if advancedLayout}<label class="slider-control"><span>Columns</span><Slider type="single" min={1} max={10} step={1} value={cols} onValueChange={value => (cols = value)} aria-label="Album columns" /><output>{cols}</output></label><label class="slider-control"><span>Gap</span><Slider type="single" min={0} max={160} step={1} value={gap} onValueChange={value => (gap = value)} aria-label="Album spacing" /><output>{gap}</output></label>
        {:else}<label class="slider-control"><span>Grid size</span><Slider type="single" min={1} max={10} step={1} value={11 - cols} onValueChange={resizeGrid} aria-label="Advanced grid size" /><output>{effectiveCols} across</output></label>{/if}
        <Button variant="outline" size="sm" aria-pressed={advancedLayout} onclick={() => (advancedLayout = !advancedLayout)}>{advancedLayout ? 'Simple' : 'Advanced'}</Button>
      </div>
    {:else if toolbar.mode === 'look'}
      <div class="controls"><span class="group" role="radiogroup" aria-label="Background">{#each Object.entries(MATERIALS) as [key, label] (key)}<button class="opt" class:on={bg.material === key} role="radio" aria-checked={bg.material === key} disabled={key === 'custom' && !bg.custom} onclick={() => (bg.material = key as keyof typeof MATERIALS)}>{label}</button>{/each}<button class="opt" onclick={randomBackground}>Random</button></span></div>
    {:else if toolbar.mode === '3d'}
      <div class="controls">
        <span class="group" role="radiogroup" aria-label="3D view">{#each Object.entries(VIEWS) as [key, label] (key)}<button class:on={view3d === key} role="radio" aria-checked={view3d === key} onclick={() => setView(key as View)}>{label}</button>{/each}</span>
        {#if view3d !== 'off'}<Button variant="outline" size="sm" aria-pressed={loop} onclick={() => (loop = !loop)}>Loop</Button>{/if}
        {#if view3d === 'grid' && loop}<Button variant="outline" size="sm" aria-pressed={inf} onclick={() => (inf = !inf)}>Endless sides</Button>{/if}
        {#if view3d === 'jukebox' || view3d === 'flow'}<Button variant="outline" size="sm" aria-pressed={reflect} onclick={() => (reflect = !reflect)}>Reflections</Button>{/if}
      </div>
    {:else if toolbar.mode === 'theme'}<ComponentStyles />{/if}
    </div>
  {/if}
  {#if sort === 'color'}<div class="color-status" role="status">{catalog.colorsLoading ? `Reading cover colors · ${colorsReady} ready` : 'Cover colors ready'}<button disabled={catalog.colorsLoading} onclick={applySort}>Apply color sort</button></div>{/if}
</div>

{#snippet collectionCard(t: Tile, index = -1)}
      {@const playback = collectionPlayback(t)}
      <div class="tile-wrap" class:coverless={!t.cover} class:discovered={t.id === discoveryId} class:current={playback.current} class:listening={playback.listening}>
        <button class="tile" class:active={playback.listening} onclick={() => { details = t; player.queueOpen = false; player.view = ''; }} aria-label="Open {t.title} — {t.sub}" aria-current={playback.current ? 'true' : undefined}>
          {#if t.cover && (warmed.has(t.cover) || near(index))}<img src={t.cover} alt="" draggable="false" onload={() => warmed.add(t.cover)} />{/if}
        </button>
        <div class="tile-play"><CollectionPlayback collection={t} compact onplay={() => { if (!t.available) details = t; else pick(t); }} /></div>
        <div class="tile-info"><span class="tile-title">{t.title}<small>{t.sub}</small></span></div>
      </div>
{/snippet}

<!-- an image dropped anywhere becomes the custom background -->
<svelte:window onkeydown={e => {
  if (e.key !== 'Escape' || e.defaultPrevented || player.view || player.queueOpen || player.visOpen) return;
  if (details) details = null;
  else if (dig.open) { dig.open = false; document.querySelector<HTMLButtonElement>('[aria-label="Dig into your music"]')?.focus(); }
  else if (toolbar.mode !== 'library') { backToSelector(); document.querySelector<HTMLButtonElement>('[aria-label="Choose toolbar mode"]')?.focus(); }
  else return;
  e.preventDefault();
}} onpointermove={onmove} {ontouchstart}
  onfocusin={(e) => chromeFocus(e.target)} onfocusout={(e) => chromeFocus(e.relatedTarget)}
  ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) importBackground(f); }} />

<!-- the material sits on the cards' layer so it scrolls and drifts with them, or on the fixed viewport behind them -->
<!-- ponytail: a mouse wheel moves cover flow by its raw steps, no easing. Ease it if a notch feels abrupt -->
<div class="scroll" inert={covered} class:tilt class:flow class:fill={!bg.tile} class:m-vinyl={!onCards && bg.material === 'vinyl'} class:m-grille={!onCards && bg.material === 'grille'}
  class:m-fabric={!onCards && bg.material === 'fabric'} class:m-custom={!onCards && (bg.material === 'custom' || bg.material === 'noise')} style:--custom={bg.material === 'noise' ? `url("${noiseBackground}")` : bg.custom ? `url("${bg.custom}")` : 'none'} {onscroll} {onscrollend} onwheel={(e) => { if (flow && !e.deltaX) scroller.scrollLeft += e.deltaY; else if (e.deltaY < 0 && scrollTop <= 4) revealAtTop(); }} bind:this={scroller} bind:clientWidth={viewportWidth} bind:clientHeight={viewportHeight}>
  {#if searching}
    <CatalogSearch bind:kind={searchKind} top={filterHeight} cols={effectiveCols} gap={pixelGap} card={collectionCard}
      onclear={() => { query = ''; filterChanged(); }}
      onartist={artist => { query = ''; filterChanged(); onpick(artist); }} />
  {:else}
  <div class="stage" class:tilt class:flow style:perspective-origin={flow ? `50% ${floorY - tile / 2}px` : undefined}>
  {#if single}
    <!-- jukebox and cover flow: every cover is its own small layer -->
    {#each discs as { key, t, p } (key)}
      {@const at = pose(p)}
      <div class="disc" style:width="{tile}px" style:left="{(viewportWidth - tile) / 2}px" style:top="{floorY - tile}px"
        style:z-index={at.z} style:opacity={at.o} style:transform-origin={at.origin} style:transform={at.tf}>
        {@render collectionCard(t)}
        <!-- the mirror image is a second, flipped image under the cover with a plain gradient over it, painted once into
          the cover's own layer. The browser's reflection with a fade mask costs an offscreen pass per cover per frame
          (2 fps), and without the mask it cannot follow the slanted bottom edges -->
        {#if reflect && t.cover && (flow || p < 1)}<span class="mirror"><img src={t.cover} alt="" draggable="false" /></span>{/if}
      </div>
    {/each}
    <!-- the mirror images fade to black, so the floor under the row is black too: the background fades into it behind the covers -->
    {#if reflect}<div class="floor" style:--from="{floorY - tile * (flow ? 1 : 0.5)}px" style:--to="{floorY - tile * (flow ? 0.2 : 0)}px"></div>{/if}
  {:else if tilt}
    <!-- 3D: the plane, hinged at the bottom edge of the screen -->
    <div class="plane" style:width="{planeW}px" style:left="{(viewportWidth - planeW) / 2}px" style:transform-origin="{planeW / 2}px {viewportHeight}px"
      style:transform="rotateX({TILT}deg) translate3d({shiftX}px, {shiftY}px, 0)">
      {#each bands as { key, y, k, cells } (key)}
        <!-- zoom shrinks the row and all in it, shadows too, so scaled back up it looks the same; its own top is zoomed as well -->
        <div class="band" style:zoom={1 / k} style:top="{y * k}px" style:transform="scale({k})">
          {#each cells as { c, t, x } (c)}<div class="cell" style:left="{x}px" style:width="{tile}px">{@render collectionCard(t)}</div>{/each}
        </div>
      {/each}
    </div>
  {:else}
  <div class="grid" class:m-vinyl={onCards && bg.material === 'vinyl'} class:m-grille={onCards && bg.material === 'grille'}
    class:m-fabric={onCards && bg.material === 'fabric'} class:m-custom={onCards && (bg.material === 'custom' || bg.material === 'noise')} style:--cols={effectiveCols} style:--gap="max(0.2px, calc({gap} * var(--u)))"
    style:padding-top="{filterHeight + pixelGap + firstRow * rowStep}px" style:padding-bottom="calc(var(--botbar, 60px) + {pixelGap + (totalRows - lastRow) * rowStep}px)"
    style:transform="translate3d({drift.current.x * -8}px, {drift.current.y * -6}px, 0)">
    {#each visibleTiles as t, i (t.id)}
      {@render collectionCard(t, firstRow * effectiveCols + i)}
    {/each}
  </div>
  {/if}
  </div>
  <!-- the plane's end rests halfway up the screen; looping, the scroll length has no reachable end -->
  {#if flow}<div style:width="{viewportWidth + (looping ? SPAN : (rows - 1) * pitch)}px"></div>
  {:else if tilt}<div style:height="{looping ? SPAN : jukebox ? (rows - 1) * pitch : Math.max(0, pixelGap + rows * pitch + BASE - viewportHeight / 2)}px"></div>{/if}
  {/if}
</div>

{#if !searching && !shown.length && !library.loading}
  <div class="empty-library" inert={covered}>
    {#if window.desktop && !library.tiles.length && !desktop.status?.musicFolder}
      <h2>Your music starts here.</h2>
      <p>Add a music folder to start your collection.</p>
      <button onclick={chooseMusicFolder}>Add music folder</button>
    {:else if window.desktop && desktop.status?.musicFolder && !library.tiles.length && library.mode === 'albums'}
      <p>{library.scan.error || library.error ? 'Your music folder could not be loaded.' : !library.scan.checked ? 'Checking your music folder…' : library.scan.scanning ? 'Your collection is being indexed. Albums will appear here as they’re found.' : 'No music was found in this folder.'}</p>
      {#each desktop.status.musicFolders as folder (folder)}<p style:overflow-wrap="anywhere">{folder}</p>{/each}
      <button onclick={chooseMusicFolder}>Add music folder</button>
    {:else}
      <p>{library.scan.scanning ? 'Your collection is being indexed. Albums will appear here as they’re found.' : 'No music matches this view.'}</p>
      {#if digActive()}<p>Add mood and sound tags from an album’s menu, or clear Dig to see all music.</p><button onclick={resetDig}>Clear Dig</button>{:else if !library.scan.scanning}<button onclick={resetFilters}>Reset filters</button>{/if}
    {/if}
  </div>
{/if}


{#if library.scan.scanning}<div class="scan">indexing… {library.scan.count} songs</div>{/if}
{#if library.loading}<div class="library-status" role="status">Loading music…</div>{/if}
{#if currentDetails}{#key currentDetails.id}<CollectionDetails tile={currentDetails} onclose={() => (details = null)} />{/key}{/if}
{#if library.error || library.scan.error}<div class="library-status" role="alert">{library.error || library.scan.error}</div>{/if}

{#if player.view === 'settings'}<Settings bind:coversOnly bind:motion initialTab={settingsTab} onclose={() => (player.view = '')} />{/if}

<style>
  .scroll {
    --u: calc(100vw / 3312); position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; scrollbar-color: #333 #000; scrollbar-gutter: stable both-edges;
    /* built-in materials: each is grain + a structure + the same two diagonal light bands */
    --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.09 0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 200px 200px;
    --sheen: repeating-linear-gradient(105deg, #fff0 0, #ffffff0a 160px, #ffffff16 270px, #ffffff0a 380px, #fff0 520px,
        #fff0 780px, #ffffff0a 920px, #ffffff16 1030px, #ffffff0a 1140px, #fff0 1300px, #fff0 1400px);
  }
  .grid { display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: var(--gap); padding: calc(var(--topbar, 52px) + var(--gap)) var(--gap) calc(var(--botbar, 60px) + var(--gap)); min-height: 100%; box-sizing: border-box; will-change: transform; }
  .stage { display: contents; }
  /* the tilted plane runs to both screen edges: no scrollbar or reserved gutter strips; the plane itself shows the motion */
  .scroll.tilt { scrollbar-width: none; scrollbar-gutter: auto; }
  .scroll.flow { overflow-x: auto; overflow-y: hidden; }
  /* 3D stage: pinned to the viewport, rows darken toward the vanishing point. Perspective and tilt set the steepness;
     the plane's horizon sits just above the top edge */
  .stage.tilt { display: block; position: sticky; top: 0; left: 0; height: 100%; overflow: hidden; perspective: 100vh; }
  /* ponytail: a screen-space shade, so it also darkens the background in the top corners the plane leaves bare */
  .stage.tilt:not(.flow)::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to bottom, #000b 0, #0000 45%); }
  .plane { position: absolute; top: 0; height: 0; will-change: transform; }
  .band { position: absolute; left: 0; transform-origin: 0 0; will-change: transform; }
  .cell { position: absolute; top: 0; }
  /* the covers move under a resting pointer: an eased hover would redraw their row on every frame of every ease */
  .plane .tile-info { transition: none; }
  .disc { position: absolute; will-change: transform; }
  .mirror { position: absolute; left: 0; top: calc(100% + 2px); width: 100%; height: 45%; overflow: hidden; pointer-events: none; }
  .mirror img { display: block; width: 100%; height: auto; aspect-ratio: 1; object-fit: cover; transform: scaleY(-1); }
  .mirror::after { content: ''; position: absolute; inset: 0; background: linear-gradient(#000c, #000); }
  .floor { position: absolute; inset: 0; z-index: -1000; pointer-events: none; background: linear-gradient(#0000 var(--from), #000 var(--to)); }
  /* custom: the imported image as authored, repeated at its own size or stretched to cover */
  .m-custom { background: var(--custom) center / auto repeat #000; }
  .fill .m-custom, .fill.m-custom { background-size: cover; background-repeat: no-repeat; }
  /* vinyl: pressed hairline grooves */
  .m-vinyl { background: var(--grain), repeating-linear-gradient(to bottom, #fff0 0 2px, #00000033 2px 3px, #ffffff06 3px 4px), var(--sheen); }
  /* grille: perforated gunmetal, staggered round holes with a lit top edge, brushed base */
  .m-grille {
    background:
      var(--grain),
      radial-gradient(circle at 50% 50%, #000 0 2px, #ffffff10 2.3px 2.7px, #0000 3px) 0 0 / 9px 15.6px,
      radial-gradient(circle at 50% 50%, #000 0 2px, #ffffff10 2.3px 2.7px, #0000 3px) 4.5px 7.8px / 9px 15.6px,
      repeating-linear-gradient(to right, #ffffff05 0 1px, #0000 1px 3px),
      var(--sheen),
      linear-gradient(#1c1c1c, #151515);
  }
  /* fabric: fine crosshatch weave with a soft nap */
  .m-fabric {
    background:
      var(--grain),
      repeating-linear-gradient(45deg, #ffffff07 0 1px, #0000 1px 4px),
      repeating-linear-gradient(-45deg, #ffffff07 0 1px, #0000 1px 4px),
      repeating-linear-gradient(to bottom, #00000030 0 1px, #0000 1px 4px),
      var(--sheen),
      linear-gradient(#141414, #0e0e0e);
  }

  .browse { position: fixed; inset: 0 0 auto; z-index: 6; color: var(--ui-text); background: var(--ui-surface); border-bottom: 1px solid var(--ui-border); font: 12px/1.4 var(--ui-font); transition: transform 180ms ease-out, opacity 140ms ease-out; }
  .browse.hidden { opacity: 0; transform: translateY(-100%); pointer-events: none; }
  .compact-bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; min-height: 52px; box-sizing: border-box; }
  .browse button { font: inherit; color: inherit; cursor: pointer; border: 0; background: transparent; border-radius: 4px; }
  .browse button:hover { background: var(--ui-muted); } .browse button:disabled { opacity: .4; cursor: default; }
  .browse :is(input, button):focus-visible { outline: 2px solid var(--ui-text); outline-offset: 2px; }
  .browse-search { display: flex; align-items: center; gap: 7px; padding: 0 9px; min-width: 110px; flex: 1; background: var(--ui-muted); border: 1px solid var(--ui-border); border-radius: 4px; }
  .browse-search :global(svg) { width: 16px; height: 16px; }
  .browse-search input { width: 100%; min-width: 0; min-height: 32px; padding: 6px 0; border: 0; color: inherit; background: transparent; font: inherit; }
  :global(:root) .browse .browse-search input[type=search] { border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 6px 0; }
  :global(:root) .browse .browse-search input[type=search]::placeholder { color: var(--ui-text-muted); opacity: 1; }
  :global(:root) .browse .browse-search input[type=search]:focus-visible { outline: none; }
  .browse-search:focus-within { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
  .dig-trigger { display: flex; gap: 5px; align-items: center; min-height: 34px; padding: 5px 9px; white-space: nowrap; }
  .dig-trigger.selected { background: var(--ui-muted); }
  .compact-bar :global(.library-select-field) { width: 145px; min-width: 110px; border-radius: 4px; }
  .library-controls { display: contents; }
  .collection-filter :global(.library-select-field) { width: 105px; min-width: 90px; }
  .compact-bar :global(.library-select-field input) { height: 32px; padding: 6px 8px; font-size: 12px; }
  .icon-button { display: grid; place-items: center; flex: 0 0 34px; width: 34px; min-height: 34px; padding: 0; }
  .inline-size { display: flex; align-items: center; gap: 8px; flex: 0 0 140px; } .inline-size :global(svg) { width: 16px; height: 16px; } .inline-size :global([data-slot=slider]) { width: 100%; min-width: 70px; }
  .bar-modes { position: relative; }
  .mode-options { position: absolute; top: calc(100% + 8px); right: 0; width: 180px; padding: 6px; display: flex; flex-direction: column; background: var(--ui-surface); box-shadow: 0 10px 25px #0005; border-radius: 4px; opacity: 0; visibility: hidden; pointer-events: none; }
  .expanded .mode-options { opacity: 1; visibility: visible; pointer-events: auto; }
  .mode-options button { min-height: 40px; padding: 8px 12px; text-align: left; } .mode-options button[aria-pressed=true] { background: var(--ui-muted); }
  .secondary-controls { display: flex; gap: 12px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--ui-border); }
  .filter-tray, .controls { display: flex; align-items: center; gap: 16px; flex: 1; min-width: 0; flex-wrap: wrap; }
  .library-count { margin-left: auto; color: var(--ui-text-muted); } .slider-control { display: flex; align-items: center; gap: 12px; min-width: 240px; }
  .slider-control :global([data-slot=slider]) { flex: 1; } output { font-variant-numeric: tabular-nums; min-width: 3ch; }
  .group { display: flex; flex-wrap: wrap; gap: 6px; } .group button { padding: 8px 12px; min-height: 36px; } .group button.on { background: var(--ui-muted); }
  .color-status { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 14px; color: var(--ui-text-muted); border-top: 1px solid var(--ui-border); }
  .color-status button { color: var(--ui-text); min-height: 32px; padding: 4px 8px; text-decoration: underline; text-underline-offset: 3px; }
  /* --edge is the outline from Figma, drawn outside the cover: 2px with a glow on hover, 8px on a 200px tile (scaled with it) while playing */
  .tile-wrap { position: relative; isolation: isolate; aspect-ratio: 1; min-width: 0; container-type: inline-size; --edge: 2px; }
  .tile-wrap.listening { --edge: clamp(3px, 4cqw, 8px); }
  .tile-wrap:hover, .tile-wrap:focus-within, .tile-wrap.listening { z-index: 1; } /* the outline spills over the neighbours */
  .tile-wrap::after { content: ''; position: absolute; z-index: 4; inset: calc(-1 * var(--edge)); border: var(--edge) solid #fafafa; border-radius: calc(2px + var(--edge)); pointer-events: none; opacity: 0; }
  .tile-wrap:hover::after, .tile-wrap:focus-within::after, .tile-wrap.listening::after { opacity: 1; }
  .tile-wrap:not(.listening):hover::after, .tile-wrap:not(.listening):focus-within::after { box-shadow: 0 0 16px 4px #ffffff80; }
  .tile { all: unset; display: block; cursor: pointer; position: relative; width: 100%; height: 100%; overflow: hidden; background: #191919; border-radius: 2px; box-shadow: 0 3px 6px #0004; }
  .tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .tile:focus-visible { outline: 2px solid white; outline-offset: 3px; }
  .tile-play { position: absolute; z-index: 3; top: 6px; right: 8px; opacity: 0; pointer-events: none; }
  .tile-wrap:hover .tile-play, .tile-wrap:focus-within .tile-play, .tile-wrap.current .tile-play { opacity: 1; pointer-events: auto; }
  .tile-info { position: absolute; z-index: 2; bottom: 0; left: 0; right: 0; min-height: 50%; box-sizing: border-box; padding: 30px 8px 8px; display: flex; align-items: flex-end; gap: 8px; background: linear-gradient(transparent, #000000b3); color: #fafafa; pointer-events: none; opacity: 0; transition: opacity 120ms ease-out; font: 14px/1.43 var(--ui-font); }
  .tile-wrap:hover .tile-info, .tile-wrap:focus-within .tile-info, .discovered .tile-info, .coverless .tile-info { opacity: 1; }
  .tile-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; } .tile-title small { display: block; overflow: hidden; text-overflow: ellipsis; font-size: inherit; font-weight: 400; }
  .discovered { outline: 2px solid var(--ui-text); outline-offset: 3px; }
  .empty-library { position: fixed; inset: 35% 10% auto; text-align: center; color: var(--ui-text); font: 16px/1.5 var(--ui-font); }
  .empty-library p + p { color: var(--ui-text-muted); font-size: 13px; } .empty-library button { color: inherit; background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: 4px; padding: 10px 14px; cursor: pointer; font: inherit; margin: 4px; }
  .empty-library h2 { margin: 0 0 12px; font-size: 24px; font-weight: 600; letter-spacing: -.025em; }
  .empty-library button { min-height: 44px; }
  .empty-library button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  .library-status, .scan { position: fixed; left: 16px; bottom: 90px; max-width: min(650px, calc(100vw - 32px)); padding: 8px 12px; box-sizing: border-box; color: var(--ui-text); background: var(--ui-surface); z-index: 3; font: 12px/1.5 var(--ui-font); }
  @media (max-width: 1100px) { .inline-size { flex-basis: 100px; } .compact-bar { gap: 5px; padding-inline: 10px; } .compact-bar :global(.library-select-field) { width: 120px; min-width: 100px; } .collection-filter :global(.library-select-field) { width: 95px; min-width: 85px; } }
  @media (max-width: 700px) {
    .compact-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 6px; padding: 8px 10px; }
    .browse-search { grid-column: 1; grid-row: 1; } .dig-trigger { grid-column: 2; grid-row: 1; min-height: 44px; }
    .bar-modes { grid-column: 3; grid-row: 1; } .settings-trigger { grid-column: 4; grid-row: 1; }
    .library-controls { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: 6px; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--ui-border) transparent; padding: 2px 0 5px; }
    .collection-filter { flex: 0 0 100px; } .show-filter, .sort-filter { flex: 0 0 128px; } .sort-direction { flex: 0 0 44px; } .inline-size { display: none; }
    .compact-bar :global(.library-select-field) { width: 100%; min-width: 0; box-sizing: border-box; } .compact-bar :global(.library-select-field input) { height: 40px; }
    .browse-search input { min-height: 40px; } .icon-button { min-width: 44px; min-height: 44px; } .sort-direction { width: 44px; }
    .secondary-controls { align-items: flex-start; } .filter-tray, .controls { gap: 10px; } .filter-tray :global(.library-select-field) { flex: 1; min-width: 150px; width: auto; } .slider-control { min-width: 0; width: 100%; } .library-count { margin: 0; }
    .mode-options { right: -40px; } .color-status { font-size: 11px; flex-wrap: wrap; justify-content: flex-start; }
    .tile-info { font-size: 11px; }
  }
  @media (hover: none) { .tile-play { opacity: 1; pointer-events: auto; } }
  @media (prefers-reduced-motion: reduce) { .browse, .browse.hidden, .tile-info { transition: none; transform: none; } }
</style>
