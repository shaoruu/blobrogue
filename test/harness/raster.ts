// Real-raster headless harness: swaps the inert domShim canvas/image stubs for
// node-canvas so the REAL Game renderer draws real pixels (real sprite/tile PNGs from
// /public) under Node. Shared by the lighting visual-metrics gate (test/lighting.test.ts)
// and the PR screenshot rig (tools/lightingScreens.ts).
//
// Import order matters: this module must be imported FIRST, and the game module graph
// only via bootGame()/importGame(), so Sprites/TileSet construct against the raster
// globals instead of the shim stubs.

import "./domShim.js";
import { domOverlay } from "./domShim.js";
import { createCanvas, Image as CanvasImage } from "canvas";
import type { Canvas, Image } from "canvas";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Image that loads "/sprites/x.png"-style URLs synchronously from /public; a missing
// file just leaves the image incomplete, so the renderer's ready() fallbacks hold.
class DiskImage extends CanvasImage {
  set src(v: string | Buffer) {
    const setter = Object.getOwnPropertyDescriptor(CanvasImage.prototype, "src")!.set!;
    if (typeof v === "string") {
      try {
        setter.call(this, readFileSync(join(ROOT, "public", v)));
      } catch {
        // missing art: stay incomplete
      }
    } else {
      setter.call(this, v);
    }
  }

  get src(): string {
    return "";
  }
}

interface MutableGlobals {
  document: { createElement: (tag: string) => object };
  Image: typeof DiskImage;
  HTMLImageElement: typeof CanvasImage;
}

let created = 0;
let isInstalled = false;

// Count of canvases created since boot — the steady-state allocation gate reads this.
export function canvasAllocations(): number {
  return created;
}

export function installRaster(): void {
  if (isInstalled) return;
  isInstalled = true;
  const g = globalThis as object as MutableGlobals;
  const shimCreate = g.document.createElement.bind(g.document);
  g.document.createElement = (tag: string): object => {
    if (tag !== "canvas") return shimCreate(tag);
    created++;
    return createCanvas(1, 1);
  };
  g.Image = DiskImage;
  g.HTMLImageElement = CanvasImage;
}

interface ScreenExtras {
  addEventListener: () => void;
  getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number };
  style: Record<string, string>;
}

export function screenCanvas(w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h) as Canvas & ScreenExtras;
  c.addEventListener = () => {};
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 });
  c.style = {};
  return c as object as HTMLCanvasElement;
}

// The Game surface the harness drives. Public dev hooks plus the handful of private
// fields QA rigs reach (same contract the golden harness and coopScreens rely on).
export interface HarnessGame {
  devStartSandbox(): void;
  devLoadRealFloor(floor: number): void;
  devTeleport(x: number, y: number): void;
  devToggleLighting(): boolean;
  devGiveWeapon(id: string): void;
  devWorld(): {
    seed: number;
    floor: number;
    enemies: { x: number; y: number; dead: boolean }[];
    floorHazards: { id: number; kind: string; tx: number; ty: number; phase: number; group: number }[];
    floorHazardClock: number;
    dungeon: { w: number; h: number; tiles: number[]; spawn: { x: number; y: number }; exit: { x: number; y: number }; rooms: { x: number; y: number; w: number; h: number; cx: number; cy: number }[] };
  };
  devLighting(): import("../../src/game/lighting.js").LightingRenderer;
  tick(dt: number): void;
  render(): void;
  stop(): void;
}

interface HarnessPrivates {
  seed: number;
  cam: { x: number; y: number };
  torches: { tx: number; ty: number }[];
  input: { mouseX: number; mouseY: number; isMouseDown: boolean };
  motes: { reseed(): void; update(): void; render(): void };
}

export function privates(game: HarnessGame): HarnessPrivates {
  return game as object as HarnessPrivates;
}

export interface BootedGame {
  game: HarnessGame;
  canvas: Canvas;
}

interface GameModuleShape {
  Game: new (
    canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement,
    overlay: HTMLElement,
    onGameOver: () => void,
    onExit: () => void,
  ) => object;
}

const noop = (): void => {};

// Boot the real Game against a node-canvas screen with the DOM-heavy subsystems
// (HUD/minimap/blessing) stubbed, exactly like the golden + coopScreens harnesses.
export async function bootGame(w: number, h: number): Promise<BootedGame> {
  installRaster();
  const { Game } = (await import("../../src/game/game.js")) as GameModuleShape;
  const { Hud } = await import("../../src/game/hud.js");
  const { Minimap } = await import("../../src/game/minimap.js");
  const { BlessingOverlay } = await import("../../src/ui/blessing.js");
  const hudProto = Hud.prototype as object as Record<string, () => void>;
  for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"]) {
    hudProto[m] = noop;
  }
  (Minimap.prototype as object as Record<string, () => void>).render = noop;
  (BlessingOverlay.prototype as object as Record<string, () => void>).show = noop;
  const screen = screenCanvas(w, h);
  const game = new Game(screen, screenCanvas(160, 120), domOverlay as object as HTMLElement, noop, noop) as object as HarnessGame;
  return { game, canvas: screen as object as Canvas };
}

// Load a REAL generated floor at a fixed seed (world + client cosmetic streams both
// re-keyed), teleport to a spot, settle the camera, and advance a few deterministic
// ticks so spawn flashes decay. Motes are stubbed out: they are the one render layer
// seeded from Math.random, and the metrics gate needs reproducible pixels.
export function loadDeterministicFloor(game: HarnessGame, seed: number, floor: number): void {
  const p = privates(game);
  p.motes.reseed = noop;
  p.motes.update = noop;
  p.motes.render = noop;
  game.devWorld().seed = seed;
  p.seed = seed;
  game.devLoadRealFloor(floor);
}

export function settleAt(game: HarnessGame, x: number, y: number, viewW: number, viewH: number, ticks = 30): void {
  game.devTeleport(x, y);
  const p = privates(game);
  for (let i = 0; i < ticks; i++) game.tick(1 / 60);
  p.cam.x = x - viewW / 2;
  p.cam.y = y - viewH / 2;
}

export { CanvasImage };
export type { Canvas, Image };
