// Protocol contract suite: BOTH wire directions round-trip losslessly through the strict
// runtime validators, fuzzed garbage can only ever produce ProtocolError (never an uncaught
// throw into a loop), security-sensitive client frames reject unknown fields (a smuggled `dt`
// is an error, not silently ignored), and the AuthoritativePlayerSnapshot projection/apply
// boundary covers every server-owned player field with runtime proof (the missing-field class
// of bug that split inventory authority).
//
// Run: npm run test:protocol

import {
  jsonCodec, ProtocolError, buildSnapshot, toSelfWire, applySelfWire, eventScope,
  PROTOCOL_VERSION, INTEREST_EXIT_FACTOR,
  type ClientMsg, type ServerMsg, type WireEvent,
} from "../src/net/protocol.js";
import { projectPlayer, applyPlayerSnapshot, modsFromWire } from "../src/net/playerSnapshot.js";
import { createWorld, createPlayer, spawnPlayerInWorld, devSpawnEnemy } from "../src/sim/world.js";
import type { PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import { createMods } from "../src/sim/items.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A deterministic PRNG for the fuzzers (reproducible failures).
function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A player with EVERY server-owned field set to a distinctive non-default value, so any field
// silently dropped by projection/wire/apply shows up as a mismatch.
function distinctivePlayer(): PlayerSim {
  const p = createPlayer("pX", 1234.5, -678.25);
  p.hp = 7; p.maxHp = 11;
  p.invuln = 0.375; p.dashInvuln = 0.125;
  p.dashCd = 0.5; p.dashTime = 0.0625; p.dashDx = -0.6; p.dashDy = 0.8;
  p.fireCd = 0.11; p.fangCd = 0.85;
  p.facing = -1;
  p.weapon = "railgun";
  p.ownedWeapons = ["pistol", "railgun", "tesla"];
  p.ownedItemIds = ["it_dmg", "it_speed", "it_dmg"];
  p.mods = createMods();
  p.mods.damageMult = 1.9; p.mods.fireRateMult = 1.3; p.mods.moveSpeedMult = 1.15;
  p.mods.maxHpBonus = 3; p.mods.extraPellets = 2; p.mods.pierce = 1;
  p.mods.critChance = 0.21; p.mods.dashCdMult = 0.8; p.mods.coinMult = 2;
  p.isDown = true;
  p.reviveProgress = 0.65;
  p.kills = 42; p.coins = 137; p.combo = 9; p.comboTimer = 1.75;
  return p;
}

function clientRoundTripTests(): void {
  section("client messages round-trip losslessly through the strict decoder");
  const msgs: ClientMsg[] = [
    { t: "join", ticket: "v1.abc.def", protocol: PROTOCOL_VERSION },
    { t: "input", seq: 41, mx: -1, my: 0.5, aim: 2.25, fire: true, dash: false, act: true, ackEv: 17 },
    { t: "pong", id: 3 },
    { t: "equip", weapon: "shotgun", cseq: 5 },
    { t: "reorder", from: 0, to: 3, cseq: 6 },
    { t: "drop", weapon: "railgun", cseq: 7 },
    { t: "chooseBlessing", offerId: 2, choiceId: "it_dmg" },
    { t: "spec", target: "p7" },
    { t: "stat", rtt: 120, jit: 14, rec: 3, corr: 22, dly: 130 },
  ];
  for (const m of msgs) {
    const decoded = jsonCodec.decodeClient(jsonCodec.encodeClient(m));
    check(`round-trip ${m.t}`, deepEqual(decoded, m));
  }
}

function unknownFieldTests(): void {
  section("security-sensitive client frames REJECT unknown fields (malicious dt)");
  const dtVariants = [0, 1e9, -5, 0.0001];
  for (const dt of dtVariants) {
    const raw = JSON.stringify({ t: "input", seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false, act: false, ackEv: 0, dt });
    let rejected = false;
    try { jsonCodec.decodeClient(raw); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`input carrying dt=${dt} is a protocol error`, rejected);
  }
  let joinExtra = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "join", ticket: "x", protocol: PROTOCOL_VERSION, isAdmin: true })); }
  catch (err) { joinExtra = err instanceof ProtocolError; }
  check("join with a smuggled extra field is a protocol error", joinExtra);
  let missing = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "join", ticket: "x" })); }
  catch (err) { missing = err instanceof ProtocolError; }
  check("join with a MISSING protocol version is a protocol error (no default-to-0)", missing);
  let legacyInput = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "input", seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false, ackEv: 0 })); }
  catch (err) { legacyInput = err instanceof ProtocolError; }
  check("a v4 input (no act) is a protocol error — the interact intent is mandatory", legacyInput);
  let specExtra = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "spec", target: "p1", x: 5 })); }
  catch (err) { specExtra = err instanceof ProtocolError; }
  check("spec with a smuggled extra field is a protocol error", specExtra);

  // Inventory commands are strict too: unknown fields, out-of-range/float indices, and
  // unknown weapon ids are protocol errors, never silently coerced.
  const badInventoryFrames: Array<[string, Record<string, unknown>]> = [
    ["reorder with a smuggled extra field", { t: "reorder", from: 0, to: 1, cseq: 1, order: ["railgun"] }],
    ["reorder with a negative index", { t: "reorder", from: -1, to: 1, cseq: 1 }],
    ["reorder with a float index", { t: "reorder", from: 0.5, to: 1, cseq: 1 }],
    ["reorder with an oversized index", { t: "reorder", from: 0, to: 999, cseq: 1 }],
    ["reorder without cseq", { t: "reorder", from: 0, to: 1 }],
    ["drop with an unknown weapon id", { t: "drop", weapon: "bfg9000", cseq: 1 }],
    ["drop with a smuggled extra field", { t: "drop", weapon: "pistol", cseq: 1, x: 10 }],
    ["drop without cseq", { t: "drop", weapon: "pistol" }],
  ];
  for (const [label, frame] of badInventoryFrames) {
    let isRejected = false;
    try { jsonCodec.decodeClient(JSON.stringify(frame)); } catch (err) { isRejected = err instanceof ProtocolError; }
    check(`${label} is a protocol error`, isRejected);
  }
}

function serverRoundTripTests(): void {
  section("server messages round-trip losslessly through the exhaustive validator");
  // A real world with every entity class present, so the snapshot exercises every wire struct.
  const w = createWorld(0xBEEFCAFE, 2, { isShared: true, skipLocalPlayer: true });
  const me = spawnPlayerInWorld(w, "pMe");
  const other = spawnPlayerInWorld(w, "pOther");
  other.x = me.x + 40; other.y = me.y - 25;
  devSpawnEnemy(w, "boss", me.x + 200, me.y);
  w.bullets.push({ x: me.x + 10, y: me.y + 5, vx: 250, vy: -40, radius: 5, life: 1, friendly: true, owner: "pMe", damage: 2, color: "#fff", pierce: 0, hitList: null, isCrit: false, fx: "pistol" });
  const events: WireEvent[] = [
    { id: 7, e: { t: "enemyKill", eid: 1, kind: "slime", tier: "swarm", x: 10, y: 20, combo: 3 } },
    { id: 8, e: { t: "descend", toFloor: 3 } },
    { id: 9, e: { t: "gameOver", pid: "pMe" } },
    { id: 10, e: { t: "weaponDrop", weapon: "railgun", x: 33, y: 44 } },
  ];
  const snap = buildSnapshot(w, "pMe", 12, events, 9, false, {});
  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("full snapshot round-trips deep-equal", deepEqual(decoded, snap));

  const others: ServerMsg[] = [
    { t: "ping", id: 4, tick: 100, time: 1234567 },
    { t: "offer", id: 2, choices: ["it_a", "it_b", "it_c"] },
    { t: "error", code: "auth", msg: "nope" },
  ];
  for (const m of others) {
    check(`round-trip ${m.t}`, deepEqual(jsonCodec.decodeServer(jsonCodec.encodeServer(m)), m));
  }

  section("corrupt server frames are ProtocolError, never NaN state");
  const snapObj = JSON.parse(jsonCodec.encodeServer(snap)) as Record<string, unknown>;
  const corrupt = [
    { ...snapObj, tick: "NaN" },
    { ...snapObj, floor: 0 },
    { ...snapObj, self: { hp: 1 } },
    { ...snapObj, enemies: [{ id: 1 }] },
    { ...snapObj, events: [{ id: 0, e: { t: "enemyKill" } }] },
    { t: "snap" },
  ];
  for (let i = 0; i < corrupt.length; i++) {
    let rejected = false;
    try { jsonCodec.decodeServer(JSON.stringify(corrupt[i])); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`corrupt snapshot variant ${i} rejected`, rejected);
  }
}

// PlayerWire identity (nm/cl): decorated from the verified per-connection identities at
// snapshot build, decoded defensively (absent -> id-as-name / no color) so an old server's
// frames still decode, and rejected when present-but-malformed.
function identityWireTests(): void {
  section("player identity on the wire: names/colors decorate, default, and validate");
  const w = createWorld(0xD00D, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pMe");
  const named = spawnPlayerInWorld(w, "pNamed");
  const anon = spawnPlayerInWorld(w, "pAnon");
  anon.x = named.x + 30;

  const identities = new Map([
    ["pNamed", { name: "Ada", colorIndex: 2 }],
    ["pAnon", { name: null, colorIndex: null }],
  ]);
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { identities });
  if (snap.t !== "snap") { check("snapshot built", false); return; }
  const wNamed = snap.players.find((p) => p.id === "pNamed");
  const wAnon = snap.players.find((p) => p.id === "pAnon");
  check("identity decorates the wire (name + color)", wNamed?.nm === "Ada" && wNamed?.cl === 2, `nm=${wNamed?.nm} cl=${wNamed?.cl}`);
  check("guest identity falls back to id-as-name, no color", wAnon?.nm === "pAnon" && wAnon?.cl === null);

  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("identity round-trips deep-equal", deepEqual(decoded, snap));

  // An OLD server's PlayerWire (no nm/cl at all) still decodes, with the safe fallbacks.
  const legacy = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
  for (const p of legacy.players) { delete p.nm; delete p.cl; }
  const fromLegacy = jsonCodec.decodeServer(JSON.stringify(legacy));
  if (fromLegacy.t === "snap") {
    const lp = fromLegacy.players.find((p) => p.id === "pNamed");
    check("nm/cl absent decodes with fallbacks (old-server compat)", lp?.nm === "pNamed" && lp?.cl === null);
  } else {
    check("legacy frame decoded", false);
  }

  // Present-but-malformed identity fields are protocol errors (defensive validation).
  const base = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
  const badVariants: Array<[string, unknown, unknown]> = [
    ["oversized nm", "x".repeat(25), null],
    ["non-string nm", 42, null],
    ["non-integer cl", "Ada", 1.5],
    ["out-of-range cl", "Ada", 999],
  ];
  for (const [label, nm, cl] of badVariants) {
    const bad = JSON.parse(JSON.stringify(base)) as { players: Array<Record<string, unknown>> };
    bad.players[0].nm = nm;
    bad.players[0].cl = cl;
    let isRejected = false;
    try { jsonCodec.decodeServer(JSON.stringify(bad)); } catch (err) { isRejected = err instanceof ProtocolError; }
    check(`${label} rejected`, isRejected);
  }
}

function fuzzTests(): void {
  section("fuzz: both decoders only ever throw ProtocolError");
  const rnd = mulberry(0x5eed);
  const junkValue = (depth: number): unknown => {
    const r = rnd();
    if (depth > 2) return r < 0.5 ? rnd() * 1e9 - 5e8 : "s".repeat(Math.floor(rnd() * 20));
    if (r < 0.2) return { t: ["snap", "input", "join", "x", 42][Math.floor(rnd() * 5)], v: junkValue(depth + 1) };
    if (r < 0.4) return [junkValue(depth + 1), junkValue(depth + 1)];
    if (r < 0.55) return rnd() < 0.5 ? Infinity : NaN;
    if (r < 0.7) return rnd() * 1e12 - 5e11;
    if (r < 0.85) return Math.random().toString(36).repeat(Math.floor(rnd() * 4) + 1);
    return rnd() < 0.5;
  };
  let clientBad = 0, serverBad = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const raw = rnd() < 0.3 ? Math.random().toString(36).slice(2) : JSON.stringify(junkValue(0));
    try { jsonCodec.decodeClient(raw); } catch (err) { if (!(err instanceof ProtocolError)) clientBad++; }
    try { jsonCodec.decodeServer(raw); } catch (err) { if (!(err instanceof ProtocolError)) serverBad++; }
  }
  check(`client decoder: 0/${N} non-ProtocolError throws`, clientBad === 0, `bad=${clientBad}`);
  check(`server decoder: 0/${N} non-ProtocolError throws`, serverBad === 0, `bad=${serverBad}`);
}

function projectionTests(): void {
  section("AuthoritativePlayerSnapshot: every server-owned field survives project->wire->apply");
  const src = distinctivePlayer();
  const wire = JSON.parse(JSON.stringify(toSelfWire(src))) as ReturnType<typeof toSelfWire>;
  const dst = createPlayer("pY", 0, 0);
  applySelfWire(dst, wire);
  const a = projectPlayer(src);
  const b = projectPlayer(dst);
  check("projections deep-equal after a full wire round trip", deepEqual(a, b));
  for (const key of Object.keys(a) as Array<keyof typeof a>) {
    check(`field ${String(key)} round-trips`, deepEqual(a[key], b[key]), `src=${JSON.stringify(a[key])} dst=${JSON.stringify(b[key])}`);
  }

  section("apply is a reset, not a merge (stale local values are overwritten)");
  const stale = createPlayer("pZ", 9999, 9999);
  stale.ownedWeapons = ["pistol", "smg", "cannon", "burst"];
  stale.ownedItemIds = ["it_wrong"];
  stale.mods.damageMult = 99;
  applyPlayerSnapshot(stale, projectPlayer(src));
  check("stale inventory replaced", deepEqual(stale.ownedWeapons, src.ownedWeapons));
  check("stale items replaced", deepEqual(stale.ownedItemIds, src.ownedItemIds));
  check("stale mods replaced", stale.mods.damageMult === src.mods.damageMult);

  section("modsFromWire: holes default to identity; junk keys/values dropped");
  const partial = modsFromWire({ damageMult: 2.5 });
  check("present field kept", partial.damageMult === 2.5);
  check("missing field defaults to identity", partial.fireRateMult === 1 && partial.pierce === 0);
  const junky = modsFromWire({ damageMult: Number.NaN, coinMult: 3, hax: 12 } as unknown as Partial<ReturnType<typeof createMods>>);
  check("NaN dropped to identity", junky.damageMult === 1);
  check("valid field kept", junky.coinMult === 3);
  check("unknown key dropped", !("hax" in junky));
}

function interestHysteresisTests(): void {
  section("interest view: enter at R, leave only beyond R*exit factor (no boundary flicker)");
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const me = spawnPlayerInWorld(w, "pMe");
  me.x = 300; me.y = 300;
  const R = 400;
  const e = devSpawnEnemy(w, "slime", me.x + R - 10, me.y); // just inside -> enters
  const view = { rev: -1, enemies: new Set<number>(), props: new Set<number>(), pickups: new Set<number>(), chests: new Set<number>() };
  const snapIn = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: R, view });
  check("entity inside R enters the view", snapIn.t === "snap" && snapIn.enemies.some((x) => x.id === e.id));
  // Drift just past R but inside the exit radius: hysteresis keeps it.
  e.x = me.x + R + 20;
  const snapHold = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: R, view });
  check("entity between R and exit radius is RETAINED (hysteresis)", snapHold.t === "snap" && snapHold.enemies.some((x) => x.id === e.id));
  // Past the exit radius: leaves.
  e.x = me.x + R * INTEREST_EXIT_FACTOR + 30;
  const snapOut = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: R, view });
  check("entity beyond the exit radius leaves the view", snapOut.t === "snap" && !snapOut.enemies.some((x) => x.id === e.id));
  // Back inside R re-enters; a NEVER-known entity between R and exit stays out (no false enter).
  e.x = me.x + R - 40;
  const fresh = devSpawnEnemy(w, "slime", me.x + R + 20, me.y);
  const snapBack = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: R, view });
  check("entity re-enters inside R", snapBack.t === "snap" && snapBack.enemies.some((x) => x.id === e.id));
  check("an unknown entity in the hysteresis band does NOT enter", snapBack.t === "snap" && !snapBack.enemies.some((x) => x.id === fresh.id));
}

function eventScopeTests(): void {
  section("event scope: pid events target their player, positional FX carry coords, objectives are global");
  const cases: Array<[SimEvent, string]> = [
    [{ t: "playerHurt", pid: "p7", x: 1, y: 2 }, "pid"],
    [{ t: "explosion", x: 10, y: 20, r: 90 }, "pos"],
    [{ t: "descend", toFloor: 2 }, "global"],
    [{ t: "bossPhase", eid: 3, x: 5, y: 6 }, "global"],
    [{ t: "gameOver", pid: "p1" }, "pid"],
    [{ t: "enemyKill", eid: 1, kind: "slime", tier: "standard", x: 3, y: 4, combo: 0 }, "pos"],
    [{ t: "weaponDrop", weapon: "railgun", x: 5, y: 6 }, "pos"],
  ];
  for (const [e, kind] of cases) {
    check(`${e.t} -> ${kind}`, eventScope(e).kind === kind, `got=${eventScope(e).kind}`);
  }
}

function main(): void {
  clientRoundTripTests();
  unknownFieldTests();
  serverRoundTripTests();
  identityWireTests();
  fuzzTests();
  projectionTests();
  interestHysteresisTests();
  eventScopeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll protocol contract assertions passed.\n");
}

main();
