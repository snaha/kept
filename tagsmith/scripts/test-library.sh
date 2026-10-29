#!/usr/bin/env bash
# The whole dry run over a test library, end to end and repeatable:
#   1. the library matches its manifest, library.sha256, so the snapshot means something
#   2. inventory, plan and categories run over a read-only clone, never the library itself
#   3. a second plan decides nothing and a second categories run is byte-identical; the online answers
#      (MusicBrainz, Cover Art Archive, LRCLIB, loudness) are replayed from enrich.json
#   4. categories.json is scored against the answer key, when there is one, and diffed with the snapshot
#   5. apply writes the proposal to a copy (and to an organized copy): every field reads back as proposed and every
#      file's audio bytes are unchanged; inventory, plan, categories and propose over the copy propose nothing more
#   6. with Navidrome at hand (NAVIDROME, or the app's ../desktop/bin/navidrome), what it shows for the library and
#      for the copy, side by side
#   7. the library and the clone still match the manifest: nothing wrote to the library
#
#   scripts/test-library.sh [library] [--online] [--update]   (default library: ../test_library)
# --online asks the services again instead of replaying enrich.json (a few minutes: MusicBrainz allows one
# request a second). --update rewrites the manifest and the snapshots; review the diff before committing.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
update=false
online=false
lib="$here/../test_library"
for arg in "$@"; do
  case "$arg" in --update) update=true ;; --online) online=true ;; *) lib="$arg" ;; esac
done
lib="$(cd "$lib" && pwd)"
# what is known about a library (manifest, answer key, enrich answers, snapshot) names its files and tags, so it
# stays on this machine: fixtures/local/ is not committed. TAGSMITH_FIXTURES points elsewhere.
fixtures="${TAGSMITH_FIXTURES:-$here/fixtures/local/$(basename "$lib")}"
if [ ! -f "$fixtures/library.sha256" ] && ! $update; then
  echo "no fixtures for this library in $fixtures; run once with --update to record them"
  exit 1
fi
mkdir -p "$fixtures"
out="$(mktemp -d "${TMPDIR:-/tmp}/tagsmith-test-library.XXXXXX")"
clone="$out/library"
work="$out/work"
trap 'chmod -R u+w "$out" 2>/dev/null; rm -rf "$out"' EXIT

manifest() { (cd "$1" && find . -type f ! -name '.*' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256); }
tagsmith() { (cd "$here" && node src/cli.ts "$@" --work "$work"); }

echo "== library $lib"
manifest "$lib" > "$out/before.sha256"
if $update; then
  cp "$out/before.sha256" "$fixtures/library.sha256"
elif ! diff -q "$fixtures/library.sha256" "$out/before.sha256" > /dev/null; then
  echo "the library differs from $fixtures/library.sha256; the snapshot will not match (--update to adopt it)"
  diff "$fixtures/library.sha256" "$out/before.sha256" | head -20
  exit 1
fi

# an APFS clone (macOS) or a reflink (Linux) costs no space; read-only so a stray write fails loudly
cp -cR "$lib" "$clone" 2>/dev/null || cp -R --reflink=auto "$lib" "$clone"
chmod -R a-w "$clone"

echo "== inventory"
tagsmith inventory "$clone" | head -3
echo "== plan"
tagsmith plan
again="$(tagsmith plan | head -1)"
case "$again" in *"0 files decided"*) echo "rerun: $again" ;; *) echo "FAIL: a second plan decided files again: $again"; exit 1 ;; esac
if $online; then
  echo "== enrich (online)"
  tagsmith enrich
  if $update; then cp "$work/enrich.json" "$fixtures/enrich.json"; fi
elif [ -f "$fixtures/enrich.json" ]; then
  cp "$fixtures/enrich.json" "$work/enrich.json"
  echo "== enrich: replaying $fixtures/enrich.json"
fi
echo "== categories"
tagsmith categories
cp "$work/categories.json" "$out/first.json"
tagsmith categories > /dev/null
cmp -s "$out/first.json" "$work/categories.json" || { echo 'FAIL: categories.json differs between two runs'; exit 1; }
echo "== propose"
tagsmith propose
if [ -f "$fixtures/answer-key.json" ]; then
  echo "== score"
  tagsmith score "$fixtures/answer-key.json"
fi

echo "== apply"
tagsmith apply --to "$out/applied"
tagsmith apply --to "$out/organized" --layout organize | tail -1
echo "== fixed point: the pipeline over the copy"
copywork="$out/work-applied"
mkdir -p "$copywork"
cp "$work/enrich.json" "$copywork/" 2>/dev/null || true
retag() { (cd "$here" && node src/cli.ts "$@" --work "$copywork"); }
retag inventory "$out/applied" > /dev/null
retag plan > /dev/null
retag categories > /dev/null
left="$(retag propose | head -1)"
case "$left" in 0\ of\ *) echo "$left" ;; *) echo "FAIL: the applied copy still needs tags: $left"; exit 1 ;; esac

navidrome="${NAVIDROME:-$here/../desktop/bin/navidrome}"
if [ -x "$navidrome" ]; then
  echo "== navidrome: the library, then the copy"
  check() { (cd "$here" && node scripts/navidrome-check.ts "$1" --navidrome "$navidrome" --out "$2"); }
  check "$clone" "$out/navidrome.before.json"
  check "$out/applied" "$out/navidrome.after.json"
  node -e '
    const [b, a] = process.argv.slice(1).map((f) => require(f))
    for (const k of Object.keys(b)) if (typeof b[k] === "number" || k === "lyrics") console.log(`  ${k.padEnd(24)} ${JSON.stringify(b[k]).padEnd(26)} ${JSON.stringify(a[k])}`)
  ' "$out/navidrome.before.json" "$out/navidrome.after.json"
else
  echo "== navidrome: skipped, no binary at $navidrome"
fi

echo "== snapshot"
if $update; then
  cp "$work/categories.json" "$fixtures/categories.json"
  echo "updated $fixtures/categories.json"
elif diff -u "$fixtures/categories.json" "$work/categories.json" > "$out/snapshot.diff"; then
  echo "categories.json matches the snapshot"
else
  head -80 "$out/snapshot.diff"
  echo "FAIL: categories.json differs from the snapshot (--update to accept a deliberate change)"
  exit 1
fi

echo "== read only"
manifest "$lib" | cmp -s - "$out/before.sha256" || { echo 'FAIL: the library changed'; exit 1; }
manifest "$clone" | cmp -s - "$out/before.sha256" || { echo 'FAIL: the clone changed'; exit 1; }
echo "library and clone unchanged ($(wc -l < "$out/before.sha256" | tr -d ' ') files)"
