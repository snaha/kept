<script lang="ts">
  import { untrack } from 'svelte'
  import Button from './ui/button.svelte'
  import { spotify, spotifyBridge, connectSpotify, cancelSpotifySignIn, disconnectSpotify, refreshSpotifyDevices, chooseSpotifyDevice, searchSpotify } from './spotify.svelte'
  import { play, enqueue } from './player.svelte'

  // Opt-in, playback only. Kept supplies its Spotify client ID when it has one; anyone can use their own app
  // instead (Spotify developer dashboard, PKCE: no secret).
  // Tokens stay in the desktop process. Spotify tracks play on a Spotify device and are never analysed.
  let clientIdOverride = $state<string>(), query = $state('')
  const clientId = $derived(clientIdOverride ?? spotify.clientId)
  $effect(() => { if (spotify.connected) clientIdOverride = undefined })
  // The device list is ready before the picker opens: a native dropdown does not update while it is open.
  $effect(() => { if (spotify.connected) untrack(() => void refreshSpotifyDevices()) })
</script>

{#snippet ownClientId()}
  <label class="field"><span>Spotify client ID</span>
    <input class="text-input" type="text" value={clientId} oninput={event => { clientIdOverride = event.currentTarget.value }} spellcheck="false" autocomplete="off" placeholder="32 characters from your Spotify app" /></label>
  <p class="help">Create an app in the Spotify developer dashboard with the redirect URI http://127.0.0.1:8888/callback, then paste its client ID. Never the client secret.</p>
{/snippet}

{#if spotifyBridge()}
  <section class="spotify" aria-labelledby="spotify-settings-title">
    <h3 id="spotify-settings-title">Spotify (optional)</h3>
    <p class="help">Off until you sign in. Playback happens on your Spotify device and requires Spotify Premium. Kept retains track details in your queue and listening history after sign-out. Spotify tracks never feed Dig, similar albums or the assistant.</p>
    {#if spotify.connected}
      <p role="status">Signed in as {spotify.account}.</p>
      <div class="buttons">
        <label class="field"><span>Play on</span>
          <select class="text-input" value={spotify.deviceId} onchange={event => chooseSpotifyDevice(event.currentTarget.value)} disabled={spotify.busy}>
            <option value="" disabled>{spotify.deviceName || 'Choose a Spotify device'}</option>
            {#each spotify.devices as device (device.id)}<option value={device.id}>{device.name} ({device.type})</option>{/each}
            {#if spotify.deviceId && !spotify.devices.some(device => device.id === spotify.deviceId)}<option value={spotify.deviceId}>{spotify.deviceName}</option>{/if}
          </select></label>
        <Button variant="outline" disabled={spotify.findingDevices} onclick={refreshSpotifyDevices}>{spotify.findingDevices ? 'Finding devices…' : 'Find devices'}</Button>
        <Button variant="outline" disabled={spotify.busy} onclick={disconnectSpotify}>Sign out</Button>
      </div>
      {#if spotify.devicesError}<p class="err" role="alert">{spotify.devicesError}</p>{/if}
      <form class="search" onsubmit={event => { event.preventDefault(); if (query.trim()) void searchSpotify(query) }}>
        <input class="text-input" type="search" aria-label="Search Spotify tracks" placeholder="Search Spotify tracks" bind:value={query} spellcheck="false" autocomplete="off" />
        <Button variant="outline" type="submit" disabled={spotify.busy || !query.trim()}>Search</Button>
      </form>
      {#if !spotify.deviceId}<p class="help">Open Spotify on a device, then choose it above to play. Not listed? Play something in Spotify once, then choose Find devices.</p>{/if}
      <ul class="results">
        {#each spotify.results as track (track.id)}
          <li><span class="t">{track.title}<small>{track.artist}</small></span>
            <Button variant="outline" size="sm" onclick={() => play([track])}>Play</Button>
            <Button variant="outline" size="sm" onclick={() => enqueue([track])}>Queue</Button></li>
        {/each}
      </ul>
    {:else}
      {#if spotify.clientId}
        <p class="help">Sign in with your Spotify account in the browser, then come back here.</p>
      {:else}
        {@render ownClientId()}
      {/if}
      <div class="buttons">
        <Button variant="outline" disabled={spotify.busy || !clientId.trim()} onclick={() => connectSpotify(clientId)}>{spotify.connecting ? 'Waiting for Spotify…' : 'Connect Spotify'}</Button>
        {#if spotify.connecting}<Button variant="outline" onclick={cancelSpotifySignIn}>Cancel</Button>{/if}
      </div>
      {#if spotify.clientId}
        <details>
          <summary>Use your own Spotify app</summary>
          {@render ownClientId()}
        </details>
      {/if}
    {/if}
    {#if spotify.error}<p class="err" role="alert">{spotify.error}</p>{/if}
  </section>
{/if}

<style>
  .spotify { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ui-border); }
  h3 { margin: 4px 0; font-size: 15px; font-weight: 600; }
  .field { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
  .field span { color: var(--ui-text-muted); }
  .text-input { box-sizing: border-box; width: min(360px, 100%); min-height: 40px; padding: 9px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-muted); color: var(--ui-text); font: inherit; caret-color: var(--ui-accent); }
  .text-input::placeholder { color: var(--ui-text-muted); opacity: 1; }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
  .buttons, .search { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-top: 6px; }
  .results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; }
  .results li { display: flex; align-items: center; gap: 8px; min-height: 44px; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { color: var(--ui-text-muted); }
  .help { margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }
  .err { margin: 0; color: #ffb8ad; }
  details { margin-top: 6px; }
  summary { width: fit-content; color: var(--ui-text-muted); cursor: pointer; }
  summary:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 3px; }
</style>
