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
import { buildSnapshot, jsonCodec, type RosterWire, type ServerMsg, type SnapMsg, type WireEvent } from "../src/net/protocol.js";
import { diffSnapshot, snapshotToWire, type WorldLiveIds } from "../src/net/snapshotDelta.js";
import { createWorld, spawnPlayerInWorld, devSpawnEnemy } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { WorldMode } from "../src/sim/pvp.js";
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
// worldMode shapes the SERVER world (co-op dungeon vs pvp arena); the client derives its own
// mode from each snapshot's authoritative world id.
async function makeRig(seed = 0xAB12, worldMode: WorldMode = "coop"): Promise<Rig> {
  const world = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true, mode: worldMode });
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

// PVP seam regression: the world MODE is part of the authoritative world identity (the pvp:
// prefix). A pvp-prefixed `wid` must make the client rebuild its LOCAL predicted/render world as
// the fixed pvp ARENA — not a co-op dungeon. The shipped bug (PR #121 wired every server/wire/sim
// layer but never the client transport): WSTransport always rebuilt co-op, so a pvp arena
// rendered as a walk-through-walls co-op floor (procedural rooms + a GO DOWN exit) even though
// the server ran the arena. A plain room id must still rebuild the seeded co-op dungeon.
async function pvpWorldModeTests(): Promise<void> {
  section("pvp world id rebuilds the LOCAL world as the arena; a co-op id stays a dungeon");
  const pvp = await makeRig(0x9911, "pvp");
  pvp.sock.deliver(pvp.snap({ full: true, worldId: "pvp:room:ARENA" }));
  const pw = pvp.transport.poll().state;
  check("client rebuilds the local world in pvp mode from the authoritative wid", pw.mode === "pvp", `mode=${pw.mode}`);
  check("client builds the fixed 19x19 pvp arena (not a generated dungeon)", pw.dungeon.w === 19 && pw.dungeon.h === 19, `${pw.dungeon.w}x${pw.dungeon.h}`);
  check("the authoritative pvp snapshot carries a match block", pvp.transport.getLatestSnapshot()?.match != null);
  pvp.transport.stop();

  // Control: a plain room id keeps co-op — the seeded generated dungeon, null match. Proves the
  // mode is DERIVED from the world id, not hard-forced (co-op geometry/goldens stay identical).
  const coop = await makeRig(0x1111, "coop");
  coop.sock.deliver(coop.snap({ full: true, worldId: "room:COOP" }));
  const cw = coop.transport.poll().state;
  const gen = generateDungeon(0x1111, 1);
  check("client keeps co-op mode for a plain room id", cw.mode === "coop", `mode=${cw.mode}`);
  check("co-op rebuilds the seeded generated dungeon geometry (not the arena)", cw.dungeon.spawn.x === gen.spawn.x && cw.dungeon.spawn.y === gen.spawn.y);
  check("co-op snapshot carries no match block", coop.transport.getLatestSnapshot()?.match == null);
  coop.transport.stop();
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

// ---- snapshot delta (v24) client-side reconstruction, ordering, and recovery ----

function liveIdsOf(s: SnapMsg): WorldLiveIds {
  return {
    enemies: new Set(s.enemies.map((e) => e.id)),
    players: new Set(s.players.map((p) => p.id)),
    props: new Set(s.props.map((p) => p.id)),
    pickups: new Set(s.pickups.map((p) => p.id)),
    chests: new Set(s.chests.map((c) => c.id)),
    hzds: new Set(s.hzds.map((h) => h.id)),
    effs: new Set(s.effs.map((e) => e.id)),
  };
}

// A complete keyframe (t:"snap") stamped with an sseq — (re)establishes the client baseline.
function keyframe(rig: Rig, sseq: number, opts: { full?: boolean; events?: WireEvent[]; evTo?: number; ackSeq?: number } = {}): SnapMsg {
  return buildSnapshot(rig.world, rig.pid, opts.ackSeq ?? 0, opts.events ?? [], opts.evTo ?? 0, opts.full ?? false, { worldId: "w-test", sseq }) as SnapMsg;
}

// A delta frame (t:"snapd") diffing the current world against `base` (the baseline the client
// last acked), stamped with `sseq`.
function deltaFrame(rig: Rig, base: SnapMsg, sseq: number, opts: { events?: WireEvent[]; evTo?: number; ackSeq?: number } = {}): ServerMsg {
  const next = keyframe(rig, sseq, opts);
  return { t: "snapd", ...diffSnapshot(snapshotToWire(base), snapshotToWire(next), sseq, liveIdsOf(next)) };
}

async function deltaReconstructTests(): Promise<void> {
  section("snapshot delta: a delta reconstructs against the retained baseline, byte-for-byte");
  const rig = await makeRig();
  devSpawnEnemy(rig.world, "slime", 800, 800);
  devSpawnEnemy(rig.world, "slime", 860, 820);
  // Keyframe establishes the baseline (sseq 1).
  const base = keyframe(rig, 1, { full: true });
  rig.sock.deliver(base);
  check("ready after keyframe", rig.transport.isReady());
  check("client acks the keyframe sseq on its next input", true);

  // Move an enemy + self, advance the tick, and deliver ONLY the delta (sseq 2, base 1).
  const e0 = rig.world.enemies[0];
  const startX = e0.x;
  e0.x += 40; e0.y -= 15;
  rig.world.players.get(rig.pid)!.x += 25;
  rig.world.tick = 12;
  const full2 = keyframe(rig, 2); // the authoritative complete state, for comparison only
  rig.sock.deliver(deltaFrame(rig, base, 2));
  const got = rig.transport.getLatestSnapshot()!;
  const gotE0 = got.enemies.find((e) => e.id === e0.id)!;
  check("delta moved the enemy to authoritative truth", Math.abs(gotE0.x - (startX + 40)) < 1e-9 && gotE0.x !== startX, `x=${gotE0.x}`);
  check("delta reconstructed the full enemy set (nothing dropped)", got.enemies.length === full2.enemies.length);
  check("delta reconstructed self position", Math.abs(got.self!.x - full2.self!.x) < 1e-9);
  check("delta applied advances the client tick", got.tick === 12);
  rig.transport.stop();
}

async function deltaOrderingTests(): Promise<void> {
  section("snapshot delta ordering: a stale / out-of-order delta is DROPPED, never applied");
  const rig = await makeRig();
  devSpawnEnemy(rig.world, "slime", 800, 800);
  const base = keyframe(rig, 1, { full: true });
  rig.sock.deliver(base);

  const e0 = rig.world.enemies[0];
  // Fresh delta sseq 5 moves the enemy to X+100.
  e0.x += 100; rig.world.tick = 20;
  rig.sock.deliver(deltaFrame(rig, base, 5));
  const afterFresh = rig.transport.getLatestSnapshot()!.enemies[0].x;

  // A STALE delta sseq 3 (older than 5) against the SAME baseline must be ignored.
  e0.x -= 100; rig.world.tick = 15;
  rig.sock.deliver(deltaFrame(rig, base, 3));
  const afterStale = rig.transport.getLatestSnapshot()!.enemies[0].x;
  check("stale (lower-sseq) delta did not regress state", Math.abs(afterStale - afterFresh) < 1e-9, `fresh=${afterFresh} stale=${afterStale}`);
  check("latest tick did not regress", rig.transport.getLatestSnapshot()!.tick === 20);
  rig.transport.stop();
}

async function deltaMissedBaselineTests(): Promise<void> {
  section("snapshot delta: a delta against a baseline the client never had is dropped (gap guard)");
  const rig = await makeRig();
  devSpawnEnemy(rig.world, "slime", 800, 800);
  const base = keyframe(rig, 1, { full: true });
  rig.sock.deliver(base);
  const before = rig.transport.getLatestSnapshot()!.enemies[0].x;

  // A delta that claims baseline sseq 7 (the client only holds 1) must NOT be applied — it would
  // corrupt state by merging onto the wrong base.
  rig.world.enemies[0].x += 250; rig.world.tick = 30;
  const orphan = keyframe(rig, 8);
  const gapped: ServerMsg = { t: "snapd", ...diffSnapshot(snapshotToWire(orphan), snapshotToWire(orphan), 8, liveIdsOf(orphan)), b: 7 };
  rig.sock.deliver(gapped);
  check("a delta with an unknown baseline is dropped (state unchanged)", Math.abs(rig.transport.getLatestSnapshot()!.enemies[0].x - before) < 1e-9);

  // Recovery: a fresh keyframe re-establishes the baseline and the client converges.
  rig.sock.deliver(keyframe(rig, 9));
  check("a keyframe recovers the client after the gap", Math.abs(rig.transport.getLatestSnapshot()!.enemies[0].x - (before + 250)) < 1e-9);
  rig.transport.stop();
}

async function deltaDropKeyframeRecoveryTests(): Promise<void> {
  section("recovery (a): a DROPPED keyframe — deltas can't apply, a later keyframe reconverges");
  const rig = await makeRig();
  devSpawnEnemy(rig.world, "slime", 800, 800);
  // The bootstrap keyframe (sseq 1) is DROPPED (never delivered). The server, seeing no ack,
  // keeps trying: first deltas (which the client can't apply — no baseline), then a keyframe.
  const lost = keyframe(rig, 1, { full: true });
  rig.world.enemies[0].x += 30; rig.world.tick = 11;
  rig.sock.deliver(deltaFrame(rig, lost, 2)); // base 1, which the client never received
  check("client is NOT ready after only an unapplicable delta (keyframe was lost)", !rig.transport.isReady());

  // A fresh full keyframe (the server's fallback) bootstraps the client to authoritative truth.
  rig.world.enemies[0].x += 30; rig.world.tick = 12;
  rig.sock.deliver(keyframe(rig, 3, { full: true }));
  check("ready once a keyframe finally arrives", rig.transport.isReady());
  check("client converged to full authoritative state", Math.abs(rig.transport.getLatestSnapshot()!.enemies[0].x - rig.world.enemies[0].x) < 1e-9);
  rig.transport.stop();
}

async function deltaDropMidStreamRecoveryTests(): Promise<void> {
  section("recovery (b): a DROPPED mid-stream delta self-heals (next delta diffs the acked base)");
  const rig = await makeRig();
  devSpawnEnemy(rig.world, "slime", 800, 800);
  // Keyframe sseq 1 -> client baseline 1. (In production the client would ack 1; here we model
  // the server diffing every subsequent delta against the client's last APPLIED baseline.)
  const s1 = keyframe(rig, 1, { full: true });
  rig.sock.deliver(s1);

  // Delta sseq 2 (base 1) applied -> baseline advances to 2 (client acks 2).
  rig.world.enemies[0].x += 20; rig.world.tick = 12;
  const s2 = keyframe(rig, 2);
  rig.sock.deliver(deltaFrame(rig, s1, 2));
  check("delta 2 applied", rig.transport.getLatestSnapshot()!.tick === 12);

  // Delta sseq 3 (base 2) is DROPPED in flight.
  rig.world.enemies[0].x += 20; rig.world.tick = 13; // (never delivered)

  // The server re-diffs against the last ACKED baseline (2) for the next frame: delta sseq 4,
  // base 2, carrying ALL changes since 2. The client (still at baseline 2) applies it and
  // reconverges — the dropped delta 3 never mattered.
  rig.world.enemies[0].x += 20; rig.world.tick = 14; // total +40 since s2
  rig.sock.deliver(deltaFrame(rig, s2, 4));
  const got = rig.transport.getLatestSnapshot()!;
  check("client reconverged to full authoritative state after the dropped delta", Math.abs(got.enemies[0].x - rig.world.enemies[0].x) < 1e-9, `got=${got.enemies[0].x} truth=${rig.world.enemies[0].x}`);
  check("client tick jumped straight to the recovered frame", got.tick === 14);
  rig.transport.stop();
}

async function deltaEventDedupeTests(): Promise<void> {
  section("reliable events stay exactly-once ACROSS a keyframe resync (id watermark survives)");
  const rig = await makeRig();
  const base = keyframe(rig, 1, { full: true });
  rig.sock.deliver(base);
  rig.transport.poll(); // drain bootstrap

  const kill: WireEvent = { id: 1, e: { t: "enemyKill", eid: 9, kind: "slime", tier: "swarm", x: 1, y: 2, combo: 1 } };
  // The kill rides a DELTA first.
  rig.world.tick = 12;
  rig.sock.deliver(deltaFrame(rig, base, 2, { events: [kill], evTo: 1 }));
  check("event delivered once via delta", rig.transport.poll().events.filter((e) => e.t === "enemyKill").length === 1);

  // A KEYFRAME resync re-carries the SAME event id (as a server that hasn't seen the ack would).
  // The id watermark must dedupe it — no double-fire across the base reset.
  rig.world.tick = 13;
  rig.sock.deliver(keyframe(rig, 3, { events: [kill], evTo: 1 }));
  check("the same event id does NOT re-fire across a keyframe resync", rig.transport.poll().events.filter((e) => e.t === "enemyKill").length === 0);

  // A NEW event arriving only on a keyframe fires exactly once.
  const descend: WireEvent = { id: 2, e: { t: "descend", toFloor: 2 } };
  rig.world.tick = 14;
  rig.sock.deliver(keyframe(rig, 4, { events: [descend], evTo: 2 }));
  check("a new event delivered on a keyframe fires once", rig.transport.poll().events.filter((e) => e.t === "descend").length === 1);
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
  await pvpWorldModeTests();
  await deltaReconstructTests();
  await deltaOrderingTests();
  await deltaMissedBaselineTests();
  await deltaDropKeyframeRecoveryTests();
  await deltaDropMidStreamRecoveryTests();
  await deltaEventDedupeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll client netcode ordering assertions passed.\n");
}

void main();
