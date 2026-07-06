// Lightweight procedural "juice" layer. Every character/pickup carries an Anim that
// advances a phase clock and eases a few state values; the draw path turns that into
// a squash/stretch/bob/lean transform. No per-frame allocations: stepAnim avoids
// closures and characterXform writes into a shared scratch object.

export interface Anim {
  clock: number;  // ever-advancing phase (faster while moving), seconds-ish
  move: number;   // eased 0..1 "is moving"
  lean: number;   // eased -1..1 horizontal lean toward motion/aim
  recoil: number; // decays after a shot/attack (scale punch)
  flash: number;  // decays after a hit (white pop)
}

export function createAnim(): Anim {
  // Random phase so a room full of blobs doesn't bob in lockstep.
  return { clock: Math.random() * 10, move: 0, lean: 0, recoil: 0, flash: 0 };
}

export function resetAnim(a: Anim): void {
  a.clock = Math.random() * 10;
  a.move = 0; a.lean = 0; a.recoil = 0; a.flash = 0;
}

export function stepAnim(a: Anim, dt: number, isMoving: boolean, leanTarget: number): void {
  a.move += ((isMoving ? 1 : 0) - a.move) * Math.min(1, dt * 9);
  const clamped = leanTarget < -1 ? -1 : leanTarget > 1 ? 1 : leanTarget;
  a.lean += (clamped - a.lean) * Math.min(1, dt * 8);
  a.clock += dt * (1 + a.move * 1.5);
  a.recoil -= dt * 6.5; if (a.recoil < 0) a.recoil = 0;
  a.flash -= dt * 7; if (a.flash < 0) a.flash = 0;
}

export function triggerRecoil(a: Anim): void { a.recoil = 1; }
export function triggerFlash(a: Anim): void { a.flash = 1; }

export interface XformStyle {
  freq: number;   // idle bob / breathe cycles per second
  bob: number;    // idle bob amplitude (px)
  squash: number; // squash-and-stretch amplitude
  hop: number;    // extra upward hop while moving (px)
  lean: number;   // max lean (radians)
}

export const CHARACTER_STYLE: XformStyle = { freq: 3.4, bob: 1.7, squash: 0.065, hop: 3.4, lean: 0.14 };
export const BOSS_STYLE: XformStyle = { freq: 1.4, bob: 1.3, squash: 0.05, hop: 1.2, lean: 0.05 };

export interface Xform { ox: number; oy: number; sx: number; sy: number; rot: number; }

// Shared scratch — safe because callers read it immediately after each call.
const scratch: Xform = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

export const IDENTITY_XFORM: Xform = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

export function characterXform(a: Anim, style: XformStyle): Xform {
  const idle = Math.sin(a.clock * style.freq);
  const sq = style.squash * (0.7 + a.move);
  let sx = 1 - sq * idle;
  let sy = 1 + sq * idle;
  const hop = a.move * style.hop * Math.abs(Math.sin(a.clock * style.freq));
  const oy = -style.bob * idle * (0.6 + a.move * 0.7) - hop;
  // Recoil: ease-out squash punch (wider + shorter for a beat).
  const punch = a.recoil * a.recoil;
  sx += punch * 0.16;
  sy -= punch * 0.2;
  scratch.ox = 0;
  scratch.oy = oy;
  scratch.sx = sx;
  scratch.sy = sy;
  scratch.rot = a.lean * style.lean + a.move * Math.sin(a.clock * style.freq) * 0.02;
  return scratch;
}

// Current frame for a horizontal strip spritesheet (N square frames).
export function frameIndex(frameCount: number, fps: number, clock: number): number {
  if (frameCount <= 1) return 0;
  return Math.floor(clock * fps) % frameCount;
}
