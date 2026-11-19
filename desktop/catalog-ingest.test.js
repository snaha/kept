import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLibraryService } from './library-service.js'
import { nodeFork } from './library-process.js'
import { TRAIT_COALESCE_MS, createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { PAYLOAD_FORMATS, audioFileVersion, hashAudioPayload } from './audio-payload.js'
import { CatalogDatabase } from './catalog-database.js'
import { NAVIDROME_SOURCE, fetchLibrarySongs, folderSourceId, ingestLibrary, startCatalogSync } from './catalog-ingest.js'

const FRAME_BYTES = 417
const FRAMES = 6
const TAG_BYTES = 300
const ID3V1_BYTES = 128
const SIDE_INFO_BYTES = 32
const SYNCSAFE = 0x7f
const SYNCSAFE_BITS = 7
const STREAMINFO_BYTES = 34
const LAST_BLOCK = 0x80
const VORBIS_COMMENT = 4
const APE_VERSION = 2000
const APE_FOOTER_BYTES = 32
const AUDIO_BYTES = 4000
const SAMPLE_RATE = 44100
const ENERGY = 80, MOOD = 20, OTHER = 55
const DAY_MS = 86400000
const YEAR = 1999

const u32 = (value, little = false) => { const buffer = Buffer.alloc(4); if (little) buffer.writeUInt32LE(value); else buffer.writeUInt32BE(value); return buffer }
const text = value => Buffer.from(value, 'latin1')
// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, joint stereo: 417-byte frames.
const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x64])
const frame = () => Buffer.concat([frameHeader, randomBytes(FRAME_BYTES - frameHeader.length)])
const infoFrame = () => { const buffer = Buffer.alloc(FRAME_BYTES); frameHeader.copy(buffer); buffer.write('Info', frameHeader.length + SIDE_INFO_BYTES, 'latin1'); return buffer }
const id3v2 = length => Buffer.concat([text('ID3'), Buffer.from([4, 0, 0, 0, 0, (length >> SYNCSAFE_BITS) & SYNCSAFE, length & SYNCSAFE]), randomBytes(length)])
const id3v1 = () => Buffer.concat([text('TAG'), randomBytes(ID3V1_BYTES - 'TAG'.length)])
const apeTag = length => Buffer.concat([randomBytes(length), text('APETAGEX'), u32(APE_VERSION, true), u32(length + APE_FOOTER_BYTES, true), u32(1, true), u32(0, true), Buffer.alloc(8)])
const flacBlock = (type, body, last = false) => Buffer.concat([Buffer.from([type | (last ? LAST_BLOCK : 0), 0, body.length >> 8, body.length & 0xff]), body])
const atom = (type, body) => Buffer.concat([u32(body.length + 8), text(type), body])
const chunk = (id, body) => Buffer.concat([text(id), u32(body.length, true), body, Buffer.alloc(body.length % 2)])
const wav = (...chunks) => { const body = Buffer.concat([text('WAVE'), ...chunks]); return Buffer.concat([text('RIFF'), u32(body.length, true), body]) }

const temporary = t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kept-ingest-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const write = (file, ...parts) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.concat(parts)); return file }
const mp3 = (audio, tagBytes = TAG_BYTES) => [id3v2(tagBytes), audio]
const audioFrames = () => Buffer.concat(Array.from({ length: FRAMES }, frame))

test('the payload hash ignores tag edits in mp3, flac, m4a and wav', async t => {
  const directory = temporary(t)
  const audio = audioFrames(), samples = randomBytes(AUDIO_BYTES)
  const streamInfo = flacBlock(0, randomBytes(STREAMINFO_BYTES))
  const ftyp = atom('ftyp', text('M4A \0\0\0\0'))
  const format = chunk('fmt ', randomBytes(16))
  const cases = [
    [PAYLOAD_FORMATS.mp3, audio.length, [
      write(path.join(directory, 'bare.mp3'), audio),
      write(path.join(directory, 'tagged.mp3'), ...mp3(audio)),
      write(path.join(directory, 'retagged.mp3'), id3v2(TAG_BYTES * 2), infoFrame(), audio, id3v1()),
      write(path.join(directory, 'ape.mp3'), id3v2(TAG_BYTES), audio, apeTag(TAG_BYTES), id3v1()),
    ]],
    [PAYLOAD_FORMATS.flac, samples.length, [
      write(path.join(directory, 'a.flac'), text('fLaC'), streamInfo, flacBlock(VORBIS_COMMENT, randomBytes(TAG_BYTES), true), samples),
      write(path.join(directory, 'b.flac'), id3v2(TAG_BYTES), text('fLaC'), streamInfo, flacBlock(VORBIS_COMMENT, randomBytes(TAG_BYTES * 2)), flacBlock(1, Buffer.alloc(TAG_BYTES), true), samples),
    ]],
    [PAYLOAD_FORMATS.mp4, samples.length, [
      write(path.join(directory, 'a.m4a'), ftyp, atom('moov', randomBytes(TAG_BYTES)), atom('mdat', samples)),
      write(path.join(directory, 'b.m4a'), ftyp, atom('free', Buffer.alloc(TAG_BYTES)), atom('mdat', samples), atom('moov', randomBytes(TAG_BYTES * 2))),
    ]],
    [PAYLOAD_FORMATS.wav, samples.length, [
      write(path.join(directory, 'a.wav'), wav(format, chunk('data', samples))),
      write(path.join(directory, 'b.wav'), wav(format, chunk('LIST', randomBytes(TAG_BYTES + 1)), chunk('data', samples), chunk('id3 ', randomBytes(TAG_BYTES)))),
    ]],
  ]
  for (const [expected, payloadBytes, files] of cases) {
    const results = await Promise.all(files.map(file => hashAudioPayload(file)))
    for (const [index, result] of results.entries()) {
      assert.deepEqual([path.basename(files[index]), result.format, result.size, result.contentHash], [path.basename(files[index]), expected, payloadBytes, results[0].contentHash])
    }
  }
  const [first, other] = await Promise.all([hashAudioPayload(path.join(directory, 'tagged.mp3')), hashAudioPayload(write(path.join(directory, 'other.mp3'), ...mp3(audioFrames())))])
  assert.notEqual(first.contentHash, other.contentHash)
  // An unknown container is hashed whole, so its identity follows every byte.
  const unknown = write(path.join(directory, 'notes.bin'), samples)
  assert.deepEqual(await hashAudioPayload(unknown), { contentHash: (await hashAudioPayload(path.join(directory, 'a.wav'))).contentHash, size: samples.length, format: PAYLOAD_FORMATS.file })
  let rests = 0
  await hashAudioPayload(unknown, { rest: () => { rests++ }, restEveryBytes: 1 })
  assert.ok(rests > 0)
})

// With ffmpeg at hand, synthesised files are re-tagged: the tags change, the payload hash does not.
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const SYNTH_HERTZ = 440
const SYNTH_STEP_HERTZ = 110
const SYNTH_SECONDS = 1
test('re-tagging synthesised files with ffmpeg keeps their payload hash', { skip: !ffmpeg && 'ffmpeg is needed' }, async t => {
  const directory = temporary(t)
  for (const index of [0, 1, 2]) {
    const original = path.join(directory, `${index}.mp3`), retagged = path.join(directory, `${index}-retagged.mp3`)
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${SYNTH_HERTZ + index * SYNTH_STEP_HERTZ}:duration=${SYNTH_SECONDS}`, '-metadata', 'title=Original title', '-id3v2_version', '3', original])
    assert.equal(made.status, 0, String(made.stderr))
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', original, '-map', '0:a', '-c', 'copy', '-metadata', 'title=A much longer changed title', '-metadata', 'album=Another album', retagged])
    assert.equal(result.status, 0, String(result.stderr))
    const [before, after] = [await hashAudioPayload(original), await hashAudioPayload(retagged)]
    assert.notEqual(statSync(original).size, statSync(retagged).size)
    assert.deepEqual(after, before)
  }
})

// A library on disk, a catalog on SQLite, and Navidrome's answers written by hand.
const fixture = async t => {
  const directory = temporary(t)
  const music = path.join(directory, 'Music'), archive = path.join(directory, 'Archive')
  const files = {
    one: write(path.join(music, 'Artist', 'Blue', '01 One.mp3'), ...mp3(audioFrames())),
    two: write(path.join(music, 'Artist', 'Blue', '02 Two.mp3'), ...mp3(audioFrames())),
    three: write(path.join(archive, 'Other', 'Red', '01 Three.mp3'), ...mp3(audioFrames())),
  }
  const database = new CatalogDatabase(path.join(directory, 'library.sqlite'))
  t.after(() => database.close())
  let clock = DAY_MS
  const now = () => ++clock
  const bridge = createCatalogBridge(database.service, { now })
  const song = (id, albumId, file, track) => ({ id, albumId, path: file, duration: 1, track, disc: 1 })
  const songs = (suffix = '') => [song(`s1${suffix}`, `blue${suffix}`, files.one, 1), song(`s2${suffix}`, `blue${suffix}`, files.two, 2), song(`s3${suffix}`, `red${suffix}`, files.three, 1)]
  let hashed = []
  const ingest = (list = songs(), extra = {}) => ingestLibrary({
    catalog: database.store, folders: [music, archive], songs: list, now,
    resolveFile: item => (existsSync(item.path) ? item.path : undefined),
    hashFile: file => { hashed.push(path.basename(file)); return hashAudioPayload(file) }, ...extra,
  })
  return { directory, music, archive, files, database, bridge, songs, song, ingest, now, hashedFiles: () => { const seen = hashed; hashed = []; return seen } }
}

test('ingest builds assets and anchors, and a second scan reads no file again', async t => {
  const { database, bridge, ingest, hashedFiles, music } = await fixture(t)
  const first = await ingest()
  assert.deepEqual([first.songs, first.hashed, first.reused, first.failed, first.unresolved, first.assets, first.albums, first.conflicts.length], [3, 3, 0, 0, 0, 3, 2, 0])
  assert.equal(hashedFiles().length, 3)
  const { albums } = await bridge.albums()
  assert.deepEqual(Object.keys(albums).sort(), ['blue', 'red'])
  const { album } = await database.service.getAlbum({ albumId: albums.blue.albumId })
  assert.deepEqual(album.tracks.map(track => track.track), [1, 2])
  assert.equal(album.availability, 'available')
  const { asset } = await database.service.getAsset({ assetId: album.tracks[0].assetId })
  assert.deepEqual(asset.locations.map(location => [location.sourceId, location.path]), [[folderSourceId(music), 'Artist/Blue/01 One.mp3']])
  assert.equal(asset.size, FRAME_BYTES * FRAMES)
  assert.equal(asset.analysisAllowed, true)
  const { sources } = await database.service.listSources()
  assert.ok(sources.some(source => source.id === NAVIDROME_SOURCE.id))
  const second = await ingest()
  assert.deepEqual([second.hashed, second.reused, second.assets, second.albums], [0, 3, 3, 2])
  assert.deepEqual(hashedFiles(), [])
})

test('a Navidrome re-ID keeps every trait and favourite', async t => {
  const { database, bridge, ingest, songs } = await fixture(t)
  await ingest()
  assert.deepEqual(await bridge.setTrait({ providerAlbumId: 'blue', trait: 'energy', value: ENERGY }), { applied: true })
  assert.deepEqual(await bridge.setTrait({ providerAlbumId: 'red', trait: 'mood', value: MOOD }), { applied: true })
  assert.deepEqual(await bridge.setFavorite({ providerAlbumId: 'red', value: true }), { applied: true })
  const before = (await bridge.albums()).albums
  // A rebuilt Navidrome database: the same files under new album and song IDs.
  const reId = await ingest(songs('-new'))
  assert.deepEqual([reId.hashed, reId.conflicts.length], [0, 0])
  const after = (await bridge.albums()).albums
  assert.deepEqual(Object.keys(after).sort(), ['blue', 'blue-new', 'red', 'red-new'])
  assert.deepEqual(after['blue-new'], before.blue)
  assert.deepEqual(after['red-new'], before.red)
  assert.equal(after['blue-new'].traits.energy.value, ENERGY)
  assert.equal(after['blue-new'].traits.energy.provenance, 'hand-set')
  assert.equal(after['red-new'].favorite, true)
  assert.equal((await database.service.listAlbums({})).total, 2)
  assert.deepEqual(await database.service.resolveProviderId({ sourceId: NAVIDROME_SOURCE.id, kind: 'track', externalId: 's1-new' }),
    await database.service.resolveProviderId({ sourceId: NAVIDROME_SOURCE.id, kind: 'track', externalId: 's1' }))
})

test('a re-tagged and a moved file keep their asset and anchor', async t => {
  const { database, bridge, ingest, files, song, hashedFiles } = await fixture(t)
  await ingest()
  hashedFiles()
  const before = (await bridge.albums()).albums.blue
  const { album } = await database.service.getAlbum({ albumId: before.albumId })
  // New tags in place, then the album folder is renamed.
  const original = statSync(files.one)
  const payload = readFileSync(files.one).subarray(original.size - FRAME_BYTES * FRAMES)
  write(files.one, id3v2(TAG_BYTES * 2), infoFrame(), payload, id3v1())
  const future = new Date(original.mtimeMs + DAY_MS)
  utimesSync(files.one, future, future)
  const moved = path.join(path.dirname(path.dirname(files.one)), 'Blue (remaster)')
  renameSync(path.dirname(files.one), moved)
  const list = [song('s1', 'blue', path.join(moved, '01 One.mp3'), 1), song('s2', 'blue', path.join(moved, '02 Two.mp3'), 2), song('s3', 'red', files.three, 1)]
  const result = await ingest(list)
  assert.deepEqual(hashedFiles().sort(), ['01 One.mp3', '02 Two.mp3'])
  assert.equal(result.conflicts.length, 0)
  const after = await database.service.getAlbum({ albumId: before.albumId })
  assert.deepEqual(after.album.tracks.map(track => track.assetId), album.tracks.map(track => track.assetId))
  const { asset } = await database.service.getAsset({ assetId: album.tracks[0].assetId })
  assert.deepEqual(asset.locations.map(location => [location.path, location.availability]).sort(), [['Artist/Blue (remaster)/01 One.mp3', 'available'], ['Artist/Blue/01 One.mp3', 'missing']])
  assert.equal((await database.service.listAlbums({})).total, 2)
})

test('an offline folder is unavailable, never deleted, and comes back', async t => {
  const { database, bridge, ingest, archive, directory, songs } = await fixture(t)
  await ingest()
  await bridge.setTrait({ providerAlbumId: 'red', trait: 'energy', value: ENERGY })
  const { albumId } = (await bridge.albums()).albums.red
  const parked = path.join(directory, 'Archive-unplugged')
  renameSync(archive, parked)
  // Navidrome no longer lists the songs of the unplugged drive.
  const offline = await ingest(songs().slice(0, 2))
  assert.deepEqual(offline.unavailable, [folderSourceId(archive)])
  const gone = (await bridge.albums()).albums
  assert.equal(gone.red.availability, 'unavailable')
  assert.equal(gone.red.traits.energy.value, ENERGY)
  assert.equal(gone.blue.availability, 'available')
  assert.equal((await database.service.getAlbum({ albumId })).album.tracks.length, 1)
  // The mount point is back but empty: still an unplugged drive, not a deleted library.
  mkdirSync(archive)
  const empty = await ingest(songs().slice(0, 2))
  assert.deepEqual(empty.unavailable, [folderSourceId(archive)])
  assert.equal((await bridge.albums()).albums.red.availability, 'unavailable')
  rmSync(archive, { recursive: true })
  renameSync(parked, archive)
  const back = await ingest()
  assert.deepEqual([back.unavailable, back.hashed], [[], 0])
  const restored = (await bridge.albums()).albums.red
  assert.deepEqual([restored.albumId, restored.availability, restored.traits.energy.value], [albumId, 'available', ENERGY])
  // A file deleted from an online folder is missing, and its album keeps its anchor.
  const deleted = await ingest(songs().slice(1))
  assert.equal(deleted.conflicts.length, 0)
  assert.equal((await bridge.albums()).albums.blue.availability, 'partial')
})

test('a file that cannot be read keeps its place: nothing is marked missing or pruned by that scan', async t => {
  const { database, bridge, ingest, files, songs } = await fixture(t)
  await ingest()
  // Touching the file forces a rehash, which then fails.
  const later = new Date(Date.now() + 60000)
  utimesSync(files.two, later, later)
  const flaky = await ingest(songs(), { hashFile: async file => { if (file === files.two) throw new Error('EIO'); return hashAudioPayload(file) } })
  assert.equal(flaky.failed, 1)
  assert.equal((await bridge.albums()).albums.blue.availability, 'available', 'the last good view stays')
  const { entries } = await database.store.fileHashes({ sourceId: folderSourceId(path.dirname(path.dirname(path.dirname(files.one)))) })
  assert.ok(entries.some(entry => entry.path === 'Artist/Blue/02 Two.mp3'), 'its cached hash survives')
  const clean = await ingest()
  assert.equal(clean.failed, 0)
  assert.equal((await bridge.albums()).albums.blue.availability, 'available')
})

test('an unresolved song preserves existing locations and hashes until the next complete scan', async t => {
  const { database, bridge, ingest, music, songs } = await fixture(t)
  await ingest()
  const sourceId = folderSourceId(music)
  const cached = await database.store.fileHashes({ sourceId })
  const listed = songs()
  const [, unresolvedSong] = listed
  const unresolved = await ingest(listed, {
    resolveFile: song => song === unresolvedSong ? undefined : song.path,
  })
  assert.equal(unresolved.unresolved, 1)
  assert.equal((await bridge.albums()).albums.blue.availability, 'available')
  assert.deepEqual(await database.store.fileHashes({ sourceId }), cached)
  const clean = await ingest(listed.filter(song => song !== unresolvedSong))
  assert.equal(clean.unresolved, 0)
  assert.equal((await bridge.albums()).albums.blue.availability, 'partial')
  assert.equal((await database.store.fileHashes({ sourceId })).entries.length, cached.entries.length - 1)
})

test('a file replaced after prefetch is hashed and cached under its own version', async t => {
  const { database, music, files, songs, ingest } = await fixture(t)
  const library = createLibraryService({ store: database.store, fork: nodeFork })
  const { hashJobs } = library
  const sourceId = folderSourceId(music)
  const original = await hashAudioPayload(files.one)
  const replacement = write(path.join(music, 'replacement.mp3'), ...mp3(audioFrames()))
  const { contentHash, size } = await hashAudioPayload(replacement)
  const [song] = songs()
  try {
    await library.start()
    const scanned = await ingest([song], {
      prefetchHashes: async (wanted, signal) => {
        const [location] = wanted
        const version = await audioFileVersion(files.one)
        await hashJobs.prefetch(wanted, signal)
        await hashJobs.hash(files.one, signal, location)
        // Ingest has yet to read its first song. Only the real job's commit could have written this.
        const entry = { path: location.path, ...version, contentHash: original.contentHash, size: original.size }
        assert.deepEqual(await database.store.fileHashes({ sourceId }), { entries: [entry] })
        renameSync(replacement, files.one)
        assert.equal(await hashJobs.hash(files.one, signal, location), undefined)
        assert.deepEqual(await database.store.fileHashes({ sourceId }), { entries: [entry] })
      },
      hashFile: hashJobs.hash,
    })
    const providerId = { sourceId: NAVIDROME_SOURCE.id, kind: 'track', externalId: song.id }
    const subject = { kind: 'asset', id: `asset:${contentHash}:${size}` }
    assert.equal(scanned.failed, 0)
    assert.deepEqual(await database.service.resolveProviderId(providerId), { subject })
    assert.equal((await ingest([song])).reused, 1)
    assert.deepEqual(await database.service.resolveProviderId(providerId), { subject })
  } finally { await library.stop() }
})

test('migrating old tags is idempotent and never overrides a later choice', async t => {
  const { bridge, ingest, now } = await fixture(t)
  const old = [
    { providerAlbumId: 'blue', favorite: true, traits: { energy: ENERGY, mood: MOOD } },
    { providerAlbumId: 'red', favorite: false },
    { providerAlbumId: 'not-scanned-yet', traits: { vocal: OTHER } },
  ]
  const decidedAt = now()
  // Before the first scan nothing has an anchor, so everything waits.
  assert.deepEqual(await bridge.migrate({ decidedAt, albums: old }), { migrated: [], pending: ['blue', 'red', 'not-scanned-yet'] })
  assert.deepEqual(await bridge.setTrait({ providerAlbumId: 'blue', trait: 'energy', value: OTHER }), { applied: false })
  await ingest()
  const first = await bridge.migrate({ decidedAt, albums: old })
  assert.deepEqual(first, { migrated: ['blue', 'red'], pending: ['not-scanned-yet'] })
  const migrated = (await bridge.albums()).albums
  assert.deepEqual([migrated.blue.favorite, migrated.blue.traits.energy.value, migrated.blue.traits.mood.value, migrated.red.favorite], [true, ENERGY, MOOD, false])
  assert.equal(migrated.blue.traits.energy.observedAt, decidedAt)
  assert.deepEqual(await bridge.migrate({ decidedAt, albums: old }), first)
  assert.deepEqual((await bridge.albums()).albums, migrated)
  // The user changes their mind in the new store. A replay of the migration must not undo it.
  await bridge.setTrait({ providerAlbumId: 'blue', trait: 'energy', value: OTHER })
  await bridge.setTrait({ providerAlbumId: 'blue', trait: 'mood' })
  await bridge.setFavorite({ providerAlbumId: 'blue', value: false })
  await bridge.migrate({ decidedAt, albums: old })
  const kept = (await bridge.albums()).albums.blue
  assert.deepEqual([kept.favorite, kept.traits.energy.value, kept.traits.mood], [false, OTHER, undefined])
})

test('tags reach the read model, and a trait edit leaves a receipt that Undo takes back', async t => {
  const { database, ingest, songs, now } = await fixture(t)
  let time = now()
  const bridge = createCatalogBridge(database.service, { now: () => time })
  const tagged = songs().map((item, index) => ({ ...item, tags: { title: `Track ${index + 1}`, artist: 'Artist', album: item.albumId === 'blue' ? 'Blue' : 'Red', year: YEAR } }))
  await ingest(tagged)
  const listed = await database.service.listCatalogAlbums({ sort: 'title' })
  assert.deepEqual(listed.albums.map(album => [album.title, album.artist, album.year, album.trackCount]), [['Blue', 'Artist', YEAR, 2], ['Red', 'Artist', YEAR, 1]])
  assert.deepEqual((await database.service.searchCatalog({ query: 'track 3' })).tracks.map(track => track.title), ['Track 3'])
  // A scan that reads the same tags again moves no version, so no pending change goes stale.
  await ingest(tagged)
  assert.equal((await database.service.listCatalogAlbums({})).version, listed.version)
  const edit = { providerAlbumId: 'blue', trait: 'energy', value: ENERGY, changeId: 'change:one' }
  assert.deepEqual(await bridge.setTrait(edit), { applied: true })
  assert.deepEqual(await bridge.setTrait(edit), { applied: true }, 'a retry after a lost reply')
  // A slider drag: several sends close together are one receipt, whose Undo goes back to before the drag.
  for (const value of [MOOD, OTHER, ENERGY]) { time++; await bridge.setTrait({ providerAlbumId: 'blue', trait: 'energy', value }) }
  assert.equal((await bridge.activity()).total, 1)
  // The same axis after a pause, another axis and another album are changes of their own.
  time += TRAIT_COALESCE_MS + 1
  await bridge.setTrait({ providerAlbumId: 'blue', trait: 'energy', value: OTHER })
  const { entries, total } = await bridge.activity()
  assert.equal(total, 2)
  assert.deepEqual(entries.map(entry => [entry.actor, entry.summary, entry.detail, entry.undone, entry.undoable]), [
    ['you', `Set energy to ${OTHER} on Blue`, undefined, false, true], ['you', `Set energy to ${ENERGY} on Blue`, 'Undo the later change to this first.', false, false],
  ])
  assert.equal(entries[1].id, 'change:one')
  assert.deepEqual(await bridge.undo({ id: 'change:one' }), { status: 'blocked', reason: 'has-dependents', blockedBy: [entries[0].id] })
  assert.deepEqual(await bridge.undo({ id: entries[0].id }), { status: 'undone' })
  assert.equal((await bridge.albums()).albums.blue.traits.energy.value, ENERGY)
  assert.deepEqual((await bridge.activity({ limit: 2 })).entries.map(entry => [entry.undone, entry.undoable]), [[true, false], [false, true]])
  assert.deepEqual(await bridge.undo({ id: 'change:one' }), { status: 'undone' })
  assert.equal((await bridge.albums()).albums.blue.traits.energy, undefined)
  await bridge.setTrait({ providerAlbumId: 'blue', trait: 'mood', value: MOOD })
  await bridge.setTrait({ providerAlbumId: 'red', trait: 'mood', value: MOOD })
  await bridge.setTrait({ providerAlbumId: 'blue', trait: 'mood', value: OTHER })
  assert.equal((await bridge.activity()).total, 2 + 3)
  // A favourite has a receipt and an Undo of its own. Consent is a setting and has neither.
  assert.deepEqual(await bridge.setFavorite({ providerAlbumId: 'red', value: true }), { applied: true })
  await bridge.setConsent({ consent: 'online-lookups', value: 'granted' })
  const [favourite, ...rest] = (await bridge.activity()).entries
  assert.deepEqual([favourite.summary, favourite.undoable, rest.length], ['Added Red to favourites', true, 2 + 3])
  assert.equal((await bridge.albums()).albums.red.favorite, true)
  assert.deepEqual(await bridge.undo({ id: favourite.id }), { status: 'undone' })
  assert.equal((await bridge.albums()).albums.red.favorite, false)
  assert.deepEqual(await bridge.consent(), { 'online-lookups': 'granted', acoustid: 'not-asked', spotify: 'not-asked' })
  assert.equal((await database.service.verifyProjections()).consistent, true)
})

test('consent is offline by default and stored as a user decision', async t => {
  const { bridge, database } = await fixture(t)
  assert.deepEqual(await bridge.consent(), { 'online-lookups': 'not-asked', acoustid: 'not-asked', spotify: 'not-asked' })
  assert.deepEqual(await bridge.setConsent({ consent: 'online-lookups', value: 'granted' }), { 'online-lookups': 'granted', acoustid: 'not-asked', spotify: 'not-asked' })
  assert.deepEqual(await bridge.setConsent({ consent: 'online-lookups', value: 'denied' }), { 'online-lookups': 'denied', acoustid: 'not-asked', spotify: 'not-asked' })
  assert.deepEqual(await database.service.getConsent(), await bridge.consent())
})

test('catalog requests from the window are validated', () => {
  const accepted = [
    ['albums', []], ['consent', []], ['set-trait', [{ providerAlbumId: 'a', trait: 'energy', value: ENERGY }]], ['set-trait', [{ providerAlbumId: 'a', trait: 'mood' }]],
    ['set-favorite', [{ providerAlbumId: 'a', value: false }]], ['set-consent', [{ consent: 'online-lookups', value: 'denied' }]],
    ['migrate', [{ decidedAt: DAY_MS, albums: [{ providerAlbumId: 'a', favorite: true, traits: { vocal: OTHER } }] }]],
    ['activity', []], ['activity', [{ limit: 1 }]], ['undo', [{ id: 'change:one' }]], ['set-trait', [{ providerAlbumId: 'a', trait: 'mood', changeId: 'change:one' }]],
  ]
  for (const [method, args] of accepted) assert.doesNotThrow(() => validateCatalogBridgeRequest(method, args), method)
  const refused = [
    ['ingestScan', [{}]], ['albums', [{}]], ['set-trait', []], ['set-trait', [{ providerAlbumId: '', trait: 'energy', value: ENERGY }]],
    ['set-trait', [{ providerAlbumId: 'a', trait: 'tempo', value: ENERGY }]], ['set-trait', [{ providerAlbumId: 'a', trait: 'energy', value: 101 }]],
    ['set-favorite', [{ providerAlbumId: 'a', value: 'yes' }]], ['set-consent', [{ consent: 'everything', value: 'granted' }]],
    ['set-consent', [{ consent: 'acoustid', value: 'not-asked' }]], ['migrate', [{ decidedAt: 0, albums: [] }]],
    ['migrate', [{ decidedAt: DAY_MS, albums: [{ providerAlbumId: 'a', traits: { energy: -1 } }] }]], ['migrate', [{ decidedAt: DAY_MS, albums: 'all' }]],
    ['activity', [{ limit: 0 }]], ['activity', ['all']], ['undo', []], ['undo', [{ id: '../library.sqlite' }]],
    ['set-trait', [{ providerAlbumId: 'a', trait: 'mood', changeId: 'not an id' }]], ['commitChangeSet', [{}]],
  ]
  for (const [method, args] of refused) assert.throws(() => validateCatalogBridgeRequest(method, args), /catalog (request|operation)/, `${method} ${JSON.stringify(args)}`)
})

test('the sync waits for the scan, ingests once per finished scan and stops cleanly', async t => {
  const { database, bridge, songs, music, archive } = await fixture(t)
  // Hashing runs as `hash` jobs in a worker process, as in the app.
  const library = createLibraryService({ store: database.store, fork: nodeFork })
  await library.start()
  t.after(() => library.stop())
  const POLL_MS = 5
  const NEVER_SCANNED = '0001-01-01T00:00:00Z', SCANNED = '2026-01-01T00:00:00Z'
  let scanning = true, lastScan = NEVER_SCANNED, searches = 0
  const answer = body => ({ ok: true, json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }) })
  const fetch = async url => {
    const { pathname, searchParams } = new URL(url)
    assert.equal(searchParams.get('u'), 'admin')
    assert.equal(searchParams.get('p'), null)
    if (pathname.endsWith('/getScanStatus')) return answer({ scanStatus: { scanning, count: 3, lastScan } })
    searches++
    return answer({ searchResult3: { song: Number(searchParams.get('songOffset')) ? [] : songs().map(({ disc, ...song }) => ({ ...song, discNumber: disc })) } })
  }
  const connection = { base: 'http://127.0.0.1:1', username: 'admin', password: 'secret', fetch }
  assert.equal((await fetchLibrarySongs(connection)).length, 3)
  searches = 0
  const results = []
  const done = new Promise(resolve => {
    const sync = startCatalogSync({
      connection, catalog: database.store, folders: [music, archive], pollMs: POLL_MS, hashFile: file => hashAudioPayload(file),
      resolveFile: song => song.path, onChange: result => { if (result) { results.push(result); setTimeout(() => resolve(sync), POLL_MS * 4) } },
    })
    // First a scan in progress, then a server that has never scanned, then a finished scan.
    setTimeout(() => { assert.equal(searches, 0); scanning = false }, POLL_MS * 4)
    setTimeout(() => { assert.equal(searches, 0); lastScan = SCANNED }, POLL_MS * 8)
  })
  const sync = await done
  await sync.stop()
  assert.equal(results.length, 1)
  assert.equal(searches, 1)
  assert.deepEqual([results[0].assets, results[0].albums, results[0].hashed], [3, 2, 3])
  assert.deepEqual(Object.keys((await bridge.albums()).albums).sort(), ['blue', 'red'])
})
