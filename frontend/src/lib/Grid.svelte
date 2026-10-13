<script lang="ts">
  import { keyboardScope } from './keyboard';
  import { onDestroy, onMount, untrack } from 'svelte';
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
  import Visualizer from './Visualizer.svelte';
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
  type BarMode = 'library' | 'filters' | 'layout' | 'look' | 'theme';
  function closeModes() {
    if (document.activeElement?.matches(':focus-visible')) document.querySelector<HTMLButtonElement>('[aria-label="Choose toolbar mode"]')?.focus();
    toolbar.selecting = false;
  }
  function showMode(mode: BarMode) { toolbar.mode = mode; player.view = ''; closeModes(); }
  function backToSelector() { player.view = ''; toolbar.selecting = true; requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.mode-options button[aria-pressed=true]')?.focus()); }
  $effect(() => {
    writePreference('grid.cols', String(cols)); writePreference('grid.gap', String(gap));
    writePreference('covers.only', coversOnly ? '1' : '0'); writePreference('motion', motion ? '1' : '0');
    writePreference('library.source', library.source);
  });
  let query = $state('');
  let searchKind = $state('all');
  const searching = $derived(!!query.trim());
  const searchAccount = $derived(JSON.stringify([session.base, session.username]));
  const catalogRevision = $derived(library.revision);
  $effect(() => {
    const term = query.trim().slice(0, 500), source = library.source;
    session.api; searchAccount; catalogRevision;
    return untrack(() => startCatalogSearch(term, source));
  });
  let artistFilter = $state('');
  let sort = $state('title'), sortDirection = $state(1), sortRevision = $state(0), randomSeed = $state(Math.random());
  let showFilter = $state('all');
  let collectionMode = $derived<string>(library.mode);
  let colorOrder = $state.raw<Record<string, number>>({});
  $effect(() => { const tiles = sourceTiles; if (sort === 'color') untrack(() => warmColors(tiles)); });
  function applySort() { colorOrder = Object.fromEntries(sourceTiles.map(tile => [tile.id, catalog.colors[tile.id]?.hue ?? 361])); sortRevision++; filterChanged(); }
  function sortChanged() { if (sort === 'random') randomSeed = Math.random(); applySort(); }
  let favoritesOnly = $state(false);
  let details = $state.raw<Tile | null>(null);
  $effect(() => { if (player.queueOpen || player.visOpen || player.view === 'share') details = null; });
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
    scroller?.scrollTo({ top: Math.floor(index / effectiveCols) * rowStep, behavior: 'instant' });
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
  function filterChanged() { scrollTop = 0; details = null; player.queueOpen = false; player.view = ''; scroller?.scrollTo({ top: 0 }); }
  function changeMode(mode: Mode) { artistFilter = ''; favoritesOnly = false; filterChanged(); void setMode(mode); }
  function changeSource() { artistFilter = ''; filterChanged(); }
  function resetFilters() { query = ''; artistFilter = ''; library.source = 'all'; sort = 'title'; sortDirection = 1; showFilter = 'all'; favoritesOnly = false; coversOnly = false; resetDig(); filterChanged(); }

  let viewportWidth = $state(innerWidth), viewportHeight = $state(innerHeight), scrollTop = $state(0);
  const pixelGap = $derived(Math.max(0.2, gap * (viewportWidth + (innerWidth - viewportWidth)) / 3312));
  const effectiveCols = $derived(Math.min(cols, Math.max(1, Math.floor(viewportWidth / 140))));
  const rowStep = $derived(Math.max(1, (viewportWidth - pixelGap * (effectiveCols + 1)) / effectiveCols + pixelGap));
  const totalRows = $derived(Math.ceil(shown.length / effectiveCols));
  const firstRow = $derived(Math.max(0, Math.min(totalRows, Math.floor((scrollTop - filterHeight - pixelGap) / rowStep) - 2)));
  const lastRow = $derived(Math.min(totalRows, Math.ceil((scrollTop + viewportHeight - filterHeight) / rowStep) + 3));
  const visibleTiles = $derived(shown.slice(firstRow * effectiveCols, lastRow * effectiveCols));

  let scroller: HTMLDivElement;
  // Playback and background refreshes keep the user's scroll position.

  // subtle whole-grid drift with the mouse; native scroll does the rest
  const drift = new Spring({ x: 0, y: 0 }, { stiffness: 0.05, damping: 0.5 });
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
    if (next < scrollTop && next <= 4) revealAtTop();
    scrollTop = next;
  }
</script>

<div class="browse" class:hidden={!barShown} class:selecting={toolbar.selecting}
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
        {#each [['library', 'Library'], ['filters', 'Filters'], ['layout', 'Layout'], ['look', 'Background'], ['theme', 'Theme']] as [mode, label] (mode)}
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
    {:else if toolbar.mode === 'theme'}<ComponentStyles />{/if}
    </div>
  {/if}
  {#if sort === 'color'}<div class="color-status" role="status">{catalog.colorsLoading ? `Reading cover colors · ${colorsReady} ready` : 'Cover colors ready'}<button disabled={catalog.colorsLoading} onclick={applySort}>Apply color sort</button></div>{/if}
</div>

{#snippet collectionCard(t: Tile)}
      {@const playback = collectionPlayback(t)}
      <div class="tile-wrap" class:coverless={!t.cover} class:discovered={t.id === discoveryId} class:current={playback.current} class:listening={playback.listening}>
        <button class="tile" class:active={playback.listening} onclick={() => { details = t; player.queueOpen = false; player.view = ''; }} aria-label="Open {t.title} — {t.sub}" aria-current={playback.current ? 'true' : undefined}>
          {#if t.cover}<img src={t.cover} alt="" loading="lazy" draggable="false" />{/if}
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

<!-- the visualizer as background sits behind everything; the fullscreen one replaces it while open -->
{#if bg.material === 'viz' && !player.visOpen}<Visualizer background />{/if}

<!-- the material sits on the cards' layer so it scrolls and drifts with them, or on the fixed viewport behind them -->
<div class="scroll" class:fill={!bg.tile} class:m-vinyl={!bg.scroll && bg.material === 'vinyl'} class:m-grille={!bg.scroll && bg.material === 'grille'}
  class:m-fabric={!bg.scroll && bg.material === 'fabric'} class:m-custom={!bg.scroll && (bg.material === 'custom' || bg.material === 'noise')} style:--custom={bg.material === 'noise' ? `url("${noiseBackground}")` : bg.custom ? `url("${bg.custom}")` : 'none'} {onscroll} onwheel={(e) => { if (e.deltaY < 0 && scrollTop <= 4) revealAtTop(); }} bind:this={scroller} bind:clientWidth={viewportWidth} bind:clientHeight={viewportHeight}>
  {#if searching}
    <CatalogSearch bind:kind={searchKind} top={filterHeight} cols={effectiveCols} gap={pixelGap} card={collectionCard}
      onclear={() => { query = ''; filterChanged(); }}
      onartist={artist => { query = ''; filterChanged(); onpick(artist); }} />
  {:else}
  <div class="grid" class:m-vinyl={bg.scroll && bg.material === 'vinyl'} class:m-grille={bg.scroll && bg.material === 'grille'}
    class:m-fabric={bg.scroll && bg.material === 'fabric'} class:m-custom={bg.scroll && (bg.material === 'custom' || bg.material === 'noise')} style:--cols={effectiveCols} style:--gap="max(0.2px, calc({gap} * var(--u)))"
    style:padding-top="{filterHeight + pixelGap + firstRow * rowStep}px" style:padding-bottom="calc(var(--botbar, 60px) + {pixelGap + (totalRows - lastRow) * rowStep}px)"
    style:transform="translate3d({drift.current.x * -8}px, {drift.current.y * -6}px, 0)">
    {#each visibleTiles as t (t.id)}
      {@render collectionCard(t)}
    {/each}
  </div>
  {/if}
</div>

{#if !searching && !shown.length && !library.loading}
  <div class="empty-library">
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
