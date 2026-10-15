# Regression coverage ledger

Maintained coverage for the core-library fixes and PR #12 review. These are
assertions and remaining gaps, not a claim that every environment was exercised.
See [the runbook](application-review.md) for check selection and native steps,
and [dated validation](core-validation.md) for earlier results.

## Automated behavior

Test names/behaviors are searchable anchors, avoiding drifting line numbers.
Component cases below live in
[`reliability.svelte.test.ts`](../frontend/src/lib/reliability.svelte.test.ts).

| Fixed error / protected invariant | Maintained check | Boundary / remaining check |
| --- | --- | --- |
| Settings is a long sidebar, dividers stop short, final actions are clipped | [agent/run.mjs](../frontend/tests/agent/run.mjs) centered modal/category keys, expanded divider width/no scrollbar shift, bottom action reachability, tab scroll reset, Escape/X and trigger focus | Geometry/interaction assertions; inspected screenshots still required for visual approval |
| Browsing starts music unintentionally, listening indicator misses actual playback, only half of bottom bar clicks | Agent cover-vs-play/listening assertions, full-width bar hit testing, large artwork/palette, Queue/history tabs and explicit open/close | Real media element with silent stream; actual audible output remains native |
| Search only filters album names instead of finding songs/artists/playlists | Agent catalog-search/type-filter/result Play/Add journey; component generation/page cases below | Synthetic catalog plus documented actual-folder native search/play; no live external provider claim |
| Fresh empty library gets only Reset filters; custom folder onboarding replaces default | Native Fresh/default-plus-custom/search/play checklist in [runbook](application-review.md) and dated [core-validation.md](core-validation.md); folder/profile/main suites below cover backend boundaries | First-launch chooser and empty-scan recovery need native/UI validation; the ready-state fixture does not prove them |
| Search refresh loses pages, deleted results persist, old/failing response replaces current data | Component `refreshes all previously loaded pages`, `reconciles unchanged-query refreshes`, `keeps the successful snapshot` | Synthetic responses; real scanner refresh in agent/native journey |
| Same-count edits leave details/search stale; background order drifts | Component `publishes a revision`, `refreshes open album details`, `keeps background ordering stable`, `reads the current browse source synchronously` | Agent journey asserts scroll/order; large-library performance needs measurement |
| Old Play/Add/random work changes a replacement queue or clears newer loading | Component `new play selection releases`, `both queued adds`, `delayed collection`, `canceling one operation`; [player.test.js](../desktop/player.test.js) cancels pending random via competing intentions | Controlled async responses/fake Audio; native decoding separate |
| Duplicate tracks share current indicator/DOM identity; shuffle edits lose previous/successor | Component `preserves a queue row and keyboard focus`; desktop player checks exact collection occurrences, replay, shuffle move/removal/previous/next/current successor | UI indicators/actions in agent journey; audible continuity native |
| Queued native media events undo newer pause/resume | Desktop player dispatches late play/pause events and asserts actual current state | Deterministic fake event order; application fixture uses real media elements |
| Recorded play collapses history pages or enters a nonmatching query; retry truncates history | [history.test.js](../desktop/history.test.js) one-page request counts at 50/150/350/450 loaded rows, fully loaded hasMore, ID merge/tail order, filtered write/read failure and retry, deferred competing plays/query changes/clear/account responses, account/port changes | Real SQLite/compiled frontend; visible scroll needs browser journey |
| One-page reconciliation retains a disconnected history tail and skips rows on pagination | [history.test.js](../desktop/history.test.js) next contiguous page after connected reconciliation and 60 plays during failed filtered reads; disconnected tail resets to one page before loading older rows | Real SQLite/compiled frontend; write-only playback and incremental stats remain a separate design follow-up |
| Durable history loses duplicate position, repeats import or drops queued writes | [music-store.test.js](../desktop/music-store.test.js) search/old plays/duplicate context/idempotent import/reopen, worker serialization/close | Real SQLite/worker; browser-origin import still native |
| Side effects start at import or outlive unmount | Component `starts side effects once and disposes preference subscriptions and pending playback` | Runtime ownership; native quit/child exit separate |
| Malformed preferences/quota blocks playback or silently loses changes | Component `recovers malformed saved JSON and retries failed writes` | Simulated failures; native profile corruption is not automatically repaired |
| Cover identity changes with session salt/port | Component `retains the cover fingerprint`: stable ID across salt/port, changed local ID/path and external URL invalidate | Identity assertions, not decode cost or real network request count |
| Dig drag reranks per move or commits foreign/stale pointer | Component `previews a Dig drag` (marker vs global state, keyboard); `owns one Dig pointer` (foreign pointer ignored, cancel commits, unmount discards) | Real component/rAF in Chromium; physical touch/measured 60 fps separate |
| Hot corner opens Queue and steals search focus | [agent/run.mjs](../frontend/tests/agent/run.mjs) corner-entry/active-input assertions | Manually run application journey, not CI; explicit button/keyboard opening retained |
| Artwork leaves library tabbable or fights nested focus | Component focus scope (inert, Tab wrap, playback controls); `restores nested artwork ownership` (new results); `real Settings modal` above actual Queue, Escape/restoration | Chromium DOM; complete app tab/scroll flow in agent journey |
| Broken artwork blanks view, changed URL never retries, late error affects closed view | Component Queue/album placeholder, changed URL retry, `ignores late artwork errors` | Real DOM with dispatched errors, not live image-server outage |
| Missing popover/checkVisibility breaks menus/focus | Component `native popovers are unavailable`, `settings focus checks without checkVisibility` | Missing capabilities simulated in Chromium; no full Safari/phone certification |
| Migration delays first window or failure bricks startup | [main.test.js](../desktop/main.test.js) success/failure barriers: visible bootstrap before pending import, warning/usable startup on failure | Actual main flow; OS windows/migration/child mocked, no paint timing claim |
| Migration hangs/leaks hidden window or marks failure complete | [service-lifecycle.test.js](../desktop/service-lifecycle.test.js) hang/rejection/protocol failure, bounded cleanup and successful retry | Actual control flow, fake storage renderer; native transfer/partial-import precedence in runbook |
| Retry leaks server/DB/child and changes share port | Main retry after child exit reuses real HTTP port, closes old DB and replaces history IPC owner; partial start/save failure cleanup | Real HTTP/credentials, mocked DB/child here; service tests cover real worker termination/listen collision |
| Worker survives graceful-close failure | Service `database cleanup terminates its worker` checks thread/pending work | Real worker with injected close rejection |
| IPC rejects safe query/hash or permits wrong document/subframe | Service trusted document URL cases; main invokes registered handler with safe navigation/wrong origin/different frame identity | URL helper and main wiring; mock Electron frames |
| History walks large snapshots twice or worker accepts malformed content | [contracts.test.js](../desktop/contracts.test.js) envelope/query bounds versus full rejection; main handler forwards contents to worker; store rejects invalid batches | Validation responsibilities asserted; no UI-thread latency benchmark |
| Custom folder replaces default or duplicate/link roots alter originals | [music-folders.test.js](../desktop/music-folders.test.js) legacy root, canonical/alias dedupe, stable combined root/original-file preservation | Real temp filesystem; native chooser/default+archive search/play documented |
| Fresh/preview/portable shares normal state or copies live profile | [profiles.test.js](../desktop/profiles.test.js) selection/Fresh isolation, live-lock rejection/stale reclaim, independent copy/cache-lock exclusion | Temp filesystem/current-process lock; concurrent Electron launch/full Chromium copy native |
| Linux portable update breaks launcher/data or mac server uses wrong entitlement | [portable-linux.test.js](../desktop/portable-linux.test.js) launcher/update; [sign-mac.test.js](../desktop/sign-mac.test.js) per-binary options | Fixture AppImages/signing options; packaged launch/Gatekeeper/notarization separate |
| Artwork colors make controls unreadable | [artwork-palette.test.ts](../frontend/tests/artwork-palette.test.ts) RGB contrast and neutral/transparent fallback | Mathematical contrast; final composition needs screenshot inspection |
| Removed exports, stale DTOs, compiler/package layout drift | `frontend check`, frontend/preload builds, shared contracts; desktop compiles via frontend-owned rune compiler export | Build/type evidence; no brittle source-text absence tests. Full portable smoke for packaging changes |

## Guidance and review decisions

- [AGENTS.md](../AGENTS.md) holds stable ownership, responsiveness, identity and
  focus rules. Detailed reproduction lives in the runbook, not one mandatory rule
  per incident.
- Generic provider interfaces and unsupported saved-source guards remain integration
  boundaries. Spotify-only transport fields and unused Side component were removed.
  Review consumers/branch ancestry before removing more.
- Embeddings/entity/schema scaffolding is intentionally retained. Scope/theme/
  toolchain/distribution choices are discussions, not runtime test failures.
  Review dense operations for readability without arbitrary size quotas.
- Agent fixture contract tests validate their own fixture/bridge, not actual
  Electron IPC or the complete app. CI runs unit, component and fixture-contract
  suites; the full agent journey is separately run and screenshots need inspection.
- The mac-only repository launcher now uses package metadata and a platform guard.
  Build/native launch checks suit this change; a negative source-string test would
  not establish that the bundle actually runs.

## Maintain the ledger

For a fix, update its row or add an error class. Strengthen existing behavioral
assertions before adding a duplicate suite or broad snapshot. If validation is
only practical natively, document steps, expected outcome and gap rather than
adding a mock that repeats implementation. Dated results need candidate head and
artifact paths. Pending native/audio/performance checks stay explicitly pending.
