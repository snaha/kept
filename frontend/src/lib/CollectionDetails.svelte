<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { keyboardScope } from './keyboard';
  import { library, trackPages, pick, addCollection, grid, type Tile } from './library.svelte';
  import { collectionTrackIsCurrent, play, player, toggle, enqueue, setOrder } from './player.svelte';
  import { artworkPalette, fallbackPalette } from './artwork-palette';
  import { metadata } from './discovery.svelte';
  import CollectionPlayback from './CollectionPlayback.svelte';
  import AlbumTraits from './AlbumTraits.svelte';
  import Icon from './ui/icon.svelte';
  import AlbumView from './AlbumView.svelte';
  import type { Track } from './music';
  let { tile, onclose }: { tile: Tile; onclose: () => void } = $props();
  const info = $derived(metadata(tile));
  const coverUrl = $derived(tile.cover);
  let coverImage = $derived({ url: coverUrl, failed: false });
  let artworkActive = false;
  onMount(() => { artworkActive = true; return () => { artworkActive = false; }; });
  const requestKey = $derived(`${tile.id}:${tile.available}:${tile.indexing}:${tile.count}:${tile.incomplete}:${library.revision}`);
  let loadedId = '';
  let tracks = $state.raw<Track[]>([]), loading = $state(true), error = $state(''), query = $state(''), actions = $state(false), preferences = $state(false), palette = $state(fallbackPalette);
  const shown = $derived(tracks.map((track, index) => ({ track, index })).filter(({ track }) => `${track.title} ${track.artist ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const totalSeconds = $derived(tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0));
  const genreYear = $derived([...info.genres, ...(info.year ? [String(info.year)] : [])].join(' • '));
  // once the heading has scrolled under the top row, the title sits in the row instead
  let heading = $state<HTMLElement>(), collapsed = $state(false);
  function onscroll() { if (heading) collapsed = heading.getBoundingClientRect().bottom <= (heading.closest('.album-view')?.querySelector('header')?.getBoundingClientRect().bottom ?? 0); }
  $effect(() => { const cover = tile.cover; let active = true; void artworkPalette(cover).then(value => { if (active) palette = value; }); return () => { active = false; }; });
  $effect(() => {
    requestKey;
    const selected = untrack(() => tile); let canceled = false;
    if (selected.id !== loadedId) tracks = [];
    loadedId = selected.id; loading = true; error = '';
    void (async () => {
      try { let nextTracks: Track[] = []; for await (const page of trackPages(selected)) { if (canceled) return; nextTracks = [...nextTracks, ...page]; tracks = nextTracks; } }
      catch (e) { if (!canceled) error = (e as Error).message; }
      finally { if (!canceled) loading = false; }
    })();
    return () => { canceled = true; };
  });
  function listen(index: number) {
    const track = tracks[index]; if (!track?.available) return;
    if (collectionTrackIsCurrent(tile, tracks, index)) { void toggle(); return; }
    play(tracks.map(track => ({ ...track, playbackOrigin: tile })), index);
  }
  async function toggleActions() { actions = !actions; if (actions) { await tick(); document.querySelector<HTMLButtonElement>('#album-actions button')?.focus(); } }
  function actionKeys(event: KeyboardEvent) { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const items = [...document.querySelectorAll<HTMLButtonElement>('#album-actions button:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  // Per-track menus: one open at a time, native popover when available.
  const nativePopovers = typeof HTMLElement.prototype.showPopover === 'function' && typeof HTMLElement.prototype.hidePopover === 'function';
  let openTrackMenu = $state('');
  const trackMenuTrigger = (id: string) => document.querySelector<HTMLElement>(`[data-actions-for="${id}"]`);
  function positionTrackMenu(menu: HTMLElement) {
    const trigger = trackMenuTrigger(menu.id);
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - 168, bounds.right - 160))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - 80, bounds.bottom + 4))}px`;
  }
  function positionTrackActions(event: ToggleEvent) { if (event.newState === 'open') positionTrackMenu(event.currentTarget as HTMLElement); }
  function dismissTrackMenu(menu: HTMLElement, restoreFocus = true) {
    if (nativePopovers) menu.hidePopover();
    if (openTrackMenu === menu.id) openTrackMenu = '';
    if (restoreFocus) trackMenuTrigger(menu.id)?.focus({ preventScroll: true });
  }
  async function toggleTrackMenu(id: string) {
    if (nativePopovers) return;
    if (openTrackMenu === id) { openTrackMenu = ''; return; }
    openTrackMenu = id;
    await tick();
    const menu = document.getElementById(id);
    if (!menu || openTrackMenu !== id) return;
    positionTrackMenu(menu);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function closeTrackMenu(event: MouseEvent) {
    const menu = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-track-actions]');
    if (menu) dismissTrackMenu(menu);
  }
  function trackMenuKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissTrackMenu(event.currentTarget as HTMLElement); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
  function keys(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    const open = openTrackMenu ? document.getElementById(openTrackMenu) : null;
    if (open) { dismissTrackMenu(open); return; }
    if (preferences) preferences = false;
    else if (actions) { actions = false; document.querySelector<HTMLButtonElement>('[aria-label="Album menu"]')?.focus(); }
    else if (query) query = '';
    else onclose();
  }
  const fmt = (s = 0) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const total = (s: number) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`; };
</script>
<svelte:window onclick={event => {
  if (nativePopovers || !openTrackMenu || (event.target instanceof Element && event.target.closest('[data-track-actions], [data-actions-for]'))) return;
  const menu = document.getElementById(openTrackMenu);
  if (menu) dismissTrackMenu(menu, false);
}} onscrollcapture={() => { const menu = openTrackMenu ? document.getElementById(openTrackMenu) : null; if (menu) dismissTrackMenu(menu, false); }} />
<AlbumView className="album-view" {palette} label={`${tile.title} details`} onkeydown={keys} {onscroll}>
  {#snippet header()}
    <div class="album-header">
      <div class="header-row">
        <button class="icon-btn back" onclick={onclose} aria-label="Back to music"><Icon name="back" size={16} /></button>
        {#if collapsed}<span class="compact-title" aria-hidden="true">{tile.title}</span>{/if}
        <div class="menu-anchor">
          <button class="icon-btn menu-trigger" aria-label="Album menu" aria-expanded={actions} aria-controls="album-actions" aria-haspopup="menu" onclick={toggleActions}><Icon name="more-vertical" size={16} /></button>
          {#if actions}<div class="action-menu" id="album-actions" role="menu" aria-label="Album actions" use:keyboardScope={actionKeys}>
            <button role="menuitem" disabled={!tracks.some(track => track.available)} onclick={() => { void addCollection(tile); actions = false; }}>Add to queue</button>
            <button role="menuitem" onclick={() => { preferences = !preferences; actions = false; }}>Album preferences &amp; Dig tags</button>
          </div>{/if}
        </div>
      </div>
    </div>
  {/snippet}
  {#snippet artwork()}
    <div class="art-stack">
      {#if coverImage.url && !coverImage.failed}
        <img class="detail-cover" src={coverImage.url} alt="{tile.title} cover" onerror={event => {
          if (!artworkActive) return;
          if (event.currentTarget.getAttribute('src') === coverImage.url) coverImage = { ...coverImage, failed: true };
        }} />
      {:else}<div class="no-art detail-cover" role="img" aria-label="Artwork unavailable for {tile.title}">{tile.title}</div>{/if}
      {#if preferences}<AlbumTraits {tile} />{/if}
    </div>
  {/snippet}
  <div class="heading" bind:this={heading}>
    <h1>{tile.title}</h1>
    <div class="heading-meta">
      <p class="artist">{tile.sub}</p>
      {#if genreYear}<p class="genre-year">{genreYear}</p>{/if}
    </div>
  </div>
  <div class="actions">
    {#if loading || tracks.some(track => track.available)}<CollectionPlayback collection={tile} onplay={() => { void pick(tile); }} />{/if}
    <!-- shuffle is the player's own order, so Play starts shuffled; there is no repeat mode in the player yet, so no repeat control -->
    <button class="toggle" aria-pressed={player.order === 'shuffle'} aria-label="Shuffle" title="Shuffle" onclick={() => setOrder(player.order === 'shuffle' ? 'normal' : 'shuffle', grid)}><Icon name="shuffle" size={16} /></button>
    <label class="track-search"><Icon name="search" size={16} /><input aria-label="Search tracks" placeholder={tile.kind === 'playlist' ? 'Search playlist' : 'Search album'} bind:value={query} /></label>
  </div>
  <div class="track-list">
      {#if error}<p class="notice" role="alert">{error}</p>{/if}
      {#if loading && !tracks.length}<p class="notice" role="status">Loading tracks…</p>{/if}
      {#each shown as { track, index } (`${index}:${track.id}`)}
        {@const current = collectionTrackIsCurrent(tile, tracks, index)}
        {@const menuId = `track-actions-${index}`}
        <div class="track-row" class:current>
          <button class="track" disabled={!track.available} aria-label="{current && player.playing ? 'Pause' : 'Play'} {track.title}" onclick={() => listen(index)}>
            <span class="number">
              {#if current && player.playing}<Icon name="listening" size={16} />
              {:else if current}<Icon name="play" size={16} />
              {:else}{index + 1}{/if}
            </span>
            <span class="track-name">{track.title}{#if track.artist && (tile.kind === 'playlist' || track.artist !== tile.sub)}<span class="track-artist"> · {track.artist}</span>{/if}{#if !track.available}<span class="unavailable"> · Unavailable</span>{/if}</span>
            <span class="duration">{fmt(track.duration)}</span>
          </button>
          <button class="track-more" popovertarget={nativePopovers ? menuId : undefined} data-actions-for={menuId} aria-label="Actions for {track.title}" aria-haspopup="menu" aria-expanded={openTrackMenu === menuId} aria-controls={menuId} disabled={!track.available} onclick={() => void toggleTrackMenu(menuId)}><Icon name="more" size={16} /></button>
          <div class="track-menu" id={menuId} data-track-actions popover={nativePopovers ? 'auto' : undefined} hidden={!nativePopovers && openTrackMenu !== menuId} role="menu" aria-label="Actions for {track.title}" onbeforetoggle={positionTrackActions} ontoggle={event => {
            if (event.newState === 'open') { openTrackMenu = menuId; event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }
            else if (openTrackMenu === menuId) openTrackMenu = '';
          }} onfocusout={event => { const menu = event.currentTarget; if (openTrackMenu === menu.id && !menu.contains(event.relatedTarget as Node)) dismissTrackMenu(menu, false); }} use:keyboardScope={trackMenuKeys}>
            <button role="menuitem" onclick={event => { enqueue([{ ...track, playbackOrigin: tile }]); closeTrackMenu(event); }}>Add to queue</button>
          </div>
        </div>
      {/each}
      {#if !shown.length && !loading && !error}<p class="notice">{query ? 'No tracks match your search.' : 'No music tracks in this collection.'}</p>{/if}
    </div>
  {#if tracks.length}<p class="album-count">{tracks.length} {tracks.length === 1 ? 'song' : 'songs'} • {total(totalSeconds)}{#if loading} · Loading…{/if}</p>{/if}
</AlbumView>
<style>

  button { font: inherit; color: inherit; cursor: pointer; } button:disabled { opacity: .4; cursor: default; }
  .album-header { padding: 32px 32px 0; }
  .header-row { display: flex; align-items: center; gap: 8px; }
  .icon-btn { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; padding: 0; border: 0; border-radius: 10px; background: transparent; }
  .icon-btn:hover { background: var(--play-line); }
  .back { border: 1px solid var(--play-line); background: color-mix(in srgb, var(--play-text) 12%, transparent); }
  .menu-anchor { position: relative; margin-left: auto; }
  .action-menu { position: absolute; right: 0; top: 40px; width: 255px; z-index: 1; background: var(--play-bar); padding: 6px; border: 1px solid var(--play-line); box-shadow: 0 10px 25px #0004; border-radius: 10px; } .action-menu button { display: block; width: 100%; min-height: 40px; padding: 8px 12px; border: 0; background: transparent; text-align: left; } .action-menu button:hover { background: var(--play-line); }
  .compact-title { min-width: 0; font-size: 18px; line-height: 28px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-top: 32px; }
  h1 { margin: 0; font-size: 30px; line-height: 36px; font-weight: 700; overflow-wrap: anywhere; }
  .heading-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .artist { flex: 1 1 0; min-width: 0; margin: 0; font-size: 18px; line-height: 28px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .genre-year { flex: 1 1 0; min-width: 0; margin: 0; text-align: right; font-size: 14px; line-height: 20px; color: var(--play-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; align-items: center; gap: 16px; padding-top: 32px; }
  .toggle { display: grid; place-items: center; min-width: 36px; height: 36px; padding: 0 10px; border: 0; border-radius: 10px; background: transparent; }
  .toggle:hover { background: var(--play-line); } .toggle[aria-pressed=true] { color: var(--play-accent); background: var(--play-line); }
  .track-search { display: flex; gap: 6px; align-items: center; flex: 1 1 0; min-width: 0; max-width: 288px; height: 32px; margin-left: auto; box-sizing: border-box; padding: 0 10px; border: 1px solid var(--play-line); border-radius: 10px; color: var(--play-muted); }
  .track-search:focus-within { outline: 2px solid var(--play-accent); outline-offset: 2px; }
  .track-search input { background: transparent; border: 0; color: var(--play-text); font: 400 14px/20px var(--ui-font); width: 100%; min-width: 0; } .track-search input::placeholder { color: var(--play-muted); opacity: 1; }
  .track-list { margin-top: 32px; }
  .track-row { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--play-line); } .track-row:first-child { border-top: 1px solid var(--play-line); }
  .track-row:hover, .track-row:focus-within, .track-row.current { background: var(--play-line); }
  .track { flex: 1; min-width: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 32px; border: 0; background: transparent; padding: 0; text-align: left; }
  .number { display: grid; place-items: center; min-width: 24px; color: var(--play-muted); font-size: 14px; font-variant-numeric: tabular-nums; } .current .number { color: var(--play-text); }
  .track-name { min-width: 0; font-size: 16px; line-height: 24px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .track-artist, .unavailable { color: var(--play-muted); }
  .duration { color: var(--play-text); font-size: 16px; line-height: 24px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .track-more { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; padding: 0; border: 0; border-radius: 10px; background: transparent; }
  .track-more:hover { background: var(--play-line); }
  .track-menu { position: fixed; margin: 0; border: 0; color: var(--play-text); font: inherit; z-index: 9; width: 160px; box-sizing: border-box; background: var(--play-bar); padding: 6px; box-shadow: 0 8px 24px #0003; border-radius: 10px; }
  .track-menu button { display: block; width: 100%; min-height: 40px; padding: 10px 12px; border: 0; background: transparent; text-align: left; } .track-menu button:hover { background: var(--play-line); }
  .album-count { margin: 32px 0 0; font-size: 14px; line-height: 20px; }
  .notice { color: var(--play-muted); margin: 16px 0 0; line-height: 1.6; }
  .art-stack { width: 100%; margin: auto 0; display: flex; flex-direction: column; align-items: center; gap: 16px; min-width: 0; }
  .detail-cover { display: block; width: min(100%, calc(100dvh - var(--botbar, 60px) - 64px)); aspect-ratio: 1; object-fit: contain; border-radius: 2px; }
  .no-art.detail-cover { display: grid; place-items: center; background: var(--play-bar); padding: 24px; box-sizing: border-box; text-align: center; overflow-wrap: anywhere; }
  @media (max-width: 700px) {
    .album-header { padding: 16px 16px 0; }
    .heading { padding-top: 24px; }
    h1 { font-size: 18px; line-height: 24px; }
    .artist { font-size: 15px; line-height: 22px; }
    .actions { flex-wrap: wrap; row-gap: 12px; padding-top: 24px; }
    .track-search { order: 5; flex-basis: 100%; max-width: none; }
    .icon-btn, .toggle { min-width: 44px; min-height: 44px; }
    .track-search { height: 44px; }
    .track-more { width: 44px; height: 44px; }
    .detail-cover { width: 100%; max-width: 360px; }
    .track-row { padding: 8px 4px; }
  }
</style>
