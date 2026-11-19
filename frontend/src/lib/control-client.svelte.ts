import { untrack } from 'svelte'
import { readPreference, writePreference } from './preferences'
import { coverUrl, session } from './api.svelte'
import { disposePlayback, player, remote } from './player.svelte'
import { MAX_COMMAND_ITEMS, TRACK_LIMIT_ERROR, type ControlCommand, type ControlTrack, type ControlState } from './control-host.svelte'
import type { ShareMode } from './sharing.svelte'

export const control = $state({
  mode: 'library' as ShareMode,
  connected: false,
  host: false,
  get active() { return this.mode === 'control' && !!session.controlSecret },
})
const KEY = 'share.phone'
const RETRY_MS = 3000

export function setShareMode(mode: ShareMode) {
  if (!session.controlSecret) return
  writePreference(KEY, mode)
  control.mode = mode
}
function resetPlayer() {
  player.queue = []
  player.index = -1
  player.playing = false
  player.pending = false
  player.suspended = false
  player.order = 'normal'
  player.error = ''
  player.time = 0
  player.duration = 0
  player.loadingCollectionId = ''
}
function applyState(state: ControlState, preserveError: boolean) {
  player.index = state.entryId && player.queue[state.index]?.queueEntryId === state.entryId ? state.index : -1
  player.playing = state.playing
  player.pending = state.pending
  player.suspended = false
  player.time = state.time
  player.duration = state.duration
  player.volume = state.volume
  player.order = state.order
  if (!preserveError) player.error = state.error
  player.loadingCollectionId = state.loadingCollectionId
}
export function startControlClient(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (window.desktop) return () => {}
  control.mode = readPreference(KEY) === 'control' ? 'control' : 'library'
  let ws: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let trackLimitRejected = false
  let queueParts: string[] | undefined
  let appliedQueueRevision: number | undefined
  let latest: ControlState | undefined
  const updateTransport = (state: ControlState) => applyState(state, trackLimitRejected && player.error === TRACK_LIMIT_ERROR)
  const receiveState = (state: ControlState) => {
    if (!Number.isSafeInteger(state.queueRevision)) return
    if (latest?.queueRevision !== state.queueRevision) queueParts = undefined
    latest = state
    if (appliedQueueRevision === state.queueRevision) updateTransport(state)
  }
  const clearSnapshot = () => {
    queueParts = undefined
    appliedQueueRevision = undefined
    latest = undefined
    player.playing = false
    player.pending = false
    player.loadingCollectionId = ''
  }
  const unavailable = () => {
    clearSnapshot()
    control.connected = false
    control.host = false
  }
  const send = (command: ControlCommand) => {
    if (ws?.readyState !== WebSocket.OPEN || !control.host) {
      player.error = 'The computer is disconnected. Reconnect before changing playback.'
      return
    }
    if (command.name === 'seek' && (!command.entryId || !latest || latest.queueRevision !== appliedQueueRevision)) return
    trackLimitRejected = false
    if ((command.name === 'tracks' || command.name === 'queue' || command.name === 'history') && command.tracks.length > MAX_COMMAND_ITEMS) {
      trackLimitRejected = true
      player.error = TRACK_LIMIT_ERROR
      return
    }
    player.error = ''
    ws.send(JSON.stringify(command))
  }
  const leave = () => {
    clearTimeout(retry)
    retry = undefined
    trackLimitRejected = false
    const old = ws
    ws = undefined
    old?.close()
    unavailable()
  }
  const connect = (secret: string) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const mine = socket(`${protocol}://${location.host}/control?c=${encodeURIComponent(secret)}`)
    ws = mine
    mine.onopen = () => { if (ws === mine) control.connected = true }
    mine.onmessage = event => {
      if (ws !== mine) return
      let message: { type: string; connected?: boolean; state?: ControlState; queueRevision?: number; first?: boolean; complete?: boolean; part?: string }
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.type === 'host') {
        clearSnapshot()
        control.host = !!message.connected
        if (message.state) receiveState(message.state)
      } else if (message.type === 'state' && message.state) {
        control.host = true
        receiveState(message.state)
      } else if (message.type === 'queue' && typeof message.part === 'string') {
        if (!latest || message.queueRevision !== latest.queueRevision) return
        if (message.first) queueParts = []
        if (!queueParts) return
        queueParts.push(message.part)
        if (!message.complete) return
        const serialized = queueParts.join('')
        queueParts = undefined
        try {
          const tracks: ControlTrack[] = JSON.parse(serialized)
          if (tracks.length !== latest.queueLength) return
          player.queue = tracks.map(({ origin, ...track }) => ({
            ...track, cover: coverUrl(track.coverId),
            playbackOrigin: origin ? { ...origin, cover: coverUrl(origin.coverId) } : undefined,
          }))
          appliedQueueRevision = latest.queueRevision
          updateTransport(latest)
        } catch { /* A later snapshot can still replace the queue. */ }
      }
    }
    mine.onclose = () => {
      if (ws !== mine) return
      ws = undefined
      unavailable()
      retry = setTimeout(() => connect(secret), RETRY_MS)
    }
  }
  const stop = $effect.root(() => {
    $effect(() => {
      const secret = session.controlSecret
      if (!control.active || !session.api || !secret) return
      const localVolume = untrack(() => player.volume)
      untrack(() => {
        // Invalidate local async work and release its media resources before remote state takes ownership.
        disposePlayback()
        player.visOpen = false
        resetPlayer()
        remote.send = send
        connect(secret)
      })
      return () => {
        delete remote.send
        leave()
        untrack(() => {
          resetPlayer()
          player.volume = localVolume
        })
      }
    })
  })
  return stop
}
