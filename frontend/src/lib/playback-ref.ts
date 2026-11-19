import type { CatalogRef, Track } from './music.ts'

// What the audio element needs. Today that is a Navidrome song id behind the stream endpoint.
export type PlaybackRef = { kind: 'navidrome-stream'; songId: string }

// Queue entries and history keep catalog refs. A playback ref is derived at play time, never stored.
export const trackCatalogRef = (track: Pick<Track, 'rawId' | 'catalogRef'>): CatalogRef => track.catalogRef ?? { kind: 'navidrome', id: track.rawId }

const refKey = (ref: CatalogRef) => `${ref.kind}\n${ref.id}`

// Resolution is synchronous so it never adds an await to play or skip. A virtual provider
// registers the playback ref of every asset it hands out, so it is known before the user plays.
export type PlaybackResolver = {
  resolve(ref: CatalogRef): PlaybackRef | undefined
  update(ref: CatalogRef, playback: PlaybackRef | undefined, version: number): void
}
export function createPlaybackResolver(): PlaybackResolver {
  const known = new Map<string, { playback: PlaybackRef | undefined; version: number }>()
  return {
    // A Navidrome ref is its own playback ref.
    resolve: ref => ref.kind === 'navidrome' ? { kind: 'navidrome-stream', songId: ref.id } : known.get(refKey(ref))?.playback,
    update(ref, playback, version) {
      const key = refKey(ref)
      const current = known.get(key)
      if (!current || version >= current.version) known.set(key, { playback, version })
    },
  }
}
export const playbackResolver = createPlaybackResolver()
export const resolveTrackPlayback = (track: Pick<Track, 'rawId' | 'catalogRef'>) => playbackResolver.resolve(trackCatalogRef(track))
