export function currentPageUrl() {
  return new URL(location.href)
}

export function serverUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a server URL without credentials, query parameters or a fragment.')
  }
  return url.href.replace(/\/+$/, '')
}
