import type { CatalogBridge } from './catalog'

/**
 * The library's catalog for a phone or browser on the LAN: the page's own origin serves a read-only endpoint
 * that the desktop authorizes with the catalog key from a Share link. Playback and covers keep their routes.
 * Without a Kept page behind it, or without a valid session, `open` says so and the music server's catalog serves.
 */
export type LanCatalogClient = Pick<CatalogBridge, 'catalogAlbums' | 'catalogAlbum' | 'catalogSearch' | 'playbackLinks'>
export type LanShare = { origin: string; server: string; key: string }
type Session = { token: string; expiresAt: number }
type Transport = { fetch?: typeof fetch; now?: () => number }
const PREFIX = '/__kept/lan/'
const HTTP_UNAUTHORIZED = 401
// A token is renewed a little early so a request never races its expiry.
const RENEW_MARGIN_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

const isSession = (value: unknown): value is Session => !!value && typeof value === 'object'
  && typeof (value as Session).token === 'string' && typeof (value as Session).expiresAt === 'number'

export function createLanCatalogClient({ origin, server, key }: LanShare, { fetch: send = (...args) => fetch(...args), now = Date.now }: Transport = {}) {
  let session: Session | undefined
  let opening: Promise<Session> | undefined
  const post = async (name: string, body: unknown, token?: string) => {
    const response = await send(`${origin}${PREFIX}${name}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    })
    // A server that is not Kept answers with its page: anything but JSON is "no catalog here".
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('No catalog on this server')
    return { status: response.status, ok: response.ok, body: await response.json() as unknown }
  }
  const open = () => opening ??= (async () => {
    try {
      const result = await post('session', { server, key })
      if (!result.ok || !isSession(result.body)) throw new Error('The library catalog refused this device')
      session = result.body
      return session
    } finally { opening = undefined }
  })()
  const token = async () => (session && session.expiresAt - RENEW_MARGIN_MS > now() ? session : await open()).token
  async function call<T>(operation: string, body: unknown): Promise<T> {
    let result = await post(`catalog/${operation}`, body, await token())
    // The desktop restarted or revoked this device: sign in once more, then give up.
    if (result.status === HTTP_UNAUTHORIZED) { session = undefined; result = await post(`catalog/${operation}`, body, await token()) }
    const value = (result.body as { value?: T }).value
    if (!result.ok || value === undefined) throw new Error('The library catalog is not available')
    return value
  }
  const client: LanCatalogClient = {
    catalogAlbums: request => call('catalog-albums', request),
    catalogAlbum: request => call('catalog-album', request),
    catalogSearch: request => call('catalog-search', request),
    playbackLinks: request => call('playback-links', request),
  }
  return { client, open: async () => { await token(); return client } }
}

type Account = {
  transport: ReturnType<typeof createLanCatalogClient>
  client?: LanCatalogClient
  opening?: Promise<LanCatalogClient | undefined>
}
let account: Account | undefined
export function rememberLanShare(share: LanShare | undefined) {
  account = share && share.origin === location.origin ? { transport: createLanCatalogClient(share) } : undefined
}
export const lanCatalog = () => account?.client
export async function openLanCatalog() {
  const owner = account
  if (!owner || owner.client) return owner?.client
  return owner.opening ??= owner.transport.open().then(client => {
    if (owner !== account) return undefined
    owner.client = client
    return client
  }).catch(() => undefined).finally(() => { owner.opening = undefined })
}
