<script lang="ts">
  import type { Snippet } from 'svelte';
  import { artworkFocusScope } from './artwork-focus';
  import { keyboardScope } from './keyboard';
  let { label, palette, className = '', header, artwork, children, onkeydown, listElement = $bindable() }: {
    label: string; palette: string; className?: string;
    header: Snippet; artwork: Snippet; children: Snippet;
    onkeydown: (event: KeyboardEvent) => void; listElement?: HTMLDivElement;
  } = $props();
</script>

<!-- Album layout: the header lives over the list column only, artwork spans the full height (Figma 54:5142). -->
<section class="album-view artwork-view {className}" style={palette} aria-label={label} use:keyboardScope={onkeydown} {@attach artworkFocusScope}>
  <header>{@render header()}</header>
  <div class="album-art">{@render artwork()}</div>
  <div class="album-content" bind:this={listElement}>{@render children()}</div>
</section>

<style>
  .album-view { position: fixed; inset: 0 0 var(--botbar, 60px); z-index: 7; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); grid-template-areas: 'header art' 'content art'; color: var(--play-text); background: var(--play-surface); font: 14px/1.4 var(--ui-font); transition: background-color 240ms ease-out, color 240ms ease-out; }
  /* the divider keeps scrolled rows off the artist line */
  header { grid-area: header; min-width: 0; border-bottom: 1px solid var(--play-line); }
  .album-content { grid-area: content; min-height: 0; box-sizing: border-box; padding: 0 32px 32px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .album-art { grid-area: art; min-width: 0; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; padding: 32px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; }
  .album-view :global(button:focus-visible), .album-view :global(input:focus-visible) { outline: 2px solid var(--play-accent); outline-offset: 2px; }
  .album-view ::selection { color: var(--play-bar); background: var(--play-accent); }
  @media (max-width: 700px) {
    .album-view { display: flex; flex-direction: column; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; }
    header { flex-shrink: 0; border-bottom: 0; } /* the whole view scrolls on phone, nothing slides under the header */
    .album-art { flex-shrink: 0; overflow: visible; padding: 0 16px; }
    .album-content { flex-shrink: 0; overflow: visible; scrollbar-gutter: auto; padding: 0 16px 32px; }
  }
  @media (prefers-reduced-motion: reduce) { .album-view { transition: none; } }
</style>
