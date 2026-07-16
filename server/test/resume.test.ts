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
//      converges to a single resumed body with the same state — including a seeded stress
//      gate whose drop schedules sweep the whole reconnect handshake (the token-rotation
//      ack window included) and demand zero rejections across every iteration
//   7. a server RESTART loses in-memory seats BY DESIGN: the reconnecting client gets
//      resume_expired and lands terminal connection_lost (documented in MULTIPLAYER.md)
// Run: npm run test:resume (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { LatencySocket, PERFECT_NET } from "../harness/latencySocket.js";
import { GameServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { mintTicket } from "../src/auth.js";
import { WSTransport } from "../../src/client/wsTransport.js";
import { jsonCodec, PROTOCOL_VERSION, RESUME_GRACE_MS } from "../../src/net/protocol.js";
import { devSpawnEnemy } from "../../src/sim/world.js";
import { TILE } from "../../src/sim/types.js";
import { Rng } from "../../src/sim/rng.js";
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
  // The studio balance gate's reconnect contract (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md
  // §6): 90s reservation, absent bodies safe within 3s of disconnect detection.
  check("production grace default is 90s (balance gate §6)", RESUME_GRACE_MS === 90000 && loadConfig({}).resumeGraceMs === 90000);
  check("silent-drop detection defaults to 3s, under a 2s heartbeat cadence",
    loadConfig({}).absenceDetectMs === 3000 && loadConfig({}).heartbeatMs === 2000);

  await test("drops early / mid / at the grace edge resume the exact body (scaled 1s/5s/24s-of-25s)", async () => {
    const graceMs = 2500;
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      let requestedKit = "phantom";
      let requestedPet: string | undefined = "doggie";
      const bot = new Bot({
        url: s.url,
        secret: s.secret,
        playerId: "resume-id",
        script: () => idle(),
        reconnect: { ...FAST, graceMs },
        ticketClaims: () => ({
          worldId: "room:RSME",
          name: "Blipper",
          colorIndex: 3,
          kit: requestedKit,
          masteryLevel: 5,
          pet: requestedPet,
          isPetChoiceMade: true,
        }),
      });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld("room:RSME")!;
      const pid = bot.transport.getSelfServerId()!;
      check("the active run starts with its validated Phantom + Doggie pair",
        world.state.players.get(pid)?.kitId === "phantom"
        && [...world.conns.values()][0]?.pet === "doggie");
      requestedKit = "gunner";
      requestedPet = undefined;

      // A run worth losing: coins, FRACTIONAL damage taken (an exact-state resume proves no
      // heal and no rounding), an extra weapon, stacked blessings, and a position away from
      // spawn — every field must survive every outage below exactly.
      const p = world.state.players.get(pid)!;
      p.coins = 137; p.hp = 1.5; p.x += TILE; p.y += TILE / 2;
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
        check(`[${outageMs}ms] exact state: fractional hp (no heal/rounding)/coins/weapons/blessings/floor/position`,
          self !== null && self !== undefined
          && self.hp === 1.5 && self.coins === 137
          && self.wpns.includes("tesla")
          && self.items.filter((it) => it === "it_dmg").length === 2
          && bot.transport.getLatestSnapshot()!.floor === 1
          && Math.abs(self.x - wantX) < 1 && Math.abs(self.y - wantY) < 1,
          `hp=${self?.hp} coins=${self?.coins}`);
        check(`[${outageMs}ms] body is present again (targetable/damageable)`, world.state.players.get(pid)?.isAbsent === false);
        check(`[${outageMs}ms] reconnect ignores changed ticket convenience and restores the run-bound pair`,
          world.state.players.get(pid)?.kitId === "phantom"
          && [...world.conns.values()][0]?.kitId === "phantom"
          && [...world.conns.values()][0]?.pet === "doggie");
        const seat = bot.transport.getWorldRoster().find((r) => r.aid === "resume-id");
        check(`[${outageMs}ms] the resumed player keeps their real identity (name + chosen color)`,
          seat?.nm === "Blipper" && seat?.cl === 3, `nm=${seat?.nm} cl=${seat?.cl}`);
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

      // Wait until the victim's post-resume input CONFIRMED receipt of the rotated token:
      // that is the moment the previous token dies. (Until then the server deliberately
      // honors it — rotation-ack ordering — so the replay must come after confirmation to
      // assert the security property, exactly like a real capture-and-replay would.)
      await waitUntil(() => [...(s.server.getWorld("room:STLN")?.conns.values() ?? [])].some((c) => c.isResumeTokenConfirmed), 2000);

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

  await test("teammates play on: ticks advance, the ghost is explicit — and a reservation never blocks the wipe (gate §6)", async () => {
    const graceMs = 8000; // long on purpose: the wipe below must NOT wait for it
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "wipe-a", world: "room:WIPE", name: "Ada", script: () => idle() });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "wipe-b", world: "room:WIPE", name: "Bob", colorIndex: 5, script: () => idle(), reconnect: { ...FAST, graceMs } });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:WIPE")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const bobPid = bob.transport.getSelfServerId()!;

      // Bob drops (network stays dark). Ada keeps playing.
      bob.dropConnection(true);
      await waitUntil(() => world.state.players.get(bobPid)?.isAbsent === true, 2000);
      const tickAtDrop = world.state.tick;
      const isGhostSeen = await waitUntil(() => {
        const remote = ada.transport.remotePlayers().find((r) => r.playerId === bobPid);
        return remote?.isAbsent === true;
      }, 2000);
      check("Ada sees Bob as an explicit reconnecting ghost (ab on the wire)", isGhostSeen);
      const ghost = ada.transport.remotePlayers().find((r) => r.playerId === bobPid);
      check("the ghost keeps Bob's verified identity (name + color, never a degraded/guessed tint)",
        ghost?.name === "Bob" && ghost?.colorIndex === 5, `nm=${ghost?.name} cl=${ghost?.colorIndex}`);
      const rosterAway = ada.transport.getWorldRoster().find((r) => r.aid === "wipe-b");
      check("the roster shows Bob AWAY (readiness integrates the outage)", rosterAway?.st === "away", `st=${rosterAway?.st}`);
      check("the AWAY seat keeps Bob's color for the whole grace window", rosterAway?.cl === 5, `cl=${rosterAway?.cl}`);
      check("Bob's mere disconnect wiped nothing (an absent body is not a death)", world.state.isRunOver === false);
      await sleep(200);
      check("world kept simulating through the outage", world.state.tick > tickAtDrop);

      // Ada — the whole CONNECTED party — dies. Balance gate §6: pending reconnect
      // reservations do NOT block the wipe; the run ends NOW, not after Bob's 8s grace.
      const pa = world.state.players.get(adaPid)!;
      pa.hp = 0.5;
      pa.invuln = 0;
      const slime = world.state.enemies.find(() => true);
      if (slime) { slime.x = pa.x; slime.y = pa.y; }
      const isWiped = await waitUntil(() => ada.transport.getCloseKind() === "game_over", 5000);
      check("all connected players down -> the wipe applies immediately (reservation does not block it)", isWiped, `kind=${ada.transport.getCloseKind()}`);

      // Bob comes back INSIDE his grace — into the truth: the run is over. He sees the wipe
      // (over-state snapshot), never a resurrected private run.
      bob.restoreNetwork();
      const isBackToOver = await waitUntil(() => bob.transport.getLatestSnapshot()?.over === true, 5000);
      check("the reserved member resumes into the over-state (sees the wipe, no divergent run)", isBackToOver);
      check("the transport flags it as RESUMED-INTO-OVER (the game shows RUN ENDED WHILE AWAY, records nothing)",
        bob.transport.getIsResumedIntoOver() === true);
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("silent link (gate §6: safe within 3s of detection): body pauses without a socket close and traffic restores it", async () => {
    // No server pings (huge heartbeat) so the ONLY inbound traffic is what this test sends.
    const s = await startTestServer({ absenceDetectMs: 250, heartbeatMs: 60000 });
    try {
      const transport = new WSTransport({
        url: s.url,
        getTicket: () => Promise.resolve(mintTicket(s.secret, "quiet-id", 120, Date.now(), { worldId: "room:QUIE" })),
        socketFactory: (url) => new LatencySocket(url, PERFECT_NET),
      });
      transport.start();
      await waitUntil(() => transport.isReady(), 3000);
      const world = s.server.getWorld("room:QUIE")!;
      const pid = transport.getSelfServerId()!;
      const conn = [...world.conns.values()][0];

      // Drive a few input frames (inbound traffic), then go COMPLETELY silent — the socket
      // stays open the whole time.
      for (let i = 0; i < 4; i++) { transport.sendInput(idle()); transport.advance(0.06); await sleep(30); }
      check("body present while the link talks", world.state.players.get(pid)?.isAbsent === false);

      const isPaused = await waitUntil(() => world.state.players.get(pid)?.isAbsent === true, 2000);
      check("silence past the window pauses the body (safe) with the socket still OPEN", isPaused && world.conns.size === 1 && conn.isSoftAbsent);
      check("no seat was reserved (the connection is alive, just quiet)", s.server.health().counters.seatsReserved === 0);
      // Snapshots keep flowing to the quiet client; its roster seat reads away for everyone.
      const isAwayOnRoster = await waitUntil(() => transport.getWorldRoster().find((r) => r.aid === "quiet-id")?.st === "away", 1000);
      check("the roster seat reads AWAY while the link is silent", isAwayOnRoster);

      // One frame of traffic restores the body instantly.
      transport.sendInput(idle());
      transport.advance(0.06);
      const isRestored = await waitUntil(() => world.state.players.get(pid)?.isAbsent === false, 1000);
      check("the next inbound frame restores the body", isRestored && !conn.isSoftAbsent);
      transport.stop();
    } finally { await s.close(); }
  });

  await test("no boss/party rescale during a reservation (gate §6): boss HP and encounter scaling are untouched", async () => {
    const graceMs = 700;
    const s = await startTestServer({ resumeGraceMs: graceMs });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "boss-a", world: "room:BOSS", name: "Ada", script: () => idle(), reconnect: { ...FAST, graceMs } });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "boss-b", world: "room:BOSS", name: "Bob", script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:BOSS")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const pa = world.state.players.get(adaPid)!;
      const boss = devSpawnEnemy(world.state, "boss", pa.x + 400, pa.y);
      const bossMaxHp = boss.maxHp;
      const bossHp = boss.hp;
      const encounterBefore = world.state.encounterPlayers;

      // Mid-pull disconnect: the reservation must rescale NOTHING.
      ada.dropConnection(true);
      await waitUntil(() => world.state.players.get(adaPid)?.isAbsent === true, 2000);
      await sleep(250);
      check("boss HP untouched by the disconnect (no rescale, no heal)", boss.hp === bossHp && boss.maxHp === bossMaxHp,
        `hp=${boss.hp}/${boss.maxHp}`);
      check("encounter scaling untouched during the reservation", world.state.encounterPlayers === encounterBefore);

      // Even the EXPIRY mid-floor rescales nothing — floor scaling is snapshotted at build
      // and never re-rolls living enemies (the next floor build is the rescale point).
      const isExpired = await waitUntil(() => !world.state.players.has(adaPid), graceMs + 1500);
      check("seat expired (authoritative leave mid-pull)", isExpired);
      check("boss STILL untouched after the expiry (no mid-floor rescale)", boss.hp === bossHp && boss.maxHp === bossMaxHp);
      check("encounter scaling STILL untouched mid-floor", world.state.encounterPlayers === encounterBefore);
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("flaky network (latency + jitter + 25% loss + repeated drops) still converges to ONE resumed body", async () => {
    const s = await startTestServer({ resumeGraceMs: 6000 });
    try {
      const netRng = new Rng(0xF1A6);
      const bot = new Bot({
        url: s.url, secret: s.secret, playerId: "flaky-id", world: "room:FLKY", script: () => idle(),
        net: { rttMs: 60, jitterMs: 25, loss: 0.25, random: () => netRng.next() },
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

  // The stress gate for the token-rotation ack race: drops are scheduled at SEEDED offsets
  // that sweep every phase of the reconnect handshake — mid-backoff, mid-join-uplink, and the
  // window between the server rotating the seat token and the client receiving it (the race
  // that flaked build-release: the client's only credential was the previous token, and the
  // old strict match rejected it as a replay -> terminal lockout -> seat expiry -> world
  // released). Every iteration must converge to exactly one clean body with zero rejections;
  // convergence is AWAITED explicitly (state predicates), never assumed from timers. The
  // seeded net RNG makes a failing seed re-runnable. GS_TEST_STRESS_SEEDS raises the seed
  // count for local soak runs (50-200 reproduction-grade iterations).
  await test("stress gate: seeded flaky-network drop schedules across the whole handshake always resume cleanly", async () => {
    const seedCount = Math.max(1, Number(process.env.GS_TEST_STRESS_SEEDS ?? 3));
    const DROPS_PER_SEED = 10;
    for (let i = 0; i < seedCount; i++) {
      const seed = 0xBEEF + i * 7919;
      const rng = new Rng(seed);
      const s = await startTestServer({ resumeGraceMs: 6000 });
      try {
        const bot = new Bot({
          url: s.url, secret: s.secret, playerId: "stress-id", world: "room:STRS", script: () => idle(),
          net: { rttMs: 60, jitterMs: 25, loss: 0.25, random: () => rng.next() },
          reconnect: { ...FAST, graceMs: 6000 },
        });
        bot.start();
        await waitUntil(() => bot.transport.isReady(), 5000);
        const world = s.server.getWorld("room:STRS")!;
        const pid = bot.transport.getSelfServerId()!;
        world.state.players.get(pid)!.coins = 777;

        // Seeded gaps in [40, 300)ms: with ~80ms backoff plus ~30ms one-way latency per leg,
        // these land drops before, during, and just after each resume handshake.
        for (let k = 0; k < DROPS_PER_SEED; k++) {
          await sleep(40 + Math.floor(rng.next() * 260));
          bot.dropConnection(false);
        }
        const isSettled = await waitUntil(() => {
          const snap = bot.transport.getLatestSnapshot();
          return !bot.transport.getReconnectInfo().isReconnecting && snap !== null && snap.self?.coins === 777
            && s.server.getWorld("room:STRS")?.playerCount === 1;
        }, 10000);
        const c = s.server.health().counters;
        check(`[seed ${seed.toString(16)}] converged: resumed, exact state, exactly one body`, isSettled,
          `players=${s.server.getWorld("room:STRS")?.playerCount} coins=${bot.transport.getLatestSnapshot()?.self?.coins} closeKind=${bot.transport.getCloseKind()}`);
        check(`[seed ${seed.toString(16)}] same identity throughout`, bot.transport.getSelfServerId() === pid);
        check(`[seed ${seed.toString(16)}] zero rejections and zero expiries for clean resume attempts`,
          c.resumesRejected === 0 && c.resumesExpired === 0,
          `rejected=${c.resumesRejected} expired=${c.resumesExpired} prevTokenResumes=${c.resumesPrevToken}`);
        bot.stop();
      } finally { await s.close(); }
    }
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
