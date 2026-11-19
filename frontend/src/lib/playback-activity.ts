/** What the window tells the desktop about its audio element, so background work gives way to playback. */
export type PlaybackReport = { kind: 'state'; playing: boolean; waiting: boolean } | { kind: 'track-start' } | { kind: 'stall' }
export type PlaybackReporter = (report: PlaybackReport) => void

const STATE_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'canplay', 'seeked']
const STALL_EVENTS = ['waiting', 'stalled']

/**
 * Reports the audio element's state to the reporter until the signal aborts. A state report is sent only
 * when it changes, a stall on every waiting or stalled event, and a track start when a source loads.
 */
export function watchPlaybackActivity(audio: HTMLAudioElement, reporter: PlaybackReporter, signal: AbortSignal) {
  let playing = false, waiting = false, sent = ''
  const send = () => {
    const key = `${playing}:${waiting}`
    if (key === sent) return
    sent = key
    reporter({ kind: 'state', playing, waiting })
  }
  const read = () => { playing = !audio.paused && !audio.ended; if (!playing) waiting = false }
  const on = (names: string[], listener: () => void) => { for (const name of names) audio.addEventListener(name, listener, { signal }) }
  on(STATE_EVENTS, () => { read(); if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) waiting = false; send() })
  on(STALL_EVENTS, () => { read(); if (!playing) return; waiting = true; reporter({ kind: 'stall' }); send() })
  on(['loadstart'], () => reporter({ kind: 'track-start' }))
  signal.addEventListener('abort', () => { if (playing || waiting) reporter({ kind: 'state', playing: false, waiting: false }) }, { once: true })
}
