import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { createRawSnippet, tick } from 'svelte'
import type { SubsonicAPI } from 'subsonic-api'
import { session } from './api.svelte'
import { catalogSearch, disposeCatalogSearch, startCatalogSearch } from './catalog-search.svelte'
import CatalogSearch from './CatalogSearch.svelte'
import { spotify, type SpotifyBridge } from './spotify.svelte'
import type { SpotifySearchResult } from './spotify-track'
import type { Collection } from './music'

const SEARCH_SETTLED_MS = 600
const SPOTIFY_QUERY_LIMIT = 200
const RESULT = (id: string, title: string): SpotifySearchResult => ({ id, title, artist: 'Fixture artist', album: 'Fixture album', duration: 200 })
const FIRST = RESULT('keptSpotifySearch0001', 'Fixture moon song')
const SECOND = RESULT('keptSpotifySearch0002', 'Fixture moon dance')
const initialApi = session.api

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const settle = () => new Promise(resolve => setTimeout(resolve, SEARCH_SETTLED_MS))
const renderSearch = () => {
  const card = createRawSnippet((tile: () => Collection) => ({ render: () => `<div>${tile().title}</div>` }))
  return render(CatalogSearch, { kind: 'all', top: 0, cols: 4, gap: 12, card, onartist: () => {}, onclear: () => {} })
}

let search: ReturnType<typeof vi.fn<SpotifyBridge['search']>>
beforeEach(() => {
  expect(session.api, 'no local server is signed in, so only Spotify answers').toBeFalsy()
  Object.assign(spotify, { connected: true, account: 'fixture-account', signingOut: false })
  search = vi.fn(async () => [FIRST, SECOND])
  vi.stubGlobal('musicSpotify', { search })
})
afterEach(() => {
  cleanup()
  disposeCatalogSearch()
  catalogSearch.spotifyTracks = []
  session.api = initialApi
  Object.assign(spotify, { connected: false, account: '' })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('signed in and online, the library search also asks Spotify once typing settles', async () => {
  for (const query of ['m', 'mo', 'moo', 'moon']) startCatalogSearch(query, 'all')
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks.map(track => track.rawId)).toEqual([FIRST.id, SECOND.id]))
  expect(search.mock.calls).toEqual([['moon']])
  expect(catalogSearch.spotifyTracks.every(track => track.source === 'spotify' && track.catalogRef?.kind === 'spotify')).toBe(true)
  expect(catalogSearch.spotifyLoading).toBe(false)
})

test('a local refresh of the same query neither cancels nor repeats the Spotify request', async () => {
  const answer = deferred<SpotifySearchResult[]>()
  search.mockImplementation(() => answer.promise)
  startCatalogSearch('moon', 'all')
  await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
  startCatalogSearch('moon', 'all') // a scan bumped the library revision
  answer.resolve([FIRST])
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks.map(track => track.rawId)).toEqual([FIRST.id]))
  await settle()
  expect(search).toHaveBeenCalledTimes(1)
})

test('a late answer for an abandoned query never replaces the current one', async () => {
  const old = deferred<SpotifySearchResult[]>()
  search.mockImplementationOnce(() => old.promise).mockImplementationOnce(async () => [SECOND])
  startCatalogSearch('moon', 'all')
  await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
  startCatalogSearch('moon dance', 'all')
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks.map(track => track.rawId)).toEqual([SECOND.id]))
  old.resolve([FIRST])
  await settle()
  expect(catalogSearch.spotifyTracks.map(track => track.rawId)).toEqual([SECOND.id])
})

test('Spotify stays out when signed out, offline or browsing local music only', async () => {
  spotify.connected = false
  startCatalogSearch('moon', 'all')
  spotify.connected = true
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  startCatalogSearch('moon dance', 'all')
  vi.restoreAllMocks()
  startCatalogSearch('moon light', 'local')
  await settle()
  expect(search).not.toHaveBeenCalled()
  expect(catalogSearch.spotifyTracks).toEqual([])
  expect(catalogSearch.spotifyLoading).toBe(false)
})

test('same-query local refresh preserves the Spotify failure and the Retry button asks again', async () => {
  search.mockRejectedValueOnce(new Error('Spotify is rate limiting requests.'))
  startCatalogSearch('moon', 'all')
  const results = renderSearch()
  await expect.element(results.getByRole('alert')).toHaveTextContent(/Spotify.*rate limiting/)
  startCatalogSearch('moon', 'all') // a scan bumped the library revision
  await settle()
  expect(search).toHaveBeenCalledTimes(1)
  await expect.element(results.getByRole('alert')).toHaveTextContent(/Spotify.*rate limiting/)
  startCatalogSearch('moon', 'local')
  await expect.element(results.getByRole('alert')).not.toBeInTheDocument()
  startCatalogSearch('moon', 'all')
  await expect.element(results.getByRole('alert')).toHaveTextContent(/Spotify.*rate limiting/)
  await results.getByRole('button', { name: 'Retry search' }).click()
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks).toHaveLength(2))
  expect(search).toHaveBeenCalledTimes(2)
  await expect.element(results.getByRole('alert')).not.toBeInTheDocument()
})

test('changing the Spotify account retries the same query after a failure', async () => {
  search.mockRejectedValueOnce(new Error('Fixture account cannot search'))
  startCatalogSearch('moon', 'all')
  await vi.waitFor(() => expect(catalogSearch.spotifyError).toContain('Fixture account cannot search'))
  spotify.account = 'fixture-other-account'
  startCatalogSearch('moon', 'all')
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks).toHaveLength(2))
  expect(search.mock.calls).toEqual([['moon'], ['moon']])
  expect(catalogSearch.spotifyError).toBe('')
})

test('an overlong query reaches local search in full and offers no Spotify Retry', async () => {
  search.mockRejectedValueOnce(new Error('Enter a search of up to 200 characters.'))
  const search3 = vi.fn(async () => ({ status: 'ok', searchResult3: {} }))
  session.api = { search3, getPlaylists: async () => ({ status: 'ok', playlists: {} }) } as unknown as SubsonicAPI
  const results = renderSearch()
  const query = 'z'.repeat(SPOTIFY_QUERY_LIMIT + 1)
  startCatalogSearch(query, 'all')
  await vi.waitFor(() => expect(search3).toHaveBeenCalledWith(expect.objectContaining({ query })))
  await settle()
  expect(search).not.toHaveBeenCalled()
  await expect.element(results.getByRole('button', { name: 'Retry search' })).not.toBeInTheDocument()
})

test('Spotify songs render in their own section, labelled, with play and queue actions', async () => {
  startCatalogSearch('moon', 'all')
  await vi.waitFor(() => expect(catalogSearch.spotifyTracks).toHaveLength(2))
  renderSearch()
  await tick()
  const section = document.querySelector('[aria-label="Spotify song results"]')!
  expect(section.querySelector('h2')?.textContent).toContain('On Spotify')
  expect([...section.querySelectorAll('.song-source')].map(label => label.textContent)).toEqual(['Spotify', 'Spotify'])
  expect(section.querySelector(`[aria-label="Play ${FIRST.title}"]`)).not.toBeNull()
  expect(section.querySelector(`[aria-label="Add ${FIRST.title} to queue"]`)).not.toBeNull()
  expect(document.querySelector('header p')?.textContent).toContain('Your music and Spotify')
})
