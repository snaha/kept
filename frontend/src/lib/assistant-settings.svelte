<script lang="ts">
  import Button from './ui/button.svelte'
  import { assistant, loadAssistantStatus, saveAssistantSettings, type AssistantProvider } from './assistant.svelte'
  import { onMount } from 'svelte'

  // Opt-in for the optional assistant. The key is sent to the desktop process once, stored there with the system's
  // secure storage, and cleared from this field. The window is only ever told that a key exists.
  let key = $state(''), model = $state(''), baseUrl = $state(''), error = $state(''), saving = $state(false), saved = $state(false)
  const status = $derived(assistant.status)
  onMount(() => { void loadAssistantStatus() })
  // The fields load once per provider; a later update of the stored status never overwrites what is being typed.
  let loadedFor = ''
  $effect(() => {
    if (!status || loadedFor === status.provider) return
    loadedFor = status.provider
    key = ''
    model = status.model
    baseUrl = status.baseUrl
  })

  async function apply(change: Parameters<typeof saveAssistantSettings>[0]) {
    saving = true
    error = ''
    saved = false
    try {
      await saveAssistantSettings(change)
      saved = true
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    } finally {
      saving = false
    }
  }
  function choose(provider: AssistantProvider) {
    key = ''
    return apply({ provider })
  }
  async function save() {
    const provider = status?.provider
    if (!provider || loadedFor !== provider) return
    const typed = key
    await apply({ provider, model, ...(provider === 'local' ? { baseUrl } : {}), ...(typed.trim() ? { apiKey: typed } : {}) })
    if (!error && key === typed) key = ''
  }
</script>

{#if status}
  <section class="assistant" aria-labelledby="assistant-settings-title">
    <h3 id="assistant-settings-title">Assistant (optional)</h3>
    <label class="row"><input type="checkbox" checked={status.enabled} disabled={saving} onchange={event => apply({ enabled: event.currentTarget.checked })} /> Ask for music in words</label>
    <p class="help">Off by default. Open it with the button next to Settings or {navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'} J. It chooses between the library's own tools; it does not play anything itself.</p>
    {#if status.enabled}
      <div class="radios" role="radiogroup" aria-label="Where the model runs">
        <label><input type="radio" name="assistant-provider" checked={status.provider === 'anthropic'} disabled={saving} onchange={() => choose('anthropic')} /> Anthropic, with your own key</label>
        <label><input type="radio" name="assistant-provider" checked={status.provider === 'local'} disabled={saving} onchange={() => choose('local')} /> Model server (OpenAI-compatible, such as Ollama)</label>
      </div>
      <label class="field"><span>Model</span><input class="text-input" type="text" bind:value={model} spellcheck="false" autocomplete="off" placeholder={status.provider === 'local' ? 'for example llama3.1' : 'claude-sonnet-5-5'} /></label>
      {#if status.provider === 'local'}
        <label class="field"><span>Model server address</span><input class="text-input" type="url" bind:value={baseUrl} spellcheck="false" autocomplete="off" aria-describedby="model-server-help" /></label>
        <p id="model-server-help" class="help">Requests and any server key go to this address. HTTP sends them unencrypted.</p>
      {/if}
      <label class="field"><span>{status.provider === 'local' ? 'Key (only if the server asks for one)' : 'API key'}</span>
        <input class="text-input" type="password" bind:value={key} autocomplete="off" spellcheck="false" placeholder={status.hasKey ? 'A key is saved. Type to replace it.' : status.provider === 'local' ? '' : 'sk-ant-…'} disabled={saving || !status.canStoreKey} /></label>
      {#if !status.canStoreKey}<p class="err" role="alert">{status.storeKeyReason || 'Secure storage is not available on this computer, so a key cannot be saved.'}</p>{/if}
      <div class="buttons">
        <Button variant="outline" disabled={saving} onclick={save}>Save</Button>
        {#if status.hasKey}<Button variant="outline" disabled={saving} onclick={() => apply({ provider: status.provider, clearKey: true })}>Remove key</Button>{/if}
        <span role="status">{saved && !error ? 'Saved.' : ''}</span>
      </div>
      <p class="help">What leaves your computer: the text you type, the tool names and their results (IDs, scores, titles and artist names). Never audio, lyrics or file paths. Your key is kept encrypted by this app and is never shown again.</p>
    {/if}
    {#if error}<p class="err" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .assistant { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ui-border); }
  h3 { margin: 4px 0; font-size: 15px; font-weight: 600; }
  .row, .radios label { display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
  .radios { display: flex; flex-direction: column; }
  input[type="checkbox"], input[type="radio"] { flex-shrink: 0; width: 18px; height: 18px; margin: 0; accent-color: var(--ui-accent); }
  .field { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-height: 0; cursor: default; }
  .field span { color: var(--ui-text-muted); }
  .text-input { box-sizing: border-box; width: min(360px, 100%); min-height: 40px; padding: 9px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-muted); color: var(--ui-text); font: inherit; caret-color: var(--ui-accent); }
  .text-input::placeholder { color: var(--ui-text-muted); opacity: 1; }
  input:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 6px; }
  .help { margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }
  .err { margin: 0; color: #ffb8ad; }
</style>
