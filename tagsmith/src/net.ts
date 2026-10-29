/** Network access for the enrich stage: one paced queue per host, a User-Agent that says who is asking, retries
 *  on 503 and 429, and a disk cache keyed by URL. A rerun asks nothing twice, and answers that were missing
 *  (404) are cached too, so a cached run is offline and gives the same result. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** MusicBrainz and LRCLIB ask for an application name and a contact; the repository is the contact. */
export const USER_AGENT = 'tagsmith/0.1.0 ( https://github.com/snaha/music )'

/** Milliseconds between requests per host: MusicBrainz allows one a second, LRCLIB about 90 a minute. */
export const GAPS: Record<string, number> = {
  'musicbrainz.org': 1100,
  'coverartarchive.org': 250,
  'lrclib.net': 700,
}
const RETRIES = 5
const BACKOFF_MS = 2000
const SECOND = 1000
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY = 429
const HTTP_UNAVAILABLE = 503

export type Fetcher = {
  json: <T>(url: string) => Promise<T | undefined>
  bytes: (url: string) => Promise<Buffer | undefined>
  /** requests that went to the network, as opposed to the cache */
  sent: () => number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fetcher with its cache under `dir`. `offline` answers from the cache only. */
export function fetcher(dir: string, opts: { offline?: boolean; gaps?: Record<string, number> } = {}): Fetcher {
  const gaps = opts.gaps ?? GAPS
  const queues = new Map<string, Promise<unknown>>()
  let sent = 0

  const paced = <T>(host: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(host) ?? Promise.resolve()).then(async () => {
      try {
        return await task()
      } finally {
        await sleep(gaps[host] ?? 0)
      }
    })
    queues.set(host, run.catch(() => undefined))
    return run
  }

  /** The body, or undefined for a 404; throws on anything else after the retries. */
  const get = (url: string): Promise<Buffer | undefined> => {
    const host = new URL(url).hostname
    return paced(host, async () => {
      for (let attempt = 0; ; attempt++) {
        sent++
        let res: Response | undefined
        try {
          res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, image/*' } })
        } catch (e) {
          if (attempt >= RETRIES) throw e
        }
        if (res?.ok) return Buffer.from(await res.arrayBuffer())
        if (res?.status === HTTP_NOT_FOUND) return undefined
        const retry = !res || res.status === HTTP_UNAVAILABLE || res.status === HTTP_TOO_MANY
        if (!retry || attempt >= RETRIES) throw new Error(`${res?.status ?? 'network error'} for ${url}`)
        const after = Number(res?.headers.get('retry-after')) * SECOND
        await sleep(after || BACKOFF_MS * 2 ** attempt)
      }
    })
  }

  const cached = async (url: string, ext: string): Promise<Buffer | undefined> => {
    const host = new URL(url).hostname
    const key = createHash('sha1').update(url).digest('hex')
    const file = join(dir, host, `${key}${ext}`)
    const missing = join(dir, host, `${key}.404`)
    try {
      return await readFile(file)
    } catch {
      // not cached as found
    }
    try {
      await readFile(missing)
      return undefined
    } catch {
      // not cached as missing either
    }
    if (opts.offline) return undefined
    const body = await get(url)
    await mkdir(join(dir, host), { recursive: true })
    await writeFile(body ? file : missing, body ?? '')
    return body
  }

  return {
    json: async <T>(url: string) => {
      const body = await cached(url, '.json')
      return body ? (JSON.parse(body.toString('utf8')) as T) : undefined
    },
    bytes: (url) => cached(url, '.bin'),
    sent: () => sent,
  }
}
