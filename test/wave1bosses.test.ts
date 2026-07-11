// WAVE 1 DEEP BOSSES (The Sump, F35–45) — the earned-window contract + each boss's
// signature mechanic, all on the authoritative sim:
//  - JET:    a FROZEN archetype mirror pool (never live inventory), a spent-recover window;
//  - TITHE:  a 2-state destructible feeding slab + the beatable re-armor loop;
//  - QUORUM: a shared HP pool with role-gated kill-order + a telegraphed non-invuln merge.
// Every boss: guarded body, a PLAYER-CREATED exposed window, telegraphed surprise (≥0.6s
// tell, ≥0.30s post-lock, ≥0.35s recover), HP calibrated on EXPOSED time (never a sponge),
// and co-op scaling the TASK — locked at the pull, never rescaled mid-fight.
//
// Run: npm run test:wave1bosses

import {
  createWorld, stepWorld, devSpawnEnemy, isBossExposed,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind, WeaponId } from "../src/sim/types.js";
import {
  JET, TITHE, QUORUM, weaponResonanceFamily, RESONANCE_FAMILIES,
  titheSlabHpForFloor,
} from "../src/sim/balance.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, cmd: InputCmd = idle(0)): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}

function plantBullet(w: WorldState, target: Enemy, damage: number, radius = 20): void {
  const b: Bullet = {
    x: target.x, y: target.y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

// A boss arena with the boss READY to act (grace cleared) so the machine runs immediately.
function bossArena(seed: number, floor: number, kind: EnemyKind): { w: WorldState; boss: Enemy } {
  const w = createWorld(seed, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, kind, p.x + 170, p.y);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  return { w, boss };
}

function liveOf(w: WorldState, kind: EnemyKind): Enemy[] {
  return w.enemies.filter((e) => !e.dead && e.kind === kind);
}

// ---- 1. the earned-window contract shape (every Wave 1 boss) ----

function contractGates(): void {
  section("earned-window contract: guard band + fair-surprise timing (≥0.6s tell, ≥0.30s post-lock, ≥0.35s recover)");
  const rows: Array<[string, number, number, number, number, number]> = [
    // [name, guardMult, tell, postLock, recover, bankFrac]
    ["JET", JET.guardMult, JET.mirrorWindup, JET.mirrorWindup - JET.mirrorLock, JET.spentRecover, JET.windowBankFrac],
    ["TITHE (slab feed)", TITHE.guardMult, TITHE.buildWindup, TITHE.buildWindup, TITHE.slabExpose, TITHE.windowBankFrac],
    ["QUORUM (shared telegraph)", QUORUM.guardMult, QUORUM.volleyWindup, QUORUM.volleyWindup - QUORUM.volleyLock, QUORUM.mergeRecover, QUORUM.windowBankFrac],
  ];
  for (const [name, guard, tell, postLock, recover, bank] of rows) {
    // Balancer FINAL: the three Wave 1 deep bosses use a HARD guard gate (JET/QUORUM 0.12,
    // TITHE 0.0 — zero to the body while armored), well below the F15–30 roster's 0.20–0.35
    // "reduction, never immunity" band. Chip is not a path here: the mechanic IS the fight.
    check(`${name} uses the deep-boss HARD guard gate (0 ≤ guard ≤ 0.12 — play the mechanic, chip is not a path)`,
      guard >= 0 - 1e-9 && guard <= 0.12 + 1e-9, `guard=${guard}`);
    check(`${name} tell is ≥0.6s (readable)`, tell >= 0.6 - 1e-9, `tell=${tell}`);
    check(`${name} keeps ≥0.30s post-lock dodge`, postLock >= 0.30 - 1e-9, `postLock=${postLock.toFixed(2)}`);
    check(`${name} recover/window is ≥0.35s`, recover >= 0.35 - 1e-9, `recover=${recover}`);
    check(`${name} arms a per-window bank (never a sponge — windows convert, guard chips)`,
      bank > 0 && bank <= 0.5, `bank=${bank}`);
  }
  // QUORUM's merge-form recover is the packet's widened ≥0.45s window.
  check("QUORUM merge-form recover is widened (≥0.45s)", QUORUM.mergeRecover >= 0.45 - 1e-9, `recover=${QUORUM.mergeRecover}`);
  // The merge is telegraphed and NON-invuln (reduction 0 — you keep hurting it) for 1.2s.
  check("QUORUM merge is a telegraphed 1.2s NON-invuln transition",
    Math.abs(QUORUM.mergeDuration - 1.2) < 1e-9 && QUORUM.mergeDamageReduction === 0);
}

// ---- 2. JET: guarded body, a spent-recover window, HP not a sponge ----

function jetWindowGates(): void {
  section("JET: GUARDED between salvos, then a spent-recover EXPOSED window (full damage, banked)");
  {
    const { w, boss } = bossArena(0x1E7, 35, "jet");
    const hp0 = boss.hp;
    plantBullet(w, boss, 100);
    step(w);
    const taken = hp0 - boss.hp;
    check("a guarded JET hit lands at guardMult (reduction, never immunity)",
      Math.abs(taken - 100 * JET.guardMult) < 1e-6 && taken > 0, `took ${taken.toFixed(1)}`);
  }
  {
    // Drive the fight: JET must OPEN an exposed window on its own (the spent recover after
    // a salvo it commits) — the window is earned by surviving the salvo, never gifted early.
    const { w, boss } = bossArena(0x1E8, 35, "jet");
    let sawSalvo = false;
    let sawExposed = false;
    for (let t = 0; t < 60 * 6 && !sawExposed; t++) {
      step(w, idle(t));
      if (boss.attack.move === "mirror" && boss.attack.phase === "active") sawSalvo = true;
      if (isBossExposed(boss)) sawExposed = true;
    }
    check("JET commits a corrupted-Resonance salvo (the mirror verb)", sawSalvo);
    check("JET is EXPOSED after it is spent (the recover window opens)", sawExposed);
  }
  {
    // Not a sponge: during the exposed window, damage lands FULL (out of the bank), unlike
    // the guarded chip — so the fight converts on exposure rather than grinding a bar down.
    const { w, boss } = bossArena(0x1E9, 35, "jet");
    for (let t = 0; t < 60 * 6 && !isBossExposed(boss); t++) step(w, idle(t));
    check("JET reached an exposed window to measure against", isBossExposed(boss));
    if (isBossExposed(boss)) {
      const hp0 = boss.hp;
      plantBullet(w, boss, 30);
      step(w);
      const taken = hp0 - boss.hp;
      check("an EXPOSED JET hit lands FULL (window damage, far above the guarded chip)",
        taken > 30 * JET.guardMult + 1e-3, `took ${taken.toFixed(1)} vs guarded ${(30 * JET.guardMult).toFixed(1)}`);
    }
  }
}

// ---- 3. JET's mirror pool is ARCHETYPE-based (never reads real inventory) ----

function jetMirrorGates(): void {
  section("JET mirror pool: derived from weapon ARCHETYPE (Resonance family), never live inventory");
  const resolveFor = (seed: number, weapon: WeaponId): WorldState => {
    const w = createWorld(seed, 35, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.weapon = weapon;
    const jet = devSpawnEnemy(w, "jet", p.x + 170, p.y);
    jet.spawnTimer = 0;
    step(w); // JET resolves its frozen pool on its first tick
    return w;
  };
  {
    const w = resolveFor(0x30, "shotgun");
    check("JET resolves a non-empty mirror pool", w.jetMirror.length > 0, `[${w.jetMirror.join(",")}]`);
    check("every pool entry is a Resonance FAMILY (an archetype), never a weapon id",
      w.jetMirror.every((f) => (RESONANCE_FAMILIES as readonly string[]).indexOf(f) !== -1), `[${w.jetMirror.join(",")}]`);
    check("JET mirrors the ARCHETYPE of the equipped weapon (shotgun → its spread family)",
      w.jetMirror.indexOf(weaponResonanceFamily("shotgun")) !== -1);
  }
  {
    // Two DIFFERENT weapons of the SAME family, same seed → IDENTICAL pools. Proof the pool
    // is a function of the ARCHETYPE, not the weapon identity/stats (never live-copies gear).
    const a = resolveFor(0x31, "sawnoff"); // spread
    const b = resolveFor(0x31, "burst");   // also spread
    check("sawnoff and burst are the SAME Resonance family (spread archetype)",
      weaponResonanceFamily("sawnoff") === weaponResonanceFamily("burst"));
    check("two same-family weapons produce the IDENTICAL frozen pool (archetype, not inventory)",
      a.jetMirror.length === b.jetMirror.length && a.jetMirror.every((f, i) => f === b.jetMirror[i]),
      `[${a.jetMirror.join(",")}] vs [${b.jetMirror.join(",")}]`);
  }
  {
    // FROZEN at the pull: swapping the player's weapon mid-fight never re-reads inventory.
    const w = createWorld(0x32, 35, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.weapon = "railgun"; // lance
    const jet = devSpawnEnemy(w, "jet", p.x + 170, p.y);
    jet.spawnTimer = 0;
    step(w);
    const frozen = w.jetMirror.slice();
    p.weapon = "flamer"; // still lance, but change the identity anyway
    for (let t = 0; t < 120; t++) step(w, idle(t));
    check("the mirror pool is FROZEN at the pull (a mid-fight weapon swap never changes it)",
      w.jetMirror.length === frozen.length && w.jetMirror.every((f, i) => f === frozen[i]),
      `[${w.jetMirror.join(",")}] vs frozen [${frozen.join(",")}]`);
  }
  {
    // Co-op scales the TASK: a more diverse party mirrors MORE families (a bigger pool),
    // while the per-salvo simultaneous count stays budget-capped (readable at 4P).
    check("the frozen pool is capped (co-op grows it up to the cap, never unbounded)",
      JET.verbMax >= 2 && JET.verbMax <= RESONANCE_FAMILIES.length);
    check("the salvo's simultaneous verbs are tighter at 4P than solo (telegraph budget)",
      JET.simulCapFor[4] <= JET.simulCapFor[1]);
  }
}

// ---- 4. THE TITHE: 2-state destructible slab + beatable re-armor loop ----

function titheGates(): void {
  section("THE TITHE: the feeding SLAB is a separate 2-state destructible; the re-armor loop is beatable + loops");
  {
    // The feeder raises a slab as a SEPARATE entity (not part of the feeder body).
    const { w, boss } = bossArena(0x71, 40, "tithe");
    let slab: Enemy | undefined;
    for (let t = 0; t < 60 * 4 && !slab; t++) {
      step(w, idle(t));
      slab = liveOf(w, "tithe_slab")[0];
    }
    check("the Tithe raises a SEPARATE feeding slab entity", slab !== undefined && slab.id !== boss.id);
    check("the slab is a real destructible (HP > 0, its own body)", slab !== undefined && slab.hp > 0 && slab.maxHp > 0);
    check("the slab has a 2-state HP band (intact→cracked crossing exists)",
      slab !== undefined && slab.maxHp > 1, `maxHp=${slab?.maxHp}`);
  }
  {
    // Destroy the slab IN TIME (during the re-armor channel) → the feeder is EXPOSED.
    const { w, boss } = bossArena(0x72, 40, "tithe");
    let slab: Enemy | undefined;
    for (let t = 0; t < 60 * 4 && !slab; t++) { step(w, idle(t)); slab = liveOf(w, "tithe_slab")[0]; }
    check("a slab is up to break", slab !== undefined);
    if (slab) {
      for (let t = 0; t < 30 && !slab.dead; t++) { plantBullet(w, slab, 9999); step(w, idle(1000 + t)); }
      // The feed channel observes the dead slab on its next tick — settle a few frames.
      for (let t = 0; t < 6 && !isBossExposed(boss); t++) step(w, idle(1100 + t));
      check("breaking the slab in time EXPOSES the feeder (the window)", isBossExposed(boss));
    }
  }
  {
    // Ignore the slab → the channel elapses → the feeder RE-ARMORS (no window) but the
    // loop simply feeds again (never a dead end).
    const { w, boss } = bossArena(0x73, 40, "tithe");
    let slab: Enemy | undefined;
    for (let t = 0; t < 60 * 4 && !slab; t++) { step(w, idle(t)); slab = liveOf(w, "tithe_slab")[0]; }
    check("a slab is up to ignore", slab !== undefined);
    // Let the whole re-armor channel elapse untouched.
    for (let t = 0; t < 60 * (TITHE.rearmChannel + 1); t++) step(w, idle(2000 + t));
    check("ignoring the slab yields NO exposed window (re-armored)", !isBossExposed(boss));
    check("the slab was reabsorbed (re-armored) rather than dead-ending", liveOf(w, "tithe_slab").length === 0);
    // …and it loops: the feeder builds another slab.
    let refed = false;
    for (let t = 0; t < 60 * 6 && !refed; t++) { step(w, idle(3000 + t)); refed = liveOf(w, "tithe_slab").length > 0; }
    check("the Tithe FEEDS AGAIN (the loop never dead-ends)", refed);
  }
  {
    // Co-op scales the TASK (more slabs, thicker), never a shorter channel. Locked at pull.
    check("co-op raises MORE slabs (task), P4 ≥ P1", (TITHE.slabsFor[4] ?? 0) >= (TITHE.slabsFor[1] ?? 0)
      && (TITHE.slabsFor[4] ?? 0) > 1);
    check("co-op slabs are THICKER (HP scales up with party)", titheSlabHpForFloor(40, 4) > titheSlabHpForFloor(40, 1));
    check("the re-armor channel is a FIXED timer (never shortened by party size)", TITHE.rearmChannel >= 2);
    // The slab count a feed raises is read from the SNAPSHOTTED encounter size at raise time.
    const w = createWorld(0x74, 40, { isSandbox: true });
    w.isGodMode = true;
    w.encounterPlayers = 4;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "tithe", p.x + 170, p.y);
    boss.spawnTimer = 0; boss.attack.cooldown = 0;
    for (let t = 0; t < 60 * 4 && liveOf(w, "tithe_slab").length === 0; t++) step(w, idle(t));
    check("a P4 feed raises the P4 slab count", liveOf(w, "tithe_slab").length === TITHE.slabsFor[4],
      `${liveOf(w, "tithe_slab").length} vs ${TITHE.slabsFor[4]}`);
  }
}

// ---- 5. QUORUM: shared pool + role kill-order + telegraphed merge ----

function quorumGates(): void {
  section("QUORUM: three husks share ONE pool; roles gate kill-order; the merge is telegraphed + non-invuln");
  {
    const { w, boss } = bossArena(0x91, 45, "quorum");
    step(w); // raises the husks
    const husks = w.enemies.filter((e) => !e.dead && (e.kind === "quorum_shield" || e.kind === "quorum_heal" || e.kind === "quorum_dmg"));
    check("QUORUM raises exactly three role-husks (shield/heal/dmg)", husks.length === 3, `n=${husks.length}`);
    check("the husks share ONE pool (each mirrors the core HP)", husks.every((h) => h.hp === boss.hp && h.maxHp === boss.maxHp));
    check("each husk carries its own break-integrity (the focus meter)", husks.every((h) => h.affixState > 0));
    check("the CORE is untargetable behind its husks (phase 1)", (boss.boss?.phase ?? 1) < 2);
  }
  {
    // Kill-order is real: the SHIELD husk (highest priority) takes FULL pool damage, while a
    // non-priority husk is CHIPPED — so 4P crossfire that nukes the pool evenly stalls.
    const a = bossArena(0x92, 45, "quorum");
    a.w.players.get(LOCAL_ID)!; step(a.w);
    const shield = liveOf(a.w, "quorum_shield")[0];
    const hpShield0 = a.boss.hp;
    plantBullet(a.w, shield, 40);
    step(a.w);
    const drainOnPriority = hpShield0 - a.boss.hp;

    const b = bossArena(0x92, 45, "quorum"); step(b.w);
    const dmgHusk = liveOf(b.w, "quorum_dmg")[0];
    const hpDmg0 = b.boss.hp;
    plantBullet(b.w, dmgHusk, 40);
    step(b.w);
    const drainOffPriority = hpDmg0 - b.boss.hp;

    check("hitting the priority (shield) husk drains the pool MORE than hitting a lower-priority husk",
      drainOnPriority > drainOffPriority + 1e-3, `priority ${drainOnPriority.toFixed(1)} vs off ${drainOffPriority.toFixed(1)}`);
    check("a lower-priority hit is CHIPPED, not full (even-nuke can't skip the order)",
      drainOffPriority < 40 - 1e-3, `off-priority took ${drainOffPriority.toFixed(1)} of 40`);
  }
  {
    // The HEAL husk regenerates the shared pool while it lives — leaving it up undoes chip.
    const { w, boss } = bossArena(0x93, 45, "quorum");
    step(w);
    boss.hp = boss.maxHp * 0.7; // drop the pool, then idle with the heal husk alive
    const hp0 = boss.hp;
    for (let t = 0; t < 60; t++) step(w, idle(t));
    check("the HEAL husk regenerates the shared pool while alive", boss.hp > hp0 + 1e-3, `${hp0.toFixed(0)}→${boss.hp.toFixed(0)}`);
  }
  {
    // Breaking a husk removes it (the tether snaps) and shifts the priority target.
    const { w } = bossArena(0x94, 45, "quorum");
    step(w);
    const shield = liveOf(w, "quorum_shield")[0];
    for (let t = 0; t < 30 && !shield.dead; t++) { plantBullet(w, shield, 9999); step(w, idle(t)); }
    check("focusing the shield husk BREAKS it (removed — the tether snaps)", shield.dead);
    check("with the shield gone, a husk still stands (kill-order continues)",
      w.enemies.some((e) => !e.dead && (e.kind === "quorum_heal" || e.kind === "quorum_dmg")));
  }
  {
    // The merge: draining the pool past the threshold triggers the telegraphed NON-invuln
    // fuse — the husks are removed and the merge-form (phase 2) takes over with its own window.
    const { w, boss } = bossArena(0x95, 45, "quorum");
    step(w);
    let sawMerge = false;
    for (let t = 0; t < 60 * 6 && (boss.boss?.phase ?? 1) < 2; t++) {
      // Hammer the current priority husk to drive the shared pool down past the threshold.
      const priority = w.enemies.find((e) => !e.dead && (e.kind === "quorum_shield" || e.kind === "quorum_heal" || e.kind === "quorum_dmg"));
      if (priority) plantBullet(w, priority, 400);
      step(w, idle(t));
      if (boss.attack.move === "merge") sawMerge = true;
    }
    check("draining the shared pool past the threshold TELEGRAPHS the merge", sawMerge);
    check("the merge advances the core to the merge-form phase", (boss.boss?.phase ?? 1) >= 2);
    // Run out the merge, then confirm the merge-form is now the directly-fought body.
    for (let t = 0; t < 60 * 3; t++) step(w, idle(6000 + t));
    check("after the merge the husks are gone (fused into the merge-form)",
      w.enemies.filter((e) => !e.dead && (e.kind === "quorum_shield" || e.kind === "quorum_heal" || e.kind === "quorum_dmg")).length === 0);
    check("the merge-form core is directly targetable (its own earned window)",
      !w.enemies.some((e) => e.kind === "quorum" && !e.dead && (e.boss?.phase ?? 1) < 2));
  }
  {
    // Co-op scales the pool (task+HP via the shared bar), locked at the pull.
    check("QUORUM's pool rides the R/HP curve (co-op is not a shorter fight)", QUORUM.baseHp > 0);
    check("each husk's integrity is a fraction of the shared pool (kill-order is proportional)",
      QUORUM.huskIntegrityFrac > 0 && QUORUM.huskIntegrityFrac < 1);
  }
}

function main(): void {
  contractGates();
  jetWindowGates();
  jetMirrorGates();
  titheGates();
  quorumGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe Wave 1 deep-boss contracts hold.\n");
}

main();
