<script lang="ts">
  import { addCollection, pick } from './library.svelte'
  import { similar } from './similar-albums.svelte'
  import Icon from './ui/icon.svelte'
</script>
<section class="similar" aria-label="Albums that sound like this one" aria-busy={similar.status === 'loading'}>
  <h2>Sounds like…</h2>
  <p class="basis">Based on how albums sound, not on folder or genre. Other artists only.</p>
  {#if similar.status === 'loading'}<p class="note" role="status">Listening for similar albums…</p>
  {:else if similar.status === 'listening'}<p class="note" role="status">Kept is still listening to this album.</p>
  {:else if similar.status === 'none'}<p class="note" role="status">No similar albums are available to play right now.</p>
  {:else if similar.status === 'failed'}<p class="note" role="alert">Could not look for similar albums.</p>
  {:else}
    <ul>
      {#each similar.albums as album (album.id)}
        <li>
          {#if album.cover}<img src={album.cover} alt="" loading="lazy" />{:else}<span class="no-cover" aria-hidden="true"></span>{/if}
          <span class="names"><span class="name">{album.title}</span><span class="artist">{album.sub}</span></span>
          <button aria-label="Play {album.title}" title="Play" disabled={!album.available} onclick={() => { void pick(album) }}><Icon name="play" size={16} /></button>
          <button aria-label="Add {album.title} to queue" title="Add to queue" disabled={!album.available} onclick={() => { void addCollection(album) }}><Icon name="plus" size={16} /></button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
<style>
  .similar { margin: 24px 0 0; }
  h2 { margin: 0; font-size: 18px; line-height: 28px; font-weight: 600; }
  .basis, .note { margin: 4px 0 0; color: var(--play-muted); line-height: 1.6; }
  ul { display: flex; flex-direction: column; gap: 4px; margin: 12px 0 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 4px 8px 4px 4px; border-radius: 10px; }
  li:hover { background: var(--play-line); }
  img, .no-cover { width: 44px; height: 44px; flex-shrink: 0; border-radius: 6px; object-fit: cover; background: var(--play-line); }
  .names { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .name, .artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artist { color: var(--play-muted); font-size: 13px; }
  button { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; padding: 0; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: var(--play-line); } button:disabled { opacity: .4; cursor: default; }
  @media (max-width: 640px) { button { width: 44px; height: 44px; } }
</style>
