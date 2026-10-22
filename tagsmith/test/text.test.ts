import { describe, expect, it } from 'vitest';
import { cleanName, discOf, norm, trackPrefix, trailingDisc } from '../src/text.ts';

describe('norm', () => {
  it('folds accents and punctuation', () => {
    expect(norm('Korai Öröm')).toBe('korai orom');
    expect(norm('Old Skoöl of Rock')).toBe('old skool of rock');
    expect(norm("Lock, Stock & Two Smoking Barrels")).toBe('lock stock two smoking barrels');
  });
  it('keeps letters and digits of every script', () => {
    expect(norm('正しいアルバム')).toBe('正しいアルバム');
    expect(norm('Кино — Группа крови (1988)')).toBe('кино группа крови 1988');
  });
  it('keeps marks that belong to non-Latin letters', () => {
    expect(norm('Йорк')).toBe('йорк');
    expect(norm('ガ')).toBe('ガ');
  });
  it('gives a name made of punctuation a key of its own', () => {
    expect(norm('!!!')).toBe('!!!');
    expect(norm('+/-')).toBe('+/-');
    expect(norm(' †††')).toBe('†††');
    expect(norm('!!!')).not.toBe(norm('+/-'));
  });
});

describe('cleanName', () => {
  it('strips uploader junk', () => {
    expect(cleanName('VA - City Lounge Paris')).toBe('City Lounge Paris');
    expect(cleanName('31 - Kat Around The Clock')).toBe('Kat Around The Clock');
    expect(cleanName('Fluke - Risotto [www.site.com] (320 kbps)')).toBe('Fluke - Risotto');
    expect(cleanName('Body_Count - ')).toBe('Body Count');
  });
});

describe('disc folders', () => {
  it('reads disc numbers', () => {
    expect(discOf('CD 2')).toBe(2);
    expect(discOf('Disc1')).toBe(1);
    expect(discOf('Abbey Road')).toBeNull();
    expect(trailingDisc('Keeper Of The Flame Disc 2')).toEqual({ album: 'Keeper Of The Flame', disc: 2 });
    expect(trailingDisc('Abbey Road')).toBeNull();
  });
});

describe('trackPrefix', () => {
  it('splits a numbered filename', () => {
    expect(trackPrefix('07 - Hands Up.mp3')).toEqual({ track: 7, stem: 'Hands Up' });
    expect(trackPrefix('(07) Hands_Up.flac')).toEqual({ track: 7, stem: 'Hands Up' });
    expect(trackPrefix('102-Ahora.mp3')).toEqual({ track: 102, stem: 'Ahora' });
    expect(trackPrefix('Chi mai.mp3')).toEqual({ track: null, stem: 'Chi mai' });
  });
});
