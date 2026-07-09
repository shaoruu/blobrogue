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
  // An older connection closed because the SAME verified identity joined the same world again
  // (two tabs / zombie socket). Growth here means players are running duplicate sessions.
  duplicateIdentityKicks: number;
  // Reconnect grace/resume lifecycle. seatsReserved counts unexpected disconnects that got a
  // grace window; resumesOk successful reclaims; seatsExpired graces that ran out (the
  // authoritative leave); resumesRejected replayed/forged tokens (security signal);
  // resumesExpired resume attempts after the seat was gone (late client / server restart);
  // seatsDiscarded plain rejoins that abandoned a reserved body; resumesPrevToken resumes
  // accepted via the armed PREVIOUS token (the connection died inside the token-rotation ack
  // window, so the rotated token never reached the client — expected under flaky networks,
  // a sustained spike means clients keep dying mid-handshake).
  seatsReserved: number;
  seatsExpired: number;
  seatsDiscarded: number;
  resumesOk: number;
  resumesPrevToken: number;
  resumesRejected: number;
  resumesExpired: number;
  // Blessing offers that ran out their TTL unanswered (pick forfeited, descend gate
  // released on the same tick). Growth flags AFK parties or a stuck-overlay bug.
  offersExpired: number;
  malformed: number;
  rateLimited: number;
  droppedSnaps: number;
  rejectedInputs: number;
}

export function newCounters(): Counters {
  return {
    msgsIn: 0, msgsOut: 0, bytesOut: 0, connsOpened: 0, connsClosed: 0,
    joinsOk: 0, joinsRejected: 0, duplicateIdentityKicks: 0,
    seatsReserved: 0, seatsExpired: 0, seatsDiscarded: 0, resumesOk: 0, resumesPrevToken: 0, resumesRejected: 0, resumesExpired: 0,
    offersExpired: 0,
    malformed: 0, rateLimited: 0, droppedSnaps: 0, rejectedInputs: 0,
  };
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[rank];
}

// Per-connection netcode signals the metrics aggregator folds into the health report. Kept as a
// plain input shape so Metrics doesn't depend on the Conn type (decoupling observability from
// the transport).
export interface ConnNetSample {
  rttMs: number;            // server-measured (ping/pong)
  cliJitterMs: number;      // client-reported
  cliReconciliations: number;
  cliCorrectionMaxPx: number;
}

export interface HealthReport {
  status: string;
  uptimeSec: number;
  worlds: number;
  players: number;
  connections: number;
  tickMs_p50: number;
  tickMs_p95: number;
  tickMs_max: number;
  snapBytes_p50: number;
  snapBytes_p95: number;
  snapBytes_max: number;
  rttMs_avg: number;
  rttMs_p95: number;
  jitterMs_avg: number;
  reconciliations: number;
  correctionMax_px: number;
  counters: Counters;
}

// Owns all server observability state (tick + snapshot rolling windows, counters) and builds the
// /healthz + /metrics report. Extracted from the server so the transport doesn't also own metrics
// math — a single, testable observability module (production spec §6).
export class Metrics {
  readonly counters = newCounters();
  private tick = new Rolling(1200);        // ~60s of ticks at 20Hz
  private snapBytes = new Rolling(2000);   // recent per-client snapshot byte sizes

  recordTick(ms: number): void {
    this.tick.push(ms);
  }
  recordSnapshotBytes(bytes: number): void {
    this.snapBytes.push(bytes);
  }
  tickP95(): number {
    return this.tick.percentile(95);
  }

  report(startedAt: number, nowMs: number, worlds: number, players: number, connections: number, nets: ConnNetSample[]): HealthReport {
    const rtts: number[] = [];
    let jitterSum = 0, jitterN = 0, recSum = 0, corrMax = 0;
    for (const c of nets) {
      if (c.rttMs > 0) rtts.push(c.rttMs);
      if (c.cliJitterMs > 0) { jitterSum += c.cliJitterMs; jitterN++; }
      recSum += c.cliReconciliations;
      if (c.cliCorrectionMaxPx > corrMax) corrMax = c.cliCorrectionMaxPx;
    }
    const rttAvg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
    return {
      status: "ok",
      uptimeSec: startedAt ? Math.round((nowMs - startedAt) / 1000) : 0,
      worlds, players, connections,
      tickMs_p50: Number(this.tick.percentile(50).toFixed(3)),
      tickMs_p95: Number(this.tick.percentile(95).toFixed(3)),
      tickMs_max: Number(this.tick.max().toFixed(3)),
      snapBytes_p50: Math.round(this.snapBytes.percentile(50)),
      snapBytes_p95: Math.round(this.snapBytes.percentile(95)),
      snapBytes_max: Math.round(this.snapBytes.max()),
      rttMs_avg: Number(rttAvg.toFixed(1)),
      rttMs_p95: Number(pct(rtts, 95).toFixed(1)),
      jitterMs_avg: Number((jitterN ? jitterSum / jitterN : 0).toFixed(1)),
      reconciliations: recSum,
      correctionMax_px: Number(corrMax.toFixed(1)),
      counters: { ...this.counters },
    };
  }
}
