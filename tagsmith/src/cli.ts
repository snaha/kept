#!/usr/bin/env node
/** tagsmith: index a music library and plan tag fixes as a dry run; apply writes them to a copy of the library.
 *
 *    tagsmith inventory <dir...> [--work work]   index folders recursively -> work/inventory.json
 *    tagsmith plan [--work work] [--config rules.json]   rules over the inventory -> work/decisions.jsonl
 *    tagsmith stats [--work work]                what the decisions would change
 *    tagsmith enrich [--only musicbrainz,covers,lyrics,loudness] [--offline] [--work work]
 *                                                MusicBrainz, Cover Art Archive, LRCLIB, ffmpeg loudness -> work/enrich.json
 *    tagsmith categories [--offline] [--work work]   group the library, with enrich.json unless --offline -> work/categories.json
 *    tagsmith propose [--work work]             the tags apply would write, with their sources -> work/proposal.json
 *    tagsmith score <answer-key.json> [--work work] [-v]   check work/categories.json against a person's answer key
 *    tagsmith apply --to <dir> [--layout keep|organize] [--work work]
 *                                                write the proposal to a copy of the library in <dir>, read it back -> work/apply.json
 *
 *  apply is the one command that writes audio files, and only its own copies: <dir> must be outside the library.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inventory, type Inventory } from './inventory.ts';
import { appendDecisions, formatStats, readDecisions, stats } from './decisions.ts';
import { plan, type RulesConfig } from './rules.ts';
import { categorize, type Categories } from './categories.ts';
import { formatScore, score, type AnswerKey } from './score.ts';
import { enrich, findLyrics, STEP_FIELDS, STEPS, type Enrichment, type Step, type TrackMatch } from './enrich.ts';
import { apply } from './apply.ts';
import { LAYOUTS, type Layout } from './layout.ts';
import { fetcher } from './net.ts';
import { propose, type Proposal } from './proposal.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: 'string', default: 'work' },
    config: { type: 'string' },
    verbose: { type: 'boolean', short: 'v', default: false },
    only: { type: 'string' },
    offline: { type: 'boolean', default: false },
    to: { type: 'string' },
    layout: { type: 'string', default: 'keep' },
  },
});
const [cmd, ...args] = positionals;
const work = resolve(values.work);
const inventoryFile = join(work, 'inventory.json');
const decisionsFile = join(work, 'decisions.jsonl');
const categoriesFile = join(work, 'categories.json');
const enrichFile = join(work, 'enrich.json');

const loadEnrichment = async (): Promise<Enrichment | undefined> => {
  try {
    return JSON.parse(await readFile(enrichFile, 'utf8')) as Enrichment;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};

/** A counter on one line of a terminal; nothing in a log. */
const progress = (what: string) => (done: number, total: number) => {
  if (process.stderr.isTTY) process.stderr.write(`${what} ${done}/${total}   \r`);
};

const loadInventory = async (): Promise<Inventory> => JSON.parse(await readFile(inventoryFile, 'utf8')) as Inventory;

const commands: Record<string, () => Promise<void>> = {
  async inventory() {
    if (!args.length) throw new Error('inventory needs at least one folder');
    await mkdir(work, { recursive: true });
    const t0 = Date.now();
    const inv = await inventory(args.map((a) => resolve(a)), {
      onProgress: (done, dir) => {
        if (values.verbose) console.log(`${done} ${dir}`);
        else if (done % 50 === 0) process.stderr.write(`${done} folders\r`);
      },
    });
    await writeFile(inventoryFile, JSON.stringify(inv, null, 1));
    const byClass: Record<string, number> = {};
    for (const f of inv.folders) byClass[f.class] = (byClass[f.class] ?? 0) + 1;
    const files = inv.folders.reduce((n, f) => n + f.files.length, 0);
    console.log(`${inv.folders.length} folders, ${files} files in ${Math.round((Date.now() - t0) / 1000)}s -> ${inventoryFile}`);
    console.log(Object.entries(byClass).map(([c, n]) => `${c} ${n}`).join(', '));
    console.log(`${inv.folders.filter((f) => f.identified).length} folders already carry MusicBrainz release ids`);
    if (inv.unreadable.length) console.log(`\n${inv.unreadable.length} folders could not be listed:\n  ${inv.unreadable.join('\n  ')}`);
    const flagged = inv.folders.filter((f) => f.findings.length);
    if (flagged.length) {
      console.log(`\n${flagged.length} folders with findings:`);
      for (const f of flagged) console.log(`  ${f.dir}\n    ${f.findings.join('\n    ')}`);
    }
  },
  async plan() {
    const inv = await loadInventory();
    const config: RulesConfig = values.config ? (JSON.parse(await readFile(values.config, 'utf8')) as RulesConfig) : {};
    const decided = new Set((await readDecisions(decisionsFile)).map((d) => d.path));
    const { decisions, skipped } = plan(inv, config, decided);
    await appendDecisions(decisionsFile, decisions);
    console.log(`dry run: ${decisions.length} files decided, ${skipped.length} folders skipped -> ${decisionsFile}`);
    if (values.verbose) for (const s of skipped) console.log(`  skipped ${s.dir}: ${s.why}`);
    console.log(formatStats(stats(decisions)));
  },
  async stats() {
    const decisions = await readDecisions(decisionsFile);
    console.log(formatStats(stats(decisions)));
    if (values.verbose) {
      const byDir = new Map<string, number>();
      for (const d of decisions) if (d.changes.length) byDir.set(d.album_dir, (byDir.get(d.album_dir) ?? 0) + 1);
      for (const [dir, n] of [...byDir].sort()) console.log(`  ${n} files: ${dir}`);
    }
  },
  async enrich() {
    const steps = values.only ? (values.only.split(',') as Step[]) : STEPS;
    const unknown = steps.filter((s) => !STEPS.includes(s));
    if (unknown.length) throw new Error(`unknown steps: ${unknown.join(', ')}; known: ${STEPS.join(', ')}`);
    const net = fetcher(join(work, 'cache'), { offline: values.offline });
    const previous = await loadEnrichment();
    const t0 = Date.now();
    const failed: string[] = [];
    const found = await enrich(await loadInventory(), await readDecisions(decisionsFile), {
      net,
      steps,
      previous,
      onProgress: (step, done, total) => progress(step)(done, total),
      onError: (step, path, e) => failed.push(`${step} ${path}: ${(e as Error).message}`),
    });
    // a step that did not run keeps what the last run found for that step, and only that; enrich itself starts from
    // the last MusicBrainz answers when that step does not run
    if (previous) {
      const kept = STEPS.filter((s) => !steps.includes(s) && s !== 'musicbrainz').flatMap((s) => STEP_FIELDS[s]);
      for (const [k, v] of Object.entries(previous.tracks)) {
        const carry: TrackMatch = Object.fromEntries(Object.entries(v).filter(([f]) => kept.includes(f as keyof TrackMatch)));
        // a cover belongs to a release; one found for another release is not carried over
        if (carry.cover && v.release !== found.tracks[k]?.release) delete carry.cover;
        if (Object.keys(carry).length) found.tracks[k] = { ...found.tracks[k], ...carry };
      }
      if (steps.includes('musicbrainz') && !steps.includes('covers'))
        for (const [k, a] of Object.entries(found.albums)) if (previous.albums[k]?.release === a.release && previous.albums[k].cover) a.cover = previous.albums[k].cover;
      found.tracks = Object.fromEntries(Object.entries(found.tracks).sort(([a], [b]) => a.localeCompare(b)));
    }
    await writeFile(enrichFile, JSON.stringify(found, null, 1) + '\n');
    await mkdir(join(work, 'covers'), { recursive: true });
    const fronts = new Map<string, { title: string; url: string }>();
    for (const a of Object.values(found.albums)) if (a.cover) fronts.set(a.release, { title: a.title, url: a.cover });
    for (const m of Object.values(found.tracks)) if (m.release && m.cover) fronts.set(m.release, { title: m.album ?? m.release, url: m.cover });
    for (const [release, { title, url }] of fronts) {
      try {
        const bytes = await net.bytes(url);
        if (bytes) await writeFile(join(work, 'covers', `${release}.jpg`), bytes);
      } catch (e) {
        failed.push(`cover ${title}: ${(e as Error).message}`);
      }
    }
    const tracks = Object.values(found.tracks);
    const count = (f: (t: (typeof tracks)[number]) => boolean) => tracks.filter(f).length;
    console.log(`enriched in ${Math.round((Date.now() - t0) / 1000)}s, ${net.sent()} requests -> ${enrichFile}`);
    console.log(`albums matched ${Object.keys(found.albums).length}, covers ${Object.values(found.albums).filter((a) => a.cover).length}; recordings filed under a release ${Object.values(found.tracks).filter((m) => m.release).length}, with a cover ${Object.values(found.tracks).filter((m) => m.cover).length}`);
    if (failed.length) console.log(`${failed.length} lookups failed after retries; rerun to try them again:\n  ${failed.join('\n  ')}`);
    console.log(`tracks by album ${count((t) => t.via === 'album')}, by recording ${count((t) => t.via === 'recording')}, lyrics ${count((t) => t.lyrics === 'synced' || t.lyrics === 'plain')}, loudness ${count((t) => !!t.loudness)}`);
  },
  async categories() {
    const enrichment = values.offline ? undefined : await loadEnrichment();
    const c = categorize(await loadInventory(), await readDecisions(decisionsFile), enrichment);
    await writeFile(categoriesFile, JSON.stringify(c, null, 1) + '\n');
    const s = c.summary;
    console.log(`${s.tracks} tracks, ${s.albums} albums, ${s.artists} artists, ${Math.round(s.seconds / 3600)} h -> ${categoriesFile}`);
    console.log(`folders: ${c.folders.map((f) => `${f.path} ${f.kind}`).join(', ')}`);
    for (const name of ['genres', 'decades', 'lengths', 'versions', 'tagQuality', 'bitrates', 'sources', 'identified', 'lyrics', 'loudness'] as const)
      console.log(`${name}: ${c[name].map((g) => `${g.name} ${g.tracks.length}`).join(', ')}`);
    console.log(`songs in several versions: ${c.songs.map((g) => g.name).join(', ') || 'none'}`);
    for (const a of c.albums.filter((a) => a.issues.length)) console.log(`  ${a.albumartist} - ${a.name}: ${a.issues.join('; ')}`);
  },
  async propose() {
    const c = JSON.parse(await readFile(categoriesFile, 'utf8')) as Categories;
    const p = propose(await loadInventory(), c, await loadEnrichment());
    const file = join(work, 'proposal.json');
    await writeFile(file, JSON.stringify(p, null, 1) + '\n');
    const s = p.summary;
    console.log(`${s.changed} of ${s.files} files would get new tags, ${s.covers} a cover, ${s.lyrics} lyrics -> ${file}`);
    console.log(`fields: ${Object.entries(s.byField).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    console.log(`sources: ${Object.entries(s.bySource).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  },
  async apply() {
    if (!values.to) throw new Error('apply needs --to <dir>, a new folder outside the library for the copy');
    const layout = values.layout as Layout;
    if (!LAYOUTS.includes(layout)) throw new Error(`unknown layout ${layout}; known: ${LAYOUTS.join(', ')}`);
    const inv = await loadInventory();
    const c = JSON.parse(await readFile(categoriesFile, 'utf8')) as Categories;
    const proposal = JSON.parse(await readFile(join(work, 'proposal.json'), 'utf8')) as Proposal;
    const e = await loadEnrichment();
    // lyrics are asked for exactly as enrich asked, so the cache answers and apply sends nothing
    const net = fetcher(join(work, 'cache'), { offline: true });
    const view = new Map(categorize(inv, await readDecisions(decisionsFile)).tracks.map((t) => [t.path, t]));
    const lyrics = async (path: string) => {
      const t = view.get(path);
      const m = e?.tracks[path];
      return t ? (await findLyrics(net, m?.title ?? t.title, m?.artist ?? t.artist, m?.album ?? t.album, t.duration)).text : undefined;
    };
    const cover = (release: string) => readFile(join(work, 'covers', `${release}.jpg`)).catch(() => undefined);
    const t0 = Date.now();
    const done = await apply(inv, c, proposal, { to: values.to, layout, cover, lyrics, onProgress: progress('apply') });
    const file = join(work, 'apply.json');
    await writeFile(file, JSON.stringify(done, null, 1) + '\n');
    const s = done.summary;
    console.log(`copied ${s.files} files to ${done.to} (${layout}) in ${Math.round((Date.now() - t0) / 1000)}s -> ${file}`);
    console.log(`tagged ${s.tagged} with ${s.fields} fields, ${s.covers} covers and ${s.lyrics} lyrics embedded, ${s.folderCovers} cover.jpg, ${s.playlists} playlists`);
    const same = done.files.filter((f) => f.audio === 'same').length;
    console.log(`read back: ${s.mismatches} fields differ from the proposal, audio unchanged in ${same} of ${same + s.audioChanged}, ${s.errors} files failed`);
    for (const f of done.files.filter((f) => f.error || f.mismatches.length || f.audio === 'changed'))
      console.log(`  ${f.from}: ${f.error ?? (f.audio === 'changed' ? 'audio changed' : f.mismatches.map((m) => `${m.field} wanted '${m.want}' got '${m.got}'`).join('; '))}`);
    if (s.mismatches || s.errors || s.audioChanged) process.exitCode = 1;
  },
  async score() {
    if (!args[0]) throw new Error('score needs an answer key');
    const key = JSON.parse(await readFile(args[0], 'utf8')) as AnswerKey;
    const c = JSON.parse(await readFile(categoriesFile, 'utf8')) as Categories;
    console.log(formatScore(score(c, key), values.verbose));
  },
};

const run = commands[cmd ?? ''];
if (!run) {
  console.log('usage: tagsmith inventory <dir...> | plan [--config rules.json] | stats | enrich [--only steps] | categories | propose | score <key.json> | apply --to <dir> [--layout keep|organize]   [--work work] [--offline] [-v]');
  process.exit(cmd ? 1 : 0);
}
await run();
