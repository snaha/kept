import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import CoverFlow from './cover-flow.svelte'
import type { Collection } from './music'

const ALBUM_COUNT = 1000
const LAST_ALBUM = ALBUM_COUNT - 1
const MAX_MOUNTED = 9
const tiles: Collection[] = Array.from({ length: ALBUM_COUNT }, (_, index) => ({
  id: `local:album:${index}`, rawId: String(index), source: 'local', kind: 'album',
  title: `Album ${index}`, sub: 'Artist', cover: '', count: 1, available: true,
}))
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
afterEach(cleanup)

describe('Cover Flow browsing', () => {
  it('bounds mounted covers, separates selection from opening and plays the selected album', async () => {
    const onopen = vi.fn()
    const onplay = vi.fn()
    render(CoverFlow, { tiles, top: 0, onopen, onplay })
    await tick()
    button('Select Album 1 — Artist').click()
    await tick()
    expect(onopen).not.toHaveBeenCalled()
    expect(document.querySelector('h2')?.textContent).toBe('Album 1')
    button('Open Album 1 — Artist').click()
    expect(onopen).toHaveBeenCalledWith(tiles[1])
    button('Play Album 1').click()
    expect(onplay).toHaveBeenCalledWith(tiles[1])
    button('Open Album 1 — Artist').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-collection-id')).toBe(tiles[LAST_ALBUM].id))
    expect(document.querySelectorAll('.flow-cover').length).toBeLessThanOrEqual(MAX_MOUNTED)
    expect(button('Next album').disabled).toBe(true)
  })
  it('keeps the centered identity when a background refresh inserts albums before it', async () => {
    const props = { tiles, top: 0, onopen: () => {}, onplay: () => {} }
    const view = render(CoverFlow, props)
    await tick()
    button('Next album').click()
    await tick()
    const inserted = { ...tiles[0], id: 'inserted', title: 'Inserted' }
    await view.rerender({ ...props, tiles: [inserted, ...tiles] })
    await vi.waitFor(() => expect(document.querySelector('h2')?.textContent).toBe('Album 1'))
    expect(document.querySelector('.flow-cover[aria-current="true"]')?.getAttribute('data-collection-id')).toBe(tiles[1].id)
  })
})
