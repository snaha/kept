# tagsmith

Index a music library and plan tag fixes as a dry run. Only `apply` writes audio files, and only to its own copy
of the library; everything before it reads. Plan: `docs/tagging-library-plan.md`.

    pnpm install
    pnpm tagsmith inventory <folder> [more folders] [--work work]   # index recursively -> work/inventory.json
    pnpm tagsmith plan [--config rules.json] [--work work]          # rules over the inventory -> work/decisions.jsonl
    pnpm tagsmith stats [--work work] [-v]                          # what the decisions would change
    pnpm check && pnpm test

Runs on Node 22 without a build step; `pnpm check` type-checks and `pnpm test` runs vitest.

## Inventory

Every folder that holds audio becomes one entry with its files' tags, duration and embedded picture sizes, a
class, stats and findings. The planned fields (title, artist, album, album artist, track, disc, year, genre,
compilation, and the MusicBrainz recording, release and release-group ids) are strings under `tags`; every
other tag music-metadata understood is kept under `extra`, and the file's raw frames by format under `raw`,
minus pictures and other binary values, so nothing is lost when a later stage learns to use them. A folder
whose files mostly carry a MusicBrainz release id is marked `identified`. Classes: `album` (one owner), `disc` (a `CD n` folder of a set), `multi` (several
albums in one flat folder), `compilation` (no artist holds 60% of the files), `dump` (more than 60 files),
`singles` (one or two files), `untagged` (most files carry no album and no artist). Findings need no network:
a cover that would show on every album of a flat folder, zero-byte picture frames, image files that are not
images, BMP covers servers ignore, decomposed Unicode folder names, placeholder album tags, unreadable files
and images. Dot entries (`._*` AppleDouble copies, `.Trashes`) are skipped, a folder that cannot be listed is
reported and the run goes on, and overlapping roots index a folder once.

## Plan

The no-network rules, per folder:

- The album is the tag the files agree on (60%), else the cleaned folder name; a `CD n` folder takes its
  parent's name and the disc number; a disc number at the end of a tagged album name moves to the disc field.
- The album artist is the config override, else the album artist the tags agree on, else the artist holding
  60% of the files, else the artist the filenames agree on, else the `Artist` of an `Artist - Album` folder,
  else Various Artists with the compilation flag.
- Track numbers come from the filename prefix where the tag is empty; `102-` on disc 1 is track 2.
- Empty titles and artists are filled from `NN Artist - Title` or `NN Title - Artist` filenames; the word
  order is learned from the folder's tagged files. A title that is the file name with its extension counts as
  empty. A trailing year in parentheses is dropped.
- Flat multi-album folders, dumps past the album size and one-off singles are skipped and listed with `-v`.
- A file that names another album keeps it; the rules fill and tidy album names, they never move a file between albums.

`work/decisions.jsonl` holds one line per file: `before`, `after`, the changed fields and the reason. Files
already decided are skipped on the next run; delete the line to redo one.

`rules.json`:

    { "overrides": { "Fabriclive 34 Krafty Kuts": "Krafty Kuts" },
      "rename": { "BODYCNT": "Body Count" },
      "hold": ["Jazz-Swing Collection"] }

## Categories

    pnpm tagsmith categories [--work work]          # inventory + decisions -> work/categories.json
    pnpm tagsmith score <answer-key.json> [-v]      # check categories.json against what a person knows

`categories.json` is what an app browses by: albums (with their issues: colliding or missing track numbers,
years that disagree, a name taken from the folder), artists with their roles (main, featured, remixer, dj),
genres, decades, lengths (`short` under 1:30, `song`, `extended` past 7 min, `mix` past 12), versions (remix,
acoustic, live, megamix…), songs present in more than one version, tag quality, bitrate and the sites or
uploaders a rip names. Paths are relative to the scanned root and every list is sorted, so the same library
gives the same file.

It adds two folder kinds the rules do not have: `dj-mix` (one DJ in the artist tag, `DJ - Performer - Title`
filenames) and `loose` (a folder named like a pile, or with three or more albums tagged and none holding it).
Loose tracks keep only an album tag that is a real album. Titles and artists are repaired where the filename
knows better, and every repair is listed under `evidence`: a title cut at ID3v1's 30 characters, a `Track 6`
placeholder, a title ending in `.mp3`, a ripper's watermark after the artist.

## Enrich

    pnpm tagsmith enrich [--only musicbrainz,covers,lyrics,loudness] [--offline]   # -> work/enrich.json

Looks the categories view up online, before fingerprints exist: MusicBrainz by name (an album folder by its
tracklist, everything else by recording, with fuzzy spelling and the file's length deciding between takes),
the Cover Art Archive front of every matched release, MusicBrainz genres (the album's release group, else the
main artist's), LRCLIB for whether synced or plain lyrics exist, and ffmpeg's EBU R128 meter for loudness and
the ReplayGain 2 gain. A recording must agree with the file on title, artists, length (20 s, 45 s on a matched
tracklist) and version words (remix, live, dub…); the year is the earliest take with the same credit, since
MusicBrainz keeps reissues as recordings of their own. Typographic quotes and hyphens are folded to ASCII. Requests are paced per host (MusicBrainz one a
second), retried on 503 and 429 and cached under `work/cache`, so a rerun is offline; `--offline` uses the
cache only. Covers land in `work/covers/<release>.jpg`. Nothing is written to the library; `categories` merges
`enrich.json` when it exists (`--offline` leaves it out) and lists every correction under `evidence`.

## Propose

    pnpm tagsmith propose [--work work]            # -> work/proposal.json

The tags an apply stage would write, per file, each with its source: `rules`, `filename`, `credits`,
`musicbrainz` or `loudness`. Field names are the ones Navidrome reads: `remixer` and `djmixer` roles,
`musicbrainz_*` ids, `replaygain_track_gain/peak` and the album gain from the duration-weighted album loudness.
A value equal to the disk is not proposed. An empty value clears a tag only where the categories rejected what is
there: an uploader's site as the album (`http://tunes4free.com`, `FREE MP3s`) or a placeholder genre
(`Other`). Every other tag nobody replaced stays. Covers to embed and lyrics to save are listed beside the tags,
for files that have none. Nothing is written.

## Apply

    pnpm tagsmith apply --to <dir> [--layout keep|organize] [--work work]   # -> work/apply.json

Writes the proposal to a copy of the library, never to the library: `<dir>` must be outside every scanned root,
and new, empty or an earlier apply copy (it holds `.tagsmith-apply`, and only such a folder is ever emptied).
Each audio file is cloned (free on APFS and btrfs) and only the clone is tagged, with node-taglib-sharp, a port
of the TagLib that Navidrome reads with: ID3v2.4 for MP3, whose ID3v1 tag is folded in and dropped. The cover
and LRCLIB lyrics are embedded (synced lyrics as LRC, which Navidrome serves as synced), album folders get a
`cover.jpg`, and `Playlists/` gets `.m3u8` lists from the categories, which Navidrome imports.

Every written file is read back and compared with the proposal, and its audio bytes (the MP3 between its tags)
with the original's; `apply.json` lists both per file and the command fails on any difference. `keep` keeps the
folders; `organize` files the copy as `Album artist/Album (year)/NN - Title`, with `Compilations/`, `DJ Mixes/`,
`Singles/` and `_Needs review/` for what has no title or artist.

    node scripts/navidrome-check.ts <music folder> [--navidrome path] [--out file.json]

Starts the app's Navidrome (`../desktop/bin/navidrome`, or `NAVIDROME`) on a folder with a throwaway data folder
and port, waits for the scan and prints what it shows: albums, artists, covers, years, genres, MusicBrainz ids,
ReplayGain, remixer and DJ-mixer roles, lyrics and playlists. Run it on the library and on a copy to compare.

## Test library

    pnpm test:library <library> [--online] [--update]

Runs inventory, plan, categories, propose, score and apply over a read-only clone of the library, checks that a
second run changes nothing, that the applied copy reads back as proposed with its audio unchanged and that the
whole pipeline over the copy proposes nothing more, compares the two in Navidrome when its binary is there, diffs
`categories.json` with the last snapshot and checks every file of the library against its manifest before and
after.

What the run records about a library names its files and tags, so it is kept out of git in
`fixtures/local/<library>/` (`TAGSMITH_FIXTURES` points elsewhere): `library.sha256`, the
snapshot `categories.json`, the resolved online answers `enrich.json`, which later runs replay offline, and an
optional `answer-key.json`, what a person knows about the library (see `AnswerKey` in `src/score.ts`). The first
run needs `--update` to record them; later, `--update` adopts a changed library or a deliberate change in the
output, and `--online` asks the services again.
