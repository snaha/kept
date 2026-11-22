import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SubsonicAPI } from 'subsonic-api'
import { session } from './api.svelte'
import { disposeHistory } from './listening-history.svelte'
import type { Track } from './music'
import { disposePlayback, pause, play, player } from './player.svelte'
import { SPOTIFY_POLL_MS } from './spotify-adapter'
import { disconnectSpotify, spotify, type SpotifyBridge, type SpotifyStatus } from './spotify.svelte'
import { spotifyTrack } from './spotify-track'

const DURATION = 120
const PROGRESS = 20
const PAUSE_BUDGET_MS = 1000
const REMOTE = spotifyTrack({ id: 'keptSpotifyTestTrack01', title: 'Fixture remote track', artist: '', album: '', duration: DURATION })
const LOCAL: Track = { id: 'local:track:fixture', rawId: 'fixture', title: 'Fixture local track', source: 'local', cover: '', available: true }
const SIGNED_OUT: SpotifyStatus = { connected: false, deviceId: '', account: '', deviceName: '', clientId: '', error: '' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class TestAudio extends EventTarget {
  src = ''
  paused = true
  async play() { this.paused = false }
  pause() { this.paused = true }
  load() {}
  removeAttribute() { this.src = '' }
}

let command: ReturnType<typeof vi.fn<SpotifyBridge['command']>>
beforeEach(() => {
  if (typeof window === 'undefined') vi.stubGlobal('window', globalThis)
  if (typeof localStorage === 'undefined') {
    vi.stubGlobal('localStorage', { getItem: () => undefined, setItem: () => {} })
  }
  vi.stubGlobal('Audio', TestAudio)
  session.api = { scrobble: async () => ({ status: 'ok' }) } as unknown as SubsonicAPI
  session.base = 'http://fixture.example:4533'
  session.username = 'fixture-user'
  player.queue = []
  player.index = -1
  spotify.connected = true
  spotify.deviceId = 'fixture-device'
  command = vi.fn(async action => {
    if (action === 'pause' && !spotify.connected) throw new Error('The Spotify account is gone')
    return action === 'play' ? 'fixture-device' : undefined
  })
  vi.stubGlobal('musicSpotify', { command, disconnect: async () => SIGNED_OUT })
})
afterEach(() => {
  disposePlayback()
  disposeHistory()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('local Play starts after Spotify loses its account without trying to pause the lost device', async () => {
  vi.useFakeTimers()
  play([REMOTE])
  await vi.waitFor(() => expect(player.playing).toBe(true))
  spotify.connected = false
  spotify.deviceId = ''
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  expect(player.suspended).toBe(true)

  play([LOCAL])
  await vi.waitFor(() => expect(player.playing).toBe(true))
  expect(player.song?.id).toBe(LOCAL.id)
  expect(command.mock.calls.map(([action]) => action)).toEqual(['play'])
})

test('local Play waits for the outgoing Spotify pause and survives sign-out', async () => {
  vi.useFakeTimers()
  const pauseStarted = deferred<void>()
  const pauseReply = deferred<undefined>()
  play([REMOTE])
  await vi.waitFor(() => expect(player.playing).toBe(true))
  command.mockImplementationOnce(() => {
    pauseStarted.resolve()
    return pauseReply.promise
  })

  const signingOut = disconnectSpotify()
  await pauseStarted.promise
  play([LOCAL])
  await vi.advanceTimersByTimeAsync(0)
  expect(player.pending).toBe(true)
  expect(player.playing).toBe(false)
  pauseReply.resolve(undefined)
  await signingOut
  await vi.waitFor(() => expect(player.playing).toBe(true))
  expect(player.song?.id).toBe(LOCAL.id)
  expect(player.suspended).toBe(false)
  expect(spotify.connected).toBe(false)
  expect(command.mock.calls.map(([action]) => action)).toEqual(['play', 'pause'])
  const pauseAudio = vi.spyOn(TestAudio.prototype, 'pause')
  await pause()
  expect(pauseAudio).toHaveBeenCalledOnce()
})

test('Spotify progress still follows the playing device after Settings selects another', async () => {
  vi.useFakeTimers()
  const deviceId = spotify.deviceId
  const playback = async () => ({ deviceId, trackId: REMOTE.rawId, playing: true, progress: PROGRESS, duration: DURATION })
  vi.stubGlobal('musicSpotify', { command, playback })
  play([REMOTE])
  await vi.waitFor(() => expect(player.playing).toBe(true))

  spotify.deviceId = 'fixture-next-device'
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  expect(player.playing).toBe(true)
  expect(player.time).toBe(PROGRESS)
})

test('automatic queue advance pauses Spotify autoplay before starting local audio', async () => {
  vi.useFakeTimers()
  const deviceId = spotify.deviceId
  const state = { deviceId, trackId: REMOTE.rawId, playing: true, progress: DURATION, duration: DURATION }
  vi.stubGlobal('musicSpotify', { command, playback: async () => ({ ...state }) })
  const localPlay = vi.spyOn(TestAudio.prototype, 'play')
  play([REMOTE, LOCAL])
  await vi.waitFor(() => expect(player.playing).toBe(true))
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  expect(player.time).toBe(state.progress)

  state.trackId = 'keptSpotifyTestTrack02'
  state.progress = 0
  const pauseReply = deferred<undefined>()
  command.mockImplementationOnce(() => pauseReply.promise)
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  expect(command.mock.calls.map(([action]) => action)).toEqual(['play', 'pause'])
  expect(localPlay).not.toHaveBeenCalled()
  expect(player.pending).toBe(true)

  pauseReply.resolve(undefined)
  await vi.waitFor(() => expect(player.playing).toBe(true))
  expect(localPlay).toHaveBeenCalledOnce()
  expect(player.song?.id).toBe(LOCAL.id)
})

for (const failure of ['lost device', 'missing reply']) {
  test(`blocked autoplay attempts a pause and a ${failure} cannot block local Play`, async () => {
    vi.useFakeTimers()
    const state = { deviceId: spotify.deviceId, trackId: REMOTE.rawId, playing: true, progress: DURATION, duration: DURATION }
    vi.stubGlobal('musicSpotify', { command, playback: async () => ({ ...state }) })
    const localPlay = vi.spyOn(TestAudio.prototype, 'play')
    const pauseReply = deferred<undefined>()
    play([REMOTE, { ...LOCAL, available: false }])
    await vi.waitFor(() => expect(player.playing).toBe(true))
    await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)

    state.trackId = 'keptSpotifyTestTrack02'
    state.progress = 0
    command.mockImplementation(action => {
      if (action !== 'pause') throw new Error('Unexpected Spotify command')
      if (failure === 'lost device') return Promise.reject(new Error('No Spotify device is active'))
      return pauseReply.promise
    })
    await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
    expect(player.blockedIndex).toBe(1)
    expect(player.song?.id).toBe(REMOTE.id)
    expect(player.playing).toBe(false)
    expect(player.error).toContain('unavailable')
    expect(command.mock.calls.map(([action]) => action)).toEqual(['play', 'pause'])

    state.deviceId = 'fixture-foreign-device'
    play([LOCAL])
    await vi.advanceTimersByTimeAsync(PAUSE_BUDGET_MS)
    expect(localPlay).toHaveBeenCalledOnce()
    expect(player.song?.id).toBe(LOCAL.id)
    expect(player.playing).toBe(true)
    expect(player.pending).toBe(false)
    pauseReply.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(player.playing).toBe(true)
    expect(command.mock.calls.map(([action]) => action)).toEqual(['play', 'pause'])
  })
}

test('local Play starts when Spotify moves devices before the next poll and the outgoing pause fails', async () => {
  vi.useFakeTimers()
  play([REMOTE])
  await vi.waitFor(() => expect(player.playing).toBe(true))
  command.mockRejectedValueOnce(new Error('No Spotify device is active'))
  play([LOCAL])
  await vi.advanceTimersByTimeAsync(0)
  expect(player.playing).toBe(true)
  expect(player.song?.id).toBe(LOCAL.id)
  expect(command.mock.calls.map(([action]) => action)).toEqual(['play', 'pause'])
})
