<script lang="ts">
  import { control } from './control-client.svelte'
  import { keyboardScope } from './keyboard';
  import { onMount, tick, type Snippet } from 'svelte';
  import ArtworkView from './ArtworkView.svelte';
  import Icon from './ui/icon.svelte';
  import { jump, moveQueue, removeQueue, replayHistory, toggle, player } from './player.svelte';
  import { listeningHistory, loadHistory, clearHistory, historyTrack, searchHistory, retryHistory } from './listening-history.svelte';
  let historyQuery = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let artworkActive = false;
  onMount(() => { artworkActive = true; return () => { artworkActive = false; clearTimeout(searchTimer); }; });
  const recent = $derived(listeningHistory.entries);
  const coverUrl = $derived(player.song?.cover || '');
  let coverImage = $derived({ url: coverUrl, failed: false });
  const playedAt = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let { onclose, palette, options }: { onclose: () => void; palette: string; options: Snippet } = $props();
  let listElement = $state<HTMLDivElement>(), bodyElement = $state<HTMLDivElement>();
  const tabScroll: Partial<Record<'queue' | 'history', number>> = {};
  async function selectTab(tab: 'queue' | 'history') {
    if (tab === player.queueTab) return;
    const menu = openActionId ? document.getElementById(openActionId) : null;
    if (menu) dismissActions(menu, false);
    openActionId = '';
    const mobile = matchMedia('(max-width: 700px)').matches;
    const scroller = mobile ? bodyElement : listElement;
    const previous = scroller?.scrollTop || 0;
    tabScroll[player.queueTab] = previous;
    player.queueTab = tab; await tick(); scroller?.scrollTo({ top: tabScroll[tab] ?? (mobile ? previous : 0) });
  }
  const nativePopovers = typeof HTMLElement.prototype.showPopover === 'function' && typeof HTMLElement.prototype.hidePopover === 'function';
  let openActionId = $state('');
  const actionTrigger = (id: string) => document.querySelector<HTMLElement>(`[data-actions-for="${id}"]`);
  function positionMenu(menu: HTMLElement) {
    const trigger = actionTrigger(menu.id);
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - 168, bounds.right - 160))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - 164, bounds.bottom + 4))}px`;
  }
  function positionActions(event: ToggleEvent) { if (event.newState === 'open') positionMenu(event.currentTarget as HTMLElement); }
  function dismissActions(menu: HTMLElement, restoreFocus = true) {
    if (nativePopovers) menu.hidePopover();
    if (openActionId === menu.id) openActionId = '';
    if (restoreFocus) actionTrigger(menu.id)?.focus({ preventScroll: true });
  }
  async function toggleFallbackActions(id: string) {
    if (nativePopovers) return;
    if (openActionId === id) { openActionId = ''; return; }
    openActionId = id;
    await tick();
    const menu = document.getElementById(id);
    if (!menu || openActionId !== id) return;
    positionMenu(menu);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function closeActions(event: MouseEvent) {
    const menu = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-queue-actions]');
    if (menu) dismissActions(menu);
  }
  function actionKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissActions(event.currentTarget as HTMLElement); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
  function listen(index: number) { if (index === player.index && player.song?.id === player.queue[index]?.id) void toggle(); else jump(index); }
  const fmt = (s = 0) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function close() { onclose(); player.topHidden = true; }
  onMount(() => {
    loadHistory(); historyQuery = listeningHistory.query;
  });
</script>

<svelte:window onclick={event => {
  if (nativePopovers || !openActionId || (event.target instanceof Element && event.target.closest('[data-queue-actions], [data-actions-for]'))) return;
  const menu = document.getElementById(openActionId);
  if (menu) dismissActions(menu, false);
}} />

<ArtworkView id="player-view" className={control.mode === 'control' ? 'now-playing remote-player' : 'now-playing'} {palette} label="Now playing and queue" bind:listElement bind:bodyElement onkeydown={event => {
  if (event.defaultPrevented) return;
  if ((event.target as HTMLElement).closest('.select-song') && !event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const tracks = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.select-song')];
    const index = tracks.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tracks.length - 1 : Math.max(0, Math.min(tracks.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    tracks[next]?.focus(); return;
  }
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  if (player.shortcutsOpen) { player.shortcutsOpen = false; return; }
  const expanded = openActionId ? document.getElementById(openActionId) : null;
  if (expanded) dismissActions(expanded);
  else close();
}}>
  {#snippet header()}
    <button class="detail-icon" onclick={close} aria-label="Close now playing"><Icon name="back" /></button>
    <div class="detail-heading"><h1>{player.song?.album || player.song?.title || 'Your queue'}</h1><p>{player.song?.artist || 'Choose a track to start listening.'}</p></div>
    {@render options()}
  {/snippet}
  {#snippet artwork()}
      {#if player.song}
        {#if coverImage.url && !coverImage.failed}
          {#key coverImage.url}
            <img class="detail-cover" src={coverImage.url} alt="{player.song.album || player.song.title} cover" onerror={event => {
              if (!artworkActive) return;
              if (event.currentTarget.getAttribute('src') === coverImage.url) coverImage = { ...coverImage, failed: true };
            }} />
          {/key}
        {:else}
          <div class="empty-art detail-cover" role="img" aria-label="Artwork unavailable for {player.song.album || player.song.title}"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /></svg></div>
        {/if}
        <div class="detail-art-meta">{#if player.song.playbackOrigin}<p>From {player.song.playbackOrigin.title}</p>{/if}</div>
      {:else}
        <div class="empty-art detail-cover" role="img" aria-label="Choose a track to see its artwork"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /></svg></div>

      {/if}
  {/snippet}
    <div class="list" aria-label={player.queueTab === 'history' ? 'Recently played tracks' : 'Queued tracks'}>
      <div class="list-tabs" role="tablist" tabindex="-1" aria-label="Player views" onkeydown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        void selectTab(event.key === 'Home' ? 'queue' : event.key === 'End' ? 'history' : player.queueTab === 'queue' ? 'history' : 'queue');
        requestAnimationFrame(() => document.getElementById(`player-tab-${player.queueTab}`)?.focus());
      }}>
        <button id="player-tab-queue" role="tab" aria-selected={player.queueTab === 'queue'} aria-controls="player-track-list" tabindex={player.queueTab === 'queue' ? 0 : -1} onclick={() => void selectTab('queue')}>Queue <span>{player.queue.length}</span></button>
        <button id="player-tab-history" role="tab" aria-selected={player.queueTab === 'history'} aria-controls="player-track-list" tabindex={player.queueTab === 'history' ? 0 : -1} onclick={() => void selectTab('history')}>{control.mode === 'control' ? 'Phone history' : 'Recently played'} <span>{listeningHistory.total}</span></button>
      </div>
      <div id="player-track-list" aria-busy={player.queueTab === 'history' && listeningHistory.loading} role="tabpanel" aria-labelledby={`player-tab-${player.queueTab}`}>
      {#if player.queueTab === 'history'}
        <div class="history-heading"><span class="history-loading" role="status">{listeningHistory.loading ? 'Loading…' : ''}</span>{#if recent.length}<button class="clear-history" onclick={clearHistory}>Clear history</button>{/if}</div>
        {#if window.musicHistory}
          <input class="history-search" type="search" aria-label="Search listening history" placeholder="Search songs, artists, albums or playlists" bind:value={historyQuery} oninput={() => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void searchHistory(historyQuery), 180); }} />
        {/if}
        {#if listeningHistory.error}<p role="status" class="empty">{listeningHistory.error} <button class="clear-history" onclick={retryHistory}>Retry</button></p>{/if}
        {#if !recent.length && !listeningHistory.loading}<p class="empty">{historyQuery ? 'No plays match your search.' : 'Songs you play will appear here with the album or playlist they came from.'}</p>{/if}
        {#each recent as entry (entry.id)}
          {@const song = historyTrack(entry.context.queue[entry.index])}
          {@const origin = song.playbackOrigin || entry.context.origin}
          <div class="song">
            <button class="select-song recent-song" onclick={() => replayHistory(entry)} disabled={!song.available} aria-label="Play {song.title} from {origin?.title || song.album || 'your queue'}">
              {#if song.cover}<img class="history-cover" src={song.cover} alt="" loading="lazy" />{:else}<span class="history-cover placeholder" aria-hidden="true"></span>{/if}
              <span class="t">{song.title}<small>{song.artist}</small><small>{origin ? `${origin.kind === 'playlist' ? 'Playlist' : origin.kind === 'album' ? 'Album' : 'Artist'} · ${origin.title}` : song.album || 'Queue'} · {song.source}{song.available ? '' : ' · unavailable'}</small></span>
              <time datetime={new Date(entry.playedAt).toISOString()}>{playedAt(entry.playedAt)}</time>
            </button>
          </div>
        {/each}
        {#if listeningHistory.hasMore}<button class="clear-history" disabled={listeningHistory.loading} onclick={() => void searchHistory(historyQuery, true)}>Load older plays</button>{/if}
      {:else}
      {#if !player.queue.length}<p class="empty">Open an album or playlist and choose Add to queue from its menu.</p>{/if}
      {#each player.queue as song, i (song.queueEntryId)}
        {@const actionId = `queue-actions-${song.queueEntryId}`}
        <div class="song" class:current={i === player.index}>
          <button class="select-song" onclick={() => listen(i)} disabled={!song.available} aria-label="{i === player.index && (player.playing || player.pending) ? 'Pause' : 'Play'} {song.title}" aria-current={i === player.index ? 'true' : undefined}>
            <span class="n">{#if i === player.index && player.pending}<span class="pending" aria-label="Connecting playback"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke-dasharray="24 20" /></svg></span>{:else if i === player.index && player.playing && !player.suspended}<Icon name="listening" />{:else}{i + 1}{/if}</span>
            <span class="t">{song.title}<small>{song.artist} · {song.source}{song.available ? '' : ' · unavailable'}</small></span>
            <span class="d">{fmt(song.duration)}</span>
          </button>
          <button class="track-menu" popovertarget={nativePopovers ? actionId : undefined} data-actions-for={actionId} aria-label="Actions for {song.title}" aria-haspopup="menu" aria-expanded={openActionId === actionId} aria-controls={actionId} onclick={() => void toggleFallbackActions(actionId)}><Icon name="more" /></button>
          <div class="queue-actions" id={actionId} data-queue-actions popover={nativePopovers ? 'auto' : undefined} hidden={!nativePopovers && openActionId !== actionId} role="menu" aria-label="Actions for {song.title}" onbeforetoggle={positionActions} ontoggle={event => {
            if (event.newState === 'open') { openActionId = actionId; event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }
            else if (openActionId === actionId) openActionId = '';
          }} use:keyboardScope={actionKeys}>
            <button role="menuitem" onclick={event => { moveQueue(i, i - 1); closeActions(event); }} disabled={i === 0} aria-label="Move {song.title} up">Move up</button>
            <button role="menuitem" onclick={event => { moveQueue(i, i + 1); closeActions(event); }} disabled={i === player.queue.length - 1} aria-label="Move {song.title} down">Move down</button>
            <button role="menuitem" onclick={event => { closeActions(event); removeQueue(i); void tick().then(() => { const tracks = listElement?.querySelectorAll<HTMLButtonElement>('.select-song:not(:disabled)'); tracks?.[Math.min(i, tracks.length - 1)]?.focus({ preventScroll: true }); }); }} aria-label="Remove {song.title}">Remove</button>
          </div>
        </div>
      {/each}
      {/if}
      </div>
    </div>
</ArtworkView>

<style>
  button { color: inherit; font: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--play-accent); outline-offset: -2px; }
  .detail-art-meta p { margin: 16px 0 0; color: var(--play-muted); font-size: 13px; overflow-wrap: anywhere; }
  .empty-art.detail-cover { background: var(--play-bar); display: grid; place-items: center; }
  .list-tabs { position: sticky; top: 0; z-index: 1; background: var(--play-surface); display: flex; gap: 16px; border-bottom: 1px solid var(--play-line); margin-bottom: 20px; }
  .list-tabs button { display: flex; gap: 8px; align-items: center; padding: 12px 0; min-height: 44px; border: 0; background: transparent; color: var(--play-muted); border-bottom: 2px solid transparent; font-weight: 550; white-space: nowrap; }
  .list-tabs button span { color: var(--play-muted); font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
  .list-tabs button[aria-selected=true] { color: var(--play-text); border-bottom-color: var(--play-accent); }
  .list-tabs button:hover { color: var(--play-text); }
  .song { display: flex; align-items: center; border-bottom: 1px solid var(--play-line); gap: 4px; position: relative; }
  .song.current, .song:hover, .song:focus-within { background: var(--play-line); }
  .select-song { border: 0; background: transparent; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; min-height: 60px; align-items: center; flex: 1; min-width: 0; padding: 10px 12px; text-align: left; }
  .n { color: var(--play-muted); font-size: 12px; font-variant-numeric: tabular-nums; display: grid; place-items: center; }
  .current .n { color: var(--play-accent); }
  .t { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
  .t small { display: block; font-size: 12px; color: var(--play-muted); font-weight: 400; margin-top: 3px; }
  .d { color: var(--play-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .track-menu { display: grid; place-items: center; flex-shrink: 0; width: 40px; min-height: 40px; padding: 0; background: transparent; border: 0; border-radius: 4px; }
  .track-menu:hover { background: var(--play-line); }
  .queue-actions { position: fixed; margin: 0; border: 0; color: var(--play-text); font: inherit; z-index: 9; width: 160px; box-sizing: border-box; background: var(--play-bar); padding: 6px;  box-shadow: 0 8px 24px #0003; border-radius: 4px; }
  .queue-actions button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 10px 12px; min-height: 44px; }
  .queue-actions button:hover, .clear-history:hover { background: var(--play-line); }
  .history-search { width: 100%; box-sizing: border-box; min-height: 40px; margin-bottom: 16px; padding: 8px 0; font: inherit; color: var(--play-text); background: transparent; border: 0; border-bottom: 1px solid var(--play-line); border-radius: 0; }
  .history-search::placeholder { color: var(--play-muted); opacity: 1; }
  .history-loading { color: var(--play-muted); font-size: 12px; }
  .history-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .clear-history { border: 0; background: transparent; color: var(--play-muted); font-size: 12px; min-height: 44px; padding: 8px; border-radius: 4px; }
  .recent-song { grid-template-columns: 44px minmax(0, 1fr) auto; }
  .history-cover { width: 44px; height: 44px; object-fit: contain; border-radius: 2px; }
  .placeholder { background: var(--play-line); }
  time { color: var(--play-muted); font-size: 11px; max-width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
  .pending { display: grid; place-items: center; } .pending svg { animation: spin 900ms linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .pending svg { animation: none; } }
  .empty { color: var(--play-muted); line-height: 1.6; }
  @media (max-width: 700px) {
    .recent-song { grid-template-columns: 36px minmax(0, 1fr); }
    .history-cover { width: 36px; height: 36px; }
    time { grid-column: 2; max-width: none; text-align: left; }
    .select-song { padding: 10px 4px; gap: 8px; }
    .track-menu { width: 44px; min-height: 44px; }
    .history-search { min-height: 44px; }
  }
</style>
