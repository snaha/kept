import { readPreference, writePreference } from './preferences'

/** How far the desktop's background work has got: `hash` reads every file once to give it a lasting identity, `analyse` works out how each track sounds. */
export type JobClassProgress = { queued: number; running: number; done: number; failed: number }
export type JobsStatus = { mode: 'idle' | 'playing' | 'hold'; classes: Record<string, JobClassProgress>; paused?: string[] }
/** How much of the collection the sound analysis has heard. analysed + unreadable + unavailable + waiting = tracks. */
export type AnalysisCoverage = { tracks: number; analysed: number; unreadable: number; unavailable: number; waiting: number; refused: number; ready: boolean; missing?: string }
export type JobsBridge = {
  reportPlayback(report: import('./playback-activity').PlaybackReport): void
  status(): Promise<JobsStatus>
  onChange(callback: (status: JobsStatus) => void): () => void
  analysisCoverage(): Promise<AnalysisCoverage | undefined>
  pauseAnalysis(paused: boolean): Promise<JobsStatus>
  restartAnalysis(): Promise<AnalysisCoverage | undefined>
}

export const ANALYSE = 'analyse'
const LABELS: Record<string, string> = { hash: 'Reading files', reconstruct: 'Repairing albums', [ANALYSE]: 'Analyzing' }
const HIDDEN_PREFERENCE = 'analysis.progress'
const HIDDEN = 'hidden'
export const jobs = $state<{ status: JobsStatus | undefined; analysisHidden: boolean; coverage: AnalysisCoverage | undefined; busy: boolean; error: string; pauseError: string }>({
  status: undefined, analysisHidden: readPreference(HIDDEN_PREFERENCE) === HIDDEN, coverage: undefined, busy: false, error: '', pauseError: '',
})
const bridge = () => window.musicJobs

export const analysisPaused = (status = jobs.status) => !!status?.paused?.includes(ANALYSE)
/** The analysis batch on screen: how many of the queued tracks are through, or undefined when none is waiting. */
export function analysisProgress(status = jobs.status) {
  const progress = status?.classes[ANALYSE]
  if (!progress || !(progress.queued + progress.running)) return undefined
  const finished = progress.done + progress.failed
  return { finished, total: finished + progress.queued + progress.running }
}

/** Short text for what is being worked on, or undefined when nothing is. A hidden analysis is left out. */
export function jobsSummary(status: JobsStatus | undefined, { analysisHidden = false } = {}): string | undefined {
  if (!status) return undefined
  const parts: string[] = []
  for (const [name, progress] of Object.entries(status.classes)) {
    const remaining = progress.queued + progress.running
    if (!remaining || (name === ANALYSE && analysisHidden)) continue
    const total = remaining + progress.done + progress.failed
    const label = name === ANALYSE && analysisPaused(status) ? 'Analysis paused' : LABELS[name] ?? name
    parts.push(`${label} ${progress.done + progress.failed} / ${total}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

/** Follows the desktop's job progress. Returns a function that stops following. */
export function followJobs() {
  const jobsBridge = bridge()
  if (!jobsBridge) return () => {}
  let stopped = false
  void jobsBridge.status().then(status => { if (!stopped && !jobs.status) jobs.status = status }, () => {})
  const unwatch = jobsBridge.onChange(status => { jobs.status = status })
  return () => { stopped = true; unwatch() }
}

export function setAnalysisHidden(hidden: boolean) {
  jobs.analysisHidden = hidden
  writePreference(HIDDEN_PREFERENCE, hidden ? HIDDEN : 'shown')
}

// One control at a time: a click while another is on its way is ignored, and its failure is shown.
async function control<T>(task: (jobsBridge: NonNullable<ReturnType<typeof bridge>>) => Promise<T>, publish: (value: T) => void, onError?: (message: string) => void) {
  const jobsBridge = bridge()
  if (!jobsBridge || jobs.busy) return
  jobs.busy = true
  jobs.error = ''
  try {
    publish(await task(jobsBridge))
  } catch (error) {
    jobs.error = error instanceof Error ? error.message : String(error)
    onError?.(jobs.error)
  } finally {
    jobs.busy = false
  }
}
export const pauseAnalysis = (paused: boolean) => control(jobsBridge => {
  jobs.pauseError = ''
  return jobsBridge.pauseAnalysis(paused)
}, status => { jobs.status = status }, message => { jobs.pauseError = message })

// Reads and resets share ownership of coverage. A reset invalidates older reads and any reads made during it.
let coverageRequest = 0
export const restartAnalysis = () => control(async jobsBridge => {
  coverageRequest++
  try { return await jobsBridge.restartAnalysis() }
  finally { coverageRequest++ }
}, coverage => { jobs.coverage = coverage })

export async function loadCoverage() {
  const jobsBridge = bridge()
  if (!jobsBridge) return
  const mine = ++coverageRequest
  try {
    const coverage = await jobsBridge.analysisCoverage()
    if (mine === coverageRequest) jobs.coverage = coverage
  } catch (error) {
    if (mine === coverageRequest) jobs.error = error instanceof Error ? error.message : String(error)
  }
}
