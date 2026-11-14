# Regression coverage ledger

Maintained coverage for the core-library fixes and PR #12 review. These are
assertions and remaining gaps, not a claim that every environment was exercised.
Use the [feature map](feature-map.md) to select affected behavior contracts.
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
| Recorded play collapses history pages or enters a nonmatching query; retry truncates history | [history.test.js](../desktop/history.test.js) loaded tail/window after record and failed write/retry, filtered insertion, account/port changes, stale reads/clear | Real SQLite/compiled frontend; visible scroll needs browser journey |
| `history.retry-pagination`: Retry abandons a failed older-window request | [history.test.js](../desktop/history.test.js) `[history.retry-pagination]` at 150 loaded rows, filtered/unfiltered, keeps visible IDs on failure then completes 200 rows in durable order | Real SQLite/compiled frontend; DOM scroll/focus remains separate |
| `history.play-during-pagination`: a new play cancels a user's pending older-window request | `[history.play-during-pagination]` holds the real older response, starts a play, delivers stale response while refresh waits; asserts loading ownership, requested window and following-page continuity | Real SQLite/compiled frontend; DOM scroll/focus remains separate |
| `history.write-retry` / harness ownership: lost write acknowledgement duplicates a play, or fault fixtures outlive a test | `[history.write-retry]` retries a committed write whose acknowledgement failed, without duplication; teardown case drains a held read, closes its worker and restores globals | Real SQLite/compiled frontend using [reusable controls](../desktop/tests/history-harness.mjs); no actual Electron IPC fault injection |
| Durable history loses duplicate position, repeats import or drops queued writes | [music-store.test.js](../desktop/music-store.test.js) search/old plays/duplicate context/idempotent import/reopen, worker serialization/close | Real SQLite/worker; browser-origin import still native |
| Side effects start at import or outlive unmount | Component `starts side effects once and disposes preference subscriptions and pending playback` | Runtime ownership; native quit/child exit separate |
| Malformed preferences/quota blocks playback or silently loses changes | Component `recovers malformed saved JSON and retries failed writes` | Simulated failures; native profile corruption is not automatically repaired |
| Fast scroll through a large library shows black tiles, or mounts the whole wall | Component `mounts a bounded window of a large library and warms covers through one deduplicated pool`: bounded mount, six-load pool reused across list refreshes, near tiles painted at once, nearest-first warm after a scroll, loads released on unmount | Stubbed `Image`; real cover latency, first-pass fill rate and phone fling need the desktop app |
| Scan buttons hand control back before a poll has seen the scan, drop focus when disabled, lose their state or failure reason when Settings closes, or let a second start through after an account change | Component `keeps the scan buttons owned by a pending start`: ownership through an idle poll that began before the start, across a Settings remount, released by the first later poll or a failed start; focus stays on the button. New-account-before-poll and late old-account failure cases cover ownership; external indexing clears an obsolete start error. The new-account guard was mutation-checked | Fake timers and stubbed scan API; a real Navidrome scan with the library refreshing mid-scan is a native check |
| Cover identity changes with session salt/port | Component `retains the cover fingerprint`: stable ID across salt/port, changed local ID/path and external URL invalidate | Identity assertions, not decode cost or real network request count |
| Dig drag reranks per move or commits foreign/stale pointer | Component `previews a Dig drag` (marker vs global state, keyboard); `owns one Dig pointer` (foreign pointer ignored, cancel commits, unmount discards) | Real component/rAF in Chromium; physical touch/measured 60 fps separate |
| Hot corner opens Queue and steals search focus | [agent/run.mjs](../frontend/tests/agent/run.mjs) corner-entry/active-input assertions | Required four-viewport journey in local validation and CI; explicit button/keyboard opening retained |
| An idle toolbar returns under the finger and steals an album Play tap | Component `keeps an idle album Play target uncovered through a touch tap/cancel`: actual App, target hit testing before release, one playback action, canceled gesture leaves queue alone; phone-size agent journey repeats touch events with real silent media | Both component cases fail on the premature pointer-down wake. Touch events are simulated in Chromium; user confirmed first-tap playback on physical iPhone/Safari on 14 November 2026; automated touch events still do not certify every native gesture |
| Artwork leaves library tabbable or fights nested focus | Component `isolates covered Grid containers` (new empty-library controls), `restores the artwork opener` (no scroll, competing focus, canceled mount), `restores playback focus` (removed/body opener), non-modal shortcuts leave library/details/Queue interactive; `real Settings modal` above actual Queue, Escape/restoration; agent search from details, per-Tab focus ownership, details → Queue → Escape fallback and visualizer shortcut above Queue | Chromium DOM; isolated Mac focus smoke exercised 15 October 2026, physical touch/performance remain separate |
| Broken artwork blanks view, changed URL never retries, late error affects closed view | Component Queue/album placeholder, changed URL retry, `ignores late artwork errors` | Real DOM with dispatched errors, not live image-server outage |
| Show in library destroys filters or a delayed jump steals the view after scrolling | Component `reveals the playing album from a matching search` checks visible destination/focus and restored query/Dig; `cancels a pending reveal` checks competing wheel input before the album response | Menu action and four-viewport navigation need the agent journey; no native Cmd-L claim |
| Album layout loses Favorites/direct Add or the bar cannot open a searched track outside Albums mode | Component `opens a searched track album outside the current library mode` covers replacing other details, fallback identity, Favorites and one-click Add while paused; existing title-scroll and bar/queue cases remain. `isolates the album under Share and Visualizer` covers inert, Escape ownership and menu-focus restoration; the empty bar opens Queue | Four-viewport visual review and native playback remain separate; no repeat control is claimed |
| Missing popover/checkVisibility breaks menus/focus | Component `native popovers are unavailable`, `settings focus checks without checkVisibility` | Missing capabilities simulated in Chromium; no full Safari/phone certification |
| Migration delays first window or failure bricks startup | [main.test.js](../desktop/main.test.js) success/failure barriers: visible bootstrap before pending import, warning/usable startup on failure | Actual main flow; OS windows/migration/child mocked, no paint timing claim |
| Migration hangs/leaks hidden window or marks failure complete | [service-lifecycle.test.js](../desktop/service-lifecycle.test.js) hang/rejection/protocol failure, bounded cleanup and successful retry | Actual control flow, fake storage renderer; native transfer/partial-import precedence in runbook |
| Retry leaks server/DB/child and changes share port | Main retry after child exit reuses real HTTP port, closes old DB and replaces history IPC owner; partial start/save failure cleanup | Real HTTP/credentials, mocked DB/child here; service tests cover real worker termination/listen collision |
| Share exports an admin account or reuses another server/account's password | [sharing.svelte.test.ts](../frontend/src/lib/sharing.svelte.test.ts): cached/fresh admin collision, restricted creation/update, rejected/malformed responses, server/base-path/account isolation, desktop profile-password ownership, cancellation and supersession | Real browser storage with mocked native API; isolated Navidrome 0.64.2 verification covers creation, cached update/login and admin collision |
| Home-network login, QR export or playback fails on HTTP | Sharing and [api-transport.svelte.test.ts](../frontend/src/lib/api-transport.svelte.test.ts): HTTP/HTTPS/Tailscale login, fragment/saved restoration, invalid URL rejection, profile ownership, QR notice and redirect refusal; main/service tests assert LAN binds; actual player test runs without randomUUID | HTTP exposure on trusted home networks explicitly accepted by the user on 14 November 2026, not remediated. Secure random bytes preserve credential/queue/history generation on HTTP. Physical-phone/audio checks remain separate |
| Malformed LAN requests terminate the desktop or escape the frontend directory | [main.test.js](../desktop/main.test.js): malformed percent/UTF-8/NUL/backslash input, encoded sibling traversal, missing-file recovery and successful SPA routes | Real HTTP sockets and temp files through the main entrypoint; Electron and backend process mocked. Packaged-app/phone smoke remains separate |
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
  Electron IPC or the complete app. CI and local app builds run the shared full validation gate, including the
  four-viewport application journey; screenshots still need inspection.
- The mac-only repository launcher now uses package metadata and a platform guard.
  Build/native launch checks suit this change; a negative source-string test would
  not establish that the bundle actually runs.

## Review workflow and history controls — 15 October 2026

Seven history cases pass, including both pagination contracts in filtered and
unfiltered history, lost-write-acknowledgement recovery and harness cleanup. The
four pagination cases fail at their intended outcome assertions against a history
module that reconciles a single page per play and drops the pending window.

Full desktop validation passes (29 desktop cases plus 7 frontend helper cases),
as do frontend typechecking, the frontend build and review-skill validation. The
build retains its existing large-chunk warning.

The feature map routes review scope to these stable behavior IDs. Review reports
must distinguish named scenario evidence from code-reviewed/untested promises and
record intentional behavior changes separately. No new UI/native/scroll, audible
output or performance result is claimed by this test-infrastructure change.

## Maintain the ledger

For a fix, update its row or add an error class. Strengthen existing behavioral
assertions before adding a duplicate suite or broad snapshot. If validation is
only practical natively, document steps, expected outcome and gap rather than
adding a mock that repeats implementation. Dated results need candidate head and
artifact paths. Pending native/audio/performance checks stay explicitly pending.

### Playing-album detour

- Core browser journey passes at 1920×1080, 1440×900, 1024×768 and 390×844 with the explicit Show in library action.
- Component coverage restores loaded search pages before refreshing, retains query/Dig settings, and cancels a delayed reveal on competing scroll intent. Keyboard scrolling and opening another album also cancel pending reveal. The wheel case publishes albums while loading remains pending and fails when wheel cancellation is removed.
- Album screenshots inspected at desktop/laptop and phone sizes: direct Favorites/Add controls and long titles remain visible. Tablet Settings and phone Neon controls also inspected. Full native audio, physical touch and phone frame pacing remain untested.

### Cover Flow

- Component checks bound mounted artwork for 1,000 albums, distinguish selecting from opening/playing, exercise End-key navigation, and retain the centered album when a refresh inserts an item before it.
- The four-size agent journey exercises Cover Flow navigation and returning to the grid's saved scroll position. Initial desktop and phone screenshots inspected; native touch momentum and physical-device 60 fps remain untested.

### Sleeve finish and integrated core journey

- The integrated journey passes at 1920×1080, 1440×900, 1024×768 and 390×844, including Cover Flow End/Home navigation, bounded covers, saved grid scroll, and gloss toggling across layouts without changing paused playback.
- Inspected gloss screenshots at desktop/tablet/phone sizes and the grid at laptop size. The highlight stays inside artwork; long titles, direct actions and the bottom playback bar remain readable. These are reviewed implementation artifacts, not replacement approved references.
- Physical touch, real-device frame pacing and audible-output checks remain separate release gaps.

### Standard build gate — 14 November 2026

- [Build validation](testing.md) defines one required command for local app builds
  and CI. Missing prerequisites and failed stages fail the build; a focused
  single-viewport run cannot count as a full pass.
- The existing four-viewport application journey now runs against the freshly
  built desktop frontend with its own ephemeral fixture and browser session.
  Logs, screenshots, source identity and pending manual checks accompany each run.
- [Real Navidrome sharing](../desktop/tests/sharing-integration.test.mjs) promotes
  the one-off check to maintained coverage: HTTP login, restricted user
  creation/cached update/login, protected administrator collision (including
  unchanged password), and no credential-bearing redirects, without randomUUID.
- [Fixture lifecycle cases](../frontend/tests/agent/server.test.mjs) check the
  selected build, readiness on a free loopback port and resource release on
  SIGTERM or parent disconnect. The production app and user profile are not used.
- Remaining boundaries: real phone QR/touch/audible playback, native chooser and
  packaged startup, external Tailscale routing, measured frame pacing and visual
  reference approval. Repeatable steps and expected results are in testing.md;
  an automated pass leaves these pending until actually exercised.

### Kept packaging and Mac verification — 14 November 2026

- `desktop/mac-distribution.test.js` covers stable/preview branding with unchanged bundle IDs, complete authentication methods, rejection of missing/partial credentials and stopping on signature, staple or Gatekeeper failures. The packaging entrypoint rejects missing credentials for stable releases; previews without credentials retain signature checks and explicit notices.
- Profile tests retain the original Music directories and existing data. The Linux portable test launches the renamed app through Open Kept and preserves its Data folder across updates.
- All Mac downloads require `codesign` success. Notarized builds additionally require `stapler` and `spctl` success before installer/portable packaging. Local development bundles remain ad-hoc and are explicitly excluded from distribution.
- Native gap: a signed/notarized download and quarantined Finder launch remain pending until Apple credentials are configured. Repeatable setup and expected results are in [desktop distribution](../desktop/README.md#macos). Existing unsigned Music Preview artifacts do not establish this result.
