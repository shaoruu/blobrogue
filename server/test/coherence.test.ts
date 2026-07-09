// Full-world coherence + room-readiness suite — the permanent regression net for the Sev-0
// room divergence (two players believed they shared a room; only one had actually joined the
// authoritative world, so they fought different enemies and saw different drops).
//
// Drives REAL WSTransport clients against an in-process server (tickets minted exactly like
// the production Convex minter) and locks:
//   1. two clients in one room receive IDENTICAL world snapshots tick-for-tick with interest
//      off (default): same seed/floor/rev/wid/cleared, same enemies (stable ids/kinds/
//      positions), same pickups/chests/props/bullets — identical modulo self/player fields —
//      and each sees the other's EXACT position and verified name/color (nm/cl)
//   2. the Sev-0 repro: a member that never joins holds the readiness gate WAITING (the host
//      can never enter a separate run), then FAILED naming the absent member; once the member
//      joins, the gate opens and both share one world
//   3. world-binding assertion: a client expecting room A that gets bound to room B closes
//      the socket and never becomes ready (never plays in the wrong world)
//   4. duplicate identity (second tab): the newer connection supersedes the older one in the
//      same world — never two blobs of one member — and the room's run is NOT reset
//   5. interest filtering (explicitly enabled) stays COHERENT: co-located clients see
//      identical entity sets; separated clients differ only by distance; seed/floor/rev/wid/
//      cleared and the roster stay identical regardless — the criteria gate for re-enabling
//      GS_INTEREST_RADIUS in production
// Run: npm run test:coherence (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { LatencySocket, PERFECT_NET } from "../harness/latencySocket.js";
import { mintTicket } from "../src/auth.js";
import { WSTransport } from "../../src/client/wsTransport.js";
import { PartyGate } from "../../src/net/partyGate.js";
import { INTEREST_EXIT_FACTOR, type ServerMsg } from "../../src/net/protocol.js";
import { TILE } from "../../src/sim/types.js";

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

// Record every distinct-tick BROADCAST snapshot a transport receives, so two clients can be
// compared on exactly the same authoritative tick. Join-time full snapshots are skipped:
// two joins inside one tick legitimately see different rosters mid-handshake.
class SnapshotLog {
  readonly byTick = new Map<number, Snap>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private transport: WSTransport) {
    this.timer = setInterval(() => {
      const s = this.transport.getLatestSnapshot();
      if (s && !s.full && !this.byTick.has(s.tick)) this.byTick.set(s.tick, s);
    }, 4);
  }
  sharedTicks(other: SnapshotLog): number[] {
    return [...this.byTick.keys()].filter((t) => other.byTick.has(t)).sort((a, b) => a - b);
  }
  stop(): void {
    clearInterval(this.timer);
  }
}

// The world-content projection two same-room clients must agree on EXACTLY (everything in a
// snapshot except the per-recipient fields: ackSeq, selfId, self, players, events, evTo).
type WorldView = Pick<Snap, "tick" | "rev" | "wid" | "seed" | "floor" | "cleared" | "over" | "enemies" | "bullets" | "props" | "pickups" | "chests" | "roster">;
function worldFields(s: Snap): WorldView {
  return {
    tick: s.tick, rev: s.rev, wid: s.wid, seed: s.seed, floor: s.floor, cleared: s.cleared, over: s.over,
    enemies: s.enemies, bullets: s.bullets, props: s.props, pickups: s.pickups, chests: s.chests,
    roster: [...s.roster].sort((a, b) => a.aid.localeCompare(b.aid)),
  };
}

async function main(): Promise<void> {
  await test("two real clients, one room: identical world snapshots tick-for-tick (interest off)", async () => {
    const s = await startTestServer(); // default GS_INTEREST_RADIUS=0 — full snapshots
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "ada-id", world: "room:PAIR", name: "Ada", colorIndex: 2, script: () => idle() });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "bob-id", world: "room:PAIR", name: "Bob", colorIndex: 5, script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);
      const logA = new SnapshotLog(ada.transport);
      const logB = new SnapshotLog(bob.transport);
      await sleep(1200);
      logA.stop(); logB.stop();

      const ticks = logA.sharedTicks(logB);
      check("clients share a comparable tick stream", ticks.length >= 10, `shared=${ticks.length}`);
      let isWorldAgreed = true;
      let firstDiff = "";
      for (const t of ticks) {
        const a = worldFields(logA.byTick.get(t)!);
        const b = worldFields(logB.byTick.get(t)!);
        if (!deepEqual(a, b)) { isWorldAgreed = false; firstDiff = `tick ${t}`; break; }
      }
      check("world content identical on EVERY shared tick (seed/floor/rev/wid/cleared/enemies/bullets/props/pickups/chests/roster)", isWorldAgreed, firstDiff);

      const sample = logA.byTick.get(ticks[ticks.length - 1])!;
      check("snapshots carry the room's world id", sample.wid === "room:PAIR", `wid=${sample.wid}`);
      check("floor content present (enemies + props + loot to diverge on)", sample.enemies.length > 0 && sample.props.length > 0, `enemies=${sample.enemies.length} props=${sample.props.length}`);
      const rosterAids = sample.roster.map((r) => r.aid).sort();
      check("server roster lists exactly the two members' verified identities", deepEqual(rosterAids, ["ada-id", "bob-id"]), rosterAids.join(","));

      // Cross-view: each client sees the OTHER at the exact authoritative position, with the
      // exact verified identity (name + chosen color) — the remote color/name regression.
      const t0 = ticks[ticks.length - 1];
      const aSnap = logA.byTick.get(t0)!;
      const bSnap = logB.byTick.get(t0)!;
      const bobSeenByAda = aSnap.players.find((p) => p.id === bSnap.selfId);
      const adaSeenByBob = bSnap.players.find((p) => p.id === aSnap.selfId);
      check("Ada sees Bob at Bob's authoritative position", bobSeenByAda !== undefined && bSnap.self !== null
        && bobSeenByAda.x === bSnap.self.x && bobSeenByAda.y === bSnap.self.y);
      check("Bob sees Ada at Ada's authoritative position", adaSeenByBob !== undefined && aSnap.self !== null
        && adaSeenByBob.x === aSnap.self.x && adaSeenByBob.y === aSnap.self.y);
      check("Ada sees Bob's exact identity (nm/cl)", bobSeenByAda?.nm === "Bob" && bobSeenByAda?.cl === 5, `nm=${bobSeenByAda?.nm} cl=${bobSeenByAda?.cl}`);
      check("Bob sees Ada's exact identity (nm/cl)", adaSeenByBob?.nm === "Ada" && adaSeenByBob?.cl === 2, `nm=${adaSeenByBob?.nm} cl=${adaSeenByBob?.cl}`);
      const remote = bob.transport.remotePlayers()[0];
      check("client render surface carries the exact remote name/color", remote?.name === "Ada" && remote?.colorIndex === 2, `nm=${remote?.name} cl=${remote?.colorIndex}`);
      // The roster agrees with the lobby's expectation surface (same identities and colors).
      const rosterBob = sample.roster.find((r) => r.aid === "bob-id");
      check("roster identity matches the wire identity", rosterBob?.nm === "Bob" && rosterBob?.cl === 5);

      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  await test("Sev-0 repro: a member that never joins holds the gate — the host cannot enter a separate run", async () => {
    const s = await startTestServer();
    try {
      const host = new Bot({ url: s.url, secret: s.secret, playerId: "host-id", world: "room:GATE", name: "Host", script: () => idle() });
      host.start();
      await waitUntil(() => host.transport.isReady(), 3000);

      // The lobby expects TWO members; only the host actually connected (the exact incident).
      const expected = [
        { playerId: "host-id", name: "Host", colorIndex: 0 },
        { playerId: "guest-id", name: "Guest", colorIndex: 3 },
      ];
      const connectedNow = () => new Set(host.transport.getWorldRoster().map((r) => r.aid));

      const gate = new PartyGate("host-id", 700);
      let isReadySeen = false;
      const t0 = Date.now();
      let view = gate.evaluate(t0, expected, connectedNow());
      while (Date.now() - t0 < 650) {
        await sleep(50);
        view = gate.evaluate(Date.now(), expected, connectedNow());
        if (view.phase === "ready") isReadySeen = true;
      }
      check("gate never opened while the guest was absent (host never plays alone)", !isReadySeen && view.phase === "waiting", `phase=${view.phase}`);
      check("host shows CONNECTED, guest shows not-connected", view.members.find((m) => m.playerId === "host-id")?.isConnected === true
        && view.members.find((m) => m.playerId === "guest-id")?.isConnected === false);

      await sleep(150);
      view = gate.evaluate(Date.now(), expected, connectedNow());
      check("past the deadline the gate FAILS explicitly, naming the absent member", view.phase === "failed" && deepEqual(view.missingNames, ["Guest"]), `phase=${view.phase} missing=${view.missingNames.join(",")}`);

      // The member finally joins: a fresh start's gate opens and both share ONE world.
      const guest = new Bot({ url: s.url, secret: s.secret, playerId: "guest-id", world: "room:GATE", name: "Guest", colorIndex: 3, script: () => idle() });
      guest.start();
      const gate2 = new PartyGate("host-id");
      const isOpened = await waitUntil(() => gate2.evaluate(Date.now(), expected, connectedNow()).phase === "ready", 3000);
      check("gate opens once every expected member is connected to the world", isOpened);
      check("both clients are bound to the same authoritative world", host.transport.getWorldId() === "room:GATE" && guest.transport.getWorldId() === "room:GATE");
      check("one shared world holds both players", s.server.getWorld("room:GATE")?.playerCount === 2);

      host.stop(); guest.stop();
    } finally { await s.close(); }
  });

  await test("world-binding assertion: bound to a world other than the expected room -> close, never play", async () => {
    const s = await startTestServer();
    try {
      // The ticket (and so the server binding) names room:OTHER, but this client expects
      // room:WANT — e.g. a stale ticket raced across a room switch. It must never play there.
      const transport = new WSTransport({
        url: s.url,
        getTicket: () => Promise.resolve(mintTicket(s.secret, "lost-player", 120, Date.now(), { worldId: "room:OTHER" })),
        expectedWorldId: "room:WANT",
        socketFactory: (url) => new LatencySocket(url, PERFECT_NET),
      });
      transport.start();
      await waitUntil(() => transport.getWorldMismatch() !== null, 3000);
      await sleep(100); // let the socket-close callbacks land after the mismatch stop
      check("mismatch detected and recorded", deepEqual(transport.getWorldMismatch(), { expected: "room:WANT", got: "room:OTHER" }), JSON.stringify(transport.getWorldMismatch()));
      check("transport never became ready (no frame of wrong-world gameplay)", !transport.isReady());
      check("transport is terminally errored", transport.getStatus() === "error", `status=${transport.getStatus()}`);
      const isReleased = await waitUntil(() => s.server.getWorld("room:OTHER") === undefined, 2000);
      check("server saw the socket close (wrong world emptied + released)", isReleased);
      transport.stop();
    } finally { await s.close(); }
  });

  await test("duplicate identity (second tab): newest connection supersedes; the run is not reset", async () => {
    const s = await startTestServer();
    try {
      const tabOne = new Bot({ url: s.url, secret: s.secret, playerId: "dup-id", world: "room:TABS", name: "TabOne", script: () => idle() });
      tabOne.start();
      await waitUntil(() => tabOne.transport.isReady(), 3000);
      const world = s.server.getWorld("room:TABS");
      const seedBefore = world?.state.seed;

      const tabTwo = new Bot({ url: s.url, secret: s.secret, playerId: "dup-id", world: "room:TABS", name: "TabTwo", script: () => idle() });
      tabTwo.start();
      await waitUntil(() => tabTwo.transport.isReady() && (s.server.getWorld("room:TABS")?.playerCount ?? 0) === 1, 3000);

      check("exactly ONE player remains for the identity (no ghost blob)", s.server.getWorld("room:TABS")?.playerCount === 1, `players=${s.server.getWorld("room:TABS")?.playerCount}`);
      const roster = tabTwo.transport.getWorldRoster();
      check("roster holds the identity once, as the newest tab", roster.length === 1 && roster[0].aid === "dup-id" && roster[0].nm === "TabTwo", JSON.stringify(roster));
      check("older tab's socket was closed", await waitUntil(() => tabOne.transport.getStatus() === "closed", 2000));
      check("the takeover is counted (duplicateIdentityKicks)", s.server.health().counters.duplicateIdentityKicks === 1);
      check("the room's run survived the takeover (same seed — bind before kick)", s.server.getWorld("room:TABS")?.state.seed === seedBefore);

      tabOne.stop(); tabTwo.stop();
    } finally { await s.close(); }
  });

  await test("interest filtering (re-enable candidate config) is coherent: same view co-located, distance-only divergence apart", async () => {
    const RADIUS = 500;
    const s = await startTestServer({ interestRadius: RADIUS });
    try {
      const ada = new Bot({ url: s.url, secret: s.secret, playerId: "ada-i", world: "room:INTR", name: "Ada", script: () => idle() });
      const bob = new Bot({ url: s.url, secret: s.secret, playerId: "bob-i", world: "room:INTR", name: "Bob", script: () => idle() });
      ada.start(); bob.start();
      await waitUntil(() => ada.transport.isReady() && bob.transport.isReady(), 3000);

      // Phase 1 — co-located at spawn: identical entity sets on the same tick.
      const logA = new SnapshotLog(ada.transport);
      const logB = new SnapshotLog(bob.transport);
      await sleep(700);
      const ticks1 = logA.sharedTicks(logB);
      check("co-located clients share ticks", ticks1.length >= 5, `shared=${ticks1.length}`);
      let isSetsIdentical = true;
      for (const t of ticks1) {
        const a = logA.byTick.get(t)!;
        const b = logB.byTick.get(t)!;
        if (!deepEqual(a.enemies, b.enemies) || !deepEqual(a.props, b.props) || !deepEqual(a.pickups, b.pickups) || !deepEqual(a.chests, b.chests)) { isSetsIdentical = false; break; }
      }
      check("co-located clients see IDENTICAL filtered sets", isSetsIdentical);

      // Phase 2 — separate Bob to the walkable tile FARTHEST from Ada (server-authoritative
      // teleport): views may now differ, but ONLY by distance, and every global fact stays
      // identical.
      const world = s.server.getWorld("room:INTR")!;
      const adaPid = ada.transport.getSelfServerId()!;
      const bobPid = bob.transport.getSelfServerId()!;
      const ap = world.state.players.get(adaPid)!;
      const bp = world.state.players.get(bobPid)!;
      const d = world.state.dungeon;
      let bestD2 = -1;
      for (let ty = 0; ty < d.h; ty++) {
        for (let tx = 0; tx < d.w; tx++) {
          if (d.tiles[ty * d.w + tx] !== 0) continue;
          const x = tx * TILE + TILE / 2;
          const y = ty * TILE + TILE / 2;
          const dx = x - ap.x, dy = y - ap.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > bestD2) { bestD2 = d2; bp.x = x; bp.y = y; }
        }
      }
      await sleep(700);
      const a = ada.transport.getLatestSnapshot()!;
      const b = bob.transport.getLatestSnapshot()!;
      const apart = Math.hypot((a.self?.x ?? 0) - (b.self?.x ?? 0), (a.self?.y ?? 0) - (b.self?.y ?? 0));
      check("players are actually separated beyond the radius", apart > RADIUS, `apart=${Math.round(apart)}px`);

      const exitR = RADIUS * INTEREST_EXIT_FACTOR;
      const withinExit = (snap: Snap, x: number, y: number) => Math.hypot(x - (snap.self?.x ?? 0), y - (snap.self?.y ?? 0)) <= exitR + 1;
      const allNear = (snap: Snap) =>
        snap.enemies.every((e) => e.kind === "boss" || withinExit(snap, e.x, e.y))
        && snap.props.every((p) => withinExit(snap, p.x, p.y))
        && snap.pickups.every((p) => withinExit(snap, p.x, p.y))
        && snap.chests.every((c) => c.kind === "boss" || withinExit(snap, c.x, c.y));
      check("everything Ada sees is within Ada's interest bound", allNear(a));
      check("everything Bob sees is within Bob's interest bound", allNear(b));

      // Global objective + roster stay identical no matter the distance.
      check("seed/floor/rev/cleared/wid identical regardless of distance",
        a.seed === b.seed && a.floor === b.floor && a.rev === b.rev && a.cleared === b.cleared && a.wid === b.wid);
      check("roster is interest-INDEPENDENT (both list both members)",
        deepEqual(a.roster.map((r) => r.aid).sort(), ["ada-i", "bob-i"]) && deepEqual(b.roster.map((r) => r.aid).sort(), ["ada-i", "bob-i"]));

      logA.stop(); logB.stop();
      ada.stop(); bob.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll coherence + readiness assertions passed.\n");
}

void main();
