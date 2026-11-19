<script lang="ts">
  import { LOOKUP_SENT, type LookupConsent } from './consent.svelte'
  let { value, onchange }: { value: LookupConsent | undefined; onchange: (choice: LookupConsent) => void } = $props()
</script>
<div class="lookup">
  <label><input type="checkbox" checked={value === 'online'} onchange={event => onchange(event.currentTarget.checked ? 'online' : 'offline')} /> Look up album details online</label>
  <p class="help">{LOOKUP_SENT} Off by default.</p>
</div>
<style>
  .lookup { display: flex; flex-direction: column; gap: 2px; }
  label { display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
  input { flex-shrink: 0; margin: 0; width: 18px; height: 18px; accent-color: var(--ui-accent); cursor: pointer; }
  input:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  .help { margin: 0; padding-left: 30px; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }
</style>
