import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory, type Inventory } from '../src/inventory.ts';
import { emptyTags, type TagReader } from '../src/tags.ts';

/** tags by file name; files not listed are untagged */
const MBID = 'c8c5f1a0-6d5e-4b4e-9d4e-0f1c2b3a4d5e';
const TAGS: Record<string, Partial<ReturnType<typeof emptyTags>> & { pictures?: number[] }> = {
  '01 - Hands Up.mp3': { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Hands Up', pictures: [0], mb_albumid: MBID },
  '02 - Labor Day.mp3': { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Labor Day', mb_albumid: MBID },
  '03 - Anxiety.mp3': { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Anxiety' },
  'beatles1.mp3': { artist: 'The Beatles', album: '1', title: 'Help!' },
  'beatles2.mp3': { artist: 'The Beatles', album: '1', title: 'Yesterday' },
  'acdc1.mp3': { artist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells' },
  'acdc2.mp3': { artist: 'AC/DC', album: 'Back in Black', title: 'Shoot to Thrill' },
  'riff1.mp3': { artist: 'Aerosmith', album: 'Toys in the Attic', title: 'Walk This Way' },
  'riff2.mp3': { artist: 'Aerosmith', album: 'Toys in the Attic', title: 'Sweet Emotion' },
};

const read: TagReader = async (path) => {
  const t = TAGS[basename(path)] ?? {};
  const { pictures = [], ...tags } = t;
  return { path, tags: { ...emptyTags(), ...tags }, extra: {}, raw: {}, duration: 0, pictures };
};

let root: string;
let inv: Inventory;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tagsmith-'));
  const mk = async (dir: string, files: Record<string, Buffer | string>) => {
    await mkdir(join(root, dir), { recursive: true });
    for (const [name, data] of Object.entries(files)) await writeFile(join(root, dir, name), data);
  };
  await mk('Black Eyed Peas/Elephunk', { '01 - Hands Up.mp3': '', '02 - Labor Day.mp3': '', '03 - Anxiety.mp3': '', 'cover.bmp': Buffer.from('424d0000', 'hex') });
  await mk('Guitar Riffs', { 'beatles1.mp3': '', 'beatles2.mp3': '', 'acdc1.mp3': '', 'acdc2.mp3': '', 'riff1.mp3': '', 'riff2.mp3': '', 'Folder.jpg': Buffer.from('ffd8ffe0', 'hex'), 'front.jpg': 'not an image' });
  await mk('Fluke - Risotto', { '01 - Absurd.mp3': '', '02 - Atom Bomb.mp3': '', '03 - Kitten Moon.mp3': '' });
  await mk('Loose', { 'Chi mai.mp3': '' });
  await mk('Empty', { 'readme.txt': '' });
  inv = await inventory([root], { read });
});

afterAll(() => rm(root, { recursive: true, force: true }));

const byName = (name: string) => inv.folders.find((f) => basename(f.dir) === name)!;

describe('inventory', () => {
  it('indexes only folders with audio, recursively', () => {
    expect(inv.folders.map((f) => basename(f.dir)).sort()).toEqual(['Elephunk', 'Fluke - Risotto', 'Guitar Riffs', 'Loose']);
    expect(byName('Elephunk').files.map((f) => basename(f.path))).toEqual(['01 - Hands Up.mp3', '02 - Labor Day.mp3', '03 - Anxiety.mp3']);
  });

  it('classifies folders', () => {
    expect(byName('Elephunk').class).toBe('album');
    expect(byName('Guitar Riffs').class).toBe('multi');
    expect(byName('Fluke - Risotto').class).toBe('untagged');
    expect(byName('Loose').class).toBe('singles');
    expect(byName('Elephunk').stats).toMatchObject({ files: 3, albums: 1, artists: 1, topArtistShare: 1, numberedNames: 3, identified: 2 });
  });

  it('marks folders whose files carry MusicBrainz release ids as identified', () => {
    expect(byName('Elephunk').identified).toBe(true);
    expect(byName('Guitar Riffs').identified).toBe(false);
  });

  it('reports findings without the network', () => {
    expect(byName('Elephunk').findings).toEqual(['1 files carry a zero-byte picture frame', 'cover.bmp is BMP, which servers ignore as a cover']);
    expect(byName('Guitar Riffs').findings).toEqual(['Folder.jpg would show on every album in this folder', 'front.jpg is not an image']);
    expect(byName('Fluke - Risotto').findings).toEqual([]);
  });
});
