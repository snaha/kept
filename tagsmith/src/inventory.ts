/** Stage 1: walk folders, read tags, classify each folder, and list what is wrong without touching the network. */
import { readdir, open } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { AUDIO, IMAGE, discOf, ext, known, nfc, norm } from './text.ts';
import { emptyTags, readTags, type FileInfo, type TagReader } from './tags.ts';

/** More audio files than this in one folder is a dump, not an album (2–3 CD sets stay under it). */
export const DUMP = 60;

export type FolderClass =
  | 'album' // one album, one owner
  | 'disc' // a CD n / Disc n folder of a set
  | 'multi' // flat folder holding several albums
  | 'compilation' // one album, no artist holds 60 percent
  | 'dump' // too many files to be an album
  | 'singles' // one or two files
  | 'untagged'; // most files carry no album and no artist

export type Folder = {
  /** absolute path */
  dir: string;
  class: FolderClass;
  files: FileInfo[];
  /** image file names in the folder */
  images: string[];
  stats: {
    files: number;
    albums: number;
    artists: number;
    /** share of files held by the most common artist, 0..1 */
    topArtistShare: number;
    untitled: number;
    noArtist: number;
    numberedNames: number;
    /** files carrying a MusicBrainz release id */
    identified: number;
  };
  /** most files carry a MusicBrainz release id: identify can skip the folder and covers can go by release id */
  identified: boolean;
  findings: string[];
};

export type Inventory = { roots: string[]; scanned: string; folders: Folder[] };

export type InventoryOptions = {
  read?: TagReader;
  dump?: number;
  onProgress?: (done: number, dir: string) => void;
};

const MAGIC: [string, string][] = [['ffd8ff', 'jpeg'], ['89504e47', 'png'], ['47494638', 'gif'], ['424d', 'bmp'], ['52494646', 'webp']];

async function imageKind(path: string): Promise<string | null> {
  const fh = await open(path);
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(8), 0, 8, 0);
    const hex = buffer.subarray(0, bytesRead).toString('hex');
    return MAGIC.find(([m]) => hex.startsWith(m))?.[1] ?? null;
  } finally {
    await fh.close();
  }
}

/** Every folder under the roots that holds audio, with its audio and image file names. */
async function walk(roots: string[]): Promise<{ dir: string; audio: string[]; images: string[] }[]> {
  const out: { dir: string; audio: string[]; images: string[] }[] = [];
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const audio: string[] = [];
    const images: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) await visit(join(dir, e.name));
      else if (AUDIO.has(ext(e.name))) audio.push(e.name);
      else if (IMAGE.has(ext(e.name))) images.push(e.name);
    }
    if (audio.length) out.push({ dir, audio: audio.sort(), images: images.sort() });
  };
  for (const r of roots) await visit(r);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

const top = (counts: Map<string, number>): number => Math.max(0, ...counts.values());

function count<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function classify(dir: string, files: FileInfo[], dump = DUMP): { class: FolderClass; stats: Folder['stats'] } {
  const n = files.length;
  const albums = count(files, (f) => (known(f.tags.album) ? norm(f.tags.album) : ''));
  const artists = count(files, (f) => (known(f.tags.artist) ? norm(f.tags.artist) : ''));
  const stats: Folder['stats'] = {
    files: n,
    albums: albums.size,
    artists: artists.size,
    topArtistShare: n ? top(artists) / n : 0,
    untitled: files.filter((f) => !known(f.tags.title)).length,
    noArtist: files.filter((f) => !known(f.tags.artist)).length,
    numberedNames: files.filter((f) => /^\s*\(?\d{1,3}\)?[\s._)-]/.test(basename(f.path))).length,
    identified: files.filter((f) => f.tags.mb_albumid).length,
  };
  const albumArtist = files.find((f) => known(f.tags.albumartist))?.tags.albumartist;
  let cls: FolderClass;
  if (n > dump) cls = 'dump';
  else if (n <= 2) cls = 'singles';
  else if (discOf(basename(dir)) !== null) cls = 'disc';
  else if (stats.noArtist / n > 0.5 && (albums.size === 0 || stats.untitled / n > 0.5)) cls = 'untagged';
  else if (albums.size >= 3 && [...albums.values()].filter((c) => c >= 2).length >= 2) cls = 'multi';
  else if (stats.topArtistShare < 0.6 && !(albumArtist && known(albumArtist) && artists.size <= 1)) cls = 'compilation';
  else cls = 'album';
  return { class: cls, stats };
}

export async function findings(dir: string, cls: FolderClass, files: FileInfo[], images: string[]): Promise<string[]> {
  const out: string[] = [];
  if (nfc(dir) !== dir) out.push('folder name is decomposed unicode (NFD); compare by NFC');
  const broken = files.filter((f) => f.pictures.some((s) => s === 0));
  if (broken.length) out.push(`${broken.length} files carry a zero-byte picture frame`);
  for (const img of images) {
    const kind = await imageKind(join(dir, img));
    if (!kind) out.push(`${img} is not an image`);
    else if (kind === 'bmp') out.push(`${img} is BMP, which servers ignore as a cover`);
    else if (cls === 'multi' && /^(cover|folder|front)\./i.test(img)) out.push(`${img} would show on every album in this folder`);
  }
  if (files.some((f) => /^\[?unknown album\]?$/i.test(f.tags.album))) out.push('files tagged with a placeholder album');
  return out;
}

/** Index every folder under the roots. Read only. */
export async function inventory(roots: string[], opts: InventoryOptions = {}): Promise<Inventory> {
  const read = opts.read ?? readTags;
  const folders: Folder[] = [];
  const tree = await walk(roots);
  for (const [i, { dir, audio, images }] of tree.entries()) {
    const files: FileInfo[] = [];
    const unreadable: string[] = [];
    for (const name of audio) {
      try {
        files.push(await read(join(dir, name)));
      } catch {
        // a corrupt header counts as an untagged file; the name is reported so it can be fixed by hand
        files.push({ path: join(dir, name), tags: emptyTags(), extra: {}, raw: {}, duration: 0, pictures: [] });
        unreadable.push(name);
      }
    }
    const { class: cls, stats } = classify(dir, files, opts.dump);
    const notes = await findings(dir, cls, files, images);
    if (unreadable.length) notes.push(`${unreadable.length} files could not be read: ${unreadable.slice(0, 3).join(', ')}`);
    folders.push({ dir, class: cls, files, images, stats, identified: stats.identified / files.length >= 0.6, findings: notes });
    opts.onProgress?.(i + 1, dir);
  }
  return { roots, scanned: new Date().toISOString(), folders };
}

/** The name a disc folder's set is known by: its parent folder. */
export const setName = (dir: string): string => basename(dirname(dir));
