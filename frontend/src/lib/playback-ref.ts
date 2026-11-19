import type { CatalogRef, Track } from './music'
import { isSpotifyTrackId } from '../../../shared/spotify-source.js'

// What a playback adapter needs: a Navidrome song id behind the stream endpoint for the audio element,
// or a Spotify track id for the Spotify adapter (played on the user's own Spotify device).
export type PlaybackRef = { kind: 'navidrome-stream'; songId: string } | { kind: 'spotify-track'; trackId: string }

// Queue entries and history keep catalog refs. A playback ref is derived at play time, never stored.
export const trackCatalogRef = (track: Pick<Track, 'rawId' | 'catalogRef'>): CatalogRef => track.catalogRef ?? { kind: 'navidrome', id: track.rawId }

const refKey = (ref: CatalogRef) => `${ref.kind}\n${ref.id}`

// Resolution is synchronous so it never adds an await to play or skip. A virtual provider
// registers the playback ref of every asset it hands out, so it is known before the user plays.
export type PlaybackResolver = {
  resolve(ref: CatalogRef): PlaybackRef | undefined
  update(ref: CatalogRef, playback: PlaybackRef | undefined, version: number): void
  register(ref: CatalogRef, playback: PlaybackRef): void
  forget(ref: CatalogRef): void
  clear(): void
}
export function createPlaybackResolver(): PlaybackResolver {
  const known = new Map<string, { playback: PlaybackRef | undefined; version: number }>()
  const nextVersion = (ref: CatalogRef) => (known.get(refKey(ref))?.version ?? -1) + 1
  const update: PlaybackResolver['update'] = (ref, playback, version) => {
    const key = refKey(ref)
    const current = known.get(key)
    if (!current || version >= current.version) known.set(key, { playback, version })
  }
  return {
    // Navidrome and valid Spotify refs contain their own playback IDs.
    resolve: ref => ref.kind === 'navidrome' ? { kind: 'navidrome-stream', songId: ref.id }
      : ref.kind === 'spotify' ? (isSpotifyTrackId(ref.id) ? { kind: 'spotify-track', trackId: ref.id } : undefined)
      : known.get(refKey(ref))?.playback,
    update,
    register: (ref, playback) => update(ref, playback, nextVersion(ref)),
    // Keep the version so an older response cannot restore a forgotten mapping.
    forget: ref => update(ref, undefined, nextVersion(ref)),
    clear: () => known.clear(),
  }
}
export const playbackResolver = createPlaybackResolver()
export const resolveTrackPlayback = (track: Pick<Track, 'rawId' | 'catalogRef'>) => playbackResolver.resolve(trackCatalogRef(track))
