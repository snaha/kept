// Playback comes first. The window reports what the audio element is doing; this policy turns
// that into how much background work may run:
//   idle (paused, nothing playing): the full configured concurrency, no pauses
//   playing: one job at a time, working a fraction of the time
//   hold (a track is starting, or the audio stalled or is waiting): nothing runs
// It has no timers of its own: every answer is a function of the reports and the clock it is given.

export const IDLE_CONCURRENCY = 2
export const PLAYING_CONCURRENCY = 1
export const PLAYING_DUTY = 0.3
export const TRACK_START_HOLD_MS = 5000
export const RESUME_HOLD_MS = 2000
export const STALL_HOLD_MS = 8000
export const MAX_REST_MS = 500

export class ResourcePolicy {
  constructor({ now = Date.now, idleConcurrency = IDLE_CONCURRENCY } = {}) {
    this.now = now
    this.idleConcurrency = idleConcurrency
    this.playing = false
    this.waiting = false
    this.holdUntil = 0
    this.enabled = true
  }
  // The window's reports: { kind: 'state', playing, waiting } when the audio element's state changes,
  // { kind: 'track-start' } when a new track loads and { kind: 'stall' } on a waiting or stalled event.
  report(event) {
    const at = this.now()
    if (event.kind === 'state') {
      const resumed = event.playing && !this.playing, recovered = this.waiting && !event.waiting
      this.playing = event.playing
      this.waiting = event.waiting
      // A short hold after playback resumes or recovers lets the buffer settle before work starts again.
      if (resumed || recovered) this.holdUntil = Math.max(this.holdUntil, at + RESUME_HOLD_MS)
    } else if (event.kind === 'track-start') this.holdUntil = Math.max(this.holdUntil, at + TRACK_START_HOLD_MS)
    else if (event.kind === 'stall') this.holdUntil = Math.max(this.holdUntil, at + STALL_HOLD_MS)
  }
  // enabled false is only for measuring the policy against its absence.
  snapshot() {
    if (!this.enabled) return { mode: 'idle', concurrency: this.idleConcurrency, dutyCycle: 1, holdMs: 0 }
    const at = this.now(), holdMs = Math.max(0, this.holdUntil - at)
    if (this.waiting || (this.playing && holdMs > 0)) return { mode: 'hold', concurrency: 0, dutyCycle: 0, holdMs }
    if (this.playing) return { mode: 'playing', concurrency: PLAYING_CONCURRENCY, dutyCycle: PLAYING_DUTY, holdMs: 0 }
    return { mode: 'idle', concurrency: this.idleConcurrency, dutyCycle: 1, holdMs: 0 }
  }
}

// The worker side of the policy: handlers call rest() at their yield points. During a hold it waits
// until the policy lets work continue; while playing it sleeps long enough that the handler
// works only dutyCycle of the time.
export class PlaybackGate {
  constructor({ now = () => performance.now(), sleep }) {
    this.now = now
    this.sleep = sleep
    this.snapshot = { mode: 'idle', concurrency: 1, dutyCycle: 1, holdMs: 0 }
    this.waiters = []
    this.markedAt = this.now()
  }
  apply(snapshot) {
    this.snapshot = snapshot
    if (snapshot.mode !== 'hold') for (const resume of this.waiters.splice(0)) resume()
  }
  // Time spent since the previous rest counts as work.
  async rest(signal) {
    const worked = this.now() - this.markedAt
    if (this.snapshot.mode === 'hold') await new Promise(resolve => { this.waiters.push(resolve); signal?.addEventListener('abort', resolve, { once: true }) })
    else if (this.snapshot.dutyCycle < 1 && this.snapshot.dutyCycle > 0) await this.sleep(Math.min(MAX_REST_MS, worked * (1 - this.snapshot.dutyCycle) / this.snapshot.dutyCycle))
    this.markedAt = this.now()
  }
}
