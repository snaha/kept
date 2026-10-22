/** Stage 3: the no-network rules. For each folder decide album, album artist, disc, track, and fill empty titles
 *  and artists from the filenames. Writes nothing; returns decisions for the dry-run log. */
import { basename, dirname } from 'node:path';
import type { Folder, Inventory } from './inventory.ts';
import type { Decision } from './decisions.ts';
import { FIELDS, type Tags } from './tags.ts';
import { cleanName, discOf, isVarious, known, norm, trackPrefix, trailingDisc } from './text.ts';

export type RulesConfig = {
  /** folder path substring -> album artist, for folders only a person can name (a DJ mix, a ripper's handle as artist) */
  overrides?: Record<string, string>;
  /** album name -> album name, for folder names that are codes ('BODYCNT' -> 'Body Count') */
  rename?: Record<string, string>;
  /** folder path substrings to leave alone */
  hold?: string[];
};

/** The share of files one artist must hold to own the album; below it the folder is a compilation. */
export const OWNER_SHARE = 0.6;

type Counted = { name: string; count: number };

/** Most common value by comparison key, with the spelling that occurs most. */
function mostCommon(values: string[]): Counted | null {
  const byKey = new Map<string, Map<string, number>>();
  for (const v of values) {
    const k = norm(v);
    if (!k) continue;
    const spellings = byKey.get(k) ?? new Map<string, number>();
    spellings.set(v, (spellings.get(v) ?? 0) + 1);
    byKey.set(k, spellings);
  }
  let best: Counted | null = null;
  for (const spellings of byKey.values()) {
    const count = [...spellings.values()].reduce((a, b) => a + b, 0);
    if (!best || count > best.count) best = { name: [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0], count };
  }
  return best;
}

/** The album name and disc number a folder implies: 'Set/CD 2' -> Set, 2; 'Album CD1' -> Album, 1; else the cleaned name. */
export function albumOfFolder(dir: string, rename: Record<string, string> = {}): { album: string; disc: number | null } {
  const base = basename(dir);
  const parent = basename(dirname(dir));
  const disc = discOf(base);
  let out: { album: string; disc: number | null };
  if (disc !== null && parent) out = { album: cleanName(parent), disc };
  else {
    const t = trailingDisc(base);
    out = t ? { album: t.album, disc: t.disc } : { album: cleanName(base), disc: null };
  }
  out.album = rename[out.album] ?? out.album;
  return out;
}

/** Does the part before ' - ' in the filenames name the artist? Learned from the folder's tagged files. */
function artistFirst(folder: Folder): boolean {
  let af = 0;
  let tf = 0;
  for (const f of folder.files) {
    const { stem } = trackPrefix(basename(f.path));
    if (!stem.includes(' - ') || !known(f.tags.artist)) continue;
    const [a, b] = stem.split(' - ', 2);
    if (norm(a) === norm(f.tags.artist)) af++;
    else if (norm(b) === norm(f.tags.artist)) tf++;
  }
  return af >= tf;
}

/** 'jazz-blues-fusion -04- change your ways' -> 'change your ways' when the album is 'jazz-blues-fusion'. */
function trimAlbumPrefix(title: string, album: string): string {
  const t = norm(title);
  const a = norm(album);
  if (!a || !t.startsWith(a) || t.length <= a.length) return title;
  return title.slice(album.length).replace(/^[\s-]*\d{0,3}[\s\-–.]*/, '').trim();
}

type FolderPlan = { album: string; albumartist: string; compilation: boolean; disc: number | null; reason: string };

/** Decide the album-level values for one folder. */
export function planFolder(folder: Folder, config: RulesConfig = {}): FolderPlan {
  const { files, dir } = folder;
  const n = files.length;
  let { album, disc } = albumOfFolder(dir, config.rename);
  const reasons: string[] = [];

  // the files' own album tag wins when they agree on one, or when every file that names an album names this one
  // (the untagged bonus tracks join their siblings); the folder name is for the rest
  const albums = files.map((f) => f.tags.album).filter(known);
  const tagged = mostCommon(albums);
  if (tagged && (tagged.count / n >= OWNER_SHARE || tagged.count === albums.length)) {
    // 'ANTHOLOGY 3 CD1' in the tags of a disc folder is the set's name plus the disc, which has its own field
    const t = disc !== null ? trailingDisc(tagged.name) : null;
    album = t ? t.album : tagged.name;
    reasons.push(t ? 'album from tags, disc number moved to its field' : 'album from tags');
  } else reasons.push(disc ? 'album from parent folder' : 'album from folder name');

  const topArtist = mostCommon(files.map((f) => f.tags.artist).filter(known));
  const override = Object.entries(config.overrides ?? {}).find(([k]) => dir.includes(k))?.[1];
  const taggedOwner = mostCommon(files.map((f) => f.tags.albumartist).filter(known));
  let albumartist: string;
  if (override) {
    albumartist = override;
    reasons.push('album artist from config');
  } else if (taggedOwner && taggedOwner.count / n >= OWNER_SHARE) {
    // a DJ mix or a producer's compilation: someone already named the owner, and no share rule knows better
    albumartist = taggedOwner.name;
    reasons.push('album artist from tags');
  } else if (topArtist && topArtist.count / n >= OWNER_SHARE) {
    albumartist = topArtist.name;
    reasons.push(`${topArtist.name} holds ${Math.round((100 * topArtist.count) / n)}% of the files`);
  } else if (!topArtist) {
    // no artist tags at all: the artist the filenames agree on, else an 'Artist - Album' folder name
    const fromNames = mostCommon(files.map((f) => filenameParts(f, folder, '', album).artist).filter(Boolean));
    const base = cleanName(basename(dir));
    const [prefix, rest] = base.includes(' - ') && disc === null && !isVarious(base.split(' - ')[0]) ? base.split(/ - (.*)/s) : ['', ''];
    if (fromNames && fromNames.count / n >= OWNER_SHARE) {
      albumartist = fromNames.name;
      reasons.push('album artist from the filenames');
    } else if (prefix && /[a-z]/i.test(prefix)) {
      albumartist = prefix;
      if (!tagged) album = rest.trim() || album;
      reasons.push("'Artist - Album' folder name");
    } else {
      albumartist = 'Various Artists';
      reasons.push('no artist holds 60% of the files');
    }
  } else {
    albumartist = 'Various Artists';
    reasons.push(`no artist holds 60% of the files (top ${Math.round((100 * topArtist.count) / n)}%)`);
  }
  const compilation = isVarious(albumartist);
  if (compilation) albumartist = 'Various Artists';
  return { album, albumartist, compilation, disc, reason: reasons.join('; ') };
}

/** Title and artist a filename implies, given what the folder taught us about word order. */
function filenameParts(f: Folder['files'][number], folder: Folder, owner: string, album: string): { track: number | null; title: string; artist: string } {
  const { track, stem } = trackPrefix(basename(f.path));
  const parts = stem.split(' - ').map((s) => s.trim());
  const base = cleanName(basename(folder.dir));
  const prefix = base.includes(' - ') ? base.split(' - ')[0] : '';
  let artist = '';
  let title = stem;
  let tn = track;
  if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
    // 'Artist - NN - Title'
    [artist, title] = [parts[0], parts[parts.length - 1]];
    tn ??= Number(parts[1]);
  } else if (parts.length >= 3) {
    // 'Artist - Album - Title' when the folder is 'Artist - Album', else 'Guitarist - Band - Title'
    [artist, title] = prefix && norm(parts[0]) === norm(prefix) ? [parts[0], parts[parts.length - 1]] : [parts[1], parts[parts.length - 1]];
  } else if (parts.length === 2) {
    [artist, title] = artistFirst(folder) ? [parts[0], parts[1]] : [parts[1], parts[0]];
  } else {
    artist = owner;
  }
  title = trimAlbumPrefix(title, album);
  if (prefix && base.includes(' - ')) title = trimAlbumPrefix(title, base.split(/ - (.*)/s)[1] ?? '');
  title = title.replace(/\s*\((19|20)\d\d\)\s*$/, ''); // 'Walking On Sunshine (1985)'
  return { track: tn, title: title.trim(), artist: artist.trim() };
}

/** Decisions for every file of one folder. */
export function planFiles(folder: Folder, config: RulesConfig = {}): Decision[] {
  const fp = planFolder(folder, config);
  const owner = fp.compilation ? '' : fp.albumartist;
  // a file that names another album keeps it: the plan fills and tidies album names, it does not move files between albums
  const planned = norm(fp.album);
  const sameAlbum = (a: string) => [a, trailingDisc(a)?.album ?? '', config.rename?.[a] ?? ''].some((v) => norm(v) === planned);
  return folder.files.map((f) => {
    const before = f.tags;
    const album = known(before.album) && !sameAlbum(before.album) ? before.album : fp.album;
    const after: Tags = { ...before, album, albumartist: fp.albumartist, compilation: fp.compilation ? '1' : '' };
    if (fp.disc) after.disc = String(fp.disc);
    const parts = filenameParts(f, folder, owner, fp.album);
    let track = parts.track;
    if (track && fp.disc && track >= 100 && track < 1000) track %= 100; // '102-...' on disc 1 is track 2
    if (track && !before.track) after.track = String(track);
    // a title that is the file name with its extension is no title; one that merely equals the stem is kept as tagged
    const needTitle = !known(before.title) || norm(before.title) === norm(basename(f.path));
    if (needTitle && parts.title) after.title = parts.title;
    if (!known(before.artist) && parts.artist) after.artist = parts.artist;
    const changes = FIELDS.filter((k) => after[k] !== before[k] && (after[k] || k === 'compilation'));
    return {
      step: 'tag',
      path: f.path,
      decision: changes.length ? 'match' : 'asis',
      mode: 'album',
      source: 'rules',
      release: `${fp.albumartist} - ${fp.album}${fp.disc ? ` (disc ${fp.disc})` : ''}`,
      album_dir: folder.dir,
      before,
      after: changes.length ? after : null,
      changes,
      reason: fp.reason,
    };
  });
}

/** Rules over every folder the stage can decide: not flat multi-album folders, not one-off singles, not held ones. */
export function plan(inv: Inventory, config: RulesConfig = {}, decided = new Set<string>()): { decisions: Decision[]; skipped: { dir: string; why: string }[] } {
  const decisions: Decision[] = [];
  const skipped: { dir: string; why: string }[] = [];
  for (const folder of inv.folders) {
    const hold = config.hold?.find((h) => folder.dir.includes(h));
    if (hold) skipped.push({ dir: folder.dir, why: `held by config (${hold})` });
    else if (folder.class === 'multi') skipped.push({ dir: folder.dir, why: 'several albums in one folder; split it first' });
    // a dump is a flat folder past the album size, so its files are as likely several albums as one; it is never
    // rewritten whole. ponytail: group a dump by its tagged albums when there is a stage that can plan per album
    else if (folder.class === 'dump') skipped.push({ dir: folder.dir, why: 'too many files for one album; split it first' });
    else if (folder.class === 'singles') skipped.push({ dir: folder.dir, why: 'one or two files, not an album' });
    else if (folder.files.every((f) => decided.has(f.path))) skipped.push({ dir: folder.dir, why: 'already decided' });
    else decisions.push(...planFiles(folder, config).filter((d) => !decided.has(d.path)));
  }
  return { decisions, skipped };
}
