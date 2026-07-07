import { generateDungeon } from "./dungeon.js";
import type { Dungeon, Room } from "./dungeon.js";
import { FlowField } from "./pathfind.js";
import { TILE } from "./types.js";
import type { Enemy, EnemyKind, Bullet, Particle, DmgNumber, Pickup, WeaponId, AttackMove, RemotePlayer, Prop, PropKind, Chest, TileKind } from "./types.js";
import { Rng, randomSeed } from "./rng.js";
import { Sprites, TileSet, playerColor, FRAME } from "./assets.js";
import type { SpriteName, SheetClip, TileName, FxName, PropSpriteName } from "./assets.js";
import { ENEMY_ARCHETYPES, spawnFloorEnemies, isBossFloor, createEnemy } from "./enemies.js";
import { WEAPONS, DEFAULT_WEAPON, PICKUP_WEAPONS, fire } from "./weapons.js";
import type { ShotSpec } from "./weapons.js";
import { createMods, rollItemChoices } from "./items.js";
import type { PlayerMods, ItemDef } from "./items.js";
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
import { settings } from "./settings.js";
import { PauseOverlay } from "../ui/pause.js";
import { BlessingOverlay } from "../ui/blessing.js";
import { BIOMES, biomeForFloor, biomeIndexForFloor, floorBannerText } from "./biomes.js";
import type { Biome } from "./biomes.js";

export interface RunResult { floor: number; kills: number; coins: number; durationMs: number; }

export interface StartOptions {
  mode: "solo" | "coop";
  coop?: CoopBridge | null;
  profile?: ProfileStats | null;
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
interface MeleeSwing {
  timer: number;
  duration: number;
  aim: number;
  arc: number;
  reach: number;
  isThrust: boolean;
  color: string;
  damage: number;
  isCrit: boolean;
  hitList: Enemy[] | null;
  burn?: number;
  chill?: number;
  shock?: number;
}
interface StrikeInfo {
  damage: number;
  isCrit: boolean;
  puffX: number;
  puffY: number;
  kbDirX: number;
  kbDirY: number;
  burn?: number;
  chill?: number;
  shock?: number;
  isMelee: boolean;
}

const MAX_DECALS = 48;
const AFTERIMAGE_DUR = 0.28; // seconds a dash afterimage takes to fade out

// Extruded-block wall look (Soul Knight): a lit top cap, a dark front face where the
// tile below is floor, plus mid-dark side strips on exposed left/right edges so a wall
// reads as a 3D cube rather than a flat cap. Tones step cap -> front -> side, darkening
// toward the world floor. Side strips are precomputed gradients (built once) that fade
// inward; corners where two faces meet get an extra darken so the cube edge reads.
const WALL_SIDE_W = 7;        // px width of an exposed side face
const WALL_SIDE_ALPHA = 0.62; // side-strip darkness at the edge

// Enemy pathfinding. A shared BFS flow field is rebuilt at most every FLOW_REBUILD
// seconds (or immediately when the local player changes tile) and every ground chaser
// follows its gradient — cheap over a ~40×30 grid, never per-enemy per-frame.
const FLOW_REBUILD = 0.2;
// Slime hop-cadence: a gentle speed pulse synced to its squash/stretch so the crawl
// reads as intent-driven hopping. Averages to 1× (sin mean 0), so balance is untouched.
const SLIME_HOP_FREQ = 3.4;   // matches CHARACTER_STYLE.freq so pushes land on the stretch
const SLIME_HOP_AMOUNT = 0.55;
// Anti-stuck: if a chaser tries to move but progresses < this fraction of its step for
// STUCK_TIME seconds, it's wedged — nudge it perpendicular to slip past the geometry.
const STUCK_TIME = 0.4;
const STUCK_PROGRESS = 0.5;
const STUCK_MIN_STEP = 0.05; // ignore near-zero intended steps (not actually trying to move)
const HALF_PI = Math.PI / 2;

const REVIVE_RADIUS = 46;
const REVIVE_HOLD = 1.1;
const BOSS_MINION_CAP = 14;
const DEATH_DUR = 0.3;        // seconds a fade-only corpse (ghost/spitter) animates out
const DEATH_DUR_SHEET = 0.4;  // slime/skeleton/bat: their 5-frame death clip
const DEATH_DUR_BOSS = 0.65;  // the boss's longer 8-frame death clip
const MUZZLE_DUR = 0.07; // seconds the muzzle flash lingers
const DASH_COOLDOWN = 0.7; // seconds between dashes; drives the HUD dash meter fill
const BASE_MAX_HP = 6;     // starting max hearts before any item bonus
// A shot firing more than one pellet fans them out; base pistol/rapid have ~no spread,
// so pellet-adding items force a minimum cone or the extra shots would stack perfectly.
const MIN_MULTI_SPREAD = 0.26;
const COIN_MAGNET_PULL = 300; // px/s a magnet drags loose coins toward the player

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
  railgun: "shootPistol",
  nailer: "shootRapid",
  flamer: "shootRapid",
  sword: "meleeSwing",
  longsword: "meleeSwing",
  spear: "meleeSwing",
};

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
  sword: 0.06, longsword: 0.1, spear: 0.05,
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
const FIRE_KNOCKBACK: Record<WeaponId, number> = {
  pistol: 0, shotgun: 22, rapid: 0,
  smg: 0, cannon: 10, burst: 0, ricochet: 0, homing: 0, tesla: 0,
  sawnoff: 26, railgun: 6, nailer: 0, flamer: 0,
  sword: 0, longsword: 0, spear: 8,
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
interface ComboTier { min: number; mult: number; color: string; } // min = combo count that engages the tier
// Highest-first so the first `combo >= min` hit is the active tier. Colors are :root tokens
// (cream -> amber -> amber-hi -> red) so the escalation reads at a glance.
const COMBO_TIERS: ComboTier[] = [
  // AD-locked escalation ramp (cool -> hot). x3 uses #ff3a3a specifically: a distinctly
  // HOTTER step past the orange (not the enemy-bat #ff5a5f), so the top "rampage" tier
  // reads as a jump, not a neighbor. It's a HUD accent, so one shade past the sprite
  // palette is intentional (like the boss damage-flash exception).
  { min: 20, mult: 3, color: "#ff3a3a" },   // hot red
  { min: 10, mult: 2, color: "#ff8a3b" },   // orange
  { min: 5, mult: 1.5, color: "#ffd166" },  // amber
  { min: 0, mult: 1, color: "#d9d2c0" },    // bone-white
];

// Enemy knockback: a bullet adds a short velocity impulse along its travel direction
// that decays every frame (never a teleport). WEAPON_KB is the ~total px shove on a
// baseline slime; heavier enemies divide it by their kbResist. The impulse is stored
// in each enemy's otherwise-unused vx/vy.
const WEAPON_KB: Record<WeaponId, number> = {
  pistol: 4, shotgun: 8, rapid: 2,
  smg: 2, cannon: 14, burst: 3, ricochet: 5, homing: 2, tesla: 3,
  sawnoff: 10, railgun: 12, nailer: 3, flamer: 1,
  sword: 14, longsword: 20, spear: 16,
};
const KB_LAMBDA = 16;     // decay rate; with the impulse math the total shove ≈ WEAPON_KB px
const KB_MAX_SPEED = 520; // cap so point-blank shotgun / rapid spam can't launch a mob
const MELEE_HIT_TRAUMA = 0.14; // extra thump layered on each melee connect (fire trauma is the whoosh)
const MELEE_THRUST_WIDTH = 18; // half-width of the spear thrust capsule (px)

// ---- elemental status effects (burn / chill / shock) ----
// Local per-enemy state driven by bullets (same model as damage/knockback), so co-op
// stays deterministic-enough with no new networking. Tuned a touch generous per the
// game's vibe; enemies are never nerfed — this only adds player upside.
const BURN_TICK = 0.25;        // DoT cadence (seconds); dmg dealt per tick = burnDmg * BURN_TICK
const BURN_DMG_STACK = 2;      // burnDmg added per application
const BURN_DMG_MAX = 6;        // cap (~3 stacks) so burn ramps but never runaway-melts
const CHILL_SLOW = 0.5;        // movement multiplier while chilled
const CHILL_MAX = 4;           // seconds of chill an enemy can bank
const FREEZE_AT = 3;           // chill ≥ this = frozen solid (speed 0, +50% damage). Never the boss.
const FROZEN_DMG_MULT = 1.5;   // shatter payoff: frozen enemies take +50%
const SHOCK_DMG_MULT = 1.25;   // shocked enemies take +25%
const SHOCK_ARC_RANGE = 130;   // px a shock arc can reach (matches the tesla feel)
const SHOCK_ARC_DMG = 1;       // small zap dealt to the arc target
// Durations rolled by item blessings (weapons carry their own via the `burn` field etc.).
const ITEM_BURN_SECS = 2;
const ITEM_CHILL_SECS = 1.2;
const ITEM_SHOCK_SECS = 2;
const BARREL_BURN_SECS = 2;    // explosive barrels lace the blast with fire
// Status overlay tints (reused by the render pass + shock arc tracer).
const BURN_TINT = "#ff8a3b";
const CHILL_TINT = "#7fd3ff";
const FREEZE_TINT = "#dff4ff";
const SHOCK_TINT = "#7fe9ff";

// Hurt vignette: a red screen-edge flash on damage that fades fast (seconds⁻¹).
const HURT_FLASH_DECAY = 3.2;

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
};
// Skeleton lunge. Aim locks at 0.35s of the 0.55s windup; the 0.5s recovery after the
// 0.28s dash is a free-damage window. Reaches ~145px, so walking sideways clears it.
const SKELETON_TRIGGER = 200;
const SKELETON_WINDUP = 0.55;
const SKELETON_LOCK = 0.35;
const SKELETON_LUNGE_DUR = 0.28;
const SKELETON_LUNGE_SPEED = 520;
const SKELETON_RECOVER = 0.5;
const SKELETON_CD = 2.0;

// Spitter caster (ranged glass cannon). Aim locks at 0.45s of the 0.7s windup, so the
// last 0.25s is a pure dodge window; walls break the shot via updateBullets.
const SPITTER_FLEE = 160;      // closer than this: back away
const SPITTER_APPROACH = 420;  // farther than this: close in; the band between = fire
const SPITTER_WINDUP = 0.7;
const SPITTER_LOCK = 0.45;
const SPITTER_RECOVER = 0.3;
const SPITTER_CD = 1.8;
const SPITTER_SPREAD_FLOOR = 4; // 3-glob spread from this floor on
const GLOB_SPREAD = 0.18;       // radians between spread globs

// Ghost solidify. Within range it ramps from translucent (harmless) to solid (lethal)
// over 0.4s; the opacity IS the tell, so staying mobile keeps it phased and harmless.
const GHOST_SOLID_RANGE = 120;
const GHOST_SOLID_TIME = 0.4;
const GHOST_SOLID_AT = 0.98;    // windup at/above which the ghost is fully solid + lethal

const BOSS_SLAM_RADIUS = 90;   // shockwave radius (also the ground-marker size)
const BOSS_JUMP_HEIGHT = 42;   // px the boss visually lifts mid hop-slam
// Slime King moveset. Hop-slam locks its target tile at 0.3s of the 0.6s windup (walk
// off the ring), leaps for 0.5s, then a 0.7s recovery. Radial burst (phase 2+) has no
// aim — it's an 8-glob ring you weave out of. Attack cadence tightens each HP phase.
const BOSS_ROAR_DUR = 0.8;
const BOSS_HOPSLAM_WINDUP = 0.6;
const BOSS_HOPSLAM_LOCK = 0.3;
const BOSS_HOPSLAM_AIR = 0.5;
const BOSS_HOPSLAM_RECOVER = 0.7;
const BOSS_RADIAL_WINDUP = 0.8;
const BOSS_RADIAL_RECOVER = 0.6;
const BOSS_RADIAL_COUNT = 8;
const BOSS_ATTACK_CD = [0, 3.5, 2.8, 2.2]; // seconds between attacks, indexed by phase 1..3
const BOSS_MINION_CD = 3.4;                // periodic slime drip
// Reused dashed/solid line patterns so the aim line never allocates per frame.
const AIM_DASH: number[] = [7, 6];
const AIM_SOLID: number[] = [];

// Animated prop frame tables (indexed by frameIndex), hoisted so the tile loop never allocates.
const TORCH_FRAMES: TileName[] = ["torch_f0", "torch_f1", "torch_f2"];

// ---- destructible props + treasure chests ----
// Placement is seeded per floor (co-op layout agreement); destruction resolves on the
// shared floor state via bullets/explosions, exactly like enemies. Reward rolls use the
// local RNG, matching enemy dropLoot (world pickups are first-come).
const PROP_RADIUS = 15;
const PROP_DRAW = 48;            // px the 64px prop sprite is drawn at (tile-sized)
const PROP_BREAK_DUR = 0.25;     // seconds the 2-frame break clip plays before removal
const CHEST_OPEN_DUR = 0.4;      // seconds the 3-frame chest-open clip plays, then holds
const BARREL_EXPLOSION_RADIUS = 70;
const BARREL_EXPLOSION_DAMAGE = 6;
const BARREL_EXPLOSION_SELF_DMG = 2; // damage dealt to a player caught in the blast

const PROP_HP: Record<PropKind, number> = {
  crate: 4, pot: 1, barrel: 3, barrel_explosive: 3, brazier: 0,
};
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
  private onExit: () => void;
  private pause: PauseOverlay;
  private blessing: BlessingOverlay;
  private isPaused = false;
  private isChoosing = false; // a between-floor blessing overlay is up (freezes the sim)

  private dungeon!: Dungeon;
  private floor = 1;
  private seed = 0;
  private kills = 0;
  private coins = 0;
  // Kill-chain combo: driven purely by this client's own kills (like `kills`/`coins`),
  // never networked. `comboTimer` drains each frame and resets the chain when it lapses.
  private combo = 0;
  private comboTimer = 0;
  private comboFreeze = false; // dev/sandbox: hold the chain at a set value so the HUD can be gated

  // player
  private px = 0; private py = 0;
  private pr = 18;
  private hp = 6; private maxHp = 6;
  private mods: PlayerMods = createMods();
  private ownedItems: ItemDef[] = [];
  private invuln = 0;
  private dashCd = 0; private dashTime = 0; private dashDx = 0; private dashDy = 0;
  private fireCd = 0;
  private isAutoFiring = false; // autofire mode only: click toggles continuous fire (settings.isAutofire)
  private facing = 1;
  private weapon: WeaponId = DEFAULT_WEAPON;
  private aimAngle = 0;
  private shotSeq = 0;
  private isDown = false;

  private enemies: Enemy[] = [];
  // Shared enemy pathfinding field + its throttle/keying state. Sources buffer is
  // reused across rebuilds (length reset, not reallocated) to stay off the GC.
  private flow = new FlowField();
  private flowCd = 0;
  private flowKeyTx = -1;
  private flowKeyTy = -1;
  private flowSources: number[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];
  private dmgNumbers: DmgNumber[] = [];  // floating damage popups (visual only)
  private pickups: Pickup[] = [];
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
  private meleeSwing: MeleeSwing | null = null;

  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, isDown: false };
  private cam = { x: 0, y: 0 };
  // Scratch slot for the nearest living player, written by findTarget each query so
  // enemy AI never allocates a result object in the per-frame hot path.
  private targetX = 0;
  private targetY = 0;

  private isRunning = false;
  private last = 0;
  private raf = 0;
  private runStart = 0;
  private animClock = 0; // wall-clock seconds for prop/ambient animation (torch, portal)
  // Per-biome side-face gradients for the extruded wall look (built once). Indexed by biome.
  private wallSideGrads: [CanvasGradient, CanvasGradient][] = [];
  private currentBiome: Biome = biomeForFloor(1);
  private biomeIdx = 0;
  private torches: { tx: number; ty: number }[] = []; // wall-mounted torch cells, per floor
  private props: Prop[] = [];   // destructible/atmosphere props, seeded per floor
  private chests: Chest[] = []; // touch-to-open treasure, seeded per floor
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

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, hudRoot: HTMLElement, onGameOver: (result: RunResult) => void, onExit: () => void) {
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
    this.canvas.addEventListener("mousedown", (e) => {
      this.mouse.isDown = true;
      // Autofire: a left-click toggles continuous fire instead of requiring a hold.
      if (settings.isAutofire && !this.isDown && e.button === 0) this.isAutoFiring = !this.isAutoFiring;
    });
    window.addEventListener("mouseup", () => (this.mouse.isDown = false));
  }

  start(opts: StartOptions) {
    this.coop = opts.coop ?? null;
    this.profile = opts.profile ?? null;
    this.floor = this.coop ? this.coop.getFloor() : 1;
    this.seed = this.coop ? this.coop.getSeed() : randomSeed();
    this.kills = 0;
    this.coins = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.mods = createMods();
    this.ownedItems = [];
    this.maxHp = BASE_MAX_HP;
    this.hp = this.maxHp;
    this.weapon = DEFAULT_WEAPON;
    this.isDown = false;
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
    this.pause.hide();
    this.blessing.hide();
    audio.unlock();
    this.corpses = [];
    this.muzzle.t = 0;
    resetAnim(this.playerAnim);
    this.isPlayerMoving = false;
    this.playerLean = 0;
    this.runStart = performance.now();
    this.loadFloor();
    this.hud.setVisible(true);
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
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
    cancelAnimationFrame(this.raf);
  }

  private loadFloor() {
    this.biomeIdx = biomeIndexForFloor(this.floor);
    this.currentBiome = biomeForFloor(this.floor);
    // Dev sandbox loads a single open arena and stays empty until the dev spawns things.
    this.dungeon = this.isSandbox ? this.buildArena() : generateDungeon(this.seed, this.floor);
    const d = this.dungeon;
    this.px = d.spawn.x * TILE + TILE / 2;
    this.py = d.spawn.y * TILE + TILE / 2;
    this.bullets = [];
    this.particles = [];
    this.dmgNumbers = [];
    this.remoteTracers = [];
    this.corpses = [];
    this.decals = [];
    this.afterimages = [];
    this.muzzle.t = 0;
    this.enemies = this.isSandbox ? [] : spawnFloorEnemies(d, this.seed, this.floor);
    // Force a fresh flow field on the new grid before the first enemy update.
    this.flowCd = 0;
    this.flowKeyTx = -1;
    this.flowKeyTy = -1;
    this.pickups = this.isSandbox ? [] : this.placeWeaponPickups(d);
    this.torches = this.placeTorches(d);
    this.props = this.isSandbox ? [] : this.placeProps(d);
    this.chests = this.isSandbox ? [] : this.placeChests(d);
    const isBoss = isBossFloor(this.floor);
    audio.setMusic(isBoss ? "boss" : "dungeon");
    if (isBoss) { sfx("bossSpawn"); this.addTrauma(TRAUMA_BOSS_FLOOR); }
  }

  private placeWeaponPickups(d: Dungeon): Pickup[] {
    if (this.floor < 2 || d.rooms.length <= 2) return [];
    const rng = new Rng((this.seed ^ 0x51ed270b) + this.floor * 40503);
    const drops: Pickup[] = [];
    // Always one weapon pickup from floor 2 (so the other weapons get discovered early),
    // with a good chance of a second from floor 3 on.
    const kinds: WeaponId[] = [rng.pick(PICKUP_WEAPONS)];
    if (this.floor >= 3 && rng.chance(0.6)) kinds.push(rng.pick(PICKUP_WEAPONS));
    for (const weapon of kinds) {
      const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
      drops.push({
        kind: "weapon",
        x: (room.cx + 0.5) * TILE,
        y: (room.cy + 0.5) * TILE,
        radius: 16,
        weapon,
        anim: createAnim(),
      });
    }
    return drops;
  }

  // Mount a torch on the wall directly above each room (facing into it), at a
  // deterministic column. Roughly one per room -> a handful on screen, no per-frame cost.
  private placeTorches(d: Dungeon): { tx: number; ty: number }[] {
    const list: { tx: number; ty: number }[] = [];
    const rng = new Rng((this.seed ^ 0x7f4a7c15) + this.floor * 92821);
    for (const room of d.rooms) {
      const ty = room.y - 1;
      if (ty < 0) continue;
      const tx = room.x + 1 + rng.int(0, Math.max(0, room.w - 3));
      const isWall = d.tiles[ty * d.w + tx] === 1;
      const isFloorBelow = d.tiles[(ty + 1) * d.w + tx] === 0;
      if (isWall && isFloorBelow) list.push({ tx, ty });
    }
    return list;
  }

  // Scatter ~2-5 props across each room on a deterministic seed (same salt+prime pattern
  // as placeWeaponPickups/placeTorches) so every co-op client agrees on the layout. The
  // spawn point and the exit tile (plus their immediate neighbors) are kept clear.
  private placeProps(d: Dungeon): Prop[] {
    const rng = new Rng((this.seed ^ 0x2f6a35c1) + this.floor * 26417);
    const list: Prop[] = [];
    const occupied = new Set<number>();
    for (const room of d.rooms) {
      const target = rng.int(3, 6);
      for (let i = 0; i < target; i++) {
        const tx = room.x + rng.int(0, room.w - 1);
        const ty = room.y + rng.int(0, room.h - 1);
        const idx = ty * d.w + tx;
        if (occupied.has(idx) || d.tiles[idx] !== 0) continue;
        if (Math.abs(tx - d.spawn.x) <= 1 && Math.abs(ty - d.spawn.y) <= 1) continue;
        if (Math.abs(tx - d.exit.x) <= 1 && Math.abs(ty - d.exit.y) <= 1) continue;
        occupied.add(idx);
        const kind = this.rollPropKind(rng);
        list.push({ kind, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: PROP_RADIUS, hp: PROP_HP[kind], dead: false, anim: createAnim() });
      }
    }
    return list;
  }

  private rollPropKind(rng: Rng): PropKind {
    const r = rng.next();
    if (r < 0.34) return "pot";              // one-shot tactile juice
    if (r < 0.62) return "crate";            // sturdiest, best loot
    if (r < 0.84) return "barrel";
    if (r < 0.94) return "barrel_explosive"; // the environmental weapon
    return "brazier";                        // atmosphere + light source
  }

  // Wood chests in 1-2 non-spawn rooms (mirrors placeWeaponPickups' seeded room pick). At
  // least one wood chest is guaranteed on every floor, including floor 1 — if every roll
  // lands on the spawn/exit tile we fall back to scanning rooms for a free floor tile. The
  // boss chest is spawned on boss death instead (see dropLoot).
  private placeChests(d: Dungeon): Chest[] {
    if (d.rooms.length < 2) return [];
    const rng = new Rng((this.seed ^ 0x1b3c9e77) + this.floor * 55697);
    const list: Chest[] = [];
    const used = new Set<number>();
    const count = rng.chance(0.5) ? 2 : 1;
    const addChest = (tx: number, ty: number) => {
      used.add(ty * d.w + tx);
      list.push({ kind: "wood", x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: 16, opened: false, anim: createAnim() });
    };
    const treasure = d.rooms.find((r) => r.kind === "treasure");
    let remaining = count;
    if (treasure) {
      const spot = this.chestTile(d, treasure, used);
      if (spot) {
        addChest(spot.tx, spot.ty);
        remaining--;
      }
    }
    for (let i = 0; i < remaining; i++) {
      const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
      const spot = this.chestTile(d, room, used);
      if (spot) addChest(spot.tx, spot.ty);
    }
    // Guarantee a minimum of one: scan the non-spawn rooms for any free floor tile.
    if (list.length === 0) {
      for (let ri = 1; ri < d.rooms.length; ri++) {
        const spot = this.chestTile(d, d.rooms[ri], used);
        if (spot) { addChest(spot.tx, spot.ty); break; }
      }
    }
    return list;
  }

  // A free floor tile for a chest in the given room: prefer the room center, else scan.
  // Skips walls, already-used tiles, and the spawn/exit tiles so chests stay reachable
  // and never block the exit portal.
  private chestTile(d: Dungeon, room: Room, used: Set<number>): { tx: number; ty: number } | null {
    const isBad = (tx: number, ty: number) =>
      d.tiles[ty * d.w + tx] !== 0 ||
      used.has(ty * d.w + tx) ||
      (tx === d.spawn.x && ty === d.spawn.y) ||
      (tx === d.exit.x && ty === d.exit.y);
    if (!isBad(room.cx, room.cy)) return { tx: room.cx, ty: room.cy };
    for (let ty = room.y; ty < room.y + room.h; ty++)
      for (let tx = room.x; tx < room.x + room.w; tx++)
        if (!isBad(tx, ty)) return { tx, ty };
    return null;
  }

  private isWall(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) return true;
    return this.dungeon.tiles[ty * this.dungeon.w + tx] === 1;
  }

  private moveCircle(x: number, y: number, r: number, dx: number, dy: number): [number, number] {
    const nx = x + dx, ny = y + dy;
    if (!this.isWall(nx + Math.sign(dx) * r, y) && !this.blockedByProp(nx, y, r)) x = nx;
    if (!this.isWall(x, ny + Math.sign(dy) * r) && !this.blockedByProp(x, ny, r)) y = ny;
    return [x, y];
  }

  // Solid props (crates/barrels/pots/brazier) block movement — you bump into them and
  // can use them as cover, instead of walking through. Circle-vs-circle overlap test.
  private blockedByProp(x: number, y: number, r: number): boolean {
    for (const p of this.props) {
      if (p.dead) continue;
      const rr = r + p.radius * 0.8; // 0.8 so you can brush past edges, not a hard square
      const ddx = x - p.x, ddy = y - p.y;
      if (ddx * ddx + ddy * ddy < rr * rr) return true;
    }
    return false;
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
      this.update(dt);
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

  private quitToMenu() {
    this.setPaused(false);
    this.stop();
    audio.setMusic(null);
    this.hud.hideStats();
    this.hud.clear();
    this.onExit();
  }

  private addFreeze(seconds: number) {
    this.freeze = Math.min(FREEZE_MAX, Math.max(this.freeze, seconds));
  }

  private addTrauma(amount: number) {
    const t = this.trauma + amount;
    this.trauma = t > 1 ? 1 : t;
  }

  private applyKnockbackDir(e: Enemy, dirX: number, dirY: number) {
    const sp = Math.hypot(dirX, dirY) || 1;
    const v = (WEAPON_KB[this.weapon] * KB_LAMBDA) / ENEMY_ARCHETYPES[e.kind].kbResist;
    e.vx += (dirX / sp) * v;
    e.vy += (dirY / sp) * v;
    const mag = Math.hypot(e.vx, e.vy);
    if (mag > KB_MAX_SPEED) { const s = KB_MAX_SPEED / mag; e.vx *= s; e.vy *= s; }
  }

  private strikeEnemy(e: Enemy, hit: StrikeInfo) {
    const isFrozen = this.isFrozen(e);
    const dmg = hit.damage * (e.shock > 0 ? SHOCK_DMG_MULT : 1) * (isFrozen ? FROZEN_DMG_MULT : 1);
    e.hp -= dmg;
    triggerFlash(e.anim);
    this.spawnDmgNumber(e.x, e.y - e.radius, dmg, { crit: hit.isCrit });
    this.spawnPuff(hit.puffX, hit.puffY, hit.isCrit ? 9 : 5, hit.isCrit ? "#fff3c4" : ENEMY_ARCHETYPES[e.kind].tint);
    this.applyKnockbackDir(e, hit.kbDirX, hit.kbDirY);
    this.applyHitStatuses(e, hit);
    if (e.shock > 0) this.shockArc(e);
    if (!hit.isMelee && this.weapon === "shotgun" && Math.hypot(this.px - e.x, this.py - e.y) < 96) {
      this.addFreeze(FREEZE_SHOTGUN);
    }
    if (hit.isMelee) {
      this.addTrauma(MELEE_HIT_TRAUMA);
      this.addFreeze(FREEZE_KILL);
    }
    if (e.hp <= 0 && !e.dead) this.killEnemy(e);
    else sfx(hit.isMelee ? "meleeHit" : "enemyHit", { gain: hit.isMelee ? 0.9 : 0.65 });
  }

  private update(dt: number) {
    if (this.coop) this.syncCoop(dt);

    const wx = this.mouse.x + this.cam.x, wy = this.mouse.y + this.cam.y;
    this.aimAngle = Math.atan2(wy - this.py, wx - this.px);

    if (!this.isDown) {
      this.updatePlayer(dt);
      this.updateShooting(dt);
    } else {
      this.isPlayerMoving = false;
    }
    if (this.meleeSwing) {
      this.meleeSwing.timer -= dt;
      if (this.meleeSwing.timer <= 0) this.meleeSwing = null;
    }
    stepAnim(this.playerAnim, dt, this.isPlayerMoving, this.playerLean);
    this.updateBullets(dt);
    this.updateEnemies(dt);
    this.updateProps(dt);
    this.updateChests(dt);
    this.updatePickups(dt);
    this.updateParticles(dt);
    this.updateDmgNumbers(dt);
    this.updateTracers(dt);
    this.updateCorpses(dt);
    this.updateDecals(dt);
    this.updateAfterimages(dt);
    if (this.muzzle.t > 0) this.muzzle.t = Math.max(0, this.muzzle.t - dt);
    if (this.coop) this.updateRemoteAnims(dt);
    this.updateExit();
    if (this.comboTimer > 0 && !this.comboFreeze) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.comboTimer = 0; this.combo = 0; } // chain lapsed: reset
    }
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);
    const ke = Math.min(1, dt * KICK_DECAY);
    this.kickX -= this.kickX * ke; this.kickY -= this.kickY * ke;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * HURT_FLASH_DECAY);

    this.cam.x = this.px - this.canvas.width / 2;
    this.cam.y = this.py - this.canvas.height / 2;

    // Always publish while in a room (including down=true) so teammates can see us
    // fall and come revive; revive detection is nonce-based, so this is race-free.
    if (this.coop) this.publishPresence();
    this.updateHud();
    if (this.isStatsHeld) this.openStats();
  }

  private updatePlayer(dt: number) {
    let ix = 0, iy = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) iy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) iy += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) ix -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) ix += 1;
    const len = Math.hypot(ix, iy) || 1;
    ix /= len; iy /= len;
    if (ix !== 0) this.facing = ix > 0 ? 1 : -1;

    const speed = 200 * this.mods.moveSpeedMult;
    this.dashCd = Math.max(0, this.dashCd - dt);
    if (this.keys.has("shift") && this.dashCd === 0 && (ix || iy)) {
      this.dashTime = 0.16; this.dashCd = this.dashCooldown(); this.dashDx = ix; this.dashDy = iy;
      this.invuln = Math.max(this.invuln, 0.35); // real "get out of jail" dodge window
      this.dashImgCd = 0;
      this.spawnParticles(this.px, this.py, 10, "#ffd27a"); // takeoff puff
      sfx("dash");
    }
    let mvx: number, mvy: number;
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      mvx = this.dashDx * 620 * dt; mvy = this.dashDy * 620 * dt;
      this.spawnParticles(this.px, this.py, 1, "#ffd27a");
      this.dashImgCd -= dt;
      if (this.dashImgCd <= 0) { this.afterimages.push({ x: this.px, y: this.py, facing: this.facing, t: 0 }); this.dashImgCd = 0.04; }
    } else {
      mvx = ix * speed * dt; mvy = iy * speed * dt;
    }
    [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, mvx, 0);
    [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, 0, mvy);
    // A dash smashes through any prop it passes over. The 0.35s dash i-frames mean an
    // explosive barrel popped this way won't hurt the dasher — a clean risk/reward beat.
    if (this.dashTime > 0 && this.props.length > 0) this.dashBreakProps();
    this.invuln = Math.max(0, this.invuln - dt);
    this.isPlayerMoving = ix !== 0 || iy !== 0;
    this.playerLean = ix;
  }

  private updateShooting(dt: number) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    // Hold-to-fire owns firing when autofire is off; drop any stale toggle state.
    if (!settings.isAutofire) this.isAutoFiring = false;
    const isFiring = settings.isAutofire ? this.isAutoFiring : this.mouse.isDown;
    if (isFiring && this.fireCd === 0) {
      const w = WEAPONS[this.weapon];
      if (w.melee) {
        this.startMeleeSwing(w);
        return;
      }
      const muzzleX = this.px + Math.cos(this.aimAngle) * 18;
      const muzzleY = this.py + Math.sin(this.aimAngle) * 18;
      const spec = this.resolveShot(w);
      for (const b of fire(spec, muzzleX, muzzleY, this.aimAngle)) this.bullets.push(b);
      this.fireCd = w.fireCd / this.currentFireRate();
      this.shotSeq++;
      triggerRecoil(this.playerAnim, FIRE_RECOIL[this.weapon]);
      this.muzzle.t = MUZZLE_DUR; this.muzzle.x = muzzleX; this.muzzle.y = muzzleY; this.muzzle.angle = this.aimAngle; this.muzzle.size = w.muzzle; this.muzzle.color = w.color;
      this.spawnParticles(muzzleX, muzzleY, w.muzzle, "#ffe6a0");
      if (this.weapon !== "rapid" && this.weapon !== "flamer") this.spawnShell(this.px, this.py - 6, this.aimAngle);
      sfx(SHOOT_SFX[this.weapon]);
      this.addTrauma(FIRE_TRAUMA[this.weapon]);
      const kick = FIRE_KICK[this.weapon];
      this.kickX += -Math.cos(this.aimAngle) * kick;
      this.kickY += -Math.sin(this.aimAngle) * kick;
      const kb = FIRE_KNOCKBACK[this.weapon];
      if (kb !== 0) {
        [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, -Math.cos(this.aimAngle) * kb, 0);
        [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, 0, -Math.sin(this.aimAngle) * kb);
      }
    }
  }

  private startMeleeSwing(w: (typeof WEAPONS)[WeaponId]) {
    const m = w.melee;
    if (!m) return;
    const isCrit = this.mods.critChance > 0 && Math.random() < this.mods.critChance;
    const baseDmg = w.damage * this.currentDamageMult();
    this.meleeSwing = {
      timer: m.swingDur ?? 0.2,
      duration: m.swingDur ?? 0.2,
      aim: this.aimAngle,
      arc: m.arc,
      reach: m.reach,
      isThrust: m.isThrust === true,
      color: w.color,
      damage: isCrit ? baseDmg * this.mods.critMult : baseDmg,
      isCrit,
      hitList: null,
      burn: w.burn,
      chill: w.chill,
      shock: w.shock,
    };
    this.fireCd = w.fireCd / this.currentFireRate();
    this.shotSeq++;
    triggerRecoil(this.playerAnim, FIRE_RECOIL[this.weapon]);
    this.spawnSlashWind(m, w.color); // wind/dust flung along the swing arc
    sfx(SHOOT_SFX[this.weapon]);
    this.addTrauma(FIRE_TRAUMA[this.weapon]);
    const kick = FIRE_KICK[this.weapon];
    this.kickX += -Math.cos(this.aimAngle) * kick;
    this.kickY += -Math.sin(this.aimAngle) * kick;
    const kb = FIRE_KNOCKBACK[this.weapon];
    if (kb !== 0) {
      [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, -Math.cos(this.aimAngle) * kb, 0);
      [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, 0, -Math.sin(this.aimAngle) * kb);
    }
    this.spawnParticles(this.px + Math.cos(this.aimAngle) * 14, this.py + Math.sin(this.aimAngle) * 14, 4, w.color);
  }

  private isMeleeHit(e: Enemy, swing: MeleeSwing): boolean {
    const dx = e.x - this.px;
    const dy = e.y - this.py;
    const dist = Math.hypot(dx, dy);
    if (dist > swing.reach + e.radius) return false;
    const cos = Math.cos(swing.aim);
    const sin = Math.sin(swing.aim);
    if (swing.isThrust) {
      const fwd = dx * cos + dy * sin;
      if (fwd < -e.radius * 0.4 || fwd > swing.reach + e.radius) return false;
      const lat = Math.abs(dx * sin - dy * cos);
      return lat < MELEE_THRUST_WIDTH + e.radius;
    }
    let ang = Math.atan2(dy, dx) - swing.aim;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    const angPad = Math.atan2(e.radius, Math.max(dist, 1));
    return Math.abs(ang) <= swing.arc * 0.5 + angPad;
  }

  // ---- in-run item mods ----

  // How empty the health bar is, 0 (full) .. 1 (near death) — drives the low-HP scalers.
  private lowHpFactor(): number {
    return this.maxHp > 0 ? 1 - Math.max(0, this.hp / this.maxHp) : 0;
  }

  private currentDamageMult(): number {
    return this.mods.damageMult + this.mods.berserk * this.lowHpFactor();
  }

  private currentFireRate(): number {
    return Math.max(0.25, this.mods.fireRateMult + this.mods.adrenaline * this.lowHpFactor());
  }

  private dashCooldown(): number {
    return DASH_COOLDOWN * this.mods.dashCdMult;
  }

  // Merge the base weapon with the run's item mods into a concrete shot.
  private resolveShot(w: (typeof WEAPONS)[WeaponId]): ShotSpec {
    const pellets = w.pellets + this.mods.extraPellets;
    const spread = pellets > 1 ? Math.max(w.spread, MIN_MULTI_SPREAD) + this.mods.spreadAdd : w.spread;
    return {
      pellets,
      spread,
      speed: w.speed * this.mods.bulletSpeedMult,
      life: w.life * this.mods.bulletLifeMult,
      radius: w.bulletRadius * this.mods.bulletSizeMult,
      color: w.color,
      damage: w.damage * this.currentDamageMult(),
      pierce: this.mods.pierce,
      critChance: this.mods.critChance,
      critMult: this.mods.critMult,
      fx: w.id,
      bounce: w.bounce,
      homing: w.homing,
      chain: w.chain,
      chainRange: w.chainRange,
      burn: w.burn,
      chill: w.chill,
      shock: w.shock,
    };
  }

  // Present three blessings and freeze until the player picks one. Called on every
  // descend (per client). Co-op note: items are purely local run-stat modifiers, so
  // each client picks its OWN blessings — nothing is networked. The shared floor sync
  // means a teammate descending pulls us through descend() too, so we never skip our
  // pick, and this freeze is the same one co-op already tolerates via the Esc pause.
  private offerBlessing() {
    const choices = rollItemChoices(3);
    if (choices.length === 0) return;
    this.isChoosing = true;
    this.isPaused = false;
    this.mouse.isDown = false;
    this.blessing.show(choices, (item) => {
      this.applyItem(item);
      this.isChoosing = false;
      this.last = performance.now(); // avoid a huge catch-up dt after the freeze
    });
  }

  private applyItem(item: ItemDef) {
    item.apply(this.mods);
    this.ownedItems.push(item);
    this.applyMaxHpBonus();
    sfx("weapon");
    this.spawnParticles(this.px, this.py, 20, item.tint);
    this.addTrauma(0.12);
  }

  // Re-derive max HP from the base + item bonus. Extra hearts come pre-filled; a
  // reduction (Glass Cannon) trims the bar but never drops the player below 1.
  private applyMaxHpBonus() {
    const next = Math.max(1, BASE_MAX_HP + this.mods.maxHpBonus);
    if (next > this.maxHp) this.hp += next - this.maxHp;
    this.maxHp = next;
    if (this.hp > this.maxHp) this.hp = this.maxHp;
    if (this.hp < 1) this.hp = 1;
  }

  private coinGain(): number {
    return Math.max(1, Math.round(this.mods.coinMult));
  }

  private comboTier(): ComboTier {
    for (const t of COMBO_TIERS) if (this.combo >= t.min) return t;
    return COMBO_TIERS[COMBO_TIERS.length - 1];
  }

  private comboMult(): number {
    return this.comboTier().mult;
  }

  private comboCoinValue(): number {
    // Base coin gain scaled by the live combo multiplier (props/chests drop face value).
    return Math.max(1, Math.round(this.coinGain() * this.comboMult()));
  }

  private updateBullets(dt: number) {
    for (const b of this.bullets) {
      if (b.friendly && b.homing !== undefined) this.steerHoming(b, dt);
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      // Walls kill any bullet — for enemy fire that IS the line-of-sight counterplay —
      // unless it's a ricochet round with bounces left, which reflects and flies on.
      if (this.isWall(b.x, b.y)) {
        if (b.bounce !== undefined && b.bounce > 0) { this.bounceOffWall(b, dt); continue; }
        b.life = 0; this.spawnSparks(b.x, b.y, 5, Math.atan2(-b.vy, -b.vx)); continue;
      }
      // Enemy projectiles vs. the local player. invuln re-checked per bullet so a
      // radial burst can't multi-hit through one set of i-frames.
      if (!b.friendly && this.invuln === 0 && !this.isDown && this.hp > 0
        && Math.hypot(this.px - b.x, this.py - b.y) < this.pr + b.radius) {
        b.life = 0;
        this.spawnPuff(b.x, b.y, 6, b.color);
        this.damagePlayer(b.damage);
      }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);
  }

  // HOMING (Wisp): rotate a bullet's velocity toward the nearest living enemy in range,
  // capped at its turn rate so it can't snap into an impossible U-turn, keeping speed
  // constant. Same nearest-enemy scan the enemy AI uses; runs only on homing bullets.
  private steerHoming(b: Bullet, dt: number) {
    const rate = b.homing;
    if (rate === undefined || rate <= 0) return;
    const RANGE = 260;
    let best: Enemy | null = null;
    let bestD = RANGE * RANGE;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.x - b.x, dy = e.y - b.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
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
    b.vx = Math.cos(a) * speed; b.vy = Math.sin(a) * speed;
  }

  // RICOCHET (Rebound): reflect a bullet off the wall it just entered instead of dying.
  // Probes each axis at the pre-move position to pick the reflect axis (corner = both),
  // steps back out of the wall, spends one bounce, and sparks so the deflect reads.
  private bounceOffWall(b: Bullet, dt: number) {
    const px = b.x - b.vx * dt, py = b.y - b.vy * dt;
    let reflected = false;
    if (this.isWall(b.x, py)) { b.vx = -b.vx; reflected = true; }
    if (this.isWall(px, b.y)) { b.vy = -b.vy; reflected = true; }
    if (!reflected) { b.vx = -b.vx; b.vy = -b.vy; }
    b.x = px; b.y = py;
    b.bounce = (b.bounce ?? 0) - 1;
    this.spawnSparks(b.x, b.y, 3, Math.atan2(b.vy, b.vx));
    this.spawnSparkFlash(b.x, b.y, b.color);
  }

  private spawnSparkFlash(x: number, y: number, color: string) {
    // A single bright sprite spark that pops and fades where a ricochet round hits a wall.
    const life = 0.16;
    this.particles.push({
      x, y, vx: 0, vy: 0,
      life, maxLife: life, color,
      size: 22, kind: "sparkfx", rot: Math.random() * 6.28, vr: 0, gravity: 0, drag: 1,
    });
  }

  private updateEnemies(dt: number) {
    // One presence snapshot per frame (not per enemy) — enemy AI targets the nearest
    // living player, which in co-op splits aggro instead of dogpiling one client.
    const remotes = this.coop ? this.coop.remotePlayers() : null;
    this.refreshFlowField(dt, remotes);
    for (const e of this.enemies) {
      this.tickStatuses(e, dt);
      if (e.dead) continue; // burn can kill; skip the rest of this frame for the corpse
      if (e.spawnTimer > 0) e.spawnTimer = e.spawnTimer > dt ? e.spawnTimer - dt : 0;
      if (e.attack.cooldown > 0) e.attack.cooldown = e.attack.cooldown > dt ? e.attack.cooldown - dt : 0;

      const angle = this.updateEnemyAI(e, dt, remotes);
      this.applyKnockbackDecay(e, dt);

      // A charging / recovering enemy holds still; a lunging skeleton is moving fast.
      const isMoving = e.attack.phase === "none" || (e.attack.phase === "active" && e.attack.move === "lunge");
      stepAnim(e.anim, dt, isMoving, Math.cos(angle));

      if (this.invuln === 0 && !this.isDown && this.hp > 0
        && Math.hypot(this.px - e.x, this.py - e.y) < this.pr + e.radius && this.canTouchDamage(e)) {
        this.damagePlayer(e.touchDamage);
        if (e.kind === "skeleton" && e.attack.phase === "active") this.lungeImpact(e);
        this.applyThorns(e);
        if (this.hp <= 0 && !this.coop) return;
      }

      for (const b of this.bullets) {
        if (!b.friendly) continue;
        if (b.hitList && b.hitList.indexOf(e) !== -1) continue; // already pierced this one
        if (Math.hypot(b.x - e.x, b.y - e.y) < b.radius + e.radius) {
          this.strikeEnemy(e, {
            damage: b.damage,
            isCrit: b.isCrit,
            puffX: b.x,
            puffY: b.y,
            kbDirX: b.vx,
            kbDirY: b.vy,
            burn: b.burn,
            chill: b.chill,
            shock: b.shock,
            isMelee: false,
          });
          // TESLA (Tesla): the round dies on its first hit, but first arcs lightning to
          // nearby enemies. Reuses hitList (the pierce dedup) so an arc never doubles back.
          if (b.chain !== undefined && b.chain > 0) {
            (b.hitList ??= []).push(e);
            this.chainLightning(b, e);
            b.life = 0;
          } else if (b.pierce > 0) { b.pierce--; (b.hitList ??= []).push(e); }
          else b.life = 0;
        }
      }

      const swing = this.meleeSwing;
      if (swing && swing.timer > 0) {
        if (swing.hitList && swing.hitList.indexOf(e) !== -1) continue;
        if (this.isMeleeHit(e, swing)) {
          const kbDirX = Math.cos(swing.aim);
          const kbDirY = Math.sin(swing.aim);
          const puffDist = swing.isThrust ? swing.reach * 0.65 : swing.reach * 0.55;
          this.strikeEnemy(e, {
            damage: swing.damage,
            isCrit: swing.isCrit,
            puffX: this.px + kbDirX * puffDist,
            puffY: this.py + kbDirY * puffDist,
            kbDirX,
            kbDirY,
            burn: swing.burn,
            chill: swing.chill,
            shock: swing.shock,
            isMelee: true,
          });
          (swing.hitList ??= []).push(e);
        }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  // ---- elemental status effects ----

  // Frozen solid: enough banked chill roots the enemy (speed 0) and opens the +50%
  // shatter window. Excluded for the boss so it can never be trivially locked down.
  private isFrozen(e: Enemy): boolean {
    return e.kind !== "boss" && e.chill >= FREEZE_AT;
  }

  // Movement multiplier from chill: frozen = 0 (rooted), chilled = half speed, else 1.
  // Applied at the single locomotion chokepoint (moveEnemyBy) so every AI path — chase,
  // lunge, kite, boss chase — and knockback all respect it with no per-call threading.
  private chillMoveScale(e: Enemy): number {
    if (e.chill <= 0) return 1;
    return this.isFrozen(e) ? 0 : CHILL_SLOW;
  }

  // Ticks the three statuses for one enemy. Burn is a DoT accumulator that can kill (it
  // calls killEnemy and bails); chill/shock just count down. A few ops per enemy/frame.
  private tickStatuses(e: Enemy, dt: number) {
    if (e.chill > 0) e.chill = e.chill > dt ? e.chill - dt : 0;
    if (e.shock > 0) e.shock = e.shock > dt ? e.shock - dt : 0;
    if (e.burn > 0) {
      e.burn = e.burn > dt ? e.burn - dt : 0;
      e.statusTick += dt;
      while (e.statusTick > BURN_TICK) {
        e.hp -= e.burnDmg * BURN_TICK;
        e.statusTick -= BURN_TICK;
        this.spawnDmgNumber(e.x, e.y - e.radius, e.burnDmg * BURN_TICK, { color: "#ff8a3b" });
        this.spawnEmber(e);
        if (e.hp <= 0) { this.killEnemy(e); break; }
      }
      if (e.burn === 0) { e.burnDmg = 0; e.statusTick = 0; }
    }
  }

  // Applies whatever status a round carries; else rolls the player's item chances. The
  // else-if means a flamethrower round (already burning) doesn't double-roll item burn.
  private applyHitStatuses(e: Enemy, src: { burn?: number; chill?: number; shock?: number }) {
    if (src.burn !== undefined) this.applyBurn(e, src.burn);
    else if (this.mods.burnChance > 0 && Math.random() < this.mods.burnChance) this.applyBurn(e, ITEM_BURN_SECS);
    if (src.chill !== undefined) this.applyChill(e, src.chill);
    else if (this.mods.chillChance > 0 && Math.random() < this.mods.chillChance) this.applyChill(e, ITEM_CHILL_SECS);
    if (src.shock !== undefined) this.applyShock(e, src.shock);
    else if (this.mods.shockChance > 0 && Math.random() < this.mods.shockChance) this.applyShock(e, ITEM_SHOCK_SECS);
  }

  // Burn: refresh duration, add a stack of DoT (capped). First application seeds burnDmg.
  private applyBurn(e: Enemy, secs: number) {
    if (secs > e.burn) e.burn = secs;
    e.burnDmg = Math.min(BURN_DMG_MAX, e.burnDmg + BURN_DMG_STACK);
  }

  // Chill: banks duration toward the freeze threshold (capped).
  private applyChill(e: Enemy, secs: number) {
    e.chill = Math.min(CHILL_MAX, e.chill + secs);
  }

  // Shock: refresh the shocked tag (damage amp + on-hit arc).
  private applyShock(e: Enemy, secs: number) {
    if (secs > e.shock) e.shock = secs;
  }

  // A shocked enemy that gets hit arcs a single small zap to one nearby enemy — reuses
  // the tesla arc core so it draws the same lightning tracer and shares the dedup model.
  // The seed list holds the source so the arc never zaps the enemy that spawned it.
  private shockArc(from: Enemy) {
    this.arcLightning(from, 1, SHOCK_ARC_RANGE, SHOCK_ARC_DMG, SHOCK_TINT, [from]);
  }

  // A little ember puff rising off a burning enemy (also the DoT tick's visual).
  private spawnEmber(e: Enemy) {
    this.particles.push({
      x: e.x + (Math.random() * 2 - 1) * e.radius * 0.6,
      y: e.y + (Math.random() * 2 - 1) * e.radius * 0.5,
      vx: (Math.random() * 2 - 1) * 24, vy: -40 - Math.random() * 50,
      life: 0.3 + Math.random() * 0.25, maxLife: 0.55,
      color: Math.random() < 0.5 ? BURN_TINT : "#ffd27a",
      size: 2 + Math.random() * 2, kind: "puff", rot: 0, vr: 0, gravity: -40, drag: 0.9,
    });
  }

  // Contact damage is kind-aware: a ghost only bites while fully solid; the boss is
  // harmless while airborne mid hop-slam (its landing shockwave is the real threat).
  private canTouchDamage(e: Enemy): boolean {
    if (e.kind === "ghost") return e.attack.windup >= GHOST_SOLID_AT;
    if (e.kind === "boss" && e.attack.move === "hopslam" && e.attack.phase === "active") return false;
    return true;
  }

  // A connecting skeleton lunge shoves the player along the lunge line and kicks harder.
  private lungeImpact(e: Enemy) {
    const push = 26, ang = e.attack.lockedAngle;
    [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, Math.cos(ang) * push, 0);
    [this.px, this.py] = this.moveCircle(this.px, this.py, this.pr, 0, Math.sin(ang) * push);
    this.addTrauma(0.16);
  }

  // Thorns: reflect flat damage onto whatever just touched the player. Shares the
  // player's i-frames, so a lingering enemy is only punished once per contact.
  private applyThorns(e: Enemy) {
    if (this.mods.thorns <= 0 || e.dead) return;
    e.hp -= this.mods.thorns;
    triggerFlash(e.anim);
    this.spawnDmgNumber(e.x, e.y - e.radius, this.mods.thorns, { color: "#c8b8ff" });
    this.spawnPuff(e.x, e.y, 5, ENEMY_ARCHETYPES[e.kind].tint);
    if (e.hp <= 0 && !e.dead) this.killEnemy(e);
  }

  // TESLA arc: hop from the struck enemy to the nearest un-hit enemy within chainRange,
  // drawing a lightning tracer and dealing reduced damage each jump, up to `chain` hops.
  // Shares the bullet's hitList so an arc never revisits an enemy. Nearest-target
  // resolution is local, so co-op clients may pick different arc paths — accepted visual
  // variance on already-fired bullets (see PR notes), never shared sim state.
  private chainLightning(b: Bullet, from: Enemy) {
    this.arcLightning(from, b.chain ?? 0, b.chainRange ?? 130, b.damage * 0.7, b.color, (b.hitList ??= []));
  }

  // Shared arc core for tesla chains AND shock arcs: hop from `origin` to the nearest
  // un-hit enemy within range, drawing the lightning tracer and dealing flat damage each
  // jump, up to `jumps` hops. `list` dedups (and seeds the source) so an arc never
  // revisits an enemy. Nearest-target resolution is local — co-op clients may pick
  // different arc paths, an accepted visual variance on already-resolved hits (never sim).
  private arcLightning(origin: Enemy, jumps: number, range: number, dmg: number, color: string, list: Enemy[]) {
    let cur: Enemy = origin;
    for (let j = 0; j < jumps; j++) {
      let best: Enemy | null = null;
      let bestD = range * range;
      for (const e of this.enemies) {
        if (e.dead || list.indexOf(e) !== -1) continue;
        const dx = e.x - cur.x, dy = e.y - cur.y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) break;
      this.remoteTracers.push({
        x: cur.x, y: cur.y,
        angle: Math.atan2(best.y - cur.y, best.x - cur.x),
        life: 0.12, color, len: Math.sqrt(bestD), isArc: true,
      });
      best.hp -= dmg;
      triggerFlash(best.anim);
      this.spawnDmgNumber(best.x, best.y - best.radius, dmg, { color });
      this.spawnPuff(best.x, best.y, 5, color);
      list.push(best);
      if (best.hp <= 0 && !best.dead) this.killEnemy(best);
      else this.sfxAt("enemyHit", best.x, best.y, { gain: 0.5, rate: 1.5 });
      cur = best;
    }
  }

  private updateEnemyAI(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    switch (e.kind) {
      case "spitter": return this.updateSpitter(e, dt, remotes);
      case "skeleton": return this.updateSkeleton(e, dt, remotes);
      case "ghost": return this.updateGhost(e, dt, remotes);
      case "boss": return this.updateBoss(e, dt, remotes);
      default: return this.updateChaser(e, dt, remotes);
    }
  }

  // SKELETON: chases, then commits a telegraphed lunge — coil, dash, then a punishable
  // dizzy recovery. Trigger needs proximity, a clear line, cooldown, and spawn grace.
  private updateSkeleton(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const a = e.attack;
    if (a.phase === "windup") {
      if (this.stepWindupTimer(e, dt, SKELETON_WINDUP, SKELETON_LOCK, remotes, false)) {
        a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = SKELETON_CD;
        this.sfxAt("dash", e.x, e.y, { gain: 0.85 }); // the lunge whoosh
        if (this.isNearCamera(e.x, e.y)) this.addTrauma(0.12);
      }
      return a.lockedAngle;
    }
    if (a.phase === "active") {
      a.time += dt;
      const step = SKELETON_LUNGE_SPEED * dt;
      this.moveEnemyBy(e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
      this.spawnPuff(e.x, e.y, 1, ENEMY_ARCHETYPES.skeleton.tint); // lunge trail
      if (a.time >= SKELETON_LUNGE_DUR) this.enterRecover(e);
      return a.lockedAngle;
    }
    if (a.phase === "recover") {
      a.time += dt;
      if (a.time >= SKELETON_RECOVER) this.enterIdle(e);
      return a.lockedAngle;
    }
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    const dx = this.targetX - e.x, dy = this.targetY - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    if (dist <= SKELETON_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
      && this.hasLineOfSight(e.x, e.y, this.targetX, this.targetY)) {
      this.beginWindup(e, "lunge");
      this.sfxAt("enemyHit", e.x, e.y, { rate: 0.5, gain: 0.6 }); // low coil tell
      return angle;
    }
    const chase = this.chaseAngle(e);
    this.applyChaseStep(e, dt, chase, e.speed * dt);
    return chase;
  }

  // Slime (chase) and bat (zigzag). Both now route via the flow field: they follow the
  // downhill gradient around walls, and only beeline once they have line of sight for a
  // precise final approach. The bat layers its erratic wobble on top of that direction,
  // and the slime pulses its speed into a hop cadence.
  private updateChaser(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const arch = ENEMY_ARCHETYPES[e.kind];
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    let angle = this.chaseAngle(e);
    if (arch.movement === "zigzag") { e.zig += dt * 5; angle += Math.sin(e.zig) * 0.9; }
    let step = e.speed * dt;
    if (e.kind === "slime") step *= this.slimeHopPulse(e);
    this.applyChaseStep(e, dt, angle, step);
    return angle;
  }

  // GHOST: phases through walls and only bites while fully solid. It stays translucent
  // (and harmless) until the player lingers within range, then materializes over 0.4s —
  // the opacity ramp is the whole tell. Always damageable by player fire (no alpha gate).
  private updateGhost(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const a = e.attack;
    const has = this.findTarget(e.x, e.y, remotes);
    const angle = has ? Math.atan2(this.targetY - e.y, this.targetX - e.x) : e.zig;
    const near = has && (this.targetX - e.x) ** 2 + (this.targetY - e.y) ** 2 <= GHOST_SOLID_RANGE * GHOST_SOLID_RANGE;
    const rate = dt / GHOST_SOLID_TIME;
    const prev = a.windup;
    a.windup = near ? Math.min(1, a.windup + rate) : Math.max(0, a.windup - rate);
    // Soft materialize cue the instant it turns lethal.
    if (prev < GHOST_SOLID_AT && a.windup >= GHOST_SOLID_AT) this.sfxAt("enemyHit", e.x, e.y, { gain: 0.35, rate: 1.7 }); // soft materialize tick
    const step = e.speed * dt;
    this.moveEnemyBy(e, Math.cos(angle) * step, Math.sin(angle) * step);
    return angle;
  }

  // SPITTER: a glass-cannon kiter. Backs off if crowded, closes if too far, and in the
  // mid band charges a telegraphed glob with a clear line of sight. See COMBAT_SPEC.md.
  private updateSpitter(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const a = e.attack;
    if (a.phase === "windup") {
      if (this.stepWindupTimer(e, dt, SPITTER_WINDUP, SPITTER_LOCK, remotes, false)) {
        this.spitterFire(e);
        this.enterRecover(e);
      }
      return a.lockedAngle;
    }
    if (a.phase === "recover") {
      a.time += dt;
      if (a.time >= SPITTER_RECOVER) this.enterIdle(e);
      return a.lockedAngle;
    }
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    const dx = this.targetX - e.x, dy = this.targetY - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    const toTarget = Math.atan2(dy, dx);
    if (dist >= SPITTER_FLEE && dist <= SPITTER_APPROACH && a.cooldown === 0 && e.spawnTimer === 0
      && this.hasLineOfSight(e.x, e.y, this.targetX, this.targetY)) {
      this.beginWindup(e, "spit");
      this.sfxAt("dash", e.x, e.y, { gain: 0.5, rate: 1.4 }); // airy charge-up
      return toTarget;
    }
    let dir = 0;
    if (dist < SPITTER_FLEE) dir = -1;        // too close: kite away
    else if (dist > SPITTER_APPROACH) dir = 1; // too far: close in
    if (dir !== 0) {
      const step = e.speed * dt * dir;
      this.moveEnemyBy(e, Math.cos(toTarget) * step, Math.sin(toTarget) * step);
    }
    return toTarget;
  }

  private spitterFire(e: Enemy) {
    const a = e.attack;
    const n = this.floor >= SPITTER_SPREAD_FLOOR ? 3 : 1;
    const mx = e.x + Math.cos(a.lockedAngle) * (e.radius + 4);
    const my = e.y + Math.sin(a.lockedAngle) * (e.radius + 4);
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i - 1) * GLOB_SPREAD;
      this.spawnEnemyBullet(mx, my, a.lockedAngle + off, 300, 7, 1, "#ff5a7a", 2.5);
    }
    a.cooldown = SPITTER_CD;
    this.sfxAt("shootRapid", e.x, e.y, { rate: 0.55, gain: 0.7 }); // low wet glob launch
    this.spawnPuff(mx, my, 6, "#ff5a7a");
  }

  // BOSS Slime King: a 3-HP-phase fight. It drips slimes throughout, hop-slams in every
  // phase, adds a radial glob burst at 66% HP, and frenzies (faster, +globs, +slimes)
  // under 33%. HP-threshold crossings interrupt into a non-invuln roar. See COMBAT_SPEC.
  private updateBoss(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const boss = e.boss;
    if (!boss) return e.zig;
    const a = e.attack;

    boss.minionTimer -= dt;
    if (boss.minionTimer <= 0) { boss.minionTimer = BOSS_MINION_CD; this.spawnBossMinion(e); }

    if (a.phase === "windup") return this.bossWindup(e, dt, remotes);
    if (a.phase === "active") return this.bossActive(e, dt);
    if (a.phase === "recover") {
      a.time += dt;
      const recDur = a.move === "hopslam" ? BOSS_HOPSLAM_RECOVER : BOSS_RADIAL_RECOVER;
      if (a.time >= recDur) this.enterIdle(e);
      return a.lockedAngle; // stationary, punishable
    }

    // Idle: roar into a new phase the moment HP crosses, else attack, else chase.
    const desired = this.bossPhaseFor(e);
    if (desired > boss.phase) {
      boss.phase = desired;
      this.beginWindup(e, "roar");
      triggerFlash(e.anim);
      this.sfxAt("bossSpawn", e.x, e.y); // reuse the boss spawn/roar cue for phase-ups
      this.addTrauma(TRAUMA_BOSS_FLOOR);
      return a.lockedAngle;
    }
    if (a.cooldown === 0 && e.spawnTimer === 0) { this.bossBeginAttack(e, boss); return a.lockedAngle; }
    return this.bossChase(e, dt, remotes);
  }

  private bossPhaseFor(e: Enemy): number {
    const r = e.hp / e.maxHp;
    return r > 0.66 ? 1 : r > 0.33 ? 2 : 3;
  }

  private bossBeginAttack(e: Enemy, boss: NonNullable<Enemy["boss"]>) {
    const useRadial = boss.phase >= 2 && boss.isNextRadial;
    if (boss.phase >= 2) boss.isNextRadial = !boss.isNextRadial;
    e.attack.cooldown = BOSS_ATTACK_CD[boss.phase];
    this.beginWindup(e, useRadial ? "radial" : "hopslam");
    this.sfxAt("enemyHit", e.x, e.y, { rate: useRadial ? 0.6 : 0.4, gain: 0.7 }); // heavy windup tell
  }

  private bossWindup(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const a = e.attack;
    if (a.move === "roar") {
      a.time += dt;
      a.windup = Math.min(1, a.time / BOSS_ROAR_DUR);
      if (a.time >= BOSS_ROAR_DUR) this.enterIdle(e);
      return a.lockedAngle;
    }
    if (a.move === "radial") {
      a.time += dt;
      a.windup = Math.min(1, a.time / BOSS_RADIAL_WINDUP);
      if (a.time >= BOSS_RADIAL_WINDUP) { this.bossRadialFire(e); this.enterRecover(e); }
      return a.lockedAngle;
    }
    // hop-slam: track + lock the target tile, then take off.
    if (this.stepWindupTimer(e, dt, BOSS_HOPSLAM_WINDUP, BOSS_HOPSLAM_LOCK, remotes, true)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      this.sfxAt("dash", e.x, e.y, { rate: 0.6, gain: 0.9 }); // heavy takeoff whoosh
    }
    return a.lockedAngle;
  }

  // Airborne arc: travels to the locked landing tile (ignoring geometry, it's in the
  // air) while windup doubles as 0..1 air progress for the render lift.
  private bossActive(e: Enemy, dt: number): number {
    const a = e.attack;
    a.time += dt;
    const prev = a.windup;
    a.windup = Math.min(1, a.time / BOSS_HOPSLAM_AIR);
    const rem = 1 - prev;
    if (rem > 0.0001) {
      const f = Math.min(1, (a.windup - prev) / rem);
      e.x += (a.markX - e.x) * f;
      e.y += (a.markY - e.y) * f;
    }
    if (a.time >= BOSS_HOPSLAM_AIR) { this.bossLand(e); this.enterRecover(e); }
    return a.lockedAngle;
  }

  private bossLand(e: Enemy) {
    const a = e.attack, boss = e.boss;
    const x = a.markX, y = a.markY;
    if (this.invuln === 0 && !this.isDown && this.hp > 0 && Math.hypot(this.px - x, this.py - y) < BOSS_SLAM_RADIUS) {
      this.damagePlayer(2);
    }
    this.addFreeze(FREEZE_HEAVY);
    this.addTrauma(TRAUMA_BOSS_SLAM);
    this.sfxAt("enemyDeath", x, y, { rate: 0.5 }); // heavy landing crunch
    this.spawnParticles(x, y, 22, "#ffd27a");
    this.spawnSparks(x, y, 12, 0);
    this.addDecal(x, y, "#ffb43b", BOSS_SLAM_RADIUS * 0.5, "splat");
    // Phase 3 frenzy: the landing also erupts globs and spits an extra pair of slimes.
    if (boss && boss.phase >= 3) {
      for (let i = 0; i < 4; i++) this.spawnEnemyBullet(x, y, (i / 4) * 6.28, 220, 7, 1, "#a24bff", 2.5);
      this.spawnBossMinion(e);
      this.spawnBossMinion(e);
    }
  }

  private bossRadialFire(e: Enemy) {
    const boss = e.boss;
    const parity = boss ? boss.burstParity : 0;
    if (boss) boss.burstParity = parity ^ 1;
    const base = parity ? Math.PI / BOSS_RADIAL_COUNT : 0; // alternate bursts offset +22.5°
    for (let i = 0; i < BOSS_RADIAL_COUNT; i++) {
      this.spawnEnemyBullet(e.x, e.y, base + (i / BOSS_RADIAL_COUNT) * 6.28, 260, 7, 1, "#a24bff", 2.6);
    }
    this.sfxAt("shootShotgun", e.x, e.y, { rate: 0.6, gain: 0.6 }); // radial ring blast
    this.addTrauma(0.2);
    this.spawnParticles(e.x, e.y, 12, "#c98bff");
  }

  private bossChase(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    const angle = Math.atan2(this.targetY - e.y, this.targetX - e.x);
    const mult = e.boss && e.boss.phase >= 3 ? 1.2 : 1; // phase 3: +20% speed
    const step = e.speed * mult * dt;
    this.moveEnemyBy(e, Math.cos(angle) * step, Math.sin(angle) * step);
    return angle;
  }

  private spawnBossMinion(e: Enemy) {
    if (this.enemies.length >= BOSS_MINION_CAP) return;
    triggerRecoil(e.anim); // pop on the spawn beat
    const a = Math.random() * Math.PI * 2;
    const mx = e.x + Math.cos(a) * (e.radius + 20);
    const my = e.y + Math.sin(a) * (e.radius + 20);
    if (this.isWall(mx, my)) return;
    this.enemies.push(createEnemy("slime", mx, my, this.floor));
    this.spawnParticles(mx, my, 8, "#a855f7");
    if (this.isNearCamera(e.x, e.y)) { sfx("enemyHit", { gain: 0.5, rate: 0.6 }); this.addTrauma(TRAUMA_BOSS_SLAM); }
  }

  // ---- shared attack helpers ----

  // Writes the nearest living player into targetX/targetY; false when none are up.
  private findTarget(x: number, y: number, remotes: RemotePlayer[] | null): boolean {
    let bestD = Infinity, found = false;
    if (!this.isDown && this.hp > 0) {
      const dx = this.px - x, dy = this.py - y;
      bestD = dx * dx + dy * dy;
      this.targetX = this.px; this.targetY = this.py; found = true;
    }
    if (remotes) {
      for (const r of remotes) {
        if (r.isDown) continue;
        const dx = r.x - x, dy = r.y - y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; this.targetX = r.x; this.targetY = r.y; found = true; }
      }
    }
    return found;
  }

  // Tile raycast: false if any wall sits between the two points. Ducking behind
  // geometry breaks a ranged attacker's shot — the core fairness affordance.
  private hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy) / (TILE * 0.5));
    if (steps <= 1) return !this.isWall(x1, y1);
    const sx = dx / steps, sy = dy / steps;
    let x = x0 + sx, y = y0 + sy;
    for (let i = 1; i < steps; i++) {
      if (this.isWall(x, y)) return false;
      x += sx; y += sy;
    }
    return true;
  }

  // Rebuilds the shared chase flow field, throttled to FLOW_REBUILD (or immediately
  // when the local player crosses a tile boundary, so the field never lags a sprint).
  // Multi-source over all living players → each enemy naturally paths to the nearest.
  private refreshFlowField(dt: number, remotes: RemotePlayer[] | null): void {
    this.flowCd -= dt;
    const d = this.dungeon;
    const isUp = !this.isDown && this.hp > 0;
    const ptx = Math.floor(this.px / TILE), pty = Math.floor(this.py / TILE);
    const tileChanged = isUp && (ptx !== this.flowKeyTx || pty !== this.flowKeyTy);
    if (this.flowCd > 0 && !tileChanged && this.flow.isReady()) return;
    this.flowCd = FLOW_REBUILD;
    this.flowKeyTx = ptx; this.flowKeyTy = pty;

    const srcs = this.flowSources;
    srcs.length = 0;
    if (isUp && ptx >= 0 && pty >= 0 && ptx < d.w && pty < d.h) srcs.push(pty * d.w + ptx);
    if (remotes) {
      for (const r of remotes) {
        if (r.isDown) continue;
        const rtx = Math.floor(r.x / TILE), rty = Math.floor(r.y / TILE);
        if (rtx < 0 || rty < 0 || rtx >= d.w || rty >= d.h) continue;
        srcs.push(rty * d.w + rtx);
      }
    }
    this.flow.build(d, srcs);
  }

  // Movement heading for a ground chaser (findTarget must have run first). With a clear
  // line of sight it beelines for a crisp melee approach; otherwise it follows the flow
  // field's downhill gradient around walls, falling back to a beeline only when no
  // gradient exists (same tile as the target, or walled off).
  private chaseAngle(e: Enemy): number {
    if (this.hasLineOfSight(e.x, e.y, this.targetX, this.targetY)) {
      return Math.atan2(this.targetY - e.y, this.targetX - e.x);
    }
    const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
    if (this.flow.sampleStep(tx, ty)) return Math.atan2(this.flow.step.dy, this.flow.step.dx);
    return Math.atan2(this.targetY - e.y, this.targetX - e.x);
  }

  // Gentle speed pulse for the slime, synced to its squash/stretch so it reads as a
  // deliberate hop toward you rather than a constant crawl. Mean 1× → balance intact.
  private slimeHopPulse(e: Enemy): number {
    return 1 + SLIME_HOP_AMOUNT * Math.sin(e.anim.clock * SLIME_HOP_FREQ);
  }

  // Moves a chaser along `angle`, then applies the anti-stuck net: if it kept trying to
  // move but barely progressed for STUCK_TIME, shove it perpendicular to slip past the
  // geometry (or another body) it's wedged on, so nothing ever freezes against a wall.
  private applyChaseStep(e: Enemy, dt: number, angle: number, step: number): void {
    const x0 = e.x, y0 = e.y;
    this.moveEnemyBy(e, Math.cos(angle) * step, Math.sin(angle) * step);
    const moved = Math.hypot(e.x - x0, e.y - y0);
    const isBlocked = step > STUCK_MIN_STEP && moved < step * STUCK_PROGRESS;
    e.stuckTimer = isBlocked ? e.stuckTimer + dt : 0;
    if (e.stuckTimer < STUCK_TIME) return;
    e.stuckTimer = 0;
    const side = Math.sin(e.zig) >= 0 ? 1 : -1; // bias the escape by the enemy's wobble
    if (!this.nudgeEnemy(e, angle + side * HALF_PI, step)) {
      this.nudgeEnemy(e, angle - side * HALF_PI, step);
    }
  }

  // One perpendicular escape attempt; returns whether it made meaningful progress.
  private nudgeEnemy(e: Enemy, angle: number, step: number): boolean {
    const x0 = e.x, y0 = e.y;
    this.moveEnemyBy(e, Math.cos(angle) * step, Math.sin(angle) * step);
    return Math.hypot(e.x - x0, e.y - y0) > step * STUCK_PROGRESS;
  }

  // Advances a windup timer: ramps windup 0..1, tracks aim toward the target until the
  // lock time, then freezes lockedAngle (and the AoE mark). Returns true at release.
  private stepWindupTimer(e: Enemy, dt: number, dur: number, lockAt: number, remotes: RemotePlayer[] | null, isAoe: boolean): boolean {
    const a = e.attack;
    a.time += dt;
    a.windup = a.time < dur ? a.time / dur : 1;
    if (!a.isAimLocked) {
      if (this.findTarget(e.x, e.y, remotes)) {
        a.lockedAngle = Math.atan2(this.targetY - e.y, this.targetX - e.x);
        if (isAoe) { a.markX = this.targetX; a.markY = this.targetY; }
      }
      if (a.time >= lockAt) a.isAimLocked = true;
    }
    return a.time >= dur;
  }

  private beginWindup(e: Enemy, move: AttackMove) {
    const a = e.attack;
    a.phase = "windup"; a.time = 0; a.move = move; a.windup = 0; a.isAimLocked = false;
  }

  private enterRecover(e: Enemy) { const a = e.attack; a.phase = "recover"; a.time = 0; a.windup = 0; }
  private enterIdle(e: Enemy) { const a = e.attack; a.phase = "none"; a.time = 0; a.move = "none"; a.windup = 0; }

  private moveEnemyBy(e: Enemy, dx: number, dy: number) {
    // Chill slows (and freeze roots) all enemy locomotion here — the one point every AI
    // path and the knockback impulse funnel through, so a frozen block never slides.
    if (e.chill > 0) {
      const s = this.chillMoveScale(e);
      dx *= s; dy *= s;
    }
    if (ENEMY_ARCHETYPES[e.kind].isPhasing) {
      // ghosts ignore geometry but stay inside the map bounds
      e.x = Math.max(TILE, Math.min((this.dungeon.w - 1) * TILE, e.x + dx));
      e.y = Math.max(TILE, Math.min((this.dungeon.h - 1) * TILE, e.y + dy));
    } else {
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, dx, 0);
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, 0, dy);
    }
  }

  // Knockback impulse (vx/vy) decaying to zero, applied on top of AI movement. Runs
  // during windups too, so a well-timed shot can still shove a charging enemy.
  private applyKnockbackDecay(e: Enemy, dt: number) {
    if (e.vx === 0 && e.vy === 0) return;
    this.moveEnemyBy(e, e.vx * dt, e.vy * dt);
    const d = Math.min(1, dt * KB_LAMBDA);
    e.vx -= e.vx * d; e.vy -= e.vy * d;
    if (e.vx < 1 && e.vx > -1) e.vx = 0;
    if (e.vy < 1 && e.vy > -1) e.vy = 0;
  }

  // Enemy fire: the shared bullet struct with friendly:false. Walls expire it (in
  // updateBullets), so line of sight is real counterplay.
  private spawnEnemyBullet(x: number, y: number, angle: number, speed: number, radius: number, damage: number, color: string, life: number) {
    this.bullets.push({
      x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      radius, life, friendly: false, damage, color,
      pierce: 0, hitList: null, isCrit: false,
    });
  }

  // Plays a positional sfx only when the source is on/near the local screen, so a
  // teammate's distant fight never spams the local mix.
  private sfxAt(name: SfxName, x: number, y: number, opts?: SfxOptions) {
    if (this.isNearCamera(x, y)) sfx(name, opts);
  }

  private killEnemy(e: Enemy) {
    e.dead = true;
    this.kills++;
    // Extend the kill chain (this kill counts toward its own multiplier, so the coins it
    // drops below already scale). The window refreshes on every kill.
    this.combo++;
    this.comboTimer = COMBO_WINDOW;
    const arch = ENEMY_ARCHETYPES[e.kind];
    const big = e.kind === "boss";
    this.spawnGibs(e.x, e.y, big ? 24 : 10, arch.tint);
    this.spawnParticles(e.x, e.y, big ? 20 : 8, big ? "#ffb43b" : arch.tint);
    this.addDecal(e.x, e.y, arch.tint, big ? 36 : 18, "splat");
    // Enemies with a death sheet play it once over a longer beat; ghost/spitter keep the
    // short procedural fade. The renderer falls back to the fade if the sheet isn't loaded.
    const dur = e.kind === "boss" ? DEATH_DUR_BOSS
      : (e.kind === "slime" || e.kind === "skeleton" || e.kind === "bat") ? DEATH_DUR_SHEET
      : DEATH_DUR;
    this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size: arch.drawSize, facing: this.px >= e.x ? 1 : -1, t: 0, dur });
    // Feel: the kill sound rises in pitch as the chain builds (boss keeps its deep roar),
    // and kill-trauma ramps with the combo tier so a hot streak visibly kicks harder.
    const comboRate = 1 + Math.min(this.combo - 1, 20) * 0.015; // up to +30% by combo 21+
    sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : comboRate });
    this.addFreeze(big ? FREEZE_HEAVY : FREEZE_KILL);
    const comboTrauma = big ? 0 : COMBO_TRAUMA * ((this.comboMult() - 1) / (COMBO_MAX_MULT - 1));
    this.addTrauma((big ? TRAUMA_BOSS_KILL : TRAUMA_KILL) + comboTrauma);
    // A boss dying clears its danger off the board so the victory beat isn't a death.
    if (big) this.bullets = this.bullets.filter((b) => b.friendly);
    if (this.mods.lifestealChance > 0 && this.hp < this.maxHp && Math.random() < this.mods.lifestealChance) {
      this.hp++;
      this.spawnParticles(e.x, e.y, 8, "#ff6a9d");
      sfx("heart", { gain: 0.5 });
    }
    this.dropLoot(e);
  }

  private dropLoot(e: Enemy) {
    if (e.kind === "boss") {
      // The heart + coin cache now comes bundled inside a guaranteed boss chest, which
      // also grants a blessing when the player walks over to claim the kill.
      this.chests.push({ kind: "boss", x: e.x, y: e.y, radius: 18, opened: false, anim: createAnim() });
      return;
    }
    // Kill coins carry the live combo multiplier baked in (props/chests stay face value).
    if (Math.random() < 0.5) this.pickups.push(this.makePickup("coin", e.x, e.y, this.comboCoinValue()));
    if (Math.random() < 0.12) this.pickups.push(this.makePickup("heart", e.x + 10, e.y));
  }

  private makePickup(kind: "heart" | "coin", x: number, y: number, value?: number): Pickup {
    // A little drop pulse so freshly-dropped loot announces itself.
    const color = kind === "heart" ? "#ff6a6a" : "#ffd27a";
    this.addDecal(x, y, color, 15, "ring");
    this.spawnPuff(x, y, 5, color);
    return { kind, x, y, radius: 13, weapon: null, anim: createAnim(), value };
  }

  private updatePickups(dt: number) {
    const remaining: Pickup[] = [];
    for (const p of this.pickups) {
      stepAnim(p.anim, dt, false, 0);
      // Coin Magnet vacuums loose coins toward the player once they're in range.
      if (this.mods.coinMagnet > 0 && p.kind === "coin" && !this.isDown) {
        const dx = this.px - p.x, dy = this.py - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && d < this.mods.coinMagnet) {
          const pull = Math.min(d, COIN_MAGNET_PULL * dt);
          p.x += (dx / d) * pull; p.y += (dy / d) * pull;
        }
      }
      if (!this.isDown && Math.hypot(this.px - p.x, this.py - p.y) < this.pr + p.radius) {
        if (p.kind === "coin") { this.coins += p.value ?? this.coinGain(); this.spawnParticles(p.x, p.y, 6, "#ffd27a"); sfx("coin"); continue; }
        if (p.kind === "heart") {
          if (this.hp < this.maxHp) { this.hp++; this.spawnParticles(p.x, p.y, 8, "#ff6a6a"); sfx("heart"); continue; }
        }
        if (p.kind === "weapon" && p.weapon) { this.weapon = p.weapon; this.fireCd = 0; this.spawnParticles(p.x, p.y, 12, "#ffb43b"); sfx("weapon"); continue; }
      }
      remaining.push(p);
    }
    this.pickups = remaining;
  }

  // Prop lifecycle: advance the idle/break anim, run friendly-bullet collisions (mirrors
  // the enemy hit loop — same shared-floor destruction model), and compact only on the
  // frame a break clip finishes (no per-frame allocation on the steady-state path).
  private updateProps(dt: number) {
    if (this.props.length === 0) return;
    let didBreakFinish = false;
    for (const p of this.props) {
      stepAnim(p.anim, dt, false, 0);
      if (p.breakT !== undefined) {
        p.breakT += dt;
        if (p.breakT >= PROP_BREAK_DUR) didBreakFinish = true;
        continue;
      }
      if (p.kind === "brazier") continue; // non-destructible atmosphere
      for (const b of this.bullets) {
        if (!b.friendly || b.life <= 0) continue;
        if (Math.hypot(b.x - p.x, b.y - p.y) >= b.radius + p.radius) continue;
        p.hp -= b.damage;
        triggerFlash(p.anim);
        this.spawnPuff(b.x, b.y, 5, PROP_TINT[p.kind]);
        if (b.pierce <= 0) b.life = 0; // piercing rounds punch through, others are spent
        if (p.hp <= 0) { this.destroyProp(p); break; }
      }
    }
    if (didBreakFinish) {
      this.props = this.props.filter((p) => p.breakT === undefined || p.breakT < PROP_BREAK_DUR);
    }
  }

  // Smash every destructible prop the dashing player currently overlaps.
  private dashBreakProps() {
    for (const p of this.props) {
      if (p.breakT !== undefined || p.kind === "brazier") continue;
      if (Math.hypot(this.px - p.x, this.py - p.y) < this.pr + p.radius) this.destroyProp(p);
    }
  }

  // Start a prop's break clip and resolve its payoff. Marking breakT first makes the
  // explosive chain (which recurses through destroyProp) terminate cleanly.
  private destroyProp(p: Prop) {
    if (p.breakT !== undefined || p.kind === "brazier") return;
    p.dead = true;
    p.breakT = 0;
    switch (p.kind) {
      case "crate":
        this.spawnGibs(p.x, p.y, 10, "#b07a3c");
        this.spawnPuff(p.x, p.y, 6, "#c9a06a");
        this.sfxAt("barrel", p.x, p.y, { rate: 1.4, gain: 0.6 }); // light crate crack
        if (Math.random() < 0.6) this.pickups.push(this.makePickup("coin", p.x, p.y));
        if (Math.random() < 0.15) this.pickups.push(this.makePickup("heart", p.x + 12, p.y));
        break;
      case "pot":
        this.spawnPuff(p.x, p.y, 10, "#8fb8d6");
        this.spawnGibs(p.x, p.y, 5, "#9c6b4a");
        this.sfxAt("barrel", p.x, p.y, { rate: 1.8, gain: 0.45 }); // high, brittle shatter
        if (Math.random() < 0.35) this.pickups.push(this.makePickup("coin", p.x, p.y));
        break;
      case "barrel":
        this.spawnGibs(p.x, p.y, 10, "#8a5a2c");
        this.spawnPuff(p.x, p.y, 6, "#b07a3c");
        this.sfxAt("barrel", p.x, p.y, { rate: 1.1, gain: 0.7 });
        if (Math.random() < 0.45) this.pickups.push(this.makePickup("coin", p.x, p.y));
        break;
      case "barrel_explosive":
        this.explodeBarrel(p);
        break;
    }
  }

  // Reuses the boss shockwave/AoE shape: flat damage to every enemy AND prop in radius —
  // so explosive barrels chain-detonate each other — plus heavy trauma/freeze, an orange
  // gib+spark burst, and self-damage if the player is caught (respecting i-frames).
  private explodeBarrel(source: Prop) {
    const r = BARREL_EXPLOSION_RADIUS;
    this.sfxAt("barrel", source.x, source.y, { rate: 0.7 }); // heavy detonation
    this.addFreeze(FREEZE_HEAVY);
    this.addTrauma(0.6);
    this.spawnGibs(source.x, source.y, 18, "#ff8a3b");
    this.spawnSparks(source.x, source.y, 16, Math.random() * 6.28);
    this.spawnParticles(source.x, source.y, 20, "#ffb43b");
    this.addDecal(source.x, source.y, "#ff7a2a", r * 0.6, "splat");
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.x - source.x, e.y - source.y) > r + e.radius) continue;
      e.hp -= BARREL_EXPLOSION_DAMAGE;
      triggerFlash(e.anim);
      this.spawnPuff(e.x, e.y, 6, ENEMY_ARCHETYPES[e.kind].tint);
      this.applyBurn(e, BARREL_BURN_SECS); // the blast leaves fire, tying props into the system
      if (e.hp <= 0 && !e.dead) this.killEnemy(e);
    }
    if (this.invuln === 0 && !this.isDown && this.hp > 0
      && Math.hypot(this.px - source.x, this.py - source.y) <= r) {
      this.damagePlayer(BARREL_EXPLOSION_SELF_DMG);
    }
    // Chain: nearby destructibles go up too; other explosive barrels recurse into their
    // own blast (breakT was set before we got here, so the recursion terminates).
    for (const other of this.props) {
      if (other === source || other.breakT !== undefined || other.kind === "brazier") continue;
      if (Math.hypot(other.x - source.x, other.y - source.y) <= r + other.radius) this.destroyProp(other);
    }
  }

  // Touch-to-open chests, mirroring the coin/heart pickup model (no new input). The open
  // clip plays once and holds on its final frame; the reward is rolled exactly once.
  private updateChests(dt: number) {
    if (this.chests.length === 0) return;
    for (const c of this.chests) {
      stepAnim(c.anim, dt, false, 0);
      if (c.opened) {
        if (c.openT !== undefined && c.openT < CHEST_OPEN_DUR) c.openT += dt;
        continue;
      }
      if (!this.isDown && this.hp > 0 && Math.hypot(this.px - c.x, this.py - c.y) < this.pr + c.radius) {
        this.openChest(c);
      }
    }
  }

  private openChest(c: Chest) {
    c.opened = true;
    c.openT = 0;
    sfx("chest");
    this.spawnParticles(c.x, c.y, 22, c.kind === "boss" ? "#ffb43b" : "#ffd27a");
    this.addDecal(c.x, c.y, "#ffd27a", 20, "ring");
    this.addTrauma(0.18);
    if (c.kind === "boss") this.grantBossChest(c);
    else this.rollWoodChest(c);
  }

  // Wood-chest table: mostly coins, then a heart, a blessing pick (the "chest -> power-up"
  // moment), and rarely a weapon. Coins/hearts/weapons ride the existing pickup collect loop.
  private rollWoodChest(c: Chest) {
    const r = Math.random();
    if (r < 0.55) {
      const n = 3 + Math.floor(Math.random() * 4); // 3-6 coins
      for (let i = 0; i < n; i++) this.pickups.push(this.makePickup("coin", c.x + (i - (n - 1) / 2) * 14, c.y + 12));
    } else if (r < 0.75) {
      this.pickups.push(this.makePickup("heart", c.x, c.y));
    } else if (r < 0.93) {
      this.offerBlessing();
    } else {
      const weapon = PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)];
      this.pickups.push({ kind: "weapon", x: c.x, y: c.y, radius: 16, weapon, anim: createAnim() });
    }
  }

  // Boss chest (spawned where the boss dies): a guaranteed blessing plus the heart + coin
  // cache the old boss drop gave, so the victory beat both heals and empowers.
  private grantBossChest(c: Chest) {
    this.pickups.push(this.makePickup("heart", c.x - 18, c.y));
    for (let i = 0; i < 5; i++) this.pickups.push(this.makePickup("coin", c.x + (i - 2) * 16, c.y + 18));
    this.offerBlessing();
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

  private updateExit() {
    if (this.isSandbox) return; // dev drives floors from the panel, not the exit portal
    const d = this.dungeon;
    const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
    const isCleared = this.enemies.length === 0;
    if (isCleared && !this.isDown && Math.hypot(this.px - ex, this.py - ey) < TILE) {
      const next = this.floor + 1;
      if (this.coop) {
        if (this.pendingDescend !== next) { this.pendingDescend = next; this.coop.requestDescend(next); }
      } else {
        this.descend(next);
      }
    }
  }

  private descend(nextFloor: number) {
    this.floor = nextFloor;
    this.pendingDescend = 0;
    this.combo = 0; this.comboTimer = 0; // a fresh floor starts a clean chain
    this.isDown = false; // a fresh floor brings downed teammates back up
    this.hp = Math.min(this.maxHp, this.hp + 2);
    sfx("descend");
    this.addTrauma(TRAUMA_DESCEND);
    this.loadFloor();
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor), isDescend: true }));
    this.offerBlessing(); // between-floor reward beat (every descend, from floor 1->2 on)
  }

  private damagePlayer(amount: number) {
    if (this.isGodMode) return; // dev god mode; never set outside the sandbox
    this.hp -= amount;
    this.invuln = 0.9;
    triggerFlash(this.playerAnim);
    this.spawnParticles(this.px, this.py, 10, "#ff5a5a");
    sfx("playerHurt");
    this.addFreeze(FREEZE_HURT);
    this.addTrauma(TRAUMA_HURT);
    this.hurtFlash = 1;
    if (this.hp <= 0) {
      this.hp = 0;
      if (this.coop && this.hasLivingTeammate()) {
        this.isDown = true; // wait for a revive
      } else {
        this.gameOver();
      }
    }
  }

  private hasLivingTeammate(): boolean {
    if (!this.coop) return false;
    return this.coop.remotePlayers().some((r) => !r.isDown);
  }

  // ---- co-op networking ----

  private syncCoop(dt: number) {
    if (!this.coop) return;
    // Follow the room's shared floor (any teammate descending pulls us along).
    const shared = this.coop.getFloor();
    if (shared > this.floor) this.descend(shared);

    // A teammate revived us.
    const revived = this.coop.consumeRevive();
    if (revived !== null && this.isDown) {
      this.isDown = false;
      this.hp = revived;
      this.invuln = 1.2;
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
      if (Math.hypot(this.px - r.x, this.py - r.y) < REVIVE_RADIUS) {
        seen.add(r.playerId);
        const held = (this.reviveHold.get(r.playerId) ?? 0) + dt;
        this.reviveHold.set(r.playerId, held);
        this.spawnParticles(r.x, r.y, 1, "#8affc0");
        if (held >= REVIVE_HOLD) {
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
    const isBossActive = this.enemies.some((e) => e.kind === "boss");
    let coopLabel: string | null = null;
    if (this.coop) {
      const count = this.coop.remotePlayers().length + 1;
      coopLabel = `CO-OP \u00b7 ${this.coop.roomCode} \u00b7 ${count} player${count === 1 ? "" : "s"}`;
    }
    const comboTier = this.comboTier();
    this.hud.update({
      hp: this.hp, maxHp: this.maxHp,
      floor: this.floor, kills: this.kills, coins: this.coins,
      weaponName: WEAPONS[this.weapon].name,
      isCleared: this.enemies.length === 0,
      enemiesLeft: this.enemies.length,
      isBossActive,
      coopLabel,
      dashFill: 1 - this.dashCd / this.dashCooldown(),
      combo: this.combo,
      comboMult: comboTier.mult,
      comboColor: comboTier.color,
      comboFrac: this.comboTimer / COMBO_WINDOW,
      items: this.collapsedItems(),
    });
  }

  // Collapse owned blessings by id into count-bearing entries (first-seen order), so the
  // HUD panel shows one chip per distinct item with an xN badge when a pick repeats.
  private collapsedItems() {
    const collapsed = new Map<string, { id: string; name: string; desc: string; glyph: string; tint: string; rarity: string; count: number }>();
    for (const it of this.ownedItems) {
      const seen = collapsed.get(it.id);
      if (seen) seen.count++;
      else collapsed.set(it.id, { id: it.id, name: it.name, desc: it.desc, glyph: it.glyph, tint: it.tint, rarity: it.rarity, count: 1 });
    }
    return [...collapsed.values()];
  }

  private openStats() {
    const roster = this.coop
      ? [
          { name: "you", isYou: true, color: playerColor(this.coop.selfColorIndex()), isDown: this.isDown },
          ...this.coop.remotePlayers().map((r) => ({ name: r.name, isYou: false, color: playerColor(r.colorIndex), isDown: r.isDown })),
        ]
      : null;
    this.hud.showStats({
      floor: this.floor, kills: this.kills, coins: this.coins,
      runTime: (performance.now() - this.runStart) / 1000,
      weaponName: WEAPONS[this.weapon].name,
      profile: this.profile,
      roster,
      items: this.ownedItems.map((it) => ({ name: it.name, desc: it.desc, glyph: it.glyph, tint: it.tint })),
    });
  }

  private gameOver() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.isAutoFiring = false;
    cancelAnimationFrame(this.raf);
    audio.setMusic(null);
    sfx("gameOver");
    this.hud.hideStats();
    this.hud.clear();
    this.hud.setVisible(false);
    this.onGameOver({ floor: this.floor, kills: this.kills, coins: this.coins, durationMs: performance.now() - this.runStart });
  }

  // True when a world point is on (or near) the visible screen — used to gate audio
  // and juice for far-off co-op events so a teammate across the map never spams us.
  private isNearCamera(x: number, y: number, margin = 160): boolean {
    return x >= this.cam.x - margin && x <= this.cam.x + this.canvas.width + margin
      && y >= this.cam.y - margin && y <= this.cam.y + this.canvas.height + margin;
  }

  private spawnParticles(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 40 + Math.random() * 140;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.4, maxLife: 0.7, color, size: 1 + Math.random() * 3, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.92 });
    }
  }

  // Wind/slash dust flung off a melee swing: particles seeded ALONG the swing arc (or the
  // thrust line for spears), each flying TANGENT to the sweep so they read as a gust of
  // wind trailing the blade. Cheap, additive to the slash VFX; tinted to the weapon.
  private spawnSlashWind(m: { arc: number; reach: number; isThrust?: boolean }, color: string) {
    const cx = this.px, cy = this.py, aim = this.aimAngle;
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
        this.particles.push({ x: px, y: py, vx: Math.cos(aim) * sp, vy: Math.sin(aim) * sp, life: 0.14 + Math.random() * 0.14, maxLife: 0.28, color, size: 1 + Math.random() * 2.5, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.88 });
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
      this.particles.push({ x: px, y: py, vx: Math.cos(tang) * sp, vy: Math.sin(tang) * sp, life: 0.16 + Math.random() * 0.16, maxLife: 0.32, color, size: 1 + Math.random() * 2.5, kind: "dot", rot: 0, vr: 0, gravity: 0, drag: 0.86 });
    }
  }

  // Chunky bits of the dead thing: fly out fast, tumble, fall, and fade a touch slower.
  private spawnGibs(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 90 + Math.random() * 210;
      const life = 0.45 + Math.random() * 0.5;
      this.particles.push({
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
      this.particles.push({
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
      this.particles.push({
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
    this.particles.push({
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
    this.renderExit();
    this.renderShadows();
    this.renderPropEntities();
    this.renderChests();
    this.renderPickups();
    this.renderParticles();
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
    this.renderHurtVignette();
    this.renderReticle();
    this.renderMinimap();
  }

  // Unmissable "you got hit" read: a red glow that hugs the screen edge and fades fast.
  // Drawn in screen space (outside the shake translate) so it frames the whole viewport.
  private renderHurtVignette() {
    if (this.hurtFlash <= 0) return;
    const { ctx, canvas } = this;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const inner = Math.min(cx, cy) * 0.55;
    const outer = Math.hypot(cx, cy);
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, "rgba(255,40,40,0)");
    g.addColorStop(1, `rgba(255,30,30,${0.55 * this.hurtFlash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

    // Pass 1: floors (+ occasional detail overlay + cast shadow under walls).
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (d.tiles[ty * d.w + tx] !== 0) continue;
        const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
        const variant = floorVariant(tileHash(tx, ty, 1));
        if (tiles.ready(variant)) {
          ctx.drawImage(tiles.get(variant), sx, sy, TILE, TILE);
        } else {
          ctx.fillStyle = (tx + ty) % 2 === 0 ? biome.floorA : biome.floorB;
          ctx.fillRect(sx, sy, TILE, TILE);
        }
        const rd = tileHash(tx, ty, 2);
        if (rd < 0.09) {
          const detail: TileName = rd < 0.03 ? "floor_crack" : rd < 0.06 ? "floor_grate" : "floor_moss";
          if (tiles.ready(detail)) ctx.drawImage(tiles.get(detail), sx, sy, TILE, TILE);
        }
        // A wall directly above casts a shadow onto this floor tile — sells the height.
        if (ty > 0 && d.tiles[(ty - 1) * d.w + tx] === 1 && tiles.ready("wall_shadow")) {
          ctx.drawImage(tiles.get("wall_shadow"), sx, sy, TILE, TILE);
        }
      }
    }

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
        // Full 16-piece autotile (AD): pick the block by which of N/E/S/W neighbours are
        // FLOOR (NESW order). One self-contained piece bakes cap + all exposed faces +
        // corners — handles thin walls, pillars, and gaps, not just room perimeters.
        const sides = (aboveFloor ? "N" : "") + (rightFloor ? "E" : "") + (belowFloor ? "S" : "") + (leftFloor ? "W" : "");
        const wf = ("wf_" + (sides || "top")) as TileName;
        if (tiles.ready(wf)) { ctx.drawImage(tiles.get(wf), sx, sy, TILE, TILE); continue; }
        if (tiles.ready("wall_top")) {
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
    for (const t of this.torches) {
      const sx = t.tx * TILE - cam.x, sy = t.ty * TILE - cam.y;
      if (sx <= -TILE || sy <= -TILE || sx >= canvas.width || sy >= canvas.height) continue;
      if (hasGlow) {
        const flick = 0.75 + 0.25 * Math.sin(clock * 11 + t.tx * 1.7 + t.ty * 0.9);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 * flick;
        ctx.drawImage(tiles.get("torch_glow"), sx + TILE / 2 - 48, sy + TILE / 2 - 48, 96, 96);
        ctx.restore();
      }
      if (hasFlame) ctx.drawImage(tiles.get(flame), sx, sy, TILE, TILE);
    }
  }

  private renderExit() {
    const { ctx, cam } = this;
    const d = this.dungeon;
    const ex = d.exit.x * TILE + TILE / 2 - cam.x, ey = d.exit.y * TILE + TILE / 2 - cam.y;
    const isCleared = this.enemies.length === 0;
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
      if (this.isNearCamera(e.x, e.y, TILE)) this.shadow(e.x - cam.x, e.y - cam.y + arch.drawSize * 0.3, arch.drawSize * 0.62);
    }
    // remote players (co-op)
    if (this.coop) for (const r of this.coop.remotePlayers()) {
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
      const xf = characterXform(p.anim, PROP_STYLE);
      if (p.kind === "brazier") { this.renderBrazier(p, sx, sy, xf); continue; }
      if (p.breakT === undefined) {
        this.drawPropImage(PROP_INTACT_IMG[p.kind], 0, sx, sy, PROP_DRAW, xf, p.anim.flash);
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
      // A closed chest pulses a soft glow so touch-to-open reads as interactive.
      if (!c.opened) {
        const pulse = 0.35 + 0.2 * Math.abs(Math.sin(c.anim.clock * 3));
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
      const xf = characterXform(c.anim, PROP_STYLE);
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
  // spritesheet (falling back to the static PNG), and an optional white hit-flash.
  private drawChar(name: SpriteName, clip: SheetClip, cx: number, cy: number, size: number, facing: number, xf: Xform, extra: number, alpha: number, flash: number, frameClock: number) {
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
      ctx.drawImage(sheet.img, i * fw, 0, fw, fw, -half, -half, size, size);
    } else {
      ctx.drawImage(this.sprites.get(name), -half, -half, size, size);
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
      const clock = p.anim.clock;
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

  private renderEnemies() {
    const { ctx, cam } = this;
    for (const e of this.enemies) {
      const arch = ENEMY_ARCHETYPES[e.kind];
      const a = e.attack;
      const sx = e.x - cam.x, sy = e.y - cam.y;
      const facing = this.px >= e.x ? 1 : -1;
      const isWindup = a.phase === "windup";
      const isHopSlam = e.kind === "boss" && a.move === "hopslam";

      // Ground danger marker for the boss hop-slam (drawn under everything).
      if (isHopSlam && (isWindup || a.phase === "active")) this.renderSlamMarker(e);

      // Ghost solidify reads as an opacity ramp; everyone else uses the archetype alpha.
      const alpha = e.kind === "ghost" ? 0.62 + 0.38 * a.windup : arch.alpha;

      const clip: SheetClip = e.anim.move > 0.5 ? "walk" : "idle";
      const xf = characterXform(e.anim, e.kind === "boss" ? BOSS_STYLE : CHARACTER_STYLE);
      let extra = 1;
      // Skeleton coils down (squash) as its lunge charges.
      if (e.kind === "skeleton" && isWindup) { xf.sx += 0.28 * a.windup; xf.sy -= 0.24 * a.windup; }
      // Boss inflates for radial/roar telegraphs and lifts off the ground mid-slam.
      if (e.kind === "boss") {
        if (isWindup && (a.move === "radial" || a.move === "roar")) extra = 1 + a.windup * 0.16;
        if (isHopSlam && a.phase === "windup") xf.sy -= 0.18 * a.windup; // crouch before the leap
        if (isHopSlam && a.phase === "active") { xf.oy -= Math.sin(a.windup * Math.PI) * BOSS_JUMP_HEIGHT; extra = 1.08; }
      }
      // A white pulse on the sprite intensifies as the windup nears release.
      const pulse = 0.55 + 0.45 * Math.sin(e.anim.clock * 13);
      const telegraphFlash = isWindup ? a.windup * pulse * 0.85 : 0;
      this.drawChar(arch.sprite, clip, sx, sy, arch.drawSize, facing, xf, extra, alpha, Math.max(e.anim.flash, telegraphFlash), e.anim.clock);

      // Elemental status overlays (burn ember glow / chill frost / freeze crust / shock crackle).
      if (e.burn > 0 || e.chill > 0 || e.shock > 0) this.renderEnemyStatus(e, sx, sy, arch.drawSize);

      // Shimmer flecks while a ghost is materializing.
      if (e.kind === "ghost" && a.windup > 0.05 && a.windup < 0.98) this.renderGhostShimmer(e, sx, sy);
      // Aura + aim line for a charging attack.
      if (isWindup) this.renderTelegraph(e, sx, sy);

      const barW = e.kind === "boss" ? 64 : 32;
      const barY = sy - arch.drawSize / 2 - 8;
      ctx.fillStyle = "#000"; ctx.fillRect(sx - barW / 2, barY, barW, 4);
      ctx.fillStyle = e.kind === "boss" ? "#ffb43b" : "#ff5a5a";
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, e.hp / e.maxHp), 4);
    }
  }

  // Pulsing colored aura + an aim line for a charging attack. The line tracks the
  // target while dashed, then goes solid + bright once the aim locks — that visual
  // "click" is the cue that the dodge window has opened.
  private renderTelegraph(e: Enemy, sx: number, sy: number) {
    const { ctx } = this;
    const a = e.attack;
    const arch = ENEMY_ARCHETYPES[e.kind];
    const color = TELEGRAPH_COLOR[a.move];
    const pulse = 0.5 + 0.5 * Math.sin(e.anim.clock * 13);
    const r = arch.drawSize * (0.5 + 0.28 * a.windup);
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
    const n = 4;
    ctx.save();
    ctx.fillStyle = "#e8faff";
    for (let i = 0; i < n; i++) {
      const ang = e.anim.clock * 2 + (i / n) * 6.28;
      const rad = 10 + (i % 2) * 8;
      ctx.globalAlpha = 0.5 * e.attack.windup * (0.5 + 0.5 * Math.sin(e.anim.clock * 9 + i));
      ctx.fillRect(sx + Math.cos(ang) * rad - 1, sy + Math.sin(ang) * rad - 1, 2, 2);
    }
    ctx.restore();
  }

  // Layered status visuals, all additive via the shared fx path. Dedicated masks
  // (ember/frost/freeze_shell) light up if the AD art is present; until then the
  // always-loaded glow_round + crackle carry the tint so the status still reads.
  private renderEnemyStatus(e: Enemy, sx: number, sy: number, size: number) {
    const clock = e.anim.clock;
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
    if (!this.coop) return;
    const { ctx, cam } = this;
    for (const r of this.coop.remotePlayers()) {
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

      if (!r.isDown) this.renderHeldWeapon(sx, sy, r.aimAngle, r.weapon, 1);

      ctx.fillStyle = color;
      ctx.font = '700 11px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText(r.isDown ? `${r.name} (down)` : r.name, sx, sy - 32);
      ctx.textAlign = "left";
    }
  }

  private renderPlayer() {
    const { ctx, cam } = this;
    const psx = this.px - cam.x, psy = this.py - cam.y;
    let alpha = 1;
    if (this.isDown) alpha = 0.4;
    else if (this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0) alpha = 0.4;
    const clip: SheetClip = this.playerAnim.move > 0.5 ? "walk" : "idle";
    const xf = characterXform(this.playerAnim, CHARACTER_STYLE);
    // Directional recoil: nudge the blob back against its aim as it fires.
    const rec = this.playerAnim.recoil;
    xf.ox += -Math.cos(this.aimAngle) * rec * 4;
    xf.oy += -Math.sin(this.aimAngle) * rec * 4;
    this.drawChar("hero", clip, psx, psy, 52, this.facing, xf, 1, alpha, this.playerAnim.flash, this.playerAnim.clock);
    if (!this.isDown) this.renderHeldWeapon(psx, psy, this.heldAimAngle(), this.weapon, alpha, this.playerAnim.recoil, this.heldThrustOffset());
    if (this.isDown) {
      ctx.fillStyle = "#ff6a6a";
      ctx.font = '700 12px "Silkscreen", monospace';
      ctx.textAlign = "center";
      ctx.fillText("DOWN \u2014 wait for a teammate", psx, psy - 34);
      ctx.textAlign = "left";
    }
  }

  private heldAimAngle(): number {
    const swing = this.meleeSwing;
    if (!swing || swing.timer <= 0) return this.aimAngle;
    const t = 1 - swing.timer / swing.duration;
    if (swing.isThrust) return swing.aim;
    return swing.aim - swing.arc * 0.5 + t * swing.arc;
  }

  private heldThrustOffset(): number {
    const swing = this.meleeSwing;
    if (!swing || swing.timer <= 0 || !swing.isThrust) return 0;
    const t = 1 - swing.timer / swing.duration;
    return Math.sin(t * Math.PI) * 14;
  }

  private renderMeleeSwing() {
    const swing = this.meleeSwing;
    if (!swing || swing.timer <= 0) return;
    const { ctx, cam } = this;
    const sx = this.px - cam.x;
    const sy = this.py - cam.y;
    const t = 1 - swing.timer / swing.duration;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(sx, sy);
    ctx.rotate(swing.aim);
    if (swing.isThrust) {
      const len = swing.reach * (0.45 + 0.55 * Math.sin(t * Math.PI));
      ctx.globalAlpha = 0.6 * (1 - t * 0.35);
      ctx.strokeStyle = swing.color;
      ctx.lineWidth = 7 * (1 - t * 0.4);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(14 + len, 0);
      ctx.stroke();
    } else {
      const start = -swing.arc * 0.5;
      const sweep = swing.arc * t;
      const inner = 10;
      const outer = swing.reach * (0.82 + 0.18 * Math.sin(t * Math.PI));
      ctx.globalAlpha = 0.5 * (1 - t * 0.3);
      ctx.fillStyle = swing.color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, outer, start, start + sweep);
      ctx.arc(0, 0, inner, start + sweep, start, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // The equipped gun, drawn over the hero and rotated to aim. Held sprites are authored
  // 40px with the gun centered in the file, pointing +X; the vertical flip past |aim| >
  // 90deg keeps the barrel horizontal (not upside-down) when aiming left. The sprite
  // center sits at the muzzle-flash anchor distance (18px out along aim), pulled in
  // slightly on fire by recoil. Weapons without art (the six newer guns) fall back to the
  // pistol overlay; if even that isn't loaded yet it simply draws nothing.
  // Melee held art (held_sword / held_longsword / held_spear) can drop into HELD_SOURCES later.
  private renderHeldWeapon(cx: number, cy: number, aim: number, weapon: WeaponId, alpha: number, recoil = 0, thrustOff = 0) {
    const img = this.sprites.heldWeapon(weapon) ?? this.sprites.heldWeapon("pistol");
    if (!img) return;
    const { ctx } = this;
    const anchor = 18 - recoil * 3 + thrustOff;
    const d = 40 * 0.6; // ~24px over the ~44px blob
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx + Math.cos(aim) * anchor, cy + Math.sin(aim) * anchor);
    ctx.rotate(aim);
    if (Math.abs(aim) > Math.PI / 2) ctx.scale(1, -1);
    ctx.drawImage(img, -d / 2, -d / 2, d, d);
    ctx.restore();
  }

  private renderAfterimages() {
    if (this.afterimages.length === 0) return;
    const { ctx, cam } = this;
    const isReady = this.sprites.ready("hero");
    for (const a of this.afterimages) {
      const k = 1 - a.t; // 1..0
      ctx.save();
      ctx.globalAlpha = k * 0.4;
      ctx.translate(a.x - cam.x, a.y - cam.y);
      ctx.scale(a.facing, 1);
      if (isReady) ctx.drawImage(this.sprites.get("hero"), -26, -26, 52, 52);
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
    if (this.coop) {
      for (const r of this.coop.remotePlayers()) dots.push({ x: r.x, y: r.y, color: playerColor(r.colorIndex), size: 2.5 });
    }
    this.minimap.render({
      dungeon: this.dungeon,
      playerX: this.px, playerY: this.py,
      exit: this.dungeon.exit,
      isCleared: this.enemies.length === 0,
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

  // A single large walled rectangle — the "creative mode" arena. Reuses the exact
  // Dungeon/Room shape the renderer + pathfinder already consume, so the real game runs
  // on it unchanged. Only ever called from loadFloor when isSandbox is set.
  private buildArena(): Dungeon {
    const w = 34, h = 24;
    const tiles: TileKind[] = new Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        tiles[y * w + x] = isBorder ? 1 : 0;
      }
    }
    const room: Room = { x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1, kind: "normal" };
    return { w, h, tiles, rooms: [room], spawn: { x: w >> 1, y: h >> 1 }, exit: { x: w - 3, y: 2 } };
  }

  // Boot the sandbox: a solo run whose loadFloor takes the arena branch above. Safe to
  // call in place of start() — it flips isSandbox first, then reuses the whole start path.
  devStartSandbox(): void {
    this.isSandbox = true;
    this.start({ mode: "solo", coop: null, profile: null });
  }

  // Where a freshly-spawned thing should land: the cursor tile if it's on open floor,
  // otherwise a random open spot a short walk from the player (so bulk spawns spread out).
  private devPlacePoint(atCursor: boolean): { x: number; y: number } {
    if (atCursor) {
      const wx = this.mouse.x + this.cam.x, wy = this.mouse.y + this.cam.y;
      if (!this.isWall(wx, wy)) return { x: wx, y: wy };
    }
    for (let i = 0; i < 32; i++) {
      const a = Math.random() * Math.PI * 2, r = 48 + Math.random() * 150;
      const x = this.px + Math.cos(a) * r, y = this.py + Math.sin(a) * r;
      if (!this.isWall(x, y)) return { x, y };
    }
    return { x: this.px, y: this.py };
  }

  devSpawnEnemies(kind: EnemyKind, count: number, atCursor: boolean): void {
    for (let i = 0; i < count; i++) {
      const p = this.devPlacePoint(atCursor);
      this.enemies.push(createEnemy(kind, p.x, p.y, this.floor));
      this.spawnParticles(p.x, p.y, 6, ENEMY_ARCHETYPES[kind].tint);
    }
  }

  devClearEnemies(): void {
    this.enemies.length = 0;
  }

  devSpawnProp(kind: PropKind, atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    this.props.push({ kind, x: p.x, y: p.y, radius: PROP_RADIUS, hp: PROP_HP[kind], dead: false, anim: createAnim() });
  }

  devSpawnChest(atCursor: boolean): void {
    const p = this.devPlacePoint(atCursor);
    this.chests.push({ kind: "wood", x: p.x, y: p.y, radius: 16, opened: false, anim: createAnim() });
  }

  devGiveWeapon(id: WeaponId): void {
    this.weapon = id;
    sfx("weapon");
  }

  // Apply a specific blessing immediately (reuses the real item pipeline + HUD strip).
  devGrantItem(item: ItemDef): void {
    this.applyItem(item);
  }

  // Pop the real between-floor blessing chooser (freezes the sim, exactly like a descend).
  devOfferBlessing(): void {
    this.offerBlessing();
  }

  devToggleGod(): boolean {
    this.isGodMode = !this.isGodMode;
    return this.isGodMode;
  }

  // Sandbox: force the combo to a value (and hold the window full) so the combo HUD can be
  // screenshotted at a given tier. Pass 0 to clear. Only meaningful in the dev sandbox.
  devSetCombo(n: number): void {
    this.combo = Math.max(0, Math.floor(n));
    this.comboTimer = this.combo > 0 ? COMBO_WINDOW : 0;
  }

  // Sandbox: when frozen, the combo window stops draining so the HUD stays put for a gate.
  devFreezeCombo(on: boolean): boolean {
    this.comboFreeze = on;
    if (on && this.comboTimer <= 0 && this.combo > 0) this.comboTimer = COMBO_WINDOW;
    return this.comboFreeze;
  }

  devHealFull(): void {
    this.hp = this.maxHp;
  }

  devAddMaxHp(delta: number): void {
    this.mods.maxHpBonus += delta;
    this.applyMaxHpBonus();
  }

  // Rebuild the arena at a new floor (scales enemy HP/speed via createEnemy's floor arg).
  devSetFloor(floor: number): void {
    this.floor = Math.max(1, Math.floor(floor));
    this.loadFloor();
    this.hud.showBanner(floorBannerText(this.floor, { isBoss: isBossFloor(this.floor) }));
  }

  devToggleFlowDebug(): boolean {
    this.isFlowDebug = !this.isFlowDebug;
    return this.isFlowDebug;
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
    if (!this.flow.isReady()) return;
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
        if (!this.flow.sampleStep(tx, ty)) {
          ctx.fillRect(cx - 3, cy - 3, 6, 6);
          continue;
        }
        const dx = this.flow.step.dx, dy = this.flow.step.dy;
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
