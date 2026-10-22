import type { ScanStatus } from 'subsonic-api';
import { ok, session } from './api.svelte';
import { appendToSession, enqueue, play, player, beginCollectionOperation, queueSession, type Grid } from './player.svelte';
import { type Collection, type Track } from './music';
import { album, playlist, localTrack, localCatalog } from './local-catalog';
export { album, playlist, localTrack } from './local-catalog';
import { browseCollections } from './browse-source';

export type Tile = Collection;
export const MODES = ['albums', 'playlists'] as const;
export type Mode = (typeof MODES)[number];
class LibraryState {
  mode = $state<Mode>('albums');
  tiles = $state.raw<Tile[]>([]);
  revision = $state(0);
  loading = $state(false);
  error = $state('');
  source = $state<'all' | 'local'>('all');
  scan = $state({ scanning: false, count: 0, checked: false, error: '' });
}
export const library = new LibraryState();
let localTiles: Tile[] = [], req = 0, pickRequest = 0, listing = true;

function publish(preserve: boolean) {
  const next = localTiles;
  if (preserve) {
    const map = new Map(next.map((t) => [t.id, t]));
    const old = new Set(library.tiles.map((t) => t.id));
    library.tiles = [...library.tiles.filter((t) => map.has(t.id)).map((t) => map.get(t.id)!), ...next.filter((t) => !old.has(t.id))];
  } else library.tiles = next;
}

async function allAlbums(type: 'alphabeticalByArtist' | 'newest', mine: number, refresh: boolean) {
  const api = session.api!, out: Tile[] = [];
  for await (const page of localCatalog.albums(api, type)) {
    if (mine !== req || api !== session.api) return;
    out.push(...page);
    if (!refresh) { localTiles = out.slice(); publish(true); }
  }
  if (mine === req && api === session.api) { localTiles = out; publish(true); }
}
export async function setMode(mode: Mode, refresh = false) {
  const api = session.api, mine = ++req;
  library.mode = mode; library.loading = true; library.error = ''; listing = true;
  if (!refresh) { localTiles = []; publish(false); }
  try {
    if (!api) return;
    if (mode === 'albums') await allAlbums('alphabeticalByArtist', mine, refresh);
    else {
      const result = await localCatalog.playlists(api);
      if (mine === req && api === session.api) { localTiles = result; publish(refresh); }
    }
    if (mine === req && api === session.api) library.revision++;
  } catch (error) { if (mine === req) library.error = (error as Error).message; }
  finally { if (mine === req) library.loading = false; }
}

// Navidrome extends the Subsonic scan status with completion and failure details.
type LibraryScanStatus = ScanStatus & { lastScan?: string | Date; error?: string };
export function watchScan() {
  let busy = false, stopped = false, lastApi: typeof session.api = null;
  let previous: { scanning: boolean; count: number; lastScan: string } | undefined;
  let refreshPending = false, lastRefresh = Number.NEGATIVE_INFINITY;
  const timer = setInterval(async () => {
    if (busy) return;
    const api = session.api;
    if (api !== lastApi) {
      lastApi = api; previous = undefined; refreshPending = false; lastRefresh = Number.NEGATIVE_INFINITY;
      library.scan = { scanning: false, count: 0, checked: false, error: '' };
    }
    if (!api) return;
    busy = true;
    try {
      const s: LibraryScanStatus = ok(await api.getScanStatus()).scanStatus;
      if (stopped || api !== session.api) return;
      const next = { scanning: s.scanning, count: s.count ?? 0, lastScan: String(s.lastScan ?? '') };
      library.scan = { scanning: next.scanning, count: next.count, checked: true,
        error: s.error ? `Music indexing failed: ${s.error}` : '' };
      // A small scan can finish before the first poll, or entirely between polls.
      // Refresh the first snapshot and any completed scan, even without seeing it start.
      if (!previous || previous.count !== next.count || previous.lastScan !== next.lastScan || (previous.scanning && !next.scanning)) { refreshPending = true; library.revision++; }
      previous = next;
      const now = performance.now();
      if (listing && !library.loading && (!next.scanning ? refreshPending : now - lastRefresh >= 5000)) {
        refreshPending = false; lastRefresh = now;
        await setMode(library.mode, true);
      }
    } catch (error) {
      if (!stopped && api === session.api) library.scan.error = `Cannot check music indexing: ${(error as Error).message}`;
    }
    finally { busy = false; }
  }, 1000);
  return () => { stopped = true; clearInterval(timer); };
}

const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
export async function songsOf(t: Tile): Promise<Track[]> {
  const tracks: Track[] = [];
  for await (const page of trackPages(t)) tracks.push(...page);
  return tracks;
}
export async function* trackPages(t: Tile): AsyncGenerator<Track[]> {
  if (t.indexing) throw new Error('This album is still being indexed. Its included tracks will appear shortly.');
  if (!t.available) throw new Error('This collection has no playable tracks. Check your music folders in Settings.');
  const api = session.api; if (!api) throw new Error('Your library is not connected.');
  yield* localCatalog.tracks(api, t);
}
export async function pick(t: Tile) {
  const mine = ++pickRequest; player.loadingCollectionId = t.id; player.error = '';
  const selection = ++player.requestRevision, api = session.api;
  const operation = beginCollectionOperation('play', t.id);
  try {
    if (t.kind !== 'artist') {
      let version: number | undefined;
      for await (const tracks of trackPages(t)) {
        if (mine !== pickRequest || api !== session.api) return;
        if (!tracks.length) continue;
        if (version === undefined) {
          if (selection !== player.requestRevision) return;
          version = play(tracks.map(track => ({ ...track, playbackOrigin: t })), 0, operation.id);
          if (version < 0) return;
        }
        else if (!appendToSession(tracks.map(track => ({ ...track, playbackOrigin: t })), version)) return;
      }
      if (version === undefined) throw new Error('This collection contains no music tracks.');
      return;
    }
    if (!api) throw new Error('Your library is not connected.');
    const albums = await localCatalog.artistAlbums(api, t.rawId);
    if (mine !== pickRequest || selection !== player.requestRevision || api !== session.api) return;
    req++; listing = false; library.mode = 'albums'; library.tiles = albums;
  } catch (error) { if (mine === pickRequest && api === session.api) operation.fail(error); }
  finally { operation.finish(); if (mine === pickRequest) player.loadingCollectionId = ''; }
}
let addTail = Promise.resolve();
export function addCollection(t: Tile) {
  const version = queueSession(), api = session.api;
  const operation = beginCollectionOperation('add', t.id);
  addTail = addTail.then(async () => {
    let includedTracks = false;
    try {
      if (version !== queueSession() || api !== session.api) return;
      for await (const tracks of trackPages(t)) {
        if (version !== queueSession() || api !== session.api) return;
        const included = tracks.filter(track => track.available).map(track => ({ ...track, playbackOrigin: t }));
        if (!included.length) continue;
        if (!includedTracks) enqueue(included); else if (!appendToSession(included, version)) return;
        includedTracks = true;
      }
      if (!includedTracks) throw new Error('This collection contains no music tracks.');
    } catch (error) { if (version === queueSession() && api === session.api) operation.fail(error); }
    finally { operation.finish(); }
  });
  return addTail;
}
export function disposeLibrary() { req++; pickRequest++; }

export function grid(): Grid {
  const tiles = browseCollections(library.tiles).filter((t) => t.available), cum = new Float64Array(tiles.length + 1);
  tiles.forEach((t, i) => (cum[i + 1] = cum[i] + Math.max(1, t.count)));
  return {
    count: cum[tiles.length], key: tiles.map((t) => t.id).join(),
    find: (albumId) => { const i = tiles.findIndex((t) => t.kind === 'album' && t.id === albumId); return i < 0 ? -1 : cum[i]; },
    async song(n) {
      let lo = 0, hi = tiles.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m + 1] <= n) lo = m + 1; else hi = m; }
      const t = tiles[lo], songs = t && (await songsOf(t));
      if (!songs?.length) return;
      const track = t.kind === 'artist' ? rnd(songs) : songs[n - cum[lo]] ?? rnd(songs);
      return { ...track, playbackOrigin: t };
    },
  };
}
