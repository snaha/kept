# Core candidate from PR #10

This branch isolates local music from the original connected-music PR #10.
The core candidate was validated locally before creating its replacement PR.
Original source: `2f0141f`; base: `3235c00` (`origin/main`).

## Split and decisions

| Core (`jose/core-library`, based on main) | Follow-up (`jose/spotify-integration-v2`, based on core) |
| --- | --- |
| Default/custom folder setup, recursive indexing, empty/error states | OAuth, account connect/disconnect and credential storage |
| Local catalog search, albums/playlists/artists, Dig, tags/favorites | Saved Spotify catalog indexing, source filtering and recovery |
| Local playback, queue/history, seek/volume/shuffle/random | Device/output control, mixed queues and provider handoffs |
| Shared artwork views, Settings and responsive controls | Spotify Settings and macOS audio capture/native bridge |
| Durable history worker, profile migration, preview/portable builds | Provider-specific unit tests and build configuration |

The shared interface and packaging stay in core because a first-time local user
needs a complete installable app. Core does not initialize a provider bridge,
fetch a Spotify catalog, ask for a playback device or advertise account setup.
The follow-up is stacked so it adds integration to the tested local foundation.
The original branch remains available for comparison. The core replacement is
published first; Spotify integration remains a separate stacked follow-up.

Audio files remain in place. Adding a folder includes it alongside the default;
canonical paths deduplicate nested directories and aliases. A combined symlink
root keeps scanner identifiers stable across updates. Profiles isolate the
scanner database, history and preferences; copied/existing data is an opt-in.

Local playback uses the serial controller so rapid skips cannot overlap audio.
History stores exact duplicate playlist occurrences and the listening context.
Unavailable or unsupported saved tracks leave the current queue intact.

## Automated validation — 2026-10-03

- Frontend check: **0 errors, 0 warnings**.
- Desktop suite: **8/8 passed**, including SQLite/history, actual compiled local
  player/library behavior, and directory canonicalization/root preservation and per-binary signing options.
- Frontend suite: **7/7 passed**, including rapid skips, outgoing pause failure,
  unsupported-source retention and artwork-palette contrast.
- Synthetic desktop bridge contract: **1/1 passed**.
- Desktop frontend/preload build: **passed**.
- Browser regression runner: **all four sizes passed** — 1920×1080, 1440×900,
  1024×768 and 390×844. Uses 240 local albums, a duplicate-entry playlist, real
  media elements and silent WAV streams. No real accounts or user files.
- Settings focus containment excludes hidden controls inside closed disclosures.
  Background-refresh assertions wait for the updated scanner/catalog revision.

Commands: `pnpm --dir frontend check`, `pnpm --dir desktop test`,
`pnpm --dir frontend audit:test`, `pnpm --dir desktop build:frontend`,
`pnpm --dir frontend audit:serve`, `pnpm --dir frontend audit:regressions`.
Local commands used Node 25.6.1: older installed Node builds lacked SQLite FTS5.
Use a Node runtime with `node:sqlite` and FTS5; the packaged app uses Electron's
bundled runtime, not the user's Node installation.

Browser evidence is in `.audit-results/2026-10-03T17-50-07-436Z/`. Selected
Settings, artwork/player, search and component-style captures were inspected at
all four sizes, including full-resolution phone Settings/player. No approved
references were replaced. This is a scoped visual inspection; a pixel comparison
of every screenshot against approved references remains pending.

## Native local-music journey

A new isolated `core-validation` profile used the native macOS folder chooser to
add the archive alongside the default Music folder. Both roots appeared on the
startup screen before Open my library. Indexing produced **1,106 songs across
124 albums**. A search for one track title returned two songs and two albums
spanning the two roots. The archive track streamed and decoded, and playback
advanced before pausing. Adding the other result produced a two-entry queue
without resuming playback; Recently played showed the successful play. Dig
opened with 124 albums and Random pick revealed an album without starting sound.

Screenshots: `.audit-results/core-native-onboarding.png`,
`core-native-playing.png`, `core-native-queue.png`, `core-native-history.png`,
`core-native-dig.png`. Original music and the normal app profile were preserved.

Native packaged restart/persistence and package results are recorded in the local
`.audit-results/core-split-REPORT.md` alongside final commit/build identifiers.
Physical speaker output, real phone touch and measured frame rate remain untested.
GitHub builds had not been triggered at the time of this October 3 validation.

## Try the core candidate before publishing

1. Extract the entire portable folder to a writable location and open
   **Open Music.command**. Keep the adjacent Data folder. It starts independently
   of normal Music and other preview builds.
2. On fresh startup, keep your default Music folder, add another folder containing
   MP3s, then choose **Open my library**. Albums should arrive while indexing.
3. Search a song from the added folder. Play it, pause/resume and seek. Confirm
   audible output yourself. Add a second result; this should extend the queue
   without resuming paused playback.
4. Clear search, browse an album by clicking its cover, then use its separate
   play button. Check the listening icon, queue, history and the bottom Menu.
5. Try Dig Random pick and your own album tags/favorites. Quit and reopen using
   the launcher; folder selections, history and saved preferences should remain.
6. Report any problem with the build identifier in **Settings → Advanced**,
   the action taken and the expected result. Validate the core candidate independently; Spotify integration follows in its
   separate stacked branch.


## Reliability review fixes and revalidation — 2026-10-04

The Svelte/Vite review fixes introduce explicit runtime ownership and teardown,
immutable catalog snapshots and revision invalidation, stable queue-entry IDs,
owned collection loading operations, authoritative search refreshes, guarded
preferences, shared desktop/history request contracts and a catalog provider
adapter. See `docs/core-reliability.md` for the integration boundaries.

- Frontend Svelte/TypeScript check: **0 errors, 0 warnings**.
- Vitest browser component/rune suite: **19 passed**, using the production Svelte
  Vite plugin; final run has no Svelte runtime warnings.
- Desktop contracts/storage/history/folder/player/packaging suite: **11 passed**.
- Existing frontend deterministic suite: **7 passed**.
- Synthetic desktop bridge contract: **1 passed**. Total: **38 tests passed**.
- Agent application regressions: passed at **1920×1080, 1440×900, 1024×768 and
  390×844**. Evidence: `.audit-results/2026-10-04T10-28-59-354Z/`.
- Scoped visual inspection: phone Settings/player, tablet expanded Settings/player,
  desktop Settings/search and native missing-artwork/history. No references replaced;
  complete comparison of every screenshot against approved references remains pending.
- Mac ARM64 portable packaging and native launch: passed for local build
  `0.5.0-preview.202610041229.829affc`, containing the tested uncommitted fixes.

The final package reopened an isolated profile with both default and Archive
folders. UI search found tracks from both roots. An archive track decoded and
playback advanced with the listening icon active. Recent history retained an
earlier play across restart and failed artwork displayed a square placeholder.
Pause/resume, keyboard seeking and adding a song without resuming playback were
also checked in the preceding local candidate. No browser JavaScript errors
were reported.

The native folder chooser automation was blocked in this latest pass; startup
used the desktop setup API with the same authorized paths. The native chooser
was exercised in the October 3 journey above. Physical speaker output, real phone
touch and measured frame rate remain untested. Linux packaging is covered by the
workflow and portable-launcher unit test, but was not rebuilt locally on this Mac.

## Regression safeguards — 2026-10-05

Candidate: `e752612` plus the tests, test configuration and review documentation
in this change. Application runtime code is unchanged in this safeguards pass.
See [the coverage ledger](regression-coverage.md) for each error class and gap,
[the runbook](application-review.md) for repeatable checks, and
[the repo review skill](../.agents/skills/review-music/SKILL.md) for future reviews.

- Svelte/TypeScript: **0 errors, 0 warnings**.
- Browser component/rune tests: **25 passed**, including a cold Vite cache run.
- Desktop tests: **23 passed**; frontend deterministic tests: **7 passed**.
- Synthetic bridge contract: **1 passed**. Total: **56 tests passed**.
- Desktop frontend and preload builds: **passed**. Existing Subsonic browser
  `node:crypto` externalization and large-chunk advisories remain.
- Two isolated main-entrypoint mutations were rejected by the intended assertions:
  moving the window after migration and omitting cleanup before startup retry.
  Temporary mutation copies were removed; logs are under
  `.audit-results/reliability-prevention/`.
- Skill schema validation and Markdown reference checks: **passed**. Svelte
  analysis of Dig/Queue/Settings found no issues; optional `bind:this` suggestions
  in Settings do not justify unrelated runtime changes in this pass.

The expanded suites run through the existing CI commands; no new test framework
was introduced. Historical CI for `e752612` completed checks, Mac/Linux packaging
and preview publication successfully (Actions run `37290051371`). That result
does not establish CI success for this newer safeguards commit.

Full application screenshots, native migration data, audible output, physical
touch and measured frame rate were not re-exercised in this test/documentation
pass. Main integration tests use real HTTP ports/files but mocked windows,
migration, child process and database; real worker/store checks remain separate.
