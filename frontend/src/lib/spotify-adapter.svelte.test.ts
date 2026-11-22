import { afterEach, expect, test, vi } from 'vitest'
import { createSpotifyAdapter, SPOTIFY_POLL_MS, type SpotifyPlayback } from './spotify-adapter'
import { spotifyTrack } from './spotify-track'

const TRACK_ID = 'fakeTrackForAdapter1'
const RETRY_AFTER_MS = SPOTIFY_POLL_MS * 5
const TRACK_DURATION = 120
const TRACK_PROGRESS = 30
const track = spotifyTrack({ id: TRACK_ID, title: '', artist: '', album: '', duration: TRACK_DURATION })

function setup() {
  vi.useFakeTimers()
  let ready = true
  const playback = vi.fn<() => Promise<SpotifyPlayback>>()
  const observer = { progress: vi.fn(), ended: vi.fn(), lost: vi.fn(), paused: vi.fn(), resumed: vi.fn() }
  const adapter = createSpotifyAdapter({
    commands: { command: async action => action === 'play' ? 'test-device' : undefined, playback },
    observer,
    ready: () => ready,
    resolve: () => ({ kind: 'spotify-track', trackId: TRACK_ID }),
  })
  return { adapter, playback, observer, signOut: () => { ready = false } }
}

afterEach(() => vi.useRealTimers())

test('a rate-limited poll waits for Retry-After and then reports the same track again', async () => {
  const { adapter, playback, observer } = setup()
  playback.mockResolvedValueOnce({ retryAfterMs: RETRY_AFTER_MS })
  playback.mockResolvedValue({ deviceId: 'test-device', playing: true, trackId: TRACK_ID, progress: TRACK_PROGRESS, duration: TRACK_DURATION })

  await adapter.start(track)
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1)
  expect(playback).toHaveBeenCalledTimes(1)
  expect(observer.lost).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(playback).toHaveBeenCalledTimes(2)
  expect(observer.progress).toHaveBeenCalledWith(TRACK_ID, TRACK_PROGRESS, TRACK_DURATION)
})

test('a rate-limit response that arrives after pause cannot start another poll', async () => {
  const { adapter, playback, observer } = setup()
  let deliver!: (state: SpotifyPlayback) => void
  playback.mockReturnValue(new Promise(resolve => { deliver = resolve }))
  await adapter.start(track)
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS)
  await adapter.pause()
  deliver({ retryAfterMs: RETRY_AFTER_MS })
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS)
  expect(playback).toHaveBeenCalledTimes(1)
  expect(observer.lost).not.toHaveBeenCalled()
})

test('a revoked sign-in stops polling and reports lost playback', async () => {
  const { adapter, playback, observer, signOut } = setup()
  playback.mockImplementation(async () => {
    signOut()
    throw new Error('Sign in again')
  })
  await adapter.start(track)
  await vi.advanceTimersByTimeAsync(SPOTIFY_POLL_MS * 2)
  expect(playback).toHaveBeenCalledTimes(1)
  expect(observer.lost).toHaveBeenCalledTimes(1)
})
