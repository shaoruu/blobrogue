// Protocol contract suite: BOTH wire directions round-trip losslessly through the strict
// runtime validators, fuzzed garbage can only ever produce ProtocolError (never an uncaught
// throw into a loop), security-sensitive client frames reject unknown fields (a smuggled `dt`
// is an error, not silently ignored), and the AuthoritativePlayerSnapshot projection/apply
// boundary covers every server-owned player field with runtime proof (the missing-field class
// of bug that split inventory authority).
//
// Run: npm run test:protocol

import {
  jsonCodec, ProtocolError, buildSnapshot, toSelfWire, applySelfWire, eventScope, effectFromWire,
  PROTOCOL_VERSION, INTEREST_EXIT_FACTOR, worldIdForRoomCode, isValidWorldId,
  type ClientMsg, type RosterWire, type ServerMsg, type WireEvent,
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
  p.fireCd = 0.11; p.chargeT = 0.42; p.fangCd = 0.85;
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
    { t: "input", seq: 41, mx: -1, my: 0.5, aim: 2.25, fire: true, dash: false, act: true, ult: true, ackEv: 17 },
    { t: "pong", id: 3 },
    { t: "equip", weapon: "shotgun", cseq: 5 },
    { t: "reorder", from: 0, to: 3, cseq: 6 },
    { t: "drop", weapon: "railgun", cseq: 7 },
    { t: "swap", pickup: 12, drop: "railgun", cseq: 8 },
    { t: "shopBuy", slot: 2, cseq: 9 },
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
    const raw = JSON.stringify({ t: "input", seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false, act: false, ult: false, ackEv: 0, dt });
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
  let v17Input = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "input", seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false, act: false, ackEv: 0 })); }
  catch (err) { v17Input = err instanceof ProtocolError; }
  check("a v17 input (no ult) is a protocol error — the ult-requested intent is mandatory (v18)", v17Input);
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
    // The v9 swap is strict too: a tampered client can name a pickup + an owned drop, but
    // never smuggle a grant/outcome, a junk weapon id, or a malformed pickup id.
    ["swap with an unknown drop weapon id", { t: "swap", pickup: 1, drop: "bfg9000", cseq: 1 }],
    ["swap with a negative pickup id", { t: "swap", pickup: -1, drop: "pistol", cseq: 1 }],
    ["swap with a float pickup id", { t: "swap", pickup: 1.5, drop: "pistol", cseq: 1 }],
    ["swap with a smuggled grant field", { t: "swap", pickup: 1, drop: "pistol", cseq: 1, grant: "railgun" }],
    ["swap without cseq", { t: "swap", pickup: 1, drop: "pistol" }],
    // A tampered buy can name a slot, but never smuggle a price/outcome or dodge cseq.
    ["shopBuy with a smuggled price", { t: "shopBuy", slot: 0, cseq: 1, price: 0 }],
    ["shopBuy with a negative slot", { t: "shopBuy", slot: -1, cseq: 1 }],
    ["shopBuy with a float slot", { t: "shopBuy", slot: 0.5, cseq: 1 }],
    ["shopBuy with an oversized slot", { t: "shopBuy", slot: 999, cseq: 1 }],
    ["shopBuy without cseq", { t: "shopBuy", slot: 0 }],
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
  // A live pending pick so pnd round-trips non-empty with its authoritative countdown.
  w.pendingBlessings.set("pOther", 41.2);
  devSpawnEnemy(w, "boss", me.x + 200, me.y);
  w.bullets.push({ x: me.x + 10, y: me.y + 5, vx: 250, vy: -40, radius: 5, life: 1, friendly: true, owner: "pMe", damage: 2, color: "#fff", pierce: 0, hitList: null, isCrit: false, fx: "pistol" });
  // One live weapon effect of every kind (the v8 effs list) + the effect events.
  w.effects.push(
    { id: 0, kind: "zone", owner: "pMe", fx: "frostline", x: 100, y: 110, life: 2.5, maxLife: 3.5, radius: 26, chillRate: 2.4 },
    { id: 1, kind: "wire", owner: "pMe", fx: "snapwire", x: 50, y: 60, x2: 170, y2: 60, width: 14, arm: 0.4, life: 11, maxLife: 12.7, damage: 9 },
    { id: 2, kind: "orbit", owner: "pMe", fx: "halo", x: 300, y: 300, life: 1, maxLife: 1, angle: 1.2, ring: 46, blades: 4, bladeRadius: 12, speed: 3.6, flare: 0.2, damage: 1.5, rehit: new Map() },
    { id: 3, kind: "sentry", owner: "pMe", fx: "sentry", x: 400, y: 380, life: 9, maxLife: 12, radius: 13, hp: 7, maxHp: 12, fireCd: 0.2, range: 240, boltSpeed: 520, boltRadius: 4, boltDamage: 2.4, boltPierce: 0, contactCd: 0, targetEid: -1 },
    { id: 4, kind: "tether", owner: "pMe", fx: "crook", x: 200, y: 210, life: 1.1, maxLife: 2.35, eid: 5, phase: "hold", isPlayerPulled: false, pullSpeed: 560, holdDist: 64, holdTime: 1.2, pullTime: 0.4, damage: 5, reach: 90 },
    // v18 kit-ult entities: the Mender's heal zone + the Bulwark's bullet-blocking dome.
    { id: 5, kind: "sanctuary", owner: "pMe", fx: "beam", x: 120, y: 130, life: 3.5, maxLife: 4.0, radius: 120, healRate: 1 },
    { id: 6, kind: "aegis", owner: "pMe", fx: "sawnoff", x: 140, y: 150, life: 3.2, maxLife: 4.0, radius: 110, hp: 9, maxHp: 12 },
  );
  const events: WireEvent[] = [
    { id: 7, e: { t: "enemyKill", eid: 1, kind: "slime", tier: "swarm", x: 10, y: 20, combo: 3 } },
    { id: 8, e: { t: "descend", toFloor: 3 } },
    { id: 9, e: { t: "gameOver", pid: "pMe" } },
    { id: 10, e: { t: "weaponDrop", weapon: "railgun", x: 33, y: 44 } },
    { id: 11, e: { t: "wireSnap", x: 50, y: 60, tx: 170, ty: 60 } },
    { id: 12, e: { t: "tetherLatch", eid: 5, x: 200, y: 210, tx: 260, ty: 210, inv: false } },
    { id: 13, e: { t: "sentryShot", x: 400, y: 380, aim: 0.5 } },
    { id: 14, e: { t: "haloFlare", x: 300, y: 300, r: 96 } },
  ];
  const snap = buildSnapshot(w, "pMe", 12, events, 9, false, { worldId: "w-test" });
  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("full snapshot round-trips deep-equal", deepEqual(decoded, snap));
  check("the effs list carries every effect kind (incl. the v18 sanctuary/aegis ult entities)", snap.t === "snap"
    && ["zone", "wire", "orbit", "sentry", "tether", "sanctuary", "aegis"].every((k) => snap.effs.some((e) => e.k === k)));
  if (decoded.t === "snap") {
    const kinds = decoded.effs.map((e) => effectFromWire(e).kind);
    check("every decoded effect rebuilds a render-ready entity", deepEqual(kinds, ["zone", "wire", "orbit", "sentry", "tether", "sanctuary", "aegis"]));
    const aegis = decoded.effs.find((e) => e.k === "aegis")!;
    const rebuiltAegis = effectFromWire(aegis);
    check("aegis barrier HP survives the trip (the client draws the dome by budget)", rebuiltAegis.kind === "aegis" && rebuiltAegis.hp === 9 && rebuiltAegis.maxHp === 12);
    const wire = decoded.effs.find((e) => e.k === "wire")!;
    const rebuilt = effectFromWire(wire);
    check("wire geometry survives the trip", rebuilt.kind === "wire" && rebuilt.x2 === 170 && rebuilt.arm === 0.4);
    const sentry = decoded.effs.find((e) => e.k === "sentry")!;
    check("sentry durability survives the trip (the client draws real pips)", sentry.hp === 7 && sentry.mhp === 12);
  }

  const others: ServerMsg[] = [
    { t: "ping", id: 4, tick: 100, time: 1234567 },
    { t: "offer", id: 2, choices: ["it_a", "it_b", "it_c"] },
    { t: "error", code: "auth", msg: "nope" },
  ];
  for (const m of others) {
    check(`round-trip ${m.t}`, deepEqual(jsonCodec.decodeServer(jsonCodec.encodeServer(m)), m));
  }

  section("v8: the shop stall rides shop-floor snapshots and validates strictly");
  {
    const ws = createWorld(0x5B0B, 3, { isShared: true, skipLocalPlayer: true });
    const buyer = spawnPlayerInWorld(ws, "pBuyer");
    spawnPlayerInWorld(ws, "pMate");
    // A claimed shared slot + a personal buyer, so sold/by round-trip non-empty.
    ws.shop!.slots[0].soldTo = "pBuyer";
    ws.shop!.slots.find((s) => s.kind === "heart")!.buyers.push("pBuyer", "pMate");
    ws.shop!.rerollsUsed = 1;
    const shopSnap = buildSnapshot(ws, buyer.id, 0, [], 0, false, { worldId: "w-test" });
    if (shopSnap.t !== "snap") { check("shop snapshot built", false); return; }
    check("a shop floor's snapshot carries the stall", shopSnap.shop !== null && shopSnap.shop.slots.length === 5);
    check("shop snapshot round-trips deep-equal", deepEqual(jsonCodec.decodeServer(jsonCodec.encodeServer(shopSnap)), shopSnap));
    const shopBase = JSON.parse(jsonCodec.encodeServer(shopSnap)) as Record<string, unknown>;
    const shopWire = (over: Record<string, unknown>): Record<string, unknown> =>
      ({ ...shopBase, shop: { ...(shopBase.shop as Record<string, unknown>), ...over } });
    const badShop: Array<[string, Record<string, unknown>]> = [
      ["missing shop field", (() => { const o = { ...shopBase }; delete o.shop; return o; })()],
      ["non-object shop", { ...shopBase, shop: 42 }],
      ["junk slot kind", shopWire({ slots: [{ id: 0, k: "cheat", sh: true, wpn: null, it: null, pr: 1, x: 0, y: 0, sold: null, by: [] }] })],
      ["junk slot weapon id", shopWire({ slots: [{ id: 0, k: "weapon", sh: true, wpn: "bfg9000", it: null, pr: 1, x: 0, y: 0, sold: null, by: [] }] })],
      ["negative price", shopWire({ slots: [{ id: 0, k: "weapon", sh: true, wpn: "pistol", it: null, pr: -1, x: 0, y: 0, sold: null, by: [] }] })],
      ["junk rerolls counter", shopWire({ ru: "many" })],
    ];
    for (const [label, frame] of badShop) {
      let rejected = false;
      try { jsonCodec.decodeServer(JSON.stringify(frame)); } catch (err) { rejected = err instanceof ProtocolError; }
      check(`${label} is a protocol error`, rejected);
    }
  }

  section("corrupt server frames are ProtocolError, never NaN state");
  const snapObj = JSON.parse(jsonCodec.encodeServer(snap)) as Record<string, unknown>;
  const corrupt = [
    { ...snapObj, tick: "NaN" },
    { ...snapObj, floor: 0 },
    { ...snapObj, self: { hp: 1 } },
    { ...snapObj, enemies: [{ id: 1 }] },
    { ...snapObj, events: [{ id: 0, e: { t: "enemyKill" } }] },
    { ...snapObj, wait: [42] },
    { ...snapObj, exr: [""] },
    { ...snapObj, exr: "p1" },
    { t: "snap" },
  ];
  for (let i = 0; i < corrupt.length; i++) {
    let rejected = false;
    try { jsonCodec.decodeServer(JSON.stringify(corrupt[i])); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`corrupt snapshot variant ${i} rejected`, rejected);
  }
}

// v4 room-correctness fields: the authoritative world id + connected roster are REQUIRED and
// strictly validated on every snapshot — a client can always assert which world it is in and
// who is actually there (the Sev-0 readout).
function worldBindingWireTests(): void {
  section("v4: authoritative world id + roster are required, strict, and round-trip");
  check("protocol version covers v4-v17 + the KIT/CLASS + ULT + account-MASTERY system (v18: SelfWire kit/ult block, the ult input bit, sanctuary/aegis effect kinds, the 4 ult SimEvents, the kit/mastery ticket claim)", PROTOCOL_VERSION === 18, `v=${PROTOCOL_VERSION}`);
  check("room code maps to its world id", worldIdForRoomCode(" abcd ") === "room:ABCD");
  check("room world ids pass the shared charset gate", isValidWorldId(worldIdForRoomCode("ZZZZ")) && isValidWorldId("arena-1"));
  check("junk world ids fail the shared charset gate", !isValidWorldId("room:../../etc") && !isValidWorldId(""));

  const w = createWorld(0xF00D, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pMe");
  spawnPlayerInWorld(w, "pOther");
  const roster: RosterWire[] = [
    { pid: "pMe", aid: "player-1", nm: "Ada", cl: 2, st: "on" },
    { pid: "pOther", aid: "guest:abc", nm: "Bob", cl: null, st: "away" },
  ];
  w.pendingBlessings.set("pMe", 42.3);
  w.pendingBlessings.set("pOther", 7);
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: worldIdForRoomCode("ABCD"), roster, resumeToken: "tok-abc123" });
  if (snap.t !== "snap") { check("snapshot built", false); return; }
  check("snapshot carries the world id", snap.wid === "room:ABCD");
  check("snapshot carries the full roster (interest-independent identities + on/away)", deepEqual(snap.roster, roster));
  check("snapshot carries the resume token when supplied", snap.tok === "tok-abc123");
  check("snapshot carries the party-wait state (sorted, whole seconds)",
    deepEqual(snap.wait, [{ pid: "pMe", s: 43 }, { pid: "pOther", s: 7 }]), JSON.stringify(snap.wait));
  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("wid/roster/tok/wait round-trip deep-equal", deepEqual(decoded, snap));

  const base = JSON.parse(jsonCodec.encodeServer(snap)) as Record<string, unknown>;
  const bad: Array<[string, Record<string, unknown>]> = [
    ["missing wid", (() => { const o = { ...base }; delete o.wid; return o; })()],
    ["empty wid", { ...base, wid: "" }],
    ["junk-charset wid", { ...base, wid: "room:../../etc" }],
    ["missing roster", (() => { const o = { ...base }; delete o.roster; return o; })()],
    ["non-array roster", { ...base, roster: {} }],
    ["roster entry missing aid", { ...base, roster: [{ pid: "p1", nm: "x", cl: null, st: "on" }] }],
    ["roster entry with junk color", { ...base, roster: [{ pid: "p1", aid: "a", nm: "x", cl: 99999, st: "on" }] }],
    ["roster entry with junk seat state", { ...base, roster: [{ pid: "p1", aid: "a", nm: "x", cl: null, st: "zombie" }] }],
    ["non-string resume token", { ...base, tok: 42 }],
    ["missing wait", (() => { const o = { ...base }; delete o.wait; return o; })()],
    ["non-array wait", { ...base, wait: {} }],
    ["wait entry with junk seconds", { ...base, wait: [{ pid: "p1", s: "soon" }] }],
  ];
  for (const [label, frame] of bad) {
    let rejected = false;
    try { jsonCodec.decodeServer(JSON.stringify(frame)); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`${label} is a protocol error`, rejected);
  }

  // The reconnect handshake frames themselves.
  const joinResume: ClientMsg = { t: "join", ticket: "v1.a.b", protocol: PROTOCOL_VERSION, resume: "tok-xyz" };
  check("join with a resume token round-trips", deepEqual(jsonCodec.decodeClient(jsonCodec.encodeClient(joinResume)), joinResume));
  const leave: ClientMsg = { t: "leave" };
  check("leave round-trips", deepEqual(jsonCodec.decodeClient(jsonCodec.encodeClient(leave)), leave));
  let extraOnLeave = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "leave", pid: "hax" })); } catch (err) { extraOnLeave = err instanceof ProtocolError; }
  check("leave with a smuggled field is a protocol error", extraOnLeave);
  let junkResume = false;
  try { jsonCodec.decodeClient(JSON.stringify({ t: "join", ticket: "x", protocol: PROTOCOL_VERSION, resume: 42 })); } catch (err) { junkResume = err instanceof ProtocolError; }
  check("join with a non-string resume token is a protocol error", junkResume);
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
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", identities });
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
  const snapIn = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", interestRadius: R, view });
  check("entity inside R enters the view", snapIn.t === "snap" && snapIn.enemies.some((x) => x.id === e.id));
  // Drift just past R but inside the exit radius: hysteresis keeps it.
  e.x = me.x + R + 20;
  const snapHold = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", interestRadius: R, view });
  check("entity between R and exit radius is RETAINED (hysteresis)", snapHold.t === "snap" && snapHold.enemies.some((x) => x.id === e.id));
  // Past the exit radius: leaves.
  e.x = me.x + R * INTEREST_EXIT_FACTOR + 30;
  const snapOut = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", interestRadius: R, view });
  check("entity beyond the exit radius leaves the view", snapOut.t === "snap" && !snapOut.enemies.some((x) => x.id === e.id));
  // Back inside R re-enters; a NEVER-known entity between R and exit stays out (no false enter).
  e.x = me.x + R - 40;
  const fresh = devSpawnEnemy(w, "slime", me.x + R + 20, me.y);
  const snapBack = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", interestRadius: R, view });
  check("entity re-enters inside R", snapBack.t === "snap" && snapBack.enemies.some((x) => x.id === e.id));
  check("an unknown entity in the hysteresis band does NOT enter", snapBack.t === "snap" && !snapBack.enemies.some((x) => x.id === fresh.id));
}

// v9: the remote-dash sync — PlayerWire carries the authoritative dash/invuln block so
// OBSERVING clients render a teammate's dash. Locks: the fields ride buildSnapshot from
// PlayerSim truth, round-trip losslessly, validate strictly, and read identically for every
// observer (two clients must agree on when/where a dash happened).
function remoteDashWireTests(): void {
  section("v9: PlayerWire carries the dash/invuln readout — strict, lossless, observer-identical");
  const w = createWorld(0xDA51, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pMe");
  spawnPlayerInWorld(w, "pMate");
  const dasher = spawnPlayerInWorld(w, "pDash");
  dasher.dashTime = 0.12; dasher.dashDx = -0.6; dasher.dashDy = 0.8;
  dasher.dashInvuln = 0.14; dasher.invuln = 0.25;
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test" });
  if (snap.t !== "snap") { check("snapshot built", false); return; }
  const seen = snap.players.find((p) => p.id === "pDash");
  check("the dash block rides the observer's wire straight from PlayerSim truth",
    seen !== undefined && seen.dti === 0.12 && seen.ddx === -0.6 && seen.ddy === 0.8
    && seen.dnv === 0.14 && seen.inv === 0.25,
    JSON.stringify(seen && { dti: seen.dti, ddx: seen.ddx, ddy: seen.ddy, dnv: seen.dnv, inv: seen.inv }));
  check("dash fields round-trip losslessly", deepEqual(jsonCodec.decodeServer(jsonCodec.encodeServer(snap)), snap));

  const snapB = buildSnapshot(w, "pMate", 0, [], 0, false, { worldId: "w-test" });
  const seenB = snapB.t === "snap" ? snapB.players.find((p) => p.id === "pDash") : undefined;
  check("both observers decode an IDENTICAL dash block (agreement on when/where)",
    seenB !== undefined && deepEqual(seen, seenB));

  const corruptDash = (over: Record<string, unknown>, drop?: string): string => {
    const o = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
    const row = o.players.find((p) => p.id === "pDash")!;
    Object.assign(row, over);
    if (drop) delete row[drop];
    return JSON.stringify(o);
  };
  const badFrames: Array<[string, string]> = [
    ["junk dti", corruptDash({ dti: "fast" })],
    ["out-of-range ddx", corruptDash({ ddx: 99 })],
    ["negative dnv", corruptDash({ dnv: -1 })],
    ["a v8 frame (dash block missing)", corruptDash({}, "dti")],
  ];
  for (const [label, frame] of badFrames) {
    let rejected = false;
    try { jsonCodec.decodeServer(frame); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`${label} is a protocol error`, rejected);
  }
}

function eventScopeTests(): void {
  section("event scope: pid events target their player, positional FX carry coords, objectives are global");
  const cases: Array<[SimEvent, string]> = [
    // v14: a networked player's combat FX are POSITIONAL (delivered to nearby observers,
    // not only the actor), so a teammate's shot/hurt is seen + heard where it happens.
    [{ t: "playerHurt", pid: "p7", x: 1, y: 2 }, "pos"],
    [{ t: "shot", pid: "p7", weapon: "pistol", x: 1, y: 2, aim: 0, px: 1, py: 2, chg: 0 }, "pos"],
    [{ t: "heal", pid: "p7", x: 1, y: 2 }, "pos"],
    [{ t: "pickup", pid: "p7", kind: "coin", x: 1, y: 2 }, "pos"],
    [{ t: "friendlyNudge", shooterId: "p7", targetId: "p8", x: 1, y: 2, dirX: 1, dirY: 0 }, "pos"],
    // Deliberately pid: remote dash FX ride PlayerWire dash STATE (v9), so broadcasting
    // these would double-play the dasher's juice.
    [{ t: "dashStart", pid: "p7", x: 1, y: 2 }, "pid"],
    [{ t: "dashTrail", pid: "p7", x: 1, y: 2 }, "pid"],
    [{ t: "explosion", x: 10, y: 20, r: 90 }, "pos"],
    [{ t: "descend", toFloor: 2 }, "global"],
    [{ t: "bossPhase", eid: 3, x: 5, y: 6 }, "global"],
    [{ t: "gameOver", pid: "p1" }, "pid"],
    [{ t: "enemyKill", eid: 1, kind: "slime", tier: "standard", x: 3, y: 4, combo: 0 }, "pos"],
    [{ t: "weaponDrop", weapon: "railgun", x: 5, y: 6 }, "pos"],
    // v18 ult casts are positional (nearby clients render the cast FX).
    [{ t: "ultOverdrive", pid: "p7", x: 1, y: 2, durationTicks: 100 }, "pos"],
    [{ t: "ultSanctuary", pid: "p7", x: 1, y: 2, radius: 120, lifetimeTicks: 80 }, "pos"],
    [{ t: "ultAegis", pid: "p7", x: 1, y: 2, radius: 110, hpBudget: 12, lifetimeTicks: 80 }, "pos"],
    [{ t: "ultPhase", pid: "p7", x: 1, y: 2, radius: 90, invulnTicks: 20, speedTicks: 60 }, "pos"],
  ];
  for (const [e, kind] of cases) {
    check(`${e.t} -> ${kind}`, eventScope(e).kind === kind, `got=${eventScope(e).kind}`);
  }
}

function main(): void {
  clientRoundTripTests();
  unknownFieldTests();
  serverRoundTripTests();
  worldBindingWireTests();
  identityWireTests();
  remoteDashWireTests();
  fuzzTests();
  projectionTests();
  interestHysteresisTests();
  eventScopeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll protocol contract assertions passed.\n");
}

main();
