// Dev entry dispatcher. Only ever reached from main.ts behind the ?dev flag, which is
// dynamically imported so none of this (nor the sandbox/viewer it pulls in) ships in the
// normal play bundle. `?dev=sprites` opens the sprite viewer; anything else (?dev=1) the
// creative-mode sandbox.

import { bootSandbox } from "./sandbox.js";
import { bootSpriteViewer } from "./spriteViewer.js";

export function bootDev(mode: string, canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, overlay: HTMLElement): void {
  if (mode === "sprites") {
    void bootSpriteViewer();
    return;
  }
  bootSandbox(canvas, minimap, overlay);
}
