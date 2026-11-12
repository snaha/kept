<script lang="ts">
  import { collectionPlayback, cancelCollectionLoading, player, toggle } from './player.svelte';
  import Icon from './ui/icon.svelte';
  import type { Collection } from './music';
  let { collection, onplay, compact = false }: { collection: Collection; onplay: () => void; compact?: boolean } = $props();
  const state = $derived(collectionPlayback(collection));
  const label = $derived(state.loading ? `Cancel loading ${collection.title}` : state.listening ? `Pause ${collection.title}` : `${state.current ? 'Resume' : 'Play'} ${collection.title}`);
</script>
<button class:compact class:current={state.current} class="collection-play" aria-label={label} aria-busy={state.loading} title={label} onclick={() => state.loading && player.loadingCollectionId === collection.id && !player.pending ? cancelCollectionLoading() : state.current || state.loading ? void toggle() : onplay()}>
  {#if state.loading}<svg class="loading" viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.7" stroke-dasharray="28 24" /></svg>
  {:else if state.listening && compact}<span class="listening"><Icon name="listening" /></span><span class="pause"><Icon name="pause" /></span>
  {:else}<Icon name={state.listening ? 'pause' : 'play'} />{/if}
  {#if !compact}<span>{state.loading ? 'Loading…' : state.listening ? 'Pause' : state.current ? 'Resume' : 'Play'}</span>{/if}
</button>
<style>
  button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 16px; border: 0; border-radius: var(--ui-radius, 4px); background: var(--play-accent, var(--ui-text)); color: var(--play-bar, var(--ui-surface)); font: inherit; cursor: pointer; }
  button.compact { width: 36px; height: 36px; min-height: 36px; padding: 0; background: #101010e6; color: #fff; border-radius: 5px; }
  /* Full-size album pill per Figma: 36px tall, 10px radius, 16px icon, medium 14px label. */
  button:not(.compact) { gap: 6px; height: 36px; min-height: 36px; padding: 8px 10px; border-radius: 10px; font: 500 14px/20px var(--ui-font, system-ui); }
  button:not(.compact) :global(svg), button:not(.compact) svg.loading { width: 16px; height: 16px; }
  button:hover { filter: brightness(1.15); }
  button:focus-visible { outline: 2px solid var(--play-accent, var(--ui-text)); outline-offset: 3px; }
  .loading { animation: loading-turn 900ms linear infinite; }
  .pause { display: none; } button:hover .listening, button:focus-visible .listening { display: none; } button:hover .pause, button:focus-visible .pause { display: contents; }
  @keyframes loading-turn { to { transform: rotate(360deg); } }
  @media (pointer: coarse) { button, button.compact { min-width: 44px; min-height: 44px; } }
  @media (prefers-reduced-motion: reduce) { .loading { animation: none; } }
</style>
