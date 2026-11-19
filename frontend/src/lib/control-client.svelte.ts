import { untrack } from 'svelte'
import { readJsonPreference, writePreference } from './preferences'
import { coverUrl, session } from './api.svelte'
import { disposePlayback, player, remote } from './player.svelte'
import type { ControlCommand, ControlState } from './control-host.svelte'
import type { ShareMode } from './sharing.svelte'

export const control = $state<{ mode: '' | ShareMode; connected: boolean; host: boolean }>({ mode: '', connected: false, host: false })
const KEY = 'share.phone'
const RETRY_MS = 3000
type Remembered = { mode: ShareMode; password: string }

export function rememberShare(mode: ShareMode, password: string) {
  writePreference(KEY, JSON.stringify({ mode, password } satisfies Remembered))
  control.mode = mode
}
export function setShareMode(mode: ShareMode) {
  const saved = readJsonPreference<Remembered | undefined>(KEY, undefined)
  if (saved) rememberShare(mode, saved.password)
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
function applyState(state: ControlState) {
  if (state.queue) {
    player.queue = state.queue.map(({ origin, ...track }) => ({
      ...track, cover: coverUrl(track.coverId),
      playbackOrigin: origin ? { ...origin, cover: coverUrl(origin.coverId) } : undefined,
    }))
  }
  player.index = state.index
  player.playing = state.playing
  player.pending = state.pending
  player.suspended = false
  player.time = state.time
  player.duration = state.duration
  player.volume = state.volume
  player.order = state.order
  player.error = state.error
  player.loadingCollectionId = state.loadingCollectionId
}
export function startControlClient(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (window.desktop) return () => {}
  const saved = readJsonPreference<Remembered | undefined>(KEY, undefined)
  if (saved?.mode) control.mode = saved.mode
  let ws: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const unavailable = () => {
    control.connected = false
    control.host = false
    player.playing = false
    player.pending = false
    player.loadingCollectionId = ''
  }
  const send = (command: ControlCommand) => {
    if (ws?.readyState !== WebSocket.OPEN || !control.host) {
      player.error = 'The computer is disconnected. Reconnect before changing playback.'
      return
    }
    player.error = ''
    ws.send(JSON.stringify(command))
  }
  const leave = () => {
    clearTimeout(retry)
    retry = undefined
    const old = ws
    ws = undefined
    old?.close()
    unavailable()
  }
  const connect = () => {
    const password = readJsonPreference<Remembered | undefined>(KEY, undefined)?.password
    if (!password) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const mine = socket(`${protocol}://${location.host}/control?p=${encodeURIComponent(password)}`)
    ws = mine
    mine.onopen = () => { if (ws === mine) control.connected = true }
    mine.onmessage = event => {
      if (ws !== mine) return
      let message: { type: string; connected?: boolean; state?: ControlState }
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.type === 'host') {
        control.host = !!message.connected
        if (message.state) applyState(message.state)
        else { player.playing = false; player.pending = false }
      } else if (message.type === 'state' && message.state) {
        control.host = true
        applyState(message.state)
      }
    }
    mine.onclose = () => {
      if (ws !== mine) return
      ws = undefined
      unavailable()
      retry = setTimeout(connect, RETRY_MS)
    }
  }
  const stop = $effect.root(() => {
    $effect(() => {
      if (control.mode !== 'control' || !session.api) return
      untrack(() => {
        // Invalidate local async work and release its media resources before remote state takes ownership.
        disposePlayback()
        player.visOpen = false
        resetPlayer()
        remote.send = send
        connect()
      })
      return () => {
        delete remote.send
        leave()
        untrack(resetPlayer)
      }
    })
  })
  return stop
}
