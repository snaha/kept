import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { session } from './api.svelte';
import { player, disposePlayback } from './player.svelte';
import { desktop } from './desktop.svelte';
import { startControlHost } from './control-host.svelte';
import type { Track } from './music';

const track: Track = { id: 'local:track:one', rawId: 'one', source: 'local', title: 'Song', cover: '', available: true, duration: 180 };
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0; sent: unknown[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { super(); FakeSocket.all.push(this); }
  open() { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; this.onclose?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const ready = (webPort: number) => ({ phase: 'ready', error: '', onboarding: false, url: '', username: 'admin', password: 'admin-secret', frame: true, build: { version: '0', channel: '', commit: '', branch: '', builtAt: '', runUrl: '' },
  profile: { name: 'default', label: 'Default', directory: '/data', existing: false } as DesktopStatus['profile'], musicFolder: '', musicFolders: [], defaultMusicFolder: '', defaultMusicFolderAvailable: false, source: 'empty', canCopy: false,
  share: { webPort, port: 4533, password: 'share-secret' } } as DesktopStatus);

beforeEach(() => {
  vi.stubGlobal('desktop', { status: vi.fn(async () => ready(4000)), onChange: () => () => {} });
  session.api = {} as never; FakeSocket.all = [];
  player.queue = []; player.index = -1; player.volume = 100;
});
afterEach(() => { disposePlayback(); desktop.status = null; vi.unstubAllGlobals(); });

describe('control host', () => {
  it('connects as host with the admin password while services are ready, publishes state and applies valid commands', async () => {
    const stop = startControlHost(url => new FakeSocket(url) as unknown as WebSocket);
    desktop.status = ready(4000); await tick();
    const socket = FakeSocket.all[0];
    expect(socket.url).toBe('ws://127.0.0.1:4000/control?h=admin-secret');
    socket.open();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'state', state: { playing: false, queueLength: 0, volume: 100 } });
    socket.receive({ type: 'command', name: 'volume', value: 40 });
    expect(player.volume).toBe(40);
    await tick();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'state', state: { volume: 40 } });
    socket.receive({ type: 'command', name: 'queue', tracks: [track] });
    expect(player.queue.map(t => t.id)).toEqual([track.id]);
    socket.receive({ type: 'command', name: 'queue', tracks: [{ id: 'x' }] });
    socket.receive({ type: 'command', name: 'play', collection: { id: 'local:album:a' } });
    socket.receive({ type: 'state', state: { volume: 5 } });
    expect(player.queue.length).toBe(1); expect(player.volume).toBe(40);

    desktop.status = ready(4100); await tick(); // a restart on another port reconnects there
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(FakeSocket.all.at(-1)!.url).toBe('ws://127.0.0.1:4100/control?h=admin-secret');
    desktop.status = { ...ready(4100), phase: 'starting' }; await tick();
    expect(FakeSocket.all.at(-1)!.readyState).toBe(WebSocket.CLOSED);
    expect(FakeSocket.all.length).toBe(2);
    stop();
  });
});
