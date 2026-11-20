import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import AnalysisSettings from './analysis-settings.svelte'
import JobsStatus from './jobs-status.svelte'
import { jobs, loadCoverage, setAnalysisHidden, type AnalysisCoverage, type JobsBridge, type JobsStatus as Status } from './jobs.svelte'

const RUNNING: Status = { mode: 'idle', classes: { analyse: { queued: 6, running: 1, done: 3, failed: 0 } }, paused: [] }
const PAUSED: Status = { ...RUNNING, paused: ['analyse'] }
const COVERAGE: AnalysisCoverage = { tracks: 40, analysed: 30, unreadable: 1, unavailable: 2, waiting: 7, refused: 5, ready: true }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const button = (name: string) => [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
const text = () => document.body.textContent ?? ''

let bridge: { [K in keyof JobsBridge]: ReturnType<typeof vi.fn> }
beforeEach(() => {
  setAnalysisHidden(false)
  Object.assign(jobs, { status: RUNNING, coverage: undefined, busy: false, error: '', pauseError: '' })
  bridge = {
    reportPlayback: vi.fn(), status: vi.fn(async () => jobs.status), onChange: vi.fn(() => () => {}),
    analysisCoverage: vi.fn(async () => COVERAGE),
    pauseAnalysis: vi.fn(async (paused: boolean) => (paused ? PAUSED : RUNNING)),
    restartAnalysis: vi.fn(async () => ({ ...COVERAGE, analysed: 0, waiting: 37 })),
  }
  window.musicJobs = bridge as unknown as JobsBridge
})
afterEach(() => {
  cleanup()
  delete window.musicJobs
  setAnalysisHidden(false)
})

test('the bottom line says Analyzing, pauses and resumes, and hides until Settings shows it again', async () => {
  render(JobsStatus)
  await tick()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Analyzing 3 / 10')
  button('Pause analysis')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe('Analysis paused 3 / 10'))
  expect(bridge.pauseAnalysis).toHaveBeenCalledWith(true)
  button('Resume analysis')!.click()
  await vi.waitFor(() => expect(bridge.pauseAnalysis).toHaveBeenLastCalledWith(false))
  await vi.waitFor(() => expect(button('Pause analysis')).toBeDefined())

  button('Hide analysis progress')!.click()
  await tick()
  expect(button('Pause analysis')).toBeUndefined()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Analysis progress hidden. To show it again, open Settings and choose Analysis.')
  expect(jobs.analysisHidden).toBe(true)
  cleanup()
  render(AnalysisSettings)
  await vi.waitFor(() => expect(text()).toContain('30 of 40 tracks analyzed'))
  const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(toggle.checked).toBe(false)
  toggle.click()
  await tick()
  expect(jobs.analysisHidden).toBe(false)
})

test('the Analysis page mentions Spotify only when this profile has it', async () => {
  render(AnalysisSettings)
  await vi.waitFor(() => expect(text()).toContain('30 of 40 tracks analyzed'))
  expect(text()).not.toMatch(/spotify/i)
  cleanup()
  window.musicSpotify = {} as NonNullable<typeof window.musicSpotify>
  try {
    render(AnalysisSettings)
    await vi.waitFor(() => expect(text()).toContain('Spotify tracks are never analyzed.'))
  } finally { delete window.musicSpotify }
})

test('a failed pause is announced at the bottom line and keeps focus for retry', async () => {
  const response = deferred<void>()
  const message = 'Fixture pause write failure'
  bridge.pauseAnalysis.mockImplementationOnce(async () => { await response.promise; throw new Error(message) })
  render(JobsStatus)
  const pause = button('Pause analysis')!
  pause.focus()
  pause.click()
  await tick()
  expect(document.activeElement).toBe(pause)
  expect(pause.getAttribute('aria-disabled')).toBe('true')
  pause.click()
  expect(bridge.pauseAnalysis).toHaveBeenCalledTimes(1)
  response.resolve()
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(message))
  expect(document.activeElement).toBe(pause)
  pause.click()
  await vi.waitFor(() => expect(button('Resume analysis')).toBe(pause))
  expect(text()).not.toContain(message)
})

test('Settings shows how much of the collection is analyzed and why the rest is not', async () => {
  render(AnalysisSettings)
  await vi.waitFor(() => expect(text()).toContain('30 of 40 tracks analyzed (75%)'))
  const meter = document.querySelector('[role="progressbar"]')!
  expect([meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemax')]).toEqual(['30', '40'])
  for (const line of ['7 tracks still to analyze', '1 track could not be read', '2 tracks not found right now', '5 tracks from sources that do not allow analysis']) expect(text()).toContain(line)
  expect(text()).toContain('Analyzing.')
  button('Pause analysis')!.click()
  await vi.waitFor(() => expect(text()).toContain('Paused. Kept keeps its place'))
  expect(button('Resume analysis')).toBeDefined()
})

test('Start over focuses Cancel first and restores the opener after cancellation or completion', async () => {
  render(AnalysisSettings)
  await vi.waitFor(() => expect(button('Start over…')).toBeDefined())
  button('Start over…')!.click()
  await tick()
  expect(document.activeElement).toBe(button('Cancel'))
  expect(text()).toContain('Forget everything Kept has heard')
  expect(bridge.restartAnalysis).not.toHaveBeenCalled()
  button('Cancel')!.click()
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('analysis-start-over'))
  expect(text()).not.toContain('Forget everything')

  const restarted = deferred<AnalysisCoverage>()
  bridge.restartAnalysis.mockImplementation(() => restarted.promise)
  button('Start over…')!.click()
  await tick()
  const confirm = button('Start over')!
  confirm.focus()
  confirm.click()
  await vi.waitFor(() => expect(bridge.restartAnalysis).toHaveBeenCalledTimes(1))
  expect(jobs.busy).toBe(true)
  expect(document.activeElement).toBe(confirm)
  restarted.resolve({ ...COVERAGE, analysed: 0, waiting: 37 })
  await vi.waitFor(() => expect(text()).toContain('0 of 40 tracks analyzed'))
  await vi.waitFor(() => expect(document.activeElement).toBe(button('Start over…')))
  expect(button('Start over…')?.disabled).toBe(false)
})

test('a coverage read started before Start over cannot replace the restart result', async () => {
  render(AnalysisSettings)
  await vi.waitFor(() => expect(text()).toContain('30 of 40 tracks analyzed'))
  const stale = deferred<AnalysisCoverage>()
  bridge.analysisCoverage.mockImplementationOnce(() => stale.promise)
  const refreshing = loadCoverage()
  button('Start over…')!.click()
  await tick()
  button('Start over')!.click()
  await vi.waitFor(() => expect(text()).toContain('0 of 40 tracks analyzed'))
  stale.resolve(COVERAGE)
  await refreshing
  await tick()
  expect(text()).toContain('0 of 40 tracks analyzed')
})

test('a copy without the decoder or model says so instead of offering controls', async () => {
  bridge.analysisCoverage.mockResolvedValue({ ...COVERAGE, ready: false, missing: 'no sound model' })
  render(AnalysisSettings)
  await vi.waitFor(() => expect(text()).toContain('unavailable in this copy of Kept: no sound model'))
  expect(button('Pause analysis')).toBeUndefined()
})
