// Spotify as a playback-only provider. Its source can never be analysed, and it needs the user's
// own sign-in (the 'spotify' consent) before anything reaches the network. Types: spotify-source.d.ts.
export const SPOTIFY_SOURCE_ID = 'spotify'
export const SPOTIFY_CONSENT = 'spotify'
export const SPOTIFY_ID_PREFIX = 'spotify:'
const TRACK_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/
const TRACK_URI_PATTERN = /^spotify:track:([A-Za-z0-9]{1,64})$/

export const SPOTIFY_SOURCE = Object.freeze({
  id: SPOTIFY_SOURCE_ID, kind: 'spotify', label: 'Spotify', evidenceClass: 'deterministic', licence: 'proprietary',
  policy: Object.freeze({ analysisAllowed: false, network: 'internet', consent: SPOTIFY_CONSENT }),
})

export const isSpotifyTrackId = value => typeof value === 'string' && TRACK_ID_PATTERN.test(value)
export const spotifyTrackUri = trackId => `spotify:track:${trackId}`
export const parseSpotifyTrackUri = uri => (typeof uri === 'string' ? TRACK_URI_PATTERN.exec(uri)?.[1] : undefined)
// The catalog entity of a Spotify track. It never enters the identity spine: it names a queue or history entry.
export const spotifyCatalogId = trackId => `${SPOTIFY_ID_PREFIX}track:${trackId}`
export const isSpotifyCatalogId = value => typeof value === 'string' && value.startsWith(SPOTIFY_ID_PREFIX)
