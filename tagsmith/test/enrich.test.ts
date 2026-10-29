import { describe, expect, it } from 'vitest'
import { categorize } from '../src/categories.ts'
import { enrich, similarity, titleMatch } from '../src/enrich.ts'
import { classify, type Folder, type Inventory } from '../src/inventory.ts'
import type { Fetcher } from '../src/net.ts'
import { plan } from '../src/rules.ts'
import { emptyTags, type FileInfo, type Tags } from '../src/tags.ts'

const ROOT = '/m'
const MS = 1000

const file = (dir: string, name: string, tags: Partial<Tags>, duration: number): FileInfo => ({
  path: `${dir}/${name}`,
  tags: { ...emptyTags(), ...tags },
  extra: {},
  raw: { 'ID3v2.3': [] },
  duration,
  pictures: [],
})

const folder = (dir: string, files: FileInfo[]): Folder => {
  const { class: cls, stats } = classify(dir, files)
  return { dir, class: cls, files, images: [], stats, identified: false, findings: [] }
}

/** A fetcher that answers from a list of URL patterns and counts what it was asked. */
function fake(routes: [RegExp, unknown][]): Fetcher & { asked: string[] } {
  const asked: string[] = []
  const answer = (url: string) => {
    asked.push(url)
    return routes.find(([re]) => re.test(url))?.[1]
  }
  return { asked, json: async <T>(url: string) => answer(url) as T | undefined, bytes: async () => undefined, sent: () => asked.length }
}

const track = (position: number, title: string, seconds: number, id = `rec-${title}`) => ({ position, title, length: seconds * MS, recording: { id, title, length: seconds * MS } })
const release = (id: string, title: string, date: string, tracks: ReturnType<typeof track>[]) => ({
  id,
  title,
  date,
  'artist-credit': [{ name: 'Mara Vale' }],
  'release-group': { id: `rg-${id}`, 'first-release-date': date },
  media: [{ position: 1, tracks }],
})

const dir = `${ROOT}/Mara Vale - Harbour`
const inv: Inventory = {
  roots: [ROOT],
  scanned: '',
  unreadable: [],
  folders: [
    folder(dir, [
      file(dir, 'Mara Vale - Tides.mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Tides' }, 206),
      file(dir, 'Mara Vale - Where Does The Night Go.mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Where Does The Night Go' }, 265),
      file(dir, 'Mara Vale - Blue River (Kestrel Remix).mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Blue River (Kestrel Remix)', track: '10' }, 468),
    ]),
  ],
}

const harbour = release('harbour', 'Harbour', '1999-05-17', [track(1, 'Tides', 207), track(2, 'Find My Way', 238), track(4, 'Where Does The Night Go So Fast?', 264)])
const single = release('single', 'Harbour: The B Sides', '2001-01-01', [track(1, 'Tides', 207)])
const routes: [RegExp, unknown][] = [
  [/\/release\?query=/, { releases: [{ id: 'single' }, { id: 'harbour' }] }],
  [/\/release\/harbour\?/, harbour],
  [/\/release\/single\?/, single],
  [
    /\/recording\?query=/,
    {
      recordings: [
        { id: 'original', title: 'Blue River', score: 100, length: 252 * MS, 'artist-credit': [{ name: 'Mara Vale' }], 'first-release-date': '1999' },
        { id: 'kestrel', title: 'Blue River (Kestrel remix)', score: 95, length: 467 * MS, 'artist-credit': [{ name: 'Mara Vale' }], 'first-release-date': '2000-03-06' },
      ],
    },
  ],
  [/coverartarchive\.org\/release\/harbour/, { images: [{ front: true, thumbnails: { '250': 'http://coverartarchive.org/release/harbour/1-250.jpg' } }] }],
]

describe('similarity', () => {
  it('forgives misspellings and titles cut short', () => {
    expect(similarity('Lanters of Dusk', 'Lanterns of Dusk')).toBeGreaterThan(0.85)
    expect(similarity('Where Does The Night Go', 'Where Does The Night Go So Fast?')).toBeGreaterThanOrEqual(0.9)
    expect(similarity('Tides', 'Glass')).toBeLessThan(0.5)
    expect(similarity('Midnigt Train', 'Midnight Train to Nowhere')).toBeGreaterThanOrEqual(0.9)
  })

  it('matches a version label that names part of the remixers, and no other remix', () => {
    expect(titleMatch('Tides - Harbour remix', 'Tides (Lowlight and Harbour remix)')).toBeGreaterThanOrEqual(0.75)
    expect(titleMatch('Paper Kite (Night Drive Remix)', 'Paper Kite (Lowlight remix)')).toBeLessThan(0.75)
  })
})

describe('enrich', () => {
  it('takes the release whose tracklist holds the folder, and finds the rest as recordings', async () => {
    const net = fake(routes)
    const found = await enrich(inv, plan(inv).decisions, { net, steps: ['musicbrainz', 'covers'] })
    expect(found.albums['Mara Vale - Harbour']).toMatchObject({ release: 'harbour', title: 'Harbour', year: 1999, matched: 2, files: 3, missing: [{ disc: 1, track: 2, title: 'Find My Way' }] })
    expect(found.albums['Mara Vale - Harbour'].cover).toBe('https://coverartarchive.org/release/harbour/1-250.jpg')
    expect(found.tracks['Mara Vale - Harbour/Mara Vale - Where Does The Night Go.mp3']).toMatchObject({ via: 'album', title: 'Where Does The Night Go So Fast?', track: 4, year: 1999 })
    // the remix is not on the album, and its own search prefers the remix over the original of the same name
    expect(found.tracks['Mara Vale - Harbour/Mara Vale - Blue River (Kestrel Remix).mp3']).toMatchObject({ via: 'recording', recording: 'kestrel', year: 2000 })
  })

  it('feeds categories: corrected titles with evidence, the release on the album and what it lacks', async () => {
    const found = await enrich(inv, plan(inv).decisions, { net: fake(routes), steps: ['musicbrainz', 'covers'], measure: async () => undefined })
    const c = categorize(inv, plan(inv).decisions, found)
    const night = c.tracks.find((t) => t.path.includes('Night'))
    expect(night).toMatchObject({ title: 'Where Does The Night Go So Fast?', track: 4, identified: 'album' })
    expect(night?.evidence).toContain("MusicBrainz title, was 'Where Does The Night Go'")
    expect(c.albums[0]).toMatchObject({ name: 'Harbour', release: 'harbour', cover: 'https://coverartarchive.org/release/harbour/1-250.jpg' })
    expect(c.albums[0].issues).toEqual(['missing track 2 (Find My Way)', 'not on Harbour: Blue River (Kestrel remix)'])
    expect(c.identified.map((g) => [g.name, g.tracks.length])).toEqual([['album match', 2], ['recording match', 1]])
  })

  it('falls back to the title alone, takes the earliest take for the year and the artist genres', async () => {
    const mixed = `${ROOT}/Mixed`
    const loose: Inventory = { roots: [ROOT], scanned: '', unreadable: [], folders: [folder(mixed, ['A', 'B', 'C'].map((n) => file(mixed, `djay - big nite ${n}.mp3`, { artist: 'djay', title: 'big nite' }, 288)))] }
    const take = (id: string, date: string) => ({ id, title: "Big Nite'", score: 100, length: 285 * MS, 'artist-credit': [{ name: 'D‐JAY', artist: { id: 'djay' } }], 'first-release-date': date })
    const net = fake([
      [/recording\?query=.*AND%20artist/, { recordings: [{ id: 'jazz', title: 'Big Bamboo', score: 100, 'artist-credit': [{ name: 'Voodoo Jazz' }] }] }],
      [/recording\?query=recording%3A\(big%20nite\)&/, { recordings: [take('compilation', '2005-01-01'), take('single', '1999-12-28')] }],
      [/\/artist\/djay\?inc=genres/, { genres: [{ name: 'east coast hip hop', count: 5 }, { name: 'hip hop', count: 9 }] }],
    ])
    const found = await enrich(loose, [], { net, steps: ['musicbrainz'] })
    expect(found.tracks['Mixed/djay - big nite A.mp3']).toMatchObject({ via: 'recording', artist: 'D‐JAY', year: 1999, artists: ['djay'], genres: ['hip hop', 'east coast hip hop'] })
    // one artist lookup serves every track of that artist
    expect(net.asked.filter((u) => u.includes('/artist/')).length).toBe(1)
    expect(categorize(loose, [], found).tracks[0].genre).toBe('Hip Hop')
  })

  it("files a loose song under its studio album, found by the artist's id when compilations crowd the search", async () => {
    const mixed = `${ROOT}/Mixed`
    const loose: Inventory = { roots: [ROOT], scanned: '', unreadable: [], folders: [folder(mixed, ['A', 'B', 'C'].map((n) => file(mixed, `Sela Moon - Stay Awake ${n}.mp3`, { artist: 'Sela Moon', title: 'Stay Awake' }, 239)))] }
    const on = (id: string, title: string, date: string, type: string, secondary: string[] = []) => ({ id, title, status: 'Official', date, 'release-group': { id: `rg-${id}`, 'primary-type': type, 'secondary-types': secondary }, media: [{ position: 1, track: [{ number: '3', title: 'Stay Awake' }] }] })
    const take = (id: string, date: string, releases: ReturnType<typeof on>[]) => ({ id, title: 'Stay Awake', score: 100, length: 239 * MS, 'artist-credit': [{ name: 'Sela-Moon', artist: { id: 'sela' } }], 'first-release-date': date, releases })
    const net = fake([
      // the search lists the US edition only; the release group knows the album came out in Sweden in 1997
      [/recording\?query=.*AND%20arid%3Asela/, { recordings: [take('album', '1998-06-23', [on('tideless', 'Tideless', '1998-06-23', 'Album')])] }],
      [/\/release-group\/rg-tideless\?inc=genres/, { 'first-release-date': '1997-08-25', genres: [{ name: 'pop rock', count: 3 }] }],
      [/recording\?query=/, { recordings: [take('hits', '1998', [on('hits98', 'Hits 98', '1998', 'Album', ['Compilation'])]), take('live', '2011', [on('stage', 'Live in Rio', '2011', 'Album', ['Live'])])] }],
      [/\/artist\/sela\?inc=genres/, { genres: [{ name: 'rock', count: 1 }] }],
    ])
    const found = await enrich(loose, [], { net, steps: ['musicbrainz'] })
    expect(found.tracks['Mixed/Sela Moon - Stay Awake A.mp3']).toMatchObject({ recording: 'album', release: 'tideless', releaseGroup: 'rg-tideless', album: 'Tideless', track: 3, disc: 1, year: 1997, genres: ['pop rock'] })
  })

  it('files songs of one album under one edition, the one that holds them all', async () => {
    const mixed = `${ROOT}/Mixed`
    const loose: Inventory = { roots: [ROOT], scanned: '', unreadable: [], folders: [folder(mixed, ['Stay Awake', 'Falling Leaves', 'Paper Tears'].map((n) => file(mixed, `Sela Moon - ${n}.mp3`, { artist: 'Sela Moon', title: n }, 200)))] }
    const edition = (id: string, date: string, n: string) => ({ id, title: 'Tideless', status: 'Official', date, 'release-group': { id: 'rg-tideless', 'primary-type': 'Album' }, media: [{ position: 1, track: [{ number: n, title: '' }] }] })
    const take = (title: string, editions: ReturnType<typeof edition>[]) => ({ id: `rec-${title}`, title, score: 100, length: 200 * MS, 'artist-credit': [{ name: 'Sela-Moon', artist: { id: 'sela' } }], 'first-release-date': '1997', releases: editions })
    const net = fake([
      [/Stay%20Awake/, { recordings: [take('Stay Awake', [edition('se', '1997-08-25', '1'), edition('us', '1998-06-23', '3')])] }],
      [/Falling/, { recordings: [take('Falling Leaves', [edition('us', '1998-06-23', '6')])] }],
      [/Paper/, { recordings: [take('Paper Tears', [edition('se', '1997-08-25', '10'), edition('us', '1998-06-23', '10')])] }],
    ])
    const found = await enrich(loose, [], { net, steps: ['musicbrainz'] })
    expect(Object.values(found.tracks).map((m) => [m.title, m.release, m.track])).toEqual([['Falling Leaves', 'us', 6], ['Paper Tears', 'us', 10], ['Stay Awake', 'us', 3]])
  })

  it('looks up lyrics by the names the last MusicBrainz run found when that step does not run again', async () => {
    const net = fake([[/lrclib\.net\/api\/get\?track_name=Where\+Does\+The\+Night\+Go\+So\+Fast%3F/, { syncedLyrics: '[00:01.00] where does the night go' }]])
    const previous = { version: 1, albums: {}, tracks: { 'Mara Vale - Harbour/Mara Vale - Where Does The Night Go.mp3': { via: 'album' as const, title: 'Where Does The Night Go So Fast?', artist: 'Mara Vale', album: 'Harbour' } } }
    const found = await enrich(inv, [], { net, steps: ['lyrics'], previous })
    expect(found.tracks['Mara Vale - Harbour/Mara Vale - Where Does The Night Go.mp3']).toMatchObject({ title: 'Where Does The Night Go So Fast?', lyrics: 'synced' })
  })

  it('measures loudness into ReplayGain terms and leaves a file it cannot measure alone', async () => {
    const LUFS = -9
    const found = await enrich(inv, [], {
      net: fake([]),
      steps: ['loudness'],
      measure: async (p) => (p.includes('Tides') ? { lufs: LUFS, peak: 0.5, gain: -18 - LUFS } : undefined),
    })
    expect(found.tracks).toEqual({ 'Mara Vale - Harbour/Mara Vale - Tides.mp3': { loudness: { lufs: LUFS, peak: 0.5, gain: -9 } } })
  })
})
