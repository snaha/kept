import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import AssistantBar from './assistant-bar.svelte'
import AssistantSettings from './assistant-settings.svelte'
import { assistant, openAssistant, type AssistantChange, type AssistantReply, type AssistantStatus } from './assistant.svelte'
import { tracksByOccurrence } from './catalog-source.svelte'
import type { Track } from './music'
import { player } from './player.svelte'

vi.mock('./catalog-source.svelte', async importOriginal => ({ ...(await importOriginal<typeof import('./catalog-source.svelte')>()), tracksByOccurrence: vi.fn(async () => []) }))

const ON: AssistantStatus = { enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5', models: { anthropic: 'claude-sonnet-5-5', local: '' }, baseUrl: 'http://localhost:11434/v1', hasKey: true, canStoreKey: true }
const reply = (message: string): AssistantReply => ({ message, queue: [], steps: [{ tool: 'search_catalog', ok: true, detail: '3 results' }] })
const SETTLE_MS = 40
const settle = async () => { await tick(); await new Promise(resolve => setTimeout(resolve, SETTLE_MS)); await tick() }
const type = (value: string) => { const input = document.querySelector<HTMLInputElement>('.assistant-bar input')!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
const submit = () => document.querySelector<HTMLFormElement>('.assistant-bar form')!.requestSubmit()
let status = ON
const api = { status: vi.fn(async () => status), save: vi.fn(), ask: vi.fn(), cancel: vi.fn(async () => {}) }

beforeEach(() => {
  status = ON
  window.musicAssistant = api as never
  Object.assign(assistant, { open: false, busy: false, request: '', error: '', note: '', status: undefined, reply: undefined, tracks: [] })
  for (const mock of Object.values(api)) mock.mockClear()
})
afterEach(() => { cleanup(); delete window.musicAssistant })

describe('prompt bar', () => {
  it('opens only on request, owns focus, and gives it back on Escape without scrolling', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus()
    render(AssistantBar); await settle()
    expect(document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(false)
    openAssistant(opener); await settle()
    expect(document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.assistant-bar input'))
    document.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle()
    expect(assistant.open).toBe(false)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('explains how to enable the assistant when it is off or has no key', async () => {
    status = { ...ON, enabled: false, hasKey: false }
    render(AssistantBar); openAssistant(); await settle()
    expect(document.querySelector('.assistant-bar')!.textContent).toMatch(/assistant is off.*Settings, under Advanced/s)
    expect(document.querySelector('.assistant-bar input')).toBeNull()
    document.querySelector<HTMLButtonElement>('.setup button')!.click(); await settle()
    expect(player.view).toBe('settings'); expect(assistant.open).toBe(false)
    player.view = ''
    status = { ...ON, hasKey: false }; assistant.status = undefined
    openAssistant(); await settle()
    expect(document.querySelector('.assistant-bar')!.textContent).toContain('no key yet')
  })

  it('asks for a model before offering a local assistant', async () => {
    status = { ...ON, provider: 'local', model: '', hasKey: false }
    render(AssistantBar); openAssistant(); await settle()
    expect(document.querySelector('.assistant-bar')!.textContent).toContain('no model yet')
    expect(document.querySelector('.assistant-bar input')).toBeNull()
  })

  it('keeps the bar open with the message and the typed request when the call fails', async () => {
    api.ask.mockRejectedValueOnce(new Error('The API key was not accepted. Check it in Settings.'))
    render(AssistantBar); openAssistant(); await settle()
    type('something calm'); submit(); await settle()
    expect(document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true)
    expect(document.querySelector('[role=alert]')!.textContent).toContain('API key was not accepted')
    expect(document.querySelector<HTMLInputElement>('.assistant-bar input')!.value).toBe('something calm')
    expect(api.ask.mock.calls[0][0].request).toBe('something calm')
  })

  it('shows the latest answer only: a late reply to an earlier question is dropped', async () => {
    let first!: (value: AssistantReply) => void
    api.ask.mockImplementationOnce(() => new Promise<AssistantReply>(resolve => { first = resolve })).mockResolvedValueOnce(reply('second answer'))
    render(AssistantBar); openAssistant(); await settle()
    type('one'); submit(); await settle()
    expect(api.ask).toHaveBeenCalledTimes(1)
    type('two'); submit(); await settle()
    first(reply('first answer')); await settle()
    expect(document.querySelector('[aria-label=Answer]')!.textContent).toContain('second answer')
    expect(document.body.textContent).not.toContain('first answer')
    expect(api.cancel).toHaveBeenCalled()
  })

  it('counts playable tracks and hides queue actions when none are playable', async () => {
    const fixtureTrack = (id: string, available: boolean): Track => ({ id, rawId: id, source: 'local', title: id, cover: '', available })
    const playable = fixtureTrack('fixture-track-a', true)
    const offline = fixtureTrack('fixture-track-b', false)
    const response: AssistantReply = {
      ...reply('Here is a queue.'),
      queue: [playable, offline].map(track => ({ occurrenceId: track.id, albumId: 'fixture-album', title: track.title })),
    }
    api.ask.mockResolvedValueOnce(response).mockResolvedValueOnce(response)
    vi.mocked(tracksByOccurrence).mockResolvedValueOnce([playable, offline]).mockResolvedValueOnce([offline])
    render(AssistantBar)
    openAssistant()
    await vi.waitFor(() => expect(document.querySelector('.assistant-bar input')).toBeTruthy())
    type('fixture queue')
    submit()
    await vi.waitFor(() => expect(document.querySelector('.actions')?.textContent).toContain('Play 1 track'))

    submit()
    await vi.waitFor(() => expect(document.querySelector('[aria-label=Answer]')?.textContent).toContain('None of these tracks can be played right now.'))
    expect(document.querySelector('.actions')).toBeNull()
  })

  it('cancels a pending request when closed, and shows tool steps plainly', async () => {
    api.ask.mockImplementationOnce(() => new Promise(() => {}))
    render(AssistantBar); openAssistant(); await settle()
    type('x'); submit(); await settle()
    expect(document.querySelector('[role=status]')!.textContent).toContain('Choosing music')
    document.querySelector<HTMLDialogElement>('dialog')!.close(); await settle()
    expect(api.cancel).toHaveBeenCalled()
    expect(assistant.busy).toBe(false)
    api.ask.mockResolvedValueOnce({ ...reply('Nothing fits.'), steps: [{ tool: 'build_queue', ok: false, detail: 'Invalid build_queue input.length: out of range' }] })
    openAssistant(); await settle(); type('y'); submit(); await settle()
    expect(document.querySelector('.steps .failed')!.textContent).toContain('failed: Invalid build_queue')
  })

  it('cancels on library teardown and stays closed when the library returns', async () => {
    let resolveAnswer!: (answer: AssistantReply) => void
    api.ask.mockImplementationOnce(() => new Promise<AssistantReply>(resolve => { resolveAnswer = resolve }))
    const view = render(AssistantBar)
    openAssistant()
    await vi.waitFor(() => expect(document.querySelector('.assistant-bar input')).toBeTruthy())
    type('fixture request')
    submit()
    await vi.waitFor(() => expect(api.ask).toHaveBeenCalledTimes(1))

    await view.unmount()
    expect(api.cancel).toHaveBeenCalledWith(api.ask.mock.calls[0][0].id)
    expect(assistant.busy).toBe(false)
    resolveAnswer(reply('late answer'))
    render(AssistantBar)
    await tick()
    expect(assistant.reply).toBeUndefined()
    expect(document.querySelector<HTMLDialogElement>('.assistant-bar')?.open).toBe(false)
  })
})

describe('assistant settings', () => {
  it('clears a draft key when switching providers and saves the new model without it', async () => {
    assistant.status = status
    api.save.mockImplementation(async (change: AssistantChange) => {
      const provider = change.provider ?? status.provider
      status = { ...status, provider, model: change.model ?? status.models[provider], hasKey: !!change.apiKey }
      return status
    })
    render(AssistantSettings)
    await vi.waitFor(() => expect(document.querySelector('input[type=password]')).toBeTruthy())
    const key = document.querySelector<HTMLInputElement>('input[type=password]')!
    key.value = 'fixture-unsaved-key'
    key.dispatchEvent(new Event('input', { bubbles: true }))

    const [, local] = document.querySelectorAll<HTMLInputElement>('input[name=assistant-provider]')
    local.click()
    await vi.waitFor(() => expect(document.querySelector('input[type=url]')).toBeTruthy())
    expect(document.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('')
    const model = document.querySelector<HTMLInputElement>('input[type=text]')!
    model.value = 'fixture-model'
    model.dispatchEvent(new Event('input', { bubbles: true }))
    const save = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save')!
    save.click()
    expect(api.save.mock.calls.at(-1)?.[0]).toEqual({ provider: 'local', model: 'fixture-model', baseUrl: status.baseUrl })
  })

  it('explains where a configured model server receives the request and key', async () => {
    status = { ...ON, provider: 'local', baseUrl: 'http://model.example/v1' }
    assistant.status = status
    render(AssistantSettings)
    await vi.waitFor(() => expect(document.querySelector('input[type=url]')).toBeTruthy())
    const address = document.querySelector<HTMLInputElement>('input[type=url]')!
    expect(address.value).toBe(status.baseUrl)
    expect(address.labels?.[0]?.textContent).toContain('Model server address')
    expect(document.getElementById(address.getAttribute('aria-describedby') ?? '')?.textContent).toContain('HTTP sends them unencrypted.')
  })

  it('is off by default, never shows a saved key, and clears the field after sending it once', async () => {
    status = { ...ON, enabled: false, hasKey: false }
    assistant.status = status
    api.save.mockImplementation(async (change: Record<string, unknown>) => { status = { ...status, enabled: change.enabled === true || status.enabled, hasKey: change.apiKey ? true : status.hasKey }; return status })
    render(AssistantSettings); await settle()
    const toggle = document.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(toggle.checked).toBe(false)
    expect(document.querySelector('input[type=password]')).toBeNull()
    toggle.click(); await settle()
    const key = document.querySelector<HTMLInputElement>('input[type=password]')!
    key.value = 'sk-ant-secret'; key.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    ;[...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Save')!.click(); await settle()
    expect(api.save.mock.calls.at(-1)![0].apiKey).toBe('sk-ant-secret')
    expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
    expect(document.body.textContent).not.toContain('sk-ant-secret')
    expect(document.querySelector<HTMLInputElement>('input[type=password]')!.placeholder).toContain('A key is saved')
    expect(JSON.stringify(assistant.status)).not.toContain('sk-ant')
    expect(JSON.stringify({ ...localStorage })).not.toContain('sk-ant')
  })
})
