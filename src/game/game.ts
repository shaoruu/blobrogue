import { generateDungeon } from "./dungeon.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import type { Enemy, Bullet, Particle } from "./types.js";

const HERO_SRC = "/sprites/hero.png";
const SLIME_SRC = "/sprites/slime.png";

function loadImg(src: string): HTMLImageElement {
  const i = new Image();
  i.src = src;
  return i;
}

export class Game {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  onGameOver: (floor: number, kills: number) => void;

  heroImg = loadImg(HERO_SRC);
  slimeImg = loadImg(SLIME_SRC);

  dungeon!: Dungeon;
  floor = 1;
  seed = Math.floor(Math.random() * 1e9);
  kills = 0;

  // player
  px = 0; py = 0; pvx = 0; pvy = 0;
  pr = 18;
  hp = 6; maxHp = 6;
  invuln = 0;
  dashCd = 0; dashTime = 0; dashDx = 0; dashDy = 0;
  fireCd = 0;
  facing = 1;

  enemies: Enemy[] = [];
  bullets: Bullet[] = [];
  particles: Particle[] = [];

  keys = new Set<string>();
  mouse = { x: 0, y: 0, down: false };
  cam = { x: 0, y: 0 };

  running = false;
  last = 0;
  raf = 0;

  constructor(canvas: HTMLCanvasElement, hud: HTMLElement, onGameOver: (f: number, k: number) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.hud = hud;
    this.onGameOver = onGameOver;
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = Math.min(window.innerWidth, 1100);
    const h = Math.min(window.innerHeight, 720);
    this.canvas.width = w;
    this.canvas.height = h;
  }

  bindInput() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.key.toLowerCase());
      if ([" ", "shift"].includes(e.key.toLowerCase())) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    });
    this.canvas.addEventListener("mousedown", () => (this.mouse.down = true));
    window.addEventListener("mouseup", () => (this.mouse.down = false));
  }

  start() {
    this.floor = 1; this.kills = 0; this.hp = this.maxHp;
    this.seed = Math.floor(Math.random() * 1e9);
    this.loadFloor();
    this.running = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.loop(this.last);
  }

  loadFloor() {
    this.dungeon = generateDungeon(this.seed, this.floor);
    const d = this.dungeon;
    this.px = d.spawn.x * TILE + TILE / 2;
    this.py = d.spawn.y * TILE + TILE / 2;
    this.enemies = [];
    this.bullets = [];
    this.particles = [];
    // spawn enemies in rooms other than the first
    const count = 4 + this.floor * 2;
    for (let i = 0; i < count; i++) {
      const room = d.rooms[1 + Math.floor(Math.random() * (d.rooms.length - 1))];
      if (!room) continue;
      const ex = (room.x + 1 + Math.random() * (room.w - 2)) * TILE;
      const ey = (room.y + 1 + Math.random() * (room.h - 2)) * TILE;
      const hp = 3 + Math.floor(this.floor * 0.7);
      this.enemies.push({
        kind: "slime", x: ex, y: ey, vx: 0, vy: 0, radius: 16,
        hp, maxHp: hp, dead: false, speed: 40 + this.floor * 4,
        touchDamage: 1, hitFlash: 0, wobble: Math.random() * 6.28,
      });
    }
  }

  isWall(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) return true;
    return this.dungeon.tiles[ty * this.dungeon.w + tx] === 1;
  }

  moveCircle(x: number, y: number, r: number, dx: number, dy: number): [number, number] {
    let nx = x + dx, ny = y + dy;
    if (!this.isWall(nx + Math.sign(dx) * r, y)) x = nx; // x axis
    if (!this.isWall(x, ny + Math.sign(dy) * r)) y = ny; // y axis
    return [x, y];
  }

  loop = (t: number) => {
    if (!this.running) return;
    const dt = Math.min((t - this.last) / 1000, 0.05);
    this.last = t;
    this.update(dt);
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  update(dt: number) {
    // ---- player movement ----
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
    if ((this.keys.has("shift")) && this.dashCd === 0 && (ix || iy)) {
      this.dashTime = 0.16; this.dashCd = 0.7; this.dashDx = ix; this.dashDy = iy; this.invuln = Math.max(this.invuln, 0.2);
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

    // ---- shooting ----
    this.fireCd = Math.max(0, this.fireCd - dt);
    if (this.mouse.down && this.fireCd === 0) {
      const wx = this.mouse.x + this.cam.x, wy = this.mouse.y + this.cam.y;
      const a = Math.atan2(wy - this.py, wx - this.px);
      const spd = 560;
      this.bullets.push({ x: this.px, y: this.py, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, radius: 6, life: 1.1, friendly: true, damage: 2 });
      this.fireCd = 0.16;
      this.spawnParticles(this.px + Math.cos(a) * 20, this.py + Math.sin(a) * 20, 2, "#ffe6a0");
    }

    // ---- bullets ----
    for (const b of this.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (this.isWall(b.x, b.y)) { b.life = 0; this.spawnParticles(b.x, b.y, 4, "#fff"); }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);

    // ---- enemies ----
    for (const e of this.enemies) {
      e.wobble += dt * 6;
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      const a = Math.atan2(this.py - e.y, this.px - e.x);
      const em = e.speed * dt;
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, Math.cos(a) * em, 0);
      [e.x, e.y] = this.moveCircle(e.x, e.y, e.radius, 0, Math.sin(a) * em);
      // touch damage
      if (this.invuln === 0 && Math.hypot(this.px - e.x, this.py - e.y) < this.pr + e.radius) {
        this.hp -= e.touchDamage; this.invuln = 0.9;
        this.spawnParticles(this.px, this.py, 10, "#ff5a5a");
        if (this.hp <= 0) { this.gameOver(); return; }
      }
      // bullet hits
      for (const b of this.bullets) {
        if (!b.friendly) continue;
        if (Math.hypot(b.x - e.x, b.y - e.y) < b.radius + e.radius) {
          e.hp -= b.damage; b.life = 0; e.hitFlash = 0.12;
          this.spawnParticles(b.x, b.y, 6, "#c98bff");
          if (e.hp <= 0 && !e.dead) { e.dead = true; this.kills++; this.spawnParticles(e.x, e.y, 18, "#a855f7"); }
        }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);

    // ---- particles ----
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);

    // ---- exit (only when floor cleared) ----
    const ex = this.dungeon.exit.x * TILE + TILE / 2, ey = this.dungeon.exit.y * TILE + TILE / 2;
    if (this.enemies.length === 0 && Math.hypot(this.px - ex, this.py - ey) < TILE) {
      this.floor++;
      this.hp = Math.min(this.maxHp, this.hp + 2);
      this.loadFloor();
    }

    // ---- camera ----
    this.cam.x = this.px - this.canvas.width / 2;
    this.cam.y = this.py - this.canvas.height / 2;

    this.updateHud();
  }

  spawnParticles(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 40 + Math.random() * 140;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.4, maxLife: 0.7, color, size: 1 + Math.random() * 3 });
    }
  }

  updateHud() {
    const hearts = "♥".repeat(Math.max(0, this.hp)) + "♡".repeat(Math.max(0, this.maxHp - this.hp));
    const cleared = this.enemies.length === 0 ? " · <span style='color:#7CFC98'>floor cleared! find the exit ▾</span>" : ` · enemies: ${this.enemies.length}`;
    this.hud.innerHTML = `<span style="color:#ff6a6a">${hearts}</span>  ·  floor ${this.floor}  ·  kills ${this.kills}${cleared}`;
  }

  gameOver() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.onGameOver(this.floor, this.kills);
  }

  render() {
    const { ctx, canvas, cam } = this;
    ctx.fillStyle = "#0e0b1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const d = this.dungeon;
    const x0 = Math.max(0, Math.floor(cam.x / TILE));
    const y0 = Math.max(0, Math.floor(cam.y / TILE));
    const x1 = Math.min(d.w, Math.ceil((cam.x + canvas.width) / TILE));
    const y1 = Math.min(d.h, Math.ceil((cam.y + canvas.height) / TILE));

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

    // exit portal (glows when cleared)
    const ex = d.exit.x * TILE + TILE / 2 - cam.x, ey = d.exit.y * TILE + TILE / 2 - cam.y;
    const cleared = this.enemies.length === 0;
    ctx.save();
    ctx.globalAlpha = cleared ? 0.9 : 0.3;
    const g = ctx.createRadialGradient(ex, ey, 2, ex, ey, TILE * 0.7);
    g.addColorStop(0, cleared ? "#8affc0" : "#5a6");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ex, ey, TILE * 0.7, 0, 6.28); ctx.fill();
    ctx.restore();

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - cam.x - p.size / 2, p.y - cam.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // enemies
    for (const e of this.enemies) {
      const sx = e.x - cam.x, sy = e.y - cam.y + Math.sin(e.wobble) * 2;
      if (this.slimeImg.complete) {
        if (e.hitFlash > 0) { ctx.save(); ctx.globalAlpha = 0.9; }
        ctx.drawImage(this.slimeImg, sx - 22, sy - 22, 44, 44);
        if (e.hitFlash > 0) ctx.restore();
      } else { ctx.fillStyle = "#a855f7"; ctx.beginPath(); ctx.arc(sx, sy, e.radius, 0, 6.28); ctx.fill(); }
      // hp bar
      ctx.fillStyle = "#000"; ctx.fillRect(sx - 16, sy - 30, 32, 4);
      ctx.fillStyle = "#ff5a5a"; ctx.fillRect(sx - 16, sy - 30, 32 * (e.hp / e.maxHp), 4);
    }

    // bullets
    for (const b of this.bullets) {
      ctx.fillStyle = b.friendly ? "#ffd27a" : "#ff6a6a";
      ctx.beginPath(); ctx.arc(b.x - cam.x, b.y - cam.y, b.radius, 0, 6.28); ctx.fill();
    }

    // player
    const psx = this.px - cam.x, psy = this.py - cam.y;
    if (this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0) ctx.globalAlpha = 0.4;
    if (this.heroImg.complete) {
      ctx.save();
      ctx.translate(psx, psy);
      ctx.scale(this.facing, 1);
      ctx.drawImage(this.heroImg, -26, -30, 52, 52);
      ctx.restore();
    } else { ctx.fillStyle = "#ffb43b"; ctx.beginPath(); ctx.arc(psx, psy, this.pr, 0, 6.28); ctx.fill(); }
    ctx.globalAlpha = 1;

    // aim reticle
    ctx.strokeStyle = "rgba(255,210,122,0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(this.mouse.x, this.mouse.y, 8, 0, 6.28); ctx.stroke();
  }
}
