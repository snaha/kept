# Agent-driven Music regressions

Use Codex computer/browser controls or the installed `agent-browser` CLI. There
is no Playwright test dependency or Cypress dependency in this workflow. The CLI
may use browser-automation libraries internally; this project does not maintain
Playwright specs.

## Start the isolated fixture

```sh
pnpm --dir frontend audit:serve
```

Opens a loopback server at http://127.0.0.1:4178 after building the frontend.
Contains 240 synthetic library albums, Liked Songs, a restricted playlist, and
Night flights: twelve tracks from six distinct album identities over three pages.
The six artwork-study covers are explicitly synthetic inline SVGs. Long titles
and multiple discs are also included. Local API and Spotify playback are mocked. The synthetic desktop bridge reports a
ready profile through the current startup API; it does not open or modify real profiles. Listening history uses an isolated temporary
SQLite database, deleted when the fixture server stops. No real library, tokens or audio are used.
The history fixture requires SQLite FTS5. If the shell Node lacks it, use
`fnm exec --using 22.21.0 pnpm --dir frontend audit:serve`.
Reload resets the fixture's browser preferences. Keep the fixture separate from
the actual app, whose settings and playback are real.

## Repeatable agent-browser assertions

With `agent-browser` installed and its browser available:

```sh
pnpm --dir frontend audit:regressions
```

If a browser executable is already installed, set
`AGENT_BROWSER_EXECUTABLE_PATH` to its full path. Otherwise run
`agent-browser install` using your installed CLI's documented setup. The CLI
must support `set viewport`, `hover`, `focus`, `eval`, `snapshot` and `screenshot`.
Set `MUSIC_AGENT_BROWSER` to use another CLI executable location.

Runs at 1920×1080, 1440×900, 1024×768 and 390×844. Checks hover/focus and overlay
hit testing, cover play, dropdown opening/no-match/Escape/selection/reset,
Settings modal centering, focus containment, category keys, device-picker search,
keyboard selection and nested Escape, click-only menus and keyboard dismissal, track-detail
overflow, and scroll/tile-order preservation during background updates.

Writes timestamped screenshots, results.json, and failure screenshots/snapshots
to `.audit-results/`. Exits nonzero on a failed assertion. Uses the isolated
`music-regressions` browser session and closes it afterward.

**Screenshot capture is not a visual pass.** Codex or a human must inspect them,
compare with approved references, and record visual results. Agent judgment is
useful for UX review but cannot guarantee the same decisions across runs.

## Full Codex audit

Give Codex the prompt in `AUDIT-PROMPT.md`. It includes additional exploratory
checks, all three styles, sliders, resize-open panels and the actual Mac app.
Codex can use its built-in computer controls without agent-browser installed.
The existing `pnpm --dir desktop test` remains the deterministic playback/library
regression suite. Physical phone, live Spotify and capture behavior need their
separate release checks in `frontend/UX-AUDIT.md`.

Only replace approved screenshots after reviewing an intentional design change.
Never treat a new screenshot as approved solely because the runner completed.

## Latest validation

2026-09-30: the agent-browser runner passed all four viewport sizes using the
installed CLI and Chrome for Testing. Screenshots and results are saved under
`.audit-results/2026-09-30T16-14-42-955Z/`. Automated assertions passed; full visual
approval of every screenshot remains a separate review. This is intentionally
recorded as pending in results.json.

Official agent-browser command reference: https://agent-browser.dev/commands

## Chronocity artwork flight

With the fixture running:

```sh
pnpm --dir frontend audit:chronocity
```

This uses the isolated `music-chronocity` browser session and closes it afterward.
`MUSIC_AUDIT_SESSION` overrides the session, `MUSIC_AUDIT_URL` overrides the fixture
URL, and `MUSIC_AUDIT_PORT` overrides the default 4178 port. Browser executable and
CLI configuration use the same variables described above.

At all four viewport sizes the runner checks a real 3D canvas, XYZ camera movement,
turning and held keys without playback shortcuts, original artwork by default,
optional foil, release-year/Undated navigation, metadata refresh continuity,
shared play/pause and queue, details and cover-wall scroll preservation. Playlist
checks cover incremental album-identity grouping, leaving during an outstanding
request, automatic proximity expansion, individual album details, motion pause,
collection collapse and restricted-playlist error reporting. Cinematic checks
cover opt-in state,
start/arc camera movement, immediate manual/Escape takeover and a stable stopped
pose; the 1440×900 pass also checks neighbor advance and overlay time suspension.
The tail checks tour-driven playlist entry, reduced-motion preference changes
and manual Approach, then forced WebGL2 rendering and a cinematic shot.
Additional 1440×900 captures show
outer artwork slots 20/21, the former environment snap boundary near z = −85 and
the section-streaming boundary near z = −170. Inspect these before/after images
for artwork/approach clearance and stable scenery; the runner records capture
completion, not an automated visual verdict. Also inspect expanded playlist
artwork clearance. Select changes use native change events
through eval because the installed CLI rejects its own select values payload.
The installed media command also has a CLI/daemon protocol mismatch, so the
reduced-motion check simulates the MediaQueryList `matches`/`change` contract
in-page. It does not exercise the native OS preference.

For a focused continuation of only playlist tour entry, reduced motion and
WebGL cinematic checks, run:

```sh
MUSIC_AUDIT_CINEMA_EDGES_ONLY=1 pnpm --dir frontend audit:chronocity
```

This skips the four-viewport matrix and outer-slot/boundary captures. The default
full runner includes these new checks after that matrix.

Screenshots, failures and results go to `.audit-results/chronocity-<timestamp>/`.
The runner deliberately records visual review as pending: inspect the actual
images separately, including foreground cover readability, control contrast,
phone framing, weathered industrial geometry, warm/cool lighting and steam/haze.
Check the WebGL2 capture as well as WebGPU. The key-light shadow map is disabled
on coarse-pointer devices; a narrow desktop viewport alone does not exercise
that resource policy. No approved Chronocity reference exists yet. Physical touch,
phone frame rate, native Mac-app interaction, live Spotify, real cover CORS and
audio capture are separate checks, not established by viewport emulation.

2026-10-03: `.audit-results/chronocity-2026-10-03T08-59-15-314Z/results.json`
records passing assertions at all four WebGPU sizes and on WebGL2 after the
industrial atmosphere refinement. Frontend check passed with zero errors/warnings;
the desktop test command passed 32 desktop plus 16 frontend tests, and desktop
build:frontend passed. Check and build passed again after the review fixes that
reserve artwork/approach space and replace camera-snapping scenery with nine
fixed world sections. That atmosphere audit includes valid, opened captures of outer
slots 20/21 and both boundary crossings. The same finish reviewer personally
inspected all 11 supplied captures and returned **ship**, with artwork/approach
clearance, scenery continuity and documentation accuracy all **resolved**. The
verdict covers those three fixes only. The runner's automatic pending marker in
results.json is distinct from this completed finish review. The earlier **ship**
verdict covered protected text readability and complete selected artwork framing
on phone before this refinement. Neither review nor assertions establish
photorealism, phone performance or whole-app visual approval.
The general `audit:regressions` run is currently blocked by its stale
`.tile-actions` selector from an earlier artwork-view change. Its older pass above
does not certify the current app.

2026-10-03, subsequent cinematic refinement: the main run at
`.audit-results/chronocity-2026-10-03T09-38-14-579Z/results.json` passed all four
WebGPU sizes, including the cinematic and existing scenarios, then failed at
the installed CLI's media protocol mismatch. The failed entry is retained.
The focused continuation at
`.audit-results/chronocity-2026-10-03T09-42-31-411Z/results.json` passed playlist
proximity entry, simulated MediaQueryList reduced-motion interruption, manual
movement/Approach and WebGL cinematic rendering. Together these are scoped
combined evidence, not a single clean full run. Frontend check passed with zero
errors/warnings; desktop tests passed 32 desktop plus 18 frontend tests (50 total),
and desktop build:frontend passed.

A fresh Astra finish reviewer returned **ship** for the cinematic refinement
with no material code findings after personally inspecting all eight start/arc
captures at the four sizes plus playlist-entry, reduced-motion and WebGL
cinematic captures. Selected covers were fully framed and controls accessible
in those views. This covers inspected framing and control logic; live motion
quality, every transfer path, native OS reduced-motion changes, physical-phone
touch/FPS, the native Mac app, real-cover CORS, live Spotify and whole-app
certification remain outside that verdict. A detector pass returned no findings.
The general regression suite was not rerun for this refinement; its stale
`.tile-actions` blocker remains unresolved.

See `frontend/CHRONOCITY.md` for launch commands, the scoped surface brief, actual
controls, data and resource limits, incumbent-system comparison and provenance.
Stop temporary fixture servers and close any additional manual audit sessions;
reset viewport overrides after browser checks. Validate the actual repository-local
Mac app separately while preserving accounts, preferences, permissions and playback.

## Preview build identity and highlights

With the isolated fixture running (`pnpm --dir frontend audit:serve`):

```sh
pnpm --dir frontend audit:build-info
```

The runner uses the same browser executable/CLI configuration above and accepts
`MUSIC_AUDIT_URL` or `MUSIC_AUDIT_PORT` for the fixture. It opens the isolated
`music-build-info` session and injects synthetic desktop build/setup state through
`window.__auditDesktopStatus`; it does not launch an installer or modify a real
profile. Notes come from the authored `jose/3d-space` preview entry.

At 1920×1080, 1440×900, 1024×768 and 390×844 it asserts source-branch identity,
full Settings highlights and Try it instructions, compact Startup notes, viewport
fit and Escape dismissal. The 1440×900 pass also checks an undescribed preview and
a stable build omit feature claims. It saves Settings top/scrolled and Startup
screenshots at each size, plus a stable Startup capture, under
`.audit-results/build-info-<timestamp>/`. The runner resets its viewport and closes
its session. Stop the fixture separately when finished.

The automatic `visual: pending separate image inspection` marker is deliberate:
passing assertions and capturing images do not approve their appearance. Inspect
them against the incumbent `DESIGN.md` and record a separate scoped verdict.

2026-10-03: `.audit-results/build-info-2026-10-03T13-58-48-091Z/` records passing
assertions at all four sizes. A fresh Astra finish reviewer personally inspected
all 13 screenshots and returned **ship**, with no material fixes or detector
findings (`review.json`). This approves the inspected Startup/Settings build
identity and highlights extension, not the whole app. The runner's pending marker
remains distinct from this completed visual review.

Two metadata tests and 18 frontend tests passed; frontend check reported zero
errors/warnings and desktop build:frontend passed. Desktop tests passed 36 of 37;
the inherited `history.test.js` legacy synchronous migration failure remains.
The general regression rerun at `.audit-results/2026-10-03T13-59-11-387Z/` remains
blocked by its stale `.tile-actions` selector. Native Mac behavior, live Spotify,
physical touch and phone FPS were not exercised. No new final installer had been
published at this validation checkpoint.

## Cover flow, Panels and Orbit

With the isolated synthetic fixture running, use:

```sh
pnpm --dir frontend audit:artwork-explorers
```

The runner checks all three modes at 1920×1080, 1440×900, 1024×768 and 390×844,
then WebGL2 and simulated reduced motion. Set `MUSIC_AUDIT_PORT=4192` on both
`audit:serve` and this command to avoid a busy default port; `MUSIC_AUDIT_URL`
overrides the fixture URL. `MUSIC_AUDIT_SIZES='[[390,844]]'` narrows the size matrix
but retains the final 1440×900 fallback checks. Browser configuration is shared
with the setup above. The isolated `music-artwork-explorers` session resets its
viewport and closes automatically; stop the fixture separately.

The 2026-10-03 run in
`.audit-results/artwork-explorers-2026-10-03T14-48-33-985Z/` passed, and all 27
captures received personal inspection plus a fresh reviewer's **ship** disposition.
That visual verdict is separate from the runner's default pending marker. Five
additional functional edge checks also passed. Synthetic results do not certify
native Mac rendering, live Spotify/audio, real cover CORS, physical touch or phone
FPS. The general regression runner's stale `.tile-actions` blocker remains.
See `frontend/ARTWORK-EXPLORERS.md` for controls, resource bounds, exact evidence,
remaining test limits and the local desktop launch command.
