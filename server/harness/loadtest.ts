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
  const lat: number[] = [];
  for (const b of bot) {
    if (b.enemyX === null || b.t < window.from || b.t > window.to) continue;
    let best: ServerEnemySample | null = null;
    let bestDx = Infinity;
    for (const s of server) {
      if (s.t > b.t) break;
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

  const s = await startTestServer();
  const enemySamples: ServerEnemySample[] = [];

  // Sample the authoritative enemy[0] position on the server clock (for render-latency correlation).
  const sampler = setInterval(() => {
    const w = s.server.getWorld();
    const e0 = w && w.state.enemies.length > 0 ? w.state.enemies[0] : null;
    if (e0) enemySamples.push({ t: Date.now(), x: e0.x });
  }, 10);

  // observer stands still the whole run: the enemies (all players spawn at center) approach it
  // monotonically at the start, giving a clean render-latency signal. mover pingpongs then
  // idles so we can measure reconvergence with no permanent drift. The rest add load.
  const MOVE_FRAMES = 200;
  const observer = new Bot({ url: s.url, secret: s.secret, playerId: "observer", net, script: idle });
  const mover = new Bot({
    url: s.url, secret: s.secret, playerId: "mover", net,
    script: (tick, t) => (tick < MOVE_FRAMES ? SCRIPTS.pingpong(tick, t) : idle()),
  });
  const load: Bot[] = [];
  for (let i = 2; i < clients; i++) load.push(new Bot({ url: s.url, secret: s.secret, playerId: "load" + i, net, script: SCRIPTS.orbit }));

  observer.start();
  const observerStart = Date.now();
  mover.start();
  for (const b of load) b.start();
  await waitUntil(() => observer.transport.isReady() && mover.transport.isReady() && load.every((b) => b.transport.isReady()), 5000);

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

  // Render latency: the monotonic-approach window (after a short interp warmup, before the
  // enemies reach the observer and plateau).
  const lat = renderLatencies(enemySamples, observer.samples, { from: observerStart + 800, to: observerStart + 2200 });
  const bytesOut = health.counters.bytesOut - c0.bytesOut;
  const msgsOut = health.counters.msgsOut - c0.msgsOut;
  const avgSnap = msgsOut > 0 ? bytesOut / msgsOut : 0;
  const kbsPerClient = bytesOut / dt / clients / 1024;

  observer.stop();
  mover.stop();
  for (const b of load) b.stop();
  await s.close();

  process.stdout.write(`\n=== measured results ===\n`);
  process.stdout.write(`  reconciliation drift (predicted vs authoritative, post-idle): ${fmt(drift, 2)} px  ${drift < 8 ? "PASS" : "FAIL"} (no permanent drift)\n`);
  if (lat.length > 0) {
    process.stdout.write(`  remote-enemy render latency: p50=${fmt(percentile(lat, 50))}ms  p90=${fmt(percentile(lat, 90))}ms  (samples=${lat.length})  ${percentile(lat, 90) < 200 ? "PASS" : "FAIL"} (<200ms p90)\n`);
  } else {
    process.stdout.write(`  remote-enemy render latency: no matched samples\n`);
  }
  process.stdout.write(`  server tick time: p50=${fmt(health.tickMs_p50, 3)}ms  p95=${fmt(health.tickMs_p95, 3)}ms  max=${fmt(health.tickMs_max, 3)}ms  ${health.tickMs_p95 < 50 ? "PASS" : "FAIL"} (<50ms; target <10ms)\n`);
  process.stdout.write(`  snapshot size: avg ${fmt(avgSnap, 0)} B/msg  ->  ${fmt(kbsPerClient)} KB/s/client at 20Hz  (${clients} clients, ${net.rttMs}ms RTT)\n`);
  process.stdout.write(`  counters: joinsOk=${health.counters.joinsOk} malformed=${health.counters.malformed} rateLimited=${health.counters.rateLimited} droppedSnaps=${health.counters.droppedSnaps}\n\n`);
}

void main();
