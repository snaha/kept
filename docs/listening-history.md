# App-owned listening history

Music owns `music.sqlite` in Electron's userData directory (normally
`~/Library/Application Support/Kept/music.sqlite` on macOS). Navidrome's
library database remains separate. The database is
opened only by a worker thread; the renderer uses a restricted preload bridge.
Production history is not exposed through the LAN frontend server.

## What is stored

- `plays`: one confirmed playback start, with provider track ID, actual playback
  source ID/kind, timestamp, queue index and shuffle cursor. Repeated occurrences
  of the same song remain separate events.
- `history_contexts`: shared queue snapshots, actual selected album/playlist,
  ordering mode and shuffle permutation. Late pages can update the same context;
  deliberate queue edits start a new one. Replaying an event restores its queue
  and exact occurrence, rather than deriving a playlist from the song's album.
- `play_search`: FTS5 index of song, artist, album and selected source names.
  Queries treat input as literal word prefixes, support accent-insensitive
  matching, and return bounded pages (50 by default).
- `music_entities`: provider-qualified track and source metadata observed during
  playback. IDs are not assumed to identify the same recording across providers.
- `embeddings`: reserved storage for model-qualified float vectors and dimensions.
  No model, vector index, semantic search or embedding generation is enabled yet.
  That later step needs a model choice, metadata input, versioned embeddings,
  background backfill and a measured search/index implementation.
- `imports`: idempotent legacy-history migration markers.

History is partitioned by the desktop Navidrome user, with a stable scope that
survives local server port changes. It is an app listening journal for the local collection. The source-qualified
IDs preserve recording identity and selected album/playlist context.

## Persistence and recovery

Desktop history has no 100-event retention limit. Only requested pages are shown.
Existing browser-local history is imported on first use, without deleting the
original copy. Duplicate event IDs are ignored; import markers survive Clear
history so old records cannot be resurrected. Local signed artwork URLs and
embedded album objects are stripped before persistence; artwork is resolved
against the current local session on replay.

Writes are transactional and ordered. WAL permits durable incremental writes.
Accepted worker requests are drained before application shutdown. Failed writes
remain in the renderer's retry buffer, keep the visible history, and expose a
recoverable message. The buffer cannot survive a process crash while the disk is
unavailable. Browser/LAN clients without Electron's bridge retain the bounded
localStorage fallback; they do not write the desktop journal.

Clear history removes plays, search entries and queue contexts for the active
scope. Observed metadata and reserved embeddings are separate from listening
history and are retained.

## Validation

`pnpm --dir desktop test` exercises the actual SQLite worker and compiled Svelte
history module: restart persistence, more than 100 plays, source distinction,
duplicate positions, full-text search, paging, late queue pages, migration,
account/port changes, invalid-batch rollback, failed-write retry, stale reads and
clear/play races. Database tests also run under the bundled Electron Node runtime.

The synthetic browser fixture uses its own temporary SQLite worker/database.
Each page load gets a separate fixture scope; stopping the server deletes the
fixture database. No real library, credentials or playback are used.
