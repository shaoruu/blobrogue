// Headless input-context harness: proves the InputController's gating matrix — overlay/
// pause/menu/reconnect/spectate can never leak gameplay actions or fire samples, blur/
// visibility loss drops everything held, only the left mouse button fires or toggles
// autofire, autofire never survives a context change, Esc auto-repeat can't flicker the
// pause overlay — plus FocusScope's modal focus capture/restore.
//
// Run: npm run test:input

import { InputController } from "../src/game/input.js";
import type { GameAction, InputContext } from "../src/game/input.js";
import { settings } from "../src/game/settings.js";
import { FocusScope } from "../src/ui/focus.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function harness(): { input: InputController; actions: GameAction[] } {
  const actions: GameAction[] = [];
  const input = new InputController((a) => actions.push(a));
  return { input, actions };
}

function isIdle(input: InputController): boolean {
  const s = input.sample();
  return s.moveX === 0 && s.moveY === 0 && !s.firing && !s.dash;
}

const NON_GAMEPLAY: InputContext[] = ["menu", "hud", "pause", "blessing", "reconnect", "spectate"];
const WEAPON_ACTIONS: readonly GameAction["kind"][] = ["selectWeapon", "cycleWeapon", "dropWeapon", "activateSlot", "reorderSlots"];

function overlayLeakageTests(): void {
  section("overlay leakage: gameplay actions exist only in the gameplay context");
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.keyDown("1");
    input.keyDown("q");
    input.wheel(120);
    input.wheel(-120);
    check("gameplay: 1/Q/wheel produce weapon actions",
      actions.length === 4
      && actions[0].kind === "selectWeapon" && actions[0].index === 0
      && actions[1].kind === "dropWeapon" // Q drops the equipped weapon
      && actions[2].kind === "cycleWeapon" && actions[2].dir === 1
      && actions[3].kind === "cycleWeapon" && actions[3].dir === -1);
  }
  for (const ctx of NON_GAMEPLAY) {
    const { input, actions } = harness();
    input.setContext(ctx);
    input.keyDown("1");
    input.keyDown("9");
    input.keyDown("q");
    input.wheel(120);
    const leaked = actions.filter((a) => WEAPON_ACTIONS.includes(a.kind));
    check(`${ctx}: number/Q/wheel cannot change or drop weapons`, leaked.length === 0, leaked.map((a) => a.kind).join(","));
  }
  {
    const { input, actions } = harness();
    // "hud" allows togglePause too: the game routes it to close-the-drawer first, so
    // Escape always dismisses the topmost surface.
    for (const ctx of ["gameplay", "hud", "pause", "spectate", "reconnect"] as InputContext[]) {
      actions.length = 0;
      input.setContext(ctx);
      input.keyDown("Escape");
      input.keyUp("Escape");
      check(`${ctx}: Escape toggles pause`, actions.some((a) => a.kind === "togglePause"));
    }
    for (const ctx of ["menu", "blessing"] as InputContext[]) {
      actions.length = 0;
      input.setContext(ctx);
      input.keyDown("Escape");
      input.keyUp("Escape");
      check(`${ctx}: Escape emits no pause action`, !actions.some((a) => a.kind === "togglePause"));
    }
  }
  {
    const { input } = harness();
    input.setContext("blessing");
    input.keyDown("w");
    input.keyDown("shift");
    check("blessing: movement/dash sample is idle", isIdle(input));
    input.setContext("gameplay");
    const s = input.sample();
    check("held movement keys keep tracking across the overlay (level state)", s.moveY === -1 && s.dash);
  }
}

function mouseButtonTests(): void {
  section("mouse buttons: only left click fires / toggles autofire");
  {
    const { input } = harness();
    input.setContext("gameplay");
    input.mouseDown(2);
    check("right click never fires", !input.sample().firing);
    input.mouseDown(1);
    check("middle click never fires", !input.sample().firing);
    input.mouseDown(0);
    check("left click fires (hold-to-fire)", input.sample().firing);
    input.mouseUp(0);
    check("left release stops fire", !input.sample().firing);
  }
  {
    settings.setAutofire(true);
    const { input } = harness();
    input.setContext("gameplay");
    input.mouseDown(2); input.mouseUp(2);
    check("autofire: right click does not toggle the latch", !input.sample().firing);
    input.mouseDown(0); input.mouseUp(0);
    check("autofire: left click latches continuous fire", input.sample().firing && input.isFireLatched);
    input.mouseDown(0); input.mouseUp(0);
    check("autofire: second left click unlatches", !input.sample().firing);
    input.setContext("menu");
    input.mouseDown(0); input.mouseUp(0);
    input.setContext("gameplay");
    check("autofire: a click outside gameplay cannot latch", !input.sample().firing);
    settings.setAutofire(false);
  }
}

function blurVisibilityTests(): void {
  section("blur / tab-hidden: everything held is dropped (releaseAll)");
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.keyDown("w");
    input.keyDown("d");
    input.keyDown("shift");
    input.mouseDown(0);
    input.keyDown("Tab");
    check("pre-blur: moving, dashing, firing, stats held",
      input.sample().moveY === -1 && input.sample().moveX === 1 && input.sample().dash && input.sample().firing
      && actions.some((a) => a.kind === "stats" && a.isHeld));
    actions.length = 0;
    input.releaseAll();
    check("post-blur: sample is fully idle", isIdle(input));
    check("post-blur: stats hold released", actions.some((a) => a.kind === "stats" && !a.isHeld));
  }
  {
    settings.setAutofire(true);
    const { input } = harness();
    input.setContext("gameplay");
    input.mouseDown(0); input.mouseUp(0);
    check("autofire latched before blur", input.sample().firing);
    input.releaseAll();
    check("blur clears the autofire latch — fresh click required", !input.sample().firing && !input.isFireLatched);
    settings.setAutofire(false);
  }
}

function autofireContextTests(): void {
  section("autofire suspension: never resumes across pause/overlay/reconnect");
  settings.setAutofire(true);
  for (const ctx of ["pause", "blessing", "reconnect", "spectate"] as InputContext[]) {
    const { input } = harness();
    input.setContext("gameplay");
    input.mouseDown(0); input.mouseUp(0);
    input.setContext(ctx);
    input.setContext("gameplay");
    check(`${ctx} round-trip clears the latch`, !input.sample().firing);
    input.mouseDown(0); input.mouseUp(0);
    check(`${ctx}: fresh click re-latches`, input.sample().firing);
  }
  settings.setAutofire(false);
  {
    const { input } = harness();
    input.setContext("gameplay");
    input.mouseDown(0);
    input.setContext("pause");
    input.setContext("gameplay");
    check("held fire (hold-to-fire) does not survive a pause round-trip", !input.sample().firing);
  }
}

function edgeTriggerTests(): void {
  section("edge triggers: auto-repeat and context changes");
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.keyDown("Escape");
    input.keyDown("Escape", true);
    input.keyDown("Escape", true);
    check("Esc auto-repeat emits exactly one togglePause", actions.filter((a) => a.kind === "togglePause").length === 1);
    input.keyUp("Escape");
    input.keyDown("Escape");
    check("a fresh Esc press re-arms the toggle", actions.filter((a) => a.kind === "togglePause").length === 2);
  }
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.keyDown("1", true);
    input.keyDown("q", true);
    check("held number/Q auto-repeat never re-fires weapon actions", actions.length === 0);
  }
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.keyDown("Tab");
    actions.length = 0;
    input.setContext("pause");
    check("pausing while stats held releases the stats panel", actions.some((a) => a.kind === "stats" && !a.isHeld));
    actions.length = 0;
    input.setContext("gameplay");
    input.keyDown("Tab", true);
    check("stats do not reopen from key auto-repeat after the context change", actions.length === 0);
  }
}

function uiDispatchTests(): void {
  section("UI dispatch: hotbar-injected actions ride the same context gate");
  {
    const { input, actions } = harness();
    input.setContext("gameplay");
    input.dispatch({ kind: "activateSlot", index: 2 });
    input.dispatch({ kind: "reorderSlots", from: 0, to: 2 });
    input.dispatch({ kind: "dropWeapon" });
    check("gameplay: activate/reorder/drop dispatches pass",
      actions.length === 3
      && actions[0].kind === "activateSlot" && actions[0].index === 2
      && actions[1].kind === "reorderSlots" && actions[1].from === 0 && actions[1].to === 2
      && actions[2].kind === "dropWeapon");
  }
  for (const ctx of NON_GAMEPLAY) {
    const { input, actions } = harness();
    input.setContext(ctx);
    input.dispatch({ kind: "activateSlot", index: 0 });
    input.dispatch({ kind: "reorderSlots", from: 0, to: 1 });
    input.dispatch({ kind: "dropWeapon" });
    check(`${ctx}: UI dispatches are rejected by the gate`, actions.length === 0, actions.map((a) => a.kind).join(","));
  }
  {
    const { input } = harness();
    input.setContext("hud");
    input.keyDown("w");
    input.mouseDown(0);
    check("hud context (drag/drawer): gameplay sample is idle", isIdle(input));
  }
}

function spectateTests(): void {
  section("spectate: watching, not acting");
  const { input, actions } = harness();
  input.setContext("spectate");
  input.keyDown("w");
  input.mouseDown(0);
  input.keyDown("2");
  check("spectate: no movement/fire sample, no weapon actions",
    isIdle(input) && !actions.some((a) => a.kind === "selectWeapon"));
  input.keyDown("Tab");
  check("spectate: stats panel still available", actions.some((a) => a.kind === "stats" && a.isHeld));
}

interface FakeFocusable { focus(): void; isConnected: boolean; focusCount: number }
function fakeEl(isConnected = true): FakeFocusable {
  const el: FakeFocusable = { isConnected, focusCount: 0, focus() { el.focusCount++; } };
  return el;
}

function focusScopeTests(): void {
  section("focus restoration: modal open/close returns focus");
  {
    const scope = new FocusScope();
    const trigger = fakeEl();
    const modalBtn = fakeEl();
    scope.open(modalBtn, trigger);
    check("opening focuses the modal's primary control", modalBtn.focusCount === 1 && trigger.focusCount === 0);
    scope.close();
    check("closing returns focus to the opener", trigger.focusCount === 1);
    scope.close();
    check("a second close is a no-op (no stale refocus)", trigger.focusCount === 1);
  }
  {
    const scope = new FocusScope();
    const trigger = fakeEl(false); // opener left the DOM while the modal was up
    scope.open(fakeEl(), trigger);
    scope.close();
    check("a disconnected opener is never refocused", trigger.focusCount === 0);
  }
}

overlayLeakageTests();
mouseButtonTests();
blurVisibilityTests();
autofireContextTests();
edgeTriggerTests();
uiDispatchTests();
spectateTests();
focusScopeTests();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => `  FAILED: ${f}`).join("\n") + "\n");
  process.exit(1);
}
