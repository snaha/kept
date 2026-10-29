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
  /** the encoding, for grouping by quality; absent in inventories written before it was read */
  audio?: { codec: string; bitrate: number; sampleRate: number; channels: number; lossless: boolean };
};

export type TagReader = (path: string) => Promise<FileInfo>;

export const emptyTags = (): Tags => Object.fromEntries(FIELDS.map((f) => [f, ''])) as Tags;

/** common keys the `Tags` fields are built from; everything else goes to `extra` */
const MAPPED = new Set(['title', 'artist', 'album', 'albumartist', 'track', 'disk', 'year', 'genre', 'compilation', 'musicbrainz_recordingid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'picture']);

/** ID3v2 involved-people roles and the common names music-metadata uses for them elsewhere */
const INVOLVED: Record<string, string> = { 'DJ-mix': 'djmixer', mix: 'mixer', producer: 'producer', engineer: 'engineer', arranger: 'arranger' };

const isBinary =(v: unknown): boolean =>
  v instanceof Uint8Array || (typeof v === 'object' && v !== null && Object.values(v as object).some((x) => x instanceof Uint8Array));

/** RIFF INFO carries no encoding, so music-metadata reads a WAV's INFO text as Latin-1 and UTF-8 arrives as
 *  mojibake ('CafÃ©' for 'Café'). Re-decoded when the text has UTF-8's lead-and-continuation shape and survives
 *  the decode; real Latin-1 text with accents does not have that shape. */
const MOJIBAKE = /[\u00c2-\u00f4][\u0080-\u00bf]/;
function redecode(s: string): string {
  if (!MOJIBAKE.test(s)) return s;
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('\ufffd') ? s : utf8;
}

export function fromMetadata(path: string, { common, format, native }: IAudioMetadata): FileInfo {
  const formats = Object.keys(native ?? {});
  const infoOnly = formats.length > 0 && formats.every((f) => f === 'exif');
  const text = (v: string | undefined): string => (infoOnly ? redecode(v ?? '') : v ?? '');
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(common)) if (!MAPPED.has(k) && v !== undefined && !isBinary(v)) extra[k] = v;
  const raw: FileInfo['raw'] = {};
  for (const [fmt, tags] of Object.entries(native ?? {})) {
    const kept = tags.filter((t) => !isBinary(t.value)).map(({ id, value }) => ({ id, value }));
    if (kept.length) raw[fmt] = kept;
  }
  // music-metadata reads an ID3v2 involved-people list (TIPL, IPLS) as { role: names } but maps no role to a
  // common name, so a DJ-mixer written by tagsmith or Picard would read back as missing
  for (const t of Object.values(raw).flat()) {
    if ((t.id !== 'TIPL' && t.id !== 'IPLS') || typeof t.value !== 'object' || !t.value) continue;
    for (const [role, names] of Object.entries(t.value as Record<string, string[]>)) {
      const key = INVOLVED[role];
      if (key && extra[key] === undefined) extra[key] = names;
    }
  }
  return {
    path,
    tags: {
      title: text(common.title),
      artist: text(common.artist),
      album: text(common.album),
      albumartist: text(common.albumartist),
      track: common.track.no ? String(common.track.no) : '',
      disc: common.disk.no ? String(common.disk.no) : '',
      year: common.year ? String(common.year) : '',
      genre: text(common.genre?.[0]),
      compilation: common.compilation ? '1' : '',
      mb_recordingid: common.musicbrainz_recordingid ?? '',
      mb_albumid: common.musicbrainz_albumid ?? '',
      mb_releasegroupid: common.musicbrainz_releasegroupid ?? '',
    },
    extra,
    raw,
    duration: Math.round(format.duration ?? 0),
    pictures: (common.picture ?? []).map((p) => p.data.length),
    audio: {
      codec: format.codec ?? '',
      bitrate: Math.round(format.bitrate ?? 0),
      sampleRate: format.sampleRate ?? 0,
      channels: format.numberOfChannels ?? 0,
      lossless: !!format.lossless,
    },
  };
}

export const readTags: TagReader = async (path) => fromMetadata(path, await parseFile(path, { duration: true, skipCovers: false }));
