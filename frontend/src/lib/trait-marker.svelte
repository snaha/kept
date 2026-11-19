<script lang="ts">
  import type { TraitSource } from './traits'
  // Solid for values the user set, a dashed hollow ring for computed ones.
  let { source }: { source: TraitSource | 'unset' } = $props()
</script>
<span class="marker" data-source={source} aria-hidden="true"></span>
<style>
  .marker { display: inline-block; box-sizing: border-box; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; vertical-align: middle; }
  .marker[data-source=hand] { background: var(--ui-text); }
  .marker[data-source=estimated] { border: 1.5px dashed var(--ui-text-muted); }
  .marker[data-source=unset] { border: 1.5px dotted var(--ui-text-muted); opacity: .6; }
</style>
