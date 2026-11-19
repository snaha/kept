import { isMbid } from './musicbrainz.js'

// The identifiers and album hints a file carries in its own tags, which the music server does not
// pass on: MusicBrainz IDs, the compilation flag and the album artist. Read with Tagsmith's
// read-only entry. Without Tagsmith beside the app there is no reader, and the ladder goes on with
// what the catalog already knows.

// The bundle that ships beside main.js (scripts/build-preload.mjs), then the compiled entry, then the
// sources, which Node runs directly where it strips types.
const TAGSMITH_ENTRIES = ['./tagsmith-read.js', '../tagsmith/dist/read.js', '../tagsmith/src/read.ts']

let loading

// Deliberate lazy loading: the tag parser is heavy and loads only in the worker process that reads tags.
async function loadReader() {
  for (const entry of TAGSMITH_ENTRIES) {
    try {
      const { readTags } = await import(new URL(entry, import.meta.url).href)
      if (typeof readTags === 'function') return readTags
    } catch { /* not installed here: try the next entry */ }
  }
  console.warn('[kept] Tagsmith is not available: embedded tags and MusicBrainz IDs are not read, and the ladder goes on without them.')
  return undefined
}

const mbid = value => (isMbid(value) ? value : undefined)

// What the ladder uses of one file's tags.
export const embeddedOf = info => ({
  releaseId: mbid(info.tags.mb_albumid), recordingId: mbid(info.tags.mb_recordingid), releaseGroupId: mbid(info.tags.mb_releasegroupid),
  compilation: info.tags.compilation === '1' ? true : undefined, albumArtist: info.tags.albumartist || undefined,
})

// Resolves to file -> embedded tags (undefined for a file that cannot be read), or to undefined
// when no reader is available.
export async function createEmbeddedReader() {
  loading ??= loadReader()
  const readTags = await loading
  if (!readTags) return undefined
  return async file => {
    try { return embeddedOf(await readTags(file)) } catch { return undefined }
  }
}
