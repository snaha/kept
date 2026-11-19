import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import Settings from './Settings.svelte'
import ThirdPartyNotices from './third-party-notices.svelte'
import { THIRD_PARTY_NOTICES } from './third-party'

const NARROW_WIDTH = 360
const NARROW_HEIGHT = 640
const WIDE_WIDTH = 1024
const WIDE_HEIGHT = 768
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent?.trim() === name)!

afterEach(async () => { cleanup(); delete window.musicCatalog; await page.viewport(WIDE_WIDTH, WIDE_HEIGHT) })

describe('third-party notices', () => {
  it('lists every bundled piece with its licence, source and terms', async () => {
    render(ThirdPartyNotices, { notices: THIRD_PARTY_NOTICES }); await tick()
    const items = [...document.querySelectorAll('li')]
    const headings = items.map(item => item.querySelector('h3')?.textContent?.trim())
    expect(headings).toEqual(expect.arrayContaining(['Navidrome 0.64.2', 'ONNX Runtime Web 1.20.1', 'OpenL3 music, 512 dimensions', 'Interface libraries']))
    expect(headings.some(heading => /^FFmpeg \d/.test(heading ?? ''))).toBe(true)
    expect(headings.some(heading => /^Electron \d/.test(heading ?? ''))).toBe(true)
    const text = (name: string) => items.find(item => item.querySelector('h3')?.textContent?.startsWith(name))!.textContent ?? ''
    expect(text('Navidrome')).toContain('GPL-3.0')
    expect(text('FFmpeg')).toContain('LGPL-2.1-or-later')
    expect(text('FFmpeg')).toContain('Source offer')
    expect(document.querySelector('pre')?.textContent).toMatch(/^\.\/configure --disable-gpl --disable-nonfree .*--disable-everything/)
    expect(text('FFmpeg')).toContain('https://ffmpeg.org/releases/ffmpeg-')
    expect(text('ONNX')).toContain('MIT')
    expect(text('OpenL3')).toContain('CC BY 4.0')
    expect(text('OpenL3')).toMatch(/Attribution.*Cramer.*Bello/)
    // Each entry is named for assistive technology by its own heading.
    for (const item of items) expect(document.getElementById(item.getAttribute('aria-labelledby')!)?.tagName).toBe('H3')
  })

  it('opens from its own Settings tab and fits a narrow window without scrolling sideways', async () => {
    // The desktop app also has the Activity tab: four tabs is the widest strip.
    window.musicCatalog = { onChange: () => () => {}, activity: async () => ({ entries: [], total: 0 }) } as unknown as typeof window.musicCatalog
    await page.viewport(NARROW_WIDTH, NARROW_HEIGHT)
    render(Settings, { coversOnly: false, motion: true, onclose: () => {} }); await tick()
    expect([...document.querySelectorAll('[role="tab"]')].map(item => item.textContent?.trim())).toEqual(['Appearance', 'Advanced', 'Activity', 'Licences'])
    tab('Licences').click(); await tick()
    expect(document.querySelector('#settings-panel h2')?.textContent).toBe('Third-party notices')
    expect(document.querySelector('#settings-panel')?.textContent).toContain('MP3, FLAC, MP4/M4A (AAC or ALAC), Ogg (Vorbis or Opus), and PCM WAV and AIFF')
    expect(document.querySelector('#settings-panel')?.getAttribute('aria-labelledby')).toBe('settings-tab-notices')
    const strip = document.querySelector<HTMLElement>('[role="tablist"]')!, panel = document.querySelector<HTMLElement>('#settings-panel')!
    expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth)
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
    for (const item of document.querySelectorAll<HTMLElement>('[role="tab"]')) expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth)
  })
})
