import { SPOTIFY_PAUSE_TIMEOUT_MS } from '../../../shared/spotify-source.js'
import type { PlaybackAdapter } from './playback-controller'
import type { Track } from './music'
import type { PlaybackRef } from './playback-ref'

// What the main process offers (desktop/spotify.js through preload.js). The adapter never sees a token.
export type SpotifyRemoteState = { deviceId: string; playing: boolean; progress: number; trackId: string; duration: number }
export type SpotifyPlayback = SpotifyRemoteState | { retryAfterMs: number } | undefined
export type SpotifyCommands = {
  command(action: 'play' | 'pause' | 'resume' | 'seek', value?: string | number): Promise<string | undefined>
  playback(): Promise<SpotifyPlayback>
}
export type SpotifyObserver = {
  progress(trackId: string, seconds: number, duration: number): void
  ended(trackId: string, devicePlaying: boolean): void
  // Spotify is playing something else, or the device went away: playback is no longer ours to report.
  lost(message: string): void
  // The device paused or resumed this track without Kept: the controls follow.
  paused(trackId: string): void
  resumed(trackId: string): void
}
export type SpotifyAdapterOptions = {
  commands: SpotifyCommands
  observer: SpotifyObserver
  ready(): boolean
  connected?(): boolean
  // Synchronous: play and skip never wait on a lookup.
  resolve(track: Track): PlaybackRef | undefined
  pollMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  clock?: () => number
}

export const SPOTIFY_POLL_MS = 1000
const END_WINDOW_SECONDS = 2
const END_JITTER_SECONDS = 0.5
const MS_PER_SECOND = 1000
const MAX_TIMER_MS = 2_147_483_647
export const SPOTIFY_NOT_READY = 'Sign in to Spotify in Settings to play this track.'
export const SPOTIFY_UNRESOLVED = 'This Spotify track cannot be played.'

// Spotify plays on the user's own Connect device. Kept only sends commands and watches the position; the
// audio never passes through the app, so nothing here can analyse, cache or capture it.
export function createSpotifyAdapter({ commands, observer, ready, connected = ready, resolve, pollMs = SPOTIFY_POLL_MS, setTimer = (run, ms) => setTimeout(run, ms), clearTimer = handle => clearTimeout(handle as ReturnType<typeof setTimeout>), clock = Date.now }: SpotifyAdapterOptions): PlaybackAdapter & { stop(): void } {
  let owner = 0
  let timer: unknown
  let current: { trackId: string; duration: number; deviceId: string } | undefined
  let last: { progress: number; playing: boolean; at: number } | undefined

  const stopPolling = () => { owner++; clearTimer(timer); timer = undefined; last = undefined }
  const stop = () => { stopPolling(); current = undefined }
  const idOf = (track: Track) => {
    const ref = resolve(track)
    return ref?.kind === 'spotify-track' ? ref.trackId : undefined
  }

  // One poll at a time, owned by a generation: a poll that outlives a pause, a skip or a sign-out is dropped.
  function schedule(mine: number, retryAfterMs = 0) {
    timer = setTimer(() => { void poll(mine) }, Math.min(MAX_TIMER_MS, Math.max(pollMs, retryAfterMs)))
  }
  async function poll(mine: number) {
    if (mine !== owner || !current) return
    const expected = current
    if (!connected()) {
      stop()
      observer.lost(SPOTIFY_NOT_READY)
      return
    }
    let state: SpotifyPlayback
    try {
      state = await commands.playback()
    } catch {
      if (mine === owner) schedule(mine)
      return
    }
    if (mine !== owner) return
    if (state && 'retryAfterMs' in state) {
      schedule(mine, state.retryAfterMs)
      return
    }
    if (state && state.deviceId !== expected.deviceId) {
      stop()
      observer.lost('Spotify moved to another device. Press play to take it back.')
      return
    }
    if (!state || state.trackId !== expected.trackId) {
      const finished = last?.playing && last.progress + (clock() - last.at) / MS_PER_SECOND >= expected.duration - END_JITTER_SECONDS && expected.duration > 0
      if (finished && state?.playing) {
        // Spotify autoplayed on the same device. Keep control so the queue can pause it.
        stopPolling()
        observer.ended(expected.trackId, true)
      } else {
        stop()
        if (finished) observer.ended(expected.trackId, false)
        else observer.lost('Spotify is playing something else. Press play to take it back.')
      }
      return
    }
    if (state.playing) {
      if (last && !last.playing) observer.resumed(state.trackId)
      observer.progress(state.trackId, state.progress, state.duration || expected.duration)
    } else if (last?.playing && expected.duration > 0 && last.progress >= expected.duration - END_WINDOW_SECONDS && state.progress < END_JITTER_SECONDS) {
      stop(); observer.ended(expected.trackId, false); return
    } else if (last?.playing) observer.paused(state.trackId)
    last = { progress: state.progress, playing: state.playing, at: clock() }
    schedule(mine)
  }

  return {
    available(track) {
      if (!ready()) throw new Error(SPOTIFY_NOT_READY)
      if (!idOf(track)) throw new Error(SPOTIFY_UNRESOLVED)
    },
    async prepare() {},
    async start(track) {
      if (!ready()) throw new Error(SPOTIFY_NOT_READY)
      const trackId = idOf(track)
      if (!trackId) throw new Error(SPOTIFY_UNRESOLVED)
      stop()
      const deviceId = await commands.command('play', trackId)
      if (!deviceId) throw new Error('Spotify did not confirm a playback device.')
      const mine = ++owner
      current = { trackId, duration: track.duration ?? 0, deviceId }
      last = { progress: 0, playing: true, at: clock() }
      schedule(mine)
    },
    async pause() {
      stopPolling()
      if (!current) return
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          commands.command('pause'),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Spotify did not confirm the pause.')), SPOTIFY_PAUSE_TIMEOUT_MS)
          }),
        ])
      } finally { clearTimeout(deadline) }
    },
    async resume() {
      if (!current) return
      await commands.command('resume')
      if (current) { const mine = ++owner; last = { progress: last?.progress ?? 0, playing: true, at: clock() }; schedule(mine) }
    },
    async seek(seconds) { if (current) await commands.command('seek', seconds) },
    stop,
  }
}
