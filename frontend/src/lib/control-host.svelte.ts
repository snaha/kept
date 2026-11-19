import { desktop } from './desktop.svelte'
import { player, enqueue, next, play, prev, toggle, pause, setVolume, seek, setOrder, jumpRandom, jump, moveQueue, removeQueue, cancelCollectionLoading, type Order } from './player.svelte'
import { pick, addCollection, gridFor, type Tile } from './library.svelte'
import type { Track } from './music'

type Origin = NonNullable<Track['playbackOrigin']>
export type ControlTrack = Omit<Track, 'cover' | 'playbackOrigin' | 'albumInfo' | 'origins'> & {
  origin?: Omit<Origin, 'cover'> & { coverId?: string }
}
export type ControlState = {
  queue?: ControlTrack[]
  playing: boolean
  pending: boolean
  time: number
  duration: number
  volume: number
  index: number
  queueLength: number
  order: Order
  error: string
  loadingCollectionId: string
}
export type ControlCommand =
  | { type: 'command'; name: 'toggle' | 'next' | 'prev' | 'pause' | 'cancel' }
  | { type: 'command'; name: 'volume'; value: number }
  | { type: 'command'; name: 'seek'; value: number; entryId: string }
  | { type: 'command'; name: 'play' | 'add'; collection: Tile }
  | { type: 'command'; name: 'queue'; tracks: Track[] }
  | { type: 'command'; name: 'tracks'; tracks: Track[]; index: number }
  | { type: 'command'; name: 'jump' | 'remove'; entryId: string }
  | { type: 'command'; name: 'move'; entryId: string; targetId: string }
  | { type: 'command'; name: 'order'; order: Order; collections: Tile[] }
  | { type: 'command'; name: 'random'; collections: Tile[] }

const RETRY_MS = 3000
const HOST_REPLACED_CODE = 4000
const MAX_COMMAND_ITEMS = 10000
const MAX_RANDOM_TRACKS = 1000000
const text = (value: unknown) => typeof value === 'string' && value.length > 0
const isCollection = (value: unknown): value is Tile => {
  const c = value as Tile
  return !!c && typeof c === 'object' && text(c.id) && text(c.rawId) && c.source === 'local' && ['album', 'artist', 'playlist'].includes(c.kind) && typeof c.title === 'string' && Number.isSafeInteger(c.count) && c.count >= 0 && c.count <= MAX_RANDOM_TRACKS && typeof c.available === 'boolean'
}
const isTrack = (value: unknown): value is Track => {
  const t = value as Track
  return !!t && typeof t === 'object' && text(t.id) && text(t.rawId) && t.source === 'local' && typeof t.title === 'string' && typeof t.cover === 'string' && typeof t.available === 'boolean'
}
function items<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= MAX_COMMAND_ITEMS && value.every(guard)
}
function playableScope(collections: Tile[]) {
  const count = collections.filter(tile => tile.available).reduce((sum, tile) => sum + Math.max(1, tile.count), 0)
  if (!count) { player.error = 'No playable music matches the phone’s view.'; return false }
  if (count > MAX_RANDOM_TRACKS) { player.error = 'This selection is too large for random playback. Narrow the phone’s filters.'; return false }
  return true
}
function wireTrack(track: Track): ControlTrack {
  const origin = track.playbackOrigin
  let coverId: string | undefined
  try { coverId = origin?.cover ? new URL(origin.cover).searchParams.get('id') ?? undefined : undefined } catch { /* Non-local artwork has no portable ID. */ }
  return {
    id: track.id, rawId: track.rawId, source: track.source, title: track.title, artist: track.artist,
    album: track.album, albumId: track.albumId, coverId: track.coverId, duration: track.duration,
    track: track.track, disc: track.disc, available: track.available,
    queueEntryId: track.queueEntryId, playbackOriginIndex: track.playbackOriginIndex,
    origin: origin ? { id: origin.id, rawId: origin.rawId, source: origin.source, kind: origin.kind, title: origin.title, coverId } : undefined,
  }
}
export function controlState(queue = player.queue.map(wireTrack), time = Math.floor(player.time)): ControlState {
  return {
    queue, playing: player.playing, pending: player.pending || player.randomRequesting,
    time, duration: Math.round(player.duration), volume: player.volume,
    index: player.index, queueLength: queue.length, order: player.order,
    error: player.error, loadingCollectionId: player.loadingCollectionId,
  }
}
export function applyCommand(command: unknown) {
  const c = command as ControlCommand
  if (!c || typeof c !== 'object' || c.type !== 'command') return
  const position = (id: string) => text(id) ? player.queue.findIndex(track => track.queueEntryId === id) : -1
  switch (c.name) {
    case 'toggle': return void toggle()
    case 'pause': return void pause()
    case 'cancel': return cancelCollectionLoading()
    case 'next': return next()
    case 'prev': return prev()
    case 'volume': return Number.isFinite(c.value) ? setVolume(c.value) : undefined
    case 'seek': return Number.isFinite(c.value) && c.entryId === player.song?.queueEntryId ? void seek(c.value) : undefined
    case 'play': return isCollection(c.collection) ? void pick(c.collection) : undefined
    case 'add': return isCollection(c.collection) ? void addCollection(c.collection) : undefined
    case 'queue': return items(c.tracks, isTrack) ? enqueue(c.tracks) : undefined
    case 'tracks': return items(c.tracks, isTrack) && Number.isInteger(c.index) && c.index >= 0 && c.index < c.tracks.length ? void play(c.tracks, c.index) : undefined
    case 'jump': { const index = position(c.entryId); if (index >= 0) jump(index); return }
    case 'remove': { const index = position(c.entryId); if (index >= 0) removeQueue(index); return }
    case 'move': { const from = position(c.entryId), to = position(c.targetId); if (from >= 0 && to >= 0) moveQueue(from, to); return }
    case 'order':
      if (!['normal', 'shuffle', 'random'].includes(c.order) || !items(c.collections, isCollection)) return
      if (c.order === 'random' && !playableScope(c.collections)) return
      return setOrder(c.order, () => gridFor(c.collections))
    case 'random':
      if (!items(c.collections, isCollection)) return
      if (!playableScope(c.collections)) return
      return jumpRandom(() => gridFor(c.collections))
  }
}

export function startControlHost(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (!window.desktop) return () => {}
  let ws: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let url = ''
  let lastQueue: ControlTrack[] | undefined
  let latest: ControlState
  const close = () => {
    clearTimeout(retry)
    retry = undefined
    const old = ws
    ws = undefined
    old?.close()
  }
  const publish = (state: ControlState) => {
    latest = state
    if (ws?.readyState !== WebSocket.OPEN) return
    const queue = state.queue === lastQueue ? undefined : state.queue
    ws.send(JSON.stringify({ type: 'state', state: { ...state, queue } }))
    lastQueue = state.queue
  }
  const connect = () => {
    if (!url) return
    const mine = socket(url)
    ws = mine
    lastQueue = undefined
    mine.onopen = () => { if (ws === mine) publish(latest ?? controlState()) }
    mine.onmessage = event => {
      if (ws !== mine) return
      try { applyCommand(JSON.parse(String(event.data))) } catch { player.error = 'The remote command could not be applied. Please try again.' }
    }
    mine.onclose = event => { if (ws !== mine) return; ws = undefined; if (event?.code !== HOST_REPLACED_CODE) retry = setTimeout(connect, RETRY_MS) }
  }
  const stop = $effect.root(() => {
    const queue = $derived(player.queue.map(wireTrack))
    const time = $derived(Math.floor(player.time))
    const state = $derived(controlState(queue, time))
    $effect(() => {
      const status = desktop.status
      const next = status?.phase === 'ready' && status.share ? `ws://127.0.0.1:${status.share.webPort}/control?h=${encodeURIComponent(status.password)}` : ''
      if (next === url) return
      url = next
      close()
      connect()
    })
    $effect(() => publish(state))
  })
  return () => { stop(); url = ''; close() }
}
