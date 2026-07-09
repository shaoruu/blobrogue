import type { Dungeon } from "../sim/dungeon.js";
import { TILE } from "../sim/types.js";
import type { Enemy, EnemyKind, Bullet, Particle, DmgNumber, Pickup, WeaponId, AttackMove, Prop, PropKind, Chest, Hazard, RemotePlayer, FloorHazard, FloorHazardKind } from "../sim/types.js";
import { floorHazardPhaseAt, floorHazardPhaseFrac, RIFT_PULL_RADIUS } from "../sim/hazards.js";
import type { FloorHazardPhase } from "../sim/hazards.js";
import { Rng, randomSeed } from "../sim/rng.js";
import { Sprites, TileSet, playerColor, FRAME } from "./assets.js";
import type { SpriteName, SheetClip, TileName, FxName, PropSpriteName } from "./assets.js";
import { ENEMY_ARCHETYPES, isBossFloor, isBossKind, isGauntletFloor } from "../sim/enemies.js";
import { WEAPONS } from "../sim/weapons.js";
import { weaponDisplayStats, lowHpFrac } from "../sim/weaponStats.js";
import { rollItemChoicesWith, itemById, itemDesc, itemLevelsOf, MAX_ITEM_LEVEL } from "../sim/items.js";
import type { PlayerMods, ItemDef } from "../sim/items.js";
import { PLAYER, REVIVE, BOSS, MARROW, WEAVER, GILDED, TIERS } from "../sim/balance.js";
import type { EnemyTier } from "../sim/balance.js";
import { shopViewerOf, shopSlotStatusFor, SHOP_FOCUS_RANGE } from "../sim/shop.js";
import type { ShopSlot } from "../sim/shop.js";
import { shopPanelView, shopChipCopy, shopSlotName } from "../ui/shopCopy.js";
import { ShopPanel } from "../ui/shopPanel.js";
import { LocalTransport } from "../client/transport.js";
import type { Transport } from "../client/transport.js";
import { WSTransport } from "../client/wsTransport.js";
import { STAGE_B_SEED, STAGE_B_FLOOR, PROTOCOL_VERSION } from "../net/protocol.js";
import { resolveSpectateTarget, cycleSpectateTarget, isReconnectingTeammate } from "./spectate.js";
import { PartyGate } from "../net/partyGate.js";
import type { ExpectedMember, PartyGateView } from "../net/partyGate.js";
import { onlineHudLabel, netDetailsLine, reconnectOverlayCopy, BACK_ONLINE_TOAST, CONNECT_CANCEL_HINT, OFFER_EXPIRED_TOAST } from "../ui/onlineCopy.js";
import type { OnlineExitReason, OnlinePhase } from "../ui/onlineCopy.js";
import { applyItemToWorld, chooseBlessingInWorld, dismissBlessingOfferInWorld, applyMaxHpBonus, loadFloorIntoWorld, descend, devSpawnEnemy, devSpawnProp, devSpawnChest, acquireWeaponInWorld, isFloorCleared, navDebugField, nearestShopSlot } from "../sim/world.js";
import type { WorldState, PlayerSim, MeleeSwing, RemoteTarget } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import { comboTierFor, BURROW_ERUPT_RADIUS, CHARGER_RUSH_SPEED, CHARGER_RUSH_DUR, SHIELDER_BLOCK_ARC } from "../sim/constants.js";
import type { ComboTier } from "../sim/constants.js";
import { Minimap } from "./minimap.js";
import type { MinimapDot } from "./minimap.js";
import { Hud } from "./hud.js";
import type { ProfileStats } from "./hud.js";
import type { CoopBridge, LocalPlayerState } from "./coop.js";
import {
  createAnim, resetAnim, stepAnim, triggerRecoil, triggerFlash,
  characterXform, frameIndex, CHARACTER_STYLE, BOSS_STYLE, IDENTITY_XFORM,
} from "./anim.js";
import type { Anim, Xform, XformStyle } from "./anim.js";
import { createFacing, computeEnemyPose } from "./facing.js";
import type { FacingState, EnemyPose } from "./facing.js";
import { audio, sfx } from "./audio.js";
import type { SfxName, SfxOptions } from "./audio.js";
import { waveAudio } from "./waveAudio.js";
import type { WaveFramePlayer } from "./waveAudio.js";
import { WAVE_HAZARDS } from "./waveSpec.js";
import { ShockwaveField, ScreenFlash, AmbienceField } from "./vfx.js";
import { settings } from "./settings.js";
import { InputController } from "./input.js";
import type { GameAction, InputContext } from "./input.js";
import { PauseOverlay } from "../ui/pause.js";
import { BlessingOverlay } from "../ui/blessing.js";
import { BIOMES, biomeForFloor, biomeIndexForFloor, floorBannerText } from "../sim/biomes.js";
import type { Biome } from "../sim/biomes.js";
import { renderDungeonTiles, buildWallSideGradients, tileHash, hexToRgb } from "./tileRender.js";
import type { TileRenderGradient } from "./tileRender.js";

export interface RunResult {
  floor: number; kills: number; coins: number; durationMs: number;
  // The run's final build for the results screen (weapons carried + blessings with
  // levels) — display-only, never persisted.
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
  // The player's chosen blob tint (client palette index). Applies to solo + online; classic
  // co-op keeps its room-assigned colors. null/0 renders the natural amber sprite.
  selfColorIndex?: number | null;
}

// Read-only live state the dev sandbox panel polls for its readouts + button states.
// Populated only via the dev hooks below; nothing in normal play reads it.
export interface DevSnapshot {
  fps: number;
  floor: number;
  hp: number;
  maxHp: number;
  weapon: WeaponId;
  isGodMode: boolean;
  isFlowDebug: boolean;
  enemies: number;
  bullets: number;
  particles: number;
  props: number;
}

interface RemoteTracer { x: number; y: number; angle: number; life: number; color: string; len?: number; isArc?: boolean; }
interface Corpse { sprite: SpriteName; x: number; y: number; size: number; facing: number; t: number; dur: number; }
interface RemoteAnimEntry { anim: Anim; lastX: number; lastY: number; }
// A short-lived floating text in world space (e.g. the name of a just-dropped weapon).
interface WorldLabel { x: number; y: number; vy: number; life: number; maxLife: number; text: string; color: string; }
// Floor stains + drop pulses that linger for a beat after the action moves on.
interface Decal { x: number; y: number; color: string; r: number; t: number; life: number; kind: "splat" | "ring"; }
// A fading ghost of the hero left along a dash so it reads as motion, not a teleport.
interface Afterimage { x: number; y: number; facing: number; t: number; }

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
};
// Per-shot pitch/gain trims where a shared sample needs to read as a different gun
// (the railgun borrows the cannon boom, pitched up into a sharp crack).
const SHOOT_SFX_OPTS: Partial<Record<WeaponId, SfxOptions>> = {
  railgun: { rate: 1.35, gain: 0.85 },
  sawnoff: { rate: 0.9 },
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
  bladeSize: number; // held blade draw size in px (the 40px art scaled up)
  artAngle: number;  // baked-in angle of the blade axis in the art (rad; measured tip-ward)
}
const MELEE_FEEL: Partial<Record<WeaponId, MeleeFeel>> = {
  sword: { swingSfx: "meleeSwing", swingRate: 1.12, swingGain: 0.7, hitTrauma: 0.12, hitFreeze: 0.045, bladeSize: 46, artAngle: -0.80 },
  longsword: { swingSfx: "heavySwing", swingRate: 1, swingGain: 1, hitTrauma: 0.22, hitFreeze: 0.07, bladeSize: 56, artAngle: -0.80 },
  spear: { swingSfx: "meleeSwing", swingRate: 1.3, swingGain: 0.6, hitTrauma: 0.15, hitFreeze: 0.05, bladeSize: 58, artAngle: -0.80 },
};
const MELEE_HIT_TRAUMA = 0.14; // fallback thump when the striker's weapon is unknown (remote hits)
const MELEE_CLASH_FREEZE = 0.055; // extra stop when a swing connects mid enemy attack (the "parry")
const BOSS_SLAM_RADIUS = BOSS.slamRadius; // shockwave radius (also the ground-marker size)
const BOSS_JUMP_HEIGHT = 42;   // px the boss visually lifts mid hop-slam
const FREEZE_AT = 3;           // chill >= this renders as frozen-solid crust
const BURN_TINT = "#ff8a3b";   // ember/burn overlay + burn-tick dmg number color
const AIM_DASH: number[] = [7, 6]; // dashed aim-line pattern (telegraph render)

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
};
// Per-weapon feel: recoil punch (sprite scale kick), camera kick (px, back along aim),
// and knockback (px the weapon shoves the player). The hand cannon is the beefy end.
const FIRE_RECOIL: Record<WeaponId, number> = {
  pistol: 1, shotgun: 1.4, rapid: 0.6,
  smg: 0.5, cannon: 1.6, burst: 0.9, ricochet: 1, homing: 0.4, tesla: 0.7,
  sawnoff: 1.6, railgun: 1.5, nailer: 0.6, flamer: 0.3, mortar: 1.4,
  beam: 0.15,
  sword: 0.7, longsword: 1.1, spear: 0.6,
};
const FIRE_KICK: Record<WeaponId, number> = {
  pistol: 3, shotgun: 8, rapid: 1.2,
  smg: 1, cannon: 10, burst: 2, ricochet: 3, homing: 0.5, tesla: 1.5,
  sawnoff: 11, railgun: 6, nailer: 1.2, flamer: 0.5, mortar: 7,
  beam: 0.3,
  sword: 1.5, longsword: 2.5, spear: 1,
};
const KICK_DECAY = 20; // how fast the camera kick eases back to center
const TRAUMA_HURT = 0.4;
const TRAUMA_KILL = 0.16;
const TRAUMA_BOSS_KILL = 0.7;
const TRAUMA_BOSS_SLAM = 0.4;
const TRAUMA_DESCEND = 0.22;
const TRAUMA_BOSS_FLOOR = 0.5;
const TRAUMA_REMOTE_DOWN = 0.3;

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

// Hurt vignette: a red screen-edge flash on damage that fades fast (seconds⁻¹).
const HURT_FLASH_DECAY = 3.2;
// Low-HP warning: at/below this health fraction the screen edge breathes red.
const LOW_HP_FRAC = 0.25;

// Client particle budget: the newest effect wins; the oldest particle is dropped when the
// pool is full, so a busy screen degrades gracefully instead of eating the frame budget.
const MAX_PARTICLES = 700;
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
};
// Break sheet per destructible kind (frames 1-2 = breaking). Brazier never breaks.
const PROP_BREAK_SHEET: Record<PropKind, PropSpriteName | null> = {
  crate: "crate_break", pot: "pot_break", barrel: "barrel_break",
  barrel_explosive: "barrel_explosive_break", brazier: null,
};
const PROP_TINT: Record<PropKind, string> = {
  crate: "#c9a06a", pot: "#8fb8d6", barrel: "#b07a3c", barrel_explosive: "#ff8a3b", brazier: "#ffb43b",
};
// Patch's station art hooks per slot kind (assets.ts PROP_SOURCES); flat primitives
// stand in until the approved PNGs land.
const SHOP_STATION_IMG: Record<ShopSlot["kind"], PropSpriteName> = {
  weapon: "shop_pedestal",
  blessing: "shop_pedestal",
  heart: "shop_heart_station",
  reroll: "shop_reroll_post",
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
  private pause: PauseOverlay;
  private blessing: BlessingOverlay;
  private shopPanel: ShopPanel;
  // Patch's handover pose timer (seconds left in the one-shot sell clip) and the per-floor
  // "welcome" latch (the first step into the waystation names it once).
  private patchSellT = 0;
  private isShopWelcomed = false;
  private isPaused = false;
  private isChoosing = false; // a between-floor blessing overlay is up (freezes the sim)
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
  private seed = 0;
  // Seeded stream for solo/co-op blessing choice rolls (the sim never rolls choices; online
  // the server decides). Keeps the whole client Math.random-free on the choice path.
  private blessingRng = new Rng(0);

  private comboFreeze = false; // dev/sandbox: hold the chain at a set value so the HUD can be gated

  // player (client-only cosmetics)
  private ownedItemDefs: ItemDef[] = []; // mirror of the local player's picked items, for the HUD
  private selfColorIndex: number | null = null; // chosen blob tint (solo + online); null/0 = natural amber
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
  private corpses: Corpse[] = [];
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
  private screenFlash = new ScreenFlash();
  private motes = new AmbienceField();
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
  private get chests(): Chest[] { return this.world.chests; }

  private isRunning = false;
  private last = 0;
  private simAccum = 0; // fixed-timestep accumulator (seconds) for smooth framerate-independent sim
  private renderPrevX = 0; private renderPrevY = 0; // player pos before the last sim step (render interpolation)
  private hasRenderPrev = false;
  private renderAlpha = 0; // 0..1 interpolation factor within the current sim step (set each frame)
  private raf = 0;
  private runStart = 0;
  private animClock = 0; // wall-clock seconds for prop/ambient animation (torch, portal)
  // Per-biome side-face gradients for the extruded wall look (built once). Indexed by biome.
  private wallSideGrads: [TileRenderGradient, TileRenderGradient][] = [];
  private currentBiome: Biome = biomeForFloor(1);
  private biomeIdx = 0;
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

  // ---- dev sandbox state (all false/0 in normal play; see the dev hooks at the end) ----
  // Every flag below is inert unless the ?dev sandbox flips it, so the whole feature is a
  // handful of cheap, harmless branches on the hot paths and tree-shakes out of a run.
  private isSandbox = false;   // arena floor + no auto-population (dev spawns by hand)
  private isGodMode = false;   // damagePlayer no-ops while true
  private isFlowDebug = false; // draw the pathfinding flow-field arrows over the floor
  private fps = 0;             // smoothed frames/sec, surfaced via devSnapshot()

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, hudRoot: HTMLElement, onGameOver: (result: RunResult) => void, onExit: (reason?: ExitReason, detail?: string) => void) {
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
    });
    this.onGameOver = onGameOver;
    this.onExit = onExit;
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
      if (document.visibilityState === "hidden") this.input.releaseAll();
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
        // On the connecting/readiness veil or mid-outage, Escape is CANCEL: give up on this
        // connection attempt and return to the lobby — never a pause menu over a dead world.
        if (this.mode === "online" && this.wsTransport && (this.isAwaitingOnlineWorld() || this.isOnlineOutage())) {
          this.quitToMenu("quit");
          break;
        }
        this.togglePause();
        break;
      case "interact":
        if (this.isRunning) this.openFocusedShopStation();
        break;
      case "selectWeapon":
        if (this.isRunning) this.equipSlot(a.index);
        break;
      case "cycleWeapon":
        if (this.isRunning) this.cycleWeapon(a.dir);
        break;
      case "dropWeapon":
        if (this.isRunning) this.dropEquippedWeapon();
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
    this.input.setContext(this.currentInputContext());
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
    this.inputSeq = 0;
    this.blessingRng = new Rng(this.seed ^ 0x0b1e55);
    this.ownedItemDefs = [];
    this.remoteShotSeen.clear();
    this.remoteDownSeen.clear();
    this.remoteAnims.clear();
    this.reviveHold.clear();
    this.freeze = 0;
    this.trauma = 0;
    this.kickX = 0; this.kickY = 0;
    this.hurtFlash = 0;
    this.isPaused = false;
    this.isChoosing = false;
    this.isWorldRevealed = this.mode !== "online";
    this.partyView = null;
    this.pendingWorld = null;
    this.isWorldReported = false;
    this.connectDeadline = performance.now() + CONNECT_HANDSHAKE_TIMEOUT_MS;
    this.isOutageSeen = false;
    this.pendingDescend = 0;
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
      this.cam.x = this.px - this.canvas.width / 2;
      this.cam.y = this.py - this.canvas.height / 2;
      this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor), isGauntlet: isGauntletFloor(this.floor) }));
    }
    this.hud.setVisible(true);
    // First run ever: briefly surface the core controls, then never nag again.
    if (!settings.isControlsHintSeen) {
      this.hud.showControlsHint();
      settings.markControlsHintSeen();
    }
    this.isRunning = true;
    this.syncInputContext(); // entering the run drops any latched menu-era input
    this.last = performance.now();
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
    this.biomeIdx = biomeIndexForFloor(this.floor);
    this.currentBiome = biomeForFloor(this.floor);
    // Crossing into a NEW band is a reveal beat: a soft wash in the biome's light color
    // sells "you are somewhere else now" the moment the floor fades in.
    if (this.biomeIdx !== prevBiomeIdx && this.floor > 1) {
      const glow = hexToRgb(this.currentBiome.glow);
      this.screenFlash.flash(glow[0], glow[1], glow[2], 0.16, 1.6);
    }
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
    this.torches = this.placeTorches(this.dungeon);
    this.particles = [];
    this.dmgNumbers = [];
    this.worldLabels = [];
    this.remoteTracers = [];
    this.corpses = [];
    this.decals = [];
    this.afterimages = [];
    this.muzzle.t = 0;
    this.shockwaves.clear();
    this.screenFlash.clear();
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
    if (isBoss) { sfx("bossSpawn"); this.addTrauma(TRAUMA_BOSS_FLOOR); }
    // Wave layer: sweep entity-keyed loops/tells from the old floor, crossfade the biome's
    // ambient bed, and preload this floor's cue set (zone + hazards + the boss actually here).
    waveAudio.onFloorLoad();
    // Deterministic biome-ambient RNG: the Deep's sparse pattern is a pure function of
    // (run seed, floor) — reproducible per floor, different across floors.
    waveAudio.setAmbientZone(this.biomeIdx, (this.seed ^ Math.imul(this.floor, 0x9E3779B9)) | 0);
    const bossUnit = this.world.enemies.find((e) => e.boss !== null && !e.dead);
    // First-trigger contract: decode every cue this floor can reach — the boss actually
    // here plus every spawned archetype's tells — before any of them can fire.
    const floorKinds = new Set<string>();
    for (const e of this.world.enemies) floorKinds.add(e.kind);
    for (const e of this.world.pendingSpawns) floorKinds.add(e.kind);
    waveAudio.preloadForFloor(this.biomeIdx, bossUnit ? bossUnit.kind : null, floorKinds);
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
    this.animClock = t / 1000; // ambient props keep flickering even while paused/frozen
    // Paused (Esc) or picking a blessing: keep drawing the frozen frame under the
    // overlay, run no sim. Reuses the exact freeze path co-op already tolerates. An ONLINE
    // pick still pumps the authoritative stream: the server world keeps ticking under the
    // overlay, and the offer's TTL expiry must land NOW, not when the overlay closes.
    if (this.isPaused || this.isChoosing) {
      if (this.isChoosing) this.pumpChoosingOnline();
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
      this.pause.show();
    } else {
      this.pause.hide();
      this.last = performance.now(); // avoid a huge catch-up dt after the pause
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
    this.cam.x = this.px - this.canvas.width / 2;
    this.cam.y = this.py - this.canvas.height / 2;
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
    this.runStart = performance.now();
  }

  // One client frame: sample input -> drive the sim through the transport -> replay the
  // returned events into FX -> advance client-only cosmetics -> render (caller). Solo runs
  // stepWorld in-process (LocalTransport), so this IS the old update loop, just seam'd.
  private tick(dt: number) {
    // Keep the input context tracking run state (reconnect veil lifting, going down /
    // being revived) so samples/actions are always gated against the current surface.
    this.syncInputContext();
    // Snapshot player pos BEFORE this sim step so the renderer can interpolate between the
    // last two sim positions (smooth motion at any frame rate vs the fixed sim rate).
    this.renderPrevX = this.px; this.renderPrevY = this.py; this.hasRenderPrev = true;
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
        this.hud.showBanner(floorBannerText(rebuilt.floor, { isBoss: isBossFloor(rebuilt.floor), isGauntlet: isGauntletFloor(rebuilt.floor) }));
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
    this.tickCosmetics(dt, cmd);

    if (this.coop) this.publishPresence();
    this.updateHud();
    if (this.isStatsHeld) this.openStats();
  }

  // Build this tick's InputCmd from the context-gated controller sample plus the
  // mouse->world aim; the sim only sees moveX/moveY/aim/firing/dash/interact. The "hud"
  // context (hotbar drag / open drawer) samples idle, so HUD interaction never leaks into
  // combat — and the "spectate" context (downed) samples idle too, so a spectator sends no
  // gameplay intents at the source (the authoritative sim ignores them anyway).
  private buildInput(): InputCmd {
    const s = this.input.sample();
    const wx = this.input.mouseX + this.cam.x, wy = this.input.mouseY + this.cam.y;
    const aim = Math.atan2(wy - this.py, wx - this.px);
    return { seq: ++this.inputSeq, moveX: s.moveX, moveY: s.moveY, aim, firing: s.firing, dash: s.dash, interact: s.interact };
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

  // Other players to render, from whichever remote source is active: co-op presence (Convex)
  // or the authoritative server (WSTransport). Solo returns none.
  private remotes(): RemotePlayer[] {
    if (this.mode === "coop" && this.coop) return this.coop.remotePlayers();
    if (this.mode === "online" && this.wsTransport) return this.wsTransport.remotePlayers();
    return [];
  }

  // Advance the client-only cosmetics the sim no longer owns: player anim, dash trail
  // afterimages, particle/decal/etc lifetimes, screen-shake/kick/hurt decay, camera.
  private tickCosmetics(dt: number, cmd: InputCmd) {
    if (!this.isDown) {
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
      this.enemyPoses.set(e.id, computeEnemyPose(e, facing, dx * inv, dy * inv, anim.move > 0.5));
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
      if (this.dashImgCd <= 0) { this.afterimages.push({ x: this.px, y: this.py, facing: this.facing, t: 0 }); this.dashImgCd = 0.04; }
    }

    this.updateFootstepDust(dt);
    this.updateParticles(dt);
    this.updateDmgNumbers(dt);
    this.updateWorldLabels(dt);
    this.updateTracers(dt);
    this.updateCorpses(dt);
    this.updateDecals(dt);
    this.updateAfterimages(dt);
    this.shockwaves.update(dt);
    this.screenFlash.update(dt);
    if (this.muzzle.t > 0) this.muzzle.t = Math.max(0, this.muzzle.t - dt);
    if (this.coop) this.updateRemoteAnims(dt);
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);
    const ke = Math.min(1, dt * KICK_DECAY);
    this.kickX -= this.kickX * ke; this.kickY -= this.kickY * ke;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * HURT_FLASH_DECAY);

    this.checkFloorCleared();

    // Smooth camera follow: ease toward the focus instead of hard-snapping every frame, so
    // per-frame movement variance (variable-dt sim step) doesn't read as jitter. High factor
    // = still tight tracking, just enough smoothing to absorb frame-time noise. The focus is
    // the local player — or, while down and spectating, the watched teammate; the same ease
    // glides the hand-off out and back (revive returns the camera home).
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
    this.motes.update(dt, this.cam.x, this.cam.y, this.canvas.width, this.canvas.height, this.px, this.py, pvx, pvy);
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
      if (!this.isNearCamera(x, y)) continue;
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
    for (const e of events) this.handleSimEvent(e);
  }

  private handleSimEvent(e: SimEvent) {
    switch (e.t) {
      case "shot": {
        const w = WEAPONS[e.weapon];
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon] * settings.effectiveRecoil);
        this.muzzle.t = MUZZLE_DUR; this.muzzle.x = e.x; this.muzzle.y = e.y; this.muzzle.angle = e.aim; this.muzzle.size = w.muzzle; this.muzzle.color = w.color;
        this.spawnParticles(e.x, e.y, w.muzzle, "#ffe6a0");
        if (SMOKY_WEAPONS.has(e.weapon)) this.spawnPuff(e.x, e.y, 3, "#c9b8a0");
        if (e.weapon !== "rapid" && e.weapon !== "flamer") this.spawnShell(e.px, e.py - 6, e.aim);
        // Manifest-bound weapons (Thumper lob, Sunlance held-beam lifecycle) own their
        // sound through the wave layer; every other weapon keeps its exact legacy sample.
        if (!waveAudio.weaponFired(e.weapon, { x: e.x, y: e.y })) {
          sfx(SHOOT_SFX[e.weapon], SHOOT_SFX_OPTS[e.weapon]);
        }
        this.addTrauma(FIRE_TRAUMA[e.weapon]);
        const kick = FIRE_KICK[e.weapon] * settings.effectiveRecoil;
        this.kickX += -Math.cos(e.aim) * kick;
        this.kickY += -Math.sin(e.aim) * kick;
        break;
      }
      case "meleeSwing": {
        const w = WEAPONS[e.weapon];
        const m = w.melee;
        this.meleeFlipDir = -this.meleeFlipDir; // alternate the visual sweep; the hitbox wedge is symmetric
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon] * settings.effectiveRecoil);
        if (m) this.spawnSlashWind(e.x, e.y, e.aim, m, w.color);
        const feel = MELEE_FEEL[e.weapon];
        if (feel) sfx(feel.swingSfx, { rate: feel.swingRate, gain: feel.swingGain });
        else sfx(SHOOT_SFX[e.weapon]);
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
        this.spawnDmgNumber(e.dmgX, e.dmgY, e.dmg, { crit: e.crit });
        this.spawnPuff(e.puffX, e.puffY, e.crit ? 9 : 5, e.puffColor);
        if (e.crit) {
          sfx("crit", { gain: 0.6 });
          this.spawnSparkFlash(e.puffX, e.puffY, "#fff3c4");
          this.addFreeze(0.03); // a hair of impact-frame so a crit lands harder
        }
        if (e.closeShotgun) this.addFreeze(FREEZE_SHOTGUN);
        if (e.melee) this.replayMeleeImpact(e.eid, e.puffX, e.puffY, e.crit);
        // Sunlance hits tick through the wave layer's 120ms-per-target limiter — a held
        // beam at 22Hz must never machine-gun the generic hit sample.
        if (!e.killed) {
          if (!e.melee && waveAudio.isBeamWeapon(this.p.weapon)) waveAudio.beamHitAt(e.eid, e.dmgX, e.dmgY);
          else sfx(e.melee ? "meleeHit" : "enemyHit", { gain: e.melee ? 0.9 : 0.65 });
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
        if (big) audio.setMusic("dungeon"); // the intense boss track relaxes after the kill
        this.spawnGibs(e.x, e.y, big ? 24 : 10, arch.tint);
        this.spawnParticles(e.x, e.y, big ? 20 : 8, big ? "#ffb43b" : arch.tint);
        this.addDecal(e.x, e.y, arch.tint, big ? 36 : 18, "splat");
        this.replayDeathBurst(e.kind, e.x, e.y);
        const dur = big ? DEATH_DUR_BOSS
          : (e.kind === "slime" || e.kind === "skeleton" || e.kind === "bat") ? DEATH_DUR_SHEET
          : DEATH_DUR;
        const size = arch.drawSize * (TIERS[e.tier as EnemyTier]?.drawMult ?? 1);
        this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size, facing: this.px >= e.x ? 1 : -1, t: 0, dur });
        const comboRate = 1 + Math.min(e.combo - 1, 20) * 0.015;
        // Wave-roster bosses die on their authored identity cue, never the generic splat.
        if (!waveAudio.bossDeath(e.kind, e.x, e.y)) {
          sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : comboRate });
        }
        this.addFreeze(big ? FREEZE_HEAVY : FREEZE_KILL);
        const mult = comboTierFor(e.combo).mult;
        const comboTrauma = big ? 0 : COMBO_TRAUMA * ((mult - 1) / (COMBO_MAX_MULT - 1));
        this.addTrauma((big ? TRAUMA_BOSS_KILL : TRAUMA_KILL) + comboTrauma);
        this.enemyAnims.delete(e.eid);
        break;
      }
      case "heal":
        this.spawnParticles(e.x, e.y, 8, "#ff6a9d");
        sfx("heart", { gain: 0.5 });
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
        triggerFlash(this.playerAnim);
        this.spawnParticles(e.x, e.y, 10, "#ff5a5a");
        sfx("playerHurt");
        this.addFreeze(FREEZE_HURT);
        this.addTrauma(TRAUMA_HURT);
        this.hurtFlash = 1;
        this.hurtDir = this.findThreatDir(); // point the vignette at whatever just hit us
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
      case "pickup":
        if (e.kind === "coin") { this.spawnParticles(e.x, e.y, 6, "#ffd27a"); this.addDecal(e.x, e.y, "#ffd27a", 10, "ring"); sfx("coin"); }
        else if (e.kind === "heart") { this.spawnParticles(e.x, e.y, 8, "#ff6a6a"); this.addDecal(e.x, e.y, "#ff6a6a", 12, "ring"); sfx("heart"); }
        else { this.spawnParticles(e.x, e.y, 12, "#ffb43b"); this.addDecal(e.x, e.y, "#ffb43b", 14, "ring"); sfx("weapon"); }
        break;
      case "shopBuy":
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
        this.patchSellT = 0.6;
        break;
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
      case "bulletWall":
        this.spawnSparks(e.x, e.y, 5, e.aim);
        break;
      case "bulletBounce":
        this.spawnSparks(e.x, e.y, 3, e.aim);
        this.spawnSparkFlash(e.x, e.y, e.color);
        break;
      case "bulletBlocked":
        this.sfxAt("parry", e.x, e.y, { rate: 1.2, gain: 0.5 });
        this.spawnSparks(e.x, e.y, 4, e.aim);
        break;
      case "bulletExpire":
        this.spawnPuff(e.x, e.y, 6, e.color);
        break;
      case "propHit":
        triggerFlash(this.animForPropId(e.propId));
        this.spawnPuff(e.x, e.y, 5, PROP_TINT[e.kind]);
        break;
      case "propBreak":
        this.replayPropBreak(e.kind, e.x, e.y);
        break;
      case "explosion":
        this.sfxAt("barrel", e.x, e.y, { rate: 0.7 });
        this.addFreeze(FREEZE_HEAVY);
        this.addTrauma(0.6);
        this.spawnGibs(e.x, e.y, 18, "#ff8a3b");
        this.spawnSparks(e.x, e.y, 16, Math.random() * 6.28);
        this.spawnParticles(e.x, e.y, 20, "#ffb43b");
        this.addDecal(e.x, e.y, "#ff7a2a", e.r * 0.6, "splat");
        this.shockwaves.spawn(e.x, e.y, 14, e.r * 1.6, 0.38, "#ffb43b", 5);
        this.spawnSparkleBurst(e.x, e.y, 10, "#ff8a3b");
        if (this.isNearCamera(e.x, e.y)) this.flashScreen(255, 150, 60, 0.13, 3.2);
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
        if (e.kind === "spikes") this.spawnSparks(e.x, e.y, 6, -Math.PI / 2);
        if (e.kind === "fire_vent") this.spawnEmberAt(e.x, e.y, 10);
        if (e.kind === "void_rift") this.spawnSparkleBurst(e.x, e.y, 8, tint);
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
        this.spawnParticles(e.x, e.y, 10, "#c9a06a");
        this.spawnSparks(e.x, e.y, 6, 0);
        this.shockwaves.spawn(e.x, e.y, 10, 60, 0.3, "#ffd27a", 3);
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
      case "bossSlam":
        this.sfxAt("enemyDeath", e.x, e.y, { rate: 0.5 });
        this.spawnParticles(e.x, e.y, 22, "#ffd27a");
        this.spawnSparks(e.x, e.y, 12, 0);
        this.addDecal(e.x, e.y, "#ffb43b", BOSS_SLAM_RADIUS * 0.5, "splat");
        this.shockwaves.spawn(e.x, e.y, 20, BOSS_SLAM_RADIUS * 1.25, 0.42, "#ffd27a", 6);
        this.spawnDustRing(e.x, e.y, BOSS_SLAM_RADIUS * 0.55, 14, "#c9a06a");
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
          if (this.isNearCamera(e.x, e.y)) { sfx("enemyHit", { gain: 0.5, rate: 0.6 }); this.addTrauma(TRAUMA_BOSS_SLAM); }
        }
        break;
      case "bossPhase": {
        triggerFlash(this.animForId(e.eid));
        const phaseKind = this.world.enemies.find((en) => en.id === e.eid)?.kind;
        if (!(phaseKind !== undefined && waveAudio.bossPhase(phaseKind, e.x, e.y, e.eid))) {
          this.sfxAt("bossSpawn", e.x, e.y);
        }
        this.addTrauma(TRAUMA_BOSS_FLOOR);
        this.shockwaves.spawn(e.x, e.y, 30, 190, 0.55, "#ffb43b", 4);
        this.flashScreen(255, 180, 59, 0.12, 2.8);
        break;
      }
      case "bossTransition":
        // Telemetry-bearing beat (enter/exit + queued overflow); the juice rides bossPhase.
        break;
      case "enemySpawn": {
        const tint = ENEMY_ARCHETYPES[e.kind].tint;
        this.spawnPuff(e.x, e.y, 8, tint);
        if (this.isNearCamera(e.x, e.y)) sfx("enemyHit", { gain: 0.4, rate: 0.7 });
        break;
      }
      case "descend":
        sfx("descend");
        this.addTrauma(TRAUMA_DESCEND);
        // Online, the structural floor load is driven by the authoritative world rebuild
        // (consumeWorldRebuilt in tick) — the event only carries the juice. Solo/co-op load here.
        if (this.mode !== "online") {
          this.loadFloorClient();
          this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor), isGauntlet: isGauntletFloor(this.floor), isDescend: true }));
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
      case "flash":
        triggerFlash(this.animForId(e.eid));
        break;
      case "puff":
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
        if (this.isNearCamera(e.x, e.y)) {
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

  // Melee connect: metal-on-flesh weight. Sparks fly out along the strike line from the
  // player through the contact point, a bright flash pops at the blade, and the per-weapon
  // hit-stop/trauma land the blow. Striking an enemy MID-ATTACK (windup/active) reads as a
  // clash — the parry CLANG, a white flash, and a longer stop — rewarding aggressive timing.
  private replayMeleeImpact(eid: number, hitX: number, hitY: number, isCrit: boolean) {
    const feel = MELEE_FEEL[this.weapon];
    this.addTrauma(feel?.hitTrauma ?? MELEE_HIT_TRAUMA);
    this.addFreeze(feel?.hitFreeze ?? FREEZE_KILL);
    const dir = Math.atan2(hitY - this.py, hitX - this.px);
    this.spawnSparks(hitX, hitY, isCrit ? 10 : 6, dir);
    const bladeColor = WEAPONS[this.weapon].melee ? WEAPONS[this.weapon].color : "#fff3c4";
    this.spawnSparkFlash(hitX, hitY, bladeColor);
    const target = this.enemies.find((en) => en.id === eid);
    const isClash = target !== undefined && (target.attack.phase === "windup" || target.attack.phase === "active") && target.attack.move !== "none";
    if (isClash) {
      sfx("parry", { gain: 0.85 });
      this.spawnSparkFlash(hitX, hitY, "#ffffff");
      this.addFreeze(MELEE_CLASH_FREEZE);
      this.addTrauma(0.08);
    }
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
    const choices = rollItemChoicesWith(3, () => this.blessingRng.next(), owned, { rareOnly: rare });
    if (choices.length === 0) { dismissBlessingOfferInWorld(this.world, LOCAL_ID); return; }
    this.isChoosing = true;
    this.isPaused = false;
    this.syncInputContext();
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      const events = chooseBlessingInWorld(this.world, LOCAL_ID, item);
      if (events.length > 0) this.ownedItemDefs.push(item);
      this.handleSimEvents(events);
      this.isChoosing = false;
      this.syncInputContext();
      this.last = performance.now();
    });
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
  private offerServerBlessing(offer: { id: number; choices: string[] }) {
    const choices = offer.choices.map((id) => itemById(id)).filter((it): it is ItemDef => it !== undefined);
    if (choices.length === 0 || !this.wsTransport) return;
    this.isChoosing = true;
    this.isPaused = false;
    this.choosingSinceTick = this.wsTransport.getLatestSnapshot()?.tick ?? 0;
    this.syncInputContext();
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      this.wsTransport?.sendChooseBlessing(offer.id, item.id);
      this.isChoosing = false;
      this.syncInputContext();
      this.last = performance.now();
    });
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

  // Equip the weapon in hotbar slot `index` (number keys 1-9 via the selectWeapon action).
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

  // Move hotbar slot `from` to position `to` (hotbar drag/drop). The 1-9 keys always map to
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

  private cycleWeapon(dir: number) {
    const owned = this.p.ownedWeapons;
    if (owned.length < 2) return;
    const cur = owned.indexOf(this.weapon);
    this.equipSlot((cur + dir + owned.length) % owned.length);
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
    if (this.isNearCamera(x, y)) sfx(name, opts);
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

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.gravity !== 0) p.vy += p.gravity * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      if (p.vr !== 0) p.rot += p.vr * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
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

  private updateRemoteAnims(dt: number) {
    if (!this.coop) return;
    const remotes = this.coop.remotePlayers();
    for (const r of remotes) {
      let entry = this.remoteAnims.get(r.playerId);
      if (!entry) { entry = { anim: createAnim(), lastX: r.x, lastY: r.y }; this.remoteAnims.set(r.playerId, entry); }
      const moving = Math.hypot(r.x - entry.lastX, r.y - entry.lastY) > 0.35;
      const lean = r.x - entry.lastX;
      stepAnim(entry.anim, dt, moving, lean < 0 ? -1 : lean > 0 ? 1 : 0);
      entry.lastX = r.x; entry.lastY = r.y;
    }
    if (this.remoteAnims.size > remotes.length) {
      const live = new Set<string>();
      for (const r of remotes) live.add(r.playerId);
      for (const id of this.remoteAnims.keys()) if (!live.has(id)) this.remoteAnims.delete(id);
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
        this.remoteTracers.push({ x: r.x, y: r.y, angle: r.aimAngle, life: 0.12, color: playerColor(r.colorIndex) });
        this.spawnParticles(r.x + Math.cos(r.aimAngle) * 18, r.y + Math.sin(r.aimAngle) * 18, 2, "#ffe6a0");
        const entry = this.remoteAnims.get(r.playerId);
        if (entry) triggerRecoil(entry.anim);
        if (this.isNearCamera(r.x, r.y)
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
      if (r.isDown && !wasDown && this.isNearCamera(r.x, r.y)) {
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
      if (Math.hypot(this.px - r.x, this.py - r.y) < REVIVE.radius) {
        seen.add(r.playerId);
        const held = (this.reviveHold.get(r.playerId) ?? 0) + dt;
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
        // Teammates still deciding a pick — the visible reason a cleared floor isn't
        // descending yet (own overlay covers the self case).
        waitingPicks: this.wsTransport.getPartyWait().filter((w) => w.pid !== selfId).length,
      });
    }
    const comboTier = this.comboTier();
    this.hud.update({
      hp: this.hp, maxHp: this.maxHp,
      floor: this.floor, kills: this.kills, coins: this.coins,
      // Live per-weapon cards ride each slot (mods + low-HP scalers via the sim's own
      // helper) so hover tooltips always show what a trigger pull would actually do.
      weapons: this.p.ownedWeapons.map((id) => ({
        id, name: WEAPONS[id].name, isCurrent: id === this.weapon,
        card: weaponDisplayStats(id, this.mods, lowHpFrac(this.hp, this.maxHp)),
      })),
      // Online floors use the authoritative global cleared flag (enemies may be interest-filtered
      // out of this client's snapshot, so a local count can't decide "cleared").
      isCleared: this.mode === "online" && this.wsTransport ? this.wsTransport.isFloorCleared() : isFloorCleared(this.world),
      enemiesLeft: this.enemies.length,
      isObjectiveHidden: this.isSandbox,
      isParty: this.mode !== "solo" && this.remotes().length > 0,
      isBossActive,
      bossHpFrac,
      coopLabel,
      prompt: this.hudPrompt(),
      dashFill: 1 - this.dashCd / this.dashCooldown(),
      combo: this.combo,
      comboMult: comboTier.mult,
      comboColor: comboTier.color,
      comboFrac: this.comboTimer / COMBO_WINDOW,
      items: this.collapsedItems(),
      // One coordination slot: an open blessing gate outranks exit staging (picks always
      // resolve before the descend, so the messages can never both apply).
      waitLabel: this.blessingWaitLabel() ?? this.exitWaitLabel(),
    });
  }

  // The SEMANTIC contextual action (UI Part4): what the interact input would do right now,
  // as data — action id + target + authoritative progress — never presentation. This is
  // the single source the HUD prompt derives from today and a controller pass maps to its
  // A-button glyph later; it rides the P0 input-context system (the `interact` sample/
  // press + context gates in src/game/input.ts) rather than any parallel input path.
  // Priority: the revive affordance (a living local player inside a revivable downed
  // teammate's ring — OUT bodies never prompt) outranks the shop affordance (a focused
  // station in Patch's room), so one E always means one thing.
  contextualAction(): { action: "revive"; targetName: string; progress: number | null } | { action: "shop"; label: string } | null {
    // A pick overlay pauses the player (sim-shielded, inputs idle) — there IS no
    // contextual action to offer under it.
    if (!this.isRunning || this.isChoosing || this.isDown || this.hp <= 0) return null;
    if (this.mode !== "solo" && !this.isSandbox) {
      let near: RemotePlayer | null = null;
      for (const r of this.remotes()) {
        if (!r.isDown || r.isOut) continue;
        if (Math.hypot(this.px - r.x, this.py - r.y) > REVIVE.radius) continue;
        if (near === null || r.reviveProgress > near.reviveProgress) near = r;
      }
      if (near !== null) {
        const isChanneling = near.reviveProgress > 0 && this.input.isInteractHeld;
        return {
          action: "revive",
          targetName: near.name,
          progress: isChanneling ? Math.min(1, near.reviveProgress / REVIVE.channel) : null,
        };
      }
    }
    if (!this.shopPanel.isOpen) {
      const slot = this.focusedShopSlot();
      if (slot !== null) return { action: "shop", label: shopSlotName(slot).toUpperCase() };
    }
    return null;
  }

  // The BL prompt presentation over the semantic action. The key cap is the KEYBOARD
  // binding only — no controller glyph until a controller actually exists (UI Part4);
  // when pads land, the same semantic action maps to its A-button glyph here.
  private hudPrompt(): { key: string; label: string; isActive: boolean } | null {
    const act = this.contextualAction();
    if (act === null) return null;
    if (act.action === "shop") return { key: "E", label: `INSPECT ${act.label}`, isActive: false };
    const name = act.targetName.toUpperCase();
    if (act.progress !== null) {
      return { key: "E", label: `REVIVING ${name} \u00b7 ${Math.round(act.progress * 100)}%`, isActive: true };
    }
    return { key: "E", label: `HOLD TO REVIVE ${name}`, isActive: false };
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
    if (this.contextualAction()?.action === "revive") return;
    const slot = this.focusedShopSlot();
    if (slot === null) return;
    this.shopPanel.open(
      this.shopPanelViewFor(slot),
      (slotId) => this.transport.requestShopBuy(slotId),
      () => this.syncInputContext(),
    );
    this.syncInputContext();
  }

  private shopPanelViewFor(slot: ShopSlot) {
    return shopPanelView(this.world.shop!, slot, shopViewerOf(this.p), this.mods);
  }

  // Patch's-room upkeep, every tick: the handover pose timer, the one-time waystation
  // welcome label, and the open panel's honesty — it re-renders from authoritative state
  // (a teammate's claim flips it to SOLD mid-look) and closes when the world moves on
  // (floor changed, shop gone, buyer down, or the buyer displaced out of range).
  private tickShop(dt: number) {
    if (this.patchSellT > 0) this.patchSellT = Math.max(0, this.patchSellT - dt);
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
      this.spawnWorldLabel(shop.keeperX, shop.keeperY - 36, "PATCH'S WAYSTATION", "#ffd166");
      this.sfxAt("blessing", shop.keeperX, shop.keeperY, { gain: 0.3, rate: 1.15 });
    }
  }

  // The party blessing gate readout: which members still owe their pick (the descend holds
  // for them, authoritatively — snapshots carry the pending set). Null when nobody is owed
  // or when solo/classic (their gate is the local overlay itself). A pending member whose
  // connection dropped reads RECONNECTING (their offer survives the reconnect grace — the
  // coherence system, PR #39 — so "picking" would be a lie while they can't see the cards).
  private blessingWaitLabel(): string | null {
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
        ...this.coop.remotePlayers().map((r) => ({ name: r.name, isYou: false, color: playerColor(r.colorIndex), isDown: r.isDown, isOut: false, isAtExit: false, isReconnecting: false })),
      ];
    } else if (this.mode === "online" && this.wsTransport) {
      const exr = this.wsTransport.exitReadyParty();
      const selfId = this.wsTransport.getSelfServerId();
      const isSelfOut = this.wsTransport.getLatestSnapshot()?.self?.out === true;
      roster = [
        { name: "you", isYou: true, color: playerColor(this.selfColorIndex ?? 0), isDown: this.isDown, isOut: isSelfOut, isAtExit: selfId !== null && exr.includes(selfId), isReconnecting: false },
        ...this.wsTransport.remotePlayers().map((r) => ({
          name: r.name, isYou: false, color: playerColor(r.colorIndex), isDown: r.isDown, isOut: r.isOut,
          isAtExit: exr.includes(r.playerId), isReconnecting: isReconnectingTeammate(r),
        })),
      ];
    }
    this.hud.showStats({
      floor: this.floor, kills: this.kills, coins: this.coins,
      runTime: (performance.now() - this.runStart) / 1000,
      weaponName: WEAPONS[this.weapon].name,
      profile: this.profile,
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
    sfx("gameOver");
    this.hud.hideStats();
    this.hud.clear();
    this.hud.setVisible(false);
    this.onGameOver({
      floor: this.floor, kills: this.kills, coins: this.coins, durationMs: performance.now() - this.runStart,
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
  private isNearCamera(x: number, y: number, margin = 160): boolean {
    return x >= this.cam.x - margin && x <= this.cam.x + this.canvas.width + margin
      && y >= this.cam.y - margin && y <= this.cam.y + this.canvas.height + margin;
  }

  // Every particle enters through here so the pool stays capped: when full, the oldest
  // particle yields to the newest — a busy screen softens instead of dropping frames.
  private pushParticle(p: Particle) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  private spawnParticles(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
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
  private spawnSparks(x: number, y: number, n: number, angle: number) {
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() * 2 - 1) * 0.9, s = 160 + Math.random() * 220;
      const life = 0.12 + Math.random() * 0.16;
      this.pushParticle({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, color: Math.random() < 0.5 ? "#fff3c4" : "#ffb43b",
        size: 1 + Math.random() * 2, kind: "spark", rot: 0, vr: 0, gravity: 120, drag: 0.86,
      });
    }
  }

  // Soft colored haze — a bullet biting into flesh.
  private spawnPuff(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
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
    this.decals.push({ x, y, color, r, t: 0, life: kind === "ring" ? 0.4 : 3.2, kind });
    if (this.decals.length > MAX_DECALS) this.decals.shift();
  }

  // ---- rendering ----

  private render() {
    const { ctx, canvas } = this;
    if (this.isAwaitingOnlineWorld()) { this.renderConnectingVeil(); return; }
    ctx.fillStyle = this.currentBiome.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // trauma² shake, scaled by the player's intensity setting (zeroed under reduced
    // motion). New random offset per frame; the background fill above stays put so
    // edges never flash the void.
    const mag = this.trauma * this.trauma * SHAKE_MAX_PX * settings.effectiveShake;
    const shakeX = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    const shakeY = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    ctx.save();
    ctx.translate(shakeX + this.kickX, shakeY + this.kickY);
    this.renderTiles();
    if (this.isFlowDebug) this.renderFlowDebug();
    this.renderProps();
    this.renderDecals();
    this.renderFloorHazards(); // floor-level danger: over decals, under the ambient air + entities
    this.renderHazards(); // dynamic boss hazards (the Weaver's webs), over the floor layer
    this.motes.render(ctx, this.cam.x, this.cam.y); // ambient biome air, over the floor, under entities
    this.renderExit();
    this.renderShadows();
    this.renderPropEntities();
    this.renderShop();
    this.renderChests();
    this.renderPickups();
    this.renderParticles();
    this.shockwaves.render(ctx, this.cam.x, this.cam.y);
    this.renderCorpses();
    this.renderEnemies();
    this.renderBullets();
    this.renderTracers();
    this.renderRemotePlayers();
    this.renderAfterimages();
    this.renderMeleeSwing();
    this.renderPlayer();
    this.renderReviveRings();
    this.renderExitCoordination();
    this.renderMuzzle();
    this.renderDmgNumbers(); // world-space, on top of all entities but under the shake restore
    this.renderWorldLabels();
    ctx.restore();
    this.renderBiomeVignette();
    this.screenFlash.render(ctx, canvas.width, canvas.height);
    this.renderHurtVignette();
    this.renderDownOverlay();
    this.renderSpectateBanner();
    this.renderReticle();
    this.renderMinimap();
    this.renderReconnectOverlay();
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
      ctx.fillText("ENTERING THE DUNGEON\u2026", cx, cy);
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
    ctx.fillText("WAITING FOR PARTY\u2026", cx, top - 44);
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

  private renderTiles() {
    renderDungeonTiles(this.ctx, {
      dungeon: this.dungeon,
      biome: this.currentBiome,
      biomeIdx: this.biomeIdx,
      camX: this.cam.x,
      camY: this.cam.y,
      viewW: this.canvas.width,
      viewH: this.canvas.height,
      art: this.tiles,
      wallSide: this.wallSideGrads[this.biomeIdx],
      animClock: this.animClock,
    });
  }

  // ---- floor hazards ----
  // Every hazard renders its full cycle so danger is ALWAYS readable: a visible resting
  // body, an arming telegraph, and an unmistakable active burst. When authored art lands
  // in HAZARD_SOURCES the sheet replaces the body; the primitive fallback below speaks
  // the game's existing telegraph language (the boss-slam-marker family), so hazards are
  // fair on day one.
  private renderFloorHazards() {
    const hazards = this.world.floorHazards;
    if (hazards.length === 0) return;
    const { cam, tiles } = this;
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

  // Wall-mounted torches: an additive glow behind a 3-frame flickering flame. Culled
  // to the visible window; per-torch phase offset keeps them from flickering in sync.
  private renderProps() {
    const { ctx, cam, canvas, tiles } = this;
    const clock = this.animClock;
    const flame = TORCH_FRAMES[frameIndex(TORCH_FRAMES.length, 8, clock)];
    const hasGlow = tiles.ready("torch_glow");
    const hasFlame = tiles.ready(flame);
    if (!hasGlow && !hasFlame) return;
    // The light itself takes the biome's color (amber home fires, arcane violet, the
    // Fracture's cold crystal, the Null's wrong pink) — one authored glow, six moods.
    const glowImg = hasGlow ? (tiles.tinted("torch_glow", this.currentBiome.glow) ?? tiles.get("torch_glow")) : null;
    for (const t of this.torches) {
      const sx = t.tx * TILE - cam.x, sy = t.ty * TILE - cam.y;
      if (sx <= -TILE || sy <= -TILE || sx >= canvas.width || sy >= canvas.height) continue;
      if (glowImg) {
        const flick = 0.75 + 0.25 * Math.sin(clock * 11 + t.tx * 1.7 + t.ty * 0.9);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 * flick;
        ctx.drawImage(glowImg, sx + TILE / 2 - 48, sy + TILE / 2 - 48, 96, 96);
        ctx.restore();
      }
      if (hasFlame) ctx.drawImage(tiles.get(flame), sx, sy, TILE, TILE);
    }
  }

  private renderExit() {
    const { ctx, cam } = this;
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

  // Soft drop-shadow ellipses under everything so entities sit ON the floor, not float.
  // One cheap pass on the floor layer (before sprites) — dark, low-alpha, no per-entity cost.
  private shadow(cx: number, cy: number, w: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#05030b";
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.42, w * 0.18, 0, 0, 6.28);
    ctx.fill();
    ctx.restore();
  }

  private renderShadows() {
    const { cam } = this;
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
      const sx = p.x - this.cam.x, sy = p.y - this.cam.y;
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
  // torch glow composited additively — a mood + light-source prop, no new art.
  private renderBrazier(p: Prop, sx: number, sy: number, xf: Xform) {
    const { ctx, tiles } = this;
    this.drawPropImage("brazier", 0, sx, sy, PROP_DRAW, xf, 0);
    const clock = this.animClock;
    if (tiles.ready("torch_glow")) {
      const flick = 0.75 + 0.25 * Math.sin(clock * 11 + p.x * 0.03 + p.y * 0.02);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 * flick;
      ctx.drawImage(tiles.get("torch_glow"), sx - 48, sy - 52, 96, 96);
      ctx.restore();
    }
    const flame = TORCH_FRAMES[frameIndex(TORCH_FRAMES.length, 8, clock)];
    if (tiles.ready(flame)) ctx.drawImage(tiles.get(flame), sx - TILE / 2, sy - TILE / 2 - 14, TILE, TILE);
  }

  private renderChests() {
    if (this.chests.length === 0) return;
    const { ctx, cam } = this;
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
      const count = Math.max(1, Math.round(sheet.img.naturalWidth / fw));
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

  // ---- Patch's waystation ----
  // Every station renders from its authoritative slot. The ART hooks (patch sprite +
  // patch_stall / shop_pedestal / shop_heart_station / shop_reroll_post) take over piece
  // by piece the moment approved PNGs land; until then each is a clean flat primitive
  // that claims no final art. Walking near a station HIGHLIGHTS it (ring + prompt) — a
  // purchase only ever leaves through the panel's BUY.
  private renderShop() {
    const shop = this.world.shop;
    if (!shop) return;
    const { cam } = this;
    if (this.isNearCamera(shop.keeperX, shop.keeperY, 140)) {
      this.drawShopStall(shop.keeperX - cam.x, shop.keeperY - cam.y);
      this.drawPatch(shop.keeperX - cam.x, shop.keeperY - cam.y - 22);
    }
    const viewer = shopViewerOf(this.p);
    const focused = this.focusedShopSlot();
    for (const slot of shop.slots) {
      if (!this.isNearCamera(slot.x, slot.y, TILE * 2)) continue;
      this.drawShopStation(shop, slot, viewer, focused !== null && focused.id === slot.id);
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

  private drawShopStation(shop: NonNullable<WorldState["shop"]>, slot: ShopSlot, viewer: ReturnType<typeof shopViewerOf>, isFocused: boolean) {
    const { ctx, cam } = this;
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
    // claimed shared weapon is gone for everyone; a personal slot empties only for the
    // viewer who bought theirs.
    const isEmptied = slot.isShared ? slot.kind === "weapon" && slot.soldTo !== null : status === "sold";
    if (!isEmptied) {
      const bob = Math.sin(this.animClock * 2.4 + slot.id * 1.7) * 2;
      this.drawShopMerch(slot, sx, sy - 24 + bob);
    }
    const color = status === "buy" ? "#ffd27a" : status === "broke" ? "#ff8a7a" : "#9a8fb5";
    this.drawShopText(shopChipCopy(status, slot.price), sx, sy + 15, color);
  }

  private drawShopMerch(slot: ShopSlot, sx: number, sy: number) {
    const { ctx } = this;
    if (slot.kind === "weapon" && slot.weapon !== null) {
      const img = this.sprites.weaponPickup(slot.weapon);
      if (img) { ctx.drawImage(img, sx - 17, sy - 17, 34, 34); return; }
      if (this.sprites.ready("gun")) { ctx.drawImage(this.sprites.get("gun"), sx - 14, sy - 14, 28, 28); return; }
    }
    if (slot.kind === "heart" && this.sprites.ready("heart")) {
      ctx.drawImage(this.sprites.get("heart"), sx - 13, sy - 13, 26, 26);
      return;
    }
    if (slot.kind === "blessing") {
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
    const { ctx, cam } = this;
    for (const p of this.pickups) {
      const clock = this.animForPickup(p).clock;
      const sx = p.x - cam.x, sy = p.y - cam.y + Math.sin(clock * 3) * 3 - 2;
      const name: SpriteName = p.kind === "weapon" ? "gun" : p.kind;
      ctx.save();
      ctx.globalAlpha = 0.3 + Math.abs(Math.sin(clock * 3)) * 0.15;
      const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, 20);
      g.addColorStop(0, p.kind === "heart" ? "#ff6a6a" : p.kind === "coin" ? "#ffd27a" : "#ffb43b");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, 20, 0, 6.28); ctx.fill();
      ctx.restore();
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
    }
  }

  private renderCorpses() {
    const { ctx, cam } = this;
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
    const { ctx, cam } = this;
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
    const { ctx, cam } = this;
    for (const p of this.particles) {
      const a = p.life / p.maxLife;
      if (a <= 0) continue;
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
    const { ctx, cam } = this;
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
    const { ctx, cam } = this;
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

  private renderDecals() {
    const { ctx, cam } = this;
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
    const { ctx, cam } = this;
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
      // The Weaver airborne: no body to shoot — just the falling shadow on its landing mark.
      if (e.kind === "weaver" && a.move === "pounce" && a.phase === "active") {
        this.renderDangerDisc(a.markX, a.markY, WEAVER.pounceRadius, 1);
        this.renderPounceShadow(a.markX, a.markY, drawSize, a.windup);
        continue;
      }

      // Ground danger marker for the boss hop-slam (drawn under everything).
      if (isHopSlam && (isWindup || a.phase === "active")) this.renderSlamMarker(e);
      // The shrinking safe-ring of the boss arena squeeze.
      if (e.kind === "boss" && a.move === "squeeze") this.renderSqueeze(e);
      // MARROW's transition shield bubble (the interactive beat: kill the husks).
      if (e.kind === "marrow" && a.move === "shield" && isWindup) this.renderMarrowShield(e, sx, sy, drawSize);
      // The Weaver's pounce marker while it coils; the Warden's quake ring while it winds.
      if (e.kind === "weaver" && a.move === "pounce" && isWindup) this.renderDangerDisc(a.markX, a.markY, WEAVER.pounceRadius, a.windup);
      if (e.kind === "gilded" && a.move === "slam" && (isWindup || a.phase === "active")) {
        this.renderDangerDisc(a.markX, a.markY, GILDED.slamRadius, a.phase === "active" ? 1 : a.windup);
      }
      // Brutes/elites carry a colored ground ring so the tier reads before the first hit.
      const ring = TIER_RING_COLOR[e.tier];
      if (ring) this.renderTierRing(sx, sy, drawSize, ring);

      // Ghost solidify reads as an opacity ramp; the Choir mid-fade is barely there;
      // everyone else uses the archetype alpha.
      const alpha = e.kind === "ghost" ? 0.62 + 0.38 * a.windup
        : e.kind === "choir" && a.move === "fade" && a.phase === "active" ? 0.3
        : arch.alpha;

      // The AD drop-in ladder: attack_<facing> -> attack -> walk_<facing> -> legacy
      // walk/idle -> static + procedural (see facing.ts). New directional/attack sheets
      // light up per sprite with zero further render changes.
      const choice = this.sprites.selectClip(arch.sprite, pose);
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
      // A white pulse on the sprite intensifies as the windup nears release.
      const pulse = 0.55 + 0.45 * Math.sin(anim.clock * 13);
      const telegraphFlash = isWindup ? a.windup * pulse * 0.85 : 0;
      this.drawChar(arch.sprite, choice.clip, sx, sy, drawSize, facing, xf, extra, alpha, Math.max(anim.flash, telegraphFlash), anim.clock, null, choice.isHoldFirstFrame);

      // Elemental status overlays (burn ember glow / chill frost / freeze crust / shock crackle).
      if (e.burn > 0 || e.chill > 0 || e.shock > 0) this.renderEnemyStatus(e, sx, sy, drawSize);

      // The shielder's guard arc — drawn from the sim's authoritative block angle.
      if (e.kind === "shielder") this.renderShielderGuard(e, sx, sy, drawSize);
      // The Warden's plate: a gold sheen while closed, a cracked-open core glow while EXPOSED.
      if (e.kind === "gilded") this.renderGildedPlate(e, sx, sy, drawSize);

      // Shimmer flecks while a ghost is materializing.
      if (e.kind === "ghost" && a.windup > 0.05 && a.windup < 0.98) this.renderGhostShimmer(e, sx, sy);
      // The Choir mid-fade shimmers like its wisp kin (intangible — hold your fire).
      if (e.kind === "choir" && a.move === "fade" && a.phase === "active") this.renderGhostShimmer(e, sx, sy);
      // Aura + aim line for a charging attack.
      if (isWindup) this.renderTelegraph(e, sx, sy);

      const barW = isBoss ? 64 : 32;
      const barY = sy - drawSize / 2 - 8;
      ctx.fillStyle = "#000"; ctx.fillRect(sx - barW / 2, barY, barW, 4);
      ctx.fillStyle = isBoss ? "#ffb43b" : "#ff5a5a";
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, e.hp / e.maxHp), 4);
    }
  }

  // The Weaver's webs: violet ground lattices (spokes + rings) that fade with their life.
  // Ground FX like the danger markers — the hazard itself is authoritative sim state.
  private renderHazards() {
    if (this.hazards.length === 0) return;
    const { ctx, cam } = this;
    ctx.save();
    for (const h of this.hazards) {
      const sx = h.x - cam.x, sy = h.y - cam.y;
      const fade = Math.min(1, h.life / Math.max(0.001, h.maxLife) * 3); // holds, then fades out
      ctx.globalAlpha = 0.34 * fade;
      ctx.strokeStyle = "#c98bff";
      ctx.lineWidth = 1.5;
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
      ctx.globalAlpha = 0.1 * fade;
      ctx.fillStyle = "#c98bff";
      ctx.beginPath(); ctx.arc(sx, sy, h.radius, 0, 6.28); ctx.fill();
    }
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
  private renderDangerDisc(x: number, y: number, radius: number, grow: number) {
    const { ctx, cam } = this;
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
    const { ctx, cam } = this;
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

  // The Warden's plate state: sealed = a cool gold rim (your shots are chipping); exposed
  // = the plate hangs open and the amber core blazes — unload.
  private renderGildedPlate(e: Enemy, sx: number, sy: number, size: number) {
    const { ctx } = this;
    const a = e.attack;
    const isExposed = a.phase === "recover" && (a.move === "slam" || a.move === "sweep");
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
    const { ctx, cam } = this;
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

    if (a.move === "lunge" || a.move === "spit" || a.move === "rush" || a.move === "volley") {
      // Line commitments draw their whole lane: the rush lengths match the sim's actual
      // travel, so where the line ends is where the rusher stops (or crashes).
      const len = a.move === "lunge" ? 150
        : a.move === "spit" ? 300
        : a.move === "volley" ? 260
        : e.kind === "marrow" ? MARROW.chargeSpeed * MARROW.chargeDur
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

  // The boss hop-slam's growing footprint: a filled danger disc + bright rim. It tracks
  // the target while charging, then freezes at aim-lock so you can simply walk off it.
  private renderSlamMarker(e: Enemy) {
    const { ctx, cam } = this;
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

  private renderBullets() {
    const { ctx, cam } = this;
    for (const b of this.bullets) {
      const bx = b.x - cam.x, by = b.y - cam.y;
      if (b.friendly) {
        // Layered additive sprite FX per weapon; falls back to the plain circle if the
        // recipe's core sprite hasn't loaded yet, so a bullet always renders.
        if (b.fx && this.drawBulletFx(b, bx, by)) continue;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, b.radius, 0, 6.28); ctx.fill();
      } else {
        // Enemy fire: a soft danger halo behind a bright hot core, in its own hue.
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, b.radius * 1.9, 0, 6.28); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, b.radius, 0, 6.28); ctx.fill();
        ctx.fillStyle = "#fff6f0";
        ctx.beginPath(); ctx.arc(bx, by, b.radius * 0.42, 0, 6.28); ctx.fill();
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
      case "beam":
        // The lance: rounds so fast and frequent the long streaks fuse into one continuous
        // line of light. The dedicated code-tinted white ray mask (AD final) carries it;
        // the generic streak keeps the beam reading until that mask lands.
        this.fxLayer("glow_round", color, bx, by, R * 5, R * 5, 0.4, 0);
        if (!this.fxTrail("beam_ray", color, bx, by, Math.max(trailLen, R * 14), R * 3, 0.9, angle)) {
          this.fxTrail("trail_streak", color, bx, by, Math.max(trailLen, R * 14), R * 2.4, 0.85, angle);
        }
        return this.fxLayer("core_dot", "#fff7dd", bx, by, R * 2, R * 2, 1, 0);
      default:
        return false;
    }
  }

  private renderTracers() {
    const { ctx, cam } = this;
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
      ctx.globalAlpha = Math.max(0, tr.life / 0.12) * 0.8;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(tr.angle) * len, y + Math.sin(tr.angle) * len);
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderRemotePlayers() {
    const remotes = this.remotes();
    if (remotes.length === 0) return;
    const { ctx, cam } = this;
    for (const r of remotes) {
      const sx = r.x - cam.x, sy = r.y - cam.y;
      const color = playerColor(r.colorIndex);
      const tinted = this.sprites.tintedHero(color);
      const entry = this.remoteAnims.get(r.playerId);
      const xf = entry ? characterXform(entry.anim, CHARACTER_STYLE) : IDENTITY_XFORM;
      ctx.save();
      // A network-absent teammate renders as an explicit ghost (their body is reserved for
      // the reconnect grace) — never mistakable for a live player or a corpse.
      ctx.globalAlpha = r.isAbsent ? 0.35 : r.isDown ? 0.4 : 1;
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

      if (!r.isDown && !r.isAbsent) {
        if (WEAPONS[r.weapon].melee) this.renderHeldMelee(sx, sy, r.aimAngle, r.weapon, 1, null);
        else this.renderHeldWeapon(sx, sy, r.aimAngle, r.weapon, 1);
      }

      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.globalAlpha = r.isAbsent ? 0.8 : 1;
      ctx.fillText(r.isAbsent ? `${r.name} (reconnecting\u2026)` : r.isDown ? `${r.name} (down)` : r.name, sx, sy - 32);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
  }

  // The chosen identity tint for the local blob, or null for the natural amber sprite
  // (palette slot 0 IS the sprite's own coloring, so it never re-tints).
  private selfTint(): string | null {
    return this.selfColorIndex !== null && this.selfColorIndex > 0 ? playerColor(this.selfColorIndex) : null;
  }

  private renderPlayer() {
    const { ctx, cam } = this;
    // Interpolate the render position between the last two sim steps for smooth motion.
    const a = this.hasRenderPrev ? this.renderAlpha : 1;
    const ipx = this.renderPrevX + (this.px - this.renderPrevX) * a;
    const ipy = this.renderPrevY + (this.py - this.renderPrevY) * a;
    const psx = ipx - cam.x, psy = ipy - cam.y;
    let alpha = 1;
    if (this.isDown) alpha = 0.4;
    else if (this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0) alpha = 0.4;
    const clip: SheetClip = this.playerAnim.move > 0.5 ? "walk" : "idle";
    const xf = characterXform(this.playerAnim, CHARACTER_STYLE);
    // Directional recoil: nudge the blob back against its aim as it fires.
    const rec = this.playerAnim.recoil;
    xf.ox += -Math.cos(this.aimAngle) * rec * 4;
    xf.oy += -Math.sin(this.aimAngle) * rec * 4;
    this.drawChar("hero", clip, psx, psy, 52, this.facing, xf, 1, alpha, this.playerAnim.flash, this.playerAnim.clock, this.selfTint());
    if (!this.isDown) {
      // Anchor the held weapon to the blob's VISUAL body offset (lean/bob/hop + recoil nudge)
      // so the gun stays glued to the body while moving. The bullet/muzzle ORIGIN stays at the
      // true sim center (psx/psy) — the weapon art is cosmetic and just follows the body.
      const bx = psx + xf.ox, by = psy + xf.oy;
      if (WEAPONS[this.weapon].melee) this.renderHeldMelee(bx, by, this.aimAngle, this.weapon, alpha, this.meleeSwing);
      else this.renderHeldWeapon(bx, by, this.aimAngle, this.weapon, alpha, this.playerAnim.recoil);
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
    const { ctx, cam } = this;
    const drawStandRing = (sx: number, sy: number) => {
      ctx.save();
      ctx.globalAlpha = 0.22 + 0.08 * Math.sin(this.animClock * 3);
      ctx.strokeStyle = "#8affc0";
      ctx.lineWidth = 2;
      ctx.setLineDash(AIM_DASH);
      ctx.beginPath();
      ctx.arc(sx, sy, REVIVE.radius, 0, 6.28);
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
      if (!this.isDown) drawStandRing(sx, sy);
      if (r.reviveProgress > 0) drawProgress(sx, sy, r.reviveProgress / REVIVE.channel);
    }
    // The local downed body: the authoritative channel a teammate holds on us.
    if (this.isDown && this.p.reviveProgress > 0) {
      const a = this.hasRenderPrev ? this.renderAlpha : 1;
      const sx = this.renderPrevX + (this.px - this.renderPrevX) * a - cam.x;
      const sy = this.renderPrevY + (this.py - this.renderPrevY) * a - cam.y;
      drawProgress(sx, sy, this.p.reviveProgress / REVIVE.channel);
      label(sx, sy, "A TEAMMATE IS REVIVING YOU\u2026", "#8affc0");
    }
  }

  // World-space party exit coordination, shown only while the descend gate is actually
  // waiting on someone: a pulsing chevron from the local player toward the STAIRS while
  // teammates stand staged there, and — once staged yourself — chevrons toward each living
  // teammate the gate still needs. Pure reads of the authoritative exr; nothing sim-side.
  private renderExitCoordination() {
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
      const { ctx, cam } = this;
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
    const reviver = this.remotes().find((r) => !r.isDown && !isReconnectingTeammate(r)
      && Math.hypot(r.x - this.px, r.y - this.py) <= REVIVE.radius);
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
      const sx = mate.x - this.cam.x, sy = mate.y - this.cam.y;
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
  // held sprite always agree, at any framerate, with zero retained state.
  private renderMeleeSwing() {
    const swing = this.meleeSwing;
    if (!swing || swing.timer <= 0) return;
    const t = 1 - swing.timer / swing.duration;
    if (swing.isThrust) this.renderThrustFx(swing, t);
    else this.renderSlashArc(swing, t);
  }

  private renderSlashArc(swing: MeleeSwing, t: number) {
    const { ctx, cam } = this;
    const sx = this.px - cam.x;
    const sy = this.py - cam.y;
    const inner = 12;
    const outer = swing.reach * (0.9 + 0.1 * Math.sin(t * Math.PI));
    const SEGS = 10;
    const fadeOut = 1 - t * t; // the whole crescent dissolves as the swing settles
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(sx, sy);
    ctx.fillStyle = swing.color;
    // The full swept crescent so far (swing start -> blade), brightest at the blade and
    // fading toward the tail — a real slash arc, not a momentary sliver.
    for (let i = 0; i < SEGS; i++) {
      const s0 = i / SEGS, s1 = (i + 1) / SEGS; // 0 = tail (swing start), 1 = head (blade)
      const a0 = this.swingBladeAngle(swing, t * s0);
      const a1 = this.swingBladeAngle(swing, t * s1);
      if (Math.abs(a1 - a0) < 0.002) continue;
      ctx.globalAlpha = 0.5 * Math.pow(s1, 1.4) * fadeOut;
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
    ctx.globalAlpha = 0.6 * fadeOut;
    ctx.strokeStyle = swing.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(hx * inner, hy * inner);
    ctx.lineTo(hx * outer, hy * outer);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * fadeOut;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx * (inner + 4), hy * (inner + 4));
    ctx.lineTo(hx * (outer - 2), hy * (outer - 2));
    ctx.stroke();
    ctx.restore();
  }

  private renderThrustFx(swing: MeleeSwing, t: number) {
    const { ctx, cam } = this;
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
    if (ext > 0.65) this.fxLayer("spark", "#ffffff", headX, headY, 18, 18, (ext - 0.65) * 2.4, swing.aim);
  }

  // The equipped gun, drawn over the hero and rotated to aim. Held sprites are authored
  // 40px with the gun centered in the file, pointing +X; the vertical flip past |aim| >
  // 90deg keeps the barrel horizontal (not upside-down) when aiming left. The sprite
  // center sits at the muzzle-flash anchor distance (18px out along aim), pulled in
  // slightly on fire by recoil. Weapons without art fall back to the pistol overlay; if
  // even that isn't loaded yet it simply draws nothing. Melee never comes through here —
  // blades have their own aim-tracking, arc-sweeping path (renderHeldMelee).
  private renderHeldWeapon(cx: number, cy: number, aim: number, weapon: WeaponId, alpha: number, recoil = 0) {
    const img = this.sprites.heldWeapon(weapon) ?? this.sprites.heldWeapon("pistol");
    if (!img) return;
    const { ctx } = this;
    const anchor = 18 - recoil * 3;
    const d = 40 * 0.6; // ~24px over the ~44px blob
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx + Math.cos(aim) * anchor, cy + Math.sin(aim) * anchor);
    ctx.rotate(aim);
    if (Math.abs(aim) > Math.PI / 2) ctx.scale(1, -1);
    ctx.drawImage(img, -d / 2, -d / 2, d, d);
    ctx.restore();
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
    const { ctx, cam } = this;
    const isReady = this.sprites.ready("hero");
    const tint = this.selfTint();
    const heroImg = tint ? this.sprites.tintedSprite("hero", tint) ?? this.sprites.get("hero") : this.sprites.get("hero");
    for (const a of this.afterimages) {
      const k = 1 - a.t; // 1..0
      ctx.save();
      ctx.globalAlpha = k * 0.4;
      ctx.translate(a.x - cam.x, a.y - cam.y);
      ctx.scale(a.facing, 1);
      if (isReady) ctx.drawImage(heroImg, -26, -26, 52, 52);
      else { ctx.fillStyle = "#ffd27a"; ctx.beginPath(); ctx.arc(0, 0, this.pr, 0, 6.28); ctx.fill(); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // A proper crosshair (ring + four tick marks + center dot) rather than a bare circle,
  // so the aim point reads clearly against a busy floor. Screen-space, drawn last.
  private renderReticle() {
    const { ctx } = this;
    const cx = this.input.mouseX, cy = this.input.mouseY;
    const r = 8, tick = 4, gap = 3;
    ctx.save();
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
    for (const r of this.remotes()) dots.push({ x: r.x, y: r.y, color: playerColor(r.colorIndex), size: 2.5 });
    this.minimap.render({
      dungeon: this.dungeon,
      playerX: this.px, playerY: this.py,
      exit: this.dungeon.exit,
      isCleared: isFloorCleared(this.world),
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

  devSpawnProp(kind: PropKind, atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    devSpawnProp(this.world, kind, p.x, p.y);
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

  devToggleFlowDebug(): boolean {
    this.isFlowDebug = !this.isFlowDebug;
    return this.isFlowDebug;
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

  devSnapshot(): DevSnapshot {
    return {
      fps: this.fps,
      floor: this.floor,
      hp: this.hp,
      maxHp: this.maxHp,
      weapon: this.weapon,
      isGodMode: this.isGodMode,
      isFlowDebug: this.isFlowDebug,
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
    const { ctx, cam, canvas } = this;
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
