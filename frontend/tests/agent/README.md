# Agent-driven Music regressions

Use Codex computer/browser controls or the installed `agent-browser` CLI. There
are no maintained Playwright application specs or Cypress tests in this workflow.
Separate Vitest component tests use a Playwright browser provider; the application
journey below remains agent-driven.

## Full build gate

Run `pnpm --dir desktop validate` for the maintained complete run. It builds the
candidate, starts the fixture on a free port, runs this journey at all four sizes
using the pinned CLI and installed Playwright Chromium, saves evidence and cleans
up. CI runs it before packaging. See [testing](../../../docs/testing.md).
The commands below are for interactive diagnosis and focused reruns.

## Start the isolated fixture

```sh
pnpm --dir frontend audit:serve
```

Opens a loopback server at http://127.0.0.1:4178 after building the frontend.
Contains 240 synthetic albums, a playlist, long titles and multiple discs. The local Subsonic API is synthetic; playback uses real HTML audio elements
and a 180-second silent WAV stream with range support. Listening history uses an isolated temporary
SQLite database, deleted when the fixture server stops. No user library, tokens or audible music are used.
Reload resets the fixture's browser preferences. Keep the fixture separate from
the actual app, whose settings and playback are real.

## Repeatable agent-browser assertions

The fixture has contract tests for the current desktop status API, listener
cleanup, serving the selected build, ephemeral ports and process shutdown. Run it with `pnpm --dir frontend audit:test`; CI runs it alongside
frontend checks and the desktop/frontend test suite before packaging.

With the fixture running and Chromium installed:

```sh
pnpm --dir frontend audit:regressions
```

If a browser executable is already installed, set
`AGENT_BROWSER_EXECUTABLE_PATH` to its full path. Otherwise run
`pnpm --dir frontend exec agent-browser install`. The CLI
must support `set viewport`, `hover`, `focus`, `eval`, `snapshot` and `screenshot`.
Set `MUSIC_AGENT_BROWSER` to use another CLI executable location.

Runs at 1920×1080, 1440×900, 1024×768 and 390×844. Checks hover/focus and overlay
hit testing, separate cover browsing and collection playback, listening state,
album/playlist views, catalog result filtering and Add to queue without playback,
dropdown opening/no-match/Escape/selection/reset,
Settings modal centering, focus containment, category keys, local folder actions,
keyboard selection and nested Escape, click-only menus and keyboard dismissal, track-detail
overflow, and scroll/tile-order preservation during background updates.
The phone-size journey also dispatches touch events over an album Play button
under the hidden toolbar, checks that the target remains uncovered until release,
and confirms one activation starts real silent playback. This protects event
ordering; it does not establish native Safari gesture behavior.

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
regression suite. Physical phone, audible output and performance need their
separate release checks in `frontend/UX-AUDIT.md`.

Only replace approved screenshots after reviewing an intentional design change.
Never treat a new screenshot as approved solely because the runner completed.

## Validation records

Run the suite on the branch you intend to ship. See `docs/core-validation.md` for
the extracted core results and native import/search/playback evidence. Earlier
mixed-provider runs do not establish a pass for core. Screenshots remain evidence,
not approved replacement references.

Official agent-browser command reference: https://agent-browser.dev/commands

## Svelte component regressions

`pnpm --dir frontend test:unit` uses Vitest Browser Mode through the production
Svelte/Vite plugin for catalog generations, operation ownership, duplicate queue
identity/focus, browser capability fallbacks, revisions, storage and runtime teardown.
Its Playwright browser provider supplies Chromium; it does not replace this
agent-driven application audit with Playwright end-to-end specifications.
