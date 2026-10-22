<script lang="ts">
  import type { Snippet } from 'svelte';
  import { artworkFocusScope } from './artwork-focus';
  import { keyboardScope } from './keyboard';
  let { label, palette, className = '', header, artwork, children, onkeydown, onscroll, listElement = $bindable() }: {
    label: string; palette: string; className?: string;
    header: Snippet; artwork: Snippet; children: Snippet;
    onkeydown: (event: KeyboardEvent) => void; onscroll?: () => void; listElement?: HTMLDivElement;
  } = $props();
</script>

<!-- Album layout: the header row lives over the list column only, artwork spans the full height (Figma 54:5142). Scrolled,
  the heading goes and the rows slide under the row through a fade (Figma 109:21480); scroll is captured because the
  list scrolls on desktop and the whole view on phone -->
<section id="album-view" class="album-view artwork-view {className}" style={palette} aria-label={label} use:keyboardScope={onkeydown} onscrollcapture={onscroll} {@attach artworkFocusScope}>
  <header>{@render header()}</header>
  <div class="album-art">{@render artwork()}</div>
  <div class="album-content" bind:this={listElement}>{@render children()}</div>
</section>

<style>
  .album-view { position: fixed; inset: 0 0 var(--botbar, 60px); z-index: 7; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); grid-template-areas: 'header art' 'content art'; color: var(--play-text); background: var(--play-surface); font: 14px/1.4 var(--ui-font); transition: background-color 240ms ease-out, color 240ms ease-out; }
  header { grid-area: header; min-width: 0; position: relative; z-index: 1; }
  header::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 40px; background: linear-gradient(var(--play-surface), transparent); pointer-events: none; }
  .album-content { grid-area: content; min-height: 0; box-sizing: border-box; padding: 0 32px 32px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .album-art { grid-area: art; min-width: 0; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; padding: 32px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; }
  .album-view :global(button:focus-visible), .album-view :global(input:focus-visible) { outline: 2px solid var(--play-accent); outline-offset: 2px; }
  .album-view ::selection { color: var(--play-bar); background: var(--play-accent); }
  @media (max-width: 700px) {
    .album-view { display: flex; flex-direction: column; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--play-line) transparent; overscroll-behavior: contain; }
    header { flex-shrink: 0; position: sticky; top: 0; background: var(--play-surface); }
    .album-art { flex-shrink: 0; overflow: visible; padding: 0 16px; }
    .album-content { flex-shrink: 0; overflow: visible; scrollbar-gutter: auto; padding: 0 16px 32px; }
  }
  @media (prefers-reduced-motion: reduce) { .album-view { transition: none; } }
</style>
