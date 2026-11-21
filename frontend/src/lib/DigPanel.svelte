<script lang="ts">
  import { onDestroy } from 'svelte';
  import { dig, digActive, resetDig, choosePreset, presets } from './discovery.svelte';
  import Slider from './ui/slider.svelte';
  import Icon from './ui/icon.svelte';
  import TraitMarker from './trait-marker.svelte';
  let { matches, total, tagged, estimated = 0, onrandom }: { matches: number; total: number; tagged: number; estimated?: number; onrandom: () => void } = $props();
  // The marker follows the pointer without publishing a library-wide filter change.
  let dragging = $state(false);
  let draftMood = $state(50), draftEnergy = $state(50);
  const mood = $derived(dragging ? draftMood : dig.mood);
  const energy = $derived(dragging ? draftEnergy : dig.energy);
  let pointerId: number | undefined;
  let dragBounds: DOMRect | undefined;
  let frame: number | undefined;
  let pendingPoint: { mood: number; energy: number } | undefined;
  function flushPoint() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (!pendingPoint) return;
    draftMood = pendingPoint.mood;
    draftEnergy = pendingPoint.energy;
    pendingPoint = undefined;
  }
  function point(event: PointerEvent) {
    const bounds = dragBounds;
    if (!bounds?.width || !bounds.height) return;
    pendingPoint = {
      mood: Math.round(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100))),
      energy: Math.round(Math.max(0, Math.min(100, 100 - (event.clientY - bounds.top) / bounds.height * 100))),
    };
    if (frame === undefined) frame = requestAnimationFrame(flushPoint);
  }
  function startDrag(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    if (pointerId !== undefined || event.button !== 0) return;
    pointerId = event.pointerId;
    dragBounds = event.currentTarget.getBoundingClientRect();
    draftMood = dig.mood;
    draftEnergy = dig.energy;
    dragging = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    point(event);
  }
  function finishDrag() {
    if (pointerId === undefined) return;
    flushPoint();
    pointerId = undefined;
    dragBounds = undefined;
    Object.assign(dig, { mood: draftMood, energy: draftEnergy, moodOn: true, preset: '' });
    dragging = false;
  }
  function endDrag(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    if (event.type === 'pointerup') point(event);
    finishDrag();
  }
  onDestroy(() => { if (frame !== undefined) cancelAnimationFrame(frame); });
  function key(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); finishDrag(); dig.moodOn = true; dig.preset = '';
    if (event.key === 'Home') { dig.mood = 50; dig.energy = 50; }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') dig.mood = Math.max(0, Math.min(100, dig.mood + (event.key === 'ArrowLeft' ? -5 : 5)));
    else dig.energy = Math.max(0, Math.min(100, dig.energy + (event.key === 'ArrowDown' ? -5 : 5)));
  }
</script>
<section id="dig-controls" class="dig-panel" aria-label="Dig into your music">
  <div class="presets" aria-label="Mood presets">
    <button onclick={onrandom} disabled={!matches}>Random pick</button>
    {#each presets as preset (preset[0])}<button class:selected={dig.preset === preset[0]} aria-pressed={dig.preset === preset[0]} onclick={() => { finishDrag(); choosePreset(preset); }}>{preset[0]}</button>{/each}
  </div>
  <div class="dig-body">
    <div class="mood-control">
      <button class="mood-map" class:active={dig.moodOn || dragging} aria-label="Mood map: {mood}% happy, {energy}% intense. Use arrow keys to adjust, Home to center." onkeydown={key}
        onpointerdown={startDrag} onpointermove={event => { if (event.pointerId === pointerId) point(event); }} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={endDrag}>
        <span class="corner tl">Angry, dark</span><span class="corner tr">Party, euphoric</span><span class="corner bl">Melancholic</span><span class="corner br">Peaceful, chill</span>
        <span class="axis left">Sad</span><span class="axis right">Happy</span><span class="axis top">Intense</span><span class="axis bottom">Calm</span>
        <span class="cross horizontal"></span><span class="cross vertical"></span>
        <span class="point" style:left="{mood}%" style:top="{100 - energy}%"></span>
      </button>
    </div>
    <div class="preferences">
      {#each [['familiarity', 'Familiar', 'Forgotten'], ['acoustic', 'Acoustic', 'Electric'], ['vocal', 'Vocal', 'Instrumental']] as [key, left, right] (key)}
        <div class="preference"><span>{left}</span><Slider type="single" min={0} max={100} step={1} value={key === 'familiarity' ? dig.familiarity : 100 - dig[key as 'acoustic' | 'vocal']} onValueChange={value => { dig[key as 'familiarity' | 'acoustic' | 'vocal'] = key === 'familiarity' ? value : 100 - value; dig.preset = ''; }} aria-label="{left} to {right}" /><span>{right}</span></div>
      {/each}
      <div class="dig-footer"><span role="status">{digActive() ? `${matches} matching` : total} {matches === 1 ? 'album' : 'albums'}</span><button onclick={() => { finishDrag(); resetDig(); }} disabled={!digActive()}><Icon name="reset" /> Reset</button></div>
      {#if estimated}<p class="legend"><span><TraitMarker source="hand" /> {tagged} tagged by you</span> <span><TraitMarker source="estimated" /> {estimated} estimated</span></p>{/if}
      <p>Mood and sound use your album tags ({tagged} tagged){estimated ? ' and Kept’s estimate of energy for the rest. Your tags always win' : ''}. Familiarity uses your listening history. Add tags from an album’s menu.</p>
    </div>
  </div>
</section>
<style>
  section { padding: 8px 16px 16px; color: var(--ui-text); border-top: 1px solid var(--ui-border); font: 12px/1.5 var(--ui-font); }
  button { font: inherit; color: inherit; cursor: pointer; }
  .presets { display: flex; gap: 6px; overflow-x: auto; padding: 6px 0 12px; scrollbar-width: thin; scrollbar-color: var(--ui-border) transparent; }
  .presets button { white-space: nowrap; border: 0; background: var(--ui-muted); padding: 6px 9px; border-radius: 4px; min-height: 32px; }
  .presets .selected { background: var(--ui-text); color: var(--ui-surface); }
  .dig-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; max-width: 1200px; margin: auto; }
  .mood-map { display: block; position: relative; width: 100%; height: 190px; padding: 0; border: 0; background: linear-gradient(0deg, #164047a6, transparent), linear-gradient(90deg, #493351, #53512f); touch-action: none; cursor: crosshair; color: #fff; }
  .corner, .axis { position: absolute; font-size: 10px; pointer-events: none; }
  .tl { top: 10px; left: 12px; } .tr { top: 10px; right: 12px; } .bl { bottom: 10px; left: 12px; } .br { bottom: 10px; right: 12px; }
  .axis.left { left: 12px; top: calc(50% - 7px); } .axis.right { right: 12px; top: calc(50% - 7px); }
  .axis.top { top: 10px; left: 50%; transform: translateX(-50%); } .axis.bottom { bottom: 10px; left: 50%; transform: translateX(-50%); }
  .cross { position: absolute; background: #ffffff30; pointer-events: none; } .horizontal { left: 15%; right: 15%; height: 1px; top: 50%; } .vertical { top: 20%; bottom: 20%; width: 1px; left: 50%; }
  .point { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; transform: translate(-50%, -50%); box-shadow: 0 2px 7px #0005; pointer-events: none; }
  .mood-map:not(.active) .point { opacity: .6; }
  .preferences { display: flex; flex-direction: column; gap: 12px; justify-content: center; }
  .preference { display: grid; grid-template-columns: 80px minmax(60px, 1fr) 90px; align-items: center; gap: 12px; }
  .preference > span:last-child { text-align: right; } .preference :global([data-slot=slider]) { width: 100%; }
  .dig-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .dig-footer button { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 0; min-height: 32px; }
  button:disabled { opacity: .45; cursor: default; } button:focus-visible { outline: 2px solid var(--ui-text); outline-offset: 3px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ui-text); } .legend span { display: inline-flex; align-items: center; gap: 6px; }
  p { margin: 0; color: var(--ui-text-muted); max-width: 65ch; font-size: 11px; }
  @media (max-width: 700px) { section { padding: 8px 12px 12px; max-height: calc(100dvh - 170px); overflow-y: auto; } .dig-body { grid-template-columns: 1fr; gap: 16px; } .mood-map { height: 170px; } .presets button, .dig-footer button { min-height: 44px; } }
</style>
