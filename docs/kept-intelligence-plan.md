# Kept intelligence plan

This plan adds a stable identity layer, local sound analysis and repair of the
library to Kept. It replaces the earlier research notes. Each phase lists what it
delivers and when it counts as done. Phases on different tracks can be built in
parallel when their dependencies are met.

## Decisions

| Area | Decision | Rejected alternative |
| --- | --- | --- |
| Order | Build stable identity first. Show intelligence early on Navidrome browse, before the virtual catalog replaces it | A catalog milestone with no models first; an AI-first build |
| Storage | `node:sqlite` in a worker, following `desktop/music-store.js`. User data that cannot be rebuilt goes in `library.sqlite`. Data that can be rebuilt goes in `features.sqlite` | PostgreSQL; one database |
| Evidence | Each source has a class: `deterministic`, `user` or `model`. Only deterministic and user evidence can approve a catalog change. Model output computes features and ranks results but never merges, splits or renames | No models anywhere; models allowed to decide |
| Licences | Each source records its licence. Derived data inherits the most restrictive licence of its inputs. The defaults that ship must be licensed for commercial use | Mixed licences with no record of them |
| Consent | Online lookups are off until the user agrees once, at the first library setup. The answer is stored as a user decision and can be changed in Settings. Offline mode is a tested mode | Online by default |
| Decoding | A bundled ffmpeg built with audio decoders only, under the LGPL. Symphonia compiled to WASM is the fallback | Decoding in Chromium; ffmpeg under the GPL |
| Inference | `onnxruntime-web` WASM on one thread, in an Electron `utilityProcess` at low priority | A native ONNX add-on |
| Features | Signal-processing features under permissive licences, plus OpenL3 embeddings (MIT code, CC BY 4.0 weights) | Essentia (AGPL code, CC BY-NC-SA models); MERT (CC BY-NC) |
| Mood | Hold the mood axis until B0 shows it can be learned from the user's own tags. Dig scoring uses only the axes an album has | Ship a mood model with a non-commercial licence |
| Tools | Typed deterministic tools in `shared/`. The UI calls them directly. An LLM is optional and uses the user's own key or a local model | An LLM required to use the features |
| Access | Keep Navidrome for scanning and streaming. A playback resolver separates catalog references from playback references | Replace Navidrome now |
| Spotify | Last. Playback only. Its source has `analysis_allowed = false` | Analyse Spotify audio or metadata |

Rules for external data: AcoustID is for non-commercial use, so fingerprinting is
opt-in with the user's own key. MusicBrainz core data is CC0, but its tags and
genres are CC BY-NC-SA. The MusicBrainz API allows 1 request per second. The Cover
Art Archive and LRCLIB state no licence, so treat their data as user-fetched
evidence with an unknown licence.

## Tracks and phases

Tracks: A catalog and identity, B sound intelligence, C tools and assistant,
D experience. Critical path: A0 → A1a → A2 → B1 → B2.

| Phase | Needs | Delivers | Done when |
| --- | --- | --- | --- |
| A0 Baseline, Tagsmith, path spike, contracts | — | A spike that maps Navidrome track IDs to real files: first `ND_SUBSONIC_DEFAULTREPORTREALPATH`, then a join on normalised relative paths. Tagsmith landed as a library with a compiled read-only entry. Frozen core DTOs, including the registry policy and consent fields. A fake catalog service with a shared contract test suite | Every test-library track resolves to its real file, including player records made before the flag. Tagsmith checks and tests run in CI. The contract suite passes on the fake service |
| B0 Offline sound spike | — | A script outside the app, run on a real collection: permissive signal-processing features plus OpenL3 on `onnxruntime-web` WASM. A mood-from-own-tags test and a blind 20-seed comparison of "unfamiliar albums like this one" | Sound-based lists beat same artist and genre lists, against a bar set before the run. Seconds per track and peak memory are recorded |
| C0 Tool contracts | — | Typed contracts in `shared/` for `search_catalog`, `find_similar`, `rank_tracks` and `build_queue`. Tools return occurrence IDs only | Reviewed with the A0 DTOs |
| D0 Design | — | Estimated traits shown next to hand-set ones in Dig and AlbumTraits. Scoring that uses only the axes an album has. The consent step at "add library", its Settings toggle, and the activity and undo surface | Designs checked at the four audit viewports |
| A1a Identity spine | A0 | `library.sqlite` with sources, assets, locations, provider links, provisional album anchors, the source registry, observations with licence propagation, and user decisions. Idempotent migration of Dig traits and favourites | A re-scan and a Navidrome re-ID keep every trait. An offline folder shows as unavailable, not deleted. Old preferences are kept until verified |
| A2 Jobs and library worker | A1a | Persistent jobs with leases, checkpoints and a resource policy that pauses for playback | Jobs survive a restart. The pause for playback is measured on real hardware |
| A1b Ledger, projections, undo | A1a | Change sets, dependencies, catalog and full-text projections, undo that respects dependencies | Commit, undo, restart, stale-patch and lost-acknowledgement tests pass on real SQLite |
| A3f Virtual provider UI on the fake | A0 | Separate catalog and playback references in the frontend, a virtual `CatalogProvider` against the fake service, history v2 read compatibility | Passes the shared contract suite. Old history still replays |
| B1 Analyser and feature store | A1a, A2, B0 | Bundled ffmpeg, the WASM inference host and `features.sqlite` keyed by asset, method and version. Refuses assets whose source has `analysis_allowed = false`. A third-party notices screen | A full-library analysis runs with no audible effect on playback. Provider assets are refused |
| A4 Reconstruction ladder | A1b, A2 | Route stages 0–6, one-to-one track assignment, versioned acceptance policies and a "not permitted by user" outcome | No false merges on the answer-key corpus. With lookups off, field repairs and local albums still work and a test fails on any outbound request |
| B2 Computed Dig and "more like this" | B1, D0 | Dig scores albums with estimated traits. A "More like this" action. Hand-set traits always win | Dig returns results on an untagged library. First visible release |
| C1 Deterministic tools | C0, B1 | Similar albums, ranking with novelty and familiarity, queue building | Every tool works with no LLM. Only real occurrence IDs are returned |
| A3 Virtual catalog and review UI | A3f, A1b, A4 | Browse, search and details on the virtual catalog. Activity receipts, comparison, field and operation undo, locks | Search, details and browse agree. Undo survives a restart |
| C2 Optional LLM front-end | C1 | A prompt bar that drives the same tools, with the user's own key or a local model | A test proves no audio, lyric text or file path is in any payload |
| E Spotify playback adapter | A3 | Playback only, with `analysis_allowed = false` | Spotify tracks play and are never analysed |
| L1 Authenticated LAN catalog | A3 | Phone control sees the same repaired library | Phones browse the virtual catalog with an authenticated session |

## Phase notes

Each finished phase keeps its notes in its own file. Read only the notes for the phases your work touches.

- [A0 findings](kept/a0.md)
- [D0 design](kept/d0.md)
- [Contracts](kept/contracts.md)
- [A3f notes](kept/a3f.md)
- [B0 findings](kept/b0.md)
- [A1a notes](kept/a1a.md)
- [A1b notes](kept/a1b.md)
- [A2 notes](kept/a2.md)
- [A3 notes](kept/a3.md)
- [C1 notes](kept/c1.md)
- [A4 notes](kept/a4.md)
- [C2 notes](kept/c2.md)
