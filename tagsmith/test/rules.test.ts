import { describe, expect, it } from 'vitest';
import type { Folder } from '../src/inventory.ts';
import { classify } from '../src/inventory.ts';
import { albumOfFolder, plan, planFiles, planFolder } from '../src/rules.ts';
import { emptyTags, type FileInfo, type Tags } from '../src/tags.ts';

const file = (dir: string, name: string, tags: Partial<Tags> = {}): FileInfo => ({ path: `${dir}/${name}`, tags: { ...emptyTags(), ...tags }, extra: {}, raw: {}, duration: 0, pictures: [] });

const folder = (dir: string, files: FileInfo[], images: string[] = []): Folder => {
  const { class: cls, stats } = classify(dir, files);
  return { dir, class: cls, files, images, stats, identified: false, findings: [] };
};

describe('albumOfFolder', () => {
  it('names a disc folder after its parent', () => {
    expect(albumOfFolder('/m/Keeper Of The Flame/CD 2')).toEqual({ album: 'Keeper Of The Flame', disc: 2 });
    expect(albumOfFolder('/m/Poncho Sanchez/Keeper Of The Flame Disc 1')).toEqual({ album: 'Keeper Of The Flame', disc: 1 });
    expect(albumOfFolder('/m/VA - City Lounge Paris [320]')).toEqual({ album: 'City Lounge Paris', disc: null });
    expect(albumOfFolder('/m/BODYCNT', { BODYCNT: 'Body Count' })).toEqual({ album: 'Body Count', disc: null });
  });
});

describe('planFolder', () => {
  it('keeps complete non-Latin tags instead of treating them as missing', () => {
    const dir = '/m/正しいアルバム';
    const f = folder(dir, [1, 2, 3].map((n) => file(dir, `0${n}.flac`, { artist: '日本語の歌手', albumartist: '日本語の歌手', album: '正しいアルバム', title: `曲 ${n}` })));
    expect(f.class).toBe('album');
    expect(planFolder(f)).toMatchObject({ album: '正しいアルバム', albumartist: '日本語の歌手', compilation: false });
  });

  it('makes a mixed folder a Various Artists compilation named after the folder', () => {
    const dir = '/m/Old Skool Funk';
    const f = folder(dir, [
      file(dir, '01 - Parliament - Flash Light.mp3', { artist: 'Parliament', title: 'Flash Light' }),
      file(dir, '02 - Zapp - More Bounce.mp3', { artist: 'Zapp', title: 'More Bounce' }),
      file(dir, '03 - Cameo - Word Up.mp3', { artist: 'Cameo', title: 'Word Up' }),
    ]);
    expect(f.class).toBe('compilation');
    const p = planFolder(f);
    expect(p).toMatchObject({ album: 'Old Skool Funk', albumartist: 'Various Artists', compilation: true, disc: null });
  });

  it('gives the album to the artist holding 60% and keeps the tagged album name', () => {
    const dir = '/m/Black Eyed Peas/Elephunk [v0]';
    const f = folder(dir, [
      file(dir, '01 - Hands Up.mp3', { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Hands Up' }),
      file(dir, '02 - Labor Day.mp3', { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Labor Day' }),
      file(dir, '03 - Let Me Get It.mp3', { artist: 'Black Eyed Peas feat. Papa Roach', album: 'Elephunk', title: 'Anxiety' }),
      file(dir, '04 - .mp3', { artist: 'Black Eyed Peas', album: 'Elephunk' }),
      file(dir, '05 - Latin Girls.mp3', { artist: 'Black Eyed Peas', album: 'Elephunk', title: 'Latin Girls' }),
    ]);
    expect(planFolder(f)).toMatchObject({ album: 'Elephunk', albumartist: 'Black Eyed Peas', compilation: false });
  });

  it('keeps an album artist the files already agree on, such as a DJ mix', () => {
    const dir = '/m/Breakin Borders Vol.1 - Mezmerized - dj Mez';
    const f = folder(dir, [
      file(dir, 'Mezmerized - 01 - Intro.mp3', { artist: 'Mezmerized', albumartist: 'DJ Mez', album: 'Breakin Borders Vol.1', title: 'Intro' }),
      file(dir, 'Mezmerized - 02 - Flow.mp3', { artist: 'Plump DJs', albumartist: 'DJ Mez', album: 'Breakin Borders Vol.1', title: 'Flow' }),
      file(dir, 'Mezmerized - 03 - Beat.mp3', { artist: 'Autobots', albumartist: 'DJ Mez', album: 'Breakin Borders Vol.1', title: 'Beat' }),
    ]);
    expect(planFolder(f)).toMatchObject({ album: 'Breakin Borders Vol.1', albumartist: 'DJ Mez', compilation: false });
  });

  it('drops a trailing year from a filename title', () => {
    const dir = "/m/Best Of The 80's/CD 1";
    const f = folder(dir, [
      file(dir, '01. Katrina and the Waves - Walking On Sunshine (1985).mp3', { artist: 'Katrina and the Waves' }),
      file(dir, '02. a-ha - Take On Me (1985).mp3', { artist: 'a-ha' }),
      file(dir, '03. Nena - 99 Luftballons (1983).mp3', { artist: 'Nena' }),
    ]);
    expect(planFiles(f)[0].after?.title).toBe('Walking On Sunshine');
  });

  it('takes the album artist from config overrides', () => {
    const dir = '/m/Fabriclive 34 Krafty Kuts';
    const f = folder(dir, [file(dir, '01 - a.mp3'), file(dir, '02 - b.mp3'), file(dir, '03 - c.mp3')]);
    expect(planFolder(f, { overrides: { 'Krafty Kuts': 'Krafty Kuts' }, rename: { 'Fabriclive 34 Krafty Kuts': 'Fabriclive 34' } }))
      .toMatchObject({ album: 'Fabriclive 34', albumartist: 'Krafty Kuts', compilation: false });
  });
});

describe('planFiles', () => {
  it('fills title and artist from untagged "Artist - Album" folder names', () => {
    const dir = '/m/Fluke - Risotto';
    const f = folder(dir, [file(dir, '01 - Absurd.mp3'), file(dir, '02 - Atom Bomb.mp3'), file(dir, '03 - Kitten Moon.mp3')]);
    expect(f.class).toBe('untagged');
    const d = planFiles(f);
    expect(d.map((x) => x.decision)).toEqual(['match', 'match', 'match']);
    expect(d[1].after).toMatchObject({ album: 'Risotto', albumartist: 'Fluke', artist: 'Fluke', title: 'Atom Bomb', track: '2', compilation: '' });
    expect(d[1].changes).toEqual(['title', 'artist', 'album', 'albumartist', 'track']);
  });

  it('learns the word order from tagged siblings and leaves complete files alone', () => {
    const dir = '/m/Tibi mix';
    const f = folder(dir, [
      file(dir, '01 - Jamiroquai - Virtual Insanity.mp3', { artist: 'Jamiroquai', title: 'Virtual Insanity', album: 'Tibi mix', albumartist: 'Various Artists', compilation: '1', track: '1' }),
      file(dir, '02 - Moloko - Sing It Back.mp3', { artist: 'Moloko', title: 'Sing It Back', album: 'Tibi mix', albumartist: 'Various Artists', compilation: '1', track: '2' }),
      file(dir, '03 - Röyksopp - Eple.mp3'),
    ]);
    const d = planFiles(f);
    expect(d[0].decision).toBe('asis');
    expect(d[2].after).toMatchObject({ artist: 'Röyksopp', title: 'Eple', album: 'Tibi mix', albumartist: 'Various Artists', compilation: '1', track: '3' });
  });

  it('keeps tagged titles that differ from the filename only in case, and fills empty album artists', () => {
    const dir = '/m/Beatles/The Beatles 1';
    const f = folder(dir, [
      file(dir, '01-Love me do.mp3', { artist: 'Beatles', album: 'The Beatles 1', title: 'Love Me Do', track: '1' }),
      file(dir, '02-From me to you.mp3', { artist: 'Beatles', album: 'The Beatles 1', title: 'From Me To You', track: '2' }),
      file(dir, '03-She loves you.mp3', { artist: 'Beatles', album: 'The Beatles 1', title: '03-She loves you.mp3', track: '3' }),
    ]);
    const d = planFiles(f);
    expect(d[0].changes).toEqual(['albumartist']);
    expect(d[0].after?.title).toBe('Love Me Do');
    expect(d[2].after).toMatchObject({ title: 'She loves you', albumartist: 'Beatles' });
  });

  it('moves a disc number out of a tagged album name', () => {
    const dir = '/m/Beatles/Anthology 3/CD1';
    const f = folder(dir, [
      file(dir, '01-A beginning.mp3', { artist: 'Beatles', album: 'ANTHOLOGY 3 CD1', title: 'A Beginning' }),
      file(dir, '02-Happiness.mp3', { artist: 'Beatles', album: 'ANTHOLOGY 3 CD1', title: 'Happiness Is a Warm Gun' }),
      file(dir, '03-Helter.mp3', { artist: 'Beatles', album: 'ANTHOLOGY 3 CD1', title: 'Helter Skelter' }),
    ]);
    expect(planFiles(f)[0].after).toMatchObject({ album: 'ANTHOLOGY 3', disc: '1', track: '1', title: 'A Beginning' });
  });

  it('carries MusicBrainz ids through untouched', () => {
    const dir = '/m/Beatles/Love songs';
    const f = folder(dir, [
      file(dir, '01-Yesterday.mp3', { artist: 'Beatles', album: 'Love songs', title: 'Yesterday', mb_albumid: 'a1', mb_recordingid: 'r1' }),
      file(dir, '02-Girl.mp3', { artist: 'Beatles', album: 'Love songs', title: 'Girl', mb_albumid: 'a1', mb_recordingid: 'r2' }),
      file(dir, '03-Michelle.mp3', { artist: 'Beatles', album: 'Love songs', title: 'Michelle', mb_albumid: 'a1', mb_recordingid: 'r3' }),
    ]);
    const d = planFiles(f);
    expect(d[0].changes).toEqual(['albumartist', 'track']);
    expect(d[0].after).toMatchObject({ mb_albumid: 'a1', mb_recordingid: 'r1' });
  });

  it('numbers disc tracks from a 102- prefix', () => {
    const dir = '/m/Keeper Of The Flame/CD 1';
    const f = folder(dir, [file(dir, '101-A Night in Tunisia.mp3'), file(dir, '102-Ahora.mp3'), file(dir, '103-Yumbambe.mp3')]);
    const d = planFiles(f);
    expect(d[1].after).toMatchObject({ album: 'Keeper Of The Flame', disc: '1', track: '2', title: 'Ahora' });
  });
});

describe('plan', () => {
  it('never rewrites a mixed folder whole, whichever side of the dump threshold it is on', () => {
    const dir = '/m/Mixed library';
    const mixed = (n: number) => Array.from({ length: n }, (_, i) => file(dir, `${String(i + 1).padStart(3, '0')}.mp3`, { artist: `Artist ${i % 3}`, album: `Album ${i % 3}`, title: `Song ${i}` }));
    for (const n of [30, 90]) {
      const f = folder(dir, mixed(n));
      expect(f.class).toBe(n > 60 ? 'dump' : 'multi');
      const { decisions, skipped } = plan({ roots: ['/m'], scanned: '', folders: [f] });
      expect(decisions).toEqual([]);
      expect(skipped).toEqual([{ dir, why: expect.stringContaining('split it first') }]);
    }
  });
});
