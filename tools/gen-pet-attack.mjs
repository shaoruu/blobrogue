#!/usr/bin/env node
// gen-pet-attack — build the original pets' one-shot ATTACK emote strips from their static
// base sprite via deterministic per-frame squash/stretch/lean transforms (the same clean,
// no-blend approach as tools/gen-walk.py: every frame is one crisp NEAREST copy of the
// source, bottom-anchored). NOT combat — the "attack" clip is the cute owner-fires / pet
// reacts flourish (see petRenderer.drawPetFrame). Horizontal 4-frame strips, 256x64.
//
// The beat is a readable anticipation -> strike -> recover: crouch/coil, lean-back windup,
// forward lunge + stretch, then settle. Fully deterministic (no fal, no AI, no RNG) so the
// same base sprite always yields byte-identical output.
//
// Run: node tools/gen-pet-attack.mjs
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PETS = join(HERE, "..", "public", "sprites", "pets");
const W = 64;
const N = 4;

// The 4-frame attack beat as (sx, sy, dx, dy) — scale about center-bottom, then pixel offset.
// Sprites face +x, so a forward lunge pushes dx positive. Kept modest so nothing clips.
const BEAT = [
  { sx: 1.08, sy: 0.9, dx: -2, dy: 0 },   // 0 crouch/squash — coil low
  { sx: 1.04, sy: 0.98, dx: -4, dy: -1 }, // 1 lean-back windup — load
  { sx: 0.94, sy: 1.1, dx: 6, dy: -2 },   // 2 lunge forward + stretch up — the strike
  { sx: 1.02, sy: 0.99, dx: 1, dy: 0 },   // 3 settle/recover
];

function frame(base, { sx, sy, dx, dy }) {
  const bw = Math.max(1, Math.round(W * sx));
  const bh = Math.max(1, Math.round(W * sy));
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const px = Math.round((W - bw) / 2) + dx;
  const py = W - bh + dy; // bottom-anchored, like gen-walk.py
  ctx.drawImage(base, px, py, bw, bh);
  return canvas;
}

async function build(name) {
  const base = await loadImage(join(PETS, `${name}.png`));
  const sheet = createCanvas(W * N, W);
  const ctx = sheet.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < N; i++) {
    ctx.drawImage(frame(base, BEAT[i]), i * W, 0);
  }
  const out = join(PETS, `${name}_attack.png`);
  writeFileSync(out, sheet.toBuffer("image/png"));
  console.log(`${name}_attack.png: ${W * N}x${W} (${N} frames)`);
}

for (const name of ["doggie", "cat", "dragon", "slime"]) {
  await build(name);
}
console.log("gen-pet-attack done");
