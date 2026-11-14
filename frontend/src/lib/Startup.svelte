<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './ui/button.svelte';
  import Icon from './ui/icon.svelte';
  import { desktop } from './desktop.svelte';

  let { onretry }: { onretry: () => void } = $props();
  let busy = $state('');
  let error = $state('');
  let profiles = $state<ProfileEntry[]>([]);
  let selectedProfile = $state('');
  let folders = $state<string[]>([]);
  let initialized = false;
  const status = $derived(desktop.status);
  const starting = $derived(status?.phase === 'starting');
  const problem = $derived(error || desktop.error || status?.error || '');

  $effect(() => {
    if (status && !initialized) {
      initialized = true;
      folders = status.musicFolders.length ? [...status.musicFolders] : status.defaultMusicFolderAvailable ? [status.defaultMusicFolder] : [];
    }
  });

  onMount(() => {
    window.desktop?.profiles().then(items => { profiles = items.filter(item => item.setupComplete && item.name !== status?.profile.name); selectedProfile = profiles[0]?.name || ''; }).catch(() => {});
  });
  async function chooseFolder() {
    busy = 'folder'; error = '';
    try {
      const musicFolder = await window.desktop!.chooseFolder();
      if (musicFolder && !folders.includes(musicFolder)) folders = [...folders, musicFolder];
    } catch (failure) { error = (failure as Error).message; }
    finally { busy = ''; }
  }
  async function start(source: 'folder' | 'empty') {
    busy = source; error = '';
    try { desktop.status = await window.desktop!.start({ source, ...(source === 'folder' ? { musicFolders: [...folders] } : {}) }); }
    catch (failure) { error = (failure as Error).message; }
    finally { busy = ''; }
  }
  async function switchProfile(mode: 'copy' | 'continue') {
    busy = mode; error = '';
    try { await window.desktop!.switchProfile(mode, selectedProfile); }
    catch (failure) { error = (failure as Error).message; busy = ''; }
  }
  async function finish() {
    busy = 'finish'; error = '';
    try { desktop.status = await window.desktop!.finishSetup(); }
    catch (failure) { error = (failure as Error).message; }
    finally { busy = ''; }
  }
</script>

<main class="startup" aria-labelledby="startup-title">
  <div class="startup-body">
    <header class="identity">
      <span>{status?.build.channel === 'preview' ? 'Kept Preview' : 'Kept'}</span>
      {#if status?.build.commit}<span class="build">{status.build.commit.slice(0, 7)}</span>{/if}
    </header>
    {#if starting}
      <section class="starting" aria-live="polite" aria-busy="true">
        <svg class="record" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="36"/><circle cx="40" cy="40" r="28"/><circle cx="40" cy="40" r="20"/><circle cx="40" cy="40" r="7"/><path d="M40 4v12M40 64v12"/></svg>
        <h1 id="startup-title">Opening your library…</h1>
        <p>Kept starts here. Your collection will fill in as it’s indexed.</p>
        <Button variant="ghost" onclick={() => window.close()}>Close Kept</Button>
      </section>
    {:else if status?.phase === 'error' && !status.onboarding}
      <h1 id="startup-title">Reconnect your library.</h1>
      <p class="intro">Restart Kept to reopen this profile.</p>
      <div class="finish"><Button onclick={() => window.desktop!.restart()}>Restart Kept</Button></div>
    {:else if status?.phase === 'ready' && status.onboarding}
      <h1 id="startup-title">Open your collection.</h1>
      <p class="intro">Your collection is ready to open.</p>
      <div class="finish"><Button disabled={!!busy} onclick={finish}>Open my library</Button></div>
    {:else if status?.phase === 'ready' && !status.onboarding}
      <h1 id="startup-title">Your library is ready.</h1>
      <p class="intro">{problem ? 'Kept couldn’t open the library view. Try connecting again.' : 'Opening your collection…'}</p>
      {#if problem}<Button onclick={onretry}>Retry opening library</Button>{/if}
    {:else}
      <h1 id="startup-title">Start with your music.</h1>
      <p class="intro">{folders.includes(status?.defaultMusicFolder || '') ? 'Your Music folder is selected. Add another folder, or open your collection.' : 'Choose the folders containing your music, then open your collection.'}</p>
      {#if status && !status.profile.existing}
        <p class="profile-note">{status.profile.portable ? 'This folder has its own library and preferences.' : 'This preview has its own library and preferences.'}</p>
      {/if}
      <section class="sources" aria-labelledby="folders-title">
        <h2 id="folders-title">Music folders</h2>
        <ul class="folders">
          {#each folders as folder (folder)}
            <li class="source">
              <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 9V7a2 2 0 0 1 2-2h8l3 4h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 12h26"/></svg>
              <div><strong>{folder === status?.defaultMusicFolder ? 'Music folder' : folder.split(/[\\/]/).filter(Boolean).at(-1)}</strong><p>{folder}</p></div>
              <Button variant="ghost" disabled={!!busy} aria-label="Remove {folder}" onclick={() => (folders = folders.filter(item => item !== folder))}><Icon name="close" /></Button>
            </li>
          {/each}
        </ul>
        {#if !folders.length}<p class="no-folders">Choose a folder containing your audio files to get started.</p>{/if}
        <Button variant="outline" disabled={!!busy || !status} onclick={chooseFolder}><Icon name="plus" />{busy === 'folder' ? 'Choosing folder…' : 'Add music folder'}</Button>
        <p class="folder-note">Files stay where they are. Kept includes subfolders, too.</p>
      </section>
      <div class="finish"><Button disabled={!!busy || !status || !folders.length} onclick={() => start('folder')}>Open my library</Button><span>Albums appear as your music is indexed.</span></div>
      <footer><Button variant="ghost" disabled={!!busy || !status} onclick={() => start('empty')}>Explore first</Button><span>You can add music folders in Settings.</span></footer>
      {#if status?.canCopy}
        <section class="existing">
          <div><h2>Already using Kept?</h2><p>Quit the other version, then copy its library, history and preferences into this preview.</p></div>
          <Button variant="outline" disabled={!!busy} onclick={() => switchProfile('copy')}>{busy === 'copy' ? 'Copying profile…' : 'Copy existing profile'}</Button>
        </section>
      {/if}
      {#if profiles.length}
        <div class="continue-profile">
          <label for="startup-profile">Previous preview</label>
          <select id="startup-profile" bind:value={selectedProfile} disabled={!!busy}>
            {#each profiles as profile}<option value={profile.name}>{profile.label === profile.name ? profile.name : `${profile.label} · ${profile.name}`}</option>{/each}
          </select>
          <Button variant="outline" disabled={!!busy || !selectedProfile} onclick={() => switchProfile('continue')}>Continue</Button>
        </div>
      {/if}
    {/if}
    {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  </div>
</main>

<style>
  .startup { height: 100dvh; overflow-y: auto; scrollbar-color: var(--ui-border) transparent; scrollbar-width: thin; box-sizing: border-box; display: grid; place-items: safe center; padding: 36px 32px; background: var(--ui-surface); color: var(--ui-text); font: 14px/1.5 var(--ui-font); overflow-wrap: anywhere; }
  .startup-body { width: min(720px, 100%); }
  .identity { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 44px; font-size: 16px; font-weight: 600; }
  .build { color: var(--ui-text-muted); font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
  h1 { margin: 0; font-size: clamp(28px, 4vw, 36px); line-height: 1.15; font-weight: 650; letter-spacing: -.025em; text-wrap: balance; }
  h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.4; font-weight: 600; }
  p { margin: 0; max-width: 65ch; color: var(--ui-text-muted); }
  .intro { margin-top: 12px; font-size: 16px; }
  .profile-note { margin-top: 16px; font-size: 13px; }
  .sources { margin-top: 32px; }
  .folders { margin: 12px 0 16px; padding: 0; list-style: none; border-top: 1px solid var(--ui-border); }
  .source { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--ui-border); }
  .source svg { width: 32px; height: 32px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .source strong { font-weight: 550; }
  .source p { margin-top: 4px; font-size: 13px; }
  .folder-note { margin-top: 12px; font-size: 13px; }
  .no-folders { margin-bottom: 16px; }
  .existing { display: flex; align-items: center; gap: 24px; margin-top: 32px; }
  .existing p { font-size: 13px; }
  .continue-profile { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 24px; }
  .continue-profile label { flex-basis: 100%; color: var(--ui-text-muted); font-size: 13px; }
  select { flex: 1; min-width: 0; padding: 10px 12px; background: var(--ui-muted); color: var(--ui-text); font: inherit; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
  select:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  footer, .finish { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 24px; }
  footer { margin-top: 12px; }
  footer > span, .finish > span { color: var(--ui-text-muted); font-size: 13px; }
  footer :global([data-slot=button]) { margin-left: -14px; }
  .startup :global([data-slot=button]) { min-height: 44px; }
  .error { margin-top: 24px; color: #ffb8ad; }
  .starting { padding: 28px 0 64px; }
  .starting p { margin: 16px 0 24px; }
  .record { width: 64px; height: 64px; margin-bottom: 32px; fill: none; stroke: var(--ui-text-muted); stroke-width: 1.5; animation: turn 4s linear infinite; }
  @keyframes turn { to { transform: rotate(360deg); } }
  @media (max-width: 600px) {
    .startup { padding: 24px 20px; place-items: start center; }
    .identity { margin-bottom: 36px; }
    .source { grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; padding: 20px 0; }
    .source svg { width: 28px; height: 28px; align-self: start; }
    .existing { flex-direction: column; align-items: flex-start; gap: 16px; }
    footer { align-items: flex-start; gap: 4px; }
    footer > span { flex-basis: 100%; }
    .continue-profile select { flex-basis: 100%; width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .record { animation: none; } }
</style>
