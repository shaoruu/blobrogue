// Headless measurement + adversity harness. Boots an in-process authoritative server, drives
// the REAL WSTransport client netcode through latency-injected sockets, and MEASURES the
// Stage-B go/no-go thresholds with actual numbers:
//   - reconciliation reconvergence (no permanent drift) under RTT/jitter/loss
//   - remote-enemy move -> client render latency (p50/p90)
//   - server tick time (p50/p95/max)
//   - snapshot bytes/client + bytes/s at 20Hz
// Run: npm run harness  (env: GS_RTT, GS_JITTER, GS_LOSS, GS_CLIENTS, GS_SECONDS)

import { startTestServer, Bot, SCRIPTS, idle, waitUntil, sleep, percentile } from "./lib.js";
import type { NetConditions } from "./latencySocket.js";

interface ServerEnemySample { t: number; x: number }

function envNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

// End-to-end render latency: with an IDLE observer the enemies approach monotonically, so each
// rendered enemy-x maps unambiguously to the single server time it held that x. Windowed to the
// monotonic approach (before the enemy arrives + plateaus) so the value->time map is 1:1.
function renderLatencies(server: ServerEnemySample[], bot: Array<{ t: number; enemyX: number | null }>, window: { from: number; to: number }): number[] {
  const eps = 6;
  const MAX_LOOKBACK_MS = 500; // bound the value->time search so an oscillating (boss) x can't
                               // match a stale server time far in the past (non-monotonic motion).
  const lat: number[] = [];
  for (const b of bot) {
    if (b.enemyX === null || b.t < window.from || b.t > window.to) continue;
    let best: ServerEnemySample | null = null;
    let bestDx = Infinity;
    for (const s of server) {
      if (s.t > b.t) break;
      if (b.t - s.t > MAX_LOOKBACK_MS) continue;
      const dx = Math.abs(s.x - b.enemyX);
      if (dx < bestDx) { bestDx = dx; best = s; }
    }
    if (best && bestDx < eps) lat.push(b.t - best.t);
  }
  return lat;
}

async function main(): Promise<void> {
  const net: NetConditions = { rttMs: envNum("GS_RTT", 100), jitterMs: envNum("GS_JITTER", 20), loss: envNum("GS_LOSS", 0.05) };
  const clients = Math.max(1, envNum("GS_CLIENTS", 4));
  const seconds = Math.max(2, envNum("GS_SECONDS", 8));

  process.stdout.write(`\nblobrogue Stage-B measurement harness\n`);
  process.stdout.write(`  net: RTT=${net.rttMs}ms jitter=${net.jitterMs}ms loss=${fmt(net.loss * 100, 0)}%  clients=${clients}  duration=${seconds}s\n`);

  // Measure in an OPEN arena (no dungeon walls) so the walker probe travels a clean monotonic
  // line — production runs the real dungeon with identical stepWorld/tick/netcode.
  const s = await startTestServer({ arena: true });
  const walkerSamples: ServerEnemySample[] = [];

  // observer stands still and watches a WALKER player stride in a straight line (monotonic x) —
  // a clean render-latency probe (1:1 value->time), unlike a chasing enemy/boss. mover pingpongs
  // then idles so we measure reconvergence with no permanent drift. The rest add load.
  const MOVE_FRAMES = 200;
  const observer = new Bot({ url: s.url, secret: s.secret, playerId: "observer", net, script: idle });
  const walker = new Bot({ url: s.url, secret: s.secret, playerId: "walker", net, script: () => ({ seq: 0, moveX: -1, moveY: 0, aim: Math.PI, firing: false, dash: false }) });
  const mover = new Bot({
    url: s.url, secret: s.secret, playerId: "mover", net,
    script: (tick, t) => (tick < MOVE_FRAMES ? SCRIPTS.pingpong(tick, t) : idle()),
  });
  const load: Bot[] = [];
  for (let i = 3; i < clients; i++) load.push(new Bot({ url: s.url, secret: s.secret, playerId: "load" + i, net, script: SCRIPTS.orbit }));

  observer.start();
  const observerStart = Date.now();
  walker.start();
  mover.start();
  for (const b of load) b.start();
  await waitUntil(() => observer.transport.isReady() && walker.transport.isReady() && mover.transport.isReady() && load.every((b) => b.transport.isReady()), 5000);

  // God mode on the measurement world: the seeded arena enemies keep chasing (realistic
  // entity/bandwidth load) but can no longer down the stationary probe bots mid-soak — a long
  // run would otherwise end in an authoritative party wipe that closes every measured socket.
  const measured = s.server.getWorld();
  if (measured) measured.state.isGodMode = true;

  // Track the walker's interpolated x on the observer, and its authoritative x on the server.
  const walkerId = walker.serverId();
  if (walkerId) observer.trackRemote(walkerId);
  const sampler = setInterval(() => {
    const w = s.server.getWorld();
    const p = walkerId ? w?.state.players.get(walkerId) : undefined;
    if (p) walkerSamples.push({ t: Date.now(), x: p.x });
  }, 10);

  const c0 = s.server.health().counters;
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const dt = (Date.now() - t0) / 1000;
  const health = s.server.health();
  clearInterval(sampler);

  // Reconciliation: after the idle drain, the mover's predicted self must match authoritative.
  await sleep(400);
  const sid = mover.serverId();
  const world = s.server.getWorld();
  const authSelf = sid ? world?.state.players.get(sid) : undefined;
  const pred = mover.predictedSelf();
  const drift = authSelf ? Math.hypot(pred.x - authSelf.x, pred.y - authSelf.y) : Infinity;

  // Render latency: the walker strides in a straight line, so its x maps 1:1 to a server time
  // during the monotonic window (after a short interp warmup, before it reaches the wall).
  const actualClients = 3 + load.length;
  const lat = renderLatencies(walkerSamples, observer.renderSamples.map((r) => ({ t: r.t, enemyX: r.x })), { from: observerStart + 800, to: observerStart + 3000 });
  const bytesOut = health.counters.bytesOut - c0.bytesOut;
  const msgsOut = health.counters.msgsOut - c0.msgsOut;
  const avgSnap = msgsOut > 0 ? bytesOut / msgsOut : 0;
  const kbsPerClient = bytesOut / dt / actualClients / 1024;

  observer.stop();
  walker.stop();
  mover.stop();
  for (const b of load) b.stop();
  await s.close();

  process.stdout.write(`\n=== measured results ===\n`);
  process.stdout.write(`  reconciliation drift (predicted vs authoritative, post-idle): ${fmt(drift, 2)} px  ${drift < 8 ? "PASS" : "FAIL"} (no permanent drift)\n`);
  if (lat.length > 0) {
    // Expected floor at 100ms RTT: half-RTT (50) + adaptive interp (~130) + up to one tick (50)
    // ~= 230ms. Bar is one interp+tick+half-RTT budget.
    const bar = net.rttMs / 2 + 150 + 50;
    process.stdout.write(`  remote-player render latency: p50=${fmt(percentile(lat, 50))}ms  p90=${fmt(percentile(lat, 90))}ms  (samples=${lat.length})  ${percentile(lat, 90) < bar ? "PASS" : "FAIL"} (<${fmt(bar, 0)}ms p90 = half-RTT+interp+tick)\n`);
  } else {
    process.stdout.write(`  remote-enemy render latency: no matched samples\n`);
  }
  process.stdout.write(`  server tick time: p50=${fmt(health.tickMs_p50, 3)}ms  p95=${fmt(health.tickMs_p95, 3)}ms  max=${fmt(health.tickMs_max, 3)}ms  ${health.tickMs_p95 < 50 ? "PASS" : "FAIL"} (<50ms; target <10ms)\n`);
  process.stdout.write(`  snapshot size: avg ${fmt(avgSnap, 0)} B/msg  ->  ${fmt(kbsPerClient)} KB/s/client at 20Hz  (${actualClients} clients, ${net.rttMs}ms RTT)\n`);
  process.stdout.write(`  counters: joinsOk=${health.counters.joinsOk} malformed=${health.counters.malformed} rateLimited=${health.counters.rateLimited} droppedSnaps=${health.counters.droppedSnaps}\n\n`);
}

void main();
