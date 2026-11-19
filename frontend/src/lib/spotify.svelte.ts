import { spotifyTrack, type SpotifySearchResult } from './spotify-track'
import type { Track } from './music'
import type { SpotifyCommands } from './spotify-adapter'

export type SpotifyStatus = { connected: boolean; account: string; clientId: string; deviceId: string; deviceName: string; error: string }
export type SpotifyDevice = { id: string; name: string; type: string }
export type SpotifyBridge = SpotifyCommands & {
  status(): Promise<SpotifyStatus>
  connect(clientId: string): Promise<SpotifyStatus>
  disconnect(): Promise<SpotifyStatus>
  devices(): Promise<SpotifyDevice[]>
  selectDevice(id: string): Promise<SpotifyStatus>
  search(query: string): Promise<SpotifySearchResult[]>
  onChange(callback: (status: SpotifyStatus) => void): () => void
}

// Off by default: Spotify exists only in the desktop app, only after the user signs in with their own client ID.
export const spotify = $state({
  available: false, connected: false, account: '', clientId: '', deviceId: '', deviceName: '', error: '',
  devicesError: '',
  devices: [] as SpotifyDevice[], results: [] as Track[], busy: false, connecting: false, signingOut: false, findingDevices: false,
})
export const spotifyBridge = (): SpotifyBridge | undefined => (window as unknown as { musicSpotify?: SpotifyBridge }).musicSpotify
export const spotifyReady = () => spotify.connected && !!spotify.deviceId && !spotify.signingOut

let deviceSearch = 0
const apply = (status: SpotifyStatus) => {
  const accountChanged = status.account !== spotify.account
  spotify.connected = status.connected
  spotify.account = status.account
  spotify.clientId = status.clientId
  spotify.deviceId = status.deviceId
  spotify.deviceName = status.deviceName
  spotify.error = status.error
  if (!status.connected || accountChanged) {
    deviceSearch++
    spotify.findingDevices = false
    spotify.devicesError = ''
    spotify.devices = []
    spotify.results = []
  }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const failure = (error: unknown) => { spotify.error = errorMessage(error) }

export function initSpotify() {
  const bridge = spotifyBridge()
  spotify.available = !!bridge
  if (!bridge) return () => {}
  const dispose = bridge.onChange(apply)
  bridge.status().then(apply).catch(failure)
  return dispose
}
let operation = 0
async function run<T>(task: (bridge: SpotifyBridge) => Promise<T>, publish: (value: T) => void, { connecting = false, signingOut = false, supersede = false } = {}) {
  const bridge = spotifyBridge()
  if (!bridge || (spotify.busy && !supersede)) return
  const mine = ++operation
  spotify.busy = true
  spotify.connecting = connecting
  spotify.signingOut = signingOut
  spotify.error = ''
  try {
    const value = await task(bridge)
    if (mine !== operation) return
    publish(value)
    return true
  } catch (error) {
    if (mine === operation) failure(error)
  } finally {
    if (mine === operation) {
      spotify.busy = false
      spotify.connecting = false
      spotify.signingOut = false
    }
  }
}
export const connectSpotify = async (clientId: string) => {
  const connected = await run(bridge => bridge.connect(clientId.trim()), apply, { connecting: true })
  if (connected) await refreshSpotifyDevices()
}
// The player gives up what Spotify was playing before the sign-in is dropped: no poll or command outlives the token.
let release: (() => Promise<void>) | undefined
export const onSpotifySignOut = (handler: (() => Promise<void>) | undefined) => { release = handler }
export const disconnectSpotify = () => run(async bridge => {
  await release?.()
  return bridge.disconnect()
}, apply, { signingOut: true })
export const cancelSpotifySignIn = () => run(bridge => bridge.disconnect(), apply, { supersede: true })
// Finding devices runs beside other Spotify work, so it never disables the picker. The latest search lands,
// and none lands after sign-out.
export async function refreshSpotifyDevices() {
  const bridge = spotifyBridge()
  if (!bridge || !spotify.connected) return
  const mine = ++deviceSearch
  spotify.findingDevices = true
  try {
    const devices = await bridge.devices()
    if (mine === deviceSearch) {
      spotify.devices = devices
      spotify.devicesError = ''
    }
  } catch (error) {
    if (mine === deviceSearch) spotify.devicesError = errorMessage(error)
  } finally {
    if (mine === deviceSearch) spotify.findingDevices = false
  }
}
export const chooseSpotifyDevice = (id: string) => run(bridge => bridge.selectDevice(id), apply)
export const searchSpotify = (query: string) => run(bridge => bridge.search(query), results => { spotify.results = results.map(spotifyTrack) })
