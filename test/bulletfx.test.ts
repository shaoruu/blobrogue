// FX COVERAGE GATE: every projectile weapon must render layered bullet FX and never fall
// back to the plain-circle default in renderBullets. Boots the REAL Game against
// node-canvas with the real /public fx sprites loaded, then drives the actual
// drawBulletFx render path once per weapon and asserts it draws a recipe (returns true).
//
// A weapon is a PROJECTILE weapon when its trigger puts a traveling, fx-tagged bullet into
// the world. That is every weapon EXCEPT the melee swings (sword/longsword/spear) and the
// trigger verbs that author a non-bullet effect: the wire (snapwire), the orbit (halo) and
// the tether (crook). The Prism Sentry stays IN: its deployed turret fires bolts stamped
// fx="sentry" (see world.ts), so those bolts render through this same path.
//
// Run: npm run test:bulletfx

import { bootGame } from "./harness/raster.js";
import { WEAPONS } from "../src/sim/weapons.js";
import type { Weapon } from "../src/sim/weapons.js";
import type { WeaponId, Bullet } from "../src/sim/types.js";

// The one private render method this gate exercises (drawBulletFx returns whether it drew a
// recipe; false means the caller falls back to the plain circle).
interface FxProbe {
  drawBulletFx(b: Bullet, bx: number, by: number): boolean;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

// Fires a traveling, fx-tagged bullet: everything but melee and the non-traveling effect
// verbs (wire/orbit/tether). Sentry passes — its bolts carry fx="sentry".
function firesProjectile(w: Weapon): boolean {
  return !w.melee && !w.wire && !w.orbit && !w.tether;
}

function probeBullet(fx: WeaponId): Bullet {
  const w = WEAPONS[fx];
  return {
    x: 0, y: 0,
    vx: w.speed > 0 ? w.speed : 400, vy: 0,
    radius: w.bulletRadius > 0 ? w.bulletRadius : 5,
    life: 1, friendly: true, owner: null,
    damage: 1, color: w.color, pierce: 0, hitList: null, isCrit: false,
    fx,
  };
}

async function main(): Promise<void> {
  const { game } = await bootGame(320, 240);
  const probe = game as object as FxProbe;

  const ids = Object.keys(WEAPONS) as WeaponId[];
  const projectiles = ids.filter((id) => firesProjectile(WEAPONS[id]));
  const nonProjectiles = ids.filter((id) => !firesProjectile(WEAPONS[id]));

  // Sanity: the harness actually loaded the fx primitives (else every check would be a
  // false negative). The sidearm is the arsenal's neutral baseline.
  check("harness loaded fx primitives (pistol draws its recipe)", probe.drawBulletFx(probeBullet("pistol"), 0, 0));

  process.stdout.write("\n[every projectile weapon renders a bullet FX recipe — no plain circles]\n");
  for (const id of projectiles) {
    check(`${id} renders a bullet FX recipe`, probe.drawBulletFx(probeBullet(id), 0, 0));
  }

  process.stdout.write("\n[non-projectile weapons are justified exclusions (no traveling bullet)]\n");
  for (const id of nonProjectiles) {
    const w = WEAPONS[id];
    const kind = w.melee ? "melee" : w.wire ? "wire" : w.orbit ? "orbit" : w.tether ? "tether" : null;
    check(`${id} legitimately fires no traveling bullet${kind ? ` (${kind})` : ""}`, kind !== null);
  }

  game.stop();

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nEvery projectile weapon renders real bullet FX.\n");
}

main();
