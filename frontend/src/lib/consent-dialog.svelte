<script lang="ts">
  import ConsentChoice from './consent-choice.svelte'
  import { consent, setLookupConsent, type LookupConsent } from './consent.svelte'
  // The consent step at "add library": a nested modal that owns focus while it is open and
  // hands it back to its opener without scrolling. It opens only from ask(), on a user action.
  let { onanswered }: { onanswered: () => void } = $props()
  let dialog = $state<HTMLDialogElement>(null!)
  let open = $state(false), busy = $state(false)
  let opener: HTMLElement | undefined

  /** Asks the question once. Returns false, opening nothing, when it is already answered. */
  export function ask(from: HTMLElement) {
    if (consent.lookup !== undefined) return false
    opener = from
    open = true
    dialog.showModal()
    return true
  }
  // Runs when the dialog closes for any reason. Focus goes back while the opener can still take it.
  function closed() {
    open = false
    busy = false
    consent.error = ''
    opener?.focus({ preventScroll: true })
    opener = undefined
  }
  async function choose(choice: LookupConsent) {
    busy = true
    await setLookupConsent(choice)
    busy = false
    // An answer that could not be stored keeps the question open, with the reason.
    if (consent.error) return
    dialog.close()
    closed()
    onanswered()
  }
  function keys(event: KeyboardEvent) {
    // The dialog underneath must not see these keys: it would close itself or move focus.
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return }
    if (event.key !== 'Tab') return
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); return }
    const active = document.activeElement
    if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus({ preventScroll: true })
    }
  }
</script>
<dialog bind:this={dialog} class="consent-dialog" aria-labelledby="consent-title" onkeydown={keys} onclose={closed}
  onclick={event => { event.stopPropagation(); if (event.target === dialog) dialog.close() }}>
  {#if open}
    <ConsentChoice onchoose={choose} {busy} />
    <p class="error" role="alert">{consent.error}</p>
  {/if}
</dialog>
<style>
  .consent-dialog { box-sizing: border-box; max-width: min(568px, calc(100vw - 32px)); padding: 24px; color: var(--ui-text); background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: calc(var(--ui-radius) + 4px); box-shadow: 0 24px 72px #0009; }
  .consent-dialog::backdrop { background: #08080db8; }
  .error { min-height: 1.5em; margin: 8px 0 0; color: #ffb8ad; font: 13px/1.5 var(--ui-font); }
  @media (max-width: 600px) { .consent-dialog { padding: 16px; } }
</style>
