<script lang="ts">
  import { untrack } from 'svelte';
  import { metadata, saveMetadata, catalog } from './discovery.svelte';
  import Slider from './ui/slider.svelte';
  import type { Collection } from './music';
  let { tile }: { tile: Collection } = $props();
  const saved = untrack(() => metadata(tile));
  let genres = $state(saved.genres.join(', ')), year = $state<number | undefined>(saved.year);
  let enabled = $state(!!saved.traits);
  let traits = $state(saved.traits ? { ...saved.traits } : { mood: 50, energy: 50, acoustic: 50, vocal: 50 });
  function save() { saveMetadata(tile.id, { genres: genres.split(',').map(g => g.trim()).filter(Boolean), year: Number(year) || undefined, traits: enabled ? { ...traits } : undefined }); }
</script>
<div class="traits">
  <h3>Album preferences</h3>
  <label>Genres <input aria-label="Album genres" placeholder="Jazz, soul…" bind:value={genres} onchange={save} /></label>
  <label>Release year <input aria-label="Album release year" type="number" min="1" max="9999" bind:value={year} onchange={save} /></label>
  <label class="enable"><input type="checkbox" bind:checked={enabled} onchange={save} /> Tag mood and sound for Dig</label>
  {#if enabled}
    {#each [['mood', 'Sad', 'Happy'], ['energy', 'Calm', 'Intense'], ['acoustic', 'Electric', 'Acoustic'], ['vocal', 'Instrumental', 'Vocal']] as [key, left, right]}
      <div class="trait"><span>{left}</span><Slider type="single" min={0} max={100} step={1} value={traits[key as keyof typeof traits]} onValueChange={value => { traits[key as keyof typeof traits] = value; save(); }} aria-label="Album {left} to {right}" /><span>{right}</span></div>
    {/each}
  {/if}
  <p>Saved for this album in Kept. These are your tags; untagged albums stay in All music.</p>
  {#if catalog.error}<p role="alert">{catalog.error}</p>{/if}
</div>
<style>
  .traits { border-top: 1px solid var(--play-line); padding: 16px 8px 4px; font: 12px/1.5 var(--ui-font); }
  h3 { font-size: 13px; margin: 0 0 12px; } label { display: grid; grid-template-columns: 85px minmax(0, 1fr); align-items: center; gap: 8px; margin: 10px 0; }
  input { font: inherit; padding: 8px; min-width: 0; color: inherit; background: var(--play-surface); border: 1px solid var(--play-line); border-radius: 3px; }
  .enable { display: flex; gap: 8px; } .enable input { accent-color: var(--play-accent); }
  .trait { display: grid; grid-template-columns: 74px minmax(80px, 1fr) 74px; gap: 8px; align-items: center; margin: 10px 0; }
  .trait > span:last-child { text-align: right; } .trait :global([data-slot=slider]) { width: 100%; }
  p { color: var(--play-muted); margin: 12px 0 0; } input:focus-visible { outline: 2px solid var(--play-accent); }
</style>
