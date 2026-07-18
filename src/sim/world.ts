// The pure, isomorphic simulation core. WorldState is plain data; stepWorld advances it
// one tick from per-player InputCmds and returns the SimEvents that fired (the client
// turns those into juice; a server would ignore most). No DOM, rendering, audio, or
// wall-clock time here — time is the passed dt + state.tick.
//
// This is game.ts's old update(dt) reorganized: the single implicit player became a
// players map (Stage A runs one), every this.px/hp/... became p.x/hp/..., and every FX
// call became an events.push(...). Behavior is preserved byte-for-byte (proven by the
// golden-master oracle).

import { generateDungeon } from "./dungeon.js";
import {
  type EncounterState,
  initArenaEncounter,
  initHuntEncounter,
  initSplitEncounter,
  initEscapeEncounter,
  initClaimantEncounter,
  initEscortEncounter,
  isEncounterObjectiveComplete,
  completeEncounter,
  cloneEncounter,
  setEncounterCarrier,
} from "./encounter.js";

export type { EncounterState } from "./encounter.js";
export {
  createIdleEncounter,
  initArenaEncounter,
  initHuntEncounter,
  initSplitEncounter,
  initEscapeEncounter,
  initClaimantEncounter,
  initEscortEncounter,
  initSmokeEncounter,
  isEncounterObjectiveComplete,
  completeEncounter,
  cloneEncounter,
  setEncounterCheckpoint,
  setEncounterCarrier,
  bumpEncounterProgress,
  encounterEqual,
} from "./encounter.js";
import type { Dungeon, Room } from "./dungeon.js";
import { roomIdAt, neighbors } from "./dungeon.js";
import type { FlowField } from "./pathfind.js";
import { createNav, markNavTargets, navChaseField, navReachField, navClassFor, navStepPoint, navPoint } from "./nav.js";
import type { NavRuntime } from "./nav.js";
import { TILE } from "./types.js";
import type {
  Enemy, EnemyKind, BossState, Bullet, Pickup, Prop, Chest, Hazard, FloorHazard, WeaponId, WeaponRarity, AttackMove, TileKind, PropKind,
  MysteryTwist, Vec2, SluiceMode, OddsmakerOutcome, MarginCategory,
  Effect, ZoneEffect, WireEffect, OrbitEffect, SentryEffect, TetherEffect, SanctuaryEffect, AegisEffect,
} from "./types.js";
import { placeFloorHazards, isFloorHazardDamaging, floorHazardPhaseAt, FLOOR_HAZARD_DAMAGE, RIFT_PULL_RADIUS, RIFT_PULL_SPEED } from "./hazards.js";
import { Rng } from "./rng.js";
import {
  ENEMY_ARCHETYPES, BOSS_KIN, spawnFloorEnemies, createEnemy, threatCostOf, isBossFloor,
  isBossKind, isComplexMover, isGauntletFloor, eliteAffixOf, isMinibossKind, bossKindForFloor,
} from "./enemies.js";
import {
  WEAPONS, DEFAULT_WEAPON, MAX_WIRES, MAX_WIRES_PARTY, MAX_ORBIT_BLADES, fire,
  rollWeaponRarity, rollMysteryTwist, WEAPON_RARITY_COLOR, MYSTERY_COLOR,
  createWeaponCycles,
} from "./weapons.js";
import type {
  ShotSpec, Weapon, WeaponCycles, WeaponFireCooldowns,
} from "./weapons.js";
import {
  createMods,
  recomputeMods,
  itemLevelsOf,
  itemById,
  itemMaxLevel,
  isPvpBlessingId,
  normalItemsForCatalog,
  rollItemChoicesWith,
} from "./items.js";
import {
  ULT, OVERDRIVE, SANCTUARY, LIFEBLOOM, AEGIS, PHASE, MOMENTUM, OVERHEAT, HARDENED, OVERSHIELD,
  MAX_TOTAL_DR, MENDER_HEAL_CLAMP, HEAL_PULSE, PHANTOM_MARK, MENDER_REVIVE_SPEED, isRealKit, canCastUlt,
  ultChargeFromDamageDealt, ultChargeFromDamageTaken, ultChargeFromHealDone, ultChargeFromKill,
  ultChargeFromDash, ultTimeChargePerTick, ultShareCapUnits,
  refEncounterHpForFloor, aegisHpBudgetForFloor,
  KIT_START_WEAPON, ticksToSec, TICKS_PER_SECOND,
} from "./kits.js";
import type { KitId, UltSource } from "./kits.js";
import { PET_ABILITY, PET_AUTOCAST, petVerbFor, petCooldownTicks, petVerbNeedsTarget, slimeSlowMul, isFetchablePickup } from "./petAbilities.js";
import type { PetVerb } from "./petAbilities.js";
import {
  PVP, buildPvpArena, createMatchState, pvpHitDamage, pvpPerHitCap, arePvpFoes, farthestSpawnIndex, pvpRespawnIndex,
  pvpRespawnDelayTicks, pvpCountdownTicks, pvpMatchTimeTicks, pvpFragLimit,
  pvpEnvKillCreditWindowTicks, pvpChainWindowTicks, pvpDraftEveryTicks, pvpDraftOfferTicks,
  pvpSuddenDeathFinalTicks, pvpComebackTierBump, pvpSpawnHardGraceTicks, pvpSpawnShieldTicks,
  pvpSpawnFallbackShieldTicks,
  pvpDeathWithinSpawnTicks,
  pvpNearestPitEdgeDistance, pvpSingleDashDistance,
  pvpRespawnWaitSafeIntervalTicks, pvpRespawnWaitSafeMaxTicks,
  isPvpRespawnCandidateSafe, isPvpRespawnCandidateThreatened, pvpRespawnThreatFlags,
  isPvpWeaponSupported,
  HEARTH, isWithinHearth, pvpHearthArmTicks, pvpHearthEmptyDecayTicks,
  pvpHearthArmedHoldTicks, pvpHearthEmberWindowTicks,
  WEATHER, PVP_WEATHER_ORDER, PVP_WEATHER_CARDINALS, createWeatherDirector,
  pvpWeatherFirstEventTicks, pvpWeatherIdleGapTicks, pvpWeatherGustTellTicks,
  pvpWeatherGustActiveTicks, pvpWeatherTarLifeTicks, pvpWeatherSparkTellTicks,
  pvpWeatherStartCursor, pvpWeatherGustCardinal, pvpWeatherTarSpots, pvpWeatherSparkCandidates,
  KIT_COUNTERS, PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP,
  pvpBraceRechargeTicks, pvpSightPulseIcdTicks, pvpRipIcdTicks,
  ARENA_ULT, ARENA_SALVO, ARENA_TRIAGE, ARENA_SHOVE, ARENA_SLIP,
  arenaUltKindForKit, arenaUltPassiveChargePerTick, arenaUltChargeFromDamage,
  clampArenaUltCharge, canCastArenaUlt, arenaUltCastSpacingTicks, arenaUltTellTicks,
  arenaSalvoShotSpacingSec,
} from "./pvp.js";
import type {
  WorldMode,
  MatchState,
  PvpRespawnCandidate,
  PvpRespawnSelectionMode,
  PvpRespawnTelemetry,
  PvpDraftTrigger,
  ArenaUltKit,
  ArenaUltKind,
} from "./pvp.js";
import { lowHpFrac, liveDamageMult, liveFireRateMult, gunnerDamageMult, gunnerFireRateMult, expectedBossDps } from "./weaponStats.js";
import type { PlayerMods, ItemDef } from "./items.js";
import type { PvpTelemetryEvent, SimEvent } from "./events.js";
import type { InputCmd, PlayerId } from "./input.js";
import { LOCAL_ID, IDLE_INPUT } from "./input.js";
import { PRIVATE_DRAFT_PVP_POLICY } from "../pvpPolicyId.js";
import * as C from "./constants.js";
import {
  PLAYER, SUSTAIN, SHOP, REVIVE, FANG_PROC_COOLDOWN, BOSS, MARROW, CHOIR, WEAVER, GILDED,
  JET, TITHE, QUORUM, GORGE, SEVER, CHOIRMASTER, UNDERTOW, PALE, CLAIMANT, WAKE, jetSimulCapFor, titheSlabHpForFloor, gorgeSeamHpForFloor, gorgeSeamCountFor, gorgeShellFracFor, severAnchorHpForFloor, choirPillarHpForFloor, paleSeamHpForFloor, paleSeamCountFor, paleShellFracFor, weaponResonanceFamily, RESONANCE_FAMILIES, RESONANCE_TELEGRAPH_COLOR,
  GAUNTLET, gauntletCaptainHp, TIERS, coopBossHpMult, EXPOSE_WINDOW_CAP,
  activeThreatCap, clampPlayers, coopThreatMult, coopHeartRateMult,
  REINFORCE_STAGGER, BIOME_PRESSURE, BRUTE_HEAVY_DAMAGE, ELITE_BRACE, BOSS_VULN_CAP,
  AMBUSH, POWER, PHASE_TIME_BASE, powerRatioFor, bossAddCapFor, bossAddIntervalFor,
  phaseTimerFor,
  ELITE_COMMANDER, ELITE_BULWARK, ELITE_VOLATILE, ELITE_ECHOED, MARSHAL, TOLL,
  ROLL_AFFIX, BOSS_AFFIX,
  WEAPON_BOSS_COEF, WIPE_HOLD_SECONDS, PU_DPS, PERSISTENT_BOSS_DPS_FRAC,
  LIVE_CAPS, activeMoverCapFor, pedestalWeaponRolls, bossWeaponChoices, KING_REWARD_TABLE,
  MYSTERY, LEGENDARY_MIN_FLOOR,
  PREMIUM, CAPS, PHASE_NO_LOS_DAMAGE_MULT, coinChanceTaper, coopCoinGainMult, premiumMysteryLegendaryWeight,
} from "./balance.js";
import type { EnemyTier, AddPoolEntry, ResonanceFamily, GiantConst } from "./balance.js";
import { giantRingGapCenter, giantRingGapStart, giantSpokeWheel } from "./giantGeometry.js";
import { isControllerKind } from "./bestiary.js";
import { biomeIndexForFloor } from "./biomes.js";
import { resolveFloorDescriptor, floorHazardMutation, floorExtraElites, floorDashProfile } from "./floorRolls.js";
import type { FloorDescriptor } from "./floorRolls.js";
import {
  buildShopState,
  restockShop,
  shopSlotStatusFor,
  shopSlotPriceFor,
  shopViewerOf,
  shopSlotForViewer,
  stockShopForViewer,
  upgradeTargetTier,
  SHOP_BUY_RANGE,
} from "./shop.js";
import type { ShopSlot, ShopSlotStatus, ShopState } from "./shop.js";
import {
  createWeaponBag, drawWeaponFromBag, rollWeaponOfferWithHistory, weaponBagCatalogVersion,
} from "./weaponBag.js";
import type { WeaponBag } from "./weaponBag.js";
import {
  createBlessingOfferHistory,
  createWeaponOfferHistory,
  recordBlessingOffer,
  recordWeaponOffer,
  resetBlessingOfferHistory,
  resetWeaponOfferHistory,
  stablePlayerIdHash,
} from "./offerHistory.js";
import type {
  BlessingOfferHistory,
  WeaponOfferHistory,
} from "./offerHistory.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "./contentCatalog.js";
import type { ContentCatalogVersion } from "./contentCatalog.js";
import { createProcWindow, procKey } from "./antiDegenerate.js";
import type { ProcWindow } from "./antiDegenerate.js";

const HOMING_ACQUIRE_RANGE = 260;

// ---- Content Wave B transient state shapes (server-owned) ----
export interface ForkLink {
  srcEid: number;    // the struck body the link is anchored on
  targetEid: number; // the resonated neighbor the link ticks into
  life: number;      // seconds remaining
  tickT: number;     // seconds until the next damage tick
}
export interface PenMark {
  life: number;        // seconds remaining on the mark
  lastInkDmg: number;  // damage of the target's last ink hit (the snap scales off it)
}
export interface MarginStore {
  category: MarginCategory;
  damage: number;
  pellets: number;
  pierce: number;
  blast: number;
  homing: number;
  burn: number;
  chill: number;
  shock: number;
  spread: number;
  color: string;
  life: number;
}
export interface DisabledBlessing {
  id: string;
  life: number;
}

// ---- Content Wave C transient state shapes (server-owned) ----
// Lamplighter's safe patch: a small, short-lived footing that shields a standing player from
// floor-hazard damage (like a temporary Pathmaker pave) without deleting the hazard itself.
export interface LampPatch {
  x: number;
  y: number;
  radius: number;
  life: number; // seconds remaining
}
// Faultlink's pending A mark (awaiting a second body to form the link).
export interface FaultMark {
  eid: number;
  life: number; // seconds remaining
}
// Faultlink's formed A<->B link (fixed lifetime; breaks on death / range / LOS loss).
export interface FaultLink {
  aEid: number;
  bEid: number;
  life: number; // seconds remaining
}

// A live melee swing, resolving hits over its short duration (sim state, per player).
export interface MeleeSwing {
  timer: number;
  duration: number;
  aim: number;
  arc: number;
  arcScale: number;
  reach: number;
  isThrust: boolean;
  color: string;
  damage: number;
  isCrit: boolean;
  // The blade's boss coefficient (WEAPON_BOSS_COEF), baked when the swing starts.
  bossCoef: number;
  hitList: Array<Enemy | number> | null; // enemies + negative prop-id markers
  burn?: number;
  chill?: number;
  shock?: number;
  // The attacker's pose when the swing started. While the swing's fire-time rewind is active
  // (online), hit tests use THIS pose so both actors are evaluated at fire time — the attacker
  // moving after the swing can't drag the hit arc with it. Solo rewind is 0, so the live pose is
  // used and behavior is unchanged.
  originX: number;
  originY: number;
  // Fire-time lag compensation for the swing (see Bullet.bornTick/lagRewind). A swing is short,
  // so this rewinds hits to when the swing started. 0/undefined in solo.
  bornTick?: number;
  lagRewind?: number;
  // PVP-only: foe player ids this swing has already struck, so one swing lands one hit per foe
  // over its multi-tick duration (hitList only holds enemies). Undefined in co-op (never set).
  hitPids?: PlayerId[];
}

interface StrikeInfo {
  damage: number;
  isCrit: boolean;
  // The crit multiplier baked into damage when isCrit (1 otherwise) — the boss
  // vulnerability channel divides it out and re-applies it capped.
  critX: number;
  // Boss-facing pellet/weapon coefficient baked at fire time. 1 for melee.
  bossCoef: number;
  puffX: number;
  puffY: number;
  kbDirX: number;
  kbDirY: number;
  burn?: number;
  chill?: number;
  shock?: number;
  isMelee: boolean;
  meleeSource?: "swing" | "crook" | "halo";
  isThrust?: boolean;
  // Persistent-source damage (turret bolts, trap snaps — output that runs while nobody
  // aims it). Against boss-grade bodies it draws from the party's shared persistent
  // budget (PERSISTENT_BOSS_DPS_FRAC of partySize x PU_DPS per rolling second) and the
  // overflow is deterministically truncated. Rooms are never budgeted.
  isPersistent?: boolean;
  // Immutable actor identity for status attribution (burn DoT). Survives the actor's disconnect
  // — a burn lit by a departed player keeps crediting THAT id (which then resolves to no one),
  // never a different live player.
  ownerId: PlayerId | null;
  // The weapon whose knockback profile applies when the striking player is gone (bullet.fx —
  // the fire-time weapon). A present player uses their live weapon, exactly as before.
  fxWeapon: WeaponId | null;
}

// §10 per-source ult-charge accumulators toward one meter fill (enforces the share caps). "time"
// is uncapped (the floor) so it is not tracked here.
export interface UltSourceCharge { dmg: number; kill: number; taken: number; heal: number; dash: number }
function freshUltSources(): UltSourceCharge { return { dmg: 0, kill: 0, taken: 0, heal: 0, dash: 0 }; }

export interface PlayerSim {
  id: PlayerId;
  offerIdentity: string;
  x: number; y: number; pr: number;
  hp: number; maxHp: number;
  mods: PlayerMods;
  // Post-hit protection (0.80s). SEPARATE from the dash iframe: neither may extend the other.
  invuln: number;
  // The world tick a landed hit last reduced this player's HP (-1 = never damaged). Server-only,
  // absolute + monotonic like the ult lockout ticks. Drives the MENDER post-damage SELF-heal
  // delay (a Mender's own healing pauses briefly after it is hit); it is set only when real HP is
  // lost, so a fully-soaked/invuln hit never arms it. Off the wire — self-heal resolves in the
  // authoritative world phase, which client prediction never runs.
  lastDamagedTick: number;
  // The earliest world tick at which this player's next 1 HP of MENDER SELF-heal may land — the
  // sustained self-heal CEILING (guard), advanced by SELF_HEAL_TICKS_PER_HP on each self-HP so
  // combined self output stays ≤ selfHpPerSec while Lifebloom's slower cadence passes untouched.
  // Server-only + monotonic like the ult lockout ticks; off the wire (self-heal is world-phase only).
  selfHealReadyTick: number;
  // Dash iframe (0.18s), set once per dash — non-refreshing, non-overlapping.
  dashInvuln: number;
  dashCd: number; dashTime: number; dashDx: number; dashDy: number;
  fireCd: number;
  weaponFireCooldowns: WeaponFireCooldowns;
  // Seconds the trigger has been held on a charge weapon (the Breach). Server-owned and
  // reconciled like fireCd so prediction and authority agree on the landing distance.
  // Always 0 on weapons without a charge spec; reset by weapon switches and downs.
  chargeT: number;
  // Vampire Fang shared proc cooldown (1.25s): at most one kill-heal per window.
  fangCd: number;
  facing: number; aimAngle: number; weapon: WeaponId;
  ownedWeapons: WeaponId[]; // inventory (never grows past MAX_OWNED_WEAPONS); one number key per slot
  shotSeq: number;
  weaponCycles: WeaponCycles;
  lastGrappleShotSeq: number;
  isMuddyRefundSpent: boolean;
  // ---- Content Wave B server-owned transient combat state (never on the reconcile wire;
  // all sub-8s, rebuilt from live inputs after a resume) ----
  forkLink: ForkLink | null;         // resonant_fork: the single active tune link
  penMarks: Map<number, PenMark>;    // red_pen: live ink marks keyed by enemy id
  penSkillCd: number;                // red_pen: REWRITE snap cooldown (successful snap only)
  penInputLock: number;              // red_pen: fail-closed input lock after a bad snap
  marginStore: MarginStore | null;   // margin_call: the one stored payload class
  sidewinderArcT: number;            // sidewinder: seconds until the 2nd authored arc launches
  sidewinderArcAim: number;          // sidewinder: aim the pending 2nd arc fires along
  revealIcdT: number;                // known_by_touch: shared reveal trigger cooldown
  rememberMeArmed: boolean;          // remember_me: lethal-save available this floor
  disabledBlessing: DisabledBlessing | null; // remember_me: the blessing muted by a save
  lightSoloDashIcd: number;          // carry_the_light: solo dash-restore cooldown
  staggerPulseIcdT: number;
  staggerPulseAppliedTick: number;
  bladeWardT: number;
  bladeWardAbsorb: number;
  bladeWardAppliedTick: number;
  isMomentumArmed: boolean;
  momentumIcdT: number;
  momentumMoveSamples: Array<{ at: number; distance: number }>;
  // ---- Content Wave C server-owned transient combat state (never on the reconcile wire;
  // all sub-10s, rebuilt from live inputs after a resume) ----
  hushStacks: number;        // hushiron: current stance stacks (0..maxStacks)
  hushStillT: number;        // hushiron: seconds standing still (arms stacking at stillDelay)
  hushStackT: number;        // hushiron: accumulator toward the next stance stack
  hushVentT: number;         // hushiron: accumulator toward the next vented stack while moving
  backtalkHoldT: number;     // backtalk: held-fire accumulator that opens the parry window
  backtalkWindowT: number;   // backtalk: seconds the frontal catch window stays open
  backtalkCd: number;        // backtalk: parry cooldown (starts on a SUCCESSFUL catch only)
  backtalkReturnT: number;   // backtalk: seconds the caught return shot stays armed
  backtalkCaughtDmg: number; // backtalk: damage of the caught shot (0 when unarmed)
  backtalkLock: number;      // backtalk: input lock after a miss / expired empty window
  lampPatches: LampPatch[];  // lamplighter: live safe patches (cap 3, oldest despawns)
  faultMark: FaultMark | null;  // faultlink: the pending A mark awaiting a B to link
  faultLink: FaultLink | null;  // faultlink: the formed A<->B link
  isDown: boolean;
  // Network-absent (authoritative server only): the player's connection dropped and their body
  // is RESERVED for the reconnect grace window. An absent body is paused and safe — it cannot
  // act, take damage, attract enemies, collect loot, or open chests — and it is excluded from
  // the exit/blessing gates so it can neither trigger nor deadlock a party transition. It
  // still counts as ALIVE for the wipe checks (a resumed player can revive the party), which
  // is exactly what keeps a brief Wi-Fi drop from reading as a death. Solo/co-op/prediction
  // never set this.
  isAbsent: boolean;
  warmthIdleSec: number;
  warmthPathPx: number;
  isWarmthChilled: boolean;
  // Seconds a teammate has been reviving this downed player (authoritative revive hold). 0 when
  // up or when no one is reviving. Solo never downs, so this stays 0.
  reviveProgress: number;
  // WHO is channeling this downed player's revive (gate §6: one reviver only, 1.5s
  // UNINTERRUPTED). Identity makes the cancel rules exact: the channeler's damage, dash,
  // attack, or exit resets the channel; a bystander's does not. Null when up / unattended.
  reviveBy: PlayerId | null;
  // Downs on THIS floor (gate §1, Standard: 3/player/floor). Past the limit the player is
  // OUT — unrevivable until the party's descent rescues them. Reset every floor.
  downsThisFloor: number;
  // Whether this player's interact key (E) is held THIS tick — the explicit revive-channel
  // intent. Derived from the consumed input every stepPlayerPhase, never wired: the server
  // sets it from the inputs it consumes, prediction from the same inputs locally.
  isInteracting: boolean;
  // Lag-compensation rewind for THIS player's shots/swings, in ticks (server-computed from the
  // player's measured RTT + interp delay, clamped). 0 in solo/prediction, so hit tests use
  // present-time positions and behavior is unchanged.
  rewindTicks: number;
  kills: number; coins: number; combo: number; comboTimer: number;
  ownedItemIds: string[];
  weaponOfferHistory: WeaponOfferHistory;
  blessingOfferHistory: BlessingOfferHistory;
  blessingOfferOrdinal: number;
  shopWeaponOfferOrdinal: number;
  shopBlessingOfferOrdinal: number;
  premiumWeaponOfferOrdinal: number;
  meleeSwing: MeleeSwing | null;
  // Studio gate §4: the boss chest offers P+1 weapon CHOICES and each player claims exactly
  // one per boss floor. Reset on every floor build.
  hasClaimedBossChoice: boolean;
  // ---- the premium coin economy (run-scoped, per player) ----
  // Successive +1-max-heart purchases (each costs ×1.6 the last; the hearts share the +4
  // total cap with Vitality — see applyMaxHpBonus).
  premiumHpBuys: number;
  // The amber cache is armed: unspent coins convert to a tiny Amber trickle at run end
  // (≤ +2 per 100, capped +5/run) — the ONLY coins→permanence route.
  isAmberCacheArmed: boolean;
  // Flat Amber banked by the mythic windfall claim (+8 per claim).
  amberWindfall: number;
  // A reroll-everything purchase arms one reroll of this player's NEXT blessing offer:
  // the roller (solo client / authoritative server) burns a full choice-set draw first.
  isBlessingRerollArmed: boolean;
  // Banked revive tokens (cap 1): a lethal hit consumes one and stands the player back
  // up at REVIVE.hp instead of downing/ending — a second chance, never a second bar.
  reviveTokens: number;
  // Bought hotbar capacity past MAX_OWNED_WEAPONS (cap 1/run — see weaponCapOf).
  extraWeaponSlots: number;
  // Max hearts paid to the artifact devil deal (permanent for the run; cap one deal).
  hpTithe: number;
  // The floor a Prospector's Draught is live on (-1 = none): collected coin VALUE
  // doubles while w.floor matches — the buff dies at the stairs by construction.
  prospectorFloor: number;
  // ---- KIT / CLASS + ULT system (spec docs/specs/blobrogue_KIT_XP_SYSTEM_spec.md) ----
  // The player's chosen kit. "none" is the pre-kit NEUTRAL baseline (legacy/quick-start/tests):
  // every kit behaviour below is inert for it, so the shipped sim stays byte-identical until a
  // real kit is assigned (setPlayerKit). Server-owned (validated at join against account Mastery).
  kitId: KitId;
  // The universal ULT METER: server-owned authoritative FIXED-POINT charge, integer 0..ULT.meterMax
  // (max === READY). Accrued only in the authoritative world phase (updateUlts + the damage/kill/
  // heal hooks), never client-computed or trusted from a client (spec §3/§7).
  ultCharge: number;
  // The 8.0s hard floor between casts: the world tick before which a cast is refused, even if the
  // meter re-fills faster (spec §3). 0 = no lockout pending.
  ultReadyAtTick: number;
  // GUNNER OVERDRIVE self-buff seconds (fire-rate boost + temporary pierce). Decays in
  // stepPlayerPhase so prediction applies the buff the server granted (reconciled via SelfWire).
  overdriveT: number;
  // GUNNER OVERHEAT boil-over seconds (Wave 2 signature): a short +fire-rate + +pierce burst that
  // fires when Momentum hits max, then rolls on. Decays in stepPlayerPhase like overdriveT (so
  // prediction applies the burst the server granted) and is read by currentFireRate/resolveShot.
  overheatT: number;
  // BULWARK OVERSHIELD chip pool (Wave 2 signature): 0..OVERSHIELD.maxChips of armor that absorbs
  // BEFORE hearts (drawn on the health bar). Server-owned (mutated in the damage funnel + the
  // world-phase regen), reconciled + rendered by the local client via SelfWire.
  overshield: number;
  // OVERSHIELD regen countdown in TICKS (server-only, integer for crisp determinism): counts down
  // each world tick; at 0 a chip regens and it resets. Any damage bumps it to OVERSHIELD.pauseTicks
  // (the out-of-combat buffer — regen never ticks under sustained fire). Off the wire.
  overshieldRegenT: number;
  // MENDER HEAL-PULSE cooldown gate (Wave 2 signature): the world tick before which the directed
  // pulse is refused (mirrors ultReadyAtTick). Server-owned; the client reconciles it for the CD
  // readout. 0 = ready.
  pulseReadyAtTick: number;
  // PHASE speed-surge seconds. Kit-AGNOSTIC: a phantom's Phase surges the caster AND affected
  // allies of any kit, so movement keys off this field, never the kit.
  phaseSpeed: number;
  // Phase invuln seconds (hard-capped <= 1.2s, spec §9.1): a SEPARATE protection window
  // isProtected()/damagePlayer honour, never extending the post-hit/dash iframes. Kit-agnostic.
  ultInvuln: number;
  // The one per-kit PASSIVE auxiliary channel (mirrors the enemy `aux` idiom): GUNNER momentum
  // stacks, MENDER lifebloom heal-credit pool, BULWARK hardened damage-soak. 0 for phantom/none.
  passiveState: number;
  // §10 per-source charge accumulators toward the CURRENT meter fill (server-only, reset on
  // cast): enforces the per-source SHARE caps so no single input dominates one fill. Never wired
  // (the client only reconciles the total meter).
  ultSources: UltSourceCharge;
  // §10 tuning stat (server-only): total overcharge LOST while the meter sat at 100 (the "charge
  // wasted %" the balancer tunes the median toward ~1 ult / 2-3 encounters against).
  ultWasted: number;
  // Whether an ult was requested THIS tick (the client's edge/level "ult requested" input bit).
  // Re-derived from the consumed input every stepPlayerPhase (like isInteracting) and resolved +
  // cleared in the authoritative updateUlts — never wired, so a client can request, never cast.
  isUltRequested: boolean;
  // Whether the MENDER heal-pulse was requested THIS tick (the client's pulse input bit). Same
  // contract as isUltRequested: re-derived from the consumed input, resolved + cleared in the
  // authoritative updateUlts, never wired — a client can request, the server alone resolves.
  isPulseRequested: boolean;
  // ---- PET ABILITY (PROTOCOL 45; see src/sim/petAbilities.ts) ----
  // The OWNER-BOUND equipped pet id (the ability source). Distinct from the cosmetic FOLLOW body,
  // which stays client-only: the sim carries the id purely to resolve the verb (petVerbFor). Set
  // at spawn from the verified join identity (setPlayerPet); null = no pet / no ability. Never
  // wired (the owner knows its own pet from its session; remotes ride PlayerWire.pt cosmetically).
  pet: string | null;
  // Server-owned CD gate (mirrors ultReadyAtTick): the world tick before which a pet ability is
  // refused. Reconciled via SelfWire so the client's CD pip is reconnect-safe. 0 = ready.
  petCdReadyAtTick: number;
  // The active 0.30s TELL countdown (seconds). Opened on a valid request; the verb FIRES when it
  // elapses. Wired for the tell VFX; a fresh full snapshot restores a mid-tell on reconnect.
  petTellT: number;
  // Wick PINPRICK active light window (seconds): while > 0 the owner's light radius is bumped.
  // Server-owned + wired (the client renders the bump reconnect-safe). 0 = no active light.
  petLightT: number;
  // Doggie FETCH active pull window (seconds): while > 0 loose non-heart loot is drawn toward the
  // owner each tick. Server-owned + wired (reconnect-safe). 0 = no active pull.
  petFetchT: number;
  // Pebble PEBBLEBRACE absorb window (seconds): while > 0 the owner carries a one-hit shield that
  // eats the next incoming hit of at most PET_ABILITY.pebblebrace.absorbMax, then is spent (set to
  // 0). Decays on its own if unspent; cleared the instant the owner is downed. Server-owned +
  // wired so the bubble is reconnect-safe. 0 = no shield.
  petShieldT: number;
  // Nullfin NULLWAKE window (seconds): while > 0 the owner takes NO floor-hazard damage (tile
  // hazards + cinder pools). Never blocks bullets/contact, never voids required-hazard objectives.
  // Server-owned + wired (reconnect-safe). 0 = not active.
  petNullT: number;
  // Whether a pet ability was REQUESTED this tick (the client's pet input bit). Same contract as
  // isUltRequested: re-derived from the consumed input every stepPlayerPhase, resolved + cleared
  // in the authoritative updatePetAbilities, never wired — a client can request, never resolve.
  isPetAbilityRequested: boolean;
  // ---- PVP (mode === "pvp") ----
  // FFA team id: 0 = "no team" (every distinct player is a foe). Set at spawn, low-churn — the
  // damage funnel reads it via arePvpFoes so future team modes need no new damage path. Always
  // 0 in co-op (the field is inert there).
  team: number;
  // Ticks until this player respawns after a pvp death (0 = alive/active). Frag-limit
  // deathmatch: a death schedules a respawn, never an elimination. Always 0 in co-op, so the
  // co-op movement/collision gates that read it (respawnT === 0) stay byte-identical.
  respawnT: number;
  // Bounded all-unsafe hold after the ordinary respawn countdown. respawnT remains 1 while this
  // is live, so every existing dead/input/wire/UI gate continues to read RESPawning.
  respawnWaitSafeT: number;
  // PvP spawn protection uses two authoritative tick windows. Hard grace suppresses every
  // outgoing combat commitment; the shield is full immunity and breaks on the first legal attack.
  spawnGraceT: number;
  spawnShieldT: number;
  spawnProtectionStartedTick: number;
  spawnHardGraceEndsAtTick: number;
  spawnShieldEndsAtTick: number;
  isSpawnOffenseLatched: boolean;
  spawnBlockedFeedbackCdT: number;
  // Last two selected spawn indices. Server-owned plain state survives a reserved-seat reconnect.
  pvpRecentSpawnIndices: number[];
  pvpRespawnTelemetry: PvpRespawnTelemetry | null;
  // Most recent PvP attacker and authoritative damage tick.
  lastPvpHitBy: PlayerId | null;
  lastPvpHitTick: number;
  // Most recent player who actually displaced this body with PvP knockback. Pit attribution
  // reads this pair specifically, so nearby damage never steals a walked-in suicide.
  lastPvpKnockbackBy: PlayerId | null;
  lastPvpKnockbackTick: number;
  // Per-player draft cadence and deterministic offer identity. These fields are inert in co-op.
  // Cadence stays server-side; clients receive the validated offer plus bounded trigger metadata.
  pvpDraftFrags: number;
  pvpDraftActiveTicks: number;
  pvpDraftOrdinal: number;
  pvpDraftTick: number;
  pvpDraftTierBump: number;
  pvpDraftTrigger: PvpDraftTrigger;
  pvpDraftOfferTicksLeft: number;
  pvpDraftOfferElapsedTicks: number;
  isPvpDraftDeathDelayReported: boolean;
  isPvpDraftAbsenceDelayReported: boolean;
  // ---- PVP WAVE 2 · CONTESTED HEARTH (Pillar A) ----
  // Accrued UNCONTESTED standing on the center hearth, in ticks (0..armTicks). A full stand
  // (armTicks) arms one ember_edge charge and resets this to 0. Server-owned + reconciled so the
  // HUD Favor pip is reconnect-safe. Always 0 in co-op / outside a live pvp match.
  hearthFavorT: number;
  // Remaining ember_edge active window in ticks (0 = no charge armed). Set to the ember window on
  // arm; decrements each world tick; force-cleared 1.5s after leaving the radius, on the next gun
  // hit (spent), and on death. Server-owned + reconciled (HUD ember pip). Always 0 in co-op.
  hearthEmberT: number;
  // Ticks since this player was last standing in the hearth radius (0 while inside). Drives the
  // 0.40s unarmed-progress clear and the 1.5s armed-charge hold. Server-only bookkeeping (never
  // wired — the client renders only the Favor/ember readouts above). Always 0 in co-op.
  hearthAwayT: number;
  // ---- PVP WAVE 2 · PILLAR C: DRAFT KIT COUNTERS (brace / sight / rip) ----
  // Per-life counter timers, keyed off the drafted blessing ids (ownedItemIds). Server-owned
  // TRANSIENT combat state: never wired (all sub-10s, rebuilt from live inputs after a resume),
  // cleared on death (resetPvpLifeTransient), and always 0 / inert in co-op or outside a live match.
  // brace_band: banked brace charges (0..braceMaxCharges) and the ticks accrued toward the next one.
  pvpBraceCharge: number;
  pvpBraceRegenT: number;
  // clear_eyes: ticks until the next outline pulse may mark (0 = armed).
  pvpSightIcdT: number;
  // rip_post: ticks until the post is armed again (0 = armed; the next reload/dash rips it).
  pvpRipIcdT: number;
  // ---- PVP WAVE 3: ARENA ULTS (PROTOCOL 49) ----
  // The CLAIMED arena ult kit (ult skin ONLY — never applies a co-op stat lean / passive / co-op
  // ult; kitId stays "none" in the arena so all co-op kit logic is inert). Server-owned + wired
  // (SelfWire.auk) so the HUD shows the claimed ult; defaults gunner (arena_salvo). Meaningless in
  // co-op (never read behind isPvp), where it stays at its "gunner" default and is byte-neutral.
  arenaUltKit: ArenaUltKit;
  // The arena ult's per-cast TRANSIENT state (tell / active windows). Server-owned transient
  // combat state: never wired (all sub-1s, rebuilt from live inputs after a resume), cleared on
  // death (resetPvpLifeTransient), and inert in co-op / outside a live match.
  arenaUlt: ArenaUltState;
}

// PVP WAVE 3 arena ult per-cast transient windows (all seconds unless noted). The meter itself
// reuses ultCharge/ultReadyAtTick; this holds only the short-lived tell/active state.
export interface ArenaUltState {
  // Tell countdown; > 0 telegraphs the pending `kind` before it lands (the >= 0.40s tell).
  tellT: number;
  // The ult telegraphing / active this cast (null = idle).
  kind: ArenaUltKind | null;
  // Aim (rad) captured at cast: the salvo aim-lock direction, the shove frontal facing, the blink.
  aim: number;
  // arena_salvo: remaining volley shots and the countdown to the next one.
  salvoShotsLeft: number;
  salvoShotT: number;
  // arena_salvo GLASS: caster takes +25% incoming while > 0 (whole tell + active window).
  glassT: number;
  // arena_bulwark_shove: remaining frontal-wall life (blocks one foe shot then shatters).
  shoveT: number;
  shoveAim: number;
  // arena_slip: the visible end-lag recovery (NO i-frame — the i-frame rides ultInvuln).
  endlagT: number;
  // arena_triage: brief tar/move-slow immunity (positional slows are re-derived every tick).
  slowImmuneT: number;
}
function freshArenaUltState(): ArenaUltState {
  return {
    tellT: 0, kind: null, aim: 0,
    salvoShotsLeft: 0, salvoShotT: 0, glassT: 0,
    shoveT: 0, shoveAim: 0, endlagT: 0, slowImmuneT: 0,
  };
}

// Extra AI target points fed in by the client from co-op presence (Stage A keeps co-op on
// the existing presence path; the sim only needs remote POSITIONS as enemy aggro targets).
export interface RemoteTarget { x: number; y: number; isDown: boolean }

// A per-enemy ring of recent positions for lag-compensated hit rewind.
interface EnemyHist { x: number[]; y: number[] }

export interface WorldState {
  tick: number;
  seed: number;
  catalogVersion: ContentCatalogVersion;
  // Content Wave B: the shared secondary-proc rate clamp (≤4/s/player/target). Sim-internal
  // and never serialized — it is a rolling window rebuilt from live combat.
  procWindow: ProcWindow;
  // Sidewinder's same-target repeat gate (1 full hit / target / short volley window; a
  // second arc into the same body lands at WAVE_B_SAME_TARGET_REPEAT). Sim-internal.
  sameTargetWindow: ProcWindow;
  // Content Wave B monotonic real-seconds clock (accumulates dt every world step,
  // unconditionally) — the proc-rate window measures against it. Sim-internal.
  waveBClock: number;
  floor: number;
  // World revision: increments on EVERY floor build (create/descend/run reset). Snapshots carry
  // it so a client can key its geometry rebuild + reject stale cross-floor snapshots explicitly
  // (tick alone stays monotonic, but rev makes the world identity first-class on the wire).
  rev: number;
  // Terminal run state: set once when the whole party wipes (or the last standing player leaves
  // a shared world with only downed players behind). Snapshots carry it so game-over is
  // derivable from STATE, not only from the transient gameOver event.
  isRunOver: boolean;
  players: Map<PlayerId, PlayerSim>;
  enemies: Enemy[];
  bullets: Bullet[];
  pickups: Pickup[];
  props: Prop[];
  chests: Chest[];
  // Authored ground hazards (the Weaver's webs): shared authoritative floor state, capped
  // and self-expiring; rebuilt empty on every floor load.
  hazards: Hazard[];
  // Weapon effect entities (the effect wave: zones/wires/orbits/sentries/tethers). Shared
  // authoritative state exactly like bullets — stepped in updateEffects on the world
  // phase, hard-capped per family, serialized on every snapshot, rebuilt empty per floor.
  effects: Effect[];
  // Environmental FLOOR hazards (depth escalation) — distinct from the boss webs above:
  // layout is derived per floor from the seed (never on the wire); pulse timing keys off
  // floorHazardClock — accumulated SIM seconds, monotonic across floors like tick, so
  // solo (60Hz) and the server (20Hz) agree on cycles in real time and an online client
  // can reconstruct it as tick x FIXED_DT.
  floorHazards: FloorHazard[];
  floorHazardClock: number;
  // Overlap arbiter (studio gate §2): damage releases mobs committed in the last 0.30s.
  // A new mob release whose area overlaps a recent one HOLDS until the window clears — no
  // two releases may pincer the same escape lane inside one reaction window. (Seeded
  // floor-hazard groups arbitrate the same rule at placement time — see hazards.ts.)
  recentReleases: Array<{ x: number; y: number; radius: number; t: number }>;
  // The F10 Arena Gauntlet stage machine (curriculum §2): `stage` counts spawned stages,
  // `breath` is the authored 1.2s beat between a clear and the next entrance, and
  // `isRewarded` latches once the premium chest has dropped. Null on ordinary floors.
  gauntlet: { stage: number; breath: number; isRewarded: boolean } | null;
  // Patch's shop (the authored Dealer room): authoritative stall state on shop floors,
  // null everywhere else. Built deterministically per floor (buildShopState) and mutated
  // ONLY by the validated buy command (buyFromShopInWorld) — never by touch/contact.
  shop: ShopState | null;
  dungeon: Dungeon;
  // Dynamic-obstacle navigation caches (prop clearance grid + per-class flow fields).
  // Derived data only — never on the wire; every consumer rebuilds lazily off
  // (obstacleRev, flowKey), so server and clients always agree.
  nav: NavRuntime;
  // Obstacle revision: increments whenever the blocking prop set changes (floor build,
  // prop destroyed, dev spawn). Keys every navigation cache; content systems that
  // destroy cover (charges, slams) bump it implicitly through destroyProp.
  obstacleRev: number;
  flowCd: number;
  // Combined hash of every living source tile; the chase fields rebuild when it changes.
  flowKey: number;
  flowSources: number[];
  // Per-tick same-kind flocker index (scratch, never on the wire): updateFlocker's
  // separation/social scan reads only fellow flockers instead of every enemy, so a
  // summon-heavy room is no longer O(flockers × all enemies). Rebuilt lazily off (tick, kind).
  flockScan: Enemy[];
  flockScanTick: number;
  flockScanKind: string;
  // Per-tick explosive-barrel detonation count (scratch): caps the chain a dense cluster
  // fires in one tick, so an ignition can't cascade into a whole-frame FX/damage spike.
  barrelExplosionsThisTick: number;
  // Pet FETCH party throttle (PROTOCOL 45): the world tick before which the NEXT fetch pulse is
  // refused, so the whole party shares one fetch pulse / 2.0s. Server-owned; never on the wire.
  petFetchPartyReadyAtTick: number;
  rng: Rng;
  // The per-run weapon deal (see weaponBag.ts): every free weapon roll — pedestals, boss
  // chest alternates, wood chests, owned-claim rerolls — draws from this seeded shuffled
  // bag so the early floors hand out DISTINCT guns. Reset with the run (never per floor);
  // advanced only by the authority, so it lives off the wire like w.rng itself.
  weaponBag: WeaponBag;
  // Co-op encounter snapshot (§8): living players at floor build, clamped 1–4. Drives
  // enemy HP / threat budget / heart-rate scaling; NEVER rescales living enemies mid-floor.
  encounterPlayers: number;
  // The R framework's pull sample (party+gear-aware boss scaling, balance.ts POWER):
  // the party's measured power ratio, taken at encounter creation from loadouts alone
  // and NEVER rescaled mid-fight. Bosses read it for effective HP and every surplus
  // mechanic lever (add pressure, soft-enrage budgets, surprise waves, density).
  encounterPower: number;
  // JET's FROZEN mirror pool (Wave 1): the distinct Resonance FAMILIES (weapon ARCHETYPES,
  // never live inventory) the party carried at the pull, seeded-padded to a minimum and
  // capped — resolved once when JET first commits and never re-read mid-fight. Empty off a
  // JET floor. Sim-internal (JET's verbs express through ordinary enemy fire on the wire).
  jetMirror: ResonanceFamily[];
  // Gate 3's FROZEN floor descriptor: the floor's mutator/affix/boss-affix rolls resolved ONCE at
  // generation via THE ROLL-ORDER CONTRACT (floorRolls.ts / streams.ts), a pure function of
  // (seed, floor, playerCountAtLock). Clients recompute it identically inside their own floor
  // build (never on the wire — the same pattern as floorHazards), so reconnect + same-seed replay
  // are identical. Nothing re-rolls per frame; the sim + clients READ this. FRAMEWORK ONLY this
  // build — resolved + frozen but not yet EXPRESSED (no vision/hazard/spawn changes), so existing
  // floors stay byte-identical.
  floorDescriptor: FloorDescriptor;
  // Batch0 encounter architecture: plain-data route/checkpoint/objective/carrier.
  // null on non-encounter floors; 'arena' on boss floors (Gorge HP-death unchanged).
  // NEVER overloaded onto BossState. Reconnect/replay safe (JSON-serializable).
  encounter: EncounterState | null;
  // Threat-cap reinforcements: pre-planned units beyond the ActiveThreatCap, released in
  // waves as the living threat drops (spawnReleaseCd staggers the trickle).
  pendingSpawns: Enemy[];
  spawnReleaseCd: number;
  // Heart-economy pity (§2): hearts generated this floor, whether the party entered below
  // 50% HP, the dry-floor streak, and whether the next wood chest is forced to hold a heart.
  heartsThisFloor: number;
  isFloorEnteredLow: boolean;
  pityStreak: number;
  isPityHeartArmed: boolean;
  nextEnemyId: number;
  nextPropId: number;
  nextPickupId: number;
  nextChestId: number;
  nextHazardId: number;
  nextEffectId: number;
  // Persistent-source boss budget (envelope): per boss-grade enemy id, the rolling
  // one-second window start (sim seconds off floorHazardClock) and the persistent
  // damage already applied inside it. Sim-internal — never on the wire; cleared per
  // floor. strikeEnemy truncates persistent damage past the window's budget.
  persistentBossWindows: Map<number, { t: number; used: number }>;
  // PALE THRONE warmth-drain (the giant SIGNATURE): the resolved per-tick params when a giant with
  // warmth-drain is alive (else null). Per-player timer/path/chill state lives on PlayerSim so the
  // authoritative snapshot reconciles the vignette and predicted speed after delay or reconnect.
  warmthDrain: WarmthDrainParams | null;
  // Friendly-fire "playful bonk" per-ORDERED-pair cooldowns: `${shooterId}>${targetId}` ->
  // seconds left before that shooter may nudge that target again (A->B independent of B->A).
  // Sim-internal — never on the wire; entries self-expire and are cleared on every floor build.
  friendlyNudgeCd: Map<string, number>;
  // §10 MENDER incoming-heal clamp: the rolling 1s per-target + party-wide heal budget ALL
  // Mender output (Lifebloom + Sanctuary, any Mender count) shares, so healing never double-
  // stacks or out-heals incoming damage. Server-only (heals resolve in the world phase); keyed
  // by target player id, reset per floor.
  incomingHealWindows: Map<PlayerId, { tick: number; hp: number }>;
  partyHealWindow: { tick: number; hp: number };
  // Lag-compensation position history: per-enemy ring of past positions (offset 0 = most
  // recent record). histHead is the ring slot of the most recent record; histCount is how many
  // slots are valid. Recorded once per world tick; read only when a shooter has rewindTicks > 0.
  enemyHist: Map<number, EnemyHist>;
  histHead: number;
  histCount: number;
  // Lag-compensation position history for PLAYERS (pvp hit-reg): the SAME ring/rewind the
  // enemy history uses, keyed by player id. Recorded only in pvp (empty/unread in co-op), so
  // the co-op golden path is untouched. Rewind is bounded identically (LAGCOMP window).
  playerHist: Map<PlayerId, EnemyHist>;
  // High-rate PVP balance telemetry is drained by the authoritative server after each tick.
  // It never enters the reliable client event ring.
  pvpTelemetryEvents: PvpTelemetryEvent[];
  // Authoritative pending blessing offers: pid -> seconds left to answer. An entry exists
  // from the moment an offerBlessing event is raised until the pick is applied (or the offer
  // expires / the player leaves). While pending, that player's INPUT is paused. Co-op grants
  // the safe-side damage shield and holds descent; PVP keeps the chooser damageable.
  pendingBlessings: Map<PlayerId, number>;
  // Whether this floor's between-floor blessing offers were already raised at the exit gate
  // (one offer per cleared non-boss floor; reset on every floor build).
  isBlessingOfferedThisFloor: boolean;
  // Seconds EVERY player has been down simultaneously (gate §6): the wipe is a held
  // 4.0s all-down beat, not an instant cut. Resets whenever anyone is standing.
  wipeTimer: number;
  remoteTargets: RemoteTarget[];
  // The world-content mode discriminant. "coop" (DEFAULT) keeps every existing path + golden
  // zero-diff; "pvp" swaps ONLY the four gated concerns (damage targeting, arena, spawns,
  // match). Orthogonal to isCoop/isShared/isSandbox below.
  mode: WorldMode;
  // Immutable room policy copied from the verified server RoomRuntime at construction. The
  // canonical private policy is the sole draft-runtime switch; null or unsupported values are
  // deliberately inert.
  pvpPolicy: string | null;
  // FFA match state (phase / scores / winner / arena spawns), non-null ONLY in pvp mode.
  match: MatchState | null;
  isCoop: boolean;
  // Authoritative shared multiplayer world (the Stage-C server). Like solo it descends in-sim
  // (the server owns floor transitions), but unlike solo a player hitting 0 HP goes DOWN rather
  // than ending the world, and enemy processing never aborts on a single downed player. Solo and
  // the legacy Convex co-op path leave this false, so their behavior is unchanged.
  isShared: boolean;
  isSandbox: boolean;
  isGodMode: boolean; // dev sandbox: damagePlayer no-ops while true
  // Per-query scratch (nearest living target); avoids per-frame allocation, matching the
  // old this.targetX/targetY.
  targetX: number;
  targetY: number;
}

export function createPlayer(id: PlayerId, x: number, y: number): PlayerSim {
  return {
    id, offerIdentity: id, x, y, pr: 18,
    hp: PLAYER.baseMaxHp, maxHp: PLAYER.baseMaxHp,
    mods: createMods(),
    invuln: 0, lastDamagedTick: -1, selfHealReadyTick: 0, dashInvuln: 0,
    dashCd: 0, dashTime: 0, dashDx: 0, dashDy: 0,
    fireCd: 0, weaponFireCooldowns: {}, chargeT: 0, fangCd: 0,
    facing: 1, aimAngle: 0, weapon: DEFAULT_WEAPON,
    ownedWeapons: [DEFAULT_WEAPON],
    shotSeq: 0, weaponCycles: createWeaponCycles(), lastGrappleShotSeq: -1,
    isMuddyRefundSpent: false,
    forkLink: null, penMarks: new Map(), penSkillCd: 0, penInputLock: 0,
    marginStore: null, sidewinderArcT: 0, sidewinderArcAim: 0,
    revealIcdT: 0, rememberMeArmed: true, disabledBlessing: null, lightSoloDashIcd: 0,
    staggerPulseIcdT: 0, staggerPulseAppliedTick: -1,
    bladeWardT: 0, bladeWardAbsorb: 0, bladeWardAppliedTick: -1,
    isMomentumArmed: false, momentumIcdT: 0, momentumMoveSamples: [],
    hushStacks: 0, hushStillT: 0, hushStackT: 0, hushVentT: 0,
    backtalkHoldT: 0, backtalkWindowT: 0, backtalkCd: 0, backtalkReturnT: 0,
    backtalkCaughtDmg: 0, backtalkLock: 0, lampPatches: [],
    faultMark: null, faultLink: null,
    isDown: false, isAbsent: false, warmthIdleSec: 0, warmthPathPx: 0, isWarmthChilled: false,
    reviveProgress: 0, reviveBy: null, downsThisFloor: 0, isInteracting: false, rewindTicks: 0,

    kills: 0, coins: 0, combo: 0, comboTimer: 0,
    ownedItemIds: [],
    weaponOfferHistory: createWeaponOfferHistory(),
    blessingOfferHistory: createBlessingOfferHistory(),
    blessingOfferOrdinal: 0,
    shopWeaponOfferOrdinal: 0,
    shopBlessingOfferOrdinal: 0,
    premiumWeaponOfferOrdinal: 0,
    meleeSwing: null,
    hasClaimedBossChoice: false,
    premiumHpBuys: 0,
    isAmberCacheArmed: false,
    amberWindfall: 0,
    isBlessingRerollArmed: false,
    reviveTokens: 0,
    extraWeaponSlots: 0,
    hpTithe: 0,
    prospectorFloor: -1,
    kitId: "none",
    ultCharge: 0,
    ultReadyAtTick: 0,
    overdriveT: 0,
    overheatT: 0,
    overshield: 0,
    overshieldRegenT: 0,
    pulseReadyAtTick: 0,
    phaseSpeed: 0,
    ultInvuln: 0,
    passiveState: 0,
    ultSources: freshUltSources(),
    ultWasted: 0,
    isUltRequested: false,
    isPulseRequested: false,
    pet: null,
    petCdReadyAtTick: 0,
    petTellT: 0,
    petLightT: 0,
    petFetchT: 0,
    petShieldT: 0,
    petNullT: 0,
    isPetAbilityRequested: false,
    team: 0,
    respawnT: 0,
    respawnWaitSafeT: 0,
    spawnGraceT: 0,
    spawnShieldT: 0,
    spawnProtectionStartedTick: 0,
    spawnHardGraceEndsAtTick: 0,
    spawnShieldEndsAtTick: 0,
    isSpawnOffenseLatched: false,
    spawnBlockedFeedbackCdT: 0,
    pvpRecentSpawnIndices: [],
    pvpRespawnTelemetry: null,
    lastPvpHitBy: null,
    lastPvpHitTick: -1,
    lastPvpKnockbackBy: null,
    lastPvpKnockbackTick: -1,
    pvpDraftFrags: 0,
    pvpDraftActiveTicks: 0,
    pvpDraftOrdinal: 0,
    pvpDraftTick: 0,
    pvpDraftTierBump: 0,
    pvpDraftTrigger: "none",
    pvpDraftOfferTicksLeft: 0,
    pvpDraftOfferElapsedTicks: 0,
    isPvpDraftDeathDelayReported: false,
    isPvpDraftAbsenceDelayReported: false,
    hearthFavorT: 0,
    hearthEmberT: 0,
    hearthAwayT: 0,
    pvpBraceCharge: 0,
    pvpBraceRegenT: 0,
    pvpSightIcdT: 0,
    pvpRipIcdT: 0,
    arenaUltKit: "gunner",
    arenaUlt: freshArenaUltState(),
  };
}

// skipLocalPlayer: the authoritative server owns N per-connection players and adds them via
// spawnPlayerInWorld on join, so it creates the world WITHOUT the implicit LOCAL_ID player.
// Solo/co-op/prediction clients keep the default (one LOCAL_ID player).
export interface WorldOptions {
  isSandbox?: boolean;
  isCoop?: boolean;
  isShared?: boolean;
  skipLocalPlayer?: boolean;
  mode?: WorldMode;
  catalogVersion?: ContentCatalogVersion;
  pvpPolicy?: string | null;
}

// The one mode predicate every "does pvp logic run here?" gate keys off, so co-op stays inert
// by construction (mode defaults to "coop").
export function isPvp(w: WorldState): boolean {
  return w.mode === "pvp";
}

export function isPvpDraftRuntime(w: WorldState): boolean {
  return isPvp(w) && w.pvpPolicy === PRIVATE_DRAFT_PVP_POLICY;
}

export function createWorld(seed: number, floor: number, opts: WorldOptions = {}): WorldState {
  const w: WorldState = {
    tick: 0,
    seed,
    catalogVersion: opts.catalogVersion ?? CURRENT_CONTENT_CATALOG_VERSION,
    procWindow: createProcWindow(),
    sameTargetWindow: createProcWindow(1, 0.30),
    waveBClock: 0,
    floor,
    rev: 0,
    isRunOver: false,
    players: new Map(),
    enemies: [],
    bullets: [],
    pickups: [],
    props: [],
    chests: [],
    hazards: [],
    effects: [],
    floorHazards: [],
    floorHazardClock: 0,
    recentReleases: [],
    gauntlet: null,
    shop: null,
    dungeon: { w: 0, h: 0, tiles: [], rooms: [], edges: [], blueprint: null, spawn: { x: 0, y: 0 }, exit: { x: 0, y: 0 } },
    nav: createNav(),
    obstacleRev: 0,
    flowCd: 0,
    flowKey: -1,
    flowSources: [],
    flockScan: [],
    flockScanTick: -1,
    flockScanKind: "",
    barrelExplosionsThisTick: 0,
    petFetchPartyReadyAtTick: 0,
    rng: new Rng(seed ^ 0x53696d21),
    weaponBag: createWeaponBag(seed, opts.catalogVersion ?? CURRENT_CONTENT_CATALOG_VERSION),
    encounterPlayers: 1,
    encounterPower: 1,
    jetMirror: [],
    floorDescriptor: resolveFloorDescriptor(seed, floor, 1),
    encounter: null,
    pendingSpawns: [],
    spawnReleaseCd: 0,
    heartsThisFloor: 0,
    isFloorEnteredLow: false,
    pityStreak: 0,
    isPityHeartArmed: false,
    nextEnemyId: 0,
    nextPropId: 0,
    nextPickupId: 0,
    nextChestId: 0,
    nextHazardId: 0,
    nextEffectId: 0,
    persistentBossWindows: new Map(),
    warmthDrain: null,
    friendlyNudgeCd: new Map(),
    incomingHealWindows: new Map(),
    partyHealWindow: { tick: 0, hp: 0 },
    enemyHist: new Map(),
    histHead: 0,
    histCount: 0,
    playerHist: new Map(),
    pvpTelemetryEvents: [],
    pendingBlessings: new Map(),
    isBlessingOfferedThisFloor: false,
    wipeTimer: 0,
    remoteTargets: [],
    mode: opts.mode ?? "coop",
    pvpPolicy: opts.pvpPolicy ?? null,
    match: null,
    isCoop: opts.isCoop ?? false,
    isShared: opts.isShared ?? false,
    isSandbox: opts.isSandbox ?? false,
    isGodMode: false,
    targetX: 0,
    targetY: 0,
  };
  loadFloorIntoWorld(w, floor);
  if (!opts.skipLocalPlayer && isPvp(w)) {
    // pvp: route through the shared pvp-aware spawn so the local player gets the fixed HP pool,
    // neutral loadout, team, and a spread arena spawn with break-on-fire protection.
    spawnPlayerInWorld(w, LOCAL_ID);
  } else if (!opts.skipLocalPlayer) {
    const spawn = w.dungeon.spawn;
    const p = createPlayer(LOCAL_ID, spawn.x * TILE + TILE / 2, spawn.y * TILE + TILE / 2);
    // Run start is a floor entry too: the same spawn grace every descend grants (the
    // reposition loop in loadFloorIntoWorld ran before this player existed).
    p.invuln = C.PLAYER_SPAWN_GRACE;
    w.players.set(LOCAL_ID, p);
    recordCurrentSharedWeaponOffers(w, p);
    stockCurrentShopForPlayer(w, p);
  }
  return w;
}

// Add a fresh player to a live world at the current dungeon spawn (authoritative server:
// on join). Returns the created PlayerSim. No-ops to the existing entry if the id is taken.
export function spawnPlayerInWorld(
  w: WorldState,
  id: PlayerId,
  offerIdentity: string = id,
): PlayerSim {
  const existing = w.players.get(id);
  if (existing) return existing;
  // Soft Batch1 late-join: on an active Sever hunt mid-chase, drop the joiner at the
  // current checkpoint room (not the dungeon entrance) so they can rejoin the intercept.
  let sx = w.dungeon.spawn.x * TILE + TILE / 2;
  let sy = w.dungeon.spawn.y * TILE + TILE / 2;
  const enc = w.encounter;
  if (enc && (enc.structureKind === "hunt" || enc.structureKind === "split" || enc.structureKind === "escape") && enc.active) {
    const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
    const cp = Math.max(0, Math.min(cps.length - 1, enc.checkpoint));
    const roomId = cps[cp] ?? enc.currentRoomId;
    const room = w.dungeon.rooms.find((r) => r.id === roomId);
    if (room) {
      sx = room.cx * TILE + TILE / 2;
      sy = room.cy * TILE + TILE / 2;
    }
  }
  const p = createPlayer(id, sx, sy);
  p.offerIdentity = offerIdentity;
  w.players.set(id, p);
  if (isPvp(w)) initPvpPlayer(w, p);
  recordCurrentSharedWeaponOffers(w, p);
  stockCurrentShopForPlayer(w, p);
  return p;
}

function recordCurrentSharedWeaponOffers(w: WorldState, p: PlayerSim): void {
  const current: WeaponId[] = [];
  for (const chest of w.chests) {
    if (!chest.opened && chest.weapon !== undefined) current.push(chest.weapon);
  }
  for (const pickup of w.pickups) {
    if (pickup.kind === "weapon" && pickup.weapon !== null) current.push(pickup.weapon);
  }
  for (const slot of w.shop?.slots ?? []) {
    if (slot.isShared && slot.weapon !== null) current.push(slot.weapon);
  }
  for (const id of current) recordWeaponOffer(p.weaponOfferHistory, id);
}

function stockCurrentShopForPlayer(
  w: WorldState,
  p: PlayerSim,
  refreshedSlotIds?: ReadonlySet<number>,
): void {
  if (!w.shop) return;
  stockShopForViewer(w.shop, w.seed, w.floor, p, refreshedSlotIds);
}

function recordRestockedSharedWeapons(w: WorldState, restockedSlotIds: readonly number[]): void {
  if (!w.shop) return;
  const restocked = new Set(restockedSlotIds);
  for (const slot of w.shop.slots) {
    if (!restocked.has(slot.id) || !slot.isShared || slot.weapon === null) continue;
    for (const p of w.players.values()) recordWeaponOffer(p.weaponOfferHistory, slot.weapon);
  }
}

function refreshPersonalShopStock(w: WorldState, restockedSlotIds: readonly number[]): void {
  if (!w.shop || restockedSlotIds.length === 0) return;
  const refreshed = new Set(restockedSlotIds);
  const players = [...w.players.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of players) stockCurrentShopForPlayer(w, p, refreshed);
}

function refreshMaxedShopBlessings(w: WorldState, p: PlayerSim): void {
  if (!w.shop) return;
  const levels = itemLevelsOf(p.ownedItemIds);
  const invalid = new Set<number>();
  for (const slot of w.shop.slots) {
    if (slot.buyers.includes(p.id)) continue;
    if (slot.kind !== "blessing" && slot.kind !== "rare_blessing" && slot.kind !== "core_infusion") continue;
    const item = itemById(shopSlotForViewer(w.shop, slot, p.id).itemId ?? "");
    if (item && (levels.get(item.id) ?? 0) >= itemMaxLevel(item)) invalid.add(slot.id);
  }
  if (invalid.size > 0) stockCurrentShopForPlayer(w, p, invalid);
}

// Give a freshly-joined pvp player the flat symmetric loadout (fixed HP pool, neutral kit +
// starting weapon, FFA team) and drop them onto a spread spawn with break-on-fire protection.
// The definitive id-sorted spawn assignment happens at the match whistle; on-join placement is
// just "far from everyone here now" so a mid-lobby join isn't dropped onto someone.
function initPvpPlayer(w: WorldState, p: PlayerSim): void {
  // A real kit would route through setPlayerKit (stat lean + maxHp); PVP.kit is "none" for the
  // MVP (no lean, no in-match power loop), so the neutral baseline createPlayer already set is
  // correct — we only fix the loadout, HP pool, and team here.
  p.kitId = PVP.kit;
  p.team = 0;
  p.ownedWeapons = [PVP.startWeapon];
  p.weapon = PVP.startWeapon;
  p.maxHp = PVP.maxHp;
  p.hp = PVP.maxHp;
  p.respawnT = 0;
  p.pvpDraftActiveTicks = 0;
  pvpPlaceOnSpawn(w, p, w.match?.phase === "live");
}

function pvpFaceInward(w: WorldState, p: PlayerSim): void {
  const centerX = w.dungeon.spawn.x * TILE + TILE / 2;
  const centerY = w.dungeon.spawn.y * TILE + TILE / 2;
  p.aimAngle = Math.atan2(centerY - p.y, centerX - p.x);
  p.facing = Math.cos(p.aimAngle) >= 0 ? 1 : -1;
}

function isLivingPvpFoe(source: PlayerSim, candidate: PlayerSim): boolean {
  return candidate.id !== source.id
    && !candidate.isAbsent
    && !candidate.isDown
    && candidate.hp > 0
    && candidate.respawnT === 0
    && arePvpFoes(
      { team: source.team, id: source.id },
      { team: candidate.team, id: candidate.id },
    );
}

function isPvpThreatOwner(w: WorldState, ownerId: PlayerId | null, target: PlayerSim): boolean {
  if (ownerId === null) return false;
  const owner = w.players.get(ownerId);
  return owner !== undefined
    && isLivingPvpFoe(target, owner)
    && owner.spawnGraceT === 0;
}

function isPvpSpawnLineOfSightClear(w: WorldState, x0: number, y0: number, x1: number, y1: number): boolean {
  return hasLineOfSight(w, x0, y0, x1, y1)
    && !propOnSegment(w, x0, y0, x1, y1, 0);
}

function isPvpInwardExitWalkable(w: WorldState, spawn: Vec2, radius: number): boolean {
  const centerX = w.dungeon.spawn.x * TILE + TILE / 2;
  const centerY = w.dungeon.spawn.y * TILE + TILE / 2;
  const dx = centerX - spawn.x;
  const dy = centerY - spawn.y;
  const magnitude = Math.hypot(dx, dy) || 1;
  const x = spawn.x + (dx / magnitude) * TILE;
  const y = spawn.y + (dy / magnitude) * TILE;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return false;
  if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 0) return false;
  return isBodyClear(w, x, y, radius)
    && hasLineOfSight(w, spawn.x, spawn.y, x, y)
    && !propOnSegment(w, spawn.x, spawn.y, x, y, radius);
}

function segmentCircleEntryFraction(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a <= 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

interface PvpIncomingThreat {
  etaSec: number;
  damage: number;
}

function pvpAreaThreat(
  spawn: Vec2,
  playerRadius: number,
  x: number,
  y: number,
  radius: number,
  etaSec: number,
  damage: number,
): PvpIncomingThreat | null {
  return Math.hypot(spawn.x - x, spawn.y - y) <= radius + playerRadius
    ? { etaSec, damage }
    : null;
}

function predictPvpBulletThreat(
  w: WorldState,
  target: PlayerSim,
  spawn: Vec2,
  bullet: Bullet,
): PvpIncomingThreat | null {
  if (!bullet.friendly || bullet.life <= 0 || !isPvpThreatOwner(w, bullet.owner, target)) return null;
  if (bullet.homing !== undefined && bullet.homing > 0) {
    const centerDistance = Math.hypot(spawn.x - bullet.x, spawn.y - bullet.y);
    const distance = Math.max(
      0,
      centerDistance - target.pr - bullet.radius,
    );
    const speed = Math.hypot(bullet.vx, bullet.vy);
    const etaSec = speed > 0 ? distance / speed : Infinity;
    if (centerDistance <= HOMING_ACQUIRE_RANGE + target.pr
      && etaSec <= bullet.life
      && etaSec <= PVP.spawnThreatOuterHorizonSec) {
      return {
        etaSec,
        damage: pvpHitDamage(bullet.fx ?? PVP.startWeapon, bullet.damage),
      };
    }
  }
  const dt = 1 / TICKS_PER_SECOND;
  const maxSteps = Math.ceil(PVP.spawnThreatOuterHorizonSec * TICKS_PER_SECOND);
  let x = bullet.x;
  let y = bullet.y;
  let vx = bullet.vx;
  let vy = bullet.vy;
  let life = bullet.life;
  let bounces = bullet.bounce ?? 0;
  for (let step = 1; step <= maxSteps && life > 0; step++) {
    if (bullet.accel !== undefined) {
      const speed = Math.hypot(vx, vy);
      if (speed > 0) {
        const scale = (speed + bullet.accel * dt) / speed;
        vx *= scale;
        vy *= scale;
      }
    }
    const nextX = x + vx * dt;
    const nextY = y + vy * dt;
    life -= dt;
    const etaSec = step * dt;
    if (life <= 0) {
      if (bullet.blast !== undefined) {
        return pvpAreaThreat(spawn, target.pr, nextX, nextY, bullet.blast, etaSec,
          pvpHitDamage(bullet.fx ?? PVP.startWeapon, bullet.damage));
      }
      if (bullet.implode !== undefined) {
        return pvpAreaThreat(spawn, target.pr, nextX, nextY, bullet.implode, etaSec,
          pvpHitDamage(bullet.fx ?? PVP.startWeapon, bullet.damage * C.IMPLODE_SPLASH_FRAC));
      }
      return null;
    }
    const isPhase = bullet.isPhase === true;
    if (!isPhase && isWall(w, nextX, nextY)) {
      if (bullet.blast !== undefined) {
        return pvpAreaThreat(spawn, target.pr, x, y, bullet.blast, etaSec,
          pvpHitDamage(bullet.fx ?? PVP.startWeapon, bullet.damage));
      }
      if (bullet.implode !== undefined) {
        return pvpAreaThreat(spawn, target.pr, x, y, bullet.implode, etaSec,
          pvpHitDamage(bullet.fx ?? PVP.startWeapon, bullet.damage * C.IMPLODE_SPLASH_FRAC));
      }
      if (bounces <= 0) return null;
      const isHorizontalHit = isWall(w, nextX, y);
      const isVerticalHit = isWall(w, x, nextY);
      if (isHorizontalHit) vx = -vx;
      if (isVerticalHit) vy = -vy;
      if (!isHorizontalHit && !isVerticalHit) { vx = -vx; vy = -vy; }
      bounces--;
      continue;
    }
    if (!bullet.isLob) {
      const hitFraction = segmentCircleEntryFraction(
        x, y, nextX, nextY, spawn.x, spawn.y, target.pr + bullet.radius,
      );
      if (hitFraction !== null) {
        const hitX = x + (nextX - x) * hitFraction;
        const hitY = y + (nextY - y) * hitFraction;
        const isBlockedByCover = !isPhase
          && bullet.pierce <= 0
          && propOnSegment(w, x, y, hitX, hitY, bullet.radius);
        if (isBlockedByCover) return null;
        const baseDamage = bullet.implode !== undefined
          ? bullet.damage * C.IMPLODE_SPLASH_FRAC
          : bullet.damage;
        return {
          etaSec: (step - 1 + hitFraction) * dt,
          damage: pvpHitDamage(bullet.fx ?? PVP.startWeapon, baseDamage),
        };
      }
      if (!isPhase && bullet.pierce <= 0 && propOnSegment(w, x, y, nextX, nextY, bullet.radius)) {
        return null;
      }
    }
    x = nextX;
    y = nextY;
  }
  return null;
}

function predictPvpEffectThreats(
  w: WorldState,
  target: PlayerSim,
  spawn: Vec2,
  opponents: readonly PlayerSim[],
): PvpIncomingThreat[] {
  const threats: PvpIncomingThreat[] = [];
  for (const opponent of opponents) {
    const swing = opponent.meleeSwing;
    if (swing === null || swing.timer <= 0) continue;
    const [x, y] = swingPose(w, opponent, swing);
    if (isPointInMeleeHit(x, y, spawn.x, spawn.y, target.pr, swing)) {
      threats.push({ etaSec: 0, damage: pvpHitDamage(opponent.weapon, swing.damage) });
    }
  }
  for (const effect of w.effects) {
    if (effect.life <= 0 || !isPvpThreatOwner(w, effect.owner, target)) continue;
    if (effect.kind === "wire") {
      if (effect.life > effect.arm
        && distToSegment(spawn.x, spawn.y, effect.x, effect.y, effect.x2, effect.y2) <= effect.width + target.pr) {
        threats.push({
          etaSec: effect.arm,
          damage: pvpHitDamage(effect.fx, effect.damage),
        });
      }
      continue;
    }
    if (effect.kind === "orbit") {
      if (Math.abs(Math.hypot(spawn.x - effect.x, spawn.y - effect.y) - effect.ring)
        > effect.bladeRadius + target.pr) continue;
      const targetAngle = Math.atan2(spawn.y - effect.y, spawn.x - effect.x);
      let etaSec = Infinity;
      for (let i = 0; i < effect.blades; i++) {
        const bladeAngle = effect.angle + (i / effect.blades) * Math.PI * 2;
        let delta = targetAngle - bladeAngle;
        while (delta < 0) delta += Math.PI * 2;
        while (delta >= Math.PI * 2) delta -= Math.PI * 2;
        etaSec = Math.min(etaSec, delta / Math.max(effect.speed, 1e-6));
      }
      if (etaSec <= effect.life && etaSec <= PVP.spawnThreatOuterHorizonSec) {
        const flareMult = effect.flare > 0
          ? WEAPONS[effect.fx].orbit?.flareBonus ?? 1
          : 1;
        threats.push({ etaSec, damage: pvpHitDamage(effect.fx, effect.damage * flareMult) });
      }
      continue;
    }
    if (effect.kind === "sentry") {
      const distance = Math.hypot(spawn.x - effect.x, spawn.y - effect.y);
      if (distance > effect.range || !isPvpSpawnLineOfSightClear(w, effect.x, effect.y, spawn.x, spawn.y)) continue;
      const etaSec = Math.max(0, effect.fireCd) + distance / effect.boltSpeed;
      if (etaSec <= effect.life && etaSec <= PVP.spawnThreatOuterHorizonSec) {
        threats.push({ etaSec, damage: pvpHitDamage(effect.fx, effect.boltDamage) });
      }
    }
  }
  return threats;
}

function pvpRespawnCandidates(
  w: WorldState,
  player: PlayerSim,
  spawns: readonly Vec2[],
  pits: readonly Vec2[],
): PvpRespawnCandidate[] {
  const opponents = [...w.players.values()]
    .filter((candidate) => isLivingPvpFoe(player, candidate))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const aimCone = PVP.respawnAimConeDeg * Math.PI / 180;
  return spawns.map((spawn, index) => {
    let nearest: PlayerSim | null = null;
    let minOpponentDistance = Infinity;
    let losThreatCount = 0;
    let isAimedAt = false;
    let isCamped = false;
    for (const opponent of opponents) {
      const dx = spawn.x - opponent.x;
      const dy = spawn.y - opponent.y;
      const distance = Math.hypot(dx, dy);
      if (distance < minOpponentDistance) {
        minOpponentDistance = distance;
        nearest = opponent;
      }
      if (distance <= PVP.respawnCampRadius) isCamped = true;
      const isLosThreat = distance <= PVP.spawnLosAimRange
        && isPvpSpawnLineOfSightClear(w, opponent.x, opponent.y, spawn.x, spawn.y);
      if (isLosThreat) losThreatCount++;
      const bearing = Math.atan2(dy, dx);
      const aimDelta = Math.abs(Math.atan2(
        Math.sin(bearing - opponent.aimAngle),
        Math.cos(bearing - opponent.aimAngle),
      ));
      if (isLosThreat && aimDelta <= aimCone) isAimedAt = true;
    }
    if (opponents.length === 0) minOpponentDistance = PVP.spawnMinOpponentDist;
    const threats = predictPvpEffectThreats(w, player, spawn, opponents);
    for (const bullet of w.bullets) {
      const threat = predictPvpBulletThreat(w, player, spawn, bullet);
      if (threat !== null) threats.push(threat);
    }
    let incomingThreatEtaSec: number | null = null;
    let predictedIncomingDamage = 0;
    for (const threat of threats) {
      if (incomingThreatEtaSec === null || threat.etaSec < incomingThreatEtaSec) {
        incomingThreatEtaSec = threat.etaSec;
      }
      if (threat.etaSec <= PVP.spawnThreatHorizonSec) predictedIncomingDamage += threat.damage;
    }
    const pitDistance = pvpNearestPitEdgeDistance(spawn, pits);
    return {
      index,
      minOpponentDistance,
      pitDistance: Number.isFinite(pitDistance) ? pitDistance : 0,
      losThreatCount,
      isAimedAt,
      incomingThreatEtaSec,
      predictedIncomingDamage,
      isCoveredFromNearest: nearest !== null
        && !isPvpSpawnLineOfSightClear(w, nearest.x, nearest.y, spawn.x, spawn.y),
      isInwardExitWalkable: isPvpInwardExitWalkable(w, spawn, player.pr),
      isCamped,
      isPitEligible: pits.length === 0 || pitDistance > pvpSingleDashDistance(),
    };
  });
}

interface PvpRespawnAssessment {
  candidates: PvpRespawnCandidate[];
  safeCount: number;
  isAllEightThreatened: boolean;
}

function assessPvpRespawn(w: WorldState, player: PlayerSim): PvpRespawnAssessment {
  const spawns = w.match?.spawns ?? [];
  const pits = w.match?.pits ?? [];
  const candidates = pvpRespawnCandidates(w, player, spawns, pits);
  return {
    candidates,
    safeCount: candidates.filter(isPvpRespawnCandidateSafe).length,
    isAllEightThreatened: candidates.length === 8
      && candidates.every(isPvpRespawnCandidateThreatened),
  };
}

function armPvpSpawnProtection(w: WorldState, p: PlayerSim, isFallbackShield = false): void {
  const shieldTicks = isFallbackShield
    ? pvpSpawnFallbackShieldTicks()
    : pvpSpawnShieldTicks();
  p.invuln = 0;
  p.spawnGraceT = pvpSpawnHardGraceTicks();
  p.spawnShieldT = shieldTicks;
  p.spawnProtectionStartedTick = w.tick;
  p.spawnHardGraceEndsAtTick = w.tick + pvpSpawnHardGraceTicks();
  p.spawnShieldEndsAtTick = w.tick + shieldTicks;
  p.isSpawnOffenseLatched = false;
  p.spawnBlockedFeedbackCdT = 0;
}

function rememberPvpSpawn(p: PlayerSim, index: number): void {
  p.pvpRecentSpawnIndices.push(index);
  if (p.pvpRecentSpawnIndices.length > 2) p.pvpRecentSpawnIndices.shift();
}

function beginPvpRespawnTelemetry(
  w: WorldState,
  p: PlayerSim,
  index: number,
  candidates: readonly PvpRespawnCandidate[],
  waitSafeTicks: number,
  isFallbackShield: boolean,
): void {
  const chosen = candidates.find((candidate) => candidate.index === index);
  p.pvpRespawnTelemetry = chosen === undefined
    ? null
    : {
        spawnTick: w.tick,
        activeTicks: 0,
        threatFlags: pvpRespawnThreatFlags(chosen),
        chosenIndex: index,
        safeCount: candidates.filter(isPvpRespawnCandidateSafe).length,
        waitSafeMs: Math.round(waitSafeTicks * 1000 / TICKS_PER_SECOND),
        timeToFirstInputMs: null,
        shieldBreakMs: null,
        firstDamageMs: null,
        isShieldBrokenByAttack: false,
        isDeathWithin3s: false,
        isRepeatedIndex: p.pvpRecentSpawnIndices.includes(index),
        isFallbackShield,
        killerDistance: null,
      };
}

function pvpPlaceOnSpawn(
  w: WorldState,
  p: PlayerSim,
  isRemembered = true,
  waitSafeTicks = 0,
  assessedCandidates?: readonly PvpRespawnCandidate[],
  selectionMode: PvpRespawnSelectionMode = "normal",
): void {
  const spawns = w.match?.spawns ?? [];
  if (spawns.length > 0) {
    const candidates = assessedCandidates ?? assessPvpRespawn(w, p).candidates;
    const idx = pvpRespawnIndex(candidates, p.pvpRecentSpawnIndices, selectionMode);
    p.x = spawns[idx].x;
    p.y = spawns[idx].y;
    beginPvpRespawnTelemetry(
      w,
      p,
      idx,
      candidates,
      waitSafeTicks,
      selectionMode === "timeout",
    );
    if (isRemembered) rememberPvpSpawn(p, idx);
  }
  pvpFaceInward(w, p);
  armPvpSpawnProtection(w, p, selectionMode === "timeout");
  p.lastPvpHitBy = null;
  p.lastPvpHitTick = -1;
  p.lastPvpKnockbackBy = null;
  p.lastPvpKnockbackTick = -1;
}

// Assign a kit to a player (lobby kit-select at spawn / dev sandbox / the authoritative server
// at join, AFTER validating the kit against the account's Mastery unlocks). Applies the kit's
// stat lean through the ONE recompute path (a different route to the committed caps), refreshes
// max HP, tops to the new max (a fresh spawn), swaps to the kit's starting weapon if the player
// still holds only the default, and clears any live ult/passive state. Server-owned.
export function setPlayerKit(w: WorldState, pid: PlayerId, kit: KitId): void {
  const p = w.players.get(pid);
  if (!p) return;
  p.kitId = kit;
  recomputeMods(p.mods, p.ownedItemIds, kit);
  applyMaxHpBonus(p);
  p.hp = p.maxHp;
  p.ultCharge = 0;
  p.ultReadyAtTick = 0;
  p.overdriveT = 0;
  p.overheatT = 0;
  p.overshieldRegenT = 0;
  p.pulseReadyAtTick = 0;
  p.phaseSpeed = 0;
  p.ultInvuln = 0;
  p.passiveState = 0;
  p.ultSources = freshUltSources();
  p.ultWasted = 0;
  p.isUltRequested = false;
  p.isPulseRequested = false;
  // Pet ability windows are cleared on a loadout (re)apply too — the pet id itself is bound
  // separately (setPlayerPet) and is intentionally untouched here (it is not a kit choice).
  p.petCdReadyAtTick = 0;
  p.petTellT = 0;
  p.petLightT = 0;
  p.petFetchT = 0;
  p.petShieldT = 0;
  p.petNullT = 0;
  p.isPetAbilityRequested = false;
  // BULWARK opens with a full OVERSHIELD so the signature is felt in the first 30 seconds; every
  // other kit carries none (the pool is inert for them).
  p.overshield = kit === "bulwark" ? OVERSHIELD.maxChips : 0;
  // Hand the kit its signature starting weapon — but only when the player is still on the
  // stock default loadout (never stomp a mid-run pickup / a re-select that kept gear).
  if (isRealKit(kit)) {
    const start = KIT_START_WEAPON[kit] as WeaponId;
    if (p.ownedWeapons.length === 1 && p.ownedWeapons[0] === DEFAULT_WEAPON && start !== DEFAULT_WEAPON) {
      p.ownedWeapons = [start];
      p.weapon = start;
    }
  }
}

// Bind a player's OWNER-BOUND pet (PROTOCOL 45) from the verified join identity — the mirror of
// setPlayerKit for the ability source. The cosmetic FOLLOW stays client-only; the sim keeps only
// the id so updatePetAbilities can resolve the verb. Idempotent (safe on a resume re-bind); it
// never touches the CD/effect windows, so a reconnect preserves an in-flight ability.
export function setPlayerPet(w: WorldState, pid: PlayerId, pet: string | null): void {
  const p = w.players.get(pid);
  if (!p) return;
  p.pet = pet;
}

// §10 ACCRUE ult charge from one SOURCE, respecting the per-source SHARE cap toward the current
// meter fill (so no single input dominates) and logging any overcharge held at 100 as "wasted"
// for balancer tuning. "time" is uncapped (the floor). No-op for the neutral baseline.
function accrueUlt(p: PlayerSim, source: UltSource, amount: number): void {
  if (!isRealKit(p.kitId) || amount <= 0) return;
  if (source !== "time") {
    const room = ultShareCapUnits(source) - p.ultSources[source];
    if (room <= 0) return;
    if (amount > room) amount = room;
    p.ultSources[source] += amount;
  }
  p.ultCharge += amount;
  if (p.ultCharge > ULT.meterMax) {
    p.ultWasted += p.ultCharge - ULT.meterMax; // overcharge held at 100 is lost (the tuning stat)
    p.ultCharge = ULT.meterMax;
  }
}

// One authoritative "this player just dealt `dmg`" hook (called from strikeEnemy after the hit
// lands). Feeds the ult meter (all kits, NORMALIZED by the floor's RefEncounterHP so it charges
// per-encounter, not per-raw-damage — §10), ramps GUNNER momentum, and banks MENDER lifebloom
// credit. No-op for the neutral baseline. `p` may be null (a departed owner's projectile).
function onKitDamageDealt(w: WorldState, p: PlayerSim | null, dmg: number): void {
  // No-snowball: pvp is flat symmetric with ZERO in-match power gain, so no kit charge/momentum
  // loop ever accrues (pvp routes damage through damagePlayer, never strikeEnemy, so this is
  // already unreachable in pvp — the gate makes the invariant explicit and future-proof).
  if (isPvp(w)) return;
  if (p === null || !isRealKit(p.kitId) || dmg <= 0) return;
  accrueUlt(p, "dmg", ultChargeFromDamageDealt(dmg, refEncounterHpForFloor(w.floor)));
  if (p.kitId === "gunner") {
    if (p.passiveState < MOMENTUM.maxStacks) {
      p.passiveState += 1;
      // OVERHEAT boil-over: reaching max stacks fires a short +fire/+pierce burst, then the ramp
      // falls to resetStacks (not 0) so it keeps rolling. overheatT decays in stepPlayerPhase and
      // is read by currentFireRate/resolveShot (a faster route to the raw fire cap, never above).
      if (p.passiveState >= MOMENTUM.maxStacks) {
        p.overheatT = ticksToSec(OVERHEAT.burstTicks);
        p.passiveState = OVERHEAT.resetStacks;
      }
    }
  } else if (p.kitId === "mender") {
    p.passiveState = Math.min(LIFEBLOOM.poolCap, p.passiveState + dmg * LIFEBLOOM.fraction);
  }
}

// The MENDER post-damage SELF-heal delay in ticks: after a Mender takes a landed hit, its OWN
// healing pauses this long (a hit dents and matters for a beat). Ally healing is never gated.
const SELF_HEAL_DELAY_TICKS = Math.round(MENDER_HEAL_CLAMP.selfHealDelaySec * TICKS_PER_SECOND);

// Is `p`'s SELF-heal currently paused by a recent hit? A pure tick comparison (no wall-clock), so
// it is fully deterministic. -1 (never damaged) reads as not-delayed.
function isSelfHealDelayed(w: WorldState, p: PlayerSim): boolean {
  return p.lastDamagedTick >= 0 && w.tick - p.lastDamagedTick < SELF_HEAL_DELAY_TICKS;
}

// The min ticks between two 1-HP SELF-heals — the sustained self-heal CEILING (guard). ceil so the
// realized rate stays ≤ selfHpPerSec (at 0.6/s → 34 ticks → ~0.588 HP/s). Slower than Lifebloom's
// 40-tick cadence, so a Lifebloom-only Mender self-heals at its natural ~0.5/s untouched; only
// STACKED self output (Sanctuary-on-self + self-pulse) is throttled to the ceiling.
const SELF_HEAL_TICKS_PER_HP = Math.ceil(TICKS_PER_SECOND / MENDER_HEAL_CLAMP.selfHpPerSec);

// §10 incoming-heal ROOM (whole HP) allowed RIGHT NOW. For an ALLY it's the shared rolling 1s
// per-target budget AND the party-wide budget, so combined Mender output (any Mender count,
// Lifebloom + Sanctuary) never double-stacks or out-heals incoming damage. For a SELF-heal the
// per-target term is instead the selfHpPerSec CEILING (≤1 HP per SELF_HEAL_TICKS_PER_HP); the
// party budget is shared and unchanged.
function incomingHealRoom(w: WorldState, target: PlayerSim, isSelf: boolean): number {
  const now = w.tick;
  const win = TICKS_PER_SECOND; // 1s rolling window
  const partyHealed = now - w.partyHealWindow.tick < win ? w.partyHealWindow.hp : 0;
  const partyRoom = MENDER_HEAL_CLAMP.partyHpPerSec - partyHealed;
  let perTargetRoom: number;
  if (isSelf) {
    perTargetRoom = now >= target.selfHealReadyTick ? 1 : 0; // the sustained self-heal ceiling
  } else {
    const tw = w.incomingHealWindows.get(target.id);
    const targetHealed = tw && now - tw.tick < win ? tw.hp : 0;
    perTargetRoom = MENDER_HEAL_CLAMP.perTargetHpPerSec - targetHealed;
  }
  return Math.max(0, Math.floor(Math.min(perTargetRoom, partyRoom) + 1e-9));
}

// Commit `hp` of actually-applied Mender healing against the party budget and, per target type,
// either the SELF ceiling (advance the next-self-heal tick) or the shared ally per-target window.
function consumeIncomingHeal(w: WorldState, target: PlayerSim, hp: number, isSelf: boolean): void {
  const now = w.tick;
  const win = TICKS_PER_SECOND;
  if (isSelf) {
    target.selfHealReadyTick = now + SELF_HEAL_TICKS_PER_HP; // hold the next self-HP to the ceiling cadence
  } else {
    const tw = w.incomingHealWindows.get(target.id);
    if (tw && now - tw.tick < win) tw.hp += hp; else w.incomingHealWindows.set(target.id, { tick: now, hp });
  }
  if (now - w.partyHealWindow.tick < win) w.partyHealWindow.hp += hp; else w.partyHealWindow = { tick: now, hp };
}

// Heal an ally by a MENDER source, clamped to maxHp (overheal does nothing, spec §2.2), emitting
// the heal FX and crediting the healer's ult meter with the ACTUAL HP restored. `throughClamp`
// routes the heal through the shared per-target/party incoming-heal RATE budget (§10 — the HoT
// stream: Lifebloom + Sanctuary HoT + any Mender count share ONE budget, so sustained healing
// never double-stacks or out-heals incoming damage). The one-time on-cast BURST bypasses the RATE
// clamp (it is not sustained output) but is still maxHp-clamped. Returns HP restored.
function menderHeal(w: WorldState, healer: PlayerSim | null, target: PlayerSim, amount: number, ev: SimEvent[], throughClamp: boolean): number {
  if (target.isDown || target.hp <= 0) return 0; // a HoT never revives (spec §7)
  const isSelf = healer !== null && healer === target;
  if (isSelf) {
    // SELF-heal: PRIMARY gate is the post-hit delay (no top-off for a beat after a hit); the
    // selfHpPerSec ceiling is the guard. Both apply to the HoT AND the on-cast burst, so a Mender
    // can't stack self-heal above the ceiling by casting Sanctuary on itself.
    if (isSelfHealDelayed(w, target)) return 0;
    amount = Math.min(amount, incomingHealRoom(w, target, true));
  } else if (throughClamp) {
    // ALLY HoT: the shared per-target/party rate clamp (unchanged). The on-cast burst
    // (throughClamp false) bypasses it exactly as before — a clutch save is never rate-limited.
    amount = Math.min(amount, incomingHealRoom(w, target, false));
  }
  if (amount <= 0) return 0;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + amount);
  const healed = target.hp - before; // overheal discarded (never counts against the budget)
  if (healed <= 0) return 0;
  if (isSelf || throughClamp) consumeIncomingHeal(w, target, healed, isSelf);
  ev.push({ t: "heal", pid: target.id, x: target.x, y: target.y });
  if (healer && isRealKit(healer.kitId)) accrueUlt(healer, "heal", ultChargeFromHealDone(healed));
  return healed;
}

// The lowest-HP living ally within `range` of a player (self counts only when no other ally is a
// better target — Lifebloom tops the team, or you when solo/none). Downed allies are skipped (a
// HoT never revives).
function lowestHpAllyInRange(w: WorldState, p: PlayerSim, range: number): PlayerSim | null {
  let best: PlayerSim | null = null;
  let bestMissing = -1;
  for (const other of w.players.values()) {
    if (other.isDown || other.hp <= 0 || other.isAbsent) continue;
    if (other !== p && Math.hypot(other.x - p.x, other.y - p.y) > range) continue;
    const missing = other.maxHp - other.hp;
    if (missing <= 0) continue;
    if (missing > bestMissing) { bestMissing = missing; best = other; }
  }
  return best;
}

// The authoritative ULT step (spec §3/§7), run ONCE per tick in the world phase — which online
// prediction never runs, so every ult effect (heal/shield/teleport/invuln + the meter) is
// server-owned and a client only ever renders the resulting SimEvents/entities. Handles the
// slow time-trickle FLOOR, the MENDER lifebloom HoT payout, and resolving each pending cast.
// The authoritative PET ABILITY pass. Server-owned exactly like updateUlts: online prediction
// never runs this world phase, so a client can never resolve one. Pets now fire AUTONOMOUSLY —
// no player bind: each tick a living owner's verb self-evaluates its smart trigger and casts when
// a useful context is present (shouldPetAutoCast). The retired active-bind is kept only as a debug
// FORCE-cast (isPetAbilityRequested, production-unbound) so a dev build can still exercise a verb
// on demand; both paths funnel through tryStartPetAbility, which owns every rail. Hard OFF in pvp —
// the whole pass returns before any state moves, so no verb can fire in the arena and the wire
// fields stay zeroed (abilities OFF; cosmetic follow only).
function updatePetAbilities(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (isPvp(w)) return;
  for (const p of w.players.values()) {
    // The one-hit brace is a downed-clears rail: a body that goes down loses the shield outright
    // (checked every tick so a mid-tell down can't leave a stale bubble hanging).
    if (p.isDown && p.petShieldT > 0) p.petShieldT = 0;
    // Open a cast this tick — auto (smart trigger) or the debug force bit. The cheap eligibility
    // precheck (equipped verb, alive, ready, not mid-tell) gates the smart-trigger world read;
    // tryStartPetAbility then re-validates every rail and BURNS the CD up front on success (a later
    // party-throttle / soft-cap no-op deliberately gets no refund — the AI does not get free retries).
    const isForced = p.isPetAbilityRequested;
    p.isPetAbilityRequested = false;
    const verb = petVerbFor(p.pet);
    if (verb !== null && p.petTellT <= 0 && !p.isDown && p.hp > 0 && !p.isAbsent && w.tick >= p.petCdReadyAtTick
      && (isForced || shouldPetAutoCast(w, p, verb))) {
      tryStartPetAbility(w, p);
    }
    // The tell resolves into the verb the tick it elapses (never mid-tell). A cast cannot re-open
    // it: the CD was burned at tell start, so tryStartPetAbility refuses until it lapses.
    if (p.petTellT > 0) {
      p.petTellT = p.petTellT > dt ? p.petTellT - dt : 0;
      if (p.petTellT <= 0) firePetVerb(w, p, ev);
    }
    // Active windows decay + apply. FETCH pulls each tick it is live; every other window just
    // counts down (its effect is read off the timer by the resolver/renderer, owner-only).
    if (p.petFetchT > 0) {
      applyFetchPull(w, p, dt);
      p.petFetchT = p.petFetchT > dt ? p.petFetchT - dt : 0;
    }
    if (p.petLightT > 0) p.petLightT = p.petLightT > dt ? p.petLightT - dt : 0;
    if (p.petShieldT > 0) p.petShieldT = p.petShieldT > dt ? p.petShieldT - dt : 0;
    if (p.petNullT > 0) p.petNullT = p.petNullT > dt ? p.petNullT - dt : 0;
  }
}

// Gate + open a pet ability: no ability pet -> silent no-op (no CD); OFF while downed/absent;
// refused on cooldown or while a tell is already in flight. STALK/RATTLE additionally require a
// live target and fail-soft with NO cooldown when nothing is in reach (checked HERE, at cast). On
// success it burns the verb's CD and opens the tell — the verb fires when the tell elapses.
function tryStartPetAbility(w: WorldState, p: PlayerSim): void {
  const verb = petVerbFor(p.pet);
  if (verb === null) return;
  if (p.isDown || p.hp <= 0 || p.isAbsent) return;
  if (w.tick < p.petCdReadyAtTick) return;
  if (p.petTellT > 0) return;
  if (petVerbNeedsTarget(verb) && findPetTarget(w, p, verb) === null) return;
  p.petCdReadyAtTick = w.tick + petCooldownTicks(verb);
  p.petTellT = PET_ABILITY.tellSec;
}

// The AUTO-CAST decision: does the verb's SMART trigger read a useful context right NOW? A pure,
// deterministic read of the current world (no RNG) — false means "nothing worth casting on", so
// the CD is never burned on empty air (the fail-soft rail the retired manual bind had). Each rule
// mirrors the resolver's own reach/eligibility so the AI never opens a tell that would then no-op:
//   FETCH       — a fetchable pickup (coins; never hearts/loot) sits inside the pull radius
//   PINPRICK    — the owner is IN COMBAT (a live enemy at the doorstep): light the fight, not idle
//   STALK       — an eligible mark (elite, or anyone mid-tell) is in reach (defers to findPetTarget)
//   EMBERPUFF   — a cinder pool overlaps the owner's reach (there is fire to shorten)
//   SLIMETRAIL  — a non-boss enemy stands close enough to cross a patch dropped under the owner
//   PEBBLEBRACE — a high-signal hurt read (hit within ~2s, OR in the low-HP band): never idle chip
//   RATTLE      — an interruptible trash wind-up is in reach (defers to findPetTarget)
//   NULLWAKE    — the owner is taking / about to take floor-hazard damage (cinder, or a live/arming tile)
function shouldPetAutoCast(w: WorldState, p: PlayerSim, verb: PetVerb): boolean {
  switch (verb) {
    case "fetch": return hasFetchablePickupInReach(w, p);
    case "pinprick": return isPlayerInCombat(w, p);
    case "stalk": return findPetTarget(w, p, "stalk") !== null;
    case "emberpuff": return cinderOverlapsReach(w, p, PET_ABILITY.emberpuff.radius);
    case "slimetrail": return hasSlowableEnemyNear(w, p);
    case "pebblebrace": return wasOwnerRecentlyDamaged(w, p) || p.hp <= p.maxHp * PET_AUTOCAST.braceLowHpFrac;
    case "rattle": return findPetTarget(w, p, "rattle") !== null;
    case "nullwake": return isOwnerInFloorHazardDanger(w, p);
  }
}

// FETCH auto-trigger: at least one FETCHABLE pickup (coins only) sits within the pull radius — the
// same reach applyFetchPull draws from, so a fired pull always has something to yank.
function hasFetchablePickupInReach(w: WorldState, p: PlayerSim): boolean {
  const reach = PET_ABILITY.fetch.radius;
  for (const pk of w.pickups) {
    if (!isFetchablePickup(pk.kind)) continue;
    if (Math.hypot(pk.x - p.x, pk.y - p.y) <= reach) return true;
  }
  return false;
}

// EMBERPUFF auto-trigger: a damaging cinder pool overlaps the owner's reach — mirrors the resolver's
// own reach + h.radius overlap so the puff always finds fire to shorten.
function cinderOverlapsReach(w: WorldState, p: PlayerSim, reach: number): boolean {
  for (const h of w.hazards) {
    if (h.kind !== "cinder") continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) <= reach + h.radius) return true;
  }
  return false;
}

// SLIMETRAIL auto-trigger: a NON-boss enemy (bosses are slow-immune) stands within the auto reach,
// close enough that the patch dropped under the owner will actually be crossed.
function hasSlowableEnemyNear(w: WorldState, p: PlayerSim): boolean {
  const r = PET_AUTOCAST.slimeEnemyRadius;
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e) || isBossGradeKind(e)) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) <= r) return true;
  }
  return false;
}

// The PEBBLEBRACE "hurt" read: a hit landed within the recent-damage window. A pure tick compare
// (-1 = never hit reads as not-recent), so the brace AI is deterministic + reconnect-safe.
function wasOwnerRecentlyDamaged(w: WorldState, p: PlayerSim): boolean {
  return p.lastDamagedTick >= 0 && w.tick - p.lastDamagedTick < PET_AUTOCAST.recentDamageTicks;
}

// NULLWAKE auto-trigger: the owner is taking (or about to take) FLOOR-hazard damage — standing in a
// cinder pool, or on a floor-hazard tile that is damaging now or arming (telegraph). The 0.30s tell
// plus the null window then cover the burn. Never reads projectiles/contact (NULLWAKE voids only
// floor damage), matching the damage side (updateFloorHazards / cinderBurn).
function isOwnerInFloorHazardDanger(w: WorldState, p: PlayerSim): boolean {
  for (const h of w.hazards) {
    if (h.kind !== "cinder") continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) < h.radius) return true;
  }
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  for (const h of w.floorHazards) {
    if (h.tx !== tx || h.ty !== ty) continue;
    const phase = floorHazardPhaseAt(h, w.floorHazardClock);
    if (phase === "active" || phase === "telegraph") return true;
  }
  return false;
}

// Fire the equipped pet's verb once its tell has elapsed. Fail-soft if the owner went down during
// the tell (utility OFF while downed — the CD stays burned, nothing fires).
function firePetVerb(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const verb = petVerbFor(p.pet);
  if (verb === null || p.isDown || p.hp <= 0 || p.isAbsent) return;
  switch (verb) {
    case "fetch": firePetFetch(w, p); break;
    case "pinprick": firePetPinprick(w, p); break;
    case "stalk": firePetStalk(w, p); break;
    case "emberpuff": firePetEmberpuff(w, p, ev); break;
    case "slimetrail": firePetSlimetrail(w, p, ev); break;
    case "pebblebrace": p.petShieldT = PET_ABILITY.pebblebrace.shieldSec; break;
    case "rattle": firePetRattle(w, p, ev); break;
    case "nullwake": p.petNullT = PET_ABILITY.nullwake.nullSec; break;
  }
}

// Doggie FETCH: open a short pull window, gated by the party throttle (1 pulse / party / 2.0s).
// A throttled fetch is a fail-soft no-op — no pull opens and the CD is NOT refunded.
function firePetFetch(w: WorldState, p: PlayerSim): void {
  if (w.tick < w.petFetchPartyReadyAtTick) return;
  w.petFetchPartyReadyAtTick = w.tick + PET_ABILITY.fetch.partyThrottleTicks;
  p.petFetchT = PET_ABILITY.fetch.pulseSec;
}

// Wick PINPRICK: open the owner-only light window, gated by the party soft-cap (<= 2 contributing
// windows). Capped out -> fail-soft no-op (no light), CD not refunded. Never revives, never damage.
function firePetPinprick(w: WorldState, p: PlayerSim): void {
  let active = 0;
  for (const other of w.players.values()) {
    if (other !== p && other.petLightT > 0) active++;
  }
  if (active >= PET_ABILITY.pinprick.partyMaxWindows) return;
  p.petLightT = PET_ABILITY.pinprick.lightSec;
}

// Cat STALK: stamp an INFO pip on the nearest valid body (elite, or anyone mid-tell). Info only —
// it never amplifies damage/stun/phase; the CD outlasts the mark so no owner can hold two.
// Fail-soft if the target left reach during the tell (CD already committed).
function firePetStalk(w: WorldState, p: PlayerSim): void {
  const target = findPetTarget(w, p, "stalk");
  if (target === null) return;
  target.petMarkT = Math.max(target.petMarkT, PET_ABILITY.stalk.markSec);
}

// Baby Dragon EMBERPUFF: scale the REMAINING life of every damaging floor hazard (cinder pools
// only) overlapping the owner. Never a boss tell (omen) / volatile charge / JET corruption / pave
// / convoy / objective light — those hazard kinds are left untouched. 0 damage.
function firePetEmberpuff(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const reach = PET_ABILITY.emberpuff.radius;
  let touched = false;
  for (const h of w.hazards) {
    if (h.kind !== "cinder") continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) > reach + h.radius) continue;
    h.life *= PET_ABILITY.emberpuff.hazardLifeMul;
    touched = true;
  }
  if (touched) ev.push({ t: "puff", x: p.x, y: p.y, n: 6, color: "#ffb066" });
}

// Baby Slime SLIMETRAIL: drop an enemy-slowing floor patch under the owner. The whole PARTY shares
// a hard cap of live patches per room; over the cap it is a fail-soft no-op (CD already committed).
// The patch deals ZERO damage — it rides the hazard list purely for position/life/render.
function firePetSlimetrail(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  let live = 0;
  for (const h of w.hazards) if (h.kind === "slime") live++;
  if (live >= PET_ABILITY.slimetrail.partyPatchCap) return;
  w.hazards.push({
    id: w.nextHazardId++, kind: "slime", x: p.x, y: p.y,
    radius: PET_ABILITY.slimetrail.patchRadius,
    life: PET_ABILITY.slimetrail.patchLifeSec, maxLife: PET_ABILITY.slimetrail.patchLifeSec,
  });
  ev.push({ t: "puff", x: p.x, y: p.y, n: 6, color: "#8be86b" });
}

// Clatter RATTLE: cancel the nearest trash body's wind-up into recover (a real telegraph interrupt,
// never damage). Elites/bosses/mechanic sockets are immune (excluded by findPetTarget). Fail-soft
// if the target left its wind-up during the tell (CD already committed).
function firePetRattle(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const target = findPetTarget(w, p, "rattle");
  if (target === null) return;
  enterRecover(target);
  ev.push({ t: "puff", x: target.x, y: target.y, n: 5, color: "#cfd8ff" });
}

// The STALK/RATTLE target picker: the nearest LIVE body in the verb's radius that passes the verb's
// eligibility rail. Returns null when nothing qualifies (the fail-soft, no-CD path at cast).
function findPetTarget(w: WorldState, p: PlayerSim, verb: PetVerb): Enemy | null {
  const radius = verb === "stalk" ? PET_ABILITY.stalk.radius : PET_ABILITY.rattle.radius;
  let best: Enemy | null = null;
  let bestD = radius * radius;
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    if (!(verb === "stalk" ? isStalkTarget(e) : isRattleTarget(e))) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d >= bestD) continue;
    best = e; bestD = d;
  }
  return best;
}

// STALK marks an elite outright, or ANY body (trash/brute/boss) only while it is mid-tell — a boss
// is info-tagged solely to read its telegraph aim, never at rest.
function isStalkTarget(e: Enemy): boolean {
  if (e.tier === "elite") return true;
  return e.attack.phase === "windup";
}

// RATTLE only bites a trash wind-up: the body must be winding up AND be neither elite nor
// boss-grade (boss/miniboss/captain). Sockets/props never wind up, so they never qualify.
function isRattleTarget(e: Enemy): boolean {
  if (e.attack.phase !== "windup") return false;
  if (e.tier === "elite" || isBossGradeKind(e)) return false;
  return true;
}

// One FETCH pull step: draw every FETCHABLE loose pickup (coins only — hearts/weapons excluded) in
// range toward the owner, per-axis against walls exactly like the coin magnet, so loot slides
// around a wall but is never dragged THROUGH one. Collection then happens in updatePickups.
function applyFetchPull(w: WorldState, p: PlayerSim, dt: number): void {
  const reach = PET_ABILITY.fetch.radius;
  const step = PET_ABILITY.fetch.pullSpeed * dt;
  for (const pk of w.pickups) {
    if (!isFetchablePickup(pk.kind)) continue;
    const dx = p.x - pk.x, dy = p.y - pk.y;
    const d = Math.hypot(dx, dy);
    if (d <= 0.5 || d > reach) continue;
    const pull = Math.min(d, step);
    const sx = (dx / d) * pull, sy = (dy / d) * pull;
    if (!isWall(w, pk.x + sx, pk.y)) pk.x += sx;
    if (!isWall(w, pk.x, pk.y + sy)) pk.y += sy;
  }
}

function updateUlts(w: WorldState, ev: SimEvent[]): void {
  // PHANTOM dash charge (spec §2.4): credited off this tick's authoritative dashStart events, so
  // the meter never accrues in client prediction (which never runs this world phase).
  for (const e of ev) {
    if (e.t !== "dashStart") continue;
    const dasher = w.players.get(e.pid);
    if (dasher && dasher.kitId === "phantom") accrueUlt(dasher, "dash", ultChargeFromDash());
  }
  // Time-FLOOR (§10): encounter-relative + COMBAT-GATED. Accrues only while a hostile enemy is
  // alive/aggro (never in empty rooms), guaranteeing ~1 ult by ~combatFillSeconds of sustained
  // combat even at low DPS. Keeps accruing during the 8s lockout (accrueUlt clamps ≤ meterMax).
  const inCombat = isEncounterLive(w);
  const timeGrant = ultTimeChargePerTick();
  for (const p of w.players.values()) {
    if (!isRealKit(p.kitId) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (inCombat) accrueUlt(p, "time", timeGrant);
    // MENDER LIFEBLOOM payout: bank credit pays out in WHOLE HP on the capped cadence, routed
    // through the shared incoming-heal clamp so it never out-heals or double-stacks (spec §2.2).
    if (p.kitId === "mender" && w.tick % LIFEBLOOM.healEveryTicks === 0 && p.passiveState >= 1) {
      const target = lowestHpAllyInRange(w, p, LIFEBLOOM.range) ?? p;
      const healed = menderHeal(w, p, target, LIFEBLOOM.healPerTick, ev, true); // HoT: rate-clamped
      if (healed > 0) p.passiveState -= healed;
    }
    // BULWARK OVERSHIELD regen (Wave 2): 1 chip / regenTicks, PAUSED pauseTicks after any damage.
    // Integer tick countdown for crisp determinism (never accrues while paused / under fire).
    if (p.kitId === "bulwark") {
      if (p.overshieldRegenT > 0) p.overshieldRegenT -= 1;
      else if (p.overshield < OVERSHIELD.maxChips) { p.overshield += 1; p.overshieldRegenT = OVERSHIELD.regenTicks; }
    }
    if (p.isPulseRequested) resolveHealPulse(w, p, ev);
    if (p.isUltRequested) resolveUlt(w, p, ev);
  }
}

// The AIMED ally under a MENDER's reticle within `range`: the living ally whose bearing is closest
// to the aim (within a ~45° cone), id-tiebroken for determinism; a solo Mender falls back to
// self. Downed/absent bodies are skipped (the pulse never revives). Pure over positions.
function aimedAllyInRange(w: WorldState, p: PlayerSim, range: number): PlayerSim | null {
  let best: PlayerSim | null = null;
  let bestDelta = Math.PI / 4; // the cone half-angle: nothing outside ~45° of the aim qualifies
  for (const other of w.players.values()) {
    if (other === p || other.isDown || other.hp <= 0 || other.isAbsent) continue;
    const dx = other.x - p.x, dy = other.y - p.y;
    if (Math.hypot(dx, dy) > range) continue;
    const delta = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - p.aimAngle), Math.cos(Math.atan2(dy, dx) - p.aimAngle)));
    if (delta < bestDelta || (delta === bestDelta && best !== null && other.id < best.id)) { bestDelta = delta; best = other; }
  }
  if (best === null && p.hp > 0 && !p.isDown) return p; // solo clutch self-heal
  return best;
}

// Validate + resolve the MENDER directed HEAL-PULSE (Wave 2): a `heal`-HP BURST to the aimed ally
// on a short cooldown. The burst bypasses the per-tick rate-clamp-DOWN (a responsive clutch save)
// but CONSUMES the healed HP against the shared incoming-heal budget, so pulse + Lifebloom +
// Sanctuary combined can never out-heal the sustained per-target/party ceiling. Server-owned
// (world phase only, like the ult) — a client can request, never resolve.
function resolveHealPulse(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  p.isPulseRequested = false;
  if (p.kitId !== "mender" || w.tick < p.pulseReadyAtTick) return;
  const target = aimedAllyInRange(w, p, HEAL_PULSE.range);
  if (target === null) return; // no ally under the reticle: the button is not spent
  // An ALLY pulse is the full burst that bypasses the rate clamp (a responsive clutch save). A
  // SELF-targeted pulse (solo fallback) instead respects BOTH self levers: the post-hit delay (no
  // instant self-clutch after a hit) AND the selfHpPerSec ceiling (it counts against the sustained
  // self-heal budget). The button is not spent while a self-pulse is gated, so it stays ready for
  // the moment the delay/ceiling lapses.
  const isSelf = target === p;
  let healAmount: number = HEAL_PULSE.heal;
  if (isSelf) {
    if (isSelfHealDelayed(w, p)) return;
    healAmount = Math.min(healAmount, incomingHealRoom(w, p, true));
    if (healAmount <= 0) return;
  }
  p.pulseReadyAtTick = w.tick + HEAL_PULSE.cooldownTicks;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + healAmount);
  const healed = target.hp - before; // overheal discarded (never charges, never counts to budget)
  if (healed <= 0) return;
  consumeIncomingHeal(w, target, healed, isSelf); // counts against the shared per-target/party (or self) budget
  ev.push({ t: "heal", pid: target.id, x: target.x, y: target.y });
  accrueUlt(p, "heal", ultChargeFromHealDone(healed));
}

// §10: is a hostile encounter LIVE (enemies alive/aggro)? Gates the ult time-floor so it never
// trickles in an empty/cleared room. Decoys + mechanic bodies (echo/knell/knot/sac/slab) don't
// count — they are counterplay, not pressure.
function isEncounterLive(w: WorldState): boolean {
  for (const e of w.enemies) {
    if (!e.dead && !isDecoyKind(e.kind)) return true;
  }
  return false;
}

// Validate + resolve one player's ult cast: server checks the meter is full AND the 8s lockout
// has elapsed, then applies the kit's effect, emits the SimEvent(s), resets the meter to 0, and
// sets the lockout (spec §3). A refused request (not charged / on cooldown) simply does nothing.
function resolveUlt(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  p.isUltRequested = false;
  // HARD-ASSERT (PVP WAVE 3 U1): the co-op ults (Overdrive/Sanctuary/Aegis/Phase) NEVER fire in
  // the arena. Arena casts route through resolveArenaUltRequest (kitId stays "none" there anyway,
  // so the switch below is already a no-op); this guard makes the invariant explicit + testable.
  if (isPvp(w)) return;
  if (!isRealKit(p.kitId)) return;
  if (!canCastUlt(p.ultCharge, w.tick, p.ultReadyAtTick)) return;
  p.ultCharge = 0;
  p.ultSources = freshUltSources();
  p.ultReadyAtTick = w.tick + ULT.lockoutTicks;
  switch (p.kitId) {
    case "gunner": {
      // OVERDRIVE: pure self-buff (fire-rate + pierce), applied live in currentFireRate/resolveShot.
      p.overdriveT = ticksToSec(OVERDRIVE.durationTicks);
      ev.push({ t: "ultOverdrive", pid: p.id, x: p.x, y: p.y, durationTicks: OVERDRIVE.durationTicks });
      break;
    }
    case "mender": {
      // SANCTUARY: on-cast burst heal to allies inside (never a revive), then the deterministic
      // HoT zone entity. Caps enforced server-side (menderHeal never overheals).
      for (const ally of w.players.values()) {
        if (ally.isDown || ally.hp <= 0 || ally.isAbsent) continue;
        if (ally !== p && Math.hypot(ally.x - p.x, ally.y - p.y) > SANCTUARY.radius) continue;
        menderHeal(w, p, ally, SANCTUARY.burstHeal, ev, false); // one-time burst bypasses the rate clamp
      }
      w.effects.push({
        id: w.nextEffectId++, kind: "sanctuary", owner: p.id, fx: p.weapon,
        x: p.x, y: p.y, life: ticksToSec(SANCTUARY.lifetimeTicks), maxLife: ticksToSec(SANCTUARY.lifetimeTicks),
        radius: SANCTUARY.radius, healRate: SANCTUARY.healPerTick,
      });
      ev.push({ t: "ultSanctuary", pid: p.id, x: p.x, y: p.y, radius: SANCTUARY.radius, lifetimeTicks: SANCTUARY.lifetimeTicks });
      break;
    }
    case "bulwark": {
      // AEGIS: a deterministic dome entity — duration OR HP budget, whichever first (spec §9.2).
      // The HP budget SCALES WITH THE ENCOUNTER (§10), clamped, so a deep-floor dome blocks
      // proportionally more incoming fire.
      const hpBudget = aegisHpBudgetForFloor(w.floor);
      w.effects.push({
        id: w.nextEffectId++, kind: "aegis", owner: p.id, fx: p.weapon,
        x: p.x, y: p.y, life: ticksToSec(AEGIS.lifetimeTicks), maxLife: ticksToSec(AEGIS.lifetimeTicks),
        radius: AEGIS.radius, hp: hpBudget, maxHp: hpBudget,
      });
      ev.push({ t: "ultAegis", pid: p.id, x: p.x, y: p.y, radius: AEGIS.radius, hpBudget, lifetimeTicks: AEGIS.lifetimeTicks });
      break;
    }
    case "phantom": {
      // PHASE: self + nearby allies (any kit) get the capped invuln + the speed surge. The
      // invuln is hard-clamped <= 1.2s server-side (spec §9.1) — no config exceeds it.
      const invulnTicks = Math.min(PHASE.invulnTicks, PHASE.invulnCapTicks);
      const invulnSec = ticksToSec(invulnTicks);
      const speedSec = ticksToSec(PHASE.speedTicks);
      for (const ally of w.players.values()) {
        if (ally.isDown || ally.hp <= 0 || ally.isAbsent) continue; // Phase never resurrects (spec §7)
        if (ally !== p && Math.hypot(ally.x - p.x, ally.y - p.y) > PHASE.allyRadius) continue;
        ally.ultInvuln = Math.max(ally.ultInvuln, invulnSec);
        ally.phaseSpeed = Math.max(ally.phaseSpeed, speedSec);
      }
      ev.push({ t: "ultPhase", pid: p.id, x: p.x, y: p.y, radius: PHASE.allyRadius, invulnTicks, speedTicks: PHASE.speedTicks });
      break;
    }
  }
}

// SANCTUARY zone (spec §2.2): a deterministic HoT zone — allies standing inside are topped off
// on the capped cadence (never past maxHp, never a revive). The on-entry chill/shock cleanse is
// inert in v1: PLAYERS carry no chill/shock status in this sim (only enemies do), so there is
// nothing to cleanse — the heal + safe-stand pocket is the mechanic.
function updateSanctuaryEffect(w: WorldState, e: SanctuaryEffect, dt: number, ev: SimEvent[]): void {
  e.life -= dt;
  if (e.life <= 0) return;
  if (w.tick % SANCTUARY.healEveryTicks !== 0) return;
  const owner = e.owner !== null ? w.players.get(e.owner) ?? null : null;
  for (const ally of w.players.values()) {
    if (ally.isDown || ally.hp <= 0 || ally.isAbsent) continue;
    if (Math.hypot(ally.x - e.x, ally.y - e.y) > e.radius) continue;
    menderHeal(w, owner, ally, SANCTUARY.healPerTick, ev, true); // HoT: shares the rate clamp
  }
}

// AEGIS dome (spec §2.3): expires on lifetime OR when its HP budget is spent (whichever first).
// It absorbs enemy projectiles crossing INWARD (allies' friendly bullets pass through freely, so
// the team shoots OUT); each blocked shot costs 1 barrier HP. It is COVER, never invuln — enemy
// bodies/contact still hurt, so it can't buy past an earned window (spec §2.3/§7).
function updateAegisEffect(w: WorldState, e: AegisEffect, dt: number, ev: SimEvent[]): void {
  e.life -= dt;
  if (e.life <= 0 || e.hp <= 0) { e.life = 0; return; }
  const r2 = e.radius * e.radius;
  for (const b of w.bullets) {
    if (b.friendly || b.life <= 0) continue; // allies shoot OUT; only enemy fire is blocked
    const dx = b.x - e.x, dy = b.y - e.y;
    if (dx * dx + dy * dy > r2) continue; // only rounds that crossed inward
    b.life = 0; // absorbed — updateBullets compacts dead rounds this tick
    e.hp -= 1;
    ev.push({ t: "bulletBlocked", kind: "shielder", x: b.x, y: b.y, aim: Math.atan2(b.vy, b.vx) });
    if (e.hp <= 0) { e.life = 0; break; }
  }
}

// Remove a player from a live world (authoritative server: deliberate leave, or the reconnect
// grace expiring). Returns whether a player was actually removed. Their pending blessing offer
// (if any) dies with them so the descend gate can't be held by a player who is no longer in
// the world.
export function removePlayerFromWorld(w: WorldState, id: PlayerId, ev: SimEvent[] = []): boolean {
  if (w.pendingBlessings.has(id) && isPvpDraftRuntime(w)) {
    ev.push(...dismissBlessingOfferInWorld(w, id, "reset"));
    ev.push({ t: "blessingExpired", pid: id });
  } else {
    w.pendingBlessings.delete(id);
  }
  for (const downed of w.players.values()) {
    if (downed.reviveBy === id) { downed.reviveBy = null; downed.reviveProgress = 0; }
    if (downed.lastPvpHitBy === id) {
      downed.lastPvpHitBy = null;
      downed.lastPvpHitTick = -1;
    }
    if (downed.lastPvpKnockbackBy === id) {
      downed.lastPvpKnockbackBy = null;
      downed.lastPvpKnockbackTick = -1;
    }
  }
  // Drop every per-player server-side map keyed by this id so a departure leaves no stale frag
  // credit, no lag-comp history, and no scoreboard ghost (and none of these maps grows unbounded
  // across join/leave churn). playerHist stays empty in co-op, so this is inert there.
  w.playerHist.delete(id);
  if (w.shop) {
    delete w.shop.viewerStock[id];
    for (const slot of w.shop.slots) {
      slot.buyers = slot.buyers.filter((buyer) => buyer !== id);
    }
  }
  const m = w.match;
  if (m !== null) {
    m.scores.delete(id);
    m.dmgThisTick.delete(id);
    m.lastFragTick.delete(id);
    m.fragChain.delete(id);
  }
  const removed = w.players.delete(id);
  // pvp FINAL removal (grace expired / hard leave): if the roster falls below the minimum PRESENT
  // participants mid-match, the match is a NO-CONTEST — reset to lobby rather than hand the lone
  // survivor a free win/frags. A fresh whistle runs once players return. (Absence alone pauses the
  // live match in stepPvpMatch; this handles the terminal case where a seat is truly gone.)
  if (removed && m !== null && isPvp(w) && m.phase !== "lobby" && pvpPresentPlayers(w).length < PVP.minPlayers) {
    pvpResetToLobby(w, m, ev);
  }
  return removed;
}

// Flip a player's network-absence (authoritative server: socket dropped -> reserved seat;
// resume -> back). Returning from absence grants the spawn-grace mercy window: the world kept
// moving while they were gone, and materializing into a surrounding pack un-hittable-for-a-
// beat beats materializing already dying.
export function setPlayerAbsence(w: WorldState, id: PlayerId, isAbsent: boolean): void {
  const p = w.players.get(id);
  if (!p || p.isAbsent === isAbsent) return;
  p.isAbsent = isAbsent;
  resetPlayerWarmth(p);
  if (!isAbsent && !isPvp(w)) p.invuln = Math.max(p.invuln, C.PLAYER_SPAWN_GRACE);
}

// The pull's measured power ratio R: every present player's expected boss-facing DPS
// (weaponStats.expectedBossDps — pure over their loadout) through the balancer's
// guard rails (weak-player floor, solo gear cap, [1, 6] clamp).
function sampleEncounterPower(w: WorldState): number {
  const contributions: number[] = [];
  for (const p of w.players.values()) contributions.push(expectedBossDps(p.weapon, p.mods));
  return powerRatioFor(contributions, w.floor);
}

// A single open walled rectangle for the dev sandbox — reuses the Dungeon/Room shape so
// the renderer + pathfinder run unchanged.
function buildArena(): Dungeon {
  const w = 34, h = 24;
  const tiles: TileKind[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      tiles[y * w + x] = isBorder ? 1 : 0;
    }
  }
  const room: Room = { id: 0, x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1, kind: "normal", shape: "rect" };
  return { w, h, tiles, rooms: [room], edges: [], blueprint: null, spawn: { x: w >> 1, y: h >> 1 }, exit: { x: w - 3, y: 2 } };
}

// Build (or rebuild, on descend) the floor's world content. Does NOT reseed w.rng — the
// sim RNG stream is continuous across a run (matching the old start()/loadFloor split).
// The co-op player count is SNAPSHOTTED here (encounter creation, §8) and never rescales
// living enemies mid-floor.
// `playerCountAtLock`: the AUTHORITATIVE co-op lock. On the server it is omitted and derived
// from the seats present at PULL (players.size); online clients pass the value the snapshot
// carries (SnapWire.pcl) so their reconstructed floor — descriptor, mutator-driven hazards,
// dash tuning — matches the server exactly (the descriptor is a pure function of
// seed+floor+playerCountAtLock, and never rescales mid-floor on join/down/disconnect).
export function loadFloorIntoWorld(w: WorldState, floor: number, playerCountAtLock?: number): void {
  if (weaponBagCatalogVersion(w.weaponBag) !== w.catalogVersion) {
    throw new Error("run catalog and weapon bag version diverged");
  }
  w.floor = floor;
  w.rev++;
  w.encounterPlayers = playerCountAtLock !== undefined
    ? clampPlayers(Math.max(1, Math.floor(playerCountAtLock)))
    : clampPlayers(Math.max(1, w.players.size));
  // The R framework's pull sample (party+gear in one measured number, balance.ts
  // POWER): taken HERE, at encounter creation, exactly like the player snapshot —
  // downed/disconnected players never change it mid-fight, and it derives purely from
  // loadouts, so every client and the server agree.
  w.encounterPower = sampleEncounterPower(w);
  // JET's mirror pool is resolved lazily when it first commits (updateJet), so it captures
  // the pull loadout on both the floor-load and dev-spawn paths; a fresh floor clears it.
  w.jetMirror = [];
  // Gate 3: resolve + FREEZE the floor's rolls once, now, with the locked player count. A pure
  // function of (seed, floor, encounterPlayers) — clients recompute the identical descriptor.
  w.floorDescriptor = resolveFloorDescriptor(w.seed, floor, w.encounterPlayers);
  // Wave 1 mutator expression, resolved once at generation from the frozen mutator set: the
  // hazard budget/kind bias (molten/fracture/amberfall) and the extra-elite count (twinned).
  // Vision (denseDark) is a client render read; dash (thinAir) is read by the shared dash step.
  const hazMut = floorHazardMutation(w.floorDescriptor.mutators);
  const extraElites = floorExtraElites(w.floorDescriptor.mutators);
  // pvp loads the fixed symmetric arena and suppresses ALL population (AI/props/chests/hazards/
  // shop) through the SAME "bare" seam the dev sandbox uses — mode only swaps the geometry +
  // win rule, never the movement/collision engine.
  const pvp = isPvp(w);
  const isBare = w.isSandbox || pvp;
  let pvpCover: Vec2[] = [];
  if (pvp) {
    // A floor build IS a fresh arena, so it is a fresh MATCH (cleared scoreboard, lobby phase).
    // pvp never descends mid-match, so this only runs at world create + on a room reset/rematch,
    // where a clean slate is exactly right.
    const arena = buildPvpArena();
    w.dungeon = arena.dungeon;
    w.match = createMatchState(arena.spawns, arena.pits, arena.centerPickup, arena.forcedChokepoints);
    pvpCover = arena.cover;
    for (const p of w.players.values()) p.pvpRecentSpawnIndices = [];
  } else {
    w.dungeon = w.isSandbox ? buildArena() : generateDungeon(w.seed, floor);
    w.match = null;
  }
  // Batch0: attach encounter state from the dungeon blueprint. Boss floors get 'arena'
  // (progress HUD only — completion stays on Gorge HP-death). Non-boss / sandbox / pvp: null.
  if (pvp || isBare) {
    w.encounter = null;
  } else if (w.dungeon.blueprint !== null && w.dungeon.blueprint.structureKind === "arena") {
    // Both the Claimant (F70) and Pale/Gorge arenas are structureKind 'arena'; the boss the floor
    // pins decides which arena flags attach (Claimant's compact coordination bag vs the giant's).
    w.encounter = bossKindForFloor(w.seed, floor) === "claimant"
      ? initClaimantEncounter(w.dungeon)
      : initArenaEncounter(w.dungeon);
  } else if (w.dungeon.blueprint !== null && w.dungeon.blueprint.structureKind === "hunt") {
    w.encounter = initHuntEncounter(w.dungeon);
  } else if (w.dungeon.blueprint !== null && w.dungeon.blueprint.structureKind === "split") {
    w.encounter = initSplitEncounter(w.dungeon);
  } else if (w.dungeon.blueprint !== null && w.dungeon.blueprint.structureKind === "escape") {
    w.encounter = initEscapeEncounter(w.dungeon);
  } else if (w.dungeon.blueprint !== null && w.dungeon.blueprint.structureKind === "escort") {
    w.encounter = initEscortEncounter(w.dungeon);
  } else {
    w.encounter = null;
  }
  w.bullets = [];
  w.hazards = [];
  w.effects = [];
  w.recentReleases = [];
  w.gauntlet = !isBare && isGauntletFloor(floor) ? { stage: 0, breath: 0, isRewarded: false } : null;
  w.nextEnemyId = 0;
  w.nextPropId = 0;
  w.nextPickupId = 0;
  w.nextChestId = 0;
  w.nextHazardId = 0;
  w.nextEffectId = 0;
  w.persistentBossWindows.clear();
  w.warmthDrain = null;
  for (const player of w.players.values()) resetPlayerWarmth(player);
  w.friendlyNudgeCd.clear();
  w.incomingHealWindows.clear();
  w.partyHealWindow = { tick: 0, hp: 0 };
  w.heartsThisFloor = 0;
  w.isFloorEnteredLow = [...w.players.values()].some((p) => p.hp < p.maxHp * SUSTAIN.pityLowHpFrac);
  w.pendingBlessings.clear();
  w.wipeTimer = 0;
  w.isBlessingOfferedThisFloor = false;
  w.flowCd = 0;
  w.flowKey = -1;
  w.pickups = [];
  // Content Wave B: transient combat state never survives a floor build, and Remember Me
  // re-arms once per floor (its lethal-save is a per-floor consumable).
  w.procWindow.clear();
  for (const p of w.players.values()) {
    p.forkLink = null;
    p.penMarks.clear();
    p.penSkillCd = 0;
    p.penInputLock = 0;
    p.marginStore = null;
    p.sidewinderArcT = 0;
    p.revealIcdT = 0;
    p.lightSoloDashIcd = 0;
    p.staggerPulseIcdT = 0;
    p.staggerPulseAppliedTick = -1;
    p.bladeWardT = 0;
    p.bladeWardAbsorb = 0;
    p.bladeWardAppliedTick = -1;
    p.isMomentumArmed = false;
    p.momentumIcdT = 0;
    p.momentumMoveSamples = [];
    p.rememberMeArmed = true;
    p.disabledBlessing = null;
    resetWaveCState(p);
  }
  w.sameTargetWindow.clear();
  for (const p of w.players.values()) p.hasClaimedBossChoice = false;
  // Floor hazards place FIRST: props/chests then avoid hazard tiles (a barrel on spikes
  // reads as a bug). floorHazardClock is NOT reset — it is monotonic sim time (phases
  // are per-hazard), so an online client reconstructs it from the tick.
  w.floorHazards = isBare ? [] : placeFloorHazards(w.dungeon, w.seed, floor, "standard", hazMut);
  // Obstacles land BEFORE enemies: spawn settling needs the floor's real prop/chest
  // footprint, and the obstacle revision must already name this floor's layout. The
  // ordering is free — every placement draws from its own seeded stream.
  // pvp cover is BREAKABLE PROPS (degrading-cover arc): the arena's symmetric prop set replaces
  // the seeded PvE props. They block movement + bullets and break like any destructible, all via
  // the shared systems (moveCircle / updateProps) — no pvp-specific collision code.
  w.props = pvp
    ? pvpCover.map((c) => ({ id: w.nextPropId++, kind: "crate" as PropKind, x: c.x, y: c.y, radius: C.PROP_RADIUS, hp: C.PROP_HP.crate, dead: false }))
    : (isBare ? [] : placeProps(w));
  w.chests = isBare ? [] : placeChests(w);
  if (!isBare) stockWeaponChests(w);
  // Patch's shop: built off the generator's dedicated shop room. Layout/prices are pure
  // (seed, floor) and party-size-invariant so a mid-floor join never shifts the stall;
  // the weapon stock additionally dodges guns the whole party owns at build time
  // (authority-only state, shipped on the wire like the rest of the shop), and the
  // premium sink count scales with the SNAPSHOTTED encounter size — only ever growing
  // upward from the identical solo prefix.
  const shopRoom = w.dungeon.rooms.find((r) => r.kind === "shop");
  w.shop = !isBare && shopRoom !== undefined
    ? buildShopState(
      w.seed,
      floor,
      shopRoom,
      [...weaponsOwnedByAll(w)],
      w.encounterPlayers,
      w.weaponBag,
      w.catalogVersion,
    )
    : null;
  if (w.shop) {
    const players = [...w.players.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const p of players) {
      for (const slot of w.shop.slots) {
        if (slot.isShared && slot.weapon !== null) {
          recordWeaponOffer(p.weaponOfferHistory, slot.weapon);
        }
      }
      stockCurrentShopForPlayer(w, p);
    }
  }
  w.obstacleRev++;
  const spawns = isBare
    ? { active: [], pending: [] }
    : spawnFloorEnemies(w.dungeon, w.seed, floor, w.encounterPlayers, w.encounterPower, {
      extraElites,
      eliteAffixes: w.floorDescriptor.eliteAffixes,
    });
  w.enemies = spawns.active;
  w.pendingSpawns = spawns.pending;
  w.spawnReleaseCd = 0;
  w.nextEnemyId = spawns.active.length + spawns.pending.length;
  // Every planned unit — the active wave AND the queued reinforcements — settles onto a
  // spawn point with full body clearance and a route to the playable region now, at
  // build time. Props only ever VANISH mid-floor, so a point valid here is still valid
  // when a reinforcement releases.
  for (const e of w.enemies) settleEnemySpawn(w, e);
  for (const e of w.pendingSpawns) settleEnemySpawn(w, e);
  // Reposition living players to the new spawn, each under the spawn-grace mercy window:
  // nobody loads into a fresh floor (a boss floor especially) already taking damage. pvp owns
  // its own symmetric spawn assignment (the match whistle / respawns), so it skips this.
  if (!pvp) {
    const spawn = w.dungeon.spawn;
    for (const p of w.players.values()) {
      p.x = spawn.x * TILE + TILE / 2;
      p.y = spawn.y * TILE + TILE / 2;
      p.invuln = Math.max(p.invuln, C.PLAYER_SPAWN_GRACE);
    }
  }
}

// Floor cleared = every active enemy dead AND no reinforcements still queued. The exit,
// the snapshot `cleared` flag, and the client HUD/minimap all read this one predicate.
export function isFloorCleared(w: WorldState): boolean {
  // pvp is a deathmatch arena, not a dungeon floor: there is no PvE clear objective, so it is
  // NEVER "cleared". This one guard keeps the whole exit stack inert in pvp — the snapshot
  // `cleared` flag reads false and playersAtExit() (hence the snapshot `exr`) reads empty — so a
  // zero-enemy arena can never leak co-op floor-exit/stairs readiness to a client HUD.
  if (isPvp(w)) return false;
  if (w.gauntlet !== null && (w.gauntlet.stage < GAUNTLET.rounds.length || !w.gauntlet.isRewarded)) return false;
  // Batch0 custom encounter completion: when an active encounter marks completed, the exit
  // opens WITHOUT requiring enemies.length===0 (phantom adds / mechanic bodies may remain).
  // Arena/null encounters still clear via the classic enemies-empty path (Gorge HP-death
  // calls endBossDanger which empties the floor first).
  if (isEncounterObjectiveComplete(w.encounter)) return true;
  return w.enemies.length === 0 && w.pendingSpawns.length === 0;
}

// Batch0: immutable same-run restore of encounter plain-data (reconnect / late-join).
export function restoreEncounterInWorld(w: WorldState, encounter: EncounterState | null): void {
  w.encounter = encounter === null ? null : cloneEncounter(encounter);
}

// Batch0 reward hook: place a premium boss chest at the encounter objective room (or exit).
// Used by custom completion paths; arena/Gorge still drop via the classic kill path.
export function grantEncounterCompletionReward(w: WorldState): void {
  if (w.encounter === null || !w.encounter.completed) return;
  if (w.chests.some((c) => c.kind === "boss" && !c.opened)) return;
  const d = w.dungeon;
  let room: Room | undefined = d.rooms.find((r) => r.id === w.encounter!.currentRoomId);
  if (!room) room = d.rooms[d.rooms.length - 1];
  if (!room) return;
  const x = room.cx * TILE + TILE / 2;
  const y = room.cy * TILE + TILE / 2;
  w.chests.push({
    id: w.nextChestId++,
    kind: "boss",
    x, y,
    radius: 18,
    opened: false,
  });
}

// Reset a live world to a FRESH run: new seed, new RNG stream, floor 1, cleared terminal state.
// The authoritative server calls this when a room empties (party wiped or everyone left), so the
// next group starts a new run rather than inheriting a half-played dungeon. tick keeps counting
// (snapshot ordering stays monotonic across resets); rev increments via loadFloorIntoWorld.
export function resetRunInWorld(w: WorldState, seed: number): void {
  w.seed = seed;
  w.rng = new Rng(seed ^ 0x53696d21);
  w.weaponBag = createWeaponBag(seed, w.catalogVersion);
  for (const p of w.players.values()) {
    resetWeaponOfferHistory(p.weaponOfferHistory);
    resetBlessingOfferHistory(p.blessingOfferHistory);
    p.blessingOfferOrdinal = 0;
    p.shopWeaponOfferOrdinal = 0;
    p.shopBlessingOfferOrdinal = 0;
    p.premiumWeaponOfferOrdinal = 0;
    p.isBlessingRerollArmed = false;
    p.weaponCycles = createWeaponCycles();
    p.lastGrappleShotSeq = -1;
    p.fireCd = 0;
    p.weaponFireCooldowns = {};
    p.isMuddyRefundSpent = false;
    p.forkLink = null;
    p.penMarks.clear();
    p.penSkillCd = 0;
    p.penInputLock = 0;
    p.marginStore = null;
    p.sidewinderArcT = 0;
    p.revealIcdT = 0;
    p.rememberMeArmed = true;
    p.disabledBlessing = null;
    p.lightSoloDashIcd = 0;
    p.staggerPulseIcdT = 0;
    p.staggerPulseAppliedTick = -1;
    p.bladeWardT = 0;
    p.bladeWardAbsorb = 0;
    p.bladeWardAppliedTick = -1;
    p.isMomentumArmed = false;
    p.momentumIcdT = 0;
    p.momentumMoveSamples = [];
    p.petCdReadyAtTick = 0;
    p.petTellT = 0;
    p.petLightT = 0;
    p.petFetchT = 0;
    p.petShieldT = 0;
    p.petNullT = 0;
    p.isPetAbilityRequested = false;
    resetWaveCState(p);
  }
  w.petFetchPartyReadyAtTick = 0;
  w.procWindow.clear();
  w.sameTargetWindow.clear();
  w.isRunOver = false;
  w.pityStreak = 0;
  w.isPityHeartArmed = false;
  loadFloorIntoWorld(w, 1);
}

// The still-connected player behind an attributed action (bullet/burn/explosion owner), or null
// when the actor has left. Attribution is IMMUTABLE: a departed owner's outcomes credit NO ONE
// (damage still lands, loot still drops at base value) and are never transferred to another live
// player — the TD audit's ownership contract. There is deliberately NO "primary player"
// fallback anywhere in the credit path. Solo: `id` is always the one LOCAL_ID player.
function ownerOf(w: WorldState, id: PlayerId | null): PlayerSim | null {
  return id !== null ? w.players.get(id) ?? null : null;
}

// ---- deterministic floor placement (seeded per floor, own RNG streams) ----

// The floor's weapon drops are CONTENTS of chests (pedestals), never loose floor pickups.
// (They used to spawn at room centers — the same tiles chests and props prefer — so guns
// sat visibly stacked on top of chests, and free weapons in the open undercut chests as the
// reward container.) Each pedestal is stocked into a weaponless wood chest, treasure room
// first; when the floor placed fewer chests than pedestals, an extra chest is placed to
// hold the overflow, roomed where the loose drop used to land. Opening the chest ejects the
// contents (see openChest).
//
// Studio gate §4 pedestal rolls: max(1, ceil(P/2)) physical weapons per floor (P1–2
// roll 1, P3–4 roll 2), DISTINCT ids when the pool permits. Party size buys options,
// never rarity — the roll table is identical solo and co-op. Floor 1 stocks too (the
// early-variety fix: it used to start at F2, leaving a solo player ~3 guaranteed guns
// before the F5 boss), and the ids come from the run's shuffled bag, skipping guns the
// whole party already owns, so early floors deal different weapons run to run and a
// pedestal is never wasted on a universal duplicate.
function stockWeaponChests(w: WorldState): void {
  const d = w.dungeon;
  if (d.rooms.length <= 2) return;
  const rng = new Rng((w.seed ^ 0x51ed270b) + w.floor * 40503);
  const exclude = weaponsOwnedByAll(w);
  // Each pedestal roll: (1) decide whether it wraps as a mystery (MYSTERY.minFloor+, from
  // the pedestal stream), (2) roll the rarity TIER — legendary-gated for identified
  // drops, gamble-weighted for mysteries — and deal that tier's next weapon from the
  // run's shuffled bag, (3) bake the mystery's twist. Fixed draw order keeps the
  // placement stream reproducible per (seed, floor).
  const kinds: Array<{ weapon: WeaponId; isMystery: boolean; twist?: MysteryTwist }> = [];
  for (let i = 0; i < pedestalWeaponRolls(w.encounterPlayers); i++) {
    const isMystery = w.floor >= MYSTERY.minFloor && rng.chance(MYSTERY.pedestalChance);
    const pick = rollBagWeapon(w, () => rng.next(), exclude, { isMystery });
    if (kinds.some((k) => k.weapon === pick)) break; // pool saturated (everything owned): no dup pedestals
    kinds.push({ weapon: pick, isMystery, twist: isMystery ? rollMysteryTwist(() => rng.next()) : undefined });
    exclude.add(pick);
  }
  const used = new Set<number>();
  for (const c of w.chests) used.add(Math.floor(c.y / TILE) * d.w + Math.floor(c.x / TILE));
  for (const { weapon, isMystery, twist } of kinds) {
    const host = w.chests.find((c) => c.kind === "wood" && c.weapon === undefined);
    if (host) { host.weapon = weapon; host.isMystery = isMystery || undefined; host.twist = twist; continue; }
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    let spot = chestTile(w, room, used);
    for (let ri = 1; spot === null && ri < d.rooms.length; ri++) spot = chestTile(w, d.rooms[ri], used);
    if (!spot) continue; // no open tile anywhere: forfeit this weapon roll
    used.add(spot.ty * d.w + spot.tx);
    w.chests.push({
      id: w.nextChestId++, kind: "wood", x: (spot.tx + 0.5) * TILE, y: (spot.ty + 0.5) * TILE,
      radius: 16, opened: false, weapon, isMystery: isMystery || undefined, twist,
    });
  }
}

// The world's one rarity-aware bag draw: roll the TIER (weighted, floor-gated — see
// rollWeaponRarity), enforce the legendary floor gate through the bag's exclude
// semantics (skip while others remain, never hang), then deal that tier's next undealt
// weapon from the run's shuffled bag. `rand` is the calling stream (a placement Rng or
// w.rng) so the tier roll rides the caller's determinism, and the roll consumes exactly
// one rand() before the bag advances.
function rollBagWeapon(
  w: WorldState,
  rand: () => number,
  exclude: ReadonlySet<WeaponId>,
  opts: { isPremium?: boolean; isMystery?: boolean } = {},
): WeaponId {
  const pickupWeapons = contentCatalogFor(w.catalogVersion).pickupWeapons;
  const tier = rollWeaponRarity(rand, w.floor, opts, w.catalogVersion);
  const isLegendaryOpen = opts.isMystery === true || w.floor >= LEGENDARY_MIN_FLOOR;
  let gated = exclude;
  if (!isLegendaryOpen) {
    const withGate = new Set(exclude);
    for (const id of pickupWeapons) {
      if (WEAPONS[id].rarity === "legendary") withGate.add(id);
    }
    gated = withGate;
  }
  const pick = drawWeaponFromBag(w.weaponBag, gated, tier);
  for (const p of w.players.values()) recordWeaponOffer(p.weaponOfferHistory, pick);
  return pick;
}

// Weapons owned by EVERY player — the set a fresh drop would waste (nobody left to
// collect it; updatePickups leaves a universally-owned weapon lying as a dead pickup).
// A gun only SOME players own stays rollable: the others can still claim it. Empty when
// the world has no players yet (server floor build before the first join).
function weaponsOwnedByAll(w: WorldState): Set<WeaponId> {
  const owned = new Set<WeaponId>();
  let isFirst = true;
  for (const p of w.players.values()) {
    if (isFirst) {
      for (const id of p.ownedWeapons) owned.add(id);
      isFirst = false;
      continue;
    }
    for (const id of [...owned]) if (!p.ownedWeapons.includes(id)) owned.delete(id);
  }
  return owned;
}

// Deep floors bias hazard density (§4 biome pressure): a wider explosive-barrel band.
function rollPropKind(rng: Rng, hazardMult: number): Prop["kind"] {
  const r = rng.next();
  const explosiveBand = 0.10 * hazardMult;
  if (r < 0.34) return "pot";
  if (r < 0.62) return "crate";
  if (r < 0.94 - explosiveBand) return "barrel";
  if (r < 0.94) return "barrel_explosive";
  return "brazier";
}

// A prop tile is class-blocked for EVERY body (its own center sits inside the collision
// ring), so a prop chain can sever the floor's navigable graph even where raw tiles stay
// connected — observed live: a crate + barrel pocketing a room's door mouth one tile
// behind it (each individually passing the corridor-mouth guard) cut half the map off
// the spawn for every clearance class. Same local articulation test the toxic pools use
// (hazards.ts poolKeepsPathOpen): with the candidate placed, its open neighbors must
// remain mutually connected within a local window, treating existing prop tiles as
// blocked. Conservative-local like the pool test: a false reject just skips one prop.
function propKeepsPathOpen(d: Dungeon, occupied: ReadonlySet<number>, tx: number, ty: number): boolean {
  const blocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= d.w || y >= d.h || d.tiles[y * d.w + x] !== 0) return true;
    if (x === tx && y === ty) return true;
    return occupied.has(y * d.w + x);
  };
  const neighbors: Array<[number, number]> = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (!blocked(tx + dx, ty + dy)) neighbors.push([tx + dx, ty + dy]);
  }
  if (neighbors.length <= 1) return true;
  const R = 3;
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [neighbors[0]];
  seen.add(neighbors[0][1] * d.w + neighbors[0][0]);
  while (queue.length > 0) {
    const [cx, cy] = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (Math.abs(nx - tx) > R || Math.abs(ny - ty) > R) continue;
      if (blocked(nx, ny)) continue;
      const key = ny * d.w + nx;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return neighbors.every(([nx, ny]) => seen.has(ny * d.w + nx));
}

function placeProps(w: WorldState): Prop[] {
  const d = w.dungeon;
  const rng = new Rng((w.seed ^ 0x2f6a35c1) + w.floor * 26417);
  const hazardMult = BIOME_PRESSURE[biomeIndexForFloor(w.floor)].hazardMult;
  const list: Prop[] = [];
  const occupied = new Set<number>();
  const addProp = (kind: Prop["kind"], tx: number, ty: number) => {
    occupied.add(ty * d.w + tx);
    list.push({ id: w.nextPropId++, kind, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false });
  };

  // Boss arenas stage an AUTHORED ring of destructible cover just outside the squeeze's
  // final safe radius: real cover to fight from, and real physics when the boss's slams,
  // charges and body smash through it (enemySmashEnvironment). Explosive barrels in the
  // ring make slamming a fuel cluster the boss's own problem.
  const arena = isBossFloor(w.floor) ? d.rooms[d.rooms.length - 1] : null;
  if (arena) {
    const ringR = Math.min(arena.w, arena.h) * TILE * 0.3;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const tx = Math.floor(((arena.cx + 0.5) * TILE + Math.cos(a) * ringR) / TILE);
      const ty = Math.floor(((arena.cy + 0.5) * TILE + Math.sin(a) * ringR) / TILE);
      const idx = ty * d.w + tx;
      if (occupied.has(idx) || d.tiles[idx] !== 0 || hasFloorHazardOnTile(w, tx, ty)) continue;
      if (Math.abs(tx - arena.cx) + Math.abs(ty - arena.cy) <= 1) continue; // exit tile ground
      const r = rng.next();
      addProp(r < 0.5 ? "crate" : r < 0.8 ? "barrel" : "barrel_explosive", tx, ty);
    }
  }

  for (const room of d.rooms) {
    if (room === arena) continue; // the arena's cover is authored above
    if (room.kind === "shop") continue; // Patch's waystation keeps its authored floor plan
    // Room-aware density: pillared halls and fighting pits carry more cover; hazard
    // set-piece rooms stay lean — their floor is the obstacle, and flocks/dodges need
    // the open lanes.
    const target = room.kind === "hazard" ? rng.int(1, 2)
      : (room.shape === "pillars" || room.shape === "arena") ? rng.int(4, 7)
      : rng.int(3, 6);
    for (let i = 0; i < target; i++) {
      const tx = room.x + rng.int(0, room.w - 1);
      const ty = room.y + rng.int(0, room.h - 1);
      const idx = ty * d.w + tx;
      if (occupied.has(idx) || d.tiles[idx] !== 0 || hasFloorHazardOnTile(w, tx, ty)) continue;
      if (isCorridorMouth(d, tx, ty)) continue;
      // Room centers are reserved ground: chests land there (a vault's chest belongs
      // INSIDE its ring, not wherever a crate left space).
      if (Math.abs(tx - room.cx) + Math.abs(ty - room.cy) <= 1) continue;
      if (Math.abs(tx - d.spawn.x) <= 1 && Math.abs(ty - d.spawn.y) <= 1) continue;
      if (Math.abs(tx - d.exit.x) <= 1 && Math.abs(ty - d.exit.y) <= 1) continue;
      if (!propKeepsPathOpen(d, occupied, tx, ty)) continue;
      addProp(rollPropKind(rng, hazardMult), tx, ty);
    }
  }
  return list;
}

function isRoomTile(d: Dungeon, tx: number, ty: number): boolean {
  for (const r of d.rooms) {
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return true;
  }
  return false;
}

// A room tile with corridor floor beside it is a DOOR MOUTH: a prop there can seal a
// room's only connection to the rest of the floor (observed in a live-seed audit — two
// barrels stacked across a 2-wide corridor mouth cut half the map off the spawn, and
// with braziers the barricade isn't even breakable). Props are placed per-room so
// corridors themselves never take one; guarding the mouths keeps the whole floor graph
// connected for every clearance class.
function isCorridorMouth(d: Dungeon, tx: number, ty: number): boolean {
  const isCorridorFloor = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < d.w && y < d.h && d.tiles[y * d.w + x] === 0 && !isRoomTile(d, x, y);
  return isCorridorFloor(tx + 1, ty) || isCorridorFloor(tx - 1, ty) || isCorridorFloor(tx, ty + 1) || isCorridorFloor(tx, ty - 1);
}

function placeChests(w: WorldState): Chest[] {
  const d = w.dungeon;
  if (d.rooms.length < 2) return [];
  const rng = new Rng((w.seed ^ 0x1b3c9e77) + w.floor * 55697);
  const list: Chest[] = [];
  const used = new Set<number>();
  const count = rng.chance(0.5) ? 2 : 1;
  const addChest = (tx: number, ty: number) => {
    used.add(ty * d.w + tx);
    list.push({ id: w.nextChestId++, kind: "wood", x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: 16, opened: false });
  };
  const treasure = d.rooms.find((r) => r.kind === "treasure");
  let remaining = count;
  if (treasure) {
    const spot = chestTile(w, treasure, used);
    if (spot) { addChest(spot.tx, spot.ty); remaining--; }
  }
  for (let i = 0; i < remaining; i++) {
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    const spot = chestTile(w, room, used);
    if (spot) addChest(spot.tx, spot.ty);
  }
  if (list.length === 0) {
    for (let ri = 1; ri < d.rooms.length; ri++) {
      const spot = chestTile(w, d.rooms[ri], used);
      if (spot) { addChest(spot.tx, spot.ty); break; }
    }
  }
  return list;
}

// A free tile for a chest: open floor, unused, not the spawn/exit tile, and not a tile a
// prop already occupies (props are placed first, and a chest materializing on a barrel is
// the same stacked-loot eyesore as a gun on a chest). The shop room takes no chests at
// all — its floor plan is authored by the shop layout.
function chestTile(w: WorldState, room: Room, used: Set<number>): { tx: number; ty: number } | null {
  if (room.kind === "shop") return null;
  const d = w.dungeon;
  const isBad = (tx: number, ty: number) =>
    d.tiles[ty * d.w + tx] !== 0 ||
    used.has(ty * d.w + tx) ||
    hasLivePropOnTile(w, tx, ty) ||
    hasFloorHazardOnTile(w, tx, ty) ||
    (tx === d.spawn.x && ty === d.spawn.y) ||
    (tx === d.exit.x && ty === d.exit.y);
  if (!isBad(room.cx, room.cy)) return { tx: room.cx, ty: room.cy };
  for (let ty = room.y; ty < room.y + room.h; ty++)
    for (let tx = room.x; tx < room.x + room.w; tx++)
      if (!isBad(tx, ty)) return { tx, ty };
  return null;
}

function hasLivePropOnTile(w: WorldState, tx: number, ty: number): boolean {
  for (const p of w.props) {
    if (!p.dead && Math.floor(p.x / TILE) === tx && Math.floor(p.y / TILE) === ty) return true;
  }
  return false;
}

function hasFloorHazardOnTile(w: WorldState, tx: number, ty: number): boolean {
  for (const h of w.floorHazards) if (h.tx === tx && h.ty === ty) return true;
  return false;
}

// ---- geometry / collision ----

function isWall(w: WorldState, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

export function moveCircle(w: WorldState, x: number, y: number, r: number, dx: number, dy: number): [number, number] {
  const nx = x + dx, ny = y + dy;
  if (!isWall(w, nx + Math.sign(dx) * r, y) && !blockedByProp(w, nx, y, r)) x = nx;
  if (!isWall(w, x, ny + Math.sign(dy) * r) && !blockedByProp(w, x, ny, r)) y = ny;
  return [x, y];
}

function blockedByProp(w: WorldState, x: number, y: number, r: number): boolean {
  for (const p of w.props) {
    if (p.dead) continue;
    const rr = r + p.radius * C.PROP_BLOCK_RING;
    const ddx = x - p.x, ddy = y - p.y;
    if (ddx * ddx + ddy * ddy < rr * rr) return true;
  }
  return false;
}

// ---- dynamic-obstacle navigation (see nav.ts for the module rationale) ----

// The prop-aware chase field for a body of this radius (lazily rebuilt off the current
// targets + obstacle revision — see refreshNav / nav.ts).
function chaseFieldFor(w: WorldState, radius: number): FlowField {
  return navChaseField(w.nav, w.dungeon, w.props, w.obstacleRev, navClassFor(radius));
}

// Reachability from the floor spawn tile (where players enter — and the only region a
// player can ever walk, since obstacles only OPEN mid-floor). The oracle behind every
// spawn-position validation.
function reachFieldFor(w: WorldState, radius: number): FlowField {
  const d = w.dungeon;
  return navReachField(w.nav, d, w.props, w.obstacleRev, navClassFor(radius), d.spawn.y * d.w + d.spawn.x);
}

// Whether a body of radius `r` can physically exist at (x, y): the same wall probes
// movement uses, outside every live prop's collision ring, and off every chest footprint
// (chests never block movement, but a body materializing ON one reads as a bug).
function isBodyClear(w: WorldState, x: number, y: number, r: number): boolean {
  if (isWall(w, x, y) || isWall(w, x - r, y) || isWall(w, x + r, y) || isWall(w, x, y - r) || isWall(w, x, y + r)) return false;
  if (blockedByProp(w, x, y, r)) return false;
  for (const c of w.chests) {
    const rr = r + c.radius;
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy < rr * rr) return false;
  }
  return true;
}

// Shared scratch for settleSpawnPoint (read immediately by callers).
const settlePoint = { x: 0, y: 0 };

// Whether a tile lies inside the floor's shop room. Every caller below is an ENEMY spawn
// path — the sanctuary contract says no enemy may ever materialize on shop ground, even
// via a relocation scan that started in a neighboring room.
function isShopTile(w: WorldState, tx: number, ty: number): boolean {
  const room = w.dungeon.rooms.find((r) => r.kind === "shop");
  return room !== undefined && tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h;
}

// Validate a spawn point for a body of radius `r`, or deterministically relocate it: the
// intended point stands when it is body-clear AND its tile has a route to the playable
// region; otherwise the scan walks outward over Chebyshev tile rings (fixed order — no
// RNG, so spawn placement never shifts any seeded stream) and takes the first reachable,
// body-clear tile center. Shop-room tiles are never accepted (all callers spawn enemies;
// the shop is sanctuary). Returns false when even the bounded scan finds nothing.
function settleSpawnPoint(w: WorldState, x: number, y: number, r: number): boolean {
  const reach = reachFieldFor(w, r);
  const tx0 = Math.floor(x / TILE), ty0 = Math.floor(y / TILE);
  if (isBodyClear(w, x, y, r) && reach.distAt(tx0, ty0) >= 0 && !isShopTile(w, tx0, ty0)) {
    settlePoint.x = x;
    settlePoint.y = y;
    return true;
  }
  for (let ring = 1; ring <= C.SPAWN_SCAN_RINGS; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const tx = tx0 + dx, ty = ty0 + dy;
        if (reach.distAt(tx, ty) < 0) continue; // wall / prop-blocked / unreachable pocket
        if (isShopTile(w, tx, ty)) continue;
        const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
        if (!isBodyClear(w, cx, cy, r)) continue; // off-center prop ring / chest footprint
        settlePoint.x = cx;
        settlePoint.y = cy;
        return true;
      }
    }
  }
  return false;
}

// Settle a freshly created floor enemy onto its validated spawn point. Falls back to the
// intended point when the bounded scan finds nothing (never worse than the old behavior;
// practically unreachable — a scan ring covers any generatable room).
function settleEnemySpawn(w: WorldState, e: Enemy): void {
  if (settleSpawnPoint(w, e.x, e.y, e.radius)) {
    e.x = settlePoint.x;
    e.y = settlePoint.y;
  }
}

// ---- item mods ----

// The live damage/fire-rate multipliers (low-HP berserk/adrenaline scalers, capped) live in
// weaponStats.ts so the HUD's stat readouts share the EXACT math real shots resolve with.
function currentDamageMult(p: PlayerSim): number {
  const m = liveDamageMult(p.mods, lowHpFrac(p.hp, p.maxHp));
  // GUNNER MOMENTUM (spec §2.1): a small live damage ramp per unhit-hit stack — a FASTER ROUTE to
  // the raw damage cap (gunnerDamageMult re-clamps to CAPS.damageMult), never a higher ceiling.
  if (p.kitId === "gunner") return gunnerDamageMult(m, p.passiveState);
  return m;
}
function currentFireRate(p: PlayerSim): number {
  let m = liveFireRateMult(p.mods, lowHpFrac(p.hp, p.maxHp));
  const comboTier = comboTierIndex(p.combo);
  m = Math.min(CAPS.fireRateMult, m + comboTier * p.mods.beatFireRatePerTier);
  if (p.kitId === "gunner") {
    // MOMENTUM + the OVERHEAT boil-over burst: both are the SAME clamped route to the raw fire cap
    // (gunnerFireRateMult re-clamps to CAPS.fireRateMult), so Overheat is a faster route in a
    // window, NEVER above it.
    m = gunnerFireRateMult(m, p.passiveState, p.overheatT > 0);
    // OVERDRIVE (§10): a SEPARATE multiplicative layer (never added to the raw fireRateMult cap),
    // and the COMBINED result is clamped to the expressive fire-rate ceiling so a strong build +
    // Overdrive can't blow past the ~7x expressive DPS envelope.
    if (p.overdriveT > 0) m = Math.min(m * OVERDRIVE.fireFactor, OVERDRIVE.expressiveFireCeiling);
  }
  return m;
}
function dashCooldown(p: PlayerSim): number {
  return PLAYER.dashCooldown * p.mods.dashCdMult;
}
// Post-hit protection and the dash iframe are separate, non-extending windows; a player is
// safe while either is live.
function isProtected(p: PlayerSim): boolean {
  return p.invuln > 0 || p.dashInvuln > 0 || p.ultInvuln > 0 || p.spawnShieldT > 0;
}
// A collected coin's face value: Greed's multiplier × the co-op compensation (coin income
// is per-player and floor coins are first-come, so a party splits them ~P ways — the
// value multiplier keeps each member's per-floor income roughly party-size-invariant,
// which the premium ladder's P-invariant prices assume). Solo is ×1, unchanged.
function coinGain(w: WorldState, p: PlayerSim): number {
  const draught = p.prospectorFloor === w.floor ? PREMIUM.prospectorMult : 1;
  return Math.max(1, Math.round(p.mods.coinMult * draught * coopCoinGainMult(w.encounterPlayers)));
}
function comboMult(p: PlayerSim): number {
  return C.comboTierFor(p.combo).mult;
}
function comboTierIndex(combo: number): number {
  return combo >= 20 ? 3 : combo >= 10 ? 2 : combo >= 5 ? 1 : 0;
}
function comboCoinValue(w: WorldState, p: PlayerSim): number {
  return Math.max(1, Math.round(coinGain(w, p) * comboMult(p)));
}

function gambleOutcomeFor(w: WorldState, p: PlayerSim, wep: Weapon): OddsmakerOutcome | null {
  const outcomes = wep.gamble?.outcomes;
  if (outcomes === undefined || outcomes.length === 0) return null;
  let mixed = (w.seed ^ stablePlayerIdHash(p.id)
    ^ Math.imul(p.weaponCycles.oddsmaker + 1, 0x9e3779b1)) >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  return outcomes[(mixed >>> 0) % outcomes.length];
}

function isReclaimableWeapon(wep: Weapon): boolean {
  return wep.melee === undefined
    && wep.bounce === undefined
    && wep.homing === undefined
    && wep.chain === undefined
    && wep.blast === undefined
    && wep.paint === undefined
    && wep.killShards === undefined
    && wep.accel === undefined
    && wep.isPhase !== true
    && wep.implode === undefined
    && wep.grapple === undefined
    && wep.modeShift === undefined
    && wep.gamble === undefined;
}

function resolveShot(w: WorldState, p: PlayerSim, weapon: WeaponId): ShotSpec {
  const wep = WEAPONS[weapon];
  const alternate = wep.modeShift !== undefined && p.weaponCycles.sluicegate % 2 === 1
    ? wep.modeShift.alternate
    : null;
  const sluiceMode: SluiceMode | undefined = wep.modeShift === undefined
    ? undefined
    : alternate === null ? "flood" : "drain";
  const basePellets = alternate?.pellets ?? wep.pellets;
  const baseSpread = alternate?.spread ?? wep.spread;
  const pellets = basePellets + p.mods.extraPellets;
  const spread = pellets > 1 ? Math.max(baseSpread, C.MIN_MULTI_SPREAD) + p.mods.spreadAdd : baseSpread;
  // The Lastlight's intrinsic risk curve: weapon-authored (like the Thunderbolt's 9),
  // scaling with MISSING health on top of the (capped) blessing damage multiplier.
  const riskMult = wep.lowHpBonus !== undefined ? 1 + wep.lowHpBonus * lowHpFrac(p.hp, p.maxHp) : 1;
  const shot: ShotSpec = {
    pellets,
    basePellets,
    spread,
    speed: (alternate?.speed ?? wep.speed) * p.mods.bulletSpeedMult,
    life: (alternate?.life ?? wep.life) * p.mods.bulletLifeMult,
    radius: (alternate?.bulletRadius ?? wep.bulletRadius) * p.mods.bulletSizeMult,
    color: wep.color,
    damage: (alternate?.damage ?? wep.damage) * riskMult * currentDamageMult(p),
    pierce: Math.min(4, (alternate?.basePierce ?? wep.basePierce ?? 0) + p.mods.pierce
      + (p.kitId === "gunner" && p.overdriveT > 0 ? OVERDRIVE.bonusPierce : 0)
      + (p.kitId === "gunner" && p.overheatT > 0 ? OVERHEAT.bonusPierce : 0)),
    critChance: p.mods.critChance,
    critMult: p.mods.critMult,
    fx: wep.id,
    bounce: wep.bounce,
    homing: wep.homing,
    chain: wep.chain,
    chainRange: wep.chainRange,
    blast: wep.blast,
    burn: wep.burn,
    chill: wep.chill,
    shock: wep.shock,
    killShards: wep.killShards,
    accel: wep.accel,
    isPhase: wep.isPhase,
    implode: wep.implode,
    nova: wep.nova,
    // Frostline painting, mods-mapped here (size -> zone footprint, life -> duration).
    paintSpacing: wep.paint?.spacing,
    paintRadius: wep.paint !== undefined ? wep.paint.radius * p.mods.bulletSizeMult : undefined,
    paintLife: wep.paint !== undefined ? wep.paint.life * p.mods.bulletLifeMult : undefined,
    paintRate: wep.paint?.chillRate,
    isPaving: wep.paint?.isPaving,
    grapplePull: wep.grapple?.pull,
    paintZonesLeft: wep.paint?.isPaving === true ? C.MAX_PAVE_ZONES_PER_SHOT : undefined,
    shotSeq: p.shotSeq,
    sluiceMode,
  };
  const gamble = gambleOutcomeFor(w, p, wep);
  shot.oddsmakerOutcome = gamble ?? undefined;
  if (gamble === "ricochet") shot.bounce = 1;
  if (gamble === "seeker") shot.homing = 6;
  if (gamble === "blast") shot.blast = 52;
  if (gamble === "pierce") shot.pierce = Math.min(4, shot.pierce + 2);
  if (p.mods.reclaimedBounceDamage > 0 && isReclaimableWeapon(wep)) {
    shot.reclaimedBounceDamage = p.mods.reclaimedBounceDamage;
  }
  // Hushiron (ROOT / RAMP): the stance stacks tighten spread and add pierce + size — and
  // NEVER raw damage (Quill hard rule). Pierce shares CAPS.pierce (the min(4) cap above).
  if (wep.stance !== undefined && p.hushStacks > 0) {
    const s = wep.stance;
    const stacks = Math.min(s.maxStacks, p.hushStacks);
    shot.spread = Math.max(0, shot.spread * (1 - s.spreadPerStack * stacks));
    shot.pierce = Math.min(4, shot.pierce + Math.min(2, Math.floor(stacks / 2)));
    shot.radius += Math.floor(stacks / 3); // 0 -> +1px at 3+ stacks
  }
  // Crosscurrent (blessing): every round the player fires gains chain jumps + jump damage.
  // The combined pierce+chain specialists pay a 55% tax on the JUMP channel only.
  if (p.mods.crosscurrentChain > 0) {
    shot.crosscurrentJumps = p.mods.crosscurrentChain;
    shot.crosscurrentRange = p.mods.crosscurrentJumpRange;
    shot.crosscurrentCoef = p.mods.crosscurrentJumpCoef;
    shot.crosscurrentPreferNew = p.mods.crosscurrentPreferNew > 0;
    shot.crosscurrentTax = crosscurrentTaxFor(weapon, sluiceMode) ? 1 - 0.55 : 1;
  }
  // Last Warm Round (blessing): the cycle-FINAL shot of a weapon deals +% (identity band).
  // Inert on simple guns; the Oddsmaker/Sluicegate pair pays a 45% tax on the bonus.
  if (p.mods.warmRoundBonus > 0 && isCycleFinalShot(wep, sluiceMode, shot.oddsmakerOutcome)) {
    const taxed = warmRoundTaxFor(weapon) ? 1 - 0.45 : 1;
    shot.damage *= 1 + p.mods.warmRoundBonus * taxed;
  }
  return shot;
}

// Crosscurrent combo gate: the pierce+chain specialists (and Sluice in its DRAIN lance)
// route their jump channel through the 55% tax so no pair breaks the 1.35 PU ceiling.
function crosscurrentTaxFor(weapon: WeaponId, sluiceMode: SluiceMode | undefined): boolean {
  if (weapon === "sluicegate") return sluiceMode === "drain";
  return weapon === "tesla" || weapon === "arcbolt" || weapon === "cleaver" || weapon === "skipper";
}

// Last Warm Round combo gate: the Oddsmaker/Sluicegate cycle pair pays the 45% bonus tax.
function warmRoundTaxFor(weapon: WeaponId): boolean {
  return weapon === "oddsmaker" || weapon === "sluicegate";
}

// Whether this committed shot is the FINAL beat of the weapon's fire cycle (Quill cycle
// defs). Simple/Fork/Sidewinder/Margin guns have no shared cycle -> Warm Round is inert.
function isCycleFinalShot(
  wep: Weapon,
  sluiceMode: SluiceMode | undefined,
  outcome: OddsmakerOutcome | undefined,
): boolean {
  if (wep.modeShift !== undefined) return sluiceMode === "drain";
  if (wep.gamble !== undefined) return outcome === "pierce" || outcome === "blast";
  if (wep.charge !== undefined) return true; // every charge shot IS a release volley
  return false;
}

// Recompute maxHp from the mods bonus and clamp current HP into it. Deliberately does NOT
// heal the capacity delta — a max-HP upgrade restores exactly 1 heart (see applyItemToWorld),
// per the Vitality rule in spec §2. Premium +1-heart purchases stack on the blessing bonus
// but the POSITIVE total is hard-capped at the same +4 (Vitality included) — no coin route
// past the studio cap; Glass Cannon's negative bonus and the artifact's heart tithe still
// apply in full below the cap.
export function applyMaxHpBonus(p: PlayerSim): void {
  // Subtract the artifact heart tithe from the RAW bonus BEFORE the positive +4 clamp, not
  // after it. Clamping first (base + clamp(bonus) − tithe) let the cap silently swallow
  // containers the player collected past +4, and THEN the tithe ate real hearts on top —
  // a capped buyer paid for the deal twice. Clamping base+bonus−tithe as one quantity means
  // an over-cap player's tithe comes out of the excess the cap was already eating, so it is
  // free to them; a player exactly at (or below) the cap still pays it in full, unchanged.
  const bonus = p.mods.maxHpBonus + p.premiumHpBuys - p.hpTithe;
  p.maxHp = Math.max(1, PLAYER.baseMaxHp + Math.min(CAPS.maxHpBonus, bonus));
  if (p.hp > p.maxHp) p.hp = p.maxHp;
  if (p.hp < 1) p.hp = 1;
}

// Equip a weapon the player already owns. Switching resets the fire cooldown and cancels
// any in-progress melee swing (matches the current game). No-ops if already equipped.
function setActiveWeaponFireCooldown(p: PlayerSim, seconds: number): void {
  p.fireCd = Math.max(0, seconds);
  p.weaponFireCooldowns[p.weapon] = p.fireCd;
}

function applyActiveWeaponFireLock(p: PlayerSim, seconds: number): void {
  setActiveWeaponFireCooldown(p, Math.max(p.fireCd, seconds));
}

function tickWeaponFireCooldowns(p: PlayerSim, dt: number): void {
  for (const id of Object.keys(p.weaponFireCooldowns) as WeaponId[]) {
    if (id === p.weapon) continue;
    const next = Math.max(0, (p.weaponFireCooldowns[id] ?? 0) - dt);
    if (next === 0) delete p.weaponFireCooldowns[id];
    else p.weaponFireCooldowns[id] = next;
  }
  p.fireCd = Math.max(0, p.fireCd - dt);
  if (p.fireCd === 0) delete p.weaponFireCooldowns[p.weapon];
  else p.weaponFireCooldowns[p.weapon] = p.fireCd;
}

function equipWeapon(p: PlayerSim, id: WeaponId): void {
  if (p.weapon === id) return;
  if (p.fireCd > 0) p.weaponFireCooldowns[p.weapon] = p.fireCd;
  else delete p.weaponFireCooldowns[p.weapon];
  p.weapon = id;
  p.fireCd = p.weaponFireCooldowns[id] ?? 0;
  p.chargeT = 0; // a held Breach charge never survives a weapon switch
  p.meleeSwing = null;
}

// Acquire a weapon (dedup into the inventory) and equip it. Used by weapon pickups (sim)
// and by dev/grant. Manual switching (1-9 / scroll / hotbar) goes through the validated
// switchWeaponInWorld below on every path (LocalTransport and the server).
// The player's hotbar capacity: the studio cap plus any bought extra slot (the premium
// extra_slot purchase, hard-capped at one).
function weaponCapFor(p: PlayerSim): number {
  return C.MAX_OWNED_WEAPONS + p.extraWeaponSlots;
}

// The hotbar cap is enforced HERE, at the one place the inventory grows, so
// the invariant is structural: no acquisition path (pickup, boss claim, shop, dev grant)
// can ever mint a slot past the number-key row. Callers that want a nicer refusal (the
// pickup pass leaving the weapon on the floor, the shop's HOTBAR FULL status) gate
// earlier; this returns whether the weapon is owned+equipped afterwards.
function acquireWeapon(w: WorldState, p: PlayerSim, id: WeaponId): boolean {
  if (isPvp(w) && !isPvpWeaponSupported(id)) return false;
  if (!p.ownedWeapons.includes(id)) {
    if (p.ownedWeapons.length >= weaponCapFor(p)) return false;
    p.ownedWeapons.push(id);
  }
  equipWeapon(p, id);
  return true;
}

// The mystery reveal's baked twist (see rollMysteryTwist): a small buff or a small
// drawback, never a dead result. Blessed follows the heart rules exactly (+1 HP, or the
// coin conversion at full health); cursed jams the freshly-equipped trigger for a beat.
function applyMysteryTwist(p: PlayerSim, twist: MysteryTwist, ev: SimEvent[]): void {
  if (twist === "blessed") {
    if (p.hp < p.maxHp) {
      p.hp++;
      ev.push({ t: "heal", pid: p.id, x: p.x, y: p.y });
    } else {
      p.coins += SUSTAIN.fullHpHeartCoins;
    }
  } else if (twist === "cursed") {
    applyActiveWeaponFireLock(p, MYSTERY.cursedJamSeconds);
  }
}

// A mystery pickup's reveal at the claim moment: the baked identity — rerolled through
// the bag's mystery gamble when the claimant already owns it (never a dead result) —
// plus the shared reveal event. Shared by the walk-over collect and the full-hotbar
// swap, so the two claim paths can never diverge. The caller applies the twist AFTER
// acquiring (equipWeapon resets fireCd, which would silently clear a cursed jam).
function revealMysteryPickup(w: WorldState, p: PlayerSim, pk: Pickup, ev: SimEvent[]): WeaponId {
  const grant = p.ownedWeapons.includes(pk.weapon!)
    ? rollBagWeapon(w, () => w.rng.next(), new Set(p.ownedWeapons), { isMystery: true })
    : pk.weapon!;
  ev.push({ t: "mysteryReveal", pid: p.id, weapon: grant, twist: pk.twist ?? "plain", x: pk.x, y: pk.y });
  return grant;
}

// Authoritative, validated weapon switch (LocalTransport + the server's equip handler).
// Equips only a slot the player actually owns; an unowned id is ignored (a tampered client
// can't equip a weapon it never picked up). Returns whether the switch was accepted.
// equipWeapon resets the fire cooldown and cancels any in-progress melee swing.
export function switchWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId): boolean {
  const p = w.players.get(pid);
  if (!p || w.pendingBlessings.has(pid) || !p.ownedWeapons.includes(id) || (isPvp(w) && !isPvpWeaponSupported(id))) return false;
  equipWeapon(p, id);
  return true;
}

// Client-driven acquire + equip (dev grant, or golden 'weapon' command). At the hotbar
// cap the grant REPLACES the equipped slot in place (the sandbox/golden affordance for
// cycling arbitrary weapons) — the cap invariant holds on every path; the gameplay claim
// path at the cap is swapWeaponInWorld.
export function acquireWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId): void {
  const p = w.players.get(pid);
  if (!p || (isPvp(w) && !isPvpWeaponSupported(id)) || acquireWeapon(w, p, id)) return;
  const replaced = p.weapon;
  p.ownedWeapons[p.ownedWeapons.indexOf(replaced)] = id;
  equipWeapon(p, id);
  delete p.weaponFireCooldowns[replaced];
}

export function reorderWeaponsInWorld(w: WorldState, pid: PlayerId, from: number, to: number): boolean {
  // Authoritative inventory reorder (drag/drop on the hotbar). Moves the slot at `from` to
  // position `to`; every other slot keeps its relative order. The equipped weapon is tracked
  // by ID (p.weapon), so it survives any reorder — only the 1-9 key mapping changes. Both
  // indices must name real slots; a stale index (inventory changed in flight) is rejected.
  const p = w.players.get(pid);
  if (!p || w.pendingBlessings.has(pid)) return false;
  const n = p.ownedWeapons.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= n || to < 0 || to >= n) return false;
  if (from === to) return true; // no-op reorder is valid (idempotent)
  const [moved] = p.ownedWeapons.splice(from, 1);
  p.ownedWeapons.splice(to, 0, moved);
  return true;
}

export function dropWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId, ev: SimEvent[]): boolean {
  // Authoritative weapon drop (Q / inventory UI): remove an OWNED weapon from the player's
  // inventory and spawn it as a shared world pickup on a safe, reachable spot. Gates:
  //  - never while the run is over, the player is downed, or a pick is pending (blessing
  //    or weapon claim — those states pause the player; a drop there would be a free
  //    action or a dupe window);
  //  - never the final weapon — the player always keeps at least one (the default pistol
  //    if that is all they own). Any weapon may be dropped while another remains.
  // If the dropped weapon was equipped, the adjacent slot (same index, else the new last)
  // is equipped so the hand is never empty. Rejected drops mutate nothing.
  const p = w.players.get(pid);
  if (!p) return false;
  if (w.isRunOver || p.isDown || w.pendingBlessings.has(pid)) return false;
  if (p.ownedWeapons.length <= 1) return false;
  const idx = p.ownedWeapons.indexOf(id);
  if (idx < 0) return false;
  const spot = weaponDropSpot(w, p);
  if (!spot) return false; // fully boxed in: keep the weapon rather than spawn it unreachable
  p.ownedWeapons.splice(idx, 1);
  delete p.weaponFireCooldowns[id];
  if (p.weapon === id) equipWeapon(p, p.ownedWeapons[Math.min(idx, p.ownedWeapons.length - 1)]);
  const [x, y] = spot;
  w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon: id });
  ev.push({ t: "weaponDrop", weapon: id, x, y });
  return true;
}

export function swapWeaponInWorld(w: WorldState, pid: PlayerId, pickupId: number, dropId: WeaponId, ev: SimEvent[]): boolean {
  // Authoritative full-hotbar swap: trade an OWNED weapon for the weapon pickup the player
  // is standing on. This is the ONE way to claim a new weapon at the cap (updatePickups
  // refuses to auto-collect into a full hotbar), and it is atomic — validate everything,
  // then mutate: the replaced weapon lands as a normal world pickup (the same safe
  // weaponDropSpot the Q drop uses) and the incoming weapon is acquired + equipped.
  // Declining is free by construction: no command is sent and the pickup stays put.
  // Gates mirror dropWeaponInWorld (no free actions from paused/terminal states), then:
  //  - the hotbar must actually be full — below the cap a walk-over collects, so a swap
  //    command is a tampered/stale client, not a state this function invents;
  //  - dropId must be owned; the pickup must be a live weapon within WEAPON_SWAP_RANGE;
  //  - the pickup must be claimable by THIS player: not an already-owned weapon, and a
  //    boss-choice pedestal only before this player's personal claim (gate §4).
  // A boss-choice swap resolves its grant exactly like the walk-over claim (seeded reroll
  // when the pedestal weapon is owned) and leaves the pedestal standing for teammates —
  // the all-claimed sweep in updatePickups retires it, same as always.
  const p = w.players.get(pid);
  if (!p) return false;
  if (w.isRunOver || p.isDown || p.isAbsent || w.pendingBlessings.has(pid)) return false;
  if (p.ownedWeapons.length < weaponCapFor(p)) return false;
  const dropIdx = p.ownedWeapons.indexOf(dropId);
  if (dropIdx < 0) return false;
  const pk = w.pickups.find((q) => q.id === pickupId);
  if (!pk || pk.kind !== "weapon" || pk.weapon === null) return false;
  if (isPvp(w) && !isPvpWeaponSupported(pk.weapon)) return false;
  if (Math.hypot(p.x - pk.x, p.y - pk.y) > C.WEAPON_SWAP_RANGE) return false;
  // A mystery's identity is hidden, so "already owned" can never block the swap — the
  // reveal itself rerolls an owned identity into something the claimant lacks.
  if (pk.isBossChoice ? p.hasClaimedBossChoice : (!pk.isMystery && p.ownedWeapons.includes(pk.weapon))) return false;
  const spot = weaponDropSpot(w, p);
  if (!spot) return false; // fully boxed in: keep everything rather than lose a weapon
  let grant = pk.weapon;
  let mysteryTwist: MysteryTwist | null = null;
  if (pk.isBossChoice) {
    p.hasClaimedBossChoice = true;
    if (p.ownedWeapons.includes(pk.weapon)) {
      grant = drawWeaponFromBag(w.weaponBag, new Set(p.ownedWeapons));
      recordWeaponOffer(p.weaponOfferHistory, grant);
    }
  } else {
    if (pk.isMystery) {
      grant = revealMysteryPickup(w, p, pk, ev);
      mysteryTwist = pk.twist ?? "plain";
    }
    w.pickups = w.pickups.filter((q) => q !== pk);
  }
  p.ownedWeapons.splice(dropIdx, 1);
  delete p.weaponFireCooldowns[dropId];
  const [x, y] = spot;
  w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon: dropId });
  ev.push({ t: "weaponDrop", weapon: dropId, x, y });
  acquireWeapon(w, p, grant);
  delete p.weaponFireCooldowns[dropId];
  // The twist lands AFTER the equip (equipWeapon resets fireCd — a cursed jam must stick).
  if (mysteryTwist !== null) applyMysteryTwist(p, mysteryTwist, ev);
  ev.push({ t: "pickup", pid, kind: "weapon", x: pk.x, y: pk.y });
  return true;
}

function weaponDropSpot(w: WorldState, p: PlayerSim): [number, number] | null {
  // Deterministic candidate scan for a player-initiated drop, sharing the chest-loot safety
  // rules: the spot must be standable (walkable floor with wall margin, prop-free,
  // chest-free) AND straight-line reachable from the dropper, so the pickup is always
  // collectible. Candidates prefer the aim direction (drop lands where the player faces),
  // then fan out; radii walk inner-to-outer starting past pickup range (no instant
  // re-collect). Null when everything nearby is blocked — the caller keeps the weapon.
  const angles = C.CHEST_EJECT_ANGLES;
  for (const radius of C.WEAPON_DROP_RADII) {
    for (const da of angles) {
      const a = p.aimAngle + da;
      const x = p.x + Math.cos(a) * radius;
      const y = p.y + Math.sin(a) * radius;
      if (!isStandableSpot(w, x, y, p.pr)) continue;
      if (!isPathOpen(w, p.x, p.y, x, y, p.pr)) continue;
      return [x, y];
    }
  }
  return null;
}

// Apply a picked blessing to a player: append the pick to the level history, RECOMPUTE the
// whole build from levels (no incremental applies — spec §6), clamp the raw caps, and heal
// exactly 1 heart when max HP grew (the Vitality rule). A pick past Lv3 is a no-op.
// Returns the itemPicked FX event.
export function applyItemToWorld(w: WorldState, pid: PlayerId, item: ItemDef): SimEvent[] {
  const p = w.players.get(pid);
  if (!p) return [];
  if ((itemLevelsOf(p.ownedItemIds).get(item.id) ?? 0) >= itemMaxLevel(item)) return [];
  p.ownedItemIds.push(item.id);
  const maxHpBefore = p.maxHp;
  recomputeMods(p.mods, p.ownedItemIds, p.kitId);
  if (isPvp(w)) {
    p.maxHp = PVP.maxHp;
    p.hp = Math.min(p.hp, PVP.maxHp);
  } else {
    applyMaxHpBonus(p);
    if (p.maxHp > maxHpBefore) p.hp = Math.min(p.maxHp, p.hp + 1);
  }
  refreshMaxedShopBlessings(w, p);
  return [{ t: "itemPicked", pid, x: p.x, y: p.y, tint: item.tint }];
}

// Raise a blessing offer for one player: the offerBlessing event surfaces the choice UI
// (solo rolls locally; the server rolls + sends a validated offer), and the pending entry
// pauses/shields that player and holds the descend gate until the pick resolves.
function raiseBlessingOffer(
  w: WorldState,
  pid: PlayerId,
  rare: boolean,
  ev: SimEvent[],
  draftTrigger: PvpDraftTrigger = "none",
): void {
  const p = w.players.get(pid);
  const isDraft = isPvpDraftRuntime(w) && draftTrigger !== "none";
  if (isDraft && p !== undefined) {
    p.pvpDraftTrigger = draftTrigger;
    p.pvpDraftOfferTicksLeft = pvpDraftOfferTicks();
    p.pvpDraftOfferElapsedTicks = 0;
    p.isPvpDraftDeathDelayReported = false;
    p.isPvpDraftAbsenceDelayReported = false;
    w.pendingBlessings.set(pid, PVP.draftOfferSec);
  } else {
    w.pendingBlessings.set(pid, C.BLESSING_OFFER_TTL);
  }
  // An overlay pause is a CANCEL, never a deferred release: a Breach charge held when the
  // pick opens must not fire a shell the instant the menu closes.
  if (p) p.chargeT = 0;
  ev.push({ t: "offerBlessing", pid, rare });
}

// Resolve a blessing OFFER with a pick: apply the item and clear the player's pending state
// (ending their pause/shield and releasing the descend gate). This is the answer path for
// every real offer — the solo/co-op overlay callback and the server's validated
// chooseBlessing command; dev grants (no offer) keep calling applyItemToWorld directly.
export function chooseBlessingInWorld(w: WorldState, pid: PlayerId, item: ItemDef): SimEvent[] {
  if (isPvp(w) && !isPvpBlessingId(item.id)) return [];
  const p = w.players.get(pid);
  if (p === undefined || !w.pendingBlessings.has(pid)) return [];
  const currentLevel = itemLevelsOf(p.ownedItemIds).get(item.id) ?? 0;
  if (currentLevel >= itemMaxLevel(item)) return [];
  const isDraft = isPvpDraftRuntime(w);
  const source = p.pvpDraftTrigger;
  const ordinal = p.pvpDraftOrdinal;
  const isComeback = p.pvpDraftTierBump > 0;
  const latencyTicks = isDraft ? p.pvpDraftOfferElapsedTicks : 0;
  const nextLevel = currentLevel + 1;
  w.pendingBlessings.delete(pid);
  const events = applyItemToWorld(w, pid, item);
  if (isDraft && events.length > 0) {
    const scores = w.match?.scores;
    const score = scores?.get(pid) ?? 0;
    const leaderScore = scores === undefined || scores.size === 0
      ? 0
      : Math.max(...scores.values());
    events.push({
      t: "pvpDraftPicked",
      pid,
      source,
      isComeback,
      ordinal,
      item: item.id,
      level: nextLevel,
      latencyTicks,
      hp: p.hp,
      score,
      leaderScore,
    });
    p.pvpDraftOfferTicksLeft = 0;
    p.pvpDraftOfferElapsedTicks = 0;
    p.pvpDraftTrigger = "none";
  }
  return events;
}

// Resolve a pending offer WITHOUT a pick — the roll came up empty (every blessing maxed), so
// there is nothing to choose and the pause/gate must not wait out the TTL.
export function dismissBlessingOfferInWorld(
  w: WorldState,
  pid: PlayerId,
  outcome: "empty" | "reset" = "empty",
): SimEvent[] {
  const p = w.players.get(pid);
  const events: SimEvent[] = [];
  if (isPvpDraftRuntime(w) && w.pendingBlessings.has(pid) && p !== undefined) {
    events.push({
      t: "pvpDraftResolved",
      pid,
      source: p.pvpDraftTrigger,
      ordinal: p.pvpDraftOrdinal,
      outcome,
      latencyTicks: p.pvpDraftOfferElapsedTicks,
    });
    p.pvpDraftOfferTicksLeft = 0;
    p.pvpDraftOfferElapsedTicks = 0;
    p.pvpDraftTrigger = "none";
  }
  w.pendingBlessings.delete(pid);
  return events;
}

// ---- Patch's shop: the ONE purchase path ----

// Everything a buy can resolve to. "ok" mutated state; every other outcome mutated
// NOTHING — an invalid purchase never consumes coins and never depletes stock. The
// non-"invalid" rejections mirror shopSlotStatusFor exactly, so the copy a client showed
// ("SOLD", "NEED N MORE", …) is also the reason the authority refused.
export type ShopBuyOutcome = "ok" | "invalid" | Exclude<ShopSlotStatus, "buy">;

// Whether living enemies stand close enough to a player that the mid-fight premium
// stations (full heal / reroll-everything) read IN COMBAT. Shop rooms are sanctuary
// (no enemy ever inside), so this only trips when the fight leaks to the doorstep.
export function isPlayerInCombat(w: WorldState, p: { x: number; y: number }): boolean {
  for (const e of w.enemies) {
    if (!e.dead && Math.hypot(e.x - p.x, e.y - p.y) <= PREMIUM.combatLockRadius) return true;
  }
  return false;
}

// The authoritative shop viewer for a live player: the pure shopViewerOf projection plus
// the world-derived combat read. Every sim-side status check goes through here.
export function shopViewerFor(w: WorldState, p: PlayerSim) {
  return shopViewerOf(p, isPlayerInCombat(w, p));
}

// The premium mystery sink's reveal: its own seeded stream, deterministic per (seed,
// floor, slot, buyer, reroll generation), so the same seed + the same wallet always
// reveal the same weapon — solo, server, and any replay agree — while two buyers of one
// personal slot each get their own fate. Per the approved spec the premium gamble
// "rolls rare+": the tier rides the SHARED rarity roll (weapons.ts) with the premium
// ladder's depth-boosted legendary weight, and a common result promotes to RARE — the
// 45-170 price buys a floor under the gamble the base pedestal mystery (1.25× ladder)
// doesn't have. The pick is distinct-from-owned while the tier permits.
function premiumMysteryRoll(w: WorldState, slot: ShopSlot, p: PlayerSim): WeaponId {
  const rng = new Rng(
    (w.seed ^ 0x6d757374)
    + w.floor * 68041
    + slot.id * 977
    + (w.shop?.rerollsUsed ?? 0) * 31337
    + stablePlayerIdHash(p.offerIdentity)
    + p.premiumWeaponOfferOrdinal++ * 0x6a09e667,
  );
  const rolled = rollWeaponRarity(
    () => rng.next(),
    w.floor,
    { isMystery: true, legendaryWeight: premiumMysteryLegendaryWeight(w.floor) },
    w.catalogVersion,
  );
  const tier: WeaponRarity = rolled === "common" ? "rare" : rolled;
  const inTier = contentCatalogFor(w.catalogVersion).pickupWeapons
    .filter((id) => WEAPONS[id].rarity === tier);
  return rollWeaponOfferWithHistory(
    inTier,
    () => rng.next(),
    p.weaponOfferHistory,
    new Set(p.ownedWeapons),
  );
}

// The upgrade station's reforge target: a seeded weapon of the NEXT tier up from the
// buyer's equipped gun, distinct-from-owned while the tier permits. Same per-buyer
// salted-stream determinism as the mystery reveal.
function weaponUpgradeRoll(w: WorldState, slot: ShopSlot, p: PlayerSim, target: WeaponRarity): WeaponId {
  const rng = new Rng(
    (w.seed ^ 0x46049e5)
    + w.floor * 68041
    + slot.id * 977
    + stablePlayerIdHash(p.offerIdentity)
    + p.premiumWeaponOfferOrdinal++ * 0x6a09e667,
  );
  const inTier = contentCatalogFor(w.catalogVersion).pickupWeapons
    .filter((id) => WEAPONS[id].rarity === target);
  return rollWeaponOfferWithHistory(
    inTier,
    () => rng.next(),
    p.weaponOfferHistory,
    new Set(p.ownedWeapons),
  );
}

// Burn a player's armed blessing-offer reroll (a reroll-everything purchase). The caller
// is the offer ROLLER — the solo client or the authoritative server — which discards one
// full choice-set draw from its offer stream when this returns true.
export function consumeBlessingReroll(w: WorldState, pid: PlayerId): boolean {
  const p = w.players.get(pid);
  if (!p || !p.isBlessingRerollArmed) return false;
  p.isBlessingRerollArmed = false;
  return true;
}

export function rollBlessingChoicesInWorld(
  w: WorldState,
  pid: PlayerId,
  isRareOnly: boolean,
  count = 3,
): ItemDef[] {
  const p = w.players.get(pid);
  if (!p || isPvp(w)) return [];
  const draw = (): ItemDef[] => {
    const rng = new Rng(
      (w.seed ^ 0x0b1e55)
      + stablePlayerIdHash(p.offerIdentity)
      + p.blessingOfferOrdinal++ * 0x6a09e667,
    );
    return rollItemChoicesWith(
      count,
      () => rng.next(),
      p.ownedItemIds,
      {
        isRareOnly,
        history: p.blessingOfferHistory,
        eligibleItems: normalItemsForCatalog(w.catalogVersion),
      },
    );
  };
  if (consumeBlessingReroll(w, pid)) draw();
  const choices = draw();
  recordBlessingOffer(p.blessingOfferHistory, choices.map((item) => item.id));
  return choices;
}

// The validated, authoritative shop purchase — the ONLY way coins leave a player at the
// stall (LocalTransport routes the solo panel here; the server routes the shopBuy command
// here). Walking over a station never reaches this function, let alone buys.
// Gates, in order: a live shop and slot; a present, standing, unpaused buyer; physical
// proximity to the station (a tampered client cannot buy from across the map); then the
// same per-viewer status matrix every UI surface renders. Success is idempotent by
// construction — a repeated buy of the same slot resolves to its post-purchase status
// (sold/owned/…) and consumes nothing further.
export function buyFromShopInWorld(w: WorldState, pid: PlayerId, slotId: number, ev: SimEvent[]): ShopBuyOutcome {
  const shop = w.shop;
  if (!shop || w.isRunOver) return "invalid";
  const p = w.players.get(pid);
  if (!p || p.isDown || p.isAbsent || p.hp <= 0 || w.pendingBlessings.has(pid)) return "invalid";
  const slot = shop.slots.find((s) => s.id === slotId);
  if (!slot) return "invalid";
  if (Math.hypot(p.x - slot.x, p.y - slot.y) > SHOP_BUY_RANGE) return "invalid";
  const stockedSlot = shopSlotForViewer(shop, slot, pid);
  const viewer = shopViewerFor(w, p);
  const status = shopSlotStatusFor(shop, stockedSlot, viewer);
  if (status !== "buy") return status;
  p.coins -= shopSlotPriceFor(shop, stockedSlot, viewer);
  switch (slot.kind) {
    case "weapon": {
      slot.soldTo = pid;
      if (slot.isMystery) {
        // The mystery pedestal reveals ON PURCHASE: an already-owned identity rerolls
        // into something the buyer lacks (never a dead buy), the twist lands, and the
        // slot flips to its true face — the SOLD pedestal shows what it was.
        const grant = p.ownedWeapons.includes(stockedSlot.weapon!)
          ? rollBagWeapon(w, () => w.rng.next(), new Set(p.ownedWeapons), { isMystery: true })
          : stockedSlot.weapon!;
        slot.weapon = grant;
        slot.isMystery = false;
        acquireWeapon(w, p, grant);
        applyMysteryTwist(p, stockedSlot.twist ?? "plain", ev);
        ev.push({ t: "mysteryReveal", pid, weapon: grant, twist: stockedSlot.twist ?? "plain", x: slot.x, y: slot.y });
        slot.twist = null;
      } else {
        acquireWeapon(w, p, stockedSlot.weapon!);
      }
      break;
    }
    case "blessing": {
      slot.buyers.push(pid);
      const item = itemById(stockedSlot.itemId!);
      if (item) for (const e of applyItemToWorld(w, pid, item)) ev.push(e);
      break;
    }
    case "heart": {
      slot.buyers.push(pid);
      p.hp = Math.min(p.maxHp, p.hp + SHOP.heartHeal);
      break;
    }
    case "reroll": {
      shop.rerollsUsed++;
      const restocked = restockShop(
        shop,
        w.seed,
        w.floor,
        [...weaponsOwnedByAll(w)],
        false,
        w.weaponBag,
      );
      recordRestockedSharedWeapons(w, restocked);
      refreshPersonalShopStock(w, restocked);
      break;
    }
    // ---- the premium sinks ----
    case "mystery": {
      // The premium gamble: personal, revealed per-buyer (twist-free — the rarity IS the
      // gamble; the base pedestal mystery keeps the blessed/cursed spice).
      slot.buyers.push(pid);
      const weapon = premiumMysteryRoll(w, slot, p);
      acquireWeapon(w, p, weapon);
      ev.push({ t: "mysteryReveal", pid, weapon, twist: "plain", x: slot.x, y: slot.y });
      break;
    }
    case "legendary": {
      slot.buyers.push(pid);
      acquireWeapon(w, p, stockedSlot.weapon!);
      break;
    }
    case "rare_blessing":
    case "core_infusion": {
      slot.buyers.push(pid);
      const item = itemById(stockedSlot.itemId!);
      if (item) for (const e of applyItemToWorld(w, pid, item)) ev.push(e);
      break;
    }
    case "max_hp": {
      slot.buyers.push(pid);
      p.premiumHpBuys++;
      const maxHpBefore = p.maxHp;
      applyMaxHpBonus(p);
      if (p.maxHp > maxHpBefore) p.hp = Math.min(p.maxHp, p.hp + 1);
      break;
    }
    case "full_heal": {
      // The Panacea splurge: to full, never past maxHp, and deliberately NO protection
      // frames — recovery is purchasable, invulnerability is not.
      slot.buyers.push(pid);
      p.hp = p.maxHp;
      break;
    }
    case "weapon_upgrade": {
      // The loyalty reforge: the EQUIPPED gun is elevated one rarity tier — the old gun
      // leaves the hotbar, its seeded next-tier reforge takes the hand. Priced by the
      // TARGET tier (see shopSlotPriceFor); a legendary in hand reads CAPPED upstream.
      slot.buyers.push(pid);
      const target = upgradeTargetTier(p.weapon)!;
      const reforged = weaponUpgradeRoll(w, slot, p, target);
      const idx = p.ownedWeapons.indexOf(p.weapon);
      p.ownedWeapons.splice(idx, 1);
      acquireWeapon(w, p, reforged);
      ev.push({ t: "mysteryReveal", pid, weapon: reforged, twist: "plain", x: slot.x, y: slot.y });
      break;
    }
    case "revive_token": {
      slot.buyers.push(pid);
      p.reviveTokens = 1;
      break;
    }
    case "extra_slot": {
      slot.buyers.push(pid);
      p.extraWeaponSlots = 1;
      break;
    }
    case "reroll_all": {
      shop.rerollsUsed++;
      const restocked = restockShop(
        shop,
        w.seed,
        w.floor,
        [...weaponsOwnedByAll(w)],
        true,
        w.weaponBag,
      );
      recordRestockedSharedWeapons(w, restocked);
      refreshPersonalShopStock(w, restocked);
      p.isBlessingRerollArmed = true;
      break;
    }
    case "amber_cache": {
      slot.buyers.push(pid);
      p.isAmberCacheArmed = true;
      break;
    }
    case "prospector": {
      slot.buyers.push(pid);
      p.prospectorFloor = w.floor;
      break;
    }
    case "artifact": {
      // The devil deal (climax only): a legendary paid in MAX HEARTS. The tithe is a
      // real trade — max capacity drops for the rest of the run (applyMaxHpBonus), the
      // status matrix already guaranteed enough hearts remain, and the deal is 1/run.
      slot.buyers.push(pid);
      p.hpTithe += PREMIUM.artifactHeartCost;
      applyMaxHpBonus(p);
      acquireWeapon(w, p, stockedSlot.weapon!);
      break;
    }
    // ---- the mythic capstone (one shared claim per party per shop) ----
    case "mythic_weapon": {
      slot.soldTo = pid;
      acquireWeapon(w, p, stockedSlot.weapon!);
      break;
    }
    case "mythic_trio": {
      // Pick 1 of 3 rares: the existing rare-offer machinery — the buyer is paused under
      // the offer (sanctuary ground) and the descend gate holds until they answer.
      slot.soldTo = pid;
      raiseBlessingOffer(w, pid, true, ev);
      break;
    }
    case "mythic_amber": {
      slot.soldTo = pid;
      p.amberWindfall += PREMIUM.mythicAmber;
      break;
    }
  }
  ev.push({ t: "shopBuy", pid, slot: slot.id, kind: slot.kind, x: slot.x, y: slot.y });
  return "ok";
}

// The station a player is standing near enough to interact with (highlight + prompt +
// panel target): the nearest slot within range, or null. Client affordance only — the
// buy itself re-validates proximity authoritatively.
export function nearestShopSlot(w: WorldState, x: number, y: number, range: number): ShopSlot | null {
  if (!w.shop) return null;
  let best: ShopSlot | null = null;
  let bestD = range;
  for (const slot of w.shop.slots) {
    const d = Math.hypot(x - slot.x, y - slot.y);
    if (d < bestD) { bestD = d; best = slot; }
  }
  return best;
}

// Tick pending offers on the SIM clock: an unanswered offer expires after BLESSING_OFFER_TTL
// and the run moves on without the pick, so an AFK/hostile client can never hold the party's
// descend gate (or their own damage shield) forever. Expiry is EMITTED, not silent — the
// authoritative server clears the matching connection/seat offer off the event (both sides
// resolve on the same tick) and the owning client closes its overlay.
function tickPendingBlessings(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.pendingBlessings.size === 0) return;
  if (isPvpDraftRuntime(w)) {
    const isEnough = pvpPresentPlayers(w).length >= PVP.minPlayers;
    for (const pid of [...w.pendingBlessings.keys()].sort()) {
      const p = w.players.get(pid);
      if (p === undefined) {
        w.pendingBlessings.delete(pid);
        continue;
      }
      if (p.pvpDraftOfferTicksLeft <= 0) {
        p.pvpDraftOfferTicksLeft = Math.max(
          1,
          Math.round((w.pendingBlessings.get(pid) ?? PVP.draftOfferSec) * TICKS_PER_SECOND),
        );
      }
      if (!isEnough || p.isAbsent) {
        if (!p.isPvpDraftAbsenceDelayReported) {
          p.isPvpDraftAbsenceDelayReported = true;
          ev.push({
            t: "pvpDraftDelayed",
            pid,
            ordinal: p.pvpDraftOrdinal,
            reason: "absence",
            remainingTicks: p.pvpDraftOfferTicksLeft,
          });
        }
        continue;
      }
      if ((p.hp <= 0 || p.respawnT > 0) && !p.isPvpDraftDeathDelayReported) {
        p.isPvpDraftDeathDelayReported = true;
        ev.push({
          t: "pvpDraftDelayed",
          pid,
          ordinal: p.pvpDraftOrdinal,
          reason: "death",
          remainingTicks: p.pvpDraftOfferTicksLeft,
        });
      }
      p.pvpDraftOfferTicksLeft--;
      p.pvpDraftOfferElapsedTicks++;
      if (p.pvpDraftOfferTicksLeft <= 0) {
        const source = p.pvpDraftTrigger;
        const ordinal = p.pvpDraftOrdinal;
        const latencyTicks = p.pvpDraftOfferElapsedTicks;
        w.pendingBlessings.delete(pid);
        p.pvpDraftOfferElapsedTicks = 0;
        p.pvpDraftTrigger = "none";
        ev.push({ t: "blessingExpired", pid });
        ev.push({ t: "pvpDraftResolved", pid, source, ordinal, outcome: "expiry", latencyTicks });
      } else {
        w.pendingBlessings.set(pid, p.pvpDraftOfferTicksLeft / TICKS_PER_SECOND);
      }
    }
    return;
  }
  for (const [pid, left] of w.pendingBlessings) {
    if (left <= dt) {
      w.pendingBlessings.delete(pid);
      ev.push({ t: "blessingExpired", pid });
    } else {
      w.pendingBlessings.set(pid, left - dt);
    }
  }
}

// ---- knockback ----

function applyKnockbackDir(
  weapon: WeaponId,
  e: Enemy,
  dirX: number,
  dirY: number,
  impulseScale = 1,
): void {
  // The GIANTS (Gorge F50 / Pale Throne F75) are anchored SET-PIECES (and their tectonic
  // weak-points jut from a fixed spot on the shell): they absorb the hit, they never slide.
  // Immovable at the source.
  if (e.kind === "gorge" || e.kind === "gorge_seam" || e.kind === "pale" || e.kind === "pale_seam") return;
  const sp = Math.hypot(dirX, dirY) || 1;
  const v = (C.WEAPON_KB[weapon] * C.KB_LAMBDA * impulseScale) / e.kbResist;
  e.vx += (dirX / sp) * v;
  e.vy += (dirY / sp) * v;
  const mag = Math.hypot(e.vx, e.vy);
  if (mag > C.KB_MAX_SPEED) { const s = C.KB_MAX_SPEED / mag; e.vx *= s; e.vy *= s; }
}

function applyKnockbackDecay(w: WorldState, e: Enemy, dt: number): void {
  if (e.vx === 0 && e.vy === 0) return;
  moveEnemyBy(w, e, e.vx * dt, e.vy * dt);
  const d = Math.min(1, dt * C.KB_LAMBDA);
  e.vx -= e.vx * d; e.vy -= e.vy * d;
  if (e.vx < 1 && e.vx > -1) e.vx = 0;
  if (e.vy < 1 && e.vy > -1) e.vy = 0;
}

// ---- elemental status ----

function isFrozen(e: Enemy): boolean {
  return !isBossKind(e.kind) && e.chill >= C.FREEZE_AT;
}
function chillMoveScale(e: Enemy): number {
  const chillScale = e.chill <= 0 ? 1 : isFrozen(e) ? 0 : C.CHILL_SLOW;
  return Math.min(chillScale, e.meleeSlowT > 0 ? e.meleeSlowMult : 1);
}
// Baby Slime SLIMETRAIL enemy-slow: 1 (no patch under this body), the full slow for trash/brute,
// half for elites, and always 1 for bosses (immune). Read off the shared hazard list each move.
function slimeSlowMult(w: WorldState, e: Enemy): number {
  if (isBossKind(e.kind)) return 1; // bosses immune (also skips the scan)
  for (const h of w.hazards) {
    if (h.kind !== "slime") continue;
    if (Math.hypot(e.x - h.x, e.y - h.y) < h.radius) return slimeSlowMul(false, e.tier === "elite");
  }
  return 1;
}
function applyBurn(e: Enemy, secs: number, owner: PlayerId | null, ev: SimEvent[]): void {
  // First application announces through the SHARED status library; re-stamps and the
  // DoT's ticks stay silent by contract (their cadence carries no decision).
  if (e.burn === 0) ev.push({ t: "statusApplied", eid: e.id, x: e.x, y: e.y, kind: "burn" });
  if (secs > e.burn) e.burn = secs;
  // Boss-grade bodies cap the DoT lower (envelope: burn is pack pressure; a boss's bar
  // is paced by the vulnerability channel, never by a stacked clock).
  const cap = isBossKind(e.kind) || e.captainPhase !== undefined ? C.BURN_DMG_MAX_BOSS : C.BURN_DMG_MAX;
  e.burnDmg = Math.min(cap, e.burnDmg + C.BURN_DMG_STACK);
  // The most recent igniter owns the burn; its DoT tick credits that id on a kill. The identity
  // is immutable: if the igniter disconnects, the burn keeps THEIR id (which then credits no
  // one), never a different live player.
  e.burnOwner = owner;
}
function applyChill(e: Enemy, secs: number, ev: SimEvent[]): void {
  if (e.chill === 0 && secs > 0) ev.push({ t: "statusApplied", eid: e.id, x: e.x, y: e.y, kind: "chill" });
  const wasFrozen = isFrozen(e);
  e.chill = Math.min(C.CHILL_MAX, e.chill + secs);
  if (!wasFrozen && isFrozen(e)) ev.push({ t: "frozeSolid", eid: e.id, x: e.x, y: e.y });
}
function applyMeleeSlow(e: Enemy, moveMult: number, secs: number, tick: number): void {
  e.meleeSlowMult = e.meleeSlowT > 0 ? Math.min(e.meleeSlowMult, moveMult) : moveMult;
  e.meleeSlowT = Math.max(e.meleeSlowT, secs);
  e.meleeSlowAppliedTick = tick;
}
function applyShock(e: Enemy, secs: number, ev: SimEvent[]): void {
  if (e.shock === 0 && secs > 0) ev.push({ t: "statusApplied", eid: e.id, x: e.x, y: e.y, kind: "shock" });
  if (secs > e.shock) e.shock = secs;
}
// `p` is the striking player when still connected; null when the actor has left (their in-flight
// bullet keeps its baked-in statuses via `src` + the immutable ownerId, but the mods-chance rolls
// need a live player and are skipped).
function applyHitStatuses(w: WorldState, p: PlayerSim | null, e: Enemy, src: StrikeInfo, ev: SimEvent[]): void {
  if (src.burn !== undefined) applyBurn(e, src.burn, src.ownerId, ev);
  else if (p && p.mods.burnChance > 0 && w.rng.next() < p.mods.burnChance) applyBurn(e, C.ITEM_BURN_SECS, p.id, ev);
  if (src.chill !== undefined) applyChill(e, src.chill, ev);
  else if (p && p.mods.chillChance > 0 && w.rng.next() < p.mods.chillChance) applyChill(e, C.ITEM_CHILL_SECS, ev);
  if (src.shock !== undefined) applyShock(e, src.shock, ev);
  else if (p && p.mods.shockChance > 0 && w.rng.next() < p.mods.shockChance) applyShock(e, C.ITEM_SHOCK_SECS, ev);
}

function tickStatuses(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (e.meleeSlowT > 0 && e.meleeSlowAppliedTick !== w.tick) {
    e.meleeSlowT = e.meleeSlowT > dt ? e.meleeSlowT - dt : 0;
    if (e.meleeSlowT === 0) e.meleeSlowMult = 1;
  }
  if (e.chill > 0) {
    const wasFrozen = isFrozen(e);
    e.chill = e.chill > dt ? e.chill - dt : 0;
    // The shell shatters as the freeze decays — the status BREAK tell (dead bodies
    // skip it; their kill burst already carried the moment).
    if (wasFrozen && !isFrozen(e) && !e.dead) ev.push({ t: "freezeBroke", eid: e.id, x: e.x, y: e.y });
  }
  if (e.shock > 0) e.shock = e.shock > dt ? e.shock - dt : 0;
  if (e.markT > 0) e.markT = e.markT > dt ? e.markT - dt : 0; // PHANTOM dash-through mark decay
  if (e.petMarkT > 0) e.petMarkT = e.petMarkT > dt ? e.petMarkT - dt : 0; // Cat STALK info-pip decay
  if (e.revealT > 0) e.revealT = e.revealT > dt ? e.revealT - dt : 0; // Known by Touch reveal decay
  if (e.burn > 0) {
    e.burn = e.burn > dt ? e.burn - dt : 0;
    e.statusTick += dt;
    while (e.statusTick > C.BURN_TICK) {
      damageEnemy(w, e.burnOwner, e, e.burnDmg * C.BURN_TICK, ev);
      e.statusTick -= C.BURN_TICK;
      ev.push({ t: "burnTick", x: e.x, y: e.y, radius: e.radius, dmg: e.burnDmg * C.BURN_TICK });
      // The burn DoT kill credits whoever last ignited this enemy (authoritative attribution).
      // A departed igniter credits no one — the kill still resolves and drops base-value loot.
      if (e.hp <= 0) { killEnemy(w, ownerOf(w, e.burnOwner), e, ev); break; }
    }
    if (e.burn === 0) { e.burnDmg = 0; e.statusTick = 0; }
  }
}

function shockArc(w: WorldState, p: PlayerSim | null, from: Enemy, ev: SimEvent[]): void {
  arcLightning(w, p, from, 1, C.SHOCK_ARC_RANGE, C.SHOCK_ARC_DMG, "#7fe9ff", [from], ev);
}

function arcLightning(w: WorldState, p: PlayerSim | null, origin: Enemy, jumps: number, range: number, dmg: number, color: string, list: Enemy[], ev: SimEvent[]): void {
  let cur: Enemy = origin;
  for (let j = 0; j < jumps; j++) {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of w.enemies) {
      if (e.dead || isUntargetable(e) || list.indexOf(e) !== -1) continue;
      const dx = e.x - cur.x, dy = e.y - cur.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) break;
    damageEnemy(w, p ? p.id : null, best, dmg, ev);
    const killed = best.hp <= 0 && !best.dead;
    ev.push({ t: "shockArc", eid: best.id, x: cur.x, y: cur.y, tx: best.x, ty: best.y, tRadius: best.radius, dmg, color, killed });
    list.push(best);
    if (killed) killEnemy(w, p, best, ev);
    cur = best;
  }
}

// ---- strikes / kills ----

// The shared anti-burst transition contract, per boss kind: the King's roar, MARROW's
// shield, the Choir's split, the Weaver's molt and the Warden's sanctify are ONE mechanism
// (damage reduction + hard HP floor + queued overflow) with different thresholds,
// presentation moves and add kinds. Interactive beats (`isBreakable`) track their adds in
// boss.beatAddIds and collapse early once every one of them dies.
interface BossBeatDef {
  phaseAt: readonly number[];
  phaseFloor: readonly number[];
  move: AttackMove;
  damageReduction: number;
  bulletClearRadius: number;
  addCount: number;
  isBreakable: boolean;
}

const BOSS_BEATS: Readonly<Partial<Record<Enemy["kind"], BossBeatDef>>> = {
  boss: {
    phaseAt: BOSS.phaseAt, phaseFloor: BOSS.phaseFloor, move: "roar",
    damageReduction: BOSS.roarDamageReduction, bulletClearRadius: BOSS.roarBulletClearRadius,
    addCount: BOSS.transitionAddCount, isBreakable: false,
  },
  marrow: {
    phaseAt: MARROW.phaseAt, phaseFloor: MARROW.phaseFloor, move: "shield",
    damageReduction: MARROW.shieldDamageReduction, bulletClearRadius: MARROW.shieldBulletClearRadius,
    addCount: MARROW.shieldHusks, isBreakable: true,
  },
  // The Choir's split: the boss itself is GONE (untargetable) for the beat, so its
  // reduction never applies — your damage goes into the wisps that end the beat early.
  choir: {
    phaseAt: CHOIR.phaseAt, phaseFloor: CHOIR.phaseFloor, move: "split",
    damageReduction: 1, bulletClearRadius: CHOIR.splitBulletClearRadius,
    addCount: CHOIR.splitWisps, isBreakable: true,
  },
  weaver: {
    phaseAt: WEAVER.phaseAt, phaseFloor: WEAVER.phaseFloor, move: "roar",
    damageReduction: WEAVER.moltDamageReduction, bulletClearRadius: WEAVER.moltBulletClearRadius,
    addCount: WEAVER.moltAdds, isBreakable: false,
  },
  gilded: {
    phaseAt: GILDED.phaseAt, phaseFloor: GILDED.phaseFloor, move: "roar",
    damageReduction: GILDED.sanctifyDamageReduction, bulletClearRadius: GILDED.sanctifyBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // JET (F35): King/Gilded-style fixed roar at each phase boundary (the amber-motif dead note).
  jet: {
    phaseAt: JET.phaseAt, phaseFloor: JET.phaseFloor, move: "roar",
    damageReduction: JET.roarDamageReduction, bulletClearRadius: JET.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // THE TITHE (F40): a feeder bellow at each phase boundary, no adds.
  tithe: {
    phaseAt: TITHE.phaseAt, phaseFloor: TITHE.phaseFloor, move: "roar",
    damageReduction: TITHE.roarDamageReduction, bulletClearRadius: TITHE.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // QUORUM (F45): ONE transition — the telegraphed NON-invuln merge (reduction 0, so you
  // keep hurting it through the fuse; the phase floor is the only anti-burst guard).
  quorum: {
    phaseAt: QUORUM.phaseAt, phaseFloor: QUORUM.phaseFloor, move: "merge",
    damageReduction: QUORUM.mergeDamageReduction, bulletClearRadius: QUORUM.mergeBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // GORGE (F50 giant): each phase boundary is a SHELL CRACK-OFF (roar semantics) — a big
  // punctuated screen-punch that sloughs the layer, swaps the sprite (rind → chitin → core) and
  // drops the shell as debris cover (giantShellSlough, called from checkBossTransition). No adds.
  gorge: {
    phaseAt: GORGE.phaseAt, phaseFloor: GORGE.phaseFloor, move: "roar",
    damageReduction: GORGE.roarDamageReduction, bulletClearRadius: GORGE.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  sever: {
    phaseAt: SEVER.phaseAt, phaseFloor: SEVER.phaseFloor, move: "roar",
    damageReduction: SEVER.roarDamageReduction, bulletClearRadius: SEVER.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  choirmaster: {
    phaseAt: CHOIRMASTER.phaseAt, phaseFloor: CHOIRMASTER.phaseFloor, move: "roar",
    damageReduction: CHOIRMASTER.roarDamageReduction, bulletClearRadius: CHOIRMASTER.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  undertow: {
    phaseAt: UNDERTOW.phaseAt, phaseFloor: UNDERTOW.phaseFloor, move: "roar",
    damageReduction: UNDERTOW.roarDamageReduction, bulletClearRadius: UNDERTOW.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // THE WAKE (F80): a punctuated shadow-toll at each phase boundary (roar semantics), no adds —
  // the escort convoy is the beat, not summoned chasers.
  wake: {
    phaseAt: WAKE.phaseAt, phaseFloor: WAKE.phaseFloor, move: "roar",
    damageReduction: WAKE.roarDamageReduction, bulletClearRadius: WAKE.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
  // PALE THRONE (F75 giant): the same SHELL CRACK-OFF transition as Gorge (roar semantics — a
  // punctuated screen-punch that sloughs the layer, swaps the sprite stone → cracked → core, and
  // drops the cold shell as debris cover via giantShellSlough). No adds.
  pale: {
    phaseAt: PALE.phaseAt, phaseFloor: PALE.phaseFloor, move: "roar",
    damageReduction: PALE.roarDamageReduction, bulletClearRadius: PALE.roarBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
};

function bossBeatOf(e: Enemy): BossBeatDef {
  return BOSS_BEATS[e.kind] ?? BOSS_BEATS.boss!;
}

// ---- earned windows (the deep-boss guarded/exposed contract) ----
// One mechanism, four presentations (see balance.ts EARNED WINDOWS): the boss is
// GUARDED by default — damage chips to guardMult, never immunity — and the players
// FORCE the EXPOSED window by doing the phase's mechanic. A fresh window arms a damage
// BANK (the phase chunk); once the window has removed that much it slams shut early,
// so stacked firepower converts a window harder but can never one-shot a phase. The
// Slime King (tutorial boss) and the F10 gauntlet captains (the deliberate DPS beat)
// deliberately have no entry here.
interface EarnedWindowDef {
  guardMult: number; // GUARDED damage multiplier (0.20–0.35 — reduction, never immunity)
  bankFrac: number;  // per-window damage bank as a fraction of max HP
}

const EARNED_WINDOWS: Readonly<Partial<Record<Enemy["kind"], EarnedWindowDef>>> = {
  marrow: { guardMult: MARROW.guardMult, bankFrac: MARROW.windowBankFrac },
  weaver: { guardMult: WEAVER.guardMult, bankFrac: WEAVER.windowBankFrac },
  gilded: { guardMult: GILDED.armorChip, bankFrac: GILDED.windowBankFrac },
  choir: { guardMult: CHOIR.guardMult, bankFrac: CHOIR.windowBankFrac },
  // Wave 1 deep bosses. JET's guard between salvos, the Tithe's guard while armored, and the
  // Quorum merge-form's guard between commitments all use the shared guarded/exposed plumbing.
  jet: { guardMult: JET.guardMult, bankFrac: JET.windowBankFrac },
  tithe: { guardMult: TITHE.guardMult, bankFrac: TITHE.windowBankFrac },
  quorum: { guardMult: QUORUM.guardMult, bankFrac: QUORUM.windowBankFrac },
  // GORGE (F50 giant): the shell is the wall — ZERO body damage while sealed (guardMult 0.0,
  // like the Tithe). The ONLY damage path is PEELING (destroy the weak-points → openBossWindow).
  gorge: { guardMult: GORGE.guardMult, bankFrac: GORGE.windowBankFrac },
  sever: { guardMult: SEVER.guardMult, bankFrac: SEVER.windowBankFrac },
  choirmaster: { guardMult: CHOIRMASTER.guardMult, bankFrac: CHOIRMASTER.windowBankFrac },
  undertow: { guardMult: UNDERTOW.guardMult, bankFrac: UNDERTOW.windowBankFrac },
  // CLAIMANT (F70): guarded coordination core — non-carrier fire chips at guardMult, the Owed
  // window is opened ONLY by the dedicated socket deposit after aim lock (openBossWindow).
  claimant: { guardMult: CLAIMANT.guardMult, bankFrac: CLAIMANT.windowBankFrac },
  // THE WAKE (F80): guarded shadow — fire chips at guardMult outside the light, the PROCESSION
  // window is opened ONLY by escorting the convoy across a threshold (openBossWindow).
  wake: { guardMult: WAKE.guardMult, bankFrac: WAKE.windowBankFrac },
  // PALE THRONE (F75 giant): the same hard-gate shell as Gorge (guardMult 0.0), with the region-cap
  // TIGHTER per-window bank (0.20 vs Gorge's 0.22) — the ONLY damage path is peeling the cold seams.
  pale: { guardMult: PALE.guardMult, bankFrac: PALE.windowBankFrac },
};

// ---- THE GIANT ENCOUNTER (shared core: Gorge F50 / Pale Throne F75 / — F100 Unmaker) ----
// The AD-LOCKED giant template runs ONE encounter core (updateGiant + its giant* helpers), keyed
// by a per-giant SPEC: the tuned constants block, the seam/debris kinds, the two telegraph colors
// (the ONLY material difference — Gorge warm-amber, Pale cold-blue — never touches determinism),
// and the per-giant balance functions. Every giant is byte-identical in behavior save these
// parameters, so the second giant is a spec entry, not a second 300-line encounter (and the third
// will be too). The giant's boss update dispatch, the per-phase window bank (openBossWindow) and
// the shell-slough transition (checkBossTransition) all route through GIANT_SPEC.
interface GiantSpec {
  bodyKind: EnemyKind;   // the giant boss body ("gorge" | "pale")
  seamKind: EnemyKind;   // the tectonic weak-point mechanic body ("gorge_seam" | "pale_seam")
  debrisKind: PropKind;  // the sloughed-shell cover prop ("gorge_debris" | "pale_debris")
  C: GiantConst;         // the tuned constants block (GORGE | PALE)
  ringColor: string;     // P1 ring + P2 slag-glob bullet color (material telegraph — cosmetic only)
  spokeColor: string;    // P3 spoke bullet color (material telegraph — cosmetic only)
  shellFracFor: (phase: number) => number;             // the phase's share of the pool (window bank)
  seamCountFor: (phase: number, players: number) => number; // co-op TASK scale (more seams, not HP)
  seamHpForFloor: (floor: number) => number;           // one weak-point's HP (peel-task pacing)
}

const GIANT_SPEC: Readonly<Partial<Record<EnemyKind, GiantSpec>>> = {
  // GORGE (F50): the reference giant — warm-amber slag material (the players' stolen amber).
  gorge: {
    bodyKind: "gorge", seamKind: "gorge_seam", debrisKind: "gorge_debris", C: GORGE,
    ringColor: "#ffcf6b", spokeColor: "#ffb43b",
    shellFracFor: gorgeShellFracFor, seamCountFor: gorgeSeamCountFor, seamHpForFloor: gorgeSeamHpForFloor,
  },
  // PALE THRONE (F75): the same encounter, COLD material — cold-blue seams (#57b6ff) and a
  // cold-white/blue core blaze (#bfeaff), the "blazing absence of warmth" (never amber). The
  // colors are the ONLY per-giant render difference; the sim path is Gorge's, byte-for-byte.
  pale: {
    bodyKind: "pale", seamKind: "pale_seam", debrisKind: "pale_debris", C: PALE,
    ringColor: "#57b6ff", spokeColor: "#bfeaff",
    shellFracFor: paleShellFracFor, seamCountFor: paleSeamCountFor, seamHpForFloor: paleSeamHpForFloor,
  },
};

// The active warmth-drain SIGNATURE params for a tick (resolved from the live giants). rampSec is
// the client vignette telegraph; the sim uses idle/chill/clear.
export interface WarmthDrainParams {
  readonly idleSec: number;
  readonly chillMult: number;
  readonly clearDist: number;
  readonly rampSec: number;
}

// The core-reveal shell phase (P3) — warmth-drain is P3-ONLY (the prestige "the Pale turns on you"
// finale beat), never in the P1/P2 shells.
const WARMTH_PHASE = 3;

// Resolve the warmth-drain SIGNATURE active THIS tick: if a live giant carries warmth-drain in its
// spec (Gorge has none; Pale does; F100 will) AND is in its core-reveal phase, return its params,
// else null. Pure over the enemy list (kind + boss phase) so the server (w.enemies) and the online
// client (snapshot enemies) resolve the SAME slow — the web-slow precedent (the predicted walk must
// feel the environmental slow the server applies). The phase gate keeps it P3-only in both.
export function resolveWarmthDrain(enemies: readonly { kind: EnemyKind; isDead?: boolean; phase: number }[]): WarmthDrainParams | null {
  for (const e of enemies) {
    if (e.isDead || e.phase !== WARMTH_PHASE) continue;
    const gc = GIANT_SPEC[e.kind]?.C;
    if (gc && gc.warmthDrainIdleSec !== undefined && gc.warmthDrainSlow !== undefined && gc.warmthDrainMoveClearTiles !== undefined) {
      return {
        idleSec: gc.warmthDrainIdleSec, chillMult: gc.warmthDrainSlow,
        clearDist: gc.warmthDrainMoveClearTiles * TILE, rampSec: gc.warmthDrainIdleSec,
      };
    }
  }
  return null;
}

export function resetPlayerWarmth(player: PlayerSim): void {
  player.warmthIdleSec = 0;
  player.warmthPathPx = 0;
  player.isWarmthChilled = false;
}

export function refreshWarmthDrain(w: WorldState): void {
  const next = resolveWarmthDrain(w.enemies.map((enemy) => ({
    kind: enemy.kind,
    isDead: enemy.dead,
    phase: enemy.boss?.phase ?? 0,
  })));
  if (next === null || (w.warmthDrain === null) !== (next === null)) {
    for (const player of w.players.values()) resetPlayerWarmth(player);
  }
  w.warmthDrain = next;
}

export function isBossExposed(e: Enemy): boolean {
  return e.boss !== null && e.boss.exposed > 0;
}

// Open (or extend — simultaneous mechanic completions COMBINE) the exposed window. Only
// a fresh window re-arms the bank: extending a live window buys time, never budget.
function openBossWindow(e: Enemy, seconds: number, ev: SimEvent[]): void {
  const boss = e.boss;
  const def = EARNED_WINDOWS[e.kind];
  if (!boss || !def) return;
  // GIANTS bank PER PHASE: a window caps at bankFrac × the CURRENT SHELL's HP chunk (not the whole
  // pool), so every one of their 3 phases needs ~5 windows and no phase can be one-burst regardless
  // of the pool size — the K=3 structure enforces the anti-burst without a fat pool. Every other
  // boss banks off the whole maxHp (the shipped single-pool contract).
  const giant = GIANT_SPEC[e.kind];
  if (boss.exposed <= 0) {
    boss.windowBank = giant
      ? def.bankFrac * giant.shellFracFor(boss.phase) * e.maxHp
      : def.bankFrac * e.maxHp;
  }
  boss.exposed = Math.min(boss.exposed + seconds, EXPOSE_WINDOW_CAP);
  ev.push({ t: "flash", eid: e.id });
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 1.5, gain: 0.6, trauma: 0.05 });
}

// EVERY authoritative point of enemy damage funnels through here, so a boss's phase
// thresholds are evaluated after every damage event (spec §5) — bullets, melee, burn ticks,
// arcs, thorns and barrels alike — and its transition beat can reduce/floor/queue uniformly.
// `isOverflow` marks a transition beat's queued damage being released: it already passed
// every reduction when it first landed, so it must not be chipped a second time.
function damageEnemy(
  w: WorldState,
  by: PlayerId | null,
  e: Enemy,
  dmg: number,
  ev: SimEvent[],
  isOverflow = false,
  isExecute = false,
): void {
  // QUORUM husks: damage routes to the shared pool (the core), gated by role kill-order —
  // full only against the highest-priority living husk (shield → heal → dmg); a lower one is
  // chipped, so 4P crossfire that nukes the pool evenly makes no progress. The husk's own
  // break-integrity (affixState) drains too; breaking it ends its role and snaps the tether.
  if (isQuorumHusk(e.kind)) { quorumDamageHusk(w, by, e, dmg, ev); return; }
  if (!e.boss) {
    // The elite's brace: ≤25% reduction through its 0.9s defensive slide — never immunity.
    if (!isExecute && e.attack.move === "brace" && e.attack.phase === "windup") {
      dmg *= 1 - ELITE_BRACE.damageReduction;
    }
    e.hp -= dmg;
    return;
  }
  const boss = e.boss;
  if (boss.roar) {
    // Transition beat: damage reduction (not immunity) + a hard phase floor. Damage
    // that would cross the floor is QUEUED and applies only after the beat exits.
    const reduced = dmg * (1 - bossBeatOf(e).damageReduction);
    const target = e.hp - reduced;
    if (target < boss.roar.floorHp) {
      boss.roar.queued += boss.roar.floorHp - target;
      boss.roar.queuedBy = by;
      e.hp = boss.roar.floorHp;
    } else {
      e.hp = target;
    }
    return;
  }
  // Earned windows (deep bosses): GUARDED chips the damage to guardMult; a player-forced
  // EXPOSED window takes full damage, but the window's APPLIED damage is clamped to what
  // its bank still holds (bankFrac × maxHp per window). Overflow beyond the bank is
  // DISCARDED — never carried to HP, never banked forward — so no single damage event can
  // remove more than the phase chunk (the true anti-one-shot: a stacked burst converts a
  // window, it can never delete one). The transition floor + queued overflow above is the
  // second, phase-crossing guard. Released overflow already paid its beat's reduction, so
  // it is never chipped again.
  const earned = EARNED_WINDOWS[e.kind];
  if (earned !== undefined && !isOverflow) {
    if (e.kind === "quorum" && boss.phase < 2) {
      // QUORUM P1 guard is the husk trio, not a timed window: chipped while a husk stands
      // (huskGuardUp), FULL while the trio is cleared (the pool-EXPOSED window before the
      // re-form). Not bank-clamped — the merge-form's P2 guard is the earned window.
      if (boss.huskGuardUp) dmg *= earned.guardMult;
    } else if (boss.exposed > 0) {
      const applied = Math.min(dmg, boss.windowBank);
      boss.windowBank -= applied;
      if (boss.windowBank <= 1e-9) { boss.exposed = 0; boss.windowBank = 0; }
      dmg = applied;
    } else if (e.kind === "claimant") {
      // CLAIMANT guard (PASS-THE-CLAIM): the claim-token carrier's fire CANNOT break the guard
      // (chipped far harder — a reduction, never immunity), so the team must deliberately pass to
      // a non-carrier. The Owed window itself is opened only by the socket deposit after lock.
      const enc = claimantEnc(w);
      const isCarrierShot = enc !== null && by !== null && enc.carrierPlayerId === by;
      dmg *= isCarrierShot ? CLAIMANT.carrierGuardMult : earned.guardMult;
    } else {
      dmg *= earned.guardMult;
    }
  }
  e.hp -= dmg;
  checkBossTransition(w, e, ev, by);
}

// Crossing a phase threshold starts the transition beat immediately (mid-attack included):
// the HP floors (overflow queued), nearby bullets clear, and the beat's adds spawn at
// opposite marked edges. The floor is the HARD anti-burst: even an arbitrarily large hit
// lands on the floor and its excess waits out the beat — a boss can never be deleted
// through a threshold. King: 70%/35% → floors 62%/27%, fixed 1.2s roars. MARROW: 65%/30%
// → floors 57%/22%, a shield that holds up to 2.6s but BREAKS EARLY once both husks die.
function checkBossTransition(w: WorldState, e: Enemy, ev: SimEvent[], by: PlayerId | null): void {
  const boss = e.boss;
  if (!boss || boss.roar) return;
  const def = bossBeatOf(e);
  if (boss.transitionsDone >= def.phaseAt.length) return;
  const threshold = def.phaseAt[boss.transitionsDone] * e.maxHp;
  if (e.hp > threshold) return;
  const floorHp = def.phaseFloor[boss.transitionsDone] * e.maxHp;
  const queued = Math.max(0, floorHp - e.hp);
  if (e.hp < floorHp) e.hp = floorHp;
  boss.transitionsDone++;
  boss.phase = boss.transitionsDone + 1;
  boss.attackCount = 0;
  boss.isNextRadial = true;
  boss.laneKnotId = 0; // the beat replaces any committed move — no stale blink lane
  // The phase-timer soft-enrage (R framework): a phase burned faster than burnFrac ×
  // its R-scaled budget means the party skipped the lesson — the NEXT phase carries
  // one authored extra PATTERN (never damage, never HP, never invuln).
  const phaseBudget = phaseTimerFor(PHASE_TIME_BASE[e.kind] ?? 14, w.encounterPower);
  boss.enrage = boss.phaseTime < POWER.burnFrac * phaseBudget ? 1 : 0;
  boss.phaseTime = 0;
  boss.isSurpriseSpent = false;
  if (boss.enrage === 1) {
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.7, gain: 0.8, trauma: 0.08 });
  }
  boss.roar = { floorHp, queued, queuedBy: by };
  beginWindup(e, def.move);
  // The beat's shockwave dissipates every projectile near the boss — a readable reset.
  for (const b of w.bullets) {
    if (Math.hypot(b.x - e.x, b.y - e.y) <= def.bulletClearRadius) b.life = 0;
  }
  // The beat's adds at evenly marked edges. Interactive beats (MARROW's husks, the
  // Choir's wisps) remember them: killing every one collapses the beat early.
  boss.beatAddIds.length = 0;
  // The R framework's beat-add lever: the Weaver's molt raises one extra broodling at
  // R ≥ 3.5 (a body, not a stat — the interactive beats keep their authored counts).
  const addCount = def.addCount + (e.kind === "weaver" && w.encounterPower >= 3.5 ? 1 : 0);
  const edgeAngle = w.rng.next() * Math.PI * 2;
  for (let i = 0; i < addCount; i++) {
    const add = spawnBossAdd(w, e, edgeAngle + (i / Math.max(1, addCount)) * Math.PI * 2, ev);
    if (add && def.isBreakable) boss.beatAddIds.push(add.id);
  }
  // Fair surprise §3: the Warden's sanctify RESHAPES the archive — its old shelving
  // crumbles and a fresh seeded ring of gapped, destructible cover rises while the
  // non-damaging beat plays (the roar IS the telegraph). Cover memory resets; the
  // escape never does.
  if (e.kind === "gilded") gildedReshapeCover(w, e, ev);
  // Fair surprise §3: the Choir's split beat re-tunes the HALL — its resonant pillars
  // crumble and a fresh seeded gapped ring rises (a readable route always survives), so
  // the finale reads differently each phase. Purely geometry: it never opens a window.
  if (e.kind === "choir") choirReshape(w, e, ev);
  // Fair surprise §5g B3: JET's "The Light Goes Out" — on each transition the arena degrades
  // toward corruption (P1 clean → P2 edges creep in → P3 floor mostly corrupted, safe pockets on
  // the last tiles). Pure zoning: it leaves ≥1 readable safe interior and NEVER opens a window.
  if (e.kind === "jet") jetReshape(w, e, ev);
  // GIANTS (Gorge F50 / Pale Throne F75): the phase boundary IS the SHELL CRACK-OFF (the punctuated
  // peel beat). The sloughed layer drops as debris cover at the base, any half-peeled seams crumble
  // with it, and the sprite advances (stone → cracked → core) off the new boss.phase. Pure
  // presentation + topology: it never opens/extends the earned window (only a seam set clear does).
  const giantSlough = GIANT_SPEC[e.kind];
  if (giantSlough) giantShellSlough(w, e, ev, giantSlough);
  ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: true, queued: boss.roar.queued, hpFrac: e.hp / e.maxHp });
}

// Beat over (roar elapsed / shield elapsed or broken): apply the queued overflow as a
// fresh damage event (it may immediately trigger the next transition — the double-cross
// case resolves as two full beats) and log the exit so the anti-burst gate stays observable.
function endBossTransition(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss || !boss.roar) return;
  const { queued, queuedBy } = boss.roar;
  boss.roar = null;
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: false, queued, hpFrac: e.hp / e.maxHp });
  if (queued > 0) {
    damageEnemy(w, queuedBy, e, queued, ev, true);
    if (e.hp <= 0 && !e.dead) killEnemy(w, ownerOf(w, queuedBy), e, ev);
  }
}

// The persistent-source boss budget (envelope): autonomous output (turret bolts, trap
// snaps) may take at most PERSISTENT_BOSS_DPS_FRAC of the party's practical DPS budget
// (encounterPlayers x PU_DPS) out of a boss-grade body per rolling second. Damage past
// the window's remainder is TRUNCATED — deterministically, in sim order — so parked
// sources supplement the fight without ever carrying it. Returns the damage to apply.
function drawPersistentBossBudget(w: WorldState, e: Enemy, dmg: number): number {
  const budget = PERSISTENT_BOSS_DPS_FRAC * PU_DPS * w.encounterPlayers;
  const now = w.floorHazardClock;
  let win = w.persistentBossWindows.get(e.id);
  if (!win || now - win.t >= 1) {
    win = { t: now, used: 0 };
    w.persistentBossWindows.set(e.id, win);
  }
  const allowed = Math.max(0, Math.min(dmg, budget - win.used));
  win.used += allowed;
  return allowed;
}

const STAGGER_PULSE_ICD = 0.8;
const STAGGER_PULSE_SLOW_SECONDS = 0.4;
const STAGGER_PULSE_TARGET_CAP = 4;
const STAGGER_PULSE_KB_SCALE = 0.4;
const PIKE_STAGGER_RADIUS = 40;
const MOMENTUM_ICD = 2.5;
const MOMENTUM_KB_SCALE = 1.5;

function pulseMeleeStagger(
  w: WorldState,
  p: PlayerSim,
  impact: Enemy,
  hit: StrikeInfo,
  ev: SimEvent[],
): void {
  if (hit.meleeSource === "halo" || p.mods.staggerPulseRadius <= 0 || p.staggerPulseIcdT > 0) return;
  p.staggerPulseIcdT = STAGGER_PULSE_ICD;
  p.staggerPulseAppliedTick = w.tick;
  const radius = hit.isThrust === true ? PIKE_STAGGER_RADIUS : p.mods.staggerPulseRadius;
  const targets = w.enemies
    .filter((enemy) =>
      !enemy.dead
      && enemy.hp > 0
      && !isUntargetable(enemy)
      && Math.hypot(enemy.x - impact.x, enemy.y - impact.y) <= radius
    )
    .sort((a, b) => {
      const distanceA = (a.x - impact.x) ** 2 + (a.y - impact.y) ** 2;
      const distanceB = (b.x - impact.x) ** 2 + (b.y - impact.y) ** 2;
      return distanceA - distanceB || a.id - b.id;
    })
    .slice(0, STAGGER_PULSE_TARGET_CAP);
  for (const target of targets) {
    const dirX = target.x - impact.x;
    const dirY = target.y - impact.y;
    applyKnockbackDir(
      "longsword",
      target,
      dirX === 0 && dirY === 0 ? hit.kbDirX : dirX,
      dirX === 0 && dirY === 0 ? hit.kbDirY : dirY,
      STAGGER_PULSE_KB_SCALE,
    );
    applyMeleeSlow(target, p.mods.staggerPulseSlowMult, STAGGER_PULSE_SLOW_SECONDS, w.tick);
  }
  ev.push({
    t: "blessingProc",
    pid: p.id,
    item: "stagger_pulse",
    phase: "pulse",
    x: impact.x,
    y: impact.y,
  });
}

function refreshBladeWard(w: WorldState, p: PlayerSim, hit: StrikeInfo, ev: SimEvent[]): void {
  if (hit.meleeSource === "halo" || p.mods.bladeWardAbsorb <= 0) return;
  p.bladeWardAbsorb = p.mods.bladeWardAbsorb;
  p.bladeWardT = p.mods.bladeWardWindow;
  p.bladeWardAppliedTick = w.tick;
  ev.push({
    t: "blessingProc",
    pid: p.id,
    item: "blade_ward",
    phase: "refresh",
    x: p.x,
    y: p.y,
  });
}

function isMeleeFinisherEligible(p: PlayerSim, e: Enemy, hit: StrikeInfo): boolean {
  if (!hit.isMelee || p.mods.finisherThreshold <= 0) return false;
  if (isBossKind(e.kind) || e.boss !== null || e.captainPhase !== undefined) return false;
  const threshold = e.tier === "elite"
    ? p.mods.finisherEliteThreshold
    : p.mods.finisherThreshold;
  return threshold > 0 && e.hp <= e.maxHp * threshold;
}

// `p` may be null when the striking actor has left (their projectile outlived them): damage,
// knockback (from the fire-time weapon), and baked-in statuses still land, but nothing is
// credited to any player.
function strikeEnemy(w: WorldState, p: PlayerSim | null, e: Enemy, hit: StrikeInfo, ev: SimEvent[]): void {
  // UNDERTOW flood front is an untargetable pursuit marker — never a second boss core.
  if (e.kind === "flood_front") return;
  const frozen = isFrozen(e);
  const isBossGrade = isBossKind(e.kind) || e.captainPhase !== undefined;
  // PHANTOM MARK (Wave 2): a dash-through enemy takes +vulnMult from ALL sources (this shared hit
  // path is every player's shots, so a marked boss is a team focus target). 1 when unmarked.
  const markMult = e.markT > 0 ? PHANTOM_MARK.vulnMult : 1;
  const isMomentumPayoff = p !== null
    && hit.meleeSource === "swing"
    && p.isMomentumArmed
    && p.mods.momentumDamageBonus > 0;
  const momentumDamageMult = isMomentumPayoff ? 1 + p.mods.momentumDamageBonus : 1;
  const isExecuted = p !== null && isMeleeFinisherEligible(p, e, hit);
  let dmg: number;
  if (isExecuted) {
    dmg = e.hp;
  } else if (isBossGrade) {
    // The boss vulnerability CHANNEL (balancer remediation): statuses keep their utility
    // (arc, slow, DoT) but amplify NOTHING here, and the crit multiplier AND the phantom mark
    // SHARE the BOSS_VULN_CAP — combined vulnerability ≤1.35, the mark NEVER adds on top.
    // hit.damage carries the crit multiplier baked in, so it is divided back out before
    // the capped channel applies. The fire-time pellet/weapon coefficient rides on top.
    dmg = (hit.damage * momentumDamageMult / hit.critX)
      * Math.min(BOSS_VULN_CAP, hit.critX * markMult)
      * hit.bossCoef;
    if (hit.isPersistent) {
      dmg = drawPersistentBossBudget(w, e, dmg);
      // A fully budget-capped hit lands as pressure, not damage: no zero-damage number,
      // no knockback stack — the round is simply spent against a saturated window.
      if (dmg <= 0) return;
    }
  } else {
    dmg = hit.damage * momentumDamageMult
      * (e.shock > 0 ? C.SHOCK_DMG_MULT : 1)
      * (frozen ? C.FROZEN_DMG_MULT : 1)
      * markMult;
  }
  if (isMomentumPayoff && p !== null) {
    p.isMomentumArmed = false;
    p.momentumIcdT = MOMENTUM_ICD;
    p.momentumMoveSamples = [];
    ev.push({
      t: "blessingProc",
      pid: p.id,
      item: "momentum_charge",
      phase: "payoff",
      x: e.x,
      y: e.y,
    });
  }
  damageEnemy(w, hit.ownerId, e, dmg, ev, false, isExecuted);
  // Kit hooks (ult meter charge from damage dealt, GUNNER momentum ramp, MENDER lifebloom
  // credit). Inert for the neutral baseline, so shipped combat is byte-identical.
  onKitDamageDealt(w, p, dmg);
  applyKnockbackDir(
    p ? p.weapon : hit.fxWeapon ?? "pistol",
    e,
    hit.kbDirX,
    hit.kbDirY,
    isMomentumPayoff ? MOMENTUM_KB_SCALE : 1,
  );
  applyHitStatuses(w, p, e, hit, ev);
  if (p !== null && hit.isMelee) {
    pulseMeleeStagger(w, p, e, hit, ev);
    refreshBladeWard(w, p, hit, ev);
  }
  const closeShotgun = !hit.isMelee && p !== null && p.weapon === "shotgun" && Math.hypot(p.x - e.x, p.y - e.y) < C.SHOTGUN_FREEZE_RANGE;
  const killed = e.hp <= 0 && !e.dead;
  const isCritPresentation = hit.isCrit || isExecuted;
  const puffColor = isCritPresentation ? "#fff3c4" : ENEMY_ARCHETYPES[e.kind].tint;
  ev.push({
    t: "enemyHit", eid: e.id, dmgX: e.x, dmgY: e.y - e.radius, dmg, crit: isCritPresentation,
    puffX: hit.puffX, puffY: hit.puffY, puffColor, melee: hit.isMelee, closeShotgun, killed,
  });
  if (isExecuted && p !== null) {
    ev.push({
      t: "blessingProc",
      pid: p.id,
      item: "finisher",
      phase: "execute",
      x: e.x,
      y: e.y,
    });
  }
  if (e.shock > 0) shockArc(w, p, e, ev);
  // Known by Touch: a melee hit is a reveal trigger (shared ICD; weaponSkill hits trigger
  // at their own sites). Only the owner's OWN melee reveals.
  if (p !== null && hit.isMelee && p.mods.revealRadius > 0) triggerKnownByTouch(w, p, ev);
  if (killed) killEnemy(w, p, e, ev);
}

// Summon-only fake/mechanic bodies (never kills, never loot): the echojack's echo, The
// Toll's knell, and the Weaver's lattice knots + egg-sacs.
function isDecoyKind(kind: Enemy["kind"]): boolean {
  return kind === "echo" || kind === "knell" || kind === "knot" || kind === "sac"
    // The Tithe's feeding slab is a mechanic body (like a knot): breaking it is counterplay,
    // never an economy — no loot, no combo fuel.
    || kind === "tithe_slab"
    // JET's mirror-image echo is a fake body (your own reflection): popping it early is
    // counterplay, never a kill/economy. Its concurrency is capped separately (jetEchoCap).
    || kind === "jet_echo"
    // The GIANTS' tectonic WEAK-POINTS (Gorge/Pale seams): destroying one is the peel counterplay,
    // never an economy — no loot, no combo (like the Weaver knot / the Tithe slab).
    || kind === "gorge_seam" || kind === "pale_seam"
    || kind === "sever_anchor" || kind === "choir_pillar"
    // UNDERTOW F65 mechanics: Warm Pulse / relief vents / flood front — never loot/combo.
    || kind === "warm_pulse" || kind === "relief_vent" || kind === "flood_front";
}

function isQuorumHusk(kind: Enemy["kind"]): boolean {
  return kind === "quorum_shield" || kind === "quorum_heal" || kind === "quorum_dmg";
}

// `p` null = the killing actor has left: the kill still resolves (death, loot, boss chest) but
// grants no personal reward (kills/combo/lifesteal) and never credits another live player.
function killEnemy(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  e.dead = true;
  // Decoys and mechanic bodies are plays, not kills: no credit, no combo fuel — popping
  // the echojack's echo, silencing a knell, breaking a Weaver knot or bursting a sac
  // is counterplay, never an economy.
  const isDecoy = isDecoyKind(e.kind);
  if (p && !isDecoy) {
    const previousComboTier = comboTierIndex(p.combo);
    p.kills++;
    p.combo++;
    p.comboTimer = C.COMBO_WINDOW + p.mods.comboWindowBonus;
    const nextComboTier = comboTierIndex(p.combo);
    if (p.mods.beatFireRatePerTier > 0 && nextComboTier > previousComboTier) {
      ev.push({
        t: "blessingProc", pid: p.id, item: "on_the_beat",
        phase: "tierUp", x: p.x, y: p.y,
      });
    }
    // Kill bonus to the ult meter (all kits — spec §3), share-capped. Inert for the baseline.
    accrueUlt(p, "kill", ultChargeFromKill());
  }
  const big = isBossKind(e.kind);
  ev.push({
    t: "enemyKill",
    eid: e.id,
    kind: e.kind,
    tier: e.tier,
    x: e.x,
    y: e.y,
    combo: p ? p.combo : 0,
    by: p?.id ?? "",
  });
  if (big) endBossDanger(w, e, ev);
  // The Weaver's earned-window mechanic bodies: a SHOT knot collapses its lane (P1:
  // the exposure; always loose debris). Sacs need no hook — the climb loop polls the
  // clutch and forces her down when the last one bursts.
  if (e.kind === "knot") weaverKnotBroken(w, e, ev);
  // An ARMED sinderling dies loudly: an immediate shared-risk burst — players take 1,
  // enemies take more (the fire is nobody's friend), cover splinters. Enemy kills inside
  // the burst credit the sinderling's killer (their shot lit the fuse).
  if (e.kind === "sinderling" && e.aux === 1) sinderlingBurst(w, p, e, ev);
  // Volatile elite: the delayed shared burst — death plants a visible fused charge that
  // detonates on expiry (see updateHazards). The kill itself is always safe.
  if (e.tier === "elite" && e.captainPhase === undefined && eliteAffixOf(e.kind) === "volatile") {
    w.hazards.push({
      id: w.nextHazardId++, kind: "charge", x: e.x, y: e.y,
      radius: ELITE_VOLATILE.radius, life: ELITE_VOLATILE.fuseSeconds, maxLife: ELITE_VOLATILE.fuseSeconds,
    });
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.6, gain: 0.5, trauma: 0 });
  }
  // Splits (rolled elite affix): the body cracks into fragile swarm shards along its
  // pre-cracked seams. Never off a summoned body (a shard can't cascade).
  if (e.rollAffix === "splits" && !e.isSummoned) splitOnDeath(w, e, ev);
  // Commander elite: the pack PANICS leaderless — nearby allies scatter and start
  // nothing from idle for the panic window.
  if (e.tier === "elite" && e.captainPhase === undefined && eliteAffixOf(e.kind) === "commander") {
    for (const ally of w.enemies) {
      if (ally === e || ally.dead || isBossKind(ally.kind) || ally.touchDamage <= 0) continue;
      if (Math.hypot(ally.x - e.x, ally.y - e.y) > ELITE_COMMANDER.panicRadius) continue;
      ally.panicTime = ELITE_COMMANDER.panicDuration;
      ally.surgeDelay = 0;
      ally.surgeTime = 0;
    }
    ev.push({ t: "cue", name: "elite.panic", x: e.x, y: e.y, rate: 1, gain: 0.7, trauma: 0.05 });
  }
  // Vampire Fang: one heart per proc, on a shared 1.25s cooldown, never off summoned adds —
  // sustain comes from scarcity decisions, not add-farming.
  if (p && !e.isSummoned && p.mods.lifestealChance > 0 && p.fangCd === 0
    && p.hp < p.maxHp && w.rng.next() < p.mods.lifestealChance) {
    p.hp++;
    p.fangCd = FANG_PROC_COOLDOWN;
    ev.push({ t: "heal", pid: p.id, x: e.x, y: e.y });
  }
  dropLoot(w, p, e, ev);
}

// Boss death ends danger immediately (spec §5): every remaining enemy and queued
// reinforcement despawns (no loot, no credit) and the exit opens regardless of adds.
function endBossDanger(w: WorldState, boss: Enemy, ev: SimEvent[]): void {
  w.bullets = w.bullets.filter((b) => b.friendly);
  w.pendingSpawns = [];
  // Pending ambush blooms fizzle with their summoner: death always ends the danger.
  w.hazards = w.hazards.filter((h) => h.kind !== "omen");
  for (const other of w.enemies) {
    if (other === boss || other.dead) continue;
    other.dead = true;
    ev.push({ t: "puff", x: other.x, y: other.y, n: 6, color: ENEMY_ARCHETYPES[other.kind].tint });
  }
  // Batch0: mirror arena completion onto EncounterState for HUD/wire/reconnect. Does NOT
  // replace HP-death — this runs AFTER the classic clear path empties the floor.
  if (w.encounter !== null && w.encounter.kind === "arena") {
    completeEncounter(w.encounter);
    w.encounter.flags.bossKind = boss.kind;
  }
}

// Each boss's authored chest weapon: its fight's answer, handed to you for the road.
// The King's zoning begets the Thumper; blind MARROW yields the Longshot (its own line,
// straightened into a slug); the Choir leaves a lance of light; the Weaver leaves the
// Tesla — its web of threads recast as chained arcs between bodies; the Warden gives up
// the heavy Thunderbolt its plate shrugged off.
const BOSS_SIGNATURE_WEAPON: Readonly<Partial<Record<Enemy["kind"], WeaponId>>> = {
  boss: "mortar", marrow: "railgun", choir: "beam", weaver: "tesla", gilded: "cannon",
  // Content Wave C boss-clear reward leads (Quill FINAL). Quorum hands the run's new
  // Faultlink; Jet/Tithe/Gorge hand their authored answers (Oddsmaker/Sluicegate/Breach).
  jet: "oddsmaker", tithe: "sluicegate", quorum: "faultlink", gorge: "breach",
};

// The lead weapon a boss chest bakes. Deep bosses hand their single authored signature;
// the Slime King — the run's FIRST boss, the one every player sees every run — rolls a
// seeded weighted preference over KING_REWARD_TABLE instead (mortar most likely, never
// guaranteed), keyed by (seed, floor) so it is fixed per run and identical on every
// authority regardless of when the boss dies. Exported for the variety regression tests.
export function bossChestWeaponFor(seed: number, floor: number, kind: Enemy["kind"]): WeaponId | undefined {
  if (kind !== "boss") return BOSS_SIGNATURE_WEAPON[kind];
  const rng = new Rng((seed ^ 0x4b1e9d07) + floor * 68909);
  let total = 0;
  for (const row of KING_REWARD_TABLE) total += row.weight;
  let roll = rng.next() * total;
  for (const row of KING_REWARD_TABLE) {
    roll -= row.weight;
    if (roll < 0) return row.weapon;
  }
  return BOSS_SIGNATURE_WEAPON[kind];
}

function dropLoot(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  if (isBossKind(e.kind)) {
    w.chests.push({
      id: w.nextChestId++, kind: "boss", x: e.x, y: e.y, radius: 18, opened: false,
      weapon: bossChestWeaponFor(w.seed, w.floor, e.kind),
    });
    return;
  }
  // Decoys and mechanic bodies (echo/knell, the Weaver's knots/sacs): no loot, ever.
  if (isDecoyKind(e.kind)) return;
  // A mid-band miniboss pays an authored purse (a heart + a coin handful) instead of the
  // ambient roll — the floor's beat has a guaranteed reward without a whole boss chest.
  if (isMinibossKind(e.kind)) {
    w.pickups.push(makePickup(w, "heart", e.x, e.y, ev));
    for (let i = 0; i < 3; i++) {
      w.pickups.push(makePickup(w, "coin", e.x + (i - 1) * 18, e.y + 16, ev, p ? comboCoinValue(w, p) : 1));
    }
    return;
  }
  // An unowned kill (departed actor) drops a face-value coin — no player's combo multiplier.
  // The deep-floor taper (premium economy calibration) thins the CHANCE only — values and
  // the RNG stream are untouched, so determinism and Greed's identity both hold.
  if (w.rng.next() < 0.5 * coinChanceTaper(w.floor)) w.pickups.push(makePickup(w, "coin", e.x, e.y, ev, p ? comboCoinValue(w, p) : 1));
  // Ambient hearts (§2): halved rate, party-scaled in co-op, never from summoned adds.
  if (!e.isSummoned && w.rng.next() < SUSTAIN.enemyHeartDrop * coopHeartRateMult(w.encounterPlayers)) {
    w.pickups.push(makePickup(w, "heart", e.x + 10, e.y, ev));
  }
}

// Nudge a drop point onto walkable floor. A coin/heart from an enemy that died against a
// wall (or a prop flush to one) could otherwise land inside a wall tile — visible yet
// forever uncollectible, since a player can never stand there. When the point is already on
// floor it is returned untouched (drops that were fine stay bit-identical); otherwise the
// nearest walkable tile center wins, scanning outward in square shells with a deterministic
// geometric tie-break. Pure (no RNG) so the server and every replaying client agree.
export function nudgePickupToWalkable(w: WorldState, x: number, y: number): { x: number; y: number } {
  if (!isWall(w, x, y)) return { x, y };
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  for (let r = 1; r <= 8; r++) {
    let bestX = 0, bestY = 0, bestD = Infinity, found = false;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue; // only the new shell
        const nx = tx + ox, ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= w.dungeon.w || ny >= w.dungeon.h) continue;
        if (w.dungeon.tiles[ny * w.dungeon.w + nx] === 1) continue;
        const cx = (nx + 0.5) * TILE, cy = (ny + 0.5) * TILE;
        const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (d < bestD) { bestD = d; bestX = cx; bestY = cy; found = true; }
      }
    }
    if (found) return { x: bestX, y: bestY };
  }
  return { x, y };
}

function makePickup(w: WorldState, kind: "heart" | "coin", x: number, y: number, ev: SimEvent[], value?: number): Pickup {
  const spot = nudgePickupToWalkable(w, x, y);
  const color = kind === "heart" ? "#ff6a6a" : "#ffd27a";
  ev.push({ t: "lootDrop", x: spot.x, y: spot.y, color });
  if (kind === "heart") w.heartsThisFloor++;
  return { id: w.nextPickupId++, kind, x: spot.x, y: spot.y, radius: 13, weapon: null, value };
}

// ---- per-tick systems ----

function updatePlayer(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  let ix = input.moveX;
  let iy = input.moveY;
  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;
  if (ix !== 0) p.facing = ix > 0 ? 1 : -1;

  // Webs slow the WALK only — the dash (below) rips through at full speed, so a snared
  // player always has an out; it just costs the dash. Holding a Breach charge slows the
  // same way (the exposure IS the tradeoff); the dash still rips free at full speed.
  const chargeSlow = p.chargeT > 0 ? WEAPONS[p.weapon].charge?.slow ?? 1 : 1;
  // PHASE speed surge (spec §2.4): a temporary ~1.4x move for the caster + nearby allies (any
  // kit). A fixed multiplier layered over the walk; the base 1.35x move cap governs the STATIC
  // build.
  const phaseSurge = p.phaseSpeed > 0 ? PHASE.speedMult : 1;
  // PALE THRONE warmth-drain: standing still too long CHILLS the WALK (never the dash — always an
  // out, like the web slow). A per-player, tick-based idle timer, cleared by moving warmthClearDist.
  // 1 (a no-op) whenever no warmth-drain giant is live, so every other floor is byte-identical.
  const isMoveIntentActive = input.moveX * input.moveX + input.moveY * input.moveY > 0.01;
  const warmthMult = warmthDrainMult(w, p, isMoveIntentActive, dt, ev);
  // PVP WAVE 3 arena_triage cleanse: a brief slow-immunity window drops the positional tar/move
  // slow (which is re-derived every tick, so the cleanse is an immunity window, never a lasting buff).
  const slowMult = p.arenaUlt.slowImmuneT > 0 ? 1 : hazardMoveSlowMult(w, p.x, p.y);
  const speed = PLAYER.moveSpeed * p.mods.moveSpeedMult * slowMult * chargeSlow * phaseSurge * warmthMult;
  // Snap accumulated float dust to zero so a cooldown that is an exact multiple of the
  // tick (Second Wind Lv3: 0.35s at 60Hz) recovers on its true tick, not one late.
  p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.dashCd < 1e-9) p.dashCd = 0;
  // Dash charges (the premium Echo Step core): the cooldown is a BANK — a dash is legal
  // while at least one full cooldown of headroom remains, and each dash ADDS a cooldown
  // rather than setting it. With zero extra charges the bank is one cooldown deep and
  // the condition collapses to the classic `dashCd === 0`, bit-for-bit.
  // Thin Air (floor mutator, DASH TUNING): a longer/faster/quicker-recovering dash, read from
  // the frozen descriptor — a per-floor constant, so the server sim and the client's prediction
  // (which holds the identical descriptor) apply it in lockstep; identity when the mutator is off.
  const dashProfile = floorDashProfile(w.floorDescriptor.mutators);
  const dashBankHeadroom = dashCooldown(p) * dashProfile.cdMult * p.mods.extraDashCharge;
  if (input.dash && p.dashCd <= dashBankHeadroom && p.dashTime <= 0 && (ix || iy)) {
    const dashCdAdded = dashCooldown(p) * dashProfile.cdMult;
    p.dashTime = PLAYER.dashActive * dashProfile.activeMult; p.dashCd += dashCdAdded; p.dashDx = ix; p.dashDy = iy;
    p.isMuddyRefundSpent = false;
    // The dash iframe is its own window (0.18s, covering the 0.16s active dash + tail):
    // SET, never max'd against post-hit protection, so the two can neither refresh nor
    // extend each other.
    p.dashInvuln = PLAYER.dashIframe;
    // PHANTOM MARK (Wave 2): resolve the dash-through mark + cooldown refund ONCE at dash start,
    // swept along the projected dash path — naturally once-per-dash (never a per-tick double
    // refund), and the mark applies the instant the phantom commits.
    if (p.kitId === "phantom") {
      phantomDashMark(w, p, PLAYER.dashSpeed * dashProfile.speedMult * p.dashTime, dashCdAdded);
    }
    cancelReviveChannelBy(w, p.id); // gate §6: the reviver's dash cancels their channel
    // PHANTOM charges its ult off dashes performed (spec §2.4) — credited AUTHORITATIVELY in
    // updateUlts off this dashStart event, never here (the player phase runs in client
    // prediction too, and the meter must stay server-owned).
    ev.push({ t: "dashStart", pid: p.id, x: p.x, y: p.y });
  }
  const isDashMovement = p.dashTime > 0;
  let mvx: number, mvy: number;
  if (p.dashTime > 0) {
    p.dashTime -= dt;
    mvx = p.dashDx * PLAYER.dashSpeed * dashProfile.speedMult * dt; mvy = p.dashDy * PLAYER.dashSpeed * dashProfile.speedMult * dt;
    ev.push({ t: "dashTrail", pid: p.id, x: p.x, y: p.y });
    if (p.dashTime <= 0) onDashEnd(w, p, ev); // Known by Touch reveal + Carry the Light solo
  } else {
    mvx = ix * speed * dt; mvy = iy * speed * dt;
  }
  const selfMoveX = p.x;
  const selfMoveY = p.y;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, mvx, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, mvy);
  const playerMoveDistance = Math.hypot(p.x - selfMoveX, p.y - selfMoveY);
  // PVP WAVE 2 · cinder_gust: an active gust adds a soft positional drift through the SAME
  // wall/prop-aware collision (never a teleport). Gated to pvp + a live active gust + the mid band,
  // and sheltered by upwind cover — a no-op everywhere else. A drift into a pit rings the body out
  // on Wave 1's env-kill credit window (the gust is ownerless, so it never steals a set-up frag).
  applyPvpGustDrift(w, p, dt);
  recordWarmthPath(w, p, isMoveIntentActive, Math.hypot(p.x - selfMoveX, p.y - selfMoveY), ev);
  recordMomentumMovement(w, p, isDashMovement ? 0 : playerMoveDistance, ev);
  if (p.dashTime > 0 && w.props.length > 0) dashBreakProps(w, p, ev);
  // Sticky silk yields to the dash: every web the dash crosses is CLEARED — the dash
  // itself is the cost (designer contract), and a cleared lane is exactly the P3 bait.
  if (p.dashTime > 0 && w.hazards.length > 0) dashClearSilk(w, p, ev);
  p.invuln = Math.max(0, p.invuln - dt);
  p.dashInvuln = Math.max(0, p.dashInvuln - dt);
}

function isPvpSpawnAttackSuppressed(w: WorldState, p: PlayerSim): boolean {
  return isPvp(w) && (p.spawnGraceT > 0 || p.isSpawnOffenseLatched);
}

function updatePvpSpawnOffenseLatch(
  w: WorldState,
  p: PlayerSim,
  input: InputCmd,
  ev: SimEvent[],
): void {
  if (!isPvp(w) || w.match?.phase !== "live") return;
  const isOffenseHeld = input.firing || input.ult === true || input.pulse === true;
  if (p.spawnGraceT > 0) {
    if (isOffenseHeld) {
      if (!p.isSpawnOffenseLatched && p.spawnBlockedFeedbackCdT === 0) {
        ev.push({ t: "pvpSpawnAttackBlocked", pid: p.id, x: p.x, y: p.y });
        p.spawnBlockedFeedbackCdT = 6;
      }
      p.isSpawnOffenseLatched = true;
    } else {
      p.isSpawnOffenseLatched = false;
    }
    return;
  }
  if (p.isSpawnOffenseLatched && !isOffenseHeld) p.isSpawnOffenseLatched = false;
}

function breakPvpSpawnShield(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  if (p.spawnGraceT > 0 || p.spawnShieldT <= 0) return;
  p.spawnShieldT = 0;
  p.spawnShieldEndsAtTick = w.tick;
  if (p.pvpRespawnTelemetry !== null) {
    p.pvpRespawnTelemetry.shieldBreakMs = Math.max(
      0,
      Math.round(p.pvpRespawnTelemetry.activeTicks * 1000 / TICKS_PER_SECOND),
    );
    p.pvpRespawnTelemetry.isShieldBrokenByAttack = true;
  }
  ev.push({ t: "pvpShieldBreak", pid: p.id, x: p.x, y: p.y });
}

function commitPvpOutgoingAttack(w: WorldState, p: PlayerSim, ev: SimEvent[]): boolean {
  if (!isPvp(w)) return true;
  if (p.spawnGraceT > 0) return false;
  breakPvpSpawnShield(w, p, ev);
  return true;
}

function advanceWeaponCycle(p: PlayerSim, weapon: WeaponId): void {
  if (weapon === "sluicegate") p.weaponCycles.sluicegate = (p.weaponCycles.sluicegate + 1) % 0x10000000;
  if (weapon === "oddsmaker") p.weaponCycles.oddsmaker = (p.weaponCycles.oddsmaker + 1) % 0x10000000;
}

function applyWeaponKick(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const kb = C.FIRE_KNOCKBACK[p.weapon] * p.mods.selfKnockbackMult;
  if (kb === 0) return;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, -Math.cos(p.aimAngle) * kb, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, -Math.sin(p.aimAngle) * kb);
  if (p.mods.selfKnockbackMult < 1) {
    ev.push({ t: "blessingProc", pid: p.id, item: "hold_fast", phase: "stabilized", x: p.x, y: p.y });
  }
}

// ===================== Content Wave B: verbs, blessings, safety =====================

function findEnemyById(w: WorldState, id: number): Enemy | null {
  for (const e of w.enemies) if (e.id === id && !e.dead) return e;
  return null;
}

// Nearest OTHER live, targetable enemy in LOS within range — the fork's link neighbour.
function nearestOtherEnemyInLos(
  w: WorldState, fromX: number, fromY: number, excludeId: number, maxRange: number,
): Enemy | null {
  let best: Enemy | null = null;
  let bestD = maxRange * maxRange;
  for (const e of w.enemies) {
    if (e.dead || e.id === excludeId || isUntargetable(e)) continue;
    const d = (e.x - fromX) ** 2 + (e.y - fromY) ** 2;
    if (d >= bestD) continue;
    if (!hasLineOfSight(w, fromX, fromY, e.x, e.y)) continue;
    best = e; bestD = d;
  }
  return best;
}

// The shared secondary-proc clamp (≤4/s/player/target). Returns true when the proc is
// admitted; overflow is discarded.
function admitWaveBProc(w: WorldState, ownerId: PlayerId | null, targetId: number, system: string): boolean {
  return w.procWindow.admit(procKey(ownerId, targetId, system), w.waveBClock);
}

// The enemy the player is aiming at (smallest angular error, in front, within range).
function aimedEnemy(w: WorldState, p: PlayerSim, maxRange = 640): Enemy | null {
  let best: Enemy | null = null;
  let bestErr = 0.42; // ~24° cone
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d > maxRange) continue;
    let err = Math.abs(normalizeAngle(Math.atan2(e.y - p.y, e.x - p.x) - p.aimAngle));
    if (err > bestErr) continue;
    // Prefer the tighter angle; break ties toward the nearer body.
    if (best === null || err < bestErr) { best = e; bestErr = err; }
  }
  return best;
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function isBossGradeKind(e: Enemy): boolean {
  return isBossKind(e.kind) || e.captainPhase !== undefined || isMinibossKind(e.kind);
}

// Per-tick Wave B timers + the resonant-fork link damage.
function tickWaveBSystems(w: WorldState, p: PlayerSim, dt: number, ev: SimEvent[]): void {
  if (p.sidewinderArcT > 0) {
    p.sidewinderArcT -= dt;
    if (p.sidewinderArcT <= 0) {
      p.sidewinderArcT = 0;
      spawnSidewinderArc(w, p, 1, p.sidewinderArcAim);
    }
  }
  if (p.penSkillCd > 0) p.penSkillCd = p.penSkillCd > dt ? p.penSkillCd - dt : 0;
  if (p.penInputLock > 0) p.penInputLock = p.penInputLock > dt ? p.penInputLock - dt : 0;
  if (p.revealIcdT > 0) p.revealIcdT = p.revealIcdT > dt ? p.revealIcdT - dt : 0;
  if (p.lightSoloDashIcd > 0) p.lightSoloDashIcd = p.lightSoloDashIcd > dt ? p.lightSoloDashIcd - dt : 0;
  if (p.marginStore !== null) {
    p.marginStore.life -= dt;
    if (p.marginStore.life <= 0) p.marginStore = null;
  }
  for (const [eid, mark] of p.penMarks) {
    mark.life -= dt;
    if (mark.life <= 0) p.penMarks.delete(eid);
  }
  if (p.disabledBlessing !== null) {
    p.disabledBlessing.life -= dt;
    if (p.disabledBlessing.life <= 0) {
      p.disabledBlessing = null;
      recomputeMods(p.mods, activeItemIdsFor(p));
      applyMaxHpBonus(p);
    }
  }
  tickForkLink(w, p, dt, ev);
}

// The owned blessing ids currently CONTRIBUTING mods (Remember Me mutes one on a save).
function activeItemIdsFor(p: PlayerSim): string[] {
  if (p.disabledBlessing === null) return p.ownedItemIds;
  const muted = p.disabledBlessing.id;
  return p.ownedItemIds.filter((id) => id !== muted);
}

// Resonant Fork: open/refresh the owner's single tune link from a struck body to a
// nearest neighbour in LOS. One link per owner (a fresh hit retargets it).
function openForkLink(w: WorldState, p: PlayerSim, struck: Enemy): void {
  const spec = WEAPONS.resonant_fork.resonate;
  if (spec === undefined) return;
  const neighbour = nearestOtherEnemyInLos(w, struck.x, struck.y, struck.id, spec.range);
  if (neighbour === null) return;
  p.forkLink = { srcEid: struck.id, targetEid: neighbour.id, life: spec.duration, tickT: spec.tick };
}

function tickForkLink(w: WorldState, p: PlayerSim, dt: number, ev: SimEvent[]): void {
  const link = p.forkLink;
  if (link === null) return;
  const spec = WEAPONS.resonant_fork.resonate!;
  link.life -= dt;
  if (link.life <= 0) { p.forkLink = null; return; }
  const src = findEnemyById(w, link.srcEid);
  const target = findEnemyById(w, link.targetEid);
  if (src === null || target === null
    || Math.hypot(src.x - target.x, src.y - target.y) > spec.range
    || !hasLineOfSight(w, src.x, src.y, target.x, target.y)) {
    p.forkLink = null;
    return;
  }
  link.tickT -= dt;
  while (link.tickT <= 0) {
    link.tickT += spec.tick;
    // ≤4/s/player/target hard clamp — overflow ticks are discarded, never queued.
    if (!admitWaveBProc(w, p.id, target.id, "fork")) continue;
    const dir = Math.atan2(target.y - src.y, target.x - src.x);
    strikeEnemy(w, p, target, {
      damage: spec.tickDamage, isCrit: false, critX: 1,
      bossCoef: WEAPON_BOSS_COEF.resonant_fork ?? 0.7,
      puffX: target.x, puffY: target.y, kbDirX: Math.cos(dir), kbDirY: Math.sin(dir),
      isMelee: false, ownerId: p.id, fxWeapon: "resonant_fork",
    }, ev);
  }
}

// Red Pen — SET / REWRITE. Firing at a marked, cooldown-ready target consumes the mark
// for a burst (the logical trigger); otherwise a normal ink round is fired (it marks on
// hit). A snap attempt that cannot land fails closed: no damage, no cooldown, input lock.
function fireRedPen(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  if (p.penInputLock > 0) return;
  const spec = wep.rewrite!;
  const aimed = aimedEnemy(w, p);
  const mark = aimed !== null ? p.penMarks.get(aimed.id) : undefined;
  if (aimed !== null && mark !== undefined && mark.life > 0 && p.penSkillCd <= 0) {
    const guarded = isBossGradeKind(aimed) && !isBossExposed(aimed);
    if (aimed.dead || isUntargetable(aimed) || guarded
      || !hasLineOfSight(w, p.x, p.y, aimed.x, aimed.y)) {
      p.penInputLock = 0.15; // fail-closed: no damage, no cooldown consumed
      return;
    }
    const warm = p.mods.warmRoundBonus > 0 ? 1 + p.mods.warmRoundBonus : 1; // snap = cycle-final
    const dmg = spec.snapCoef * mark.lastInkDmg * warm;
    const dir = Math.atan2(aimed.y - p.y, aimed.x - p.x);
    strikeEnemy(w, p, aimed, {
      damage: dmg, isCrit: false, critX: 1, bossCoef: 0.65,
      puffX: aimed.x, puffY: aimed.y, kbDirX: Math.cos(dir), kbDirY: Math.sin(dir),
      isMelee: false, ownerId: p.id, fxWeapon: "red_pen",
    }, ev);
    p.penMarks.delete(aimed.id);
    p.penSkillCd = spec.skillCd;
    if (p.mods.revealRadius > 0) triggerKnownByTouch(w, p, ev); // snap = a weaponSkill hit
    setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
    p.shotSeq++;
    ev.push({
      t: "shot", pid: p.id, weapon: "red_pen", x: aimed.x, y: aimed.y, aim: p.aimAngle,
      px: p.x, py: p.y, chg: 0, mode: "none", outcome: "none",
    });
    applyWeaponKick(w, p, ev);
    return;
  }
  // Normal ink: fire a marking round.
  const shot = resolveShot(w, p, "red_pen");
  const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
  const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
  for (const b of fire(shot, muzzleX, muzzleY, p.aimAngle, w.rng, p.id)) {
    b.isPenInk = true;
    b.bornTick = w.tick;
    b.lagRewind = p.rewindTicks;
    w.bullets.push(b);
  }
  captureMarginStore(p, wep, shot);
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({
    t: "shot", pid: p.id, weapon: "red_pen", x: muzzleX, y: muzzleY, aim: p.aimAngle,
    px: p.x, py: p.y, chg: 0, mode: "none", outcome: "none",
  });
  applyWeaponKick(w, p, ev);
}

// Margin Call — COPY-ONE. A stored payload echoes at a discount; empty, it fires a stub.
function fireMarginCall(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const spec = wep.margin!;
  const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
  const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
  const store = p.marginStore;
  if (store !== null && store.life > 0) {
    spawnMarginCopies(w, p, spec, store, muzzleX, muzzleY);
    setActiveWeaponFireCooldown(p, spec.loadedFireCd / currentFireRate(p));
  } else {
    const shot = resolveShot(w, p, "margin_call"); // base damage 1.2 == stub damage
    for (const b of fire(shot, muzzleX, muzzleY, p.aimAngle, w.rng, p.id)) {
      b.bornTick = w.tick;
      b.lagRewind = p.rewindTicks;
      w.bullets.push(b);
    }
    setActiveWeaponFireCooldown(p, spec.stubFireCd / currentFireRate(p));
  }
  p.shotSeq++;
  ev.push({
    t: "shot", pid: p.id, weapon: "margin_call", x: muzzleX, y: muzzleY, aim: p.aimAngle,
    px: p.x, py: p.y, chg: 0, mode: "none", outcome: "none",
  });
  applyWeaponKick(w, p, ev);
}

function spawnMarginCopies(
  w: WorldState, p: PlayerSim, spec: NonNullable<Weapon["margin"]>,
  store: MarginStore, muzzleX: number, muzzleY: number,
): void {
  const pellets = store.category === "spread"
    ? Math.min(spec.maxCopyPellets, Math.min(3, store.pellets))
    : Math.min(spec.maxCopyPellets, store.pellets);
  const spread = store.category === "spread" ? Math.min(0.55, store.spread) : store.spread;
  const pierce = store.category === "pierce" ? Math.min(2, store.pierce) : Math.min(4, store.pierce);
  const blast = store.category === "blast" ? store.blast * 0.70 : undefined;
  const homing = store.category === "seeker" ? store.homing * 0.60 : undefined;
  const statusMult = store.category === "status" ? 0.70 : 0;
  const dmg = store.damage * spec.outputCoef;
  for (let i = 0; i < Math.max(1, pellets); i++) {
    const t = pellets <= 1 ? 0 : (i / (pellets - 1)) - 0.5;
    const a = p.aimAngle + t * spread;
    const isCrit = p.mods.critChance > 0 && w.rng.next() < p.mods.critChance;
    const b: Bullet = {
      x: muzzleX, y: muzzleY,
      vx: Math.cos(a) * WEAPONS.margin_call.speed * p.mods.bulletSpeedMult,
      vy: Math.sin(a) * WEAPONS.margin_call.speed * p.mods.bulletSpeedMult,
      radius: WEAPONS.margin_call.bulletRadius * p.mods.bulletSizeMult,
      life: WEAPONS.margin_call.life * p.mods.bulletLifeMult,
      friendly: true, owner: p.id,
      damage: isCrit ? dmg * p.mods.critMult : dmg,
      color: store.color, pierce, hitList: null, isCrit, enemyHits: 0,
      critX: isCrit ? p.mods.critMult : 1, bossCoef: 0.60, fx: "margin_call",
      isMarginCopy: true,
      blast, homing,
      burn: statusMult > 0 && store.burn > 0 ? store.burn * statusMult : undefined,
      chill: statusMult > 0 && store.chill > 0 ? store.chill * statusMult : undefined,
      shock: statusMult > 0 && store.shock > 0 ? store.shock * statusMult : undefined,
      bornTick: w.tick, lagRewind: p.rewindTicks,
    };
    applyCrosscurrentStamp(p, b);
    w.bullets.push(b);
  }
}

// Store exactly one payload CLASS off a committed shot from another owned weapon.
// Odds×Margin combo tax (Quill/Rook): Oddsmaker's gamble is NEVER storeable — fail-closed
// to Margin Call's empty stub (stubDamage/stubFireCd). Do not invent a second 50% tax;
// the stub path IS the authored combo tax.
function captureMarginStore(p: PlayerSim, wep: Weapon, spec: ShotSpec): void {
  if (wep.id === "margin_call" || !p.ownedWeapons.includes("margin_call")) return;
  const category = marginCategoryOf(wep, spec);
  if (category === null) return;
  p.marginStore = {
    category,
    damage: spec.damage,
    pellets: spec.pellets,
    pierce: spec.pierce,
    blast: spec.blast ?? wep.blast ?? 0,
    homing: spec.homing ?? wep.homing ?? 0,
    burn: spec.burn ?? 0,
    chill: spec.chill ?? 0,
    shock: spec.shock ?? 0,
    spread: spec.spread,
    color: spec.color,
    life: WEAPONS.margin_call.margin!.ttl,
  };
}

function marginCategoryOf(wep: Weapon, spec: ShotSpec): MarginCategory | null {
  if (wep.gamble !== undefined) return null; // gamble payloads are never storeable
  if ((wep.blast ?? spec.blast ?? 0) > 0) return "blast";
  if ((wep.homing ?? 0) > 0) return "seeker";
  if ((wep.burn ?? 0) > 0 || (wep.chill ?? 0) > 0 || (wep.shock ?? 0) > 0
    || (spec.burn ?? 0) > 0 || (spec.chill ?? 0) > 0 || (spec.shock ?? 0) > 0) return "status";
  if ((wep.basePierce ?? 0) > 0) return "pierce";
  if (wep.pellets > 1) return "spread";
  return "slug";
}

// Sidewinder — ENCIRCLE / FLANK. A fixed two-arc volley; extra-pellet mods never add arcs.
function fireSidewinder(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  spawnSidewinderArc(w, p, 0, p.aimAngle);
  p.sidewinderArcT = wep.sidewinder!.arcDelay;
  p.sidewinderArcAim = p.aimAngle;
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({
    t: "shot", pid: p.id, weapon: "sidewinder", x: p.x + Math.cos(p.aimAngle) * 18,
    y: p.y + Math.sin(p.aimAngle) * 18, aim: p.aimAngle,
    px: p.x, py: p.y, chg: 0, mode: "none", outcome: "none",
  });
  applyWeaponKick(w, p, ev);
}

function spawnSidewinderArc(w: WorldState, p: PlayerSim, index: number, aim: number): void {
  const wep = WEAPONS.sidewinder;
  const spec = wep.sidewinder!;
  const sign = index === 0 ? 1 : -1;
  const launch = aim + sign * 0.30; // bias to the flank side
  const speed = 420 * p.mods.bulletSpeedMult;
  const dmg = spec.arcDamage * currentDamageMult(p);
  const isCrit = p.mods.critChance > 0 && w.rng.next() < p.mods.critChance;
  const muzzleX = p.x + Math.cos(aim) * 18;
  const muzzleY = p.y + Math.sin(aim) * 18;
  const b: Bullet = {
    x: muzzleX, y: muzzleY,
    vx: Math.cos(launch) * speed, vy: Math.sin(launch) * speed,
    radius: wep.bulletRadius * p.mods.bulletSizeMult,
    life: spec.arcLife * p.mods.bulletLifeMult,
    friendly: true, owner: p.id,
    damage: isCrit ? dmg * p.mods.critMult : dmg,
    color: wep.color, pierce: Math.min(4, (wep.basePierce ?? 0) + p.mods.pierce), hitList: null,
    isCrit, enemyHits: 0, critX: isCrit ? p.mods.critMult : 1, bossCoef: 0.55, fx: "sidewinder",
    sidewinderArc: index, sidewinderTurn: sign * spec.turn, sidewinderAim: aim,
    bornTick: w.tick, lagRewind: p.rewindTicks,
  };
  applyCrosscurrentStamp(p, b);
  w.bullets.push(b);
}

// Crosscurrent rides the custom-fire Wave B rounds too (it stamps every round the player
// fires); the generic fire() path already reads these off the ShotSpec.
function applyCrosscurrentStamp(p: PlayerSim, b: Bullet): void {
  if (p.mods.crosscurrentChain <= 0) return;
  b.crosscurrentJumps = p.mods.crosscurrentChain;
  b.crosscurrentRange = p.mods.crosscurrentJumpRange;
  b.crosscurrentCoef = p.mods.crosscurrentJumpCoef;
  b.crosscurrentPreferNew = p.mods.crosscurrentPreferNew > 0;
  b.crosscurrentTax = 1;
}

// Crosscurrent chain jump: on a bullet's enemy hit, arc bounded damage to nearby bodies
// the round has not already hit (proc-clamped; excess jumps discarded).
function crosscurrentJump(w: WorldState, p: PlayerSim | null, b: Bullet, from: Enemy, ev: SimEvent[]): void {
  const jumps = b.crosscurrentJumps ?? 0;
  if (jumps <= 0) return;
  const range = b.crosscurrentRange ?? 140;
  const coef = (b.crosscurrentCoef ?? 0.55) * (b.crosscurrentTax ?? 1);
  const hit = (b.hitList ??= []);
  let remaining = jumps;
  let fromX = from.x, fromY = from.y;
  let prevDmg = b.damage;
  while (remaining > 0) {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of w.enemies) {
      if (e.dead || e.id === from.id || isUntargetable(e) || hit.indexOf(e) !== -1) continue;
      const d = (e.x - fromX) ** 2 + (e.y - fromY) ** 2;
      if (d < bestD) { best = e; bestD = d; }
    }
    if (best === null) break;
    remaining--;
    hit.push(best);
    if (b.owner !== null && !admitWaveBProc(w, b.owner, best.id, "crosscurrent")) continue;
    const dmg = prevDmg * coef;
    const dir = Math.atan2(best.y - fromY, best.x - fromX);
    strikeEnemy(w, p, best, {
      damage: dmg, isCrit: false, critX: 1, bossCoef: b.bossCoef ?? 1,
      puffX: best.x, puffY: best.y, kbDirX: Math.cos(dir), kbDirY: Math.sin(dir),
      isMelee: false, ownerId: b.owner, fxWeapon: b.fx ?? null,
    }, ev);
    fromX = best.x; fromY = best.y;
    prevDmg = dmg;
  }
}

// Support blessings (never disabled by Remember Me): the two revive/objective supports.
const SUPPORT_BLESSING_IDS = new Set<string>(["shared_rope", "carry_the_light"]);
const RARITY_RANK: Readonly<Record<string, number>> = { rare: 3, uncommon: 2, common: 1 };

// Remember Me's disable target: the owner's highest-rarity NON-support, non-premium, non-self
// blessing (Rare > Uncommon > Common; tie -> lowest id). null when nothing is eligible.
function rememberMeDisableTarget(p: PlayerSim): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const id of new Set(p.ownedItemIds)) {
    if (id === "remember_me" || SUPPORT_BLESSING_IDS.has(id)) continue;
    const def = itemById(id);
    if (def === undefined || def.isPremiumOnly === true) continue;
    const rank = RARITY_RANK[def.rarity] ?? 0;
    if (rank > bestRank || (rank === bestRank && best !== null && id < best)) {
      best = id; bestRank = rank;
    }
  }
  return best;
}

// Dash end: fires the Known by Touch reveal and the Carry the Light SOLO dash-restore.
function onDashEnd(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  armMomentumCharge(p, ev);
  triggerKnownByTouch(w, p, ev);
  if (w.players.size === 1 && p.mods.lightSoloDashRestore > 0 && p.lightSoloDashIcd <= 0) {
    const maxCd = WEAPONS[p.weapon].fireCd;
    const restore = maxCd * p.mods.lightSoloDashRestore;
    setActiveWeaponFireCooldown(p, Math.max(0, p.fireCd - restore));
    p.lightSoloDashIcd = 5;
    ev.push({ t: "blessingProc", pid: p.id, item: "carry_the_light", phase: "solo", x: p.x, y: p.y });
  }
}

function armMomentumCharge(p: PlayerSim, ev: SimEvent[]): void {
  if (p.mods.momentumDamageBonus <= 0 || p.isMomentumArmed || p.momentumIcdT > 0) return;
  p.isMomentumArmed = true;
  p.momentumMoveSamples = [];
  ev.push({
    t: "blessingProc",
    pid: p.id,
    item: "momentum_charge",
    phase: "armed",
    x: p.x,
    y: p.y,
  });
}

function recordMomentumMovement(
  w: WorldState,
  p: PlayerSim,
  distance: number,
  ev: SimEvent[],
): void {
  if (p.mods.momentumDamageBonus <= 0 || p.isMomentumArmed || p.momentumIcdT > 0) {
    p.momentumMoveSamples = [];
    return;
  }
  const cutoff = w.waveBClock - 1;
  p.momentumMoveSamples = p.momentumMoveSamples.filter((sample) => sample.at > cutoff);
  if (distance > 0) p.momentumMoveSamples.push({ at: w.waveBClock, distance });
  const moved = p.momentumMoveSamples.reduce((total, sample) => total + sample.distance, 0);
  if (moved >= 200) armMomentumCharge(p, ev);
}

// Known by Touch: a dash-end or a melee/skill hit reveals hidden bodies within radius.
function triggerKnownByTouch(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  if (p.mods.revealRadius <= 0 || p.revealIcdT > 0) return;
  p.revealIcdT = p.mods.revealIcd;
  const r2 = p.mods.revealRadius * p.mods.revealRadius;
  let revealed = false;
  for (const e of w.enemies) {
    if (e.dead) continue;
    if ((e.x - p.x) ** 2 + (e.y - p.y) ** 2 > r2) continue;
    e.revealT = Math.max(e.revealT, p.mods.revealDur);
    revealed = true;
  }
  if (revealed) {
    ev.push({ t: "blessingProc", pid: p.id, item: "known_by_touch", phase: "revealed", x: p.x, y: p.y });
  }
}

// ===================== Content Wave C: verbs + safety (guns-only) =====================

// Every Wave C verb is server-owned TRANSIENT combat state (sub-10s), rebuilt from live
// inputs after a resume. This is the single reset the floor build + run reset call.
function resetWaveCState(p: PlayerSim): void {
  p.hushStacks = 0; p.hushStillT = 0; p.hushStackT = 0; p.hushVentT = 0;
  p.backtalkHoldT = 0; p.backtalkWindowT = 0; p.backtalkCd = 0;
  p.backtalkReturnT = 0; p.backtalkCaughtDmg = 0; p.backtalkLock = 0;
  p.lampPatches = [];
  p.faultMark = null; p.faultLink = null;
}

// Per-tick Wave C timers + verbs (hushiron stance, backtalk parry, lamp patches, fault link).
function tickWaveCSystems(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  tickHushStance(p, input, dt);
  tickBacktalk(w, p, input, dt, ev);
  tickLampPatches(p, dt);
  tickFaultlink(w, p, dt);
}

// Hushiron — ROOT / RAMP. Standing still ramps stance stacks (accuracy + pass-through, NEVER
// damage); movement vents them one at a time; a dash rips them all out at once.
function tickHushStance(p: PlayerSim, input: InputCmd, dt: number): void {
  const s = WEAPONS.hushiron.stance;
  if (s === undefined || p.weapon !== "hushiron") return;
  if (p.dashTime > 0) {
    p.hushStacks = 0; p.hushStillT = 0; p.hushStackT = 0; p.hushVentT = 0;
    return;
  }
  const isMoving = input.moveX * input.moveX + input.moveY * input.moveY > 0.01;
  if (isMoving) {
    p.hushStillT = 0; p.hushStackT = 0;
    if (p.hushStacks > 0) {
      p.hushVentT += dt;
      while (p.hushVentT >= s.moveClearInterval && p.hushStacks > 0) {
        p.hushVentT -= s.moveClearInterval;
        p.hushStacks--;
      }
      if (p.hushStacks === 0) p.hushVentT = 0;
    } else {
      p.hushVentT = 0;
    }
    return;
  }
  p.hushVentT = 0;
  p.hushStillT += dt;
  if (p.hushStillT < s.stillDelay || p.hushStacks >= s.maxStacks) return;
  p.hushStackT += dt;
  while (p.hushStackT >= s.stackInterval && p.hushStacks < s.maxStacks) {
    p.hushStackT -= s.stackInterval;
    p.hushStacks++;
  }
}

// Backtalk — PARRY / RETURN. Holding fire while ready opens a short frontal window; a caught
// enemy shot arms a return that the next fire throws back at 1.15x the caught damage.
function tickBacktalk(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  if (p.backtalkCd > 0) p.backtalkCd = p.backtalkCd > dt ? p.backtalkCd - dt : 0;
  if (p.backtalkLock > 0) p.backtalkLock = p.backtalkLock > dt ? p.backtalkLock - dt : 0;
  if (p.backtalkReturnT > 0) {
    p.backtalkReturnT -= dt;
    if (p.backtalkReturnT <= 0) { p.backtalkReturnT = 0; p.backtalkCaughtDmg = 0; }
  }
  const spec = WEAPONS.backtalk.parry;
  if (spec === undefined || p.weapon !== "backtalk") { p.backtalkHoldT = 0; p.backtalkWindowT = 0; return; }
  const isReady = p.backtalkCd <= 0 && p.backtalkReturnT <= 0 && p.backtalkLock <= 0;
  if (input.firing && isReady) {
    p.backtalkHoldT += dt;
    if (p.backtalkHoldT >= spec.holdOpen) p.backtalkWindowT = spec.windowDur;
  } else {
    p.backtalkHoldT = 0;
  }
  if (p.backtalkWindowT <= 0) return;
  // The frontal catch: the earliest legal enemy shot inside the window is caught + returned.
  if (tryBacktalkCatch(w, p, spec, ev)) return;
  p.backtalkWindowT -= dt;
  if (p.backtalkWindowT <= 0) {
    p.backtalkWindowT = 0;
    p.backtalkLock = spec.missLock; // an expired empty window locks input briefly (no CD refund)
  }
}

// Legal catch: an enemy bullet (damage ≥ 1) in the frontal window. Boss mechanic hazards
// (flood fronts, choir sheets, pale/gorge arena bodies) are enemies/effects, never plain
// enemy bullets, so they can never enter this set; ally shots are friendly and excluded.
function tryBacktalkCatch(w: WorldState, p: PlayerSim, spec: NonNullable<Weapon["parry"]>, ev: SimEvent[]): boolean {
  const catchRange = 220;
  for (const b of w.bullets) {
    if (b.friendly || b.owner !== null || b.damage < 1) continue;
    const dx = b.x - p.x, dy = b.y - p.y;
    if (dx * dx + dy * dy > catchRange * catchRange) continue;
    if (Math.abs(normalizeAngle(Math.atan2(dy, dx) - p.aimAngle)) > spec.windowArc) continue;
    b.life = 0;
    p.backtalkCaughtDmg = b.damage;
    p.backtalkCd = spec.cooldown;        // cooldown starts ONLY on a successful catch
    p.backtalkReturnT = spec.returnWindow;
    p.backtalkWindowT = 0;
    p.backtalkHoldT = 0;
    ev.push({ t: "cue", name: "backtalk.parry", x: p.x, y: p.y, rate: 1, gain: 0.72, trauma: 0.03 });
    return true;
  }
  return false;
}

// Backtalk fire: throw the caught return when armed, else the feeble ready stub. A fire while
// input-locked (after a missed window) fails closed.
function fireBacktalk(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const spec = wep.parry!;
  if (p.backtalkLock > 0) return;
  const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
  const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
  if (p.backtalkReturnT > 0 && p.backtalkCaughtDmg > 0) {
    const dmg = Math.min(spec.returnMax, Math.max(spec.returnMin, p.backtalkCaughtDmg * spec.returnCoef));
    const b: Bullet = {
      x: muzzleX, y: muzzleY,
      vx: Math.cos(p.aimAngle) * spec.returnSpeed * p.mods.bulletSpeedMult,
      vy: Math.sin(p.aimAngle) * spec.returnSpeed * p.mods.bulletSpeedMult,
      radius: wep.bulletRadius * p.mods.bulletSizeMult,
      life: spec.returnLife * p.mods.bulletLifeMult,
      friendly: true, owner: p.id, damage: dmg, color: "#fff2e6",
      pierce: 0, hitList: null, isCrit: false, enemyHits: 0, critX: 1,
      bossCoef: 0.65, fx: "backtalk", isBacktalkReturn: true,
      bornTick: w.tick, lagRewind: p.rewindTicks,
    };
    w.bullets.push(b);
    p.backtalkReturnT = 0;
    p.backtalkCaughtDmg = 0;
    ev.push({ t: "cue", name: "backtalk.return", x: muzzleX, y: muzzleY, rate: 1, gain: 0.7, trauma: 0.02 });
  } else {
    const shot = resolveShot(w, p, "backtalk");
    for (const b of fire(shot, muzzleX, muzzleY, p.aimAngle, w.rng, p.id)) {
      b.bornTick = w.tick;
      b.lagRewind = p.rewindTicks;
      w.bullets.push(b);
    }
    captureMarginStore(p, wep, shot);
  }
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({
    t: "shot", pid: p.id, weapon: "backtalk", x: muzzleX, y: muzzleY, aim: p.aimAngle,
    px: p.x, py: p.y, chg: 0, mode: "none", outcome: "none",
  });
  applyWeaponKick(w, p, ev);
}

// Lamplighter — RELIGHT. Live safe patches decay; expired ones despawn.
function tickLampPatches(p: PlayerSim, dt: number): void {
  if (p.lampPatches.length === 0) return;
  for (const patch of p.lampPatches) patch.life -= dt;
  p.lampPatches = p.lampPatches.filter((patch) => patch.life > 0);
}

// A point is in warm light if it sits inside any live Carry-the-Light aura or an Undertow
// warm-pulse carry (the objective light source). This is the lit-path source for Lamplighter.
function isInWarmLight(w: WorldState, x: number, y: number): boolean {
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.mods.lightRadius <= 0) continue;
    const r = p.mods.lightRadius;
    if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) return true;
  }
  for (const e of w.enemies) {
    if (e.dead || e.kind !== "warm_pulse") continue;
    const r = e.radius + 40;
    if ((e.x - x) ** 2 + (e.y - y) ** 2 <= r * r) return true;
  }
  return false;
}

// A point is on a live Lamplighter safe patch (any owner). Read by the floor-hazard funnel.
function isOnLampPatch(w: WorldState, x: number, y: number): boolean {
  for (const p of w.players.values()) {
    for (const patch of p.lampPatches) {
      if (patch.life <= 0) continue;
      if ((patch.x - x) ** 2 + (patch.y - y) ** 2 <= patch.radius * patch.radius) return true;
    }
  }
  return false;
}

// Plant a Lamplighter safe patch (cap maxPatches; oldest despawns). NEVER deletes a hazard,
// boss tell, or pave — it only shields a standing player from floor-hazard damage.
function plantLampPatch(w: WorldState, p: PlayerSim, x: number, y: number, ev: SimEvent[]): void {
  const spec = WEAPONS.lamplighter.relight!;
  // Pathmaker overlap tax: once at the patch cap, a plant landing on existing pave has a 45%
  // chance to be skipped — the pave already covers that ground (Quill combo gate).
  if (isPavedAt(w, x, y) && p.lampPatches.length >= spec.maxPatches && w.rng.next() < 0.45) return;
  // Carry the Light tax: while the objective aura is up, patches burn 40% faster.
  const life = p.mods.lightRadius > 0 ? spec.patchLife * (1 - 0.40) : spec.patchLife;
  p.lampPatches.push({ x, y, radius: spec.patchRadius, life });
  while (p.lampPatches.length > spec.maxPatches) p.lampPatches.shift();
  ev.push({ t: "cue", name: "lamplighter.patch", x, y, rate: 1, gain: 0.5, trauma: 0 });
}

// Faultlink — LINK / SHARE. Tick the pending mark + formed link; break the link on death,
// range, or LOS loss.
function tickFaultlink(w: WorldState, p: PlayerSim, dt: number): void {
  if (p.faultMark !== null) {
    p.faultMark.life -= dt;
    if (p.faultMark.life <= 0 || findEnemyById(w, p.faultMark.eid) === null) p.faultMark = null;
  }
  const link = p.faultLink;
  if (link === null) return;
  const spec = WEAPONS.faultlink.faultlink!;
  link.life -= dt;
  const a = findEnemyById(w, link.aEid);
  const b = findEnemyById(w, link.bEid);
  if (link.life <= 0 || a === null || b === null
    || Math.hypot(a.x - b.x, a.y - b.y) > spec.range
    || !hasLineOfSight(w, a.x, a.y, b.x, b.y)) {
    p.faultLink = null;
  }
}

// A Faultlink primary hit: echo across a live seam, or advance the mark → link handshake.
function faultOnPrimaryHit(w: WorldState, p: PlayerSim, e: Enemy, dmg: number, ev: SimEvent[]): void {
  const spec = WEAPONS.faultlink.faultlink!;
  const link = p.faultLink;
  if (link !== null) {
    const otherId = e.id === link.aEid ? link.bEid : e.id === link.bEid ? link.aEid : null;
    if (otherId !== null) { faultEcho(w, p, otherId, dmg, ev); return; }
  }
  // No live seam on this body: mark it, or close the seam if a different body is already marked.
  const mark = p.faultMark;
  if (mark !== null && mark.eid !== e.id) {
    const a = findEnemyById(w, mark.eid);
    if (a !== null && Math.hypot(a.x - e.x, a.y - e.y) <= spec.range
      && hasLineOfSight(w, a.x, a.y, e.x, e.y)) {
      p.faultLink = { aEid: mark.eid, bEid: e.id, life: spec.linkDur };
      p.faultMark = null;
      ev.push({ t: "cue", name: "faultlink.link", x: e.x, y: e.y, rate: 1, gain: 0.55, trauma: 0 });
      return;
    }
  }
  p.faultMark = { eid: e.id, life: spec.markDur };
}

// Echo a fraction of a primary hit onto the linked endpoint. No crit / status / proc / recurse;
// rate-clamped to ≤4/s and same-target-repeat 0.25 (Quill echo channel).
function faultEcho(w: WorldState, p: PlayerSim, targetId: number, primaryDmg: number, ev: SimEvent[]): void {
  const spec = WEAPONS.faultlink.faultlink!;
  const target = findEnemyById(w, targetId);
  if (target === null) return;
  if (!w.procWindow.admit(procKey(p.id, target.id, "faultecho"), w.waveBClock)) return;
  const isBoss = isBossGradeKind(target);
  let dmg = primaryDmg * (isBoss ? spec.echoBoss : spec.echoRoom);
  if (!w.sameTargetWindow.admit(procKey(p.id, target.id, "faultecho"), w.waveBClock)) {
    dmg *= C.WAVE_C_FAULT_ECHO_REPEAT;
  }
  const dir = Math.atan2(target.y - p.y, target.x - p.x);
  strikeEnemy(w, p, target, {
    damage: dmg, isCrit: false, critX: 1, bossCoef: 1,
    puffX: target.x, puffY: target.y, kbDirX: Math.cos(dir), kbDirY: Math.sin(dir),
    isMelee: false, ownerId: p.id, fxWeapon: "faultlink",
  }, ev);
}

function updateShooting(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  if (isPvpSpawnAttackSuppressed(w, p)) return;
  tickWeaponFireCooldowns(p, dt);
  tickWaveBSystems(w, p, dt, ev);
  tickWaveCSystems(w, p, input, dt, ev);
  if (isPvp(w) && !isPvpWeaponSupported(p.weapon)) return;
  const wep = WEAPONS[p.weapon];
  // Hold-charge weapons (the Breach) own the whole trigger lifecycle: hold accumulates
  // the landing distance, RELEASE fires. Every other weapon fires on press-with-cooldown.
  if (wep.charge) {
    updateChargeShooting(w, p, wep, input, dt, ev);
    return;
  }
  if (input.firing && p.fireCd === 0) {
    if (wep.wire !== undefined && wirePlantLength(w, p, wep) < 24) {
      plantWire(w, p, wep, ev);
      return;
    }
    if (!commitPvpOutgoingAttack(w, p, ev)) return;
    cancelReviveChannelBy(w, p.id); // gate §6: the reviver's attack cancels their channel
    if (wep.melee) {
      startMeleeSwing(w, p, ev);
      return;
    }
    // Effect-wave verbs: each branch authors an Effect (or resolves one) instead of
    // spawning bullets. They pay the same cooldown/shotSeq bookkeeping as a shot.
    if (wep.wire) { plantWire(w, p, wep, ev); return; }
    if (wep.orbit) { flareOrbit(w, p, wep, ev); return; }
    if (wep.sentry) { deploySentry(w, p, wep, ev); return; }
    if (wep.tether) { fireTether(w, p, wep, ev); return; }
    if (wep.rewrite) { fireRedPen(w, p, wep, ev); return; }
    if (wep.margin) { fireMarginCall(w, p, wep, ev); return; }
    if (wep.sidewinder) { fireSidewinder(w, p, wep, ev); return; }
    if (wep.parry) { fireBacktalk(w, p, wep, ev); return; }
    const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
    const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
    const spec = resolveShot(w, p, p.weapon);
    // The Midas: a FED shot eats one coin for its damage multiplier (and gleams brighter);
    // broke, it fires the honest base round — never a locked trigger.
    if (wep.coinBoost !== undefined && p.coins > 0) {
      p.coins--;
      spec.damage *= wep.coinBoost;
      spec.color = "#fff3a8";
    }
    const fired = fire(spec, muzzleX, muzzleY, p.aimAngle, w.rng, p.id);
    for (let index = 0; index < fired.length; index++) {
      const b = fired[index];
      if (spec.isPaving === true && index > 0) {
        b.paintSpacing = undefined;
        b.paintDist = undefined;
        b.paintZonesLeft = undefined;
        b.isPaving = undefined;
      }
      if (spec.grapplePull !== undefined && index > 0) b.grapplePull = undefined;
      // Resonant Fork: the primary round opens/refreshes the owner's single tune link on hit.
      if (wep.resonate !== undefined) b.isForkPrimary = true;
      // Hushiron: a stance slug (tracked for FX only; its stance mods are baked into the shot).
      if (wep.stance !== undefined) b.isHushSlug = true;
      // Lamplighter: a relight round accrues lit-travel distance to earn its pierce + patch.
      if (wep.relight !== undefined) { b.isLampShot = true; b.lampLitDist = 0; b.lampLit = false; }
      // Faultlink: a primary round marks the body it hits (and echoes across a formed link).
      if (wep.faultlink !== undefined) b.isFaultPrimary = true;
      // Anchor lag-comp at fire time: record the tick + the shooter's rewind depth NOW, so hit
      // tests use the shooter's fire-time view and decay to present as the projectile travels.
      b.bornTick = w.tick;
      b.lagRewind = p.rewindTicks;
      w.bullets.push(b);
    }
    // Margin Call stores exactly one payload class off ANY other weapon's committed shot.
    captureMarginStore(p, wep, spec);
    setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
    p.shotSeq++;
    advanceWeaponCycle(p, p.weapon);
    ev.push({
      t: "shot", pid: p.id, weapon: p.weapon, x: muzzleX, y: muzzleY, aim: p.aimAngle,
      px: p.x, py: p.y, chg: 0, mode: spec.sluiceMode ?? "none",
      outcome: spec.oddsmakerOutcome ?? "none",
    });
    applyWeaponKick(w, p, ev);
  }
}

// ---- the effect wave: per-weapon trigger verbs ----

// The Breach: holding the trigger charges a LANDING DISTANCE (bounded, walk slowed via
// updatePlayer); releasing lobs a shell whose life expires exactly at that distance —
// the lob flag makes it sail over bodies, so the end-of-arc airburst IS the payload.
function updateChargeShooting(w: WorldState, p: PlayerSim, wep: Weapon, input: InputCmd, dt: number, ev: SimEvent[]): void {
  const spec = wep.charge!;
  // The SAFE CANCEL: dashing while holding a charge dumps it without firing (one intent,
  // reachable from any input device — the same button that already means "get out").
  // Weapon switches, going down, and pause/blessing overlays cancel through their own
  // sites (equipWeapon / damagePlayer / stepPlayerPhase), so a charge can never fire
  // out of a menu or a corpse.
  if (input.dash && p.chargeT > 0) {
    p.chargeT = 0;
    return;
  }
  if (input.firing && p.fireCd === 0) {
    if (!commitPvpOutgoingAttack(w, p, ev)) return;
    if (p.chargeT === 0) cancelReviveChannelBy(w, p.id); // charging is an attack commitment
    p.chargeT = Math.min(spec.time, p.chargeT + dt);
    return;
  }
  if (input.firing || p.chargeT === 0) return;
  // Release: distance scales tap -> full hold; the life mod maps to reach (duration of
  // the arc), the speed mod to flight time over the SAME distance.
  const t = p.chargeT / spec.time;
  p.chargeT = 0;
  const dist = (spec.minDist + (spec.maxDist - spec.minDist) * t) * p.mods.bulletLifeMult;
  const shot = resolveShot(w, p, p.weapon);
  shot.life = dist / shot.speed;
  const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
  const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
  for (const b of fire(shot, muzzleX, muzzleY, p.aimAngle, w.rng, p.id)) {
    b.isLob = true;
    b.lobT = t;
    b.bornTick = w.tick;
    b.lagRewind = p.rewindTicks;
    w.bullets.push(b);
  }
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  advanceWeaponCycle(p, p.weapon);
  ev.push({
    t: "shot", pid: p.id, weapon: p.weapon, x: muzzleX, y: muzzleY, aim: p.aimAngle,
    px: p.x, py: p.y, chg: t, mode: shot.sluiceMode ?? "none",
    outcome: shot.oddsmakerOutcome ?? "none",
  });
  applyWeaponKick(w, p, ev);
}

// The Snapwire: string a wire from the planting spot along aim, wall-clamped. It arms
// after a beat (planting is never a free point-blank hit) and the OLDEST owned wire
// gives way past the cap — the pellets mod buys more concurrent wires, never more snap.
function wirePlantLength(w: WorldState, p: PlayerSim, wep: Weapon): number {
  const spec = wep.wire!;
  const dirX = Math.cos(p.aimAngle);
  const dirY = Math.sin(p.aimAngle);
  const step = 8;
  let length = 0;
  while (length + step <= spec.length
    && !isWall(w, p.x + dirX * (length + step), p.y + dirY * (length + step))) {
    length += step;
  }
  return length;
}

function plantWire(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const spec = wep.wire!;
  const dirX = Math.cos(p.aimAngle), dirY = Math.sin(p.aimAngle);
  const len = wirePlantLength(w, p, wep);
  if (len < 24) {
    // Face-planting into a wall refuses the plant — the fail state reads out loud.
    setActiveWeaponFireCooldown(p, 0.2);
    ev.push({ t: "wireRefused", x: p.x, y: p.y });
    return;
  }
  const maxWires = Math.min(MAX_WIRES, spec.max + p.mods.extraPellets);
  const owned = w.effects.filter((e): e is WireEffect => e.kind === "wire" && e.owner === p.id && e.life > 0);
  for (let i = 0; i <= owned.length - maxWires; i++) owned[i].life = 0;
  // Party-wide trap budget (envelope): the WORLD holds at most MAX_WIRES_PARTY armed
  // wires; the globally oldest (lowest id) gives way regardless of who planted it.
  const all = w.effects.filter((e): e is WireEffect => e.kind === "wire" && e.life > 0);
  for (let i = 0; i <= all.length - MAX_WIRES_PARTY; i++) all[i].life = 0;
  const arm = spec.arm / p.mods.bulletSpeedMult;
  const life = arm + spec.life * p.mods.bulletLifeMult;
  const x2 = p.x + dirX * len, y2 = p.y + dirY * len;
  w.effects.push({
    id: w.nextEffectId++, kind: "wire", owner: p.id, fx: wep.id,
    x: p.x, y: p.y, x2, y2,
    width: spec.width * p.mods.bulletSizeMult,
    arm, life, maxLife: life,
    damage: wep.damage,
  });
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({ t: "wirePlanted", x: p.x, y: p.y, tx: x2, ty: y2 });
}

// The Razor Halo's active: flare the ring outward for a beat (updateEffects owns the
// upkeep/damage; ensureOrbit covers the first press racing the world phase).
function flareOrbit(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const orbit = ensureOrbit(w, p, wep);
  orbit.flare = wep.orbit!.flareDur;
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({ t: "haloFlare", x: p.x, y: p.y, r: wep.orbit!.flareRing });
}

// The Prism Sentry: park a destructible turret a step ahead (redeploying MOVES it — one
// per owner, so the verb is "hold a second lane", never a turret farm).
function deploySentry(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const spec = wep.sentry!;
  let x = p.x + Math.cos(p.aimAngle) * spec.deployDist;
  let y = p.y + Math.sin(p.aimAngle) * spec.deployDist;
  if (!isStandableSpot(w, x, y, spec.radius)) { x = p.x; y = p.y; }
  for (const e of w.effects) {
    if (e.kind === "sentry" && e.owner === p.id) e.life = 0; // silent replace: the redeploy
  }
  const life = spec.life * p.mods.bulletLifeMult;
  w.effects.push({
    id: w.nextEffectId++, kind: "sentry", owner: p.id, fx: wep.id,
    x, y, life, maxLife: life,
    radius: spec.radius, hp: spec.hp, maxHp: spec.hp,
    fireCd: 0, range: spec.range,
    boltSpeed: spec.boltSpeed * p.mods.bulletSpeedMult,
    boltRadius: spec.boltRadius * p.mods.bulletSizeMult,
    boltDamage: wep.damage,
    boltPierce: Math.min(4, p.mods.pierce),
    contactCd: 0,
    targetEid: -1,
  });
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  ev.push({ t: "sentryPlaced", x, y });
}

// The Crooked Chain: first press latches the nearest body along the aim capsule and
// starts the pull (heavy bodies pull the OWNER instead); a second press resolves the
// sweep around the owner and releases the chain.
function fireTether(w: WorldState, p: PlayerSim, wep: Weapon, ev: SimEvent[]): void {
  const spec = wep.tether!;
  const held = w.effects.find((e): e is TetherEffect => e.kind === "tether" && e.owner === p.id && e.life > 0);
  if (held) {
    sweepTether(w, p, held, ev);
    setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
    p.shotSeq++;
    return;
  }
  const dirX = Math.cos(p.aimAngle), dirY = Math.sin(p.aimAngle);
  let best: Enemy | null = null;
  let bestFwd = Infinity;
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const fwd = dx * dirX + dy * dirY;
    if (fwd < 0 || fwd > spec.range) continue;
    const lat = Math.abs(dx * dirY - dy * dirX);
    if (lat > spec.width + e.radius) continue;
    if (!hasLineOfSight(w, p.x, p.y, e.x, e.y)) continue;
    if (fwd < bestFwd) { bestFwd = fwd; best = e; }
  }
  if (!best) {
    // The whiff still lashes (readable feedback + a real cooldown cost).
    setActiveWeaponFireCooldown(p, 0.35);
    p.shotSeq++;
    ev.push({ t: "tetherLatch", eid: -1, x: p.x, y: p.y, tx: p.x + dirX * spec.range, ty: p.y + dirY * spec.range, inv: false });
    return;
  }
  const isHeavy = isBossKind(best.kind) || best.tier === "brute" || best.tier === "elite";
  w.effects.push({
    id: w.nextEffectId++, kind: "tether", owner: p.id, fx: wep.id,
    x: p.x, y: p.y,
    eid: best.id, phase: "pull", isPlayerPulled: isHeavy,
    pullSpeed: spec.pullSpeed * p.mods.bulletSpeedMult,
    holdDist: spec.holdDist,
    holdTime: spec.hold * p.mods.bulletLifeMult,
    pullTime: isHeavy ? spec.playerPullTime : C.TETHER_PULL_BUDGET,
    damage: wep.damage,
    reach: spec.reach * p.mods.bulletSizeMult,
    life: C.TETHER_PULL_BUDGET + spec.hold * p.mods.bulletLifeMult + 0.5,
    maxLife: C.TETHER_PULL_BUDGET + spec.hold * p.mods.bulletLifeMult + 0.5,
  });
  // A short lock (not the full weapon cooldown): the SECOND press is the sweep.
  setActiveWeaponFireCooldown(p, C.TETHER_LATCH_FIRE_LOCK);
  p.shotSeq++;
  ev.push({ t: "tetherLatch", eid: best.id, x: p.x, y: p.y, tx: best.x, ty: best.y, inv: isHeavy });
}

// Resolve a held chain: strike everything in the sweep radius around the owner (the
// reeled-in target included by construction) and release the tether.
function sweepTether(w: WorldState, p: PlayerSim, t: TetherEffect, ev: SimEvent[]): void {
  t.life = 0;
  const dmg = t.damage * currentDamageMult(p);
  const isCrit = p.mods.critChance > 0 && w.rng.next() < p.mods.critChance;
  ev.push({ t: "tetherSweep", x: p.x, y: p.y, r: t.reach });
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) > t.reach + e.radius) continue;
    const kbX = e.x - p.x, kbY = e.y - p.y;
    strikeEnemy(w, p, e, {
      damage: isCrit ? dmg * p.mods.critMult : dmg, isCrit,
      critX: isCrit ? p.mods.critMult : 1,
      bossCoef: WEAPON_BOSS_COEF[t.fx] ?? 1,
      puffX: e.x, puffY: e.y,
      kbDirX: kbX === 0 && kbY === 0 ? 1 : kbX, kbDirY: kbY,
      isMelee: true, meleeSource: "crook",
      ownerId: p.id, fxWeapon: t.fx,
    }, ev);
  }
  // The sweep smashes cover in its arc as well. One-shot (the tether releases this call),
  // so no re-hit guard is needed.
  for (const prop of w.props) {
    if (Math.hypot(prop.x - p.x, prop.y - p.y) > t.reach + prop.radius) continue;
    damageProp(w, prop, t.damage, ev, p);
  }
}

// One live orbit ring per Razor Halo wielder (updateEffects keeps it in step with the
// owner every world tick; this covers the flare racing the first upkeep).
function ensureOrbit(w: WorldState, p: PlayerSim, wep: Weapon): OrbitEffect {
  for (const e of w.effects) {
    if (e.kind === "orbit" && e.owner === p.id && e.life > 0) return e;
  }
  const spec = wep.orbit!;
  const orbit: OrbitEffect = {
    id: w.nextEffectId++, kind: "orbit", owner: p.id, fx: wep.id,
    x: p.x, y: p.y, life: 1, maxLife: 1,
    angle: 0, ring: spec.ring,
    blades: Math.min(MAX_ORBIT_BLADES, spec.blades + p.mods.extraPellets),
    bladeRadius: spec.bladeRadius * p.mods.bulletSizeMult,
    speed: spec.speed * p.mods.bulletSpeedMult,
    flare: 0,
    damage: wep.damage,
    rehit: new Map(),
  };
  w.effects.push(orbit);
  return orbit;
}

function startMeleeSwing(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const wep = WEAPONS[p.weapon];
  const m = wep.melee;
  if (!m) return;
  const isCrit = p.mods.critChance > 0 && w.rng.next() < p.mods.critChance;
  const cleaveArcScale = isCrit ? p.mods.cleaveCritArcMult : 1;
  const cleaveReachScale = isCrit ? p.mods.cleaveCritReachMult : 1;
  // Last Warm Round: every melee swing is its own cycle-final beat (family: melee).
  const warm = p.mods.warmRoundBonus > 0 ? 1 + p.mods.warmRoundBonus : 1;
  const baseDmg = wep.damage * currentDamageMult(p) * warm;
  p.meleeSwing = {
    timer: m.swingDur ?? 0.2,
    duration: m.swingDur ?? 0.2,
    aim: p.aimAngle,
    arc: m.arc * cleaveArcScale,
    arcScale: cleaveArcScale,
    reach: m.reach * cleaveReachScale,
    isThrust: m.isThrust === true,
    color: wep.color,
    damage: isCrit ? baseDmg * p.mods.critMult : baseDmg,
    isCrit,
    bossCoef: WEAPON_BOSS_COEF[wep.id] ?? 1,
    hitList: null,
    burn: wep.burn,
    chill: wep.chill,
    shock: wep.shock,
    originX: p.x,
    originY: p.y,
    bornTick: w.tick,
    lagRewind: p.rewindTicks,
  };
  setActiveWeaponFireCooldown(p, wep.fireCd / currentFireRate(p));
  p.shotSeq++;
  // Slash-wind fires at the pre-knockback position (x,y); the small tip burst fires after
  // the weapon's self-knockback (bx,by). They differ only for the spear (its kb > 0).
  // Hold Fast is gun-only: melee kick uses the authored FIRE_KNOCKBACK raw, never
  // selfKnockbackMult / applyWeaponKick (which emits the hold_fast blessingProc).
  const preX = p.x, preY = p.y;
  const kb = C.FIRE_KNOCKBACK[p.weapon];
  if (kb !== 0) {
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, -Math.cos(p.aimAngle) * kb, 0);
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, -Math.sin(p.aimAngle) * kb);
  }
  // The fire-time attacker pose is the post-knockback one (what the first hit test would see).
  p.meleeSwing.originX = p.x;
  p.meleeSwing.originY = p.y;
  ev.push({ t: "meleeSwing", pid: p.id, weapon: p.weapon, x: preX, y: preY, aim: p.aimAngle, bx: p.x, by: p.y });
}

// The attacker pose a swing's hit tests use: while the swing's fire-time rewind is active
// (online lag comp), the swing-START pose — both actors are then evaluated at fire time, so an
// attacker moving after the swing can neither drag the arc onto a target nor have a laggy swing
// judged from a pose it never fired at. Solo/prediction rewind is 0 → the live pose (unchanged).
function swingPose(w: WorldState, p: PlayerSim, swing: MeleeSwing): [number, number] {
  if (fireTimeRewind(w, swing.bornTick, swing.lagRewind) > 0) return [swing.originX, swing.originY];
  return [p.x, p.y];
}

function isPointInMeleeHit(px: number, py: number, x: number, y: number, radius: number, swing: MeleeSwing): boolean {
  const dx = x - px;
  const dy = y - py;
  const dist = Math.hypot(dx, dy);
  if (dist > swing.reach + radius) return false;
  const cos = Math.cos(swing.aim);
  const sin = Math.sin(swing.aim);
  if (swing.isThrust) {
    const fwd = dx * cos + dy * sin;
    if (fwd < -radius * 0.4 || fwd > swing.reach + radius) return false;
    const lat = Math.abs(dx * sin - dy * cos);
    return lat < C.MELEE_THRUST_WIDTH * swing.arcScale + radius;
  }
  let ang = Math.atan2(dy, dx) - swing.aim;
  while (ang > Math.PI) ang -= Math.PI * 2;
  while (ang < -Math.PI) ang += Math.PI * 2;
  const angPad = Math.atan2(radius, Math.max(dist, 1));
  return Math.abs(ang) <= swing.arc * 0.5 + angPad;
}

function firstWallContact(
  w: WorldState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number } | null {
  const distance = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(distance / 2));
  let lastX = x0;
  let lastY = y0;
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps;
    const x = x0 + (x1 - x0) * ratio;
    const y = y0 + (y1 - y0) * ratio;
    if (isWall(w, x, y)) return { x: lastX, y: lastY };
    lastX = x;
    lastY = y;
  }
  return null;
}

function updateBullets(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const b of w.bullets) {
    if (isPvp(w) && b.owner !== null) {
      const owner = w.players.get(b.owner);
      if (owner !== undefined && (owner.hp <= 0 || owner.respawnT > 0)) {
        b.life = 0;
        continue;
      }
    }
    if (b.isPaving === true && b.owner !== null) {
      const owner = w.players.get(b.owner);
      if (owner === undefined || owner.isAbsent) {
        b.life = 0;
        continue;
      }
    }
    // Anchor this tick's swept-collision segment BEFORE any steering/move. A wall bounce
    // resets the bullet to exactly this point, leaving that tick's segment degenerate —
    // a reflected round never sweeps backward through the wall it hit.
    b.prevX = b.x;
    b.prevY = b.y;
    if (b.homing !== undefined) {
      if (b.friendly) steerHoming(w, b, dt);
      else steerEnemyHoming(w, b, dt); // the Choir's wails seek the nearest standing player
    }
    // Sidewinder: the arc curves at a fixed turn rate (encircling toward the flank).
    if (b.sidewinderTurn !== undefined) {
      const turn = b.sidewinderTurn * dt;
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const nvx = b.vx * cos - b.vy * sin;
      const nvy = b.vx * sin + b.vy * cos;
      b.vx = nvx; b.vy = nvy;
    }
    // The Hive's darts gain speed in flight (launch lazy, arrive fast).
    if (b.accel !== undefined) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const scale = (sp + b.accel * dt) / sp;
        b.vx *= scale;
        b.vy *= scale;
      }
    }
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    // Lamplighter: a relight round accrues distance through warm/objective/Carry-the-Light
    // light; once past the lit threshold it latches +1 pierce (shares CAPS.pierce).
    if (b.isLampShot === true && b.lampLit !== true && isInWarmLight(w, b.x, b.y)) {
      b.lampLitDist = (b.lampLitDist ?? 0) + Math.hypot(b.vx, b.vy) * dt;
      if (b.lampLitDist >= (WEAPONS.lamplighter.relight?.litDist ?? Infinity)) {
        b.lampLit = true;
        b.pierce = Math.min(4, b.pierce + 1);
      }
    }
    const wallContact = !(b.friendly && b.isPhase === true)
      ? b.grapplePull !== undefined
        ? firstWallContact(w, b.prevX, b.prevY, b.x, b.y)
        : isWall(w, b.x, b.y) ? { x: b.prevX, y: b.prevY } : null
      : null;
    // Ground-painting beads drop their authored zone at fixed travel spacing.
    if (b.friendly && b.paintSpacing !== undefined && b.paintDist !== undefined && !isWall(w, b.x, b.y)) {
      b.paintDist += Math.hypot(b.vx, b.vy) * dt;
      while (b.paintDist >= b.paintSpacing) {
        b.paintDist -= b.paintSpacing;
        if (b.paintZonesLeft !== undefined && b.paintZonesLeft <= 0) break;
        if (spawnPaintZone(w, b) && b.paintZonesLeft !== undefined) b.paintZonesLeft--;
      }
    }
    // A mortar shell that reaches the end of its arc airbursts instead of vanishing;
    // a Lodestone round's end-of-arc implodes the same way.
    if (b.life <= 0 && b.friendly && b.blast !== undefined) { detonateBullet(w, b, b.x, b.y, ev); continue; }
    if (b.life <= 0 && b.friendly && b.implode !== undefined) { implodeBullet(w, b, b.x, b.y, ev); continue; }
    // The Weaver's aimed silk webs the spot it dies on (spent bolt -> sticky floor).
    if (b.life <= 0 && b.isSilk === true) { plantWeb(w, b.x, b.y, WEAVER.silkWebRadius, ev); continue; }
    // Umbra rounds pass straight through walls — geometry simply isn't theirs to hit.
    if (!(b.friendly && b.isPhase === true) && wallContact !== null) {
      if (b.friendly && b.blast !== undefined) {
        // Shells burst ON the wall face (the last in-bounds point), not inside it.
        detonateBullet(w, b, wallContact.x, wallContact.y, ev);
        continue;
      }
      if (b.friendly && b.implode !== undefined) {
        implodeBullet(w, b, wallContact.x, wallContact.y, ev);
        continue;
      }
      if (b.friendly && b.grapplePull !== undefined) {
        grappleOwnerToAnchor(w, b, wallContact.x, wallContact.y, ev);
        b.life = 0;
        ev.push({ t: "bulletWall", x: b.x, y: b.y, aim: Math.atan2(-b.vy, -b.vx) });
        continue;
      }
      if (b.friendly && b.reclaimedBounceDamage !== undefined
        && (b.enemyHits ?? 0) === 0 && (b.bounce ?? 0) <= 0) {
        b.damage *= b.reclaimedBounceDamage;
        b.reclaimedBounceDamage = undefined;
        b.bounce = 1;
        if (b.owner !== null) {
          ev.push({
            t: "blessingProc", pid: b.owner, item: "nothing_wasted",
            phase: "reclaimed", x: wallContact.x, y: wallContact.y,
          });
        }
        bounceOffWall(w, b, dt, ev);
        continue;
      }
      b.reclaimedBounceDamage = undefined;
      if (b.bounce !== undefined && b.bounce > 0) { bounceOffWall(w, b, dt, ev); continue; }
      b.life = 0;
      if (b.isSilk === true) plantWeb(w, b.prevX ?? b.x, b.prevY ?? b.y, WEAVER.silkWebRadius, ev);
      // Lamplighter: a LIT round that reaches a wall plants its safe patch on the wall face.
      if (b.isLampShot === true && b.lampLit === true && b.owner !== null) {
        const lampOwner = w.players.get(b.owner);
        if (lampOwner !== undefined) plantLampPatch(w, lampOwner, wallContact.x, wallContact.y, ev);
      }
      ev.push({ t: "bulletWall", x: b.x, y: b.y, aim: Math.atan2(-b.vy, -b.vx) }); continue;
    }
    if (!b.friendly) {
      for (const p of w.players.values()) {
        if (!isProtected(p) && !p.isDown && !p.isAbsent && p.hp > 0 && Math.hypot(p.x - b.x, p.y - b.y) < p.pr + b.radius) {
          b.life = 0;
          ev.push({ t: "bulletExpire", x: b.x, y: b.y, color: b.color });
          damagePlayer(w, p, b.damage, ev);
          if (b.isSilk === true) plantWeb(w, b.x, b.y, WEAVER.silkWebRadius, ev);
          break;
        }
      }
      // Enemy fire chews deployed sentries — a parked turret is a real body in the lane,
      // not an invulnerable damage source.
      if (b.life > 0) {
        for (const e of w.effects) {
          if (e.kind !== "sentry" || e.life <= 0) continue;
          if (Math.hypot(e.x - b.x, e.y - b.y) < e.radius + b.radius) {
            b.life = 0;
            e.hp -= b.damage;
            ev.push({ t: "sentryHit", x: e.x, y: e.y });
            break;
          }
        }
      }
    } else if (!isPvp(w) && b.owner !== null && isFriendlyNudgeProjectile(b)) {
      // A teammate's DIRECT round grazing a friend: 0 damage, a gentle positional impulse,
      // and the bullet PASSES THROUGH (never consumed, no pierce cost). Resolved in the same
      // bullet pass as every other collision so it stays deterministic + server-authoritative.
      // pvp has no friendlies — owned rounds DAMAGE foes (resolvePvpHits), never nudge them.
      applyFriendlyNudges(w, b, ev);
    }
  }
  w.bullets = w.bullets.filter((b) => b.life > 0);
}

// A DIRECT player projectile eligible for the friendly bonk: an ordinary gun/pellet/thrown
// round. Explicitly NOT area/persistent/sticky payloads — mortar blast, vortex implosion,
// sentry bolts (isPersistent), Frostline paint — nor the Weaver's enemy silk. Those are
// excluded by the game-designer spec (effect-wave/area/persistent weapons never bonk).
function isFriendlyNudgeProjectile(b: Bullet): boolean {
  return b.blast === undefined
    && b.implode === undefined
    && b.isPersistent !== true
    && b.paintSpacing === undefined
    && b.grapplePull === undefined
    && b.isSilk !== true;
}

// Resolve friendly nudges for one direct projectile against every NON-owner teammate it
// swept over this tick. Downed/absent/dead teammates are skipped; a per-ORDERED-pair
// cooldown gates it to one bonk per window (never per-bullet). The impulse is a fixed
// wall-aware displacement ALONG the bullet vector, clamped to a dash-distance ceiling and
// NEVER scaled by the shooter's weapon KB — it can't cancel firing/dash/reload/animation.
function applyFriendlyNudges(w: WorldState, b: Bullet, ev: SimEvent[]): void {
  const owner = b.owner;
  if (owner === null) return;
  const dist = Math.min(
    C.FRIENDLY_NUDGE_FRAC * C.FRIENDLY_NUDGE_REF_KB,
    PLAYER.dashSpeed * PLAYER.dashActive * C.FRIENDLY_NUDGE_DASH_FRAC,
  );
  const sp = Math.hypot(b.vx, b.vy) || 1;
  const ux = b.vx / sp, uy = b.vy / sp;
  for (const p of w.players.values()) {
    if (p.id === owner) continue;                       // own projectiles never nudge you
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;  // downed/dead teammates: no nudge
    if (!sweptBulletHit(b, p.x, p.y, p.pr + b.radius)) continue;
    const key = owner + ">" + p.id;
    if ((w.friendlyNudgeCd.get(key) ?? 0) > 0) continue; // A->B pair cooldown (independent of B->A)
    w.friendlyNudgeCd.set(key, C.FRIENDLY_NUDGE_CD);
    const cx = sweptHit.x, cy = sweptHit.y;              // contact point off the swept segment
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, ux * dist, 0);
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, uy * dist);
    ev.push({ t: "friendlyNudge", shooterId: owner, targetId: p.id, x: cx, y: cy, dirX: ux, dirY: uy });
  }
}

function oldestZone(zones: readonly ZoneEffect[]): ZoneEffect | null {
  let oldest: ZoneEffect | null = null;
  for (const zone of zones) {
    if (oldest === null || zone.id < oldest.id) oldest = zone;
  }
  return oldest;
}

function admitPaintZone(w: WorldState, owner: PlayerId | null, isPaved: boolean): boolean {
  const zones = w.effects.filter(
    (effect): effect is ZoneEffect => effect.kind === "zone" && effect.life > 0,
  );
  const sameFamily = zones.filter((zone) => zone.isPaved === isPaved);
  if (!isPaved) {
    if (sameFamily.length < C.MAX_CHILL_ZONE_EFFECTS && zones.length < C.MAX_ZONE_EFFECTS) {
      return true;
    }
    const evicted = oldestZone(sameFamily);
    if (evicted === null) return false;
    evicted.life = 0;
    return true;
  }

  const owned = sameFamily.filter((zone) => zone.owner === owner);
  if (owned.length >= C.MAX_PAVE_ZONES_PER_OWNER) {
    const evicted = oldestZone(owned);
    if (evicted !== null) evicted.life = 0;
    return evicted !== null;
  }
  if (sameFamily.length < C.MAX_PAVE_ZONE_EFFECTS && zones.length < C.MAX_ZONE_EFFECTS) {
    return true;
  }

  const activeOwners = [...new Set(sameFamily.map((zone) => zone.owner))]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const fairShare = Math.max(1, Math.floor(C.MAX_PAVE_ZONE_EFFECTS / Math.max(1, activeOwners.length)));
  let evictedOwner: PlayerId | null | undefined;
  let highestCount = fairShare;
  for (const candidate of activeOwners) {
    const count = sameFamily.filter((zone) => zone.owner === candidate).length;
    if (count > highestCount || (count === highestCount && candidate === owner)) {
      highestCount = count;
      evictedOwner = candidate;
    }
  }
  if (evictedOwner === undefined) return false;
  const evicted = oldestZone(sameFamily.filter((zone) => zone.owner === evictedOwner));
  if (evicted === null) return false;
  evicted.life = 0;
  return true;
}

function spawnPaintZone(w: WorldState, b: Bullet): boolean {
  const life = b.paintLife ?? 1;
  const isPaved = b.isPaving === true;
  if (!admitPaintZone(w, b.owner, isPaved)) return false;
  w.effects.push({
    id: w.nextEffectId++, kind: "zone", owner: b.owner, fx: b.fx ?? "frostline",
    x: b.x, y: b.y, life, maxLife: life,
    radius: b.paintRadius ?? 24,
    chillRate: b.paintRate ?? 2,
    isPaved,
  });
  if (!isPaved) return true;
  const radius = b.paintRadius ?? 24;
  for (const h of w.hazards) {
    if (h.kind !== "web" && h.kind !== "cinder" && h.kind !== "corrupt") continue;
    if (Math.hypot(h.x - b.x, h.y - b.y) + h.radius <= radius) h.life = 0;
  }
  w.hazards = w.hazards.filter((h) => h.life > 0);
  return true;
}

// Mortar detonation: the shell's ONE payload, applied as an ordinary strike (attribution,
// crits, elemental blessings, knockback radially out of the blast) to every targetable
// enemy in the radius, plus prop destruction — explosive barrels chain, exactly like §prop
// explosions. The bullet collapses onto the blast point so its spent segment can never
// also plain-hit something later this tick.
function detonateBullet(w: WorldState, b: Bullet, x: number, y: number, ev: SimEvent[]): void {
  const r = b.blast;
  if (r === undefined) return;
  b.blast = undefined;
  b.life = 0;
  b.x = x; b.y = y; b.prevX = x; b.prevY = y;
  // A FULL-charge Breach shell walks a LINE of detonations back along its approach (the
  // creative gate's behavior change: the full hold buys geometry, never bigger numbers).
  // The shared hitList keeps every body at exactly one strike, so the line extends AREA;
  // it can never stack damage on a single target.
  const points: Array<[number, number]> = [[x, y]];
  if (b.isLob && (b.lobT ?? 0) >= C.BREACH_LINE_TIER) {
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / speed, uy = b.vy / speed;
    for (let i = 1; i < C.BREACH_LINE_BLASTS; i++) {
      const px = x - ux * C.BREACH_LINE_STEP * i;
      const py = y - uy * C.BREACH_LINE_STEP * i;
      if (!isWall(w, px, py)) points.push([px, py]);
    }
  }
  const shooter = ownerOf(w, b.owner);
  for (const [bx, by] of points) {
    ev.push({ t: "explosion", x: bx, y: by, r, src: b.fx ?? "barrel" });
    for (const e of w.enemies) {
      if (e.dead || isUntargetable(e)) continue;
      if (b.hitList && b.hitList.indexOf(e) !== -1) continue;
      if (Math.hypot(e.x - bx, e.y - by) > r + e.radius) continue;
      const kbX = e.x - bx, kbY = e.y - by;
      strikeEnemy(w, shooter, e, {
        damage: b.damage, isCrit: b.isCrit, critX: b.critX ?? 1, bossCoef: b.bossCoef ?? 1, puffX: e.x, puffY: e.y,
        kbDirX: kbX === 0 && kbY === 0 ? 1 : kbX, kbDirY: kbY,
        burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
        ownerId: b.owner, fxWeapon: b.fx ?? null,
      }, ev);
      (b.hitList ??= []).push(e);
    }
    for (const prop of w.props) {
      if (prop.breakT !== undefined || prop.kind === "brazier") continue;
      if (Math.hypot(prop.x - bx, prop.y - by) <= r + prop.radius) destroyProp(w, prop, ev, shooter ?? undefined);
    }
  }
  // pvp: the blast also catches FOE PLAYERS in the radius (mortars never silently pass through a
  // player). One splash at the primary point through the ONE funnel; the per-tick cap bounds it.
  pvpSplash(w, b.owner, b.fx ?? null, x, y, r, b.damage, ev);
}

// Lodestone implosion: the round's ONE payload. Every targetable enemy in the radius is
// yanked TOWARD the impact point (strikeEnemy's knockback, aimed inward — WEAPON_KB.vortex
// is the pull strength, resisted like ordinary knockback so a heavy body barely budges)
// and takes a modest splash (IMPLODE_SPLASH_FRAC of the round). The bullet collapses onto
// the point exactly like a mortar shell, so its spent segment can never also plain-hit.
function implodeBullet(w: WorldState, b: Bullet, x: number, y: number, ev: SimEvent[]): void {
  const r = b.implode;
  if (r === undefined) return;
  b.implode = undefined;
  b.life = 0;
  b.x = x; b.y = y; b.prevX = x; b.prevY = y;
  ev.push({ t: "implosion", x, y, r });
  const shooter = ownerOf(w, b.owner);
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    if (Math.hypot(e.x - x, e.y - y) > r + e.radius) continue;
    const inX = x - e.x, inY = y - e.y;
    strikeEnemy(w, shooter, e, {
      damage: b.damage * C.IMPLODE_SPLASH_FRAC, isCrit: b.isCrit, critX: b.critX ?? 1,
      bossCoef: b.bossCoef ?? 1, puffX: e.x, puffY: e.y,
      kbDirX: inX === 0 && inY === 0 ? 1 : inX, kbDirY: inY,
      burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
      ownerId: b.owner, fxWeapon: b.fx ?? null,
    }, ev);
    (b.hitList ??= []).push(e);
  }
  // pvp: the implosion splashes AND yanks FOE PLAYERS toward the collapse point (the player twin
  // of the enemy pull), routed through the ONE funnel. Wall-aware pull, cap-bounded splash.
  if (isPvp(w) && b.owner !== null) {
    const splash = pvpHitDamage(b.fx ?? PVP.startWeapon, b.damage * C.IMPLODE_SPLASH_FRAC);
    for (const vid of [...w.players.keys()].sort()) {
      const v = w.players.get(vid);
      if (v === undefined || !canDamagePlayer(w, b.owner, v)) continue;
      if (Math.hypot(v.x - x, v.y - y) > r + v.pr) continue;
      const inX = x - v.x, inY = y - v.y;
      damagePlayer(w, v, splash, ev, b.owner, {
        weapon: b.fx ?? PVP.startWeapon,
        dirX: inX,
        dirY: inY,
      });
    }
  }
  // The Singularity's SECOND stage: the collapse point births a short-fused friendly nova.
  // It rides the isLob path (like a Breach shell) so it SAILS OVER bodies during its fuse —
  // detonating only when the fuse expires (updateBullets' end-of-life blast branch), never on
  // contact with the body already sitting on the point. That fuse is the beat the implosion
  // knockback uses to clump the pack; the blast then lands on the clump with a fresh hitList
  // (its own hit, never a double-dip). An ordinary blast bullet otherwise: no wire field, no
  // new client render path, and it culls itself on detonation.
  if (b.nova !== undefined && b.nova > 0) {
    w.bullets.push({
      x, y, vx: 0, vy: 0, radius: 4, life: C.NOVA_FUSE, friendly: true, owner: b.owner,
      damage: b.damage, color: b.color, pierce: 0, hitList: null, isCrit: b.isCrit,
      critX: b.critX, bossCoef: b.bossCoef, blast: b.nova, isLob: true, fx: b.fx,
      burn: b.burn, chill: b.chill, shock: b.shock,
    });
  }
}

function steerHoming(w: WorldState, b: Bullet, dt: number): void {
  const rate = b.homing;
  if (rate === undefined || rate <= 0) return;
  let bx = 0, by = 0, found = false;
  let bestD = HOMING_ACQUIRE_RANGE * HOMING_ACQUIRE_RANGE;
  if (isPvp(w)) {
    // pvp: home toward the nearest FOE PLAYER (the enemy-seeker twin), so homing weapons track
    // opponents instead of flying straight in an empty arena.
    for (const id of [...w.players.keys()].sort()) {
      const v = w.players.get(id);
      if (v === undefined) continue;
      if (!canDamagePlayer(w, b.owner, v)) continue;
      const dx = v.x - b.x, dy = v.y - b.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; bx = v.x; by = v.y; found = true; }
    }
  } else {
    for (const e of w.enemies) {
      if (e.dead || isUntargetable(e)) continue;
      const dx = e.x - b.x, dy = e.y - b.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; bx = e.x; by = e.y; found = true; }
    }
  }
  if (!found) return;
  const speed = Math.hypot(b.vx, b.vy) || 1;
  const cur = Math.atan2(b.vy, b.vx);
  let delta = Math.atan2(by - b.y, bx - b.x) - cur;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxTurn = rate * dt;
  const turn = delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta;
  const a = cur + turn;
  b.vx = Math.cos(a) * speed; b.vy = Math.sin(a) * speed;
}

// Enemy seekers (the Choir's wails): a capped turn toward the nearest standing player.
// The cap is the counterplay — hold a curve and the wail overshoots.
function steerEnemyHoming(w: WorldState, b: Bullet, dt: number): void {
  const rate = b.homing;
  if (rate === undefined || rate <= 0) return;
  let best: PlayerSim | null = null;
  let bestD = Infinity;
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0 || (isPvp(w) && isProtected(p))) continue;
    const dx = p.x - b.x, dy = p.y - b.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) return;
  const speed = Math.hypot(b.vx, b.vy) || 1;
  const cur = Math.atan2(b.vy, b.vx);
  let delta = Math.atan2(best.y - b.y, best.x - b.x) - cur;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxTurn = rate * dt;
  const turn = delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta;
  const a = cur + turn;
  b.vx = Math.cos(a) * speed;
  b.vy = Math.sin(a) * speed;
}

function bounceOffWall(w: WorldState, b: Bullet, dt: number, ev: SimEvent[]): void {
  const px = b.x - b.vx * dt, py = b.y - b.vy * dt;
  let reflected = false;
  if (isWall(w, b.x, py)) { b.vx = -b.vx; reflected = true; }
  if (isWall(w, px, b.y)) { b.vy = -b.vy; reflected = true; }
  if (!reflected) { b.vx = -b.vx; b.vy = -b.vy; }
  b.x = px; b.y = py;
  b.bounce = (b.bounce ?? 0) - 1;
  ev.push({ t: "bulletBounce", x: b.x, y: b.y, aim: Math.atan2(b.vy, b.vx), color: b.color });
}

function isLegalGrapplePoint(w: WorldState, owner: PlayerSim, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return false;
  if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 0) return false;
  if (!isBodyClear(w, x, y, owner.pr)) return false;
  for (const other of w.players.values()) {
    if (other.id === owner.id || other.isAbsent || other.hp <= 0) continue;
    if (Math.hypot(x - other.x, y - other.y) < owner.pr + other.pr) return false;
  }
  for (const enemy of w.enemies) {
    if (enemy.dead || isUntargetable(enemy)) continue;
    if (Math.hypot(x - enemy.x, y - enemy.y) < owner.pr + enemy.radius) return false;
  }
  return true;
}

function grappleDestination(
  w: WorldState,
  owner: PlayerSim,
  anchorX: number,
  anchorY: number,
  maxPull: number,
): { x: number; y: number } {
  const dx = anchorX - owner.x;
  const dy = anchorY - owner.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= owner.pr + 4) return { x: owner.x, y: owner.y };
  const travel = Math.min(maxPull, distance - owner.pr - 4);
  const ux = dx / distance;
  const uy = dy / distance;
  const steps = Math.max(1, Math.ceil(travel / C.GRAPPLE_SWEEP_STEP));
  let x = owner.x;
  let y = owner.y;
  for (let step = 1; step <= steps; step++) {
    const amount = Math.min(travel, step * C.GRAPPLE_SWEEP_STEP);
    const nextX = owner.x + ux * amount;
    const nextY = owner.y + uy * amount;
    if (!isLegalGrapplePoint(w, owner, nextX, nextY)) break;
    x = nextX;
    y = nextY;
  }
  return { x, y };
}

export interface GrapplePreview {
  anchorX: number;
  anchorY: number;
  destinationX: number;
  destinationY: number;
}

export function grapplePreview(w: WorldState, owner: PlayerSim, aim: number): GrapplePreview | null {
  const weapon = WEAPONS.mooring_nail;
  const startX = owner.x + Math.cos(aim) * 18;
  const startY = owner.y + Math.sin(aim) * 18;
  const reach = weapon.speed * weapon.life * owner.mods.bulletSpeedMult * owner.mods.bulletLifeMult;
  const endX = startX + Math.cos(aim) * reach;
  const endY = startY + Math.sin(aim) * reach;
  const anchor = firstWallContact(w, startX, startY, endX, endY);
  if (anchor === null) return null;
  const destination = grappleDestination(
    w, owner, anchor.x, anchor.y, weapon.grapple?.pull ?? 0,
  );
  return {
    anchorX: anchor.x,
    anchorY: anchor.y,
    destinationX: destination.x,
    destinationY: destination.y,
  };
}

function grappleOwnerToAnchor(
  w: WorldState,
  b: Bullet,
  x: number,
  y: number,
  ev: SimEvent[],
): void {
  if (b.owner === null || b.grapplePull === undefined || isPvp(w)) return;
  const owner = w.players.get(b.owner);
  if (owner === undefined || owner.isDown || owner.isAbsent || owner.hp <= 0
    || w.pendingBlessings.has(owner.id)) return;
  const shotSeq = b.shotSeq ?? -1;
  if (owner.lastGrappleShotSeq === shotSeq) return;
  owner.lastGrappleShotSeq = shotSeq;
  const destination = grappleDestination(w, owner, x, y, b.grapplePull);
  const startX = owner.x;
  const startY = owner.y;
  owner.x = destination.x;
  owner.y = destination.y;
  ev.push({
    t: "grappleResolved", pid: owner.id, x: startX, y: startY, tx: x, ty: y,
    dx: destination.x, dy: destination.y,
  });
}

// Swept (continuous) bullet collision. Fast rounds cover many body-widths per fixed tick —
// the Longshot's 1400px/s slug crosses ~70px per 20Hz step against swarm bodies barely 10px
// wide — so testing only the endpoint tunnels straight through small targets. The whole
// travel segment [prev -> current] is tested against the target circle; the closest point
// comes back in `sweptHit` (per-query scratch, like w.targetX/targetY) so impact FX land ON
// the target instead of wherever the bullet ended up.
const sweptHit = { x: 0, y: 0 };
function sweptBulletHit(b: Bullet, cx: number, cy: number, r: number): boolean {
  const x1 = b.x, y1 = b.y;
  const x0 = b.prevX ?? x1, y0 = b.prevY ?? y1;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2)) : 0;
  const px = x0 + dx * t, py = y0 + dy * t;
  const ddx = cx - px, ddy = cy - py;
  if (ddx * ddx + ddy * ddy >= r * r) return false;
  sweptHit.x = px;
  sweptHit.y = py;
  return true;
}

// ---- weapon effect entities (the effect wave's world-phase step) ----

// Distance from point (px,py) to the segment (x0,y0)-(x1,y1) — the wire trigger test.
function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

// Advance every weapon effect one world tick. Runs BEFORE updateEnemies (like bullets),
// so effect kills leave the array on this tick's compaction. Only the world phase steps
// effects — prediction never runs this, so effects are purely server-owned online.
function updateEffects(w: WorldState, dt: number, ev: SimEvent[]): void {
  // Orbit upkeep: the halo ring exists exactly while its owner stands with the weapon in
  // hand — equip conjures it, switching away (or going down) dismisses it.
  for (const p of w.players.values()) {
    const wep = WEAPONS[p.weapon];
    const isLive = wep.orbit !== undefined && !p.isDown && !p.isAbsent && p.hp > 0
      && !w.pendingBlessings.has(p.id)
      && (!isPvp(w) || p.spawnShieldT === 0);
    if (isLive) ensureOrbit(w, p, wep);
    else {
      for (const e of w.effects) {
        if (e.kind === "orbit" && e.owner === p.id) e.life = 0;
      }
    }
  }
  for (const e of w.effects) {
    if (e.life <= 0) continue;
    if (isPvp(w) && e.owner !== null) {
      const owner = w.players.get(e.owner);
      if (owner !== undefined && (owner.hp <= 0 || owner.respawnT > 0)) {
        e.life = 0;
        continue;
      }
    }
    switch (e.kind) {
      case "zone": updateZoneEffect(w, e, dt, ev); break;
      case "wire": updateWireEffect(w, e, dt, ev); break;
      case "orbit": updateOrbitEffect(w, e, dt, ev); break;
      case "sentry": updateSentryEffect(w, e, dt, ev); break;
      case "tether": updateTetherEffect(w, e, dt, ev); break;
      case "sanctuary": updateSanctuaryEffect(w, e, dt, ev); break;
      case "aegis": updateAegisEffect(w, e, dt, ev); break;
    }
  }
  w.effects = w.effects.filter((e) => e.life > 0);
}

// Frostline zones: standing enemies soak chill at the painted rate (slow, then freeze —
// bosses slow but never freeze, exactly like the Cryo Coating blessing).
function updateZoneEffect(w: WorldState, e: ZoneEffect, dt: number, ev: SimEvent[]): void {
  e.life -= dt;
  if (e.life <= 0) return;
  if (e.isPaved) {
    const owner = e.owner === null ? null : w.players.get(e.owner);
    if (owner !== null && (owner === undefined || owner.isAbsent)) e.life = 0;
    return;
  }
  for (const en of w.enemies) {
    if (en.dead || isUntargetable(en)) continue;
    if (Math.hypot(en.x - e.x, en.y - e.y) > e.radius + en.radius) continue;
    applyChill(en, e.chillRate * dt, ev);
  }
}

export function isPavedAt(w: WorldState, x: number, y: number): boolean {
  for (const e of w.effects) {
    if (e.kind !== "zone" || !e.isPaved || e.life <= 0) continue;
    if (Math.hypot(x - e.x, y - e.y) <= e.radius) return true;
  }
  return false;
}

// Snapwire: once armed, the first body crossing the band snaps the wire on EVERY enemy
// touching it — one authored damage event with full attribution/crit/status/knockback.
function updateWireEffect(w: WorldState, e: WireEffect, dt: number, ev: SimEvent[]): void {
  e.life -= dt;
  if (e.life <= 0) {
    // Decayed unspent: the expire tell (a snap zeroes life through its own event path).
    ev.push({ t: "wireExpired", x: (e.x + e.x2) / 2, y: (e.y + e.y2) / 2 });
    return;
  }
  if (e.arm > 0) {
    e.arm = e.arm > dt ? e.arm - dt : 0;
    if (e.arm === 0) ev.push({ t: "wireArmed", x: (e.x + e.x2) / 2, y: (e.y + e.y2) / 2 });
    return;
  }
  let isTripped = false;
  for (const en of w.enemies) {
    if (en.dead || isUntargetable(en)) continue;
    if (distToSegment(en.x, en.y, e.x, e.y, e.x2, e.y2) <= e.width + en.radius) { isTripped = true; break; }
  }
  // pvp: a FOE PLAYER crossing the armed band trips it too (the wire is cover-agnostic).
  if (!isTripped && isPvp(w)) {
    for (const v of w.players.values()) {
      if (!canDamagePlayer(w, e.owner, v)) continue;
      if (distToSegment(v.x, v.y, e.x, e.y, e.x2, e.y2) <= e.width + v.pr) { isTripped = true; break; }
    }
  }
  if (!isTripped) return;
  e.life = 0;
  ev.push({ t: "wireSnap", x: e.x, y: e.y, tx: e.x2, ty: e.y2 });
  const owner = ownerOf(w, e.owner);
  const dmg = e.damage * (owner ? currentDamageMult(owner) : 1);
  const isCrit = owner !== null && owner.mods.critChance > 0 && w.rng.next() < owner.mods.critChance;
  // Perpendicular of the wire span: snapped bodies are THROWN off the line.
  const spanX = e.x2 - e.x, spanY = e.y2 - e.y;
  const spanLen = Math.hypot(spanX, spanY) || 1;
  const perpX = -spanY / spanLen, perpY = spanX / spanLen;
  for (const en of w.enemies) {
    if (en.dead || isUntargetable(en)) continue;
    if (distToSegment(en.x, en.y, e.x, e.y, e.x2, e.y2) > e.width + en.radius) continue;
    const side = Math.sign((en.x - e.x) * perpX + (en.y - e.y) * perpY) || 1;
    strikeEnemy(w, owner, en, {
      damage: isCrit && owner ? dmg * owner.mods.critMult : dmg, isCrit,
      critX: isCrit && owner ? owner.mods.critMult : 1,
      bossCoef: WEAPON_BOSS_COEF[e.fx] ?? 1,
      puffX: en.x, puffY: en.y,
      kbDirX: perpX * side, kbDirY: perpY * side,
      isMelee: false,
      isPersistent: true,
      ownerId: e.owner, fxWeapon: e.fx,
    }, ev);
  }
  // pvp: the snap strikes every FOE PLAYER in the band too, through the ONE funnel.
  if (isPvp(w)) {
    const pdmg = pvpHitDamage(e.fx, e.damage);
    for (const vid of [...w.players.keys()].sort()) {
      const v = w.players.get(vid);
      if (v === undefined || !canDamagePlayer(w, e.owner, v)) continue;
      if (distToSegment(v.x, v.y, e.x, e.y, e.x2, e.y2) > e.width + v.pr) continue;
      const side = Math.sign((v.x - e.x) * perpX + (v.y - e.y) * perpY) || 1;
      damagePlayer(w, v, pdmg, ev, e.owner, {
        weapon: e.fx,
        dirX: perpX * side,
        dirY: perpY * side,
      });
    }
  }
  // The snap chews cover in the band too — a barrel across the wire goes down with the pack.
  // One-shot (the wire is spent this tick), so no re-hit guard is needed.
  for (const p of w.props) {
    if (distToSegment(p.x, p.y, e.x, e.y, e.x2, e.y2) > e.width + p.radius) continue;
    damageProp(w, p, e.damage, ev, owner);
  }
}

// Razor Halo: blades circle the owner and strike bodies on a per-enemy re-hit cadence;
// the flare widens the ring and lands harder while it holds.
function updateOrbitEffect(w: WorldState, e: OrbitEffect, dt: number, ev: SimEvent[]): void {
  const owner = ownerOf(w, e.owner);
  const spec = WEAPONS[e.fx].orbit;
  if (!owner || !spec) { e.life = 0; return; }
  e.x = owner.x;
  e.y = owner.y;
  // Mods can grow mid-run (blessing picks): keep the authored mapping in step.
  e.blades = Math.min(MAX_ORBIT_BLADES, spec.blades + owner.mods.extraPellets);
  e.speed = spec.speed * owner.mods.bulletSpeedMult;
  e.bladeRadius = spec.bladeRadius * owner.mods.bulletSizeMult;
  if (e.flare > 0) e.flare = e.flare > dt ? e.flare - dt : 0;
  const targetRing = e.flare > 0 ? spec.flareRing : spec.ring;
  e.ring += (targetRing - e.ring) * Math.min(1, dt * C.ORBIT_RING_EASE);
  e.angle += e.speed * dt;
  while (e.angle > Math.PI * 2) e.angle -= Math.PI * 2;
  for (const [eid, cd] of e.rehit) {
    if (cd <= dt) e.rehit.delete(eid);
    else e.rehit.set(eid, cd - dt);
  }
  const flareMult = e.flare > 0 ? spec.flareBonus : 1;
  for (const en of w.enemies) {
    if (en.dead || isUntargetable(en) || e.rehit.has(en.id)) continue;
    for (let i = 0; i < e.blades; i++) {
      const a = e.angle + (i / e.blades) * Math.PI * 2;
      const bx = e.x + Math.cos(a) * e.ring;
      const by = e.y + Math.sin(a) * e.ring;
      if (Math.hypot(en.x - bx, en.y - by) > e.bladeRadius + en.radius) continue;
      const dmg = e.damage * currentDamageMult(owner) * flareMult;
      const isCrit = owner.mods.critChance > 0 && w.rng.next() < owner.mods.critChance;
      const kbX = en.x - e.x, kbY = en.y - e.y;
      strikeEnemy(w, owner, en, {
        damage: isCrit ? dmg * owner.mods.critMult : dmg, isCrit,
        critX: isCrit ? owner.mods.critMult : 1,
        bossCoef: WEAPON_BOSS_COEF[e.fx] ?? 1,
        puffX: bx, puffY: by,
        kbDirX: kbX === 0 && kbY === 0 ? 1 : kbX, kbDirY: kbY,
        isMelee: true, meleeSource: "halo",
        ownerId: e.owner, fxWeapon: e.fx,
      }, ev);
      e.rehit.set(en.id, spec.rehit);
      break;
    }
  }
  // pvp: the blades strike FOE PLAYERS in the ring on the same per-foe re-hit cadence, through
  // the ONE funnel (a player-keyed rehit map, since player ids are strings).
  if (isPvp(w)) {
    const rehitP = (e.rehitP ??= new Map<PlayerId, number>());
    for (const [pid, cd] of rehitP) { if (cd <= dt) rehitP.delete(pid); else rehitP.set(pid, cd - dt); }
    const pdmg = pvpHitDamage(e.fx, e.damage * flareMult);
    for (const vid of [...w.players.keys()].sort()) {
      const v = w.players.get(vid);
      if (v === undefined || rehitP.has(vid) || !canDamagePlayer(w, e.owner, v)) continue;
      for (let i = 0; i < e.blades; i++) {
        const a = e.angle + (i / e.blades) * Math.PI * 2;
        const bx = e.x + Math.cos(a) * e.ring, by = e.y + Math.sin(a) * e.ring;
        if (Math.hypot(v.x - bx, v.y - by) > e.bladeRadius + v.pr) continue;
        damagePlayer(w, v, pdmg, ev, e.owner, {
          weapon: e.fx,
          dirX: v.x - e.x,
          dirY: v.y - e.y,
        });
        rehitP.set(vid, spec.rehit);
        break;
      }
    }
  }
  // Cover pressed into the ring is shredded too, on the same per-target re-hit cadence —
  // negative prop-id keys share the rehit map (enemy ids are non-negative) so the worn
  // blades never delete a wall every tick.
  for (const p of w.props) {
    if (p.breakT !== undefined || p.kind === "brazier") continue;
    const key = -1 - p.id;
    if (e.rehit.has(key)) continue;
    for (let i = 0; i < e.blades; i++) {
      const a = e.angle + (i / e.blades) * Math.PI * 2;
      const bx = e.x + Math.cos(a) * e.ring;
      const by = e.y + Math.sin(a) * e.ring;
      if (Math.hypot(p.x - bx, p.y - by) > e.bladeRadius + p.radius) continue;
      damageProp(w, p, e.damage * flareMult, ev, owner);
      e.rehit.set(key, spec.rehit);
      break;
    }
  }
}

// Prism Sentry: a destructible lane turret. Enemy contact chews it on a readable
// cadence, enemy fire hits it in updateBullets, and its bolts are ordinary owner-
// attributed bullets (kills credit the deployer; a departed deployer credits no one).
function updateSentryEffect(w: WorldState, e: SentryEffect, dt: number, ev: SimEvent[]): void {
  e.life -= dt;
  e.fireCd = Math.max(0, e.fireCd - dt);
  e.contactCd = Math.max(0, e.contactCd - dt);
  if (e.contactCd === 0) {
    for (const en of w.enemies) {
      if (en.dead || isUntargetable(en)) continue;
      if (Math.hypot(en.x - e.x, en.y - e.y) > e.radius + en.radius) continue;
      e.hp -= contactDamageOf(en);
      e.contactCd = C.SENTRY_CONTACT_CD;
      ev.push({ t: "sentryHit", x: e.x, y: e.y });
      break;
    }
  }
  if (e.hp <= 0 || e.life <= 0) {
    const why = e.hp <= 0 ? "destroyed" : "timeout";
    e.life = 0;
    ev.push({ t: "sentryDown", x: e.x, y: e.y, why });
    return;
  }
  if (e.fireCd > 0) return;
  const owner = ownerOf(w, e.owner);
  // Envelope: a turret STOPS while its owner is down or absent — autonomous fire never
  // carries a fight its owner is not standing in. (A DEPARTED owner's turret keeps the
  // attribution contract instead: it works, credits no one, and expires on its own.)
  if (owner && (owner.isDown || owner.isAbsent || owner.hp <= 0 || owner.respawnT > 0)) return;
  // Acquire the nearest target in range + line of sight: enemies in co-op, FOE PLAYERS in pvp
  // (id-sorted tiebreak for determinism). tid -2 marks a pvp foe-player lock (distinct from enemy
  // ids >= 0 and -1 "none"); the bolt itself is an owned bullet that hits foes via resolvePvpHits.
  let tx = 0, ty = 0, tid = -1;
  let bestD = e.range * e.range;
  if (isPvp(w)) {
    for (const vid of [...w.players.keys()].sort()) {
      const v = w.players.get(vid);
      if (v === undefined || !canDamagePlayer(w, e.owner, v)) continue;
      const dx = v.x - e.x, dy = v.y - e.y, d = dx * dx + dy * dy;
      if (d < bestD && hasLineOfSight(w, e.x, e.y, v.x, v.y)) { bestD = d; tx = v.x; ty = v.y; tid = -2; }
    }
  } else {
    for (const en of w.enemies) {
      if (en.dead || isUntargetable(en)) continue;
      const dx = en.x - e.x, dy = en.y - e.y, d = dx * dx + dy * dy;
      if (d < bestD && hasLineOfSight(w, e.x, e.y, en.x, en.y)) { bestD = d; tx = en.x; ty = en.y; tid = en.id; }
    }
  }
  if (tid === -1) return;
  if (owner !== null && !commitPvpOutgoingAttack(w, owner, ev)) return;
  if (tid !== e.targetEid) {
    e.targetEid = tid;
    ev.push({ t: "sentryAcquire", x: e.x, y: e.y });
  }
  const spec = WEAPONS[e.fx].sentry!;
  const aim = Math.atan2(ty - e.y, tx - e.x);
  const dmg = e.boltDamage * (owner ? currentDamageMult(owner) : 1);
  const isCrit = owner !== null && owner.mods.critChance > 0 && w.rng.next() < owner.mods.critChance;
  w.bullets.push({
    isPersistent: true,
    x: e.x + Math.cos(aim) * (e.radius + 2), y: e.y + Math.sin(aim) * (e.radius + 2),
    vx: Math.cos(aim) * e.boltSpeed, vy: Math.sin(aim) * e.boltSpeed,
    radius: e.boltRadius,
    life: (e.range * 1.15) / e.boltSpeed,
    friendly: true,
    owner: e.owner,
    damage: isCrit && owner ? dmg * owner.mods.critMult : dmg,
    color: "#c8a8ff",
    pierce: e.boltPierce,
    hitList: null,
    isCrit,
    critX: isCrit && owner ? owner.mods.critMult : 1,
    bossCoef: WEAPON_BOSS_COEF[e.fx] ?? 1,
    fx: e.fx,
  });
  e.fireCd = spec.fireCd / (owner ? currentFireRate(owner) : 1);
  ev.push({ t: "sentryShot", x: e.x, y: e.y, aim });
}

// Crooked Chain: reel the target to the owner (or the OWNER to a heavy target), then
// hold a short leash so the second press can sweep. Every window is bounded.
function updateTetherEffect(w: WorldState, e: TetherEffect, dt: number, ev: SimEvent[]): void {
  const owner = ownerOf(w, e.owner);
  if (!owner || owner.isDown || owner.hp <= 0) { e.life = 0; return; }
  const target = w.enemies.find((en) => en.id === e.eid && !en.dead);
  if (!target || isUntargetable(target)) { e.life = 0; return; }
  e.x = owner.x;
  e.y = owner.y;
  e.life -= dt;
  if (e.life <= 0) return;
  const dx = target.x - owner.x, dy = target.y - owner.y;
  const dist = Math.hypot(dx, dy) || 1;
  if (e.phase === "pull") {
    e.pullTime -= dt;
    if (dist <= e.holdDist || e.pullTime <= 0) {
      e.phase = "hold";
      e.life = Math.min(e.life, e.holdTime);
      ev.push({ t: "tetherHold", x: owner.x, y: owner.y });
      return;
    }
    const step = Math.min(dist - e.holdDist * 0.8, e.pullSpeed * dt);
    if (e.isPlayerPulled) {
      // A paused (blessing-picking) owner is frozen state — nothing may drag them.
      if (!w.pendingBlessings.has(owner.id)) {
        [owner.x, owner.y] = moveCircle(w, owner.x, owner.y, owner.pr, (dx / dist) * step, 0);
        [owner.x, owner.y] = moveCircle(w, owner.x, owner.y, owner.pr, 0, (dy / dist) * step);
      }
    } else {
      moveEnemyBy(w, target, (-dx / dist) * step, (-dy / dist) * step);
    }
    return;
  }
  // Hold: leash a standard body inside the sweep window (heavies never leash — the
  // inverted pull bought proximity, nothing more).
  if (!e.isPlayerPulled && dist > e.holdDist * 1.5) {
    const step = Math.min(dist - e.holdDist, e.pullSpeed * 0.7 * dt);
    moveEnemyBy(w, target, (-dx / dist) * step, (-dy / dist) * step);
  }
}

// Record every enemy's current position into the ring (one entry per world tick). Called at the
// START of the world step so the newest record is the previous tick's end state — i.e. exactly
// what a client rendered in the last snapshot. Stale entries for despawned enemies are pruned so
// the map stays bounded. Pure + deterministic; never read when rewindTicks is 0 (solo), so the
// golden-master behavior is unchanged.
export function recordHistory(w: WorldState): void {
  const H = C.LAGCOMP_HISTORY;
  w.histHead = (w.histHead + 1) % H;
  const slot = w.histHead;
  for (const e of w.enemies) {
    let h = w.enemyHist.get(e.id);
    if (!h) { h = { x: new Array(H).fill(e.x), y: new Array(H).fill(e.y) }; w.enemyHist.set(e.id, h); }
    h.x[slot] = e.x; h.y[slot] = e.y;
  }
  if (w.histCount < H) w.histCount++;
  // Prune history for enemies no longer present (killed/removed) so the map can't grow forever.
  if (w.enemyHist.size > w.enemies.length) {
    const live = new Set<number>();
    for (const e of w.enemies) live.add(e.id);
    for (const id of w.enemyHist.keys()) if (!live.has(id)) w.enemyHist.delete(id);
  }
  // pvp lag-comp: record PLAYER positions into the SAME ring (same slot/head/count), so a pvp
  // shooter's hit test can rewind a target player exactly as PvE rewinds a target enemy. Only
  // in pvp, so co-op keeps an empty playerHist and zero extra work.
  if (isPvp(w)) {
    for (const p of w.players.values()) {
      let h = w.playerHist.get(p.id);
      if (!h) { h = { x: new Array(H).fill(p.x), y: new Array(H).fill(p.y) }; w.playerHist.set(p.id, h); }
      h.x[slot] = p.x; h.y[slot] = p.y;
    }
    if (w.playerHist.size > w.players.size) {
      for (const id of w.playerHist.keys()) if (!w.players.has(id)) w.playerHist.delete(id);
    }
  }
}

// The position of enemy `e` as the shooter saw it `rewindTicks` ticks ago (offset rewindTicks-1
// into the ring; rewind 1 == the most recent recorded tick). rewindTicks <= 0 returns the
// present authoritative position (the solo/prediction path — identical behavior). Clamped to the
// history window + LAGCOMP_MAX_TICKS so a hit can never be rewound to an impossible time.
// Effective rewind depth for a hit whose lag-comp is anchored at FIRE time. As the projectile/
// swing ages, the shooter's past view converges to the present, so the rewind shrinks one tick
// per tick and reaches 0 — after which collisions test present positions (correct for slow
// projectiles). bornTick/lagRewind undefined (solo, enemy fire) => 0 (present-time), unchanged.
export function fireTimeRewind(w: WorldState, bornTick: number | undefined, lagRewind: number | undefined): number {
  if (bornTick === undefined || lagRewind === undefined || lagRewind <= 0) return 0;
  const age = w.tick - bornTick;
  const eff = lagRewind - (age > 0 ? age : 0);
  return eff > 0 ? eff : 0;
}

export function rewoundEnemyPos(w: WorldState, e: Enemy, rewindTicks: number): [number, number] {
  if (rewindTicks <= 0) return [e.x, e.y];
  const r = Math.min(rewindTicks, C.LAGCOMP_MAX_TICKS, w.histCount);
  if (r <= 0) return [e.x, e.y];
  const h = w.enemyHist.get(e.id);
  if (!h) return [e.x, e.y];
  const slot = (w.histHead - (r - 1) + C.LAGCOMP_HISTORY * 2) % C.LAGCOMP_HISTORY;
  return [h.x[slot], h.y[slot]];
}

// The pvp twin of rewoundEnemyPos: the position of PLAYER `p` as the shooter saw it `rewindTicks`
// ago, bounded to the same history window so a high-latency shooter can never kill someone who
// already broke line-of-sight beyond the window. rewindTicks <= 0 returns the present position.
function rewoundPlayerPos(w: WorldState, p: PlayerSim, rewindTicks: number): [number, number] {
  if (rewindTicks <= 0) return [p.x, p.y];
  const r = Math.min(rewindTicks, C.LAGCOMP_MAX_TICKS, w.histCount);
  if (r <= 0) return [p.x, p.y];
  const h = w.playerHist.get(p.id);
  if (!h) return [p.x, p.y];
  const slot = (w.histHead - (r - 1) + C.LAGCOMP_HISTORY * 2) % C.LAGCOMP_HISTORY;
  return [h.x[slot], h.y[slot]];
}

// Reinforcement waves (§4): pending units trickle in whenever the LIVING active threat has
// room under the ActiveThreatCap, staggered so a wave reads as a wave (Emberreach
// reinforces faster). Deterministic — pure function of state, positions pre-rolled at
// floor generation, spawn grace protects fairness.
function releaseReinforcements(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.pendingSpawns.length === 0) return;
  w.spawnReleaseCd -= dt;
  if (w.spawnReleaseCd > 0) return;
  let living = 0;
  let livingBodies = 0;
  let livingMovers = 0;
  let livingBrutes = 0;
  let livingElites = 0;
  let livingControllers = 0;
  for (const e of w.enemies) {
    if (e.dead || isBossKind(e.kind)) continue;
    // Summons count too (envelope: summons cost threat) — a decoy or a ward holds real
    // live budget until it resolves.
    living += threatCostOf(e.kind, e.tier);
    livingBodies++;
    if (isComplexMover(e.kind)) livingMovers++;
    if (e.tier === "brute") livingBrutes++;
    if (e.tier === "elite") livingElites++;
    if (isControllerKind(e.kind)) livingControllers++;
  }
  const cap = activeThreatCap(w.floor) * coopThreatMult(w.encounterPlayers);
  const moverCap = activeMoverCapFor(w.encounterPlayers);
  // The head of the queue releases when it fits EVERY live budget (threat cap, body
  // cap, and the envelope's per-class simultaneity caps). A blocked unit never
  // head-blocks the queue: the first releasable unit behind it goes instead,
  // preserving order otherwise.
  let idx = -1;
  for (let i = 0; i < w.pendingSpawns.length; i++) {
    const cand = w.pendingSpawns[i];
    if (living + threatCostOf(cand.kind, cand.tier) > cap) continue;
    if (livingBodies >= LIVE_CAPS.bodies) continue;
    if (isComplexMover(cand.kind) && livingMovers >= moverCap) continue;
    if (cand.tier === "brute" && livingBrutes >= LIVE_CAPS.brutes) continue;
    if (cand.tier === "elite" && livingElites >= LIVE_CAPS.elites) continue;
    if (isControllerKind(cand.kind) && livingControllers >= LIVE_CAPS.controllers) continue;
    idx = i;
    break;
  }
  if (idx === -1) return;
  // Its spawn grace never ticked while pending, so it activates with the full grace window.
  const next = w.pendingSpawns.splice(idx, 1)[0];
  w.enemies.push(next);
  w.spawnReleaseCd = REINFORCE_STAGGER / BIOME_PRESSURE[biomeIndexForFloor(w.floor)].reinforceRate;
  ev.push({ t: "enemySpawn", eid: next.id, kind: next.kind, tier: next.tier, x: next.x, y: next.y });
}

function updateEnemies(w: WorldState, dt: number, ev: SimEvent[]): void {
  // Stage C: every strike is attributed to the player who caused it (bullet.owner / swing owner
  // / burn igniter), NOT a single "primary player". Kills/coins/combo/lifesteal go to the right
  // authoritative player. Solo resolves to the one player, so behavior is unchanged.
  tickReleaseArbiter(w, dt);
  releaseReinforcements(w, dt, ev);
  refreshNav(w, dt);
  // Reaper soul shards born this pass. Buffered and flushed AFTER the enemy loop so a
  // fresh shard never hit-tests inside the tick that spawned it (it visibly flies first,
  // and the loop never iterates a mutating bullet list).
  const shardSpawns: Bullet[] = [];
  for (const e of w.enemies) {
    tickStatuses(w, e, dt, ev);
    if (e.dead) continue;
    if (e.captainPhase !== undefined) tickCaptainPhase(w, e, ev);
    if (e.spawnTimer > 0) e.spawnTimer = e.spawnTimer > dt ? e.spawnTimer - dt : 0;
    if (e.attack.cooldown > 0) e.attack.cooldown = e.attack.cooldown > dt ? e.attack.cooldown - dt : 0;
    if (e.braceCd !== undefined && e.braceCd > 0) e.braceCd = e.braceCd > dt ? e.braceCd - dt : 0;
    // Earned windows: the exposed timer runs on the world clock (never attack-state
    // bound), and its remainder rides the aux channel so clients render guard/exposed.
    if (e.boss && EARNED_WINDOWS[e.kind] !== undefined) {
      if (e.boss.exposed > 0) e.boss.exposed = e.boss.exposed > dt ? e.boss.exposed - dt : 0;
      if (e.boss.exposed === 0) e.boss.windowBank = 0;
      e.aux = e.boss.exposed;
    }
    // The soft-enrage yardstick: seconds spent in the current phase (R framework).
    if (e.boss) e.boss.phaseTime += dt;
    if (e.panicTime > 0) e.panicTime = e.panicTime > dt ? e.panicTime - dt : 0;
    // The echoed elite's scheduled repeat: the last ranged release refires once, along
    // the same locked bearing, from wherever the body now stands.
    if (e.echoTime > 0) {
      e.echoTime = e.echoTime > dt ? e.echoTime - dt : 0;
      if (e.echoTime === 0) refireEcho(w, e, ev);
    }
    // Boss pack-surge order: the delay elapses, then a short burst of chase speed.
    if (e.surgeDelay > 0) {
      e.surgeDelay -= dt;
      if (e.surgeDelay <= 0) {
        e.surgeDelay = 0;
        e.surgeTime = BOSS.packSurgeDuration;
        // The commander's ordered surge lands: ONE aggregate cue off the leader (the
        // flock's lock beat), never a voice per surged body.
        if (e.tier === "elite" && eliteAffixOf(e.kind) === "commander") {
          ev.push({ t: "cue", name: "flock.surge", x: e.x, y: e.y, rate: 1, gain: 0.65, trauma: 0 });
        }
      }
    } else if (e.surgeTime > 0) {
      e.surgeTime = e.surgeTime > dt ? e.surgeTime - dt : 0;
    }

    updateEnemyAI(w, e, dt, ev);
    applyKnockbackDecay(w, e, dt);

    const isMoving = e.attack.phase === "none" || (e.attack.phase === "active" && isRushMove(e.attack.move));
    e.hopMove += ((isMoving ? 1 : 0) - e.hopMove) * Math.min(1, dt * 9);
    e.hopClock += dt * (1 + e.hopMove * 1.5);

    for (const victim of w.players.values()) {
      if (!isProtected(victim) && !victim.isDown && !victim.isAbsent && victim.hp > 0
        && Math.hypot(victim.x - e.x, victim.y - e.y) < victim.pr + e.radius && canTouchDamage(e)) {
        damagePlayer(w, victim, contactDamageOf(e), ev);
        // A connecting line commitment (skeleton lunge, charger/MARROW rush) shoves the
        // victim along the committed angle — the hit reads as impact, not overlap.
        if (isRushMove(e.attack.move) && e.attack.phase === "active") lungeImpact(w, victim, e, ev);
        applyThorns(w, victim, victim, e, ev);
        // Solo aborts the enemy loop on death (game over). Co-op and the authoritative shared
        // world keep processing — a downed player doesn't stop the world.
        if (victim.hp <= 0 && !w.isCoop && !w.isShared) return;
      }
    }

    // Underground: every round and swing passes over it (see isUntargetable).
    const isBelowGround = isUntargetable(e);

    for (const b of w.bullets) {
      if (isBelowGround || !b.friendly) continue;
      // A SPENT round stops mattering the instant it lands. Bullets are only culled at the
      // next updateBullets pass, so without this guard a pierce-0 round that just died on
      // one body could strike every other body overlapping its final segment in the same
      // tick — phantom pierce that quietly inflated pack damage (~50% on tight clumps)
      // past everything the balance tables authorize. Piercing rounds keep life > 0
      // by design, so legitimate multi-hits are untouched (chests already apply this
      // same spent-round rule).
      if (b.life <= 0) continue;
      // Breach shells are artillery: they sail OVER bodies and detonate only where the
      // charged arc lands (or on a wall face) — never on contact.
      if (b.isLob) continue;
      if (b.hitList && b.hitList.indexOf(e) !== -1) continue;
      // Immutable attribution: the bullet keeps flying and dealing damage after its owner leaves
      // (shooter null) — it just credits no one. Never re-attributed to another live player.
      const shooter = ownerOf(w, b.owner);
      // Lag comp anchored at FIRE time (decays as the bullet travels): a hitscan-fast shot tests
      // the shooter's fire-time view; a slow projectile tests present positions. 0 in solo.
      const [btx, bty] = rewoundEnemyPos(w, e, fireTimeRewind(w, b.bornTick, b.lagRewind));
      // Formation guards (rootward / P1 marshal) reach a little PAST the body: allies
      // trailing the guard's shadow get real cover. The pad only matters to the guard —
      // a graze through it that the arc does not cover passes clean.
      const guardPad = guardPadOf(e);
      const isBodyHit = sweptBulletHit(b, btx, bty, b.radius + e.radius);
      const isGuardHit = !isBodyHit && guardPad > 0 && sweptBulletHit(b, btx, bty, b.radius + e.radius + guardPad);
      if (isBodyHit || isGuardHit) {
        // Mortar shells never strike directly — the blast IS the payload (the direct
        // target is inside the radius and takes exactly one blast hit; explosions are
        // the one ranged answer a guard cannot eat).
        if (b.blast !== undefined) {
          detonateBullet(w, b, sweptHit.x, sweptHit.y, ev);
          continue;
        }
        // Same contract for the Lodestone: the implosion IS the payload — the direct
        // target sits inside the radius, takes exactly one splash hit, and gets pulled.
        if (b.implode !== undefined) {
          implodeBullet(w, b, sweptHit.x, sweptHit.y, ev);
          continue;
        }
        // A formation guard swallows a non-piercing shot arriving inside its slow arc.
        if (isGuardBlocked(e, b)) {
          b.enemyHits = (b.enemyHits ?? 0) + 1;
          b.life = 0;
          ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
          continue;
        }
        if (!isBodyHit) continue; // pad graze the guard did not cover: flies on
        b.enemyHits = (b.enemyHits ?? 0) + 1;
        // The shielder's front arc swallows the shot: no damage, the round is spent.
        if (isShieldBlocked(e, b.vx, b.vy)) {
          b.life = 0;
          ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
          continue;
        }
        // A bulwark elite's directional plate absorbs the round instead (until it breaks).
        if (absorbOnBulwark(e, b, ev)) continue;
        // Rolled elite affixes: the shielded slab absorbs a frontal round, or the armed reflect
        // facet bounces it back as a hostile bolt (and cracks). Both frontal, non-piercing only.
        if (absorbOnRollSlab(e, b, ev)) continue;
        if (reflectFrontalBullet(w, e, b, ev)) continue;
        let strikeDmg = b.damage * phaseLineOfSightDamageMult(w, b, btx, bty);
        // Sidewinder: same-target repeat (2nd arc into one body lands reduced) + the rear
        // flank bonus (non-boss only; boss-grade / captains / giants get no rear vuln).
        if (b.sidewinderArc !== undefined) {
          if (b.owner !== null
            && !w.sameTargetWindow.admit(procKey(b.owner, e.id, "sidewinder"), w.waveBClock)) {
            strikeDmg *= C.WAVE_B_SAME_TARGET_REPEAT;
          }
          if (!isBossGradeKind(e)) {
            const contact = Math.atan2(sweptHit.y - e.y, sweptHit.x - e.x);
            const rear = b.sidewinderAim ?? Math.atan2(b.vy, b.vx);
            if (Math.abs(normalizeAngle(contact - rear)) <= WEAPONS.sidewinder.sidewinder!.flankArc) {
              strikeDmg *= 1 + WEAPONS.sidewinder.sidewinder!.flankBonus;
            }
          }
        }
        strikeEnemy(w, shooter, e, {
          damage: strikeDmg, isCrit: b.isCrit, critX: b.critX ?? 1, bossCoef: b.bossCoef ?? 1, puffX: sweptHit.x, puffY: sweptHit.y, kbDirX: b.vx, kbDirY: b.vy,
          burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
          isPersistent: b.isPersistent,
          ownerId: b.owner, fxWeapon: b.fx ?? null,
        }, ev);
        // Red Pen ink marks the body it hits (refreshes the mark + its snap-scaling damage).
        if (b.isPenInk === true && b.owner !== null) {
          const inkOwner = w.players.get(b.owner);
          if (inkOwner !== undefined) {
            inkOwner.penMarks.set(e.id, { life: WEAPONS.red_pen.rewrite!.markDur, lastInkDmg: strikeDmg });
          }
        }
        // Resonant Fork: a primary hit opens/refreshes the owner's tune link off this body.
        if (b.isForkPrimary === true && b.owner !== null && !e.dead) {
          const forkOwner = w.players.get(b.owner);
          if (forkOwner !== undefined) openForkLink(w, forkOwner, e);
        }
        // Crosscurrent (blessing): the round chains bounded damage to nearby bodies once.
        if ((b.crosscurrentJumps ?? 0) > 0) {
          crosscurrentJump(w, shooter, b, e, ev);
          b.crosscurrentJumps = 0;
        }
        // Faultlink: a primary hit marks the body, forms the seam, or echoes across it.
        if (b.isFaultPrimary === true && b.owner !== null) {
          const faultOwner = w.players.get(b.owner);
          if (faultOwner !== undefined) faultOnPrimaryHit(w, faultOwner, e, strikeDmg, ev);
        }
        // Lamplighter: a LIT round plants a safe patch on its FIRST enemy hit (once).
        if (b.isLampShot === true && b.lampLit === true && b.owner !== null) {
          const lampOwner = w.players.get(b.owner);
          if (lampOwner !== undefined) plantLampPatch(w, lampOwner, sweptHit.x, sweptHit.y, ev);
          b.isLampShot = false;
          b.lampLit = false;
        }
        // The Reaper's harvest: a KILLING round bursts the body into seeking shards
        // (shards carry the field too, so kills cascade at geometrically decaying damage).
        if (e.dead && b.killShards !== undefined && b.killShards > 0) {
          spawnKillShards(w, b, e.x, e.y, shardSpawns);
        }
        // The caskbellows' rear crank: a hit on its back mid-commitment staggers it.
        if (!e.dead) maybeCrankStagger(e, b, ev);
        if (b.chain !== undefined && b.chain > 0) {
          (b.hitList ??= []).push(e);
          arcLightning(w, shooter, e, b.chain ?? 0, b.chainRange ?? 130, b.damage * 0.7, b.color, (b.hitList ??= []), ev);
          b.life = 0;
        } else if (b.pierce > 0) { b.pierce--; (b.hitList ??= []).push(e); }
        else b.life = 0;
      }
    }

    // Each player resolves their own melee swing against this enemy (solo: one player).
    for (const player of w.players.values()) {
      if (isBelowGround) break;
      const swing = player.meleeSwing;
      if (!swing || swing.timer <= 0) continue;
      if (swing.hitList && swing.hitList.indexOf(e) !== -1) continue;
      // Fire-time lag comp for the whole swing: BOTH actors evaluate at fire time while the
      // rewind is active (attacker = swing-start pose, target = rewound position).
      const [mtx, mty] = rewoundEnemyPos(w, e, fireTimeRewind(w, swing.bornTick, swing.lagRewind));
      const [sx, sy] = swingPose(w, player, swing);
      if (isPointInMeleeHit(sx, sy, mtx, mty, e.radius, swing)) {
        const kbDirX = Math.cos(swing.aim);
        const kbDirY = Math.sin(swing.aim);
        const puffDist = swing.isThrust ? swing.reach * 0.65 : swing.reach * 0.55;
        strikeEnemy(w, player, e, {
          damage: swing.damage, isCrit: swing.isCrit,
          critX: swing.isCrit ? player.mods.critMult : 1, bossCoef: swing.bossCoef,
          puffX: player.x + kbDirX * puffDist, puffY: player.y + kbDirY * puffDist,
          kbDirX, kbDirY, burn: swing.burn, chill: swing.chill, shock: swing.shock,
          isMelee: true, meleeSource: "swing", isThrust: swing.isThrust,
          ownerId: player.id, fxWeapon: null,
        }, ev);
        (swing.hitList ??= []).push(e);
      }
    }
  }
  for (const shard of shardSpawns) w.bullets.push(shard);
  w.enemies = w.enemies.filter((e) => !e.dead);
}

// The Reaper's kill shards: an even deterministic fan off the corpse (the homing does the
// aiming), each at KILL_SHARD_DMG_FRAC of the killing round. The cascade is bounded by
// construction: damage halves per generation and stops under KILL_SHARD_MIN_DMG.
function spawnKillShards(w: WorldState, b: Bullet, ex: number, ey: number, out: Bullet[]): void {
  const count = b.killShards ?? 0;
  const damage = b.damage * C.KILL_SHARD_DMG_FRAC;
  if (count <= 0 || damage <= 0) return;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({
      x: ex, y: ey,
      vx: Math.cos(a) * C.KILL_SHARD_SPEED,
      vy: Math.sin(a) * C.KILL_SHARD_SPEED,
      radius: C.KILL_SHARD_RADIUS,
      life: C.KILL_SHARD_LIFE,
      friendly: true,
      owner: b.owner,
      damage,
      color: b.color,
      pierce: 0,
      hitList: null,
      isCrit: false,
      bossCoef: b.bossCoef,
      fx: b.fx,
      homing: C.KILL_SHARD_HOMING,
      killShards: damage * C.KILL_SHARD_DMG_FRAC >= C.KILL_SHARD_MIN_DMG ? count : undefined,
      bornTick: w.tick,
      lagRewind: 0,
    });
  }
}

function canTouchDamage(e: Enemy): boolean {
  if (e.touchDamage <= 0) return false; // decoys (echo/knell) are fake bodies, not threats
  if (isUntargetable(e)) return false; // an underground burrower neither deals nor takes touch
  if (e.kind === "ghost") return e.attack.windup >= C.GHOST_SOLID_AT;
  if (e.kind === "boss" && e.attack.move === "hopslam" && e.attack.phase === "active") return false;
  return true;
}

// A body that is temporarily OUT OF PLAY: bullets, swings, arcs, blasts and barrel
// explosions all pass over it, and it neither deals nor takes touch. Every window is
// bounded by construction (hard caps on travel/fade/air-time/beat duration):
//  - burrower: underground (tunneling, or armed under its eruption marker);
//  - Hollow Choir: mid-fade drift, or scattered into wisps for its split beat;
//  - Weaver: airborne during the descent/blink traverse (≤0.4s, the knot is the
//    counterplay), or UP THE WALLS through the P2 climb — bounded by climbMax and
//    always with alternate targets (the egg-sac clutch, the spiderlings): DPS is
//    redirected, never idle-punished.
//  - Hollow Choir: also its bounded singing refrain as a verse lands (the fragments
//    ARE the target — silencing them is the window).
function isUntargetable(e: Enemy): boolean {
  // Known by Touch: a live reveal strips EVASION untargetability (a diving burrower, a
  // faded choir, a blinking weaver) — never a boss guard (the quorum core stays shielded).
  if (e.revealT > 0 && (e.kind === "burrower" || e.kind === "choir" || e.kind === "weaver")) {
    return false;
  }
  const a = e.attack;
  switch (e.kind) {
    case "burrower":
      return (a.move === "dive" && a.phase === "active") || (a.move === "erupt" && a.phase === "windup");
    case "choir":
      return (a.move === "fade" && a.phase === "active") || a.move === "split"
        || (a.move === "harmonize" && a.phase === "active");
    case "weaver":
      return ((a.move === "pounce" || a.move === "blink") && a.phase === "active")
        || (a.move === "dive" && a.phase === "active");
    case "quorum":
      // The CORE is guarded behind the husk trio: untargetable while a husk stands (P1,
      // huskGuardUp) and through the merge beat — shoot the husks. When the trio is cleared the
      // core is EXPOSED (targetable) for the reform window, then the trio re-forms and re-gates.
      return e.boss !== null && ((e.boss.phase < 2 && e.boss.huskGuardUp) || a.move === "merge");
    default:
      return false;
  }
}

// The straight-line commitments that shove on impact (skeleton lunge, charger/MARROW
// rush, the sinderling's flame jet).
function isRushMove(move: AttackMove): boolean {
  return move === "lunge" || move === "rush";
}

// Whether a rusher is overlapping any standing player (the connect test that ends a rush).
function isTouchingAnyPlayer(w: WorldState, e: Enemy): boolean {
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) < p.pr + e.radius) return true;
  }
  return false;
}

// Damage tiers (§3): light/contact stays 1 at every floor; only a brute's authored,
// clearly telegraphed commitment (the skeleton's lunge or the charger's rush, mid-active)
// deals the heavy 2.
function contactDamageOf(e: Enemy): number {
  if (e.tier === "brute" && (e.kind === "skeleton" || e.kind === "charger") && e.attack.phase === "active") return BRUTE_HEAVY_DAMAGE;
  return e.touchDamage;
}

function lungeImpact(w: WorldState, p: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  const push = 26, ang = e.attack.lockedAngle;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, Math.cos(ang) * push, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, Math.sin(ang) * push);
  ev.push({ t: "trauma", amount: 0.16 });
}

function applyThorns(w: WorldState, src: PlayerSim, victim: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  if (victim.mods.thorns <= 0 || e.dead) return;
  damageEnemy(w, victim.id, e, victim.mods.thorns, ev);
  ev.push({ t: "thornsHit", eid: e.id, x: e.x, y: e.y, radius: e.radius, dmg: victim.mods.thorns, tint: ENEMY_ARCHETYPES[e.kind].tint });
  if (e.hp <= 0 && !e.dead) killEnemy(w, src, e, ev);
}

// ---- enemy AI ----

// The elite's one visible affix COMMITMENT (balancer final): the first time it is
// bloodied (≤70% HP) — and again off a cooldown that keeps the duty cycle ≤35% — it
// BRACES: a 0.9s defensive slide away from its target at ≤25% damage reduction (never
// immunity), then a ≥0.5s recover. Gauntlet captains run their own two-phase contract
// and never brace.
function updateEliteBrace(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  const a = e.attack;
  if (a.move === "brace") {
    a.time += dt;
    if (a.phase === "windup") {
      a.windup = Math.min(1, a.time / ELITE_BRACE.duration);
      // The reposition: strafe PERPENDICULAR to the fire line (deterministic side by id
      // parity) — in-flight bullets aimed at the old position miss, which is the visible
      // payoff of the commitment.
      if (findTarget(w, e.x, e.y)) {
        const toward = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        const strafe = toward + (e.id % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
        moveEnemyBy(w, e, Math.cos(strafe) * ELITE_BRACE.slideSpeed * dt, Math.sin(strafe) * ELITE_BRACE.slideSpeed * dt);
      }
      if (a.time >= ELITE_BRACE.duration) enterRecover(e);
      return true;
    }
    if (a.phase === "recover") {
      if (a.time >= ELITE_BRACE.recover) {
        enterIdle(e);
        e.braceCd = ELITE_BRACE.cooldown;
      }
      return true;
    }
  }
  // Trigger only from idle (a brace never cancels a committed telegraph).
  if (a.phase === "none" && (e.braceCd ?? 0) <= 0 && e.hp <= e.maxHp * ELITE_BRACE.triggerHpFrac) {
    beginWindup(e, "brace");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.3, gain: 0.45, trauma: 0 });
    return true;
  }
  return false;
}

function updateEnemyAI(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  // Commander-panic: a leaderless body SCATTERS — flees the nearest player and starts
  // nothing from idle. A committed telegraph still finishes (a panic never deletes an
  // already-visible attack), so the read stays honest.
  if (e.panicTime > 0 && e.attack.phase === "none") {
    if (findTarget(w, e.x, e.y)) {
      const away = Math.atan2(e.y - w.targetY, e.x - w.targetX);
      applyChaseStep(w, e, dt, away, e.speed * ELITE_COMMANDER.panicSpeedMult * dt);
    }
    return;
  }
  // Rolled-affix per-tick upkeep (hazardTrail drips, reflect facet re-arm): passive, so it
  // never consumes the tick — the chassis/kind AI and the kind-baseline elite affix run below.
  if (e.rollAffix !== "") stepRollAffix(w, e, dt);
  // Deep-boss affix (the extra telegraphed pattern): a parallel cadence that blooms telegraphed
  // charge hazards; never touches the boss's own attack machine, so it layers cleanly.
  if (e.boss !== null && w.floorDescriptor.bossAffix !== null) stepBossAffix(w, e, dt, ev);
  if (e.tier === "elite" && e.captainPhase === undefined && updateEliteAffix(w, e, dt, ev)) return;
  switch (e.kind) {
    case "spitter": updateSpitter(w, e, dt, ev); return;
    case "bat": updateFlocker(w, e, dt); return;
    case "skeleton": updateSkeleton(w, e, dt, ev); return;
    case "ghost": updateGhost(w, e, dt, ev); return;
    case "charger": updateCharger(w, e, dt, ev); return;
    case "burrower": updateBurrower(w, e, dt, ev); return;
    case "orbiter": updateOrbiter(w, e, dt, ev); return;
    case "shielder": updateShielder(w, e, dt, ev); return;
    case "rootward": updateRootward(w, e, dt, ev); return;
    case "echojack": updateEchojack(w, e, dt, ev); return;
    case "seamcutter": updateSeamcutter(w, e, dt, ev); return;
    case "caskbellows": updateCaskbellows(w, e, dt, ev); return;
    case "sinderling": updateSinderling(w, e, dt, ev); return;
    case "mason": updateMason(w, e, dt, ev); return;
    case "fragment": updateFragment(w, e, dt, ev); return;
    case "echo": updateEcho(e, dt, ev); return;
    case "knell": updateKnell(w, e, dt, ev); return;
    case "knot": updateKnot(w, e, dt, ev); return;
    case "sac": return; // inert: the clutch is an objective, not an actor
    case "marshal": updateMarshal(w, e, dt, ev); return;
    case "toll": updateToll(w, e, dt, ev); return;
    case "boss": updateBoss(w, e, dt, ev); return;
    case "marrow": updateMarrow(w, e, dt, ev); return;
    case "choir": updateChoir(w, e, dt, ev); return;
    case "weaver": updateWeaver(w, e, dt, ev); return;
    case "gilded": updateGilded(w, e, dt, ev); return;
    case "jet": updateJet(w, e, dt, ev); return;
    case "tithe": updateTithe(w, e, dt, ev); return;
    case "quorum": updateQuorum(w, e, dt, ev); return;
    case "tithe_slab": return; // inert: a destructible feeding slab, not an actor
    case "quorum_shield": updateQuorumHusk(w, e, dt); return;
    case "quorum_heal": updateQuorumHusk(w, e, dt); return;
    case "quorum_dmg": updateQuorumHusk(w, e, dt); return;
    case "tithe_tribute": updateTitheTribute(w, e, dt, ev); return;
    case "quorum_splinter": updateQuorumSplinter(w, e, dt); return;
    case "jet_echo": updateJetEcho(w, e, dt, ev); return;
    case "gorge": updateGiant(w, e, dt, ev, GIANT_SPEC.gorge!); return;
    case "gorge_seam": return; // inert: a tectonic weak-point is a peel target, not an actor
    case "sever": updateSever(w, e, dt, ev); return;
    case "sever_anchor": return; // inert: resin anchor tooth is an intercept target, not an actor
    case "choirmaster": updateChoirmaster(w, e, dt, ev); return;
    case "choir_pillar": return; // inert: resonating pillar is a silence target, not an actor
    case "undertow": updateUndertow(w, e, dt, ev); return;
    case "warm_pulse": return; // inert: Warm Pulse is a carry/deposit prop, not an actor
    case "relief_vent": return; // inert: deposit/relief target, not an actor
    case "flood_front": return; // inert: untargetable flood marker, not an actor
    case "claimant": updateClaimant(w, e, dt, ev); return;
    case "claim_token": return; // inert: claim-token is a carry/pass/deposit prop, not an actor
    case "claim_socket": return; // inert: deposit socket target, not an actor
    case "wake": updateWake(w, e, dt, ev); return;
    case "warm_bier": return; // inert: the convoy body is advanced by updateWake, not self-driven
    case "convoy_blocker": return; // inert: peel target before a threshold, not an actor
    case "shadow_front": return; // inert: untargetable dark-front marker, not an actor
    case "pale": updateGiant(w, e, dt, ev, GIANT_SPEC.pale!); return;
    case "pale_seam": return; // inert: a tectonic weak-point is a peel target, not an actor
    default: updateChaser(w, e, dt); return;
  }
}

// One affix per elite, deterministic by kind (ELITE_AFFIXES). Returns true when the
// affix consumed this tick's AI (a live brace slide, a rally beat); passive affixes
// (bulwark's plate upkeep, volatile/echoed which act on death/after fire) return false
// so the chassis behavior runs unchanged.
function updateEliteAffix(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  switch (eliteAffixOf(e.kind)) {
    case "commander": return updateEliteCommander(w, e, dt, ev);
    case "bulwark":
      // The plate tracks its target SLOWLY while the body is idle (committed attacks own
      // lockedAngle themselves, and the plate rides along — an attacking bulwark faces
      // its attack). Slower than a strafing player: footwork beats it even solo.
      if (e.aux > 0 && e.attack.phase === "none" && findTarget(w, e.x, e.y)) {
        const want = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        const d = angleDiff(want, e.attack.lockedAngle);
        const maxTurn = ELITE_BULWARK.turnRate * dt;
        e.attack.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
      }
      return false;
    case "volatile":
    case "echoed":
      return false;
    default:
      return updateEliteBrace(w, e, dt, ev);
  }
}

// ---- ROLLED elite affixes (Wave 1 randomness layer) ----
// Passive per-tick upkeep for the rolled affix: hazardTrail drips its element, reflect re-arms
// its cracked facet, shielded's slab slowly tracks the target while idle. splits (killEnemy),
// reflect's bounce + shielded's absorb (the bullet loop) and enrage (applyChaseStep) live at
// their own chokepoints. Never consumes the tick — the chassis behavior runs unchanged.
function stepRollAffix(w: WorldState, e: Enemy, dt: number): void {
  switch (e.rollAffix) {
    case "hazardTrail": {
      // The body drips its element as it moves: a short-lived cinder wake every dripGap, only
      // while it is actually chasing (idle/telegraphing bodies don't paint the floor).
      if (e.attack.phase !== "none") return;
      e.affixClock += dt;
      if (e.affixClock >= ROLL_AFFIX.dripGap && findTarget(w, e.x, e.y)) {
        e.affixClock = 0;
        plantDrip(w, e.x, e.y);
      }
      return;
    }
    case "reflect": {
      // affixState > 0 = ARMED (the bright amber facet); 0 = CRACKED. A cracked facet re-arms
      // after reflectCrackCd — the ONLY window the front is safe to shoot.
      if (e.affixState <= 0) {
        e.affixClock -= dt;
        if (e.affixClock <= 0) { e.affixState = ROLL_AFFIX.reflectArmed; e.affixClock = 0; }
      }
      return;
    }
    case "shielded": {
      // The crust slab tracks its target SLOWLY while the body is idle (a committed attack owns
      // lockedAngle and the slab rides along), so footwork beats it even solo — same law as
      // bulwark, its own material read.
      if (e.affixState > 0 && e.attack.phase === "none" && findTarget(w, e.x, e.y)) {
        const want = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        const d = angleDiff(want, e.attack.lockedAngle);
        const maxTurn = ROLL_AFFIX.slabTurnRate * dt;
        e.attack.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
      }
      return;
    }
    default:
      return;
  }
}

// hazardTrail's drip: a short-lived cinder wake (reuses the cinder hazard + its render/burn),
// under the same hard cinder cap so a chased trail is a wake, never a lake.
function plantDrip(w: WorldState, x: number, y: number): void {
  if (isWall(w, x, y)) return;
  let cinders = 0;
  for (const h of w.hazards) if (h.kind === "cinder") cinders++;
  if (cinders >= C.SINDER_CINDER_CAP) return;
  w.hazards.push({
    id: w.nextHazardId++, kind: "cinder", x, y,
    radius: ROLL_AFFIX.dripRadius, life: ROLL_AFFIX.dripLife, maxLife: ROLL_AFFIX.dripLife,
  });
}

// The shielded elite's asymmetric crust slab: absorbs non-piercing bullets inside its frontal
// arc until the slab HP (aux) is spent, then FALLS for good — a directional breakable plate, its
// own material read. Never immunity: melee, blasts, pierce and the flank always work. Returns
// true when the slab ate the round.
function absorbOnRollSlab(e: Enemy, b: Bullet, ev: SimEvent[]): boolean {
  if (e.rollAffix !== "shielded" || e.affixState <= 0 || b.pierce > 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, e.attack.lockedAngle)) > ROLL_AFFIX.slabArc / 2) return false;
  e.affixState = Math.max(0, e.affixState - b.damage);
  b.life = 0;
  ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: incoming });
  if (e.affixState === 0) {
    // The slab falls: loud and final — from here the elite is just its chassis.
    ev.push({ t: "puff", x: e.x, y: e.y, n: 8, color: "#8a6f52" });
    ev.push({ t: "cue", name: "guard.break", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.06 });
  }
  return true;
}

// The reflect elite's glassy amber facet: while ARMED (aux > 0), a non-piercing frontal round is
// bounced back as a hostile bolt (a fixed chip, never the player's full damage), and the facet
// CRACKS — disarmed for reflectCrackCd (the safe window to shoot the front). Returns true when
// the shot was reflected (the player round is spent).
function reflectFrontalBullet(w: WorldState, e: Enemy, b: Bullet, ev: SimEvent[]): boolean {
  if (e.rollAffix !== "reflect" || e.affixState <= 0 || b.pierce > 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, e.attack.lockedAngle)) > ROLL_AFFIX.reflectArc / 2) return false;
  b.life = 0;
  e.affixState = 0;
  e.affixClock = ROLL_AFFIX.reflectCrackCd;
  spawnEnemyBullet(w, e.x, e.y, incoming, ROLL_AFFIX.reflectBoltSpeed, ROLL_AFFIX.reflectBoltRadius, ROLL_AFFIX.reflectBoltDamage, "#ffca6b", 2.2);
  ev.push({ t: "bulletBounce", x: e.x, y: e.y, aim: incoming, color: "#ffca6b" });
  ev.push({ t: "cue", name: "guard.break", x: e.x, y: e.y, rate: 1.2, gain: 0.7, trauma: 0.04 });
  return true;
}

// Which swarm body a splitting elite cracks into: its own kind when that kind is a swarm chassis,
// otherwise plain slimes (the universal swarm). Shards are always swarm-tier fragile bodies.
const SWARM_SPLIT_KIND: Readonly<Partial<Record<EnemyKind, EnemyKind>>> = { slime: "slime", bat: "bat" };

// splits (rolled elite affix): on death the body cracks along its pre-cracked seams into
// splitCount fragile swarm bodies (no rolled affix of their own — a split can't cascade). Never
// off a summoned body. The shards scatter from the corpse and settle onto clear ground.
function splitOnDeath(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const kin: EnemyKind = SWARM_SPLIT_KIND[e.kind] ?? "slime";
  for (let i = 0; i < ROLL_AFFIX.splitCount; i++) {
    const ang = (i / ROLL_AFFIX.splitCount) * Math.PI * 2 + e.x;
    const mx = e.x + Math.cos(ang) * (e.radius + 12);
    const my = e.y + Math.sin(ang) * (e.radius + 12);
    if (!settleSpawnPoint(w, mx, my, ENEMY_ARCHETYPES[kin].radius)) continue;
    const shard = createEnemy(kin, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      tier: "swarm", isSummoned: true, players: w.encounterPlayers,
    });
    shard.hp = shard.maxHp = Math.max(1, Math.round(e.maxHp * ROLL_AFFIX.splitHpFrac));
    shard.speed *= ROLL_AFFIX.splitSpeedMult;
    w.enemies.push(shard);
    ev.push({ t: "puff", x: shard.x, y: shard.y, n: 4, color: ENEMY_ARCHETYPES[kin].tint });
  }
  ev.push({ t: "cue", name: "enemyKill", x: e.x, y: e.y, rate: 1.1, gain: 0.6, trauma: 0.03 });
}

// The commander's synchronized ONE commit: a fixed rally beat (roar grammar — a
// stationary horn) that orders every nearby ally into the existing pack surge. Speed,
// never damage: the gate's release arbiter is untouched, and the surge lands a readable
// beat later. The cooldown rides the shared elite-affix timer (braceCd).
function updateEliteCommander(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  const a = e.attack;
  if (a.move === "roar") {
    if (a.phase === "windup") {
      a.time += dt;
      a.windup = Math.min(1, a.time / ELITE_COMMANDER.rallyWindup);
      if (a.time >= ELITE_COMMANDER.rallyWindup) {
        commanderRally(w, e, ev);
        enterRecover(e);
      }
      return true;
    }
    if (a.phase === "recover") {
      a.time += dt;
      if (a.time >= ELITE_COMMANDER.rallyRecover) {
        enterIdle(e);
        e.braceCd = ELITE_COMMANDER.rallyCooldown;
      }
      return true;
    }
  }
  if (a.phase === "none" && (e.braceCd ?? 0) <= 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)
    && Math.hypot(w.targetX - e.x, w.targetY - e.y) <= ELITE_COMMANDER.rallyTrigger) {
    beginWindup(e, "roar");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.6, gain: 0.7, trauma: 0 });
    return true;
  }
  return false;
}

function commanderRally(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  e.surgeDelay = ELITE_COMMANDER.surgeDelay;
  for (const ally of w.enemies) {
    if (ally === e || ally.dead || isBossKind(ally.kind) || ally.touchDamage <= 0) continue;
    if (Math.hypot(ally.x - e.x, ally.y - e.y) > ELITE_COMMANDER.rallyRadius) continue;
    ally.surgeDelay = ELITE_COMMANDER.surgeDelay;
  }
  ev.push({ t: "cue", name: "elite.rally", x: e.x, y: e.y, rate: 1, gain: 0.75, trauma: 0.04 });
}

// The echoed elite's repeat: refire the last ranged release along its stored bearing
// from the CURRENT position. The refire never re-arms itself, so one shot echoes once.
function refireEcho(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (e.dead) return;
  switch (e.kind) {
    case "spitter": spitterVolley(w, e, e.echoAngle, ev); return;
    case "orbiter": orbiterBolt(w, e, e.echoAngle, ev); return;
    default: return;
  }
}

function updateSkeleton(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SKELETON_WINDUP, C.SKELETON_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SKELETON_LUNGE_SPEED * C.SKELETON_LUNGE_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SKELETON_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.12 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SKELETON_LUNGE_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    // A committed charge is a physical object: crates and barrels in its path shatter.
    // Cover absorbs the telegraphed hit — and is spent doing it.
    enemySmashEnvironment(w, e.x, e.y, e.radius + 4, ev);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    if (a.time >= C.SKELETON_LUNGE_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SKELETON_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  if (dist <= C.SKELETON_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "lunge");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.6, trauma: 0 });
    return;
  }
  const chase = chaseAngle(w, e);
  applyChaseStep(w, e, dt, chase, e.speed * surgeMult(e) * dt);
}

function updateChaser(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = chaseAngle(w, e);
  let step = e.speed * dt;
  if (e.kind === "slime") step *= slimeHopPulse(e);
  step *= surgeMult(e);
  applyChaseStep(w, e, dt, angle, step);
}

// The pack-surge speed factor (the boss's P2 order AND the commander elite's rally):
// consumed by every ordinary ground walk, never by committed attack movement.
function surgeMult(e: Enemy): number {
  return e.surgeTime > 0 ? BOSS.packSurgeSpeedMult : 1;
}

// The same-kind flocker cohort for this tick (rebuilt lazily off (tick, kind)). Built by
// iterating w.enemies in array order, so it is the EXACT same set — in the exact same order
// — the old full scan filtered to, only without touching every non-flocking body. Enemy
// spawns defer to pendingSpawns (never appended mid-loop), so the first build of a tick is
// complete for the whole enemy pass; the dead check below still skips bodies killed this tick.
function flockScanFor(w: WorldState, e: Enemy): Enemy[] {
  if (w.flockScanTick === w.tick && w.flockScanKind === e.kind) return w.flockScan;
  w.flockScanTick = w.tick;
  w.flockScanKind = e.kind;
  w.flockScan.length = 0;
  for (const other of w.enemies) if (other.kind === e.kind) w.flockScan.push(other);
  return w.flockScan;
}

// Deterministic boids for the bat family. Each bat carries a persistent heading in its
// `zig` scratch (seeded at spawn, so a fresh flock fans out reproducibly) and blends four
// steering pulls into it under a capped turn rate:
//   separation (strong, inside FLOCK_SEP_RADIUS)  — never stack;
//   alignment + cohesion (with capped, deterministic array-order neighbors) — move as ONE
//   wheeling body;
//   target attraction (the flow-field chase bearing) — the flock still hunts.
// Pure state math, no RNG, bounded O(n·FLOCK_MAX_NEIGHBORS): replay-identical every run.
function updateFlocker(w: WorldState, e: Enemy, dt: number): void {
  const hasTarget = findTarget(w, e.x, e.y);
  let sepX = 0, sepY = 0;
  let aliX = 0, aliY = 0;
  let cohX = 0, cohY = 0;
  let social = 0;
  let closest = Infinity;
  // One pass over the enemy list (the same per-enemy scan shape every AI routine here
  // uses). The SOCIAL terms (alignment/cohesion) cap at FLOCK_MAX_NEIGHBORS in
  // deterministic array order; SEPARATION must instead see every body inside its small
  // radius — a capped-by-array-order pick can starve exactly the stacked pair it exists
  // to split (two late-array bats never scanning each other).
  for (const other of flockScanFor(w, e)) {
    if (other === e || other.dead || other.kind !== e.kind) continue;
    const dx = other.x - e.x, dy = other.y - e.y;
    // Bounding-box pre-reject before the sqrt: a body outside the FLOCK_RADIUS square is
    // outside the circle too, so this is bit-identical to the d >= FLOCK_RADIUS skip below,
    // it just avoids the hypot for the many far pairs a summon-heavy room produces.
    if (dx <= -C.FLOCK_RADIUS || dx >= C.FLOCK_RADIUS || dy <= -C.FLOCK_RADIUS || dy >= C.FLOCK_RADIUS) continue;
    const d = Math.hypot(dx, dy);
    if (d >= C.FLOCK_RADIUS) continue;
    if (d < closest) closest = d;
    if (d < C.FLOCK_SEP_RADIUS) {
      // A fully co-located pair has no separation axis — break the tie along each bat's
      // own id-derived bearing (golden-angle spread: stable, deterministic, never shared),
      // so an exactly-stacked pair can never become a fixed point.
      if (d < 1) {
        const tie = e.id * 2.399963;
        sepX -= Math.cos(tie);
        sepY -= Math.sin(tie);
      } else {
        const push = (C.FLOCK_SEP_RADIUS - d) / C.FLOCK_SEP_RADIUS;
        sepX -= (dx / d) * push;
        sepY -= (dy / d) * push;
      }
    }
    if (social < C.FLOCK_MAX_NEIGHBORS) {
      social++;
      aliX += Math.cos(other.zig);
      aliY += Math.sin(other.zig);
      cohX += dx;
      cohY += dy;
    }
  }
  let desX = sepX * C.FLOCK_SEP_WEIGHT;
  let desY = sepY * C.FLOCK_SEP_WEIGHT;
  // Priority arbitration: inside the hard core, separation is the ONLY voice. The shared
  // target pull focuses converging bats onto one point like rays — without this override
  // it laterally re-compresses any pair it likes back into a stack.
  const isCrowded = closest < C.FLOCK_HARD_CORE;
  if (!isCrowded && social > 0) {
    const aliLen = Math.hypot(aliX, aliY) || 1;
    desX += (aliX / aliLen) * C.FLOCK_ALIGN_WEIGHT;
    desY += (aliY / aliLen) * C.FLOCK_ALIGN_WEIGHT;
    const cohLen = Math.hypot(cohX, cohY) || 1;
    desX += (cohX / cohLen) * C.FLOCK_COHESION_WEIGHT;
    desY += (cohY / cohLen) * C.FLOCK_COHESION_WEIGHT;
  }
  if (!isCrowded && hasTarget) {
    const hunt = chaseAngle(w, e);
    desX += Math.cos(hunt) * C.FLOCK_TARGET_WEIGHT;
    desY += Math.sin(hunt) * C.FLOCK_TARGET_WEIGHT;
  }
  // No pulls at all (lone bat, no target): glide on the current heading at full speed.
  let brake = 1;
  if (desX !== 0 || desY !== 0) {
    let delta = Math.atan2(desY, desX) - e.zig;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxTurn = C.FLOCK_TURN_RATE * dt;
    e.zig += delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta;
    // Variable airspeed: a bat whose desired pull opposes its heading BRAKES (a trailing
    // bat glued to a leader's tail can fall back and slide out) — turning alone can never
    // unstack a pair flying the same axis at the same speed.
    brake = C.FLOCK_MIN_SPEED + (1 - C.FLOCK_MIN_SPEED) * Math.max(0, Math.cos(delta));
  }
  const step = e.speed * brake * dt * surgeMult(e);
  applyChaseStep(w, e, dt, e.zig, step);
}

// The charger: a slow stalker whose whole threat is one long, telegraphed straight rush.
// The lane is authored to be SIDESTEPPED (backpedaling loses — it outruns you on a line),
// and a wall crash swaps the move to "crash": a long self-stun, the authored punish window.
function updateCharger(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.CHARGER_WINDUP, C.CHARGER_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.CHARGER_RUSH_SPEED * C.CHARGER_RUSH_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.CHARGER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.8, gain: 0.85, trauma: 0.08 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    // A connect ends the rush BEFORE the next step (hit-and-stop, never a drag): the
    // contact pass already landed the damage + shove on the tick the bodies met.
    if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
    const step = C.CHARGER_RUSH_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    rushSmashEnvironment(w, e, ev); // the lane splinters FIRST — furniture never wedges a rush
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    // Wall crash: barely progressing at full commitment = it hit something solid.
    // (chill scales the intended step too, so a slowed rush is not a false crash.)
    const moved = Math.hypot(e.x - x0, e.y - y0);
    if (moved < step * chillMoveScale(e) * 0.5) {
      a.move = "crash";
      enterRecover(e);
      ev.push({ t: "chargeCrash", x: e.x, y: e.y });
      return;
    }
    if (a.time >= C.CHARGER_RUSH_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "crash" ? C.CHARGER_CRASH_STUN : C.CHARGER_RECOVER)) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.CHARGER_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "rush");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.45, gain: 0.65, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * surgeMult(e) * dt);
}

// The burrower: kite-denial. It dives (telegraph), tunnels toward the target at a speed
// multiple while untargetable (bounded), then arms a marked eruption where it stopped —
// the marker holds for the FULL windup, so the dodge is always readable. Surfacing leaves
// it exposed through the pop + recover: the punish window for holding your ground.
function updateBurrower(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "dive") {
      a.time += dt;
      a.windup = Math.min(1, a.time / C.BURROW_DIVE_WINDUP);
      if (a.time >= C.BURROW_DIVE_WINDUP) {
        a.phase = "active"; a.time = 0; a.windup = 0;
        ev.push({ t: "burrowDive", x: e.x, y: e.y });
      }
      return;
    }
    // erupt: stationary underground, marker armed — the player's reaction window.
    a.time += dt;
    a.windup = Math.min(1, a.time / C.BURROW_ERUPT_WINDUP);
    if (a.time >= C.BURROW_ERUPT_WINDUP && tryRelease(w, a.markX, a.markY, C.BURROW_ERUPT_RADIUS)) {
      burrowerErupt(w, e, ev);
    }
    return;
  }
  if (a.phase === "active") {
    if (a.move === "dive") {
      a.time += dt;
      const has = findTarget(w, e.x, e.y);
      const dist = has ? Math.hypot(w.targetX - e.x, w.targetY - e.y) : Infinity;
      if (a.time >= C.BURROW_MAX_TRAVEL || dist <= C.BURROW_EMERGE_DIST) {
        beginWindup(e, "erupt");
        a.markX = e.x; a.markY = e.y; a.isAimLocked = true;
        return;
      }
      applyChaseStep(w, e, dt, chaseAngle(w, e), C.BURROW_TRAVEL_SPEED * dt);
      return;
    }
    // The surfacing pop itself.
    a.time += dt;
    if (a.time >= C.BURROW_POP) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.BURROW_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.BURROW_TRIGGER && dist > C.BURROW_EMERGE_DIST && a.cooldown === 0 && e.spawnTimer === 0) {
    beginWindup(e, "dive");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.7, gain: 0.55, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function burrowerErupt(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  a.phase = "active"; a.time = 0; a.windup = 0;
  a.cooldown = C.BURROW_CD * attackCdMultOf(e);
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - a.markX, p.y - a.markY) < C.BURROW_ERUPT_RADIUS) damagePlayer(w, p, e.touchDamage, ev);
  }
  enemySmashEnvironment(w, a.markX, a.markY, C.BURROW_ERUPT_RADIUS, ev);
  ev.push({ t: "burrowErupt", x: a.markX, y: a.markY, r: C.BURROW_ERUPT_RADIUS });
}

// The orbiter: holds a strafing ring around the target (rotational tracking, not radial
// kiting), then STOPS to fire a quick telegraphed bolt — the stillness is the tell.
function updateOrbiter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.ORBITER_WINDUP, C.ORBITER_LOCK, false)) {
      orbiterBolt(w, e, a.lockedAngle, ev);
      a.cooldown = C.ORBITER_CD * attackCdMultOf(e);
      armEcho(e, a.lockedAngle);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.ORBITER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (a.cooldown === 0 && e.spawnTimer === 0 && dist <= C.ORBITER_RING + C.ORBITER_RING_SLACK * 2
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "spit");
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.5, gain: 0.45, trauma: 0 });
    return;
  }
  // Ring hold: strafe tangentially (seeded flip direction), blending inward/outward when
  // outside the ring's slack band.
  e.zig += dt * C.ORBITER_FLIP_RATE;
  const side = Math.sin(e.zig) >= 0 ? 1 : -1;
  let angle = toTarget + side * C.HALF_PI;
  if (dist > C.ORBITER_RING + C.ORBITER_RING_SLACK) angle = toTarget + side * (Math.PI * 0.3);
  else if (dist < C.ORBITER_RING - C.ORBITER_RING_SLACK) angle = toTarget + Math.PI - side * (Math.PI * 0.3);
  applyChaseStep(w, e, dt, angle, e.speed * dt);
}

// The orbiter's release body, shared by the live fire and the echoed repeat.
function orbiterBolt(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): void {
  const mx = e.x + Math.cos(angle) * (e.radius + 4);
  const my = e.y + Math.sin(angle) * (e.radius + 4);
  spawnEnemyBullet(w, mx, my, angle, C.ORBITER_BOLT_SPEED, C.ORBITER_BOLT_RADIUS, 1, "#8fb8ff", C.ORBITER_BOLT_LIFE);
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

// The shielder: an ordinary chaser whose front arc EATS bullets (see the bullet pass in
// updateEnemies) — the fight is a positioning question. Its guard angle is stored in
// lockedAngle (already on the wire), so the client draws exactly what the sim blocks.
function updateShielder(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SHIELDER_WINDUP, C.SHIELDER_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SHIELDER_BASH_SPEED * C.SHIELDER_BASH_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SHIELDER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.9, gain: 0.7, trauma: 0.05 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SHIELDER_BASH_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    if (a.time >= C.SHIELDER_BASH_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SHIELDER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.SHIELDER_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "lunge");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.6, gain: 0.6, trauma: 0 });
    return;
  }
  const chase = chaseAngle(w, e);
  // The guard tracks the walk (and holds through windup/recover via lockedAngle's last value).
  a.lockedAngle = chase;
  applyChaseStep(w, e, dt, chase, e.speed * dt);
}

// Whether the shielder's front arc swallows a shot arriving along `vx/vy`.
function isShieldBlocked(e: Enemy, vx: number, vy: number): boolean {
  if (e.kind !== "shielder") return false;
  const incoming = Math.atan2(-vy, -vx); // the direction the shot came FROM
  let diff = incoming - e.attack.lockedAngle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff) <= C.SHIELDER_BLOCK_ARC / 2;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// How far past the body a formation guard still eats bullets: the rootward's shadow pad,
// the marshal's wider P1 frontage. 0 everywhere else (the ordinary body-only test).
function guardPadOf(e: Enemy): number {
  if (e.kind === "rootward") return C.ROOTWARD_GUARD_PAD;
  if (e.kind === "marshal" && e.captainPhase !== 2) return MARSHAL.guardReach;
  return 0;
}

// The formation guard (rootward / P1 marshal): swallows NON-PIERCING bullets arriving
// inside its slow-turning frontal arc (anchored on lockedAngle, exactly what the wire
// carries). Piercing rounds punch through — the authored hard counter alongside the
// flank, melee over the top, and splash.
function isGuardBlocked(e: Enemy, b: Bullet): boolean {
  if (b.pierce > 0) return false;
  const arc = e.kind === "rootward" ? C.ROOTWARD_GUARD_ARC
    : e.kind === "marshal" && e.captainPhase !== 2 ? MARSHAL.guardArc
    : 0;
  if (arc === 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  return Math.abs(angleDiff(incoming, e.attack.lockedAngle)) <= arc / 2;
}

// The bulwark elite's ONE directional breakable plate: absorbs non-piercing bullets
// arriving inside its frontal arc until the plate HP (the aux channel) is spent, then
// shatters for good. Reduction of a different shape — never immunity: melee, blasts,
// pierce and the flank always work, and the plate itself is finite.
function absorbOnBulwark(e: Enemy, b: Bullet, ev: SimEvent[]): boolean {
  if (e.tier !== "elite" || e.captainPhase !== undefined || e.aux <= 0) return false;
  if (eliteAffixOf(e.kind) !== "bulwark") return false;
  if (b.pierce > 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, e.attack.lockedAngle)) > ELITE_BULWARK.arc / 2) return false;
  e.aux = Math.max(0, e.aux - b.damage);
  b.life = 0;
  ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
  if (e.aux === 0) {
    // The shatter: loud and final — from here the elite is just its chassis.
    ev.push({ t: "puff", x: e.x, y: e.y, n: 8, color: "#cfd6dd" });
    ev.push({ t: "cue", name: "guard.break", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.06 });
  }
  return true;
}

// The caskbellows' rear crank: a round landing on its BACK arc mid-commitment knocks the
// sentry into the shared crash-grammar stagger — the long punish window. The stagger
// also spends the volley (cooldown restarts), so circling behind between shots is the
// authored answer.
function maybeCrankStagger(e: Enemy, b: Bullet, ev: SimEvent[]): void {
  if (e.kind !== "caskbellows") return;
  const a = e.attack;
  if (a.phase !== "windup" && a.phase !== "active") return;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, a.lockedAngle + Math.PI)) > C.CASK_REAR_ARC / 2) return;
  a.move = "crash";
  enterRecover(e);
  a.cooldown = C.CASK_CD * attackCdMultOf(e);
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.75, trauma: 0.05 });
}

// ---- the bestiary wave: rootward / echojack / seamcutter / caskbellows / sinderling /
// ---- fragment, their decoys (echo / knell), and the mid-band miniboss templates ----

// The rootward: a walking wall with a SLOW-TURNING guard. No committed attack — it herds.
// Its guard angle lives in lockedAngle (already on the wire), turning toward the chase
// heading at a capped rate, so circling it opens the flank the shielder never gives.

// ---- worker constructions (the ecology gate's persistent topology edits) ------------
// Three workers, three materials, ONE shared law: a raise first crumbles everything the
// worker already owns (the replacement rule), then segments land only where the
// escape-route standoffs hold, and never while ANOTHER worker's construction stands in
// the same room (one persistent topology edit per room). Everything raised is a plain
// destructible prop: cover for either side, breakable by either side, navigated by the
// same prop-aware flow fields as authored furniture.

const WORKER_PROP: Readonly<Partial<Record<Enemy["kind"], PropKind>>> = {
  rootward: "root_wall",
  seamcutter: "silt_mound",
  mason: "clinker_brick",
};

function roomIndexAt(w: WorldState, x: number, y: number): number {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const rooms = w.dungeon.rooms;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return i;
  }
  return -1;
}

// The escape-route law: a segment may never sit against the wall grid (the guaranteed
// walkable gaps at a construction's ends ARE the explicit escape route — a capped,
// wall-free line can never partition a room), never near the floor exit, never stacked
// on props, and never boxed onto a body.
function isConstructionSiteClear(w: WorldState, x: number, y: number): boolean {
  if (isWall(w, x, y)) return false;
  const standoff = C.CONSTRUCT_WALL_STANDOFF * TILE;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      if (ox === 0 && oy === 0) continue;
      if (isWall(w, x + ox * standoff, y + oy * standoff)) return false;
    }
  }
  const ex = (w.dungeon.exit.x + 0.5) * TILE, ey = (w.dungeon.exit.y + 0.5) * TILE;
  if (Math.hypot(x - ex, y - ey) < C.CONSTRUCT_EXIT_STANDOFF * TILE) return false;
  if (blockedByProp(w, x, y, C.PROP_RADIUS)) return false;
  for (const pl of w.players.values()) {
    if (Math.hypot(pl.x - x, pl.y - y) < pl.pr + C.PROP_RADIUS + 6) return false;
  }
  for (const en of w.enemies) {
    if (en.dead) continue;
    if (Math.hypot(en.x - x, en.y - y) < en.radius + C.PROP_RADIUS + 2) return false;
  }
  return true;
}

function raiseConstruction(w: WorldState, e: Enemy, sites: readonly { x: number; y: number }[], ev: SimEvent[]): number {
  const kind = WORKER_PROP[e.kind];
  if (kind === undefined) return 0;
  const room = roomIndexAt(w, e.x, e.y);
  for (const p of w.props) {
    if (p.dead || p.breakT !== undefined || p.owner === undefined || p.owner === e.id) continue;
    if (room !== -1 && roomIndexAt(w, p.x, p.y) === room) return 0; // the room's one edit stands
  }
  for (const p of w.props) {
    if (p.breakT === undefined && !p.dead && p.owner === e.id) destroyProp(w, p, ev);
  }
  let placed = 0;
  for (const site of sites) {
    if (!isConstructionSiteClear(w, site.x, site.y)) continue;
    w.props.push({
      id: w.nextPropId++, kind, x: site.x, y: site.y,
      radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false, owner: e.id,
    });
    ev.push({ t: "puff", x: site.x, y: site.y, n: 5, color: ENEMY_ARCHETYPES[e.kind].tint });
    placed++;
  }
  if (placed > 0) w.obstacleRev++;
  return placed;
}

// The authoritative build footprint, pure over the attack state — the sim raises on it
// and the client previews EXACTLY it (one geometry, no drift):
//  - bailiff: an asymmetric divider across the guard facing — two segments to the
//    handed side (id parity), one to the other, a reach ahead of the body;
//  - mason: a handed L-corner whose apex points down the locked angle (at the nearest
//    player when the tell started), long arm on the handed side.
export function workerBuildSites(e: Pick<Enemy, "kind" | "id" | "attack">): { x: number; y: number }[] {
  const a = e.attack;
  const hand = e.id % 2 === 0 ? 1 : -1;
  const sites: { x: number; y: number }[] = [];
  if (e.kind === "rootward") {
    const perp = a.lockedAngle + C.HALF_PI;
    for (const k of [0, hand, -hand, 2 * hand]) {
      sites.push({
        x: a.markX + Math.cos(perp) * k * C.BAILIFF_SEG_SPACING,
        y: a.markY + Math.sin(perp) * k * C.BAILIFF_SEG_SPACING,
      });
    }
    return sites;
  }
  if (e.kind === "mason") {
    const apexX = a.markX + Math.cos(a.lockedAngle) * C.MASON_CORNER_DIST;
    const apexY = a.markY + Math.sin(a.lockedAngle) * C.MASON_CORNER_DIST;
    const longDir = a.lockedAngle + hand * (Math.PI * 0.75);
    const shortDir = a.lockedAngle - hand * (Math.PI * 0.75);
    sites.push({ x: apexX, y: apexY });
    for (let k = 1; k < C.MASON_ARM_LONG; k++) {
      sites.push({ x: apexX + Math.cos(longDir) * k * C.MASON_SEG_SPACING, y: apexY + Math.sin(longDir) * k * C.MASON_SEG_SPACING });
    }
    for (let k = 1; k <= C.MASON_ARM_SHORT; k++) {
      sites.push({ x: apexX + Math.cos(shortDir) * k * C.MASON_SEG_SPACING, y: apexY + Math.sin(shortDir) * k * C.MASON_SEG_SPACING });
    }
    return sites;
  }
  return sites;
}

function bailiffRaiseDivider(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  raiseConstruction(w, e, workerBuildSites(e), ev);
}

// The SILT KEEL's berm: the plowed material piles beside the furrow — a capped line
// marching back from where the cut ended, offset to the handed side.
function keelRaiseBerm(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const segs = Math.min(C.BERM_MAX_SEGS, Math.floor(e.aux / C.BERM_SEG_SPACING));
  if (segs <= 0) { e.aux = 0; return; }
  const back = a.lockedAngle + Math.PI;
  const perp = a.lockedAngle + C.HALF_PI;
  const hand = e.id % 2 === 0 ? 1 : -1;
  const ox = Math.cos(perp) * C.BERM_SIDE_OFFSET * hand;
  const oy = Math.sin(perp) * C.BERM_SIDE_OFFSET * hand;
  const sites: { x: number; y: number }[] = [];
  for (let k = 1; k <= segs; k++) {
    sites.push({
      x: e.x + Math.cos(back) * k * C.BERM_SEG_SPACING + ox,
      y: e.y + Math.sin(back) * k * C.BERM_SEG_SPACING + oy,
    });
  }
  if (raiseConstruction(w, e, sites, ev) > 0) {
    ev.push({ t: "cue", name: "keel.berm", x: e.x + ox, y: e.y + oy, rate: 1, gain: 0.7, trauma: 0.03 });
  }
  e.aux = 0;
}

function updateRootward(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    // The raise is a STATIONARY tell: the guard facing freezes with it, so the divider
    // footprint previewed at the mark is exactly what lands.
    a.time += dt;
    a.windup = Math.min(1, a.time / C.BAILIFF_BUILD_WINDUP);
    if (a.time >= C.BAILIFF_BUILD_WINDUP) {
      bailiffRaiseDivider(w, e, ev);
      a.cooldown = C.BAILIFF_BUILD_CD * attackCdMultOf(e);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.BAILIFF_BUILD_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const chase = chaseAngle(w, e);
  const d = angleDiff(chase, a.lockedAngle);
  const maxTurn = C.ROOTWARD_TURN_RATE * dt;
  a.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y);
  // It raises (or MOVES) the divider only when the guard faces the fight, at wall-raising
  // range, and its standing divider is gone or left behind — so the anchor advances with
  // its wall instead of bricking its own approach forever.
  if (dist <= C.BAILIFF_BUILD_TRIGGER && dist > C.BAILIFF_BUILD_MIN_DIST
    && Math.abs(angleDiff(chase, a.lockedAngle)) < C.BAILIFF_BUILD_ALIGN
    && a.cooldown === 0 && e.spawnTimer === 0 && bailiffWantsDivider(w, e)) {
    beginWindup(e, "build");
    a.markX = e.x + Math.cos(a.lockedAngle) * C.BAILIFF_DIVIDER_DIST;
    a.markY = e.y + Math.sin(a.lockedAngle) * C.BAILIFF_DIVIDER_DIST;
    return;
  }
  applyChaseStep(w, e, dt, chase, e.speed * surgeMult(e) * dt);
}

// "Raises/MOVES one divider": a re-raise happens only once the old wall is broken or the
// fight has moved past it — never a wall spammed into its own path.
function bailiffWantsDivider(w: WorldState, e: Enemy): boolean {
  let nearest = Infinity;
  for (const p of w.props) {
    if (p.dead || p.breakT !== undefined || p.owner !== e.id) continue;
    const dd = Math.hypot(p.x - e.x, p.y - e.y);
    if (dd < nearest) nearest = dd;
  }
  return nearest > C.BAILIFF_REBUILD_DIST;
}

function countLiveKind(w: WorldState, kind: Enemy["kind"]): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.kind === kind) n++;
  return n;
}

// The echojack: flee support. It keeps its distance; on cadence it PLANTS a false-noise
// decoy at its own position (a telegraphed beat — the jangling is visible), then BLINKS:
// a fast perpendicular relocation dash, deterministic side by id parity. The decoy is a
// real 1-HP body that draws homing fire and attention; the jack is already elsewhere.
function updateEchojack(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.ECHOJACK_DECOY_WINDUP);
    if (a.time >= C.ECHOJACK_DECOY_WINDUP) {
      spawnEchoDecoy(w, e, ev);
      a.phase = "active"; a.move = "blink"; a.time = 0; a.windup = 0;
      a.cooldown = C.ECHOJACK_CD * attackCdMultOf(e);
      const toTarget = findTarget(w, e.x, e.y) ? Math.atan2(w.targetY - e.y, w.targetX - e.x) : e.zig;
      a.lockedAngle = toTarget + (e.id % 2 === 0 ? C.HALF_PI : -C.HALF_PI);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.6, gain: 0.6, trauma: 0 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.ECHOJACK_BLINK_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    if (a.time >= C.ECHOJACK_BLINK_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.ECHOJACK_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (dist <= C.ECHOJACK_APPROACH && a.cooldown === 0 && e.spawnTimer === 0
    && countLiveKind(w, "echo") < C.ECHO_CAP) {
    beginWindup(e, "decoy");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.5, gain: 0.5, trauma: 0 });
    return;
  }
  if (dist < C.ECHOJACK_FLEE) {
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.ECHOJACK_APPROACH) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function spawnEchoDecoy(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const decoy = createEnemy("echo", e.x, e.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  decoy.aux = C.ECHO_LIFE;
  w.enemies.push(decoy);
  ev.push({ t: "enemySpawn", eid: decoy.id, kind: decoy.kind, tier: decoy.tier, x: decoy.x, y: decoy.y });
}

// The echo: pure noise. It stands still, counts its fuse down the aux channel, and
// expires quietly (never a kill, never loot). Shooting it works — that is the trick.
function updateEcho(e: Enemy, dt: number, ev: SimEvent[]): void {
  e.aux -= dt;
  if (e.aux <= 0) {
    e.aux = 0;
    e.dead = true;
    ev.push({ t: "puff", x: e.x, y: e.y, n: 5, color: ENEMY_ARCHETYPES.echo.tint });
  }
}

// The Toll's noise-lure: a planted bell-bomb. Harmless while the fuse (aux) burns; on
// expiry it tolls its own ring. Killed early (1 HP), it never sounds.
function updateKnell(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  e.aux -= dt;
  if (e.aux > 0) return;
  e.aux = 0;
  e.dead = true;
  for (let i = 0; i < TOLL.lureRingCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, (i / TOLL.lureRingCount) * Math.PI * 2, TOLL.lureRingSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.knell.tint, TOLL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.8, trauma: 0.06 });
}

// The seamcutter: the lane. Windup previews the whole wall-to-wall seam (the mark is the
// far wall, frozen at aim lock); active travels it at a flat speed, splintering cover
// and throwing timed PERPENDICULAR sweep bolts; the far-wall recover is the punish
// window. Cross the seam early or trail behind it — the lane never turns post-lock.
function updateSeamcutter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.SEAM_WINDUP);
    if (!a.isAimLocked) {
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      setSeamMark(w, e);
      if (a.time >= C.SEAM_LOCK) a.isAimLocked = true;
    }
    if (a.time >= C.SEAM_WINDUP
      && tryReleaseLane(w, e, a.lockedAngle, Math.hypot(a.markX - e.x, a.markY - e.y))) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.aux = 0; // the furrow odometer: how much berm the plow has earned
      a.cooldown = C.SEAM_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.7, gain: 0.85, trauma: 0.06 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SEAM_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    rushSmashEnvironment(w, e, ev); // the plow splinters its furrow — old construction is replaced
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    const moved = Math.hypot(e.x - x0, e.y - y0);
    e.aux += moved;
    if (moved < step * chillMoveScale(e) * 0.5 || a.time >= C.SEAM_MAX_DUR) {
      // The plow ends (wall or wedge): the piled silt RISES — one persistent berm
      // beside the furrow, superseding the old sweep-bolt payload.
      keelRaiseBerm(w, e, ev);
      enterRecover(e);
      ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.6, gain: 0.6, trauma: 0.04 });
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SEAM_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.SEAM_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "seam");
    setSeamMark(w, e);
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.4, gain: 0.65, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * surgeMult(e) * dt);
}

// The seam's far endpoint: a bounded ray march from the body along the locked bearing to
// the first wall (or the travel cap). Recomputed while tracking, frozen at aim lock —
// the previewed lane IS the traveled lane.
function setSeamMark(w: WorldState, e: Enemy): void {
  const a = e.attack;
  const maxDist = C.SEAM_SPEED * C.SEAM_MAX_DUR;
  const stepLen = TILE / 2;
  const cos = Math.cos(a.lockedAngle), sin = Math.sin(a.lockedAngle);
  let x = e.x, y = e.y;
  for (let d = stepLen; d <= maxDist; d += stepLen) {
    const nx = e.x + cos * d, ny = e.y + sin * d;
    if (isWall(w, nx, ny)) break;
    x = nx; y = ny;
  }
  a.markX = x;
  a.markY = y;
}

// The caskbellows: a stationary lane sentry. It locks a target, fires a 3-shot volley
// down the locked lane, and staggers hard (crash grammar — see maybeCrankStagger) when a
// round lands on its rear crank mid-commitment. It waddles back to range when crowded;
// otherwise it holds its ground and tracks.
function updateCaskbellows(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.CASK_WINDUP, C.CASK_LOCK, false)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.seq = 0;
      a.cooldown = C.CASK_CD * attackCdMultOf(e);
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    while (e.seq < C.CASK_SHOTS && a.time >= e.seq * C.CASK_SHOT_GAP) {
      const mx = e.x + Math.cos(a.lockedAngle) * (e.radius + 4);
      const my = e.y + Math.sin(a.lockedAngle) * (e.radius + 4);
      spawnEnemyBullet(w, mx, my, a.lockedAngle, C.CASK_BOLT_SPEED, C.CASK_BOLT_RADIUS, 1, ENEMY_ARCHETYPES.caskbellows.tint, C.CASK_BOLT_LIFE);
      ev.push({ t: "spitMuzzle", x: mx, y: my });
      e.seq++;
    }
    if (e.seq >= C.CASK_SHOTS && a.time >= (C.CASK_SHOTS - 1) * C.CASK_SHOT_GAP + 0.05) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "crash" ? C.CASK_STAGGER : C.CASK_RECOVER)) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  // The crank faces away from the lane: keep the lane tracking while idle so the rear
  // arc (and the client's crank render) stays honest between volleys.
  a.lockedAngle = toTarget;
  if (dist <= C.CASK_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "volley");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.8, gain: 0.6, trauma: 0 });
    return;
  }
  // The periodic reposition: crowded, it waddles back toward its firing range; too far,
  // it closes. In its band it is a turret.
  if (dist < C.CASK_TOO_CLOSE) {
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.CASK_TRIGGER) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

// The sinderling: the heat-feeder. Unarmed it seeks environmental heat — an ACTIVE fire
// vent or a brazier — and consumes one pulse to ARM (aux 1, on the wire: the client
// renders the stoked glow). With no heat in reach it stokes itself on a long stationary
// channel instead, so the identity works on every floor. Armed: a locked flame-jet dash
// (rush grammar) laying a burning cinder wake; an armed DEATH bursts shared-risk fire.
function updateSinderling(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "stoke") {
      a.time += dt;
      a.windup = Math.min(1, a.time / C.SINDER_STOKE_WINDUP);
      if (a.time >= C.SINDER_STOKE_WINDUP) {
        sinderArm(e, ev);
        enterIdle(e);
      }
      return;
    }
    // The jet (rush grammar: aimed, locked, shoves on impact).
    if (stepWindupTimer(w, e, dt, C.SINDER_JET_WINDUP, C.SINDER_JET_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SINDER_JET_SPEED * C.SINDER_JET_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.seq = 0;
      a.cooldown = C.SINDER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.2, gain: 0.75, trauma: 0.05 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
    const step = C.SINDER_JET_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    // The flame wedge: a burning cinder dropped every few px of the jet's wake.
    while (e.seq < Math.floor(a.time / C.SINDER_CINDER_GAP)) {
      e.seq++;
      plantCinder(w, e.x, e.y);
    }
    const moved = Math.hypot(e.x - x0, e.y - y0);
    if (moved < step * chillMoveScale(e) * 0.5 || a.time >= C.SINDER_JET_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SINDER_JET_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (e.aux === 0) {
    // Unarmed: feed first. Consume standing heat, else walk to the nearest source, else
    // stoke — the channel is long and stationary: killing it unarmed is always on offer.
    if (isOnHeat(w, e)) { sinderArm(e, ev); return; }
    const heat = nearestHeatPoint(w, e);
    if (heat !== null) {
      applyChaseStep(w, e, dt, Math.atan2(heat.y - e.y, heat.x - e.x), e.speed * dt);
      return;
    }
    if (a.cooldown === 0 && e.spawnTimer === 0 && dist <= C.SINDER_HEAT_RANGE) {
      beginWindup(e, "stoke");
      ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.65, gain: 0.55, trauma: 0 });
      return;
    }
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
    return;
  }
  // Armed: faster, hungrier, and carrying the jet.
  if (dist <= C.SINDER_JET_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "rush");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.9, gain: 0.6, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * C.SINDER_ARMED_SPEED_MULT * surgeMult(e) * dt);
}

function sinderArm(e: Enemy, ev: SimEvent[]): void {
  e.aux = 1;
  ev.push({ t: "flash", eid: e.id });
  ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES.sinderling.tint });
  ev.push({ t: "cue", name: "barrel", x: e.x, y: e.y, rate: 1.4, gain: 0.5, trauma: 0 });
}

// Standing heat: an ACTIVE fire vent under its feet, or a brazier at arm's reach.
function isOnHeat(w: WorldState, e: Enemy): boolean {
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  for (const h of w.floorHazards) {
    if (h.kind !== "fire_vent" || h.tx !== tx || h.ty !== ty) continue;
    if (floorHazardPhaseAt(h, w.floorHazardClock) === "active") return true;
  }
  for (const p of w.props) {
    if (p.dead || p.kind !== "brazier") continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) <= e.radius + p.radius + C.SINDER_BRAZIER_RANGE) return true;
  }
  return false;
}

// Shared scratch for nearestHeatPoint (read immediately by the one caller).
const heatPoint = { x: 0, y: 0 };

function nearestHeatPoint(w: WorldState, e: Enemy): { x: number; y: number } | null {
  let bestD = C.SINDER_HEAT_RANGE * C.SINDER_HEAT_RANGE;
  let found = false;
  for (const h of w.floorHazards) {
    if (h.kind !== "fire_vent") continue;
    const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
    const dx = cx - e.x, dy = cy - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; heatPoint.x = cx; heatPoint.y = cy; found = true; }
  }
  for (const p of w.props) {
    if (p.dead || p.kind !== "brazier") continue;
    const dx = p.x - e.x, dy = p.y - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; heatPoint.x = p.x; heatPoint.y = p.y; found = true; }
  }
  return found ? heatPoint : null;
}

function plantCinder(w: WorldState, x: number, y: number): void {
  if (isWall(w, x, y)) return;
  let cinders = 0;
  for (const h of w.hazards) if (h.kind === "cinder") cinders++;
  if (cinders >= C.SINDER_CINDER_CAP) return; // hard cap: a wake, never a lake
  w.hazards.push({
    id: w.nextHazardId++, kind: "cinder", x, y,
    radius: C.SINDER_CINDER_RADIUS, life: C.SINDER_CINDER_LIFE, maxLife: C.SINDER_CINDER_LIFE,
  });
}

// The armed sinderling's death: an immediate SHARED-risk burst. Players take 1 (their
// protection rules apply); enemies take more — the fire is nobody's friend — and enemy
// kills inside it credit the sinderling's killer. Cover splinters.
function sinderlingBurst(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  const r = C.SINDER_BURST_RADIUS;
  ev.push({ t: "explosion", x: e.x, y: e.y, r, src: "sinderling" });
  ev.push({ t: "cue", name: "sinderling.burst", x: e.x, y: e.y, rate: 1, gain: 0.8, trauma: 0.05 });
  for (const victim of w.players.values()) {
    if (isProtected(victim) || victim.isDown || victim.isAbsent || victim.hp <= 0) continue;
    if (Math.hypot(victim.x - e.x, victim.y - e.y) <= r) damagePlayer(w, victim, C.SINDER_BURST_PLAYER_DMG, ev);
  }
  for (const other of w.enemies) {
    if (other === e || other.dead || isUntargetable(other)) continue;
    if (Math.hypot(other.x - e.x, other.y - e.y) > r + other.radius) continue;
    damageEnemy(w, p ? p.id : null, other, C.SINDER_BURST_ENEMY_DMG, ev);
    ev.push({ t: "puff", x: other.x, y: other.y, n: 4, color: ENEMY_ARCHETYPES[other.kind].tint });
    if (other.hp <= 0 && !other.dead) killEnemy(w, p, other, ev);
  }
  enemySmashEnvironment(w, e.x, e.y, r, ev);
}

// The choir fragment: the tethered voice. It binds to the nearest OTHER enemy in line of
// sight (the source id + 1 rides the aux channel so the client draws the authoritative
// tether); on cadence the tether HARMONIZES — the segment between the two bodies becomes
// a damaging lane for a short pulse. Kill the source or break line of sight and the
// pattern simplifies to a slow contact drifter.

// The CLINKER MASON (Emberreach's topology worker): claims the nearest heat vent or
// brazier — the sinderling's feeding ground — walks to it, and masons ONE handed
// L-corner of clinker bricks around it on a long stationary tell. The corner apex
// points at the nearest player (the denial face); the long arm is handed by id parity;
// the open back side is the authored approach lane. Building anew collapses the old
// corner. No vent in reach: it fortifies its own position instead.
const masonSite = { x: 0, y: 0 };

function masonSitePoint(w: WorldState, e: Enemy): { x: number; y: number } {
  let bestD = C.MASON_VENT_RANGE * C.MASON_VENT_RANGE;
  let found = false;
  for (const h of w.floorHazards) {
    if (h.kind !== "fire_vent") continue;
    const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
    const dx = cx - e.x, dy = cy - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; masonSite.x = cx; masonSite.y = cy; found = true; }
  }
  for (const p of w.props) {
    if (p.dead || p.kind !== "brazier") continue;
    const dx = p.x - e.x, dy = p.y - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; masonSite.x = p.x; masonSite.y = p.y; found = true; }
  }
  if (!found) { masonSite.x = e.x; masonSite.y = e.y; }
  return masonSite;
}

function masonRaiseCorner(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  raiseConstruction(w, e, workerBuildSites(e), ev);
}

function updateMason(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.MASON_BUILD_WINDUP);
    if (a.time >= C.MASON_BUILD_WINDUP) {
      masonRaiseCorner(w, e, ev);
      a.cooldown = C.MASON_BUILD_CD * attackCdMultOf(e);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.MASON_BUILD_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const site = masonSitePoint(w, e);
  const siteDist = Math.hypot(site.x - e.x, site.y - e.y);
  if (siteDist > C.MASON_SITE_REACH) {
    applyChaseStep(w, e, dt, Math.atan2(site.y - e.y, site.x - e.x), e.speed * surgeMult(e) * dt);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0) {
    beginWindup(e, "build");
    a.markX = site.x;
    a.markY = site.y;
    // The corner apex faces the nearest player at tell start — frozen for the whole
    // masonry, so the previewed footprint is exactly what lands.
    a.lockedAngle = Math.atan2(w.targetY - site.y, w.targetX - site.x);
    a.isAimLocked = true;
  }
  // Site claimed and cooling: the mason holds its ground by its work.
}

function updateFragment(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  let src = fragmentSourceOf(w, e);
  if (src !== null && (src.dead || !hasLineOfSight(w, e.x, e.y, src.x, src.y))) src = null;
  if (src === null) {
    if (e.aux !== 0) {
      e.aux = 0;
      // The lane dissolves the moment the tether breaks — mid-pulse included.
      if (a.move === "harmonize") enterIdle(e);
    }
    src = pickFragmentSource(w, e);
    if (src !== null) e.aux = src.id + 1;
  }
  if (a.phase === "windup" && a.move === "harmonize") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.FRAGMENT_PULSE_WINDUP);
    if (a.time >= C.FRAGMENT_PULSE_WINDUP && src !== null) {
      // The release area is the whole lane: arbitrated at its midpoint like every other
      // line commitment. Blocked pulses hold at full windup and re-check.
      const midX = (e.x + src.x) / 2, midY = (e.y + src.y) / 2;
      const half = Math.hypot(src.x - e.x, src.y - e.y) / 2;
      if (tryRelease(w, midX, midY, half)) {
        a.phase = "active"; a.time = 0; a.windup = 0;
        ev.push({ t: "cue", name: "fragment.pulse", x: e.x, y: e.y, rate: 1, gain: 0.7, trauma: 0.03 });
      }
    }
    return;
  }
  if (a.phase === "active" && a.move === "harmonize") {
    a.time += dt;
    if (src !== null) harmonizeLaneDamage(w, e, src, ev);
    if (a.time >= C.FRAGMENT_PULSE_ACTIVE) {
      enterRecover(e);
      a.cooldown = C.FRAGMENT_CD * attackCdMultOf(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.FRAGMENT_PULSE_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  // Tethered it hovers at mid-range, singing; untethered it drifts in with contact only.
  const hold = e.aux !== 0 ? C.FRAGMENT_HOLD_DIST : 0;
  if (dist > hold) applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  if (e.aux !== 0 && src !== null && a.cooldown === 0 && e.spawnTimer === 0) {
    beginWindup(e, "harmonize");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.8, gain: 0.45, trauma: 0 });
  }
}

function fragmentSourceOf(w: WorldState, e: Enemy): Enemy | null {
  if (e.aux === 0) return null;
  const id = e.aux - 1;
  for (const other of w.enemies) if (other.id === id && !other.dead) return other;
  return null;
}

// A valid tether source: the nearest other living enemy in range with line of sight —
// never another fragment (no daisy chains) and never a decoy (noise cannot sing).
function pickFragmentSource(w: WorldState, e: Enemy): Enemy | null {
  let best: Enemy | null = null;
  let bestD = C.FRAGMENT_TETHER_RANGE * C.FRAGMENT_TETHER_RANGE;
  for (const other of w.enemies) {
    if (other === e || other.dead) continue;
    if (other.kind === "fragment" || other.kind === "echo" || other.kind === "knell") continue;
    const dx = other.x - e.x, dy = other.y - e.y, d = dx * dx + dy * dy;
    if (d >= bestD) continue;
    if (!hasLineOfSight(w, e.x, e.y, other.x, other.y)) continue;
    bestD = d;
    best = other;
  }
  return best;
}

function harmonizeLaneDamage(w: WorldState, e: Enemy, src: Enemy, ev: SimEvent[]): void {
  const dx = src.x - e.x, dy = src.y - e.y;
  const len2 = dx * dx + dy * dy;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - e.x) * dx + (p.y - e.y) * dy) / len2)) : 0;
    const px = e.x + dx * t, py = e.y + dy * t;
    if (Math.hypot(p.x - px, p.y - py) < C.FRAGMENT_BEAM_HALF_WIDTH + p.pr) damagePlayer(w, p, 1, ev);
  }
}

// ROOT MARSHAL (miniboss template: the formation fight). P1 (captainPhase 1): a wide
// slow-turning guard + a live formation — it raises swarm rootwards on a cadence and
// walks its wall forward. At 50% the generic captain transition fires and the shield
// SHATTERS INTO DESTRUCTIBLE COVER (see marshalShatterShield); P2 trades the wall for
// tempo: ring sweeps alternating aimed fans, with the guard gone for good.
function updateMarshal(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (e.captainPhase === 1 || e.captainPhase === undefined) {
    if (!findTarget(w, e.x, e.y)) return;
    const chase = chaseAngle(w, e);
    const d = angleDiff(chase, a.lockedAngle);
    const maxTurn = MARSHAL.guardTurnRate * dt;
    a.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
    // The formation: seq is the summon countdown while the shield stands.
    e.seq -= dt;
    if (e.seq <= 0 && e.spawnTimer === 0) {
      e.seq = MARSHAL.summonInterval;
      if (countMarshalWards(w) < MARSHAL.summonCap) spawnMarshalWard(w, e, ev);
    }
    applyChaseStep(w, e, dt, chase, e.speed * dt);
    return;
  }
  // P2: the sweeps.
  if (a.phase === "windup") {
    if (a.move === "sweep") {
      a.time += dt;
      a.windup = Math.min(1, a.time / MARSHAL.sweepWindup);
      if (a.time >= MARSHAL.sweepWindup) {
        marshalRing(w, e, ev);
        enterRecover(e);
      }
      return;
    }
    // The aimed fan (volley grammar).
    if (stepWindupTimer(w, e, dt, MARSHAL.sweepWindup, MARSHAL.sweepWindup * 0.55, false)) {
      marshalFan(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= MARSHAL.sweepRecover) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)) {
    e.seq = Math.floor(e.seq) + 1;
    a.cooldown = MARSHAL.sweepCooldown;
    beginWindup(e, e.seq % 2 === 1 ? "sweep" : "volley");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function countMarshalWards(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.isSummoned && e.kind === "rootward") n++;
  return n;
}

function spawnMarshalWard(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const angle = e.attack.lockedAngle + (countMarshalWards(w) === 0 ? 0.9 : -0.9);
  const mx = e.x + Math.cos(angle) * (e.radius + 26);
  const my = e.y + Math.sin(angle) * (e.radius + 26);
  if (!settleSpawnPoint(w, mx, my, ENEMY_ARCHETYPES.rootward.radius)) return;
  const ward = createEnemy("rootward", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    tier: "swarm", isSummoned: true, players: w.encounterPlayers,
  });
  w.enemies.push(ward);
  ev.push({ t: "enemySpawn", eid: ward.id, kind: ward.kind, tier: ward.tier, x: ward.x, y: ward.y });
}

function marshalRing(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const base = e.seq % 4 < 2 ? 0 : Math.PI / MARSHAL.sweepCount;
  for (let i = 0; i < MARSHAL.sweepCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / MARSHAL.sweepCount) * Math.PI * 2, MARSHAL.sweepSpeed, MARSHAL.shotRadius, 1, ENEMY_ARCHETYPES.marshal.tint, MARSHAL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

function marshalFan(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (let i = 0; i < MARSHAL.fanShots; i++) {
    const off = (i - (MARSHAL.fanShots - 1) / 2) * MARSHAL.fanSpread;
    spawnEnemyBullet(w, e.x, e.y, a.lockedAngle + off, MARSHAL.fanSpeed, MARSHAL.shotRadius, 1, ENEMY_ARCHETYPES.marshal.tint, MARSHAL.shotLife);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

// The marshal's 50% beat: the shield SHATTERS INTO COVER — real destructible crates land
// where the guard hung, becoming the player's cover against the P2 rings. Placement is
// deterministic (the guard's arc), validated for walls/props/players, and bumps the
// obstacle revision through the ordinary door so navigation re-routes.
function marshalShatterShield(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const spread = 0.7;
  for (let i = 0; i < MARSHAL.coverCount; i++) {
    const ang = e.attack.lockedAngle + (i - (MARSHAL.coverCount - 1) / 2) * spread;
    const x = e.x + Math.cos(ang) * MARSHAL.coverDist;
    const y = e.y + Math.sin(ang) * MARSHAL.coverDist;
    if (isWall(w, x, y) || blockedByProp(w, x, y, C.PROP_RADIUS)) continue;
    let isClear = true;
    for (const p of w.players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < p.pr + C.PROP_RADIUS + 4) { isClear = false; break; }
    }
    if (!isClear) continue;
    w.props.push({ id: w.nextPropId++, kind: "crate", x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP.crate, dead: false });
    ev.push({ t: "puff", x, y, n: 5, color: ENEMY_ARCHETYPES.marshal.tint });
  }
  w.obstacleRev++;
  e.seq = 0; // P2's sweep alternation starts fresh
  ev.push({ t: "cue", name: "enemyDeath", x: e.x, y: e.y, rate: 0.6, gain: 0.85, trauma: 0.1 });
}

// THE TOLL (miniboss template: the sound-lane fight). Nearly stationary. P1: the knell —
// an expanding sound ring — alternating an aimed three-bolt peal (volley grammar). P2:
// every knell also plants a NOISE-LURE at the nearest player's feet (a 1-HP knell decoy
// that tolls its own ring when its fuse runs out — shoot the noise or leave it).
function updateToll(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "knell") {
      a.time += dt;
      a.windup = Math.min(1, a.time / TOLL.ringWindup);
      if (a.time >= TOLL.ringWindup) {
        tollRing(w, e, ev);
        if (e.captainPhase === 2) tollPlantLure(w, e, ev);
        enterRecover(e);
      }
      return;
    }
    // The peal (volley grammar: aimed, locked).
    if (stepWindupTimer(w, e, dt, TOLL.pealWindup, TOLL.pealLock, false)) {
      tollPeal(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "knell" ? TOLL.ringRecover : TOLL.pealRecover)) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)) {
    e.seq++;
    a.cooldown = TOLL.ringCooldown;
    beginWindup(e, e.seq % 2 === 1 ? "knell" : "volley");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.45, gain: 0.7, trauma: 0 });
    return;
  }
  // The bell barely walks: it creeps only when the fight has left it behind entirely.
  if (!findTarget(w, e.x, e.y)) return;
  if (Math.hypot(w.targetX - e.x, w.targetY - e.y) > 500) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function tollRing(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const base = e.seq % 4 < 2 ? 0 : Math.PI / TOLL.ringCount;
  for (let i = 0; i < TOLL.ringCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / TOLL.ringCount) * Math.PI * 2, TOLL.ringSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.toll.tint, TOLL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

function tollPeal(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (let i = 0; i < TOLL.pealShots; i++) {
    const off = (i - (TOLL.pealShots - 1) / 2) * TOLL.pealSpread;
    spawnEnemyBullet(w, e.x, e.y, a.lockedAngle + off, TOLL.pealSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.toll.tint, TOLL.shotLife);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

function tollPlantLure(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (!findTarget(w, e.x, e.y)) return;
  if (!settleSpawnPoint(w, w.targetX, w.targetY, ENEMY_ARCHETYPES.knell.radius)) return;
  const lure = createEnemy("knell", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  lure.aux = TOLL.lureLife;
  w.enemies.push(lure);
  ev.push({ t: "enemySpawn", eid: lure.id, kind: lure.kind, tier: lure.tier, x: lure.x, y: lure.y });
  ev.push({ t: "cue", name: "knell.fuse", x: lure.x, y: lure.y, rate: 1, gain: 0.65, trauma: 0 });
}

function updateGhost(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const has = findTarget(w, e.x, e.y);
  const angle = has ? Math.atan2(w.targetY - e.y, w.targetX - e.x) : e.zig;
  const near = has && (w.targetX - e.x) ** 2 + (w.targetY - e.y) ** 2 <= C.GHOST_SOLID_RANGE * C.GHOST_SOLID_RANGE;
  const rate = dt / C.GHOST_SOLID_TIME;
  const prev = a.windup;
  a.windup = near ? Math.min(1, a.windup + rate) : Math.max(0, a.windup - rate);
  if (prev < C.GHOST_SOLID_AT && a.windup >= C.GHOST_SOLID_AT) ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.7, gain: 0.35, trauma: 0 });
  const step = e.speed * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
}

function updateSpitter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SPITTER_WINDUP, C.SPITTER_LOCK, false)) {
      spitterFire(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SPITTER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (dist >= C.SPITTER_FLEE && dist <= C.SPITTER_APPROACH && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "spit");
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.4, gain: 0.5, trauma: 0 });
    return;
  }
  if (dist < C.SPITTER_FLEE) {
    // Retreat stays a direct backpedal: a cornered spitter is the player's reward.
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.SPITTER_APPROACH) {
    // The approach routes like every other ground enemy (prop-aware + anti-stuck):
    // a kiter that wedges on a barrel forever out of range never becomes a fight.
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function spitterFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  spitterVolley(w, e, e.attack.lockedAngle, ev);
  e.attack.cooldown = C.SPITTER_CD * attackCdMultOf(e);
  armEcho(e, e.attack.lockedAngle);
}

// The release body, shared by the live fire and the echoed elite's delayed repeat.
function spitterVolley(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): void {
  const n = w.floor >= C.SPITTER_SPREAD_FLOOR ? 3 : 1;
  const mx = e.x + Math.cos(angle) * (e.radius + 4);
  const my = e.y + Math.sin(angle) * (e.radius + 4);
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i - 1) * C.GLOB_SPREAD;
    spawnEnemyBullet(w, mx, my, angle + off, 300, 7, 1, "#ff5a7a", 2.5);
  }
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

// Arm the echoed elite's one repeat at fire time. A refire never re-arms (refireEcho
// calls the volley bodies directly), so a release echoes exactly once.
function armEcho(e: Enemy, angle: number): void {
  if (e.tier !== "elite" || e.captainPhase !== undefined || eliteAffixOf(e.kind) !== "echoed") return;
  e.echoTime = ELITE_ECHOED.delay;
  e.echoAngle = angle;
}

// Elite affix package: 20% shorter commit cooldowns (§4) — never a damage multiplier.
function attackCdMultOf(e: Enemy): number {
  return TIERS[e.tier].attackCdMult;
}

// The Slime King (spec §5, calibrated to ~37.5s median / ≥20s absolute solo TTK). Phase
// changes ride damage events (checkBossTransition); this state machine owns the cadence:
//   P1 (100–70%): hop slam every 3.2s; adds 1 slime @4.5s then every 6.5s (cap 5).
//   P2 (70–35%):  2.7s cadence alternating hop / 10-glob radial; every 2nd radial orders
//                 the living slimes into a delayed pack surge (pressure, no extra HP).
//   P3 (35–0%):   2.25s cadence; hop landings fire 4 cardinal globs; every 3rd attack is a
//                 telegraphed 3s arena squeeze; chase +12%; adds 2 slimes / 7s (cap 7).
// ---- BOSS AFFIX (Wave 1): one extra telegraphed pattern layered onto a deep boss ----
// A parallel cadence, independent of the boss's own attack machine: on its beat it blooms
// telegraphed "charge" detonations (a ≥0.6s arming fuse, walk-dodgeable — the same shared hazard
// the volatile elite plants, so it rides hzds and renders as a fairness cue) in a distinct
// spatial signature per affix. Paused during the entrance grace and every transition beat.
function stepBossAffix(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss!;
  if (e.spawnTimer > 0 || boss.roar !== null) return;
  boss.affixCd -= dt;
  if (boss.affixCd > 0) return;
  if (!findTarget(w, e.x, e.y)) return;
  boss.affixCd = BOSS_AFFIX.cooldown;
  switch (w.floorDescriptor.bossAffix) {
    case "emberwake": {
      // A bloom under each living player's feet — keep moving off the ground you stand on.
      for (const p of w.players.values()) {
        if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
        plantAffixCharge(w, p.x, p.y);
      }
      break;
    }
    case "sundering": {
      // A fracture SEAM drawn across the arena through the boss toward the nearest player —
      // leave the line before it snaps.
      const ang = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      const cx = Math.cos(ang), cy = Math.sin(ang);
      const half = (BOSS_AFFIX.seamCount - 1) / 2;
      for (let i = 0; i < BOSS_AFFIX.seamCount; i++) {
        const d = (i - half) * BOSS_AFFIX.seamSpacing;
        plantAffixCharge(w, e.x + cx * d, e.y + cy * d);
      }
      break;
    }
    case "amberrain": {
      // A seeded scatter of blooms around the party centroid — read the raining amber.
      for (let i = 0; i < BOSS_AFFIX.rainCount; i++) {
        const ox = (w.rng.next() * 2 - 1) * BOSS_AFFIX.rainSpread;
        const oy = (w.rng.next() * 2 - 1) * BOSS_AFFIX.rainSpread;
        plantAffixCharge(w, w.targetX + ox, w.targetY + oy);
      }
      break;
    }
    default:
      break;
  }
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.8, gain: 0.6, trauma: 0.05 });
}

// One boss-affix bloom: the shared telegraphed "charge" hazard (arming fuse → walk-dodgeable
// detonation). Skips walls so a bloom never arms inside geometry.
function plantAffixCharge(w: WorldState, x: number, y: number): void {
  if (isWall(w, x, y)) return;
  w.hazards.push({
    id: w.nextHazardId++, kind: "charge", x, y,
    radius: BOSS_AFFIX.radius, life: BOSS_AFFIX.fuse, maxLife: BOSS_AFFIX.fuse,
  });
}

function updateBoss(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  // Add pacing pauses during the transition roar (the roar spawns its own marked pair).
  // Add pressure rides the R framework: the interval tightens and the cap grows with
  // the pull's measured surplus, both hard-clamped (never more than addCapMax live).
  if (!boss.roar) {
    boss.addTimer -= dt;
    if (boss.addTimer <= 0) {
      boss.addTimer = bossAddIntervalFor(BOSS.addInterval[boss.phase], w.encounterPower);
      const cap = bossAddCapFor(BOSS.addCap[boss.phase], w.encounterPower);
      for (let i = 0; i < BOSS.addBatch[boss.phase]; i++) {
        if (countBossAdds(w) >= cap) break;
        spawnBossAdd(w, e, w.rng.next() * Math.PI * 2, ev);
      }
    }
  }

  if (a.phase === "windup") { bossWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { bossActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "hopslam" ? BOSS.hopRecover : BOSS.radialRecover;
    if (a.time >= recDur) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { bossBeginAttack(e, ev); return; }
  bossChase(w, e, dt, ev);
}

// Living boss-summoned adds (the cadence cap counts only summons, never floor enemies —
// and never the mechanic/decoy bodies: knots, sacs and noise hold no add budget).
function countBossAdds(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) {
    if (!e.dead && e.isSummoned && !isBossKind(e.kind) && !isDecoyKind(e.kind)) n++;
  }
  return n;
}

// Live summoned adds of a specific kind (the deep bosses' surplus adds are counted by their
// own kind so the cap counts the ADDS, not the boss's own bodies — slabs, husks).
function countLiveAddsOfKind(w: WorldState, kind: Enemy["kind"]): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.isSummoned && e.kind === kind) n++;
  return n;
}

function bossBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = BOSS.attackCd[boss.phase];
  // P3: every 3rd attack is the arena squeeze (1.0s telegraph, 3.0s hold).
  if (boss.phase >= 3 && boss.attackCount % BOSS.squeezeEvery === 0) {
    beginWindup(e, "squeeze");
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.8, gain: 0.7, trauma: 0.1 });
    return;
  }
  const useRadial = boss.phase === 2 && boss.isNextRadial;
  if (boss.phase === 2) boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, useRadial ? "radial" : "hopslam");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: useRadial ? 0.6 : 0.4, gain: 0.7, trauma: 0 });
}

function bossWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.roarDuration);
    if (a.time >= BOSS.roarDuration) {
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "radial") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.radialWindup);
    if (a.time >= BOSS.radialWindup) { bossRadialFire(w, e, ev); enterRecover(e); }
    return;
  }
  if (a.move === "squeeze") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.squeezeTelegraph);
    if (a.time >= BOSS.squeezeTelegraph) { a.phase = "active"; a.time = 0; a.windup = 0; }
    return;
  }
  if (stepWindupTimer(w, e, dt, BOSS.hopWindup, BOSS.hopLock, true)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.6, gain: 0.9, trauma: 0 });
  }
}

function bossActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "squeeze") { bossSqueezeActive(w, e, dt, ev); return; }
  a.time += dt;
  const prev = a.windup;
  a.windup = Math.min(1, a.time / BOSS.hopAir);
  const rem = 1 - prev;
  if (rem > 0.0001) {
    const f = Math.min(1, (a.windup - prev) / rem);
    e.x += (a.markX - e.x) * f;
    e.y += (a.markY - e.y) * f;
  }
  if (a.time >= BOSS.hopAir) { bossLand(w, e, ev); enterRecover(e); }
}

// The arena squeeze: a safe circle around the boss shrinks over 3s — stand inside it or
// take ring damage. Forces movement TOWARD the fight while the boss holds still (the DPS
// window is the reward for reading it). windup carries squeeze progress for the renderer.
function bossSqueezeActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  a.time += dt;
  const t = Math.min(1, a.time / BOSS.squeezeDuration);
  a.windup = t;
  const safeR = BOSS.squeezeStartRadius + (BOSS.squeezeEndRadius - BOSS.squeezeStartRadius) * t;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) > safeR) damagePlayer(w, p, BOSS.squeezeDamage, ev);
  }
  if (a.time >= BOSS.squeezeDuration) enterIdle(e);
}

function bossLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack, boss = e.boss;
  const x = a.markX, y = a.markY;
  // Slam center hits for 2; the outer shockwave ring for 1 (spec §5 damage table).
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < BOSS.slamInnerRadius) damagePlayer(w, p, BOSS.slamCenterDamage, ev);
    else if (d < BOSS.slamRadius) damagePlayer(w, p, BOSS.slamOuterDamage, ev);
  }
  enemySmashEnvironment(w, x, y, BOSS.slamRadius, ev);
  ev.push({ t: "bossSlam", x, y });
  if (boss && boss.phase >= 3) {
    for (let i = 0; i < 4; i++) spawnEnemyBullet(w, x, y, (i / 4) * 6.28, 220, 7, BOSS.globDamage, "#a24bff", 2.5);
  }
}

function bossRadialFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  const parity = boss ? boss.burstParity : 0;
  if (boss) boss.burstParity = parity ^ 1;
  const base = parity ? Math.PI / BOSS.radialCount : 0;
  for (let i = 0; i < BOSS.radialCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / BOSS.radialCount) * 6.28, 260, 7, BOSS.globDamage, "#a24bff", 2.6);
  }
  // The King's soft-enrage pattern: a second, slower OFFSET ring — one more readable
  // weave through the gaps, never a damage or speed change.
  if (boss && boss.enrage === 1) {
    for (let i = 0; i < BOSS.radialCount; i++) {
      spawnEnemyBullet(w, e.x, e.y, base + Math.PI / BOSS.radialCount + (i / BOSS.radialCount) * 6.28, 200, 7, BOSS.globDamage, "#a24bff", 2.6);
    }
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
  // Every 2nd radial orders the living slimes into a delayed pack surge — coordinated
  // pressure with zero extra HP.
  if (boss && boss.burstParity === 0) {
    for (const add of w.enemies) {
      if (add.dead || !add.isSummoned || add.kind !== "slime") continue;
      add.surgeDelay = BOSS.packSurgeDelay;
    }
  }
}

function bossChase(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (!findTarget(w, e.x, e.y)) return;
  const mult = e.boss && e.boss.phase >= 3 ? BOSS.p3ChaseMult : 1;
  const step = e.speed * mult * dt;
  // Route around walls on the boss-clearance flow field (prop avoidance + stuck-escape
  // come free), so a wall between the King and the party no longer beaches it behind cover.
  applyChaseStep(w, e, dt, chaseAngle(w, e), step);
  // The King still crushes furniture it reaches: the smash reach extends just past
  // moveCircle's prop-block ring, so any crate it does close on is destroyed, not orbited.
  enemySmashEnvironment(w, e.x, e.y, e.radius + 2, ev);
}

// Spawn one summoned add at `angle` off the boss's edge — each boss raises its own kin
// (the King standard slimes; the deep bosses fragile SWARM bodies, killable inside an
// interactive beat). Summons are excluded from hearts/Fang (isSummoned) so add pressure
// never becomes a sustain farm. The point settles like every other spawn (body-clear +
// reachable — never inside a wall or a sealed cover pocket); a rim point with no valid
// neighborhood skips the add. Returns the add (interactive beats track ids), or null.
function spawnBossAdd(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): Enemy | null {
  const kin = BOSS_KIN[e.kind] ?? "slime";
  const mx = e.x + Math.cos(angle) * (e.radius + 20);
  const my = e.y + Math.sin(angle) * (e.radius + 20);
  if (!settleSpawnPoint(w, mx, my, ENEMY_ARCHETYPES[kin].radius)) {
    ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: e.x, my: e.y, spawned: false });
    return null;
  }
  const add = createEnemy(kin, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    tier: e.kind === "boss" ? "standard" : "swarm", isSummoned: true, players: w.encounterPlayers,
  });
  w.enemies.push(add);
  ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: add.x, my: add.y, spawned: true });
  return add;
}

// ---- KEEP THEM GUESSING: curated add pools + omen-telegraphed ambush spawns ----
// Fair surprise (see balance.ts): WHICH body arrives is a weighted seeded draw from a
// curated per-boss pool (no immediate repeats, singular entries capped, complex movers
// under the live mover cap); WHERE it arrives is an authored settled anchor never
// inside a player's personal space; WHEN it becomes dangerous is never a surprise —
// the OMEN tell stands for its whole beat BEFORE the body exists, and the body then
// keeps its ordinary spawn grace. Surprise in composition and placement, never as an
// instant hit. Every draw rides the world RNG: co-op clients and replays agree.

function countLivePoolEntry(w: WorldState, entry: AddPoolEntry): number {
  let n = 0;
  for (const e of w.enemies) {
    if (!e.dead && e.isSummoned && e.kind === entry.kind && e.tier === entry.tier) n++;
  }
  return n;
}

function countLiveComplexMovers(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && isComplexMover(e.kind)) n++;
  return n;
}

// The weighted draw. Ineligible entries (singular already alive/pending, mover cap
// reached) leave the bag; the previous pick is excluded whenever ANY other entry is
// still eligible, so the exact wave can never be rote-memorized.
function drawFromAddPool(w: WorldState, boss: Enemy, pool: readonly AddPoolEntry[]): AddPoolEntry | null {
  const bossState = boss.boss;
  if (!bossState) return null;
  const moverCap = activeMoverCapFor(w.encounterPlayers);
  const eligible: number[] = [];
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    if (entry.maxAlive > 0 && countLivePoolEntry(w, entry) + countPendingOmensOfKind(w, entry.kind, entry.tier) >= entry.maxAlive) continue;
    if (isComplexMover(entry.kind) && countLiveComplexMovers(w) >= moverCap) continue;
    eligible.push(i);
  }
  if (eligible.length === 0) return null;
  const pickFrom = eligible.length > 1 ? eligible.filter((i) => i !== bossState.lastAddPick) : eligible;
  let total = 0;
  for (const i of pickFrom) total += pool[i].weight;
  let roll = w.rng.next() * total;
  let pick = pickFrom[pickFrom.length - 1];
  for (const i of pickFrom) {
    roll -= pool[i].weight;
    if (roll <= 0) { pick = i; break; }
  }
  bossState.lastAddPick = pick;
  return pool[pick];
}

// Queue one ambush: the omen tell at a settled anchor (never on/beside a standing
// player), carrying its spawn payload. Returns whether the tell was actually placed —
// a blocked anchor skips the ambush, it never relocates onto someone. `aux` rides an
// optional per-body role the resolve stamps on the body (the Quorum splinter's shard role).
function queueAmbush(w: WorldState, x: number, y: number, kind: Enemy["kind"], tier: EnemyTier, forBossId: number, ev: SimEvent[], tell: number = AMBUSH.tell, clear: number = AMBUSH.playerClear, aux?: number): boolean {
  if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES[kind].radius)) return false;
  if (isNearAnyPlayer(w, settlePoint.x, settlePoint.y, clear)) return false;
  w.hazards.push({
    id: w.nextHazardId++, kind: "omen", x: settlePoint.x, y: settlePoint.y,
    radius: AMBUSH.radius, life: tell, maxLife: tell,
    spawnKind: kind, spawnTier: tier, forBossId: forBossId > 0 ? forBossId : undefined, spawnAux: aux,
  });
  ev.push({ t: "cue", name: "enemyAttack", x: settlePoint.x, y: settlePoint.y, rate: 1.7, gain: 0.45, trauma: 0 });
  return true;
}

// Queue an entry's whole wave around an origin: `count` bodies, each with its own
// omen, retrying a few seeded ring angles per body so a crowded anchor SKIPS rather
// than relocating onto someone. Surprise waves (R framework) pass their longer tell +
// wider clearance. Returns how many tells actually stood.
function queueAmbushWave(w: WorldState, origin: Enemy, dist: number, entry: AddPoolEntry, forBossId: number, ev: SimEvent[], tell: number = AMBUSH.tell, clear: number = AMBUSH.playerClear): number {
  let placed = 0;
  const base = w.rng.next() * Math.PI * 2;
  for (let i = 0; i < entry.count; i++) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ang = base + (i / Math.max(1, entry.count)) * Math.PI * 2 + attempt * 2.399963;
      const x = origin.x + Math.cos(ang) * dist;
      const y = origin.y + Math.sin(ang) * dist;
      if (queueAmbush(w, x, y, entry.kind, entry.tier, forBossId, ev, tell, clear)) { placed++; break; }
    }
  }
  return placed;
}

// Pending ambush bodies (they hold cap budget the moment their tell stands — mechanic
// blooms like the Weaver's sacs are objectives, never add pressure, so they don't).
function countPendingOmens(w: WorldState): number {
  let n = 0;
  for (const h of w.hazards) {
    if (h.kind === "omen" && h.spawnKind !== undefined && h.life > 0 && !isDecoyKind(h.spawnKind)) n++;
  }
  return n;
}

function countPendingOmensOfKind(w: WorldState, kind: Enemy["kind"], tier: EnemyTier): number {
  let n = 0;
  for (const h of w.hazards) {
    if (h.kind === "omen" && h.spawnKind === kind && h.spawnTier === tier && h.life > 0) n++;
  }
  return n;
}

function countPendingOmensFor(w: WorldState, bossId: number): number {
  let n = 0;
  for (const h of w.hazards) if (h.kind === "omen" && h.forBossId === bossId + 1 && h.life > 0) n++;
  return n;
}

// The omen's beat is over: the announced body arrives (with its full spawn grace — the
// tell already stood for the whole AMBUSH.tell, so first contact is never a surprise).
function resolveOmen(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  const kind = h.spawnKind;
  if (kind === undefined) return;
  if (!settleSpawnPoint(w, h.x, h.y, ENEMY_ARCHETYPES[kind].radius)) return; // blocked meanwhile: fizzle
  const add = createEnemy(kind, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    tier: h.spawnTier, isSummoned: true, players: w.encounterPlayers,
  });
  w.enemies.push(add);
  ev.push({ t: "enemySpawn", eid: add.id, kind: add.kind, tier: add.tier, x: add.x, y: add.y });
  if (h.forBossId === undefined) return;
  const owner = w.enemies.find((o) => !o.dead && o.id === h.forBossId! - 1 && o.boss !== null);
  if (!owner || !owner.boss) return;
  // Mechanic bodies join their summoner's earned-window set. Every Choir verse omen is a
  // fragment of the current verse regardless of WHICH voice was drawn (fair surprise §1),
  // so the silence task is kind-agnostic — the window opens when the whole verse dies.
  if (owner.kind === "choir") {
    owner.boss.windowAddIds.push(add.id);
    // The verse has fully gathered: the Choir sings WITH it — a bounded untargetable
    // refrain (your DPS is redirected into the fragments, never idled). The refrain
    // replaces whatever ordinary move it was shaping (it stops attacking to sing —
    // player-favorable); only the transition beats themselves are never interrupted.
    if (countPendingOmensFor(w, owner.id) === 0
      && owner.attack.move !== "split" && owner.attack.move !== "roar") {
      owner.attack.move = "harmonize";
      owner.attack.phase = "active";
      owner.attack.time = 0;
      owner.attack.windup = 0;
      owner.attack.isAimLocked = false;
      ev.push({ t: "cue", name: "enemyAttack", x: owner.x, y: owner.y, rate: 0.5, gain: 0.7, trauma: 0 });
    }
  }
  if (owner.kind === "weaver" && add.kind === "sac") {
    add.seq = owner.id + 1; // the clutch belongs to the weaver that laid it
    owner.boss.windowAddIds.push(add.id);
  }
  if (owner.kind === "jet" && add.kind === "jet_echo") {
    // The reflection MIRRORS whoever it landed nearest (the targeted player reads "that's ME";
    // teammates read "[name]'s reflection"). Rides Enemy.mirrorOf → EnemyWire.mir.
    add.mirrorOf = jetNearestPlayer(w, add.x, add.y)?.id ?? null;
    add.aux = JET.echoWindup + JET.echoActive + JET.echoDissolve; // remaining-life readout (client fade)
    // Freeze ONE mirrored school (from the frozen pool) for this reflection's salvo — one of
    // YOUR OWN guns, turned back on you. Drawn seeded, never from live inventory.
    add.seq = w.jetMirror.length > 0
      ? RESONANCE_FAMILIES.indexOf(w.jetMirror[w.rng.int(0, w.jetMirror.length - 1)])
      : 0;
    beginWindup(add, "mirror"); // its salvo tell begins now; the spawn grace still holds it inert
  }
  if (owner.kind === "quorum" && add.kind === "quorum_splinter") {
    // The shard carries its parent husk's WEAK role (planted on the omen): 0 shield / 1 heal
    // / 2 dmg. seq links it to the core (the heal shard's trickle target); only the dmg pip
    // contacts. Its ordinary spawn grace + the arbiter hold still keep it inert mid tether-snap.
    const role = h.spawnAux ?? 0;
    add.aux = role;
    add.seq = owner.id + 1;
    add.touchDamage = role === 2 ? 1 : 0;
  }
}

// MARROW (spec §5b, calibrated like §5 to the same 30–45s TTK band at F10).
// A LINE boss: everything it does is an angle you read and step off, and its biggest
// opening is self-inflicted (the wall-crash stun). Phase changes ride damage events
// (checkBossTransition) exactly like the King; this machine owns the cadence:
//   P1 (100–65%): alternating line charge / 3-shard volley every 3.0s; husk adds on cadence.
//   P2 (65–30%):  2.6s cadence; 5-shard volley; a wall crash bursts a 6-shard ring.
//   P3 (30–0%):   2.2s cadence; 7 shards, 8-ring crash; every 3rd attack is the rotating
//                 spiral barrage; stalk +10%.
// Transitions (65%/30%) raise the SHIELD beat: reduction + floors + queued overflow, and
// two husks whose deaths break the shield early — read the beat, switch targets, profit.
function updateMarrow(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  // Add pacing pauses during the shield beat (the beat spawned its own marked husks).
  // Fair surprise: each cadence slot is ONE omen-telegraphed ambush drawn from the
  // curated pool — the fight never decays into pure charge-lane memorization, and the
  // tell + spawn grace keep every arrival honest. Pending blooms hold cap budget.
  if (!boss.roar) {
    boss.addTimer -= dt;
    if (boss.addTimer <= 0) {
      boss.addTimer = bossAddIntervalFor(MARROW.addInterval[boss.phase], w.encounterPower);
      const cap = bossAddCapFor(MARROW.addCap[boss.phase], w.encounterPower);
      // The phase's ONE surprise wave (R ≥ surpriseMinR): a second draw on the same
      // slot — it CONSUMES the add budget (cap-gated like everything else), stands
      // behind the longer surprise tell, and never fires during a beat.
      const isSurprise = w.encounterPower >= POWER.surpriseMinR && !boss.isSurpriseSpent;
      const batch = MARROW.addBatch[boss.phase] + (isSurprise ? 1 : 0);
      if (isSurprise) boss.isSurpriseSpent = true;
      for (let i = 0; i < batch; i++) {
        if (countBossAdds(w) + countPendingOmens(w) >= cap) break;
        const entry = drawFromAddPool(w, e, MARROW.addPool);
        if (!entry) break;
        if (isSurprise) queueAmbushWave(w, e, 190, entry, 0, ev, POWER.surpriseTell, POWER.surpriseClear);
        else queueAmbushWave(w, e, 150, entry, 0, ev);
      }
    }
  }

  if (a.phase === "windup") { marrowWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { marrowActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "crash" ? MARROW.crashStun
      : a.move === "rush" ? MARROW.chargeRecover
      : a.move === "spin" ? MARROW.spinRecover
      : MARROW.volleyRecover;
    if (a.time >= recDur) {
      // The soft-enrage pattern: charges come in PAIRS — a survived rush re-telegraphs
      // one more full-windup charge (a crash always ends the pair: the bait pays double).
      if (a.move === "rush" && boss.enrage === 1 && boss.spinCount === 0) {
        boss.spinCount = 1;
        beginWindup(e, "rush");
        ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.4, gain: 0.7, trauma: 0 });
        return;
      }
      enterIdle(e);
    }
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { marrowBeginAttack(w, e, ev); return; }
  marrowChase(w, e, dt);
}

function marrowBeginAttack(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = MARROW.attackCd[boss.phase];
  // P3: every 3rd attack is the stationary spiral barrage (0.8s telegraph, 2.2s weave).
  if (boss.phase >= 3 && boss.attackCount % MARROW.spinEvery === 0) {
    beginWindup(e, "spin");
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.9, gain: 0.7, trauma: 0.1 });
    return;
  }
  // A rush into cover is a wasted commitment (a wall-crash daze the party never earned).
  // Like the regular charger, the blind bull only lunges down a clear line of sight — when
  // a wall blocks the charge lane it throws the bone volley instead (the alternation holds).
  const isVolley = boss.isNextRadial || !marrowChargeLaneClear(w, e);
  boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, isVolley ? "volley" : "rush");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isVolley ? 0.55 : 0.4, gain: 0.7, trauma: 0 });
}

// The charge lane is clear when a wall does not sit between Marrow and its target: the
// blind bull commits to where it HEARD the party, so a straight line into stone is a
// telegraphed self-daze, never a threat. Mirrors updateCharger's hasLineOfSight gate.
function marrowChargeLaneClear(w: WorldState, e: Enemy): boolean {
  return findTarget(w, e.x, e.y) && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY);
}

function marrowWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "shield") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.shieldDuration);
    // The interactive break: past the minimum readable beat, the shield holds only while
    // a marked husk still stands (or until its hard cap elapses).
    const isBreakable = a.time >= MARROW.shieldMinDuration;
    if (a.time >= MARROW.shieldDuration || (isBreakable && countLiveBeatAdds(w, e) === 0)) {
      e.boss!.beatAddIds.length = 0;
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "spin") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.spinWindup);
    if (a.time >= MARROW.spinWindup) {
      // Anchor the spiral on the target's bearing at release, and flip its rotation
      // direction each barrage so the weave never becomes muscle memory.
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      const boss = e.boss!;
      boss.spinCount = 0;
      boss.burstParity ^= 1;
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "radialBurst", x: e.x, y: e.y });
    }
    return;
  }
  if (a.move === "volley") {
    if (stepWindupTimer(w, e, dt, MARROW.volleyWindup, MARROW.volleyLock, false)) {
      marrowVolleyFire(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  // rush
  if (stepWindupTimer(w, e, dt, MARROW.chargeWindup, MARROW.chargeLock, false)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.55, gain: 0.9, trauma: 0.05 });
  }
}

function marrowActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  if (a.move === "spin") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.spinDuration);
    const dir = boss.burstParity === 0 ? 1 : -1;
    // Deterministic pair emitter: shard pair k fires as elapsed time crosses k×interval.
    while (boss.spinCount < Math.floor(a.time / MARROW.spinInterval)) {
      const ang = a.lockedAngle + dir * boss.spinCount * MARROW.spinStep;
      spawnMarrowShard(w, e, ang);
      spawnMarrowShard(w, e, ang + Math.PI);
      boss.spinCount++;
    }
    if (a.time >= MARROW.spinDuration) enterRecover(e);
    return;
  }
  // rush
  a.time += dt;
  // A connect ends the rush BEFORE the next step (the contact pass already landed the
  // hit + shove last tick, while the rush was active) — hit-and-stop, never a drag.
  if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
  const step = MARROW.chargeSpeed * dt;
  const x0 = e.x, y0 = e.y;
  rushSmashEnvironment(w, e, ev); // the blind bull clears its furrow FIRST — no furniture wedge
  moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
  ev.push({ t: "lungeTrail", x: e.x, y: e.y });
  // Progress along the COMMITTED lane, never the wall-slide component: an oblique wall
  // impact used to shed the crash by sliding along the face, which would make the bait
  // — now the fight's earned window — unbaitable at anything but a square hit.
  const along = (e.x - x0) * Math.cos(a.lockedAngle) + (e.y - y0) * Math.sin(a.lockedAngle);
  if (along < step * chillMoveScale(e) * 0.5) {
    marrowCrash(w, e, ev);
    return;
  }
  if (a.time >= MARROW.chargeDur) enterRecover(e);
}

// The wall crash: MARROW's authored weakness, now its EARNED WINDOW. A long self-stun
// ("crash" recover) that opens the exposed window — the only full-damage time in the
// fight, and it exists exactly because a player made the rush miss. From P2 the impact
// bursts a radial shard ring — punishing, but only around the crash point.
function marrowCrash(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const shards = MARROW.crashShards[boss.phase];
  for (let i = 0; i < shards; i++) spawnMarrowShard(w, e, (i / shards) * Math.PI * 2);
  a.move = "crash";
  enterRecover(e);
  openBossWindow(e, MARROW.crashExpose, ev);
  ev.push({ t: "chargeCrash", x: e.x, y: e.y });
}

function marrowVolleyFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const n = MARROW.volleyShards[boss.phase];
  for (let i = 0; i < n; i++) {
    spawnMarrowShard(w, e, a.lockedAngle + (i - (n - 1) / 2) * MARROW.volleySpread);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

function spawnMarrowShard(w: WorldState, e: Enemy, angle: number): void {
  const mx = e.x + Math.cos(angle) * (e.radius + 6);
  const my = e.y + Math.sin(angle) * (e.radius + 6);
  spawnEnemyBullet(w, mx, my, angle, MARROW.shardSpeed, MARROW.shardRadius, MARROW.shardDamage, "#dceef5", MARROW.shardLife);
}

function countLiveIds(w: WorldState, ids: number[]): number {
  if (ids.length === 0) return 0;
  let n = 0;
  for (const other of w.enemies) {
    if (!other.dead && ids.indexOf(other.id) !== -1) n++;
  }
  return n;
}

function countLiveBeatAdds(w: WorldState, e: Enemy): number {
  return countLiveIds(w, e.boss!.beatAddIds);
}

function marrowChase(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const mult = e.boss && e.boss.phase >= 3 ? MARROW.p3ChaseMult : 1;
  const step = e.speed * mult * dt;
  // Flow-field routing at the boss clearance: the blind bull walks around cover between
  // charges instead of grinding a wall face toward a target it cannot reach in a line.
  applyChaseStep(w, e, dt, chaseAngle(w, e), step);
}

// THE HOLLOW CHOIR (spec §5c). The grieving ghost mass — the fight is about TRACKING and
// TURNING, never cover: its wails home (juke them on a curve), and on cadence it fades
// intangible and drifts through you before rematerializing into a burst + long recover
// (the punish window). Transition beats SPLIT it into three wisps: the boss is gone until
// they die or the cap elapses — your beat DPS goes into the wisps, by design.
//   P1 (100–65%): 2-wail volleys; every 3rd attack is the fade.
//   P2 (65–30%):  3 wails; the fade now rematerializes into an 8-shard ring.
//   P3 (30–0%):   2.4s cadence, 4 wails, 10-shard rematerialize ring.
function updateChoir(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  // SILENCE THE CHOIR (earned window + fair surprise): its verses arrive as AMBUSH
  // WAVES — omen tells bloom at seeded ring anchors (never on a player), the fragments
  // land a beat later, and as the verse gathers the Choir sings WITH it: a bounded
  // untargetable refrain (resolveOmen starts it — the fragments are the target).
  // While any fragment stands, the Choir stays guarded; silencing every one opens the
  // exposed window. Paused during the split beat (the wisps ARE that beat's answer).
  if (!boss.roar) {
    const pending = countPendingOmensFor(w, e.id);
    if (boss.windowAddIds.length > 0 || pending > 0) {
      if (pending === 0 && countLiveIds(w, boss.windowAddIds) === 0 && boss.windowAddIds.length > 0) {
        boss.windowAddIds.length = 0;
        boss.addTimer = CHOIR.fragmentRespawn;
        // Silencing the verse silences HER: a refrain still singing ends with it, so
        // the window that just opened is never wasted on an untargetable body.
        if (a.move === "harmonize") enterIdle(e);
        openBossWindow(e, CHOIR.silenceExpose, ev);
      }
    } else if (boss.exposed <= 0) {
      boss.addTimer -= dt;
      if (boss.addTimer <= 0) {
        boss.addTimer = CHOIR.fragmentRespawn;
        const n = CHOIR.fragmentsFor[w.encounterPlayers];
        const edgeAngle = w.rng.next() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          // Fair surprise §1: WHICH voice gathers is a seeded, non-repeating draw from
          // the curated pool (drawFromAddPool + lastAddPick, exactly like Weaver/Marrow)
          // — a DIFFERENT readable spectral kin each verse (drawn per fragment so a
          // single verse mixes its voices, never a rote wall), never always the ghost.
          // The COUNT stays the co-op task (fragmentsFor); only the voice varies, and
          // every pool member is fragile swarm chaff so the verse stays silenceable.
          const voice = drawFromAddPool(w, e, CHOIR.addPool);
          const voiceKind = voice ? voice.kind : "ghost";
          const voiceTier = voice ? voice.tier : "swarm";
          // The verse is a TASK (every fragment must die to open the window), so a
          // ring slot fouled by player clearance re-aims around the ring instead of
          // silently shrinking the mechanic.
          for (let nudge = 0; nudge < 6; nudge++) {
            const ang = edgeAngle + (i / n) * Math.PI * 2 + nudge * 0.5;
            const ok = queueAmbush(w, e.x + Math.cos(ang) * CHOIR.fragmentRingDist, e.y + Math.sin(ang) * CHOIR.fragmentRingDist, voiceKind, voiceTier, e.id + 1, ev);
            if (ok) break;
          }
        }
      }
    }
  }

  if (a.phase === "windup") { choirWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { choirActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "fade" ? CHOIR.fadeRecover : CHOIR.wailRecover)) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { choirBeginAttack(e, ev); return; }
  // Idle drift toward the target (it floats through geometry like its kin).
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  moveEnemyBy(w, e, Math.cos(angle) * e.speed * dt, Math.sin(angle) * e.speed * dt);
}

function choirBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = CHOIR.attackCd[boss.phase];
  if (boss.attackCount % CHOIR.fadeEvery === 0) {
    beginWindup(e, "fade");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.6, gain: 0.5, trauma: 0 });
    return;
  }
  beginWindup(e, "wail");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
}

function choirWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "split") {
    // The split beat: the Choir is scattered into its wisps. Reforms when they all die
    // (past the minimum readable beat) or at the hard cap; the queued overflow lands then.
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIR.splitDuration);
    const isBreakable = a.time >= CHOIR.splitMinDuration;
    if (a.time >= CHOIR.splitDuration || (isBreakable && countLiveBeatAdds(w, e) === 0)) {
      e.boss!.beatAddIds.length = 0;
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "fade") {
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIR.fadeWindup);
    if (a.time >= CHOIR.fadeWindup) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.8, gain: 0.5, trauma: 0 });
    }
    return;
  }
  // wail
  if (stepWindupTimer(w, e, dt, CHOIR.wailWindup, CHOIR.wailLock, false)) {
    choirWailFire(w, e, ev);
    enterRecover(e);
  }
}

function choirActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "harmonize") {
    // The singing refrain (fair surprise): unmade while its fresh verse gathers —
    // bounded, drifting, and ALWAYS with the fragments up as the redirected target.
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIR.singDuration);
    if (findTarget(w, e.x, e.y)) {
      const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      moveEnemyBy(w, e, Math.cos(angle) * e.speed * 0.5 * dt, Math.sin(angle) * e.speed * 0.5 * dt);
    }
    if (a.time >= CHOIR.singDuration) enterIdle(e);
    return;
  }
  // The fade: intangible, drifting through the target's position — keep moving.
  a.time += dt;
  a.windup = Math.min(1, a.time / CHOIR.fadeDuration);
  if (findTarget(w, e.x, e.y)) {
    const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
    const step = e.speed * CHOIR.fadeSpeedMult * dt;
    moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  }
  if (a.time >= CHOIR.fadeDuration) {
    choirRematerialize(w, e, ev);
    enterRecover(e);
  }
}

// Re-forming is loud: from P2 a ring of shards blooms out of the reassembly point.
function choirRematerialize(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const n = CHOIR.burstShards[boss.phase];
  const base = (boss.burstParity ^= 1) ? Math.PI / Math.max(1, n) : 0;
  for (let i = 0; i < n; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / n) * Math.PI * 2, CHOIR.burstSpeed, CHOIR.shardRadius, CHOIR.shardDamage, "#bfe9ff", CHOIR.shardLife);
  }
  if (n > 0) ev.push({ t: "radialBurst", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.8, gain: 0.7, trauma: 0.08 });
}

// The wail volley: slow seekers with a capped turn rate, fanned around the locked bearing.
function choirWailFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  // The soft-enrage pattern: one more seeker in the volley (the Choir's authored lever).
  const n = CHOIR.wailCount[boss.phase] + boss.enrage;
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * CHOIR.wailSpread;
    const ang = a.lockedAngle + off;
    w.bullets.push({
      x: e.x + Math.cos(ang) * (e.radius + 6), y: e.y + Math.sin(ang) * (e.radius + 6),
      vx: Math.cos(ang) * CHOIR.wailSpeed, vy: Math.sin(ang) * CHOIR.wailSpeed,
      radius: CHOIR.wailRadius, life: CHOIR.wailLife, friendly: false, owner: null,
      damage: CHOIR.wailDamage, color: "#9fd8ff", pierce: 0, hitList: null, isCrit: false,
      homing: CHOIR.wailTurnRate,
    });
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

// THE WEAVER (spec §5d, earned-window flagship + fair surprise). Read the weave,
// force it out, punish — GUARDED (30% chip) by default, and every window is
// PLAYER-CREATED per the designer's exact phase structure:
//   P1 (100–65%) READ THE WEAVE: the weave PARTITIONS the arena — silk LANES (sticky
//     rows, move ×0.5, a dash clears what it crosses) strung on glowing KNOT anchors
//     (never where a player stands) — and its blink-strike commits along a knot's
//     thread. Shoot a knot → its lane collapses → EXPOSED 3s (breaks combine); a knot
//     shot out mid-blink SNAGS her into a crash.
//   P2 (65–30%)  SHE CLIMBS: untargetable on the walls, dropping omen-telegraphed
//     spiderling ambushes and AIMED SILK that webs where it lands. DPS is redirected,
//     never idled: destroy every EGG-SAC of the clutch to FORCE HER DOWN → marked
//     descent, crash stagger, EXPOSED 4s. Ignored sacs mean she eventually descends on
//     her own — with NO window.
//   P3 (30–0%)   WALL-CRAWL DASH: she scurries to a lane's end and CHARGE-DASHES the
//     lanes she built — the target lane's silk FLARES for the whole locked 0.7s tell.
//     An intact lane brakes her at the far end (no window); a broken/empty one —
//     knot dead, or its silk dash-cleared out from under her — can't: she OVERSHOOTS
//     into the wall → crash stagger + EXPOSED 4s.
// Phase transitions RESHAPE the weave (molt: fresh seeded lattice, every old knot,
// lane and sac crumbles) so lane memory resets. Webs stay slow-zones, never damage.
function updateWeaver(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { weaverWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { weaverActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "crash" ? weaverStaggerOf(boss.phase)
      : a.move === "pounce" ? WEAVER.unforcedRecover
      : a.move === "blink" ? WEAVER.blinkRecover
      : a.move === "rush" ? WEAVER.dashRecover
      : WEAVER.weaveRecover;
    if (a.time >= recDur) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) {
    // P3's dash turn: wall-crawl to the chosen lane's entry first, commit when there.
    if (boss.phase >= 3 && !boss.isNextRadial) {
      const knot = weaverPickDashLane(w, e);
      if (knot) {
        const entry = weaverLaneEntry(w, e, knot);
        if (Math.hypot(entry.x - e.x, entry.y - e.y) > WEAVER.crawlNear) {
          const angle = Math.atan2(entry.y - e.y, entry.x - e.x);
          const step = e.speed * WEAVER.crawlSpeedMult * dt;
          moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
          return;
        }
        weaverBeginDash(w, e, knot, ev);
        return;
      }
    }
    weaverBeginAttack(w, e, ev);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  // Between pounces the duelist stalks around cover on the boss-clearance field rather than
  // pressing straight into a wall — the blink/weave attacks still handle vertical closes.
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

// The crash stagger per phase: the P1 snag, the P2 forced-down, the P3 overshoot.
function weaverStaggerOf(phase: number): number {
  return phase >= 3 ? WEAVER.dashStagger : phase === 2 ? WEAVER.descendStagger : WEAVER.snagStagger;
}

// Per-phase commitments: P1 weave (string the lattice) / blink-strike along it; P2 the
// climb loop; P3 weave (re-string) alternating the lane dash (committed above once the
// crawl arrives). A blink with no lattice left re-lays instead — never a stall.
function weaverBeginAttack(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0;
  e.attack.cooldown = WEAVER.attackCd[boss.phase];
  const isFirst = boss.isNextRadial;
  boss.isNextRadial = !boss.isNextRadial;
  let move: AttackMove;
  if (boss.phase === 2) move = "dive";
  else if (boss.phase >= 3) move = "weave";
  else move = isFirst && weaverHasLiveKnot(w, e) ? "blink" : "weave";
  beginWindup(e, move);
  if (move === "blink" && !weaverCommitBlink(w, e)) {
    // No reachable lane after all (walls closed in): re-lay instead — never stall.
    beginWindup(e, "weave");
    move = "weave";
  }
  if (move === "dive") weaverBeginClimb(w, e, ev);
  const rate = move === "weave" ? 0.7 : move === "dive" ? 1.4 : 1.0;
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate, gain: 0.65, trauma: 0 });
}

// The P3 dash commitment: the lane, its exit mark and the snag identity all freeze
// HERE — the whole flare is the post-lock window, and the lane's silk is the read.
function weaverBeginDash(w: WorldState, e: Enemy, knot: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0;
  boss.isNextRadial = true; // the next commitment re-strings
  e.attack.cooldown = WEAVER.attackCd[boss.phase];
  beginWindup(e, "rush");
  const a = e.attack;
  const exit = weaverLaneExit(w, e, knot);
  a.lockedAngle = Math.atan2(exit.y - e.y, exit.x - e.x);
  a.isAimLocked = true;
  a.markX = exit.x;
  a.markY = exit.y;
  boss.laneKnotId = knot.id + 1;
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.75, trauma: 0 });
}

// The climb's ascent: pick the nearest wall-adjacent perch, and bloom the clutch — the
// egg-sac AMBUSH omens (never on a player) that gate this climb's forced-down window.
function weaverBeginClimb(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const perch = weaverWallPerch(w, e);
  e.attack.markX = perch.x;
  e.attack.markY = perch.y;
  boss.burstParity = 0;
  boss.windowAddIds.length = 0;
  // Surviving sacs from the last climb still count — alternate-target damage is never
  // wasted; the clutch only tops back up to the pull's count.
  let live = 0;
  for (const other of w.enemies) {
    if (other.dead || other.kind !== "sac" || other.seq !== e.id + 1) continue;
    boss.windowAddIds.push(other.id);
    live++;
  }
  const want = WEAVER.sacsFor[w.encounterPlayers];
  const base = w.rng.next() * Math.PI * 2;
  for (let i = 0; live < want && i < want * 6; i++) {
    const ang = base + i * 2.399963; // golden-angle scatter: deterministic, well-spread
    // Egg-sacs live ON THE WALLS (spec P2): march the ray out to the chamber wall and
    // clutch a body's width inside it. The march is bounded — she perches ON a wall,
    // so nearby faces exist; a rayless direction (open running room) falls back to the
    // ring, keeping the task walk-completable instead of a cross-chamber hike.
    let x = e.x + Math.cos(ang) * WEAVER.sacRingDist;
    let y = e.y + Math.sin(ang) * WEAVER.sacRingDist;
    for (let d = TILE; d <= TILE * 8; d += TILE * 0.5) {
      const wx = e.x + Math.cos(ang) * d;
      const wy = e.y + Math.sin(ang) * d;
      if (!isWall(w, wx, wy)) continue;
      x = wx - Math.cos(ang) * 22;
      y = wy - Math.sin(ang) * 22;
      break;
    }
    // The clutch stays IN THE CHAMBER (line of sight to the perch): a sac walled off
    // in the next room would be an unreachable objective — never fair.
    if (!hasLineOfSight(w, e.x, e.y, x, y)) continue;
    if (queueAmbush(w, x, y, "sac", "standard", e.id + 1, ev)) live++;
  }
}

// The nearest wall-adjacent floor point: her perch while climbing (rendered clinging).
function weaverWallPerch(w: WorldState, e: Enemy): { x: number; y: number } {
  let best = { x: e.x, y: e.y };
  let bestD = Infinity;
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    // March outward until the wall, then step back a body's width.
    for (let d = TILE; d <= TILE * 14; d += TILE * 0.5) {
      const x = e.x + Math.cos(ang) * d;
      const y = e.y + Math.sin(ang) * d;
      if (!isWall(w, x, y)) continue;
      const px = x - Math.cos(ang) * (e.radius + 10);
      const py = y - Math.sin(ang) * (e.radius + 10);
      const dist = Math.hypot(px - e.x, py - e.y);
      if (dist < bestD) { bestD = dist; best = { x: px, y: py }; }
      break;
    }
  }
  return best;
}

function weaverWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    // The molt: a fixed cocoon beat that bursts into a ring of web-bolts on exit,
    // then RESHAPES the weave — the phase-shift that resets lane memory.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.moltDuration);
    if (a.time >= WEAVER.moltDuration) {
      for (let i = 0; i < WEAVER.moltBoltCount; i++) {
        spawnEnemyBullet(w, e.x, e.y, (i / WEAVER.moltBoltCount) * Math.PI * 2, WEAVER.moltBoltSpeed, WEAVER.shardRadius, WEAVER.shardDamage, "#c98bff", WEAVER.shardLife);
      }
      // The soft-enrage pattern: a second, slower OFFSET ring — a denser weave to
      // read on the way out, never a damage change.
      if (e.boss!.enrage === 1) {
        for (let i = 0; i < WEAVER.moltBoltCount; i++) {
          spawnEnemyBullet(w, e.x, e.y, Math.PI / WEAVER.moltBoltCount + (i / WEAVER.moltBoltCount) * Math.PI * 2, WEAVER.moltBoltSpeed * 0.8, WEAVER.shardRadius, WEAVER.shardDamage, "#c98bff", WEAVER.shardLife);
        }
      }
      ev.push({ t: "radialBurst", x: e.x, y: e.y });
      enterIdle(e);
      weaverMoltReshape(w, e, ev);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "weave") {
    // A self-cast re-stringing: fixed tell, no aim — the lattice rises around HER.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.weaveWindup);
    if (a.time >= WEAVER.weaveWindup) {
      weaverLayLattice(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.move === "blink") {
    // The lane + arrival mark froze at commit (weaverCommitBlink) — the whole tell is
    // the post-lock dodge window. Shooting the lane's knot NOW snags the strike.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.blinkWindup);
    if (a.time >= WEAVER.blinkWindup) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.5, gain: 0.7, trauma: 0 });
    }
    return;
  }
  if (a.move === "dive") {
    // The ascent: she scurries to her perch (still targetable) and climbs at the tell's end.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.climbAscend);
    const angle = Math.atan2(a.markY - e.y, a.markX - e.x);
    const step = e.speed * WEAVER.crawlSpeedMult * dt;
    if (Math.hypot(a.markX - e.x, a.markY - e.y) > step) {
      moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
    }
    if (a.time >= WEAVER.climbAscend) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.6, gain: 0.6, trauma: 0 });
    }
    return;
  }
  if (a.move === "rush") {
    // The lane flare: the committed lane's silk burns bright for the whole locked tell.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.dashFlare);
    if (a.time >= WEAVER.dashFlare) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.8, gain: 0.85, trauma: 0.05 });
    }
    return;
  }
  // pounce — the marked descent off the wall (mark frozen at commit).
  a.time += dt;
  a.windup = Math.min(1, a.time / WEAVER.descendTell);
  if (a.time >= WEAVER.descendTell) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.1, gain: 0.8, trauma: 0.05 });
  }
}

function weaverActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "dive") { weaverClimbActive(w, e, dt, ev); return; }
  if (a.move === "rush") { weaverDashActive(w, e, dt, ev); return; }
  // Airborne (blink traverse / descent): lerp to the locked mark, untargetable for the
  // bounded beat.
  a.time += dt;
  const airTime = a.move === "blink" ? WEAVER.blinkAir : WEAVER.descendAir;
  const prev = a.windup;
  a.windup = Math.min(1, a.time / airTime);
  const rem = 1 - prev;
  if (rem > 0.0001) {
    const f = Math.min(1, (a.windup - prev) / rem);
    e.x += (a.markX - e.x) * f;
    e.y += (a.markY - e.y) * f;
  }
  if (a.time < airTime) return;
  if (a.move === "blink") {
    weaverBlinkArrive(w, e, ev);
    return;
  }
  weaverDescendLand(w, e, ev);
}

// The climb (P2): untargetable on the wall — bounded by climbMax — while the pressure
// stays on the FLOOR: aimed-silk volleys (a charging tell rides the windup channel) and
// omen-telegraphed spiderling ambushes from the curated pool. Destroying the whole
// clutch forces her down with the window; ignoring it only delays her — no window.
function weaverClimbActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  a.time += dt;
  // Aimed silk: charge for silkWindup at the end of each cycle, then loose the fan.
  const tCycle = a.time - boss.spinCount * WEAVER.silkEvery;
  a.windup = Math.max(0, Math.min(1, (tCycle - (WEAVER.silkEvery - WEAVER.silkWindup)) / WEAVER.silkWindup));
  if (!a.isAimLocked && a.windup > 0 && findTarget(w, e.x, e.y)) {
    a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
    if (a.windup >= 0.55) a.isAimLocked = true; // ≥0.30s of the tell is post-lock
  }
  if (tCycle >= WEAVER.silkEvery) {
    weaverSilkVolley(w, e, ev);
    boss.spinCount++;
    a.isAimLocked = false;
  }
  // Spiderling drops: the pool draw, omen-telegraphed near her perch. The R framework
  // tightens the cadence and lifts the live cap with the pull's surplus (hard-clamped),
  // and the phase's ONE surprise wave (R ≥ surpriseMinR) doubles a slot INSIDE the
  // same budget — never on top of it, never during a beat.
  boss.addTimer -= dt;
  if (boss.addTimer <= 0) {
    boss.addTimer = bossAddIntervalFor(WEAVER.spiderlingEvery, w.encounterPower);
    const cap = bossAddCapFor(WEAVER.spiderlingCapBase, w.encounterPower);
    const isSurprise = w.encounterPower >= POWER.surpriseMinR && !boss.isSurpriseSpent;
    if (isSurprise) boss.isSurpriseSpent = true;
    for (let i = 0; i < (isSurprise ? 2 : 1); i++) {
      if (countBossAdds(w) + countPendingOmens(w) >= cap) break;
      const entry = drawFromAddPool(w, e, WEAVER.addPool);
      if (!entry) break;
      if (isSurprise) queueAmbushWave(w, e, 190, entry, 0, ev, POWER.surpriseTell, POWER.surpriseClear);
      else queueAmbushWave(w, e, 150, entry, 0, ev);
    }
  }
  // The forced-down switch: the whole clutch is silenced (and none still blooming).
  const hasClutch = boss.windowAddIds.length > 0;
  if (hasClutch && countLiveIds(w, boss.windowAddIds) === 0 && countPendingOmensFor(w, e.id) === 0) {
    boss.windowAddIds.length = 0;
    weaverBeginDescend(w, e, true, ev);
    return;
  }
  // Bounded: past climbMax she descends on her own — with NO window.
  if (a.time >= WEAVER.climbMax) weaverBeginDescend(w, e, false, ev);
}

// The descent commitment: a marked drop to a settled floor point pulled toward the
// nearest player but STOPPED clear of every body — forced descents pay the window,
// voluntary ones only a brief recover. burstParity carries the forced flag to landing.
function weaverBeginDescend(w: WorldState, e: Enemy, isForced: boolean, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.burstParity = isForced ? 1 : 0;
  let x = e.x, y = e.y;
  if (findTarget(w, e.x, e.y)) {
    const toward = Math.atan2(w.targetY - e.y, w.targetX - e.x);
    const dist = Math.max(60, Math.min(200, Math.hypot(w.targetX - e.x, w.targetY - e.y) - (WEAVER.pounceRadius + 30)));
    x = e.x + Math.cos(toward) * dist;
    y = e.y + Math.sin(toward) * dist;
  }
  if (settleSpawnPoint(w, x, y, e.radius)) { x = settlePoint.x; y = settlePoint.y; }
  const a = e.attack;
  a.move = "pounce";
  a.phase = "windup";
  a.time = 0;
  a.windup = 0;
  a.isAimLocked = true;
  a.markX = x;
  a.markY = y;
  ev.push({ t: "cue", name: "enemyHit", x, y, rate: 0.45, gain: 0.7, trauma: 0 });
}

// The landing: the shared pounce read (center-heavy ring), splintered cover — then the
// forced-down crash + window, or just a brief recover when she came down on her own.
function weaverDescendLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    const d = Math.hypot(p.x - a.markX, p.y - a.markY);
    if (d < WEAVER.pounceInnerRadius) damagePlayer(w, p, WEAVER.pounceCenterDamage, ev);
    else if (d < WEAVER.pounceRadius) damagePlayer(w, p, WEAVER.pounceOuterDamage, ev);
  }
  enemySmashEnvironment(w, a.markX, a.markY, WEAVER.pounceRadius, ev);
  ev.push({ t: "bossSlam", x: a.markX, y: a.markY });
  if (boss.burstParity === 1) {
    boss.burstParity = 0;
    a.move = "crash";
    enterRecover(e);
    openBossWindow(e, WEAVER.forcedownExpose, ev);
    ev.push({ t: "chargeCrash", x: e.x, y: e.y });
    return;
  }
  enterRecover(e); // voluntary: the brief unforcedRecover, no window
}

// Aimed silk (P2): a readable fan whose bolts WEB where they land — pressure that
// builds the floor against you while she is up.
function weaverSilkVolley(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  // The soft-enrage pattern: a wider fan (+2 bolts) — more silk to read, same damage.
  const bolts = WEAVER.silkBolts + (e.boss!.enrage === 1 ? 2 : 0);
  for (let i = 0; i < bolts; i++) {
    const off = (i - (bolts - 1) / 2) * WEAVER.silkSpread;
    const ang = a.lockedAngle + off;
    w.bullets.push({
      x: e.x + Math.cos(ang) * (e.radius + 6), y: e.y + Math.sin(ang) * (e.radius + 6),
      vx: Math.cos(ang) * WEAVER.silkSpeed, vy: Math.sin(ang) * WEAVER.silkSpeed,
      radius: WEAVER.shardRadius, life: WEAVER.silkLife, friendly: false, owner: null,
      damage: WEAVER.silkDamage, color: "#e6c2ff", pierce: 0, hitList: null, isCrit: false,
      isSilk: true,
    });
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

// The P3 charge-dash: full speed along the committed lane. The lane's live silk (and
// its live knot) brake her at the far end — a broken/empty lane cannot, and the wall
// does it for her: the overshoot crash IS the window.
function weaverDashActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  a.time += dt;
  const step = WEAVER.dashSpeed * dt;
  const x0 = e.x, y0 = e.y;
  rushSmashEnvironment(w, e, ev);
  moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
  ev.push({ t: "lungeTrail", x: e.x, y: e.y });
  // Wall impact (marrow's lane-progress law): the overshoot she couldn't brake out of.
  const along = (e.x - x0) * Math.cos(a.lockedAngle) + (e.y - y0) * Math.sin(a.lockedAngle);
  if (along < step * chillMoveScale(e) * 0.5) {
    boss.laneKnotId = 0;
    a.move = "crash";
    enterRecover(e);
    openBossWindow(e, WEAVER.overshootExpose, ev);
    ev.push({ t: "chargeCrash", x: e.x, y: e.y });
    return;
  }
  // Past the exit mark: an INTACT lane (live knot + live silk) brakes her there.
  const past = (e.x - a.markX) * Math.cos(a.lockedAngle) + (e.y - a.markY) * Math.sin(a.lockedAngle);
  if (past >= 0) {
    const knot = w.enemies.find((o) => !o.dead && o.kind === "knot" && o.id === boss.laneKnotId - 1);
    if (knot && weaverLaneSilkCount(w, knot) >= WEAVER.laneBrakeSilk) {
      boss.laneKnotId = 0;
      // The R framework's density lever: at R ≥ 3 a braked dash CHAINS one more lane
      // (full flare tell, same overshoot bait) — one extra committed pattern, never a
      // stat. spinCount counts the chain; a crash always ends the sequence.
      if (w.encounterPower >= 3 && boss.spinCount < 1) {
        const next = weaverPickDashLane(w, e);
        if (next && next.id !== knot.id) {
          boss.spinCount++;
          weaverCommitChainedDash(w, e, next, ev);
          return;
        }
      }
      enterRecover(e); // controlled brake: no window
      return;
    }
  }
  if (a.time >= 1.6) { boss.laneKnotId = 0; enterRecover(e); } // hard safety bound
}

// The chained dash (R ≥ 3): the same full flare tell + lane commit, WITHOUT consuming
// a new attack slot — the chain is one commitment's pattern, not a faster rotation.
function weaverCommitChainedDash(w: WorldState, e: Enemy, knot: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const a = e.attack;
  a.phase = "windup";
  a.time = 0;
  a.windup = 0;
  const exit = weaverLaneExit(w, e, knot);
  a.lockedAngle = Math.atan2(exit.y - e.y, exit.x - e.x);
  a.isAimLocked = true;
  a.markX = exit.x;
  a.markY = exit.y;
  boss.laneKnotId = knot.id + 1;
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.75, trauma: 0 });
}

// ---- the lattice: knots, lanes, silk ----

// A mechanic body's OWNER rides its seq scratch (owner enemy id + 1, sim-internal):
// lattices and clutches belong to the weaver that cast them, so a broken knot can
// never expose a different weaver (two can coexist — a dev spawn on its boss floor).
function weaverOwnerOf(w: WorldState, body: Enemy): Enemy | null {
  for (const e of w.enemies) {
    if (!e.dead && e.kind === "weaver" && e.id === body.seq - 1) return e;
  }
  return null;
}

function weaverHasLiveKnot(w: WorldState, e: Enemy): boolean {
  for (const other of w.enemies) {
    if (!other.dead && other.kind === "knot" && other.seq === e.id + 1) return true;
  }
  return false;
}

// The strung lane of a knot: the silk row along its committed thread (lockedAngle),
// wall-clamped to laneHalf each side. End points are derived, never stored — the same
// walls give the same lane on every client.
function weaverLaneEnds(w: WorldState, knot: Enemy): { x1: number; y1: number; x2: number; y2: number } {
  const dir = knot.attack.lockedAngle;
  const reach = (sign: number): number => {
    let end = 0;
    for (let d = TILE * 0.4; d <= WEAVER.laneHalf; d += TILE * 0.4) {
      if (isWall(w, knot.x + Math.cos(dir) * d * sign, knot.y + Math.sin(dir) * d * sign)) break;
      end = d;
    }
    return end;
  };
  const r1 = reach(1), r2 = reach(-1);
  return {
    x1: knot.x + Math.cos(dir) * r1, y1: knot.y + Math.sin(dir) * r1,
    x2: knot.x - Math.cos(dir) * r2, y2: knot.y - Math.sin(dir) * r2,
  };
}

function weaverLaneEntry(w: WorldState, e: Enemy, knot: Enemy): { x: number; y: number } {
  const ends = weaverLaneEnds(w, knot);
  const d1 = Math.hypot(ends.x1 - e.x, ends.y1 - e.y);
  const d2 = Math.hypot(ends.x2 - e.x, ends.y2 - e.y);
  return d1 <= d2 ? { x: ends.x1, y: ends.y1 } : { x: ends.x2, y: ends.y2 };
}

function weaverLaneExit(w: WorldState, e: Enemy, knot: Enemy): { x: number; y: number } {
  const ends = weaverLaneEnds(w, knot);
  const d1 = Math.hypot(ends.x1 - e.x, ends.y1 - e.y);
  const d2 = Math.hypot(ends.x2 - e.x, ends.y2 - e.y);
  return d1 <= d2 ? { x: ends.x2, y: ends.y2 } : { x: ends.x1, y: ends.y1 };
}

// Distance from a point to the knot's lane SEGMENT.
function weaverLaneDistance(w: WorldState, knot: Enemy, x: number, y: number): number {
  const ends = weaverLaneEnds(w, knot);
  const dx = ends.x2 - ends.x1, dy = ends.y2 - ends.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ends.x1) * dx + (y - ends.y1) * dy) / len2)) : 0;
  return Math.hypot(x - (ends.x1 + dx * t), y - (ends.y1 + dy * t));
}

function weaverLaneSilkCount(w: WorldState, knot: Enemy): number {
  let n = 0;
  for (const h of w.hazards) {
    if (h.kind !== "web" || h.life <= 0) continue;
    if (weaverLaneDistance(w, knot, h.x, h.y) <= WEAVER.laneWebRadius + 8) n++;
  }
  return n;
}

// The dash target: the live lane whose thread passes nearest a standing player — the
// lane that MATTERS. Deterministic tie-break by knot id.
function weaverPickDashLane(w: WorldState, e: Enemy): Enemy | null {
  if (!findTarget(w, e.x, e.y)) return null;
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const other of w.enemies) {
    if (other.dead || other.kind !== "knot" || other.seq !== e.id + 1) continue;
    const d = weaverLaneDistance(w, other, w.targetX, w.targetY);
    if (d < bestD || (d === bestD && best !== null && other.id < best.id)) { bestD = d; best = other; }
  }
  return best;
}

// String silk along a knot's lane: sticky rows at fixed spacing, skipping slots that
// already hold silk (a re-string tops up, never stacks). Silk shares the knot's clock.
function weaverStringLane(w: WorldState, knot: Enemy, ev: SimEvent[]): void {
  const dir = knot.attack.lockedAngle;
  for (const sign of [1, -1]) {
    for (let d = WEAVER.laneWebSpacing; d <= WEAVER.laneHalf; d += WEAVER.laneWebSpacing) {
      const x = knot.x + Math.cos(dir) * d * sign;
      const y = knot.y + Math.sin(dir) * d * sign;
      if (isWall(w, x, y)) break;
      let isHeld = false;
      for (const h of w.hazards) {
        if (h.kind === "web" && Math.hypot(h.x - x, h.y - y) < WEAVER.laneWebSpacing * 0.5) { isHeld = true; break; }
      }
      if (!isHeld) plantWeb(w, x, y, WEAVER.laneWebRadius, ev);
    }
  }
  plantWeb(w, knot.x, knot.y, WEAVER.laneWebRadius, ev);
}

function plantWeb(w: WorldState, x: number, y: number, radius: number, ev: SimEvent[]): void {
  let webs = 0;
  for (const h of w.hazards) if (h.kind === "web") webs++;
  if (webs >= WEAVER.maxWebs) return; // hard cap: sticky, never solid
  if (isWall(w, x, y)) return;
  w.hazards.push({ id: w.nextHazardId++, kind: "web", x, y, radius, life: WEAVER.webLife, maxLife: WEAVER.webLife });
  ev.push({ t: "webPlaced", x, y, r: radius });
}

// Lay/refresh the lattice: top the knots up to the pull's count (co-op scales the
// MECHANIC — more players, more anchors), each ringed off the Weaver on a golden-angle
// scatter, NEVER inside knotPlayerClear of a standing player, and string every live
// lane's silk. Each knot's lockedAngle IS its strung thread.
function weaverLayLattice(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const want = WEAVER.knotsFor[w.encounterPlayers];
  const mine: Enemy[] = [];
  for (const other of w.enemies) {
    if (!other.dead && other.kind === "knot" && other.seq === e.id + 1) mine.push(other);
  }
  const base = w.rng.next() * Math.PI * 2;
  for (let i = 0; mine.length < Math.min(want, WEAVER.maxKnots) && i < WEAVER.maxKnots * 4; i++) {
    const ang = base + i * 2.399963;
    const x = e.x + Math.cos(ang) * WEAVER.knotRingDist;
    const y = e.y + Math.sin(ang) * WEAVER.knotRingDist;
    if (isNearAnyPlayer(w, x, y, WEAVER.knotPlayerClear)) continue;
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.knot.radius)) continue;
    const knot = createEnemy("knot", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, { isSummoned: true });
    knot.aux = WEAVER.knotLife;
    knot.seq = e.id + 1; // the caster's identity (see weaverOwnerOf)
    knot.spawnTimer = 0;
    knot.attack.lockedAngle = w.rng.next() * Math.PI; // the strung thread's orientation
    w.enemies.push(knot);
    ev.push({ t: "enemySpawn", eid: knot.id, kind: knot.kind, tier: knot.tier, x: knot.x, y: knot.y });
    mine.push(knot);
  }
  for (const knot of mine) weaverStringLane(w, knot, ev);
}

function isNearAnyPlayer(w: WorldState, x: number, y: number, range: number): boolean {
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - x, p.y - y) < range) return true;
  }
  return false;
}

// The phase shift that changes the room (fair surprise §3): the molt crumbles every
// knot, lane, sac and pending bloom, then strings a FRESH seeded lattice — new lane
// geometry each phase, telegraphed by the cocoon beat itself. Webs only slow, so the
// reshape can never wall anyone in.
function weaverMoltReshape(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  for (const other of w.enemies) {
    if (other.dead || other.seq !== e.id + 1) continue;
    if (other.kind !== "knot" && other.kind !== "sac") continue;
    other.dead = true;
    ev.push({ t: "puff", x: other.x, y: other.y, n: 5, color: ENEMY_ARCHETYPES[other.kind].tint });
  }
  for (const h of w.hazards) {
    if (h.kind === "web") h.life = 0;
    if (h.kind === "omen" && h.forBossId === e.id + 1) { h.life = 0; h.spawnKind = undefined; }
  }
  w.hazards = w.hazards.filter((h) => h.life > 0);
  boss.windowAddIds.length = 0;
  weaverLayLattice(w, e, ev);
  // Fresh lanes stand ready: P3's first commitment is the dash that uses them.
  if (boss.phase >= 3) boss.isNextRadial = false;
}

// Commit the blink-strike (P1): pick the live knot nearest the target, then the one of
// its thread's directions that best bears on the target. The lane, the arrival mark
// and the snag identity (laneKnotId) all freeze HERE, at windup start — the entire
// 0.7s tell is the post-lock window, and shooting THAT knot mid-commitment snags her.
function weaverCommitBlink(w: WorldState, e: Enemy): boolean {
  if (!findTarget(w, e.x, e.y)) return false;
  const boss = e.boss!;
  const a = e.attack;
  let knot: Enemy | null = null;
  let bestD = Infinity;
  for (const other of w.enemies) {
    if (other.dead || other.kind !== "knot" || other.seq !== e.id + 1) continue;
    const d = Math.hypot(other.x - w.targetX, other.y - w.targetY);
    if (d < bestD) { bestD = d; knot = other; }
  }
  if (!knot) return false;
  const toTarget = Math.atan2(w.targetY - knot.y, w.targetX - knot.x);
  let dir = 0;
  let bestDot = -Infinity;
  for (let k = 0; k < 6; k++) {
    const lane = knot.attack.lockedAngle + k * (Math.PI / 3);
    const dot = Math.cos(lane - toTarget);
    if (dot > bestDot) { bestDot = dot; dir = lane; }
  }
  // March the lane from the knot to the wall (capped): the arrival mark.
  const step = TILE * 0.4;
  let end = 0;
  for (let d = step; d <= WEAVER.laneHalf; d += step) {
    if (isWall(w, knot.x + Math.cos(dir) * d, knot.y + Math.sin(dir) * d)) break;
    end = d;
  }
  if (end < step) return false; // the lane dead-ends into a wall immediately
  a.lockedAngle = dir;
  a.isAimLocked = true;
  a.markX = knot.x + Math.cos(dir) * end;
  a.markY = knot.y + Math.sin(dir) * end;
  boss.laneKnotId = knot.id + 1;
  return true;
}

function weaverBlinkArrive(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  boss.laneKnotId = 0;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - a.markX, p.y - a.markY) < WEAVER.blinkStrikeRadius) {
      damagePlayer(w, p, WEAVER.blinkStrikeDamage, ev);
    }
  }
  enemySmashEnvironment(w, a.markX, a.markY, WEAVER.blinkStrikeRadius, ev);
  ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES.weaver.tint });
  enterRecover(e);
}

// A knot was SHOT (fuse expiry never lands here): the lane collapses — its silk
// crumbles into loose debris — P1 earns the exposed window, and a Weaver mid-blink on
// THIS knot's thread is snagged out of the air into a crash stagger.
function weaverKnotBroken(w: WorldState, knot: Enemy, ev: SimEvent[]): void {
  weaverCrumbleLane(w, knot, ev);
  plantWeb(w, knot.x, knot.y, WEAVER.knotDebrisRadius, ev);
  const e = weaverOwnerOf(w, knot);
  if (!e) return;
  const boss = e.boss!;
  const a = e.attack;
  const isOnLane = a.move === "blink" && (a.phase === "windup" || a.phase === "active")
    && boss.laneKnotId === knot.id + 1;
  if (isOnLane) {
    boss.laneKnotId = 0;
    a.move = "crash";
    enterRecover(e);
    ev.push({ t: "chargeCrash", x: e.x, y: e.y });
  }
  if (boss.phase === 1) openBossWindow(e, WEAVER.knotBreakExpose, ev);
}

// The lane's silk crumbles with its anchor.
function weaverCrumbleLane(w: WorldState, knot: Enemy, ev: SimEvent[]): void {
  for (const h of w.hazards) {
    if (h.kind !== "web" || h.life <= 0) continue;
    if (weaverLaneDistance(w, knot, h.x, h.y) <= WEAVER.laneWebRadius + 8) {
      h.life = 0;
      ev.push({ t: "puff", x: h.x, y: h.y, n: 3, color: "#c98bff" });
    }
  }
}

// The lattice knot: stationary, harmless, on a fuse (aux). Expiry crumbles the lane
// quietly — no debris, no window; only a player's shot earns the exposure (killEnemy
// routes that through weaverKnotBroken).
function updateKnot(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  e.aux -= dt;
  if (e.aux > 0) return;
  e.aux = 0;
  e.dead = true;
  weaverCrumbleLane(w, e, ev);
  ev.push({ t: "puff", x: e.x, y: e.y, n: 5, color: ENEMY_ARCHETYPES.knot.tint });
}

// The sanctify's cover reconfiguration: crumble the Warden's previous shelving, then
// raise a seeded ring of destructible cover around it. Every isConstructionSiteClear
// law holds (wall/exit standoffs, never on props, never on/beside a body), every
// coverGapEvery-th site stays OPEN by construction, and the pieces are ordinary
// breakable props — the reshape reorganizes the room, it can never seal a route.
function gildedReshapeCover(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  for (const p of w.props) {
    if (p.breakT === undefined && !p.dead && p.owner === e.id) destroyProp(w, p, ev);
  }
  const base = w.rng.next() * Math.PI * 2;
  let placed = 0;
  for (let i = 0; i < GILDED.coverSites; i++) {
    if (i % GILDED.coverGapEvery === GILDED.coverGapEvery - 1) continue; // the authored gap
    const ang = base + (i / GILDED.coverSites) * Math.PI * 2;
    const x = e.x + Math.cos(ang) * GILDED.coverRingDist;
    const y = e.y + Math.sin(ang) * GILDED.coverRingDist;
    if (isNearAnyPlayer(w, x, y, GILDED.coverPlayerClear)) continue;
    if (!isConstructionSiteClear(w, x, y)) continue;
    w.props.push({
      id: w.nextPropId++, kind: "clinker_brick", x, y,
      radius: C.PROP_RADIUS, hp: C.PROP_HP.clinker_brick, dead: false, owner: e.id,
    });
    ev.push({ t: "puff", x, y, n: 5, color: ENEMY_ARCHETYPES.gilded.tint });
    placed++;
  }
  if (placed > 0) w.obstacleRev++;
}

// THE HOLLOW CHOIR's hall reshape (fair surprise §3): the split beat already scatters the
// Choir into wisps — this EXTENDS that beat into an ARENA reshape. The hall's resonant
// pillars crumble and a fresh seeded ring rises, and the ring now VARIES BY PHASE (radius,
// gap pattern, site count read from CHOIR.reshapeByPhase[boss.phase]) so P2 and P3 read as
// genuinely different halls, not the same ring re-spun (the Weaver molt / Gilded cover
// shape, reused wholesale). Every isConstructionSiteClear law holds (wall/exit standoffs,
// never on props, never on/beside a body), every gapEvery-th site stays OPEN by
// construction (≥1 readable route always, per phase), and the pieces are ordinary breakable
// pillars. It fires ON the transition beat and NEVER touches the guard/exposed state — the
// only way to expose the Choir stays the verse silence, so the reshape can never open or
// extend a window.
function choirReshape(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  for (const p of w.props) {
    if (p.breakT === undefined && !p.dead && p.owner === e.id) destroyProp(w, p, ev);
  }
  // Per-phase hall (fair surprise §3): the ring RADIUS + GAP PATTERN + site count are read
  // from boss.phase, so P2 and P3 present genuinely different halls (not the same ring
  // re-spun). Clamped to the table so any future phase reuses the last hall. The random
  // base angle still rides the world RNG (one draw, exactly as before) — determinism holds.
  const phase = Math.min(e.boss?.phase ?? 1, CHOIR.reshapeByPhase.length - 1);
  const hall = CHOIR.reshapeByPhase[phase];
  const base = w.rng.next() * Math.PI * 2;
  let placed = 0;
  for (let i = 0; i < hall.sites; i++) {
    if (i % hall.gapEvery === hall.gapEvery - 1) continue; // the authored gap (≥3 per ring)
    const ang = base + (i / hall.sites) * Math.PI * 2;
    const x = e.x + Math.cos(ang) * hall.ringDist;
    const y = e.y + Math.sin(ang) * hall.ringDist;
    if (isNearAnyPlayer(w, x, y, CHOIR.reshapePlayerClear)) continue;
    if (!isConstructionSiteClear(w, x, y)) continue;
    w.props.push({
      id: w.nextPropId++, kind: "clinker_brick", x, y,
      radius: C.PROP_RADIUS, hp: C.PROP_HP.clinker_brick, dead: false, owner: e.id,
    });
    ev.push({ t: "puff", x, y, n: 5, color: ENEMY_ARCHETYPES.choir.tint });
    placed++;
  }
  if (placed > 0) w.obstacleRev++;
}

// THE GILDED WARDEN (spec §5e). The armored tempo boss — the earned-window pattern's
// precedent, now on the shared plumbing: closed plate = GUARDED (30% chip, see
// EARNED_WINDOWS in the damage funnel); each committed quake/sweep OPENS its recover
// as the exposed, bank-capped window — you dodge the commitment, then unload.
//   P1 (100–70%): alternating anvil slam / gold sweep every 3.6s.
//   P2 (70–35%):  3.2s cadence (sanctify beats at 70%/35%, King-style fixed roars).
//   P3 (35–0%):   2.8s cadence; the sweep releases a second offset wave.
function updateGilded(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { gildedWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { gildedActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "slam" ? GILDED.slamRecover : GILDED.sweepRecover)) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { gildedBeginAttack(e, ev); return; }
  // A stately advance — the Warden walks, it never chases — but it walks AROUND the room's
  // pillars and its own gilded cover on the boss-clearance field, never into them.
  if (!findTarget(w, e.x, e.y)) return;
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function gildedBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0; // sweep-wave counter
  e.attack.cooldown = GILDED.attackCd[boss.phase];
  const isSlam = !boss.isNextRadial;
  boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, isSlam ? "slam" : "sweep");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isSlam ? 0.35 : 0.55, gain: 0.75, trauma: 0 });
}

function gildedWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    // Sanctify: the King's fixed transition-roar semantics in gold.
    a.time += dt;
    a.windup = Math.min(1, a.time / GILDED.sanctifyDuration);
    if (a.time >= GILDED.sanctifyDuration) {
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "slam") {
    // The quake is centered on the Warden itself — the mark is its own feet.
    a.time += dt;
    a.windup = Math.min(1, a.time / GILDED.slamWindup);
    a.markX = e.x; a.markY = e.y;
    if (!a.isAimLocked) {
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      if (a.time >= GILDED.slamLock) a.isAimLocked = true;
    }
    if (a.time >= GILDED.slamWindup) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.5, gain: 0.9, trauma: 0.05 });
    }
    return;
  }
  // sweep
  a.time += dt;
  a.windup = Math.min(1, a.time / GILDED.sweepWindup);
  if (a.time >= GILDED.sweepWindup) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    gildedSweepWave(w, e, ev);
  }
}

function gildedActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  a.time += dt;
  if (a.move === "slam") {
    if (a.time >= GILDED.slamActive) {
      gildedSlamResolve(w, e, ev);
      enterRecover(e);
      // The plate hangs open: the committed quake OPENS its recover as the earned
      // window (full damage, bank-capped) — dodge the commitment, then unload.
      openBossWindow(e, GILDED.slamRecover, ev);
    }
    return;
  }
  // sweep: wave one fired at release; P3's offset second wave follows after the gap.
  // spinCount counts the EXTRA waves already released this commitment.
  const boss = e.boss!;
  // The soft-enrage pattern: one more offset wave to walk through — never faster, never
  // heavier (the R framework's authored Warden lever).
  const extraWaves = GILDED.sweepWaves[boss.phase] - 1 + boss.enrage;
  if (boss.spinCount < extraWaves && a.time >= (boss.spinCount + 1) * GILDED.sweepWaveGap) {
    gildedSweepWave(w, e, ev);
    boss.spinCount++;
  }
  if (a.time >= extraWaves * GILDED.sweepWaveGap + 0.2) {
    enterRecover(e);
    openBossWindow(e, GILDED.sweepRecover, ev); // the sweep's exposed recover
  }
}

function gildedSlamResolve(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    const d = Math.hypot(p.x - a.markX, p.y - a.markY);
    if (d < GILDED.slamInnerRadius) damagePlayer(w, p, GILDED.slamCenterDamage, ev);
    else if (d < GILDED.slamRadius) damagePlayer(w, p, GILDED.slamOuterDamage, ev);
  }
  // The aftershock: a tight line of shards down the locked bearing.
  for (let i = 0; i < GILDED.slamLineShards; i++) {
    const off = (i - (GILDED.slamLineShards - 1) / 2) * GILDED.slamLineGap;
    spawnEnemyBullet(w, a.markX, a.markY, a.lockedAngle + off, GILDED.slamLineSpeed, GILDED.shardRadius, GILDED.shardDamage, "#ffd166", GILDED.shardLife);
  }
  enemySmashEnvironment(w, a.markX, a.markY, GILDED.slamRadius, ev);
  ev.push({ t: "bossSlam", x: a.markX, y: a.markY });
}

function gildedSweepWave(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const base = (boss.burstParity ^= 1) ? Math.PI / GILDED.sweepCount : 0;
  for (let i = 0; i < GILDED.sweepCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / GILDED.sweepCount) * Math.PI * 2, GILDED.sweepSpeed, GILDED.shardRadius, GILDED.shardDamage, "#ffd166", GILDED.shardLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

// ============================================================================
// WAVE 1 DEEP BOSSES (THE UNMAKING / The Sump, F35–45)
// ============================================================================

// ---- §5g JET (F35): the corrupted MIRROR of the party ----
// Earned window = the Gilded commitment-recover model: JET is GUARDED between salvos; a
// corrupted-Resonance salvo commits, and its SPENT recover is the exposed window. The salvo
// draws from a FROZEN archetype MIRROR pool (never live inventory). 3 phases: P1 uncanny
// (one verb) → P2 out-of-sync canon (a staggered second verb) → P3 inverted + room-drain.

// Resolve JET's mirror pool ONCE from the party's weapon ARCHETYPES (families), seeded-padded
// to a minimum and capped. Reads only each equipped weapon's FAMILY — never its identity or
// stats — so two different weapons of one family produce the same pool (archetype, not inventory).
function resolveJetMirror(w: WorldState): void {
  const present: ResonanceFamily[] = [];
  for (const p of w.players.values()) {
    const fam = weaponResonanceFamily(p.weapon);
    if (present.indexOf(fam) === -1) present.push(fam);
  }
  // Stable family order (determinism) over the party's present families.
  const pool: ResonanceFamily[] = RESONANCE_FAMILIES.filter((f) => present.indexOf(f) !== -1);
  // Seeded pad: if the party is too homogeneous, JET reflects extra authored families from a
  // dedicated stream (pure seed+floor — never touches the shared sim RNG).
  const rng = new Rng((w.seed ^ 0x4a455421) + w.floor * 0x9e3779b1);
  while (pool.length < JET.verbMinSeeded && pool.length < RESONANCE_FAMILIES.length) {
    const rest = RESONANCE_FAMILIES.filter((f) => pool.indexOf(f) === -1);
    pool.push(rest[rng.int(0, rest.length - 1)]);
  }
  w.jetMirror = pool.slice(0, JET.verbMax);
}

// The JET recover length by move — only the mirror salvo's SPENT recover is the exposed
// window; the interleaved pressure moves recover on their own shorter beats.
function jetRecoverFor(move: AttackMove): number {
  return move === "tracer" ? JET.tracerRecover
    : move === "beam" ? JET.beamRecover
    : move === "rush" ? JET.recoilRecover
    : JET.spentRecover; // mirror (the window) + any fallback
}

// The Tithe's surplus TRIBUTE add — an omen-telegraphed ambush (fair: 0.7s tell + grace +
// player clearance) like the Weaver/Marrow pool draws. It crawls to the feeding slab to
// reinforce it (updateTitheTribute), threatening slab-break PROGRESS, not the player.
const TITHE_FEED_ADD: AddPoolEntry = { kind: "tithe_tribute", tier: "swarm", weight: 1, maxAlive: 0, count: 1 };

// JET tracer-snap mote count (balancer FINAL): round((R−1)/1.5) capped — 0 solo / 1 2p /
// 2 3p / 3 4p (a co-op dash-punish; solo JET is mirror-focused, so solo picks a salvo instead).
function jetTracerMotes(w: WorldState): number {
  return Math.min(Math.round((w.encounterPower - 1) / JET.tracerMoteDivR), JET.tracerMoteCap);
}

function updateJet(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  if (w.jetMirror.length === 0) resolveJetMirror(w); // frozen at first tick (the pull loadout)
  // Fair surprise §5g B2: the MIRROR-IMAGE ECHO cadence. On its beat JET spawns ONE telegraphed
  // reflection of a targeted player through the shared fair-ambush omen (0.7s tell + ≥140px
  // clear), capped at jetEchoCap CONCURRENT echoes and gated by the shared add-density
  // controller. Paused during the transition beat (the roar owns that beat). The cadence rides
  // boss.addTimer (JET's only add is the echo), R-scaled like every boss add loop.
  if (!boss.roar && boss.phase >= 1) {
    boss.addTimer -= dt;
    if (boss.addTimer <= 0) {
      boss.addTimer = bossAddIntervalFor(JET.echoInterval[boss.phase], w.encounterPower);
      jetTrySpawnEcho(w, e, ev);
    }
  }
  const a = e.attack;

  if (a.phase === "windup") { jetWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { jetActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= jetRecoverFor(a.move)) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0) { jetBeginAttack(w, e, ev); return; }
  // Between salvos the mirror stalks the party (it moves like you would).
  if (!findTarget(w, e.x, e.y)) return;
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

// JET's rotation: the corrupted MIRROR salvo (A1, the window-opener) fires every other
// commitment; the intervening slots interleave the pressure moves so the fight never
// decays into one spammable salvo — P1 TRACER SNAP (A2), P2 adds the RECOIL LINE (A3) and
// the OVERCLOCK FEINT beam (A4), P3 periodically CORRUPTS (a wide screen beam).
function jetBeginAttack(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0; // verbs emitted this salvo
  const phase = boss.phase;
  // R-framework SURPLUS: the salvo cadence tightens with R (more parry attempts = more
  // windows at high R), floored so it never becomes a machine-gun. Solo (R≈1) is unchanged.
  e.attack.cooldown = Math.max(JET.salvoIntervalFloor, JET.attackCd[phase] - JET.salvoIntervalPerR * (w.encounterPower - 1));
  let move: AttackMove;
  if (boss.attackCount % 2 === 1) {
    move = "mirror"; // the signature salvo (opens the spent-recover window)
  } else if (phase === 1) {
    move = "tracer";
  } else if (phase >= 3 && boss.attackCount % 4 === 0) {
    move = "beam"; // P3 corruption cadence (the wide screen beam)
  } else {
    move = (["tracer", "rush", "beam"] as const)[((boss.attackCount / 2) | 0) % 3];
  }
  // The tracer-snap is a CO-OP dash-punish (0 motes at solo): solo JET fires the mirror
  // salvo instead of a no-op tracer beat, so it never stalls into an empty telegraph.
  if (move === "tracer" && jetTracerMotes(w) <= 0) move = "mirror";
  beginWindup(e, move);
  // Fair surprise §5g B1: the salvo's LEAD mirror family is now a WEIGHTED NON-REPEAT DRAW over
  // the frozen pool (the drawFromAddPool lastAddPick law applied to the verb) — "which of my own
  // guns is turned on you THIS time," never the same school back-to-back. The drawn family rides
  // the wire (mfm) so the client draws the copied weapon's shape + hue; -1 for the pressure moves.
  boss.mirrorFamily = move === "mirror" && w.jetMirror.length > 0
    ? RESONANCE_FAMILIES.indexOf(w.jetMirror[drawMirrorFamily(w, boss)])
    : -1;
  ev.push({ t: "cue", name: move === "mirror" ? "enemyHit" : "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
}

function jetWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    // Phase transition: the amber-motif dead note (King/Gilded fixed-roar semantics).
    a.time += dt;
    a.windup = Math.min(1, a.time / JET.roarDuration);
    if (a.time >= JET.roarDuration) { enterIdle(e); endBossTransition(w, e, ev); }
    return;
  }
  if (a.move === "tracer") {
    // A2 TRACER SNAP: the motes LOCK your position partway through the tell (markX/markY),
    // then hover — dodge LATE, off the mark, before they snap in the active beat.
    if (stepWindupTimer(w, e, dt, JET.tracerWindup, JET.tracerLock, true)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
    }
    return;
  }
  if (a.move === "rush") {
    // A3 RECOIL LINE: JET rears, then recoils along an axis laying the amber wall.
    a.time += dt;
    a.windup = Math.min(1, a.time / JET.recoilWindup);
    if (a.time >= JET.recoilWindup) { a.phase = "active"; a.time = 0; a.windup = 0; jetRecoilWall(w, e, ev); }
    return;
  }
  if (a.move === "beam") {
    // A4 OVERCLOCK FEINT / P3 CORRUPTION: a beam CORRIDOR tell; aim locks partway.
    if (stepWindupTimer(w, e, dt, e.boss!.phase >= 3 ? JET.corruptWindup : JET.beamWindup, JET.beamLock, true)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
    }
    return;
  }
  // The salvo tell: aim locks partway (≥0.30s post-lock dodge). On release, fire the first
  // mirrored verb and enter the brief active beat (the rest stagger in during P2's canon).
  if (stepWindupTimer(w, e, dt, JET.mirrorWindup, JET.mirrorLock, false)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    jetFireVerb(w, e, 0, ev);
    e.boss!.spinCount = 1;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.7, gain: 0.85, trauma: 0.04 });
  }
}

function jetActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  a.time += dt;
  if (a.move === "tracer") {
    // The motes hover for the snap delay (the "dash late" read), then SNAP to the locked
    // mark from converging bearings — a player still on the mark is caught.
    if (a.time >= JET.tracerSnapDelay) {
      const n = jetTracerMotes(w);
      const base = Math.atan2(a.markY - e.y, a.markX - e.x);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 0.14;
        spawnEnemyBullet(w, e.x, e.y, base + off, JET.tracerSnapSpeed, JET.tracerRadius, JET.tracerDamage, "#b39ddb", JET.tracerLife);
      }
      ev.push({ t: "bossVolley", x: e.x, y: e.y });
      ev.push({ t: "cue", name: "dash", x: a.markX, y: a.markY, rate: 0.9, gain: 0.8, trauma: 0.05 });
      enterRecover(e);
    }
    return;
  }
  if (a.move === "rush") {
    enterRecover(e); // the wall was laid on release; the recover is the punish beat
    return;
  }
  if (a.move === "beam") {
    if (a.time >= JET.beamActive) { jetFireBeam(w, e, ev); enterRecover(e); }
    return;
  }
  // R-framework SURPLUS (balancer FINAL): the render-capped base (jetSalvoSize) bounds how
  // many verbs land AT ONCE (1 at 4p); at R ≥ surplusSimulMinR the P2/P3 salvo appends one
  // more verb to the staggered SEQUENCE (faster sequence, same per-beat readability), and a
  // soft-enraged phase appends one INVERTED verb (the "you skipped the lesson" beat). The
  // extras ride the canon stagger, so they never exceed the simultaneous render cap.
  const base = jetSalvoSize(w, boss.phase);
  // R-framework SURPLUS (balancer FINAL): extra sequential verbs = min(bossAddCapFor(0,R), 2)
  // → 0 solo / 2 at 2p+ (simulCapFor still governs how many render per beat). Counted vs the
  // active-threat budget only, never the ≤2-complex-mover rule (these are shard patterns).
  const surplus = Math.min(bossAddCapFor(0, w.encounterPower), JET.surplusVerbCap);
  // Soft-enrage (party skipped a phase): the phase OPENS with one extra MIRROR-FLIPPED verb —
  // the safe pocket on the OPPOSITE side, forcing a re-read. Uses the authored mirror pool
  // (no new entity). Spent after this opening salvo (fires once per enraged phase).
  const enrageVerb = boss.enrage === 1 ? 1 : 0;
  const total = base + surplus + enrageVerb;
  // P2's "out-of-sync canon": the further verbs enter one canonOffset apart, so the salvo
  // reads as a mirror falling out of time with you rather than a single wall.
  while (boss.spinCount < total && a.time >= boss.spinCount * JET.canonOffset) {
    const forceInvert = enrageVerb === 1 && boss.spinCount === total - 1; // the enrage verb is mirror-flipped
    jetFireVerb(w, e, boss.spinCount, ev, forceInvert);
    boss.spinCount++;
  }
  if (a.time >= JET.mirrorActive + (total - 1) * JET.canonOffset) {
    if (boss.enrage === 1) boss.enrage = 0; // the opening mirror-flipped salvo is spent
    enterRecover(e);
    // He is SPENT — the recover is the exposed window (bank-capped like the deep roster).
    openBossWindow(e, JET.spentExpose, ev);
  }
}

// The salvo's simultaneous-verb count: the phase's desire clamped to the 4-player telegraph
// budget (frozen at the pull — trio/quad read fewer at once; the co-op TASK grows via a
// bigger POOL, not a denser salvo).
function jetSalvoSize(w: WorldState, phase: number): number {
  const desire = JET.phaseSimul[phase] ?? 1;
  const cap = jetSimulCapFor(w.encounterPlayers);
  return Math.max(1, Math.min(desire, cap, w.jetMirror.length));
}

// Fair surprise §5g B1: draw WHICH mirrored school leads the next salvo — a weighted, seeded,
// NON-REPEATING pick over the frozen pool (the drawFromAddPool + lastAddPick law, applied to the
// VERB rather than a body). Returns the drawn POSITION into w.jetMirror. Every family is equally
// weighted (the pool is a set); the previous salvo's lead family is excluded whenever another
// school is available, so JET never turns the SAME of your guns on you back-to-back. Rides the
// world RNG exactly like drawFromAddPool, so two identical pulls replay byte-for-byte.
function drawMirrorFamily(w: WorldState, boss: BossState): number {
  const pool = w.jetMirror;
  if (pool.length === 0) return 0;
  const eligible: number[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (pool.length > 1 && RESONANCE_FAMILIES.indexOf(pool[i]) === boss.mirrorLastFamily) continue;
    eligible.push(i);
  }
  const pick = eligible[w.rng.int(0, eligible.length - 1)];
  boss.mirrorLastFamily = RESONANCE_FAMILIES.indexOf(pool[pick]);
  return pick;
}

// Fire the index-th mirrored verb of this salvo. Index 0 is the drawn LEAD school (boss.mirrorFamily,
// the non-repeat pick); the simultaneous verbs fan out from it through the pool, so a salvo's
// multiple lanes stay distinct schools (the copied-gun silhouette stays legible). P3 INVERTS.
function jetFireVerb(w: WorldState, e: Enemy, index: number, ev: SimEvent[], forceInvert = false): void {
  const boss = e.boss!;
  const pool = w.jetMirror;
  if (pool.length === 0) return;
  const lead = boss.mirrorFamily >= 0 ? pool.indexOf(RESONANCE_FAMILIES[boss.mirrorFamily]) : 0;
  const family = pool[((lead >= 0 ? lead : 0) + index) % pool.length];
  const isInverted = boss.phase >= 3 || forceInvert; // the soft-enrage verb inverts even in P2
  let aim = e.attack.lockedAngle;
  if (findTarget(w, e.x, e.y)) aim = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  // The canon offset spreads simultaneous verbs so they read as distinct mirrored lanes.
  aim += (isInverted ? -1 : 1) * index * 0.4;
  jetEmitFamily(w, e, family, aim, isInverted);
  // P3 room-drain: the room's amber "drains" into telegraphed blooms around the party — a
  // walk-dodgeable closing pressure layered on the inverted salvo (the shared charge hazard).
  if (isInverted && index === 0 && findTarget(w, e.x, e.y)) {
    // Add-pressure lever: the 4p surplus routes to MORE walk-dodgeable blooms (never HP).
    const n = bossAddCapFor(JET.drainCount, w.encounterPower);
    for (let i = 0; i < n; i++) {
      const ox = (w.rng.next() * 2 - 1) * JET.drainSpread;
      const oy = (w.rng.next() * 2 - 1) * JET.drainSpread;
      plantAffixCharge(w, w.targetX + ox, w.targetY + oy);
    }
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(aim) * (e.radius + 6), y: e.y + Math.sin(aim) * (e.radius + 6) });
}

// The authored mirrored PATTERN per Resonance family — the archetype tell, not the weapon.
function jetEmitFamily(w: WorldState, e: Enemy, family: ResonanceFamily, aim: number, isInverted: boolean): void {
  // The mirrored shards wear the COPIED weapon's OWN family hue (never JET's cold-indigo band),
  // so a salvo reads as "that's MY gun" and not as one of JET's native attacks.
  const col = RESONANCE_TELEGRAPH_COLOR[family];
  const sign = isInverted ? -1 : 1;
  const shard = (ang: number, speed: number): void =>
    spawnEnemyBullet(w, e.x + Math.cos(ang) * (e.radius + 6), e.y + Math.sin(ang) * (e.radius + 6), ang, speed, JET.globRadius, JET.globDamage, col, JET.globLife);
  switch (family) {
    case "spread": {
      for (let i = 0; i < JET.spreadCount; i++) {
        const off = (i / (JET.spreadCount - 1) - 0.5) * JET.spreadArc;
        shard(aim + sign * off, JET.globSpeed);
      }
      return;
    }
    case "rapid": {
      // A tight fast cluster (the stream mirror), lightly fanned so it reads as many rounds.
      for (let i = 0; i < JET.rapidCount; i++) shard(aim + sign * (i - (JET.rapidCount - 1) / 2) * 0.05, JET.globSpeed * 1.25);
      return;
    }
    case "lance": {
      // A single fast locked line (precision/beam mirror).
      shard(aim, JET.lanceSpeed);
      return;
    }
    case "arc": {
      // A full ring (the bounce/chain/seek mirror): the pattern that ignores your cover.
      const base = isInverted ? Math.PI / JET.arcCount : 0;
      for (let i = 0; i < JET.arcCount; i++) shard(base + (i / JET.arcCount) * Math.PI * 2, JET.globSpeed * 0.9);
      return;
    }
    case "lob": {
      // A marked bloom at your feet (the AoE lob mirror): a telegraphed walk-off charge.
      if (findTarget(w, e.x, e.y)) plantAffixCharge(w, w.targetX, w.targetY);
      return;
    }
    case "melee": {
      // A close forward slash of shards (the melee mirror) — read the lunge, step off the arc.
      for (let i = 0; i < 3; i++) shard(aim + sign * (i - 1) * 0.22, JET.globSpeed * 1.1);
      return;
    }
  }
}

// A3 RECOIL LINE: JET recoils along an axis, laying an amber WALL of walk-dodgeable charge
// blooms that bisects the arena; alternating axes make the SECOND recoil lay a cross. The
// wall covers space (you reposition through its gaps), the recover is the punish beat.
function jetRecoilWall(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const isVertical = (boss.burstParity ^= 1) === 1;
  // The wall runs through the arena centre on the chosen axis; JET recoils to one end.
  const cx = e.x, cy = e.y;
  const half = JET.recoilWallSpan;
  for (let d = -half; d <= half; d += JET.recoilWallStep) {
    if (isVertical) plantAffixCharge(w, cx, cy + d);
    else plantAffixCharge(w, cx + d, cy);
  }
  // The recoil dash itself (JET slides to the far side of its own wall).
  const away = isVertical ? (e.x < 840 ? 0 : Math.PI) : (e.y < 600 ? Math.PI / 2 : -Math.PI / 2);
  moveEnemyBy(w, e, Math.cos(away) * JET.recoilDashSpeed * JET.recoilDashDur, Math.sin(away) * JET.recoilDashSpeed * JET.recoilDashDur);
  ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.7, gain: 0.85, trauma: 0.05 });
}

// A4 OVERCLOCK FEINT (P2) / P3 CORRUPTION: a beam CORRIDOR of fast shards down the locked
// aim. The feint (30%, seeded) fires the corridor OFFSET to one side, punishing a dash into
// the telegraphed "safe" gap; P3's corruption is wider with an authored central gap to
// dodge THROUGH. Covers a whole lane — never a lone strafable shot.
function jetFireBeam(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const isCorrupt = boss.phase >= 3;
  let aim = e.attack.lockedAngle;
  // The feint: shift the corridor to the side by a fixed offset (seeded, deterministic).
  if (!isCorrupt && w.rng.next() < JET.beamFeintChance) aim += (boss.burstParity ^= 1) === 1 ? JET.beamFeintOffset : -JET.beamFeintOffset;
  const half = isCorrupt ? JET.corruptHalfWidth : JET.beamHalfWidth;
  const count = isCorrupt ? JET.corruptShards : JET.beamShards;
  const speed = isCorrupt ? JET.corruptSpeed : JET.beamSpeed;
  const nx = Math.cos(aim + Math.PI / 2), ny = Math.sin(aim + Math.PI / 2); // perpendicular offset
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) - 0.5 : 0; // -0.5..0.5 across the corridor width
    // P3 corruption leaves an authored central gap to dodge THROUGH (the counter route).
    if (isCorrupt && Math.abs(t) < JET.corruptGap / 2) continue;
    const ox = nx * t * half * 2, oy = ny * t * half * 2;
    spawnEnemyBullet(w, e.x + ox, e.y + oy, aim, speed, JET.globRadius, JET.globDamage, isCorrupt ? "#d84a8a" : "#8a7bd8", JET.globLife);
  }
  ev.push({ t: "bossVolley", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isCorrupt ? 0.4 : 0.55, gain: 0.85, trauma: 0.06 });
}

// ---- §5g B2: the MIRROR-IMAGE ECHO (JET's marquee surprise element) ----

// Concurrent-echo cap: ONE at a time (the deliberate default). The optional P3 "two sequential"
// flourish is DROPPED — one reflection keeps the worst-case 4p read from ever becoming a soup of
// echoes / a multi-Jet fight (the fairness guardrail wins over the flourish).
function jetEchoCap(_w: WorldState): number {
  return JET.echoCap;
}

// The nearest live, targetable player to a point (deterministic: players iterate in insertion
// order). The echo MIRRORS this player — the reflection's identity for the co-op read.
function jetNearestPlayer(w: WorldState, x: number, y: number): PlayerSim | null {
  let best: PlayerSim | null = null;
  let bestD = Infinity;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Queue ONE mirror-image echo through the shared fair-ambush omen path (0.7s tell + ≥140px
// clear), if the concurrent-echo cap AND the shared add-density budget both allow. The tell
// stands off a targeted player; the resolved body mirrors whoever it lands nearest (resolveOmen).
function jetTrySpawnEcho(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const cap = jetEchoCap(w);
  // Concurrent echoes = live bodies + pending omens (an announced echo holds a slot the moment
  // its tell stands, so the cadence never over-plants while one is still arriving).
  const live = countLiveAddsOfKind(w, "jet_echo") + countPendingOmensOfKind(w, "jet_echo", "standard");
  if (live >= cap) return;
  // Route through the density controller like any add (bossAddCapFor over the shared budget).
  if (countBossAdds(w) + countPendingOmens(w) >= bossAddCapFor(cap, w.encounterPower)) return;
  const target = jetNearestPlayer(w, e.x, e.y);
  if (!target) return;
  const base = w.rng.next() * Math.PI * 2;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ang = base + attempt * 2.399963;
    const x = target.x + Math.cos(ang) * JET.echoRingDist;
    const y = target.y + Math.sin(ang) * JET.echoRingDist;
    if (queueAmbush(w, x, y, "jet_echo", "standard", e.id + 1, ev)) break;
  }
}

// A resolved mirror-image echo: it holds its pose through spawn grace, telegraphs its ONE
// mirrored-school salvo on its own readable windup, fires it, then DISSOLVES into resin flecks.
// FRAGILE + BRIEF — never a second durable JET. aux carries remaining life (the client fade).
function updateJetEcho(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (e.spawnTimer > 0) return; // fair-ambush spawn grace on top of the omen tell
  const a = e.attack;
  if (e.aux > 0) e.aux = Math.max(0, e.aux - dt); // remaining-life readout (drives the client fade)
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, JET.echoWindup, JET.echoLock, false)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      // ONE mirrored-school salvo (the school frozen on `seq` at resolve), fired from the
      // reflection's body at the locked bearing — "dodge your own reflected aggression."
      const fam = RESONANCE_FAMILIES[e.seq] ?? w.jetMirror[0];
      jetEmitFamily(w, e, fam, a.lockedAngle, false);
      ev.push({ t: "bossVolley", x: e.x, y: e.y });
      ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.6, gain: 0.75, trauma: 0.03 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    if (a.time >= JET.echoActive) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= JET.echoDissolve) {
      e.dead = true; // self-dissolve into resin flecks (a reflection, never a kill/loot)
      ev.push({ t: "puff", x: e.x, y: e.y, n: 8, color: ENEMY_ARCHETYPES.jet_echo.tint });
    }
    return;
  }
  // Orphaned: the omen resolved AFTER the mirror that cast it died, so its windup was never
  // seeded — a reflection with no source simply dissolves (never a lingering inert body).
  e.dead = true;
  ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES.jet_echo.tint });
}

// ---- §5g B3: the PER-PHASE ARENA-CORRUPTION RESHAPE ("The Light Goes Out") ----

// The room JET is fighting in (its perimeter is what corrupts inward). The boss arena is the
// last room on a boss floor; otherwise (sandbox/dev) the room whose tile-rect holds the boss.
function jetArenaRoom(w: WorldState, e: Enemy): Room | null {
  const d = w.dungeon;
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  for (const room of d.rooms) {
    if (tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h) return room;
  }
  return d.rooms.length > 0 ? d.rooms[d.rooms.length - 1] : null;
}

// JET's arena reshape (fair surprise §5g B3): mirrors the weaver/gilded/choir reshape STRUCTURE
// (crumble the old, raise the fresh) but the material is CORRUPTION, not pillars — JET's own cold
// black-resin drain (the plantAffixCharge env-drain, made persistent + escalating). The previous
// phase's corruption crumbles and a fresh, DENSER band creeps in from the room EDGES (inset tiles
// deep, growing each phase), so the safe space SHRINKS INWARD as JET wins — never a ring/circle,
// never violet. An authored corridor gap on one seeded edge + the always-open interior guarantee
// ≥1 readable safe route; a patch never lands on/beside a standing player. It fires ON the ≤1.2s
// transition beat and NEVER touches guard/exposed — the window stays earned by the mirror salvo.
function jetReshape(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const exposedBefore = boss.exposed; // the reshape must NEVER open/extend a window (asserted below)
  // Crumble the previous phase's corruption: the room re-corrupts fresh + denser each transition,
  // never accumulates (the choir/weaver "crumble old, raise fresh" law).
  for (const h of w.hazards) if (h.kind === "corrupt") h.life = 0;
  w.hazards = w.hazards.filter((h) => h.life > 0);
  const room = jetArenaRoom(w, e);
  const wantInset = JET.corruptInsetTiles[boss.phase] ?? 0;
  if (room && wantInset > 0) {
    // Clamp the band so a corruption-free INTERIOR (the safe pocket) always survives.
    const inset = Math.min(wantInset, Math.floor(Math.min(room.w, room.h) / 2) - 2);
    if (inset > 0) {
      // The authored safe-corridor gap: one seeded edge carries a corruptGapTiles-wide opening,
      // a readable break in the corruption wall (on top of the always-open interior).
      const gapSide = w.rng.int(0, 3); // 0 top / 1 bottom / 2 left / 3 right
      const gapHalf = JET.corruptGapTiles / 2;
      const step = JET.corruptStepTiles; // coarse grid: a bounded patch count, never per-tile
      for (let ty = room.y; ty < room.y + room.h; ty += step) {
        for (let tx = room.x; tx < room.x + room.w; tx += step) {
          const dl = tx - room.x, dr = room.x + room.w - 1 - tx;
          const dtp = ty - room.y, db = room.y + room.h - 1 - ty;
          const edge = Math.min(dl, dr, dtp, db);
          if (edge >= inset) continue; // interior tile: stays clear (the safe pocket)
          // Skip the authored corridor gap on the seeded edge (a readable way out).
          if (gapSide === 0 && dtp < inset && Math.abs(tx - room.cx) <= gapHalf) continue;
          if (gapSide === 1 && db < inset && Math.abs(tx - room.cx) <= gapHalf) continue;
          if (gapSide === 2 && dl < inset && Math.abs(ty - room.cy) <= gapHalf) continue;
          if (gapSide === 3 && dr < inset && Math.abs(ty - room.cy) <= gapHalf) continue;
          const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
          if (isWall(w, x, y)) continue;
          if (isNearAnyPlayer(w, x, y, AMBUSH.playerClear)) continue; // never corrupt a player's ground
          w.hazards.push({
            id: w.nextHazardId++, kind: "corrupt", x, y,
            radius: JET.corruptRadius, life: JET.corruptLife, maxLife: JET.corruptLife,
          });
        }
      }
    }
  }
  ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES.jet.tint });
  boss.exposed = exposedBefore; // hard invariant: the corruption reshape opens no window (like choirReshape)
}

// ---- §5h THE TITHE (F40): the armored FEEDER + its destructible feeding slab ----
// GUARDED while armored; it BUILDS a slab and RE-ARMORS behind it. Destroy the slab before
// the re-armor channel closes → the feeder is EXPOSED. Miss it → re-armored (no window) but it
// ALWAYS feeds again (never dead-ends). Co-op = more/thicker slabs (task), never a shorter channel.

function updateTithe(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { titheWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { titheActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= titheRecoverFor(a.move)) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0) { titheBeginAttack(w, e, ev); return; }
  // The heavy feeder lumbers toward the party between commitments.
  if (!findTarget(w, e.x, e.y)) return;
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function titheRecoverFor(move: AttackMove): number {
  return move === "slam" ? TITHE.slamRecover
    : move === "spew" ? TITHE.spewRecover
    : move === "hurl" ? TITHE.hurlRecover
    : TITHE.radialRecover; // radial / build / rip-wheel fallback
}

// The Tithe's rotation: the FEED loop (build → slab → break-window) stays the primary
// window mechanic (odd commitments when slabless & unexposed); the even commitments
// interleave the space-covering pressure — P1 GORGE SLAM (A1), P2 adds the two-stage SPEW
// (A3), the SLAB HURL (A4) and the heavy ring. P3 opens with the SIGNATURE barrage wheel.
function titheBeginAttack(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0;
  const phase = boss.phase;
  e.attack.cooldown = TITHE.attackCd[phase];
  const isSlabless = countLiveIds(w, boss.windowAddIds) === 0 && boss.windowAddIds.length === 0;
  // SIGNATURE: once per P3, rip the plating into the rotating barrage wheel. Gated on
  // isNextRadial (set true by every checkBossTransition, unused otherwise by the Tithe) so it
  // fires once on entering P3 — leaving isSurpriseSpent for the shared R-surplus surprise wave.
  if (phase >= 3 && boss.isNextRadial && boss.exposed <= 0 && isSlabless) {
    boss.isNextRadial = false;
    beginWindup(e, "rip");
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.5, gain: 0.85, trauma: 0.1 });
    return;
  }
  // Feed (the window) on odd commitments when slabless & unexposed.
  if (boss.exposed <= 0 && isSlabless && boss.attackCount % 2 === 1) {
    beginWindup(e, "build");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
    return;
  }
  // Pressure otherwise.
  const move: AttackMove = phase >= 2
    ? (["slam", "spew", "hurl", "radial"] as const)[((boss.attackCount / 2) | 0) % 4]
    : "slam";
  beginWindup(e, move);
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.55, gain: 0.7, trauma: 0 });
}

function titheWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    a.time += dt;
    a.windup = Math.min(1, a.time / TITHE.roarDuration);
    if (a.time >= TITHE.roarDuration) { enterIdle(e); endBossTransition(w, e, ev); }
    return;
  }
  if (a.move === "build") {
    // The amber-ooze-rising tell, then the slab(s) rise and the re-armor channel begins.
    a.time += dt;
    a.windup = Math.min(1, a.time / TITHE.buildWindup);
    if (a.time >= TITHE.buildWindup) {
      titheRaiseSlabs(w, e, ev);
      a.phase = "active"; a.time = 0; a.windup = 0;
    }
    return;
  }
  if (a.move === "hurl") {
    // A4 SLAB HURL: aim locks partway; the throw fires on release and its recover opens a
    // short exposed window (the feeder commits its plating and leaves its side open).
    if (stepWindupTimer(w, e, dt, TITHE.hurlWindup, TITHE.hurlLock, false)) {
      titheHurl(w, e, ev);
      enterRecover(e);
      openBossWindow(e, TITHE.hurlExpose, ev);
    }
    return;
  }
  // slam (gorge) / spew / spin (signature wheel): a fixed rear tell, then the active beat.
  const windupT = a.move === "slam" ? TITHE.slamWindup : a.move === "spew" ? TITHE.spewWindup
    : a.move === "rip" ? TITHE.wheelWindup : TITHE.radialWindup;
  a.time += dt;
  a.windup = Math.min(1, a.time / windupT);
  if (a.time >= windupT) {
    if (a.move === "radial") {
      titheRing(w, e, 0);
      if (e.boss!.enrage === 1) titheRing(w, e, Math.PI / TITHE.radialCount);
      enterRecover(e);
    } else {
      a.phase = "active"; a.time = 0; a.windup = 0;
    }
  }
}

// The multi-beat active phase (gorge pulses, two-stage spew, the barrage wheel).
function titheActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  if (a.move === "build") { titheFeedChannel(w, e, dt, ev); return; }
  a.time += dt;
  if (a.move === "slam") {
    // A1 GORGE SLAM: a 360° ring + debris blooms; P2+ DOUBLE-pulses (read both rings).
    const pulses = boss.phase >= 2 ? 2 : 1;
    while (boss.spinCount < pulses && a.time >= boss.spinCount * TITHE.gorgePulseGap) {
      titheGorge(w, e, boss.spinCount, ev);
      boss.spinCount++;
    }
    if (boss.spinCount >= pulses) enterRecover(e);
    return;
  }
  if (a.move === "spew") {
    // A3 SPEW ARC: wave 1 pools, then wave 2 fills wave 1's GAPS (offset half a step).
    while (boss.spinCount < 2 && a.time >= boss.spinCount * TITHE.spewStageGap) {
      titheSpew(w, e, boss.spinCount);
      boss.spinCount++;
    }
    if (boss.spinCount >= 2 && a.time >= TITHE.spewStageGap + 0.1) enterRecover(e);
    return;
  }
  if (a.move === "rip") {
    // SIGNATURE: a slow rotating barrage wheel, then it COLLAPSES into a long exposed window.
    while (a.time >= boss.spinCount * TITHE.wheelInterval && a.time <= TITHE.wheelDuration) {
      const ang = boss.spinCount * TITHE.wheelStep;
      spawnEnemyBullet(w, e.x, e.y, ang, TITHE.wheelSpeed, TITHE.globRadius, TITHE.globDamage, "#ffb43b", TITHE.globLife);
      spawnEnemyBullet(w, e.x, e.y, ang + Math.PI, TITHE.wheelSpeed, TITHE.globRadius, TITHE.globDamage, "#ffb43b", TITHE.globLife);
      boss.spinCount++;
    }
    if (a.time >= TITHE.wheelDuration) {
      enterRecover(e);
      openBossWindow(e, TITHE.collapseExpose, ev); // the memorable P3 collapse window
    }
    return;
  }
  enterRecover(e);
}

// A1 GORGE SLAM pulse: a full ring shockwave + debris blooms ringing the shadow (dash the
// ring on i-frames, or stand in a debris-shadow gap). Pulse index offsets the ring so a
// double-pulse reads as two distinct walls.
function titheGorge(w: WorldState, e: Enemy, pulse: number, ev: SimEvent[]): void {
  const base = pulse * (Math.PI / TITHE.gorgeRingCount);
  for (let i = 0; i < TITHE.gorgeRingCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / TITHE.gorgeRingCount) * Math.PI * 2, TITHE.gorgeSpeed, TITHE.globRadius, TITHE.globDamage, "#ffcf6b", TITHE.globLife);
  }
  // Debris blooms in the ring's shadow (area-deny), scaled by the 4p surplus.
  const debris = bossAddCapFor(TITHE.gorgeDebris, w.encounterPower);
  for (let i = 0; i < debris; i++) {
    const ang = base + (i / debris) * Math.PI * 2 + 0.3;
    plantAffixCharge(w, e.x + Math.cos(ang) * TITHE.gorgeDebrisDist, e.y + Math.sin(ang) * TITHE.gorgeDebrisDist);
  }
  ev.push({ t: "bossSlam", x: e.x, y: e.y });
}

// A3 SPEW ARC: a ring of arcing pools (charge blooms) around the party; stage 1 lays the
// pools, stage 2 fills the GAPS (offset half a step) — read both, not one.
function titheSpew(w: WorldState, e: Enemy, stage: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const n = TITHE.spewCount;
  const offset = stage === 1 ? Math.PI / n : 0; // wave 2 fills wave 1's gaps
  for (let i = 0; i < n; i++) {
    const ang = offset + (i / n) * Math.PI * 2;
    plantAffixCharge(w, w.targetX + Math.cos(ang) * TITHE.spewRing, w.targetY + Math.sin(ang) * TITHE.spewRing);
  }
}

// A4 SLAB HURL: a heavy line projectile thrown at the locked bearing — a slab-sized round
// that covers a lane (dodge the line, then punish the unarmored recover window).
function titheHurl(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  let aim = e.attack.lockedAngle;
  if (findTarget(w, e.x, e.y)) aim = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  spawnEnemyBullet(w, e.x + Math.cos(aim) * (e.radius + 8), e.y + Math.sin(aim) * (e.radius + 8), aim, TITHE.hurlSpeed, TITHE.hurlRadius, TITHE.hurlDamage, "#c98b5a", TITHE.hurlLife);
  ev.push({ t: "bossVolley", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.85, trauma: 0.08 });
}

// TRIBUTE (surplus add): a slow amber crawler that shuffles toward the nearest feeding SLAB
// and, once adjacent, REPAIRS it at a steady 6 HP/s (undoing the party's slab-break) for as
// long as it lives — it threatens slab-break PROGRESS, not the player (touchDamage 0). At 4p
// the party must divide labor: INTERCEPT (kill) tributes while others break the slab; ignore
// them and the repair outpaces the break. If no slab stands it just mills (harmless).
function updateTitheTribute(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (e.spawnTimer > 0) return; // spawn grace: the omen already stood as the tell
  // RING SUPPRESSION (explicit — the arbiter doesn't gate a repair actor against the ring):
  // while a GORGE SLAM ring telegraphs/is live, only the first tributeActiveCapDuringRing
  // tributes (by id) ACT; the overflow holds so the ring dodge stays readable, then re-activates
  // staggered (echoTime = overflow-index × stagger, counted down once the ring clears).
  // The ring is "live" for the whole gorge commitment — the windup tell, the active fire, and
  // the recover while the shockwave travels (move stays "slam" until the feeder idles). Keying
  // off the move (not the phase) covers all three, since the phase resolves within the tick.
  const feeder = w.enemies.find((o) => !o.dead && o.kind === "tithe" && o.boss !== null);
  const ringLive = feeder !== undefined && feeder.attack.move === "slam";
  if (ringLive) {
    let rank = 0;
    for (const o of w.enemies) if (!o.dead && o.kind === "tithe_tribute" && o.id < e.id) rank++;
    if (rank >= TITHE.tributeActiveCapDuringRing) {
      e.echoTime = (rank - TITHE.tributeActiveCapDuringRing) * TITHE.tributeReactivateStagger;
      return; // held for the ring; echoTime is its post-ring staggered release delay
    }
  }
  if (e.echoTime > 0) { e.echoTime = e.echoTime > dt ? e.echoTime - dt : 0; return; } // staggered re-activation
  let slab: Enemy | null = null;
  let bestD = Infinity;
  for (const o of w.enemies) {
    if (o.dead || o.kind !== "tithe_slab") continue;
    const d = Math.hypot(o.x - e.x, o.y - e.y);
    if (d < bestD) { bestD = d; slab = o; }
  }
  if (!slab) { // nothing to repair — drift with the party, harmless
    if (findTarget(w, e.x, e.y)) applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
    return;
  }
  if (bestD <= e.radius + slab.radius + 2) {
    // Parked at the slab: repair it (heal toward its max) at the steady rate while alive.
    if (slab.hp < slab.maxHp) {
      slab.hp = Math.min(slab.maxHp, slab.hp + TITHE.tributeRepairPerSec * dt);
      ev.push({ t: "cue", name: "enemyHit", x: slab.x, y: slab.y, rate: 0.6, gain: 0.4, trauma: 0 });
    }
    return;
  }
  applyChaseStep(w, e, dt, Math.atan2(slab.y - e.y, slab.x - e.x), e.speed * dt);
}

// The feed channel's chaser adds (balancer FINAL): a per-P cap (solo 0 / 2p 3 / 4p 4) of
// simple chasers, omen-telegraphed like the Weaver/Marrow pool draws, the live count held at
// the cap (which stays under the room's active-threat budget). Solo raises none.
function titheFeedAdds(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const cap = Math.min(bossAddCapFor(0, w.encounterPower), TITHE.feedAddCap); // 0 solo / 3 2p / 4 3p+ (R-keyed)
  let live = countLiveAddsOfKind(w, TITHE_FEED_ADD.kind) + countPendingOmensOfKind(w, TITHE_FEED_ADD.kind, TITHE_FEED_ADD.tier);
  for (let i = 0; i < cap && live < cap; i++) {
    if (queueAmbushWave(w, e, TITHE.slabRingDist + 44, TITHE_FEED_ADD, e.id, ev) > 0) live++;
  }
}

// The re-armor channel: break every slab before it elapses to EXPOSE the feeder. Miss it and
// it re-armors (crumble the survivors, no window) — but the loop simply feeds again.
function titheFeedChannel(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  a.time += dt;
  a.windup = Math.min(1, a.time / TITHE.rearmChannel);
  if (countLiveIds(w, boss.windowAddIds) === 0) {
    // Every slab broken in time — the feeder is caught exposed.
    boss.windowAddIds.length = 0;
    enterRecover(e);
    openBossWindow(e, TITHE.slabExpose, ev);
    return;
  }
  if (a.time >= TITHE.rearmChannel) {
    // Re-armored: the surviving slab(s) are absorbed back into the plating (no window).
    for (const id of boss.windowAddIds) {
      const slab = w.enemies.find((o) => !o.dead && o.id === id);
      if (slab) { slab.dead = true; ev.push({ t: "puff", x: slab.x, y: slab.y, n: 4, color: ENEMY_ARCHETYPES.tithe_slab.tint }); }
    }
    boss.windowAddIds.length = 0;
    enterRecover(e);
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.7, gain: 0.7, trauma: 0.05 });
  }
}

// Raise the feeding slab(s) between the feeder and the party — offset off the direct axis so
// a line-of-sight lane to the feeder ALWAYS stays open. Co-op raises more/thicker slabs.
function titheRaiseSlabs(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.windowAddIds.length = 0;
  let toward = 0;
  if (findTarget(w, e.x, e.y)) toward = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  // Soft-enrage (a burned phase): this feed raises one EXTRA slab (never HP, never a shorter
  // channel) — the "you skipped the lesson" beat, keyed off the phaseTimerFor yardstick.
  const n = (TITHE.slabsFor[w.encounterPlayers] ?? 1) + (boss.enrage === 1 ? 1 : 0);
  const slabHp = titheSlabHpForFloor(w.floor, w.encounterPlayers);
  // R-framework SURPLUS: the feed also spawns simple chaser adds (per-P cap, active-threat
  // gated) — the 4p feed-add pressure. rearmChannel stays FLAT; the task scales, not the timer.
  titheFeedAdds(w, e, ev);
  for (let i = 0; i < n; i++) {
    // Fan the slabs to one side of the axis (offset), never straddling it — the lane stays.
    const ang = toward + (i - (n - 1) / 2) * (TITHE.slabOffset * 1.2) + TITHE.slabOffset;
    const x = e.x + Math.cos(ang) * TITHE.slabRingDist;
    const y = e.y + Math.sin(ang) * TITHE.slabRingDist;
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.tithe_slab.radius)) continue;
    const slab = createEnemy("tithe_slab", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    slab.hp = slabHp; slab.maxHp = slabHp;
    slab.spawnTimer = 0;
    w.enemies.push(slab);
    boss.windowAddIds.push(slab.id);
    ev.push({ t: "enemySpawn", eid: slab.id, kind: slab.kind, tier: slab.tier, x: slab.x, y: slab.y });
  }
}

function titheRing(w: WorldState, e: Enemy, base: number): void {
  for (let i = 0; i < TITHE.radialCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / TITHE.radialCount) * Math.PI * 2, TITHE.globSpeed, TITHE.globRadius, TITHE.globDamage, "#ffb43b", TITHE.globLife);
  }
}

// ---- §5i QUORUM (F45): three husks, ONE shared pool + ONE telegraph, then the merge ----
// The CORE carries the shared pool + the shared telegraph and is untargetable behind its
// husks (phase 1). Roles gate kill-order: SHIELD guards the pool, HEAL regenerates it, DMG
// attacks. Break a husk (focus its integrity) to end its role. At the merge threshold a
// telegraphed 1.2s NON-invuln merge fuses them into the merge-form (phase 2) with its own window.

const QUORUM_HUSK_KINDS: readonly Enemy["kind"][] = ["quorum_shield", "quorum_heal", "quorum_dmg"];

// Kill-order priority (shield first): the highest-priority LIVING husk is the only one that
// takes FULL pool damage; the rest are chipped (so 4P even-nuke stalls).
function quorumPriorityHusk(w: WorldState, core: Enemy): Enemy | null {
  for (const kind of QUORUM_HUSK_KINDS) {
    const h = w.enemies.find((o) => !o.dead && o.kind === kind && o.seq === core.id + 1);
    if (h) return h;
  }
  return null;
}

function quorumCoreOf(w: WorldState, husk: Enemy): Enemy | null {
  return w.enemies.find((o) => !o.dead && o.kind === "quorum" && o.id === husk.seq - 1) ?? null;
}

function updateQuorum(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;
  if (boss.addTimer > 0) boss.addTimer -= dt; // the husk-add wave interval (surplus lever)

  // Prune dead husks from the shared roster (a broken husk stays broken WITHIN a wave; the
  // whole trio RE-FORMS after it is cleared — the P1 loop, below).
  for (let k = boss.windowAddIds.length - 1; k >= 0; k--) {
    const id = boss.windowAddIds[k];
    if (!w.enemies.some((o) => !o.dead && o.id === id)) boss.windowAddIds.splice(k, 1);
  }
  // P1 HUSK LOOP (design owner): three-husk/tether-up -> husks die by priority -> all-dead/pool-
  // EXPOSED -> RE-FORM -> repeat, until the merge at 45%. The tether-SNAP fires when the trio is
  // cleared (the pool opens); the tether-REFORM fires when the fresh trio raises (in
  // quorumSpawnHusks). Both are LIGHT repeatable accents — the merge is the sole big screen-punch.
  if (boss.phase < 2 && a.move !== "merge" && !boss.roar) {
    const anyHuskAlive = boss.windowAddIds.length > 0;
    if (!boss.huskRaised) {
      if (e.spawnTimer === 0) { quorumSpawnHusks(w, e, ev); boss.huskRaised = true; boss.huskGuardUp = true; }
    } else if (anyHuskAlive) {
      boss.huskGuardUp = true;
      boss.huskReformTimer = 0;
    } else if (boss.huskGuardUp) {
      // The trio was JUST cleared — the pool OPENS: a light one-beat tether-SNAP + the exposed
      // window begins (the core is now targetable + takes full damage for huskReformDelay).
      boss.huskGuardUp = false;
      boss.huskReformTimer = QUORUM.huskReformDelay;
      ev.push({ t: "puff", x: e.x, y: e.y, n: 8, color: "#bfeef0" });
      ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.6, gain: 0.75, trauma: 0.07 });
    } else {
      // Exposed window ticking down; RE-FORM the trio (re-gate) when it elapses.
      boss.huskReformTimer -= dt;
      if (boss.huskReformTimer <= 0 && e.spawnTimer === 0) { quorumSpawnHusks(w, e, ev); boss.huskGuardUp = true; }
    }
  }

  // The husks share the pool: mirror the core HP onto every live husk (the bar + tether read
  // the ONE pool), and the HEAL husk regenerates the pool while it lives (undo lazy chip).
  const liveHusks: Enemy[] = [];
  let isHealAlive = false;
  for (const id of boss.windowAddIds) {
    const h = w.enemies.find((o) => !o.dead && o.id === id);
    if (!h) continue;
    liveHusks.push(h);
    if (h.kind === "quorum_heal") isHealAlive = true;
  }
  if (boss.phase < 2 && isHealAlive && !boss.roar && e.hp < e.maxHp) {
    e.hp = Math.min(e.maxHp, e.hp + QUORUM.healRegenPerSec * dt);
  }
  for (const h of liveHusks) { h.hp = e.hp; h.maxHp = e.maxHp; }

  if (a.phase === "windup") { quorumWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { quorumActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= quorumRecoverFor(a.move, boss.phase)) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0) { quorumBeginAttack(w, e, ev); return; }
  // The core drifts toward the party (slow) so the orbiting husk-triangle follows the fight
  // rather than sitting still; its husks hold their formation slots around it (updateQuorumHusk).
  if (findTarget(w, e.x, e.y)) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

// Each husk holds an assigned FORMATION SLOT around the core — a readable triangle 120°
// apart that slowly orbits (with a little per-husk sway). The husk steers toward ITS slot,
// NOT the player, so the three never free-chase the same target and collapse into one
// overlapping blob (which looked odd and broke the kill-order read). The tether from the
// core to each husk stays taut and the trio stays visually distinct and targetable.
function updateQuorumHusk(w: WorldState, e: Enemy, dt: number): void {
  const core = quorumCoreOf(w, e);
  if (!core) return;
  const i = QUORUM_HUSK_KINDS.indexOf(e.kind);
  if (i < 0) return;
  const orbit = w.tick * QUORUM.huskOrbitStep;
  const slotAngle = orbit + i * ((2 * Math.PI) / QUORUM_HUSK_KINDS.length)
    + Math.sin(w.tick * QUORUM.huskSwayStep + i * 2.1) * QUORUM.huskSway;
  const sx = core.x + Math.cos(slotAngle) * QUORUM.huskRingDist;
  const sy = core.y + Math.sin(slotAngle) * QUORUM.huskRingDist;
  const d = Math.hypot(sx - e.x, sy - e.y);
  if (d > 1) applyChaseStep(w, e, dt, Math.atan2(sy - e.y, sx - e.x), Math.min(d, e.speed * dt));
}

function quorumSpawnHusks(w: WorldState, core: Enemy, ev: SimEvent[]): void {
  const boss = core.boss!;
  const integrity = Math.max(1, Math.round(QUORUM.huskIntegrityFrac * core.maxHp));
  for (let i = 0; i < QUORUM_HUSK_KINDS.length; i++) {
    const ang = (i / QUORUM_HUSK_KINDS.length) * Math.PI * 2;
    const x = core.x + Math.cos(ang) * QUORUM.huskRingDist;
    const y = core.y + Math.sin(ang) * QUORUM.huskRingDist;
    const px = settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES[QUORUM_HUSK_KINDS[i]].radius) ? { x: settlePoint.x, y: settlePoint.y } : { x: core.x, y: core.y };
    const husk = createEnemy(QUORUM_HUSK_KINDS[i], px.x, px.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    husk.seq = core.id + 1;          // the husk belongs to its core (shared pool linkage)
    husk.hp = core.hp; husk.maxHp = core.maxHp;
    husk.affixState = integrity;     // the break meter (focus it to end its role)
    husk.aux = 1;                    // integrity fraction (drives the tether/focus render)
    husk.spawnTimer = 0;
    w.enemies.push(husk);
    boss.windowAddIds.push(husk.id);
    ev.push({ t: "enemySpawn", eid: husk.id, kind: husk.kind, tier: husk.tier, x: husk.x, y: husk.y });
  }
  // The tether-REFORM beat (the inverse of the SNAP): the severed shared body REKNITS itself —
  // relentless/menacing, NOT a triumphant "reset" (the pool HP persists across cycles, so the
  // low bar is the honest progress read). A LIGHT quiet cue only; the inward-pulling reknit
  // visual is client-drawn (renderQuorumTether), kept dim + subordinate to the HP bar. The
  // merge stays the sole big screen-punch.
  ev.push({ t: "cue", name: "enemyAttack", x: core.x, y: core.y, rate: 0.55, gain: 0.55, trauma: 0.03 });
}

function quorumRecoverFor(move: AttackMove, phase: number): number {
  if (phase >= 2) return QUORUM.mergeRecover; // every merge-form commitment is the window
  return move === "beam" ? QUORUM.crossRecover
    : move === "sweep" ? QUORUM.snapRecover
    : move === "volley" ? QUORUM.roleRecover
    : QUORUM.volleyRecover; // radial
}

// The husk which alive-checks the shield tether (A2 TETHER SNAP is gone once it dies).
function quorumShieldAlive(w: WorldState, core: Enemy): boolean {
  return w.enemies.some((o) => !o.dead && o.kind === "quorum_shield" && o.seq === core.id + 1);
}

// QUORUM's rotation. Husk phase: the 3-husk geometry — CROSSFIRE (A1), ROLE VOLLEY (A3),
// TETHER SNAP (A2, while the shield husk lives), and the converging ring. Merge-form: the
// amalgam runs the CROSSFIRE→TETHER-SNAP combo plus the wide ring, each opening its window.
function quorumBeginAttack(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0;
  e.attack.cooldown = QUORUM.attackCd[boss.phase] ?? QUORUM.attackCd[QUORUM.attackCd.length - 1];
  let move: AttackMove;
  if (boss.phase >= 2) {
    move = (["beam", "sweep", "radial"] as const)[boss.attackCount % 3]; // the merge combo
  } else {
    const opts: readonly AttackMove[] = quorumShieldAlive(w, e)
      ? (["beam", "volley", "sweep", "radial"] as const)
      : (["beam", "volley", "radial"] as const);
    move = opts[boss.attackCount % opts.length];
  }
  beginWindup(e, move);
  // The shared telegraph reads on the "next to act" husk (the lead) — the tether leans to it.
  const lead = quorumLeadHusk(w, e);
  if (lead) { e.attack.markX = lead.x; e.attack.markY = lead.y; }
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.55, gain: 0.7, trauma: 0 });
}

// The lead husk (the "next to act"): in phase 1 the dmg husk leads (else heal, else shield);
// null once merged. Drives the tether "pulls hardest" tell (via the core's mark point).
function quorumLeadHusk(w: WorldState, core: Enemy): Enemy | null {
  for (const kind of ["quorum_dmg", "quorum_heal", "quorum_shield"] as const) {
    const h = w.enemies.find((o) => !o.dead && o.kind === kind && o.seq === core.id + 1);
    if (h) return h;
  }
  return null;
}

function quorumWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  if (a.move === "merge") {
    // The telegraphed 1.2s NON-invuln fuse: keep hurting it. On completion the husks are gone
    // and the merge-form (phase 2, set by checkBossTransition) takes over with its own window.
    a.time += dt;
    a.windup = Math.min(1, a.time / QUORUM.mergeDuration);
    if (a.time >= QUORUM.mergeDuration) {
      quorumRemoveHusks(w, e, ev);
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  // The shared telegraph. Track the lead husk so the tell + tether follow it.
  const lead = quorumLeadHusk(w, e);
  if (lead) { a.markX = lead.x; a.markY = lead.y; }
  const windupT = a.move === "beam" ? QUORUM.crossWindup
    : a.move === "sweep" ? QUORUM.snapWindup
    : a.move === "volley" ? QUORUM.roleWindup
    : boss.phase >= 2 ? QUORUM.mergeRadialWindup : QUORUM.volleyWindup;
  const lockAt = a.move === "beam" ? QUORUM.crossLock
    : a.move === "sweep" ? QUORUM.snapLock
    : a.move === "volley" ? QUORUM.roleLock : QUORUM.volleyLock;
  a.time += dt;
  a.windup = Math.min(1, a.time / windupT);
  if (!a.isAimLocked && findTarget(w, e.x, e.y)) {
    a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
    if (a.time >= lockAt) a.isAimLocked = true;
  }
  if (a.time >= windupT) { a.phase = "active"; a.time = 0; a.windup = 0; }
}

function quorumActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  a.time += dt;
  // Every merge-form commitment opens the widened recover window (the amalgam's earned
  // window); the husk-phase commitments never do (kill-order is the husk mechanic).
  const openWindowOnRecover = (): void => {
    enterRecover(e);
    if (boss.phase >= 2) openBossWindow(e, QUORUM.mergeRecover, ev);
  };
  if (a.move === "beam") {
    if (a.time >= QUORUM.crossActive) { quorumCrossfire(w, e, ev); openWindowOnRecover(); }
    return;
  }
  if (a.move === "sweep") {
    quorumTetherSnap(w, e, ev);
    openWindowOnRecover();
    return;
  }
  if (a.move === "volley") {
    // A3 ROLE VOLLEY: the aimed staggered burst, then a knockback ring pulse (the heal role).
    while (boss.spinCount < QUORUM.roleBurst && a.time >= boss.spinCount * QUORUM.roleGap) {
      const aim = a.lockedAngle + (boss.spinCount - (QUORUM.roleBurst - 1) / 2) * 0.08;
      spawnEnemyBullet(w, e.x, e.y, aim, QUORUM.roleSpeed, QUORUM.globRadius, QUORUM.globDamage, "#e8d9b0", QUORUM.globLife);
      boss.spinCount++;
    }
    if (boss.spinCount >= QUORUM.roleBurst && a.time >= QUORUM.roleGap * QUORUM.roleBurst) {
      quorumRing(w, e, QUORUM.rolePulseCount, QUORUM.rolePulseSpeed); // the heal-role pulse
      openWindowOnRecover();
    }
    return;
  }
  // radial: the converging ring (husk phase) / the wide merge-form ring.
  if (boss.phase >= 2) {
    if (a.time >= QUORUM.mergeRadialActive) {
      quorumRing(w, e, QUORUM.mergeRadialCount, QUORUM.mergeSpeed);
      // Soft-enrage: a burned husk phase carries an extra offset ring in the merge-form.
      if (boss.enrage === 1) quorumRing(w, e, QUORUM.mergeRadialCount, QUORUM.mergeSpeed * 0.8);
      openWindowOnRecover();
    }
    return;
  }
  quorumRing(w, e, QUORUM.radialCount, QUORUM.globSpeed);
  enterRecover(e);
}

// A1 CROSSFIRE: a converging beam CORRIDOR per LIVE husk (the 3-body geometry), each a wall
// of shards down an offset lane toward the party — pick a pocket between them or dash a lane.
// The 4p surplus routes to denser corridors (add-pressure via bossAddCapFor).
function quorumCrossfire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const lanes = Math.max(1, e.boss!.windowAddIds.filter((id) => w.enemies.some((o) => !o.dead && o.id === id)).length || 3);
  const shards = bossAddCapFor(QUORUM.crossShards, w.encounterPower);
  const aim = e.attack.lockedAngle;
  const nx = Math.cos(aim + Math.PI / 2), ny = Math.sin(aim + Math.PI / 2);
  for (let l = 0; l < lanes; l++) {
    const laneAim = aim + (l - (lanes - 1) / 2) * QUORUM.crossLaneSpread;
    for (let i = 0; i < shards; i++) {
      const t = shards > 1 ? i / (shards - 1) - 0.5 : 0;
      spawnEnemyBullet(w, e.x + nx * t * QUORUM.crossHalfWidth * 2, e.y + ny * t * QUORUM.crossHalfWidth * 2, laneAim, QUORUM.crossSpeed, QUORUM.globRadius, QUORUM.globDamage, "#d84a8a", QUORUM.globLife);
    }
  }
  ev.push({ t: "bossVolley", x: e.x, y: e.y });
}

// A2 TETHER SNAP: a dense arc of shards whipped across the aim — a moving WALL to dash
// under/over on i-frames. The arc widens the safe read by leaving its far edges open.
function quorumTetherSnap(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const aim = e.attack.lockedAngle;
  const n = bossAddCapFor(QUORUM.snapShards, w.encounterPower);
  for (let i = 0; i < n; i++) {
    const off = (i / (n - 1) - 0.5) * QUORUM.snapArc;
    spawnEnemyBullet(w, e.x, e.y, aim + off, QUORUM.snapSpeed, QUORUM.globRadius, QUORUM.globDamage, "#c9b458", QUORUM.globLife);
  }
  ev.push({ t: "bossVolley", x: e.x, y: e.y });
}

function quorumRing(w: WorldState, e: Enemy, count: number, speed: number): void {
  const boss = e.boss!;
  const base = (boss.burstParity ^= 1) ? Math.PI / count : 0;
  for (let i = 0; i < count; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / count) * Math.PI * 2, speed, QUORUM.globRadius, QUORUM.globDamage, "#e8d9b0", QUORUM.globLife);
  }
}

function quorumRemoveHusks(w: WorldState, core: Enemy, ev: SimEvent[]): void {
  const boss = core.boss!;
  for (const id of boss.windowAddIds) {
    const h = w.enemies.find((o) => o.id === id && !o.dead);
    if (h) { h.dead = true; ev.push({ t: "puff", x: h.x, y: h.y, n: 6, color: ENEMY_ARCHETYPES[h.kind].tint }); }
  }
  boss.windowAddIds.length = 0;
  ev.push({ t: "cue", name: "bossSpawn", x: core.x, y: core.y, rate: 0.6, gain: 0.85, trauma: 0.1 });
}

// Damage to a husk routes to the shared pool: FULL against the highest-priority living husk
// (shield → heal → dmg), chipped otherwise — so spreading damage evenly stalls. The husk's
// own break-integrity drains too; at 0 it is removed (the tether snaps + yanks).
function quorumDamageHusk(w: WorldState, by: PlayerId | null, husk: Enemy, dmg: number, ev: SimEvent[]): void {
  const core = quorumCoreOf(w, husk);
  if (!core || !core.boss) { husk.hp -= dmg; return; }
  const priority = quorumPriorityHusk(w, core);
  const isPriority = priority !== null && priority.id === husk.id;
  const eff = isPriority ? dmg : dmg * QUORUM.guardMult;
  // Drain the shared pool (the phase-1 guard is the ROLE gate above — never the earned-window
  // chip, which is the merge-form's phase-2 guard). The merge beat's floor still applies.
  const boss = core.boss;
  if (boss.roar) {
    const target = core.hp - eff;
    if (target < boss.roar.floorHp) { boss.roar.queued += boss.roar.floorHp - target; boss.roar.queuedBy = by; core.hp = boss.roar.floorHp; }
    else core.hp = target;
  } else {
    core.hp -= eff;
    checkBossTransition(w, core, ev, by);
  }
  // The husk's break meter (independent of the pool): focus it to end its role.
  husk.affixState -= eff;
  const integrity = Math.max(1, Math.round(QUORUM.huskIntegrityFrac * core.maxHp));
  husk.aux = Math.max(0, Math.min(1, husk.affixState / integrity));
  if (husk.affixState <= 0 && !husk.dead) {
    husk.dead = true;
    // The tether spoke snaps + recoils on a husk's death (the client reads the missing body).
    // The full-trio-cleared tether-SNAP beat (pool opens) fires in updateQuorum; the merge is
    // the sole big screen-punch. Individual husk deaths are light per-husk accents.
    ev.push({ t: "puff", x: husk.x, y: husk.y, n: 7, color: ENEMY_ARCHETYPES[husk.kind].tint });
    ev.push({ t: "cue", name: "enemyHit", x: husk.x, y: husk.y, rate: 0.7, gain: 0.7, trauma: 0.06 });
    // R-framework SURPLUS: a husk break BREAKS OFF a SPLINTER wave carrying its role (per-P
    // cap, paced by the wave interval that tightens 6.0s → 3.0s with R). The merge-form
    // (phase 2) breaks off none — its final window is ungated by R.
    if (boss.phase < 2) quorumSpawnSplinters(w, core, husk, ev);
  }
}

// SPLINTERS (balancer FINAL surplus): a dying husk breaks off small role-echo shards, count =
// min(bossAddCapFor(1, R), 5) → solo 1 / 2p 4 / 3p 5 / 4p 5, paced by bossAddIntervalFor(6.0 →
// 3.0s). They arrive through the FAIR-AMBUSH path like every other boss add (fair surprise §2):
// each shard plants an omen tell at a seeded ring spot off the husk (husk.zig based) that stands
// for its whole AMBUSH.tell BEFORE the body exists, and the omen REFUSES any spot within
// AMBUSH.playerClear (140px) of a standing player — so a shard can never pop onto you. The
// resolved body keeps its ordinary spawn grace (and the arbiter hold) so it never acts mid
// tether-snap. Each carries a WEAK version of its parent's role on aux (0 shield / 1 heal /
// 2 dmg): the heal shard trickle-heals the pool, the dmg shard pips on contact, the shield
// shard is a body to clear — the kill-order lesson at small scale (clear the wave before the
// pool window).
function quorumSpawnSplinters(w: WorldState, core: Enemy, husk: Enemy, ev: SimEvent[]): void {
  const boss = core.boss!;
  if (boss.addTimer > 0) return; // paced by the wave interval
  const cap = Math.min(bossAddCapFor(QUORUM.huskAddBase, w.encounterPower), QUORUM.huskAddCap);
  if (cap <= 0) return;
  boss.addTimer = bossAddIntervalFor(QUORUM.huskAddInterval, w.encounterPower);
  const role = husk.kind === "quorum_shield" ? 0 : husk.kind === "quorum_heal" ? 1 : 2;
  // Pending omens hold the cap the moment their tell stands (like the Tithe's feed adds), so
  // the wave never over-plants while shards are still announcing.
  let live = countLiveAddsOfKind(w, "quorum_splinter") + countPendingOmensOfKind(w, "quorum_splinter", "standard");
  for (let i = 0; i < cap && live < cap; i++) {
    // The seeded ring off the husk (zig baked at spawn) is WHERE it tries; a spot within the
    // player-clear is refused, so retry a few nudged angles before giving that shard up.
    for (let attempt = 0; attempt < 4; attempt++) {
      const ang = husk.zig + (i / cap) * Math.PI * 2 + attempt * 2.399963;
      const x = husk.x + Math.cos(ang) * 26;
      const y = husk.y + Math.sin(ang) * 26;
      if (queueAmbush(w, x, y, "quorum_splinter", "standard", core.id + 1, ev, AMBUSH.tell, AMBUSH.playerClear, role)) { live++; break; }
    }
  }
}

// A splinter (surplus add): the heal shard trickle-heals the shared pool while it lives (undo
// the pool progress — clear it, the kill-order lesson at small scale); all shards chase. The
// spawn grace holds it inert so it never acts inside the husk's tether-snap.
function updateQuorumSplinter(w: WorldState, e: Enemy, dt: number): void {
  if (e.spawnTimer > 0) return; // (a) ordinary spawn-grace (on top of the omen tell that preceded it)
  // (b) FIRST-action hold (explicit — the arbiter covers the pip-vs-sweep INSTANT overlap but
  // not the full hold): the shard's first action waits until no MAJOR release (tether-snap
  // sweep / crossfire beam) is mid-flight. affixClock latches once it has acted (0 → 1), so
  // only the first action is gated; after that it acts normally under the arbiter.
  if (e.affixClock === 0) {
    // A major release is "mid-flight" for the whole commitment (windup → active → recover while
    // its wall/lanes travel) — the move stays set until the core idles, so key off the move.
    const coreForHold = quorumCoreOf(w, e);
    const majorMidFlight = coreForHold !== null
      && (coreForHold.attack.move === "sweep" || coreForHold.attack.move === "beam");
    if (majorMidFlight) return;
    e.affixClock = 1;
  }
  if (e.aux === 1) { // heal-role shard: trickle-heal the pool (weak)
    const core = quorumCoreOf(w, e);
    if (core && core.boss && core.boss.phase < 2 && !core.boss.roar && core.hp < core.maxHp) {
      core.hp = Math.min(core.maxHp, core.hp + QUORUM.splinterHealPerSec * dt);
    }
  }
  if (findTarget(w, e.x, e.y)) applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}


// ---- SEVER (F55 HUNT/INTERCEPT + WORLDSPLIT) — Batch1 OWNER LOCK ----
// 3 chase checkpoints on Batch0 RoomEdges. Flee when pressured; escape advances escapeMeter
// / cuts a route (soft fail — never wipes the run). Intercept: destroy 2 resin anchors that
// trap both exits of a checkpoint room → earned window (SEPARATE hunt verb). Signature
// WORLDSPLIT: 1.5s plant/tell → 1.2s moving fracture → 3.0s reel-back punish (±1 tick).
// Success counter = dedicated WORLDSPLIT tooth on alternate shortcut dies before fracture
// completes (NOT intercept boss.exposed). Survival = cross band, no window. Failure = soft
// route worsen, never wipe. No global aggro before encounter activation.
function severEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "hunt" ? w.encounter : null;
}

function severTryActivate(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = severEnc(w);
  if (!enc) return true; // no encounter bag → treat as already live (dev spawn)
  if (enc.active) return true;
  // Activation: any living player inside the approach/current room OR pressure radius.
  let activate = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    const rid = roomIdAt(w.dungeon, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
    if (rid === enc.currentRoomId || (w.dungeon.blueprint && rid === w.dungeon.blueprint.spawnRoomId)) {
      activate = true; break;
    }
    if (Math.hypot(p.x - e.x, p.y - e.y) < SEVER.pressureRadius) { activate = true; break; }
  }
  if (!activate) return false;
  enc.active = true;
  // Plant CP0 anchors on first activation (2 anchors trap both exits → earned window).
  if ((Number(enc.flags.anchorsPlantedCp) ?? -1) < enc.checkpoint) {
    severPlantAnchors(w, e, ev);
  }
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.85, gain: 0.5, trauma: 0.05 });
  return true;
}

function updateSever(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;
  const enc = severEnc(w);

  // Sync encounter room from body position (reconnect/late-join friendly).
  if (enc) {
    const rid = roomIdAt(w.dungeon, Math.floor(e.x / TILE), Math.floor(e.y / TILE));
    if (rid >= 0) enc.currentRoomId = rid;
  }

  // Pre-activation: body present, but NO hunt flee / WORLDSPLIT / aggro.
  if (!severTryActivate(w, e, ev)) {
    if (a.phase !== "none") enterIdle(e);
    return;
  }

  // Sev-0 fail-safe FIRST: the hunt can never softlock a run. Once it has resolved to a soft
  // escape (escape meter maxed, or a stall watchdog), the exit is already open and Sever
  // disengages — the party can descend even if they never found a single anchor.
  if (severFailsafe(w, e, dt, ev)) { if (a.phase !== "none") enterIdle(e); return; }

  // Anchor intercept loop (parallel): both anchors dead → open window + advance checkpoint.
  severAnchorLoop(w, e, ev);

  if (a.phase === "windup") { severWorldsplitWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { severWorldsplitActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= SEVER.worldsplitPunish) {
      if (enc) enc.flags.worldsplitPhase = "idle";
      severClearWorldsplitTooth(w, e);
      enterIdle(e);
    }
    return;
  }

  // Flee / hunt locomotion when not mid-WORLDSPLIT.
  severHuntStep(w, e, dt, ev);

  if (a.cooldown === 0 && e.spawnTimer === 0 && !boss.roar && !(enc && enc.flags.interceptState === "exposed")) {
    // Commit WORLDSPLIT when a player is in sightline / pressure range.
    if (findTarget(w, e.x, e.y) && Math.hypot(w.targetX - e.x, w.targetY - e.y) < SEVER.pressureRadius * 1.4) {
      beginWindup(e, "worldsplit");
      a.cooldown = SEVER.attackCd[boss.phase] ?? SEVER.attackCd[3];
      if (enc) {
        enc.flags.worldsplitPhase = "plant";
        enc.flags.worldsplitOutcome = "pending"; // success | survival | failure
        enc.flags.worldsplitToothBroken = false;
      }
      // Dedicated WORLDSPLIT tooth on alternate shortcut / fracture support — NOT an
      // intercept trap anchor (those ride boss.windowAddIds separately).
      severPlantWorldsplitTooth(w, e, ev);
      ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.7, gain: 0.55, trauma: 0.04 });
    }
  }
}

function severHuntStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const enc = severEnc(w);
  if (!enc) {
    if (findTarget(w, e.x, e.y)) applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
    return;
  }
  const pressured = findTarget(w, e.x, e.y)
    && Math.hypot(w.targetX - e.x, w.targetY - e.y) < SEVER.pressureRadius;
  const bp = w.dungeon.blueprint;
  const cps = bp?.objectiveRoomIds ?? [];
  const cp = Math.max(0, Math.min(2, enc.checkpoint));

  // Trap = anchors live (players may intercept). Sever still flees when pressured;
  // only the earned window holds the body for punish.
  if (pressured && enc.flags.interceptState !== "exposed") {
    // Flee toward next checkpoint via authored chase edges.
    const nextCp = cps[Math.min(cps.length - 1, cp + (cps[cp] === enc.currentRoomId ? 1 : 0))] ?? cps[cps.length - 1];
    let chosen = -1;
    let best = Infinity;
    const dest = w.dungeon.rooms.find((r) => r.id === nextCp);
    for (let i = 0; i < w.dungeon.edges.length; i++) {
      const edge = w.dungeon.edges[i];
      if (edge.locked) continue;
      if (edge.a !== enc.currentRoomId && edge.b !== enc.currentRoomId) continue;
      // Prefer chaseEdgeIds
      const isChase = bp && bp.chaseEdgeIds.indexOf(i) >= 0;
      const other = edge.a === enc.currentRoomId ? edge.b : edge.a;
      const room = w.dungeon.rooms.find((r) => r.id === other);
      if (!room || !dest) continue;
      const d = Math.abs(room.cx - dest.cx) + Math.abs(room.cy - dest.cy);
      const score = d - (isChase ? 100 : 0);
      if (score < best) { best = score; chosen = i; }
    }
    if (chosen >= 0) {
      enc.routeEdgeId = chosen;
      enc.flags.chosenExitEdgeId = chosen;
      const edge = w.dungeon.edges[chosen];
      const towardB = edge.a === enc.currentRoomId;
      const otherId = towardB ? edge.b : edge.a;
      const otherRoom = w.dungeon.rooms.find((r) => r.id === otherId);
      // Follow the authored edge.path (tile centers). Walk forward along the path toward the
      // destination room so roomIdAt advances across ≥2 RoomEdges under pressure.
      const path = edge.path;
      let tx: number, ty: number;
      if (path.length > 0) {
        let bestI = 0, bestD = Infinity;
        for (let i = 0; i < path.length; i++) {
          const px = path[i].x * TILE + TILE / 2;
          const py = path[i].y * TILE + TILE / 2;
          const d = Math.hypot(px - e.x, py - e.y);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        // Step ahead along the path in the direction that leads to the destination room.
        const destIdx = towardB ? path.length - 1 : 0;
        const stepAhead = towardB ? 2 : -2;
        let aimI = bestI;
        if (towardB) aimI = Math.min(path.length - 1, bestI + (bestD < TILE * 0.85 ? 2 : 1));
        else aimI = Math.max(0, bestI - (bestD < TILE * 0.85 ? 2 : 1));
        // If already near the far end, commit to destination room center.
        if (Math.abs(aimI - destIdx) <= 1 && otherRoom) {
          tx = otherRoom.cx * TILE + TILE / 2;
          ty = otherRoom.cy * TILE + TILE / 2;
        } else {
          tx = path[aimI].x * TILE + TILE / 2;
          ty = path[aimI].y * TILE + TILE / 2;
        }
        void stepAhead;
      } else if (otherRoom) {
        tx = otherRoom.cx * TILE + TILE / 2;
        ty = otherRoom.cy * TILE + TILE / 2;
      } else {
        const farDoor = towardB ? edge.doorB : edge.doorA;
        tx = farDoor.x * TILE + TILE / 2;
        ty = farDoor.y * TILE + TILE / 2;
      }
      const ang = Math.atan2(ty - e.y, tx - e.x);
      applyChaseStep(w, e, dt, ang, e.speed * SEVER.fleeSpeedMult * dt);
      // Arrived in next room along edge?
      const newRoom = roomIdAt(w.dungeon, Math.floor(e.x / TILE), Math.floor(e.y / TILE));
      if (newRoom >= 0 && newRoom !== enc.currentRoomId) {
        const from = enc.currentRoomId;
        enc.currentRoomId = newRoom;
        // Soft escape: if players didn't intercept, bump escapeMeter (never fail the run).
        const playersNear = [...w.players.values()].some((p) => !p.isDown && Math.hypot(p.x - e.x, p.y - e.y) < SEVER.pressureRadius * 0.85);
        if (!playersNear) {
          const meter = (Number(enc.flags.escapeMeter) || 0) + 1;
          enc.flags.escapeMeter = meter;
          enc.failureCount = meter;
          // Carve/worsen: lock the edge just used (supportsCut bitmask).
          const bit = 1 << (chosen & 31);
          enc.flags.supportsCut = (Number(enc.flags.supportsCut) || 0) | bit;
          edge.locked = true;
          if (meter >= SEVER.escapeMeterMax) {
            enc.failed = true; // soft — route worsened, run remains winnable
            enc.flags.interceptState = "escaped";
          }
        }
        // Advance checkpoint when reaching an objective room ahead.
        const idx = cps.indexOf(newRoom);
        if (idx > enc.checkpoint) {
          enc.checkpoint = Math.min(2, idx);
          severPlantAnchors(w, e, ev);
          enc.flags.interceptState = "trap";
        }
        void from;
      }
      return;
    }
  }

  // Default: keep distance / light chase facing the party (hunt presence).
  if (findTarget(w, e.x, e.y)) {
    const ang = chaseAngle(w, e);
    applyChaseStep(w, e, dt, ang, e.speed * 0.55 * dt);
  }
}

function severPlantAnchors(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = severEnc(w);
  if (!enc) return;
  const boss = e.boss!;
  // Clear prior live anchors.
  for (const id of boss.windowAddIds) {
    const a = w.enemies.find((o) => o.id === id && o.kind === "sever_anchor");
    if (a) a.dead = true;
  }
  boss.windowAddIds.length = 0;
  const room = w.dungeon.rooms.find((r) => r.id === enc.currentRoomId);
  if (!room) return;
  const exits = neighbors(w.dungeon, enc.currentRoomId).slice(0, SEVER.anchorsPerCheckpoint);
  const hp = severAnchorHpForFloor(w.floor);
  const cxCenter = room.cx * TILE + TILE / 2;
  const cyCenter = room.cy * TILE + TILE / 2;
  const r = ENEMY_ARCHETYPES.sever_anchor.radius;
  for (let i = 0; i < SEVER.anchorsPerCheckpoint; i++) {
    // Preferred site: on a checkpoint-room exit door (the "trap both exits" read).
    let x = (room.cx + (i === 0 ? -2 : 2)) * TILE + TILE / 2;
    let y = cyCenter;
    if (exits[i]) {
      const edge = exits[i];
      const door = edge.a === enc.currentRoomId ? edge.doorA : edge.doorB;
      x = door.x * TILE + TILE / 2;
      y = door.y * TILE + TILE / 2;
    }
    if (settleSpawnPoint(w, x, y, r)) {
      x = settlePoint.x; y = settlePoint.y;
    } else {
      // No exit / a blocked door mouth: fan the anchors out on OPPOSITE sides of the room
      // center rather than piling them on top of each other (and the boss). Each is still
      // settled onto valid floor, so both stay reachable, living, and visibly distinct.
      const ang = Math.PI / 4 + (Math.PI * 2 * i) / SEVER.anchorsPerCheckpoint;
      const fx = cxCenter + Math.cos(ang) * TILE * 2.5;
      const fy = cyCenter + Math.sin(ang) * TILE * 2.5;
      if (settleSpawnPoint(w, fx, fy, r)) { x = settlePoint.x; y = settlePoint.y; }
      else { x = fx; y = fy; }
    }
    const anchor = createEnemy("sever_anchor", x, y, w.floor, w.rng, w.nextEnemyId++, { isSummoned: true });
    anchor.hp = anchor.maxHp = hp;
    anchor.spawnTimer = 0;
    w.enemies.push(anchor);
    boss.windowAddIds.push(anchor.id);
  }
  enc.flags.interceptState = "trap";
  enc.flags.anchorsPlantedCp = enc.checkpoint;
  enc.objectiveProgress = Math.min(1, (enc.checkpoint) / 3);
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 1.1, gain: 0.45, trauma: 0.03 });
}

// Sev-0 fail-safe (the hunt can NEVER softlock a run). Two independent catches funnel into ONE
// soft-escape completion that opens the exit WITHOUT the boss reward: (1) the escape meter
// reaching its max (the documented "route worsened" loss), and (2) a stall watchdog — the
// encounter stays active with ZERO progress (no boss damage, no checkpoint, no open window) for
// SEVER.stallFailoverSec. Returns whether the hunt has resolved (so Sever disengages).
function severFailsafe(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  const enc = severEnc(w);
  if (!enc) return false;
  if (enc.completed) return true;
  if (Number(enc.flags.escapeMeter) >= SEVER.escapeMeterMax) { severSoftEscapeComplete(w, e, ev); return true; }
  const prevHp = enc.flags.stallHp == null ? e.hp : Number(enc.flags.stallHp);
  const prevCp = enc.flags.stallCp == null ? enc.checkpoint : Number(enc.flags.stallCp);
  const isProgress = e.hp < prevHp - 0.5 || enc.checkpoint > prevCp || enc.flags.interceptState === "exposed";
  const stall = isProgress ? 0 : Number(enc.flags.stallSec ?? 0) + dt;
  enc.flags.stallSec = stall;
  enc.flags.stallHp = e.hp;
  enc.flags.stallCp = enc.checkpoint;
  if (stall >= SEVER.stallFailoverSec) { severSoftEscapeComplete(w, e, ev); return true; }
  return false;
}

// The hunt slips away: open the exit (soft escape) so the party can descend. No premium reward
// (they lost the hunt), and the WORLDSPLIT tooth is cleared so nothing dangles.
function severSoftEscapeComplete(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = severEnc(w);
  if (!enc || enc.completed) return;
  severClearWorldsplitTooth(w, e);
  enc.failed = true;
  enc.flags.interceptState = "escaped";
  completeEncounter(enc);
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.5, gain: 0.55, trauma: 0.05 });
}

function severAnchorLoop(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const enc = severEnc(w);
  if (!enc || boss.windowAddIds.length === 0) return;
  if (countLiveIds(w, boss.windowAddIds) === 0) {
    boss.windowAddIds.length = 0;
    openBossWindow(e, SEVER.interceptWindow, ev);
    enc.flags.interceptState = "exposed";
    // Carrier pip: nearest living player to Sever earns the intercept credit.
    let best: { id: string; d: number } | null = null;
    for (const p of w.players.values()) {
      if (p.isDown || p.isAbsent || p.hp <= 0) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (!best || d < best.d) best = { id: p.id, d };
    }
    if (best) setEncounterCarrier(enc, best.id);
    const next = Math.min(2, enc.checkpoint + 1);
    enc.checkpoint = next;
    enc.objectiveProgress = Math.min(1, (next + 1) / 3);
    if (next >= 2 && e.hp <= e.maxHp * 0.2) {
      // Final chamber pressure — completion still via boss death OR full objective.
      enc.objectiveProgress = 1;
    }
    ev.push({ t: "chargeCrash", x: e.x, y: e.y });
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.6, gain: 0.7, trauma: 0.08 });
  }
}

// Plant ONE dedicated WORLDSPLIT tooth on the alternate shortcut / fracture support.
// Distinct from intercept trap anchors (boss.windowAddIds). Success counter keys ONLY
// off this tooth dying during plant/fracture — never off intercept boss.exposed.
function severPlantWorldsplitTooth(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = severEnc(w);
  const boss = e.boss!;
  // Clear any prior WORLDSPLIT tooth (laneKnotId channel) — leave intercept anchors alone.
  if (boss.laneKnotId > 0) {
    const old = w.enemies.find((o) => o.id === boss.laneKnotId - 1 && o.kind === "sever_anchor");
    if (old) old.dead = true;
    boss.laneKnotId = 0;
  }
  const roomId = enc
    ? enc.currentRoomId
    : roomIdAt(w.dungeon, Math.floor(e.x / TILE), Math.floor(e.y / TILE));
  const room = w.dungeon.rooms.find((r) => r.id === roomId);
  const neigh = roomId >= 0 ? neighbors(w.dungeon, roomId) : [];
  const chase = w.dungeon.blueprint?.chaseEdgeIds ?? [];
  // Prefer shortcut (alternate route); else a non-chase neighbor (fracture support); else any.
  let edge = neigh.find((ed) => ed.isShortcut && !ed.locked)
    ?? neigh.find((ed) => {
      const ei = w.dungeon.edges.indexOf(ed);
      return ei >= 0 && chase.indexOf(ei) < 0 && !ed.locked;
    })
    ?? neigh.find((ed) => !ed.locked)
    ?? null;
  let x = e.x + 72;
  let y = e.y - 56;
  if (edge && room) {
    const door = edge.a === roomId ? edge.doorA : edge.doorB;
    // On the support mouth, nudged into the room (readable tooth on the alternate shortcut).
    const nx = Math.sign(room.cx - door.x) || 1;
    const ny = Math.sign(room.cy - door.y) || 0;
    x = (door.x + nx) * TILE + TILE / 2;
    y = (door.y + ny) * TILE + TILE / 2;
  } else if (room) {
    x = (room.cx + 2) * TILE + TILE / 2;
    y = (room.cy - 2) * TILE + TILE / 2;
  }
  if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.sever_anchor.radius)) {
    x = e.x + 64; y = e.y - 48;
    settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.sever_anchor.radius);
  }
  const hp = severAnchorHpForFloor(w.floor);
  const tooth = createEnemy("sever_anchor", x, y, w.floor, w.rng, w.nextEnemyId++, { isSummoned: true });
  tooth.hp = tooth.maxHp = hp;
  tooth.spawnTimer = 0;
  tooth.aux = 1; // highlight WORLDSPLIT tooth (intercept anchors stay aux=0)
  tooth.seq = e.id + 1; // caster link for cleanup
  w.enemies.push(tooth);
  boss.laneKnotId = tooth.id + 1;
  if (enc) {
    enc.flags.worldsplitToothId = tooth.id;
    enc.flags.worldsplitToothBroken = false;
  }
  ev.push({ t: "cue", name: "bossSpawn", x: tooth.x, y: tooth.y, rate: 1.25, gain: 0.4, trauma: 0.02 });
}

function severWorldsplitToothBroken(w: WorldState, e: Enemy): boolean {
  const boss = e.boss;
  const enc = severEnc(w);
  if (!boss) return false;
  // Sticky: once broken during this WORLDSPLIT, stays true through fracture resolve.
  if (enc && enc.flags.worldsplitToothBroken === true) return true;
  if (boss.laneKnotId <= 0) {
    if (enc && Number(enc.flags.worldsplitToothId) >= 0) {
      // Tooth id was set but lane cleared — treat as broken if body gone.
      const id = Number(enc.flags.worldsplitToothId);
      const live = w.enemies.some((o) => o.id === id && o.kind === "sever_anchor" && !o.dead);
      if (!live) {
        if (enc) enc.flags.worldsplitToothBroken = true;
        return true;
      }
    }
    return false;
  }
  const tooth = w.enemies.find((o) => o.id === boss.laneKnotId - 1 && o.kind === "sever_anchor");
  const broken = !tooth || tooth.dead || tooth.hp <= 0;
  if (broken && enc) enc.flags.worldsplitToothBroken = true;
  return broken;
}

function severClearWorldsplitTooth(w: WorldState, e: Enemy): void {
  const boss = e.boss;
  if (!boss) return;
  if (boss.laneKnotId > 0) {
    const tooth = w.enemies.find((o) => o.id === boss.laneKnotId - 1 && o.kind === "sever_anchor");
    if (tooth && !tooth.dead) tooth.dead = true;
    boss.laneKnotId = 0;
  }
  const enc = severEnc(w);
  if (enc) enc.flags.worldsplitToothId = -1;
}

function severWorldsplitWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const enc = severEnc(w);
  a.time += dt;
  a.windup = Math.min(1, a.time / SEVER.worldsplitPlant);
  // Poll tooth death during plant (success may arm before fracture ends).
  severWorldsplitToothBroken(w, e);
  // Aim/route lock ~60% with ≥0.30s reaction (fairness contract). Prefer a two-room
  // diagonal sightline (current room → neighbor) so the fracture band spans rooms.
  if (!a.isAimLocked && a.windup >= 0.6) {
    let locked = false;
    if (enc) {
      const room = w.dungeon.rooms.find((r) => r.id === enc.currentRoomId);
      const neigh = neighbors(w.dungeon, enc.currentRoomId);
      const edge = neigh.find((ed) => ed.isShortcut && !ed.locked) ?? neigh[0];
      if (room && edge) {
        const otherId = edge.a === enc.currentRoomId ? edge.b : edge.a;
        const other = w.dungeon.rooms.find((r) => r.id === otherId);
        if (other) {
          // Soft diagonal two-room fracture scar: aim across room centers (not pure axis).
          const tx = (other.cx + (other.cx >= room.cx ? 1 : -1)) * TILE + TILE / 2;
          const ty = (other.cy + (other.cy >= room.cy ? 1 : -1)) * TILE + TILE / 2;
          a.lockedAngle = Math.atan2(ty - e.y, tx - e.x);
          a.markX = tx;
          a.markY = ty;
          locked = true;
          // Cheap scar endpoints for reconnect/spectate (tile coords).
          enc.flags.worldsplitScarX0 = Math.floor(e.x / TILE);
          enc.flags.worldsplitScarY0 = Math.floor(e.y / TILE);
          enc.flags.worldsplitScarX1 = Math.floor(tx / TILE);
          enc.flags.worldsplitScarY1 = Math.floor(ty / TILE);
        }
      }
    }
    if (!locked) {
      if (findTarget(w, e.x, e.y)) {
        a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        a.markX = w.targetX;
        a.markY = w.targetY;
      } else {
        a.lockedAngle = 0;
      }
    }
    a.isAimLocked = true;
  }
  if (enc) enc.flags.worldsplitPhase = "plant";
  if (a.time >= SEVER.worldsplitPlant) {
    a.phase = "active";
    a.time = 0;
    a.windup = 1;
    if (enc) enc.flags.worldsplitPhase = "fracture";
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.5, gain: 0.75, trauma: 0.1 });
  }
}

function severWorldsplitActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const enc = severEnc(w);
  a.time += dt;
  // Moving fracture across two-room sightline — 1-tile band along locked angle.
  const t = a.time / SEVER.worldsplitFracture;
  const front = Math.min(1, t) * 320;
  let anyHit = false;
  let anySurvivedCrossing = false;
  // Keep success sticky if the WORLDSPLIT tooth dies mid-fracture.
  const toothBroken = severWorldsplitToothBroken(w, e);
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    // Distance to segment e → front tip
    const dx = p.x - e.x, dy = p.y - e.y;
    const proj = dx * Math.cos(a.lockedAngle) + dy * Math.sin(a.lockedAngle);
    if (proj < 0 || proj > front + TILE) continue;
    const perp = Math.abs(-dx * Math.sin(a.lockedAngle) + dy * Math.cos(a.lockedAngle));
    if (perp < TILE * 0.85) {
      // Survival fallback: invuln/dash crossing the line before front arrives → no chip.
      if (p.invuln > 0) { anySurvivedCrossing = true; continue; }
      anyHit = true;
      damagePlayer(w, p, 1, ev);
      ev.push({ t: "trauma", amount: 0.12 });
    }
  }
  if (a.time >= SEVER.worldsplitFracture) {
    // OWNER LOCK success counter: WORLDSPLIT tooth dead during plant/fracture → blades jam
    // → 3.0s punish. Do NOT treat intercept trap / boss.exposed as WORLDSPLIT success.
    enterRecover(e);
    if (enc) enc.flags.worldsplitPhase = "punish";
    const success = toothBroken;
    if (success) {
      if (enc) enc.flags.worldsplitOutcome = "success";
      // Blades jam → reel-back punish window (bank-capped via openBossWindow).
      openBossWindow(e, SEVER.worldsplitPunish, ev);
      // Carrier pip: nearest living player to the (ex-)tooth / Sever earns credit.
      if (enc) {
        let best: { id: string; d: number } | null = null;
        for (const p of w.players.values()) {
          if (p.isDown || p.isAbsent || p.hp <= 0) continue;
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (!best || d < best.d) best = { id: p.id, d };
        }
        if (best) setEncounterCarrier(enc, best.id);
      }
    } else if (anySurvivedCrossing && !anyHit) {
      // Survival-only: crossed before front → live, NO window.
      if (enc) enc.flags.worldsplitOutcome = "survival";
    } else {
      // Failure: soft route worsen; never wipe.
      if (enc) {
        enc.flags.worldsplitOutcome = "failure";
        enc.failed = true;
        const bit = 1 << ((Number(enc.flags.chosenExitEdgeId) || 0) & 31);
        enc.flags.supportsCut = (Number(enc.flags.supportsCut) || 0) | bit;
        const ei = Number(enc.flags.chosenExitEdgeId);
        if (ei >= 0 && ei < w.dungeon.edges.length) w.dungeon.edges[ei].locked = true;
      }
    }
    severClearWorldsplitTooth(w, e);
  }
}


// ---- HOLLOW CHOIRMASTER F60 — THE LAST NOTE (Batch2A OWNER LOCK) ----
// Timings: 1.6s silent inhale → ~0.7s per linked sheet span → 4.0s voiceless punish.
// Success = silence FIRST live pillar before sheet reaches it → openBossWindow(4.0).
// Survival = stand in acoustic shadow behind a previously broken pillar (no window).
// Failure = sheet continues span-by-span under overlap arbiter; soft escalate; never wipe.
// ONE multi-lobed super-room (structureKind 'split') — NOT a RoomEdge chase.
// Cadence: boss.lastAddPick stores centiseconds until next signature.
// Phrase index → boss.spinCount. Live pillar id → boss.laneKnotId-1.
// Outcome rides boss.mirrorLastFamily: -1 idle, 0 pending, 1 success, 2 survival, 3 failure.

function choirEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "split" ? w.encounter : null;
}

function choirSetOutcome(w: WorldState, e: Enemy, outcome: "idle" | "pending" | "success" | "survival" | "failure"): void {
  const enc = choirEnc(w);
  if (enc) enc.flags.lastNoteOutcome = outcome;
  const map = { idle: -1, pending: 0, success: 1, survival: 2, failure: 3 } as const;
  e.boss!.mirrorLastFamily = map[outcome];
}

function choirTryActivate(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = choirEnc(w);
  if (!enc) return false;
  if (enc.active) {
    // Late activation / reconnect / tests may mark active before pillars exist.
    if (enc.flags.pillarsPlanted !== true) choirPlantPillars(w, e, ev);
    return true;
  }
  let near = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) <= CHOIRMASTER.pressureRadius) { near = true; break; }
  }
  if (!near) {
    // Also activate when any living player enters the super-room / a lobe room.
    const lobes = new Set(w.dungeon.blueprint?.objectiveRoomIds ?? [enc.currentRoomId]);
    for (const p of w.players.values()) {
      if (p.isDown || p.isAbsent || p.hp <= 0) continue;
      const rid = roomIdAt(w.dungeon, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
      if (rid >= 0 && lobes.has(rid)) { near = true; break; }
    }
  }
  if (!near) return false;
  enc.active = true;
  enc.currentRoomId = w.dungeon.blueprint?.spawnRoomId ?? enc.currentRoomId;
  choirPlantPillars(w, e, ev);
  ev.push({ t: "cue", name: "choirmaster.activate", x: e.x, y: e.y, rate: 0.75, gain: 0.65, trauma: 0.04 });
  return true;
}

function choirPlantPillars(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = choirEnc(w);
  if (!enc || enc.flags.pillarsPlanted === true) return;
  const boss = e.boss!;
  // Clear any stale pillars.
  for (const o of w.enemies) if (o.kind === "choir_pillar" && !o.dead) o.dead = true;
  boss.windowAddIds.length = 0;
  const lobes = w.dungeon.blueprint?.objectiveRoomIds ?? [];
  const count = Math.max(3, Math.min(CHOIRMASTER.pillarCount, Math.max(3, lobes.length)));
  const hp = choirPillarHpForFloor(w.floor);
  const r = ENEMY_ARCHETYPES.choir_pillar.radius;
  for (let i = 0; i < count; i++) {
    const roomId = lobes[i % Math.max(1, lobes.length)] ?? enc.currentRoomId;
    const room = w.dungeon.rooms.find((rm) => rm.id === roomId) ?? w.dungeon.rooms[w.dungeon.rooms.length - 1];
    // Place pillars around lobe centers in a ring relative to the conductor so the sheet
    // route is authored as conductor → lobe spans (directional, not radial).
    const ang = -Math.PI / 2 + (i / count) * Math.PI * 2;
    let x = room.cx * TILE + TILE / 2 + Math.cos(ang) * (TILE * 1.5);
    let y = room.cy * TILE + TILE / 2 + Math.sin(ang) * (TILE * 1.5);
    if (!settleSpawnPoint(w, x, y, r)) {
      x = room.cx * TILE + TILE / 2;
      y = room.cy * TILE + TILE / 2;
      settleSpawnPoint(w, x, y, r);
    }
    const pillar = createEnemy("choir_pillar", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    pillar.hp = pillar.maxHp = hp;
    pillar.spawnTimer = 0;
    pillar.seq = e.id + 1;
    pillar.aux = 0; // 0 dormant, 1 live/resonating, 2 silenced (kept for VFX)
    w.enemies.push(pillar);
    boss.windowAddIds.push(pillar.id);
    ev.push({ t: "enemySpawn", eid: pillar.id, kind: pillar.kind, tier: pillar.tier, x: pillar.x, y: pillar.y });
  }
  enc.flags.pillarsPlanted = true;
  enc.flags.silencedMask = 0;
  enc.flags.acousticShadowPillarId = -1;
  choirLightNextPillar(w, e, ev);
}

function choirPillars(w: WorldState, e: Enemy): Enemy[] {
  const ids = e.boss!.windowAddIds;
  const out: Enemy[] = [];
  for (const id of ids) {
    const p = w.enemies.find((o) => o.id === id && o.kind === "choir_pillar");
    if (p) out.push(p);
  }
  return out;
}

function choirLightNextPillar(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = choirEnc(w);
  if (!enc) return;
  const pillars = choirPillars(w, e);
  const mask = Number(enc.flags.silencedMask) || 0;
  // Pick the first non-silenced pillar in authored order as the live target.
  let live: Enemy | null = null;
  let liveSlot = -1;
  for (let i = 0; i < pillars.length; i++) {
    if ((mask & (1 << i)) !== 0) continue;
    if (pillars[i].dead || pillars[i].hp <= 0) continue;
    live = pillars[i];
    liveSlot = i;
    break;
  }
  for (const p of pillars) p.aux = 0;
  if (!live) {
    enc.flags.livePillarId = -1;
    e.boss!.laneKnotId = 0;
    return;
  }
  live.aux = 1;
  enc.flags.livePillarId = live.id;
  enc.flags.phraseIndex = liveSlot;
  e.boss!.laneKnotId = live.id + 1;
  e.boss!.mirrorFamily = liveSlot;
  ev.push({ t: "cue", name: "choirmaster.phraseLight", x: live.x, y: live.y, rate: 1.05, gain: 0.5, trauma: 0.02 });
}

function choirSilencePillar(w: WorldState, e: Enemy, pillar: Enemy, ev: SimEvent[]): void {
  const enc = choirEnc(w);
  if (!enc) return;
  const pillars = choirPillars(w, e);
  const slot = pillars.findIndex((p) => p.id === pillar.id);
  if (slot < 0) return;
  const mask = Number(enc.flags.silencedMask) || 0;
  enc.flags.silencedMask = mask | (1 << slot);
  pillar.aux = 2;
  pillar.dead = true;
  // Acoustic shadow = last broken pillar (survival fallback for THE LAST NOTE).
  enc.flags.acousticShadowPillarId = pillar.id;
  const silenced = pillars.filter((_, i) => ((Number(enc.flags.silencedMask) || 0) & (1 << i)) !== 0).length;
  enc.checkpoint = silenced;
  enc.objectiveProgress = Math.min(1, silenced / Math.max(1, CHOIRMASTER.phrasePillars));
  ev.push({ t: "cue", name: "choirmaster.silence", x: pillar.x, y: pillar.y, rate: 0.9, gain: 0.55, trauma: 0.03 });
  // Completing the authored phrase opens a small earned window (bank-capped) outside LAST NOTE.
  if (silenced > 0 && silenced % CHOIRMASTER.phrasePillars === 0) {
    openBossWindow(e, 2.0, ev);
    enc.flags.activePhrase = Number(enc.flags.activePhrase) + 1;
  }
  choirLightNextPillar(w, e, ev);
}

function choirPillarLoop(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = choirEnc(w);
  if (!enc || !enc.active) return;
  const liveId = Number(enc.flags.livePillarId);
  if (liveId < 0) return;
  const live = w.enemies.find((o) => o.id === liveId && o.kind === "choir_pillar");
  // Wrong/dormant pillar damage: if a non-live pillar was killed, soft-escalate (never wipe).
  for (const p of choirPillars(w, e)) {
    if (p.id === liveId) continue;
    if ((p.dead || p.hp <= 0) && p.aux !== 2) {
      p.aux = 2;
      enc.failureCount += 1;
      enc.failed = true;
      // Soft pressure ping near conductor — never an unavoidable wipe.
      for (const pl of w.players.values()) {
        if (pl.isDown || pl.isAbsent || pl.hp <= 0) continue;
        if (Math.hypot(pl.x - e.x, pl.y - e.y) < CHOIRMASTER.pressureRadius) {
          damagePlayer(w, pl, CHOIRMASTER.wrongPillarPressure, ev);
        }
      }
      ev.push({ t: "cue", name: "choirmaster.wrongPillar", x: p.x, y: p.y, rate: 1.2, gain: 0.45, trauma: 0.04 });
    }
  }
  if (live && (live.dead || live.hp <= 0) && live.aux !== 2) {
    // Silenced during phrase (or during LAST NOTE inhale/sheet — success path handles that).
    if (e.attack.move === "last_note" && (e.attack.phase === "windup" || e.attack.phase === "active")) {
      // Handled in last-note step as success.
      return;
    }
    choirSilencePillar(w, e, live, ev);
  }
}

function choirInAcousticShadow(w: WorldState, px: number, py: number, e: Enemy): boolean {
  const enc = choirEnc(w);
  if (!enc) return false;
  const shadowId = Number(enc.flags.acousticShadowPillarId);
  if (shadowId < 0) return false;
  // Shadow pillar may be dead — use its last position from the enemy record.
  const shadow = w.enemies.find((o) => o.id === shadowId && o.kind === "choir_pillar");
  if (!shadow) return false;
  // Player is in acoustic shadow if the broken pillar lies between them and the conductor
  // (within a narrow cone behind the pillar relative to the sheet direction).
  const toPillarX = shadow.x - e.x;
  const toPillarY = shadow.y - e.y;
  const toPlayerX = px - e.x;
  const toPlayerY = py - e.y;
  const plen = Math.hypot(toPillarX, toPillarY) || 1;
  // Behind = past the pillar along the same ray, within half-width.
  const along = (toPlayerX * toPillarX + toPlayerY * toPillarY) / plen;
  if (along < plen) return false; // not past the pillar
  const closestX = e.x + (toPillarX / plen) * along;
  const closestY = e.y + (toPillarY / plen) * along;
  const lat = Math.hypot(px - closestX, py - closestY);
  return lat <= CHOIRMASTER.sheetHalfWidth * 1.5 + 12;
}

function choirSheetHitsPlayer(px: number, py: number, e: Enemy, spanIndex: number, pillars: Enemy[]): boolean {
  // 2-tile directional sheet along authored pillar route: conductor → pillar[span].
  if (spanIndex < 0 || spanIndex >= pillars.length) return false;
  const target = pillars[spanIndex];
  if (!target) return false;
  const ax = e.x, ay = e.y;
  const bx = target.x, by = target.y;
  const abx = bx - ax, aby = by - ay;
  const abLen = Math.hypot(abx, aby) || 1;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abLen * abLen)));
  const cx = ax + abx * t, cy = ay + aby * t;
  const dist = Math.hypot(px - cx, py - cy);
  return dist <= CHOIRMASTER.sheetHalfWidth + 10;
}

function choirMaybeBeginLastNote(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const boss = e.boss!;
  if (boss.lastAddPick > 0) return false;
  if (e.attack.cooldown > 0) return false;
  const enc = choirEnc(w);
  if (!enc || !enc.active) return false;
  const liveId = Number(enc.flags.livePillarId);
  if (liveId < 0) return false;
  beginWindup(e, "last_note");
  e.attack.cooldown = CHOIRMASTER.attackCd[boss.phase] ?? CHOIRMASTER.attackCd[3];
  boss.lastAddPick = Math.round(4.5 * 100); // cadence between signatures (BALANCER_TODO)
  boss.spinCount = 0; // sheet span index
  choirSetOutcome(w, e, "pending");
  enc.flags.lastNotePhase = "inhale";
  enc.flags.sheetSpanIndex = 0;
  // Aim toward the live pillar (directional sheet route).
  const live = w.enemies.find((o) => o.id === liveId && o.kind === "choir_pillar");
  if (live) {
    e.attack.lockedAngle = Math.atan2(live.y - e.y, live.x - e.x);
    e.attack.markX = live.x;
    e.attack.markY = live.y;
  }
  ev.push({ t: "cue", name: "choirmaster.lastNote.inhale", x: e.x, y: e.y, rate: 0.65, gain: 0.7, trauma: 0.05 });
  return true;
}

function choirLastNoteLiveBroken(w: WorldState, _e: Enemy): boolean {
  const enc = choirEnc(w);
  if (!enc) return false;
  const liveId = Number(enc.flags.livePillarId);
  if (liveId < 0) return false;
  const live = w.enemies.find((o) => o.id === liveId && o.kind === "choir_pillar");
  return !live || live.dead || live.hp <= 0;
}

function choirLastNoteStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const enc = choirEnc(w);
  // Prefer authored order from windowAddIds for sheet spans.
  const route = choirPillars(w, e);

  if (a.phase === "windup") {
    // INHALE 1.6s
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIRMASTER.lastNoteInhale);
    if (!a.isAimLocked && a.windup >= 0.6) {
      a.isAimLocked = true;
    }
    if (enc) enc.flags.lastNotePhase = "inhale";
    // Success during inhale: silence FIRST live pillar before sheet starts.
    if (choirLastNoteLiveBroken(w, e)) {
      const liveId = Number(enc?.flags.livePillarId ?? -1);
      const live = w.enemies.find((o) => o.id === liveId && o.kind === "choir_pillar");
      if (live && enc) choirSilencePillar(w, e, live, ev);
      choirSetOutcome(w, e, "success");
      enterRecover(e);
      a.time = 0;
      if (enc) enc.flags.lastNotePhase = "punish";
      openBossWindow(e, CHOIRMASTER.lastNotePunish, ev);
      ev.push({ t: "chargeCrash", x: e.x, y: e.y });
      ev.push({ t: "cue", name: "choirmaster.lastNote.punish", x: e.x, y: e.y, rate: 0.55, gain: 0.9, trauma: 0.14 });
      let best: { id: string; d: number } | null = null;
      for (const p of w.players.values()) {
        if (p.isDown || p.isAbsent || p.hp <= 0) continue;
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (!best || d < best.d) best = { id: p.id, d };
      }
      if (best && enc) setEncounterCarrier(enc, best.id);
      return;
    }
    if (a.time >= CHOIRMASTER.lastNoteInhale) {
      a.phase = "active";
      a.time = 0;
      a.windup = 1;
      boss.spinCount = 0;
      if (enc) {
        enc.flags.lastNotePhase = "sheet";
        enc.flags.sheetSpanIndex = 0;
      }
      ev.push({ t: "cue", name: "choirmaster.lastNote.sheet", x: e.x, y: e.y, rate: 0.85, gain: 0.6, trauma: 0.04 });
    }
    return;
  }

  if (a.phase === "active") {
    // SHEET advances ~0.7s per linked span along pillar route.
    a.time += dt;
    if (enc) enc.flags.lastNotePhase = "sheet";
    const span = boss.spinCount;
    if (enc) enc.flags.sheetSpanIndex = span;

    // Success during sheet: silence FIRST live pillar before the sheet reaches it.
    // "Reaches it" = sheet span index has advanced to the live pillar's slot.
    const liveId = Number(enc?.flags.livePillarId ?? -1);
    const liveSlot = route.findIndex((p) => p.id === liveId);
    if (choirLastNoteLiveBroken(w, e) && (liveSlot < 0 || span <= liveSlot)) {
      const live = w.enemies.find((o) => o.id === liveId && o.kind === "choir_pillar");
      if (live && enc) choirSilencePillar(w, e, live, ev);
      choirSetOutcome(w, e, "success");
      enterRecover(e);
      a.time = 0;
      if (enc) enc.flags.lastNotePhase = "punish";
      openBossWindow(e, CHOIRMASTER.lastNotePunish, ev);
      ev.push({ t: "chargeCrash", x: e.x, y: e.y });
      ev.push({ t: "cue", name: "choirmaster.lastNote.punish", x: e.x, y: e.y, rate: 0.55, gain: 0.9, trauma: 0.14 });
      return;
    }

    // Soft sheet pressure on players overlapping the current span (never wipe).
    let anyHit = false;
    let anyShadow = false;
    for (const p of w.players.values()) {
      if (p.isDown || p.isAbsent || p.hp <= 0) continue;
      if (choirInAcousticShadow(w, p.x, p.y, e)) {
        anyShadow = true;
        continue;
      }
      if (choirSheetHitsPlayer(p.x, p.y, e, span, route)) {
        anyHit = true;
        if (p.invuln <= 0) damagePlayer(w, p, CHOIRMASTER.sheetDamage, ev);
      }
    }

    if (a.time >= CHOIRMASTER.lastNoteSpan) {
      a.time = 0;
      boss.spinCount = span + 1;
      if (enc) enc.flags.sheetSpanIndex = boss.spinCount;
      // Sheet finished all spans without success → resolve survival/failure.
      if (boss.spinCount >= Math.max(1, route.length)) {
        enterRecover(e);
        a.time = 0;
        if (enc) enc.flags.lastNotePhase = "punish";
        if (anyShadow && !anyHit) {
          choirSetOutcome(w, e, "survival");
          ev.push({ t: "cue", name: "choirmaster.lastNote.survival", x: e.x, y: e.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
        } else {
          choirSetOutcome(w, e, "failure");
          if (enc) {
            enc.failed = true;
            enc.failureCount += 1;
          }
          ev.push({ t: "cue", name: "choirmaster.lastNote.miss", x: e.x, y: e.y, rate: 0.95, gain: 0.5, trauma: 0.04 });
        }
      } else {
        ev.push({ t: "cue", name: "choirmaster.lastNote.span", x: e.x, y: e.y, rate: 1.0, gain: 0.4, trauma: 0.02 });
      }
    }
    return;
  }

  if (a.phase === "recover") {
    // Voiceless punish / post-resolution settle. Success already opened the window;
    // survival/failure do not. Hold recover for punish duration on success, shorter otherwise.
    a.time += dt;
    if (enc) enc.flags.lastNotePhase = "punish";
    const hold = choirOutcomeIsSuccess(e) ? CHOIRMASTER.lastNotePunish : 0.8;
    if (a.time >= hold) {
      a.phase = "none";
      a.time = 0;
      a.move = "none";
      a.windup = 0;
      a.isAimLocked = false;
      if (enc) enc.flags.lastNotePhase = "idle";
    }
  }
}

function choirOutcomeIsSuccess(e: Enemy): boolean {
  return e.boss!.mirrorLastFamily === 1;
}

function updateChoirmaster(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss!;
  // Activation + pillar plant may happen during entrance grace (no LAST NOTE / aggro yet).
  if (!choirTryActivate(w, e, ev)) {
    // Idle conductor — no global aggro before activation.
    e.attack.cooldown = Math.max(e.attack.cooldown, 0.5);
    return;
  }
  if (e.spawnTimer > 0) return; // fair entrance grace: pillars may be lit, signature waits
  // Tick signature cadence.
  if (boss.lastAddPick > 0) {
    boss.lastAddPick = Math.max(0, boss.lastAddPick - Math.max(1, Math.round(dt * 100)));
  }
  if (e.attack.cooldown > 0) e.attack.cooldown = Math.max(0, e.attack.cooldown - dt);

  choirPillarLoop(w, e, ev);

  if (e.attack.move === "last_note" && e.attack.phase !== "none") {
    choirLastNoteStep(w, e, dt, ev);
    return;
  }
  // Phase roar transitions use shared boss plumbing; otherwise try THE LAST NOTE.
  if (e.attack.phase === "none" && boss.exposed <= 0) {
    choirMaybeBeginLastNote(w, e, ev);
  }
}


// ---- UNDERTOW (F65 STEAL/ESCAPE + THE RIVER COMES BACK) — Batch2B OWNER LOCK ----
// Reverse journey: steal Warm Pulse in deep room → flee SPAWNWARD across ≥2 RoomEdges while
// an untargetable flood advances behind the carrier. Relief vents slow/redirect; alcoves shelter.
// Signature THE RIVER COMES BACK: 1.6s full-width flood tell → 1.2s advancing front through
// current room → 3.5s forced-manifestation punish (±1 tick @20Hz).
// Success = deposit Pulse in highlighted relief vent before front arrives → openBossWindow(3.5).
// Survival = drop Pulse + shelter in marked alcove (no window). Failure = capped hit+KB; never wipe.
// ONE isBossKind = undertow when manifested; warm_pulse / relief_vent / flood_front = mechanics.
// BLACK_TIDE retired — cues use undertow.river* story pattern.

function undertowEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "escape" ? w.encounter : null;
}

function undertowSetOutcome(w: WorldState, e: Enemy, outcome: "idle" | "pending" | "success" | "survival" | "failure"): void {
  const enc = undertowEnc(w);
  if (enc) enc.flags.riverOutcome = outcome;
  const map = { idle: -1, pending: 0, success: 1, survival: 2, failure: 3 } as const;
  e.boss!.mirrorLastFamily = map[outcome];
}

function undertowTryActivate(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = undertowEnc(w);
  if (!enc) return false;
  if (enc.active) {
    if (enc.flags.pulseStolen !== true) undertowEnsurePulseAndVents(w, e, ev);
    return true;
  }
  // Soft approach: any living player enters the deep steal room or pressure radius.
  let near = false;
  const stealRoom = w.dungeon.blueprint?.spawnRoomId ?? enc.currentRoomId;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    const rid = roomIdAt(w.dungeon, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
    if (rid === stealRoom) { near = true; break; }
    if (Math.hypot(p.x - e.x, p.y - e.y) <= UNDERTOW.pressureRadius) { near = true; break; }
  }
  if (!near) return false;
  enc.active = true;
  enc.currentRoomId = stealRoom;
  undertowEnsurePulseAndVents(w, e, ev);
  ev.push({ t: "cue", name: "undertow.activate", x: e.x, y: e.y, rate: 0.75, gain: 0.65, trauma: 0.04 });
  return true;
}

function undertowEnsurePulseAndVents(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = undertowEnc(w);
  if (!enc) return;
  const boss = e.boss!;
  // Plant Warm Pulse once in the deep steal room if missing.
  let pulse = w.enemies.find((o) => o.kind === "warm_pulse" && !o.dead);
  if (!pulse) {
    const room = w.dungeon.rooms.find((r) => r.id === enc.currentRoomId) ?? w.dungeon.rooms[w.dungeon.rooms.length - 1];
    let x = room.cx * TILE + TILE / 2;
    let y = room.cy * TILE + TILE / 2;
    settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.warm_pulse.radius);
    pulse = createEnemy("warm_pulse", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    pulse.hp = pulse.maxHp = UNDERTOW.pulseHp;
    pulse.spawnTimer = 0;
    pulse.aux = 0; // 0 world, 1 carried (hidden), 2 deposited
    w.enemies.push(pulse);
    boss.windowAddIds.push(pulse.id);
    enc.flags.pulseRoomId = enc.currentRoomId;
    enc.flags.pulseDropped = false;
    ev.push({ t: "enemySpawn", eid: pulse.id, kind: pulse.kind, tier: pulse.tier, x: pulse.x, y: pulse.y });
    ev.push({ t: "cue", name: "undertow.pulse.plant", x: pulse.x, y: pulse.y, rate: 1.0, gain: 0.5, trauma: 0.02 });
  }
  // Plant relief vents along reverse objective rooms (skip deep steal room index 0 for deposit mid-route).
  const vents = w.enemies.filter((o) => o.kind === "relief_vent" && !o.dead);
  if (vents.length === 0) {
    const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [enc.currentRoomId];
    const count = Math.min(UNDERTOW.ventsPerRoute, Math.max(2, cps.length));
    for (let i = 0; i < count; i++) {
      const roomId = cps[Math.min(cps.length - 1, i)] ?? enc.currentRoomId;
      const room = w.dungeon.rooms.find((r) => r.id === roomId) ?? w.dungeon.rooms[0];
      const ang = (i / Math.max(1, count)) * Math.PI * 2;
      let x = room.cx * TILE + TILE / 2 + Math.cos(ang) * (TILE * 1.25);
      let y = room.cy * TILE + TILE / 2 + Math.sin(ang) * (TILE * 1.25);
      if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.relief_vent.radius)) {
        x = room.cx * TILE + TILE / 2;
        y = room.cy * TILE + TILE / 2;
        settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.relief_vent.radius);
      }
      const vent = createEnemy("relief_vent", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
        isSummoned: true, players: w.encounterPlayers,
      });
      vent.hp = vent.maxHp = UNDERTOW.ventHp;
      vent.spawnTimer = 0;
      vent.aux = i; // slot index along reverse route
      w.enemies.push(vent);
      boss.windowAddIds.push(vent.id);
      ev.push({ t: "enemySpawn", eid: vent.id, kind: vent.kind, tier: vent.tier, x: vent.x, y: vent.y });
    }
    // Mark first mid-route vent as highlighted deposit target.
    const firstVent = w.enemies.find((o) => o.kind === "relief_vent" && !o.dead && o.aux === 1)
      ?? w.enemies.find((o) => o.kind === "relief_vent" && !o.dead);
    if (firstVent) {
      enc.flags.highlightedVentId = firstVent.id;
      enc.flags.pulseDepositVentId = firstVent.id;
      firstVent.aux = 10; // highlighted
    }
    // Alcove = near-spawn objective room (last reverse checkpoint).
    const alcoveId = cps[Math.min(cps.length - 1, cps.length - 1)] ?? enc.currentRoomId;
    enc.flags.alcoveRoomId = alcoveId;
  }
}

function undertowPulsePickupLoop(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = undertowEnc(w);
  if (!enc || !enc.active) return;
  const pulse = w.enemies.find((o) => o.kind === "warm_pulse" && !o.dead);
  if (!pulse) return;
  // If already carried, stick pulse to carrier and allow drop/pass.
  if (enc.carrierPlayerId) {
    const carrier = w.players.get(enc.carrierPlayerId);
    if (!carrier || carrier.isDown || carrier.isAbsent || carrier.hp <= 0) {
      // Grace → world pickup (never deadlock).
      enc.carrierPlayerId = null;
      enc.flags.pulseDropped = true;
      pulse.aux = 0;
      pulse.x = e.x;
      pulse.y = e.y;
      ev.push({ t: "cue", name: "undertow.pulse.drop", x: pulse.x, y: pulse.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
      return;
    }
    pulse.x = carrier.x;
    pulse.y = carrier.y;
    pulse.aux = 1;
    enc.flags.pulseStolen = true;
    // Sync current room from carrier for reverse journey progress.
    const rid = roomIdAt(w.dungeon, Math.floor(carrier.x / TILE), Math.floor(carrier.y / TILE));
    if (rid >= 0) {
      enc.currentRoomId = rid;
      enc.flags.pulseRoomId = rid;
      const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
      const idx = cps.indexOf(rid);
      if (idx > enc.checkpoint) {
        enc.checkpoint = idx;
        enc.objectiveProgress = Math.min(1, idx / Math.max(1, cps.length - 1));
      }
    }
    return;
  }
  // World pickup: first living player near Pulse steals it → encounter pursuit begins.
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - pulse.x, p.y - pulse.y) < TILE * 1.1) {
      enc.carrierPlayerId = p.id;
      enc.flags.pulseStolen = true;
      enc.flags.pulseDropped = false;
      pulse.aux = 1;
      setEncounterCarrier(enc, p.id);
      ev.push({ t: "cue", name: "undertow.pulse.steal", x: p.x, y: p.y, rate: 0.9, gain: 0.6, trauma: 0.03 });
      // Manifest body remains dormant until River success / final threshold; flood pursuit starts.
      if (enc.flags.riverPhase === "idle") enc.flags.riverPhase = "pursuit";
      break;
    }
  }
}

function undertowInAlcove(w: WorldState, px: number, py: number): boolean {
  const enc = undertowEnc(w);
  if (!enc) return false;
  const alcoveId = Number(enc.flags.alcoveRoomId);
  if (alcoveId < 0) return false;
  const room = w.dungeon.rooms.find((r) => r.id === alcoveId);
  if (!room) return false;
  const cx = room.cx * TILE + TILE / 2;
  const cy = room.cy * TILE + TILE / 2;
  // Marked side alcove: near room edge opposite the chase path (readable shelter pocket).
  const rid = roomIdAt(w.dungeon, Math.floor(px / TILE), Math.floor(py / TILE));
  if (rid !== alcoveId) return false;
  return Math.hypot(px - cx, py - cy) >= UNDERTOW.alcoveHalfWidth;
}

function undertowDepositCheck(w: WorldState, _e: Enemy, ev: SimEvent[]): boolean {
  const enc = undertowEnc(w);
  if (!enc || !enc.carrierPlayerId) return false;
  const ventId = Number(enc.flags.highlightedVentId);
  if (ventId < 0) return false;
  const vent = w.enemies.find((o) => o.id === ventId && o.kind === "relief_vent" && !o.dead);
  const carrier = w.players.get(enc.carrierPlayerId);
  if (!vent || !carrier) return false;
  if (Math.hypot(carrier.x - vent.x, carrier.y - vent.y) < TILE * 1.25) {
    // Deposit success counter.
    const pulse = w.enemies.find((o) => o.kind === "warm_pulse" && !o.dead);
    if (pulse) { pulse.aux = 2; pulse.dead = true; }
    enc.carrierPlayerId = null;
    enc.flags.pulseDepositVentId = vent.id;
    const mask = Number(enc.flags.ventsUsedMask) || 0;
    enc.flags.ventsUsedMask = mask | (1 << (vent.aux & 31));
    enc.objectiveProgress = Math.min(1, enc.objectiveProgress + 0.5);
    ev.push({ t: "cue", name: "undertow.pulse.deposit", x: vent.x, y: vent.y, rate: 0.85, gain: 0.7, trauma: 0.05 });
    return true;
  }
  return false;
}

function undertowMaybeBeginRiver(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = undertowEnc(w);
  const boss = e.boss!;
  if (!enc || !enc.active || enc.flags.pulseStolen !== true) return false;
  if (e.attack.phase !== "none" || boss.exposed > 0) return false;
  if (boss.lastAddPick > 0) return false;
  if (e.attack.cooldown > 0) return false;
  beginWindup(e, "river_comes_back");
  e.attack.cooldown = UNDERTOW.attackCd[boss.phase] ?? UNDERTOW.attackCd[3];
  boss.lastAddPick = Math.round(4.0 * 100); // cadence between Rivers
  undertowSetOutcome(w, e, "pending");
  enc.flags.riverPhase = "tell";
  enc.flags.floodProgress = 0;
  // Ensure a flood_front marker exists (untargetable).
  let front = w.enemies.find((o) => o.kind === "flood_front" && !o.dead);
  if (!front) {
    front = createEnemy("flood_front", e.x, e.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    front.spawnTimer = 0;
    front.hp = front.maxHp = 9999;
    w.enemies.push(front);
    boss.windowAddIds.push(front.id);
  }
  // Anchor flood behind carrier / deep side of current room.
  const carrier = enc.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
  if (carrier) {
    front.x = carrier.x - 80;
    front.y = carrier.y;
  } else {
    front.x = e.x;
    front.y = e.y;
  }
  const bp = w.dungeon.blueprint;
  if (bp && bp.chaseEdgeIds.length > 0) {
    enc.flags.floodFrontEdgeId = bp.chaseEdgeIds[Math.min(enc.checkpoint, bp.chaseEdgeIds.length - 1)];
    enc.routeEdgeId = Number(enc.flags.floodFrontEdgeId);
  }
  ev.push({ t: "cue", name: "undertow.river.tell", x: e.x, y: e.y, rate: 0.65, gain: 0.7, trauma: 0.05 });
  return true;
}

function undertowRiverStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const enc = undertowEnc(w);
  if (a.phase === "windup") {
    // 1.6s full-width flood tell
    a.time += dt;
    a.windup = Math.min(1, a.time / UNDERTOW.riverTell);
    if (!a.isAimLocked && a.windup >= 0.6) {
      a.isAimLocked = true;
      const carrier = enc?.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
      if (carrier) { a.markX = carrier.x; a.markY = carrier.y; a.lockedAngle = Math.atan2(carrier.y - e.y, carrier.x - e.x); }
      else { a.markX = e.x; a.markY = e.y; }
    }
    if (enc) enc.flags.riverPhase = "tell";
    // Success can fire during tell if Pulse deposited in highlighted vent.
    if (undertowDepositCheck(w, e, ev)) {
      undertowSetOutcome(w, e, "success");
      if (enc) enc.flags.riverPhase = "punish";
      openBossWindow(e, UNDERTOW.riverPunish, ev);
      enc!.flags.manifestCount = Number(enc!.flags.manifestCount) + 1;
      a.phase = "recover";
      a.time = 0;
      ev.push({ t: "cue", name: "undertow.river.success", x: e.x, y: e.y, rate: 0.8, gain: 0.75, trauma: 0.08 });
      return;
    }
    if (a.time >= UNDERTOW.riverTell) {
      a.phase = "active";
      a.time = 0;
      a.windup = 1;
      if (enc) { enc.flags.riverPhase = "front"; enc.flags.floodProgress = 0; }
      ev.push({ t: "cue", name: "undertow.river.front", x: e.x, y: e.y, rate: 0.9, gain: 0.65, trauma: 0.04 });
    }
    return;
  }
  if (a.phase === "active") {
    // 1.2s advancing front through current room
    a.time += dt;
    if (enc) {
      enc.flags.riverPhase = "front";
      enc.flags.floodProgress = Math.min(1, a.time / UNDERTOW.riverFront);
    }
    const front = w.enemies.find((o) => o.kind === "flood_front" && !o.dead);
    const carrier = enc?.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
    if (front && carrier) {
      // Advance flood toward carrier across route width (not radial).
      const ang = Math.atan2(carrier.y - front.y, carrier.x - front.x);
      front.x += Math.cos(ang) * UNDERTOW.floodSpeed * dt;
      front.y += Math.sin(ang) * UNDERTOW.floodSpeed * dt;
    }
    // Success during front.
    if (undertowDepositCheck(w, e, ev)) {
      undertowSetOutcome(w, e, "success");
      if (enc) enc.flags.riverPhase = "punish";
      openBossWindow(e, UNDERTOW.riverPunish, ev);
      enc!.flags.manifestCount = Number(enc!.flags.manifestCount) + 1;
      a.phase = "recover";
      a.time = 0;
      ev.push({ t: "cue", name: "undertow.river.success", x: e.x, y: e.y, rate: 0.8, gain: 0.75, trauma: 0.08 });
      return;
    }
    if (a.time >= UNDERTOW.riverFront) {
      // Resolve survival vs soft failure.
      let survival = false;
      if (enc && enc.carrierPlayerId) {
        // Drop + alcove = survival fallback.
        const carrier = w.players.get(enc.carrierPlayerId);
        if (carrier && undertowInAlcove(w, carrier.x, carrier.y)) {
          survival = true;
          const pulse = w.enemies.find((o) => o.kind === "warm_pulse" && !o.dead);
          if (pulse) { pulse.aux = 0; pulse.x = carrier.x; pulse.y = carrier.y; }
          enc.carrierPlayerId = null;
          enc.flags.pulseDropped = true;
          // Bounded checkpoint loss.
          enc.checkpoint = Math.max(0, enc.checkpoint - 1);
          enc.objectiveProgress = Math.max(0, enc.objectiveProgress - 0.15);
        }
      } else if (enc) {
        // Already dropped — if any living player shelters in alcove, count survival.
        for (const p of w.players.values()) {
          if (p.isDown || p.isAbsent || p.hp <= 0) continue;
          if (undertowInAlcove(w, p.x, p.y)) { survival = true; break; }
        }
      }
      if (survival) {
        undertowSetOutcome(w, e, "survival");
        if (enc) enc.flags.riverPhase = "pursuit";
        ev.push({ t: "cue", name: "undertow.river.survival", x: e.x, y: e.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
        enterIdle(e);
        return;
      }
      // Soft failure: capped hit+KB; advance pursuit one checkpoint; never wipe.
      undertowSetOutcome(w, e, "failure");
      if (enc) {
        enc.failed = true;
        enc.failureCount += 1;
        enc.checkpoint = Math.min((w.dungeon.blueprint?.objectiveRoomIds.length ?? 1) - 1, enc.checkpoint + 1);
        enc.flags.riverPhase = "pursuit";
        enc.flags.floodProgress = 1;
      }
      for (const p of w.players.values()) {
        if (p.isDown || p.isAbsent || p.hp <= 0) continue;
        // Only punish players not in alcove (readable). Soft capped — never wipe.
        if (undertowInAlcove(w, p.x, p.y)) continue;
        damagePlayer(w, p, UNDERTOW.riverFrontDamage, ev);
      }
      ev.push({ t: "cue", name: "undertow.river.miss", x: e.x, y: e.y, rate: 0.95, gain: 0.55, trauma: 0.05 });
      enterIdle(e);
      return;
    }
    return;
  }
  if (a.phase === "recover") {
    // 3.5s forced-manifestation punish window (success path only).
    a.time += dt;
    if (enc) enc.flags.riverPhase = "punish";
    if (a.time >= UNDERTOW.riverPunish) {
      if (enc) enc.flags.riverPhase = "pursuit";
      enterIdle(e);
      // Custom completion: Pulse deposited + at least one manifestation resolved.
      if (enc && Number(enc.flags.manifestCount) > 0 && Number(enc.flags.pulseDepositVentId) >= 0) {
        // Require boss HP pressure OR second deposit/progress — soft clear when manifested body dies
        // handled by normal kill path; here mark objective progress.
        enc.objectiveProgress = Math.min(1, Math.max(enc.objectiveProgress, 0.75));
      }
    }
    return;
  }
}

function updateUndertow(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss!;
  if (!undertowTryActivate(w, e, ev)) {
    e.attack.cooldown = Math.max(e.attack.cooldown, 0.5);
    return;
  }
  if (e.spawnTimer > 0) {
    undertowEnsurePulseAndVents(w, e, ev);
    return;
  }
  if (boss.lastAddPick > 0) {
    boss.lastAddPick = Math.max(0, boss.lastAddPick - Math.max(1, Math.round(dt * 100)));
  }
  if (e.attack.cooldown > 0) e.attack.cooldown = Math.max(0, e.attack.cooldown - dt);

  undertowPulsePickupLoop(w, e, ev);

  if (e.attack.move === "river_comes_back" && e.attack.phase !== "none") {
    undertowRiverStep(w, e, dt, ev);
    return;
  }

  // Light presence chase while Pulse is stolen (manifested body can be damaged anytime once active).
  if (enc_alive_carrier(w) && findTarget(w, e.x, e.y)) {
    const ang = chaseAngle(w, e);
    applyChaseStep(w, e, dt, ang, e.speed * 0.45 * dt);
  }

  // Crossing spawn threshold with Pulse deposited + manifestation done → custom completion.
  const enc = undertowEnc(w);
  if (enc && Number(enc.flags.manifestCount) > 0 && Number(enc.flags.pulseDepositVentId) >= 0) {
    if (e.dead || e.hp <= 0) {
      completeEncounter(enc);
      grantEncounterCompletionReward(w);
    }
  }

  if (e.attack.phase === "none" && boss.exposed <= 0 && enc && enc.flags.pulseStolen === true) {
    undertowMaybeBeginRiver(w, e, ev);
  }
}

function enc_alive_carrier(w: WorldState): boolean {
  const enc = undertowEnc(w);
  if (!enc || !enc.carrierPlayerId) return false;
  const p = w.players.get(enc.carrierPlayerId);
  return !!p && !p.isDown && !p.isAbsent && p.hp > 0;
}

// ---- CLAIMANT (F70 PASS-THE-CLAIM + ALL THINGS OWED) — Batch3A OWNER LOCK ----
// Compact coordination arena (structureKind 'arena'; NOT a RoomEdge chase). One player carries the
// claim-token (the marked target); carrier fire cannot break the Claimant's guard (see damageEnemy),
// so the team must deliberately PASS to a non-carrier. Three correct passes / socket deposits
// (checkpoint 0..3) bait an overcommit → ALL THINGS OWED: 1.4s angular crown/beam tell → aim locks
// at 0.84s (60% of tell) → ONE socket lights → 0.6s descent → 3.0s kneel punish. Success = deposit
// the token into the lit socket after lock and before impact → the crown hits an empty socket,
// shatters → openBossWindow(3.0). Survival = carrier dashes perpendicular out of the crown-lane
// (keeps token, no window). Failure = capped hit to the carrier; anti-one-shot holds; never a wipe.
// ONE isBossKind claimant; claim_token / claim_socket = mechanics. CROWNFALL retired — cues use the
// claimant.owed* story pattern. Outcome rides boss.mirrorLastFamily (-1 idle,0 pending,1 success,
// 2 survival,3 failure), same as the other Batch bosses.
type ClaimantOutcome = "idle" | "pending" | "success" | "survival" | "failure";

function claimantEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "arena" && "owedPhase" in w.encounter.flags
    ? w.encounter : null;
}

function claimantSetOutcome(w: WorldState, e: Enemy, outcome: ClaimantOutcome): void {
  const enc = claimantEnc(w);
  if (enc) enc.flags.owedOutcome = outcome;
  const map = { idle: -1, pending: 0, success: 1, survival: 2, failure: 3 } as const;
  e.boss!.mirrorLastFamily = map[outcome];
}

function claimantNearestSocket(w: WorldState, x: number, y: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const o of w.enemies) {
    if (o.kind !== "claim_socket" || o.dead) continue;
    const d = (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function claimantClearHighlight(w: WorldState, enc: EncounterState | null): void {
  for (const o of w.enemies) {
    if (o.kind === "claim_socket" && o.aux === 10) o.aux = 0;
  }
  if (enc) enc.flags.highlightedSocketId = -1;
}

function claimantEnsureTokenAndSockets(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = claimantEnc(w);
  if (!enc || enc.flags.tokenPlanted === true) return;
  const boss = e.boss!;
  const room = w.dungeon.rooms.find((r) => r.id === enc.currentRoomId) ?? w.dungeon.rooms[w.dungeon.rooms.length - 1];
  const cx = room.cx * TILE + TILE / 2;
  const cy = room.cy * TILE + TILE / 2;
  // Sockets ring the arena so the coordination space is symmetric on every side (fair reach).
  for (let i = 0; i < CLAIMANT.socketCount; i++) {
    const ang = (i / CLAIMANT.socketCount) * Math.PI * 2;
    let x = cx + Math.cos(ang) * (TILE * 3);
    let y = cy + Math.sin(ang) * (TILE * 3);
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.claim_socket.radius)) {
      x = cx + Math.cos(ang) * (TILE * 2);
      y = cy + Math.sin(ang) * (TILE * 2);
      settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.claim_socket.radius);
    }
    const sock = createEnemy("claim_socket", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    sock.hp = sock.maxHp = CLAIMANT.socketHp;
    sock.spawnTimer = 0;
    sock.aux = i; // slot index (10 = highlighted during the Owed cast)
    w.enemies.push(sock);
    boss.windowAddIds.push(sock.id);
    ev.push({ t: "enemySpawn", eid: sock.id, kind: sock.kind, tier: sock.tier, x: sock.x, y: sock.y });
  }
  // Token starts as a world-pickup near the arena center (never a boss core).
  let tx = cx + TILE;
  let ty = cy;
  settleSpawnPoint(w, tx, ty, ENEMY_ARCHETYPES.claim_token.radius);
  const token = createEnemy("claim_token", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  token.hp = token.maxHp = CLAIMANT.tokenHp;
  token.spawnTimer = 0;
  token.aux = 0; // 0 world, 1 carried, 2 socketed
  w.enemies.push(token);
  boss.windowAddIds.push(token.id);
  ev.push({ t: "enemySpawn", eid: token.id, kind: token.kind, tier: token.tier, x: token.x, y: token.y });
  ev.push({ t: "cue", name: "claimant.owed.plant", x: token.x, y: token.y, rate: 1.0, gain: 0.5, trauma: 0.02 });
  enc.flags.tokenPlanted = true;
}

function claimantTryActivate(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = claimantEnc(w);
  if (!enc) return false;
  if (enc.active) {
    if (enc.flags.tokenPlanted !== true) claimantEnsureTokenAndSockets(w, e, ev);
    return true;
  }
  const arenaRoom = w.dungeon.blueprint?.spawnRoomId ?? enc.currentRoomId;
  let near = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    const rid = roomIdAt(w.dungeon, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
    if (rid === arenaRoom) { near = true; break; }
    if (Math.hypot(p.x - e.x, p.y - e.y) <= CLAIMANT.pressureRadius) { near = true; break; }
  }
  if (!near) return false;
  enc.active = true;
  enc.currentRoomId = arenaRoom;
  claimantEnsureTokenAndSockets(w, e, ev);
  ev.push({ t: "cue", name: "claimant.activate", x: e.x, y: e.y, rate: 0.75, gain: 0.65, trauma: 0.04 });
  return true;
}

function claimantCountPass(enc: EncounterState, ev: SimEvent[], x: number, y: number): void {
  const next = Math.min(CLAIMANT.passesToOvercommit, Number(enc.flags.passesCompleted) + 1);
  enc.flags.passesCompleted = next;
  enc.flags.passCount = Number(enc.flags.passCount) + 1;
  enc.checkpoint = next;
  enc.objectiveProgress = Math.min(1, next / CLAIMANT.passesToOvercommit);
  ev.push({ t: "cue", name: "claimant.owed.pass", x, y, rate: 0.9, gain: 0.55, trauma: 0.02 });
}

function claimantTokenLoop(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = claimantEnc(w);
  if (!enc || !enc.active) return;
  const token = w.enemies.find((o) => o.kind === "claim_token" && !o.dead);
  if (!token) return;
  const isCasting = e.attack.move === "all_things_owed" && e.attack.phase !== "none";

  if (enc.carrierPlayerId) {
    const carrier = w.players.get(enc.carrierPlayerId);
    if (!carrier || carrier.isDown || carrier.isAbsent || carrier.hp <= 0) {
      // Absent carrier → world pickup after grace (never deadlock).
      enc.carrierPlayerId = null;
      setEncounterCarrier(enc, null);
      enc.flags.tokenDropped = true;
      token.aux = 0;
      token.x = e.x;
      token.y = e.y;
      ev.push({ t: "cue", name: "claimant.owed.drop", x: token.x, y: token.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
      return;
    }
    token.x = carrier.x;
    token.y = carrier.y;
    token.aux = 1;
    enc.flags.tokenDropped = false;
    if (!isCasting) {
      // Coop PASS: a DIFFERENT living player within reach receives the token (deliberate pass).
      for (const p of w.players.values()) {
        if (p.id === carrier.id) continue;
        if (p.isDown || p.isAbsent || p.hp <= 0) continue;
        if (Math.hypot(p.x - carrier.x, p.y - carrier.y) < TILE * 1.1) {
          enc.carrierPlayerId = p.id;
          setEncounterCarrier(enc, p.id);
          claimantCountPass(enc, ev, p.x, p.y);
          return;
        }
      }
      // Solo DEPOSIT: carrier deposits into any socket to count a pass (no partner needed), then the
      // token re-emerges at the socket as a world-pickup so the loop continues.
      const sock = claimantNearestSocket(w, carrier.x, carrier.y);
      if (sock && Math.hypot(carrier.x - sock.x, carrier.y - sock.y) < CLAIMANT.depositRadius) {
        claimantCountPass(enc, ev, sock.x, sock.y);
        token.aux = 0;
        token.x = sock.x;
        token.y = sock.y;
        enc.carrierPlayerId = null;
        setEncounterCarrier(enc, null);
        enc.flags.tokenDropped = true;
      }
    }
    return;
  }
  // World pickup: first living player near the token carries it.
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - token.x, p.y - token.y) < TILE * 1.1) {
      enc.carrierPlayerId = p.id;
      setEncounterCarrier(enc, p.id);
      enc.flags.tokenDropped = false;
      token.aux = 1;
      ev.push({ t: "cue", name: "claimant.owed.take", x: p.x, y: p.y, rate: 0.9, gain: 0.55, trauma: 0.02 });
      break;
    }
  }
}

function claimantCarrierAtLitSocket(w: WorldState): boolean {
  const enc = claimantEnc(w);
  if (!enc || !enc.carrierPlayerId) return false;
  const sockId = Number(enc.flags.highlightedSocketId);
  if (sockId < 0) return false;
  const sock = w.enemies.find((o) => o.id === sockId && o.kind === "claim_socket" && !o.dead);
  const carrier = w.players.get(enc.carrierPlayerId);
  if (!sock || !carrier) return false;
  return Math.hypot(carrier.x - sock.x, carrier.y - sock.y) < CLAIMANT.depositRadius;
}

function claimantOwedSuccess(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = claimantEnc(w);
  const a = e.attack;
  // The token drops into the lit socket → the crown hits an EMPTY socket, shatters → boss kneels.
  if (enc) {
    const sockId = Number(enc.flags.highlightedSocketId);
    const sock = w.enemies.find((o) => o.id === sockId && o.kind === "claim_socket" && !o.dead);
    const token = w.enemies.find((o) => o.kind === "claim_token" && !o.dead);
    if (sock && token) { token.aux = 2; token.x = sock.x; token.y = sock.y; enc.flags.tokenSocketId = sock.id; }
    enc.carrierPlayerId = null;
    setEncounterCarrier(enc, null);
    enc.flags.tokenDropped = false;
    enc.flags.owedPhase = "punish";
  }
  claimantSetOutcome(w, e, "success");
  openBossWindow(e, CLAIMANT.owedPunish, ev);
  claimantClearHighlight(w, enc);
  a.phase = "recover";
  a.time = 0;
  ev.push({ t: "cue", name: "claimant.owed.success", x: e.x, y: e.y, rate: 0.8, gain: 0.75, trauma: 0.08 });
}

function claimantOutOfLane(e: Enemy, a: Enemy["attack"], px: number, py: number): boolean {
  // Perpendicular distance from the elongated crown-lane axis (boss → locked mark). A carrier who
  // dashes perpendicular beyond the lane half-width is clear (survival); the lane is NOT circular.
  const dx = px - e.x;
  const dy = py - e.y;
  const perp = Math.abs(-Math.sin(a.lockedAngle) * dx + Math.cos(a.lockedAngle) * dy);
  return perp > CLAIMANT.laneHalfWidth;
}

function claimantMaybeBeginOwed(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = claimantEnc(w);
  const boss = e.boss!;
  if (!enc || !enc.active) return false;
  if (e.attack.phase !== "none" || boss.exposed > 0) return false;
  const overcommit = Number(enc.flags.passesCompleted) >= CLAIMANT.passesToOvercommit;
  if (e.attack.cooldown > 0 && !overcommit) return false;
  const carrier = enc.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
  if (!carrier || carrier.isDown || carrier.isAbsent || carrier.hp <= 0) return false;
  beginWindup(e, "all_things_owed");
  e.attack.cooldown = CLAIMANT.attackCd[boss.phase] ?? CLAIMANT.attackCd[3];
  claimantSetOutcome(w, e, "pending");
  enc.flags.owedPhase = "tell";
  enc.flags.aimLockedAt = 0;
  enc.flags.highlightedSocketId = -1; // the socket lights only AFTER the aim lock
  // The passes are SPENT to bait the overcommit — reset the count for the next cycle.
  enc.flags.passesCompleted = 0;
  enc.checkpoint = 0;
  if (overcommit) {
    ev.push({ t: "cue", name: "claimant.owed.overcommit", x: e.x, y: e.y, rate: 0.9, gain: 0.84, trauma: 0.03 });
  }
  // tell/lock/descent ride WAVE_TELLS (claimant.all_things_owed) — no duplicate sim cue.
  return true;
}

function claimantOwedStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const enc = claimantEnc(w);
  const lockAt = CLAIMANT.owedTell * CLAIMANT.owedLockFrac; // 0.84s
  if (a.phase === "windup") {
    // 1.4s angular crown/beam tell; aim locks at 0.84s.
    a.time += dt;
    a.windup = Math.min(1, a.time / CLAIMANT.owedTell);
    if (!a.isAimLocked && a.time >= lockAt) {
      a.isAimLocked = true;
      const carrier = enc?.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
      if (carrier) { a.markX = carrier.x; a.markY = carrier.y; a.lockedAngle = Math.atan2(carrier.y - e.y, carrier.x - e.x); }
      else { a.markX = e.x; a.markY = e.y; }
      if (enc) {
        enc.flags.owedPhase = "locked";
        enc.flags.aimLockedAt = a.time;
        // ONE socket lights — the nearest to the locked carrier mark (reachable = fair).
        const sock = claimantNearestSocket(w, a.markX, a.markY);
        if (sock) {
          sock.aux = 10;
          enc.flags.highlightedSocketId = sock.id;
          ev.push({ t: "cue", name: "claimant.owed.socket", x: sock.x, y: sock.y, rate: 1.0, gain: 0.72, trauma: 0.02 });
        }
      }
    } else if (enc && !a.isAimLocked) {
      enc.flags.owedPhase = "tell";
    }
    // Success can fire once the socket is lit (after lock), through the rest of the tell.
    if (a.isAimLocked && claimantCarrierAtLitSocket(w)) { claimantOwedSuccess(w, e, ev); return; }
    if (a.time >= CLAIMANT.owedTell) {
      a.phase = "active";
      a.time = 0;
      a.windup = 1;
      if (enc) enc.flags.owedPhase = "descent";
      // descent voiced by WAVE_TELLS active → claimant.owedDescent
    }
    return;
  }
  if (a.phase === "active") {
    // 0.6s descent — the crown falls along the locked lane.
    a.time += dt;
    if (enc) enc.flags.owedPhase = "descent";
    if (claimantCarrierAtLitSocket(w)) { claimantOwedSuccess(w, e, ev); return; }
    if (a.time >= CLAIMANT.owedDescent) {
      const carrier = enc?.carrierPlayerId ? w.players.get(enc.carrierPlayerId) : null;
      // Survival: carrier dashed perpendicular out of the lane (keeps token). No carrier in lane
      // (token passed/socketed away) also resolves without punish.
      const survival = !carrier || claimantOutOfLane(e, a, carrier.x, carrier.y);
      if (survival) {
        claimantSetOutcome(w, e, "survival");
        if (enc) enc.flags.owedPhase = "idle";
        claimantClearHighlight(w, enc);
        ev.push({ t: "cue", name: "claimant.owed.survival", x: e.x, y: e.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
        enterIdle(e);
        return;
      }
      // Soft failure: capped hit to the carrier; anti-one-shot holds; never a wipe.
      claimantSetOutcome(w, e, "failure");
      if (enc) { enc.failed = true; enc.failureCount += 1; enc.flags.owedPhase = "idle"; }
      if (carrier) damagePlayer(w, carrier, CLAIMANT.owedFailDamage, ev);
      claimantClearHighlight(w, enc);
      ev.push({ t: "cue", name: "claimant.owed.miss", x: e.x, y: e.y, rate: 0.95, gain: 0.55, trauma: 0.05 });
      enterIdle(e);
      return;
    }
    return;
  }
  if (a.phase === "recover") {
    // 3.0s kneel punish (success path only) — runs alongside the exposed window.
    a.time += dt;
    if (enc) enc.flags.owedPhase = "punish";
    if (a.time >= CLAIMANT.owedPunish) {
      if (enc) enc.flags.owedPhase = "idle";
      enterIdle(e);
    }
    return;
  }
}

function updateClaimant(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss!;
  if (!claimantTryActivate(w, e, ev)) {
    e.attack.cooldown = Math.max(e.attack.cooldown, 0.5);
    return;
  }
  if (e.spawnTimer > 0) {
    claimantEnsureTokenAndSockets(w, e, ev);
    return;
  }
  if (e.attack.cooldown > 0) e.attack.cooldown = Math.max(0, e.attack.cooldown - dt);

  claimantTokenLoop(w, e, ev);

  if (e.attack.move === "all_things_owed" && e.attack.phase !== "none") {
    claimantOwedStep(w, e, dt, ev);
    return;
  }

  // Light presence while guarded: the Claimant tracks the marked carrier (never a global aggro
  // rush — the compact arena is about the pass loop, not a chase).
  if (findTarget(w, e.x, e.y)) {
    const ang = chaseAngle(w, e);
    applyChaseStep(w, e, dt, ang, e.speed * 0.4 * dt);
  }

  if (e.attack.phase === "none" && boss.exposed <= 0) {
    claimantMaybeBeginOwed(w, e, ev);
  }
}

// ---- THE WAKE (F80 PROTECT/ADVANCE + THE LAST PROCESSION) — Batch3B OWNER LOCK ----
// Cross-room escort/convoy (structureKind 'escort'; a RoomEdge graph). An autonomous last-light
// convoy (warm_bier) advances FORWARD across ≥2 RoomEdges (origin → thresholds → exit) inside a
// continuous warmth corridor (the convoy aura). The team PROTECTs the convoy: stay in the aura and
// clear the ONE highlighted blocker before each threshold while the untargetable dark front
// (shadow_front) closes from behind. Signature THE LAST PROCESSION: 1.5s blackout/flood tell → the
// dark front follows the convoy to the threshold (moving-front, capped at frontMaxDuration) → 4.0s
// light-bound manifestation punish (±1 tick @20Hz). Success = protected (blocker cleared + a player
// in the aura) → the convoy crosses on-beat → the Wake is forced into light → openBossWindow(4.0);
// crossing the FINAL threshold custom-completes the floor. Survival = nobody in the dark-front lane
// (all in a side shelter) → the convoy stalls, no window. Failure = capped hit to players caught in
// the lane + bounded warmth/progress loss; anti-one-shot holds; never a wipe/soft-lock. ONE
// isBossKind wake; warm_bier / convoy_blocker / shadow_front = mechanics. NIGHTFALL_PROCESSION
// retired — cues use the wake.procession* story pattern. Outcome rides boss.mirrorLastFamily
// (-1 idle, 0 pending, 1 success, 2 survival, 3 failure), same as the other Batch bosses.
type WakeOutcome = "idle" | "pending" | "success" | "survival" | "failure";

function wakeEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "escort" ? w.encounter : null;
}

function wakeSetOutcome(w: WorldState, e: Enemy, outcome: WakeOutcome): void {
  const enc = wakeEnc(w);
  if (enc) enc.flags.processionOutcome = outcome;
  const map = { idle: -1, pending: 0, success: 1, survival: 2, failure: 3 } as const;
  e.boss!.mirrorLastFamily = map[outcome];
}

function wakeRoomCenter(w: WorldState, roomId: number): { x: number; y: number } {
  const room = w.dungeon.rooms.find((r) => r.id === roomId) ?? w.dungeon.rooms[w.dungeon.rooms.length - 1];
  return { x: room.cx * TILE + TILE / 2, y: room.cy * TILE + TILE / 2 };
}

// The convoy's current segment: from objective room[thresholdIndex] toward room[thresholdIndex+1].
function wakeSegment(w: WorldState, enc: EncounterState): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const obj = w.dungeon.blueprint?.objectiveRoomIds ?? [enc.currentRoomId];
  const ti = Math.max(0, Math.min(obj.length - 2, Number(enc.flags.thresholdIndex)));
  return { from: wakeRoomCenter(w, obj[ti]), to: wakeRoomCenter(w, obj[ti + 1]) };
}

function wakeBier(w: WorldState): Enemy | null {
  return w.enemies.find((o) => o.kind === "warm_bier" && !o.dead) ?? null;
}

// Position the bier by lerping the current segment at convoyProgress (the convoy is autonomous).
function wakePlaceBier(w: WorldState, enc: EncounterState): void {
  const bier = wakeBier(w);
  if (!bier) return;
  const seg = wakeSegment(w, enc);
  const t = Math.max(0, Math.min(1, Number(enc.flags.convoyProgress)));
  bier.x = seg.from.x + (seg.to.x - seg.from.x) * t;
  bier.y = seg.from.y + (seg.to.y - seg.from.y) * t;
  const rid = roomIdAt(w.dungeon, Math.floor(bier.x / TILE), Math.floor(bier.y / TILE));
  if (rid >= 0) enc.currentRoomId = rid;
}

// The untargetable dark front trails the convoy from behind; during the front phase it closes in.
function wakePlaceShadowFront(w: WorldState, enc: EncounterState, closing: boolean): void {
  const front = w.enemies.find((o) => o.kind === "shadow_front" && !o.dead);
  const bier = wakeBier(w);
  if (!front || !bier) return;
  const seg = wakeSegment(w, enc);
  const ang = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x);
  const lag = closing ? TILE * 1.2 : TILE * 2.5; // closes from behind during the moving-front
  front.x = bier.x - Math.cos(ang) * lag;
  front.y = bier.y - Math.sin(ang) * lag;
  enc.flags.shadowBehind = true;
}

function wakeHighlightBlockerFor(w: WorldState, enc: EncounterState, thresholdIndex: number): void {
  let id = -1;
  for (const o of w.enemies) {
    if (o.kind !== "convoy_blocker") continue;
    if (!o.dead && o.aux === thresholdIndex) id = o.id;
  }
  enc.flags.highlightedBlockerId = id;
}

function wakeEnsureConvoy(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = wakeEnc(w);
  if (!enc || enc.flags.convoyPlanted === true) return;
  const boss = e.boss!;
  const obj = w.dungeon.blueprint?.objectiveRoomIds ?? [enc.currentRoomId];
  const origin = wakeRoomCenter(w, obj[0] ?? enc.currentRoomId);
  // The convoy body starts at the origin — the continuous warmth corridor the team escorts.
  let bx = origin.x + TILE;
  let by = origin.y;
  settleSpawnPoint(w, bx, by, ENEMY_ARCHETYPES.warm_bier.radius);
  const bier = createEnemy("warm_bier", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  bier.hp = bier.maxHp = WAKE.bierHp;
  bier.spawnTimer = 0;
  bier.aux = 0;
  w.enemies.push(bier);
  boss.windowAddIds.push(bier.id);
  ev.push({ t: "enemySpawn", eid: bier.id, kind: bier.kind, tier: bier.tier, x: bier.x, y: bier.y });
  ev.push({ t: "cue", name: "wake.procession.plant", x: bier.x, y: bier.y, rate: 1.0, gain: 0.5, trauma: 0.02 });
  // One blocker per threshold, planted at the room the convoy enters when it crosses (aux = index).
  for (let i = 0; i < WAKE.thresholdCount; i++) {
    const c = wakeRoomCenter(w, obj[Math.min(obj.length - 1, i + 1)] ?? enc.currentRoomId);
    let x = c.x;
    let y = c.y - TILE * 1.5;
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.convoy_blocker.radius)) {
      x = c.x; y = c.y;
      settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES.convoy_blocker.radius);
    }
    const blk = createEnemy("convoy_blocker", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    blk.hp = blk.maxHp = WAKE.blockerHp;
    blk.spawnTimer = 0;
    blk.aux = i; // the threshold this blocker gates
    w.enemies.push(blk);
    boss.windowAddIds.push(blk.id);
    ev.push({ t: "enemySpawn", eid: blk.id, kind: blk.kind, tier: blk.tier, x: blk.x, y: blk.y });
  }
  // The untargetable dark front trails the convoy from behind.
  const front = createEnemy("shadow_front", origin.x - TILE * 2.5, origin.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  front.spawnTimer = 0;
  front.hp = front.maxHp = 9999;
  w.enemies.push(front);
  boss.windowAddIds.push(front.id);
  enc.flags.convoyPlanted = true;
  enc.flags.thresholdIndex = 0;
  wakeHighlightBlockerFor(w, enc, 0);
}

function wakeTryActivate(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const enc = wakeEnc(w);
  if (!enc) return false;
  if (enc.active) {
    if (enc.flags.convoyPlanted !== true) wakeEnsureConvoy(w, e, ev);
    return true;
  }
  const originRoom = w.dungeon.blueprint?.spawnRoomId ?? enc.currentRoomId;
  let near = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    const rid = roomIdAt(w.dungeon, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
    if (rid === originRoom) { near = true; break; }
    if (Math.hypot(p.x - e.x, p.y - e.y) <= WAKE.pressureRadius) { near = true; break; }
  }
  if (!near) return false;
  enc.active = true;
  enc.currentRoomId = originRoom;
  enc.flags.processionPhase = "advance";
  wakeEnsureConvoy(w, e, ev);
  ev.push({ t: "cue", name: "wake.activate", x: e.x, y: e.y, rate: 0.75, gain: 0.65, trauma: 0.04 });
  return true;
}

// The convoy is PROTECTED for the current threshold when the highlighted blocker is cleared AND at
// least one living player rides inside the warmth corridor (the aura) around the bier.
function wakeConvoyProtected(w: WorldState, enc: EncounterState | null): boolean {
  if (!enc) return false;
  const blkId = Number(enc.flags.highlightedBlockerId);
  const blk = blkId >= 0 ? w.enemies.find((o) => o.id === blkId && o.kind === "convoy_blocker" && !o.dead) : undefined;
  if (blk) return false; // the highlighted blocker still stands — not clear
  const bier = wakeBier(w);
  if (!bier) return false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - bier.x, p.y - bier.y) <= WAKE.auraRadius) return true;
  }
  return false;
}

// A player is in the dark-front lane when within laneHalfWidth perpendicular of the convoy axis and
// within reach of the bier; a side shelter beyond the lane keeps them safe (the convoy then stalls).
function wakeInLane(w: WorldState, enc: EncounterState, px: number, py: number): boolean {
  const bier = wakeBier(w);
  if (!bier) return false;
  const seg = wakeSegment(w, enc);
  const ang = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x);
  const dx = px - bier.x;
  const dy = py - bier.y;
  if (Math.hypot(dx, dy) > WAKE.auraRadius * 2) return false;
  const perp = Math.abs(-Math.sin(ang) * dx + Math.cos(ang) * dy);
  return perp <= WAKE.laneHalfWidth;
}

function wakeAnyInLane(w: WorldState, enc: EncounterState): boolean {
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (wakeInLane(w, enc, p.x, p.y)) return true;
  }
  return false;
}

function wakeProcessionSuccess(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const enc = wakeEnc(w);
  const a = e.attack;
  if (enc) {
    const ti = Number(enc.flags.thresholdIndex);
    enc.flags.blockersClearedMask = (Number(enc.flags.blockersClearedMask) || 0) | (1 << (ti & 31));
    enc.flags.thresholdIndex = ti + 1;
    enc.checkpoint = ti + 1;
    enc.flags.manifestCount = Number(enc.flags.manifestCount) + 1;
    enc.flags.convoyProgress = 0; // the convoy has crossed — begin the next segment
    enc.objectiveProgress = Math.min(1, (ti + 1) / WAKE.thresholdCount);
    enc.flags.processionPhase = "punish";
    wakePlaceBier(w, enc);
    if (ti + 1 < WAKE.thresholdCount) wakeHighlightBlockerFor(w, enc, ti + 1);
    else enc.flags.highlightedBlockerId = -1;
    // Custom completion at the FINAL threshold (not only enemies.length===0).
    if (ti + 1 >= WAKE.thresholdCount) {
      completeEncounter(enc);
      grantEncounterCompletionReward(w);
    }
  }
  wakeSetOutcome(w, e, "success");
  openBossWindow(e, WAKE.processionPunish, ev);
  a.phase = "recover";
  a.time = 0;
  ev.push({ t: "cue", name: "wake.procession.success", x: e.x, y: e.y, rate: 0.8, gain: 0.75, trauma: 0.08 });
}

function wakeMaybeBeginProcession(w: WorldState, e: Enemy, _ev: SimEvent[]): boolean {
  const enc = wakeEnc(w);
  const boss = e.boss!;
  if (!enc || !enc.active || enc.completed) return false;
  if (Number(enc.flags.thresholdIndex) >= WAKE.thresholdCount) return false;
  if (e.attack.phase !== "none" || boss.exposed > 0) return false;
  if (e.attack.cooldown > 0) return false;
  if (Number(enc.flags.convoyProgress) < WAKE.processionTriggerFrac) return false;
  beginWindup(e, "last_procession");
  e.attack.cooldown = WAKE.attackCd[boss.phase] ?? WAKE.attackCd[3];
  wakeSetOutcome(w, e, "pending");
  enc.flags.processionPhase = "tell";
  wakeHighlightBlockerFor(w, enc, Number(enc.flags.thresholdIndex));
  // tell/lock/front ride WAVE_TELLS (wake.last_procession) — no duplicate sim cue.
  return true;
}

function wakeProcessionStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const enc = wakeEnc(w);
  const lockAt = WAKE.processionTell * WAKE.processionLockFrac; // 0.90s
  if (a.phase === "windup") {
    // 1.5s blackout/flood tell; aim locks at 0.90s (the dark front's heading commits).
    a.time += dt;
    a.windup = Math.min(1, a.time / WAKE.processionTell);
    if (enc) enc.flags.processionPhase = "tell";
    if (!a.isAimLocked && a.time >= lockAt) {
      a.isAimLocked = true;
      const bier = wakeBier(w);
      const seg = enc ? wakeSegment(w, enc) : null;
      if (bier && seg) { a.markX = bier.x; a.markY = bier.y; a.lockedAngle = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x); }
    }
    // Success can fire once the convoy is protected (blocker cleared + a player in the aura).
    if (wakeConvoyProtected(w, enc)) { wakeProcessionSuccess(w, e, ev); return; }
    if (a.time >= WAKE.processionTell) {
      a.phase = "active";
      a.time = 0;
      a.windup = 1;
      if (enc) enc.flags.processionPhase = "front";
      // front voiced by WAVE_TELLS active → wake.processionFront
    }
    return;
  }
  if (a.phase === "active") {
    // Moving-front: the dark front follows the convoy to the threshold (capped by frontMaxDuration).
    a.time += dt;
    if (enc) {
      enc.flags.processionPhase = "front";
      // The convoy keeps advancing toward the threshold while the front closes from behind.
      enc.flags.convoyProgress = Math.min(WAKE.convoyHoldFrac, Number(enc.flags.convoyProgress) + WAKE.convoyAdvanceRate * dt);
      wakePlaceBier(w, enc);
      wakePlaceShadowFront(w, enc, true);
    }
    if (wakeConvoyProtected(w, enc)) { wakeProcessionSuccess(w, e, ev); return; }
    if (a.time >= WAKE.frontMaxDuration) {
      // Survival: nobody caught in the dark-front lane (all in a side shelter) → the convoy stalls.
      if (!enc || !wakeAnyInLane(w, enc)) {
        wakeSetOutcome(w, e, "survival");
        if (enc) enc.flags.processionPhase = "advance";
        ev.push({ t: "cue", name: "wake.procession.survival", x: e.x, y: e.y, rate: 1.1, gain: 0.45, trauma: 0.02 });
        enterIdle(e);
        return;
      }
      // Soft failure: bounded warmth/progress loss + a capped hit to players in the lane; never wipe.
      wakeSetOutcome(w, e, "failure");
      enc.failed = true;
      enc.failureCount += 1;
      enc.flags.processionPhase = "advance";
      enc.flags.convoyWarmth = Math.max(0.1, Number(enc.flags.convoyWarmth) - WAKE.warmthLossOnFailure);
      enc.flags.convoyProgress = Math.max(0, Number(enc.flags.convoyProgress) - 0.15);
      for (const p of w.players.values()) {
        if (p.isDown || p.isAbsent || p.hp <= 0) continue;
        if (!wakeInLane(w, enc, p.x, p.y)) continue;
        damagePlayer(w, p, WAKE.processionFailDamage, ev);
      }
      ev.push({ t: "cue", name: "wake.procession.miss", x: e.x, y: e.y, rate: 0.95, gain: 0.55, trauma: 0.05 });
      enterIdle(e);
      return;
    }
    return;
  }
  if (a.phase === "recover") {
    // 4.0s light-bound manifestation punish (success path only) — runs alongside the exposed window.
    a.time += dt;
    if (enc) enc.flags.processionPhase = "punish";
    if (a.time >= WAKE.processionPunish) {
      if (enc) enc.flags.processionPhase = "advance";
      enterIdle(e);
    }
    return;
  }
}

function updateWake(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss!;
  if (!wakeTryActivate(w, e, ev)) {
    e.attack.cooldown = Math.max(e.attack.cooldown, 0.5);
    return;
  }
  if (e.spawnTimer > 0) {
    wakeEnsureConvoy(w, e, ev);
    return;
  }
  if (e.attack.cooldown > 0) e.attack.cooldown = Math.max(0, e.attack.cooldown - dt);

  const enc = wakeEnc(w);

  if (e.attack.move === "last_procession" && e.attack.phase !== "none") {
    wakeProcessionStep(w, e, dt, ev);
    return;
  }

  // Advance the autonomous convoy toward the next threshold (the convoy waits at holdFrac for the
  // escort — it only CROSSES a threshold on a successful procession).
  if (enc && enc.active && !enc.completed && Number(enc.flags.thresholdIndex) < WAKE.thresholdCount) {
    enc.flags.processionPhase = "advance";
    enc.flags.convoyProgress = Math.min(WAKE.convoyHoldFrac, Number(enc.flags.convoyProgress) + WAKE.convoyAdvanceRate * dt);
    const seg = wakeSegment(w, enc);
    enc.flags.convoyEdgeId = w.dungeon.blueprint && w.dungeon.blueprint.chaseEdgeIds.length > 0
      ? w.dungeon.blueprint.chaseEdgeIds[Math.min(Number(enc.flags.thresholdIndex), w.dungeon.blueprint.chaseEdgeIds.length - 1)]
      : -1;
    enc.routeEdgeId = Number(enc.flags.convoyEdgeId) >= 0 ? Number(enc.flags.convoyEdgeId) : null;
    void seg;
    wakePlaceBier(w, enc);
    wakePlaceShadowFront(w, enc, false);
  }

  // The Wake shadow trails the convoy from behind (never a global aggro rush — the escort is the
  // beat, not a chase). It manifests into the fight at the thresholds via THE LAST PROCESSION.
  const bier = wakeBier(w);
  if (bier && enc) {
    const seg = wakeSegment(w, enc);
    const ang = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x);
    const behindX = bier.x - Math.cos(ang) * (TILE * 2.5);
    const behindY = bier.y - Math.sin(ang) * (TILE * 2.5);
    const toBehind = Math.atan2(behindY - e.y, behindX - e.x);
    applyChaseStep(w, e, dt, toBehind, e.speed * 0.4 * dt);
  } else if (findTarget(w, e.x, e.y)) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * 0.4 * dt);
  }

  if (e.attack.phase === "none" && boss.exposed <= 0) {
    wakeMaybeBeginProcession(w, e, ev);
  }
}

// ---- PALE THRONE F75 — THE LAST LIGHT FALLS (OWNER LOCK signature) ----
// Timings: 1.8s tell → 3× ≥0.65s sequential scar relights (one active) → 1.0s fall → 4.0s punish.
// Success = all three scars relit in order → openBossWindow(4.0). Survival = abandon chain /
// stay on warm route → dead-space impact, no window. Failure = bounded sequence reset.
// Warmth-drain remains a separate P3 tax and is NEVER the success counter.
// Cadence: boss.lastAddPick stores centiseconds until the next signature (Pale has no add drip).
// Relit count rides boss.huskReformTimer (unused on Pale). Outcome rides boss.mirrorLastFamily:
//   -1 idle, 0 pending, 1 success, 2 survival, 3 failure. Active scar index → boss.mirrorFamily.
function paleEnc(w: WorldState) {
  return w.encounter && w.encounter.structureKind === "arena" ? w.encounter : null;
}

function paleLastLightSetOutcome(w: WorldState, e: Enemy, outcome: "idle" | "pending" | "success" | "survival" | "failure"): void {
  const enc = paleEnc(w);
  if (enc) enc.flags.lastLightOutcome = outcome;
  const map = { idle: -1, pending: 0, success: 1, survival: 2, failure: 3 } as const;
  e.boss!.mirrorLastFamily = map[outcome];
}

function paleLastLightOutcomeOf(e: Enemy): "idle" | "pending" | "success" | "survival" | "failure" {
  const v = e.boss!.mirrorLastFamily;
  if (v === 1) return "success";
  if (v === 2) return "survival";
  if (v === 3) return "failure";
  if (v === 0) return "pending";
  return "idle";
}

function paleLastLightTickCadence(e: Enemy, dt: number): void {
  const boss = e.boss!;
  if (boss.lastAddPick > 0) {
    boss.lastAddPick = Math.max(0, boss.lastAddPick - Math.max(1, Math.round(dt * 100)));
  }
}

function paleLastLightMaybeBegin(w: WorldState, e: Enemy, ev: SimEvent[]): boolean {
  const boss = e.boss!;
  if (boss.lastAddPick > 0) return false;
  beginWindup(e, "last_light");
  e.attack.cooldown = PALE.attackCd[boss.phase] ?? PALE.attackCd[3];
  boss.lastAddPick = Math.round(PALE.lastLightCadence * 100);
  boss.spinCount = 0;
  boss.mirrorFamily = 0;
  boss.huskReformTimer = 0;
  paleLastLightSetOutcome(w, e, "pending");
  const enc = paleEnc(w);
  if (enc) {
    enc.flags.lastLightPhase = "tell";
    enc.flags.lastLightScarIndex = 0;
    enc.flags.lastLightScarId = -1;
    enc.flags.lastLightRelit = 0;
    enc.checkpoint = 0;
  }
  paleLastLightClearScar(w, e);
  ev.push({ t: "cue", name: "pale.lastLight.tell", x: e.x, y: e.y, rate: 0.7, gain: 0.7, trauma: 0.05 });
  return true;
}

function paleLastLightClearScar(w: WorldState, e: Enemy): void {
  const boss = e.boss!;
  if (boss.laneKnotId > 0) {
    const scar = w.enemies.find((o) => o.id === boss.laneKnotId - 1 && o.kind === "pale_seam");
    if (scar && !scar.dead) scar.dead = true;
    boss.laneKnotId = 0;
  }
  const enc = paleEnc(w);
  if (enc) enc.flags.lastLightScarId = -1;
}

function paleLastLightPlantScar(w: WorldState, e: Enemy, scarIndex: number, ev: SimEvent[]): void {
  paleLastLightClearScar(w, e);
  const boss = e.boss!;
  const base = -Math.PI / 2;
  const offsets = [-0.55, 0, 0.55];
  const ang = base + (offsets[scarIndex] ?? 0);
  const dist = PALE.seamRingDist + 12;
  let x = e.x + Math.cos(ang) * dist;
  let y = e.y + Math.sin(ang) * dist;
  const r = ENEMY_ARCHETYPES.pale_seam.radius;
  if (!settleSpawnPoint(w, x, y, r)) {
    x = e.x + Math.cos(ang) * (dist + TILE);
    y = e.y + Math.sin(ang) * (dist + TILE);
    settleSpawnPoint(w, x, y, r);
  }
  const scar = createEnemy("pale_seam", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  scar.hp = scar.maxHp = Math.max(1, Math.round(PALE.lastLightScarHp));
  scar.spawnTimer = 0;
  scar.seq = e.id + 1;
  scar.aux = scarIndex + 10;
  w.enemies.push(scar);
  boss.laneKnotId = scar.id + 1;
  boss.mirrorFamily = scarIndex;
  const enc = paleEnc(w);
  if (enc) {
    enc.flags.lastLightScarId = scar.id;
    enc.flags.lastLightScarIndex = scarIndex;
    enc.flags.lastLightPhase = "scars";
    enc.checkpoint = scarIndex;
  }
  ev.push({ t: "enemySpawn", eid: scar.id, kind: scar.kind, tier: scar.tier, x: scar.x, y: scar.y });
  ev.push({ t: "cue", name: "pale.lastLight.scar", x: scar.x, y: scar.y, rate: 1.1, gain: 0.55, trauma: 0.02 });
}

function paleLastLightScarBroken(w: WorldState, e: Enemy): boolean {
  const boss = e.boss!;
  if (boss.laneKnotId <= 0) return false;
  const scar = w.enemies.find((o) => o.id === boss.laneKnotId - 1 && o.kind === "pale_seam");
  return !scar || scar.dead || scar.hp <= 0;
}

function paleLastLightStep(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const enc = paleEnc(w);
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / PALE.lastLightTell);
    if (!a.isAimLocked && a.windup >= 0.6) {
      a.lockedAngle = -Math.PI / 2;
      a.markX = e.x;
      a.markY = e.y - PALE.seamRingDist;
      a.isAimLocked = true;
    }
    if (enc) enc.flags.lastLightPhase = "tell";
    if (a.time >= PALE.lastLightTell) {
      a.phase = "active";
      a.time = 0;
      a.windup = 1;
      boss.spinCount = 0;
      boss.huskReformTimer = 0;
      if (enc) {
        enc.flags.lastLightPhase = "scars";
        enc.flags.lastLightRelit = 0;
        enc.flags.lastLightScarIndex = 0;
      }
      paleLastLightPlantScar(w, e, 0, ev);
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const scarIx = boss.spinCount;
    if (scarIx < PALE.lastLightScarCount) {
      if (enc) {
        enc.flags.lastLightPhase = "scars";
        enc.flags.lastLightScarIndex = scarIx;
      }
      if (paleLastLightScarBroken(w, e)) {
        const relitCount = scarIx + 1;
        boss.huskReformTimer = relitCount;
        if (enc) {
          enc.flags.lastLightRelit = relitCount;
          enc.checkpoint = relitCount;
        }
        paleLastLightClearScar(w, e);
        boss.spinCount = scarIx + 1;
        a.time = 0;
        if (boss.spinCount < PALE.lastLightScarCount) {
          paleLastLightPlantScar(w, e, boss.spinCount, ev);
          a.lockedAngle = -Math.PI / 2 + boss.spinCount * 0.18;
        } else {
          a.lockedAngle = Math.PI / 2;
          if (enc) enc.flags.lastLightPhase = "fall";
          ev.push({ t: "cue", name: "pale.lastLight.lock", x: e.x, y: e.y, rate: 0.55, gain: 0.8, trauma: 0.08 });
        }
        return;
      }
      if (a.time >= PALE.lastLightScarCommit) {
        paleLastLightClearScar(w, e);
        boss.spinCount = PALE.lastLightScarCount;
        a.time = 0;
        if (enc) enc.flags.lastLightPhase = "fall";
      }
      return;
    }
    if (enc) enc.flags.lastLightPhase = "fall";
    if (a.time >= PALE.lastLightFall) {
      const success = boss.huskReformTimer >= PALE.lastLightScarCount;
      enterRecover(e);
      a.time = 0;
      if (enc) enc.flags.lastLightPhase = "punish";
      if (success) {
        paleLastLightSetOutcome(w, e, "success");
        openBossWindow(e, PALE.lastLightPunish, ev);
        ev.push({ t: "chargeCrash", x: e.x, y: e.y });
        ev.push({ t: "cue", name: "pale.lastLight.punish", x: e.x, y: e.y, rate: 0.6, gain: 0.9, trauma: 0.14 });
        if (enc) {
          let best: { id: string; d: number } | null = null;
          for (const p of w.players.values()) {
            if (p.isDown || p.isAbsent || p.hp <= 0) continue;
            const d = Math.hypot(p.x - e.x, p.y - e.y);
            if (!best || d < best.d) best = { id: p.id, d };
          }
          if (best) setEncounterCarrier(enc, best.id);
        }
      } else {
        let anyHit = false;
        for (const p of w.players.values()) {
          if (p.isDown || p.hp <= 0) continue;
          const dx = p.x - e.x, dy = p.y - (e.y + PALE.seamRingDist);
          if (Math.hypot(dx, dy) < TILE * 1.2 && p.invuln <= 0) {
            anyHit = true;
            damagePlayer(w, p, 1, ev);
          }
        }
        paleLastLightSetOutcome(w, e, anyHit ? "failure" : "survival");
        if (enc) {
          if (anyHit) {
            enc.failureCount = (enc.failureCount || 0) + 1;
            enc.failed = true;
          }
          enc.flags.lastLightScarIndex = 0;
          enc.flags.lastLightRelit = 0;
          enc.checkpoint = 0;
        }
        ev.push({ t: "cue", name: "pale.lastLight.miss", x: e.x, y: e.y + PALE.seamRingDist, rate: 0.9, gain: 0.5, trauma: 0.04 });
      }
      paleLastLightClearScar(w, e);
      boss.huskReformTimer = 0;
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    const dur = paleLastLightOutcomeOf(e) === "success" ? PALE.lastLightPunish : 0.6;
    if (a.time >= dur) {
      if (enc) enc.flags.lastLightPhase = "idle";
      enterIdle(e);
    }
  }
}

// ---- THE GIANT ENCOUNTER CORE (Gorge F50 / Pale Throne F75 / — F100 Unmaker) ----
// The AD-LOCKED shell-peel giant, run as ONE shared core parameterized by a per-giant GiantSpec
// (constants + material colors + seam/debris kinds + balance fns). A colossal STATIONARY set-piece:
// it NEVER chases. Its threat is SPACE-CONTROL (rings/zones/spokes) plus a MULTI-PHASE SHELL-PEEL
// task, and it is GUARDED behind its shell (guardMult 0.0 — a TRUE hard gate, the shell IS the
// wall). Two loops run in parallel:
//  (1) the WEAK-POINT loop (giantSeamLoop): periodically juts N tectonic seams out of the shell;//      clearing the whole set routes through the SHIPPED openBossWindow plumbing (guard chip +
//      per-window bank + calibration) — the ONLY damage path. Missing the set → it re-seals + re-
//      exposes (it LOOPS). Co-op = MORE seams (the TASK scales), never fatter HP.
//  (2) the SPATIAL-PATTERN loop (the attack machine): P1 RADIAL ring-with-a-gap / P2 ZONING slag
//      pools / P3 CONVERGENT rotating spokes (P2 zones still live), each on its own ≥0.6s tell.
// Per-shell HP (shellFrac) is spent across the peel windows; when a shell's chunk is gone the layer
// SLOUGHS at the phase transition (giantShellSlough: sprite swaps + debris cover drops). Gorge and
// Pale are byte-identical in behavior save the spec — Pale's tuned HP/bank + its COLD telegraph
// colors (spec.ringColor/spokeColor) — and the material colors never touch determinism.
function updateGiant(w: WorldState, e: Enemy, dt: number, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;
  const gc = spec.C;

  // THE LAST LIGHT FALLS (Pale only): signature reserves the major-telegraph slot. Seam peel and
  // spatial patterns pause while the meteor/scar sequence is live (fairness: one lethal commitment).
  if (spec.bodyKind === "pale") {
    if (boss.lastAddPick < 0) boss.lastAddPick = Math.round(PALE.lastLightCadence * 100);
    if (a.move === "last_light" && a.phase !== "none") {
      paleLastLightStep(w, e, dt, ev);
      return;
    }
  }

  // The weak-point loop runs EVERY tick, in parallel with (and independent of) the pattern loop —
  // the seams stand while the giant fires its rings/zones/spokes (paused only during the crack-off
  // beat, which sloughs them anyway).
  giantSeamLoop(w, e, dt, ev, spec);

  if (a.phase === "windup") { giantWindup(w, e, dt, ev, spec); return; }
  if (a.phase === "active") { giantActive(w, e, dt, ev, spec); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "sweep" ? gc.spokeRecover : a.move === "spew" ? gc.zoneRecover : gc.ringRecover;
    if (a.time >= recDur) enterIdle(e);
    return;
  }
  if (spec.bodyKind === "pale") paleLastLightTickCadence(e, dt);
  if (a.cooldown === 0 && e.spawnTimer === 0 && !boss.roar) {
    if (spec.bodyKind === "pale" && paleLastLightMaybeBegin(w, e, ev)) return;
    giantBeginAttack(e, ev, spec);
    return;
  }
  // STATIONARY: no chase step — the giant holds the arena center and lets its patterns do the work.
}

// The weak-point exposure loop (the peel VERB, skinned over the earned-window engine). The live
// seam ids ride windowAddIds (the "kill all to open the window" set); the exposure CADENCE reuses
// the generic addTimer (the giant runs no add drip); seamLife is the current exposure's retract
// countdown. Clearing the whole set → openBossWindow (the peel); a timeout → re-seal (no window).
function giantSeamLoop(w: WorldState, e: Enemy, dt: number, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss!;
  const gc = spec.C;
  if (boss.roar) return; // the shell is mid-slough (crack-off beat) — seam logic pauses
  if (boss.windowAddIds.length > 0) {
    // Seams are exposed (some may have just died this tick).
    if (countLiveIds(w, boss.windowAddIds) === 0) {
      // The whole set is destroyed — the shell CRACKS: route the peel through the shipped
      // earned-window plumbing (guard chip, window bank, determinism, calibration all inherited).
      boss.windowAddIds.length = 0;
      boss.seamLife = 0;
      boss.addTimer = gc.seamExposeInterval; // re-expose a fresh set after the window plays out
      openBossWindow(e, gc.peelExpose, ev);
      ev.push({ t: "chargeCrash", x: e.x, y: e.y });
      ev.push({ t: "cue", name: `${spec.bodyKind}.peel`, x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.12 });
      return;
    }
    boss.seamLife -= dt;
    if (boss.seamLife <= 0) {
      // Not cleared in time — the shell RE-SEALS (the seams retract unspent, no window). It loops.
      for (const id of boss.windowAddIds) {
        const seam = w.enemies.find((o) => !o.dead && o.id === id);
        if (seam) { seam.dead = true; ev.push({ t: "puff", x: seam.x, y: seam.y, n: 4, color: ENEMY_ARCHETYPES[spec.seamKind].tint }); }
      }
      boss.windowAddIds.length = 0;
      boss.addTimer = gc.seamExposeInterval;
    }
    return;
  }
  // Sealed: count down to the next exposure. Never during the entrance grace or while a peel
  // window is still being spent (let the bared material be worked before re-sealing behind seams).
  if (e.spawnTimer > 0 || boss.exposed > 0) return;
  boss.addTimer -= dt;
  if (boss.addTimer <= 0) giantExposeSeams(w, e, ev, spec);
}

// Jut N tectonic weak-points out of the current shell, FACING the threatened player (always
// reachable), the arc widening per shell: P1 a tight front cluster (easy — teaches the verb) →
// P2 wider → P3 the widest (out to the giant's sides), so players must TRACK + REPOSITION
// across the front to hit them all (space pressure) without an unfair orbit behind the body. The
// seams are mechanic bodies (decoy kind: no loot/combo), linked to the giant via seq, on the
// shared windowAddIds set.
function giantExposeSeams(w: WorldState, e: Enemy, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss!;
  const gc = spec.C;
  const n = spec.seamCountFor(boss.phase, w.encounterPlayers);
  const hp = spec.seamHpForFloor(w.floor);
  boss.windowAddIds.length = 0;
  const arc = gc.seamArcByShell[Math.max(0, Math.min(gc.seamArcByShell.length - 1, boss.phase - 1))];
  const livingPlayers = [...w.players.values()]
    .filter((player) => !player.isDown && !player.isAbsent && player.hp > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  let bankFacings: number[] = [];
  if ((gc.seamBanksMinPlayers ?? Infinity) <= livingPlayers.length) {
    let anchorA = livingPlayers[0];
    let anchorB = livingPlayers[1];
    let bestDistance = -1;
    for (let i = 0; i < livingPlayers.length; i++) {
      for (let j = i + 1; j < livingPlayers.length; j++) {
        const distance = Math.hypot(livingPlayers[i].x - livingPlayers[j].x, livingPlayers[i].y - livingPlayers[j].y);
        if (distance > bestDistance) {
          bestDistance = distance;
          anchorA = livingPlayers[i];
          anchorB = livingPlayers[j];
        }
      }
    }
    let facingA = Math.atan2(anchorA.y - e.y, anchorA.x - e.x);
    let facingB = Math.atan2(anchorB.y - e.y, anchorB.x - e.x);
    const separation = Math.atan2(Math.sin(facingB - facingA), Math.cos(facingB - facingA));
    const minSeparation = gc.seamBankMinSeparationRad ?? 0;
    if (Math.abs(separation) < minSeparation) {
      const midpoint = facingA + separation / 2;
      facingA = midpoint - minSeparation / 2;
      facingB = midpoint + minSeparation / 2;
    }
    bankFacings = [facingA, facingB];
  } else {
    const facing = findTarget(w, e.x, e.y) ? Math.atan2(w.targetY - e.y, w.targetX - e.x) : 0;
    bankFacings = [facing];
  }

  for (let i = 0; i < n; i++) {
    const bankIndex = bankFacings.length === 2 && i >= Math.ceil(n / 2) ? 1 : 0;
    const bankStart = bankIndex === 0 ? 0 : Math.ceil(n / 2);
    const bankCount = bankIndex === 0 ? Math.ceil(n / bankFacings.length) : Math.floor(n / bankFacings.length);
    const bankOffset = i - bankStart;
    const bankArc = arc / bankFacings.length;
    const ang = bankFacings[bankIndex]
      + (bankCount > 1 ? (bankOffset / (bankCount - 1) - 0.5) * bankArc : 0);
    const seamRadius = ENEMY_ARCHETYPES[spec.seamKind].radius;
    let isSettled = false;
    for (let extra = 0; extra <= TILE; extra += TILE / 4) {
      const x = e.x + Math.cos(ang) * (gc.seamRingDist + extra);
      const y = e.y + Math.sin(ang) * (gc.seamRingDist + extra);
      if (!settleSpawnPoint(w, x, y, seamRadius)) continue;
      if (Math.hypot(settlePoint.x - e.x, settlePoint.y - e.y) <= e.radius + seamRadius + 20) continue;
      isSettled = true;
      break;
    }
    if (!isSettled) continue;
    const seam = createEnemy(spec.seamKind, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      isSummoned: true, players: w.encounterPlayers,
    });
    seam.hp = seam.maxHp = hp;
    seam.spawnTimer = 0;
    seam.seq = e.id + 1; // the seam belongs to the giant that cracked it open
    seam.aux = bankIndex + 1;
    w.enemies.push(seam);
    boss.windowAddIds.push(seam.id);
    ev.push({ t: "enemySpawn", eid: seam.id, kind: seam.kind, tier: seam.tier, x: seam.x, y: seam.y });
  }
  boss.seamLife = gc.seamLifeByShell[Math.max(0, Math.min(gc.seamLifeByShell.length - 1, boss.phase - 1))];
  // The shell cracks/juts as the seams emerge — a readable tell that the peel window is open.
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.7, gain: 0.6, trauma: 0.04 });
}

// The spatial-pattern cadence: P1 RADIAL ring, P2 ZONING pools, P3 CONVERGENT spokes (interleaving
// a zone refresh every other beat so the P2 floor-denial stays live under the spoke sweep).
function giantBeginAttack(e: Enemy, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss!;
  const gc = spec.C;
  boss.attackCount++;
  boss.spinCount = 0;
  e.attack.cooldown = gc.attackCd[boss.phase] ?? gc.attackCd[3];
  let move: AttackMove;
  if (boss.phase <= 1) move = "slam";                                   // P1: the shockwave ring
  else if (boss.phase === 2) move = "spew";                             // P2: the slag zones
  else move = boss.attackCount % 2 === 0 ? "spew" : "sweep";            // P3: spokes + zones still live
  beginWindup(e, move);
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
}

function giantWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[], spec: GiantSpec): void {
  const a = e.attack;
  const boss = e.boss!;
  const gc = spec.C;
  if (a.move === "roar") {
    // The SHELL CRACK-OFF beat (phase transition): the layer sloughs on exit (giantShellSlough
    // already dropped the debris + swapped the phase in checkBossTransition).
    a.time += dt;
    a.windup = Math.min(1, a.time / gc.roarDuration);
    if (a.time >= gc.roarDuration) { enterIdle(e); endBossTransition(w, e, ev); }
    return;
  }
  const windupT = a.move === "slam" ? gc.ringWindup : a.move === "spew" ? gc.zoneWindup : gc.spokeWindup;
  a.time += dt;
  a.windup = Math.min(1, a.time / windupT);
  if (a.time < windupT) return;
  if (a.move === "slam") {
    giantRing(w, e, ev, spec, 0); // the primary ring
    // P1 SEQUENCING axis: if this giant has a SECOND ring, hold in `active` to fire it after the
    // delay (the counter-offset ring whose gap is where the first's wall now is). Else recover now
    // (Gorge — single ring, byte-identical).
    if (gc.ring2DelaySec !== undefined) {
      a.phase = "active";
      a.time = 0;
      a.windup = 0;
      boss.spinCount = 0;
      ev.push({ t: "cue", name: `${spec.bodyKind}.ring2Warn`, x: e.x, y: e.y, rate: 1, gain: 0.7, trauma: 0 });
    }
    else enterRecover(e);
  } else if (a.move === "spew") { giantZones(w, e, ev, spec); enterRecover(e); }
  else { a.phase = "active"; a.time = 0; a.windup = 0; } // sweep: the multi-beat rotating spoke wheel
}

function giantActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[], spec: GiantSpec): void {
  const a = e.attack;
  const boss = e.boss!;
  const gc = spec.C;
  a.time += dt;
  if (a.move === "slam") {
    // P1 SEQUENCING axis (giants with a 2nd ring only): fire the counter-offset SECOND ring after
    // its delay, then recover. Reached only when ring2DelaySec is set, so Gorge never enters here.
    if (boss.spinCount === 0 && gc.ring2DelaySec !== undefined && a.time >= gc.ring2DelaySec) {
      giantRing(w, e, ev, spec, 1);
      boss.spinCount = 1;
    }
    if (boss.spinCount >= 1) enterRecover(e);
    return;
  }
  if (a.move !== "sweep") { enterRecover(e); return; }
  // The rotating spoke wheel: a fresh spoke set every interval, the whole wheel advancing by
  // spokeStep each emission so its ONE gap sweeps around as a moving safe lane.
  while (boss.spinCount * gc.spokeInterval <= a.time && a.time <= gc.spokeDuration) {
    giantSpokes(w, e, boss.spinCount, ev, spec);
    boss.spinCount++;
  }
  if (a.time >= gc.spokeDuration) enterRecover(e);
}

// P1 RADIAL: an expanding shockwave ring WITH an authored GAP (a stand-in-the-gap safe wedge that
// rotates each ring), plus a couple of debris blooms near the gap so it isn't the only read.
// ringIx 0 = the PRIMARY ring (Gorge-identical). ringIx 1 = the P1 SEQUENCING axis's SECOND ring —
// its gap offset by ring2OffsetDeg so the gap you just dashed becomes the next wall (the read is
// the SEQUENCE). Each ring keeps the SAME gap width (the second ring IS the difficulty, not a
// narrower gap). Debris blooms only on the primary, so the second ring adds no charge-hazard soup.
function giantRing(w: WorldState, e: Enemy, ev: SimEvent[], spec: GiantSpec, ringIx: number): void {
  const boss = e.boss!;
  const gc = spec.C;
  const gapStart = giantRingGapStart(boss.attackCount, ringIx, gc);
  const gapCenterAng = giantRingGapCenter(boss.attackCount, ringIx, gc);
  for (let i = 0; i < gc.ringCount; i++) {
    const inGap = ((i - gapStart + gc.ringCount) % gc.ringCount) < gc.ringGap;
    if (inGap) continue; // the authored safe wedge
    const ang = (i / gc.ringCount) * Math.PI * 2;
    spawnEnemyBullet(w, e.x, e.y, ang, gc.ringSpeed, gc.globRadius, gc.globDamage, spec.ringColor, gc.globLife);
  }
  // Debris blooms flank the gap (area-deny — the ring isn't the only read), scaled by 4p surplus.
  // PRIMARY ring only: the second ring's difficulty is the sequence, never extra charge density.
  if (ringIx === 0) {
    const debris = bossAddCapFor(gc.ringDebris, w.encounterPower);
    for (let i = 0; i < debris; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const layer = Math.floor(i / 2);
      const gapHalf = (gc.ringGap / gc.ringCount) * Math.PI;
      const off = side * (gapHalf + 0.24 + layer * 0.2);
      plantAffixCharge(w, e.x + Math.cos(gapCenterAng + off) * gc.ringDebrisDist, e.y + Math.sin(gapCenterAng + off) * gc.ringDebrisDist);
    }
  }
  ev.push({ t: "bossSlam", x: e.x, y: e.y });
}

// P2 ZONING: persistent SLAG pools (reusing the cinder floor-denial primitive) ringed AROUND the
// party — their CURRENT spot stays open (the authored safe pocket), while the pools accumulate and
// shrink the safe floor. Hard-capped (giantPlantSlag evicts the nearest-to-expiring), so the floor
// never fully seals — tension is "space is dangerous," never "you're cornered."
function giantZones(w: WorldState, e: Enemy, ev: SimEvent[], spec: GiantSpec): void {
  const gc = spec.C;
  if (!findTarget(w, e.x, e.y)) return;
  const base = w.rng.next() * Math.PI * 2;
  // The P2 MIGRATION axis: each new pool also CREEPS outward from the giant (drift), and (churn)
  // seeds at the edge of the nearest-to-expiring pool so the field ROLLS forward instead of
  // re-centering on the party. spread = 0 (no drift) for Gorge, so its plant is byte-identical.
  const spread = gc.zoneSpreadTilesPerSec !== undefined ? gc.zoneSpreadTilesPerSec * TILE : 0;
  if (gc.isZoneChurnEnabled) {
    const field = w.hazards.filter((h) => h.kind === "cinder" && h.life > 0).sort((a, b) => a.life - b.life);
    for (let i = 0; i < gc.zoneCount; i++) {
      let px: number, py: number;
      if (i < field.length) {
        // Seed at the OUTWARD edge of the i-th nearest-to-expiring pool (the field's leading edge).
        const src = field[i];
        const outward = Math.atan2(src.y - e.y, src.x - e.x);
        px = src.x + Math.cos(outward) * gc.zoneRadius * 2;
        py = src.y + Math.sin(outward) * gc.zoneRadius * 2;
      } else {
        // Bootstrap around the party (like Gorge) until a field exists to churn off of.
        const ang = base + (i / gc.zoneCount) * Math.PI * 2;
        px = w.targetX + Math.cos(ang) * gc.zoneRing;
        py = w.targetY + Math.sin(ang) * gc.zoneRing;
      }
      const drift = Math.atan2(py - e.y, px - e.x);
      giantPlantSlag(w, px, py, spec, Math.cos(drift) * spread, Math.sin(drift) * spread);
    }
  } else {
    for (let i = 0; i < gc.zoneCount; i++) {
      const ang = base + (i / gc.zoneCount) * Math.PI * 2;
      giantPlantSlag(w, w.targetX + Math.cos(ang) * gc.zoneRing, w.targetY + Math.sin(ang) * gc.zoneRing, spec);
    }
  }
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.6, gain: 0.6, trauma: 0.03 });
}

// Plant one persistent slag pool (a cinder = a protection-gated 1-damage floor-denial zone). The
// giant's pools are hard-capped: at the cap the nearest-to-expiring pool is evicted first, so the
// denied floor is a rolling, shrinking-then-shifting area — never a sealed room. (The pool rides
// the shared cinder floor-denial primitive for both giants; only the giant's telegraph BULLETS
// carry the per-giant material color, so the sim/wire is untouched by the cold material swap.)
function giantPlantSlag(w: WorldState, x: number, y: number, spec: GiantSpec, driftVx = 0, driftVy = 0): void {
  const gc = spec.C;
  if (isWall(w, x, y)) return;
  let cinders = 0;
  let oldest: Hazard | null = null;
  for (const h of w.hazards) {
    if (h.kind !== "cinder") continue;
    cinders++;
    if (oldest === null || h.life < oldest.life) oldest = h;
  }
  // The denial ceiling (zoneCap): keeps total denied area ≤ ⅓ arena so the safe pocket always
  // holds (pale.test.ts asserts it). At the cap, evict the nearest-to-expiring — the field churns.
  if (cinders >= gc.zoneCap && oldest !== null) oldest.life = 0;
  // Pale's slag CREEPS outward (driftVx/Vy from zoneSpreadTilesPerSec); Gorge's is static (0/0 →
  // vx/vy left undefined → inert in updateHazards, so every other cinder source is unaffected).
  w.hazards.push({
    id: w.nextHazardId++, kind: "cinder", x, y,
    radius: gc.zoneRadius, life: gc.zoneLife, maxLife: gc.zoneLife,
    ...(driftVx !== 0 || driftVy !== 0 ? { vx: driftVx, vy: driftVy } : {}),
  });
}

// P3 CONVERGENT: one rotating spoke SET per emission — spokeCount arms minus a spokeGap-wide wedge,
// the whole wheel advanced by spokeStep each emission so the gap is a MOVING safe lane (< walk
// speed to ride). burstParity carries a per-commitment phase offset so successive sweeps re-read.
function giantSpokes(w: WorldState, e: Enemy, emission: number, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss!;
  const gc = spec.C;
  const wheel = giantSpokeWheel(emission, boss.burstParity, 0, gc);
  for (let i = 0; i < gc.spokeCount; i++) {
    if (i < gc.spokeGap) continue; // the moving safe wedge (fixed vs the wheel, so it rotates with it)
    const ang = wheel + (i / gc.spokeCount) * Math.PI * 2;
    spawnEnemyBullet(w, e.x, e.y, ang, gc.spokeSpeed, gc.globRadius, gc.globDamage, spec.spokeColor, gc.spokeLife ?? gc.globLife);
  }
  // P3 DUAL-READ axis: a COUNTER-ROTATING second sweep (giants with spoke2Step only — Gorge has
  // none). It reuses the SWEEP_ARC (spokeCount slots, gap = spoke2Gap ?? spokeGap) counter-rotating
  // at spoke2Step (opposite sign). Safe = the drifting INTERSECTION of the two wedges, which
  // provably never fully closes at spokeGap 2 (discrete 40°-apart spokes leave inter-spoke lanes —
  // pale.test.ts measures min ~40° every tick). Safe = ride the primary lane, dodge the crossings.
  if (gc.spoke2Step !== undefined) {
    const gap2 = gc.spoke2Gap ?? gc.spokeGap;
    const wheel2 = giantSpokeWheel(emission, boss.burstParity, 1, gc);
    for (let i = 0; i < gc.spokeCount; i++) {
      if (i < gap2) continue; // the counter-sweep's (wider) moving wedge
      const ang = wheel2 + (i / gc.spokeCount) * Math.PI * 2;
      spawnEnemyBullet(w, e.x, e.y, ang, gc.spokeSpeed, gc.globRadius, gc.globDamage, spec.spokeColor, gc.spokeLife ?? gc.globLife);
    }
  }
  if (emission === 0) ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

// The SHELL CRACK-OFF (the phase transition beat, from checkBossTransition): the sloughed layer
// drops as debris cover at the base (material evidence + reusable line-of-sight/movement cover),
// any half-peeled seams crumble with it, and the exposure cadence re-arms for the freshly-bared
// shell. The sprite advance (stone → cracked → core) is automatic off the new boss.phase. Pure
// presentation + topology — it NEVER opens/extends the earned window (only a seam clear does).
function giantShellSlough(w: WorldState, e: Enemy, ev: SimEvent[], spec: GiantSpec): void {
  const boss = e.boss!;
  const gc = spec.C;
  for (const id of boss.windowAddIds) {
    const seam = w.enemies.find((o) => !o.dead && o.id === id);
    if (seam) { seam.dead = true; ev.push({ t: "puff", x: seam.x, y: seam.y, n: 4, color: ENEMY_ARCHETYPES[spec.seamKind].tint }); }
  }
  boss.windowAddIds.length = 0;
  boss.seamLife = 0;
  boss.addTimer = gc.seamExposeInterval; // the fresh shell re-exposes on the normal cadence
  boss.burstParity = (boss.burstParity + 1) & 1; // shift the spoke wheel's phase so P3 re-reads
  giantDropDebris(w, e, ev, spec);
  if (boss.phase === 3) {
    ev.push({ t: "cue", name: `${spec.bodyKind}.coreReveal`, x: e.x, y: e.y, rate: 1, gain: 0.9, trauma: 0.08 });
  }
  ev.push({ t: "bossSlam", x: e.x, y: e.y });
}

// Drop the sloughed shell as debris CHUNKS at the giant's base — destructible props (movement +
// line-of-sight cover, like the marshal's shatter-crates / the Warden's clinker ring), deterministic
// and cheap. Never dropped on a player or into a wall/prop; the nav obstacle field is bumped.
function giantDropDebris(w: WorldState, e: Enemy, ev: SimEvent[], spec: GiantSpec): void {
  const gc = spec.C;
  const base = w.rng.next() * Math.PI * 2;
  let placed = 0;
  for (let i = 0; i < gc.debrisPerPeel; i++) {
    const ang = base + (i / Math.max(1, gc.debrisPerPeel)) * Math.PI * 2;
    const x = e.x + Math.cos(ang) * gc.debrisRingDist;
    const y = e.y + Math.sin(ang) * gc.debrisRingDist;
    if (isWall(w, x, y) || blockedByProp(w, x, y, C.PROP_RADIUS)) continue;
    if (isNearAnyPlayer(w, x, y, C.PROP_RADIUS + 40)) continue; // never bury a player under a chunk
    w.props.push({
      id: w.nextPropId++, kind: spec.debrisKind, x, y,
      radius: C.PROP_RADIUS, hp: C.PROP_HP[spec.debrisKind], dead: false, owner: e.id,
    });
    ev.push({ t: "puff", x, y, n: 6, color: ENEMY_ARCHETYPES[spec.bodyKind].tint });
    placed++;
  }
  if (placed > 0) w.obstacleRev++;
}

// ---- shared attack helpers ----

function findTarget(w: WorldState, x: number, y: number): boolean {
  let bestD = Infinity, found = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0 || (isPvp(w) && isProtected(p))) continue;
    const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; w.targetX = p.x; w.targetY = p.y; found = true; }
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    const dx = r.x - x, dy = r.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; w.targetX = r.x; w.targetY = r.y; found = true; }
  }
  return found;
}

function hasLineOfSight(w: WorldState, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.hypot(dx, dy) / (TILE * 0.5));
  if (steps <= 1) return !isWall(w, x1, y1);
  const sx = dx / steps, sy = dy / steps;
  let x = x0 + sx, y = y0 + sy;
  for (let i = 1; i < steps; i++) {
    if (isWall(w, x, y)) return false;
    x += sx; y += sy;
  }
  return true;
}

function phaseLineOfSightDamageMult(w: WorldState, b: Bullet, targetX: number, targetY: number): number {
  if (b.isPhase !== true) return 1;
  if (b.phaseFireX === undefined || b.phaseFireY === undefined) return PHASE_NO_LOS_DAMAGE_MULT;
  return hasLineOfSight(w, b.phaseFireX, b.phaseFireY, targetX, targetY)
    ? 1
    : PHASE_NO_LOS_DAMAGE_MULT;
}

function refreshNav(w: WorldState, dt: number): void {
  w.flowCd -= dt;
  const d = w.dungeon;
  // Retarget trigger keys off a combined hash of EVERY living source tile (players + legacy
  // remote targets), so ANY player crossing a tile refreshes multi-source paths — not only
  // the primary. The chase fields themselves rebuild LAZILY per clearance class (see
  // nav.ts) — this only records the target tiles and invalidates; obstacle-revision
  // invalidation (a prop broke) rides the same lazy path inside the field queries.
  let keyHash = 0;
  let anyUp = false;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.isAbsent || pl.hp <= 0) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(pl.y / TILE) * d.w + Math.floor(pl.x / TILE)) | 0;
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(r.y / TILE) * d.w + Math.floor(r.x / TILE)) | 0;
  }
  const tileChanged = anyUp && keyHash !== w.flowKey;
  if (w.flowCd > 0 && !tileChanged) return;
  w.flowCd = C.FLOW_REBUILD;
  w.flowKey = keyHash;

  const srcs = w.flowSources;
  srcs.length = 0;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.isAbsent || pl.hp <= 0) continue;
    const tx = Math.floor(pl.x / TILE), ty = Math.floor(pl.y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) continue;
    srcs.push(ty * d.w + tx);
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    const rtx = Math.floor(r.x / TILE), rty = Math.floor(r.y / TILE);
    if (rtx < 0 || rty < 0 || rtx >= d.w || rty >= d.h) continue;
    srcs.push(rty * d.w + rtx);
  }
  markNavTargets(w.nav, srcs);
}

// Does any live prop's collision ring cut the straight corridor from (x0,y0) to (x1,y1)
// for a body of radius `r`? The full radius sum keeps the same conservative margin the
// local steering uses, so "corridor clear" always means "actually walkable".
function propOnSegment(w: WorldState, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const ux = dx / len, uy = dy / len;
  for (const p of w.props) {
    if (p.dead) continue;
    const rr = r + p.radius;
    const t = Math.max(0, Math.min(len, (p.x - x0) * ux + (p.y - y0) * uy));
    const cx = x0 + ux * t - p.x, cy = y0 + uy * t - p.y;
    if (cx * cx + cy * cy < rr * rr) return true;
  }
  return false;
}

// The chase heading: direct when the straight corridor is genuinely walkable (wall LOS
// AND no prop ring across it), otherwise the next waypoint of the prop-aware flow route
// for this body's clearance class. Close range always commits to the direct line — the
// finishing layer (avoidPropAhead + the stuck net in applyChaseStep) rounds a final
// single prop far better than tile-resolution routing, and contact must never stall on
// grid quantization. The route is what fixes the live wedge: rows, corners and concave
// pockets are simply not part of the field, so steering can no longer be lured into them.
function chaseAngle(w: WorldState, e: Enemy): number {
  const direct = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  if (hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    const dx = w.targetX - e.x, dy = w.targetY - e.y;
    if (dx * dx + dy * dy <= C.NAV_DIRECT_RANGE * C.NAV_DIRECT_RANGE) return direct;
    if (!propOnSegment(w, e.x, e.y, w.targetX, w.targetY, e.radius)) return direct;
  }
  const field = chaseFieldFor(w, e.radius);
  if (navStepPoint(field, e.x, e.y)) return Math.atan2(navPoint.y - e.y, navPoint.x - e.x);
  return direct;
}

function slimeHopPulse(e: Enemy): number {
  return 1 + C.SLIME_HOP_AMOUNT * Math.sin(e.hopClock * C.SLIME_HOP_FREQ);
}

// Enrage (rolled elite affix): dead-amber veins heat as HP drops, closing the gap faster the
// more bloodied the body is. APPROACH speed only — committed lethal dashes move by their own
// baked step, never through here, so the telegraph read stays honest. 1 for everyone else.
function enrageMoveMult(e: Enemy): number {
  if (e.rollAffix !== "enrage" || e.maxHp <= 0) return 1;
  const bloodied = 1 - Math.max(0, Math.min(1, e.hp / e.maxHp));
  return 1 + ROLL_AFFIX.enrageMaxSpeedBonus * bloodied;
}

function applyChaseStep(w: WorldState, e: Enemy, dt: number, angle: number, step: number): void {
  step *= enrageMoveMult(e);
  // Local obstacle avoidance: props aren't in the flow field, so a chaser would otherwise
  // grind straight into a barrel/crate and wedge. Steer smoothly around the nearest
  // blocking prop instead.
  angle = avoidPropAhead(w, e, angle, dt);
  const x0 = e.x, y0 = e.y;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  const moved = Math.hypot(e.x - x0, e.y - y0);
  const isBlocked = step > C.STUCK_MIN_STEP && moved < step * C.STUCK_PROGRESS;
  e.stuckTimer = isBlocked ? e.stuckTimer + dt : 0;
  if (e.stuckTimer < C.STUCK_TIME) return;
  e.stuckTimer = 0;
  // Wedged despite the steering (a geometry corner, or a prop flush against a wall): a
  // strong perpendicular escape preferring the committed detour side, then the other side,
  // then a hard back-diagonal. Whichever side the escape actually took BECOMES the
  // commitment, so the following steering keeps rounding the same way instead of shoving
  // straight back into the prop.
  const side = e.avoidSide !== 0 ? e.avoidSide : Math.sin(e.zig) >= 0 ? 1 : -1;
  const esc = step * 1.6;
  e.avoidSide = side;
  e.avoidTime = C.AVOID_COMMIT;
  if (nudgeEnemy(w, e, angle + side * C.HALF_PI, esc)) return;
  if (nudgeEnemy(w, e, angle - side * C.HALF_PI, esc)) { e.avoidSide = -side; return; }
  nudgeEnemy(w, e, angle + side * (Math.PI * 0.75), esc);
}

// Steer a chaser around the nearest live prop blocking its path, or return `angle` when the
// way is clear. Three properties keep enemies from wedging on barrels/crates (the playtest
// complaint):
//  - the whole swept CORRIDOR ahead is tested (radius sum wide, AVOID_LOOKAHEAD deep), not a
//    single probe point, so an offset prop that would still clip the body is seen;
//  - the deflection is the TANGENT past the prop's edge — gentle at range, growing to a
//    perpendicular slide when touching — instead of a fixed 45° kink;
//  - the detour side is COMMITTED for a short window (e.avoidSide/avoidTime), so a dead-on
//    approach can't ping-pong left/right into the prop every tick, and a row of props is
//    rounded consistently along one flank.
function avoidPropAhead(w: WorldState, e: Enemy, angle: number, dt: number): number {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let hit: Prop | null = null;
  let hitDist = Infinity;
  for (const p of w.props) {
    if (p.dead) continue;
    const dx = p.x - e.x, dy = p.y - e.y;
    const rr = e.radius + p.radius;
    const fwd = dx * cos + dy * sin;
    if (fwd < 0 || fwd > rr + C.AVOID_LOOKAHEAD) continue; // behind, or beyond the lookahead
    if (Math.abs(dx * sin - dy * cos) >= rr) continue;     // outside the swept corridor
    const d = Math.hypot(dx, dy);
    if (d < hitDist) { hit = p; hitDist = d; }
  }
  if (!hit) {
    if (e.avoidTime > 0) {
      e.avoidTime = e.avoidTime > dt ? e.avoidTime - dt : 0;
      if (e.avoidTime === 0) e.avoidSide = 0;
    }
    return angle;
  }
  const toProp = Math.atan2(hit.y - e.y, hit.x - e.x);
  if (e.avoidSide === 0) {
    // A fresh detour follows the side the heading is already biased toward; a dead-on
    // approach picks whichever side has open room (deterministic zig tiebreak).
    let diff = angle - toProp;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    e.avoidSide = Math.abs(diff) > 0.08 ? (diff >= 0 ? 1 : -1) : clearerSide(w, e, toProp);
  }
  e.avoidTime = C.AVOID_COMMIT;
  const clear = e.radius + hit.radius + C.AVOID_CLEARANCE;
  const tangent = hitDist > clear ? Math.asin(clear / hitDist) : C.HALF_PI;
  return toProp + e.avoidSide * tangent;
}

// Which flank of a blocking prop has open room: probe one point past the body on each side,
// perpendicular to the prop direction. A tie falls back to the seeded zig heading, so the
// pick is stable and deterministic.
function clearerSide(w: WorldState, e: Enemy, toProp: number): number {
  const px = -Math.sin(toProp), py = Math.cos(toProp);
  const reach = e.radius + C.AVOID_SIDE_PROBE;
  const isOpen = (side: number): boolean => {
    const x = e.x + px * side * reach, y = e.y + py * side * reach;
    return !isWall(w, x, y) && !blockedByProp(w, x, y, e.radius);
  };
  const left = isOpen(1), right = isOpen(-1);
  if (left !== right) return left ? 1 : -1;
  return Math.sin(e.zig) >= 0 ? 1 : -1;
}

function nudgeEnemy(w: WorldState, e: Enemy, angle: number, step: number): boolean {
  const x0 = e.x, y0 = e.y;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  return Math.hypot(e.x - x0, e.y - y0) > step * C.STUCK_PROGRESS;
}

function stepWindupTimer(w: WorldState, e: Enemy, dt: number, dur: number, lockAt: number, isAoe: boolean): boolean {
  const a = e.attack;
  a.time += dt;
  a.windup = a.time < dur ? a.time / dur : 1;
  if (!a.isAimLocked) {
    if (findTarget(w, e.x, e.y)) {
      a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      if (isAoe) { a.markX = w.targetX; a.markY = w.targetY; }
    }
    if (a.time >= lockAt) a.isAimLocked = true;
  }
  return a.time >= dur;
}

function beginWindup(e: Enemy, move: AttackMove): void {
  const a = e.attack;
  a.phase = "windup"; a.time = 0; a.move = move; a.windup = 0; a.isAimLocked = false;
}
function enterRecover(e: Enemy): void { const a = e.attack; a.phase = "recover"; a.time = 0; a.windup = 0; }
function enterIdle(e: Enemy): void { const a = e.attack; a.phase = "none"; a.time = 0; a.move = "none"; a.windup = 0; }

function moveEnemyBy(w: WorldState, e: Enemy, dx: number, dy: number): void {
  if (e.chill > 0) {
    const s = chillMoveScale(e);
    dx *= s; dy *= s;
  }
  // Baby Slime SLIMETRAIL: a body crossing a live slime patch is slowed (bosses immune, elites
  // half). Allies never call this path, so "allies unaffected" holds by construction.
  if (w.hazards.length > 0) {
    const s = slimeSlowMult(w, e);
    if (s !== 1) { dx *= s; dy *= s; }
  }
  if (ENEMY_ARCHETYPES[e.kind].isPhasing) {
    e.x = Math.max(TILE, Math.min((w.dungeon.w - 1) * TILE, e.x + dx));
    e.y = Math.max(TILE, Math.min((w.dungeon.h - 1) * TILE, e.y + dy));
  } else {
    [e.x, e.y] = moveCircle(w, e.x, e.y, e.radius, dx, 0);
    [e.x, e.y] = moveCircle(w, e.x, e.y, e.radius, 0, dy);
  }
}

function spawnEnemyBullet(w: WorldState, x: number, y: number, angle: number, speed: number, radius: number, damage: number, color: string, life: number): void {
  w.bullets.push({
    x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    radius, life, friendly: false, owner: null, damage, color,
    pierce: 0, hitList: null, isCrit: false,
  });
}

// ---- enemy -> environment destruction ----

// The authoritative environment-damage path for enemy commitments (charges, slams,
// pounces, eruptions — every caller is a fully telegraphed move, so the wreckage is
// as dodge-readable as the hit itself). Props splinter through the ordinary destroyProp
// pipeline WITHOUT an owner: chained explosive barrels hurt everything but their kills
// credit NO player (the departed-actor ownership contract), and crate/pot spills stay
// ordinary first-come world loot. Wood chests burst open and eject their contents away
// from the impact onto standable floor.
function enemySmashEnvironment(w: WorldState, x: number, y: number, radius: number, ev: SimEvent[]): void {
  for (const p of w.props) {
    if (p.breakT !== undefined || p.kind === "brazier") continue;
    if (Math.hypot(p.x - x, p.y - y) <= radius + p.radius) destroyProp(w, p, ev);
  }
  for (const c of w.chests) {
    if (c.opened || c.kind !== "wood") continue;
    if (Math.hypot(c.x - x, c.y - y) <= radius + c.radius) smashOpenChest(w, c, x, y, ev);
  }
}

// A rusher plows THROUGH the furniture: splinter everything at the body's leading edge,
// BEFORE the move resolves (called per active-rush tick — the lane telegraph already drew
// exactly this corridor). The pad must clear moveCircle's prop-collision ring
// (prop radius × 0.8 ≈ 12px), or the rush would wedge against the crate it was about to
// smash and read the stall as a wall crash.
const RUSH_SMASH_PAD = 16;
function rushSmashEnvironment(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  enemySmashEnvironment(w, e.x, e.y, e.radius + RUSH_SMASH_PAD, ev);
}

// ---- the F10 Miniboss Gauntlet (corrected gate §3, exact formula) ----
// A stage machine, not a boss: once the floor's living pressure, its summons AND its
// hazards are all cleared, the authored 5s intermission passes and the next CAPTAIN
// enters the arena — the Charger commander with simple adds, the Shielder elite with
// ranged adds, then the brute Burrower alone — strictly sequential, never simultaneous.
// Captains carry round10(.28/.32/.40 × calibrated Marrow HP), party-scaled independently
// at each spawn, and run two phases split at 50% with one 0.8s non-invulnerable
// transition (no floor, no overflow — see the captain check in updateEnemies). +1 heart
// drops only after round 2; the full clear drops the premium boss chest (P+1 weapon
// choices led by the gauntlet's signature + the rare blessing offer).

function updateGauntlet(w: WorldState, dt: number, ev: SimEvent[]): void {
  const g = w.gauntlet;
  if (!g || w.isRunOver || g.isRewarded) return;
  if (w.enemies.some((e) => !e.dead) || w.pendingSpawns.length > 0 || w.hazards.length > 0) {
    // The intermission runs only after R1/R2 (the first captain enters as soon as the
    // approach is down; the reward follows the final kill on the same beat).
    g.breath = g.stage > 0 && g.stage < GAUNTLET.rounds.length ? GAUNTLET.intermission : 0;
    return;
  }
  g.breath -= dt;
  if (g.breath > 0) return;
  if (g.stage < GAUNTLET.rounds.length) {
    spawnGauntletRound(w, GAUNTLET.rounds[g.stage], ev);
    g.stage++;
    // The gate's +1 heart lands only after round 2 clears — i.e. alongside R3's entrance.
    if (g.stage - 1 === GAUNTLET.heartAfterRound) {
      const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
      w.pickups.push(makePickup(w, "heart", (arena.cx + 0.5) * TILE + 40, (arena.cy + 0.5) * TILE, ev));
    }
    return;
  }
  // Sequence complete: the premium reward stands where the last captain fell.
  g.isRewarded = true;
  const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  w.chests.push({
    id: w.nextChestId++, kind: "boss",
    x: (arena.cx + 0.5) * TILE, y: (arena.cy + 0.5) * TILE,
    radius: 18, opened: false, weapon: GAUNTLET.chestWeapon,
  });
  ev.push({ t: "cue", name: "bossSpawn", x: (arena.cx + 0.5) * TILE, y: (arena.cy + 0.5) * TILE, rate: 1.3, gain: 0.8, trauma: 0.1 });
}

function spawnGauntletRound(w: WorldState, round: (typeof GAUNTLET.rounds)[number], ev: SimEvent[]): void {
  const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  const cx = (arena.cx + 0.5) * TILE, cy = (arena.cy + 0.5) * TILE;
  const spawnAt = (kind: Enemy["kind"], tier: Enemy["tier"], x: number, y: number, isSummoned: boolean): Enemy | null => {
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES[kind].radius)) return null;
    const e = createEnemy(kind, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      tier, isSummoned, players: w.encounterPlayers,
    });
    w.enemies.push(e);
    ev.push({ t: "enemySpawn", eid: e.id, kind: e.kind, tier: e.tier, x: e.x, y: e.y });
    return e;
  };
  const captain = spawnAt(round.kind, round.tier, cx, cy, false);
  if (captain) {
    // Gate formula: round10(hpFrac × calibrated Marrow HP), party-scaled at THIS spawn.
    const hp = Math.round((gauntletCaptainHp(round) * coopBossHpMult(w.encounterPlayers)) / 10) * 10;
    captain.hp = captain.maxHp = hp;
    captain.captainPhase = 1;
    ev.push({ t: "cue", name: "bossSpawn", x: captain.x, y: captain.y, rate: 0.8, gain: 0.9, trauma: 0.15 });
  }
  for (let i = 0; i < round.addCount; i++) {
    const ang = (i / round.addCount) * Math.PI * 2;
    spawnAt(round.addKind ?? "slime", round.addTier, cx + Math.cos(ang) * 70, cy + Math.sin(ang) * 70, true);
  }
}

// The captain's two-phase contract: crossing 50% triggers ONE 0.8s stagger — the current
// windup drops and the next commitment waits — with no invulnerability, no damage
// reduction, and no HP floor (a big hit may carry straight through the threshold).
function tickCaptainPhase(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (e.captainPhase !== 1 || e.dead || e.hp > e.maxHp * GAUNTLET.captainPhaseAt) return;
  e.captainPhase = 2;
  if (e.attack.phase === "windup") enterIdle(e);
  e.spawnTimer = Math.max(e.spawnTimer, GAUNTLET.captainTransition);
  e.attack.cooldown = Math.max(e.attack.cooldown, GAUNTLET.captainTransition);
  // The miniboss templates mirror the phase onto the aux channel (the client's marshal
  // shield render keys off it; captainPhase itself never travels the wire).
  if (isMinibossKind(e.kind)) e.aux = 2;
  // Per-template phase beat: the Root Marshal's shield shatters into destructible cover.
  if (e.kind === "marshal") marshalShatterShield(w, e, ev);
  ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 1.1, gain: 0.7, trauma: 0.08 });
}

// ---- dynamic hazards (webs / cinders / volatile charges) ----

// The dash rips the silk out of the floor: webs overlapping the dashing body are
// removed for good. Movement counterplay with a real price — and the P3 lane bait.
function dashClearSilk(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  let cleared = false;
  for (const h of w.hazards) {
    if (h.kind !== "web" || h.life <= 0) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) >= h.radius + p.pr) continue;
    h.life = 0;
    cleared = true;
    ev.push({ t: "puff", x: h.x, y: h.y, n: 4, color: "#c98bff" });
  }
  if (!cleared) return;
  w.hazards = w.hazards.filter((h) => h.life > 0);
  if (p.mods.muddyDashRefund > 0 && !p.isMuddyRefundSpent) {
    const profile = floorDashProfile(w.floorDescriptor.mutators);
    p.dashCd = Math.max(0, p.dashCd - dashCooldown(p) * profile.cdMult * p.mods.muddyDashRefund);
    p.isMuddyRefundSpent = true;
    ev.push({
      t: "blessingProc", pid: p.id, item: "second_breath_muddy",
      phase: "refunded", x: p.x, y: p.y,
    });
  }
}

// PALE THRONE warmth-drain (the giant SIGNATURE): update this player's stillness timer and return
// the WALK slow. A per-player idle clock — moving warmthClearDist RESETS it (thaw), else it
// accumulates; past warmthIdleSec the walk is ×warmthChillMult (the shipped CHILL_SLOW; a single
// ×0.5, never stacking into a stun). Deterministic (position + dt, no rng). Returns 1 (a no-op)
// unless a warmth-drain giant is live, so every non-giant floor's speed calc is byte-identical.
function warmthDrainMult(
  w: WorldState,
  p: PlayerSim,
  isMoveIntentActive: boolean,
  dt: number,
  ev: SimEvent[],
): number {
  const wd = w.warmthDrain;
  if (!wd || p.isDown || p.isAbsent || p.hp <= 0) {
    resetPlayerWarmth(p);
    return 1;
  }
  const wasChilled = p.isWarmthChilled;
  if (isMoveIntentActive) {
    p.isWarmthChilled = p.warmthIdleSec >= wd.idleSec;
  } else {
    if (p.warmthIdleSec === 0) {
      ev.push({ t: "cue", name: "pale.warmthWarn", x: p.x, y: p.y, rate: 1, gain: 0.5, trauma: 0 });
    }
    p.warmthPathPx = 0;
    p.warmthIdleSec += dt;
    p.isWarmthChilled = p.warmthIdleSec >= wd.idleSec;
  }
  if (!wasChilled && p.isWarmthChilled) {
    ev.push({ t: "cue", name: "pale.warmthChill", x: p.x, y: p.y, rate: 1, gain: 0.65, trauma: 0 });
  }
  return p.isWarmthChilled ? wd.chillMult : 1;
}

function recordWarmthPath(
  w: WorldState,
  p: PlayerSim,
  isMoveIntentActive: boolean,
  selfDistance: number,
  ev: SimEvent[],
): void {
  const wd = w.warmthDrain;
  if (!wd || !isMoveIntentActive || selfDistance <= 0 || p.isDown || p.isAbsent || p.hp <= 0) return;
  p.warmthPathPx += selfDistance;
  if (p.warmthPathPx < wd.clearDist) return;
  resetPlayerWarmth(p);
  ev.push({ t: "cue", name: "pale.warmthClear", x: p.x, y: p.y, rate: 1, gain: 0.5, trauma: 0 });
}

function hazardMoveSlowMult(w: WorldState, x: number, y: number): number {
  // Pathmaker pave is silk-immune: a player center on live pave never takes Weaver web slow.
  if (isPavedAt(w, x, y)) return 1;
  let mult = 1;
  for (const h of w.hazards) {
    // Weaver silk (co-op) and PVP WAVE 2 tar_bloom both drag the WALK only (the dash rips free at
    // full speed at its own site). They never coexist (web is co-op, tar is the pvp arena), but we
    // take the STRONGEST slow if they ever did, so the rule is order-independent.
    if (h.kind !== "web" && h.kind !== "tar") continue;
    if (Math.hypot(x - h.x, y - h.y) >= h.radius) continue;
    mult = Math.min(mult, h.kind === "tar" ? WEATHER.tarMoveMult : WEAVER.webSlow);
  }
  return mult;
}

function updateHazards(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.hazards.length === 0) return;
  for (const h of w.hazards) {
    h.life -= dt;
    // PALE THRONE slag pools CREEP outward (the P2 motion-under-denial axis): a per-hazard drift
    // velocity migrates the pool across the floor (walls stop it). Only the giant's slag carries
    // vx/vy (set at plant); every other cinder/hazard is static, so this is inert elsewhere.
    if (h.vx !== undefined || h.vy !== undefined) {
      const nx = h.x + (h.vx ?? 0) * dt, ny = h.y + (h.vy ?? 0) * dt;
      if (!isWall(w, nx, ny)) { h.x = nx; h.y = ny; }
    }
    // A volatile charge detonates the instant its fuse runs out — the delayed shared burst.
    if (h.kind === "charge" && h.life <= 0) detonateCharge(w, h, ev);
    // PVP WAVE 2 · spark_mine: the telegraph fuse detonates once on expiry (a flat capped chip +
    // micro knockback through the pvp funnel). The `charge` pattern retargeted to pvp — inert in
    // co-op (nothing spawns a `spark` there).
    if (h.kind === "spark" && h.life <= 0) detonateSparkMine(w, h, ev);
    // An omen's beat is over: the ambush body it announced arrives (fair surprise §2).
    if (h.kind === "omen" && h.life <= 0) resolveOmen(w, h, ev);
    // Cinders burn any player standing in them; post-hit protection self-limits the ticks.
    if (h.kind === "cinder") cinderBurn(w, h, ev);
    // JET's corruption drains any player standing in it (post-hit protection self-limits the
    // ticks, like cinder) — zoning, not a DPS race. The bright authored edge is client-side.
    if (h.kind === "corrupt") corruptDrain(w, h, ev);
  }
  w.hazards = w.hazards.filter((h) => h.life > 0);
}

function corruptDrain(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0 || w.pendingBlessings.has(p.id)) continue;
    if (isPavedAt(w, p.x, p.y)) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) < h.radius) damagePlayer(w, p, JET.corruptDrain, ev);
  }
}

function cinderBurn(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0 || w.pendingBlessings.has(p.id)) continue;
    if (isPavedAt(w, p.x, p.y)) continue;
    if (p.petNullT > 0) continue; // Nullfin NULLWAKE: floor-hazard damage nulled for the window
    if (Math.hypot(p.x - h.x, p.y - h.y) < h.radius) damagePlayer(w, p, 1, ev);
  }
}

// The volatile elite's fused charge: a SHARED-risk burst — players take 1 (their
// protection rules apply), enemies take more, cover splinters. Ownerless by design
// (nobody's kill credit): the corpse's spite, not anyone's weapon.
function detonateCharge(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  ev.push({ t: "explosion", x: h.x, y: h.y, r: h.radius, src: "charge" });
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) <= h.radius) damagePlayer(w, p, ELITE_VOLATILE.playerDamage, ev);
  }
  for (const other of w.enemies) {
    if (other.dead || isUntargetable(other)) continue;
    if (Math.hypot(other.x - h.x, other.y - h.y) > h.radius + other.radius) continue;
    damageEnemy(w, null, other, ELITE_VOLATILE.enemyDamage, ev);
    ev.push({ t: "puff", x: other.x, y: other.y, n: 4, color: ENEMY_ARCHETYPES[other.kind].tint });
    if (other.hp <= 0 && !other.dead) killEnemy(w, null, other, ev);
  }
  enemySmashEnvironment(w, h.x, h.y, h.radius, ev);
}

// ---- the mob overlap arbiter (studio gate §2) ----
// "No two damage releases within 0.30s covering the same escape lane": before a REGULAR
// mob's committed windup may flip into its damage release, its release area must be clear
// of every release from the last 0.30s. Blocked commitments HOLD at full windup (telegraph
// stays up, no damage) and re-check each tick — the stagger is at most the window itself.
// Bosses are exempt: boss floors are authored end-to-end by their own §3 contracts.

const RELEASE_ARBITER_WINDOW = 0.30;
const RELEASE_LANE_CLEARANCE = 36; // a player body's diameter — the escape lane itself

function tickReleaseArbiter(w: WorldState, dt: number): void {
  if (w.recentReleases.length === 0) return;
  for (const r of w.recentReleases) r.t -= dt;
  w.recentReleases = w.recentReleases.filter((r) => r.t > 0);
}

function tryRelease(w: WorldState, x: number, y: number, radius: number): boolean {
  for (const r of w.recentReleases) {
    if (Math.hypot(x - r.x, y - r.y) < radius + r.radius + RELEASE_LANE_CLEARANCE) return false;
  }
  w.recentReleases.push({ x, y, radius, t: RELEASE_ARBITER_WINDOW });
  return true;
}

// The release area of a straight commitment (lunge/rush/bash): the swept lane,
// approximated as a circle over its middle.
function tryReleaseLane(w: WorldState, e: Enemy, angle: number, reach: number): boolean {
  const half = reach / 2;
  return tryRelease(w, e.x + Math.cos(angle) * half, e.y + Math.sin(angle) * half, half + e.radius);
}

// ---- props / chests / pickups ----

function updateProps(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.props.length === 0) return;
  let didBreakFinish = false;
  for (const p of w.props) {
    if (p.breakT !== undefined) {
      p.breakT += dt;
      if (p.breakT >= C.PROP_BREAK_DUR) didBreakFinish = true;
      continue;
    }
    if (p.kind === "brazier") continue;
    for (const b of w.bullets) {
      if (b.life <= 0) continue;
      // Breach shells are artillery over COVER too: crates cannot eat a lobbed shell the
      // way they eat direct fire (the blast still smashes props where it lands).
      if (b.isLob) continue;
      // Umbra rounds pass through props the same way they pass through walls: cover —
      // the room's OR the player's — simply is not theirs to hit.
      if (b.friendly && b.isPhase === true) continue;
      if (!sweptBulletHit(b, p.x, p.y, b.radius + p.radius)) continue;
      if (!b.friendly) {
        // Standing props are COVER: enemy fire is stopped by them — and spends them.
        // Ducking behind a crate against a spitter volley is a real play, with a real
        // cost. An enemy-detonated explosive barrel credits no one (destroyProp rules).
        p.hp -= b.damage;
        ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: sweptHit.x, y: sweptHit.y });
        b.life = 0;
        if (p.hp <= 0) { destroyProp(w, p, ev); break; }
        continue;
      }
      p.hp -= b.damage;
      ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: sweptHit.x, y: sweptHit.y });
      if (b.pierce <= 0) b.life = 0;
      if (p.hp <= 0) { destroyProp(w, p, ev, ownerOf(w, b.owner) ?? undefined); break; }
    }
    if (p.breakT === undefined) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (!swing || swing.timer <= 0) continue;
        const [sx, sy] = swingPose(w, player, swing);
        if (!isPointInMeleeHit(sx, sy, p.x, p.y, p.radius, swing)) continue;
        // Reuse the swing hitList with a stable negative prop id namespace to prevent
        // repeated damage every frame while the same swing overlaps the prop.
        const marker = -1 - p.id;
        if (swing.hitList?.includes(marker)) continue;
        (swing.hitList ??= []).push(marker);
        p.hp -= swing.damage;
        ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: p.x, y: p.y });
        if (p.hp <= 0) destroyProp(w, p, ev, player);
        break;
      }
    }
  }
  if (didBreakFinish) {
    w.props = w.props.filter((p) => p.breakT === undefined || p.breakT < C.PROP_BREAK_DUR);
  }
}

function dashBreakProps(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  for (const prop of w.props) {
    if (prop.breakT !== undefined || prop.kind === "brazier") continue;
    if (Math.hypot(p.x - prop.x, p.y - prop.y) < p.pr + prop.radius) destroyProp(w, prop, ev, p);
  }
}

// PHANTOM MARK (Wave 2): mark every enemy whose body the phantom's dash path sweeps through
// (+vuln for PHANTOM_MARK.durationTicks, non-stacking — a fresh pass REFRESHES), and if it caught
// at least one, REFUND PHANTOM_MARK.refundFrac of the cooldown just added. Resolved once at dash
// start along the swept segment (deterministic, once-per-dash). Decoys/mechanic bodies are fair
// game to mark (harmless — they take no meaningful damage). `refundBase` is the cooldown added.
function phantomDashMark(w: WorldState, p: PlayerSim, dist: number, refundBase: number): void {
  const ax = p.x, ay = p.y;
  const bx = p.x + p.dashDx * dist, by = p.y + p.dashDy * dist;
  const segLen2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  const markSec = ticksToSec(PHANTOM_MARK.durationTicks);
  let caught = false;
  for (const e of w.enemies) {
    if (e.dead) continue;
    // Closest point on the dash segment to the enemy center (t clamped to the segment).
    let t = segLen2 > 0 ? ((e.x - ax) * (bx - ax) + (e.y - ay) * (by - ay)) / segLen2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t;
    const rr = p.pr + e.radius;
    if ((e.x - cx) * (e.x - cx) + (e.y - cy) * (e.y - cy) > rr * rr) continue;
    e.markT = markSec; // non-stacking: refresh to the full window
    caught = true;
  }
  if (caught) p.dashCd = Math.max(0, p.dashCd - refundBase * PHANTOM_MARK.refundFrac);
}


// `by` is the player who destroyed the prop (bullet owner / melee / dash / chain source), so an
// explosive barrel credits its kills to the right player. A departed destroyer (undefined)
// still detonates the barrel — its damage credits no one and never another live player.
function destroyProp(w: WorldState, p: Prop, ev: SimEvent[], by?: PlayerSim): void {
  if (p.breakT !== undefined || p.kind === "brazier") return;
  p.dead = true;
  p.breakT = 0;
  // The blocking set changed: invalidate every navigation cache so routes flow through
  // the fresh gap on their next rebuild. Any future system that destroys cover (charges,
  // slams, environmental chains) goes through this same door and inherits the bump.
  w.obstacleRev++;
  switch (p.kind) {
    case "crate":
      ev.push({ t: "propBreak", kind: "crate", x: p.x, y: p.y });
      if (w.rng.next() < 0.6 * coinChanceTaper(w.floor)) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      if (w.rng.next() < SUSTAIN.crateHeartDrop * coopHeartRateMult(w.encounterPlayers)) {
        w.pickups.push(makePickup(w, "heart", p.x + 12, p.y, ev));
      }
      break;
    case "pot":
      ev.push({ t: "propBreak", kind: "pot", x: p.x, y: p.y });
      if (w.rng.next() < 0.35 * coinChanceTaper(w.floor)) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      break;
    case "barrel":
      ev.push({ t: "propBreak", kind: "barrel", x: p.x, y: p.y });
      if (w.rng.next() < 0.45 * coinChanceTaper(w.floor)) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      break;
    case "barrel_explosive":
      explodeBarrel(w, by ?? null, p, ev);
      break;
    // Worker constructions: cover either side spends, never loot (a rebuilding worker
    // must not be a coin farm) and never RNG (the stream stays untouched).
    case "root_wall": case "silt_mound": case "clinker_brick":
      ev.push({ t: "propBreak", kind: p.kind, x: p.x, y: p.y });
      break;
  }
}

// Effect weapons (Snapwire's snap, Razor Halo's blades, the Crooked Chain's sweep) chew
// cover the way bullets and melee do: subtract the strike's damage from a prop's hp and
// break it through the shared destroyProp door when it drops. Braziers and already-breaking
// props are immune. Returns true when the prop broke this call.
function damageProp(w: WorldState, p: Prop, damage: number, ev: SimEvent[], by: PlayerSim | null): boolean {
  if (p.breakT !== undefined || p.kind === "brazier") return false;
  p.hp -= damage;
  ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: p.x, y: p.y });
  if (p.hp <= 0) { destroyProp(w, p, ev, by ?? undefined); return true; }
  return false;
}

function explodeBarrel(w: WorldState, p: PlayerSim | null, source: Prop, ev: SimEvent[]): void {
  const r = C.BARREL_EXPLOSION_RADIUS;
  w.barrelExplosionsThisTick++;
  ev.push({ t: "explosion", x: source.x, y: source.y, r, src: "barrel" });
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    if (Math.hypot(e.x - source.x, e.y - source.y) > r + e.radius) continue;
    damageEnemy(w, p ? p.id : null, e, C.BARREL_EXPLOSION_DAMAGE, ev);
    ev.push({ t: "flash", eid: e.id });
    ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES[e.kind].tint });
    applyBurn(e, C.BARREL_BURN_SECS, p ? p.id : null, ev);
    if (e.hp <= 0 && !e.dead) killEnemy(w, p, e, ev);
  }
  for (const victim of w.players.values()) {
    if (!isProtected(victim) && !victim.isDown && !victim.isAbsent && victim.hp > 0
      && Math.hypot(victim.x - source.x, victim.y - source.y) <= r) {
      damagePlayer(w, victim, C.BARREL_EXPLOSION_SELF_DMG, ev);
    }
  }
  for (const other of w.props) {
    if (other === source || other.breakT !== undefined || other.kind === "brazier") continue;
    if (Math.hypot(other.x - source.x, other.y - source.y) > r + other.radius) continue;
    // Cap the per-tick cascade: once the chain budget is spent, explosive barrels caught in
    // the blast are LEFT standing (they can be set off again later) instead of all detonating
    // this frame. Non-explosive cover still breaks freely — it adds no explosion to the burst.
    if (other.kind === "barrel_explosive" && w.barrelExplosionsThisTick >= C.MAX_BARREL_EXPLOSIONS_PER_TICK) continue;
    destroyProp(w, other, ev, p ?? undefined);
  }
}

function updateChests(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.chests.length === 0) return;
  for (const c of w.chests) {
    if (!c.opened) {
      for (const b of w.bullets) {
        if (!b.friendly || b.life <= 0) continue;
        if (!sweptBulletHit(b, c.x, c.y, b.radius + c.radius)) continue;
        // The chest opener is the BULLET's owner (the actual shooter) — never a "primary" player.
        // If that shooter has since disconnected, the bullet still stops on the chest but opens
        // nothing (no one is there to receive the roll); the chest stays for live players.
        const opener = ownerOf(w, b.owner);
        if (opener) openChest(w, opener, c, ev);
        if (b.pierce > 0) b.pierce--; else b.life = 0;
        break;
      }
    }
    if (!c.opened) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (!swing || swing.timer <= 0) continue;
        const [sx, sy] = swingPose(w, player, swing);
        if (isPointInMeleeHit(sx, sy, c.x, c.y, c.radius, swing)) {
          openChest(w, player, c, ev);
          break;
        }
      }
    }
    if (c.opened) {
      if (c.openT !== undefined && c.openT < C.CHEST_OPEN_DUR) c.openT += dt;
      continue;
    }
    for (const p of w.players.values()) {
      if (!p.isDown && !p.isAbsent && p.hp > 0 && Math.hypot(p.x - c.x, p.y - c.y) < p.pr + c.radius) {
        openChest(w, p, c, ev);
        break;
      }
    }
  }
}

function openChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  c.opened = true;
  c.openT = 0;
  ev.push({ t: "chestOpen", kind: c.kind, x: c.x, y: c.y });
  // The full loot of the opening is decided first, then placed as ONE batch, so the fan
  // spreads coins, hearts and weapons together without stacking. Boss completion recovery
  // is the chest's +1 heart ONLY (no descent heal) plus the boss's authored SIGNATURE
  // weapon (see BOSS_SIGNATURE_WEAPON, baked at drop); its blessing offer is the floor's
  // reward — a Rare pick (see raiseBlessingOffer). Wood chests eject baked contents first
  // (the floor's weapon drop lives in this chest — see stockWeaponChests), then the
  // ordinary roll: the weapon replaces nothing, so the heart economy and pity behave
  // exactly as they always did per chest opened.
  const loot: ChestLoot[] = [];
  if (c.kind === "boss") {
    // Studio gate §4 boss weapon reward: P+1 DISTINCT personal choices (capped 5) — the
    // boss's authored signature weapon plus seeded distinct alternatives. Every player
    // claims exactly one (see updatePickups); a claim never removes a teammate's options.
    // (Only signature-bearing chests — every real boss drop — carry the choice set.)
    if (c.weapon !== undefined) {
      recordWeaponOffer(w.weaponBag, c.weapon);
      for (const member of w.players.values()) {
        recordWeaponOffer(member.weaponOfferHistory, c.weapon);
      }
      const choices: WeaponId[] = [c.weapon];
      // Alternates come from the run's shuffled bag, skipping the signature, this set,
      // and guns the whole party already owns — every pedestal is a real option. The
      // boss chest is the premium container: each alternate's rarity tier rolls with the
      // boosted legendary weight (see BOSS_CHEST_LEGENDARY_MULT).
      const exclude = weaponsOwnedByAll(w);
      exclude.add(c.weapon);
      while (choices.length < bossWeaponChoices(w.encounterPlayers)) {
        const pick = rollBagWeapon(w, () => w.rng.next(), exclude, { isPremium: true });
        if (choices.includes(pick)) break; // pool saturated: no duplicate pedestals
        choices.push(pick);
        exclude.add(pick);
      }
      for (const weapon of choices) loot.push({ kind: "weapon", weapon, isBossChoice: true });
    }
    loot.push({ kind: "heart" });
    for (let i = 0; i < 5; i++) loot.push({ kind: "coin" });
  } else {
    if (c.weapon !== undefined) loot.push({ kind: "weapon", weapon: c.weapon, isMystery: c.isMystery, twist: c.twist });
    loot.push(...rollWoodChest(w));
  }
  ejectChestLoot(w, c, loot, openerAngle(p, c), p.pr, ev);
  // The boss chest is the floor's reward for the WHOLE party: every member gets (and must
  // answer) their own Rare pick — never only whoever touched the chest first. Solo has one
  // player, so exactly one offer is raised, as before. (Absent bodies are skipped — their
  // pick can't be shown; the coherence system carries them to the next floor instead.)
  if (c.kind === "boss") {
    for (const member of w.players.values()) {
      if (!member.isAbsent) raiseBlessingOffer(w, member.id, true, ev);
    }
  }
}

// An enemy commitment bursts a wood chest open: the same deterministic contents, spilled
// through the same safe-spot fan but AWAY from the impact, with NO opener — everything it
// drops is ordinary first-come world loot, and no blessing machinery is touched (wood
// chests never carried one). Boss chests are the cleared floor's pedestal and are never
// smashable (see enemySmashEnvironment).
function smashOpenChest(w: WorldState, c: Chest, fromX: number, fromY: number, ev: SimEvent[]): void {
  c.opened = true;
  c.openT = 0;
  ev.push({ t: "chestOpen", kind: c.kind, x: c.x, y: c.y });
  const loot: ChestLoot[] = [];
  if (c.weapon !== undefined) loot.push({ kind: "weapon", weapon: c.weapon, isMystery: c.isMystery, twist: c.twist });
  loot.push(...rollWoodChest(w));
  const away = Math.atan2(c.y - fromY, c.x - fromX);
  ejectChestLoot(w, c, loot, away, 18, ev);
}

// The eject bearing for a player-opened chest: out toward the opener.
function openerAngle(p: PlayerSim, c: Chest): number {
  const dx = p.x - c.x, dy = p.y - c.y;
  return Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : C.HALF_PI;
}

type ChestLoot =
  | { kind: "coin" | "heart" }
  | { kind: "weapon"; weapon: WeaponId; isBossChoice?: boolean; isMystery?: boolean; twist?: MysteryTwist };

// Every drop a chest produces lands somewhere the collector can actually STAND — the old
// loose offsets (coins in a row, heart under the chest) could put loot inside a wall or
// a prop ring where the collect range never triggered: the unreachable coins of the
// playtest. Slots fan out from `base` (toward the opener, or away from whatever smashed
// the chest) so the batch reads as spilled loot. `pr` is the collector's clearance —
// the opener's own radius, or the standard 18px body for ownerless bursts.
function ejectChestLoot(w: WorldState, c: Chest, loot: ChestLoot[], base: number, pr: number, ev: SimEvent[]): void {
  const placed: { x: number; y: number }[] = [];
  for (let slot = 0; slot < loot.length; slot++) {
    const item = loot[slot];
    const [x, y] = chestLootSpot(w, c, base, slot, pr, placed);
    placed.push({ x, y });
    if (item.kind === "weapon") {
      w.pickups.push({
        id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon: item.weapon,
        isBossChoice: item.isBossChoice, isMystery: item.isMystery, twist: item.twist,
      });
      ev.push({ t: "lootDrop", x, y, color: item.isMystery ? MYSTERY_COLOR : WEAPON_RARITY_COLOR[WEAPONS[item.weapon].rarity] });
    } else {
      w.pickups.push(makePickup(w, item.kind, x, y, ev));
    }
  }
}

function chestLootSpot(w: WorldState, c: Chest, base: number, slot: number, pr: number, placed: { x: number; y: number }[]): [number, number] {
  // Deterministic candidate scan for one drop. Each slot prefers its own direction in the
  // fan (slot i starts at angle i), then walks the fixed angle order and the radii
  // inner-to-outer, so the preferred point loses only to the NEAREST safe candidate. The
  // first pass demands spacing from already-placed drops; the second gives that up rather
  // than land anywhere unsafe. A candidate must also have a walkable straight path from
  // the chest — a spot past a wall or a prop ring would be visible yet uncollectible.
  const angles = C.CHEST_EJECT_ANGLES;
  for (const sep of [C.CHEST_LOOT_SEPARATION, 0]) {
    for (const radius of C.CHEST_EJECT_RADII) {
      for (let k = 0; k < angles.length; k++) {
        const a = base + angles[(slot + k) % angles.length];
        const x = c.x + Math.cos(a) * radius;
        const y = c.y + Math.sin(a) * radius;
        if (!isStandableSpot(w, x, y, pr)) continue;
        if (!isPathOpen(w, c.x, c.y, x, y, pr)) continue;
        if (sep > 0 && placed.some((q) => Math.hypot(x - q.x, y - q.y) < sep)) continue;
        return [x, y];
      }
    }
  }
  // Everything around is blocked (a chest boxed in by props/walls): fall back to the
  // source chest's own rim — outside its sprite, ignoring only ITS hide-exclusion — and
  // finally to the chest's own tile, which is open floor by construction (see chestTile)
  // and right under the opener, who collects the drop the same tick.
  for (let k = 0; k < angles.length; k++) {
    const a = base + angles[(slot + k) % angles.length];
    const x = c.x + Math.cos(a) * C.CHEST_EJECT_RIM;
    const y = c.y + Math.sin(a) * C.CHEST_EJECT_RIM;
    if (isStandableSpot(w, x, y, pr, c)) return [x, y];
  }
  return [c.x, c.y];
}

function isStandableSpot(w: WorldState, x: number, y: number, pr: number, ignoreChest?: Chest): boolean {
  // Whether a player of radius `pr` can physically stand at (x, y) — open floor with a
  // margin on all sides (so a loot sprite never clips into a wall) and outside every live
  // prop's collision ring. Chests don't block movement but a drop under one would hide
  // the sprite, so they're excluded too; `ignoreChest` lifts that for the already-opened
  // source chest on the rim fallback.
  const m = C.CHEST_LOOT_WALL_MARGIN;
  if (isWall(w, x, y) || isWall(w, x - m, y) || isWall(w, x + m, y) || isWall(w, x, y - m) || isWall(w, x, y + m)) return false;
  if (blockedByProp(w, x, y, pr)) return false;
  for (const c of w.chests) {
    if (c === ignoreChest) continue;
    if (Math.hypot(x - c.x, y - c.y) < c.radius + 16) return false;
  }
  return true;
}

function isPathOpen(w: WorldState, x0: number, y0: number, x1: number, y1: number, pr: number): boolean {
  // Can a player walk the straight segment from (x0,y0) to (x1,y1)? Sampled finely enough
  // that no wall tile or prop ring fits between consecutive samples at these distances.
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (isWall(w, x, y) || blockedByProp(w, x, y, pr)) return false;
  }
  return true;
}

function rollWoodChest(w: WorldState): ChestLoot[] {
  // Wood chest table (§2/§6): heart 15%, weapon 7%, otherwise coins. Blessings no longer
  // drop from random chests — the reward cadence lives on descents and the boss chest.
  // The recovery pity, once armed, forces the heart. Decides WHAT drops only; placement
  // happens in ejectChestLoot, so the RNG stream stays exactly as it always was.
  if (w.isPityHeartArmed) {
    w.isPityHeartArmed = false;
    w.pityStreak = 0;
    return [{ kind: "heart" }];
  }
  const r = w.rng.next();
  const heartChance = SUSTAIN.woodChestHeart * coopHeartRateMult(w.encounterPlayers);
  if (r < heartChance) return [{ kind: "heart" }];
  // The ambient weapon window is IDENTICAL solo/co-op (gate §4: party quantity increases
  // options through the §4 counts only — never through drop rates). The id rides the
  // run's shuffled bag and skips universally-owned guns, so the rare ambient gun is
  // never a wasted duplicate while unowned guns remain.
  if (r < heartChance + SUSTAIN.woodChestWeapon) {
    return [{ kind: "weapon", weapon: rollBagWeapon(w, () => w.rng.next(), weaponsOwnedByAll(w)) }];
  }
  // The mystery band stacks AFTER the identified band (hearts/weapons keep their exact
  // rates) and only opens at MYSTERY.minFloor — early chests never gamble.
  const mysteryBand = w.floor >= MYSTERY.minFloor ? SUSTAIN.woodChestMystery : 0;
  if (r < heartChance + SUSTAIN.woodChestWeapon + mysteryBand) {
    return [{
      kind: "weapon",
      weapon: rollBagWeapon(w, () => w.rng.next(), weaponsOwnedByAll(w), { isMystery: true }),
      isMystery: true,
      twist: rollMysteryTwist(() => w.rng.next()),
    }];
  }
  const n = 3 + Math.floor(w.rng.next() * 4);
  const coins: ChestLoot[] = [];
  for (let i = 0; i < n; i++) coins.push({ kind: "coin" });
  return coins;
}

function updatePickups(w: WorldState, dt: number, ev: SimEvent[]): void {
  const remaining: Pickup[] = [];
  for (const p of w.pickups) {
    let collected = false;
    for (const player of w.players.values()) {
      if (player.isAbsent) continue; // a reserved body neither magnets nor collects loot
      if (player.mods.coinMagnet > 0 && p.kind === "coin" && !player.isDown) {
        const dx = player.x - p.x, dy = player.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && d < player.mods.coinMagnet) {
          // Each magnet step resolves per-axis against walls (like moveCircle) so a coin
          // slides along a wall toward its owner but can never be dragged THROUGH one
          // into a tile the player can't reach.
          const pull = Math.min(d, player.mods.coinMagnetPull * dt);
          const sx = (dx / d) * pull, sy = (dy / d) * pull;
          if (!isWall(w, p.x + sx, p.y)) p.x += sx;
          if (!isWall(w, p.x, p.y + sy)) p.y += sy;
        }
      }
      if (!player.isDown && Math.hypot(player.x - p.x, player.y - p.y) < player.pr + p.radius) {
        if (p.kind === "coin") { player.coins += p.value ?? coinGain(w, player); ev.push({ t: "pickup", pid: player.id, kind: "coin", x: p.x, y: p.y }); collected = true; break; }
        if (p.kind === "heart") {
          // At full HP the heart is consumed and converts to coins (§2) — no backtracking
          // stockpile of floor hearts.
          if (player.hp < player.maxHp) { player.hp++; ev.push({ t: "pickup", pid: player.id, kind: "heart", x: p.x, y: p.y }); }
          else { player.coins += SUSTAIN.fullHpHeartCoins; ev.push({ t: "pickup", pid: player.id, kind: "coin", x: p.x, y: p.y }); }
          collected = true; break;
        }
        if (p.kind === "weapon" && p.weapon) {
          if (isPvp(w) && !isPvpWeaponSupported(p.weapon)) continue;
          // A full hotbar NEVER auto-collects (MAX_OWNED_WEAPONS): the weapon stays on the
          // floor and the swap command (swapWeaponInWorld) is the only claim path — the
          // client surfaces that as the swap-or-leave prompt. `continue` (not break) so a
          // teammate with room can still take it this same tick.
          if (player.ownedWeapons.length >= weaponCapFor(player)) continue;
          if (p.isBossChoice) {
            // Gate §4 boss reward: one personal CLAIM per player per boss chest. Claiming a
            // weapon the player already owns grants one seeded REROLL (never coins/raw
            // damage); the pedestal itself persists for teammates either way.
            if (player.hasClaimedBossChoice) continue;
            player.hasClaimedBossChoice = true;
            let grant = p.weapon;
            if (player.ownedWeapons.includes(p.weapon)) {
              grant = drawWeaponFromBag(w.weaponBag, new Set(player.ownedWeapons));
              recordWeaponOffer(player.weaponOfferHistory, grant);
            }
            acquireWeapon(w, player, grant);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
            continue;
          }
          if (p.isMystery) {
            // The reveal moment: the baked identity is granted — rerolled into something
            // the collector does NOT own if they already carry it (never a dead result) —
            // and the baked blessed/cursed twist lands (after the equip, so a cursed jam
            // survives equipWeapon's cooldown reset). First-come, like every pickup.
            acquireWeapon(w, player, revealMysteryPickup(w, player, p, ev));
            applyMysteryTwist(player, p.twist ?? "plain", ev);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
            collected = true; break;
          }
          if (!player.ownedWeapons.includes(p.weapon)) {
            acquireWeapon(w, player, p.weapon);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
            collected = true; break;
          }
        }
      }
    }
    if (!collected) remaining.push(p);
  }
  w.pickups = remaining;
  // Boss-choice pedestals clear only once every living player has claimed — until then a
  // claim leaves every remaining option standing for the others.
  if (w.pickups.some((p) => p.isBossChoice)) {
    let allClaimed = true;
    for (const player of w.players.values()) {
      if (!player.isDown && player.hp > 0 && !player.hasClaimedBossChoice) { allClaimed = false; break; }
    }
    if (allClaimed) w.pickups = w.pickups.filter((p) => !p.isBossChoice);
  }
}

// Environmental hazards (depth escalation): advance the shared pulse clock, drag players
// caught by an active void rift toward its core, and land floor damage on any standing
// player over an active hazard tile. Fairness contract: every pulse hazard has already
// telegraphed (cycle math in hazards.ts), pools are permanently visible, damage is always
// 1, and both the dash iframe and post-hit protection gate it — the exact protection
// rules enemy contact obeys. Hazards never touch enemies: bodies are the encounter
// designer's pressure, the floor is the player's problem.
function updateFloorHazards(w: WorldState, dt: number, ev: SimEvent[]): void {
  w.floorHazardClock += dt;
  if (w.floorHazards.length === 0) return;
  for (const p of w.players.values()) {
    // A blessing-picking player is fully paused AND shielded (see stepPlayerPhase /
    // damagePlayer); the rift drag must respect the same freeze — nothing may move a
    // player who cannot answer.
    if (p.isDown || p.hp <= 0 || w.pendingBlessings.has(p.id)) continue;
    if (isPavedAt(w, p.x, p.y) || isOnLampPatch(w, p.x, p.y)) continue;
    // Rift drag: escapable pressure (85px/s against a 200px/s walk), through the normal
    // wall-aware move so it can never push a player into geometry, and line-of-sight
    // gated so a rift never pulls through a wall.
    for (const h of w.floorHazards) {
      if (h.kind !== "void_rift" || floorHazardPhaseAt(h, w.floorHazardClock) !== "active") continue;
      const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
      const dx = cx - p.x, dy = cy - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1 || dist > RIFT_PULL_RADIUS) continue;
      if (!hasLineOfSight(w, p.x, p.y, cx, cy)) continue;
      const step = Math.min(dist, RIFT_PULL_SPEED * dt);
      const [nx, ny] = moveCircle(w, p.x, p.y, p.pr, (dx / dist) * step, (dy / dist) * step);
      p.x = nx;
      p.y = ny;
    }
    if (isProtected(p)) continue;
    // Nullfin NULLWAKE: a live window nulls floor-hazard damage (never the rift drag above, which
    // is displacement not damage, and never any objective's required hazard presence).
    if (p.petNullT > 0) continue;
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    for (const h of w.floorHazards) {
      if (h.tx !== tx || h.ty !== ty || !isFloorHazardDamaging(h, w.floorHazardClock)) continue;
      ev.push({ t: "hazardHit", pid: p.id, kind: h.kind, x: p.x, y: p.y });
      damagePlayer(w, p, FLOOR_HAZARD_DAMAGE, ev);
      break;
    }
  }
}

// Is there another player (or, on the legacy Convex co-op path, a remote target) still up who
// could revive `p`? Drives the authoritative down-vs-gameover decision. Network-absent bodies
// are EXCLUDED from the wipe calculus entirely (studio balance gate §6: "pending reconnect
// reservations do not block wipe"): an absent teammate can neither be counted dead (their
// disconnect never causes a wipe) nor counted standing (a reservation cannot keep a fully
// downed connected party alive — nobody absent can channel a revive).
function hasStandingAlly(w: WorldState, p: PlayerSim): boolean {
  for (const other of w.players.values()) {
    if (other === p || other.isAbsent) continue;
    if (!other.isDown && other.hp > 0) return true;
  }
  return w.isCoop && w.remoteTargets.some((r) => !r.isDown);
}

interface PvpHitContext {
  weapon: WeaponId;
  dirX: number;
  dirY: number;
  // Set ONLY at the direct gun-hit site when the attacker holds a live ember_edge charge. The
  // funnel adds the flat chip + the KB scalar and spends the charge (once). Undefined everywhere
  // else (splash / chain / melee / co-op), so ember never leaks past "the next 1 gun hit".
  isEmber?: boolean;
  // A FIXED knockback distance (px) that overrides the per-weapon KB table — the ambient
  // spark_mine's micro shove (PVP WAVE 2 · Pillar B). Undefined everywhere else, so weapon KB is
  // unchanged. Still clamped by kbMaxPerHit and nulled while protected, like every pvp knockback.
  kbDistance?: number;
  // PVP WAVE 3: a FLAT arena-ult hit whose `amount` is already the final PVP damage (e.g. the
  // arena_salvo per-shot 10). It skips the draft output-scale (arena ults are flat, never
  // draft-multiplied), but still honors the glass window + the per-tick anti-one-shot cap.
  isFlat?: boolean;
}

// The ONE player-damage funnel. `by` is the attacking player for kill attribution (bullet.owner
// / melee owner), null for enemy/environmental damage — plumbed through so pvp frag credit uses
// the SAME funnel, never a second damage path. Co-op callers omit `by` (defaults null), unchanged.
function damagePlayer(
  w: WorldState,
  p: PlayerSim,
  amount: number,
  ev: SimEvent[],
  by: PlayerId | null = null,
  pvpHit: PvpHitContext | null = null,
): void {
  if (w.isGodMode) return; // dev god mode; never set outside the sandbox
  // PHASE ult invuln (spec §2.4/§9.1): a brief, hard-capped (<= 1.2s) full-immunity window the
  // one damage funnel honours directly — an earned "get us out" button, never extending the
  // post-hit/dash iframes. Inert for the neutral baseline (ultInvuln stays 0).
  if (p.ultInvuln > 0) return;
  // A network-absent body is reserved, not playing: it cannot be hurt while its player has
  // no way to react (the reconnect-grace contract). Collision paths skip absent bodies too;
  // this is the belt-and-suspenders gate on the one damage funnel.
  if (p.isAbsent) return;
  // pvp: the FIXED-HP model, the anti-one-shot per-tick cap, frag attribution, and respawn
  // scheduling all live in the pvp branch of this ONE funnel (no second damage path).
  if (isPvp(w)) { damagePlayerPvp(w, p, amount, ev, by, pvpHit); return; }
  // A player mid-blessing-pick cannot be hurt. Offers are only raised on the safe side of a
  // transition (cleared floor), but the shared world keeps ticking under the chooser's menu
  // online — this shield covers the residue (a stray in-flight glob, a chained barrel).
  // BELOW the pvp branch by design: a mid-match PvP draft is free power, not a free combat
  // iframe. Its chooser is paused but remains vulnerable until the quick 1-of-3 decision lands.
  if (w.pendingBlessings.has(p.id)) return;
  // Hushiron flusher vulnerability (Quill FINAL): a ROOTED, ramped (stacks ≥ flusherStacks)
  // owner is exposed — an enemy hit lands a flat +1 and flushes the whole stance. A readable
  // counter to camping the ramp, never a silent per-hit HP tax (only while the iron is held
  // and fully ramped, which no other system triggers). BALANCER_TODO: the FILL scopes this to
  // hits that DISPLACE ≥24px; the central damage funnel has no displacement, so this pass
  // applies it to enemy-sourced hits and documents the approximation for the balancer gate.
  if (by === null && amount > 0 && p.weapon === "hushiron") {
    const stance = WEAPONS.hushiron.stance;
    if (stance !== undefined && p.hushStacks >= stance.flusherStacks) {
      amount += C.WAVE_C_HUSH_FLUSHER_DAMAGE;
      p.hushStacks = 0; p.hushStillT = 0; p.hushStackT = 0; p.hushVentT = 0;
    }
  }
  // BULWARK HARDENED (spec §2.3/§10): flat damage reduction with NO invuln, applied HERE in the
  // damage-taken math BEFORE any co-op/mode pressure, and clamped so total DR never stacks past
  // MAX_TOTAL_DR. Integer HP is preserved by SOAKING the reduced fraction into the passive
  // channel and negating only WHOLE points, so the realized reduction converges without fractions.
  if (p.kitId === "bulwark" && amount > 0) {
    // OVERSHIELD regen PAUSES for pauseTicks after taking ANY damage (the buffer is gone under
    // sustained fire) — set before the soak so even a fully-Hardened-soaked hit holds regen off.
    p.overshieldRegenT = Math.max(p.overshieldRegenT, OVERSHIELD.pauseTicks);
    const dr = Math.min(HARDENED.reduction, MAX_TOTAL_DR);
    p.passiveState += amount * dr;
    const negate = Math.floor(p.passiveState);
    if (negate > 0) {
      const applied = Math.min(negate, amount);
      amount -= applied;
      p.passiveState -= applied;
    }
    // OVERSHIELD absorbs BEFORE hearts (§10, within MAX_TOTAL_DR): each chip soaks 1 HP. No
    // post-hit iframe is granted while the shield eats a hit — that is exactly what lets sustained
    // fire drain the pool (never invuln). A fully-absorbed hit returns below without heart loss.
    if (p.overshield > 0 && amount > 0) {
      const absorbed = Math.min(p.overshield, amount);
      p.overshield -= absorbed;
      amount -= absorbed;
    }
  }
  // Pebble PEBBLEBRACE: the one-hit brace eats up to absorbMax of this hit, then is spent. Capped
  // at 2 so it is NEVER a lethal-save on a big blow (it only ever softens a hit by 2), and it
  // grants no iframe — it is orthogonal to Remember Me and the post-hit protection below.
  if (p.petShieldT > 0 && amount > 0) {
    const absorbed = Math.min(PET_ABILITY.pebblebrace.absorbMax, amount);
    amount -= absorbed;
    p.petShieldT = 0;
    ev.push({ t: "puff", x: p.x, y: p.y, n: 5, color: "#b9c4d6" });
  }
  if (p.bladeWardT > 0 && p.bladeWardAbsorb > 0 && amount > 0) {
    amount -= Math.min(p.bladeWardAbsorb, amount);
    p.bladeWardT = 0;
    p.bladeWardAbsorb = 0;
    ev.push({
      t: "blessingProc",
      pid: p.id,
      item: "blade_ward",
      phase: "absorbed",
      x: p.x,
      y: p.y,
    });
  }
  if (amount <= 0) return;
  // The ult meter charges off damage TAKEN for the tank (spec §2.3), normalized by the tank's
  // own maxHp (§10 target-agnostic), off the post-reduction amount.
  if (p.kitId === "bulwark") accrueUlt(p, "taken", ultChargeFromDamageTaken(amount, p.maxHp));
  // GUNNER MOMENTUM softened decay (Wave 2): a significant hit (>= 1 heart) loses significantLoss
  // stacks; a sub-heart chip loses chipLoss — a graze no longer WIPES the ramp, so it is
  // achievable in a boss fight. `amount` here is the post-reduction HP about to land. Only gunner
  // uses the passive channel for momentum; the other kits' channel is left untouched.
  if (p.kitId === "gunner" && p.passiveState > 0) {
    const loss = amount >= OVERHEAT.significantHitHp ? OVERHEAT.significantLoss : OVERHEAT.chipLoss;
    p.passiveState = Math.max(0, p.passiveState - loss);
  }
  p.hp -= amount;
  p.invuln = PLAYER.postHitInvuln;
  p.lastDamagedTick = w.tick; // arms the MENDER post-damage SELF-heal delay (self-heal only; ally heal is never gated)
  // Damage to the CHANNELER cancels the revive it was powering (gate §6) — identity-exact:
  // a bystander inside the radius taking a hit resets nothing.
  cancelReviveChannelBy(w, p.id);
  ev.push({ t: "playerHurt", pid: p.id, x: p.x, y: p.y });
  if (p.hp <= 0) {
    p.hp = 0;
    p.bladeWardT = 0;
    p.bladeWardAbsorb = 0;
    resetPlayerWarmth(p);
    p.chargeT = 0; // a held charge never survives going down
    // The banked REVIVE TOKEN (premium, cap 1): the lethal hit consumes it and the player
    // stands back up at the standard revive numbers — REVIVE.hp, the standard 1.0s
    // protection window (a revive, not a bonus invulnerability product), the standard
    // fire lockout via fireCd. It never prevents a wipe already in progress (everyone
    // else must still be alive for the timer to reset) and never skips a boss mechanic —
    // the hit LANDED; this only changes what comes after. See the difficulty flag in
    // balance.ts beside its steep price.
    if (p.reviveTokens > 0) {
      p.reviveTokens--;
      p.hp = REVIVE.hp;
      p.invuln = Math.max(p.invuln, REVIVE.invuln);
      applyActiveWeaponFireLock(p, REVIVE.fireLockout);
      ev.push({ t: "revive", pid: p.id, by: p.id, x: p.x, y: p.y });
      return;
    }
    // Remember Me (identity / sustain converter): survive one lethal hit per floor by
    // disabling the owner's best non-support blessing. Skips if nothing eligible to disable.
    if (p.rememberMeArmed && p.mods.rememberMeDisableDur > 0 && !p.isDown) {
      const target = rememberMeDisableTarget(p);
      if (target !== null) {
        p.rememberMeArmed = false;
        p.hp = 1;
        p.invuln = Math.max(p.invuln, 0.80);
        p.disabledBlessing = { id: target, life: p.mods.rememberMeDisableDur };
        recomputeMods(p.mods, activeItemIdsFor(p));
        applyMaxHpBonus(p);
        ev.push({ t: "blessingProc", pid: p.id, item: "remember_me", phase: "saved", x: p.x, y: p.y });
        return;
      }
    }
    if (w.isShared) {
      // Stage C (gate §6): going to 0 is always DOWN, never a direct cut — the wipe is the
      // held all-down beat in checkStrandedWipe (4.0s), which is also what lets a teammate's
      // last-moment revive (or a reconnect return) save the run. The per-floor down limit
      // is counted on the TRANSITION only (splash on an already-down body recounts nothing);
      // past the limit the player is OUT (unrevivable) until the descent rescue.
      if (!p.isDown) {
        p.isDown = true;
        p.reviveProgress = 0;
        p.reviveBy = null;
        p.downsThisFloor++;
      }
    } else if (hasStandingAlly(w, p)) {
      // Legacy local co-op: a teammate can still revive — go DOWN, not out.
      p.isDown = true;
      p.reviveProgress = 0;
      p.reviveBy = null;
    } else {
      // Solo death (local): end the run immediately, exactly as it always did. isRunOver
      // makes the terminal transition derivable from STATE, not only from the event.
      endRun(w, ev);
    }
  }
}

function pvpDraftOutputScale(w: WorldState, by: PlayerId | null, weapon: WeaponId): number {
  if (by === null) return 1;
  const attacker = w.players.get(by);
  if (attacker === undefined) return 1;
  const def = WEAPONS[weapon];
  const pellets = def.melee === undefined
    ? Math.max(1, def.pellets + attacker.mods.extraPellets)
    : 1;
  const critExpected = 1 + attacker.mods.critChance * Math.max(0, attacker.mods.critMult - 1);
  const outputPerSec = def.damage
    * currentDamageMult(attacker)
    * pellets
    * critExpected
    * currentFireRate(attacker)
    / def.fireCd
    * PVP.dmgMult
    * (PVP.weaponMult[weapon] ?? 1);
  const outputCap = PVP.maxHp / PVP.ttkMinSec;
  return outputPerSec > outputCap ? outputCap / outputPerSec : 1;
}

function applyPvpKnockback(w: WorldState, p: PlayerSim, hit: PvpHitContext | null, ev: SimEvent[], emberScalar = 1): number {
  if (hit === null) return 0;
  const protectionScale = isProtected(p) ? PVP.kbSelfDuringIframe : 1;
  const base = hit.kbDistance ?? C.WEAPON_KB[hit.weapon] * PVP.kbScalar;
  // brace_band: the first incoming knockback while a brace charge is banked is HALVED (never
  // nulled) and spends the charge — a soft anti-shove, not KB/pit immunity. Only a hit that
  // actually carries knockback (base > 0, not fully nulled by protection) consumes it.
  const isBraced = base > 0 && protectionScale > 0
    && ownsPvpCounter(w, p, PVP_COUNTER_BRACE) && p.pvpBraceCharge > 0;
  if (isBraced) { p.pvpBraceCharge = 0; p.pvpBraceRegenT = 0; }
  const braceScalar = isBraced ? KIT_COUNTERS.braceKbScalar : 1;
  const distance = Math.min(
    PVP.kbMaxPerHit,
    Math.max(0, base * emberScalar * braceScalar * protectionScale),
  );
  if (distance <= 0) return 0;
  const magnitude = Math.hypot(hit.dirX, hit.dirY) || 1;
  const dx = (hit.dirX / magnitude) * distance;
  const dy = (hit.dirY / magnitude) * distance;
  const beforeX = p.x;
  const beforeY = p.y;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, dx, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, dy);
  if (isBraced) {
    ev.push({ t: "blessingProc", pid: p.id, item: PVP_COUNTER_BRACE, phase: "brace", x: p.x, y: p.y });
    // Post-hit pit-warning pulse (presentation only): the braced body ended within a short ETA of
    // a pit edge. It changes no state — brace grants no pit immunity, only the readable heads-up.
    if (isPvpBracePitWarn(w, p)) {
      ev.push({ t: "blessingProc", pid: p.id, item: PVP_COUNTER_BRACE, phase: "pitwarn", x: p.x, y: p.y });
    }
  }
  return Math.hypot(p.x - beforeX, p.y - beforeY);
}

function isPlayerCenterInPvpPit(w: WorldState, p: PlayerSim): boolean {
  const tx = Math.floor(p.x / TILE);
  const ty = Math.floor(p.y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return false;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 2;
}

function recentPvpKnockbackSource(w: WorldState, p: PlayerSim): PlayerId | null {
  const by = p.lastPvpKnockbackBy;
  if (by === null || p.lastPvpKnockbackTick < 0) return null;
  return w.tick - p.lastPvpKnockbackTick <= pvpEnvKillCreditWindowTicks()
    && isValidPvpKillCreditSource(w, by)
    ? by
    : null;
}

function isValidPvpKillCreditSource(w: WorldState, by: PlayerId): boolean {
  const attacker = w.players.get(by);
  return attacker !== undefined && !attacker.isAbsent;
}

function awardPvpFrag(w: WorldState, by: PlayerId, x: number, y: number): SimEvent | null {
  const m = w.match;
  if (m === null || !isValidPvpKillCreditSource(w, by)) return null;
  m.scores.set(by, (m.scores.get(by) ?? 0) + 1);
  const attacker = w.players.get(by);
  if (attacker !== undefined) attacker.pvpDraftFrags++;
  const lastTick = m.lastFragTick.get(by);
  const isChain = lastTick !== undefined && w.tick - lastTick <= pvpChainWindowTicks();
  const chain = isChain ? (m.fragChain.get(by) ?? 1) + 1 : 1;
  m.lastFragTick.set(by, w.tick);
  m.fragChain.set(by, chain);
  return chain >= 2 ? { t: "pvpChainFrag", by, chain, x, y } : null;
}

function eliminatePvpPlayer(
  w: WorldState,
  p: PlayerSim,
  by: PlayerId | null,
  kind: "combat" | "ringOut",
  ev: SimEvent[],
): void {
  if (p.respawnT > 0) return;
  const creditedBy = by !== null
    && by !== p.id
    && isValidPvpKillCreditSource(w, by)
    ? by
    : null;
  const chainEvent = creditedBy === null ? null : awardPvpFrag(w, creditedBy, p.x, p.y);
  const telemetry = p.pvpRespawnTelemetry;
  if (telemetry !== null) {
    telemetry.isDeathWithin3s = telemetry.activeTicks <= pvpDeathWithinSpawnTicks();
    const killer = creditedBy === null ? undefined : w.players.get(creditedBy);
    telemetry.killerDistance = killer === undefined
      ? null
      : Math.hypot(killer.x - p.x, killer.y - p.y);
  }
  p.hp = 0;
  // stepPvpMatch runs later in this same world phase, so seed one extra tick; its immediate
  // decrement publishes the exact named delay and preserves the full 2.5s future countdown.
  p.respawnT = pvpRespawnDelayTicks() + 1;
  p.respawnWaitSafeT = 0;
  // Patch 0 B5: the dead body carries NOTHING into respawn — dash (time+velocity), fire/charge,
  // held swing, buffs. resetPvpLifeTransient zeroes the whole transient set (superset of the
  // prior chargeT/meleeSwing clear), so a death mid-dash can't slide the corpse.
  resetPvpLifeTransient(p);
  pvpClearOwnedEngagement(w, p.id);
  w.match?.lastFragTick.delete(p.id);
  w.match?.fragChain.delete(p.id);
  p.lastPvpHitBy = null;
  p.lastPvpHitTick = -1;
  p.lastPvpKnockbackBy = null;
  p.lastPvpKnockbackTick = -1;
  if (kind === "ringOut") {
    ev.push({ t: "pvpRingOut", by: creditedBy ?? "", victim: p.id, x: p.x, y: p.y });
  } else {
    ev.push({ t: "pvpKill", by: creditedBy ?? "", victim: p.id, x: p.x, y: p.y });
  }
  if (chainEvent !== null) ev.push(chainEvent);
}

// The pvp branch of the ONE damage funnel: fixed-HP model, anti-one-shot cap, frag credit +
// respawn scheduling. Damage lands only during the LIVE phase (countdown/lobby/over are safe).
// No post-hit iframe is granted (the PvE 0.8s window would swamp the balancer's ~4s TTK); the
// only pvp protections are the two-stage spawn window and dash iframes.
function damagePlayerPvp(
  w: WorldState,
  p: PlayerSim,
  amount: number,
  ev: SimEvent[],
  by: PlayerId | null,
  pvpHit: PvpHitContext | null,
): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  if (p.respawnT > 0 || p.hp <= 0) return; // already dead, awaiting respawn
  if (isProtected(p)) return;
  if (amount <= 0) return;
  // Arena ults are FLAT (their `amount` is already the final PVP damage); every other pvp hit is
  // scaled by the draft output cap. isFlat skips the cap but still honors glass + the per-tick cap.
  if (pvpHit !== null && pvpHit.isFlat !== true) amount *= pvpDraftOutputScale(w, by, pvpHit.weapon);
  // Contested-hearth ember_edge: a live charge on the ATTACKER adds a flat chip to this one gun
  // hit — post output-scale (a flat +8, never multiplied by drafts) and pre-cap (the anti-one-shot
  // clamp still bounds it). Only the direct gun-hit site sets isEmber, so splash/chain/melee are
  // never "the next gun hit".
  const attacker = by !== null && by !== p.id ? w.players.get(by) : undefined;
  const isEmberHit = pvpHit?.isEmber === true && attacker !== undefined && attacker.hearthEmberT > 0;
  if (isEmberHit) amount += HEARTH.emberBonusDamage;
  // PVP WAVE 3 arena_salvo GLASS: the caster runs +25% incoming for the whole tell+active window.
  // Read on the VICTIM (the casting gunner is more fragile while volleying), before the per-tick cap.
  if (p.arenaUlt.glassT > 0) amount *= ARENA_SALVO.glassIncomingMult;
  // Per-victim, per-tick cumulative clamp: no single tick (one trigger / pellet stack / crit)
  // may remove more than perHitCap HP. This is the hard anti-one-shot backstop that holds even
  // after per-weapon tuning.
  const cap = pvpPerHitCap();
  const already = m.dmgThisTick.get(p.id) ?? 0;
  amount = Math.min(amount, Math.max(0, cap - already));
  if (amount <= 0) return;
  // The charge is SPENT the instant its gun hit lands damage (never twice — a multi-pellet volley
  // or pierce chain reads hearthEmberT === 0 for every later hit this tick).
  if (isEmberHit && attacker !== undefined) attacker.hearthEmberT = 0;
  m.dmgThisTick.set(p.id, already + amount);
  if (by !== null) {
    const shieldBreaker = w.players.get(by);
    if (shieldBreaker !== undefined) breakPvpSpawnShield(w, shieldBreaker, ev);
  }
  if (by !== null && by !== p.id) {
    p.lastPvpHitBy = by;
    p.lastPvpHitTick = w.tick;
  }
  if (p.pvpRespawnTelemetry !== null && p.pvpRespawnTelemetry.firstDamageMs === null) {
    p.pvpRespawnTelemetry.firstDamageMs = Math.max(
      0,
      Math.round(p.pvpRespawnTelemetry.activeTicks * 1000 / TICKS_PER_SECOND),
    );
  }
  p.hp -= amount;
  // PVP WAVE 3 arena ult charge: the ATTACKER banks +0.35 meter points per 1 PVP damage DEALT
  // (fixed-point hundredths, clamped to the arena meter max). The neutral kitId is untouched — this
  // is a separate arena meter reusing the ultCharge field, never the co-op accrual path.
  if (attacker !== undefined) {
    attacker.ultCharge = clampArenaUltCharge(attacker.ultCharge + arenaUltChargeFromDamage(amount));
  }
  if (by !== null && by !== p.id) {
    w.pvpTelemetryEvents.push({
      t: "pvpDamage",
      by,
      victim: p.id,
      weapon: pvpHit?.weapon ?? PVP.startWeapon,
      damage: amount,
      victimHp: Math.max(0, p.hp),
    });
  }
  const knockback = applyPvpKnockback(w, p, pvpHit, ev, isEmberHit ? HEARTH.emberKbScalar : 1);
  if (knockback > 0 && by !== null && by !== p.id) {
    p.lastPvpKnockbackBy = by;
    p.lastPvpKnockbackTick = w.tick;
  }
  ev.push({ t: "playerHurt", pid: p.id, x: p.x, y: p.y });
  if (isPlayerCenterInPvpPit(w, p)) {
    eliminatePvpPlayer(w, p, recentPvpKnockbackSource(w, p), "ringOut", ev);
    return;
  }
  if (p.hp <= 0) eliminatePvpPlayer(w, p, by, "combat", ev);
}

// ---- PVP hit resolution (the mode-gated DAMAGE-TARGETING concern) --------------------------

// The ONE "can attacker `owner` damage player `target` right now?" predicate — the single team
// model EVERY owned-damage subsystem routes player-damage through (direct bullets, melee, AoE
// blasts, chain lightning, homing, deployables), so pvp is CONSISTENT (no weapon silently passes
// through a foe) and co-op is inert (players never damage players — the `friendly` pass-through is
// preserved). pvp only, live phase, FOES only, honouring spawn/dash i-frames + dead/respawning.
function canDamagePlayer(w: WorldState, owner: PlayerId | null, target: PlayerSim): boolean {
  if (owner === null || !isPvp(w)) return false;
  const m = w.match;
  if (m === null || m.phase !== "live") return false;
  // The ATTACKER must still be a present participant. A departed (removed) or network-absent
  // owner's round/swing deals NOTHING — no damage, no kill, no frag — so a body that left the
  // arena can never score a ghost frag (the old team-0 fallback silently let it). Its rounds
  // keep flying but fizzle at every foe (they are not a valid source).
  const shooter = w.players.get(owner);
  if (shooter === undefined
    || shooter.isAbsent
    || shooter.isDown
    || shooter.hp <= 0
    || shooter.respawnT > 0
    || shooter.spawnGraceT > 0) return false;
  // The TARGET must be a live, collidable foe. An absent body is RESERVED, not playing —
  // non-collidable and non-damageable — so a shot passes THROUGH it (never consuming the round's
  // life/pierce) and can still reach a live foe standing behind it.
  if (target.id === owner || target.isAbsent || target.hp <= 0 || target.respawnT > 0 || isProtected(target)) return false;
  return arePvpFoes({ team: shooter.team, id: owner }, { team: target.team, id: target.id });
}

// Apply an owned AoE/point hit to every FOE PLAYER within `radius` of (x,y) — the player twin of
// the strikeEnemy radius loops (detonate / implode / orbit / wire). Routes through the ONE
// predicate + the damagePlayer funnel (pvp model + per-tick cap + attribution), foes scanned
// id-sorted for determinism. No-op in co-op / outside a live match.
function pvpSplash(w: WorldState, owner: PlayerId | null, fx: WeaponId | null, x: number, y: number, radius: number, baseDmg: number, ev: SimEvent[]): void {
  if (owner === null || !isPvp(w)) return;
  const dmg = pvpHitDamage(fx ?? PVP.startWeapon, baseDmg);
  if (dmg <= 0) return;
  for (const vid of [...w.players.keys()].sort()) {
    const v = w.players.get(vid);
    if (v === undefined || !canDamagePlayer(w, owner, v)) continue;
    if (Math.hypot(v.x - x, v.y - y) > radius + v.pr) continue;
    damagePlayer(w, v, dmg, ev, owner, {
      weapon: fx ?? PVP.startWeapon,
      dirX: v.x - x,
      dirY: v.y - y,
    });
  }
}

// Chain lightning to FOE PLAYERS (the tesla/arc twin of arcLightning): from the struck foe, hop
// to the nearest not-yet-hit foe within range, `jumps` times, damage decaying per hop. Routes
// every hop through the ONE funnel. `hit` accumulates the pids already zapped (no re-hit).
function pvpChain(w: WorldState, owner: PlayerId | null, fx: WeaponId | null, fromX: number, fromY: number, jumps: number, range: number, baseDmg: number, hit: Set<PlayerId>, ev: SimEvent[]): void {
  let dmg = baseDmg, x = fromX, y = fromY;
  for (let j = 0; j < jumps; j++) {
    let best: PlayerSim | null = null;
    let bestD = range * range;
    for (const vid of [...w.players.keys()].sort()) {
      const v = w.players.get(vid);
      if (v === undefined || hit.has(v.id) || !canDamagePlayer(w, owner, v)) continue;
      const dx = v.x - x, dy = v.y - y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best === null) return;
    hit.add(best.id);
    ev.push({ t: "shockArc", eid: -1, x, y, tx: best.x, ty: best.y, tRadius: best.pr, dmg: pvpHitDamage(fx ?? PVP.startWeapon, dmg), color: "#7fe9ff", killed: false });
    damagePlayer(w, best, pvpHitDamage(fx ?? PVP.startWeapon, dmg), ev, owner, {
      weapon: fx ?? PVP.startWeapon,
      dirX: best.x - x,
      dirY: best.y - y,
    });
    x = best.x; y = best.y;
    dmg *= 0.7; // same geometric decay as the PvE arc
  }
}

// In pvp, owned ("friendly") rounds and swings resolve against NON-OWNER FOE players — the ONE
// thing the enemy resolve never does. It mirrors the enemy resolve exactly (swept collision,
// FIRE-TIME lag-comp rewind of the TARGET, per-weapon damage) but routes every hit through the
// single damagePlayer funnel with attribution. Runs only during the live match.
function resolvePvpHits(w: WorldState, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  // Victims are scanned in ID-SORTED order (never Map iteration order), so which foe an
  // overlapping round hits — and the per-tick cap + kill attribution when multiple sources
  // land the same tick — is byte-identical across servers.
  const victimIds = [...w.players.keys()].sort();
  // Reaper kill-shards spawned this pass, flushed AFTER the bullet loop (a fresh shard never
  // hit-tests inside the tick that spawned it — same contract as the enemy cascade).
  const shardSpawns: Bullet[] = [];

  // Owned bullets vs foe players, resolved in a CANONICAL order — attacker id, then each
  // attacker's own creation order (preserved by a STABLE sort) — NOT w.bullets/Map iteration
  // order. A reconnect reorders the players map (and thus bullet-creation order), so without this
  // the SAME-TICK damage order — which decides the 35% cap application and which source lands the
  // killing blow (`by`) — could differ between two servers on identical inputs. A departed or
  // absent owner's round keeps flying but is not a valid source (canDamagePlayer rejects it), so
  // it fizzles at every foe — no free frags after a departure.
  const ownedBullets = w.bullets.filter((b) => b.friendly && b.life > 0 && !b.isLob && b.owner !== null);
  ownedBullets.sort((x, y) => (x.owner! < y.owner! ? -1 : x.owner! > y.owner! ? 1 : 0));
  for (const b of ownedBullets) {
    const owner = b.owner;
    if (owner === null || b.life <= 0) continue;
    const rewind = fireTimeRewind(w, b.bornTick, b.lagRewind);
    for (const vid of victimIds) {
      const victim = w.players.get(vid);
      if (victim === undefined || !canDamagePlayer(w, owner, victim)) continue;
      if (b.hitPids && b.hitPids.indexOf(victim.id) !== -1) continue;
      const [vx, vy] = rewoundPlayerPos(w, victim, rewind);
      if (!sweptBulletHit(b, vx, vy, b.radius + victim.pr)) continue;
      // AoE rounds NEVER direct-hit: the blast/implosion IS the payload (the foe is inside its
      // own radius and takes exactly one splash), exactly as the enemy resolve treats them.
      if (b.blast !== undefined) { detonateBullet(w, b, sweptHit.x, sweptHit.y, ev); break; }
      if (b.implode !== undefined) { implodeBullet(w, b, sweptHit.x, sweptHit.y, ev); break; }
      // A direct bullet is "the next 1 gun hit" ember_edge spends on: flag it when the shooter
      // holds a live charge (the funnel adds the flat chip + KB scalar and consumes the charge).
      const shooter = w.players.get(owner);
      damagePlayer(w, victim, pvpHitDamage(b.fx ?? PVP.startWeapon, b.damage), ev, owner, {
        weapon: b.fx ?? PVP.startWeapon,
        dirX: b.vx,
        dirY: b.vy,
        isEmber: shooter !== undefined && shooter.hearthEmberT > 0,
      });
      // Reaper: a KILLING round bursts the foe into seeking shards (the cascade twin).
      if (victim.hp <= 0 && b.killShards !== undefined && b.killShards > 0) spawnKillShards(w, b, victim.x, victim.y, shardSpawns);
      // Tesla/arc: a chaining round leaps to nearby foes (the player twin of arcLightning).
      if (b.chain !== undefined && b.chain > 0) {
        pvpChain(w, owner, b.fx ?? null, victim.x, victim.y, b.chain, b.chainRange ?? 130, b.damage * 0.7, new Set<PlayerId>([victim.id]), ev);
        b.life = 0;
        break;
      }
      if (b.pierce > 0) { b.pierce--; (b.hitPids ??= []).push(victim.id); }
      else { b.life = 0; ev.push({ t: "bulletExpire", x: b.x, y: b.y, color: b.color }); break; }
    }
  }

  // Owned melee swings vs foe players. One hit per foe per swing (hitPids), over the swing's
  // multi-tick duration, both actors evaluated at the swing's fire-time pose (lag-comp).
  for (const aid of victimIds) {
    const attacker = w.players.get(aid);
    const swing = attacker?.meleeSwing;
    if (attacker === undefined || !swing || swing.timer <= 0) continue;
    const rewind = fireTimeRewind(w, swing.bornTick, swing.lagRewind);
    const [sx, sy] = swingPose(w, attacker, swing);
    for (const vid of victimIds) {
      const victim = w.players.get(vid);
      if (victim === undefined || !canDamagePlayer(w, attacker.id, victim)) continue;
      if (swing.hitPids && swing.hitPids.indexOf(victim.id) !== -1) continue;
      const [vx, vy] = rewoundPlayerPos(w, victim, rewind);
      if (!isPointInMeleeHit(sx, sy, vx, vy, victim.pr, swing)) continue;
      damagePlayer(w, victim, pvpHitDamage(attacker.weapon, swing.damage), ev, attacker.id, {
        weapon: attacker.weapon,
        dirX: Math.cos(swing.aim),
        dirY: Math.sin(swing.aim),
      });
      (swing.hitPids ??= []).push(victim.id);
    }
  }

  for (const s of shardSpawns) w.bullets.push(s);
}

function resolvePvpPits(w: WorldState, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (p === undefined || p.isAbsent || p.hp <= 0 || p.respawnT > 0 || isProtected(p)) continue;
    if (!isPlayerCenterInPvpPit(w, p)) continue;
    eliminatePvpPlayer(w, p, recentPvpKnockbackSource(w, p), "ringOut", ev);
  }
}

// ---- PVP match state machine (pure sim, TICK-based) ---------------------------------------

// The winner: most frags, ties broken by the LOWEST player id (id-sorted iteration + strict >),
// so two servers with identical inputs pick the identical winner. Null when there are no players.
function pvpTopScorer(w: WorldState): PlayerId | null {
  const m = w.match;
  if (m === null) return null;
  let best: PlayerId | null = null;
  let bestScore = -1;
  for (const id of [...w.players.keys()].sort()) {
    const s = m.scores.get(id) ?? 0;
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return best;
}

function clearPvpPendingDrafts(
  w: WorldState,
  ev: SimEvent[],
  outcome: "reset",
): void {
  for (const pid of [...w.pendingBlessings.keys()].sort()) {
    ev.push(...dismissBlessingOfferInWorld(w, pid, outcome));
    ev.push({ t: "blessingExpired", pid });
  }
}

function resetPvpDrafts(w: WorldState): void {
  for (const p of w.players.values()) {
    p.ownedItemIds = [];
    recomputeMods(p.mods, p.ownedItemIds, PVP.kit);
    p.maxHp = PVP.maxHp;
    p.hp = Math.min(p.hp, PVP.maxHp);
    p.pvpDraftFrags = 0;
    p.pvpDraftActiveTicks = 0;
    p.pvpDraftOrdinal = 0;
    p.pvpDraftTick = 0;
    p.pvpDraftTierBump = 0;
    p.pvpDraftTrigger = "none";
    p.pvpDraftOfferTicksLeft = 0;
    p.pvpDraftOfferElapsedTicks = 0;
    p.isPvpDraftDeathDelayReported = false;
    p.isPvpDraftAbsenceDelayReported = false;
  }
}

function pvpEndMatch(w: WorldState, winner: PlayerId | null, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase === "over") return;
  m.phase = "over";
  m.winner = winner;
  m.phaseEndTick = 0;
  clearPvpPendingDrafts(w, ev, "reset");
  resetPvpDrafts(w);
  m.weather = createWeatherDirector();
  clearPvpWeatherHazards(w);
  ev.push({ t: "pvpMatchOver", winner: winner ?? "" });
}

// Clear every per-LIFE movement/weapon/buff transient that must not survive a pvp death or carry
// across a (re)spawn — the ONE place the deathmatch wipes a body clean, called on death, at the
// match-start spawn, and on every respawn. It zeroes the active dash (so a player killed mid-dash
// never respawns sliding), all cooldowns/held charge/mid-swing, every protection channel (the
// caller re-arms two-stage spawn protection after), and every in-match buff/combo/no-snowball accumulator so
// nothing carries across a life. It touches ONLY transients — never hp, position, respawnT, team,
// or score, which the caller owns.
function resetPvpLifeTransient(p: PlayerSim): void {
  p.dashTime = 0; p.dashDx = 0; p.dashDy = 0; p.dashCd = 0; p.dashInvuln = 0;
  p.fireCd = 0; p.weaponFireCooldowns = {}; p.chargeT = 0; p.meleeSwing = null;
  p.invuln = 0; p.spawnGraceT = 0; p.spawnShieldT = 0;
  p.spawnProtectionStartedTick = 0;
  p.spawnHardGraceEndsAtTick = 0;
  p.spawnShieldEndsAtTick = 0;
  p.isSpawnOffenseLatched = false;
  p.spawnBlockedFeedbackCdT = 0;
  p.combo = 0; p.comboTimer = 0; p.fangCd = 0;
  p.overdriveT = 0; p.overheatT = 0; p.phaseSpeed = 0; p.ultInvuln = 0;
  p.passiveState = 0; p.overshield = 0; p.overshieldRegenT = 0;
  p.staggerPulseIcdT = 0; p.staggerPulseAppliedTick = -1;
  p.bladeWardT = 0; p.bladeWardAbsorb = 0; p.bladeWardAppliedTick = -1;
  p.isMomentumArmed = false; p.momentumIcdT = 0; p.momentumMoveSamples = [];
  p.isUltRequested = false; p.isPulseRequested = false;
  // Contested-hearth: Favor + armed ember_edge NEVER survive a death or carry across a (re)spawn
  // (Quill FINAL — "Death: Favor + charge cleared"; "no carry across death").
  p.hearthFavorT = 0; p.hearthEmberT = 0; p.hearthAwayT = 0;
  // Draft kit counters: no charge or armed post carries across a life. A respawned body re-earns
  // its brace charge (0), and its sight/rip come back ARMED (icd 0) — an equal-footing restart.
  p.pvpBraceCharge = 0; p.pvpBraceRegenT = 0; p.pvpSightIcdT = 0; p.pvpRipIcdT = 0;
  // PVP WAVE 3 arena ult: DEATH dumps the meter to 0 and clears the cast lockout + every in-flight
  // tell/active window (Quill FINAL — "Death: charge -> 0"). The CLAIMED kit (arenaUltKit) persists
  // across lives (it is the loadout choice, not a per-life transient).
  p.ultCharge = 0; p.ultReadyAtTick = 0;
  p.arenaUlt = freshArenaUltState();
}

// Wipe every PLAYER-OWNED transient object from the arena — in-flight bullets and every deployed
// weapon effect (sentries / wires / orbits / tethers / zones). Called at a match reset and at the
// countdown->live whistle so nothing deployed or lobbed during the pre-live freeze can survive
// into the match (the belt to B4's suspenders: inputs are frozen off-live, this guarantees a
// pristine arena regardless). Held charges/mid-swings are per-player and cleared by
// resetPvpLifeTransient at the same transitions. In the pvp arena these lists hold ONLY owned
// objects (no PvE population), so clearing them whole is exactly the owned set.
function pvpClearOwnedEntities(w: WorldState): void {
  w.bullets = [];
  w.effects = [];
}

function pvpClearOwnedEngagement(w: WorldState, playerId: PlayerId): void {
  w.bullets = w.bullets.filter((bullet) => bullet.owner !== playerId);
  w.effects = w.effects.filter((effect) => effect.owner !== playerId);
}

// Place every PRESENT player on a maximally-spread arena spawn in ID-SORTED order (deterministic:
// greedy farthest-from-already-placed, ties to the lowest spawn index), full HP, life transients
// wiped, spawn protection armed. Used at the countdown/live whistle so the opening spread never
// depends on join order and never seats an absent (reserved) body.
function pvpAssignSpreadSpawns(w: WorldState, isRemembered: boolean): void {
  const m = w.match;
  if (m === null || m.spawns.length === 0) return;
  const placed: Array<{ x: number; y: number }> = [];
  const assignments: Array<{ player: PlayerSim; index: number }> = [];
  for (const p of pvpPresentPlayers(w)) {
    const idx = farthestSpawnIndex(m.spawns, placed, m.pits);
    p.x = m.spawns[idx].x;
    p.y = m.spawns[idx].y;
    pvpFaceInward(w, p);
    p.hp = p.maxHp;
    p.respawnT = 0;
    p.respawnWaitSafeT = 0;
    resetPvpLifeTransient(p);
    armPvpSpawnProtection(w, p);
    assignments.push({ player: p, index: idx });
    placed.push({ x: p.x, y: p.y });
  }
  for (const assignment of assignments) {
    const assessment = assessPvpRespawn(w, assignment.player);
    beginPvpRespawnTelemetry(
      w,
      assignment.player,
      assignment.index,
      assessment.candidates,
      0,
      false,
    );
    if (isRemembered) rememberPvpSpawn(assignment.player, assignment.index);
  }
}

// Respawn a dead player at the spawn farthest from live opponents (frag-limit deathmatch: death
// schedules a respawn, never an elimination), full HP + spawn protection.
function pvpRespawn(
  w: WorldState,
  p: PlayerSim,
  assessment: PvpRespawnAssessment,
  waitSafeTicks: number,
  selectionMode: PvpRespawnSelectionMode,
): void {
  p.hp = p.maxHp;
  p.respawnT = 0;
  p.respawnWaitSafeT = 0;
  resetPvpLifeTransient(p);
  pvpPlaceOnSpawn(w, p, true, waitSafeTicks, assessment.candidates, selectionMode);
}

// The ONE id-sorted PRESENT-player roster. Every pvp match decision (start, countdown/live
// progression, fragLimit, spawn spread, no-contest) reads participant count from HERE, never
// w.players.size. A network-absent body is a reserved seat inside its reconnect grace, not a
// participant — so a lobby never starts, counts down, or stays live on an absent seat.
function pvpPresentPlayers(w: WorldState): PlayerSim[] {
  const out: PlayerSim[] = [];
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (p !== undefined && !p.isAbsent) out.push(p);
  }
  return out;
}

function syncPvpSpawnProtection(w: WorldState): void {
  const isAdvancing = w.match?.phase === "live"
    && pvpPresentPlayers(w).length >= PVP.minPlayers;
  for (const p of w.players.values()) {
    const previousTick = w.tick - 1;
    if (p.spawnShieldEndsAtTick <= 0 && p.spawnShieldT > 0) {
      p.spawnProtectionStartedTick = previousTick;
      p.spawnHardGraceEndsAtTick = previousTick + p.spawnGraceT;
      p.spawnShieldEndsAtTick = previousTick + p.spawnShieldT;
    }
    if (!isAdvancing || p.isAbsent) {
      if (p.spawnShieldEndsAtTick > 0) p.spawnProtectionStartedTick++;
      if (p.spawnHardGraceEndsAtTick > 0) p.spawnHardGraceEndsAtTick++;
      if (p.spawnShieldEndsAtTick > 0) p.spawnShieldEndsAtTick++;
      continue;
    }
    if (p.hp > 0 && p.respawnT === 0 && p.pvpRespawnTelemetry !== null) {
      p.pvpRespawnTelemetry.activeTicks++;
    }
    const previousShieldT = p.spawnShieldT;
    p.spawnGraceT = Math.max(0, p.spawnHardGraceEndsAtTick - w.tick);
    p.spawnShieldT = Math.max(0, p.spawnShieldEndsAtTick - w.tick);
    if (p.spawnBlockedFeedbackCdT > 0) p.spawnBlockedFeedbackCdT--;
    if (previousShieldT > 0
      && p.spawnShieldT === 0
      && p.pvpRespawnTelemetry?.shieldBreakMs === null) {
      p.pvpRespawnTelemetry.shieldBreakMs = Math.max(
        0,
        Math.round(p.pvpRespawnTelemetry.activeTicks * 1000 / TICKS_PER_SECOND),
      );
    }
  }
}

// Abandon the current match back to a clean lobby (NO-CONTEST): the roster fell below the minimum
// PRESENT participants mid-match (a final removal / grace expiry), so nobody is awarded the frags
// or the win of a match that can no longer be played. Scores/timers reset and the arena is wiped;
// a fresh whistle runs once enough players are present again.
function pvpResetToLobby(w: WorldState, m: MatchState, ev: SimEvent[]): void {
  m.phase = "lobby";
  m.phaseEndTick = 0;
  m.fragLimit = 0;
  m.winner = null;
  m.scores.clear();
  m.dmgThisTick.clear();
  for (const p of w.players.values()) {
    p.pvpRecentSpawnIndices = [];
    p.respawnWaitSafeT = 0;
  }
  clearPvpPendingDrafts(w, ev, "reset");
  resetPvpDrafts(w);
  pvpClearOwnedEntities(w);
  m.weather = createWeatherDirector();
  clearPvpWeatherHazards(w);
}

function raiseDuePvpDrafts(w: WorldState, ev: SimEvent[]): void {
  if (!isPvpDraftRuntime(w)) return;
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  const presentIds = pvpPresentPlayers(w).map((player) => player.id);
  const cadenceTicks = pvpDraftEveryTicks();
  for (const pid of presentIds) {
    const p = w.players.get(pid);
    if (p === undefined) continue;
    if (w.pendingBlessings.has(pid)) continue;
    p.pvpDraftActiveTicks = Math.min(cadenceTicks, p.pvpDraftActiveTicks + 1);
    const isFragDue = p.pvpDraftFrags >= PVP.draftEveryFrags;
    const isTimeDue = p.pvpDraftActiveTicks >= cadenceTicks;
    if (!isFragDue && !isTimeDue) continue;
    if (p.hp <= 0 || p.respawnT > 0) {
      if (!p.isPvpDraftDeathDelayReported) {
        p.isPvpDraftDeathDelayReported = true;
        ev.push({
          t: "pvpDraftDelayed",
          pid,
          ordinal: p.pvpDraftOrdinal + 1,
          reason: "death",
          remainingTicks: 0,
        });
      }
      continue;
    }
    const source: PvpDraftTrigger = isFragDue && isTimeDue
      ? "dedup"
      : isFragDue
        ? "frag"
        : "time";
    p.pvpDraftFrags = 0;
    p.pvpDraftActiveTicks = 0;
    p.pvpDraftOrdinal++;
    p.pvpDraftTick = w.tick;
    p.pvpDraftTierBump = pvpComebackTierBump(m.scores, presentIds, pid);
    const score = m.scores.get(pid) ?? 0;
    const leaderScore = presentIds.length === 0
      ? 0
      : Math.max(...presentIds.map((id) => m.scores.get(id) ?? 0));
    ev.push({
      t: "pvpDraftTriggered",
      pid,
      source,
      isComeback: p.pvpDraftTierBump > 0,
      ordinal: p.pvpDraftOrdinal,
      score,
      leaderScore,
    });
    raiseBlessingOffer(w, pid, false, ev, source);
  }
}

function firePvpSuddenDeath(w: WorldState, leader: PlayerId | null, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.isSuddenDeath || leader === null) return;
  const leaderFrags = m.scores.get(leader) ?? 0;
  const isMatchPoint = m.fragLimit > 0 && m.fragLimit - leaderFrags <= PVP.suddenDeathFrags;
  const isFinalClock = m.phaseEndTick - w.tick <= pvpSuddenDeathFinalTicks();
  if (!isMatchPoint && !isFinalClock) return;
  m.isSuddenDeath = true;
  ev.push({ t: "pvpSuddenDeath", leader });
}

// A living, PRESENT, un-downed, non-respawning body — the "living player" unit the hearth
// occupancy scan (and the contested read) counts. Spawn protection gates combat, not presence,
// so a protected body still occupies the hearth.
function isPvpHearthBody(p: PlayerSim | undefined): p is PlayerSim {
  return p !== undefined && !p.isAbsent && !p.isDown && p.hp > 0 && p.respawnT === 0;
}

// Is the center hearth CONTESTED right now (>= 2 living bodies in the ring)? A pure read the wire
// projects for the HUD's contested VFX; the authoritative accrual re-derives occupancy itself.
export function isPvpHearthContested(w: WorldState): boolean {
  const m = w.match;
  if (m === null || m.phase !== "live") return false;
  let occupancy = 0;
  for (const p of w.players.values()) {
    if (!isPvpHearthBody(p)) continue;
    if (isWithinHearth(p, m.hearthCenter) && ++occupancy >= 2) return true;
  }
  return false;
}

// ---- PVP WAVE 2 · PILLAR B: RING WEATHER (the arena director) -----------------------------
// A single one-at-a-time director cycles ambient hazard events on a seeded rotation, spaced by a
// fixed idle gap. Every event is pressure that shapes the fight, never a kill on its own (tar
// slows, gust nudges, spark chips a capped micro-hit). Runs only in a LIVE, non-grace-paused
// match — the same gate the hearth + respawn clock use — and is fully server-authoritative; the
// wire projects only kind/phase/dir for VFX. Pure off the pvp path (nothing here runs in co-op).

// Is `p` a live, unprotected body the weather may push/chip right now? Absent/downed/dead/
// respawning and spawn-protected bodies are skipped — the gust never shoves a body mid-grace.
function isPvpWeatherTarget(p: PlayerSim | undefined): p is PlayerSim {
  return p !== undefined && !p.isAbsent && !p.isDown && p.hp > 0 && p.respawnT === 0 && !isProtected(p);
}

// True when upwind cover (a standing prop) or a wall breaks the gust's line onto `p` — the "not
// behind cover line-break" shelter. Sampled along the short upwind segment (against the wind).
function isShelteredFromGust(w: WorldState, p: PlayerSim, dir: Vec2): boolean {
  const SAMPLES = 4;
  for (let i = 1; i <= SAMPLES; i++) {
    const reach = (WEATHER.gustCoverProbePx * i) / SAMPLES;
    const ux = p.x - dir.x * reach;
    const uy = p.y - dir.y * reach;
    if (isWall(w, ux, uy)) return true;
    for (const prop of w.props) {
      if (prop.dead || prop.breakT !== undefined) continue;
      if (Math.hypot(ux - prop.x, uy - prop.y) <= prop.radius + p.pr) return true;
    }
  }
  return false;
}

// Apply the active cinder_gust's soft positional drift to one body. Gated: pvp + a live ACTIVE
// gust + a target in the mid band (within gustMidBandDist of the hearth) that is not sheltered
// upwind by cover. Routes through moveCircle so walls/props stop the drift (never a wall-clip).
function applyPvpGustDrift(w: WorldState, p: PlayerSim, dt: number): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  const weather = m.weather;
  if (weather.kind !== "gust" || weather.phase !== "active") return;
  if (!isPvpWeatherTarget(p)) return;
  if (Math.hypot(p.x - m.hearthCenter.x, p.y - m.hearthCenter.y) > WEATHER.gustMidBandDist) return;
  const dir = PVP_WEATHER_CARDINALS[weather.gustDir] ?? PVP_WEATHER_CARDINALS[0];
  if (isShelteredFromGust(w, p, dir)) return;
  const step = WEATHER.gustDriftPxPerSec * dt;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, dir.x * step, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, dir.y * step);
}

// The spark_mine blast: one ownerless, flat capped chip + micro knockback to every foe body in the
// blast radius. Routes through the ONE pvp damage funnel (per-hit cap, protection gate, pit
// attribution all unchanged) with `by = null`, so it can never one-shot, never hits a protected
// body, and never credits itself a frag. A blast-induced pit fall still rides the recent-attacker
// env credit window (unchanged), never the mine.
function detonateSparkMine(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  ev.push({ t: "explosion", x: h.x, y: h.y, r: WEATHER.sparkBlastRadius, src: "spark" });
  if (!isPvp(w) || w.match?.phase !== "live") return;
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (!isPvpWeatherTarget(p)) continue;
    const dx = p.x - h.x;
    const dy = p.y - h.y;
    if (Math.hypot(dx, dy) > WEATHER.sparkBlastRadius + p.pr) continue;
    damagePlayer(w, p, WEATHER.sparkChipDamage, ev, null, {
      weapon: PVP.startWeapon,
      dirX: dx,
      dirY: dy,
      kbDistance: WEATHER.sparkKnockback,
    });
  }
}

// Arm the director for a fresh match at the live whistle: idle until the first event, seeded onto
// the rotation. Clears any lingering weather ground hazards (belt to the whistle's clean arena).
function armPvpWeather(w: WorldState): void {
  const m = w.match;
  if (m === null) return;
  clearPvpWeatherHazards(w);
  m.weather = {
    kind: null,
    phase: "idle",
    phaseEndTick: w.tick + pvpWeatherFirstEventTicks(),
    cursor: pvpWeatherStartCursor(w.seed),
    ordinal: 0,
    gustDir: 0,
  };
}

// Drop every weather-owned ground hazard (tar patches + spark fuses). Called on arm/end/reset so
// a weather event never bleeds across a match boundary or a grace-pause reset.
function clearPvpWeatherHazards(w: WorldState): void {
  if (w.hazards.length === 0) return;
  w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
}

function spawnPvpWeatherHazard(w: WorldState, kind: "tar" | "spark", x: number, y: number, radius: number, lifeSec: number): void {
  w.hazards.push({ id: w.nextHazardId++, kind, x, y, radius, life: lifeSec, maxLife: lifeSec });
}

// Begin the director's next event (the cursor's kind), advancing the rotation + ordinal. tar and
// spark spawn their ground hazards here; gust is a director-only wind (its push rides the active
// window). Returns the phase to enter and how long it lasts.
function beginPvpWeatherEvent(w: WorldState): void {
  const m = w.match;
  if (m === null) return;
  const weather = m.weather;
  const kind = PVP_WEATHER_ORDER[weather.cursor % PVP_WEATHER_ORDER.length];
  weather.cursor = (weather.cursor + 1) % PVP_WEATHER_ORDER.length;
  const ordinal = weather.ordinal++;
  weather.kind = kind;
  weather.gustDir = 0;
  if (kind === "tar") {
    // No tell — the patches bloom straight onto the forced chokepoints (never hearth/spawn/pit by
    // construction). Hard cap 2 concurrent, and the one-at-a-time director bounds it further.
    const spots = pvpWeatherTarSpots(w.seed, ordinal, m.forcedChokepoints).slice(0, WEATHER.tarMaxPatches);
    for (const spot of spots) spawnPvpWeatherHazard(w, "tar", spot.x, spot.y, WEATHER.tarRadius, WEATHER.tarLifeSec);
    weather.phase = "active";
    weather.phaseEndTick = w.tick + pvpWeatherTarLifeTicks();
  } else if (kind === "gust") {
    weather.phase = "tell";
    weather.phaseEndTick = w.tick + pvpWeatherGustTellTicks();
  } else {
    // spark_mine: plant the telegraph fuse on the first annulus candidate that lands on open floor
    // clear of the pit denylist; it detonates on expiry (updateHazards). If none is valid (never,
    // for the authored arena), the event simply passes as a harmless idle beat.
    const spot = firstValidSparkSpot(w, ordinal, m.hearthCenter);
    if (spot !== null) spawnPvpWeatherHazard(w, "spark", spot.x, spot.y, WEATHER.sparkBlastRadius, WEATHER.sparkTellSec);
    weather.phase = "tell";
    weather.phaseEndTick = w.tick + pvpWeatherSparkTellTicks();
  }
}

// The first spark candidate on open floor that is NOT a pit and not within a blast of one (the H1
// denylist: pits, and the spark is centered in the annulus so it is already clear of the hearth
// and spawns). Returns null when the seeded ring yields nothing valid.
function firstValidSparkSpot(w: WorldState, ordinal: number, hearthCenter: Vec2): Vec2 | null {
  const m = w.match;
  for (const cand of pvpWeatherSparkCandidates(w.seed, ordinal, hearthCenter)) {
    if (isWall(w, cand.x, cand.y)) continue;
    const tx = Math.floor(cand.x / TILE);
    const ty = Math.floor(cand.y / TILE);
    if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) continue;
    if (w.dungeon.tiles[ty * w.dungeon.w + tx] === 2) continue; // never on a pit tile (H1)
    if (m !== null && m.spawns.some((s) => Math.hypot(cand.x - s.x, cand.y - s.y) <= WEATHER.sparkBlastRadius)) continue;
    return cand;
  }
  return null;
}

// The ring-weather director step (Pillar B). One event at a time on the seeded rotation, spaced by
// the idle gap (tightened in sudden death — cadence only). Freezes with the match: a grace-paused
// or non-live match runs no weather (identical gate to stepPvpHearth).
function stepPvpWeather(w: WorldState): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  if (pvpPresentPlayers(w).length < PVP.minPlayers) return; // grace pause freezes the weather too
  const weather = m.weather;
  // spark_mine's tell is HAZARD-DRIVEN, not timer-driven: the fuse detonates in updateHazards the
  // tick its life hits 0 (the `charge` idiom), so the event is done the tick its hazard is gone.
  // Keying off the hazard (not a parallel tick timer) makes the fuse the SINGLE source of truth —
  // no float race between the life countdown and a separate director clock.
  if (weather.kind === "spark" && weather.phase === "tell") {
    if (!w.hazards.some((h) => h.kind === "spark")) endPvpWeatherEvent(w);
    return;
  }
  if (w.tick < weather.phaseEndTick) return;
  switch (weather.phase) {
    case "idle":
      beginPvpWeatherEvent(w);
      break;
    case "tell":
      // Only the gust reaches here (spark is handled above). Its tell resolves into the active
      // drift: pick the seeded cardinal now (toward a pit side).
      weather.phase = "active";
      weather.gustDir = pvpWeatherGustCardinal(w.seed, weather.ordinal - 1);
      weather.phaseEndTick = w.tick + pvpWeatherGustActiveTicks();
      break;
    case "active":
      // tar's patches have faded (their life == the active window) and gust's drift is spent.
      endPvpWeatherEvent(w);
      break;
  }
}

// Close the current event: clear any lingering weather hazards and idle until the next beat (idle
// gap tightened in sudden death — the cadence-only storm-closes-in beat).
function endPvpWeatherEvent(w: WorldState): void {
  const m = w.match;
  if (m === null) return;
  clearPvpWeatherHazards(w);
  m.weather.kind = null;
  m.weather.gustDir = 0;
  m.weather.phase = "idle";
  m.weather.phaseEndTick = w.tick + pvpWeatherIdleGapTicks(m.isSuddenDeath);
}

// PVP WAVE 2 · CONTESTED HEARTH (Pillar A — HOLD_THE_HEARTH). One lone body standing UNCONTESTED
// on the center hearth accrues Favor; a full stand (armTicks) arms one ember_edge charge (a flat
// next-gun-hit chip resolved in the damage funnel). Contested (>= 2 in radius) PAUSES Favor;
// leaving decays unarmed progress after 0.40s and drops an armed charge 1.5s after leaving. The
// ember window also counts down 4.0s from arm regardless. Runs only in a LIVE, non-grace-paused
// match — the same gate the respawn clock uses, so a paused match freezes the hearth too. Pure
// server logic (authoritative-only, never predicted): the timers ride SelfWire, reconciled.
function stepPvpHearth(w: WorldState): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  if (pvpPresentPlayers(w).length < PVP.minPlayers) return; // grace pause freezes the hearth
  const armTicks = pvpHearthArmTicks();
  const emptyDecayTicks = pvpHearthEmptyDecayTicks();
  const armedHoldTicks = pvpHearthArmedHoldTicks();
  const emberWindowTicks = pvpHearthEmberWindowTicks();
  const ids = [...w.players.keys()].sort();
  const inHearth = new Map<PlayerId, boolean>();
  let occupancy = 0;
  for (const id of ids) {
    const p = w.players.get(id);
    const isIn = isPvpHearthBody(p) && isWithinHearth(p, m.hearthCenter);
    inHearth.set(id, isIn);
    if (isIn) occupancy++;
  }
  for (const id of ids) {
    const p = w.players.get(id);
    if (p === undefined) continue;
    const isIn = inHearth.get(id) === true;
    let isJustArmed = false;
    if (isIn && occupancy === 1) {
      // Uncontested: accrue Favor; a full stand arms (or refreshes) one ember_edge charge.
      p.hearthAwayT = 0;
      p.hearthFavorT++;
      if (p.hearthFavorT >= armTicks) {
        p.hearthFavorT = 0;
        p.hearthEmberT = emberWindowTicks; // max 1; a refresh replaces
        isJustArmed = true;
      }
    } else if (isIn) {
      // Contested (>= 2 bodies in radius): Favor PAUSES — held, neither accrues nor decays.
      p.hearthAwayT = 0;
    } else {
      // Out of the radius: unarmed progress clears after emptyDecay; armed charge drops after
      // armedHold (the ember window countdown below still applies, so the effective drop is the
      // earlier of the two).
      p.hearthAwayT++;
      if (p.hearthFavorT > 0 && p.hearthAwayT >= emptyDecayTicks) p.hearthFavorT = 0;
      if (p.hearthEmberT > 0 && p.hearthAwayT >= armedHoldTicks) p.hearthEmberT = 0;
    }
    // A live charge always burns down its 4.0s window (a camped charge still expires) — but never
    // on the very tick it armed, so a fresh charge gets its full window.
    if (!isJustArmed && p.hearthEmberT > 0) p.hearthEmberT--;
  }
}

// ---- PVP WAVE 2 · PILLAR C: DRAFT KIT COUNTERS (brace / sight / rip) -----------------------
// Three uncommon draft blessings, each a soft on-cadence counter resolved in the match sim and
// keyed off the drafted blessing id (ownedItemIds). Server-authoritative, behind isPvp — pure off
// the pvp path (nothing here runs in co-op). The blessing ids ride SelfWire.items; the per-life
// counter timers are server-owned transient (never wired, cleared on death).

// Does `p` currently own the named pvp draft counter? True only on the pvp path with the id drafted.
function ownsPvpCounter(w: WorldState, p: PlayerSim, id: string): boolean {
  return isPvp(w) && p.ownedItemIds.includes(id);
}

// brace_band pit-warning ETA gate: the braced body ends within bracePitWarnEtaSec of the nearest
// pit edge, measured as edge distance / the body's current walk speed. Presentation-only heads-up.
function isPvpBracePitWarn(w: WorldState, p: PlayerSim): boolean {
  const m = w.match;
  if (m === null || m.pits.length === 0) return false;
  const speed = PLAYER.moveSpeed * p.mods.moveSpeedMult;
  if (speed <= 0) return false;
  return pvpNearestPitEdgeDistance(p, m.pits) / speed <= KIT_COUNTERS.bracePitWarnEtaSec;
}

// The nearest live foe body within the clear_eyes radius AND clear line-of-sight (no wallhack).
// Info only — the caller emits a presentation mark, never damage. id-sorted for determinism.
function nearestPvpSightFoe(w: WorldState, p: PlayerSim): PlayerSim | null {
  let best: PlayerSim | null = null;
  let bestD: number = KIT_COUNTERS.sightRadius;
  for (const id of [...w.players.keys()].sort()) {
    const foe = w.players.get(id);
    if (foe === undefined || foe.id === p.id || !isPvpHearthBody(foe)) continue;
    if (!arePvpFoes({ team: p.team, id: p.id }, { team: foe.team, id: foe.id })) continue;
    const d = Math.hypot(foe.x - p.x, foe.y - p.y);
    if (d > bestD) continue;
    if (!hasLineOfSight(w, p.x, p.y, foe.x, foe.y)) continue;
    bestD = d; best = foe;
  }
  return best;
}

// The nearest ADJACENT breakable cover (a live, non-brazier prop whose edge is within reach) — the
// one piece rip_post chips. The arena's cover is breakable crates; the outer wall is a tile and the
// hearth/players are not props, so those are excluded by construction. id-order is prop-array order,
// which is deterministic (spawned once, id-sorted in the pvp arena build).
function nearestBreakablePvpCover(w: WorldState, p: PlayerSim): Prop | null {
  let best: Prop | null = null;
  let bestEdge = Infinity;
  for (const prop of w.props) {
    if (prop.dead || prop.breakT !== undefined || prop.kind === "brazier") continue;
    const edge = Math.hypot(p.x - prop.x, p.y - prop.y) - prop.radius - p.pr;
    if (edge > KIT_COUNTERS.ripCoverReachPx) continue;
    if (edge < bestEdge) { bestEdge = edge; best = prop; }
  }
  return best;
}

// Rip the post: clear tar under the body (r40, so the drag never traps the rip) and chip ONE
// adjacent breakable cover by a single break tick. Never damages a player, never demolishes a
// piece outright, never touches the hearth/outer wall.
function firePvpRip(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  let clearedTar = false;
  for (const h of w.hazards) {
    if (h.kind !== "tar" || h.life <= 0) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) > KIT_COUNTERS.ripTarClearRadius + h.radius) continue;
    h.life = 0;
    clearedTar = true;
  }
  if (clearedTar) w.hazards = w.hazards.filter((h) => h.life > 0);
  const cover = nearestBreakablePvpCover(w, p);
  if (cover !== null) damageProp(w, cover, KIT_COUNTERS.ripCoverChipDamage, ev, p);
  ev.push({ t: "blessingProc", pid: p.id, item: PVP_COUNTER_RIP, phase: "rip", x: p.x, y: p.y });
}

// The draft-counter step (Pillar C). Advances each owner's counter and fires the soft effect on
// cadence. Runs only in a LIVE, non-grace-paused match — the same gate the hearth/weather use.
// Placed after the weather step so rip clears the freshest tar and the match/respawn state settles
// first (an eliminated body is no longer a kit body and is skipped).
function stepPvpKits(w: WorldState, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  if (pvpPresentPlayers(w).length < PVP.minPlayers) return; // grace pause freezes the kits too
  // rip_post triggers on the owner's next reload OR dash this tick. The arena has no reload action,
  // so a fired shot (cycling the weapon) IS the "reload" beat; both ride events already emitted in
  // the player phase (dashStart / shot), so one scan resolves whichever came first.
  const actedThisTick = new Set<PlayerId>();
  for (const e of ev) {
    if (e.t === "dashStart" || e.t === "shot") actedThisTick.add(e.pid);
  }
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (!isPvpHearthBody(p)) continue;
    // brace_band: bank toward one charge on the 7.0s cadence (max 1).
    if (ownsPvpCounter(w, p, PVP_COUNTER_BRACE) && p.pvpBraceCharge < KIT_COUNTERS.braceMaxCharges) {
      if (++p.pvpBraceRegenT >= pvpBraceRechargeTicks()) {
        p.pvpBraceRegenT = 0;
        p.pvpBraceCharge++;
        ev.push({ t: "blessingProc", pid: p.id, item: PVP_COUNTER_BRACE, phase: "ready", x: p.x, y: p.y });
      }
    }
    // clear_eyes: on the 7.0s ICD, outline the nearest foe in radius + LOS (info only). The ICD is
    // spent only on a successful mark, so a lone player's pulse fires the instant a foe is in sight.
    if (ownsPvpCounter(w, p, PVP_COUNTER_SIGHT)) {
      if (p.pvpSightIcdT > 0) p.pvpSightIcdT--;
      if (p.pvpSightIcdT <= 0) {
        const foe = nearestPvpSightFoe(w, p);
        if (foe !== null) {
          p.pvpSightIcdT = pvpSightPulseIcdTicks();
          ev.push({ t: "blessingProc", pid: p.id, item: PVP_COUNTER_SIGHT, phase: "mark", x: foe.x, y: foe.y });
        }
      }
    }
    // rip_post: on the 8.0s ICD; when armed and the owner reloaded/dashed this tick, rip the post.
    if (ownsPvpCounter(w, p, PVP_COUNTER_RIP)) {
      if (p.pvpRipIcdT > 0) p.pvpRipIcdT--;
      if (p.pvpRipIcdT <= 0 && actedThisTick.has(p.id)) {
        firePvpRip(w, p, ev);
        p.pvpRipIcdT = pvpRipIcdTicks();
      }
    }
  }
}

// ---- PVP WAVE 3: ARENA ULTS (PROTOCOL 49) -------------------------------------------------
// The arena-only ult loop: a shared charge/cast meter (reusing ultCharge/ultReadyAtTick) drives
// ONE of four arena ult ids off the CLAIMED kit skin. Co-op ults never fire here (kitId stays
// "none" + resolveUlt's isPvp guard). Runs only during a LIVE match, behind isPvp — co-op is inert.

// A cast is in flight while telegraphing (tell), mid-volley (salvo), recovering (slip end-lag), or
// holding a frontal wall (shove). One cast at a time.
function isArenaUltBusy(p: PlayerSim): boolean {
  const a = p.arenaUlt;
  return a.tellT > 0 || a.salvoShotsLeft > 0 || a.endlagT > 0 || a.shoveT > 0;
}

function stepArenaUlts(w: WorldState, dt: number, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (p === undefined) continue;
    stepArenaUlt(w, p, dt, ev);
  }
}

function stepArenaUlt(w: WorldState, p: PlayerSim, dt: number, ev: SimEvent[]): void {
  // Dead / respawning / absent bodies never accrue, telegraph, or cast (their windows were already
  // dumped by resetPvpLifeTransient on death). A live grace pause is handled by the phase gate above.
  if (p.isDown || p.isAbsent || p.hp <= 0 || p.respawnT > 0) return;
  const a = p.arenaUlt;
  // Active-window decay (seconds; deterministic fixed step).
  if (a.glassT > 0) a.glassT = a.glassT > dt ? a.glassT - dt : 0;
  if (a.slowImmuneT > 0) a.slowImmuneT = a.slowImmuneT > dt ? a.slowImmuneT - dt : 0;
  if (a.endlagT > 0) a.endlagT = a.endlagT > dt ? a.endlagT - dt : 0;
  // arena_bulwark_shove: the frontal wall lives for its window; its BLOCK scan runs earlier in the
  // tick (stepArenaShoveWalls, before resolvePvpHits) so it eats a foe shot before it can land. Here
  // we only age the wall — silent expiry when it runs out without blocking.
  if (a.shoveT > 0) a.shoveT = a.shoveT > dt ? a.shoveT - dt : 0;
  // Tell -> effect: the >= 0.40s telegraph elapses, then the ult lands (U3: tell honored). Fire on
  // CROSSING zero (never an exact-equality float compare) so the tell length is robust to fp dust.
  if (a.tellT > 0) {
    a.tellT -= dt;
    if (a.tellT <= 0) {
      a.tellT = 0;
      if (a.kind !== null) fireArenaUlt(w, p, ev);
    }
  }
  // arena_salvo cadence: 5 shots evenly over the volley window (the first fires the tick the tell
  // ends). `+= spacing` carries the sub-tick remainder so the cadence never drifts.
  if (a.salvoShotsLeft > 0) {
    a.salvoShotT -= dt;
    if (a.salvoShotT <= 0) {
      fireArenaSalvoShot(w, p, ev);
      a.salvoShotsLeft -= 1;
      a.salvoShotT += arenaSalvoShotSpacingSec();
    }
  }
  // Passive time charge (+1.0 pts/s), clamped to the arena meter max. HOLD/BREAK sources are idle
  // on frag DM (no Brazier objective) — the wire path exists for siege, but never ticks here.
  p.ultCharge = clampArenaUltCharge(p.ultCharge + arenaUltPassiveChargePerTick());
  // A fresh request opens a cast when the meter is full, the 8s spacing has elapsed, and no cast
  // is already in flight. The client only REQUESTS (input.ult); the server validates + resolves.
  if (p.isUltRequested) resolveArenaUltRequest(w, p, ev);
}

function resolveArenaUltRequest(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const a = p.arenaUlt;
  if (isArenaUltBusy(p)) return;
  if (!canCastArenaUlt(p.ultCharge, w.tick, p.ultReadyAtTick)) return;
  const kind = arenaUltKindForKit(p.arenaUltKit);
  p.ultCharge = 0;
  p.ultReadyAtTick = w.tick + arenaUltCastSpacingTicks(); // the 8s min cast spacing (U3)
  a.kind = kind;
  a.aim = p.aimAngle;
  a.tellT = ARENA_ULT.tellSec;
  // arena_salvo GLASS opens with the tell and runs through the whole active window (0.95s total).
  if (kind === "salvo") a.glassT = ARENA_SALVO.glassSec;
  ev.push({ t: "ultArena", pid: p.id, kind, x: p.x, y: p.y, aim: p.aimAngle, tellTicks: arenaUltTellTicks() });
}

// The tell elapsed — apply the claimed ult's effect (U4: each matches the Quill finals).
function fireArenaUlt(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const a = p.arenaUlt;
  switch (a.kind) {
    case "salvo":
      // 5 shots over 0.55s; the cadence block fires the first this same tick (salvoShotT 0).
      a.salvoShotsLeft = ARENA_SALVO.shots;
      a.salvoShotT = 0;
      break;
    case "triage":
      // +18 HP instant self, never past maxHp; cleanse the tar/move slow (brief slow-immunity).
      // Never grounds a HoT, heals an ally, or converts to shield.
      p.hp = Math.min(p.maxHp, p.hp + ARENA_TRIAGE.healSelf);
      a.slowImmuneT = ARENA_TRIAGE.cleanseSec;
      ev.push({ t: "heal", pid: p.id, x: p.x, y: p.y });
      a.kind = null;
      break;
    case "shove":
      // Raise the 0.75s frontal wall (blocks one foe shot then shatters + shoves).
      a.shoveT = ARENA_SHOVE.wallLifeSec;
      a.shoveAim = a.aim;
      break;
    case "slip": {
      // ~90px blink along aim with a 0.40s i-frame (rides ultInvuln — the damage funnel honors it),
      // then a visible 0.35s end-lag with NO i-frame (offense locked; the counter-window).
      const dx = Math.cos(a.aim) * ARENA_SLIP.blinkPx;
      const dy = Math.sin(a.aim) * ARENA_SLIP.blinkPx;
      [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, dx, 0);
      [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, dy);
      p.ultInvuln = Math.max(p.ultInvuln, ARENA_SLIP.iframeSec);
      a.endlagT = ARENA_SLIP.endlagSec;
      applyActiveWeaponFireLock(p, ARENA_SLIP.endlagSec);
      a.kind = null;
      break;
    }
    case null:
      break;
  }
}

// One arena_salvo hitscan shot along the locked aim: a flat 10 PVP dmg to up to (1 + bonusPierce)
// nearest foes on the ray (pierce is volley-only). Flat (skips draft scale), still capped + glassed.
function fireArenaSalvoShot(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const a = p.arenaUlt;
  const dirX = Math.cos(a.aim), dirY = Math.sin(a.aim);
  const maxTargets = 1 + ARENA_SALVO.bonusPierce;
  const hits: { v: PlayerSim; forward: number }[] = [];
  for (const vid of [...w.players.keys()].sort()) {
    const v = w.players.get(vid);
    if (v === undefined || !canDamagePlayer(w, p.id, v)) continue;
    const rx = v.x - p.x, ry = v.y - p.y;
    const forward = rx * dirX + ry * dirY;
    if (forward <= 0 || forward > ARENA_SALVO.rangePx) continue;
    const perp = Math.abs(rx * dirY - ry * dirX);
    if (perp > v.pr + ARENA_SALVO.shotRadiusPx) continue;
    hits.push({ v, forward });
  }
  hits.sort((h1, h2) => h1.forward - h2.forward || (h1.v.id < h2.v.id ? -1 : h1.v.id > h2.v.id ? 1 : 0));
  for (let i = 0; i < hits.length && i < maxTargets; i++) {
    damagePlayer(w, hits[i].v, ARENA_SALVO.perShotDamage, ev, p.id, {
      weapon: p.weapon, dirX, dirY, isFlat: true,
    });
  }
}

// The frontal-wall block pass: runs BEFORE resolvePvpHits (right after updateBullets) so an active
// wall eats a foe shot before it can damage its owner. Live match, behind isPvp — co-op is inert.
function stepArenaShoveWalls(w: WorldState, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null || m.phase !== "live") return;
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    if (p === undefined || p.arenaUlt.shoveT <= 0) continue;
    stepArenaShoveWall(w, p, ev);
  }
}

// The shove wall's per-tick scan: block the FIRST foe shot crossing the frontal arc within reach,
// then shatter (shove frontal foes). Absorbs exactly one shot per wall (Quill FINAL).
function stepArenaShoveWall(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const a = p.arenaUlt;
  const half = (ARENA_SHOVE.arcDeg * Math.PI / 180) / 2;
  const reach = ARENA_SHOVE.reachPx;
  for (const b of w.bullets) {
    if (!b.friendly || b.life <= 0 || b.owner === null || b.owner === p.id) continue;
    const shooter = w.players.get(b.owner);
    if (shooter === undefined || shooter.isAbsent) continue;
    if (!arePvpFoes({ team: p.team, id: p.id }, { team: shooter.team, id: shooter.id })) continue;
    const rx = b.x - p.x, ry = b.y - p.y;
    if (Math.hypot(rx, ry) > reach + b.radius) continue;
    const ang = Math.abs(Math.atan2(Math.sin(Math.atan2(ry, rx) - a.shoveAim), Math.cos(Math.atan2(ry, rx) - a.shoveAim)));
    if (ang > half) continue;
    b.life = 0;
    ev.push({ t: "bulletBlocked", kind: "shielder", x: b.x, y: b.y, aim: Math.atan2(b.vy, b.vx) });
    shatterArenaShove(w, p, ev);
    return;
  }
}

function shatterArenaShove(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const a = p.arenaUlt;
  const half = (ARENA_SHOVE.arcDeg * Math.PI / 180) / 2;
  const reach = ARENA_SHOVE.reachPx;
  a.shoveT = 0;
  for (const vid of [...w.players.keys()].sort()) {
    const v = w.players.get(vid);
    if (v === undefined || v.id === p.id) continue;
    if (!arePvpFoes({ team: p.team, id: p.id }, { team: v.team, id: v.id })) continue;
    if (v.isAbsent || v.isDown || v.hp <= 0 || v.respawnT > 0) continue;
    const rx = v.x - p.x, ry = v.y - p.y;
    if (Math.hypot(rx, ry) > reach + v.pr) continue;
    const ang = Math.abs(Math.atan2(Math.sin(Math.atan2(ry, rx) - a.shoveAim), Math.cos(Math.atan2(ry, rx) - a.shoveAim)));
    if (ang > half) continue;
    // KB frontal (brace can half it inside applyPvpKnockback); a shove into a pit rings out (credit
    // to the shover, riding the same env-kill path as every other pvp knockback ring-out).
    applyPvpKnockback(w, v, { weapon: p.weapon, dirX: rx, dirY: ry, kbDistance: ARENA_SHOVE.shatterKb }, ev);
    if (isPlayerCenterInPvpPit(w, v)) eliminatePvpPlayer(w, v, p.id, "ringOut", ev);
  }
  ev.push({ t: "puff", x: p.x, y: p.y, n: 6, color: "#cfe6ff" });
}

// The frag-limit RESPAWN deathmatch state machine (lobby -> countdown -> live -> over). Pure sim,
// counted in TICKS off w.tick — no rounds, no last-standing, no wipe. A death respawns after a
// delay; the match ends when a player reaches the frag limit OR the time cap expires (highest
// frags wins, id-sorted tiebreak). This REPLACES the co-op wipe/descend loop in pvp. Every roster
// decision reads the PRESENT count, so an absent seat never starts, advances, or wins a match.
function stepPvpMatch(w: WorldState, ev: SimEvent[]): void {
  const m = w.match;
  if (m === null) return;
  const present = pvpPresentPlayers(w).length;
  const isEnough = present >= PVP.minPlayers;
  // Respawn timers advance only during LIVE play that is NOT grace-paused (a paused match freezes
  // the whole clock, respawns included).
  if (m.phase === "live" && isEnough) {
    for (const id of [...w.players.keys()].sort()) {
      const p = w.players.get(id);
      if (p === undefined || p.isAbsent) continue;
      if (p.respawnWaitSafeT > 0) {
        p.respawnWaitSafeT--;
        const elapsed = pvpRespawnWaitSafeMaxTicks() - p.respawnWaitSafeT;
        const isPollTick = elapsed % pvpRespawnWaitSafeIntervalTicks() === 0;
        if (isPollTick || p.respawnWaitSafeT === 0) {
          const assessment = assessPvpRespawn(w, p);
          if (!assessment.isAllEightThreatened || p.respawnWaitSafeT === 0) {
            pvpRespawn(
              w,
              p,
              assessment,
              elapsed,
              p.respawnWaitSafeT === 0 ? "timeout" : "normal",
            );
          }
        }
        continue;
      }
      if (p.respawnT > 0) {
        p.respawnT -= 1;
        if (p.respawnT <= 0) {
          const assessment = assessPvpRespawn(w, p);
          if (assessment.isAllEightThreatened) {
            p.respawnT = 1;
            p.respawnWaitSafeT = pvpRespawnWaitSafeMaxTicks();
          } else {
            pvpRespawn(w, p, assessment, 0, "normal");
          }
        }
      }
    }
  }
  switch (m.phase) {
    case "lobby":
      // Fun at 2 — the loop opens the instant minPlayers are PRESENT (never gated to >= 3, never
      // opened by an absent seat). Wipe the arena before the freeze-in spread.
      if (isEnough) {
        m.phase = "countdown";
        m.phaseEndTick = w.tick + pvpCountdownTicks();
        pvpClearOwnedEntities(w);
        pvpAssignSpreadSpawns(w, false);
      }
      break;
    case "countdown":
      // A seat dropping during the freeze-in aborts the whistle: revert to lobby (re-opens when
      // enough are present again). Never count down — let alone start — a solo match.
      if (!isEnough) { m.phase = "lobby"; m.phaseEndTick = 0; break; }
      if (w.tick >= m.phaseEndTick) {
        m.phase = "live";
        m.phaseEndTick = w.tick + pvpMatchTimeTicks();
        m.fragLimit = pvpFragLimit(present); // Patch 0 B3: scaled by the PRESENT match-start count
        pvpClearOwnedEntities(w);   // Patch 0 B4: nothing pre-positioned during the countdown survives the whistle
        for (const p of w.players.values()) p.pvpRecentSpawnIndices = [];
        pvpAssignSpreadSpawns(w, true); // fresh id-sorted spread + protection at the whistle
        m.lastFragTick.clear();
        m.fragChain.clear();
        m.isSuddenDeath = false;
        resetPvpDrafts(w);
        armPvpWeather(w); // PVP WAVE 2 · Pillar B: the ring-weather director opens fresh at the whistle
      }
      break;
    case "live": {
      // Grace pause: while a seat is absent inside its reconnect window the match FREEZES — the
      // time cap holds (phaseEndTick tracks the tick, so no wall-clock is lost) and no frag/time
      // end resolves. Combat is already inert (canDamagePlayer rejects an absent owner+target),
      // so this is the clock half of the pause. FINAL removal below the minimum is a separate
      // no-contest reset (removePlayerFromWorld) — never a free win handed out here.
      if (!isEnough) { m.phaseEndTick += 1; break; }
      const leader = pvpTopScorer(w);
      if (leader !== null && (m.scores.get(leader) ?? 0) >= m.fragLimit) { pvpEndMatch(w, leader, ev); break; }
      if (w.tick >= m.phaseEndTick) { pvpEndMatch(w, leader, ev); break; }
      raiseDuePvpDrafts(w, ev);
      firePvpSuddenDeath(w, leader, ev);
      break;
    }
    case "over":
      break;
  }
}

// Terminal run transition: mark the world over (once) and emit gameOver for every remaining
// player. Idempotent — re-entering while already over emits nothing.
function endRun(w: WorldState, ev: SimEvent[]): void {
  if (w.isRunOver) return;
  w.isRunOver = true;
  for (const other of w.players.values()) {
    resetPlayerWarmth(other);
    ev.push({ t: "gameOver", pid: other.id });
  }
}

// The wipe (studio balance gate §6): the run ends only after EVERY connected player has
// been down SIMULTANEOUSLY for the full 4.0s hold — a beat where a last-tick revive
// completion (updateRevives runs first) or a reconnect return can still save the run.
// Anyone standing resets the hold. Network-absent bodies are excluded from the calculus
// entirely (gate §6): a reservation neither blocks a wipe (an absent ally cannot be waited
// on while the whole CONNECTED party lies downed) nor causes one (a body that merely
// disconnected is not "down" — with every connected player absent and nobody downed, the
// world simply idles until the seats resolve). Solo-local keeps its classic instant game
// over in damagePlayer; this gate is shared-world only.
function checkStrandedWipe(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (!w.isShared || w.isRunOver || w.players.size === 0) { w.wipeTimer = 0; return; }
  let anyUp = false;
  let anyDown = false;
  for (const p of w.players.values()) {
    if (p.isAbsent) continue;
    if (!p.isDown && p.hp > 0) anyUp = true;
    else anyDown = true;
  }
  if (anyUp || !anyDown) { w.wipeTimer = 0; return; }
  w.wipeTimer += dt;
  if (w.wipeTimer >= WIPE_HOLD_SECONDS) endRun(w, ev);
}

// Authoritative revive (studio balance gate §6): ONE living teammate HOLDS the interact
// key (isInteracting, the consumed input's explicit intent) within REVIVE.radius for the
// full 1.5s channel, UNINTERRUPTED. Any break — the channeler taking damage, dashing,
// attacking (all three cancel at their sites via cancelReviveChannelBy), releasing the
// key, or leaving the radius — resets the channel to zero; a different teammate taking
// over starts fresh, and extra revivers never accelerate (the identity in reviveBy is the
// single channel). A player past the floor's down limit is OUT: unrevivable until the
// descent rescue. The revived player returns at 2 HP with 1.0s protection and a 0.35s
// attack lockout. The server validates everything from ITS OWN state — a tampered client
// can flip an input bit, never conjure proximity or skip the channel. Solo never has a
// downed player with a standing ally, so this no-ops there.
export function effectiveReviveRadius(reviver: PlayerSim): number {
  // Shared Rope's flat bonus + Carry the Light's objective_support bonus (distinct cats).
  return REVIVE.radius + reviver.mods.reviveRadiusBonus + reviver.mods.lightReviveRadius;
}

export function effectiveReviveRate(reviver: PlayerSim): number {
  const kitRate = reviver.kitId === "mender" ? MENDER_REVIVE_SPEED : 1;
  // Carry the Light never MULTIPLIES the Rope channel authority; it adds its own rate.
  return Math.min(2.1, kitRate * reviver.mods.reviveSpeedMult * (1 + reviver.mods.lightReviveRate));
}

export function effectiveReviveChannelSeconds(reviver: PlayerSim): number {
  return REVIVE.channel / effectiveReviveRate(reviver);
}

function updateRevives(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const downed of w.players.values()) {
    if (!downed.isDown) { downed.reviveBy = null; continue; }
    if (downed.downsThisFloor > REVIVE.downsPerFloor) {
      downed.reviveBy = null;
      downed.reviveProgress = 0;
      continue;
    }
    const previousReviverId = downed.reviveBy;
    const current = previousReviverId !== null ? w.players.get(previousReviverId) : undefined;
    let reviver = current !== undefined && isValidReviver(current, downed) ? current : undefined;
    if (reviver === undefined) {
      // The running channel broke (or none existed): zero it, then let the first valid
      // candidate in stable map order open a FRESH one.
      downed.reviveProgress = 0;
      const candidates = [...w.players.values()]
        .filter((other) => other !== downed && isValidReviver(other, downed))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (candidates.length > 0) {
        reviver = candidates[0];
      }
      downed.reviveBy = reviver !== undefined ? reviver.id : null;
    }
    if (downed.reviveBy !== previousReviverId) {
      ev.push({
        t: "reviveHandoff", pid: downed.id, from: previousReviverId ?? "",
        to: downed.reviveBy ?? "",
        isBoosted: reviver !== undefined
          && (reviver.mods.reviveRadiusBonus > 0 || reviver.mods.reviveSpeedMult > 1
            || reviver.mods.lightReviveRadius > 0),
        x: downed.x, y: downed.y,
      });
      // Carry the Light: opening a fresh channel cuts the reviver's remaining fire cooldown.
      if (reviver !== undefined && reviver.mods.lightSwapCut > 0) {
        for (const id of Object.keys(reviver.weaponFireCooldowns) as WeaponId[]) {
          reviver.weaponFireCooldowns[id] = (reviver.weaponFireCooldowns[id] ?? 0) * (1 - reviver.mods.lightSwapCut);
        }
        reviver.fireCd *= 1 - reviver.mods.lightSwapCut;
        reviver.weaponFireCooldowns[reviver.weapon] = reviver.fireCd;
      }
    }
    if (reviver === undefined) continue;
    downed.reviveProgress += dt * effectiveReviveRate(reviver);
    if (downed.reviveProgress >= REVIVE.channel) {
      downed.isDown = false;
      downed.hp = Math.min(downed.maxHp, REVIVE.hp);
      downed.invuln = Math.max(downed.invuln, REVIVE.invuln);
      applyActiveWeaponFireLock(downed, REVIVE.fireLockout);
      downed.reviveProgress = 0;
      // Carry the Light Lv3: the reviver's weapon is readied on a completed revive.
      if (reviver.mods.lightFreeMag > 0) {
        reviver.fireCd = 0;
        reviver.weaponFireCooldowns = {};
      }
      resetPlayerWarmth(downed);

      ev.push({ t: "revive", pid: downed.id, by: reviver.id, x: downed.x, y: downed.y });
      downed.reviveBy = null;
    }
  }
}

// Past the floor's down limit (gate §1: Standard 3/player/floor): OUT — down and
// unrevivable until the descent rescue. Both wires carry this derived bit so every client
// can stop offering a revive that the sim would refuse.
export function isPlayerOut(p: PlayerSim): boolean {
  return p.isDown && p.downsThisFloor > REVIVE.downsPerFloor;
}

function isValidReviver(other: PlayerSim, downed: PlayerSim): boolean {
  // An absent body cannot channel a revive; an absent DOWNED body can still be revived
  // (a kindness that survives the reconnect — they resume upright).
  if (other.isDown || other.isAbsent || other.hp <= 0 || !other.isInteracting) return false;
  if (other.dashTime > 0) return false; // mid-dash is a movement commitment, not a channel
  return Math.hypot(other.x - downed.x, other.y - downed.y)
    <= effectiveReviveRadius(other);
}

// Reset any revive channel POWERED BY this player (gate §6: the reviver's damage, dash, or
// attack cancels the whole channel — no partial credit).
function cancelReviveChannelBy(w: WorldState, pid: PlayerId): void {
  for (const downed of w.players.values()) {
    if (downed.reviveBy !== pid) continue;
    downed.reviveBy = null;
    downed.reviveProgress = 0;
  }
}

// ---- exit / descend ----

// The living players currently standing at the cleared exit — THE party-descend readiness
// predicate. One function backs the authoritative gate (updateExit) AND the wire readout
// (snapshot `exr`), so what the UI shows can never drift from what the gate requires.
// Downed players are never listed (they aren't required at the stairs; the descend rescues
// them), network-absent bodies are excluded on BOTH sides of the gate (they can neither
// hold the party hostage nor stand in as a phantom "player at the exit" — the descend
// carries them along), and an uncleared floor has no usable exit, so it reads nobody-ready.
export function playersAtExit(w: WorldState): PlayerId[] {
  if (w.isSandbox || !isFloorCleared(w)) return [];
  const d = w.dungeon;
  const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
  const out: PlayerId[] = [];
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - ex, p.y - ey) < TILE) out.push(p.id);
  }
  return out;
}

function updateExit(w: WorldState, ev: SimEvent[]): void {
  if (w.isSandbox) return;
  if (!isFloorCleared(w)) return;
  // Party-wide gate: descend only when EVERY living (up) player stands at the exit. Solo has one
  // player, so this is identical to the old single-player check. The authoritative server owns
  // this decision entirely off server positions — no client triggers the transition.
  // Network-absent bodies are excluded on BOTH sides of the gate (see playersAtExit): they
  // can neither hold the party hostage for the whole grace window nor stand in as a phantom
  // "player at the exit". At least one PRESENT living player must be at the exit, so an
  // all-absent world never descends by itself; a reserved body is carried down with the
  // party (descend repositions every player) and resumes on the new floor.
  let living = 0;
  for (const p of w.players.values()) {
    if (!p.isDown && !p.isAbsent && p.hp > 0) living++;
  }
  if (living === 0 || playersAtExit(w).length < living) return;
  // Solo + shared server descend in-sim; the legacy Convex co-op path defers to the client's
  // shared-floor orchestration (everyone descends together via presence, offers ride descend).
  if (w.isCoop) {
    ev.push({ t: "reachExit", toFloor: w.floor + 1 });
    return;
  }
  // The safe-side blessing gate (spec §6 cadence, moved off the descend): with the party
  // gathered at a cleared floor's exit, raise this floor's offers ONCE, then hold the
  // descend until every pick resolves (or expires). The pick therefore always happens
  // BEFORE the next floor's threats exist — never mid-fight, never as a boss floor loads.
  // A boss floor's reward was its chest (the Rare pick), so leaving it offers nothing.
  if (!w.isBlessingOfferedThisFloor && !isBossFloor(w.floor)) {
    w.isBlessingOfferedThisFloor = true;
    // No offer for a network-absent body: it cannot answer, and its pending entry would hold
    // the party's descend for the full offer TTL. The trade (documented) is that a player
    // absent across the exit gate misses that floor's pick.
    for (const p of w.players.values()) if (!p.isAbsent) raiseBlessingOffer(w, p.id, false, ev);
    return;
  }
  if (w.pendingBlessings.size > 0) return;
  descend(w, w.floor + 1, ev);
}

// A floor descent (solo). Co-op's shared-floor sync is orchestrated client-side; the
// client calls descend via stepWorld's exit check or directly on a coop descend request.
// There is NO descent heal (§2) — the descent is pacing, not a free mistake reset.
export function descend(w: WorldState, nextFloor: number, ev: SimEvent[]): void {
  const isLeavingBossFloor = isBossFloor(w.floor);
  // Reward cadence (§6): one blessing offer per NON-BOSS descent for every player. In solo
  // and the authoritative shared world the exit gate already raised this floor's offers on
  // the safe side (isBlessingOfferedThisFloor — see updateExit), so the debt is paid. A
  // descend that arrives WITHOUT the gate having offered — a legacy co-op follower pulled
  // down by the room's shared floor, or a directly scripted descend — still owes each
  // player their pick and offers it post-load exactly as before (those clients freeze their
  // own local sim under the overlay, so the pick is safe there too).
  const isOfferDue = !isLeavingBossFloor && !w.isBlessingOfferedThisFloor;
  // Recovery pity (§2): two consecutive dry non-boss floors entered below 50% HP arm a
  // guaranteed heart in the next wood chest. Any generated heart resets the streak.
  if (!isLeavingBossFloor && w.heartsThisFloor === 0 && w.isFloorEnteredLow) {
    w.pityStreak++;
    if (w.pityStreak >= SUSTAIN.pityFloors) {
      w.isPityHeartArmed = true;
      w.pityStreak = 0;
    }
  } else if (w.heartsThisFloor > 0) {
    w.pityStreak = 0;
  }
  w.floor = nextFloor;
  for (const p of w.players.values()) {
    p.combo = 0; p.comboTimer = 0;
    // Descending rescues downed members — OUT (down-limit) members included: the living
    // party reaching the stairs pulls them through at the same partial HP a revive grants
    // (never at 0 — a "living" player with an empty bar must not exist). They land under
    // the spawn-grace shield like everyone, and the floor's down count starts over.
    if (p.isDown) p.hp = Math.max(p.hp, REVIVE.hp);
    p.isDown = false;
    p.reviveProgress = 0;
    p.reviveBy = null;
    p.downsThisFloor = 0;
    if (SUSTAIN.descentHeal > 0) p.hp = Math.min(p.maxHp, p.hp + SUSTAIN.descentHeal);
  }
  ev.push({ t: "descend", toFloor: nextFloor });
  loadFloorIntoWorld(w, nextFloor);
  if (isOfferDue) {
    for (const p of w.players.values()) if (!p.isAbsent) raiseBlessingOffer(w, p.id, false, ev);
  }
}

// ---- the step ----

// Advance ONE player for one input over dt: aim, movement/dash/collision, shooting, and the
// melee-swing timer. This is the per-player half of stepWorld, factored out so the
// authoritative server and client prediction can step ONLY the local player at an arbitrary
// dt (each InputCmd carries its own frame dt) while the world half runs once per fixed tick.
// stepWorld itself calls this, so solo behavior is unchanged.
export function stepPlayerPhase(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  // A player with a blessing offer open is paused: no aim, movement, fire, or revive
  // channel. Their client freezes under the overlay and sends nothing anyway; the guard
  // makes a tampered client equally inert.
  if (w.pendingBlessings.has(p.id)) {
    p.isInteracting = false;
    return;
  }
  const telemetry = p.pvpRespawnTelemetry;
  if (isPvp(w)
    && w.match?.phase === "live"
    && telemetry !== null
    && telemetry.timeToFirstInputMs === null
    && p.hp > 0) {
    const aimDelta = Math.abs(Math.atan2(
      Math.sin(input.aim - p.aimAngle),
      Math.cos(input.aim - p.aimAngle),
    ));
    const isMeaningfulInput = input.moveX !== 0
      || input.moveY !== 0
      || input.firing
      || input.dash
      || input.interact === true
      || input.ult === true
      || input.pulse === true
      || input.petAbility === true
      || aimDelta > 0.01;
    if (isMeaningfulInput) {
      telemetry.timeToFirstInputMs = Math.max(
        0,
        Math.round(telemetry.activeTicks * 1000 / TICKS_PER_SECOND),
      );
    }
  }
  updatePvpSpawnOffenseLatch(w, p, input, ev);
  p.aimAngle = input.aim;
  const isSpawnAttackSuppressed = isPvpSpawnAttackSuppressed(w, p);
  // The revive-channel intent, held only by a living player (a downed body can't revive).
  p.isInteracting = input.interact === true && !p.isDown && p.hp > 0;
  // The "ult requested" intent for this tick — consumed + validated in the AUTHORITATIVE
  // updateUlts (world phase), which online prediction never runs, so a client can only ask.
  p.isUltRequested = input.ult === true && !p.isDown && p.hp > 0 && !isSpawnAttackSuppressed;
  // The MENDER heal-pulse intent — same contract as the ult request (resolved in updateUlts).
  p.isPulseRequested = input.pulse === true && !p.isDown && p.hp > 0 && !isSpawnAttackSuppressed;
  // PVP WAVE 3 arena ult kit CLAIM: an ult SKIN only (never a co-op kit — kitId stays "none" in the
  // arena). Accepted only in the pvp arena and only OUTSIDE the live phase (lobby / countdown / over
  // — the claim locks at the whistle), so it never swaps mid-fight. Inert in co-op.
  if (isPvp(w) && (w.match === null || w.match.phase !== "live")) {
    const claim = input.arenaUltKit;
    if (claim === "gunner" || claim === "mender" || claim === "bulwark" || claim === "phantom") {
      p.arenaUltKit = claim;
    }
  }
  // The PET ABILITY intent. Production pets AUTO-cast (no bind), so a live client never sets this;
  // it survives only as a debug FORCE-cast the authoritative updatePetAbilities honors under the
  // same rails as auto-cast. Utility is OFF while downed, so a downed owner can never force it.
  p.isPetAbilityRequested = input.petAbility === true && !p.isDown && p.hp > 0 && !isSpawnAttackSuppressed;
  // Self-buff ult timers decay per player step (so prediction applies the server-granted buff
  // the server reconciles) alongside the melee-swing timer. Phase invuln is capped at cast.
  if (p.overdriveT > 0) p.overdriveT = p.overdriveT > dt ? p.overdriveT - dt : 0;
  if (p.overheatT > 0) p.overheatT = p.overheatT > dt ? p.overheatT - dt : 0;
  if (p.phaseSpeed > 0) p.phaseSpeed = p.phaseSpeed > dt ? p.phaseSpeed - dt : 0;
  if (p.ultInvuln > 0) p.ultInvuln = p.ultInvuln > dt ? p.ultInvuln - dt : 0;
  // respawnT > 0 is a pvp dead body awaiting respawn — no movement/shooting until it respawns
  // (respawnT is always 0 in co-op, so this is byte-identical there). isDown stays the co-op gate.
  // pvp: OUTSIDE the live phase (lobby / countdown freeze-in / match over) a player is FROZEN — no
  // movement, dash, fire, melee, charge, or deploy — so nothing can be pre-positioned before the
  // whistle or lobbed in after the match ends. Aim still tracks (cosmetic facing only). A live
  // grace pause keeps phase === "live", so the lone present player stays free to move while waiting.
  // AUTHORITATIVE-ONLY (isShared): the client's local prediction never runs the match machine, so
  // its predState.match sits in "lobby" — gating on isShared keeps client prediction byte-identical
  // (the server owns the freeze; the client mirrors it via reconciliation to the authoritative pose).
  const isPvpFrozen = isPvp(w) && w.isShared && (w.match === null || w.match.phase !== "live");
  if (!p.isDown && p.respawnT === 0 && !isPvpFrozen) {
    updatePlayer(w, p, input, dt, ev);
    updateShooting(w, p, input, dt, ev);
  }
  if (p.meleeSwing) {
    p.meleeSwing.timer -= dt;
    if (p.meleeSwing.timer <= 0) p.meleeSwing = null;
  }
}

// The world-systems half of stepWorld: bullets, enemies, props, chests, pickups, exit, and
// combo decay. Runs once per authoritative tick at the fixed step AFTER every player has been
// advanced. Only the sim RNG (w.rng) is consumed here, so the server is the single roller.
export function stepWorldPhase(w: WorldState, dt: number, ev: SimEvent[]): void {
  w.waveBClock += dt; // Content Wave B: monotonic real-seconds clock for the proc window
  for (const player of w.players.values()) {
    if (player.mods.bladeWardAbsorb <= 0) {
      player.bladeWardT = 0;
      player.bladeWardAbsorb = 0;
    }
    if (player.mods.momentumDamageBonus <= 0) {
      player.isMomentumArmed = false;
      player.momentumMoveSamples = [];
    }
    if (player.staggerPulseIcdT > 0 && player.staggerPulseAppliedTick !== w.tick) {
      player.staggerPulseIcdT = player.staggerPulseIcdT > dt ? player.staggerPulseIcdT - dt : 0;
    }
    if (player.bladeWardT > 0 && player.bladeWardAppliedTick !== w.tick) {
      player.bladeWardT = player.bladeWardT > dt ? player.bladeWardT - dt : 0;
      if (player.bladeWardT === 0) player.bladeWardAbsorb = 0;
    }
    if (player.isDown) {
      player.bladeWardT = 0;
      player.bladeWardAbsorb = 0;
    }
    if (player.momentumIcdT > 0) {
      player.momentumIcdT = player.momentumIcdT > dt ? player.momentumIcdT - dt : 0;
    }
  }
  w.barrelExplosionsThisTick = 0; // reset the per-tick explosive-barrel chain budget
  const pvp = isPvp(w);
  // Reset the per-victim per-tick pvp damage-cap accumulator BEFORE any damage this tick.
  if (pvp && w.match !== null) w.match.dmgThisTick.clear();
  // Movement/self-knockback ring-outs resolve before projectiles, so a body that has already
  // crossed the edge cannot be converted into an ordinary shot kill while falling.
  if (pvp) resolvePvpPits(w, ev);
  recordHistory(w);
  updateBullets(w, dt, ev);
  updateEffects(w, dt, ev);
  updateEnemies(w, dt, ev);
  updateGauntlet(w, dt, ev);
  updateHazards(w, dt, ev);
  updateProps(w, dt, ev);
  // The mode-gated DAMAGE-TARGETING concern: owned rounds/swings hit non-owner foe players. Runs
  // AFTER updateProps so breakable cover consumes a round before it can reach a player behind it
  // (real LOS cover), and after recordHistory (fire-time rewind samples ready).
  if (pvp) {
    stepArenaShoveWalls(w, ev); // PVP WAVE 3: a live frontal wall eats a foe shot before it lands
    resolvePvpHits(w, ev);
    resolvePvpPits(w, ev);
  }
  updateChests(w, dt, ev);
  updateFloorHazards(w, dt, ev);
  // Pet abilities resolve BEFORE pickup collection so a FETCH pulse can draw coins into reach the
  // same tick. The resolver is a hard no-op in pvp (abilities OFF in the arena — cosmetic follow
  // only), so a fetch/pinprick can never fire there and the wire fields stay zeroed.
  updatePetAbilities(w, dt, ev);
  updatePickups(w, dt, ev);
  if (pvp) {
    // The deathmatch replaces the whole co-op end-of-run loop: NO ult accrual/firing (ults off +
    // no-snowball), NO revives, NO all-down wipe, and NO floor descend. PvP's free draft reuses
    // only the shared offer timeout/apply plumbing.
    tickPendingBlessings(w, dt, ev);
    stepPvpHearth(w);
    stepPvpMatch(w, ev);
    stepPvpWeather(w);
    stepPvpKits(w, ev);
    stepArenaUlts(w, dt, ev); // PVP WAVE 3: arena-only ult charge/tell/cast (behind isPvp, live only)
  } else {
    updateUlts(w, ev);
    updateRevives(w, dt, ev);
    checkStrandedWipe(w, dt, ev);
    tickPendingBlessings(w, dt, ev);
    updateExit(w, ev);
  }

  for (const p of w.players.values()) {
    if (p.comboTimer > 0) {
      p.comboTimer -= dt;
      if (p.comboTimer <= 0) {
        const wasOnBeat = p.mods.beatFireRatePerTier > 0 && comboTierIndex(p.combo) > 0;
        p.comboTimer = 0;
        p.combo = 0;
        if (wasOnBeat) {
          ev.push({
            t: "blessingProc", pid: p.id, item: "on_the_beat",
            phase: "expired", x: p.x, y: p.y,
          });
        }
      }
    }
    if (p.fangCd > 0) p.fangCd = p.fangCd > dt ? p.fangCd - dt : 0;
  }

  // Friendly-nudge pair cooldowns decay on the sim clock; expired entries are dropped so
  // the map stays bounded (party-sized at most) even across a long fight.
  if (w.friendlyNudgeCd.size > 0) {
    for (const [key, left] of w.friendlyNudgeCd) {
      const next = left - dt;
      if (next <= 0) w.friendlyNudgeCd.delete(key);
      else w.friendlyNudgeCd.set(key, next);
    }
  }
}

export function beginWorldTick(w: WorldState): void {
  w.tick++;
  if (isPvp(w)) {
    w.pvpTelemetryEvents = [];
    syncPvpSpawnProtection(w);
  }
}

export function stepWorld(w: WorldState, inputs: Map<PlayerId, InputCmd>, dt: number): SimEvent[] {
  const ev: SimEvent[] = [];
  beginWorldTick(w);

  refreshWarmthDrain(w);

  if (isPvp(w)) {
    for (const id of [...w.players.keys()].sort()) {
      const p = w.players.get(id);
      if (p !== undefined && !p.isAbsent) {
        stepPlayerPhase(w, p, inputs.get(p.id) ?? IDLE_INPUT, dt, ev);
      }
    }
  } else {
    for (const p of w.players.values()) {
      stepPlayerPhase(w, p, inputs.get(p.id) ?? IDLE_INPUT, dt, ev);
    }
  }

  stepWorldPhase(w, dt, ev);

  return ev;
}

// ---- dev sandbox helpers (client dev tools mutate the world through these) ----

export function devSpawnEnemy(w: WorldState, kind: Enemy["kind"], x: number, y: number, tier?: EnemyTier): Enemy {
  // A dev/sandbox-spawned BOSS is its own pull: sample R off the loadouts standing
  // right now (harnesses grant weapons/blessings first, then spawn).
  if (isBossKind(kind)) w.encounterPower = sampleEncounterPower(w);
  const e = createEnemy(kind, x, y, w.floor, w.rng, w.nextEnemyId++, { players: w.encounterPlayers, tier, power: w.encounterPower });
  w.enemies.push(e);
  return e;
}
export function devSpawnProp(w: WorldState, kind: Prop["kind"], x: number, y: number): Prop {
  const p: Prop = { id: w.nextPropId++, kind, x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false };
  w.props.push(p);
  w.obstacleRev++;
  return p;
}
export function devSpawnChest(w: WorldState, x: number, y: number): void {
  w.chests.push({ id: w.nextChestId++, kind: "wood", x, y, radius: 16, opened: false });
}

// Dev flow inspector: the standard-class prop-aware chase field, lazily built off the
// current targets. Diagnostics only — reading it never changes game outcomes (the same
// cached build would happen on the next enemy query anyway).
export function navDebugField(w: WorldState): FlowField {
  return chaseFieldFor(w, ENEMY_ARCHETYPES.slime.radius);
}
