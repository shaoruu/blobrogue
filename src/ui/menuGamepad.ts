// Controller parity for the MENU surfaces (title, profiles, closet, leaderboard):
//   D-pad      — move focus through the screen's focusable controls (DOM order)
//   A (0)      — activate the focused control (exactly a click)
//   B (1)      — Back/cancel: dispatches the same Escape the keyboard uses, so it inherits
//                the same behavior (named focus restore, exact leaderboard-row return)
//                with zero parallel logic
//   LB/RB (4/5)— cycle the screen's tab group (closet categories, profile views)
//
// The poller only acts while the overlay is visible (never during a run) and only on
// edges (a held button fires once). The mapping is a pure function so the contract is
// testable headless.

export type PadAction = "focusPrev" | "focusNext" | "activate" | "back" | "tabPrev" | "tabNext";

const BTN_A = 0, BTN_B = 1, BTN_LB = 4, BTN_RB = 5;
const DPAD_UP = 12, DPAD_DOWN = 13, DPAD_LEFT = 14, DPAD_RIGHT = 15;

// Edge-detected actions between two button-state frames.
export function padActions(prev: readonly boolean[], now: readonly boolean[]): PadAction[] {
  const pressed = (i: number) => now[i] === true && prev[i] !== true;
  const out: PadAction[] = [];
  if (pressed(DPAD_UP) || pressed(DPAD_LEFT)) out.push("focusPrev");
  if (pressed(DPAD_DOWN) || pressed(DPAD_RIGHT)) out.push("focusNext");
  if (pressed(BTN_A)) out.push("activate");
  if (pressed(BTN_B)) out.push("back");
  if (pressed(BTN_LB)) out.push("tabPrev");
  if (pressed(BTN_RB)) out.push("tabNext");
  return out;
}

function focusables(overlay: HTMLElement): HTMLElement[] {
  const nodes = overlay.querySelectorAll<HTMLElement>("button:not(:disabled), input, [tabindex]");
  return [...nodes].filter((n) => n.offsetParent !== null);
}

export interface MenuPadHooks {
  onTab: (dir: 1 | -1) => void;
}

export function applyPadAction(action: PadAction, overlay: HTMLElement, hooks: MenuPadHooks): void {
  switch (action) {
    case "focusPrev":
    case "focusNext": {
      const items = focusables(overlay);
      if (items.length === 0) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const idx = active ? items.indexOf(active) : -1;
      const step = action === "focusNext" ? 1 : -1;
      const next = idx === -1 ? (step === 1 ? 0 : items.length - 1) : (idx + step + items.length) % items.length;
      items[next].focus();
      return;
    }
    case "activate": {
      const active = document.activeElement;
      if (active instanceof HTMLElement && overlay.contains(active)) active.click();
      else focusables(overlay)[0]?.focus();
      return;
    }
    case "back":
      // The keyboard path IS the controller path: same guards, same focus restore.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      return;
    case "tabPrev":
      hooks.onTab(-1);
      return;
    case "tabNext":
      hooks.onTab(1);
      return;
  }
}

// Start the poll loop. Inert while the overlay is hidden or no pad is connected.
export function bindMenuGamepad(overlay: HTMLElement, hooks: MenuPadHooks): void {
  let prev: boolean[] = [];
  const tick = () => {
    requestAnimationFrame(tick);
    if (overlay.classList.contains("hidden")) { prev = []; return; }
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p !== null && p !== undefined);
    if (!pad) { prev = []; return; }
    const now = pad.buttons.map((b) => b.pressed);
    for (const action of padActions(prev, now)) applyPadAction(action, overlay, hooks);
    prev = now;
  };
  requestAnimationFrame(tick);
}
