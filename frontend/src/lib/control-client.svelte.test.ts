import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from 'vitest-browser-svelte';
import { session } from './api.svelte';
import { player, disposePlayback, toggle, setVolume, enqueue, remote } from './player.svelte';
import { pick, addCollection, type Tile } from './library.svelte';
import { control, rememberShare, startControlClient } from './control-client.svelte';
import { writePreference } from './preferences';
import ControlSwitch from './ControlSwitch.svelte';
import type { Track } from './music';

const tile: Tile = { id: 'local:album:a', rawId: 'a', source: 'local', kind: 'album', title: 'Album', sub: 'Artist', cover: '', count: 2, available: true };
const track: Track = { id: 'local:track:one', rawId: 'one', source: 'local', title: 'Song', cover: '', available: true, duration: 180 };
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0; sent: { type: string; name: string }[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { super(); FakeSocket.all.push(this); }
  open() { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; this.onclose?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const names = (socket: FakeSocket) => socket.sent.map(m => m.name);

beforeEach(() => {
  vi.stubGlobal('Audio', class extends EventTarget { src = ''; paused = true; volume = 1; async play() {} pause() {} load() {} removeAttribute() {} });
  session.api = { getAlbum: vi.fn(async () => { throw new Error('the phone must not fetch tracks in Control mode'); }) } as never;
  session.base = 'http://10.0.0.2:4533'; session.authQs = 'u=share';
  FakeSocket.all = []; player.queue = []; player.index = -1; player.playing = false; player.volume = 100;
  writePreference('share.phone', null); control.mode = '';
});
afterEach(() => { cleanup(); disposePlayback(); delete remote.send; control.mode = ''; vi.unstubAllGlobals(); });

describe('phone control', () => {
  it('hands playback over to the computer in Control mode and takes it back in Library mode', async () => {
    rememberShare('control', 'share-secret');
    const stop = startControlClient(url => new FakeSocket(url) as unknown as WebSocket);
    render(ControlSwitch); await tick();
    const socket = FakeSocket.all[0];
    expect(socket.url).toBe(`ws://${location.host}/control?p=share-secret`);
    expect(document.body.textContent).toContain('connecting');
    socket.open(); await tick();
    socket.receive({ type: 'host', connected: true, state: { song: { id: 'local:track:far', rawId: 'far', title: 'Far away', coverId: 'c1', albumId: 'local:album:a', duration: 200 }, playing: true, pending: false, time: 42, duration: 200, volume: 70, index: 0, queueLength: 3 } });
    await tick();
    expect(player.song?.title).toBe('Far away'); expect(player.playing).toBe(true); expect(player.time).toBe(42); expect(player.volume).toBe(70);
    expect(player.song?.cover).toContain('http://10.0.0.2:4533/rest/getCoverArt?id=c1');
    expect(document.body.textContent).not.toContain('connecting');

    void pick(tile); void addCollection(tile); enqueue([track]); void toggle(); setVolume(30);
    expect(names(socket)).toEqual(['play', 'add', 'queue', 'toggle', 'volume']);
    expect(player.queue.length).toBe(1); // nothing was queued or fetched here

    socket.receive({ type: 'host', connected: false, state: null }); await tick();
    expect(player.song).toBeUndefined(); expect(player.playing).toBe(false);
    expect(document.body.textContent).toContain('not playing');

    document.querySelector<HTMLButtonElement>('[role=radio][aria-checked=false]')!.click(); await tick();
    expect(control.mode).toBe('library'); expect(socket.readyState).toBe(WebSocket.CLOSED);
    enqueue([track]);
    expect(player.queue.map(t => t.id)).toEqual([track.id]); // plays here again
    expect(names(socket)).toEqual(['play', 'add', 'queue', 'toggle', 'volume']);
    stop();
  });
});
