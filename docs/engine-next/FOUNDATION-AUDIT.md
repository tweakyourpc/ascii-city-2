# Engine Next Foundation Audit

Status: pre-implementation assessment  
Baseline commit: `57f7fd22449566d80f383c4c3b8ed8bb37d29257`  
Recovery tag: `ascii-city-2-baseline-v2.0.0`  
Development branch: `engine-next`  
Assessment date: 2026-08-23

This report records the existing implementation before Engine Next changes. It
is intentionally specific about what already works, what is missing, and which
proposed ideas would be rewrites rather than incremental extensions.

## 1. Architecture assessment

### Application shape

ASCII City 2 is a static browser application built from native JavaScript ES
modules. It has no runtime package dependency. Canvas 2D is the only display
backend. A small optional Cloudflare Worker proxies ADS-B and radio discovery;
weather, geocoding, OSM, Wikipedia, and astronomical calculation use direct
browser access or local calculation.

The current frame pipeline is:

1. advance the city clock and input-driven simulation;
2. update traffic, live aircraft, and weather state;
3. calculate solar position and lighting;
4. rebuild the camera's per-column ray table;
5. raycast ground, building facades, roofs, and vegetation into a cell buffer;
6. paint the smooth sky behind the cell buffer;
7. project roads and the remaining semantic layers into the same depth buffer;
8. draw text panels and batch the cell buffer to Canvas 2D.

The draw order after the height-field pass is roads, signs, traffic signals,
labels, traffic, aircraft, weather, the identify panel, and finally Canvas
composition. The ordering is part of the behavior: all world layers share the
same depth array, while HUD text intentionally remains screen-space UI.

### World coordinate model

- `+x` is east and `+y` is north.
- A camera angle of `pi / 2` faces north.
- One horizontal world cell is about 2.37 metres.
- Vertical coordinates use the same cell unit. A nominal storey is 1.35 cells,
  derived from 3.2 metres per storey.
- Camera pitch is currently a screen-row offset, not an angle in radians.
- OSM coordinates use a local equirectangular projection around the requested
  bounding-box centre. This is appropriate for the current city-sized extracts.

There are two world-storage implementations behind the same hot-loop contract.
`sample(x, y)` returns an integer slot into parallel typed arrays rather than an
allocated object.

- The procedural world lazily generates deterministic 32 by 32 chunks into a
  pooled structure-of-arrays store. When its generous cap is reached it uses
  wholesale eviction, not a sliding-window LRU.
- An OSM extract is bounded and rasterized once into flat typed arrays. Building
  polygons become a height field; roads remain available both as raster surface
  cells and as projected polylines.

This split is efficient and worth retaining. It is not yet a geographic streaming
system: the procedural chunks wrap inside a fixed synthetic world, and an OSM
city is still one complete in-memory extract.

### Real-world geometry

OSM building rings and multipolygon members are projected and scan-filled onto
the 2.37-metre grid. Holes work through even-odd filling. Each occupied cell
stores height, type, material seed, flags, and a building-record index. Building
records retain the authoritative OSM element identity and tags.

This means the engine already accepts irregular OSM footprints, but the raycaster
does not intersect the original polygon edges. It intersects their rasterized
height-field interpretation. Camera-plane projection will improve perspective,
but it cannot restore footprint detail discarded during rasterization. A future
near-field polygon path or finer adaptive raster should be measured separately.

### Existing spatial behavior

The height-field DDA is already an O(visible columns times crossed cells) spatial
query. It does not test rays against every OSM building. Ground sampling is also
spatially coherent and benefits from the procedural world's last-chunk memo.

Other layers are less disciplined. The procedural reference world contains 294
road polylines and 21,609 graph junctions. `renderStreets()` projects all road
vertices, sorts all roads, and scans every junction each frame. This pass costs
more than the raycaster at the current resolutions. Spatial filtering of semantic
layers is therefore a higher-value optimization than adding a quadtree to the
already O(1) height-field lookup.

### Simulation and identity

OSM cars use the directed road graph, including one-way/access constraints,
lane offset, signals, braking, headway, and random outgoing-edge selection.
Movement is continuous in world space. Procedural traffic also has a graph, but
agent creation and route choices use `Math.random()`, so traffic is not currently
session-reproducible. Building identity is stable for OSM (`type/id`); procedural
terrain is deterministic by absolute coordinates, but procedural buildings and
street objects do not yet expose stable semantic IDs.

Live aircraft are polled every 20 seconds and moved between polls from reported
velocity data. They are withdrawn when the city clock is not live. Weather is
polled every ten minutes and is likewise withdrawn in time simulation. The
astronomical sky is calculated locally from the requested coordinate and instant.

### Composition

The screen owns glyph, colour, depth, and kind buffers. GLYPH mode groups adjacent
same-colour glyphs into `fillText()` runs. BLOCK mode uses two half-height scene
cells per text line and batches equal-colour cells into `fillRect()` runs while
preserving text as glyphs. The gradient sky is already a direct Canvas layer
behind the grid.

This is a sound seam for a future WebGL glyph compositor: JavaScript can continue
to own simulation, raycasting, visibility, and cell selection. WebGL need only
consume glyph/colour buffers. It should not become the world renderer.

### Portability findings

Two current behaviors violate the new forkability requirement:

- `npm start` and the public README require the author's local `portbroker` tool.
- `API_BASE` is hard-coded to the author's Cloudflare Worker, so a fresh clone
  sends aircraft and radio requests to infrastructure owned by the original
  project.

Both must be removed. The public development server should work with conventional
Node tooling while still accepting an explicit `PORT`. Worker-backed capabilities
must start unconfigured or use an explicitly chosen local configuration. Direct,
local, and offline functionality must remain useful without a Worker.

## 2. Renderer assessment

### Current ray generation

The current camera uses linear angular stepping. For column `i` of `N` columns:

```text
rayAngle = facing + FOV/2 - ((i + 0.5) / N) * FOV
```

The direction is stored as unit `cos(rayAngle), sin(rayAngle)`. DDA distances are
converted to perpendicular camera depth with `cos(rayAngle - facing)`. Floor and
roof casting perform the inverse conversion when walking along a ray.

The cosine correction means this is not the classic uncorrected Wolfenstein
fisheye bug: facade height and stored depth are based on perpendicular distance.
However, horizontal sampling is still cylindrical while every projected overlay
uses rectilinear pinhole projection:

```text
screenX = centreX - side / forward * projectionScale
```

Those models agree at the centre and view edges but disagree between them. With
the current 1.15-radian horizontal FOV, the maximum angular mismatch is about
1.50 degrees around the quarter-screen positions. That is approximately 2.7
columns at 120 columns, 4.1 columns at 180, and 5.5 columns at 240.

Consequences:

- height-field facades and projected roads/labels can disagree away from centre;
- horizontal sampling density is uneven for a pinhole display;
- long flat facades can bow or change width as the camera turns;
- higher resolution makes the mismatch more visible in cell units;
- small camera rotations change which raster cells occupy mismatched columns,
  contributing to shimmer.

### Recommended camera-plane model

For a normalized column coordinate `u` in `[-1, 1]`, use:

```text
forward = (cos(facing), sin(facing))
right   = (sin(facing), -cos(facing))
plane   = right * tan(FOV / 2)
ray     = forward + u * plane
```

The unnormalized ray's forward component is exactly one. Normalizing it for the
existing unit-ray DDA and retaining the reciprocal length as the perpendicular
depth factor allows the raycaster to change without rewriting the DDA. It also
makes each ray the inverse of the projection already used by roads, sprites,
aircraft, signs, and labels.

Mathematical tests should pin centre direction, edge FOV, symmetry, projection
round-trip, perpendicular depth, and a planar facade's stable screen-space depth.

### Existing skyline and vertical visibility

The renderer does not terminate at the first opaque cell. It walks front-to-back
and maintains the top of the vertically covered interval for each column. A
short near building covers the lower rows; a taller distant building can still
paint above it. Roofs are solved analytically as horizontal planes, so elevated
views expose roofs and do not create seams at facade boundaries.

This already provides the main result requested by "multiple depth intersections"
without storing an unbounded hit list. Vegetation promotes a column to a small
bit mask because canopies contain holes. The scalar coverage invariant remains
valid for opaque height-field buildings.

It should be preserved until geometry gains non-bottom-anchored intervals such
as bridges, arches, overhangs, or interior windows. At that point a bounded set
of visible vertical intervals is appropriate. Replacing the current watermark
with a generic hit list now would add cost without adding skyline correctness.

### Existing LOD

Some useful LOD already exists:

- facade windows collapse to a brightness ramp when a floor projects below
  roughly 1.25 rows;
- cars and pedestrians select three sprite templates by projected height;
- agents are distance-culled;
- fog and early coverage termination bound DDA work.

Missing pieces are explicit near/far material policy, spatial filtering for road
and junction layers, street-furniture culling, a distant skyline tier, and a
quality controller driven by measured frame cost.

### Camera movement

Mouse delta currently modifies camera angle and pitch immediately. Arrow-key yaw
also writes directly to the current angle. There is no target orientation or
frame-rate-independent smoothing. A target/current split is compatible, but it
must preserve a fast response and reset cleanly on city load and shared-camera
restore. Pitch should eventually become an angular camera value; changing that
in the camera-plane patch would broaden its risk unnecessarily.

## 3. Current performance baseline

### Reference machine

- Lenovo Tiny-class system
- Intel Core i5-7500T, 4 cores, 2.70 GHz base / 3.30 GHz maximum
- Intel HD Graphics 630 integrated GPU
- 16 GiB RAM
- Node.js 22.22.0
- baseline commit `57f7fd2`

The existing lint and all 15 hermetic test files pass. Total test-gate time was
about 13 seconds; collision and lighting tests account for most of it.

### Steady-state procedural benchmark

The existing renderer was warmed for 20 frames and measured for 120 frames.
Values are milliseconds per frame. "Street pass" is road projection, sorting,
rasterization, and junction drawing; it is not network or OSM load time.

| Resolution | Simulation median / p95 | Raycast median / p95 | Street pass median / p95 | Measured subtotal |
| --- | ---: | ---: | ---: | ---: |
| 120 x 54 | 0.279 / 0.477 | 1.615 / 1.864 | 6.102 / 6.814 | 8.002 |
| 160 x 72 | 0.252 / 0.437 | 2.352 / 2.725 | 6.424 / 7.944 | 9.036 |
| 180 x 80 | 0.217 / 0.316 | 2.690 / 3.068 | 6.299 / 7.527 | 9.214 |
| 240 x 108 | 0.279 / 0.507 | 3.985 / 4.382 | 6.574 / 7.780 | 10.848 |

Per-frame `world.sample()` counts in the same fixed scene were 26,742; 37,260;
42,636; and 59,905 respectively. The street pass performs no height-field
samples; its nearly constant cost comes from 294 roads and 21,609 junctions.

### Composition submission baseline

The hermetic Canvas stub measures JavaScript batching/submission work, not the
browser's actual raster/GPU cost. It exposes the number of Canvas calls that a
real browser must service.

| Mode | Resolution | JS compose median / p95 | Canvas calls |
| --- | ---: | ---: | ---: |
| GLYPH | 120 x 54 | 0.172 / 0.282 | 853 `fillText` |
| GLYPH | 180 x 80 | 0.324 / 0.460 | 1,652 `fillText` |
| GLYPH | 240 x 108 | 0.693 / 0.953 | 3,333 `fillText` |
| BLOCK | 120 x 54 output | 0.275 / 0.314 | 1,455 `fillRect` |
| BLOCK | 180 x 80 output | 0.421 / 0.672 | 3,845 `fillRect` |
| BLOCK | 240 x 108 output | 0.701 / 0.924 | 5,512 `fillRect` |

### Baseline limits

The current application only exposes rolling FPS. It does not separately expose
simulation, raycast, semantic world-query, composition, or browser draw time.
Headless virtual-time FPS is not a valid hardware measurement and is excluded.
There is also no hermetic dense-OSM benchmark fixture. Therefore the first code
slice must add repeatable benchmark scenes and phase instrumentation before an
adaptive controller or WebGL compositor can be justified.

The existing data does support two immediate conclusions:

1. 180 x 80 is computationally plausible for the core CPU renderer on this
   machine, but should not be made a fixed default yet.
2. The global road/junction pass is the current CPU hotspot in the procedural
   reference scene. Raising resolution alone is not the dominant risk.

## 4. Proposed milestone plan

### Milestone A: renderer foundation

1. Make local development portable and make owner-hosted endpoints opt-in.
2. Add a reusable benchmark runner, deterministic scenes, phase timings, and
   semantic frame snapshots.
3. Replace linear angular rays with camera-plane rays while preserving the DDA.
4. Add target yaw/pitch with frame-rate-independent critically damped movement.
5. Add resolution profiles and a manual override; only then trial gradual
   automatic scaling.
6. Add a lightweight spatial grid for roads, junctions, labels, and later props.

The spatial grid moves forward from the original milestone list because current
measurements identify the semantic pass as the first hotspot.

### Milestone B: city depth

1. Formalize near/far policies using projected size and measured distance.
2. Retain the current skyline watermark for ordinary height-field buildings.
3. Introduce bounded vertical intervals only when elevated/portal geometry
   requires non-bottom-anchored visibility.
4. Attach provenance to building heights and keep the original OSM tags.
5. Validate roofs and elevated views with deterministic fixtures.

### Milestone C: street richness

1. Add a primitive pseudo-volume contract with stable semantic identity.
2. Ingest explicitly mapped OSM street furniture as observed objects.
3. Generate optional deterministic ambience as simulated objects.
4. Replace flat vehicle cards with cheap oriented primitives while preserving
   the road-graph simulation.
5. Keep pedestrians glyph-first, direction-aware, deterministic, and near-only.

### Milestone D: geographic scale

1. Define geographic chunk coordinates and stable feature IDs.
2. Split OSM loading, preprocessing, and active-world adoption by chunk.
3. Keep an active ring and bounded cache with abortable loads.
4. Recreate deterministic enrichment from absolute chunk identity.

### Milestone E: composition

1. Measure real Canvas submission and browser raster time first.
2. Build a deterministic monospace glyph atlas only if composition is material.
3. Keep the CPU cell buffers canonical and add WebGL2 as a compositor backend.
4. Retain Canvas as the fallback and regression oracle.
5. Drive adaptive quality from rolling phase timings with slow hysteresis.

### Milestone F: interior world

Begin only after the exterior coordinate, height, chunk, identity, and visibility
models are stable. Entrances must preserve observed versus derived provenance.
Interiors are deterministic interpretations. Portal windows reuse the exterior
camera and active simulation; they are not static images. Flying, rooftops,
upper floors, and portal cameras must share one vertical model.

## 5. Risks and tradeoffs

- **Raster truth versus polygon truth:** the height field is fast and robust but
  quantizes irregular footprints. A near polygon renderer may improve identity
  while increasing intersection cost and complexity.
- **Projection regression:** camera-plane rays intentionally change frame output.
  Semantic goldens must distinguish expected projection changes from unrelated
  material or visibility regressions.
- **Camera feel:** smoothing can reduce shimmer but can also add latency. Use an
  exponential/critical response with a short time constant and no overshoot.
- **Resolution pressure:** core ray cost scales with cells, while Canvas call
  count and semantic passes scale differently. One global quality number is too
  crude without phase timings.
- **OSM sparsity:** observed street furniture and height coverage vary. Absence
  must remain unknown, not evidence that an object does not exist.
- **Vertical generality:** bridges, arches, interiors, and portal windows break
  the bottom-anchored height-field invariant. Do not weaken the fast common path
  before a fixture demonstrates the need.
- **Streaming identity:** chunking without authoritative IDs and deterministic
  enrichment would make objects change on reload.
- **Provider ownership:** a convenient default Worker creates a hidden maintenance
  dependency. Forks must start with no inherited infrastructure.
- **WebGL scope creep:** WebGL can efficiently compose glyphs, but moving world
  logic or geometry there would create the conventional 3D engine this project
  explicitly does not want.

## 6. Recommended first implementation

The first engine implementation should be a narrow renderer-foundation slice:

1. remove the public `portbroker` dependency and inherited Worker endpoint;
2. add reusable phase instrumentation and hermetic benchmark scenarios;
3. change only `Camera.buildRays()` to camera-plane ray generation;
4. add mathematical projection tests and deterministic frame snapshots;
5. compare before/after performance and visual semantics before touching LOD,
   resolution, world storage, or composition backends.

This slice fixes a verified mathematical mismatch, preserves the height-field
DDA and every real-data subsystem, and creates the measurements needed for the
rest of Milestone A. It is small enough to review and revert independently.
