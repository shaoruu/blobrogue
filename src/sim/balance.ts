// The versioned BalanceDef — every gameplay-balance number from
// docs/specs/blobrogue_BALANCE_FINAL_impl.md lives HERE, in one deterministic module the
// pure sim consumes (LocalTransport solo and the authoritative server run the same data).
// Design rule (spec §0): difficulty comes from techniques, telegraphed commitments, room
// composition, movement and scarcity — HP is a calibration output, never the difficulty lever.
//
// Engine-mechanical constants that are not balance (pathfinding cadence, knockback physics,
// status-system plumbing) stay in constants.ts.

export const BALANCE_VERSION = 3;

// ---- §0.5 difficulty modes (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §1) ----
//
// OWNER DECISION (after Game Designer review): exactly THREE modes — casual, standard,
// brutal — per the committed studio-gate matrix, also recorded as the encounter
// curriculum's §7 "Three explicit difficulty modes (owner decision)". Any spec draft
// that names a two-mode Standard/Veteran split is superseded by this main-runner
// contract; do not reduce, rename, or add modes without a new owner decision.
//
// ONE typed definition per mode, consumed at the deterministic floor-build/sim seams.
// The gate's core rule: ALL modes use identical enemy/boss HP, tier HP, weapon DPS,
// damage, phase thresholds/floors, windups, locks and recoveries — focused TTK stays
// authored. Mode changes CONCURRENT PRESSURE and RECOVERY only: threat budget, active
// cap, idle attack cadence, reinforcement pacing, boss add pacing/cap, enemy projectile
// speed, hazards, hearts, revive and down limits. Every knob multiplies the SAME
// baseline tables below — gameplay logic is never forked.
//
// STANDARD is the exact ×1.0 identity — the authored baseline the studio gate calibrates
// (§8: "mode modifiers are then applied around that validated baseline") — which is what
// keeps the golden-master oracle honest (goldens pin standard and stay byte-stable).
// CASUAL gives more reaction and recovery; BRUTAL increases composition/opportunity
// frequency without extra HP or ordinary damage.

export type Difficulty = "casual" | "standard" | "brutal";

export interface DifficultyDef {
  id: Difficulty;
  blurb: string;               // one-sentence run-setup description (menu + lobby)
  tint: string;                // HUD/menu accent for this mode
  // §1 pins normal/elite and boss HP at 1.00× in EVERY mode ("focused TTK stays
  // authored"); the typed seam stays so a future gate revision can recalibrate without
  // re-plumbing, and the balance suite asserts all three rows are exactly 1.
  enemyHpMult: number;
  bossHpMult: number;
  threatBudgetMult: number;    // floor threat budget + boss-floor escort density
  activeCapMult: number;       // active-threat cap (casual floors w/ min 6; brutal ceils w/ max 18)
  attackCdMult: number;        // enemy AND boss idle attack cooldowns (never tells/recovery)
  reinforceIntervalMult: number; // seconds between reinforcement release waves
  bossAddIntervalMult: number; // boss add cadence (first delay + per-phase interval)
  bossAddCapDelta: number;     // per-phase live add cap adjustment (clamped to ≥2)
  projectileSpeedMult: number; // enemy projectile speed (globs; never player bullets)
  hazardMult: number;          // hazard budget (currently the explosive-prop band lever)
  maxComplexPerRoom: number;   // simultaneous complex movers per room (readability guard)
  heartMult: number;           // §2 ambient heart-drop chances (enemy / crate / wood chest)
  bossChestHearts: number;     // hearts the boss chest ejects (the boss heart reward)
  reviveChannel: number;       // seconds an uninterrupted revive hold takes
  reviveHp: number;            // HP a revived player returns at
  floorDownLimit: number;      // downs per player per floor before spectating until descent
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  casual: {
    id: "casual",
    blurb: "More room to breathe \u2014 fewer foes at once, gentler pacing, richer recovery.",
    tint: "#7dd87d",
    enemyHpMult: 1.00, bossHpMult: 1.00,
    threatBudgetMult: 0.80, activeCapMult: 0.85, attackCdMult: 1.15,
    reinforceIntervalMult: 1.25, bossAddIntervalMult: 1.20, bossAddCapDelta: -1,
    projectileSpeedMult: 0.90, hazardMult: 0.65, maxComplexPerRoom: 1,
    heartMult: 1.25, bossChestHearts: 2, reviveChannel: 1.20, reviveHp: 3,
    floorDownLimit: Number.POSITIVE_INFINITY,
  },
  standard: {
    id: "standard",
    blurb: "The authored descent \u2014 dangerous, fair, and exactly as tuned.",
    tint: "#ffd166",
    enemyHpMult: 1.00, bossHpMult: 1.00,
    threatBudgetMult: 1.00, activeCapMult: 1.00, attackCdMult: 1.00,
    reinforceIntervalMult: 1.00, bossAddIntervalMult: 1.00, bossAddCapDelta: 0,
    projectileSpeedMult: 1.00, hazardMult: 1.00, maxComplexPerRoom: 2,
    heartMult: 1.00, bossChestHearts: 1, reviveChannel: 1.50, reviveHp: 2,
    floorDownLimit: 3,
  },
  brutal: {
    id: "brutal",
    blurb: "Denser waves, faster commits, leaner hearts \u2014 same foes, no sponges.",
    tint: "#ff6a6a",
    enemyHpMult: 1.00, bossHpMult: 1.00,
    threatBudgetMult: 1.20, activeCapMult: 1.15, attackCdMult: 0.85,
    reinforceIntervalMult: 0.85, bossAddIntervalMult: 0.85, bossAddCapDelta: 1,
    projectileSpeedMult: 1.10, hazardMult: 1.30, maxComplexPerRoom: 2,
    heartMult: 0.80, bossChestHearts: 1, reviveChannel: 1.80, reviveHp: 2,
    floorDownLimit: 2,
  },
};

export const DIFFICULTY_IDS = ["casual", "standard", "brutal"] as const satisfies readonly Difficulty[];

// The compatibility default for every claimless/legacy path: solo before a pick is made,
// quick play, dev tickets, tickets minted without a df claim, and old snapshots.
export const DEFAULT_DIFFICULTY: Difficulty = "standard";

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DIFFICULTIES, v);
}

export function difficultyThreatBudget(base: number, difficulty: Difficulty): number {
  // Standard IS the validated baseline and passes through untouched (gate §8); scaled
  // modes multiply AFTER summing and round to the nearest 0.5 so budgets stay on the
  // same half-point grid as the §2 threat costs. Party scaling (§4) applies on top.
  if (difficulty === "standard") return base;
  return Math.round(base * DIFFICULTIES[difficulty].threatBudgetMult * 2) / 2;
}

export function difficultyActiveCap(base: number, difficulty: Difficulty): number {
  // §1: casual 0.85× FLOORED with a 6-threat minimum (a mercy cap can never starve the
  // floor's composition); brutal 1.15× CEILED with an 18 ceiling. Standard passes the
  // authored formula through untouched. Applied to the SOLO cap; party scaling (§4)
  // multiplies on top, so the min/max anchor to the authored solo table.
  if (difficulty === "casual") return Math.max(6, Math.floor(base * DIFFICULTIES.casual.activeCapMult));
  if (difficulty === "brutal") return Math.min(18, Math.ceil(base * DIFFICULTIES.brutal.activeCapMult));
  return base;
}

export function difficultyBossAddCap(base: number, difficulty: Difficulty): number {
  // §1 "boss add interval / cap": casual −1 (never below 2 — adds are boss mechanics,
  // not optional), brutal +1, standard authored. A zero base (phase 0 slot) stays zero.
  if (base <= 0) return base;
  return Math.max(2, base + DIFFICULTIES[difficulty].bossAddCapDelta);
}

// ---- §1 player constants ----

export const PLAYER = {
  baseMaxHp: 6,
  moveSpeed: 200,
  postHitInvuln: 0.80,
  dashCooldown: 0.70,
  dashActive: 0.16,
  dashSpeed: 620,
  // Non-refreshing, non-overlapping dash iframe — a SEPARATE protection from the post-hit
  // invuln (0.80s), which must never extend it. At Second Wind Lv3 (CD 0.35s) the
  // theoretical uptime is 0.18/0.35 = 51.4%: excellent mobility, not immunity.
  dashIframe: 0.18,
} as const;

// ---- §2 sustain / heart economy (ambient healing roughly halved) ----

export const SUSTAIN = {
  enemyHeartDrop: 0.06,   // was 0.12
  crateHeartDrop: 0.06,   // was 0.15
  woodChestHeart: 0.15,   // was 0.20
  woodChestWeapon: 0.07,
  descentHeal: 0,         // was +2 — the descent is pacing, not a free mistake reset
  fullHpHeartCoins: 2,    // a loose heart at full HP is consumed and converts to coins
  // Recovery pity: after this many consecutive non-boss floors that generated zero hearts
  // while the party entered below 50% HP, force one heart into the next wood chest.
  pityFloors: 2,
  pityLowHpFrac: 0.5,
} as const;

// Dealer: a purchasable heart on every third floor (3/6/9, …). +1 HP, never a full heal.
// Co-op stocks P hearts (§8).
export const DEALER = {
  floorInterval: 3,
  price: 6,
  heal: 1,
} as const;

// Revive mechanics shared by every mode. The channel length and returned HP are difficulty
// knobs (studio gate §1: 1.20s/3HP casual, 1.50s/2HP standard, 1.80s/2HP brutal) — see
// DifficultyDef.reviveChannel / reviveHp. Any damage to the reviver cancels the channel.
export const REVIVE = {
  radius: 46,
  invuln: 1.0,
  fireLockout: 0.35, // a revived player cannot attack for this long
} as const;

// Vampire Fang: shared proc cooldown; boss-spawned/summoned adds are excluded from both
// Fang procs and natural heart drops (no farmable trivial sustain).
export const FANG_PROC_COOLDOWN = 1.25;

// ---- §3 regular enemy scaling (exact per-floor multiplier tables) ----

// Index 0 = floor 1; floors beyond 10 clamp to the last entry (the F1–10 envelope).
export const FLOOR_HP_MULT = [1.00, 1.25, 1.50, 1.72, 1.94, 2.12, 2.30, 2.47, 2.60, 2.71] as const;
export const FLOOR_SPEED_MULT = [1.00, 1.02, 1.04, 1.06, 1.07, 1.09, 1.11, 1.13, 1.14, 1.16] as const;

// Spec rounding: round-half-to-even reproduces every value in the §3 tables
// (bat F2 2.5→2, slime F3 4.5→4, skeleton F2 7.5→8).
export function roundHalfToEven(v: number): number {
  const floor = Math.floor(v);
  const frac = v - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function floorIndex(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  return Math.min(f, FLOOR_HP_MULT.length) - 1;
}

export function floorHpMult(floor: number): number {
  return FLOOR_HP_MULT[floorIndex(floor)];
}

export function floorSpeedMult(floor: number): number {
  return FLOOR_SPEED_MULT[floorIndex(floor)];
}

// ---- §4 threat budget, density and variety tiers (difficulty ≠ HP) ----

export function floorThreat(floor: number): number {
  return Math.min(30, 6 + 2 * (Math.max(1, floor) - 1));
}

export function activeThreatCap(floor: number): number {
  return Math.min(16, 8 + Math.max(1, floor));
}

export type EnemyTier = "swarm" | "standard" | "brute" | "elite";

export interface TierDef {
  hpMult: number;
  speedMult: number;
  radiusMult: number;
  drawMult: number;
  threatCost: number;
  minFloor: number;
  attackCdMult: number; // elite: one affix + 20% shorter commit cooldowns
}

export const TIERS: Record<EnemyTier, TierDef> = {
  swarm: { hpMult: 0.55, speedMult: 1.15, radiusMult: 0.78, drawMult: 0.78, threatCost: 0.55, minFloor: 1, attackCdMult: 1 },
  standard: { hpMult: 1.00, speedMult: 1.00, radiusMult: 1.00, drawMult: 1.00, threatCost: 1.0, minFloor: 1, attackCdMult: 1 },
  brute: { hpMult: 2.40, speedMult: 0.82, radiusMult: 1.30, drawMult: 1.35, threatCost: 2.2, minFloor: 4, attackCdMult: 1 },
  elite: { hpMult: 1.70, speedMult: 1.12, radiusMult: 1.08, drawMult: 1.12, threatCost: 2.8, minFloor: 6, attackCdMult: 0.8 },
};

// Brute damage rule: only its authored, clearly telegraphed commitment (the skeleton lunge)
// deals 2 — ordinary contact stays 1. No tier ever blanket-multiplies damage.
export const BRUTE_HEAVY_DAMAGE = 2;

// Room-composition guards (§4): readable pressure, never soup. The per-room complex-mover
// cap is a difficulty knob (studio gate §1: 1 / 2 / 2) — see DifficultyDef.maxComplexPerRoom.
export const BRUTE_ELITE_COMBO_FLOOR = 8; // no brute+elite in one room before this floor
export const ELITE_SPLIT_COUNT = 2;       // the shipped elite affix: splits into swarm units

// Reinforcement release pacing: pending threat trickles in as waves whenever the living
// active threat drops below the cap, spaced by this stagger so waves read as waves.
export const REINFORCE_STAGGER = 0.9;

// Biome pressure (§4): bodies/hazard modifiers, never HP. Indexed by biomeIndexForFloor.
export interface BiomePressure {
  budgetMult: number;      // threat-budget multiplier
  packBias: number;        // extra swarm-pack likelihood (Verdant +15% pack units)
  complexShare: number;    // ranged/kiter weight multiplier (Sunless 1.10×)
  hazardMult: number;      // explosive-prop bias (Deep 1.15×)
  reinforceRate: number;   // reinforcement release-rate multiplier (Emberreach 1.15×)
}

export const BIOME_PRESSURE: readonly BiomePressure[] = [
  { budgetMult: 1.00, packBias: 1.15, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.00 }, // Verdant
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.10, hazardMult: 1.00, reinforceRate: 1.00 }, // Sunless
  { budgetMult: 0.90, packBias: 1.00, complexShare: 1.00, hazardMult: 1.15, reinforceRate: 1.00 }, // Deep
  { budgetMult: 1.05, packBias: 1.00, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.15 }, // Emberreach
];

// ---- §5 Slime King (calibrated to ~37.5s median solo, ≥20s absolute floor) ----

export const BOSS = {
  // bossHP = max(round10(38 × medianPracticalDPS), ceil10((20 − forcedTransitionTime) × P95LegalSustainedDPS))
  // With median 24 DPS, P95 51 DPS, 2.4s forced transitions → 900 at the F5 encounter.
  baseHp: 900,
  baseHpFloor: 5,             // the floor the 900 calibration belongs to
  contactDamage: 2,           // was 3 — collision hurts, but can't delete half a base bar
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.7, 2.25] as readonly number[], // indexed by phase 1..3
  hopWindup: 0.65,
  hopLock: 0.32,
  hopAir: 0.45,
  hopRecover: 0.65,
  slamRadius: 90,
  slamInnerRadius: 55,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  globDamage: 1,
  radialWindup: 0.75,
  radialRecover: 0.60,
  radialCount: 10,            // 36° gaps
  packSurgeEvery: 2,          // every 2nd radial orders existing slimes into a delayed surge
  packSurgeDelay: 0.6,
  packSurgeDuration: 1.2,
  packSurgeSpeedMult: 1.6,
  // Phase thresholds, evaluated immediately after EVERY authoritative damage event.
  phaseAt: [0.70, 0.35] as readonly number[],
  phaseFloor: [0.62, 0.27] as readonly number[],
  roarDuration: 1.2,          // no invuln/reduction beat exceeds 1.2s; total forced 2.4s
  roarDamageReduction: 0.35,  // reduction, not immunity
  roarBulletClearRadius: 70,
  transitionAddCount: 2,      // two slimes at opposite marked edges
  addFirstAt: 4.5,
  addInterval: [0, 6.5, 6.5, 7.0] as readonly number[], // per phase 1..3
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 5, 5, 7] as readonly number[],
  p3ChaseMult: 1.12,          // was 1.2
  squeezeEvery: 3,            // every 3rd P3 attack is the arena squeeze
  squeezeTelegraph: 1.0,
  squeezeDuration: 3.0,
  squeezeStartRadius: 340,    // safe radius shrinks toward the boss…
  squeezeEndRadius: 150,      // …forcing movement into the fight
  squeezeDamage: 1,
} as const;

// Deeper boss floors (F10, …) scale off the same §3 HP curve, anchored at the F5
// calibration; the F10 result (≈1.40×) respects the ≤1.5× later-boss ceiling.
export function bossHpForFloor(floor: number): number {
  const scaled = BOSS.baseHp * (floorHpMult(floor) / floorHpMult(BOSS.baseHpFloor));
  return Math.round(scaled / 10) * 10;
}

// ---- §6 power budget: raw caps (temporary per-run blessings) ----
// The 4–6× strong-run fantasy is EXPRESSIVE capability (pellets/pierce/status/crit/
// positioning), never a product of raw flat stats. Enforced in the authoritative sim
// after a full build recompute from item levels.

export const CAPS = {
  damageMult: 2.25,
  fireRateMult: 1.80,
  moveSpeedMult: 1.35,
  maxHpBonus: 4,
  pierce: 3,          // blessing-ADDED pierce (weapon-intrinsic pierce is separate)
  elementalChance: 0.5,
} as const;

// Permanent (Foundation) power: no permanent gear system exists in the runtime yet; when
// it lands, the strongest legal loadout advantage must stay under this ceiling (§6/§7 gate 8).
export const PERMANENT_ADVANTAGE_CEILING = 0.30;

// ---- §8 co-op scaling (Stage C authoritative combat) ----
// P = living players snapshotted at encounter creation (floor build), clamped 1–4; living
// enemies are never rescaled on disconnect/down.

export const COOP = {
  maxPlayers: 4,
  mobHpPerExtra: 0.55,    // 1.00 / 1.55 / 2.10 / 2.65
  bossHpPerExtra: 0.65,   // 1.00 / 1.65 / 2.30 / 2.95
  threatPerExtra: 0.35,   // 1.00 / 1.35 / 1.70 / 2.05
  kbResistPerExtra: 0.20,
  heartRatePerExtra: 0.30,
  // Enemy damage: unchanged P1–3; ×1.10 at P4 authored as explicit integers — every
  // current source is 1 or 2, and both round back to themselves, so damage stays as-is.
} as const;

export function clampPlayers(players: number): number {
  return Math.max(1, Math.min(COOP.maxPlayers, Math.floor(players)));
}

export function coopMobHpMult(players: number): number {
  return 1 + COOP.mobHpPerExtra * (clampPlayers(players) - 1);
}

export function coopBossHpMult(players: number): number {
  return 1 + COOP.bossHpPerExtra * (clampPlayers(players) - 1);
}

export function coopThreatMult(players: number): number {
  return 1 + COOP.threatPerExtra * (clampPlayers(players) - 1);
}

export function coopKbResistMult(players: number): number {
  return 1 + COOP.kbResistPerExtra * (clampPlayers(players) - 1);
}

export function coopHeartRateMult(players: number): number {
  return 1 + COOP.heartRatePerExtra * (clampPlayers(players) - 1);
}
