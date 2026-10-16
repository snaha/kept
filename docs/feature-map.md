# Music feature map

Use this map to turn a change into an affected behavior table before judging
correctness from its tests. It is an index of user promises, implementation routes
and neighboring features, not a claim that every listed path is tested. The
[review runbook](application-review.md) defines evidence statuses; the
[coverage ledger](regression-coverage.md) owns maintained checks and known gaps.

Keep IDs stable as files move. Add or refine a behavior when its contract changes;
put incident results and dated passes in the ledger/review artifacts. Do not copy
the entire map into every review. Trace the changed feature and its callers and
consumers, then select relevant failure/overlap scenarios. Paths and evidence
describe this checkout; resolve them again on a different candidate.

## Feature index

The normal journey is library setup → browse/search → collection → playback.
Playback changes queue and history; history statistics feed discovery and browse.
Overlays, preferences, profiles and service lifecycle cross those journeys. A
shared helper change can affect several user actions along these connections.

| Feature ID | User actions and contract to expand | Implementation entry points | Neighbors to trace |
| --- | --- | --- | --- |
| `library` | Choose default/custom folders, scan and recover from an empty library; retain the usable catalog during background work | [library](../frontend/src/lib/library.svelte.ts), [Settings](../frontend/src/lib/Settings.svelte), [folders](../desktop/music-folders.js) | `startup`, `search`, `browse`, `collection` |
| `browse` | Change library mode, filters/sort and scroll; background updates preserve surviving order and the current view | [Grid](../frontend/src/lib/Grid.svelte), [browse ordering](../frontend/src/lib/browse-view.ts), [browse state](../frontend/src/lib/browse-view.svelte.ts) | `library`, `search`, `discovery`, `playback`, `display` |
| `search` | Search albums/artists/tracks/playlists, change query and load more; retain successful lanes on failure and reject obsolete responses | [catalog search](../frontend/src/lib/catalog-search.svelte.ts), [local provider](../frontend/src/lib/local-catalog.ts) | `library`, `collection`, `playback`, `overlays` |
| `collection` | Open details, Play or Add; browsing alone never starts playback and loaded details refresh after catalog changes | [details](../frontend/src/lib/CollectionDetails.svelte), [library actions](../frontend/src/lib/library.svelte.ts) | `search`, `library`, `playback`, `queue`, `overlays` |
| `playback` | Play/pause/seek/skip and choose playback order; newer transport intentions own audio and loading | [player](../frontend/src/lib/player.svelte.ts), [controller](../frontend/src/lib/playback-controller.ts), [bar](../frontend/src/lib/Bar.svelte) | `collection`, `queue`, `history`, `runtime`, `display` |
| `queue` | Add/reorder/remove/replay, including duplicates and shuffle; preserve current occurrence, history and row focus | [Queue](../frontend/src/lib/Queue.svelte), [player](../frontend/src/lib/player.svelte.ts), [domain identities](../shared/music.ts) | `playback`, `collection`, `history`, `overlays` |
| `history` | Open/search/load older/Retry/clear/replay; preserve explicit request intent and contiguous order across playback and failures | [history](../frontend/src/lib/listening-history.svelte.ts), [Queue](../frontend/src/lib/Queue.svelte), [store](../desktop/music-store.js) | `playback`, `queue`, `discovery`, `profiles`, `bridge`; detailed contracts below |
| `discovery` | Adjust Dig controls/presets/familiarity and warm artwork; preview pointer motion immediately, commit filtering at the intended moment | [discovery](../frontend/src/lib/discovery.svelte.ts), [DigPanel](../frontend/src/lib/DigPanel.svelte), [palette](../frontend/src/lib/artwork-palette.ts) | `browse`, `history`, `display`, `runtime` |
| `overlays` | Open/close artwork, details, menus, Settings and shortcuts; explicit intent and one focus owner, including nested native dialogs | [ArtworkView](../frontend/src/lib/ArtworkView.svelte), [focus](../frontend/src/lib/artwork-focus.ts), [Settings](../frontend/src/lib/Settings.svelte), [keyboard](../frontend/src/lib/keyboard.ts) | `browse`, `search`, `queue`, `preferences`, `playback` |
| `preferences` | Change Settings and retry saving; malformed/unavailable storage does not block the session | [preferences](../frontend/src/lib/preferences.ts), [save status](../frontend/src/lib/preferences-status.svelte.ts), [Settings](../frontend/src/lib/Settings.svelte) | `display`, `profiles`, `overlays`, `runtime` |
| `display` | Change component style, theme, layout/background and visualizer state; retain interactive controls, resource ownership and usable responsive layout | [UI style](../frontend/src/lib/ui-style.svelte.ts), [background](../frontend/src/lib/background.svelte.ts), [Visualizer](../frontend/src/lib/Visualizer.svelte), [Grid](../frontend/src/lib/Grid.svelte) | `preferences`, `overlays`, `browse`, `playback`, `runtime` |
| `profiles` | Fresh/copy/continue and portable data selection; isolate accounts/state, reject live copies and preserve source data | [profiles](../desktop/profiles.js), [profile UI](../frontend/src/lib/ProfileSettings.svelte), [migration](../desktop/storage-migration.js) | `startup`, `preferences`, `history`, `distribution` |
| `startup` | Launch while migration runs, recover after service failure and Retry; show a window promptly and release prior resources before replacement | [main](../desktop/main.js), [service lifecycle](../desktop/service-lifecycle.js), [migration](../desktop/storage-migration.js) | `profiles`, `library`, `history`, `bridge`, `runtime` |
| `runtime` | Mount/unmount/reload/quit; dispose subscriptions, timers, media and pending work without stale publication | [runtime](../frontend/src/lib/runtime.ts), [service lifecycle](../desktop/service-lifecycle.js) | All features with asynchronous work |
| `bridge` | Use desktop/history APIs across safe in-document navigation; retain trusted-frame checks and validate worker callers | [preload](../desktop/preload.js), [main](../desktop/main.js), [contracts](../shared/contracts.js), [worker](../desktop/music-store-worker.js) | `startup`, `history`, `profiles`, `library` |
| `distribution` | Launch installed/preview/portable versions and update them; retain profile isolation and package the required binaries/contracts | [desktop instructions](../desktop/README.md), [packaging scripts](../desktop/scripts), [CI](../.github/workflows) | `profiles`, `startup`, `bridge` |

## History behavior contracts

These are separate caller promises even though several use the same refresh lane.
Use the ID in review rows and new focused test names. `H` below links to the
maintained [history tests](../desktop/history.test.js), `S` to
[store tests](../desktop/music-store.test.js), and `A` to the
[synthetic journey](../frontend/tests/agent/run.mjs). A starting check is a route to
inspect, not a verified result for the current candidate.

| Behavior ID | Trigger and required outcome | Failure/overlap worth checking | Starting check / remaining boundary |
| --- | --- | --- | --- |
| `history.pagination` | Load older extends the current query with the next contiguous durable rows | Refresh/new entries change the head between page requests | H: paging/search and `history.play-during-pagination`; S: old plays/search. Compare IDs/order, not just row count |
| `history.retry-pagination` | Retry completes the failed older window without another Load older click | Failed read at 150 loaded rows; retry succeeds | H: `[history.retry-pagination]`, filtered and unfiltered. Retry is distinct from playback refresh |
| `history.play-during-pagination` | A play preserves an outstanding older-window request and its loading owner | Hold an older response, start a play, deliver obsolete response while newer refresh waits | H: `[history.play-during-pagination]`, including following-page continuity. No DOM scroll claim |
| `history.write-retry` | Record a play and retry failed persistence without losing or duplicating the original event | Write rejection, or successful commit followed by lost acknowledgement | H: existing write failure plus `[history.write-retry]`; S: idempotent writes/reopen |
| `history.search` | Search shows only matching plays; late reads cannot replace a newer query | Play during filtered/changing query, failed refresh, obsolete response | H: existing filtered insertion/search checks; A: history no-match/restoration. Extend with a controlled query race when changing that path |
| `history.clear-account` | Clear/account change prevents late data from repopulating the wrong view; a subsequent play survives | In-flight reads/writes, failed clear, account switch or port change | H: clear/account/port checks; add explicit deferred/failed-clear cases when affected |
| `history.replay` | Replay restores the recorded context and exact duplicate occurrence | Queue edits, shuffle state, unavailable saved source | [Player tests](../desktop/player.test.js), S. Audible continuity requires native playback |
| `history.view` | Open/refresh preserves the user's loaded view, focus and scroll unless they request a reset | Reconnect after an outage, background playback, tab close/reopen | A covers ordinary history/search. Long-history outage scroll/focus remains a browser gap |
| `history.stats` | Discovery counts follow the active account and durable events without duplicate retry counts | Account change, pending/failed write, clear/retry | H/S provide stats/storage boundaries; incremental/write-only redesign is deferred. Add discovery-effect ownership scenarios for that redesign |

Opening History currently switches tabs; same-account `loadHistory()` does not
refresh a stale list. A write-only redesign must introduce that read owner and
handle plays while History is already visible. It cannot assume the current open
handler provides it. Cost budgets, such as reads per play, belong
in separate performance assertions, not in the definition of Retry or view preservation.

## Starting evidence for the other features

- `library`, `browse`, `search`, `collection`, `discovery`: the
  [component suite](../frontend/src/lib/reliability.svelte.test.ts) has revision,
  loaded-page search, failed/superseded responses, browse order and Dig pointer
  cases; [folder tests](../desktop/music-folders.test.js) cover real filesystem roots.
- `playback`, `queue`: [player integration](../desktop/player.test.js),
  [controller tests](../frontend/tests/playback.test.ts) and component queue identity
  cases cover separate ownership boundaries. Fake audio cannot prove audible output.
- `overlays`, `preferences`, `display`, `runtime`: component cases and the
  [agent workflow](../frontend/tests/agent/README.md) cover DOM/lifecycle/journey
  behavior. Use inspected screenshots for visual claims and a phone for frame-rate claims.
- `startup`, `profiles`, `bridge`, `distribution`: [main](../desktop/main.test.js),
  [service](../desktop/service-lifecycle.test.js), [profile](../desktop/profiles.test.js),
  [contracts](../desktop/contracts.test.js), [portable](../desktop/portable-linux.test.js)
  and [signing](../desktop/sign-mac.test.js) tests establish their asserted boundaries.
  Use the runbook's isolated native checks for actual migration, installation and launch.

When a change exposes a missing contract, add that feature's detailed behavior rows
here and link the maintained check/gap in the ledger. Historical PR-only features,
future providers and embedding schema scaffolding are not delivered user journeys
in this map; check [integration boundaries](core-reliability.md) before changing scope.
