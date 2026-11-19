# A1b notes

The ledger, the read model and undo are in `library.sqlite` and in the fake, and both pass the same suite. `CatalogService` gained `commitChangeSet`, `undoChangeSet`, `undoField`, `getChangeSet`, `listChangeSets`, `listCatalogAlbums`, `getCatalogAlbum`, `searchCatalog`, `rebuildProjections` and `verifyProjections`.

Change sets:

- A change set (`ChangeSetInput`) is an ID chosen by its author, an author (`user`, `route` or `job`, a job naming the route it ran), a list of operations, evidence references, the change sets it depends on and the catalog version it was computed against. All operations apply in one transaction or none does.
- Operations: `set-field`, `lock-field`, `merge-albums`, `split-album`, `move-track` and `relink-provider`. A `set-field` on `trait.<name>` is a hand-set trait: it writes the user decision, and only the user may commit it. Any other field is an override that stands in front of the observations in `AlbumView.fields`. A merge also moves the provider's album IDs to the surviving anchor, so the next scan agrees. An anchor emptied by a merge or a split stays, for its links and for undo, and is no longer listed.
- Evidence names a registered source or a stored observation. The service reads the evidence class from it, so an author cannot claim one, and an automated author cannot cite user evidence. A user author is user evidence in itself. `validateCatalogChange` gives the verdict. A change that is not approvable is returned as `rejected` and not stored.
- The other rejections: `locked`, `suppressed`, `stale` and `dependency-not-applied`. A malformed request, an unknown subject or a second commit of the same ID with other content throws.
- **Lost acknowledgement.** Committing an ID that is already stored applies nothing and returns the stored change set with `replayed: true`, also after it was undone. The window names its own change set for each trait edit and sends it again once if the reply is lost.
- **Stale patch.** The catalog version moves each time a projected album changes, and each album remembers the version of its last change. An automated commit must carry `baseVersion`. It is rejected as `stale` when a subject it touches changed after that version, and applied with `rebased: true` when only other albums did. A scan that reads nothing new moves no version.
- States: `applied`, `undone`, `superseded` (every state it wrote was written again by later change sets; it becomes `applied` again when those are undone) and `suppressed`.

Undo:

- Each operation stores the state it replaced and the state it left. Undo puts the earlier state back and is recorded on the change set (`undos`: which operations, who, when, and `causedBy` when another undo took it along).
- A dependent is a later applied operation that wrote the same state, used an album this one created, or belongs to a change set that names this one in `dependsOn`. Undo reports `blocked` with the dependents, or undoes them first, newest first, with `cascade: true`.
- Undo works on a whole change set, on chosen operations of it (`operations`), or on a field (`undoField`: the newest applied operation that wrote it).
- An automated change set the user undoes is `suppressed`: the same operation from the same route is rejected from then on, including from a job of that route. A change set undone by a route, or taken along by a cascade, is only `undone`.
- An undo is refused as `changed-since` when the value was changed outside the ledger afterwards (a direct user decision, a scan that relinked an ID). Nothing is overwritten.
- An undone trait is written with the time of the undo, so a replayed migration, which is older, cannot bring the undone value back.
- `lock-field` is a user operation. A locked field rejects automated `set-field`. Locking `tracks` on an album rejects automated merges, splits and moves that touch it, and `links` rejects relinks. The user is not held by a lock, and lifts one by undoing it.

Projections, schema version 2 (one appended migration, with no dependency on its position):

| Table | Holds |
| --- | --- |
| `field_overrides`, `field_locks` | The fields set and locked by applied change sets |
| `change_sets`, `change_keys` | The ledger: one JSON body per change set, indexed by every state key it wrote or read |
| `change_suppressions` | Per route, the operations the user undid |
| `album_projection` | One row per anchor: title, artist, year, favourite, availability, traits with provenance, locks and the ordered tracks, with sort keys and the version of its last change |
| `search_rows`, `catalog_fts` | One FTS5 row per album and per track (title and artist, `unicode61` without diacritics) |
| `catalog_meta` | The catalog version and the projection format |

- Every mutation marks the albums it touched. They are projected again before the transaction commits, and a row is written only when it differs. `verifyProjections` compares the stored rows and search rows with a full rebuild; `rebuildProjections` rewrites them. A stored format other than `PROJECTION_FORMAT` is rebuilt on open.
- The projections can be rebuilt, but they stay in `library.sqlite`, not `features.sqlite`, because they must commit with the change that caused them.
- Titles come from tags: `ScanFile.tags` (title, artist, album, album artist, year, as Navidrome read them) are stored as observations of the folder source, and only when they differ from the last one. The album fields are the values most of its files agree on.
- Search: every word of the query must start a word of the title or the artist; case and accents are ignored. Results are in sort order, not ranked.

Measured on an Apple Silicon laptop. The real collection through `node desktop/scripts/catalog-e2e.mjs <folder>` (through the worker); the rest directly on the store with synthetic tags:

| Library | Tracks | Anchors | Full rebuild | Verify | List 500 | Search | Commit | Undo | Re-scan with nothing new |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Real collection | 951 | 56 | 33 to 64 ms | 41 to 55 ms | 2 to 3 ms | 3 to 5 ms | 8 to 14 ms | 7 ms | 144 to 233 ms in all, about 35 ms of it in the store |
| `test_library` | 149 | 69 | 11 ms | 12 ms | 1 ms | 2 ms | 1 ms | 1 ms | 32 ms |
| Synthetic | 20,000 | 1,177 | 0.8 s | 0.7 s | 8 ms | 10 ms | 4 ms | 2 ms | 0.7 to 0.8 s |

The other agents' work was running on the same machine, so the real-collection times vary by a factor of two.

Bridge and Activity:

- `window.musicCatalog.activity()` lists receipts and `undo({ id })` undoes one as the user, without cascade. `setTrait` now commits a user change set, so every hand-set trait has a receipt. After an undo the main process sends `catalog:changed`, so the tiles and the list refresh.
- Settings has an Activity tab when the bridge exists (`activity-panel.svelte` behind `activity.svelte.ts`). An undone entry shows at once, and is put back with a message if the library refuses. An entry a later change builds on has a disabled Undo and says why. Focus moves to the tab panel when the pressed button gives way to "Undone".

What later phases must know:

- **A2.** Both phases append to `MIGRATIONS`. This one's entry does not depend on its index. A job that commits must pass `author: { kind: 'job', id, route }` and the `baseVersion` it read.
- **A4.** Routes commit through `commitChangeSet` and should treat `stale` as "read again", `suppressed` and `locked` as final for that proposal. Scan conflicts are still returned by ingest and not stored. A merge does not renumber tracks. Nothing lifts a suppression yet: A3 needs a "let Kept try again" action.
- **A3.** `listCatalogAlbums` and `searchCatalog` replace paging `listAlbums`; the bridge's `albums()` still pages full album views and should move to the projection. The projection has no covers and no genre. Field receipts for anything but traits need a UI that commits them; the Activity wording for those operations is untested with real users.
- **One gesture, one receipt.** A slider tells the library its value on release, not while it moves (`saveMetadata(id, patch, { settled: false })` keeps the edit on the device only). Where several sends still arrive, as with arrow keys, the bridge passes `amends` when the same trait of the same album was edited within `TRAIT_COALESCE_MS` (3 s). The ledger then puts the new value into that change set, which keeps its ID and the value from before the gesture, provided it is a single user `set-field` on the same field, still applied, with nothing built on it. Otherwise the edit is committed on its own.
- **Favourites.** A `set-field` on `favorite` is the favourite decision, user only, with a receipt and an undo. Consent stays a plain user decision with no receipt: it is a setting.
- **Checked by eye.** The Activity tab and the trait sliders at 1920×1080, 1440×900, 1024×768 and 390×844 on the synthetic audit library, with a stand-in bridge in the page (screenshots and results in `.audit-results/a1b/`). "Undone" now takes exactly the box of the Undo button it replaces, so undoing moves and re-wraps nothing.
- **Not done.** A trait edit repeated from the old device migration is not a change set. The Activity tab was not checked in the Mac app, against a real library, or with physical touch. `catalog-e2e.mjs` needs `desktop/bin/navidrome`.
