/** How far the desktop's background work has got: `hash` reads every file once to give it a lasting identity. */
export type JobClassProgress = { queued: number; running: number; done: number; failed: number }
export type JobsStatus = { mode: 'idle' | 'playing' | 'hold'; classes: Record<string, JobClassProgress> }

const LABELS: Record<string, string> = { hash: 'reading files', reconstruct: 'repairing albums' }
export const jobs = $state<{ status: JobsStatus | undefined }>({ status: undefined })

/** Short text for what is being worked on, or undefined when nothing is. */
export function jobsSummary(status: JobsStatus | undefined): string | undefined {
  if (!status) return undefined
  const parts: string[] = []
  for (const [name, progress] of Object.entries(status.classes)) {
    const remaining = progress.queued + progress.running
    if (!remaining) continue
    const total = remaining + progress.done + progress.failed
    parts.push(`${LABELS[name] ?? name} ${progress.done + progress.failed} / ${total}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

/** Follows the desktop's job progress. Returns a function that stops following. */
export function followJobs() {
  const bridge = window.musicJobs
  if (!bridge) return () => {}
  let stopped = false
  void bridge.status().then(status => { if (!stopped && !jobs.status) jobs.status = status }, () => {})
  const unwatch = bridge.onChange(status => { jobs.status = status })
  return () => { stopped = true; unwatch() }
}
