import { describe, expect, it } from 'vitest'
import { baseTitle, categorize, creditsOf, folderKind, lengthOf, versionOf } from '../src/categories.ts'
import { classify, type Folder, type Inventory } from '../src/inventory.ts'
import { plan } from '../src/rules.ts'
import { score } from '../src/score.ts'
import { emptyTags, type FileInfo, type Tags } from '../src/tags.ts'

const ROOT = '/m'
const SONG_SECONDS = 200

const file = (dir: string, name: string, tags: Partial<Tags> = {}, raw: FileInfo['raw'] = { 'ID3v2.3': [] }): FileInfo => ({
  path: `${dir}/${name}`,
  tags: { ...emptyTags(), ...tags },
  extra: {},
  raw,
  duration: SONG_SECONDS,
  pictures: [],
})

const folder = (dir: string, files: FileInfo[]): Folder => {
  const { class: cls, stats } = classify(dir, files)
  return { dir, class: cls, files, images: [], stats, identified: false, findings: [] }
}

const library = (...folders: Folder[]): Inventory => ({ roots: [ROOT], scanned: '', folders, unreadable: [] })

describe('folderKind', () => {
  it('finds a DJ mix from one artist tag and DJ - Performer - Title filenames', () => {
    const dir = `${ROOT}/DjNova`
    const f = folder(dir, ['Sun Circle - Paloma', 'KLX - Hopscape', 'Spindle - Groove Kite'].map((n) => file(dir, `DJ Nova - ${n}.mp3`, { artist: 'DJ Nova' })))
    expect(folderKind(f).kind).toBe('dj-mix')
  })

  it('calls a folder of unrelated tracks loose, by its name or by its many albums', () => {
    const dir = `${ROOT}/Mixed`
    const named = folder(dir, ['A', 'B', 'C'].map((a) => file(dir, `${a} - Song.mp3`, { artist: a })))
    expect(folderKind(named).kind).toBe('loose')
    const other = `${ROOT}/Stuff`
    const albums = folder(other, ['A', 'B', 'C', 'D'].map((a) => file(other, `${a} - Song.mp3`, { artist: a, album: `${a} Album` })))
    expect(folderKind(albums).kind).toBe('loose')
  })

  it('keeps a compilation without album tags a compilation', () => {
    const dir = `${ROOT}/Night Shift`
    const f = folder(dir, ['Northbound', 'Glassworks', 'Pulsar'].map((a) => file(dir, `${a} - Song.mp3`, { artist: a })))
    expect(folderKind(f).kind).toBe('compilation')
  })
})

describe('titles and credits', () => {
  it('reads the version from parentheses and the dashed tail, not from a title word', () => {
    expect(versionOf('Blue River (Kestrel Remix)')).toBe('remix')
    expect(versionOf('Tides - Harbour remix')).toBe('remix')
    expect(versionOf('Meet Me There (Acoustic)')).toBe('acoustic')
    expect(versionOf('DeepHouseMiniMix')).toBe('megamix')
    expect(versionOf('Live Your Life')).toBe('original')
    expect(baseTitle('Tides - Harbour remix')).toBe('Tides')
  })

  it('splits featured, joint and remix credits but keeps a duo whole', () => {
    expect(creditsOf('Velvet Coast Featuring Mara', 'Low Tide')).toEqual([
      { name: 'Velvet Coast', role: 'main' },
      { name: 'Mara', role: 'featured' },
    ])
    expect(creditsOf('Ada Lane n Mo B', 'Out West').map((c) => c.name)).toEqual(['Ada Lane', 'Mo B'])
    expect(creditsOf('Rowe & Hart', 'Every Night')).toEqual([{ name: 'Rowe & Hart', role: 'main' }])
    expect(creditsOf('The Lanterns', 'Tides (Harbour Jones Remix)')).toContainEqual({ name: 'Harbour Jones', role: 'remixer' })
  })

  it('buckets lengths', () => {
    expect([20, 200, 500, 829].map(lengthOf)).toEqual(['short', 'song', 'extended', 'mix'])
  })
})

describe('categorize', () => {
  it('repairs titles the filename knows better and records why', () => {
    const dir = `${ROOT}/Mixed`
    const c = categorize(library(folder(dir, [
      file(dir, 'Six Rivers - Northern Light.mp3', { artist: 'Six Rivers', title: 'Track 6' }),
      file(dir, '03 - The Lanterns - Saltwater.mp3.mp3', { artist: 'The Lanterns', title: 'Saltwater.mp3' }),
      file(dir, 'Glassworks - Change.mp3', { artist: 'Glassworks  (tunes4free.com)', title: 'Change' }),
      file(dir, 'Clear Sky - Dancing In The Kitchen All Night.mp3', { artist: 'Clear Sky', title: 'Dancing In The Kitchen All N' }, { ID3v1: [] }),
      file(dir, 'rip1-99tunesmp3.mp3', { artist: 'Pulsar' }),
    ])))
    const t = Object.fromEntries(c.tracks.map((x) => [x.path, x]))
    expect(t['Mixed/Six Rivers - Northern Light.mp3'].title).toBe('Northern Light')
    expect(t['Mixed/03 - The Lanterns - Saltwater.mp3.mp3'].title).toBe('Saltwater')
    expect(t['Mixed/Glassworks - Change.mp3'].artist).toBe('Glassworks')
    expect(t['Mixed/Clear Sky - Dancing In The Kitchen All Night.mp3'].title).toBe('Dancing In The Kitchen All Night')
    expect(t['Mixed/rip1-99tunesmp3.mp3']).toMatchObject({ title: '', song: '' })
    expect(t['Mixed/rip1-99tunesmp3.mp3'].issues[0]).toContain('is a code')
    expect(c.tracks.every((x) => x.album === '' && x.albumartist === '')).toBe(true)
  })

  it('groups an album, joins a remix to its song and reports collisions and gaps', () => {
    const dir = `${ROOT}/Mara Vale - Harbour`
    const play = folder(dir, [
      file(dir, 'Mara Vale - Tides.mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Tides', track: '1', year: '1999' }),
      file(dir, 'Mara Vale - Glass.mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Glass', track: '3', year: '1999' }),
      file(dir, 'Mara Vale - Blue River.mp3', { artist: 'Mara Vale', album: 'Harbour', title: 'Blue River', track: '3', year: '2000' }),
    ])
    const mixed = `${ROOT}/Mixed`
    const loose = folder(mixed, [
      file(mixed, 'Mara Vale - Tides - Harbour remix.mp3', { artist: 'Mara Vale', title: 'Tides - Harbour remix' }),
      file(mixed, 'Northbound - Sand Hills.mp3', { artist: 'Northbound', title: 'Sand Hills' }),
    ])
    const inv = library(play, loose)
    const c = categorize(inv, plan(inv).decisions)
    expect(c.albums.map((a) => [a.albumartist, a.name])).toEqual([['Mara Vale', 'Harbour']])
    expect(c.albums[0].issues).toEqual(['track 3 claimed by more than one file', 'missing track 2', 'years disagree: 1999, 2000'])
    expect(c.songs).toEqual([{ key: 'maravaletides', name: 'Mara Vale - Tides', tracks: ['Mara Vale - Harbour/Mara Vale - Tides.mp3', 'Mixed/Mara Vale - Tides - Harbour remix.mp3'] }])
    expect(c.artists.find((a) => a.name === 'Mara Vale')?.tracks).toHaveLength(4)
    expect(categorize(inv, plan(inv).decisions)).toEqual(c)
  })

  it('scores the result against an answer key', () => {
    const dir = `${ROOT}/Mixed`
    const c = categorize(library(folder(dir, [file(dir, 'Pulsar - Stelar.mp3', { artist: 'Pulsar', title: 'Stelar' })])))
    const checks = score(c, {
      folders: { Mixed: { kind: 'singles' } },
      tracks: { 'Mixed/Pulsar - Stelar.mp3': { artist: 'pulsar', title: 'Stellar' } },
    })
    expect(checks.map((x) => [x.what, x.pass])).toEqual([
      ['Mixed: kind', true],
      ['Mixed/Pulsar - Stelar.mp3: title', false],
      ['Mixed/Pulsar - Stelar.mp3: artist', true],
    ])
  })

  it('files a loose recording under its MusicBrainz release, drops a junk album and spells genres as MusicBrainz', () => {
    const dir = `${ROOT}/Mixed`
    const inv = library(
      folder(dir, [
        file(dir, 'Six Rivers - Northern Light.mp3', { artist: 'Six Rivers', title: 'Track 6', album: 'FREE MP3s' }),
        file(dir, 'DJ Ay - Big Night.mp3', { artist: 'DJ Ay', title: 'Big Night', genre: 'Hip-Hop' }),
        file(dir, 'Coral - Jumping.mp3', { artist: 'Coral', title: 'Jumping', album: 'http://tunes4free.com' }),
      ]),
    )
    const c = categorize(inv, [], {
      version: 1,
      albums: {},
      tracks: {
        'Mixed/Six Rivers - Northern Light.mp3': {
          via: 'recording', recording: 'rec-1', title: 'Northern Light', artist: '6 Rivers', year: 2000, genres: ['hip hop', 'r&b'],
          release: 'rel-1', releaseGroup: 'rg-1', album: 'Long Way Home', albumartist: '6 Rivers', track: 1, disc: 1,
        },
      },
    })
    const t = (name: string) => c.tracks.find((x) => x.path.endsWith(name))
    expect(t('Northern Light.mp3')).toMatchObject({ album: 'Long Way Home', albumartist: '6 Rivers', release: 'rel-1', track: 1, genres: ['Hip Hop', 'R&B'] })
    expect(t('Jumping.mp3')?.album).toBe('')
    expect(t('Big Night.mp3')?.genre).toBe('Hip Hop')
  })
})
