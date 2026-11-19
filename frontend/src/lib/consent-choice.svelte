<script lang="ts">
  import Button from './ui/button.svelte'
  import { LOOKUP_SENT, type LookupConsent } from './consent.svelte'
  // First-run step at "add library". Nothing is sent until the user picks "online".
  let { onchoose, busy = false }: { onchoose: (choice: LookupConsent) => void; busy?: boolean } = $props()
</script>
<section class="consent" aria-labelledby="consent-title">
  <h2 id="consent-title">Look up album details online?</h2>
  <p>Kept can fill in missing album details, covers and track names from open music databases.</p>
  <dl>
    <dt>What is sent</dt><dd>{LOOKUP_SENT}</dd>
    <dt>What stays here</dt><dd>Your files, your listening history and your tags.</dd>
  </dl>
  <div class="choices">
    <Button disabled={busy} onclick={() => onchoose('online')}>Look up album details online</Button>
    <Button variant="outline" disabled={busy} onclick={() => onchoose('offline')}>Stay offline</Button>
  </div>
  <p class="note">You can change this any time in Settings. Offline works fully; Kept just won't fill in what is missing.</p>
</section>
<style>
  .consent { display: flex; flex-direction: column; gap: 12px; max-width: 520px; color: var(--ui-text); font: 14px/1.5 var(--ui-font); }
  h2 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.025em; line-height: 1.2; }
  p, dl, dd { margin: 0; } p, dd { color: var(--ui-text-muted); }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; padding: 12px 14px; background: var(--ui-muted); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
  dt { font-weight: 600; }
  .choices { display: flex; flex-wrap: wrap; gap: 10px; }
  .note { font-size: 12px; }
  @media (max-width: 600px) { dl { grid-template-columns: 1fr; } .choices { flex-direction: column; } .choices :global([data-slot=button]) { min-height: 44px; width: 100%; } }
</style>
