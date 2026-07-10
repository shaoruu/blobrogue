// Client-side ambient occlusion + authored local lighting (docs/specs/
// blobrogue_POST_SERVER_LIGHTING_spec.md, presentation layer only). Nothing here reads
// or writes sim state: the sim stays byte-identical and multiplayer/goldens can't be
// affected. Cached surfaces do the heavy lifting, so a frame costs a handful of 1:1
// blits + two upscaled composites and zero steady-state allocations:
//
//   Per floor (bake): a sub-tile AO field from dungeon geometry — wall/floor contact
//   bands, doubled-up concave corner pockets, pools around isolated pillars — and a
//   static light field (torches/braziers/ember hazards) as radial falloff x coarse tile
//   line-of-sight, so walls shape and BLOCK light instead of glow discs leaking through
//   geometry. Both are pre-scaled once into half-resolution floor canvases.
//
//   Per frame: a half-res occlusion buffer (ambient darkness + AO with every light cut
//   out of it) lands on screen as ONE nearest-neighbor upscale, followed by the
//   additive light stain (each light's color laid onto the ground it reaches). Dynamic
//   lights (hero glow, muzzle, luminous projectiles, eruptions, explosion pulses) come
//   from fixed pools; the big movers are occlusion-shaped per frame by the same tile
//   LOS, so a hero glow or explosion can never brighten the far side of a wall.
//
// The readability contract (spec §2) is enforced structurally: the grade renders inside
// the tile pass, BEFORE hazards/telegraphs/entities/HUD, so no tell can ever be
// darkened; the hero glow keeps the player's ground readable at every depth; and the
// accessibility settings are respected (high contrast halves the grade, reduced motion
// freezes the breathe).

import type { Dungeon } from "../sim/dungeon.js";
import type { Biome } from "../sim/biomes.js";
import { TILE } from "../sim/types.js";
import { settings } from "./settings.js";

// Sub-tile resolution of the baked fields: 4x4 cells per 48px tile = 12px cells,
// smoothed once at bake time so bands read soft, never blocky.
const CELL = 12;
const CELLS = TILE / CELL;
// Screen-space buffer downscale. The grade composes at half res and upscales
// nearest-neighbor — 2px blocks vanish under the 48px tile art, and skipping the
// full-screen smoothed upscale keeps software rasterizers fast too.
const DARK_SCALE = 2;
// AO reach from a wall face onto the floor (px) and the peak occlusion alpha at
// contact. Reach < TILE means only the 8 immediate neighbor tiles can ever contribute —
// the bake stays local and room centers provably clean.
const AO_REACH = 34;
const AO_MAX = 0.42;
const AO_INK = { r: 5, g: 3, b: 11 }; // the palette's shadow ink (#05030b)
// Pooled dynamic lights per frame. Sized for the worst authored scene: hero + 3
// teammates + muzzle + a bullet volley + a vent channel + the sinderling's full cinder
// wake (12, sim-capped) + the exit, with slack. Push order is priority order — identity
// glows first — so a saturated pool sheds ground dressing, never the readability floor.
const DYNAMIC_CAP = 32;
const PULSE_CAP = 8;    // pooled transient pulses (explosions)
const GLOW_SPRITE_PX = 128;
// Occlusion-shaping scratch: the largest pulse (explosion, 240px radius) at buffer
// resolution. Allocated once, reused for every shaped light.
const OCC_SCRATCH_PX = 256;

export type StaticLightKind = "torch" | "brazier" | "vent" | "rift" | "stall";

export interface StaticLightSpec {
  x: number;
  y: number;
  kind: StaticLightKind;
}

export interface SourceStyle {
  radius: number;    // px falloff reach
  intensity: number; // 0..1 peak ambient-darkness cut
  color: string;
}

// Halo geometry for the authored torch_glow art (renderProps draws it; the grammar owns
// per-biome throw/tint so one authored asset serves every band).
export interface HaloStyle {
  size: number;
  color: string;
}

export interface LightSample {
  intensity: number; // 0..1 static light at the point
  dx: number;        // light-field gradient (points TOWARD brighter ground)
  dy: number;
}

export interface LightingStats {
  bakeMs: number;     // last floor bake (AO + light fields + canvases)
  frameMs: number;    // EMA of per-frame grade cost
  staticCount: number;
  dynamicPeak: number;
}

// ---- per-biome light grammar (spec §5) ----
// Indexed by biome index (src/sim/biomes.ts order), like vfx.ts AMBIENCE_STYLES. The
// torch entry is the biome's authored light identity: warm and broad in the living
// bands, a warm beacon against the cold caves (spec: "warm torches against cold
// shale"), swallowed short throws in the Deep, hard pale gold in the Archive, hot in
// Emberreach, wrong lavender in the Null.
interface BiomeLightStyle {
  torch: SourceStyle;
  stainAlpha: number; // additive floor-stain strength for the baked light
}

const BIOME_LIGHT_STYLES: readonly BiomeLightStyle[] = [
  { torch: { radius: 215, intensity: 0.85, color: "#ffc86b" }, stainAlpha: 0.30 }, // Amberwild
  { torch: { radius: 205, intensity: 0.85, color: "#ffd166" }, stainAlpha: 0.30 }, // Rootbound
  { torch: { radius: 190, intensity: 0.90, color: "#ffd9a0" }, stainAlpha: 0.33 }, // Sunless
  { torch: { radius: 165, intensity: 0.82, color: "#b06bff" }, stainAlpha: 0.34 }, // Deep
  { torch: { radius: 200, intensity: 0.92, color: "#ffe9b0" }, stainAlpha: 0.32 }, // Gilded
  { torch: { radius: 180, intensity: 0.86, color: "#ff9a4a" }, stainAlpha: 0.34 }, // Ember
  { torch: { radius: 150, intensity: 0.80, color: "#d9a6ff" }, stainAlpha: 0.36 }, // Null
];

const VENT_STYLE: SourceStyle = { radius: 95, intensity: 0.4, color: "#ff7a2a" };

function biomeLightStyle(biomeIdx: number): BiomeLightStyle {
  return BIOME_LIGHT_STYLES[Math.min(biomeIdx, BIOME_LIGHT_STYLES.length - 1)];
}

function hexChannel(hex: string, i: number): number {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return parseInt(h.slice(i * 2, i * 2 + 2), 16);
}

// Quadratic falloff: 1 at the source, 0 at reach — soft without a blur pass.
function fall(d: number, reach: number): number {
  if (d >= reach) return 0;
  const t = 1 - d / reach;
  return t * t;
}

interface StaticLight {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  kind: StaticLightKind;
}

interface DynamicLight {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color: string;
  stainAlpha: number;
  isOccluded: boolean;
}

interface LightPulse {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color: string;
  t: number;
  dur: number;
}

export class LightingRenderer {
  // Dev A/B toggle: when off, the game falls back to the legacy flat depth-darkness
  // fill and constant entity shadows — an honest before/after of exactly this layer.
  isEnabled = true;

  readonly stats: LightingStats = { bakeMs: 0, frameMs: 0, staticCount: 0, dynamicPeak: 0 };

  private dungeon: Dungeon | null = null;
  private biome: Biome | null = null;
  private style: BiomeLightStyle = BIOME_LIGHT_STYLES[0];
  private statics: StaticLight[] = [];

  // Baked per-floor fields + half-resolution surfaces (grown, never shrunk).
  private aoField: Float32Array = new Float32Array(0);   // subcell occlusion 0..1
  private tileLight: Float32Array = new Float32Array(0); // per-tile static intensity 0..1
  private cellCanvas: HTMLCanvasElement | null = null;   // CELL-res bake intermediate
  private aoHalf: HTMLCanvasElement | null = null;       // AO ink at 1/DARK_SCALE world res
  private lightHalf: HTMLCanvasElement | null = null;    // static light at 1/DARK_SCALE world res
  private subW = 0;
  private subH = 0;
  private gridW = 0;
  private gridH = 0;
  // Bake scratch (subcell light accumulation), reused across floors.
  private accR: Float32Array = new Float32Array(0);
  private accG: Float32Array = new Float32Array(0);
  private accB: Float32Array = new Float32Array(0);
  private accC: Float32Array = new Float32Array(0);
  private visScratch: Uint8Array = new Uint8Array(0);
  private ambientDark = { r: 2, g: 1, b: 8 };

  // Per-frame buffers + sprites (allocated once, tinted glows cached per color).
  private darkCanvas: HTMLCanvasElement | null = null;
  private stainCanvas: HTMLCanvasElement | null = null;
  private glowSprite: HTMLCanvasElement | null = null;
  private tintedGlows = new Map<string, HTMLCanvasElement>();
  private shadowBlob: HTMLCanvasElement | null = null;
  private occScratch: HTMLCanvasElement | null = null;

  private dynamics: DynamicLight[] = [];
  private dynamicCount = 0;
  private pulses: LightPulse[] = [];
  private pulseHead = 0;
  private lastClock = 0;

  private sample: LightSample = { intensity: 0, dx: 0, dy: 0 };

  constructor() {
    for (let i = 0; i < DYNAMIC_CAP; i++) {
      this.dynamics.push({ x: 0, y: 0, radius: 0, intensity: 0, color: "#ffffff", stainAlpha: 0, isOccluded: false });
    }
    for (let i = 0; i < PULSE_CAP; i++) {
      this.pulses.push({ x: 0, y: 0, radius: 0, intensity: 0, color: "#ffffff", t: 1, dur: 1 });
    }
  }

  // ---- per-floor bake ----

  loadFloor(dungeon: Dungeon, biomeIdx: number, biome: Biome, specs: readonly StaticLightSpec[]): void {
    const t0 = performance.now();
    this.dungeon = dungeon;
    this.biome = biome;
    this.style = biomeLightStyle(biomeIdx);
    this.ambientDark = {
      r: hexChannel(biome.vignetteColor, 0),
      g: hexChannel(biome.vignetteColor, 1),
      b: hexChannel(biome.vignetteColor, 2),
    };
    this.statics = specs.map((s) => {
      const st = this.styleFor(s.kind);
      return {
        x: s.x, y: s.y,
        radius: st.radius, intensity: st.intensity,
        r: hexChannel(st.color, 0), g: hexChannel(st.color, 1), b: hexChannel(st.color, 2),
        kind: s.kind,
      };
    });
    this.gridW = dungeon.w;
    this.gridH = dungeon.h;
    this.subW = dungeon.w * CELLS;
    this.subH = dungeon.h * CELLS;
    const cells = this.subW * this.subH;
    if (this.aoField.length < cells) {
      this.aoField = new Float32Array(cells);
      this.accR = new Float32Array(cells);
      this.accG = new Float32Array(cells);
      this.accB = new Float32Array(cells);
      this.accC = new Float32Array(cells);
    }
    if (this.tileLight.length < this.gridW * this.gridH) this.tileLight = new Float32Array(this.gridW * this.gridH);
    this.bakeAo(dungeon);
    this.bakeLight(dungeon);
    this.dynamicCount = 0;
    for (const p of this.pulses) p.t = p.dur;
    this.stats.bakeMs = performance.now() - t0;
    this.stats.staticCount = this.statics.length;
  }

  private styleFor(kind: StaticLightKind): SourceStyle {
    const torch = this.style.torch;
    switch (kind) {
      case "torch": return torch;
      case "brazier": return { radius: torch.radius * 0.85, intensity: torch.intensity * 0.9, color: torch.color };
      case "vent": return VENT_STYLE;
      // The rift's resting anti-light takes the biome accent (void violet in the Deep,
      // wrong pink in the Null) — the same channel its body art already speaks.
      case "rift": return { radius: 85, intensity: 0.35, color: this.biome ? this.biome.accent : "#c98bff" };
      // Patch's stall: a broad ALWAYS-warm hearth pool over the waystation, deliberately
      // off the biome grammar — the shop reads as shelter in every band (spec §5, "no
      // combat-readability tax at home").
      case "stall": return { radius: 230, intensity: 0.95, color: "#ffd166" };
    }
  }

  torchHalo(): HaloStyle {
    return { size: this.style.torch.radius * 0.9, color: this.style.torch.color };
  }

  brazierHalo(): HaloStyle {
    return { size: this.style.torch.radius * 0.76, color: this.style.torch.color };
  }

  // Soft contact shading from dungeon geometry. Per floor subcell: each adjacent wall
  // FACE contributes a distance band, and a diagonal wall contributes a radial pocket
  // only when neither of its flanking faces already covers it — that rule keeps straight
  // walls perfectly even (no per-tile scalloping) while concave corners, where two
  // faces overlap, deepen naturally via the union.
  private bakeAo(d: Dungeon): void {
    const { w, h, tiles } = d;
    this.aoField.fill(0, 0, this.subW * this.subH);
    const isWall = (tx: number, ty: number): boolean =>
      tx < 0 || ty < 0 || tx >= w || ty >= h || tiles[ty * w + tx] === 1;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        if (tiles[ty * w + tx] === 1) continue;
        const wallN = isWall(tx, ty - 1);
        const wallS = isWall(tx, ty + 1);
        const wallW = isWall(tx - 1, ty);
        const wallE = isWall(tx + 1, ty);
        const wallNW = !wallN && !wallW && isWall(tx - 1, ty - 1);
        const wallNE = !wallN && !wallE && isWall(tx + 1, ty - 1);
        const wallSW = !wallS && !wallW && isWall(tx - 1, ty + 1);
        const wallSE = !wallS && !wallE && isWall(tx + 1, ty + 1);
        if (!wallN && !wallS && !wallW && !wallE && !wallNW && !wallNE && !wallSW && !wallSE) continue;
        for (let cy = 0; cy < CELLS; cy++) {
          const ly = cy * CELL + CELL / 2;
          for (let cx = 0; cx < CELLS; cx++) {
            const lx = cx * CELL + CELL / 2;
            let keep = 1;
            if (wallN) keep *= 1 - fall(ly, AO_REACH);
            if (wallS) keep *= 1 - fall(TILE - ly, AO_REACH);
            if (wallW) keep *= 1 - fall(lx, AO_REACH);
            if (wallE) keep *= 1 - fall(TILE - lx, AO_REACH);
            if (wallNW) keep *= 1 - fall(Math.hypot(lx, ly), AO_REACH);
            if (wallNE) keep *= 1 - fall(Math.hypot(TILE - lx, ly), AO_REACH);
            if (wallSW) keep *= 1 - fall(Math.hypot(lx, TILE - ly), AO_REACH);
            if (wallSE) keep *= 1 - fall(Math.hypot(TILE - lx, TILE - ly), AO_REACH);
            this.aoField[(ty * CELLS + cy) * this.subW + (tx * CELLS + cx)] = 1 - keep;
          }
        }
      }
    }
    this.cellCanvas = this.ensureCanvas(this.cellCanvas, this.subW, this.subH);
    const g = this.cellCanvas.getContext("2d");
    if (!g) return;
    const img = g.createImageData(this.subW, this.subH);
    const px = img.data;
    for (let i = 0; i < this.subW * this.subH; i++) {
      px[i * 4] = AO_INK.r;
      px[i * 4 + 1] = AO_INK.g;
      px[i * 4 + 2] = AO_INK.b;
      px[i * 4 + 3] = Math.round(this.aoField[i] * AO_MAX * 255);
    }
    g.putImageData(img, 0, 0);
    this.aoHalf = this.bakeHalf(this.aoHalf);
  }

  // Static light: radial falloff x coarse tile LOS, accumulated per subcell (tint
  // premixed) into the light surface, plus a per-tile intensity grid for sampleLight and
  // headless metrics. Flicker never touches the bake — the darkness hole stays steady
  // (spec §3: flicker is presentation, carried by the additive halo art).
  private bakeLight(d: Dungeon): void {
    const { w, h } = d;
    const cells = this.subW * this.subH;
    this.accR.fill(0, 0, cells);
    this.accG.fill(0, 0, cells);
    this.accB.fill(0, 0, cells);
    this.accC.fill(0, 0, cells);
    this.tileLight.fill(0, 0, w * h);
    for (const src of this.statics) {
      const stx = Math.min(w - 1, Math.max(0, Math.floor(src.x / TILE)));
      const sty = Math.min(h - 1, Math.max(0, Math.floor(src.y / TILE)));
      const reachTiles = Math.ceil(src.radius / TILE) + 1;
      const tx0 = Math.max(0, stx - reachTiles), tx1 = Math.min(w - 1, stx + reachTiles);
      const ty0 = Math.max(0, sty - reachTiles), ty1 = Math.min(h - 1, sty + reachTiles);
      const spanW = tx1 - tx0 + 1;
      const spanH = ty1 - ty0 + 1;
      if (this.visScratch.length < spanW * spanH) this.visScratch = new Uint8Array(spanW * spanH);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const isVisible = hasTileLos(d, stx, sty, tx, ty);
          this.visScratch[(ty - ty0) * spanW + (tx - tx0)] = isVisible ? 1 : 0;
          if (!isVisible) continue;
          const c = src.intensity * fall(Math.hypot((tx + 0.5) * TILE - src.x, (ty + 0.5) * TILE - src.y), src.radius);
          if (c <= 0) continue;
          const t = ty * w + tx;
          this.tileLight[t] = Math.min(1, this.tileLight[t] + c);
        }
      }
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (this.visScratch[(ty - ty0) * spanW + (tx - tx0)] === 0) continue;
          for (let cy = 0; cy < CELLS; cy++) {
            for (let cx = 0; cx < CELLS; cx++) {
              const px = tx * TILE + cx * CELL + CELL / 2;
              const py = ty * TILE + cy * CELL + CELL / 2;
              const c = src.intensity * fall(Math.hypot(px - src.x, py - src.y), src.radius);
              if (c <= 0) continue;
              const idx = (ty * CELLS + cy) * this.subW + (tx * CELLS + cx);
              this.accR[idx] += c * src.r;
              this.accG[idx] += c * src.g;
              this.accB[idx] += c * src.b;
              this.accC[idx] += c;
            }
          }
        }
      }
    }
    this.cellCanvas = this.ensureCanvas(this.cellCanvas, this.subW, this.subH);
    const g = this.cellCanvas.getContext("2d");
    if (!g) return;
    const img = g.createImageData(this.subW, this.subH);
    const px = img.data;
    for (let i = 0; i < cells; i++) {
      const sum = this.accC[i];
      if (sum <= 0) {
        px[i * 4 + 3] = 0;
        continue;
      }
      px[i * 4] = Math.min(255, this.accR[i] / sum);
      px[i * 4 + 1] = Math.min(255, this.accG[i] / sum);
      px[i * 4 + 2] = Math.min(255, this.accB[i] / sum);
      px[i * 4 + 3] = Math.round(Math.min(1, sum) * 255);
    }
    g.putImageData(img, 0, 0);
    this.lightHalf = this.bakeHalf(this.lightHalf);
  }

  // One smoothed upscale of the CELL-res bake into a half-world-res floor surface, so
  // per-frame composites are pure 1:1 blits.
  private bakeHalf(target: HTMLCanvasElement | null): HTMLCanvasElement | null {
    if (!this.cellCanvas) return target;
    const w = (this.subW * CELL) / DARK_SCALE;
    const h = (this.subH * CELL) / DARK_SCALE;
    const half = this.ensureCanvas(target, w, h);
    const g = half.getContext("2d");
    if (!g) return half;
    g.clearRect(0, 0, half.width, half.height);
    g.drawImage(this.cellCanvas, 0, 0, this.subW, this.subH, 0, 0, w, h);
    return half;
  }

  private ensureCanvas(canvas: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
    if (canvas && canvas.width >= w && canvas.height >= h) {
      const g = canvas.getContext("2d");
      if (g) g.clearRect(0, 0, canvas.width, canvas.height);
      return canvas;
    }
    const c = document.createElement("canvas");
    c.width = Math.max(w, canvas ? canvas.width : 0);
    c.height = Math.max(h, canvas ? canvas.height : 0);
    return c;
  }

  // ---- per-frame dynamic sources ----

  // Advance pulse lifetimes and reset the dynamic pool. Called once per RENDER frame
  // (never from the sim tick), keyed off the wall clock so hit-stop doesn't stall decay.
  beginFrame(clock: number): void {
    const dt = Math.min(0.1, Math.max(0, clock - this.lastClock));
    this.lastClock = clock;
    for (const p of this.pulses) {
      if (p.t < p.dur) p.t += dt;
    }
    if (this.dynamicCount > this.stats.dynamicPeak) this.stats.dynamicPeak = this.dynamicCount;
    this.dynamicCount = 0;
  }

  // stainAlpha > 0 additionally lays the light's color onto the ground it reaches
  // (scaled by intensity); isOccluded shapes the cut by coarse tile LOS.
  pushDynamic(x: number, y: number, radius: number, intensity: number, color: string, stainAlpha = 0, isOccluded = false): void {
    if (this.dynamicCount >= DYNAMIC_CAP || intensity <= 0.01) return;
    const slot = this.dynamics[this.dynamicCount++];
    slot.x = x;
    slot.y = y;
    slot.radius = radius;
    slot.intensity = intensity;
    slot.color = color;
    slot.stainAlpha = stainAlpha;
    slot.isOccluded = isOccluded;
  }

  // Transient flash (explosion): a ring slot, newest-wins, eased out over dur seconds.
  // Callers pre-scale intensity by the flash-level setting.
  addPulse(x: number, y: number, radius: number, intensity: number, color: string, dur: number): void {
    if (intensity <= 0.01) return;
    const p = this.pulses[this.pulseHead];
    this.pulseHead = (this.pulseHead + 1) % PULSE_CAP;
    p.x = x;
    p.y = y;
    p.radius = radius;
    p.intensity = intensity;
    p.color = color;
    p.t = 0;
    p.dur = dur;
  }

  // ---- per-frame render pass ----

  // The ambient grade in two screen composites: (1) the occlusion buffer — contact AO
  // plus the biome's ambient darkness with every light cut out of it — upscaled over
  // the world, then (2) the additive light stain (each light's own color on the ground
  // it reaches) drawn straight onto the frame. Replaces the legacy flat depth-darkness
  // fill at the same pipeline slot (end of the tile pass), so everything drawn later —
  // hazards, telegraphs, entities, HUD — sits above the grade by construction.
  renderGrade(ctx: CanvasRenderingContext2D, camX: number, camY: number, viewW: number, viewH: number, clock: number): void {
    if (!this.isEnabled || !this.dungeon || !this.lightHalf || !this.aoHalf || !this.biome) return;
    const t0 = performance.now();
    const win = this.tileWindow(camX, camY, viewW, viewH);
    if (win.ww <= 0 || win.wh <= 0) return;
    const ambient = this.ambientLevel(clock);
    const bw = win.ww / DARK_SCALE;
    const bh = win.wh / DARK_SCALE;
    const sx = win.wx / DARK_SCALE;
    const sy = win.wy / DARK_SCALE;
    // Screen destination at the EXACT fractional camera (the shared render-clock camera
    // every world pass subtracts): the window origin is tile-aligned in world space, so
    // this fraction is what keeps the light field locked to the smoothed world during a
    // pan. Snapping it would re-introduce per-pixel stepping against the scene — the
    // exact relative jitter the one-camera contract (test:rendersmooth) forbids.
    const dx = win.wx - camX;
    const dy = win.wy - camY;

    if (!this.darkCanvas || this.darkCanvas.width < bw || this.darkCanvas.height < bh) {
      this.darkCanvas = this.ensureCanvas(this.darkCanvas, bw, bh);
    }
    const dark = this.darkCanvas.getContext("2d");
    if (!dark) return;

    // Occlusion buffer: ambient bed + contact AO, then every light cut out of both, so
    // a torch pool also relaxes the contact shading it reaches.
    dark.save();
    dark.clearRect(0, 0, bw, bh);
    if (ambient > 0.004) {
      dark.globalAlpha = ambient;
      dark.fillStyle = `rgb(${this.ambientDark.r},${this.ambientDark.g},${this.ambientDark.b})`;
      dark.fillRect(0, 0, bw, bh);
    }
    dark.globalAlpha = settings.isHighContrast ? 0.55 : 1;
    dark.drawImage(this.aoHalf, sx, sy, bw, bh, 0, 0, bw, bh);
    dark.globalCompositeOperation = "destination-out";
    dark.globalAlpha = 1;
    dark.drawImage(this.lightHalf, sx, sy, bw, bh, 0, 0, bw, bh);
    // Glow sprites sample nearest: a 128px radial gradient is low-frequency, so nearest
    // at half res is indistinguishable after the upscale and skips cairo's slow
    // filtered-composite path (a real cost with a dozen live lights).
    dark.imageSmoothingEnabled = false;
    const glow = this.ensureGlowSprite();
    for (let i = 0; i < this.dynamicCount; i++) {
      const dl = this.dynamics[i];
      if (dl.isOccluded) this.shapedGlow(dark, glow, dl.x, dl.y, dl.radius, dl.intensity, win.wx, win.wy, DARK_SCALE);
      else this.bufferGlow(dark, glow, dl.x, dl.y, dl.radius, dl.intensity, win.wx, win.wy);
    }
    for (const p of this.pulses) {
      if (p.t >= p.dur) continue;
      const ease = 1 - p.t / p.dur;
      this.shapedGlow(dark, glow, p.x, p.y, p.radius, p.intensity * ease * ease, win.wx, win.wy, DARK_SCALE);
    }
    dark.restore();

    // Stain buffer: the baked light's own color over the ground it reaches (and the
    // wall caps that catch it), plus the dynamic stains/pulses — half res, one upscale.
    if (!this.stainCanvas || this.stainCanvas.width < bw || this.stainCanvas.height < bh) {
      this.stainCanvas = this.ensureCanvas(this.stainCanvas, bw, bh);
    }
    const stain = this.stainCanvas.getContext("2d");
    if (!stain) return;
    stain.save();
    stain.clearRect(0, 0, bw, bh);
    stain.globalAlpha = this.style.stainAlpha;
    stain.drawImage(this.lightHalf, sx, sy, bw, bh, 0, 0, bw, bh);
    stain.globalCompositeOperation = "lighter";
    stain.imageSmoothingEnabled = false;
    for (let i = 0; i < this.dynamicCount; i++) {
      const dl = this.dynamics[i];
      if (dl.stainAlpha <= 0) continue;
      const img = this.tintedGlow(dl.color);
      const alpha = Math.min(1, dl.intensity * dl.stainAlpha);
      if (dl.isOccluded) this.shapedGlow(stain, img, dl.x, dl.y, dl.radius, alpha, win.wx, win.wy, DARK_SCALE);
      else this.bufferGlow(stain, img, dl.x, dl.y, dl.radius, alpha, win.wx, win.wy);
    }
    for (const p of this.pulses) {
      if (p.t >= p.dur) continue;
      const ease = 1 - p.t / p.dur;
      this.shapedGlow(stain, this.tintedGlow(p.color), p.x, p.y, p.radius, p.intensity * ease * ease * 0.6, win.wx, win.wy, DARK_SCALE);
    }
    stain.restore();

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.darkCanvas, 0, 0, bw, bh, dx, dy, win.ww, win.wh);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(this.stainCanvas, 0, 0, bw, bh, dx, dy, win.ww, win.wh);
    ctx.restore();
    this.noteFrameCost(performance.now() - t0);
  }

  // A radial glow sprite drawn straight into the half-res buffer.
  private bufferGlow(g: CanvasRenderingContext2D, sprite: HTMLCanvasElement, x: number, y: number, radius: number, alpha: number, wx: number, wy: number): void {
    if (alpha <= 0.01) return;
    const s = (radius * 2) / DARK_SCALE;
    g.globalAlpha = Math.min(1, alpha);
    g.drawImage(sprite, (x - radius - wx) / DARK_SCALE, (y - radius - wy) / DARK_SCALE, s, s);
  }

  // Occlusion-shaped glow: the sprite is stamped into a scratch, every tile without
  // coarse LOS from the source is erased, and the shaped mask lands in the target — a
  // hero glow or explosion flash can never brighten the far side of a wall. Only the
  // big movers pay for this; small projectile lights skip it. ox/oy map world -> target
  // space at 1/scale resolution (the darkness buffer or the screen).
  private shapedGlow(g: CanvasRenderingContext2D, sprite: HTMLCanvasElement, x: number, y: number, radius: number, alpha: number, ox: number, oy: number, scale: number): void {
    if (alpha <= 0.01 || !this.dungeon) return;
    const s = (radius * 2) / scale;
    if (!this.occScratch) {
      this.occScratch = document.createElement("canvas");
      this.occScratch.width = OCC_SCRATCH_PX;
      this.occScratch.height = OCC_SCRATCH_PX;
    }
    const side = Math.min(OCC_SCRATCH_PX, Math.ceil(s));
    const sg = this.occScratch.getContext("2d");
    if (!sg) return;
    sg.clearRect(0, 0, side, side);
    sg.drawImage(sprite, 0, 0, side, side);
    const d = this.dungeon;
    const stx = Math.min(d.w - 1, Math.max(0, Math.floor(x / TILE)));
    const sty = Math.min(d.h - 1, Math.max(0, Math.floor(y / TILE)));
    const tx0 = Math.max(0, Math.floor((x - radius) / TILE));
    const ty0 = Math.max(0, Math.floor((y - radius) / TILE));
    const tx1 = Math.min(d.w - 1, Math.floor((x + radius) / TILE));
    const ty1 = Math.min(d.h - 1, Math.floor((y + radius) / TILE));
    // Scratch cell size: the scratch holds the glow at `side` px across 2*radius world px.
    const cell = (TILE / (radius * 2)) * side;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (hasTileLos(d, stx, sty, tx, ty)) continue;
        sg.clearRect(
          ((tx * TILE - (x - radius)) / (radius * 2)) * side,
          ((ty * TILE - (y - radius)) / (radius * 2)) * side,
          cell + 0.5, cell + 0.5,
        );
      }
    }
    const prevAlpha = g.globalAlpha;
    g.globalAlpha = Math.min(1, alpha);
    g.drawImage(this.occScratch, 0, 0, side, side, (x - radius - ox) / scale, (y - radius - oy) / scale, s, s);
    g.globalAlpha = prevAlpha;
  }

  // Legacy-compatible ambient: the same lightLevel + pulse-breathe budget the flat fill
  // used, gated by accessibility — reduced motion freezes the breathe at its midpoint,
  // high contrast halves the whole ambient bed.
  private ambientLevel(clock: number): number {
    const biome = this.biome;
    if (!biome) return 0;
    let breathe = 0;
    if (biome.pulse > 0) {
      breathe = settings.isReducedMotion ? biome.pulse * 0.5 : biome.pulse * 0.5 * (1 + Math.sin(clock * 1.3));
    }
    const base = Math.min(0.5, biome.lightLevel + breathe);
    return settings.isHighContrast ? base * 0.5 : base;
  }

  private tileWindow(camX: number, camY: number, viewW: number, viewH: number): { wx: number; wy: number; ww: number; wh: number } {
    const d = this.dungeon!;
    const x0 = Math.max(0, Math.floor(camX / TILE) - 1);
    const y0 = Math.max(0, Math.floor(camY / TILE) - 1);
    const x1 = Math.min(d.w, Math.ceil((camX + viewW) / TILE) + 1);
    const y1 = Math.min(d.h, Math.ceil((camY + viewH) / TILE) + 1);
    return { wx: x0 * TILE, wy: y0 * TILE, ww: Math.max(0, (x1 - x0) * TILE), wh: Math.max(0, (y1 - y0) * TILE) };
  }

  private ensureGlowSprite(): HTMLCanvasElement {
    if (this.glowSprite) return this.glowSprite;
    const c = document.createElement("canvas");
    c.width = GLOW_SPRITE_PX;
    c.height = GLOW_SPRITE_PX;
    const g = c.getContext("2d");
    if (g) {
      const half = GLOW_SPRITE_PX / 2;
      const grad = g.createRadialGradient(half, half, 1, half, half, half);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.45, "rgba(255,255,255,0.38)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, GLOW_SPRITE_PX, GLOW_SPRITE_PX);
    }
    this.glowSprite = c;
    return c;
  }

  private tintedGlow(color: string): HTMLCanvasElement {
    const cached = this.tintedGlows.get(color);
    if (cached) return cached;
    const base = this.ensureGlowSprite();
    const c = document.createElement("canvas");
    c.width = base.width;
    c.height = base.height;
    const g = c.getContext("2d");
    if (g) {
      g.drawImage(base, 0, 0);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
    }
    this.tintedGlows.set(color, c);
    return c;
  }

  // A soft radial shadow blob for entity/prop grounding (replaces the hard ellipse when
  // the layer is enabled): alpha falls 1 -> 0 from the center, so contacts read as
  // occlusion pools rather than stamped outlines.
  shadowSprite(): HTMLCanvasElement {
    if (this.shadowBlob) return this.shadowBlob;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(32, 32, 1, 32, 32, 32);
      grad.addColorStop(0, "rgba(5,3,11,1)");
      grad.addColorStop(0.55, "rgba(5,3,11,0.5)");
      grad.addColorStop(1, "rgba(5,3,11,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    this.shadowBlob = c;
    return c;
  }

  // ---- queries (shadows, tests, dev readouts) ----

  // Static light at a world point: bilinear intensity over tile centers plus the local
  // grid gradient (which points TOWARD the light, because the grid is occlusion-aware —
  // a wall between torch and entity zeroes both). Returns a reused scratch object.
  sampleLight(x: number, y: number): LightSample {
    const out = this.sample;
    if (!this.isEnabled || !this.dungeon) {
      out.intensity = 0;
      out.dx = 0;
      out.dy = 0;
      return out;
    }
    out.intensity = this.lightIntensityAt(x, y);
    const tx = Math.min(this.gridW - 1, Math.max(0, Math.round(x / TILE - 0.5)));
    const ty = Math.min(this.gridH - 1, Math.max(0, Math.round(y / TILE - 0.5)));
    const left = this.tileLight[ty * this.gridW + Math.max(0, tx - 1)];
    const right = this.tileLight[ty * this.gridW + Math.min(this.gridW - 1, tx + 1)];
    const up = this.tileLight[Math.max(0, ty - 1) * this.gridW + tx];
    const down = this.tileLight[Math.min(this.gridH - 1, ty + 1) * this.gridW + tx];
    out.dx = (right - left) * 0.5;
    out.dy = (down - up) * 0.5;
    return out;
  }

  lightIntensityAt(x: number, y: number): number {
    if (!this.dungeon || this.gridW === 0) return 0;
    const gx = Math.min(this.gridW - 1.001, Math.max(0, x / TILE - 0.5));
    const gy = Math.min(this.gridH - 1.001, Math.max(0, y / TILE - 0.5));
    const tx = Math.floor(gx);
    const ty = Math.floor(gy);
    const fx = gx - tx;
    const fy = gy - ty;
    const w = this.gridW;
    const i00 = this.tileLight[ty * w + tx];
    const i10 = this.tileLight[ty * w + Math.min(w - 1, tx + 1)];
    const i01 = this.tileLight[Math.min(this.gridH - 1, ty + 1) * w + tx];
    const i11 = this.tileLight[Math.min(this.gridH - 1, ty + 1) * w + Math.min(w - 1, tx + 1)];
    return (i00 * (1 - fx) + i10 * fx) * (1 - fy) + (i01 * (1 - fx) + i11 * fx) * fy;
  }

  aoAt(x: number, y: number): number {
    if (!this.dungeon || this.subW === 0) return 0;
    const cx = Math.min(this.subW - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(this.subH - 1, Math.max(0, Math.floor(y / CELL)));
    return this.aoField[cy * this.subW + cx];
  }

  staticLights(): readonly { x: number; y: number; radius: number; intensity: number; kind: StaticLightKind }[] {
    return this.statics;
  }

  debugSurfaces(): { ao: HTMLCanvasElement | null; light: HTMLCanvasElement | null } {
    return { ao: this.aoHalf, light: this.lightHalf };
  }

  private noteFrameCost(ms: number): void {
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.08;
  }
}

// Coarse tile line-of-sight: walk the Bresenham line between tile centers; any
// intermediate wall blocks, and a diagonal step is blocked when BOTH flanking cells are
// wall (light never slips between kissing corners). Endpoints are exempt so a
// wall-mounted torch lights out of its own block and neighboring caps still catch light.
function hasTileLos(d: Dungeon, x0: number, y0: number, x1: number, y1: number): boolean {
  const isWall = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= d.w || y >= d.h || d.tiles[y * d.w + x] === 1;
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    const isStepX = e2 >= dy;
    const isStepY = e2 <= dx;
    if (isStepX && isStepY && isWall(x + sx, y) && isWall(x, y + sy)) return false;
    if (isStepX) {
      err += dy;
      x += sx;
    }
    if (isStepY) {
      err += dx;
      y += sy;
    }
    if (x === x1 && y === y1) break;
    if (isWall(x, y)) return false;
  }
  return true;
}
