/** Reading tags from one audio file. The only module that touches music-metadata, so a stub can replace it in tests. */
import { parseFile } from 'music-metadata';

/** The fields the pipeline plans and applies, every one a string, '' when absent. Same names as the Python pipeline. */
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
};
export const FIELDS: (keyof Tags)[] = ['title', 'artist', 'album', 'albumartist', 'track', 'disc', 'year', 'genre', 'compilation'];

export type FileInfo = {
  /** absolute path */
  path: string;
  tags: Tags;
  /** seconds, 0 when unknown */
  duration: number;
  /** byte size of every embedded picture; a 0 is a broken frame that servers render as a missing image */
  pictures: number[];
};

export type TagReader = (path: string) => Promise<FileInfo>;

export const emptyTags = (): Tags => ({ title: '', artist: '', album: '', albumartist: '', track: '', disc: '', year: '', genre: '', compilation: '' });

export const readTags: TagReader = async (path) => {
  const { common, format } = await parseFile(path, { duration: true, skipCovers: false });
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
    },
    duration: Math.round(format.duration ?? 0),
    pictures: (common.picture ?? []).map((p) => p.data.length),
  };
};
