// Pet ability gates. Pets now fire AUTONOMOUSLY (smart AI, no player bind): each verb self-casts
// when its deterministic smart trigger reads a useful context, entirely server-authoritative. This
// suite pins BOTH halves:
//   - AUTO-CAST: every verb fires on its trigger with ZERO player input, stays quiet in an empty
//     context (no CD burned on empty air), and still honors the CD / party / downed / PVP rails.
//   - The retained rails: utility-only ZERO-dps verbs, the shared cooldown, the 0.30s tell, party
//     throttle / soft-cap, PVP hard-off, the FETCH coin-only deny-list, and reconnect-safe wire.
// The (production-unbound) request bit survives only as a DEBUG force-cast; `press(true)` exercises
// it to drive the deterministic rail checks below — a live client never sets it.
//
// Run: npx tsx test/petability.test.ts

import {
  createWorld, spawnPlayerInWorld, setPlayerPet, stepWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import type { Pickup, Hazard, Enemy, EnemyTier } from "../src/sim/types.js";
import {
  PET_ABILITY, petVerbFor, petCooldownTicks, petVerbNeedsTarget, slimeSlowMul, isFetchablePickup,
} from "../src/sim/petAbilities.js";
import {
  DOGGIE_PET_ID, WICK_PET_ID, CAT_PET_ID, DRAGON_PET_ID, SLIME_PET_ID,
  PEBBLE_PET_ID, CLATTER_PET_ID, NULLFIN_PET_ID,
} from "../src/sim/camp_nodes.js";
import { createEnemy } from "../src/sim/enemies.js";
import { toSelfWire, applySelfWire, toEnemyWire, enemyFromWire } from "../src/net/protocol.js";

const DT = 1 / 20;
let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(n: string): void { process.stdout.write(`\n[${n}]\n`); }

// The petAbility bit is the DEBUG force-cast (production pets have no bind): press(true) forces a
// cast under the same rails as auto-cast, press(false) is the pure-idle production input.
function press(petAbility: boolean, seq = 1): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false, ult: false, pulse: false, petAbility };
}

function coopWorld(seed = 0x9e77): WorldState {
  return createWorld(seed, 1, { isShared: true, skipLocalPlayer: true });
}

// Spawn a player at the dungeon spawn tile with an equipped ability pet bound in the sim.
function addPet(w: WorldState, id: string, pet: string): PlayerSim {
  const p = spawnPlayerInWorld(w, id);
  setPlayerPet(w, id, pet);
  return p;
}

function makeCoin(w: WorldState, x: number, y: number): Pickup {
  const c: Pickup = { id: w.nextPickupId++, kind: "coin", x, y, radius: 8, weapon: null, value: 1 };
  w.pickups.push(c);
  return c;
}

// Drop a live enemy at (x,y) with an explicit tier and attack phase — the two dimensions STALK
// and RATTLE key off. Spawn grace is cleared so the body reads as a genuine combatant this tick.
function makeEnemy(w: WorldState, x: number, y: number, opts: { tier?: EnemyTier; kind?: Enemy["kind"]; windup?: boolean } = {}): Enemy {
  const e = createEnemy(opts.kind ?? "skeleton", x, y, w.floor, w.rng, w.nextEnemyId++, { tier: opts.tier ?? "standard" });
  e.spawnTimer = 0;
  if (opts.windup) e.attack.phase = "windup";
  w.enemies.push(e);
  return e;
}

// Drive the world one full authoritative tick with a single player's input.
function tick1(w: WorldState, id: string, input: InputCmd): void {
  stepWorld(w, new Map([[id, input]]), DT);
}

// Press once, then idle through the tell until the verb resolves (the effect window opens or the
// party gate no-ops it). Returns after the tell can no longer be in flight.
function castAndSettle(w: WorldState, id: string, extraTicks = 10): void {
  tick1(w, id, press(true));
  for (let i = 0; i < extraTicks; i++) tick1(w, id, press(false));
}

function pureContractTests(): void {
  section("pure contract: full 8-pet verb registry + FETCH deny-list");
  check("doggie grants FETCH", petVerbFor(DOGGIE_PET_ID) === "fetch");
  check("wick grants PINPRICK", petVerbFor(WICK_PET_ID) === "pinprick");
  check("cat grants STALK", petVerbFor(CAT_PET_ID) === "stalk");
  check("dragon grants EMBERPUFF", petVerbFor(DRAGON_PET_ID) === "emberpuff");
  check("slime grants SLIMETRAIL", petVerbFor(SLIME_PET_ID) === "slimetrail");
  check("pebble grants PEBBLEBRACE", petVerbFor(PEBBLE_PET_ID) === "pebblebrace");
  check("clatter grants RATTLE", petVerbFor(CLATTER_PET_ID) === "rattle");
  check("nullfin grants NULLWAKE", petVerbFor(NULLFIN_PET_ID) === "nullwake");
  check("all 8 roster pets grant a verb (none cosmetic-only)", [
    DOGGIE_PET_ID, WICK_PET_ID, CAT_PET_ID, DRAGON_PET_ID, SLIME_PET_ID, PEBBLE_PET_ID, CLATTER_PET_ID, NULLFIN_PET_ID,
  ].every((id) => petVerbFor(id) !== null));
  check("an unknown/future pet id grants no verb", petVerbFor("totally_unknown") === null);
  check("no pet grants no verb", petVerbFor(null) === null);
  check("FETCH pulls coins", isFetchablePickup("coin"));
  check("FETCH NEVER pulls hearts (no sustain vacuum)", !isFetchablePickup("heart"));
  check("FETCH excludes weapon loot/objective pedestals", !isFetchablePickup("weapon"));

  section("pure contract: per-verb Quill FINAL cooldowns (all >= the 6s rail)");
  const cds: Array<[Parameters<typeof petCooldownTicks>[0], number]> = [
    ["fetch", 8.0], ["pinprick", 8.0], ["stalk", 7.0], ["emberpuff", 10.0],
    ["slimetrail", 8.0], ["pebblebrace", 12.0], ["rattle", 10.0], ["nullwake", 12.0],
  ];
  for (const [verb, sec] of cds) {
    check(`${verb} CD is ${sec}s and >= the 6s rail`, petCooldownTicks(verb) === Math.round(sec * 20) && petCooldownTicks(verb) >= 6 * 20);
  }
  check("the tell is 0.30s (shared)", Math.abs(PET_ABILITY.tellSec - 0.30) < 1e-9);
  check("STALK + RATTLE require a target; every other verb always commits", petVerbNeedsTarget("stalk") && petVerbNeedsTarget("rattle")
    && !petVerbNeedsTarget("fetch") && !petVerbNeedsTarget("pinprick") && !petVerbNeedsTarget("emberpuff")
    && !petVerbNeedsTarget("slimetrail") && !petVerbNeedsTarget("pebblebrace") && !petVerbNeedsTarget("nullwake"));

  section("pure contract: SLIMETRAIL slow decision (boss immune, elite half, trash full)");
  check("trash/brute take the full 0.75x slow", slimeSlowMul(false, false) === 0.75 && slimeSlowMul(false, false) === PET_ABILITY.slimetrail.enemySlowMul);
  check("elites take half slow (0.875x)", slimeSlowMul(false, true) === 0.875 && slimeSlowMul(false, true) === PET_ABILITY.slimetrail.eliteSlowMul);
  check("bosses are immune (1.0x)", slimeSlowMul(true, false) === 1 && slimeSlowMul(true, true) === 1);
}

function tellAndServerAuthorityTests(): void {
  section("server-authoritative: 0.30s tell then fire; a client can only request");
  const w = coopWorld();
  const p = addPet(w, "a", DOGGIE_PET_ID);
  tick1(w, "a", press(true));
  check("a request opens the tell (not an instant fire)", p.petTellT > 0 && p.petFetchT === 0);
  check("the shared cooldown is burned up front (server-owned)", p.petCdReadyAtTick > 0);
  check("the request bit is consumed (never wired; server re-derives it)", p.isPetAbilityRequested === false);
  // Let the tell elapse.
  let firedTick = -1;
  for (let i = 0; i < 10 && firedTick < 0; i++) {
    tick1(w, "a", press(false));
    if (p.petFetchT > 0) firedTick = i;
  }
  check("the verb FIRES only after the tell elapses (~0.30s later)", firedTick >= 4 && firedTick <= 7, `firedTick=${firedTick}`);
}

function cooldownTests(): void {
  section("cooldown: a second cast is refused until the CD clears (no held-bind chain)");
  const w = coopWorld();
  const p = addPet(w, "a", WICK_PET_ID);
  castAndSettle(w, "a");
  const cdAt = p.petCdReadyAtTick;
  check("PINPRICK light window opened", p.petLightT > 0);
  check("cooldown set to now + 8.0s", cdAt > 0);
  // Held bind cannot re-open a tell while on cooldown.
  tick1(w, "a", press(true));
  check("a held bind cannot re-trigger while on cooldown", p.petTellT === 0 && p.petCdReadyAtTick === cdAt);
  // Advance past the cooldown, then a fresh press works again.
  let guard = 0;
  while (w.tick < cdAt && guard++ < 400) tick1(w, "a", press(false));
  tick1(w, "a", press(true));
  check("after the cooldown clears a fresh press re-opens the tell", p.petTellT > 0 && p.petCdReadyAtTick > cdAt);
}

function downedTests(): void {
  section("utility OFF while downed (never a request, never a fire)");
  const w = coopWorld();
  const p = addPet(w, "a", DOGGIE_PET_ID);
  p.isDown = true;
  castAndSettle(w, "a");
  check("a downed owner never opens a tell", p.petTellT === 0);
  check("a downed owner never burns the cooldown", p.petCdReadyAtTick === 0);
  check("a downed owner never fires a pull", p.petFetchT === 0);
}

function fetchPullTests(): void {
  section("Doggie FETCH: pulls coins toward the owner; deny-lists hearts");
  const w = coopWorld();
  const p = addPet(w, "a", DOGGIE_PET_ID);
  // A coin in reach, a coin out of reach, and a heart in reach (must never move).
  const near = makeCoin(w, p.x + 100, p.y);
  const far = makeCoin(w, p.x + PET_ABILITY.fetch.radius + 120, p.y);
  const heart: Pickup = { id: w.nextPickupId++, kind: "heart", x: p.x + 60, y: p.y, radius: 8, weapon: null };
  w.pickups.push(heart);
  const heartX0 = heart.x;
  const coinsBefore = p.coins;
  castAndSettle(w, "a", 16);
  const nearGone = !w.pickups.includes(near);
  check("a coin in reach is drawn in (moved closer or collected)", nearGone || Math.hypot(near.x - p.x, near.y - p.y) < 100);
  check("FETCH is a real utility (coins collected or in flight)", p.coins > coinsBefore || nearGone || near.x < p.x + 100);
  check("a coin out of reach is never touched", w.pickups.includes(far) && Math.abs(far.x - (p.x + PET_ABILITY.fetch.radius + 120)) < 1e-6);
  check("a HEART in reach is NEVER pulled (deny-list rail)", w.pickups.includes(heart) && Math.abs(heart.x - heartX0) < 1e-6);
}

function fetchPartyThrottleTests(): void {
  section("FETCH party throttle: 1 pulse / party / 2.0s (second = no-op, no CD refund)");
  const w = coopWorld();
  const a = addPet(w, "a", DOGGIE_PET_ID);
  const b = addPet(w, "b", DOGGIE_PET_ID);
  // Both press together, both tells elapse together; only ONE pull may open.
  stepWorld(w, new Map([["a", press(true)], ["b", press(true)]]), DT);
  for (let i = 0; i < 10; i++) stepWorld(w, new Map([["a", press(false)], ["b", press(false)]]), DT);
  const opened = (a.petFetchT > 0 ? 1 : 0) + (b.petFetchT > 0 ? 1 : 0);
  check("exactly ONE fetch pull opened for the party", opened === 1, `opened=${opened}`);
  check("both casters still paid the cooldown (throttled one gets NO refund)", a.petCdReadyAtTick > 0 && b.petCdReadyAtTick > 0);
}

function pinprickTests(): void {
  section("Wick PINPRICK: owner-only light, party soft-cap of 2 contributing windows");
  const w = coopWorld();
  const caster = addPet(w, "a", WICK_PET_ID);
  const bystander = addPet(w, "b", WICK_PET_ID);
  // Only 'a' casts.
  castAndSettle(w, "a");
  check("the caster gets the light window", caster.petLightT > 0);
  check("PINPRICK is OWNER-ONLY (a bystander gets no light)", bystander.petLightT === 0);

  // Soft-cap: a third simultaneous window is a no-op (CD still burned).
  const w2 = coopWorld(0x5151);
  const p1 = addPet(w2, "a", WICK_PET_ID);
  const p2 = addPet(w2, "b", WICK_PET_ID);
  const p3 = addPet(w2, "c", WICK_PET_ID);
  const all = new Map([["a", press(true)], ["b", press(true)], ["c", press(true)]]);
  stepWorld(w2, all, DT);
  const idleAll = new Map([["a", press(false)], ["b", press(false)], ["c", press(false)]]);
  for (let i = 0; i < 10; i++) stepWorld(w2, idleAll, DT);
  const lit = [p1, p2, p3].filter((p) => p.petLightT > 0).length;
  check("at most 2 PINPRICK windows contribute (soft-cap)", lit === 2, `lit=${lit}`);
  check("the soft-capped third still paid its cooldown (no refund)", p1.petCdReadyAtTick > 0 && p2.petCdReadyAtTick > 0 && p3.petCdReadyAtTick > 0);
}

function stalkTests(): void {
  section("Cat STALK: info-only mark on an eligible body; no target -> fail-soft, no CD");
  const w = coopWorld();
  const p = addPet(w, "a", CAT_PET_ID);
  const elite = makeEnemy(w, p.x + 120, p.y, { tier: "elite" });
  const hp0 = elite.hp;
  castAndSettle(w, "a");
  check("an elite in reach gets the info mark", elite.petMarkT > 0);
  check("STALK deals NO damage to the marked body", elite.hp === hp0);
  check("STALK never sets the PHANTOM vuln mark (markT stays 0)", elite.markT === 0);
  check("a successful stalk burned the CD", p.petCdReadyAtTick > 0);
  // The info pip rides the enemy wire so every client draws it (round-trips through EnemyWire.pmk).
  const eWire = enemyFromWire(toEnemyWire(elite), elite.x, elite.y);
  check("the info mark survives the EnemyWire round trip", Math.abs(eWire.petMarkT - elite.petMarkT) < 1e-6);

  // No enemy in reach at all -> fail-soft, NO tell, NO cooldown.
  const w2 = coopWorld(0x3131);
  const q = addPet(w2, "a", CAT_PET_ID);
  castAndSettle(w2, "a");
  check("no target opens no tell and burns no CD", q.petTellT === 0 && q.petCdReadyAtTick === 0);
}

function emberpuffTests(): void {
  section("Baby Dragon EMBERPUFF: scales a cinder's remaining life down; radius-gated; 0 damage");
  const w = coopWorld();
  const p = addPet(w, "a", DRAGON_PET_ID);
  // A long-lived cinder in reach (but not under the owner, so it deals no damage), and a control
  // cinder well out of reach. Long lives make the 0.55x scale unmistakable against natural decay.
  const near: Hazard = { id: w.nextHazardId++, kind: "cinder", x: p.x + 90, y: p.y, radius: 40, life: 100, maxLife: 100 };
  const far: Hazard = { id: w.nextHazardId++, kind: "cinder", x: p.x + 600, y: p.y, radius: 40, life: 100, maxLife: 100 };
  w.hazards.push(near, far);
  const hp0 = p.hp;
  castAndSettle(w, "a");
  check("a cinder in reach had its remaining life scaled DOWN (~0.55x)", near.life < near.maxLife * 0.6);
  check("a cinder OUT of reach is untouched (radius-gated)", far.life > far.maxLife - 2);
  check("EMBERPUFF itself deals no damage (owner outside the pools)", p.hp === hp0);
}

function slimetrailTests(): void {
  section("Baby Slime SLIMETRAIL: drops an enemy-slow patch; party cap 2 / room; 0 damage");
  const w = coopWorld();
  const p = addPet(w, "a", SLIME_PET_ID);
  const hp0 = p.hp;
  castAndSettle(w, "a");
  const patches = w.hazards.filter((h) => h.kind === "slime");
  check("a slime patch is dropped at the owner", patches.length === 1);
  check("the patch uses the tuned radius + life", patches[0].radius === PET_ABILITY.slimetrail.patchRadius
    && Math.abs(patches[0].maxLife - PET_ABILITY.slimetrail.patchLifeSec) < 1e-9);
  check("standing on the patch deals no damage", p.hp === hp0);

  // Party cap: three casters firing together yield at most 2 live patches (shared).
  const w2 = coopWorld(0x6161);
  addPet(w2, "a", SLIME_PET_ID);
  addPet(w2, "b", SLIME_PET_ID);
  addPet(w2, "c", SLIME_PET_ID);
  const all = new Map([["a", press(true)], ["b", press(true)], ["c", press(true)]]);
  stepWorld(w2, all, DT);
  const idle = new Map([["a", press(false)], ["b", press(false)], ["c", press(false)]]);
  for (let i = 0; i < 10; i++) stepWorld(w2, idle, DT);
  const live = w2.hazards.filter((h) => h.kind === "slime").length;
  check("the party patch cap holds at 2", live === 2, `live=${live}`);
}

function pebblebraceTests(): void {
  section("Pebble PEBBLEBRACE: one-hit <=2 absorb, spent after one hit, no iframe, clears on downed");
  const w = coopWorld();
  const p = addPet(w, "a", PEBBLE_PET_ID);
  castAndSettle(w, "a");
  check("the brace window is open", p.petShieldT > 0);
  const hp0 = p.hp;
  // Drop a cinder (1 damage/tick) right on the owner: the next tick's hit is fully eaten.
  w.hazards.push({ id: w.nextHazardId++, kind: "cinder", x: p.x, y: p.y, radius: 40, life: 5, maxLife: 5 });
  tick1(w, "a", press(false));
  check("a <=2 hit (cinder = 1) is fully absorbed — no HP lost", p.hp === hp0);
  check("the brace is spent after one hit", p.petShieldT === 0);
  check("the brace granted no post-hit iframe (the absorb set no invuln)", p.invuln === 0);
  // With the brace spent (and no iframe), the very next cinder tick bites for real.
  tick1(w, "a", press(false));
  check("the next cinder tick lands once the brace is spent", p.hp === hp0 - 1);

  // Clears the instant the owner is downed.
  const w2 = coopWorld(0x7171);
  const q = addPet(w2, "a", PEBBLE_PET_ID);
  castAndSettle(w2, "a");
  check("brace open before the owner goes down", q.petShieldT > 0);
  q.isDown = true;
  tick1(w2, "a", press(false));
  check("the brace clears the instant the owner is downed", q.petShieldT === 0);
}

function rattleTests(): void {
  section("Clatter RATTLE: cancels a TRASH wind-up early; elites immune; no target -> no CD");
  const w = coopWorld();
  const p = addPet(w, "a", CLATTER_PET_ID);
  // A trash skeleton in reach auto-enters its 0.55s lunge wind-up; RATTLE fires at the 0.30s tell,
  // so recover BEFORE natural completion is proof the interrupt (not the lunge) ended the wind-up.
  const trash = makeEnemy(w, p.x + 90, p.y, { tier: "standard", kind: "skeleton" });
  tick1(w, "a", press(true));
  for (let i = 0; i < 7; i++) tick1(w, "a", press(false));
  check("RATTLE cancelled the trash wind-up EARLY (recover before the lunge)", trash.attack.phase === "recover");
  check("RATTLE burned its CD on a valid trash target", p.petCdReadyAtTick > 0);

  // An ELITE wind-up is immune: no valid target -> fail-soft, no CD.
  const w2 = coopWorld(0x8181);
  const q = addPet(w2, "a", CLATTER_PET_ID);
  makeEnemy(w2, q.x + 90, q.y, { tier: "elite", kind: "skeleton" });
  castAndSettle(w2, "a");
  check("an elite wind-up is immune to RATTLE (no target -> no CD)", q.petCdReadyAtTick === 0 && q.petTellT === 0);
}

function nullwakeTests(): void {
  section("Nullfin NULLWAKE: nulls floor-hazard damage for a brief window; owner-only; no iframe");
  const w = coopWorld();
  const p = addPet(w, "a", NULLFIN_PET_ID);
  const bystander = addPet(w, "b", NULLFIN_PET_ID);
  // Cast; then advance to the moment the 0.45s null window opens.
  tick1(w, "a", press(true));
  let guard = 0;
  while (p.petNullT === 0 && guard++ < 20) tick1(w, "a", press(false));
  check("the null window opened after the tell", p.petNullT > 0);
  check("NULLWAKE is OWNER-ONLY (a bystander gets no window)", bystander.petNullT === 0);
  check("the window grants NO projectile iframe (no invuln fields set)", p.invuln === 0 && p.dashInvuln === 0 && p.ultInvuln === 0);
  // A cinder right on the owner would bite every tick — the live window voids it.
  w.hazards.push({ id: w.nextHazardId++, kind: "cinder", x: p.x, y: p.y, radius: 40, life: 5, maxLife: 5 });
  const hp0 = p.hp;
  tick1(w, "a", press(false));
  check("floor-hazard (cinder) damage is nulled while the window is live", p.hp === hp0);
  // Let the window fully lapse; the cinder then resumes biting.
  for (let i = 0; i < 14; i++) tick1(w, "a", press(false));
  check("cinder damage resumes once the window lapses", p.hp < hp0);
}

function pvpOffTests(): void {
  section("PVP arena: abilities OFF (no-op, no CD burn, zero wire fields)");
  const w = createWorld(0x2222, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "a");
  setPlayerPet(w, "a", DOGGIE_PET_ID);
  for (let i = 0; i < 12; i++) tick1(w, "a", press(true));
  check("no tell opens in a pvp arena", a.petTellT === 0);
  check("no cooldown is burned in a pvp arena (a no-op, not a spend)", a.petCdReadyAtTick === 0);
  check("no fetch pull opens in a pvp arena", a.petFetchT === 0);
  const wire = toSelfWire(a);
  check("pvp SelfWire zeroes every pet ability field", wire.pcd === 0 && wire.ptt === 0 && wire.plt === 0 && wire.pft === 0 && wire.psh === 0 && wire.pnl === 0);
}

function reconnectWireTests(): void {
  section("reconnect-safe: the CD + active windows survive the SelfWire round-trip");
  const w = coopWorld();
  const p = addPet(w, "a", WICK_PET_ID);
  // Put the player mid-ability: a live tell, every active window, and a CD.
  p.petCdReadyAtTick = 137;
  p.petTellT = 0.2;
  p.petLightT = 1.75;
  p.petFetchT = 0.45;
  p.petShieldT = 2.1;
  p.petNullT = 0.3;
  const wire = toSelfWire(p);
  check("SelfWire carries the CD gate", wire.pcd === 137);
  check("SelfWire carries the tell window", Math.abs(wire.ptt - 0.2) < 1e-6);
  check("SelfWire carries the light window", Math.abs(wire.plt - 1.75) < 1e-6);
  check("SelfWire carries the fetch window", Math.abs(wire.pft - 0.45) < 1e-6);
  check("SelfWire carries the PEBBLEBRACE window", Math.abs(wire.psh - 2.1) < 1e-6);
  check("SelfWire carries the NULLWAKE window", Math.abs(wire.pnl - 0.3) < 1e-6);
  // Apply onto a FRESH body (the reconnect apply path).
  const w2 = coopWorld(0x7777);
  const fresh = addPet(w2, "a", WICK_PET_ID);
  applySelfWire(fresh, wire);
  check("reconnect restores the CD gate", fresh.petCdReadyAtTick === 137);
  check("reconnect restores the tell window", Math.abs(fresh.petTellT - 0.2) < 1e-6);
  check("reconnect restores the light window", Math.abs(fresh.petLightT - 1.75) < 1e-6);
  check("reconnect restores the fetch window", Math.abs(fresh.petFetchT - 0.45) < 1e-6);
  check("reconnect restores the PEBBLEBRACE window", Math.abs(fresh.petShieldT - 2.1) < 1e-6);
  check("reconnect restores the NULLWAKE window", Math.abs(fresh.petNullT - 0.3) < 1e-6);
}

function noPetIsInertTests(): void {
  section("a player with no ability pet: the bind is fully inert");
  const w = coopWorld();
  const p = spawnPlayerInWorld(w, "a"); // no setPlayerPet -> pet null
  for (let i = 0; i < 8; i++) tick1(w, "a", press(true));
  check("no pet -> no tell", p.petTellT === 0);
  check("no pet -> no cooldown burn", p.petCdReadyAtTick === 0);
  check("no pet -> no effect windows", p.petFetchT === 0 && p.petLightT === 0);
  // A cosmetic-only (unknown-id) pet is equally inert (no verb) — every ROSTER pet now has a verb,
  // so the cosmetic case is any id outside the table.
  const cosmetic = addPet(w, "b", "cosmetic_only_pet");
  for (let i = 0; i < 8; i++) stepWorld(w, new Map([["b", press(true)]]), DT);
  check("a cosmetic-only pet never opens an ability", cosmetic.petTellT === 0 && cosmetic.petCdReadyAtTick === 0);
}

// Drive N ticks of PURE IDLE input (no bind) — the production path. Auto-cast must act entirely on
// its own here; the client sends nothing that could trigger a verb.
function idle(w: WorldState, id: string, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick1(w, id, press(false));
}

function autoCastFiresTests(): void {
  section("AUTO-CAST: every verb fires on its smart trigger with ZERO player input");

  // FETCH: a coin in the pull radius auto-yanks (no press).
  {
    const w = coopWorld();
    const p = addPet(w, "a", DOGGIE_PET_ID);
    const coin = makeCoin(w, p.x + 100, p.y);
    idle(w, "a", 12);
    check("FETCH auto-fires on a coin in reach", p.petCdReadyAtTick > 0);
    check("the auto-pull actually moved the coin (collected or in flight)", !w.pickups.includes(coin) || coin.x < p.x + 100);
  }

  // PINPRICK: an enemy at the doorstep (owner in combat) auto-lights the owner.
  {
    const w = coopWorld();
    const p = addPet(w, "a", WICK_PET_ID);
    makeEnemy(w, p.x + 120, p.y, { tier: "standard" });
    idle(w, "a", 12);
    check("PINPRICK auto-fires while the owner is in combat", p.petLightT > 0);
  }

  // STALK: an elite in reach is auto-marked.
  {
    const w = coopWorld();
    const p = addPet(w, "a", CAT_PET_ID);
    const elite = makeEnemy(w, p.x + 120, p.y, { tier: "elite" });
    const hp0 = elite.hp;
    idle(w, "a", 12);
    check("STALK auto-marks an elite in reach", elite.petMarkT > 0);
    check("the auto-mark deals no damage (info only)", elite.hp === hp0);
  }

  // EMBERPUFF: a cinder overlapping the reach is auto-shortened.
  {
    const w = coopWorld();
    const p = addPet(w, "a", DRAGON_PET_ID);
    const near: Hazard = { id: w.nextHazardId++, kind: "cinder", x: p.x + 90, y: p.y, radius: 40, life: 100, maxLife: 100 };
    w.hazards.push(near);
    idle(w, "a", 12);
    check("EMBERPUFF auto-fires on a cinder in reach (life scaled down)", near.life < near.maxLife * 0.6);
  }

  // SLIMETRAIL: a non-boss enemy within reach auto-drops a slow patch under the owner.
  {
    const w = coopWorld();
    const p = addPet(w, "a", SLIME_PET_ID);
    makeEnemy(w, p.x + 80, p.y, { tier: "standard" });
    idle(w, "a", 12);
    check("SLIMETRAIL auto-drops a patch near a non-boss enemy", w.hazards.some((h) => h.kind === "slime"));
  }

  // PEBBLEBRACE: a hurt owner auto-braces (never at full HP — see the idle suite).
  {
    const w = coopWorld();
    const p = addPet(w, "a", PEBBLE_PET_ID);
    p.hp = p.maxHp - 1;
    idle(w, "a", 12);
    check("PEBBLEBRACE auto-braces a hurt owner", p.petShieldT > 0);
  }

  // RATTLE: a trash wind-up in reach is auto-interrupted.
  {
    const w = coopWorld();
    const p = addPet(w, "a", CLATTER_PET_ID);
    const trash = makeEnemy(w, p.x + 90, p.y, { tier: "standard", kind: "skeleton" });
    idle(w, "a", 12);
    check("RATTLE auto-fires on a trash wind-up", p.petCdReadyAtTick > 0);
    check("the auto-interrupt drove the trash into recover", trash.attack.phase === "recover");
  }

  // NULLWAKE: an owner standing in a cinder auto-opens the null window.
  {
    const w = coopWorld();
    const p = addPet(w, "a", NULLFIN_PET_ID);
    w.hazards.push({ id: w.nextHazardId++, kind: "cinder", x: p.x, y: p.y, radius: 40, life: 100, maxLife: 100 });
    idle(w, "a", 8);
    check("NULLWAKE auto-fires when the owner stands in a cinder", p.petCdReadyAtTick > 0);
  }
}

function autoCastIdleNoFireTests(): void {
  section("AUTO-CAST: NO fire in an empty context — no tell, no CD burned (idle stays quiet)");
  const roster: Array<[string, string]> = [
    ["FETCH", DOGGIE_PET_ID], ["PINPRICK", WICK_PET_ID], ["STALK", CAT_PET_ID], ["EMBERPUFF", DRAGON_PET_ID],
    ["SLIMETRAIL", SLIME_PET_ID], ["PEBBLEBRACE", PEBBLE_PET_ID], ["RATTLE", CLATTER_PET_ID], ["NULLWAKE", NULLFIN_PET_ID],
  ];
  for (const [verb, petId] of roster) {
    const w = coopWorld();
    const p = addPet(w, "a", petId);
    // Strip every trigger source: no loot, no enemies, no hazards, and the owner at full HP.
    w.enemies.length = 0; w.hazards.length = 0; w.floorHazards.length = 0; w.pickups.length = 0;
    p.hp = p.maxHp;
    idle(w, "a", 24);
    check(`${verb} never auto-fires with no context (no tell, no CD burn)`, p.petTellT === 0 && p.petCdReadyAtTick === 0);
  }
}

function autoCastRailsTests(): void {
  section("AUTO-CAST honors the rails with NO input (cooldown / downed / party / PVP)");

  // Cooldown: after an auto-fire the verb waits out the FULL cooldown before it can auto-fire again.
  {
    const w = coopWorld();
    const p = addPet(w, "a", WICK_PET_ID);
    makeEnemy(w, p.x + 120, p.y, { tier: "standard" }); // holds the owner in combat the whole time
    idle(w, "a", 12);
    check("auto-cast burned the CD on the first fire", p.petCdReadyAtTick > w.tick);
    const cdAt = p.petCdReadyAtTick;
    idle(w, "a", 6);
    check("no second auto-cast opens while on cooldown (no free retries)", p.petCdReadyAtTick === cdAt);
  }

  // Downed: a downed owner never auto-casts even with a perfect trigger present.
  {
    const w = coopWorld();
    const p = addPet(w, "a", DOGGIE_PET_ID);
    makeCoin(w, p.x + 80, p.y);
    p.isDown = true;
    idle(w, "a", 16);
    check("a downed owner never auto-casts", p.petTellT === 0 && p.petCdReadyAtTick === 0 && p.petFetchT === 0);
  }

  // Party throttle: two doggies each with a coin still open at most ONE shared pull.
  {
    const w = coopWorld();
    const a = addPet(w, "a", DOGGIE_PET_ID);
    const b = addPet(w, "b", DOGGIE_PET_ID);
    makeCoin(w, a.x + 80, a.y);
    makeCoin(w, b.x + 80, b.y);
    const idleBoth = new Map([["a", press(false)], ["b", press(false)]]);
    for (let i = 0; i < 12; i++) stepWorld(w, idleBoth, DT);
    const opened = (a.petFetchT > 0 ? 1 : 0) + (b.petFetchT > 0 ? 1 : 0);
    check("auto-cast honors the FETCH party throttle (exactly one pull)", opened === 1, `opened=${opened}`);
  }

  // PVP: auto-cast is hard-off in the arena even with a perfect trigger and no input.
  {
    const w = createWorld(0x2222, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "a");
    setPlayerPet(w, "a", DOGGIE_PET_ID);
    makeCoin(w, a.x + 80, a.y);
    idle(w, "a", 12);
    check("auto-cast is OFF in a pvp arena (no fire on context)", a.petTellT === 0 && a.petCdReadyAtTick === 0 && a.petFetchT === 0);
  }
}

pureContractTests();
autoCastFiresTests();
autoCastIdleNoFireTests();
autoCastRailsTests();
tellAndServerAuthorityTests();
cooldownTests();
downedTests();
fetchPullTests();
fetchPartyThrottleTests();
pinprickTests();
stalkTests();
emberpuffTests();
slimetrailTests();
pebblebraceTests();
rattleTests();
nullwakeTests();
pvpOffTests();
reconnectWireTests();
noPetIsInertTests();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Pet ability roster (8 verbs) contract holds.\n");
