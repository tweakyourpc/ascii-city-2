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

## Engine Next reference result

Reference machine: Intel Core i5-7500T with Intel HD Graphics 630. Command:
`npm run benchmark -- --frames 120 --warmup 30`.

| Scene | Internal grid | Simulation p50 | Raycast p50 | World p50 | Compose p50 | Frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense downtown | 180 x 80 | 0.20 ms | 1.50 ms | 16.00 ms | 0.30 ms | 21.60 ms |
| Low-density suburb | 180 x 80 | 0.36 ms | 3.35 ms | 16.00 ms | 0.24 ms | 22.87 ms |
| Street-level detail | 160 x 72 | 0.21 ms | 2.31 ms | 14.24 ms | 0.22 ms | 20.16 ms |
| Overlapping skyline | 180 x 80 | 0.11 ms | 3.95 ms | 13.99 ms | 0.27 ms | 21.38 ms |
| Integrated-GPU stress | 240 x 216 | 0.12 ms | 6.45 ms | 14.75 ms | 0.52 ms | 24.88 ms |

BLOCK mode uses two internal rows per output text row, so the stress case is
240 x 216 internal cells and 240 x 108 output lines. These Node measurements
confirm that global semantic-layer traversal is the next CPU target. They do
not replace browser frame pacing or GPU measurements.
