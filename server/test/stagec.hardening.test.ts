// Stage C hardening regression suite — one targeted test per Technical-Director finding
// (P0-3/P0-4/P0-5 + reliable events + game-over lifecycle + fuzz). Drives the real server +
// WSTransport / raw sockets. Exits non-zero on any failure. Run: npm run test:hardening (server/).

import { startTestServer, Bot, waitUntil, sleep } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec } from "../../src/net/protocol.js";
import { clientIpFrom, parseCidrList } from "../src/net.js";
import { devSpawnEnemy } from "../../src/sim/world.js";
import { TILE } from "../../src/sim/types.js";
import type { IncomingMessage } from "node:http";
import { WebSocket as WsClient } from "ws";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try { await fn(); } catch (err) { failed++; failures.push(`${name} threw: ${String(err)}`); process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`); }
}
function rawSocket(url: string, headers?: Record<string, string>): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, headers ? { headers } : undefined);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
// A minimal IncomingMessage stand-in for the pure clientIpFrom unit test.
function fakeReq(remote: string, xff?: string): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } } as unknown as IncomingMessage;
}

async function main(): Promise<void> {
  // ---- P0-4: trusted-proxy client-IP resolution (spoof-safe) ----
  test("P0-4: clientIpFrom trusts XFF only from a trusted proxy; ignores spoofed XFF", () => {
    const trusted = parseCidrList(["127.0.0.1/32", "::1/128", "10.0.0.0/8"]);
    // Direct (untrusted) peer: its XFF is attacker-controlled and MUST be ignored.
    check("direct peer uses socket IP (spoofed XFF ignored)", clientIpFrom(fakeReq("203.0.113.5", "1.2.3.4"), trusted) === "203.0.113.5");
    // Behind a trusted proxy: take the real client from XFF (rightmost non-trusted hop).
    check("trusted proxy -> real client from XFF", clientIpFrom(fakeReq("127.0.0.1", "9.9.9.9"), trusted) === "9.9.9.9");
    check("trusted proxy chain -> rightmost non-trusted", clientIpFrom(fakeReq("127.0.0.1", "9.9.9.9, 10.0.0.7"), trusted) === "9.9.9.9");
    check("trusted proxy, empty XFF -> falls back to peer", clientIpFrom(fakeReq("127.0.0.1"), trusted) === "127.0.0.1");
  });

  // ---- P0-4: per-IP cap keys on the real client behind the proxy ----
  await test("P0-4: per-IP cap uses X-Forwarded-For behind the (loopback) trusted proxy", async () => {
    const s = await startTestServer({ maxConnsPerIp: 2 }); // loopback is trusted by default
    try {
      // Three connections carrying DISTINCT client IPs via XFF -> distinct buckets, all allowed.
      const distinct = [await rawSocket(s.url, { "x-forwarded-for": "1.1.1.1" }), await rawSocket(s.url, { "x-forwarded-for": "2.2.2.2" }), await rawSocket(s.url, { "x-forwarded-for": "3.3.3.3" })];
      for (const w of distinct) w.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "u"), protocol: 1 }));
      await sleep(200);
      check("3 distinct-IP clients all admitted (proxy did not collapse them)", s.server.getWorld()?.playerCount === 3, `players=${s.server.getWorld()?.playerCount}`);
      for (const w of distinct) w.close();
      await sleep(100);
      // Three connections sharing ONE client IP -> the 3rd exceeds the per-IP cap and is closed.
      const same: WsClient[] = [];
      let sameClosed = 0;
      for (let i = 0; i < 3; i++) { const w = await rawSocket(s.url, { "x-forwarded-for": "7.7.7.7" }); w.on("close", () => sameClosed++); same.push(w); }
      await sleep(300);
      check("3rd connection from the same client IP is capped", sameClosed >= 1, `closed=${sameClosed}`);
      for (const w of same) { try { w.close(); } catch { /* ignore */ } }
    } finally { await s.close(); }
  });

  // ---- P0-3: server tick owns time — flooding inputs can't buy simulation time ----
  await test("P0-3: an input flood advances only ~1 fixed step per tick (no time advantage)", async () => {
    const s = await startTestServer();
    try {
      const ws = await rawSocket(s.url);
      ws.on("message", () => {});
      ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "flood"), protocol: 1 }));
      await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
      const world = s.server.getWorld()!;
      const pid = [...world.state.players.keys()][0];
      const startX = world.state.players.get(pid)!.x;
      // Dump 40 move commands in a single burst (as a 240Hz cheat might), then wait ~5 ticks.
      for (let i = 1; i <= 40; i++) ws.send(jsonCodec.encodeClient({ t: "input", seq: i, mx: 1, my: 0, aim: 0, fire: false, dash: false, ackEv: 0 }));
      await sleep(300); // ~6 ticks
      const moved = Math.abs(world.state.players.get(pid)!.x - startX);
      // 40 commands unclamped would be 40 fixed steps (~400px). One-per-tick over ~6 ticks is ~60px.
      check("flood consumed ~1 command/tick, not 40 at once", moved < 120, `moved=${moved.toFixed(0)}px (40 cmds burst)`);
      ws.close();
    } finally { await s.close(); }
  });

  // ---- P0-5: input cadence is frame-rate independent (30/60/144/240Hz equivalence) ----
  await test("P0-5: 30/60/144/240Hz clients advance equally (fixed-step sampling)", async () => {
    const s = await startTestServer();
    try {
      const move = () => ({ seq: 0, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
      const fps = [33, 16, 7, 4]; // 30 / 60 / ~144 / ~240 Hz frame intervals (ms)
      const bots = fps.map((frameMs, i) => new Bot({ url: s.url, secret: s.secret, playerId: `fps${i}`, script: move, frameMs }));
      for (const b of bots) b.start();
      await waitUntil(() => bots.every((b) => b.transport.isReady()), 3000);
      const world = s.server.getWorld()!;
      const startXs = bots.map((b) => world.state.players.get(b.serverId()!)!.x);
      await sleep(1500);
      const disp = bots.map((b, i) => world.state.players.get(b.serverId()!)!.x - startXs[i]);
      const min = Math.min(...disp), max = Math.max(...disp);
      // All frame rates should walk essentially the same distance (server consumes 1 cmd/tick).
      check("all frame rates advanced ~equally", max - min < 20, `disp=[${disp.map((d) => d.toFixed(0)).join(",")}]px spread=${(max - min).toFixed(0)}`);
      for (const b of bots) b.stop();
    } finally { await s.close(); }
  });

  // ---- H5: fuzz — random garbage frames can't crash; a valid client survives ----
  await test("H5: fuzz garbage frames cannot crash the server; strict protocol version enforced", async () => {
    const s = await startTestServer();
    try {
      const good = new Bot({ url: s.url, secret: s.secret, playerId: "good", script: () => ({ seq: 0, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false }) });
      good.start();
      await waitUntil(() => good.transport.isReady(), 2000);
      const before = s.server.health().counters.malformed;
      // 200 random garbage frames from short-lived sockets (bounded so we don't trip rate limits).
      for (let n = 0; n < 40; n++) {
        const ws = await rawSocket(s.url);
        ws.on("message", () => {});
        ws.on("error", () => {});
        for (let i = 0; i < 5; i++) {
          const junk = Math.random() < 0.5 ? Math.random().toString(36) : JSON.stringify({ t: Math.random() < 0.5 ? "input" : "x", seq: "NaN", mx: {}, junk: Array(20).fill(Math.random()) });
          try { ws.send(junk); } catch { /* ignore */ }
        }
        try { ws.close(); } catch { /* ignore */ }
      }
      await sleep(400);
      check("server stayed healthy under fuzz", s.server.health().status === "ok");
      check("malformed frames were counted (rejected at boundary)", s.server.health().counters.malformed > before);
      check("legit client survived the fuzz", good.transport.isReady());

      // Strict protocol version: 0 / missing is rejected; the current version is accepted.
      const rej0 = s.server.health().counters.joinsRejected;
      const badVer = await rawSocket(s.url);
      let badClosed = false; badVer.on("close", () => (badClosed = true)); badVer.on("message", () => {});
      badVer.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "v0"), protocol: 0 }));
      await waitUntil(() => badClosed, 1500);
      check("protocol 0 join rejected (no bypass)", badClosed && s.server.health().counters.joinsRejected > rej0);
      good.stop();
    } finally { await s.close(); }
  });

  // ---- H2: reliable event channel — no missing/double kill/loot under heavy loss ----
  await test("H2: a killed enemy's kill event reaches a lossy client exactly once", async () => {
    const s = await startTestServer();
    try {
      // 40% packet loss both ways: snapshots (and their events) are frequently dropped.
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "lossy", net: { rttMs: 60, jitterMs: 20, loss: 0.4 }, script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const sp = world.state.dungeon.spawn;
      const e = devSpawnEnemy(world.state, "slime", sp.x * TILE + TILE / 2 + 60, sp.y * TILE + TILE / 2);
      e.hp = 1;
      // Kill it authoritatively next tick via a planted friendly bullet owned by the bot.
      const pid = bot.serverId()!;
      world.state.bullets.push({ x: e.x, y: e.y, vx: 1, vy: 0, radius: 8, life: 1, friendly: true, owner: pid, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false });
      await sleep(2500); // plenty of resends to punch through 40% loss
      const kills = bot.events.filter((ev) => ev.t === "enemyKill" && (ev as { eid: number }).eid === e.id);
      check("kill event delivered despite 40% loss (reliable channel)", kills.length >= 1, `count=${kills.length}`);
      check("kill event not duplicated (id dedupe)", kills.length === 1, `count=${kills.length}`);
      bot.stop();
    } finally { await s.close(); }
  });

  // ---- H6: deterministic game-over leave lifecycle ----
  await test("H6: full wipe deterministically closes the socket + removes the player", async () => {
    const s = await startTestServer();
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "solo-death", script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const pid = bot.serverId()!;
      const p = world.state.players.get(pid)!;
      p.hp = 1; p.invuln = 0;
      // A slime on top of the (only) player -> contact kills -> no ally -> game over.
      devSpawnEnemy(world.state, "slime", p.x, p.y).spawnTimer = 0;
      const closed = await waitUntil(() => bot.transport.getStatus() === "closed", 3000);
      check("socket deterministically closed on game over", closed);
      const removed = await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) === 0, 2000);
      check("player removed from the world on game over", removed, `players=${s.server.getWorld()?.playerCount}`);
      bot.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll Stage-C hardening regressions passed.\n");
}

void main();
