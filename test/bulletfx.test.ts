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
  renderHeldWeapon(
    cx: number,
    cy: number,
    aim: number,
    weapon: WeaponId,
    alpha: number,
    recoil: number,
    isSluiceDrain: boolean,
  ): void;
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
  const { game, canvas } = await bootGame(320, 240);
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

  const signature = (bullet: Bullet): number => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    probe.drawBulletFx(bullet, 160, 120);
    const pixels = ctx.getImageData(120, 80, 80, 80).data;
    let hash = 2166136261;
    for (const channel of pixels) hash = Math.imul(hash ^ channel, 16777619);
    return hash >>> 0;
  };
  const sluiceSignatures = new Set([
    signature({ ...probeBullet("sluicegate"), sluiceMode: "flood" }),
    signature({ ...probeBullet("sluicegate"), sluiceMode: "drain" }),
  ]);
  check("Sluice FLOOD and DRAIN are blind-distinct projectile silhouettes",
    sluiceSignatures.size === 2);
  const heldSignature = (isSluiceDrain: boolean): number => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    probe.renderHeldWeapon(160, 120, 0, "sluicegate", 1, 0, isSluiceDrain);
    const pixels = ctx.getImageData(120, 80, 80, 80).data;
    let hash = 2166136261;
    for (const channel of pixels) hash = Math.imul(hash ^ channel, 16777619);
    return hash >>> 0;
  };
  check("Sluice next FLOOD/DRAIN mode is blind-distinct before firing",
    heldSignature(false) !== heldSignature(true));
  const oddsmakerSignatures = new Set(
    (["ricochet", "seeker", "blast", "pierce"] as const)
      .map((oddsmakerOutcome) =>
        signature({ ...probeBullet("oddsmaker"), oddsmakerOutcome })),
  );
  check("all four Oddsmaker outcomes are blind-distinct raster grammars",
    oddsmakerSignatures.size === 4);

  process.stdout.write("\n[non-projectile weapons are justified exclusions (no traveling bullet)]\n");
  for (const id of nonProjectiles) {
    const w = WEAPONS[id];
    const kind = w.melee ? "melee" : w.wire ? "wire" : w.orbit ? "orbit" : w.tether ? "tether" : null;
    check(`${id} legitimately fires no traveling bullet${kind ? ` (${kind})` : ""}`, kind !== null);
  }

  // The AD's hard rule: enemy fire is round hot-amber orbs, so a player legendary must NEVER
  // read as a round tinted orb. Render each legendary on a black bg through the real path and
  // assert (a) a bright core pops off the dark ground, and — for Midas, the critical one where
  // gold cannot separate by hue — (b) the silhouette is a 4-point STAR (angular brightness
  // varies at a fixed radius), not a uniform disc, with (c) a near-WHITE (non-amber) core.
  const ctx2d = canvas.getContext("2d");
  const cx = 160, cy = 120;
  const drawOn = (id: WeaponId): void => {
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.globalAlpha = 1;
    ctx2d.fillStyle = "#000";
    ctx2d.fillRect(0, 0, 320, 240);
    probe.drawBulletFx(probeBullet(id), cx, cy);
  };
  const lum = (x: number, y: number): number => {
    const d = ctx2d.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return (d[0] + d[1] + d[2]) / 3;
  };
  const chan = (x: number, y: number): [number, number, number] => {
    const d = ctx2d.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  process.stdout.write("\n[legendary bullets differ from the enemy amber orb — bright core, shape-first]\n");
  for (const id of ["reaper", "swarm", "midas", "phase", "vortex"] as WeaponId[]) {
    drawOn(id);
    check(`${id} core pops off the dark background`, lum(cx, cy) > 60, `lum=${lum(cx, cy).toFixed(0)}`);
  }

  // Midas silhouette: sample a ring at ~2x the core radius; a 4-point star has bright arms and
  // dark gaps (high angular spread), a round orb would be near-uniform.
  drawOn("midas");
  const ring = Math.max(8, WEAPONS.midas.bulletRadius * 2);
  let minL = Infinity, maxL = -Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const l = lum(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring);
    minL = Math.min(minL, l);
    maxL = Math.max(maxL, l);
  }
  check("midas silhouette is a 4-point star, not a round orb (arms vs gaps)", maxL - minL > 30,
    `ring spread max=${maxL.toFixed(0)} min=${minL.toFixed(0)}`);
  const [cr, cg, cb] = chan(cx, cy);
  check("midas core is near-WHITE, never an amber orb (blue channel not starved)", cb >= cr * 0.8 && cr > 180,
    `rgb=${cr},${cg},${cb}`);

  game.stop();

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nEvery projectile weapon renders real bullet FX.\n");
}

main();
