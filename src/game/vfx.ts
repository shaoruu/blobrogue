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

// ---- ambient biome atmosphere ----
// Layered pools of tiny world-space particles, one recipe per biome band, that make each
// depth tier breathe differently: pollen and fireflies in the Hollow, ceiling drips in
// the Caves, wrong-gravity arcana in the Deep, embers and heat columns in Emberreach,
// glinting shards in the Fracture, and specks that drift TOWARD you in the Null. They
// react subtly to the player (running scatters pollen; the Null's specks hunt), wrap
// around the camera window, and draw additively at low alpha — alive, never busy.
// Everything is pooled and hard-capped; per-frame cost stays flat.

type MoteKind = "float" | "firefly" | "drip" | "ember" | "heat" | "shard" | "voidspeck";

interface Mote {
  x: number; y: number;
  vx: number; vy: number; // reaction impulse (decays); base drift comes from the layer
  phase: number;
  size: number;
  speedMult: number;
  layer: number;
}

interface MoteLayer {
  kind: MoteKind;
  color: string;
  count: number;
  alpha: number;
  rise: number;      // px/s vertical drift (negative = upward)
  sway: number;      // horizontal sway amplitude (px/s at peak)
  swayFreq: number;  // sway cycles per second
  size: number;      // base px
  reactRadius: number; // px around the player that reacts (0 = inert)
  reactPush: number;   // impulse px/s (negative = drawn toward the player)
}

// Indexed by biome index (see src/sim/biomes.ts).
const AMBIENCE_STYLES: readonly MoteLayer[][] = [
  [ // Verdant Hollow: drifting pollen the player scatters + lazy fireflies.
    { kind: "float", color: "#9fdc7a", count: 30, alpha: 0.32, rise: -13, sway: 11, swayFreq: 0.5, size: 1.8, reactRadius: 72, reactPush: 90 },
    { kind: "firefly", color: "#d8f27a", count: 8, alpha: 0.5, rise: -6, sway: 16, swayFreq: 0.22, size: 2.2, reactRadius: 90, reactPush: 60 },
  ],
  [ // Sunless Caves: hanging dust + ceiling drips that streak down and vanish.
    { kind: "float", color: "#8fc2e8", count: 26, alpha: 0.26, rise: 8, sway: 7, swayFreq: 0.35, size: 1.6, reactRadius: 60, reactPush: 55 },
    { kind: "drip", color: "#a8d8f0", count: 7, alpha: 0.5, rise: 240, sway: 0, swayFreq: 0.1, size: 3.2, reactRadius: 0, reactPush: 0 },
  ],
  [ // The Deep: arcane motes falling UP, unsettled by anyone who walks through.
    { kind: "float", color: "#b98aff", count: 30, alpha: 0.3, rise: -9, sway: 15, swayFreq: 0.28, size: 1.9, reactRadius: 84, reactPush: 70 },
    { kind: "firefly", color: "#7ae8ff", count: 6, alpha: 0.42, rise: -14, sway: 10, swayFreq: 0.16, size: 1.8, reactRadius: 70, reactPush: 50 },
  ],
  [ // Emberreach: hard-rising embers + broad heat-shimmer columns.
    { kind: "ember", color: "#ffb43b", count: 30, alpha: 0.38, rise: -26, sway: 9, swayFreq: 0.7, size: 1.8, reactRadius: 66, reactPush: 80 },
    { kind: "heat", color: "#ff6a2a", count: 6, alpha: 0.05, rise: -18, sway: 6, swayFreq: 0.18, size: 46, reactRadius: 0, reactPush: 0 },
  ],
  [ // The Fracture: slow lateral crystal glints that flare as you pass.
    { kind: "shard", color: "#6ff0d8", count: 22, alpha: 0.4, rise: -4, sway: 26, swayFreq: 0.12, size: 2.6, reactRadius: 90, reactPush: 40 },
    { kind: "float", color: "#2a8fa0", count: 18, alpha: 0.22, rise: 5, sway: 9, swayFreq: 0.3, size: 1.5, reactRadius: 60, reactPush: 45 },
  ],
  [ // The Null: void specks that drift toward the player. The world is watching.
    { kind: "voidspeck", color: "#ff4ad8", count: 24, alpha: 0.34, rise: 0, sway: 7, swayFreq: 0.2, size: 1.7, reactRadius: 240, reactPush: -26 },
    { kind: "float", color: "#d9a6ff", count: 16, alpha: 0.2, rise: -20, sway: 13, swayFreq: 0.4, size: 1.4, reactRadius: 70, reactPush: 60 },
  ],
];

const MOTE_MARGIN = 40; // px past the view edge before a mote wraps to the other side
const REACT_DECAY = 3;  // 1/s exponential decay of reaction impulses

export class AmbienceField {
  private motes: Mote[] = [];
  private layers: readonly MoteLayer[] = AMBIENCE_STYLES[0];

  // Rebuild the pool for a biome, scattered across the current camera window.
  reseed(biomeIdx: number, camX: number, camY: number, viewW: number, viewH: number): void {
    this.layers = AMBIENCE_STYLES[Math.min(biomeIdx, AMBIENCE_STYLES.length - 1)];
    this.motes.length = 0;
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      for (let i = 0; i < layer.count; i++) {
        this.motes.push({
          x: camX + Math.random() * viewW,
          y: camY + Math.random() * viewH,
          vx: 0, vy: 0,
          phase: Math.random() * 6.28,
          size: layer.size * (0.7 + Math.random() * 0.6),
          speedMult: 0.6 + Math.random() * 0.8,
          layer: li,
        });
      }
    }
  }

  // px/py: the local player (reaction center). pvx/pvy: their velocity, which scales and
  // directs the scatter so running through pollen actually parts it.
  update(dt: number, camX: number, camY: number, viewW: number, viewH: number,
    px: number, py: number, pvx: number, pvy: number): void {
    const left = camX - MOTE_MARGIN, right = camX + viewW + MOTE_MARGIN;
    const top = camY - MOTE_MARGIN, bottom = camY + viewH + MOTE_MARGIN;
    const spanX = right - left, spanY = bottom - top;
    const speed = Math.hypot(pvx, pvy);
    const decay = Math.exp(-REACT_DECAY * dt);
    for (const m of this.motes) {
      const layer = this.layers[m.layer];
      m.phase += dt * layer.swayFreq * 6.28;
      if (layer.reactRadius > 0) {
        const dx = m.x - px, dy = m.y - py;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && d < layer.reactRadius) {
          const falloff = 1 - d / layer.reactRadius;
          if (layer.reactPush >= 0) {
            // Scatter: pushed along the player's motion + gently outward. Standing still
            // barely stirs the air; running parts it.
            const k = layer.reactPush * falloff * Math.min(1, speed / 160) * dt;
            m.vx += (pvx / (speed || 1)) * k * 1.6 + (dx / d) * k;
            m.vy += (pvy / (speed || 1)) * k * 1.6 + (dy / d) * k;
          } else {
            // Drawn toward the player (the Null): constant unsettling drift, no speed gate.
            const k = -layer.reactPush * falloff * dt;
            m.vx -= (dx / d) * k;
            m.vy -= (dy / d) * k;
          }
        }
      }
      m.x += Math.sin(m.phase) * layer.sway * m.speedMult * dt + m.vx * 1.0;
      m.y += layer.rise * m.speedMult * dt + m.vy * 1.0;
      m.vx *= decay;
      m.vy *= decay;
      if (m.x < left) m.x += spanX; else if (m.x > right) m.x -= spanX;
      if (m.y < top) m.y += spanY; else if (m.y > bottom) m.y -= spanY;
    }
  }

  render(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    if (this.motes.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const m of this.motes) {
      const layer = this.layers[m.layer];
      const sx = m.x - camX, sy = m.y - camY;
      switch (layer.kind) {
        case "drip": {
          // Fall streak; the last stretch of each cycle reads as the splash flash.
          const cycle = (m.phase % 6.28) / 6.28;
          ctx.globalAlpha = layer.alpha * (cycle < 0.85 ? 0.8 : 2.2 * (1 - cycle));
          ctx.fillStyle = layer.color;
          ctx.fillRect(sx, sy, 1, m.size * (cycle < 0.85 ? 3 : 1));
          break;
        }
        case "heat": {
          const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, m.size);
          g.addColorStop(0, layer.color);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = layer.alpha * (0.7 + 0.3 * Math.sin(m.phase));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, m.size, 0, 6.28);
          ctx.fill();
          break;
        }
        case "shard": {
          // A twinkling cross glint; brightens hard at its pulse peak.
          const tw = Math.max(0, Math.sin(m.phase * 2.3));
          ctx.globalAlpha = layer.alpha * (0.25 + 0.75 * tw * tw);
          ctx.fillStyle = layer.color;
          const s = m.size * (0.8 + tw);
          ctx.fillRect(sx - s, sy - 0.5, s * 2, 1);
          ctx.fillRect(sx - 0.5, sy - s, 1, s * 2);
          break;
        }
        case "firefly": {
          const blink = Math.max(0, Math.sin(m.phase)) ** 3;
          ctx.globalAlpha = layer.alpha * blink;
          ctx.fillStyle = layer.color;
          ctx.fillRect(sx - m.size / 2, sy - m.size / 2, m.size, m.size);
          break;
        }
        case "ember": {
          ctx.globalAlpha = layer.alpha * (0.6 + 0.4 * Math.sin(m.phase * 3.1));
          ctx.fillStyle = layer.color;
          ctx.fillRect(sx - m.size / 2, sy - m.size / 2, m.size, m.size);
          break;
        }
        default: {
          ctx.globalAlpha = layer.alpha * (0.8 + 0.2 * Math.sin(m.phase));
          ctx.fillStyle = layer.color;
          ctx.fillRect(sx - m.size / 2, sy - m.size / 2, m.size, m.size);
          break;
        }
      }
    }
    ctx.restore();
  }
}
