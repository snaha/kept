import { afterEach, describe, expect, it } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import { catalog, resetDig } from './discovery.svelte'
import AlbumTraits from './AlbumTraits.svelte'
import DigPanel from './DigPanel.svelte'
import type { Collection } from './music'

const tile: Collection = { id: 'local:album:p', rawId: 'p', source: 'local', kind: 'album', title: 'Album', sub: 'Artist', cover: '', count: 1, available: true }
const rows = () => [...document.querySelectorAll<HTMLElement>('.trait')]
const sources = () => rows().map(row => row.dataset.source)

describe('trait provenance', () => {
  afterEach(() => { cleanup(); catalog.items = {}; catalog.estimated = {}; resetDig() })

  it('shows estimated axes as estimated and unset axes as unset', async () => {
    render(AlbumTraits, { tile, estimated: { mood: { value: 70, confidence: .8 }, energy: { value: 30 } } }); await tick()
    expect(sources()).toEqual(['estimated', 'estimated', 'unset', 'unset'])
    expect(document.querySelectorAll('.marker[data-source=estimated]')).toHaveLength(2)
  })

  it('shows hand values solid and lets them win over an estimate', async () => {
    catalog.items[tile.id] = { traits: { mood: 20 } }
    render(AlbumTraits, { tile, estimated: { mood: { value: 70 }, energy: { value: 30 } } }); await tick()
    expect(sources().slice(0, 2)).toEqual(['hand', 'estimated'])
    expect(rows()[0].querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('20')
  })

  it('turns an axis solid on the same frame the user moves it, and saves only that axis', async () => {
    render(AlbumTraits, { tile, estimated: { energy: { value: 30 } } }); await tick()
    const thumb = rows()[1].querySelector<HTMLElement>('[role=slider]')!
    thumb.focus(); thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick()
    expect(sources()[1]).toBe('hand')
    expect(catalog.items[tile.id]?.traits).toEqual({ energy: 31 })
  })

  it('explains the provenance on focus without changing the layout', async () => {
    render(AlbumTraits, { tile, estimated: { mood: { value: 70, confidence: .8 } } }); await tick()
    const note = document.querySelector<HTMLElement>('.provenance')!
    const before = note.getBoundingClientRect().height
    expect(note.textContent).toContain('Dashed values are estimated')
    rows()[0].dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await tick()
    expect(note.textContent).toContain('Estimated by Kept, 80% sure')
    expect(note.getBoundingClientRect().height).toBe(before)
  })

  it('keeps the sliders hidden when nothing is tagged or estimated', async () => {
    render(AlbumTraits, { tile }); await tick()
    expect(rows()).toHaveLength(0)
  })

  it('Dig explains the mix of hand and estimated tags', async () => {
    render(DigPanel, { matches: 1, total: 3, tagged: 1, estimated: 2, onrandom: () => {} }); await tick()
    expect(document.querySelector('.legend')?.textContent).toMatch(/1 tagged by you\s+2 estimated/)
    cleanup()
    render(DigPanel, { matches: 1, total: 3, tagged: 1, onrandom: () => {} }); await tick()
    expect(document.querySelector('.legend')).toBeNull()
  })
})
