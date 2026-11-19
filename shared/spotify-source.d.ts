import type { SourceInput } from './catalog'

export const SPOTIFY_SOURCE_ID: 'spotify'
export const SPOTIFY_CONSENT: 'spotify'
export const SPOTIFY_ID_PREFIX: 'spotify:'
export const SPOTIFY_SOURCE: SourceInput
export function isSpotifyTrackId(value: unknown): value is string
export function spotifyTrackUri(trackId: string): string
export function parseSpotifyTrackUri(uri: unknown): string | undefined
export function spotifyCatalogId(trackId: string): string
export function isSpotifyCatalogId(value: unknown): boolean
