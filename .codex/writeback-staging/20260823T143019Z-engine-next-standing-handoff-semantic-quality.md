---
title: "Engine-next standing handoff and semantic quality slice"
created_at: "2026-08-23T14:30:19.314933+00:00"
type: "pending-writeback"
---

# Summary

Standing orders now live in HANDOFF.md; cinematic mode has adaptive quality control and semantic spatial hashes for roads, junctions, and labels.

# Rules

- Keep HANDOFF.md and /tmp/codex-claude-handoff.md current before agent switches; optimize semantic layers with spatial filtering before adding a GPU compositor.

# Verify next time

- Run npm test, npm run lint, and npm run benchmark; verify /whoami on the persistent service after restart.

# Prevents

- Do not claim streaming, WebGL composition, interiors, or portals are complete when they remain planned; do not bypass the canonical cell buffer.

# Look here first

- HANDOFF.md; docs/engine-next/FOUNDATION-AUDIT.md; src/spatial.js; src/quality.js
