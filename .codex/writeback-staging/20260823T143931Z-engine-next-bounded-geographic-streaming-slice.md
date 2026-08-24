---
title: "Engine-next bounded geographic streaming slice"
created_at: "2026-08-23T14:39:31.608015+00:00"
type: "pending-writeback"
---

# Summary

Added abortable bounded OSM neighbor loading around the active camera region while preserving the existing OsmWorld renderer and camera geographic position.

# Rules

- Streaming failures must preserve the current world; only successful fetched regions may enter the merged snapshot, and all fetched elements must deduplicate by authoritative type/id.
- Camera continuity across a world rebuild must be preserved by converting the current local projection to latitude/longitude before constructing the new projection.

# Verify next time

- Run npm test, npm run lint, restart ascii-city-2.service, and verify GET /whoami on port 8780.

# Prevents

- Do not claim packed multi-chunk storage, traffic continuity, or complete world streaming until those are independently implemented and measured.

# Look here first

- HANDOFF.md; docs/engine-next/STREAMING.md; src/world/streaming.js; test/streaming.test.js
