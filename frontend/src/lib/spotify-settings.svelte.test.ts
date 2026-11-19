import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import SpotifySettings from './spotify-settings.svelte'
import { disconnectSpotify, refreshSpotifyDevices, spotify, type SpotifyBridge, type SpotifyDevice, type SpotifyStatus } from './spotify.svelte'

const KEPT_CLIENT_ID = 'b'.repeat(32)
const OWN_CLIENT_ID = 'c'.repeat(32)
const SIGNED_OUT: SpotifyStatus = { connected: false, deviceId: '', account: '', deviceName: '', clientId: '', error: '' }
const SIGNED_IN: SpotifyStatus = { ...SIGNED_OUT, connected: true, account: 'fixture-account', clientId: KEPT_CLIENT_ID }
const LAPTOP: SpotifyDevice = { id: 'fixture-laptop', name: 'Fixture laptop', type: 'Computer' }
const SPEAKER: SpotifyDevice = { id: 'fixture-speaker', name: 'Fixture speaker', type: 'Speaker' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let connect: ReturnType<typeof vi.fn<SpotifyBridge['connect']>>
beforeEach(() => {
  Object.assign(spotify, { ...SIGNED_OUT, busy: false, connecting: false, signingOut: false, findingDevices: false, devicesError: '', devices: [], results: [] })
  connect = vi.fn(async (clientId: string) => ({ ...SIGNED_OUT, connected: true, account: 'fixture-account', clientId }))
  vi.stubGlobal('musicSpotify', { connect, devices: async () => [] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!
const field = () => document.querySelector<HTMLInputElement>('input[placeholder^="32 characters"]')!

test('with a known client ID, signing in is one button and the client ID stays tucked away', async () => {
  spotify.clientId = KEPT_CLIENT_ID
  render(SpotifySettings)
  await tick()
  expect(field().checkVisibility()).toBe(false)
  button('Connect Spotify').click()
  await vi.waitFor(() => expect(connect).toHaveBeenCalledWith(KEPT_CLIENT_ID))
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('fixture-account'))
})

test('someone can still sign in with their own Spotify app', async () => {
  spotify.clientId = KEPT_CLIENT_ID
  render(SpotifySettings)
  await tick()
  document.querySelector('summary')!.click()
  await tick()
  const input = field()
  expect(input.checkVisibility()).toBe(true)
  input.value = ` ${OWN_CLIENT_ID} `
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  button('Connect Spotify').click()
  await vi.waitFor(() => expect(connect).toHaveBeenCalledWith(OWN_CLIENT_ID))
})

test('without a known client ID, the field is shown and Connect waits for it', async () => {
  render(SpotifySettings)
  await tick()
  expect(document.querySelector('details')).toBeNull()
  expect(field().checkVisibility()).toBe(true)
  expect(button('Connect Spotify').disabled).toBe(true)
})

const picker = () => document.querySelector<HTMLSelectElement>('.spotify select')!
const pickerOptions = () => [...picker().options].map(option => option.value).filter(Boolean)

test('signed in, the device picker is filled before it is opened and stays usable while devices load', async () => {
  Object.assign(spotify, SIGNED_IN)
  const answer = deferred<SpotifyDevice[]>()
  const devices = vi.fn(() => answer.promise)
  const selectDevice = vi.fn(async (id: string) => ({ ...SIGNED_IN, deviceId: id, deviceName: LAPTOP.name }))
  vi.stubGlobal('musicSpotify', { connect, devices, selectDevice })
  render(SpotifySettings)
  await tick()
  expect(devices).toHaveBeenCalledTimes(1)
  expect(picker().disabled).toBe(false)
  answer.resolve([LAPTOP, SPEAKER])
  await vi.waitFor(() => expect(pickerOptions()).toEqual([LAPTOP.id, SPEAKER.id]))

  picker().value = LAPTOP.id
  picker().dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(selectDevice).toHaveBeenCalledWith(LAPTOP.id))
  await vi.waitFor(() => expect(picker().value).toBe(LAPTOP.id))
})

test('Find devices picks up a device that started later, and a late answer after sign-out lands nowhere', async () => {
  Object.assign(spotify, SIGNED_IN)
  const answers = [deferred<SpotifyDevice[]>(), deferred<SpotifyDevice[]>(), deferred<SpotifyDevice[]>()]
  let call = 0
  const devices = vi.fn(() => answers[call++].promise)
  vi.stubGlobal('musicSpotify', { connect, devices, disconnect: async () => SIGNED_OUT })
  render(SpotifySettings)
  await tick()
  answers[0].resolve([LAPTOP])
  await vi.waitFor(() => expect(pickerOptions()).toEqual([LAPTOP.id]))

  button('Find devices').click()
  await vi.waitFor(() => expect(button('Finding devices…').disabled).toBe(true))
  answers[1].resolve([LAPTOP, SPEAKER])
  await vi.waitFor(() => expect(pickerOptions()).toEqual([LAPTOP.id, SPEAKER.id]))

  void refreshSpotifyDevices()
  await disconnectSpotify()
  answers[2].resolve([SPEAKER])
  await tick()
  expect(spotify.devices).toEqual([])
  expect(spotify.findingDevices).toBe(false)
})

test('Find devices clears its own alert after a successful retry', async () => {
  Object.assign(spotify, SIGNED_IN)
  const devices = vi.fn<SpotifyBridge['devices']>()
    .mockResolvedValueOnce([LAPTOP])
    .mockRejectedValueOnce(new Error('Fixture device search failed'))
    .mockResolvedValueOnce([LAPTOP, SPEAKER])
  vi.stubGlobal('musicSpotify', { devices })
  const settings = render(SpotifySettings)
  await vi.waitFor(() => expect(pickerOptions()).toEqual([LAPTOP.id]))

  await settings.getByRole('button', { name: 'Find devices' }).click()
  await expect.element(settings.getByRole('alert')).toHaveTextContent('Fixture device search failed')
  await settings.getByRole('button', { name: 'Find devices' }).click()
  await vi.waitFor(() => expect(pickerOptions()).toEqual([LAPTOP.id, SPEAKER.id]))
  await expect.element(settings.getByRole('alert')).not.toBeInTheDocument()
})

test('Connect uses the current default after signing out of an older bundled client ID', async () => {
  const rotatedClientId = 'd'.repeat(KEPT_CLIENT_ID.length)
  Object.assign(spotify, SIGNED_IN)
  vi.stubGlobal('musicSpotify', { connect, devices: async () => [], disconnect: async () => ({ ...SIGNED_OUT, clientId: rotatedClientId }) })
  const settings = render(SpotifySettings)
  await settings.getByRole('button', { name: 'Sign out' }).click()
  await settings.getByRole('button', { name: 'Connect Spotify' }).click()
  expect(connect).toHaveBeenCalledWith(rotatedClientId)
})
