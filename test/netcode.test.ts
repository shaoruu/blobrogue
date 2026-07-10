// Client netcode ordering suite: drives the REAL WSTransport through a scripted fake socket
// with full control over delivery order and the clock, and locks the snapshot/event ordering
// contracts the TD audit demanded: stale/duplicate/reordered snapshots are ignored, the server
// ack never decreases (a replayed full snapshot cannot resurrect consumed inputs), reliable
// events dedupe by id and the ack advances past interest-filtered gaps via evTo, offers dedupe
// by id, world rebuilds key off the authoritative seed/floor, and terminal run state is
// readable from snapshots.
//
// Run: npm run test:netcode

import { WSTransport, type SocketLike } from "../src/client/wsTransport.js";
import { buildSnapshot, jsonCodec, type RosterWire, type ServerMsg, type WireEvent } from "../src/net/protocol.js";
import { createWorld, spawnPlayerInWorld } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import { generateDungeon } from "../src/sim/dungeon.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

class FakeSocket implements SocketLike {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  deliverRaw(raw: string): void { this.onmessage?.({ data: raw }); }
  deliver(msg: ServerMsg): void { this.deliverRaw(jsonCodec.encodeServer(msg)); }
}

interface Rig {
  transport: WSTransport;
  sock: FakeSocket;
  world: WorldState;
  pid: string;
  snap: (opts?: { ackSeq?: number; events?: WireEvent[]; evTo?: number; full?: boolean; worldId?: string; roster?: RosterWire[] }) => ServerMsg;
  tickNow: (ms: number) => void;
}

// A rig: a server-shaped world + a WSTransport bound to a fake socket with a controlled clock.
async function makeRig(seed = 0xAB12): Promise<Rig> {
  const world = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true });
  const pid = "p1";
  spawnPlayerInWorld(world, pid);
  world.tick = 5;
  const sock = new FakeSocket();
  let now = 100000;
  const transport = new WSTransport({
    url: "ws://fake",
    getTicket: () => Promise.resolve("dev:test"),
    socketFactory: () => sock,
    now: () => now,
  });
  transport.start();
  await Promise.resolve(); // let the async connect() bind handlers
  sock.onopen?.();
  return {
    transport, sock, world, pid,
    snap: (opts = {}) => buildSnapshot(world, pid, opts.ackSeq ?? 0, opts.events ?? [], opts.evTo ?? 0, opts.full ?? false, { worldId: opts.worldId ?? "w-test", roster: opts.roster }),
    tickNow: (ms) => { now += ms; },
  };
}

// Advance the transport by n fixed 50ms steps with a held input (sends one input per step).
function advanceSteps(rig: Rig, n: number, moveX = 1): void {
  for (let i = 0; i < n; i++) {
    rig.transport.sendInput({ seq: 0, moveX, moveY: 0, aim: 0, firing: false, dash: false });
    rig.tickNow(50);
    rig.transport.advance(0.05);
  }
}

async function staleAndDuplicateTests(): Promise<void> {
  section("stale / duplicate / reordered snapshots are ignored");
  const rig = await makeRig();
  rig.sock.deliver(rig.snap({ full: true }));
  check("transport ready after the full snapshot", rig.transport.isReady());

  // Move the authoritative player and send tick 10; then replay an OLD state at tick 8.
  const p = rig.world.players.get(rig.pid)!;
  const freshX = p.x + 100;
  p.x = freshX;
  rig.world.tick = 10;
  rig.sock.deliver(rig.snap());
  p.x = freshX - 100; // the older position
  rig.world.tick = 8;
  rig.sock.deliver(rig.snap()); // REORDERED delivery (older tick arrives later)
  const latest = rig.transport.getLatestSnapshot()!;
  check("older-tick snapshot did not replace the newer one", latest.tick === 10, `tick=${latest.tick}`);
  check("state did not regress to the older position", latest.self!.x === freshX, `x=${latest.self!.x}`);

  // A duplicate of the same tick is also ignored (no re-processing).
  p.x = freshX + 55; // would corrupt if the duplicate were accepted
  rig.sock.deliver({ ...rig.snap(), tick: 10 } as ServerMsg);
  check("duplicate tick ignored", rig.transport.getLatestSnapshot()!.self!.x === freshX);

  // An older WORLD REVISION is ignored even with a higher tick (cross-floor stale frame).
  p.x = freshX;
  rig.world.tick = 20; rig.world.rev += 1;
  rig.sock.deliver(rig.snap());
  const revNow = rig.transport.getLatestSnapshot()!.rev;
  rig.world.rev -= 1; rig.world.tick = 30;
  rig.sock.deliver(rig.snap());
  check("older-revision snapshot ignored despite a higher tick", rig.transport.getLatestSnapshot()!.rev === revNow, `rev=${rig.transport.getLatestSnapshot()!.rev}`);
  rig.world.rev += 1;
  rig.transport.stop();
}

async function ackMonotonicTests(): Promise<void> {
  section("the server ack never decreases (a stale full snapshot can't resurrect inputs)");
  const rig = await makeRig();
  rig.sock.deliver(rig.snap({ full: true }));
  // Send 10 real inputs (seq 1..10) so the pending buffer is populated.
  advanceSteps(rig, 10);
  // Server consumed all 10: reconcile snaps to authoritative truth with ackSeq 10.
  const p = rig.world.players.get(rig.pid)!;
  rig.world.tick = 30;
  rig.sock.deliver(rig.snap({ ackSeq: 10 }));
  const settled = rig.transport.getPredictedSelf();
  // A REPLAYED full snapshot with an older ack (2) must not resurrect seqs 3..10 into the
  // replay set — that would re-apply eight 50ms move steps on top of authoritative truth.
  rig.world.tick = 31;
  rig.sock.deliver(rig.snap({ ackSeq: 2, full: true }));
  const after = rig.transport.getPredictedSelf();
  const drift = Math.hypot(after.x - settled.x, after.y - settled.y);
  check("no forward replay drift from the stale ack", drift < 1, `drift=${drift.toFixed(1)}px (8 replayed steps would be ~80px)`);
  check("predicted position still matches authority", Math.abs(after.x - p.x) < 1);
  rig.transport.stop();
}

async function eventChannelTests(): Promise<void> {
  section("reliable events: id dedupe across resends; evTo advances the ack past filtered gaps");
  const rig = await makeRig();
  rig.sock.deliver(rig.snap({ full: true }));
  rig.transport.poll();

  const kill: WireEvent = { id: 1, e: { t: "enemyKill", eid: 9, kind: "slime", tier: "standard", x: 1, y: 2, combo: 1 } };
  rig.world.tick = 10;
  rig.sock.deliver(rig.snap({ events: [kill], evTo: 1 }));
  rig.world.tick = 11;
  rig.sock.deliver(rig.snap({ events: [kill], evTo: 1 })); // RESEND (unacked yet)
  const events = rig.transport.poll().events.filter((e) => e.t === "enemyKill");
  check("resent event replayed exactly once", events.length === 1, `count=${events.length}`);

  // evTo advance: a snapshot whose pending events were ALL filtered for this client still
  // advances the ack high-water so the server stops rescanning them.
  rig.world.tick = 12;
  rig.sock.deliver(rig.snap({ events: [], evTo: 7 }));
  advanceSteps(rig, 1);
  const lastInput = rig.sock.sent.map((s) => JSON.parse(s) as { t: string; ackEv?: number }).filter((m) => m.t === "input").pop();
  check("input acks up to evTo (7) despite receiving no event bodies", lastInput?.ackEv === 7, `ackEv=${lastInput?.ackEv}`);

  // An event with id <= evTo arriving later (impossible from a correct server, but reordering
  // insurance) is deduped by the same high-water mark.
  rig.world.tick = 13;
  rig.sock.deliver(rig.snap({ events: [{ id: 5, e: { t: "descend", toFloor: 2 } }], evTo: 7 }));
  const late = rig.transport.poll().events.filter((e) => e.t === "descend");
  check("an already-acked id never replays", late.length === 0, `count=${late.length}`);
  rig.transport.stop();
}

async function offerAndRunOverTests(): Promise<void> {
  section("offers dedupe by id; terminal run state is readable from snapshots");
  const rig = await makeRig();
  rig.sock.deliver(rig.snap({ full: true }));
  rig.sock.deliver({ t: "offer", id: 1, choices: ["it_a", "it_b"] });
  rig.sock.deliver({ t: "offer", id: 1, choices: ["it_a", "it_b"] }); // resend
  const first = rig.transport.consumePendingOffer();
  const dup = rig.transport.consumePendingOffer();
  check("offer surfaced once with its id", first !== null && first.id === 1 && first.choices.length === 2);
  check("resent offer id not re-prompted", dup === null);
  rig.sock.deliver({ t: "offer", id: 2, choices: ["it_c"] });
  const second = rig.transport.consumePendingOffer();
  check("a NEW offer id prompts again", second !== null && second.id === 2);

  check("run not over initially", !rig.transport.isRunOver());
  rig.world.isRunOver = true;
  rig.world.tick = 40;
  rig.sock.deliver(rig.snap());
  check("terminal run state derivable from snapshot state (no event needed)", rig.transport.isRunOver());
  rig.transport.stop();
}

// Bug regression: "i get spawned and immediately teleported to another place". Before the
// first authoritative snapshot the local world is a placeholder with the WRONG dungeon and
// spawn (the game hides it behind a connecting veil, keyed off isReady). The first snapshot
// must place the player EXACTLY at authoritative truth — no residual smoothing offset, no
// extrapolation leak — so the first visible frame is already correct.
async function firstSpawnPlacementTests(): Promise<void> {
  section("first-frame spawn placement: the first snapshot lands exactly, with nothing to glide");
  const rig = await makeRig(0xD156E); // a real run seed, distinct from the placeholder's
  // Pre-join frames with held movement: the client predicts inside the placeholder world.
  advanceSteps(rig, 6);
  check("transport not ready before the first snapshot (the game shows a veil, not the placeholder)", !rig.transport.isReady());
  const placeholder = rig.transport.getPredictedSelf();
  const authoritative = rig.world.players.get(rig.pid)!;
  check("the placeholder position is genuinely elsewhere (the old visible teleport)",
    Math.hypot(placeholder.x - authoritative.x, placeholder.y - authoritative.y) > 40,
    `off by ${Math.hypot(placeholder.x - authoritative.x, placeholder.y - authoritative.y).toFixed(0)}px`);

  rig.sock.deliver(rig.snap({ full: true }));
  check("ready after the full snapshot", rig.transport.isReady());
  const polled = rig.transport.poll().state.players.get("local")!;
  const err0 = Math.hypot(polled.x - authoritative.x, polled.y - authoritative.y);
  check("first polled frame sits EXACTLY on the authoritative spawn", err0 < 1e-6, `err=${err0}px`);

  // And it STAYS exact over the following idle frames — no smoothing residue gliding the
  // player, no extrapolation anchor from the placeholder leaking in.
  let maxDrift = 0;
  for (let i = 0; i < 5; i++) {
    rig.transport.sendInput({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false });
    rig.tickNow(50);
    rig.transport.advance(0.05);
    const p = rig.transport.poll().state.players.get("local")!;
    maxDrift = Math.max(maxDrift, Math.hypot(p.x - authoritative.x, p.y - authoritative.y));
  }
  check("no post-spawn drift/glide across the idle frames that follow", maxDrift < 1e-6, `maxDrift=${maxDrift}px`);
  rig.transport.stop();
}

async function worldRebuildTests(): Promise<void> {
  section("world rebuild keys off the authoritative seed/floor (join + descend)");
  const rig = await makeRig(0x1111);
  rig.sock.deliver(rig.snap({ full: true }));
  const joined = rig.transport.consumeWorldRebuilt();
  check("initial join rebuilds to the server seed", joined !== null && joined.seed === 0x1111, `seed=${joined?.seed}`);
  check("rebuild latch consumed once", rig.transport.consumeWorldRebuilt() === null);

  // Party-wide descend: same seed, next floor. The client must rebuild the IDENTICAL floor-2
  // dungeon the server generated.
  rig.world.floor = 2; rig.world.rev += 1; rig.world.tick = 50;
  const spawn2 = generateDungeon(0x1111, 2).spawn;
  for (const pl of rig.world.players.values()) { pl.x = spawn2.x * 48 + 24; pl.y = spawn2.y * 48 + 24; }
  rig.sock.deliver(rig.snap());
  const rebuilt = rig.transport.consumeWorldRebuilt();
  check("descend rebuild reported for floor 2", rebuilt !== null && rebuilt.floor === 2);
  const clientDungeon = rig.transport.poll().state.dungeon;
  check("client dungeon geometry matches the authoritative floor-2 generation", clientDungeon.spawn.x === spawn2.x && clientDungeon.spawn.y === spawn2.y);
  rig.transport.stop();
}

// v14: a NETWORKED player's combat events reach every nearby client's event queue (not only
// the actor), so a teammate's shot/hurt is audible + visible; the local player's own copies
// still arrive exactly once; and non-audible player-scoped events for OTHERS stay gated out.
async function remoteCombatAudioGateTests(): Promise<void> {
  section("v14: remote players' combat events survive the client gate; the local player's play once");
  const rig = await makeRig();
  rig.sock.deliver(rig.snap({ full: true }));
  rig.transport.poll(); // drain the bootstrap
  const self = rig.pid; // "p1"
  const mate = "p2";
  const events: WireEvent[] = [
    { id: 1, e: { t: "shot", pid: mate, weapon: "pistol", x: 10, y: 20, aim: 0, px: 10, py: 20, chg: 0 } },
    { id: 2, e: { t: "playerHurt", pid: mate, x: 10, y: 20 } },
    { id: 3, e: { t: "heal", pid: mate, x: 10, y: 20 } },
    { id: 4, e: { t: "pickup", pid: mate, kind: "coin", x: 10, y: 20 } },
    { id: 5, e: { t: "shot", pid: self, weapon: "pistol", x: 5, y: 5, aim: 0, px: 5, py: 5, chg: 0 } },
    // A NON-audible player-scoped event for a teammate must stay gated out (it drives the
    // owner's private UI, not shared audio) — proves the gate is selective, not a blanket pass.
    { id: 6, e: { t: "itemPicked", pid: mate, x: 10, y: 20, tint: "#fff" } },
  ];
  rig.world.tick = 10;
  rig.sock.deliver(rig.snap({ events, evTo: 6 }));
  const got = rig.transport.poll().events;
  const remoteShot = got.filter((e) => e.t === "shot" && (e as { pid: string }).pid === mate);
  const remoteHurt = got.filter((e) => e.t === "playerHurt" && (e as { pid: string }).pid === mate);
  const remoteHeal = got.filter((e) => e.t === "heal" && (e as { pid: string }).pid === mate);
  const remotePickup = got.filter((e) => e.t === "pickup" && (e as { pid: string }).pid === mate);
  const localShot = got.filter((e) => e.t === "shot" && (e as { pid: string }).pid === self);
  const remoteItem = got.filter((e) => e.t === "itemPicked");
  check("a teammate's shot survives the gate (routable to the remote audio path)", remoteShot.length === 1);
  check("a teammate's hurt survives the gate (Ian hears his friend get hit)", remoteHurt.length === 1);
  check("a teammate's heal + pickup survive the gate", remoteHeal.length === 1 && remotePickup.length === 1);
  check("the local player's own shot arrives exactly once (no double-play)", localShot.length === 1);
  check("a teammate's non-audible pid event (itemPicked) stays gated out", remoteItem.length === 0);

  // A resend (same ids) must not replay any of them — the local shot stays at exactly one.
  rig.world.tick = 11;
  rig.sock.deliver(rig.snap({ events, evTo: 6 }));
  const resent = rig.transport.poll().events;
  check("resent combat events are deduped (local shot never double-plays)",
    resent.filter((e) => e.t === "shot").length === 0, `count=${resent.filter((e) => e.t === "shot").length}`);
  rig.transport.stop();
}

async function main(): Promise<void> {
  await staleAndDuplicateTests();
  await ackMonotonicTests();
  await eventChannelTests();
  await remoteCombatAudioGateTests();
  await offerAndRunOverTests();
  await firstSpawnPlacementTests();
  await worldRebuildTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll client netcode ordering assertions passed.\n");
}

void main();
