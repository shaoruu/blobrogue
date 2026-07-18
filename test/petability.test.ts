// Pet ability framework + FETCH/PINPRICK pilot gates (PROTOCOL 45). Pins the RAILS the design
// locked: server-authoritative resolution (a client can only request), utility-only ZERO-dps
// verbs, the shared cooldown, the 0.30s tell, party throttle / soft-cap, PVP hard-off, the FETCH
// coin-only deny-list, PINPRICK owner-only light, and reconnect-safe wire projection.
//
// Run: npx tsx test/petability.test.ts

import {
  createWorld, spawnPlayerInWorld, setPlayerPet, stepWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import type { Pickup } from "../src/sim/types.js";
import { PET_ABILITY, petVerbFor, isFetchablePickup } from "../src/sim/petAbilities.js";
import { DOGGIE_PET_ID, WICK_PET_ID, CAT_PET_ID } from "../src/sim/camp_nodes.js";
import { toSelfWire, applySelfWire } from "../src/net/protocol.js";

const DT = 1 / 20;
let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(n: string): void { process.stdout.write(`\n[${n}]\n`); }

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
  section("pure contract: verb registry + FETCH deny-list");
  check("doggie grants FETCH", petVerbFor(DOGGIE_PET_ID) === "fetch");
  check("wick grants PINPRICK", petVerbFor(WICK_PET_ID) === "pinprick");
  check("a cosmetic-only pet grants no verb", petVerbFor(CAT_PET_ID) === null);
  check("an unknown/future pet id grants no verb", petVerbFor("totally_unknown") === null);
  check("no pet grants no verb", petVerbFor(null) === null);
  check("FETCH pulls coins", isFetchablePickup("coin"));
  check("FETCH NEVER pulls hearts (no sustain vacuum)", !isFetchablePickup("heart"));
  check("FETCH excludes weapon loot/objective pedestals", !isFetchablePickup("weapon"));
  check("shared active-bind cooldown is >= the 6s rail (Quill FINAL 8.0s)", PET_ABILITY.cooldownTicks >= 6 * 20 && PET_ABILITY.cooldownTicks === 160);
  check("the tell is 0.30s", Math.abs(PET_ABILITY.tellSec - 0.30) < 1e-9);
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
  check("pvp SelfWire zeroes every pet ability field", wire.pcd === 0 && wire.ptt === 0 && wire.plt === 0 && wire.pft === 0);
}

function reconnectWireTests(): void {
  section("reconnect-safe: the CD + active windows survive the SelfWire round-trip");
  const w = coopWorld();
  const p = addPet(w, "a", WICK_PET_ID);
  // Put the player mid-ability: a live tell, a light window, a fetch window, and a CD.
  p.petCdReadyAtTick = 137;
  p.petTellT = 0.2;
  p.petLightT = 1.75;
  p.petFetchT = 0.45;
  const wire = toSelfWire(p);
  check("SelfWire carries the CD gate", wire.pcd === 137);
  check("SelfWire carries the tell window", Math.abs(wire.ptt - 0.2) < 1e-6);
  check("SelfWire carries the light window", Math.abs(wire.plt - 1.75) < 1e-6);
  check("SelfWire carries the fetch window", Math.abs(wire.pft - 0.45) < 1e-6);
  // Apply onto a FRESH body (the reconnect apply path).
  const w2 = coopWorld(0x7777);
  const fresh = addPet(w2, "a", WICK_PET_ID);
  applySelfWire(fresh, wire);
  check("reconnect restores the CD gate", fresh.petCdReadyAtTick === 137);
  check("reconnect restores the tell window", Math.abs(fresh.petTellT - 0.2) < 1e-6);
  check("reconnect restores the light window", Math.abs(fresh.petLightT - 1.75) < 1e-6);
  check("reconnect restores the fetch window", Math.abs(fresh.petFetchT - 0.45) < 1e-6);
}

function noPetIsInertTests(): void {
  section("a player with no ability pet: the bind is fully inert");
  const w = coopWorld();
  const p = spawnPlayerInWorld(w, "a"); // no setPlayerPet -> pet null
  for (let i = 0; i < 8; i++) tick1(w, "a", press(true));
  check("no pet -> no tell", p.petTellT === 0);
  check("no pet -> no cooldown burn", p.petCdReadyAtTick === 0);
  check("no pet -> no effect windows", p.petFetchT === 0 && p.petLightT === 0);
  // A cosmetic-only pet (cat) is equally inert (no verb).
  const cosmetic = addPet(w, "b", CAT_PET_ID);
  for (let i = 0; i < 8; i++) stepWorld(w, new Map([["b", press(true)]]), DT);
  check("a cosmetic-only pet never opens an ability", cosmetic.petTellT === 0 && cosmetic.petCdReadyAtTick === 0);
}

pureContractTests();
tellAndServerAuthorityTests();
cooldownTests();
downedTests();
fetchPullTests();
fetchPartyThrottleTests();
pinprickTests();
pvpOffTests();
reconnectWireTests();
noPetIsInertTests();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Pet ability framework + FETCH/PINPRICK pilot contract holds.\n");
