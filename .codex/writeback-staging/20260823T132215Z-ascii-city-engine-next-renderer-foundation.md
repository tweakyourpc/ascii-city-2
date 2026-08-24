---
title: "ASCII City Engine Next renderer foundation"
created_at: "2026-08-23T13:22:15.929127+00:00"
type: "pending-writeback"
---

# Summary

The height-field DDA already preserves taller skyline intervals behind low buildings; the verified defect was a linear-angle ray fan that disagreed with the pinhole projection used by semantic layers.

# Rules

- Keep the DDA and bottom-anchored skyline coverage fast path. Generate camera rays from the same camera plane used by roads, labels, sprites, aircraft, sky, and picking. Fresh clones must inherit no hosted endpoint.

# Verify next time

- Run workspace-quality-gate, npm run benchmark, camera projection round-trip tests, and the semantic renderer snapshot before release.

# Prevents

- Scene-graph rewrites disguised as extraction; first-hit-only skyline regressions; cylindrical-versus-pinhole layer drift; traffic silently routed through the original maintainer's Worker.

# Look here first

- docs/engine-next/FOUNDATION-AUDIT.md and docs/engine-next/CAMERA-PLANE.md
