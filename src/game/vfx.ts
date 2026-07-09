// Client-only visual-effect subsystems layered over the pure sim: expanding shockwave
// rings (slams/explosions/boss beats), full-screen celebration flashes, and per-biome
// ambient motes that drift through the air. All of it is cosmetic — nothing here reads
// or writes sim state, so multiplayer/goldens can't be affected. Everything is pooled
// or hard-capped and renders in a handful of canvas calls, so the cost stays flat.

export interface Shockwave {
  x: number; y: number;
  t: number; dur: number;
  r0: number; r1: number;
  color: string;
  width: number;
}

const MAX_SHOCKWAVES = 12;

export class ShockwaveField {
  private list: Shockwave[] = [];

  spawn(x: number, y: number, r0: number, r1: number, dur: number, color: string, width = 4): void {
    if (this.list.length >= MAX_SHOCKWAVES) this.list.shift();
    this.list.push({ x, y, t: 0, dur, r0, r1, color, width });
  }

  clear(): void {
    this.list.length = 0;
  }

  update(dt: number): void {
    if (this.list.length === 0) return;
    for (const s of this.list) s.t += dt;
    this.list = this.list.filter((s) => s.t < s.dur);
  }

  render(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    if (this.list.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.list) {
      const k = s.t / s.dur; // 0..1
      const ease = 1 - (1 - k) * (1 - k); // ease-out: rings burst fast then coast
      const r = s.r0 + (s.r1 - s.r0) * ease;
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.width * (1 - k * 0.6));
      ctx.beginPath();
      ctx.arc(s.x - camX, s.y - camY, r, 0, 6.28);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// A brief additive full-screen wash for celebratory beats (boss down, blessing taken).
// Deliberately low-alpha: it should read as a glow, never a strobe.
export class ScreenFlash {
  private r = 255;
  private g = 255;
  private b = 255;
  private alpha = 0;
  private decay = 3;

  flash(r: number, g: number, b: number, strength: number, decay = 3): void {
    // Keep the stronger of overlapping flashes rather than stacking to white.
    if (strength <= this.alpha) return;
    this.r = r; this.g = g; this.b = b;
    this.alpha = Math.min(0.5, strength);
    this.decay = decay;
  }

  clear(): void {
    this.alpha = 0;
  }

  update(dt: number): void {
    if (this.alpha > 0) this.alpha = Math.max(0, this.alpha - dt * this.decay);
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.alpha <= 0.004) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(${this.r},${this.g},${this.b},${this.alpha})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

// ---- ambient biome motes ----
// A fixed pool of tiny drifting particles tinted per biome (pollen / cave dust / arcane
// motes / rising embers). They live in world space, wrap around the camera window, and
// draw additively at low alpha — the floor feels alive without competing with combat.

interface Mote {
  x: number; y: number;
  phase: number;
  size: number;
  speedMult: number;
}

export interface MoteStyle {
  color: string;
  rise: number;     // px/s vertical drift (negative = upward)
  sway: number;     // horizontal sway amplitude (px/s at peak)
  swayFreq: number; // sway cycles per second
  alpha: number;
  count: number;
  isFlicker: boolean; // embers pulse brightness; dust stays steady
}

// Indexed by biome index (see src/sim/biomes.ts): the curriculum's six regions —
// Amberwild, Rootbound Warrens, Sunless Caves, The Deep, Gilded Archive, Emberreach.
const MOTE_STYLES: readonly MoteStyle[] = [
  { color: "#9fdc7a", rise: -13, sway: 11, swayFreq: 0.5, alpha: 0.32, count: 34, isFlicker: false },
  { color: "#b6cc6e", rise: -10, sway: 13, swayFreq: 0.42, alpha: 0.3, count: 36, isFlicker: false },
  { color: "#8fc2e8", rise: 9, sway: 7, swayFreq: 0.35, alpha: 0.28, count: 30, isFlicker: false },
  { color: "#b98aff", rise: -7, sway: 15, swayFreq: 0.28, alpha: 0.3, count: 34, isFlicker: false },
  { color: "#ffd166", rise: -9, sway: 6, swayFreq: 0.3, alpha: 0.3, count: 28, isFlicker: true },
  { color: "#ffb43b", rise: -26, sway: 9, swayFreq: 0.7, alpha: 0.38, count: 30, isFlicker: true },
];

const MOTE_MARGIN = 40; // px past the view edge before a mote wraps to the other side

export class MoteField {
  private motes: Mote[] = [];
  private style: MoteStyle = MOTE_STYLES[0];

  // Rebuild the pool for a biome, scattered across the current camera window.
  reseed(biomeIdx: number, camX: number, camY: number, viewW: number, viewH: number): void {
    this.style = MOTE_STYLES[biomeIdx % MOTE_STYLES.length];
    this.motes.length = 0;
    for (let i = 0; i < this.style.count; i++) {
      this.motes.push({
        x: camX + Math.random() * viewW,
        y: camY + Math.random() * viewH,
        phase: Math.random() * 6.28,
        size: 1.5 + Math.random() * 1.8,
        speedMult: 0.6 + Math.random() * 0.8,
      });
    }
  }

  update(dt: number, camX: number, camY: number, viewW: number, viewH: number): void {
    const s = this.style;
    const left = camX - MOTE_MARGIN, right = camX + viewW + MOTE_MARGIN;
    const top = camY - MOTE_MARGIN, bottom = camY + viewH + MOTE_MARGIN;
    const spanX = right - left, spanY = bottom - top;
    for (const m of this.motes) {
      m.phase += dt * s.swayFreq * 6.28;
      m.x += Math.sin(m.phase) * s.sway * m.speedMult * dt;
      m.y += s.rise * m.speedMult * dt;
      if (m.x < left) m.x += spanX; else if (m.x > right) m.x -= spanX;
      if (m.y < top) m.y += spanY; else if (m.y > bottom) m.y -= spanY;
    }
  }

  render(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    if (this.motes.length === 0) return;
    const s = this.style;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = s.color;
    for (const m of this.motes) {
      const pulse = s.isFlicker ? 0.6 + 0.4 * Math.sin(m.phase * 3.1) : 0.8 + 0.2 * Math.sin(m.phase);
      ctx.globalAlpha = s.alpha * pulse;
      ctx.fillRect(m.x - camX - m.size / 2, m.y - camY - m.size / 2, m.size, m.size);
    }
    ctx.restore();
  }
}
