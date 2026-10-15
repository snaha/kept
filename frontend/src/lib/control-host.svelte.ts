import { desktop } from './desktop.svelte';
import { player, enqueue, next, play, prev, toggle, setVolume } from './player.svelte';
import { pick, addCollection, type Tile } from './library.svelte';
import type { Track } from './music';

// The app window is the host of the control channel: phones send commands, the window applies them to its own
// player and publishes what plays. Nothing here owns playback; it calls the same functions the window's UI calls.
export type ControlState = {
  // the cover goes by id: the host's cover URLs point at its own loopback address, the phone builds its own
  song?: { id: string; rawId: string; title: string; artist?: string; album?: string; albumId?: string; coverId?: string; duration?: number; origin?: Track['playbackOrigin'] };
  playing: boolean; pending: boolean; time: number; duration: number; volume: number; index: number; queueLength: number;
};
export type ControlCommand =
  | { type: 'command'; name: 'toggle' | 'next' | 'prev' }
  | { type: 'command'; name: 'volume'; value: number }
  | { type: 'command'; name: 'play' | 'add'; collection: Tile }
  | { type: 'command'; name: 'queue'; tracks: Track[] }
  | { type: 'command'; name: 'tracks'; tracks: Track[]; index: number };

const RETRY_MS = 3000;
const text = (value: unknown) => typeof value === 'string' && value.length > 0;
const isCollection = (value: unknown): value is Tile => {
  const c = value as Tile;
  return !!c && typeof c === 'object' && text(c.id) && text(c.rawId) && c.source === 'local' && ['album', 'artist', 'playlist'].includes(c.kind) && typeof c.title === 'string';
};
const isTrack = (value: unknown): value is Track => {
  const t = value as Track;
  return !!t && typeof t === 'object' && text(t.id) && text(t.rawId) && t.source === 'local' && typeof t.title === 'string' && typeof t.cover === 'string';
};

export function controlState(): ControlState {
  const s = player.song;
  return {
    song: s ? { id: s.id, rawId: s.rawId, title: s.title, artist: s.artist, album: s.album, albumId: s.albumId, coverId: s.coverId, duration: s.duration, origin: s.playbackOrigin } : undefined,
    playing: player.playing, pending: player.pending, time: Math.floor(player.time), duration: Math.round(player.duration), volume: player.volume,
    index: player.index, queueLength: player.queue.length,
  };
}

export function applyCommand(command: unknown) {
  const c = command as ControlCommand;
  if (!c || typeof c !== 'object' || c.type !== 'command') return;
  switch (c.name) {
    case 'toggle': return void toggle();
    case 'next': return next();
    case 'prev': return prev();
    case 'volume': return Number.isFinite(c.value) ? setVolume(c.value) : undefined;
    case 'play': return isCollection(c.collection) ? void pick(c.collection) : undefined;
    case 'add': return isCollection(c.collection) ? void addCollection(c.collection) : undefined;
    case 'queue': return Array.isArray(c.tracks) && c.tracks.every(isTrack) ? enqueue(c.tracks) : undefined;
    case 'tracks': return Array.isArray(c.tracks) && c.tracks.every(isTrack) && Number.isInteger(c.index) ? void play(c.tracks, c.index) : undefined;
  }
}

// connects while the desktop services are up; reconnects after a drop and follows a restart on new ports
export function startControlHost(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (!window.desktop) return () => {};
  let ws: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, url = '';
  const close = () => { clearTimeout(retry); retry = undefined; ws?.close(); ws = undefined; };
  const publish = () => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', state: controlState() })); };
  const connect = () => {
    if (!url) return;
    const mine = socket(url); ws = mine;
    mine.onopen = () => { if (ws === mine) publish(); };
    mine.onmessage = event => { if (ws !== mine) return; try { applyCommand(JSON.parse(String(event.data))); } catch { /* not ours */ } };
    mine.onclose = () => { if (ws !== mine) return; ws = undefined; retry = setTimeout(connect, RETRY_MS); };
  };
  const stop = $effect.root(() => {
    $effect(() => {
      const status = desktop.status;
      const next = status?.phase === 'ready' && status.share ? `ws://127.0.0.1:${status.share.webPort}/control?h=${encodeURIComponent(status.password)}` : '';
      if (next === url) return;
      url = next; close(); connect();
    });
    $effect(() => { controlState(); publish(); }); // every change of what plays goes out; time is whole seconds, so once a second
  });
  return () => { stop(); url = ''; close(); };
}
