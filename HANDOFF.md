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
- One unified semantic index now queries roads, junctions, labels, traffic
  signals, and landmarks in a single camera-envelope traversal; the reference
  `ProceduralWorld` uses the same contract. Traffic spawning picks a nearby
  road-graph edge via a spatial index instead of scanning every edge.
- Cinematic mode has an adaptive quality controller with manual-capable levels
  and gradual frame-time hysteresis.
- Bounded OSM streaming now maintains a replaceable 3x3 active window, requests
  the centre tile, cancels stale work, coalesces rebuilds, deduplicates active
  elements, and prunes the initial region after the camera travels away.
- Streamed rebuilds preserve camera geography, compatible graph-routed cars,
  aircraft/weather observations, radio playback/discovery, and the city time
  zone. Provider polling is not restarted for each neighboring tile.
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
- Cars now use oriented pseudo-volumetric cell geometry with stable seeded
  profiles, explicit near/mid/far LOD, lane-width placement, per-face depth,
  day/night shading, and directional lights. Pedestrians remain template-based.
- Packed-world rebuild latency and browser memory behavior still need validation
  across several tile widths on the reference machine.

### Not started

- Packed multi-chunk OSM storage without whole-world rebuilds.
- Turn `surfaceTier` on in `groundGlyph`/`groundColour` (flip the one-line
  `selectTier` switch in surface.js) once near/mid/far glyph bands are authored
  for each surface type, so grass/asphalt/crosswalk textures degrade with
  distance and viewing angle.
- Pluggable terrain provider (DEM: Copernicus GLO-30 worldwide, USGS 3DEP for
  the US) draped under OSM roads and buildings, with buildings kept vertical
  (base elevation only) and roads conformed to the surface. Terrain is
  DERIVED/SIMULATED unless from a real DEM; the offline demo uses a synthetic
  `DemoTerrain`.
- Rendered traffic-signal heads are DISABLED by default (`TrafficLights.on =
  false`): the mast-mounted heads read poorly at the engine's scale/resolution
  (clustered, flickering, wrong proportions). The signal *timing* still drives
  traffic via `traffic-signals.js`; the heads stay suppressed until a cleaner
  representation (e.g. painted stop-bars on the road, not poles) is designed.
  Do not re-enable the pole renderer without reworking it.
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

Result: 24 test files passed; lint passed, including `tools/**`.

Known failing tests: none.

## Performance status

Latest benchmark is the median of three runs with 240 measured frames and 30
warmup frames. It includes per-layer semantic timings and an irregular OSM demo
scenario:

```text
Dense downtown          180x80   ray 1.93  world 3.41  frame p95 9.84 ms
Low-density suburb      180x80   ray 4.26  world 3.34  frame p95 11.56 ms
Street-level detail     160x72   ray 2.88  world 2.95  frame p95 9.16 ms
Overlapping skyline     180x80   ray 4.83  world 2.93  frame p95 12.36 ms
Integrated-GPU stress   240x216  ray 8.40  world 3.20  frame p95 14.84 ms
Irregular OSM demo      180x80   ray 2.02  world 0.13  frame p95 5.13 ms
```

Canvas 2D does not expose portable GPU timing. The unified query reduced the
procedural candidate set from 21,609 junctions to about 1,156 and the world-pass
median from roughly 21-23 ms to 2.9-3.4 ms. Composition is not a reason to
require WebGL. These Node numbers do not replace browser frame pacing.

## Known problems

- Streaming can expose a temporary edge while the centre or neighbor tile is
  pending or unavailable.
- Cinematic quality scaling has a visible adaptive/fixed control but still needs
  browser validation on the reference integrated GPU.
- Camera orientation still responds directly to input rather than a smoothed
  target/current model.
- OSM and procedural worlds do not share a geographic streaming abstraction.
- Streaming neighbors can still expose a temporary edge while public Overpass
  requests are pending or unavailable.
- Overpass is frequently overloaded/unreachable (this sandbox has no reliable
  egress; all four mirrors timed out). The offline Demo City is the guaranteed
  first-load path; real OSM cities depend on a reachable Overpass mirror.
- Rebuild-based streaming still constructs one flat `OsmWorld`; browser travel
  and memory measurements must decide whether packed chunks are justified.

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

## Most recent session (3)

Agent: opencode

Goal: remove the broken mast-mounted traffic-signal heads and clean the road
surface (creative-liberty pass on the cartographic layer).

Completed: disabled `TrafficLights` by default (`on = false`) so no signal
poles are drawn; the signal *timing* still drives traffic via
`traffic-signals.js`. Made roads clean pavement in `surface.js` (the `T.ROAD`
glyph is now a space, not the `'.'` asphalt speckle) so the floor no longer
competes with the street-line renderer's markings; sidewalks, crosswalks, grass,
water, and plaza textures are unchanged. Regenerated the camera-plane snapshot
fixture (depth/kind hashes identical; only the road glyph layer changed).
Updated `signal-render.test.js` to pin the disabled-by-default contract and the
timing guard. A following cleanup commit removed the rendered crosswalk bands;
they read poorly at this scale and remain deferred with painted stop-bars.
Tests: 149 pass, lint clean.

## Most recent session (4)

Agent: Codex

Goal: complete the stable Engine Next milestone through bounded streaming,
state-preserving rebuilds, a shared semantic query, and stronger quality gates.

Completed: made the streaming seed replaceable, included the current centre in
the 3x3 wanted set, cancelled obsolete work, rejected late results, rebuilt
deduplication from active chunks, and coalesced updates with a 250 ms trailing
window. Added stable directed road-edge keys and traffic rebinding; streamed
world replacement now reprojects aircraft/weather without resetting their last
good observations and does not restart radio or time-zone discovery.

Replaced per-layer semantic hashes with one tagged index and one frame query.
The benchmark exposed that `ProceduralWorld` had never built the old spatial
index; wiring it into the unified contract cut world-query p50 from roughly
21-23 ms to 2.9-3.4 ms. Added per-layer/candidate benchmark output and the
offline irregular OSM scenario. Added a visible cinematic quality control,
background-tab sampling guard, a pure dev-server identity handler test, mocked
Worker success/failure tests, and lint coverage for tools. Fixing the resulting
lint errors also corrected the procedural map preview's vertical crop origin.

Validation: `npm run check` passes 24 test files. Three runs of
`npm run benchmark -- --frames 240 --warmup 30` produced the medians recorded
above. Browser/live-network validation was not available in the headless
sandbox.

## Most recent session (5)

Agent: Codex

Goal: replace flat traffic cards with original pseudo-volumetric vehicles suited
to the existing CPU cell renderer and real OSM road graph.

Completed: added `src/render/vehicles.js`, which projects a body prism, narrower
cabin frustum, contact shadow, wheels, and directional lights through the
canonical glyph/colour/depth buffers. GLYPH mode uses face-specific surface
characters; BLOCK/CINEMATIC use the same geometry as shaded solid cells. Added
stable sedan/hatch/SUV/van profiles, muted paint variation, lane-width-aware
offsets, length-aware headway, brake state, and smoothed visual position/heading
through graph turns. Rich detail is capped at the nearest eight cars; mid and far
LOD collapse deterministically, with a two-cell daylight silhouette and paired
night lights.

Added developer-only `traffic.setSeed`, `setDensity`, `setDetailMode`,
`renderStats`, and an initial `trafficSeed=` hash parameter. Added hermetic
vehicle profile, LOD, glyph/block structure, lighting, depth-occlusion, lane,
seed, and smoothing tests. Browser inspection covered close roadside, along-road,
intersection, elevated, day/night, approaching/receding, GLYPH/BLOCK, and 1440 x
900 plus 960 x 600 views using the offline OSM-format Demo City. Full results and
limits are documented in `docs/engine-next/VEHICLES.md`.

Validation: `workspace-quality-gate` passes 27 test files and lint; `npm audit
--audit-level=high` reports zero vulnerabilities. Final 120-frame benchmark p95:
street detail 9.99 ms, integrated BLOCK stress 16.34 ms, and irregular OSM demo
5.33 ms. Headless browser phase samples at close traffic poses remained roughly
3.4-6.1 ms total engine work; Canvas GPU time remains unavailable.



## Next recommended work

1. Browser-test Demo City and a reachable real city across at least three tile
   widths; record rebuild latency, heap growth, provider request counts, camera
   continuity, traffic continuity, and frame p95 on the reference machine.
2. Replace rebuild-based streaming with packed multi-chunk storage only if those
   measurements show visible stalls, unbounded memory, or frame-budget failures.
3. Author and validate the near/mid/far surface vocabularies before enabling
   `surfaceTier` in the renderer.
4. Add a live traffic-congestion provider only after streaming validation, using
   the existing provider-pluggable worker pattern.
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
- Do not pin the initial streaming extract or accept late results from obsolete
  centers; both defeat the bounded active-window contract.
- Do not call full provider `setWorld()` methods during a streamed rebuild. Use
  rebind/reprojection paths so neighboring tiles cannot trigger request storms.
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
