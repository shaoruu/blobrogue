import type { Dungeon, Room } from "../sim/dungeon.js";
import { TILE } from "../sim/types.js";
import type { Enemy, EnemyKind, Bullet, Particle, DmgNumber, Pickup, WeaponId, AttackMove, Prop, PropKind, Chest, Hazard, RemotePlayer, FloorHazard, FloorHazardKind, Effect, OrbitEffect } from "../sim/types.js";
import { floorHazardPhaseAt, floorHazardPhaseFrac, RIFT_PULL_RADIUS } from "../sim/hazards.js";
import type { FloorHazardPhase } from "../sim/hazards.js";
import { Rng, randomSeed } from "../sim/rng.js";
import { Sprites, TileSet, playerColor, playerColorOr, NEUTRAL_PLAYER_COLOR, FRAME, heroBodySprite, HELD_ART_ANGLE } from "./assets.js";
import type { SpriteName, SheetClip, TileName, FxName, PropSpriteName } from "./assets.js";
import { ENEMY_ARCHETYPES, isBossFloor, isBossKind, isGauntletFloor, eliteAffixOf, bossDisplayName } from "../sim/enemies.js";
import { WEAPONS, WEAPON_RARITY_COLOR, MYSTERY_COLOR } from "../sim/weapons.js";
import { weaponDisplayStats, lowHpFrac } from "../sim/weaponStats.js";
import { rollPvpDraftChoicesWith, itemById, itemDesc, itemLevelsOf, isPvpBlessingId, MAX_ITEM_LEVEL } from "../sim/items.js";
import type { PlayerMods, ItemDef } from "../sim/items.js";
import { PLAYER, REVIVE, BOSS, MARROW, WEAVER, GILDED, GORGE, PALE, TIERS, ELITE_BULWARK, MARSHAL, ROLL_AFFIX, RESONANCE_FAMILIES, RESONANCE_TELEGRAPH_COLOR } from "../sim/balance.js";
import type { GiantConst } from "../sim/balance.js";
import { giantRingGapCenter, giantSafeIntersection, giantSpokeWheel } from "../sim/giantGeometry.js";
import { petSpriteFor } from "./pets.js";
import { drawPetFrame, PET_RENDER_SIZE } from "./petRenderer.js";
import {
  createPetFollow, stepPetFollow, PET_REST_OFFSET, PET_REST_DROP, PET_MAX_SPEED,
} from "./petFollow.js";
import type { PetFollow } from "./petFollow.js";
import { DOGGIE_PET_ID, CAT_PET_ID, DRAGON_PET_ID, SLIME_PET_ID, WICK_PET_ID, PEBBLE_PET_ID, CLATTER_PET_ID, NULLFIN_PET_ID } from "../sim/camp_nodes.js";
import type { EnemyTier, EliteAffix, ResonanceFamily } from "../sim/balance.js";
import {
  shopViewerOf,
  shopSlotStatusFor,
  shopSlotPriceFor,
  shopSlotForViewer,
  PREMIUM_EVENT_KINDS,
  SHOP_FOCUS_RANGE,
} from "../sim/shop.js";
import type { ShopSlot, ShopSlotKind, ShopState, ShopViewer } from "../sim/shop.js";
import { shopPanelView, shopChipCopy, shopSlotName } from "../ui/shopCopy.js";
import { ShopPanel } from "../ui/shopPanel.js";
import { LocalTransport } from "../client/transport.js";
import type { Transport } from "../client/transport.js";
import { WSTransport } from "../client/wsTransport.js";
import { STAGE_B_SEED, STAGE_B_FLOOR, PROTOCOL_VERSION, FIXED_DT } from "../net/protocol.js";
import { resolveSpectateTarget, cycleSpectateTarget, isReconnectingTeammate } from "./spectate.js";
import { drawLoadoutOverlays } from "./cosmeticArt.js";
import { bodyPaletteIndex } from "./cosmetics.js";
import type { CosmeticLoadout } from "./cosmetics.js";
import { PartyGate } from "../net/partyGate.js";
import type { ExpectedMember, PartyGateView } from "../net/partyGate.js";
import { onlineHudLabel, netDetailsLine, reconnectOverlayCopy, BACK_ONLINE_TOAST, CONNECT_CANCEL_HINT, OFFER_EXPIRED_TOAST } from "../ui/onlineCopy.js";
import type { OnlineExitReason, OnlinePhase } from "../ui/onlineCopy.js";
import { applyItemToWorld, chooseBlessingInWorld, dismissBlessingOfferInWorld, applyMaxHpBonus, loadFloorIntoWorld, descend, devSpawnEnemy, devSpawnProp, devSpawnChest, acquireWeaponInWorld, isFloorCleared, isPvp, navDebugField, workerBuildSites, nearestShopSlot, isPlayerInCombat, rollBlessingChoicesInWorld, setPlayerKit, effectiveReviveRadius, effectiveReviveRate, grapplePreview, resolveWarmthDrain, spawnPlayerInWorld } from "../sim/world.js";
import type { WorldState, PlayerSim, MeleeSwing, RemoteTarget } from "../sim/world.js";
import { ULT, isRealKit, canCastUlt, KIT_META, MOMENTUM, OVERSHIELD, HEAL_PULSE, LIFEBLOOM } from "../sim/kits.js";
import { PET_ABILITY, petVerbFor } from "../sim/petAbilities.js";
import type { PetVerb } from "../sim/petAbilities.js";
import type { KitId } from "../sim/kits.js";
import { UltCueTracker, isFlyingMoteSource, isPassiveMeterPulse } from "./ultCue.js";
import type { UltMoteSource } from "./ultCue.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import {
  comboTierFor, BURROW_ERUPT_RADIUS, CHARGER_RUSH_SPEED, CHARGER_RUSH_DUR, SHIELDER_BLOCK_ARC,
  ROOTWARD_GUARD_ARC, SINDER_JET_SPEED, SINDER_JET_DUR, HALF_PI, MAX_OWNED_WEAPONS,
} from "../sim/constants.js";
import type { ComboTier } from "../sim/constants.js";
import { Minimap } from "./minimap.js";
import type { MinimapDot } from "./minimap.js";
import { Hud } from "./hud.js";
import type { ProfileStats, HudState } from "./hud.js";
import { buildArenaMatchHud, pvpMaterializeFraction } from "./arenaHud.js";
import type { CoopBridge, LocalPlayerState } from "./coop.js";
import {
  createAnim, resetAnim, stepAnim, triggerRecoil, triggerFlash, triggerBounce,
  characterXform, frameIndex, frameCount, CHARACTER_STYLE, BOSS_STYLE, IDENTITY_XFORM,
} from "./anim.js";
import type { Anim, Xform, XformStyle } from "./anim.js";
import { createFacing, computeEnemyPose } from "./facing.js";
import { TIER_LAYERS, bestiaryCue } from "./bestiaryAudio.js";
import type { FacingState, EnemyPose } from "./facing.js";
import { audio, sfx } from "./audio.js";
import type { SfxName, SfxOptions } from "./audio.js";
import { waveAudio } from "./waveAudio.js";
import type { WaveFramePlayer } from "./waveAudio.js";
import {
  blessingProcCue, EXPEDITION_BAND_ENTRY_EVENT, ODDSMAKER_OUTCOME_AUDIO,
  WAVE_HAZARDS, WEAPON_AUDIO, STATUS_AUDIO,
} from "./waveSpec.js";
import { pvpKillCue, pvpMatchOverCue, pvpFragStreakRate, pvpCountTickRate } from "./waveSpec.js";
import type { WaveEventId } from "./waveSpec.js";
import { ARENA_SALVO, ARENA_SHOVE, ARENA_SLIP, PVP, HEARTH, WEATHER, PVP_WEATHER_CARDINALS, pvpDraftSeed, pvpSpawnHardGraceTicks } from "../sim/pvp.js";
import type { ArenaUltKind, MatchPhase } from "../sim/pvp.js";
import { ShockwaveField, ScreenFlash, AmbienceField } from "./vfx.js";
import {
  ARENA_SALVO_CORE,
  ARENA_SALVO_GLOW,
  ARENA_ULT_HUE,
  ArenaUltVfx,
} from "./arenaUltVfx.js";
import type { ArenaUltCastView, ArenaUltMoment } from "./arenaUltVfx.js";
import { LightingRenderer } from "./lighting.js";
import type { StaticLightSpec } from "./lighting.js";
import {
  FRAME_MS_EMA_SEED,
  FX_QUALITY_MAX,
  FX_QUALITY_MIN,
  createFxQualityDwell,
  resetFxQualityDwell,
  updateFrameMsEma,
  updateFxQualityTier,
} from "./adaptiveFxQuality.js";
import { HALO_VISUAL_BASE, haloVisualStrength, haloVisualTier } from "./haloVisual.js";
import { settings } from "./settings.js";
import { InputController } from "./input.js";
import type { GameAction, InputContext } from "./input.js";
import { PauseOverlay } from "../ui/pause.js";
import { BlessingOverlay } from "../ui/blessing.js";
import {
  BIOMES, biomeForFloor, biomeIndexForFloor, expeditionRegionEntryForFloor, floorBannerText,
} from "../sim/biomes.js";
import type { Biome } from "../sim/biomes.js";
import { mutatorLabels, floorVisionMult } from "../sim/floorRolls.js";
import type { MutatorId, RollAffixId, BossAffixId } from "../sim/floorRolls.js";
import { renderDungeonTiles, buildWallSideGradients, tileHash, hexToRgb } from "./tileRender.js";
import type { TileRenderGradient } from "./tileRender.js";

export interface RunResult {
  floor: number; kills: number; coins: number; durationMs: number;
  // Authoritative run FACTS the SERVER banks Amber from (never a client-authored amber
  // number). floorsCleared counts cleared floors (from sim descend events); bossKills lists
  // the boss kinds defeated this run (first-kill grants resolve server-side); the two cache
  // flags mirror the premium economy's armed cache + mythic windfall; outcome drives the
  // 100%/50% bank fraction (WAVE 1 always ends in "death" — "return" lands with the hub).
  floorsCleared: number;
  bossKills: string[];
  isCacheArmed: boolean;
  amberWindfall: number;
  outcome: "death" | "return";
  // The run's final build (weapons carried + blessings with levels) for the results screen.
  // Display-only for gameplay; the id/count subset also rides recordRun so a personal-best
  // run's build shows on the player's leaderboard profile.
  build?: {
    weapons: { id: WeaponId; name: string }[];
    items: { id: string; name: string; glyph: string; tint: string; count: number }[];
  };
}

// Why a run exited without a game over: the player quit/cancelled, an online connection
// never came up, the server bound us to a world other than the room's (world_mismatch —
// refuse to play), the party never assembled behind the readiness veil (party_incomplete),
// the reconnect window ran out (connection_lost — the run is unreachable, NOT a death),
// another session took the body over (superseded), or the run finished while this player
// was mid-outage (run_ended_away — they see RUN ENDED WHILE AWAY, never a fabricated
// death). The copy contract for every reason lives in src/ui/onlineCopy.ts.
export type ExitReason = OnlineExitReason;

// Online (authoritative WS) start config. Solo/co-op are unchanged; online is opt-in behind
// explicit config and routes through WSTransport instead of LocalTransport.
export interface OnlineOptions {
  url: string;
  getTicket: () => Promise<string>;
  // The lobby room code this run belongs to (shown in the HUD so friends can be invited
  // mid-run); null for direct dev joins.
  roomCode: string | null;
  // The ONLY world this run is allowed to play in (worldIdForRoomCode of the lobby's code).
  // Every snapshot's authoritative world id is asserted against it — a mismatch closes the
  // socket and returns to the lobby. null for direct dev joins (no room expectation).
  expectedWorldId: string | null;
  // This player's lobby identity (matches the server roster's verified `aid`); null for dev.
  selfPlayerId: string | null;
  // The live lobby expectation for a PARTY-STARTED run: who should be in this world before
  // gameplay reveals. null = no readiness gate (quick play, drop-in join, rejoin, dev).
  party: (() => ExpectedMember[]) | null;
  // Mirrors the authoritative connection state onto the lobby roster (worldId once the
  // server's snapshot confirms the join, null on leaving) — best-effort UI plumbing.
  onWorldPresence?: (worldId: string | null) => void;
}

export interface StartOptions {
  mode: "solo" | "coop" | "online";
  coop?: CoopBridge | null;
  online?: OnlineOptions | null;
  profile?: ProfileStats | null;
  // The player's chosen KIT for this run (KIT/XP spec §5). Solo + classic co-op run the
  // in-process sim as the authority, so the kit is applied locally at start through the same
  // authoritative mutator the server uses on join. Online ignores this: the SERVER assigns the
  // ticket-verified kit. Omitted / undefined leaves the neutral "none" baseline (dev sandbox,
  // harness, existing goldens) untouched.
  kit?: KitId;
  // The player's chosen blob tint (client palette index). Applies to solo + online; classic
  // co-op keeps its room-assigned colors. null/0 renders the natural amber sprite.
  selfColorIndex?: number | null;
  // The player's equipped visual-only cosmetic loadout (hat/face overlays + body palette).
  // Solo + online; never touches the sim — teammates see the overlays via the verified
  // ticket identity instead, and body renders from the party color at launch.
  selfCosmetics?: CosmeticLoadout | null;
  // The player's equipped companion pet id (META spec §3), or null. A pure client-side
  // cosmetic follower rendered OUTSIDE the sim — it cannot desync a co-op run. Teammates'
  // pets arrive via the verified ticket identity on the wire (PlayerWire.pt).
  selfPet?: string | null;
}

// Read-only live state the dev sandbox panel polls for its readouts + button states.
// Populated only via the dev hooks below; nothing in normal play reads it.
export interface DevSnapshot {
  fps: number;
  frameMsEma: number;
  fxQuality: number;
  floor: number;
  hp: number;
  maxHp: number;
  weapon: WeaponId;
  isGodMode: boolean;
  isFlowDebug: boolean;
  isLighting: boolean;
  lightingMs: number;
  enemies: number;
  bullets: number;
  particles: number;
  props: number;
}

interface RemoteTracer { x: number; y: number; angle: number; life: number; color: string; len?: number; width?: number; isArc?: boolean; }
interface Corpse { sprite: SpriteName; x: number; y: number; size: number; facing: number; t: number; dur: number; }
// Per-teammate render bookkeeping: the walk/idle anim plus the dash-FX clocks (edge
// detection for the takeoff juice, spacing for the afterimage trail and the dust motes).
interface RemoteAnimEntry { anim: Anim; lastX: number; lastY: number; isDashing: boolean; dashImgCd: number; dashDustCd: number; }
// A companion pet's client-only render state (META spec §3): the lagged follow body (a trot
// velocity that scampers to catch up and coasts to a sit — see petFollow.ts), plus an anim
// clock for the idle-breathe / run cycle. Purely cosmetic — never a sim entity.
interface PetRenderEntry { petId: string; follow: PetFollow; anim: Anim; wasMoving: boolean; attackT: number; }
// How long a pet's one-shot ATTACK emote plays (owner fires -> pet reacts, then back to
// idle/walk). Purely cosmetic client-side expressiveness — zero sim impact. The attack strip
// plays through once across this window (petRenderer.drawPetFrame maps progress -> frame).
const PET_EMOTE_DUR = 0.42;
// Per-pet voice: a move cue (while trotting), a settle cue (on stop), and an optional trot
// loop. The doggie has the richest set (a felt trot loop + pant); the others get a small
// species move/settle. Cooldowns live in the wave spec, so this only fires on transitions.
const PET_VOICES: Record<string, { move: string; settle: string; trot?: WaveEventId }> = {
  [DOGGIE_PET_ID]: { move: "dog.pant", settle: "dog.settle", trot: "dog.trot" },
  [CAT_PET_ID]: { move: "cat.move", settle: "cat.settle" },
  [DRAGON_PET_ID]: { move: "dragon.move", settle: "dragon.settle" },
  [SLIME_PET_ID]: { move: "slimepet.move", settle: "slimepet.settle" },
  [WICK_PET_ID]: { move: "wick.move", settle: "wick.settle" },
  [PEBBLE_PET_ID]: { move: "pebble.move", settle: "pebble.settle" },
  [CLATTER_PET_ID]: { move: "clatter.move", settle: "clatter.settle" },
  [NULLFIN_PET_ID]: { move: "nullfin.move", settle: "nullfin.settle" },
};
// A short-lived floating text in world space (e.g. the name of a just-dropped weapon).
interface WorldLabel { x: number; y: number; vy: number; life: number; maxLife: number; text: string; color: string; }
// A coin token flying from its pickup spot (world x,y) up into the top-left wallet: t runs
// 0..1, arcing from the world position to the wallet's screen anchor, then the counter pops.
interface CoinFly { x: number; y: number; t: number; }
const COIN_FLY_DUR = 0.5;   // seconds for a coin to arc into the wallet
const COIN_FLY_MAX = 8;     // hard cap on live tokens (a mega-burst never swarms)
const COIN_FLY_ARC = 46;    // px of upward hump on the arc (reads as a lift-and-scoop)
// An ult CHARGE MOTE flying from a combat origin (world x,y) into the bottom-left ult meter:
// t runs 0..1 arcing to the meter's screen anchor, then a soft tick + a fill pulse. size maps
// off the accrued amount (trash small, elite/boss bigger); auto-collected (the visual IS the
// reward, never a pickup to walk to).
interface UltMoteFly { x: number; y: number; t: number; size: number; source: UltMoteSource; }
const ULT_MOTE_DUR = 0.42;  // seconds for a mote to arc into the meter
const ULT_MOTE_MAX = 24;    // hard cap on live motes (coalescing already bounds the spawn rate)
const ULT_MOTE_ARC = 40;    // px of upward hump on the arc
// The world-anchored "[F] <ULT> READY" nudge shown the FIRST time the ult is castable per run
// (reuses the interact-prompt chip renderer) so a new player learns what F does. Seconds it
// lingers over the player before fading.
const ULT_READY_NUDGE_SECONDS = 2.6;
// Kit accent hexes, mirroring the CSS --amber/--grn/--blu/--pur tokens (index.html :root): the
// canvas-drawn charge motes carry the kit's color while the HUD chrome resolves the same accent
// via --kit, so the two surfaces read as one identity.
const KIT_ACCENT: Record<Exclude<KitId, "none">, string> = {
  gunner: "#ffb43b", mender: "#7fdd5a", bulwark: "#5ab6ff", phantom: "#b06bff",
};
// World-anchored interact nudge (item 6, UI-designer spec): the floating [E] chip sits just
// ABOVE the target of the verb, offset by (target half-height + an 18px gap). Per-target so a
// small floor pickup, a downed blob (+ its revive ring), and a shop pedestal (+ price chip)
// each clear their own art. Screen-space top clamp keeps it onscreen. Easily tunable.
const INTERACT_OFFSET_PICKUP = 26; // ~24px sprite + 18px gap (target.y - 26)
const INTERACT_OFFSET_REVIVE = 40; // ~52px blob + ring, above the body
const INTERACT_OFFSET_SHOP = 44;   // above the pedestal + its price chip
const INTERACT_TOP_CLAMP = 14;     // never above this screen y
const INTERACT_KEY_PX = 13;        // the [E] keycap box size
// Floor stains + drop pulses that linger for a beat after the action moves on.
interface Decal { x: number; y: number; color: string; r: number; t: number; life: number; kind: "splat" | "ring"; }
// A fading ghost of the hero left along a dash so it reads as motion, not a teleport.
// color carries a REMOTE dasher's party tint; null means the local player's own tint.
// base is the body sprite the dasher was wearing (bald under a hat, else the classic hero),
// captured at drop time so the ghost matches the live body.
interface Afterimage { x: number; y: number; facing: number; t: number; color: string | null; base: SpriteName; }

// The i-frame blink: sim invulnerability (post-hit or the dash's own i-frame window)
// renders as a 10Hz alpha flicker keyed to the window's remaining seconds. One predicate
// for the local player AND remotes, mirroring the sim's isInvulnerable (either window).
export function isInvulnBlinkFrame(invulnSec: number, dashInvulnSec: number): boolean {
  const s = Math.max(invulnSec, dashInvulnSec);
  return s > 0 && Math.floor(s * 20) % 2 === 0;
}

const MAX_DECALS = 48;
const AFTERIMAGE_DUR = 0.28; // seconds a dash afterimage takes to fade out
// The online handshake (connect -> ticket -> join -> first snapshot) must resolve within
// this window or the veil exits explicitly — never an infinite ENTERING THE DUNGEON hold.
// Generous: covers a slow Convex mint + a TLS handshake; the transport retries inside it.
const CONNECT_HANDSHAKE_TIMEOUT_MS = 15000;

// Client FX magnitudes / tables the event handler + render read (the sim emits the events;
// the client decides the juice). Sim-side tuning lives in src/sim/constants.ts.
const SHOOT_SFX: Record<WeaponId, SfxName> = {
  pistol: "shootPistol",
  shotgun: "shootShotgun",
  rapid: "shootRapid",
  smg: "smg",
  cannon: "cannon",
  burst: "burst",
  ricochet: "ricochet",
  homing: "homing",
  tesla: "tesla",
  sawnoff: "shootShotgun",
  railgun: "cannon",
  nailer: "shootRapid",
  mortar: "cannon",
  beam: "tesla",
  flamer: "shootRapid",
  sword: "meleeSwing",
  longsword: "meleeSwing",
  spear: "meleeSwing",
  // Effect wave. lastlight/breach/frostline fire through the wave manifest first (see
  // WAVE_WEAPON_FIRE); these rows are the legacy fallback + the shared-sample stopgap
  // until their generated stems land. The non-shooting verbs (snapwire/halo/sentry/
  // crook) never raise a `shot` event — their dedicated effect events carry the sound —
  // but the Record stays exhaustive by contract.
  lastlight: "cannon",
  breach: "cannon",
  snapwire: "ricochet",
  frostline: "shootRapid",
  halo: "meleeSwing",
  sentry: "homing",
  crook: "meleeSwing",
  // The legendaries borrow the closest authored sample, re-pitched below (final authored
  // samples arrive with their art via the audio pipeline).
  reaper: "cannon",
  swarm: "homing",
  midas: "shootPistol",
  phase: "tesla",
  vortex: "cannon",
  // Content wave: each borrows the closest authored sample (final stems arrive with the art).
  cleaver: "cannon",
  scrapper: "shootRapid",
  skipper: "shootShotgun",
  arcbolt: "tesla",
  cryobolt: "shootRapid",
  firebomb: "cannon",
  tracker: "homing",
  singularity: "cannon",
  mooring_nail: "cannon",
  sluicegate: "shootShotgun",
  oddsmaker: "ricochet",
  pathmaker: "shootRapid",
  resonant_fork: "tesla",
  red_pen: "cannon",
  margin_call: "ricochet",
  sidewinder: "homing",
  hushiron: "cannon",
  backtalk: "ricochet",
  lamplighter: "shootRapid",
  faultlink: "tesla",
};
// Per-shot pitch/gain trims where a shared sample needs to read as a different gun
// (the railgun borrows the cannon boom, pitched up into a sharp crack).
const SHOOT_SFX_OPTS: Partial<Record<WeaponId, SfxOptions>> = {
  railgun: { rate: 1.35, gain: 0.85 },
  sawnoff: { rate: 0.9 },
  lastlight: { rate: 1.2, gain: 0.9 },
  breach: { rate: 0.85 },
  frostline: { rate: 1.4, gain: 0.5 },
  reaper: { rate: 1.2, gain: 0.8 },
  swarm: { rate: 0.8 },
  midas: { rate: 1.3, gain: 0.9 },
  phase: { rate: 0.7, gain: 0.8 },
  vortex: { rate: 0.6 },
  cleaver: { rate: 0.8, gain: 0.9 },
  scrapper: { rate: 1.25, gain: 0.7 },
  arcbolt: { rate: 1.2, gain: 0.85 },
  cryobolt: { rate: 1.5, gain: 0.6 },
  firebomb: { rate: 0.75, gain: 0.95 },
  singularity: { rate: 0.65, gain: 0.9 },
};
// Weapons whose shots leave a curl of barrel smoke (the beefy, black-powder end).
const SMOKY_WEAPONS: ReadonlySet<WeaponId> = new Set(["shotgun", "cannon", "sawnoff", "railgun"]);

// Per-melee-weapon feel: the swing cue, connect thump (trauma) and hit-stop, plus how big
// the held blade draws. Light/quick (cutlass) reads high and snappy; the claymore is the
// slow heavy arc with the dedicated heavySwing sample; the pike is a fast narrow lunge.
interface MeleeFeel {
  swingSfx: SfxName;
  swingRate: number;
  swingGain: number;
  hitTrauma: number;
  hitFreeze: number;
  impactSparks: number;
  sparkFan: number;
  sparkSpeed: number;
  impactKick: number;
  trailLength: number;
  trailWidth: number;
  trailIntensity: number;
  isHeavy: boolean;
  bladeSize: number; // held blade draw size in px (the 40px art scaled up)
  artAngle: number;  // baked-in angle of the blade axis in the art (rad; measured tip-ward)
}
const MELEE_FEEL: Partial<Record<WeaponId, MeleeFeel>> = {
  sword: {
    swingSfx: "meleeSwing", swingRate: 1.12, swingGain: 0.7,
    hitTrauma: 0.11, hitFreeze: 0.04, impactSparks: 9, sparkFan: 0.48, sparkSpeed: 1.18,
    impactKick: 0.6, trailLength: 0.58, trailWidth: 1, trailIntensity: 1, isHeavy: false,
    bladeSize: 46, artAngle: -0.80,
  },
  longsword: {
    swingSfx: "heavySwing", swingRate: 1, swingGain: 1,
    hitTrauma: 0.28, hitFreeze: 0.08, impactSparks: 7, sparkFan: 0.72, sparkSpeed: 0.82,
    impactKick: 1.4, trailLength: 0.72, trailWidth: 1.35, trailIntensity: 1.15, isHeavy: true,
    bladeSize: 56, artAngle: -0.80,
  },
  spear: {
    swingSfx: "meleeSwing", swingRate: 1.3, swingGain: 0.6,
    hitTrauma: 0.07, hitFreeze: 0.035, impactSparks: 6, sparkFan: 0.22, sparkSpeed: 1.3,
    impactKick: 2.2, trailLength: 1, trailWidth: 1, trailIntensity: 1, isHeavy: false,
    bladeSize: 58, artAngle: -0.80,
  },
};
const MELEE_HIT_TRAUMA = 0.14; // fallback thump when the striker's weapon is unknown (remote hits)
const MELEE_CLASH_FREEZE = 0.055; // extra stop when a swing connects mid enemy attack (the "parry")
const BOSS_SLAM_RADIUS = BOSS.slamRadius; // shockwave radius (also the ground-marker size)
const BOSS_JUMP_HEIGHT = 42;   // px the boss visually lifts mid hop-slam
const FREEZE_AT = 3;           // chill >= this renders as frozen-solid crust
const BURN_TINT = "#ff8a3b";   // ember/burn overlay + burn-tick dmg number color
const AIM_DASH: number[] = [7, 6]; // dashed aim-line pattern (telegraph render)
const SIDE_CHANNEL_ARMED_COLOR = "#5ab6ff";
const SIDE_CHANNEL_LANE_LENGTH = 180;

const DEATH_DUR = 0.3;        // seconds a fade-only corpse (ghost/spitter) animates out
const DEATH_DUR_SHEET = 0.4;  // slime/skeleton/bat: their 5-frame death clip
const DEATH_DUR_BOSS = 0.65;  // the boss's longer 8-frame death clip
const MUZZLE_DUR = 0.07; // seconds the muzzle flash lingers

// Hit-stop: freeze the sim for a beat on impact (render keeps going). Values are
// taken as a max, never summed, and capped so a busy frame can't grind to a halt.
const FREEZE_KILL = 0.04;     // a normal enemy dies
const FREEZE_HEAVY = 0.06;    // boss death / heavy impact
const FREEZE_HURT = 0.05;     // the player takes damage
const FREEZE_SHOTGUN = 0.035; // a point-blank shotgun pellet connects
const FREEZE_MAX = 0.08;

// Trauma-based screen shake. Events add trauma (clamped 0..1); it decays each second
// and the camera offset scales with trauma² so small hits barely register while big
// ones kick hard. The player's intensity setting (0..1) scales the whole thing.
const TRAUMA_DECAY = 1.6;
const SHAKE_MAX_PX = 26;
const FIRE_TRAUMA: Record<WeaponId, number> = {
  pistol: 0.12, shotgun: 0.5, rapid: 0.06,
  smg: 0.05, cannon: 0.55, burst: 0.18, ricochet: 0.14, homing: 0.05, tesla: 0.12,
  sawnoff: 0.6, railgun: 0.4, nailer: 0.06, flamer: 0.04, mortar: 0.45,
  beam: 0.02,
  sword: 0.08, longsword: 0.16, spear: 0.07,
  lastlight: 0.4, breach: 0.5, snapwire: 0.05, frostline: 0.03,
  halo: 0.14, sentry: 0.06, crook: 0.18,
  reaper: 0.22, swarm: 0.32, midas: 0.1, phase: 0.28, vortex: 0.4,
  cleaver: 0.35, scrapper: 0.07, skipper: 0.4, arcbolt: 0.18,
  cryobolt: 0.05, firebomb: 0.42, tracker: 0.14, singularity: 0.4,
  mooring_nail: 0.18, sluicegate: 0.3, oddsmaker: 0.22, pathmaker: 0.04,
  resonant_fork: 0.14, red_pen: 0.2, margin_call: 0.22, sidewinder: 0.12,
  hushiron: 0.16, backtalk: 0.18, lamplighter: 0.1, faultlink: 0.12,
};
// Per-weapon feel: recoil punch (sprite scale kick), camera kick (px, back along aim),
// and knockback (px the weapon shoves the player). The hand cannon is the beefy end.
const FIRE_RECOIL: Record<WeaponId, number> = {
  pistol: 1, shotgun: 1.4, rapid: 0.6,
  smg: 0.5, cannon: 1.6, burst: 0.9, ricochet: 1, homing: 0.4, tesla: 0.7,
  sawnoff: 1.6, railgun: 1.5, nailer: 0.6, flamer: 0.3, mortar: 1.4,
  beam: 0.15,
  sword: 0.7, longsword: 1.1, spear: 0.6,
  lastlight: 1.4, breach: 1.5, snapwire: 0.4, frostline: 0.25,
  halo: 0.8, sentry: 0.5, crook: 1.0,
  reaper: 1.1, swarm: 1.3, midas: 0.8, phase: 1.2, vortex: 1.4,
  cleaver: 1.3, scrapper: 0.5, skipper: 1.4, arcbolt: 0.8,
  cryobolt: 0.4, firebomb: 1.4, tracker: 0.6, singularity: 1.4,
  mooring_nail: 0.9, sluicegate: 1.1, oddsmaker: 1, pathmaker: 0.35,
  resonant_fork: 0.7, red_pen: 0.9, margin_call: 1, sidewinder: 0.6,
  hushiron: 0.8, backtalk: 0.7, lamplighter: 0.5, faultlink: 0.5,
};
const FIRE_KICK: Record<WeaponId, number> = {
  pistol: 3, shotgun: 8, rapid: 1.2,
  smg: 1, cannon: 10, burst: 2, ricochet: 3, homing: 0.5, tesla: 1.5,
  sawnoff: 11, railgun: 6, nailer: 1.2, flamer: 0.5, mortar: 7,
  beam: 0.3,
  sword: 1.5, longsword: 2.5, spear: 1,
  lastlight: 8, breach: 9, snapwire: 1, frostline: 0.5,
  halo: 2, sentry: 1, crook: 3,
  reaper: 4, swarm: 5, midas: 2, phase: 5, vortex: 6,
  cleaver: 6, scrapper: 1, skipper: 7, arcbolt: 2,
  cryobolt: 1, firebomb: 7, tracker: 1.5, singularity: 6,
  mooring_nail: 3, sluicegate: 5, oddsmaker: 4, pathmaker: 0.8,
  resonant_fork: 2, red_pen: 3, margin_call: 4, sidewinder: 1.5,
  hushiron: 3, backtalk: 3, lamplighter: 1.5, faultlink: 1.5,
};
const KICK_DECAY = 20; // how fast the camera kick eases back to center
const TRAUMA_HURT = 0.4;
const TRAUMA_KILL = 0.16;
const TRAUMA_BOSS_KILL = 0.7;
const TRAUMA_BOSS_SLAM = 0.4;
const TRAUMA_DESCEND = 0.22;
const TRAUMA_BOSS_FLOOR = 0.5;
const TRAUMA_REMOTE_DOWN = 0.3;

// How long (seconds) a Prism Sentry's post-shot recoil kick + muzzle flare plays out; the
// barrel eases back to rest over this window. Client render only (no sim/golden effect).
const SENTRY_RECOIL_TIME = 0.18;

// ---- combo / kill-chain multiplier (per-local-player, mirrors the kills counter) ----
// Each kill bumps the combo and refreshes a short window; let it lapse and the chain
// resets to 0. The combo tier drives a coin/score multiplier, a small kill-trauma ramp,
// and a rising kill-sound pitch — pure local upside, never shared/networked state (the
// combo lives beside kills/coins and is never published), so co-op stays desync-free.
const COMBO_WINDOW = 3;     // seconds a kill keeps the chain alive; every kill refreshes it
const COMBO_TRAUMA = 0.16;  // extra kill-trauma at the top tier, scaled by (mult-1); layered on TRAUMA_KILL
const COMBO_MAX_MULT = 3;   // top multiplier tier, referenced by the trauma/pitch ramps

const CHILL_TINT = "#7fd3ff";
const FREEZE_TINT = "#dff4ff";
const SHOCK_TINT = "#7fe9ff";
const MARK_TINT = "#c9a0ff"; // PHANTOM dash-through mark ring (the phantom violet accent)
const STALK_TINT = "#b98bff"; // Cat STALK info-pip caret (a cooler, quieter violet than the mark)

// Hurt vignette: a red screen-edge flash on damage that fades fast (seconds⁻¹).
const HURT_FLASH_DECAY = 3.2;
// Low-HP warning: at/below this health fraction the screen edge breathes red.
const LOW_HP_FRAC = 0.25;

// Client particle budget: the newest effect wins; the oldest particle is dropped when the
// pool is full, so a busy screen degrades gracefully instead of eating the frame budget.
const MAX_PARTICLES = 700;
const FX_CAMERA_MARGIN_MIN = 40;
const FX_CAMERA_MARGIN_MAX = 160;
// Per-frame FX burst coalescing: a thumper into an explosive-barrel cluster can land many
// explosions + kills in ONE frame. The first FX_BURST_FULL on-screen bursts spawn at full
// particle counts; beyond that per-event counts scale down so the frame's total spawn work
// stays bounded (the pools already FIFO-evict — this keeps them from thrashing).
const FX_BURST_FULL = 3;
const FX_BURST_HALF = 8;
const HALO_IMPACT_SAMPLES = 4;
const HALO_IMPACT_TRAUMA_CAP = 0.28;
// Hard cap on lingering corpse sprites: unbounded corpses grew both the array and the draw
// loop through a long fight. When full, the oldest corpse shifts out.
const MAX_CORPSES = 32;
const FOOTSTEP_INTERVAL = 0.17; // seconds between dust kicks while running

// ---- combat depth: telegraph rendering ----
// A per-enemy windup (0..1) drives a pulsing colored aura + aim line; the boss adds a
// ground shadow ring for its slam. Colors read the threat by attack type. The actual
// attack timing/tuning lives with each enemy's AI (see docs/COMBAT_SPEC.md).
const TELEGRAPH_COLOR: Record<AttackMove, string> = {
  none: "#ffffff",
  lunge: "#ff5a5a",   // skeleton: red coil
  spit: "#ff5a7a",    // spitter: rose caster
  hopslam: "#ffd27a", // boss slam: amber
  radial: "#c98bff",  // boss burst: violet
  roar: "#ffb43b",    // boss phase change: gold
  squeeze: "#ff5a5a", // boss arena squeeze: closing red ring
  rush: "#ff8a3b",    // charger / MARROW line charge: hot orange lane
  crash: "#ffd27a",   // post-crash stun (no windup renders; the dizzy wobble carries it)
  dive: "#c9a06a",    // burrower submerge: earthen shudder
  erupt: "#ff5a5a",   // burrower eruption marker: red danger disc
  volley: "#dceef5",  // MARROW bone fan: pale bone
  spin: "#dceef5",    // MARROW spiral barrage
  shield: "#7fd6ff",  // MARROW transition shield: cold blue
  fade: "#bfe9ff",    // Choir submerging into intangibility: cold mist
  wail: "#9fd8ff",    // Choir homing wail volley
  split: "#bfe9ff",   // Choir wisp-split beat
  pounce: "#c98bff",  // Weaver drop-from-above: Deep violet
  weave: "#c98bff",   // Weaver web planting
  slam: "#ffd166",    // Gilded Warden anvil quake: gold
  sweep: "#ffd166",   // Gilded Warden ring waves
  brace: "#9fb4a8",   // elite brace: braced steel-green slide
  decoy: "#d7b8ff",   // echojack planting its false noise: pale violet jangle
  build: "#a8e07a",   // worker raise (bailiff divider / mason L-corner): living green footprint
  blink: "#d7b8ff",   // echojack's perpendicular relocation dash
  seam: "#e88fb1",    // seamcutter's previewed wall-to-wall lane
  stoke: "#ff8a3b",   // sinderling self-arming channel: gathering embers
  harmonize: "#bfe9ff", // fragment tether pulse: the Choir's cold light
  knell: "#c9b458",   // The Toll's expanding sound ring: bronze
  mirror: "#8a7bd8",  // JET's corrupted-Resonance salvo: cold indigo mirror-light
  merge: "#e8d9b0",   // QUORUM's fuse-merge: pale bone gather
  // Wave 1 rework — the interleaved pressure moves.
  tracer: "#b39ddb",  // JET's dash-punish motes: pale indigo lock
  beam: "#d84a8a",    // JET overclock/corruption + Quorum crossfire: hot corridor magenta
  spew: "#ffb43b",    // the Tithe's two-stage arcing pools: amber ooze
  hurl: "#c98b5a",    // the Tithe hurls its slab: heavy amber stone
  rip: "#ffcf6a",     // the Tithe's P3 rip: the all-slabs debris wheel (bright amber)
  worldsplit: "#e8d9b0", // Sever WORLDSPLIT: pale bone fracture tell
  last_light: "#bfeaff", // Pale THE LAST LIGHT FALLS: cold stolen-sun meteor tell
  last_note: "#d4c4ff", // Choirmaster THE LAST NOTE: hollow violet sheet tell
  river_comes_back: "#6ec8ff", // Undertow THE RIVER COMES BACK: cold flood tell
  all_things_owed: "#e0b64a", // Claimant ALL THINGS OWED: angular gilded crown-lane tell
  last_procession: "#6b5a9a", // Wake THE LAST PROCESSION: dusk-violet blackout/dark-front tell
};

// BOSS TELEGRAPH RENDER CONTRACT (docs/specs/blobrogue_TELEGRAPH_RENDER_CONTRACT.md +
// _GEOMETRY.md + _PARAM_DEFAULTS.md). The reworked boss attacks decompose into reusable
// parametric primitives drawn on the GROUND PLANE (under sprites) in a RESERVED register
// (never bullet/player-FX colors): a family-hue FILL (which boss) + a universal hot danger
// EDGE (this HURTS). Safe pockets are NEVER painted — clear floor IS the safe read. FIXED
// tells are crisp from cast; DYNAMIC (aim-locking) tells follow the target with a soft edge,
// then SNAP crisp + flash on the AUTHORITATIVE isAimLocked commit (never an art timer).
const TG_DANGER_EDGE = "#ff6a3b";   // universal hot danger hatch/edge ("dodge this")
// JET surprise-layer palette (AD hard gates — JET_SURPRISE_LAYER_DIRECTION). The echo is
// player-SHAPED, so the ENTIRE separation from a warm solid teammate rides value + opacity +
// cold + telegraph (NEVER shape). A teammate averages lum ~0.68 (bright amber, solid, no
// telegraph); the echo is the opposite on every axis.
const JET_ECHO_INK = "#0e0b1a";      // near-black echo body (lum ~0.05) — an enormous value gap under a teammate
const JET_ECHO_RIM = "#2a5fa0";      // thin COLD-blue anti-vanish rim (edge only, never a fill)
const JET_ECHO_RIM_HOT = "#57b6ff";  // sparse cold hot-points on the rim (never warm)
const JET_ECHO_SEAM = "#7a3d12";     // DARK dead-amber seams ONLY (lum ~0.28) — NEVER hero-bright amber (that IS a teammate)
const JET_ECHO_EYE_PIN = "#7fe0ff";  // cold-cyan pinpoint in the hollow void eyes
const JET_ECHO_TELL = "#57b6ff";     // the 0.7s pre-fire cold hatched danger-edge (a separator no teammate has)
// Corruption reshape (AD Part 2): the creep RECEDES (recessive cold-blue, low-contrast, within
// the floor value band — MOOD), but each DRAIN ZONE is the real hazard, so its EDGE reads
// "don't stand here" — a BRIGHT authored hatched edge in the reserved telegraph register (kept
// COLD, distinct from the hot attack register, so it reads as JET's persistent corruption).
const JET_CORRUPT_FILL = "#0b1220";  // recessive cold-blue corruption fill (mood)
const JET_CORRUPT_EDGE = "#57b6ff";  // bright cold-frost hatched drain-zone edge ("don't stand here")
const JET_SAFE_AMBER = "122,61,18";  // dead-amber safe-pocket wash (rgb; warmer/lighter, never hero-bright)
const TG_FILL_ALPHA = 0.26;          // family-hue fill (§R2 ~0.22-0.30)
// HARD RENDERER RULE (safe-pocket clamp): every computed safe pocket must stay >= 48px (the
// body+margin stand-minimum). If one would shrink below at runtime (e.g. a CONVERGE_POCKET
// closing), clamp it to this 64px floor — a sealed pocket is unfair, so clamp, never close.
const TG_POCKET_MIN = 64;
const TG_ARENA_LEN = 1100;           // "full arena length" for beam/lance lanes (covers the view)
// Family FILL hue per boss (Jet cold-indigo / Tithe amber / Quorum bone-cyan). Value+edge+shape
// carry the read in 4p chaos, never hue alone; the aura ring (renderBossAura) is the low-sat
// ambient twin of these.
function tgFamilyHue(kind: EnemyKind): string {
  return kind === "jet" ? "#5b63d6" : kind === "tithe" ? "#e6952f" : kind === "gorge" ? "#d9822c"
    : kind === "pale" ? "#57b6ff" // PALE THRONE: COLD-blue telegraphs (never amber — the warmth-drain material)
    : "#7fd6da";
}

// ---- THE GIANT MATERIAL (client render only — the ONE difference between the giants) ----
// Every giant (Gorge F50 / Pale Throne F75 / — F100 Unmaker) runs the identical shell-peel
// encounter (see world.ts updateGiant); the client dresses each in its own material. Gorge is the
// warm AMBER slag (the players' stolen amber); Pale is COLD warmth-drain — cold-blue seams and a
// cold-white/blue crystalline core ("a blazing ABSENCE of warmth"), pulled from the F75 manifest.
// Pure presentation: nothing here touches the sim or the wire. The third giant is one more entry.
interface GiantMaterial {
  coreGlow: string;   // P3 bared-core additive bloom
  coreDot: string;    // P3 bared-core hot center
  seamGlow: string;   // weak-point crack-node bloom
  seamDot: string;    // weak-point bright center
  exposeHot: string;  // earned-window EXPOSED core blaze
  guardRim: string;   // earned-window GUARDED shell rim (dim/sealed)
  auraGuard: string;  // ground aura ring, guarded
  auraExpose: string; // ground aura ring, exposed (drained)
}
const GIANT_MATERIAL: Readonly<Record<"gorge" | "pale", GiantMaterial>> = {
  // GORGE (F50): molten amber — the ONE bright warm read on an enemy (unchanged, byte-for-byte).
  gorge: {
    coreGlow: "#ffb43b", coreDot: "#ffd166", seamGlow: "#ffb43b", seamDot: "#ffe6a6",
    exposeHot: "#ffb43b", guardRim: "#6b6152", auraGuard: "#b06a28", auraExpose: "#7a5228",
  },
  // PALE THRONE (F75): cold warmth-drain — cold-blue seams (#57b6ff), a cold-white/blue core blaze
  // (#bfeaff bloom over a #ffffff center), and a cold rime-slate guarded rim / cold-blue ground aura.
  pale: {
    coreGlow: "#bfeaff", coreDot: "#ffffff", seamGlow: "#57b6ff", seamDot: "#bfeaff",
    exposeHot: "#bfeaff", guardRim: "#6b6f8a", auraGuard: "#2f6bb0", auraExpose: "#24456e",
  },
};

// The giant boss bodies (Gorge/Pale) and their weak-point mechanic bodies — narrowing helpers so
// the shared giant render (core glow, seam glow, guard/expose aura, telegraphs) keys off one place.
function isGiantKind(kind: EnemyKind): kind is "gorge" | "pale" {
  return kind === "gorge" || kind === "pale";
}
function isGiantSeamKind(kind: EnemyKind): kind is "gorge_seam" | "pale_seam" {
  return kind === "gorge_seam" || kind === "pale_seam";
}
// The constants block driving a giant's telegraph geometry (spoke count/gap). Gorge & Pale share
// these today; keyed per-kind so a future giant can tune them without a render edit.
function giantConstFor(kind: "gorge" | "pale"): GiantConst {
  return kind === "pale" ? PALE : GORGE;
}
// A giant weak-point's body kind maps to its giant's material (for the seam crack-node glow).
function giantSeamMaterial(kind: "gorge_seam" | "pale_seam"): GiantMaterial {
  return kind === "pale_seam" ? GIANT_MATERIAL.pale : GIANT_MATERIAL.gorge;
}

// The elite affix's ground-ring accent (derived from kind — the affix table is pure sim
// data, so the client can color the tell without any extra wire state).
const AFFIX_RING_COLOR: Record<EliteAffix, string> = {
  brace: "#9fb4a8",
  commander: "#ffd166", // the horn: gold
  bulwark: "#cfd6dd",   // the plate: steel
  volatile: "#ff5a3b",  // the fuse: hot red-orange
  echoed: "#7fe9ff",    // the repeat: cold cyan
};

// Fallback disc tint per sprite while its PNG streams in (or before generated art lands):
// each enemy keeps its identity color instead of everything reading as a purple slime.
const SPRITE_FALLBACK_TINT: Partial<Record<SpriteName, string>> = (() => {
  const tints: Partial<Record<SpriteName, string>> = {};
  for (const arch of Object.values(ENEMY_ARCHETYPES)) tints[arch.sprite] = arch.tint;
  return tints;
})();

// Ground-ring accents that make brutes/elites read at a glance (tier is also on the wire).
const TIER_RING_COLOR: Partial<Record<EnemyTier, string>> = {
  brute: "#ff8a3b",
  elite: "#c98bff",
};

const AIM_SOLID: number[] = [];

// Animated prop frame tables (indexed by frameIndex), hoisted so the tile loop never allocates.
const TORCH_FRAMES: TileName[] = ["torch_f0", "torch_f1", "torch_f2"];

// ---- dynamic light recipes (see lighting.ts; spec §3 benchmark radii) ----
// The hero's amber identity glow: a readability floor around the player, never off.
// The small stain keeps walkable ground visibly lit even where the biome's floor art
// is darker than the ambient grade could ever account for (the Null's near-black).
const HERO_GLOW_RADIUS = 110;
const HERO_GLOW_CUT = 0.55;
const HERO_GLOW_STAIN = 0.24;
const HERO_GLOW_COLOR = "#ffc86b";
const REMOTE_GLOW_RADIUS = 96;
const REMOTE_GLOW_CUT = 0.45;
const REMOTE_GLOW_STAIN = 0.18;
const MUZZLE_LIGHT_RADIUS = 74;
const EXIT_LIGHT_RADIUS = 96;
// Luminous projectiles ONLY (restraint: plain slugs carry their streak art, no light).
// The Wisp (homing) is the cold seeker glow; the Sunlance (beam) the hot line.
const BULLET_LIGHTS: Partial<Record<WeaponId, { radius: number; cut: number }>> = {
  beam: { radius: 70, cut: 0.6 },
  tesla: { radius: 55, cut: 0.5 },
  flamer: { radius: 48, cut: 0.5 },
  railgun: { radius: 62, cut: 0.55 },
  homing: { radius: 55, cut: 0.45 },
  mortar: { radius: 50, cut: 0.45 },
  cannon: { radius: 45, cut: 0.4 },
};
// Explosion light pulse (spec: full pulse then fast falloff, capped radius).
const EXPLOSION_LIGHT_MAX = 240;
const EXPLOSION_LIGHT_DUR = 0.42;

// ---- destructible props + treasure chests ----
// Placement is seeded per floor (co-op layout agreement); destruction resolves on the
// shared floor state via bullets/explosions, exactly like enemies. Reward rolls use the
// local RNG, matching enemy dropLoot (world pickups are first-come).
const PROP_DRAW = 48;            // px the 64px prop sprite is drawn at (tile-sized)
const PROP_BREAK_DUR = 0.25;     // seconds the 2-frame break clip plays before removal
const CHEST_OPEN_DUR = 0.4;      // seconds the 3-frame chest-open clip plays, then holds
// Intact render source per kind: crate/pot/barrel show frame 0 of their break sheet;
// the explosive barrel + brazier are their own 64px statics.
const PROP_INTACT_IMG: Record<PropKind, PropSpriteName> = {
  crate: "crate_break", pot: "pot_break", barrel: "barrel_break",
  barrel_explosive: "barrel_explosive", brazier: "brazier",
  root_wall: "root_wall_break", silt_mound: "silt_mound_break", clinker_brick: "clinker_brick_break",
  // The GORGE giant's shell debris reuses the silt-mound rubble art (a Sump chunk), amber-tinted.
  gorge_debris: "silt_mound_break",
  // The PALE THRONE giant's shell debris reuses the same rubble art, cold-tinted (a cold-stone chunk).
  pale_debris: "silt_mound_break",
};
// Break sheet per destructible kind (frames 1-2 = breaking). Brazier never breaks.
const PROP_BREAK_SHEET: Record<PropKind, PropSpriteName | null> = {
  crate: "crate_break", pot: "pot_break", barrel: "barrel_break",
  barrel_explosive: "barrel_explosive_break", brazier: null,
  root_wall: "root_wall_break", silt_mound: "silt_mound_break", clinker_brick: "clinker_brick_break",
  gorge_debris: "silt_mound_break",
  pale_debris: "silt_mound_break",
};
const PROP_TINT: Record<PropKind, string> = {
  crate: "#c9a06a", pot: "#8fb8d6", barrel: "#b07a3c", barrel_explosive: "#ff8a3b", brazier: "#ffb43b",
  root_wall: "#86c06c", silt_mound: "#b8a888", clinker_brick: "#c9743f",
  gorge_debris: "#c77320", // warm amber slag (the giant's material — not the bright core amber)
  pale_debris: "#2a5fa0", // cold slate-blue (the F75 giant's cold-stone shell — the amber→cold swap)
};
// Patch's station art hooks per slot kind (assets.ts PROP_SOURCES); flat primitives
// stand in until the approved PNGs land.
const SHOP_STATION_IMG: Record<ShopSlot["kind"], PropSpriteName> = {
  weapon: "shop_pedestal",
  blessing: "shop_pedestal",
  heart: "shop_heart_station",
  reroll: "shop_reroll_post",
  mystery: "shop_pedestal",
  legendary: "shop_pedestal",
  rare_blessing: "shop_pedestal",
  max_hp: "shop_heart_station",
  full_heal: "shop_heart_station",
  core_infusion: "shop_pedestal",
  prospector: "shop_pedestal",
  weapon_upgrade: "shop_reroll_post",
  revive_token: "shop_heart_station",
  extra_slot: "shop_pedestal",
  reroll_all: "shop_reroll_post",
  amber_cache: "shop_pedestal",
  artifact: "shop_pedestal",
  mythic_weapon: "shop_pedestal",
  mythic_trio: "shop_pedestal",
  mythic_amber: "shop_pedestal",
};
// Subtle idle bob/flash for props + chests — a fraction of the character juice so a crate
// reads as a solid object, not a jelly.
const PROP_STYLE: XformStyle = { freq: 2.1, bob: 0.7, squash: 0.03, hop: 0, lean: 0 };

// ---- hazard render tables (see renderHazards) ----
// Spike socket centers within the 48px tile (a 2x2 trap plate).
const SPIKE_SOCKETS: ReadonlyArray<[number, number]> = [[14, 15], [34, 15], [14, 35], [34, 35]];
// Toxic-pool liquid palette per curriculum band (wet roots, warren murk, cave water,
// jet resin, gilded amber, slag, anti-light).
interface PoolStyle { base: string; edge: string; sheen: string }
const POOL_STYLES: readonly PoolStyle[] = [
  { base: "#14301e", edge: "#3fbf5f", sheen: "#8fffa8" },
  { base: "#1a2a10", edge: "#6b8a2e", sheen: "#c8e86a" },
  { base: "#12262e", edge: "#2a5a6a", sheen: "#57b6ff" },
  { base: "#1a1430", edge: "#46356b", sheen: "#a24bff" },
  { base: "#241c08", edge: "#8a6b1f", sheen: "#ffd166" },
  { base: "#20140e", edge: "#7a3d12", sheen: "#ffb43b" },
  { base: "#220c26", edge: "#6a2fb0", sheen: "#ff4ad8" },
];
// Hazard impact tint for the hazardHit event juice.
const HAZARD_HIT_TINT: Record<FloorHazardKind, string> = {
  spikes: "#c9c9de", toxic_pool: "#3fbf5f", fire_vent: "#ff8a3b", void_rift: "#d9a6ff",
};
// Manifest §6: the toxic pool's surface loop sounds only while a player is this close.
const TOXIC_LOOP_RADIUS = 120;

export class Game {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private sprites = new Sprites();
  private tiles = new TileSet();
  private minimap: Minimap;
  private hud: Hud;
  private onGameOver: (result: RunResult) => void;
  private onExit: (reason?: ExitReason, detail?: string) => void;
  // Fired on each descend with the floor just reached — the client hook that banks deepest
  // floor progressively (so depth is recorded even when the run ends by disconnect/quit,
  // not just a clean full-party-wipe game over). Optional: solo tooling passes nothing.
  private onFloorReached: (floor: number) => void;
  private onArenaRequeue: () => void;
  private pause: PauseOverlay;
  private blessing: BlessingOverlay;
  private shopPanel: ShopPanel;
  // Patch's handover pose timer (seconds left in the one-shot sell clip) and the per-floor
  // "welcome" latch (the first step into the waystation names it once).
  private patchSellT = 0;
  private isShopWelcomed = false;
  // Your own purchase just landed: holds the panel's BOUGHT ✓ footer briefly so a buy
  // reads "keep shopping", never a silent state flip.
  private shopBoughtT = 0;
  private isPaused = false;
  private isChoosing = false; // a between-floor blessing overlay is up (freezes the sim)
  private isArenaRequeuePending = false;
  // Online: whether gameplay has been revealed yet. Until then the run sits behind the
  // readiness veil: first CONNECTING (no authoritative snapshot), then — for a party-started
  // run — WAITING FOR PARTY until the server's own roster contains every expected member.
  private isWorldRevealed = false;
  // The readiness gate for a party-started run (null = ungated: quick play/drop-in/dev) and
  // its latest evaluation (drives the veil's member list).
  private partyGate: PartyGate | null = null;
  private partyView: PartyGateView | null = null;
  // The authoritative geometry that arrived while the veil was up, applied at reveal.
  private pendingWorld: { seed: number; floor: number } | null = null;
  private isWorldReported = false; // the lobby mirror heard about this world join
  // Handshake deadline: the CONNECTING veil may never sit forever — if no authoritative
  // snapshot arrives by this wall-clock time, the run exits with an explicit failure.
  private connectDeadline = 0;
  // Edge detector for the outage overlay (drives the BACK ONLINE toast on recovery).
  private isOutageSeen = false;
  // The authoritative tick when the current online blessing overlay opened (guards the
  // wait-state watchdog against a fresh offer's snapshot lag).
  private choosingSinceTick = 0;

  // The simulation is owned by the Transport. Solo/co-op run stepWorld in-process
  // (LocalTransport); online routes through WSTransport (predict + reconcile against an
  // authoritative server). The client reads the world for rendering + camera and drives it via
  // InputCmds; it never mutates sim state directly outside dev tools + blessing picks.
  private mode: "solo" | "coop" | "online" = "solo";
  private localTransport = new LocalTransport();
  private wsTransport: WSTransport | null = null;
  private get transport(): Transport {
    return this.mode === "online" && this.wsTransport ? this.wsTransport : this.localTransport;
  }
  private world!: WorldState;
  private inputSeq = 0;
  // A held Breach charge must never fire out of a menu: when input leaves the gameplay
  // context mid-charge, this latch turns subsequent input frames into the sim's explicit
  // charge-cancel intent (dash bit, no movement, no fire) until the charge reads 0.
  private isChargeCancelPending = false;
  // Dev sandbox: a one-frame ult-request pulse the panel's "Cast ult" button arms.
  private devUltPulse = false;
  // PVP WAVE 3: the pending arena ult kit CLAIM (ult skin), sent on the input frame until the
  // server reflects it (SelfWire.auk) or the match goes live (the claim locks at the whistle).
  private pendingArenaKit = "";
  // ---- the semantic weapon-audio state machine (client-side edges over authoritative
  // state; every cue is a WEAPON_AUDIO contract state, never a file name) ----
  private audioPrevWeapon: WeaponId | null = null;
  private audioPrevChargeT = 0;
  private isChargeThresholdCued = false;
  private isChargeLockCued = false;
  private isBreachReleaseSeen = false;
  private isRiskBandOpen = false;
  private audioOrbitSector = -1;
  // PvP (client-only) audio edge memory. The match block only exists online; these track the
  // phase/countdown/respawn edges the match-flow cues fire on.
  private isPvpMatchSeen = false;
  private pvpPrevPhase: MatchPhase | null = null;
  private pvpLastCountSecond = -1;
  private pvpPrevRespawnT: number | null = null;
  // Short-fuse scheduled cues (the sentry's place -> unfold beat).
  private pendingCues: Array<{ t: number; name: string; x: number; y: number }> = [];
  private seed = 0;
  private comboFreeze = false; // dev/sandbox: hold the chain at a set value so the HUD can be gated

  // player (client-only cosmetics)
  private ownedItemDefs: ItemDef[] = []; // mirror of the local player's picked items, for the HUD
  private selfColorIndex: number | null = null; // chosen blob tint (solo + online); null/0 = natural amber
  private selfCosmetics: CosmeticLoadout | null = null; // equipped cosmetic loadout (visual-only)
  private selfPet: string | null = null; // equipped companion pet id (visual-only, out-of-sim)
  // WAVE 1 run facts fed to the SERVER-authoritative Amber bank (never a client amber number):
  // cleared-floor count (one per descend event) + the boss kinds defeated this run.
  private runFloorsCleared = 0;
  private runBossKills = new Set<string>();
  // Per-owner client-side pet render state (lagged follow position + sit/trot anim), keyed by
  // player id. Pure cosmetic — never in the sim, never targetable, never a gameplay input.
  private petRenders = new Map<string, PetRenderEntry>();
  private lastPetTs = 0; // performance.now() of the last pet-follow frame (own display-rate dt)
  // The wall test the client-only pet follow slides against — the SAME solid-tile probe the
  // player's own movement uses (isWallAt). Bound once so the per-pet per-frame step passes it
  // with no closure allocation on the hot path.
  private readonly petWallAt = (x: number, y: number): boolean => this.isWallAt(x, y);
  private online: OnlineOptions | null = null;  // the active online run config (null otherwise)
  // Spectate: the teammate a downed local player's camera follows (null while up / solo).
  // Cycling runs through cycleSpectate so any input source (Q/E, arrows, a controller) shares
  // one path; sentSpectateId tracks what the server was last told (interest centering).
  private spectateId: string | null = null;
  // Spectate follow mode (F): watch the teammate, or your own body (see who's coming).
  private isSpectatingBody = false;
  // Client-side revive-interrupt read: the last authoritative self progress, and a short
  // flash timer when it snaps back to zero mid-channel (the gate's hard reset).
  private lastSelfRevive = 0;
  private reviveInterruptT = 0;
  private sentSpectateId: string | null = null;

  private particles: Particle[] = [];
  private dmgNumbers: DmgNumber[] = [];  // floating damage popups (visual only)
  private worldLabels: WorldLabel[] = []; // floating text popups (visual only; e.g. drop names)
  private coinFlies: CoinFly[] = [];      // coins arcing into the top-left wallet (client juice)
  private coinFlySpawnTick = -1;          // coalesces a same-tick coin burst into one token
  // The local player's ult "legibility" layer (all client-side, off the already-authoritative
  // ultCharge — never the sim, never the wire). The tracker derives charge MOTES + the READY /
  // CAST cues; the motes arc into the bottom-left meter.
  private ultCue = new UltCueTracker();
  private ultMotes: UltMoteFly[] = [];
  // The best local combat origin captured while replaying THIS step's events (a kill/boss hit) —
  // the point the next mote flies FROM; null falls back to the player's own body (self-sourced
  // charge: the time-floor trickle, dash, heal, damage-taken).
  private ultMoteOrigin: { x: number; y: number; source: UltMoteSource } | null = null;
  // The authoritative ult charge last step + a throttle clock, so passive (self-sourced) charge —
  // which no longer flies a mote — still ticks the meter with a throttled pulse on each increase.
  private ultChargePulsePrev = 0;
  private ultChargePulseClock = 0;
  private isUltCasting = false;           // the local player's own ult resolved this step
  private hasShownUltReadyNudge = false;  // the one-time "[F] <ULT> READY" world nudge, per run
  private ultReadyNudge: { verb: string; t: number } | null = null; // world-anchored, over the player
  // The world-anchored interact nudge, recomputed each tick (item 6): null when no interact
  // is available/in-range. Rendered as a floating [E] chip over the target of the verb.
  private interactPrompt: { x: number; y: number; verb: string; progress: number | null } | null = null;
  private corpses: Corpse[] = [];
  // Per-handleSimEvents-call FX burst state (reset each call): coalesces the explosion/kill
  // spawn burst and the once-per-frame hitstop/shake so a many-detonation frame stays cheap.
  private fxBurstCount = 0;
  private burstFreeze = 0;
  private burstTrauma = 0;
  private burstKick = 0;
  private burstKickDir = 0;
  private arenaBurstFreeze = 0;
  private arenaBurstTrauma = 0;
  private arenaBurstKickX = 0;
  private arenaBurstKickY = 0;
  private isHaloActiveForBurst = false;
  private isHaloFlaredForBurst = false;
  private haloBurstAngle = 0;
  private haloBurstRing = 0;
  private haloBurstBlades = 0;
  private haloBurstX = 0;
  private haloBurstY = 0;
  private haloImpactCount = 0;
  private haloImpactSampleCount = 0;
  private haloImpactTrauma = 0;
  private readonly haloImpactPuffX = new Float64Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactPuffY = new Float64Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactDmgX = new Float64Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactDmgY = new Float64Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactDmg = new Float64Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactCrit = new Uint8Array(HALO_IMPACT_SAMPLES);
  private readonly haloImpactColor = Array<string>(HALO_IMPACT_SAMPLES).fill("#ffffff");
  private meleeShockwaveX = 0;
  private meleeShockwaveY = 0;
  private meleeShockwaveCount = 0;
  private meleeShockwaveScale = 1;
  private meleeShockwaveColor = "#ffffff";
  private decals: Decal[] = [];
  private afterimages: Afterimage[] = [];
  private dashImgCd = 0; // spacing timer for dropping dash afterimages
  private remoteTracers: RemoteTracer[] = [];
  private remoteShotSeen = new Map<string, number>();
  private remoteDownSeen = new Map<string, boolean>();
  private remoteAnims = new Map<string, RemoteAnimEntry>();
  private reviveHold = new Map<string, number>();

  private playerAnim = createAnim();
  private isPlayerMoving = false;
  private playerLean = 0;
  private muzzle = { t: 0, x: 0, y: 0, angle: 0, size: 2, color: "#ffe6a0" };
  // Client-only VFX subsystems (see vfx.ts) — pure cosmetics over the sim's event stream.
  private shockwaves = new ShockwaveField();
  private arenaUltVfx = new ArenaUltVfx();
  private screenFlash = new ScreenFlash();
  private motes = new AmbienceField();
  // Ambient occlusion + authored local lighting (see lighting.ts) — cached per floor,
  // rendered under entities so the mood never taxes combat readability.
  private lighting = new LightingRenderer();
  // Smoothed local mirror of the sim's hazardClock: advances every render frame and eases
  // onto the authoritative clock, so 20Hz online snapshots (or a hit-stop) never make a
  // telegraph animation stutter. Purely visual — damage reads the SIM clock.
  private hazardVisClock = 0;
  // Last seen cycle phase per hazard id — fires the client-side eruption cues (sound +
  // burst particles) exactly on the idle->telegraph->active edges.
  private hazardPhases = new Map<number, FloorHazardPhase>();
  // Tile indices holding toxic pools this floor, so adjacent pool tiles render merged
  // into one liquid body. Rebuilt per floor load.
  private poolTiles = new Set<number>();
  private meleeFlipDir = 1;      // alternates the visual sweep direction per swing (hitbox is symmetric)
  private meleeTrailLength = 1;
  private meleeTrailWidth = 1;
  private meleeTrailIntensity = 1;
  private meleeImpactWeapon: WeaponId | null = null;
  private meleeImpactUntil = 0;
  private meleeImpactAim = 0;
  private meleeImpactPuffDist = 0;
  private footstepCd = 0;        // spacing timer for run-dust kicks
  private hurtDir: number | null = null; // world angle toward the last damage source (screen-edge hint)
  // Previous-frame player position -> velocity for the reactive ambience layer.
  private lastPx = 0;
  private lastPy = 0;
  private isClearCelebrated = false; // edge detector for the floor-clear flourish
  // Client-side cosmetic anim, split out of the now-pure sim structs. Enemies/props key by
  // their stable sim id; pickups/chests key by object identity (LocalTransport shares the
  // live objects and no anim event ever targets them). Enemy/prop entries are pruned when
  // the entity is removed; loadFloor clears them wholesale.
  private enemyAnims = new Map<number, Anim>();
  private enemyAnimPos = new Map<number, { x: number; y: number }>();
  // The render-contract facing state (persistent 4-way + L/R memory, velocity-driven with
  // a deadzone so facing never jitters) and the per-frame pose handed to the draw pass.
  private enemyFacing = new Map<number, FacingState>();
  private enemyPoses = new Map<number, EnemyPose>();
  private propAnims = new Map<number, Anim>();
  // Keyed by the sim's stable per-floor id (like enemies/props): online rebuilds pickup/chest
  // objects from each snapshot, so object-identity keying would reset the idle anim 20x/s.
  private pickupAnims = new Map<number, Anim>();
  private chestAnims = new Map<number, Anim>();

  // All raw input funnels through the context-gated controller (src/game/input.ts): it
  // owns key/mouse/autofire state and only lets actions/samples through in the contexts
  // where they're legal, so overlays/pause/reconnect can never leak gameplay input.
  private input = new InputController((a) => this.onInputAction(a));
  // Sim-rate camera: eased toward the focus once per fixed sim step (tickCosmetics). The
  // renderer never subtracts this directly — draws use renderCam, this camera resampled on
  // the render clock (see render()). Input/audio/sim-side gating keeps reading this one.
  private cam = { x: 0, y: 0 };

  // Read-only bridge to the local player + world so the render code reads state exactly as
  // before (this.px / this.enemies / ...). The sim owns the truth; the client only reads.
  private get p(): PlayerSim { return this.world.players.get(LOCAL_ID)!; }
  private get px(): number { return this.p.x; }
  private get py(): number { return this.p.y; }
  private get pr(): number { return this.p.pr; }
  private get hp(): number { return this.p.hp; }
  private get maxHp(): number { return this.p.maxHp; }
  private get mods(): PlayerMods { return this.p.mods; }
  private get invuln(): number { return this.p.invuln; }
  private get dashCd(): number { return this.p.dashCd; }
  private get facing(): number { return this.p.facing; }
  private get weapon(): WeaponId { return this.p.weapon; }
  private get aimAngle(): number { return this.p.aimAngle; }
  private get shotSeq(): number { return this.p.shotSeq; }
  private get isDown(): boolean { return this.p.isDown; }
  private get isArena(): boolean { return isPvp(this.world); }
  private get kills(): number { return this.p.kills; }
  private get coins(): number { return this.p.coins; }
  private get combo(): number { return this.p.combo; }
  private get comboTimer(): number { return this.p.comboTimer; }
  private get meleeSwing(): MeleeSwing | null { return this.p.meleeSwing; }
  private get dungeon(): Dungeon { return this.world.dungeon; }
  private get floor(): number { return this.world.floor; }
  private get enemies(): Enemy[] { return this.world.enemies; }
  private get bullets(): Bullet[] { return this.world.bullets; }
  private get pickups(): Pickup[] { return this.world.pickups; }
  private get props(): Prop[] { return this.world.props; }
  private get hazards(): Hazard[] { return this.world.hazards; }
  private get effects(): Effect[] { return this.world.effects; }
  private get chests(): Chest[] { return this.world.chests; }

  private isRunning = false;
  private last = 0;
  private simAccum = 0; // fixed-timestep accumulator (seconds) for smooth framerate-independent sim
  private renderPrevX = 0; private renderPrevY = 0; // player pos before the last sim step (render interpolation)
  private hasRenderPrev = false;
  private renderAlpha = 0; // 0..1 interpolation factor within the current sim step (set each frame)
  private camPrevX = 0; private camPrevY = 0; // camera before the last sim step (render interpolation)
  // The one camera every world-space draw subtracts this frame: `cam` sampled on the render
  // clock (interpolated between its last two sim steps by renderAlpha — the SAME time base the
  // player body is drawn on). The sim-rate `cam` advances only inside fixed sim steps, so
  // subtracting it directly makes the world hold-then-jump while the interpolated player
  // glides (Ian's "props jitter against the player" playtest bug). Rounding policy: fractional
  // everywhere, matching the player draw — no layer may re-snap its own coordinates.
  private renderCam = { x: 0, y: 0 };
  private raf = 0;
  private runStart = 0;
  private animClock = 0; // wall-clock seconds for prop/ambient animation (torch, portal)
  // Boss telegraph aim-lock flash tracker, keyed by enemy id: the DYNAMIC soft->crisp SNAP
  // fires on the rising edge of the AUTHORITATIVE isAimLocked commit (never an art timer), so
  // players learn the real juke window. flashUntil is a short wall-clock deadline for the one
  // bright edge-pop the frame it locks.
  private tgLock = new Map<number, { locked: boolean; flashUntil: number }>();
  // QUORUM P1 tether-REKNIT animation per core id: on each trio RE-FORM the severed body pulls
  // itself back together — beads sweep INWARD (husk -> core), dim bone-cyan, a light beat that
  // reads "relentless" not "reset" (the persistent low HP bar is the honest progress cue, so
  // this stays subordinate to it). `anim` decays 1->0; its speed tightens as the pool nears merge.
  private quorumReform = new Map<number, { anim: number; lastCount: number; lastClock: number }>();
  // Prism Sentry render state, keyed by the (stable) server effect id. The wire carries no
  // aim/fireCd for a sentry, so the turret's barrel tracks the last-fired direction and the
  // recoil kick is driven off the sentryShot event's timestamp (animClock at fire) — a live,
  // aiming, firing turret without any sim/golden change. Pruned to live sentries each render.
  private sentryFx = new Map<number, { aim: number; firedAt: number }>();
  // Per-biome side-face gradients for the extruded wall look (built once). Indexed by biome.
  private wallSideGrads: [TileRenderGradient, TileRenderGradient][] = [];
  private currentBiome: Biome = biomeForFloor(1);
  private biomeIdx = 0;
  private presentedFloor: number | null = null;
  // Cached screen-space vignette (rebuilt on resize / biome change): the depth mood that
  // closes in band over band. One cached gradient fill per frame — flat cost.
  private vignetteCache: { canvas: HTMLCanvasElement; w: number; h: number } | null = null;
  private torches: { tx: number; ty: number }[] = []; // wall-mounted torch cells, per floor
  private freeze = 0; // hit-stop timer (seconds); while > 0 gameplay updates pause
  private trauma = 0; // screen-shake trauma, 0..1
  private kickX = 0; private kickY = 0; // directional camera kick (recoil), render-only
  private hurtFlash = 0; // red hurt-vignette intensity, 0..1
  private coop: CoopBridge | null = null;
  private profile: ProfileStats | null = null;
  private isStatsHeld = false;
  private pendingDescend = 0;

  // The full-hotbar swap prompt's target: the blocked weapon pickup underfoot (the sim
  // refused to auto-collect it — see updatePickups). Client affordance only; the swap
  // command re-validates everything authoritatively. `swapDismissedId` suppresses the
  // prompt for a declined pickup until the player walks off it.
  private swapTarget: { pickupId: number; weapon: WeaponId } | null = null;
  private swapDismissedId: number | null = null;

  // ---- dev sandbox state (all false/0 in normal play; see the dev hooks at the end) ----
  // Every flag below is inert unless the ?dev sandbox flips it, so the whole feature is a
  // handful of cheap, harmless branches on the hot paths and tree-shakes out of a run.
  private isSandbox = false;   // arena floor + no auto-population (dev spawns by hand)
  private isGodMode = false;   // damagePlayer no-ops while true
  private isFlowDebug = false; // draw the pathfinding flow-field arrows over the floor
  private isDevBossNameHidden = false;
  private isDevHitRadiusVisible = false;
  private isDevPaleCapture = false;
  private devArenaUltEventsSeen = 0;
  private fps = 0;             // smoothed frames/sec, surfaced via devSnapshot()
  private frameMsEma = FRAME_MS_EMA_SEED;
  private fxQuality = FX_QUALITY_MAX;
  private fxQualityDwell = createFxQualityDwell();
  private isFxAdaptationSuspended = false;

  constructor(
    canvas: HTMLCanvasElement,
    minimapCanvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    onGameOver: (result: RunResult) => void,
    onExit: (reason?: ExitReason, detail?: string) => void,
    onFloorReached: (floor: number) => void = () => {},
    onArenaRequeue: () => void = () => {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.minimap = new Minimap(minimapCanvas);
    this.hud = new Hud(hudRoot);
    // Hotbar UI injects into the SAME context-gated InputController the keyboard uses —
    // one action gate for every input surface. Context is re-synced first because these
    // callbacks fire between ticks (right after a drag tears down or a drawer closes).
    this.hud.setHotbarActions({
      onSlotActivate: (index) => { this.syncInputContext(); this.input.dispatch({ kind: "activateSlot", index }); },
      onSlotReorder: (from, to) => { this.syncInputContext(); this.input.dispatch({ kind: "reorderSlots", from, to }); },
      onSlotInspect: (index) => { this.syncInputContext(); this.input.dispatch({ kind: "inspectSlot", index }); },
      onSlotSwap: (index) => { this.syncInputContext(); this.input.dispatch({ kind: "swapSlot", index }); },
      onSlotDrop: (index) => { this.syncInputContext(); this.input.dispatch({ kind: "dropWeaponAt", index }); },
      onSwapDismiss: () => this.dismissSwapPrompt(),
    });
    this.onGameOver = onGameOver;
    this.onExit = onExit;
    this.onFloorReached = onFloorReached;
    this.onArenaRequeue = onArenaRequeue;
    this.hud.setArenaRematchAction(() => this.requeueArena());
    this.pause = new PauseOverlay(() => this.setPaused(false), () => this.quitToMenu());
    this.blessing = new BlessingOverlay();
    this.shopPanel = new ShopPanel();
    this.buildWallGradients();
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  // Precompute per-biome side-face gradients once (no per-frame allocation).
  private buildWallGradients() {
    this.wallSideGrads = BIOMES.map((biome) => buildWallSideGradients(this.ctx, biome));
  }

  private resize() {
    // Fill the whole viewport (camera-follow world, so more screen = more visible area).
    // Cap at a sane max so a huge monitor doesn't blow out fill-rate, but no letterbox.
    this.canvas.width = Math.min(window.innerWidth, 2560);
    this.canvas.height = Math.min(window.innerHeight, 1440);
    // Nearest-neighbour sampling for the whole world raster: the tile pass draws scaled
    // pixel-art sprites off a deliberately fractional camera, and bilinear smoothing on
    // those samples the semi-transparent tile edges into 1px seams between floors/walls.
    // Every scaled draw on this ctx is either pixel art (wants nearest) or a low-frequency
    // gradient blitted 1:1 (unaffected); the lighting grade already forces this off for its
    // own upscales. Re-asserted here because assigning width/height resets ctx state.
    this.ctx.imageSmoothingEnabled = false;
  }

  // Thin DOM binding: every listener just forwards plain data into the InputController,
  // which owns all gating (see src/game/input.ts). Blur / tab-hidden drop everything held
  // (keyup/mouseup are lost while unfocused, so a key or autofire could otherwise stick).
  private bindInput() {
    window.addEventListener("keydown", (e) => {
      // Refresh the context first: a drawer/drag can open and a key can land within the
      // same tick, and the gate must see the CURRENT surface, never last tick's.
      this.syncInputContext();
      if (this.input.keyDown(e.key, e.repeat)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.input.keyUp(e.key));
    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.input.mouseMove(e.clientX - r.left, e.clientY - r.top);
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.syncInputContext();
      this.input.wheel(e.deltaY); // cycle weapons — or, while down, the spectated teammate
    }, { passive: false });
    this.canvas.addEventListener("mousedown", (e) => { this.syncInputContext(); this.input.mouseDown(e.button); });
    window.addEventListener("mouseup", (e) => this.input.mouseUp(e.button));
    // Right-click is not a gameplay input; only suppress the browser menu over the
    // canvas while actually playing, never on overlays or the menu.
    this.canvas.addEventListener("contextmenu", (e) => {
      if (this.input.context === "gameplay" || this.input.context === "spectate") e.preventDefault();
    });
    window.addEventListener("blur", () => this.input.releaseAll());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.input.releaseAll();
        this.suspendFrameTiming();
      } else if (this.isRunning && !this.isPaused && !this.isChoosing) {
        this.resetFrameTiming(performance.now());
      }
    });
  }

  // Gameplay actions arrive already context-filtered by the InputController.
  private onInputAction(a: GameAction) {
    switch (a.kind) {
      case "togglePause":
        // Under the hud context Escape means "abort the HUD gesture": cancel a live hotbar
        // drag first, then dismiss an open drawer; under the shop context it means "close
        // the panel"; pause is next.
        if (this.hud.cancelActiveDrag()) break;
        if (this.hud.isDrawerOpen()) { this.hud.closeDrawer(); break; }
        if (this.shopPanel.isOpen) { this.shopPanel.close(); break; }
        // A visible swap prompt owns Escape next: LEAVE IT (the pickup stays on the
        // floor) — never a pause menu over an unanswered trade.
        if (this.input.context === "gameplay" && this.dismissSwapPrompt()) break;
        // On the connecting/readiness veil or mid-outage, Escape is CANCEL: give up on this
        // connection attempt and return to the lobby — never a pause menu over a dead world.
        if (this.mode === "online" && this.wsTransport && (this.isAwaitingOnlineWorld() || this.isOnlineOutage())) {
          this.quitToMenu("quit");
          break;
        }
        this.togglePause();
        break;
      case "interact":
        if (this.isRunning) this.handleInteractPress();
        break;
      case "selectWeapon":
        // PVP WAVE 3: during the pre-live arena freeze the 1-4 keys CLAIM the arena ult kit (an ult
        // skin only). The weapon hotbar is inert off-live (the sim freezes it), so the keys are free.
        if (this.claimArenaUltKit(a.index)) break;
        if (this.isRunning) this.equipSlot(a.index);
        break;
      case "cycleWeapon":
        if (this.isRunning) this.cycleWeapon(a.dir);
        break;
      case "dropWeapon":
        if (this.isRunning) this.dropEquippedWeapon();
        break;
      case "dropWeaponAt":
        if (this.isRunning) this.dropWeaponAt(a.index);
        break;
      case "activateSlot":
        if (this.isRunning) this.activateSlot(a.index);
        break;
      case "inspectSlot":
        if (this.isRunning) this.inspectSlot(a.index);
        break;
      case "reorderSlots":
        if (this.isRunning) this.reorderSlots(a.from, a.to);
        break;
      case "swapSlot":
        if (this.isRunning) this.swapSlot(a.index);
        break;
      case "cycleSpectate":
        if (this.isRunning) this.cycleSpectate(a.dir);
        break;
      case "spectateFollow":
        if (this.isRunning) this.toggleSpectateFollow();
        break;
      case "stats":
        this.isStatsHeld = a.isHeld;
        if (a.isHeld) this.openStats();
        else this.hud.hideStats();
        break;
    }
  }

  // Derive the current input context from run state. Called at every transition point and
  // once per tick; the controller clears its edge/latch state whenever it changes.
  private syncInputContext() {
    const prev = this.input.context;
    this.input.setContext(this.currentInputContext());
    // Leaving gameplay mid-charge (drawer, pause, overlay): the release that follows must
    // CANCEL, not fire a shell into wherever the cursor happened to sit.
    if (prev === "gameplay" && this.input.context !== "gameplay" && this.isRunning && this.p.chargeT > 0) {
      this.isChargeCancelPending = true;
    }
  }

  private currentInputContext(): InputContext {
    if (!this.isRunning) return "menu";
    if (this.isChoosing) return "blessing";
    if (this.isPaused) return "pause";
    // Both no-world-yet (connecting/readiness veil) AND a mid-run outage are the reconnect
    // context: gameplay actions and fire samples are blocked at the controller, so a dead
    // connection can never accumulate inputs or keep an autofire latch alive.
    if (this.isAwaitingOnlineWorld() || this.isOnlineOutage()) return "reconnect";
    if (this.isDown) return "spectate";
    // Browsing a shop station: the panel owns Enter/Esc/E; gameplay samples idle so the
    // buy flow can never fire a shot or walk the buyer off the pedestal.
    if (this.shopPanel.isOpen) return "shop";
    // A live hotbar drag or an open drawer: the HUD owns input, gameplay samples idle.
    if (this.hud.isInteractionActive()) return "hud";
    return "gameplay";
  }

  // Mid-run connection outage: the transport is auto-resuming with its seat token.
  private isOnlineOutage(): boolean {
    return this.mode === "online" && this.wsTransport !== null && this.wsTransport.getReconnectInfo().isReconnecting;
  }

  start(opts: StartOptions) {
    this.mode = opts.mode;
    this.coop = opts.coop ?? null;
    this.profile = opts.profile ?? null;
    // The chosen blob tint applies to solo + online (classic co-op keeps assigned colors).
    this.selfColorIndex = this.mode === "coop" ? null : opts.selfColorIndex ?? null;
    this.selfCosmetics = this.mode === "coop" ? null : opts.selfCosmetics ?? null;
    this.selfPet = this.mode === "coop" ? null : opts.selfPet ?? null;
    this.runFloorsCleared = 0;
    this.runBossKills.clear();
    this.devArenaUltEventsSeen = 0;
    this.hasShownUltReadyNudge = false; // the "[F] <ULT> READY" world nudge shows once per RUN
    this.petRenders.clear();
    this.online = this.mode === "online" ? opts.online ?? null : null;
    this.spectateId = null;
    this.sentSpectateId = null;
    this.isSpectatingBody = false;
    let floor: number;
    if (this.mode === "online" && opts.online) {
      // Online: the SERVER owns the world (seed/floor/dungeon). WSTransport boots a placeholder
      // world for pre-join prediction; the first snapshot's authoritative seed/floor/rev rebuilds
      // it (the readiness veil applies it at reveal). Every snapshot's world id is asserted
      // against the room's expected world — a mismatch is terminal, never played through. A
      // transport terminal state (closed/error) while running ends the run — never a stranded
      // session.
      this.wsTransport = new WSTransport({
        url: opts.online.url,
        getTicket: opts.online.getTicket,
        expectedWorldId: opts.online.expectedWorldId,
        onStatus: (s) => this.onOnlineStatus(s),
      });
      this.partyGate = opts.online.party && opts.online.selfPlayerId
        ? new PartyGate(opts.online.selfPlayerId)
        : null;
      this.seed = STAGE_B_SEED;
      floor = STAGE_B_FLOOR;
      this.transport.start(this.seed, floor, { isSandbox: true, isCoop: false });
    } else {
      this.wsTransport = null;
      this.partyGate = null;
      floor = this.coop ? this.coop.getFloor() : 1;
      this.seed = this.coop ? this.coop.getSeed() : randomSeed();
      this.transport.start(this.seed, floor, { isSandbox: this.isSandbox, isCoop: this.coop !== null });
    }
    this.world = this.transport.poll().state;
    // Solo / classic co-op: assign the chosen kit to the local player NOW, through the same
    // authoritative sim mutator the server runs on join — otherwise the player spawns on the
    // neutral baseline (no stat lean, no starting weapon, no ult meter / signature / kit chrome).
    // The kit rides the persistent LOCAL_ID player, so it survives floor descents and run resets
    // (a fresh run re-enters start() and re-applies). Online is untouched: the server owns kit
    // assignment via the verified ticket, and the local pre-join world is a throwaway placeholder.
    if (this.mode !== "online" && opts.kit) setPlayerKit(this.world, LOCAL_ID, opts.kit);
    this.inputSeq = 0;
    this.ownedItemDefs = [];
    this.remoteShotSeen.clear();
    this.remoteDownSeen.clear();
    this.remoteAnims.clear();
    this.petRenders.clear();
    this.reviveHold.clear();
    this.freeze = 0;
    this.trauma = 0;
    this.kickX = 0; this.kickY = 0;
    this.arenaBurstFreeze = 0;
    this.arenaBurstTrauma = 0;
    this.arenaBurstKickX = 0;
    this.arenaBurstKickY = 0;
    this.arenaUltVfx.clear();
    this.meleeImpactWeapon = null;
    this.meleeImpactUntil = 0;
    this.meleeImpactAim = 0;
    this.meleeImpactPuffDist = 0;
    this.hurtFlash = 0;
    this.isPaused = false;
    this.isChoosing = false;
    this.isArenaRequeuePending = false;
    this.isWorldRevealed = this.mode !== "online";
    this.partyView = null;
    this.pendingWorld = null;
    this.isWorldReported = false;
    this.connectDeadline = performance.now() + CONNECT_HANDSHAKE_TIMEOUT_MS;
    this.isOutageSeen = false;
    this.pendingDescend = 0;
    this.presentedFloor = null;
    this.pause.hide();
    this.blessing.hide();
    this.shopPanel.close();
    audio.unlock();
    waveAudio.reset();
    resetAnim(this.playerAnim);
    this.isPlayerMoving = false;
    this.playerLean = 0;
    this.runStart = performance.now();
    if (this.mode === "online") {
      // The server owns the world; the local one is a pre-join prediction placeholder with
      // the WRONG dungeon and spawn. Show nothing of it: the run boots behind a connecting
      // veil (see tick/render) and the floor load + camera + banner happen when the first
      // authoritative snapshot rebuilds the world — so the first visible frame already has
      // the player at the true spawn instead of teleporting there a beat later.
      this.minimap.clear();
    } else {
      this.loadFloorClient();
      this.snapCameraTo(this.px - this.canvas.width / 2, this.py - this.canvas.height / 2);
      this.showFloorEntryBanner(this.floor, { isBoss: isBossFloor(this.floor), isGauntlet: isGauntletFloor(this.floor) });
    }
    if (this.isArena) this.updateHud();
    this.hud.setVisible(true);
    // First run ever: briefly surface the core controls, then never nag again.
    if (!settings.isControlsHintSeen) {
      this.hud.showControlsHint();
      settings.markControlsHintSeen();
    }
    this.isRunning = true;
    this.syncInputContext(); // entering the run drops any latched menu-era input
    this.fxQuality = FX_QUALITY_MAX;
    this.resetFrameTiming(performance.now());
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.isRunning = false;
    this.transport.stop();
    this.shopPanel.close();
    cancelAnimationFrame(this.raf);
    // Leaving the world (quit, wipe, or a dead socket): clear the lobby's readiness mirror
    // so the roster shows this member back at LOBBY instead of a phantom CONNECTED.
    if (this.isWorldReported) {
      this.isWorldReported = false;
      this.online?.onWorldPresence?.(null);
    }
  }

  // Cosmetic floor-load: biome + torches + music + the boss-floor entry cue, plus a reset
  // of the client-only transient FX. The sim's world content (dungeon/enemies/pickups/
  // props/chests) is built by the sim (createWorld / descend); this only mirrors the
  // presentation side.
  private loadFloorClient() {
    const prevBiomeIdx = this.biomeIdx;
    const isNewFloor = this.presentedFloor !== this.floor;
    this.presentedFloor = this.floor;
    this.biomeIdx = biomeIndexForFloor(this.floor);
    this.currentBiome = biomeForFloor(this.floor);
    const expeditionEntry = isNewFloor ? expeditionRegionEntryForFloor(this.floor) : null;
    const isBandReveal = isNewFloor && this.floor > 1
      && (this.biomeIdx !== prevBiomeIdx || expeditionEntry !== null);
    this.vignetteCache = null;
    this.hazardPhases.clear();
    this.hazardVisClock = this.world.floorHazardClock;
    this.poolTiles.clear();
    for (const h of this.world.floorHazards) {
      if (h.kind === "toxic_pool") this.poolTiles.add(h.ty * this.dungeon.w + h.tx);
    }
    this.lastPx = this.px;
    this.lastPy = this.py;
    this.shopPanel.close();
    this.isShopWelcomed = false;
    this.patchSellT = 0;
    this.shopBoughtT = 0;
    this.torches = this.placeTorches(this.dungeon);
    this.rebakeLighting();
    this.particles = [];
    this.dmgNumbers = [];
    this.worldLabels = [];
    // The ult legibility layer: drop in-flight motes and re-prime the tracker at the live charge
    // so a floor load / world rebuild is never read as a burst of combat charge.
    this.ultMotes = [];
    this.ultMoteOrigin = null;
    this.ultReadyNudge = null;
    this.ultCue.reset(this.p.ultCharge);
    this.ultChargePulsePrev = this.p.ultCharge;
    this.ultChargePulseClock = 0;
    this.remoteTracers = [];
    this.corpses = [];
    this.decals = [];
    this.afterimages = [];
    this.muzzle.t = 0;
    this.sentryFx.clear();
    this.shockwaves.clear();
    this.arenaUltVfx.clear();
    this.screenFlash.clear();
    if (isBandReveal) {
      const glow = hexToRgb(this.currentBiome.glow);
      this.screenFlash.flash(glow[0], glow[1], glow[2], 0.16, 1.6);
    }
    this.motes.reseed(this.biomeIdx, this.px - this.canvas.width / 2, this.py - this.canvas.height / 2, this.canvas.width, this.canvas.height);
    this.hurtDir = null;
    this.footstepCd = 0;
    this.isClearCelebrated = this.isCurrentFloorCleared();
    this.enemyAnims.clear();
    this.enemyAnimPos.clear();
    this.enemyFacing.clear();
    this.propAnims.clear();
    this.pickupAnims.clear();
    this.chestAnims.clear();
    const isBoss = isBossFloor(this.floor);
    audio.setMusic(isBoss ? "boss" : "dungeon");
    // Wave layer: sweep entity-keyed loops/tells from the old floor, crossfade the biome's
    // ambient bed, and preload this floor's cue set (zone + hazards + the boss actually
    // here + every encounter kind on the floor — the contract's preload plan).
    waveAudio.onFloorLoad();
    // Deterministic biome-ambient RNG: the Deep's sparse pattern is a pure function of
    // (run seed, floor) — reproducible per floor, different across floors.
    waveAudio.setAmbientZone(this.biomeIdx, (this.seed ^ Math.imul(this.floor, 0x9E3779B9)) | 0);
    const bossUnit = this.world.enemies.find((e) => e.boss !== null && !e.dead);
    if (isBoss) {
      if (!waveAudio.bossEntrance(bossUnit?.kind ?? "boss", bossUnit?.x, bossUnit?.y)) sfx("bossSpawn");
      this.addTrauma(TRAUMA_BOSS_FLOOR);
    }
    // First-trigger contract: decode every cue this floor can reach — the boss actually
    // here plus every spawned archetype's tells — before any of them can fire.
    const floorKinds = new Set<string>();
    for (const e of this.world.enemies) floorKinds.add(e.kind);
    for (const e of this.world.pendingSpawns) floorKinds.add(e.kind);
    waveAudio.preloadForFloor(
      this.biomeIdx,
      bossUnit ? bossUnit.kind : null,
      floorKinds,
      expeditionEntry ? [EXPEDITION_BAND_ENTRY_EVENT] : undefined,
    );
    if (expeditionEntry) waveAudio.play(EXPEDITION_BAND_ENTRY_EVENT);
  }

  private showFloorEntryBanner(
    floor: number,
    opts?: { isBoss?: boolean; isGauntlet?: boolean; isDescend?: boolean },
  ): void {
    const expeditionEntry = expeditionRegionEntryForFloor(floor);
    if (expeditionEntry) {
      this.hud.showBanner(expeditionEntry.entryTitle, expeditionEntry.entryFlavor);
      return;
    }
    this.hud.showBanner(floorBannerText(floor, opts));
  }

  // Bake this floor's static light set: torches (emitting from the wall FACE into their
  // room, so the pool can never leak behind the mounting wall), standing braziers, the
  // ember-resting hazards, and Patch's stall (the waystation's warm hearth pool).
  // Deterministic from the same floor state on every client.
  private rebakeLighting() {
    const specs: StaticLightSpec[] = [];
    for (const t of this.torches) {
      specs.push({ x: (t.tx + 0.5) * TILE, y: (t.ty + 1) * TILE + 6, kind: "torch" });
    }
    for (const p of this.props) {
      if (p.kind === "brazier" && !p.dead) specs.push({ x: p.x, y: p.y, kind: "brazier" });
    }
    for (const h of this.world.floorHazards) {
      if (h.kind === "fire_vent") specs.push({ x: (h.tx + 0.5) * TILE, y: (h.ty + 0.5) * TILE, kind: "vent" });
      else if (h.kind === "void_rift") specs.push({ x: (h.tx + 0.5) * TILE, y: (h.ty + 0.5) * TILE, kind: "rift" });
    }
    const shop = this.world.shop;
    if (shop) specs.push({ x: shop.keeperX, y: shop.keeperY + 12, kind: "stall" });
    this.lighting.loadFloor(this.dungeon, this.biomeIdx, this.currentBiome, specs);
  }

  // Mount torches on the wall directly above each room (facing into it), at deterministic
  // columns. Deeper biomes hang MORE lights (biome.torchesPerRoom) — the darker the band,
  // the more its little fires matter. Same seeded stream shape as before; no per-frame cost.
  private placeTorches(d: Dungeon): { tx: number; ty: number }[] {
    const list: { tx: number; ty: number }[] = [];
    const rng = new Rng((this.seed ^ 0x7f4a7c15) + this.floor * 92821);
    const perRoom = this.currentBiome.torchesPerRoom;
    for (const room of d.rooms) {
      const ty = room.y - 1;
      if (ty < 0) continue;
      for (let i = 0; i < perRoom; i++) {
        const tx = room.x + 1 + rng.int(0, Math.max(0, room.w - 3));
        const isWall = d.tiles[ty * d.w + tx] === 1;
        const isFloorBelow = d.tiles[(ty + 1) * d.w + tx] === 0;
        if (isWall && isFloorBelow && !list.some((t) => t.tx === tx && t.ty === ty)) list.push({ tx, ty });
      }
    }
    return list;
  }

  private loop = (t: number) => {
    if (!this.isRunning) return;
    const raw = (t - this.last) / 1000;
    const dt = Math.min(raw, 0.05);
    this.last = t;
    if (raw > 0) this.fps += (1 / raw - this.fps) * 0.1; // dev readout only; harmless otherwise
    const isFrameTimingSuspended = this.isPaused || this.isChoosing || document.visibilityState === "hidden";
    if (isFrameTimingSuspended) {
      this.suspendFrameTiming();
    } else if (this.isFxAdaptationSuspended) {
      this.resetFrameTiming(t);
    } else if (this.freeze <= 0 && raw > 0) {
      this.frameMsEma = updateFrameMsEma(this.frameMsEma, raw * 1000);
      this.fxQuality = updateFxQualityTier(this.fxQuality, this.frameMsEma, this.fxQualityDwell);
    }
    this.animClock = t / 1000; // ambient props keep flickering even while paused/frozen
    // Paused (Esc) or picking a blessing: keep drawing the frozen frame under the
    // overlay, run no sim. Reuses the exact freeze path co-op already tolerates. An ONLINE
    // pick still pumps the authoritative stream: the server world keeps ticking under the
    // overlay, and the offer's TTL expiry must land NOW, not when the overlay closes.
    if (this.isPaused || this.isChoosing) {
      if (this.isChoosing) {
        this.pumpChoosingOnline();
        this.blessing.tickGamepad();
      }
      this.render();
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    // Hit-stop: hold the frame (and any peak screen-shake) for a beat, but keep
    // rendering so the pause reads as impact rather than a stutter.
    if (this.freeze > 0) {
      this.freeze = Math.max(0, this.freeze - dt);
    } else {
      // Fixed-timestep sim: step in constant FIXED_DT chunks so movement advances the same
      // amount every step regardless of frame rate — removes variable-dt micro-jitter. Leftover
      // time carries in the accumulator; cap the catch-up so a long stall can't spiral.
      const FIXED_DT = 1 / 60;
      this.simAccum = Math.min(this.simAccum + dt, FIXED_DT * 5);
      let steps = 0;
      while (this.simAccum >= FIXED_DT && steps < 5) {
        this.tick(FIXED_DT);
        this.simAccum -= FIXED_DT;
        steps++;
      }
      // Fraction into the next sim step — the renderer draws the player interpolated between
      // the last two sim positions by this alpha, so motion is smooth at any frame rate.
      this.renderAlpha = this.hasRenderPrev ? this.simAccum / FIXED_DT : 1;
    }
    this.render();
    this.hud.tick(dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  private suspendFrameTiming(): void {
    this.isFxAdaptationSuspended = true;
    resetFxQualityDwell(this.fxQualityDwell);
  }

  private resetFrameTiming(t: number): void {
    this.last = t;
    this.frameMsEma = FRAME_MS_EMA_SEED;
    resetFxQualityDwell(this.fxQualityDwell);
    this.isFxAdaptationSuspended = false;
  }

  private togglePause() {
    if (!this.isRunning || this.isChoosing) return; // a blessing pick owns the freeze
    this.setPaused(!this.isPaused);
  }

  private setPaused(paused: boolean) {
    this.isPaused = paused;
    // The context switch drops held fire + the autofire latch, so nothing resumes firing
    // without fresh input after the pause.
    this.syncInputContext();
    if (paused) {
      this.suspendFrameTiming();
      this.pause.show();
    } else {
      this.pause.hide();
      this.resetFrameTiming(performance.now()); // avoid a huge catch-up dt after the pause
    }
  }

  private quitToMenu(reason?: ExitReason, detail?: string) {
    this.setPaused(false);
    this.stop();
    this.syncInputContext();
    audio.setMusic(null);
    waveAudio.reset();
    this.hud.hideStats();
    this.hud.clear();
    this.onExit(reason, detail);
  }

  private requeueArena(): void {
    if (this.isArenaRequeuePending || !this.isArena || this.arenaMatchHud()?.phase !== "over") return;
    this.isArenaRequeuePending = true;
    this.stop();
    this.syncInputContext();
    audio.setMusic(null);
    waveAudio.reset();
    this.hud.clear();
    this.hud.setVisible(false);
    this.onArenaRequeue();
  }

  private addFreeze(seconds: number) {
    if (!settings.isHitstop) return; // accessibility: impact frames can be turned off
    this.freeze = Math.min(FREEZE_MAX, Math.max(this.freeze, seconds));
  }

  private addTrauma(amount: number) {
    const t = this.trauma + amount;
    this.trauma = t > 1 ? 1 : t;
  }

  // Every full-screen flash wash goes through here so the player's flash-level setting
  // (off / low / full) scales all of them in one place (photosensitivity control).
  private flashScreen(r: number, g: number, b: number, strength: number, decay = 3) {
    const f = settings.flashFactor;
    if (f <= 0) return;
    this.screenFlash.flash(r, g, b, strength * f, decay);
  }

  // Lazily create/fetch the client-side cosmetic anim for a sim entity. The sim no longer
  // carries anim; the client owns it, keyed by id (enemy/prop) or object (pickup/chest).
  private animForEnemy(e: Enemy): Anim {
    let a = this.enemyAnims.get(e.id);
    if (!a) { a = createAnim(); this.enemyAnims.set(e.id, a); }
    return a;
  }
  private animForProp(p: Prop): Anim {
    let a = this.propAnims.get(p.id);
    if (!a) { a = createAnim(); this.propAnims.set(p.id, a); }
    return a;
  }
  private animForPickup(p: Pickup): Anim {
    let a = this.pickupAnims.get(p.id);
    if (!a) { a = createAnim(); this.pickupAnims.set(p.id, a); }
    return a;
  }
  private animForChest(c: Chest): Anim {
    let a = this.chestAnims.get(c.id);
    if (!a) { a = createAnim(); this.chestAnims.set(c.id, a); }
    return a;
  }

  // Online, before gameplay is revealed: the local world is either the pre-join prediction
  // placeholder (wrong dungeon, wrong spawn) or the real world still gated on party
  // readiness. Nothing of it may run or render, or the player sees themselves spawn there
  // and teleport once truth arrives — or worse, start a run their party never joined.
  private isAwaitingOnlineWorld(): boolean {
    return this.mode === "online" && this.wsTransport !== null && !this.isWorldRevealed;
  }

  // The veil frame for an online run: keep the handshake/inputs alive, and reveal gameplay
  // only when the world AND (for a party-started run) the whole expected roster are in.
  private tickOnlineVeil(dt: number) {
    const t = this.wsTransport!;
    this.transport.advance(dt);
    if (!t.isReady()) {
      // No infinite entering veil: a handshake that produces no authoritative snapshot in
      // time is a failed connect — exit explicitly (the lobby shows the reason; ESC cancels
      // sooner). The transport keeps its own retries INSIDE this window.
      if (performance.now() > this.connectDeadline) {
        console.warn("[net] handshake timeout — no authoritative snapshot inside the window");
        this.quitToMenu("connect_failed");
        return;
      }
      this.updateHud();
      return;
    }
    // First authoritative contact: mirror the verified world join onto the lobby roster.
    if (!this.isWorldReported) {
      this.isWorldReported = true;
      this.online?.onWorldPresence?.(t.getWorldId());
    }
    // Latch the authoritative geometry; the reveal applies it. Events that arrive while
    // veiled are join-time bootstrap noise for a player who cannot see the world yet — poll
    // to keep the reliable-event acks advancing, discard the cosmetics.
    const rebuilt = t.consumeWorldRebuilt();
    if (rebuilt) this.pendingWorld = rebuilt;
    t.poll();

    if (this.partyGate && this.online?.party) {
      const roster = t.getWorldRoster();
      const connected = new Set(roster.filter((r) => r.st === "on").map((r) => r.aid));
      const away = new Set(roster.filter((r) => r.st === "away").map((r) => r.aid));
      const expected = this.online.party();
      const view = this.partyGate.evaluate(Date.now(), expected, connected, away);
      this.partyView = view;
      if (view.phase === "failed") {
        console.warn("[net] party never assembled — returning to the lobby", {
          worldId: t.getWorldId(), expected: expected.map((m) => m.playerId), connected: [...connected],
        });
        this.quitToMenu("party_incomplete", view.missingNames.join(", "));
        return;
      }
      // Safety valve: the world found us while we waited (spawn damage). An invisible fight
      // is worse than an early reveal — surface the game and let the veil's warning stand.
      const self = t.getLatestSnapshot()?.self;
      const isHurt = self != null && self.hp < self.mhp;
      if (view.phase === "waiting" && !isHurt) { this.updateHud(); return; }
      if (view.phase === "waiting" && isHurt) {
        console.warn("[net] revealing before the full party — took damage while waiting");
      }
    }
    this.revealOnlineWorld();
  }

  // While the blessing overlay is up in an ONLINE run the normal tick is frozen, but the
  // authoritative world is not: keep the countdown honest from the snapshot's wait state and
  // drain the event stream so the offer's expiry closes the overlay the moment it happens.
  // The pick window's cosmetic FX events are deliberately dropped (bounded to the overlay).
  private pumpChoosingOnline() {
    if (this.mode !== "online" || !this.wsTransport) return;
    const selfId = this.wsTransport.getSelfServerId();
    const mine = this.wsTransport.getPartyWait().find((w) => w.pid === selfId);
    this.blessing.setCountdown(mine ? mine.s : null);
    const { events } = this.transport.poll();
    for (const e of events) {
      if (e.t === "blessingExpired") this.onOfferExpired(e.pid);
    }
    // Watchdog for a LOST expiry event (e.g. it fell into a reconnect's skipped backlog):
    // the authoritative wait state is on every snapshot — once it no longer lists us (a few
    // ticks past the offer opening, so a fresh offer's first snapshot can't false-trigger),
    // the offer is dead server-side and the overlay must not outlive it.
    const snap = this.wsTransport.getLatestSnapshot();
    if (this.isChoosing && !mine && snap !== null && snap.tick > this.choosingSinceTick + 2 && selfId !== null) {
      this.onOfferExpired(selfId);
    }
  }

  // The offer's TTL ran out unanswered (pid-scoped: only the owner receives it). Close the
  // overlay if it is still up, drop any undelivered transport offer, and say so — the run
  // moved on, and a pick after this point is rejected server-side anyway.
  private onOfferExpired(pid: PlayerId) {
    if (this.mode !== "online" || !this.wsTransport || pid !== this.wsTransport.getSelfServerId()) return;
    this.wsTransport.consumePendingOffer();
    if (!this.isChoosing) return;
    this.blessing.hide();
    this.isChoosing = false;
    this.input.releaseAll();
    this.syncInputContext();
    this.hud.showBanner(OFFER_EXPIRED_TOAST);
  }

  // Apply the authoritative first world and lift the veil: cosmetic floor load, camera on
  // the true spawn, banner, and the run clock starting at the first playable frame.
  private revealOnlineWorld() {
    this.isWorldRevealed = true;
    this.partyView = null;
    const world = this.pendingWorld;
    this.pendingWorld = null;
    if (world) this.seed = world.seed;
    this.loadFloorClient();
    this.snapCameraTo(this.px - this.canvas.width / 2, this.py - this.canvas.height / 2);
    if (!this.isArena) this.showFloorEntryBanner(this.floor, { isBoss: isBossFloor(this.floor) });
    this.runStart = performance.now();
  }

  // One client frame: sample input -> drive the sim through the transport -> replay the
  // returned events into FX -> advance client-only cosmetics -> render (caller). Solo runs
  // stepWorld in-process (LocalTransport), so this IS the old update loop, just seam'd.
  private tick(dt: number) {
    // Keep the input context tracking run state (reconnect veil lifting, going down /
    // being revived) so samples/actions are always gated against the current surface.
    this.syncInputContext();
    // Snapshot player pos AND camera BEFORE this sim step so the renderer can interpolate
    // both between the last two sim states (smooth motion at any frame rate vs the fixed sim
    // rate). They must share one snapshot point: the camera is what every world-space draw
    // subtracts, so it has to ride the exact same render clock as the player body.
    this.renderPrevX = this.px; this.renderPrevY = this.py; this.hasRenderPrev = true;
    this.camPrevX = this.cam.x; this.camPrevY = this.cam.y;
    // Behind the readiness veil: no gameplay runs and nothing of the world shows.
    if (this.isAwaitingOnlineWorld()) {
      this.tickOnlineVeil(dt);
      return;
    }
    // Mid-run outage: the transport is resuming with its seat token and the server is holding
    // our body safe. Freeze gameplay on the last authoritative frame — no inputs, no local
    // prediction drift — and let the CONNECTION LOST overlay carry the state. Never a game
    // over; the terminal paths route through onOnlineStatus if the window runs out.
    if (this.isOnlineOutage()) {
      if (!this.isOutageSeen) {
        // Loss edge: same policy as window blur — drop everything held (keys, mouse, the
        // autofire latch, the stats hold) so nothing carries across the outage and resuming
        // always requires fresh input. The context flip to "reconnect" (above) blocks any
        // new gameplay action for the duration.
        this.input.releaseAll();
      }
      this.isOutageSeen = true;
      this.updateHud();
      return;
    }
    if (this.mode === "online" && this.wsTransport && this.isOutageSeen) {
      this.isOutageSeen = false;
      // The run may have FINISHED while we were away (the party wiped): an explicit RUN
      // ENDED WHILE AWAY exit — no recorded death, no YOU DIED — per the UI contract.
      if (this.wsTransport.getIsResumedIntoOver()) {
        this.quitToMenu("run_ended_away");
        return;
      }
      this.hud.showBanner(BACK_ONLINE_TOAST);
    }

    if (this.coop) this.syncCoop(dt);

    const cmd = this.buildInput();
    this.world.remoteTargets = this.coopTargets();
    this.transport.sendInput(cmd);
    this.transport.advance(dt);

    // Online: the authoritative world geometry changed (party descend) — refresh the
    // seed-keyed cosmetic floor state (biome/torches/music/banner) BEFORE replaying events.
    if (this.mode === "online" && this.wsTransport) {
      const rebuilt = this.wsTransport.consumeWorldRebuilt();
      if (rebuilt) {
        const isFirstReveal = !this.isWorldRevealed;
        this.isWorldRevealed = true;
        this.seed = rebuilt.seed;
        this.loadFloorClient();
        if (!this.isArena) {
          this.showFloorEntryBanner(rebuilt.floor, { isBoss: isBossFloor(rebuilt.floor), isGauntlet: isGauntletFloor(rebuilt.floor) });
        }
        // The run properly begins at the first reveal (the connect veil isn't run time).
        if (isFirstReveal) this.runStart = performance.now();
      }
    }

    const { events } = this.transport.poll();
    this.handleSimEvents(events);

    // Online: terminal run state is derivable from SNAPSHOT state too, so a backpressure-dropped
    // gameOver event (or its final snapshot) can never strand this client in a dead run.
    if (this.mode === "online" && this.wsTransport && this.wsTransport.isRunOver() && (this.isDown || this.hp <= 0)) {
      this.gameOver();
      return;
    }

    // Spectate: down with the party still fighting means the camera rides a living teammate
    // (game over only lands on a full wipe — the check above). Revive releases it.
    this.updateSpectate();

    // The revive-interrupt read (gate §6 hard reset): authoritative progress snapping back
    // to zero while still down = the channel broke — flash the interrupted copy briefly.
    if (this.isDown) {
      if (this.p.reviveProgress === 0 && this.lastSelfRevive > 0.15) this.reviveInterruptT = 1.6;
      if (this.reviveInterruptT > 0) this.reviveInterruptT = Math.max(0, this.reviveInterruptT - dt);
    } else {
      this.reviveInterruptT = 0;
    }
    this.lastSelfRevive = this.isDown ? this.p.reviveProgress : 0;

    // Online: surface any server-decided blessing offer (choice authority is server-side).
    if (this.mode === "online" && this.wsTransport && !this.isChoosing) {
      const offer = this.wsTransport.consumePendingOffer();
      if (offer) this.offerServerBlessing(offer);
    }

    // Dev combo-freeze holds the chain full so the HUD can be screenshotted at a tier.
    if (this.comboFreeze && this.combo > 0) this.p.comboTimer = COMBO_WINDOW;

    this.tickShop(dt);
    this.tickWeaponAudio(dt);
    this.tickPvpAudio();
    this.tickCosmetics(dt, cmd);
    this.tickUltCue(dt);

    if (this.coop) this.publishPresence();
    this.updateHud();
    if (this.isStatsHeld) this.openStats();
  }

  // Build this tick's InputCmd from the context-gated controller sample plus the
  // mouse->world aim; the sim only sees moveX/moveY/aim/firing/dash/interact. The "hud"
  // context (hotbar drag / open drawer) samples idle, so HUD interaction never leaks into
  // combat — and the "spectate" context (downed) samples idle too, so a spectator sends no
  // gameplay intents at the source (the authoritative sim ignores them anyway).
  // PVP WAVE 3: claim the arena ult kit from a 1-4 key during the pre-live arena freeze. Returns
  // whether the key was consumed as a claim (so it does not also fall through to weapon-equip).
  private claimArenaUltKit(index: number): boolean {
    if (this.mode !== "online" || !this.wsTransport) return false;
    const match = this.wsTransport.getLatestSnapshot()?.match ?? null;
    if (match === null || match.ph === "live" || match.ph === "over") return false;
    const order = ["gunner", "mender", "bulwark", "phantom"] as const;
    const kit = order[index];
    if (kit === undefined) return false;
    this.pendingArenaKit = kit;
    return true;
  }

  private buildInput(): InputCmd {
    const s = this.input.sample();
    const wx = this.input.mouseX + this.cam.x, wy = this.input.mouseY + this.cam.y;
    const aim = Math.atan2(wy - this.py, wx - this.px);
    // Dev sandbox: a one-frame ult request armed by the panel button (OR'd with the held key).
    const devUlt = this.devUltPulse; this.devUltPulse = false;
    // Stop resending the arena ult claim once the server reflects it, or once the match locks it.
    if (this.pendingArenaKit && this.wsTransport) {
      const snap = this.wsTransport.getLatestSnapshot();
      if (snap?.self?.auk === this.pendingArenaKit || snap?.match?.ph === "live") this.pendingArenaKit = "";
    }
    const arenaUltKit = this.pendingArenaKit;
    // Pending charge cancel: send the sim's explicit cancel intent (dash with zero
    // movement neither dashes nor fires — see updateChargeShooting) until the
    // authoritative charge reads empty. Movement is zeroed so a resume with a held
    // movement key can't turn the cancel frame into a real dash.
    if (this.isChargeCancelPending) {
      if (this.p.chargeT > 0) {
        return { seq: ++this.inputSeq, moveX: 0, moveY: 0, aim, firing: false, dash: true, interact: false, ult: false, pulse: false, petAbility: false, arenaUltKit };
      }
      this.isChargeCancelPending = false;
    }
    // Pets auto-cast (server-owned smart AI); there is no player bind, so the request bit is
    // always false on the wire (it survives only as a debug force-cast the sim can honor).
    return { seq: ++this.inputSeq, moveX: s.moveX, moveY: s.moveY, aim, firing: s.firing, dash: s.dash, interact: s.interact, ult: s.ult || devUlt, pulse: s.pulse, petAbility: false, arenaUltKit };
  }

  // Co-op teammate positions fed to the sim as extra enemy-aggro targets (Stage A keeps
  // co-op on the existing presence path; the sim only needs their positions).
  private coopTargets(): RemoteTarget[] {
    if (!this.coop) return [];
    return this.coop.remotePlayers().map((r) => ({ x: r.x, y: r.y, isDown: r.isDown }));
  }

  // Whether the local player sits in the spectator seat: down, with somebody left to watch.
  private isSpectating(): boolean {
    return this.isRunning && this.isDown && this.remotes().some((r) => !r.isDown);
  }

  // Keep the spectate target valid every tick: acquire one on going down, keep it while it
  // lives, hand off when it dies or leaves, and release on revive (the camera glides home).
  // The server learns the chosen target whenever it changes so it can center this client's
  // interest view (and positional events) on what the camera actually shows.
  private updateSpectate() {
    this.spectateId = this.isDown ? resolveSpectateTarget(this.spectateId, this.remotes()) : null;
    if (this.spectateId === null) {
      this.sentSpectateId = null;
      this.isSpectatingBody = false; // revive/hand-off releases the body toggle too
      return;
    }
    if (this.mode === "online" && this.wsTransport && this.spectateId !== this.sentSpectateId) {
      this.wsTransport.sendSpectate(this.spectateId);
      this.sentSpectateId = this.spectateId;
    }
  }

  // Every spectate input source lands here (Q/E, arrows, scroll — and a controller's bumpers
  // when pads arrive): step the watched teammate through the stable living ring. Cycling
  // also snaps out of body-follow — picking a teammate means you want to watch them.
  private cycleSpectate(dir: 1 | -1) {
    if (!this.isDown) return;
    this.spectateId = cycleSpectateTarget(this.spectateId, this.remotes(), dir);
    this.isSpectatingBody = false;
  }

  // F while down: flip the camera between the watched teammate and your own body (the
  // UI Director's FOLLOW control — see who's coming for the revive).
  private toggleSpectateFollow() {
    if (!this.isDown) return;
    this.isSpectatingBody = !this.isSpectatingBody;
  }

  // Where the camera looks: the local player, or the spectated teammate while down (unless
  // the body toggle holds the camera home).
  private cameraFocus(): { x: number; y: number } {
    if (this.spectateId !== null && !this.isSpectatingBody) {
      const target = this.remotes().find((r) => r.playerId === this.spectateId);
      if (target) return { x: target.x, y: target.y };
    }
    return { x: this.px, y: this.py };
  }

  // Hard camera cut (run start, floor load): clear the interpolation history too, so the
  // first rendered frame sits exactly on the new camera instead of sliding from the old one.
  private snapCameraTo(x: number, y: number) {
    this.cam.x = x; this.cam.y = y;
    this.camPrevX = x; this.camPrevY = y;
    this.renderCam.x = x; this.renderCam.y = y;
  }

  // Other players to render, from whichever remote source is active: co-op presence (Convex)
  // or the authoritative server (WSTransport). Solo returns none.
  private remotes(): RemotePlayer[] {
    if (this.mode === "coop" && this.coop) return this.coop.remotePlayers();
    if (this.mode === "online" && this.wsTransport) return this.wsTransport.remotePlayers();
    return [];
  }

  // Advance the client-only cosmetics the sim no longer owns: player anim, dash trail
  // afterimages, particle/decal/etc lifetimes, screen-shake/kick/hurt decay, camera.
  // Charge-tier and risk-payoff releases: DISTINCT STEMS by contract, never pitch tiers.
  // Returns true when the semantic layer owned the sound (legacy paths then stay quiet).
  private playSemanticFireAudio(e: Extract<SimEvent, { t: "shot" }>): boolean {
    const audio_ = WEAPON_AUDIO[e.weapon];
    if (!audio_) return false;
    if (e.weapon === "breach") {
      this.isBreachReleaseSeen = true;
      const release = e.chg >= 0.66 ? audio_.releaseAlt : audio_.release;
      if (release !== undefined) waveAudio.cueAt(release, e.x, e.y);
      if (audio_.travel !== undefined) waveAudio.cueAt(audio_.travel, e.x, e.y);
      return true;
    }
    if (e.weapon === "lastlight" && e.pid === this.p.id && audio_.payoff !== undefined) {
      // The risk payoff voice: the wielder's own empowered release once the band is open.
      const lowHp = this.p.maxHp > 0 ? 1 - this.p.hp / this.p.maxHp : 0;
      if (lowHp >= 0.5) { waveAudio.cueAt(audio_.payoff, e.x, e.y); return true; }
    }
    return false;
  }

  // The pvpKill role branch (THE #1 PvP audio rule). `isSelfPid` resolves the local player in
  // both online (server pid) and local worlds, so the same branch is correct everywhere.
  //  - by === self    -> FRAG CONFIRM: the money cue, non-spatial + full gain, with the rapid
  //                      streak pitch-step laddered up a safe-band semitone per frag.
  //  - victim === self -> YOU DIED: non-spatial, full gain.
  //  - neither        -> NEUTRAL KILL: a quiet SPATIAL distant thud at the kill point, hard
  //                      rate-limited by the cue's own 300ms cooldown so a full lobby never spams.
  private playPvpKillCue(e: Extract<SimEvent, { t: "pvpKill" | "pvpRingOut" }>): void {
    const cue = pvpKillCue(this.isSelfPid(e.by), this.isSelfPid(e.victim));
    if (cue.event === "pvp.frag") {
      waveAudio.play("pvp.frag");
    } else if (cue.isSpatial) {
      waveAudio.play(cue.event, { x: e.x, y: e.y });
    } else {
      waveAudio.play(cue.event);
    }
  }

  // The PvP match-flow observer (client-only). The authoritative match block only exists in an
  // online PvP snapshot; from its phase + countdown timer + the local respawn countdown it
  // fires the non-event beats: a rising countTick on each whole second of the countdown, the
  // GO stinger the instant the phase flips to "live", and the "weapons hot" blip the instant
  // the local rsp countdown reaches 0 and control returns. Win/lose ride the reliable
  // pvpMatchOver event (handleSimEvent), never re-fired here.
  private tickPvpAudio(): void {
    if (this.mode !== "online" || !this.wsTransport) { if (this.isPvpMatchSeen) this.resetPvpAudioState(); return; }
    const snap = this.wsTransport.getLatestSnapshot();
    const match = snap?.match ?? null;
    if (!snap || match === null) { if (this.isPvpMatchSeen) this.resetPvpAudioState(); return; }
    if (!this.isPvpMatchSeen) { this.isPvpMatchSeen = true; waveAudio.preloadPvp(); }

    const prevPhase = this.pvpPrevPhase;
    if (match.ph === "countdown") {
      if (prevPhase !== "countdown") this.pvpLastCountSecond = -1; // a fresh countdown
      const secondsLeft = Math.max(0, Math.ceil((match.end - snap.tick) * FIXED_DT));
      if (secondsLeft >= 1 && secondsLeft !== this.pvpLastCountSecond) {
        this.pvpLastCountSecond = secondsLeft;
        waveAudio.play("pvp.countTick", { rate: pvpCountTickRate(secondsLeft) });
      }
    }
    if (match.ph === "live" && prevPhase !== null && prevPhase !== "live") waveAudio.play("pvp.fight");
    this.pvpPrevPhase = match.ph;

    const rsp = snap.self?.rsp ?? null;
    if (rsp !== null) {
      if (this.pvpPrevRespawnT !== null
        && this.pvpPrevRespawnT > 0
        && rsp === 0
        && (snap.self?.hp ?? 0) > 0) {
        waveAudio.play("pvp.respawnIn");
      }
      this.pvpPrevRespawnT = rsp;
    }
  }

  private resetPvpAudioState(): void {
    this.isPvpMatchSeen = false;
    this.pvpPrevPhase = null;
    this.pvpLastCountSecond = -1;
    this.pvpPrevRespawnT = null;
  }

  private arenaMatchHud(): HudState["arenaMatch"] {
    if (!this.isArena || this.mode !== "online" || !this.wsTransport) return null;
    const snap = this.wsTransport.getLatestSnapshot();
    if (snap === null || snap.match === null) return null;
    return buildArenaMatchHud({
      match: snap.match,
      tick: snap.tick,
      selfId: snap.selfId,
      respawnTicks: snap.self?.rsp ?? 0,
      spawnProtectionStartedTick: snap.self?.spo ?? 0,
      spawnHardGraceEndsAtTick: snap.self?.sge ?? 0,
      spawnShieldEndsAtTick: snap.self?.sse ?? 0,
      hearthFavorTicks: snap.self?.hf ?? 0,
      hearthEmberTicks: snap.self?.he ?? 0,
      nameOf: (id, isSelf) => this.arenaNameOf(id, isSelf),
    });
  }

  private arenaNameOf(id: PlayerId, isSelf: boolean): string {
    if (isSelf) return "YOU";
    const seat = this.wsTransport?.getWorldRoster().find((entry) => entry.pid === id);
    if (seat?.nm) return seat.nm;
    return this.remotes().find((player) => player.playerId === id)?.name ?? id;
  }

  private isArenaRespawning(): boolean {
    if (!this.isArena || this.mode !== "online" || !this.wsTransport) return false;
    const self = this.wsTransport.getLatestSnapshot()?.self;
    return self !== null && self !== undefined && (self.hp <= 0 || self.rsp > 0);
  }

  // Per-tick semantic weapon audio: equip edges, the Breach charge lifecycle (prime /
  // ONE keyed hold loop / threshold / full lock / vent-on-cancel), the halo's single
  // owner loop + blade-pass ticks, the chain's pull loop, and the risk band open/close.
  // Every loop is level-held (holdLoop does the edge work) — never retriggered per tick.
  private tickWeaponAudio(dt: number) {
    for (let i = this.pendingCues.length - 1; i >= 0; i--) {
      const cue = this.pendingCues[i];
      cue.t -= dt;
      if (cue.t <= 0) {
        waveAudio.cueAt(cue.name, cue.x, cue.y);
        this.pendingCues.splice(i, 1);
      }
    }
    if (!this.isRunning) return;
    const wpn = this.weapon;
    const contract = WEAPON_AUDIO[wpn];
    if (this.audioPrevWeapon !== wpn) {
      if (this.audioPrevWeapon !== null && contract?.equip !== undefined) {
        waveAudio.cueAt(contract.equip, this.px, this.py);
      }
      this.audioPrevWeapon = wpn;
      this.audioPrevChargeT = 0;
      this.isChargeThresholdCued = false;
      this.isChargeLockCued = false;
      this.isRiskBandOpen = false;
      this.audioOrbitSector = -1;
    }

    // The Breach charge lifecycle off the authoritative (prediction-reconciled) chargeT.
    const chargeSpec = WEAPONS[wpn].charge;
    const chg = this.p.chargeT;
    waveAudio.holdLoop("breach.chargeLoop", "self", chargeSpec !== undefined && chg > 0);
    if (chargeSpec && contract) {
      if (chg > 0 && this.audioPrevChargeT === 0 && contract.prime !== undefined) {
        waveAudio.cueAt(contract.prime, this.px, this.py);
        this.isBreachReleaseSeen = false;
      }
      if (chg >= chargeSpec.time * 0.5 && !this.isChargeThresholdCued && contract.threshold !== undefined) {
        this.isChargeThresholdCued = true;
        waveAudio.cueAt(contract.threshold, this.px, this.py);
      }
      if (chg >= chargeSpec.time - 1e-9 && !this.isChargeLockCued && contract.ready !== undefined) {
        this.isChargeLockCued = true;
        waveAudio.cueAt(contract.ready, this.px, this.py);
      }
      if (chg === 0 && this.audioPrevChargeT > 0) {
        // The hold ended without a release event this tick: that was a CANCEL — vent it.
        if (!this.isBreachReleaseSeen && contract.vent !== undefined) waveAudio.cueAt(contract.vent, this.px, this.py);
        this.isChargeThresholdCued = false;
        this.isChargeLockCued = false;
        this.isBreachReleaseSeen = false;
      }
    }
    this.audioPrevChargeT = chargeSpec !== undefined ? chg : 0;

    // The halo: ONE mixed owner loop (never per blade) + the blade-pass tick each time
    // the ring completes a sector (the row's cooldown paces it).
    const orbit = this.effects.find((fx) => fx.kind === "orbit" && fx.owner === LOCAL_ID);
    waveAudio.holdLoop("halo.loop", "self", orbit !== undefined);
    if (orbit !== undefined && orbit.kind === "orbit" && orbit.blades > 0) {
      const sector = Math.floor(orbit.angle / ((Math.PI * 2) / orbit.blades));
      if (this.audioOrbitSector !== -1 && sector !== this.audioOrbitSector) {
        waveAudio.cueAt("halo.pass", this.px, this.py);
      }
      this.audioOrbitSector = sector;
    } else {
      this.audioOrbitSector = -1;
    }

    // The chain: the pull/hold loop lives exactly while the local tether does.
    const tether = this.effects.some((fx) => fx.kind === "tether" && fx.owner === LOCAL_ID);
    waveAudio.holdLoop("crook.pullLoop", "self", tether);

    // The risk band (Lastlight): danger on entry, recovery on exit — the band is the
    // same authoritative low-HP curve the damage rides.
    const risk = WEAPONS[wpn].lowHpBonus !== undefined
      && this.p.maxHp > 0 && (1 - this.p.hp / this.p.maxHp) >= 0.5 && !this.isDown;
    if (risk && !this.isRiskBandOpen && contract?.danger !== undefined) waveAudio.cueAt(contract.danger, this.px, this.py);
    if (!risk && this.isRiskBandOpen && contract?.recovery !== undefined) waveAudio.cueAt(contract.recovery, this.px, this.py);
    this.isRiskBandOpen = risk;
  }

  private tickCosmetics(dt: number, cmd: InputCmd) {
    if (!this.isDown && !this.isArenaRespawning()) {
      let ix = cmd.moveX, iy = cmd.moveY;
      const len = Math.hypot(ix, iy) || 1; ix /= len; iy /= len;
      this.isPlayerMoving = cmd.moveX !== 0 || cmd.moveY !== 0;
      this.playerLean = ix;
    } else {
      this.isPlayerMoving = false;
    }
    stepAnim(this.playerAnim, dt, this.isPlayerMoving, this.playerLean);

    // Sim entities no longer carry Anim after Stage A, so every client-owned cosmetic
    // map must advance here. Without this, hit flash stays at 1 forever (white mobs),
    // and pickup/chest/prop idle clocks freeze. Movement is derived from last snapshot.
    const liveEnemyIds = new Set<number>();
    for (const e of this.enemies) {
      liveEnemyIds.add(e.id);
      const anim = this.animForEnemy(e);
      const prev = this.enemyAnimPos.get(e.id);
      const dx = prev ? e.x - prev.x : 0, dy = prev ? e.y - prev.y : 0;
      const moving = dx * dx + dy * dy > 0.12;
      stepAnim(anim, dt, moving, dx < -0.05 ? -1 : dx > 0.05 ? 1 : 0);
      // The render-contract pose: persistent 4-way facing from observed velocity (deadzone
      // + axis hysteresis kill the old mirror-flicker), aim intent overriding while a
      // committed move telegraphs. A fresh body starts out looking at the player.
      let facing = this.enemyFacing.get(e.id);
      if (!facing) {
        facing = createFacing();
        facing.isMirrored = this.px < e.x;
        this.enemyFacing.set(e.id, facing);
      }
      const inv = dt > 0 ? 1 / dt : 0;
      // Phasing bodies drift THROUGH their target, so their observed velocity oscillates at
      // full speed while they overlap it — face off a smoothed velocity so that wobble can't
      // flip-flicker the sprite's L/R mirror (see FACING_DRIFT_SMOOTHING).
      const smoothFacing = ENEMY_ARCHETYPES[e.kind].isPhasing;
      this.enemyPoses.set(e.id, computeEnemyPose(e, facing, dx * inv, dy * inv, anim.move > 0.5, smoothFacing));
      this.enemyAnimPos.set(e.id, { x: e.x, y: e.y });
    }
    if (this.enemyAnims.size > liveEnemyIds.size) {
      for (const id of this.enemyAnims.keys()) {
        if (!liveEnemyIds.has(id)) {
          this.enemyAnims.delete(id); this.enemyAnimPos.delete(id);
          this.enemyFacing.delete(id); this.enemyPoses.delete(id);
        }
      }
    }
    const livePropIds = new Set<number>();
    for (const prop of this.props) { livePropIds.add(prop.id); stepAnim(this.animForProp(prop), dt, false, 0); }
    if (this.propAnims.size > livePropIds.size) for (const id of this.propAnims.keys()) if (!livePropIds.has(id)) this.propAnims.delete(id);
    const livePickupIds = new Set<number>();
    for (const pickup of this.pickups) { livePickupIds.add(pickup.id); stepAnim(this.animForPickup(pickup), dt, false, 0); }
    if (this.pickupAnims.size > livePickupIds.size) for (const id of this.pickupAnims.keys()) if (!livePickupIds.has(id)) this.pickupAnims.delete(id);
    const liveChestIds = new Set<number>();
    for (const chest of this.chests) { liveChestIds.add(chest.id); stepAnim(this.animForChest(chest), dt, false, 0); }
    if (this.chestAnims.size > liveChestIds.size) for (const id of this.chestAnims.keys()) if (!liveChestIds.has(id)) this.chestAnims.delete(id);

    // Dash afterimages (pure ghost trail): spaced by dashImgCd while the sim reports a dash.
    if (this.p.dashTime > 0) {
      this.dashImgCd -= dt;
      if (this.dashImgCd <= 0) { this.afterimages.push({ x: this.px, y: this.py, facing: this.facing, t: 0, color: null, base: heroBodySprite(this.selfCosmetics?.hat ?? null) }); this.dashImgCd = 0.04; }
    }

    this.arenaUltVfx.syncLocalPosition(this.px, this.py);
    this.resetArenaUltBurst();
    this.arenaUltVfx.update(dt, this.onArenaUltMoment);
    this.flushArenaUltBurst();

    this.updateFootstepDust(dt);
    this.updateParticles(dt);
    this.updateDmgNumbers(dt);
    this.updateWorldLabels(dt);
    this.updateCoinFlies(dt);
    this.updateTracers(dt);
    this.updateCorpses(dt);
    this.updateDecals(dt);
    this.updateAfterimages(dt);
    this.shockwaves.update(dt);
    this.screenFlash.update(dt);
    if (this.muzzle.t > 0) this.muzzle.t = Math.max(0, this.muzzle.t - dt);
    this.updateRemoteAnims(dt);
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);
    const ke = Math.min(1, dt * KICK_DECAY);
    this.kickX -= this.kickX * ke; this.kickY -= this.kickY * ke;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * HURT_FLASH_DECAY);

    this.checkFloorCleared();

    // Smooth camera follow: ease toward the focus instead of hard-snapping every frame, so
    // per-frame movement variance (variable-dt sim step) doesn't read as jitter. High factor
    // = still tight tracking, just enough smoothing to absorb frame-time noise. The focus is
    // the local player — or, while down and spectating, the watched teammate; the same ease
    // glides the hand-off out and back (revive returns the camera home). This runs at the
    // fixed sim rate; render() interpolates between the last two eased states per frame.
    {
      const focus = this.cameraFocus();
      const tx = focus.x - this.canvas.width / 2;
      const ty = focus.y - this.canvas.height / 2;
      const k = 1 - Math.pow(0.000001, dt); // very tight follow; movement is already smooth (fixed-step)
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }
    // Player velocity for the reactive ambience (pollen scatters as you run through it).
    const pvx = dt > 0 ? (this.px - this.lastPx) / dt : 0;
    const pvy = dt > 0 ? (this.py - this.lastPy) / dt : 0;
    this.lastPx = this.px;
    this.lastPy = this.py;
    this.motes.update(
      dt,
      this.cam.x,
      this.cam.y,
      this.canvas.width,
      this.canvas.height,
      this.px,
      this.py,
      pvx,
      pvy,
      this.fxQuality,
    );
    this.updateHazardCosmetics(dt);

    // Wave-audio observation pass: authoritative attack-state tells (windup/lock/active/
    // recover edges), revive-channel lifecycle, beam stop hysteresis, entity loop sweep.
    waveAudio.frame({
      listener: {
        x: this.px, y: this.py,
        camLeft: this.cam.x - 160, camTop: this.cam.y - 160,
        camRight: this.cam.x + this.canvas.width + 160, camBottom: this.cam.y + this.canvas.height + 160,
      },
      enemies: this.world.enemies,
      players: this.waveFramePlayers(),
      // Diegetic ambience placement (the Deep emitter): only wall/material cells are
      // valid sources — the biome's fabric creaks, never the empty air over the floor.
      isMaterialCellAt: (x, y) => this.isWallAt(x, y),
    });
  }

  // Every body the revive-channel audio watches: the local sim player(s) plus — online —
  // the interpolated teammates, whose authoritative channel progress rides PlayerWire.rv.
  // Without the remotes, a teammate being revived beside you would be silent online.
  private *waveFramePlayers(): Generator<WaveFramePlayer> {
    for (const p of this.world.players.values()) {
      yield { id: p.id, x: p.x, y: p.y, isDown: p.isDown, reviveProgress: p.reviveProgress };
    }
    for (const r of this.remotes()) {
      yield { id: r.playerId, x: r.x, y: r.y, isDown: r.isDown, reviveProgress: r.reviveProgress };
    }
  }

  // Ease the visual hazard clock onto the sim's authoritative one (online snapshots step
  // it at 20Hz; hit-stop pauses it) and fire the idle->telegraph->active edge cues:
  // an arming tick and an eruption burst per hazard, positional and camera-gated. All
  // cosmetic — damage resolves in the sim off the REAL clock.
  private updateHazardCosmetics(dt: number) {
    const target = this.world.floorHazardClock;
    this.hazardVisClock += dt;
    const drift = target - this.hazardVisClock;
    if (Math.abs(drift) > 0.6) this.hazardVisClock = target;
    else this.hazardVisClock += drift * Math.min(1, dt * 8);

    const hazards = this.world.floorHazards;
    if (hazards.length === 0) {
      if (this.hazardPhases.size > 0) this.hazardPhases.clear();
      return;
    }
    let poolNear = false;
    for (const h of hazards) {
      // Manifest §6: the toxic pool has no phase edge — its quiet surface loop is
      // proximity-gated instead (one mixed voice for the nearest body of liquid).
      if (h.kind === "toxic_pool") {
        const px = (h.tx + 0.5) * TILE, py = (h.ty + 0.5) * TILE;
        if (Math.hypot(px - this.px, py - this.py) <= TOXIC_LOOP_RADIUS) poolNear = true;
        continue;
      }
      const phase = floorHazardPhaseAt(h, this.hazardVisClock);
      const prev = this.hazardPhases.get(h.id);
      this.hazardPhases.set(h.id, phase);
      if (prev === undefined || phase === prev) continue;
      const x = (h.tx + 0.5) * TILE, y = (h.ty + 0.5) * TILE;
      if (!this.isNearCamera(x, y, FX_CAMERA_MARGIN_MAX)) continue;
      // Phase-edge cues route through the wave manifest (authored hazard/* assets with
      // safe library fallbacks) — never the old uiClick/meleeSwing/enemyAttack repitches.
      const cues = WAVE_HAZARDS[h.kind];
      if (phase === "telegraph") {
        if (cues?.telegraph) waveAudio.play(cues.telegraph, { x, y, entityId: h.id });
      } else if (phase === "active") {
        if (cues?.active) waveAudio.play(cues.active, { x, y, entityId: h.id });
        switch (h.kind) {
          case "spikes":
            this.spawnPuff(x, y, 3, "#c9c9de");
            break;
          case "fire_vent":
            this.spawnEmberAt(x, y - 6, 8);
            this.spawnPuff(x, y - 10, 4, "#ff8a3b");
            break;
          case "void_rift":
            this.spawnSparkleBurst(x, y, 6, this.currentBiome.accent);
            break;
          default:
            break;
        }
      }
    }
    waveAudio.holdLoop("toxic_pool.loop", "near", poolNear);
    if (this.hazardPhases.size > hazards.length * 2) {
      // Floor changed underneath us: drop stale ids so the map stays bounded.
      const live = new Set<number>();
      for (const h of hazards) live.add(h.id);
      for (const id of this.hazardPhases.keys()) if (!live.has(id)) this.hazardPhases.delete(id);
    }
  }

  // Little dust kicks at the feet while running — the floor reacts to movement. Direct
  // particle pushes (never event-driven), so it stays a purely local cosmetic.
  private updateFootstepDust(dt: number) {
    if (!this.isPlayerMoving || this.isDown || this.p.dashTime > 0) { this.footstepCd = 0; return; }
    this.footstepCd -= dt;
    if (this.footstepCd > 0) return;
    this.footstepCd = FOOTSTEP_INTERVAL;
    this.pushParticle({
      x: this.px + (Math.random() * 2 - 1) * 6, y: this.py + 15,
      vx: (Math.random() * 2 - 1) * 16 - this.playerLean * 22, vy: -6 - Math.random() * 10,
      life: 0.24 + Math.random() * 0.12, maxLife: 0.36,
      color: "#9a8f80", size: 2 + Math.random() * 1.6, kind: "puff", rot: 0, vr: 0, gravity: -12, drag: 0.9,
    });
  }

  private isCurrentFloorCleared(): boolean {
    if (this.isArena) return false;
    if (this.mode === "online" && this.wsTransport) return this.wsTransport.isFloorCleared();
    return isFloorCleared(this.world);
  }

  // The floor-clear beat: the moment the last enemy (and queued reinforcement) is gone,
  // celebrate once — fanfare, a banner pointing at the stairs, and a sparkle at the exit.
  private checkFloorCleared() {
    const isClearedNow = this.isCurrentFloorCleared();
    if (!isClearedNow) { this.isClearCelebrated = false; return; }
    if (this.isClearCelebrated) return;
    this.isClearCelebrated = true;
    sfx("floorClear");
    this.addTrauma(0.1);
    this.flashScreen(140, 255, 190, 0.08, 2.5);
    const isParty = this.mode !== "solo" && this.remotes().length > 0;
    this.hud.showBanner(isParty ? "FLOOR CLEAR \u00b7 MEET AT EXIT" : "FLOOR CLEAR \u00b7 \u25be GO DOWN");
    const d = this.dungeon;
    this.spawnSparkleBurst(d.exit.x * TILE + TILE / 2, d.exit.y * TILE + TILE / 2, 14, "#8affc0");
  }

  // Replay each SimEvent into the EXACT existing FX body (spawnParticles/sfx/addTrauma/...)
  // — the juice is byte-identical; only the trigger path changed. isNearCamera gating stays
  // a client concern here. Remote-player FX are handled separately (presence-driven).
  private handleSimEvents(events: SimEvent[]) {
    this.fxBurstCount = 0;
    this.burstFreeze = 0;
    this.burstTrauma = 0;
    this.burstKick = 0;
    this.burstKickDir = 0;
    this.resetArenaUltBurst();
    this.isHaloActiveForBurst = false;
    this.isHaloFlaredForBurst = false;
    this.haloImpactCount = 0;
    this.haloImpactSampleCount = 0;
    this.haloImpactTrauma = 0;
    if (this.weapon === "halo") {
      for (const effect of this.effects) {
        if (effect.kind !== "orbit" || effect.owner !== LOCAL_ID) continue;
        this.isHaloActiveForBurst = true;
        this.isHaloFlaredForBurst = effect.flare > 0;
        this.haloBurstAngle = effect.angle;
        this.haloBurstRing = effect.ring;
        this.haloBurstBlades = effect.blades;
        this.haloBurstX = this.p.x;
        this.haloBurstY = this.p.y;
        break;
      }
    }
    for (const e of events) this.handleSimEvent(e);
    this.flushHaloImpacts();
    // The explosion/kill burst coalesces its hitstop + shake into ONE apply per frame. The
    // per-event calls all clamp anyway (freeze -> max, trauma -> sum capped at 1), so this is
    // outcome-identical while a many-detonation frame no longer runs the apply 11 times.
    if (this.burstFreeze > 0) this.addFreeze(this.burstFreeze);
    if (this.burstTrauma > 0) this.addTrauma(this.burstTrauma);
    if (this.burstKick > 0) {
      const kick = this.burstKick * settings.effectiveRecoil;
      this.kickX += Math.cos(this.burstKickDir) * kick;
      this.kickY += Math.sin(this.burstKickDir) * kick;
    }
    this.flushArenaUltBurst();
  }

  // Coalesce heavy FX bursts: as more explosions/kills land in one frame, scale per-event
  // particle counts down so the frame's total spawn work stays bounded. Advances the frame's
  // burst counter — called only for ON-SCREEN bursts, the ones actually paid for.
  private burstScale(): number {
    const n = this.fxBurstCount++;
    return (n < FX_BURST_FULL ? 1 : n < FX_BURST_HALF ? 0.5 : 0.25) * this.fxQuality;
  }

  private resetArenaUltBurst(): void {
    this.arenaBurstFreeze = 0;
    this.arenaBurstTrauma = 0;
    this.arenaBurstKickX = 0;
    this.arenaBurstKickY = 0;
  }

  private flushArenaUltBurst(): void {
    if (this.arenaBurstFreeze > 0) this.addFreeze(this.arenaBurstFreeze);
    if (this.arenaBurstTrauma > 0) this.addTrauma(Math.min(1, this.arenaBurstTrauma));
    if (this.arenaBurstKickX !== 0 || this.arenaBurstKickY !== 0) {
      const recoil = settings.effectiveRecoil;
      this.kickX += this.arenaBurstKickX * recoil;
      this.kickY += this.arenaBurstKickY * recoil;
    }
    this.resetArenaUltBurst();
  }

  private readonly onArenaUltMoment = (cast: ArenaUltCastView, moment: ArenaUltMoment): void => {
    const isNear = this.isNearCamera(cast.x, cast.y, 180);
    if (!isNear) return;
    switch (moment) {
      case "salvo": {
        const cos = Math.cos(cast.aim);
        const sin = Math.sin(cast.aim);
        for (let i = 0; i < ARENA_SALVO.shots; i++) {
          const side = (i - (ARENA_SALVO.shots - 1) / 2) * 13;
          this.remoteTracers.push({
            x: cast.x + cos * 18 - sin * side,
            y: cast.y + sin * 18 + cos * side,
            angle: cast.aim,
            life: ARENA_SALVO.volleySec,
            color: ARENA_ULT_HUE.salvo,
            len: ARENA_SALVO.rangePx - 18,
            width: 10,
          });
        }
        if (cast.isLocal) {
          const kick = 9;
          this.arenaBurstFreeze = Math.max(this.arenaBurstFreeze, 0.035);
          this.arenaBurstTrauma += 0.28;
          this.arenaBurstKickX -= Math.cos(cast.aim) * kick;
          this.arenaBurstKickY -= Math.sin(cast.aim) * kick;
        } else {
          this.arenaBurstTrauma += 0.1;
        }
        this.lighting.addPulse(cast.x, cast.y, 150, 0.8 * settings.flashFactor, ARENA_ULT_HUE.salvo, 0.24);
        this.flashScreen(232, 255, 255, 0.11, 4);
        break;
      }
      case "triage":
        this.shockwaves.spawn(cast.x, cast.y, 12, 112, 0.42, ARENA_ULT_HUE.triage, 7, 0.95);
        this.lighting.addPulse(cast.x, cast.y, 130, 0.65 * settings.flashFactor, ARENA_ULT_HUE.triage, 0.38);
        break;
      case "shoveShatter": {
        const arc = ARENA_SHOVE.arcDeg * Math.PI / 180;
        this.shockwaves.spawnArc(
          cast.x,
          cast.y,
          18,
          ARENA_SHOVE.reachPx * 2.2,
          0.34,
          ARENA_ULT_HUE.shove,
          cast.aim,
          arc,
          8 * settings.flashFactor,
          settings.flashFactor,
        );
        const scale = this.burstScale();
        this.spawnDustRing(
          cast.x,
          cast.y,
          ARENA_SHOVE.reachPx,
          Math.max(3, Math.round(10 * scale)),
          ARENA_ULT_HUE.shove,
        );
        this.arenaBurstFreeze = Math.max(this.arenaBurstFreeze, 0.055);
        this.arenaBurstTrauma += 0.34;
        this.flashScreen(234, 243, 255, 0.12, 4.2);
        break;
      }
      case "slip":
      case "slipLanding": {
        const isLanding = moment === "slipLanding";
        const remote = cast.isLocal
          ? null
          : this.remotes().find((candidate) => candidate.playerId === cast.pid) ?? null;
        const base = cast.isLocal
          ? heroBodySprite(this.selfCosmetics?.hat ?? null)
          : heroBodySprite(remote?.hat ?? null);
        const facing = cast.isLocal
          ? this.facing
          : remote?.facing ?? (Math.cos(cast.aim) < 0 ? -1 : 1);
        for (let i = 0; i < 4; i++) {
          const k = i / 3;
          this.afterimages.push({
            x: cast.x + Math.cos(cast.aim) * ARENA_SLIP.blinkPx * k,
            y: cast.y + Math.sin(cast.aim) * ARENA_SLIP.blinkPx * k,
            facing,
            t: isLanding ? 0.25 + i * 0.1 : i * 0.08,
            color: ARENA_ULT_HUE.slip,
            base,
          });
        }
        if (!isLanding) this.arenaBurstTrauma += cast.isLocal ? 0.12 : 0.05;
        break;
      }
    }
  };

  private flushMeleeShockwave() {
    if (this.meleeShockwaveCount === 0) return;
    const flash = settings.flashFactor;
    if (flash > 0) {
      const scale = this.meleeShockwaveScale;
      this.shockwaves.spawn(
        this.meleeShockwaveX / this.meleeShockwaveCount,
        this.meleeShockwaveY / this.meleeShockwaveCount,
        10,
        54 + 26 * scale,
        0.26 + 0.06 * scale,
        this.meleeShockwaveColor,
        (3.5 + 1.5 * scale) * flash,
        (0.65 + 0.35 * scale) * flash,
      );
    }
    this.meleeShockwaveX = 0;
    this.meleeShockwaveY = 0;
    this.meleeShockwaveCount = 0;
    this.meleeShockwaveScale = 1;
  }

  private handleSimEvent(e: SimEvent) {
    switch (e.t) {
      case "shot": {
        // A firing owner's companion does its cosmetic reaction beat (local + teammates alike).
        this.triggerPetEmote(this.isSelfPid(e.pid) ? LOCAL_ID : e.pid);
        const w = WEAPONS[e.weapon];
        const outcomeColor = e.outcome === "ricochet" ? "#c98bff"
          : e.outcome === "seeker" ? "#8affe0"
            : e.outcome === "blast" ? "#ffb43b"
              : e.outcome === "pierce" ? "#e8f0ff"
                : w.color;
        const muzzleParticleColor = e.outcome === "none" && e.mode === "none"
          ? "#ffe6a0"
          : outcomeColor;
        const playFireAudio = (gain = 1): void => {
          if (e.outcome !== "none") {
            waveAudio.cueAt(ODDSMAKER_OUTCOME_AUDIO[e.outcome], e.x, e.y);
            return;
          }
          if (!waveAudio.weaponFired(e.weapon, { x: e.x, y: e.y, gain, beamKey: e.pid })) {
            if (gain < 1) this.sfxAt(SHOOT_SFX[e.weapon], e.x, e.y, { ...SHOOT_SFX_OPTS[e.weapon], gain });
            else sfx(SHOOT_SFX[e.weapon], SHOOT_SFX_OPTS[e.weapon]);
          }
        };
        // Online MP has ONE authoritative event stream: a teammate's shot arrives here too
        // (v14, "pos" scope). The local player gets the full juice; a REMOTE player's shot
        // is replayed POSITIONALLY — muzzle particles + tracer + a recoil punch on their
        // blob + spatial audio (quieter if far) — with NO local camera kick/trauma/muzzle.
        if (!this.isSelfPid(e.pid)) {
          this.spawnParticles(e.x, e.y, w.muzzle, muzzleParticleColor);
          if (e.mode === "flood") {
            for (const offset of [-0.34, 0, 0.34]) {
              this.remoteTracers.push({ x: e.x, y: e.y, angle: e.aim + offset, life: 0.12, color: "#78cbd1", len: 28 });
            }
          } else {
            this.remoteTracers.push({
              x: e.x, y: e.y, angle: e.aim, life: 0.12,
              color: e.mode === "drain" ? "#d9fbff" : outcomeColor,
              len: e.mode === "drain" || e.outcome === "pierce" ? 64 : undefined,
              isArc: e.outcome === "ricochet",
            });
          }
          const entry = this.remoteAnims.get(e.pid);
          if (entry) triggerRecoil(entry.anim);
          playFireAudio(0.4);
          break;
        }
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon] * settings.effectiveRecoil);
        this.muzzle.t = MUZZLE_DUR; this.muzzle.x = e.x; this.muzzle.y = e.y; this.muzzle.angle = e.aim;
        this.muzzle.size = e.mode === "flood" ? w.muzzle + 2 : e.mode === "drain" ? 2 : w.muzzle;
        this.muzzle.color = outcomeColor;
        this.spawnParticles(e.x, e.y, w.muzzle, muzzleParticleColor);
        if (SMOKY_WEAPONS.has(e.weapon)) this.spawnPuff(e.x, e.y, 3, "#c9b8a0");
        if (e.weapon !== "rapid" && e.weapon !== "flamer") this.spawnShell(e.px, e.py - 6, e.aim);
        // Semantic weapon-audio contract first (charge TIER releases are distinct stems,
        // the risk payoff is a distinct stem), then manifest-bound weapons (Thumper lob,
        // Sunlance held-beam lifecycle), then the exact legacy sample.
        if (e.outcome !== "none") playFireAudio();
        else if (!this.playSemanticFireAudio(e)) playFireAudio();
        this.addTrauma(FIRE_TRAUMA[e.weapon]);
        const kick = FIRE_KICK[e.weapon] * settings.effectiveRecoil;
        this.kickX += -Math.cos(e.aim) * kick;
        this.kickY += -Math.sin(e.aim) * kick;
        break;
      }
      case "meleeSwing": {
        // The owner's companion reacts to a swing too (same cosmetic emote as a shot).
        this.triggerPetEmote(this.isSelfPid(e.pid) ? LOCAL_ID : e.pid);
        const w = WEAPONS[e.weapon];
        const m = w.melee;
        const feel = MELEE_FEEL[e.weapon];
        // A remote teammate's swing: the slash arc + a recoil punch on their blob + spatial
        // audio, no local camera kick/trauma (see the shot case).
        if (!this.isSelfPid(e.pid)) {
          const isVisible = this.isNearCamera(e.x, e.y);
          if (m && isVisible) this.spawnSlashWind(e.x, e.y, e.aim, m, w.color);
          const entry = this.remoteAnims.get(e.pid);
          if (entry) triggerRecoil(entry.anim);
          if (feel) {
            if (!waveAudio.playMeleeSwing(e.weapon, { x: e.x, y: e.y, gain: 0.4 })) {
              this.sfxAt(feel.swingSfx, e.x, e.y, { rate: feel.swingRate, gain: feel.swingGain * 0.4 });
            }
          } else {
            this.sfxAt(SHOOT_SFX[e.weapon], e.x, e.y, { gain: 0.4 });
          }
          if (isVisible) this.spawnParticles(e.bx + Math.cos(e.aim) * 14, e.by + Math.sin(e.aim) * 14, 4, w.color);
          break;
        }
        this.meleeFlipDir = -this.meleeFlipDir; // alternate the visual sweep; the hitbox wedge is symmetric
        const comboBuild = (Math.min(COMBO_MAX_MULT, comboTierFor(this.combo).mult) - 1) / (COMBO_MAX_MULT - 1);
        const baseTrailLength = feel?.trailLength ?? 1;
        this.meleeTrailLength = baseTrailLength + (1 - baseTrailLength) * comboBuild;
        this.meleeTrailWidth = (feel?.trailWidth ?? 1) * (1 + comboBuild * 0.18);
        this.meleeTrailIntensity = (feel?.trailIntensity ?? 1) * (1 + comboBuild * 0.45);
        this.meleeImpactWeapon = m ? e.weapon : null;
        this.meleeImpactUntil = this.animClock + (m?.swingDur ?? 0.2) + 0.1;
        this.meleeImpactAim = e.aim;
        this.meleeImpactPuffDist = m ? m.reach * (m.isThrust ? 0.65 : 0.55) : 0;
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon] * settings.effectiveRecoil);
        if (m) this.spawnSlashWind(e.x, e.y, e.aim, m, w.color);
        if (feel) {
          if (!waveAudio.playMeleeSwing(e.weapon, { x: e.x, y: e.y })) {
            sfx(feel.swingSfx, { rate: feel.swingRate, gain: feel.swingGain });
          }
        } else {
          sfx(SHOOT_SFX[e.weapon]);
        }
        this.addTrauma(FIRE_TRAUMA[e.weapon]);
        // Melee kicks the camera INTO the strike (a lunge), not back like gun recoil.
        const kick = FIRE_KICK[e.weapon] * settings.effectiveRecoil;
        this.kickX += Math.cos(e.aim) * kick * 1.6;
        this.kickY += Math.sin(e.aim) * kick * 1.6;
        this.spawnParticles(e.bx + Math.cos(e.aim) * 14, e.by + Math.sin(e.aim) * 14, 4, w.color);
        break;
      }
      case "enemyHit": {
        triggerFlash(this.animForId(e.eid));
        const localMeleeWeapon = e.melee
          ? this.meleeImpactWeaponFor(e.eid, e.puffX, e.puffY)
          : null;
        const isHaloImpact = e.melee
          && this.isHaloActiveForBurst
          && localMeleeWeapon === null
          && this.isHaloImpactPoint(e.puffX, e.puffY);
        let meleeWeapon: WeaponId | null = null;
        if (isHaloImpact) {
          const isSampled = this.queueHaloImpact(e.puffX, e.puffY, e.dmgX, e.dmgY, e.dmg, e.puffColor, e.crit);
          if (isSampled) this.captureUltMoteOrigin(e.dmgX, e.dmgY, this.isBossEid(e.eid) ? "boss" : "dmg");
        } else {
          this.captureUltMoteOrigin(e.dmgX, e.dmgY, this.isBossEid(e.eid) ? "boss" : "dmg");
          this.spawnDmgNumber(e.dmgX, e.dmgY, e.dmg, { crit: e.crit });
          this.spawnPuff(e.puffX, e.puffY, e.crit ? 9 : 5, e.puffColor);
          if (e.melee) meleeWeapon = this.replayMeleeImpact(e.eid, e.puffX, e.puffY, e.crit, localMeleeWeapon);
        }
        if (e.crit) {
          if (e.melee) waveAudio.play("melee.crit", { x: e.puffX, y: e.puffY });
          else sfx("crit", { gain: 0.6 });
          if (!isHaloImpact) this.spawnSparkFlash(e.puffX, e.puffY, "#fff3c4");
          if (e.melee) this.burstFreeze = Math.max(this.burstFreeze, 0.03);
          else this.addFreeze(0.03); // a hair of impact-frame so a crit lands harder
        }
        if (e.closeShotgun) this.addFreeze(FREEZE_SHOTGUN);
        if (meleeWeapon !== null && (MELEE_FEEL[meleeWeapon]?.isHeavy === true || e.crit)) {
          waveAudio.play("melee.cleaveShock", { x: e.puffX, y: e.puffY });
        }
        // Sunlance hits tick through the wave layer's 120ms-per-target limiter — a held
        // beam at 22Hz must never machine-gun the generic hit sample.
        if (!e.killed) {
          if (!e.melee && waveAudio.isBeamWeapon(this.p.weapon)) {
            waveAudio.beamHitAt(e.eid, e.dmgX, e.dmgY);
          } else if (isHaloImpact) {
            // The ring's contact voice (flared hits read as the CATCH) — the local
            // wielder's read; remote halos keep the shared melee thump.
            const cue = this.isHaloFlaredForBurst ? "halo.catch" : "halo.hit";
            if (!waveAudio.cueAt(cue, e.puffX, e.puffY, e.eid)) sfx("meleeHit", { gain: 0.9 });
          } else if (e.melee) {
            if (meleeWeapon === null || !waveAudio.playMeleeImpact(meleeWeapon, {
              x: e.puffX,
              y: e.puffY,
              entityId: e.eid,
            })) {
              sfx("meleeHit", { gain: 0.9 });
            }
          } else {
            // The semantic HURT event (bestiary audio contract): kind-resolved where a
            // body owns a hurt identity (a shielder only ever hurts from the flank),
            // the rate-limited generic row otherwise, legacy sample as the last rung.
            const hitKind = this.world.enemies.find((en) => en.id === e.eid)?.kind;
            const hurtCue = (hitKind !== undefined ? bestiaryCue(hitKind, "rearHurt") : null) ?? "mob.hurt";
            if (!waveAudio.cueAt(hurtCue, e.dmgX, e.dmgY, e.eid)) sfx("enemyHit", { gain: 0.65 });
          }
        }
        break;
      }
      case "thornsHit":
        triggerFlash(this.animForId(e.eid));
        this.spawnDmgNumber(e.x, e.y - e.radius, e.dmg, { color: "#c8b8ff" });
        this.spawnPuff(e.x, e.y, 5, e.tint);
        break;
      case "burnTick":
        this.spawnDmgNumber(e.x, e.y - e.radius, e.dmg, { color: "#ff8a3b" });
        this.spawnEmberAt(e.x, e.y, e.radius);
        break;
      case "shockArc": {
        const len = Math.hypot(e.tx - e.x, e.ty - e.y);
        this.remoteTracers.push({ x: e.x, y: e.y, angle: Math.atan2(e.ty - e.y, e.tx - e.x), life: 0.12, color: e.color, len, isArc: true });
        triggerFlash(this.animForId(e.eid));
        this.spawnDmgNumber(e.tx, e.ty - e.tRadius, e.dmg, { color: e.color });
        this.spawnPuff(e.tx, e.ty, 5, e.color);
        if (!e.killed) this.sfxAt("enemyHit", e.tx, e.ty, { gain: 0.5, rate: 1.5 });
        break;
      }
      case "enemyKill": {
        const arch = ENEMY_ARCHETYPES[e.kind];
        const big = isBossKind(e.kind);
        this.captureUltMoteOrigin(e.x, e.y, big ? "boss" : "kill");
        // WAVE 1 amber earn fact: a boss defeat this run (the server grants the one-time
        // first-boss Amber per account; trash mobs never pay — the anti-grind rule).
        if (big) this.runBossKills.add(e.kind);
        if (big) audio.setMusic("dungeon"); // the intense boss track relaxes after the kill
        // The visual death burst is camera-gated (an off-screen kill in a swarm pays nothing)
        // and coalesced so many kills in ONE frame stay cheap; the hitstop/shake flush once.
        // Bookkeeping below (corpse, audio, anim GC) always runs so state stays consistent.
        if (this.isNearCamera(e.x, e.y)) {
          const s = this.burstScale();
          this.spawnGibs(e.x, e.y, Math.round((big ? 24 : 10) * s), arch.tint);
          this.spawnParticles(e.x, e.y, Math.round((big ? 20 : 8) * s), big ? "#ffb43b" : arch.tint);
          this.addDecal(e.x, e.y, arch.tint, big ? 36 : 18, "splat");
          this.replayDeathBurst(e.kind, e.x, e.y);
          this.burstFreeze = Math.max(this.burstFreeze, big ? FREEZE_HEAVY : FREEZE_KILL);
          const mult = comboTierFor(e.combo).mult;
          const comboTrauma = big ? 0 : COMBO_TRAUMA * ((mult - 1) / (COMBO_MAX_MULT - 1));
          this.burstTrauma += (big ? TRAUMA_BOSS_KILL : TRAUMA_KILL) + comboTrauma;
        }
        const dur = big ? DEATH_DUR_BOSS
          : (e.kind === "slime" || e.kind === "skeleton" || e.kind === "bat") ? DEATH_DUR_SHEET
          : DEATH_DUR;
        const size = arch.drawSize * (TIERS[e.tier as EnemyTier]?.drawMult ?? 1);
        this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size, facing: this.px >= e.x ? 1 : -1, t: 0, dur });
        if (this.corpses.length > MAX_CORPSES) this.corpses.shift(); // oldest corpse yields to the newest
        const comboRate = 1 + Math.min(e.combo - 1, 20) * 0.015;
        // Wave-roster bosses die on their authored identity cue, never the generic splat.
        if (!waveAudio.bossDeath(e.kind, e.x, e.y)) {
          if (!waveAudio.cueAt("mob.death", e.x, e.y, e.eid)) {
            sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : comboRate });
          }
          // The tier's authored body/debris LAYER rides on top of the material death.
          const layer = TIER_LAYERS[e.tier];
          if (layer) waveAudio.cueAt(layer, e.x, e.y, e.eid);
        }
        this.enemyAnims.delete(e.eid);
        break;
      }
      case "heal":
        this.spawnParticles(e.x, e.y, 8, "#ff6a9d");
        // A teammate's heal is heard positionally (quieter); the local player's plays full.
        if (this.isSelfPid(e.pid)) sfx("heart", { gain: 0.5 });
        else this.sfxAt("heart", e.x, e.y, { gain: 0.4 });
        break;
      case "dashStart":
        this.dashImgCd = 0;
        this.spawnParticles(e.x, e.y, 10, "#ffd27a");
        this.addDecal(e.x, e.y, "#ffd27a", 16, "ring");
        sfx("dash");
        break;
      case "dashTrail":
        this.spawnParticles(e.x, e.y, 1, "#ffd27a");
        break;
      case "playerHurt":
        this.arenaUltVfx.pulseSalvoHit(e.x, e.y);
        // A teammate getting hit MUST be audible to everyone (Ian: "I want to hear my friend
        // get hit") — but a remote hit is a positional red burst + hurt cue on THEIR blob,
        // never the local player's screen shake / hurt vignette / shop-close.
        if (!this.isSelfPid(e.pid)) {
          this.spawnParticles(e.x, e.y, 10, "#ff5a5a");
          this.sfxAt("playerHurt", e.x, e.y, { gain: 0.6 });
          const entry = this.remoteAnims.get(e.pid);
          if (entry) triggerFlash(entry.anim);
          break;
        }
        triggerFlash(this.playerAnim);
        this.spawnParticles(e.x, e.y, 10, "#ff5a5a");
        sfx("playerHurt");
        this.addFreeze(FREEZE_HURT);
        this.addTrauma(TRAUMA_HURT);
        this.hurtFlash = 1;
        this.hurtDir = this.findThreatDir(); // point the vignette at whatever just hit us
        // Taking a hit closes the shop panel: browsing must never hold a player's inputs
        // idle while something that chased them into the room is chewing on them.
        this.shopPanel.close();
        break;
      case "itemPicked":
        // The pick SOUND (blessing vs levelup) plays at choice time in the blessing overlay,
        // where the reached level is known; this event carries the world-space glow.
        this.spawnParticles(e.x, e.y, 20, e.tint);
        this.spawnSparkleBurst(e.x, e.y, 14, e.tint);
        this.flashScreen(255, 210, 122, 0.1, 2.5);
        this.addTrauma(0.12);
        break;
      case "offerBlessing":
        // Online: the SERVER decides the choice set and sends a separate `offer` message (drained
        // in tick via the transport); ignore the sim event's local roll so choice authority stays
        // server-side. Solo/co-op roll their own choices locally.
        if (this.mode !== "online") this.offerBlessing(e.rare);
        break;
      case "blessingExpired":
        this.onOfferExpired(e.pid);
        break;
      case "pickup": {
        // The world-space glow/decal fires for everyone at the spot; the chime is full for
        // the local collector, positional (quieter) for a teammate's pickup.
        const isSelfPickup = this.isSelfPid(e.pid);
        const chime = (name: SfxName) => { if (isSelfPickup) sfx(name); else this.sfxAt(name, e.x, e.y, { gain: 0.4 }); };
        if (e.kind === "coin") { this.spawnParticles(e.x, e.y, 6, "#ffd27a"); this.addDecal(e.x, e.y, "#ffd27a", 10, "ring"); chime("coin"); }
        else if (e.kind === "heart") { this.spawnParticles(e.x, e.y, 8, "#ff6a6a"); this.addDecal(e.x, e.y, "#ff6a6a", 12, "ring"); chime("heart"); }
        else { this.spawnParticles(e.x, e.y, 12, "#ffb43b"); this.addDecal(e.x, e.y, "#ffb43b", 14, "ring"); chime("weapon"); }
        // The local player's coin flies to the top-left wallet (client juice only).
        if (isSelfPickup && e.kind === "coin") this.spawnCoinFly(e.x, e.y);
        break;
      }
      case "friendlyNudge": {
        // The playful friendly-fire bonk (server-authoritative KB already applied): a soft
        // round puff in the SHOOTER's color at contact + a tiny star mote, a springy
        // squash-and-stretch on the bonked blob, and a rounded comedic sound — explicitly
        // NOT red, no screen shake, no i-frame flicker, no hurt anim.
        this.spawnPuff(e.x, e.y, 5, this.shooterColorOf(e.shooterId));
        this.spawnSparkleBurst(e.x, e.y, 4, "#fff6d0");
        if (this.isSelfPid(e.targetId)) triggerBounce(this.playerAnim);
        else { const entry = this.remoteAnims.get(e.targetId); if (entry) triggerBounce(entry.anim); }
        // Softer than combat, pitch-randomized, positional (quieter if far). The sim's
        // per-pair cooldown already guarantees one bonk per nudge (never per-bullet).
        this.sfxAt("bonk", e.x, e.y, { gain: 0.35, rate: 0.9 + Math.random() * 0.3 });
        break;
      }
      case "shopBuy": {
        // The register moment: positional (everyone browsing the stall sees a teammate's
        // claim land), with the buyer's kind selecting the flavor. Patch plays the
        // handover pose over it. The OUTCOME itself is authoritative state — coins/stock/
        // SOLD flow via snapshot; this is purely the chime.
        this.spawnSparkleBurst(e.x, e.y, 10, "#ffd27a");
        this.spawnParticles(e.x, e.y, 8, "#ffd27a");
        this.addDecal(e.x, e.y, "#ffd27a", 12, "ring");
        this.sfxAt("coin", e.x, e.y, { gain: 0.7 });
        if (e.kind === "heart") this.sfxAt("heart", e.x, e.y, { gain: 0.55 });
        else if (e.kind === "blessing") this.sfxAt("blessing", e.x, e.y, { gain: 0.5 });
        else if (e.kind === "weapon") this.sfxAt("weapon", e.x, e.y, { gain: 0.55 });
        else this.sfxAt("levelup", e.x, e.y, { gain: 0.4 });
        // The BIG-PURCHASE flourish (designer feel spec): a legendary/artifact/mythic
        // claim is an EVENT — gold burst, a named banner, the levelup fanfare, and a
        // touch of shake, so the table-flip spend lands like one.
        if (PREMIUM_EVENT_KINDS.has(e.kind as ShopSlotKind)) {
          const gold = WEAPON_RARITY_COLOR.legendary;
          this.spawnSparkleBurst(e.x, e.y, 22, gold);
          this.spawnParticles(e.x, e.y, 16, gold);
          this.addDecal(e.x, e.y, gold, 26, "ring");
          this.spawnWorldLabel(e.x, e.y - 40, e.kind === "artifact" ? "THE DEAL IS STRUCK" : "A MYTHIC CLAIM", gold);
          this.sfxAt("levelup", e.x, e.y, { gain: 0.8, rate: 0.9 });
          this.addTrauma(0.18);
        }
        this.patchSellT = 0.6;
        if (this.isSelfPid(e.pid)) this.shopBoughtT = 1.2;
        break;
      }
      case "lootDrop":
        this.addDecal(e.x, e.y, e.color, 15, "ring");
        this.spawnPuff(e.x, e.y, 5, e.color);
        break;
      case "weaponDrop":
        // A deliberate drop lands with a small pop and names itself, so every nearby player
        // (including the dropper) reads what just hit the floor.
        this.addDecal(e.x, e.y, "#ffb43b", 14, "ring");
        this.spawnPuff(e.x, e.y, 6, "#ffb43b");
        this.spawnWorldLabel(e.x, e.y - 22, WEAPONS[e.weapon].name.toUpperCase(), "#ffd166");
        this.sfxAt("weapon", e.x, e.y, { rate: 0.8, gain: 0.5 });
        break;
      case "mysteryReveal": {
        // The gamble resolves: name the identity for everyone at the pedestal, in its
        // rarity color, with the twist's flavor line for the collector's story.
        const w = WEAPONS[e.weapon];
        const accent = WEAPON_RARITY_COLOR[w.rarity];
        this.addDecal(e.x, e.y, MYSTERY_COLOR, 18, "ring");
        this.spawnSparkleBurst(e.x, e.y, 14, MYSTERY_COLOR);
        this.spawnParticles(e.x, e.y, 12, accent);
        this.spawnWorldLabel(e.x, e.y - 26, `??? \u2192 ${w.name.toUpperCase()}`, accent);
        if (e.twist === "blessed") this.spawnWorldLabel(e.x, e.y - 12, "BLESSED \u00b7 +1 HP", "#8affc0");
        else if (e.twist === "cursed") this.spawnWorldLabel(e.x, e.y - 12, "CURSED \u00b7 JAMMED", "#ff6a6a");
        this.sfxAt("weapon", e.x, e.y, { rate: w.rarity === "legendary" ? 1.3 : 1.1, gain: 0.7 });
        this.addTrauma(w.rarity === "legendary" ? 0.2 : 0.1);
        break;
      }
      case "bulletWall":
        this.spawnSparks(e.x, e.y, 5, e.aim);
        // A light impact tick so a round dying on a wall reads audibly — rate-limited so a
        // firefight peppering a wall never strobes. TODO(audio director): a bespoke
        // bullet-on-stone tick; borrows the ricochet stem, trimmed low, until then.
        this.sfxAtThrottled("ricochet", e.x, e.y, "bulletWall", 3, { rate: 1.35, gain: 0.22 });
        break;
      case "bulletBounce":
        this.spawnSparks(e.x, e.y, 3, e.aim);
        this.spawnSparkFlash(e.x, e.y, e.color);
        // A ricochet IS a ricochet — the authored stem fits exactly; rate-limited.
        this.sfxAtThrottled("ricochet", e.x, e.y, "bulletBounce", 2, { gain: 0.4 });
        break;
      case "bulletBlocked": {
        // The block voices in the blocker's MATERIAL: shielder wood, living root
        // (rootward/marshal), a bulwark elite's steel plate.
        const blockCue = e.kind === "shielder" ? "shielder.block"
          : e.kind === "rootward" || e.kind === "marshal" ? "root.block"
          : "plate.block";
        if (!waveAudio.cueAt(blockCue, e.x, e.y)) this.sfxAt("parry", e.x, e.y, { rate: 1.2, gain: 0.5 });
        this.spawnSparks(e.x, e.y, 4, e.aim);
        if (this.isArena && e.kind === "shielder") {
          this.arenaUltVfx.cutShove(e.x, e.y, false, this.onArenaUltMoment);
        }
        break;
      }
      case "bulletExpire":
        this.spawnPuff(e.x, e.y, 6, e.color);
        break;
      case "propHit":
        triggerFlash(this.animForPropId(e.propId));
        this.spawnPuff(e.x, e.y, 5, PROP_TINT[e.kind]);
        // A soft thud when a round chews a prop (propBreak already sounds on destruction).
        // TODO(audio director): a bespoke prop-chew tick; borrows meleeHit low + dull rate.
        this.sfxAtThrottled("meleeHit", e.x, e.y, "propHit", 2, { rate: 0.8, gain: 0.28 });
        break;
      case "propBreak":
        this.replayPropBreak(e.kind, e.x, e.y);
        break;
      case "explosion": {
        // The impact voice routes by SOURCE (breach.impact / mortarDetonate / the legacy
        // barrel boom) and is positional — it always plays. The heavy FX burst is camera-gated
        // so an off-screen detonation (a thumper into a distant barrel cluster) pays nothing,
        // and coalesced so many blasts in ONE frame stay cheap; the hitstop/shake flush once.
        const impactCue = WEAPON_AUDIO[e.src]?.impact;
        if (!(impactCue !== undefined && waveAudio.cueAt(impactCue, e.x, e.y))) {
          this.sfxAt("barrel", e.x, e.y, { rate: 0.7 });
        }
        if (!this.isNearCamera(e.x, e.y)) break;
        const s = this.burstScale();
        // ODDSMAKER's BLAST payload is a SMALL (r=52), RAPID-fire boom (a ~2.5/s gamble). Giving
        // every one a barrel/thumper's full treatment — heavy hitstop, big trauma, a full debris
        // field, and a whole-screen flash — strobes the view, stutters the frame with back-to-back
        // hitstop, and floods the particle pool under sustained fire (the confirmed playtest lag).
        // A small rapid blast earns a proportionately lean pop: half the debris, a kill-weight
        // (not heavy) hitstop, softer shake, and the local light pulse INSTEAD of a screen flash.
        // Still a punchy, readable boom — the gamble fantasy is intact; big set-pieces are untouched.
        const isRapidBlast = e.src === "oddsmaker";
        const debris = isRapidBlast ? 0.5 : 1;
        this.lighting.addPulse(e.x, e.y, Math.min(EXPLOSION_LIGHT_MAX, e.r * 2), 0.85 * settings.flashFactor, "#ffb43b", EXPLOSION_LIGHT_DUR);
        this.burstFreeze = Math.max(this.burstFreeze, isRapidBlast ? FREEZE_KILL : FREEZE_HEAVY);
        this.burstTrauma += isRapidBlast ? 0.28 : 0.6;
        this.spawnGibs(e.x, e.y, Math.round(18 * s * debris), "#ff8a3b");
        this.spawnSparks(e.x, e.y, Math.round(16 * s * debris), Math.random() * 6.28);
        this.spawnParticles(e.x, e.y, Math.round(20 * s * debris), "#ffb43b");
        this.addDecal(e.x, e.y, "#ff7a2a", e.r * 0.6, "splat");
        this.shockwaves.spawn(e.x, e.y, 14, e.r * 1.6, 0.38, "#ffb43b", 5);
        this.spawnSparkleBurst(e.x, e.y, Math.round(10 * s * debris), "#ff8a3b");
        if (!isRapidBlast) this.flashScreen(255, 150, 60, 0.13, 3.2);
        break;
      }
      case "implosion":
        // The Lodestone's collapse: the explosion's inward twin — cooler palette, a
        // gentler thump, and converging spark rays instead of an outward shockwave.
        this.sfxAt("barrel", e.x, e.y, { rate: 1.4, gain: 0.5 });
        this.addTrauma(0.18);
        this.spawnConvergence(e.x, e.y, e.r, "#7fb0ff");
        this.addDecal(e.x, e.y, "#7fb0ff", e.r * 0.4, "ring");
        this.spawnSparkleBurst(e.x, e.y, 8, "#9ecfff");
        break;
      case "chestOpen":
        sfx("chest");
        this.spawnParticles(e.x, e.y, 22, e.kind === "boss" ? "#ffb43b" : "#ffd27a");
        this.spawnSparkleBurst(e.x, e.y, e.kind === "boss" ? 18 : 12, "#ffd27a");
        this.addDecal(e.x, e.y, "#ffd27a", 20, "ring");
        this.addTrauma(0.18);
        break;
      case "hazardHit": {
        // The floor connected: kind-flavored burst on top of the ordinary playerHurt beat
        // (which the sim raises separately for the shared hurt juice). The toxic pool has
        // no phase-edge cue, so contact is its manifest moment.
        if (e.kind === "toxic_pool") waveAudio.play("toxic_pool.enter", { x: e.x, y: e.y });
        const tint = HAZARD_HIT_TINT[e.kind];
        this.spawnPuff(e.x, e.y, 8, tint);
        // Each floor hazard gets its own contact voice (only the toxic pool sounded before).
        // TODO(audio director): bespoke spikes/fire_vent/void_rift contact stems; these borrow
        // the closest authored samples, trimmed, until they land. Rate-limited per kind.
        if (e.kind === "spikes") { this.spawnSparks(e.x, e.y, 6, -Math.PI / 2); this.sfxAtThrottled("parry", e.x, e.y, "hazard.spikes", 2, { rate: 1.4, gain: 0.4 }); }
        if (e.kind === "fire_vent") { this.spawnEmberAt(e.x, e.y, 10); this.sfxAtThrottled("barrel", e.x, e.y, "hazard.fire", 2, { rate: 1.6, gain: 0.35 }); }
        if (e.kind === "void_rift") { this.spawnSparkleBurst(e.x, e.y, 8, tint); this.sfxAtThrottled("tesla", e.x, e.y, "hazard.void", 2, { rate: 0.7, gain: 0.4 }); }
        this.addDecal(e.x, e.y, tint, 12, "ring");
        break;
      }
      case "spitMuzzle":
        this.sfxAt("shootRapid", e.x, e.y, { rate: 0.55, gain: 0.7 });
        this.spawnPuff(e.x, e.y, 6, "#ff5a7a");
        break;
      case "lungeTrail":
        this.spawnPuff(e.x, e.y, 1, ENEMY_ARCHETYPES.skeleton.tint);
        break;
      // chargeCrash / burrowDive / burrowErupt / bossVolley / webPlaced keep their juice
      // only: the wave-manifest tell watcher already sounds these exact edges
      // (charger.crash, burrower.submerge/erupt, marrow.stompImpact / choir.strikeImpact,
      // weaver.latticeFire) — the old repitched library doubles are gone.
      case "chargeCrash":
        {
          const giant = this.world.enemies.find((enemy) =>
            isGiantKind(enemy.kind) && Math.hypot(enemy.x - e.x, enemy.y - e.y) < 8);
          const color = giant?.kind === "pale" ? "#bfeaff" : "#c9a06a";
          const edge = giant?.kind === "pale" ? "#57b6ff" : "#ffd27a";
          this.spawnParticles(e.x, e.y, giant ? 18 : 10, color);
          this.spawnSparks(e.x, e.y, giant ? 10 : 6, 0);
          this.shockwaves.spawn(e.x, e.y, 10, giant ? 92 : 60, 0.3, edge, 3);
        }
        this.addTrauma(0.18);
        break;
      case "burrowDive":
        this.spawnPuff(e.x, e.y, 8, "#c9a06a");
        break;
      case "burrowErupt":
        this.spawnParticles(e.x, e.y, 14, "#c9a06a");
        this.spawnDustRing(e.x, e.y, e.r * 0.7, 10, "#c9a06a");
        this.shockwaves.spawn(e.x, e.y, 10, e.r * 1.4, 0.32, "#ffd27a", 3);
        this.addTrauma(0.14);
        break;
      case "bossVolley":
        this.spawnPuff(e.x, e.y, 6, "#dceef5");
        break;
      case "webPlaced":
        this.spawnPuff(e.x, e.y, 7, "#c98bff");
        this.addDecal(e.x, e.y, "#c98bff", e.r * 0.4, "ring");
        break;
      // ---- weapon effects (the effect wave) — manifest-first, legacy sample fallback ----
      case "wirePlanted":
        if (!waveAudio.cueAt("wirePlant", e.x, e.y)) this.sfxAt("parry", e.x, e.y, { rate: 1.5, gain: 0.4 });
        this.spawnPuff(e.tx, e.ty, 4, "#e8e05a");
        break;
      case "wireArmed":
        waveAudio.cueAt("wire.armed", e.x, e.y);
        this.spawnSparkFlash(e.x, e.y, "#e8e05a");
        break;
      case "wireExpired":
        waveAudio.cueAt("wire.expire", e.x, e.y);
        this.spawnPuff(e.x, e.y, 3, "#b8b04a");
        break;
      case "wireRefused":
        waveAudio.cueAt("wire.refuse", e.x, e.y);
        break;
      case "wireSnap": {
        if (!waveAudio.cueAt("wireSnap", e.x, e.y)) this.sfxAt("parry", e.x, e.y, { rate: 0.7, gain: 0.8 });
        const len = Math.hypot(e.tx - e.x, e.ty - e.y);
        this.remoteTracers.push({ x: e.x, y: e.y, angle: Math.atan2(e.ty - e.y, e.tx - e.x), life: 0.15, color: "#e8e05a", len, isArc: true });
        this.spawnSparks((e.x + e.tx) / 2, (e.y + e.ty) / 2, 8, Math.atan2(e.ty - e.y, e.tx - e.x) + HALF_PI);
        this.addTrauma(0.15);
        break;
      }
      case "haloFlare":
        if (!waveAudio.cueAt("haloFlare", e.x, e.y)) this.sfxAt("meleeSwing", e.x, e.y, { rate: 1.3, gain: 0.7 });
        {
          const strength = this.haloStrengthAt(e.x, e.y);
          this.shockwaves.spawn(
            e.x,
            e.y,
            12 - strength * 4,
            e.r,
            0.3 + strength * 0.1,
            "#d8f0e8",
            3 + strength * 2,
          );
        }
        break;
      case "sentryPlaced":
        if (!waveAudio.cueAt("sentryPlace", e.x, e.y)) this.sfxAt("chest", e.x, e.y, { rate: 1.4, gain: 0.5 });
        this.spawnPuff(e.x, e.y, 8, "#c8a8ff");
        this.addDecal(e.x, e.y, "#c8a8ff", 14, "ring");
        // The prism opens a beat after the mount lands (place -> unfold are two cues).
        this.pendingCues.push({ t: 0.22, name: "sentry.unfold", x: e.x, y: e.y });
        break;
      case "sentryAcquire":
        waveAudio.cueAt("sentry.acquire", e.x, e.y);
        break;
      case "sentryHit":
        waveAudio.cueAt("sentry.damaged", e.x, e.y);
        this.spawnPuff(e.x, e.y, 4, "#c8a8ff");
        break;
      case "sentryShot": {
        if (!waveAudio.cueAt("sentryShot", e.x, e.y)) this.sfxAt("homing", e.x, e.y, { rate: 1.15, gain: 0.45 });
        this.spawnParticles(e.x + Math.cos(e.aim) * 14, e.y + Math.sin(e.aim) * 14, 2, "#c8a8ff");
        // Persist this shot's aim + fire time on the nearest sentry (the event carries the
        // turret's position, and sentries are static) so the barrel keeps tracking and the
        // recoil kick plays out even between the 20Hz shot events.
        this.recordSentryShot(e.x, e.y, e.aim);
        break;
      }
      case "sentryDown":
        // Destroyed shatters; a timeout powers down — the deployable's two endings.
        if (!waveAudio.cueAt(e.why === "timeout" ? "sentry.timeout" : "sentryDown", e.x, e.y)) {
          this.sfxAt("parry", e.x, e.y, { rate: 0.6, gain: 0.7 });
        }
        if (e.why === "timeout") this.spawnPuff(e.x, e.y, 6, "#c8a8ff");
        else { this.spawnGibs(e.x, e.y, 8, "#c8a8ff"); this.spawnPuff(e.x, e.y, 8, "#c8a8ff"); }
        break;
      // KIT ULTIMATES: the cast moment's juice. The persistent zone/dome ride the effs list
      // (rendered in renderGroundEffects/renderEffectEntities); these are the burst tells.
      case "ultOverdrive":
        if (this.isSelfPid(e.pid)) this.isUltCasting = true;
        this.spawnPuff(e.x, e.y, 12, "#ffd166");
        this.sfxAt("weapon", e.x, e.y, { rate: 1.25, gain: 0.6 });
        this.addTrauma(0.12);
        break;
      case "ultSanctuary":
        if (this.isSelfPid(e.pid)) this.isUltCasting = true;
        this.spawnPuff(e.x, e.y, 16, "#7fe6a8");
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          this.spawnParticles(e.x + Math.cos(a) * e.radius * 0.7, e.y + Math.sin(a) * e.radius * 0.7, 1, "#b8ffd0");
        }
        this.sfxAt("heart", e.x, e.y, { rate: 0.9, gain: 0.7 });
        break;
      case "ultAegis":
        if (this.isSelfPid(e.pid)) this.isUltCasting = true;
        this.spawnPuff(e.x, e.y, 14, "#bcd4ff");
        this.sfxAt("parry", e.x, e.y, { rate: 0.8, gain: 0.7 });
        this.addTrauma(0.1);
        break;
      case "ultPhase":
        if (this.isSelfPid(e.pid)) this.isUltCasting = true;
        this.spawnPuff(e.x, e.y, 16, "#a8e6ff");
        this.sfxAt("homing", e.x, e.y, { rate: 1.3, gain: 0.6 });
        this.addTrauma(0.14);
        break;
      // PVP WAVE 3 ARENA ULTS: one cast event for all four; `kind` picks the tell/VFX flavor. The
      // effects themselves (salvo hits, triage heal, shove KB, slip blink) ride state/playerHurt.
      case "ultArena": {
        this.devArenaUltEventsSeen++;
        if (this.isSelfPid(e.pid)) this.isUltCasting = true;
        const kind: ArenaUltKind = e.kind === "salvo" || e.kind === "triage"
          || e.kind === "shove" || e.kind === "slip"
          ? e.kind
          : "slip";
        this.arenaUltVfx.spawn(
          e.pid,
          kind,
          e.x,
          e.y,
          e.aim,
          e.tellTicks * FIXED_DT,
          this.shooterColorOf(e.pid),
          this.isSelfPid(e.pid),
        );
        this.sfxAt(e.kind === "triage" ? "heart" : e.kind === "shove" ? "parry" : "weapon", e.x, e.y, { rate: 1.2, gain: 0.6 });
        break;
      }
      case "tetherLatch": {
        // Whiff and latch are different sounds; the INVERTED latch adds the danger tell
        // (a heavy body is about to reel the wielder in).
        if (e.eid < 0) waveAudio.cueAt("crook.whiff", e.x, e.y);
        else if (!waveAudio.cueAt("tetherLatch", e.x, e.y)) this.sfxAt("ricochet", e.x, e.y, { rate: 0.8, gain: 0.6 });
        if (e.inv) waveAudio.cueAt("crook.dragged", e.x, e.y);
        const len = Math.hypot(e.tx - e.x, e.ty - e.y);
        this.remoteTracers.push({ x: e.x, y: e.y, angle: Math.atan2(e.ty - e.y, e.tx - e.x), life: e.eid >= 0 ? 0.14 : 0.1, color: "#c9b06a", len, isArc: true });
        if (e.eid >= 0) { triggerFlash(this.animForId(e.eid)); this.addTrauma(0.08); }
        break;
      }
      case "tetherHold":
        waveAudio.cueAt("crook.hold", e.x, e.y);
        break;
      case "grappleResolved": {
        const anchorLen = Math.hypot(e.tx - e.x, e.ty - e.y);
        this.remoteTracers.push({
          x: e.x, y: e.y, angle: Math.atan2(e.ty - e.y, e.tx - e.x),
          life: 0.24, color: "#d6c7a1", len: anchorLen, isArc: true,
        });
        const travelLen = Math.hypot(e.dx - e.x, e.dy - e.y);
        this.remoteTracers.push({
          x: e.x, y: e.y, angle: Math.atan2(e.dy - e.y, e.dx - e.x),
          life: 0.24, color: "#a8d7a0", len: travelLen,
        });
        this.spawnPuff(e.tx, e.ty, 5, "#d6c7a1");
        break;
      }
      case "blessingProc": {
        const eventId = blessingProcCue(e.item, e.phase);
        const isSelfOnlyCue = eventId === "melee.bladeWard";
        if (eventId !== undefined && (!isSelfOnlyCue || this.isSelfPid(e.pid))) {
          waveAudio.cueAt(eventId, e.x, e.y);
        }
        if (this.isSelfPid(e.pid)) {
          const item = itemById(e.item);
          if (item !== undefined) this.spawnWorldLabel(e.x, e.y, item.name, item.tint);
        }
        this.spawnPuff(e.x, e.y, 3, itemById(e.item)?.tint ?? "#e8e0c8");
        break;
      }
      case "reviveHandoff": {
        if (e.to.length > 0 && (this.isSelfPid(e.to) || this.isSelfPid(e.pid))) {
          this.spawnWorldLabel(e.x, e.y, e.isBoosted ? "SHARED ROPE" : "REVIVING", e.isBoosted ? "#a8d7a0" : "#8affc0");
        }
        break;
      }
      case "statusApplied":
        // The SHARED status library: apply cues ride per-entity cooldowns; DoT ticks
        // stay silent by contract (burnTick below carries visuals only).
        waveAudio.cueAt(STATUS_AUDIO[e.kind] ?? "status.chillApply", e.x, e.y, e.eid);
        break;
      case "frozeSolid":
        waveAudio.cueAt("status.freeze", e.x, e.y, e.eid);
        this.spawnSparkFlash(e.x, e.y, "#cdeaff");
        break;
      case "freezeBroke":
        waveAudio.cueAt("status.freezeBreak", e.x, e.y, e.eid);
        this.spawnPuff(e.x, e.y, 5, "#cdeaff");
        break;
      case "tetherSweep":
        if (!waveAudio.cueAt("tetherSweep", e.x, e.y)) sfx("heavySwing", { rate: 1.1 });
        this.shockwaves.spawn(e.x, e.y, 14, e.r * 1.3, 0.32, "#c9b06a", 4);
        this.addTrauma(0.2);
        this.addFreeze(0.04);
        break;
      case "bossSlam":
        {
          const giant = this.world.enemies.find((enemy) =>
            isGiantKind(enemy.kind) && Math.hypot(enemy.x - e.x, enemy.y - e.y) < 8);
          if (giant === undefined) this.sfxAt("enemyDeath", e.x, e.y, { rate: 0.5 });
          const bright = giant?.kind === "pale" ? "#bfeaff" : "#ffd27a";
          const body = giant?.kind === "pale" ? "#57b6ff" : "#ffb43b";
          const dust = giant?.kind === "pale" ? "#6b6f8a" : "#c9a06a";
          this.spawnParticles(e.x, e.y, giant ? 30 : 22, bright);
          this.spawnSparks(e.x, e.y, 12, 0);
          this.addDecal(e.x, e.y, body, BOSS_SLAM_RADIUS * 0.5, "splat");
          this.shockwaves.spawn(e.x, e.y, 20, BOSS_SLAM_RADIUS * 1.25, 0.42, bright, 6);
          this.spawnDustRing(e.x, e.y, BOSS_SLAM_RADIUS * 0.55, giant ? 20 : 14, dust);
        }
        this.addFreeze(FREEZE_HEAVY);
        this.addTrauma(TRAUMA_BOSS_SLAM);
        break;
      case "radialBurst":
        this.sfxAt("shootShotgun", e.x, e.y, { rate: 0.6, gain: 0.6 });
        this.addTrauma(0.2);
        this.spawnParticles(e.x, e.y, 12, "#c98bff");
        this.shockwaves.spawn(e.x, e.y, 12, 72, 0.3, "#c98bff", 3);
        break;
      case "bossAddSpawn":
        triggerRecoil(this.animForId(e.eid));
        if (e.spawned) {
          this.spawnParticles(e.mx, e.my, 8, "#a855f7");
          if (this.isNearCamera(e.x, e.y, FX_CAMERA_MARGIN_MAX)) { sfx("enemyHit", { gain: 0.5, rate: 0.6 }); this.addTrauma(TRAUMA_BOSS_SLAM); }
        }
        break;
      case "bossPhase": {
        triggerFlash(this.animForId(e.eid));
        const phaseKind = this.world.enemies.find((en) => en.id === e.eid)?.kind;
        if (!(phaseKind !== undefined && waveAudio.bossPhase(phaseKind, e.x, e.y, e.eid))) {
          this.sfxAt("bossSpawn", e.x, e.y);
        }
        const isPalePhase = phaseKind === "pale";
        this.addTrauma(TRAUMA_BOSS_FLOOR);
        this.shockwaves.spawn(e.x, e.y, 30, 190, 0.55, isPalePhase ? "#bfeaff" : "#ffb43b", 4);
        this.flashScreen(isPalePhase ? 87 : 255, isPalePhase ? 182 : 180, isPalePhase ? 255 : 59, 0.12, 2.8);
        break;
      }
      case "bossTransition":
        // Telemetry-bearing beat (enter/exit + queued overflow); the juice rides bossPhase.
        break;
      case "enemySpawn": {
        const tint = ENEMY_ARCHETYPES[e.kind].tint;
        this.spawnPuff(e.x, e.y, 8, tint);
        // A miniboss captain announces itself on its bespoke entrance row; the
        // caskbellows plants on its anchor cue; everyone else keeps the spawn tick.
        if (waveAudio.bossEntrance(e.kind, e.x, e.y, e.eid)) break;
        const placeCue = e.kind === "caskbellows" ? bestiaryCue(e.kind, "place") : null;
        if (placeCue !== null && waveAudio.cueAt(placeCue, e.x, e.y, e.eid)) break;
        if (this.isNearCamera(e.x, e.y, FX_CAMERA_MARGIN_MAX)) sfx("enemyHit", { gain: 0.4, rate: 0.7 });
        break;
      }
      case "descend":
        sfx("descend");
        this.addTrauma(TRAUMA_DESCEND);
        // WAVE 1 amber earn fact: a descend means the floor just left was CLEARED (the exit
        // only opens on clear). The server pays per cleared floor from this authoritative count.
        this.runFloorsCleared++;
        // Bank the reached depth immediately (progressive, idempotent) so a run that later
        // ends by disconnect/quit — never a clean full-party-wipe game over — still records
        // the deepest floor on the leaderboard. Fires in every mode for the local player.
        this.onFloorReached(e.toFloor);
        // Online, the structural floor load is driven by the authoritative world rebuild
        // (consumeWorldRebuilt in tick) — the event only carries the juice. Solo/co-op load here.
        if (this.mode !== "online") {
          this.loadFloorClient();
          this.showFloorEntryBanner(this.floor, {
            isBoss: isBossFloor(this.floor),
            isGauntlet: isGauntletFloor(this.floor),
            isDescend: true,
          });
        }
        break;
      case "reachExit":
        if (this.coop && this.pendingDescend !== e.toFloor) { this.pendingDescend = e.toFloor; this.coop.requestDescend(e.toFloor); }
        break;
      case "revive":
        // Authoritative (online) revive: the server brought a downed player back. The revived
        // player's own client replays the juice (wsTransport only forwards its own pid events).
        waveAudio.reviveComplete(e.pid); // channel loop ends; the manifest duck frames the sting
        sfx("revive");
        this.spawnParticles(e.x, e.y, 14, "#8affe0");
        this.shockwaves.spawn(e.x, e.y, 8, 46, 0.4, "#8affe0", 3);
        break;
      case "gameOver":
        this.gameOver();
        break;
      case "pvpShieldBreak": {
        const isSelf = this.isSelfPid(e.pid);
        this.spawnParticles(e.x, e.y, isSelf ? 14 : 8, "#f5e6c8");
        this.shockwaves.spawn(e.x, e.y, 22, isSelf ? 38 : 32, 0.22, "#ffd27a", isSelf ? 3 : 2);
        if (isSelf) this.addTrauma(0.08);
        break;
      }
      case "pvpSpawnAttackBlocked":
        if (this.isSelfPid(e.pid)) {
          const mx = e.x + Math.cos(this.aimAngle) * 18;
          const my = e.y + Math.sin(this.aimAngle) * 18;
          this.shockwaves.spawn(mx, my, 5, 13, 0.14, "#ffd27a", 2);
          sfx("uiClick", { gain: 0.08, rate: 0.75 });
        }
        break;
      case "pvpKill":
        // Fires to EVERY client — branch on the LOCAL player id (never "play frag on every
        // kill"): your kill = FRAG, your death = DEATH (both non-spatial), any other = a quiet
        // SPATIAL distant thud, hard rate-limited by the cue's own 300ms cooldown.
        this.playPvpKillCue(e);
        break;
      case "pvpRingOut":
        this.playPvpKillCue(e);
        this.spawnWorldLabel(e.x, e.y - 38, "RING OUT", "#ff7a4f");
        this.spawnParticles(e.x, e.y, 18, "#ff5a4f");
        this.shockwaves.spawn(e.x, e.y, 10, 64, 0.42, "#ff7a4f", 4);
        if (this.isNearCamera(e.x, e.y)) this.addTrauma(0.2);
        break;
      case "pvpChainFrag":
        if (this.isSelfPid(e.by)) {
          const label = `CHAIN x${e.chain} \u00b7 +1 FRAG`;
          this.spawnWorldLabel(e.x, e.y - 54, label, "#ffd166");
          this.flashScreen(255, 209, 102, 0.12, 2.6);
          this.addTrauma(0.24);
          waveAudio.play("pvp.frag", { rate: pvpFragStreakRate(e.chain - 1) });
        } else {
          this.spawnWorldLabel(e.x, e.y - 48, `CHAIN x${e.chain}`, "#ffb43b");
        }
        break;
      case "pvpSuddenDeath":
        waveAudio.play("pvp.fight", { rate: 1.12 });
        this.flashScreen(255, 90, 74, 0.14, 2.2);
        this.addTrauma(0.16);
        this.hud.showBanner("SUDDEN DEATH");
        break;
      case "pvpDraftTriggered":
      case "pvpDraftOffered":
      case "pvpDraftPicked":
      case "pvpDraftResolved":
      case "pvpDraftDelayed":
        break;
      case "pvpMatchOver":
        // Reliable, id-tagged (never lost): the winner hears the victory sting, everyone else
        // the light defeat cue. The ph->"over" observer edge is intentionally NOT a second
        // trigger, so the result never double-sounds.
        waveAudio.play(pvpMatchOverCue(this.isSelfPid(e.winner)));
        break;
      case "flash":
        triggerFlash(this.animForId(e.eid));
        break;
      case "puff":
        if (this.isArena && e.n === 6 && e.color === "#cfe6ff") {
          this.arenaUltVfx.cutShove(e.x, e.y, true, this.onArenaUltMoment);
        }
        this.spawnPuff(e.x, e.y, e.n, e.color);
        break;
      case "trauma":
        this.addTrauma(e.amount);
        break;
      case "cue": {
        // Manifest ids on the cue channel route to the wave layer (its own attenuation +
        // off-camera law — boss locks must stay audible); legacy names keep the near-camera
        // gate and exact SfxName replay.
        const isWaveCue = waveAudio.cueAt(e.name, e.x, e.y);
        if (this.isNearCamera(e.x, e.y, FX_CAMERA_MARGIN_MAX)) {
          if (!isWaveCue) sfx(e.name as SfxName, { rate: e.rate, gain: e.gain });
          if (e.trauma > 0) this.addTrauma(e.trauma);
        }
        break;
      }
    }
  }

  // Look up the client anim for an enemy id (creating it if the enemy is still around).
  private animForId(eid: number): Anim {
    let a = this.enemyAnims.get(eid);
    if (!a) { a = createAnim(); this.enemyAnims.set(eid, a); }
    return a;
  }
  private animForPropId(id: number): Anim {
    let a = this.propAnims.get(id);
    if (!a) { a = createAnim(); this.propAnims.set(id, a); }
    return a;
  }

  private spawnEmberAt(x: number, y: number, radius: number) {
    this.pushParticle({
      x: x + (Math.random() * 2 - 1) * radius * 0.6,
      y: y + (Math.random() * 2 - 1) * radius * 0.5,
      vx: (Math.random() * 2 - 1) * 24, vy: -40 - Math.random() * 50,
      life: 0.3 + Math.random() * 0.25, maxLife: 0.55,
      color: Math.random() < 0.5 ? BURN_TINT : "#ffd27a",
      size: 2 + Math.random() * 2, kind: "puff", rot: 0, vr: 0, gravity: -40, drag: 0.9,
    });
  }

  private queueHaloImpact(
    puffX: number,
    puffY: number,
    dmgX: number,
    dmgY: number,
    dmg: number,
    color: string,
    isCrit: boolean,
  ): boolean {
    const scale = this.haloImpactCount < FX_BURST_FULL
      ? 1
      : this.haloImpactCount < FX_BURST_HALF ? 0.5 : 0.25;
    this.haloImpactCount++;
    this.burstFreeze = Math.max(this.burstFreeze, FREEZE_KILL);
    this.haloImpactTrauma = Math.min(
      HALO_IMPACT_TRAUMA_CAP,
      this.haloImpactTrauma + MELEE_HIT_TRAUMA * scale,
    );
    if (this.haloImpactSampleCount >= HALO_IMPACT_SAMPLES || !this.isNearCamera(puffX, puffY)) return false;
    const index = this.haloImpactSampleCount++;
    this.haloImpactPuffX[index] = puffX;
    this.haloImpactPuffY[index] = puffY;
    this.haloImpactDmgX[index] = dmgX;
    this.haloImpactDmgY[index] = dmgY;
    this.haloImpactDmg[index] = dmg;
    this.haloImpactCrit[index] = isCrit ? 1 : 0;
    this.haloImpactColor[index] = color;
    return true;
  }

  private isHaloImpactPoint(x: number, y: number): boolean {
    for (let i = 0; i < this.haloBurstBlades; i++) {
      const angle = this.haloBurstAngle + (i / this.haloBurstBlades) * Math.PI * 2;
      const dx = x - (this.haloBurstX + Math.cos(angle) * this.haloBurstRing);
      const dy = y - (this.haloBurstY + Math.sin(angle) * this.haloBurstRing);
      if (dx * dx + dy * dy <= 16) return true;
    }
    return false;
  }

  private flushHaloImpacts(): void {
    this.burstTrauma += this.haloImpactTrauma;
    for (let i = 0; i < this.haloImpactSampleCount; i++) {
      const isCrit = this.haloImpactCrit[i] === 1;
      const scale = this.burstScale();
      const puffX = this.haloImpactPuffX[i];
      const puffY = this.haloImpactPuffY[i];
      const color = this.haloImpactColor[i];
      this.spawnDmgNumber(this.haloImpactDmgX[i], this.haloImpactDmgY[i], this.haloImpactDmg[i], { crit: isCrit });
      this.spawnPuff(puffX, puffY, Math.max(1, Math.round((isCrit ? 9 : 5) * scale)), color);
      const dir = Math.atan2(puffY - this.py, puffX - this.px);
      this.spawnSparks(
        puffX,
        puffY,
        Math.max(1, Math.round((isCrit ? 10 : 6) * scale)),
        dir,
        isCrit ? 1.125 : 0.9,
        isCrit ? "#fff3c4" : undefined,
        1,
      );
      this.spawnSparkFlash(puffX, puffY, "#fff3c4");
      if (isCrit) this.spawnSparkFlash(puffX, puffY, "#fff3c4");
    }
  }

  private meleeImpactWeaponFor(eid: number, hitX: number, hitY: number): WeaponId | null {
    let isLocalBladeHit = false;
    const localHits = this.meleeSwing?.hitList;
    if (this.animClock <= this.meleeImpactUntil) {
      if (localHits) {
        for (const enemy of localHits) {
          if (typeof enemy !== "number" && enemy.id === eid) {
            isLocalBladeHit = true;
            break;
          }
        }
      } else {
        const expectedX = this.px + Math.cos(this.meleeImpactAim) * this.meleeImpactPuffDist;
        const expectedY = this.py + Math.sin(this.meleeImpactAim) * this.meleeImpactPuffDist;
        const dx = hitX - expectedX;
        const dy = hitY - expectedY;
        isLocalBladeHit = dx * dx + dy * dy <= 24 * 24;
      }
    }
    return isLocalBladeHit ? this.meleeImpactWeapon : null;
  }

  // Melee connect: metal-on-flesh weight. Sparks fly out along the strike line from the
  // player through the contact point, a bright flash pops at the blade, and the per-weapon
  // hit-stop/trauma land the blow. Striking an enemy MID-ATTACK (windup/active) reads as a
  // clash — the parry CLANG, a white flash, and a longer stop — rewarding aggressive timing.
  private replayMeleeImpact(
    eid: number,
    hitX: number,
    hitY: number,
    isCrit: boolean,
    weapon: WeaponId | null,
  ): WeaponId | null {
    const feel = weapon === null ? undefined : MELEE_FEEL[weapon];
    this.burstTrauma = Math.min(1, this.burstTrauma + (feel?.hitTrauma ?? MELEE_HIT_TRAUMA));
    this.burstFreeze = Math.max(this.burstFreeze, feel?.hitFreeze ?? FREEZE_KILL);
    const dir = Math.atan2(hitY - this.py, hitX - this.px);
    const bladeColor = weapon === null ? "#fff3c4" : WEAPONS[weapon].color;
    const sparkCount = (feel?.impactSparks ?? 6) + (isCrit ? 4 : 0);
    const sparkFan = (feel?.sparkFan ?? 0.9) * (isCrit ? 1.25 : 1);
    this.spawnSparks(hitX, hitY, sparkCount, dir, sparkFan, isCrit ? bladeColor : undefined, feel?.sparkSpeed ?? 1);
    this.spawnSparkFlash(hitX, hitY, bladeColor);
    if (feel && feel.impactKick > this.burstKick) {
      this.burstKick = feel.impactKick;
      this.burstKickDir = dir;
    }
    if (feel?.isHeavy && this.isNearCamera(hitX, hitY)) {
      const frameBurst = this.meleeShockwaveCount < FX_BURST_FULL
        ? 1
        : this.meleeShockwaveCount < FX_BURST_HALF ? 0.5 : 0.25;
      this.meleeShockwaveX += hitX;
      this.meleeShockwaveY += hitY;
      this.meleeShockwaveCount++;
      this.meleeShockwaveScale = Math.min(this.meleeShockwaveScale, this.burstScale(), frameBurst);
      this.meleeShockwaveColor = bladeColor;
    }
    const target = this.enemies.find((en) => en.id === eid);
    const isClash = target !== undefined && (target.attack.phase === "windup" || target.attack.phase === "active") && target.attack.move !== "none";
    if (isClash) {
      sfx("parry", { gain: 0.85 });
      this.spawnSparkFlash(hitX, hitY, "#ffffff");
      this.burstFreeze = Math.max(this.burstFreeze, MELEE_CLASH_FREEZE);
      this.burstTrauma = Math.min(1, this.burstTrauma + 0.08);
    }
    return weapon;
  }

  // Kind-flavored death burst layered over the shared gib/splat kill juice, so each enemy
  // dies in its own material: goo, bone, wing-dust, wisps, spray — and the boss goes out
  // with rings and a golden screen wash.
  private replayDeathBurst(kind: EnemyKind, x: number, y: number) {
    switch (kind) {
      case "slime":
        this.spawnPuff(x, y, 12, ENEMY_ARCHETYPES.slime.tint);
        break;
      case "skeleton":
        this.spawnGibs(x, y, 8, "#e8e4d8");
        break;
      case "bat":
        this.spawnParticles(x, y, 6, "#6f7a99");
        break;
      case "ghost":
        this.spawnWisps(x, y, 7, "#dff4ff");
        break;
      case "spitter":
        this.spawnPuff(x, y, 9, "#ff9ab8");
        break;
      case "charger":
        this.spawnGibs(x, y, 7, ENEMY_ARCHETYPES.charger.tint);
        this.spawnSparks(x, y, 5, 0);
        break;
      case "burrower":
        this.spawnPuff(x, y, 10, ENEMY_ARCHETYPES.burrower.tint);
        this.spawnDustRing(x, y, 26, 8, "#c9a06a");
        break;
      case "orbiter":
        this.spawnWisps(x, y, 5, ENEMY_ARCHETYPES.orbiter.tint);
        this.spawnSparks(x, y, 4, 0);
        break;
      case "shielder":
        this.spawnGibs(x, y, 8, "#cfe0d4");
        this.spawnSparks(x, y, 6, 0);
        break;
      case "boss":
        this.flashScreen(255, 214, 120, 0.4, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#ffd27a", 5);
        this.shockwaves.spawn(x, y, 12, 260, 0.8, "#ffb43b", 3);
        this.spawnSparkleBurst(x, y, 26, "#ffd27a");
        break;
      case "marrow":
        this.screenFlash.flash(191, 216, 224, 0.4, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#dceef5", 5);
        this.shockwaves.spawn(x, y, 12, 260, 0.8, "#bfd8e0", 3);
        this.spawnGibs(x, y, 14, "#e8e4d8");
        this.spawnSparkleBurst(x, y, 26, "#dceef5");
        break;
      case "choir":
        this.screenFlash.flash(191, 233, 255, 0.35, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#bfe9ff", 5);
        this.spawnWisps(x, y, 18, "#dff4ff");
        this.spawnSparkleBurst(x, y, 22, "#bfe9ff");
        break;
      case "weaver":
        this.screenFlash.flash(201, 139, 255, 0.35, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#c98bff", 5);
        this.spawnGibs(x, y, 12, "#c98bff");
        this.spawnSparkleBurst(x, y, 22, "#e0c8ff");
        break;
      case "gilded":
        this.screenFlash.flash(255, 209, 102, 0.45, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#ffd166", 5);
        this.shockwaves.spawn(x, y, 12, 260, 0.8, "#ffb43b", 3);
        this.spawnGibs(x, y, 14, "#ffe6a0");
        this.spawnSparkleBurst(x, y, 30, "#ffd166");
        break;
    }
  }

  // Best guess at what just hurt the player, for the directional hurt hint: the nearest
  // enemy bullet (projectile hits), else the nearest living enemy (contact damage).
  // Pure world-state reads — no RNG, nothing mutated.
  private findThreatDir(): number | null {
    let bestX = 0, bestY = 0;
    let bestD = 130 * 130;
    let isFound = false;
    for (const b of this.bullets) {
      if (b.friendly) continue;
      const d = (b.x - this.px) ** 2 + (b.y - this.py) ** 2;
      if (d < bestD) { bestD = d; bestX = b.x; bestY = b.y; isFound = true; }
    }
    if (!isFound) {
      bestD = 170 * 170;
      for (const en of this.enemies) {
        if (en.dead) continue;
        const d = (en.x - this.px) ** 2 + (en.y - this.py) ** 2;
        if (d < bestD) { bestD = d; bestX = en.x; bestY = en.y; isFound = true; }
      }
    }
    return isFound ? Math.atan2(bestY - this.py, bestX - this.px) : null;
  }

  private replayPropBreak(kind: PropKind, x: number, y: number) {
    switch (kind) {
      case "crate":
        this.spawnGibs(x, y, 10, "#b07a3c");
        this.spawnPuff(x, y, 6, "#c9a06a");
        this.sfxAt("barrel", x, y, { rate: 1.4, gain: 0.6 });
        break;
      case "pot":
        this.spawnPuff(x, y, 10, "#8fb8d6");
        this.spawnGibs(x, y, 5, "#9c6b4a");
        this.sfxAt("barrel", x, y, { rate: 1.8, gain: 0.45 });
        break;
      case "barrel":
        this.spawnGibs(x, y, 10, "#8a5a2c");
        this.spawnPuff(x, y, 6, "#b07a3c");
        this.sfxAt("barrel", x, y, { rate: 1.1, gain: 0.7 });
        break;
      case "root_wall":
        this.spawnGibs(x, y, 8, "#86c06c");
        this.spawnPuff(x, y, 6, "#5f8f4c");
        this.sfxAt("barrel", x, y, { rate: 0.9, gain: 0.6 });
        break;
      case "silt_mound":
        this.spawnPuff(x, y, 10, "#b8a888");
        this.sfxAt("dash", x, y, { rate: 0.6, gain: 0.5 });
        break;
      case "clinker_brick":
        this.spawnGibs(x, y, 8, "#c9743f");
        this.spawnPuff(x, y, 5, "#8a4a2c");
        this.sfxAt("barrel", x, y, { rate: 1.2, gain: 0.6 });
        break;
      default:
        break;
    }
    // Biome-flavored debris: a thin accent haze rides every break, so smashed cover
    // kicks up spores in the Hollow, ember dust in Emberreach, void light in the Null.
    if (kind !== "barrel_explosive") this.spawnPuff(x, y, 3, this.currentBiome.accent);
  }

  // Present three blessings and freeze until the player picks one (per client; items are
  // purely local run-stat modifiers). A duplicate choice reads as its Lv2/Lv3 upgrade.
  // The pick resolves through chooseBlessingInWorld, which applies the item AND clears the
  // sim's pending-offer state (releasing the descend gate the exit is holding).
  private offerBlessing(rare = false) {
    const owned = this.p.ownedItemIds;
    if (this.isArena) {
      const rng = new Rng(pvpDraftSeed(this.world.seed, this.p.id, this.p.pvpDraftTick, this.p.pvpDraftOrdinal));
      const choices = rollPvpDraftChoicesWith(
        PVP.draftChoices,
        () => rng.next(),
        owned,
        { tierBump: this.p.pvpDraftTierBump },
      );
      if (choices.length === 0) { dismissBlessingOfferInWorld(this.world, this.p.id); return; }
      this.showLocalBlessingChoices(choices);
      return;
    }
    const choices = rollBlessingChoicesInWorld(this.world, LOCAL_ID, rare);
    if (choices.length === 0) { dismissBlessingOfferInWorld(this.world, LOCAL_ID); return; }
    this.showLocalBlessingChoices(choices);
  }

  private showLocalBlessingChoices(choices: ItemDef[]): void {
    this.isChoosing = true;
    this.isPaused = false;
    this.input.releaseAll();
    this.syncInputContext();
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      const events = chooseBlessingInWorld(this.world, this.p.id, item);
      if (events.length > 0) this.ownedItemDefs.push(item);
      this.handleSimEvents(events);
      this.isChoosing = false;
      this.input.releaseAll();
      this.syncInputContext();
      this.resetFrameTiming(performance.now());
    }, { isDraft: this.isArena });
  }

  // The pick moment's sound: a fresh blessing chimes; a duplicate pick IS its Lv2/Lv3
  // upgrade, so it gets the bigger level-up fanfare. Levels are read pre-apply.
  private playBlessingPickSfx(item: ItemDef) {
    const level = (itemLevelsOf(this.p.ownedItemIds).get(item.id) ?? 0) + 1;
    sfx(level >= 2 ? "levelup" : "blessing");
  }

  // Online: show the SERVER's decided blessing choice set (already validated pool) and reply with
  // the authoritative choice — the answer echoes the offer id so the server validates it against
  // exactly that offer, applies the mods, and reflects them via SelfWire; this client never
  // mutates its own run stats. Choices arrive as item ids we resolve to defs.
  private offerServerBlessing(offer: {
    id: number;
    choices: string[];
    k: "blessing" | "pvp_draft";
    tr: "none" | "frag" | "time" | "dedup";
    isComeback: boolean;
  }) {
    const choices = offer.choices
      .map((id) => itemById(id))
      .filter((item): item is ItemDef =>
        item !== undefined && (!this.isArena || isPvpBlessingId(item.id))
      );
    if (choices.length === 0 || !this.wsTransport) return;
    this.isChoosing = true;
    this.isPaused = false;
    this.input.releaseAll();
    this.choosingSinceTick = this.wsTransport.getLatestSnapshot()?.tick ?? 0;
    this.syncInputContext();
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      this.wsTransport?.sendChooseBlessing(offer.id, item.id);
      this.isChoosing = false;
      this.input.releaseAll();
      this.syncInputContext();
      this.resetFrameTiming(performance.now());
    }, { isDraft: offer.k === "pvp_draft" });
  }

  // Card view of a choice set: each card shows the level the pick WOULD reach (an owned
  // blessing offered again is its upgrade) and that level's effect text.
  private toBlessingCards(choices: ItemDef[]) {
    const levels = itemLevelsOf(this.p.ownedItemIds);
    return choices.map((item) => ({ item, nextLevel: (levels.get(item.id) ?? 0) + 1 }));
  }

  private dashCooldown(): number {
    return PLAYER.dashCooldown * this.mods.dashCdMult;
  }

  private comboTier(): ComboTier {
    return comboTierFor(this.combo);
  }

  private isFrozen(e: Enemy): boolean {
    return e.kind !== "boss" && e.chill >= FREEZE_AT;
  }

  // ---- inventory action handlers ----
  // Reached ONLY through the context-gated InputController (keyboard keys, wheel, and the
  // hotbar UI all dispatch GameActions into it), so context legality lives in one place.
  // These bodies keep just the structural rules, and route through the ONE transport seam:
  // solo/co-op apply through the validated sim mutators in LocalTransport; online sends
  // the authoritative command and the snapshot confirms — there is NO client-local
  // inventory mutation on the online path.

  // Equip the weapon in hotbar slot `index` (number keys 1..MAX_OWNED_WEAPONS via the
  // selectWeapon action).
  private equipSlot(index: number) {
    const owned = this.p.ownedWeapons;
    if (index < 0 || index >= owned.length) return;
    this.transport.requestEquip(owned[index]);
  }

  // Hotbar activation (tap/click/Enter/Space): an unequipped slot equips; the already-
  // equipped slot opens its stat drawer instead — weapon info is never hover-only, so
  // touch and keyboard users reach it too. Number keys keep pure-equip semantics. The
  // drawer's DROP button re-enters the controller as a dropWeapon action (context is
  // re-synced after the drawer closes, so it passes the same gate as the Q key).
  private activateSlot(index: number) {
    const owned = this.p.ownedWeapons;
    if (index < 0 || index >= owned.length) return;
    if (owned[index] !== this.weapon) { this.transport.requestEquip(owned[index]); return; }
    this.inspectSlot(index);
  }

  // Open a slot's stat drawer without equipping — the touch long-press path, and where an
  // already-equipped activation lands. The drawer renders the SAME WeaponDisplayStats the
  // hotbar tooltip does (one live mod-adjusted source, so the surfaces can never drift);
  // DROP is offered only on the equipped weapon (Q semantics), never the final weapon.
  private inspectSlot(index: number) {
    const owned = this.p.ownedWeapons;
    if (index < 0 || index >= owned.length) return;
    const id = owned[index];
    this.hud.openWeaponDrawer({
      id,
      name: WEAPONS[id].name,
      stats: weaponDisplayStats(id, this.mods, lowHpFrac(this.hp, this.maxHp)),
      onDrop: id === this.weapon && owned.length > 1
        ? () => { this.syncInputContext(); this.input.dispatch({ kind: "dropWeapon" }); }
        : null,
    });
  }

  // Move hotbar slot `from` to position `to` (hotbar drag/drop). The number keys always map to
  // the resulting order, because they index the same authoritative ownedWeapons array.
  private reorderSlots(from: number, to: number) {
    const n = this.p.ownedWeapons.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    this.transport.requestReorder(from, to);
  }

  // Drop the currently equipped weapon into the world (Q / drawer DROP). The final weapon
  // never drops; the authority (sim or server) additionally rejects downed/pending/terminal
  // states server-side even if a tampered client bypasses the context gate.
  private dropEquippedWeapon() {
    if (this.p.ownedWeapons.length < 2) return;
    this.transport.requestDrop(this.weapon);
  }

  // Drop the weapon in hotbar slot `index` (the drag-out-to-discard gesture). Routes through
  // the SAME server-authoritative dropWeaponInWorld path Q uses — named by weapon id, so the
  // authority drops that exact slot's weapon (never equip-then-drop). The final weapon never
  // drops; the sim/server re-checks fullness/downed/terminal even if a client bypasses this.
  private dropWeaponAt(index: number) {
    const owned = this.p.ownedWeapons;
    if (owned.length < 2 || index < 0 || index >= owned.length) return;
    this.transport.requestDrop(owned[index]);
  }

  private cycleWeapon(dir: number) {
    const owned = this.p.ownedWeapons;
    if (owned.length < 2) return;
    const cur = owned.indexOf(this.weapon);
    this.equipSlot((cur + dir + owned.length) % owned.length);
  }

  // A weapon pickup the local player already owns: the sim never collects or swaps it in
  // (it stays physical for an ally — the WEAPONS/PROGRESSION duplicate rule), so it can
  // only ever wear the OWNED affordance, never be claimed. Boss/mystery pickups keep their
  // own claim rules (an owned boss choice still rerolls), so they are never owned-dupes.
  private isOwnedDuplicateWeapon(p: Pickup): boolean {
    return p.kind === "weapon" && !!p.weapon && !p.isMystery && !p.isBossChoice
      && this.p.ownedWeapons.includes(p.weapon);
  }

  // ---- the full-hotbar swap prompt ----

  // The blocked weapon pickup underfoot: the nearest live weapon pickup within collect
  // range that this player could claim if the hotbar had room (the sim's updatePickups
  // refused it because it doesn't). Pure client affordance — the same predicate the sim
  // gates collection with, so the prompt appears exactly when a walk-over silently
  // wouldn't collect.
  private blockedWeaponPickup(): Pickup | null {
    if (!this.isRunning || this.isChoosing || this.isDown || this.hp <= 0) return null;
    const p = this.p;
    if (p.ownedWeapons.length < MAX_OWNED_WEAPONS + p.extraWeaponSlots) return null;
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const k of this.pickups) {
      if (k.kind !== "weapon" || !k.weapon) continue;
      if (k.isBossChoice ? p.hasClaimedBossChoice : p.ownedWeapons.includes(k.weapon)) continue;
      const d = Math.hypot(this.px - k.x, this.py - k.y);
      if (d < p.pr + k.radius && d < bestD) { best = k; bestD = d; }
    }
    return best;
  }

  // Refresh the swap prompt target each tick: standing on a blocked pickup arms it,
  // walking away disarms it AND clears any decline (coming back re-offers the trade).
  private tickSwapPrompt() {
    const blocked = this.blockedWeaponPickup();
    if (blocked === null) {
      this.swapTarget = null;
      this.swapDismissedId = null;
      return;
    }
    this.swapTarget = blocked.id === this.swapDismissedId ? null : { pickupId: blocked.id, weapon: blocked.weapon! };
  }

  // Trade the weapon in hotbar slot `index` for the prompt's pickup. Authority decides:
  // the sim validates fullness/ownership/range and performs the trade atomically (the
  // replaced weapon lands as a floor pickup); a stale prompt is a rejected command.
  private swapSlot(index: number) {
    const target = this.swapTarget;
    if (target === null) return;
    const owned = this.p.ownedWeapons;
    if (index < 0 || index >= owned.length) return;
    this.transport.requestSwap(target.pickupId, owned[index]);
  }

  // Decline the swap prompt (LEAVE IT / Esc): nothing is sent — the pickup simply stays
  // on the floor (cancel-safe by construction) and the prompt stays down until the player
  // walks off it. Returns whether a prompt was actually dismissed (the Escape cascade).
  private dismissSwapPrompt(): boolean {
    if (this.swapTarget === null) return false;
    this.swapDismissedId = this.swapTarget.pickupId;
    this.swapTarget = null;
    return true;
  }

  private handleInteractPress() {
    if (this.contextualAction()?.action === "revive") return;
    if (this.swapTarget !== null) {
      this.swapSlot(this.p.ownedWeapons.indexOf(this.weapon));
      return;
    }
    this.openFocusedShopStation();
  }





  // ---- in-run item mods ----
















  private spawnSparkFlash(x: number, y: number, color: string) {
    // A single bright sprite spark that pops and fades where a ricochet round hits a wall.
    const life = 0.16;
    this.pushParticle({
      x, y, vx: 0, vy: 0,
      life, maxLife: life, color,
      size: 22, kind: "sparkfx", rot: Math.random() * 6.28, vr: 0, gravity: 0, drag: 1,
    });
  }


  // ---- elemental status effects ----




























  // ---- shared attack helpers ----














  // Plays a positional sfx only when the source is on/near the local screen, so a
  // teammate's distant fight never spams the local mix.
  private sfxAt(name: SfxName, x: number, y: number, opts?: SfxOptions) {
    if (this.isNearCamera(x, y, FX_CAMERA_MARGIN_MAX)) sfx(name, opts);
  }

  // A positional sfx that never strobes: at most one play of `key` per `minGapTicks` sim
  // ticks (many simultaneous impacts in one tick collapse to one voice). Keyed on the sim
  // tick so it stays deterministic (never the wall-clock animClock). Used for the
  // high-frequency world impacts (bullet-on-wall, prop chew, floor-hazard contact) so a 4p
  // firefight peppering a wall reads as one tick, not a machine-gun of clicks.
  private lastCueTick = new Map<string, number>();
  private sfxAtThrottled(name: SfxName, x: number, y: number, key: string, minGapTicks: number, opts?: SfxOptions) {
    if (!this.isNearCamera(x, y, FX_CAMERA_MARGIN_MAX)) return;
    const now = this.world.tick;
    const last = this.lastCueTick.get(key);
    if (last !== undefined && now - last < minGapTicks) return;
    this.lastCueTick.set(key, now);
    sfx(name, opts);
  }

  // The party color of a networked teammate (their verified colorIndex), neutral if unknown.
  private remoteColorOf(pid: PlayerId): string {
    const r = this.remotes().find((x) => x.playerId === pid);
    return playerColorOr(r ? r.colorIndex : null);
  }

  // The player color of whoever fired — the local player's chosen tint or a teammate's.
  private shooterColorOf(pid: PlayerId): string {
    return this.isSelfPid(pid) ? playerColorOr(this.selfColorIndex) : this.remoteColorOf(pid);
  }













  // Floating damage number: a visual-only popup that rises off an enemy and fades. Never
  // affects logic. Capped so a big tesla chain / flamethrower spray can't flood the array.
  private spawnDmgNumber(x: number, y: number, dmg: number, opts?: { crit?: boolean; color?: string }) {
    const value = Math.max(1, Math.round(dmg));
    const crit = opts?.crit ?? false;
    if (this.dmgNumbers.length >= 60) this.dmgNumbers.shift(); // drop oldest under flood
    this.dmgNumbers.push({
      x: x + (Math.random() * 2 - 1) * 8,
      y: y - 8,
      vy: crit ? -46 : -38,
      life: crit ? 0.8 : 0.65, maxLife: crit ? 0.8 : 0.65,
      value, crit,
      color: opts?.color ?? (crit ? "#fff3c4" : "#ffe9c0"),
    });
  }

  private updateDmgNumbers(dt: number) {
    for (const n of this.dmgNumbers) {
      n.y += n.vy * dt;
      n.vy *= 0.9;      // ease the rise so it settles as it fades
      n.life -= dt;
    }
    if (this.dmgNumbers.some((n) => n.life <= 0)) {
      this.dmgNumbers = this.dmgNumbers.filter((n) => n.life > 0);
    }
  }

  private spawnWorldLabel(x: number, y: number, text: string, color: string) {
    if (this.worldLabels.length >= 12) this.worldLabels.shift();
    this.worldLabels.push({ x, y, vy: -22, life: 1.1, maxLife: 1.1, text, color });
  }

  private updateWorldLabels(dt: number) {
    for (const l of this.worldLabels) {
      l.y += l.vy * dt;
      l.vy *= 0.9;
      l.life -= dt;
    }
    if (this.worldLabels.some((l) => l.life <= 0)) {
      this.worldLabels = this.worldLabels.filter((l) => l.life > 0);
    }
  }

  // The local player collected a coin: launch a token that arcs from the pickup up into the
  // top-left wallet counter. Cheap + pooled (hard cap) and COALESCED — many coins landing on
  // one tick spawn ONE token, not one per coin — so a chest dump reads as a satisfying scoop,
  // never a swarm. The counter itself pops when the token lands (see updateCoinFlies).
  private spawnCoinFly(x: number, y: number) {
    if (this.coinFlySpawnTick === this.world.tick) return; // one per tick (burst -> a few)
    if (this.coinFlies.length >= COIN_FLY_MAX) return;
    this.coinFlySpawnTick = this.world.tick;
    this.coinFlies.push({ x, y, t: 0 });
  }

  private updateCoinFlies(dt: number) {
    if (this.coinFlies.length === 0) return;
    let landed = false;
    for (const c of this.coinFlies) {
      c.t += dt / COIN_FLY_DUR;
      if (c.t >= 1) landed = true;
    }
    if (landed) {
      this.coinFlies = this.coinFlies.filter((c) => c.t < 1);
      this.hud.pulseCoins(); // the wallet ticks up with a quick pop as the coin lands
    }
  }

  // Remember where THIS step's combat happened, on screen, as the origin the next charge mote
  // flies FROM (cosmetic — the mote's AMOUNT rides the authoritative ultCharge delta, so it can
  // never disagree with the meter). Off-screen combat is skipped; the self-source fallback (the
  // player's body) covers the time-floor / dash / heal / damage-taken trickle.
  private captureUltMoteOrigin(x: number, y: number, source: UltMoteSource): void {
    if (!isRealKit(this.p.kitId)) return;
    if (!this.isNearCamera(x, y, FX_CAMERA_MARGIN_MAX)) return;
    this.ultMoteOrigin = { x, y, source };
  }

  private isBossEid(eid: number): boolean {
    for (const enemy of this.world.enemies) {
      if (enemy.id === eid) return isBossKind(enemy.kind);
    }
    return false;
  }

  // Drive the client-side ult legibility layer once per client step: advance the flying motes +
  // the one-time ready nudge, then feed the tracker the SAME authoritative charge the meter shows
  // and play back whatever cues it derives (motes / the loud READY / the cast spend).
  private tickUltCue(dt: number) {
    const isMoteLanded = this.updateUltMotes(dt);
    if (this.ultReadyNudge !== null) {
      this.ultReadyNudge.t += dt;
      if (this.ultReadyNudge.t >= ULT_READY_NUDGE_SECONDS) this.ultReadyNudge = null;
    }
    const isCasting = this.isUltCasting;
    this.isUltCasting = false;
    const origin = this.ultMoteOrigin ?? { x: this.px, y: this.py, source: "dmg" as const };
    this.ultMoteOrigin = null;
    const ult = this.ultHud();
    if (ult === null) { this.ultCue.reset(this.p.ultCharge); this.ultChargePulsePrev = this.p.ultCharge; return; }
    // During the post-cast lockout the bar shows the cooldown REFILL, not the charge fill, so a
    // mote landing on its "leading edge" would misread — suppress motes there (charge still
    // accrues authoritatively; motes resume the moment the meter is charging again).
    const isLockout = ult.cd > 0 && !ult.isReady;
    const cues = this.ultCue.feed({ charge: this.p.ultCharge, isReady: ult.isReady, isCasting, origin, dt });
    for (const c of cues) {
      // Only discrete COMBAT charge (a kill / boss hit) flies a mote from the enemy; self-sourced
      // charge would stream nonstop from the body, so it drives only the throttled meter pulse.
      if (c.t === "ultMote") { if (!isLockout && isFlyingMoteSource(c.source)) this.spawnUltMote(c.x, c.y, c.amount, c.source); }
      else if (c.t === "ultReady") this.onUltReady(ult.name);
      // ultCast: the meter collapsing to empty + the 8s lockout refill render straight off
      // HudState.cd, and the cast BURST rides the authoritative ult* event FX — nothing here.
    }
    // Passive (self-sourced) charge still has to read on the meter now that its motes are gone:
    // pulse the fill on any authoritative charge increase, throttled and never doubled with a
    // combat mote that landed this step (that path already pulsed).
    this.ultChargePulseClock = isMoteLanded ? 0 : this.ultChargePulseClock + dt;
    const chargeDelta = this.p.ultCharge - this.ultChargePulsePrev;
    this.ultChargePulsePrev = this.p.ultCharge;
    if (isPassiveMeterPulse(chargeDelta, this.ultChargePulseClock, isMoteLanded, isLockout)) {
      this.hud.pulseUlt();
      this.ultChargePulseClock = 0;
    }
  }

  private spawnUltMote(x: number, y: number, amount: number, source: UltMoteSource) {
    if (this.ultMotes.length >= ULT_MOTE_MAX) return;
    // size maps off the accrued charge (fixed-point meter units): a trash kill is small, an
    // elite/boss or a coalesced crowd burst is bigger. Clamped so one huge accrual never balloons.
    const size = Math.max(2.5, Math.min(6.5, 2.5 + Math.sqrt(Math.max(0, amount)) / 6));
    this.ultMotes.push({ x, y, t: 0, size, source });
  }

  private updateUltMotes(dt: number): boolean {
    if (this.ultMotes.length === 0) return false;
    let landed = false;
    for (const m of this.ultMotes) { m.t += dt / ULT_MOTE_DUR; if (m.t >= 1) landed = true; }
    if (landed) {
      this.ultMotes = this.ultMotes.filter((m) => m.t < 1);
      this.hud.pulseUlt();                       // the fill pulses as charge lands
      sfx("uiClick", { gain: 0.16, rate: 1.5 }); // a soft tick (coalesced: one per landing frame)
    }
    return landed;
  }

  // The loud READY moment: a soft amber flash (amber is the universal "you can act now"
  // reinforcement, per the meter contract) + the FIRST-time-per-run world nudge so a new player
  // learns what F does.
  private onUltReady(name: string) {
    sfx("levelup", { gain: 0.5 });
    this.flashScreen(255, 180, 59, 0.09, 2.2);
    this.hud.pulseUlt(); // the charge->ready "snap to solid + flash" on the (now solid) bar
    if (!this.hasShownUltReadyNudge) {
      this.hasShownUltReadyNudge = true;
      this.ultReadyNudge = { verb: `${name.toUpperCase()} READY`, t: 0 };
    }
  }

  private updateParticles(dt: number) {
    // Advance + drop-dead in ONE in-place compaction pass (live particles slide to the front,
    // the tail is truncated). The old filter() re-allocated the whole array every frame — with
    // a dense FX weapon (Oddsmaker blasts push the pool into the hundreds) that was steady GC
    // churn on the hot path. This reuses the array, so a busy screen no longer feeds the GC.
    const arr = this.particles;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.gravity !== 0) p.vy += p.gravity * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      if (p.vr !== 0) p.rot += p.vr * dt;
      p.life -= dt;
      if (p.life > 0) { if (w !== i) arr[w] = p; w++; }
    }
    arr.length = w;
  }

  private updateDecals(dt: number) {
    for (const d of this.decals) d.t += dt;
    this.decals = this.decals.filter((d) => d.t < d.life);
  }

  private updateAfterimages(dt: number) {
    if (this.afterimages.length === 0) return;
    for (const a of this.afterimages) a.t += dt / AFTERIMAGE_DUR;
    this.afterimages = this.afterimages.filter((a) => a.t < 1);
  }

  private updateTracers(dt: number) {
    for (const tr of this.remoteTracers) tr.life -= dt;
    this.remoteTracers = this.remoteTracers.filter((tr) => tr.life > 0);
  }

  private updateCorpses(dt: number) {
    for (const c of this.corpses) c.t += dt / c.dur;
    this.corpses = this.corpses.filter((c) => c.t < 1);
  }

  // Advance every teammate's client-side cosmetics from whichever remote source is active
  // (legacy co-op presence OR the authoritative server): walk/idle anim + the remote dash FX.
  private updateRemoteAnims(dt: number) {
    const remotes = this.remotes();
    if (remotes.length === 0 && this.remoteAnims.size === 0) return;
    for (const r of remotes) {
      this.arenaUltVfx.syncRemotePosition(r.playerId, r.x, r.y);
      let entry = this.remoteAnims.get(r.playerId);
      if (!entry) { entry = { anim: createAnim(), lastX: r.x, lastY: r.y, isDashing: false, dashImgCd: 0, dashDustCd: 0 }; this.remoteAnims.set(r.playerId, entry); }
      const moving = Math.hypot(r.x - entry.lastX, r.y - entry.lastY) > 0.35;
      const lean = r.x - entry.lastX;
      stepAnim(entry.anim, dt, moving, lean < 0 ? -1 : lean > 0 ? 1 : 0);
      entry.lastX = r.x; entry.lastY = r.y;
      this.updateRemoteDashFx(r, entry, dt);
    }
    if (this.remoteAnims.size > remotes.length) {
      const live = new Set<string>();
      for (const r of remotes) live.add(r.playerId);
      for (const id of this.remoteAnims.keys()) if (!live.has(id)) this.remoteAnims.delete(id);
    }
  }

  // A teammate's dash, driven off the authoritative PlayerWire dash state (isDashing is
  // aligned with the interpolated pose, so the juice lands where the blob visibly lunges).
  // The SAME reads as the local dash: takeoff puff + ring + sfx on the rising edge, then the
  // afterimage ghost trail and one dust mote per authoritative tick while the dash is live.
  // The dasher's own dashStart/dashTrail events stay pid-scoped, so nothing double-plays.
  private updateRemoteDashFx(r: RemotePlayer, entry: RemoteAnimEntry, dt: number) {
    if (r.isDashing && !entry.isDashing && !r.isAbsent) {
      this.spawnParticles(r.x, r.y, 10, "#ffd27a");
      this.addDecal(r.x, r.y, "#ffd27a", 16, "ring");
      sfx("dash", { gain: 0.5 });
      entry.dashImgCd = 0;
      entry.dashDustCd = 0;
    }
    entry.isDashing = r.isDashing && !r.isAbsent;
    if (!entry.isDashing) return;
    entry.dashImgCd -= dt;
    if (entry.dashImgCd <= 0) {
      this.afterimages.push({ x: r.x, y: r.y, facing: r.facing, t: 0, color: playerColorOr(r.colorIndex), base: heroBodySprite(r.hat) });
      entry.dashImgCd = 0.04;
    }
    entry.dashDustCd -= dt;
    if (entry.dashDustCd <= 0) {
      this.spawnParticles(r.x, r.y, 1, "#ffd27a");
      entry.dashDustCd = FIXED_DT;
    }
  }




  private hasLivingTeammate(): boolean {
    if (!this.coop) return false;
    return this.coop.remotePlayers().some((r) => !r.isDown);
  }

  // ---- co-op networking ----

  private syncCoop(dt: number) {
    if (!this.coop) return;
    // Follow the room's shared floor (any teammate descending pulls us along). The sim
    // rebuilds the world + resets per-player floor state; the returned events drive the
    // client's cosmetic floor-load + blessing offer.
    const shared = this.coop.getFloor();
    if (shared > this.floor) {
      this.pendingDescend = 0;
      const ev: SimEvent[] = [];
      descend(this.world, shared, ev);
      this.handleSimEvents(ev);
    }

    // A teammate revived us.
    const revived = this.coop.consumeRevive();
    if (revived !== null && this.isDown) {
      this.p.isDown = false;
      this.p.hp = revived;
      this.p.invuln = REVIVE.invuln;
      this.spawnParticles(this.px, this.py, 20, "#8affc0");
      sfx("revive");
    }

    // If we're down and the last living teammate is gone, the run is over.
    if (this.isDown && !this.hasLivingTeammate()) { this.gameOver(); return; }

    this.handleRemoteShots();
    this.handleRemoteState();
    this.handleReviving(dt);
  }

  private handleRemoteShots() {
    if (!this.coop) return;
    for (const r of this.coop.remotePlayers()) {
      const seen = this.remoteShotSeen.get(r.playerId) ?? r.shotSeq;
      if (r.shotSeq > seen) {
        this.remoteTracers.push({ x: r.x, y: r.y, angle: r.aimAngle, life: 0.12, color: playerColorOr(r.colorIndex) });
        this.spawnParticles(r.x + Math.cos(r.aimAngle) * 18, r.y + Math.sin(r.aimAngle) * 18, 2, "#ffe6a0");
        const entry = this.remoteAnims.get(r.playerId);
        if (entry) triggerRecoil(entry.anim);
        if (this.isNearCamera(r.x, r.y, FX_CAMERA_MARGIN_MAX)
          && !waveAudio.weaponFired(r.weapon, { x: r.x, y: r.y, gain: 0.4, beamKey: r.playerId })) {
          sfx(SHOOT_SFX[r.weapon], { gain: 0.4 });
        }
      }
      this.remoteShotSeen.set(r.playerId, r.shotSeq);
    }
  }

  // A teammate going down nearby gets a hurt cue + red burst locally (gated to screen).
  private handleRemoteState() {
    if (!this.coop) return;
    const live = new Set<string>();
    for (const r of this.coop.remotePlayers()) {
      live.add(r.playerId);
      const wasDown = this.remoteDownSeen.get(r.playerId) ?? false;
      if (r.isDown && !wasDown && this.isNearCamera(r.x, r.y, FX_CAMERA_MARGIN_MAX)) {
        sfx("playerHurt", { gain: 0.6 });
        this.spawnParticles(r.x, r.y, 10, "#ff5a5a");
        this.addTrauma(TRAUMA_REMOTE_DOWN);
      }
      this.remoteDownSeen.set(r.playerId, r.isDown);
    }
    for (const id of [...this.remoteDownSeen.keys()]) if (!live.has(id)) this.remoteDownSeen.delete(id);
  }

  private handleReviving(dt: number) {
    if (!this.coop || this.isDown) return;
    const seen = new Set<string>();
    for (const r of this.coop.remotePlayers()) {
      if (!r.isDown) continue;
      if (Math.hypot(this.px - r.x, this.py - r.y) < effectiveReviveRadius(this.p)) {
        seen.add(r.playerId);
        const held = (this.reviveHold.get(r.playerId) ?? 0) + dt * effectiveReviveRate(this.p);
        this.reviveHold.set(r.playerId, held);
        this.spawnParticles(r.x, r.y, 1, "#8affc0");
        if (held >= REVIVE.channel) {
          this.coop.requestRevive(r.playerId);
          this.reviveHold.set(r.playerId, -2); // debounce until the row flips
        }
      }
    }
    for (const id of [...this.reviveHold.keys()]) if (!seen.has(id)) this.reviveHold.delete(id);
  }

  private publishPresence() {
    if (!this.coop) return;
    const state: LocalPlayerState = {
      x: this.px, y: this.py, facing: this.facing,
      hp: this.hp, maxHp: this.maxHp, weapon: this.weapon,
      floor: this.floor, isDown: this.isDown, aimAngle: this.aimAngle,
      shotSeq: this.shotSeq, kills: this.kills,
    };
    this.coop.publish(state);
  }

  private updateHud() {
    this.tickSwapPrompt();
    // The interact nudge tracks its live target every tick (item 6) — never a static corner
    // element. Recomputed here from the same contextualAction() logic and drawn world-anchored.
    this.interactPrompt = this.computeInteractPrompt();
    const boss = this.enemies.find((e) => isBossKind(e.kind));
    const isBossActive = boss !== undefined;
    const bossHpFrac = boss ? Math.max(0, boss.hp / boss.maxHp) : 0;
    // TL co-op status strip: ONLINE ONLY (UI Director hierarchy) — the authoritative
    // shared world is the one place the party status is load-bearing mid-run. The verified
    // world-id echo + per-member connected/reconnecting readiness readout belong to the
    // Sev-0 coherence system (PR #39); until it lands this keeps the plain lobby label,
    // and integration swaps in its authoritative roster line.
    let coopLabel: string | null = null;
    if (this.coop) {
      const count = this.coop.remotePlayers().length + 1;
      coopLabel = `CO-OP \u00b7 ${this.coop.roomCode} \u00b7 ${count} player${count === 1 ? "" : "s"}`;
    } else if (this.mode === "online" && this.wsTransport) {
      // The UI contract's normal HUD: CONNECTED · ROOM CODE · N PLAYERS (server-roster
      // truth; away members appended explicitly). World/rev/protocol debug details live in
      // the hold-Tab panel, not here.
      const phase: OnlinePhase = this.wsTransport.getReconnectInfo().isReconnecting ? "reconnecting"
        : !this.wsTransport.isReady() ? "connecting"
          : this.isWorldRevealed ? "connected" : "waiting";
      const roster = this.wsTransport.getWorldRoster();
      const connected = roster.filter((r) => r.st === "on").length;
      const selfId = this.wsTransport.getSelfServerId();
      coopLabel = onlineHudLabel({
        phase,
        roomCode: this.online?.roomCode ?? null,
        worldId: this.wsTransport.getWorldId(),
        connected,
        away: roster.length - connected,
        isArena: this.isArena,
        // Teammates still deciding a pick — the visible reason a cleared floor isn't
        // descending yet (own overlay covers the self case).
        waitingPicks: this.isArena
          ? 0
          : this.wsTransport.getPartyWait().filter((w) => w.pid !== selfId).length,
      });
    }
    const comboTier = this.comboTier();
    this.hud.update({
      hp: this.hp, maxHp: this.maxHp,
      floor: this.floor, kills: this.kills, coins: this.coins,
      // The active floor mutators (the "why this floor feels different" readout). Read from the
      // authoritative descriptor the world holds (online: reconstructed from SnapWire.pcl).
      mutators: mutatorLabels(this.world.floorDescriptor.mutators),
      // Live per-weapon cards ride each slot (mods + low-HP scalers via the sim's own
      // helper) so hover tooltips always show what a trigger pull would actually do.
      weapons: this.p.ownedWeapons.map((id) => ({
        id, name: WEAPONS[id].name, isCurrent: id === this.weapon,
        card: weaponDisplayStats(id, this.mods, lowHpFrac(this.hp, this.maxHp)),
      })),
      weaponCap: MAX_OWNED_WEAPONS + this.p.extraWeaponSlots,
      swap: this.swapTarget ? { id: this.swapTarget.weapon, name: WEAPONS[this.swapTarget.weapon].name } : null,
      // Online floors use the authoritative global cleared flag (enemies may be interest-filtered
      // out of this client's snapshot, so a local count can't decide "cleared").
      isCleared: this.isCurrentFloorCleared(),
      enemiesLeft: this.enemies.length,
      isObjectiveHidden: !this.isArena && this.isSandbox,
      isParty: !this.isArena && this.mode !== "solo" && this.remotes().length > 0,
      isBossActive: !this.isArena && isBossActive,
      bossHpFrac,
      bossName: boss && !this.isDevBossNameHidden ? bossDisplayName(boss.kind) : "",
      coopLabel,
      dashFill: 1 - this.dashCd / this.dashCooldown(),
      combo: this.combo,
      comboMult: comboTier.mult,
      comboColor: comboTier.color,
      comboFrac: this.comboTimer / COMBO_WINDOW,
      items: this.collapsedItems(),
      // One coordination slot: an open blessing gate outranks exit staging (picks always
      // resolve before the descend, so the messages can never both apply).
      waitLabel: this.isArena ? null : this.blessingWaitLabel() ?? this.exitWaitLabel(),
      encounter: this.encounterHud(),
      party: this.partyHud(),
      ult: this.ultHud(),
      sig: this.sigHud(),
      isArena: this.isArena,
      arenaMatch: this.arenaMatchHud(),
    });
  }

  // The local player's Wave 2 SIGNATURE readouts (null for a neutral kit). Each block is null
  // unless the local player is that kit, so the HUD only ever draws the one that applies. Pure
  // reads off authoritative state (momentum stacks / overheat window / overshield pool / pulse
  // cooldown) — the sim owns every value; this only renders it.
  private sigHud(): HudState["sig"] {
    const p = this.p;
    if (!isRealKit(p.kitId)) return null;
    const tick = this.kitHudTick();
    return {
      momentum: p.kitId === "gunner"
        ? { stacks: Math.round(p.passiveState), max: MOMENTUM.maxStacks, isOverheat: p.overheatT > 0 }
        : null,
      overshield: p.kitId === "bulwark"
        ? { chips: p.overshield, max: OVERSHIELD.maxChips }
        : null,
      pulse: p.kitId === "mender"
        ? { cd: Math.max(0, Math.min(1, (p.pulseReadyAtTick - tick) / HEAL_PULSE.cooldownTicks)), isReady: tick >= p.pulseReadyAtTick }
        : null,
    };
  }

  // Teammate HP for the party HUD (spec §6, the Mender dependency): the live nameplate rows.
  // Batch0: encounter progress for custom objective HUD. Arena returns null (boss bar wins).
  private encounterHud(): HudState["encounter"] {
    const enc = this.world.encounter;
    if (!enc || enc.kind === "none" || enc.kind === "arena") return null;
    return {
      kind: enc.kind,
      progress: enc.objectiveProgress,
      checkpoint: enc.checkpoint,
      carrierId: enc.carrierPlayerId,
      completed: enc.completed,
      mechanic: this.severBreakTarget(),
    };
  }

  // The live Sever break-target for the objective line, read straight off the authoritative
  // enemies (never encounter flags, which stay sim-internal and off the wire): the WORLDSPLIT
  // tooth (aux===1) out-ranks the intercept trap anchors (aux===0). null when nothing is up.
  private severBreakTarget(): "anchors" | "tooth" | null {
    let isAnchorLive = false;
    for (const e of this.world.enemies) {
      if (e.dead || e.kind !== "sever_anchor") continue;
      if (e.aux === 1) return "tooth";
      isAnchorLive = true;
    }
    return isAnchorLive ? "anchors" : null;
  }

  private partyHud(): HudState["party"] {
    if (this.mode === "solo" || this.isArena) return [];
    return this.remotes().map((r) => ({
      id: r.playerId, name: r.name, hp: r.hp, maxHp: r.maxHp,
      colorIndex: r.colorIndex, isDown: r.isDown, isAbsent: r.isAbsent,
    }));
  }

  // The authoritative clock for kit HUD readiness/cooldown readouts. Online, ready-at ticks
  // (ultReadyAtTick / pulseReadyAtTick) are reconciled as SERVER-ABSOLUTE ticks, but the local
  // render world's tick is never stepped against the server clock — so comparing them to
  // world.tick leaves every "readyAt" perpetually in the future (meter stuck empty / "8s"
  // lockout even after the server meter is full). The snapshot tick is that same server clock,
  // so kit readouts must read it online, exactly like localPvpProtectionState. Solo/co-op step
  // the world in-process, so world.tick is the authoritative clock there.
  private kitHudTick(): number {
    if (this.mode === "online" && this.wsTransport) {
      const snap = this.wsTransport.getLatestSnapshot();
      if (snap) return snap.tick;
    }
    return this.world.tick;
  }

  // The local player's ult meter readout (spec §3/§6). null for a neutral-kit player (the meter
  // is hidden). cd is the 8s lockout fraction still remaining after a cast.
  private ultHud(): HudState["ult"] {
    const p = this.p;
    if (!isRealKit(p.kitId)) return null;
    const tick = this.kitHudTick();
    const cd = Math.max(0, Math.min(1, (p.ultReadyAtTick - tick) / ULT.lockoutTicks));
    return {
      charge: p.ultCharge / ULT.meterMax,
      isReady: canCastUlt(p.ultCharge, tick, p.ultReadyAtTick),
      cd,
      kit: p.kitId,
      name: KIT_META[p.kitId].ult,
    };
  }

  // The SEMANTIC contextual action (UI Part4): what the interact input would do right now,
  // as data — action id + target + authoritative progress — never presentation. This is
  // the single source the HUD prompt derives from today and a controller pass maps to its
  // A-button glyph later; it rides the P0 input-context system (the `interact` sample/
  // press + context gates in src/game/input.ts) rather than any parallel input path.
  // Priority: the revive affordance (a living local player inside a revivable downed
  // teammate's ring — OUT bodies never prompt) outranks the shop affordance (a focused
  // station in Patch's room), so one E always means one thing.
  contextualAction(): { action: "revive"; targetName: string; progress: number | null; x: number; y: number } | { action: "shop"; label: string; x: number; y: number } | null {
    // A pick overlay pauses the player (sim-shielded, inputs idle) — there IS no
    // contextual action to offer under it.
    if (!this.isRunning || this.isChoosing || this.isDown || this.hp <= 0) return null;
    if (this.mode !== "solo" && !this.isSandbox) {
      let near: RemotePlayer | null = null;
      for (const r of this.remotes()) {
        if (!r.isDown || r.isOut) continue;
        if (Math.hypot(this.px - r.x, this.py - r.y) > effectiveReviveRadius(this.p)) continue;
        if (near === null || r.reviveProgress > near.reviveProgress) near = r;
      }
      if (near !== null) {
        const selfServerId = this.wsTransport?.getSelfServerId() ?? LOCAL_ID;
        const isChanneling = near.reviveProgress > 0
          && near.reviveBy === selfServerId
          && this.input.isInteractHeld;
        return {
          action: "revive",
          targetName: near.name,
          progress: isChanneling ? Math.min(1, near.reviveProgress / REVIVE.channel) : null,
          x: near.x, y: near.y,
        };
      }
    }
    if (!this.shopPanel.isOpen) {
      const slot = this.focusedShopSlot();
      if (slot !== null) {
        const stockedSlot = shopSlotForViewer(this.world.shop!, slot, this.p.id);
        return { action: "shop", label: shopSlotName(stockedSlot).toUpperCase(), x: slot.x, y: slot.y };
      }
    }
    return null;
  }

  // The ONE world-anchored interact nudge (UI-designer spec, item 6): recomputed every tick
  // from the SAME contextualAction() logic that fed the old bottom-left prompt, so it tracks
  // the live target as it moves. Exactly ONE nudge at a time, by priority REVIVE > PICKUP >
  // SHOP. The anchor y is the target CENTER minus a per-target up-offset; renderInteractPrompt
  // converts it to screen each frame. `verb` is short/uppercase; `progress` (revive hold only)
  // turns the chip into the in-place "REVIVING N%" read.
  private computeInteractPrompt(): { x: number; y: number; verb: string; progress: number | null } | null {
    const act = this.contextualAction();
    // REVIVE outranks everything.
    if (act !== null && act.action === "revive") {
      return { x: act.x, y: act.y - INTERACT_OFFSET_REVIVE, verb: "REVIVE", progress: act.progress };
    }
    // PICKUP (a full hotbar refused the walk-over collect) sits between revive and shop —
    // the nudge draws the eye to the weapon; the .hb-swap panel remains the trade detail.
    if (this.swapTarget !== null) {
      const pk = this.world.pickups.find((p) => p.id === this.swapTarget!.pickupId);
      if (pk) return { x: pk.x, y: pk.y - INTERACT_OFFSET_PICKUP, verb: "SWAP", progress: null };
    }
    // SHOP is lowest (contextualAction only surfaces it when no revive is in range).
    if (act !== null && act.action === "shop") {
      return { x: act.x, y: act.y - INTERACT_OFFSET_SHOP, verb: "INSPECT", progress: null };
    }
    return null;
  }

  // ---- Patch's shop (client side) ----

  // The station the local player stands close enough to interact with (highlight, HUD
  // prompt, panel target). Pure affordance — the buy re-validates authoritatively.
  private focusedShopSlot(): ShopSlot | null {
    if (!this.isRunning || this.isDown || this.hp <= 0 || this.isChoosing) return null;
    return nearestShopSlot(this.world, this.px, this.py, SHOP_FOCUS_RANGE);
  }

  // The semantic interact PRESS resolved against the world: open the focused station's
  // compact panel. A revivable teammate in range owns E (the hold channel), so the shop
  // yields; away from every station the press does nothing. Stepping/touching never
  // reaches any purchase path — only the panel's BUY sends the buy command.
  private openFocusedShopStation() {
    const slot = this.focusedShopSlot();
    if (slot === null) return;
    this.shopPanel.open(
      this.shopPanelViewFor(slot),
      (slotId) => this.transport.requestShopBuy(slotId),
      () => this.syncInputContext(),
    );
    this.syncInputContext();
  }

  // Whether an event's pid is THIS client's player: online events carry server pids,
  // local/solo worlds key the local player as LOCAL_ID.
  private isSelfPid(pid: PlayerId): boolean {
    return this.mode === "online" && this.wsTransport
      ? pid === this.wsTransport.getSelfServerId()
      : pid === LOCAL_ID;
  }

  private shopPanelViewFor(slot: ShopSlot) {
    const shop = this.world.shop!;
    return shopPanelView(
      shop,
      shopSlotForViewer(shop, slot, this.p.id),
      this.shopViewer(),
      this.mods,
      this.floor,
      this.shopBoughtT > 0,
    );
  }

  // The local player's shop viewer with the client-side combat read (the authoritative
  // buy re-validates the same predicate server-side; near enemies are always inside the
  // interest view, so the reads agree).
  private shopViewer() {
    return shopViewerOf(this.p, isPlayerInCombat(this.world, this.p));
  }

  // Patch's-room upkeep, every tick: the handover pose timer, the one-time waystation
  // welcome label, and the open panel's honesty — it re-renders from authoritative state
  // (a teammate's claim flips it to SOLD mid-look) and closes when the world moves on
  // (floor changed, shop gone, buyer down, or the buyer displaced out of range).
  private tickShop(dt: number) {
    if (this.patchSellT > 0) this.patchSellT = Math.max(0, this.patchSellT - dt);
    if (this.shopBoughtT > 0) this.shopBoughtT = Math.max(0, this.shopBoughtT - dt);
    const shop = this.world.shop;
    if (this.shopPanel.isOpen) {
      const slot = shop?.slots.find((s) => s.id === this.shopPanel.slotId);
      if (!shop || slot === undefined || this.isDown || this.hp <= 0 || this.isChoosing
        || Math.hypot(this.px - slot.x, this.py - slot.y) > SHOP_FOCUS_RANGE * 1.5) {
        this.shopPanel.close();
      } else {
        this.shopPanel.update(this.shopPanelViewFor(slot));
      }
    }
    if (!shop || this.isShopWelcomed) return;
    const room = this.dungeon.rooms.find((r) => r.kind === "shop");
    if (!room) return;
    const tx = Math.floor(this.px / TILE), ty = Math.floor(this.py / TILE);
    if (tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h) {
      this.isShopWelcomed = true;
      // The stall names itself by MODE — the read arrives with the room (wire-agreed).
      if (shop.mode === "climax") {
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 36, "THE LAST STALL BEFORE THE CHOIR", "#ffb43b");
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 20, "SPEND IT ALL \u2014 COINS DIE WITH THE RUN", "#ffe9b0");
      } else if (shop.mode === "premium") {
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 36, "PATCH'S PREMIUM CACHE", "#ffb43b");
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 20, "ONE PREMIUM BUY PER SHOP \u2014 CHOOSE WELL", "#ffe9b0");
      } else if (shop.mode === "spoils") {
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 36, "THE SPOILS STALL", "#ffb43b");
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 20, "A BOSS'S PURSE BURNS A HOLE \u2014 SPEND IT", "#ffe9b0");
      } else {
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 36, "PATCH'S WAYSTATION", "#ffd166");
        // The multi-buy opener (playtest fix: kills the pick-one mental model on arrival).
        this.spawnWorldLabel(shop.keeperX, shop.keeperY - 20, "BUY FROM ANY STATION YOU CAN AFFORD", "#ffe9b0");
      }
      this.sfxAt("blessing", shop.keeperX, shop.keeperY, { gain: 0.3, rate: 1.15 });
    }
  }

  // The party blessing gate readout: which members still owe their pick (the descend holds
  // for them, authoritatively — snapshots carry the pending set). Null when nobody is owed
  // or when solo/classic (their gate is the local overlay itself). A pending member whose
  // connection dropped reads RECONNECTING (their offer survives the reconnect grace — the
  // coherence system, PR #39 — so "picking" would be a lie while they can't see the cards).
  private blessingWaitLabel(): string | null {
    if (this.isArena) return null;
    if (this.mode !== "online" || !this.wsTransport) return null;
    const pending = this.wsTransport.pendingPickWait();
    if (pending.length === 0) return null;
    const selfId = this.wsTransport.getSelfServerId();
    const others = pending.filter((p) => p.id !== selfId);
    if (others.length === 0) return null;
    const remotes = this.wsTransport.remotePlayers();
    const picking: string[] = [];
    const reconnecting: string[] = [];
    let secondsLeft = 0;
    for (const p of others) {
      const r = remotes.find((x) => x.playerId === p.id);
      const name = (r?.name ?? "teammate").toUpperCase();
      if (r !== undefined && isReconnectingTeammate(r)) reconnecting.push(name);
      else {
        picking.push(name);
        secondsLeft = Math.max(secondsLeft, p.secondsLeft);
      }
    }
    // UI Director copy: name who the party is waiting on, with the AUTHORITATIVE expiry
    // countdown (the sim's TTL riding every snapshot — never a client timer; the gate
    // unblocks only when a snapshot says the pending set drained). pnd is the union of
    // blessing picks and boss weapon claims, so "choose" covers both reward kinds.
    const parts: string[] = [];
    if (picking.length > 0) {
      const countdown = secondsLeft > 0 ? ` \u00b7 ${secondsLeft}s` : "";
      parts.push(`WAITING FOR ${picking.join(" \u00b7 ")} TO CHOOSE${countdown}`);
    }
    if (reconnecting.length > 0) parts.push(`${reconnecting.join(" \u00b7 ")} RECONNECTING\u2026`);
    return parts.join(" \u00b7 ");
  }

  // The party exit-coordination readout (UI Director copy: `2/3 READY TO GO DOWN` plus a
  // checklist of who is still missing WITH their distance to the stairs), mirroring the
  // authoritative descend gate exactly (the snapshot's exr IS playersAtExit). Shows only
  // while coordination is actually owed: a cleared party floor, somebody staged, somebody
  // required still missing. Downed members aren't required (the descend rescues them), and
  // neither are RECONNECTING members — the coherence system (PR #39) reserves their body
  // and excludes it from the gate on both sides, so the party never waits on a ghost.
  private exitWaitLabel(): string | null {
    if (this.isArena) return null;
    if (this.mode !== "online" || !this.wsTransport || !this.wsTransport.isFloorCleared()) return null;
    const remotes = this.wsTransport.remotePlayers();
    const presentLiving = remotes.filter((r) => !r.isDown && !isReconnectingTeammate(r));
    const required = presentLiving.length + (this.isDown ? 0 : 1);
    if (required <= 1) return null;
    const exr = this.wsTransport.exitReadyParty();
    if (exr.length === 0 || exr.length >= required) return null;
    const d = this.world.dungeon;
    const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
    const meters = (x: number, y: number): string => `${Math.max(1, Math.round(Math.hypot(x - ex, y - ey) / TILE))}m`;
    const selfId = this.wsTransport.getSelfServerId();
    const checklist: string[] = [];
    if (!this.isDown && (selfId === null || !exr.includes(selfId))) checklist.push(`YOU ${meters(this.px, this.py)}`);
    for (const r of presentLiving) {
      if (!exr.includes(r.playerId)) checklist.push(`${r.name.toUpperCase()} ${meters(r.x, r.y)}`);
    }
    const reconnecting = remotes.filter((r) => !r.isDown && isReconnectingTeammate(r)).map((r) => r.name.toUpperCase());
    const suffix = reconnecting.length > 0 ? ` \u00b7 ${reconnecting.join(" \u00b7 ")} RECONNECTING\u2026` : "";
    return `${exr.length}/${required} READY TO GO DOWN${checklist.length > 0 ? ` \u2014 ${checklist.join(" \u00b7 ")}` : ""}${suffix}`;
  }

  // The player's owned blessing defs from the authoritative source: online that is the server's
  // SelfWire item ids (never a local mirror); solo/co-op the locally-picked defs.
  private currentItemDefs(): ItemDef[] {
    if (this.mode === "online") {
      return this.p.ownedItemIds.map((id) => itemById(id)).filter((it): it is ItemDef => it !== undefined);
    }
    return this.ownedItemDefs;
  }

  // Collapse owned blessings by id into level-bearing entries (first-seen order), so the
  // HUD strip shows one icon slot per distinct blessing with level pips; desc tracks the
  // current level's effect and nextDesc the upgrade delta (null once maxed).
  private collapsedItems() {
    const collapsed = new Map<string, { id: string; name: string; desc: string; nextDesc: string | null; glyph: string; tint: string; rarity: string; count: number }>();
    for (const it of this.currentItemDefs()) {
      const seen = collapsed.get(it.id);
      if (seen) {
        seen.count++;
        seen.desc = itemDesc(it, seen.count);
        seen.nextDesc = seen.count < MAX_ITEM_LEVEL ? itemDesc(it, seen.count + 1) : null;
      } else {
        collapsed.set(it.id, { id: it.id, name: it.name, desc: itemDesc(it, 1), nextDesc: itemDesc(it, 2), glyph: it.glyph, tint: it.tint, rarity: it.rarity, count: 1 });
      }
    }
    return [...collapsed.values()];
  }

  private openStats() {
    let roster: Array<{ name: string; isYou: boolean; color: string; isDown: boolean; isOut: boolean; isAtExit: boolean; isReconnecting: boolean }> | null = null;
    if (this.coop) {
      roster = [
        { name: "you", isYou: true, color: playerColor(this.coop.selfColorIndex()), isDown: this.isDown, isOut: false, isAtExit: false, isReconnecting: false },
        ...this.coop.remotePlayers().map((r) => ({ name: r.name, isYou: false, color: playerColorOr(r.colorIndex), isDown: r.isDown, isOut: false, isAtExit: false, isReconnecting: false })),
      ];
    } else if (this.mode === "online" && this.wsTransport) {
      const exr = this.isArena ? [] : this.wsTransport.exitReadyParty();
      const selfId = this.wsTransport.getSelfServerId();
      const isSelfOut = this.wsTransport.getLatestSnapshot()?.self?.out === true;
      roster = [
        { name: "you", isYou: true, color: playerColor(this.selfColorIndex ?? 0), isDown: this.isDown, isOut: isSelfOut, isAtExit: selfId !== null && exr.includes(selfId), isReconnecting: false },
        ...this.wsTransport.remotePlayers().map((r) => ({
          name: r.name, isYou: false, color: playerColorOr(r.colorIndex), isDown: r.isDown, isOut: r.isOut,
          isAtExit: exr.includes(r.playerId), isReconnecting: isReconnectingTeammate(r),
        })),
      ];
    }
    this.hud.showStats({
      floor: this.floor, kills: this.kills, coins: this.coins,
      runTime: (performance.now() - this.runStart) / 1000,
      weaponName: WEAPONS[this.weapon].name,
      isArena: this.isArena,
      profile: this.isArena ? null : this.profile,
      roster,
      // The details panel owns the connection debug surface (world / rev / protocol).
      netInfo: this.mode === "online" && this.wsTransport
        ? netDetailsLine(this.wsTransport.getWorldId(), this.wsTransport.getLatestSnapshot()?.rev ?? null, PROTOCOL_VERSION)
        : null,
      items: this.collapsedItems().map((it) => ({ name: it.count > 1 ? `${it.name} Lv${it.count}` : it.name, desc: it.desc, glyph: it.glyph, tint: it.tint })),
    });
  }

  private gameOver() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.syncInputContext();
    cancelAnimationFrame(this.raf);
    // Terminal exit STOPS the transport: online this closes the socket and leaves the
    // authoritative world (no lingering post-run connection); solo LocalTransport.stop is a
    // no-op, so solo behavior is unchanged.
    this.transport.stop();
    audio.setMusic(null);
    waveAudio.reset();
    this.resetPvpAudioState();
    sfx("gameOver");
    this.hud.hideStats();
    this.hud.clear();
    this.hud.setVisible(false);
    this.onGameOver({
      floor: this.floor, kills: this.kills, coins: this.coins, durationMs: performance.now() - this.runStart,
      // Authoritative run facts — the server banks Amber from these. A game over is a wipe
      // ("death" → 50% of the run pool); the leftover-coin cache trickle + first-boss grants
      // ride along. Returning to camp (100%) lands with the walkable hub in wave 2.
      floorsCleared: this.runFloorsCleared,
      bossKills: [...this.runBossKills],
      isCacheArmed: this.p.isAmberCacheArmed,
      amberWindfall: this.p.amberWindfall,
      outcome: "death",
      build: {
        weapons: this.p.ownedWeapons.map((id) => ({ id, name: WEAPONS[id].name })),
        items: this.collapsedItems().map((it) => ({ id: it.id, name: it.name, glyph: it.glyph, tint: it.tint, count: it.count })),
      },
    });
  }

  // Online transport terminal states end the run cleanly instead of freezing the last frame.
  // The ONLY path that reads as a death is the server's own game-over close — a network
  // outage that exhausts the reconnect window is connection_lost (back to the lobby, the run
  // may still be live for friends), never a fabricated YOU DIED. Pre-reveal failures return
  // to the lobby with their explicit reason: no run happened. "reconnecting" is not terminal
  // — the freeze in tick() and the overlay own that state.
  private onOnlineStatus(s: "connecting" | "open" | "reconnecting" | "closed" | "error") {
    if (this.mode !== "online" || !this.isRunning || !this.wsTransport) return;
    if (s !== "closed" && s !== "error") return;
    const kind = this.wsTransport.getCloseKind();
    if (kind === "game_over" && this.wsTransport.isReady() && this.isWorldRevealed) { this.gameOver(); return; }
    const mismatch = this.wsTransport.getWorldMismatch();
    if (mismatch) { this.quitToMenu("world_mismatch", `expected ${mismatch.expected}, got ${mismatch.got}`); return; }
    switch (kind) {
      case "connection_lost": this.quitToMenu("connection_lost"); return;
      case "client_outdated": this.quitToMenu("client_outdated"); return;
      case "superseded": this.quitToMenu("superseded"); return;
      case "resume_rejected": this.quitToMenu("connection_lost", "resume rejected"); return;
      // The run ended while we were still behind the veil — nothing was played; regroup.
      case "game_over": this.quitToMenu("connection_lost", "the run ended before you got in"); return;
      case null: break;
    }
    // No classified cause (defensive): a dead mid-run socket is an OUTAGE, never a death.
    if (this.wsTransport.isReady() && this.isWorldRevealed) { this.quitToMenu("connection_lost"); return; }
    this.quitToMenu("connect_failed");
  }

  // True when a world point is on (or near) the visible screen — used to gate audio
  // and juice for far-off co-op events so a teammate across the map never spams us.
  private isNearCamera(x: number, y: number, margin?: number): boolean {
    const qualityRange = FX_CAMERA_MARGIN_MAX - FX_CAMERA_MARGIN_MIN;
    const qualityMargin = FX_CAMERA_MARGIN_MIN
      + qualityRange * ((this.fxQuality - FX_QUALITY_MIN) / (FX_QUALITY_MAX - FX_QUALITY_MIN));
    const effectiveMargin = margin ?? qualityMargin;
    return x >= this.cam.x - effectiveMargin && x <= this.cam.x + this.canvas.width + effectiveMargin
      && y >= this.cam.y - effectiveMargin && y <= this.cam.y + this.canvas.height + effectiveMargin;
  }

  // Every particle enters through here so the pool stays capped: when full, the oldest
  // particle yields to the newest — a busy screen softens instead of dropping frames.
  private pushParticle(p: Particle) {
    const cap = Math.max(1, Math.round(MAX_PARTICLES * this.fxQuality));
    if (this.particles.length >= cap) this.particles.splice(0, this.particles.length - cap + 1);
    this.particles.push(p);
  }

  private spawnParticles(x: number, y: number, n: number, color: string) {
    const count = Math.max(1, Math.round(n * this.fxQuality));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.28, s = 40 + Math.random() * 140;
      this.pushParticle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.4, maxLife: 0.7, color, size: 1 + Math.random() * 3, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.92 });
    }
  }

  // Celebration sparkles: bright flecks that leap upward and rain back down under gravity.
  // Every third one runs white-hot so the burst glitters instead of reading as one color.
  private spawnSparkleBurst(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
      const s = 110 + Math.random() * 190;
      const life = 0.45 + Math.random() * 0.4;
      this.pushParticle({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, color: i % 3 === 0 ? "#fff3c4" : color,
        size: 1.5 + Math.random() * 2, kind: "spark", rot: 0, vr: 0, gravity: 430, drag: 0.96,
      });
    }
  }

  // Ghostly wisps: soft flecks that float up and dissolve — a spirit coming apart.
  private spawnWisps(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const life = 0.5 + Math.random() * 0.5;
      this.pushParticle({
        x: x + (Math.random() * 2 - 1) * 12, y: y + (Math.random() * 2 - 1) * 8,
        vx: (Math.random() * 2 - 1) * 24, vy: -34 - Math.random() * 44,
        life, maxLife: life, color,
        size: 3 + Math.random() * 3, kind: "puff", rot: 0, vr: 0, gravity: -22, drag: 0.94,
      });
    }
  }

  // A ring of dust thrown outward from a ground impact (boss slam), slightly flattened
  // so it sits on the floor plane.
  private spawnDustRing(x: number, y: number, r: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + (Math.random() - 0.5) * 0.3;
      const s = 70 + Math.random() * 70;
      const life = 0.34 + Math.random() * 0.22;
      this.pushParticle({
        x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.6,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6,
        life, maxLife: life, color,
        size: 3 + Math.random() * 3.5, kind: "puff", rot: 0, vr: 0, gravity: -16, drag: 0.88,
      });
    }
  }

  // Wind/slash dust flung off a melee swing: particles seeded ALONG the swing arc (or the
  // thrust line for spears), each flying TANGENT to the sweep so they read as a gust of
  // wind trailing the blade. Cheap, additive to the slash VFX; tinted to the weapon.
  private spawnSlashWind(cx: number, cy: number, aim: number, m: { arc: number; reach: number; isThrust?: boolean }, color: string) {
    if (m.isThrust) {
      // Spear: streaks blown straight forward along the thrust line.
      const n = 7;
      for (let i = 0; i < n; i++) {
        const t = 0.35 + Math.random() * 0.65;
        const r = m.reach * t;
        const jitter = (Math.random() * 2 - 1) * 6;
        const px = cx + Math.cos(aim) * r - Math.sin(aim) * jitter;
        const py = cy + Math.sin(aim) * r + Math.cos(aim) * jitter;
        const sp = 120 + Math.random() * 120;
        this.pushParticle({ x: px, y: py, vx: Math.cos(aim) * sp, vy: Math.sin(aim) * sp, life: 0.14 + Math.random() * 0.14, maxLife: 0.28, color, size: 1 + Math.random() * 2.5, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.88 });
      }
      return;
    }
    // Sword/longsword: dust seeded across the arc, each blown along the sweep tangent.
    const n = Math.round(6 + m.arc * 6);
    for (let i = 0; i < n; i++) {
      const frac = Math.random();                       // 0..1 across the arc
      const ang = aim - m.arc / 2 + frac * m.arc;        // point on the arc
      const r = m.reach * (0.55 + Math.random() * 0.5);
      const px = cx + Math.cos(ang) * r;
      const py = cy + Math.sin(ang) * r;
      // Tangent to the sweep (perpendicular to the radius), in the swing's rotation sense.
      const tang = ang + Math.PI / 2;
      const sp = 90 + Math.random() * 130;
      this.pushParticle({ x: px, y: py, vx: Math.cos(tang) * sp, vy: Math.sin(tang) * sp, life: 0.16 + Math.random() * 0.16, maxLife: 0.32, color, size: 1 + Math.random() * 2.5, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.86 });
    }
  }

  // Chunky bits of the dead thing: fly out fast, tumble, fall, and fade a touch slower.
  private spawnGibs(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 90 + Math.random() * 210;
      const life = 0.45 + Math.random() * 0.5;
      this.pushParticle({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
        life, maxLife: life, color, size: 3 + Math.random() * 4, kind: "gib",
        rot: Math.random() * 6.28, vr: (Math.random() * 2 - 1) * 14, gravity: 560, drag: 0.9,
      });
    }
  }

  // Bright, short sparks that shoot back off a surface (wall impacts).
  private spawnSparks(x: number, y: number, n: number, angle: number, fan = 0.9, tint?: string, speedScale = 1) {
    const count = Math.max(1, Math.round(n * this.fxQuality));
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() * 2 - 1) * fan;
      const s = (160 + Math.random() * 220) * speedScale;
      const life = 0.12 + Math.random() * 0.16;
      this.pushParticle({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, color: tint === undefined
          ? (Math.random() < 0.5 ? "#fff3c4" : "#ffb43b")
          : (i % 3 === 0 ? "#ffffff" : tint),
        size: 1 + Math.random() * 2, kind: "spark", rot: 0, vr: 0, gravity: 120, drag: 0.86,
      });
    }
  }

  // The implosion's converging rays: sparks born ON the ring, flying INTO the center —
  // the visual inverse of an explosion, so the pull reads instantly.
  private spawnConvergence(x: number, y: number, r: number, color: string) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + Math.random() * 0.3;
      const d = r * (0.7 + Math.random() * 0.3);
      const life = 0.16 + Math.random() * 0.12;
      const speed = d / life;
      this.pushParticle({
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        vx: -Math.cos(a) * speed, vy: -Math.sin(a) * speed,
        life, maxLife: life, color: i % 3 === 0 ? "#fff3c4" : color,
        size: 1.5 + Math.random() * 2, kind: "spark", rot: 0, vr: 0, gravity: 0, drag: 1,
      });
    }
  }

  // Soft colored haze — a bullet biting into flesh.
  private spawnPuff(x: number, y: number, n: number, color: string) {
    const count = Math.max(1, Math.round(n * this.fxQuality));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.28, s = 20 + Math.random() * 80;
      const life = 0.2 + Math.random() * 0.3;
      this.pushParticle({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, color, size: 3 + Math.random() * 4, kind: "puff", rot: 0, vr: 0, gravity: -30, drag: 0.9,
      });
    }
  }

  // A single brass casing ejected sideways from the gun; tumbles and settles.
  private spawnShell(x: number, y: number, aim: number) {
    const side = Math.random() < 0.5 ? 1 : -1;
    const perp = aim + side * (Math.PI / 2) + (Math.random() * 2 - 1) * 0.3;
    const s = 70 + Math.random() * 70;
    const life = 0.5 + Math.random() * 0.3;
    this.pushParticle({
      x, y, vx: Math.cos(perp) * s, vy: Math.sin(perp) * s - 50,
      life, maxLife: life, color: "#d9a441", size: 3.5, kind: "shell",
      rot: Math.random() * 6.28, vr: (Math.random() * 2 - 1) * 18, gravity: 560, drag: 0.99,
    });
  }

  private addDecal(x: number, y: number, color: string, r: number, kind: "splat" | "ring") {
    if (this.fxQuality < 0.5) return;
    this.decals.push({ x, y, color, r, t: 0, life: kind === "ring" ? 0.4 : 3.2, kind });
    if (this.decals.length > MAX_DECALS) this.decals.shift();
  }

  // ---- rendering ----

  private render() {
    const { ctx, canvas } = this;
    if (this.isAwaitingOnlineWorld()) { this.renderConnectingVeil(); return; }
    this.flushMeleeShockwave();
    // Sample the camera on the render clock ONCE for the whole frame: the sim-rate `cam`
    // interpolated between its last two steps by the same alpha the player body uses. Every
    // world-space pass below (tiles, props, pickups, hazards, enemies, fx, player) subtracts
    // this single fractional value and nothing re-rounds it, so the whole scene translates
    // together — zero relative jitter as the camera pans, at any display refresh rate.
    // The lighting/AO grade subtracts the SAME renderCam, so the light field pans with
    // the smoothed world instead of stepping against it.
    {
      const a = this.hasRenderPrev ? this.renderAlpha : 1;
      this.renderCam.x = this.camPrevX + (this.cam.x - this.camPrevX) * a;
      this.renderCam.y = this.camPrevY + (this.cam.y - this.camPrevY) * a;
    }
    this.lighting.beginFrame(this.animClock);
    if (this.lighting.isEnabled) this.collectDynamicLights();
    ctx.fillStyle = this.currentBiome.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // trauma² shake, scaled by the player's intensity setting (zeroed under reduced
    // motion). New random offset per frame; the background fill above stays put so
    // edges never flash the void.
    const normalizedFxQuality = (this.fxQuality - FX_QUALITY_MIN) / (FX_QUALITY_MAX - FX_QUALITY_MIN);
    const shakeQuality = 0.6 + 0.4 * normalizedFxQuality;
    const mag = this.trauma * this.trauma * SHAKE_MAX_PX * settings.effectiveShake * shakeQuality;
    const shakeX = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    const shakeY = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    ctx.save();
    ctx.translate(shakeX + this.kickX, shakeY + this.kickY);
    this.renderTiles();
    if (this.isFlowDebug) this.renderFlowDebug();
    this.renderProps();
    this.renderDecals();
    this.renderFloorHazards(); // floor-level danger: over decals, under the ambient air + entities
    this.renderArenaHearth(); // PVP Wave 2: the contested-hearth marker (arena only, floor level)
    this.renderRingWeather(); // PVP Wave 2: the cinder_gust wind (director-only; tar/spark ride renderHazards)
    this.renderHazards(); // dynamic boss hazards (the Weaver's webs), over the floor layer
    this.renderGroundEffects(); // weapon ground effects (chill zones, snap wires) at floor level
    this.arenaUltVfx.renderGround(ctx, this.renderCam.x, this.renderCam.y, this.sprites);
    this.motes.render(ctx, this.renderCam.x, this.renderCam.y, this.fxQuality); // ambient biome air, over the floor, under entities
    this.renderExit();
    this.renderShadows();
    this.renderPropEntities();
    this.renderShop();
    this.renderChests();
    this.renderPickups();
    this.renderParticles();
    this.shockwaves.render(ctx, this.renderCam.x, this.renderCam.y);
    this.renderCorpses();
    this.renderEnemies();
    this.renderBullets();
    this.renderEffectEntities(); // weapon effect bodies (sentries, orbit blades, tether chains)
    this.renderChargeMarker();   // the local Breach hold: charge ring + landing marker
    this.renderGrapplePreview();
    this.renderSideChannelArmed();
    this.renderTracers();
    this.arenaUltVfx.renderWorld(
      ctx,
      this.renderCam.x,
      this.renderCam.y,
      this.sprites,
      settings.isReducedMotion,
    );
    this.renderRemotePlayers();
    this.renderDevPalePlayers();
    this.renderPets(); // client-side cosmetic companions (follow/sit; never a sim entity)
    this.renderAfterimages();
    this.renderHealBeam(); // MENDER Lifebloom tether (under the bodies) — see who you're healing
    this.renderMeleeSwing();
    this.renderPlayer();
    this.renderReviveRings();
    this.renderExitCoordination();
    this.renderMuzzle();
    this.renderDmgNumbers(); // world-space, on top of all entities but under the shake restore
    this.renderWorldLabels();
    this.renderInteractPrompt(); // world-anchored [E] chip over the interact target (item 6)
    this.renderUltReadyNudge();  // one-time "[F] <ULT> READY" chip over the player
    this.renderPetAbilityCue();  // PROTOCOL 45: pet ability cast cues over the player
    ctx.restore();
    this.renderBiomeVignette();
    this.screenFlash.render(ctx, canvas.width, canvas.height);
    this.renderHurtVignette();
    this.renderWarmthVignette();
    this.renderDownOverlay();
    this.renderSpectateBanner();
    this.renderReticle();
    this.renderCoinFlies();     // coins arcing into the top-left wallet
    this.renderUltMotes();      // charge motes arcing into the bottom-left ult meter
    this.renderMinimap();
    this.renderReconnectOverlay();
  }

  // Per-frame dynamic light sources, written into the lighting layer's fixed pool (no
  // allocation): the hero/teammate identity glows (occluded — a wall between you and the
  // next room keeps that room dark), the muzzle flash, luminous projectiles only, hazard
  // eruption pulses, and the cleared exit. Everything is derived from render-side state;
  // nothing here touches the sim.
  private collectDynamicLights() {
    const flash = settings.flashFactor;
    // Dense Dark (floor mutator, VISION): the run's sight radius contracts. A per-floor constant
    // read from the authoritative descriptor — fairness telegraphs draw on top and stay full-bright
    // (they are never dimmed), so a tighter glow costs readability of the room, never of a tell.
    const visionMult = floorVisionMult(this.world.floorDescriptor.mutators);
    if (this.isRunning && this.isWorldRevealed) {
      if (!this.isDown && !this.isArenaRespawning()) {
        // Wick PINPRICK (PROTOCOL 45): the owner-only light window bumps the hero glow by a flat
        // +radius while it is live. Reconnect-safe — petLightT rides SelfWire, never predicted.
        const pinprick = this.p.petLightT > 0 ? PET_ABILITY.pinprick.lightRadiusBonus : 0;
        this.lighting.pushDynamic(this.px, this.py, HERO_GLOW_RADIUS * visionMult + pinprick, HERO_GLOW_CUT, HERO_GLOW_COLOR, HERO_GLOW_STAIN, true);
      }
      for (const r of this.remotes()) {
        if (!r.isDown && !r.isAbsent && (!this.isArena || r.hp > 0) && this.isNearCamera(r.x, r.y, REMOTE_GLOW_RADIUS)) {
          this.lighting.pushDynamic(r.x, r.y, REMOTE_GLOW_RADIUS * visionMult, REMOTE_GLOW_CUT, HERO_GLOW_COLOR, REMOTE_GLOW_STAIN, true);
        }
      }
    }
    if (this.muzzle.t > 0 && flash > 0) {
      this.lighting.pushDynamic(this.muzzle.x, this.muzzle.y, MUZZLE_LIGHT_RADIUS, 0.55 * (this.muzzle.t / MUZZLE_DUR) * flash, this.muzzle.color);
    }
    for (const b of this.bullets) {
      if (!b.friendly || b.fx === undefined) continue;
      const light = BULLET_LIGHTS[b.fx];
      if (!light || !this.isNearCamera(b.x, b.y, light.radius)) continue;
      this.lighting.pushDynamic(b.x, b.y, light.radius, light.cut, b.color);
    }
    // Hazard eruptions: the vent brightens through its telegraph and blazes while
    // active; the rift's open maw deepens its wrong-colored resting light. Both stain
    // the ground in their own hue — light IS the pressure tell (spec §5, Emberreach).
    const clock = this.hazardVisClock;
    for (const h of this.world.floorHazards) {
      if (h.kind !== "fire_vent" && h.kind !== "void_rift") continue;
      const wx = (h.tx + 0.5) * TILE, wy = (h.ty + 0.5) * TILE;
      if (!this.isNearCamera(wx, wy, 160)) continue;
      const phase = floorHazardPhaseAt(h, clock);
      if (phase === "idle") continue;
      const frac = floorHazardPhaseFrac(h, clock);
      if (h.kind === "fire_vent") {
        if (phase === "telegraph") {
          this.lighting.pushDynamic(wx, wy, 70 + 30 * frac, 0.25 + 0.35 * frac, "#ff6a2a", 0.55);
        } else {
          const flick = settings.isReducedMotion ? 0.9 : 0.8 + 0.2 * Math.sin(this.animClock * 23 + h.phase * 9);
          const fade = frac > 0.75 ? (1 - frac) / 0.25 : 1;
          this.lighting.pushDynamic(wx, wy, 130, 0.8 * flick * fade, "#ff8a3b", 0.55);
        }
      } else if (phase === "active") {
        this.lighting.pushDynamic(wx, wy, 100, 0.45, this.currentBiome.accent, 0.55);
      }
    }
    // Burning cinders (the sinderling's flame-jet wake): each live cinder is real fire
    // on the ground — a small warm cut + stain that fades with its life. Sim-capped at
    // 12 live cinders, pushed after the vent tells so a saturated pool sheds wake
    // dressing first. Volatile "charge" fuses stay UNLIT on purpose: a fuse is a tell,
    // not a fire — its blinking ring renders above the grade, and the eventual burst
    // arrives through the shared explosion light pulse.
    for (const h of this.hazards) {
      if (h.kind !== "cinder" || !this.isNearCamera(h.x, h.y, 90)) continue;
      const fade = Math.min(1, h.life / Math.max(0.001, h.maxLife) * 3);
      const flicker = settings.isReducedMotion ? 0.85 : 0.7 + 0.3 * Math.sin(this.animClock * 11 + h.id * 1.9);
      this.lighting.pushDynamic(h.x, h.y, 58, 0.5 * fade * flicker, "#ff8a3b", 0.5);
    }
    if (this.isCurrentFloorCleared()) {
      const ex = (this.dungeon.exit.x + 0.5) * TILE, ey = (this.dungeon.exit.y + 0.5) * TILE;
      if (this.isNearCamera(ex, ey, EXIT_LIGHT_RADIUS)) {
        this.lighting.pushDynamic(ex, ey, EXIT_LIGHT_RADIUS, 0.5, "#8affc0");
      }
    }
  }

  // The depth mood: a biome-colored vignette that closes in band over band (10% of the
  // frame edge in the Hollow, nearly half-frame in the Null), breathing very slightly in
  // the pulsing biomes. Cached gradient — one drawImage per frame.
  private renderBiomeVignette() {
    const { ctx, canvas } = this;
    const biome = this.currentBiome;
    if (biome.vignette <= 0.01) return;
    if (!this.vignetteCache || this.vignetteCache.w !== canvas.width || this.vignetteCache.h !== canvas.height) {
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const g = off.getContext("2d");
      if (!g) return;
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const inner = Math.min(cx, cy) * (1 - biome.vignette);
      const outer = Math.hypot(cx, cy);
      const [r, gg, b] = hexToRgb(biome.vignetteColor);
      const grad = g.createRadialGradient(cx, cy, inner, cx, cy, outer);
      grad.addColorStop(0, `rgba(${r},${gg},${b},0)`);
      grad.addColorStop(1, `rgba(${r},${gg},${b},${Math.min(0.9, biome.vignette + 0.34)})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, off.width, off.height);
      this.vignetteCache = { canvas: off, w: canvas.width, h: canvas.height };
    }
    ctx.save();
    ctx.globalAlpha = biome.pulse > 0 ? 1 - biome.pulse * 0.5 * (1 + Math.sin(this.animClock * 1.7)) : 1;
    ctx.drawImage(this.vignetteCache.canvas, 0, 0);
    ctx.restore();
  }

  // Mid-run outage overlay over the frozen world, following the UI contract's state
  // machine: the first 3s are a calm CONNECTION LOST / Reconnecting… (most blips end
  // there); from 3s the attempt counter, the ESC cancel affordance, and the seat-grace
  // countdown appear. Explicitly NOT a game-over screen.
  private renderReconnectOverlay() {
    if (this.mode !== "online" || !this.wsTransport) return;
    const info = this.wsTransport.getReconnectInfo();
    if (!info.isReconnecting) return;
    const copy = reconnectOverlayCopy(Date.now(), info);
    const { ctx, canvas } = this;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.save();
    ctx.fillStyle = "rgba(13, 10, 24, 0.72)";
    ctx.fillRect(0, cy - 58, canvas.width, 116);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pulse = 0.6 + 0.3 * Math.sin(this.animClock * 4);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#ffb43b";
    ctx.font = '700 14px "Silkscreen", monospace';
    ctx.fillText(copy.title, cx, cy - 22);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e8e2f4";
    ctx.font = '16px "VT323", monospace';
    ctx.fillText(copy.line, cx, cy + 4);
    if (copy.hint) {
      ctx.fillStyle = "#8f87a8";
      ctx.fillText(copy.hint, cx, cy + 28);
    }
    ctx.restore();
  }

  // The pre-reveal online frame: a plain dark hold, never the placeholder dungeon — showing
  // it is exactly the spawn-then-teleport artifact. A party-started run additionally lists
  // every expected room member with their live server-verified status, so "only the host
  // made it in" is an explicit, visible state instead of a silent solo run.
  private renderConnectingVeil() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0d0a18";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const pulse = 0.55 + 0.35 * Math.sin(this.animClock * 4);
    const view = this.partyView;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (!view) {
      ctx.globalAlpha = pulse;
      ctx.fillStyle = "#ffb43b";
      ctx.font = '700 14px "Silkscreen", monospace';
      ctx.fillText(this.isArena ? "ENTERING THE ARENA\u2026" : "ENTERING THE DUNGEON\u2026", cx, cy);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#8f87a8";
      ctx.font = '16px "VT323", monospace';
      ctx.fillText(CONNECT_CANCEL_HINT, cx, cy + 28);
      ctx.restore();
      return;
    }
    const rows = view.members;
    const rowH = 26;
    const top = cy - (rows.length * rowH) / 2;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#ffb43b";
    ctx.font = '700 14px "Silkscreen", monospace';
    ctx.fillText(this.isArena ? "WAITING FOR PLAYERS\u2026" : "WAITING FOR PARTY\u2026", cx, top - 44);
    ctx.globalAlpha = 1;
    ctx.font = '700 11px "Silkscreen", monospace';
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i];
      const y = top + i * rowH;
      ctx.fillStyle = playerColor(m.colorIndex);
      ctx.beginPath();
      ctx.arc(cx - 150, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = "#e8e2f4";
      ctx.fillText(`${m.name}${m.isSelf ? " (you)" : ""}`, cx - 136, y);
      ctx.textAlign = "right";
      if (m.link === "connected") {
        ctx.fillStyle = "#7CFC98";
        ctx.fillText("CONNECTED TO WORLD", cx + 150, y);
      } else {
        ctx.fillStyle = "#ffb43b";
        ctx.globalAlpha = pulse;
        ctx.fillText(m.link === "reconnecting" ? "RECONNECTING\u2026" : "CONNECTING\u2026", cx + 150, y);
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "center";
    }
    ctx.fillStyle = "#8f87a8";
    ctx.font = '16px "VT323", monospace';
    ctx.fillText(`the run starts when everyone is in \u00b7 absent players drop out automatically \u00b7 ${CONNECT_CANCEL_HINT}`, cx, top + rows.length * rowH + 30);
    ctx.restore();
  }

  // Unmissable "you got hit" read: a red glow that hugs the screen edge and fades fast,
  // plus a brighter lobe on the edge FACING the damage source (findThreatDir) so a hit
  // also tells you where to look. At low HP the edge keeps breathing softly as a
  // standing warning. All screen space (outside the shake translate).
  private renderHurtVignette() {
    const { ctx, canvas } = this;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const lowFrac = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    const isLow = this.isRunning && !this.isDown && this.hp > 0 && lowFrac <= LOW_HP_FRAC;
    if (this.hurtFlash <= 0 && !isLow) return;
    const inner = Math.min(cx, cy) * 0.55;
    const outer = Math.hypot(cx, cy);
    if (isLow) {
      const pulse = 0.1 + 0.05 * Math.sin(this.animClock * 4.2) + (lowFrac <= LOW_HP_FRAC / 2 ? 0.05 : 0);
      const g = ctx.createRadialGradient(cx, cy, inner * 1.15, cx, cy, outer);
      g.addColorStop(0, "rgba(255,40,40,0)");
      g.addColorStop(1, `rgba(200,20,30,${pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (this.hurtFlash <= 0) return;
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, "rgba(255,40,40,0)");
    g.addColorStop(1, `rgba(255,30,30,${0.55 * this.hurtFlash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.hurtDir !== null) {
      const edgeR = Math.min(cx, cy) * 0.92;
      const bx = cx + Math.cos(this.hurtDir) * edgeR;
      const by = cy + Math.sin(this.hurtDir) * edgeR;
      const dg = ctx.createRadialGradient(bx, by, 8, bx, by, 230);
      dg.addColorStop(0, `rgba(255,60,50,${0.42 * this.hurtFlash})`);
      dg.addColorStop(1, "rgba(255,60,50,0)");
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // The cold frost vignette (the warmth-drain fairness tell): a cold-blue edge that RAMPS as the
  // idle timer climbs toward the chill, then holds + breathes once chilled (move ×0.5). Cold, never
  // amber — the Pale "blazing absence of warmth". A single screen effect (never ambient soup).
  private renderWarmthVignette() {
    const wd = this.isRunning ? resolveWarmthDrain(this.world.enemies.map((e) => ({ kind: e.kind, isDead: e.dead, phase: e.boss ? e.boss.phase : 0 }))) : null;
    if (!wd || this.p.warmthIdleSec <= 0) return;
    const { ctx, canvas } = this;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const ramp = Math.min(1, this.p.warmthIdleSec / wd.rampSec);
    const breath = this.p.isWarmthChilled ? 0.03 + 0.025 * Math.sin(this.animClock * 3.4) : 0;
    const isSweepLive = this.world.enemies.some((enemy) =>
      enemy.kind === "pale"
      && enemy.attack.move === "sweep"
      && (enemy.attack.phase === "windup" || enemy.attack.phase === "active"));
    const alpha = (ramp * 0.1 + breath) * (isSweepLive ? 0.6 : 1);
    if (alpha <= 0.001) return;
    const g = ctx.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.7, cx, cy, Math.hypot(cx, cy));
    g.addColorStop(0, "rgba(191,234,255,0)");
    g.addColorStop(1, `rgba(87,182,255,${alpha})`); // #57b6ff cold-blue frost rim
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  private renderTiles() {
    renderDungeonTiles(this.ctx, {
      dungeon: this.dungeon,
      biome: this.currentBiome,
      biomeIdx: this.biomeIdx,
      camX: this.renderCam.x,
      camY: this.renderCam.y,
      viewW: this.canvas.width,
      viewH: this.canvas.height,
      art: this.tiles,
      wallSide: this.wallSideGrads[this.biomeIdx],
      animClock: this.animClock,
      // The lighting layer supplies the ambient depth darkness (shaped by light pools)
      // in the grade below; the tile pass's flat fill only runs when the layer is off.
      isAmbientGraded: this.lighting.isEnabled,
    });
    // The ambient grade: contact AO + biome darkness with authored light cut out of it
    // (torch pools, hero glow, eruptions), then the light's own color stained onto the
    // ground it reaches. Everything after this — hazards, telegraphs, entities, HUD —
    // draws above the grade, so the depth mood can never darken a tell. Subtracts the
    // same render-clock camera as every other world pass (the shared-camera smoothing
    // invariant), so the light field pans with the world instead of stepping against it.
    this.lighting.renderGrade(this.ctx, this.renderCam.x, this.renderCam.y, this.canvas.width, this.canvas.height, this.animClock);
  }

  // ---- floor hazards ----
  // Every hazard renders its full cycle so danger is ALWAYS readable: a visible resting
  // body, an arming telegraph, and an unmistakable active burst. When authored art lands
  // in HAZARD_SOURCES the sheet replaces the body; the primitive fallback below speaks
  // the game's existing telegraph language (the boss-slam-marker family), so hazards are
  // fair on day one.
  // PVP Wave 2 — the contested hearth marker at the arena center (9,9). A floor-level ring +
  // radial glow that reads calm while uncontested, warms while an ember_edge is armed locally,
  // and flips to a dashed hot ring while contested. Rendered only inside a LIVE arena match, so
  // co-op and the pre/post-match freeze never draw it.
  private renderArenaHearth(): void {
    if (!this.isArena) return;
    const hud = this.arenaMatchHud();
    if (hud === null || hud.phase !== "live") return;
    const { ctx } = this;
    const cx = this.dungeon.spawn.x * TILE + TILE / 2 - this.renderCam.x;
    const cy = this.dungeon.spawn.y * TILE + TILE / 2 - this.renderCam.y;
    const pulse = 0.5 + 0.5 * Math.sin(this.animClock * 3.2);
    const rgb = hud.isHearthContested ? "255,92,64" : hud.isEmberArmed ? "255,184,96" : "255,150,84";
    ctx.save();
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, HEARTH.radius);
    glow.addColorStop(0, `rgba(${rgb},${(0.15 + 0.1 * pulse).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, HEARTH.radius, 0, 6.28);
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},${(0.5 + 0.35 * pulse).toFixed(3)})`;
    ctx.lineWidth = hud.isHearthContested ? 3 : 2;
    ctx.setLineDash(hud.isHearthContested ? [6, 5] : []);
    ctx.beginPath();
    ctx.arc(cx, cy, HEARTH.radius, 0, 6.28);
    ctx.stroke();
    ctx.restore();
  }

  // PVP Wave 2 — the cinder_gust wind. The gust is a director-only field (no hazard entity), so it
  // reads from the MatchWire projection: cold streaks blowing along the seeded cardinal across the
  // mid band around the hearth. A faint building shimmer during the tell, then a stronger drift
  // during the active window. tar/spark ride renderHazards; only the wind is drawn here.
  private renderRingWeather(): void {
    if (!this.isArena) return;
    const match = this.wsTransport?.getLatestSnapshot()?.match ?? null;
    if (match === null || match.ph !== "live" || match.wk !== "gust") return;
    const isActive = match.wp === "active";
    if (!isActive && match.wp !== "tell") return;
    const dir = PVP_WEATHER_CARDINALS[match.wd ?? 0] ?? PVP_WEATHER_CARDINALS[0];
    const cx = this.dungeon.spawn.x * TILE + TILE / 2 - this.renderCam.x;
    const cy = this.dungeon.spawn.y * TILE + TILE / 2 - this.renderCam.y;
    const band = WEATHER.gustMidBandDist;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "#bfe6ff";
    // The tell breathes in; the active window blows steady + brighter.
    const baseAlpha = isActive ? 0.28 : 0.12;
    const speed = isActive ? 90 : 26;
    const perp = { x: -dir.y, y: dir.x };
    const LANES = 7;
    for (let i = 0; i < LANES; i++) {
      const laneOff = (i / (LANES - 1) - 0.5) * 2 * band; // across the wind
      const flow = ((this.animClock * speed + i * 37) % (band * 2)) - band; // along the wind
      const mx = cx + perp.x * laneOff + dir.x * flow;
      const my = cy + perp.y * laneOff + dir.y * flow;
      if (Math.hypot(mx - cx, my - cy) > band) continue;
      const len = isActive ? 16 : 10;
      ctx.globalAlpha = baseAlpha * (0.6 + 0.4 * Math.sin(this.animClock * 6 + i));
      ctx.lineWidth = isActive ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(mx - dir.x * len, my - dir.y * len);
      ctx.lineTo(mx + dir.x * len, my + dir.y * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderFloorHazards() {
    const hazards = this.world.floorHazards;
    if (hazards.length === 0) return;
    const { renderCam: cam, tiles } = this;
    const clock = this.hazardVisClock;
    for (const h of hazards) {
      const wx = (h.tx + 0.5) * TILE, wy = (h.ty + 0.5) * TILE;
      if (!this.isNearCamera(wx, wy, TILE)) continue;
      const sx = h.tx * TILE - cam.x, sy = h.ty * TILE - cam.y;
      const phase = floorHazardPhaseAt(h, clock);
      const frac = floorHazardPhaseFrac(h, clock);
      const sheet = tiles.hazard(h.kind);
      if (sheet) {
        this.drawFloorHazardSheet(sheet, phase, sx, sy);
        continue;
      }
      switch (h.kind) {
        case "spikes": this.drawSpikes(sx, sy, phase, frac); break;
        case "toxic_pool": this.drawPool(sx, sy, h); break;
        case "fire_vent": this.drawVent(sx, sy, phase, frac, h); break;
        case "void_rift": this.drawRift(sx, sy, phase, frac); break;
      }
    }
  }

  // Authored hazard art: a 64px 1xN strip — 3 frames map idle/telegraph/active, 2 frames
  // map rest/active, 1 frame is a static body under the same telegraph overlays.
  private drawFloorHazardSheet(sheet: HTMLImageElement, phase: FloorHazardPhase, sx: number, sy: number) {
    const frames = Math.max(1, Math.floor(sheet.width / sheet.height));
    const idx = frames >= 3 ? (phase === "idle" ? 0 : phase === "telegraph" ? 1 : 2)
      : frames === 2 ? (phase === "active" ? 1 : 0) : 0;
    this.ctx.drawImage(sheet, idx * sheet.height, 0, sheet.height, sheet.height, sx, sy, TILE, TILE);
  }

  private drawSpikes(sx: number, sy: number, phase: FloorHazardPhase, frac: number) {
    const { ctx } = this;
    // Resting body: a recessed trap plate with four sockets — visible even when dormant.
    ctx.save();
    ctx.fillStyle = "rgba(5,3,11,0.42)";
    ctx.fillRect(sx + 4, sy + 4, TILE - 8, TILE - 8);
    ctx.fillStyle = "rgba(5,3,11,0.8)";
    for (const [ox, oy] of SPIKE_SOCKETS) ctx.fillRect(sx + ox - 2, sy + oy - 1, 4, 3);
    if (phase === "telegraph") {
      // Arming: the plate glows hot and the tips peek out — your cue to step off.
      ctx.globalAlpha = 0.25 + 0.45 * frac;
      ctx.strokeStyle = "#ff6a5a";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 4.5, sy + 4.5, TILE - 9, TILE - 9);
      ctx.globalAlpha = 1;
      this.drawSpikeSet(sx, sy, 3 + 3 * frac, 0.9);
    } else if (phase === "active") {
      // Sprung: full spikes with a fast pop and a late retract.
      const pop = frac < 0.15 ? frac / 0.15 : frac > 0.8 ? (1 - frac) / 0.2 : 1;
      this.drawSpikeSet(sx, sy, 4 + 12 * pop, 1);
    }
    ctx.restore();
  }

  private drawSpikeSet(sx: number, sy: number, height: number, alpha: number) {
    const { ctx } = this;
    ctx.globalAlpha = alpha;
    for (const [ox, oy] of SPIKE_SOCKETS) {
      const bx = sx + ox, by = sy + oy + 1;
      ctx.beginPath();
      ctx.moveTo(bx - 4, by);
      ctx.lineTo(bx + 4, by);
      ctx.lineTo(bx, by - height);
      ctx.closePath();
      ctx.fillStyle = "#c9c9de";
      ctx.fill();
      ctx.strokeStyle = "#05030b";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawPool(sx: number, sy: number, h: FloorHazard) {
    const { ctx } = this;
    const style = POOL_STYLES[Math.min(this.biomeIdx, POOL_STYLES.length - 1)];
    const cx = sx + TILE / 2, cy = sy + TILE / 2;
    const left = this.poolTiles.has(h.ty * this.dungeon.w + h.tx - 1) ? 0 : 3;
    const right = this.poolTiles.has(h.ty * this.dungeon.w + h.tx + 1) ? 0 : 3;
    const top = this.poolTiles.has((h.ty - 1) * this.dungeon.w + h.tx) ? 0 : 3;
    const bottom = this.poolTiles.has((h.ty + 1) * this.dungeon.w + h.tx) ? 0 : 3;
    ctx.save();
    // Recessed basin: a dark sink under the liquid so it reads carved INTO the floor,
    // merged with orthogonal pool neighbors so a blob is ONE body.
    ctx.fillStyle = "rgba(2,1,6,0.72)";
    ctx.fillRect(sx + left, sy + top, TILE - left - right, TILE - top - bottom);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = style.base;
    ctx.fillRect(sx + left + 1, sy + top + 1, TILE - left - right - 2, TILE - top - bottom - 2);
    // Rim highlight on the OUTER edges only (merged sides stay open water).
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (top > 0) { ctx.moveTo(sx + left, sy + top + 0.5); ctx.lineTo(sx + TILE - right, sy + top + 0.5); }
    if (bottom > 0) { ctx.moveTo(sx + left, sy + TILE - bottom - 0.5); ctx.lineTo(sx + TILE - right, sy + TILE - bottom - 0.5); }
    if (left > 0) { ctx.moveTo(sx + left + 0.5, sy + top); ctx.lineTo(sx + left + 0.5, sy + TILE - bottom); }
    if (right > 0) { ctx.moveTo(sx + TILE - right - 0.5, sy + top); ctx.lineTo(sx + TILE - right - 0.5, sy + TILE - bottom); }
    ctx.stroke();
    // Meniscus sheen, slowly wandering — liquid, not paint.
    const t = this.animClock * 0.7 + h.phase;
    const g = ctx.createRadialGradient(cx + Math.sin(t) * 8, cy + Math.cos(t * 0.8) * 6, 2, cx, cy, TILE * 0.62);
    g.addColorStop(0, style.sheen);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.10 + 0.04 * Math.sin(t * 1.7);
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, TILE, TILE);
    // Bubbles: two seeded risers that swell and pop.
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = style.sheen;
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const seed = tileHash(h.tx, h.ty, 7 + i);
      const cycle = (this.animClock * (0.35 + seed * 0.3) + seed * 7) % 1;
      const bx = sx + 10 + seed * (TILE - 20);
      const by = sy + TILE - 10 - cycle * (TILE - 22);
      ctx.beginPath();
      ctx.arc(bx, by, 1.2 + cycle * 2.2, 0, 6.28);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawVent(sx: number, sy: number, phase: FloorHazardPhase, frac: number, h: FloorHazard) {
    const { ctx } = this;
    const cx = sx + TILE / 2, cy = sy + TILE / 2;
    ctx.save();
    // Body: a scorched grate — three slots on a dark disc.
    ctx.fillStyle = "rgba(10,5,3,0.75)";
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, 6.28);
    ctx.fill();
    ctx.strokeStyle = "#4a2820";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#05030b";
    for (let i = -1; i <= 1; i++) ctx.fillRect(cx - 8, cy + i * 6 - 1, 16, 2);
    if (phase === "telegraph") {
      // Coals glowing through the slots, swelling toward the blast.
      const glow = this.sprites.fxTinted("glow_round", "#ff6a2a");
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.2 + 0.55 * frac;
      if (glow) ctx.drawImage(glow, cx - 14, cy - 14, 28, 28);
      else {
        const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 14);
        g.addColorStop(0, "#ff8a3b");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 14, cy - 14, 28, 28);
      }
    } else if (phase === "active") {
      // The eruption: a flickering flame column + floor bloom.
      const flick = 0.75 + 0.25 * Math.sin(this.animClock * 23 + h.phase * 9);
      const sway = Math.sin(this.animClock * 9 + h.phase * 5) * 2.5;
      const fade = frac > 0.75 ? (1 - frac) / 0.25 : 1;
      ctx.globalCompositeOperation = "lighter";
      const bloom = ctx.createRadialGradient(cx, cy, 4, cx, cy, 34);
      bloom.addColorStop(0, "rgba(255,140,60,0.5)");
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.8 * fade;
      ctx.fillStyle = bloom;
      ctx.fillRect(cx - 34, cy - 34, 68, 68);
      const flame = this.sprites.fxTinted("flame_puff", "#ff8a3b") ?? this.sprites.fxTinted("glow_round", "#ff8a3b");
      const core = this.sprites.fxTinted("glow_round", "#ffd166");
      for (let i = 0; i < 3; i++) {
        const size = (34 - i * 8) * flick;
        const oy = -6 - i * 13;
        ctx.globalAlpha = (0.55 - i * 0.12) * fade;
        if (flame) ctx.drawImage(flame, cx + sway * (i + 1) * 0.4 - size / 2, cy + oy - size / 2, size, size);
      }
      if (core) {
        ctx.globalAlpha = 0.8 * fade * flick;
        ctx.drawImage(core, cx - 8, cy - 16, 16, 16);
      }
    }
    ctx.restore();
  }

  private drawRift(sx: number, sy: number, phase: FloorHazardPhase, frac: number) {
    const { ctx } = this;
    const accent = this.currentBiome.accent;
    const cx = sx + TILE / 2, cy = sy + TILE / 2;
    ctx.save();
    // Body: a tear lying on the floor — dark lens + faint standing ring.
    ctx.fillStyle = "rgba(2,1,6,0.85)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, 10, 6, 0, 0, 6.28);
    ctx.fill();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 13, 8, 0, 0, 6.28);
    ctx.stroke();
    if (phase === "telegraph") {
      // Ingathering: a ring collapses inward while stray light is dragged in.
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.25 + 0.5 * frac;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      const r = 26 - 16 * frac;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 6.28);
      ctx.stroke();
      ctx.fillStyle = accent;
      for (let i = 0; i < 4; i++) {
        const a = this.animClock * 2.2 + i * (Math.PI / 2);
        const rr = r * (0.6 + 0.4 * ((1 - frac + i * 0.25) % 1));
        ctx.fillRect(cx + Math.cos(a) * rr - 1, cy + Math.sin(a) * rr - 1, 2, 2);
      }
    } else if (phase === "active") {
      // Open: rotating accretion arcs, inward streaks, and the honest pull-range hint.
      ctx.globalCompositeOperation = "lighter";
      const spin = this.animClock * 3.1;
      ctx.strokeStyle = accent;
      for (let i = 0; i < 3; i++) {
        const r = 9 + i * 6;
        ctx.globalAlpha = 0.55 - i * 0.13;
        ctx.lineWidth = 2 - i * 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, spin * (i % 2 === 0 ? 1 : -1) + i, spin * (i % 2 === 0 ? 1 : -1) + i + 3.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 4; i++) {
        const a = spin * 0.7 + i * (Math.PI / 2);
        const r0 = 24, r1 = 13;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.07 + 0.03 * Math.sin(this.animClock * 4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, RIFT_PULL_RADIUS, 0, 6.28);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Wall-mounted torches: an additive emissive halo behind a 3-frame flickering flame.
  // Culled to the visible window; per-torch phase offset keeps them from flickering in
  // sync, and reduced motion holds the flicker at its midpoint. The halo takes the biome
  // light grammar's tint + throw (warm home fires, a beacon against the cold caves, the
  // Null's wrong lavender) — one authored glow asset, every mood.
  private renderProps() {
    const { ctx, renderCam: cam, canvas, tiles } = this;
    const clock = this.animClock;
    const flame = TORCH_FRAMES[frameIndex(TORCH_FRAMES.length, 8, clock)];
    const hasGlow = tiles.ready("torch_glow");
    const hasFlame = tiles.ready(flame);
    if (!hasGlow && !hasFlame) return;
    const halo = this.lighting.torchHalo();
    const glowImg = hasGlow ? (tiles.tinted("torch_glow", halo.color) ?? tiles.get("torch_glow")) : null;
    for (const t of this.torches) {
      const sx = t.tx * TILE - cam.x, sy = t.ty * TILE - cam.y;
      if (sx <= -TILE || sy <= -TILE || sx >= canvas.width || sy >= canvas.height) continue;
      if (glowImg) {
        const flick = settings.isReducedMotion ? 0.875 : 0.75 + 0.25 * Math.sin(clock * 11 + t.tx * 1.7 + t.ty * 0.9);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 * flick;
        ctx.drawImage(glowImg, sx + TILE / 2 - halo.size / 2, sy + TILE / 2 - halo.size / 2, halo.size, halo.size);
        ctx.restore();
      }
      if (hasFlame) ctx.drawImage(tiles.get(flame), sx, sy, TILE, TILE);
    }
  }

  private renderExit() {
    if (this.isArena) return;
    const { ctx, renderCam: cam } = this;
    const d = this.dungeon;
    const ex = d.exit.x * TILE + TILE / 2 - cam.x, ey = d.exit.y * TILE + TILE / 2 - cam.y;
    // Use the SAME authoritative/objective clear predicate as the HUD + descend gate. Online
    // snapshots can carry an interest-filtered entity view, so local isFloorCleared(world)
    // may say "clear" while global enemies/reinforcements remain — that caused false GO DOWN.
    const isCleared = this.isCurrentFloorCleared();
    // Stairs-down sprite reads as the way to the next floor (replaces the vague portal
    // ring). Subtle amber shimmer between the 2 frames + a soft glow once the floor's clear.
    const stairs: TileName = (isCleared && Math.floor(this.animClock * 1.5) % 2 === 1) ? "stairs_f1" : "stairs_f0";
    if (isCleared) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      const g = ctx.createRadialGradient(ex, ey, 2, ex, ey, TILE * 0.75);
      g.addColorStop(0, "#ffb43b"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ex, ey, TILE * 0.75, 0, 6.28); ctx.fill();
      ctx.restore();
    }
    if (this.tiles.ready(stairs)) {
      ctx.drawImage(this.tiles.get(stairs), d.exit.x * TILE - cam.x, d.exit.y * TILE - cam.y, TILE, TILE);
    } else {
      // fallback: the old portal ring if the stairs art isn't loaded yet.
      ctx.save(); ctx.globalAlpha = isCleared ? 0.9 : 0.28;
      const g = ctx.createRadialGradient(ex, ey, 2, ex, ey, TILE * 0.7);
      g.addColorStop(0, isCleared ? "#8affc0" : "#5a6"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ex, ey, TILE * 0.7, 0, 6.28); ctx.fill(); ctx.restore();
    }

    // Once the floor is clear, prompt the player to walk onto the portal.
    if (isCleared) {
      ctx.save();
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(this.animClock * 3));
      ctx.globalAlpha = pulse;
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.fillStyle = "#05030b";
      ctx.fillText("\u25be GO DOWN", ex + 1, ey - TILE * 0.7 + 1);
      ctx.fillStyle = "#8affc0";
      ctx.fillText("\u25be GO DOWN", ex, ey - TILE * 0.7);
      ctx.restore();
    }
  }

  // Soft contact shadows under everything so entities sit ON the floor, not float. With
  // the lighting layer up, each shadow samples the baked light field: it slides a few px
  // AWAY from the light and firms up on brightly lit ground, so bodies read grounded in
  // a torch pool without their silhouettes ever changing. One cheap pass on the floor
  // layer (before sprites) — a sampled gradient blob, no per-entity allocation.
  private shadow(cx: number, cy: number, w: number) {
    const { ctx } = this;
    if (!this.lighting.isEnabled) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = "#05030b";
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.42, w * 0.18, 0, 0, 6.28);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Screen -> world through the same render-clock camera the callers subtracted.
    const s = this.lighting.sampleLight(cx + this.renderCam.x, cy + this.renderCam.y);
    const mag = Math.hypot(s.dx, s.dy);
    const push = Math.min(4, mag * 22);
    const ox = mag > 0.001 ? (-s.dx / mag) * push : 0;
    const oy = mag > 0.001 ? (-s.dy / mag) * push : 0;
    ctx.save();
    ctx.globalAlpha = 0.30 + 0.18 * Math.min(1, s.intensity * 1.6);
    ctx.drawImage(this.lighting.shadowSprite(), cx + ox - w * 0.5, cy + oy - w * 0.21, w, w * 0.42);
    ctx.restore();
  }

  private renderShadows() {
    const { renderCam: cam } = this;
    // props + chests
    for (const p of this.props) {
      if (p.dead || p.kind === "brazier") continue;
      if (this.isNearCamera(p.x, p.y, TILE)) this.shadow(p.x - cam.x, p.y - cam.y + PROP_DRAW * 0.34, PROP_DRAW * 0.7);
    }
    for (const c of this.chests) {
      if (this.isNearCamera(c.x, c.y, TILE)) this.shadow(c.x - cam.x, c.y - cam.y + 16, 40);
    }
    // enemies
    for (const e of this.enemies) {
      if (e.dead) continue;
      const arch = ENEMY_ARCHETYPES[e.kind];
      if (arch.isPhasing) continue; // ghosts float — no ground shadow
      const size = this.enemyDrawSize(e);
      if (this.isNearCamera(e.x, e.y, TILE)) this.shadow(e.x - cam.x, e.y - cam.y + size * 0.3, size * 0.62);
    }
    // remote players (co-op presence or authoritative server)
    for (const r of this.remotes()) {
      if (!r.isDown) this.shadow(r.x - cam.x, r.y - cam.y + 15, 34);
    }
    // local player
    if (this.isRunning && !this.isDown) this.shadow(this.px - cam.x, this.py - cam.y + 16, 36);
  }

  private renderPropEntities() {
    if (this.props.length === 0) return;
    for (const p of this.props) {
      if (!this.isNearCamera(p.x, p.y, TILE)) continue;
      const sx = p.x - this.renderCam.x, sy = p.y - this.renderCam.y;
      const anim = this.animForProp(p);
      const xf = characterXform(anim, PROP_STYLE);
      if (p.kind === "brazier") { this.renderBrazier(p, sx, sy, xf); continue; }
      if (p.breakT === undefined) {
        this.drawPropImage(PROP_INTACT_IMG[p.kind], 0, sx, sy, PROP_DRAW, xf, anim.flash);
      } else {
        const sheet = PROP_BREAK_SHEET[p.kind];
        if (!sheet) continue;
        // Frames 1-2 over the break duration (frame 0 is the intact state).
        const frame = 1 + Math.min(1, Math.floor((p.breakT / PROP_BREAK_DUR) * 2));
        this.drawPropImage(sheet, frame, sx, sy, PROP_DRAW, xf, 0);
      }
    }
  }

  // Brazier: the static base with the animated torch flame layered on top and the shared
  // torch glow composited additively — a mood + light-source prop, no new art. Halo tint
  // and throw come from the biome light grammar, like the wall torches.
  private renderBrazier(p: Prop, sx: number, sy: number, xf: Xform) {
    const { ctx, tiles } = this;
    this.drawPropImage("brazier", 0, sx, sy, PROP_DRAW, xf, 0);
    const clock = this.animClock;
    if (tiles.ready("torch_glow")) {
      const halo = this.lighting.brazierHalo();
      const glowImg = tiles.tinted("torch_glow", halo.color) ?? tiles.get("torch_glow");
      const flick = settings.isReducedMotion ? 0.875 : 0.75 + 0.25 * Math.sin(clock * 11 + p.x * 0.03 + p.y * 0.02);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 * flick;
      ctx.drawImage(glowImg, sx - halo.size / 2, sy - 4 - halo.size / 2, halo.size, halo.size);
      ctx.restore();
    }
    const flame = TORCH_FRAMES[frameIndex(TORCH_FRAMES.length, 8, clock)];
    if (tiles.ready(flame)) ctx.drawImage(tiles.get(flame), sx - TILE / 2, sy - TILE / 2 - 14, TILE, TILE);
  }

  private renderChests() {
    if (this.chests.length === 0) return;
    const { ctx, renderCam: cam } = this;
    for (const c of this.chests) {
      if (!this.isNearCamera(c.x, c.y, TILE)) continue;
      const sx = c.x - cam.x, sy = c.y - cam.y;
      const anim = this.animForChest(c);
      // A closed chest pulses a soft glow so touch-to-open reads as interactive.
      if (!c.opened) {
        const pulse = 0.35 + 0.2 * Math.abs(Math.sin(anim.clock * 3));
        ctx.save();
        ctx.globalAlpha = pulse;
        const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, 24);
        g.addColorStop(0, c.kind === "boss" ? "#ffb43b" : "#ffd27a");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(sx, sy, 24, 0, 6.28); ctx.fill();
        ctx.restore();
      }
      const t = c.openT ?? 0;
      const frame = c.opened ? Math.min(2, Math.floor((t / CHEST_OPEN_DUR) * 3)) : 0;
      const xf = characterXform(anim, PROP_STYLE);
      this.drawPropImage("chest_open", frame, sx, sy, PROP_DRAW, xf, 0);
    }
  }

  // Draws one frame of a prop/chest image (break sheet or 64px static) with the prop's
  // idle transform and an optional white hit-flash. Falls back to a small box until the
  // sprite streams in. Frame width is the sheet height (square frames), so frame 0 also
  // covers the single-frame statics.
  private drawPropImage(name: PropSpriteName, frame: number, sx: number, sy: number, size: number, xf: Xform, flashAmt: number) {
    const { ctx } = this;
    const img = this.sprites.prop(name);
    const half = size / 2;
    if (!img) {
      ctx.save();
      ctx.fillStyle = "#6b5330";
      ctx.fillRect(sx - half * 0.55, sy - half * 0.55, size * 0.55, size * 0.55);
      ctx.restore();
      return;
    }
    const fw = img.naturalHeight || FRAME;
    ctx.save();
    ctx.translate(sx + xf.ox, sy + xf.oy);
    ctx.scale(xf.sx, xf.sy);
    ctx.drawImage(img, frame * fw, 0, fw, fw, -half, -half, size, size);
    if (flashAmt > 0) {
      const f = this.sprites.propFlash(name);
      if (f) { ctx.globalAlpha = Math.min(1, flashAmt) * 0.9; ctx.drawImage(f, frame * fw, 0, fw, fw, -half, -half, size, size); }
    }
    ctx.restore();
  }

  // Draws a character sprite with its animation transform, an optional frame from a
  // spritesheet (falling back to the static PNG), an optional white hit-flash, and an
  // optional identity tint (recolored via the shading-preserving cache in assets.ts).
  // `isHoldFirstFrame`: directional walk sheets double as the idle pose by clamping to
  // frame 0 while the body stands still (the AD authors one sheet per facing, not two).
  private drawChar(name: SpriteName, clip: SheetClip, cx: number, cy: number, size: number, facing: number, xf: Xform, extra: number, alpha: number, flash: number, frameClock: number, tint: string | null = null, isHoldFirstFrame = false) {
    const { ctx } = this;
    const sheet = this.sprites.sheet(name, clip);
    if (!sheet && !this.sprites.ready(name)) {
      // Streaming/absent sprite: a plain disc in the character's own tint keeps it readable.
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = SPRITE_FALLBACK_TINT[name] ?? "#a855f7";
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.34, 0, 6.28); ctx.fill(); ctx.restore();
      return;
    }
    const half = size / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx + xf.ox, cy + xf.oy);
    ctx.rotate(xf.rot);
    // When a frame SHEET is playing, its frames ALREADY bake the squash/stretch, so
    // applying the procedural sx/sy deform on top double-exposes it (the "ghosted /
    // stacked slime" bug). Keep facing + the bob/lean offset, but neutralize the
    // procedural scale toward 1 so the sheet's own animation carries the deform.
    const sSx = sheet ? facing * extra : facing * xf.sx * extra;
    const sSy = sheet ? extra : xf.sy * extra;
    ctx.scale(sSx, sSy);
    if (sheet) {
      const fw = sheet.img.naturalHeight || FRAME;
      const count = frameCount(sheet.img.naturalWidth, sheet.img.naturalHeight);
      const i = isHoldFirstFrame ? 0 : frameIndex(count, sheet.fps, frameClock);
      // The tinted sheet is pixel-identical in layout, so the source frame rect still applies.
      const src = tint ? this.sprites.tintedSheetCanvas(name, clip, tint) ?? sheet.img : sheet.img;
      ctx.drawImage(src, i * fw, 0, fw, fw, -half, -half, size, size);
    } else {
      const src = tint ? this.sprites.tintedSprite(name, tint) ?? this.sprites.get(name) : this.sprites.get(name);
      ctx.drawImage(src, -half, -half, size, size);
    }
    if (flash > 0) {
      const f = this.sprites.flashSprite(name);
      if (f) { ctx.globalAlpha = alpha * Math.min(1, flash) * 0.9; ctx.drawImage(f, -half, -half, size, size); }
    }
    ctx.restore();
  }

  // Composite a REUSABLE body overlay (guard/expose crack, etc.) on top of the base sprite at
  // the SAME transform, following the body's facing/deform. Zero-code art hook (the
  // pet/cosmetic pattern): it draws ONLY once the overlay sheet has loaded — while it streams
  // in or is absent it draws NOTHING (never a fallback disc over the boss). Callers gate it on
  // the authoritative guard/expose flag, so the swap is a hard instant toggle with no tween.
  private compositeBodyOverlay(name: SpriteName, cx: number, cy: number, size: number, facing: number, xf: Xform, extra: number, frameClock: number): void {
    if (this.sprites.sheet(name, "idle") === null) return;
    // Additive ("lighter") so the glow-only crack asset (dark outline pixels stripped to
    // transparent) reads as hot cracks lit THROUGH the body, never a flat panel that dims
    // the boss. AD-confirmed blend for glow overlays.
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    this.drawChar(name, "idle", cx, cy, size, facing, xf, extra, 1, 0, frameClock);
    ctx.restore();
  }

  // ---- Patch's waystation ----
  // Every station renders from its authoritative slot. The ART hooks (patch sprite +
  // patch_stall / shop_pedestal / shop_heart_station / shop_reroll_post) take over piece
  // by piece the moment approved PNGs land; until then each is a clean flat primitive
  // that claims no final art. Walking near a station HIGHLIGHTS it (ring + prompt) — a
  // purchase only ever leaves through the panel's BUY.
  private renderShop() {
    const shop = this.world.shop;
    if (!shop) return;
    const { renderCam: cam } = this;
    if (this.isNearCamera(shop.keeperX, shop.keeperY, 140)) {
      this.drawShopStall(shop.keeperX - cam.x, shop.keeperY - cam.y);
      this.drawPatch(shop.keeperX - cam.x, shop.keeperY - cam.y - 22);
    }
    const viewer = this.shopViewer();
    const focused = this.focusedShopSlot();
    for (const slot of shop.slots) {
      if (!this.isNearCamera(slot.x, slot.y, TILE * 2)) continue;
      this.drawShopStation(
        shop,
        shopSlotForViewer(shop, slot, this.p.id),
        viewer,
        focused !== null && focused.id === slot.id,
      );
    }
  }

  // The fold-out salvage cabinet (coherence gate: built from recovered doors/prop
  // pieces). Primitive: frame beam, hung panel, counter — flat fills only.
  private drawShopStall(sx: number, sy: number) {
    const { ctx } = this;
    const img = this.sprites.prop("patch_stall");
    if (img) {
      ctx.drawImage(img, sx - 48, sy - 44, 96, 64);
      return;
    }
    ctx.save();
    ctx.fillStyle = "#2c2013";
    ctx.fillRect(sx - 42, sy - 38, 84, 8);
    ctx.fillStyle = "#57402a";
    ctx.fillRect(sx - 38, sy - 30, 76, 5);
    ctx.fillStyle = "#6b5330";
    ctx.fillRect(sx - 34, sy + 2, 68, 12);
    ctx.fillStyle = "#8a6a3c";
    ctx.fillRect(sx - 34, sy, 68, 3);
    ctx.restore();
  }

  // Patch behind the counter: authored idle/handover sheets once patch art lands (see
  // assets.ts); until then the engine's standard flat streaming disc — deliberately NOT
  // a procedural character. The nameplate is fixed identity, never a floating price tag.
  private drawPatch(sx: number, sy: number) {
    const { ctx } = this;
    const clip: SheetClip = this.patchSellT > 0 ? "attack" : "idle";
    if (this.sprites.sheet("patch", clip) !== null || this.sprites.ready("patch")) {
      this.drawChar("patch", clip, sx, sy, 44, 1, IDENTITY_XFORM, 1, 1, 0, this.animClock);
    } else {
      ctx.save();
      ctx.fillStyle = "#c98a3b";
      ctx.beginPath(); ctx.arc(sx, sy, 13, 0, 6.28); ctx.fill();
      ctx.strokeStyle = "#ffd27a";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 13, 0, 6.28); ctx.stroke();
      ctx.restore();
    }
    this.drawShopText("PATCH", sx, sy - 22, "#ffd27a");
  }

  private drawShopStation(shop: ShopState, slot: ShopSlot, viewer: ShopViewer, isFocused: boolean) {
    const { ctx, renderCam: cam } = this;
    const sx = slot.x - cam.x, sy = slot.y - cam.y;
    const status = shopSlotStatusFor(shop, slot, viewer);
    // The walk-near highlight: an interact affordance ring, never a buy trigger.
    if (isFocused) {
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.25 * Math.sin(this.animClock * 5);
      ctx.strokeStyle = "#ffe9b0";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 23, 0, 6.28); ctx.stroke();
      ctx.restore();
    }
    const art = this.sprites.prop(SHOP_STATION_IMG[slot.kind]);
    if (art) {
      ctx.drawImage(art, sx - 24, sy - 34, 48, 48);
    } else {
      ctx.save();
      ctx.fillStyle = "#443550";
      ctx.fillRect(sx - 11, sy - 6, 22, 13);
      ctx.fillStyle = "#5d4a66";
      ctx.fillRect(sx - 13, sy - 10, 26, 5);
      ctx.restore();
    }
    // The merchandise floats over the pedestal — and honestly VANISHES once taken: a
    // claimed shared object is gone for everyone; a personal slot empties only for the
    // viewer who bought theirs.
    const isEmptied = slot.isShared ? slot.soldTo !== null : status === "sold";
    if (!isEmptied) {
      const bob = Math.sin(this.animClock * 2.4 + slot.id * 1.7) * 2;
      // The EVENT stock's distinct glow (designer feel spec): legendaries, the artifact,
      // and the mythic pedestals breathe gold so the chase reads from across the room —
      // greyed-but-glowing when unaffordable (visible-but-locked, never hidden).
      if (PREMIUM_EVENT_KINDS.has(slot.kind) || (slot.weapon !== null && !slot.isMystery && WEAPONS[slot.weapon].rarity === "legendary")) {
        ctx.save();
        ctx.globalAlpha = (status === "buy" ? 0.5 : 0.28) + 0.18 * Math.sin(this.animClock * 3 + slot.id);
        ctx.strokeStyle = WEAPON_RARITY_COLOR.legendary;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy - 24 + bob, 20, 0, 6.28); ctx.stroke();
        ctx.restore();
      }
      this.drawShopMerch(slot, sx, sy - 24 + bob);
    }
    // An unaffordable station still reads FOR SALE: its price chip wears the same amber
    // outline the panel's broke row does — never the muted grey of the resolved states.
    // Prices are the viewer's EFFECTIVE price (successive-buy escalation included).
    const price = shopSlotPriceFor(shop, slot, viewer);
    const color = status === "buy" ? "#ffd27a" : status === "broke" ? "#ffb43b" : "#9a8fb5";
    if (status === "broke") this.drawShopChipOutline(shopChipCopy(status, price, slot.kind), sx, sy + 15);
    this.drawShopText(shopChipCopy(status, price, slot.kind), sx, sy + 15, color);
  }

  private drawShopChipOutline(text: string, sx: number, sy: number) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 9px "Silkscreen", monospace';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(8,6,16,0.8)";
    ctx.fillRect(sx - w / 2 - 4, sy - 9, w + 8, 13);
    ctx.strokeStyle = "#ffb43b";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - w / 2 - 3.5, sy - 8.5, w + 7, 12);
    ctx.restore();
  }

  // A big tinted glyph on a dark chip — the premium stations' merchandise read until
  // authored art lands (a "?" for the mystery, "◆" for the amber sinks, "✦" mythic trio).
  private drawShopGlyph(sx: number, sy: number, glyph: string, tint: string) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "rgba(8,6,16,0.85)";
    ctx.fillRect(sx - 11, sy - 11, 22, 22);
    ctx.strokeStyle = tint;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - 11, sy - 11, 22, 22);
    ctx.fillStyle = tint;
    ctx.font = '700 12px "Silkscreen", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, sx, sy + 1);
    ctx.restore();
  }

  private drawShopMerch(slot: ShopSlot, sx: number, sy: number) {
    const { ctx } = this;
    // A mystery pedestal wears the "???" chip — its identity never even reaches the wire.
    if (slot.kind === "weapon" && slot.isMystery) { this.drawShopGlyph(sx, sy, "?", MYSTERY_COLOR); return; }
    if ((slot.kind === "weapon" || slot.kind === "legendary" || slot.kind === "mythic_weapon" || slot.kind === "artifact") && slot.weapon !== null) {
      const img = this.sprites.weaponPickup(slot.weapon);
      if (img) { ctx.drawImage(img, sx - 17, sy - 17, 34, 34); return; }
      if (this.sprites.ready("gun")) { ctx.drawImage(this.sprites.get("gun"), sx - 14, sy - 14, 28, 28); return; }
    }
    if ((slot.kind === "heart" || slot.kind === "max_hp" || slot.kind === "full_heal" || slot.kind === "revive_token") && this.sprites.ready("heart")) {
      ctx.drawImage(this.sprites.get("heart"), sx - 13, sy - 13, 26, 26);
      return;
    }
    if (slot.kind === "mystery") { this.drawShopGlyph(sx, sy, "?", MYSTERY_COLOR); return; }
    if (slot.kind === "amber_cache" || slot.kind === "mythic_amber") { this.drawShopGlyph(sx, sy, "\u25c6", "#ffb43b"); return; }
    if (slot.kind === "mythic_trio") { this.drawShopGlyph(sx, sy, "\u2756", "#ffb43b"); return; }
    if (slot.kind === "reroll_all") { this.drawShopGlyph(sx, sy, "\u21bb", "#ffb43b"); return; }
    if (slot.kind === "weapon_upgrade") { this.drawShopGlyph(sx, sy, "\u2692", "#e8e0c8"); return; }
    if (slot.kind === "prospector") { this.drawShopGlyph(sx, sy, "\u2697", "#ffd166"); return; }
    if (slot.kind === "extra_slot") { this.drawShopGlyph(sx, sy, "\u25a3", "#e8e0c8"); return; }
    if (slot.kind === "blessing" || slot.kind === "rare_blessing" || slot.kind === "core_infusion") {
      const def = itemById(slot.itemId ?? "");
      const tint = def?.tint ?? "#c98bff";
      ctx.save();
      ctx.fillStyle = "rgba(8,6,16,0.85)";
      ctx.fillRect(sx - 11, sy - 11, 22, 22);
      ctx.strokeStyle = tint;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 11, sy - 11, 22, 22);
      ctx.fillStyle = tint;
      ctx.font = '700 12px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def?.glyph ?? "?", sx, sy + 1);
      ctx.restore();
      return;
    }
    if (slot.kind === "reroll") {
      ctx.save();
      ctx.fillStyle = "#8fd8c8";
      ctx.font = '700 16px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u21bb", sx, sy + 1);
      ctx.restore();
      return;
    }
    ctx.fillStyle = "#ffd27a";
    ctx.beginPath(); ctx.arc(sx, sy, 8, 0, 6.28); ctx.fill();
  }

  // Small world-space shop label with the HUD's standard drop shadow.
  private drawShopText(text: string, sx: number, sy: number, color: string) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 9px "Silkscreen", monospace';
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(8,6,16,0.9)";
    ctx.fillText(text, sx + 1, sy + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, sx, sy);
    ctx.restore();
  }

  private renderPickups() {
    const { ctx, renderCam: cam } = this;
    for (const p of this.pickups) {
      const clock = this.animForPickup(p).clock;
      const sx = p.x - cam.x, sy = p.y - cam.y + Math.sin(clock * 3) * 3 - 2;
      const name: SpriteName = p.kind === "weapon" ? "gun" : p.kind;
      // The rarity treatment starts at the glow: weapons wear their tier's accent (the
      // shared WEAPON_RARITY_COLOR palette); a mystery wears the "???" purple. Note the
      // mystery's identity may be known locally (solo runs the full sim) but is NEVER
      // rendered — the reveal moment is authoritative for every mode.
      const isMystery = p.isMystery === true;
      const rarity = !isMystery && p.kind === "weapon" && p.weapon ? WEAPONS[p.weapon].rarity : null;
      const glow = p.kind === "heart" ? "#ff6a6a"
        : p.kind === "coin" ? "#ffd27a"
        : isMystery ? MYSTERY_COLOR
        : rarity !== null ? WEAPON_RARITY_COLOR[rarity]
        : "#ffb43b";
      const isLegendary = rarity === "legendary";
      ctx.save();
      ctx.globalAlpha = (0.3 + Math.abs(Math.sin(clock * 3)) * 0.15) * (isLegendary || isMystery ? 1.35 : 1);
      const glowR = isLegendary || isMystery ? 26 : 20;
      const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, glowR);
      g.addColorStop(0, glow);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, glowR, 0, 6.28); ctx.fill();
      ctx.restore();
      // Legendary and mystery pickups earn a slow-pulsing accent ring — the from-across-
      // the-room "that one is special" read.
      if (isLegendary || isMystery) {
        ctx.save();
        ctx.globalAlpha = 0.45 + Math.sin(clock * 2.2) * 0.2;
        ctx.strokeStyle = glow;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy + 2, 21 + Math.sin(clock * 2.2) * 2, 0, 6.28); ctx.stroke();
        ctx.restore();
      }
      // Boss weapon CHOICES (gate §4): a golden pedestal ring; dimmed once this player has
      // spent their one personal claim (teammates still see their own live options).
      if (p.isBossChoice) {
        ctx.save();
        const isSpent = this.p.hasClaimedBossChoice;
        ctx.globalAlpha = isSpent ? 0.25 : 0.55 + Math.sin(clock * 3) * 0.2;
        ctx.strokeStyle = isSpent ? "#8a8378" : "#ffd27a";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy + 2, 19, 0, 6.28); ctx.stroke();
        ctx.restore();
      }
      // Coins spin (scaleX crossing 0); hearts/guns gently shimmer-pulse.
      const spin = p.kind === "coin" ? Math.cos(clock * 4) : 1;
      const pulse = p.kind === "coin" ? 1 : 1 + Math.sin(clock * 4) * 0.08;
      // A mystery renders as a dark shrouded gun silhouette under a floating "?" — never
      // its real art (that would leak the identity in solo, where the sim is local).
      if (isMystery) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(pulse, pulse);
        if (this.sprites.ready("gun")) {
          ctx.globalAlpha = 0.9;
          ctx.filter = "brightness(0.25) saturate(0.4)";
          ctx.drawImage(this.sprites.get("gun"), -15, -15, 30, 30);
          ctx.filter = "none";
        } else {
          ctx.fillStyle = "#2a1f42";
          ctx.beginPath(); ctx.arc(0, 0, 10, 0, 6.28); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = MYSTERY_COLOR;
        ctx.font = "bold 13px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("?", 0, -14 + Math.sin(clock * 2.5) * 2);
        ctx.restore();
        continue;
      }
      // Weapon pickups draw their own 64px side-profile sprite so each gun is
      // recognizable on the floor; anything without dedicated art (or not yet loaded)
      // falls back to the generic "gun" sprite, then to a plain dot.
      const weaponImg = p.kind === "weapon" && p.weapon ? this.sprites.weaponPickup(p.weapon) : null;
      if (weaponImg) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(spin * pulse, pulse);
        ctx.drawImage(weaponImg, -19, -19, 38, 38);
        ctx.restore();
      } else if (this.sprites.ready(name)) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(spin * pulse, pulse);
        ctx.drawImage(this.sprites.get(name), -15, -15, 30, 30);
        ctx.restore();
      } else {
        ctx.fillStyle = p.kind === "heart" ? "#ff6a6a" : "#ffd27a";
        ctx.beginPath(); ctx.arc(sx, sy, 10, 0, 6.28); ctx.fill();
      }
      // Duplicate-weapon feedback (WEAPONS/PROGRESSION spec: an owned weapon is never
      // collected/swapped — it stays physical for an ally — so a walk-over with free
      // slots would otherwise be a silent no-op). Surface the proximity OWNED label the
      // moment the local player stands on a weapon they already carry, so "I have space
      // but nothing happens" reads as a rule, not a bug.
      if (
        this.isOwnedDuplicateWeapon(p) && !this.isDown && this.hp > 0
        && Math.hypot(this.px - p.x, this.py - p.y) < this.p.pr + p.radius
      ) {
        this.drawShopText("OWNED", sx, sy - 22, "#aeb9c4");
      }
    }
  }

  private renderCorpses() {
    const { ctx, renderCam: cam } = this;
    for (const c of this.corpses) {
      const p = c.t; // 0..1
      // A registered death sheet plays once over the corpse's lifetime (frame from elapsed
      // seconds, clamped to the last frame). The gib particles + splat decal still layer on
      // top from killEnemy. Ghost/spitter (no sheet) and any not-yet-loaded sheet fall
      // through to the procedural pop-and-fade below.
      const death = this.sprites.sheet(c.sprite, "death");
      if (death) {
        const fw = death.img.naturalHeight || FRAME;
        const count = Math.max(1, Math.round(death.img.naturalWidth / fw));
        const frame = Math.min(count - 1, Math.floor(p * c.dur * death.fps));
        const dsx = c.x - cam.x, dsy = c.y - cam.y;
        ctx.save();
        ctx.globalAlpha = p > 0.75 ? Math.max(0, 1 - (p - 0.75) / 0.25) : 1;
        ctx.translate(dsx, dsy);
        ctx.scale(c.facing, 1);
        ctx.drawImage(death.img, frame * fw, 0, fw, fw, -c.size / 2, -c.size / 2, c.size, c.size);
        ctx.restore();
        continue;
      }
      const grow = p < 0.2 ? 1 + (p / 0.2) * 0.4 : 1.4 - ((p - 0.2) / 0.8) * 1.4;
      const s = Math.max(0, grow);
      const sx = c.x - cam.x, sy = c.y - cam.y - p * 8;
      if (this.sprites.ready(c.sprite)) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p * p);
        ctx.translate(sx, sy);
        ctx.scale(c.facing * s, s * (1 - p * 0.4));
        ctx.drawImage(this.sprites.get(c.sprite), -c.size / 2, -c.size / 2, c.size, c.size);
        if (p < 0.3) {
          const f = this.sprites.flashSprite(c.sprite);
          if (f) { ctx.globalAlpha = (1 - p / 0.3) * 0.8; ctx.drawImage(f, -c.size / 2, -c.size / 2, c.size, c.size); }
        }
        ctx.restore();
      }
    }
  }

  private renderMuzzle() {
    if (this.muzzle.t <= 0) return;
    const { ctx, renderCam: cam } = this;
    const k = this.muzzle.t / MUZZLE_DUR; // 1..0
    const mx = this.muzzle.x - cam.x, my = this.muzzle.y - cam.y;
    const sz = this.muzzle.size;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(mx, my);
    ctx.rotate(this.muzzle.angle);
    // A weapon-tinted sprite glow at the barrel, over the procedural gradient below.
    const tint = this.sprites.fxTinted("glow_round", this.muzzle.color);
    if (tint) {
      const gs = (14 + sz * 4) * (0.6 + k * 0.6);
      ctx.globalAlpha = k * 0.9;
      ctx.drawImage(tint, -gs / 2, -gs / 2, gs, gs);
    }
    // Round core glow.
    const core = 6 + sz * 1.3;
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, core + k * 10);
    g.addColorStop(0, "#fff3c4");
    g.addColorStop(0.5, "#ffb43b");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = k;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, core + k * 10, 0, 6.28); ctx.fill();
    // Directional flash pointing down the barrel — bigger for beefier weapons.
    const len = (16 + sz * 4) * (0.5 + k * 0.5);
    const wdt = (3 + sz) * (0.4 + k * 0.6);
    ctx.fillStyle = "#fff3c4";
    ctx.beginPath();
    ctx.moveTo(0, -wdt);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, wdt);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private renderParticles() {
    const { ctx, renderCam: cam } = this;
    for (const p of this.particles) {
      const a = p.life / p.maxLife;
      if (a <= 0) continue;
      // Particles are pure cosmetic dressing (never a fairness cue), so an off-screen one
      // is skipped outright — a dense boss burst that throws flecks across a big arena
      // pays only for what the camera can actually see.
      if (!this.isNearCamera(p.x, p.y, 24)) continue;
      if (p.kind === "gib" || p.kind === "shell") {
        ctx.save();
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.translate(p.x - cam.x, p.y - cam.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.7);
        ctx.restore();
      } else if (p.kind === "sparkfx") {
        const img = this.sprites.fxTinted("spark", p.color);
        const sz = p.size * (0.6 + a * 0.6); // pop out then shrink as it fades
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.min(1, a);
        ctx.translate(p.x - cam.x, p.y - cam.y);
        ctx.rotate(p.rot);
        if (img) ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        else { ctx.fillStyle = p.color; ctx.fillRect(-sz / 4, -sz / 4, sz / 2, sz / 2); }
        ctx.restore();
      } else {
        ctx.globalAlpha = p.kind === "puff" ? Math.min(1, a) * 0.55 : Math.min(1, a);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - cam.x - p.size / 2, p.y - cam.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Floating damage numbers, drawn in world space over the particles. Pixel font with a
  // dark outline so they read on any background; crits are bigger + gold + a "!".
  private renderDmgNumbers() {
    const { ctx, renderCam: cam } = this;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of this.dmgNumbers) {
      const a = n.life / n.maxLife;
      if (a <= 0) continue;
      const sx = n.x - cam.x, sy = n.y - cam.y;
      // Crits pop in bigger then settle over the first third of their life.
      const pop = n.crit ? 1 + Math.max(0, (a - 0.66) / 0.34) * 0.4 : 1;
      const size = Math.round((n.crit ? 15 : 11) * pop);
      const label = n.crit ? `${n.value}!` : `${n.value}`;
      ctx.font = `700 ${size}px "Silkscreen", monospace`;
      ctx.globalAlpha = Math.min(1, a * 1.4); // hold full opacity, fade only at the end
      // dark outline
      ctx.fillStyle = "rgba(8,6,16,0.9)";
      ctx.fillText(label, sx + 1, sy + 1);
      ctx.fillText(label, sx - 1, sy + 1);
      ctx.fillStyle = n.color;
      ctx.fillText(label, sx, sy);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private renderWorldLabels() {
    if (this.worldLabels.length === 0) return;
    const { ctx, renderCam: cam } = this;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 10px "Silkscreen", monospace`;
    for (const l of this.worldLabels) {
      const a = l.life / l.maxLife;
      if (a <= 0) continue;
      const sx = l.x - cam.x, sy = l.y - cam.y;
      ctx.globalAlpha = Math.min(1, a * 1.4);
      ctx.fillStyle = "rgba(8,6,16,0.9)";
      ctx.fillText(l.text, sx + 1, sy + 1);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, sx, sy);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Coins arcing into the top-left wallet. Drawn in SCREEN space (after the world restore,
  // like the reticle/minimap) so they read as headed INTO the HUD, not sitting in the world:
  // each token lifts off its pickup spot (world->screen) and eases along an arc to the wallet
  // counter's live screen anchor, shrinking as it lands.
  private renderCoinFlies() {
    if (this.coinFlies.length === 0) return;
    const { ctx, renderCam: cam } = this;
    const anchor = this.walletAnchorScreen();
    ctx.save();
    for (const c of this.coinFlies) {
      const t = c.t < 0 ? 0 : c.t > 1 ? 1 : c.t;
      const e = t * t * (3 - 2 * t); // smoothstep ease
      const startX = c.x - cam.x, startY = c.y - cam.y;
      const px = startX + (anchor.x - startX) * e;
      const py = startY + (anchor.y - startY) * e - Math.sin(t * Math.PI) * COIN_FLY_ARC;
      const r = 5 * (1 - 0.5 * e); // shrinks into the counter
      ctx.globalAlpha = 0.9 * (1 - t * 0.2);
      ctx.fillStyle = "#ffd27a";
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.28);
      ctx.fill();
      ctx.strokeStyle = "rgba(120,80,20,0.8)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // A small inner highlight so the token reads as a coin, not a dot.
      ctx.globalAlpha *= 0.7;
      ctx.fillStyle = "#fff3c4";
      ctx.beginPath();
      ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.35, 0, 6.28);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // The ONE world-anchored interact nudge (UI-designer spec, item 6): a small boxed keycap
  // chip `[E] VERB` anchored just ABOVE the target of the verb, converted world->screen every
  // frame so it tracks as things move. Drawn in the SAME pass as renderWorldLabels (inside the
  // camera/shake transform, after entities), so it reads as a diegetic tag on the target
  // rather than a detached corner element. A two-pass boxed chip (dark backing + ink outline +
  // amber keycap) survives any biome floor and stays legible even when an enemy overlaps.
  // While a revive hold runs, the chip becomes the in-place "REVIVING N%" progress read.
  private renderInteractPrompt() {
    const p = this.interactPrompt;
    if (p === null) return;
    const sx = p.x - this.renderCam.x;
    // A very subtle idle bob (~0.5px) — no pulse/scale/glow.
    const bob = Math.sin(this.animClock * 2) * 0.5;
    const sy = p.y - this.renderCam.y + bob;
    const isProgress = p.progress !== null;
    // Progress read drops the keycap (it's a status, not a press); otherwise the nudge leads [E].
    this.drawKeyChip(sx, sy, isProgress ? null : "E", isProgress ? `REVIVING ${Math.round((p.progress ?? 0) * 100)}%` : p.verb);
  }

  // The shared world-anchored chip: a dark backing + 2px ink outline (legible over any floor /
  // under an enemy), an optional amber [KEY] keycap (the bright anchor), then the cream LABEL,
  // centered at (sx, sy) and pinned onscreen at the top. A null key is a status read (no keycap).
  // Reused by the interact nudge and the one-time ult-ready nudge.
  private drawKeyChip(sx: number, syIn: number, key: string | null, label: string) {
    const { ctx } = this;
    const sy = syIn < INTERACT_TOP_CLAMP ? INTERACT_TOP_CLAMP : syIn;
    ctx.save();
    ctx.font = '700 10px "Silkscreen", monospace';
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const keyPx = INTERACT_KEY_PX;
    const padX = 5, padY = 4, gap = 5;
    const labelW = ctx.measureText(label).width;
    const contentW = key === null ? labelW : keyPx + gap + labelW;
    const bw = contentW + padX * 2;
    const bh = keyPx + padY * 2;
    const bx = sx - bw / 2, by = sy - bh / 2;
    ctx.fillStyle = "rgba(5,3,11,0.82)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#120a24";
    ctx.strokeRect(bx, by, bw, bh);
    let cx = bx + padX;
    if (key !== null) {
      ctx.fillStyle = "#ffb43b";
      ctx.fillRect(cx, sy - keyPx / 2, keyPx, keyPx);
      ctx.fillStyle = "#120a24";
      ctx.textAlign = "center";
      ctx.fillText(key, cx + keyPx / 2, sy + 1);
      ctx.textAlign = "left";
      cx += keyPx + gap;
    }
    ctx.fillStyle = "#ffe9b0";
    ctx.fillText(label, cx, sy + 1);
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // The one-time "[F] <ULT> READY" nudge over the player, the first time the ult is castable per
  // run (reuses drawKeyChip). Fades in then out over its lifetime so it teaches without nagging.
  private renderUltReadyNudge() {
    const n = this.ultReadyNudge;
    if (n === null) return;
    const k = n.t / ULT_READY_NUDGE_SECONDS; // 0..1
    const alpha = k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
    const sx = this.px - this.renderCam.x;
    const sy = this.py - this.renderCam.y - INTERACT_OFFSET_REVIVE;
    this.ctx.save();
    this.ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    this.drawKeyChip(sx, sy, "F", n.verb);
    this.ctx.restore();
  }

  // The minimal PET ABILITY cue (PROTOCOL 46): a world-anchored tell ring over the local player
  // while the 0.30s wind-up plays and the verb's active-effect ring while a window is live (the
  // FETCH pull radius, the PEBBLEBRACE brace bubble, the NULLWAKE shimmer). All read purely off the
  // reconciled SelfWire timers, so it is reconnect-safe and never diverges from the authoritative
  // ability state. Per-verb effects that live on OTHER bodies (the STALK pip, the SLIMETRAIL patch)
  // render in their own passes off the enemy/hazard wires.
  private petVerbColor(verb: PetVerb): string {
    switch (verb) {
      case "fetch": return "#ffd166";
      case "pinprick": return "#ffdda0";
      case "stalk": return "#b98bff";
      case "emberpuff": return "#ff9a52";
      case "slimetrail": return "#8be86b";
      case "pebblebrace": return "#b9c4d6";
      case "rattle": return "#cfd8ff";
      case "nullwake": return "#6fe0d0";
    }
  }
  private petVerbReach(verb: PetVerb): number {
    switch (verb) {
      case "fetch": return PET_ABILITY.fetch.radius;
      case "stalk": return PET_ABILITY.stalk.radius;
      case "rattle": return PET_ABILITY.rattle.radius;
      case "emberpuff": return PET_ABILITY.emberpuff.radius;
      case "slimetrail": return PET_ABILITY.slimetrail.patchRadius;
      case "pinprick": case "pebblebrace": case "nullwake": return 64;
    }
  }
  private renderPetAbilityCue() {
    const p = this.p;
    const verb = petVerbFor(this.selfPet);
    if (verb === null || !this.isRunning || !this.isWorldRevealed || this.isDown) return;
    const ctx = this.ctx;
    const sx = this.px - this.renderCam.x;
    const sy = this.py - this.renderCam.y;
    const color = this.petVerbColor(verb);
    // Active tell: a ring that grows toward the verb's reach across the wind-up.
    if (p.petTellT > 0) {
      const k = 1 - Math.min(1, p.petTellT / PET_ABILITY.tellSec);
      const reach = this.petVerbReach(verb);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.4 * k;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 18 + (reach - 18) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Active FETCH pull window: a soft ring at the pull radius so the yank reads.
    if (p.petFetchT > 0) {
      ctx.save();
      ctx.globalAlpha = 0.2 + 0.2 * Math.min(1, p.petFetchT / PET_ABILITY.fetch.pulseSec);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, PET_ABILITY.fetch.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Active PEBBLEBRACE brace: a solid stone bubble hugging the body until it is spent.
    if (p.petShieldT > 0) {
      const pulse = 0.6 + 0.4 * Math.sin(this.animClock * 6);
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.35 * pulse;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, this.pr + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Active NULLWAKE window: a brief teal shimmer ring (the floor under the owner is voided).
    if (p.petNullT > 0) {
      ctx.save();
      ctx.globalAlpha = 0.3 + 0.4 * Math.min(1, p.petNullT / PET_ABILITY.nullwake.nullSec);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(sx, sy, this.pr + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // A charge mote's flight target: the bottom-left ult meter's center in canvas pixels, mapped
  // from the HUD element's live rect through the canvas's own rect/scale (lands correctly at any
  // UI zoom / window size). Null while the meter is hidden — the caller then drops its motes.
  private ultMeterAnchorScreen(): { x: number; y: number } | null {
    const rect = this.hud.ultFillRect();
    const cr = this.canvas.getBoundingClientRect();
    if (rect === null || cr.width === 0 || cr.height === 0) return null;
    const sx = this.canvas.width / cr.width, sy = this.canvas.height / cr.height;
    // The fill's LEADING EDGE (its right edge), vertically centered — the mote lands exactly here,
    // then triggers the leading-edge flash.
    return { x: (rect.right - cr.left) * sx, y: (rect.top + rect.height / 2 - cr.top) * sy };
  }

  // Charge motes: each orb lifts off its combat origin (world->screen) and eases along an arc
  // into the ult meter, shrinking as it lands. Additive so it reads as energy, kit-colored so it
  // matches the meter it feeds.
  private renderUltMotes() {
    if (this.ultMotes.length === 0) return;
    const anchor = this.ultMeterAnchorScreen();
    if (anchor === null) { this.ultMotes = []; return; } // meter hidden: no target, drop them
    const { ctx, renderCam: cam } = this;
    const color = isRealKit(this.p.kitId) ? KIT_ACCENT[this.p.kitId] : "#ffb43b";
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const m of this.ultMotes) {
      const t = m.t < 0 ? 0 : m.t > 1 ? 1 : m.t;
      const e = t * t * (3 - 2 * t); // smoothstep ease
      const startX = m.x - cam.x, startY = m.y - cam.y;
      const px = startX + (anchor.x - startX) * e;
      const py = startY + (anchor.y - startY) * e - Math.sin(t * Math.PI) * ULT_MOTE_ARC;
      const r = m.size * (1 - 0.35 * e); // shrinks into the meter
      ctx.globalAlpha = 0.85 * (1 - t * 0.15);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.28);
      ctx.fill();
      // A bright inner core so the orb reads as energy, not a flat dot.
      ctx.globalAlpha *= 0.8;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(px, py, r * 0.4, 0, 6.28);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // The wallet coin counter's center in canvas pixels (the coin token's flight target). Reads
  // the HUD chip's live rect and maps it through the canvas's own rect/scale, so it lands on
  // the counter at any UI zoom or window size; falls back to the top-left corner if the HUD
  // rect isn't measurable yet.
  private walletAnchorScreen(): { x: number; y: number } {
    const rect = this.hud.coinChipRect();
    const cr = this.canvas.getBoundingClientRect();
    if (rect === null || cr.width === 0 || cr.height === 0) return { x: 64, y: 44 };
    const sx = this.canvas.width / cr.width, sy = this.canvas.height / cr.height;
    return { x: (rect.left + rect.width / 2 - cr.left) * sx, y: (rect.top + rect.height / 2 - cr.top) * sy };
  }

  private renderDecals() {
    const { ctx, renderCam: cam } = this;
    for (const d of this.decals) {
      const k = d.t / d.life; // 0..1
      const sx = d.x - cam.x, sy = d.y - cam.y;
      ctx.save();
      if (d.kind === "ring") {
        // A quick expanding halo when loot drops.
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 4 + k * d.r, 0, 6.28);
        ctx.stroke();
      } else {
        // A splat that soaks in and fades over a few seconds.
        ctx.globalAlpha = (1 - k) * 0.4;
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(sx, sy, d.r * (0.7 + k * 0.3), 0, 6.28);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Tier-scaled sprite size: swarm 0.78x, brute 1.35x, elite 1.12x of the archetype draw.
  private enemyDrawSize(e: Enemy): number {
    return ENEMY_ARCHETYPES[e.kind].drawSize * TIERS[e.tier].drawMult;
  }

  private renderEnemies() {
    const { ctx, renderCam: cam } = this;
    for (const e of this.enemies) {
      const arch = ENEMY_ARCHETYPES[e.kind];
      const a = e.attack;
      const anim = this.animForEnemy(e);
      const sx = e.x - cam.x, sy = e.y - cam.y;
      const pose = this.enemyPoses.get(e.id) ?? computeEnemyPose(e, createFacing(), 0, 0, anim.move > 0.5);
      const isWindup = a.phase === "windup";
      const isBoss = isBossKind(e.kind);
      const isHopSlam = e.kind === "boss" && a.move === "hopslam";
      const drawSize = this.enemyDrawSize(e);

      // JET's mirror-image echo owns its entire look (AD hard gates): a near-black, translucent,
      // cold-rimmed, hollow-eyed, telegraphed reflection. Drawn fully here — skip the generic
      // body pass so the near-black value + <=40% opacity are guaranteed (never a bright body,
      // never a floating enemy bar that would read as a monster).
      if (e.kind === "jet_echo") { this.renderJetEcho(e, sx, sy, drawSize, pose, anim.clock); continue; }

      // An underground burrower (tunneling, or armed under its marker — the sim's
      // untargetable window) renders as a traveling mound, never a body: nothing to shoot
      // until it surfaces.
      const isUnderground = e.kind === "burrower"
        && ((a.move === "dive" && a.phase === "active") || (a.move === "erupt" && isWindup));
      if (isUnderground) {
        if (a.move === "erupt") this.renderDangerDisc(a.markX, a.markY, BURROW_ERUPT_RADIUS, a.windup);
        this.renderBurrowMound(e, sx, sy, drawSize, anim.clock);
        continue;
      }
      // The Choir mid-split is GONE — only a reforming shimmer marks where it will return.
      if (e.kind === "choir" && a.move === "split") {
        this.renderChoirSplit(e, sx, sy, drawSize, anim.clock);
        continue;
      }
      // QUORUM: the shared-HP CORE is hidden behind its husks until the merge — draw the
      // code-drawn amber tether that links the husks (the shared-HP tell) and skip the body.
      // Once merged (phase 2) the fused merge-form draws normally below.
      // Its guard/expose read is NOT an overlay toggle: it advances through 4 DISCRETE looks
      // driven by husk deaths + the merge flag — {shield+heal+dmg} -> shield-dead -> heal-dead
      // (the three directional husk sprites vanishing in kill-order) -> the merged core body
      // ("quorum" = quorum_merge, the single core swap point in assets.ts). The shield-husk
      // beams in renderQuorumTether are the taut-guarded / snapped-exposed read up to the merge.
      if (e.kind === "quorum" && (e.boss?.phase ?? 1) < 2) {
        this.renderQuorumTether(e);
        // P1 LOOP guard: the core is hidden while ANY husk stands. When the trio is cleared the
        // tether beams have snapped and the core is EXPOSED — draw the (now targetable) core body
        // so the player can shoot it during the window; it re-hides when the trio re-forms.
        const anyHuskAlive = this.enemies.some((o) => !o.dead
          && (o.kind === "quorum_shield" || o.kind === "quorum_heal" || o.kind === "quorum_dmg"));
        if (anyHuskAlive) continue;
      }
      // The Weaver airborne: no body to shoot — just the falling shadow on its landing mark.
      if (e.kind === "weaver" && a.move === "pounce" && a.phase === "active") {
        this.renderDangerDisc(a.markX, a.markY, WEAVER.pounceRadius, 1);
        this.renderPounceShadow(a.markX, a.markY, drawSize, a.windup);
        continue;
      }
      // The Weaver UP THE WALLS (P2 climb): out of reach, clinging translucent at her
      // perch — shoot the CLUTCH instead. Her aimed-silk charge pulses on the windup
      // channel so the volley is always read before it flies.
      if (e.kind === "weaver" && a.move === "dive" && a.phase === "active") {
        ctx.save();
        ctx.globalAlpha = 0.45;
        this.drawChar(ENEMY_ARCHETYPES.weaver.sprite, this.sprites.selectClip(ENEMY_ARCHETYPES.weaver.sprite, pose).clip, sx, sy - drawSize * 0.35, drawSize * 0.9, 1, IDENTITY_XFORM, 1, 0.45, a.windup * 0.8, anim.clock);
        ctx.restore();
        this.renderGhostShimmer(e, sx, sy - drawSize * 0.35);
        if (a.windup > 0.05) this.renderTelegraph(e, sx, sy - drawSize * 0.35);
        continue;
      }

      // A worker's build tell previews the EXACT construction footprint (the sim's own
      // site geometry): green rising markers where the divider / L-corner will stand.
      if (a.move === "build" && isWindup && !isBossKind(e.kind)) this.renderBuildFootprint(e);
      // Ground danger marker for the boss hop-slam (drawn under everything).
      if (isHopSlam && (isWindup || a.phase === "active")) this.renderSlamMarker(e);
      // The shrinking safe-ring of the boss arena squeeze.
      if (e.kind === "boss" && a.move === "squeeze") this.renderSqueeze(e);
      // MARROW's transition shield bubble (the interactive beat: kill the husks).
      if (e.kind === "marrow" && a.move === "shield" && isWindup) this.renderMarrowShield(e, sx, sy, drawSize);
      // The Weaver's pounce marker while it coils; the Warden's quake ring while it winds.
      if (e.kind === "weaver" && a.move === "pounce" && isWindup) this.renderDangerDisc(a.markX, a.markY, WEAVER.pounceRadius, a.windup);
      // The blink-strike's arrival mark (the lane itself draws via renderTelegraph).
      if (e.kind === "weaver" && a.move === "blink" && isWindup) this.renderDangerDisc(a.markX, a.markY, WEAVER.blinkStrikeRadius, a.windup);
      if (e.kind === "gilded" && a.move === "slam" && (isWindup || a.phase === "active")) {
        this.renderDangerDisc(a.markX, a.markY, GILDED.slamRadius, a.phase === "active" ? 1 : a.windup);
      }
      // Brutes/elites carry a colored ground ring so the tier reads before the first
      // hit; an elite's ring takes its AFFIX color (derived from kind — pure sim data),
      // so "gold ring = commander" is learnable at a glance.
      const ring = e.tier === "elite" ? AFFIX_RING_COLOR[eliteAffixOf(e.kind)] : TIER_RING_COLOR[e.tier];
      if (ring) this.renderTierRing(sx, sy, drawSize, ring);
      // A persistent emissive ground-ring beneath each deep boss in its family hue — reads
      // "setpiece" at a glance and DOUBLES as the guard/expose read (saturated + swelling
      // while GUARDED, drained + desaturated while EXPOSED). State = the authoritative aux
      // flag off the wire, never authored client-side.
      if (e.kind === "jet" || e.kind === "tithe" || e.kind === "quorum" || isGiantKind(e.kind)) this.renderBossAura(e, sx, sy, drawSize);
      // The reworked boss attacks' authoritative footprints (reusable parametric primitives),
      // drawn on the ground plane UNDER the body during their windup + active beats.
      if (this.isBossTelegraphMove(e) && (isWindup || a.phase === "active")) this.renderBossTelegraph(e, sx, sy);
      // The shield husk's persistent LOS-blocking barrier (drawn under the body while it lives).
      if (e.kind === "quorum_shield") this.renderShieldBarrier(e, sx, sy);

      // Ghost solidify reads as an opacity ramp; the Choir mid-fade is barely there;
      // everyone else uses the archetype alpha.
      const alpha = e.kind === "ghost" ? 0.62 + 0.38 * a.windup
        : e.kind === "choir" && a.move === "fade" && a.phase === "active" ? 0.3
        : arch.alpha;

      // The AD drop-in ladder: attack_<facing> -> attack -> walk_<facing> -> legacy
      // walk/idle -> static + procedural (see facing.ts). New directional/attack sheets
      // light up per sprite with zero further render changes.
      // JET swaps its whole body by fight phase (the escalation reads on the body): P1 the
      // directional uncanny mirror, P2 the desaturated out-of-sync frame, P3 the hot-veined
      // enrage. The Tithe's slab swaps intact -> cracked in place as its HP drops.
      let spriteName = arch.sprite;
      if (e.kind === "jet") {
        const ph = e.boss?.phase ?? 1;
        spriteName = ph >= 3 ? "jet_phase3" : ph === 2 ? "jet_phase2" : "jet";
      } else if (e.kind === "gorge") {
        // The GIANT swaps its whole SHELL by fight phase (the peel reads on the body):
        // P1 "gorge" (rind, dim/cold) → P2 chitin (cracked, hot edges) → P3 core (molten reveal).
        const ph = e.boss?.phase ?? 1;
        spriteName = ph >= 3 ? "gorge_shell_core" : ph === 2 ? "gorge_shell_chitin" : "gorge";
      } else if (e.kind === "pale") {
        // The PALE THRONE giant swaps its cold SHELL by phase (same peel read as Gorge):
        // P1 "pale" (stone, dormant/cold) → P2 cracked (cold-blue seams) → P3 core (cold-blaze reveal).
        const ph = e.boss?.phase ?? 1;
        spriteName = ph >= 3 ? "pale_shell_core" : ph === 2 ? "pale_shell_cracked" : "pale";
      } else if (e.kind === "tithe_slab" && e.hp <= e.maxHp * 0.5) {
        spriteName = "tithe_slab_cracked";
      } else if (e.kind === "tithe" && this.isEnemyExposed(e) && this.sprites.sheet("tithe_exposed", "idle") !== null) {
        // EXPOSED — swap to the slumped body pose the instant the guard drops (hard swap).
        // Guarded until its PNG lands so we never flash a disc; the shimmer dome toggles below.
        spriteName = "tithe_exposed";
      }
      const choice = this.sprites.selectClip(spriteName, pose);
      const facing = choice.isMirrored ? -1 : 1;
      const xf = characterXform(anim, isBoss ? BOSS_STYLE : CHARACTER_STYLE);
      let extra = 1;
      // Skeleton and charger coil down (squash) as their line commitments charge.
      if ((e.kind === "skeleton" || e.kind === "charger") && isWindup && a.move !== "none") { xf.sx += 0.28 * a.windup; xf.sy -= 0.24 * a.windup; }
      // Mid-rush stretch along the lane; post-crash dizzy wobble (the punish window tell).
      if (a.move === "rush" && a.phase === "active") { xf.sx += 0.18; xf.sy -= 0.12; }
      if (a.move === "crash" && a.phase === "recover") { xf.rot += Math.sin(anim.clock * 11) * 0.14; xf.sy -= 0.08; }
      // Boss inflates for radial/roar/squeeze telegraphs and lifts off the ground mid-slam.
      if (e.kind === "boss") {
        if (isWindup && (a.move === "radial" || a.move === "roar" || a.move === "squeeze")) extra = 1 + a.windup * 0.16;
        if (isHopSlam && a.phase === "windup") xf.sy -= 0.18 * a.windup; // crouch before the leap
        if (isHopSlam && a.phase === "active") { xf.oy -= Math.sin(a.windup * Math.PI) * BOSS_JUMP_HEIGHT; extra = 1.08; }
      }
      // The MARROW inflates for its spiral/shield telegraphs; the Choir for its fade and
      // the Warden for its sweep/sanctify; the Weaver coils down before the leap.
      if (e.kind === "marrow" && isWindup && (a.move === "spin" || a.move === "shield")) extra = 1 + a.windup * 0.14;
      if (e.kind === "choir" && isWindup && a.move === "fade") extra = 1 + a.windup * 0.12;
      if (e.kind === "gilded" && isWindup && (a.move === "sweep" || a.move === "roar")) extra = 1 + a.windup * 0.14;
      if (e.kind === "weaver" && isWindup && a.move === "pounce") { xf.sy -= 0.22 * a.windup; xf.sx += 0.14 * a.windup; }
      // The GIANT rumbles (a subtle tectonic swell) as its shell winds up to crack/slam/sweep.
      if (isGiantKind(e.kind) && isWindup && a.move !== "none") extra = 1 + a.windup * 0.06;
      if (isGiantKind(e.kind) && isWindup && a.move === "roar") {
        xf.sx += a.windup * 0.16;
        xf.sy -= a.windup * 0.18;
        xf.oy -= Math.sin(a.windup * Math.PI) * 10;
      }
      // A white pulse on the sprite intensifies as the windup nears release.
      const pulse = 0.55 + 0.45 * Math.sin(anim.clock * 13);
      const telegraphFlash = isWindup ? a.windup * pulse * 0.85 : 0;
      this.drawChar(spriteName, choice.clip, sx, sy, drawSize, facing, xf, extra, alpha, Math.max(anim.flash, telegraphFlash), anim.clock, null, choice.isHoldFirstFrame);

      // JET's EXPOSE overlay: one reusable crack+desaturate layer composited over whatever
      // phase body just drew, the instant the guard drops (hard swap — no tween, so the short
      // exposed window reads on frame one). The composite draws nothing until its PNG lands
      // (the procedural expose glow below carries the read meanwhile).
      if (e.kind === "jet" && this.isEnemyExposed(e)) this.compositeBodyOverlay("jet_expose", sx, sy, drawSize, facing, xf, extra, anim.clock);

      // GIANT CORE (phase 3 only): the bared core is the ONE bright material read on the body — an
      // additive glow blooms over it (the dim earlier shells stay dark). Gorge = molten AMBER; Pale
      // = a cold-white/blue crystalline blaze (a "blazing absence of warmth"). Same beat, per-giant hue.
      if (isGiantKind(e.kind) && (e.boss?.phase ?? 1) >= 3) {
        const mat = GIANT_MATERIAL[e.kind];
        const corePulse = 0.6 + 0.4 * Math.sin(anim.clock * 6);
        this.fxLayer("glow_round", mat.coreGlow, sx, sy, drawSize * 0.72 * corePulse, drawSize * 0.72 * corePulse, 0.5, 0);
        this.fxLayer("core_dot", mat.coreDot, sx, sy, drawSize * 0.3, drawSize * 0.3, 0.72 * corePulse, 0);
      }

      // Elemental status overlays (burn ember glow / chill frost / freeze crust / shock crackle).
      if (e.burn > 0 || e.chill > 0 || e.shock > 0) this.renderEnemyStatus(e, sx, sy, drawSize);

      // PHANTOM MARK (Wave 2): a pulsing violet vulnerability ring the whole team reads (the mark
      // is shared authoritative state on the wire). A pure cosmetic read off e.markT.
      if (e.markT > 0) this.renderMarkGlow(e, sx, sy, drawSize);

      // Cat STALK info pip (v46): a small caret above a marked body. Pure info (never a threat
      // signal), so it stays quiet and small — distinct from the PHANTOM vulnerability ring.
      if (e.petMarkT > 0) this.renderStalkPip(e, sx, sy, drawSize);

      // The shielder's guard arc — drawn from the sim's authoritative block angle.
      if (e.kind === "shielder") this.renderShielderGuard(e, sx, sy, drawSize);
      // The formation guards: the rootward's slow arc, the marshal's P1 frontage (its
      // aux channel carries the captain phase — 2 means the shield already shattered).
      if (e.kind === "rootward") this.renderGuardArc(e, sx, sy, drawSize, ROOTWARD_GUARD_ARC, ENEMY_ARCHETYPES.rootward.tint);
      if (e.kind === "marshal" && e.aux < 2) this.renderGuardArc(e, sx, sy, drawSize, MARSHAL.guardArc, ENEMY_ARCHETYPES.marshal.tint);
      // A bulwark elite's directional plate (aux = remaining plate HP; 0 = shattered).
      if (e.tier === "elite" && e.aux > 0 && eliteAffixOf(e.kind) === "bulwark") {
        this.renderGuardArc(e, sx, sy, drawSize, ELITE_BULWARK.arc, AFFIX_RING_COLOR.bulwark);
      }
      // Rolled elite affix (Wave 1): the material tell — a crust slab, a glassy amber facet
      // (armed vs cracked), heated dead-amber veins, pre-cracked seams, or a dripping element.
      if (e.rollAffix !== "") this.renderRollAffix(e, sx, sy, drawSize, anim.clock);
      // The caskbellows' rear crank: the weak point marked on its back between volleys.
      if (e.kind === "caskbellows") this.renderCaskCrank(e, sx, sy, drawSize);
      // The stoked sinderling burns visibly — armed state rides the aux channel.
      if (e.kind === "sinderling" && e.aux === 1) {
        const emberPulse = 0.6 + 0.4 * Math.sin(anim.clock * 9);
        this.fxLayer("glow_round", "#ff8a3b", sx, sy, drawSize * 1.1 * emberPulse, drawSize * 1.1 * emberPulse, 0.4, 0);
      }
      // A GIANT's tectonic WEAK-POINT (seam): a crack-node showing the core material through the
      // shell (Gorge hot amber / Pale cold blue). An additive glow over the small chunk reads
      // "shoot me to peel"; the hit flash brightens it, and the floating bar (below) reads progress.
      if (isGiantSeamKind(e.kind)) {
        const mat = giantSeamMaterial(e.kind);
        const seamPulse = 0.6 + 0.4 * Math.sin(anim.clock * 7 + e.id);
        this.fxLayer("glow_round", mat.seamGlow, sx, sy, drawSize * (0.95 + 0.25 * seamPulse), drawSize * (0.95 + 0.25 * seamPulse), 0.5 + 0.4 * anim.flash, 0);
        this.fxLayer("core_dot", mat.seamDot, sx, sy, drawSize * 0.5, drawSize * 0.5, 0.85 * seamPulse, 0);
        if (e.kind === "pale_seam" && e.aux > 0) {
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = e.aux === 1 ? "#57b6ff" : "#e5f8ff";
          ctx.lineWidth = e.aux === 1 ? 3 : 2;
          ctx.setLineDash(e.aux === 1 ? AIM_SOLID : [4, 3]);
          ctx.beginPath();
          ctx.arc(sx, sy, drawSize * 0.62, e.aux === 1 ? -2.6 : -0.55, e.aux === 1 ? 2.6 : 5.73);
          ctx.stroke();
          ctx.setLineDash(AIM_SOLID);
          ctx.restore();
        }
      }
      // SEVER F55 mechanic bodies wear the Weaver placeholder sprite, so — like the giant
      // seams above — the client paints the "shoot me" read the shared sheet can't. The
      // intercept trap anchors (aux===0) get a steady amber resin marker + a BREAK label;
      // the WORLDSPLIT tooth (aux===1) is deliberately LOUDER so it out-reads the anchors.
      if (e.kind === "sever_anchor") this.renderSeverAnchor(e, sx, sy, drawSize, anim.clock);
      if (this.isDevHitRadiusVisible && isGiantKind(e.kind)) {
        ctx.save();
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = "#ff4d4d";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(sx, sy, e.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash(AIM_SOLID);
        ctx.restore();
      }
      // Decoys wear their fuse: the echo fades out, the knell blinks faster as it arms.
      if (e.kind === "echo" || e.kind === "knell") this.renderDecoyFuse(e, sx, sy, drawSize, anim.clock);
      // The Weaver's lattice: every knot casts its three thread-lines (the blink lanes,
      // crossing AT the shootable node) and glows as the mechanic target it is.
      if (e.kind === "knot") this.renderKnotLattice(e, sx, sy, drawSize, anim.clock);
      // The egg-sac swells: a soft clutch pulse — "shoot these to bring her down".
      if (e.kind === "sac") {
        const swell = 0.5 + 0.5 * Math.sin(anim.clock * 4 + e.id);
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.25 * swell;
        ctx.strokeStyle = ENEMY_ARCHETYPES.sac.tint;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, drawSize * (0.42 + 0.05 * swell), 0, 6.28); ctx.stroke();
        ctx.restore();
      }
      // An earned-window boss wears its state: a thread-dim guard rim while GUARDED, a
      // blazing core through the EXPOSED window (aux = the authoritative remainder —
      // the Warden's plate below renders its own gold flavor of the same read).
      if (e.kind === "weaver" || e.kind === "marrow" || e.kind === "choir"
        || e.kind === "jet" || e.kind === "tithe" || e.kind === "quorum" || isGiantKind(e.kind)) {
        this.renderEarnedWindow(e, sx, sy, drawSize);
      }
      // The fragment's tether: the authoritative source id rides aux; the line IS the lane.
      if (e.kind === "fragment" && e.aux > 0) this.renderFragmentTether(e);
      // The Warden's plate: a gold sheen while closed, a cracked-open core glow while EXPOSED.
      if (e.kind === "gilded") this.renderGildedPlate(e, sx, sy, drawSize);

      // Shimmer flecks while a ghost is materializing.
      if (e.kind === "ghost" && a.windup > 0.05 && a.windup < 0.98) this.renderGhostShimmer(e, sx, sy);
      // The Choir mid-fade shimmers like its wisp kin (intangible — hold your fire).
      if (e.kind === "choir" && a.move === "fade" && a.phase === "active") this.renderGhostShimmer(e, sx, sy);
      // Aura + aim line for a charging attack (the reworked boss moves draw their dedicated
      // ground-plane footprints above instead, so skip the generic aura for them).
      if (isWindup && !this.isBossTelegraphMove(e)) this.renderTelegraph(e, sx, sy);

      const barW = isBoss ? 64 : 32;
      const barY = sy - drawSize / 2 - 8;
      // QUORUM husks share the core's pool (shown on the HUD boss bar + the tether), so their
      // own floating bar reads their BREAK INTEGRITY (aux) in amber — the "focus this husk" tell.
      const isHusk = e.kind === "quorum_shield" || e.kind === "quorum_heal" || e.kind === "quorum_dmg";
      // A resin anchor / WORLDSPLIT tooth reads its progress in amber — the "break this" tell,
      // matching its ground marker (and the WORLDSPLIT tooth burns a shade hotter than the anchors).
      const isBreakTarget = e.kind === "sever_anchor";
      const barFrac = isHusk ? e.aux : Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "#000"; ctx.fillRect(sx - barW / 2, barY, barW, 4);
      ctx.fillStyle = isHusk ? "#c77320"
        : isBreakTarget ? (e.aux === 1 ? "#ffd27a" : "#f2a63b")
        : isBoss ? "#ffb43b" : "#ff5a5a";
      ctx.fillRect(sx - barW / 2, barY, barW * barFrac, 4);
    }
  }

  // Dynamic ground hazards, each in its own language: the Weaver's violet web lattices,
  // the sinderling's burning cinders, a volatile elite's blinking fused charge. Ground
  // FX like the danger markers — the hazards themselves are authoritative sim state.
  private renderHazards() {
    if (this.hazards.length === 0) return;
    const { ctx, renderCam: cam } = this;
    // AD Part 2: as JET's corruption creeps in, the SAFE POCKET (the uncorrupted interior) is
    // washed a touch warmer/lighter in DEAD-amber (never hero-bright) so the eye finds it as the
    // arena darkens — it is what the player hunts. Drawn UNDER the drain patches.
    this.renderCorruptSafePocket();
    // The Weaver's committed lane flares through its whole dash tell: silk near the
    // locked thread (her position to the exit mark) burns bright — the read.
    const dasher = this.enemies.find((e) => e.kind === "weaver" && e.attack.move === "rush" && e.attack.phase === "windup");
    const isOnFlareLane = (hx: number, hy: number): boolean => {
      if (!dasher) return false;
      const a = dasher.attack;
      const dx = a.markX - dasher.x, dy = a.markY - dasher.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) return false;
      const t = Math.max(0, Math.min(1, ((hx - dasher.x) * dx + (hy - dasher.y) * dy) / len2));
      return Math.hypot(hx - (dasher.x + dx * t), hy - (dasher.y + dy * t)) < 60;
    };
    ctx.save();
    for (const h of this.hazards) {
      const sx = h.x - cam.x, sy = h.y - cam.y;
      const fade = Math.min(1, h.life / Math.max(0.001, h.maxLife) * 3); // holds, then fades out
      if (h.kind === "omen") {
        // The ambush tell: an urgent bloom that swells as the body's arrival nears —
        // "something is about to be HERE" reads before anything exists to hurt you.
        const urgency = 1 - h.life / Math.max(0.001, h.maxLife);
        const blink = 0.5 + 0.5 * Math.sin(this.animClock * (10 + urgency * 14));
        ctx.globalAlpha = 0.3 + 0.5 * urgency * blink;
        ctx.strokeStyle = "#e6c2ff";
        ctx.lineWidth = 2 + 1.5 * urgency;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius * (0.5 + 0.5 * urgency), 0, 6.28); ctx.stroke();
        ctx.globalAlpha = 0.14 + 0.2 * urgency;
        ctx.fillStyle = "#e6c2ff";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius * (0.5 + 0.5 * urgency), 0, 6.28); ctx.fill();
        continue;
      }
      if (h.kind === "cinder") {
        // Burning ground: an ember-orange pool with a flickering core.
        const flicker = 0.7 + 0.3 * Math.sin(this.animClock * 11 + h.id * 1.9);
        ctx.globalAlpha = 0.26 * fade * flicker;
        ctx.fillStyle = "#ff8a3b";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.5 * fade * flicker;
        ctx.fillStyle = "#ffd27a";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius * 0.4, 0, 6.28); ctx.fill();
        continue;
      }
      if (h.kind === "corrupt") {
        // AD Part 2: the corruption RECEDES — a recessive, low-contrast, desaturated cold-blue
        // fill that sits WITHIN the floor value band (mood, never a danger signal, never
        // competing with bullets/telegraphs/enemies). The DRAIN ZONE is the actual hazard, so
        // its EDGE reads FIRST: a BRIGHT authored hatched danger-edge in the reserved telegraph
        // register, kept COLD (distinct from the hot attack register) so it reads as JET's
        // persistent corruption. Dark-on-dark gate: the bright edge always wins over the creep.
        ctx.globalAlpha = 0.20 * fade; // recessive fill (mood)
        ctx.fillStyle = JET_CORRUPT_FILL;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
        const blink = 0.75 + 0.25 * Math.sin(this.animClock * 5 + h.id * 1.3);
        ctx.globalAlpha = (0.7 + 0.2 * blink) * fade;
        ctx.strokeStyle = JET_CORRUPT_EDGE;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]); // hatched danger-edge (the reserved register language)
        ctx.beginPath(); ctx.arc(sx, sy, h.radius - 1, 0, 6.28); ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      if (h.kind === "charge") {
        // The volatile fuse: a red ring that blinks faster as the burst approaches —
        // "step off the corpse" needs no tutorial.
        const urgency = 1 - h.life / Math.max(0.001, h.maxLife);
        const blink = 0.5 + 0.5 * Math.sin(this.animClock * (8 + urgency * 22));
        ctx.globalAlpha = 0.25 + 0.55 * urgency * blink;
        ctx.strokeStyle = "#ff5a3b";
        ctx.lineWidth = 2 + 2 * urgency;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.stroke();
        ctx.globalAlpha = 0.12 + 0.14 * urgency * blink;
        ctx.fillStyle = "#ff5a3b";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
        continue;
      }
      if (h.kind === "slime") {
        // Baby Slime SLIMETRAIL: a low, gooey green patch — ally-safe, enemy-slowing. Quiet floor
        // residue (never a danger tell), so it sits under bodies/telegraphs like other residue.
        const wob = 0.85 + 0.15 * Math.sin(this.animClock * 4 + h.id * 2.1);
        ctx.globalAlpha = 0.22 * fade * wob;
        ctx.fillStyle = "#5fbf4a";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.42 * fade;
        ctx.strokeStyle = "#8be86b";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.stroke();
        continue;
      }
      if (h.kind === "tar") {
        // PVP WAVE 2 tar_bloom: a dark, oily slow patch — ambient, ZERO damage, so it reads as
        // sticky FLOOR (a tempo cost), never a danger tell: a low dark fill with a slow-wobbling
        // sheen rim and no hot register.
        const wob = 0.85 + 0.15 * Math.sin(this.animClock * 3 + h.id * 1.7);
        ctx.globalAlpha = 0.34 * fade * wob;
        ctx.fillStyle = "#241a2e";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.26 * fade;
        ctx.fillStyle = "#3b2c49";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius * 0.6, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.4 * fade;
        ctx.strokeStyle = "#6b5a7e";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.stroke();
        continue;
      }
      if (h.kind === "spark") {
        // PVP WAVE 2 spark_mine: a telegraph fuse — an electric ring that crackles faster as the
        // blast nears (urgency = age), in a cold white-blue distinct from the charge's hot red so
        // "step off this ring" reads on any floor.
        const urgency = 1 - h.life / Math.max(0.001, h.maxLife);
        const blink = 0.5 + 0.5 * Math.sin(this.animClock * (9 + urgency * 26));
        ctx.globalAlpha = 0.3 + 0.55 * urgency * blink;
        ctx.strokeStyle = "#8fdcff";
        ctx.lineWidth = 2 + 2.5 * urgency;
        ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.stroke();
        ctx.globalAlpha = (0.1 + 0.2 * urgency) * blink;
        ctx.fillStyle = "#d6f2ff";
        ctx.beginPath(); ctx.arc(sx, sy, h.radius * (0.35 + 0.3 * urgency), 0, 6.28); ctx.fill();
        continue;
      }
      const isFlaring = isOnFlareLane(h.x, h.y);
      ctx.globalAlpha = (isFlaring ? 0.85 : 0.34) * fade;
      ctx.strokeStyle = isFlaring ? "#ffd27a" : "#c98bff";
      ctx.lineWidth = isFlaring ? 2.5 : 1.5;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * 6.28 + h.id * 0.7;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(ang) * h.radius, sy + Math.sin(ang) * h.radius);
        ctx.stroke();
      }
      for (let ring = 1; ring <= 2; ring++) {
        ctx.beginPath();
        ctx.arc(sx, sy, h.radius * (ring / 2.4), 0, 6.28);
        ctx.stroke();
      }
      ctx.globalAlpha = (isFlaring ? 0.22 : 0.1) * fade;
      ctx.fillStyle = isFlaring ? "#ffd27a" : "#c98bff";
      ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
    }
    ctx.restore();
  }

  // Weapon ground effects (the effect wave's floor layer): Frostline chill zones and
  // Snapwire trip lines. Sprite-mask hooks (frost_zone / wire_post) recolor like every
  // fx primitive; until the art lands the primitive fallback keeps them fully readable.
  //
  // COMBAT ATTENTION POLICY: weapon residue renders on the floor pass, UNDER every enemy
  // body and telegraph marker, and always quieter than any telegraph — the residue caps
  // below tell alphas by a wide margin. A REMOTE teammate's persistent effects simplify
  // aggressively (REMOTE_EFFECT_ALPHA rims/lines, no fills, no blink pulses): their
  // information matters, their brightness never competes with an enemy windup.
  private renderGroundEffects() {
    const { ctx, cam } = this;
    let isDrawing = false;
    for (const e of this.effects) {
      if (e.kind !== "zone" && e.kind !== "wire" && e.kind !== "sanctuary") continue;
      if (!isDrawing) { ctx.save(); isDrawing = true; }
      const isRemote = e.owner !== LOCAL_ID;
      if (e.kind === "sanctuary") {
        // The MENDER heal pocket: a soft warm ring + gentle inward pulse — a safe-stand zone,
        // never a telegraph, so it stays quiet under enemy tells.
        const sx = e.x - cam.x, sy = e.y - cam.y;
        const fade = Math.min(1, (e.maxLife - e.life) * 6, (e.life / Math.max(0.001, e.maxLife)) * 2.5);
        const pulse = 0.85 + 0.15 * Math.sin(this.animClock * 3);
        ctx.globalAlpha = 0.12 * fade;
        ctx.fillStyle = "#7fe6a8";
        ctx.beginPath(); ctx.arc(sx, sy, e.radius, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.5 * fade;
        ctx.strokeStyle = "#b8ffd0";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, e.radius * pulse, 0, 6.28); ctx.stroke();
        continue;
      }
      if (e.kind === "zone") {
        const sx = e.x - cam.x, sy = e.y - cam.y;
        const isPaved = e.isPaved;
        const tint = isPaved ? "#a8d7a0" : "#9fd8ff";
        // Quick fade-in as the bead paints it, long fade-out as it thaws.
        const fade = Math.min(1, (e.maxLife - e.life) * 8, (e.life / Math.max(0.001, e.maxLife)) * 2.5);
        if (isRemote) {
          // Remote zones: a thin rim only — the lane reads, nothing glows.
          ctx.globalAlpha = 0.22 * fade;
          ctx.strokeStyle = tint;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(sx, sy, isPaved ? e.radius : e.radius * 0.92, 0, 6.28); ctx.stroke();
          continue;
        }
        const mask = this.sprites.fxTinted(isPaved ? "pave_zone" : "frost_zone", tint)
          ?? (isPaved ? this.sprites.fxTinted("frost_zone", tint) : null);
        if (mask) {
          ctx.save();
          if (isPaved) {
            ctx.beginPath();
            ctx.arc(sx, sy, e.radius, 0, 6.28);
            ctx.clip();
          }
          ctx.globalAlpha = 0.5 * fade;
          ctx.drawImage(mask, sx - e.radius, sy - e.radius, e.radius * 2, e.radius * 2);
          ctx.restore();
        } else {
          ctx.globalAlpha = 0.16 * fade;
          ctx.fillStyle = tint;
          ctx.beginPath(); ctx.arc(sx, sy, e.radius, 0, 6.28); ctx.fill();
          ctx.globalAlpha = 0.4 * fade;
          ctx.strokeStyle = isPaved ? "#dff2d8" : "#cdeaff";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sx, sy, isPaved ? e.radius : e.radius * 0.92, 0, 6.28); ctx.stroke();
        }
      } else {
        const ax = e.x - cam.x, ay = e.y - cam.y;
        const bx = e.x2 - cam.x, by = e.y2 - cam.y;
        if (isRemote) {
          // Remote wires: one dim steady line — no posts, no blink (their arm state is
          // their owner's problem; the geometry is all a teammate needs).
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = "#b8b04a";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          continue;
        }
        // Arming wires blink; live wires hold a taut hum-bright line.
        const isArming = e.arm > 0;
        const blink = isArming ? 0.35 + 0.3 * Math.sin(this.animClock * 18) : 1;
        ctx.globalAlpha = 0.85 * blink;
        ctx.strokeStyle = isArming ? "#b8b04a" : "#e8e05a";
        ctx.lineWidth = isArming ? 1 : 2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "#e8e05a";
        for (const [px, py] of [[ax, ay], [bx, by]] as const) {
          const post = this.sprites.fxTinted("wire_post", "#e8e05a");
          if (post) ctx.drawImage(post, px - 5, py - 5, 10, 10);
          else ctx.fillRect(px - 2, py - 4, 4, 8);
        }
      }
    }
    if (isDrawing) ctx.restore();
  }

  // Weapon effect bodies: Prism Sentries, Razor Halo blades, and Crooked Chain links.
  // The halo centers on its owner's RENDERED position when that player is on screen
  // (the local player especially — the 20Hz effect anchor would lag the predicted body).
  private renderEffectEntities() {
    const { ctx, cam } = this;
    this.pruneSentryFx();
    let isDrawing = false;
    for (const e of this.effects) {
      // zone/wire/sanctuary render on the GROUND pass (renderGroundEffects); aegis + the
      // entity-kinds below draw here.
      if (e.kind === "zone" || e.kind === "wire" || e.kind === "sanctuary") continue;
      if (!isDrawing) { ctx.save(); isDrawing = true; }
      if (e.kind === "aegis") {
        // The BULWARK dome: a translucent bullet-blocking bubble whose rim brightens with the
        // remaining barrier budget, dimming as it is spent — COVER, never immunity.
        const sx = e.x - cam.x, sy = e.y - cam.y;
        const frac = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
        ctx.globalAlpha = 0.10 + 0.10 * frac;
        ctx.fillStyle = "#8fb6ff";
        ctx.beginPath(); ctx.arc(sx, sy, e.radius, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 0.35 + 0.5 * frac;
        ctx.strokeStyle = "#bcd4ff";
        ctx.lineWidth = 2 + 2 * frac;
        ctx.beginPath(); ctx.arc(sx, sy, e.radius, 0, 6.28); ctx.stroke();
        continue;
      }
      if (e.kind === "sentry") {
        const sx = e.x - cam.x, sy = e.y - cam.y;
        ctx.globalAlpha = 1;
        // A live turret READS live: an idle breathing pulse/bob so a placed sentry never
        // freezes, a barrel that tracks the last-acquired target (persisted from sentryShot),
        // and a brief recoil kick + muzzle flare right after a shot.
        const fx = this.sentryFx.get(e.id);
        const aim = fx ? fx.aim : this.animClock * 1.4; // never fired yet: a slow idle sweep
        const recoil = fx ? Math.max(0, 1 - (this.animClock - fx.firedAt) / SENTRY_RECOIL_TIME) : 0;
        const pulse = 1 + Math.sin(this.animClock * 4 + e.id * 1.7) * 0.05;
        const bob = Math.sin(this.animClock * 2.4 + e.id * 0.9) * 1.4;
        const kick = recoil * 4; // the whole body kicks back opposite the shot
        const bcx = sx - Math.cos(aim) * kick;
        const bcy = sy + bob - Math.sin(aim) * kick;
        const core = this.sprites.fxTinted("sentry_core", "#c8a8ff");
        // The barrel muzzle: a short nub toward the target, recoiling into the body on fire.
        const barrel = e.radius + 6 - recoil * 5;
        const mx = bcx + Math.cos(aim) * barrel, my = bcy + Math.sin(aim) * barrel;
        ctx.strokeStyle = "#e0d0ff";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(bcx, bcy); ctx.lineTo(mx, my); ctx.stroke();
        if (recoil > 0.55) { // muzzle flare on the freshest frames of a shot
          ctx.fillStyle = "#f0e6ff";
          ctx.beginPath(); ctx.arc(mx, my, 2 + recoil * 2, 0, 6.28); ctx.fill();
        }
        if (core) {
          const r = e.radius * 1.4 * pulse;
          ctx.save();
          ctx.translate(bcx, bcy);
          ctx.rotate(aim); // the turret body faces its target
          ctx.drawImage(core, -r, -r, r * 2, r * 2);
          ctx.restore();
        } else {
          ctx.fillStyle = "#3a2f52";
          ctx.beginPath(); ctx.arc(bcx, bcy, e.radius * pulse, 0, 6.28); ctx.fill();
          ctx.strokeStyle = "#c8a8ff";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(bcx, bcy, e.radius * pulse - 2, 0, 6.28); ctx.stroke();
        }
        // Durability pips over the body — a destructible deployable must read as one.
        if (e.hp >= 0 && e.maxHp > 0 && e.hp < e.maxHp) {
          const w = e.radius * 2;
          ctx.fillStyle = "#1c1826";
          ctx.fillRect(sx - w / 2, sy - e.radius - 8, w, 3);
          ctx.fillStyle = "#c8a8ff";
          ctx.fillRect(sx - w / 2, sy - e.radius - 8, w * Math.max(0, e.hp / e.maxHp), 3);
        }
      } else if (e.kind === "orbit") {
        const ownerPos = this.effectOwnerPos(e);
        const cx = ownerPos[0] - cam.x, cy = ownerPos[1] - cam.y;
        if (e.owner !== LOCAL_ID) {
          // A teammate's ring: simple dim dots, no blades, no ring line — position and
          // cadence read; nothing competes with enemy telegraphs.
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = "#d8f0e8";
          for (let i = 0; i < e.blades; i++) {
            const a = e.angle + (i / Math.max(1, e.blades)) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * e.ring, cy + Math.sin(a) * e.ring, 3, 0, 6.28);
            ctx.fill();
          }
          continue;
        }
        const visualSpeed = this.haloVisualSpeed(e);
        const strength = haloVisualStrength(e.blades, e.bladeRadius, visualSpeed);
        const tier = haloVisualTier(e.blades, e.bladeRadius, visualSpeed);
        const flare = Math.min(1, e.flare / 0.45);
        const pulse = settings.isReducedMotion
          ? 0.5
          : 0.5 + Math.sin(this.animClock * (3 + strength * 2) + e.id) * 0.5;
        const glow = this.sprites.fxTinted("glow_round", "#d8f0e8");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        if (glow) {
          const coreRadius = 10 + strength * 8 + flare * 4;
          ctx.globalAlpha = 0.06 + strength * 0.1 + pulse * 0.03 + flare * 0.08;
          ctx.drawImage(glow, cx - coreRadius, cy - coreRadius, coreRadius * 2, coreRadius * 2);
        }
        ctx.strokeStyle = "#d8f0e8";
        ctx.lineCap = "round";
        const trailArc = 0.09 + strength * 0.26 + flare * 0.08;
        for (let layer = 0; layer <= tier; layer++) {
          ctx.globalAlpha = (0.07 + strength * 0.17 + flare * 0.08) * (1 - layer * 0.24);
          ctx.lineWidth = Math.max(1, 1 + strength * 1.4 - layer * 0.18);
          ctx.beginPath();
          for (let i = 0; i < e.blades; i++) {
            const a = e.angle + (i / Math.max(1, e.blades)) * Math.PI * 2;
            const radius = Math.max(1, e.ring - layer * 1.5);
            const start = a - trailArc * (1 - layer * 0.16);
            ctx.moveTo(cx + Math.cos(start) * radius, cy + Math.sin(start) * radius);
            ctx.arc(cx, cy, radius, start, a - 0.035);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 0.1 + strength * 0.16 + flare * (0.12 + strength * 0.12);
        ctx.lineWidth = 1 + strength * 1.5 + flare;
        ctx.beginPath(); ctx.arc(cx, cy, e.ring, 0, 6.28); ctx.stroke();

        const blade = this.sprites.fxTinted("halo_blade", "#d8f0e8");
        for (let i = 0; i < e.blades; i++) {
          const a = e.angle + (i / Math.max(1, e.blades)) * Math.PI * 2;
          const bx = cx + Math.cos(a) * e.ring;
          const by = cy + Math.sin(a) * e.ring;
          if (glow) {
            const bladeGlowRadius = e.bladeRadius * (0.72 + strength * 0.16 + flare * 0.08);
            ctx.globalAlpha = 0.12 + strength * 0.2 + pulse * 0.05 + flare * 0.16;
            ctx.drawImage(
              glow,
              bx - bladeGlowRadius,
              by - bladeGlowRadius,
              bladeGlowRadius * 2,
              bladeGlowRadius * 2,
            );
          }
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 0.92 + strength * 0.06;
          if (blade) {
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(a + HALF_PI);
            ctx.drawImage(blade, -e.bladeRadius, -e.bladeRadius, e.bladeRadius * 2, e.bladeRadius * 2);
            ctx.restore();
          } else {
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(a + HALF_PI);
            ctx.fillStyle = "#d8f0e8";
            ctx.beginPath();
            ctx.moveTo(0, -e.bladeRadius);
            ctx.lineTo(e.bladeRadius * 0.45, 0);
            ctx.lineTo(0, e.bladeRadius);
            ctx.lineTo(-e.bladeRadius * 0.45, 0);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
          ctx.globalCompositeOperation = "lighter";
        }
        ctx.restore();
      } else {
        // Tether: a sagging chain from the owner to the latched body.
        const target = this.enemies.find((en) => en.id === e.eid);
        if (!target) continue;
        const ownerPos = this.effectOwnerPos(e);
        const ax = ownerPos[0] - cam.x, ay = ownerPos[1] - cam.y;
        const bx = target.x - cam.x, by = target.y - cam.y;
        if (e.owner !== LOCAL_ID) {
          // A teammate's chain: one thin line, no links, no sag detail.
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = "#c9b06a";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          continue;
        }
        const link = this.sprites.fxTinted("chain_link", "#c9b06a");
        const segs = 9;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = "#c9b06a";
        ctx.lineWidth = 2;
        for (let i = 0; i < segs; i++) {
          const t0 = i / segs, t1 = (i + 1) / segs;
          const sag0 = Math.sin(t0 * Math.PI) * 7, sag1 = Math.sin(t1 * Math.PI) * 7;
          const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0 + sag0;
          const x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1 + sag1;
          if (link) {
            ctx.drawImage(link, (x0 + x1) / 2 - 3, (y0 + y1) / 2 - 3, 6, 6);
          } else if (i % 2 === 0) {
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          }
        }
      }
    }
    if (isDrawing) ctx.restore();
  }

  // Where an owner-anchored effect should draw from: the owner's RENDERED body when we
  // can resolve it (local player: the predicted position), else the effect's own anchor.
  private effectOwnerPos(e: Effect): [number, number] {
    if (e.owner === LOCAL_ID) return [this.px, this.py];
    return [e.x, e.y];
  }

  private haloStrengthAt(x: number, y: number): number {
    let nearestDistanceSq = 48 * 48;
    let strength = 0;
    for (const effect of this.effects) {
      if (effect.kind !== "orbit") continue;
      const ex = effect.owner === LOCAL_ID ? this.px : effect.x;
      const ey = effect.owner === LOCAL_ID ? this.py : effect.y;
      const distanceSq = (ex - x) ** 2 + (ey - y) ** 2;
      if (distanceSq > nearestDistanceSq) continue;
      nearestDistanceSq = distanceSq;
      const visualSpeed = this.haloVisualSpeed(effect);
      strength = haloVisualStrength(effect.blades, effect.bladeRadius, visualSpeed);
    }
    return strength;
  }

  private haloVisualSpeed(effect: OrbitEffect): number {
    if (effect.speed > 0) return effect.speed;
    if (effect.owner === LOCAL_ID) return HALO_VISUAL_BASE.speed * this.p.mods.bulletSpeedMult;
    return 0;
  }

  // A sentryShot fired at (x,y): match it to the nearest live sentry (turrets are static and
  // the event carries the turret's position) and stamp the barrel aim + fire time so the
  // renderer can keep the barrel tracking and play the recoil kick between shot events.
  private recordSentryShot(x: number, y: number, aim: number): void {
    let best: number | null = null;
    let bestD = Infinity;
    for (const e of this.effects) {
      if (e.kind !== "sentry") continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bestD) { bestD = d; best = e.id; }
    }
    if (best !== null) this.sentryFx.set(best, { aim, firedAt: this.animClock });
  }

  // Drop render state for sentries that no longer exist (effect ids climb forever, so the
  // map must not accumulate dead turrets).
  private pruneSentryFx(): void {
    if (this.sentryFx.size === 0) return;
    const live = new Set<number>();
    for (const e of this.effects) if (e.kind === "sentry") live.add(e.id);
    for (const id of this.sentryFx.keys()) if (!live.has(id)) this.sentryFx.delete(id);
  }

  // The local Breach hold: a fill ring on the player plus a landing marker at the
  // currently-charged distance — the ground target IS the weapon's aim story.
  private renderChargeMarker() {
    const p = this.p;
    if (p.chargeT <= 0) return;
    const spec = WEAPONS[p.weapon].charge;
    if (!spec) return;
    const { ctx, cam } = this;
    const t = Math.min(1, p.chargeT / spec.time);
    const dist = (spec.minDist + (spec.maxDist - spec.minDist) * t) * p.mods.bulletLifeMult;
    const sx = this.px - cam.x, sy = this.py - cam.y;
    const mx = sx + Math.cos(this.aimAngle) * dist;
    const my = sy + Math.sin(this.aimAngle) * dist;
    const blast = (WEAPONS[p.weapon].blast ?? 60) * 0.9;
    ctx.save();
    // Charge ring around the player.
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#ffb06a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, p.pr + 7, -HALF_PI, -HALF_PI + t * Math.PI * 2);
    ctx.stroke();
    // Landing marker: blast-sized dashed ring + core dot, brightening toward full charge.
    ctx.globalAlpha = 0.35 + 0.4 * t;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx, my, blast, 0, 6.28); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffb06a";
    ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  private renderGrapplePreview() {
    if (this.weapon !== "mooring_nail" || this.isDown || this.p.isAbsent) return;
    const preview = grapplePreview(this.world, this.p, this.aimAngle);
    if (preview === null) return;
    const { ctx, renderCam: cam } = this;
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.strokeStyle = "#d6c7a1";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(this.px - cam.x, this.py - cam.y);
    ctx.lineTo(preview.anchorX - cam.x, preview.anchorY - cam.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#a8d7a0";
    ctx.beginPath();
    ctx.arc(preview.destinationX - cam.x, preview.destinationY - cam.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private renderSideChannelArmed() {
    const aim = this.p.sideChannelArmedAim;
    if (aim === null || this.isDown || this.p.isAbsent) return;
    const { ctx, renderCam: cam } = this;
    const dx = Math.cos(aim);
    const dy = Math.sin(aim);
    const muzzleX = this.px + dx * 18 - cam.x;
    const muzzleY = this.py + dy * 18 - cam.y;
    const tipX = this.px + dx * SIDE_CHANNEL_LANE_LENGTH - cam.x;
    const tipY = this.py + dy * SIDE_CHANNEL_LANE_LENGTH - cam.y;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = SIDE_CHANNEL_ARMED_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash(AIM_DASH);
    ctx.beginPath();
    ctx.moveTo(muzzleX, muzzleY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // The traveling dirt mound of a tunneling burrower: a low earthen bump + kicked specks.
  // A ground effect, not a body — the sprite returns at the eruption.
  private renderBurrowMound(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    const tint = ENEMY_ARCHETYPES[e.kind].tint;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.ellipse(sx, sy + size * 0.18, size * 0.34, size * 0.14, 0, 0, 6.28);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < 5; i++) {
      const ang = clock * 6 + (i / 5) * 6.28;
      const rad = size * (0.2 + 0.14 * Math.sin(clock * 9 + i * 1.7));
      ctx.fillRect(sx + Math.cos(ang) * rad - 1.5, sy + size * 0.12 + Math.sin(ang) * rad * 0.4 - 1.5, 3, 3);
    }
    ctx.restore();
  }

  // A generic filled danger disc + bright rim (the burrower's eruption marker). Grows with
  // the telegraph so "leave this circle" needs no explanation.
  // The worker tell's footprint preview: one soft rising marker per planned segment —
  // the sim's OWN site geometry (workerBuildSites), so the preview never drifts from
  // what lands. Escape-route standoffs may still skip a segment at raise time; the
  // preview shows intent, the props are truth.
  private renderBuildFootprint(e: Enemy) {
    const { ctx, renderCam: cam } = this;
    const a = e.attack;
    const pulse = 0.5 + 0.5 * Math.sin(this.animClock * 9);
    ctx.save();
    for (const site of workerBuildSites(e)) {
      const sx = site.x - cam.x, sy = site.y - cam.y;
      const r = 10 + 5 * a.windup;
      ctx.globalAlpha = 0.14 + 0.2 * a.windup;
      ctx.fillStyle = TELEGRAPH_COLOR.build;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.fill();
      ctx.globalAlpha = (0.3 + 0.45 * a.windup) * (0.6 + 0.4 * pulse);
      ctx.strokeStyle = TELEGRAPH_COLOR.build;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.stroke();
    }
    ctx.restore();
  }

  private renderDangerDisc(x: number, y: number, radius: number, grow: number) {
    const { ctx, renderCam: cam } = this;
    const sx = x - cam.x, sy = y - cam.y;
    const r = radius * Math.max(0.2, grow);
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.16 * grow;
    ctx.fillStyle = "#ff5a5a";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.fill();
    ctx.globalAlpha = 0.45 + 0.35 * grow;
    ctx.strokeStyle = "#ffd27a";
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  // The Choir's split beat: the body is gone; a slow inward spiral of flecks marks the
  // reforming point (and the wisps you should be shooting are live enemies elsewhere).
  private renderChoirSplit(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    const t = e.attack.windup;
    ctx.save();
    ctx.fillStyle = "#dff4ff";
    for (let i = 0; i < 7; i++) {
      const ang = clock * 1.6 + (i / 7) * 6.28;
      const rad = size * (0.65 - 0.35 * t) * (0.7 + 0.3 * Math.sin(clock * 5 + i * 1.3));
      ctx.globalAlpha = 0.35 + 0.3 * Math.sin(clock * 7 + i);
      ctx.fillRect(sx + Math.cos(ang) * rad - 2, sy + Math.sin(ang) * rad - 2, 4, 4);
    }
    ctx.globalAlpha = 0.12 + 0.1 * t;
    ctx.strokeStyle = TELEGRAPH_COLOR.split;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.4, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  // The airborne Weaver's falling shadow: a blob that swells over the landing mark as it
  // drops — the classic "get out from under it" read.
  private renderPounceShadow(x: number, y: number, size: number, t: number) {
    const { ctx, renderCam: cam } = this;
    const sx = x - cam.x, sy = y - cam.y;
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.35 * t;
    ctx.fillStyle = "#1a0f24";
    ctx.beginPath();
    ctx.ellipse(sx, sy, size * (0.2 + 0.25 * t), size * (0.1 + 0.13 * t), 0, 0, 6.28);
    ctx.fill();
    ctx.restore();
  }

  // The shielder's guard: a braced arc across its authoritative block frontage.
  private renderShielderGuard(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const half = SHIELDER_BLOCK_ARC / 2;
    const facing = e.attack.lockedAngle;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#cfe0d4";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.46, facing - half, facing + half);
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 8;
    ctx.strokeStyle = ENEMY_ARCHETYPES.shielder.tint;
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.46, facing - half, facing + half);
    ctx.stroke();
    ctx.restore();
  }

  // A formation/plate guard arc (rootward, P1 marshal, bulwark elites): the protected
  // frontage drawn from the sim's authoritative lockedAngle, in the owner's color.
  // The rolled elite affix's material tell (Wave 1). Every read is code-drawn material (slab
  // arc, faceted plane, veins, crack seams, ember drip) — never a bare circle — and the
  // reflect facet's ARMED state is the fairness cue (bright = don't shoot the front).
  private renderRollAffix(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    const bloodied = e.maxHp > 0 ? 1 - Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
    switch (e.rollAffix) {
      case "shielded": {
        // An asymmetric crust slab (a directional plate that FALLS when spent, afs = its HP).
        if (e.affixState > 0) this.renderGuardArc(e, sx, sy, size, ROLL_AFFIX.slabArc, "#8a6f52");
        return;
      }
      case "reflect": {
        // A glassy amber facet across the front: pulsing BRIGHT while armed (the fairness tell —
        // a frontal shot bounces back), a dim cracked hatch while disarmed (safe to shoot).
        const facing = e.attack.lockedAngle;
        const px = Math.cos(facing), py = Math.sin(facing);
        const tx = -py, ty = px;
        const r = size * 0.42, half = size * 0.34;
        const cx = sx + px * r, cy = sy + py * r;
        ctx.save();
        if (e.affixState > 0) {
          ctx.globalAlpha = 0.5 + 0.35 * Math.sin(clock * 8);
          ctx.strokeStyle = "#ffca6b"; ctx.lineWidth = 4; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(cx - tx * half, cy - ty * half); ctx.lineTo(cx + tx * half, cy + ty * half); ctx.stroke();
          ctx.globalAlpha = 0.22; ctx.lineWidth = 9; ctx.stroke();
        } else {
          ctx.globalAlpha = 0.45; ctx.strokeStyle = "#6b5a3a"; ctx.lineWidth = 2;
          for (let i = -1; i <= 1; i++) {
            const o = i * 4;
            ctx.beginPath();
            ctx.moveTo(cx - tx * half + px * o, cy - ty * half + py * o);
            ctx.lineTo(cx + tx * half * 0.4 + px * o, cy + ty * half * 0.4 + py * o);
            ctx.stroke();
          }
        }
        ctx.restore();
        return;
      }
      case "enrage": {
        // Dead-amber veins that HEAT as HP drops — brighter/hotter the more bloodied the body.
        if (bloodied <= 0.02) return;
        ctx.save();
        ctx.globalAlpha = (0.25 + 0.65 * bloodied) * (0.7 + 0.3 * Math.sin(clock * 10));
        ctx.strokeStyle = "#ff7a2a"; ctx.lineWidth = 2; ctx.lineCap = "round";
        const n = 5;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2 + e.id;
          const r0 = size * 0.12, r1 = size * 0.34 * (0.7 + 0.5 * bloodied);
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(ang) * r0, sy + Math.sin(ang) * r0);
          ctx.lineTo(sx + Math.cos(ang) * r1, sy + Math.sin(ang) * r1);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      case "splits": {
        // Pre-cracked seams that widen as the body is bloodied — it's about to come apart.
        ctx.save();
        ctx.globalAlpha = 0.4 + 0.4 * bloodied;
        ctx.strokeStyle = "#241b2c"; ctx.lineWidth = 1 + 2 * bloodied; ctx.lineCap = "round";
        const seams: ReadonlyArray<readonly [number, number, number, number]> = [
          [-0.3, -0.38, 0.12, 0.32], [0.34, -0.3, -0.06, 0.36],
        ];
        for (const [ax, ay, bx, by] of seams) {
          ctx.beginPath();
          ctx.moveTo(sx + ax * size, sy + ay * size);
          ctx.lineTo(sx + (ax + bx) * 0.5 * size, sy + (ay + by) * 0.5 * size - 3);
          ctx.lineTo(sx + bx * size, sy + by * size);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      case "hazardTrail": {
        // The body drips its element (the ground cinders it leaves are the real hazard tell).
        const dp = 0.6 + 0.4 * Math.sin(clock * 7 + e.id);
        this.fxLayer("glow_round", "#ff8a3b", sx, sy + size * 0.3, size * 0.28 * dp, size * 0.28 * dp, 0.35, 0);
        return;
      }
      default:
        return;
    }
  }

  private renderGuardArc(e: Enemy, sx: number, sy: number, size: number, arc: number, color: string) {
    const { ctx } = this;
    const half = arc / 2;
    const facing = e.attack.lockedAngle;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#e8efe4";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.46, facing - half, facing + half);
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 8;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.46, facing - half, facing + half);
    ctx.stroke();
    ctx.restore();
  }

  // The caskbellows' crank: a bright stud on its BACK — the stagger point. It sits
  // opposite the authoritative lane (lockedAngle), so where the lane points, the weak
  // point is exactly behind.
  private renderCaskCrank(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const back = e.attack.lockedAngle + Math.PI;
    const x = sx + Math.cos(back) * size * 0.4;
    const y = sy + Math.sin(back) * size * 0.4;
    ctx.save();
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(this.animClock * 6);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  // A decoy's fuse readout (aux = seconds left): the echo simply fades; the knell blinks
  // faster and hotter as its toll approaches — "shoot the noise" needs no tutorial.
  private renderDecoyFuse(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    ctx.save();
    if (e.kind === "knell") {
      const urgency = Math.max(0, 1 - e.aux / 2.2);
      const blink = 0.5 + 0.5 * Math.sin(clock * (6 + urgency * 18));
      ctx.globalAlpha = 0.35 + 0.5 * urgency * blink;
      ctx.strokeStyle = "#ff5a3b";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, size * (0.5 + 0.2 * urgency), 0, 6.28); ctx.stroke();
    } else {
      ctx.globalAlpha = 0.25 + 0.15 * Math.sin(clock * 4);
      ctx.strokeStyle = ENEMY_ARCHETYPES.echo.tint;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, 0, 6.28); ctx.stroke();
    }
    ctx.restore();
  }

  // The fragment's tether to its source (aux = source id + 1). A faint standing line
  // that brightens through the harmonize windup and burns solid during the pulse —
  // the lane IS the telegraph.
  private renderFragmentTether(e: Enemy) {
    const src = this.enemies.find((other) => other.id === e.aux - 1 && !other.dead);
    if (!src) return;
    const { ctx, renderCam: cam } = this;
    const a = e.attack;
    const isPulsing = a.move === "harmonize" && a.phase === "active";
    const charge = a.move === "harmonize" && a.phase === "windup" ? a.windup : 0;
    ctx.save();
    ctx.globalAlpha = isPulsing ? 0.95 : 0.2 + 0.55 * charge;
    ctx.strokeStyle = TELEGRAPH_COLOR.harmonize;
    ctx.lineWidth = isPulsing ? 5 : 1.5 + 2 * charge;
    ctx.setLineDash(isPulsing || charge > 0.99 ? AIM_SOLID : AIM_DASH);
    ctx.beginPath();
    ctx.moveTo(e.x - cam.x, e.y - cam.y);
    ctx.lineTo(src.x - cam.x, src.y - cam.y);
    ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
  }

  // QUORUM's code-drawn amber TETHER (per the QUORUM manifest): a taut amber line linking
  // every living husk (and back to the fused core point). Its thickness/tautness reads the
  // SHARED HP (the core pool fraction); it visibly snaps when a husk dies (that body simply
  // drops out of the ring); and it leans HARDEST toward the "next to act" husk — the core's
  // mark point (atk.mx/my), set to the lead husk while a shared telegraph is charging. There
  // is exactly one Quorum core per floor, so every live husk on the field belongs to it.
  private renderQuorumTether(core: Enemy) {
    const husks = this.enemies.filter((o) => !o.dead
      && (o.kind === "quorum_shield" || o.kind === "quorum_heal" || o.kind === "quorum_dmg"));
    const { ctx, renderCam: cam } = this;
    const pool = Math.max(0, Math.min(1, core.hp / core.maxHp));
    // Tether-REKNIT tracker: catch the trio RE-FORM (count rises to a full trio) even across the
    // exposed window (this runs every P1 frame, before the empty early-return). The reknit speed
    // TIGHTENS as the pool nears the 45% merge — the body "struggles to hold itself together".
    const rk = this.quorumReform.get(core.id) ?? { anim: 0, lastCount: 0, lastClock: this.animClock };
    const dt = Math.max(0, Math.min(0.1, this.animClock - rk.lastClock));
    if (husks.length > rk.lastCount && husks.length >= 3) rk.anim = 1;
    rk.lastCount = husks.length;
    rk.lastClock = this.animClock;
    const reknitSpeed = 1 + (1 - pool) * 1.6; // faster/tighter heading into the merge
    if (rk.anim > 0) rk.anim = Math.max(0, rk.anim - dt * reknitSpeed / 0.35);
    this.quorumReform.set(core.id, rk);
    if (husks.length === 0) return; // the core body is shown during the exposed window
    // The reknit VISUAL: dim bone-cyan beads sweep INWARD (husk -> core) as the severed body
    // pulls back together — light + subordinate to the HP bar (never a triumphant burst).
    if (rk.anim > 0) {
      const f = 1 - rk.anim; // 0 (just re-formed) -> 1 (knit taut)
      for (const h of husks) {
        const hx = h.x - cam.x, hy = h.y - cam.y, ccx = core.x - cam.x, ccy = core.y - cam.y;
        ctx.save();
        ctx.globalAlpha = 0.4 * rk.anim;
        ctx.strokeStyle = "#8fd8dc"; // dim (menacing), not the bright shield-beam cyan
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ccx, ccy); ctx.stroke();
        ctx.globalAlpha = 0.7 * rk.anim;
        ctx.fillStyle = "#bfeef0";
        ctx.beginPath(); ctx.arc(hx + (ccx - hx) * f, hy + (ccy - hy) * f, 2.5, 0, 6.28); ctx.fill();
        ctx.restore();
      }
    }
    const a = core.attack;
    const isCharging = a.phase === "windup" && a.move === "radial";
    // The lead husk (nearest the core's mark point): the tether pulls hardest to it.
    let lead: Enemy | null = null;
    if (isCharging) {
      let best = Infinity;
      for (const h of husks) {
        const d = Math.hypot(h.x - a.markX, h.y - a.markY);
        if (d < best) { best = d; lead = h; }
      }
    }
    // The shared centroid the husks orbit — the fused-core point the merge collapses toward.
    let cx = 0, cy = 0;
    for (const h of husks) { cx += h.x; cy += h.y; }
    cx /= husks.length; cy /= husks.length;
    ctx.save();
    ctx.lineCap = "round";
    const draw = (x0: number, y0: number, x1: number, y1: number, lead2: boolean): void => {
      // Thicker/brighter with more shared HP; the lead husk's spoke pulls hardest.
      ctx.globalAlpha = (lead2 ? 0.85 : 0.5) * (0.4 + 0.6 * pool);
      ctx.strokeStyle = lead2 ? "#ffb43b" : "#c77320";
      ctx.lineWidth = (lead2 ? 3.5 : 2) + 3 * pool + (lead2 && isCharging ? 2.5 * a.windup : 0);
      ctx.beginPath();
      ctx.moveTo(x0 - cam.x, y0 - cam.y);
      ctx.lineTo(x1 - cam.x, y1 - cam.y);
      ctx.stroke();
    };
    // Spokes from the shared centroid to each husk (the shared-pool web).
    for (const h of husks) draw(cx, cy, h.x, h.y, lead !== null && h.id === lead.id);
    // The husk-to-husk ring (drops a segment the instant a husk dies — the visible snap).
    for (let i = 0; i < husks.length; i++) {
      const h0 = husks[i], h1 = husks[(i + 1) % husks.length];
      if (husks.length > 1) draw(h0.x, h0.y, h1.x, h1.y, false);
    }
    // The shield-husk's guard beams: taut BRIGHT bone-cyan lines to its siblings while it
    // LIVES (the body is guarded — near-zero damage). The instant the shield husk dies
    // these beams are gone and the others are damageable — beams present/absent IS the read.
    const shield = husks.find((h) => h.kind === "quorum_shield") ?? null;
    if (shield) {
      const shimmer = 0.6 + 0.4 * Math.sin(this.animClock * 6);
      for (const h of husks) {
        if (h.id === shield.id) continue;
        ctx.globalAlpha = 0.8 * shimmer;
        ctx.strokeStyle = "#bfeef0";
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(shield.x - cam.x, shield.y - cam.y);
        ctx.lineTo(h.x - cam.x, h.y - cam.y);
        ctx.stroke();
      }
    }
    // The HEAL husk feeds the shared pool (healRegenPerSec): a faint pulse travels heal-husk ->
    // core so "kill the healer or the pool refills" reads at a glance while it lives.
    const heal = husks.find((h) => h.kind === "quorum_heal") ?? null;
    if (heal) {
      const flow = (this.animClock * 0.8) % 1; // a bead traveling toward the core
      const hx = heal.x - cam.x, hy = heal.y - cam.y, ccx = core.x - cam.x, ccy = core.y - cam.y;
      ctx.globalAlpha = 0.35 + 0.2 * Math.sin(this.animClock * 5);
      ctx.strokeStyle = "#d8b6e0"; // the heal husk's family tint
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ccx, ccy); ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#f0d8f6";
      ctx.beginPath(); ctx.arc(hx + (ccx - hx) * flow, hy + (ccy - hy) * flow, 3, 0, 6.28); ctx.fill();
    }
    ctx.restore();
  }

  // The Weaver's lattice knot: the glowing ANCHOR NODE where its three thread-lines
  // cross. The lines ARE the blink lanes (drawn from the sim's authoritative lattice
  // orientation), and the node pulses like the shoot-this target it is.
  private renderKnotLattice(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    const tint = ENEMY_ARCHETYPES.knot.tint;
    const reach = 300;
    ctx.save();
    ctx.strokeStyle = tint;
    ctx.setLineDash(AIM_DASH);
    for (let k = 0; k < 3; k++) {
      const ang = e.attack.lockedAngle + k * (Math.PI / 3);
      // k=0 IS the strung lane (the sim's silk row follows exactly this thread).
      ctx.lineWidth = k === 0 ? 2.5 : 1.5;
      ctx.globalAlpha = (k === 0 ? 0.38 : 0.2) + 0.1 * Math.sin(clock * 3 + e.id);
      ctx.beginPath();
      ctx.moveTo(sx - Math.cos(ang) * reach, sy - Math.sin(ang) * reach);
      ctx.lineTo(sx + Math.cos(ang) * reach, sy + Math.sin(ang) * reach);
      ctx.stroke();
    }
    ctx.setLineDash(AIM_SOLID);
    const pulse = 0.6 + 0.4 * Math.sin(clock * 7);
    ctx.globalAlpha = 0.55 * pulse;
    ctx.strokeStyle = "#fff3c4";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.42 + 2 * pulse, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  // The earned-window read (Weaver/MARROW/Choir): GUARDED = a dim thread rim (your
  // shots are chipping — force the window instead); EXPOSED (aux carries the sim's
  // remainder) = the body blazes, unload.
  // The authoritative EXPOSED read — the SAME flag the sim's damage gate uses (isBossExposed:
  // boss.exposed > 0). It rides the wire on aux and is restored into boss.exposed by
  // enemyFromWire, so binding art to it here means the guard/expose visuals can never desync
  // from the hitbox. Non-boss bodies are never "exposed" in this sense.
  private isEnemyExposed(e: Enemy): boolean {
    return e.boss !== null && e.boss.exposed > 0;
  }

  private renderEarnedWindow(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const deep = e.kind === "jet" || e.kind === "tithe" || e.kind === "quorum" || isGiantKind(e.kind);
    if (this.isEnemyExposed(e)) {
      // EXPOSED — the guard is down: a blazing core reads "unload now". The deep bosses crack
      // hot-amber (Tithe's slumped amber sacs run a touch lighter; the PALE THRONE cracks COLD —
      // its cold-white/blue core blaze); the earlier earned-window bosses keep their own tint.
      const pulse = 0.6 + 0.4 * Math.sin(this.animClock * 9);
      const hot = deep ? (e.kind === "tithe" ? "#ffcf6a" : isGiantKind(e.kind) ? GIANT_MATERIAL[e.kind].exposeHot : "#ffb43b") : ENEMY_ARCHETYPES[e.kind].tint;
      this.fxLayer("glow_round", hot, sx, sy, size * 1.15 * pulse, size * 1.15 * pulse, 0.5, 0);
      this.fxLayer("core_dot", "#fff3c4", sx, sy, size * 0.42, size * 0.42, 0.75 * pulse, 0);
      return;
    }
    // GUARDED — near-zero damage to the body. Each deep-boss family wears a distinct
    // FULL-BRIGHT shield read (value + shape, not hue alone) so it holds in 4p chaos.
    if (e.kind === "jet") {
      // A specular shimmer SWEEP across saturated corrupted-amber plates.
      const sweep = this.animClock * 2.2;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = "#c78a2a";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, 0, 6.28); ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "#ffe6a6";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, sweep, sweep + 0.9); ctx.stroke();
      ctx.restore();
      return;
    }
    if (e.kind === "tithe") {
      // A glassy blue-white shield-shimmer DOME — the zero-damage-while-feeding signal.
      const pulse = 0.5 + 0.5 * Math.sin(this.animClock * 4);
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.2 * pulse;
      ctx.strokeStyle = "#dcebff";
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(sx, sy - size * 0.05, size * 0.56, 0, 6.28); ctx.stroke();
      ctx.globalAlpha = 0.1 + 0.08 * pulse;
      ctx.fillStyle = "#bcd8ff";
      ctx.beginPath(); ctx.arc(sx, sy - size * 0.05, size * 0.56, 0, 6.28); ctx.fill();
      ctx.restore();
      return;
    }
    if (e.kind === "quorum") {
      // Merge-form guarded: a taut bone-cyan rim (the pre-merge husk beams carry the read).
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.2 * Math.sin(this.animClock * 4);
      ctx.strokeStyle = "#bfeef0";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, 0, 6.28); ctx.stroke();
      ctx.restore();
      return;
    }
    if (isGiantKind(e.kind)) {
      // GUARDED behind the shell: a dim, sealed-crust rim (the ONLY way through is peeling the
      // weak-points). Deliberately dim — Gorge a cold slate-stone, Pale a cold rime-slate — so the
      // P3 core glow stays the ONE bright material read on the body.
      ctx.save();
      ctx.globalAlpha = 0.4 + 0.12 * Math.sin(this.animClock * 3);
      ctx.strokeStyle = GIANT_MATERIAL[e.kind].guardRim;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.42, 0, 6.28); ctx.stroke();
      ctx.restore();
      return;
    }
    // The earlier earned-window bosses (weaver/marrow/choir): a thread-dim family rim.
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.12 * Math.sin(this.animClock * 3);
    ctx.strokeStyle = ENEMY_ARCHETYPES[e.kind].tint;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  // A persistent emissive ground-ring beneath a deep boss in its family hue (JET
  // cold-indigo, TITHE amber, QUORUM bone-white). It reads "setpiece" and DOUBLES as the
  // guard/expose indicator: saturated + swelling while GUARDED, drained + desaturated
  // while EXPOSED. The state is the authoritative aux flag (exposed remainder > 0).
  private renderBossAura(e: Enemy, sx: number, sy: number, size: number) {
    const hue = e.kind === "jet" ? { guard: "#5b63c8", expose: "#6b7088" }
      : e.kind === "tithe" ? { guard: "#e0902f", expose: "#8a5a22" }
      // GIANTS: a dim ground-ring (the sealed shell), draining as the peel window opens. Gorge is a
      // warm slag ring; Pale is a cold-blue one (the warmth-drain material).
      : isGiantKind(e.kind) ? { guard: GIANT_MATERIAL[e.kind].auraGuard, expose: GIANT_MATERIAL[e.kind].auraExpose }
      : { guard: "#eef0e2", expose: "#b9bcae" };
    const exposed = this.isEnemyExposed(e);
    const { ctx } = this;
    const gy = sy + size * 0.32;
    const color = exposed ? hue.expose : hue.guard;
    const scale = exposed ? 0.7 : 1;
    const pulse = 0.5 + 0.5 * Math.sin(this.animClock * (exposed ? 3 : 5));
    this.fxLayer("glow_round", color, sx, gy, size * 1.5 * scale, size * 0.7 * scale, (exposed ? 0.18 : 0.4) + 0.12 * pulse, 0);
    ctx.save();
    ctx.globalAlpha = (exposed ? 0.35 : 0.7) + 0.15 * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = exposed ? 2 : 3.5;
    ctx.beginPath();
    ctx.ellipse(sx, gy, size * 0.6, size * 0.28, 0, 0, 6.28);
    ctx.stroke();
    ctx.restore();
  }

  // SEVER's resin ANCHOR / WORLDSPLIT tooth read (both share the Weaver placeholder sprite,
  // so the "shoot me to open the window" language is painted client-side off the wire). The
  // intercept trap anchors (aux===0) get a steady amber resin marker; the WORLDSPLIT tooth
  // (aux===1) is LOUDER — hotter, larger, faster, an extra halo ring — so it always out-reads
  // the parallel intercept anchors. A floating BREAK label names the target while it is on camera.
  private renderSeverAnchor(e: Enemy, sx: number, sy: number, size: number, clock: number) {
    const { ctx } = this;
    const isTooth = e.aux === 1;
    const color = isTooth ? "#ffd27a" : "#f2a63b";
    const gy = sy + size * 0.32;
    const pulse = 0.5 + 0.5 * Math.sin(clock * (isTooth ? 9 : 5) + e.id);
    // A resin marker wider than the small body — a bigger interaction silhouette to aim at.
    const ringR = size * (isTooth ? 0.82 : 0.6);
    this.fxLayer("glow_round", color, sx, gy, ringR * 2.2 * (0.9 + 0.2 * pulse), ringR * (0.9 + 0.2 * pulse), (isTooth ? 0.42 : 0.26) + 0.14 * pulse, 0);
    ctx.save();
    ctx.globalAlpha = (isTooth ? 0.85 : 0.6) + 0.15 * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = isTooth ? 4 : 2.5;
    ctx.setLineDash(isTooth ? AIM_SOLID : [6, 4]);
    ctx.beginPath();
    ctx.ellipse(sx, gy, ringR, ringR * 0.42, 0, 0, 6.28);
    ctx.stroke();
    // The louder tooth wears a second, wider halo ring the anchors never get.
    if (isTooth) {
      ctx.globalAlpha = 0.35 + 0.2 * pulse;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(sx, gy, ringR * 1.35, ringR * 0.56, 0, 0, 6.28);
      ctx.stroke();
    }
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
    // Floating label — the same pixel voice as the arena squeeze's GET INSIDE tell.
    const title = isTooth ? "TOOTH" : "ANCHOR";
    const labelY = sy - size * 0.62;
    ctx.save();
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.6 + 0.35 * pulse;
    ctx.fillStyle = "#1a1206";
    ctx.fillText(title, sx + 1, labelY + 1);
    ctx.fillText("BREAK", sx + 1, labelY + 13);
    ctx.fillStyle = color;
    ctx.fillText(title, sx, labelY);
    ctx.fillStyle = isTooth ? "#fff3c4" : "#ffd8a0";
    ctx.fillText("BREAK", sx, labelY + 12);
    ctx.restore();
  }

  // The Warden's plate state: sealed = a cool gold rim (your shots are chipping); exposed
  // = the plate hangs open and the amber core blazes — unload. Exposure rides the aux
  // channel (the authoritative earned-window remainder), so online clients agree.
  private renderGildedPlate(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const isExposed = this.isEnemyExposed(e);
    if (isExposed) {
      const pulse = 0.6 + 0.4 * Math.sin(this.animClock * 9);
      this.fxLayer("glow_round", "#ffb43b", sx, sy, size * 1.1 * pulse, size * 1.1 * pulse, 0.55, 0);
      this.fxLayer("core_dot", "#fff3c4", sx, sy, size * 0.4, size * 0.4, 0.8 * pulse, 0);
      return;
    }
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.15 * Math.sin(this.animClock * 3);
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.5, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  // The MARROW's bone shield: a cold ring that thins as the beat runs out. Husk deaths
  // collapse it early — the ring is the "switch targets" prompt.
  private renderMarrowShield(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const t = e.attack.windup;
    const pulse = 0.6 + 0.4 * Math.sin(this.animClock * 7);
    ctx.save();
    ctx.globalAlpha = (0.5 - 0.25 * t) * pulse + 0.2;
    ctx.strokeStyle = TELEGRAPH_COLOR.shield;
    ctx.lineWidth = 4 - 2 * t;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.62, 0, 6.28); ctx.stroke();
    ctx.globalAlpha = 0.12 * pulse;
    ctx.fillStyle = TELEGRAPH_COLOR.shield;
    ctx.beginPath(); ctx.arc(sx, sy, size * 0.62, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  // A thin pulsing ellipse under a brute/elite — the tier tell.
  private renderTierRing(sx: number, sy: number, size: number, color: string) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(this.animClock * 5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sx, sy + size * 0.3, size * 0.44, size * 0.2, 0, 0, 6.28);
    ctx.stroke();
    ctx.restore();
  }

  // The arena squeeze: outside the safe ring is danger. During the 1s telegraph the ring
  // fades in at its start radius; during the 3s hold it shrinks toward the boss.
  private renderSqueeze(e: Enemy) {
    const { ctx, renderCam: cam } = this;
    const a = e.attack;
    const t = a.phase === "active" ? a.windup : 0;
    const safeR = BOSS.squeezeStartRadius + (BOSS.squeezeEndRadius - BOSS.squeezeStartRadius) * t;
    const sx = e.x - cam.x, sy = e.y - cam.y;
    const pulse = 0.6 + 0.4 * Math.sin(this.animClock * 8);
    ctx.save();
    // Communicate the RULE, not merely the boundary: outside is danger, inside is safe.
    // The old lone red circle looked like a damaging ring and made players stand outside.
    const dangerAlpha = a.phase === "windup" ? 0.07 + 0.10 * a.windup : 0.16 + 0.04 * pulse;
    ctx.globalAlpha = dangerAlpha;
    ctx.fillStyle = "#ff3d52";
    ctx.beginPath();
    ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    ctx.arc(sx, sy, safeR, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.globalAlpha = a.phase === "windup" ? 0.05 + 0.07 * a.windup : 0.10;
    ctx.fillStyle = "#8affc0";
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(0, safeR - 5), 0, Math.PI * 2); ctx.fill();

    ctx.globalAlpha = (a.phase === "windup" ? 0.45 + 0.35 * a.windup : 0.9) * pulse;
    ctx.strokeStyle = TELEGRAPH_COLOR.squeeze;
    ctx.lineWidth = a.phase === "active" ? 5 : 3;
    ctx.setLineDash(a.phase === "active" ? AIM_SOLID : AIM_DASH);
    ctx.beginPath(); ctx.arc(sx, sy, safeR, 0, 6.28); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);

    // Four inward chevrons and an explicit instruction make the safe-side impossible to misread.
    ctx.fillStyle = "#8affc0";
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.75 + 0.2 * pulse;
    ctx.fillText("GET INSIDE", sx, sy - Math.min(safeR - 18, 54));
    for (let i = 0; i < 4; i++) {
      const ang = i * Math.PI / 2;
      const r = Math.max(22, safeR - 18);
      const x = sx + Math.cos(ang) * r, y = sy + Math.sin(ang) * r;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang + Math.PI);
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // Pulsing colored aura + an aim line for a charging attack. The line tracks the
  // target while dashed, then goes solid + bright once the aim locks — that visual
  // "click" is the cue that the dodge window has opened.
  private renderTelegraph(e: Enemy, sx: number, sy: number) {
    const { ctx } = this;
    const a = e.attack;
    const color = TELEGRAPH_COLOR[a.move];
    const pulse = 0.5 + 0.5 * Math.sin(this.animForEnemy(e).clock * 13);
    const r = this.enemyDrawSize(e) * (0.5 + 0.28 * a.windup);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = (0.14 + 0.38 * a.windup) * (0.6 + 0.4 * pulse);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.fill();
    ctx.restore();

    const isBlinkLane = a.move === "blink" && e.kind === "weaver";
    if (a.move === "lunge" || a.move === "spit" || a.move === "rush" || a.move === "volley" || a.move === "seam" || isBlinkLane) {
      // Line commitments draw their whole lane: the rush lengths match the sim's actual
      // travel, so where the line ends is where the rusher stops (or crashes). The seam
      // draws to its authoritative mark — the far wall the cut will reach; the Weaver's
      // blink draws its committed thread to the arrival mark (shoot the lane's knot!).
      const len = a.move === "lunge" ? 150
        : a.move === "spit" ? 300
        : a.move === "volley" ? 260
        : a.move === "seam" || isBlinkLane ? Math.hypot(a.markX - e.x, a.markY - e.y)
        : e.kind === "weaver" ? Math.hypot(a.markX - e.x, a.markY - e.y)
        : e.kind === "marrow" ? MARROW.chargeSpeed * MARROW.chargeDur
        : e.kind === "sinderling" ? SINDER_JET_SPEED * SINDER_JET_DUR
        : CHARGER_RUSH_SPEED * CHARGER_RUSH_DUR;
      ctx.save();
      ctx.globalAlpha = (a.isAimLocked ? 0.9 : 0.4) * (0.55 + 0.45 * a.windup);
      ctx.strokeStyle = color;
      ctx.lineWidth = a.isAimLocked ? 3 : 1.5;
      ctx.setLineDash(a.isAimLocked ? AIM_SOLID : AIM_DASH);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(a.lockedAngle) * len, sy + Math.sin(a.lockedAngle) * len);
      ctx.stroke();
      ctx.setLineDash(AIM_SOLID);
      ctx.restore();
    }
  }

  // ---- BOSS TELEGRAPH RENDERER (reusable parametric primitives) ----
  // Which (kind, move) pairs the dedicated boss telegraph owns (so the generic aura is skipped
  // for them and no footprint is double-drawn). merge = fuse VFX only (no danger footprint);
  // roar = the transition beat; build = the feed window (its own slab-raise tell).
  private isBossTelegraphMove(e: Enemy): boolean {
    const m = e.attack.move;
    if (e.kind === "jet") return m === "mirror" || m === "tracer" || m === "rush" || m === "beam";
    if (e.kind === "tithe") return m === "slam" || m === "spew" || m === "hurl" || m === "radial" || m === "rip" || m === "build";
    if (e.kind === "quorum") return m === "beam" || m === "sweep" || m === "volley" || m === "radial";
    // GIANTS (Gorge/Pale): the P1 ring (slam), P2 slag zones (spew) and P3 rotating spokes (sweep)
    // each own a dedicated ground footprint (the roar crack-off is the transition beat, not danger).
    if (isGiantKind(e.kind)) return m === "slam" || m === "spew" || m === "sweep";
    return false;
  }

  // One shape, drawn to the contract: family-hue FILL (which boss) + hot danger EDGE (dodge).
  // A DYNAMIC-and-not-yet-locked tell draws a SOFT dashed edge (juke window open); a FIXED or
  // LOCKED tell draws a CRISP solid edge; the lock frame adds one bright snap-flash. Lingering
  // post-fire fill is dimmer. The caller only ever paints the DANGER area — safe pockets stay
  // clear floor (§R3).
  private tgShape(pathFn: () => void, hue: string, o: { locked: boolean; dynamic: boolean; linger?: number; snapFlash?: number; fillAlpha?: number; dashed?: boolean; fillRule?: CanvasFillRule; edgeColor?: string }): void {
    const { ctx } = this;
    const linger = o.linger ?? 1;
    ctx.save();
    ctx.beginPath(); pathFn();
    ctx.globalAlpha = (o.fillAlpha ?? TG_FILL_ALPHA) * linger;
    ctx.fillStyle = hue;
    ctx.fill(o.fillRule ?? "nonzero");
    const soft = (o.dynamic && !o.locked) || (o.dashed ?? false);
    ctx.globalAlpha = (soft ? 0.5 : 0.9) * linger;
    ctx.strokeStyle = o.edgeColor ?? TG_DANGER_EDGE;
    ctx.lineWidth = soft ? 2 : 3.5;
    ctx.setLineDash(soft ? AIM_DASH : AIM_SOLID);
    ctx.beginPath(); pathFn(); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    if (o.snapFlash && o.snapFlash > 0) {
      ctx.globalAlpha = o.snapFlash * 0.9;
      ctx.strokeStyle = "#fff3c4";
      ctx.lineWidth = 5;
      ctx.beginPath(); pathFn(); ctx.stroke();
    }
    ctx.restore();
  }

  // 1. LANE (capsule): beams, lances, slab lanes, charges, recoil walls, dmg-husk shots.
  private tgLane(sx: number, sy: number, angle: number, length: number, width: number, hue: string, o: { locked: boolean; dynamic: boolean; linger?: number; snapFlash?: number; back?: number; dashed?: boolean; fillAlpha?: number; edgeColor?: string }): void {
    const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx, hw = width / 2;
    const back = o.back ?? 0;
    const x0 = sx - dx * back, y0 = sy - dy * back, x1 = sx + dx * length, y1 = sy + dy * length;
    this.tgShape(() => {
      const { ctx } = this;
      ctx.moveTo(x0 + nx * hw, y0 + ny * hw);
      ctx.lineTo(x1 + nx * hw, y1 + ny * hw);
      ctx.lineTo(x1 - nx * hw, y1 - ny * hw);
      ctx.lineTo(x0 - nx * hw, y0 - ny * hw);
      ctx.closePath();
    }, hue, o);
  }

  // 2. WEDGE (filled cone): the mirrored melee/cone copy. Safe = the flanking arcs (unpainted).
  private tgWedge(sx: number, sy: number, angle: number, halfAngle: number, range: number, hue: string, o: { locked: boolean; dynamic: boolean; snapFlash?: number }): void {
    this.tgShape(() => {
      const { ctx } = this;
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, range, angle - halfAngle, angle + halfAngle);
      ctx.closePath();
    }, hue, o);
  }

  // 3. FAN (N diverging sub-lanes): the spread SMG-copy. The standable pocket OPENS WITH
  // DISTANCE — the shards emanate from the boss, so up close (tiles 1-3) the gaps are under the
  // body (no pocket: a solid dash-through near-cone), and a body-fitting gap opens from ~tile 4,
  // widening to a comfortable stand by ~tile 6. Never promises a standable gap up close.
  private tgFan(sx: number, sy: number, angle: number, count: number, gap: number, shardW: number, range: number, hue: string, o: { locked: boolean; dynamic: boolean; snapFlash?: number }): void {
    const spread = gap * (count - 1);
    const near = TILE * 3; // tiles 1-3: no standable pocket — one dense dash-through cone
    this.tgShape(() => {
      const { ctx } = this;
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, near, angle - spread / 2 - gap / 2, angle + spread / 2 + gap / 2);
      ctx.closePath();
    }, hue, o);
    // Far field: the shards diverge and the gaps between them (unpainted = safe) open up.
    for (let i = 0; i < count; i++) this.tgLane(sx, sy, angle + (i - (count - 1) / 2) * gap, range, shardW, hue, o);
  }

  // 4. ARC_PARABOLA (dotted): the lobbed-orb copy — dotted arc to the first landing marker.
  private tgArcParabola(sx: number, sy: number, lx: number, ly: number, hue: string): void {
    const { ctx } = this;
    const mx = (sx + lx) / 2, my = (sy + ly) / 2 - Math.hypot(lx - sx, ly - sy) * 0.4;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = hue;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 7]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(mx, my, lx, ly); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
    this.tgImpactDiscs([{ x: lx, y: ly }], 36, hue, { locked: true, dynamic: false });
  }

  // 5. TRACK_DISC (lock-flip): the tracer's homing mote — HOLLOW while tracking, SOLID + a
  // bright snap-ring the frame it locks. THE lock primitive; the snap = "dash now."
  private tgTrackDisc(sx: number, sy: number, radius: number, locked: boolean, hue: string, snapFlash: number): void {
    const { ctx } = this;
    ctx.save();
    if (locked) {
      ctx.globalAlpha = TG_FILL_ALPHA + 0.14;
      ctx.fillStyle = hue;
      ctx.beginPath(); ctx.arc(sx, sy, radius, 0, 6.28); ctx.fill();
    }
    ctx.globalAlpha = locked ? 0.9 : 0.5;
    ctx.strokeStyle = TG_DANGER_EDGE;
    ctx.lineWidth = locked ? 3.5 : 2;
    ctx.setLineDash(locked ? AIM_SOLID : AIM_DASH);
    ctx.beginPath(); ctx.arc(sx, sy, radius, 0, 6.28); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    if (snapFlash > 0) {
      ctx.globalAlpha = snapFlash * 0.9;
      ctx.strokeStyle = "#fff3c4";
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(sx, sy, radius * (1 + 0.35 * snapFlash), 0, 6.28); ctx.stroke();
    }
    ctx.restore();
  }

  // 6. RING_BAND (annulus): the gorge slam / radial ring / heal knockback. The SAFE center
  // disc (<= inner r) is never painted, and neither is beyond the outer edge.
  private tgRingBand(sx: number, sy: number, innerR: number, outerR: number, hue: string, o: { linger?: number; dashed?: boolean }): void {
    if (outerR <= innerR) return;
    this.tgShape(() => {
      const { ctx } = this;
      ctx.arc(sx, sy, outerR, 0, 6.28);
      ctx.arc(sx, sy, innerR, 0, 6.28, true);
    }, hue, { locked: true, dynamic: false, linger: o.linger, dashed: o.dashed, fillRule: "evenodd" });
  }

  private tgGappedRing(
    sx: number,
    sy: number,
    innerR: number,
    outerR: number,
    gapCenter: number,
    gapWidth: number,
    hue: string,
    isCounter: boolean,
  ): void {
    if (outerR <= innerR) return;
    const { ctx } = this;
    const start = gapCenter + gapWidth / 2;
    const end = gapCenter - gapWidth / 2 + Math.PI * 2;
    ctx.save();
    ctx.globalAlpha = isCounter ? 0.1 : 0.16;
    ctx.strokeStyle = hue;
    ctx.lineWidth = outerR - innerR;
    ctx.setLineDash(isCounter ? [7, 7] : AIM_SOLID);
    ctx.beginPath();
    ctx.arc(sx, sy, (innerR + outerR) / 2, start, end);
    ctx.stroke();
    ctx.globalAlpha = isCounter ? 0.78 : 0.92;
    ctx.lineWidth = isCounter ? 2 : 3;
    ctx.beginPath();
    ctx.arc(sx, sy, innerR, start, end);
    ctx.arc(sx, sy, outerR, start, end);
    ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
  }

  private tgSafeIntersection(sx: number, sy: number, angle: number, width: number, radius: number): void {
    const { ctx } = this;
    const half = Math.max(0.08, width / 2);
    const left = angle - half;
    const right = angle + half;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(sx, sy, radius, left, right);
    ctx.stroke();
    for (const edge of [left, right]) {
      const x = sx + Math.cos(edge) * radius;
      const y = sy + Math.sin(edge) * radius;
      const inward = edge + (edge === left ? 0.22 : -0.22);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(inward + Math.PI) * 13, y + Math.sin(inward + Math.PI) * 13);
      ctx.lineTo(x + Math.cos(inward) * 13, y + Math.sin(inward) * 13);
      ctx.stroke();
    }
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
  }

  // 7. IMPACT_DISCS (set): debris / spew landing pools. Safe = the gaps between discs.
  private tgImpactDiscs(centers: Array<{ x: number; y: number }>, radius: number, hue: string, o: { locked: boolean; dynamic: boolean; linger?: number; dashed?: boolean }): void {
    for (const c of centers) {
      this.tgShape(() => { this.ctx.arc(c.x, c.y, radius, 0, 6.28); }, hue, o);
    }
  }

  // 8. RAMP_FILL (area-denial): the tether-feed zones — a filled circle whose intensity ramps
  // up over the lead ("getting hot"). Not a burst — the whole disc is denied.
  private tgRampFill(sx: number, sy: number, radius: number, intensity: number, hue: string): void {
    this.tgShape(() => { this.ctx.arc(sx, sy, radius, 0, 6.28); }, hue, {
      locked: true, dynamic: false, fillAlpha: 0.12 + 0.22 * intensity,
    });
  }

  // 9. SWEEP_ARC (swept band): the tether-snap wall / Tithe signature spokes. Pivot stays
  // clear (safe near the anchor). Draws the whole swept region as the danger band.
  private tgSweepArc(px: number, py: number, radius: number, bandW: number, startAng: number, arcSpan: number, hue: string, o: { locked: boolean; dynamic: boolean; snapFlash?: number }): void {
    const inner = Math.max(1, radius - bandW / 2), outer = radius + bandW / 2;
    this.tgShape(() => {
      const { ctx } = this;
      ctx.arc(px, py, outer, startAng, startAng + arcSpan);
      ctx.arc(px, py, inner, startAng + arcSpan, startAng, true);
      ctx.closePath();
    }, hue, o);
  }

  // 10. BARRIER_WALL (solid): the shield husk's LOS blocker. NOT hatched-danger — a SOLID
  // family-hue wall ("reposition to keep DPS"), no hot edge. Placed state, no lead.
  private tgBarrierWall(sx: number, sy: number, facing: number, width: number, hue: string): void {
    const { ctx } = this;
    const inner = 22, outer = inner + 12, half = (width / 2) / outer;
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.12 * Math.sin(this.animClock * 4);
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.arc(sx, sy, outer, facing - half, facing + half);
    ctx.arc(sx, sy, inner, facing + half, facing - half, true);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = hue;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // 11. CONVERGE_POCKET: the crossfire — N converging lanes + the shrinking SAFE pocket edge
  // (a hint line, never a fill). The pocket is CLAMPED so it can never seal (hard fairness rule).
  private tgConvergePocket(origins: Array<{ x: number; y: number }>, target: { x: number; y: number }, width: number, hue: string, o: { locked: boolean; dynamic: boolean; snapFlash?: number }, pocketR: number): void {
    for (const s of origins) {
      const ang = Math.atan2(target.y - s.y, target.x - s.x);
      this.tgLane(s.x, s.y, ang, Math.hypot(target.x - s.x, target.y - s.y) + 40, width, hue, o);
    }
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = hue;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.arc(target.x, target.y, Math.max(TG_POCKET_MIN, pocketR), 0, 6.28); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
  }

  // 12. MOVING_CAPSULE: the herder wall that translates toward you — a lane with a leading
  // motion edge so the push direction reads.
  private tgMovingCapsule(sx: number, sy: number, angle: number, length: number, width: number, hue: string): void {
    this.tgLane(sx, sy, angle, length, width, hue, { locked: true, dynamic: false });
    const { ctx } = this;
    const dx = Math.cos(angle), dy = Math.sin(angle), hw = width / 2;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#fff3c4";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx + dx * length - dy * hw, sy + dy * length + dx * hw);
    ctx.lineTo(sx + dx * length + dy * hw, sy + dy * length - dx * hw);
    ctx.stroke();
    ctx.restore();
  }

  // The per-attack dispatch: each of the reworked boss attacks binds to its primitive(s) with
  // the spec geometry, reading ONLY authoritative state (move/phase, lockedAngle, the
  // isAimLocked commit, markX/markY, boss phase). Drawn on the ground plane under the body.
  private renderBossTelegraph(e: Enemy, sx: number, sy: number): void {
    const a = e.attack;
    const hue = tgFamilyHue(e.kind);
    const phase = e.boss?.phase ?? 1;
    const cam = this.renderCam;
    const isActive = a.phase === "active";
    const wu = a.windup;
    // Aim-lock snap bookkeeping (rising edge of the authoritative isAimLocked commit).
    const st = this.tgLock.get(e.id) ?? { locked: false, flashUntil: 0 };
    if (a.isAimLocked && !st.locked) st.flashUntil = this.animClock + 0.18;
    st.locked = a.isAimLocked;
    this.tgLock.set(e.id, st);
    const snapFlash = Math.max(0, (st.flashUntil - this.animClock) / 0.18);
    const dyn = { locked: a.isAimLocked, dynamic: true, snapFlash };
    const fix = { locked: true, dynamic: false };
    const ang = a.lockedAngle;

    if (e.kind === "jet") {
      if (a.move === "mirror") {
        // A1 MIRROR SALVO — the footprint IS the copied weapon's shape, drawn in the copied
        // weapon's OWN family hue (the "that's my gun" read, §R2 exception), both keyed on the
        // authoritative mirror-family enum (EnemyWire.mfm). spread->FAN, rapid->dense dash-lane,
        // lance->LANE, arc->RING_BAND (10 shards), lob->ARC_PARABOLA + bloom, melee->short WEDGE.
        const fam = this.jetMirrorFamily(e);
        const mhue = fam ? RESONANCE_TELEGRAPH_COLOR[fam] : hue;
        if (fam === "spread") this.tgFan(sx, sy, ang, 5, 0.225, 16, 288, mhue, dyn); // 5 shards, 12.9deg apart (0.9rad), gap opens tile4+
        else if (fam === "rapid") this.tgLane(sx, sy, ang, TG_ARENA_LEN, 52, mhue, dyn); // tight aimed stream: one dense dash-through band, no pocket
        else if (fam === "lance") this.tgLane(sx, sy, ang, TG_ARENA_LEN, TILE, mhue, dyn);
        else if (fam === "arc") this.tgRingBand(sx, sy, 200 - TILE, 200, mhue, {}); // the 10-shard ring
        else if (fam === "lob") this.tgArcParabola(sx, sy, a.markX - cam.x, a.markY - cam.y, mhue); // + 1 bloom (tgArcParabola draws the landing disc)
        else if (fam === "melee") this.tgWedge(sx, sy, ang, 0.5, 120, mhue, dyn);
        else this.tgWedge(sx, sy, ang, 0.52, 240, mhue, dyn); // no family on the wire: aimed cone
      } else if (a.move === "tracer") {
        // A2 TRACER SNAP — the lock primitive at the mote's mark.
        this.tgTrackDisc(a.markX - cam.x, a.markY - cam.y, 24, a.isAimLocked, hue, snapFlash);
      } else if (a.move === "rush") {
        // A3 RECOIL LINE — a fixed capsule bisecting the arena along the recoil axis.
        this.tgLane(sx, sy, ang, 360, TILE, hue, { ...fix, back: 360 });
      } else if (a.move === "beam") {
        // A4 OVERCLOCK (P2, honest beam 72px) / SIGNATURE (P3 wide corruption corridor, ~104px to
        // cover the wider hitbox). Both DYNAMIC (lock at 60% lead on the real isAimLocked tick).
        const width = phase >= 3 ? TILE * 2.17 : TILE * 1.5; // corrupt ~104px vs overclock 72px
        this.tgLane(sx, sy, ang, TG_ARENA_LEN, width, hue, dyn);
      }
      return;
    }

    if (e.kind === "tithe") {
      if (a.move === "slam") {
        // A1 GORGE SLAM — expanding ring band (safe center + beyond) + debris discs; P2 double.
        const outer = isActive ? 240 : 60 + 180 * wu;
        this.tgRingBand(sx, sy, Math.max(TILE, outer - TILE), outer, hue, {});
        if (phase >= 2) this.tgRingBand(sx, sy, Math.max(TILE, outer * 0.55 - TILE), outer * 0.55, hue, { dashed: true });
        const debris: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < 4; i++) { const da = (i / 4) * 6.28 + 0.4; debris.push({ x: sx + Math.cos(da) * 120, y: sy + Math.sin(da) * 120 }); }
        this.tgImpactDiscs(debris, 36, hue, fix);
      } else if (a.move === "spew") {
        // A3 SPEW ARC — wave-1 discs solid + wave-2 discs (in the gaps) dashed-lighter BEFORE
        // wave-1 lands (the multi-stage read).
        const w1: Array<{ x: number; y: number }> = [], w2: Array<{ x: number; y: number }> = [];
        const step = 0.7 / 4;
        for (let i = 0; i < 5; i++) {
          const a1 = ang + (i - 2) * step;
          w1.push({ x: sx + Math.cos(a1) * 150, y: sy + Math.sin(a1) * 150 });
          const a2 = a1 + step / 2;
          w2.push({ x: sx + Math.cos(a2) * 175, y: sy + Math.sin(a2) * 175 });
        }
        this.tgImpactDiscs(w1, 36, hue, fix);
        this.tgImpactDiscs(w2, 36, hue, { locked: false, dynamic: false, dashed: true, linger: 0.7 });
      } else if (a.move === "hurl") {
        // A4 SLAB HURL — a heavy aimed lane (DYNAMIC lock).
        this.tgLane(sx, sy, ang, TG_ARENA_LEN, TILE * 1.5, hue, dyn);
      } else if (a.move === "radial") {
        // P2 radial ring burst.
        const outer = isActive ? 220 : 40 + 180 * wu;
        this.tgRingBand(sx, sy, Math.max(TILE, outer - TILE), outer, hue, {});
      } else if (a.move === "rip") {
        // SIGNATURE (P3 rip) — rotating barrage: N spoke lanes with clear wedges between (moving pockets).
        const rot = this.animClock * 1.5;
        for (let i = 0; i < 5; i++) this.tgLane(sx, sy, rot + (i / 5) * 6.28, 240, TILE * 1.5, hue, isActive ? fix : { locked: false, dynamic: false, dashed: true });
      } else if (a.move === "build") {
        // A2 TETHER FEED — the feeding zone as area-denial (RAMP_FILL): a filled disc whose
        // intensity ramps over the raise ("getting hot"), not a burst.
        this.tgRampFill(sx, sy, 72, wu, hue);
      }
      return;
    }

    if (isGiantKind(e.kind)) {
      // GIANTS (Gorge/Pale) share the footprint; `hue` (tgFamilyHue) is already the giant's material
      // color (Gorge warm, Pale cold-blue), and the spoke geometry rides the per-giant constants.
      const gc = giantConstFor(e.kind);
      if (a.move === "slam") {
        const gapWidth = (gc.ringGap / gc.ringCount) * Math.PI * 2;
        const ringIndex = isActive && e.boss?.spinCount === 0 && gc.ring2DelaySec !== undefined ? 1 : 0;
        const gapCenter = giantRingGapCenter(e.boss?.attackCount ?? 0, ringIndex, gc);
        const outer = isActive ? 240 : 60 + 180 * wu;
        this.tgGappedRing(
          sx,
          sy,
          Math.max(TILE, outer - TILE),
          outer,
          gapCenter,
          gapWidth,
          ringIndex === 1 ? "#bfeaff" : hue,
          ringIndex === 1,
        );
        if (ringIndex === 1) this.tgSafeIntersection(sx, sy, gapCenter, gapWidth, Math.max(90, outer - TILE));
      } else if (a.move === "spew") {
        // P2 ZONING — a "charging area-denial" ramp on the giant; the persistent slag pools
        // themselves (planted CLEAR of every player, then visible cinder) carry the exact
        // footprint, forming the shrinking safe area.
        this.tgRampFill(sx, sy, 90, wu, hue);
      } else if (a.move === "sweep") {
        const emission = isActive ? Math.max(0, (e.boss?.spinCount ?? 1) - 1) : 0;
        const parity = e.boss?.burstParity ?? 0;
        const primary = giantSpokeWheel(emission, parity, 0, gc);
        for (let i = gc.spokeGap; i < gc.spokeCount; i++) {
          this.tgLane(sx, sy, primary + (i / gc.spokeCount) * Math.PI * 2, 240, TILE, hue, {
            ...fix,
            fillAlpha: 0.07,
            edgeColor: hue,
          });
        }
        if (gc.spoke2Step !== undefined) {
          const gap2 = gc.spoke2Gap ?? gc.spokeGap;
          const counter = giantSpokeWheel(emission, parity, 1, gc);
          for (let i = gap2; i < gc.spokeCount; i++) {
            this.tgLane(sx, sy, counter + (i / gc.spokeCount) * Math.PI * 2, 240, TILE, "#bfeaff", {
              ...fix,
              dashed: true,
              fillAlpha: 0.035,
              edgeColor: "#e5f8ff",
            });
          }
          const safe = giantSafeIntersection(emission, parity, gc);
          if (safe !== null) this.tgSafeIntersection(sx, sy, safe.center, safe.width, 190);
        }
      }
      return;
    }

    // QUORUM
    const husks = this.enemies.filter((o) => !o.dead && (o.kind === "quorum_shield" || o.kind === "quorum_heal" || o.kind === "quorum_dmg"));
    if (a.move === "beam") {
      // A1 CROSSFIRE — converging lanes from the live husks + the shrinking safe pocket edge.
      const origins = husks.length > 0 ? husks.map((h) => ({ x: h.x - cam.x, y: h.y - cam.y })) : [{ x: sx, y: sy }];
      const pocketR = isActive ? TG_POCKET_MIN : 192 - 128 * wu;
      this.tgConvergePocket(origins, { x: sx, y: sy }, TILE, hue, dyn, pocketR);
    } else if (a.move === "sweep") {
      // A2 TETHER SNAP — a swept wall around the anchor (shield husk if alive, else the core).
      const shield = husks.find((h) => h.kind === "quorum_shield");
      const px = shield ? shield.x - cam.x : sx, py = shield ? shield.y - cam.y : sy;
      this.tgSweepArc(px, py, 200, TILE * 1.5, ang - 1.5 / 2, 1.5, hue, fix);
    } else if (a.move === "volley") {
      // A3 ROLE VOLLEY — the dmg role's aimed burst lanes (48px) + the heal role's knockback
      // ring (outer 120px, band 48px).
      for (let i = 0; i < 3; i++) this.tgLane(sx, sy, ang + (i - 1) * 0.08, 320, TILE, hue, dyn);
      const heal = husks.find((h) => h.kind === "quorum_heal");
      if (heal) this.tgRingBand(heal.x - cam.x, heal.y - cam.y, 120 - TILE, 120, hue, { dashed: true });
    } else if (a.move === "radial") {
      // Radial ring (husk-phase / merge combo).
      const outer = isActive ? 220 : 40 + 180 * wu;
      this.tgRingBand(sx, sy, Math.max(TILE, outer - TILE), outer, hue, {});
    }
    // A4 HUNT PAIR — the herder MOVING_CAPSULE (a slow advancing wall) pairs with a charger
    // LANE. There is no distinct hunt move on the wire yet (spec OPEN — the current sim routes
    // husk-phase pressure through beam/sweep/volley/radial), so quorumHuntHerder returns null
    // today; the capsule binds the moment the hunt move crosses the wire.
    const herder = this.quorumHuntHerder(e);
    if (herder) this.tgMovingCapsule(herder.sx, herder.sy, herder.ang, 240, TILE * 1.5, hue);
  }

  // Jet's mirror-salvo copied family (authoritative EnemyWire.mfm, restored into
  // boss.mirrorFamily): the index selects the copied weapon's telegraph shape + its own hue.
  // null when the enum is out of range (older frame / not a mirror salvo).
  private jetMirrorFamily(e: Enemy): ResonanceFamily | null {
    const i = e.boss?.mirrorFamily ?? -1;
    return i >= 0 && i < RESONANCE_FAMILIES.length ? RESONANCE_FAMILIES[i] : null;
  }

  // Quorum's hunt-pair herder (the advancing wall). No distinct hunt move rides the wire yet
  // (spec OPEN), so this returns null; it binds to the herder husk's advance once it lands.
  private quorumHuntHerder(_e: Enemy): { sx: number; sy: number; ang: number } | null {
    return null;
  }

  // The shield husk's persistent LOS-blocking barrier (BARRIER_WALL): a solid bone-cyan wall
  // on its OUTWARD face (away from the core it guards) while it lives — "reposition to keep DPS."
  private renderShieldBarrier(e: Enemy, sx: number, sy: number): void {
    const core = this.enemies.find((o) => !o.dead && o.kind === "quorum");
    const facing = core ? Math.atan2(e.y - core.y, e.x - core.x) : e.attack.lockedAngle;
    this.tgBarrierWall(sx, sy, facing, TILE * 2, tgFamilyHue("quorum"));
  }

  // The boss hop-slam's growing footprint: a filled danger disc + bright rim. It tracks
  // the target while charging, then freezes at aim-lock so you can simply walk off it.
  private renderSlamMarker(e: Enemy) {
    const { ctx, renderCam: cam } = this;
    const a = e.attack;
    const sx = a.markX - cam.x, sy = a.markY - cam.y;
    const grow = a.phase === "windup" ? a.windup : 1;
    const r = BOSS_SLAM_RADIUS * grow;
    if (r < 1) return;
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.14 * grow;
    ctx.fillStyle = "#ff5a5a";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.fill();
    ctx.globalAlpha = 0.5 + 0.3 * grow;
    ctx.strokeStyle = "#ffd27a";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.stroke();
    ctx.restore();
  }

  private renderGhostShimmer(e: Enemy, sx: number, sy: number) {
    const { ctx } = this;
    const clock = this.animForEnemy(e).clock;
    const n = 4;
    ctx.save();
    ctx.fillStyle = "#e8faff";
    for (let i = 0; i < n; i++) {
      const ang = clock * 2 + (i / n) * 6.28;
      const rad = 10 + (i % 2) * 8;
      ctx.globalAlpha = 0.5 * e.attack.windup * (0.5 + 0.5 * Math.sin(clock * 9 + i));
      ctx.fillRect(sx + Math.cos(ang) * rad - 1, sy + Math.sin(ang) * rad - 1, 2, 2);
    }
    ctx.restore();
  }

  // JET's MIRROR-IMAGE ECHO — the AD's make-or-break readability gate, built to the exact
  // quantified spec (JET_SURPRISE_LAYER_DIRECTION). The echo is player-SHAPED, so shape can NEVER
  // separate it from a teammate — the ENTIRE tell rides value + opacity + cold + telegraph:
  //  - BODY: a NEAR-BLACK (JET_ECHO_INK, lum ~0.05) tinted silhouette at <=40% opacity (floor
  //    shows through) — an enormous value gap under a teammate's bright ~0.68 solid body. Never
  //    brightened toward the teammate range.
  //  - RIM: a THIN cold-blue edge (never a fill) with sparse cold hot-points (anti-vanish).
  //  - SEAMS: DARK dead-amber ONLY — never hero-bright amber (bright amber IS a teammate).
  //  - EYES: hollow voids with a cold-cyan pinpoint.
  //  - TELEGRAPH: the 0.7s pre-fire cold hatched danger-edge (a separator no teammate has).
  // Drawn fully here (the caller skips the generic body pass) so the value/opacity are guaranteed.
  private renderJetEcho(e: Enemy, sx: number, sy: number, size: number, pose: EnemyPose, clock: number) {
    const { ctx } = this;
    const a = e.attack;
    const fade = e.aux > 0 ? Math.min(1, e.aux / 0.6) : 1; // dissolves to resin flecks as its life ends
    // The 0.7s pre-fire telegraph FIRST (under the body) — a cold hatched danger-edge.
    if (a.phase === "windup") this.renderJetEchoTelegraph(e, sx, sy);
    // BODY — near-black tinted silhouette (the exact player pose) at <=40% opacity.
    const choice = this.sprites.selectClip("jet_echo", pose);
    const facing = choice.isMirrored ? -1 : 1;
    const xf = characterXform(this.animForEnemy(e), CHARACTER_STYLE);
    this.drawChar("jet_echo", choice.clip, sx, sy, size, facing, xf, 1, 0.38 * fade, 0, clock, JET_ECHO_INK, choice.isHoldFirstFrame);
    const r = size * 0.32;
    const pulse = 0.6 + 0.4 * Math.sin(clock * 6 + e.id);
    ctx.save();
    // RIM — a THIN cold-blue edge (never a fill).
    ctx.globalAlpha = 0.8 * fade;
    ctx.strokeStyle = JET_ECHO_RIM;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, sy, r * 1.02, 0, 6.28); ctx.stroke();
    // Sparse cold hot-points on the rim (anti-vanish, never warm).
    ctx.globalAlpha = (0.4 + 0.4 * pulse) * fade;
    ctx.fillStyle = JET_ECHO_RIM_HOT;
    for (let i = 0; i < 3; i++) {
      const ang = clock * 0.6 + (i / 3) * 6.28;
      ctx.beginPath(); ctx.arc(sx + Math.cos(ang) * r * 1.02, sy + Math.sin(ang) * r * 1.02, 1.3, 0, 6.28); ctx.fill();
    }
    // SEAMS — DARK dead-amber only (never hero-bright amber).
    ctx.globalAlpha = 0.55 * fade;
    ctx.strokeStyle = JET_ECHO_SEAM;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * 6.28 + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(ang) * r * 0.2, sy + Math.sin(ang) * r * 0.2);
      ctx.lineTo(sx + Math.cos(ang) * r * 0.9, sy + Math.sin(ang) * r * 0.9);
      ctx.stroke();
    }
    // EYES — hollow voids, each with a cold-cyan pinpoint.
    for (const ex of [-0.28, 0.28]) {
      ctx.globalAlpha = 0.85 * fade;
      ctx.fillStyle = "#04070c";
      ctx.beginPath(); ctx.arc(sx + r * ex, sy - r * 0.1, r * 0.15, 0, 6.28); ctx.fill();
      ctx.globalAlpha = (0.6 + 0.4 * pulse) * fade;
      ctx.fillStyle = JET_ECHO_EYE_PIN;
      ctx.beginPath(); ctx.arc(sx + r * ex, sy - r * 0.1, 1.2, 0, 6.28); ctx.fill();
    }
    ctx.restore();
  }

  // The echo's 0.7s pre-fire in the reserved enemy-telegraph register — a COLD hatched
  // danger-edge (no teammate has a telegraph, so it is another separator): the salvo bearing as
  // a cold aim lane + a hatched cold rim that tightens as the shot nears.
  private renderJetEchoTelegraph(e: Enemy, sx: number, sy: number) {
    const { ctx } = this;
    const a = e.attack;
    const w = a.windup;
    const size = this.enemyDrawSize(e);
    ctx.save();
    ctx.globalAlpha = (a.isAimLocked ? 0.85 : 0.4) * (0.55 + 0.45 * w);
    ctx.strokeStyle = JET_ECHO_TELL;
    ctx.lineWidth = a.isAimLocked ? 3 : 1.5;
    ctx.setLineDash(a.isAimLocked ? AIM_SOLID : AIM_DASH);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a.lockedAngle) * 220, sy + Math.sin(a.lockedAngle) * 220);
    ctx.stroke();
    const r = size * (0.55 + 0.3 * w);
    ctx.globalAlpha = 0.4 + 0.45 * w;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 5]); // hatched cold danger-edge
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.28); ctx.stroke();
    ctx.setLineDash(AIM_SOLID);
    ctx.restore();
  }

  // The boss arena room a body sits in (mirrors the sim's jetArenaRoom): the last room on a
  // boss floor, else the room whose tile-rect holds the body. Used for the safe-pocket wash.
  private arenaRoomFor(e: Enemy | undefined): Room | null {
    const d = this.dungeon;
    if (e) {
      const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
      for (const room of d.rooms) {
        if (tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h) return room;
      }
    }
    return d.rooms.length > 0 ? d.rooms[d.rooms.length - 1] : null;
  }

  // AD Part 2 safe-pocket read: as the drain zones close in, wash the uncorrupted interior a
  // touch warmer/lighter in DEAD-amber (never hero-bright) so the eye finds it. Data-driven —
  // the pocket radius is the distance from the arena center to the nearest drain zone, so it
  // shrinks exactly as the corruption creeps in (P2 -> P3).
  private renderCorruptSafePocket() {
    let hasCorrupt = false;
    for (const h of this.hazards) { if (h.kind === "corrupt") { hasCorrupt = true; break; } }
    if (!hasCorrupt) return;
    const room = this.arenaRoomFor(this.enemies.find((e) => e.kind === "jet"));
    if (!room) return;
    const cx = (room.cx + 0.5) * TILE, cy = (room.cy + 0.5) * TILE;
    let safeR = Infinity;
    for (const h of this.hazards) {
      if (h.kind !== "corrupt") continue;
      safeR = Math.min(safeR, Math.hypot(h.x - cx, h.y - cy) - h.radius);
    }
    if (!isFinite(safeR) || safeR < TILE) return;
    const { ctx, renderCam: cam } = this;
    const psx = cx - cam.x, psy = cy - cam.y;
    ctx.save();
    const g = ctx.createRadialGradient(psx, psy, safeR * 0.3, psx, psy, safeR);
    g.addColorStop(0, `rgba(${JET_SAFE_AMBER},0.10)`);
    g.addColorStop(1, `rgba(${JET_SAFE_AMBER},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(psx, psy, safeR, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  // Layered status visuals, all additive via the shared fx path. Dedicated masks
  // (ember/frost/freeze_shell) light up if the AD art is present; until then the
  // always-loaded glow_round + crackle carry the tint so the status still reads.
  private renderEnemyStatus(e: Enemy, sx: number, sy: number, size: number) {
    const clock = this.animForEnemy(e).clock;
    if (e.burn > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(clock * 12);
      this.fxLayer("glow_round", BURN_TINT, sx, sy, size * 1.15, size * 1.15, 0.2 + 0.18 * pulse, 0);
      // Bias the embers onto the lower body/edges (not the upper-center face) so the
      // enemy's eyes — part of its identity/menace — stay readable while burning.
      this.fxLayer("ember", BURN_TINT, sx, sy + size * 0.14, size * 0.82, size * 0.82, 0.45 + 0.3 * pulse, clock);
    }
    if (e.chill > 0) {
      const isFrozen = this.isFrozen(e);
      this.fxLayer("glow_round", CHILL_TINT, sx, sy, size * 1.1, size * 1.1, isFrozen ? 0.4 : 0.22, 0);
      this.fxLayer("frost", CHILL_TINT, sx, sy, size, size, 0.5, 0);
      if (isFrozen) this.fxLayer("freeze_shell", FREEZE_TINT, sx, sy, size * 1.05, size * 1.05, 0.85, 0);
    }
    if (e.shock > 0) {
      const pulse = 0.6 + 0.4 * Math.sin(clock * 20);
      // A dilating electric ring (AD's shock_ring mask) reads the shocked state at a
      // glance; the crackle sits on top for the sparky detail. Both fall through to
      // just the crackle if the ring mask isn't loaded (fxLayer no-ops on a missing tint).
      this.fxLayer("shock_ring", SHOCK_TINT, sx, sy, size * (1.0 + 0.25 * pulse), size * (1.0 + 0.25 * pulse), 0.35 + 0.35 * pulse, clock * 4);
      // Ring stays centered (it frames the silhouette edges); bias the crackle detail
      // down onto the body so the sparks don't bury the enemy's face/eyes.
      this.fxLayer("crackle", SHOCK_TINT, sx, sy + size * 0.12, size * 0.85, size * 0.85, pulse, clock * 9);
    }
  }

  // PHANTOM MARK (Wave 2): a pulsing violet vulnerability ring so the whole team reads a marked
  // (+15% damage-taken) enemy at a glance. Pure cosmetic — the mark itself is authoritative sim
  // state (e.markT) reconciled from the snapshot.
  private renderMarkGlow(e: Enemy, sx: number, sy: number, size: number) {
    const pulse = 0.6 + 0.4 * Math.sin(this.animForEnemy(e).clock * 8);
    this.fxLayer("glow_round", MARK_TINT, sx, sy, size * 1.25, size * 1.25, 0.18 + 0.16 * pulse, 0);
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.35 * pulse;
    ctx.strokeStyle = MARK_TINT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.5, 0, 6.28);
    ctx.stroke();
    ctx.restore();
  }

  // Cat STALK info pip (v46): a small downward caret hovering over a marked body. It reads as a
  // "watched" tag, never a threat/vulnerability cue — the authoritative mark (e.petMarkT) carries
  // no gameplay effect, so the glyph stays deliberately quiet.
  private renderStalkPip(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const bob = Math.sin(this.animForEnemy(e).clock * 4) * 2;
    const cy = sy - size * 0.8 + bob;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = STALK_TINT;
    ctx.beginPath();
    ctx.moveTo(sx, cy + 5);
    ctx.lineTo(sx - 4, cy - 2);
    ctx.lineTo(sx + 4, cy - 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // MENDER heal BEAM (Wave 2): a soft green tether from the local Mender to the lowest-HP living
  // ally in Lifebloom range — you SEE who the passive is topping off. Pure cosmetic (mirrors the
  // sim's lowestHpAllyInRange target); no beam when solo or nobody in range needs it.
  private renderHealBeam() {
    if (this.p.kitId !== "mender" || this.isDown) return;
    let best: RemotePlayer | null = null;
    let bestMissing = 0;
    for (const r of this.remotes()) {
      if (r.isDown || r.isAbsent || r.hp <= 0 || r.hp >= r.maxHp) continue;
      if (Math.hypot(r.x - this.px, r.y - this.py) > LIFEBLOOM.range) continue;
      const missing = r.maxHp - r.hp;
      if (missing > bestMissing) { bestMissing = missing; best = r; }
    }
    if (best === null) return;
    const { ctx, renderCam: cam } = this;
    const ax = this.px - cam.x, ay = this.py - cam.y;
    const bx = best.x - cam.x, by = best.y - cam.y;
    const pulse = 0.5 + 0.5 * Math.sin(this.animClock * 6);
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.25 * pulse;
    ctx.strokeStyle = "#7fe6a8";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.globalAlpha = 0.5 + 0.3 * pulse;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
  }

  private renderBullets() {
    const { ctx, renderCam: cam } = this;
    for (const b of this.bullets) {
      const bx = b.x - cam.x, by = b.y - cam.y;
      // Off-screen rounds draw nothing visible; skip their (multi-layer) FX entirely so a
      // spray weapon's rounds flying past the view cost nothing. Margin covers the glow/streak
      // reach so a round about to enter frame is never clipped early.
      if (!this.isNearCamera(b.x, b.y, 48)) continue;
      if (b.friendly) {
        // Layered additive sprite FX per weapon; falls back to the plain circle if the
        // recipe's core sprite hasn't loaded yet, so a bullet always renders.
        if (b.fx && this.drawBulletFx(b, bx, by)) continue;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, b.radius, 0, 6.28); ctx.fill();
      } else {
        // Enemy fire: a uniform ROUND hot-orb (NEVER streaked — round is the enemy signifier
        // vs the player's streaky bullets; the fastest "mine vs theirs" read at 4p). Three
        // layers, preserving the readability structure: soft hue danger-halo -> saturated hue
        // mid (at the TRUE b.radius = the real hitbox) -> a white-hot CORE (the "dodge this"
        // signal). Uses the shipped glow primitives; falls back to flat circles until they load.
        // Glow alpha is capped so 10+ overlapping orbs stay countable, never a white-out soup.
        const R = b.radius;
        // Halo: soft, translucent, clearly bigger-but-softer so it never reads as a bigger hitbox.
        if (!this.fxLayer("glow_round", b.color, bx, by, R * 5.2, R * 5.2, 0.3, 0)) {
          ctx.globalAlpha = 0.32; ctx.fillStyle = b.color;
          ctx.beginPath(); ctx.arc(bx, by, R * 1.9, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1;
        }
        // Saturated mid at the TRUE radius (the collision size players dodge).
        ctx.globalAlpha = 1; ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, R, 0, 6.28); ctx.fill();
        // White-hot core (THE incoming-threat signal — stays near-white, never tinted). A
        // 1px dark inner rim keeps it separable on the brightest biome (Emberreach) too.
        if (!this.fxLayer("core_dot", "#fff6f0", bx, by, R * 1.3, R * 1.3, 1, 0)) {
          ctx.fillStyle = "#fff6f0";
          ctx.beginPath(); ctx.arc(bx, by, R * 0.42, 0, 6.28); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private fxLayer(name: FxName, color: string, x: number, y: number, w: number, h: number, alpha: number, angle: number): boolean {
    // One tinted FX primitive, drawn additively and centered (px sizes), optionally
    // rotated. Returns whether it drew — the source sprite may still be streaming in.
    const img = this.sprites.fxTinted(name, color);
    if (!img) return false;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (angle !== 0) ctx.rotate(angle);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    return true;
  }

  private fxTrail(name: FxName, color: string, x: number, y: number, len: number, thick: number, alpha: number, angle: number): boolean {
    // trail_streak/comet_trail are authored bright-head-at-+X; anchoring that head on the
    // bullet and extending backward (len px) makes the streak trail the shot.
    const img = this.sprites.fxTinted(name, color);
    if (!img) return false;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(img, -len, -thick / 2, len, thick);
    ctx.restore();
    return true;
  }

  private drawBulletFx(b: Bullet, bx: number, by: number): boolean {
    // Per-weapon look: [smoke] -> glow -> trail (to velocity) -> core/slug, all additive.
    // Tinted canvases are cached, so this is allocation-free. Returns false only when the
    // recipe's core sprite is still loading (the caller then draws the fallback circle).
    const color = b.color;
    const R = b.radius;
    const angle = Math.atan2(b.vy, b.vx);
    const speed = Math.hypot(b.vx, b.vy);
    // Streak length tracks bullet speed (clamped), so faster rounds read as longer smears.
    const trailLen = Math.min(R * 9, Math.max(R * 2.5, speed * 0.05));
    switch (b.fx) {
      case "pistol":
        this.fxLayer("glow_round", color, bx, by, R * 8, R * 8, 0.5, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.6, R * 2, 0.55, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 3, R * 3, 1, 0);
      case "shotgun":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.45, 0);
        return this.fxLayer("slug", color, bx, by, R * 3.6, R * 3.6, 1, angle);
      case "rapid":
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.3, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen, R * 1.8, 0.6, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 2.4, R * 2.4, 1, 0);
      case "smg":
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.35, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.75, R * 1.9, 0.55, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 2.8, R * 2.8, 1, 0);
      case "cannon":
        this.fxLayer("smoke_puff", "#c9b8a0", bx - Math.cos(angle) * R * 2.2, by - Math.sin(angle) * R * 2.2, R * 5, R * 5, 0.4, 0);
        this.fxLayer("glow_round", color, bx, by, R * 10, R * 10, 0.5, 0);
        return this.fxLayer("slug", color, bx, by, R * 5, R * 5, 1, angle);
      case "burst":
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.45, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.5, R * 2, 0.5, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 3, R * 3, 1, 0);
      case "ricochet":
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.4, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.75, R * 2, 0.55, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 3, R * 3, 1, 0);
      case "homing":
        this.fxLayer("glow_round", color, bx, by, R * 7, R * 7, 0.5, 0);
        return this.fxTrail("comet_trail", color, bx, by, Math.max(R * 6, trailLen), R * 4, 0.7, angle);
      case "tesla":
        this.fxLayer("glow_round", color, bx, by, R * 7, R * 7, 0.5, 0);
        this.fxLayer("crackle", color, bx, by, R * 4.5, R * 4.5, 0.9, this.animClock * 9);
        return this.fxLayer("core_dot", color, bx, by, R * 2.6, R * 2.6, 1, 0);
      case "sawnoff":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.45, 0);
        return this.fxLayer("slug", color, bx, by, R * 3.6, R * 3.6, 1, angle);
      case "railgun":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.45, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen, R * 1.4, 0.7, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 2.2, R * 2.2, 1, 0);
      case "nailer":
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.4, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.75, R * 2, 0.55, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 3, R * 3, 1, 0);
      case "flamer":
        // Flame stream: a soft puff of fire (dedicated mask if present) under a warm glow
        // and a bright hot core, so the fast short-life pellets blur into a flame cone.
        this.fxLayer("flame_puff", color, bx, by, R * 4.5, R * 4.5, 0.75, angle);
        this.fxLayer("glow_round", color, bx, by, R * 5.5, R * 5.5, 0.5, 0);
        return this.fxLayer("core_dot", "#ffe6a0", bx, by, R * 2.4, R * 2.4, 0.9, 0);
      case "mortar":
        // A heavy lobbed shell: smoke billowing off the tail, warm glow, fat slug head.
        this.fxLayer("smoke_puff", "#c9b8a0", bx - Math.cos(angle) * R * 2.4, by - Math.sin(angle) * R * 2.4, R * 4.5, R * 4.5, 0.45, 0);
        this.fxLayer("glow_round", color, bx, by, R * 8, R * 8, 0.5, 0);
        return this.fxLayer("slug", color, bx, by, R * 4.2, R * 4.2, 1, angle);
      case "beam": {
        // The lance: rounds so fast and frequent the streaks fuse into one continuous line of
        // light. The bright head sits ON the round (its true position), and the whole ray is
        // capped at the round's actual reach (life × speed) — so the drawn beam never extends
        // past where the rounds can hit. Players read the lance's true reach, not a longer ray.
        const reach = WEAPONS.beam.life * WEAPONS.beam.speed;
        const beamLen = Math.min(reach, Math.max(trailLen, R * 24)); // >= round spacing so the ray never dashes
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        if (!this.fxTrail("beam_ray", color, bx, by, beamLen, R * 3, 0.9, angle)) {
          this.fxTrail("trail_streak", color, bx, by, beamLen, R * 2.4, 0.85, angle);
        }
        return this.fxLayer("core_dot", "#fff7dd", bx, by, R * 2, R * 2, 1, 0);
      }
      case "cleaver": {
        // Spinning saw disc: a heavy core that visibly rotates, over a cold glow (no trail —
        // it's a slow thrown blade, not a bullet).
        this.fxLayer("glow_round", color, bx, by, R * 4.5, R * 4.5, 0.4, 0);
        this.fxLayer("crackle", color, bx, by, R * 3.2, R * 3.2, 0.35, this.animClock * 16);
        return this.fxLayer("slug", color, bx, by, R * 3.4, R * 3.4, 1, this.animClock * 18);
      }
      case "scrapper":
        // Small fast scrap pellets: a tight core + short streak, low glow (sprayed in pairs).
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.3, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.7, R * 1.8, 0.55, angle);
        return this.fxLayer("core_dot", color, bx, by, R * 2.8, R * 2.8, 1, 0);
      case "skipper":
        // Bouncy buckshot slugs: fat slug head + soft glow, short streak so ricochets read.
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.45, R * 1.8, 0.45, angle);
        return this.fxLayer("slug", color, bx, by, R * 3.4, R * 3.4, 1, angle);
      case "arcbolt":
        // Electric bolt: crackling arc over a hot core (like tesla but shorter-lived).
        this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.5, 0);
        this.fxLayer("crackle", color, bx, by, R * 4.2, R * 4.2, 0.9, this.animClock * 11);
        return this.fxLayer("core_dot", color, bx, by, R * 2.6, R * 2.6, 1, 0);
      case "cryobolt":
        // Frost round: an icy frost mask (falls back to glow) trailing a cold streak + core.
        this.fxLayer("frost", color, bx, by, R * 5, R * 5, 0.7, angle) || this.fxLayer("glow_round", color, bx, by, R * 6, R * 6, 0.5, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.7, R * 1.8, 0.5, angle);
        return this.fxLayer("core_dot", "#eafaff", bx, by, R * 2.4, R * 2.4, 1, 0);
      case "firebomb": {
        // A lobbed fire shell: smoke off the tail, a fiery puff, warm glow, fat hot slug.
        this.fxLayer("smoke_puff", "#c9b8a0", bx - Math.cos(angle) * R * 2.2, by - Math.sin(angle) * R * 2.2, R * 4, R * 4, 0.4, 0);
        this.fxLayer("flame_puff", color, bx, by, R * 4.5, R * 4.5, 0.7, angle) || this.fxLayer("glow_round", color, bx, by, R * 8, R * 8, 0.5, 0);
        return this.fxLayer("slug", "#ffd08a", bx, by, R * 4, R * 4, 1, angle);
      }
      case "tracker":
        // A heavy seeker: a long comet tail over a strong glow (reads as a homing missile).
        this.fxLayer("glow_round", color, bx, by, R * 7, R * 7, 0.5, 0);
        return this.fxTrail("comet_trail", color, bx, by, Math.max(R * 7, trailLen), R * 4, 0.75, angle);
      case "singularity": {
        // The void round: a dark-purple swirling core (counter-rotating crackle) with a heavy
        // glow — reads as a little collapsing gravity well, not a bullet.
        this.fxLayer("glow_round", color, bx, by, R * 9, R * 9, 0.6, 0);
        this.fxLayer("crackle", color, bx, by, R * 5, R * 5, 0.5, -this.animClock * 7);
        this.fxLayer("crackle", "#f0d9ff", bx, by, R * 3.4, R * 3.4, 0.6, this.animClock * 10);
        return this.fxLayer("core_dot", "#e9d2ff", bx, by, R * 2.2, R * 2.2, 1, 0);
      }
      case "mooring_nail":
        this.fxTrail("trail_streak", color, bx, by, trailLen, R * 1.4, 0.65, angle);
        this.fxLayer("chain_link", color, bx, by, R * 4.5, R * 2.2, 0.55, angle);
        return this.fxLayer("slug", "#f1e6c8", bx, by, R * 5, R * 2.2, 1, angle);
      case "sluicegate":
        if (b.sluiceMode === "drain") {
          this.fxLayer("glow_round", "#d9fbff", bx, by, R * 4, R * 4, 0.35, 0);
          this.fxTrail("beam_ray", "#d9fbff", bx, by, Math.max(trailLen, R * 14), R * 2, 0.85, angle);
          return this.fxLayer("core_dot", "#ffffff", bx, by, R * 2, R * 2, 1, 0);
        }
        this.fxLayer("glow_round", color, bx, by, R * 6.5, R * 6.5, 0.4, 0);
        this.fxTrail("comet_trail", color, bx, by, trailLen * 0.5, R * 3, 0.5, angle);
        return this.fxLayer("slug", "#b9edf0", bx, by, R * 4, R * 3, 0.9, angle);
      case "oddsmaker":
        if (b.oddsmakerOutcome === "ricochet") {
          this.fxLayer("crackle", "#c98bff", bx, by, R * 5, R * 5, 0.8, this.animClock * 9);
          return this.fxLayer("slug", "#fff7dd", bx, by, R * 3.4, R * 3.4, 1, angle + Math.PI / 4);
        }
        if (b.oddsmakerOutcome === "seeker") {
          this.fxLayer("glow_round", "#8affe0", bx, by, R * 7, R * 7, 0.5, 0);
          return this.fxTrail("comet_trail", "#8affe0", bx, by, Math.max(R * 7, trailLen), R * 4, 0.75, angle);
        }
        if (b.oddsmakerOutcome === "blast") {
          this.fxLayer("smoke_puff", "#c9b8a0", bx - Math.cos(angle) * R * 2, by - Math.sin(angle) * R * 2, R * 4, R * 4, 0.4, 0);
          this.fxLayer("glow_round", "#ffb43b", bx, by, R * 8, R * 8, 0.5, 0);
          return this.fxLayer("slug", "#fff0bd", bx, by, R * 4.2, R * 4.2, 1, angle);
        }
        this.fxTrail("trail_streak", "#e8f0ff", bx, by, Math.max(trailLen, R * 10), R * 1.4, 0.8, angle);
        return this.fxLayer("core_dot", "#ffffff", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "pathmaker":
        this.fxLayer("frost", color, bx, by, R * 4.5, R * 4.5, 0.6, angle);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.55, R * 1.8, 0.45, angle);
        return this.fxLayer("core_dot", "#e9f8df", bx, by, R * 2.4, R * 2.4, 1, 0);
      case "resonant_fork":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        this.fxTrail("trail_streak", "#e6dcff", bx, by, Math.max(trailLen, R * 7), R * 1.6, 0.7, angle);
        return this.fxLayer("core_dot", "#ffffff", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "red_pen":
        if (b.isPenSnap === true) {
          this.fxLayer("crackle", "#ff6a66", bx, by, R * 6, R * 6, 0.85, this.animClock * 8);
          return this.fxLayer("slug", "#fff0ee", bx, by, R * 4, R * 4, 1, angle);
        }
        this.fxTrail("trail_streak", color, bx, by, Math.max(trailLen, R * 8), R * 1.4, 0.75, angle);
        return this.fxLayer("core_dot", "#ffe3e1", bx, by, R * 2, R * 2, 1, 0);
      case "margin_call":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        this.fxTrail("comet_trail", color, bx, by, trailLen * 0.6, R * 2.4, 0.55, angle);
        return this.fxLayer("slug", "#fff4c8", bx, by, R * 3.4, R * 3.4, 1, angle);
      case "sidewinder":
        this.fxLayer("glow_round", color, bx, by, R * 4.5, R * 4.5, 0.4, 0);
        this.fxTrail("comet_trail", "#a6f0b0", bx, by, Math.max(trailLen, R * 6), R * 2, 0.7, angle);
        return this.fxLayer("core_dot", "#eafff0", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "hushiron":
        this.fxTrail("trail_streak", color, bx, by, Math.max(trailLen, R * 8), R * 1.4, 0.7, angle);
        return this.fxLayer("core_dot", "#e6eef4", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "backtalk":
        if (b.isBacktalkReturn === true) {
          this.fxLayer("crackle", "#ffb27a", bx, by, R * 6, R * 6, 0.8, this.animClock * 8);
          return this.fxLayer("slug", "#fff2e6", bx, by, R * 3.6, R * 3.6, 1, angle);
        }
        this.fxTrail("comet_trail", color, bx, by, trailLen * 0.6, R * 2, 0.55, angle);
        return this.fxLayer("core_dot", "#ffe8d6", bx, by, R * 2, R * 2, 1, 0);
      case "lamplighter":
        this.fxLayer("glow_round", color, bx, by, R * (b.lampLit === true ? 6 : 4.5), R * (b.lampLit === true ? 6 : 4.5), b.lampLit === true ? 0.6 : 0.4, 0);
        this.fxTrail("trail_streak", "#fff0c0", bx, by, Math.max(trailLen, R * 6), R * 1.6, 0.65, angle);
        return this.fxLayer("core_dot", "#fffdf0", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "faultlink":
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        this.fxTrail("trail_streak", b.isFaultEcho === true ? "#c9fff0" : "#8ad6c9", bx, by, Math.max(trailLen, R * 7), R * 1.5, 0.7, angle);
        return this.fxLayer("core_dot", "#eafffb", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "lastlight":
        // The desperate round: a fierce red glow trailing a hot streak into a white-hot core
        // that blazes brightest when HP runs low — the last-stand ember.
        this.fxLayer("glow_round", color, bx, by, R * 8, R * 8, 0.55, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.7, R * 2.2, 0.6, angle);
        return this.fxLayer("core_dot", "#ffe0d0", bx, by, R * 3, R * 3, 1, 0);
      case "breach":
        // A charged demolition shell: smoke off the tail, a warm glow, a fat slug head — a
        // heavier sibling of the mortar lob.
        this.fxLayer("smoke_puff", "#c9b8a0", bx - Math.cos(angle) * R * 2.4, by - Math.sin(angle) * R * 2.4, R * 4.5, R * 4.5, 0.45, 0);
        this.fxLayer("glow_round", color, bx, by, R * 9, R * 9, 0.5, 0);
        return this.fxLayer("slug", color, bx, by, R * 4.4, R * 4.4, 1, angle);
      case "frostline":
        // The chill bead: an icy frost mask (falls back to glow) dripping a short cold streak
        // into a pale frozen core — it paints the floor, so the round itself reads as frost.
        this.fxLayer("frost", color, bx, by, R * 4.5, R * 4.5, 0.7, angle) || this.fxLayer("glow_round", color, bx, by, R * 5.5, R * 5.5, 0.5, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.55, R * 1.7, 0.45, angle);
        return this.fxLayer("core_dot", "#eafaff", bx, by, R * 2.2, R * 2.2, 1, 0);
      case "sentry":
        // The turret's prism bolt: a tidy focused round — soft glow, short streak, a bright
        // crystalline core.
        this.fxLayer("glow_round", color, bx, by, R * 5.5, R * 5.5, 0.4, 0);
        this.fxTrail("trail_streak", color, bx, by, trailLen * 0.6, R * 1.6, 0.5, angle);
        return this.fxLayer("core_dot", "#efe6ff", bx, by, R * 2.6, R * 2.6, 1, 0);
      case "reaper": {
        // AD spec — a raked toxic-green SCYTHE-STREAK, never a dot: an angled slug blade
        // behind a short comet trail, a crackle serration on the edge, and a white-hot core
        // at the LEADING tip. Reads as a sickle scything forward (kill shards inherit it).
        const tipX = bx + Math.cos(angle) * R * 1.2, tipY = by + Math.sin(angle) * R * 1.2;
        this.fxTrail("comet_trail", "#3fbf5f", bx, by, Math.max(R * 4.5, trailLen * 0.7), R * 2.4, 0.55, angle);
        this.fxLayer("slug", "#3fbf5f", bx, by, R * 6, R * 2.4, 0.9, angle - 0.5);
        this.fxLayer("crackle", "#8fffa8", bx, by, R * 3, R * 3, 0.3, angle + this.animClock * 5);
        return this.fxLayer("core_dot", "#8fffa8", tipX, tipY, R * 2.2, R * 2.2, 1, 0);
      }
      case "swarm": {
        // AD spec — a nervous ghost-blue SEEKING MOTE: a tight glow core, a short trail that
        // stutters off the travel line, and tiny spark flecks jittering beside it. Kept
        // SMALLER than the other legendaries so it reads as a live darting hornet.
        const wob = Math.sin(this.animClock * 34 + bx * 0.7 + by * 0.3) * R * 1.1;
        const perpX = Math.cos(angle + Math.PI / 2), perpY = Math.sin(angle + Math.PI / 2);
        this.fxTrail("comet_trail", "#57b6ff", bx, by, Math.max(R * 3, trailLen * 0.45), R * 1.5, 0.5, angle + Math.sin(this.animClock * 22 + bx) * 0.5);
        this.fxLayer("spark", "#bfeaff", bx + perpX * wob, by + perpY * wob, R * 1.5, R * 1.5, 0.55, this.animClock * 8);
        this.fxLayer("glow_round", "#57b6ff", bx, by, R * 3.2, R * 3.2, 0.55, 0);
        return this.fxLayer("core_dot", "#bfeaff", bx, by, R * 2, R * 2, 1, 0);
      }
      case "midas": {
        // AD spec (THE CRITICAL ONE) — gold is one degree off the enemy amber, so HUE cannot
        // separate it: it reads by SHAPE + BRIGHTNESS ONLY. A hard 4-POINT STAR gleam (two
        // concentric sparks at the SAME rotation so the silhouette stays a 4-point star) over
        // a near-white core. Deliberately NO glow_round halo — a round halo is exactly what
        // makes gold read as an enemy orb, which is a reject.
        const spin = this.animClock * 1.2;
        this.fxLayer("spark", "#ffe9b0", bx, by, R * 10, R * 10, 0.8, spin);
        this.fxLayer("spark", "#fff4d0", bx, by, R * 5.5, R * 5.5, 0.95, spin);
        return this.fxLayer("core_dot", "#ffffff", bx, by, R * 2.2, R * 2.2, 1, 0);
      }
      case "phase": {
        // AD spec — a violet PHASE TRAIL: a long smooth comet with a faint ghosted second copy
        // offset BEHIND it (the after-image of where it just was) over a dim smoke haze — a
        // low-luminance body with a bright core. Reads as a violet streak that smears/echoes.
        const backX = bx - Math.cos(angle) * R * 4, backY = by - Math.sin(angle) * R * 4;
        this.fxLayer("smoke_puff", "#3a1f5c", bx - Math.cos(angle) * R * 2, by - Math.sin(angle) * R * 2, R * 5, R * 5, 0.35, 0);
        this.fxTrail("comet_trail", "#a24bff", backX, backY, Math.max(R * 6, trailLen), R * 2.4, 0.3, angle);
        this.fxTrail("comet_trail", "#a24bff", bx, by, Math.max(R * 8, trailLen * 1.2), R * 2.8, 0.6, angle);
        return this.fxLayer("core_dot", "#d9a6ff", bx, by, R * 2.4, R * 2.4, 1, 0);
      }
      case "vortex": {
        // AD spec — an IMPLOSION that reads by MOTION, not a trail: spark flecks + arc_chain
        // lines converge INWARD onto a compressed core, and the pull distance breathes with
        // the clock so it visibly sucks in. Steel-white, high brightness — a magnetic collapse
        // (distinct from Umbra's long dark trail: this one is bright, compact, inward).
        const pull = 0.5 + 0.5 * Math.abs(Math.sin(this.animClock * 5));
        const reach = R * (2.2 + pull * 3.4);
        for (let i = 0; i < 4; i++) {
          const a = i * (Math.PI / 2) + this.animClock * 0.6;
          const fxX = bx + Math.cos(a) * reach, fyY = by + Math.sin(a) * reach;
          this.fxTrail("arc_chain", "#c9c9de", bx, by, reach, R * 1.3, 0.45, a + Math.PI);
          this.fxLayer("spark", "#ffffff", fxX, fyY, R * 1.4, R * 1.4, 0.7 * pull, a);
        }
        this.fxLayer("glow_round", "#c9c9de", bx, by, R * 3.6, R * 3.6, 0.6, 0);
        return this.fxLayer("core_dot", "#ffffff", bx, by, R * 2.6, R * 2.6, 1, 0);
      }
      default:
        return false;
    }
  }

  private renderTracers() {
    const { ctx, renderCam: cam } = this;
    for (const tr of this.remoteTracers) {
      const len = tr.len ?? 42;
      const x = tr.x - cam.x, y = tr.y - cam.y;
      // Tesla chain arcs draw as a stretched, rotated lightning sprite between enemies;
      // everything else (co-op shot tracers) keeps the thin line, with a line fallback if
      // the sprite is still loading.
      if (tr.isArc) {
        const img = this.sprites.fxTinted("arc_chain", tr.color);
        if (img) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = Math.max(0, tr.life / 0.12);
          ctx.translate(x, y);
          ctx.rotate(tr.angle);
          const h = 14;
          ctx.drawImage(img, 0, -h / 2, len, h);
          ctx.restore();
          continue;
        }
      }
      ctx.save();
      const alpha = Math.min(1, Math.max(0, tr.life / 0.12)) * 0.8;
      const width = tr.width ?? 2;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = width > 2 ? ARENA_SALVO_GLOW : tr.color;
      ctx.lineWidth = width > 2 ? width + 8 : width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(tr.angle) * len, y + Math.sin(tr.angle) * len);
      ctx.stroke();
      if (width > 2) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = width;
        ctx.stroke();
        ctx.globalAlpha = Math.min(1, alpha * 1.2);
        ctx.strokeStyle = ARENA_SALVO_CORE;
        ctx.lineWidth = Math.max(2, width * 0.32);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private applyArenaUltPose(cue: ArenaUltCastView | null, xf: Xform): void {
    if (cue === null || cue.kind !== "slip") return;
    if (this.arenaUltVfx.isSlipTelling(cue)) {
      xf.sx *= 1.12;
      xf.sy *= 0.72;
      xf.oy += 7;
    } else if (this.arenaUltVfx.isSlipLanding(cue)) {
      xf.sx *= 1.08;
      xf.sy *= 0.88;
      xf.oy += 4;
    }
  }

  private renderArenaUltBodyRim(
    cue: ArenaUltCastView | null,
    sx: number,
    sy: number,
    alpha: number,
  ): void {
    if (cue === null) return;
    const { ctx } = this;
    const isLanding = this.arenaUltVfx.isSlipLanding(cue);
    const isGlass = cue.kind === "salvo" && cue.t < ARENA_SALVO.glassSec;
    const pulse = settings.isReducedMotion ? 1 : 0.82 + 0.18 * Math.sin(cue.t * 18);
    ctx.save();
    ctx.globalAlpha = alpha * (isLanding ? 0.9 : isGlass ? 0.72 : 0.48) * pulse;
    ctx.strokeStyle = ARENA_ULT_HUE[cue.kind];
    ctx.lineWidth = isLanding ? 5 : isGlass ? 3.5 : 2.5;
    if (isGlass) ctx.setLineDash(AIM_DASH);
    ctx.beginPath();
    ctx.ellipse(sx, sy + 2, isLanding ? 31 : 28, isLanding ? 25 : 23, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = alpha * (isLanding ? 0.95 : 0.72);
    ctx.strokeStyle = cue.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, isLanding ? 35 : 32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private renderRemoteArenaBodyFlash(
    cue: ArenaUltCastView | null,
    base: SpriteName,
    sx: number,
    sy: number,
    facing: number,
    xf: Xform,
    alpha: number,
    hurtFlash: number,
  ): void {
    const arenaFlash = cue === null ? 0 : this.arenaUltVfx.bodyFlash(cue);
    const flash = Math.max(arenaFlash, hurtFlash);
    if (flash <= 0) return;
    const img = this.sprites.flashSprite(base);
    if (img === null) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha * flash;
    ctx.translate(sx + xf.ox, sy + xf.oy);
    ctx.rotate(xf.rot);
    ctx.scale(facing * xf.sx, xf.sy);
    ctx.drawImage(img, -26, -26, 52, 52);
    ctx.restore();
  }

  private renderRemotePlayers() {
    const remotes = this.remotes();
    if (remotes.length === 0) return;
    const { ctx, renderCam: cam } = this;
    for (const r of remotes) {
      const sx = r.x - cam.x, sy = r.y - cam.y;
      const isArenaRespawning = this.isArena && r.hp <= 0;
      const spawnGraceTicks = Math.max(0, r.spawnHardGraceEndsAtTick - r.authoritativeTick);
      const spawnShieldTicks = Math.max(0, r.spawnShieldEndsAtTick - r.authoritativeTick);
      const materialize = pvpMaterializeFraction({
        startedTick: r.spawnProtectionStartedTick,
        tick: r.authoritativeTick,
        shieldEndsAtTick: r.spawnShieldEndsAtTick,
      });
      if (!r.isAbsent && !isArenaRespawning) {
        this.renderPvpSpawnProtection(
          sx,
          sy,
          r.spawnHardGraceEndsAtTick,
          r.spawnShieldEndsAtTick,
          r.authoritativeTick,
          true,
        );
      }
      // Identity still unresolved (no verified color claim yet): an explicit NEUTRAL
      // placeholder at the exact body/label geometry the real render uses, so the resolve
      // happens in place. Never a guessed color that pops to the real one later.
      if (r.colorIndex === null) {
        const status = r.isDown ? "DOWN" : isArenaRespawning ? "RESPAWNING" : null;
        this.renderUnresolvedRemote(sx, sy, status, materialize);
        continue;
      }
      const color = playerColor(r.colorIndex);
      // A hatted teammate renders from the bald base (their equipped hat replaces the baked
      // cowboy hat); bare-headed teammates keep the classic hatted hero.
      const base = heroBodySprite(r.hat);
      const tinted = this.sprites.tintedSprite(base, color);
      const entry = this.remoteAnims.get(r.playerId);
      const xf = entry ? characterXform(entry.anim, CHARACTER_STYLE) : IDENTITY_XFORM;
      const arenaCue = this.arenaUltVfx.bodyCue(r.playerId, false);
      if (entry) this.applyArenaUltPose(arenaCue, xf);
      ctx.save();
      // A network-absent teammate renders as an explicit ghost (their body is reserved for
      // the reconnect grace) — never mistakable for a live player or a corpse. A live one
      // blinks through its authoritative i-frames exactly like the local blob does.
      const alphaBase = r.isAbsent
        ? 0.35
        : r.isDown || isArenaRespawning
          ? 0.4
          : spawnGraceTicks > 0
            ? 0.62
            : spawnShieldTicks > 0
              ? 0.82
              : isInvulnBlinkFrame(r.invuln, r.dashInvuln)
                ? 0.4
                : 1;
      const alpha = alphaBase * materialize;
      ctx.globalAlpha = alpha;
      ctx.translate(sx + xf.ox, sy + xf.oy);
      ctx.rotate(xf.rot);
      ctx.scale(r.facing * xf.sx, xf.sy);
      if (tinted) {
        ctx.drawImage(tinted, -26, -26, 52, 52);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(0, 0, this.pr, 0, 6.28); ctx.fill();
      }
      ctx.restore();
      this.renderRemoteArenaBodyFlash(arenaCue, base, sx, sy, r.facing, xf, alpha, entry?.anim.flash ?? 0);
      this.renderArenaUltBodyRim(arenaCue, sx, sy, alpha);
      // Teammates' verified cosmetic overlays (same transform as their body draw above,
      // which never uses frame sheets — the procedural xf carries the full deform).
      this.drawCosmetics(r.hat, r.face, sx, sy, 52, r.facing, xf, alpha, false);

      if (!r.isDown && !r.isAbsent && !isArenaRespawning) {
        if (WEAPONS[r.weapon].melee) this.renderHeldMelee(sx, sy, r.aimAngle, r.weapon, 1, null);
        else this.renderHeldWeapon(sx, sy, r.aimAngle, r.weapon, 1, 0, r.isSluiceDrain);
      }

      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.globalAlpha = r.isAbsent ? 0.8 : 1;
      ctx.fillText(
        r.isAbsent
          ? `${r.name} (reconnecting\u2026)`
          : r.isDown
            ? `${r.name} (down)`
            : isArenaRespawning
              ? `${r.name} (respawning)`
              : r.name,
        sx,
        sy - 32,
      );
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
  }

  private renderDevPalePlayers(): void {
    if (!this.isDevPaleCapture || this.world.players.size <= 1) return;
    const { ctx, renderCam: cam } = this;
    let colorIndex = 1;
    for (const player of this.world.players.values()) {
      if (player.id === LOCAL_ID) continue;
      const sx = player.x - cam.x;
      const sy = player.y - cam.y;
      const color = playerColor(colorIndex++);
      const tinted = this.sprites.tintedSprite(heroBodySprite(null), color);
      ctx.save();
      ctx.translate(sx, sy);
      if (tinted) {
        ctx.drawImage(tinted, -26, -26, 52, 52);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, player.pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(`P${colorIndex}`, sx, sy - 32);
      ctx.textAlign = "left";
    }
  }

  // Cosmetic companion pets (META spec §3): a pure CLIENT-SIDE follower per player who has one
  // equipped — the local player (from selfPet) and any teammate (from the wire identity pet).
  // The pet TROTS to keep near its owner with a little lag + a settle distance (it SITS when it
  // catches up), and warps with a puff if it falls way behind (a dash/teleport/floor change).
  // It is NEVER a sim entity: it cannot die, deal damage, block, or be targeted — enemies do
  // not know it exists, so it can never desync a co-op run. Determinism-safe by construction.
  private renderPets() {
    // Own frame-dt clock: pets are display-rate juice, decoupled from the fixed sim step.
    const now = performance.now();
    const dt = this.lastPetTs > 0 ? Math.min(0.05, (now - this.lastPetTs) / 1000) : 0;
    this.lastPetTs = now;

    const live = new Set<string>();
    // The local player's own pet follows the INTERPOLATED body position (matches renderPlayer).
    if (this.selfPet !== null && !this.isSpectatingBody) {
      const a = this.hasRenderPrev ? this.renderAlpha : 1;
      const ox = this.renderPrevX + (this.px - this.renderPrevX) * a;
      const oy = this.renderPrevY + (this.py - this.renderPrevY) * a;
      this.stepPet(LOCAL_ID, this.selfPet, ox, oy, this.facing, dt);
      live.add(LOCAL_ID);
    }
    // Teammates' pets follow their interpolated remote positions (from the verified wire id).
    for (const r of this.remotes()) {
      if (r.pet === null || r.isAbsent) continue;
      this.stepPet(r.playerId, r.pet, r.x, r.y, r.facing, dt);
      live.add(r.playerId);
    }
    // Drop pets whose owner left this frame (leaver / no longer equipped).
    for (const id of [...this.petRenders.keys()]) if (!live.has(id)) this.petRenders.delete(id);

    const cam = this.renderCam;
    for (const pet of this.petRenders.values()) {
      const f = pet.follow;
      const sx = f.x - cam.x, sy = f.y - cam.y;
      const xf = characterXform(pet.anim, CHARACTER_STYLE);
      // Two readable states, both drop-in against the AD's N-frame sheets (frame count
      // inferred, so a 4-frame idle / 6-frame run need no code change):
      //  RUN  — while trotting: the "walk" strip plays. Missing strip -> the static base PNG
      //         carries the motion through the procedural squash/lean.
      //  IDLE — while settled: the "doggie.idle" strip plays a gentle breathe/bob loop.
      //         Missing strip -> drawChar falls to the static base PNG and the procedural
      //         idle transform (breathe/bob) animates it, so a sat pet is never a dead frame.
      //  ATTACK — a one-shot emote beat (owner fires -> pet reacts) overriding both while it
      //         plays. Missing attack strip -> the walk/idle sheet, then the static base.
      // A still-streaming sprite degrades to a tinted disc (never blank, never a crash).
      const emoteProgress = pet.attackT > 0 ? 1 - pet.attackT / PET_EMOTE_DUR : null;
      drawPetFrame(this.ctx, this.sprites, {
        petId: pet.petId,
        isMoving: f.isMoving,
        emoteProgress,
        cx: sx,
        cy: sy,
        size: PET_RENDER_SIZE,
        facing: f.facing,
        xform: xf,
        clock: pet.anim.clock,
      });
    }
  }

  // Advance one pet's lagged follow toward its owner (client-render-only): the trot physics +
  // wall slide live in the pure petFollow module; this wraps it with the puff on a warp, the
  // per-species voice, and the idle/run anim clock. Shared by EVERY pet (doggie/cat/dragon/
  // slime) — nothing here special-cases a species.
  private stepPet(ownerId: string, petId: string, ownerX: number, ownerY: number, ownerFacing: number, dt: number) {
    let pet = this.petRenders.get(ownerId);
    // The rest spot sits just BEHIND the owner (opposite their facing) so it never blocks them.
    const restX = ownerX - ownerFacing * PET_REST_OFFSET;
    const restY = ownerY + PET_REST_DROP;
    if (!pet || pet.petId !== petId) {
      // Spawn AT the owner (a guaranteed-standable point — the owner is there) so a fresh pet
      // never initializes inside a wall; it then trots out to its rest spot.
      pet = { petId, follow: createPetFollow(ownerX, ownerY, ownerFacing), anim: createAnim(), wasMoving: false, attackT: 0 };
      this.petRenders.set(ownerId, pet);
    }
    // Tick down the one-shot attack emote (owner fired a beat ago); it drives the attack clip
    // in renderPets and returns to idle/walk once elapsed. Display-rate, out of the sim.
    if (pet.attackT > 0) pet.attackT = Math.max(0, pet.attackT - dt);
    const f = pet.follow;
    // Slide toward the rest spot against the SAME walls the player collides with; a true warp
    // (way behind / wedged) puffs.
    if (stepPetFollow(f, restX, restY, ownerFacing, dt, this.petWallAt)) {
      this.spawnPuff(f.x, f.y, 4, "#d8c8a0");
    }
    // The companion doggie's voice (local pet only, so remote pets never chorus). The
    // wave-spec cooldowns own the anti-annoyance cadence; here we only fire on real state
    // transitions: a soft trot loop while moving, a content settle-sigh when it stops, and
    // an occasional pant kept alive by its own 6s cooldown while it keeps trotting.
    if (ownerId === LOCAL_ID) {
      const voice = PET_VOICES[petId];
      if (voice !== undefined) {
        if (voice.trot !== undefined) waveAudio.holdLoop(voice.trot, "selfpet", f.isMoving);
        if (f.isMoving) {
          waveAudio.cueAt(voice.move, f.x, f.y); // the move cue's own cooldown gates cadence
        } else if (pet.wasMoving) {
          waveAudio.cueAt(voice.settle, f.x, f.y); // the cozy stop payoff
        }
      }
    }
    pet.wasMoving = f.isMoving;
    // Lean into the trot direction for a touch of scamper; a settled pet just breathes.
    const lean = f.isMoving ? Math.max(-1, Math.min(1, f.vx / PET_MAX_SPEED)) : 0;
    stepAnim(pet.anim, dt, f.isMoving, lean);
  }

  // Kick a pet's one-shot ATTACK emote (owner fired / swung) for the owner whose blob is at
  // `ownerId` — LOCAL_ID for the local player, the wire pid for a teammate. Purely a display
  // beat: it only arms an existing render entry (a pet spawns/steps in renderPets), so an owner
  // with no equipped pet is a silent no-op, and it can never touch the sim or the wire.
  private triggerPetEmote(ownerId: string): void {
    const pet = this.petRenders.get(ownerId);
    if (pet) pet.attackT = PET_EMOTE_DUR;
  }

  // The body tint for the local blob, or null for the natural amber sprite (palette slot 0
  // IS the sprite's own coloring, so it never re-tints). The cosmetic body item wins;
  // otherwise the PARTY color is the fallback — the party color always keeps owning the
  // name label / minimap / roster identity surfaces regardless.
  private selfTint(): string | null {
    const idx = bodyPaletteIndex(this.selfCosmetics?.body ?? null, this.selfColorIndex ?? 0);
    return idx > 0 ? playerColor(idx) : null;
  }

  // Draw a blob's equipped cosmetic overlays (hat/face) through THE shared loadout renderer
  // (drawLoadoutOverlays — the single path every surface uses, so world and menus can never
  // drift). The hero renders the side-authored orientation, mirrored by the facing flip;
  // weapon, status, and name/team cues always draw AFTER this pass.
  private drawCosmetics(hat: string | null, face: string | null, cx: number, cy: number, size: number, facing: number, xf: Xform, alpha: number, isSheetPlaying: boolean, frameIndex = 0) {
    drawLoadoutOverlays(this.ctx, hat, face, {
      cx, cy, sizePx: size, facing, orientation: "side", xf, isSheetPlaying, frameIndex, alpha,
    });
  }

  // The neutral stand-in for a teammate whose identity color has not resolved: a grey ring
  // at the body position and a grey "…" at the name-label baseline — the same geometry the
  // real render uses, so the resolve swaps in place with zero shift.
  private renderUnresolvedRemote(sx: number, sy: number, status: string | null, alpha = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = NEUTRAL_PLAYER_COLOR;
    ctx.lineWidth = 2;
    ctx.globalAlpha = (status === null ? 0.8 : 0.35) * alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, this.pr, 0, 6.28);
    ctx.stroke();
    ctx.fillStyle = NEUTRAL_PLAYER_COLOR;
    ctx.font = '700 11px "Silkscreen", monospace';
    ctx.textAlign = "center";
    ctx.fillText(status ?? "\u2026", sx, sy - 32);
    ctx.restore();
    ctx.textAlign = "left";
  }

  private localPvpProtectionState(): {
    tick: number;
    startedTick: number;
    graceEndsAtTick: number;
    shieldEndsAtTick: number;
  } {
    if (this.mode === "online" && this.wsTransport) {
      const snap = this.wsTransport.getLatestSnapshot();
      if (snap?.self) {
        return {
          tick: snap.tick,
          startedTick: snap.self.spo,
          graceEndsAtTick: snap.self.sge,
          shieldEndsAtTick: snap.self.sse,
        };
      }
    }
    return {
      tick: this.world.tick,
      startedTick: this.p.spawnProtectionStartedTick,
      graceEndsAtTick: this.p.spawnHardGraceEndsAtTick,
      shieldEndsAtTick: this.p.spawnShieldEndsAtTick,
    };
  }

  private renderPvpSpawnProtection(
    sx: number,
    sy: number,
    graceEndsAtTick: number,
    shieldEndsAtTick: number,
    tick: number,
    isRemote: boolean,
  ): void {
    const graceTicks = Math.max(0, graceEndsAtTick - tick);
    const shieldTicks = Math.max(0, shieldEndsAtTick - tick);
    if (!this.isArena || shieldTicks <= 0) return;
    const isGrace = graceTicks > 0;
    const remainingTicks = isGrace ? graceTicks : shieldTicks;
    const isFinalPulse = remainingTicks <= 10;
    const pulseRate = isFinalPulse ? 16 : isGrace ? 8 : 5;
    const pulseDepth = isFinalPulse ? 0.24 : 0.10;
    const pulse = 0.76 + pulseDepth * Math.sin(this.animClock * pulseRate);
    const color = "#ffd27a";
    const radius = this.pr + (isRemote ? 6 : isGrace ? 10 : 8);
    const { ctx } = this;
    ctx.save();
    if (!isRemote) {
      ctx.globalAlpha = (isGrace ? 0.20 : 0.14) * pulse;
      ctx.fillStyle = "#f5e6c8";
      ctx.beginPath();
      ctx.arc(sx, sy, this.pr + 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = (isRemote ? 0.55 : 0.88) * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = isRemote ? (isGrace ? 2 : 1) : isGrace ? 4 : 3;
    ctx.setLineDash([]);
    if (isGrace) {
      const remaining = Math.max(0, Math.min(1, graceTicks / pvpSpawnHardGraceTicks())) * 4;
      for (let segment = 0; segment < 4; segment++) {
        const fill = Math.max(0, Math.min(1, remaining - segment));
        const start = -Math.PI / 2 + segment * Math.PI / 2 + 0.08;
        const segmentArc = Math.PI / 2 - 0.16;
        ctx.globalAlpha = (isRemote ? 0.16 : 0.22) * pulse;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, start, start + segmentArc);
        ctx.stroke();
        if (fill <= 0) continue;
        ctx.globalAlpha = (isRemote ? 0.55 : 0.88) * pulse;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, start, start + segmentArc * fill);
        ctx.stroke();
      }
    } else {
      ctx.globalAlpha = (isRemote ? 0.32 : 0.48) * pulse;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!isRemote && isFinalPulse) {
      ctx.globalAlpha = 0.42 * pulse;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderPvpWeaponArming(
    sx: number,
    sy: number,
    aim: number,
    graceEndsAtTick: number,
    tick: number,
  ): void {
    const graceTicks = Math.max(0, graceEndsAtTick - tick);
    if (!this.isArena || graceTicks <= 0) return;
    const progress = 1 - Math.max(0, Math.min(1, graceTicks / pvpSpawnHardGraceTicks()));
    const mx = sx + Math.cos(aim) * 18;
    const my = sy + Math.sin(aim) * 18;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "#ffd27a";
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(mx, my, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.arc(mx, my, 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();
    ctx.restore();
  }

  private renderPlayer() {
    const { ctx, renderCam: cam } = this;
    const isArenaRespawning = this.isArenaRespawning();
    // Interpolate the render position between the last two sim steps for smooth motion.
    const a = this.hasRenderPrev ? this.renderAlpha : 1;
    const ipx = this.renderPrevX + (this.px - this.renderPrevX) * a;
    const ipy = this.renderPrevY + (this.py - this.renderPrevY) * a;
    const psx = ipx - cam.x, psy = ipy - cam.y;
    const protection = this.localPvpProtectionState();
    const spawnGraceTicks = Math.max(0, protection.graceEndsAtTick - protection.tick);
    const spawnShieldTicks = Math.max(0, protection.shieldEndsAtTick - protection.tick);
    const materialize = pvpMaterializeFraction({
      startedTick: protection.startedTick,
      tick: protection.tick,
      shieldEndsAtTick: protection.shieldEndsAtTick,
    });
    if (!isArenaRespawning && !this.isDown) {
      this.renderPvpSpawnProtection(
        psx,
        psy,
        protection.graceEndsAtTick,
        protection.shieldEndsAtTick,
        protection.tick,
        false,
      );
    }
    // GUNNER OVERHEAT (Wave 2): a building heat glow on the body as Momentum ramps, FLARING on the
    // boil-over burst — the visible "charge" the HUD pip row mirrors. Local read off authoritative
    // state (passiveState stacks + overheatT window); drawn under the body.
    if (this.p.kitId === "gunner" && !this.isDown) {
      const heat = Math.min(1, this.p.passiveState / MOMENTUM.maxStacks);
      const isBoil = this.p.overheatT > 0;
      if (heat > 0 || isBoil) {
        const pulse = isBoil ? 0.7 + 0.3 * Math.sin(this.animClock * 14) : 1;
        const glowA = (isBoil ? 0.5 : 0.12 + 0.26 * heat) * pulse;
        const glowSize = 52 * (1 + 0.28 * (isBoil ? 1 : heat));
        this.fxLayer("glow_round", isBoil ? "#ffd479" : BURN_TINT, psx, psy, glowSize, glowSize, glowA, 0);
      }
    }
    let alpha = 1;
    if (isArenaRespawning) alpha = 0.25;
    else if (this.isDown) alpha = 0.4;
    else if (spawnGraceTicks > 0) alpha = 0.72;
    else if (spawnShieldTicks > 0) alpha = 0.88;
    else if (isInvulnBlinkFrame(this.invuln, this.p.dashInvuln)) alpha = 0.4;
    alpha *= materialize;
    const clip: SheetClip = this.playerAnim.move > 0.5 ? "walk" : "idle";
    const xf = characterXform(this.playerAnim, CHARACTER_STYLE);
    const arenaCue = this.arenaUltVfx.bodyCue(this.p.id, true);
    this.applyArenaUltPose(arenaCue, xf);
    // Directional recoil: nudge the blob back against its aim as it fires.
    const rec = this.playerAnim.recoil;
    xf.ox += -Math.cos(this.aimAngle) * rec * 4;
    xf.oy += -Math.sin(this.aimAngle) * rec * 4;
    // A hatted blob renders from the bald base so the equipped hat replaces the baked cowboy
    // hat instead of stacking on it; bare-headed blobs keep the classic hatted hero.
    const base = heroBodySprite(this.selfCosmetics?.hat ?? null);
    const arenaFlash = arenaCue === null ? 0 : this.arenaUltVfx.bodyFlash(arenaCue);
    this.drawChar(
      base,
      clip,
      psx,
      psy,
      52,
      this.facing,
      xf,
      1,
      alpha,
      Math.max(this.playerAnim.flash, arenaFlash),
      this.playerAnim.clock,
      this.selfTint(),
    );
    this.renderArenaUltBodyRim(arenaCue, psx, psy, alpha);
    if (this.selfCosmetics) {
      // Socket determinism: the cosmetic pass reads the SAME frame index the body sheet
      // shows this tick, so per-frame socket anchors can never drift off the head.
      const sheet = this.sprites.sheet(base, clip);
      let cosmeticFrame = 0;
      if (sheet) {
        const fw = sheet.img.naturalHeight || 64;
        cosmeticFrame = frameIndex(Math.max(1, Math.round(sheet.img.naturalWidth / fw)), sheet.fps, this.playerAnim.clock);
      }
      this.drawCosmetics(this.selfCosmetics.hat, this.selfCosmetics.face, psx, psy, 52, this.facing, xf, alpha, !!sheet, cosmeticFrame);
    }
    if (!this.isDown && !isArenaRespawning) {
      // Anchor the held weapon to the blob's VISUAL body offset (lean/bob/hop + recoil nudge)
      // so the gun stays glued to the body while moving. The bullet/muzzle ORIGIN stays at the
      // true sim center (psx/psy) — the weapon art is cosmetic and just follows the body.
      const bx = psx + xf.ox, by = psy + xf.oy;
      if (WEAPONS[this.weapon].melee) this.renderHeldMelee(bx, by, this.aimAngle, this.weapon, alpha, this.meleeSwing);
      else this.renderHeldWeapon(
        bx, by, this.aimAngle, this.weapon, alpha, this.playerAnim.recoil,
        this.p.weaponCycles.sluicegate % 2 === 1,
      );
      this.renderPvpWeaponArming(
        psx,
        psy,
        this.aimAngle,
        protection.graceEndsAtTick,
        protection.tick,
      );
    }
    if (this.isDown) {
      // The revive ring (renderReviveRings) owns the "being revived" read; the spectate
      // banner owns the down-state instructions. Only the bare label rides the body here.
      ctx.fillStyle = "#ff6a6a";
      ctx.font = '700 12px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(this.isSpectating() || this.p.reviveProgress > 0 ? "DOWN" : "DOWN \u2014 wait for a teammate", psx, psy - 34);
      ctx.textAlign = "left";
    }
  }

  // World-space revive UX. Around every downed body: a faint stand-here ring at the exact
  // authoritative revive radius. While a channel runs: a progress arc that both sides read
  // from the SAME authoritative number (SelfWire.rev for your own body, PlayerWire.rv for a
  // teammate's). For a living player in range: the HOLD E prompt / REVIVING label.
  private renderReviveRings() {
    if (this.mode === "solo" || !this.isRunning) return;
    const { ctx, renderCam: cam } = this;
    const drawStandRing = (sx: number, sy: number, radius: number) => {
      ctx.save();
      ctx.globalAlpha = 0.22 + 0.08 * Math.sin(this.animClock * 3);
      ctx.strokeStyle = "#8affc0";
      ctx.lineWidth = 2;
      ctx.setLineDash(AIM_DASH);
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, 6.28);
      ctx.stroke();
      ctx.restore();
    };
    const drawProgress = (sx: number, sy: number, frac: number) => {
      ctx.save();
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#0d2a1e";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(sx, sy, 27, 0, 6.28);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#8affc0";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(sx, sy, 27, -Math.PI / 2, -Math.PI / 2 + 6.283 * Math.min(1, frac));
      ctx.stroke();
      ctx.restore();
    };
    const label = (sx: number, sy: number, text: string, color: string) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(text, sx, sy - 48);
      ctx.restore();
      ctx.textAlign = "left";
    };
    const drawRope = (x0: number, y0: number, x1: number, y1: number, isBoosted: boolean) => {
      ctx.save();
      ctx.globalAlpha = isBoosted ? 0.85 : 0.55;
      ctx.strokeStyle = isBoosted ? "#a8d7a0" : "#8affc0";
      ctx.lineWidth = isBoosted ? 2.5 : 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
    };
    const selfServerId = this.wsTransport?.getSelfServerId() ?? LOCAL_ID;
    const localReviveRadius = effectiveReviveRadius(this.p);
    for (const r of this.remotes()) {
      if (!r.isDown) continue;
      const sx = r.x - cam.x, sy = r.y - cam.y;
      // Past the floor's down limit (gate §1) the body is OUT: the sim refuses the channel,
      // so the UI must stop inviting one — no ring, no prompt, just the descent-rescue read.
      if (r.isOut) {
        label(sx, sy, `${r.name.toUpperCase()} IS OUT \u2014 DESCEND TO RESCUE`, "#ff8a7a");
        continue;
      }
      // World space carries the SPATIAL guidance only — the stand-here ring and the
      // authoritative progress arc at the body; the input affordance (`E | REVIVE GF`)
      // lives in the bottom-left prompt cluster (UI Director hierarchy), so the copy
      // never doubles up over the fight.
      if (!this.isDown) drawStandRing(sx, sy, localReviveRadius);
      if (r.reviveProgress > 0) drawProgress(sx, sy, r.reviveProgress / REVIVE.channel);
      if (!this.isDown && r.reviveBy === selfServerId) {
        drawRope(this.px - cam.x, this.py - cam.y, sx, sy, this.p.mods.reviveSpeedMult > 1);
        label(sx, sy, "REVIVING", this.p.mods.reviveSpeedMult > 1 ? "#dff2d8" : "#8affc0");
      }
    }
    // The local downed body: the authoritative channel a teammate holds on us.
    if (this.isDown && this.p.reviveProgress > 0) {
      const a = this.hasRenderPrev ? this.renderAlpha : 1;
      const sx = this.renderPrevX + (this.px - this.renderPrevX) * a - cam.x;
      const sy = this.renderPrevY + (this.py - this.renderPrevY) * a - cam.y;
      drawProgress(sx, sy, this.p.reviveProgress / REVIVE.channel);
      const reviver = this.remotes().find((remote) => remote.playerId === this.p.reviveBy);
      if (reviver) {
        drawRope(reviver.x - cam.x, reviver.y - cam.y, sx, sy, false);
        label(sx, sy, `${reviver.name.toUpperCase()} IS REVIVING YOU\u2026`, "#8affc0");
      } else {
        label(sx, sy, "A TEAMMATE IS REVIVING YOU\u2026", "#8affc0");
      }
    }
  }

  // World-space party exit coordination, shown only while the descend gate is actually
  // waiting on someone: a pulsing chevron from the local player toward the STAIRS while
  // teammates stand staged there, and — once staged yourself — chevrons toward each living
  // teammate the gate still needs. Pure reads of the authoritative exr; nothing sim-side.
  private renderExitCoordination() {
    if (this.isArena) return;
    if (this.mode !== "online" || !this.wsTransport || this.isDown || !this.isRunning) return;
    if (!this.wsTransport.isFloorCleared()) return;
    const remotes = this.remotes();
    // Only PRESENT living teammates are required at the stairs (a reconnecting member's
    // reserved body is excluded from the gate — PR #39 — so no chevron ever points at it).
    const livingRemotes = remotes.filter((r) => !r.isDown && !isReconnectingTeammate(r));
    if (livingRemotes.length === 0) return;
    const exr = this.wsTransport.exitReadyParty();
    const required = livingRemotes.length + 1;
    if (exr.length === 0 || exr.length >= required) return;
    const selfId = this.wsTransport.getSelfServerId();
    const isSelfAt = selfId !== null && exr.includes(selfId);
    const chevron = (fromX: number, fromY: number, angle: number, color: string) => {
      const { ctx, renderCam: cam } = this;
      const pulse = 2.5 * Math.sin(this.animClock * 5);
      const cx = fromX + Math.cos(angle) * (58 + pulse) - cam.x;
      const cy = fromY + Math.sin(angle) * (58 + pulse) - cam.y;
      ctx.save();
      ctx.globalAlpha = 0.75 + 0.2 * Math.sin(this.animClock * 5);
      ctx.fillStyle = color;
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-5, 6.5);
      ctx.lineTo(-5, -6.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    if (!isSelfAt) {
      // You are the missing one: point at the stairs where the party waits.
      const d = this.dungeon;
      const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
      if (Math.hypot(ex - this.px, ey - this.py) > TILE * 2) {
        chevron(this.px, this.py, Math.atan2(ey - this.py, ex - this.px), "#8affc0");
      }
      return;
    }
    // You are staged: point at each living teammate the gate still needs.
    for (const r of livingRemotes) {
      if (exr.includes(r.playerId)) continue;
      chevron(this.px, this.py, Math.atan2(r.y - this.py, r.x - this.px), "#ffd27a");
    }
  }

  // Screen-space spectator chrome: who the camera follows and how to switch. Fixed position
  // and opacity-only, so it can never shift the layout.
  // The spectator's control bar (UI Director: SPECTATING NAME + prev/next/follow/menu).
  // The DOWN state itself — YOU'RE DOWN, revive progress, interrupts, teammate arrows —
  // lives in renderDownOverlay; this bar is purely "what am I watching and how do I drive".
  private renderSpectateBanner() {
    if (!this.isSpectating() || this.spectateId === null) return;
    const target = this.remotes().find((r) => r.playerId === this.spectateId);
    if (!target) return;
    const { ctx, canvas } = this;
    const cx = canvas.width / 2;
    const y = canvas.height - 168;
    const isTargetReconnecting = isReconnectingTeammate(target);
    const living = this.remotes().filter((r) => !r.isDown).length;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffb43b";
    ctx.font = '700 16px "Silkscreen", monospace';
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin(this.animClock * 3);
    ctx.fillText(this.isSpectatingBody ? "WATCHING YOUR BODY" : `SPECTATING ${target.name.toUpperCase()}`, cx, y);
    ctx.globalAlpha = 0.8;
    ctx.font = '700 10px "Silkscreen", monospace';
    if (isTargetReconnecting && !this.isSpectatingBody) {
      ctx.fillStyle = "#9a8fb5";
      ctx.fillText(`${target.name.toUpperCase()} IS RECONNECTING\u2026 THE RUN RESUMES WHEN THEY RETURN`, cx, y + 18);
    }
    ctx.fillStyle = "#d9d2c0";
    const controls = [
      ...(living > 1 ? ["Q \u25c0 PREV", "NEXT \u25b6 E"] : []),
      this.isSpectatingBody ? `F FOLLOW ${target.name.toUpperCase()}` : "F YOUR BODY",
      "ESC MENU",
    ];
    ctx.fillText(controls.join(" \u00b7 "), cx, y + (isTargetReconnecting && !this.isSpectatingBody ? 34 : 18));
    ctx.restore();
    ctx.textAlign = "left";
  }

  // The downed player's own state overlay (UI Director): YOU'RE DOWN, the authoritative
  // revive readout (`NAME REVIVING · N%`), the hard-reset interrupt flash, the OUT state,
  // and screen-edge arrows with distances toward every living teammate (the people who can
  // come channel you). Drawn while down regardless of what the camera watches.
  private renderDownOverlay() {
    if (!this.isDown || !this.isRunning || this.mode === "solo") return;
    const { ctx, canvas } = this;
    const cx = canvas.width / 2;
    const y = 118;
    const reviver = this.p.reviveBy === null
      ? undefined
      : this.remotes().find((remote) => remote.playerId === this.p.reviveBy);
    const isSelfOut = this.wsTransport?.getLatestSnapshot()?.self?.out === true;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ff6a6a";
    ctx.font = '700 22px "Silkscreen", monospace';
    ctx.globalAlpha = 0.8 + 0.2 * Math.sin(this.animClock * 2.4);
    ctx.fillText("YOU'RE DOWN", cx, y);
    ctx.globalAlpha = 0.9;
    ctx.font = '700 11px "Silkscreen", monospace';
    if (this.p.reviveProgress > 0) {
      ctx.fillStyle = "#8affc0";
      const by = reviver ? reviver.name.toUpperCase() : "A TEAMMATE";
      ctx.fillText(`${by} REVIVING \u00b7 ${Math.round((this.p.reviveProgress / REVIVE.channel) * 100)}%`, cx, y + 20);
    } else if (this.reviveInterruptT > 0) {
      ctx.fillStyle = "#ffb43b";
      ctx.globalAlpha = Math.min(1, this.reviveInterruptT * 2);
      ctx.fillText("REVIVE INTERRUPTED \u2014 THE CHANNEL RESTARTS FROM ZERO", cx, y + 20);
    } else if (isSelfOut) {
      ctx.fillStyle = "#ff8a7a";
      ctx.fillText("NO REVIVES LEFT THIS FLOOR \u2014 THE PARTY'S DESCENT RESCUES YOU", cx, y + 20);
    } else {
      ctx.fillStyle = "#d9d2c0";
      ctx.fillText("A TEAMMATE CAN HOLD E ON YOUR BODY", cx, y + 20);
    }
    // Screen-edge arrows toward every living teammate + their distance to your body —
    // the downed player's answer to "is anyone coming?".
    const living = this.remotes().filter((r) => !r.isDown && !isReconnectingTeammate(r)).slice(0, 3);
    ctx.font = '700 10px "Silkscreen", monospace';
    for (const mate of living) {
      const sx = mate.x - this.renderCam.x, sy = mate.y - this.renderCam.y;
      const isOnScreen = sx > 40 && sx < canvas.width - 40 && sy > 40 && sy < canvas.height - 40;
      if (isOnScreen) continue; // visible teammates need no arrow
      const ang = Math.atan2(mate.y - this.py, mate.x - this.px);
      const ax = cx + Math.cos(ang) * 150;
      const ay = y + 64 + Math.sin(ang) * 34;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = "#8affc0";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#8affc0";
      ctx.globalAlpha = 0.85;
      const dist = Math.max(1, Math.round(Math.hypot(mate.x - this.px, mate.y - this.py) / TILE));
      ctx.fillText(`${mate.name.toUpperCase()} ${dist}m`, ax, ay + 22);
    }
    ctx.restore();
    ctx.textAlign = "left";
  }

  // Where the blade POINTS at swing progress t (0..1): an eased sweep across the sim's
  // exact hit wedge — aim ± arc/2 — alternating direction per swing. The hitbox is the
  // whole wedge for the whole swing (see isPointInMeleeHit), so the visual sweep passes
  // through precisely the area that can hit.
  private swingBladeAngle(swing: MeleeSwing, t: number): number {
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    const k = 1 - (1 - u) * (1 - u) * (1 - u); // easeOutCubic: snaps through, settles at the end
    return swing.aim + this.meleeFlipDir * swing.arc * (k - 0.5);
  }

  // The slash VFX: a crescent ribbon that TRAILS the blade through its eased sweep (or a
  // lunging streak for thrusts), plus a white-hot leading edge where the blade is right
  // now. Analytic — sampled from the same easing the blade uses — so the trail and the
  // held sprite always agree at any framerate without retaining trail geometry.
  private renderMeleeSwing() {
    const swing = this.meleeSwing;
    if (!swing || swing.timer <= 0) return;
    const t = 1 - swing.timer / swing.duration;
    if (swing.isThrust) this.renderThrustFx(swing, t);
    else this.renderSlashArc(swing, t);
  }

  private renderSlashArc(swing: MeleeSwing, t: number) {
    const { ctx, renderCam: cam } = this;
    const sx = this.px - cam.x;
    const sy = this.py - cam.y;
    const inner = 12;
    const outer = swing.reach * (0.9 + 0.1 * Math.sin(t * Math.PI));
    const trailStart = Math.max(0, t - this.meleeTrailLength);
    const trailSpan = t - trailStart;
    const SEGS = 10;
    const fadeOut = 1 - t * t; // the whole crescent dissolves as the swing settles
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(sx, sy);
    ctx.fillStyle = swing.color;
    // The analytic trailing crescent, brightest at the blade and fading toward the tail.
    for (let i = 0; i < SEGS; i++) {
      const s0 = i / SEGS, s1 = (i + 1) / SEGS; // 0 = tail (swing start), 1 = head (blade)
      const a0 = this.swingBladeAngle(swing, trailStart + trailSpan * s0);
      const a1 = this.swingBladeAngle(swing, trailStart + trailSpan * s1);
      if (Math.abs(a1 - a0) < 0.002) continue;
      ctx.globalAlpha = 0.5 * this.meleeTrailIntensity * Math.pow(s1, 1.4) * fadeOut;
      const ro = outer * (0.78 + 0.22 * s1); // tail tapers inward
      const ccw = a1 < a0;
      ctx.beginPath();
      ctx.arc(0, 0, ro, a0, a1, ccw);
      ctx.arc(0, 0, inner, a1, a0, !ccw);
      ctx.closePath();
      ctx.fill();
    }
    // Leading edge: the blade line itself, white-hot over a colored glow.
    const head = this.swingBladeAngle(swing, t);
    const hx = Math.cos(head), hy = Math.sin(head);
    ctx.lineCap = "round";
    ctx.globalAlpha = Math.min(1, 0.6 * this.meleeTrailIntensity) * fadeOut;
    ctx.strokeStyle = swing.color;
    ctx.lineWidth = 5 * this.meleeTrailWidth;
    ctx.beginPath();
    ctx.moveTo(hx * inner, hy * inner);
    ctx.lineTo(hx * outer, hy * outer);
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, 0.9 * this.meleeTrailIntensity) * fadeOut;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * this.meleeTrailWidth;
    ctx.beginPath();
    ctx.moveTo(hx * (inner + 4), hy * (inner + 4));
    ctx.lineTo(hx * (outer - 2), hy * (outer - 2));
    ctx.stroke();
    ctx.restore();
  }

  private renderThrustFx(swing: MeleeSwing, t: number) {
    const { ctx, renderCam: cam } = this;
    const sx = this.px - cam.x;
    const sy = this.py - cam.y;
    const ext = Math.sin(t * Math.PI); // 0 -> full extension -> 0
    const len = swing.reach * (0.45 + 0.55 * ext);
    const headX = sx + Math.cos(swing.aim) * (12 + len);
    const headY = sy + Math.sin(swing.aim) * (12 + len);
    // Colored streak trailing back from the tip (sprite glow with a stroke fallback).
    const isStreak = this.fxTrail("trail_streak", swing.color, headX, headY, len, 13 * (1 - t * 0.3), 0.8 * (1 - t * 0.25), swing.aim);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    if (!isStreak) {
      ctx.globalAlpha = 0.6 * (1 - t * 0.35);
      ctx.strokeStyle = swing.color;
      ctx.lineWidth = 7 * (1 - t * 0.4);
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(swing.aim) * 14, sy + Math.sin(swing.aim) * 14);
      ctx.lineTo(headX, headY);
      ctx.stroke();
    }
    // White-hot core line + a glint at the tip at full extension.
    ctx.globalAlpha = 0.8 * (1 - t * 0.4);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(swing.aim) * 16, sy + Math.sin(swing.aim) * 16);
    ctx.lineTo(headX, headY);
    ctx.stroke();
    ctx.restore();
    const glint = Math.max(0, 1 - Math.abs(t - 0.5) / 0.18);
    if (glint > 0) {
      this.fxLayer("spark", swing.color, headX, headY, 28, 10, glint * 0.8, swing.aim);
      this.fxLayer("spark", "#ffffff", headX, headY, 18, 18, glint, swing.aim);
    }
  }

  // The equipped gun, drawn over the hero and rotated to aim. Held sprites are authored
  // 40px with the gun centered in the file, pointing +X; the vertical flip past |aim| >
  // 90deg keeps the barrel horizontal (not upside-down) when aiming left. The sprite
  // center sits at the muzzle-flash anchor distance (18px out along aim), pulled in
  // slightly on fire by recoil. Weapons without art fall back to the pistol overlay; if
  // even that isn't loaded yet it simply draws nothing. Melee never comes through here —
  // blades have their own aim-tracking, arc-sweeping path (renderHeldMelee).
  private renderHeldWeapon(
    cx: number,
    cy: number,
    aim: number,
    weapon: WeaponId,
    alpha: number,
    recoil = 0,
    isSluiceDrain = false,
  ) {
    const img = this.sprites.heldWeapon(weapon) ?? this.sprites.heldWeapon("pistol");
    if (!img) return;
    const { ctx } = this;
    const anchor = 18 - recoil * 3;
    const d = 40 * 0.6; // ~24px over the ~44px blob
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx + Math.cos(aim) * anchor, cy + Math.sin(aim) * anchor);
    // Cancel the sprite's baked-in diagonal so the barrel points at the true aim.
    ctx.rotate(aim - (HELD_ART_ANGLE[weapon] ?? 0));
    if (Math.abs(aim) > Math.PI / 2) ctx.scale(1, -1);
    ctx.drawImage(img, -d / 2, -d / 2, d, d);
    ctx.restore();
    if (weapon === "sluicegate") {
      const muzzleX = cx + Math.cos(aim) * 30;
      const muzzleY = cy + Math.sin(aim) * 30;
      if (isSluiceDrain) {
        this.fxTrail("trail_streak", "#d9fbff", muzzleX, muzzleY, 22, 2.5, alpha * 0.8, aim);
      } else {
        for (const offset of [-0.32, 0, 0.32]) {
          this.fxLayer(
            "slug", "#78cbd1",
            muzzleX + Math.cos(aim + offset) * 4,
            muzzleY + Math.sin(aim + offset) * 4,
            7, 3, alpha * 0.75, aim + offset,
          );
        }
      }
    }
  }

  // The held BLADE. Idle it points exactly at the cursor (live aim); during a swing it
  // sweeps through the sim's real hit wedge on the same eased curve as the slash VFX
  // (swingBladeAngle), with a smear of ghost blades behind it — so what you see IS where
  // the hitbox is. Thrusts lunge the pike out along the locked aim instead of arcing.
  // Drawn big (per-weapon bladeSize; the tip lands at the weapon's true reach) so the
  // weapon reads as a weapon, not a bar. Remotes pass swing=null and get the aim-tracking
  // idle pose.
  private renderHeldMelee(cx: number, cy: number, aim: number, weapon: WeaponId, alpha: number, swing: MeleeSwing | null) {
    const img = this.sprites.heldWeapon(weapon);
    if (!img) { this.renderHeldWeapon(cx, cy, aim, weapon, alpha); return; }
    const feel = MELEE_FEEL[weapon];
    const d = feel?.bladeSize ?? 46;
    const artAngle = feel?.artAngle ?? 0;
    const isSwinging = swing !== null && swing.timer > 0;
    let angle = aim;
    let stretch = 0;
    let scale = 1;
    let t = 0;
    if (isSwinging) {
      t = 1 - swing.timer / swing.duration;
      if (swing.isThrust) {
        angle = swing.aim;
        stretch = Math.sin(t * Math.PI) * swing.reach * 0.34;
      } else {
        angle = this.swingBladeAngle(swing, t);
      }
      scale = 1 + 0.12 * Math.sin(t * Math.PI); // punch out slightly mid-swing
    }
    // Flip so the blade's edge faces up when pointing left; frozen to the swing's locked
    // aim while swinging so the sprite can't pop mid-sweep as it crosses straight-up/down.
    const isFlip = Math.abs(isSwinging ? swing.aim : aim) > Math.PI / 2;
    // Grip the weapon at a HAND position offset from body center, not dead center — a bit forward
    // along the aim and to the side — so the handle doesn't cut through the blob's face. The blade
    // then extends outward from the hand.
    const hand = isSwinging ? swing.aim : aim;
    const side = isFlip ? -1 : 1;
    const hx = cx + Math.cos(hand) * 10 - Math.sin(hand) * 7 * side;
    const hy = cy + Math.sin(hand) * 10 + Math.cos(hand) * 7 * side;
    const anchor = d * 0.42 + stretch; // shorter: base near the hand, blade reaches out
    // Ghost smears behind an arcing blade sell the speed of the sweep.
    if (isSwinging && !swing.isThrust) {
      this.drawBlade(img, hx, hy, this.swingBladeAngle(swing, t - 0.22), anchor, d * scale, alpha * 0.16, isFlip, artAngle);
      this.drawBlade(img, hx, hy, this.swingBladeAngle(swing, t - 0.11), anchor, d * scale, alpha * 0.32, isFlip, artAngle);
    }
    this.drawBlade(img, hx, hy, angle, anchor, d * scale, alpha, isFlip, artAngle);
  }

  // Draws blade art so its ACTUAL blade axis (the art carries a baked diagonal — artAngle)
  // lands exactly on `angle`: rotate to aim, mirror if aiming left, then back out the art's
  // own tilt inside that frame so the tip points precisely where the hitbox says.
  private drawBlade(img: HTMLImageElement, cx: number, cy: number, angle: number, anchor: number, d: number, alpha: number, isFlip: boolean, artAngle: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx + Math.cos(angle) * anchor, cy + Math.sin(angle) * anchor);
    ctx.rotate(angle);
    if (isFlip) ctx.scale(1, -1);
    ctx.rotate(-artAngle);
    ctx.drawImage(img, -d / 2, -d / 2, d, d);
    ctx.restore();
  }

  private renderAfterimages() {
    if (this.afterimages.length === 0) return;
    const { ctx, renderCam: cam } = this;
    const tint = this.selfTint();
    for (const a of this.afterimages) {
      const k = 1 - a.t; // 1..0
      // Each ghost matches the dasher's live body: bald base under a hat, else the classic
      // hero. A remote dasher's ghost carries their party tint; the local ghost keeps self
      // tint (null = the natural amber).
      const color = a.color ?? tint;
      const plain = this.sprites.ready(a.base) ? this.sprites.get(a.base) : null;
      const img = color ? this.sprites.tintedSprite(a.base, color) ?? plain : plain;
      ctx.save();
      ctx.globalAlpha = k * 0.4;
      ctx.translate(a.x - cam.x, a.y - cam.y);
      ctx.scale(a.facing, 1);
      if (img) ctx.drawImage(img, -26, -26, 52, 52);
      else { ctx.fillStyle = a.color ?? "#ffd27a"; ctx.beginPath(); ctx.arc(0, 0, this.pr, 0, 6.28); ctx.fill(); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // A proper crosshair (ring + four tick marks + center dot) rather than a bare circle,
  // so the aim point reads clearly against a busy floor. Screen-space, drawn last.
  private renderReticle() {
    if (this.isArenaRespawning()) return;
    const { ctx } = this;
    const cx = this.input.mouseX, cy = this.input.mouseY;
    const r = 8, tick = 4, gap = 3;
    const protection = this.localPvpProtectionState();
    const isArming = protection.graceEndsAtTick > protection.tick;
    ctx.save();
    if (isArming) {
      ctx.strokeStyle = "#ffd27a";
      ctx.fillStyle = "rgba(245,230,200,0.18)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (this.weapon === "sluicegate") {
      const isDrain = this.p.weaponCycles.sluicegate % 2 === 1;
      ctx.strokeStyle = isDrain ? "#d9fbff" : "#78cbd1";
      ctx.fillStyle = isDrain ? "#d9fbff" : "#78cbd1";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (isDrain) {
        ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14);
        ctx.moveTo(cx - 3, cy - 8); ctx.lineTo(cx + 3, cy - 8);
        ctx.moveTo(cx - 3, cy + 8); ctx.lineTo(cx + 3, cy + 8);
      } else {
        ctx.arc(cx, cy, 12, -2.25, -0.9);
        ctx.moveTo(cx, cy); ctx.lineTo(cx - 9, cy - 8);
        ctx.moveTo(cx, cy); ctx.lineTo(cx + 9, cy - 8);
      }
      ctx.stroke();
      ctx.font = '700 8px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(isDrain ? "DRAIN" : "FLOOD", cx, cy + 25);
      ctx.textAlign = "left";
      ctx.restore();
      return;
    }
    ctx.strokeStyle = "rgba(255,210,122,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - gap); ctx.lineTo(cx, cy - r - gap - tick);
    ctx.moveTo(cx, cy + r + gap); ctx.lineTo(cx, cy + r + gap + tick);
    ctx.moveTo(cx - r - gap, cy); ctx.lineTo(cx - r - gap - tick, cy);
    ctx.moveTo(cx + r + gap, cy); ctx.lineTo(cx + r + gap + tick, cy);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,210,122,0.95)";
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, 6.28);
    ctx.fill();
    ctx.restore();
  }

  private renderMinimap() {
    const dots: MinimapDot[] = [];
    for (const e of this.enemies) {
      dots.push({ x: e.x, y: e.y, color: isBossKind(e.kind) ? "#ffb43b" : "#ff6a6a", size: isBossKind(e.kind) ? 3 : 2 });
    }
    // Patch's waystation: a warm amber marker so the safe room reads on the map at a glance.
    if (this.world.shop) dots.push({ x: this.world.shop.keeperX, y: this.world.shop.keeperY, color: "#ffd27a", size: 2.5 });
    for (const r of this.remotes()) dots.push({ x: r.x, y: r.y, color: playerColorOr(r.colorIndex), size: 2.5 });
    this.minimap.render({
      dungeon: this.dungeon,
      playerX: this.px, playerY: this.py,
      exit: this.isArena ? null : this.dungeon.exit,
      isCleared: this.isCurrentFloorCleared(),
      dots,
    });
  }

  // =====================================================================================
  // DEV-ONLY HOOKS — reached exclusively from the ?dev sandbox (src/dev/*). None of this
  // is wired into the menu or normal play; the guarded flags above (isSandbox/isGodMode/
  // isFlowDebug) each cost one cheap branch on a hot path and are always false in a real
  // run. Kept here (rather than reaching into privates from outside) so the surface the
  // panel depends on is small, explicit, and safe.
  // =====================================================================================

  // Boot the sandbox: a solo run over the sim's arena world. Safe to call in place of
  // start() — it flips isSandbox first, then reuses the whole start path.
  devStartSandbox(): void {
    this.isSandbox = true;
    this.start({ mode: "solo", coop: null, profile: null });
  }

  private isWallAt(x: number, y: number): boolean {
    const d = this.dungeon;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    return d.tiles[ty * d.w + tx] === 1;
  }

  // Where a freshly-spawned thing should land: the cursor tile if it's on open floor,
  // otherwise a random open spot a short walk from the player (so bulk spawns spread out).
  private devPlacePoint(atCursor: boolean): { x: number; y: number } {
    if (atCursor) {
      const wx = this.input.mouseX + this.cam.x, wy = this.input.mouseY + this.cam.y;
      if (!this.isWallAt(wx, wy)) return { x: wx, y: wy };
    }
    for (let i = 0; i < 32; i++) {
      const a = Math.random() * Math.PI * 2, r = 48 + Math.random() * 150;
      const x = this.px + Math.cos(a) * r, y = this.py + Math.sin(a) * r;
      if (!this.isWallAt(x, y)) return { x, y };
    }
    return { x: this.px, y: this.py };
  }

  devSpawnEnemies(kind: EnemyKind, count: number, atCursor: boolean, tier?: EnemyTier): void {
    for (let i = 0; i < count; i++) {
      const p = this.devPlacePoint(atCursor);
      devSpawnEnemy(this.world, kind, p.x, p.y, tier);
      this.spawnParticles(p.x, p.y, 6, ENEMY_ARCHETYPES[kind].tint);
    }
  }

  devClearEnemies(): void {
    this.world.enemies.length = 0;
  }

  // ---- Wave 1 randomness dev hooks (force every mutator/affix/boss-affix in isolation) ----

  // Force-spawn an elite carrying a specific ROLLED affix (splits/shielded/hazardTrail/reflect/
  // enrage), so each affix's behavior + material tell is testable on its own.
  devSpawnAffixElite(affix: RollAffixId, kind: EnemyKind, atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    const e = devSpawnEnemy(this.world, kind, p.x, p.y, "elite");
    e.rollAffix = affix;
    if (affix === "shielded") e.affixState = ROLL_AFFIX.slabHp;
    else if (affix === "reflect") e.affixState = ROLL_AFFIX.reflectArmed;
    this.spawnParticles(p.x, p.y, 6, ENEMY_ARCHETYPES[kind].tint);
  }

  // Toggle the active floor mutators on the frozen descriptor (≤2). Refreshes the client floor so
  // vision (Dense Dark), dash (Thin Air) and the HUD readout express immediately.
  devForceMutators(ids: MutatorId[]): void {
    this.world.floorDescriptor = { ...this.world.floorDescriptor, mutators: ids.slice(0, 2) };
    this.loadFloorClient();
  }

  // Force a deep-boss affix and spawn a boss to carry it — the extra telegraphed pattern begins
  // blooming on its cadence.
  devForceBossAffix(affix: BossAffixId, atCursor: boolean): void {
    this.world.floorDescriptor = { ...this.world.floorDescriptor, bossAffix: affix };
    const p = this.devPlacePoint(atCursor);
    devSpawnEnemy(this.world, "boss", p.x, p.y);
  }

  devSpawnProp(kind: PropKind, atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    devSpawnProp(this.world, kind, p.x, p.y);
    // A spawned brazier is a new static light source: fold it into the baked field.
    if (kind === "brazier") this.rebakeLighting();
  }

  devSpawnChest(atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    devSpawnChest(this.world, p.x, p.y);
  }

  devGiveWeapon(id: WeaponId): void {
    acquireWeaponInWorld(this.world, LOCAL_ID, id); // adds to inventory + equips, so the inventory HUD is testable
    sfx("weapon");
  }

  // Apply a specific blessing immediately (reuses the real item pipeline + HUD strip).
  // A grant past Lv3 is a sim no-op, so the HUD mirror only records applied picks.
  devGrantItem(item: ItemDef): void {
    const events = applyItemToWorld(this.world, LOCAL_ID, item);
    if (events.length > 0) this.ownedItemDefs.push(item);
    this.handleSimEvents(events);
  }

  // Pop the real between-floor blessing chooser (freezes the sim, exactly like a descend).
  devOfferBlessing(): void {
    this.offerBlessing();
  }

  devToggleGod(): boolean {
    this.isGodMode = !this.isGodMode;
    this.world.isGodMode = this.isGodMode;
    return this.isGodMode;
  }

  // Sandbox: force the combo to a value (and hold the window full) so the combo HUD can be
  // screenshotted at a given tier. Pass 0 to clear. Only meaningful in the dev sandbox.
  devSetCombo(n: number): void {
    this.p.combo = Math.max(0, Math.floor(n));
    this.p.comboTimer = this.p.combo > 0 ? COMBO_WINDOW : 0;
  }

  // Sandbox: when frozen, the combo window stops draining so the HUD stays put for a gate.
  devFreezeCombo(on: boolean): boolean {
    this.comboFreeze = on;
    if (on && this.p.comboTimer <= 0 && this.p.combo > 0) this.p.comboTimer = COMBO_WINDOW;
    return this.comboFreeze;
  }

  devHealFull(): void {
    this.p.hp = this.p.maxHp;
  }

  devAddMaxHp(delta: number): void {
    this.p.mods.maxHpBonus += delta;
    applyMaxHpBonus(this.p);
  }

  // Sandbox: assign a kit to the local player so all four kits + their ults can be tested in
  // isolation (spec build-gate). Applies the kit's stat lean + starting weapon.
  devSetKit(kit: KitId): void {
    setPlayerKit(this.world, LOCAL_ID, kit);
  }

  // Sandbox: fill the ult meter + clear the 8s lockout, so a cast is available on demand.
  devFillUlt(): void {
    this.p.ultCharge = ULT.meterMax;
    this.p.ultReadyAtTick = 0;
  }

  // Sandbox: request an ult THIS frame (the authoritative sim still validates charge + lockout).
  devCastUlt(): void {
    this.devUltPulse = true;
  }

  devKit(): KitId {
    return this.p.kitId;
  }

  // Rebuild the sandbox world at a new floor (scales enemy HP/speed via createEnemy's arg).
  devSetFloor(floor: number): void {
    loadFloorIntoWorld(this.world, Math.max(1, Math.floor(floor)));
    this.loadFloorClient();
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor), isGauntlet: isGauntletFloor(this.floor) }));
  }

  // Rebuild as a REAL generated floor (full biome/architecture/hazards/enemies) at any
  // depth — the level-design eyeball tool. Leaves sandbox mode so the world populates;
  // toggles god mode ON so a deep floor can be toured without instant deletion.
  devLoadRealFloor(floor: number): void {
    this.isSandbox = false;
    this.world.isSandbox = false;
    if (!this.isGodMode) this.devToggleGod();
    loadFloorIntoWorld(this.world, Math.max(1, Math.floor(floor)));
    this.loadFloorClient();
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
  }

  devSetupPaleCapture(players = 1, phase = 1): void {
    this.isSandbox = true;
    this.world.isSandbox = true;
    if (!this.isGodMode) this.devToggleGod();
    loadFloorIntoWorld(this.world, 75, Math.max(1, Math.min(4, players)));
    this.loadFloorClient();
    this.isDevPaleCapture = true;
    this.isDevBossNameHidden = true;
    this.world.enemies.length = 0;
    this.world.props.length = 0;
    this.world.hazards.length = 0;
    const room = this.world.dungeon.rooms[this.world.dungeon.rooms.length - 1];
    const boss = devSpawnEnemy(this.world, "pale", (room.cx + 0.5) * TILE, (room.cy + 0.5) * TILE);
    if (boss.boss === null) return;
    for (const id of [...this.world.players.keys()]) {
      if (id !== LOCAL_ID) this.world.players.delete(id);
    }
    while (this.world.players.size < Math.max(1, Math.min(4, players))) {
      spawnPlayerInWorld(this.world, `pale-qa-${this.world.players.size}`);
    }
    const activePlayers = [...this.world.players.values()].slice(0, Math.max(1, Math.min(4, players)));
    for (let index = 0; index < activePlayers.length; index++) {
      const angle = (index / activePlayers.length) * Math.PI * 2 + Math.PI;
      activePlayers[index].x = boss.x + Math.cos(angle) * 210;
      activePlayers[index].y = boss.y + Math.sin(angle) * 210;
    }
    this.devSetPalePhase(phase);
    this.devTeleport(activePlayers[0].x, activePlayers[0].y);
    this.cam.x = boss.x - this.canvas.width / 2;
    this.cam.y = boss.y - this.canvas.height / 2;
    this.hud.clear();
  }

  devSetPalePhase(phase: number): void {
    const boss = this.world.enemies.find((enemy) => enemy.kind === "pale");
    if (boss?.boss === null || boss === undefined) return;
    const nextPhase = Math.max(1, Math.min(3, Math.floor(phase)));
    boss.boss.phase = nextPhase;
    boss.hp = nextPhase === 1
      ? boss.maxHp
      : nextPhase === 2
        ? boss.maxHp * PALE.phaseAt[0]
        : boss.maxHp * PALE.phaseAt[1];
    boss.spawnTimer = 0;
    boss.attack = {
      phase: "windup",
      time: nextPhase === 3 ? PALE.spokeWindup * 0.65 : PALE.ringWindup * 0.65,
      move: nextPhase === 1 ? "slam" : nextPhase === 2 ? "spew" : "sweep",
      windup: 0.65,
      cooldown: 0,
      lockedAngle: 0,
      isAimLocked: false,
      markX: boss.x,
      markY: boss.y,
    };
    boss.boss.spinCount = 0;
  }

  devSetPaleBeat(beat: "ring2" | "sweepWindup" | "sweepActive" | "crackOff"): void {
    const boss = this.world.enemies.find((enemy) => enemy.kind === "pale");
    if (boss?.boss === null || boss === undefined) return;
    if (beat === "ring2") {
      boss.boss.phase = 1;
      boss.boss.spinCount = 0;
      boss.attack.phase = "active";
      boss.attack.move = "slam";
      boss.attack.time = PALE.ring2DelaySec * 0.5;
      boss.attack.windup = 0;
    } else if (beat === "sweepWindup" || beat === "sweepActive") {
      boss.boss.phase = 3;
      boss.boss.spinCount = beat === "sweepActive" ? 5 : 0;
      boss.attack.phase = beat === "sweepActive" ? "active" : "windup";
      boss.attack.move = "sweep";
      boss.attack.time = beat === "sweepActive" ? PALE.spokeInterval * 4 : PALE.spokeWindup * 0.65;
      boss.attack.windup = beat === "sweepActive" ? 0 : 0.65;
    } else {
      boss.attack.phase = "windup";
      boss.attack.move = "roar";
      boss.attack.time = PALE.roarDuration * 0.45;
      boss.attack.windup = 0.45;
      boss.boss.roar = { floorHp: boss.hp, queued: 0, queuedBy: null };
    }
  }

  devSetPaleWarmth(isChilled: boolean): void {
    this.p.warmthIdleSec = isChilled ? PALE.warmthDrainIdleSec : 0;
    this.p.warmthPathPx = 0;
    this.p.isWarmthChilled = isChilled;
  }

  devSetBossNameHidden(isHidden: boolean): void {
    this.isDevBossNameHidden = isHidden;
  }

  devSetHitRadiusVisible(isVisible: boolean): void {
    this.isDevHitRadiusVisible = isVisible;
  }

  devToggleFlowDebug(): boolean {
    this.isFlowDebug = !this.isFlowDebug;
    return this.isFlowDebug;
  }

  // A/B the whole AO + lighting layer (legacy flat depth fill returns while off).
  devToggleLighting(): boolean {
    this.lighting.isEnabled = !this.lighting.isEnabled;
    return this.lighting.isEnabled;
  }

  // Direct lighting-layer access for QA rigs + the headless visual-metrics tests.
  devLighting(): LightingRenderer {
    return this.lighting;
  }

  // Teleport the local player (QA capture rigs aim the camera at a spot of interest).
  devTeleport(x: number, y: number): void {
    this.p.x = x;
    this.p.y = y;
    this.lastPx = x;
    this.lastPy = y;
  }

  // Read-only world access for QA scripting (hazard positions, room rects).
  devWorld(): WorldState {
    return this.world;
  }

  // Read-only access to the loaded sprite registry for the sandbox catalog thumbnails — the
  // SAME images the world renders from, so a panel thumbnail can never drift from the game.
  devSprites(): Sprites {
    return this.sprites;
  }

  // The sprite an equipped pet renders as (null for an unknown id) — the sandbox resolves a
  // pet thumbnail through the exact same mapping renderPets uses.
  devPetSprite(petId: string): SpriteName | null {
    return petSpriteFor(petId);
  }

  // Sandbox: dress the local blob in a cosmetic loadout (hat/face/body) so the equipped look
  // can be reviewed in the dev world. Visual-only — the same field a real equip feeds, picked
  // up by renderPlayer next frame.
  devSetCosmetics(loadout: CosmeticLoadout | null): void {
    this.selfCosmetics = loadout;
  }

  // Sandbox: equip (or clear) a companion pet so it trots along in the dev world — wires the
  // SAME selfPet the run start + wire identity feed into renderPets.
  devSetPet(petId: string | null): void {
    this.selfPet = petId;
  }

  devArenaUltFxCount(): number {
    return this.arenaUltVfx.activeCount();
  }

  devArenaUltFxTime(): number {
    return this.arenaUltVfx.activeTime();
  }

  devArenaUltEventCount(): number {
    return this.devArenaUltEventsSeen;
  }

  devIsWorldReady(): boolean {
    return this.isWorldRevealed;
  }

  devSnapshot(): DevSnapshot {
    return {
      fps: this.fps,
      frameMsEma: this.frameMsEma,
      fxQuality: this.fxQuality,
      floor: this.floor,
      hp: this.hp,
      maxHp: this.maxHp,
      weapon: this.weapon,
      isGodMode: this.isGodMode,
      isFlowDebug: this.isFlowDebug,
      isLighting: this.lighting.isEnabled,
      lightingMs: this.lighting.stats.frameMs,
      enemies: this.enemies.length,
      bullets: this.bullets.length,
      particles: this.particles.length,
      props: this.props.length,
    };
  }

  // Flow-field inspector: an arrow per open tile pointing downhill toward the player,
  // plus a marker on source/unreachable/prop-blocked tiles. Reads the standard-class
  // prop-aware chase field the AI shares (cached — see nav.ts), so it costs one lazy
  // build at most and nothing until toggled on.
  private renderFlowDebug(): void {
    const flow = navDebugField(this.world);
    if (!flow.isReady()) return;
    const { ctx, renderCam: cam, canvas } = this;
    const d = this.dungeon;
    const x0 = Math.max(0, Math.floor(cam.x / TILE));
    const y0 = Math.max(0, Math.floor(cam.y / TILE));
    const x1 = Math.min(d.w, Math.ceil((cam.x + canvas.width) / TILE));
    const y1 = Math.min(d.h, Math.ceil((cam.y + canvas.height) / TILE));
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(122,220,255,0.5)";
    ctx.fillStyle = "rgba(255,180,59,0.6)";
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (d.tiles[ty * d.w + tx] !== 0) continue;
        const cx = tx * TILE + TILE / 2 - cam.x;
        const cy = ty * TILE + TILE / 2 - cam.y;
        if (!flow.sampleStep(tx, ty)) {
          ctx.fillRect(cx - 3, cy - 3, 6, 6);
          continue;
        }
        const dx = flow.step.dx, dy = flow.step.dy;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const arm = 14;
        const hx = cx + ux * arm, hy = cy + uy * arm;
        const ang = Math.atan2(uy, ux);
        ctx.beginPath();
        ctx.moveTo(cx - ux * arm, cy - uy * arm);
        ctx.lineTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ang - 0.5) * 7, hy - Math.sin(ang - 0.5) * 7);
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ang + 0.5) * 7, hy - Math.sin(ang + 0.5) * 7);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
