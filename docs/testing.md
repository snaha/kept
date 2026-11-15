# Build validation

Run the same gate locally and in CI:

```sh
pnpm --dir desktop validate
```

Install both packages with `pnpm install --frozen-lockfile` in `frontend` and
`desktop`, then install the browser once:

```sh
pnpm --dir frontend exec playwright install chromium
```

Linux CI uses `playwright install --with-deps chromium`. The journey CLI is pinned
in the frontend lockfile; no global agent-browser install is needed. Validation
uses that same Chromium for components and journeys. `MUSIC_TEST_BROWSER` can
select an installed Chromium executable. Use Node with built-in SQLite and FTS5;
CI uses Node 22. The preflight reports missing FTS5 or browser setup as a failure,
never a skipped test. Some locally compiled Node distributions omit FTS5.

## Required automated checks

| Stage | What it establishes |
| --- | --- |
| Typecheck | Svelte and TypeScript contracts |
| Component tests | DOM behavior, async ownership, playback state, sharing, transport and capability fallbacks |
| Desktop and helper tests | Main lifecycle, request boundaries, real SQLite/workers, profiles, queue identity and packaging helpers |
| Fixture contracts | Synthetic desktop bridge and fixture startup/shutdown on signal or parent disconnect |
| Real Navidrome | Actual SDK login over HTTP, restricted share creation/update/login, administrator collision protection, redirect refusal without `randomUUID` |
| Production builds | Preload and frontend compile successfully |
| Application journey | Real built frontend at 1920×1080, 1440×900, 1024×768 and 390×844: library/search, playback, queue/history, focus, Settings, styles, layouts and refresh preservation |

The gate starts its own fixture on a free loopback port, with temporary SQLite
state and a uniquely named browser session. It serves `desktop/dist`, the output
of the build in that run. Playback uses real HTML audio and a silent WAV; no real
music, user profiles or running app are touched. The real Navidrome fixture also
uses temporary state and loopback ports. Servers, processes and browser sessions
are closed afterward.

Each invocation writes `.audit-results/validation-<timestamp>/`: stage logs,
journey screenshots and failure snapshots, plus `results.json` with the commit,
dirty files, source hash, timing, automated outcome and pending manual checks.
The first failed stage stops the run and returns a nonzero exit code. Later
stages have not run; a partial run is never a full pass. Setting a single
`MUSIC_AUDIT_VIEWPORT` is rejected by the full gate.

`pnpm --dir desktop dev:app`, `dist:mac` and `dist` require validation before
creating the app/package. CI runs this same gate in its required `checks` job
and uploads evidence even on failure. The dependent packaging jobs use
`dist:mac:package` / `dist:package` after that gate, avoiding a duplicate browser
run per platform. Those package-only helpers do not establish validation.

For iteration, `dev`, `dev:hot`, `build:frontend`, `build:preload` and
`dev:app:quick` remain explicit development/compile shortcuts. Their success is
not a validated build. Individual test commands and the interactive
[`audit:serve` workflow](../frontend/tests/agent/README.md) remain available for
diagnosing failures.

## Close the remaining gaps

An automated pass is required for every candidate build. It does not turn the
following hardware or human observations into passes. Record each result against
the same candidate and put evidence alongside its validation report.

| Check | Repeatable procedure and expected result |
| --- | --- |
| Visual review | Inspect the four-size screenshots against approved references using the [UX checklist](../frontend/UX-AUDIT.md). Record clipping, overlap, focus and readability results. Capturing images is not approval; do not update references automatically. |
| Packaged app / OS | Launch the built package with a fresh isolated profile. Add a synthetic music folder through the native chooser, wait for indexing, search/play, pause, restart and check history and roots. For portable builds repeat without the source checkout. |
| Home-network phone | On a real iPhone/Safari and/or Android/Chrome, scan Share while both devices use ordinary home Wi-Fi. Confirm login without a certificate prompt, browse, start a track by touch and hear audio. Check pause/next/seek, lock/background and resume. Record OS/browser and any playback interruption. The phone owns its own queue; this does not test remote control of the Mac. |
| Tailscale | With both devices connected to Tailscale and the phone off home Wi-Fi, open the Mac's Tailscale-address share link. Repeat login and audible playback. A loopback test cannot establish firewall or routing reachability. |
| Performance / continuity | On the physical phone, record frame timing while scrolling and while library updates occur during playback. Check the 60 fps target and listen for dropouts. Desktop viewport emulation and a silent WAV cannot establish device performance or sound quality. |

Run the native/device checks before a release and whenever the corresponding
boundary changes; mark unavailable checks **untested** with the device/action
still needed. The [coverage ledger](regression-coverage.md) identifies which
promises remain at those boundaries. Local HTTP on a trusted home network is an
accepted product tradeoff; these checks do not claim to encrypt ordinary Wi-Fi.
