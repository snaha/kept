import test from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackController, type PlaybackAdapter } from '../src/lib/playback-controller.ts'
import { createSpotifyAdapter, SPOTIFY_NOT_READY, type SpotifyRemoteState } from '../src/lib/spotify-adapter.ts'
import { createPlaybackResolver } from '../src/lib/playback-ref.ts'
import { spotifyTrack } from '../src/lib/spotify-track.ts'
import { isListeningContext, isStoredTrack } from '../../shared/contracts.js'
import type { Source, Track } from '../src/lib/music.ts'

const SPOTIFY_ID = 'keptSpotifyTestTrack01'
const DURATION = 200
const POLL_MS = 10
const local = (id: string): Track => ({ id: `local:track:${id}`, rawId: id, source: 'local', title: id, cover: '', available: true })
const spotify = (id = SPOTIFY_ID): Track => spotifyTrack({ id, title: 'Song', artist: 'Artist', album: 'Album', duration: DURATION })
const resolver = createPlaybackResolver()
const resolve = (track: Track) => resolver.resolve(track.catalogRef ?? { kind: 'navidrome', id: track.rawId })

// Local and Spotify adapters that record what they do, and a Spotify remote the test controls.
function setup(options: { ready?: () => boolean; deviceId?: string } = {}) {
  const events: string[] = [], sounding = new Set<Source>()
  const localAdapter: PlaybackAdapter = {
    available: () => {}, prepare: async () => { events.push('prepare:local') },
    start: async track => { assert.equal(sounding.size, 0, 'players never overlap'); sounding.add('local'); events.push(`play:${track.id}`) },
    pause: async () => { sounding.delete('local'); events.push('pause:local') }, resume: async () => {}, seek: async () => {},
  }
  const remote: { state?: SpotifyRemoteState; commands: string[]; ended: string[]; lost: string[]; progress: number[]; paused: string[]; resumed: string[] } = { commands: [], ended: [], lost: [], progress: [], paused: [], resumed: [] }
  const timers: (() => void)[] = []
  let now = 0
  const adapter = createSpotifyAdapter({
    ready: options.ready ?? (() => true), resolve, pollMs: POLL_MS, clock: () => now,
    setTimer: run => { timers.push(run); return timers.length }, clearTimer: () => { timers.length = 0 },
    commands: {
      command: async (action, value) => {
        remote.commands.push(`${action}${value === undefined ? '' : `:${value}`}`)
        if (action === 'play') sounding.add('spotify'); if (action === 'pause') sounding.delete('spotify')
        events.push(`spotify:${action}`)
        return action === 'play' ? options.deviceId ?? 'd' : undefined
      },
      playback: async () => remote.state,
    },
    observer: { progress: (_id, seconds) => remote.progress.push(seconds), ended: id => remote.ended.push(id), lost: message => remote.lost.push(message), paused: id => remote.paused.push(id), resumed: id => remote.resumed.push(id) },
  })
  const tick = async (advance = 1) => { now += advance * 1000; const run = timers.shift(); run?.(); await new Promise(done => setTimeout(done, 0)) }
  return { controller: new PlaybackController({ local: localAdapter, spotify: adapter }), adapter, events, sounding, remote, tick }
}

test('a spotify catalog ref resolves synchronously to a spotify playback ref, and only for a plain track id', () => {
  assert.deepEqual(resolve(spotify()), { kind: 'spotify-track', trackId: SPOTIFY_ID })
  assert.equal(resolver.resolve({ kind: 'spotify', id: '../etc' }), undefined)
  assert.deepEqual(resolve(local('1')), { kind: 'navidrome-stream', songId: '1' })
  assert.equal(spotify().source, 'spotify')
  assert.equal(spotify().cover, '', 'no Spotify artwork is kept')
})

test('the controller hands over between local and spotify without overlap, in both directions', async () => {
  const { controller, events, sounding } = setup()
  await controller.play(local('1'))
  await controller.play(spotify())
  assert.equal(controller.active, 'spotify')
  assert.deepEqual([...sounding], ['spotify'])
  await controller.play(local('2'))
  assert.equal(controller.active, 'local')
  assert.deepEqual([...sounding], ['local'])
  assert.deepEqual(events, ['prepare:local', 'play:local:track:1', 'pause:local', 'spotify:play', 'spotify:pause', 'prepare:local', 'play:local:track:2'])
})

test('a mixed queue replays: skipping through local and spotify entries starts each on its own adapter', async () => {
  const { controller, remote } = setup()
  const queue = [local('1'), spotify(), local('2'), spotify('1234567890abcdefghijkl')]
  for (const track of queue) await controller.play(track)
  assert.deepEqual(remote.commands, ['play:' + SPOTIFY_ID, 'pause', 'play:1234567890abcdefghijkl'])
  assert.equal(controller.current?.rawId, '1234567890abcdefghijkl')
})

test('spotify tracks are refused with a clear message when the user is not signed in, and the local track keeps playing', async () => {
  const { controller, sounding } = setup({ ready: () => false })
  await controller.play(local('1'))
  assert.throws(() => controller.available(spotify()), new RegExp(SPOTIFY_NOT_READY.slice(0, 20)))
  assert.deepEqual([...sounding], ['local'])
  assert.doesNotThrow(() => controller.available(local('1')))
})

test('a skip while spotify is starting supersedes it and stops it before the next track makes sound', async () => {
  const { controller, adapter, events, sounding } = setup()
  let release!: () => void
  const original = adapter.start
  adapter.start = async track => { await new Promise<void>(done => { release = done }); await original(track) }
  const first = controller.play(spotify())
  while (!release) await new Promise(done => setTimeout(done, 0))
  const second = controller.play(local('9'))
  release(); await Promise.all([first, second])
  assert.equal(events.at(-1), 'play:local:track:9')
  assert.deepEqual([...sounding], ['local'])
})

test('the adapter reports progress, detects the end of the track and stops watching', async () => {
  const { controller, remote, tick } = setup()
  await controller.play(spotify())
  remote.state = { deviceId: 'd', playing: true, progress: 5, trackId: SPOTIFY_ID, duration: DURATION }
  await tick(); assert.deepEqual(remote.progress, [5])
  remote.state = { deviceId: 'd', playing: true, progress: DURATION - 1, trackId: SPOTIFY_ID, duration: DURATION }
  await tick(); assert.deepEqual(remote.ended, [])
  remote.state = { deviceId: 'd', playing: false, progress: 0, trackId: SPOTIFY_ID, duration: DURATION }
  await tick(); assert.deepEqual(remote.ended, [SPOTIFY_ID])
  await tick(); assert.deepEqual(remote.ended, [SPOTIFY_ID], 'it stopped polling')
})

test('another track playing on the device is reported as lost, not as a finished track', async () => {
  const { controller, remote, tick } = setup()
  await controller.play(spotify())
  remote.state = { deviceId: 'd', playing: true, progress: 3, trackId: 'someoneelse', duration: DURATION }
  await tick()
  assert.equal(remote.lost.length, 1); assert.deepEqual(remote.ended, [])
})

test('a pause or resume made on the device reaches the player, mid-track', async () => {
  const { controller, remote, tick } = setup()
  await controller.play(spotify())
  remote.state = { deviceId: 'd', playing: true, progress: 5, trackId: SPOTIFY_ID, duration: DURATION }
  await tick()
  remote.state = { deviceId: 'd', playing: false, progress: 6, trackId: SPOTIFY_ID, duration: DURATION }
  await tick(); await tick()
  assert.deepEqual([remote.paused, remote.resumed], [[SPOTIFY_ID], []], 'reported once')
  remote.state = { deviceId: 'd', playing: true, progress: 6, trackId: SPOTIFY_ID, duration: DURATION }
  await tick()
  assert.deepEqual(remote.resumed, [SPOTIFY_ID])
})

test('the same track handed to another device is reported as lost', async () => {
  const { controller, remote, tick } = setup({ deviceId: 'mine' })
  await controller.play(spotify())
  remote.state = { deviceId: 'mine', playing: true, progress: 5, trackId: SPOTIFY_ID, duration: DURATION }
  await tick(); assert.equal(remote.lost.length, 0)
  remote.state = { deviceId: 'phone', playing: true, progress: 6, trackId: SPOTIFY_ID, duration: DURATION }
  await tick()
  assert.equal(remote.lost.length, 1); assert.deepEqual(remote.progress, [5])
})

test('history and queue contracts accept mixed local and spotify occurrences', () => {
  const queue = [local('1'), spotify(), local('2')]
  assert.ok(queue.every(isStoredTrack))
  assert.ok(isListeningContext({ id: 'c', queue, order: 'normal', permutation: [] }))
  assert.equal(isStoredTrack({ ...spotify(), source: 'other' }), false)
  assert.equal(isStoredTrack({ ...spotify(), catalogRef: { kind: 'tidal', id: 'x' } }), false)
})
