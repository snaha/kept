import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from 'vitest-browser-svelte';
import { session } from './api.svelte';
import { player, disposePlayback, play, replayHistory, toggle, setVolume, enqueue, remote, seek, setOrder, jumpRandom, jump, moveQueue, removeQueue, pause } from './player.svelte';
import { pick, addCollection, gridFor, library, type Tile } from './library.svelte';
import { control, setShareMode, startControlClient } from './control-client.svelte';
import { applyCommand, type ControlState } from './control-host.svelte'
import { clearHistory, listeningHistory, loadHistory } from './listening-history.svelte'
import ControlSwitch from './ControlSwitch.svelte';
import type { Track } from './music';

const tile: Tile = { id: 'local:album:a', rawId: 'a', source: 'local', kind: 'album', title: 'Album', sub: 'Artist', cover: '', count: 2, available: true };
const track: Track = { id: 'local:track:one', rawId: 'one', source: 'local', title: 'Song', cover: '', available: true, duration: 180 };
const OVER_LIMIT_COUNT = 10001
const FULL_VOLUME = 100
const PHONE_VOLUME = 85
const HOST_VOLUME = 70
const REMOTE_TIME = 42
const HALF_TRACK = 0.5
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

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = ''; paused = true; volume = 1;
  constructor() { super(); FakeAudio.instances.push(this); }
  async play() {}
  pause() {}
  load() {}
  removeAttribute() {}
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  session.api = { getAlbum: vi.fn(async () => { throw new Error('the phone must not fetch tracks in Control mode'); }), scrobble: vi.fn(async () => {}) } as never;
  session.base = 'http://10.0.0.2:4533'; session.authQs = 'u=share';
  FakeSocket.all = []; player.queue = []; player.index = -1; player.playing = false; player.volume = 100;
  localStorage.removeItem('share.phone'); session.controlSecret = 'control-secret'; control.mode = 'library';
});
afterEach(() => { cleanup(); disposePlayback(); delete remote.send; session.controlSecret = undefined; control.mode = 'library'; vi.unstubAllGlobals(); });

describe('phone control', () => {
  it('hands playback over to the computer in Control mode and takes it back in Library mode', async () => {
    setVolume(PHONE_VOLUME);
    setShareMode('control');
    const stop = startControlClient(url => new FakeSocket(url) as unknown as WebSocket);
    render(ControlSwitch); await tick();
    const socket = FakeSocket.all[0];
    expect(socket.url).toBe(`ws://${location.host}/control?c=control-secret`);
    expect(document.body.textContent).toContain('connecting');
    socket.open(); await tick();
    const entries = [0, 1].map(index => ({ ...track, id: 'local:track:far', rawId: 'far', title: 'Far away', coverId: 'c1', albumId: tile.id, queueEntryId: `entry-${index}`, playbackOriginIndex: index }));
    const initial = { playing: true, pending: false, time: REMOTE_TIME, duration: track.duration, volume: HOST_VOLUME, index: 1, entryId: 'entry-1', queueLength: entries.length, queueRevision: 1, order: 'normal', error: '', loadingCollectionId: '' };
    socket.receive({ type: 'host', connected: true, state: initial });
    const serialized = JSON.stringify(entries);
    socket.receive({ type: 'queue', queueRevision: initial.queueRevision, first: true, complete: false, part: serialized.slice(0, -1) });
    expect(player.time).toBe(0);
    expect(player.queue).toEqual([]);
    socket.receive({ type: 'queue', queueRevision: initial.queueRevision, first: false, complete: true, part: serialized.slice(-1) });
    await tick();
    expect(player.song?.title).toBe('Far away'); expect(player.playing).toBe(true); expect(player.volume).toBe(HOST_VOLUME);
    expect(player.time).toBe(REMOTE_TIME)
    expect(player.song?.cover).toContain('http://10.0.0.2:4533/rest/getCoverArt?id=c1');
    expect(document.body.textContent).not.toContain('connecting');

    void pick(tile); void addCollection(tile); enqueue([track]); void toggle(); setVolume(30);
    expect(names(socket)).toEqual(['play', 'add', 'queue', 'toggle', 'volume']);
    expect(player.queue.length).toBe(2)
    expect(player.index).toBe(1)
    expect(player.song?.playbackOriginIndex).toBe(1)
    const queue = player.queue
    const state = { ...initial, time: REMOTE_TIME + 1 }
    socket.receive({ type: 'state', state })
    expect(player.queue).toBe(queue)
    void seek(0.5)
    setOrder('shuffle', () => gridFor([tile]))
    jumpRandom(() => gridFor([tile]))
    jump(0)
    moveQueue(0, 1)
    removeQueue(0)
    void pause()
    expect(names(socket).slice(5)).toEqual(['seek', 'order', 'random', 'jump', 'move', 'remove', 'pause'])
    expect(socket.sent.at(-3)).toMatchObject({ name: 'move', entryId: 'entry-0', targetId: 'entry-1' })
    expect(socket.sent.at(-5)).toMatchObject({ name: 'random', collections: [tile] })
    expect(player.queue).toBe(queue)
    expect(player.index).toBe(1)

    const permutation = [1, 0]
    replayHistory({ id: 'fixture-play', index: 1, cursor: 0, playedAt: 1, context: { id: 'fixture-queue', queue: entries, order: 'shuffle', permutation } })
    expect(socket.sent.at(-1)).toMatchObject({ name: 'history', index: 1, order: 'shuffle', permutation })

    const sentBeforeRejection = socket.sent.length
    enqueue(Array(OVER_LIMIT_COUNT).fill(track))
    expect(socket.sent.length).toBe(sentBeforeRejection)
    expect(player.error).toContain('Choose fewer tracks')
    socket.receive({ type: 'state', state })
    expect(player.error).toContain('Choose fewer tracks')
    expect(player.queue).toBe(queue)
    enqueue([track])
    expect(names(socket).at(-1)).toBe('queue')
    expect(player.error).toBe('')

    socket.receive({ type: 'host', connected: false, state: null }); await tick();
    expect(player.song?.title).toBe('Far away'); expect(player.playing).toBe(false);
    expect(document.body.textContent).toContain('Computer disconnected');
    void toggle()
    expect(player.error).toContain('disconnected')
    const sent = socket.sent.length

    document.querySelector<HTMLButtonElement>('[role=radio][aria-checked=false]')!.click(); await tick();
    expect(control.mode).toBe('library'); expect(socket.readyState).toBe(WebSocket.CLOSED);
    enqueue([track]);
    expect(player.queue.map(t => t.id)).toEqual([track.id]); // plays here again
    expect(socket.sent.length).toBe(sent)
    socket.receive({ type: 'state', state: { index: 999 } })
    expect(player.index).toBe(-1)
    play([track])
    expect(player.volume).toBe(PHONE_VOLUME)
    expect(FakeAudio.instances[0].volume).toBe(PHONE_VOLUME / FULL_VOLUME)
    expect(localStorage.getItem('music.volume')).toBe(String(PHONE_VOLUME))
    await vi.waitFor(() => expect(player.playing).toBe(true))
    stop();
  });

  it('waits for the matching queue revision before showing a track or seeking', async () => {
    const current = { ...track, title: 'Glowing Cinder', queueEntryId: 'cinder' }
    const other = { ...track, title: 'Paper Orbit', queueEntryId: 'orbit' }
    const state: ControlState = {
      playing: true, pending: false, time: REMOTE_TIME, duration: track.duration ?? 0, volume: HOST_VOLUME,
      index: 1, entryId: current.queueEntryId, queueLength: 2, queueRevision: 2, order: 'normal',
      error: '', loadingCollectionId: '',
    }
    setShareMode('control')
    const stop = startControlClient(url => new FakeSocket(url) as unknown as WebSocket)
    try {
      await tick()
      const socket = FakeSocket.all[0]
      socket.open()
      socket.receive({ type: 'host', connected: true, state })
      socket.receive({ type: 'queue', queueRevision: 1, first: true, complete: true, part: JSON.stringify([current, other]) })
      expect(player.song).toBeUndefined()
      expect(player.playing).toBe(false)
      await seek(HALF_TRACK)
      expect(socket.sent).toEqual([])

      const reordered = JSON.stringify([other, current])
      socket.receive({ type: 'queue', queueRevision: state.queueRevision, first: true, complete: false, part: reordered.slice(0, -1) })
      socket.receive({ type: 'state', state: { ...state, time: REMOTE_TIME + 1 } })
      socket.receive({ type: 'queue', queueRevision: 1, complete: true, part: ']' })
      expect(player.queue).toEqual([])
      socket.receive({ type: 'queue', queueRevision: state.queueRevision, complete: true, part: reordered.slice(-1) })
      expect(player.song?.title).toBe(current.title)
      expect(player.time).toBe(REMOTE_TIME + 1)
      await seek(HALF_TRACK)
      expect(socket.sent).toEqual([{ type: 'command', name: 'seek', value: HALF_TRACK, entryId: current.queueEntryId }])

      socket.receive({ type: 'host', connected: true })
      socket.receive({ type: 'state', state: { ...state, index: 0, entryId: other.queueEntryId } })
      expect(player.playing).toBe(false)
      await seek(HALF_TRACK)
      expect(socket.sent).toHaveLength(1)
      socket.receive({ type: 'queue', queueRevision: state.queueRevision, first: true, complete: true, part: reordered })
      expect(player.song?.title).toBe(other.title)
      expect(player.playing).toBe(true)
    } finally {
      stop()
    }
  })

  it('replays persisted Shuffle history with an incomplete order on the computer', async () => {
    const tracks = [track, { ...track, id: 'local:track:orbit', rawId: 'orbit', title: 'Paper Orbit' }]
    const originalUsername = session.username
    session.username = 'shuffle-fixture'
    const key = `music.history.v1:${session.base}:${session.username}`
    localStorage.setItem(key, JSON.stringify({
      contexts: [{ id: 'fixture-queue', queue: tracks, order: 'shuffle', permutation: [] }],
      entries: [{ id: 'fixture-play', contextId: 'fixture-queue', index: 1, cursor: 0, playedAt: 1 }],
    }))
    setShareMode('control')
    const stop = startControlClient(url => new FakeSocket(url) as unknown as WebSocket)
    try {
      let command: unknown
      try {
        loadHistory()
        expect(listeningHistory.entries).toHaveLength(1)
        await tick()
        const socket = FakeSocket.all[0]
        socket.open()
        socket.receive({ type: 'host', connected: true })
        replayHistory(listeningHistory.entries[0])
        command = socket.sent.at(-1)
      } finally {
        stop()
      }
      applyCommand(command)
      await vi.waitFor(() => expect(player.playing).toBe(true))
      expect(player.order).toBe('shuffle')
      expect(player.song?.rawId).toBe(tracks[1].rawId)
      applyCommand({ type: 'command', name: 'next' })
      expect(player.song?.rawId).toBe(tracks[0].rawId)
      await vi.waitFor(() => expect(player.playing).toBe(true))
    } finally {
      clearHistory()
      session.username = originalUsername
      loadHistory()
      localStorage.removeItem(key)
    }
  })

  it('opens the selected artist’s albums locally while the computer controls playback', async () => {
    const previousTiles = library.tiles;
    const getArtist = vi.fn(async () => ({ status: 'ok', artist: { album: [{ id: 'cinder', name: 'Glowing Cinder' }] } }));
    session.api = { getArtist } as never;
    setShareMode('control');
    const stop = startControlClient(url => new FakeSocket(url) as unknown as WebSocket);
    try {
      await tick();
      const socket = FakeSocket.all[0];
      socket.open();
      socket.receive({ type: 'host', connected: true });
      const artist: Tile = { ...tile, kind: 'artist', id: 'local:artist:chalk', rawId: 'chalk', title: 'Chalk Atlas' };
      await pick(artist);
      expect(getArtist).toHaveBeenCalledExactlyOnceWith({ id: artist.rawId });
      expect(library.tiles.map(album => album.title)).toEqual(['Glowing Cinder']);
      expect(socket.sent).toEqual([]);
    } finally {
      stop();
      library.tiles = previousTiles;
    }
  });
});
