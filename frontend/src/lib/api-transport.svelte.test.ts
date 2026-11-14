import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-svelte'
import { login, logout, restore, session } from './api.svelte'
import Login from './Login.svelte'

const SERVER = 'https://library.example/music'
const LAN_SERVER = 'http://192.168.1.10:4533'
const CREDS = { url: SERVER, username: 'share', password: 'synthetic-password' }
const requests: { url: string; init?: RequestInit }[] = []
let originalUrl = ''

beforeEach(() => {
  originalUrl = location.href
  localStorage.clear()
  logout()
  session.error = ''
  session.admin = false
  vi.stubGlobal('desktop', undefined)
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith('/auth/login')) return Response.json({ token: 'native-token' })
    return Response.json({ 'subsonic-response': {
      status: 'ok', version: '1.16.1', user: { username: 'share', adminRole: false },
    } })
  }))
})
afterEach(() => {
  cleanup()
  logout()
  session.error = ''
  history.replaceState(undefined, '', originalUrl)
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fragment(url: string) {
  const hash = new URLSearchParams({ u: CREDS.username, p: CREDS.password, s: url })
  history.replaceState(undefined, '', `${location.pathname}${location.search}#${hash}`)
}

describe('credential destinations', () => {
  for (const server of ['ftp://library.example', 'javascript:alert(1)', 'https://user:password@library.example', `${SERVER}?token=secret`, `${SERVER}#fragment`]) {
    it(`rejects invalid server URL ${server} before sending credentials`, async () => {
      await expect(login({ ...CREDS, url: server })).rejects.toThrow('server URL')
      expect(requests).toHaveLength(0)
      expect(localStorage.length).toBe(0)
    })
  }
  for (const server of [SERVER, LAN_SERVER, 'http://100.64.1.10:4533']) {
    it(`logs in to ${server} and rejects redirects for REST and native authentication`, async () => {
      await login({ ...CREDS, url: server })
      expect(session.username).toBe('share')
      expect(session.base).toBe(server)
      expect(session.admin).toBe(false)
      await expect(session.api!.navidromeSession()).resolves.toEqual({ token: 'native-token' })
      expect(requests.some(request => request.url === `${server}/auth/login`)).toBe(true)
      expect(requests.every(request => request.url.startsWith(`${server}/`))).toBe(true)
      expect(requests.every(request => request.init?.redirect === 'error')).toBe(true)
      expect(JSON.parse(localStorage.getItem('creds')!)).toEqual({ ...CREDS, url: server })
    })
  }
  it('logs in on an HTTP phone with getRandomValues but no randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    await login({ ...CREDS, url: LAN_SERVER })
    expect(session.base).toBe(LAN_SERVER)
    expect(localStorage.getItem('auth.salt')).toMatch(/^[a-f0-9]{32}$/)
    expect(new URLSearchParams(session.authQs).get('s')).toBe(localStorage.getItem('auth.salt'))
  })
  it('preserves desktop restore from its local status endpoint', async () => {
    vi.stubGlobal('desktop', { status: async () => ({ ...CREDS, phase: 'ready', url: 'http://127.0.0.1:4533' }) })
    await restore()
    expect(session.base).toBe('http://127.0.0.1:4533')
    expect(session.error).toBe('')
    expect(requests.length).toBeGreaterThan(0)
  })
})

describe('shared and saved credential restoration', () => {
  for (const server of [LAN_SERVER, SERVER]) {
    for (const source of ['fragment', 'saved']) {
      it(`restores ${source} credentials for ${server}`, async () => {
        if (source === 'fragment') fragment(server)
        else localStorage.setItem('creds', JSON.stringify({ ...CREDS, url: server }))
        await restore()
        expect(session.username).toBe('share')
        expect(session.base).toBe(server)
        expect(session.api).toBeTruthy()
        expect(session.error).toBe('')
        expect(location.hash).toBe('')
      })
    }
  }
  it('clears a rejected sharing fragment and shows its error on Login', async () => {
    fragment('ftp://library.example')
    await restore()
    expect(requests).toHaveLength(0)
    expect(location.hash).toBe('')
    expect(session.api).toBeFalsy()
    const view = render(Login)
    await expect.element(view.getByRole('alert')).toHaveTextContent('Use a server URL')
  })
})
