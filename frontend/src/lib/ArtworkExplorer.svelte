<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { keyboardScope } from './keyboard';
  import CityCanvas from './chronocity/CityCanvas.svelte';
  import GalleryScene from './artwork-space/GalleryScene.svelte';
  import { clampCursor, galleryNames, type GalleryMode } from './artwork-space/layout';
  import { metadata } from './discovery.svelte';
  import { addCollection, trackPages, type Tile } from './library.svelte';
  import { playlistArtworks } from './chronocity/artworks';
  import type { Track } from './music';
  import CollectionPlayback from './CollectionPlayback.svelte';
  import { spotifyPlayable, spotifyMessage } from './spotify.svelte';
  import Icon from './ui/icon.svelte';

  let { albums, mode, layoutKey, discoveryId = '', active, paused, top, onpick, onopen, onexit }: {
    albums: Tile[]; mode: GalleryMode; layoutKey: string; discoveryId?: string; active: boolean; paused: boolean; top: number;
    onpick: (album: Tile) => void; onopen: (album: Tile) => void; onexit: () => void;
  } = $props();
  let cursor = $state(0), roots = $state.raw<Tile[]>([]), collection = $state<Tile | null>(null), artworks = $state.raw<Tile[]>([]);
  let loading = $state(false), collectionError = $state(''), reduced = $state(false), visible = $state(true);
  let ready = $state(false), failed = $state(false), rendererKind = $state(''), missing = $state(0), zoom = $state(1), revision = $state(0);
  let renderedCursor = $state(0), renderedCount = $state(0), cameraDistance = $state(0);
  let artBounds = $state([0, 0, 0, 0]);
  let consoleElement = $state<HTMLElement>();
  let bottomClearance = $state(240);
  let world = $state<GalleryScene>();
  let region: HTMLElement;
  let previousKey = '', request = 0, previousDiscovery = '', snapTimer: ReturnType<typeof setTimeout>;
  const cache = new Map<string, Tile[]>();
  const list = $derived(collection ? artworks : roots);
  const index = $derived(Math.round(clampCursor(cursor, list.length)));
  const selected = $derived(list[index]);
  const selectedMeta = $derived(selected ? metadata(selected) : null);
  const years = $derived([...new Set(list.map(album => metadata(album).year ?? null))].sort((a, b) => (a ?? 10000) - (b ?? 10000)));
  const running = $derived(active && visible && !paused);
  const unavailable = $derived(selected && (!selected.available || (selected.source === 'spotify' && !spotifyPlayable())));
  const subtitles: Record<GalleryMode, string> = { flow: 'A folded shelf of original artwork.', panels: 'An angled gallery through depth and height.', orbit: 'A spiral archive of your album artwork.' };
  $effect(() => {
    const element = consoleElement;
    if (!element) return;
    const measure = () => { bottomClearance = element.offsetHeight + (element.parentElement!.clientWidth < 700 ? 78 : 74) + 24; };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    const incoming = albums, key = layoutKey;
    untrack(() => {
      const id = roots[Math.round(cursor)]?.id;
      roots = incoming;
      if (previousKey !== key) { request++; collection = null; artworks = []; loading = false; collectionError = ''; cursor = 0; cache.clear(); zoom = 1; }
      else if (!collection) { const retained = roots.findIndex(album => album.id === id); cursor = retained >= 0 ? clampCursor(retained + cursor - Math.round(cursor), roots.length) : clampCursor(cursor, roots.length); }
      previousKey = key;
    });
  });
  $effect(() => {
    const id = discoveryId;
    untrack(() => { if (id && id !== previousDiscovery) { const found = list.findIndex(album => album.id === id); if (found >= 0) choose(found); } previousDiscovery = id; });
  });
  $effect(() => { if (!active && loading) untrack(() => { request++; loading = false; collectionError = 'Artwork loading paused. Retry to load the remaining albums.'; }); });
  onMount(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => (reduced = media.matches); update(); media.addEventListener('change', update);
    const visibility = () => (visible = !document.hidden); document.addEventListener('visibilitychange', visibility);
    return () => { media.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); };
  });
  onDestroy(() => { request++; clearTimeout(snapTimer); });
  function choose(next: number) { clearTimeout(snapTimer); cursor = clampCursor(next, list.length); }
  function browse(amount: number) {
    cursor = clampCursor(cursor + amount, list.length); clearTimeout(snapTimer);
    snapTimer = setTimeout(() => { cursor = Math.round(cursor); }, 140);
  }
  function back() { request++; const id = collection?.id; collection = null; artworks = []; loading = false; collectionError = ''; choose(Math.max(0, roots.findIndex(album => album.id === id))); }
  async function enterPlaylist(album: Tile) {
    const token = ++request; collection = album; artworks = cache.get(album.id) ?? []; cursor = 0; collectionError = '';
    if (cache.has(album.id)) return;
    loading = true;
    const tracks: Track[] = [];
    try {
      for await (const page of trackPages(album)) {
        if (token !== request) return;
        tracks.push(...page);
        const next = playlistArtworks(tracks, roots.filter(tile => tile.kind === 'album'));
        // Album IDs, rather than cover URLs, identify members. Paging appends in place.
        const order = new Map(artworks.map((tile, index) => [tile.id, index]));
        artworks = next.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      }
      if (token !== request) return;
      if (!artworks.length) collectionError = 'This playlist does not expose album artwork. Open Tracks for its source details.';
      else { cache.set(album.id, artworks); if (cache.size > 12) cache.delete(cache.keys().next().value!); }
    } catch (error) { if (token === request) collectionError = (error as Error).message || 'Could not load this playlist. Retry or open Tracks for details.'; }
    finally { if (token === request) loading = false; }
  }
  function activate(id: string) {
    const found = list.findIndex(album => album.id === id);
    if (found < 0) return;
    if (found !== index) choose(found);
    else if (selected?.kind === 'playlist') void enterPlaylist(selected);
    else if (selected) onopen(selected);
  }
  function keys(event: KeyboardEvent) {
    if (!running || event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, select, textarea'))) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      choose(event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1));
    } else if (event.key === 'Enter' && event.target === region && selected) { event.preventDefault(); event.stopPropagation(); activate(selected.id); }
    else if (event.key === 'Escape' && collection) { event.preventDefault(); event.stopPropagation(); back(); }
  }
  function wheel(event: WheelEvent) {
    if (!running || event.ctrlKey || !(event.target instanceof HTMLCanvasElement)) return;
    event.preventDefault(); browse(Math.max(-2, Math.min(2, (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 0.12 : 0.006))));
  }
  let gesture: { id: number; x: number; y: number; last: number; moved: boolean } | undefined;
  function down(event: PointerEvent) {
    if (!running || event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
    region.focus({ preventScroll: true }); gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, last: event.clientX, moved: false }; region.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) gesture.moved = true;
    if (gesture.moved) { browse((gesture.last - event.clientX) * 0.014); gesture.last = event.clientX; }
  }
  function up(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (!gesture.moved) { const id = world?.pick(event.clientX, event.clientY); if (id) activate(id); }
    else choose(Math.round(cursor));
    gesture = undefined; if (region.hasPointerCapture(event.pointerId)) region.releasePointerCapture(event.pointerId);
  }
</script>

<section class="artwork-explorer" class:concealed={!active} inert={!active || paused} style:--scene-top="{top}px" aria-label="{galleryNames[mode]} artwork exploration" tabindex="-1" bind:this={region} use:keyboardScope={keys} onwheel={wheel} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => { gesture = undefined; choose(Math.round(cursor)); }} data-mode={mode} data-renderer={rendererKind} data-ready={ready} data-selected={selected?.id ?? ''} data-cursor={renderedCursor.toFixed(3)} data-mesh-count={renderedCount} data-camera-distance={cameraDistance.toFixed(2)} data-art-bounds={artBounds.map(value => value.toFixed(1)).join(',')} data-collection={collection?.id ?? ''} data-artworks={artworks.length} data-reduced={reduced} data-running={running}>
  {#if !failed && list.length}
    <div class="world">{#key revision}<CityCanvas active={running} onbackend={kind => (rendererKind = kind)} onerror={() => (failed = true)}><GalleryScene bind:this={world} albums={list} {cursor} {mode} active={running} {reduced} {zoom} {bottomClearance} inCollection={!!collection} onready={() => (ready = true)} onmissing={count => (missing = count)} onframe={(position, count, distance, bounds) => { renderedCursor = position; renderedCount = count; cameraDistance = distance; artBounds = bounds; }} /></CityCanvas>{/key}</div>
  {/if}
  <header><h1>{galleryNames[mode]}</h1><p>{subtitles[mode]}</p></header>
  <div class="view-options"><button class="zoom-button" aria-label="Zoom out of artwork" disabled={zoom <= 0.75} onclick={() => (zoom = Math.max(0.75, zoom - 0.1))}><Icon name="minus" /></button><button class="zoom-button" aria-label="Zoom into artwork" disabled={zoom >= 1.15} onclick={() => (zoom = Math.min(1.15, zoom + 0.1))}><Icon name="plus" /></button><button onclick={() => (zoom = 1)}>Fit artwork</button></div>
  {#if collection}
    <div class="collection-strip"><button onclick={back}><Icon name="back" /> Playlists</button><span>{collection.title} · {artworks.length} albums{loading ? ' · Loading artwork…' : ''}</span><button onclick={() => onopen(collection!)}>Tracks</button></div>
    {#if collectionError}<p class="collection-error" role="alert">{collectionError} <button onclick={() => void enterPlaylist(collection!)}>Retry artwork</button></p>{/if}
  {/if}
  {#if selected}
    <div class="album-console" bind:this={consoleElement}>
      <div class="album-copy"><button class="album-title" title={selected.title} onclick={() => onopen(selected)}>{selected.title}</button><p>{selected.sub}</p><span class="album-meta">{selectedMeta?.year ?? 'Undated'} · {selected.count} tracks{selectedMeta?.genres.length ? ` · ${selectedMeta.genres.join(' / ')}` : ''}</span></div>
      <div class="album-actions"><CollectionPlayback collection={selected} onplay={() => unavailable ? onopen(selected) : onpick(selected)} /><button onclick={() => onopen(selected)}>Tracks</button><button disabled={!!unavailable} onclick={() => void addCollection(selected)} aria-label="Add {selected.title} to queue">Queue</button>{#if selected.kind === 'playlist'}<button onclick={() => void enterPlaylist(selected)}>Explore artwork</button>{/if}</div>
      {#if unavailable}<p class="availability">{selected.source === 'spotify' ? spotifyMessage() : 'Playback unavailable. Open Tracks for details.'}</p>{/if}
    </div>
    <nav class="gallery-navigation" aria-label="Artwork navigation">
      <button class="step" aria-label="Previous artwork" disabled={index === 0} onclick={() => choose(index - 1)}><Icon name="back" /></button>
      <select aria-label="Jump to artwork release year" value={selectedMeta?.year ?? 'undated'} onchange={event => { const found = list.findIndex(album => String(metadata(album).year ?? 'undated') === event.currentTarget.value); if (found >= 0) choose(found); }}>{#each years as year}<option value={year ?? 'undated'}>{year ?? 'Undated'}</option>{/each}</select>
      <button class="step" aria-label="Next artwork" disabled={index >= list.length - 1} onclick={() => choose(index + 1)}><Icon name="forward" /></button><span class="position">{index + 1} / {list.length}</span>
      <p>Scroll or drag to browse · arrow keys to select · click the selected cover to open</p>
    </nav>
  {:else if collection && loading}<div class="scene-message" role="status"><h2>Opening playlist artwork…</h2><p>Albums appear as their tracks arrive.</p></div>
  {:else if !collection}<div class="scene-message"><h2>No artwork in this view</h2><p>Adjust your library filters or add music to explore your collection.</p><button onclick={onexit}>Return to cover wall</button></div>{/if}
  {#if failed}<div class="scene-message" role="alert"><h2>This gallery couldn’t render</h2><p>Your albums are still available in the cover wall.</p><button onclick={() => { failed = false; ready = false; revision++; }}>Try again</button><button onclick={onexit}>Return to cover wall</button></div>{/if}
  {#if !ready && list.length && !failed}<p class="scene-status" role="status">Opening the gallery…</p>{:else if missing}<p class="scene-status" role="status">{missing} artwork{missing === 1 ? '' : 's'} unavailable · titles remain visible</p>{/if}
</section>

<style>
  .artwork-explorer { position: fixed; inset: var(--scene-top) 0 var(--botbar, 60px); overflow: hidden; background: #141719; color: #eeeae2; font-family: var(--ui-font); isolation: isolate; }
  .concealed { visibility: hidden; pointer-events: none; }
  .artwork-explorer:focus-visible { outline: 2px solid #d1b382; outline-offset: -3px; }
  .artwork-explorer ::selection { background: #d1b382; color: #141719; }
  .world { position: absolute; inset: 0; touch-action: none; cursor: grab; } .world:active { cursor: grabbing; }
  header { position: absolute; top: 22px; left: 28px; pointer-events: none; }
  h1 { margin: 0; font-size: 26px; line-height: 1.15; font-weight: 550; letter-spacing: -.025em; }
  header p { margin: 8px 0 0; font-size: 12px; color: #bcc7ce; }
  .view-options { position: absolute; top: 18px; right: 24px; display: flex; gap: 6px; }
  button, select { border: 1px solid #89949d66; border-radius: 4px; background: #182027; color: #eeeae2; padding: 8px 12px; min-height: 40px; font: inherit; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #d1b382; background: #222b32; } button:disabled { opacity: .4; cursor: default; }
  :is(button, select):focus-visible { outline: 2px solid #d1b382; outline-offset: 3px; }
  button :global(svg) { width: 16px; height: 16px; }
  .zoom-button, .step { display: grid; place-items: center; width: 40px; padding: 0; }
  .album-console { position: absolute; bottom: 74px; left: 28px; right: 28px; width: fit-content; max-width: min(620px, calc(100% - 56px)); padding: 12px 16px; box-sizing: border-box; border-radius: 6px; background: #12191ff5; }
  .album-title { display: block; width: 100%; max-width: 100%; padding: 0; min-height: auto; border: 0; background: transparent; text-align: left; font-size: clamp(20px, 2vw, 28px); line-height: 1.2; letter-spacing: -.025em; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .album-copy p { margin: 6px 0; font-size: 13px; color: #d0d9df; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .album-meta { display: block; font-size: 11px; color: #bcc7ce; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .album-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .album-actions :global(.collection-play) { --play-accent: #d1b382; --play-bar: #12191f; font-size: 12px; }
  .availability { color: #f2c79d; font-size: 12px; margin: 8px 0 0; max-width: 65ch; }
  .gallery-navigation { position: absolute; bottom: 14px; left: 28px; right: 28px; display: flex; align-items: center; gap: 8px; }
  select { color-scheme: dark; max-width: 125px; }
  .position { color: #bcc7ce; font-size: 12px; font-variant-numeric: tabular-nums; margin-left: 8px; }
  .gallery-navigation p { margin: 0 0 0 auto; font-size: 11px; color: #bcc7ce; }
  .collection-strip { position: absolute; top: 80px; left: 28px; right: 28px; display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .collection-strip button { display: flex; align-items: center; gap: 6px; }
  .collection-strip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 65ch; padding: 8px; background: #12191ff5; }
  .collection-error { position: absolute; top: 132px; left: 28px; right: 28px; padding: 12px; background: #12191ff5; color: #f2c79d; font-size: 13px; max-width: 65ch; }
  .scene-message { position: absolute; inset: 25% 24px auto; max-width: 420px; margin: auto; background: #12191f; padding: 24px; }
  .scene-message h2 { font-size: 24px; margin: 0 0 12px; } .scene-message p { color: #bcc7ce; font-size: 14px; line-height: 1.6; }
  .scene-message button + button { margin-left: 8px; }
  .scene-status { position: absolute; top: 120px; left: 28px; color: #bcc7ce; font-size: 12px; background: #12191f; padding: 8px; }
  @media (max-width: 700px) {
    header { top: 18px; left: 16px; } h1 { font-size: 22px; } header p { display: none; }
    .view-options { top: 12px; right: 12px; gap: 5px; } .view-options button { padding: 7px 9px; }
    button, select, .album-actions :global(button) { min-height: 44px; }
    .zoom-button, .step { width: 44px; }
    .album-console { left: 16px; right: 16px; width: auto; max-width: none; bottom: 78px; padding: 12px; }
    .album-title { font-size: 20px; } .album-actions { gap: 6px; margin-top: 9px; } .album-actions button { padding: 8px 10px; }
    .gallery-navigation { left: 16px; right: 16px; bottom: 16px; } .gallery-navigation p { display: none; } .position { margin-left: auto; }
    .collection-strip { top: 68px; left: 16px; right: 16px; gap: 6px; } .collection-strip span { flex: 1; min-width: 0; }
    .collection-strip button { padding: 8px; font-size: 11px; }
    .collection-error { top: 112px; left: 16px; right: 16px; }
    .scene-status { top: 124px; left: 16px; right: 16px; }
  }
</style>
