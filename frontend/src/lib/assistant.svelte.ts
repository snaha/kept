import { tracksByOccurrence } from './catalog-source.svelte'
import type { Track } from './music'
import { enqueue, play } from './player.svelte'
import { randomId } from './random-id'

/** The optional assistant: the window sends text, the desktop process holds the key and calls the model. */
export type AssistantProvider = 'anthropic' | 'local'
export type AssistantStatus = {
  enabled: boolean; provider: AssistantProvider; model: string; models: Record<AssistantProvider, string>
  baseUrl: string; hasKey: boolean; canStoreKey: boolean; storeKeyReason?: string
}
// apiKey goes to the desktop process once and is not kept by the window.
type CredentialChange = { provider: AssistantProvider; apiKey?: string; clearKey?: boolean }
  | { provider?: AssistantProvider; apiKey?: never; clearKey?: never }
export type AssistantChange = { enabled?: boolean; model?: string; baseUrl?: string } & CredentialChange
export type AssistantQueueItem = { occurrenceId: string; albumId: string; title?: string; artist?: string; album?: string }
export type AssistantStep = { tool: string; ok: boolean; detail: string }
export type AssistantReply = { message: string; queue: AssistantQueueItem[]; steps: AssistantStep[] }

export const assistant = $state({
  open: false, busy: false, request: '', error: '', note: '',
  status: undefined as AssistantStatus | undefined,
  reply: undefined as AssistantReply | undefined,
  // The playable tracks of the reply, found in the library's catalog.
  tracks: [] as Track[],
})
const api = () => window.musicAssistant
export const assistantAvailable = () => typeof api()?.ask === 'function'

// Every ask has a generation: a late answer to an older one, or one the listener cancelled, publishes nothing.
let generation = 0
let activeId = ''
let opener: HTMLElement | undefined

export async function loadAssistantStatus() {
  try { assistant.status = await api()?.status() } catch (error) { assistant.error = error instanceof Error ? error.message : String(error) }
}
/** Opens the bar. Only called from a user action; the opener gets focus back when it closes. */
export function openAssistant(from?: Element | null) {
  if (!assistantAvailable()) return
  opener = from instanceof HTMLElement ? from : undefined
  assistant.open = true
  void loadAssistantStatus()
}
export function closeAssistant() { assistant.open = false }
export function disposeAssistant() {
  cancelAssistant()
  closeAssistant()
  opener = undefined
}
/** Focus goes back to whatever opened the bar, if it is still there, without scrolling. */
export function restoreAssistantFocus() {
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  opener = undefined
}
export async function saveAssistantSettings(change: AssistantChange) {
  const saved = await api()?.save(change)
  if (saved) assistant.status = saved
  return saved
}

export async function askAssistant(text: string) {
  const request = text.trim()
  if (!request || !api()) return
  const mine = ++generation
  const id = randomId()
  if (assistant.busy) void api()?.cancel(activeId).catch(() => {})
  activeId = id
  assistant.busy = true; assistant.error = ''; assistant.note = ''
  try {
    const reply = await api()!.ask({ request, id })
    if (mine !== generation) return
    // The previous answer stays until this one replaces it, in one step.
    const tracks = await tracksByOccurrence(reply.queue)
    if (mine !== generation) return
    assistant.reply = reply; assistant.tracks = tracks
  } catch (error) {
    if (mine === generation) assistant.error = error instanceof Error ? error.message : String(error)
  } finally { if (mine === generation) assistant.busy = false }
}
export function cancelAssistant() {
  if (!assistant.busy) return
  generation++
  assistant.busy = false
  void api()?.cancel(activeId).catch(() => {})
}

export const playableAssistantTracks = () => assistant.tracks.filter(track => track.available !== false)
/** Plays the reply from the first track. Returns false, saying why, when nothing in it can play. */
export function playAssistantQueue() {
  const tracks = playableAssistantTracks()
  if (!tracks.length) { assistant.note = 'None of these tracks can be played right now.'; return false }
  assistant.note = ''
  play(tracks, 0)
  return true
}
export function addAssistantQueue() {
  const tracks = playableAssistantTracks()
  if (!tracks.length) { assistant.note = 'None of these tracks can be played right now.'; return false }
  enqueue(tracks)
  assistant.note = `Added ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} to the queue.`
  return true
}
