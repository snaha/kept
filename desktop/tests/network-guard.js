import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

// Makes any outbound request of this process fail and remembers it, so a test can prove that
// nothing was sent. It covers fetch, http, https, raw sockets and name lookups. A connection to
// this machine itself is let through: the test runner and local servers use them.

const LOOPBACK = /^(localhost|127\.|::1$|\[::1\])/
const isLocal = host => host === undefined || LOOPBACK.test(String(host))
const hostOf = args => {
  const [first, second] = args
  if (typeof first === 'string') { try { return new URL(first).hostname } catch { return first } }
  if (first instanceof URL) return first.hostname
  if (Array.isArray(first)) return hostOf(first)
  if (first && typeof first === 'object') return first.path !== undefined ? undefined : first.host ?? first.hostname
  return typeof second === 'string' ? second : undefined
}

export function installNetworkGuard() {
  const attempts = []
  const refuse = (kind, host) => {
    attempts.push({ kind, host: String(host) })
    return new Error(`Network guard: outbound ${kind} to ${host}`)
  }
  const originals = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, connect: net.Socket.prototype.connect, lookup: dns.lookup }
  globalThis.fetch = async (input, ...rest) => {
    const host = hostOf([typeof input === 'object' && input !== undefined && 'url' in input ? input.url : input])
    if (isLocal(host)) return originals.fetch(input, ...rest)
    throw refuse('fetch', host)
  }
  const wrap = (kind, original) => function guarded(...args) {
    const host = hostOf(args)
    if (isLocal(host)) return original.apply(this, args)
    throw refuse(kind, host)
  }
  http.request = wrap('http', originals.httpRequest)
  http.get = wrap('http', originals.httpGet)
  https.request = wrap('https', originals.httpsRequest)
  https.get = wrap('https', originals.httpsGet)
  net.Socket.prototype.connect = wrap('socket', originals.connect)
  dns.lookup = wrap('lookup', originals.lookup)
  return {
    attempts,
    restore() {
      globalThis.fetch = originals.fetch
      http.request = originals.httpRequest
      http.get = originals.httpGet
      https.request = originals.httpsRequest
      https.get = originals.httpsGet
      net.Socket.prototype.connect = originals.connect
      dns.lookup = originals.lookup
    },
  }
}
