import { describe, expect, it } from 'vitest';
import type { IAudioMetadata } from 'music-metadata';
import { fromMetadata } from '../src/tags.ts';

const meta = {
  format: { duration: 231.4 },
  common: {
    title: 'Hands Up', artist: 'Black Eyed Peas', album: 'Elephunk', track: { no: 1, of: 15 }, disk: { no: null, of: null },
    year: 2003, genre: ['Hip Hop', 'Pop'], compilation: false,
    musicbrainz_albumid: 'a1', musicbrainz_recordingid: 'r1', musicbrainz_releasegroupid: 'g1', musicbrainz_artistid: ['x1'],
    composer: ['will.i.am'], bpm: 97,
    picture: [{ format: 'image/jpeg', data: new Uint8Array(3) }, { format: 'image/jpeg', data: new Uint8Array(0) }],
  },
  native: {
    'ID3v2.3': [
      { id: 'TIT2', value: 'Hands Up' },
      { id: 'TXXX:ripper', value: { description: 'ripper', text: 'me' } },
      { id: 'APIC', value: { format: 'image/jpeg', data: new Uint8Array(3) } },
      { id: 'PRIV', value: new Uint8Array(2) },
    ],
  },
} as unknown as IAudioMetadata;

describe('fromMetadata', () => {
  const f = fromMetadata('/m/a.mp3', meta);
  it('re-decodes UTF-8 that a RIFF INFO chunk delivered as Latin-1, and only there', () => {
    const mojibake = Buffer.from('Café del Mar – 正しい', 'utf8').toString('latin1');
    const info = { ...meta, common: { ...meta.common, album: mojibake, albumartist: 'Ångström' }, native: { exif: [{ id: 'IPRD', value: mojibake }] } } as unknown as IAudioMetadata;
    expect(fromMetadata('/m/a.wav', info).tags).toMatchObject({ album: 'Café del Mar – 正しい', albumartist: 'Ångström' });
    const id3 = { ...meta, common: { ...meta.common, album: mojibake } } as unknown as IAudioMetadata;
    expect(fromMetadata('/m/a.mp3', id3).tags.album).toBe(mojibake);
  });
  it('maps the planned fields and the MusicBrainz ids', () => {
    expect(f.tags).toMatchObject({ title: 'Hands Up', track: '1', disc: '', year: '2003', genre: 'Hip Hop', compilation: '', mb_albumid: 'a1', mb_recordingid: 'r1', mb_releasegroupid: 'g1' });
    expect(f.duration).toBe(231);
    expect(f.pictures).toEqual([3, 0]);
  });
  it('keeps every other tag, but no binary values', () => {
    expect(f.extra).toEqual({ composer: ['will.i.am'], bpm: 97, musicbrainz_artistid: ['x1'] });
    expect(f.raw['ID3v2.3'].map((t) => t.id)).toEqual(['TIT2', 'TXXX:ripper']);
  });
});
