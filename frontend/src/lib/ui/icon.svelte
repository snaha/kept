<script lang="ts">
  let { name }: { name: 'display' | 'settings' | 'star' | 'reset' | 'info' | 'filter' | 'shuffle' | 'play' | 'pause' | 'listening' | 'search' | 'more' | 'back' | 'forward' | 'close' | 'volume' | 'mute' | 'dig' | 'sort' | 'plus' | 'minus' } = $props();
  const paths = { filter: 'M4 7h16M4 17h16M8 4v6M16 14v6', shuffle: 'm18 3 3 3-3 3M3 18 15 6h6M3 6h3l3 3m6 6 3 3h3m-3-3 3 3-3 3', display: 'M4 4h16v5H4zM4 13h6v7H4zM14 13h6v7h-6z', star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z', reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6', info: 'M12 11v6M12 7h.01' };
</script>
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'settings'}<circle cx="12" cy="12" r="3" /><path d="M9 3h6l.7 3 2.1 1.2 3-.8 3 5.2-2.3 2.1v2.4l2.3 2.1-3 5.2-3-.8-2.1 1.2-.7 3H9l-.7-3-2.1-1.2-3 .8-3-5.2 2.3-2.1v-2.4L.2 11.6l3-5.2 3 .8L8.3 6Z" transform="translate(2.4 0) scale(.8)" />
  {:else if name === 'play'}<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />
  {:else if name === 'pause'}<path d="M8 5v14M16 5v14" stroke-width="4" />
  {:else if name === 'listening'}{#each ['M4 9v6', 'M9 5v14', 'M14 8v8', 'M19 3v18'] as d, i}<path class="listening-line" {d} style:animation-delay="{i * -180}ms" />{/each}
  {:else if name === 'search'}<circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
  {:else if name === 'more'}<circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" />
  {:else if name === 'back'}<path d="m10 5-7 7 7 7M3 12h18" />
  {:else if name === 'forward'}<path d="m14 5 7 7-7 7M3 12h18" />
  {:else if name === 'close'}<path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'volume' || name === 'mute'}<path d="M4 9h4l5-4v14l-5-4H4Z" />{#if name === 'mute'}<path d="m17 9 5 6m0-6-5 6" />{:else}<path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" />{/if}
  {:else if name === 'dig'}<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7ZM20 16v6m-3-3h6M4 2v4M2 4h4" />
  {:else if name === 'sort'}<path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'minus'}<path d="M5 12h14" />
  {:else}<path d={paths[name]} />{/if}
  {#if name === 'info'}<circle cx="12" cy="12" r="9" />{/if}
</svg>
<style>
  .listening-line { transform-box: fill-box; transform-origin: center; animation: listening 900ms ease-in-out infinite alternate; }
  @keyframes listening { from { transform: scaleY(.45); } to { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) { .listening-line { animation: none; } }
  svg { flex-shrink: 0; }
</style>
