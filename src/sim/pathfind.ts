import type { Dungeon } from "./dungeon.js";

// Grid flow field (a.k.a. Dijkstra map) for enemy pathfinding. A multi-source BFS
// floods walkable tiles outward from every live target (the player, or all players
// in co-op) and records each tile's step-distance to the NEAREST target. Enemies
// then just walk downhill on that distance to route around walls toward whoever is
// closest by path — no per-enemy search, no straight-line "stick on the wall" bug.
//
// Allocation discipline: the typed arrays are sized once per dungeon and reused on
// every rebuild (build() only fills, never allocates). Sampling writes into a shared
// `step` scratch vector rather than returning a fresh object, mirroring anim.ts.

// 8-neighborhood, orthogonals first so a diagonal can be gated on its two ortho cells.
const DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DY = [0, 0, 1, -1, 1, -1, 1, -1] as const;

const UNREACHED = -1; // dist sentinel: wall or not-yet-flooded (treated as impassable)

export class FlowField {
  private w = 0;
  private h = 0;
  private dist = new Int32Array(0); // BFS steps to nearest target; UNREACHED = wall/unreachable
  private queue = new Int32Array(0); // FIFO of tile indices; each tile enqueues at most once
  private isBuilt = false;

  // Shared scratch for sampleStep(); safe because callers read it immediately.
  readonly step = { dx: 0, dy: 0 };

  isReady(): boolean {
    return this.isBuilt;
  }

  private ensureSize(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.dist = new Int32Array(w * h);
    this.queue = new Int32Array(w * h);
    this.isBuilt = false;
  }

  // Flood from every source tile at once. `sources` holds row-major tile indices;
  // wall / out-of-range sources are ignored. After this, dist[i] is the step count
  // from tile i to the nearest reachable source (UNREACHED if walled off).
  build(dungeon: Dungeon, sources: readonly number[]): void {
    this.ensureSize(dungeon.w, dungeon.h);
    const { w, h, tiles } = dungeon;
    const dist = this.dist;
    const queue = this.queue;
    dist.fill(UNREACHED);

    let head = 0;
    let tail = 0;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s < 0 || s >= dist.length) continue;
      if (tiles[s] === 1 || dist[s] === 0) continue; // skip walls and duplicate seeds
      dist[s] = 0;
      queue[tail++] = s;
    }

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (tiles[ni] === 1 || dist[ni] !== UNREACHED) continue;
        dist[ni] = nd;
        queue[tail++] = ni;
      }
    }

    this.isBuilt = true;
  }

  // Writes the downhill step direction from tile (tx,ty) into `this.step` and returns
  // true if a strictly-closer neighbor exists. Diagonals are only taken when both
  // adjacent ortho cells are open, so enemies never clip a wall corner. Returns false
  // on the target tile / an unreachable tile / before the first build.
  sampleStep(tx: number, ty: number): boolean {
    this.step.dx = 0;
    this.step.dy = 0;
    const w = this.w;
    const h = this.h;
    if (!this.isBuilt || tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    const dist = this.dist;
    const here = dist[ty * w + tx];
    if (here <= 0) return false; // on a source tile, a wall, or unreachable

    let best = here;
    let bestDx = 0;
    let bestDy = 0;
    for (let k = 0; k < 8; k++) {
      const dx = DX[k];
      const dy = DY[k];
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nd = dist[ny * w + nx];
      if (nd === UNREACHED) continue;
      if (dx !== 0 && dy !== 0) {
        // Corner guard: block diagonals that would cut across a wall corner.
        if (dist[ty * w + nx] === UNREACHED || dist[ny * w + tx] === UNREACHED) continue;
      }
      if (nd < best) {
        best = nd;
        bestDx = dx;
        bestDy = dy;
      }
    }
    this.step.dx = bestDx;
    this.step.dy = bestDy;
    return bestDx !== 0 || bestDy !== 0;
  }
}
