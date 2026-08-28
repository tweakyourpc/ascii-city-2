# Geographic OSM streaming

`src/world/streaming.js` keeps the existing `OsmWorld` typed-array renderer
intact while loading neighboring geographic regions ahead of the camera.

The manager uses approximately 512 m tiles, a bounded 3x3 active neighborhood,
two concurrent fetches, element IDs for deduplication, and abortable requests.
The current centre tile is always requested first. Moving to a new centre drops
stale queued work, aborts obsolete requests, and allows the initial region to
leave the cache. Successful tiles are coalesced through a 250 ms trailing window
before `main.js` rebuilds `OsmWorld` from the newest snapshot.

The camera is converted through geographic latitude/longitude during the
replacement, so it does not jump as the local projection changes. Cars rebind
through stable directed edge keys. Aircraft and weather keep their last good
observations and adopt the new projection; radio and time-zone discovery are
not restarted for neighboring tiles.

This is intentionally a first streaming slice, not a server-backed global map:

- Overpass remains the direct, cacheable transport.
- A failed neighbor leaves the current world visible and reports the degraded
  edge.
- The active cache is bounded; distant tiles are pruned.
- Rebuilds preserve OSM element identity and compatible graph-routed traffic.
- Automated tests use a fake chunk fetcher and never call Overpass.

The next refinement is browser validation of rebuild latency and memory while
crossing several tile widths. Replace rebuilding with a packed multi-chunk world
store only if those measurements exceed the frame or memory budget.
