import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsonicAPI } from 'subsonic-api'
import { session } from './api.svelte'
import { shareLink } from './sharing.svelte'
import { currentPageUrl } from './connection-security'
import { cleanup, render } from 'vitest-browser-svelte'
import Share from './Share.svelte'

vi.mock('./connection-security', { spy: true })

const HTTP_NO_CONTENT = 204
const HTTP_FORBIDDEN = 403
const WEB_PORT = 8765
const SERVER_PORT = 4533
const BASE = 'https://library.example/music'
const LEGACY_PASSWORD = 'legacy-secret-from-another-server'
const PROFILE_PASSWORD = 'desktop-profile-secret'
const USER = { id: 'share-id', userName: 'share', name: 'Family', isAdmin: false }
const key = (base = BASE, username = 'admin') => `share.password.v2:${JSON.stringify([base, username])}`
const params = (link: string) => new URLSearchParams(new URL(link).hash.slice(1))
const auth = vi.fn(async () => ({ token: 'fixture-token' }))
const requests: { url: string; init: RequestInit }[] = []
let users: unknown = []
let writeStatus = HTTP_NO_CONTENT

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('desktop', undefined)
  vi.mocked(currentPageUrl).mockReturnValue(new URL('https://music.example/library/'))
  auth.mockReset().mockResolvedValue({ token: 'fixture-token' })
  session.api = { navidromeSession: auth } as unknown as SubsonicAPI
  session.username = 'admin'
  session.base = BASE
  session.admin = true
  users = []
  writeStatus = HTTP_NO_CONTENT
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return init.method ? new Response(undefined, { status: writeStatus }) : Response.json(users)
  }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('sharing account authority', () => {
  for (const cached of [false, true]) {
    it(`rejects an existing administrator before mutation or export (cached=${cached})`, async () => {
      users = [{ ...USER, isAdmin: true }]
      if (cached) localStorage.setItem(key(), 'cached-password')
      await expect(shareLink()).rejects.toThrow('is an administrator')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.init.method).toBeUndefined()
    })
  }
  it('creates a restricted account and exports exactly its password', async () => {
    const link = params(await shareLink())
    const write = requests.at(-1)!
    expect(write.url).toBe(`${BASE}/api/user`)
    expect(write.init.method).toBe('POST')
    expect(JSON.parse(String(write.init.body))).toEqual({ userName: 'share', name: 'Share', password: link.get('p'), isAdmin: false })
    expect(link.get('s')).toBe(BASE)
    expect(localStorage.getItem(key())).toBe(link.get('p'))
    expect(write.init.redirect).toBe('error')
  })
  it('rekeys a restricted account without discarding its settings', async () => {
    users = [{ ...USER, id: 'id/with/slash', customSetting: 'preserve' }]
    localStorage.setItem(key(), 'scoped-password')
    expect(params(await shareLink()).get('p')).toBe('scoped-password')
    const write = requests.at(-1)!
    expect(write.url).toBe(`${BASE}/api/user/id%2Fwith%2Fslash`)
    expect(write.init.method).toBe('PUT')
    expect(JSON.parse(String(write.init.body))).toEqual({ ...USER, id: 'id/with/slash', customSetting: 'preserve', password: 'scoped-password', isAdmin: false })
  })
  it('does not export when the server rejects an account update', async () => {
    users = [USER]
    writeStatus = HTTP_FORBIDDEN
    await expect(shareLink()).rejects.toThrow('403')
  })
  for (const response of [{}, [{ id: 'share-id', userName: 'share' }], [{ ...USER, isAdmin: 'false' }]]) {
    it('fails closed for a malformed account response', async () => {
      users = response
      await expect(shareLink()).rejects.toThrow('invalid sharing account')
      expect(requests).toHaveLength(1)
    })
  }
  it('rejects a non-admin caller before authentication', async () => {
    session.admin = false
    await expect(shareLink()).rejects.toThrow('administrator')
    expect(auth).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })
})

describe('sharing credential ownership', () => {
  it('ignores the legacy password and keeps server, base path and account passwords separate', async () => {
    localStorage.setItem('share.password', LEGACY_PASSWORD)
    const initial = params(await shareLink()).get('p')
    expect(initial).toBeTruthy()
    expect(initial).not.toBe(LEGACY_PASSWORD)
    for (const [base, username] of [
      ['https://attacker.example/music', 'admin'],
      ['https://library.example/another-library', 'admin'],
      [BASE, 'another-admin'],
    ] as const) {
      session.base = base
      session.username = username
      const password = params(await shareLink()).get('p')
      expect(password).not.toBe(initial)
      expect(password).not.toBe(LEGACY_PASSWORD)
      expect(JSON.parse(String(requests.at(-1)!.init.body)).password).toBe(password)
    }
    session.base = 'https://LIBRARY.example:443/music/'
    session.username = 'admin'
    expect(params(await shareLink()).get('p')).toBe(initial)
  })
  it('exports the desktop LAN link without copying its profile password into browser preferences', async () => {
    const status = vi.fn(async () => ({ url: BASE, username: 'admin', share: { password: PROFILE_PASSWORD, port: SERVER_PORT, webPort: WEB_PORT } }))
    vi.stubGlobal('desktop', {
      status,
      lanIp: async () => '192.0.2.10',
    })
    const link = new URL(await shareLink())
    expect(link.origin).toBe(`http://192.0.2.10:${WEB_PORT}`)
    expect(params(link.href).get('s')).toBe(`http://192.0.2.10:${SERVER_PORT}`)
    expect(params(link.href).get('p')).toBe(PROFILE_PASSWORD)
    expect(status).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })
  it('does not send a desktop profile password to a different active server', async () => {
    vi.stubGlobal('desktop', {
      status: async () => ({ url: BASE, username: 'admin', share: { password: PROFILE_PASSWORD, port: SERVER_PORT, webPort: WEB_PORT } }),
    })
    session.base = 'https://attacker.example'
    await expect(shareLink()).rejects.toThrow('own library')
    expect(auth).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })
  it('stops before a write if the account changes while user lookup is pending', async () => {
    const lookup = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => lookup.promise))
    const result = shareLink()
    const rejection = expect(result).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    session.username = 'another-admin'
    lookup.resolve(Response.json([]))
    await rejection
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('cancels a superseded attempt while retaining a stable password', async () => {
    const pending = deferred<{ token: string }>()
    auth.mockImplementationOnce(() => pending.promise)
    const old = shareLink()
    const rejection = expect(old).rejects.toThrow('cancelled')
    const password = localStorage.getItem(key())
    const next = params(await shareLink())
    pending.resolve({ token: 'old-token' })
    await rejection
    expect(next.get('p')).toBe(password)
    expect(requests).toHaveLength(2)
  })
  it('cancels a closed share view before sending user-management requests', async () => {
    const pending = deferred<{ token: string }>()
    auth.mockImplementationOnce(() => pending.promise)
    const controller = new AbortController()
    const result = shareLink(controller.signal)
    const rejection = expect(result).rejects.toThrow('cancelled')
    controller.abort()
    pending.resolve({ token: 'old-token' })
    await rejection
    expect(requests).toHaveLength(0)
  })
})

describe('home network sharing', () => {
  it('creates an HTTP LAN link on a phone without randomUUID', async () => {
    vi.mocked(currentPageUrl).mockReturnValue(new URL('http://192.168.1.10:8080/library/'))
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    session.base = 'http://192.168.1.10:4533/music'
    const link = new URL(await shareLink())
    expect(link.origin + link.pathname).toBe('http://192.168.1.10:8080/library/')
    expect(params(link.href).get('s')).toBe(session.base)
    expect(params(link.href).get('p')).toMatch(/^[a-f0-9]{32}$/)
  })
  it('keeps HTTPS hostnames and base paths unchanged, including localhost', async () => {
    vi.mocked(currentPageUrl).mockReturnValue(new URL('https://localhost/library/'))
    session.base = 'https://localhost/music'
    const link = new URL(await shareLink())
    expect(link.origin + link.pathname).toBe('https://localhost/library/')
    expect(params(link.href).get('s')).toBe(session.base)
    expect(requests.every(request => new URL(request.url).protocol === 'https:')).toBe(true)
  })
  it('shows the home-network tradeoff alongside the HTTP QR code', async () => {
    vi.mocked(currentPageUrl).mockReturnValue(new URL('http://192.168.1.10/'))
    session.base = 'http://192.168.1.10:4533'
    const view = render(Share, { onclose: vi.fn() })
    await expect.element(view.getByRole('img')).toBeVisible()
    await expect.element(view.getByText('HTTP is not encrypted on ordinary Wi-Fi.', { exact: false })).toBeVisible()
  })
  it('does not label an HTTPS link as unencrypted', async () => {
    const view = render(Share, { onclose: vi.fn() })
    await expect.element(view.getByRole('img')).toBeVisible()
    await expect.element(view.getByText('HTTP is not encrypted on ordinary Wi-Fi.', { exact: false })).not.toBeInTheDocument()
  })
})
