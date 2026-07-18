// Dev entry dispatcher. Only ever reached from main.ts behind the ?dev flag, which is
// dynamically imported so none of this (nor the sandbox/viewer it pulls in) ships in the
// normal play bundle. `?dev=sprites` opens the sprite viewer; `?dev=arena` the Wave 2 arena
// capture harness; anything else (?dev=1) the creative-mode sandbox.

import { bootSandbox } from "./sandbox.js";
import { bootSpriteViewer } from "./spriteViewer.js";
import { bootArenaHarness } from "./arenaHarness.js";

export function bootDev(mode: string, canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, overlay: HTMLElement): void {
  if (mode === "sprites") {
    void bootSpriteViewer();
    return;
  }
  if (mode === "arena") {
    bootArenaHarness(canvas, minimap, overlay);
    return;
  }
  bootSandbox(canvas, minimap, overlay);
}
