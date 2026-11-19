<script lang="ts">
  import { untrack } from 'svelte';
  import { metadata, saveMetadata, catalog } from './discovery.svelte';
  import { TRAIT_KEYS, resolveTraits, hasSource, type EstimatedTraits, type TraitKey, type Traits } from './traits';
  import Slider from './ui/slider.svelte';
  import TraitMarker from './trait-marker.svelte';
  import type { Collection } from './music';
  // `estimated` carries computed values; it defaults to what the catalog holds for the album.
  let { tile, estimated }: { tile: Collection; estimated?: EstimatedTraits } = $props();
  const NEUTRAL = 50, PERCENT = 100;
  const saved = untrack(() => metadata(tile));
  let genres = $state(saved.genres.join(', ')), year = $state<number | undefined>(saved.year);
  let hand = $state<Partial<Traits>>({ ...saved.traits });
  let tagging = $state(!!saved.traits);
  let focused = $state<TraitKey | undefined>();
  const readings = $derived(resolveTraits(hand, estimated ?? catalog.estimated[tile.id]));
  const showSliders = $derived(tagging || hasSource(readings, 'estimated'));
  const rows = [['mood', 'Sad', 'Happy'], ['energy', 'Calm', 'Intense'], ['acoustic', 'Electric', 'Acoustic'], ['vocal', 'Instrumental', 'Vocal']] as const;
  function save(settled = true) { saveMetadata(tile.id, { genres: genres.split(',').map(g => g.trim()).filter(Boolean), year: Number(year) || undefined, traits: tagging && Object.keys(hand).length ? { ...hand } : undefined }, { settled }); }
  function toggle() {
    if (tagging) for (const key of TRAIT_KEYS) { if (!readings[key]) hand[key] = NEUTRAL; }
    else hand = {};
    save();
  }
  // Setting a value by hand always wins: the axis turns solid on the same frame.
  // The library hears of a drag once, on release. A value that never moved is not a change.
  function setHand(key: TraitKey, value: number, settled: boolean) {
    if (hand[key] === value && !settled) return;
    if (hand[key] === undefined && settled) return;
    hand[key] = value; tagging = true; save(settled);
  }
  const note = $derived.by(() => {
    const reading = focused ? readings[focused] : undefined;
    if (!focused) return hasSource(readings, 'estimated') ? 'Dashed values are estimated by Kept. Move one to set it yourself.' : '';
    if (!reading) return 'Not set yet. Move it to tag this axis.';
    if (reading.source === 'hand') return 'Set by you. Your tags always win.';
    const sure = reading.confidence === undefined ? '' : `, ${Math.round(reading.confidence * PERCENT)}% sure`;
    return `Estimated by Kept${sure}. Move it to set it yourself.`;
  });
</script>
<div class="traits">
  <h3>Album preferences</h3>
  <label>Genres <input aria-label="Album genres" placeholder="Jazz, soul…" bind:value={genres} onchange={() => save()} /></label>
  <label>Release year <input aria-label="Album release year" type="number" min="1" max="9999" bind:value={year} onchange={() => save()} /></label>
  <label class="enable"><input type="checkbox" bind:checked={tagging} onchange={toggle} /> Tag mood and sound for Dig</label>
  {#if showSliders}
    {#each rows as [key, left, right] (key)}
      {@const reading = readings[key]}
      {@const source = reading?.source ?? 'unset'}
      <div class="trait" data-source={source} data-trait={key} role="group" aria-label="{left} to {right}: {source === 'hand' ? 'set by you' : source === 'estimated' ? 'estimated' : 'not set'}"
        onpointerenter={() => focused = key} onpointerleave={() => { if (focused === key) focused = undefined; }} onfocusin={() => focused = key} onfocusout={() => { if (focused === key) focused = undefined; }}>
        <TraitMarker {source} /><span>{left}</span>
        <Slider type="single" min={0} max={100} step={1} value={reading?.value ?? NEUTRAL} onValueChange={value => setHand(key, value, false)} onValueCommit={value => setHand(key, value, true)} aria-label="Album {left} to {right}" />
        <span>{right}</span>
      </div>
    {/each}
    <p class="provenance" role="status">{note}</p>
  {/if}
  <p>Saved for this album in Kept. Your tags stay in Kept; untagged albums stay in All music.</p>
  {#if catalog.error}<p role="alert">{catalog.error}</p>{/if}
</div>
<style>
  .traits { border-top: 1px solid var(--play-line); padding: 16px 8px 4px; font: 12px/1.5 var(--ui-font); }
  h3 { font-size: 13px; margin: 0 0 12px; } label { display: grid; grid-template-columns: 85px minmax(0, 1fr); align-items: center; gap: 8px; margin: 10px 0; }
  input { font: inherit; padding: 8px; min-width: 0; color: inherit; background: var(--play-surface); border: 1px solid var(--play-line); border-radius: 3px; }
  .enable { display: flex; gap: 8px; } .enable input { accent-color: var(--play-accent); }
  .trait { display: grid; grid-template-columns: 10px 74px minmax(80px, 1fr) 74px; gap: 8px; align-items: center; margin: 10px 0; }
  .trait > span:last-child { text-align: right; } .trait :global([data-slot=slider]) { width: 100%; }
  .trait[data-source=estimated] :global([data-slot=slider-range]) { background: repeating-linear-gradient(90deg, var(--ui-text-muted) 0 4px, transparent 4px 7px); }
  .trait[data-source=estimated] :global([data-slot=slider-thumb]) { border-style: dashed; border-color: var(--ui-text-muted); background: transparent; }
  .trait[data-source=unset] { opacity: .6; }
  .trait[data-source=unset] :global([data-slot=slider-range]) { background: transparent; }
  .trait[data-source=unset] :global([data-slot=slider-thumb]) { border-style: dotted; background: transparent; }
  p { color: var(--play-muted); margin: 12px 0 0; } input:focus-visible { outline: 2px solid var(--play-accent); }
  .provenance { min-height: 3em; margin-top: 4px; }
</style>
