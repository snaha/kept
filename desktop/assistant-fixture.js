// A small synthetic library for the assistant's tests and for the manual evaluation: calm and loud
// albums, a live album that exists and one that does not, and two artists with nearly the same name.
// Nothing here is a real collection and the paths are made up.
import { createFakeCatalogService } from '../shared/catalog-fake.js'
import { createFakeFeatureSource } from '../shared/feature-fake.js'
import { createToolRunner } from '../shared/tool-runner.js'

export const FIXTURE_FOLDER = '/Users/example/Private Music'
const T1 = 1000
const SIZE = 4096
const SECONDS = 200
const TRACKS = 4
const PLAYED_OFTEN = 40
const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }

export const ALBUMS = {
  stillwater: { artist: 'Marlow', title: 'Still Water', vector: [1, 0, 0], traits: { energy: 15, mood: 70, vocal: 30, acoustic: 85 }, plays: PLAYED_OFTEN, favorite: true },
  slowtide: { artist: 'Marlow', title: 'Slow Tide', vector: [0.95, 0.2, 0], traits: { energy: 20, mood: 65, vocal: 20, acoustic: 80 }, plays: 0 },
  overdrive: { artist: 'Gamma Rays', title: 'Overdrive', vector: [0, 1, 0], traits: { energy: 92, mood: 40, vocal: 80, acoustic: 10 }, plays: 3 },
  overdrivelive: { artist: 'Gamma Rays', title: 'Overdrive Live', vector: [0.1, 0.95, 0], traits: { energy: 95, mood: 45, vocal: 80, acoustic: 10 }, plays: 0 },
  blue: { artist: 'Alpha', title: 'Blue', vector: [0.7, 0.3, 0.2], traits: { energy: 50, mood: 50, vocal: 60, acoustic: 50 }, plays: 5 },
  latehours: { artist: 'Delta Quartet', title: 'Late Hours', vector: [0.8, 0, 0.5], traits: { energy: 25, mood: 60, vocal: 5, acoustic: 95 }, plays: 1, favorite: true },
  needlewalk: { artist: 'Veskivox 9Q', title: 'Veskivox Needlewalk', vector: [0.1, 0.8, 0.4], traits: { energy: 85, mood: 35, vocal: 85, acoustic: 15 }, plays: 8 },
  plumeclock: { artist: 'Veskivox 9Q Annex', title: 'Veskivox Plumeclock', vector: [0.5, 0.3, 0.7], traits: { energy: 55, mood: 55, vocal: 70, acoustic: 40 }, plays: 0 },
  workout: { artist: 'Pulse Unit', title: 'Cardio', vector: [0, 0.9, 0.3], traits: { energy: 98, mood: 60, vocal: 10, acoustic: 5 }, plays: 12 },
}
export const KEYS = Object.keys(ALBUMS)

export async function createAssistantWorld() {
  const catalog = createFakeCatalogService()
  await catalog.registerSource(folder)
  await catalog.registerSource(navidrome)
  const files = KEYS.flatMap(key => Array.from({ length: TRACKS }, (_, index) => {
    const { artist, title } = ALBUMS[key]
    return {
      path: `Collection/${artist}/${title}/0${index + 1}.flac`, contentHash: `hash-${key}-${index}`, size: SIZE, duration: SECONDS, track: index + 1,
      providerTrackId: `nd-${key}-${index}`, providerAlbumId: `nd-${key}`, tags: { title: `${title} ${index + 1}`, artist, album: title, albumArtist: artist },
    }
  }))
  await catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files })
  const ids = {}, tracks = {}
  for (const key of KEYS) {
    const { subject } = await catalog.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: `nd-${key}` })
    ids[key] = subject.id
    tracks[key] = (await catalog.getCatalogAlbum({ albumId: subject.id })).album.tracks.map(track => track.id)
    for (const [trait, value] of Object.entries(ALBUMS[key].traits)) await catalog.recordUserDecision({ kind: 'trait', subject: { kind: 'album', id: subject.id }, trait, value, decidedAt: T1 })
    if (ALBUMS[key].favorite) await catalog.recordUserDecision({ kind: 'favorite', subject: { kind: 'album', id: subject.id }, value: true, decidedAt: T1 })
  }
  const features = createFakeFeatureSource({ albums: Object.fromEntries(KEYS.map(key => [ids[key], ALBUMS[key].vector])) })
  const history = { albumStats: async () => Object.fromEntries(KEYS.map(key => [ids[key], { plays: ALBUMS[key].plays, lastPlayed: T1 }])) }
  const runner = createToolRunner({ catalog, features, history })
  return { catalog, runner, ids, tracks, folder: FIXTURE_FOLDER }
}
