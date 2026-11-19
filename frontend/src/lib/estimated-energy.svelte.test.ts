import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { catalog, dig, digScore, loadCatalog, resetDig, saveMetadata, syncDecisions, traitReadings } from './discovery.svelte'
import { closeSimilar, findSimilarAlbums, similar } from './similar-albums.svelte'
import SimilarLane from './similar-lane.svelte'
import { createCatalogBridge, createFakeCatalogService, type CatalogBridge, type CatalogService, type ScanFile } from './catalog'
import type { Collection } from './music'

const KEY = 'music.catalog.v1::'
const T1 = 1000, SIZE = 4096, HAND_ENERGY = 15, ESTIMATED_ENERGY = 80, OTHER_ENERGY = 60, SAVE_DELAY = 300
const policy = { analysisAllowed: true, network: 'none' } as const
const file = (name: string, album: string): ScanFile => ({ path: `${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track: 1, providerTrackId: `song-${name}-${album}`, providerAlbumId: album })
const tile = (album: string): Collection => ({ id: `local:album:${album}`, rawId: album, source: 'local', kind: 'album', title: album, sub: 'Artist', cover: '', count: 1, available: true })
type Bridge = NonNullable<Window['musicCatalog']>

let service: CatalogService, bridge: CatalogBridge
const install = (overrides: Partial<Bridge> = {}) => { window.musicCatalog = { ...bridge, onChange: () => () => {}, ...overrides } }
const anchorOf = async (album: string) => (await bridge.albums()).albums[album].albumId

beforeAll(() => { loadCatalog() })
beforeEach(async () => {
  service = createFakeCatalogService()
  await service.registerSource({ id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy })
  await service.registerSource({ id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } })
  await service.ingestScan({ sourceId: 'folder-a', providerSourceId: 'navidrome', observedAt: T1, rootAvailable: true, complete: true, files: [file('one', 'p'), file('two', 'q')] })
  bridge = createCatalogBridge(service)
  catalog.items = {}; catalog.estimated = {}; catalog.error = ''
})
afterEach(async () => {
  cleanup(); closeSimilar()
  await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
  delete window.musicCatalog
  catalog.items = {}; catalog.estimated = {}; catalog.error = ''; resetDig(); localStorage.clear()
})

describe('estimated energy', () => {
  it('fills an untagged album as an estimate, and Dig returns it on the energy axis', async () => {
    const [p, q] = [await anchorOf('p'), await anchorOf('q')]
    install({ estimatedTraits: async () => ({ albums: { [p]: { energy: { value: ESTIMATED_ENERGY } }, [q]: { energy: { value: OTHER_ENERGY } } } }) })
    await syncDecisions()
    expect(traitReadings('local:album:p').energy).toEqual({ value: ESTIMATED_ENERGY, source: 'estimated', confidence: undefined })
    expect(Object.keys(catalog.items)).toEqual([])
    Object.assign(dig, { moodOn: true, mood: 50, energy: ESTIMATED_ENERGY })
    expect(digScore(tile('p'))).toBe(1)
    expect(digScore(tile('q'))).toBeGreaterThan(0)
    expect(digScore(tile('p'))).toBeGreaterThan(digScore(tile('q')))
  })

  it('never overwrites a hand value: the hand value is shown and scored, before and after a sync', async () => {
    const p = await anchorOf('p')
    install({ estimatedTraits: async () => ({ albums: { [p]: { energy: { value: ESTIMATED_ENERGY } } } }) })
    saveMetadata('local:album:p', { traits: { energy: HAND_ENERGY } })
    await syncDecisions()
    await syncDecisions()
    expect(traitReadings('local:album:p').energy).toEqual({ value: HAND_ENERGY, source: 'hand' })
    expect(catalog.estimated['local:album:p']?.energy).toBeUndefined()
    Object.assign(dig, { moodOn: true, mood: 50, energy: ESTIMATED_ENERGY })
    expect(digScore(tile('p'))).toBe(0)
    // The decision kept in the catalog is the user's, with nothing computed recorded beside it.
    expect(((await bridge.albums()).albums.p.traits.energy)?.provenance).toBe('hand-set')
    expect(((await bridge.albums()).albums.p.traits.energy)?.value).toBe(HAND_ENERGY)
  })

  it('keeps what is shown when the estimates cannot be read', async () => {
    const p = await anchorOf('p')
    install({ estimatedTraits: async () => ({ albums: { [p]: { energy: { value: ESTIMATED_ENERGY } } } }) })
    await syncDecisions()
    install({ estimatedTraits: async () => { throw new Error('features are busy') } })
    await syncDecisions()
    expect(traitReadings('local:album:p').energy?.value).toBe(ESTIMATED_ENERGY)
  })
})

describe('More like this', () => {
  const albumResult = (albumIds: string[]) => ({ analysed: true, albumIds })

  it('loads sound matches through the dedicated catalog query', async () => {
    const [p, q] = [await anchorOf('p'), await anchorOf('q')]
    let asked: unknown
    install({
      similarAlbums: async request => {
        asked = request
        return albumResult([q])
      },
      tool: async () => { throw new Error('The lane called the generic tool') },
    })
    await findSimilarAlbums(tile(p))
    expect(similar.status).toBe('ready')
    expect(similar.albums.map(album => album.rawId)).toEqual([q])
    expect(asked).toEqual({ albumId: p })
    const screen = await render(SimilarLane)
    await expect.element(screen.getByRole('heading', { name: 'Sounds like…' })).toBeVisible()
    await expect.element(screen.getByText('Based on how albums sound', { exact: false })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /^Play / })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /^Add .* to queue/ })).toBeVisible()
  })

  it('says Kept is still listening when the album is awaiting analysis', async () => {
    install({ similarAlbums: async () => ({ analysed: false, albumIds: [] }) })
    await findSimilarAlbums(tile(await anchorOf('p')))
    expect(similar.status).toBe('listening')
    expect(similar.albums).toEqual([])
    const screen = await render(SimilarLane)
    await expect.element(screen.getByText('Kept is still listening to this album.')).toBeVisible()
  })

  it('shows no similar albums for an analysed seed without sound matches', async () => {
    const screen = await render(SimilarLane)
    install({ similarAlbums: async () => albumResult([]) })
    await findSimilarAlbums(tile(await anchorOf('p')))
    await expect.element(screen.getByRole('status')).toHaveTextContent('No similar albums are available to play right now.')
    expect(similar.albums).toEqual([])
  })

  it('ignores seed coverage that arrives after closing the lane', async () => {
    const p = await anchorOf('p')
    let release = () => {}
    let started = () => {}
    const checking = new Promise<void>(resolve => { started = resolve })
    install({
      similarAlbums: async () => {
        started()
        await new Promise<void>(resolve => { release = resolve })
        return albumResult([])
      },
    })
    const search = findSimilarAlbums(tile(p))
    await Promise.race([checking, search])
    expect(similar.status).toBe('loading')
    closeSimilar()
    release()
    await search
    expect(similar.status).toBe('idle')
  })

  it('lets the newest request win and reports a failure without keeping an old list', async () => {
    const [p, q] = [await anchorOf('p'), await anchorOf('q')]
    let release: () => void = () => {}
    install({ similarAlbums: async () => {
      await new Promise<void>(resolve => { release = resolve })
      return albumResult([q])
    } })
    const first = findSimilarAlbums(tile(p))
    install({ similarAlbums: async () => albumResult([p]) })
    await findSimilarAlbums(tile(q))
    release(); await first
    expect(similar.albums.map(album => album.rawId)).toEqual([p])
    install({ similarAlbums: async () => { throw new Error('broken') } })
    await findSimilarAlbums(tile(p))
    expect(similar.status).toBe('failed')
    expect(similar.albums).toEqual([])
  })
})
