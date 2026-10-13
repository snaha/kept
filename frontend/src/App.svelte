<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { restore, session } from './lib/api.svelte';
  import { library, MODES, pick, setMode } from './lib/library.svelte';
  import { next, player, prev, toggle } from './lib/player.svelte';
  import Bar from './lib/Bar.svelte';
  import Login from './lib/Login.svelte';
  import { startRuntime } from './lib/runtime';
  import { preferenceStatus } from './lib/preferences-status.svelte';
  import { retryPreferences, dismissPreferenceError } from './lib/preferences';
  import { catalog } from './lib/discovery.svelte';
  import { toolbar } from './lib/ui-style.svelte';
  import Grid from './lib/Grid.svelte';
  import Visualizer from './lib/Visualizer.svelte';
  import { bg } from './lib/background.svelte';
  import Startup from './lib/Startup.svelte';
  import { desktop, initDesktop } from './lib/desktop.svelte';

  let ready = $state(false), idle = $state(false);
  let dismissedStartupWarning = $state('');
  let idleTimer: ReturnType<typeof setTimeout>;

  onMount(() => { if (!window.desktop) restore().finally(() => (ready = true)); return startRuntime(); });
  onMount(initDesktop);
  onMount(() => { wake(); return () => clearTimeout(idleTimer); });
  $effect(() => { if (session.api) untrack(() => setMode('albums')); });
  let attempted = false;
  function connectDesktop() {
    attempted = true; desktop.error = '';
    void restore().then(() => { if (desktop.status?.phase === 'ready') ready = true; }).catch(error => { desktop.error = error.message; });
  }
  $effect(() => {
    const status = desktop.status;
    if (status && status.phase !== 'ready') { attempted = false; return; }
    if (status?.phase === 'ready' && !status.onboarding && !attempted) untrack(connectDesktop);
  });

  // any pointer activity (mouse move, tap, touch scroll) shows the bars; they fade again after a pause
  function wake() { idle = false; player.topHidden = false; clearTimeout(idleTimer); idleTimer = setTimeout(() => (idle = true), 2500); }

  function focusHelp(node: HTMLButtonElement) {
    const active = document.activeElement as HTMLElement | null;
    const previous = active?.closest('[aria-label="Playback options"]') ? document.querySelector<HTMLButtonElement>('button[aria-label="Playback options"]') : active;
    node.focus({ preventScroll: true });
    return { destroy() { if (previous?.isConnected && (document.activeElement === document.body || node.closest('.hint')?.contains(document.activeElement))) previous.focus({ preventScroll: true }); } };
  }
  let searchReturn: HTMLElement | null = null;
  async function focusSearch() {
    searchReturn = document.activeElement as HTMLElement;
    player.view = ''; player.queueOpen = false; player.shortcutsOpen = false; wake();
    toolbar.mode = 'library'; toolbar.selecting = false;
    await tick();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search library"]');
    input?.focus({ preventScroll: true }); input?.select();
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || !session.api) return;
    const target = e.target as HTMLElement;
    const editing = !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]');
    // the visualizer, open and closed: ctrl/cmd-T as in iTunes, and V, since a browser tab keeps ctrl-T for itself
    const combo = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (!e.altKey && !e.repeat && (combo ? key === 't' : key === 'v' && !editing)) { e.preventDefault(); player.visOpen = !player.visOpen; wake(); return; }
    if (player.visOpen) return; // the visualizer owns the keys while open
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); void focusSearch(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (player.shortcutsOpen) player.shortcutsOpen = false;
      else if (player.view) player.view = '';
      else if (player.queueOpen) { player.queueOpen = false; player.topHidden = true; }
      else if (target.matches('[aria-label="Search library"]')) { target.blur(); if (searchReturn?.isConnected) searchReturn.focus({ preventScroll: true }); }
      else return;
      e.preventDefault(); return;
    }
    if (editing) return;
    if (e.key === '/') { e.preventDefault(); void focusSearch(); return; }
    if (target.closest('[role="menu"], [role="radiogroup"], [role="tablist"]')) return;
    if (target.closest('[role="slider"]') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ', ...MODES.map((_, i) => String(i + 1))].includes(e.key)) return;
    if (e.repeat) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key.toLowerCase() === 'q') { player.queueOpen = !player.queueOpen; }
    else if (e.key.toLowerCase() === 's') { player.viewFrom = 'right'; player.view = player.view === 'settings' ? '' : 'settings'; }
    else if (e.key === '?') player.shortcutsOpen = !player.shortcutsOpen;
    else if (e.key === ' ' && !target.closest('button, summary, a')) toggle();
    else {
      const n = Number(e.key);
      if (n >= 1 && n <= MODES.length && !target.closest('button, summary, a')) setMode(MODES[n - 1]);
      else return;
    }
    e.preventDefault(); wake();
  }

</script>

{#if preferenceStatus.error || catalog.error}
  <div class="preference-notice" role="status">{preferenceStatus.error || catalog.error}
    <button onclick={retryPreferences}>Retry saving</button><button aria-label="Dismiss saving notice" onclick={() => { dismissPreferenceError(); catalog.error = ''; }}>Dismiss</button>
  </div>
{/if}
{#if desktop.status?.warning && dismissedStartupWarning !== desktop.status.warning}
  <div class="preference-notice" role="status">{desktop.status.warning}
    <button onclick={() => { dismissedStartupWarning = desktop.status?.warning || ''; }}>Dismiss</button>
  </div>
{/if}
<svelte:window onkeydown={onkeydown} onpointermove={wake} onpointerdown={wake} />

{#if window.desktop && (!ready || desktop.status?.phase !== 'ready' || desktop.status?.onboarding)}
  <Startup onretry={connectDesktop} />
{:else if !ready}
  <!-- black until we know whether a session exists -->
{:else if !session.api}
  <Login />
{:else}
  <Grid tiles={library.tiles} onpick={pick} activeId={player.song?.albumId} hidden={idle} />
  {#if player.shortcutsOpen}
    <aside class="hint" aria-label="Keyboard shortcuts">
      <div class="hint-title"><strong>Keyboard shortcuts</strong><button use:focusHelp onclick={() => (player.shortcutsOpen = false)} aria-label="Close keyboard shortcuts">×</button></div>
      <dl>
        <div><dt><kbd>Space</kbd></dt><dd>Play / pause</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous / next track</dd></div>
        <div><dt><kbd>/</kbd> <kbd>⌘ / Ctrl K</kbd></dt><dd>Search library</dd></div>
        <div><dt><kbd>Q</kbd></dt><dd>Open / close player</dd></div>
        <div><dt><kbd>S</kbd></dt><dd>Settings</dd></div>
        <div><dt><kbd>V</kbd> <kbd>⌘ / Ctrl T</kbd></dt><dd>Open / close the visualizer</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close the active view or menu</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd> in queue</dt><dd>Navigate queued tracks</dd></div>
        <div><dt><kbd>Tab</kbd></dt><dd>Navigate controls</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd> on seek</dt><dd>Seek 10 seconds</dd></div>
        {#each MODES as m, i (m)}<div><dt><kbd>{i + 1}</kbd></dt><dd>{m}</dd></div>{/each}
        <div><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
      </dl>
      <p>While typing, keys enter text. Space activates focused buttons.</p>
    </aside>
  {/if}
  <Bar hidden={idle} />
  <!-- one visualizer for both places: behind the grid as the background material, and fullscreen. Opening it fullscreen
    carries on from the picture the background shows -->
  {#if player.visOpen || bg.material === 'viz'}<Visualizer background={!player.visOpen} />{/if}
{/if}

<style>
  .hint { position: fixed; right: 20px; bottom: calc(var(--botbar, 76px) + 16px); z-index: 8; box-sizing: border-box; width: min(420px, calc(100vw - 32px)); max-height: calc(100dvh - var(--botbar, 76px) - 32px); overflow-y: auto; padding: 20px; border-radius: var(--ui-radius); background: var(--ui-surface); color: var(--ui-text); font: 14px/1.5 var(--ui-font); box-shadow: 0 12px 32px #0005; }
  .hint-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .hint button { background: transparent; border: 0; color: inherit; font: inherit; width: 44px; height: 44px; cursor: pointer; }
  .hint button:focus-visible { outline: 2px solid var(--ui-accent); }
  dl { margin: 8px 0 16px; }
  dl > div { display: grid; grid-template-columns: 45% 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ui-border); }
  dd { margin: 0; } dt, p { color: var(--ui-text-muted); } p { margin: 0; font-size: 12px; }
  kbd { font: inherit; color: var(--ui-text); }

.preference-notice { position: fixed; bottom: 80px; left: 16px; right: 16px; z-index: 100; padding: 12px; background: var(--bg, #18181b); color: var(--fg, #fff); border: 1px solid currentColor; border-radius: 8px; }
.preference-notice button { margin-left: 12px; }

</style>
