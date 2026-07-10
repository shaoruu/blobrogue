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
  ULT, OVERDRIVE, SANCTUARY, AEGIS, PHASE, MOMENTUM, HARDENED, MENDER_HEAL_CLAMP, ticksToSec,
  masteryLevelForXp, isKitUnlocked, kitUnlockLevel, unlockedKits, masteryXpForRun,
  canCastUlt, ultChargeFromDamageDealt, ultChargeFromDamageTaken, ultChargeFromHealDone,
  ultShareCapUnits, ultTimeChargePerTick,
  refEncounterHpForFloor, aegisHpBudgetForFloor,
} from "../src/sim/kits.js";
import type { KitId } from "../src/sim/kits.js";

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
    return seconds >= 45 && seconds <= 65; // ~55s band
  })());

  section("§10 per-source SHARE caps: no single input dominates one fill (damage ≤70%, kills ≤40%)");
  check("share caps are exposed as tunable fractions", ULT.shareCap.dmg === 0.70 && ULT.shareCap.kill === 0.40);
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
    check("damage source never exceeds its 70% share cap", g.ultSources.dmg <= ultShareCapUnits("dmg"), `dmg=${g.ultSources.dmg} cap=${ultShareCapUnits("dmg")}`);
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
  // Stand in the zone for its whole life: the HoT tops the ally but NEVER exceeds maxHp.
  for (let i = 0; i < SANCTUARY.lifetimeTicks + 5; i++) tick(w, () => idle());
  check("the HoT tops the ally to (not past) maxHp — overheal does nothing", ally.hp === ally.maxHp, `hp=${ally.hp}/${ally.maxHp}`);
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
  check("the per-target + party heal caps are exposed as tunables", MENDER_HEAL_CLAMP.perTargetHpPerSec === 1.5 && MENDER_HEAL_CLAMP.partyHpPerSec === 3.0);
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
  section("GUNNER MOMENTUM: ramps on unhit hits, fully decays on taking damage (spec §2.1)");
  check("momentum ceiling is ~+15% damage / +10% fire rate at max", Math.abs(MOMENTUM.maxStacks * MOMENTUM.damagePerStack - 0.15) < 1e-9 && Math.abs(MOMENTUM.maxStacks * MOMENTUM.fireRatePerStack - 0.10) < 1e-9);
  const w = freshWorld();
  spawnPlayerInWorld(w, "g"); setPlayerKit(w, "g", "gunner");
  const g = w.players.get("g")!; g.invuln = 0;
  // Simulate landed hits via the damage-dealt hook indirectly: momentum stacks live in the
  // passive channel; a taken hit must zero it.
  g.passiveState = MOMENTUM.maxStacks;
  g.invuln = 0;
  w.bullets.push(enemyBullet(g.x, g.y));
  tick(w, () => idle());
  check("taking damage fully decays momentum", g.passiveState === 0);
}

function main(): void {
  masteryTests();
  chargeFormulaTests();
  overdriveTests();
  overdriveCeilingTests();
  sanctuaryTests();
  healClampTests();
  aegisTests();
  phaseTests();
  hardenedTests();
  momentumTests();
  bossUntouchedTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll kit/ult/mastery unit gates hold.\n");
}

main();
