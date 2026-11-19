import type { Track } from './music.ts'
import { spotifyCatalogId } from '../../../shared/spotify-source.js'

export type SpotifySearchResult = { id: string; title: string; artist: string; album: string; duration: number }

// A Spotify track as a queue occurrence. Only the id and display text are kept: no cover, no audio, no analysis.
// The catalog ref names the Spotify entity, and the resolver turns it into a Spotify playback ref at play time.
export const spotifyTrack = (result: SpotifySearchResult): Track => ({
  id: spotifyCatalogId(result.id), rawId: result.id, source: 'spotify', title: result.title, artist: result.artist, album: result.album,
  cover: '', duration: result.duration, available: true, catalogRef: { kind: 'spotify', id: result.id },
})
