import type { Dungeon } from "../sim/dungeon.js";
import { TILE } from "../sim/types.js";
import type { Enemy, EnemyKind, Bullet, Particle, DmgNumber, Pickup, WeaponId, AttackMove, Prop, PropKind, Chest, RemotePlayer, Hazard, HazardKind } from "../sim/types.js";
import { hazardPhaseAt, hazardPhaseFrac, RIFT_PULL_RADIUS } from "../sim/hazards.js";
import type { HazardPhase } from "../sim/hazards.js";
import { Rng, randomSeed } from "../sim/rng.js";
import { Sprites, TileSet, playerColor, FRAME } from "./assets.js";
import type { SpriteName, SheetClip, TileName, FxName, PropSpriteName } from "./assets.js";
import { ENEMY_ARCHETYPES, isBossFloor } from "../sim/enemies.js";
import { WEAPONS } from "../sim/weapons.js";
import { rollItemChoicesWith, itemById, itemDesc, itemLevelsOf } from "../sim/items.js";
import type { PlayerMods, ItemDef } from "../sim/items.js";
import { PLAYER, REVIVE, BOSS, TIERS } from "../sim/balance.js";
import type { EnemyTier } from "../sim/balance.js";
import { LocalTransport } from "../client/transport.js";
import type { Transport } from "../client/transport.js";
import { WSTransport } from "../client/wsTransport.js";
import { STAGE_B_SEED, STAGE_B_FLOOR } from "../net/protocol.js";
import { applyItemToWorld, chooseBlessingInWorld, dismissBlessingOfferInWorld, applyMaxHpBonus, loadFloorIntoWorld, descend, devSpawnEnemy, devSpawnProp, devSpawnChest, equipWeaponInWorld, acquireWeaponInWorld, isFloorCleared } from "../sim/world.js";
import type { WorldState, PlayerSim, MeleeSwing, RemoteTarget } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import { comboTierFor } from "../sim/constants.js";
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
import { audio, sfx } from "./audio.js";
import type { SfxName, SfxOptions } from "./audio.js";
import { ShockwaveField, ScreenFlash, AmbienceField } from "./vfx.js";
import { settings } from "./settings.js";
import { PauseOverlay } from "../ui/pause.js";
import { BlessingOverlay } from "../ui/blessing.js";
import { BIOMES, biomeForFloor, biomeIndexForFloor, floorBannerText } from "../sim/biomes.js";
import type { Biome } from "../sim/biomes.js";

export interface RunResult { floor: number; kills: number; coins: number; durationMs: number; }

// Why a run exited without a game over: the player quit, or an online connection never came
// up (lets the menu land back on the lobby with an explanation instead of silence).
export type ExitReason = "quit" | "connect_failed";

// Online (authoritative WS) start config. Solo/co-op are unchanged; online is opt-in behind
// explicit config and routes through WSTransport instead of LocalTransport.
export interface OnlineOptions {
  url: string;
  getTicket: () => Promise<string>;
  // The lobby room code this run belongs to (shown in the HUD so friends can be invited
  // mid-run); null for direct dev joins.
  roomCode: string | null;
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
// Floor stains + drop pulses that linger for a beat after the action moves on.
interface Decal { x: number; y: number; color: string; r: number; t: number; life: number; kind: "splat" | "ring"; }
// A fading ghost of the hero left along a dash so it reads as motion, not a teleport.
interface Afterimage { x: number; y: number; facing: number; t: number; }

const MAX_DECALS = 48;
const AFTERIMAGE_DUR = 0.28; // seconds a dash afterimage takes to fade out

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

// Extruded-block wall look (Soul Knight): a lit top cap, a dark front face where the
// tile below is floor, plus mid-dark side strips on exposed left/right edges so a wall
// reads as a 3D cube rather than a flat cap. Tones step cap -> front -> side, darkening
// toward the world floor. Side strips are precomputed gradients (built once) that fade
// inward; corners where two faces meet get an extra darken so the cube edge reads.
const WALL_SIDE_W = 7;        // px width of an exposed side face
const WALL_SIDE_ALPHA = 0.62; // side-strip darkness at the edge


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
  sawnoff: 0.6, railgun: 0.4, nailer: 0.06, flamer: 0.04,
  sword: 0.08, longsword: 0.16, spear: 0.07,
};
// Per-weapon feel: recoil punch (sprite scale kick), camera kick (px, back along aim),
// and knockback (px the weapon shoves the player). The hand cannon is the beefy end.
const FIRE_RECOIL: Record<WeaponId, number> = {
  pistol: 1, shotgun: 1.4, rapid: 0.6,
  smg: 0.5, cannon: 1.6, burst: 0.9, ricochet: 1, homing: 0.4, tesla: 0.7,
  sawnoff: 1.6, railgun: 1.5, nailer: 0.6, flamer: 0.3,
  sword: 0.7, longsword: 1.1, spear: 0.6,
};
const FIRE_KICK: Record<WeaponId, number> = {
  pistol: 3, shotgun: 8, rapid: 1.2,
  smg: 1, cannon: 10, burst: 2, ricochet: 3, homing: 0.5, tesla: 1.5,
  sawnoff: 11, railgun: 6, nailer: 1.2, flamer: 0.5,
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
};

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
// Subtle idle bob/flash for props + chests — a fraction of the character juice so a crate
// reads as a solid object, not a jelly.
const PROP_STYLE: XformStyle = { freq: 2.1, bob: 0.7, squash: 0.03, hop: 0, lean: 0 };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---- hazard render tables (see renderHazards) ----
// Spike socket centers within the 48px tile (a 2x2 trap plate).
const SPIKE_SOCKETS: ReadonlyArray<[number, number]> = [[14, 15], [34, 15], [14, 35], [34, 35]];
// Toxic-pool liquid palette per biome band (murk in the Caves, venom resin in the Deep,
// cold glass in the Fracture, anti-light in the Null).
interface PoolStyle { base: string; edge: string; sheen: string }
const POOL_STYLES: readonly PoolStyle[] = [
  { base: "#14301e", edge: "#3fbf5f", sheen: "#8fffa8" },
  { base: "#12262e", edge: "#2a5a6a", sheen: "#57b6ff" },
  { base: "#1a3a26", edge: "#3fbf5f", sheen: "#8fffa8" },
  { base: "#20140e", edge: "#7a3d12", sheen: "#ffb43b" },
  { base: "#0c2e2e", edge: "#1fa89a", sheen: "#6ff0d8" },
  { base: "#220c26", edge: "#6a2fb0", sheen: "#ff4ad8" },
];
// Hazard impact tint for the hazardHit event juice.
const HAZARD_HIT_TINT: Record<HazardKind, string> = {
  spikes: "#c9c9de", toxic_pool: "#3fbf5f", fire_vent: "#ff8a3b", void_rift: "#d9a6ff",
};

// Stable per-tile hash -> 0..1. Salted so different features (variant vs. detail) draw
// from independent streams, and identical every frame so tiles never shimmer.
function tileHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Pick a floor variant from a stable hash: mostly plain floor, others sprinkled in.
function floorVariant(r: number): TileName {
  if (r < 0.7) return "floor";
  if (r < 0.8) return "floor2";
  if (r < 0.9) return "floor3";
  return "floor4";
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private sprites = new Sprites();
  private tiles = new TileSet();
  private minimap: Minimap;
  private hud: Hud;
  private onGameOver: (result: RunResult) => void;
  private onExit: (reason?: ExitReason) => void;
  private pause: PauseOverlay;
  private blessing: BlessingOverlay;
  private isPaused = false;
  private isChoosing = false; // a between-floor blessing overlay is up (freezes the sim)
  // Online: whether the first authoritative snapshot has revealed the real world yet. Until
  // then the run sits behind a connecting veil (the local world is a placeholder).
  private isWorldRevealed = false;

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
  private isAutoFiring = false; // autofire mode only: click toggles continuous fire (settings.isAutofire)
  private selfColorIndex: number | null = null; // chosen blob tint (solo + online); null/0 = natural amber
  private onlineRoomCode: string | null = null; // lobby room code for the HUD label (online only)

  private particles: Particle[] = [];
  private dmgNumbers: DmgNumber[] = [];  // floating damage popups (visual only)
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
  private hazardPhases = new Map<number, HazardPhase>();
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
  private enemyFacing = new Map<number, number>(); // stable L/R facing (velocity-driven + deadzone) to kill mirror-flicker
  private propAnims = new Map<number, Anim>();
  // Keyed by the sim's stable per-floor id (like enemies/props): online rebuilds pickup/chest
  // objects from each snapshot, so object-identity keying would reset the idle anim 20x/s.
  private pickupAnims = new Map<number, Anim>();
  private chestAnims = new Map<number, Anim>();

  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, isDown: false };
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
  private wallSideGrads: [CanvasGradient, CanvasGradient][] = [];
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

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, hudRoot: HTMLElement, onGameOver: (result: RunResult) => void, onExit: (reason?: ExitReason) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.minimap = new Minimap(minimapCanvas);
    this.hud = new Hud(hudRoot);
    this.onGameOver = onGameOver;
    this.onExit = onExit;
    this.pause = new PauseOverlay(() => this.setPaused(false), () => this.quitToMenu());
    this.blessing = new BlessingOverlay();
    this.buildWallGradients();
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  // Precompute per-biome side-face gradients once (no per-frame allocation).
  private buildWallGradients() {
    this.wallSideGrads = BIOMES.map((biome) => {
      const edge = `rgba(${biome.wallSideRgb},${WALL_SIDE_ALPHA})`;
      const inner = `rgba(${biome.wallSideRgb},0)`;
      const left = this.ctx.createLinearGradient(0, 0, WALL_SIDE_W, 0);
      left.addColorStop(0, edge);
      left.addColorStop(1, inner);
      const right = this.ctx.createLinearGradient(0, 0, WALL_SIDE_W, 0);
      right.addColorStop(0, inner);
      right.addColorStop(1, edge);
      return [left, right] as [CanvasGradient, CanvasGradient];
    });
  }

  private resize() {
    // Fill the whole viewport (camera-follow world, so more screen = more visible area).
    // Cap at a sane max so a huge monitor doesn't blow out fill-rate, but no letterbox.
    this.canvas.width = Math.min(window.innerWidth, 2560);
    this.canvas.height = Math.min(window.innerHeight, 1440);
  }

  private bindInput() {
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "escape") {
        e.preventDefault();
        if (!this.keys.has("escape")) this.togglePause(); // ignore key auto-repeat
        this.keys.add(k);
        return;
      }
      this.keys.add(k);
      if ([" ", "shift", "tab"].includes(k)) e.preventDefault();
      if (k === "tab" && !this.isStatsHeld) { this.isStatsHeld = true; this.openStats(); }
      // Weapon switch: number keys 1-9 select that inventory slot directly.
      if (k >= "1" && k <= "9") { const i = parseInt(k, 10) - 1; if (this.isRunning) this.selectWeapon(i); }
      if (k === "q") this.cycleWeapon(-1); // Q cycles back a slot
    });
    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === "tab") { this.isStatsHeld = false; this.hud.hideStats(); }
    });
    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.isRunning) this.cycleWeapon(e.deltaY > 0 ? 1 : -1); // scroll to cycle weapons
    }, { passive: false });
    this.canvas.addEventListener("mousedown", (e) => {
      this.mouse.isDown = true;
      // Autofire: a left-click toggles continuous fire instead of requiring a hold.
      if (settings.isAutofire && !this.isDown && e.button === 0) this.isAutoFiring = !this.isAutoFiring;
    });
    window.addEventListener("mouseup", () => (this.mouse.isDown = false));
  }

  start(opts: StartOptions) {
    this.mode = opts.mode;
    this.coop = opts.coop ?? null;
    this.profile = opts.profile ?? null;
    // The chosen blob tint applies to solo + online (classic co-op keeps assigned colors).
    this.selfColorIndex = this.mode === "coop" ? null : opts.selfColorIndex ?? null;
    this.onlineRoomCode = opts.online?.roomCode ?? null;
    let floor: number;
    if (this.mode === "online" && opts.online) {
      // Online: the SERVER owns the world (seed/floor/dungeon). WSTransport boots a placeholder
      // world for pre-join prediction; the first snapshot's authoritative seed/floor/rev rebuilds
      // it (consumeWorldRebuilt below refreshes the cosmetic floor state to match). A transport
      // terminal state (closed/error) while running ends the run — never a stranded session.
      this.wsTransport = new WSTransport({
        url: opts.online.url,
        getTicket: opts.online.getTicket,
        onStatus: (s) => this.onOnlineStatus(s),
      });
      this.seed = STAGE_B_SEED;
      floor = STAGE_B_FLOOR;
      this.transport.start(this.seed, floor, { isSandbox: true, isCoop: false });
    } else {
      this.wsTransport = null;
      floor = this.coop ? this.coop.getFloor() : 1;
      this.seed = this.coop ? this.coop.getSeed() : randomSeed();
      this.transport.start(this.seed, floor, { isSandbox: this.isSandbox, isCoop: this.coop !== null });
    }
    this.world = this.transport.poll().state;
    this.inputSeq = 0;
    this.blessingRng = new Rng(this.seed ^ 0x0b1e55);
    this.ownedItemDefs = [];
    this.isAutoFiring = false;
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
    this.pendingDescend = 0;
    this.pause.hide();
    this.blessing.hide();
    audio.unlock();
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
      this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
    }
    this.hud.setVisible(true);
    // First run ever: briefly surface the core controls, then never nag again.
    if (!settings.isControlsHintSeen) {
      this.hud.showControlsHint();
      settings.markControlsHintSeen();
    }
    this.isRunning = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.isRunning = false;
    this.transport.stop();
    cancelAnimationFrame(this.raf);
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
    this.hazardVisClock = this.world.hazardClock;
    this.poolTiles.clear();
    for (const h of this.world.hazards) {
      if (h.kind === "toxic_pool") this.poolTiles.add(h.ty * this.dungeon.w + h.tx);
    }
    this.lastPx = this.px;
    this.lastPy = this.py;
    this.torches = this.placeTorches(this.dungeon);
    this.particles = [];
    this.dmgNumbers = [];
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
    // overlay, run no sim. Reuses the exact freeze path co-op already tolerates.
    if (this.isPaused || this.isChoosing) {
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
    if (paused) {
      this.mouse.isDown = false; // don't let a held click fire on resume
      this.pause.show();
    } else {
      this.pause.hide();
      this.last = performance.now(); // avoid a huge catch-up dt after the pause
    }
  }

  private quitToMenu(reason?: ExitReason) {
    this.setPaused(false);
    this.stop();
    audio.setMusic(null);
    this.hud.hideStats();
    this.hud.clear();
    this.onExit(reason);
  }

  private addFreeze(seconds: number) {
    this.freeze = Math.min(FREEZE_MAX, Math.max(this.freeze, seconds));
  }

  private addTrauma(amount: number) {
    const t = this.trauma + amount;
    this.trauma = t > 1 ? 1 : t;
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

  // Online, before the first authoritative snapshot: the local world is a placeholder built
  // for pre-join prediction — the wrong dungeon, the wrong spawn. Nothing of it may run or
  // render, or the player sees themselves spawn there and teleport once truth arrives.
  private isAwaitingOnlineWorld(): boolean {
    return this.mode === "online" && this.wsTransport !== null && !this.wsTransport.isReady();
  }

  // One client frame: sample input -> drive the sim through the transport -> replay the
  // returned events into FX -> advance client-only cosmetics -> render (caller). Solo runs
  // stepWorld in-process (LocalTransport), so this IS the old update loop, just seam'd.
  private tick(dt: number) {
    // Snapshot player pos BEFORE this sim step so the renderer can interpolate between the
    // last two sim positions (smooth motion at any frame rate vs the fixed sim rate).
    this.renderPrevX = this.px; this.renderPrevY = this.py; this.hasRenderPrev = true;
    // Awaiting the authoritative world: keep the handshake alive (join resends live in
    // advance) but run no gameplay — there is nothing real to play in yet.
    if (this.isAwaitingOnlineWorld()) {
      this.transport.advance(dt);
      this.updateHud();
      return;
    }

    if (this.coop) this.syncCoop(dt);

    const cmd = this.buildInput();
    this.world.remoteTargets = this.coopTargets();
    this.transport.sendInput(cmd);
    this.transport.advance(dt);

    // Online: the authoritative world geometry changed (initial join / party descend) — refresh
    // the seed-keyed cosmetic floor state (biome/torches/music/banner) BEFORE replaying events.
    if (this.mode === "online" && this.wsTransport) {
      const rebuilt = this.wsTransport.consumeWorldRebuilt();
      if (rebuilt) {
        const isFirstReveal = !this.isWorldRevealed;
        this.isWorldRevealed = true;
        this.seed = rebuilt.seed;
        this.loadFloorClient();
        this.hud.showBanner(floorBannerText(rebuilt.floor, { isBoss: isBossFloor(rebuilt.floor) }));
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

    // Online: surface any server-decided blessing offer (choice authority is server-side).
    if (this.mode === "online" && this.wsTransport && !this.isChoosing) {
      const offer = this.wsTransport.consumePendingOffer();
      if (offer) this.offerServerBlessing(offer);
    }

    // Dev combo-freeze holds the chain full so the HUD can be screenshotted at a tier.
    if (this.comboFreeze && this.combo > 0) this.p.comboTimer = COMBO_WINDOW;

    this.tickCosmetics(dt, cmd);

    if (this.coop) this.publishPresence();
    this.updateHud();
    if (this.isStatsHeld) this.openStats();
  }

  // Build this tick's InputCmd from keys/mouse/settings. Autofire + the mouse->world aim
  // are resolved here; the sim only sees moveX/moveY/aim/firing/dash.
  private buildInput(): InputCmd {
    let moveX = 0, moveY = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) moveY -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) moveY += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) moveX -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) moveX += 1;
    const wx = this.mouse.x + this.cam.x, wy = this.mouse.y + this.cam.y;
    const aim = Math.atan2(wy - this.py, wx - this.px);
    if (!settings.isAutofire) this.isAutoFiring = false;
    const firing = settings.isAutofire ? this.isAutoFiring : this.mouse.isDown;
    const dash = this.keys.has("shift");
    return { seq: ++this.inputSeq, moveX, moveY, aim, firing, dash };
  }

  // Co-op teammate positions fed to the sim as extra enemy-aggro targets (Stage A keeps
  // co-op on the existing presence path; the sim only needs their positions).
  private coopTargets(): RemoteTarget[] {
    if (!this.coop) return [];
    return this.coop.remotePlayers().map((r) => ({ x: r.x, y: r.y, isDown: r.isDown }));
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
      // Stable facing: only flip on committed horizontal movement (deadzone), never from
      // player-relative x every frame — that was the ghost/mob mirror-flicker.
      if (dx > 0.6) this.enemyFacing.set(e.id, 1);
      else if (dx < -0.6) this.enemyFacing.set(e.id, -1);
      stepAnim(anim, dt, moving, dx < -0.05 ? -1 : dx > 0.05 ? 1 : 0);
      this.enemyAnimPos.set(e.id, { x: e.x, y: e.y });
    }
    if (this.enemyAnims.size > liveEnemyIds.size) {
      for (const id of this.enemyAnims.keys()) if (!liveEnemyIds.has(id)) { this.enemyAnims.delete(id); this.enemyAnimPos.delete(id); this.enemyFacing.delete(id); }
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

    // Smooth camera follow: ease toward the player instead of hard-snapping every frame, so
    // per-frame movement variance (variable-dt sim step) doesn't read as jitter. High factor
    // = still tight tracking, just enough smoothing to absorb frame-time noise.
    {
      const tx = this.px - this.canvas.width / 2;
      const ty = this.py - this.canvas.height / 2;
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
  }

  // Ease the visual hazard clock onto the sim's authoritative one (online snapshots step
  // it at 20Hz; hit-stop pauses it) and fire the idle->telegraph->active edge cues:
  // an arming tick and an eruption burst per hazard, positional and camera-gated. All
  // cosmetic — damage resolves in the sim off the REAL clock.
  private updateHazardCosmetics(dt: number) {
    const target = this.world.hazardClock;
    this.hazardVisClock += dt;
    const drift = target - this.hazardVisClock;
    if (Math.abs(drift) > 0.6) this.hazardVisClock = target;
    else this.hazardVisClock += drift * Math.min(1, dt * 8);

    const hazards = this.world.hazards;
    if (hazards.length === 0) {
      if (this.hazardPhases.size > 0) this.hazardPhases.clear();
      return;
    }
    for (const h of hazards) {
      const phase = hazardPhaseAt(h, this.hazardVisClock);
      const prev = this.hazardPhases.get(h.id);
      this.hazardPhases.set(h.id, phase);
      if (prev === undefined || phase === prev) continue;
      const x = (h.tx + 0.5) * TILE, y = (h.ty + 0.5) * TILE;
      if (!this.isNearCamera(x, y)) continue;
      if (phase === "telegraph") {
        if (h.kind === "spikes") this.sfxAt("uiClick", x, y, { rate: 1.6, gain: 0.5 });
        else if (h.kind === "fire_vent") this.sfxAt("enemyAttack", x, y, { rate: 0.7, gain: 0.3 });
        else if (h.kind === "void_rift") this.sfxAt("enemyAttack", x, y, { rate: 0.4, gain: 0.3 });
      } else if (phase === "active") {
        switch (h.kind) {
          case "spikes":
            this.sfxAt("meleeSwing", x, y, { rate: 1.5, gain: 0.4 });
            this.spawnPuff(x, y, 3, "#c9c9de");
            break;
          case "fire_vent":
            this.sfxAt("barrel", x, y, { rate: 1.3, gain: 0.35 });
            this.spawnEmberAt(x, y - 6, 8);
            this.spawnPuff(x, y - 10, 4, "#ff8a3b");
            break;
          case "void_rift":
            this.sfxAt("tesla", x, y, { rate: 0.6, gain: 0.3 });
            this.spawnSparkleBurst(x, y, 6, this.currentBiome.accent);
            break;
          default:
            break;
        }
      }
    }
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
    this.screenFlash.flash(140, 255, 190, 0.08, 2.5);
    this.hud.showBanner("FLOOR CLEARED \u00b7 \u25be TAKE THE STAIRS");
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
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon]);
        this.muzzle.t = MUZZLE_DUR; this.muzzle.x = e.x; this.muzzle.y = e.y; this.muzzle.angle = e.aim; this.muzzle.size = w.muzzle; this.muzzle.color = w.color;
        this.spawnParticles(e.x, e.y, w.muzzle, "#ffe6a0");
        if (SMOKY_WEAPONS.has(e.weapon)) this.spawnPuff(e.x, e.y, 3, "#c9b8a0");
        if (e.weapon !== "rapid" && e.weapon !== "flamer") this.spawnShell(e.px, e.py - 6, e.aim);
        sfx(SHOOT_SFX[e.weapon], SHOOT_SFX_OPTS[e.weapon]);
        this.addTrauma(FIRE_TRAUMA[e.weapon]);
        const kick = FIRE_KICK[e.weapon];
        this.kickX += -Math.cos(e.aim) * kick;
        this.kickY += -Math.sin(e.aim) * kick;
        break;
      }
      case "meleeSwing": {
        const w = WEAPONS[e.weapon];
        const m = w.melee;
        this.meleeFlipDir = -this.meleeFlipDir; // alternate the visual sweep; the hitbox wedge is symmetric
        triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon]);
        if (m) this.spawnSlashWind(e.x, e.y, e.aim, m, w.color);
        const feel = MELEE_FEEL[e.weapon];
        if (feel) sfx(feel.swingSfx, { rate: feel.swingRate, gain: feel.swingGain });
        else sfx(SHOOT_SFX[e.weapon]);
        this.addTrauma(FIRE_TRAUMA[e.weapon]);
        // Melee kicks the camera INTO the strike (a lunge), not back like gun recoil.
        const kick = FIRE_KICK[e.weapon];
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
        if (!e.killed) sfx(e.melee ? "meleeHit" : "enemyHit", { gain: e.melee ? 0.9 : 0.65 });
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
        const big = e.kind === "boss";
        if (big) audio.setMusic("dungeon"); // the intense boss track relaxes after the kill
        this.spawnGibs(e.x, e.y, big ? 24 : 10, arch.tint);
        this.spawnParticles(e.x, e.y, big ? 20 : 8, big ? "#ffb43b" : arch.tint);
        this.addDecal(e.x, e.y, arch.tint, big ? 36 : 18, "splat");
        this.replayDeathBurst(e.kind, e.x, e.y);
        const dur = e.kind === "boss" ? DEATH_DUR_BOSS
          : (e.kind === "slime" || e.kind === "skeleton" || e.kind === "bat") ? DEATH_DUR_SHEET
          : DEATH_DUR;
        const size = arch.drawSize * (TIERS[e.tier as EnemyTier]?.drawMult ?? 1);
        this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size, facing: this.px >= e.x ? 1 : -1, t: 0, dur });
        const comboRate = 1 + Math.min(e.combo - 1, 20) * 0.015;
        sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : comboRate });
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
        this.screenFlash.flash(255, 210, 122, 0.1, 2.5);
        this.addTrauma(0.12);
        break;
      case "offerBlessing":
        // Online: the SERVER decides the choice set and sends a separate `offer` message (drained
        // in tick via the transport); ignore the sim event's local roll so choice authority stays
        // server-side. Solo/co-op roll their own choices locally.
        if (this.mode !== "online") this.offerBlessing(e.rare);
        break;
      case "pickup":
        if (e.kind === "coin") { this.spawnParticles(e.x, e.y, 6, "#ffd27a"); this.addDecal(e.x, e.y, "#ffd27a", 10, "ring"); sfx("coin"); }
        else if (e.kind === "heart" || e.kind === "dealer_heart") { this.spawnParticles(e.x, e.y, 8, "#ff6a6a"); this.addDecal(e.x, e.y, "#ff6a6a", 12, "ring"); sfx("heart"); }
        else { this.spawnParticles(e.x, e.y, 12, "#ffb43b"); this.addDecal(e.x, e.y, "#ffb43b", 14, "ring"); sfx("weapon"); }
        break;
      case "lootDrop":
        this.addDecal(e.x, e.y, e.color, 15, "ring");
        this.spawnPuff(e.x, e.y, 5, e.color);
        break;
      case "bulletWall":
        this.spawnSparks(e.x, e.y, 5, e.aim);
        break;
      case "bulletBounce":
        this.spawnSparks(e.x, e.y, 3, e.aim);
        this.spawnSparkFlash(e.x, e.y, e.color);
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
        if (this.isNearCamera(e.x, e.y)) this.screenFlash.flash(255, 150, 60, 0.13, 3.2);
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
        // (which the sim raises separately for the shared hurt juice).
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
      case "bossPhase":
        triggerFlash(this.animForId(e.eid));
        this.sfxAt("bossSpawn", e.x, e.y);
        this.addTrauma(TRAUMA_BOSS_FLOOR);
        this.shockwaves.spawn(e.x, e.y, 30, 190, 0.55, "#ffb43b", 4);
        this.screenFlash.flash(255, 180, 59, 0.12, 2.8);
        break;
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
          this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor), isDescend: true }));
        }
        break;
      case "reachExit":
        if (this.coop && this.pendingDescend !== e.toFloor) { this.pendingDescend = e.toFloor; this.coop.requestDescend(e.toFloor); }
        break;
      case "revive":
        // Authoritative (online) revive: the server brought a downed player back. The revived
        // player's own client replays the juice (wsTransport only forwards its own pid events).
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
      case "cue":
        if (this.isNearCamera(e.x, e.y)) {
          sfx(e.name as SfxName, { rate: e.rate, gain: e.gain });
          if (e.trauma > 0) this.addTrauma(e.trauma);
        }
        break;
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
      case "boss":
        this.screenFlash.flash(255, 214, 120, 0.4, 1.4);
        this.shockwaves.spawn(x, y, 24, 150, 0.5, "#ffd27a", 5);
        this.shockwaves.spawn(x, y, 12, 260, 0.8, "#ffb43b", 3);
        this.spawnSparkleBurst(x, y, 26, "#ffd27a");
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
    this.mouse.isDown = false;
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      const events = chooseBlessingInWorld(this.world, LOCAL_ID, item);
      if (events.length > 0) this.ownedItemDefs.push(item);
      this.handleSimEvents(events);
      this.isChoosing = false;
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
    this.mouse.isDown = false;
    this.blessing.show(this.toBlessingCards(choices), (item) => {
      this.playBlessingPickSfx(item);
      this.wsTransport?.sendChooseBlessing(offer.id, item.id);
      this.isChoosing = false;
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

  // Weapon switching (1-9 / Q / scroll): resolves the target slot client-side, then equips
  // it in the sim. All local — no networking. Switching resets fire cooldown + cancels any
  // in-progress swing (in the sim).
  private selectWeapon(index: number) {
    const owned = this.p.ownedWeapons;
    if (index < 0 || index >= owned.length) return;
    this.equipOrRequest(owned[index]);
  }

  private cycleWeapon(dir: number) {
    const owned = this.p.ownedWeapons;
    if (owned.length < 2) return;
    const cur = owned.indexOf(this.weapon);
    const next = (cur + dir + owned.length) % owned.length;
    this.equipOrRequest(owned[next]);
  }

  // Solo/co-op equip in the local sim (authoritative locally); online sends an authoritative
  // equip command — the server validates ownership + equips, and the result returns via SelfWire.
  // There is NO client-local inventory mutation on the online path.
  private equipOrRequest(weapon: WeaponId) {
    if (this.mode === "online" && this.wsTransport) this.wsTransport.sendEquip(weapon);
    else equipWeaponInWorld(this.world, LOCAL_ID, weapon);
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
        if (this.isNearCamera(r.x, r.y)) sfx(SHOOT_SFX[r.weapon], { gain: 0.4 });
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
    const boss = this.enemies.find((e) => e.kind === "boss");
    const isBossActive = boss !== undefined;
    const bossHpFrac = boss ? Math.max(0, boss.hp / boss.maxHp) : 0;
    let coopLabel: string | null = null;
    if (this.coop) {
      const count = this.coop.remotePlayers().length + 1;
      coopLabel = `CO-OP \u00b7 ${this.coop.roomCode} \u00b7 ${count} player${count === 1 ? "" : "s"}`;
    } else if (this.mode === "online" && this.wsTransport) {
      const count = this.wsTransport.remotePlayers().length + 1;
      const live = this.wsTransport.isReady() ? "ONLINE" : "CONNECTING";
      // Surface the room code mid-run so a friend can still be invited into this world.
      const room = this.onlineRoomCode ? ` \u00b7 ${this.onlineRoomCode}` : "";
      coopLabel = `${live}${room} \u00b7 ${count} player${count === 1 ? "" : "s"}`;
    }
    const comboTier = this.comboTier();
    this.hud.update({
      hp: this.hp, maxHp: this.maxHp,
      floor: this.floor, kills: this.kills, coins: this.coins,
      weapons: this.p.ownedWeapons.map((id) => ({ id, name: WEAPONS[id].name, isCurrent: id === this.weapon })),
      // Online floors use the authoritative global cleared flag (enemies may be interest-filtered
      // out of this client's snapshot, so a local count can't decide "cleared").
      isCleared: this.mode === "online" && this.wsTransport ? this.wsTransport.isFloorCleared() : isFloorCleared(this.world),
      enemiesLeft: this.enemies.length,
      isBossActive,
      bossHpFrac,
      coopLabel,
      dashFill: 1 - this.dashCd / this.dashCooldown(),
      combo: this.combo,
      comboMult: comboTier.mult,
      comboColor: comboTier.color,
      comboFrac: this.comboTimer / COMBO_WINDOW,
      items: this.collapsedItems(),
    });
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
  // HUD panel shows one chip per distinct blessing with an xN level badge; the chip text
  // tracks the current level's effect.
  private collapsedItems() {
    const collapsed = new Map<string, { id: string; name: string; desc: string; glyph: string; tint: string; rarity: string; count: number }>();
    for (const it of this.currentItemDefs()) {
      const seen = collapsed.get(it.id);
      if (seen) { seen.count++; seen.desc = itemDesc(it, seen.count); }
      else collapsed.set(it.id, { id: it.id, name: it.name, desc: itemDesc(it, 1), glyph: it.glyph, tint: it.tint, rarity: it.rarity, count: 1 });
    }
    return [...collapsed.values()];
  }

  private openStats() {
    let roster: Array<{ name: string; isYou: boolean; color: string; isDown: boolean }> | null = null;
    if (this.coop) {
      roster = [
        { name: "you", isYou: true, color: playerColor(this.coop.selfColorIndex()), isDown: this.isDown },
        ...this.coop.remotePlayers().map((r) => ({ name: r.name, isYou: false, color: playerColor(r.colorIndex), isDown: r.isDown })),
      ];
    } else if (this.mode === "online" && this.wsTransport) {
      roster = [
        { name: "you", isYou: true, color: playerColor(this.selfColorIndex ?? 0), isDown: this.isDown },
        ...this.wsTransport.remotePlayers().map((r) => ({ name: r.name, isYou: false, color: playerColor(r.colorIndex), isDown: r.isDown })),
      ];
    }
    this.hud.showStats({
      floor: this.floor, kills: this.kills, coins: this.coins,
      runTime: (performance.now() - this.runStart) / 1000,
      weaponName: WEAPONS[this.weapon].name,
      profile: this.profile,
      roster,
      items: this.collapsedItems().map((it) => ({ name: it.count > 1 ? `${it.name} Lv${it.count}` : it.name, desc: it.desc, glyph: it.glyph, tint: it.tint })),
    });
  }

  private gameOver() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.isAutoFiring = false;
    cancelAnimationFrame(this.raf);
    // Terminal exit STOPS the transport: online this closes the socket and leaves the
    // authoritative world (no lingering post-run connection); solo LocalTransport.stop is a
    // no-op, so solo behavior is unchanged.
    this.transport.stop();
    audio.setMusic(null);
    sfx("gameOver");
    this.hud.hideStats();
    this.hud.clear();
    this.hud.setVisible(false);
    this.onGameOver({ floor: this.floor, kills: this.kills, coins: this.coins, durationMs: performance.now() - this.runStart });
  }

  // Online transport terminal states end the run cleanly instead of freezing the last frame:
  // once we were in the authoritative world, a closed/errored socket IS the end of this run
  // (the server also closes the socket after a game over — same path). If the connection never
  // became ready (server unreachable / rejected), return to the menu instead.
  private onOnlineStatus(s: "connecting" | "open" | "closed" | "error") {
    if (this.mode !== "online" || !this.isRunning || !this.wsTransport) return;
    if (s !== "closed" && s !== "error") return;
    if (this.wsTransport.isReady()) this.gameOver();
    else this.quitToMenu("connect_failed");
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
    // trauma² shake, scaled by the player's intensity setting. New random offset per
    // frame; the background fill above stays put so edges never flash the void.
    const mag = this.trauma * this.trauma * SHAKE_MAX_PX * settings.shakeIntensity;
    const shakeX = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    const shakeY = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    ctx.save();
    ctx.translate(shakeX + this.kickX, shakeY + this.kickY);
    this.renderTiles();
    if (this.isFlowDebug) this.renderFlowDebug();
    this.renderProps();
    this.renderDecals();
    this.renderHazards(); // floor-level danger: over decals, under the ambient air + entities
    this.motes.render(ctx, this.cam.x, this.cam.y); // ambient biome air, over the floor, under entities
    this.renderExit();
    this.renderShadows();
    this.renderPropEntities();
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
    this.renderMuzzle();
    this.renderDmgNumbers(); // world-space, on top of all entities but under the shake restore
    ctx.restore();
    this.renderBiomeVignette();
    this.screenFlash.render(ctx, canvas.width, canvas.height);
    this.renderHurtVignette();
    this.renderReticle();
    this.renderMinimap();
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

  // The pre-world online frame: a plain dark hold with a pulsing status line. Never the
  // placeholder dungeon — showing it is exactly the spawn-then-teleport artifact.
  private renderConnectingVeil() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0d0a18";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const pulse = 0.55 + 0.35 * Math.sin(this.animClock * 4);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#ffb43b";
    ctx.font = '700 14px "Silkscreen", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ENTERING THE DUNGEON\u2026", canvas.width / 2, canvas.height / 2);
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
    const { ctx, canvas, cam, tiles } = this;
    const d = this.dungeon;
    const biome = this.currentBiome;
    const [sideL, sideR] = this.wallSideGrads[this.biomeIdx];
    // +1 tile of margin on each edge so the screen-shake translate never exposes bg.
    const x0 = Math.max(0, Math.floor(cam.x / TILE) - 1);
    const y0 = Math.max(0, Math.floor(cam.y / TILE) - 1);
    const x1 = Math.min(d.w, Math.ceil((cam.x + canvas.width) / TILE) + 1);
    const y1 = Math.min(d.h, Math.ceil((cam.y + canvas.height) / TILE) + 1);

    // Pass 1: floors (+ detail overlay at the biome's density + cast shadow under walls).
    // Dedicated per-biome floor art (BIOME_TILE_SOURCES) wins when registered; otherwise
    // the shared set carries the biome through the grade below.
    const detailDensity = biome.detailDensity;
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (d.tiles[ty * d.w + tx] !== 0) continue;
        const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
        const vHash = tileHash(tx, ty, 1);
        const biomeArt = tiles.biomeFloor(biome.tileKey, Math.floor(vHash * 61));
        if (biomeArt) {
          ctx.drawImage(biomeArt, sx, sy, TILE, TILE);
        } else if (tiles.ready(floorVariant(vHash))) {
          ctx.drawImage(tiles.get(floorVariant(vHash)), sx, sy, TILE, TILE);
        } else {
          ctx.fillStyle = (tx + ty) % 2 === 0 ? biome.floorA : biome.floorB;
          ctx.fillRect(sx, sy, TILE, TILE);
        }
        const rd = tileHash(tx, ty, 2);
        if (rd < detailDensity) {
          const t = rd / detailDensity;
          // Built-dungeon grates only suit the built bands (the Hollow's masonry, the
          // Ember works); caves and the deeper wrong places crack and grow instead.
          const hasGrates = this.biomeIdx === 0 || this.biomeIdx === 3;
          const detail: TileName = t < 0.33 ? "floor_crack" : t < 0.66 ? (hasGrates ? "floor_grate" : "floor_crack") : "floor_moss";
          if (tiles.ready(detail)) {
            ctx.drawImage(tiles.get(detail), sx, sy, TILE, TILE);
            // Deep biomes recolor their growth dressing (frost lichen, ember-lit cracks,
            // void bloom): the tinted silhouette blends OVER the original at partial
            // alpha, so the art keeps its texture and only the hue shifts.
            if (biome.detailTint && detail === "floor_moss") {
              const tinted = tiles.tinted(detail, biome.detailTint);
              if (tinted) {
                ctx.save();
                ctx.globalAlpha = 0.45;
                ctx.drawImage(tinted, sx, sy, TILE, TILE);
                ctx.restore();
              }
            }
          }
        }
        // A wall directly above casts a shadow onto this floor tile — sells the height.
        if (ty > 0 && d.tiles[(ty - 1) * d.w + tx] === 1 && tiles.ready("wall_shadow")) {
          ctx.drawImage(tiles.get("wall_shadow"), sx, sy, TILE, TILE);
        }
      }
    }

    // Room flourishes: per-archetype floor lighting drawn between floors and walls, so
    // wall tiles crop the edges naturally. Arenas get a fighting-pit spotlight, vaults a
    // treasure-warm glow, hazard set-piece rooms an ominous accent pool.
    this.renderRoomFlourishes(x0, y0, x1, y1);

    // Pass 2: walls as extruded blocks — lit top cap, dark front face where a floor sits
    // directly below, and mid-dark side strips on exposed left/right edges. Corners where
    // the front meets a side get an extra darken so the cube edge reads.
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (d.tiles[ty * d.w + tx] !== 1) continue;
        const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
        const aboveFloor = ty > 0 && d.tiles[(ty - 1) * d.w + tx] === 0;
        const belowFloor = ty + 1 < d.h && d.tiles[(ty + 1) * d.w + tx] === 0;
        const leftFloor = tx > 0 && d.tiles[ty * d.w + tx - 1] === 0;
        const rightFloor = tx + 1 < d.w && d.tiles[ty * d.w + tx + 1] === 0;
        // Per-biome wall art (opt-in) wins outright; the extruded side/corner shading
        // below still runs over it, so a single authored block reads as a full cube.
        const biomeWall = tiles.biomeWallTop(biome.tileKey);
        if (!biomeWall) {
          // Full 16-piece autotile (AD): pick the block by which of N/E/S/W neighbours are
          // FLOOR (NESW order). One self-contained piece bakes cap + all exposed faces +
          // corners — handles thin walls, pillars, and gaps, not just room perimeters.
          const sides = (aboveFloor ? "N" : "") + (rightFloor ? "E" : "") + (belowFloor ? "S" : "") + (leftFloor ? "W" : "");
          const wf = ("wf_" + (sides || "top")) as TileName;
          if (tiles.ready(wf)) { ctx.drawImage(tiles.get(wf), sx, sy, TILE, TILE); continue; }
        }
        if (biomeWall) {
          ctx.drawImage(biomeWall, sx, sy, TILE, TILE);
        } else if (tiles.ready("wall_top")) {
          ctx.drawImage(tiles.get("wall_top"), sx, sy, TILE, TILE);
        } else {
          ctx.fillStyle = biome.wallFront;
          ctx.fillRect(sx, sy, TILE, TILE);
          ctx.fillStyle = biome.wallCap;
          ctx.fillRect(sx, sy, TILE, 6);
        }
        // Front face (darkest): a real sprite if present, else the wall_face_left/right
        // swap-ready fallback is the shaded strips below.
        if (belowFloor && tiles.ready("wall_face")) {
          ctx.drawImage(tiles.get("wall_face"), sx, sy, TILE, TILE);
        }
        // Side faces: a translucent gradient strip fading inward from the exposed edge.
        if (leftFloor && sideL) {
          ctx.save();
          ctx.translate(sx, sy);
          ctx.fillStyle = sideL;
          ctx.fillRect(0, 0, WALL_SIDE_W, TILE);
          ctx.restore();
        }
        if (rightFloor && sideR) {
          ctx.save();
          ctx.translate(sx + TILE - WALL_SIDE_W, sy);
          ctx.fillStyle = sideR;
          ctx.fillRect(0, 0, WALL_SIDE_W, TILE);
          ctx.restore();
        }
        // Darken the bottom corners where the front face meets a side face.
        if (belowFloor && (leftFloor || rightFloor)) {
          ctx.fillStyle = biome.wallCorner;
          if (leftFloor) ctx.fillRect(sx, sy + TILE - WALL_SIDE_W, WALL_SIDE_W, WALL_SIDE_W);
          if (rightFloor) ctx.fillRect(sx + TILE - WALL_SIDE_W, sy + TILE - WALL_SIDE_W, WALL_SIDE_W, WALL_SIDE_W);
        }
      }
    }

    // Two-pass wash so the biome reads at a glance over the purple-baked wall sprites:
    // a "color" pass to shift hue, then a lighter "overlay" pass to push saturation/warmth
    // through while preserving the tile shading. Alphas kept tasteful (cohesion, not neon).
    const wx = x0 * TILE - cam.x, wy = y0 * TILE - cam.y, ww = (x1 - x0) * TILE, wh = (y1 - y0) * TILE;
    ctx.save();
    ctx.globalCompositeOperation = "color";
    ctx.globalAlpha = biome.tintAlpha;
    ctx.fillStyle = biome.tint;
    ctx.fillRect(wx, wy, ww, wh);
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = biome.tintAlpha * 0.85;
    ctx.fillRect(wx, wy, ww, wh);
    // Depth darkness: the world itself dims band over band (entities draw ABOVE this, so
    // combat readability never pays for the mood). Ember/Null breathe — the dark swells.
    if (biome.lightLevel > 0) {
      ctx.globalCompositeOperation = "source-over";
      const breathe = biome.pulse > 0 ? biome.pulse * 0.5 * (1 + Math.sin(this.animClock * 1.3)) : 0;
      ctx.globalAlpha = Math.min(0.5, biome.lightLevel + breathe);
      ctx.fillStyle = "#020108";
      ctx.fillRect(wx, wy, ww, wh);
    }
    ctx.restore();
  }

  // ---- floor hazards ----
  // Every hazard renders its full cycle so danger is ALWAYS readable: a visible resting
  // body, an arming telegraph, and an unmistakable active burst. When authored art lands
  // in HAZARD_SOURCES the sheet replaces the body; the primitive fallback below speaks
  // the game's existing telegraph language (the boss-slam-marker family), so hazards are
  // fair on day one.
  private renderHazards() {
    const hazards = this.world.hazards;
    if (hazards.length === 0) return;
    const { cam, tiles } = this;
    const clock = this.hazardVisClock;
    for (const h of hazards) {
      const wx = (h.tx + 0.5) * TILE, wy = (h.ty + 0.5) * TILE;
      if (!this.isNearCamera(wx, wy, TILE)) continue;
      const sx = h.tx * TILE - cam.x, sy = h.ty * TILE - cam.y;
      const phase = hazardPhaseAt(h, clock);
      const frac = hazardPhaseFrac(h, clock);
      const sheet = tiles.hazard(h.kind);
      if (sheet) {
        this.drawHazardSheet(sheet, phase, sx, sy);
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
  private drawHazardSheet(sheet: HTMLImageElement, phase: HazardPhase, sx: number, sy: number) {
    const frames = Math.max(1, Math.floor(sheet.width / sheet.height));
    const idx = frames >= 3 ? (phase === "idle" ? 0 : phase === "telegraph" ? 1 : 2)
      : frames === 2 ? (phase === "active" ? 1 : 0) : 0;
    this.ctx.drawImage(sheet, idx * sheet.height, 0, sheet.height, sheet.height, sx, sy, TILE, TILE);
  }

  private drawSpikes(sx: number, sy: number, phase: HazardPhase, frac: number) {
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

  private drawPool(sx: number, sy: number, h: Hazard) {
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

  private drawVent(sx: number, sy: number, phase: HazardPhase, frac: number, h: Hazard) {
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

  private drawRift(sx: number, sy: number, phase: HazardPhase, frac: number) {
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

  // Per-archetype room lighting (screen-cropped, gradient fills only). Cheap: a handful
  // of rooms intersect the camera and each is one radial fill.
  private renderRoomFlourishes(x0: number, y0: number, x1: number, y1: number) {
    const { ctx, cam } = this;
    const biome = this.currentBiome;
    for (const room of this.dungeon.rooms) {
      if (room.x >= x1 || room.y >= y1 || room.x + room.w <= x0 || room.y + room.h <= y0) continue;
      const cx = (room.cx + 0.5) * TILE - cam.x;
      const cy = (room.cy + 0.5) * TILE - cam.y;
      const radius = Math.max(room.w, room.h) * TILE * 0.55;
      if (room.shape === "arena") {
        // Fighting-pit spotlight: brightest at the center where the duel happens.
        const g = ctx.createRadialGradient(cx, cy, radius * 0.15, cx, cy, radius);
        g.addColorStop(0, "rgba(255,244,214,0.10)");
        g.addColorStop(1, "rgba(255,244,214,0)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = g;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.restore();
      } else if (room.kind === "treasure") {
        const g = ctx.createRadialGradient(cx, cy, 6, cx, cy, radius * 0.7);
        g.addColorStop(0, "rgba(255,209,102,0.12)");
        g.addColorStop(1, "rgba(255,209,102,0)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = g;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.restore();
      } else if (room.kind === "hazard") {
        const [r, g2, b] = hexToRgb(biome.accent);
        const pulse = 0.05 + 0.03 * Math.sin(this.animClock * 2.1);
        const g = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
        g.addColorStop(0, `rgba(${r},${g2},${b},${pulse})`);
        g.addColorStop(1, `rgba(${r},${g2},${b},0)`);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = g;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.restore();
      }
    }
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
  private drawChar(name: SpriteName, clip: SheetClip, cx: number, cy: number, size: number, facing: number, xf: Xform, extra: number, alpha: number, flash: number, frameClock: number, tint: string | null = null) {
    const { ctx } = this;
    const sheet = this.sprites.sheet(name, clip);
    if (!sheet && !this.sprites.ready(name)) {
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = "#a855f7";
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
      const i = frameIndex(count, sheet.fps, frameClock);
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

  private renderPickups() {
    const { ctx, cam } = this;
    for (const p of this.pickups) {
      const clock = this.animForPickup(p).clock;
      const sx = p.x - cam.x, sy = p.y - cam.y + Math.sin(clock * 3) * 3 - 2;
      const name: SpriteName = p.kind === "weapon" ? "gun" : p.kind === "dealer_heart" ? "heart" : p.kind;
      ctx.save();
      ctx.globalAlpha = 0.3 + Math.abs(Math.sin(clock * 3)) * 0.15;
      const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, 20);
      g.addColorStop(0, p.kind === "heart" ? "#ff6a6a" : p.kind === "coin" || p.kind === "dealer_heart" ? "#ffd27a" : "#ffb43b");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, 20, 0, 6.28); ctx.fill();
      ctx.restore();
      // The Dealer's heart wears its coin price; gray if this player can't afford it.
      if (p.kind === "dealer_heart") {
        const price = p.value ?? 6;
        ctx.save();
        ctx.font = '700 10px "Silkscreen", monospace';
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(8,6,16,0.9)";
        ctx.fillText(`${price}c`, sx + 1, sy - 17);
        ctx.fillStyle = this.coins >= price ? "#ffd27a" : "#8a8378";
        ctx.fillText(`${price}c`, sx, sy - 18);
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
      const facing = this.enemyFacing.get(e.id) ?? (this.px >= e.x ? 1 : -1);
      const isWindup = a.phase === "windup";
      const isHopSlam = e.kind === "boss" && a.move === "hopslam";
      const drawSize = this.enemyDrawSize(e);

      // Ground danger marker for the boss hop-slam (drawn under everything).
      if (isHopSlam && (isWindup || a.phase === "active")) this.renderSlamMarker(e);
      // The shrinking safe-ring of the boss arena squeeze.
      if (e.kind === "boss" && a.move === "squeeze") this.renderSqueeze(e);
      // Brutes/elites carry a colored ground ring so the tier reads before the first hit.
      const ring = TIER_RING_COLOR[e.tier];
      if (ring) this.renderTierRing(sx, sy, drawSize, ring);

      // Ghost solidify reads as an opacity ramp; everyone else uses the archetype alpha.
      const alpha = e.kind === "ghost" ? 0.62 + 0.38 * a.windup : arch.alpha;

      const clip: SheetClip = anim.move > 0.5 ? "walk" : "idle";
      const xf = characterXform(anim, e.kind === "boss" ? BOSS_STYLE : CHARACTER_STYLE);
      let extra = 1;
      // Skeleton coils down (squash) as its lunge charges.
      if (e.kind === "skeleton" && isWindup) { xf.sx += 0.28 * a.windup; xf.sy -= 0.24 * a.windup; }
      // Boss inflates for radial/roar/squeeze telegraphs and lifts off the ground mid-slam.
      if (e.kind === "boss") {
        if (isWindup && (a.move === "radial" || a.move === "roar" || a.move === "squeeze")) extra = 1 + a.windup * 0.16;
        if (isHopSlam && a.phase === "windup") xf.sy -= 0.18 * a.windup; // crouch before the leap
        if (isHopSlam && a.phase === "active") { xf.oy -= Math.sin(a.windup * Math.PI) * BOSS_JUMP_HEIGHT; extra = 1.08; }
      }
      // A white pulse on the sprite intensifies as the windup nears release.
      const pulse = 0.55 + 0.45 * Math.sin(anim.clock * 13);
      const telegraphFlash = isWindup ? a.windup * pulse * 0.85 : 0;
      this.drawChar(arch.sprite, clip, sx, sy, drawSize, facing, xf, extra, alpha, Math.max(anim.flash, telegraphFlash), anim.clock);

      // Elemental status overlays (burn ember glow / chill frost / freeze crust / shock crackle).
      if (e.burn > 0 || e.chill > 0 || e.shock > 0) this.renderEnemyStatus(e, sx, sy, drawSize);

      // Shimmer flecks while a ghost is materializing.
      if (e.kind === "ghost" && a.windup > 0.05 && a.windup < 0.98) this.renderGhostShimmer(e, sx, sy);
      // Aura + aim line for a charging attack.
      if (isWindup) this.renderTelegraph(e, sx, sy);

      const barW = e.kind === "boss" ? 64 : 32;
      const barY = sy - drawSize / 2 - 8;
      ctx.fillStyle = "#000"; ctx.fillRect(sx - barW / 2, barY, barW, 4);
      ctx.fillStyle = e.kind === "boss" ? "#ffb43b" : "#ff5a5a";
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, e.hp / e.maxHp), 4);
    }
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

    if (a.move === "lunge" || a.move === "spit") {
      const len = a.move === "lunge" ? 150 : 300;
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
      ctx.globalAlpha = r.isDown ? 0.4 : 1;
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

      if (!r.isDown) {
        if (WEAPONS[r.weapon].melee) this.renderHeldMelee(sx, sy, r.aimAngle, r.weapon, 1, null);
        else this.renderHeldWeapon(sx, sy, r.aimAngle, r.weapon, 1);
      }

      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(r.isDown ? `${r.name} (down)` : r.name, sx, sy - 32);
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
      ctx.fillStyle = "#ff6a6a";
      ctx.font = '700 12px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText("DOWN \u2014 wait for a teammate", psx, psy - 34);
      ctx.textAlign = "left";
    }
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
    const cx = this.mouse.x, cy = this.mouse.y;
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
      dots.push({ x: e.x, y: e.y, color: e.kind === "boss" ? "#ffb43b" : "#ff6a6a", size: e.kind === "boss" ? 3 : 2 });
    }
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
      const wx = this.mouse.x + this.cam.x, wy = this.mouse.y + this.cam.y;
      if (!this.isWallAt(wx, wy)) return { x: wx, y: wy };
    }
    for (let i = 0; i < 32; i++) {
      const a = Math.random() * Math.PI * 2, r = 48 + Math.random() * 150;
      const x = this.px + Math.cos(a) * r, y = this.py + Math.sin(a) * r;
      if (!this.isWallAt(x, y)) return { x, y };
    }
    return { x: this.px, y: this.py };
  }

  devSpawnEnemies(kind: EnemyKind, count: number, atCursor: boolean): void {
    for (let i = 0; i < count; i++) {
      const p = this.devPlacePoint(atCursor);
      devSpawnEnemy(this.world, kind, p.x, p.y);
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
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
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
  // plus a marker on source/unreachable tiles. Reads the shared field the AI already
  // built this frame (see updateEnemies), so it costs nothing until toggled on.
  private renderFlowDebug(): void {
    const flow = this.world.flow;
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
