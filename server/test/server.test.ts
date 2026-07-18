// Server + netcode integration/assertion suite. Drives the REAL WSTransport client netcode
// against an in-process authoritative server under injected adversity, plus raw hostile
// sockets, and asserts the Stage-B production properties. Exits non-zero on any failure so it
// gates CI. Run: npm run test (in server/).

import { WebSocket as WsClient } from "ws";
import type { RoomRuntime } from "../src/ports.js";
import { startTestServer, Bot, SCRIPTS, idle, waitUntil, sleep, TEST_SECRET } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/net/protocol.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(`${name} threw: ${String(err)}`);
    process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`);
  }
}

// Open a raw ws, run `fn`, and always close it.
function rawSocket(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main(): Promise<void> {
  // ---- auth + join ----
  await test("auth: valid ticket joins, bad ticket rejected", async () => {
    const s = await startTestServer();
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "alice" });
      bot.start();
      const ready = await waitUntil(() => bot.transport.isReady(), 2000);
      check("valid ticket -> ready + spawned", ready && (s.server.getWorld()?.playerCount ?? 0) === 1);
      bot.stop();

      const before = s.server.health().counters.joinsRejected;
      const ws = await rawSocket(s.url);
      let closed = false;
      ws.on("close", () => (closed = true));
      ws.send(jsonCodec.encodeClient({ t: "join", ticket: "totally-bogus", protocol: PROTOCOL_VERSION }));
      await waitUntil(() => closed, 1500);
      check("bad ticket -> rejected + closed", closed && s.server.health().counters.joinsRejected > before);
    } finally {
      await s.close();
    }
  });

  // ---- prediction / reconciliation under adversity ----
  await test("reconciliation reconverges (100ms RTT, 20ms jitter, 5% loss) — no permanent drift", async () => {
    const s = await startTestServer();
    try {
      const MOVE_FRAMES = 200;
      const bot = new Bot({
        url: s.url, secret: s.secret, playerId: "bob",
        net: { rttMs: 100, jitterMs: 20, loss: 0.05 },
        script: (tick, t) => (tick < MOVE_FRAMES ? SCRIPTS.pingpong(tick, t) : idle()),
      });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 2000);
      // Move phase then idle phase; let the network drain so predicted + authoritative settle.
      await sleep(5500);
      const sid = bot.serverId();
      const world = s.server.getWorld();
      const server = sid ? world?.state.players.get(sid) : undefined;
      const pred = bot.predictedSelf();
      const drift = server ? Math.hypot(pred.x - server.x, pred.y - server.y) : Infinity;
      check("predicted self reconverges to authoritative self", drift < 8, `drift=${drift.toFixed(2)}px`);
      bot.stop();
    } finally {
      await s.close();
    }
  });

  // ---- two clients see identical authoritative enemy state ----
  await test("two clients observe identical authoritative enemy positions", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "c1", script: SCRIPTS.orbit });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "c2", script: SCRIPTS.orbit });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      await sleep(1500);
      const sa = a.transport.getLatestSnapshot();
      const sb = b.transport.getLatestSnapshot();
      let maxDelta = 0;
      let compared = 0;
      if (sa && sb) {
        const mapB = new Map(sb.enemies.map((e) => [e.id, e]));
        for (const ea of sa.enemies) {
          const eb = mapB.get(ea.id);
          if (!eb) continue;
          compared++;
          maxDelta = Math.max(maxDelta, Math.hypot(ea.x - eb.x, ea.y - eb.y));
        }
      }
      // Both snapshots are drawn from the same authoritative world; they can be at most a tick
      // or two apart, so positions match within a small enemy-movement tolerance.
      check("enemy sets match across clients", compared > 0 && maxDelta < 40, `enemies=${compared} maxDelta=${maxDelta.toFixed(2)}px`);
      a.stop(); b.stop();
    } finally {
      await s.close();
    }
  });

  // ---- hostile input: malformed + flooding cannot crash, get disconnected ----
  await test("malformed + flooding is isolated (no crash) and disconnected", async () => {
    const s = await startTestServer({ maxMsgsPerSec: 40 });
    try {
      // A legit bot must survive the hostile neighbors.
      const good = new Bot({ url: s.url, secret: s.secret, playerId: "good", script: SCRIPTS.orbit });
      good.start();
      await waitUntil(() => good.transport.isReady(), 2000);

      // Malformed flood.
      const malBefore = s.server.health().counters.malformed;
      const mal = await rawSocket(s.url);
      let malClosed = false;
      mal.on("close", () => (malClosed = true));
      for (let i = 0; i < 10; i++) mal.send("}{ not json " + i);
      await waitUntil(() => malClosed, 1500);
      check("malformed -> counted + disconnected", malClosed && s.server.health().counters.malformed > malBefore);

      // Rate-limit flood: blast valid pings well past the cap.
      const rlBefore = s.server.health().counters.rateLimited;
      const flood = await rawSocket(s.url);
      let floodClosed = false;
      flood.on("close", () => (floodClosed = true));
      for (let i = 0; i < 200; i++) flood.send(jsonCodec.encodeClient({ t: "pong", id: i }));
      await waitUntil(() => floodClosed, 1500);
      check("flood -> rate-limited + disconnected", floodClosed && s.server.health().counters.rateLimited > rlBefore);

      check("server still healthy after hostile input", s.server.health().status === "ok");
      check("legit client unaffected by hostile neighbors", good.transport.isReady());
      good.stop();
    } finally {
      await s.close();
    }
  });

  // ---- heartbeat timeout + clean disconnect ----
  await test("heartbeat drops a silent socket; clean disconnect removes the player", async () => {
    const s = await startTestServer({ heartbeatMs: 60, heartbeatMisses: 2 });
    try {
      // A raw socket that joins but never pongs must be dropped by the heartbeat.
      const silent = await rawSocket(s.url);
      let silentClosed = false;
      silent.on("close", () => (silentClosed = true));
      // Swallow pings so we never auto-pong.
      silent.on("message", () => {});
      silent.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(TEST_SECRET, "ghost"), protocol: PROTOCOL_VERSION }));
      const dropped = await waitUntil(() => silentClosed, 2000);
      check("silent socket dropped by heartbeat", dropped);

      // Clean disconnect: a normal bot leaving removes its player from the world.
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "leaver" });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 2000);
      const withPlayer = s.server.getWorld()?.playerCount ?? 0;
      bot.stop();
      const removed = await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) < withPlayer, 2000);
      check("clean disconnect removes player", removed, `before=${withPlayer} after=${s.server.getWorld()?.playerCount ?? 0}`);
    } finally {
      await s.close();
    }
  });

  // ---- tick health + snapshot size under a small load ----
  await test("tick p95 within budget and snapshots are low-KB under load", async () => {
    const s = await startTestServer();
    try {
      const bots: Bot[] = [];
      for (let i = 0; i < 4; i++) bots.push(new Bot({ url: s.url, secret: s.secret, playerId: "load" + i, script: SCRIPTS.orbit }));
      for (const b of bots) b.start();
      await waitUntil(() => bots.every((b) => b.transport.isReady()), 3000);
      const c0 = s.server.health().counters;
      const t0 = Date.now();
      await sleep(3000);
      const h = s.server.health();
      const dt = (Date.now() - t0) / 1000;
      const bytesOut = h.counters.bytesOut - c0.bytesOut;
      const msgsOut = h.counters.msgsOut - c0.msgsOut;
      const avgSnap = msgsOut > 0 ? bytesOut / msgsOut : 0;
      const bytesPerClientPerSec = bytesOut / dt / bots.length;
      check("tick p95 < 50ms budget", h.tickMs_p95 < 50, `p95=${h.tickMs_p95}ms max=${h.tickMs_max}ms`);
      check("tick p95 comfortably under target (<10ms) at POC scale", h.tickMs_p95 < 10, `p95=${h.tickMs_p95}ms`);
      // Snapshots are now DELTA-encoded against each client's last acknowledged snapshot (v24):
      // per-tick frames send only the fields/entities that changed, with periodic full keyframes
      // for join/resume/gap recovery. Under the same 4-clustered-orbiting-clients scenario that
      // was tripping the old 6KB cap (measured avg ~6044 B/msg pre-delta), the steady-state
      // per-client payload measures avg ~700-875 B/msg and delta p95 ~780-940 B (a full keyframe
      // is ~6KB but rare — join/descent only). The cap below is set from the measured avg peak
      // (~875 B) with generous headroom; the second assert locks the steady-state delta p95, the
      // real "wire is tight" signal that the avg (which folds in the join keyframe) can mask.
      check("avg snapshot < 1.5KB (delta-encoded; was ~6KB)", avgSnap < 1536, `avg=${avgSnap.toFixed(0)}B/msg, ${(bytesPerClientPerSec / 1024).toFixed(1)}KB/s/client`);
      check("steady-state delta p95 < 1200B", h.snapBytes_p95 < 1200, `p50=${h.snapBytes_p50}B p95=${h.snapBytes_p95}B max=${h.snapBytes_max}B`);
      for (const b of bots) b.stop();
    } finally {
      await s.close();
    }
  });

  // ---- server-side anti-cheat: clamps illegal movement (speed-hack) ----
  await test("server clamps speed-hacked movement (mx far beyond unit)", async () => {
    const s = await startTestServer();
    try {
      const cheatWs = await rawSocket(s.url);
      cheatWs.on("message", () => {});
      cheatWs.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(TEST_SECRET, "cheater"), protocol: PROTOCOL_VERSION }));
      await sleep(200);
      const world = s.server.getWorld() as RoomRuntime;
      const pid = [...world.state.players.keys()][0];
      const start = world.state.players.get(pid)!;
      const startX = start.x;
      // Blast max-magnitude move inputs; the sim normalizes to unit + the server caps total dt.
      for (let i = 1; i <= 30; i++) {
        cheatWs.send(jsonCodec.encodeClient({ t: "input", seq: i, mx: 8, my: 0, aim: 0, fire: false, dash: false, act: false, ult: false, pulse: false, pet: false, ak: "", ackEv: 0, ackSnap: 0 }));
      }
      await sleep(500);
      const moved = Math.abs(world.state.players.get(pid)!.x - startX);
      // 30 inputs * 0.05dt would be 1.5s of movement if unclamped; the per-tick dt cap keeps it
      // to ~a couple ticks per tick. Over ~0.5s the honest max is ~ speed*0.5*someMargin.
      check("speed-hack movement is clamped", moved < 400, `moved=${moved.toFixed(0)}px in ~0.5s`);
      cheatWs.close();
    } finally {
      await s.close();
    }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll server/netcode assertions passed.\n");
}

void main();
