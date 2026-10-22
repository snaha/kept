<script lang="ts">
  import Icon from './ui/icon.svelte';
  import Slider from './ui/slider.svelte';
  import { tick } from 'svelte';
  import { session } from './api.svelte';
  import { jumpRandom, next, prev, player, seek, setOrder, setVolume, toggle, type Order } from './player.svelte';
  import { grid, library } from './library.svelte';
  import Queue from './Queue.svelte';
  import { artworkPalette, fallbackPalette } from './artwork-palette';
  let palette = $state(fallbackPalette);
  let failedCover = $state('');
  const playingCover = $derived(player.song?.cover ?? '');
  $effect(() => {
    const cover = playingCover;
    let active = true;
    if (!cover) palette = fallbackPalette;
    artworkPalette(cover).then(value => { if (active) palette = value; });
    return () => { active = false; };
  });
  import Share from './Share.svelte';
  let { hidden }: { hidden: boolean } = $props();
  // publish the bar height so the song list can pad for it
  let barHeight = $state(0);
  $effect(() => { document.documentElement.style.setProperty('--botbar', `${barHeight}px`); });
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // random picks songs from the albums the grid shows
  // icons after VLC's: an arrow into a stop bar for in order, crossing arrows for shuffle; a die for random, which VLC lacks
  const ORDERS: Record<Order, string> = { normal: 'In order', shuffle: 'Shuffle queue', random: 'Random from the grid' };
  // Playback options live in the expanded player header; the bottom menu toggles that view.
  let menuTop = $state(70);
  let menu = $state(false), key = $state<HTMLElement>(), panel = $state<HTMLElement>();
  function focusMenu(last = false) {
    const items = panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    (last ? items?.[items.length - 1] : items?.[0])?.focus();
  }
  function positionMenu() { menuTop = (key?.getBoundingClientRect().bottom || 64) + 6; }
  async function openMenu(last = false) { menu = true; await tick(); positionMenu(); focusMenu(last); }
  function menuKeys(e: KeyboardEvent) {
    const items = [...panel!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu = false; key?.focus(); }
    else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Tab') { menu = false; key?.focus(); }
  }
  function onclick(e: MouseEvent) {
    const t = e.target as Node;
    if (menu && !key?.contains(t) && !panel?.contains(t)) menu = false;

  }
  // a menu item that opens a view hands the screen to it
  function revealPlayer() { player.queueOpen = !player.queueOpen; }
  // the bar itself opens the album view of what is playing: the collection it was played from, or its album on the wall
  const playingAlbum = $derived.by(() => {
    const song = player.song; if (!song) return null;
    const origin = song.playbackOrigin;
    return library.tiles.find(tile => tile.id === (origin?.id ?? song.albumId)) ?? (origin ? { sub: song.artist ?? '', count: 0, available: true, ...origin } : null);
  });
  function showAlbum() {
    if (library.details) { library.details = null; return; }
    if (!playingAlbum) return;
    player.queueOpen = false; player.view = ''; library.details = playingAlbum;
  }
  $effect(() => { if (!player.queueOpen) menu = false; });
  function share() { player.viewFrom = 'bottom'; player.queueOpen = false; player.view = player.view === 'share' ? '' : 'share'; menu = false; }
  function visualize() { player.visOpen = true; menu = false; }
  const volume = $derived(player.volume);
  const volumeSupported = true;
  let rememberedLocal = 100;
  function mute() { if (volume > 0) { rememberedLocal = volume; setVolume(0); } else setVolume(rememberedLocal); }
</script>

<svelte:window {onclick} onresize={() => { if (menu) void tick().then(positionMenu); }} />

{#if session.api}
  <div class="playback-world" style={palette}>
  {#if player.queueOpen}<Queue {palette} onclose={() => (player.queueOpen = false)}>
    {#snippet options()}
      <button class="detail-icon" bind:this={key} onclick={() => { if (menu) menu = false; else void openMenu(); }} onkeydown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); void openMenu(e.key === 'ArrowUp'); } }} aria-label="Playback options" aria-haspopup="menu" aria-expanded={menu} aria-controls="playback-options"><Icon name="more" /></button>
    {/snippet}
  </Queue>{/if}
  {#if player.view === 'share'}<Share from={player.viewFrom} onclose={() => (player.view = '')} />{/if}
  <div id="playback-options" class="menu-panel" style:--options-top={`${menuTop}px`} class:open={menu} role="menu" aria-label="Playback options" aria-hidden={!menu} inert={!menu} bind:this={panel} onkeydown={menuKeys}>
    {#if session.admin}<button role="menuitem" tabindex={menu ? 0 : -1} class:on={player.view === 'share'} onclick={share}>Share</button>{/if}
    <button role="menuitem" tabindex={menu ? 0 : -1} onclick={() => { player.queueTab = 'history'; player.queueOpen = true; menu = false; }}>Recently played</button>
    <button role="menuitem" tabindex={menu ? 0 : -1} onclick={visualize}>Visualizer</button>
    <button role="menuitem" tabindex={menu ? 0 : -1} onclick={() => { player.shortcutsOpen = true; menu = false; }}>Keyboard shortcuts <span aria-hidden="true">?</span></button>
    <span class="rule"></span>
    <!-- stays open after a jump, so it can be pressed again right away -->
    <button role="menuitem" tabindex={menu ? 0 : -1} onclick={() => jumpRandom(grid)}>Play a random song</button>
    <span class="orders" role="group" aria-label="Play order">
      {#each Object.entries(ORDERS) as [o, label] (o)}
        <button role="menuitemradio" tabindex={menu ? 0 : -1} aria-checked={player.order === o} aria-label={label} title={label} class:on={player.order === o} onclick={() => setOrder(o as Order, grid)}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {#if o === 'normal'}<path d="M3 12h13M12 8l4 4-4 4M20 6v12" />
            {:else if o === 'shuffle'}<path d="M3 7h2.5c5.5 0 7.5 10 13 10H21M3 17h2.5c2.3 0 3.9-1.8 5.2-4M13.3 11c1.3-2.2 2.9-4 5.2-4H21M18 4l3 3-3 3M18 14l3 3-3 3" />
            {:else}<rect x="4" y="4" width="16" height="16" rx="3" />
              {#each [[8.5, 8.5], [15.5, 8.5], [12, 12], [8.5, 15.5], [15.5, 15.5]] as [cx, cy] (`${cx}${cy}`)}<circle {cx} {cy} r="1.1" fill="currentColor" stroke="none" />{/each}
            {/if}
          </svg>
          <span>{label}</span>
          <svg class="order-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
        </button>
      {/each}
    </span>
  </div>
  {#if player.error || player.pending || player.requesting || player.randomRequesting}
    <div class="playback-status" role="status">{player.error || (player.requesting || player.randomRequesting ? 'Loading tracks…' : 'Connecting playback…')}
      {#if player.error}<button onclick={() => { player.viewFrom = 'right'; player.view = 'settings'; }}>Settings</button><button onclick={() => (player.error = '')} aria-label="Dismiss playback message">×</button>{/if}
    </div>
  {/if}
  <div class="bar" class:hidden={hidden && !player.song && !player.queueOpen && !player.view && !menu && !player.pending && !player.error} class:lit={player.queueOpen || !!player.view || menu || !!library.details} bind:clientHeight={barHeight} role="group" aria-label="Playback bar">
    <button class="bar-toggle" onclick={showAlbum} aria-label={library.details ? 'Close album' : 'Show album'} aria-expanded={!!library.details} aria-controls="album-view"></button>
    {#if player.song}
      <span class="left">
        {#if playingCover && playingCover !== failedCover}<img src={playingCover} alt="" onerror={() => (failedCover = playingCover)} />
        {:else}<span class="cover-fallback" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="16" cy="16" r="12"/><circle cx="16" cy="16" r="8"/><circle cx="16" cy="16" r="2"/></svg></span>{/if}
        <span class="meta"><b>{player.song.title}</b> <span>{player.song.artist}{#if player.song.album}{' · '}{player.song.album}{/if}</span></span>
      </span>
    {:else}
      <span class="left"></span>
    {/if}
    <span class="ctl">
      <span class="btns">
        <button onclick={prev} disabled={!player.song} aria-label="Previous track" aria-keyshortcuts="ArrowLeft"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M5 5h2v14H5zM19 5v14L8 12z" /></svg></button>
        <button onclick={toggle} disabled={!player.queue.length} aria-label={player.playing || player.pending ? 'Pause' : 'Play'}><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">{#if player.pending}<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="24 20" />{:else if player.playing}<path d="M7 5h4v14H7zM14 5h4v14h-4z" />{:else}<path d="m8 4 13 8-13 8z" />{/if}</svg></button>
        <button onclick={next} disabled={!player.song} aria-label="Next track" aria-keyshortcuts="ArrowRight"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17 5h2v14h-2zM5 5l11 7-11 7z" /></svg></button>
      </span>

    </span>
    <div class="volume" title={`Volume ${volume}%`}>
      <button onclick={mute} disabled={!volumeSupported} aria-label={volume === 0 ? 'Unmute' : 'Mute'}><Icon name={volume === 0 ? 'mute' : 'volume'} /></button>
      <Slider type="single" min={0} max={100} step={1} value={volume} onValueChange={setVolume} disabled={!volumeSupported} aria-label="Local playback volume" />
    </div>
    <button class="key" class:down={player.queueOpen} onclick={revealPlayer} aria-expanded={player.queueOpen} aria-controls="player-view" aria-keyshortcuts="q" aria-label="Menu" title={player.queueOpen ? 'Close queue and recently played' : 'Open queue and recently played'}>
      {#if player.queueOpen}<Icon name="close" />{:else}<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>{/if}
    </button>
    <div class="progress" role="slider" tabindex="0" aria-label="Seek" aria-valuemin={0} aria-valuemax={player.duration || 0} aria-valuenow={Math.min(player.time, player.duration || 0)} aria-valuetext={`${fmt(player.time)} of ${fmt(player.duration)}`}
      onclick={(e) => { const bounds = e.currentTarget.getBoundingClientRect(); seek((e.clientX - bounds.left) / bounds.width); }}
      onkeydown={(e) => { if (!player.duration || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); seek(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (player.time + (e.key === 'ArrowLeft' ? -10 : 10)) / player.duration); }}>
      <span class="seek-times"><span>{fmt(player.time)}</span><span>−{fmt(Math.max(0, player.duration - player.time))}</span></span>
      <i style:width="{player.duration ? (player.time / player.duration) * 100 : 0}%"></i>
    </div>
  </div>
  </div>
{/if}

<style>
  .playback-world { color: var(--play-text); font-family: var(--ui-font); }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 8; display: flex; align-items: center; height: 60px; padding: 0 16px env(safe-area-inset-bottom, 0px); gap: 16px; background: #0d0d0df5; color: #fff; font: 12px/1.4 var(--ui-font); transition: opacity 180ms ease-out;
    --play-text: #fff; --play-muted: #b6b6b6; --play-accent: #eee; --play-bar: #121212; --play-line: #ffffff24; }
  .bar.hidden:not(:hover):not(:focus-within) { opacity: 0; pointer-events: none; }
  .bar:focus-within { opacity: 1; pointer-events: auto; }
  .bar button { border: 0; color: inherit; font: inherit; cursor: pointer; background: transparent; border-radius: 4px; }
  .bar button:hover, .bar .key.down { background: #ffffff18; }
  .bar button:disabled { opacity: .35; cursor: default; }
  .bar button:focus-visible, .progress:focus-visible { outline: 2px solid #eee; outline-offset: -3px; }
  .bar .bar-toggle { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; padding: 0; border-radius: 0; }
  .bar .left, .bar .volume, .bar .key { position: relative; z-index: 1; }
  .bar .left, .ctl, .volume { pointer-events: none; }
  .bar .btns button, .volume button, .volume :global([data-slot=slider]) { pointer-events: auto; }
  .bar .left { flex: 1; min-width: 0; max-width: calc(50% - 100px); display: flex; align-items: center; align-self: stretch; gap: 10px; padding: 0 8px 0 16px; margin-left: -16px; text-align: left; }
  .bar img, .cover-fallback { width: 42px; height: 42px; object-fit: cover; flex-shrink: 0; border-radius: 2px; }
  .cover-fallback { display: grid; place-items: center; color: var(--play-muted); background: var(--play-surface); }
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; } .meta b, .meta span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; } .meta b { font-weight: 500; } .meta span { color: #b6b6b6; font-size: 11px; }
  .ctl { position: absolute; z-index: 1; left: 50%; transform: translateX(-50%); } .btns { display: flex; align-items: center; }
  .bar .btns button { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; }

  .volume { margin-left: auto; display: flex; align-items: center; width: 120px; gap: 4px; }
  .volume button { display: grid; place-items: center; width: 36px; height: 40px; padding: 0; flex-shrink: 0; }
  .volume :global([data-slot=slider]) { flex: 1; width: auto; min-width: 0; } .volume :global([data-slot=slider-track]) { background: #555; height: 3px; } .volume :global([data-slot=slider-range]) { background: #eee; } .volume :global([data-slot=slider-thumb]) { background: #eee; border-color: #eee; width: 9px; height: 9px; }
  .bar .key { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; margin-right: -8px; flex-shrink: 0; } .bar .key svg { width: 20px; height: 20px; }
  .progress { --h: 2px; position: absolute; left: 0; right: 0; top: -9px; height: 18px; cursor: pointer; z-index: 1; }
  .progress::before { content: ''; position: absolute; left: 0; right: 0; top: 9px; height: var(--h); background: #ffffff24; } .progress i { position: absolute; left: 0; top: 9px; height: var(--h); background: #bcbcbc; }
  .progress:hover, .progress:focus-visible { --h: 5px; } .progress:hover i, .progress:focus-visible i { background: #fff; }
  .seek-times { display: flex; justify-content: space-between; position: absolute; left: 16px; right: 16px; bottom: 14px; font-size: 11px; opacity: 0; pointer-events: none; font-variant-numeric: tabular-nums; } .seek-times span { background: #141414; padding: 2px 5px; border-radius: 2px; } .progress:hover .seek-times, .progress:focus-visible .seek-times { opacity: 1; }
  .menu-panel { position: fixed; right: 24px; top: var(--options-top, 70px); z-index: 9; width: 250px; max-height: calc(100dvh - var(--botbar, 60px) - var(--options-top, 70px) - 16px); overflow-y: auto; box-sizing: border-box; padding: 8px; display: flex; flex-direction: column; gap: 4px; background: var(--play-bar); color: var(--play-text); font: 14px/1.4 var(--ui-font); border: 1px solid var(--play-line); border-radius: 6px; box-shadow: 0 10px 30px #0005; visibility: hidden; opacity: 0; pointer-events: none; transform: translateY(8px); transition: opacity 140ms ease-out, transform 140ms ease-out, visibility 0s 140ms; }
  .menu-panel.open { visibility: visible; opacity: 1; pointer-events: auto; transform: none; transition-delay: 0s; }
  .menu-panel button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; box-sizing: border-box; padding: 10px 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; border-radius: 4px; cursor: pointer; } .menu-panel button:hover, .menu-panel button.on { background: var(--play-line); } .menu-panel button:focus-visible { outline: 2px solid var(--play-accent); outline-offset: -2px; }
  .rule { height: 1px; background: var(--play-line); margin: 4px 12px; } .orders { display: flex; flex-direction: column; gap: 4px; } .orders button svg { flex-shrink: 0; } .orders button span { flex: 1; } .order-check { visibility: hidden; } .on .order-check { visibility: visible; } .menu-panel button > span[aria-hidden] { margin-left: auto; color: var(--play-muted); }
  .playback-status { position: fixed; bottom: calc(var(--botbar, 60px) + 16px); left: 50%; transform: translateX(-50%); max-width: min(90vw, 720px); background: #161616f5; color: #eee; padding: 12px 16px; border: 1px solid #555; border-radius: 6px; z-index: 10; font: 14px/1.5 var(--ui-font); }
  .playback-status button { background: none; color: white; font: inherit; border: 1px solid #777; border-radius: 3px; padding: 4px 8px; margin-left: 10px; cursor: pointer; }
  @media (max-width: 1100px) { .volume { width: 100px; } .bar .volume { margin-left: auto; }  }
  @media (max-width: 700px) {
    .bar { height: 68px; padding: 0 8px env(safe-area-inset-bottom, 0px); gap: 4px; }
    .bar .left { max-width: none; padding: 0; margin: 0; font-size: 12px; gap: 8px; } .bar img { width: 36px; height: 36px; } .meta { gap: 2px; } .meta span { font-size: 10px; }
    .ctl { position: static; transform: none; } .bar .btns button { width: 44px; height: 44px; } .bar .btns button:first-child { display: none; }
    .bar .volume { width: 44px; margin: 0; } .volume button { width: 44px; height: 44px; } .volume :global([data-slot=slider]) { display: none; } .bar .key { margin: 0; }
    .menu-panel { right: 12px; width: min(280px, calc(100vw - 24px)); }
  }
  @media (prefers-reduced-motion: reduce) { .bar, .menu-panel { transition: none; transform: none; } }
</style>
