// Weapon HUD-stat suite: the sim's weaponStats helper — the single source the hotbar
// tooltips and the weapon drawer read — must (1) report the base weapon data faithfully,
// (2) apply run mods + the low-HP scalers exactly like the fire math, capped, (3) derive
// the special-effect copy from the canonical Weapon fields, and (4) NEVER drift from what
// a real trigger pull produces: the anti-drift section fires actual shots in a real world
// (with a modded player) and pins bullet damage / volley size / fire cooldown to the
// numbers the HUD would display.
//
// Run: npm run test:weaponstats

import { weaponHudStats, liveDamageMult, liveFireRateMult, lowHpFrac } from "../src/sim/weaponStats.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { createMods } from "../src/sim/items.js";
import { CAPS } from "../src/sim/balance.js";
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
  section("base stats: unmodded values read straight from the canonical weapon data");
  const p = weaponHudStats("pistol", createMods(), 0);
  check("pistol damage", p.damage === 2);
  check("pistol pellets", p.pellets === 1);
  check("pistol rate = 1/fireCd", near(p.rate, 1 / 0.16));
  check("pistol range = speed × life", near(p.range, 560 * 1.1));
  check("pistol is not melee and has no special", !p.isMelee && p.special === null);

  const sg = weaponHudStats("shotgun", createMods(), 0);
  check("shotgun volley of 5 at 1.7 per pellet", sg.pellets === 5 && sg.damage === 1.7);

  const sw = weaponHudStats("sword", createMods(), 0);
  check("melee: range is the reach, pellets pinned to 1", sw.isMelee && sw.range === 48 && sw.pellets === 1);
  check("melee rate still meaningful", near(sw.rate, 1 / 0.22));
}

function modTests(): void {
  section("mods: damage/fire-rate/pellets/range all reflect the live build");
  const mods = createMods();
  mods.damageMult = 1.5;
  mods.fireRateMult = 1.2;
  mods.extraPellets = 2;
  mods.bulletSpeedMult = 1.1;
  mods.bulletLifeMult = 1.25;
  const s = weaponHudStats("pistol", mods, 0);
  check("damage scales by the damage mult", near(s.damage, 2 * 1.5));
  check("rate scales by the fire-rate mult", near(s.rate, (1 / 0.16) * 1.2));
  check("extra pellets join the volley", s.pellets === 3);
  check("range scales by speed AND life mults", near(s.range, 560 * 1.1 * 1.1 * 1.25));

  const m = weaponHudStats("sword", mods, 0);
  check("melee ignores pellet/range mults (reach is reach)", m.pellets === 1 && m.range === 48);
  check("melee damage/rate still scale", near(m.damage, 3.5 * 1.5) && near(m.rate, (1 / 0.22) * 1.2));

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
  const hurt = weaponHudStats("pistol", risk, lowHpFrac(3, 6));
  check("stats carry the live low-HP payoff", near(hurt.damage, 2 * Math.min(CAPS.damageMult, 2.5)));
}

function specialTests(): void {
  section("special-effect copy derives from canonical weapon fields (never hand-written)");
  const special = (id: WeaponId) => weaponHudStats(id, createMods(), 0).special;
  check("tesla chains", special("tesla") === "CHAINS TO 3 MORE");
  check("ricochet bounces twice", special("ricochet") === "RICOCHETS \u00d72");
  check("nailer bounces once", special("nailer") === "RICOCHETS ONCE");
  check("wisp homes", special("homing") === "HOMING ROUNDS");
  check("mortar blasts with its real radius", special("mortar") === "64PX BLAST");
  check("flamer burns", special("flamer") === "SETS TARGETS ABLAZE");
  check("cannon pierces its basePierce", special("cannon") === "PIERCES 2 BODIES");
  check("beam pierces one", special("beam") === "PIERCES 1 BODY");
  check("spear thrusts", special("spear") === "PIERCING THRUST");
  check("claymore sweeps wide", special("longsword") === "WIDE SWEEP");
  check("plain weapons carry no special", (["pistol", "shotgun", "rapid", "smg", "burst", "railgun", "sword"] as WeaponId[])
    .every((id) => special(id) === null));
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

  const stats = weaponHudStats("shotgun", p.mods, lowHpFrac(p.hp, p.maxHp));
  const fireCmd: InputCmd = { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
  p.fireCd = 0;
  stepWorld(w, new Map<PlayerId, InputCmd>([[p.id, fireCmd]]), 1 / 20);

  const volley = w.bullets.filter((b) => b.friendly);
  check("volley size = the HUD's pellet count", volley.length === stats.pellets, `fired=${volley.length} hud=${stats.pellets}`);
  check("per-pellet damage = the HUD's damage stat (mods + berserk, capped)",
    volley.every((b) => near(b.damage, stats.damage)), `bullet=${volley[0]?.damage} hud=${stats.damage}`);
  // Bullets already flew one tick inside this stepWorld call: remaining life + dt = birth life.
  const dt = 1 / 20;
  check("bullet range budget = the HUD's range stat",
    volley.every((b) => near(Math.hypot(b.vx, b.vy) * (b.life + dt), stats.range, 1e-6)),
    `bullet=${volley[0] ? Math.hypot(volley[0].vx, volley[0].vy) * (volley[0].life + dt) : "-"} hud=${stats.range}`);
  // rate = attacks/sec -> the post-shot cooldown must be exactly 1/rate.
  check("fire cooldown = 1 / the HUD's rate stat", near(p.fireCd, 1 / stats.rate, 1e-9), `cd=${p.fireCd} 1/rate=${1 / stats.rate}`);

  section("anti-drift: melee swing damage matches the HUD stats");
  const w2 = createWorld(0x5747a76, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const p2 = spawnPlayerInWorld(w2, "p2");
  acquireWeaponInWorld(w2, p2.id, "sword");
  switchWeaponInWorld(w2, p2.id, "sword");
  p2.mods.damageMult = 1.75;
  const swordStats = weaponHudStats("sword", p2.mods, lowHpFrac(p2.hp, p2.maxHp));
  p2.fireCd = 0;
  stepWorld(w2, new Map<PlayerId, InputCmd>([[p2.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), 1 / 20);
  check("swing exists", p2.meleeSwing !== null);
  check("swing damage = HUD damage", p2.meleeSwing !== null && near(p2.meleeSwing.damage, swordStats.damage),
    `swing=${p2.meleeSwing?.damage} hud=${swordStats.damage}`);
  check("swing reach = HUD range", p2.meleeSwing !== null && p2.meleeSwing.reach === swordStats.range);
  check("melee cooldown = 1 / HUD rate", near(p2.fireCd, 1 / swordStats.rate, 1e-9));

  section("anti-drift: every weapon's base stats mirror WEAPONS (no duplicated constants)");
  const fresh = createMods();
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const def = WEAPONS[id];
    const s = weaponHudStats(id, fresh, 0);
    const ok = s.damage === def.damage
      && near(s.rate, 1 / def.fireCd)
      && (def.melee ? s.range === def.melee.reach : near(s.range, def.speed * def.life))
      && s.isMelee === (def.melee !== undefined)
      && s.pellets === (def.melee ? 1 : def.pellets);
    check(`${id} base stats mirror the canonical def`, ok);
  }
}

function main(): void {
  baseStatTests();
  modTests();
  specialTests();
  antiDriftTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll weapon-stat assertions passed.\n");
}

main();
