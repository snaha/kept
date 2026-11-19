# feat: add local library onboarding, discovery and playback

## Summary

Replace the core portion of PR #10 with a complete local music application on `jose/core-library`: default/custom folder onboarding, indexing, catalog discovery, local playback, queue/history and isolated preview builds. Spotify integration remains on `jose/spotify-integration-v2` as a separate stacked follow-up.

This includes the core split, the previous review fixes and the latest Svelte/Vite reliability work. The branch includes current `main` (`3235c00`).

## User-facing changes

### Start with your own files

- Fresh startup selects the available default Music folder. Add custom folders alongside it, remove unwanted selections, then choose **Open my library**. **Explore first** remains available.
- Folder selections persist per profile. Settings → Advanced → Library & profile exposes paths and Add, Replace and Remove actions.
- Index audio recursively in place, show progress and keep discovered content usable while the scanner runs. Empty-folder and scan-error states offer recovery.
- Show albums without artwork by default. Reset filters clears the artwork-only restriction. Failed artwork in album details and the queue uses an accessible square placeholder.

### Find and discover your collection

- Search local songs, albums, artists and playlists independently of the visible cover wall, with result-type selection and separate Play/Add actions.
- Keep successful results visible while refreshing. Remove deleted matches after a successful response, preserve surviving order, and retain loaded pages even when a refresh is interrupted.
- Browse albums/playlists, filter and sort explicitly, and use Dig, favorites and user-authored album traits.
- Background indexing refreshes content in place. A catalog revision invalidates open details and search even when the song count stays constant.

### Browse, play and revisit

- Clicking artwork opens album details. The separate play control starts, resumes or pauses a collection and displays loading/listening state.
- Album details and the expanded player share large complete artwork, cover-derived colors and track-list styling. Queue and Recently played are tabs within the expanded player.
- The full playback-bar background and bottom menu open/close the player; transport, volume and seeking retain their own actions.
- Preserve duplicate playlist occurrences, current playback context, queue order and row identity. Moving a duplicate queue entry retains its DOM and keyboard focus.
- Persist app-owned listening history and restore recorded queue/shuffle context when replaying a past session.
- Centered Settings, searchable selectors, component styles and responsive controls include keyboard focus, nested Escape and missing-browser-capability fallbacks.

## Key implementation decisions

### Multiple roots without moving audio

Canonicalize folder paths, deduplicate aliases/nested selections and reject overlap with profile data. Combined libraries use stable hashed symlinks inside the profile, with Navidrome explicitly following them. Keep the combined scanner root stable when selections change so identifiers do not churn. Source audio is neither copied nor removed by folder management.

### Explicit ownership of asynchronous work

Each collection load owns a loading token. A new play intention invalidates superseded play work; independent Add operations retain their own status. Add captures the queue session and account at the click, preventing delayed responses from appending to a replacement queue.

The serial playback controller sequences local audio actions. Random-load cancellation clears its pending state. Frozen collection membership and original occurrence positions distinguish duplicate tracks from the same recording's identity.

Search generations accumulate authoritative provider responses independently. Failed lanes keep their successful snapshots; obsolete generations cannot publish or clear newer loading state. Previously loaded offsets survive consecutive same-query refreshes.

### Svelte lifecycle and integration boundaries

- `runtime.ts` owns audio, subscriptions, scanning, preference synchronization and disposal, including Vite hot reload. Importing the player no longer creates audio elements.
- Catalog snapshots use immutable raw state with explicit revisions. Pure browse filtering/order helpers are separate from rendering; playback reads the current browse getter synchronously.
- `shared/music.ts` defines domain models. Shared desktop/profile/history DTOs and runtime validators cover IPC and direct database callers. History writes are versioned while legacy unversioned imports remain supported.
- `CatalogProvider<Client>` and the local Subsonic adapter separate transport data from catalog components. The Spotify follow-up should rebase onto this foundation and supply its provider/playback adapters.
- Guarded preference reads recover malformed saved data. Failed writes expose retry/dismiss controls instead of blocking playback.
- Explicit Vite browser targets are supplemented with runtime visibility/popover fallbacks. Late artwork errors after component teardown are ignored.

### Durable history and isolated builds

A worker-owned SQLite database keeps history separate from Navidrome and supports paged FTS lookup, ordered writes and legacy import. Browser/LAN clients retain a bounded local fallback; desktop history is not exposed through the LAN frontend.

Preview identity, profile locks, separate ports and Fresh/Copy existing/Continue choices isolate iterations. Portable launchers keep indexes, history and preferences in an adjacent **Data** folder, leaving audio in its original source folders. Linux portable updates retain a stable launcher target.

The Mac signing hook scopes Navidrome's executable-memory entitlement to the bundled server rather than all app binaries. Packages include shared runtime validators alongside app resources.

## Workflow and review scope

Actions gates packaging on frontend checks, desktop/deterministic tests, synthetic bridge tests and the new browser component/rune tests through the production Svelte Vite plugin. The application journey remains the existing agent-driven workflow.

PR builds produce standard and portable Mac/Linux artifacts. Same-repository PRs publish a `pr-<number>` preview download page after successful checks/builds; manual preview publishing and version-tag stable releases remain available. Shared contract changes trigger the workflow.

Provider OAuth/credentials, Spotify catalog sync, device/output controls, mixed-provider playback and native Spotify capture are excluded from this core PR. Unsupported saved sources cannot replace local playback.

## Validation

Local validation completed before publication:

| Check | Result |
| --- | --- |
| Svelte/TypeScript | 0 errors, 0 warnings |
| Vitest browser component/rune tests | 19 passed; no Svelte runtime warnings in final run |
| Desktop contracts/storage/history/folders/player/packaging tests | 11 passed |
| Existing frontend deterministic tests | 7 passed |
| Synthetic desktop bridge contract | 1 passed |
| Total deterministic/component tests | **38 passed** |
| Agent application regressions | Passed at 1920×1080, 1440×900, 1024×768 and 390×844 |
| Mac ARM64 portable package | Built and launched successfully |

The earlier native chooser journey combined default and Archive folders into **1,106 songs / 124 albums**. The latest portable package retained both roots across restart, found songs from both through UI search and decoded an archive track. Playback advanced with the listening icon active. Pause/resume, seeking, Add while paused, queue/history and missing-artwork fallback were exercised; history survived restart. The ready-to-test portable copy has a blank Data folder for fresh onboarding.

Latest chooser automation was blocked, so that pass configured authorized paths through the desktop startup API; the native chooser was exercised in the preceding journey. Selected Settings/search/player screenshots were inspected across the required sizes. Complete comparison of every screenshot against approved references remains pending; no references were replaced.

Physical speaker output, real phone touch and measured frame rate are untested. Linux packaging awaits this PR's CI run; it was not rebuilt on the local Mac. The local Mac preview is Apple Silicon, ad-hoc signed and not notarized. CI results will appear on this PR and are not represented as already passing.

## Suggested review order

1. `Startup.svelte`, `ProfileSettings.svelte`, `desktop/music-folders.js`, `desktop/profiles.js` — onboarding, roots and profile safety.
2. `library.svelte.ts`, `local-catalog.ts`, `catalog-search.svelte.ts`, `browse-view.*` — retrieval, refreshes and stable discovery.
3. `player.svelte.ts`, `playback-controller.ts`, `CollectionPlayback.svelte`, `Queue.svelte` — playback ownership and occurrence identity.
4. `runtime.ts`, `preferences.ts`, `shared/`, `music-store*`, `listening-history.svelte.ts` — lifecycle, persistence and contracts.
5. `reliability.svelte.test.ts`, `frontend/tests/agent/`, packaging scripts and `.github/workflows/desktop.yml` — regression evidence and distribution.

See [core validation](docs/core-validation.md), [reliability and integration boundaries](docs/core-reliability.md) and [listening history](docs/listening-history.md).
