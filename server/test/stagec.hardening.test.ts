// Stage C hardening regression suite — one targeted test per Technical-Director finding
// (P0-3/P0-4/P0-5 + reliable events + game-over lifecycle + fuzz). Drives the real server +
// WSTransport / raw sockets. Exits non-zero on any failure. Run: npm run test:hardening (server/).

import { startTestServer, Bot, waitUntil, sleep } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/net/protocol.js";
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
function fakeReq(remote: string, xff?: string, realIp?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  if (realIp !== undefined) headers["x-real-ip"] = realIp;
  return { socket: { remoteAddress: remote }, headers } as unknown as IncomingMessage;
}

async function main(): Promise<void> {
  // ---- P0-4: trusted-proxy client-IP resolution (spoof-safe) ----
  test("P0-4: clientIpFrom trusts forwarded headers only from a trusted proxy; ignores spoofing", () => {
    const trusted = parseCidrList(["127.0.0.1/32", "::1/128", "10.0.0.0/8"]);
    // Direct (untrusted) peer: its forwarded headers are attacker-controlled and MUST be ignored.
    check("direct peer uses socket IP (spoofed XFF ignored)", clientIpFrom(fakeReq("203.0.113.5", "1.2.3.4"), trusted) === "203.0.113.5");
    check("direct peer uses socket IP (spoofed X-Real-IP ignored)", clientIpFrom(fakeReq("203.0.113.5", undefined, "1.2.3.4"), trusted) === "203.0.113.5");
    // Behind a trusted proxy: take the real client from XFF (rightmost non-trusted hop).
    check("trusted proxy -> real client from XFF", clientIpFrom(fakeReq("127.0.0.1", "9.9.9.9"), trusted) === "9.9.9.9");
    check("trusted proxy chain -> rightmost non-trusted", clientIpFrom(fakeReq("127.0.0.1", "9.9.9.9, 10.0.0.7"), trusted) === "9.9.9.9");
    // The PRODUCTION topology: nginx sets ONLY X-Real-IP (see server/nginx.example.conf).
    check("trusted proxy + only X-Real-IP -> real client (the documented nginx shape)", clientIpFrom(fakeReq("127.0.0.1", undefined, "9.9.9.9"), trusted) === "9.9.9.9");
    check("garbage forwarded values fall back to peer (no junk buckets)", clientIpFrom(fakeReq("127.0.0.1", "not-an-ip", "also-junk"), trusted) === "127.0.0.1");
    check("trusted proxy, no headers -> falls back to peer", clientIpFrom(fakeReq("127.0.0.1"), trusted) === "127.0.0.1");
  });

  // ---- P0-4: per-IP cap keys on the real client behind the proxy ----
  await test("P0-4: per-IP cap uses X-Forwarded-For behind the (loopback) trusted proxy", async () => {
    const s = await startTestServer({ maxConnsPerIp: 2 }); // loopback is trusted by default
    try {
      // Three connections carrying DISTINCT client IPs via XFF -> distinct buckets, all allowed.
      // (Distinct identities too — same-identity joins now supersede each other by design.)
      const distinct = [await rawSocket(s.url, { "x-forwarded-for": "1.1.1.1" }), await rawSocket(s.url, { "x-forwarded-for": "2.2.2.2" }), await rawSocket(s.url, { "x-forwarded-for": "3.3.3.3" })];
      distinct.forEach((w, i) => w.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, `u${i}`), protocol: PROTOCOL_VERSION })));
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

  // ---- P0-4: production shape — MANY distinct proxied users never collapse to one bucket ----
  await test("P0-4: >16 distinct proxied users all join at the default per-IP cap", async () => {
    const s = await startTestServer(); // default maxConnsPerIp = 16; loopback is a trusted proxy
    try {
      const users: WsClient[] = [];
      for (let i = 0; i < 20; i++) {
        // Each user arrives through the loopback proxy with its own real IP (nginx topology).
        const ws = await rawSocket(s.url, { "x-real-ip": `198.51.100.${i + 1}` });
        ws.on("message", () => {});
        ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, `user${i}`), protocol: PROTOCOL_VERSION }));
        users.push(ws);
      }
      const allIn = await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 20, 4000);
      check("20 proxied users joined (per-IP cap keyed on REAL client IPs)", allIn, `players=${s.server.getWorld()?.playerCount}`);
      for (const ws of users) { try { ws.close(); } catch { /* ignore */ } }
    } finally { await s.close(); }
  });

  // ---- P0-3: adversarial dt — the protocol has no dt, and smuggling one is an error ----
  await test("P0-3: inputs smuggling a dt field (0 / huge / negative) are rejected outright", async () => {
    const s = await startTestServer();
    try {
      for (const dt of [0, 1e9, -5]) {
        const ws = await rawSocket(s.url);
        ws.on("message", () => {});
        let closed = false;
        ws.on("close", () => (closed = true));
        ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, `dt${dt}`), protocol: PROTOCOL_VERSION }));
        await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
        const world = s.server.getWorld()!;
        const pid = [...world.state.players.keys()][0];
        const startX = world.state.players.get(pid)!.x;
        const before = s.server.health().counters.malformed;
        // Four dt-carrying inputs: each is a protocol error; past the malformed allowance the
        // connection dies. None of them may move the player.
        for (let i = 1; i <= 4; i++) ws.send(JSON.stringify({ t: "input", seq: i, mx: 1, my: 0, aim: 0, fire: false, dash: false, ackEv: 0, dt }));
        await sleep(250);
        const gone = await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) === 0, 1500);
        check(`dt=${dt}: counted malformed`, s.server.health().counters.malformed > before);
        check(`dt=${dt}: zero movement from dt-carrying inputs`, (s.server.getWorld()?.state.players.get(pid)?.x ?? startX) === startX);
        check(`dt=${dt}: connection kicked after repeated protocol errors`, closed || gone);
        try { ws.close(); } catch { /* ignore */ }
        await sleep(100);
      }
    } finally { await s.close(); }
  });

  // ---- P0-3: server tick owns time — flooding inputs can't buy simulation time ----
  await test("P0-3: an input flood advances only ~1 fixed step per tick (no time advantage)", async () => {
    const s = await startTestServer();
    try {
      const ws = await rawSocket(s.url);
      ws.on("message", () => {});
      ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "flood"), protocol: PROTOCOL_VERSION }));
      await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
      const world = s.server.getWorld()!;
      const pid = [...world.state.players.keys()][0];
      const startX = world.state.players.get(pid)!.x;
      // Dump 40 move commands in a single burst (as a 240Hz cheat might), then wait ~5 ticks.
      for (let i = 1; i <= 40; i++) ws.send(jsonCodec.encodeClient({ t: "input", seq: i, mx: 1, my: 0, aim: 0, fire: false, dash: false, act: false, ult: false, pulse: false, ackEv: 0, ackSnap: 0 }));
      await sleep(300); // ~6 ticks
      const moved = Math.abs(world.state.players.get(pid)!.x - startX);
      // 40 commands unclamped would be 40 fixed steps (~400px). One-per-tick over ~6 ticks is ~60px.
      check("flood consumed ~1 command/tick, not 40 at once", moved < 120, `moved=${moved.toFixed(0)}px (40 cmds burst)`);
      ws.close();
    } finally { await s.close(); }
  });

  // ---- P0-5: input cadence is frame-rate independent (60/120/144/240Hz equivalence) ----
  await test("P0-5: 60/120/144/240Hz clients advance equally (fixed-step sampling)", async () => {
    const s = await startTestServer();
    try {
      const move = () => ({ seq: 0, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
      const fps = [16, 8, 7, 4]; // 60 / 120 / ~144 / ~240 Hz frame intervals (ms)
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

  // ---- P0-5/B6: sustained high-refresh client stays under every rate limit ----
  await test("B6: a 240Hz client runs sustained without tripping any rate limit; an input flood dies", async () => {
    const s = await startTestServer();
    try {
      const fast = new Bot({ url: s.url, secret: s.secret, playerId: "fps240", frameMs: 4, script: () => ({ seq: 0, moveX: 1, moveY: 0, aim: 0, firing: true, dash: false }) });
      fast.start();
      await waitUntil(() => fast.transport.isReady(), 3000);
      await sleep(3000); // ~720 frames; fixed-step sampling must keep sends ~20/s
      check("240Hz client still connected after sustained play", fast.transport.isReady() && fast.transport.getStatus() === "open");
      check("no rate limiting triggered by the 240Hz client", s.server.health().counters.rateLimited === 0, `rateLimited=${s.server.health().counters.rateLimited}`);
      // Bounded client internals: the pending-input ring and the hidden prediction world must
      // not grow with frame rate or sustained fire.
      const pending = fast.transport.getPendingInputCount();
      check("pending-input ring stays bounded", pending <= 64, `pending=${pending}`);
      check("prediction world holds no leaked bullets under sustained fire", fast.transport.getPredictedBulletCount() === 0, `bullets=${fast.transport.getPredictedBulletCount()}`);
      fast.stop();

      // Segmented buckets: an INPUT-class flood (well over maxInputPerSec, under the aggregate
      // cap) is killed by the input bucket specifically.
      const flooder = await rawSocket(s.url);
      flooder.on("message", () => {});
      let closed = false;
      flooder.on("close", () => (closed = true));
      flooder.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "flood2"), protocol: PROTOCOL_VERSION }));
      await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
      for (let i = 1; i <= 100; i++) flooder.send(jsonCodec.encodeClient({ t: "input", seq: i, mx: 0, my: 0, aim: 0, fire: false, dash: false, act: false, ult: false, pulse: false, ackEv: 0, ackSnap: 0 }));
      const kicked = await waitUntil(() => closed, 2000);
      check("input-class flood (100 msgs in <1s) disconnected by the input bucket", kicked);
      check("input-bucket kick counted as rate limiting", s.server.health().counters.rateLimited > 0);
    } finally { await s.close(); }
  });

  // ---- B3: blessing offers expire; a late answer is rejected ----
  await test("B3: an expired blessing offer rejects the (late) choice", async () => {
    const s = await startTestServer({ offerTtlMs: 1000 });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "sloth", script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const pid = bot.serverId()!;
      // Trigger an authoritative descend -> a blessing offer for the player.
      world.state.enemies = [];
      const d = world.state.dungeon;
      const p = world.state.players.get(pid)!;
      p.x = d.exit.x * TILE + TILE / 2; p.y = d.exit.y * TILE + TILE / 2;
      const gotOffer = await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 3000);
      check("offer arrived", gotOffer);
      const offer = bot.transport.getPendingOfferPeek()!;
      await sleep(1400); // let the 1s TTL lapse
      const rej0 = s.server.health().counters.rejectedInputs;
      bot.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      await sleep(300);
      check("late choice applied nothing", world.state.players.get(pid)!.ownedItemIds.length === 0);
      check("late choice rejected + counted", s.server.health().counters.rejectedInputs > rej0);
      bot.stop();
    } finally { await s.close(); }
  });

  // ---- M16: heartbeat pong-id validation ----
  await test("M16: unsolicited/stale pongs neither reset liveness nor contaminate RTT", async () => {
    const s = await startTestServer({ heartbeatMs: 250, heartbeatMisses: 2 });
    try {
      const ws = await rawSocket(s.url);
      let closed = false;
      ws.on("close", () => (closed = true));
      // Answer every ping with a WRONG id and spam unsolicited pongs: liveness must not reset.
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { t: string; id?: number };
        if (msg.t === "ping") ws.send(jsonCodec.encodeClient({ t: "pong", id: (msg.id ?? 0) + 500 }));
      });
      ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "liar"), protocol: PROTOCOL_VERSION }));
      await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
      const dropped = await waitUntil(() => closed, 3000);
      check("wrong-id pongs did not keep the connection alive (heartbeat timeout)", dropped);
    } finally { await s.close(); }
  });

  // ---- M17: config validation fails fast on invalid values ----
  test("M17: invalid config values refuse to boot instead of silently disabling protections", () => {
    const bad: Array<[string, string]> = [
      ["GS_HEARTBEAT_MS", "-100"],
      ["GS_MAX_INPUT_QUEUE", "0"],
      ["GS_MAX_CONNS_PER_IP", "1.5"],
      ["GS_SEND_BUFFER_LIMIT", "banana"],
      ["PORT", "99999"],
    ];
    for (const [key, val] of bad) {
      let threw = false;
      try { loadConfig({ [key]: val }); } catch { threw = true; }
      check(`${key}=${val} rejected at boot`, threw);
    }
    check("valid env still loads", loadConfig({ GS_HEARTBEAT_MS: "4000" }).heartbeatMs === 4000);
  });

  // ---- M14: positional events are interest-filtered per client ----
  await test("M14: a distant client does not receive positional one-shot FX events", async () => {
    const s = await startTestServer({ interestRadius: 300 });
    try {
      const near = new Bot({ url: s.url, secret: s.secret, playerId: "evnear", script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      const far = new Bot({ url: s.url, secret: s.secret, playerId: "evfar", script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      near.start(); far.start();
      await waitUntil(() => near.transport.isReady() && far.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      world.state.isGodMode = true;
      const sp = world.state.dungeon.spawn;
      const cx = sp.x * TILE + TILE / 2, cy = sp.y * TILE + TILE / 2;
      const farP = world.state.players.get(far.serverId()!)!;
      farP.x = cx + 2000; farP.y = cy;
      await sleep(300);
      // A kill right at the spawn: near must see the enemyKill FX event; far must NOT.
      const e = devSpawnEnemy(world.state, "slime", cx + 40, cy);
      e.hp = 1;
      world.state.bullets.push({ x: e.x, y: e.y, vx: 1, vy: 0, radius: 8, life: 1, friendly: true, owner: near.serverId()!, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false });
      await sleep(600);
      const nearKills = near.events.filter((ev) => ev.t === "enemyKill").length;
      const farKills = far.events.filter((ev) => ev.t === "enemyKill").length;
      check("near client received the kill event", nearKills >= 1, `near=${nearKills}`);
      check("far client did NOT receive the distant positional event", farKills === 0, `far=${farKills}`);
      // But the far client's reliable-event ack still advances (evTo), so nothing is wedged.
      await sleep(200);
      const farConn = [...world.conns.values()].find((c) => c.playerId === far.serverId());
      check("far client's event ack advanced past the filtered ids (evTo)", (farConn?.ackedEventId ?? 0) >= world.latestEventId() - 1, `acked=${farConn?.ackedEventId} latest=${world.latestEventId()}`);
      near.stop(); far.stop();
    } finally { await s.close(); }
  });

  // ---- lifecycle: an emptied room resets to a fresh run ----
  await test("lifecycle: the room resets to a fresh run when the last player leaves", async () => {
    const s = await startTestServer();
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "runner", script: () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }) });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const seed0 = world.state.seed;
      const rev0 = world.state.rev;
      // Advance the run: force floor 2 via an authoritative descend (the exit gate offers the
      // between-floor blessing first and holds the descend until the pick resolves).
      world.state.enemies = [];
      const d = world.state.dungeon;
      const p = world.state.players.get(bot.serverId()!)!;
      p.x = d.exit.x * TILE + TILE / 2; p.y = d.exit.y * TILE + TILE / 2;
      await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 3000);
      const offer = bot.transport.getPendingOfferPeek()!;
      bot.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      await waitUntil(() => world.state.floor === 2, 3000);
      check("run advanced to floor 2", world.state.floor === 2);
      bot.stop();
      const reset = await waitUntil(() => world.state.floor === 1 && world.state.seed !== seed0, 3000);
      check("room reset to floor 1 with a FRESH seed after emptying", reset, `floor=${world.state.floor}`);
      check("world revision advanced across the reset (stale-snapshot guard)", world.state.rev > rev0, `rev=${world.state.rev}`);
      check("no players remain", world.playerCount === 0);
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
      // A slime on top of the (only) player -> contact downs them; the wipe is the held
      // 4.0s all-down beat (studio balance gate §6), THEN game over closes the socket.
      devSpawnEnemy(world.state, "slime", p.x, p.y).spawnTimer = 0;
      const isDowned = await waitUntil(() => world.state.players.get(pid)?.isDown === true, 3000);
      check("the last player going to 0 goes DOWN first (the 4.0s wipe hold)", isDowned && !world.state.isRunOver);
      const closed = await waitUntil(() => bot.transport.getStatus() === "closed", 8000);
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
