import { describe, expect, it } from 'vitest'
import { jobsSummary } from './jobs.svelte'
import { watchPlaybackActivity, type PlaybackReport } from './playback-activity'

const element = () => {
  const audio = new Audio()
  const set = (paused: boolean, readyState: number = HTMLMediaElement.HAVE_ENOUGH_DATA) => {
    Object.defineProperty(audio, 'paused', { value: paused, configurable: true })
    Object.defineProperty(audio, 'readyState', { value: readyState, configurable: true })
  }
  return { audio, set, fire: (name: string) => audio.dispatchEvent(new Event(name)) }
}

describe('playback activity reports', () => {
  it('reports state changes once, stalls every time and a track start when a source loads', () => {
    const { audio, set, fire } = element(), reports: PlaybackReport[] = [], controller = new AbortController()
    watchPlaybackActivity(audio, report => reports.push(report), controller.signal)
    fire('loadstart')
    set(false); fire('play'); fire('playing'); fire('timeupdate')
    set(false, HTMLMediaElement.HAVE_CURRENT_DATA); fire('waiting'); fire('stalled')
    set(false); fire('playing')
    set(true); fire('pause'); fire('pause')
    expect(reports).toEqual([
      { kind: 'track-start' },
      { kind: 'state', playing: true, waiting: false },
      { kind: 'stall' }, { kind: 'state', playing: true, waiting: true }, { kind: 'stall' },
      { kind: 'state', playing: true, waiting: false },
      { kind: 'state', playing: false, waiting: false },
    ])
  })

  it('ignores a waiting event while paused, and says playback ended when it stops being watched', () => {
    const { audio, set, fire } = element(), reports: PlaybackReport[] = [], controller = new AbortController()
    watchPlaybackActivity(audio, report => reports.push(report), controller.signal)
    fire('waiting')
    expect(reports).toEqual([])
    set(false); fire('play')
    controller.abort()
    expect(reports.at(-1)).toEqual({ kind: 'state', playing: false, waiting: false })
    fire('pause')
    expect(reports).toHaveLength(2)
  })
})

describe('job progress text', () => {
  it('shows what is left in each class and nothing once it is all done', () => {
    expect(jobsSummary(undefined)).toBeUndefined()
    expect(jobsSummary({ mode: 'idle', classes: { hash: { queued: 3, running: 2, done: 5, failed: 0 } } })).toBe('Reading files 5 / 10')
    expect(jobsSummary({ mode: 'idle', classes: { reconstruct: { queued: 1, running: 1, done: 2, failed: 0 } } })).toBe('Repairing albums 2 / 4')
    expect(jobsSummary({ mode: 'playing', classes: { hash: { queued: 0, running: 0, done: 10, failed: 0 }, analyse: { queued: 1, running: 0, done: 0, failed: 1 } } })).toBe('Analyzing 1 / 2')
    const analysing = { mode: 'idle' as const, classes: { analyse: { queued: 4, running: 1, done: 5, failed: 0 } } }
    expect(jobsSummary({ ...analysing, paused: ['analyse'] })).toBe('Analysis paused 5 / 10')
    expect(jobsSummary(analysing, { analysisHidden: true })).toBeUndefined()
    expect(jobsSummary({ ...analysing, classes: { ...analysing.classes, hash: { queued: 1, running: 0, done: 1, failed: 0 } } }, { analysisHidden: true })).toBe('Reading files 1 / 2')
  })
})
