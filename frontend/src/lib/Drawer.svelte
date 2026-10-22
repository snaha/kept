<script lang="ts">
  import { player } from './player.svelte';
  import { keyboardScope } from './keyboard';
  import { onMount, type Snippet } from 'svelte';
  import { reveal } from './ui/motion';

  // a translucent layer over the grid, closed with a chevron.
  // 'bottom': rises from the player bar and leaves it visible
  // 'right': slides in from the right and fills exactly the space between top bar, side panel and player bar
  let { from = 'bottom', onclose, children }: { from?: 'bottom' | 'right'; onclose: () => void; children: Snippet } = $props();
  let handle: HTMLButtonElement;
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    handle.focus({ preventScroll: true });
    return () => { if (previous?.isConnected && (document.activeElement === document.body || handle.closest('.panel')?.contains(document.activeElement))) previous.focus({ preventScroll: true }); };
  });
</script>

<div role="region" aria-label="Details panel" use:keyboardScope={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (player.shortcutsOpen) player.shortcutsOpen = false; else onclose(); } }} class="panel" class:right={from === 'right'} in:reveal={from === 'right' ? { x: 32, duration: 260 } : { y: 24, duration: 260 }} out:reveal={from === 'right' ? { x: 16, duration: 140 } : { y: 12, duration: 140 }}>
  <!-- the whole strip along the edge closes the drawer; the chevron sits centred in it -->
  <button bind:this={handle} class="handle" onclick={onclose} aria-label={from === 'right' ? 'Back' : 'Close'}><span>{from === 'right' ? '›' : '⌄'}</span></button>
  {@render children()}
</div>

<style>
  .panel {
    --s: clamp(0.85px, 100vw / 1600, 1.3px);
    /* covers the whole viewport underneath the bottom bar, so it sits on the dark panel with no seam */
    position: fixed; inset: 0; padding: 0 0 var(--botbar, 0px); box-sizing: border-box;
    display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.85); color: #eee; z-index: 8; /* above the album view (7), under the bar */
  }
  /* right variant: the bottom layout rotated — chevron on the right edge, centred, pointing right */
  .panel:not(.right) { top: var(--browsebar, 0px); }
  .panel.right { inset: var(--topbar, 0px) 0 var(--botbar, 0px) auto; width: min(520px, 100vw); padding: 0; flex-direction: row-reverse; background: var(--ui-surface, #18181b); border-left: 1px solid var(--ui-border, #ffffff26); box-shadow: -12px 0 40px #0005; z-index: 4; }
  .handle {
    all: unset; cursor: pointer; align-self: stretch; display: flex; align-items: center; justify-content: center;
    padding: calc(6 * var(--s)) 0; font-size: calc(32 * var(--s)); line-height: 1; color: #fff; transition: background 250ms;
  }
  .right .handle { padding: 0 calc(10 * var(--s)); }
  .handle span { opacity: .6; transition: opacity 250ms, text-shadow 250ms, transform 250ms; }
  .handle:hover, .handle:focus-visible { background: rgba(255, 255, 255, 0.04); }
  /* the chevron swells and gets a tight bright halo plus a wide soft one */
  .handle:hover span, .handle:focus-visible span {
    opacity: 1; font-weight: 700; transform: scale(1.15);
    text-shadow: 0 0 calc(4 * var(--s)) rgba(255, 255, 255, 0.9), 0 0 calc(20 * var(--s)) rgba(255, 255, 255, 0.5);
  }
  @media (prefers-reduced-motion: reduce) { .handle, .handle span { transition: none; } .handle:hover span, .handle:focus-visible span { transform: none; } }
</style>
