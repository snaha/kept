---
version: 1
slug: artwork-explorers
primary_target: frontend/src/lib/ArtworkExplorer.svelte
related_targets: [frontend/src/lib/artwork-space/GalleryScene.svelte, frontend/src/lib/Grid.svelte]
---

# Three artwork explorers alongside Chronocity

Mode: Experience. User-directed, code-led extension of the existing artwork-led
library. Preserve DESIGN.md, real covers, metadata, source availability, shared
playback/queue/details, library state and the existing Chronocity experience.

THESIS: Offer three materially different ways to move among original artworks.
Cover flow folds adjacent square sleeves around a front-facing selection. Panels
arranges suspended artwork in an angled gallery that recedes through depth and
height. Orbit wraps artworks around a cylindrical spiral, rotating the archive
as the listener advances. It is the surprise requested by the user.

FIRST VIEWPORT: One complete, readable selected cover above the album actions;
neighbors establish perspective and depth. Inherit neutral toolbar controls and
UI typography. Thin metal frames, a shaded ground and restrained copper rails
belong to the actual 3D geometry, not decorative chrome. Phone keeps the selected
artwork clear of heading and controls. These are local alternate compositions,
not a replacement visual identity or an unrelated direction decision.

INTERACTION: Scroll/drag/arrow keys browse, click a neighboring cover to select
it, click the selected cover to open it. Year navigation uses actual metadata.
Playlists can expand into unique actual album identities, incrementally. Switching
explorers preserves the selection. Playback and background updates never reset
the cover wall. No autoplay or automatic camera tour in these three modes.

MOTION: Exponential easing between deliberate selections, immediate title/control
feedback, bounded rendered neighborhood. Reduced motion removes easing. Pause
the scene under overlays and when the document is hidden. Dispose texture/mesh
resources on eviction and renderer teardown. WebGPU with WebGL2 fallback.

REFERENCES: Codrops WebGL Carousel (https://tympanus.net/Tutorials/WebGLCarousel/),
path gallery (https://tympanus.net/codrops/2026/07/07/building-a-scroll-driven-3d-gallery-using-a-blender-camera-path-with-three-js-and-gsap/),
and Three.js spatial/helix layouts (https://threejs.org/examples/css3d_periodictable).
Borrow spatial navigation disciplines, not their content, assets or code.

FINISH: Four-size synthetic interaction/capture checks, personal image inspection,
one detector, a fresh finish reviewer and ordinary-extension documentation.
Native Mac, physical touch/FPS, live Spotify, actual cover CORS and audio capture
remain untested unless explicitly exercised.
