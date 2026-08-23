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
- Uniform semantic spatial hashes now filter roads, junctions, and labels by
  the camera's active envelope.
- Cinematic mode has an adaptive quality controller with manual-capable levels
  and gradual frame-time hysteresis.
- Bounded OSM streaming now prefetches neighboring tiles, deduplicates elements,
  preserves camera geographic position across rebuilds, and prunes distant
  tiles.
- Live weather, aircraft, radio, astronomy, OSM, traffic, signs, signals, and
  labels remain in the main application.

### Partially complete

- Cinematic composition is Canvas 2D on the main thread; no GPU compositor is
  active yet.
- Streaming currently rebuilds a merged `OsmWorld` after tile completion; it is
  not yet a packed multi-chunk typed-array world.
- Cars and pedestrians have basic distance/template LOD; traffic and semantic
  layers still need broader spatial filtering.
- Traffic and world-bound simulation are reinitialized after a streamed merge.

### Not started

- Packed multi-chunk OSM storage without whole-world rebuilds.
- Traffic/signals/landmark filtering on the shared spatial-query contract.
- Explicit near/mid/far building and semantic policies.
- Mapped pseudo-volume street furniture and provenance-aware ambience.
- Optional WebGL2 glyph atlas compositor.
- Deterministic entrances, interiors, portal windows, and unified floor/roof
  interaction.

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

Latest benchmark from the current branch:

```text
Dense downtown          180x80   sim .20  ray 1.53  world 18.19  compose .29  frame p95 24.69 ms
Low-density suburb      180x80   sim .41  ray 3.64  world 19.17  compose .25  frame p95 27.48 ms
Street-level detail     160x72   sim .23  ray 2.49  world 16.53  compose .22  frame p95 24.34 ms
Overlapping skyline     180x80   sim .16  ray 4.19  world 17.13  compose .27  frame p95 27.05 ms
Integrated-GPU stress   240x216   sim .13  ray 6.74  world 19.05  compose .53  frame p95 32.98 ms
```

Canvas 2D does not expose portable GPU timing. The semantic/world pass is the
current hotspot; composition is not yet the reason to require WebGL.

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

## Most recent session

Agent: Codex

Goal: create a standing-orders handoff and continue engine-next work.

Completed: created this `HANDOFF.md`; added adaptive cinematic quality,
semantic spatial filtering, bounded OSM streaming, hermetic tests, and verified
the next sequence.

This session commits: `b0abab5`, `c55fba7`, and `818d3c4`.
Earlier commits: `a6541d6`, `26bbfd9`, `95f890a`, `31f88de`, `e645cdd`,
`cb10864`.

## Next recommended work

1. Apply the spatial-query contract to traffic, signals, landmarks, and future
   street objects; verify world-query time falls in the benchmark.
2. Coalesce streamed world rebuilds and preserve traffic/simulation state when
   a neighboring tile arrives.
3. Replace rebuild-based streaming with packed multi-chunk storage only if
   measurements show rebuilds are visible or exceed the frame budget.
4. Update this handoff after each coherent commit and hand the next agent the
   exact test/benchmark command and next file to inspect.

## Do not accidentally undo

- Do not restore equal-angle ray stepping.
- Do not restore hard-coded original Worker traffic.
- Do not make live API calls required by automated tests.
- Do not remove the road/sign depth tests or semantic snapshots.
- Do not make cinematic mode bypass the canonical cell buffer.
- Do not turn streaming failures into fabricated geometry; keep the current
  world and report the unavailable neighbor.
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
