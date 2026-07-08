// Lightweight rolling metrics for /healthz + /metrics (production spec §6). Tick time is THE
// key health signal: if it approaches the 50ms budget the server is overloaded.

export class Rolling {
  private buf: Float64Array;
  private len = 0;
  private idx = 0;
  constructor(private cap: number) {
    this.buf = new Float64Array(cap);
  }
  push(v: number): void {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }
  percentile(p: number): number {
    if (this.len === 0) return 0;
    const sorted = Array.from(this.buf.subarray(0, this.len)).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[rank];
  }
  max(): number {
    let m = 0;
    for (let i = 0; i < this.len; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }
  count(): number {
    return this.len;
  }
}

export interface Counters {
  msgsIn: number;
  msgsOut: number;
  bytesOut: number;
  connsOpened: number;
  connsClosed: number;
  joinsOk: number;
  joinsRejected: number;
  malformed: number;
  rateLimited: number;
  droppedSnaps: number;
  rejectedInputs: number;
}

export function newCounters(): Counters {
  return {
    msgsIn: 0, msgsOut: 0, bytesOut: 0, connsOpened: 0, connsClosed: 0,
    joinsOk: 0, joinsRejected: 0, malformed: 0, rateLimited: 0, droppedSnaps: 0, rejectedInputs: 0,
  };
}
