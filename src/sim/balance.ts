// The versioned BalanceDef — every gameplay-balance number from
// docs/specs/blobrogue_BALANCE_FINAL_impl.md, reconciled against the studio-wide
// docs/specs/blobrogue_STUDIO_BALANCE_GATE.md (Standard baseline), lives HERE, in one
// deterministic module the pure sim consumes (LocalTransport solo and the authoritative
// server run the same data).
// Design rule (spec §0): difficulty comes from techniques, telegraphed commitments, room
// composition, movement and scarcity — HP is a calibration output, never the difficulty lever.
//
// Engine-mechanical constants that are not balance (pathfinding cadence, knockback physics,
// status-system plumbing) stay in constants.ts.

import type { EnemyKind, WeaponId } from "./types.js";

export const BALANCE_VERSION = 4;

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
// Co-op stocks P hearts (§8). Studio gate §4: the Dealer also stocks max(2, P) DISTINCT
// weapons at the fixed 12/18/24 price ladder — purchases are personal and never deplete a
// teammate's stock (an owned weapon is simply walked past).
export const DEALER = {
  floorInterval: 3,
  price: 6,
  heal: 1,
  weaponPrices: [12, 18, 24, 24] as readonly number[], // by stock slot; 4th holds at 24
} as const;

export function dealerWeaponStock(players: number): number {
  return Math.max(2, clampPlayers(players));
}

// Studio gate §4 weapon-opportunity rules: party size buys OPTIONS, never rarity/power.
// Normal floor pedestal rolls (weapons stocked into the floor's chests): P1–2 roll 1,
// P3–4 roll 2, distinct IDs when the pool permits.
export function pedestalWeaponRolls(players: number): number {
  return Math.max(1, Math.ceil(clampPlayers(players) / 2));
}

// Boss weapon reward: P+1 distinct personal CHOICES (capped 5). Each player claims one;
// a claim never removes a teammate's options.
export function bossWeaponChoices(players: number): number {
  return Math.min(5, clampPlayers(players) + 1);
}

// Revive (studio balance gate §6, Standard baseline): 1.5s UNINTERRUPTED channel — any
// reviver damage, dash, attack, or leaving the radius cancels the whole channel (hard
// reset, no partial credit). One reviver only; extra players never accelerate.
export const REVIVE = {
  radius: 46,
  channel: 1.5,
  hp: 2,
  invuln: 1.0,
  fireLockout: 0.35, // a revived player cannot attack for this long
  // Down limit per floor (gate §1, Standard): after this many downs on one floor the player
  // is OUT — unrevivable until the party's descent rescues them at the stairs.
  downsPerFloor: 3,
} as const;

// Wipe (gate §6): the run ends only after every connected player has been down
// SIMULTANEOUSLY for this long — a held beat, not an instant cut. Reconnect reservations
// neither block nor extend it (absent bodies are outside the calculus — the coherence
// system's rule). Solo-local keeps the classic instant game over.
export const WIPE_HOLD_SECONDS = 4.0;

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
  // Balancer final: elites are 2.0× their chassis (retired: the 1.7× multiple AND the
  // interim uniform pool). The elite identity is the visible BRACE commitment (below),
  // not an HP wall: focused 1.5–2.5s, aggro→death 2.5–5.5s.
  elite: { hpMult: 2.0, speedMult: 1.12, radiusMult: 1.08, drawMult: 1.12, threatCost: 2.8, minFloor: 6, attackCdMult: 0.8 },
};

// The elite's one visible affix COMMITMENT (balancer final): a braced defensive
// reposition — 0.9s slide away from the attacker at ≤25% damage reduction (never
// immunity), a ≥0.5s recover, and a cooldown that keeps the duty cycle ≤35%. Triggered
// the first time the elite is bloodied (and again off cooldown), so any elite that
// survives >1.5s shows its affix.
export const ELITE_BRACE = {
  triggerHpFrac: 0.85,
  duration: 1.1,
  recover: 0.5,
  cooldown: 4.0,
  damageReduction: 0.25,
  slideSpeed: 230,
} as const;

// Brute damage rule: only its authored, clearly telegraphed commitment (the skeleton lunge)
// deals 2 — ordinary contact stays 1. No tier ever blanket-multiplies damage.
export const BRUTE_HEAVY_DAMAGE = 2;

// Room-composition guards (§4): readable pressure, never soup.
export const MAX_COMPLEX_PER_ROOM = 2;
export const BRUTE_ELITE_COMBO_FLOOR = 8; // no brute+elite in one room before this floor
export const ELITE_SPLIT_COUNT = 2;       // the shipped elite affix: splits into swarm units

// Studio gate §1 (Standard): never more than 2 complex MOVERS live simultaneously — the
// charge/burrow verbs that deny standard answers. Enforced at the spawn split and again
// at every reinforcement release.
export const MAX_COMPLEX_MOVERS_ACTIVE = 2;
// Studio gate §2: max one burrower AND one shielder per room, and no flock pack may
// consume more than 35% of the room's threat spend.
export const MAX_BURROWERS_PER_ROOM = 1;
export const MAX_SHIELDERS_PER_ROOM = 1;
export const FLOCK_THREAT_SHARE_MAX = 0.35;

// Reinforcement release pacing: pending threat trickles in as waves whenever the living
// active threat drops below the cap, spaced by this stagger so waves read as waves.
export const REINFORCE_STAGGER = 0.9;

// Biome pressure (§4): bodies/hazard modifiers, never HP. Indexed by biomeIndexForFloor.
export interface BiomePressure {
  budgetMult: number;      // threat-budget multiplier
  packBias: number;        // extra swarm-pack likelihood (Amberwild +15% pack units)
  complexShare: number;    // ranged/kiter weight multiplier (Sunless 1.10×)
  hazardMult: number;      // explosive-prop bias (Deep 1.15×)
  reinforceRate: number;   // reinforcement release-rate multiplier (Emberreach 1.15×)
}

// ---- studio gate: difficulty modes (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §1) ----
// Standard is the authored experience; Casual is forgiveness, Brutal is pressure — never
// sponges, never shortened tells. Only the HAZARD rows are implemented here (the hazard
// system consumes them today, mode-parameterized and gate-tested); the combat rows
// (HP/threat/cooldown/heart multipliers) land with the difficulty system itself,
// extending this same table.

export type Difficulty = "casual" | "standard" | "brutal";

export interface HazardModeRules {
  budgetMult: number;         // scales the floor's hazard-unit budget (§1 hazard row)
  roomSimultaneousCap: number; // max hazard groups active at one instant in one room (§2)
  roomDenialCap: number;       // max fraction of a room's open floor claimed by hazards (§2)
}

export const HAZARD_DIFFICULTY: Record<Difficulty, HazardModeRules> = {
  casual: { budgetMult: 0.65, roomSimultaneousCap: 1, roomDenialCap: 0.25 },
  standard: { budgetMult: 1.00, roomSimultaneousCap: 2, roomDenialCap: 0.35 },
  brutal: { budgetMult: 1.30, roomSimultaneousCap: 3, roomDenialCap: 0.45 },
};

// Rows follow the canonical curriculum bands (blobrogue_ENCOUNTER_CURRICULUM_spec.md §0),
// plus the terminal post-F30 Null expansion band. Content's accepted values win where
// the two branches tuned the same region (Gilded Archive).
export const BIOME_PRESSURE: readonly BiomePressure[] = [
  { budgetMult: 1.00, packBias: 1.15, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.00 }, // Amberwild
  { budgetMult: 1.00, packBias: 1.20, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.05 }, // Rootbound Warrens (formation density)
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.10, hazardMult: 1.00, reinforceRate: 1.00 }, // Sunless Caves
  { budgetMult: 0.90, packBias: 1.00, complexShare: 1.00, hazardMult: 1.15, reinforceRate: 1.00 }, // The Deep
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.05, hazardMult: 1.00, reinforceRate: 1.00 }, // Gilded Archive (order/claimed space)
  { budgetMult: 1.05, packBias: 1.00, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.15 }, // Emberreach
  { budgetMult: 1.05, packBias: 1.10, complexShare: 1.10, hazardMult: 1.15, reinforceRate: 1.10 }, // The Null
];

// ---- §5 Slime King (studio gate §3: F5, 900 HP, median 35–50s, high-roll 20–25s) ----

export const BOSS = {
  // HP = max(round10(targetMedianBurn × medianPracticalDPS),
  //          ceil10((minLegalTTK − forcedTransitionTime) × P95LegalDPS))   [gate §3]
  // The gate's initial Standard-solo calibration is 900, but its own rule recalibrates HP
  // from measurement whenever the legal arsenal changes (this wave added Thumper/
  // Sunlance) — ours are deterministic sim-harness measurements, not live telemetry:
  // at 900 the fastest legal build (point-blank sawnoff + Deadeye Lv3 + Glass Cannon)
  // measures 19.0s — under the 20s high-roll floor. The anti-burst term lands 950:
  // median 48.2s ∈ 35–50, fastest legal high-roll 22.8s ∈ 20–25 (see balance tests).
  baseHp: 950,
  baseHpFloor: 5,             // the floor the 950 calibration belongs to
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

// Should the King reappear past the authored ladder (seeded deep rotation, F30+), it
// scales off the same §3 HP curve, anchored at the F5 calibration; the curve clamps at
// F10 (≈1.40×), respecting the gate's ≤1.5× later-boss effective-health ceiling.
export function bossHpForFloor(floor: number): number {
  const scaled = BOSS.baseHp * (floorHpMult(floor) / floorHpMult(BOSS.baseHpFloor));
  return Math.round(scaled / 10) * 10;
}

// ---- §5b MARROW (corrected gate §3: F15, 1,250 HP, median 35–50s, high-roll 20–25s) ----
// A LINE fight, not an area fight: sidestep the charge lanes, weave the volleys/spiral,
// and punish the wall crash. Its transition beat is a bone SHIELD instead of a roar:
// identical anti-burst plumbing (damage reduction + hard HP floor + queued overflow), but
// INTERACTIVE — killing both summoned husks drops the shield early (.9–2.6s at 35%).

export const MARROW = {
  // The corrected gate pins the in-flight kit as authoritative: charge tell .9 / lock .5
  // / 520 for 1.1s / recover .7 or crash 1.6; 65/30 thresholds with 57/22 floors;
  // 1,250 HP at the F15 slot (the §3 curve clamps at F10, so the calibration carries).
  baseHp: 1250,
  baseHpFloor: 15,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.6, 2.2] as readonly number[], // indexed by phase 1..3
  // Line charge: long windup, long lane, and a wall crash that self-stuns (the punish window).
  chargeWindup: 0.9,
  chargeLock: 0.5,
  chargeSpeed: 520,
  chargeDur: 1.1,
  chargeRecover: 0.7,
  crashStun: 1.6,
  crashShards: [0, 0, 6, 8] as readonly number[],    // ring size on a wall crash, per phase
  // Bone-shard volley: an aimed fan that widens with the phase.
  volleyWindup: 0.7,
  volleyLock: 0.4,
  volleyRecover: 0.6,
  volleyShards: [0, 3, 5, 7] as readonly number[],   // fan size per phase 1..3
  volleySpread: 0.22,                                // radians between fan shards
  shardSpeed: 300,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.4,
  // P3 spiral barrage: every 3rd attack, a stationary rotating pair-emitter you weave through.
  spinEvery: 3,
  spinWindup: 0.8,
  spinDuration: 2.2,
  spinInterval: 0.22,   // seconds between shard pairs
  spinStep: 0.55,       // radians the spiral advances per pair
  spinRecover: 0.8,
  // Phase thresholds/floors (65/30, floors 57/22), evaluated after EVERY authoritative
  // damage event (like §5).
  phaseAt: [0.65, 0.30] as readonly number[],
  phaseFloor: [0.57, 0.22] as readonly number[],
  shieldDuration: 2.6,        // max beat length when the husks are ignored (attackable at 65%)
  shieldMinDuration: 0.9,     // the beat always reads, even if the husks die instantly
  shieldDamageReduction: 0.35, // reduction, not immunity — same principle as the roar
  shieldBulletClearRadius: 70,
  shieldHusks: 2,             // summoned at opposite marked edges; killing both breaks early
  addFirstAt: 5,
  addInterval: [0, 7, 7, 7] as readonly number[],
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 4, 4, 6] as readonly number[],
  p3ChaseMult: 1.10,
} as const;

// Deep bosses ride the same clamped §3 curve off their own calibration anchor (beyond F10
// the envelope is flat, so deeper encounters stay at the anchor).
function anchoredBossHp(baseHp: number, anchorFloor: number, floor: number): number {
  return Math.round((baseHp * (floorHpMult(floor) / floorHpMult(anchorFloor))) / 10) * 10;
}

export function marrowHpForFloor(floor: number): number {
  return anchoredBossHp(MARROW.baseHp, MARROW.baseHpFloor, floor);
}

// ---- §5c THE HOLLOW CHOIR (corrected gate §3: F30 finale, median 40–58s, high-roll ≥22s) ----
// The grieving ghost mass: it does not zone you with bodies — it UNMAKES itself. On
// cadence it fades intangible and drifts through you (a breather you must keep moving
// through), then rematerializes into a burst; its volleys are slow HOMING wails you juke
// by turning, not by standing behind cover. Transition beats SPLIT it into three wisps —
// kill them to force it back together early (the wisps ARE the boss during the beat).

export const CHOIR = {
  // The corrected gate lists 1,130 as the in-flight initial; at the F30 median build it
  // burns in ≈34s (deterministic sim harness, not live telemetry) — under the 40s floor —
  // so the §3 recalibration formula lands the anchor below (measured in-band; see
  // balance tests).
  baseHp: 1450,
  baseHpFloor: 30,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.8, 2.4] as readonly number[],
  // The fade: telegraph, then intangible drift toward the target, then a rematerialize
  // burst (P2+) into a long recover — the punish window for tracking it through the fade.
  fadeEvery: 3,
  fadeWindup: 0.6,
  fadeDuration: 1.8,
  fadeSpeedMult: 1.6,
  fadeRecover: 0.8,
  burstShards: [0, 0, 8, 10] as readonly number[], // rematerialize ring per phase
  burstSpeed: 240,
  // Homing wails: slow, readable seekers with a capped turn rate — orbit them off.
  wailWindup: 0.7,
  wailLock: 0.4,
  wailRecover: 0.6,
  wailCount: [0, 2, 3, 4] as readonly number[],
  wailSpread: 0.5,
  wailSpeed: 150,
  wailTurnRate: 2.4,
  wailRadius: 8,
  wailDamage: 1,
  wailLife: 2.6,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
  // Transition beats: the Choir scatters into wisps (it is GONE — untargetable, but the
  // wisps ARE the active pressure) until they die or the cap elapses. Queued overflow
  // lands when it reforms, same §5 contract. Corrected: 65/30 thresholds, 57/22 floors,
  // split 1–3.2s.
  phaseAt: [0.65, 0.30] as readonly number[],
  phaseFloor: [0.57, 0.22] as readonly number[],
  splitDuration: 3.2,
  splitMinDuration: 1.0,
  splitWisps: 3,
  splitBulletClearRadius: 70,
} as const;

export function choirHpForFloor(floor: number): number {
  return anchoredBossHp(CHOIR.baseHp, CHOIR.baseHpFloor, floor);
}

// ---- §5d THE WEAVER (corrected gate §3: F20, median 38–55s, high-roll ≥20s) ----
// The duelist that fights the FLOOR: webs are persistent slow-zones that shrink your
// dance space (never damage — routing pressure), and its pounce is a marked drop from
// above that chains in later phases. Small, fast, evasive — hard to pin, exactly like
// the roster spec's duelist.

export const WEAVER = {
  // The corrected gate lists 1,080 as the in-flight initial and recalibrates by
  // measurement for the intended floor's legal build pool (§3) — deterministic
  // sim-harness numbers, not live telemetry: at the F20 median build 1,080 burns in
  // ≈32s — under the 38s floor — so the formula lands 1,500 (measured in-band; see
  // balance tests).
  baseHp: 1500,
  baseHpFloor: 20,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.7, 2.3] as readonly number[],
  // Weave: plants a locked pattern of webs on and around the target's position.
  weaveWindup: 0.7,
  weaveLock: 0.35,
  weaveRecover: 0.7,
  webCount: [0, 3, 3, 4] as readonly number[],
  webRingDist: 130,
  webRadius: 62,
  webLife: 12,
  webSlow: 0.55,       // player move-speed multiplier inside a web (enemies unaffected)
  maxWebs: 8,          // hard cap: the arena squeezes, it never fills
  // Pounce per the corrected in-flight contract: tell .65 / lock .3 / .35 air / .9
  // recover; P2+ chains a second, shorter-telegraph leap (chains 1/2/2).
  pounceWindup: 0.65,
  pounceLock: 0.3,
  pounceChainWindup: 0.5,
  pounceChainLock: 0.2,
  pounceAir: 0.35,
  pounceRecover: 0.9,
  pounceRadius: 74,
  pounceInnerRadius: 44,
  pounceCenterDamage: 2,
  pounceOuterDamage: 1,
  pounceChains: [0, 1, 2, 2] as readonly number[], // chained leaps per commitment (P2+)
  pounceWebRadius: 52,
  // Molt beat: a fixed 1.4s cocoon (roar semantics) that bursts into a web-bolt ring +
  // two broodlings. Corrected thresholds 65/30, floors 57/22.
  phaseAt: [0.65, 0.30] as readonly number[],
  phaseFloor: [0.57, 0.22] as readonly number[],
  moltDuration: 1.4,
  moltDamageReduction: 0.35,
  moltBoltCount: 8,
  moltBoltSpeed: 260,
  moltBulletClearRadius: 70,
  moltAdds: 2,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
} as const;

export function weaverHpForFloor(floor: number): number {
  return anchoredBossHp(WEAVER.baseHp, WEAVER.baseHpFloor, floor);
}

// ---- §5e THE GILDED WARDEN (corrected gate §3: F25, median 40–58s, high-roll ≥22s) ----
// The armored tempo boss: its plate chips incoming damage to 30% at ALL times except the
// EXPOSED window — the long recover after each committed quake/sweep, when the plate
// hangs open. You do not out-DPS the Warden whenever you like; you dodge the commitment,
// then unload into the opening. Reduction, never immunity: impatient chip still works,
// it is just the slow way.
// The corrected gate lists 800 as the in-flight initial "valid only if its closed-armor/
// exposure cycle lands inside its gate" — at the F25 median build 800 burns in ≈26s,
// under the 40s floor, so the §3 recalibration formula lands 1,280 (measured in-band;
// see balance tests). Jet stays post-F30 expansion content; the Warden holds F25.

export const GILDED = {
  baseHp: 1280,
  baseHpFloor: 25,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.6, 3.2, 2.8] as readonly number[],
  armorChip: 0.3,       // closed-plate damage multiplier (never zero)
  // Anvil slam: a marked in-place quake with a directional aftershock line, then the
  // exposed recover — the fight's core loop.
  slamWindup: 0.8,
  slamLock: 0.45,
  slamActive: 0.3,
  slamRecover: 2.2,     // the EXPOSED window
  slamRadius: 110,
  slamInnerRadius: 66,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  slamLineShards: 3,
  slamLineSpeed: 300,
  slamLineGap: 0.16,    // radians between aftershock shards
  // Gold sweep: slow, heavy rings you walk through; P3 releases two offset waves.
  sweepWindup: 0.75,
  sweepRecover: 2.0,    // also exposed
  sweepCount: 10,
  sweepSpeed: 190,
  sweepWaves: [0, 1, 1, 2] as readonly number[],
  sweepWaveGap: 0.4,
  shardRadius: 8,
  shardDamage: 1,
  shardLife: 3.0,
  // Sanctify beat: fixed-duration roar semantics — corrected contract 70/35 thresholds,
  // 62/27 floors, 1.2s transition at 35% reduction (the King's sturdier shape).
  phaseAt: [0.70, 0.35] as readonly number[],
  phaseFloor: [0.62, 0.27] as readonly number[],
  sanctifyDuration: 1.2,
  sanctifyDamageReduction: 0.35,
  sanctifyBulletClearRadius: 70,
} as const;

export function gildedHpForFloor(floor: number): number {
  return anchoredBossHp(GILDED.baseHp, GILDED.baseHpFloor, floor);
}

// ---- §5f the F10 MINIBOSS GAUNTLET (corrected gate §3, exact formula) ----
// Three sequential CAPTAINS derived from calibrated Marrow HP — commander round10(.28×),
// elite round10(.32×), brute round10(.40×), total 1.00× — with 5s intermissions after
// rounds 1 and 2, never more than one captain alive, and the next spawn waiting until
// the prior captain, its summons AND its hazards are all dead/cleared. Round composition
// per the gate: R1 Charger commander + max 4 simple adds; R2 Shielder elite + max 3
// ranged adds; R3 brute Burrower alone. Each captain runs TWO phases split at 50% with
// one 0.8s NON-invulnerable transition and no phase floor. +1 heart drops only after R2;
// no blessing until the full clear (the premium chest carries the rare offer).

export interface GauntletRound {
  kind: EnemyKind;
  tier: EnemyTier;
  hpFrac: number;        // fraction of the calibrated Marrow HP (.28/.32/.40)
  addKind: EnemyKind | null;
  addTier: EnemyTier;
  addCount: number;
}

export const GAUNTLET = {
  floor: 10,
  intermission: 5,          // seconds after R1 and R2 before the next captain enters
  captainPhaseAt: 0.5,      // two phases split at 50%…
  captainTransition: 0.8,   // …one short stagger, non-invulnerable, no floor
  // Round threat stays inside the gate caps (≤8/≤8/≤6 counting the captain's elite/brute
  // pricing): R1 4.2 + 3×1.0 = 7.2, R2 4.2 + 3×0.825 ≈ 6.7, R3 3.3 alone.
  rounds: [
    { kind: "charger", tier: "elite", hpFrac: 0.28, addKind: "slime", addTier: "standard", addCount: 3 },
    { kind: "shielder", tier: "elite", hpFrac: 0.32, addKind: "spitter", addTier: "swarm", addCount: 3 },
    { kind: "burrower", tier: "brute", hpFrac: 0.40, addKind: null, addTier: "swarm", addCount: 0 },
  ] as readonly GauntletRound[],
  heartAfterRound: 2,       // +1 heart only after R2
  // The premium reward: the gauntlet's boss chest bakes the Burst rifle — Rootbound's
  // formation-fire signature (no full boss signature is duplicated).
  chestWeapon: "burst" as WeaponId,
} as const;

export function gauntletCaptainHp(round: GauntletRound): number {
  return Math.round((round.hpFrac * MARROW.baseHp) / 10) * 10;
}

// ---- §3 the boss-facing damage model ("no legal build below high-roll minimum") ----
// The balancer's remediation path, implemented WITHOUT any runtime clamp: repeat-hit
// bugs are gone (the spent-round rule, regression-gated), raw caps hold across 100k
// generated builds, and the two offending interactions are re-coefficiented AGAINST
// BOSSES/CAPTAINS ONLY — room/multitarget power is untouched:
//   1. Boss VULNERABILITY is one capped channel and status amps are OUT of it: against
//      a boss-grade body, shock/frozen deal their utility (arcs, slow, DoT) but no
//      damage amplification, and the crit multiplier counts at most 1.35× — combined
//      vulnerability ≤1.35, non-multiplicative by construction. Rooms keep the full
//      multiplicative behavior (Deadeye Lv3 crits at 3.0×, statuses amplify).
//   2. Pellet boss coefficient: a big body soaking every stacked pellet was the
//      single-target exploit. Native pellets beyond the first count at 75% against
//      boss-grade bodies; ADDED pellets (Split Shot / Scattergun) count 0 — they stay
//      full-power room tools. Rooms always take full pellet damage.
//   3. Per-family boss coefficients for the measured offenders (full-arsenal god-stack
//      sweep): the point-blank hoses (flamer, sawnoff), the sustained pin (beam), the
//      burst/cannon/railgun nukes and the melee blade loop — each sized so its 12-pick
//      god stack lands ≥ the minimum, with room damage untouched.
// The 100k practical-DPS estimator gate (balance tests) proves the strongest legal build
// stays under every per-boss DPS ceiling: King 53 / Marrow 68 / Weaver 87 / Warden 65 /
// Choir 65 — each ceiling = HP over (minimum TTK − forced transition time).

export const BOSS_MIN_LEGAL_TTK: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: 20, marrow: 20, weaver: 20, gilded: 22, choir: 22,
};

// Per-boss practical-DPS ceilings from the balancer (HP / (minTtk − forced downtime)).
export const BOSS_DPS_CEILING: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: 53, marrow: 68, weaver: 87, gilded: 65, choir: 65,
};

// Boss-facing combat coefficients (rooms/multitarget are never touched).
export const BOSS_VULN_CAP = 1.35;           // the crit channel's cap vs boss-grade bodies
export const BOSS_NATIVE_PELLET_COEF = 0.75; // native pellets beyond the first
export const BOSS_EXTRA_PELLET_COEF = 0;     // added pellets: room tools, zero vs bosses
export const WEAPON_BOSS_COEF: Readonly<Partial<Record<WeaponId, number>>> = {
  beam: 0.75,     // sustained pin: 100% uptime on an arena-sized body
  sawnoff: 0.5,   // point-blank full-fan burst
  flamer: 0.55,   // point-blank sustained hose
  burst: 0.75,    // highest per-volley nuke of the precise family
  cannon: 0.95,
  railgun: 0.9,
  sword: 0.7,     // the melee loop parks on the body with zero travel/spread loss
  longsword: 0.7,
};

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

// ---- §8b party weapon opportunities (studio balance gate §4 — Stage C shared worlds only) ----
// Quantity increases OPTIONS, never rarity or stats: weapon stats and roll pools are
// identical solo/co-op; only opportunity COUNTS follow the gate's exact formulas, and every
// count is deterministic per (seed, floor, P). The local solo economy is untouched
// (golden-locked); a shared world applies §4 at every P including 1.

export const WEAPON_ECONOMY = {
  // Dealer stall prices by slot (gate: "prices unchanged 12/18/24") — a fourth stall (P4)
  // clamps to the last price. Purchases are PERSONAL: a stall never depletes for teammates.
  dealerPrices: [12, 18, 24] as readonly number[],
  // Boss reward choices are capped regardless of party size.
  bossChoiceCap: 5,
  // Boss weapon claims expire on the sim clock like blessing offers (the descend gate must
  // always drain); each claimant gets exactly one reroll, never coins/raw damage.
  claimTtl: 60,
  claimRerolls: 1,
  // Starvation guard (gate §4): no player goes more than this many consecutive non-boss
  // floors without a weapon opportunity — the next floor force-stocks a pedestal.
  maxDroughtFloors: 2,
} as const;

// Weapons per pedestal (gate: `max(1, ceil(P/2))` — P1–2: 1, P3–4: 2), distinct IDs when
// the pool permits. The pedestal COUNT per floor stays the solo cadence.
export function pedestalWeaponsFor(players: number): number {
  return Math.max(1, Math.ceil(clampPlayers(players) / 2));
}

// Dealer weapon stalls (gate: `max(2,P)` distinct weapons) — Stage C shared worlds only.
export function dealerWeaponStockFor(players: number): number {
  return Math.max(2, clampPlayers(players));
}

export function dealerWeaponPriceFor(slot: number): number {
  const prices = WEAPON_ECONOMY.dealerPrices;
  return prices[Math.min(Math.max(0, slot), prices.length - 1)];
}

// Boss weapon reward (gate: `P+1` distinct choices, capped 5): every member claims ONE
// personal choice from the shared set; claims never remove choices for teammates.
export function bossWeaponChoicesFor(players: number): number {
  return Math.min(clampPlayers(players) + 1, WEAPON_ECONOMY.bossChoiceCap);
}
