/** Reading tags from one audio file. The only module that touches music-metadata, so a stub can replace it in tests. */
import { parseFile, type IAudioMetadata } from 'music-metadata';

/** The fields the pipeline plans and applies, every one a string, '' when absent. Same names as the Python pipeline,
 *  plus the MusicBrainz ids that tell an identified file from a guessed one. */
export type Tags = {
  title: string;
  artist: string;
  album: string;
  albumartist: string;
  track: string;
  disc: string;
  year: string;
  genre: string;
  compilation: string;
  mb_recordingid: string;
  mb_albumid: string;
  mb_releasegroupid: string;
};
export const FIELDS: (keyof Tags)[] = ['title', 'artist', 'album', 'albumartist', 'track', 'disc', 'year', 'genre', 'compilation', 'mb_recordingid', 'mb_albumid', 'mb_releasegroupid'];

export type FileInfo = {
  /** absolute path */
  path: string;
  tags: Tags;
  /** every other tag music-metadata understood (common names such as `composer`, `bpm`, `musicbrainz_artistid`),
   *  kept so nothing is lost when a future stage learns to use it */
  extra: Record<string, unknown>;
  /** the file's raw frames by tag format (`ID3v2.3`, `vorbis`, `iTunes`), pictures and other binary values left out */
  raw: Record<string, { id: string; value: unknown }[]>;
  /** seconds, 0 when unknown */
  duration: number;
  /** byte size of every embedded picture; a 0 is a broken frame that servers render as a missing image */
  pictures: number[];
};

export type TagReader = (path: string) => Promise<FileInfo>;

export const emptyTags = (): Tags => Object.fromEntries(FIELDS.map((f) => [f, ''])) as Tags;

/** common keys the `Tags` fields are built from; everything else goes to `extra` */
const MAPPED = new Set(['title', 'artist', 'album', 'albumartist', 'track', 'disk', 'year', 'genre', 'compilation', 'musicbrainz_recordingid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'picture']);

const isBinary = (v: unknown): boolean =>
  v instanceof Uint8Array || (typeof v === 'object' && v !== null && Object.values(v as object).some((x) => x instanceof Uint8Array));

export function fromMetadata(path: string, { common, format, native }: IAudioMetadata): FileInfo {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(common)) if (!MAPPED.has(k) && v !== undefined && !isBinary(v)) extra[k] = v;
  const raw: FileInfo['raw'] = {};
  for (const [fmt, tags] of Object.entries(native ?? {})) {
    const kept = tags.filter((t) => !isBinary(t.value)).map(({ id, value }) => ({ id, value }));
    if (kept.length) raw[fmt] = kept;
  }
  return {
    path,
    tags: {
      title: common.title ?? '',
      artist: common.artist ?? '',
      album: common.album ?? '',
      albumartist: common.albumartist ?? '',
      track: common.track.no ? String(common.track.no) : '',
      disc: common.disk.no ? String(common.disk.no) : '',
      year: common.year ? String(common.year) : '',
      genre: common.genre?.[0] ?? '',
      compilation: common.compilation ? '1' : '',
      mb_recordingid: common.musicbrainz_recordingid ?? '',
      mb_albumid: common.musicbrainz_albumid ?? '',
      mb_releasegroupid: common.musicbrainz_releasegroupid ?? '',
    },
    extra,
    raw,
    duration: Math.round(format.duration ?? 0),
    pictures: (common.picture ?? []).map((p) => p.data.length),
  };
}

export const readTags: TagReader = async (path) => fromMetadata(path, await parseFile(path, { duration: true, skipCovers: false }));
