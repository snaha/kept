<script lang="ts">
  import QRCode from 'qrcode';
  import { onDestroy } from 'svelte'
  import Drawer from './Drawer.svelte';
  import { shareLinks, type ShareMode } from './sharing.svelte';

  let { onclose, from = 'bottom' }: { onclose: () => void; from?: 'bottom' | 'right' } = $props();
  // Control needs the desktop app's player to drive; a plain web deployment only has the library to offer
  const MODES: { mode: ShareMode; label: string; lead: string }[] = [
    { mode: 'control', label: 'Control', lead: 'scan to play music on this computer from a phone' },
    { mode: 'library', label: 'Library', lead: 'scan to play the library on a phone' },
  ];
  let codes = $state<Partial<Record<ShareMode, string>>>({}), error = $state('');
  let localHttp = $state(false)
  let mode = $state<ShareMode>('library');
  const modes = $derived(MODES.filter(option => codes[option.mode]))
  const qr = $derived(codes[mode])
  const current = $derived(MODES.find(option => option.mode === mode)!)
  const controller = new AbortController()
  const QR_WIDTH = 640
  onDestroy(() => controller.abort())
  const encode = (url: string) => QRCode.toDataURL(url, { width: QR_WIDTH, margin: 1, color: { dark: '#eeeeee', light: '#141414' } })
  shareLinks(controller.signal)
    .then(async links => {
      const [library, control] = await Promise.all([encode(links.library), links.control && encode(links.control)])
      if (controller.signal.aborted) return
      const url = new URL(links.library)
      const server = new URL(new URLSearchParams(url.hash.slice(1)).get('s')!)
      localHttp = url.protocol === 'http:' || server.protocol === 'http:'
      codes = { library, control }
      mode = control ? 'control' : 'library'
    })
    .catch((cause: unknown) => {
      if (!controller.signal.aborted) error = cause instanceof Error ? cause.message : 'Sharing failed. Try again.'
    })
  function select(next: ShareMode) { mode = next; requestAnimationFrame(() => document.getElementById(`share-tab-${next}`)?.focus()); }
</script>

<Drawer {from} {onclose}>
  <div class="body" class:right={from === 'right'}>
    {#if qr}
      <img class="qr" src={qr} alt="QR code to {mode === 'control' ? 'control this computer' : 'open this library'}" />
      {#if modes.length > 1}<div class="tabs" role="tablist" tabindex="-1" aria-label="Share mode" onkeydown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        select(event.key === 'Home' ? 'control' : event.key === 'End' ? 'library' : mode === 'control' ? 'library' : 'control');
      }}>
        {#each modes as m (m.mode)}
          <button id="share-tab-{m.mode}" role="tab" aria-selected={mode === m.mode} tabindex={mode === m.mode ? 0 : -1} onclick={() => select(m.mode)}>{m.label}</button>
        {/each}
      </div>{/if}
      <p class="lead">{current.lead}</p>
      <p class="note">the code includes the share account, keep it to people you trust</p>
      {#if localHttp}<p class="note">Use a trusted home network or Tailscale. HTTP is not encrypted on ordinary Wi-Fi.</p>{/if}
    {:else if error}
      <p class="note" role="alert">{error}</p>
    {/if}
  </div>
</Drawer>

<style>
  .body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(16 * var(--s)); padding: calc(24 * var(--s)); }
  /* the app's white on dark: text tone squares on the background's darkest tone, framed like the panels. Phone cameras
     read inverted codes; some older scanner apps don't. The quiet zone is one module instead of the spec's four:
     blurred, shrunk test renders decoded as well as with three */
  .qr { width: min(60vh, 80vw); border-radius: 6px; border: 1px solid #fff2; box-shadow: 0 8px 40px #000; }
  /* right variant: the code fills whatever space is left */
  .body.right { min-height: 0; min-width: 0; }
  .body.right .qr { flex: 1 1 0; min-height: 0; width: auto; max-width: 100%; height: auto; object-fit: contain; }
  .tabs { display: flex; gap: calc(24 * var(--s)); border-bottom: 1px solid #fff2; }
  .tabs button { padding: calc(10 * var(--s)) 0; min-height: 44px; border: 0; background: transparent; color: inherit; opacity: .5; border-bottom: 2px solid transparent; font: inherit; font-size: calc(22 * var(--s)); letter-spacing: .03em; cursor: pointer; }
  .tabs button[aria-selected=true] { opacity: 1; border-bottom-color: currentColor; }
  .tabs button:hover { opacity: .9; }
  .tabs button:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
  .lead { margin: calc(8 * var(--s)) 0 0; font-size: calc(32 * var(--s)); opacity: .9; letter-spacing: .03em; text-align: center; }
  .note { margin: 0; font-size: calc(18 * var(--s)); opacity: .5; text-align: center; max-width: 60ch; }
</style>
