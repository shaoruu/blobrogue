// The cosmetic LAYER contract (integration of fal-art/COSMETIC_LAYER_SPEC.md — the art
// director's spec lives on the art environment; this module is the code side of it):
//
//   - DETERMINISTIC SOCKETS: every overlay attaches to a named socket (head / face / back)
//     whose position is a pure function of (socket, orientation, frameIndex) — same inputs,
//     same anchor, on every client. Coordinates live in the hero's 64px frame space
//     (measured off the shipped sprite: hat brim line ~y16, eye line ~y32, center x32).
//   - THREE ORIENTATIONS: down / up / side, side authored FACING RIGHT and mirrored for
//     left by the renderer's existing facing flip (the same convention as ART.md's
//     directional mob sheets). The hero currently renders side-only (mirror); the up/down
//     entries are the gated data waiting for directional hero sheets.
//   - CAPPED TRANSFORMS: cosmetics ride the body's bob/lean/squash only up to hard caps,
//     so a hat can never stretch into a readability problem or exaggerate the silhouette.
//   - LAYER ORDER: cosmetics draw ABOVE the body but BELOW weapon, muzzle, status, and
//     name/team cues (locked by the render-order test) — gameplay reads always win.
//   - SAFE FALLBACK: unknown/absent ids or missing art render NOTHING, never a placeholder.
//
// ASSET HOOKS (first integration pair ONLY — no fabricated art here): the art pipeline
// (main agent, FAL) generates into public/sprites/cosmetics/<key>_<orientation>.png. The
// renderer uses an asset when its file exists and has loaded; otherwise it falls back to
// the item's procedural painter (if it has one), else draws nothing. `cowboy_hat_classic`
// deliberately has NO procedural fallback: until its generated art (and the layered bald
// base, see LAYERED_HERO_BASE_SRC) ship, the classic hat stays the baked-in sprite look.

export type CosmeticOrientation = "down" | "up" | "side";
export type SocketKind = "head" | "face" | "back";

export const COSMETIC_ORIENTATIONS: readonly CosmeticOrientation[] = ["down", "up", "side"];
export const SOCKET_KINDS: readonly SocketKind[] = ["head", "face", "back"];

// One socket sample: the anchor point in 64px frame space, whether the layer is visible at
// all for this orientation (a face layer has no business on the back of a head), and
// whether it draws BEHIND the body (a cape seen from the front).
export interface SocketPoint {
  x: number;
  y: number;
  isVisible: boolean;
  isBehindBody: boolean;
}

// Per-frame socket tables. Four entries per orientation — the walk sheet's frame budget
// (ART.md) — so per-frame anchor tuning lands as data when the directional sheets ship;
// the static/idle pose reads frame 0. Frame indexes clamp by modulo: deterministic for any
// input, never out of range.
type FrameTable = readonly [SocketPoint, SocketPoint, SocketPoint, SocketPoint];

function still(x: number, y: number, isVisible = true, isBehindBody = false): FrameTable {
  const p: SocketPoint = { x, y, isVisible, isBehindBody };
  return [p, p, p, p];
}

const SOCKETS: Record<CosmeticOrientation, Record<SocketKind, FrameTable>> = {
  // Facing the camera: hat crowns the head, face sits on the eye line, a back layer hides
  // behind the body.
  down: {
    head: still(32, 16),
    face: still(32, 32),
    back: still(32, 30, true, true),
  },
  // Facing away: the face layer is invisible (back of the head); a back layer draws in
  // front of the body sprite.
  up: {
    head: still(32, 14),
    face: still(32, 32, false),
    back: still(32, 30, true, false),
  },
  // Side (authored RIGHT; the renderer's facing flip mirrors left): hat shifts toward the
  // face, the eye line sits forward of center.
  side: {
    head: still(33, 15),
    face: still(36, 32),
    back: still(26, 30, true, true),
  },
};

// The deterministic socket lookup. frameIndex accepts ANY integer (negative, oversized —
// remote interpolation clocks are messy) and clamps by modulo.
export function socketFor(kind: SocketKind, orientation: CosmeticOrientation, frameIndex: number): SocketPoint {
  const table = SOCKETS[orientation][kind];
  const i = ((Math.trunc(frameIndex) % table.length) + table.length) % table.length;
  return table[i];
}

// ---- capped transforms -----------------------------------------------------------------
// Cosmetics inherit the body's procedural deform only up to these caps. The body itself
// squashes ~6.5% at full stride (anim.ts CHARACTER_STYLE) — cosmetics follow at most this
// far and rotate/bob strictly less, keeping hats readable through every animation.

export const COSMETIC_SCALE_CAP = 0.06; // |1 - s| max for sx/sy
export const COSMETIC_ROT_CAP = 0.06;   // radians
export const COSMETIC_BOB_CAP = 2.5;    // px of vertical follow

export interface CosmeticXform { ox: number; oy: number; sx: number; sy: number; rot: number }

const cappedScratch: CosmeticXform = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Cap a body transform for the cosmetic pass. Returns a shared scratch (render hot path —
// consume before the next call, exactly like anim.ts characterXform).
export function capCosmeticXform(xf: CosmeticXform): CosmeticXform {
  cappedScratch.ox = xf.ox;
  cappedScratch.oy = clamp(xf.oy, -COSMETIC_BOB_CAP, COSMETIC_BOB_CAP);
  cappedScratch.sx = clamp(xf.sx, 1 - COSMETIC_SCALE_CAP, 1 + COSMETIC_SCALE_CAP);
  cappedScratch.sy = clamp(xf.sy, 1 - COSMETIC_SCALE_CAP, 1 + COSMETIC_SCALE_CAP);
  cappedScratch.rot = clamp(xf.rot, -COSMETIC_ROT_CAP, COSMETIC_ROT_CAP);
  return cappedScratch;
}

// ---- asset hooks (first integration pair only) -------------------------------------------

export interface CosmeticAssetDef {
  socket: SocketKind;
  // Drawn size in frame-space px (the asset is authored square at this size, centered on
  // its socket).
  sizePx: number;
  src: Record<CosmeticOrientation, string>;
}

function orientedSources(key: string): Record<CosmeticOrientation, string> {
  return {
    down: `/sprites/cosmetics/${key}_down.png`,
    up: `/sprites/cosmetics/${key}_up.png`,
    side: `/sprites/cosmetics/${key}_side.png`,
  };
}

// The pipeline's generation targets. EXACTLY the gated first pair — broader content waits
// until these two pass the socket gate across facings/animations/biomes/weapons.
export const COSMETIC_ASSET_SOURCES: Record<string, CosmeticAssetDef> = {
  cowboy_hat_classic: { socket: "head", sizePx: 48, src: orientedSources("cowboy_hat_classic") },
  round_glasses: { socket: "face", sizePx: 32, src: orientedSources("round_glasses") },
};

// The layered-hero base (the hero WITHOUT the baked-in cowboy hat) — the second half of
// making cowboy_hat_classic a real layer. Until both files ship, the classic look stays
// the baked sprite and the layer system leaves it alone.
export const LAYERED_HERO_BASE_SRC = "/sprites/cosmetics/hero_base_bald.png";
