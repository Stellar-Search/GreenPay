/**
 * lib/graphPicking.ts
 *
 * Screen-space bucket grid used by TransactionGraphVisualizer to prune
 * hover/click picking candidates (resolves #352 — picking previously
 * scanned every on-screen node, which meant every node once zoomed out).
 * Kept independent of three.js/WebGL so its cost can be measured directly
 * in __tests__/graphPicking.bench.test.ts without a real GPU context.
 *
 * Usage: call `rebuild()` whenever the camera moves (a few times a second
 * is enough — see TransactionGraphVisualizer's frustumCounter), then
 * `forEachNear()` on every pick. Both are allocation-free after
 * construction — all scratch state is the grid's own typed arrays.
 */
export const BUCKET_COLS = 64;
export const BUCKET_ROWS = 64;
const NUM_BUCKETS = BUCKET_COLS * BUCKET_ROWS;

export class ScreenBucketGrid {
  readonly bucketStart: Int32Array;
  readonly bucketItems: Int32Array;
  private readonly bucketCursor: Int32Array;
  cellWidth = 1;
  cellHeight = 1;

  constructor(capacity: number) {
    this.bucketStart = new Int32Array(NUM_BUCKETS + 1);
    this.bucketCursor = new Int32Array(NUM_BUCKETS);
    this.bucketItems = new Int32Array(capacity);
  }

  private bucketIndexFor(x: number, y: number): number {
    let cx = Math.floor(x / this.cellWidth);
    let cy = Math.floor(y / this.cellHeight);
    if (cx < 0) cx = 0;
    else if (cx >= BUCKET_COLS) cx = BUCKET_COLS - 1;
    if (cy < 0) cy = 0;
    else if (cy >= BUCKET_ROWS) cy = BUCKET_ROWS - 1;
    return cy * BUCKET_COLS + cx;
  }

  /** Counting-sort the first `count` entries of (screenX, screenY) into buckets. */
  rebuild(screenX: Float32Array, screenY: Float32Array, count: number, canvasWidth: number, canvasHeight: number) {
    this.cellWidth = canvasWidth / BUCKET_COLS;
    this.cellHeight = canvasHeight / BUCKET_ROWS;

    this.bucketStart.fill(0);
    for (let v = 0; v < count; v++) {
      this.bucketStart[this.bucketIndexFor(screenX[v], screenY[v]) + 1]++;
    }
    for (let b = 0; b < NUM_BUCKETS; b++) {
      this.bucketStart[b + 1] += this.bucketStart[b];
    }
    this.bucketCursor.set(this.bucketStart.subarray(0, NUM_BUCKETS));
    for (let v = 0; v < count; v++) {
      const bucket = this.bucketIndexFor(screenX[v], screenY[v]);
      this.bucketItems[this.bucketCursor[bucket]++] = v;
    }
  }

  centerCol(px: number): number {
    return Math.min(BUCKET_COLS - 1, Math.max(0, Math.floor(px / this.cellWidth)));
  }

  centerRow(py: number): number {
    return Math.min(BUCKET_ROWS - 1, Math.max(0, Math.floor(py / this.cellHeight)));
  }

  /** Index into `bucketStart` for (col, row), or -1 if out of range. Allocation-free. */
  boundedBucketIndex(col: number, row: number): number {
    if (col < 0 || col >= BUCKET_COLS || row < 0 || row >= BUCKET_ROWS) return -1;
    return row * BUCKET_COLS + col;
  }
}
