# Pseudo-volumetric traffic

## Why the previous cars were weak

Cars were camera-facing text cards. A projected height selected one of three
templates, then every visible cell was stretched across a flat rectangle at one
depth. The renderer distinguished only broadside from end-on. Length, roof
depth, face orientation, road contact, and per-component occlusion were absent;
BLOCK mode merely converted the same card into a coloured slab.

## Current model

`src/render/vehicles.js` projects a compact oriented primitive into the same
cell buffers as buildings and streets:

- a dark road-contact quad;
- a tapered lower body prism;
- a narrower cabin frustum with dark window faces and a painted roof;
- distinct front, rear, side, and top surface treatment;
- paired headlights or taillights, optional brake-light lift, and a restrained
  near-headlight road cue;
- wheel/contact cells for nearby vehicles.

Each face is triangulated in screen space. Perspective-correct inverse depth is
interpolated per cell before writing through `Screen.setDepth()`. Buildings can
therefore hide cars, cars cover road markings, and nearer vehicle faces cover
farther components without a second depth system.

GLYPH mode assigns semantic surface characters (`#`, `@`, `%`, `:`, `^`, `=`)
instead of sampling a fixed picture. BLOCK and CINEMATIC modes consume the same
geometry and use the per-face colours as clean solid silhouettes.

## Stable variation and movement

Every car receives a seeded, persistent profile at spawn: sedan, hatchback,
SUV, or van proportions; muted paint; roof/cabin proportions; and a small
condition/brightness variation. Profile construction is not repeated per frame.

Bidirectional traffic is offset by one quarter of the mapped carriageway width,
clamped to a safe range. Single-lane one-way traffic stays on the centreline.
The graph remains authoritative for movement and signals. A short exponential
visual response smooths heading and position through segment changes, while
length-aware headway prevents differently sized cars from overlapping.

## LOD and performance policy

- Near: within 16 cells or at least 4.2 output rows. Full body/cabin geometry,
  shadows, wheels, lights, and near-night road cues.
- Mid: at least 1.15 output rows and within 68 cells. Body, cabin, directional
  faces, shadow, and lights; wheel detail is removed.
- Far: stable two-cell travel-axis silhouette. At night, paired white or red
  light identity survives after face geometry disappears.

Only the nearest eight visible cars may use rich near detail. Cars outside the
camera cone, behind the near plane, beyond the renderer distance, or behind
existing depth are rejected. The normal simulation cap remains 26 cars. The
renderer exposes `traffic.renderStats` for the current simulated/visible count,
LOD mix, and vehicle cells written.

## Developer-only showcase controls

These controls are available through the browser console and add no normal UI:

```js
traffic.setSeed(20260827)     // respawn repeatable routes and profiles
traffic.setDensity(1.35)      // 0.25x to 2.3x; hard-capped at 60 cars
traffic.setDetailMode('near') // auto | near | mid | far
traffic.renderStats
```

`trafficSeed=20260827` may also be included in the initial URL hash. Time of day
is already repeatable through the existing simulated clock and share hash.

## Offline regression poses

The bundled OSM-format Demo City avoids provider variability:

- Down Elm Avenue: `x=249.2`, `y=230`, `z=1.65`, `a=1.571`, `p=0`.
- Canal/Elm intersection: `x=242`, `y=280`, `z=1.65`, `a=0`, `p=0`.
- Elevated avenue: `x=249.2`, `y=230`, `z=15`, `a=1.571`, `p=11`.

Day regression instant: `1787846400000` (2026-08-27 12:00 EDT). Night
regression instant: `1787893200000` (2026-08-28 01:00 EDT).

## Honest limits

- The graph has one simulated stream per directed edge, not a separate stream
  for every OSM lane in a multi-lane carriageway.
- Intersection motion is visually eased, not physically simulated with turning
  radii, suspension, steering, or wheel rotation.
- Very distant daylight cars intentionally become two-cell silhouettes.
- The model remains cell geometry, not a mesh or imported vehicle asset.
