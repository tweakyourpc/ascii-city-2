# Engine Benchmark Method

Run the hermetic benchmark from the repository root:

```bash
npm run benchmark
npm run benchmark -- --frames 240 --json
```

The runner uses a fixed procedural seed, fixed camera poses, deterministic
traffic randomness, a fixed simulation step, and no network providers. It warms
the JavaScript engine before recording percentiles.

## Scenarios

- **Dense downtown:** street level inside the tower ring.
- **Low-density suburb:** street level inside the residential ring.
- **Street-level detail:** cars, pedestrians, signs, and the road network.
- **Overlapping skyline:** an elevated view across low and tall structures.
- **Integrated-GPU stress:** a large BLOCK-mode cell buffer with all traffic.

These are engine fixtures, not claims about a real place. A recorded OSM fixture
with irregular footprints must be added before making performance claims about
dense real-world extracts.

## Phase definitions

- `simulation`: traffic and agent state advancement.
- `raycast`: height-field ground, facade, roof, and vegetation rendering. The
  height-field world queries are interleaved with this phase.
- `worldQuery`: projected semantic layers such as roads, junctions, signs, and
  movers. In the browser this phase also includes the sky and information layers.
- `compose`: submission of the completed cell buffer to Canvas 2D.
- `frame`: all measured engine work, including camera ray-table construction and
  phase bookkeeping.

Canvas 2D exposes no portable GPU timer. The engine reports GPU time as unavailable
rather than treating JavaScript submission time as GPU execution time.

Press `P` in the browser to show rolling phase timings. The profile overlay is
off by default so profiling itself does not become a normal frame cost.

## Interpretation

Use p50 for steady-state cost and p95 for frame pacing. Compare the same machine,
browser/runtime, branch, and scenario. Do not compare a warm benchmark number to
a first-load frame or include live provider latency in renderer timing.
