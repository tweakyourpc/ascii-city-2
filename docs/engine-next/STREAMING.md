# Geographic OSM streaming

`src/world/streaming.js` keeps the existing `OsmWorld` typed-array renderer
intact while loading neighboring geographic regions ahead of the camera.

The manager uses approximately 512 m tiles, a 3x3 active neighborhood, two
concurrent fetches, element IDs for deduplication, and abortable requests. A
successful tile emits a merged snapshot. `main.js` rebuilds `OsmWorld` from
that snapshot while converting the current camera position through geographic
latitude/longitude, so the user does not jump when the local projection grows.

This is intentionally a first streaming slice, not a server-backed global map:

- Overpass remains the direct, cacheable transport.
- A failed neighbor leaves the current world visible and reports the degraded
  edge.
- The active cache is bounded; distant tiles are pruned.
- Rebuilds preserve OSM element identity but currently reinitialize traffic and
  other world-bound simulation layers.
- Automated tests use a fake chunk fetcher and never call Overpass.

The next refinement is to apply the same spatial-query contract to traffic,
signals, landmarks, and street objects, then measure whether rebuilding should
be coalesced or replaced with a packed multi-chunk world store.
