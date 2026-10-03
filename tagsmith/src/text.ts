/** Text helpers shared by every stage: accent folding, folder-name cleaning, filename parsing. Pure functions. */

/** NFKD with the Latin combining diacritics dropped: 'Öröm' -> 'Orom', so names compare the way people type them.
 * Only that block goes: the voiced marks of kana are letters' worth of meaning, not accents. */
export const fold = (s: string): string => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Comparison key: folded, lower case, runs of punctuation and space collapsed to one space. Letters and digits of
 * every script count, so a Japanese or Cyrillic name keeps its key instead of folding to nothing. */
export const norm = (s: string | null | undefined): string =>
  fold(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim().normalize('NFC');

/** Folder names on disk may be NFD (macOS); tags and lookups are NFC. */
export const nfc = (s: string): string => s.normalize('NFC');

const UNKNOWN = new Set(['', 'unknown', 'unknown artist', 'unknown album', '[unknown artist]', '[unknown album]', 'various', 'va']);

/** A tag value that carries information, as opposed to empty or a server's placeholder. */
export const known = (s: string | null | undefined): boolean => !!s && !UNKNOWN.has(s.trim().toLowerCase());

export const isVarious = (s: string | null | undefined): boolean =>
  /^(va|v\.a\.|various( artists?)?)$/i.test((s ?? '').trim());

/** A folder name without the junk uploaders add: 'VA - ', '31 - ', '[www.site.com]', '(320 kbps)', trailing dashes. */
export function cleanName(name: string): string {
  let s = name.replace(/_/g, ' ');
  s = s.replace(/^\s*(va|v\.a\.|various artists?)\s*[-–]\s*/i, '');
  s = s.replace(/^\s*\d{1,3}\s*[-–]\s*/, '');
  s = s.replace(/[[(][^\])]*(www\.|\.com|\.net|\bv0\b|lo-fi|mp3\+covers|\d{3}\s*kbps|\b(flac|mp3|320|192|128)\b)[^\])]*[\])]/gi, '');
  s = s.replace(/\s*-\s*(lo-fi|\d{3}\s*kbps)\s*$/i, '');
  s = s.replace(/\s*-\s*$/, '');
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '');
}

/** 'CD 2', 'Disc2', 'disk-3' -> 2, 3; anything else -> null. */
export function discOf(name: string): number | null {
  const m = /^(?:cd|disc|disk)\s*[-_ ]?\s*(\d+)\b/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** 'Album Name CD2' -> { album: 'Album Name', disc: 2 } for folders that carry the disc number at the end. */
export function trailingDisc(name: string): { album: string; disc: number } | null {
  const m = /^(.*?)\s*[-–]?\s*\b(?:cd|disc|disk)\s*(\d+)\b.*$/i.exec(name);
  return m && m[1] ? { album: cleanName(m[1]), disc: Number(m[2]) } : null;
}

/** '07 - Title.mp3', '(07) Title.flac', '07.Title.mp3' -> { track: 7, stem: 'Title' }; no number -> track null. */
export function trackPrefix(file: string): { track: number | null; stem: string } {
  const noExt = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = /^\s*\(?(\d{1,3})\)?[\s._)-]+(.*)$/.exec(noExt);
  if (m && m[2].trim()) return { track: Number(m[1]), stem: m[2].replace(/_/g, ' ').trim() };
  return { track: null, stem: noExt.replace(/_/g, ' ').trim() };
}

/** Audio extensions the inventory indexes. */
export const AUDIO = new Set(['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wma', 'wav', 'aac', 'aiff', 'ape', 'wv']);
export const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);

export const ext = (file: string): string => file.toLowerCase().replace(/^.*\./, '');
