// Blessing-offer expiry suite — the P0 "stranded descent" audit fix. An unanswered online
// offer must resolve AUTHORITATIVELY when its TTL runs out: the sim's pending entry and the
// connection/seat offer clear on the SAME tick (the blessingExpired event is the sync), the
// party-wait state every client sees is identical and bounded, and the descend gate can
// never be held past the TTL. Late/duplicate choices are rejected at every layer.
// Drives REAL WSTransport clients against an in-process server. Cases:
//   1. offers expire with no message -> BOTH sides cleared, expiry events delivered, the
//      party-wait readout identical on every shared tick and non-increasing, descend proceeds
//   2. a choice after expiry is rejected at the router AND the room (no post-expiry grant);
//      a duplicate/replayed choice never double-applies
//   3. 3 players at the gate: two choose, one expires — everyone descends, nobody stuck
//   4. a disconnect during the offer: the TTL keeps running, the SEAT's offer dies with it,
//      and a resume resurrects nothing
// Run: npm run test:offerexpiry (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { TILE } from "../../src/sim/types.js";
import type { ServerMsg } from "../../src/net/protocol.js";
import { WSTransport } from "../../src/client/wsTransport.js";
import type { Conn } from "../src/connection.js";

type Snap = Extract<ServerMsg, { t: "snap" }>;

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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Per-tick snapshot capture (broadcasts only) for cross-client wait-state comparison.
class SnapshotLog {
  readonly byTick = new Map<number, Snap>();
  private timer: ReturnType<typeof setInterval>;
  constructor(transport: WSTransport) {
    this.timer = setInterval(() => {
      const s = transport.getLatestSnapshot();
      if (s && !s.full && !this.byTick.has(s.tick)) this.byTick.set(s.tick, s);
    }, 4);
  }
  stop(): void {
    clearInterval(this.timer);
  }
}

async function main(): Promise<void> {
  await test("unanswered offers expire: both sides clear, wait state agrees everywhere, descend proceeds", async () => {
    const s = await startTestServer();
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "exp-a", world: "room:EXP1", name: "Ada", script: () => idle() });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "exp-b", world: "room:EXP1", name: "Bob", script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const world = s.server.getWorld("room:EXP1")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const bobPid = bob.transport.getSelfServerId()!;

      // Clear the floor and gather the party at the exit — the REAL gate raises the offers.
      world.state.enemies.length = 0;
      world.state.pendingSpawns.length = 0;
      const exit = world.state.dungeon.exit;
      for (const pid of [adaPid, bobPid]) {
        const p = world.state.players.get(pid)!;
        p.x = exit.x * TILE + TILE / 2;
        p.y = exit.y * TILE + TILE / 2;
      }
      await waitUntil(() => ada.transport.getPendingOfferPeek() !== null && bob.transport.getPendingOfferPeek() !== null, 3000);
      check("the exit gate raised both offers (clients see them)", world.state.pendingBlessings.size === 2);
      check("the wait state is on the wire for everyone", ada.transport.getPartyWait().length === 2 && bob.transport.getPartyWait().length === 2);

      // Nobody answers. Shorten the authoritative TTLs; the expiry must resolve EVERYTHING.
      const logA = new SnapshotLog(ada.transport);
      const logB = new SnapshotLog(bob.transport);
      world.state.pendingBlessings.set(adaPid, 0.6);
      world.state.pendingBlessings.set(bobPid, 0.9);
      const isDescended = await waitUntil(() => world.state.floor === 2, 4000);
      logA.stop(); logB.stop();
      check("descend proceeded once the offers expired (the gate can NEVER be held past the TTL)", isDescended, `floor=${world.state.floor}`);
      check("sim pending map is empty", world.state.pendingBlessings.size === 0);
      const conns = [...world.conns.values()] as Conn[];
      check("both connection offers were cleared by the expiry (not by a late choose)", conns.every((c) => c.pendingOffer === null));
      check("expiries were counted", s.server.health().counters.offersExpired === 2, `expired=${s.server.health().counters.offersExpired}`);
      const isDelivered = await waitUntil(() => ada.events.some((e) => e.t === "blessingExpired") && bob.events.some((e) => e.t === "blessingExpired"), 2000);
      check("each owner received its blessingExpired event", isDelivered);
      check("nobody was granted a forfeited pick", (ada.transport.getLatestSnapshot()?.self?.items.length ?? -1) === 0
        && (bob.transport.getLatestSnapshot()?.self?.items.length ?? -1) === 0);

      // Party-wait consistency: identical on every shared tick, non-increasing, empty at the end.
      const shared = [...logA.byTick.keys()].filter((t) => logB.byTick.has(t)).sort((a, b) => a - b);
      check("clients share wait-state ticks", shared.length >= 5, `shared=${shared.length}`);
      let isIdentical = true;
      const lastSeen = new Map<string, number>();
      let isMonotonic = true;
      for (const t of shared) {
        const wa = logA.byTick.get(t)!.wait;
        const wb = logB.byTick.get(t)!.wait;
        if (!deepEqual(wa, wb)) { isIdentical = false; break; }
        for (const w of wa) {
          const prev = lastSeen.get(w.pid);
          if (prev !== undefined && w.s > prev) isMonotonic = false;
          lastSeen.set(w.pid, w.s);
        }
      }
      check("wait state identical on every shared tick (party-wait countdown consistent)", isIdentical);
      check("countdowns never increase", isMonotonic);
      check("wait state resolves to empty for everyone", (ada.transport.getPartyWait().length === 0) && (bob.transport.getPartyWait().length === 0));

      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("a choice after expiry is rejected at every layer; a duplicate choice never double-applies", async () => {
    const s = await startTestServer();
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "late-id", world: "room:EXP2", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld("room:EXP2")!;
      const pid = bot.transport.getSelfServerId()!;
      const conn = [...world.conns.values()][0];

      // An offer whose CONNECTION deadline is generous but whose sim TTL is short — the sim
      // clock is the single authority, so expiry must win regardless of the conn deadline.
      const choices = world.rollBlessingChoices(pid, false);
      conn.pendingOffer = choices;
      conn.offerId = 1;
      conn.offerResendsLeft = 40;
      conn.offerDeadline = Date.now() + 60000;
      world.state.pendingBlessings.set(pid, 0.4);
      await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);

      await waitUntil(() => conn.pendingOffer === null, 2000);
      check("expiry cleared the connection offer despite the far conn deadline", conn.pendingOffer === null);
      const rejectedBefore = s.server.health().counters.rejectedInputs;
      // The client (which still holds the stale offer UI-side) answers late.
      const stale = bot.transport.consumePendingOffer()!;
      bot.transport.sendChooseBlessing(stale.id, stale.choices[0]);
      await sleep(250);
      check("late choose REJECTED at the router", s.server.health().counters.rejectedInputs > rejectedBefore);
      check("no post-expiry grant", (bot.transport.getLatestSnapshot()?.self?.items.length ?? -1) === 0);
      check("the room gate rejects a direct late apply too", world.applyBlessing(pid, choices[0]) === false);

      // A fresh offer answered in time applies EXACTLY once — the duplicate is dropped.
      const choices2 = world.rollBlessingChoices(pid, false);
      conn.pendingOffer = choices2;
      conn.offerId = 2;
      conn.offerResendsLeft = 40;
      conn.offerDeadline = Date.now() + 60000;
      world.state.pendingBlessings.set(pid, 30);
      await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);
      const offer = bot.transport.consumePendingOffer()!;
      bot.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      const isApplied = await waitUntil(() => (bot.transport.getLatestSnapshot()?.self?.items ?? []).includes(offer.choices[0]), 2000);
      check("in-time choice applied", isApplied);
      bot.transport.sendChooseBlessing(offer.id, offer.choices[0]); // replay
      await sleep(250);
      check("replayed choice did not double-apply", (bot.transport.getLatestSnapshot()?.self?.items.length ?? -1) === 1);
      check("pick resolved the pending state (descend gate free)", !world.state.pendingBlessings.has(pid));

      bot.stop();
    } finally { await s.close(); }
  });

  await test("three players at the gate: two choose, one expires — everyone descends together", async () => {
    const s = await startTestServer();
    try {
      const bots = ["a", "b", "c"].map((k) => new Bot({ url: s.url, secret: s.secret, playerId: `trio-${k}`, world: "room:EXP3", name: k.toUpperCase(), script: () => idle() }));
      for (const b of bots) b.start();
      await waitUntil(() => bots.every((b) => b.transport.isReady()), 4000);
      const world = s.server.getWorld("room:EXP3")!;
      const pids = bots.map((b) => b.transport.getSelfServerId()!);

      world.state.enemies.length = 0;
      world.state.pendingSpawns.length = 0;
      const exit = world.state.dungeon.exit;
      for (const pid of pids) {
        const p = world.state.players.get(pid)!;
        p.x = exit.x * TILE + TILE / 2;
        p.y = exit.y * TILE + TILE / 2;
      }
      await waitUntil(() => bots.every((b) => b.transport.getPendingOfferPeek() !== null), 3000);

      // A and B answer; C walks away from the keyboard.
      for (const b of [bots[0], bots[1]]) {
        const offer = b.transport.consumePendingOffer()!;
        b.transport.sendChooseBlessing(offer.id, offer.choices[0]);
      }
      world.state.pendingBlessings.set(pids[2], 0.8);
      const isDescended = await waitUntil(() => world.state.floor === 2, 4000);
      check("the party descended once the last offer expired (no stranded gate)", isDescended, `floor=${world.state.floor}`);
      check("the choosers kept their picks", bots.slice(0, 2).every((b) => (b.transport.getLatestSnapshot()?.self?.items.length ?? 0) === 1));
      check("the sleeper was NOT granted a pick", (bots[2].transport.getLatestSnapshot()?.self?.items.length ?? -1) === 0);
      check("exactly one expiry counted", s.server.health().counters.offersExpired === 1);
      // The authoritative descend already happened (checked above via world.state.floor); each
      // bot's SNAPSHOT floor catches up a tick later, so wait for propagation instead of racing it.
      const allSnapsOnFloor2 = await waitUntil(() => bots.every((b) => b.transport.getLatestSnapshot()?.floor === 2), 3000);
      check("everyone landed on floor 2 together", allSnapsOnFloor2);

      for (const b of bots) b.stop();
    } finally { await s.close(); }
  });

  await test("disconnect during the offer: the TTL keeps running, the seat's offer dies with it, resume resurrects nothing", async () => {
    const s = await startTestServer({ resumeGraceMs: 5000 });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "away-id", world: "room:EXP4", script: () => idle(), reconnect: { baseDelayMs: 80, maxDelayMs: 250, graceMs: 5000 } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld("room:EXP4")!;
      const pid = bot.transport.getSelfServerId()!;
      const conn = [...world.conns.values()][0];
      const choices = world.rollBlessingChoices(pid, false);
      conn.pendingOffer = choices;
      conn.offerId = 1;
      conn.offerResendsLeft = 40;
      conn.offerDeadline = Date.now() + 60000;
      world.state.pendingBlessings.set(pid, 0.6);
      await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);

      // Drop mid-offer and stay dark PAST the TTL: the seat preserves the offer, then the
      // expiry clears it off the seat — an absent player cannot outlive the party's gate.
      bot.dropConnection(true);
      await waitUntil(() => world.state.players.get(pid)?.isAbsent === true, 2000);
      await waitUntil(() => !world.state.pendingBlessings.has(pid), 2000);
      check("the offer expired while the player was away (gate released)", !world.state.pendingBlessings.has(pid));

      bot.restoreNetwork();
      const isBack = await waitUntil(() => !bot.transport.getReconnectInfo().isReconnecting && bot.transport.getLatestSnapshot() !== null && world.playerCount === 1 && [...world.conns.values()].length === 1, 4000);
      check("resumed", isBack);
      const resumedConn = [...world.conns.values()][0];
      check("the resume did NOT resurrect the expired offer (seat copy was cleared)", resumedConn.pendingOffer === null);
      await sleep(300);
      check("no offer message was re-sent to the client", bot.transport.getPendingOfferPeek() === null);
      check("a late choose against the dead offer is rejected", world.applyBlessing(pid, choices[0]) === false
        && (bot.transport.getLatestSnapshot()?.self?.items.length ?? -1) === 0);
      bot.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll blessing-offer expiry assertions passed.\n");
}

void main();
