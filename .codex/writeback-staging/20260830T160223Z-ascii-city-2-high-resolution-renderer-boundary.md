---
title: "ASCII City 2 high-resolution renderer boundary"
created_at: "2026-08-30T16:02:23.696706+00:00"
type: "pending-writeback"
---

# Summary

The first polygon integration corrected geometry but still painted through the coarse cell compositor, so it was not a visible renderer upgrade. The corrected cinematic path keeps grid depth and picking while painting OSM facades, roofs, and windows as display-resolution Canvas paths.

The pass shipped mirrored. `cameraPoint` negated the side axis and the projection subtracted it, so the polygon city was reflected about the screen centre while the streets, signs, labels, vehicles, and sky stayed correct. Nothing caught it: the projection test only checked a point dead centre, where a mirror is a no-op, and the whole test suite plus lint passed on the mirrored build.

# Rules

- Preserve semantic compatibility in shared depth/picking buffers, but paint upgraded geometry at its intended output resolution.
- Compose underlying ground or sky, vector meshes, nearer semantic cells, then text and live glyph overlays.
- Every world-anchored layer projects `side = -dx*sin(a) + dy*cos(a)` and `col = cols/2 - (side/along)*proj`. Both halves together. A new projector must be tested against an off-centre point on each side, never only the centre.
- Draw meshes near-first. The spatial hash returns bucket order, so a budget spent in query order lands on arbitrary buildings.

# Verified this session

- Real headless-Chrome frames at eye level and from the air, against the same view rendered at HEAD. Facades, roofs, and window grids are straight and antialiased, and the polygon buildings now sit on the same columns as the street network.
- Compositing order is asserted, not just call counts: `test/support/screen.js` stamps a monotonic `order` on every recorded canvas call, and `building-mesh.test.js` requires base rects before the first path fill and the live overlay glyph after the last one.
- Both new projection tests fail on the mirrored code and pass on the fix.
- `npm run check`: 223 pass, lint clean.

# Measured

Offline demo city, headless software canvas, 138x112 grid, `perf.snapshot()` after five seconds:

| build | raycast | compose | frame | fps |
|---|---|---|---|---|
| HEAD (height field) | 1.75 | 1.36 | 3.71 | 48 |
| polygon pass, query order | 6.06 | 4.58 | 11.17 | 34 |
| polygon pass, near-first | 4.2-4.5 | 2.8-3.0 | 7.6 | 58-60 |

`npm run benchmark` now carries an `OSM polygon facades` scene; the height-field scenes cannot see this cost at all.

# Verify next time

- Dense real OSM, not the six-building demo. The demo alone queues 1714 window panes; `MAX_VECTOR_WINDOWS` is 3600, so Manhattan will hit the cap and the budget behaviour at saturation is untested.
- `_blitMeshSurfaces` is a painter's-algorithm sort on average surface depth and consults no depth buffer. Adjacent or interpenetrating footprints are the case that will break it.

# Prevents

- Treating mathematically improved geometry in the old coarse compositor as a completed visual renderer upgrade.
- Trusting a green suite over a rendered frame. A centre-only projection assertion cannot see a mirror.

# Look here first

- src/render/buildings.js
- src/screen.js
- test/building-mesh.test.js
- test/support/screen.js
