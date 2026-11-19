import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import ConsentChoice from './consent-choice.svelte'
import LookupToggle from './lookup-toggle.svelte'
import ActivityPanel from './activity-panel.svelte'
import Settings from './Settings.svelte'
import { consent, setLookupConsent } from './consent.svelte'
import type { ActivityEntry } from './activity'

const button = (name: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => name.test(item.textContent ?? ''))!
const NOW = Date.UTC(2026, 0, 1, 12)
const entries: ActivityEntry[] = [
  { id: 'a', at: NOW, actor: 'kept', summary: 'Fixed the year of Kind of Blue', detail: '1958 instead of 1985' },
  { id: 'b', at: NOW - 1000, actor: 'you', summary: 'Merged two albums', undone: true },
  { id: 'c', at: NOW - 2000, actor: 'kept', summary: 'Locked change', undoable: false },
]

afterEach(() => { cleanup(); localStorage.clear(); consent.lookup = undefined })

describe('consent step', () => {
  it('says what is sent and offers exactly two choices', async () => {
    render(ConsentChoice, { onchoose: () => {} }); await tick()
    expect(document.querySelector('.consent dd')?.textContent).toMatch(/track titles.*MusicBrainz release IDs/)
    expect(document.querySelector('.consent dd')?.textContent).toContain('Your audio files stay on this device')
    expect([...document.querySelectorAll('button')].map(item => item.textContent?.trim())).toEqual(['Look up album details online', 'Stay offline'])
  })

  it('reports the choice once per click and does nothing while busy', async () => {
    const onchoose = vi.fn()
    const view = render(ConsentChoice, { onchoose }); await tick()
    button(/Stay offline/).click(); button(/online/).click()
    expect(onchoose.mock.calls).toEqual([['offline'], ['online']])
    await view.rerender({ onchoose, busy: true }); await tick()
    expect([...document.querySelectorAll('button')].every(item => item.disabled)).toBe(true)
  })
})

describe('lookup toggle', () => {
  it('is off until the user agrees and reports changes', async () => {
    const onchange = vi.fn()
    render(LookupToggle, { value: undefined, onchange }); await tick()
    const box = document.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(box.checked).toBe(false)
    box.click(); box.click()
    expect(onchange.mock.calls).toEqual([['online'], ['offline']])
  })

  it('lives in Advanced settings and keeps the stored answer', async () => {
    render(Settings, { coversOnly: false, motion: true, initialTab: 'advanced', onclose: () => {} }); await tick()
    const box = document.querySelector<HTMLInputElement>('.lookup input')!
    expect(document.querySelector('.lookup .help')?.textContent).toMatch(/track titles.*MusicBrainz release IDs/)
    expect(box.checked).toBe(false)
    box.click(); await tick()
    expect(consent.lookup).toBe('online')
    expect(localStorage.getItem('music.lookup-consent.v1')).toBe('online')
    setLookupConsent('offline'); await tick()
    expect(box.checked).toBe(false)
  })
})

describe('activity panel', () => {
  it('lists receipts and undoes the chosen entry', async () => {
    const onundo = vi.fn()
    render(ActivityPanel, { entries, onundo }); await tick()
    expect(document.querySelectorAll('li')).toHaveLength(3)
    document.querySelector<HTMLButtonElement>('[aria-label="Undo: Fixed the year of Kind of Blue"]')!.click()
    expect(onundo).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('shows undone entries as receipts without an Undo and disables locked ones', async () => {
    const onundo = vi.fn()
    render(ActivityPanel, { entries, onundo }); await tick()
    const items = [...document.querySelectorAll('li')]
    expect(items[1].textContent).toContain('Undone')
    expect(items[1].querySelector('button')).toBeNull()
    const locked = items[2].querySelector('button')!
    expect(locked.disabled).toBe(true)
  })

  it('explains an empty list', async () => {
    render(ActivityPanel, { entries: [], onundo: () => {} }); await tick()
    expect(document.querySelectorAll('li')).toHaveLength(0)
    expect(document.body.textContent).toContain('Nothing yet')
  })
})
