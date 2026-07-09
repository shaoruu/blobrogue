// Reconnect grace / session resume suite — the permanent fix for "Wi-Fi blipped and my blob
// was dead when I got back". Drives REAL WSTransport clients (auto-reconnect, backoff, seat
// tokens) against an in-process server and locks:
//   1. a drop early / mid / at the very edge of the grace window resumes the EXACT body:
//      same player id, HP, inventory, blessings, coins, floor, position — no duplicate body.
//      (Wall-clock points scale the production 1s/5s/24s-of-25s pattern into a fast window;
//      the production defaults themselves are asserted.)
//   2. past the grace the seat expires: the authoritative leave applies, the world empties,
//      and a late resume gets an EXPLICIT resume_expired (terminal connection_lost — the
//      client returns to the lobby, never a fabricated game over)
//   3. a replayed/stolen resume token is rejected outright and cannot disturb the live
//      session (tokens are single-use and rotate on every join)
//   4. state-sensitive drops: while DOWNED (still down after resume, revivable), while
//      CHOOSING a blessing (the offer survives and is answerable after resume), and AT THE
//      EXIT (the disconnect neither descends the party nor deadlocks it — the present
//      player descends when ready and the reserved body is carried to the next floor)
//   5. teammates play on through an outage: ticks advance, they see the reconnecting ghost
//      (ab flag + away roster), and an absent-but-alive member prevents a false wipe until
//      the grace truly expires
//   6. a flaky network (latency + jitter + packet loss + repeated socket kills) still
//      converges to a single resumed body with the same state
//   7. a server RESTART loses in-memory seats BY DESIGN: the reconnecting client gets
//      resume_expired and lands terminal connection_lost (documented in MULTIPLAYER.md)
// Run: npm run test:resume (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { GameServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec, PROTOCOL_VERSION, RESUME_GRACE_MS } from "../../src/net/protocol.js";
import { TILE } from "../../src/sim/types.js";
import { WebSocket as WsClient } from "ws";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try { await fn(); }
  catch (err) { failed++; failures.push(`${name} threw: ${String(err)}`); process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`); }
}

// Fast reconnect tuning for a scaled grace window (tests must not take 25s per case).
const FAST = { baseDelayMs: 80, maxDelayMs: 250 };

function isResumed(bot: Bot, sinceTick: number): boolean {
  const snap = bot.transport.getLatestSnapshot();
  return !bot.transport.getReconnectInfo().isReconnecting && snap !== null && snap.tick > sinceTick;
}

async function main(): Promise<void> {
  check("production grace default is 25s (the deployed window)", RESUME_GRACE_MS === 25000 && loadConfig({}).resumeGraceMs === 25000);

  await test("drops early / mid / at the grace edge resume the exact body (scaled 1s/5s/24s-of-25s)", async () => {
    const graceMs = 2500;
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "resume-id", world: "room:RSME", name: "Blipper", colorIndex: 3, script: () => idle(), reconnect: { ...FAST, graceMs } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld("room:RSME")!;
      const pid = bot.transport.getSelfServerId()!;

      // A run worth losing: coins, damage taken, an extra weapon, stacked blessings, and a
      // position away from spawn — every field must survive every outage below exactly.
      const p = world.state.players.get(pid)!;
      p.coins = 137; p.hp = 2; p.x += TILE; p.y += TILE / 2;
      p.ownedWeapons.push("tesla");
      p.ownedItemIds.push("it_dmg", "it_dmg");
      const wantX = p.x, wantY = p.y;
      const seedBefore = world.state.seed;

      // The production pattern 1s/5s/24s of a 25s grace, scaled into the 2.5s window: an
      // early blip (4%), a mid outage (20%), and an outage lasting almost the whole grace
      // (96%) — the connectivity-returned signal retries immediately, so even the edge case
      // resumes in time.
      const outages = [Math.round(graceMs * 0.04), Math.round(graceMs * 0.2), Math.round(graceMs * 0.96)];
      const firstToken = bot.transport.getResumeToken();
      for (const outageMs of outages) {
        const tickBefore = bot.transport.getLatestSnapshot()!.tick;
        bot.dropConnection(true);
        await waitUntil(() => (s.server.getWorld("room:RSME")?.state.players.get(pid)?.isAbsent ?? false), 2000);
        check(`[${outageMs}ms] body reserved (absent + safe) the moment the server sees the drop`,
          world.state.players.get(pid)?.isAbsent === true && world.playerCount === 1);
        await sleep(outageMs);
        bot.restoreNetwork();
        const isBack = await waitUntil(() => isResumed(bot, tickBefore), 4000);
        check(`[${outageMs}ms] client resumed inside the grace`, isBack, `reconnecting=${bot.transport.getReconnectInfo().isReconnecting}`);
        const self = bot.transport.getLatestSnapshot()?.self;
        check(`[${outageMs}ms] SAME player id (no duplicate body)`, bot.transport.getSelfServerId() === pid && world.playerCount === 1,
          `pid=${bot.transport.getSelfServerId()} players=${world.playerCount}`);
        check(`[${outageMs}ms] exact state: hp/coins/weapons/blessings/floor/position`,
          self !== null && self !== undefined
          && self.hp === 2 && self.coins === 137
          && self.wpns.includes("tesla")
          && self.items.filter((it) => it === "it_dmg").length === 2
          && bot.transport.getLatestSnapshot()!.floor === 1
          && Math.abs(self.x - wantX) < 1 && Math.abs(self.y - wantY) < 1,
          `hp=${self?.hp} coins=${self?.coins}`);
        check(`[${outageMs}ms] body is present again (targetable/damageable)`, world.state.players.get(pid)?.isAbsent === false);
        check(`[${outageMs}ms] run was never reset`, world.state.seed === seedBefore);
      }
      const lastToken = bot.transport.getResumeToken();
      check("seat token rotated across resumes (single-use)", firstToken !== null && lastToken !== null && firstToken !== lastToken);
      check("every resume was counted", s.server.health().counters.resumesOk === outages.length, `resumesOk=${s.server.health().counters.resumesOk}`);
      bot.stop();
    } finally { await s.close(); }
  });

  await test("past the grace the seat expires: authoritative leave + explicit resume_expired (never a fake death)", async () => {
    const graceMs = 800;
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "late-id", world: "room:LATE", script: () => idle(), reconnect: { ...FAST, graceMs } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      bot.dropConnection(true);
      // 26s-of-25s, scaled: stay dark past the whole grace window.
      const isExpired = await waitUntil(() => s.server.getWorld("room:LATE") === undefined, graceMs + 1500);
      check("seat expired on schedule -> authoritative leave -> world released", isExpired);
      check("expiry counted", s.server.health().counters.seatsExpired === 1);

      bot.restoreNetwork();
      const isTerminal = await waitUntil(() => bot.transport.getCloseKind() !== null, 6000);
      check("late resume answered explicitly", isTerminal, `kind=${bot.transport.getCloseKind()}`);
      check("terminal state is connection_lost (lobby return), NOT a game over", bot.transport.getCloseKind() === "connection_lost");
      check("the reason names the expired seat", (bot.transport.lastError ?? "").includes("resume_expired"), bot.transport.lastError ?? "");
      check("the expired attempt was counted", s.server.health().counters.resumesExpired >= 1);
      bot.stop();
    } finally { await s.close(); }
  });

  await test("a replayed resume token is rejected and cannot disturb the live session", async () => {
    const s = await startTestServer({ resumeGraceMs: 4000 });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "steal-id", world: "room:STLN", script: () => idle(), reconnect: { ...FAST, graceMs: 4000 } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const stolenToken = bot.transport.getResumeToken()!;
      const pid = bot.transport.getSelfServerId()!;

      // The victim drops and resumes — consuming the seat and rotating the token.
      const tickBefore = bot.transport.getLatestSnapshot()!.tick;
      bot.dropConnection(false);
      await waitUntil(() => isResumed(bot, tickBefore), 4000);
      check("victim resumed (token consumed + rotated)", bot.transport.getResumeToken() !== stolenToken);

      // The attacker replays the CAPTURED (pre-rotation) token with a valid same-identity
      // ticket. The live connection holds a different token -> hard reject.
      const ws = new WsClient(s.url);
      let rejectCode = "";
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as { t?: string; code?: string };
        if (msg.t === "error" && msg.code) rejectCode = msg.code;
      });
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      ws.send(jsonCodec.encodeClient({
        t: "join",
        ticket: mintTicket(s.secret, "steal-id", 120, Date.now(), { worldId: "room:STLN" }),
        protocol: PROTOCOL_VERSION,
        resume: stolenToken,
      }));
      await waitUntil(() => rejectCode !== "", 2000);
      check("replayed token rejected with the resume code", rejectCode === "resume", `code=${rejectCode}`);
      check("rejection counted (security signal)", s.server.health().counters.resumesRejected === 1);
      await sleep(200);
      check("live session undisturbed: same pid, one body, still ready",
        bot.transport.getSelfServerId() === pid && s.server.getWorld("room:STLN")?.playerCount === 1 && bot.transport.isReady());
      ws.close();
      bot.stop();
    } finally { await s.close(); }
  });

  await test("drop while DOWNED: still down after resume — never promoted to dead or erased", async () => {
    const s = await startTestServer({ resumeGraceMs: 3000 });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "down-a", world: "room:DOWN", name: "Ada", script: () => idle(), reconnect: { ...FAST, graceMs: 3000 } });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "down-b", world: "room:DOWN", name: "Bob", script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:DOWN")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const pa = world.state.players.get(adaPid)!;
      pa.hp = 0; pa.isDown = true;

      const tickBefore = ada.transport.getLatestSnapshot()!.tick;
      ada.dropConnection(false);
      await waitUntil(() => isResumed(ada, tickBefore), 4000);
      const self = ada.transport.getLatestSnapshot()?.self;
      check("resumed still DOWN with 0 hp (not dead, not reset)", self?.down === true && self?.hp === 0, `down=${self?.down} hp=${self?.hp}`);
      check("run not over (Bob stands; Ada is revivable)", world.state.isRunOver === false);
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("drop while CHOOSING a blessing: the offer survives the outage and is answerable after resume", async () => {
    const s = await startTestServer({ resumeGraceMs: 3000 });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "bless-id", world: "room:BLSS", script: () => idle(), reconnect: { ...FAST, graceMs: 3000 } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld("room:BLSS")!;
      const pid = bot.transport.getSelfServerId()!;
      const conn = [...world.conns.values()][0];

      // Raise a real offer exactly the way the server does (sim pause + validated conn offer).
      const choices = world.rollBlessingChoices(pid, false);
      conn.pendingOffer = choices;
      conn.offerId = 1;
      conn.offerResendsLeft = 40;
      conn.offerDeadline = Date.now() + 60000;
      world.state.pendingBlessings.set(pid, 30);
      await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);
      check("offer shown before the drop", bot.transport.getPendingOfferPeek() !== null);

      const tickBefore = bot.transport.getLatestSnapshot()!.tick;
      bot.dropConnection(false);
      await waitUntil(() => isResumed(bot, tickBefore), 4000);
      // The transport re-prompts preserved offers after a resume (offer ids reset with the
      // socket); the pick is still damage-shielded sim-side throughout.
      const isOfferReDelivered = await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);
      check("offer re-delivered after the resume (same choice set)", isOfferReDelivered
        && JSON.stringify(bot.transport.getPendingOfferPeek()?.choices) === JSON.stringify(choices));
      check("the pick pause survived (player still shielded mid-choice)", world.state.pendingBlessings.has(pid));

      const offer = bot.transport.consumePendingOffer()!;
      bot.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      const isApplied = await waitUntil(() => (bot.transport.getLatestSnapshot()?.self?.items ?? []).includes(offer.choices[0]), 2000);
      check("the choice made AFTER the outage applies authoritatively", isApplied);
      check("pick released the pause", !world.state.pendingBlessings.has(pid));
      bot.stop();
    } finally { await s.close(); }
  });

  await test("drop AT THE EXIT: no false descend, no deadlock — the party moves when ready and carries the body", async () => {
    const s = await startTestServer({ resumeGraceMs: 4000 });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "exit-a", world: "room:EXIT", name: "Ada", script: () => idle(), reconnect: { ...FAST, graceMs: 4000 } });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "exit-b", world: "room:EXIT", name: "Bob", script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:EXIT")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const bobPid = bob.transport.getSelfServerId()!;

      // Clear the floor and put Ada ON the exit; Bob stays at spawn.
      world.state.enemies.length = 0;
      world.state.pendingSpawns.length = 0;
      const exit = world.state.dungeon.exit;
      const pa = world.state.players.get(adaPid)!;
      pa.x = exit.x * TILE + TILE / 2;
      pa.y = exit.y * TILE + TILE / 2;

      // Ada disconnects while standing on the exit.
      ada.dropConnection(true);
      await waitUntil(() => world.state.players.get(adaPid)?.isAbsent === true, 2000);
      await sleep(400);
      check("her disconnect alone descends nothing (no false descend)", world.state.floor === 1 && world.state.pendingBlessings.size === 0,
        `floor=${world.state.floor}`);

      // Bob walks to the exit: the ABSENT body neither blocks nor stands in — Bob's offer
      // gate raises for Bob ONLY, and his pick descends the party.
      const pb = world.state.players.get(bobPid)!;
      pb.x = pa.x; pb.y = pa.y;
      await waitUntil(() => bob.transport.getPendingOfferPeek() !== null, 3000);
      check("the exit offer raised for the PRESENT player only", bob.transport.getPendingOfferPeek() !== null
        && world.state.pendingBlessings.has(bobPid) && !world.state.pendingBlessings.has(adaPid));
      const offer = bob.transport.consumePendingOffer()!;
      bob.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      const isDescended = await waitUntil(() => world.state.floor === 2, 3000);
      check("the present player descends (an absent member cannot hold the party hostage)", isDescended, `floor=${world.state.floor}`);
      check("the reserved body was carried to the new floor (still one party)", world.state.players.size === 2 && world.state.players.get(adaPid)?.isAbsent === true);

      // Ada resumes ON floor 2 with her body.
      ada.restoreNetwork();
      const isBack = await waitUntil(() => !ada.transport.getReconnectInfo().isReconnecting && ada.transport.getLatestSnapshot()?.floor === 2, 5000);
      check("she resumes on the NEW floor with the same identity", isBack && ada.transport.getSelfServerId() === adaPid,
        `floor=${ada.transport.getLatestSnapshot()?.floor}`);
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("teammates play on: ticks advance, the ghost is explicit, and no false wipe — until the grace truly expires", async () => {
    const graceMs = 1500;
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "wipe-a", world: "room:WIPE", name: "Ada", script: () => idle() });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "wipe-b", world: "room:WIPE", name: "Bob", script: () => idle(), reconnect: { ...FAST, graceMs } });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:WIPE")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const bobPid = bob.transport.getSelfServerId()!;

      // Bob drops (stays dark past his grace). Ada keeps playing.
      bob.dropConnection(true);
      await waitUntil(() => world.state.players.get(bobPid)?.isAbsent === true, 2000);
      const tickAtDrop = world.state.tick;
      const isGhostSeen = await waitUntil(() => {
        const remote = ada.transport.remotePlayers().find((r) => r.playerId === bobPid);
        return remote?.isAbsent === true;
      }, 2000);
      check("Ada sees Bob as an explicit reconnecting ghost (ab on the wire)", isGhostSeen);
      const rosterAway = ada.transport.getWorldRoster().find((r) => r.aid === "wipe-b");
      check("the roster shows Bob AWAY (readiness integrates the outage)", rosterAway?.st === "away", `st=${rosterAway?.st}`);

      // Ada goes down while Bob is absent-but-alive: DOWN, not a wipe — Bob could return.
      const pa = world.state.players.get(adaPid)!;
      pa.hp = 0.5;
      pa.invuln = 0;
      const slime = world.state.enemies.find(() => true);
      if (slime) { slime.x = pa.x; slime.y = pa.y; }
      await waitUntil(() => world.state.players.get(adaPid)?.isDown === true, 4000);
      check("last connected player went DOWN, not game over (absent ally counts as standing)",
        world.state.players.get(adaPid)?.isDown === true && world.state.isRunOver === false);
      check("world kept simulating through the outage", world.state.tick > tickAtDrop);

      // Bob's grace expires -> authoritative leave -> NOW the stranded wipe applies. The
      // client-observable proof is Ada's REAL game-over close (the world itself is reset +
      // released moments later, so poll the transport, not the released world object).
      const isWiped = await waitUntil(() => ada.transport.getCloseKind() === "game_over", graceMs + 3000);
      check("after the grace expires the leave lifecycle applies and the stranded wipe ends the run", isWiped, `kind=${ada.transport.getCloseKind()}`);
      check("the expired member was removed (teammates saw the explicit disconnect)", !world.state.players.has(bobPid));
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("flaky network (latency + jitter + 25% loss + repeated drops) still converges to ONE resumed body", async () => {
    const s = await startTestServer({ resumeGraceMs: 6000 });
    try {
      const bot = new Bot({
        url: s.url, secret: s.secret, playerId: "flaky-id", world: "room:FLKY", script: () => idle(),
        net: { rttMs: 60, jitterMs: 25, loss: 0.25 },
        reconnect: { ...FAST, graceMs: 6000 },
      });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 5000);
      const world = s.server.getWorld("room:FLKY")!;
      const pid = bot.transport.getSelfServerId()!;
      world.state.players.get(pid)!.coins = 777;

      for (let i = 0; i < 3; i++) {
        await sleep(250);
        bot.dropConnection(false); // instant retry, but every frame rolls the 25% loss dice
      }
      const isSettled = await waitUntil(() => {
        const snap = bot.transport.getLatestSnapshot();
        return !bot.transport.getReconnectInfo().isReconnecting && snap !== null && snap.self?.coins === 777
          && s.server.getWorld("room:FLKY")?.playerCount === 1;
      }, 10000);
      check("converged: resumed, same coins, exactly one body", isSettled,
        `players=${s.server.getWorld("room:FLKY")?.playerCount} coins=${bot.transport.getLatestSnapshot()?.self?.coins}`);
      check("same identity throughout", bot.transport.getSelfServerId() === pid);
      check("no forged/replayed rejections tripped (clean resumes only)", s.server.health().counters.resumesRejected === 0);
      bot.stop();
    } finally { await s.close(); }
  });

  await test("server restart: in-memory seats are gone BY DESIGN — reconnecting clients get the explicit expired answer", async () => {
    const graceMs = 8000;
    const first = await startTestServer({ resumeGraceMs: graceMs });
    const port = first.port;
    const bot = new Bot({ url: first.url, secret: first.secret, playerId: "restart-id", world: "room:RSRT", script: () => idle(), reconnect: { ...FAST, graceMs } });
    try {
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      bot.dropConnection(true);
      await sleep(150);
      await first.close();

      // The replacement process boots on the SAME address with NO seats (they are in-memory).
      const cfg = { ...loadConfig({}), host: "127.0.0.1", port, auth: { secret: first.secret, allowDev: true }, resumeGraceMs: graceMs };
      const second = new GameServer(cfg, { logger: createLogger({ app: "gs-restart" }, "error") });
      await second.listen();
      try {
        bot.restoreNetwork();
        const isTerminal = await waitUntil(() => bot.transport.getCloseKind() !== null, 8000);
        check("the resume is answered, not black-holed", isTerminal, `kind=${bot.transport.getCloseKind()}`);
        check("restart resolves as connection_lost via resume_expired (documented lifecycle)",
          bot.transport.getCloseKind() === "connection_lost" && (bot.transport.lastError ?? "").includes("resume_expired"),
          bot.transport.lastError ?? "");
        check("the replacement server counted the expired resume", second.health().counters.resumesExpired >= 1);
      } finally {
        bot.stop();
        await second.close();
      }
    } catch (err) {
      bot.stop();
      throw err;
    }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll reconnect grace / session resume assertions passed.\n");
}

void main();
