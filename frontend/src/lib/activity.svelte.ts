import { ACTIVITY_PAGE } from './catalog'
import type { ActivityEntry } from './activity'

/**
 * The Activity list of the identity spine: what changed, newest first, each with an Undo.
 * Desktop only. A load or an undo that fails keeps the list that was last shown.
 */
const LOAD_ERROR = 'The activity list could not be loaded.'
const UNDO_ERROR = 'That change could not be undone. Nothing was changed.'
const BLOCKED = {
  'has-dependents': 'A later change builds on this one. Undo that first.',
  'changed-since': 'This was changed again since, so it was left as it is.',
  'nothing-to-undo': 'There is nothing left to undo.',
} as const
export const activity = $state({ entries: [] as ActivityEntry[], total: 0, loadingOlder: false, error: '' })
// Every load takes a turn, and only the latest may change what is shown.
let turn = 0
let pendingUndo: symbol | undefined

export async function loadActivity(older = false) {
  const bridge = window.musicCatalog
  if (!bridge || pendingUndo) return
  const mine = ++turn
  const shown = activity.entries
  activity.loadingOlder ||= older
  try {
    // Append from the existing boundary while the ledger is unchanged. New receipts shift offsets,
    // so rebuild the loaded window if the count changed since those rows were loaded.
    const offset = older ? shown.length : 0
    const first = await bridge.activity({ offset })
    if (mine !== turn) return
    const append = older && first.total === activity.total
    const page = older && !append ? await bridge.activity() : first
    if (mine !== turn) return
    const { total } = page
    const keepOlder = shown.length > ACTIVITY_PAGE || activity.loadingOlder
    const added = keepOlder ? Math.max(0, total - activity.total) : 0
    const target = Math.max(shown.length + added, ACTIVITY_PAGE) + (activity.loadingOlder ? ACTIVITY_PAGE : 0)
    const entries = append ? [...shown, ...page.entries] : [...page.entries]
    while (entries.length < Math.min(target, total)) {
      const next = await bridge.activity({ offset: entries.length, limit: Math.min(ACTIVITY_PAGE, target - entries.length) })
      if (mine !== turn) return
      // A changing total invalidates offsets across these reads. Keep the last complete view.
      if (next.total !== total || !next.entries.length) throw new Error(LOAD_ERROR)
      entries.push(...next.entries)
    }
    activity.entries = entries
    activity.total = total
    if (activity.error === LOAD_ERROR) activity.error = ''
  } catch {
    if (mine === turn && !activity.error) activity.error = LOAD_ERROR
  } finally {
    if (mine === turn) activity.loadingOlder = false
  }
}

export function loadOlderActivity() {
  if (!activity.loadingOlder && activity.entries.length < activity.total) return loadActivity(true)
}

/**
 * Marks the entry undone at once, then shows what the library actually did.
 * With `operation`, only that part of the change is undone.
 */
export async function undoActivity(id: string, operation?: number) {
  const bridge = window.musicCatalog, entry = activity.entries.find(item => item.id === id)
  const part = operation === undefined ? undefined : entry?.operations?.find(item => item.index === operation)
  if (!bridge || !entry || entry.undone || pendingUndo || (operation !== undefined && (!part || part.undone))) return
  const undo = Symbol()
  pendingUndo = undo
  turn++
  activity.error = ''
  const mark = (undone: boolean) => {
    const shown = activity.entries.find(item => item.id === id), shownPart = shown?.operations?.find(item => item.index === operation)
    if (shownPart) shownPart.undone = undone
    else if (shown && operation === undefined) shown.undone = undone
  }
  mark(true)
  let error = ''
  try {
    const result = await bridge.undo(operation === undefined ? { id } : { id, operations: [operation] })
    if (result.status === 'blocked') error = BLOCKED[result.reason]
  } catch { error = UNDO_ERROR }
  if (pendingUndo !== undo) return
  pendingUndo = undefined
  if (error) mark(false)
  activity.error = error
  await loadActivity()
}

export function resetActivity() {
  turn++
  pendingUndo = undefined
  activity.entries = []
  activity.total = 0
  activity.loadingOlder = false
  activity.error = ''
}
