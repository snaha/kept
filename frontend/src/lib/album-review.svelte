<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { FieldReview, ReviewField } from './catalog'
  import { randomId } from './random-id'
  // Where each detail of an album comes from, with a correction, a lock and an undo per field.
  // Desktop only: the album is one of the library's own catalog, named by its anchor.
  let { albumId, title }: { albumId: string; title: string } = $props()

  const LABELS: Record<ReviewField, string> = { title: 'Title', artist: 'Artist', year: 'Year', genre: 'Genre' }
  const FIELDS = Object.keys(LABELS) as ReviewField[]
  const MAX_YEAR = 9999
  const LOAD_ERROR = 'These details could not be loaded.'
  const SAVE_ERROR = 'That could not be saved. Nothing was changed.'
  const REFUSED = {
    'has-dependents': 'A later change builds on this one. Undo that first, in Settings, Activity.',
    'changed-since': 'This was changed again since, so it was left as it is.',
    'nothing-to-undo': 'There is nothing left to undo.',
  } as const
  const empty = (): FieldReview[] => FIELDS.map(field => ({ field, locked: false, undoable: false }))

  let fields = $state<FieldReview[]>(empty())
  // What the user is typing, until it is saved or dropped. A background update never replaces it.
  let drafts = $state<Partial<Record<ReviewField, string>>>({})
  let note = $state(''), failed = $state(false), busy = $state<ReviewField | undefined>()
  // Every load takes a turn, and only the latest for the album on screen may change what is shown.
  let turn = 0

  async function load() {
    const bridge = window.musicCatalog, mine = ++turn, asked = albumId
    if (!bridge) return
    try {
      const review = await bridge.albumReview({ albumId: asked })
      if (mine !== turn || asked !== albumId) return
      fields = FIELDS.map(field => review.fields.find(item => item.field === field) ?? { field, locked: false, undoable: false })
      if (failed && note === LOAD_ERROR) { note = ''; failed = false }
    } catch { if (mine === turn && !note) { note = LOAD_ERROR; failed = true } }
  }
  $effect(() => {
    albumId
    untrack(() => { fields = empty(); drafts = {}; note = ''; failed = false; busy = undefined; void load() })
    // A scan, a repair or an undo elsewhere: the rows are replaced in place.
    return window.musicCatalog?.onChange(() => void load())
  })

  const shownValue = (item: FieldReview) => drafts[item.field] ?? (item.value === undefined ? '' : String(item.value))
  const origin = (item: FieldReview) => item.origin === 'user' ? 'Set by you' : item.origin === 'route' ? `Changed by Kept${item.by ? ` (${item.by})` : ''}` : item.origin === 'tags' ? 'From the file tags' : 'Not set'
  function say(text: string, error = false) { note = text; failed = error }
  // A refusal the user can act on, as opposed to a failure.
  class Refused extends Error {}
  // One change at a time. The controls stay enabled and in place while it is saved, so focus never falls out of them.
  async function act(field: ReviewField, change: (bridge: NonNullable<Window['musicCatalog']>) => Promise<string>) {
    const bridge = window.musicCatalog
    if (!bridge || busy) return
    busy = field
    try { say(await change(bridge)) } catch (error) { say(error instanceof Refused ? error.message : SAVE_ERROR, true) }
    busy = undefined
    await load()
  }
  function save(item: FieldReview) {
    const draft = drafts[item.field]
    if (draft === undefined) return
    const text = draft.trim(), year = Number(text)
    const value = item.field === 'year' ? year : text
    if (!text || String(item.value ?? '') === text) { delete drafts[item.field]; return }
    if (item.field === 'year' && !(Number.isInteger(year) && year >= 1 && year <= MAX_YEAR)) { say('A year is a number, such as 1971.', true); return }
    void act(item.field, async bridge => {
      // The correction names its own change, so sending it again after a lost reply saves nothing twice.
      const request = { albumId, field: item.field, value, changeId: `change:${randomId()}` }
      const result = await bridge.setField(request).catch(() => bridge.setField(request))
      if (!result.applied) throw new Error(result.reason)
      // Shown at once. The library confirms it with the next load.
      item.value = value; item.origin = 'user'; item.by = undefined; item.undoable = true
      delete drafts[item.field]
      return `${LABELS[item.field]} saved. Undo brings back what was there.`
    })
  }
  function toggleLock(item: FieldReview) {
    if (busy) return
    const locked = !item.locked
    item.locked = locked
    void act(item.field, async bridge => {
      const result = await bridge.lockField({ albumId, field: item.field, locked, changeId: `change:${randomId()}` })
      if (!result.applied) { item.locked = !locked; throw new Error(result.reason) }
      return locked ? `Kept will not change the ${item.field} of this album.` : `Kept may change the ${item.field} of this album again.`
    })
  }
  async function undo(item: FieldReview, button: HTMLButtonElement) {
    await act(item.field, async bridge => {
      const result = await bridge.undoField({ albumId, field: item.field })
      if (result.status === 'blocked') throw new Refused(REFUSED[result.reason])
      delete drafts[item.field]
      return `The earlier ${item.field} is back.`
    })
    // With nothing left to undo the button is disabled: focus moves to the value it belongs to.
    await tick()
    if (button.disabled && (document.activeElement === button || document.activeElement === document.body)) document.getElementById(`review-${item.field}`)?.focus({ preventScroll: true })
  }
  function keys(event: KeyboardEvent, item: FieldReview) {
    if (event.key === 'Enter') { event.preventDefault(); save(item) }
    // Escape drops what was typed. With nothing typed it is left to the album view.
    else if (event.key === 'Escape' && drafts[item.field] !== undefined) { event.preventDefault(); event.stopPropagation(); delete drafts[item.field] }
  }
</script>
<section class="review" aria-label="Details of {title}">
  <h3>Album details</h3>
  {#each fields as item (item.field)}
    <div class="field" data-field={item.field} data-origin={item.origin ?? 'none'}>
      <label for="review-{item.field}">{LABELS[item.field]}</label>
      <span class="origin"><span class="marker" aria-hidden="true"></span>{origin(item)}</span>
      <input id="review-{item.field}" value={shownValue(item)} inputmode={item.field === 'year' ? 'numeric' : undefined} autocomplete="off" spellcheck="false" aria-describedby="review-note"
        oninput={event => { drafts[item.field] = event.currentTarget.value }} onchange={() => save(item)} onkeydown={event => keys(event, item)} />
      <button class="lock" aria-pressed={item.locked} aria-label="{item.locked ? 'Unlock' : 'Lock'} the {item.field}" title={item.locked ? 'Kept will not change this. Press to unlock.' : 'Stop Kept from changing this'}
        onclick={() => toggleLock(item)}>{item.locked ? 'Locked' : 'Lock'}</button>
      <button aria-label="Undo the change to the {item.field}" disabled={!item.undoable} onclick={event => undo(item, event.currentTarget)}>Undo</button>
    </div>
  {/each}
  <p id="review-note" class="note" class:failed role="status">{note}</p>
  <p>A solid dot is yours, a dashed ring is a change Kept made, a plain ring is what the files say. Every change is listed in Settings, Activity.</p>
</section>
<style>
  .review { width: 100%; box-sizing: border-box; border-top: 1px solid var(--play-line); padding: 16px 8px 4px; font: 12px/1.5 var(--ui-font); }
  h3 { font-size: 13px; margin: 0 0 12px; }
  .field { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: 'label origin origin' 'input lock undo'; gap: 4px 8px; align-items: center; margin: 10px 0; }
  label { grid-area: label; font-weight: 600; }
  .origin { grid-area: origin; justify-self: end; display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--play-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .marker { box-sizing: border-box; width: 10px; height: 10px; flex-shrink: 0; border-radius: 50%; border: 1.5px solid var(--play-muted); }
  [data-origin=user] .marker { border-color: var(--play-text); background: var(--play-text); }
  [data-origin=route] .marker { border-style: dashed; }
  [data-origin=none] .marker { border-style: dotted; opacity: .6; }
  input { grid-area: input; font: inherit; padding: 8px; min-width: 0; color: inherit; background: var(--play-surface); border: 1px solid var(--play-line); border-radius: 3px; }
  button { box-sizing: border-box; min-width: 64px; min-height: 34px; padding: 0 10px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--play-line); border-radius: 3px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--play-line); }
  button:disabled { opacity: .4; cursor: default; }
  .lock { grid-area: lock; } .lock[aria-pressed=true] { color: var(--play-accent); background: var(--play-line); }
  p { color: var(--play-muted); margin: 12px 0 0; }
  /* Reserved, so a message never moves the rows. */
  .note { min-height: 3em; margin-top: 4px; } .note.failed { color: var(--play-text); }
  @media (max-width: 700px) { input, button { min-height: 44px; } }
</style>
