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
import { MAX_OWNED_WEAPONS } from "../sim/constants.js";

// Which surface currently owns input. Exactly one is active at a time:
//  - menu:      no run on screen (title/lobby/game-over own the DOM)
//  - gameplay:  live run, local player acting
//  - hud:       live run, but the HUD owns the pointer/keys (hotbar drag or an open
//               drawer) — gameplay reads idle so a UI gesture can never fire/dash
//  - pause:     Esc overlay up
//  - blessing:  between-floor choice overlay up (the overlay owns 1/2/3/arrows/enter)
//  - shop:      the shop panel is up on a focused station in Patch's room (the panel owns
//               Enter/Esc/E) — gameplay reads idle, so browsing can never fire or move
//  - reconnect: online run waiting for the authoritative world (connecting veil)
//  - spectate:  local player downed in a party run (watching, not acting)
export type InputContext = "menu" | "gameplay" | "hud" | "pause" | "blessing" | "shop" | "reconnect" | "spectate";

export type GameAction =
  | { kind: "togglePause" }
  | { kind: "selectWeapon"; index: number }
  // Touch long-press on a hotbar slot: open its stat drawer without equipping.
  | { kind: "inspectSlot"; index: number }
  | { kind: "cycleWeapon"; dir: 1 | -1 }
  | { kind: "dropWeapon" }
  // Drag-out-to-discard: drop the OWNED weapon at hotbar `index` to the floor (the drawer's
  // dropWeapon path, indexed directly — not equip-then-drop). Fired by a hotbar drag
  // released outside the slots row when more than one weapon is owned.
  | { kind: "dropWeaponAt"; index: number }
  | { kind: "activateSlot"; index: number }
  | { kind: "reorderSlots"; from: number; to: number }
  // The full-hotbar swap prompt: trade the slot at `index` for the blocked pickup underfoot.
  | { kind: "swapSlot"; index: number }
  // The semantic interact PRESS (E edge; a controller's A button later): the game resolves
  // it against the world — today that is "open the focused shop station's panel". Distinct
  // from the revive channel, which is the HELD `interact` bit on the gameplay sample.
  | { kind: "interact" }
  | { kind: "cycleSpectate"; dir: 1 | -1 }
  // Spectate follow toggle (F): watched teammate <-> your own body (see who's coming).
  | { kind: "spectateFollow" }
  | { kind: "stats"; isHeld: boolean };

// Per-action context allow-list. togglePause stays available while paused (Esc resumes),
// spectating (quit out while down), reconnecting (escape a dead connect), and under the
// hud/shop contexts (the game routes it to close-the-surface first); weapon/inventory
// actions, interact, and fire exist only in live gameplay; cycling the spectated teammate
// exists only while downed — so a spectator structurally cannot reach any gameplay action,
// and an open shop panel structurally cannot leak movement/fire/equips.
const ACTION_CONTEXTS: Record<GameAction["kind"], readonly InputContext[]> = {
  togglePause: ["gameplay", "hud", "pause", "spectate", "reconnect", "shop"],
  selectWeapon: ["gameplay"],
  cycleWeapon: ["gameplay"],
  dropWeapon: ["gameplay"],
  dropWeaponAt: ["gameplay"],
  activateSlot: ["gameplay"],
  inspectSlot: ["gameplay"],
  reorderSlots: ["gameplay"],
  swapSlot: ["gameplay"],
  interact: ["gameplay"],
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
  // The ult-request hold (F). Like interact, a gameplay-context level input; the server alone
  // validates charge + the 8s lockout and resolves the effect.
  ult: boolean;
  // The MENDER heal-pulse hold (R). Like ult, a gameplay-context level input; the server alone
  // validates the pulse cooldown and resolves the directed heal.
  pulse: boolean;
}

const IDLE_SAMPLE: InputSample = { moveX: 0, moveY: 0, firing: false, dash: false, interact: false, ult: false, pulse: false };

// Double-tap-to-dash timing (game-designer spec). A dash fires on a down->up->down where the
// FIRST press was a genuine TAP (held <= TAP_MAX_HOLD) and the SECOND press lands within
// DOUBLE_TAP_MS of the first RELEASE (the gap is measured release->press, NOT press->press),
// so a held key or a slow re-press never dashes. Exported for the input test.
export const DOUBLE_TAP_MS = 220;
export const TAP_MAX_HOLD = 180;

// The four logical movement directions; each maps from BOTH its WASD key and its arrow
// equivalent, so a double-tap works on either (and mixing them across the two presses).
type MoveDir = "up" | "down" | "left" | "right";
const MOVE_DIR: Record<string, MoveDir> = {
  w: "up", arrowup: "up",
  s: "down", arrowdown: "down",
  a: "left", arrowleft: "left",
  d: "right", arrowright: "right",
};

// Per-direction tap tracking for the double-tap detector. pressT = when the currently-held
// press began (-1 = not held); lastReleaseT = when the previous press was released (-1 =
// none); lastPressWasTap = whether that previous press qualified as a tap (held short).
interface TapState { pressT: number; lastReleaseT: number; lastPressWasTap: boolean }
function freshTapState(): TapState { return { pressT: -1, lastReleaseT: -1, lastPressWasTap: false }; }

export class InputController {
  private keys = new Set<string>();
  private ctx: InputContext = "menu";
  private isMouseDown = false; // left button only — right/middle are never gameplay input
  private isAutofireLatched = false;
  private isStatsHeld = false;
  private onAction: (a: GameAction) => void;
  // Injectable monotonic clock (ms) so the double-tap timing is deterministic under test;
  // production uses performance.now().
  private now: () => number;
  // Per-direction double-tap state + the one-shot latch a detected double-tap arms (consumed
  // by the next gameplay sample as a dash, so it shares the Shift dash's cooldown/charges).
  private moveTap: Record<MoveDir, TapState> = {
    up: freshTapState(), down: freshTapState(), left: freshTapState(), right: freshTapState(),
  };
  private isDashTapQueued = false;
  mouseX = 0;
  mouseY = 0;

  constructor(onAction: (a: GameAction) => void, now: () => number = () => performance.now()) {
    this.onAction = onAction;
    this.now = now;
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
    // A double-tap sequence can never span an overlay boundary: a tap before the pause and a
    // press after it must not fabricate a dash on resume.
    this.resetDashTap();
  }

  // Window blur / tab hidden / focus loss: keyup+mouseup are lost while unfocused, so
  // drop everything held and require fresh presses.
  releaseAll(): void {
    this.keys.clear();
    this.suspendFire();
    this.releaseStats();
    this.resetDashTap();
  }

  private resetDashTap(): void {
    this.isDashTapQueued = false;
    for (const dir of Object.keys(this.moveTap) as MoveDir[]) this.moveTap[dir] = freshTapState();
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
      // Movement-key double-tap -> dash (an alternate to the dash key). Runs before the
      // weapon/interact edges (independent of them); only a genuine tap-then-quick-repress
      // in live gameplay arms the dash latch.
      this.trackMoveTap(k);
      // The select row is exactly the hotbar cap (1..MAX_OWNED_WEAPONS, cap <= 9 by
      // contract): every slot that can exist has a key, and no key names a dead slot.
      if (k >= "1" && k <= String(MAX_OWNED_WEAPONS)) this.emit({ kind: "selectWeapon", index: parseInt(k, 10) - 1 });
      if (k === "q") this.emit({ kind: "dropWeapon" }); // Q drops the equipped weapon
      // E is ONE physical key, three semantic meanings, disambiguated purely by context +
      // world state: the interact PRESS below (gameplay — the game opens the focused shop
      // station), the revive HOLD (the level `interact` bit on the gameplay sample), and
      // the spectate step (downed). The context gate makes exactly one reachable.
      if (k === "e") this.emit({ kind: "interact" });
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
    this.releaseMoveTap(k);
  }

  // On a fresh movement-key press: if the previous press of the SAME direction was a tap and
  // its RELEASE was within DOUBLE_TAP_MS, arm a dash (consumed by the next sample). Gated on
  // live gameplay + the setting; the sequence is then reset so a third tap needs a fresh one.
  private trackMoveTap(k: string): void {
    const dir = MOVE_DIR[k];
    if (dir === undefined) return;
    const st = this.moveTap[dir];
    const now = this.now();
    if (this.ctx === "gameplay" && settings.isDoubleTapDash
      && st.lastReleaseT >= 0 && st.lastPressWasTap && now - st.lastReleaseT <= DOUBLE_TAP_MS) {
      this.isDashTapQueued = true;
      st.lastReleaseT = -1;
      st.lastPressWasTap = false;
    }
    st.pressT = now;
  }

  // On a movement-key release: record whether the press just ended was a genuine TAP (held
  // <= TAP_MAX_HOLD) and when it released — the basis a following press checks against.
  private releaseMoveTap(k: string): void {
    const dir = MOVE_DIR[k];
    if (dir === undefined) return;
    const st = this.moveTap[dir];
    if (st.pressT < 0) return;
    const now = this.now();
    st.lastPressWasTap = now - st.pressT <= TAP_MAX_HOLD;
    st.lastReleaseT = now;
    st.pressT = -1;
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
    // Dash triggers: Shift is ALWAYS one; the rebindable dash key adds a second (Ian's R);
    // and a detected double-tap arms a one-shot latch, consumed here. All three feed the
    // SAME `dash` bit, so they share the sim's dash cooldown/charges/i-frames — a double-tap
    // is never a free extra dash.
    const dashKey = settings.dashKey;
    const dashHeld = this.keys.has("shift") || (dashKey !== "shift" && this.keys.has(dashKey));
    const dashTap = this.isDashTapQueued;
    this.isDashTapQueued = false;
    // The "ult requested" intent (spec §3): Q is already the drop-weapon key, so the ult lives
    // on the dedicated F key (a controller button later). A held bit is safe — the server resets
    // the meter on cast, so holding it can never chain a second ult. The MENDER heal-pulse (Wave
    // 2) lives on C — a held bit is likewise safe (the server owns the pulse cooldown).
    return { moveX, moveY, firing, dash: dashHeld || dashTap, interact: this.keys.has("e"), ult: this.keys.has("f"), pulse: this.keys.has("c") };
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
