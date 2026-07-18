// Weapon display-stats suite: weaponDisplayStats is the ONE effective-stats source both
// the hotbar tooltip and the weapon drawer render from. It must (1) report the base
// weapon data faithfully, (2) apply run mods + the low-HP scalers exactly like the fire
// math, capped, (3) derive the room job / bands / mechanics from the canonical Weapon
// fields, and (4) NEVER drift from what a real trigger pull produces: the anti-drift
// section fires actual shots in a real world (with a modded player) and pins bullet
// damage / volley size / fire cooldown to the numbers the HUD would display.
//
// Run: npm run test:weaponstats

import { weaponDisplayStats, liveDamageMult, liveFireRateMult, lowHpFrac } from "../src/sim/weaponStats.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { createMods } from "../src/sim/items.js";
import { CAPS, WEAPON_BOSS_COEF } from "../src/sim/balance.js";
import {
  createWorld, spawnPlayerInWorld, acquireWeaponInWorld, switchWeaponInWorld, stepWorld,
} from "../src/sim/world.js";
import type { WeaponId } from "../src/sim/types.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function baseStatTests(): void {
  section("base stats: unmodded live numbers read straight from the canonical weapon data");
  const p = weaponDisplayStats("pistol", createMods(), 0);
  check("pistol per-hit power", p.power.perHit === 2 && p.power.count === 1);
  check("pistol cadence num = 1/fireCd", near(p.cadence.num, 1 / 0.16));
  check("pistol reach num = speed × life", near(p.reach.num, 560 * 1.1));
  check("pistol is not melee, no mechanics", !p.isMelee && p.mechanics.length === 0);

  const sg = weaponDisplayStats("shotgun", createMods(), 0);
  check("shotgun volley of 5 at 1.7 per pellet", sg.power.count === 5 && sg.power.perHit === 1.7);

  const sw = weaponDisplayStats("sword", createMods(), 0);
  check("melee: reach num is the reach, volley pinned to 1", sw.isMelee && sw.reach.num === 54 && sw.power.count === 1);
  check("melee cadence still meaningful", near(sw.cadence.num, 1 / 0.18));

  section("Quill FINAL: melee class authored fields");
  const sword = WEAPONS.sword;
  check("Cutlass FINAL", sword.damage === 5 && sword.fireCd === 0.18
    && sword.melee?.reach === 54 && sword.melee.arc === 1.35 && sword.melee.swingDur === 0.18);
  const longsword = WEAPONS.longsword;
  check("Claymore FINAL", longsword.damage === 8.5 && longsword.fireCd === 0.34
    && longsword.melee?.reach === 66 && longsword.melee.arc === 2 && longsword.melee.swingDur === 0.22);
  const spear = WEAPONS.spear;
  check("Pike FINAL", spear.damage === 6.5 && spear.fireCd === 0.24
    && spear.melee?.reach === 82 && spear.melee.arc === 0.36
    && spear.melee.swingDur === 0.16 && spear.melee.isThrust === true);
  const crook = WEAPONS.crook;
  check("Crooked Chain FINAL", crook.damage === 7 && crook.fireCd === 0.75
    && crook.tether?.range === 230 && crook.tether.pullSpeed === 640
    && crook.tether.holdDist === 58 && crook.tether.hold === 1
    && crook.tether.reach === 105 && crook.tether.width === 34);
  check("melee class FINAL boss coefficients", WEAPON_BOSS_COEF.sword === 0.55
    && WEAPON_BOSS_COEF.longsword === 0.55 && WEAPON_BOSS_COEF.spear === 0.55
    && WEAPON_BOSS_COEF.crook === 0.6);
}

function modTests(): void {
  section("mods: power/cadence/volley/reach all reflect the live build");
  const mods = createMods();
  mods.damageMult = 1.5;
  mods.fireRateMult = 1.2;
  mods.extraPellets = 2;
  mods.bulletSpeedMult = 1.1;
  mods.bulletLifeMult = 1.25;
  const s = weaponDisplayStats("pistol", mods, 0);
  check("power scales by the damage mult", near(s.power.perHit, 2 * 1.5));
  check("cadence scales by the fire-rate mult", near(s.cadence.num, (1 / 0.16) * 1.2));
  check("extra pellets join the volley", s.power.count === 3);
  check("reach scales by speed AND life mults", near(s.reach.num, 560 * 1.1 * 1.1 * 1.25));

  const m = weaponDisplayStats("sword", mods, 0);
  check("melee ignores pellet/range mults (reach is reach)", m.power.count === 1 && m.reach.num === 54);
  check("melee power/cadence still scale", near(m.power.perHit, 5 * 1.5) && near(m.cadence.num, (1 / 0.18) * 1.2));

  section("low-HP scalers: berserk/adrenaline pay off with missing health, capped");
  const risk = createMods();
  risk.damageMult = 2;
  risk.berserk = 1;
  risk.adrenaline = 0.6;
  risk.fireRateMult = 1.5;
  check("full HP: no berserk payoff", near(liveDamageMult(risk, lowHpFrac(6, 6)), 2));
  check("half HP: half the berserk bonus", near(liveDamageMult(risk, lowHpFrac(3, 6)), Math.min(CAPS.damageMult, 2.5)));
  check("death's door damage is CAPPED", near(liveDamageMult(risk, lowHpFrac(0.5, 6)), CAPS.damageMult));
  check("fire rate capped the same way", liveFireRateMult(risk, 1) === CAPS.fireRateMult);
  check("lowHpFrac guards a zero max", lowHpFrac(1, 0) === 0);
  const hurt = weaponDisplayStats("pistol", risk, lowHpFrac(3, 6));
  check("stats carry the live low-HP payoff", near(hurt.power.perHit, 2 * Math.min(CAPS.damageMult, 2.5)));
}

// The anti-drift oracle: give a REAL simulated player a build, pull the trigger, and
// require the fired volley to match the HUD numbers exactly. If someone forks the fire
// math away from weaponStats.ts, this is the test that goes red.
function antiDriftTests(): void {
  section("anti-drift: a real fired shot matches the HUD stats exactly");
  const w = createWorld(0x5747a75, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const p = spawnPlayerInWorld(w, "p1");
  acquireWeaponInWorld(w, p.id, "shotgun");
  switchWeaponInWorld(w, p.id, "shotgun");
  p.mods.damageMult = 1.4;
  p.mods.fireRateMult = 1.3;
  p.mods.extraPellets = 1;
  p.mods.bulletSpeedMult = 1.2;
  p.mods.bulletLifeMult = 1.1;
  p.hp = 3; p.maxHp = 6;
  p.mods.berserk = 0.5; // half HP -> +0.25 damage mult live

  const stats = weaponDisplayStats("shotgun", p.mods, lowHpFrac(p.hp, p.maxHp));
  const fireCmd: InputCmd = { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
  p.fireCd = 0;
  stepWorld(w, new Map<PlayerId, InputCmd>([[p.id, fireCmd]]), 1 / 20);

  const volley = w.bullets.filter((b) => b.friendly);
  check("volley size = the displayed pellet count", volley.length === stats.power.count, `fired=${volley.length} hud=${stats.power.count}`);
  check("per-pellet damage = the displayed POWER (mods + berserk, capped)",
    volley.every((b) => near(b.damage, stats.power.perHit)), `bullet=${volley[0]?.damage} hud=${stats.power.perHit}`);
  // Bullets already flew one tick inside this stepWorld call: remaining life + dt = birth life.
  const dt = 1 / 20;
  check("bullet range budget = the displayed reach number",
    volley.every((b) => near(Math.hypot(b.vx, b.vy) * (b.life + dt), stats.reach.num, 1e-6)),
    `bullet=${volley[0] ? Math.hypot(volley[0].vx, volley[0].vy) * (volley[0].life + dt) : "-"} hud=${stats.reach.num}`);
  // cadence num = attacks/sec -> the post-shot cooldown must be exactly 1/rate.
  check("fire cooldown = 1 / the displayed cadence number", near(p.fireCd, 1 / stats.cadence.num, 1e-9), `cd=${p.fireCd} 1/rate=${1 / stats.cadence.num}`);

  section("anti-drift: melee swing damage matches the displayed stats");
  const w2 = createWorld(0x5747a76, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const p2 = spawnPlayerInWorld(w2, "p2");
  acquireWeaponInWorld(w2, p2.id, "sword");
  switchWeaponInWorld(w2, p2.id, "sword");
  p2.mods.damageMult = 1.75;
  const swordStats = weaponDisplayStats("sword", p2.mods, lowHpFrac(p2.hp, p2.maxHp));
  p2.fireCd = 0;
  stepWorld(w2, new Map<PlayerId, InputCmd>([[p2.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), 1 / 20);
  check("swing exists", p2.meleeSwing !== null);
  check("swing damage = displayed POWER", p2.meleeSwing !== null && near(p2.meleeSwing.damage, swordStats.power.perHit),
    `swing=${p2.meleeSwing?.damage} hud=${swordStats.power.perHit}`);
  check("swing reach = displayed reach", p2.meleeSwing !== null && p2.meleeSwing.reach === swordStats.reach.num);
  check("melee cooldown = 1 / displayed cadence", near(p2.fireCd, 1 / swordStats.cadence.num, 1e-9));

  section("anti-drift: every weapon's base numbers mirror WEAPONS (no duplicated constants)");
  const fresh = createMods();
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const def = WEAPONS[id];
    const s = weaponDisplayStats(id, fresh, 0);
    const ok = s.power.perHit === def.damage
      && near(s.cadence.num, 1 / def.fireCd)
      && (def.melee ? s.reach.num === def.melee.reach : near(s.reach.num, def.speed * def.life))
      && s.isMelee === (def.melee !== undefined)
      && s.power.count === (def.melee ? 1 : def.pellets);
    check(`${id} base numbers mirror the canonical def`, ok);
  }
}

// The designer's card model: room-job verbs, categorical bands, and technique lines all
// derive from canonical WeaponDef fields by rule — never hand-written per weapon.
function cardTests(): void {
  const card = (id: WeaponId) => weaponDisplayStats(id, createMods(), 0);

  section("card: the room job derives from the weapon's defining behavior field");
  const roles: [WeaponId, string][] = [
    ["pistol", "HANDLE ANYTHING"], ["shotgun", "SHRED UP CLOSE"], ["sawnoff", "SHRED UP CLOSE"],
    ["rapid", "HOSE THEM DOWN"], ["smg", "HOSE THEM DOWN"], ["beam", "MELT ONE TARGET"],
    ["cannon", "BREAK A LINE"], ["railgun", "DELETE A TARGET"],
    ["homing", "SEEK TARGETS"], ["tesla", "ARC THE PACK"], ["mortar", "BLAST THE CHOKEPOINT"],
    ["flamer", "TORCH THE PACK"], ["ricochet", "WORK THE CORNERS"], ["nailer", "WORK THE CORNERS"],
    ["sword", "DUEL UP CLOSE"], ["longsword", "CLEAR YOUR FLANKS"], ["spear", "HOLD A LANE"],
  ];
  for (const [id, role] of roles) check(`${id} -> ${role}`, card(id).role === role, card(id).role);

  section("card: the ACCEPTED band tables (impact/cadence/reach) on live effective numbers");
  // IMPACT: LIGHT <1, SOLID <2.5, HEAVY <6, CRUSHING >=6 (effective per-pellet/swing damage)
  check("impact LIGHT under 1", card("flamer").impact.band === "LIGHT" && card("beam").impact.band === "LIGHT");
  check("impact SOLID under 2.5", card("pistol").impact.band === "SOLID" && card("shotgun").impact.band === "SOLID");
  check("impact HEAVY under 6", card("tesla").impact.band === "HEAVY" && card("sword").impact.band === "HEAVY");
  check("impact CRUSHING at 6+", card("mortar").impact.band === "CRUSHING" && card("railgun").impact.band === "CRUSHING"
    && card("longsword").impact.band === "CRUSHING");
  // CADENCE: SLOW <1.8/s, STEADY <5, FAST <10, RAPID >=10
  check("cadence SLOW under 1.8/s", card("railgun").cadence.band === "SLOW" && card("sawnoff").cadence.band === "SLOW");
  check("cadence STEADY under 5/s", card("shotgun").cadence.band === "STEADY" && card("sword").cadence.band === "STEADY");
  check("cadence FAST under 10/s", card("pistol").cadence.band === "FAST" && card("nailer").cadence.band === "FAST");
  check("cadence RAPID at 10+/s", card("smg").cadence.band === "RAPID" && card("beam").cadence.band === "RAPID");
  // REACH: CLOSE <180, MID <520, LONG <950, EXTREME >=950 — internal px, one scale for all
  check("reach CLOSE under 180", card("shotgun").reach.band === "CLOSE" && card("sawnoff").reach.band === "CLOSE");
  check("melee lives on the same reach scale (all CLOSE)",
    (["sword", "longsword", "spear"] as WeaponId[]).every((id) => card(id).reach.band === "CLOSE"));
  check("reach MID under 520", card("tesla").reach.band === "MID" && card("mortar").reach.band === "MID" && card("beam").reach.band === "MID");
  check("reach LONG under 950", card("pistol").reach.band === "LONG" && card("cannon").reach.band === "LONG");
  check("reach EXTREME at 950+", card("railgun").reach.band === "EXTREME" && card("ricochet").reach.band === "EXTREME");
  check("power is exact per-pellet \u00d7 count, never aggregate", card("shotgun").power.perHit === 1.7 && card("shotgun").power.count === 5);

  section("card: behavior-first COVERAGE categories");
  const cov = (id: WeaponId) => card(id).coverage.kind;
  check("melee: THRUST / SWEEP", cov("spear") === "THRUST" && cov("sword") === "SWEEP" && cov("longsword") === "SWEEP");
  check("blast is AREA", cov("mortar") === "AREA");
  check("chain lightning is CHAIN", cov("tesla") === "CHAIN");
  check("homing rounds are TRACKING", cov("homing") === "TRACKING");
  check("bouncing rounds are RICOCHET", cov("ricochet") === "RICOCHET" && cov("nailer") === "RICOCHET");
  check("wide fans are WIDE", cov("shotgun") === "WIDE" && cov("sawnoff") === "WIDE" && cov("flamer") === "WIDE");
  check("tight multi-shot is BURST", cov("burst") === "BURST");
  check("single tight rounds are FOCUSED",
    (["pistol", "rapid", "smg", "cannon", "railgun", "beam"] as WeaponId[]).every((id) => cov(id) === "FOCUSED"));
  check("pattern family carries an order, behavior kinds do not",
    card("pistol").coverage.patternOrder === 0 && card("burst").coverage.patternOrder === 1
    && card("shotgun").coverage.patternOrder === 2 && card("tesla").coverage.patternOrder === null);
  check("thrust still carries its mechanic line", card("spear").mechanics.some((m) => m.tag === "THRUST"));

  section("card: technique/tradeoff mechanics from canonical fields (incl. self-kick)");
  const tags = (id: WeaponId) => card(id).mechanics.map((m) => m.tag).join(",");
  check("cannon: PIERCE", tags("cannon") === "PIERCE");
  check("tesla: CHAIN", tags("tesla") === "CHAIN");
  check("ricochet/nailer: RICOCHET at different magnitudes",
    tags("ricochet") === "RICOCHET" && tags("nailer") === "RICOCHET"
    && card("ricochet").mechanics[0].mag === 2 && card("nailer").mechanics[0].mag === 1);
  check("homing: SEEKING", tags("homing") === "SEEKING");
  check("mortar: BLAST", tags("mortar") === "BLAST");
  check("flamer: BURN", tags("flamer") === "BURN");
  check("shotgun/sawnoff: the big self-kick surfaces as KICK", tags("shotgun") === "KICK" && tags("sawnoff") === "KICK");
  check("plain weapons carry no mechanics", (["pistol", "rapid", "smg", "burst", "sword", "longsword"] as WeaponId[])
    .every((id) => card(id).mechanics.length === 0));

  section("card: live mods reshape the card honestly");
  const mods = createMods();
  mods.extraPellets = 2;
  mods.pierce = 1;
  mods.fireRateMult = 1.7;
  mods.damageMult = 1.5;
  const modded = weaponDisplayStats("pistol", mods, 0);
  check("extra pellets grow the volley and move coverage FOCUSED -> BURST", modded.power.count === 3 && modded.coverage.kind === "BURST");
  check("pierce mods surface a live PIERCE mechanic", modded.mechanics.some((m) => m.tag === "PIERCE" && m.mag === 1));
  check("fire-rate mods can move the cadence band", modded.cadence.band === "RAPID", modded.cadence.band); // 6.25 -> 10.6
  check("damage mods can move the impact band", modded.impact.band === "HEAVY", modded.impact.band); // 2 -> 3
  check("melee ignores pellet mods on the card", weaponDisplayStats("sword", mods, 0).power.count === 1);
}

// QA gate: no card field may ever be NaN/undefined/empty for ANY weapon under ANY mod
// profile or HP state — the tooltip must never render nonsense.
function integrityTests(): void {
  section("QA gate: every card is finite and complete across weapons \u00d7 builds \u00d7 HP states");
  const capped = createMods();
  capped.damageMult = 99; capped.fireRateMult = 99; capped.extraPellets = 4; capped.spreadAdd = 0.4;
  capped.bulletSpeedMult = 1.3; capped.bulletLifeMult = 1.3; capped.pierce = 9;
  capped.berserk = 3; capped.adrenaline = 2;
  const risky = createMods();
  risky.berserk = 1.2; risky.adrenaline = 0.8;
  const profiles = [createMods(), capped, risky];
  let bad = 0;
  const details: string[] = [];
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    for (let pi = 0; pi < profiles.length; pi++) {
      for (const lowHp of [0, 0.5, 1, lowHpFrac(1, 0)]) {
        const c = weaponDisplayStats(id, profiles[pi], lowHp);
        const nums = [c.power.perHit, c.power.count, c.impact.num, c.impact.order, c.cadence.num, c.cadence.order,
          c.reach.num, c.reach.order, ...(c.coverage.patternOrder !== null ? [c.coverage.patternOrder] : [])];
        const ok = nums.every((n) => Number.isFinite(n))
          && c.power.count >= 1
          && c.role.length > 0 && c.impact.band.length > 0 && c.cadence.band.length > 0
          && c.reach.band.length > 0 && c.coverage.kind.length > 0
          && c.mechanics.every((m) => m.text.length > 0 && Number.isFinite(m.mag))
          && !JSON.stringify(c).includes("NaN") && !JSON.stringify(c).includes("undefined");
        if (!ok) { bad++; details.push(`${id} profile=${pi} lowHp=${lowHp}`); }
      }
    }
  }
  check("no NaN / undefined / empty band anywhere", bad === 0, details.slice(0, 3).join("; "));
  check("caps hold even under an absurd build",
    weaponDisplayStats("pistol", capped, 1).power.perHit === 2 * CAPS.damageMult
    && weaponDisplayStats("pistol", capped, 1).cadence.num <= (1 / WEAPONS.pistol.fireCd) * CAPS.fireRateMult + 1e-9);
}

function main(): void {
  baseStatTests();
  modTests();
  cardTests();
  integrityTests();
  antiDriftTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll weapon-stat assertions passed.\n");
}

main();
