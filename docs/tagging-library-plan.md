# Plan: a TypeScript library for tagging and album art

Draft for iteration. Drawn from two days of cleaning this library with the Python scripts in `tagging/` and the
session scratchpad: what recurred, what worked, what bit. The Python scripts stay as reference for the rules; the
library is TypeScript so the desktop app can run it and the UI can drive it.

## Goal

A TypeScript package, `tagsmith/`, next to `frontend/` and `desktop/`, that takes any music folder tree and
improves its tags and covers in reviewable, reversible batches. The Electron main process imports it and exposes
it over IPC; a thin CLI wraps the same functions for headless use. It never writes to audio without a plan that
was rendered for review first, and every network step is cached and resumable.

## Why not keep beets

beets did two things for us: fingerprint lookup and the album-level matcher. The lookup is three HTTP calls plus
the `fpcalc` binary. The matcher is a few hundred lines we write ourselves (see stage 2), simpler than beets'
because we only need the cases this library hit. Everything else was already our own code. Dropping Python means
no runtime to install for users and no sidecar process to babysit.

## Dependencies

| Need | Choice | Note |
|---|---|---|
| Read tags, durations, pictures | `music-metadata` | pure JS, every format we have (mp3, flac, m4a, ogg, wav, wma) |
| Write tags and embedded art | `taglib-wasm` | WASM TagLib, no native build step in Electron |
| Fingerprints | `fpcalc` from chromaprint | fetched by `scripts/fetch-fpcalc.mjs`, shipped as an extra resource like the Navidrome binary |
| AcoustID, MusicBrainz, Cover Art Archive, Discogs | `fetch` | one small client per service with pacing and a disk cache |
| BMP and odd image formats | `jimp` | pure JS; only for converting folder scans, skip if it hurts bundle size |
| Navidrome | Subsonic API over `fetch` | no SQLite driver; the `navidrome.db` reads from the scripts become API calls |
| Tests | vitest | already in `frontend/` |

No native modules. That keeps `electron-builder` and the three platforms simple.

## The six stages

Each stage is a function that reads and writes JSON state under a work directory, so the UI, the CLI and tests
share one code path.

### 1. Inventory (read only)

Walk the tree, read tags, group files into albums per folder, classify folders.

- Classes: proper album, multi-disc set (`CD 1`, `Disc 2`, `I rész`), flat folder holding several albums,
  compilation, dump (more than ~60 files, mixed albums), loose singles, untagged.
- Per-folder stats: file count, distinct album tags, distinct artists and the top artist's share, files
  without title or artist, filenames that start with a number.
- Findings that need no network: folder images that leak onto every album in a flat folder; the catch-all
  "Unknown Album"; embedded pictures of zero bytes; files named `.jpg` that are not images; BMP scans the
  server ignores; folder names in decomposed Unicode (compare by NFC).

### 2. Identify

- Run `fpcalc -json` per file, cache fingerprints by path, size and mtime.
- AcoustID lookup with `meta=recordings+releasegroups`, 3 requests per second, cached by fingerprint.
- Album mode for folders up to a size, singleton mode above it (dumps).
- The matcher: collect the releases the folder's recordings point at, fetch each candidate release from
  MusicBrainz with its tracklist, and score it as a distance in 0..1 from track count difference, missing and
  unmatched tracks, title distance, and duration difference per track. Accept under 0.15 by default, keep
  0.15..0.25 as near misses for a second look. A partial disc of a multi-disc set is accepted when the matched
  tracks fit one medium in order, which is the case beets refused until `max_rec` was lifted.
- Extras forced onto wrong slots (tracks not on the release) are detected by title mismatch and kept with
  their own titles, joining the album only.
- Output is `decisions.jsonl`, same shape as the current pipeline writes; `forget <folder>` drops a folder.

### 3. Rules (no network)

For what fingerprints miss, decide per folder from names:

- Album from the folder name, cleaned: strip `VA -`, bracketed junk, site tags, quality markers,
  leading numbers like `31 - `.
- A `CD n` / `Disc n` folder takes its parent's name and a disc number; `102-…` prefixes become track 2 on
  disc 1.
- Owner: the artist holding 60 percent of the files, else the artist the filenames agree on, else the
  `Artist` in an `Artist - Album` folder, else Various Artists with the compilation flag. A numeric prefix is
  not an artist.
- Titles and artists filled from filenames only where the tag is empty; the word order (`Artist - Title`
  or `Title - Artist`) is learned from the folder's tagged files; three-part names are
  `Artist - Album - Title` when the folder is `Artist - Album`, else `Guitarist - Band - Title`;
  `Artist - NN - Title` yields a track number.
- Titles that start with the album name and a number are trimmed.
- Fingerprint-derived titles win over filenames where they exist.
- Overrides and renames live in a JSON config, since every library has a few folders only a human can
  name (a ripper's handle in the artist tag, a band whose files carry no name).
- Bonus tracks left untagged in a folder whose siblings share one album join that album.

### 4. Covers

A source chain where every hit carries evidence, never a name-only match:

1. Images beside the album: `front*`, `portada`, `cover`, `Folder.jpg`, BMP converted to JPEG with jimp;
   backs, booklets and disc labels excluded by name. Prefer the box cover over a label logo.
2. Cover Art Archive by MusicBrainz release id when identified, else by artist and title search: release
   front, then release group front.
3. Discogs, with a token, 3 s between requests: free-text search for releases and masters, the artist's
   discography matched by title words or a year in the album name. Accept only when the tracklist shares
   titles (3, or half of a short album), or the durations line up (half the tracks within 4 s, in order), or,
   for untitled tracks, artist, title and track count agree.
4. iTunes never automatically. It gave Dirty Dancing for an AC/DC-era rock compilation.
5. Manual: a release URL or an image the user supplies, recorded with its source.

Comparison is accent-insensitive (NFKD, combining marks dropped). Every fetched image is cached under its
source id and shown for review before writing.

Writing policy: embed in every file; write `cover.jpg` only in folders that hold just that album, never in a
shared folder. Where a compilation has no cover, strip the random track sleeve rather than show it.

### 5. Review and apply

- A batch is a JSON file of proposed changes per album: tags, cover file, source, evidence, the first tracks
  as `filename → title`. The UI renders it as a page; the CLI renders the same JSON to static HTML.
  Strikes are ids in `skip.json`.
- Apply writes through one tag writer: tags and embedded art via taglib-wasm, with either file backups for
  small batches or a JSON undo log (previous tags per file) for large ones, plus `undo`.
- Batches checkpoint every ten items and resume; network errors mark the item for retry rather than as a
  miss. Paths are never passed through a shell.

### 6. Server adapter (Navidrome first)

- Start a scan over the Subsonic API; the file watcher usually beats it.
- Albums that only lost files are not refreshed; touch one remaining file to force it.
- Cover priority is `cover.*`, `folder.*`, `front.*`, then embedded; the served cover id does not change
  when the file content does, so clients cache stale images; a touched file or a changed path fixes it.
- Verify after every batch: fetch every album's cover, hash it, cluster albums by hash, report clusters of
  three or more, and report covers that are not images.

## Package shape

    tagsmith/
      package.json          "type": "module", tsc build, vitest
      src/
        inventory.ts        walk, classify, findings
        identify/
          fpcalc.ts         spawn, cache
          acoustid.ts       lookup client
          musicbrainz.ts    release client
          match.ts          the album matcher and distance
        rules.ts            folder-name cleaner, owner rule, filename parser, overrides
        art/
          folder.ts  caa.ts  discogs.ts  manual.ts
          judge.ts          tracklist, duration and track-count acceptance
        text.ts             norm(), clean(), NFC helpers
        tags.ts             read via music-metadata, write via taglib-wasm
        batch.ts            plan and cover batch types, checkpoint, resume
        apply.ts            backups, undo log, apply, undo
        servers/navidrome.ts
        cli.ts
      test/                 fixtures: a few tiny audio files, recorded API responses

    tagsmith inventory <root>            -> work/inventory.json, findings printed
    tagsmith identify [--threshold] [--retry-near-misses] [--forget <folder>]
    tagsmith plan                        -> work/plan.json (rules over everything undecided)
    tagsmith covers [--sources folder,caa,discogs]
    tagsmith review [plan|covers]        -> work/review.html
    tagsmith apply [plan|covers] [--backup files|log]
    tagsmith undo [<folder>...]
    tagsmith verify --server navidrome

State is plain JSON in `work/`, editable by hand; that paid off repeatedly.

## Desktop integration

- `desktop/main.js` imports `tagsmith` and registers IPC handlers for each stage; long stages report
  progress events to the renderer and run one at a time.
- `preload.cjs` exposes `tagsmith.run(stage, options)` and `tagsmith.on('progress', …)`; `desktop.d.ts`
  gets the types.
- The work directory is `app.getPath('userData')/tagsmith`; the Discogs token is stored next to the
  Navidrome credentials with the same 0600 care.
- The frontend gets a Library page under Settings: findings from inventory, a review list with thumbnails
  and strike buttons, Apply and Undo, and the verify report. Same JSON as the CLI sheet.
- `fpcalc` joins `extraResources` beside `navidrome`; `scripts/fetch-fpcalc.mjs` mirrors
  `fetch-navidrome.mjs`.

## Order of work

1. `text.ts`, `rules.ts`, `tags.ts`, undo log, with tests. Half a day.
2. Inventory and the Navidrome adapter, both read only. One day.
3. Covers: source chain, cache, judge, batch, review HTML. One day.
4. Identify: fpcalc, AcoustID, MusicBrainz, matcher. One and a half days. The matcher is the only part with
   real risk; test it against the folders `decisions.jsonl` already records.
5. Apply, undo, verify, CLI, README with the policies. Half a day.
6. Desktop IPC and the Library page. One day.

## Open questions

- Whether `plan` should propose renaming folders too; today it only writes tags.
- Duplicate handling: Zooropa and Greatest Hits II exist twice; a `dupes` stage from fingerprints is cheap
  once identify exists.
- The albums no source could cover are mostly personal mixes; a generated text tile per album is an option,
  declined this time in favour of hiding them behind the art filter.
- `taglib-wasm` versus `node-taglib-sharp`: both write pictures; pick after checking WMA and WAV support,
  since both formats exist in the library.
