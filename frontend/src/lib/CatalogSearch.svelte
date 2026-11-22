<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { catalogSearch, startCatalogSearch, moreCatalogSearch, retrySpotifySearch } from './catalog-search.svelte';
  import { player, play, toggle, enqueue } from './player.svelte';
  import type { Collection, Track } from './music';
  import Icon from './ui/icon.svelte';
  let { kind = $bindable('all'), top, cols, gap, card, onartist, onclear }: {
    kind: string; top: number; cols: number; gap: number; card: Snippet<[Collection]>;
    onartist: (artist: Collection) => void; onclear: () => void;
  } = $props();
  const albums = $derived(catalogSearch.collections.filter(tile => tile.kind === 'album'));
  const playlists = $derived(catalogSearch.collections.filter(tile => tile.kind === 'playlist'));
  const tracks = $derived(kind === 'all' ? catalogSearch.tracks.slice(0, 5) : catalogSearch.tracks);
  const spotifyVisible = $derived(catalogSearch.source === 'all' || catalogSearch.source === 'spotify');
  const spotifyTracks = $derived(!spotifyVisible ? [] : kind === 'all' ? catalogSearch.spotifyTracks.slice(0, 5) : catalogSearch.spotifyTracks);
  const spotifyError = $derived(spotifyVisible ? catalogSearch.spotifyError : '');
  const withSpotify = $derived(spotifyVisible && (catalogSearch.spotifyLoading || spotifyTracks.length > 0 || !!spotifyError));
  const artists = $derived(kind === 'all' ? catalogSearch.artists.slice(0, 6) : catalogSearch.artists);
  const groups = $derived([{ type: 'album', label: 'Albums', items: albums }, { type: 'playlist', label: 'Playlists', items: playlists }]);
  let resultsElement: HTMLElement;
  let groupOrder = $state<string[]>([]);
  let layoutKey = '', layoutRevision = 0;
  function changeKind(value: string) { kind = value; resultsElement.closest('.scroll')?.scrollTo({ top: 0 }); }
  $effect.pre(() => {
    const key = JSON.stringify([catalogSearch.query, catalogSearch.source, kind]);
    const available = [
      ...((kind === 'all' || kind === 'song') && tracks.length ? ['song'] : []),
      ...((kind === 'all' || kind === 'album') && albums.length ? ['album'] : []),
      ...((kind === 'all' || kind === 'playlist') && playlists.length ? ['playlist'] : []),
      ...((kind === 'all' || kind === 'artist') && artists.length ? ['artist'] : []),
      ...((kind === 'all' || kind === 'song') && spotifyTracks.length ? ['spotify'] : []),
    ];
    // Keep groups in their first-seen order as provider responses settle.
    const previous = untrack(() => groupOrder), changed = key !== layoutKey;
    groupOrder = changed ? available : [...previous.filter(group => available.includes(group)), ...available.filter(group => !previous.includes(group))];
    layoutKey = key;
    const revision = ++layoutRevision;
    if (changed || !resultsElement) return;
    const scroller = resultsElement.closest<HTMLElement>('.scroll');
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const focused = document.activeElement?.closest<HTMLElement>('.song-row, .tile-wrap, .artist');
    const focusedBox = focused?.getBoundingClientRect();
    const anchor = focused && focusedBox && resultsElement.contains(focused) && focusedBox.bottom > bounds.top + top && focusedBox.top < bounds.bottom ? focused : [...resultsElement.querySelectorAll<HTMLElement>('.song-row, .tile-wrap, .artist')].find(element => {
      const box = element.getBoundingClientRect(); return box.bottom > bounds.top + top && box.top < bounds.bottom;
    });
    if (!anchor) return;
    const before = anchor.getBoundingClientRect().top;
    void tick().then(() => {
      if (revision !== layoutRevision || !anchor.isConnected) return;
      const delta = anchor.getBoundingClientRect().top - before;
      if (Math.abs(delta) > .5) scroller.scrollTop += delta;
    });
  });
  const spotifyCount = $derived(spotifyVisible && (kind === 'all' || kind === 'song') ? catalogSearch.spotifyTracks.length : 0);
  const count = $derived(spotifyCount + (kind === 'song' ? catalogSearch.tracks.length : kind === 'album' ? albums.length : kind === 'playlist' ? playlists.length : kind === 'artist' ? catalogSearch.artists.length : catalogSearch.tracks.length + catalogSearch.collections.length + catalogSearch.artists.length));
  const searching = $derived(catalogSearch.loading || (spotifyVisible && catalogSearch.spotifyLoading));
  const fmt = (duration = 0) => `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
  function listen(track: Track) { if (player.song?.id === track.id) void toggle(); else play([track]); }
  function retry() { startCatalogSearch(catalogSearch.query, catalogSearch.source); }
</script>

<section class="results" bind:this={resultsElement} style:padding-top="{top + 20}px" aria-label="Catalog search results">
  <header><div><h1>Search results</h1><p>{withSpotify ? 'Your music and Spotify' : 'Your music'} · Albums, songs, artists and playlists</p></div><button class="clear" onclick={onclear}>Clear search</button></header>
  <p class="search-status" role="status">{searching ? (withSpotify ? 'Searching your catalog and Spotify…' : 'Searching your catalog…') : `${count} ${count === 1 ? 'result' : 'results'}${catalogSearch.moreLocal ? ' loaded' : ''}`}</p>
  {#each Object.entries(catalogSearch.errors) as [source, message]}
    <p class="notice" role="alert">{source} could not be searched: {message} <button onclick={retry}>Retry search</button></p>
  {/each}
  {#if spotifyError}<p class="notice" role="alert">Spotify could not be searched: {spotifyError} <button onclick={retrySpotifySearch}>Retry search</button></p>{/if}
  {#each groupOrder as group (group)}
    {#if group === 'song'}{@render songResults()}
    {:else if group === 'spotify'}{@render spotifyResults()}
    {:else if group === 'artist'}{@render artistResults()}
    {:else}{@const category = groups.find(item => item.type === group)!}{@render collectionResults(category.type, category.label, category.items)}{/if}
  {/each}
  {#if !count && !searching && !Object.keys(catalogSearch.errors).length && !spotifyError}<p class="notice">No matches for “{catalogSearch.query}”. Try a song, album, artist or playlist name.</p>{/if}
  {#if catalogSearch.moreLocal}<button class="more" onclick={moreCatalogSearch} disabled={catalogSearch.loading}>{catalogSearch.loading ? 'Loading results…' : 'Load more results'}</button>{/if}
</section>

{#snippet songResults()}
  {#if kind === 'all' || kind === 'song'}
    {#if tracks.length}
      <section aria-label="Song results"><h2>Songs <span>{catalogSearch.tracks.length}{catalogSearch.moreLocal ? '+' : ''}</span></h2>
        {#each tracks as track (track.id)}{@render songRow(track, 'Local')}{/each}
        {#if kind === 'all' && catalogSearch.tracks.length > 5}<button class="more" onclick={() => changeKind('song')}>Show all songs</button>{/if}
      </section>
    {/if}
  {/if}
{/snippet}
{#snippet songRow(track: Track, source: string)}
  {@const current = player.song?.id === track.id}
  {@const listening = current && player.playing && !player.pending}
  <div class="song-row" class:current>
    <button class="song" onclick={() => listen(track)} disabled={!track.available} aria-label="{current && (player.playing || player.pending) ? 'Pause' : 'Play'} {track.title}">
      <span class="song-cover">{#if track.cover}<img src={track.cover} alt="" loading="lazy" />{/if}<span class="song-state">{#if current && player.pending}<svg class="pending" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="28 22" /></svg>{:else}{#if listening}<span class="listening"><Icon name="listening" /></span><span class="pause"><Icon name="pause" /></span>{:else}<Icon name="play" />{/if}{/if}</span></span>
      <span class="song-name">{track.title}<small>{track.artist || 'Unknown artist'}{#if track.album} · {track.album}{/if}{#if !track.available} · Unavailable{/if}</small></span>
      <span class="song-source">{source}</span><span class="duration">{fmt(track.duration)}</span>
    </button>
    <button class="add" onclick={() => enqueue([track])} disabled={!track.available} aria-label="Add {track.title} to queue" title="Add to queue"><Icon name="plus" /></button>
  </div>
{/snippet}
{#snippet spotifyResults()}
  <section aria-label="Spotify song results"><h2>On Spotify <span>{catalogSearch.spotifyTracks.length}</span></h2>
    {#each spotifyTracks as track (track.id)}{@render songRow(track, 'Spotify')}{/each}
    {#if kind === 'all' && catalogSearch.spotifyTracks.length > 5}<button class="more" onclick={() => changeKind('song')}>Show all Spotify songs</button>{/if}
  </section>
{/snippet}
{#snippet collectionResults(type: string, label: string, items: Collection[])}
    {#if (kind === 'all' || kind === type) && items.length}
      <section aria-label="{label} results"><h2>{label} <span>{items.length}</span></h2>
        <div class="covers" style:--result-cols={cols} style:gap="{Math.max(12, gap)}px">
          {#each (kind === 'all' ? items.slice(0, 6) : items) as tile (tile.id)}{@render card(tile)}{/each}
        </div>
        {#if kind === 'all' && items.length > 6}<button class="more" onclick={() => changeKind(type)}>Show all {label.toLocaleLowerCase()}</button>{/if}
      </section>
    {/if}
{/snippet}
{#snippet artistResults()}
  {#if (kind === 'all' || kind === 'artist') && artists.length}
    <section aria-label="Artist results"><h2>Artists <span>{catalogSearch.artists.length}</span></h2><div class="artists">
      {#each artists as artist (artist.id)}<button class="artist" onclick={() => onartist(artist)}>{#if artist.cover}<img src={artist.cover} alt="" loading="lazy" />{/if}<span>{artist.title}<small>Local · {artist.count} {artist.count === 1 ? 'album' : 'albums'}</small></span><Icon name="back" /></button>{/each}
    </div>{#if kind === 'all' && catalogSearch.artists.length > 6}<button class="more" onclick={() => changeKind('artist')}>Show all artists</button>{/if}</section>
  {/if}{/snippet}

<style>
  .results { overflow-anchor: none; min-height: 100%; box-sizing: border-box; padding: 20px 24px calc(var(--botbar, 60px) + 32px); color: var(--ui-text); background: var(--ui-surface); font: 14px/1.5 var(--ui-font); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0; } header p { margin: 6px 0 0; color: var(--ui-text-muted); font-size: 12px; }
  h2 { margin: 24px 0 12px; font-size: 16px; } h2 span { color: var(--ui-text-muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
  button { color: inherit; font: inherit; border: 0; background: transparent; cursor: pointer; border-radius: 4px; }
  button:hover { background: var(--ui-muted); } button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; } button:disabled { opacity: .45; cursor: default; }
  .clear, .more, .notice button { min-height: 40px; padding: 8px 12px; border: 1px solid var(--ui-border); white-space: nowrap; }
  .search-status { color: var(--ui-text-muted); font-size: 12px; } .search-status { min-height: 18px; margin: 14px 0 0; }
  .song-row { display: flex; align-items: center; border-bottom: 1px solid var(--ui-border); max-width: 1100px; }
  .song-row.current { background: var(--ui-muted); }
  .song { min-height: 64px; padding: 10px 12px; display: flex; align-items: center; flex: 1; min-width: 0; gap: 12px; text-align: left; }
  .song-cover { position: relative; display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; background: var(--ui-muted); }
  img { display: block; width: 40px; height: 40px; object-fit: cover; } .song-state { position: absolute; inset: 0; display: grid; place-items: center; color: white; background: #0009; opacity: 0; }
  .song:hover .song-state, .song:focus-visible .song-state, .current .song-state { opacity: 1; }
  .pause { display: none; } .song:hover .listening, .song:focus-visible .listening { display: none; } .song:hover .pause, .song:focus-visible .pause { display: flex; }
  .song-name { flex: 1; min-width: 0; overflow-wrap: anywhere; } small { display: block; color: var(--ui-text-muted); font-size: 12px; margin-top: 3px; }
  .song-source, .duration { color: var(--ui-text-muted); font-size: 12px; flex-shrink: 0; } .duration { font-variant-numeric: tabular-nums; }
  .add { display: grid; place-items: center; min-width: 44px; min-height: 44px; padding: 0; flex-shrink: 0; }
  .covers { display: grid; grid-template-columns: repeat(var(--result-cols), minmax(0, 1fr)); }
  .covers :global(.tile-info) { opacity: 1; }
  .artists { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 8px; }
  .artist { display: flex; align-items: center; gap: 12px; padding: 10px; min-height: 60px; text-align: left; } .artist span { flex: 1; min-width: 0; overflow-wrap: anywhere; } .artist :global(svg) { transform: rotate(180deg); }
  .notice { line-height: 1.6; max-width: 72ch; overflow-wrap: anywhere; } .more { margin-top: 20px; }
  @media (max-width: 700px) { .results { padding-inline: 12px; } header { align-items: flex-start; } h1 { font-size: 18px; } .clear, .more, .notice button { min-height: 44px; } .song { padding: 10px 4px; gap: 8px; } .song-source { display: none; } .song-state { opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) { .pending { animation: spin 900ms linear infinite; } }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
