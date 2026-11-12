<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte'
  import type { Collection } from './music'
  import CollectionPlayback from './CollectionPlayback.svelte'

  let { tiles, top, selectedId = $bindable(''), onopen, onplay }: {
    tiles: Collection[]
    top: number
    selectedId?: string
    onopen: (tile: Collection) => void
    onplay: (tile: Collection) => void
  } = $props()
  const MAX_COVER = 440
  const MIN_COVER = 160
  const WIDTH_RATIO = 0.62
  const HEIGHT_RATIO = 0.55
  const STEP_RATIO = 0.68
  const NEIGHBORS = 4
  const SIDE_TURN = 52
  const SIDE_SCALE = 0.18
  const FOREGROUND_ART_SIZE = 1024
  const WHEEL_LINE_PIXELS = 16
  let width = $state(0)
  let height = $state(0)
  let position = $state(0)
  let scroller: HTMLDivElement
  let frame = 0
  let focusFrame = 0
  let generation = 0
  let disposed = false
  let placedId = ''
  let placedStep = 0
  let placedIndex = -1
  const coverSize = $derived(Math.max(MIN_COVER, Math.min(MAX_COVER, width * WIDTH_RATIO, height * HEIGHT_RATIO)))
  const step = $derived(coverSize * STEP_RATIO)
  const index = $derived(Math.max(0, Math.min(tiles.length - 1, Math.round(position))))
  const selected = $derived(tiles[index])
  const start = $derived(Math.max(0, index - NEIGHBORS))
  const visible = $derived(tiles.slice(start, index + NEIGHBORS + 1))

  function artwork(tile: Collection, foreground: boolean) {
    if (!foreground || !tile.cover) return tile.cover
    try {
      const url = new URL(tile.cover, location.href)
      if (url.pathname.endsWith('/rest/getCoverArt')) url.searchParams.set('size', String(FOREGROUND_ART_SIZE))
      return url.href
    } catch { return tile.cover }
  }
  function cancelFocus() {
    generation++
    cancelAnimationFrame(focusFrame)
  }
  onMount(() => {
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX || !event.deltaY) return
      event.preventDefault()
      cancelFocus()
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? width : 1
      scroller.scrollBy({ left: event.deltaY * scale, behavior: 'instant' })
    }
    scroller.addEventListener('wheel', wheel, { passive: false })
    return () => scroller.removeEventListener('wheel', wheel)
  })
  function onscroll() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (disposed || !scroller) return
      position = scroller.scrollLeft / step
      const current = tiles[Math.max(0, Math.min(tiles.length - 1, Math.round(position)))]
      if (current) {
        selectedId = current.id
        placedId = current.id
        placedIndex = Math.round(position)
      }
    })
  }
  async function select(next: number, focus = false) {
    const mine = ++generation
    const bounded = Math.max(0, Math.min(tiles.length - 1, next))
    if (!tiles[bounded]) return
    cancelAnimationFrame(frame)
    cancelAnimationFrame(focusFrame)
    selectedId = tiles[bounded].id
    placedId = selectedId
    placedIndex = bounded
    position = bounded
    await tick()
    if (disposed || mine !== generation) return
    scroller.scrollTo({ left: bounded * step, behavior: 'instant' })
    if (!focus) return
    focusFrame = requestAnimationFrame(() => {
      if (disposed || mine !== generation) return
      scroller.querySelector<HTMLButtonElement>(`[data-collection-id="${CSS.escape(selectedId)}"]`)?.focus({ preventScroll: true })
    })
  }
  export function reveal(id: string) {
    const next = tiles.findIndex(tile => tile.id === id)
    if (next < 0) return false
    void select(next, true)
    return true
  }
  // Preserve the centered album through refreshes and resizes, never follow playback implicitly.
  $effect(() => {
    const nextTiles = tiles
    const nextStep = step
    if (!scroller || !width || !nextTiles.length) return
    untrack(() => {
      const found = nextTiles.findIndex(tile => tile.id === selectedId)
      const next = found >= 0 ? found : Math.min(index, nextTiles.length - 1)
      if (placedId === nextTiles[next].id && placedStep === nextStep && placedIndex === next) return
      placedStep = nextStep
      void select(next)
    })
  })
  function keydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey) return
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tiles.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    void select(next, true)
  }
  onDestroy(() => { disposed = true; generation++; cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame) })
</script>

<section class="cover-flow" aria-label="Cover Flow" style:top="{top}px" bind:clientWidth={width} bind:clientHeight={height}>
  <!-- The focusable scrolling region owns arrow navigation for its cover buttons. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="flow-scroll" bind:this={scroller} {onscroll} onpointerdown={cancelFocus} onkeydown={keydown} role="region" aria-label="Album covers" tabindex="0">
    <div class="flow-track" style:width="{width + Math.max(0, tiles.length - 1) * step}px" style:--cover="{coverSize}px">
      {#each visible as tile, offset (tile.id)}
        {@const itemIndex = start + offset}
        {@const distance = itemIndex - position}
        {@const turn = Math.max(-1, Math.min(1, distance)) * -SIDE_TURN}
        <button class="flow-cover" class:centered={itemIndex === index} data-collection-id={tile.id}
          style:left="{width / 2 - coverSize / 2 + itemIndex * step}px"
          style:z-index={NEIGHBORS + 1 - Math.round(Math.abs(distance))}
          style:transform="perspective(1000px) rotateY({turn}deg) scale({1 - Math.min(1, Math.abs(distance)) * SIDE_SCALE})"
          tabindex={itemIndex === index ? 0 : -1} aria-current={itemIndex === index ? 'true' : undefined}
          aria-label="{itemIndex === index ? 'Open' : 'Select'} {tile.title} — {tile.sub}"
          onclick={() => itemIndex === index ? onopen(tile) : void select(itemIndex)}>
          {#if tile.cover}<img src={artwork(tile, itemIndex === index)} alt="" draggable="false" />{:else}<span>{tile.title}<small>{tile.sub}</small></span>{/if}
        </button>
      {/each}
    </div>
  </div>
  {#if selected}
    <div class="flow-caption">
      <h2>{selected.title}</h2><p>{selected.sub}</p>
      <div class="flow-actions">
        <button aria-label="Previous album" disabled={index === 0} onclick={() => void select(index - 1)}>←</button>
        <CollectionPlayback collection={selected} onplay={() => onplay(selected)} />
        <button aria-label="Open album details" onclick={() => onopen(selected)}>Details</button>
        <button aria-label="Next album" disabled={index === tiles.length - 1} onclick={() => void select(index + 1)}>→</button>
      </div>
      <label class="flow-position"><span>{index + 1} / {tiles.length}</span><input type="range" aria-label="Browse albums" min="0" max={tiles.length - 1} value={index} oninput={event => void select(Number(event.currentTarget.value))} /></label>
    </div>
  {/if}
</section>

<style>
  .cover-flow { position: absolute; inset-inline: 0; bottom: var(--botbar, 60px); min-height: 0; display: flex; flex-direction: column; color: var(--ui-text); }
  .flow-scroll { flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
  .flow-scroll:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -3px; }
  .flow-track { position: relative; height: 100%; }
  .flow-cover { position: absolute; top: 50%; margin-top: calc(var(--cover) / -2); width: var(--cover); height: var(--cover); padding: 0; border: 0; border-radius: 2px; background: #191919; color: #fafafa; cursor: pointer; scroll-snap-align: center; overflow: hidden; box-shadow: 0 12px 24px #0006; backface-visibility: hidden; }
  .flow-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .flow-cover span { display: block; padding: 24px; font: 600 24px/1.3 var(--ui-font); overflow-wrap: anywhere; }
  .flow-cover small { display: block; font-size: 16px; margin-top: 12px; }
  .flow-cover:focus-visible { outline: 3px solid var(--ui-accent); outline-offset: -3px; }
  .flow-caption { flex: none; text-align: center; padding: 8px 20px 20px; font: 14px/1.4 var(--ui-font); }
  h2 { font-size: 22px; font-weight: 600; line-height: 1.25; margin: 0 auto; max-width: 55ch; text-wrap: balance; }
  p { color: var(--ui-text-muted); margin: 6px 0 12px; }
  .flow-actions { display: flex; gap: 8px; align-items: center; justify-content: center; }
  .flow-actions > button { min-height: 44px; min-width: 44px; padding: 8px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius, 4px); background: var(--ui-surface); color: var(--ui-text); font: inherit; cursor: pointer; }
  .flow-actions > button:disabled { opacity: .35; cursor: default; }
  .flow-actions > button:focus-visible, input:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  .flow-position { display: flex; gap: 12px; align-items: center; max-width: 380px; margin: 12px auto 0; font-size: 12px; color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
  input { min-width: 0; flex: 1; accent-color: var(--ui-accent); min-height: 24px; }
  @media (max-width: 700px) { h2 { font-size: 18px; } .flow-caption { padding: 8px 16px 12px; } }
  @media (prefers-reduced-motion: reduce) { .flow-cover { transform: none !important; box-shadow: none; } }
</style>
