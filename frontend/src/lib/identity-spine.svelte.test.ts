import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import { catalog, loadCatalog, resetDig, saveMetadata, syncDecisions, traitReadings } from './discovery.svelte'
import { consent, loadLookupConsent, setLookupConsent } from './consent.svelte'
import { desktop } from './desktop.svelte'
import Settings from './Settings.svelte'
import AlbumTraits from './AlbumTraits.svelte'
import { createCatalogBridge, createFakeCatalogService, type CatalogBridge, type CatalogService, type ScanFile } from './catalog'

const KEY = 'music.catalog.v1::', MARKER = `${KEY}:spine`, CONSENT_KEY = 'music.lookup-consent.v1'
const T1 = 1000
const SIZE = 4096
const ENERGY = 80, MOOD = 20, ESTIMATE = 35, EDITED = 31, LATER = 99
const SAVE_DELAY = 300
const policy = { analysisAllowed: true, network: 'none' } as const
const file = (name: string, album: string): ScanFile => ({ path: `${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track: 1, providerTrackId: `song-${name}-${album}`, providerAlbumId: album })
const id = (album: string) => `local:album:${album}`
type Bridge = NonNullable<Window['musicCatalog']>

let service: CatalogService, bridge: CatalogBridge, changed: (() => void) | undefined
const scan = (files: ScanFile[]) => service.ingestScan({ sourceId: 'folder-a', providerSourceId: 'navidrome', observedAt: T1, rootAvailable: true, complete: true, files })
const install = (overrides: Partial<Bridge> = {}) => { window.musicCatalog = { ...bridge, onChange: callback => { changed = callback; return () => { changed = undefined } }, ...overrides } }
const albumOf = async (album: string) => (await bridge.albums()).albums[album]

beforeAll(() => { loadCatalog() })
beforeEach(async () => {
  service = createFakeCatalogService()
  await service.registerSource({ id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy })
  await service.registerSource({ id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } })
  await scan([file('one', 'p'), file('two', 'q')])
  bridge = createCatalogBridge(service)
  catalog.items = {}; catalog.estimated = {}; catalog.error = ''
})
afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
  delete window.musicCatalog; delete window.desktop
  desktop.status = null; consent.lookup = undefined; consent.error = ''
  catalog.items = {}; catalog.estimated = {}; catalog.error = ''; resetDig(); localStorage.clear()
})

describe('Dig traits and favourites on the identity spine', () => {
  it('migrates device tags once, keeps the old preferences and can be replayed', async () => {
    const saved = JSON.stringify({ [id('p')]: { favorite: true, traits: { energy: ENERGY, mood: MOOD } }, [id('later')]: { traits: { vocal: MOOD } }, 'local:playlist:x': { favorite: true } })
    localStorage.setItem(KEY, saved)
    catalog.items = JSON.parse(saved)
    install()
    await syncDecisions()
    const first = await albumOf('p')
    expect([first.favorite, first.traits.energy?.value, first.traits.mood?.value, first.traits.energy?.provenance]).toEqual([true, ENERGY, MOOD, 'hand-set'])
    expect((await albumOf('q')).traits).toEqual({})
    const marker = localStorage.getItem(MARKER)
    expect(JSON.parse(marker!).decidedAt).toBe(first.traits.energy?.observedAt)
    await syncDecisions(); await syncDecisions()
    expect(await albumOf('p')).toEqual(first)
    expect(localStorage.getItem(MARKER)).toBe(marker)
    // The old preferences are exactly as they were, and still drive the albums not scanned yet.
    expect(localStorage.getItem(KEY)).toBe(saved)
    expect(catalog.items[id('later')]).toEqual({ traits: { vocal: MOOD } })
    expect(catalog.items[id('p')]).toMatchObject({ favorite: true, traits: { energy: ENERGY, mood: MOOD } })
    // A later scan anchors the waiting album, and the same migration picks it up.
    await scan([file('one', 'p'), file('two', 'q'), file('three', 'later')])
    await syncDecisions()
    expect((await albumOf('later')).traits.vocal).toMatchObject({ value: MOOD, provenance: 'hand-set', observedAt: JSON.parse(marker!).decidedAt })
  })

  it('reads hand-set and estimated traits from the spine, keyed through the provider link', async () => {
    install()
    const { albumId } = await albumOf('p')
    const subject = { kind: 'album' as const, id: albumId }
    await service.registerSource({ id: 'openl3', kind: 'model', label: 'OpenL3', evidenceClass: 'model', licence: 'CC-BY-4.0', policy })
    await service.recordObservation({ sourceId: 'openl3', subject, field: 'trait.energy', value: ESTIMATE, observedAt: T1 })
    await service.recordObservation({ sourceId: 'openl3', subject, field: 'trait.vocal', value: ESTIMATE, observedAt: T1 })
    await service.recordUserDecision({ kind: 'trait', subject, trait: 'energy', value: ENERGY, decidedAt: T1 })
    await service.recordUserDecision({ kind: 'favorite', subject, value: true, decidedAt: T1 })
    await syncDecisions()
    expect(catalog.items[id('p')]).toMatchObject({ favorite: true, traits: { energy: ENERGY } })
    expect(traitReadings(id('p'))).toEqual({ energy: { value: ENERGY, source: 'hand' }, vocal: { value: ESTIMATE, source: 'estimated', confidence: undefined } })
    expect(catalog.items[id('q')]).toBeUndefined()
  })

  it('sends a slider drag once, on release, and keeps it as one receipt with the value from before', async () => {
    const setTrait = vi.fn(bridge.setTrait)
    install({ setTrait })
    await syncDecisions()
    saveMetadata(id('p'), { traits: { energy: ENERGY } })
    await vi.waitFor(() => expect(setTrait).toHaveBeenCalledTimes(1))
    // Mid-drag the value is on screen and on the device, and the library has not heard of it.
    for (const value of [EDITED, MOOD, LATER]) saveMetadata(id('p'), { traits: { energy: value } }, { settled: false })
    await syncDecisions()
    expect(catalog.items[id('p')].traits).toEqual({ energy: LATER })
    expect(setTrait).toHaveBeenCalledTimes(1)
    saveMetadata(id('p'), { traits: { energy: LATER } })
    await vi.waitFor(async () => expect((await albumOf('p')).traits.energy?.value).toBe(LATER))
    expect(setTrait).toHaveBeenCalledTimes(2)
    // A release at the value the drag started from is not a change.
    saveMetadata(id('p'), { traits: { energy: MOOD } }, { settled: false })
    saveMetadata(id('p'), { traits: { energy: LATER } })
    await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
    expect(setTrait).toHaveBeenCalledTimes(2)
  })

  it('keeps the keys of one slider as one receipt, and Undo returns to the value before them', async () => {
    install()
    await syncDecisions()
    render(AlbumTraits, { tile: { id: id('p'), rawId: 'p', source: 'local', kind: 'album', title: 'Album', sub: 'Artist', cover: '', count: 1, available: true }, estimated: { energy: { value: ESTIMATE } } }); await tick()
    const thumb = [...document.querySelectorAll<HTMLElement>('.trait')][1].querySelector<HTMLElement>('[role=slider]')!
    thumb.focus()
    for (const step of [1, 2, 3]) {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick()
      await vi.waitFor(async () => expect((await albumOf('p')).traits.energy?.value).toBe(ESTIMATE + step))
    }
    const { entries } = await bridge.activity()
    expect(entries.map(entry => entry.summary)).toEqual([`Set energy to ${ESTIMATE + 3} on an album`])
    await bridge.undo({ id: entries[0].id })
    expect((await albumOf('p')).traits.energy).toBeUndefined()
  })

  it('gives a favourite a receipt that Undo takes back', async () => {
    install()
    await syncDecisions()
    saveMetadata(id('p'), { favorite: true })
    await vi.waitFor(async () => expect((await albumOf('p')).favorite).toBe(true))
    const { entries } = await bridge.activity()
    expect(entries.map(entry => [entry.summary, entry.undoable])).toEqual([['Added an album to favourites', true]])
    await bridge.undo({ id: entries[0].id })
    changed?.()
    await syncDecisions()
    expect((await albumOf('p')).favorite).toBe(false)
    expect(catalog.items[id('p')]?.favorite).toBeUndefined()
  })

  it('writes edits to the spine and to the device, and a server re-ID keeps them', async () => {
    install()
    await syncDecisions()
    saveMetadata(id('p'), { traits: { energy: ENERGY, mood: MOOD } })
    saveMetadata(id('p'), { traits: { energy: EDITED, mood: MOOD }, favorite: true })
    await vi.waitFor(async () => expect((await albumOf('p')).traits.energy?.value).toBe(EDITED))
    expect(await albumOf('p')).toMatchObject({ favorite: true, traits: { mood: { value: MOOD, provenance: 'hand-set' } } })
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)[id('p')]).toMatchObject({ favorite: true, traits: { energy: EDITED, mood: MOOD } }))
    // The server rebuilt its database: the same files under new album IDs.
    await scan([{ ...file('one', 'p-new') }, { ...file('two', 'q-new') }])
    changed?.()
    await syncDecisions()
    expect(catalog.items[id('p-new')]).toMatchObject({ favorite: true, traits: { energy: EDITED, mood: MOOD } })
    // Clearing the tags clears the decisions.
    saveMetadata(id('p-new'), { traits: undefined })
    await vi.waitFor(async () => expect((await albumOf('p')).traits).toEqual({}))
    expect((await albumOf('p')).favorite).toBe(true)
  })

  it('keeps an edit made while a sync is in flight', async () => {
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    install()
    saveMetadata(id('p'), { traits: { energy: ENERGY } })
    await vi.waitFor(async () => expect((await albumOf('p')).traits.energy?.value).toBe(ENERGY))
    // The sync reads the spine, then the user moves the slider before that answer arrives.
    const before = await bridge.albums()
    install({ albums: async () => { await held; return before } })
    const sync = syncDecisions()
    saveMetadata(id('p'), { traits: { energy: LATER } })
    release()
    await sync
    expect(catalog.items[id('p')]?.traits).toEqual({ energy: LATER })
    await vi.waitFor(async () => expect((await albumOf('p')).traits.energy?.value).toBe(LATER))
  })

  it('falls back to device preferences when the spine fails or is absent', async () => {
    saveMetadata(id('p'), { traits: { energy: ENERGY } })
    await syncDecisions()
    expect(catalog.items[id('p')]?.traits).toEqual({ energy: ENERGY })
    const refuse = async () => { throw new Error('worker stopped') }
    install({ albums: refuse, migrate: refuse, setTrait: refuse })
    await syncDecisions()
    expect(catalog.items[id('p')]?.traits).toEqual({ energy: ENERGY })
    saveMetadata(id('p'), { traits: { energy: EDITED } })
    await vi.waitFor(() => expect(catalog.error).toMatch(/still kept on this device/))
    expect(catalog.items[id('p')]?.traits).toEqual({ energy: EDITED })
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)[id('p')].traits).toEqual({ energy: EDITED }))
    expect((await albumOf('p')).traits).toEqual({})
  })
})

describe('lookup consent as a user decision', () => {
  it('carries an earlier device answer over once, then obeys the stored decision', async () => {
    install()
    localStorage.setItem(CONSENT_KEY, 'online'); consent.lookup = 'online'
    await loadLookupConsent()
    expect((await service.getConsent())['online-lookups']).toBe('granted')
    await service.setConsent({ consent: 'online-lookups', value: 'denied', decidedAt: Date.now() + T1 })
    await loadLookupConsent()
    expect(consent.lookup).toBe('offline')
    expect(localStorage.getItem(CONSENT_KEY)).toBe('offline')
  })

  it('is offline until asked, stores the answer, and shows a failed save as not made', async () => {
    install()
    await loadLookupConsent()
    expect(consent.lookup).toBeUndefined()
    expect((await service.getConsent())['online-lookups']).toBe('not-asked')
    await setLookupConsent('online')
    expect([consent.lookup, (await service.getConsent())['online-lookups'], localStorage.getItem(CONSENT_KEY)]).toEqual(['online', 'granted', 'online'])
    install({ setConsent: async () => { throw new Error('worker stopped') } })
    await setLookupConsent('offline')
    expect([consent.lookup, localStorage.getItem(CONSENT_KEY)]).toEqual(['online', 'online'])
    expect(consent.error).toMatch(/could not be saved/)
    expect((await service.getConsent())['online-lookups']).toBe('granted')
  })
})

describe('consent step at add library', () => {
  const status = { phase: 'ready', error: '', onboarding: false, url: '', username: '', password: '', frame: true, build: { version: '0', channel: 'stable', commit: '', branch: '', builtAt: '', runUrl: '' },
    profile: { name: 'p', label: 'Profile', directory: '/data', existing: false, portable: false }, musicFolder: '', musicFolders: [], defaultMusicFolder: '', defaultMusicFolderAvailable: false, source: 'local', canCopy: false } satisfies DesktopStatus
  const button = (name: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => name.test(item.textContent ?? ''))!
  const step = () => document.querySelector<HTMLDialogElement>('.consent-dialog')!
  const open = async () => {
    const changeFolder = vi.fn(async () => {}), onclose = vi.fn()
    window.desktop = { profiles: async () => [], changeFolder } as unknown as Window['desktop']
    desktop.status = status
    install()
    render(Settings, { coversOnly: false, motion: true, initialTab: 'advanced', onclose }); await tick()
    return { changeFolder, onclose, add: button(/Add music folder/) }
  }

  it('asks once before the first folder is added and remembers the answer', async () => {
    const { changeFolder, onclose, add } = await open()
    expect(step().open).toBe(false)
    add.focus(); add.click(); await tick()
    expect(step().open).toBe(true)
    expect(step().contains(document.activeElement)).toBe(true)
    expect(changeFolder).not.toHaveBeenCalled()
    button(/Stay offline/).click()
    await vi.waitFor(() => expect(changeFolder).toHaveBeenCalledWith('add', undefined))
    expect([step().open, consent.lookup, (await service.getConsent())['online-lookups']]).toEqual([false, 'offline', 'denied'])
    expect(onclose).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(add.disabled).toBe(false))
    add.click(); await tick()
    expect(step().open).toBe(false)
    await vi.waitFor(() => expect(changeFolder).toHaveBeenCalledTimes(2))
  })

  it('closes on Escape without an answer, keeps Settings open and returns focus to its opener', async () => {
    const { changeFolder, onclose, add } = await open()
    add.focus(); add.click(); await tick()
    const [online, offline] = [button(/Look up album details online/), button(/Stay offline/)]
    offline.focus()
    offline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(online)
    online.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(step().open).toBe(false))
    await vi.waitFor(() => expect(document.activeElement).toBe(add))
    expect([consent.lookup, changeFolder.mock.calls.length, onclose.mock.calls.length]).toEqual([undefined, 0, 0])
    expect(document.querySelector<HTMLDialogElement>('.settings-dialog')!.open).toBe(true)
    expect((await service.getConsent())['online-lookups']).toBe('not-asked')
  })
})
