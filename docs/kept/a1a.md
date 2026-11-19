# A1a notes

The identity spine is live: `library.sqlite` in the profile folder, owned by one worker thread (`desktop/catalog-store-worker.js`) behind `CatalogDatabase`, which exposes the `CatalogService` as `.service`. It opens with the profile, before the music server, and closes on quit. It passes `runCatalogContractSuite` unchanged (`desktop/catalog-store.test.js`).

Schema, version 1 (`PRAGMA user_version`; migrations are an append-only list in `desktop/catalog-store.js`, and a file from a newer version is refused, not altered):

| Table | Key | Holds |
| --- | --- | --- |
| `sources` | `id` | The registry: kind, label, evidence class, licence, `analysis_allowed`, network, consent key. `user` is inserted on open |
| `assets` | `id` = `asset:<sha256>:<payload bytes>` | Payload hash, payload size, duration |
| `locations` | `source_id, path` | Asset, availability (`available`, `unavailable`, `missing`), `seen_at`. Paths are relative to the folder |
| `albums` | `id` = `album:<uuid>` | Provisional anchors, in creation order |
| `album_tracks` | `asset_id` | The one anchor of an asset, with disc, track and path |
| `provider_links` | `source_id, kind, external_id` | Album and track links. Old Navidrome IDs stay linked after a re-ID |
| `observations` | `id`; unique per source, subject, field and time | JSON value, propagated evidence class and licence, `derived_from` |
| `user_decisions` | `kind, subject, trait` | Traits, favourites and consent, latest wins. Consent rows have subject kind `consent` |
| `file_hashes` | `source_id, path` | File size and modification time with the hash they gave. Can be rebuilt; it is only what lets a re-scan skip reading files |

Identity and ingest:

- `desktop/audio-payload.js` hashes the audio payload with SHA-256, reading in slices: mp3 (after ID3v2 and a Xing/Info/VBRI header frame, before APE and ID3v1), flac (frames after the metadata blocks), mp4/m4a (every `mdat` payload), wav (the `data` chunk). Any other container is hashed whole minus ID3 and APE tags, so tag edits in ogg, opus or aiff still change the asset. `size` in an asset and in `ScanFile` is the payload length, not the file's. ffmpeg rewrites the Info frame when it copies an mp3, which is why that frame is skipped.
- Sources: one `local-folder` source per music folder with the ID `folder-<16 hex>` (the same name as its symlink in the combined root), and `navidrome` as the provider. A source is registered once and never re-registered, so a later policy change survives a scan.
- `desktop/catalog-ingest.js` polls `getScanStatus` every 5 s. After each finished scan it lists every song with `search3`, resolves paths through `track-paths.js`, hashes new or changed files (size and modification time) one at a time on a worker that rests 2 ms per 4 MiB, and ingests whole albums in batches of 25, then one complete snapshot per folder. A server that has never scanned (`lastScan` in year 1) is not ingested.
- A folder that is missing, or present but empty where files were known, marks its locations `unavailable`. This also runs at launch, before the music server starts. Nothing is deleted.
- The window reaches the spine through `window.musicCatalog` (`catalog:*` IPC, trusted frame, validated by `validateCatalogBridgeRequest`). It names albums by Navidrome ID and the main process resolves the anchor through provider links. `catalog:changed` is sent after each ingested batch.
- Frontend: `discovery.svelte.ts` writes every trait and favourite edit to the device preference as before and to the spine, and shows what the spine holds for anchored albums, including estimated traits (`catalog.estimated`). The migration is replayed on each sync with the time of its first run (preference `<catalog key>:spine`), so it never overrides a later choice. It reads the old preferences and never rewrites or deletes them. Without the bridge, or when it fails, the preferences serve alone.
- Consent is the `online-lookups` user decision. `consent.svelte.ts` mirrors it into the old device preference; a choice the spine could not store is shown as not made. The consent step is mounted in Settings at "Add music folder" (`consent-dialog.svelte`).

Measured on an Apple Silicon laptop, internal SSD, with `node desktop/scripts/catalog-e2e.mjs <folder>` (bundled Navidrome 0.64.2 on a temporary data folder, the music folder only read):

| Library | Songs | Assets | Anchors | Navidrome scan | First ingest (hashing) | Re-scan ingest | Conflicts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Real collection | 958 | 951 | 56 | 3.6 s | 12.5 s (12.4 s) | 64 ms | 0 |
| `test_library` | 149 | 149 | 69 | 3.1 s | 0.9 s (0.8 s) | 12 ms | 0 |

A rebuilt Navidrome database changed all 958 song IDs. Every one of the 56 anchors kept its trait and favourite, with no file read again. Renaming every album ID as well gave the same result.

What later phases must know:

- **A2.** Hashing is not a job yet: it has no lease or checkpoint and does not pause for playback. It is one file at a time at a fixed duty cycle on a worker thread, which cannot be given a lower OS priority. An interrupted run keeps its hashes in `file_hashes`, so the next run resumes. Move it into the job system, and measure it against playback on real hardware.
- **A1b.** `albums()` on the bridge pages `listAlbums` with full album views on every sync. That is fine at hundreds of albums and wasteful at tens of thousands: the projections should replace it. `AlbumView.favorite` is a boolean, so "never decided" and "no" look the same; the frontend keeps a device "no" to override Navidrome's own star. Each service call is its own transaction, and a migration is one call per decision.
- **A4.** An asset has one anchor. The same audio in two albums is a `ScanConflict` for the second album, and the track stays in the first. A provider re-ID is recognised only inside one snapshot, and a snapshot is one folder: an album spread over two folders that is re-ID'd is reported as conflicts and keeps its old links. Conflicts are returned by ingest and not stored or shown yet.
- **B1.** Key features by `asset.id`. `AssetView.analysisAllowed` is false when any location's source forbids analysis. An asset can be `unavailable` or `missing`: check before decoding. The real file is the folder of the location's source joined with its path; the folder of a source is found by `folderSourceId(folder)`, since an ID is never a path.
- **Offline.** Navidrome itself looks artists up online (its log shows Deezer requests) whatever the consent says. Honouring "Stay offline" needs its external agents turned off (Navidrome's `Agents` setting), which is not done or verified here.
- **Not done.** The consent step is not shown in onboarding (`Startup.svelte`) or at the empty-library "add folder" action in the grid, and its look was not checked at the four audit viewports. The old preferences are not removed: that waits until the migration is verified on real profiles.
