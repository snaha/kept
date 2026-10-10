<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './ui/button.svelte';
  import LibrarySelect from './ui/library-select.svelte';
  import { desktop } from './desktop.svelte';
  import { session } from './api.svelte';
  import { library, requestScan } from './library.svelte';
  let { portalTarget }: { portalTarget?: Element } = $props();
  let profiles = $state<ProfileEntry[]>([]), name = $state(''), busy = $state(''), error = $state('');
  const status = $derived(desktop.status);
  onMount(() => {
    window.desktop?.profiles().then(items => { profiles = items.filter(profile => profile.name !== status?.profile.name); name = profiles[0]?.name || ''; }).catch(failure => { error = failure.message; });
  });
  async function change(mode: 'fresh' | 'copy' | 'continue' | 'existing') {
    busy = mode; error = '';
    try { await window.desktop!.switchProfile(mode, name); if (mode === 'existing') busy = ''; }
    catch (failure) { error = (failure as Error).message; busy = ''; }
  }
  async function folder(mode: 'add' | 'replace' | 'remove', path?: string) {
    busy = 'folder'; error = '';
    try { await window.desktop!.changeFolder(mode, path); }
    catch (failure) { error = (failure as Error).message; }
    finally { busy = ''; }
  }
  // the library owns the scan request and its polling; the buttons stay in place and keep focus while they wait
  const scanBlocked = $derived(!session.api || library.scan.pending || library.scan.scanning);
  async function scan(full: boolean) { if (scanBlocked) return; error = ''; const problem = await requestScan(full); if (problem) error = problem; }
</script>

{#if status}
  <section class="profile-settings" aria-labelledby="profile-title">
    <h2 id="profile-title">Library &amp; profile</h2>
    <dl>
      <div><dt>Profile</dt><dd>{status.profile.label}{status.profile.existing ? ' · Existing Music data' : ' · Isolated data'}</dd></div>
      <div><dt>Music folders</dt><dd>{#each status.musicFolders as path (path)}<div class="folder-row"><span>{path}</span><Button variant="ghost" size="sm" disabled={!!busy} aria-label="Remove {path}" onclick={() => folder('remove', path)}>Remove</Button></div>{:else}No folders selected{/each}</dd></div>
      <div><dt>Build</dt><dd>{status.build.version}{#if status.build.commit} · {status.build.commit.slice(0, 7)}{/if}{#if status.build.branch} · {status.build.branch}{/if}{#if status.build.dirty} · local changes{/if}</dd></div>
      <div><dt>Data folder</dt><dd>{status.profile.directory}</dd></div>
    </dl>
    <div class="actions">
      <Button variant="outline" disabled={!!busy} onclick={() => folder('add')}>Add music folder</Button>
      <Button variant="ghost" disabled={!!busy} onclick={() => folder('replace')}>Replace music folders</Button>
      <Button variant="ghost" aria-disabled={scanBlocked} onclick={() => scan(false)}>Scan for changes</Button>
      <Button variant="ghost" aria-disabled={scanBlocked} onclick={() => scan(true)}>Full rescan</Button>
      <Button variant="ghost" onclick={async () => { const problem = await window.desktop!.showData(); if (problem) error = problem; }}>Show data folder</Button>
    </div>
    {#if session.api && (library.scan.pending || library.scan.scanning)}<p role="status">{library.scan.scanning ? 'Indexing…' : 'Starting a scan…'}</p>{/if}
    <details>
      <summary>Preview profiles</summary>
      <p>A fresh profile starts with setup. Copying keeps your normal Music data separate. Switching profiles restarts the app.</p>
      <div class="actions">
        <Button variant="outline" disabled={!!busy} onclick={() => change('fresh')}>New fresh profile</Button>
        {#if status.canCopy}<Button variant="outline" disabled={!!busy} onclick={() => change('copy')}>{busy === 'copy' ? 'Copying profile…' : 'Copy existing profile'}</Button>{/if}
      </div>
      {#if profiles.length}
        <div class="actions">
          <LibrarySelect {portalTarget} label="Preview profile" bind:value={name} options={profiles.map(profile => ({ value: profile.name, label: profile.label === profile.name ? profile.name : `${profile.label} · ${profile.name}` }))} />
          <Button variant="outline" disabled={!!busy || !name} onclick={() => change('continue')}>Switch profile</Button>
        </div>
      {/if}
      {#if !status.profile.existing}
        <details class="advanced-profile">
          <summary>Use normal Music data directly</summary>
          <p>This writes to your normal profile. Quit other versions first. Older builds may not understand data changed by a preview.</p>
          <Button variant="outline" disabled={!!busy} onclick={() => change('existing')}>Use existing profile</Button>
        </details>
      {/if}
      {#if busy && busy !== 'copy' && busy !== 'folder'}<p role="status">Opening profile…</p>{/if}
    </details>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .profile-settings { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
  dl { display: grid; gap: 12px; margin: 0; }
  dl > div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 16px; }
  dt, p { color: var(--ui-text-muted); }
  dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .folder-row { display: flex; align-items: center; gap: 12px; }
  .folder-row > span { flex: 1; min-width: 0; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .actions :global([aria-disabled="true"]) { opacity: .5; cursor: default; }
  details { border-top: 1px solid var(--ui-border); }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; font-weight: 550; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: ""; width: 7px; height: 7px; flex-shrink: 0; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform 180ms ease-out; margin-right: 4px; }
  details[open] > summary::after { transform: rotate(225deg); }
  summary:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
  p { margin: 0 0 12px; max-width: 72ch; line-height: 1.6; font-size: 13px; }
  details .actions { margin-bottom: 12px; }
  .advanced-profile { margin-top: 20px; }
  .error { color: #ffb8ad; }
  @media (max-width: 600px) { dl > div { grid-template-columns: 1fr; gap: 4px; } }
  @media (prefers-reduced-motion: reduce) { summary::after { transition: none; } }
</style>
