// Companion-pet suite: deterministic follow/targeting/damage/support behavior, the safe
// teleport failsafe, owner lifecycle (down/pause/disconnect), the bounded-power caps, and
// the pure unlock-requirement evaluator that Convex persists against. Pure sim — no DOM, no
// sockets — the same core the server and client share. The measured DPS/utility numbers are
// printed at the end (they feed the PR's balance summary).
//
// Run: npm run test:pets

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, spawnPetInWorld, devSpawnEnemy,
  stepWorld, descend,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, Pet } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { PETS, PET_KINDS, PET_BALANCE, PET_CAPS, isPetKind, isPetUnlocked, petUnlocksFor } from "../src/sim/pets.js";
import { BURN_DMG_STACK } from "../src/sim/constants.js";
import { createMods, recomputeMods } from "../src/sim/items.js";
import { FIXED_DT } from "../src/net/protocol.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const IDLE: Omit<InputCmd, "seq"> = { moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };

// Step a world N ticks feeding each player the given (or idle) input, collecting events.
function run(w: WorldState, ticks: number, inputs: Map<PlayerId, Omit<InputCmd, "seq">> = new Map()): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const cmds = new Map<PlayerId, InputCmd>();
    for (const pid of w.players.keys()) cmds.set(pid, { seq: i + 1, ...(inputs.get(pid) ?? IDLE) });
    out.push(...stepWorld(w, cmds, FIXED_DT));
  }
  return out;
}

// A fresh open arena (server-shaped) with one player and their pet.
function arenaWithPet(kind: Pet["kind"]): { w: WorldState; p: PlayerSim; pet: Pet } {
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const p = spawnPlayerInWorld(w, "pA");
  const pet = spawnPetInWorld(w, "pA", kind)!;
  return { w, p, pet };
}

function isWallAt(w: WorldState, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

// A wall tile with open floor on BOTH horizontal sides, from a real generated dungeon —
// the geometry the wall-safety assertions (wisp pull, stuck teleport) need.
function findWallGap(w: WorldState): { tx: number; ty: number } {
  const d = w.dungeon;
  for (let ty = 1; ty < d.h - 1; ty++) {
    for (let tx = 2; tx < d.w - 2; tx++) {
      if (d.tiles[ty * d.w + tx] === 1 && d.tiles[ty * d.w + tx - 1] === 0 && d.tiles[ty * d.w + tx + 1] === 0) {
        return { tx, ty };
      }
    }
  }
  throw new Error("no floor|wall|floor column in this dungeon seed");
}

function unlockTests(): void {
  section("unlock requirements: exact milestones, pure + idempotent evaluation");
  const none = { deepestFloor: 0, deepestBossKill: 0 };
  check("fresh account unlocks nothing", petUnlocksFor(none).length === 0);
  check("floor 7 alone unlocks nothing (wisp needs 8, pup/bird need boss kills)",
    petUnlocksFor({ deepestFloor: 7, deepestBossKill: 0 }).length === 0);
  const firstBoss = petUnlocksFor({ deepestFloor: 5, deepestBossKill: 5 });
  check("defeating the Slime King (floor 5) unlocks EXACTLY the Ember Pup",
    firstBoss.length === 1 && firstBoss[0] === "ember_pup", JSON.stringify(firstBoss));
  check("dying ON the boss floor after the kill still counts (kill != descend)",
    isPetUnlocked("ember_pup", { deepestFloor: 5, deepestBossKill: 5 }));
  const deep = petUnlocksFor({ deepestFloor: 8, deepestBossKill: 5 });
  check("reaching floor 8 (The Deep) adds the Lantern Wisp", deep.includes("lantern_wisp") && deep.length === 2);
  const all = petUnlocksFor({ deepestFloor: 11, deepestBossKill: 10 });
  check("the floor-10 Slime King completes the roster", all.length === PET_KINDS.length);
  check("boss kill at 10 without floor 8?? impossible in play, but evaluation stays per-requirement",
    petUnlocksFor({ deepestFloor: 0, deepestBossKill: 10 }).includes("bonebird"));
  check("evaluation is idempotent (same stats -> same set)",
    JSON.stringify(petUnlocksFor(all.length ? { deepestFloor: 11, deepestBossKill: 10 } : none))
    === JSON.stringify(petUnlocksFor({ deepestFloor: 11, deepestBossKill: 10 })));
  check("isPetKind accepts the roster and rejects junk",
    PET_KINDS.every(isPetKind) && !isPetKind("dragon") && !isPetKind(42) && !isPetKind(null));
}

function capTests(): void {
  section("bounded power: the balance table can never exceed the pet caps");
  const pup = PET_BALANCE.ember_pup;
  const pupDps = (pup.nipDamage + pup.burnSecs * BURN_DMG_STACK) / pup.nipCd;
  check("ember pup nominal DPS (nip + full burn) under the cap",
    pupDps <= PET_CAPS.sustainedDps, `${pupDps.toFixed(3)} <= ${PET_CAPS.sustainedDps}`);
  const bird = PET_BALANCE.bonebird;
  check("bonebird nominal DPS under the cap",
    bird.peckDamage / bird.peckCd <= PET_CAPS.sustainedDps, `${(bird.peckDamage / bird.peckCd).toFixed(3)}`);
  check("mark multiplier under the utility cap", bird.markDamageMult <= PET_CAPS.markDamageMult);
  const magnetLv1 = createMods();
  recomputeMods(magnetLv1, ["coin_magnet"]);
  check("wisp coin pull at-or-under the cap AND weaker than Coin Magnet Lv1",
    PET_BALANCE.lantern_wisp.pullSpeed <= PET_CAPS.coinPullSpeed && PET_BALANCE.lantern_wisp.pullSpeed < magnetLv1.coinMagnetPull,
    `wisp=${PET_BALANCE.lantern_wisp.pullSpeed} magnetLv1=${magnetLv1.coinMagnetPull}`);
}

function lifecycleTests(): void {
  section("lifecycle: one pet per player, replace on re-equip, removed with its owner");
  const w = createWorld(0xF00D, 1, { isSandbox: true, skipLocalPlayer: true });
  check("spawning for a missing owner no-ops", spawnPetInWorld(w, "ghost", "ember_pup") === null);
  spawnPlayerInWorld(w, "pA");
  spawnPetInWorld(w, "pA", "ember_pup");
  const wisp = spawnPetInWorld(w, "pA", "lantern_wisp");
  check("re-equip replaces, never stacks", w.pets.size === 1 && w.pets.get("pA")?.kind === "lantern_wisp");
  check("replacement got a fresh id", wisp !== null && wisp.id === 1);
  removePlayerFromWorld(w, "pA");
  check("the pet leaves with its owner (disconnect path)", w.pets.size === 0);
}

function followTests(): void {
  section("follow: deterministic damped-spring heel, never inside a wall");
  const record = (): string => {
    const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
    spawnPlayerInWorld(w, "pA");
    const pet = spawnPetInWorld(w, "pA", "ember_pup")!;
    const stream: number[] = [];
    const inputs = new Map<PlayerId, Omit<InputCmd, "seq">>([["pA", { ...IDLE, moveX: 1, moveY: 0.4 }]]);
    for (let i = 0; i < 200; i++) {
      run(w, 1, inputs);
      stream.push(pet.x, pet.y, pet.vx, pet.vy);
    }
    return JSON.stringify(stream);
  };
  check("two identical runs produce bit-identical pet motion", record() === record());

  const { w, p, pet } = arenaWithPet("bonebird");
  const inputs = new Map<PlayerId, Omit<InputCmd, "seq">>([["pA", { ...IDLE, moveX: 1 }]]);
  let maxDist = 0;
  let wallHits = 0;
  for (let i = 0; i < 240; i++) {
    run(w, 1, inputs);
    maxDist = Math.max(maxDist, Math.hypot(pet.x - p.x, pet.y - p.y));
    if (isWallAt(w, pet.x, pet.y)) wallHits++;
  }
  check("pet keeps pace with a running owner (never left behind)", maxDist < 120, `maxDist=${maxDist.toFixed(1)}`);
  check("pet center never entered a wall tile", wallHits === 0);
  check("pet faces its direction of travel", pet.facing === 1);
}

function separationTests(): void {
  section("separation: a full party's pets fan out instead of stacking");
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const pets: Pet[] = [];
  for (const pid of ["pA", "pB", "pC", "pD"]) {
    const p = spawnPlayerInWorld(w, pid);
    p.x = 840; p.y = 600; // stack all owners on one spot — worst case
    pets.push(spawnPetInWorld(w, pid, "ember_pup")!);
  }
  run(w, 60); // 3s to settle
  let minPair = Infinity;
  for (let i = 0; i < pets.length; i++) {
    for (let j = i + 1; j < pets.length; j++) {
      minPair = Math.min(minPair, Math.hypot(pets[i].x - pets[j].x, pets[i].y - pets[j].y));
    }
  }
  check("pets keep visible spacing", minPair >= PET_BALANCE.separation * 0.45, `minPair=${minPair.toFixed(1)}`);
  check("no NaN escaped the spring math", pets.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y)));
}

function nonBlockingTests(): void {
  section("pets block nothing: players walk straight through them");
  const { w, p, pet } = arenaWithPet("ember_pup");
  pet.x = p.x + 24; pet.y = p.y; // parked dead ahead
  const x0 = p.x;
  run(w, 20, new Map([["pA", { ...IDLE, moveX: 1 }]]));
  // 20 ticks at base 200 px/s = 200px; any pet collision would have cost distance.
  check("owner's path is unimpeded by the pet", p.x - x0 > 195, `moved=${(p.x - x0).toFixed(1)}`);
}

function emberPupTests(): void {
  section("ember pup: leash-ranged nip with a short singe, credited like the owner's damage");
  const { w, p } = arenaWithPet("ember_pup");
  const e = devSpawnEnemy(w, "skeleton", p.x + 70, p.y);
  e.hp = e.maxHp = 50;
  const ev = run(w, Math.ceil(1.5 / FIXED_DT)); // spawn grace + approach + first nip
  const hit = ev.find((x) => x.t === "enemyHit");
  check("the pup nipped within the first engage window", hit !== undefined && e.hp < 50, `hp=${e.hp}`);
  check("the nip applied its burn", e.burn > 0 || e.burnDmg > 0 || ev.some((x) => x.t === "burnTick"));
  check("burn attribution is the owner", e.burnOwner === "pA");

  // Kill credit: a lethal nip credits the owner's kills/combo exactly like their own shot.
  const { w: w2, p: p2 } = arenaWithPet("ember_pup");
  const weak = devSpawnEnemy(w2, "slime", p2.x + 60, p2.y);
  weak.hp = 1;
  const ev2 = run(w2, Math.ceil(2 / FIXED_DT));
  check("lethal nip credits the owner's kill + combo", p2.kills === 1 && p2.combo >= 1, `kills=${p2.kills}`);
  check("the kill resolved through the standard event", ev2.some((x) => x.t === "enemyKill"));

  // Leash: an enemy beyond the owner's engage range is ignored.
  const { w: w3, p: p3 } = arenaWithPet("ember_pup");
  const far = devSpawnEnemy(w3, "slime", p3.x + PET_BALANCE.ember_pup.engageRange + 120, p3.y);
  far.speed = 0; // hold it in place: outside the leash it must never be engaged
  run(w3, Math.ceil(4 / FIXED_DT));
  check("enemies beyond the owner leash are ignored", far.hp === far.maxHp);
}

function pupDpsMeasurement(): number {
  section("ember pup: measured sustained DPS respects the cap (30s live sim)");
  const { w, p } = arenaWithPet("ember_pup");
  w.isGodMode = true; // the dummy fights back; the measurement is about pet output
  const dummy = devSpawnEnemy(w, "skeleton", p.x + 50, p.y);
  dummy.hp = dummy.maxHp = 10_000;
  const secs = 30;
  run(w, Math.ceil(secs / FIXED_DT));
  const dps = (dummy.maxHp - dummy.hp) / secs;
  check("pup lands sustained damage (it is not decorative)", dps > 0.5, `dps=${dps.toFixed(3)}`);
  check("pup sustained DPS is under the cap", dps <= PET_CAPS.sustainedDps, `${dps.toFixed(3)} <= ${PET_CAPS.sustainedDps}`);
  return dps;
}

function bonebirdTests(): { dps: number; markUptime: number } {
  section("bonebird: LOS-gated peck projectile that marks its target for team bonus damage");
  const { w, p, pet } = arenaWithPet("bonebird");
  const e = devSpawnEnemy(w, "skeleton", p.x + 200, p.y);
  e.hp = e.maxHp = 50;
  e.speed = 0; // parked target: clean flight-path assertions
  let sawPeck = false;
  for (let i = 0; i < Math.ceil(2 / FIXED_DT) && e.hp === 50; i++) {
    run(w, 1);
    if (pet.peck) sawPeck = true;
  }
  check("a peck projectile flew", sawPeck);
  check("the peck hit for its damage", e.hp === 50 - PET_BALANCE.bonebird.peckDamage, `hp=${e.hp}`);
  check("the hit marked the target", e.petMark > 0, `mark=${e.petMark.toFixed(2)}`);
  check("the peck expired on impact", pet.peck === null);

  // The mark amplifies PLAYER strikes only. Two identical enemies, identical bullets; the
  // marked one takes exactly the multiplier more.
  const wAmp = createWorld(0xA11CE, 1, { isSandbox: true, skipLocalPlayer: true });
  const shooter = spawnPlayerInWorld(wAmp, "pS");
  const plain = devSpawnEnemy(wAmp, "skeleton", shooter.x + 300, shooter.y - 100);
  const marked = devSpawnEnemy(wAmp, "skeleton", shooter.x + 300, shooter.y + 100);
  plain.hp = plain.maxHp = marked.hp = marked.maxHp = 20;
  marked.petMark = 2;
  const shot = (target: { x: number; y: number }): Bullet => ({
    x: target.x, y: target.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
    owner: "pS", damage: 2, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  });
  wAmp.bullets.push(shot(plain), shot(marked));
  run(wAmp, 1);
  const plainDmg = 20 - plain.hp;
  const markedDmg = 20 - marked.hp;
  check("marked target takes the team bonus", Math.abs(markedDmg - plainDmg * PET_BALANCE.bonebird.markDamageMult) < 1e-9,
    `plain=${plainDmg} marked=${markedDmg}`);
  // And pet damage itself is never amplified: a nip on a marked enemy deals base damage.
  const wPet = createWorld(0xA11CF, 1, { isSandbox: true, skipLocalPlayer: true });
  const owner2 = spawnPlayerInWorld(wPet, "pA");
  spawnPetInWorld(wPet, "pA", "ember_pup");
  const markedForPet = devSpawnEnemy(wPet, "skeleton", owner2.x + 60, owner2.y);
  markedForPet.hp = markedForPet.maxHp = 50;
  markedForPet.petMark = 60;
  markedForPet.speed = 0;
  const evPet = run(wPet, Math.ceil(2 / FIXED_DT));
  const petHit = evPet.find((x) => x.t === "enemyHit");
  check("pet damage ignores the mark (no pet-compounding)",
    petHit !== undefined && petHit.t === "enemyHit" && petHit.dmg === PET_BALANCE.ember_pup.nipDamage, `dmg=${petHit?.t === "enemyHit" ? petHit.dmg : "none"}`);

  // Mark expiry.
  const eShort = devSpawnEnemy(wAmp, "slime", shooter.x + 500, shooter.y);
  eShort.petMark = 0.1;
  run(wAmp, 4);
  check("the mark expires", eShort.petMark === 0);

  // Utility measurement: mark uptime on a single hostile over 30s, plus bird DPS.
  const { w: wU, p: pU } = arenaWithPet("bonebird");
  wU.isGodMode = true;
  const dummy = devSpawnEnemy(wU, "skeleton", pU.x + 150, pU.y);
  dummy.hp = dummy.maxHp = 10_000;
  const secs = 30;
  let markedTicks = 0;
  const ticks = Math.ceil(secs / FIXED_DT);
  for (let i = 0; i < ticks; i++) {
    run(wU, 1);
    if (dummy.petMark > 0) markedTicks++;
  }
  const dps = (dummy.maxHp - dummy.hp) / secs;
  const markUptime = markedTicks / ticks;
  check("bird sustained DPS is under the cap", dps <= PET_CAPS.sustainedDps, `dps=${dps.toFixed(3)}`);
  check("the mark holds most of the fight on a focused target", markUptime > 0.7, `uptime=${(markUptime * 100).toFixed(0)}%`);
  return { dps, markUptime };
}

function wispTests(): void {
  section("lantern wisp: modest coin assist toward the owner, wall-safe, coins only");
  const { w, p } = arenaWithPet("lantern_wisp");
  w.pickups.push({ id: w.nextPickupId++, kind: "coin", x: p.x + 100, y: p.y, radius: 13, weapon: null });
  w.pickups.push({ id: w.nextPickupId++, kind: "heart", x: p.x + 100, y: p.y + 40, radius: 13, weapon: null });
  const heart = w.pickups[1];
  const heartX = heart.x;
  const coins0 = p.coins;
  run(w, Math.ceil(2 / FIXED_DT));
  check("a coin inside the wisp's light drifts in and collects", p.coins > coins0, `coins=${p.coins}`);
  check("hearts (non-coins) are never pulled", heart.x === heartX);

  // Wall safety: a coin on the far side of a real wall is never dragged through it.
  const wd = createWorld(0xC0FFEE, 1, { skipLocalPlayer: true });
  const owner = spawnPlayerInWorld(wd, "pA");
  const gap = findWallGap(wd);
  owner.x = (gap.tx + 1.5) * TILE + 10; // open floor right of the wall
  owner.y = (gap.ty + 0.5) * TILE;
  const wisp = spawnPetInWorld(wd, "pA", "lantern_wisp")!;
  wisp.x = owner.x; wisp.y = owner.y;
  const wallRightEdge = (gap.tx + 1) * TILE;
  wd.pickups.length = 0;
  wd.enemies.length = 0; wd.pendingSpawns.length = 0; // a clear floor: nothing else moves coins
  wd.pickups.push({ id: 999, kind: "coin", x: (gap.tx - 0.5) * TILE, y: owner.y, radius: 13, weapon: null });
  const coin = wd.pickups[0];
  let crossed = false;
  for (let i = 0; i < Math.ceil(3 / FIXED_DT); i++) {
    run(wd, 1);
    if (coin.x >= wallRightEdge - 13 || isWallAt(wd, coin.x, coin.y)) crossed = true;
  }
  check("the pull can never drag a coin through a wall", !crossed, `coinX=${coin.x.toFixed(1)} wallEdge=${wallRightEdge}`);
}

function teleportTests(): void {
  section("safe teleport: separated or wedged pets reappear beside the owner on open floor");
  // Distance failsafe: the owner crosses the map (descend-like displacement).
  const w = createWorld(0xC0FFEE, 1, { skipLocalPlayer: true });
  const p = spawnPlayerInWorld(w, "pA");
  const pet = spawnPetInWorld(w, "pA", "ember_pup")!;
  w.enemies.length = 0; w.pendingSpawns.length = 0;
  const room = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  p.x = (room.cx + 0.5) * TILE;
  p.y = (room.cy + 0.5) * TILE;
  const ev = run(w, 2);
  const tp = ev.find((x) => x.t === "petTeleport");
  check("a petTeleport event fired", tp !== undefined);
  check("the pet landed beside its owner", Math.hypot(pet.x - p.x, pet.y - p.y) < 80, `d=${Math.hypot(pet.x - p.x, pet.y - p.y).toFixed(1)}`);
  const r = PET_BALANCE.radius;
  const isOpen = !isWallAt(w, pet.x, pet.y) && !isWallAt(w, pet.x - r, pet.y) && !isWallAt(w, pet.x + r, pet.y)
    && !isWallAt(w, pet.x, pet.y - r) && !isWallAt(w, pet.x, pet.y + r);
  check("the landing spot is clearance-checked open floor", isOpen);
  check("the landing spot is outside every live prop",
    w.props.every((pr) => pr.dead || Math.hypot(pet.x - pr.x, pet.y - pr.y) >= pr.radius * 0.8 + r));
  check("the event carries both ends for the puff", tp?.t === "petTeleport" && Number.isFinite(tp.ox) && Number.isFinite(tp.x));

  // Stuck failsafe: owner within teleportDist but a wall wedges the path — the patience
  // timer trips instead of the distance snap.
  const w2 = createWorld(0xC0FFEE, 1, { skipLocalPlayer: true });
  const p2 = spawnPlayerInWorld(w2, "pB");
  w2.enemies.length = 0; w2.pendingSpawns.length = 0;
  const gap = findWallGap(w2);
  p2.x = (gap.tx + 1.5) * TILE + 40;
  p2.y = (gap.ty + 0.5) * TILE;
  const pet2 = spawnPetInWorld(w2, "pB", "ember_pup")!;
  pet2.x = (gap.tx - 0.5) * TILE - 40; // wrong side of the wall, ~170px away: > stuckFarDist, < teleportDist
  pet2.y = p2.y;
  const dist0 = Math.hypot(pet2.x - p2.x, pet2.y - p2.y);
  check("scenario holds the stuck window (not the distance snap)",
    dist0 > PET_BALANCE.stuckFarDist && dist0 < PET_BALANCE.teleportDist, `d=${dist0.toFixed(0)}`);
  const ev2 = run(w2, Math.ceil((PET_BALANCE.stuckAfter + 1.2) / FIXED_DT));
  check("the wedged pet teleported within the patience threshold", ev2.some((x) => x.t === "petTeleport"));
  check("it landed beside the owner", Math.hypot(pet2.x - p2.x, pet2.y - p2.y) < 80);
}

function ownerStateTests(): void {
  section("owner state: pets pause while their owner is down/choosing, resume on revive");
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "pA");
  const b = spawnPlayerInWorld(w, "pB");
  b.x = a.x + 400; b.y = a.y;
  spawnPetInWorld(w, "pA", "ember_pup");
  const e = devSpawnEnemy(w, "skeleton", a.x + 60, a.y);
  e.hp = e.maxHp = 500;
  e.speed = 0;

  a.isDown = true; a.hp = 0; // downed with a standing ally (B): run continues
  run(w, Math.ceil(5 / FIXED_DT));
  check("a downed owner's pet starts no attacks", e.hp === 500, `hp=${e.hp}`);

  a.isDown = false; a.hp = 2; // revived
  run(w, Math.ceil(5 / FIXED_DT));
  check("the pet resumes after the revive", e.hp < 500, `hp=${e.hp}`);

  // A pending blessing pick pauses the pet exactly like it pauses the owner.
  const { w: w2, p: p2 } = arenaWithPet("ember_pup");
  const e2 = devSpawnEnemy(w2, "skeleton", p2.x + 60, p2.y);
  e2.hp = e2.maxHp = 500;
  e2.speed = 0;
  w2.pendingBlessings.set("pA", 60);
  run(w2, Math.ceil(5 / FIXED_DT));
  check("a mid-pick owner's pet holds fire", e2.hp === 500);
  w2.pendingBlessings.delete("pA");
  run(w2, Math.ceil(5 / FIXED_DT));
  check("the pet resumes once the pick resolves", e2.hp < 500);

  // An already-loosed peck finishes its flight even if the owner drops mid-flight.
  const { w: w3, p: p3, pet: bird } = arenaWithPet("bonebird");
  const ally = spawnPlayerInWorld(w3, "pC");
  ally.x = p3.x + 300; ally.y = p3.y + 300;
  const target = devSpawnEnemy(w3, "skeleton", p3.x + 240, p3.y);
  target.hp = target.maxHp = 50;
  target.speed = 0;
  let downed = false;
  for (let i = 0; i < Math.ceil(3 / FIXED_DT) && target.hp === 50; i++) {
    run(w3, 1);
    if (bird.peck && !downed) { p3.isDown = true; p3.hp = 0; downed = true; }
  }
  check("an in-flight peck still lands after the owner goes down", downed && target.hp < 50, `hp=${target.hp}`);
}

function floorTransitionTests(): void {
  section("floor transitions: pets ride the descend with their owners");
  const w = createWorld(0xC0FFEE, 1, { skipLocalPlayer: true });
  const p = spawnPlayerInWorld(w, "pA");
  const pet = spawnPetInWorld(w, "pA", "bonebird")!;
  pet.peck = { x: p.x, y: p.y, vx: 400, vy: 0, life: 0.8 };
  const ev: SimEvent[] = [];
  descend(w, 2, ev);
  check("the pet repositioned to the new spawn beside its owner", Math.hypot(pet.x - p.x, pet.y - p.y) < 60);
  check("the in-flight peck fizzled across the transition", pet.peck === null);
  check("pet ids stay stable across floors (client anim/interp keys)", pet.id === 0 && w.pets.get("pA") === pet);
}

function targetingDeterminismTests(): void {
  section("targeting: nearest enemy wins; array order breaks exact ties (deterministic)");
  const { w, p } = arenaWithPet("bonebird");
  const near = devSpawnEnemy(w, "skeleton", p.x - 180, p.y);   // nearer by 20px
  const farther = devSpawnEnemy(w, "skeleton", p.x + 200, p.y);
  near.hp = near.maxHp = farther.hp = farther.maxHp = 50;
  near.speed = 0; farther.speed = 0;
  for (let i = 0; i < Math.ceil(3 / FIXED_DT) && near.hp === 50 && farther.hp === 50; i++) run(w, 1);
  check("the nearer enemy was pecked first", near.hp < 50 && farther.hp === 50, `near=${near.hp} far=${farther.hp}`);
}

function main(): void {
  unlockTests();
  capTests();
  lifecycleTests();
  followTests();
  separationTests();
  nonBlockingTests();
  emberPupTests();
  const pupDps = pupDpsMeasurement();
  const bird = bonebirdTests();
  wispTests();
  teleportTests();
  ownerStateTests();
  floorTransitionTests();
  targetingDeterminismTests();

  process.stdout.write(`\n[measured balance — for the ship notes]\n`);
  process.stdout.write(`  ember pup sustained DPS: ${pupDps.toFixed(3)} (cap ${PET_CAPS.sustainedDps})\n`);
  process.stdout.write(`  bonebird sustained DPS: ${bird.dps.toFixed(3)} (cap ${PET_CAPS.sustainedDps})\n`);
  process.stdout.write(`  bonebird mark uptime (focused target): ${(bird.markUptime * 100).toFixed(0)}% at +${Math.round((PET_BALANCE.bonebird.markDamageMult - 1) * 100)}% player damage\n`);
  process.stdout.write(`  lantern wisp pull: ${PET_BALANCE.lantern_wisp.pullSpeed} px/s within ${PET_BALANCE.lantern_wisp.pullRadius}px (Coin Magnet Lv1: 240 px/s at 90px)\n`);

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll companion-pet assertions passed.\n");
}

main();
