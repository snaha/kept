import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import Settings from './Settings.svelte'
import { activity, loadActivity, resetActivity, undoActivity } from './activity.svelte'
import { ACTIVITY_PAGE, TRAIT_COALESCE_MS, createCatalogBridge, createFakeCatalogService, type CatalogBridge, type CatalogService } from './catalog'

const T1 = 1000
const SIZE = 4096
const ENERGY = 80, LATER = 30
const SETTLE_MS = 50
const policy = { analysisAllowed: true, network: 'none' } as const
type Bridge = NonNullable<Window['musicCatalog']>

let service: CatalogService, bridge: CatalogBridge, changed: (() => void) | undefined, clock = T1
const install = (overrides: Partial<Bridge> = {}) => { window.musicCatalog = { ...bridge, onChange: callback => { changed = callback; return () => { changed = undefined } }, ...overrides } }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, SETTLE_MS)); await tick() }
const openActivity = async () => { render(Settings, { coversOnly: false, motion: true, initialTab: 'activity', onclose: () => {} }); await settle() }
const rows = () => [...document.querySelectorAll<HTMLLIElement>('.activity li')]
const energy = async () => (await bridge.albums()).albums.p.traits.energy?.value

beforeEach(async () => {
  clock = T1
  service = createFakeCatalogService()
  await service.registerSource({ id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy })
  await service.registerSource({ id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } })
  await service.ingestScan({ sourceId: 'folder-a', providerSourceId: 'navidrome', observedAt: T1, rootAvailable: true, complete: true, files: [
    { path: 'one.flac', contentHash: 'hash-one', size: SIZE, track: 1, providerTrackId: 'song-one', providerAlbumId: 'p', tags: { title: 'One', artist: 'Artist', album: 'Blue' } },
  ] })
  bridge = createCatalogBridge(service, { now: () => ++clock })
})
afterEach(() => { cleanup(); delete window.musicCatalog; resetActivity() })

describe('Activity in Settings', () => {
  it('has no tab where there is no library to list', async () => {
    render(Settings, { coversOnly: false, motion: true, onclose: () => {} }); await tick()
    expect([...document.querySelectorAll('[role=tab]')].map(tab => tab.textContent)).toEqual(['Appearance', 'Advanced'])
  })

  it('lists a trait edit as a receipt, undoes it and keeps focus in the dialog', async () => {
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: ENERGY })
    install()
    await openActivity()
    expect(rows().map(row => row.querySelector('.summary')!.textContent)).toEqual([`Set energy to ${ENERGY} on Blue`])
    const undo = rows()[0].querySelector('button')!
    undo.focus()
    undo.click()
    await tick()
    // The response is on screen before the library has answered.
    expect(rows()[0].textContent).toContain('Undone')
    expect(rows()[0].querySelector('button')).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('settings-panel'))
    await settle()
    expect(await energy()).toBeUndefined()
    expect(rows()[0].textContent).toContain('Undone')
    expect(document.querySelector('[role=alert]')).toBeNull()
  })

  it('disables the Undo of a change a later one builds on, and refreshes when the library changes', async () => {
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: ENERGY })
    const read = vi.fn(bridge.activity)
    install({ activity: read })
    await openActivity()
    // Long enough after the first edit to be a change of its own, not the same gesture.
    clock += TRAIT_COALESCE_MS
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: LATER })
    changed!()
    changed!()
    await expect.poll(() => rows().length).toBe(2)
    expect(read).toHaveBeenCalledTimes(2)
    expect(rows().map(row => row.querySelector('button')!.disabled)).toEqual([false, true])
    expect(rows()[1].querySelector('.detail')!.textContent).toBe('Undo the later change to this first.')
    rows()[0].querySelector('button')!.click()
    await settle()
    expect(await energy()).toBe(ENERGY)
    expect(rows()[1].querySelector('button')!.disabled).toBe(false)
  })

  it('appends older receipts in place and can undo a receipt beyond the first page', async () => {
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: ENERGY })
    for (let index = 0; index < ACTIVITY_PAGE; index++) {
      await bridge.setFavorite({ providerAlbumId: 'p', value: index % 2 === 0 })
    }
    install({ activity: async request => {
      const result = await bridge.activity(request)
      Object.freeze(result.entries)
      return result
    } })
    await openActivity()
    expect(rows()).toHaveLength(ACTIVITY_PAGE)
    const first = rows()[0]
    const panel = document.getElementById('settings-panel')!
    const older = [...panel.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Show older')
    expect(older).toBeDefined()
    older!.focus()
    const scrollTop = panel.scrollTop
    expect(scrollTop).toBeGreaterThan(0)
    older!.click()
    await expect.poll(() => rows().length).toBe(ACTIVITY_PAGE + 1)
    expect(rows()[0]).toBe(first)
    expect(panel.scrollTop).toBe(scrollTop)
    expect(document.activeElement).toBe(panel)
    const oldest = rows().at(-1)
    await bridge.setFavorite({ providerAlbumId: 'p', value: true })
    changed!()
    await expect.poll(() => rows().length).toBe(ACTIVITY_PAGE + 2)
    expect(rows().at(-1)).toBe(oldest)

    rows().at(-1)?.querySelector('button')?.click()
    await expect.poll(energy).toBeUndefined()
    await expect.poll(() => rows().at(-1)?.textContent).toContain('Undone')
    expect(rows()).toHaveLength(ACTIVITY_PAGE + 2)
  })

  it('puts the entry back and says so when the undo fails, and when it is refused', async () => {
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: ENERGY })
    let failure: 'reject' | 'refuse' = 'reject'
    install({ undo: async () => { if (failure === 'reject') throw new Error('offline'); return { status: 'blocked', reason: 'changed-since', blockedBy: [] } } })
    await openActivity()
    rows()[0].querySelector('button')!.click()
    await settle()
    expect(rows()[0].querySelector('button')!.disabled).toBe(false)
    expect(document.querySelector('[role=alert]')!.textContent).toContain('could not be undone')
    failure = 'refuse'
    rows()[0].querySelector('button')!.click()
    await settle()
    expect(rows()[0].textContent).not.toContain('Undone')
    expect(document.querySelector('[role=alert]')!.textContent).toContain('changed again since')
    expect(await energy()).toBe(ENERGY)
  })

  it('keeps the last list when a refresh fails, and lets only the latest load show', async () => {
    await bridge.setTrait({ providerAlbumId: 'p', trait: 'energy', value: ENERGY })
    install()
    await loadActivity()
    expect(activity.entries).toHaveLength(1)
    let release: () => void = () => {}
    const slow = new Promise<void>(resolve => { release = resolve })
    install({ activity: async () => { await slow; return { entries: [], total: 0 } } })
    const stale = loadActivity()
    install({ activity: async () => { throw new Error('offline') } })
    await loadActivity()
    release()
    await stale
    expect(activity.entries).toHaveLength(1)
    expect(activity.error).toContain('could not be loaded')
    install()
    await undoActivity(activity.entries[0].id)
    expect(activity.entries[0].undone).toBe(true)
    expect(activity.error).toBe('')
  })
})
