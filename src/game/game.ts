import { generateDungeon } from "./dungeon.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import type { Enemy, Bullet, Particle, Pickup, WeaponId } from "./types.js";
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
import type { SfxName } from "./audio.js";
import { settings } from "./settings.js";

export interface RunResult { floor: number; kills: number; coins: number; }

export interface StartOptions {
  mode: "solo" | "coop";
  coop?: CoopBridge | null;
  profile?: ProfileStats | null;
}

interface RemoteTracer { x: number; y: number; angle: number; life: number; color: string; }
interface Corpse { sprite: SpriteName; x: number; y: number; size: number; facing: number; t: number; }
interface RemoteAnimEntry { anim: Anim; lastX: number; lastY: number; }

const REVIVE_RADIUS = 46;
const REVIVE_HOLD = 1.1;
const BOSS_MINION_CAP = 14;
const DEATH_DUR = 0.3;   // seconds a death "corpse" animates out
const MUZZLE_DUR = 0.07; // seconds the muzzle flash lingers
const BOSS_WINDUP = 0.6; // seconds before a boss spawn that it telegraphs

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
const TRAUMA_HURT = 0.4;
const TRAUMA_KILL = 0.16;
const TRAUMA_BOSS_KILL = 0.7;
const TRAUMA_BOSS_SLAM = 0.4;
const TRAUMA_DESCEND = 0.22;
const TRAUMA_BOSS_FLOOR = 0.5;
const TRAUMA_REMOTE_DOWN = 0.3;

export class Game {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private sprites = new Sprites();
  private minimap: Minimap;
  private hud: Hud;
  private onGameOver: (result: RunResult) => void;

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
  private remoteTracers: RemoteTracer[] = [];
  private remoteShotSeen = new Map<string, number>();
  private remoteDownSeen = new Map<string, boolean>();
  private remoteAnims = new Map<string, RemoteAnimEntry>();
  private reviveHold = new Map<string, number>();

  private playerAnim = createAnim();
  private isPlayerMoving = false;
  private playerLean = 0;
  private muzzle = { t: 0, x: 0, y: 0, angle: 0 };

  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, isDown: false };
  private cam = { x: 0, y: 0 };

  private isRunning = false;
  private last = 0;
  private raf = 0;
  private runStart = 0;
  private freeze = 0; // hit-stop timer (seconds); while > 0 gameplay updates pause
  private trauma = 0; // screen-shake trauma, 0..1

  private coop: CoopBridge | null = null;
  private profile: ProfileStats | null = null;
  private isStatsHeld = false;
  private pendingDescend = 0;

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, hudRoot: HTMLElement, onGameOver: (result: RunResult) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.minimap = new Minimap(minimapCanvas);
    this.hud = new Hud(hudRoot);
    this.onGameOver = onGameOver;
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
    audio.unlock();
    this.corpses = [];
    this.muzzle.t = 0;
    resetAnim(this.playerAnim);
    this.isPlayerMoving = false;
    this.playerLean = 0;
    this.runStart = performance.now();
    this.loadFloor();
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

  private addFreeze(seconds: number) {
    this.freeze = Math.min(FREEZE_MAX, Math.max(this.freeze, seconds));
  }

  private addTrauma(amount: number) {
    const t = this.trauma + amount;
    this.trauma = t > 1 ? 1 : t;
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
    if (this.muzzle.t > 0) this.muzzle.t = Math.max(0, this.muzzle.t - dt);
    if (this.coop) this.updateRemoteAnims(dt);
    this.updateExit();
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);

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
      this.invuln = Math.max(this.invuln, 0.2);
      sfx("dash");
    }
    let mvx: number, mvy: number;
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      mvx = this.dashDx * 620 * dt; mvy = this.dashDy * 620 * dt;
      this.spawnParticles(this.px, this.py, 1, "#ffd27a");
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
      triggerRecoil(this.playerAnim);
      this.muzzle.t = MUZZLE_DUR; this.muzzle.x = muzzleX; this.muzzle.y = muzzleY; this.muzzle.angle = this.aimAngle;
      this.spawnParticles(muzzleX, muzzleY, w.muzzle, "#ffe6a0");
      sfx(SHOOT_SFX[this.weapon]);
      this.addTrauma(FIRE_TRAUMA[this.weapon]);
    }
  }

  private updateBullets(dt: number) {
    for (const b of this.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (this.isWall(b.x, b.y)) { b.life = 0; this.spawnParticles(b.x, b.y, 3, "#fff"); }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);
  }

  private updateEnemies(dt: number) {
    for (const e of this.enemies) {
      const angle = this.moveEnemy(e, dt);
      stepAnim(e.anim, dt, true, Math.cos(angle));

      if (e.kind === "boss") this.updateBoss(e, dt);

      if (this.invuln === 0 && !this.isDown && Math.hypot(this.px - e.x, this.py - e.y) < this.pr + e.radius) {
        this.damagePlayer(e.touchDamage);
        if (this.hp <= 0 && !this.coop) return;
      }

      for (const b of this.bullets) {
        if (!b.friendly) continue;
        if (Math.hypot(b.x - e.x, b.y - e.y) < b.radius + e.radius) {
          e.hp -= b.damage; b.life = 0; triggerFlash(e.anim);
          this.spawnParticles(b.x, b.y, 5, "#c98bff");
          if (this.weapon === "shotgun" && Math.hypot(this.px - e.x, this.py - e.y) < 96) this.addFreeze(FREEZE_SHOTGUN);
          if (e.hp <= 0 && !e.dead) this.killEnemy(e);
          else sfx("enemyHit", { gain: 0.65 });
        }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  private moveEnemy(e: Enemy, dt: number): number {
    const arch = ENEMY_ARCHETYPES[e.kind];
    const toPlayer = Math.atan2(this.py - e.y, this.px - e.x);
    let angle = toPlayer;
    if (arch.movement === "zigzag") {
      e.zig += dt * 5;
      angle = toPlayer + Math.sin(e.zig) * 0.9;
    }
    const step = e.speed * dt;
    const dx = Math.cos(angle) * step, dy = Math.sin(angle) * step;
    if (arch.isPhasing) {
      // ghosts ignore geometry but stay inside the map bounds
      e.x = Math.max(TILE, Math.min((this.dungeon.w - 1) * TILE, e.x + dx));
      e.y = Math.max(TILE, Math.min((this.dungeon.h - 1) * TILE, e.y + dy));
    } else {
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, dx, 0);
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, 0, dy);
    }
    return angle;
  }

  private updateBoss(e: Enemy, dt: number) {
    e.spawnTimer -= dt;
    if (e.spawnTimer <= 0 && this.enemies.length < BOSS_MINION_CAP) {
      e.spawnTimer = 3.4;
      triggerRecoil(e.anim); // pop on the spawn beat
      const a = Math.random() * Math.PI * 2;
      const mx = e.x + Math.cos(a) * (e.radius + 20);
      const my = e.y + Math.sin(a) * (e.radius + 20);
      if (!this.isWall(mx, my)) {
        this.enemies.push(createEnemy("slime", mx, my, this.floor));
        this.spawnParticles(mx, my, 8, "#a855f7");
        if (this.isNearCamera(e.x, e.y)) { sfx("enemyHit", { gain: 0.5, rate: 0.6 }); this.addTrauma(TRAUMA_BOSS_SLAM); }
      }
    }
  }

  private killEnemy(e: Enemy) {
    e.dead = true;
    this.kills++;
    const arch = ENEMY_ARCHETYPES[e.kind];
    const big = e.kind === "boss";
    this.spawnParticles(e.x, e.y, big ? 40 : 16, big ? "#ffb43b" : "#a855f7");
    this.corpses.push({ sprite: arch.sprite, x: e.x, y: e.y, size: arch.drawSize, facing: this.px >= e.x ? 1 : -1, t: 0 });
    sfx("enemyDeath", { gain: big ? 1 : 0.85, rate: big ? 0.7 : undefined });
    this.addFreeze(big ? FREEZE_HEAVY : FREEZE_KILL);
    this.addTrauma(big ? TRAUMA_BOSS_KILL : TRAUMA_KILL);
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
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);
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
    this.onGameOver({ floor: this.floor, kills: this.kills, coins: this.coins });
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
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.4, maxLife: 0.7, color, size: 1 + Math.random() * 3 });
    }
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
    ctx.translate(shakeX, shakeY);
    this.renderTiles();
    this.renderExit();
    this.renderPickups();
    this.renderParticles();
    this.renderCorpses();
    this.renderEnemies();
    this.renderBullets();
    this.renderTracers();
    this.renderRemotePlayers();
    this.renderPlayer();
    this.renderMuzzle();
    ctx.restore();
    this.renderReticle();
    this.renderMinimap();
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
    const k = this.muzzle.t / MUZZLE_DUR;
    const mx = this.muzzle.x - cam.x, my = this.muzzle.y - cam.y;
    ctx.save();
    ctx.globalAlpha = k;
    const g = ctx.createRadialGradient(mx, my, 1, mx, my, 22);
    g.addColorStop(0, "#fff3c4");
    g.addColorStop(0.5, "#ffb43b");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(mx, my, 8 + k * 10, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  private renderParticles() {
    const { ctx, cam } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - cam.x - p.size / 2, p.y - cam.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  private renderEnemies() {
    const { ctx, cam } = this;
    for (const e of this.enemies) {
      const arch = ENEMY_ARCHETYPES[e.kind];
      const sx = e.x - cam.x, sy = e.y - cam.y;
      const facing = this.px >= e.x ? 1 : -1;
      let extra = 1;
      if (e.kind === "boss" && e.spawnTimer < BOSS_WINDUP) {
        extra = 1 + (1 - e.spawnTimer / BOSS_WINDUP) * 0.14; // telegraph wind-up
      }
      const clip: SheetClip = e.anim.move > 0.5 ? "walk" : "idle";
      const xf = characterXform(e.anim, e.kind === "boss" ? BOSS_STYLE : CHARACTER_STYLE);
      this.drawChar(arch.sprite, clip, sx, sy, arch.drawSize, facing, xf, extra, arch.alpha, e.anim.flash, e.anim.clock);
      const barW = e.kind === "boss" ? 64 : 32;
      const barY = sy - arch.drawSize / 2 - 8;
      ctx.fillStyle = "#000"; ctx.fillRect(sx - barW / 2, barY, barW, 4);
      ctx.fillStyle = e.kind === "boss" ? "#ffb43b" : "#ff5a5a";
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, e.hp / e.maxHp), 4);
    }
  }

  private renderBullets() {
    const { ctx, cam } = this;
    for (const b of this.bullets) {
      ctx.fillStyle = b.friendly ? b.color : "#ff6a6a";
      ctx.beginPath(); ctx.arc(b.x - cam.x, b.y - cam.y, b.radius, 0, 6.28); ctx.fill();
    }
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
