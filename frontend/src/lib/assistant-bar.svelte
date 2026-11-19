<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { isElementVisible } from './dom'
  import Button from './ui/button.svelte'
  import { addAssistantQueue, askAssistant, assistant, cancelAssistant, closeAssistant, disposeAssistant, playableAssistantTracks, playAssistantQueue, restoreAssistantFocus } from './assistant.svelte'
  import { player } from './player.svelte'

  // The prompt bar: a modal that owns focus while it is open and hands it back to its opener. It opens only from a
  // button or the shortcut. The model chooses tools; what is shown here is what the tools returned.
  let dialog = $state<HTMLDialogElement>(undefined!)
  let input = $state<HTMLInputElement>(undefined!)
  const ready = $derived(!!assistant.status?.enabled && (assistant.status.provider === 'local' ? !!assistant.status.model?.trim() : assistant.status.hasKey))
  const reason = $derived(!assistant.status ? '' : !assistant.status.enabled ? 'The assistant is off.' : assistant.status.provider === 'local' ? 'The assistant has no model yet.' : 'The assistant has no key yet.')
  const playableCount = $derived(playableAssistantTracks().length)

  $effect(() => {
    if (assistant.open && !dialog.open) {
      dialog.showModal()
      void tick().then(() => {
        if (dialog?.isConnected && dialog.open) (input ?? dialog.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
      })
    }
    if (!assistant.open && dialog.open) dialog.close()
  })
  onDestroy(disposeAssistant)
  function closed() { cancelAssistant(); closeAssistant(); restoreAssistantFocus() }
  function openSettings() { closeAssistant(); player.viewFrom = 'right'; player.view = 'settings' }
  function submit(event: SubmitEvent) { event.preventDefault(); void askAssistant(assistant.request) }
  function contain(event: KeyboardEvent) {
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')].filter(isElementVisible)
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); return }
    const active = document.activeElement
    if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true }) }
  }
  function keys(event: KeyboardEvent) {
    // Nothing under the bar may see these keys: Space would pause the music and arrows would skip it.
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return }
    if (event.key === 'Tab') contain(event)
  }
</script>

<dialog bind:this={dialog} class="assistant-bar" aria-labelledby="assistant-title" onkeydown={keys} onclose={closed}
  onclick={event => { event.stopPropagation(); if (event.target === dialog) dialog.close() }}>
  <header>
    <h1 id="assistant-title">Ask for music</h1>
    <button class="close" aria-label="Close" title="Close" onclick={() => dialog.close()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
  </header>
  {#if assistant.status && !ready}
    <div class="setup">
      <p><strong>{reason}</strong> Turn it on in Settings, under Advanced, and add an Anthropic key or the address of an OpenAI-compatible model server such as Ollama.</p>
      <p class="help">Only your request, the names of the tools, and their results (IDs, scores, titles and artist names) are sent. Never audio, lyrics or file paths.</p>
      <Button variant="outline" onclick={openSettings}>Open Settings</Button>
    </div>
  {:else}
    <form onsubmit={submit}>
      <input bind:this={input} bind:value={assistant.request} type="text" aria-label="What would you like to hear?" placeholder="Something calm I haven't played much" maxlength="500" autocomplete="off" spellcheck="false" />
      {#if assistant.busy}<Button type="button" variant="outline" onclick={cancelAssistant}>Cancel</Button>{:else}<Button type="submit" disabled={!assistant.request.trim()}>Ask</Button>{/if}
    </form>
    <p class="status" role="status">{assistant.busy ? 'Choosing music…' : ''}</p>
    {#if assistant.error}<p class="error" role="alert">{assistant.error}</p>{/if}
    {#if assistant.reply}
      <section aria-label="Answer" class:stale={assistant.busy}>
        {#if assistant.reply.message}<p class="message">{assistant.reply.message}</p>{/if}
        {#if assistant.reply.queue.length}
          <ol class="queue">
            {#each assistant.reply.queue as item (item.occurrenceId)}
              <li><span class="title">{item.title ?? 'Unknown track'}</span><span class="artist">{item.artist ?? ''}</span></li>
            {/each}
          </ol>
          {#if playableCount}
            <div class="actions">
              <Button onclick={() => { if (playAssistantQueue()) dialog.close() }}>Play {playableCount} {playableCount === 1 ? 'track' : 'tracks'}</Button>
              <Button variant="outline" onclick={addAssistantQueue}>Add to queue</Button>
            </div>
            <p class="note" role="status">{assistant.note}</p>
          {:else}
            <p class="help">None of these tracks can be played right now.</p>
          {/if}
        {:else}
          <p class="help">No queue was built.</p>
        {/if}
        {#if assistant.reply.steps.length}
          <details>
            <summary>What was done</summary>
            <ul class="steps">{#each assistant.reply.steps as step, index (index)}<li class:failed={!step.ok}><code>{step.tool}</code> {step.ok ? step.detail : `failed: ${step.detail}`}</li>{/each}</ul>
          </details>
        {/if}
      </section>
    {/if}
  {/if}
</dialog>

<style>
  .assistant-bar { box-sizing: border-box; width: min(640px, calc(100vw - 24px)); max-height: calc(100dvh - 48px); margin: 12vh auto auto; padding: 18px 20px 20px; overflow-y: auto; color: var(--ui-text); background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: calc(var(--ui-radius) + 4px); box-shadow: 0 24px 72px #0009; font: 14px/1.5 var(--ui-font); }
  .assistant-bar::backdrop { background: #08080db8; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
  .close { display: grid; place-items: center; width: 40px; height: 40px; border: 0; border-radius: var(--ui-radius); background: transparent; color: var(--ui-text-muted); cursor: pointer; }
  .close:hover { background: var(--ui-muted); color: var(--ui-text); }
  .close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .close:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
  form { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; box-sizing: border-box; min-height: 44px; padding: 8px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-muted); color: var(--ui-text); font: inherit; caret-color: var(--ui-accent); }
  input::placeholder { color: var(--ui-text-muted); opacity: 1; }
  form :global([data-slot="button"]), .actions :global([data-slot="button"]), .setup :global([data-slot="button"]) { min-height: 44px; }
  .status { min-height: 1.5em; margin: 6px 0 0; color: var(--ui-text-muted); }
  .error { margin: 0 0 8px; color: #ffb8ad; }
  .message { margin: 0 0 10px; }
  .stale { opacity: .6; transition: opacity 120ms; }
  .queue { max-height: min(40dvh, 320px); margin: 0 0 12px; padding: 0; overflow-y: auto; list-style: none; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
  .queue li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 12px; border-bottom: 1px solid var(--ui-border); }
  .queue li:last-child { border-bottom: 0; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artist { flex: 0 1 40%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .note, .help { margin: 8px 0 0; color: var(--ui-text-muted); font-size: 13px; }
  .setup p { margin: 0 0 12px; }
  details { margin-top: 8px; border-top: 1px solid var(--ui-border); }
  summary { min-height: 40px; display: flex; align-items: center; color: var(--ui-text-muted); cursor: pointer; }
  .steps { margin: 0 0 4px; padding-left: 18px; color: var(--ui-text-muted); font-size: 13px; }
  .steps .failed { color: #ffb8ad; }
  @media (max-width: 600px) { .assistant-bar { margin-top: 8px; padding: 14px; } form { flex-wrap: wrap; } form :global([data-slot="button"]) { flex: 1; } }
  @media (prefers-reduced-motion: reduce) { .stale { transition: none; } }
</style>
