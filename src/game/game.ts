import { generateDungeon } from "./dungeon.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import type { Enemy, Bullet, Particle, Pickup, WeaponId, AttackMove, RemotePlayer } from "./types.js";
import { Rng, randomSeed } from "./rng.js";
import { Sprites, playerColor, FRAME } from "./assets.js";
import type { SpriteName, SheetClip } from "./assets.js";
import { ENEMY_ARCHETYPES, spawnFloorEnemies, isBossFloor, createEnemy } from "./enemies.js";
import { WEAPONS, DEFAULT_WEAPON, PICKUP_WEAPONS, fire } from "./weapons.js";
import { Minimap } from "./minimap.js";
import type { MinimapDot } from "./minimap.js";
import { Hud } from "./hud.js";
import type { ProfileStats } from "./hud.js";
import type { CoopBridge, LocalPlayerState } from "./coop.js";
import {
  createAnim, resetAnim, stepAnim, triggerRecoil, triggerFlash,
  characterXform, frameIndex, CHARACTER_STYLE, BOSS_STYLE, IDENTITY_XFORM,
} from "./anim.js";
import type { Anim, Xform } from "./anim.js";
import { audio, sfx } from "./audio.js";
import type { SfxName, SfxOptions } from "./audio.js";
import { settings } from "./settings.js";
import { PauseOverlay } from "../ui/pause.js";

export interface RunResult { floor: number; kills: number; coins: number; durationMs: number; }

export interface StartOptions {
  mode: "solo" | "coop";
  coop?: CoopBridge | null;
  profile?: ProfileStats | null;
}

interface RemoteTracer { x: number; y: number; angle: number; life: number; color: string; }
interface Corpse { sprite: SpriteName; x: number; y: number; size: number; facing: number; t: number; }
interface RemoteAnimEntry { anim: Anim; lastX: number; lastY: number; }
// Floor stains + drop pulses that linger for a beat after the action moves on.
interface Decal { x: number; y: number; color: string; r: number; t: number; life: number; kind: "splat" | "ring"; }
// A fading ghost of the hero left along a dash so it reads as motion, not a teleport.
interface Afterimage { x: number; y: number; facing: number; t: number; }

const MAX_DECALS = 48;
const AFTERIMAGE_DUR = 0.28; // seconds a dash afterimage takes to fade out

const REVIVE_RADIUS = 46;
const REVIVE_HOLD = 1.1;
const BOSS_MINION_CAP = 14;
const DEATH_DUR = 0.3;   // seconds a death "corpse" animates out
const MUZZLE_DUR = 0.07; // seconds the muzzle flash lingers

const SHOOT_SFX: Record<WeaponId, SfxName> = {
  pistol: "shootPistol",
  shotgun: "shootShotgun",
  rapid: "shootRapid",
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
const FIRE_TRAUMA: Record<WeaponId, number> = { pistol: 0.12, shotgun: 0.5, rapid: 0.06 };
// Per-weapon feel: recoil punch (sprite scale kick), camera kick (px, back along aim),
// and knockback (px the shotgun shoves the player). Shotgun is the beefy end.
const FIRE_RECOIL: Record<WeaponId, number> = { pistol: 1, shotgun: 1.4, rapid: 0.6 };
const FIRE_KICK: Record<WeaponId, number> = { pistol: 3, shotgun: 8, rapid: 1.2 };
const FIRE_KNOCKBACK: Record<WeaponId, number> = { pistol: 0, shotgun: 22, rapid: 0 };
const KICK_DECAY = 20; // how fast the camera kick eases back to center
const TRAUMA_HURT = 0.4;
const TRAUMA_KILL = 0.16;
const TRAUMA_BOSS_KILL = 0.7;
const TRAUMA_BOSS_SLAM = 0.4;
const TRAUMA_DESCEND = 0.22;
const TRAUMA_BOSS_FLOOR = 0.5;
const TRAUMA_REMOTE_DOWN = 0.3;

// Enemy knockback: a bullet adds a short velocity impulse along its travel direction
// that decays every frame (never a teleport). WEAPON_KB is the ~total px shove on a
// baseline slime; heavier enemies divide it by their kbResist. The impulse is stored
// in each enemy's otherwise-unused vx/vy.
const WEAPON_KB: Record<WeaponId, number> = { pistol: 4, shotgun: 8, rapid: 2 };
const KB_LAMBDA = 16;     // decay rate; with the impulse math the total shove ≈ WEAPON_KB px
const KB_MAX_SPEED = 520; // cap so point-blank shotgun / rapid spam can't launch a mob

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

const BOSS_SLAM_RADIUS = 90;   // shockwave radius (also the ground-marker size)
const BOSS_JUMP_HEIGHT = 42;   // px the boss visually lifts mid hop-slam
// Reused dashed/solid line patterns so the aim line never allocates per frame.
const AIM_DASH: number[] = [7, 6];
const AIM_SOLID: number[] = [];

export class Game {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private sprites = new Sprites();
  private minimap: Minimap;
  private hud: Hud;
  private onGameOver: (result: RunResult) => void;
  private onExit: () => void;
  private pause: PauseOverlay;
  private isPaused = false;

  private dungeon!: Dungeon;
  private floor = 1;
  private seed = 0;
  private kills = 0;
  private coins = 0;

  // player
  private px = 0; private py = 0;
  private pr = 18;
  private hp = 6; private maxHp = 6;
  private invuln = 0;
  private dashCd = 0; private dashTime = 0; private dashDx = 0; private dashDy = 0;
  private fireCd = 0;
  private facing = 1;
  private weapon: WeaponId = DEFAULT_WEAPON;
  private aimAngle = 0;
  private shotSeq = 0;
  private isDown = false;

  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];
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
  private muzzle = { t: 0, x: 0, y: 0, angle: 0, size: 2 };

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
  private freeze = 0; // hit-stop timer (seconds); while > 0 gameplay updates pause
  private trauma = 0; // screen-shake trauma, 0..1
  private kickX = 0; private kickY = 0; // directional camera kick (recoil), render-only
  private hurtFlash = 0; // red hurt-vignette intensity, 0..1

  private coop: CoopBridge | null = null;
  private profile: ProfileStats | null = null;
  private isStatsHeld = false;
  private pendingDescend = 0;

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, hudRoot: HTMLElement, onGameOver: (result: RunResult) => void, onExit: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.minimap = new Minimap(minimapCanvas);
    this.hud = new Hud(hudRoot);
    this.onGameOver = onGameOver;
    this.onExit = onExit;
    this.pause = new PauseOverlay(() => this.setPaused(false), () => this.quitToMenu());
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize() {
    this.canvas.width = Math.min(window.innerWidth, 1100);
    this.canvas.height = Math.min(window.innerHeight, 720);
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
    this.canvas.addEventListener("mousedown", () => (this.mouse.isDown = true));
    window.addEventListener("mouseup", () => (this.mouse.isDown = false));
  }

  start(opts: StartOptions) {
    this.coop = opts.coop ?? null;
    this.profile = opts.profile ?? null;
    this.floor = this.coop ? this.coop.getFloor() : 1;
    this.seed = this.coop ? this.coop.getSeed() : randomSeed();
    this.kills = 0;
    this.coins = 0;
    this.hp = this.maxHp;
    this.weapon = DEFAULT_WEAPON;
    this.isDown = false;
    this.remoteShotSeen.clear();
    this.remoteDownSeen.clear();
    this.remoteAnims.clear();
    this.reviveHold.clear();
    this.freeze = 0;
    this.trauma = 0;
    this.kickX = 0; this.kickY = 0;
    this.hurtFlash = 0;
    this.isPaused = false;
    this.pause.hide();
    audio.unlock();
    this.corpses = [];
    this.muzzle.t = 0;
    resetAnim(this.playerAnim);
    this.isPlayerMoving = false;
    this.playerLean = 0;
    this.runStart = performance.now();
    this.loadFloor();
    this.hud.setVisible(true);
    this.hud.showBanner(isBossFloor(this.floor) ? "BOSS FLOOR" : `FLOOR ${this.floor}`);
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
    this.dungeon = generateDungeon(this.seed, this.floor);
    const d = this.dungeon;
    this.px = d.spawn.x * TILE + TILE / 2;
    this.py = d.spawn.y * TILE + TILE / 2;
    this.bullets = [];
    this.particles = [];
    this.remoteTracers = [];
    this.corpses = [];
    this.decals = [];
    this.afterimages = [];
    this.muzzle.t = 0;
    this.enemies = spawnFloorEnemies(d, this.seed, this.floor);
    this.pickups = this.placeWeaponPickups(d);
    const isBoss = isBossFloor(this.floor);
    audio.setMusic(isBoss ? "boss" : "dungeon");
    if (isBoss) { sfx("bossSpawn"); this.addTrauma(TRAUMA_BOSS_FLOOR); }
  }

  private placeWeaponPickups(d: Dungeon): Pickup[] {
    if (this.floor < 2 || d.rooms.length <= 2) return [];
    const rng = new Rng((this.seed ^ 0x51ed270b) + this.floor * 40503);
    const drops: Pickup[] = [];
    const kinds: WeaponId[] = [rng.pick(PICKUP_WEAPONS)];
    if (this.floor >= 4 && rng.chance(0.5)) kinds.push(rng.pick(PICKUP_WEAPONS));
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

  private isWall(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) return true;
    return this.dungeon.tiles[ty * this.dungeon.w + tx] === 1;
  }

  private moveCircle(x: number, y: number, r: number, dx: number, dy: number): [number, number] {
    const nx = x + dx, ny = y + dy;
    if (!this.isWall(nx + Math.sign(dx) * r, y)) x = nx;
    if (!this.isWall(x, ny + Math.sign(dy) * r)) y = ny;
    return [x, y];
  }

  private loop = (t: number) => {
    if (!this.isRunning) return;
    const dt = Math.min((t - this.last) / 1000, 0.05);
    this.last = t;
    // Paused: keep drawing the frozen frame under the pause overlay, run no sim.
    if (this.isPaused) {
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
    if (!this.isRunning) return;
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

  private applyKnockback(e: Enemy, b: Bullet) {
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const v = (WEAPON_KB[this.weapon] * KB_LAMBDA) / ENEMY_ARCHETYPES[e.kind].kbResist;
    e.vx += (b.vx / sp) * v;
    e.vy += (b.vy / sp) * v;
    const mag = Math.hypot(e.vx, e.vy);
    if (mag > KB_MAX_SPEED) { const s = KB_MAX_SPEED / mag; e.vx *= s; e.vy *= s; }
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
    stepAnim(this.playerAnim, dt, this.isPlayerMoving, this.playerLean);
    this.updateBullets(dt);
    this.updateEnemies(dt);
    this.updatePickups(dt);
    this.updateParticles(dt);
    this.updateTracers(dt);
    this.updateCorpses(dt);
    this.updateDecals(dt);
    this.updateAfterimages(dt);
    if (this.muzzle.t > 0) this.muzzle.t = Math.max(0, this.muzzle.t - dt);
    if (this.coop) this.updateRemoteAnims(dt);
    this.updateExit();
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

    const speed = 200;
    this.dashCd = Math.max(0, this.dashCd - dt);
    if (this.keys.has("shift") && this.dashCd === 0 && (ix || iy)) {
      this.dashTime = 0.16; this.dashCd = 0.7; this.dashDx = ix; this.dashDy = iy;
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
    this.invuln = Math.max(0, this.invuln - dt);
    this.isPlayerMoving = ix !== 0 || iy !== 0;
    this.playerLean = ix;
  }

  private updateShooting(dt: number) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    if (this.mouse.isDown && this.fireCd === 0) {
      const w = WEAPONS[this.weapon];
      const muzzleX = this.px + Math.cos(this.aimAngle) * 18;
      const muzzleY = this.py + Math.sin(this.aimAngle) * 18;
      for (const b of fire(w, muzzleX, muzzleY, this.aimAngle)) this.bullets.push(b);
      this.fireCd = w.fireCd;
      this.shotSeq++;
      triggerRecoil(this.playerAnim, FIRE_RECOIL[this.weapon]);
      this.muzzle.t = MUZZLE_DUR; this.muzzle.x = muzzleX; this.muzzle.y = muzzleY; this.muzzle.angle = this.aimAngle; this.muzzle.size = w.muzzle;
      this.spawnParticles(muzzleX, muzzleY, w.muzzle, "#ffe6a0");
      if (this.weapon !== "rapid") this.spawnShell(this.px, this.py - 6, this.aimAngle);
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

  private updateBullets(dt: number) {
    for (const b of this.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      // Walls kill any bullet — for enemy fire that IS the line-of-sight counterplay.
      if (this.isWall(b.x, b.y)) { b.life = 0; this.spawnSparks(b.x, b.y, 5, Math.atan2(-b.vy, -b.vx)); continue; }
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

  private updateEnemies(dt: number) {
    // One presence snapshot per frame (not per enemy) — enemy AI targets the nearest
    // living player, which in co-op splits aggro instead of dogpiling one client.
    const remotes = this.coop ? this.coop.remotePlayers() : null;
    for (const e of this.enemies) {
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
        if (this.hp <= 0 && !this.coop) return;
      }

      for (const b of this.bullets) {
        if (!b.friendly) continue;
        if (Math.hypot(b.x - e.x, b.y - e.y) < b.radius + e.radius) {
          e.hp -= b.damage; b.life = 0; triggerFlash(e.anim);
          this.spawnPuff(b.x, b.y, 5, ENEMY_ARCHETYPES[e.kind].tint);
          this.applyKnockback(e, b);
          if (this.weapon === "shotgun" && Math.hypot(this.px - e.x, this.py - e.y) < 96) this.addFreeze(FREEZE_SHOTGUN);
          if (e.hp <= 0 && !e.dead) this.killEnemy(e);
          else sfx("enemyHit", { gain: 0.65 });
        }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  // Contact damage is kind-aware: a ghost only bites while fully solid; the boss is
  // harmless while airborne mid hop-slam (its landing shockwave is the real threat).
  private canTouchDamage(e: Enemy): boolean {
    if (e.kind === "ghost") return e.attack.windup >= 0.98;
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

  private updateEnemyAI(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    switch (e.kind) {
      case "spitter": return this.updateSpitter(e, dt, remotes);
      case "boss": return this.updateBoss(e, dt, remotes);
      default: return this.updateChaser(e, dt, remotes);
    }
  }

  // Slime (chase), bat (zigzag), and — until they grow their own moves — skeleton/ghost.
  private updateChaser(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const arch = ENEMY_ARCHETYPES[e.kind];
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    let angle = Math.atan2(this.targetY - e.y, this.targetX - e.x);
    if (arch.movement === "zigzag") { e.zig += dt * 5; angle += Math.sin(e.zig) * 0.9; }
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
      this.sfxAt("spitCharge", e.x, e.y);
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
    this.sfxAt("spitFire", e.x, e.y);
    this.spawnPuff(mx, my, 6, "#ff5a7a");
  }

  private updateBoss(e: Enemy, dt: number, remotes: RemotePlayer[] | null): number {
    const boss = e.boss;
    if (!boss) return e.zig;
    boss.minionTimer -= dt;
    if (boss.minionTimer <= 0 && this.enemies.length < BOSS_MINION_CAP) {
      boss.minionTimer = 3.4;
      this.spawnBossMinion(e);
    }
    if (!this.findTarget(e.x, e.y, remotes)) return e.zig;
    const angle = Math.atan2(this.targetY - e.y, this.targetX - e.x);
    const step = e.speed * dt;
    this.moveEnemyBy(e, Math.cos(angle) * step, Math.sin(angle) * step);
    return angle;
  }

  private spawnBossMinion(e: Enemy) {
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
    const arch = ENEMY_ARCHETYPES[e.kind];
    const big = e.kind === "boss";
    this.spawnGibs(e.x, e.y, big ? 24 : 10, arch.tint);
    this.spawnParticles(e.x, e.y, big ? 20 : 8, big ? "#ffb43b" : arch.tint);
    this.addDecal(e.x, e.y, arch.tint, big ? 36 : 18, "splat");
    this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size: arch.drawSize, facing: this.px >= e.x ? 1 : -1, t: 0 });
    sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : undefined });
    this.addFreeze(big ? FREEZE_HEAVY : FREEZE_KILL);
    this.addTrauma(big ? TRAUMA_BOSS_KILL : TRAUMA_KILL);
    // A boss dying clears its danger off the board so the victory beat isn't a death.
    if (big) this.bullets = this.bullets.filter((b) => b.friendly);
    this.dropLoot(e);
  }

  private dropLoot(e: Enemy) {
    if (e.kind === "boss") {
      this.pickups.push(this.makePickup("heart", e.x - 18, e.y));
      for (let i = 0; i < 5; i++) this.pickups.push(this.makePickup("coin", e.x + (i - 2) * 16, e.y + 18));
      return;
    }
    if (Math.random() < 0.5) this.pickups.push(this.makePickup("coin", e.x, e.y));
    if (Math.random() < 0.12) this.pickups.push(this.makePickup("heart", e.x + 10, e.y));
  }

  private makePickup(kind: "heart" | "coin", x: number, y: number): Pickup {
    // A little drop pulse so freshly-dropped loot announces itself.
    const color = kind === "heart" ? "#ff6a6a" : "#ffd27a";
    this.addDecal(x, y, color, 15, "ring");
    this.spawnPuff(x, y, 5, color);
    return { kind, x, y, radius: 13, weapon: null, anim: createAnim() };
  }

  private updatePickups(dt: number) {
    const remaining: Pickup[] = [];
    for (const p of this.pickups) {
      stepAnim(p.anim, dt, false, 0);
      if (!this.isDown && Math.hypot(this.px - p.x, this.py - p.y) < this.pr + p.radius) {
        if (p.kind === "coin") { this.coins++; this.spawnParticles(p.x, p.y, 6, "#ffd27a"); sfx("coin"); continue; }
        if (p.kind === "heart") {
          if (this.hp < this.maxHp) { this.hp++; this.spawnParticles(p.x, p.y, 8, "#ff6a6a"); sfx("heart"); continue; }
        }
        if (p.kind === "weapon" && p.weapon) { this.weapon = p.weapon; this.fireCd = 0; this.spawnParticles(p.x, p.y, 12, "#ffb43b"); sfx("weapon"); continue; }
      }
      remaining.push(p);
    }
    this.pickups = remaining;
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
    for (const c of this.corpses) c.t += dt / DEATH_DUR;
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
    this.isDown = false; // a fresh floor brings downed teammates back up
    this.hp = Math.min(this.maxHp, this.hp + 2);
    sfx("descend");
    this.addTrauma(TRAUMA_DESCEND);
    this.loadFloor();
    this.hud.showBanner(isBossFloor(this.floor) ? "BOSS FLOOR" : `FLOOR ${this.floor}`);
  }

  private damagePlayer(amount: number) {
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
    this.hud.update({
      hp: this.hp, maxHp: this.maxHp,
      floor: this.floor, kills: this.kills, coins: this.coins,
      weaponName: WEAPONS[this.weapon].name,
      isCleared: this.enemies.length === 0,
      enemiesLeft: this.enemies.length,
      isBossActive,
      coopLabel,
    });
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
    });
  }

  private gameOver() {
    if (!this.isRunning) return;
    this.isRunning = false;
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
    ctx.fillStyle = "#0e0b1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // trauma² shake, scaled by the player's intensity setting. New random offset per
    // frame; the background fill above stays put so edges never flash the void.
    const mag = this.trauma * this.trauma * SHAKE_MAX_PX * settings.shakeIntensity;
    const shakeX = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    const shakeY = mag > 0.05 ? (Math.random() * 2 - 1) * mag : 0;
    ctx.save();
    ctx.translate(shakeX + this.kickX, shakeY + this.kickY);
    this.renderTiles();
    this.renderDecals();
    this.renderExit();
    this.renderPickups();
    this.renderParticles();
    this.renderCorpses();
    this.renderEnemies();
    this.renderBullets();
    this.renderTracers();
    this.renderRemotePlayers();
    this.renderAfterimages();
    this.renderPlayer();
    this.renderMuzzle();
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
    const { ctx, canvas, cam } = this;
    const d = this.dungeon;
    // +1 tile of margin on each edge so the screen-shake translate never exposes bg.
    const x0 = Math.max(0, Math.floor(cam.x / TILE) - 1);
    const y0 = Math.max(0, Math.floor(cam.y / TILE) - 1);
    const x1 = Math.min(d.w, Math.ceil((cam.x + canvas.width) / TILE) + 1);
    const y1 = Math.min(d.h, Math.ceil((cam.y + canvas.height) / TILE) + 1);
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        const wall = d.tiles[ty * d.w + tx] === 1;
        const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
        if (wall) {
          ctx.fillStyle = "#241a3a";
          ctx.fillRect(sx, sy, TILE, TILE);
          ctx.fillStyle = "#2f2350";
          ctx.fillRect(sx, sy, TILE, 6);
        } else {
          ctx.fillStyle = (tx + ty) % 2 === 0 ? "#171227" : "#1b1530";
          ctx.fillRect(sx, sy, TILE, TILE);
        }
      }
    }
  }

  private renderExit() {
    const { ctx, cam } = this;
    const d = this.dungeon;
    const ex = d.exit.x * TILE + TILE / 2 - cam.x, ey = d.exit.y * TILE + TILE / 2 - cam.y;
    const isCleared = this.enemies.length === 0;
    ctx.save();
    ctx.globalAlpha = isCleared ? 0.9 : 0.28;
    const g = ctx.createRadialGradient(ex, ey, 2, ex, ey, TILE * 0.7);
    g.addColorStop(0, isCleared ? "#8affc0" : "#5a6");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ex, ey, TILE * 0.7, 0, 6.28); ctx.fill();
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
    ctx.scale(facing * xf.sx * extra, xf.sy * extra);
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
      if (this.sprites.ready(name)) {
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
      } else {
        ctx.globalAlpha = p.kind === "puff" ? Math.min(1, a) * 0.55 : Math.min(1, a);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - cam.x - p.size / 2, p.y - cam.y - p.size / 2, p.size, p.size);
      }
    }
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

  private renderBullets() {
    const { ctx, cam } = this;
    for (const b of this.bullets) {
      const bx = b.x - cam.x, by = b.y - cam.y;
      if (b.friendly) {
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

  private renderTracers() {
    const { ctx, cam } = this;
    for (const tr of this.remoteTracers) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, tr.life / 0.12) * 0.8;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tr.x - cam.x, tr.y - cam.y);
      ctx.lineTo(tr.x - cam.x + Math.cos(tr.angle) * 42, tr.y - cam.y + Math.sin(tr.angle) * 42);
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

      ctx.fillStyle = color;
      ctx.font = "11px ui-monospace, Menlo, monospace";
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
    if (this.isDown) {
      ctx.fillStyle = "#ff6a6a";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText("DOWN \u2014 wait for a teammate", psx, psy - 34);
      ctx.textAlign = "left";
    }
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

  private renderReticle() {
    const { ctx } = this;
    ctx.strokeStyle = "rgba(255,210,122,0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(this.mouse.x, this.mouse.y, 8, 0, 6.28); ctx.stroke();
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
}
