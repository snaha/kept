import { session } from './api.svelte';
import { library } from './library.svelte';
import { metadata } from './discovery.svelte';
import { localCatalog } from './local-catalog';
import { player } from './player.svelte';
import { type Collection, type Track, type Source } from './music';

export const normalizeSearch = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
export const searchWords = (query: string) => normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
export function collectionMatches(tile: Collection, words: string[]) {
  const info = metadata(tile);
  const text = normalizeSearch([tile.title, tile.sub, tile.source, tile.kind, info.year, ...info.genres].join(' '));
  return words.every(word => text.includes(word));
}
const merge = <T extends { id: string }>(previous: T[], incoming: T[]) => {
  const next = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) next.set(item.id, item);
  return [...next.values()];
};
class CatalogSearchState {
  query = $state(''); source = $state<Source | 'all'>('all');
  collections = $state.raw<Collection[]>([]); artists = $state.raw<Collection[]>([]); tracks = $state.raw<Track[]>([]);
  loading = $state(false); errors = $state<Record<string, string>>({}); moreLocal = $state(false);
}
export const catalogSearch = new CatalogSearchState();
type Snapshot = { collections: Collection[]; artists: Collection[]; tracks: Track[]; playlists: Collection[] };
let localReady = false, playlistsReady = false;
let incoming: Snapshot = { collections: [], artists: [], tracks: [], playlists: [] };
// Keep surviving rows in place, remove absent rows, append newly discovered ones.
const reconcile = <T extends { id: string }>(previous: T[], next: T[]) => {
  const fresh = new Map(next.map(item => [item.id, item]));
  const retained = previous.filter(item => fresh.has(item.id)).map(item => fresh.get(item.id)!);
  const known = new Set(retained.map(item => item.id));
  return [...retained, ...next.filter(item => !known.has(item.id))];
};
function publish() {
  const collections = localReady ? incoming.collections : catalogSearch.collections.filter(item => item.kind !== 'playlist');
  const playlists = playlistsReady ? incoming.playlists : catalogSearch.collections.filter(item => item.kind === 'playlist');
  catalogSearch.collections = reconcile(catalogSearch.collections, merge(collections, playlists));
  if (localReady) { catalogSearch.artists = reconcile(catalogSearch.artists, incoming.artists); catalogSearch.tracks = reconcile(catalogSearch.tracks, incoming.tracks); }
}
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
let localOffsets = { album: 0, artist: 0, song: 0 }, localMore = { album: true, artist: true, song: true };
let playlistApi: typeof session.api = null, playlistCount = -1, playlistRequest: Promise<Collection[]> | undefined, knownPlaylists: Collection[] = [];
let accountScope = '';
const pageSize = 50;
let refreshTargets = { album: pageSize, artist: pageSize, song: pageSize };
const includes = (source: Source) => catalogSearch.source === 'all' || catalogSearch.source === source;
function localPlaylists() {
  const api = session.api!;
  if (playlistApi !== api || playlistCount !== library.revision) {
    playlistApi = api; playlistCount = library.revision; playlistRequest = undefined; knownPlaylists = [];
  }
  const scanCount = playlistCount;
  if (!playlistRequest) playlistRequest = localCatalog.playlists(api).then(tiles => {
    if (playlistApi === api && playlistCount === scanCount) knownPlaylists = tiles;
    return tiles;
  }).catch(error => { if (playlistApi === api && playlistCount === scanCount) playlistRequest = undefined; throw error; });
  return playlistRequest;
}
function songAlbum(track: Track, collections: Collection[]): Collection | undefined {
  if (!track.albumId || !track.album) return undefined;
  return collections.find(tile => tile.id === track.albumId) ?? library.tiles.find(tile => tile.id === track.albumId) ?? {
    id: track.albumId, rawId: track.albumId.slice('local:album:'.length), source: 'local', kind: 'album', title: track.album,
    sub: track.artist ?? '', cover: track.cover, count: 1, available: true,
  };
}
async function localPage(mine: number, query: string, api: NonNullable<typeof session.api>) {
  const offsets = { ...localOffsets }, more = { ...localMore };
  const result = await localCatalog.search(api, { query, albumCount: more.album ? pageSize : 0, albumOffset: offsets.album,
    artistCount: more.artist ? pageSize : 0, artistOffset: offsets.artist, songCount: more.song ? pageSize : 0, songOffset: offsets.song });
  if (mine !== generation || api !== session.api) return;
  const albums = result.collections, tracks = result.tracks;
  const associated = tracks.map(track => songAlbum(track, albums)).filter((tile): tile is Collection => !!tile);
  incoming.collections = merge(incoming.collections, [...albums, ...associated]);
  incoming.tracks = merge(incoming.tracks, tracks.map(track => ({ ...track, playbackOrigin: songAlbum(track, albums) })));
  incoming.artists = merge(incoming.artists, result.artists);
  for (const key of ['album', 'artist', 'song'] as const) {
    if (more[key]) { const count = (key === 'album' ? result.collections : key === 'artist' ? result.artists : result.tracks).length; localOffsets[key] += count; localMore[key] = count === pageSize; }
  }
  localReady = true;
  catalogSearch.moreLocal = Object.values(localMore).some(Boolean);
}
async function load(mine: number, playlists = false) {
  const api = session.api, query = catalogSearch.query;
  const jobs: [string, Promise<void>][] = [];
  if (includes('local') && api && (playlists || catalogSearch.moreLocal)) jobs.push(['Local music', (async () => {
    const ready = localReady;
    try {
      do {
        await localPage(mine, query, api);
        if (mine !== generation || api !== session.api) return;
      } while (playlists && (['album', 'artist', 'song'] as const).some(key => localMore[key] && localOffsets[key] < refreshTargets[key]));
    } catch (error) { if (mine === generation) localReady = ready; throw error; }
  })()]);
  if (playlists && includes('local') && api) jobs.push(['Local playlists', localPlaylists().then(tiles => {
    if (mine === generation && api === session.api) { incoming.playlists = tiles.filter(tile => collectionMatches(tile, searchWords(query))); playlistsReady = true; }
  })]);
  await Promise.all(jobs.map(async ([name, job]) => {
    try { await job; if (mine === generation) delete catalogSearch.errors[name]; }
    catch (error) { if (mine === generation) catalogSearch.errors[name] = (error as Error).message; }
  }));
  if (mine === generation) { if (localReady || playlistsReady) publish(); catalogSearch.loading = false; }
}
export function startCatalogSearch(query: string, source: Source | 'all') {
  const mine = ++generation;
  clearTimeout(timer);
  const words = searchWords(query);
  const scope = JSON.stringify([session.base, session.username]);
  const accountChanged = scope !== accountScope;
  accountScope = scope;
  const changed = accountChanged || query !== catalogSearch.query || source !== catalogSearch.source;
  const previous = changed && !accountChanged ? catalogSearch.tracks : [];
  if (playlistApi !== session.api) knownPlaylists = [];
  catalogSearch.query = query; catalogSearch.source = source; catalogSearch.errors = {};
  refreshTargets = changed ? { album: pageSize, artist: pageSize, song: pageSize } : { album: Math.max(pageSize, refreshTargets.album, localOffsets.album), artist: Math.max(pageSize, refreshTargets.artist, localOffsets.artist), song: Math.max(pageSize, refreshTargets.song, localOffsets.song) };
  localOffsets = { album: 0, artist: 0, song: 0 }; localMore = { album: true, artist: true, song: true };
  catalogSearch.moreLocal = false;
  if (!words.length) { catalogSearch.collections = []; catalogSearch.artists = []; catalogSearch.tracks = []; catalogSearch.loading = false; return; }
  const allowed = (item: { source: Source }) => source === 'all' || item.source === source;
  const immediate = library.tiles.filter(tile => tile.kind !== 'playlist' && allowed(tile) && collectionMatches(tile, words));
  localReady = false; playlistsReady = false;
  incoming = { collections: immediate, playlists: [], tracks: [], artists: [] };
  if (changed) {
    catalogSearch.collections = immediate; catalogSearch.artists = [];
    catalogSearch.tracks = merge(previous, player.queue).filter(track => allowed(track) && words.every(word => normalizeSearch([track.title, track.artist, track.album, ...(track.origins ?? []).map(origin => origin.title)].join(' ')).includes(word)));
  } // Retain the visible snapshot until this refresh successfully responds.
  catalogSearch.loading = true;
  timer = setTimeout(() => { void load(mine, true); }, 150);
  return () => { if (mine === generation) { generation++; clearTimeout(timer); } };
}
export function moreCatalogSearch() {
  if (catalogSearch.loading) return;
  catalogSearch.loading = true;
  void load(generation);
}

export function disposeCatalogSearch() { generation++; clearTimeout(timer); catalogSearch.loading = false; playlistApi = null; playlistRequest = undefined; }

// A deliberate detour can restore its loaded pages immediately, then refresh in place.
export function captureCatalogSearch() {
  return {
    scope: accountScope, api: session.api, query: catalogSearch.query, source: catalogSearch.source,
    collections: catalogSearch.collections, artists: catalogSearch.artists, tracks: catalogSearch.tracks,
    offsets: { ...localOffsets }, targets: { ...refreshTargets },
  }
}
export function restoreCatalogSearch(saved: ReturnType<typeof captureCatalogSearch>) {
  if (saved.scope !== accountScope || saved.api !== session.api) return
  generation++
  clearTimeout(timer)
  catalogSearch.query = saved.query
  catalogSearch.source = saved.source
  catalogSearch.collections = saved.collections
  catalogSearch.artists = saved.artists
  catalogSearch.tracks = saved.tracks
  localOffsets = { ...saved.offsets }
  refreshTargets = { ...saved.targets }
}
