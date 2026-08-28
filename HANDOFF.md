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
4. Keep browser-native and portable. Never add credentials, the port broker,
   or local-only tooling to public source, docs, scripts, comments, or tests.
   The public deployment Worker may be named in `ascii-city.config.js`, but
   only behind the official-hostname gate, so a clone or fork inherits no
   service and sends no traffic through the original author's account. That
   URL is not a secret: publishing the Pages site ships it in the bundle
   either way. Treat it as a public, unauthenticated endpoint and keep any
   abuse control in the Worker, never in the client gate.
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

Result: 30 test files, 218 tests passed; lint passed, including `tools/**`.

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



## Most recent session (6)

Agent: Codex, finished by Claude Code

Goal: stop three layers from presenting a distant thing as a local one, and
give the published GitHub Pages deployment a working Worker.

Completed (Codex): narrowed radio locality to a strict 50/150 km boundary in
both `worker/src/index.js` and `src/radio.js`. The old third 300 km tier is
what let a Miami station be announced as Sarasota's local radio; it is gone,
and an empty result now reports `NO LOCAL STATIONS` rather than reaching
further out. Direct discovery reverse-geocodes to country *and* state, queries
the directory state-exact first with a 1000-row limit, then falls back to the
country, and applies the same boundary the Worker does. `RadioPlayer` now takes
injectable `fetchImpl` and `storage`, remembers the chosen station per city,
and shows station distance in the HUD.

Removed the free-text Wikipedia name search (`searchKey`, and the `s:` branch
in `resolve`). A bare building name routinely resolved to a similarly named
feature in another city, and the 30-day cache made that stick; `LS_PREFIX` is
bumped to `3:` to invalidate those entries. Only an explicit OSM
`wikipedia`/`wikidata` tag is trusted now.

Fixed a real crash in `FlockLayer.nearest()`: `const distanceKm = distanceKm(...)`
shadowed the imported helper, so the call threw a `ReferenceError` on every
invocation once a single camera had loaded. `statusOf` now receives the live
camera, so "nearest" means nearest to the viewer rather than to world centre.

Added the official-hostname Worker gate in `ascii-city.config.js`.

Completed (Claude Code): added an early guard so a world without real
coordinates reports `N/A` instead of asking Nominatim about an undefined
position, with a test asserting no request is made. Reconciled standing order 4,
which still forbade exactly what the new config does. Corrected the stale
"24 test files" line. Ignored and removed a stray 1440x900 browser-check
screenshot that was sitting untracked in the repository root.

Validation: `npm run check` passes 28 test files and 212 tests with lint clean.
No benchmark-affecting code changed, so the performance numbers above still
stand. Live-network behavior (real Overpass, real Radio Browser, real DeFlock)
was not exercised; every new test is hermetic.


## Most recent session (7)

Agent: Claude Code

Goal: fix five defects the user hit in the running app: aircraft stuck in SIM,
`B` missing from the on-screen legend, the city input overflowing the HUD, no
way to find ALPR cameras, and radio reporting `UNAVAILABLE`.

Radio was the important one. `RadioPlayer` stored the injected fetch on the
instance, so `this.fetchImpl(url)` called a browser's `fetch` as a method of
the player and every request threw `TypeError: Illegal invocation`. Radio was
therefore dead on both the Worker and the direct path, in every browser, while
every test passed because tests always inject a plain function. The default is
now bound, and a test asserts the binding a browser demands by throwing when
`this` is not the global. Verified in headless Chrome before and after.

Removed Nominatim from the radio path entirely. Radio Browser filters by
`geo_lat`/`geo_long`/`geo_distance` itself, so discovery is one request instead
of two, no longer depends on a rate-limited geocoder that answers 403 under
load, and no longer lets a country-or-state text match decide what is nearby.
Also collapsed the 50/150 km ladder to the single 150 km boundary: results are
sorted nearest-first and carry their distance, so the nearer tier only hid
usable stations. Sarasota went from 1 station to 12.

Aircraft: adsb.lol answers 403 to a request with no User-Agent, and the Workers
runtime sends none, so the proxy had been failing since it was deployed. Adding
the header exposed the real limit: adsb.lol answers 429 and adsb.fi 403 to
Cloudflare's shared egress, and OpenSky drops the connection (522). The Worker
now tries all three, maps OpenSky's SI state vectors onto the `ac` contract the
client already reads, and returns which upstream refused instead of an empty
sky the client would draw as clear air. The same Worker run on an ordinary
connection is accepted; local `wrangler dev` returned 5 real aircraft.

Added a runtime Worker override, `?worker=<url>` in the query or the view hash,
remembered per browser. This is what makes local development reach live
aircraft and cameras without any fork inheriting a service.

Camera visibility: the HUD now gives the nearest camera's compass point as well
as its distance, matching the aircraft layer, because one ground glyph at a
distance is otherwise unfindable. Completed the on-screen legend, which was
missing `B`, `L`, `Y`, `G`, and `H`, and grouped it. The city row overflowed
because a flex item will not shrink below its content: the select now has
`min-width: 0`, the row wraps, and free-text entry moved to its own labelled
row so it is visibly a place to type a city.

Validation: `npm run check` passes 30 test files and 218 tests with lint clean.
Verified in headless Chrome at 1440x900 against the offline Demo City with a
local Worker: `air traffic LIVE - 16 - nearest DAL520 WSW 3.5 km`,
`cameras LIVE - 1815 - nearest 0.5 km N`, `radio READY - WQHT Hot 97`,
`weather Overcast - 21C`. The Worker was redeployed three times during this
work; the live aircraft limit above is a property of the upstreams, not a bug
left in the code.


## Next recommended work

1. Decide what live aircraft should say on the published site. The upstreams
   refuse Cloudflare's egress, so the Pages deployment can only offer SIM. The
   options are a proxy on an accepted address, an upstream with credentials, or
   a HUD state that names the limit instead of quietly falling back.
2. Decide whether the published Worker needs an abuse control; it is a public
   unauthenticated endpoint and the hostname gate is client-side only.
3. Browser-test Demo City and a reachable real city across at least three tile
   widths; record rebuild latency, heap growth, provider request counts, camera
   continuity, traffic continuity, and frame p95 on the reference machine.
4. Replace rebuild-based streaming with packed multi-chunk storage only if those
   measurements show visible stalls, unbounded memory, or frame-budget failures.
5. Author and validate the near/mid/far surface vocabularies before enabling
   `surfaceTier` in the renderer.
6. Add a live traffic-congestion provider only after streaming validation, using
   the existing provider-pluggable worker pattern.
7. Update this handoff after each coherent commit and hand the next agent the
   exact test/benchmark command and next file to inspect.

## Do not accidentally undo

- Do not restore equal-angle ray stepping.
- Do not store a browser API on an instance and call it as a method. `fetch`
  throws `Illegal invocation` unless `this` is the global, and no Node test
  will catch it. Keep the bound default in `RadioPlayer`.
- Do not reintroduce a geocoder into the radio path, and do not restore a
  ladder of radii. Radio Browser filters by position, and a nearer tier only
  hides usable stations inside the same stated boundary.
- Do not drop the aircraft `User-Agent`; adsb.lol answers 403 without one.
- Do not collapse the aircraft upstream list to one provider, and do not turn
  a refused upstream into an empty `ac` array.
- Do not restore the third 300 km radio tier or the bare-name Wikipedia search.
  Each one presented another city's content as this city's, and the Wikipedia
  cache made it persist for 30 days.
- Do not shadow the imported `distanceKm` inside `FlockLayer.nearest()`; the
  block-scoped redeclaration threw on every call with a camera loaded.
- Do not remove the official-hostname gate in `ascii-city.config.js`. A clone
  or fork must still inherit no service.
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
