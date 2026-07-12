// The KEEP THEM GUESSING contract (fair surprise): randomize WHICH / WHERE / WHEN
// inside hard caps — NEVER whether a hit got a fair tell.
//  §1 add composition draws from curated per-boss pools: weighted, seeded, no immediate
//     entry repeats, singular entries capped, complex movers under the live mover cap;
//  §2 ambush reinforcements are TELEGRAPHED: an omen tell stands at the spot for its
//     whole 0.6–0.8s beat BEFORE the body exists, the body keeps its ordinary spawn
//     grace before it may attack, and no ambush is ever placed inside a standing
//     player's personal space;
//  §3 phase transitions RESHAPE the room (the Weaver re-strings its lanes, the Warden
//     reconfigures its cover) while always leaving a readable route;
//  and all of it is DETERMINISTIC given seed+inputs — seeded variety, never client
//  divergence.
//
// Run: npm run test:fairsurprise

import {
  createWorld, stepWorld, devSpawnEnemy, isBossExposed,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { SPAWN_GRACE, isComplexMover, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import { AMBUSH, WEAVER, MARROW, CHOIR, GILDED, QUORUM, activeMoverCapFor } from "../src/sim/balance.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, cmd: InputCmd = idle(0)) {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 20): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

interface AmbushLog {
  spawns: Array<{ kind: EnemyKind; tier: string; tick: number; hadTell: boolean; tellAge: number; graceOk: boolean }>;
  omenClearOk: boolean;
}

// Run a boss fight and audit every ambush arrival against the fair-surprise laws.
// Transition-beat adds (the molt broodlings, shield husks, split wisps) are the
// choreographed exceptions — they arrive ON the marked beat itself — so the audit
// watches the seeded cadence/pool arrivals: the kinds each boss's pool can draw.
// Live pressure adds are culled once their grace ends (a real party clears them),
// so the shared add budget keeps flowing like a real fight.
function auditAmbushes(w: WorldState, boss: Enemy, watched: readonly EnemyKind[], ticks: number, isCulling = true, drive?: (t: number) => void): AmbushLog {
  const omens = new Map<number, { x: number; y: number; tick: number }>();
  const log: AmbushLog = { spawns: [], omenClearOk: true };
  for (let t = 0; t < ticks && !boss.dead; t++) {
    for (const h of w.hazards) {
      if (h.kind !== "omen" || omens.has(h.id)) continue;
      omens.set(h.id, { x: h.x, y: h.y, tick: t });
      for (const p of w.players.values()) {
        if (p.isDown || p.hp <= 0) continue;
        if (Math.hypot(p.x - h.x, p.y - h.y) < AMBUSH.playerClear - 1e-6) log.omenClearOk = false;
      }
    }
    if (drive) drive(t);
    if (isCulling) {
      for (const en of w.enemies) {
        if (!en.dead && en.isSummoned && en !== boss && en.spawnTimer === 0
          && en.kind !== "knot" && en.kind !== "sac") {
          plantBullet(w, en.x, en.y, 999, 6);
        }
      }
    }
    const evs = step(w, idle(t));
    for (const e of evs) {
      if (e.t !== "enemySpawn") continue;
      if (!watched.includes(e.kind)) continue;
      let hadTell = false;
      let tellAge = 0;
      for (const o of omens.values()) {
        if (Math.hypot(o.x - e.x, o.y - e.y) < 30) {
          hadTell = true;
          tellAge = (t - o.tick) * DT;
        }
      }
      const body = w.enemies.find((en) => en.id === e.eid);
      log.spawns.push({
        kind: e.kind, tier: e.tier, tick: t, hadTell, tellAge,
        graceOk: body !== undefined && Math.abs(body.spawnTimer - SPAWN_GRACE) < 1e-9,
      });
    }
  }
  return log;
}

// ---- §2: every ambush is telegraphed, graced, and never on a player ----

function ambushTellGates(): void {
  section("§2 MARROW cadence: every pool arrival has its omen tell + spawn grace, never on a player");
  {
    const w = createWorld(0xFA1B, 15, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "marrow", p.x + 170, p.y);
    const log = auditAmbushes(w, boss, ["skeleton", "bat", "charger"], 60 * 30);
    check("cadence ambushes arrived to audit", log.spawns.length >= 3, `spawns=${log.spawns.length}`);
    check("every arrival stood behind an omen tell of at least 0.6s",
      log.spawns.every((sp) => sp.hadTell && sp.tellAge >= 0.6 - 2 * DT),
      log.spawns.map((sp) => `${sp.kind}@${sp.tellAge.toFixed(2)}s`).join(","));
    check("the tell itself sits in the 0.6–0.8s band", AMBUSH.tell >= 0.6 && AMBUSH.tell <= 0.8, `tell=${AMBUSH.tell}`);
    check("every arrival keeps its full spawn grace before it may attack",
      log.spawns.every((sp) => sp.graceOk));
    check("no omen ever bloomed inside a standing player's personal space", log.omenClearOk);
  }

  section("§2 Weaver P2: sac blooms + spiderling drops ride the same omen contract");
  {
    const w = createWorld(0xFA1C, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    boss.hp = boss.maxHp * 0.64;
    plantBullet(w, boss.x, boss.y, 1);
    step(w);
    for (let t = 0; t < 60 * 4; t++) step(w, idle(t)); // ride out the molt (its broodlings are the beat's own)
    const log = auditAmbushes(w, boss, ["sac", "bat", "charger"], 60 * 30);
    check("the climb's blooms arrived to audit", log.spawns.length >= 2, `spawns=${log.spawns.length}`);
    check("every sac/spiderling stood behind its omen tell",
      log.spawns.every((sp) => sp.hadTell && sp.tellAge >= 0.6 - 2 * DT));
    check("every arrival keeps its spawn grace", log.spawns.every((sp) => sp.graceOk));
    check("no bloom inside a player's personal space", log.omenClearOk);
  }

  section("§2 Choir verses arrive as ambush waves (and the refrain redirects, never idles)");
  {
    const w = createWorld(0xFA1D, 30, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "choir", p.x + 170, p.y);
    // One pass watches the verse land AND the refrain that rides it: untargetable,
    // bounded, and ALWAYS with live fragments up.
    let sangOk = false;
    let redirectOk = true;
    let singTime = 0;
    // The verse draws its voice from the curated pool now (fair surprise §1): watch every
    // pool kind, and read "fragments up" off the verse TASK (the silence set), not a kind.
    const voiceKinds = [...new Set(CHOIR.addPool.map((entry) => entry.kind))];
    const log = auditAmbushes(w, boss, voiceKinds, 60 * 10, false, () => {
      const isSinging = boss.attack.move === "harmonize" && boss.attack.phase === "active";
      if (isSinging) {
        sangOk = true;
        singTime += DT;
        if (!w.enemies.some((e) => !e.dead && e.isSummoned && boss.boss!.windowAddIds.includes(e.id))) redirectOk = false;
      }
    });
    check("the verse's fragments arrived on omen tells",
      log.spawns.length >= CHOIR.fragmentsFor[1] && log.spawns.every((sp) => sp.hadTell && sp.graceOk),
      `fragments=${log.spawns.length}`);
    check("the Choir sings its refrain as the verse lands (untargetable-while-singing)", sangOk);
    check("the refrain is bounded (never exceeds its authored duration)", singTime <= CHOIR.singDuration + 0.2,
      `sang=${singTime.toFixed(1)}s cap=${CHOIR.singDuration}s`);
    check("DPS is always redirected: fragments stood the whole refrain", redirectOk);
  }

  section("§2 Quorum splinters: a husk break's shard wave rides the SAME omen contract");
  {
    // Break husks (focus the whole trio) to trip splinter waves, holding the pool in phase 1
    // (reset the shared HP each tick) so the trio reforms and breaks repeatedly — a steady
    // stream of shard waves to audit. The core stays put; its husks orbit it (never chase),
    // so this proves the shards themselves telegraph, grace, and clear like every other add.
    const w = createWorld(0xFA1E, 45, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "quorum", p.x + 170, p.y);
    step(w); // raise the husks
    const omens = new Map<number, { x: number; y: number; tick: number }>();
    const spawns: Array<{ tick: number; hadTell: boolean; tellAge: number; graceOk: boolean; roleOk: boolean }> = [];
    let omenClearOk = true;
    for (let t = 0; t < 60 * 40 && !boss.dead; t++) {
      boss.hp = boss.maxHp; // pin phase 1 (never let the pool merge) so the trio keeps reforming
      for (const h of w.hazards) {
        if (h.kind !== "omen" || omens.has(h.id)) continue;
        omens.set(h.id, { x: h.x, y: h.y, tick: t });
        if (Math.hypot(p.x - h.x, p.y - h.y) < AMBUSH.playerClear - 1e-6) omenClearOk = false;
      }
      for (const en of w.enemies) {
        if (!en.dead && (en.kind === "quorum_shield" || en.kind === "quorum_heal" || en.kind === "quorum_dmg")) {
          plantBullet(w, en.x, en.y, boss.maxHp * 0.12, 6); // break the priority husk's integrity without cratering the (pinned) pool
        }
      }
      const evs = step(w, idle(t));
      for (const e of evs) {
        if (e.t !== "enemySpawn" || e.kind !== "quorum_splinter") continue;
        let hadTell = false, tellAge = 0;
        for (const o of omens.values()) {
          if (Math.hypot(o.x - e.x, o.y - e.y) < 30) { hadTell = true; tellAge = (t - o.tick) * DT; }
        }
        const body = w.enemies.find((en) => en.id === e.eid);
        const role = body?.aux ?? -1;
        const roleOk = body !== undefined && (role === 0 || role === 1 || role === 2)
          && body.seq === boss.id + 1 && body.touchDamage === (role === 2 ? 1 : 0);
        spawns.push({
          tick: t, hadTell, tellAge,
          graceOk: body !== undefined && Math.abs(body.spawnTimer - SPAWN_GRACE) < 1e-9,
          roleOk,
        });
      }
    }
    check("splinter waves arrived to audit", spawns.length >= 3, `spawns=${spawns.length}`);
    check("every splinter stood behind an omen tell of at least 0.6s (was: instant pop-in)",
      spawns.every((sp) => sp.hadTell && sp.tellAge >= 0.6 - 2 * DT),
      spawns.map((sp) => `${sp.tellAge.toFixed(2)}s`).join(","));
    check("every splinter keeps its full spawn grace before it may act", spawns.every((sp) => sp.graceOk));
    check("every splinter still carries its parent role (aux 0/1/2, core link, dmg-only contact)",
      spawns.every((sp) => sp.roleOk));
    check("no splinter omen ever bloomed inside the player's ≥140px personal space", omenClearOk);
    check("the splinter's clearance is the shared ambush guarantee (140px)", AMBUSH.playerClear === 140);
    check("splinters draw from the R-keyed wave cap (never an unbounded pop)", QUORUM.huskAddCap > 0);
  }
}

// ---- §1: composition varies by seed, inside every cap ----

function compositionGates(): void {
  section("§1 add composition: seeded variety, non-repeating entries, caps hold");
  const sequences: string[] = [];
  let capsOk = true;
  let repeatOk = true;
  let moverOk = true;
  for (let s = 0; s < 5; s++) {
    const w = createWorld(0xFA20 + s * 7919, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    boss.hp = boss.maxHp * 0.64;
    plantBullet(w, boss.x, boss.y, 1);
    step(w);
    const picks: string[] = [];
    for (let t = 0; t < 60 * 45 && !boss.dead; t++) {
      for (const en of w.enemies) {
        if (!en.dead && en.isSummoned && en !== boss && en.spawnTimer === 0
          && en.kind !== "knot" && en.kind !== "sac") {
          plantBullet(w, en.x, en.y, 999, 6);
        }
      }
      const evs = step(w, idle(t));
      // Same-tick arrivals are ONE draw (a pair entry blooms its bodies together).
      const wave: string[] = [];
      for (const e of evs) {
        if (e.t !== "enemySpawn") continue;
        if (e.kind !== "bat" && e.kind !== "charger") continue;
        wave.push(`${e.kind}/${e.tier}`);
      }
      if (wave.length > 0) picks.push(wave.join("+"));
      // Caps live-audited every tick: singular elites and the complex-mover ceiling.
      let eliteBats = 0, eliteChargers = 0;
      for (const en of w.enemies) {
        if (en.dead || !en.isSummoned) continue;
        if (en.kind === "bat" && en.tier === "elite") eliteBats++;
        if (en.kind === "charger" && en.tier === "elite") eliteChargers++;
      }
      if (eliteBats > 1 || eliteChargers > 1) capsOk = false;
      let movers = 0;
      for (const en of w.enemies) if (!en.dead && isComplexMover(en.kind)) movers++;
      if (movers > activeMoverCapFor(w.encounterPlayers)) moverOk = false;
    }
    for (let i = 2; i < picks.length; i++) {
      if (picks[i] === picks[i - 1] && picks[i - 1] === picks[i - 2]) repeatOk = false;
    }
    sequences.push(picks.join(","));
  }
  const distinct = new Set(sequences).size;
  check("five seeds produce at least two distinct spiderling-wave compositions", distinct >= 2,
    `distinct=${distinct}`);
  check("no draw ever repeats three times running (the anti-rote non-repeat law)", repeatOk);
  check("singular pool entries (one Commander, one Bulwark) never double up", capsOk);
  check("complex movers never exceed the live mover cap", moverOk);
  check("every pool member is a known readable creature (archetype table)",
    WEAVER.addPool.every((e) => ENEMY_ARCHETYPES[e.kind] !== undefined)
    && MARROW.addPool.every((e) => ENEMY_ARCHETYPES[e.kind] !== undefined)
    && CHOIR.addPool.every((e) => ENEMY_ARCHETYPES[e.kind] !== undefined));
  check("the Choir's voice pool is fragile swarm chaff (silenceable, never a kiter that stalls the window)",
    CHOIR.addPool.every((e) => e.tier === "swarm" && !isComplexMover(e.kind)));
}

// ---- §3: phase shifts reshape the room, always leaving a route ----

// Coarse tile BFS over walls + standing props: the readable-route predicate.
function hasRoute(w: WorldState, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const d = w.dungeon;
  const blocked = new Set<number>();
  for (const p of w.props) {
    if (p.dead || p.breakT !== undefined) continue;
    blocked.add(Math.floor(p.y / TILE) * d.w + Math.floor(p.x / TILE));
  }
  const start = Math.floor(fromY / TILE) * d.w + Math.floor(fromX / TILE);
  const goal = Math.floor(toY / TILE) * d.w + Math.floor(toX / TILE);
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === goal) return true;
    const cx = cur % d.w, cy = Math.floor(cur / d.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h) continue;
      const idx = ny * d.w + nx;
      if (seen.has(idx) || d.tiles[idx] === 1 || blocked.has(idx)) continue;
      seen.add(idx);
      queue.push(idx);
    }
  }
  return false;
}

function reshapeGates(): void {
  section("§3 Warden sanctify: the cover reconfigures, gapped and destructible, route intact");
  {
    const w = createWorld(0xFA30, 25, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "gilded", p.x + 220, p.y);
    for (let t = 0; t < 12; t++) step(w, idle(t));
    // First sanctify.
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.31) / GILDED.armorChip);
    step(w);
    const cover1 = w.props.filter((pr) => !pr.dead && pr.owner === boss.id);
    check("the first sanctify raises a ring of owned cover", cover1.length >= 3, `cover=${cover1.length}`);
    check("every piece is ordinary destructible cover (never a hard wall)",
      cover1.every((pr) => pr.kind === "clinker_brick" && pr.hp > 0));
    check("no piece rose on or beside a player",
      cover1.every((pr) => Math.hypot(pr.x - p.x, pr.y - p.y) >= GILDED.coverPlayerClear - 1e-6));
    check("a walkable route to the boss survives the reshape", hasRoute(w, p.x, p.y, boss.x, boss.y));
    const ids1 = new Set(cover1.map((pr) => pr.id));
    // Ride out the beat, then the second sanctify: the shelving RECONFIGURES.
    for (let t = 0; t < 60 * 2; t++) step(w, idle(t));
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.4) / GILDED.armorChip);
    step(w);
    const cover2 = w.props.filter((pr) => !pr.dead && pr.breakT === undefined && pr.owner === boss.id);
    check("the second sanctify crumbles the old set and raises a fresh one",
      cover2.length >= 3 && cover2.every((pr) => !ids1.has(pr.id)), `cover=${cover2.length}`);
    check("the route still stands after the second reshape", hasRoute(w, p.x, p.y, boss.x, boss.y));
  }

  section("§3 Weaver molt: the lattice re-strings (fresh knots + lanes), silk-only — never a wall");
  {
    const w = createWorld(0xFA31, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    // Let the P1 lattice stand first.
    let knots1: Enemy[] = [];
    for (let t = 0; t < 60 * 10 && knots1.length === 0; t++) {
      step(w, idle(t));
      knots1 = w.enemies.filter((e) => !e.dead && e.kind === "knot");
    }
    check("a P1 lattice stands", knots1.length > 0);
    const ids1 = new Set(knots1.map((k) => k.id));
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.37) / WEAVER.guardMult);
    step(w);
    for (let t = 0; t < 60 * 3; t++) step(w, idle(t)); // the molt beat + reshape
    const knots2 = w.enemies.filter((e) => !e.dead && e.kind === "knot");
    check("the molt crumbles the old lattice and strings a FRESH one (lane memory resets)",
      knots2.length > 0 && knots2.every((k) => !ids1.has(k.id)), `knots=${knots2.length}`);
    check("fresh lanes carry silk again", w.hazards.some((h) => h.kind === "web"));
    check("the reshape is silk-only: the route can never be walled off", hasRoute(w, p.x, p.y, boss.x, boss.y));
  }

  section("§3 Choir split: the hall re-tunes (fresh gapped pillar ring), route intact, no window");
  {
    const w = createWorld(0xFA32, 30, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "choir", p.x + 220, p.y);
    for (let t = 0; t < 12; t++) step(w, idle(t));
    // First split beat (P1→P2): a huge hit floors the phase and scatters the Choir; the
    // hall re-tunes as the beat plays.
    plantBullet(w, boss.x, boss.y, 1e6, 30);
    step(w);
    const pillars1 = w.props.filter((pr) => !pr.dead && pr.owner === boss.id);
    check("the split raises a ring of owned resonant pillars", pillars1.length >= 3, `pillars=${pillars1.length}`);
    check("every pillar is ordinary destructible cover (never a hard wall)",
      pillars1.every((pr) => pr.hp > 0 && pr.breakT === undefined));
    check("no pillar rose on or beside a player",
      pillars1.every((pr) => Math.hypot(pr.x - p.x, pr.y - p.y) >= CHOIR.reshapePlayerClear - 1e-6));
    check("a walkable route to the boss survives the reshape", hasRoute(w, p.x, p.y, boss.x, boss.y));
    check("the split reshape opens NO window (only the verse silence can)", !isBossExposed(boss));
    const ids1 = new Set(pillars1.map((pr) => pr.id));
    // Ride the beats out: the queued overflow crosses the next threshold, so the hall
    // reconfigures a SECOND time (fresh pillars, old set crumbled).
    for (let t = 0; t < 60 * 6; t++) step(w, idle(t));
    const pillars2 = w.props.filter((pr) => !pr.dead && pr.breakT === undefined && pr.owner === boss.id);
    check("the second transition crumbles the old ring and raises a fresh one",
      pillars2.length >= 3 && pillars2.every((pr) => !ids1.has(pr.id)), `pillars=${pillars2.length}`);
    check("the route still stands after the second reshape", hasRoute(w, p.x, p.y, boss.x, boss.y));
  }
}

// ---- determinism: seeded variety, never divergence ----

function determinismGates(): void {
  section("determinism: the full surprise stack replays byte-identically (omens, pools, reshapes)");
  const runFight = (): string => {
    const w = createWorld(0xFA40, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    const log: string[] = [];
    for (let t = 0; t < 60 * 60 && !boss.dead; t++) {
      const isExp = isBossExposed(boss);
      const aimAt = isExp ? boss
        : w.enemies.find((e) => !e.dead && e.kind === "sac")
          ?? w.enemies.find((e) => !e.dead && e.kind === "knot")
          ?? boss;
      const aim = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
      const evs = step(w, { seq: t, moveX: 0, moveY: 0, aim, firing: true, dash: false });
      for (const e of evs) {
        if (e.t === "enemySpawn") log.push(`${t}:spawn:${e.kind}/${e.tier}@${e.x.toFixed(2)},${e.y.toFixed(2)}`);
      }
      if (t % 30 === 0) {
        log.push(`${t}:${boss.hp.toFixed(4)}:${boss.boss!.phase}:${boss.boss!.exposed.toFixed(4)}:${w.enemies.length}:${w.hazards.length}:${boss.x.toFixed(3)},${boss.y.toFixed(3)}`);
      }
    }
    return log.join("|");
  };
  const a = runFight();
  const b = runFight();
  check("two identical runs of a P1→P3 fight (ambushes, climbs, dashes) match exactly", a === b,
    `trace=${a.length} chars`);
}

function main(): void {
  ambushTellGates();
  compositionGates();
  reshapeGates();
  determinismGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe fair-surprise contract holds.\n");
}

main();
