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
// ASSET HOOKS: the art pipeline (FAL) generates into
// public/sprites/cosmetics/<key>_<orientation>.png. Every shipped hat/face is a generated
// sprite anchored on its socket — there is NO procedural cosmetic art. The renderer uses an
// asset once its file has loaded, and draws nothing while it streams in / on failure (never
// a fabricated placeholder). `cowboy_hat_classic` is now a normal equippable hat layer: it
// draws over the bald hero base (LAYERED_HERO_BASE_SRC) exactly like every other hat, so
// the classic cowboy look is a pick a player equips rather than baked into the body.

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
    head: still(32, 14),  // retuned: new base crown tops y22 (was tuned for old y11 crown)
    face: still(32, 32),
    back: still(32, 30, true, true),
  },
  // Facing away: the face layer is invisible (back of the head); a back layer draws in
  // front of the body sprite.
  up: {
    head: still(32, 12),  // retuned for new base crown y22
    face: still(32, 32, false),
    back: still(32, 30, true, false),
  },
  // Side (authored RIGHT; the renderer's facing flip mirrors left): hat shifts toward the
  // face, the eye line sits forward of center.
  side: {
    head: still(33, 13),  // retuned for new base crown y22 (side is what the hero renders)
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
  // Per-hat fine-tune offset in frame-space px, added to the socket anchor. Each hat sits
  // slightly differently on the round head (a tall toque rides higher, a low headphone band
  // sits lower), so this is the per-item nudge on top of the shared head socket. Defaults to
  // 0,0 when omitted. +y = lower on the head, +x = toward the facing side.
  offsetX?: number;
  offsetY?: number;
  src: Record<CosmeticOrientation, string>;
}

function orientedSources(key: string): Record<CosmeticOrientation, string> {
  return {
    down: `/sprites/cosmetics/${key}_down.png`,
    up: `/sprites/cosmetics/${key}_up.png`,
    side: `/sprites/cosmetics/${key}_side.png`,
  };
}

// The pipeline's generation targets — the AD-approved Wave 1 set. Hats socket to the head
// at the head size (~48px, like the classic cowboy hat); faces socket to the face at the
// face size (~32px, like the round specs). cowboy_hat_classic is a normal head layer that
// rides the bald base like every other hat.
export const COSMETIC_ASSET_SOURCES: Record<string, CosmeticAssetDef> = {
  cowboy_hat_classic: { socket: "head", sizePx: 48, src: orientedSources("cowboy_hat_classic") },
  // hats
  hat_top: { socket: "head", sizePx: 48, src: orientedSources("hat_top") },
  hat_beanie: { socket: "head", sizePx: 48, offsetY: -4, src: orientedSources("hat_beanie") },
  hat_chef: { socket: "head", sizePx: 50, offsetY: -7, src: orientedSources("hat_chef") },
  hat_party: { socket: "head", sizePx: 46, offsetY: -5, src: orientedSources("hat_party") },
  hat_flower: { socket: "head", sizePx: 46, offsetY: 2, src: orientedSources("hat_flower") },
  hat_mushroom: { socket: "head", sizePx: 46, offsetY: -2, src: orientedSources("hat_mushroom") },
  hat_crown: { socket: "head", sizePx: 48, offsetY: 2, src: orientedSources("hat_crown") },
  hat_wizard: { socket: "head", sizePx: 48, src: orientedSources("hat_wizard") },
  hat_halo: { socket: "head", sizePx: 44, offsetY: 7, src: orientedSources("hat_halo") },
  hat_headphones: { socket: "head", sizePx: 68, offsetY: 11, src: orientedSources("hat_headphones") },
  hat_helmet: { socket: "head", sizePx: 48, src: orientedSources("hat_helmet") },
  hat_horns: { socket: "head", sizePx: 48, offsetY: -6, src: orientedSources("hat_horns") },
  // hats, pack #2 (assetKey == file stem == catalog id). Sizes/offsets are start points the AD
  // can tune per line; a tall/perched piece rides higher (-y), a low band sits lower (+y).
  hat_beret: { socket: "head", sizePx: 46, offsetY: -3, src: orientedSources("hat_beret") },
  hat_bow: { socket: "head", sizePx: 42, offsetY: 1, src: orientedSources("hat_bow") },
  hat_bandana: { socket: "head", sizePx: 46, offsetY: 3, src: orientedSources("hat_bandana") },
  hat_propeller: { socket: "head", sizePx: 48, offsetY: -6, src: orientedSources("hat_propeller") },
  hat_viking: { socket: "head", sizePx: 52, offsetY: -3, src: orientedSources("hat_viking") },
  hat_leaf: { socket: "head", sizePx: 46, offsetY: -4, src: orientedSources("hat_leaf") },
  hat_hardhat: { socket: "head", sizePx: 48, offsetY: -2, src: orientedSources("hat_hardhat") },
  hat_space: { socket: "head", sizePx: 54, offsetY: 2, src: orientedSources("hat_space") },
  // faces
  round_glasses: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -4, src: orientedSources("round_glasses") },
  face_shades: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -3, src: orientedSources("face_shades") },
  face_eyepatch: { socket: "face", sizePx: 40, offsetX: -13, offsetY: -2, src: orientedSources("face_eyepatch") },
  face_star_shades: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -4, src: orientedSources("face_star_shades") },
  face_3d_glasses: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -4, src: orientedSources("face_3d_glasses") },
  face_monocle: { socket: "face", sizePx: 24, offsetX: -14, offsetY: -4, src: orientedSources("face_monocle") },
  // faces, pack #2 (assetKey == file stem == catalog id).
  face_goggles: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -4, src: orientedSources("face_goggles") },
  face_heart_shades: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -4, src: orientedSources("face_heart_shades") },
  face_visor: { socket: "face", sizePx: 40, offsetX: -3, offsetY: -5, src: orientedSources("face_visor") },
  face_bandage: { socket: "face", sizePx: 36, offsetX: -3, offsetY: -2, src: orientedSources("face_bandage") },
  face_snorkel: { socket: "face", sizePx: 40, offsetX: -3, offsetY: 2, src: orientedSources("face_snorkel") },
};

// The layered-hero base (the canonical hero body WITHOUT the baked-in cowboy hat) and its
// walk sheet, registered in assets.ts as the "hero_bald" sprite + "hero_bald.walk" sheet.
// The renderer selects it under any equipped hat (see heroBodySprite) so the worn hat is a
// separate layer over a fixed body rather than a second hat stacked on the baked one.
//
// THE ART HERE IS A PROVISIONAL PLACEHOLDER — the art director will finalize the bald body
// later. These two paths are the single swap point: dropping the AD's approved PNGs at
// exactly these paths is a ZERO-code change. The renderer never reads the art's pixels,
// dimensions, or frame count (drawChar infers frames from the sheet at draw time and tints
// through the generic path), and no test asserts anything about its specific look — only
// that these registered paths and the walk cadence are wired. Keep the head-anchor sockets
// above (tuned to the hero's 64px head geometry, not to this placeholder's pixels) as the
// durable contract the final art must respect.
export const LAYERED_HERO_BASE_SRC = "/sprites/cosmetics/hero_base_bald.png";
export const LAYERED_HERO_BASE_WALK_SRC = "/sprites/cosmetics/hero_base_bald_walk.png";
