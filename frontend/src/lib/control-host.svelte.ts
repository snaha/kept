import { desktop } from './desktop.svelte'
import { coverUrl } from './api.svelte'
import { player, enqueue, next, play, prev, toggle, pause, setVolume, seek, setOrder, jumpRandom, jump, moveQueue, removeQueue, cancelCollectionLoading, isQueuePermutation, replayQueue, type Order } from './player.svelte'
import { pick, addCollection, gridFor, type Tile } from './library.svelte'
import type { Track } from './music'

type Origin = NonNullable<Track['playbackOrigin']>
export type ControlTrack = Omit<Track, 'cover' | 'playbackOrigin' | 'albumInfo' | 'origins'> & {
  origin?: Omit<Origin, 'cover'> & { coverId?: string }
}
type PlaybackState = {
  playing: boolean
  pending: boolean
  time: number
  duration: number
  volume: number
  index: number
  entryId?: string
  queueLength: number
  order: Order
  error: string
  loadingCollectionId: string
}
export type ControlState = PlaybackState & { queueRevision: number }
export type ControlCommand =
  | { type: 'command'; name: 'toggle' | 'next' | 'prev' | 'pause' | 'cancel' }
  | { type: 'command'; name: 'volume'; value: number }
  | { type: 'command'; name: 'seek'; value: number; entryId: string }
  | { type: 'command'; name: 'play' | 'add'; collection: Tile }
  | { type: 'command'; name: 'queue'; tracks: Track[] }
  | { type: 'command'; name: 'tracks'; tracks: Track[]; index: number }
  | { type: 'command'; name: 'history'; tracks: Track[]; index: number; order: Order; permutation: number[] }
  | { type: 'command'; name: 'jump' | 'remove'; entryId: string }
  | { type: 'command'; name: 'move'; entryId: string; targetId: string }
  | { type: 'command'; name: 'order'; order: Order; collections: Tile[] }
  | { type: 'command'; name: 'random'; collections: Tile[] }

const RETRY_MS = 3000
// JSON escaping takes at most six bytes per UTF-16 code unit. Leave room for the envelope.
const QUEUE_PART_LENGTH = 32 * 1024
const HOST_REPLACED_CODE = 4000
export const MAX_COMMAND_ITEMS = 10000
const MAX_RANDOM_TRACKS = 1000000
const TRACK_COVER_SIZE = 512
export const TRACK_LIMIT_ERROR = `The computer accepts up to ${MAX_COMMAND_ITEMS} tracks at a time. Choose fewer tracks.`
const text = (value: unknown) => typeof value === 'string' && value.length > 0
const optionalText = (value: unknown) => typeof value === 'string' ? value : undefined
const optionalNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const isOrder = (value: unknown): value is Order => value === 'normal' || value === 'shuffle' || value === 'random'

function coverIdFromUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    return url.pathname === '/rest/getCoverArt' ? url.searchParams.get('id') ?? undefined : undefined
  } catch {
    return undefined
  }
}
function readOrigin(value: unknown): Origin | undefined {
  const origin = value as Origin
  if (!origin || typeof origin !== 'object' || !text(origin.id) || !text(origin.rawId) || origin.source !== 'local' || typeof origin.title !== 'string') return undefined
  if (origin.kind !== 'album' && origin.kind !== 'artist' && origin.kind !== 'playlist') return undefined
  return {
    id: origin.id, rawId: origin.rawId, source: origin.source, kind: origin.kind, title: origin.title,
    cover: coverUrl(coverIdFromUrl(origin.cover)),
  }
}
function readCollection(value: unknown): Tile | undefined {
  const origin = readOrigin(value)
  const c = value as Tile
  if (!origin || !Number.isSafeInteger(c.count) || c.count < 0 || c.count > MAX_RANDOM_TRACKS || typeof c.available !== 'boolean') return undefined
  return { ...origin, count: c.count, available: c.available, sub: optionalText(c.sub) ?? '', indexing: c.indexing === true }
}
function readTrack(value: unknown): Track | undefined {
  const t = value as Track
  if (!t || typeof t !== 'object' || !text(t.id) || !text(t.rawId) || t.source !== 'local' || typeof t.title !== 'string' || typeof t.available !== 'boolean') return undefined
  const coverId = optionalText(t.coverId)
  return {
    id: t.id, rawId: t.rawId, source: t.source, title: t.title, available: t.available,
    artist: optionalText(t.artist), album: optionalText(t.album), albumId: optionalText(t.albumId),
    coverId, cover: coverUrl(coverId, TRACK_COVER_SIZE),
    duration: optionalNumber(t.duration), track: optionalNumber(t.track), disc: optionalNumber(t.disc),
    playbackOrigin: readOrigin(t.playbackOrigin), playbackOriginIndex: optionalNumber(t.playbackOriginIndex),
  }
}
function readItems<T>(value: unknown, readItem: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ITEMS) return undefined
  const items: T[] = []
  for (const item of value) {
    const parsed = readItem(item)
    if (!parsed) return undefined
    items.push(parsed)
  }
  return items
}
function playableScope(collections: Tile[]) {
  const count = collections.filter(tile => tile.available).reduce((sum, tile) => sum + Math.max(1, tile.count), 0)
  if (!count) { player.error = 'No playable music matches the phone’s view.'; return false }
  if (count > MAX_RANDOM_TRACKS) { player.error = 'This selection is too large for random playback. Narrow the phone’s filters.'; return false }
  return true
}
function wireTrack(track: Track): ControlTrack {
  const origin = track.playbackOrigin
  return {
    id: track.id, rawId: track.rawId, source: track.source, title: track.title, artist: track.artist,
    album: track.album, albumId: track.albumId, coverId: track.coverId, duration: track.duration,
    track: track.track, disc: track.disc, available: track.available,
    queueEntryId: track.queueEntryId, playbackOriginIndex: track.playbackOriginIndex,
    origin: origin ? { id: origin.id, rawId: origin.rawId, source: origin.source, kind: origin.kind, title: origin.title, coverId: coverIdFromUrl(origin.cover) } : undefined,
  }
}
function controlState(time = Math.floor(player.time)): PlaybackState {
  return {
    playing: player.playing, pending: player.pending || player.randomRequesting,
    time, duration: Math.round(player.duration), volume: player.volume,
    index: player.index, entryId: player.song?.queueEntryId, queueLength: player.queue.length, order: player.order,
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
    case 'play':
    case 'add': {
      const collection = readCollection(c.collection)
      if (!collection) return
      if (c.name === 'add') return void addCollection(collection, { revealQueue: false })
      if (collection.kind !== 'artist') void pick(collection)
      return
    }
    case 'queue':
    case 'tracks':
    case 'history': {
      if (Array.isArray(c.tracks) && c.tracks.length > MAX_COMMAND_ITEMS) {
        player.error = TRACK_LIMIT_ERROR
        return
      }
      const tracks = readItems(c.tracks, readTrack)
      if (!tracks) return
      if (c.name !== 'queue' && (!Number.isInteger(c.index) || c.index < 0 || c.index >= tracks.length)) return
      if (c.name === 'history' && (!isOrder(c.order) || !isQueuePermutation(c.permutation, c.order === 'shuffle' ? tracks.length : 0))) return
      if (player.error === TRACK_LIMIT_ERROR) player.error = ''
      if (c.name === 'queue') return enqueue(tracks, { revealQueue: false })
      if (c.name === 'history') return void replayQueue(tracks, c.index, c.order, c.permutation)
      return void play(tracks, c.index)
    }
    case 'jump': { const index = position(c.entryId); if (index >= 0) jump(index); return }
    case 'remove': { const index = position(c.entryId); if (index >= 0) removeQueue(index); return }
    case 'move': { const from = position(c.entryId), to = position(c.targetId); if (from >= 0 && to >= 0) moveQueue(from, to); return }
    case 'order':
    case 'random': {
      if (c.name === 'order' && !isOrder(c.order)) return
      const collections = readItems(c.collections, readCollection)
      if (!collections) return
      if ((c.name === 'random' || c.order === 'random') && !playableScope(collections)) return
      const grid = () => gridFor(collections)
      return c.name === 'order' ? setOrder(c.order, grid) : jumpRandom(grid, { replaceScope: true })
    }
  }
}

export function startControlHost(socket: (url: string) => WebSocket = url => new WebSocket(url)) {
  if (!window.desktop) return () => {}
  let ws: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let url = ''
  let lastQueue: ControlTrack[] | undefined
  let queueRevision = 0
  let latest: { state: PlaybackState; queue: ControlTrack[] } | undefined
  const close = () => {
    clearTimeout(retry)
    retry = undefined
    const old = ws
    ws = undefined
    old?.close()
  }
  const publish = (state: PlaybackState, queue: ControlTrack[]) => {
    latest = { state, queue }
    if (ws?.readyState !== WebSocket.OPEN) return
    const queueChanged = queue !== lastQueue
    if (queueChanged) queueRevision++
    // The relay and phone establish the new revision before receiving its chunks.
    ws.send(JSON.stringify({ type: 'state', state: { ...state, queueRevision } }))
    if (!queueChanged) return
    lastQueue = queue
    const serialized = JSON.stringify(queue)
    for (let offset = 0; offset < serialized.length; offset += QUEUE_PART_LENGTH) {
      const end = offset + QUEUE_PART_LENGTH
      ws.send(JSON.stringify({
        type: 'queue', queueRevision, first: offset === 0, complete: end >= serialized.length, part: serialized.slice(offset, end),
      }))
    }
  }
  const connect = () => {
    if (!url) return
    const mine = socket(url)
    ws = mine
    lastQueue = undefined
    mine.onopen = () => {
      if (ws !== mine) return
      if (latest) publish(latest.state, latest.queue)
      else publish(controlState(), player.queue.map(wireTrack))
    }
    mine.onmessage = event => {
      if (ws !== mine) return
      try { applyCommand(JSON.parse(String(event.data))) } catch { player.error = 'The remote command could not be applied. Please try again.' }
    }
    mine.onclose = event => { if (ws !== mine) return; ws = undefined; if (event?.code !== HOST_REPLACED_CODE) retry = setTimeout(connect, RETRY_MS) }
  }
  const stop = $effect.root(() => {
    const queue = $derived(player.queue.map(wireTrack))
    const time = $derived(Math.floor(player.time))
    const state = $derived(controlState(time))
    $effect(() => {
      const status = desktop.status
      const next = status?.phase === 'ready' && status.share ? `ws://127.0.0.1:${status.share.webPort}/control?h=${encodeURIComponent(status.password)}` : ''
      if (next === url) return
      url = next
      close()
      connect()
    })
    $effect(() => publish(state, queue))
  })
  return () => { stop(); url = ''; close() }
}
