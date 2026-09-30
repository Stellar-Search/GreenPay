/**
 * lib/__tests__/graphPicking.bench.test.ts
 *
 * Benchmark for #352: the graph visualizer's picking used to scan every
 * on-screen node on every pointermove, which is every node once the camera
 * is zoomed out. This measures the actual shipped ScreenBucketGrid — the
 * same class TransactionGraphVisualizer rebuilds a few times a second and
 * queries on every pick — at fifty thousand nodes, all projected on screen
 * (the exact scenario the issue calls out), under simulated continuous
 * pointer movement.
 *
 * Deliberately a plain-JS micro-benchmark rather than a real-browser e2e
 * test: it isolates the CPU cost the issue is actually about from WebGL
 * draw-call/rasterization cost (a separate, GPU-bound concern this repo's
 * e2e suite can't measure reliably headlessly), so it stays fast and
 * deterministic on any CI runner.
 */
import { ScreenBucketGrid, BUCKET_COLS, BUCKET_ROWS } from "@/lib/graphPicking";

const NODE_COUNT = 50_000;
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 800;
const SIMULATED_POINTER_SAMPLES = 300; // ~5s of continuous movement at 60fps

/** Deterministic pseudo-random screen positions spread across the whole canvas. */
function buildScreenPositions(count: number) {
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  let seed = 1;
  const next = () => {
    // xorshift32 — deterministic, no Math.random dependency
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  for (let i = 0; i < count; i++) {
    x[i] = next() * CANVAS_WIDTH;
    y[i] = next() * CANVAS_HEIGHT;
  }
  return { x, y };
}

describe("ScreenBucketGrid perf (#352)", () => {
  it("rebuilds a 50k-node grid quickly", () => {
    const { x, y } = buildScreenPositions(NODE_COUNT);
    const grid = new ScreenBucketGrid(NODE_COUNT);

    const start = performance.now();
    grid.rebuild(x, y, NODE_COUNT, CANVAS_WIDTH, CANVAS_HEIGHT);
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`[bench][#352] rebuild(${NODE_COUNT} nodes): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it("documents pick-query cost under continuous pointer movement at 50k nodes", () => {
    const { x, y } = buildScreenPositions(NODE_COUNT);
    const grid = new ScreenBucketGrid(NODE_COUNT);
    grid.rebuild(x, y, NODE_COUNT, CANVAS_WIDTH, CANVAS_HEIGHT);

    const durations: number[] = [];
    let visitedTotal = 0;

    for (let sample = 0; sample < SIMULATED_POINTER_SAMPLES; sample++) {
      // A cursor sweeping diagonally across the canvas — continuous movement,
      // not a fixed point, so the query lands in a different bucket each time.
      const px = (Math.sin(sample * 0.11) * 0.5 + 0.5) * CANVAS_WIDTH;
      const py = (Math.cos(sample * 0.07) * 0.5 + 0.5) * CANVAS_HEIGHT;

      const queryStart = performance.now();
      const centerCol = grid.centerCol(px);
      const centerRow = grid.centerRow(py);
      let visited = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = grid.boundedBucketIndex(centerCol + dx, centerRow + dy);
          if (bucket === -1) continue;
          visited += grid.bucketStart[bucket + 1] - grid.bucketStart[bucket];
        }
      }
      durations.push(performance.now() - queryStart);
      visitedTotal += visited;
    }

    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const max = Math.max(...durations);
    const avgVisitedPerQuery = visitedTotal / SIMULATED_POINTER_SAMPLES;
    const expectedIfLinearInGraphSize = NODE_COUNT; // what the old O(N) scan would have touched

    // eslint-disable-next-line no-console
    console.log(
      `[bench][#352] ${SIMULATED_POINTER_SAMPLES} pick queries over a ${NODE_COUNT}-node, ` +
        `${BUCKET_COLS}x${BUCKET_ROWS}-bucket grid — avg: ${avg.toFixed(4)}ms, max: ${max.toFixed(4)}ms, ` +
        `avg candidates examined per query: ${avgVisitedPerQuery.toFixed(1)} ` +
        `(vs. ${expectedIfLinearInGraphSize} for a full-graph scan)`
    );

    // A single frame's budget at 60fps is ~16ms for everything (input, layout,
    // render); picking should be a small fraction of that even at this scale.
    expect(avg).toBeLessThan(2);
    expect(max).toBeLessThan(10);
    // The whole point of the bucket grid: a query should touch a handful of
    // nearby nodes, not scale with total graph size.
    expect(avgVisitedPerQuery).toBeLessThan(NODE_COUNT * 0.01);
  });
});
