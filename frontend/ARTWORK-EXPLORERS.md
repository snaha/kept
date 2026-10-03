# Artwork explorers

Cover flow, Panels and Orbit are three alternate library views alongside
Chronocity. They share the existing artwork, metadata, availability rules and
playback controls. This is a code-led extension of the incumbent Music interface;
its scoped design brief is `.impeccable/surfaces/artwork-explorers.md`.

## Run locally

From the existing worktree:

```sh
cd <your checkout>
pnpm --dir desktop dev
```

Choose Cover flow, Panels or Orbit in the library toolbar. Clicking the active
mode again returns to the cover wall. Switching directly among these three
layouts keeps the selected album, including a selected member of an expanded
playlist. The preserved wall retains its scroll position.

The authored preview highlights in `desktop/build-highlights.json` describe these
views for a future preview build. To refresh local preview metadata, run
`MUSIC_CHANNEL=preview pnpm --dir desktop prepare:build` from the repository root.
No installer containing these new views was created at this checkpoint.

## Composition and controls

| View | Spatial arrangement |
| --- | --- |
| Cover flow | A front-facing selected square sleeve with folded neighbors on a horizontal shelf and thin metal rails. |
| Panels | Suspended frames spread sideways and recede through depth and height. |
| Orbit | Original covers form a cylindrical spiral with restrained copper rings. |

Original artwork remains on the cover faces. Muted metal, copper framing and the
shaded floor belong to the surrounding scene; they do not replace the art or add
foil to it. All three inherit the UI font and keep compact controls on a dark
neutral ground. Camera fitting measures the album console's height and reserves
additional space above the cover for an expanded playlist. Check both long
metadata and playlist states when changing this geometry.

- Scroll on the canvas or drag horizontally to browse. Arrow keys select the
  previous/next item; Home and End select the first/last item while the explorer
  has keyboard focus.
- Click a neighboring cover to select it. Click the selected cover to open album
  details or expand its playlist artwork. Enter does the same when the scene
  itself has focus.
- The year selector jumps to actual release metadata, including Undated.
- Zoom buttons change camera distance; Fit artwork restores the default fit.
- Play/Pause/Resume and pending cancellation use shared `CollectionPlayback`.
  Tracks opens shared details; Queue adds the selected collection through the
  existing queue path. Availability messages and disabled queue actions retain
  source restrictions.
- Explore artwork expands a playlist into unique actual album identities as
  track pages arrive. Tracks in the playlist header opens the parent playlist.
  Playlists or Escape returns to the selected parent. Failed/restricted loads
  offer source details and retry; stale responses are ignored after leaving.

These three modes have no automatic camera tour or autoplay. Chronocity retains
its own existing movement and opt-in cinematic controls.

## Implementation and resource limits

`frontend/src/lib/ArtworkExplorer.svelte` owns input, selection, playlist loading
and the control layer. `frontend/src/lib/artwork-space/GalleryScene.svelte` owns
scene geometry, artwork textures and camera fitting; `layout.ts` defines the
three arrangements. `Grid.svelte` loads the explorer lazily and preserves the
wall. The renderer reuses Chronocity's `CityCanvas`: WebGPU with WebGL2 fallback.

At rest the scene holds at most 25 artwork entries, or 17 below 700px scene width.
A long jump temporarily retains the old and destination neighborhoods, bounded
at 50/34 entries, then retires the old one. Each entry includes more than one
mesh, so these are artwork-entry limits, not total draw-call limits. Textures and
materials are disposed on eviction, shared geometry on teardown. The completed
playlist cache holds at most 12 collections. Missing images retain album identity
and show a title fallback plus a visible status message.

Selection labels update immediately while scene positions ease toward the chosen
item. Reduced motion removes selection easing. Rendering pauses when the view is
inactive, the document is hidden or a covering overlay is open. These resource
policies do not establish a measured phone frame rate.

## Repeatable synthetic audit

Start the isolated fixture in one terminal, using 4192 when the default 4178 is
occupied, then run the dedicated audit in another:

```sh
MUSIC_AUDIT_PORT=4192 pnpm --dir frontend audit:serve
MUSIC_AUDIT_PORT=4192 pnpm --dir frontend audit:artwork-explorers
```

Omit `MUSIC_AUDIT_PORT` on both commands to use 4178. `MUSIC_AUDIT_URL` can point the
runner to an existing fixture. Browser setup and `AGENT_BROWSER_EXECUTABLE_PATH`
are documented in `frontend/tests/agent/README.md`; `MUSIC_AGENT_BROWSER` selects
a different CLI path. Use a Node runtime with SQLite FTS5 for the fixture.

The default matrix is 1920×1080, 1440×900, 1024×768 and 390×844. For a focused run,
set `MUSIC_AUDIT_SIZES='[[390,844]]'`; this narrows the matrix but retains the final
1440×900 WebGL2 and simulated reduced-motion checks. The runner uses the isolated
`music-artwork-explorers` session, resets its viewport and closes it on completion.
Stop the fixture separately; close additional manual sessions and reset overrides.

Checks include canvas rendering, selected-cover framing, year and keyboard
navigation, wheel browsing, zoom, background-selection continuity, overlay pause,
shared playback and queue, wall-scroll retention, paged playlist identities,
member preservation across layouts, and return to the parent playlist. All three
modes also render on forced WebGL2. Reduced-motion testing simulates the
MediaQueryList contract because the installed CLI's media command has a protocol
mismatch; it does not exercise the operating-system preference.

The fixture uses synthetic albums and inline SVG study covers, mocked playback
and an isolated temporary history database. It does not use real accounts or
prove actual audio playback. Screenshots and results are written to
`.audit-results/artwork-explorers-<timestamp>/`. The runner deliberately marks
visual review pending: inspect the images separately and record a scoped verdict.
No approved visual reference exists for these new modes.

## Validation checkpoint: 2026-10-03

`.audit-results/artwork-explorers-2026-10-03T14-48-33-985Z/` passed all four sizes,
WebGL2 and simulated reduced motion. The implementing agent personally inspected
all 27 root/playlist/WebGL captures and recorded its visual pass in `results.json`.
A fresh finish reviewer independently inspected the same 27 images and returned
**ship**, with no material fixes. Copies, `reviewer.md` and an empty detector result
are in `.impeccable/review/artwork-explorers/`.

Five additional checks passed in `.audit-results/explorer-functional-edges.json`:
selected-cover raycasting, missing-art identity/fallback, restricted queue,
actionable playlist error and ignoring a pending playlist's late result after
returning to its parent. Existing Chronocity assertions passed in
`.audit-results/chronocity-2026-10-03T14-48-33-984Z/results.json`; those legacy
captures did not receive wholesale visual approval in this pass.

Frontend check reported zero errors/warnings; frontend and desktop frontend
production builds passed; 20 frontend tests passed. Desktop tests passed 36 of 37.
The inherited synchronous legacy migration assertion in `history.test.js:35`
(expected 1, actual 0) remains, previously verified against the baseline. The
general audit at `.audit-results/2026-10-03T14-48-14-980Z/` remains blocked by the
inherited stale `.tile-actions` selector. This is not a full general UI audit.

Actual Mac-native rendering of these modes, live Spotify, real-cover CORS,
audio capture, physical touch and measured phone FPS remain untested. Existing
onboarding evidence does not extend to these new views.

## Incumbent authority and references

`PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json` remain unchanged. The
root design document and sidecar still say no PRODUCT.md exists, although it is
now present. They also retain older broad native-validation limits while
PRODUCT.md records a later, scoped local-onboarding pass. This pre-existing
documentation drift is reported here without repairing the root artifacts.
Local scene materials and arrangements are not promoted into global design tokens.

Spatial references recorded in the scoped brief are the
[Codrops WebGL Carousel](https://tympanus.net/Tutorials/WebGLCarousel/),
[Codrops camera-path gallery](https://tympanus.net/codrops/2026/07/07/building-a-scroll-driven-3d-gallery-using-a-blender-camera-path-with-three-js-and-gsap/)
and [Three.js spatial/helix layouts](https://threejs.org/examples/css3d_periodictable).
They inform spatial navigation; their content, assets and code are not bundled.
