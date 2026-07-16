// Snapshot delta codec suite (pure): the diff/apply round-trips losslessly (decoded state
// identical by id, unchanged data omitted), removal tombstones distinguish death ("gone") from
// leaving the interest radius ("left"), a delta names the EXACT baseline it applies to (so a
// client can refuse a gap), and the whole thing survives the strict wire codec + snapshot
// validator. These are the reviewer's hard gates, proven at the codec boundary.
//
// Run: npx tsx test/snapshotdelta.test.ts

import {
  jsonCodec, buildSnapshot, validateSnap, PROTOCOL_VERSION,
  type ServerMsg, type SnapMsg, type WireEvent,
} from "../src/net/protocol.js";
import {
  diffSnapshot, applySnapshotDelta, snapshotToWire, type WorldLiveIds,
} from "../src/net/snapshotDelta.js";
import { createWorld, spawnPlayerInWorld, devSpawnEnemy } from "../src/sim/world.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

type AnyEntity = { id: number | string } & Record<string, unknown>;
const KEYED = ["enemies", "players", "props", "pickups", "chests", "hzds", "effs"] as const;

function byId(list: AnyEntity[]): Map<number | string, string> {
  const m = new Map<number | string, string>();
  for (const e of list) m.set(e.id, JSON.stringify(e));
  return m;
}

// Order-insensitive snapshot equality: the client keys every entity by id, so list ORDER is not
// part of the decoded state. Compares each keyed list by id, and everything else structurally.
function snapEqualById(a: SnapMsg, b: SnapMsg): boolean {
  const ao = a as unknown as Record<string, AnyEntity[]>;
  const bo = b as unknown as Record<string, AnyEntity[]>;
  for (const k of KEYED) {
    const ma = byId(ao[k]);
    const mb = byId(bo[k]);
    if (ma.size !== mb.size) return false;
    for (const [id, s] of ma) { if (mb.get(id) !== s) return false; }
  }
  const strip = (s: SnapMsg): string => {
    const o = { ...(s as unknown as Record<string, unknown>) };
    for (const k of KEYED) delete o[k];
    return JSON.stringify(o);
  };
  return strip(a) === strip(b);
}

// A complete authoritative snapshot with several entity classes present, sseq stamped.
function makeBaseSnap(): SnapMsg {
  const w = createWorld(0xBEEF01, 1, { isShared: true, skipLocalPlayer: true });
  const me = spawnPlayerInWorld(w, "pMe");
  const mate = spawnPlayerInWorld(w, "pMate");
  mate.x = me.x + 60; mate.y = me.y - 20;
  devSpawnEnemy(w, "slime", me.x + 100, me.y);
  devSpawnEnemy(w, "slime", me.x + 140, me.y + 30);
  devSpawnEnemy(w, "slime", me.x - 120, me.y);
  return buildSnapshot(w, "pMe", 3, [], 0, false, { worldId: "w-delta", sseq: 1 }) as SnapMsg;
}

// Deep clone a snapshot to a fresh SnapMsg we can mutate to form the "next" frame.
function cloneSnap(s: SnapMsg): SnapMsg {
  return validateSnap(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
}

function fullWorld(s: SnapMsg): WorldLiveIds {
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

// Reconstruct through the same path the client uses: diff -> wire encode -> strict decode ->
// apply against baseline -> strict snapshot validate.
function roundTrip(base: SnapMsg, next: SnapMsg, world: WorldLiveIds): SnapMsg {
  const delta = diffSnapshot(snapshotToWire(base), snapshotToWire(next), next.sseq, world);
  const wire = jsonCodec.encodeServer({ t: "snapd", ...delta });
  const decoded = jsonCodec.decodeServer(wire);
  if (decoded.t !== "snapd") throw new Error("expected snapd");
  return validateSnap(applySnapshotDelta(snapshotToWire(base), decoded));
}

function roundTripTests(): void {
  section("round-trip: reconstructed decoded state is identical (by id); unchanged data omitted");
  const base = makeBaseSnap();
  const next = cloneSnap(base);
  next.sseq = 2;
  next.tick = base.tick + 1;
  // Move enemy[0], damage enemy[1], leave enemy[2] untouched. Nudge self + a scalar.
  next.enemies[0].x += 12.5; next.enemies[0].y -= 3.25;
  next.enemies[1].hp -= 1;
  next.self!.x += 4; next.self!.coins += 7;
  next.ackSeq = base.ackSeq + 2;

  const world = fullWorld(next);
  const delta = diffSnapshot(snapshotToWire(base), snapshotToWire(next), next.sseq, world);

  check("delta names the exact baseline sseq", delta.b === base.sseq, `b=${delta.b}`);
  check("delta scalars carry only what changed (tick + ackSeq)",
    delta.sc.tick === next.tick && delta.sc.ackSeq === next.ackSeq && delta.sc.rev === undefined,
    JSON.stringify(delta.sc));
  const movedPatch = delta.en?.u?.find((e) => e.id === next.enemies[0].id);
  check("a moved enemy sends only id + x + y (static fields omitted)",
    movedPatch !== undefined && Object.keys(movedPatch).sort().join(",") === "id,x,y",
    JSON.stringify(movedPatch));
  const dmgPatch = delta.en?.u?.find((e) => e.id === next.enemies[1].id);
  check("a damaged enemy sends only id + hp", dmgPatch !== undefined && Object.keys(dmgPatch).sort().join(",") === "hp,id");
  check("an untouched enemy is not in the delta at all",
    delta.en?.u?.find((e) => e.id === next.enemies[2].id) === undefined);
  check("props unchanged -> the whole prop list is omitted", delta.pr === undefined);
  check("self change is a partial patch of only the changed fields",
    delta.self !== undefined && "p" in delta.self && Object.keys(delta.self.p).sort().join(",") === "coins,x",
    JSON.stringify(delta.self));

  const recon = roundTrip(base, next, world);
  check("reconstructed snapshot equals next (order-insensitive, by id)", snapEqualById(recon, next));
  check("reconstruction did NOT mutate the retained baseline", base.enemies[0].x !== next.enemies[0].x && base.self!.coins !== next.self!.coins);
}

function tombstoneTests(): void {
  section("removal tombstones: death is 'gone', leaving interest is 'left' — never conflated");
  const base = makeBaseSnap();
  const deadId = base.enemies[0].id;
  const leftId = base.enemies[1].id;

  // DEATH: enemy absent from next AND absent from the authoritative world -> gone.
  const died = cloneSnap(base); died.sseq = 2; died.tick = base.tick + 1;
  died.enemies = died.enemies.filter((e) => e.id !== deadId);
  const worldAfterDeath = fullWorld(died); // world no longer contains deadId
  const dDeath = diffSnapshot(snapshotToWire(base), snapshotToWire(died), died.sseq, worldAfterDeath);
  const goneTomb = dDeath.en?.r?.find(([id]) => id === deadId);
  check("a despawned/killed enemy is tombstoned 'gone'", goneTomb !== undefined && goneTomb[1] === "gone", JSON.stringify(goneTomb));

  // LEAVE INTEREST: enemy absent from next but STILL ALIVE in the world -> left.
  const filtered = cloneSnap(base); filtered.sseq = 2; filtered.tick = base.tick + 1;
  filtered.enemies = filtered.enemies.filter((e) => e.id !== leftId);
  const worldStillAlive: WorldLiveIds = { ...fullWorld(filtered), enemies: new Set(base.enemies.map((e) => e.id)) };
  const dLeft = diffSnapshot(snapshotToWire(base), snapshotToWire(filtered), filtered.sseq, worldStillAlive);
  const leftTomb = dLeft.en?.r?.find(([id]) => id === leftId);
  check("an enemy that left the interest radius is tombstoned 'left'", leftTomb !== undefined && leftTomb[1] === "left", JSON.stringify(leftTomb));

  check("the reasons are distinct wire values for the SAME removal shape (not conflated)",
    (goneTomb?.[1]) === "gone" && (leftTomb?.[1]) === "left");

  // Either way, the reconstructed decoded state is identical: the entity is absent.
  const reconDeath = roundTrip(base, died, worldAfterDeath);
  const reconLeft = roundTrip(base, filtered, worldStillAlive);
  check("reconstruction removes a 'gone' entity", reconDeath.enemies.find((e) => e.id === deadId) === undefined);
  check("reconstruction removes a 'left' entity", reconLeft.enemies.find((e) => e.id === leftId) === undefined);
}

function additionAndSelfTests(): void {
  section("additions carry full structs; self null-flips and first-appearance are handled");
  const base = makeBaseSnap();

  // A NEW enemy appears (not in base) -> full struct in u; a NEW player appears too.
  const grown = cloneSnap(base); grown.sseq = 2; grown.tick = base.tick + 1;
  const newEnemy = JSON.parse(JSON.stringify(base.enemies[0])) as typeof base.enemies[0];
  newEnemy.id = 9999; newEnemy.x += 400;
  grown.enemies = [...grown.enemies, newEnemy];
  const world = fullWorld(grown);
  const d = diffSnapshot(snapshotToWire(base), snapshotToWire(grown), grown.sseq, world);
  const added = d.en?.u?.find((e) => e.id === 9999);
  check("a new enemy is sent as a FULL struct (all fields present)",
    added !== undefined && "kind" in added && "tr" in added && "atk" in added);
  const recon = roundTrip(base, grown, world);
  check("reconstruction adds the new enemy with full fidelity", snapEqualById(recon, grown));

  // self goes null -> { d: true }; and a null baseline self becoming present -> { f: full }.
  const gone = cloneSnap(base); gone.sseq = 2; gone.tick = base.tick + 1; gone.self = null;
  const dNull = diffSnapshot(snapshotToWire(base), snapshotToWire(gone), gone.sseq, fullWorld(gone));
  check("self -> null is a delete flip", dNull.self !== undefined && "d" in dNull.self);
  check("reconstructs self as null", roundTrip(base, gone, fullWorld(gone)).self === null);

  const reborn = cloneSnap(gone); reborn.sseq = 3; reborn.tick = gone.tick + 1; reborn.self = JSON.parse(JSON.stringify(base.self));
  const dReborn = diffSnapshot(snapshotToWire(gone), snapshotToWire(reborn), reborn.sseq, fullWorld(reborn));
  check("self from null -> present is a FULL set", dReborn.self !== undefined && "f" in dReborn.self);
  check("reconstructs the full self", snapEqualById(roundTrip(gone, reborn, fullWorld(reborn)), reborn));
}

function eventPassthroughTests(): void {
  section("the reliable event stream rides every delta verbatim (independent of the baseline)");
  const base = makeBaseSnap();
  const next = cloneSnap(base); next.sseq = 2; next.tick = base.tick + 1;
  const events: WireEvent[] = [
    { id: 5, e: { t: "enemyKill", eid: 1, kind: "slime", tier: "swarm", x: 1, y: 2, combo: 1, by: "p1" } },
    { id: 6, e: { t: "descend", toFloor: 2 } },
  ];
  next.events = events;
  next.evTo = 6;
  const d = diffSnapshot(snapshotToWire(base), snapshotToWire(next), next.sseq, fullWorld(next));
  check("events + evTo are carried on the delta verbatim", d.ev.length === 2 && d.et === 6);
  const recon = roundTrip(base, next, fullWorld(next));
  check("reconstructed snapshot carries the same events + evTo", recon.events.length === 2 && recon.evTo === 6);
}

function safetyTests(): void {
  section("the delta decode is strict + crash-safe (fuzz-adjacent malformed frames)");
  // Raw JSON strings so non-finite numbers (1e999 -> Infinity) and an OWN "__proto__" key
  // survive parsing — the exact adversarial shapes JSON.stringify would silently sanitize.
  const bad: Array<[string, string]> = [
    ["missing q", '{"t":"snapd","b":1,"sc":{},"ev":[],"et":0}'],
    ["non-object sc", '{"t":"snapd","q":2,"b":1,"sc":5,"ev":[],"et":0}'],
    ["non-finite in a scalar patch", '{"t":"snapd","q":2,"b":1,"sc":{"tick":1e999},"ev":[],"et":0}'],
    ["bad removal reason", '{"t":"snapd","q":2,"b":1,"sc":{},"en":{"r":[[1,"vanished"]]},"ev":[],"et":0}'],
    ["prototype-polluting key in a patch", '{"t":"snapd","q":2,"b":1,"sc":{},"en":{"u":[{"id":1,"__proto__":{"hax":1}}]},"ev":[],"et":0}'],
    ["bad event body", '{"t":"snapd","q":2,"b":1,"sc":{},"ev":[{"id":1,"e":{"t":"enemyKill"}}],"et":0}'],
  ];
  for (const [label, raw] of bad) {
    let rejected = false;
    try { jsonCodec.decodeServer(raw); } catch (err) { rejected = err instanceof Error; }
    check(`${label} rejected`, rejected);
  }
  const base = makeBaseSnap();
  const selfFrame = (self: object): string => JSON.stringify({
    t: "snapd",
    q: 2,
    b: 1,
    sc: { tick: base.tick + 1 },
    self,
    ev: [],
    et: 0,
  });
  const malformedSelf: Array<[string, object]> = [
    ["H4 d:false", { d: false }],
    ["H4 d:true plus f", { d: true, f: base.self }],
    ["H4 f plus p", { f: base.self, p: { coins: 2 } }],
    ["H4 unknown discriminator", { x: 1 }],
    ["H4 extra key", { d: true, extra: 1 }],
    ["H4 missing discriminator", {}],
  ];
  for (const [label, self] of malformedSelf) {
    let rejected = false;
    try { jsonCodec.decodeServer(selfFrame(self)); } catch (err) { rejected = err instanceof Error; }
    check(`${label} rejected without deleting baseline self`, rejected && base.self !== null);
  }
  const validSelf: Array<[string, object, "d" | "f" | "p"]> = [
    ["delete", { d: true }, "d"],
    ["full", { f: base.self }, "f"],
    ["patch", { p: { coins: (base.self?.coins ?? 0) + 1 } }, "p"],
  ];
  for (const [label, self, discriminator] of validSelf) {
    const decoded = jsonCodec.decodeServer(selfFrame(self));
    check(`H4 valid ${label} discriminator passes exactly`,
      decoded.t === "snapd"
      && decoded.self !== undefined
      && discriminator in decoded.self
      && Object.keys(decoded.self).length === 1);
  }
  // A well-formed delta whose baseline the receiver never had is a client-side DROP: the pure
  // apply is deliberately dumb (it trusts the caller's baseline match), so the guard lives at
  // the client. Here we simply prove the delta advertises its baseline so the client CAN detect.
  const next = cloneSnap(base); next.sseq = 7; next.tick = base.tick + 1;
  const d = diffSnapshot(snapshotToWire(base), snapshotToWire(next), next.sseq, fullWorld(next));
  check("a delta advertises its baseline sseq so a client can refuse a gap", d.b === base.sseq && d.q === 7);

  check("protocol version is current (v34: Batch0 encounter wire)", PROTOCOL_VERSION === 34);
}

function main(): void {
  roundTripTests();
  tombstoneTests();
  additionAndSelfTests();
  eventPassthroughTests();
  safetyTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll snapshot delta assertions passed.\n");
}

main();
