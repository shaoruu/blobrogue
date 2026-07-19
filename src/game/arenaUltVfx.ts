import type { PlayerId } from "../sim/input.js";
import { ARENA_SALVO, ARENA_SHOVE, ARENA_SLIP, ARENA_TRIAGE } from "../sim/pvp.js";
import type { ArenaUltKind } from "../sim/pvp.js";
import type { Sprites } from "./assets.js";

export const ARENA_ULT_HUE: Record<ArenaUltKind, string> = {
  salvo: "#7fe0ff",
  triage: "#7fe6a8",
  shove: "#ddeeff",
  slip: "#9a5cff",
};

export const ARENA_SALVO_CORE = "#e8ffff";
export const ARENA_SALVO_GLOW = "#3fb9d6";

const ARENA_ULT_CORE: Record<ArenaUltKind, string> = {
  salvo: ARENA_SALVO_CORE,
  triage: "#eafff0",
  shove: "#eaf3ff",
  slip: "#c98bff",
};

const MAX_CASTS = 8;
const MAX_HIT_PULSES = 10;
const SHOVE_ARC = ARENA_SHOVE.arcDeg * Math.PI / 180;
const SALVO_SCAR_SEC = 0.4;
const SALVO_HIT_PULSE_SEC = 0.2;
const SHOVE_GLINT_SEC = 0.55;
const TAU = Math.PI * 2;

export interface ArenaUltCastView {
  pid: PlayerId;
  kind: ArenaUltKind;
  x: number;
  y: number;
  aim: number;
  tell: number;
  t: number;
  accent: string;
  isLocal: boolean;
  isShattered: boolean;
  shatterT: number;
  seed: number;
}

interface ArenaUltCast extends ArenaUltCastView {
  isActive: boolean;
  isMomentFired: boolean;
}

interface ArenaHitPulse {
  x: number;
  y: number;
  t: number;
  isActive: boolean;
}

export type ArenaUltMoment = "salvo" | "triage" | "shoveShatter" | "slip" | "slipLanding";
export type ArenaUltMomentHandler = (cast: ArenaUltCastView, moment: ArenaUltMoment) => void;

function createCast(): ArenaUltCast {
  return {
    pid: "",
    kind: "salvo",
    x: 0,
    y: 0,
    aim: 0,
    tell: 0,
    t: 0,
    accent: "#ffffff",
    isLocal: false,
    isActive: false,
    isMomentFired: false,
    isShattered: false,
    shatterT: 0,
    seed: 0,
  };
}

function createHitPulse(): ArenaHitPulse {
  return { x: 0, y: 0, t: 0, isActive: false };
}

function hashCast(pid: PlayerId, kind: ArenaUltKind, x: number, y: number): number {
  let h = 2166136261;
  const key = `${pid}|${kind}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= Math.round(x * 8);
  h = Math.imul(h, 16777619);
  h ^= Math.round(y * 8);
  return h >>> 0;
}

function seededUnit(seed: number, index: number): number {
  let n = seed ^ Math.imul(index + 1, 0x9e3779b1);
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

function castEnd(cast: ArenaUltCast): number {
  switch (cast.kind) {
    case "salvo":
      return Math.max(ARENA_SALVO.glassSec, cast.tell + ARENA_SALVO.volleySec + SALVO_SCAR_SEC);
    case "triage":
      return cast.tell + ARENA_TRIAGE.cleanseSec;
    case "shove":
      return cast.isShattered
        ? cast.shatterT + SHOVE_GLINT_SEC
        : cast.tell + ARENA_SHOVE.wallLifeSec + SHOVE_GLINT_SEC;
    case "slip":
      return cast.tell + ARENA_SLIP.iframeSec + ARENA_SLIP.endlagSec;
  }
}

export class ArenaUltVfx {
  private readonly casts: ArenaUltCast[] = Array.from({ length: MAX_CASTS }, createCast);
  private readonly hitPulses: ArenaHitPulse[] = Array.from({ length: MAX_HIT_PULSES }, createHitPulse);
  private castCount = 0;
  private hitCursor = 0;

  private salvoTint: HTMLCanvasElement | null = null;
  private triageTint: HTMLCanvasElement | null = null;
  private shoveTint: HTMLCanvasElement | null = null;
  private slipTint: HTMLCanvasElement | null = null;

  clear(): void {
    this.castCount = 0;
    this.hitCursor = 0;
    for (const pulse of this.hitPulses) pulse.isActive = false;
  }

  activeCount(): number {
    return this.castCount;
  }

  activeTime(): number {
    return this.castCount === 0 ? -1 : this.casts[this.castCount - 1].t;
  }

  spawn(
    pid: PlayerId,
    kind: ArenaUltKind,
    x: number,
    y: number,
    aim: number,
    tell: number,
    accent: string,
    isLocal: boolean,
  ): void {
    let cast: ArenaUltCast;
    if (this.castCount < MAX_CASTS) {
      cast = this.casts[this.castCount++];
    } else {
      cast = this.casts[0];
      for (let i = 1; i < MAX_CASTS; i++) this.casts[i - 1] = this.casts[i];
      this.casts[MAX_CASTS - 1] = cast;
    }
    cast.pid = pid;
    cast.kind = kind;
    cast.x = x;
    cast.y = y;
    cast.aim = aim;
    cast.tell = tell;
    cast.t = 0;
    cast.accent = accent;
    cast.isLocal = isLocal;
    cast.isActive = true;
    cast.isMomentFired = false;
    cast.isShattered = false;
    cast.shatterT = 0;
    cast.seed = hashCast(pid, kind, x, y);
  }

  update(dt: number, onMoment: ArenaUltMomentHandler): void {
    let live = 0;
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      const previous = cast.t;
      cast.t += dt;
      if (!cast.isMomentFired && previous < cast.tell && cast.t >= cast.tell) {
        if (cast.kind === "shove") {
          cast.isMomentFired = true;
        } else {
          cast.isMomentFired = true;
          onMoment(cast, cast.kind);
        }
      }
      if (cast.kind === "shove" && !cast.isShattered
        && previous < cast.tell + ARENA_SHOVE.wallLifeSec
        && cast.t >= cast.tell + ARENA_SHOVE.wallLifeSec) {
        this.shatter(cast, onMoment);
      }
      if (cast.kind === "slip") {
        const landStart = cast.tell + ARENA_SLIP.iframeSec;
        if (previous < landStart && cast.t >= landStart) {
          onMoment(cast, "slipLanding");
        }
      }
      if (cast.t < castEnd(cast)) {
        const slot = this.casts[live];
        this.casts[live++] = cast;
        this.casts[i] = slot;
      } else {
        cast.isActive = false;
      }
    }
    this.castCount = live;

    for (const pulse of this.hitPulses) {
      if (!pulse.isActive) continue;
      pulse.t += dt;
      if (pulse.t >= SALVO_HIT_PULSE_SEC) pulse.isActive = false;
    }
  }

  syncLocalPosition(x: number, y: number): void {
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      if (cast.isLocal && cast.kind !== "slip") {
        cast.x = x;
        cast.y = y;
      }
    }
  }

  syncRemotePosition(pid: PlayerId, x: number, y: number): void {
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      if (!cast.isLocal && cast.pid === pid && cast.kind !== "slip") {
        cast.x = x;
        cast.y = y;
      }
    }
  }

  cutShove(
    x: number,
    y: number,
    isAtOwner: boolean,
    onMoment: ArenaUltMomentHandler,
  ): boolean {
    let closest: ArenaUltCast | null = null;
    let closestDistSq = 96 * 96;
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      if (cast.kind !== "shove" || cast.isShattered) continue;
      const dx = cast.x - x;
      const dy = cast.y - y;
      const distSq = dx * dx + dy * dy;
      if (isAtOwner) {
        if (distSq > 24 * 24) continue;
      } else {
        const distance = Math.sqrt(distSq);
        const angle = Math.atan2(y - cast.y, x - cast.x);
        const offset = Math.abs(Math.atan2(
          Math.sin(angle - cast.aim),
          Math.cos(angle - cast.aim),
        ));
        if (distance > ARENA_SHOVE.reachPx + 20 || offset > SHOVE_ARC / 2) continue;
      }
      if (distSq < closestDistSq) {
        closest = cast;
        closestDistSq = distSq;
      }
    }
    if (closest === null) return false;
    this.shatter(closest, onMoment);
    return true;
  }

  pulseSalvoHit(x: number, y: number): void {
    let isSalvoHit = false;
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      if (cast.kind !== "salvo" || cast.t < cast.tell
        || cast.t > cast.tell + ARENA_SALVO.volleySec) continue;
      const dx = x - cast.x;
      const dy = y - cast.y;
      const forward = dx * Math.cos(cast.aim) + dy * Math.sin(cast.aim);
      const side = Math.abs(dx * Math.sin(cast.aim) - dy * Math.cos(cast.aim));
      if (forward > 0 && forward <= ARENA_SALVO.rangePx && side <= 36) {
        isSalvoHit = true;
        break;
      }
    }
    if (!isSalvoHit) return;
    const pulse = this.hitPulses[this.hitCursor];
    this.hitCursor = (this.hitCursor + 1) % MAX_HIT_PULSES;
    pulse.x = x;
    pulse.y = y;
    pulse.t = 0;
    pulse.isActive = true;
  }

  bodyCue(pid: PlayerId, isLocal: boolean): ArenaUltCastView | null {
    for (let i = this.castCount - 1; i >= 0; i--) {
      const cast = this.casts[i];
      if (cast.isLocal === isLocal && (isLocal || cast.pid === pid)) return cast;
    }
    return null;
  }

  bodyFlash(cast: ArenaUltCastView): number {
    switch (cast.kind) {
      case "salvo":
        if (cast.t >= ARENA_SALVO.glassSec) return 0;
        return 0.35 + 0.22 * (0.5 + 0.5 * Math.sin(cast.t * 24));
      case "triage": {
        if (cast.t < cast.tell) return 0;
        const k = (cast.t - cast.tell) / 0.36;
        return k < 1 ? 0.65 * (1 - k) : 0;
      }
      case "shove":
        return 0;
      case "slip": {
        if (cast.t < cast.tell) return 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(cast.t * 34));
        const landStart = cast.tell + ARENA_SLIP.iframeSec;
        if (cast.t < landStart) return 0;
        const k = (cast.t - landStart) / ARENA_SLIP.endlagSec;
        return k < 1 ? 0.95 - k * 0.25 : 0;
      }
    }
  }

  isSlipTelling(cast: ArenaUltCastView): boolean {
    return cast.kind === "slip" && cast.t < cast.tell;
  }

  isSlipLanding(cast: ArenaUltCastView): boolean {
    const landStart = cast.tell + ARENA_SLIP.iframeSec;
    return cast.kind === "slip" && cast.t >= landStart
      && cast.t < landStart + ARENA_SLIP.endlagSec;
  }

  renderGround(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    sprites: Sprites,
  ): void {
    this.cacheTints(sprites);
    ctx.save();
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      const x = cast.x - camX;
      const y = cast.y - camY;
      switch (cast.kind) {
        case "salvo":
          this.renderSalvoScar(ctx, cast, x, y);
          break;
        case "triage":
          this.renderTriageGround(ctx, cast, x, y);
          break;
        case "shove":
          this.renderShoveGround(ctx, cast, x, y);
          break;
        case "slip":
          this.renderSlipGround(ctx, cast, x, y);
          break;
      }
    }
    ctx.restore();
  }

  renderWorld(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    sprites: Sprites,
    isReducedMotion: boolean,
  ): void {
    this.cacheTints(sprites);
    ctx.save();
    for (let i = 0; i < this.castCount; i++) {
      const cast = this.casts[i];
      const x = cast.x - camX;
      const y = cast.y - camY;
      switch (cast.kind) {
        case "salvo":
          this.renderSalvoWorld(ctx, cast, x, y);
          break;
        case "triage":
          this.renderTriageWorld(ctx, cast, x, y);
          break;
        case "shove":
          this.renderShoveWorld(ctx, cast, x, y);
          break;
        case "slip":
          this.renderSlipWorld(ctx, cast, x, y, isReducedMotion);
          break;
      }
    }
    for (const pulse of this.hitPulses) {
      if (!pulse.isActive) continue;
      const k = pulse.t / SALVO_HIT_PULSE_SEC;
      const x = pulse.x - camX;
      const y = pulse.y - camY;
      const r = 7 + k * 13;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = ARENA_ULT_CORE.salvo;
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      ctx.stroke();
    }
    ctx.restore();
  }

  private shatter(cast: ArenaUltCast, onMoment: ArenaUltMomentHandler): void {
    if (cast.isShattered) return;
    cast.isShattered = true;
    cast.shatterT = cast.t;
    onMoment(cast, "shoveShatter");
  }

  private cacheTints(sprites: Sprites): void {
    this.salvoTint ??= sprites.fxTinted("trail_streak", ARENA_ULT_HUE.salvo);
    this.triageTint ??= sprites.fxTinted("shock_ring", ARENA_ULT_HUE.triage);
    this.shoveTint ??= sprites.fxTinted("spark", ARENA_ULT_HUE.shove);
    this.slipTint ??= sprites.fxTinted("glow_round", ARENA_ULT_HUE.slip);
  }

  private renderSalvoScar(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    const start = cast.tell + ARENA_SALVO.volleySec;
    const k = (cast.t - start) / SALVO_SCAR_SEC;
    if (k < 0 || k >= 1) return;
    ctx.globalAlpha = (1 - k) * 0.45;
    ctx.strokeStyle = ARENA_ULT_HUE.salvo;
    ctx.lineWidth = 10 - k * 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(
      x + Math.cos(cast.aim) * ARENA_SALVO.rangePx,
      y + Math.sin(cast.aim) * ARENA_SALVO.rangePx,
    );
    ctx.stroke();
  }

  private renderTriageGround(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    if (cast.t >= cast.tell) return;
    const k = smoothstep(cast.t / cast.tell);
    const radius = 92 - k * 68;
    ctx.globalAlpha = 0.45 + k * 0.45;
    ctx.strokeStyle = ARENA_ULT_HUE.triage;
    ctx.lineWidth = 3 + k * 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.stroke();
  }

  private renderShoveGround(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    const start = cast.aim - SHOVE_ARC / 2;
    const end = cast.aim + SHOVE_ARC / 2;
    if (!cast.isShattered) {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#111b28";
      ctx.lineWidth = cast.t < cast.tell ? 5 : 18;
      ctx.beginPath();
      ctx.arc(x, y + 5, ARENA_SHOVE.reachPx, start, end);
      ctx.stroke();
      return;
    }
    const k = (cast.t - cast.shatterT) / SHOVE_GLINT_SEC;
    if (k < 0 || k >= 1) return;
    ctx.strokeStyle = ARENA_ULT_CORE.shove;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = (1 - k) * 0.7;
    for (let i = 0; i < 6; i++) {
      const a = start + SHOVE_ARC * seededUnit(cast.seed, i);
      const d = 22 + 34 * seededUnit(cast.seed, i + 8);
      const gx = x + Math.cos(a) * d;
      const gy = y + Math.sin(a) * d;
      const s = 3 + 4 * seededUnit(cast.seed, i + 16);
      ctx.beginPath();
      ctx.moveTo(gx - s, gy);
      ctx.lineTo(gx + s, gy);
      ctx.stroke();
    }
  }

  private renderSlipGround(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    if (cast.t < cast.tell) return;
    const dx = Math.cos(cast.aim) * ARENA_SLIP.blinkPx;
    const dy = Math.sin(cast.aim) * ARENA_SLIP.blinkPx;
    const landStart = cast.tell + ARENA_SLIP.iframeSec;
    const isLanding = cast.t >= landStart;
    ctx.globalAlpha = isLanding ? 0.68 : 0.22;
    ctx.strokeStyle = isLanding ? ARENA_ULT_CORE.slip : ARENA_ULT_HUE.slip;
    ctx.lineWidth = isLanding ? 4 : 2;
    ctx.beginPath();
    ctx.ellipse(x + dx, y + dy + 16, isLanding ? 28 : 20, isLanding ? 10 : 7, 0, 0, TAU);
    ctx.stroke();
  }

  private renderSalvoWorld(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    const cos = Math.cos(cast.aim);
    const sin = Math.sin(cast.aim);
    if (cast.t < cast.tell) {
      const k = smoothstep(cast.t / cast.tell);
      const spread = (1 - k) * 0.22;
      for (let i = -1; i <= 1; i++) {
        const angle = cast.aim + spread * i;
        ctx.globalAlpha = i === 0 ? 0.8 : 0.35 + k * 0.25;
        ctx.strokeStyle = i === 0 ? ARENA_ULT_CORE.salvo : ARENA_ULT_HUE.salvo;
        ctx.lineWidth = i === 0 ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 18, y + Math.sin(angle) * 18);
        ctx.lineTo(
          x + Math.cos(angle) * ARENA_SALVO.rangePx,
          y + Math.sin(angle) * ARENA_SALVO.rangePx,
        );
        ctx.stroke();
      }
      const charge = 18 + k * 28;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.25 + k * 0.55;
      ctx.fillStyle = ARENA_SALVO_GLOW;
      ctx.beginPath();
      ctx.arc(x + cos * 20, y + sin * 20, charge, 0, TAU);
      ctx.fill();
      return;
    }

    const elapsed = cast.t - cast.tell;
    if (elapsed > ARENA_SALVO.volleySec) return;
    ctx.globalCompositeOperation = "lighter";
    const bloom = Math.max(0, 1 - elapsed / 0.32);
    ctx.globalAlpha = bloom * 0.8;
    ctx.fillStyle = ARENA_ULT_CORE.salvo;
    ctx.beginPath();
    ctx.arc(x + cos * 20, y + sin * 20, 12 + bloom * 24, 0, TAU);
    ctx.fill();
    if (this.salvoTint !== null && bloom > 0) {
      ctx.globalAlpha = bloom * 0.6;
      ctx.save();
      ctx.translate(x + cos * 20, y + sin * 20);
      ctx.rotate(cast.aim);
      ctx.drawImage(this.salvoTint, -36, -12, 72, 24);
      ctx.restore();
    }
  }

  private renderTriageWorld(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    if (cast.t < cast.tell) return;
    const elapsed = cast.t - cast.tell;
    const k = elapsed / ARENA_TRIAGE.cleanseSec;
    if (k >= 1) return;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8 + seededUnit(cast.seed, i) * 0.28;
      const d = 14 + k * (34 + seededUnit(cast.seed, i + 8) * 28);
      const drop = k * k * 18;
      const sx = x + Math.cos(a) * d;
      const sy = y + Math.sin(a) * d + drop;
      const size = 3 + seededUnit(cast.seed, i + 16) * 3;
      ctx.globalAlpha = (1 - k) * 0.75;
      ctx.fillStyle = i % 3 === 0 ? ARENA_ULT_CORE.triage : ARENA_ULT_HUE.triage;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(a + k * 2);
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }
    if (this.triageTint !== null && elapsed < 0.28) {
      const pulse = elapsed / 0.28;
      const size = 44 + pulse * 124;
      ctx.globalAlpha = (1 - pulse) * 0.65;
      ctx.drawImage(this.triageTint, x - size / 2, y - size / 2, size, size);
    }
  }

  private renderShoveWorld(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
  ): void {
    const start = cast.aim - SHOVE_ARC / 2;
    const end = cast.aim + SHOVE_ARC / 2;
    if (!cast.isShattered) {
      const edgeFlash = Math.max(0, 1 - cast.t / 0.13);
      if (cast.t < cast.tell) {
        const k = smoothstep(cast.t / cast.tell);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.45 + 0.5 * edgeFlash;
        ctx.strokeStyle = ARENA_ULT_CORE.shove;
        ctx.lineWidth = 2 + edgeFlash * 5;
        ctx.beginPath();
        ctx.arc(x, y - 3, ARENA_SHOVE.reachPx, start, end);
        ctx.stroke();
        ctx.globalAlpha = 0.28 + k * 0.35;
        ctx.strokeStyle = ARENA_ULT_HUE.shove;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, ARENA_SHOVE.reachPx, start, end);
        ctx.stroke();
        return;
      }
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = "#101927";
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.arc(x, y, ARENA_SHOVE.reachPx, start, end);
      ctx.stroke();
      ctx.globalAlpha = 0.72 + edgeFlash * 0.25;
      ctx.strokeStyle = ARENA_ULT_HUE.shove;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(x, y - 2, ARENA_SHOVE.reachPx, start, end);
      ctx.stroke();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.82 + edgeFlash * 0.18;
      ctx.strokeStyle = ARENA_ULT_CORE.shove;
      ctx.lineWidth = 3 + edgeFlash * 4;
      ctx.beginPath();
      ctx.arc(x, y - 5, ARENA_SHOVE.reachPx + 1, start, end);
      ctx.stroke();
      return;
    }

    const k = (cast.t - cast.shatterT) / SHOVE_GLINT_SEC;
    if (k < 0 || k >= 1) return;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 8; i++) {
      const a = start + SHOVE_ARC * seededUnit(cast.seed, i);
      const speed = 55 + seededUnit(cast.seed, i + 8) * 95;
      const d = ARENA_SHOVE.reachPx + speed * k;
      const sx = x + Math.cos(a) * d;
      const sy = y + Math.sin(a) * d + k * k * 26;
      const size = 5 + seededUnit(cast.seed, i + 16) * 8;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.fillStyle = i % 3 === 0 ? ARENA_ULT_CORE.shove : ARENA_ULT_HUE.shove;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(a + k * (3 + seededUnit(cast.seed, i + 24) * 5));
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.55, size * 0.28);
      ctx.lineTo(-size * 0.35, -size * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private renderSlipWorld(
    ctx: CanvasRenderingContext2D,
    cast: ArenaUltCast,
    x: number,
    y: number,
    isReducedMotion: boolean,
  ): void {
    if (cast.t < cast.tell) {
      const k = cast.t / cast.tell;
      const flicker = isReducedMotion ? 0.55 : 0.3 + 0.7 * Math.abs(Math.sin(cast.t * 30));
      const tension = 18 + smoothstep(k) * 18;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = flicker * 0.42;
      ctx.fillStyle = ARENA_ULT_HUE.slip;
      ctx.beginPath();
      ctx.ellipse(x, y + 10, tension, 9 - k * 3, 0, 0, TAU);
      ctx.fill();
      return;
    }
    const elapsed = cast.t - cast.tell;
    if (elapsed > 0.22) return;
    const k = elapsed / 0.22;
    const dx = Math.cos(cast.aim) * ARENA_SLIP.blinkPx;
    const dy = Math.sin(cast.aim) * ARENA_SLIP.blinkPx;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = (1 - k) * 0.55;
    ctx.strokeStyle = ARENA_ULT_HUE.slip;
    ctx.lineWidth = 10 * (1 - k) + 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
    if (this.slipTint !== null) {
      const size = 70 + k * 42;
      ctx.globalAlpha = (1 - k) * 0.58;
      ctx.drawImage(this.slipTint, x + dx - size / 2, y + dy - size / 2, size, size);
    }
  }
}
