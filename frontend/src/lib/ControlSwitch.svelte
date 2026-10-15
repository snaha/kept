<script lang="ts">
  import { control, setShareMode } from './control-client.svelte';
  import type { ShareMode } from './sharing.svelte';

  // a phone that opened a share link chooses what it does with the library: Control plays on the computer that shared
  // the link, Library plays here. Search and filters stay as they are across the switch
  const OPTIONS: { mode: ShareMode; label: string }[] = [{ mode: 'control', label: 'Control' }, { mode: 'library', label: 'Library' }];
  const status = $derived(control.mode !== 'control' ? '' : !control.connected ? 'connecting…' : control.host ? '' : 'the computer is not playing');
</script>

{#if control.mode}
  <div class="control-switch" role="radiogroup" aria-label="Where music plays">
    {#each OPTIONS as option (option.mode)}
      <button role="radio" aria-checked={control.mode === option.mode} class:on={control.mode === option.mode} onclick={() => setShareMode(option.mode)}>{option.label}</button>
    {/each}
    {#if status}<span class="status" role="status">{status}</span>{/if}
  </div>
{/if}

<style>
  .control-switch { display: flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
  .control-switch button { min-height: 36px; padding: 6px 12px; border: 0; border-radius: calc(var(--ui-radius) - 2px); background: transparent; color: var(--ui-text-muted); font: inherit; cursor: pointer; }
  .control-switch button.on { background: var(--ui-muted); color: var(--ui-text); }
  .control-switch button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
  .status { padding: 0 8px; color: var(--ui-text-muted); white-space: nowrap; }
</style>
