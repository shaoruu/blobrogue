// Client input contexts + the single gated funnel between raw input and gameplay actions.
//
// Every raw input (key, mouse button, wheel) lands here first, and every gameplay-affecting
// action leaves through `emit`, which checks the current InputContext. That is what makes
// "a number key during the blessing overlay switches weapons" structurally impossible: an
// action either is allowed in the current context or it never reaches the game.
//
// This module is deliberately DOM-free (it receives plain keys/buttons/deltas, never events)
// so the whole context/gating matrix runs headlessly in test/input.test.ts. The thin DOM
// binding lives in Game.bindInput. UI surfaces (e.g. hotbar slot clicks/drags) inject through
// `dispatch`, so they ride the exact same context gate as the keyboard.

import { settings } from "./settings.js";

// Which surface currently owns input. Exactly one is active at a time:
//  - menu:      no run on screen (title/lobby/game-over own the DOM)
//  - gameplay:  live run, local player acting
//  - hud:       live run, but the HUD owns the pointer/keys (hotbar drag or an open
//               drawer) — gameplay reads idle so a UI gesture can never fire/dash
//  - pause:     Esc overlay up
//  - blessing:  between-floor choice overlay up (the overlay owns 1/2/3/arrows/enter)
//  - reconnect: online run waiting for the authoritative world (connecting veil)
//  - spectate:  local player downed in a party run (watching, not acting)
export type InputContext = "menu" | "gameplay" | "hud" | "pause" | "blessing" | "reconnect" | "spectate";

export type GameAction =
  | { kind: "togglePause" }
  | { kind: "selectWeapon"; index: number }
  // Touch long-press on a hotbar slot: open its stat drawer without equipping.
  | { kind: "inspectSlot"; index: number }
  | { kind: "cycleWeapon"; dir: 1 | -1 }
  | { kind: "dropWeapon" }
  | { kind: "activateSlot"; index: number }
  | { kind: "reorderSlots"; from: number; to: number }
  | { kind: "cycleSpectate"; dir: 1 | -1 }
  // Spectate follow toggle (F): watched teammate <-> your own body (see who's coming).
  | { kind: "spectateFollow" }
  | { kind: "stats"; isHeld: boolean };

// Per-action context allow-list. togglePause stays available while paused (Esc resumes),
// spectating (quit out while down), reconnecting (escape a dead connect), and under the
// hud context (the game routes it to close-the-drawer first); weapon/inventory actions
// and fire exist only in live gameplay; cycling the spectated teammate exists only while
// downed — so a spectator structurally cannot reach any gameplay action.
const ACTION_CONTEXTS: Record<GameAction["kind"], readonly InputContext[]> = {
  togglePause: ["gameplay", "hud", "pause", "spectate", "reconnect"],
  selectWeapon: ["gameplay"],
  cycleWeapon: ["gameplay"],
  dropWeapon: ["gameplay"],
  activateSlot: ["gameplay"],
  inspectSlot: ["gameplay"],
  reorderSlots: ["gameplay"],
  cycleSpectate: ["spectate"],
  spectateFollow: ["spectate"],
  stats: ["gameplay", "spectate"],
};

export interface InputSample {
  moveX: number;
  moveY: number;
  firing: boolean;
  dash: boolean;
  // The revive-channel hold (E). A gameplay-context level input like movement; every other
  // context samples it released, so a spectator/chooser can never channel.
  interact: boolean;
}

const IDLE_SAMPLE: InputSample = { moveX: 0, moveY: 0, firing: false, dash: false, interact: false };

export class InputController {
  private keys = new Set<string>();
  private ctx: InputContext = "menu";
  private isMouseDown = false; // left button only — right/middle are never gameplay input
  private isAutofireLatched = false;
  private isStatsHeld = false;
  private onAction: (a: GameAction) => void;
  mouseX = 0;
  mouseY = 0;

  constructor(onAction: (a: GameAction) => void) {
    this.onAction = onAction;
  }

  get context(): InputContext {
    return this.ctx;
  }

  get isFireLatched(): boolean {
    return this.isAutofireLatched;
  }

  // A context switch clears every edge-triggered/latched input (held fire, the autofire
  // latch, the stats hold) so nothing carries across an overlay boundary — resuming from
  // pause/blessing/reconnect always requires fresh input to fire. Held movement keys are
  // level state and keep tracking the physical keyboard (keyup still updates them under
  // any overlay), so they can't stick either.
  setContext(ctx: InputContext): void {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    this.suspendFire();
    this.releaseStats();
  }

  // Window blur / tab hidden / focus loss: keyup+mouseup are lost while unfocused, so
  // drop everything held and require fresh presses.
  releaseAll(): void {
    this.keys.clear();
    this.suspendFire();
    this.releaseStats();
  }

  // UI-driven actions (hotbar slot click/drag, on-screen buttons) enter here and pass
  // through the same context gate as the keyboard.
  dispatch(a: GameAction): void {
    this.emit(a);
  }

  // Returns true when the caller should preventDefault. Auto-repeat never re-triggers an
  // edge action (Esc held can't flicker the pause overlay).
  keyDown(key: string, isRepeat = false): boolean {
    const k = key.toLowerCase();
    this.keys.add(k);
    if (k === "escape") {
      if (!isRepeat) this.emit({ kind: "togglePause" });
      return this.ctx !== "menu";
    }
    const isPlaying = this.ctx === "gameplay" || this.ctx === "spectate";
    if (k === "tab") {
      if (!isRepeat && !this.isStatsHeld && this.allows("stats")) {
        this.isStatsHeld = true;
        this.onAction({ kind: "stats", isHeld: true });
      }
      return isPlaying; // outside a run, Tab keeps doing focus navigation
    }
    if (!isRepeat) {
      if (k >= "1" && k <= "9") this.emit({ kind: "selectWeapon", index: parseInt(k, 10) - 1 });
      if (k === "q") this.emit({ kind: "dropWeapon" }); // Q drops the equipped weapon
      // Downed: Q/E and the arrows step the spectated teammate instead (the context gate
      // keeps these dead everywhere else, and gameplay keys dead here). A controller's
      // bumpers would dispatch the same action.
      if (k === "q" || k === "arrowleft") this.emit({ kind: "cycleSpectate", dir: -1 });
      if (k === "e" || k === "arrowright") this.emit({ kind: "cycleSpectate", dir: 1 });
      if (k === "f") this.emit({ kind: "spectateFollow" });
    }
    return isPlaying && (k === " " || k === "shift");
  }

  keyUp(key: string): void {
    const k = key.toLowerCase();
    this.keys.delete(k);
    if (k === "tab") this.releaseStats();
  }

  // Only the LEFT button fires — and, in autofire mode, toggles the latch. Right/middle
  // clicks (and any click outside live gameplay) are ignored entirely, so they can never
  // start fire or flip autofire.
  mouseDown(button: number): void {
    if (button !== 0 || this.ctx !== "gameplay") return;
    this.isMouseDown = true;
    if (settings.isAutofire) this.isAutofireLatched = !this.isAutofireLatched;
  }

  mouseUp(button: number): void {
    if (button === 0) this.isMouseDown = false;
  }

  mouseMove(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  wheel(deltaY: number): void {
    const dir = deltaY > 0 ? 1 : -1;
    // While down the wheel steps the spectated teammate; alive it cycles weapons. Both ride
    // the context gate, so exactly one can ever fire.
    this.emit({ kind: "cycleWeapon", dir });
    this.emit({ kind: "cycleSpectate", dir });
  }

  // Whether the revive-channel key is physically held in live gameplay (drives the
  // world-space HOLD E / REVIVING prompt beside a downed teammate).
  get isInteractHeld(): boolean {
    return this.ctx === "gameplay" && this.keys.has("e");
  }

  // The per-tick gameplay sample. Anything but live gameplay reads as a player doing
  // nothing — movement, fire, dash, and the revive channel cannot leak out of an overlay
  // or spectate.
  sample(): InputSample {
    if (this.ctx !== "gameplay") return IDLE_SAMPLE;
    let moveX = 0, moveY = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) moveY -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) moveY += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) moveX -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) moveX += 1;
    if (!settings.isAutofire) this.isAutofireLatched = false;
    const firing = settings.isAutofire ? this.isAutofireLatched : this.isMouseDown;
    return { moveX, moveY, firing, dash: this.keys.has("shift"), interact: this.keys.has("e") };
  }

  private suspendFire(): void {
    this.isMouseDown = false;
    this.isAutofireLatched = false;
  }

  private releaseStats(): void {
    if (!this.isStatsHeld) return;
    this.isStatsHeld = false;
    this.onAction({ kind: "stats", isHeld: false });
  }

  private allows(kind: GameAction["kind"]): boolean {
    return ACTION_CONTEXTS[kind].includes(this.ctx);
  }

  private emit(a: GameAction): void {
    if (this.allows(a.kind)) this.onAction(a);
  }
}
