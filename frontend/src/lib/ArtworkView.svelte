<script lang="ts">
  import type { Snippet } from 'svelte';
  import { artworkFocusScope } from './artwork-focus';
  import { keyboardScope } from './keyboard';
  let { id, label, palette, className = '', header, artwork, children, onkeydown, listElement = $bindable(), bodyElement = $bindable() }: {
    id?: string; label: string; palette: string; className?: string;
    header: Snippet; artwork: Snippet; children: Snippet;
    onkeydown: (event: KeyboardEvent) => void; listElement?: HTMLDivElement; bodyElement?: HTMLDivElement;
  } = $props();
</script>

<section {id} class="artwork-view {className}" style={palette} aria-label={label} use:keyboardScope={onkeydown} {@attach artworkFocusScope}>
  <header>{@render header()}</header>
  <div class="artwork-body" bind:this={bodyElement}>
    <aside>{@render artwork()}</aside>
    <div class="artwork-list" bind:this={listElement}>{@render children()}</div>
  </div>
</section>

<style>
  .artwork-view { position: fixed; inset: 0 0 var(--botbar, 60px); z-index: 7; display: flex; flex-direction: column; color: var(--play-text); background: var(--play-surface); font: 14px/1.4 var(--ui-font); transition: background-color 240ms ease-out, color 240ms ease-out; }
  header { display: flex; align-items: center; gap: 16px; min-height: 78px; padding: 12px 24px; box-sizing: border-box; border-bottom: 1px solid var(--play-line); flex-shrink: 0; }
  header :global(.detail-heading) { flex: 1; min-width: 0; }
  header :global(h1) { margin: 0; font-size: 22px; font-weight: 600; overflow-wrap: anywhere; }
  header :global(.detail-heading p) { margin: 3px 0 0; color: var(--play-muted); }
  .artwork-view :global(.detail-icon) { display: grid; place-items: center; width: 40px; min-height: 40px; flex-shrink: 0; border: 0; background: transparent; border-radius: 4px; padding: 0; font: inherit; color: inherit; cursor: pointer; }
  .artwork-view :global(.detail-icon:hover) { background: var(--play-line); }
  .artwork-view :global(button:focus-visible), .artwork-view :global(input:focus-visible) { outline: 2px solid var(--play-accent); outline-offset: 2px; }
  .artwork-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; padding: 32px max(24px, calc((100vw - 1680px) / 2)); flex: 1; min-height: 0; overflow: hidden; }
  aside, .artwork-list { min-width: 0; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; scrollbar-gutter: stable; }
  aside { display: flex; flex-direction: column; align-items: center; }
  aside :global(.detail-cover) { display: block; flex-shrink: 0; width: min(100%, calc(100dvh - var(--botbar, 60px) - 234px)); aspect-ratio: 1; object-fit: contain; border-radius: 2px; }
  aside :global(.detail-art-meta) { width: 100%; text-align: center; flex-shrink: 0; }
  .artwork-view ::selection { color: var(--play-bar); background: var(--play-accent); }
  @media (max-width: 1100px) { .artwork-body { gap: 32px; padding: 24px; } }
  @media (max-width: 700px) {
    header { min-height: 78px; padding: 10px 12px; gap: 8px; flex-wrap: wrap; }
    header :global(h1) { font-size: 18px; }
    .artwork-body { display: block; padding: 20px 16px 32px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; }
    aside, .artwork-list { overflow: visible; scrollbar-gutter: auto; }
    aside { margin-bottom: 28px; }
    aside :global(.detail-cover) { width: 100%; max-width: 360px; }
    .remote-player aside { flex-direction: row; gap: 16px; align-items: center; margin-bottom: 16px; }
    .remote-player aside :global(.detail-cover) { width: 80px; }
    .remote-player aside :global(.detail-art-meta) { width: auto; flex: 1; min-width: 0; text-align: left; }
    .remote-player aside :global(.detail-art-meta p) { margin: 0; }
    .artwork-view :global(.detail-icon) { min-height: 44px; min-width: 44px; }
  }
  @media (prefers-reduced-motion: reduce) { .artwork-view { transition: none; } }
</style>
