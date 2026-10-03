# tagsmith

Index a music library and plan tag fixes as a dry run. Nothing here writes to audio files; a later `apply`
stage will be the only writer. Plan: `docs/tagging-library-plan.md`.

    pnpm install
    pnpm tagsmith inventory <folder> [more folders] [--work work]   # index recursively -> work/inventory.json
    pnpm tagsmith plan [--config rules.json] [--work work]          # rules over the inventory -> work/decisions.jsonl
    pnpm tagsmith stats [--work work] [-v]                          # what the decisions would change
    pnpm check && pnpm test

Runs on Node 22 without a build step; `pnpm check` type-checks and `pnpm test` runs vitest.

## Inventory

Every folder that holds audio becomes one entry with its files' tags, duration and embedded picture sizes, a
class, stats and findings. Classes: `album` (one owner), `disc` (a `CD n` folder of a set), `multi` (several
albums in one flat folder), `compilation` (no artist holds 60% of the files), `dump` (more than 60 files),
`singles` (one or two files), `untagged` (most files carry no album and no artist). Findings need no network:
a cover that would show on every album of a flat folder, zero-byte picture frames, image files that are not
images, BMP covers servers ignore, decomposed Unicode folder names, placeholder album tags, unreadable files.

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
- Flat multi-album folders and one-off singles are skipped and listed with `-v`.

`work/decisions.jsonl` holds one line per file: `before`, `after`, the changed fields and the reason. Files
already decided are skipped on the next run; delete the line to redo one.

`rules.json`:

    { "overrides": { "Fabriclive 34 Krafty Kuts": "Krafty Kuts" },
      "rename": { "BODYCNT": "Body Count" },
      "hold": ["Jazz-Swing Collection"] }
