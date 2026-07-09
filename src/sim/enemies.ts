import type { Enemy, EnemyKind, SpriteName } from "./types.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor } from "./biomes.js";
import {
  TIERS, BIOME_PRESSURE, BOSS, MARROW, CHOIR, WEAVER, GILDED, GAUNTLET,
  floorHpMult, floorSpeedMult, floorThreat, activeThreatCap, roundHalfToEven,
  bossHpForFloor, marrowHpForFloor, choirHpForFloor, weaverHpForFloor, gildedHpForFloor,
  coopMobHpMult, coopBossHpMult, coopThreatMult, coopKbResistMult,
  MAX_COMPLEX_PER_ROOM, BRUTE_ELITE_COMBO_FLOOR, MAX_COMPLEX_MOVERS_ACTIVE,
  MAX_BURROWERS_PER_ROOM, MAX_SHIELDERS_PER_ROOM, FLOCK_THREAT_SHARE_MAX,
} from "./balance.js";
import type { EnemyTier } from "./balance.js";

export type Movement = "chase" | "flock" | "drift" | "kite" | "charge" | "burrow" | "orbit" | "boss";

// Seconds a freshly-spawned enemy stays passive before it may start a windup, so
// boss-spat adds (or a room's mob on entry) never telegraph-and-hit on frame one.
// Reinforcement releases get the same grace (the timer only ticks once active).
export const SPAWN_GRACE = 0.8;

export interface EnemyArchetype {
  kind: EnemyKind;
  sprite: SpriteName;
  movement: Movement;
  isPhasing: boolean; // ghosts drift through geometry
  radius: number;
  drawSize: number;     // sprite draw size in px (standard tier; tiers scale it)
  alpha: number;        // render opacity (ghost is semi-transparent)
  tint: string;         // gib / impact-puff color for this enemy
  kbResist: number;     // knockback divisor — heavier things budge less (boss ~unmovable)
  baseHp: number;       // floor-1 baseline; per-floor tables in balance.ts scale it
  baseSpeed: number;    // floor-1 baseline px/s
  touchDamage: number;
  threat: number;       // §4 threat-budget cost (simple chaser 1.0, ranged/kiter 1.5)
}

// Standard-tier baselines satisfy the studio gate's early-melt floor: a focused starter
// pistol takes ≥0.45s median to delete any archetype on its entry floor (gate §7.1 raised
// slime 3→5, bat 2→4, spitter 3→5 — "raise archetype HP, not body count"). Swarm-tier
// bodies stay the deliberate 0.55× melt chaff.
export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  slime: {
    kind: "slime", sprite: "slime", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 44, alpha: 1, tint: "#a855f7", kbResist: 1,
    baseHp: 5, baseSpeed: 42, touchDamage: 1, threat: 1.0,
  },
  // Bats fly as a FLOCK (deterministic boids: separation/alignment/cohesion + target
  // attraction) — a wheeling, readable swarm instead of independent zigzag beelines.
  bat: {
    kind: "bat", sprite: "bat", movement: "flock", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#9aa4bf", kbResist: 0.7,
    baseHp: 4, baseSpeed: 96, touchDamage: 1, threat: 1.0,
  },
  skeleton: {
    kind: "skeleton", sprite: "skeleton", movement: "chase", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e8e0cf", kbResist: 1.6,
    baseHp: 6, baseSpeed: 62, touchDamage: 1, threat: 1.0,
  },
  ghost: {
    kind: "ghost", sprite: "ghost", movement: "drift", isPhasing: true,
    radius: 15, drawSize: 46, alpha: 0.62, tint: "#bfe9ff", kbResist: 1.1,
    baseHp: 4, baseSpeed: 56, touchDamage: 1, threat: 1.0,
  },
  // Glass-cannon ranged caster. Kites the player and lobs projectiles on a telegraph.
  // TODO(art): using beetle.png as a placeholder body — the art director is making a
  // dedicated bright-caster Spitter sprite (distinct from the purple boss).
  spitter: {
    kind: "spitter", sprite: "spitter", movement: "kite", isPhasing: false,
    radius: 15, drawSize: 42, alpha: 1, tint: "#ff5a7a", kbResist: 0.8,
    baseHp: 5, baseSpeed: 30, touchDamage: 1, threat: 1.5,
  },
  // Line-rush bruiser: a slow stalker whose telegraphed straight charge crosses most of a
  // room — sidestep it, then punish the wall-crash stun. Heavy on its feet (high kbResist),
  // so the answer is footwork, not knockback. The corrected gate pins the in-flight base
  // (threat 1.5, like every special-answer mob).
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: charger).
  charger: {
    kind: "charger", sprite: "charger", movement: "charge", isPhasing: false,
    radius: 17, drawSize: 48, alpha: 1, tint: "#d9a066", kbResist: 1.8,
    baseHp: 5, baseSpeed: 46, touchDamage: 1, threat: 1.5,
  },
  // Kite-denial: dives underground (untargetable, bounded), tunnels to the target, and
  // erupts on a marked, telegraphed circle. You cannot outrange it — you dodge its marker
  // and punish the surfaced recover window.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: burrower).
  burrower: {
    kind: "burrower", sprite: "burrower", movement: "burrow", isPhasing: false,
    radius: 15, drawSize: 44, alpha: 1, tint: "#caa27e", kbResist: 1.2,
    baseHp: 4, baseSpeed: 40, touchDamage: 1, threat: 1.5,
  },
  // Ring strafer: circles the target at mid range (rotational tracking — a different aim
  // problem from the spitter's straight kiting) and stops to fire a quick telegraphed bolt.
  // The stop IS the tell: an orbiter standing still is an orbiter about to shoot.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: orbiter).
  orbiter: {
    kind: "orbiter", sprite: "orbiter", movement: "orbit", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#8fb8ff", kbResist: 0.8,
    baseHp: 3, baseSpeed: 95, touchDamage: 1, threat: 1.5,
  },
  // Walking wall: absorbs bullets arriving inside its front arc — the answer is the flank,
  // melee over the top, or splash. Its bash is an ordinary short telegraphed lunge; the
  // enemy itself is a POSITIONING problem, not a stat problem.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: shielder).
  shielder: {
    kind: "shielder", sprite: "shielder", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 46, alpha: 1, tint: "#9fb4a8", kbResist: 2.2,
    baseHp: 5, baseSpeed: 50, touchDamage: 1, threat: 1.5,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b", kbResist: 6,
    baseHp: BOSS.baseHp, baseSpeed: 40, touchDamage: BOSS.contactDamage, threat: 0,
  },
  // MARROW (the boss-roster spec's blind charger, deep roster): line charges with a
  // wall-crash daze, bone-shard volleys, a P3 spiral barrage, and an interactive shield
  // transition beat (§5b). Eyeless — it commits to where it HEARD you (the aim lock),
  // which is why the last stretch of every windup is un-tracked and sidesteppable.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: marrow).
  marrow: {
    kind: "marrow", sprite: "marrow", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 92, alpha: 1, tint: "#bfd8e0", kbResist: 6,
    baseHp: MARROW.baseHp, baseSpeed: 46, touchDamage: MARROW.contactDamage, threat: 0,
  },
  // THE HOLLOW CHOIR (deep roster): the grieving ghost mass — fades intangible on cadence,
  // sings slow homing wails you juke by turning, and SPLITS into wisps at its transition
  // beats (kill them to force it back together early). §5c.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: choir).
  choir: {
    kind: "choir", sprite: "choir", movement: "boss", isPhasing: true,
    radius: 30, drawSize: 96, alpha: 0.85, tint: "#bfe9ff", kbResist: 6,
    baseHp: CHOIR.baseHp, baseSpeed: 44, touchDamage: CHOIR.contactDamage, threat: 0,
  },
  // THE WEAVER (deep roster): the duelist that fights the floor — plants persistent web
  // slow-zones that shrink your dance space and pounces from above onto a locked marker,
  // chaining leaps in later phases. Small, fast, lower HP. §5d.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: weaver).
  weaver: {
    kind: "weaver", sprite: "weaver", movement: "boss", isPhasing: false,
    radius: 26, drawSize: 76, alpha: 1, tint: "#c98bff", kbResist: 4,
    baseHp: WEAVER.baseHp, baseSpeed: 120, touchDamage: WEAVER.contactDamage, threat: 0,
  },
  // THE GILDED WARDEN (deep roster): the armored tempo boss — its plate chips damage to
  // 30% except during the EXPOSED recover after each committed quake/sweep. The only
  // warm-angular body in the bestiary (amber is the one friendly-angular thing). §5e.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: gilded).
  gilded: {
    kind: "gilded", sprite: "gilded", movement: "boss", isPhasing: false,
    radius: 36, drawSize: 108, alpha: 1, tint: "#ffd166", kbResist: 8,
    baseHp: GILDED.baseHp, baseSpeed: 26, touchDamage: GILDED.contactDamage, threat: 0,
  },
};

// Which archetypes each tier may inhabit: swarms are small fast bodies, brutes are the
// bulky telegraph-hitters (only an authored commitment — the skeleton's lunge or the
// charger's rush — carries the heavy +1).
const SWARM_KINDS: readonly EnemyKind[] = ["slime", "bat"];
const BRUTE_KINDS: readonly EnemyKind[] = ["slime", "skeleton", "charger"];

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

const BOSS_KINDS: readonly EnemyKind[] = ["boss", "marrow", "choir", "weaver", "gilded"];

export function isBossKind(kind: EnemyKind): boolean {
  return BOSS_KINDS.indexOf(kind) !== -1;
}

// The canonical first-clear chain (curriculum §0, FINAL): Slime King F5 → Miniboss
// Gauntlet F10 (a non-boss milestone — see world.ts's gauntlet controller) → Marrow F15 →
// Weaver F20 → Gilded Warden F25 → Hollow Choir F30. `null` marks the gauntlet slot.
const AUTHORED_BOSS_LADDER: readonly (EnemyKind | null)[] = ["boss", null, "marrow", "weaver", "gilded", "choir"];

// Beyond the authored chain (F35+ endgame), boss floors draw from the full roster, seeded
// per run — variety between runs, identical across a run's clients/restarts.
const DEEP_BOSS_ROSTER: readonly EnemyKind[] = ["marrow", "choir", "weaver", "gilded", "boss"];

// Each boss floor's kin — the floor's ambient minions and its cadence/beat adds.
export const BOSS_KIN: Readonly<Partial<Record<EnemyKind, EnemyKind>>> = {
  boss: "slime", marrow: "skeleton", choir: "ghost", weaver: "bat", gilded: "shielder",
};

// The F10 Arena Gauntlet floor (curriculum §2): sequential authored minibosses instead of
// a boss. The stage machine lives in world.ts; spawn/clear plumbing branches here.
export function isGauntletFloor(floor: number): boolean {
  return floor === GAUNTLET.floor;
}

// Which boss holds each boss-cadence floor: the authored F5–F30 chain (null = the F10
// gauntlet), then the seeded deep rotation with no immediate repeats (its first pick also
// never repeats the F30 Choir finale).
export function bossKindForFloor(seed: number, floor: number): EnemyKind | null {
  const ladder = Math.floor(floor / BOSS_EVERY);
  if (ladder <= AUTHORED_BOSS_LADDER.length) return AUTHORED_BOSS_LADDER[Math.max(1, ladder) - 1];
  return DEEP_BOSS_ROSTER[deepBossIndex(seed, ladder - AUTHORED_BOSS_LADDER.length - 1)];
}

// Walk the seeded ladder from the top so "no immediate repeats" is well-defined and
// deterministic at any depth (each step rerolls, shifting off the previous pick). Step 0
// treats the authored finale (the Choir) as its predecessor.
function deepBossIndex(seed: number, step: number): number {
  let prev = DEEP_BOSS_ROSTER.indexOf("choir");
  for (let s = 0; ; s++) {
    let pick = new Rng((seed ^ 0xB055ED) + s * 2654435761).int(0, DEEP_BOSS_ROSTER.length - 1);
    if (pick === prev) pick = (pick + 1) % DEEP_BOSS_ROSTER.length;
    if (s === step) return pick;
    prev = pick;
  }
}

// §3 exact tables: HP(f) = roundHalfToEven(baseHP × HPmult(f)), same for speed. Damage
// never scales with floor.
export function enemyHpForFloor(kind: EnemyKind, floor: number): number {
  switch (kind) {
    case "boss": return bossHpForFloor(floor);
    case "marrow": return marrowHpForFloor(floor);
    case "choir": return choirHpForFloor(floor);
    case "weaver": return weaverHpForFloor(floor);
    case "gilded": return gildedHpForFloor(floor);
    default: return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseHp * floorHpMult(floor));
  }
}

export function enemySpeedForFloor(kind: EnemyKind, floor: number): number {
  return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseSpeed * floorSpeedMult(floor));
}

// §4 threat-budget cost of one unit: archetype cost × tier cost.
export function threatCostOf(kind: EnemyKind, tier: EnemyTier): number {
  return ENEMY_ARCHETYPES[kind].threat * TIERS[tier].threatCost;
}

// The complex MOVERS of studio gate §1: the movement verbs that deny standard answers
// (the charger's lane, the burrower's tunnel). At most MAX_COMPLEX_MOVERS_ACTIVE of them
// may be live at once on Standard.
export function isComplexMover(kind: EnemyKind): boolean {
  const m = ENEMY_ARCHETYPES[kind].movement;
  return m === "charge" || m === "burrow";
}

export interface CreateEnemyOpts {
  tier?: EnemyTier;
  isSummoned?: boolean;
  players?: number; // encounter player snapshot (co-op HP/KB scaling); 1 = solo
}

// The seeded sim Rng supplies the bat's initial `zig` heading so enemy creation is
// deterministic (golden-master oracle + later prediction). spawnFloorEnemies passes its
// own per-floor Rng; runtime spawns (boss adds, elite splits, dev) pass the live world Rng.
export function createEnemy(kind: EnemyKind, x: number, y: number, floor: number, rng: Rng, id: number, opts: CreateEnemyOpts = {}): Enemy {
  const a = ENEMY_ARCHETYPES[kind];
  const tier = opts.tier ?? "standard";
  const tierDef = TIERS[tier];
  const players = opts.players ?? 1;
  const isBoss = isBossKind(kind);
  const hp = isBoss
    ? Math.round((enemyHpForFloor(kind, floor) * coopBossHpMult(players)) / 10) * 10
    : Math.max(1, roundHalfToEven(a.baseHp * floorHpMult(floor) * tierDef.hpMult * coopMobHpMult(players)));
  const speed = isBoss
    ? a.baseSpeed
    : roundHalfToEven(a.baseSpeed * floorSpeedMult(floor) * tierDef.speedMult);
  // Seed the slime hop clock from the sim Rng (not Math.random): the slime's hop-cadence
  // reads it, so it must be deterministic. Drawn BEFORE zig to match the historical rng
  // stream order. Still desyncs each enemy, but reproducibly.
  const hopClock = rng.next() * 10;
  return {
    id,
    kind, x, y, vx: 0, vy: 0,
    tier,
    isSummoned: opts.isSummoned ?? false,
    radius: a.radius * tierDef.radiusMult,
    hp, maxHp: hp, dead: false,
    speed,
    touchDamage: a.touchDamage,
    kbResist: a.kbResist * (tier === "brute" ? 2 : 1) * coopKbResistMult(players),
    surgeDelay: 0, surgeTime: 0,
    zig: rng.next() * Math.PI * 2,
    hopClock, hopMove: 0,
    spawnTimer: SPAWN_GRACE,
    stuckTimer: 0,
    avoidSide: 0,
    avoidTime: 0,
    burn: 0, burnDmg: 0, chill: 0, shock: 0, statusTick: 0, burnOwner: null,
    attack: {
      phase: "none", time: 0, move: "none", windup: 0,
      // Bosses wait a beat after their dramatic entrance before the first commitment.
      cooldown: BOSS_ENTRANCE_GRACE[kind] ?? 0,
      lockedAngle: 0, isAimLocked: false, markX: 0, markY: 0,
    },
    boss: isBoss
      ? {
        phase: 1, transitionsDone: 0, roar: null,
        addTimer: BOSS_ADD_FIRST_AT[kind] ?? 0,
        attackCount: 0, isNextRadial: false, burstParity: 0,
        beatAddIds: [], spinCount: 0,
      }
      : null,
  };
}

const BOSS_ENTRANCE_GRACE: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.entranceGrace, marrow: MARROW.entranceGrace, choir: CHOIR.entranceGrace,
  weaver: WEAVER.entranceGrace, gilded: GILDED.entranceGrace,
};

// Only the summoner bosses run a cadence add drip (the Choir's wisps and the Weaver's
// broodlings arrive on their transition beats instead; the Warden fights alone).
const BOSS_ADD_FIRST_AT: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.addFirstAt, marrow: MARROW.addFirstAt,
};

// The corrected gate §2 cadence table (authoritative over earlier drafts): F1 slime only,
// F2 expands (bat, skeleton, spitter — the bat flock's first isolated floor), F3 remixes
// (+ghost, charger), F4 proves (+burrower, first guaranteed brute), F6 recovers with the
// orbiter's isolated teaching room, F7 adapts with the shielder wall.
export const FAMILY_INTRO_FLOOR: Readonly<Partial<Record<EnemyKind, number>>> = {
  slime: 1, bat: 2, skeleton: 2, spitter: 2, ghost: 3, charger: 3,
  burrower: 4, orbiter: 6, shielder: 7,
};

function floorRoster(floor: number, complexShare: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  const has = (kind: EnemyKind): boolean => floor >= (FAMILY_INTRO_FLOOR[kind] ?? Infinity);
  if (has("bat")) roster.push({ kind: "bat", weight: 3 });
  if (has("skeleton")) roster.push({ kind: "skeleton", weight: 2 });
  // Ranged threat: rare on its intro floor (a gentle lesson), a bit more common from
  // floor 3 once the melee lunge is learned. Sunless raises the complex share.
  if (has("spitter")) roster.push({ kind: "spitter", weight: (floor >= 3 ? 2 : 1) * complexShare });
  if (has("ghost")) roster.push({ kind: "ghost", weight: 2 * complexShare });
  if (has("charger")) roster.push({ kind: "charger", weight: 2 });
  if (has("burrower")) roster.push({ kind: "burrower", weight: 2 * complexShare });
  if (has("orbiter")) roster.push({ kind: "orbiter", weight: 2 * complexShare });
  if (has("shielder")) roster.push({ kind: "shielder", weight: 2 });
  return roster;
}

function weightedPick(rng: Rng, roster: Array<{ kind: EnemyKind; weight: number }>): EnemyKind {
  const total = roster.reduce((s, r) => s + r.weight, 0);
  let roll = rng.next() * total;
  for (const r of roster) {
    roll -= r.weight;
    if (roll <= 0) return r.kind;
  }
  return roster[roster.length - 1].kind;
}

// ---- the encounter deck (curriculum §4) ----
// Each combat room draws one CARD from a seeded shuffle bag; the card decides the room's
// composition flavor. Simple cards host only simple families; a complex card is the only
// place its family may land. The bag is drawn without replacement (an exact card cannot
// repeat until the bag turns over), never deals the same card twice in a row across a
// reshuffle, never deals more than two complex cards consecutively, keeps ≥30% of the
// floor's rooms simple (dropping complexity before repeating pressure, §4's own remedy),
// and deals an authored BREATHER as the first room after a milestone floor.

export type EncounterCard = "breather" | "pack" | "hunt" | "ranged" | "mover" | "wall";

const COMPLEX_CARDS: readonly EncounterCard[] = ["ranged", "mover", "wall"];

function isComplexCard(card: EncounterCard): boolean {
  return COMPLEX_CARDS.indexOf(card) !== -1;
}

// Which card a complex family plays under (simple families fit any room).
function cardOfKind(kind: EnemyKind): EncounterCard | null {
  switch (kind) {
    case "spitter": case "orbiter": return "ranged";
    case "charger": case "burrower": return "mover";
    case "shielder": return "wall";
    default: return null;
  }
}

function availableCards(floor: number): EncounterCard[] {
  const has = (kind: EnemyKind): boolean => floor >= (FAMILY_INTRO_FLOOR[kind] ?? Infinity);
  const cards: EncounterCard[] = ["pack", "hunt"];
  if (has("spitter") || has("orbiter")) cards.push("ranged");
  if (has("charger") || has("burrower")) cards.push("mover");
  if (has("shielder")) cards.push("wall");
  return cards;
}

// The deck is a pure function of (seed, floor, combatRoomCount) — its own derived Rng
// stream, shared by the planner and the cadence tests.
export function encounterDeckForFloor(seed: number, floor: number, combatRoomCount: number): EncounterCard[] {
  const rng = new Rng((seed ^ 0xDECCB4A9) + floor * 92821);
  const pool = availableCards(floor);
  const bag: EncounterCard[] = [];
  const cards: EncounterCard[] = [];
  let complexRun = 0;
  for (let i = 0; i < combatRoomCount; i++) {
    // The first room after a milestone floor (boss or gauntlet) is the authored breather.
    if (i === 0 && floor > 1 && isBossFloor(floor - 1)) {
      cards.push("breather");
      complexRun = 0;
      continue;
    }
    if (bag.length === 0) {
      bag.push(...pool);
      // Fisher-Yates off the seeded stream.
      for (let k = bag.length - 1; k > 0; k--) {
        const j = rng.int(0, k);
        [bag[k], bag[j]] = [bag[j], bag[k]];
      }
      // Never deal the same card twice in a row across the reshuffle boundary.
      if (cards.length > 0 && bag[bag.length - 1] === cards[cards.length - 1] && bag.length > 1) {
        [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      }
    }
    // Max two complex cards consecutively: prefer the topmost simple card when the run
    // would exceed the limit; if the bag holds only pressure, deal a simple filler
    // instead (drop complexity before repeating it — §4's remedy) and keep the bag.
    // Every path also refuses to deal the same card back-to-back.
    const last = cards.length > 0 ? cards[cards.length - 1] : null;
    let take = -1;
    for (let k = bag.length - 1; k >= 0; k--) {
      if (bag[k] === last) continue;
      if (complexRun >= 2 && isComplexCard(bag[k])) continue;
      take = k;
      break;
    }
    const card = take === -1 ? (last === "hunt" ? "pack" : "hunt") : bag.splice(take, 1)[0];
    complexRun = isComplexCard(card) ? complexRun + 1 : 0;
    cards.push(card);
  }
  // ≥30% simple/mastery rooms: drop complexity from the tail before repeating pressure,
  // picking whichever simple card keeps neighbors distinct.
  const simpleQuota = Math.ceil(combatRoomCount * 0.30);
  let simple = cards.filter((c) => !isComplexCard(c)).length;
  for (let i = cards.length - 1; i >= 0 && simple < simpleQuota; i--) {
    if (!isComplexCard(cards[i])) continue;
    const neighbors = [cards[i - 1], cards[i + 1]];
    cards[i] = (["hunt", "pack", "breather"] as const).find((c) => !neighbors.includes(c)) ?? "hunt";
    simple++;
  }
  return cards;
}

// A spawn point on OPEN FLOOR inside the room. Rooms carry interior walls now (pillared
// halls, cavern edges, vault rings), so a raw rect sample can land inside geometry;
// resample a few times and fall back to the room center, which the generator guarantees
// open. Deterministic: same seed -> same draw sequence.
function pointInRoom(rng: Rng, dungeon: Dungeon, roomIndex: number): { x: number; y: number } {
  const room = dungeon.rooms[roomIndex];
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = (room.x + 1 + rng.next() * Math.max(1, room.w - 2)) * TILE;
    const y = (room.y + 1 + rng.next() * Math.max(1, room.h - 2)) * TILE;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (dungeon.tiles[ty * dungeon.w + tx] === 0) return { x, y };
  }
  return { x: (room.cx + 0.5) * TILE, y: (room.cy + 0.5) * TILE };
}

// The floor's spawn set, split into the immediately-active wave and the pending
// reinforcement queue (released by the world when the living threat drops under the cap).
export interface FloorSpawns {
  active: Enemy[];
  pending: Enemy[];
}

interface PlannedUnit {
  kind: EnemyKind;
  tier: EnemyTier;
  room: number;
}

// Per-room composition bookkeeping for the §4 readability guards.
interface RoomLoad {
  card: EncounterCard;
  units: number;
  complex: number;
  burrowers: number;
  shielders: number;
  hasBrute: boolean;
  hasElite: boolean;
}

// Flock spacing: swarm-tier units (the boid packs — see flock.ts) need open air to move
// as a flock, so their placement prefers rooms with at least this many open floor tiles.
// Exported so the depth suite can assert the invariant.
export const SWARM_ROOM_MIN_AREA = 30;

function roomOpenArea(dungeon: Dungeon, roomIndex: number): number {
  const room = dungeon.rooms[roomIndex];
  let open = 0;
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      if (dungeon.tiles[ty * dungeon.w + tx] === 0) open++;
    }
  }
  return open;
}

// Deterministic threat-budget floor composition (§4): spend FloorThreat on a tiered unit
// mix instead of counting bodies. Elites/brutes are planned first (they anchor the opening
// wave); swarm packs and standards fill the remainder and overflow into reinforcements.
function planFloorUnits(rng: Rng, dungeon: Dungeon, seed: number, floor: number, players: number): PlannedUnit[] {
  const roomCount = dungeon.rooms.length;
  const pressure = BIOME_PRESSURE[biomeIndexForFloor(floor)];
  let budget = floorThreat(floor) * pressure.budgetMult * coopThreatMult(players);
  const roster = floorRoster(floor, pressure.complexShare);
  const plan: PlannedUnit[] = [];

  // Combat rooms: 3–5 of the non-spawn rooms carry the floor's threat, in PROGRESSION
  // order (ascending room index) so the deck's sequencing rules — breather first after a
  // milestone, complex-run limits — read along the player's actual path. The shop room
  // is sanctuary ground and never a candidate (Patch's waystation hosts no encounter).
  const candidates: number[] = [];
  for (let i = 1; i < roomCount; i++) {
    if (dungeon.rooms[i].kind !== "shop") candidates.push(i);
  }
  const combatRoomCount = Math.min(5, Math.max(Math.min(3, candidates.length), Math.floor(candidates.length * 0.75)));
  const combatRooms: number[] = [];
  while (combatRooms.length < combatRoomCount && candidates.length > 0) {
    combatRooms.push(candidates.splice(rng.int(0, candidates.length - 1), 1)[0]);
  }
  combatRooms.sort((a, b) => a - b);
  const deck = encounterDeckForFloor(seed, floor, combatRooms.length);
  const load = new Map<number, RoomLoad>();
  for (let i = 0; i < combatRooms.length; i++) {
    load.set(combatRooms[i], { card: deck[i], units: 0, complex: 0, burrowers: 0, shielders: 0, hasBrute: false, hasElite: false });
  }
  // §4: at most 35% of the floor's rooms may carry TWO complex units.
  let twoComplexRooms = 0;
  const twoComplexCap = Math.floor(combatRooms.length * 0.35);

  // Swarm placement (flock spacing, gate: flocks need open air): combat rooms with real
  // open floor host the packs; the ordinary card-constrained draw is the fallback. Room
  // shapes get roomier with depth (halls, arenas, caverns), so deep flocks reliably get
  // their theater.
  const roomyCombat = combatRooms.filter((r) => roomOpenArea(dungeon, r) >= SWARM_ROOM_MIN_AREA);

  const roomFits = (room: number, unit: { kind: EnemyKind; tier: EnemyTier }): boolean => {
    const l = load.get(room)!;
    const family = cardOfKind(unit.kind);
    // A complex family may only land in a room playing ITS card; breathers stay small
    // and simple (the curriculum's mastery/recovery room).
    if (family !== null && l.card !== family) return false;
    if (l.card === "breather" && (family !== null || unit.tier === "elite" || unit.tier === "brute" || l.units >= 3)) return false;
    if (ENEMY_ARCHETYPES[unit.kind].threat > 1) {
      if (l.complex >= MAX_COMPLEX_PER_ROOM) return false;
      if (l.complex === 1 && twoComplexRooms >= twoComplexCap) return false;
    }
    if (unit.kind === "burrower" && l.burrowers >= MAX_BURROWERS_PER_ROOM) return false;
    if (unit.kind === "shielder" && l.shielders >= MAX_SHIELDERS_PER_ROOM) return false;
    // Corrected gate §2 tier cadence: one brute and one elite per room.
    if (unit.tier === "brute" && l.hasBrute) return false;
    if (unit.tier === "elite" && l.hasElite) return false;
    if (floor < BRUTE_ELITE_COMBO_FLOOR) {
      if (unit.tier === "brute" && l.hasElite) return false;
      if (unit.tier === "elite" && l.hasBrute) return false;
    }
    return true;
  };

  const claimRoom = (room: number, unit: { kind: EnemyKind; tier: EnemyTier }): number => {
    const l = load.get(room)!;
    l.units++;
    if (ENEMY_ARCHETYPES[unit.kind].threat > 1) {
      l.complex++;
      if (l.complex === 2) twoComplexRooms++;
    }
    if (unit.kind === "burrower") l.burrowers++;
    if (unit.kind === "shielder") l.shielders++;
    if (unit.tier === "brute") l.hasBrute = true;
    if (unit.tier === "elite") l.hasElite = true;
    return room;
  };

  // Random placement first, then a deterministic scan — the composition guards are HARD
  // (a floor plants fewer units before it ever breaks one).
  const pickRoom = (unit: { kind: EnemyKind; tier: EnemyTier }): number | null => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const room = combatRooms[rng.int(0, combatRooms.length - 1)];
      if (roomFits(room, unit)) return claimRoom(room, unit);
    }
    for (const room of combatRooms) {
      if (roomFits(room, unit)) return claimRoom(room, unit);
    }
    return null;
  };

  // Swarm units prefer the roomy combat rooms (same card guards, roomier draw pool);
  // when no roomy room fits, the ordinary draw decides — caps beat preference.
  const pickSwarmRoom = (kind: EnemyKind): number | null => {
    if (roomyCombat.length > 0) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const room = roomyCombat[rng.int(0, roomyCombat.length - 1)];
        if (roomFits(room, { kind, tier: "swarm" })) return claimRoom(room, { kind, tier: "swarm" });
      }
    }
    return pickRoom({ kind, tier: "swarm" });
  };

  const add = (kind: EnemyKind, tier: EnemyTier): boolean => {
    const cost = threatCostOf(kind, tier);
    if (cost > budget) return false;
    const room = tier === "swarm" ? pickSwarmRoom(kind) : pickRoom({ kind, tier });
    if (room === null) return false;
    budget -= cost;
    plan.push({ kind, tier, room });
    return true;
  };

  // Every complex card's room is anchored by ONE unit of its family first — the card IS
  // that room's lesson; the fill loop then textures around the anchors.
  for (const room of combatRooms) {
    const l = load.get(room)!;
    if (!isComplexCard(l.card)) continue;
    const anchors = roster.filter((r) => cardOfKind(r.kind) === l.card);
    if (anchors.length === 0) continue;
    const kind = anchors.length === 1 ? anchors[0].kind : weightedPick(rng, anchors);
    const cost = threatCostOf(kind, "standard");
    if (cost > budget || !roomFits(room, { kind, tier: "standard" })) continue;
    claimRoom(room, { kind, tier: "standard" });
    budget -= cost;
    plan.push({ kind, tier: "standard", room });
  }

  if (floor >= TIERS.elite.minFloor) {
    const elites = floor >= 9 ? 2 : 1;
    for (let i = 0; i < elites; i++) {
      // Up to three rolls: an elite of a complex family needs a room playing its card.
      for (let roll = 0; roll < 3 && !add(weightedPick(rng, roster), "elite"); roll++) { /* reroll */ }
    }
  }
  if (floor >= TIERS.brute.minFloor) {
    const brutes = floor >= 7 ? 2 : 1;
    for (let i = 0; i < brutes; i++) add(BRUTE_KINDS[rng.int(0, BRUTE_KINDS.length - 1)], "brute");
  }

  // Gate §2: no pack (the bat flock especially) may consume more than 35% of the floor's
  // threat spend — a swarm is texture, never the room's whole budget.
  const packSpendCap = FLOCK_THREAT_SHARE_MAX * floorThreat(floor) * pressure.budgetMult * coopThreatMult(players);
  const minCost = threatCostOf("slime", "swarm");
  let guard = 0;
  while (budget >= minCost && guard++ < 200) {
    const kind = weightedPick(rng, roster);
    const isSwarmable = SWARM_KINDS.includes(kind);
    if (isSwarmable && rng.chance(0.3 * pressure.packBias)) {
      const pack = rng.int(2, 3);
      const room = pickSwarmRoom(kind);
      if (room === null) continue;
      let packSpent = threatCostOf(kind, "swarm");
      budget -= packSpent;
      plan.push({ kind, tier: "swarm", room });
      for (let i = 1; i < pack; i++) {
        const cost = threatCostOf(kind, "swarm");
        if (cost > budget || packSpent + cost > packSpendCap) break;
        // Each extra pack body re-checks the room's guards (a breather stays small).
        if (!roomFits(room, { kind, tier: "swarm" })) break;
        claimRoom(room, { kind, tier: "swarm" });
        budget -= cost;
        packSpent += cost;
        plan.push({ kind, tier: "swarm", room });
      }
    } else if (!add(kind, "standard")) {
      // No compatible room (or too expensive) — reroll; a swarm unit may still fit.
      if (isSwarmable) add(kind, "swarm");
    }
  }
  return plan;
}

export function spawnFloorEnemies(dungeon: Dungeon, seed: number, floor: number, players = 1): FloorSpawns {
  const rng = new Rng((seed ^ 0x9e3779b9) + floor * 2654435761);
  const roomCount = dungeon.rooms.length;
  if (roomCount <= 1) return { active: [], pending: [] };

  if (isGauntletFloor(floor)) {
    // The F10 Arena Gauntlet: the arena (last room) starts EMPTY — the world's gauntlet
    // controller stages the sequential minibosses — while the approach rooms carry a
    // light flock escort sprinkle (the region's kin, never the arena's pressure).
    const active: Enemy[] = [];
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, Math.max(1, roomCount - 2) - 1);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy("bat", p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  if (isBossFloor(floor)) {
    // The floor's boss lives in the last room (next to the exit), with a few of its own
    // kin for company (slimes under the King, skeletons under MARROW, ghosts under the
    // Choir, bats under the Weaver, shielders under the Gilded Warden).
    const active: Enemy[] = [];
    const bossKind = bossKindForFloor(seed, floor) ?? "boss";
    const minionKind: EnemyKind = BOSS_KIN[bossKind] ?? "slime";
    const bossRoom = roomCount - 1;
    const b = pointInRoom(rng, dungeon, bossRoom);
    active.push(createEnemy(bossKind, b.x, b.y, floor, rng, active.length, { players }));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy(minionKind, p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  const plan = planFloorUnits(rng, dungeon, seed, floor, players);
  const cap = activeThreatCap(floor) * coopThreatMult(players);
  const active: Enemy[] = [];
  const pending: Enemy[] = [];
  let activeThreat = 0;
  let activeComplexMovers = 0;
  let id = 0;
  for (const unit of plan) {
    const p = pointInRoom(rng, dungeon, unit.room);
    const enemy = createEnemy(unit.kind, p.x, p.y, floor, rng, id++, { tier: unit.tier, players });
    const cost = threatCostOf(unit.kind, unit.tier);
    const isMover = isComplexMover(unit.kind);
    // Never exceed the ActiveThreatCap simultaneously, and never field more than the
    // gate's complex-mover budget at once: overflow becomes reinforcements.
    if (activeThreat + cost <= cap && (!isMover || activeComplexMovers < MAX_COMPLEX_MOVERS_ACTIVE)) {
      activeThreat += cost;
      if (isMover) activeComplexMovers++;
      active.push(enemy);
    } else {
      pending.push(enemy);
    }
  }
  return { active, pending };
}
