// PVP (free-for-all arena deathmatch) — the ONE place every tunable pvp number, the symmetric
// arena, and the pure match helpers live, so the balancer and designer tune a single surface.
//
// This module is PURE (sim-only, no world.ts dependency): it owns config + arena geometry +
// deterministic helpers over plain data. The match STATE MACHINE and the damage funnel wiring
// live in world.ts (they mutate WorldState); they read the constants and helpers here. Keeping
// the split this way means pvp resolution never forks movement/shooting/collision — mode only
// selects which of the four gated concerns (damage targeting, arena, spawns, match) engages.

import { TILE } from "./types.js";
import type { WeaponId, Vec2, TileKind } from "./types.js";
import type { PlayerId } from "./input.js";
import type { Dungeon, Room } from "./dungeon.js";
import { TICKS_PER_SECOND } from "./kits.js";
import type { KitId } from "./kits.js";
import { PLAYER } from "./balance.js";
import { Rng } from "./rng.js";

// The world-content discriminant. "coop" is the DEFAULT everywhere (solo, legacy co-op, the
// authoritative shared dungeon) so every existing code path and golden master is zero-diff;
// "pvp" swaps ONLY the four gated concerns. Orthogonal to isSandbox/isShared/isCoop.
export type WorldMode = "coop" | "pvp";

export const pvpBlessingBlacklist = [
  "vampire_fang",
  "adrenaline",
  "berserk",
  "second_wind",
  "greed",
  "coin_magnet",
  "vitality",
  "juggernaut",
  "hold_fast",
  "nothing_wasted",
  "second_breath_muddy",
  "on_the_beat",
  "shared_rope",
  "crosscurrent",
  "last_warm_round",
  "known_by_touch",
  "remember_me",
  "carry_the_light",
  "blade_ward",
  "finisher",
] as const;

export type PvpDraftTrigger = "none" | "frag" | "time" | "dedup";

export const pvpUnsupportedWeaponIds: readonly WeaponId[] = [
  "mooring_nail",
  "sluicegate",
  "oddsmaker",
  "pathmaker",
  "resonant_fork",
  "red_pen",
  "margin_call",
  "sidewinder",
  "hushiron",
  "backtalk",
  "lamplighter",
  "faultlink",
];

const PVP_UNSUPPORTED_WEAPON_IDS = new Set<WeaponId>(pvpUnsupportedWeaponIds);

export function isPvpWeaponSupported(id: WeaponId): boolean {
  return !PVP_UNSUPPORTED_WEAPON_IDS.has(id);
}

// PVP WAVE 2 · PILLAR C draft kit counters — the three blessing ids, named once so the pool
// entry below and the match-sim gates in world.ts never drift. Each is an uncommon DRAFT blessing
// whose behavior lives in the pvp match sim (behind isPvp — co-op is inert), keyed off ownership.
export const PVP_COUNTER_BRACE = "brace_band";
export const PVP_COUNTER_SIGHT = "clear_eyes";
export const PVP_COUNTER_RIP = "rip_post";

// ---- PVP CONFIG (balancer + designer surface) ---------------------------------------------
// Numbers are the balancer finals (2026-07-15): FIXED 100 HP + a global 1.78x scalar
// (PvE damage 100% untouched) tuned to a ~4.0s median TTK (3-5s band), a small per-weapon
// outlier table, a 35%-of-maxHp anti-one-shot per-hit cap, ults blanket-disabled, and two-stage
// spawn protection. The match is a FRAG-LIMIT RESPAWN deathmatch (no rounds).
export const PVP = {
  // FIXED pvp HP pool — NOT the PvE 6-HP pool (too coarse). 100 gives smooth, readable TTK
  // (a hit = 3-8%). PvP-only; PvE maxHp is unchanged.
  maxHp: 100,
  // Global player-vs-player damage scalar, applied to pvp hits ONLY. Median gun ~4.5s TTK vs
  // 100 HP (1.78, bumped from 2.0 for the FFA respawn third-party reset beat).
  dmgMult: 1.78,
  // Per-weapon outliers that come in fast at the flat scalar — an EXTRA multiplier stacked on
  // top of dmgMult (final = raw * dmgMult * (weaponMult[id] ?? 1)) to pull them into band.
  // (ricochet/tesla/thumper come in slow ~5.8-6.7s — fine, left on the flat scalar.)
  weaponMult: {
    sawnoff: 0.45, // Boomstick (worst offender)
    flamer: 0.45,  // Dragon (players take no burn DoT — direct pellets only)
    burst: 0.72,   // Triplet
    sword: 0.47,   // Cutlass
    longsword: 0.52, // Claymore
    spear: 0.48,   // Pike
    beam: 0.85,    // Sunlance
  } as Partial<Record<WeaponId, number>>,
  // Anti-one-shot backstop: no single tick may remove more than this fraction of maxHp from a
  // player (35 of 100). Enforced as a per-victim-per-tick cumulative clamp, so even a
  // point-blank pellet stack can never one-shot.
  perHitCapFrac: 0.35,
  // The committed median 1v1 TTK band, including a fully drafted build.
  ttkMinSec: 3.5,
  ttkMaxSec: 5.5,
  // Player knockback uses the shipped per-weapon impulse in pixel space. Protection windows
  // null it entirely, and one hit can never cross the hard displacement ceiling.
  kbScalar: 1.0,
  kbMaxPerHit: 180,
  kbSelfDuringIframe: 0,
  // Documented balancer target. The authoritative perimeter layout is 3 tiles from its nearest
  // spawn and intentionally falls short; spawn protection is the hard anti-grief rule.
  pitEdgeClearance: 200,
  // Walkable floor tiles telegraph every lethal edge by this many full tiles.
  pitWarningBandTiles: 1,
  // Ring-out attribution remains attached to the most recent PvP attacker for this long.
  envKillCreditWindowSec: 2.0,
  // Two or more credited frags inside this window produce presentation-only chain juice.
  chainWindowSec: 5.0,
  // A free draft arrives on either personal-frag cadence or active-match cadence. Runtime
  // activation is room-policy authority in world.ts, never a mutable balance flag.
  draftEveryFrags: 3,
  draftEverySec: 45,
  draftOfferSec: 60,
  draftChoices: 3,
  // The curated pool contains mechanics with a working PvP identity. Flat commons and every
  // sustain, low-HP, economy, dash-cooldown, and flat-EHP blessing stay out.
  blessingBlacklist: pvpBlessingBlacklist,
  blessingPool: [
    "split_shot",
    "scattergun",
    "full_metal",
    "big_iron",
    "deadeye",
    "marksman",
    "heavy_rounds",
    "skirmisher",
    "executioner",
    "core_damage",
    "core_fire",
    "core_move",
    "core_dash",
    // PVP WAVE 2 · PILLAR C draft kit counters (all uncommon; behavior in the match sim).
    PVP_COUNTER_BRACE,
    PVP_COUNTER_SIGHT,
    PVP_COUNTER_RIP,
  ] as readonly string[],
  // Base offers favor uncommon mechanics. A bottom-third player receives one rarity-weight
  // bump on their own offer only; no live combat stat is changed.
  draftRarityWeight: { common: 0, uncommon: 6, rare: 3 } as const,
  comebackDraftTierBump: 1,
  // Match-point or the final clock window fires one presentation-only crescendo.
  suddenDeathFrags: 1,
  suddenDeathFinalSec: 30,
  // Guaranteed control time suppresses outgoing combat while movement, aim, and dash remain live.
  // The longer shield permits attacks, but the first legal attack ends it.
  spawnHardGraceSec: 0.75,
  spawnShieldSec: 2.0,
  spawnFallbackShieldSec: 3.0,
  deathWithinSpawnSec: 3.0,
  spawnMinOpponentDist: 192,
  spawnLosAimRange: 480,
  spawnProjectileHardHorizonSec: 0.75,
  spawnThreatHorizonSec: 1.5,
  spawnThreatOuterHorizonSec: 2.5,
  respawnLosPenalty: 600,
  respawnLosPenaltyCap: 1200,
  respawnAimPenalty: 800,
  respawnAimConeDeg: 35,
  respawnProjectileNearPenalty: 1200,
  respawnProjectileFarPenalty: 600,
  respawnCoverBonus: 300,
  respawnRecentPenalty: 400,
  respawnRecentOverride: 800,
  respawnCampRadius: 180,
  respawnWaitSafeIntervalSec: 0.10,
  respawnWaitSafeMaxSec: 0.75,
  // Respawn delay after death (frag-limit deathmatch: dead players respawn, never eliminate).
  respawnDelaySec: 2.5,
  // Pre-match countdown after enough players are present.
  countdownSec: 3.0,
  // Match time cap: at expiry the highest frag count wins (id-sorted tiebreak).
  matchTimeSec: 300,
  // The loop starts at 2 players — frag-limit respawn is a duel-to-N at 2 (fun at 2).
  minPlayers: 2,
  // Ults blanket-disabled for the MVP (every kit ult is degenerate in a duel). Named so v2
  // re-adds them tuned. When false the ult meter never charges and no ult ever fires in pvp.
  ultsEnabled: false,
  // Symmetric loadout: everyone gets the SAME neutral kit + weapon. "none" carries no stat
  // lean and no in-match power loop (no ult/momentum/lifesteal), which is exactly the flat
  // symmetric MVP the balancer's TTK numbers assume. Named so a tuned real kit is one line.
  kit: "none" as KitId,
  startWeapon: "pistol" as WeaponId,
};

// ---- PVP WAVE 2 · PILLAR A: CONTESTED HEARTH (HOLD_THE_HEARTH @ arena center) --------------
// The one objective tuning surface for the contested hearth (Quill FINAL 2026-07-18, PROTOCOL 47).
// A lone player standing UNCONTESTED on the arena-center hearth accrues Favor; a full stand arms
// one ember_edge charge (a flat next-gun-hit chip). Contested (>=2 living players in radius)
// PAUSES Favor; leaving the radius decays unarmed progress and, after a short hold, drops an
// armed charge. Death clears both. Every number is read only behind isPvp — co-op is inert.
export const HEARTH = {
  // Radius (px) of the center hearth ring, measured from the (9,9) centerPickup tile center.
  radius: 56,
  // Seconds of UNCONTESTED standing (exactly one living player in radius) per accrued Favor tick.
  favorTickSec: 0.50,
  // Favor ticks that ARM one ember_edge charge (2 x 0.50s = 1.0s of uncontested standing).
  favorTicksToArm: 2,
  // Unarmed Favor progress clears this long after the player leaves the radius.
  emptyDecaySec: 0.40,
  // An ARMED ember_edge charge survives at most this long after the player leaves the radius.
  armedHoldSec: 1.5,
  // ember_edge active window after arming — spent by the next gun hit or dropped at expiry.
  emberWindowSec: 4.0,
  // Flat PVP damage added to the next single gun hit while ember_edge is live. A flat chip only
  // (never multiplied by draft blessings / output scale), still clamped by the per-hit cap.
  emberBonusDamage: 8,
  // Knockback multiplier applied to that one ember_edge gun hit (still clamped by kbMaxPerHit).
  emberKbScalar: 1.15,
} as const;

// ---- PVP WAVE 2 · PILLAR B: RING WEATHER (the arena director) ------------------------------
// The one weather tuning surface (Quill FINAL 2026-07-18). A single DIRECTOR runs ONE ambient
// hazard event at a time on a seeded rotation (tar_bloom -> cinder_gust -> spark_mine -> repeat),
// spacing them by a fixed idle gap. Every event is ambient pressure that shapes the fight, never
// a kill by itself: tar only slows, gust only nudges, spark chips a capped micro-hit. All read
// behind isPvp — co-op is inert. The compact wire kind/phase names ("tar"/"gust"/"spark") match
// the HazardKind widening so the director state and the ground hazards speak one vocabulary.
export const WEATHER = {
  // Director cadence (seconds). The first event fires at live + firstEventSec; thereafter events
  // are spaced by idleGapSec of empty air. Sudden death tightens the CADENCE only (× the mult) —
  // never the damage or the drift (a presentation-faithful "storm closes in", not a power spike).
  firstEventSec: 8.0,
  idleGapSec: 10.0,
  suddenDeathIdleMult: 0.70,

  // B2 tar_bloom — 1..2 slow patches on the forced chokepoints (never the hearth / spawns / pits).
  // Ambient tar: no damage, it only drags the WALK (like the Weaver web) so a chokepoint costs
  // tempo to cross. Hard cap of 2 concurrent patches (the director's one-at-a-time already bounds
  // it; the cap is the belt-and-suspenders ceiling the placement asserts).
  tarMinPatches: 1,
  tarMaxPatches: 2,
  tarRadius: 40,
  tarLifeSec: 3.5,
  tarMoveMult: 0.70,

  // B1 cinder_gust — a telegraphed cardinal wind. tellSec of a building tell, then activeSec of a
  // soft positional drift (px/s) applied to bodies in the MID BAND (within midBandDist of the
  // hearth) that are NOT sheltered upwind by cover/wall. Seeded cardinal toward a pit side; a body
  // shoved into a pit rides Wave 1's env-kill credit window (2.0s), so the gust never steals a
  // frag it did not set up. Never damages.
  gustTellSec: 0.75,
  gustActiveSec: 1.80,
  gustDriftPxPerSec: 55,
  gustMidBandDist: 128,
  gustCoverProbePx: 56,

  // B3 spark_mine — a telegraphed floor mine in an annulus around the hearth. tellSec of a growing
  // telegraph ring (rides the hzds list like the volatile `charge` fuse), then a one-shot blast:
  // a flat capped chip + a micro knockback inside blastRadius. Never under spawn grace/shield (the
  // one funnel's protection gate), never a one-shot (the chip is a fraction of the per-hit cap).
  sparkAnnulusInner: 72,
  sparkAnnulusOuter: 110,
  sparkTellSec: 0.55,
  sparkBlastRadius: 36,
  sparkChipDamage: 12,
  sparkKnockback: 60,
} as const;

// The director's rotation vocabulary. Compact names shared with the HazardKind widening: "tar"
// and "spark" are ground hazards on the hzds list; "gust" is a director-only wind (no hazard).
export type PvpWeatherKind = "tar" | "gust" | "spark";
export type PvpWeatherPhase = "idle" | "tell" | "active";

// The seeded rotation. tar_bloom ships first (B2); the per-match start offset rotates it so no two
// seeds open on the same beat, but the cycle order is fixed and one-at-a-time.
export const PVP_WEATHER_ORDER: readonly PvpWeatherKind[] = ["tar", "gust", "spark"];

// Weather timers in TICKS (deterministic; never wall-clock). idleGap tightens in sudden death.
export function pvpWeatherFirstEventTicks(): number { return Math.round(WEATHER.firstEventSec * TICKS_PER_SECOND); }
export function pvpWeatherIdleGapTicks(isSuddenDeath: boolean): number {
  const sec = WEATHER.idleGapSec * (isSuddenDeath ? WEATHER.suddenDeathIdleMult : 1);
  return Math.round(sec * TICKS_PER_SECOND);
}
export function pvpWeatherGustTellTicks(): number { return Math.round(WEATHER.gustTellSec * TICKS_PER_SECOND); }
export function pvpWeatherGustActiveTicks(): number { return Math.round(WEATHER.gustActiveSec * TICKS_PER_SECOND); }
export function pvpWeatherTarLifeTicks(): number { return Math.round(WEATHER.tarLifeSec * TICKS_PER_SECOND); }
export function pvpWeatherSparkTellTicks(): number { return Math.round(WEATHER.sparkTellSec * TICKS_PER_SECOND); }

// A fresh deterministic stream for the weather event of the given ordinal — seeded off the match
// seed so every client + the server derive the SAME event placement/direction with zero wire cost.
function pvpWeatherRng(seed: number, ordinal: number): Rng {
  return new Rng(pvpMix32((seed ^ 0x52494e47) + Math.imul(ordinal + 1, 0x9e3779b1)));
}

// The rotation offset the match opens on (0..2), seeded off the match seed.
export function pvpWeatherStartCursor(seed: number): number {
  return ((pvpMix32(seed ^ 0x57454154) % PVP_WEATHER_ORDER.length) + PVP_WEATHER_ORDER.length)
    % PVP_WEATHER_ORDER.length;
}

// The seeded cardinal (0..3 = E/S/W/N unit) a gust event blows toward. Every cardinal faces a pit
// pocket in the 4-fold-symmetric arena, so any pick is a legitimate "toward the pit side".
export const PVP_WEATHER_CARDINALS: ReadonlyArray<Vec2> = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
];
export function pvpWeatherGustCardinal(seed: number, ordinal: number): number {
  return pvpWeatherRng(seed, ordinal).int(0, PVP_WEATHER_CARDINALS.length - 1);
}

// The 1..2 forced-chokepoint patch centers a tar_bloom event drops on, chosen (seeded, no repeats)
// from the arena's forcedChokepoints. Returns [] when the arena has none. Placement is BY DESIGN
// confined to the chokepoints, so it can never touch the hearth (9,9), a spawn pad, or a PIT_TILE.
export function pvpWeatherTarSpots(seed: number, ordinal: number, chokepoints: readonly Vec2[]): Vec2[] {
  if (chokepoints.length === 0) return [];
  const rng = pvpWeatherRng(seed, ordinal);
  const pool = chokepoints.map((c) => ({ x: c.x, y: c.y }));
  // Fisher-Yates over a copy (deterministic) so the picks are distinct chokepoints.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const maxCount = Math.min(WEATHER.tarMaxPatches, pool.length);
  const count = Math.max(WEATHER.tarMinPatches, rng.int(WEATHER.tarMinPatches, maxCount));
  return pool.slice(0, Math.min(count, maxCount));
}

// A deterministic ring of candidate spark-mine blast centers in the [inner,outer] annulus around
// the hearth. The caller walks them in order and takes the first one on open floor clear of the
// denylist (pits/spawns), so the pure helper stays geometry-only (no dungeon dependency here).
export function pvpWeatherSparkCandidates(seed: number, ordinal: number, hearthCenter: Vec2): Vec2[] {
  const rng = pvpWeatherRng(seed, ordinal);
  const base = rng.next() * Math.PI * 2;
  const out: Vec2[] = [];
  const RING = 12;
  for (let i = 0; i < RING; i++) {
    const ang = base + (i / RING) * Math.PI * 2;
    const t = rng.next();
    const radius = WEATHER.sparkAnnulusInner + t * (WEATHER.sparkAnnulusOuter - WEATHER.sparkAnnulusInner);
    out.push({ x: hearthCenter.x + Math.cos(ang) * radius, y: hearthCenter.y + Math.sin(ang) * radius });
  }
  return out;
}

// ---- PVP WAVE 2 · PILLAR C: DRAFT KIT COUNTERS (brace / sight / rip) -----------------------
// Three uncommon DRAFT blessings that answer specific kit pressure without ever removing agency
// (Quill FINAL 2026-07-18). Each is a soft, on-cadence counter — never immunity, never a kill,
// never a demolition. The blessing ids ride the existing SelfWire.items strip (no new wire field,
// no protocol bump); the per-life counter timers are server-owned transient (sub-10s, rebuilt
// after a resume, cleared on death), never reconciled. All read only behind isPvp — co-op is inert.
export const KIT_COUNTERS = {
  // brace_band (stackCategory pvp_brace): bank one brace charge every 7.0s (max 1); the next
  // incoming knockback while banked is HALVED (x0.50) and spends the charge — a soft anti-shove,
  // never full KB immunity, never pit immunity, never a spawn-shield extend.
  braceRechargeSec: 7.0,
  braceMaxCharges: 1,
  braceKbScalar: 0.50,
  // If the braced body ends within this ETA of the nearest pit edge (edge distance / walk speed),
  // a pit-warning pulse fires — PRESENTATION ONLY (it changes no state, grants no pit immunity).
  bracePitWarnEtaSec: 0.45,

  // clear_eyes (stackCategory pvp_sight): every 7.0s the pulse outlines the nearest foe within
  // 180px AND clear line-of-sight for 1.50s. Info only — no damage, no wallhack (LOS is required).
  sightPulseIcdSec: 7.0,
  sightRadius: 180,
  sightOutlineSec: 1.50,

  // rip_post (stackCategory pvp_rip): the next reload OR dash (whichever first) rips the post — it
  // clears tar under the body (r40) and chips ONE adjacent breakable cover by a single break tick
  // — then goes on an 8.0s cooldown. Never player damage, illegal pathing, or a demolition ult.
  ripIcdSec: 8.0,
  ripTarClearRadius: 40,
  ripCoverChipDamage: 1,
  // "Adjacent" cover: the nearest breakable prop whose EDGE is within this reach of the body.
  ripCoverReachPx: 60,
} as const;

// Counter timers in TICKS (deterministic; never wall-clock).
export function pvpBraceRechargeTicks(): number { return Math.round(KIT_COUNTERS.braceRechargeSec * TICKS_PER_SECOND); }
export function pvpSightPulseIcdTicks(): number { return Math.round(KIT_COUNTERS.sightPulseIcdSec * TICKS_PER_SECOND); }
export function pvpSightOutlineTicks(): number { return Math.round(KIT_COUNTERS.sightOutlineSec * TICKS_PER_SECOND); }
export function pvpRipIcdTicks(): number { return Math.round(KIT_COUNTERS.ripIcdSec * TICKS_PER_SECOND); }

// ---- PVP WAVE 3: ARENA ULTS (PROTOCOL 49) --------------------------------------------------
// Arena-only ults on the frag deathmatch (Quill FINAL 2026-07-18). A player CLAIMS one arena kit
// (ult skin only — start still pistol + equal HP; co-op stat lean / passive / co-op ult never
// apply), and a shared charge/cast model powers ONE of the four arena ult ids. The co-op ults
// (Overdrive/Sanctuary/Aegis/Phase) are HARD-banned in the arena — PVP.ultsEnabled stays false
// and they never select behind isPvp. All read only behind isPvp; co-op is byte-inert.
//
// The meter reuses the existing SelfWire.uc/ura fields (the fixed-point ult charge + the cast
// lockout tick). It is expressed in the Quill "meter points" domain (max 100.0), stored as an
// INTEGER in hundredths-of-a-point so accrual stays crisp and reads cleanly in a golden — which
// makes meterMax exactly 10000, numerically matching ULT.meterMax but a distinct arena surface.
export type ArenaUltKit = Exclude<KitId, "none">;
export type ArenaUltKind = "salvo" | "triage" | "shove" | "slip";

export const ARENA_ULT = {
  // Fixed-point meter: 100.0 points = 10000 hundredths (reuses SelfWire.uc). Full = ready.
  meterMax: 10000,
  // +0.35 points per 1 PVP damage DEALT (hundredths: 0.35 * 100 = 35).
  chargePerDamage: 35,
  // +4.0 points/s while uncontested HOLDing the Brazier — WIRED but idle on frag DM (no-op until
  // siege; the HOLD source never ticks without a Brazier objective). Kept so siege wires the path.
  holdParticipationPerSec: 400,
  // +0.25 points per 1 dmg to an Exposed Brazier — idle until siege (BREAK objective absent on DM).
  breakChipPerDamage: 25,
  // +1.0 points/s passive time (hundredths/s: 100).
  passivePerSec: 100,
  // Min cast spacing after a cast (the 8s hard floor, reuses SelfWire.ura like the co-op lockout).
  castSpacingSec: 8.0,
  // Tell floor shared by all four (>= 0.40s telegraph before the effect lands).
  tellSec: 0.40,
} as const;

// A1 arena_salvo (Gunner): a committed aimed volley — a 0.40s tell/aim-lock, then 5 shots over
// 0.55s at a flat 10 PVP dmg each with +1 pierce (volley only), while the caster runs GLASS
// (+25% incoming) for the whole tell+active 0.95s. No lasting fire-rate buff.
export const ARENA_SALVO = {
  tellSec: 0.40,
  volleySec: 0.55,
  shots: 5,
  perShotDamage: 10,
  bonusPierce: 1,           // +1 pierce on the volley only (each shot may pass through one foe)
  glassSec: 0.95,           // tell (0.40) + active (0.55); caster takes +25% incoming the whole time
  glassIncomingMult: 1.25,
  rangePx: 520,             // aimed hitscan reach across the arena (~19 tiles)
  shotRadiusPx: 8,          // hit half-width along the aimed ray
} as const;

// A2 arena_triage (Mender): a 0.40s tell, then +18 HP instant SELF heal (never past maxHp) and a
// cleanse of the tar slow + move slows. Never grounds a HoT / heals an ally / converts to shield.
export const ARENA_TRIAGE = {
  tellSec: 0.40,
  healSelf: 18,
  // Positional slows (tar/web) are re-derived every tick from standing ground, so the cleanse is
  // a brief slow-IMMUNITY window (never a lasting buff) that also drops any current drag.
  cleanseSec: 0.60,
} as const;

// A3 arena_bulwark_shove (Bulwark): a 0.40s tell, then a 0.75s frontal wall (70° arc, 48px reach)
// that blocks ONE foe shot then shatters (or expires). The shatter shoves frontal foes 90px (brace
// can half it). Never an HP dome — it is a single-shot frontal parry + shove.
export const ARENA_SHOVE = {
  tellSec: 0.40,
  wallLifeSec: 0.75,
  arcDeg: 70,
  reachPx: 48,
  shatterKb: 90,
} as const;

// A4 arena_slip (Phantom): a 0.40s tell, then a ~90px blink along aim with a 0.40s i-frame, then a
// visible 0.35s end-lag (NO i-frame — the recovery is the counter-window). Never an ally aura.
export const ARENA_SLIP = {
  tellSec: 0.40,
  iframeSec: 0.40,
  blinkPx: 90,
  endlagSec: 0.35,
} as const;

// The arena ult a claimed kit fires. Pure so the sim + client + tests agree on the mapping.
export function arenaUltKindForKit(kit: ArenaUltKit): ArenaUltKind {
  switch (kit) {
    case "gunner": return "salvo";
    case "mender": return "triage";
    case "bulwark": return "shove";
    case "phantom": return "slip";
  }
}

// Arena charge helpers (fixed-point hundredths-of-a-point; integer, deterministic).
export function arenaUltPassiveChargePerTick(): number {
  return Math.max(1, Math.round(ARENA_ULT.passivePerSec / TICKS_PER_SECOND));
}
export function arenaUltChargeFromDamage(dmg: number): number {
  return dmg <= 0 ? 0 : Math.max(0, Math.round(dmg * ARENA_ULT.chargePerDamage));
}
export function clampArenaUltCharge(charge: number): number {
  return charge < 0 ? 0 : charge > ARENA_ULT.meterMax ? ARENA_ULT.meterMax : Math.floor(charge);
}
export function isArenaUltMeterFull(charge: number): boolean {
  return charge >= ARENA_ULT.meterMax;
}
// Ready === meter full AND past the 8s cast-spacing lockout (server-only truth; a client asks).
export function canCastArenaUlt(charge: number, tick: number, readyAtTick: number): boolean {
  return isArenaUltMeterFull(charge) && tick >= readyAtTick;
}
export function arenaUltCastSpacingTicks(): number { return Math.round(ARENA_ULT.castSpacingSec * TICKS_PER_SECOND); }
export function arenaUltTellTicks(): number { return Math.round(ARENA_ULT.tellSec * TICKS_PER_SECOND); }
// Even shot cadence across the volley window (5 shots over 0.55s -> one every 0.11s).
export function arenaSalvoShotSpacingSec(): number { return ARENA_SALVO.volleySec / ARENA_SALVO.shots; }

// The match timers are counted in TICKS (never ms / wall-clock) for determinism; these convert
// the named second-values at the authoritative tick rate.
export function pvpRespawnDelayTicks(): number { return Math.round(PVP.respawnDelaySec * TICKS_PER_SECOND); }
export function pvpSpawnHardGraceTicks(): number { return Math.round(PVP.spawnHardGraceSec * TICKS_PER_SECOND); }
export function pvpSpawnShieldTicks(): number { return Math.round(PVP.spawnShieldSec * TICKS_PER_SECOND); }
export function pvpSpawnFallbackShieldTicks(): number {
  return Math.round(PVP.spawnFallbackShieldSec * TICKS_PER_SECOND);
}
export function pvpDeathWithinSpawnTicks(): number {
  return Math.round(PVP.deathWithinSpawnSec * TICKS_PER_SECOND);
}
export function pvpRespawnWaitSafeIntervalTicks(): number {
  return Math.round(PVP.respawnWaitSafeIntervalSec * TICKS_PER_SECOND);
}
export function pvpRespawnWaitSafeMaxTicks(): number {
  return Math.round(PVP.respawnWaitSafeMaxSec * TICKS_PER_SECOND);
}
export function pvpCountdownTicks(): number { return Math.round(PVP.countdownSec * TICKS_PER_SECOND); }
export function pvpMatchTimeTicks(): number { return Math.round(PVP.matchTimeSec * TICKS_PER_SECOND); }
export function pvpEnvKillCreditWindowTicks(): number { return Math.round(PVP.envKillCreditWindowSec * TICKS_PER_SECOND); }
export function pvpChainWindowTicks(): number { return Math.round(PVP.chainWindowSec * TICKS_PER_SECOND); }
export function pvpDraftEveryTicks(): number { return Math.round(PVP.draftEverySec * TICKS_PER_SECOND); }
export function pvpDraftOfferTicks(): number { return Math.round(PVP.draftOfferSec * TICKS_PER_SECOND); }
export function pvpSuddenDeathFinalTicks(): number { return Math.round(PVP.suddenDeathFinalSec * TICKS_PER_SECOND); }

// Hearth timers in TICKS (deterministic). armTicks is the full uncontested stand that arms a
// charge; the others are the decay/hold/window windows named in HEARTH.
export function pvpHearthFavorTickTicks(): number { return Math.round(HEARTH.favorTickSec * TICKS_PER_SECOND); }
export function pvpHearthArmTicks(): number { return pvpHearthFavorTickTicks() * HEARTH.favorTicksToArm; }
export function pvpHearthEmptyDecayTicks(): number { return Math.round(HEARTH.emptyDecaySec * TICKS_PER_SECOND); }
export function pvpHearthArmedHoldTicks(): number { return Math.round(HEARTH.armedHoldSec * TICKS_PER_SECOND); }
export function pvpHearthEmberWindowTicks(): number { return Math.round(HEARTH.emberWindowSec * TICKS_PER_SECOND); }

// Favor pips (0..favorTicksToArm) earned from raw uncontested standing ticks — the HUD readout.
export function pvpHearthFavorPips(favorTicks: number): number {
  const per = pvpHearthFavorTickTicks();
  return Math.min(HEARTH.favorTicksToArm, Math.floor(Math.max(0, favorTicks) / per));
}

// Is `point` inside the hearth ring centered at `center`? The ONE geometry predicate the sim's
// occupancy scan and the client's marker both key off, so radius is defined in exactly one place.
export function isWithinHearth(point: Vec2, center: Vec2): boolean {
  return Math.hypot(point.x - center.x, point.y - center.y) <= HEARTH.radius;
}

function pvpPlayerIdHash(id: PlayerId): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function pvpMix32(value: number): number {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed | 0;
}

export function pvpDraftSeed(seed: number, pid: PlayerId, triggerTick: number, ordinal: number): number {
  let mixed = pvpMix32(seed ^ 0x50565044);
  mixed = pvpMix32(mixed ^ pvpPlayerIdHash(pid));
  mixed = pvpMix32(mixed ^ triggerTick);
  return pvpMix32(mixed ^ Math.imul(ordinal, 0x9e3779b1));
}

export function pvpComebackTierBump(
  scores: ReadonlyMap<PlayerId, number>,
  playerIds: readonly PlayerId[],
  pid: PlayerId,
): number {
  if (playerIds.length < 2) return 0;
  const ranked = playerIds
    .slice()
    .sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const leaderScore = Math.max(...ranked.map((id) => scores.get(id) ?? 0));
  if ((scores.get(pid) ?? 0) >= leaderScore) return 0;
  const trailingCount = Math.ceil(ranked.length / 3);
  return ranked.slice(0, trailingCount).includes(pid) ? PVP.comebackDraftTierBump : 0;
}

// Frags to win, SCALED by the match-start player count: clamp(round(6 + playerCount), 8, 16) —
// 2p:8, 4p:10, 6p:12. Resolved once at the live whistle so a mid-match join never moves the goal.
export function pvpFragLimit(playerCount: number): number {
  const n = Math.round(6 + Math.max(0, playerCount));
  return n < 8 ? 8 : n > 16 ? 16 : n;
}

// The final player-vs-player damage for one hit BEFORE the per-tick cap: global scalar times
// the per-weapon outlier multiplier. PvE damage never routes through here.
export function pvpHitDamage(weapon: WeaponId, rawDamage: number): number {
  return rawDamage * PVP.dmgMult * (PVP.weaponMult[weapon] ?? 1);
}

// The absolute per-hit/per-tick damage cap (HP), derived from the fixed maxHp.
export function pvpPerHitCap(): number {
  return PVP.perHitCapFrac * PVP.maxHp;
}

// A participant in the foe test: the (team, id) pair the damage funnel already carries for the
// attacker and the target. A named struct (not four same-typed positional args) so a call site
// can never silently transpose team/id or attacker/target — the swap-prone shape the audit flagged.
export interface PvpActor { team: number; id: PlayerId }

// FFA foe test: distinct players are foes unless they share a NON-ZERO team. team 0 = "no
// team" (every-man-for-himself), so in the MVP every distinct player is a foe. The team axis
// exists purely so future team modes drop in without touching the damage funnel.
export function arePvpFoes(a: PvpActor, b: PvpActor): boolean {
  if (a.id === b.id) return false;
  if (a.team === 0 || b.team === 0) return true;
  return a.team !== b.team;
}

// ---- match state --------------------------------------------------------------------------

// lobby: waiting for >= minPlayers. countdown: spawns assigned, brief freeze-in. live: the
// deathmatch (respawns, frag scoring). over: a winner is decided (frag limit or time cap).
export type MatchPhase = "lobby" | "countdown" | "live" | "over";

export interface MatchState {
  phase: MatchPhase;
  // The tick a TIMED phase ends (countdown -> live; the live time cap). 0 when untimed.
  phaseEndTick: number;
  // Frags per player, keyed by PlayerId (deterministic scoreboard). Winner = most frags.
  scores: Map<PlayerId, number>;
  // Frags to win, resolved at the live whistle from the player count (pvpFragLimit). 0 until then.
  fragLimit: number;
  // Decided winner id once phase === "over" (null otherwise).
  winner: PlayerId | null;
  // The arena's symmetric spawn CANDIDATES (tile-center px), static for the match. The spread
  // assignment / respawn picks a subset (farthest-from-opponents) deterministically.
  spawns: Vec2[];
  // Per-victim pvp damage applied THIS tick — the accumulator behind the per-hit cap. Cleared
  // at the top of every world step; never serialized (transient scratch).
  dmgThisTick: Map<PlayerId, number>;
  // Per-killer chain timing. Presentation reads the emitted event only; these maps never grant
  // combat stats and never leave the authoritative sim.
  lastFragTick: Map<PlayerId, number>;
  fragChain: Map<PlayerId, number>;
  isSuddenDeath: boolean;
  // Authored lethal-pit centers used by deterministic, pit-aware spawn selection.
  pits: Vec2[];
  // The contested-hearth center (tile-center px), reused from the arena centerPickup at (9,9).
  // Static for the match; the Favor/ember_edge occupancy scan measures every player against it.
  hearthCenter: Vec2;
  // Authored forced-chokepoint centers (tile-center px), the ONLY ground tar_bloom may bloom on
  // (never the hearth / spawns / pits). Static for the match.
  forcedChokepoints: Vec2[];
  // PVP WAVE 2 · PILLAR B: the ring-weather director. One event at a time on the seeded rotation.
  weather: WeatherDirectorState;
}

// The ring-weather director state — a single one-at-a-time machine. `kind` is the active event
// (null while idle); `phase` distinguishes the harmless tell from the active window; `phaseEndTick`
// is the absolute tick the current phase ends; `cursor` is the next rotation index; `ordinal`
// counts events begun (it seeds each event's placement RNG); `gustDir` is the active gust's seeded
// cardinal (0..3). All of it is server-authoritative; the wire projects kind/phase/dir for VFX.
export interface WeatherDirectorState {
  kind: PvpWeatherKind | null;
  phase: PvpWeatherPhase;
  phaseEndTick: number;
  cursor: number;
  ordinal: number;
  gustDir: number;
}

export function createWeatherDirector(): WeatherDirectorState {
  return { kind: null, phase: "idle", phaseEndTick: 0, cursor: 0, ordinal: 0, gustDir: 0 };
}

export function createMatchState(
  spawns: Vec2[],
  pits: Vec2[] = [],
  hearthCenter: Vec2 = { x: 0, y: 0 },
  forcedChokepoints: Vec2[] = [],
): MatchState {
  return {
    phase: "lobby",
    phaseEndTick: 0,
    scores: new Map(),
    fragLimit: 0,
    winner: null,
    spawns,
    dmgThisTick: new Map(),
    lastFragTick: new Map(),
    fragChain: new Map(),
    isSuddenDeath: false,
    pits,
    hearthCenter,
    forcedChokepoints,
    weather: createWeatherDirector(),
  };
}

export function pvpPitEdgeDistance(point: Vec2, pit: Vec2): number {
  const dx = Math.max(0, Math.abs(point.x - pit.x) - TILE / 2);
  const dy = Math.max(0, Math.abs(point.y - pit.y) - TILE / 2);
  return Math.hypot(dx, dy);
}

export function pvpNearestPitEdgeDistance(point: Vec2, pits: readonly Vec2[]): number {
  let nearest = Infinity;
  for (const pit of pits) nearest = Math.min(nearest, pvpPitEdgeDistance(point, pit));
  return nearest;
}

export function pvpSingleDashDistance(): number {
  return PLAYER.dashSpeed * PLAYER.dashActive;
}

function pitDistanceWeight(point: Vec2, pits: readonly Vec2[]): number {
  const distance = pvpNearestPitEdgeDistance(point, pits);
  return Number.isFinite(distance) ? distance : 0;
}

// The spawn index farthest from every listed occupied position (deterministic: ties break to
// the LOWEST index). Used for greedy spread-placement at match start (occupied = already-placed
// players). Pit distance shares the score so equally spread choices favor safer ground.
export function farthestSpawnIndex(spawns: Vec2[], occupied: Vec2[], pits: readonly Vec2[] = []): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < spawns.length; i++) {
    let minD = Infinity;
    for (const o of occupied) {
      const dx = spawns[i].x - o.x;
      const dy = spawns[i].y - o.y;
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
    }
    if (occupied.length === 0) minD = 0;
    const pitDistance = pitDistanceWeight(spawns[i], pits);
    if (pits.length > 0 && pitDistance <= pvpSingleDashDistance()) continue;
    const score = minD + pitDistance;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

export interface PvpRespawnCandidate {
  index: number;
  minOpponentDistance: number;
  pitDistance: number;
  losThreatCount: number;
  isAimedAt: boolean;
  incomingThreatEtaSec: number | null;
  predictedIncomingDamage: number;
  isCoveredFromNearest: boolean;
  isInwardExitWalkable: boolean;
  isCamped: boolean;
  isPitEligible: boolean;
}

export const PVP_RESPAWN_THREAT = {
  los: 1 << 0,
  aim: 1 << 1,
  projectileNear: 1 << 2,
  projectileFar: 1 << 3,
  camp: 1 << 4,
  pit: 1 << 5,
} as const;

export interface PvpRespawnTelemetry {
  spawnTick: number;
  activeTicks: number;
  threatFlags: number;
  chosenIndex: number;
  safeCount: number;
  waitSafeMs: number;
  timeToFirstInputMs: number | null;
  shieldBreakMs: number | null;
  firstDamageMs: number | null;
  isShieldBrokenByAttack: boolean;
  isDeathWithin3s: boolean;
  isRepeatedIndex: boolean;
  isFallbackShield: boolean;
  killerDistance: number | null;
}

export function pvpRespawnProjectilePenalty(candidate: PvpRespawnCandidate): number {
  const eta = candidate.incomingThreatEtaSec;
  if (eta === null) return 0;
  if (eta <= PVP.spawnThreatHorizonSec) return PVP.respawnProjectileNearPenalty;
  if (eta <= PVP.spawnThreatOuterHorizonSec) return PVP.respawnProjectileFarPenalty;
  return 0;
}

export function isPvpRespawnImmediateProjectileThreat(candidate: PvpRespawnCandidate): boolean {
  return candidate.incomingThreatEtaSec !== null
    && candidate.incomingThreatEtaSec <= PVP.spawnProjectileHardHorizonSec;
}

export function isPvpRespawnCandidateSafe(candidate: PvpRespawnCandidate): boolean {
  return candidate.isPitEligible
    && !candidate.isCamped
    && candidate.minOpponentDistance >= PVP.spawnMinOpponentDist
    && !isPvpRespawnImmediateProjectileThreat(candidate)
    && !(candidate.losThreatCount > 0 && candidate.isAimedAt);
}

export function isPvpRespawnCandidateThreatened(candidate: PvpRespawnCandidate): boolean {
  return !isPvpRespawnCandidateSafe(candidate);
}

export function pvpRespawnThreatFlags(candidate: PvpRespawnCandidate): number {
  let flags = 0;
  if (candidate.losThreatCount > 0) flags |= PVP_RESPAWN_THREAT.los;
  if (candidate.isAimedAt) flags |= PVP_RESPAWN_THREAT.aim;
  const eta = candidate.incomingThreatEtaSec;
  if (eta !== null && eta <= PVP.spawnProjectileHardHorizonSec) flags |= PVP_RESPAWN_THREAT.projectileNear;
  else if (eta !== null && eta <= PVP.spawnThreatOuterHorizonSec) flags |= PVP_RESPAWN_THREAT.projectileFar;
  if (candidate.isCamped) flags |= PVP_RESPAWN_THREAT.camp;
  if (!candidate.isPitEligible) flags |= PVP_RESPAWN_THREAT.pit;
  return flags;
}

export function pvpRespawnBaseScore(candidate: PvpRespawnCandidate): number {
  const losPenalty = Math.min(
    PVP.respawnLosPenaltyCap,
    candidate.losThreatCount * PVP.respawnLosPenalty,
  );
  const coverBonus = candidate.isCoveredFromNearest && candidate.isInwardExitWalkable
    ? PVP.respawnCoverBonus
    : 0;
  return candidate.minOpponentDistance
    + 0.5 * candidate.pitDistance
    + coverBonus
    - losPenalty
    - (candidate.isAimedAt ? PVP.respawnAimPenalty : 0)
    - pvpRespawnProjectilePenalty(candidate);
}

function pvpRespawnScore(
  candidate: PvpRespawnCandidate,
  candidates: readonly PvpRespawnCandidate[],
  recentSpawnIndices: readonly number[],
): number {
  let score = pvpRespawnBaseScore(candidate);
  if (!recentSpawnIndices.includes(candidate.index)) return score;
  const alternatives = candidates.filter((other) => other.index !== candidate.index);
  const bestAlternative = alternatives.reduce(
    (best, other) => Math.max(best, pvpRespawnBaseScore(other)),
    -Infinity,
  );
  const isRecentPenaltyWaived = alternatives.length === 0
    || score - bestAlternative > PVP.respawnRecentOverride;
  if (!isRecentPenaltyWaived) score -= PVP.respawnRecentPenalty;
  return score;
}

export function pvpRespawnValidCandidates(
  candidates: readonly PvpRespawnCandidate[],
  recentSpawnIndices: readonly number[] = [],
): PvpRespawnCandidate[] {
  if (candidates.length === 0) return [];
  const pitEligible = candidates.filter((candidate) => candidate.isPitEligible);
  let valid = pitEligible.length > 0 ? pitEligible : candidates.slice();
  const noImmediateProjectile = valid.filter((candidate) =>
    !isPvpRespawnImmediateProjectileThreat(candidate)
  );
  if (noImmediateProjectile.length > 0) valid = noImmediateProjectile;
  const nonCamped = valid.filter((candidate) => !candidate.isCamped);
  if (nonCamped.length > 0) valid = nonCamped;
  const farEnough = valid.filter((candidate) =>
    candidate.minOpponentDistance >= PVP.spawnMinOpponentDist
  );
  if (farEnough.length > 0) valid = farEnough;
  const nonLos = valid.filter((candidate) => candidate.losThreatCount === 0);
  if (nonLos.length > 0) {
    valid = valid.filter((candidate) =>
      candidate.losThreatCount === 0 || !candidate.isAimedAt
    );
  }
  const last = recentSpawnIndices.at(-1);
  const previous = recentSpawnIndices.at(-2);
  if (last !== undefined && last === previous) {
    const alternatives = valid.filter((candidate) => candidate.index !== last);
    if (alternatives.length >= 2) valid = alternatives;
  }
  return valid;
}

export type PvpRespawnSelectionMode = "normal" | "timeout";

export function pvpRespawnIndex(
  candidates: readonly PvpRespawnCandidate[],
  recentSpawnIndices: readonly number[] = [],
  mode: PvpRespawnSelectionMode = "normal",
): number {
  if (candidates.length === 0) return 0;
  let valid = pvpRespawnValidCandidates(candidates, recentSpawnIndices);
  let best = valid[0];
  let bestScore = pvpRespawnScore(best, valid, recentSpawnIndices);
  for (let i = 1; i < valid.length; i++) {
    const candidate = valid[i];
    const score = pvpRespawnScore(candidate, valid, recentSpawnIndices);
    if (mode === "timeout") {
      if (candidate.predictedIncomingDamage < best.predictedIncomingDamage
        || (candidate.predictedIncomingDamage === best.predictedIncomingDamage
          && (pvpRespawnProjectilePenalty(candidate) < pvpRespawnProjectilePenalty(best)
            || (pvpRespawnProjectilePenalty(candidate) === pvpRespawnProjectilePenalty(best)
              && (candidate.losThreatCount < best.losThreatCount
                || (candidate.losThreatCount === best.losThreatCount
                  && (score > bestScore || (score === bestScore && candidate.index < best.index)))))))) {
        best = candidate;
        bestScore = score;
      }
      continue;
    }
    if (score > bestScore || (score === bestScore && candidate.index < best.index)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.index;
}

// ---- symmetric arena ----------------------------------------------------------------------

// The AUTHORITATIVE arena grid (game designer, independently re-verified 4-fold symmetric): a
// 19x19 square (0..18, center 9,9), clipped corners, 8 spawn candidates, and breakable-prop
// cover pieces. All groups are invariant under the 90° rotation rot90(x,y)=(y,18-x) — the pvp
// tests assert this. Cover is destructible props (not walls), so the arena degrades over a match
// (thinning cover → late-game raw aim), and props block movement + bullets via the shared sim.
// ARENA_N is the tunable size dial (design band 15..21); the coord tables below are hand-authored
// for 19 (the GD's exact grid), so retuning the size means re-authoring them for 4-fold symmetry.
const ARENA_N = 19;

// Wall cells cut from each corner (an octagon-ish clip so no one-angle corner camp), 4-fold
// symmetric. Listed verbatim from the authoritative grid.
const CLIP_WALLS: ReadonlyArray<[number, number]> = [
  [0, 0], [1, 0], [0, 1], [17, 0], [18, 0], [18, 1],
  [0, 17], [0, 18], [1, 18], [18, 17], [17, 18], [18, 18],
];

// Spawn CANDIDATES (8): 4 edge-mids + 4 diagonals. The match picks the N-most-spread subset
// deterministically (greedy farthest-from-placed). Diagonals are listed as point-opposite pairs
// so the greedy's lowest-index tiebreak yields OPPOSITE diagonals at 6p (max spread), matching the
// authoritative selection: 2->opposite edge-mids, 4->all edge-mids, 6->edge-mids + opposite diagonals.
const SPAWN_TILES: ReadonlyArray<[number, number]> = [
  [9, 3], [3, 9], [9, 15], [15, 9],   // edge-mids
  [12, 6], [6, 12], [6, 6], [12, 12], // diagonals (opposite pairs consecutive)
];

// Breakable cover (16 props): center knot (center 9,9 stays OPEN), four mid pairs, four corner
// blockers. Every piece stays disjoint from the authoritative perimeter pit pockets.
const COVER_TILES: ReadonlyArray<[number, number]> = [
  [8, 8], [10, 8], [8, 10], [10, 10],                 // center knot
  [9, 6], [9, 7], [6, 9], [7, 9], [9, 12], [9, 11], [12, 9], [11, 9], // mid pairs
  [3, 3], [15, 3], [3, 15], [15, 15],                 // corner blockers
];

// Authoritative perimeter pockets: eight 2-tile falls, invariant under rot90(x,y)=(y,18-x).
export const PIT_TILES: ReadonlyArray<[number, number]> = [
  [6, 2], [6, 3], [12, 2], [12, 3],
  [2, 6], [3, 6], [2, 12], [3, 12],
  [6, 15], [6, 16], [12, 15], [12, 16],
  [15, 6], [16, 6], [15, 12], [16, 12],
];

const CENTER_PICKUP_TILE: readonly [number, number] = [9, 9];
const FORCED_CHOKE_TILES: ReadonlyArray<[number, number]> = [
  [9, 8], [10, 9], [9, 10], [8, 9],
];

function tileCenter(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

export function isPvpPitWarningTile(dungeon: Dungeon, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= dungeon.w || ty >= dungeon.h) return false;
  if (dungeon.tiles[ty * dungeon.w + tx] !== 0) return false;
  const band = Math.max(0, Math.floor(PVP.pitWarningBandTiles));
  for (let dy = -band; dy <= band; dy++) {
    for (let dx = -band; dx <= band; dx++) {
      if (dx === 0 && dy === 0) continue;
      const px = tx + dx;
      const py = ty + dy;
      if (px < 0 || py < 0 || px >= dungeon.w || py >= dungeon.h) continue;
      if (dungeon.tiles[py * dungeon.w + px] === 2) return true;
    }
  }
  return false;
}

export interface PvpArena {
  dungeon: Dungeon;
  spawns: Vec2[];
  cover: Vec2[];
  pits: Vec2[];
  pitWarnings: Vec2[];
  centerPickup: Vec2;
  forcedChokepoints: Vec2[];
}

// The FIXED symmetric FFA arena. Reuses the same Dungeon/Room shape the renderer + pathfinder
// consume (the SAME seam the dev sandbox's buildArena() uses to suppress population); the caller
// places `cover` as breakable props. `spawns` are the candidate points; `cover` the prop coords.
export function buildPvpArena(): PvpArena {
  const n = ARENA_N;
  const tiles: TileKind[] = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const isBorder = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      tiles[y * n + x] = isBorder ? 1 : 0;
    }
  }
  for (const [x, y] of CLIP_WALLS) tiles[y * n + x] = 1;
  const reservedTileKeys = new Set([
    ...CLIP_WALLS,
    ...SPAWN_TILES,
    ...COVER_TILES,
    CENTER_PICKUP_TILE,
    ...FORCED_CHOKE_TILES,
  ].map(([x, y]) => `${x},${y}`));
  for (const [x, y] of PIT_TILES) {
    if (reservedTileKeys.has(`${x},${y}`)) throw new Error("PVP pit overlaps reserved arena geometry");
  }
  for (const [x, y] of PIT_TILES) tiles[y * n + x] = 2;
  const spawns: Vec2[] = SPAWN_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  const cover: Vec2[] = COVER_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  const pits: Vec2[] = PIT_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  const c = (n - 1) >> 1; // center tile (9)
  const room: Room = { id: 0, x: 1, y: 1, w: n - 2, h: n - 2, cx: c, cy: c, kind: "normal", shape: "arena" };
  const dungeon: Dungeon = { w: n, h: n, tiles, rooms: [room], edges: [], blueprint: null, spawn: { x: c, y: c }, exit: { x: c, y: c } };
  const pitWarnings: Vec2[] = [];
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (isPvpPitWarningTile(dungeon, tx, ty)) pitWarnings.push(tileCenter(tx, ty));
    }
  }
  for (const [tx, ty] of PIT_TILES) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (dungeon.tiles[ny * n + nx] === 2) continue;
      if (!isPvpPitWarningTile(dungeon, nx, ny)) {
        throw new Error("PVP pit warning band is obstructed");
      }
    }
  }
  if (PVP.pitWarningBandTiles * TILE > pvpSingleDashDistance()) {
    throw new Error("PVP pit warning band exceeds one dash");
  }
  const centerPickup = tileCenter(...CENTER_PICKUP_TILE);
  const forcedChokepoints = FORCED_CHOKE_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  for (const spawn of spawns) {
    if (pvpNearestPitEdgeDistance(spawn, pits) <= pvpSingleDashDistance()) {
      throw new Error("PVP spawn violates pit dash clearance");
    }
  }
  const warningKeys = new Set(pitWarnings.map((point) => `${point.x},${point.y}`));
  if (cover.some((point) => warningKeys.has(`${point.x},${point.y}`))) {
    throw new Error("PVP cover obstructs pit warning band");
  }
  return { dungeon, spawns, cover, pits, pitWarnings, centerPickup, forcedChokepoints };
}

// The 90° rotation the arena is symmetric under — in tile space rot90(tx,ty)=(ty,N-1-tx), which
// in tile-CENTER px is (p.y, N*TILE - p.x). Exported so the pvp test can assert the arena walls +
// spawn set + cover are rotation-invariant (provably fair).
export function pvpArenaRot90(p: Vec2): Vec2 {
  return { x: p.y, y: ARENA_N * TILE - p.x };
}
