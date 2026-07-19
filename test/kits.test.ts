// KIT/ULT + account-MASTERY unit gates (spec §2/§3/§4/§7): each kit's ult EFFECT + the
// SERVER-SIDE cap clamps, the account-mastery unlock validation (never trust a client claiming
// an unowned kit), and the ult-meter charge formula. The determinism golden lives in
// test/kits.golden.test.ts; this suite pins the numbers + the caps directly.
//
// Run: npx tsx test/kits.test.ts

import {
  createWorld, spawnPlayerInWorld, setPlayerKit, stepPlayerPhase, stepWorldPhase, devSpawnEnemy,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet } from "../src/sim/types.js";
import {
  ULT, OVERDRIVE, SANCTUARY, AEGIS, PHASE, MOMENTUM, OVERHEAT, HARDENED, OVERSHIELD,
  HEAL_PULSE, PHANTOM_MARK, MENDER_HEAL_CLAMP, ticksToSec, TICKS_PER_SECOND,
  masteryLevelForXp, isKitUnlocked, kitUnlockLevel, unlockedKits, masteryXpForRun,
  canCastUlt, ultChargeFromDamageDealt, ultChargeFromDamageTaken, ultChargeFromHealDone,
  ultShareCapUnits, ultTimeChargePerTick,
  refEncounterHpForFloor, aegisHpBudgetForFloor,
} from "../src/sim/kits.js";
import type { KitId } from "../src/sim/kits.js";
import { BOSS_VULN_CAP } from "../src/sim/balance.js";

const FIXED_DT = 1 / 20;
let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(n: string): void { process.stdout.write(`\n[${n}]\n`); }

function idle(seq = 1): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false, ult: false };
}

// Drive one authoritative tick (server order: player phase per player, then world phase, then
// tick++), returning the emitted events.
function tick(w: WorldState, perPlayer: (p: PlayerSim) => InputCmd): SimEvent[] {
  const ev: SimEvent[] = [];
  for (const p of w.players.values()) stepPlayerPhase(w, p, perPlayer(p), FIXED_DT, ev);
  stepWorldPhase(w, FIXED_DT, ev);
  w.tick++;
  return ev;
}

function freshWorld(): WorldState {
  return createWorld(0x1234, 1, { isShared: true, skipLocalPlayer: true });
}

function enemyBullet(x: number, y: number): Bullet {
  return { x, y, vx: 0, vy: 0, radius: 5, life: 1, friendly: false, owner: null, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false };
}

function masteryTests(): void {
  section("account MASTERY: XP -> level -> which kits are unlocked (spec §4)");
  check("level 1 at 0 XP", masteryLevelForXp(0) === 1);
  check("a linear XP curve levels up", masteryLevelForXp(500) === 2 && masteryLevelForXp(2000) === 5);
  check("gunner + mender unlocked from level 1", kitUnlockLevel("gunner") === 1 && kitUnlockLevel("mender") === 1);
  check("bulwark gated to level 3, phantom to level 5", kitUnlockLevel("bulwark") === 3 && kitUnlockLevel("phantom") === 5);
  check("a level-1 account sees exactly the two starters", JSON.stringify(unlockedKits(1)) === JSON.stringify(["gunner", "mender"]));
  check("bulwark unlocks at level 3", !isKitUnlocked("bulwark", 2) && isKitUnlocked("bulwark", 3));
  check("phantom unlocks at level 5", !isKitUnlocked("phantom", 4) && isKitUnlocked("phantom", 5));
  check("run-end XP rewards floors (primary) + bosses + depth", masteryXpForRun({ floorsCleared: 5, bossesDefeated: 1, depth: 6 }) === 5 * 100 + 250 + 6 * 20);
  check("a cleared floor always pays (win or lose)", masteryXpForRun({ floorsCleared: 1, bossesDefeated: 0, depth: 1 }) > 0);

  section("SERVER-SIDE kit-unlock gate: never trust a client claiming an unowned kit (spec §9.5)");
  // Mirror the join handler's exact gate: an unlocked kit stands, anything else downgrades.
  const gate = (kit: KitId, level: number): KitId => (isKitUnlocked(kit, level) ? kit : "gunner");
  check("a low-mastery client claiming PHANTOM is downgraded to gunner", gate("phantom", 1) === "gunner");
  check("a level-3 account may take BULWARK", gate("bulwark", 3) === "bulwark");
  check("a level-3 account claiming PHANTOM is still downgraded", gate("phantom", 3) === "gunner");
  check("an unlocked pick is honoured", gate("mender", 1) === "mender");
}

function chargeFormulaTests(): void {
  section("ult meter: fixed-point + TARGET-AGNOSTIC charge formula (§10)");
  check("meter is fixed-point hundredths of a percent (0..10000)", ULT.meterMax === 10000);
  check("damage-dealt charge is normalized by RefEncounterHP (not raw)", (() => {
    const ref = refEncounterHpForFloor(1);
    return ultChargeFromDamageDealt(2, ref) === Math.round(ULT.meterMax * (2 / ref) * ULT.K_dmg);
  })());
  check("same damage charges the SAME fraction regardless of floor depth (target-agnostic)", (() => {
    // Dealing a fixed FRACTION of the encounter charges identically on F1 and a deep floor.
    const f1 = ultChargeFromDamageDealt(refEncounterHpForFloor(1) * 0.1, refEncounterHpForFloor(1));
    const f9 = ultChargeFromDamageDealt(refEncounterHpForFloor(9) * 0.1, refEncounterHpForFloor(9));
    return f1 === f9 && f1 > 0;
  })());
  check("damage-taken charge is normalized by the tank's own maxHp", ultChargeFromDamageTaken(2, 8) === Math.round(ULT.meterMax * (2 / 8) * ULT.K_taken));
  check("healing-done charge is per-HP", ultChargeFromHealDone(2) === Math.round(ULT.meterMax * ULT.K_heal * 2));
  check("canCast requires BOTH a full meter and past the 8s lockout", !canCastUlt(ULT.meterMax, 10, 20) && canCastUlt(ULT.meterMax, 20, 20) && !canCastUlt(ULT.meterMax - 1, 50, 0));
  check("the 8s lockout is 160 ticks (8.0s at 20Hz)", ULT.lockoutTicks === 160);
  check("the time floor fills in ~combatFillSeconds even at zero DPS", (() => {
    const perTick = ultTimeChargePerTick();
    const ticksToFull = ULT.meterMax / perTick;
    const seconds = ticksToFull / 20;
    return seconds >= 110 && seconds <= 135; // ~120s band (Wave 1 reweight)
  })());

  section("§10 per-source SHARE caps: no single input dominates one fill (damage ≤85%, kills ≤55%)");
  check("share caps are exposed as tunable fractions", ULT.shareCap.dmg === 0.85 && ULT.shareCap.kill === 0.55);
  {
    // A gunner punching a huge dummy: damage charge saturates at its 70% share and stops.
    const w = freshWorld();
    spawnPlayerInWorld(w, "g"); setPlayerKit(w, "g", "gunner");
    const g = w.players.get("g")!;
    for (let i = 0; i < 400; i++) {
      // Direct damage accrual via the exposed contribution (bypassing combat for a clean probe):
      g.ultSources.dmg = g.ultSources.dmg; // no-op to keep intent clear
      break;
    }
    // Drive the accrual through the real sim: spawn a fat dummy + autofire, capping time out by
    // checking the dmg source never exceeds its share cap.
    const enemy = devSpawnEnemy(w, "boss", g.x + 60, g.y);
    enemy.hp = 1e9; enemy.maxHp = 1e9; // an effectively bottomless dummy
    for (let i = 0; i < 300; i++) tick(w, (p) => ({ ...idle(), firing: p.id === "g", aim: 0 }));
    check("damage source never exceeds its 85% share cap", g.ultSources.dmg <= ultShareCapUnits("dmg"), `dmg=${g.ultSources.dmg} cap=${ultShareCapUnits("dmg")}`);
  }

  section("§10 time floor is COMBAT-GATED (never trickles in an empty room)");
  {
    const empty = freshWorld();
    empty.enemies = []; // a truly cleared room (freshWorld loads the floor's enemies)
    spawnPlayerInWorld(empty, "g"); setPlayerKit(empty, "g", "gunner"); const g = empty.players.get("g")!; g.invuln = 0;
    for (let i = 0; i < 200; i++) tick(empty, () => idle());
    check("an EMPTY room never charges the time floor", g.ultCharge === 0, `charge=${g.ultCharge}`);
    const combat = freshWorld();
    combat.enemies = [];
    spawnPlayerInWorld(combat, "g2"); setPlayerKit(combat, "g2", "gunner"); const g2 = combat.players.get("g2")!; g2.invuln = 0;
    devSpawnEnemy(combat, "slime", g2.x + 400, g2.y); // a live enemy => encounter is live
    for (let i = 0; i < 200; i++) tick(combat, () => idle());
    check("a live encounter DOES charge the time floor", g2.ultCharge > 0, `charge=${g2.ultCharge}`);
  }

  section("charge is neutral-baseline-inert + persists (does not reset on the shipped sim)");
  const w = freshWorld();
  const neutral = spawnPlayerInWorld(w, "n"); neutral.invuln = 0;
  devSpawnEnemy(w, "slime", neutral.x + 300, neutral.y);
  for (let i = 0; i < 100; i++) tick(w, () => idle());
  check("a neutral-kit player NEVER accrues charge (shipped sim untouched)", neutral.ultCharge === 0);
}

function overdriveTests(): void {
  section("GUNNER OVERDRIVE: self-buff, magnitude clamped (spec §2.1/§9.3)");
  check("Overdrive is a fixed (non-compounding) fire-rate factor", OVERDRIVE.fireFactor > 1 && OVERDRIVE.fireFactor <= 2.5);
  check("Overdrive grants a bounded temporary pierce", OVERDRIVE.bonusPierce === 2);
  const w = freshWorld();
  spawnPlayerInWorld(w, "g"); setPlayerKit(w, "g", "gunner");
  const g = w.players.get("g")!;
  g.ultCharge = ULT.meterMax; g.ultReadyAtTick = 0;
  const ev = tick(w, (p) => ({ ...idle(), ult: p.id === "g" }));
  check("a full-meter request casts (meter resets, lockout armed)", g.ultCharge === 0 && g.ultReadyAtTick > w.tick);
  check("Overdrive sets the ~5s self-buff window", Math.abs(g.overdriveT - ticksToSec(OVERDRIVE.durationTicks)) < 1e-6, `ov=${g.overdriveT}`);
  check("the cast emitted ULT_OVERDRIVE", ev.some((e) => e.t === "ultOverdrive"));
  // Lockout: an immediate re-request while charged is refused.
  g.ultCharge = ULT.meterMax;
  tick(w, (p) => ({ ...idle(), ult: p.id === "g" }));
  check("the 8s lockout refuses a re-cast even at full meter", g.ultCharge === ULT.meterMax);
}

function ultRefillAfterCastTests(): void {
  section("ult meter: capped sources reset for every post-cast fill");
  const w = freshWorld();
  w.enemies = [];
  spawnPlayerInWorld(w, "m"); setPlayerKit(w, "m", "mender");
  const ally = spawnPlayerInWorld(w, "a"); setPlayerKit(w, "a", "gunner");
  const m = w.players.get("m")!;
  ally.x = m.x + 40;
  ally.y = m.y;
  ally.hp = ally.maxHp - 1;

  const healGrant = ultChargeFromHealDone(1);
  const healCap = ultShareCapUnits("heal");
  m.ultCharge = ULT.meterMax - healGrant;
  m.ultSources.heal = healCap - healGrant;
  tick(w, (p) => ({ ...idle(), aim: 0, pulse: p.id === "m" }));
  check("a real Mender heal fills the first meter at its per-fill share cap",
    m.ultCharge === ULT.meterMax && m.ultSources.heal === healCap,
    `charge=${m.ultCharge} heal=${m.ultSources.heal}`);

  const wastedBefore = m.ultWasted;
  devSpawnEnemy(w, "slime", m.x + 400, m.y);
  tick(w, () => idle());
  check("uncapped combat-time overcharge still records ultWasted",
    m.ultCharge === ULT.meterMax && m.ultWasted > wastedBefore,
    `charge=${m.ultCharge} wasted=${m.ultWasted}`);
  w.enemies = [];

  const firstCastTick = w.tick;
  const firstCastEvents = tick(w, (p) => ({ ...idle(), ult: p.id === "m" }));
  check("Mender casts Sanctuary once after the first capped-source fill",
    firstCastEvents.some((e) => e.t === "ultSanctuary"));
  check("a successful cast resets every capped-source accumulator",
    Object.values(m.ultSources).every((charge) => charge === 0),
    `sources=${JSON.stringify(m.ultSources)}`);
  check("the successful cast preserves the 8s lockout",
    m.ultReadyAtTick === firstCastTick + ULT.lockoutTicks,
    `ready=${m.ultReadyAtTick} cast=${firstCastTick}`);

  m.ultCharge = ULT.meterMax;
  const refusedEvents = tick(w, (p) => ({ ...idle(), ult: p.id === "m" }));
  check("the lockout still refuses an immediate full-meter re-cast",
    m.ultCharge === ULT.meterMax && !refusedEvents.some((e) => e.t === "ultSanctuary"));

  while (w.tick < m.ultReadyAtTick) tick(w, () => idle());
  m.ultCharge = ULT.meterMax - healGrant;
  ally.hp = ally.maxHp - 1;
  tick(w, (p) => ({ ...idle(), aim: 0, pulse: p.id === "m" }));
  check("the same capped heal source fills the next meter",
    m.ultCharge === ULT.meterMax && m.ultSources.heal === healGrant,
    `charge=${m.ultCharge} heal=${m.ultSources.heal}`);

  const secondCastEvents = tick(w, (p) => ({ ...idle(), ult: p.id === "m" }));
  check("Mender can cast Sanctuary twice in one run",
    firstCastEvents.filter((e) => e.t === "ultSanctuary").length
      + secondCastEvents.filter((e) => e.t === "ultSanctuary").length === 2);
}

function sanctuaryTests(): void {
  section("MENDER SANCTUARY: burst + capped HoT, NEVER out-heals (spec §2.2/§7)");
  const w = freshWorld();
  spawnPlayerInWorld(w, "m"); setPlayerKit(w, "m", "mender");
  const ally = spawnPlayerInWorld(w, "a"); setPlayerKit(w, "a", "gunner");
  const m = w.players.get("m")!;
  ally.x = m.x + 20; ally.y = m.y; ally.hp = 1;
  m.ultCharge = ULT.meterMax; m.ultReadyAtTick = 0;
  const ev = tick(w, (p) => ({ ...idle(), ult: p.id === "m" }));
  check("cast emitted ULT_SANCTUARY + spawned the zone entity", ev.some((e) => e.t === "ultSanctuary") && w.effects.some((e) => e.kind === "sanctuary"));
  check("on-cast burst healed the wounded ally (+2)", ally.hp === 3, `hp=${ally.hp}`);
  const zone = w.effects.find((e) => e.kind === "sanctuary")!;
  check("the zone lifetime is the fixed 4.0s", Math.abs(zone.maxLife - ticksToSec(SANCTUARY.lifetimeTicks)) < 1e-6);
  // Stand in the zone for its whole life: the HoT heals within the clamped ally rate and NEVER
  // exceeds maxHp. Post 2026-07-19 nerf (perTargetHpPerSec 0.9) a single 4s zone tops up PARTIALLY,
  // not a full bar — healing supplements survival, it no longer replaces it. The invariant that
  // must always hold: HP only goes up (or holds) and never overheals past maxHp.
  const hpBeforeHot = ally.hp;
  for (let i = 0; i < SANCTUARY.lifetimeTicks + 5; i++) tick(w, () => idle());
  check("the clamped HoT never overheals past maxHp and never drops the ally",
    ally.hp >= hpBeforeHot && ally.hp <= ally.maxHp, `hp=${ally.hp}/${ally.maxHp}`);
  check("the zone expired on its fixed lifetime", !w.effects.some((e) => e.kind === "sanctuary"));
  // A HoT never revives a downed ally (spec §7).
  const w2 = freshWorld();
  spawnPlayerInWorld(w2, "m"); setPlayerKit(w2, "m", "mender");
  const downed = spawnPlayerInWorld(w2, "d"); setPlayerKit(w2, "d", "gunner");
  const m2 = w2.players.get("m")!;
  downed.x = m2.x + 20; downed.isDown = true; downed.hp = 0;
  m2.ultCharge = ULT.meterMax; m2.ultReadyAtTick = 0;
  tick(w2, (p) => ({ ...idle(), ult: p.id === "m" }));
  check("Sanctuary never auto-revives a downed ally", downed.isDown && downed.hp === 0);
}

function aegisTests(): void {
  section("BULWARK AEGIS: ENCOUNTER-SCALED HP, duration OR HP whichever first (spec §2.3/§9.2/§10)");
  check("the HP budget scales with the floor (deep floors block more) + clamps", (() => {
    const f1 = aegisHpBudgetForFloor(1), deep = aegisHpBudgetForFloor(25);
    return deep >= f1 && f1 >= AEGIS.hpMin && deep <= AEGIS.hpMax;
  })());
  const w = freshWorld();
  spawnPlayerInWorld(w, "b"); setPlayerKit(w, "b", "bulwark");
  const b = w.players.get("b")!;
  const domeX = b.x, domeY = b.y;
  const budget = aegisHpBudgetForFloor(w.floor);
  b.ultCharge = ULT.meterMax; b.ultReadyAtTick = 0;
  const ev = tick(w, (p) => ({ ...idle(), ult: p.id === "b" }));
  check("cast emitted ULT_AEGIS + spawned the dome entity", ev.some((e) => e.t === "ultAegis") && w.effects.some((e) => e.kind === "aegis"));
  const dome = w.effects.find((e) => e.kind === "aegis")!;
  check("the dome opens with its encounter-scaled HP budget", dome.kind === "aegis" && dome.hp === budget);
  // Move the bulwark far away so injected enemy fire only tests the dome, never the player, then
  // feed it enemy projectiles: each blocked shot costs 1 barrier HP; the dome falls when spent.
  b.x = domeX + 1000;
  let blocked = 0;
  for (let i = 0; i < budget + 4 && w.effects.some((e) => e.kind === "aegis"); i++) {
    w.bullets.push(enemyBullet(domeX, domeY));
    const e2 = tick(w, () => idle());
    blocked += e2.filter((e) => e.t === "bulletBlocked").length;
  }
  check("the dome absorbed enemy projectiles (blocked, HP spent)", blocked >= budget, `blocked=${blocked}`);
  check("the dome FELL on its HP budget well before the 4.0s duration (whichever first)", !w.effects.some((e) => e.kind === "aegis"));
  check("allies shoot OUT: a friendly round inside the dome is NOT absorbed", (() => {
    const w3 = freshWorld();
    spawnPlayerInWorld(w3, "b"); setPlayerKit(w3, "b", "bulwark");
    const bb = w3.players.get("b")!; bb.ultCharge = ULT.meterMax; bb.ultReadyAtTick = 0;
    const fx = bb.x, fy = bb.y;
    tick(w3, (p) => ({ ...idle(), ult: p.id === "b" }));
    const friendly: Bullet = { ...enemyBullet(fx, fy), friendly: true, owner: "b" };
    w3.bullets.push(friendly);
    const e4 = tick(w3, () => idle());
    return !e4.some((e) => e.t === "bulletBlocked");
  })());
}

function phaseTests(): void {
  section("PHANTOM PHASE: invuln HARD-CAPPED <= 1.2s + multi-target (spec §2.4/§9.1)");
  check("the authored invuln is <= the 1.2s cap", PHASE.invulnTicks <= PHASE.invulnCapTicks && ticksToSec(PHASE.invulnCapTicks) <= 1.2 + 1e-9);
  const w = freshWorld();
  spawnPlayerInWorld(w, "ph"); setPlayerKit(w, "ph", "phantom");
  const near = spawnPlayerInWorld(w, "near"); setPlayerKit(w, "near", "gunner");
  const far = spawnPlayerInWorld(w, "far"); setPlayerKit(w, "far", "gunner");
  const ph = w.players.get("ph")!;
  near.x = ph.x + 50; near.y = ph.y;   // inside the 90px radius
  far.x = ph.x + 300; far.y = ph.y;    // outside
  near.invuln = 0; far.invuln = 0;
  ph.ultCharge = ULT.meterMax; ph.ultReadyAtTick = 0;
  const ev = tick(w, (p) => ({ ...idle(), ult: p.id === "ph" }));
  check("cast emitted ULT_PHASE", ev.some((e) => e.t === "ultPhase"));
  check("the caster gets the capped invuln (<= 1.2s)", ph.ultInvuln > 0 && ph.ultInvuln <= 1.2 + 1e-9);
  check("a nearby ally (any kit) gets the invuln + speed surge", near.ultInvuln > 0 && near.phaseSpeed > 0);
  check("a far ally is EXCLUDED (multi-target selection is radius-gated)", far.ultInvuln === 0 && far.phaseSpeed === 0);
  // Phase invuln blocks all damage while live: an enemy round on the caster does nothing.
  const hpBefore = ph.hp;
  w.bullets.push(enemyBullet(ph.x, ph.y));
  tick(w, () => idle());
  check("Phase invuln negates incoming damage while live", ph.hp === hpBefore);
}

function healClampTests(): void {
  section("§10 MENDER incoming-heal clamp: two Menders' HoT on ONE ally does NOT double-stack");
  check("the per-target + party heal caps are exposed as tunables", MENDER_HEAL_CLAMP.perTargetHpPerSec === 0.9 && MENDER_HEAL_CLAMP.partyHpPerSec === 3.0);
  // Two Menders both drop Sanctuary over one wounded ally; the sustained HoT is rate-clamped.
  const w = freshWorld();
  spawnPlayerInWorld(w, "m1"); setPlayerKit(w, "m1", "mender");
  spawnPlayerInWorld(w, "m2"); setPlayerKit(w, "m2", "mender");
  const ally = spawnPlayerInWorld(w, "a"); setPlayerKit(w, "a", "gunner");
  const m1 = w.players.get("m1")!, m2 = w.players.get("m2")!;
  m2.x = m1.x + 10; ally.x = m1.x + 5; ally.y = m1.y;
  ally.maxHp = 100; ally.hp = 10; // deeply wounded so the cap, not maxHp, governs
  m1.ultCharge = ULT.meterMax; m1.ultReadyAtTick = 0;
  m2.ultCharge = ULT.meterMax; m2.ultReadyAtTick = 0;
  // Both cast on the same tick.
  tick(w, (p) => ({ ...idle(), ult: p.id === "m1" || p.id === "m2" }));
  const afterBurst = ally.hp;
  // Run 3 seconds of overlapping HoT; the sustained gain must track the per-target cap (≤ ~1
  // whole HP/s from the combined Mender HoT), NOT 2 HP/s (which double-stacking would give).
  const startHp = ally.hp;
  for (let i = 0; i < 60; i++) tick(w, () => idle());
  const hotGain = ally.hp - startHp;
  check("the on-cast burst still lands (Sanctuary keeps its signature)", afterBurst > 10);
  check("3s of TWO overlapping Sanctuary HoTs heals at the clamped rate, not doubled", hotGain <= 4, `hotGain=${hotGain} (two-mender double-stack would be ~6)`);
}

function overdriveCeilingTests(): void {
  section("§10 Overdrive is a SEPARATE clamped fire-rate LAYER (never collides with the 1.8x raw cap)");
  check("the fire factor + expressive ceiling are exposed tunables", OVERDRIVE.fireFactor > 1 && OVERDRIVE.expressiveFireCeiling >= OVERDRIVE.fireFactor);
  check("the ceiling caps the combined build+Overdrive fire rate", OVERDRIVE.expressiveFireCeiling <= 5, `ceiling=${OVERDRIVE.expressiveFireCeiling}`);
}

function bossUntouchedTests(): void {
  section("§11 ults are PLAYER capability only: casting never touches boss phase/transition state");
  const w = freshWorld();
  spawnPlayerInWorld(w, "b"); setPlayerKit(w, "b", "bulwark");
  const boss = devSpawnEnemy(w, "boss", w.players.get("b")!.x + 300, w.players.get("b")!.y);
  const phaseBefore = boss.boss ? boss.boss.phase : -1;
  const hpBefore = boss.hp;
  const b = w.players.get("b")!;
  b.ultCharge = ULT.meterMax; b.ultReadyAtTick = 0;
  tick(w, (p) => ({ ...idle(), ult: p.id === "b" }));
  check("Aegis cast leaves the boss phase untouched", (boss.boss ? boss.boss.phase : -1) === phaseBefore);
  check("Aegis cast does no direct damage to the boss (cover, not a weapon)", boss.hp === hpBefore);
}

function hardenedTests(): void {
  section("BULWARK HARDENED: ~15% DR, integer HP preserved (spec §2.3)");
  check("the DR rate is the authored ~15%", Math.abs(HARDENED.reduction - 0.15) < 1e-9);
  // A bulwark and a neutral player each eat many 1-damage hits; the tank loses strictly less.
  const measure = (kit: KitId): number => {
    const w = freshWorld();
    spawnPlayerInWorld(w, "p"); if (kit !== "none") setPlayerKit(w, "p", kit);
    const p = w.players.get("p")!;
    p.maxHp = 100; p.hp = 100; p.invuln = 0;
    for (let i = 0; i < 40; i++) {
      p.invuln = 0; // clear the post-hit window so every injected round lands
      w.bullets.push(enemyBullet(p.x, p.y));
      tick(w, () => idle());
    }
    return 100 - p.hp;
  };
  const neutralLost = measure("none");
  const bulwarkLost = measure("bulwark");
  check("a neutral player takes the full damage", neutralLost > 0, `lost=${neutralLost}`);
  check("the tank takes strictly less (Hardened soak)", bulwarkLost < neutralLost, `tank=${bulwarkLost} neutral=${neutralLost}`);
  check("the reduction is roughly the authored rate", bulwarkLost <= Math.ceil(neutralLost * (1 - HARDENED.reduction)) + 1, `tank=${bulwarkLost} neutral=${neutralLost}`);
}

function momentumTests(): void {
  section("GUNNER MOMENTUM: ramps on unhit hits, SOFTENED decay — survives a boss fight (Wave 2)");
  check("momentum ceiling is ~+15% damage / +10% fire rate at max", Math.abs(MOMENTUM.maxStacks * MOMENTUM.damagePerStack - 0.15) < 1e-9 && Math.abs(MOMENTUM.maxStacks * MOMENTUM.fireRatePerStack - 0.10) < 1e-9);
  const w = freshWorld(); w.enemies = [];
  spawnPlayerInWorld(w, "g"); setPlayerKit(w, "g", "gunner");
  const g = w.players.get("g")!; g.invuln = 0;
  // Momentum stacks live in the passive channel; a significant taken hit softens the ramp by
  // OVERHEAT.significantLoss (was: ANY hit WIPED it — the boss-fight achievability fix).
  g.passiveState = MOMENTUM.maxStacks;
  g.invuln = 0;
  w.bullets.push(enemyBullet(g.x, g.y)); // a 1-heart (significant) hit
  tick(w, () => idle());
  check("a significant hit loses OVERHEAT.significantLoss stacks (not ALL)", g.passiveState === MOMENTUM.maxStacks - OVERHEAT.significantLoss, `stacks=${g.passiveState}`);
  check("the ramp SURVIVES the hit (a graze no longer wipes it)", g.passiveState > 0);
}

function overheatTests(): void {
  section("GUNNER OVERHEAT: boil-over at max stacks -> +fire/+pierce burst, rolls to the reset (Wave 2)");
  check("authored: reset floor < max, +pierce, +fire on top of Momentum", OVERHEAT.resetStacks < MOMENTUM.maxStacks && OVERHEAT.bonusPierce >= 1 && OVERHEAT.extraFireRate > 0);
  const w = freshWorld(); w.enemies = []; w.isGodMode = true; // isolate the ramp from incoming fire
  spawnPlayerInWorld(w, "g"); setPlayerKit(w, "g", "gunner");
  const g = w.players.get("g")!; g.invuln = 0;
  const dummy = devSpawnEnemy(w, "boss", g.x + 60, g.y); dummy.hp = 1e9; dummy.maxHp = 1e9;
  let sawBoilOver = false;
  for (let i = 0; i < 200 && !sawBoilOver; i++) {
    tick(w, (p) => ({ ...idle(), firing: p.id === "g", aim: 0 }));
    if (g.overheatT > 0) sawBoilOver = true;
  }
  check("hitting max stacks fires OVERHEAT (the boil-over burst opens)", sawBoilOver && g.overheatT > 0, `ovh=${g.overheatT.toFixed(2)}`);
  check("stacks roll to the reset floor (keeps rolling, never resets to 0)", g.passiveState >= OVERHEAT.resetStacks, `stacks=${g.passiveState}`);
  check("the burst window is the authored ~3s (never longer)", g.overheatT <= ticksToSec(OVERHEAT.burstTicks) + 1e-6);
}

function overshieldTests(): void {
  section("BULWARK OVERSHIELD: absorbs BEFORE hearts, regen pauses under fire (Wave 2)");
  check("authored: 3 chips, regen no faster than the pause (an out-of-combat buffer)", OVERSHIELD.maxChips === 3 && OVERSHIELD.regenTicks >= OVERSHIELD.pauseTicks);
  const w = freshWorld(); w.enemies = [];
  spawnPlayerInWorld(w, "b"); setPlayerKit(w, "b", "bulwark");
  const b = w.players.get("b")!; b.maxHp = 100; b.hp = 100; b.invuln = 0;
  check("a bulwark spawns with a full overshield (felt in the first 30s)", b.overshield === OVERSHIELD.maxChips);
  const startHp = b.hp;
  // Sustained fire drains the pool BEFORE hearts (no post-hit iframe while the shield eats).
  for (let i = 0; i < OVERSHIELD.maxChips; i++) { b.invuln = 0; w.bullets.push(enemyBullet(b.x, b.y)); tick(w, () => idle()); }
  check("the overshield eats the first hits (hearts untouched while chips remain)", b.hp === startHp, `hp=${b.hp}`);
  check("sustained fire drains the pool to empty (gone under fire, never invuln)", b.overshield === 0, `osh=${b.overshield}`);
  b.invuln = 0; w.bullets.push(enemyBullet(b.x, b.y)); tick(w, () => idle());
  check("once the shield is spent, the next hit reaches hearts", b.hp < startHp, `hp=${b.hp}`);

  // Out-of-combat regen: a spent chip returns after the pause + interval (no incoming damage).
  const w2 = freshWorld(); w2.enemies = [];
  spawnPlayerInWorld(w2, "b2"); setPlayerKit(w2, "b2", "bulwark");
  const b2 = w2.players.get("b2")!; b2.overshield = 0; b2.overshieldRegenT = 0;
  for (let i = 0; i < OVERSHIELD.regenTicks + 2; i++) tick(w2, () => idle());
  check("out of combat, the overshield regenerates", b2.overshield >= 1, `osh=${b2.overshield}`);
  // Under sustained fire the regen is PAUSED: it never climbs while hits keep landing.
  const w3 = freshWorld(); w3.enemies = [];
  spawnPlayerInWorld(w3, "b3"); setPlayerKit(w3, "b3", "bulwark");
  const b3 = w3.players.get("b3")!; b3.overshield = 0; b3.overshieldRegenT = 0;
  for (let i = 0; i < OVERSHIELD.regenTicks * 2; i++) { b3.invuln = 0; w3.bullets.push(enemyBullet(b3.x, b3.y)); tick(w3, () => idle()); }
  check("sustained fire PAUSES regen (the pool never climbs under fire)", b3.overshield === 0, `osh=${b3.overshield}`);
}

function healPulseTests(): void {
  section("MENDER HEAL-PULSE: directed 2 HP burst to the aimed ally, on cooldown (Wave 2)");
  check("authored: 2 HP, 6s cooldown", HEAL_PULSE.heal === 2 && HEAL_PULSE.cooldownTicks === 120);
  const w = freshWorld(); w.enemies = [];
  spawnPlayerInWorld(w, "m"); setPlayerKit(w, "m", "mender");
  const ally = spawnPlayerInWorld(w, "a"); setPlayerKit(w, "a", "gunner");
  const m = w.players.get("m")!;
  ally.x = m.x + 40; ally.y = m.y; ally.maxHp = 20; ally.hp = 10; // aimed to the +x of the mender
  tick(w, (p) => ({ ...idle(), aim: 0, pulse: p.id === "m" }));
  check("the pulse instantly heals the aimed ally by HEAL_PULSE.heal", ally.hp === 12, `hp=${ally.hp}`);
  check("the pulse arms its cooldown", m.pulseReadyAtTick > w.tick);
  const hpAfter = ally.hp;
  tick(w, (p) => ({ ...idle(), aim: 0, pulse: p.id === "m" }));
  check("the cooldown refuses an immediate second pulse", ally.hp === hpAfter, `hp=${ally.hp}`);
  // An ally OUTSIDE the aim cone is not the target (directed, not an AoE).
  const w2 = freshWorld(); w2.enemies = [];
  spawnPlayerInWorld(w2, "m2"); setPlayerKit(w2, "m2", "mender");
  const behind = spawnPlayerInWorld(w2, "bh"); setPlayerKit(w2, "bh", "gunner");
  const m2 = w2.players.get("m2")!;
  behind.x = m2.x - 40; behind.y = m2.y; behind.maxHp = 20; behind.hp = 10; // BEHIND (aim is +x)
  tick(w2, (p) => ({ ...idle(), aim: 0, pulse: p.id === "m2" }));
  check("an ally outside the aim cone is NOT healed (directed, not AoE)", behind.hp === 10, `hp=${behind.hp}`);
}

function phantomMarkTests(): void {
  section("PHANTOM MARK: dash-through marks +vuln + refunds the dash cooldown (Wave 2)");
  check("authored: +15% vuln, 35% refund, non-stacking window", PHANTOM_MARK.vulnMult === 1.15 && PHANTOM_MARK.refundFrac === 0.35 && PHANTOM_MARK.durationTicks > 0);
  const w = freshWorld(); w.enemies = [];
  spawnPlayerInWorld(w, "ph"); setPlayerKit(w, "ph", "phantom");
  const ph = w.players.get("ph")!;
  const enemy = devSpawnEnemy(w, "slime", ph.x + 30, ph.y); enemy.hp = 1000; enemy.maxHp = 1000;
  tick(w, (p) => ({ ...idle(), dash: p.id === "ph", moveX: 1, aim: 0 }));
  check("dashing THROUGH an enemy MARKS it (+vuln for the window)", enemy.markT > 0, `markT=${enemy.markT.toFixed(2)}`);
  const throughCd = ph.dashCd;
  // A phantom dashing through EMPTY space gets the full cooldown (no refund) — the delta is 35%.
  const empty = freshWorld(); empty.enemies = [];
  spawnPlayerInWorld(empty, "e"); setPlayerKit(empty, "e", "phantom");
  const pe = empty.players.get("e")!;
  tick(empty, (p) => ({ ...idle(), dash: p.id === "e", moveX: 1, aim: 0 }));
  check("dashing through EMPTY space adds the full dash cooldown (no refund)", pe.dashCd > 0);
  check("dashing THROUGH an enemy leaves a SHORTER cooldown (35% refunded)", throughCd < pe.dashCd - 1e-9, `through=${throughCd.toFixed(3)} empty=${pe.dashCd.toFixed(3)}`);
  check("the refund is ~PHANTOM_MARK.refundFrac of the cooldown", Math.abs(throughCd - pe.dashCd * (1 - PHANTOM_MARK.refundFrac)) < 1e-6, `through=${throughCd.toFixed(3)} expected=${(pe.dashCd * (1 - PHANTOM_MARK.refundFrac)).toFixed(3)}`);
}

function phantomBossVulnCapTests(): void {
  section("PHANTOM MARK vs a BOSS: the +15% SHARES the BOSS_VULN_CAP (never additive, Wave 2)");
  // A marked boss takes MORE from a plain (non-crit) hit, but a marked + max-crit hit is still
  // capped at BOSS_VULN_CAP — the mark shares the crit channel's ceiling, never stacks past it.
  const measure = (marked: boolean, critMult: number): number => {
    const w = freshWorld(); w.enemies = [];
    spawnPlayerInWorld(w, "ph"); setPlayerKit(w, "ph", "phantom");
    const ph = w.players.get("ph")!;
    const boss = devSpawnEnemy(w, "boss", ph.x + 120, ph.y);
    const hp0 = boss.hp;
    if (marked) boss.markT = ticksToSec(PHANTOM_MARK.durationTicks);
    // A crit-carrying friendly bullet planted on the boss (critX baked in, as fire() does); a
    // few ticks let it resolve the hit through the ordinary boss-grade strike path.
    const shot: Bullet = { ...enemyBullet(boss.x, boss.y), radius: 30, life: 0.5, friendly: true, owner: "ph", damage: 10 * critMult, isCrit: critMult > 1, critX: critMult };
    w.bullets.push(shot);
    for (let i = 0; i < 3; i++) tick(w, () => idle());
    return hp0 - boss.hp;
  };
  const plain = measure(false, 1);
  const markedPlain = measure(true, 1);
  check("a plain hit on a MARKED boss deals more (mark applies)", markedPlain > plain + 1e-6, `plain=${plain.toFixed(2)} marked=${markedPlain.toFixed(2)}`);
  check("mark on a non-crit hit is exactly the +15% vuln (≤ cap)", Math.abs(markedPlain / plain - PHANTOM_MARK.vulnMult) < 1e-6, `ratio=${(markedPlain / plain).toFixed(3)}`);
  // Max crit (well above the cap) alone already saturates BOSS_VULN_CAP; adding the mark cannot
  // push the realized vulnerability past it.
  const critOnly = measure(false, 3);
  const critMarked = measure(true, 3);
  check("mark + max-crit combined vulnerability is still capped at BOSS_VULN_CAP", Math.abs(critMarked - critOnly) < 1e-6, `critOnly=${critOnly.toFixed(2)} critMarked=${critMarked.toFixed(2)} (cap ${BOSS_VULN_CAP})`);
}

function main(): void {
  masteryTests();
  chargeFormulaTests();
  overdriveTests();
  ultRefillAfterCastTests();
  overdriveCeilingTests();
  sanctuaryTests();
  healClampTests();
  aegisTests();
  phaseTests();
  hardenedTests();
  momentumTests();
  overheatTests();
  overshieldTests();
  healPulseTests();
  phantomMarkTests();
  phantomBossVulnCapTests();
  bossUntouchedTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll kit/ult/mastery unit gates hold.\n");
}

main();
