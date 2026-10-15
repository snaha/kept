import { untrack } from 'svelte';
import { readJsonPreference, writePreference } from './preferences';
import { coverUrl } from './api.svelte';
import { pause, player, remote } from './player.svelte';
import type { ControlState } from './control-host.svelte';
import type { ShareMode } from './sharing.svelte';

// A phone that opened a share link. In Control mode it drives the player of the computer that shared the link over
// the control socket on the page's own host; in Library mode it plays here. Nothing is shared with the computer's
// history: what plays there is its own listening
export const control = $state<{ mode: '' | ShareMode; connected: boolean; host: boolean }>({ mode: '', connected: false, host: false });
const KEY = 'share.phone';
const RETRY_MS = 3000;
type Remembered = { mode: ShareMode; password: string };

export function rememberShare(mode: ShareMode, password: string) {
  writePreference(KEY, JSON.stringify({ mode, password } satisfies Remembered));
  control.mode = mode;
}
export function setShareMode(mode: ShareMode) {
  const saved = readJsonPreference<Remembered | null>(KEY, null);
  if (saved) rememberShare(mode, saved.password);
}

function applyState(state: ControlState | null | undefined) {
  const s = state?.song;
  player.queue = s ? [{ id: s.id, rawId: s.rawId, source: 'local', title: s.title, artist: s.artist, album: s.album, albumId: s.albumId, coverId: s.coverId,
    cover: coverUrl(s.coverId), duration: s.duration, available: true, playbackOrigin: s.origin }] : [];
  player.index = s ? 0 : -1;
  player.playing = !!state?.playing; player.pending = !!state?.pending;
  player.time = state?.time ?? 0; player.duration = state?.duration ?? 0;
  if (state) player.volume = state.volume;
}

export function startControlClient(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (window.desktop) return () => {}; // the app window is the host, never a phone
  const saved = readJsonPreference<Remembered | null>(KEY, null);
  if (saved?.mode) control.mode = saved.mode;
  let ws: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  const send = (command: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command)); };
  const leave = () => {
    clearTimeout(retry); retry = undefined; ws?.close(); ws = undefined;
    control.connected = false; control.host = false;
  };
  const connect = () => {
    const password = readJsonPreference<Remembered | null>(KEY, null)?.password;
    if (!password) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const mine = socket(`${protocol}://${location.host}/control?p=${encodeURIComponent(password)}`); ws = mine;
    mine.onopen = () => { if (ws === mine) control.connected = true; };
    mine.onmessage = event => {
      if (ws !== mine) return;
      let m: { type: string; connected?: boolean; state?: ControlState | null };
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.type === 'host') { control.host = !!m.connected; applyState(m.state); }
      else if (m.type === 'state') applyState(m.state);
    };
    mine.onclose = () => { if (ws !== mine) return; ws = undefined; control.connected = false; control.host = false; retry = setTimeout(connect, RETRY_MS); };
  };
  let active = false;
  const stop = $effect.root(() => {
    $effect(() => {
      if (control.mode !== 'control') return;
      active = true; remote.send = send;
      untrack(() => { void pause(); applyState(null); connect(); }); // whatever played here stops; the computer's state takes the bar over
      return () => { if (!active) return; active = false; delete remote.send; leave(); untrack(() => applyState(null)); };
    });
  });
  return stop;
}
