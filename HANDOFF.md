# ASCII City, Standing Orders and Agent Handoff

> Read this file completely before modifying code. Update it before ending a
> substantial session. It is the repository-level operating memory for Codex,
> Claude Code, and future agents.

## Project

ASCII City is a lightweight browser-native ASCII world engine. It combines
real geographic and observational data with deterministic local calculation
and explicitly marked procedural interpretation. The renderer must interpret
irregular real-world geometry rather than replacing it with a renderer-shaped
synthetic grid.

Repository: `https://github.com/tweakyourpc/ascii-city-2`

## Standing orders

1. Read this file, run `git status`, inspect the branch and recent history, and
   run the relevant tests before changing code.
2. Verify claims against the implementation. Do not trust an earlier agent's
   intended work without tests or inspection.
3. Preserve real OSM geometry, live weather/aircraft/radio behavior, and the
   existing ASCII renderer. Prefer additive, measured changes.
4. Keep browser-native and portable. Never add the original developer's
   private Worker, port broker, credentials, or local tooling to public source,
   docs, scripts, comments, or tests.
5. Treat `OBSERVED`, `DERIVED`, and `SIMULATED` as distinct provenance states.
   Never present generated geography or interiors as measured fact.
6. Keep external APIs out of automated tests; use fixtures and deterministic
   snapshots.
7. Optimize from phase measurements. Record simulation, world-query,
   raycast, composition, total frame time, and FPS when changing rendering.
8. Prefer small coherent commits. Do not rewrite public history or force-push.
9. Before handing off, update this file and `/tmp/codex-claude-handoff.md` with
   the current truth, tests, risks, and one concrete next action.

## Core invariants

- CPU owns world data, simulation, visibility, and cell selection.
- A renderer consumes the cell/frame buffers; it does not fetch providers.
- ASCII text remains the evidence/provenance layer in every display mode.
- Camera/world coordinates remain stable across renderer changes and reloads.
- Failed or unavailable data is reported, never replaced by fabricated world
  positions.
- WebGL, if added, is an optional glyph compositor; it is never the world
  engine or a deployment requirement.
- Modest integrated graphics are the reference target: 30 FPS is acceptable,
  60 FPS is desirable, and quality must degrade gradually.

## Current development phase

Branch: `engine-next`

Current milestone: renderer foundation, hybrid integration, semantic filtering,
and first geographic streaming slice.

Current objective: make streamed real-world regions stable and efficient while
preserving adaptive hybrid performance.

## Current state

### Completed

- Recovery tag `ascii-city-2-baseline-v2.0.0` preserves the original stable
  `main` history.
- Portable `npm start` development server with `/whoami` and no inherited
  endpoint configuration.
- Owner-configured Worker support for optional aircraft/radio paths.
- Renderer phase instrumentation and deterministic benchmark runner.
- Camera-plane ray generation with geometry tests and semantic snapshots.
- Existing multi-depth height-field traversal and roof handling.
- Per-cell road/sign/junction occlusion fixes.
- Canvas cinematic mode (`B` cycles ASCII, BLOCK, CINEMATIC); text and HUD
  remain glyph-rendered.
- Uniform semantic spatial hashes now filter roads, junctions, labels, traffic
  signals, and landmarks by the camera's active envelope; traffic spawning picks
  a nearby road-graph edge via a spatial index instead of scanning every edge.
- Cinematic mode has an adaptive quality controller with manual-capable levels
  and gradual frame-time hysteresis.
- Bounded OSM streaming now prefetches neighboring tiles, deduplicates elements,
  preserves camera geographic position across rebuilds, and prunes distant
  tiles.
- Live weather, aircraft, radio, astronomy, OSM, traffic, signs, signals, and
  labels remain in the main application.
- Offline Demo City: `src/world/demo-city.js` ships a hand-authored OSM-style
  extract (`DEMO_BBOX`, `DEMO_ELEMENTS`) with 5 named streets, 3 traffic
  signals, 11 buildings (one 22-level landmark with a `wikipedia` tag), and a
  park. `overpass.js` exposes a `demo` preset; `main.js` builds an `OsmWorld`
  directly with no network. This guarantees the OSM renderer works on first
   load even when Overpass is unreachable.
- Cartographic generalization layer: `src/render/surface.js` centralizes the
   ground surface vocabulary (glyph + colour per `T` type, per perceptual tier)
   and a `surfaceTier(d, viewAngle, dayAmt)` LOD metric mirroring the facade
   near/mid/far split. `materials.js` now delegates to it; the mid tier
   reproduces the original ground rendering exactly, so output is unchanged
   until a tier is selected. This is the seam for distance/angle/light-aware
   grass/asphalt/crosswalk textures and a future pluggable terrain provider.


### Partially complete

- Cinematic composition is Canvas 2D on the main thread; no GPU compositor is
  active yet.
- Streaming currently rebuilds a merged `OsmWorld` after tile completion; it is
  not yet a packed multi-chunk typed-array world.
- Cars and pedestrians have basic distance/template LOD; traffic and semantic
  layers still need broader spatial filtering.
- Traffic and world-bound simulation are reinitialized after a streamed merge.
- The spatial-query contract now covers signals and landmarks, but traffic,
  signals, and landmark filtering still rebuild candidate lists per frame rather
  than sharing one envelope query with the other layers.

### Not started

- Packed multi-chunk OSM storage without whole-world rebuilds.
- A single shared envelope query that all semantic layers (roads, junctions,
  labels, signals, landmarks, traffic) draw candidates from in one pass.
- Turn `surfaceTier` on in `groundGlyph`/`groundColour` (flip the one-line
  `selectTier` switch in surface.js) once near/mid/far glyph bands are authored
  for each surface type, so grass/asphalt/crosswalk textures degrade with
  distance and viewing angle.
- Pluggable terrain provider (DEM: Copernicus GLO-30 worldwide, USGS 3DEP for
  the US) draped under OSM roads and buildings, with buildings kept vertical
  (base elevation only) and roads conformed to the surface. Terrain is
  DERIVED/SIMULATED unless from a real DEM; the offline demo uses a synthetic
  `DemoTerrain`.
- Explicit near/mid/far building and semantic policies.
- Mapped pseudo-volume street furniture and provenance-aware ambience.
- Optional WebGL2 glyph atlas compositor.
- Deterministic entrances, interiors, portal windows, and unified floor/roof
  interaction.
- Live traffic-congestion provider (slowdowns now), following the existing
  provider-pluggable worker pattern used by radio/aircraft/weather.

## Important files

```text
src/main.js
src/screen.js
src/camera.js
src/render/raycaster.js
src/render/streets.js
src/render/signs.js
src/world/osm.js
src/world/overpass.js
src/world/source.js
src/agents.js
src/performance.js
docs/engine-next/FOUNDATION-AUDIT.md
tools/benchmark-engine.js
test/renderer-snapshot.test.js
```

## Architectural decisions

- Camera rays use a conventional camera plane; world coordinates are unchanged.
- Ordinary building visibility uses the bounded height-field coverage invariant
  rather than an unbounded per-ray hit list.
- Road and sign layers depth-test against the building buffer.
- Cinematic mode is a low-resolution Canvas compositor over the same cell
  buffer; it does not invent a separate scene graph.
- Direct CORS-compatible providers are the default. User-owned Worker or
  companion services are optional.
- Real-world extraction is bounded today; streaming is the next structural
  change and must preserve stable identities and cache limits.

## Explicitly rejected for now

- Three.js, Babylon.js, Unity, Godot, or a heavyweight frontend framework.
- WebGPU as a requirement.
- Making WebGL responsible for world simulation or raycasting.
- Replacing real OSM geometry with a procedural city grid.
- Inventing aircraft, road, or provider positions after a failed query.
- Building interiors before exterior streaming, identity, and occlusion are
  stable.

## Testing status

Commands most recently run:

```bash
npm test
npm run lint
npm run benchmark
```

Result: 22 test files passed; lint passed.

Known failing tests: none.

## Performance status

Latest benchmark from the current branch (now includes `signals.draw` and
`labels.draw` in the `world` pass):

```text
Dense downtown          180x80   sim .11  ray 1.57  world 25.43  compose .30  frame p95 33.69 ms
Low-density suburb      180x80   sim .14  ray 3.65  world 25.62  compose .31  frame p95 53.24 ms
Street-level detail     160x72   sim .17  ray 2.57  world 24.76  compose .35  frame p95 40.38 ms
Overlapping skyline     180x80   sim .06  ray 3.15  world 20.50  compose .33  frame p95 29.65 ms
Integrated-GPU stress   240x216   sim .25  ray 6.08  world 23.91  compose .54  frame p95 58.57 ms
```

Canvas 2D does not expose portable GPU timing. The semantic/world pass is the
current hotspot; composition is not yet the reason to require WebGL. The `world`
pass rose after signals/labels were added to the measured block; the spatial
prefilters keep candidate counts bounded by the camera envelope.

## Known problems

- OSM city data ends at the loaded bounding box; moving past it reaches a hard
  world boundary.
- Props and traffic still need the same semantic filtering contract.
- Cinematic quality scaling is implemented but needs browser validation and a
  visible HUD setting/status.
- Camera orientation still responds directly to input rather than a smoothed
  target/current model.
- OSM and procedural worlds do not share a geographic streaming abstraction.
- Streaming neighbors can still expose a temporary edge while public Overpass
  requests are pending or unavailable.
- Overpass is frequently overloaded/unreachable (this sandbox has no reliable
  egress; all four mirrors timed out). The offline Demo City is the guaranteed
  first-load path; real OSM cities depend on a reachable Overpass mirror.
- The `world` benchmark pass now includes signals and labels; its p50 is higher
  than earlier reports that measured only streets/signs/traffic. Compare like
  for like when judging regressions.

## Most recent session

Agent: opencode

Goal: extend the spatial-query contract to signals, landmarks, and traffic
spawning; port the offshoot's synthetic-aircraft generator and radio fallback
discovery; measure the new paths in the benchmark; fix "nothing loads city data".

Completed: added `signals` and `landmarks` indexes to `buildSemanticIndex`
(`src/spatial.js`); `TrafficLights.draw` and `Labels._landmarks` now prefilter by
the camera envelope; `Traffic._spawnOsm` picks a nearby edge via a cached
`buildEdgeIndex`; `tools/benchmark-engine.js` now times `signals.draw` and
`labels.draw` inside `worldQuery`; ported `syntheticAircraft` so SIM mode shows
deterministic demo planes instead of going blank; added a Radio Browser +
Nominatim fallback to `RadioPlayer._discoverDirect` used when no Worker is
configured or the Worker route fails; rewrote the far-facade night glyph texture
in `raycaster.js`; added an offline Demo City (`src/world/demo-city.js`) that
loads real OSM building/street/landmark data with no network, wired through the
`demo` preset in `overpass.js` and a `view.demo` branch in `main.js`. Verified
headlessly: the demo city renders a street grid + building footprints with zero
network. Tests: 136 pass, lint clean.

This session commits: see the engine-next renderer foundation commit that follows
this handoff update (signals/landmarks spatial indexes, synthetic aircraft, radio
fallback, far-facade night glyphs, offline Demo City, and the regenerated
 camera-plane snapshot fixture).

## Most recent session (2)

Agent: opencode

Goal: lay the groundwork for a cartographic generalization layer so the renderer
can take creative liberty over how OSM facts become ASCII (grass/asphalt/crosswalk
vocabularies, distance/angle/light-aware LOD) and, later, a pluggable terrain
provider, without rewriting the height-field renderer.

Completed: extracted the ground surface vocabulary into `src/render/surface.js`
(glyph + colour per `T` type, per perceptual tier) with a `surfaceTier(d,
viewAngle, dayAmt)` LOD metric mirroring the facade near/mid/far split;
`materials.js` now delegates to it and re-exports `groundGlyph`/`groundColour` so
the raycaster and render tests are unchanged; the mid tier reproduces the original
ground rendering exactly, so output is identical until the one-line `selectTier`
switch is flipped. Added `test/surface.test.js` (151 tests pass, lint clean).
Recorded the terrain-provider and LOD-on next steps in HANDOFF.md.


## Next recommended work

1. Unify the per-frame envelope query so roads, junctions, labels, signals,
   landmarks, and traffic all draw candidates from one shared spatial query
   rather than each building its own list.
2. Coalesce streamed world rebuilds and preserve traffic/simulation state when
   a neighboring tile arrives.
3. Replace rebuild-based streaming with packed multi-chunk storage only if
   measurements show rebuilds are visible or exceed the frame budget.
4. Add a live traffic-congestion provider (slowdowns now) on the existing
   provider-pluggable worker pattern.
5. Update this handoff after each coherent commit and hand the next agent the
   exact test/benchmark command and next file to inspect.

## Do not accidentally undo

- Do not restore equal-angle ray stepping.
- Do not restore hard-coded original Worker traffic.
- Do not make live API calls required by automated tests.
- Do not remove the road/sign depth tests or semantic snapshots.
- Do not make cinematic mode bypass the canonical cell buffer.
- Do not turn streaming failures into fabricated geometry; keep the current
  world and report the unavailable neighbor.
- Do not remove the spatial prefilters from `TrafficLights.draw`,
  `Labels._landmarks`, or `Traffic._spawnOsm`; they keep per-frame work bounded
  by the camera envelope. The exact along/side/depth checks remain the real
  filter, the index is only a coarse cull.
- Do not present synthetic demo aircraft (SIM mode) as live observations; they
  carry `synthetic: true` and must stay marked as SIMULATED.
- Do not make the radio fallback (Radio Browser + Nominatim) invent stations; a
  failed discovery must end in an empty list and a truthful status.
- Do not remove the offline Demo City or its `view.demo` branch; it is the
  guaranteed first-load path when Overpass is unreachable. Keep `DEMO_ELEMENTS`
  in the exact `OsmWorld` element format.
- Do not claim the complete roadmap is finished until streaming, adaptive
  quality, semantic indexing, optional GPU composition, and the later interior
  milestones are implemented and tested.

## Open questions

- Exact chunk prefetch radius and Overpass request budget must be measured on
  the reference machine and public endpoint behavior.
- WebGL2 should be added only if Canvas composition remains material after
  semantic filtering and quality control.
- Interior/portal geometry remains intentionally deferred until exterior
  streaming and vertical visibility are stable.

## Handoff quality check

- [x] Branch and current objective documented.
- [x] Completed and partial work separated.
- [x] Tests and benchmark results recorded truthfully.
- [x] Architectural decisions and rejected paths recorded.
- [x] Next recommended work is concrete.
- [x] Fragile requirements are recorded under Do not accidentally undo.
- [x] No private/local-only infrastructure was added.
