---
name: Music
description: Square album artwork with quiet controls for browsing, discovery, and playback.
colors:
  ui-surface: "#18181b"
  ui-muted: "#27272a"
  ui-border: "#ffffff26"
  ui-text: "#fafafa"
  ui-accent: "#e4e4e7"
  ui-text-muted: "color-mix(in srgb, var(--ui-text) 72%, var(--ui-surface))"
  classic-surface: "#111"
  classic-muted: "#222"
  classic-border: "#ffffff40"
  classic-accent: "#eee"
  neon-surface: "#151427"
  neon-muted: "#292442"
  neon-border: "#a78bfa55"
  neon-accent: "#c4b5fd"
  coss-surface: "#161616"
  coss-muted: "#202020"
  coss-border: "#ffffff0f"
  coss-text: "#f5f5f5"
  playback-bar: "#0d0d0df5"
  playback-text: "#fff"
  playback-muted: "#b6b6b6"
  playback-line: "#ffffff24"
  artwork-fallback: "#191919"
typography:
  title:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.4
  settings-title:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.025em"
  section:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "-.015em"
  body:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.4
  settings-body:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "12px"
    lineHeight: 1.4
  caption:
    fontFamily: '"Avenir Next", "Segoe UI", system-ui, sans-serif'
    fontSize: "11px"
  coss-body:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: "20px"
rounded:
  artwork: "2px"
  classic: "3px"
  compact-control: "4px"
  compact-play: "5px"
  studio: "6px"
  coss: "8px"
  neon: "16px"
  slider-track: "99px"
spacing:
  compact: "6px"
  control-gap: "8px"
  row-gap: "12px"
  panel-gap: "16px"
  section-gap: "24px"
  album-columns: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ui-accent}"
    textColor: "{colors.classic-surface}"
    rounded: "{rounded.studio}"
    padding: "8px 14px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.ui-surface}"
    textColor: "{colors.ui-text}"
    rounded: "{rounded.studio}"
    padding: "8px 14px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ui-text}"
    rounded: "{rounded.studio}"
    padding: "8px 14px"
    height: "36px"
  library-search:
    backgroundColor: "{colors.ui-muted}"
    textColor: "{colors.ui-text}"
    rounded: "{rounded.compact-control}"
    typography: "{typography.label}"
    padding: "0 9px"
  preset-chip:
    backgroundColor: "{colors.ui-muted}"
    textColor: "{colors.ui-text}"
    rounded: "{rounded.compact-control}"
    padding: "6px 9px"
    height: "32px"
  preset-chip-selected:
    backgroundColor: "{colors.ui-text}"
    textColor: "{colors.ui-surface}"
    rounded: "{rounded.compact-control}"
    padding: "6px 9px"
    height: "32px"
  artwork-card:
    backgroundColor: "{colors.artwork-fallback}"
    rounded: "{rounded.artwork}"
  compact-play:
    backgroundColor: "#101010e6"
    textColor: "{colors.playback-text}"
    rounded: "{rounded.compact-play}"
    size: "36px"
  settings-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ui-text-muted}"
    typography: "{typography.settings-body}"
    padding: "0 14px"
    height: "46px"
---

# Design System: Music

## Overview

**Creative North Star: "Artwork leads"**

The approved direction is the Music Figma file's [Current page](https://www.figma.com/design/OfsKpzlMZkLzzoHMWA4FHg/Music?node-id=52-871): square cover artwork, a restrained charcoal ground, compact neutral controls, and direct playback. “Artwork leads” repeats the supplied direction; it is not a newly invented brand metaphor. Descriptive token names and the named rules below are documentation labels inferred from the implemented system.

This records the Svelte interface shared by web and Electron after the five scored implementation fixes received a ship disposition. Ground truth is `frontend/src/components.css`, `app.css`, `coss.css`, `Grid.svelte`, `ArtworkView.svelte`, `AlbumView.svelte`, `CollectionDetails.svelte`, `CollectionPlayback.svelte`, `Queue.svelte`, `Bar.svelte`, `DigPanel.svelte`, and the Settings implementation. Preserve the already polished tabbed Settings structure. Studio is the fresh-install component preset; saved Classic, Neon, Coss, materials, density, and motion preferences remain supported.

Album detail follows the Music Figma album frame on its own `AlbumView` shell: the header over the list column, the full-height cover beside it, stacked on phone with the cover up to (360px). Queue/Recently played keep the full-color ArtworkView: equal desktop columns within (1680px) and complete contained artwork bounded by viewport height. Queue/history tabs remember their scroll positions. The bottom Menu toggles the expanded player and shows X while open; playback options remain in the header overflow menu anchored below its measured trigger. Share closes the expanded player before opening its drawer.

Evidence is the source plus the synthetic desktop and phone captures in `.impeccable/review/`, with scope and disposition in `.audit-results/figma-current/review-packet.md` and `finish-verdict.md`. No PRODUCT.md, QUALITY BAR card, approved comp, or comp-diff exists; this is an implementation record, not a pixel-match certification or a product requirements document. Physical touch, 60 fps performance, physical audio output, delayed history-write execution, and native Mac rendering remain untested. The ship disposition covers the five scored fixes, not a complete surface certification. The subsequent unified album/player extension is recorded in `.audit-results/unified-player/review-packet.md`, with synthetic captures in `.impeccable/review/unified-player/`. That scope covers the shared artwork view, queue/history tabs, and relocated playback options; history timing under load and queue mutation remain untested alongside the native, physical-touch, performance, and live-provider limits above.

**Key Characteristics:**

- Square album artwork dominates the viewport.
- Neutral chrome gives feedback through focused, hovered, selected, pending, and confirmed playback states.
- Album detail and the expanded player adapt their ground to artwork while the playback bar stays neutral.
- Background work preserves the user's wall order, view, scroll position, and queue.
- Discovery states its manual-tag and listening-history data sources.

## Colors

The control palette is charcoal with near-white text and a neutral accent; artwork supplies the dominant color.

### Primary

- **Control accent** (`ui-accent`): primary button fill, focus outlines, active sliders, and selected controls. Read the value from frontmatter; the active preset supplies the live CSS variable.
- **Neon accent** (`neon-accent`): the existing user-selected lavender preset. It is an optional control treatment, not the default wall identity.

### Neutral

- **Control surface / muted surface** (`ui-surface`, `ui-muted`): toolbar, popovers, Settings, fields, and hover/pressed fills.
- **Control foreground / muted foreground** (`ui-text`, `ui-text-muted`): primary text and readable subordinate text. The muted foreground is the source's live color mix, including placeholders at full opacity.
- **Control edge** (`ui-border`): thin field edges, section boundaries, and scrollbar treatment.
- **Classic, Neon, Coss neutrals**: the prefixed tokens record actual preset overrides. Classic changes the shared radius to `classic`; Neon to `neon`; Coss to `coss` and the alternate font stack. Coss text and accent share `coss-text`. The later shared muted-foreground declaration wins over Coss's earlier muted-text declaration.
- **Playback neutrals** (`playback-*`): the fixed slim player has its own neutral foreground, metadata, and progress edge, independent of an album's colors.
- **Artwork fallback** (`artwork-fallback`): the tile base while cover content is absent.

**The Artwork Ground Rule.** Keep the library control layer neutral; derive album-detail color from its artwork rather than treating fixture colors as brand colors.

Album detail and the expanded player share the artwork palette, sampled asynchronously with a fallback immediately available. The dominant region is tinted toward light or dark according to luminance; separate text, muted text, accent, and line colors follow that choice. Keep these generated `--play-*` roles together. The Dig map's muted purple, ochre, and teal gradients encode its spatial mood/energy axes; they are local to that component. Sidecar tonal ramps are synthesized preview aids and are not additional implementation tokens.

## Typography

**Body / control font:** Avenir Next, Segoe UI, system-ui, sans-serif through the shared UI font. **Coss font:** Inter Variable, ui-sans-serif, system-ui, sans-serif. **Root fallback:** system-ui, sans-serif. No separate display or mono identity is established.

Text remains compact so artwork carries the composition. The frontmatter captures roles used by the components; it does not introduce a new display hierarchy.

- **Title:** album header; narrows to (18px) on phone.
- **Settings title:** modal heading with its distinct weight and tighter tracking.
- **Section:** Settings subsection headings.
- **Body / Settings body:** track content and modal content; Settings uses the looser line height.
- **Label:** compact toolbar, playback bar, and tile information. Dig uses (12px / 1.5).
- **Caption:** subordinate metadata; tile artist text drops to (10px) on phone. Settings help text uses (13px / 1.6) and a (72ch) maximum; Dig explanation uses a (65ch) maximum.

**The Legible Control Rule.** Use the active theme's muted foreground for secondary control text and the library Search placeholder at opacity 1; a quiet control still needs visible text.

## Layout

The wall is a fixed scrolling viewport with square, cropped cover images. Default density is six columns; saved column preferences win. Effective columns are capped by available width at roughly (140px) per column, giving two columns at the captured (390px) phone width. Gaps scale from the saved density value against viewport width; do not replace this with a fixed desktop gap. Virtualized rows retain spacer geometry and keyed tile identity.

The compact toolbar has a (52px) minimum desktop height and keeps measured space above the grid. At (1100px) and below its gaps and dropdown widths narrow; at (700px) and below it becomes two rows, with a horizontally scrolling filter/sort strip and larger controls. Idle chrome fades/translates without changing the reserved grid geometry; hover, keyboard focus, open menus, and Dig keep it available.

Album detail follows the Music Figma file's ALBUM, PLAYLIST & ARTIST PAGES album frame: equal desktop columns with the track list on the left and the full-height cover on the right. The list column owns a stacked header — bordered back button and overflow menu row, (30px/36px) title, artist left with genre • year right — then the actions row (primary Play pill, shuffle and repeat toggles, right-aligned (288px) album search), (48px) single-line track rows with per-track overflow menus, and an "N songs • M min" count. The cover keeps object-fit contain at `min(100%, calc(100dvh - var(--botbar, 60px) - 64px))`, centered in its column, and independently scrollable for the Dig-tags panel. The expanded player (Queue/Recently played) keeps the shared artwork view above the playback bar: header spanning both columns, artwork left, (60px) two-line rows. At (700px) and below both stack to header, artwork up to (360px), then content with one scrolling body; album search gets its own full-width row. Track paging updates the existing surface.

The playback bar is (60px) high on desktop and (68px) on phone. Desktop transport is centered; cover and metadata occupy the left, output/volume/menu the right. Between (701px) and (1100px), the hidden provider must leave volume aligned right, clear of transport. Phone uses inline transport, hides previous and the volume slider, and retains mute/menu controls. Safe-area bottom padding is supported.

Settings is centered, bounded to (820px) width and (640px) height, with viewport margins. At (600px) and below its outer margins shrink. Header and tabs remain fixed; one body scrolls with a stable scrollbar gutter. Tab selection explicitly resets that body's scroll to the top.

**The Stable Wall Rule.** Background refresh replaces tiles in place and appends new matches; only explicit filtering, sorting, or density actions may change the user's browsing arrangement. Apply warmed cover-color order through the explicit Apply action.

## Elevation & Depth

The interface combines tonal layers and small ambient shadows. Album covers have a low shadow at rest and a stronger one on hover/focus. Floating menus and Settings use depth to separate them from the wall. The default ground is restrained noise; existing Vinyl, Grille, Fabric, Custom, and Viz materials remain selectable. Their physical effects are optional appearance choices, not requirements for new controls.

- **Cover rest:** (`0 3px 6px #0004`).
- **Cover hover/focus:** (`0 4px 18px #0009`).
- **Searchable menu:** (`0 12px 36px #0009`).
- **Settings modal:** (`0 24px 72px #0009`) with a dark translucent backdrop.

**The State Depth Rule.** Keep strong separation on floating surfaces and direct interaction states; do not add decorative elevation to every toolbar control.

## Shapes

Artwork stays square with the `artwork` corner token. Compact toolbar and album actions use the small `compact-control` radius; tile transport uses `compact-play`. Shared primitives inherit their preset radius; Settings uses that live radius plus (4px), and its frame clips to the same shape. Slider tracks are pill shaped and thumbs circular. Borders remain thin; the three-pixel white playing outline is a state indicator, not a generic card border.

## Components

### Buttons

Neutral controls with immediate state feedback. Shared primary buttons fill with the theme accent and dark text; outline buttons use the theme surface and edge; ghost buttons start transparent. Defaults use the frontmatter padding and minimum height, while small variants use (5px 10px) and a (30px) minimum. Hover brightens shared buttons; disabled controls dim and stop accepting input. Keyboard focus is a visible (2px) outline. Coss retains its existing inset edge and distinct hover/active treatments. Phone/coarse-pointer variants use the component's larger targets, typically (44px).

### Inputs / Fields

One visible field boundary per search. Library Search has a wrapper border/background, an unbordered transparent inner input, readable placeholder, and a wrapper focus outline. Searchable dropdowns use the same theme roles, a scrollable floating menu, highlighted rows, and selected text treatment. Album search is a quiet underline on the artwork-derived ground. Preserve keyboard searching, selection, and dismissal.

### Chips

Dig preset chips use muted fill at rest and inverted foreground/surface when selected. They scroll horizontally and retain their explicit pressed state. Random pick and Reset communicate disabled state when no action is available.

### Cards / Containers

The cover button opens album detail. A separate upper-right transport button controls playback; its click must never open the queue. Hover or keyboard focus reveals metadata and transport; the current origin retains transport for Resume, and touch layouts expose transport directly. Cover images crop to the square without inventing metadata.

**The Confirmed Playback Rule.** Show the thick white outline and listening bars only for confirmed playing at that origin. Paused current items offer Resume; pending items show a distinct cancellable loading control. Hover/focus replaces listening bars with Pause.

### Navigation

The compact toolbar supplies search, Dig, collection/music filters, sort direction, grid size, display modes, and Settings. Cmd/Ctrl+K and `/` consistently target visible library Search, closing album detail first. Settings uses fixed Appearance and Advanced tabs; selection uses a narrow accent underline, with roving tab focus and arrow/Home/End navigation. ESC, the close button, and backdrop dismissal return focus to a connected prior control.

### Album detail

Artwork-derived color on the album layout: bordered back button and overflow-menu row, (30px) title with artist and genre • year, a Play pill with shuffle and repeat toggles plus right-aligned album search, then single-line (48px) rows — number or playing indicator, title, duration, and an overflow menu offering Add to queue. The count line reports songs and minutes; favorite has no album-view control, so it reflects server stars only. Shuffle and repeat render pressed state only; the play-order control still lives in playback options. Partial loading, inaccessible collections, source recovery, and no-match states remain explicit. Album preferences & Dig tags stay in the overflow menu and appear under the cover.

### Queue / Recently played

The expanded player uses the shared artwork-derived view and retains the original listening context beneath the full cover. Queue and Recently played tabs show counts and a narrow selected underline, with roving focus and arrow/Home/End navigation. Each tab remembers its scroll position while the view stays open; on phone, a first visit to the other tab preserves the body position. Queue rows retain reorder/removal and availability states; the current track toggles pause/resume, with listening bars only for confirmed playback and a distinct pending state. History retains search, paging, replay, clear, and retry. Track action menus return focus to their trigger, and their Escape dismissal stays local.

### Dig

The spatial control maps Sad→Happy horizontally and Calm→Intense vertically. Pointer capture supports dragging; arrow keys adjust by (5) and Home centers it. Familiar→Forgotten, Acoustic→Electric, and Vocal→Instrumental use the existing sliders. Mood and sound are manual album tags because current providers do not supply audio traits. Familiarity and play sorting use confirmed, durably persisted history aggregates; browser totals are separate from the rolling history display. Untagged albums stay in All music; zero matches explain the tag requirement. Do not present manual tags as inferred audio analysis.

### Playback bar

The player remains mounted once a song exists, including paused/loading states. Full-width progress becomes thicker on hover/focus and shows elapsed/remaining time; keyboard seeking uses (10-second) steps. Output-aware volume is disabled with an explanation when unsupported. Preserve source recovery, queue state, and output status. The bottom-right Menu button and bottom cover/title toggle the expanded player; Menu shows X while open. Opening it from album detail replaces that view. Q, Escape, and the header back button remain available. Share, Recently played, visualizer, shortcuts, random playback, and order controls live in the expanded header overflow menu, positioned below its measured trigger even when a title wraps. Share closes the expanded player before opening its drawer. Menus remain keyboard accessible, return focus on dismissal, and handle nested Escape locally. Neutral bar tokens intentionally override album-derived roles.

### Settings

Keep the centered modal, fixed header/tabs, single scrolling body, ESC/X close, and local folder/profile controls in Advanced. Appearance and diagnostics stay available. Labels and device fields wrap within the panel instead of widening it.

Motion supports state feedback: shared control color changes settle in (120ms), slider hover/focus grows the thumb in (140ms), and searchable menus arrive in (180ms). Values update synchronously. Respect reduced motion by removing the implemented movement/animations; the optional whole-grid drift starts off by default. A pending spinner stays distinguishable when its rotation is disabled.

## Do's and Don'ts

### Do:

- **Do** keep square artwork dominant and the control layer neutral.
- **Do** preserve saved component styles, materials, columns, and motion preferences.
- **Do** keep cover opening and playback as distinct controls with visible keyboard feedback.
- **Do** preserve wall order, scroll, and queue while background data settles.
- **Do** state the manual-tag and confirmed-history basis of Dig.
- **Do** preserve the fixed Settings header/tabs and single scrolling body.

### Don't:

- **Don't** show confirmed-playing decoration for paused, suspended, or pending playback.
- **Don't** let volume collide with centered transport at intermediate desktop widths.
- **Don't** focus library Search underneath an open album view.
- **Don't** promote fixture artwork colors or synthesized sidecar ramps into brand tokens.
- **Don't** turn source gaps or untested native/live-provider behavior into certified design claims.
