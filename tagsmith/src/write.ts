/** Writing tags to one audio file. The only module that writes audio files, so a stub can replace it in tests and
 *  apply can never reach a file by another route. node-taglib-sharp, a port of TagLib#, writes the frames and
 *  fields TagLib reads back, and TagLib is what Navidrome reads tags with. */
import {
  ByteVector,
  File,
  Id3v2FrameIdentifiers,
  Id3v2Settings,
  Id3v2Tag,
  Picture,
  PictureType,
  TagTypes,
  XiphComment,
  type Tag,
} from 'node-taglib-sharp'
import type { Field } from './proposal.ts'

export type Write = {
  /** proposal fields and their new values; several names are joined by '; ' as the proposal shows them */
  set: Partial<Record<Field, string>>
  /** a JPEG front cover to embed in place of any front cover the file has */
  cover?: Buffer
  /** lyrics text, LRC when synced; Navidrome serves embedded LRC as synced lyrics */
  lyrics?: string
}

export type TagWriter = (path: string, w: Write) => Promise<void>

/** ID3v2.4 keeps several values in one frame and has TIPL for the DJ-mixer; Navidrome and every current player read it. */
const ID3V2_VERSION = 4
Id3v2Settings.defaultVersion = ID3V2_VERSION
Id3v2Settings.forceDefaultVersion = true
// a genre is written as text: TagLib#'s numbers for the ID3v1 genres are named differently by other readers
// (40 is 'Alternative Rock' to TagLib#, 'Alt. Rock' to music-metadata)
Id3v2Settings.useNumericGenres = false

const MPEG = /\.mp3$/i

const list = (v: string): string[] => v.split(';').map((s) => s.trim()).filter(Boolean)
/** '-5.60 dB' -> -5.6 */
const decibels = (v: string): number => Number.parseFloat(v)

function setStandard(tag: Tag, field: Field, v: string): void {
  switch (field) {
    case 'title': tag.title = v; break
    case 'artist': tag.performers = [v]; break
    case 'album': tag.album = v; break
    case 'albumartist': tag.albumArtists = [v]; break
    case 'track': tag.track = Number(v); break
    case 'disc': tag.disc = Number(v); break
    case 'year': tag.year = Number(v); break
    case 'genre': tag.genres = list(v); break
    case 'compilation': tag.isCompilation = v === '1'; break
    case 'remixer': tag.remixedBy = v; break
    case 'musicbrainz_trackid': tag.musicBrainzTrackId = v; break
    case 'musicbrainz_albumid': tag.musicBrainzReleaseId = v; break
    case 'musicbrainz_releasegroupid': tag.musicBrainzReleaseGroupId = v; break
    case 'musicbrainz_artistid': tag.musicBrainzArtistId = v; break
    case 'replaygain_track_gain': tag.replayGainTrackGain = decibels(v); break
    case 'replaygain_track_peak': tag.replayGainTrackPeak = Number(v); break
    case 'replaygain_album_gain': tag.replayGainAlbumGain = decibels(v); break
    case 'replaygain_album_peak': tag.replayGainAlbumPeak = Number(v); break
    case 'djmixer': break
  }
}

/** Writes in place: apply calls it on its own copy, never on a file of the scanned library. An MP3 gets an ID3v2.4
 *  tag and loses its ID3v1 tag, whose 30-character fields hold the cut titles the proposal repairs. */
export const writeTags: TagWriter = async (path, w) => {
  const file = File.createFromPath(path)
  try {
    const id3 = MPEG.test(path) ? (file.getTag(TagTypes.Id3v2, true) as Id3v2Tag) : undefined
    if (id3) {
      // what only the ID3v1 tag holds moves to ID3v2 first, so dropping ID3v1 loses nothing the proposal kept
      const v1 = file.getTag(TagTypes.Id3v1, false)
      if (v1) v1.copyTo(id3, false)
      file.removeTags(TagTypes.Id3v1)
      // an ID3v2.3 year (TYER) is kept under its old id and dropped when the tag is saved as 2.4; written anew as TDRC
      const year = id3.year
      id3.removeFrames(Id3v2FrameIdentifiers.TYER)
      id3.removeFrames(Id3v2FrameIdentifiers.TDRC)
      if (year) id3.year = year
    }
    const xiph = file.getTag(TagTypes.Xiph, false) as XiphComment | undefined
    const tag = id3 ?? file.tag
    for (const [field, v] of Object.entries(w.set) as [Field, string][]) {
      if (field === 'remixer' && id3) id3.setTextFrame(Id3v2FrameIdentifiers.TPE4, ...list(v))
      else if (field === 'djmixer' && id3) id3.setTextFrame(Id3v2FrameIdentifiers.TIPL, ...list(v).flatMap((name) => ['DJ-mix', name]))
      else if (field === 'djmixer' && xiph) xiph.setFieldAsStrings('DJMIXER', ...list(v))
      else setStandard(tag, field, v)
    }
    if (w.cover) {
      const front = Picture.fromFullData(ByteVector.fromByteArray(w.cover), PictureType.FrontCover, 'image/jpeg', '')
      tag.pictures = [...tag.pictures.filter((p) => p.type !== PictureType.FrontCover), front]
    }
    if (w.lyrics) tag.lyrics = w.lyrics
    file.save()
  } finally {
    file.dispose()
  }
}
