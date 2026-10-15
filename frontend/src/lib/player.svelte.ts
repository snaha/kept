import { randomId } from './random-id';
import { logPlayback } from './playback-log';
import { readPreference, writePreference } from './preferences';
import { session, streamUrl } from './api.svelte';
import { PlaybackController, type PlaybackAdapter } from './playback-controller';
import { shuffle } from './shuffle';
import type { Track, Collection } from './music';
import { recordHistory, saveHistory, historyTrack, type ListeningContext, type HistoryEntry } from './listening-history.svelte';

export type Order = 'normal' | 'shuffle' | 'random';
export type Grid = { count: number; key: string; find(albumId: string): number; song(n: number): Promise<Track | undefined> };
export const player = $state({
  queue: [] as Track[], index: -1, blockedIndex: -1, playing: false, pending: false,
  collectionOperations: [] as { id: string; kind: 'play' | 'add'; collectionId: string }[],
  get requesting() { return this.collectionOperations.length > 0; }, randomRequesting: false, requestRevision: 0, suspended: false, error: '',
  time: 0, duration: 0, order: 'normal' as Order, queueOpen: false, queueTab: 'queue' as 'queue' | 'history', shortcutsOpen: false, topHidden: false, visOpen: false,
  loadingCollectionId: '', volume: 100,
  view: '' as '' | 'share' | 'settings', viewFrom: 'bottom' as 'bottom' | 'right',
  get song() { return this.queue[this.index] as Track | undefined; },
});

// a phone in Control mode drives the player of the computer that shared the link: while `remote.send` is set, the
// entry points below hand their request over instead of playing here, and the computer's state comes back into `player`
export const remote: { send?: (command: object) => void } = {};
let audio: HTMLAudioElement, warmAudio: HTMLAudioElement;
let playbackListeners: AbortController | undefined;
const savedVolume = Number(readPreference('music.volume', '100'));
player.volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(100, savedVolume)) : 100;
export function beginCollectionOperation(kind: 'play' | 'add', collectionId: string) {
  if (kind === 'play') cancelPlayOperations();
  const id = randomId();
  player.collectionOperations.push({ id, kind, collectionId });
  return {
    id,
    fail(error: unknown) { if (player.collectionOperations.some(op => op.id === id)) player.error = error instanceof Error ? error.message : String(error); },
    finish() { player.collectionOperations = player.collectionOperations.filter(op => op.id !== id); },
  };
}
function cancelPlayOperations(except?: string) { player.collectionOperations = player.collectionOperations.filter(op => op.kind !== 'play' || op.id === except); }
const queueEntry = (track: Track): Track => ({ ...track, queueEntryId: randomId() });
let localTrack: Track | undefined, scrobbled = false;
let intent = 0, perm: Uint32Array = new Uint32Array(0), cursor = -1;
let randomGrid: Grid | undefined, randomDraw = 0;
function cancelRandomLookup() { randomDraw++; player.randomRequesting = false; }
let queueVersion = 0;
let historyContext: ListeningContext | undefined;
function freshHistoryContext() { historyContext = undefined; }
function remember(index: number) {
  if (!historyContext) {
    const context = $state<ListeningContext>({ id: randomId(), queue: player.queue.map(t => ({ ...t })), origin: player.queue[index]?.playbackOrigin, order: player.order, permutation: [...perm] });
    historyContext = context;
  }
  recordHistory(historyContext, index, cursor);
}

function clearWarm() { if (!warmAudio) return; warmAudio.removeAttribute('src'); warmAudio.load(); }
const localAdapter: PlaybackAdapter = {
  available(track) { initPlayback(); if (track.source !== 'local') throw new Error('This build plays local music only.'); if (!session.api || !track.available) throw new Error('Local track unavailable. Check your music library.'); },
  async prepare(track) { graph?.ctx.resume(); if (audio.src !== streamUrl(track.rawId)) { audio.src = streamUrl(track.rawId); audio.load(); } },
  async start(track) { localTrack = track; scrobbled = false; audio.currentTime = 0; await audio.play(); session.api?.scrobble({ id: track.rawId, submission: false }).catch(() => {}); },
  async pause() { audio.pause(); },
  async resume() { graph?.ctx.resume(); await audio.play(); },
  async seek(seconds) { audio.currentTime = seconds; },
};
const controller = new PlaybackController({ local: localAdapter });

function playing(value: boolean) {
  player.playing = value;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = value ? 'playing' : 'paused';
}
function fail(error: unknown) { player.error = error instanceof Error ? error.message : String(error); player.pending = false; player.suspended = true; playing(false); }
function metadata(track: Track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album,
    artwork: track.cover ? [{ src: track.cover, sizes: '512x512' }] : [] });
}
export function setVolume(value: number) {
  if (!Number.isFinite(value)) return;
  player.volume = Math.max(0, Math.min(100, Math.round(value)));
  if (remote.send) return remote.send({ type: 'command', name: 'volume', value: player.volume });
  if (audio) audio.volume = player.volume / 100;
  writePreference('music.volume', String(player.volume));
}
export function collectionPlayback(collection: Pick<Collection, 'id'>) {
  const current = (player.song?.playbackOrigin?.id || player.song?.albumId) === collection.id;
  const loading = player.loadingCollectionId === collection.id || (current && player.pending);
  return { current, loading, listening: current && player.playing && !player.suspended && !player.pending };
}
export function collectionTrackIsCurrent(collection: Pick<Collection, 'id'>, tracks: Track[], index: number) {
  const track = tracks[index], current = player.song;
  if (!track || current?.id !== track.id || current.playbackOrigin?.id !== collection.id) return false;
  return current.playbackOriginIndex === undefined ? tracks.filter(song => song.id === track.id).length === 1 : current.playbackOriginIndex === index;
}
function prepareNext() {
  if (!playbackListeners) return;
  const i = player.order === 'shuffle' ? perm[cursor + 1] : player.index + 1;
  const track = player.queue[i];
  if (track?.source === 'local') warmAudio.src = streamUrl(track.rawId);
  else clearWarm();
}
function blocked(track: Track | undefined) {
  if (track && track.source !== 'local') { player.error = 'This build plays local music only.'; return true; }
  if (track && !track.available) { player.error = 'This track is unavailable. Check its music folder or skip it.'; return true; }
  return false;
}
async function start(index: number) {
  const track = player.queue[index]; if (!track) return;
  if (blocked(track)) { player.blockedIndex = index; return; }
  try { localAdapter.available(track); }
  catch (error) { player.error = (error as Error).message; player.view = 'settings'; return; }
  player.blockedIndex = -1;
  const mine = ++intent;
  logPlayback('start-request', { source: track.source, trackId: track.id, queueLength: player.queue.length, index });
  player.index = index; player.pending = true; player.suspended = false; player.error = '';
  player.time = 0; player.duration = track.duration ?? 0; playing(false);
  const startedAt = performance.now();
  try {
    await controller.play(track);
    if (mine !== intent) { logPlayback('start-superseded', { intent: mine }); return; }
    logPlayback('start-confirmed', { source: track.source, trackId: track.id, intent: mine });
    player.pending = false; playing(true); remember(player.index); metadata(track); prepareNext();
    performance.measure('music-playback-handoff', { start: startedAt, end: performance.now(), detail: { source: track.source } });
  } catch (error) { if (mine === intent) { logPlayback('start-failed', { source: track.source, trackId: track.id, message: error instanceof Error ? error.message : String(error) }); fail(error); } }
}

function rebuildShuffle() {
  if (player.order === 'shuffle') { perm = shuffle(player.queue.length, player.index); cursor = 0; }
}
export function play(queue: Track[], index = 0, operationId?: string) {
  if (remote.send) { remote.send({ type: 'command', name: 'tracks', tracks: queue, index }); return queueVersion; }
  if (blocked(queue[Math.max(0, index)])) return -1;
  player.requestRevision++; cancelPlayOperations(operationId);
  if (!operationId) player.loadingCollectionId = '';
  queueVersion++; freshHistoryContext();
  cancelRandomLookup(); randomGrid = undefined;
  player.queue = queue.map(queueEntry); player.index = Math.max(0, index);
  if (player.order === 'random') player.order = 'normal';
  rebuildShuffle();
  if (player.queue.length) void start(player.order === 'shuffle' ? perm[0] : player.index);
  return queueVersion;
}
export function appendToSession(tracks: Track[], version: number) {
  if (version !== queueVersion) return false;
  const offset = player.queue.length;
  const entries = tracks.map(queueEntry);
  player.queue.push(...entries);
  if (historyContext) historyContext.queue.push(...entries.map(t => ({ ...t })));
  if (player.order === 'shuffle') perm = Uint32Array.from([...perm, ...Array.from(shuffle(tracks.length), (i) => i + offset)]);
  if (historyContext) { historyContext.permutation = [...perm]; saveHistory(historyContext); }
  prepareNext(); return true;
}
export const queueSession = () => queueVersion;
export function enqueue(tracks: Track[]) {
  if (remote.send) { remote.send({ type: 'command', name: 'queue', tracks }); return queueVersion; }
  if (player.order === 'random') { randomGrid = undefined; cancelRandomLookup(); player.order = 'normal'; }
  appendToSession(tracks, queueVersion); player.queueOpen = true;
  return queueVersion;
}
function shuffleEntries() {
  return player.order === 'shuffle' ? [...perm].map(index => player.queue[index]?.queueEntryId) : [];
}
function reconcileShuffle(entries: (string | undefined)[], current: Track | undefined) {
  if (player.order !== 'shuffle') return;
  const positions = new Map(player.queue.map((track, index) => [track.queueEntryId, index]));
  perm = Uint32Array.from(entries.flatMap(id => positions.has(id) ? [positions.get(id)!] : []));
  cursor = current ? [...perm].indexOf(player.queue.indexOf(current)) : -1;
}
export function moveQueue(from: number, to: number) {
  if (from < 0 || to < 0 || from >= player.queue.length || to >= player.queue.length || from === to) return;
  const sequence = shuffleEntries();
  const current = player.song;
  freshHistoryContext();
  player.blockedIndex = -1;
  const [entry] = player.queue.splice(from, 1);
  player.queue.splice(to, 0, entry);
  player.index = current ? player.queue.indexOf(current) : -1;
  reconcileShuffle(sequence, current);
  prepareNext();
}
export function removeQueue(index: number) {
  if (index < 0 || index >= player.queue.length) return;
  const sequence = shuffleEntries();
  const current = player.song;
  const removingCurrent = index === player.index;
  const successorId = sequence[cursor + 1] ?? sequence[cursor - 1];
  freshHistoryContext();
  player.queue.splice(index, 1);
  player.blockedIndex = -1;
  const successor = player.order === 'shuffle'
    ? player.queue.find(track => track.queueEntryId === successorId) ?? player.queue[0]
    : player.queue[Math.min(index, player.queue.length - 1)];
  const selected = removingCurrent ? successor : current;
  player.index = selected ? player.queue.indexOf(selected) : -1;
  reconcileShuffle(sequence, selected);
  if (removingCurrent) {
    if (selected) void start(player.index);
    else { queueVersion++; void pause(); }
  }
  prepareNext();
}

export function setOrder(order: Order, source: () => Grid) {
  if (order === player.order) return;
  freshHistoryContext();
  player.order = order; cancelRandomLookup();
  if (order === 'random') {
    randomGrid = source(); // freeze the source selection for this listening session
    perm = shuffle(randomGrid.count); cursor = -1;
    freshHistoryContext();
    const current = player.song;
    player.queue = current ? [current] : []; player.index = current ? 0 : -1;
    if (!current) void nextRandom();
  } else { randomGrid = undefined; rebuildShuffle(); }
}
async function nextRandom() {
  const grid = randomGrid; if (!grid?.count) return;
  if (player.index < player.queue.length - 1) { void start(player.index + 1); return; }
  if (++cursor >= perm.length) { perm = shuffle(grid.count); cursor = 0; }
  const mine = ++randomDraw; player.randomRequesting = true;
  try {
    const track = await grid.song(perm[cursor]);
    if (mine !== randomDraw) return;
    if (!track) throw new Error('This collection has no playable music tracks. Skip to continue.');
    if (blocked(track)) { cursor--; return; }
    freshHistoryContext();
    player.queue.push(queueEntry(track)); void start(player.queue.length - 1);
  } catch (error) { if (mine === randomDraw) fail(error); }
  finally { if (mine === randomDraw) player.randomRequesting = false; }
}
export function jumpRandom(source: () => Grid) {
  const hadSong = !!player.song;
  if (player.order !== 'random') { setOrder('random', source); if (hadSong) void nextRandom(); }
  else void nextRandom();
}
export function replayHistory(entry: HistoryEntry) {
  const context = entry.context;
  logPlayback('history-selected', { entryId: entry.id, contextId: context.id, index: entry.index });
  const queue = context.queue.map(historyTrack);
  if (blocked(queue[entry.index])) return;
  // Start the chosen occurrence, then restore the exact shuffle permutation.
  const previousOrder = player.order;
  player.order = 'normal';
  if (play(queue, entry.index) < 0) { player.order = previousOrder; return; }
  player.order = context.order === 'random' ? 'normal' : context.order;
  if (player.order === 'shuffle') {
    const valid = context.permutation.length === queue.length && new Set(context.permutation).size === queue.length && context.permutation.every(i => Number.isInteger(i) && i >= 0 && i < queue.length);
    perm = valid ? Uint32Array.from(context.permutation) : shuffle(queue.length, entry.index);
    cursor = [...perm].indexOf(entry.index);
  }
  player.queueTab = 'queue';
}
export function jump(index: number) {
  player.requestRevision++; cancelPlayOperations(); player.loadingCollectionId = '';
  cancelRandomLookup();
  if (blocked(player.queue[index])) return;
  if (player.order === 'shuffle') { freshHistoryContext(); player.index = index; rebuildShuffle(); }
  void start(index);
}
export function next() {
  if (remote.send) return remote.send({ type: 'command', name: 'next' });
  player.requestRevision++; cancelPlayOperations(); player.loadingCollectionId = '';
  if (player.order === 'random') return void nextRandom();
  const index = player.order === 'shuffle' ? perm[cursor + 1] : (player.blockedIndex >= 0 ? player.blockedIndex : player.index) + 1;
  if (index < player.queue.length) { if (blocked(player.queue[index])) { player.blockedIndex = index; if (player.order === 'shuffle') cursor++; return; } if (player.order === 'shuffle') cursor++; void start(index); }
  else { void pause(); player.time = player.duration; }
}
export function prev() {
  if (remote.send) return remote.send({ type: 'command', name: 'prev' });
  player.requestRevision++; cancelPlayOperations(); player.loadingCollectionId = '';
  cancelRandomLookup();
  if (player.time > 3) return seek(0);
  if (player.order === 'shuffle') { if (cursor > 0 && !blocked(player.queue[perm[cursor - 1]])) void start(perm[--cursor]); }
  else if (player.index > 0) void start(player.index - 1);
}
export async function pause() {
  player.requestRevision++;
  player.loadingCollectionId = '';

  const mine = ++intent; cancelRandomLookup(); cancelPlayOperations(); player.pending = true;
  try { await controller.pause(); if (mine === intent) { playing(false); player.pending = false; } }
  catch (error) { if (mine === intent) fail(error); }
}
export async function toggle() {
  if (remote.send) return remote.send({ type: 'command', name: 'toggle' });
  if (player.loadingCollectionId && !player.pending && !player.song) { cancelCollectionLoading(); return; }
  if (player.blockedIndex >= 0) return start(player.blockedIndex);
  if (player.playing || player.pending) return pause();
  if (!player.song && player.queue.length) return start(0);
  if (!player.song || blocked(player.song)) return;
  if (player.suspended || controller.current?.id !== player.song.id || player.time >= player.duration - 0.2) return start(player.index);
  const mine = ++intent; player.pending = true;
  try { await controller.resume(); if (mine === intent) { player.pending = false; player.error = ''; playing(true);  } }
  catch (error) { if (mine === intent) fail(error); }
}
export function cancelCollectionLoading() { player.requestRevision++; cancelPlayOperations(); player.loadingCollectionId = ''; }
export async function seek(fraction: number) {
  if (remote.send) return; // ponytail: no seeking from a phone yet
  if (!player.duration || player.pending || !Number.isFinite(fraction)) return;
  const seconds = Math.max(0, Math.min(1, fraction)) * player.duration;
  player.time = seconds;
  const mine = ++intent;

  try { await controller.seek(seconds); } catch (error) { if (mine === intent) fail(error); }
}

export function initPlayback() {
  if (playbackListeners) return;
  audio = new Audio(); warmAudio = new Audio();
  audio.volume = player.volume / 100;
  audio.crossOrigin = warmAudio.crossOrigin = 'anonymous';
  audio.preload = 'auto'; warmAudio.preload = 'metadata';
  playbackListeners = new AbortController();
  const listen = (name: string, listener: EventListener) => audio.addEventListener(name, listener, { signal: playbackListeners!.signal });
listen('timeupdate', () => {
  if (controller.active !== 'local' || player.pending || player.song?.id !== localTrack?.id) return;
  player.time = audio.currentTime; player.duration = audio.duration || localTrack?.duration || 0;
  if (!scrobbled && localTrack && (player.time > player.duration / 2 || player.time > 240)) {
    scrobbled = true; session.api?.scrobble({ id: localTrack.rawId, submission: true }).catch(() => {});
  }
});
listen('ended', () => { if (controller.active === 'local' && !player.pending) { playing(false); next(); } });
listen('error', () => { if (controller.active === 'local') fail(new Error('Local audio could not be loaded. Check the file and retry or skip.')); });
// Native media events can arrive after a newer pause/resume intention.
// Read the element's current state instead of trusting the queued event name.
const syncPlaying = () => { if (controller.active === 'local' && !player.pending) playing(!audio.paused); };
listen('pause', syncPlaying);
listen('play', syncPlaying);

  initMediaSession();
}
export function disposePlayback() {
  intent++; queueVersion++; player.requestRevision++; cancelRandomLookup(); cancelPlayOperations();
  controller.release(); playbackListeners?.abort(); playbackListeners = undefined;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  clearWarm(); localTrack = undefined;
  void graph?.ctx.close().catch(() => {}); graph = null;
  player.pending = false; player.playing = false;
  if ('mediaSession' in navigator) {
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto'] as const) navigator.mediaSession.setActionHandler(action, null);
    navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none';
  }
}

let graph: { ctx: AudioContext; node: GainNode; localAnalysis: GainNode } | null = null;
export function audioGraph() {
  initPlayback();
  if (!graph) {
    const ctx = new AudioContext(), node = ctx.createGain();
    const local = ctx.createMediaElementSource(audio), silent = ctx.createGain(), localAnalysis = ctx.createGain();
    local.connect(ctx.destination); local.connect(localAnalysis); localAnalysis.connect(node);
    silent.gain.value = 0; node.connect(silent); silent.connect(ctx.destination);
    graph = { ctx, node, localAnalysis };
  }
  graph.ctx.resume(); return graph;
}
function initMediaSession() {
 if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => { if (!player.playing) void toggle(); });
  ms.setActionHandler('pause', () => void pause());
  ms.setActionHandler('nexttrack', next); ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) void seek(d.seekTime / player.duration); });
}

}
