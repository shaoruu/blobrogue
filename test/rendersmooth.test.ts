// Render-smoothing suite: locks the fix for Ian's "props/crates/barrels jitter and swim
// against the player while the camera moves" playtest bug.
//
// Root cause being guarded: the local player is drawn interpolated between the last two
// FIXED sim steps (renderAlpha advances every display frame), but the camera used to be
// eased only inside the fixed 60Hz sim step. Every world-space draw subtracts the camera,
// so on any display not phase-locked to the sim (144Hz, 120Hz, or 60Hz with pacing jitter)
// static props held still for the frames between sim steps and then jumped a whole camera
// step, while the player glided — mixed time bases, visible as prop shimmer/swim. The fix
// samples ONE render-clock camera per frame (cam interpolated between its last two sim
// steps by the same renderAlpha) and every world-space layer subtracts that single
// fractional value with no per-layer re-rounding.
//
// This suite boots the REAL Game headlessly, replays the exact fixed-timestep accumulator
// schedule loop() runs at a 144Hz refresh, records the actual canvas draw calls, and
// asserts on the true drawn positions:
//   1. a static prop's screen position advances smoothly EVERY frame during a pan
//      (no stall-then-jump staircase — the bug's signature),
//   2. the prop stays rigidly locked to the interpolated player (shared camera transform,
//      no layer re-snaps or rounds on its own),
//   3. the tile pass subtracts the exact same fractional camera as the prop pass,
//   4. crossing a sim-step boundary is positionally continuous (no per-step pop),
//   5. the player's on-screen position holds steady while the camera tracks a straight
//      run (the old sim-rate camera sawtoothed it), and
//   6. a camera snap (floor load) clears the interpolation history — no one-frame slide.
//
// Run: npm run test:rendersmooth

import "./harness/domShim.js";
import { domMinimap, domOverlay } from "./harness/domShim.js";
import { installFxCapture } from "./harness/fxCapture.js";
import { Game } from "../src/game/game.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { devSpawnProp } from "../src/sim/world.js";
import { TILE } from "../src/sim/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = () => {};
installFxCapture();
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

// ---- recording canvas ------------------------------------------------------------------
// The Game draws into a real ctx interface; this one records the two calls the streaming-
// asset fallbacks use (fillRect boxes, arc discs) so drawn screen positions can be read
// back exactly. Everything else no-ops like the golden harness's ctx stub.

interface RectCall { x: number; y: number; w: number; h: number }
interface ArcCall { x: number; y: number; r: number }
const frameLog = { fillRects: [] as RectCall[], arcs: [] as ArcCall[] };
function resetLog(): void {
  frameLog.fillRects.length = 0;
  frameLog.arcs.length = 0;
}

const gradientStub = { addColorStop: noop };
const recordingCtx: any = new Proxy({}, {
  get(_t, p) {
    if (p === "fillRect") return (x: number, y: number, w: number, h: number) => { frameLog.fillRects.push({ x, y, w, h }); };
    if (p === "arc") return (x: number, y: number, r: number) => { frameLog.arcs.push({ x, y, r }); };
    if (p === "createLinearGradient" || p === "createRadialGradient" || p === "createPattern") return () => gradientStub;
    if (p === "measureText") return () => ({ width: 0 });
    if (p === "canvas") return null;
    return noop;
  },
  set() { return true; },
});

const recCanvas: any = {
  width: 1280,
  height: 720,
  style: {},
  getContext: () => recordingCtx,
  addEventListener: noop,
  removeEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }),
};

// ---- draw-call markers -----------------------------------------------------------------
// With no sprite PNGs loaded, drawPropImage falls back to a fillRect of EXACTLY this size
// centered on the prop's screen position, and drawChar falls back to an arc of EXACTLY
// this radius at the player's screen position. Both fallbacks apply no anim transform on
// x, so the recovered coordinates are the pure world-minus-camera values under test.
const PROP_FALLBACK_W = 48 * 0.55;        // drawPropImage: size * 0.55 with PROP_DRAW = 48
const PROP_FALLBACK_INSET = 24 * 0.55;    // drawPropImage: half * 0.55
const PLAYER_FALLBACK_R = 52 * 0.34;      // drawChar: size * 0.34 with the hero's 52px draw

function readPropSx(): number {
  const hits = frameLog.fillRects.filter((r) => r.w === PROP_FALLBACK_W && r.h === PROP_FALLBACK_W);
  if (hits.length !== 1) throw new Error(`expected exactly 1 prop fallback box, saw ${hits.length}`);
  return hits[0].x + PROP_FALLBACK_INSET;
}
function readPlayerSx(): number {
  const hits = frameLog.arcs.filter((a) => a.r === PLAYER_FALLBACK_R);
  if (hits.length !== 1) throw new Error(`expected exactly 1 player fallback disc, saw ${hits.length}`);
  return hits[0].x;
}

// ---- boot the real game into the deterministic sandbox arena ----------------------------

const FIXED_DT = 1 / 60;   // the loop()'s sim step
const FRAME_DT = 1 / 144;  // a 144Hz display: 2-3 render frames per sim step

const game: any = new Game(recCanvas, domMinimap as any, domOverlay as any, noop, noop);
game.isSandbox = true;
game.start({ mode: "solo", coop: null, profile: null });
game.transport.start(0x5eed, 1, { isSandbox: true, isCoop: false });
game.world = game.transport.poll().state;
game.seed = 0x5eed;
game.inputSeq = 0;
game.loadFloorClient();
game.snapCameraTo(game.px - recCanvas.width / 2, game.py - recCanvas.height / 2);

const prop = devSpawnProp(game.world, "crate", game.px + 180, game.py - 120);

// Hold "d": the player runs right at full speed, so the eased camera pans right.
game.input.keys.add("d");

// Warm up on whole sim steps until the camera-follow ease has fully converged on the
// straight-line run (geometric convergence; 150 steps is far past float precision).
for (let i = 0; i < 150; i++) game.tick(FIXED_DT);

function renderAt(alpha: number): void {
  game.renderAlpha = alpha;
  resetLog();
  game.render();
}

// ---- 1+2+5: the 144Hz pan sweep ----------------------------------------------------------
// Replay loop()'s accumulator schedule exactly: fractional camera offsets every frame,
// sim steps landing on every 2nd-3rd frame.
{
  interface FrameSample { propSx: number; playerSx: number; relErr: number }
  const frames: FrameSample[] = [];
  let acc = 0;
  for (let f = 0; f < 40; f++) {
    acc += FRAME_DT;
    while (acc >= FIXED_DT) { game.tick(FIXED_DT); acc -= FIXED_DT; }
    renderAt(acc / FIXED_DT);
    const propSx = readPropSx();
    const playerSx = readPlayerSx();
    // The interpolated player world position this frame drew (same alpha the render used).
    const ipx = game.renderPrevX + (game.p.x - game.renderPrevX) * game.renderAlpha;
    frames.push({ propSx, playerSx, relErr: Math.abs((playerSx - propSx) - (ipx - prop.x)) });
  }

  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i - 1].propSx - frames[i].propSx);
  const minD = Math.min(...deltas), maxD = Math.max(...deltas);
  check("prop pans smoothly at 144Hz (advances every frame, no stall)", minD > 0.01,
    `min per-frame move ${minD.toFixed(4)}px`);
  check("prop pan has no staircase (per-frame deltas uniform)", maxD - minD < 0.05,
    `delta spread ${(maxD - minD).toExponential(2)}px (bug signature: ~${(maxD).toFixed(2)}px jumps between stalls)`);

  const maxRelErr = Math.max(...frames.map((s) => s.relErr));
  check("prop is rigidly locked to the interpolated player (one shared camera, no re-snap)",
    maxRelErr < 1e-6, `max relative error ${maxRelErr.toExponential(2)}px across ${frames.length} fractional offsets`);

  const playerXs = frames.map((s) => s.playerSx);
  const wobble = Math.max(...playerXs) - Math.min(...playerXs);
  check("player screen position holds steady during the pan (no sawtooth vs the camera)",
    wobble < 0.35, `peak-to-peak ${wobble.toExponential(2)}px (sim-rate camera sawtoothed ~2px at 144Hz)`);
}

// ---- 3: the tile pass subtracts the exact same fractional camera as the prop pass --------
{
  renderAt(0.4375); // an arbitrary fractional offset mid-step
  const renderCamX = prop.x - readPropSx();
  const tileRects = frameLog.fillRects.filter((r) => r.w === TILE && r.h === TILE);
  let worstOff = 0;
  for (const r of tileRects) {
    const world = r.x + renderCamX;
    const off = Math.abs(world - Math.round(world / TILE) * TILE);
    if (off > worstOff) worstOff = off;
  }
  check("tile pass saw the visible window", tileRects.length > 100, `${tileRects.length} tile fills`);
  check("tiles share the prop's fractional camera exactly (no per-layer rounding)",
    worstOff < 1e-6, `worst tile-grid misalignment ${worstOff.toExponential(2)}px`);
}

// ---- 4: crossing a sim step is positionally continuous ------------------------------------
{
  renderAt(1); // the instant before the next sim step lands
  const before = readPropSx();
  game.tick(FIXED_DT);
  renderAt(0); // the instant after it lands
  const after = readPropSx();
  check("no pop at the sim-step boundary", Math.abs(before - after) < 1e-9,
    `|before-after| = ${Math.abs(before - after).toExponential(2)}px (sim-rate camera popped a full step here)`);
}

// ---- 6: a camera snap (floor load semantics) never slides ---------------------------------
{
  game.snapCameraTo(prop.x - 400, prop.y - 300);
  renderAt(0.37); // stale mid-step alpha from the previous frame
  const propSx = readPropSx();
  check("camera snap takes effect exactly (no one-frame slide from the old camera)",
    Math.abs(propSx - 400) < 1e-9, `prop at ${propSx.toFixed(6)}px, want 400`);
}

game.stop();

process.stdout.write(`\nrendersmooth: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
