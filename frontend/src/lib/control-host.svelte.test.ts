import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { session } from './api.svelte';
import { player, disposePlayback, setOrder } from './player.svelte';
import { desktop } from './desktop.svelte';
import { startControlHost, applyCommand } from './control-host.svelte';
import { gridFor, library } from './library.svelte'
import type { Track } from './music';

const track: Track = { id: 'local:track:one', rawId: 'one', source: 'local', title: 'Song', cover: '', available: true, duration: 180 };
const HOST_LIBRARY = 'http://library.example.invalid'
const ORIGIN_COVER = 'https://phone.example.invalid/rest/getCoverArt?id=crater-cover&u=phone-fixture'
const EXTERNAL_COVER = 'https://artwork.example.invalid/cover'
const OVER_LIMIT_COUNT = 10001
const LARGE_QUEUE_COUNT = 256
const LARGE_TITLE_LENGTH = 24 * 1024
const RELAY_LIMIT_BYTES = 16 * 1024 * 1024
const WIRE_PART_LIMIT_BYTES = 256 * 1024
const HOST_PORT = 4000
const album = {
  id: 'local:album:chalk-crater', rawId: 'chalk-crater', source: 'local', kind: 'album',
  title: 'Chalk Crater', sub: '', count: 1, available: true, cover: ORIGIN_COVER,
} as const

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
  vi.stubGlobal('desktop', { status: vi.fn(async () => ready(HOST_PORT)), onChange: () => () => {} });
  vi.stubGlobal('Audio', class extends EventTarget {
    src = ''
    async play() {}
    pause() {}
    load() {}
    removeAttribute() {}
  })
  session.api = {} as never; FakeSocket.all = [];
  player.queue = []; player.index = -1; player.volume = 100; player.time = 0;
  player.queueOpen = false; player.order = 'normal';
  session.base = HOST_LIBRARY
  session.authQs = 'u=host-fixture'
  player.error = ''
});
afterEach(() => { disposePlayback(); desktop.status = null; vi.unstubAllGlobals(); });

describe('control host', () => {
  it('connects as host with the admin password while services are ready, publishes state and applies valid commands', async () => {
    const stop = startControlHost(url => new FakeSocket(url) as unknown as WebSocket);
    desktop.status = ready(HOST_PORT); await tick();
    const socket = FakeSocket.all[0];
    expect(socket.url).toBe('ws://127.0.0.1:4000/control?h=admin-secret');
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: 'state', state: { playing: false, queueLength: 0, volume: 100 } });
    socket.receive({ type: 'command', name: 'volume', value: 40 });
    expect(player.volume).toBe(40);
    await tick();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'state', state: { volume: 40 } });
    const other = { ...track, id: 'local:track:orbit', rawId: 'orbit', title: 'Paper Orbit' }
    socket.receive({ type: 'command', name: 'queue', tracks: [track, other] });
    expect(player.queue.map(t => t.id)).toEqual([track.id, other.id]);
    socket.receive({ type: 'command', name: 'queue', tracks: [{ id: 'x' }] });
    socket.receive({ type: 'command', name: 'play', collection: { id: 'local:album:a' } });
    socket.receive({ type: 'state', state: { volume: 5 } });
    expect(player.queue.length).toBe(2); expect(player.volume).toBe(40);
    expect(player.queueOpen).toBe(false)

    await tick()
    const published = socket.sent.length
    player.time = 0.1; await tick()
    player.time = 0.9; await tick()
    expect(socket.sent.length).toBe(published)
    player.time = 1.1; await tick()
    expect(socket.sent.length).toBe(published + 1)
    const transport = socket.sent.at(-1) as { state: { queue?: unknown; queueRevision: number } }
    expect(transport).toMatchObject({ state: { time: 1, queueRevision: expect.any(Number) } })
    expect(transport.state.queue).toBeUndefined()
    const [first, second] = player.queue
    socket.receive({ type: 'command', name: 'move', entryId: first.queueEntryId, targetId: second.queueEntryId })
    await tick()
    const [reorderedState, reorderedQueue] = socket.sent.slice(-2) as [{ state: { queueRevision: number } }, { part: string }]
    expect(reorderedState.state.queueRevision).not.toBe(transport.state.queueRevision)
    expect(reorderedQueue).toMatchObject({ type: 'queue', queueRevision: reorderedState.state.queueRevision, complete: true })
    expect((JSON.parse(reorderedQueue.part) as Track[]).map(track => track.queueEntryId)).toEqual([second.queueEntryId, first.queueEntryId])

    desktop.status = ready(4100); await tick(); // a restart on another port reconnects there
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(FakeSocket.all.at(-1)!.url).toBe('ws://127.0.0.1:4100/control?h=admin-secret');
    desktop.status = { ...ready(4100), phase: 'starting' }; await tick();
    expect(FakeSocket.all.at(-1)!.readyState).toBe(WebSocket.CLOSED);
    expect(FakeSocket.all.length).toBe(2);
    stop();
  });
  it('addresses duplicate queue occurrences by identity and ignores stale queue edits', () => {
    player.queue = [
      { ...track, queueEntryId: 'first' },
      { ...track, queueEntryId: 'second' },
      { ...track, id: 'other', queueEntryId: 'third' },
    ]
    player.index = 1
    applyCommand({ type: 'command', name: 'move', entryId: 'first', targetId: 'third' })
    expect(player.queue.map(track => track.queueEntryId)).toEqual(['second', 'third', 'first'])
    expect(player.song?.queueEntryId).toBe('second')
    applyCommand({ type: 'command', name: 'remove', entryId: 'third' })
    applyCommand({ type: 'command', name: 'remove', entryId: 'third' })
    applyCommand({ type: 'command', name: 'move', entryId: 'first', targetId: 'gone' })
    expect(player.queue.map(track => track.queueEntryId)).toEqual(['second', 'first'])
    expect(player.song?.queueEntryId).toBe('second')
  })

  it.each(['queue', 'tracks'] as const)('rebuilds artwork on the host for %s commands', async name => {
    session.api = { scrobble: vi.fn(async () => {}) } as never
    const withArtwork = { ...track, cover: EXTERNAL_COVER, coverId: 'cinder-cover', playbackOrigin: album, playbackOriginIndex: 1 }
    const withoutArtwork = { ...track, cover: EXTERNAL_COVER, playbackOrigin: { ...album, cover: EXTERNAL_COVER } }

    applyCommand({ type: 'command', name, tracks: [withArtwork, withoutArtwork], index: 0 })

    expect(player.queue[0]).toMatchObject({
      cover: `${HOST_LIBRARY}/rest/getCoverArt?id=cinder-cover&size=512&u=host-fixture`,
      playbackOrigin: { id: album.id, cover: `${HOST_LIBRARY}/rest/getCoverArt?id=crater-cover&size=300&u=host-fixture` },
      playbackOriginIndex: 1,
    })
    expect(player.queue[1]).toMatchObject({ cover: '', playbackOrigin: { id: album.id, cover: '' } })
    if (name === 'tracks') await vi.waitFor(() => expect(player.playing).toBe(true))
  })

  it('rebuilds the collection artwork attached to tracks added from a phone', async () => {
    session.api = {
      getAlbum: vi.fn(async () => ({ status: 'ok', album: { song: [{ id: 'cinder', title: 'Glowing Cinder' }] } })),
    } as never

    library.details = album
    try {
      applyCommand({ type: 'command', name: 'add', collection: album })

      await vi.waitFor(() => expect(player.queue[0]?.playbackOrigin).toMatchObject({
        id: album.id, cover: `${HOST_LIBRARY}/rest/getCoverArt?id=crater-cover&size=300&u=host-fixture`,
      }))
      expect(player.queueOpen).toBe(false)
      expect(library.details?.id).toBe(album.id)
    } finally {
      library.details = undefined
    }
  })

  it('publishes a large multibyte queue in bounded frames while sending transport separately', async () => {
    const title = '☄'.repeat(LARGE_TITLE_LENGTH)
    player.queue = Array.from({ length: LARGE_QUEUE_COUNT }, (_, index) => ({ ...track, title, queueEntryId: `entry-${index}` }))
    player.index = player.queue.length - 1
    const stop = startControlHost(url => new FakeSocket(url) as unknown as WebSocket)
    try {
      desktop.status = ready(HOST_PORT)
      await tick()
      const socket = FakeSocket.all[0]
      socket.open()
      const [transport, ...frames] = socket.sent as { type: string; part?: string; complete?: boolean }[]
      expect(transport).toMatchObject({ type: 'state', state: { queueLength: LARGE_QUEUE_COUNT, entryId: player.song?.queueEntryId } })
      const bytes = new TextEncoder()
      const serialized = frames.map(frame => frame.part).join('')
      expect(bytes.encode(serialized).byteLength).toBeGreaterThan(RELAY_LIMIT_BYTES)
      expect(frames.every(frame => frame.type === 'queue' && bytes.encode(JSON.stringify(frame)).byteLength <= WIRE_PART_LIMIT_BYTES)).toBe(true)
      expect(frames.at(-1)?.complete).toBe(true)
      const entries = JSON.parse(serialized) as Track[]
      expect(entries).toHaveLength(LARGE_QUEUE_COUNT)
      expect(entries.at(-1)).toMatchObject({ title, queueEntryId: player.song?.queueEntryId })

      socket.sent.length = 0
      player.time = 1
      await tick()
      expect(socket.sent).toEqual([expect.objectContaining({ type: 'state', state: expect.objectContaining({ time: 1 }) })])
    } finally {
      stop()
    }
  })

  it('replays the selected history occurrence in its saved shuffle order', async () => {
    session.api = { scrobble: vi.fn(async () => {}) } as never
    const tracks = [track, { ...track, rawId: 'cinder', title: 'Glowing Cinder' }, { ...track, rawId: 'orbit', title: 'Paper Orbit' }]
    const replay = { type: 'command', name: 'history', tracks, index: 0, order: 'shuffle' }
    applyCommand({ ...replay, permutation: [0, 1, 1] })
    applyCommand({ ...replay, permutation: [0, 2, 1], order: 'invalid' })
    expect(player.queue).toEqual([])

    applyCommand({ ...replay, permutation: [0, 2, 1] })
    await vi.waitFor(() => expect(player.playing).toBe(true))
    expect(player.song?.rawId).toBe(track.rawId)
    expect(player.order).toBe('shuffle')
    applyCommand({ type: 'command', name: 'next' })
    expect(player.song?.rawId).toBe('orbit')
    await vi.waitFor(() => expect(player.playing).toBe(true))
  })

  it('uses the phone’s new Random scope even when a desktop draw is still pending', async () => {
    const phoneAlbum = { ...album, id: 'local:album:orbit', rawId: 'orbit', title: 'Paper Orbit' }
    let finishOldLookup!: (value: unknown) => void
    const oldLookup = new Promise(resolve => { finishOldLookup = resolve })
    const getAlbum = vi.fn(({ id }: { id: string }) => id === album.rawId
      ? oldLookup
      : Promise.resolve({ status: 'ok', album: { song: [{ id: 'orbit-track', title: 'Paper Orbit' }] } }))
    session.api = { getAlbum, scrobble: vi.fn(async () => {}) } as never

    setOrder('random', () => gridFor([album]))
    expect(getAlbum).toHaveBeenCalledWith({ id: album.rawId })
    applyCommand({ type: 'command', name: 'random', collections: [phoneAlbum] })
    try {
      await vi.waitFor(() => expect(player.song?.playbackOrigin?.id).toBe(phoneAlbum.id))
    } finally {
      finishOldLookup({ status: 'ok', album: { song: [{ id: 'cinder', title: 'Glowing Cinder' }] } })
      await oldLookup
    }
    await vi.waitFor(() => expect(player.playing).toBe(true))
    applyCommand({ type: 'command', name: 'next' })
    await vi.waitFor(() => expect(player.queue).toHaveLength(2))
    expect(player.queue.map(song => song.playbackOrigin?.id)).toEqual([phoneAlbum.id, phoneAlbum.id])
    await vi.waitFor(() => expect(player.playing).toBe(true))
  })

  it('publishes an error for an oversized track selection and accepts a smaller retry', async () => {
    const stop = startControlHost(url => new FakeSocket(url) as unknown as WebSocket)
    try {
      desktop.status = ready(HOST_PORT)
      await tick()
      const socket = FakeSocket.all[0]
      socket.open()
      const queue = player.queue

      socket.receive({ type: 'command', name: 'tracks', tracks: Array(OVER_LIMIT_COUNT).fill(track), index: 0 })
      await tick()

      expect(player.queue).toBe(queue)
      expect(socket.sent.at(-1)).toMatchObject({ state: { error: expect.stringContaining('Choose fewer tracks') } })

      socket.receive({ type: 'command', name: 'queue', tracks: [track] })
      await tick()

      expect(player.queue.map(song => song.id)).toEqual([track.id])
      expect(socket.sent.at(-2)).toMatchObject({ state: { error: '' } })
    } finally {
      stop()
    }
  })
});
