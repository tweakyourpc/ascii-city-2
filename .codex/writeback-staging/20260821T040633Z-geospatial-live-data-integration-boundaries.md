---
title: "Geospatial live-data integration boundaries"
created_at: "2026-08-21T04:06:33.942971+00:00"
type: "pending-writeback"
---

# Summary

Road routing and nearby live services stay truthful only when topology, units, and provider capabilities are normalized at their source boundaries.

# Rules

- Connect OSM roads by shared node ID; never infer a drivable intersection from overlapping geometry because bridges and tunnels cross without connecting.
- Retain OSM way node IDs in cached extracts and bump the cache version whenever topology-bearing fields change.
- Normalize provider units once at ingestion: adsb.lol altitude is feet, ground speed is knots, and point-query radius is nautical miles.
- If an external directory does not document distance search, fetch a bounded geographic candidate set and calculate Haversine distance locally.

# Verify next time

- Test shared-node intersections, non-connected geometric crossings, one-way/access restrictions, signal grouping, and same-lane car headway.
- Smoke-test /whoami and every deployed proxy endpoint through a browser-compatible TLS client.

# Prevents

- Jitter from raster-cell vehicle movement, false bridge junctions, incorrect aircraft scale, and arbitrary radio stations labeled as nearby.

# Look here first

- src/world/roadgraph.js
- worker/src/index.js
- test/roadgraph.test.js
