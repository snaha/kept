<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { keyboardScope } from './keyboard';
  import { isElementVisible } from './dom';
  import Button from './ui/button.svelte';
  import ProfileSettings from './ProfileSettings.svelte';
  import { desktop } from './desktop.svelte';
  import { session } from './api.svelte';
  import { downloadPlaybackLog } from './playback-log';
  import { bg, clearBackground, importBackground } from './background.svelte';

  let { coversOnly = $bindable(), motion = $bindable(), initialTab = 'appearance', onclose }: { coversOnly: boolean; motion: boolean; initialTab?: string; onclose: () => void } = $props();
  let dialog = $state<HTMLDialogElement>(null!);
  let content = $state<HTMLDivElement>(null!);
  let activeTab = $state(untrack(() => initialTab));
  let paste = $state(''), bad = $state(false);
  let backgroundFile = $state<HTMLInputElement>(null!);
  const tabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'advanced', label: 'Advanced' }
  ];

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      const target = previous?.isConnected && !previous.closest('[inert]') ? previous : document.querySelector<HTMLElement>('[aria-label="Choose toolbar mode"]');
      target?.focus({ preventScroll: true });
    };
  });

  // a picked file, or SVG / CSS pasted from a generator (fffuel's "copy SVG" or eeencode output)
  async function load(src: File | string) { bad = !(await importBackground(src)); if (!bad) paste = ''; }

  function close() { dialog.close(); }
  function containFocus(event: KeyboardEvent) {
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
      .filter(control => control.tabIndex >= 0 && isElementVisible(control) && !control.closest('[inert]'));
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  }
  function selectTab(id: string) {
    if (activeTab === id) return;
    activeTab = id;
    content.scrollTop = 0;
  }
  function tabKeys(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = tabs.findIndex((tab) => tab.id === activeTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next].id);
    document.getElementById(`settings-tab-${tabs[next].id}`)?.focus();
  }
</script>

<dialog bind:this={dialog} class="settings-dialog" aria-labelledby="settings-title" onkeydown={(event) => {
  if (event.defaultPrevented) return;
  if (event.key === 'Tab') containFocus(event);
  if (event.key === 'Escape' && dialog.querySelector('[role="combobox"][aria-expanded="true"]')) return;
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); close(); }
}} onclick={(event) => { if (event.target === dialog) close(); }} onclose={onclose}>
  <div class="frame">
    <header class="header">
      <h1 id="settings-title">Settings</h1>
      <button class="close" aria-label="Close settings" title="Close settings" onclick={close}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>

    <div class="tabs" role="tablist" aria-label="Settings categories" use:keyboardScope={tabKeys}>
      {#each tabs as tab (tab.id)}
        <button id="settings-tab-{tab.id}" role="tab" aria-selected={activeTab === tab.id} aria-controls="settings-panel" tabindex={activeTab === tab.id ? 0 : -1} onclick={() => selectTab(tab.id)}>{tab.label}</button>
      {/each}
    </div>

    <div bind:this={content} id="settings-panel" class="content" role="tabpanel" aria-labelledby="settings-tab-{activeTab}" tabindex="0">
      <div class="panel-body">
      {#if activeTab === 'appearance'}
        <section aria-labelledby="appearance-title">
          <h2 id="appearance-title">Appearance</h2>
          <label><input type="checkbox" bind:checked={coversOnly} /> Only show albums with cover</label>
          <label><input type="checkbox" bind:checked={motion} /> Motion</label>
          <details>
            <summary>Background customization</summary>
            <div class="detail-body">
              <label><input type="checkbox" bind:checked={bg.scroll} /> Background scrolls with the cards</label>
              <label><input type="checkbox" bind:checked={bg.tile} disabled={bg.material !== 'custom' && bg.material !== 'noise'} /> Tile the image / SVG background</label>
              <div class="import">
                <span class="k">Custom image / SVG background</span>
                <input bind:this={backgroundFile} hidden type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) load(file); event.currentTarget.value = ''; }} />
                <Button variant="outline" size="sm" onclick={() => backgroundFile.click()}>Choose file</Button>
                <input class="text-input" type="text" aria-label="Paste SVG or CSS background" placeholder="Or paste SVG / CSS" bind:value={paste} spellcheck="false" onchange={() => paste.trim() && load(paste)} />
                {#if bg.custom}<Button variant="outline" size="sm" onclick={clearBackground}>Clear</Button>{/if}
                {#if bad}<span class="err" role="alert">Choose an SVG, PNG, JPEG or WebP image.</span>{/if}
              </div>
            </div>
          </details>
        </section>

      {:else}
        <section class="advanced" aria-labelledby="advanced-title">
          <h2 id="advanced-title">Advanced &amp; network</h2>
          {#if window.desktop}
            <ProfileSettings portalTarget={dialog} />
            <label><input type="checkbox" checked={desktop.status?.frame ?? true} onchange={(event) => window.desktop!.setFrame(event.currentTarget.checked)} /> Native window frame</label>
          {/if}
          <div class="server">
            <span class="k">Server</span>
            <span class="v">{session.base}</span>
          </div>
            <details>
              <summary>Playback diagnostics</summary>
              <div class="detail-body">
                <p class="help">The last 100 playback events stay on this device. Includes track IDs and playback state, without credentials or account details.</p>
                <Button variant="outline" onclick={downloadPlaybackLog}>Download playback log</Button>
              </div>
            </details>
        </section>
      {/if}
      </div>
    </div>
  </div>
</dialog>

<style>
  .settings-dialog {
    color: var(--ui-text);
    background: var(--ui-surface);
    border: 0;
    border-radius: calc(var(--ui-radius) + 4px);
    box-shadow: 0 24px 72px #0009;
    box-sizing: border-box;
    width: min(820px, calc(100vw - 32px));
    max-width: none;
    height: min(640px, calc(100dvh - 64px));
    max-height: none;
    padding: 0;
    overflow: visible;
    font: 14px/1.5 var(--ui-font);
  }
  .settings-dialog::backdrop { background: #08080db8; }
  .frame { display: flex; flex-direction: column; height: 100%; overflow: hidden; border-radius: inherit; }
  .header { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 26px 16px; }
  h1 { margin: 0; font-size: 22px; line-height: 1.2; font-weight: 650; letter-spacing: -.025em; }
  h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
  .close { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border: 1px solid transparent; border-radius: var(--ui-radius); background: transparent; color: var(--ui-text-muted); cursor: pointer; }
  .close:hover { background: var(--ui-muted); color: var(--ui-text); }
  .close svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .close:focus-visible, .tabs button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
  .tabs { flex-shrink: 0; display: flex; gap: 6px; padding: 0 26px; border-bottom: 1px solid var(--ui-border); }
  .tabs button { position: relative; min-height: 46px; padding: 0 14px; border: 0; border-radius: var(--ui-radius) var(--ui-radius) 0 0; background: transparent; color: var(--ui-text-muted); font: inherit; cursor: pointer; }
  .tabs button:hover { color: var(--ui-text); background: color-mix(in srgb, var(--ui-muted) 60%, transparent); }
  .tabs button[aria-selected="true"] { color: var(--ui-text); }
  .tabs button[aria-selected="true"]::after { position: absolute; right: 10px; bottom: -1px; left: 10px; height: 2px; background: var(--ui-accent); content: ''; }
  .content { flex: 1; min-height: 0; margin: 6px 6px 8px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable both-edges; scrollbar-width: thin; scrollbar-color: var(--ui-border) var(--ui-surface); scroll-padding-block: 18px; }
  .panel-body { padding: 18px 14px 24px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  label { display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
  input[type="checkbox"] { flex-shrink: 0; margin: 0; width: 18px; height: 18px; accent-color: var(--ui-accent); cursor: pointer; }
  input:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  summary:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; border-radius: var(--ui-radius); }
  details { margin-top: 10px; border-top: 1px solid var(--ui-border); }
  summary { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-weight: 550; cursor: pointer; list-style: none; color: var(--ui-text-muted); }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: ''; width: 7px; height: 7px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform 180ms ease-out; margin-right: 4px; }
  details[open] > summary::after { transform: rotate(225deg); }
  summary:hover, details[open] > summary { color: var(--ui-text); }
  .detail-body { display: flex; flex-direction: column; gap: 10px; padding: 6px 0 12px; }
  .detail-body :global([data-slot="button"]) { align-self: flex-start; }
  .help { margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }
  .import { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 14px 0 0; }
  .import .k { flex-basis: 100%; }
  .text-input { box-sizing: border-box; width: min(260px, 100%); min-width: 0; padding: 9px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-muted); color: var(--ui-text); font: inherit; caret-color: var(--ui-accent); }
  .text-input::placeholder { color: var(--ui-text-muted); opacity: 1; }
  label:has(input:disabled) { color: var(--ui-text-muted); cursor: default; }
  input:disabled { opacity: .5; }
  .err { color: #ffb8ad; }
  .k { color: var(--ui-text-muted); }
  .v { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .server { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  @media (max-width: 600px) {
    .settings-dialog { width: calc(100vw - 20px); height: min(640px, calc(100dvh - 20px)); }
    .header { padding: 16px 18px 12px; }
    .tabs { padding: 0 18px; }
    .tabs button { flex: 1; padding: 0 8px; }
    .panel-body { padding: 14px 6px 20px; }
    .content :global([data-slot="button"]), .text-input { min-height: 44px; }
    .content :global(.library-select-field input), .content :global(.library-select-field button) { min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) { summary::after { transition: none; } }
</style>
