// Hotbar drag/reorder regression suite (jsdom): the P0 live repro — the drag ghost must
// stay under the pointer at the ORIGINAL grab point, at any slot width (normal 66px vs the
// equipped 84px), any UI zoom (#hud zoom: var(--ui-scale)), and any devicePixelRatio —
// plus the full drag lifecycle: click-vs-drag threshold, insertion marker independence on
// a wrapped bar, deterministic five-slot reorders, every cancel path (Escape, blur, tab
// hide, resize, pointercancel, release outside, item disappearing under the drag), no
// stuck state after a cancel, tooltip suppression while dragging, and the keyboard
// (Shift+arrow) reorder alternative with focus restore.
//
// Rects are stubbed per element (jsdom has no layout), which is exactly what makes the
// zoom/DPR cases deterministic: the math under test is pure client-coordinate arithmetic.
//
// Run: npm run test:hotbardrag

import { JSDOM, VirtualConsole } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
});
// jsdom has no pointer capture; the HUD code calls these unconditionally.
(dom.window.HTMLElement.prototype as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {};
(dom.window.HTMLElement.prototype as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = () => {};

const { Hud } = await import("../src/game/hud.js");
const { createMods } = await import("../src/sim/items.js");
const { weaponHudStats } = await import("../src/sim/weaponStats.js");
type HudModule = typeof import("../src/game/hud.js");
type HudState = Parameters<InstanceType<HudModule["Hud"]>["update"]>[0];
type WeaponId = HudState["weapons"][number]["id"];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// The playtest layout: five owned weapons, slot 1 (shotgun) equipped.
const FIVE: { id: WeaponId; name: string }[] = [
  { id: "pistol", name: "Pistol" },
  { id: "shotgun", name: "Shotgun" },
  { id: "tesla", name: "Tesla" },
  { id: "sword", name: "Cutlass" },
  { id: "railgun", name: "Longshot" },
];

function mkState(currentIndex = 1, ids = FIVE): HudState {
  return {
    hp: 5, maxHp: 6, floor: 2, kills: 7, coins: 30,
    weapons: ids.map((w, i) => ({ ...w, isCurrent: i === currentIndex, stats: weaponHudStats(w.id, createMods(), 0) })),
    isCleared: false, enemiesLeft: 3, isObjectiveHidden: false, isParty: false, isBossActive: false, bossHpFrac: 0,
    coopLabel: null, waitLabel: null, prompt: null, dashFill: 1,
    combo: 0, comboMult: 1, comboColor: "#fff", comboFrac: 0,
    items: [],
  };
}

interface Rect { left: number; top: number; width: number; height: number }

function setRect(elm: HTMLElement, r: Rect, cssWidth?: number): void {
  elm.getBoundingClientRect = () => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
    toJSON() { return {}; },
  } as DOMRect);
  if (cssWidth !== undefined) Object.defineProperty(elm, "offsetWidth", { value: cssWidth, configurable: true });
}

// Lay the five slots out in one bottom row at the given zoom (viewport px = CSS px × zoom),
// mirroring the real CSS: 66px slots, the equipped one 84px, 6px gaps, plus the slots-row
// container rect. Returns each slot's viewport rect.
function layoutRow(slotsEl: HTMLElement, slots: HTMLElement[], zoom: number, originX = 300, top = 600): Rect[] {
  const gap = 6 * zoom;
  const rects: Rect[] = [];
  let x = originX;
  for (const s of slots) {
    const cssW = s.classList.contains("on") ? 84 : 66;
    const r = { left: x, top, width: cssW * zoom, height: 62 * zoom };
    setRect(s, r, cssW);
    rects.push(r);
    x += r.width + gap;
  }
  setRect(slotsEl, { left: originX, top, width: x - gap - originX, height: 62 * zoom });
  return rects;
}

type Actions = { activates: number[]; reorders: [number, number][] };

function rig(currentIndex = 1): { hud: InstanceType<HudModule["Hud"]>; root: HTMLElement; slotsEl: HTMLElement; slots: HTMLElement[]; acts: Actions } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const acts: Actions = { activates: [], reorders: [] };
  hud.setHotbarActions({
    onSlotActivate: (i) => acts.activates.push(i),
    onSlotReorder: (from, to) => acts.reorders.push([from, to]),
  });
  hud.update(mkState(currentIndex));
  const slotsEl = root.querySelector<HTMLElement>("[data-hb-slots]")!;
  const slots = [...slotsEl.querySelectorAll<HTMLElement>(".hb-slot")];
  return { hud, root, slotsEl, slots, acts };
}

function ptr(type: string, x: number, y: number, pointerId = 1): Event {
  const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "pointerId", { value: pointerId });
  return e;
}

function ghostEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".hb-ghost");
}

// Press at (grab point inside the slot), move to (x2,y2). Returns the ghost.
function dragTo(slot: HTMLElement, r: Rect, gx: number, gy: number, x2: number, y2: number): HTMLElement | null {
  slot.dispatchEvent(ptr("pointerdown", r.left + gx, r.top + gy));
  slot.dispatchEvent(ptr("pointermove", x2, y2));
  return ghostEl();
}

function expectTransform(x2: number, y2: number, gx: number, gy: number, scale: number): string {
  const base = `translate3d(${Math.round(x2 - gx)}px, ${Math.round(y2 - gy)}px, 0)`;
  return scale !== 1 ? `${base} scale(${scale})` : base;
}

function grabPointTests(): void {
  section("P0: the ghost pins the ORIGINAL grab point under the pointer (no center snap)");
  for (const [label, gxFrac, gyFrac] of [["center", 0.5, 0.5], ["top-left corner", 0.06, 0.1], ["bottom-right corner", 0.94, 0.9]] as const) {
    // Normal 66px slot (index 0) and the wider equipped 84px slot (index 1) — the width
    // difference is exactly what made the old width/2-centering snap on live.
    for (const idx of [0, 1]) {
      const { hud, root, slotsEl, slots } = rig();
      const rects = layoutRow(slotsEl, slots, 1);
      const r = rects[idx];
      const gx = r.width * gxFrac, gy = r.height * gyFrac;
      const ghost = dragTo(slots[idx], r, gx, gy, 500, 380);
      check(`${idx === 1 ? "equipped 84px" : "normal 66px"} slot, ${label} grab`,
        ghost !== null && ghost.style.transform === expectTransform(500, 380, gx, gy, 1),
        ghost?.style.transform ?? "no ghost");
      slots[idx].dispatchEvent(ptr("pointermove", 220.7, 411.2));
      check(`  fractional pointer coords round to whole px (crisp pixels)`,
        ghost?.style.transform === expectTransform(220.7, 411.2, gx, gy, 1), ghost?.style.transform ?? "");
      hud.clear(); root.remove();
    }
  }

  section("P0: non-1 UI zoom (the #hud zoom: var(--ui-scale) mismatch that offset the ghost)");
  for (const zoom of [0.8, 1.25]) {
    const { hud, root, slotsEl, slots } = rig();
    const rects = layoutRow(slotsEl, slots, zoom);
    const r = rects[1]; // equipped, viewport width 84*zoom
    const gx = 9, gy = 12; // off-center grab, viewport px
    const ghost = dragTo(slots[1], r, gx, gy, 466, 390);
    check(`zoom ${zoom}: grab point preserved in viewport coordinates`,
      ghost !== null && ghost.style.transform === expectTransform(466, 390, gx, gy, zoom),
      ghost?.style.transform ?? "no ghost");
    check(`zoom ${zoom}: ghost box is the UNSCALED slot size with the zoom re-applied via scale()`,
      ghost?.style.width === "84px" && ghost?.style.transformOrigin === "0 0", `w=${ghost?.style.width}`);
    hud.clear(); root.remove();
  }

  section("P0: devicePixelRatio never enters the math (client coords are CSS px)");
  const byDpr: string[] = [];
  for (const dpr of [1, 1.25, 2]) {
    Object.defineProperty(dom.window, "devicePixelRatio", { value: dpr, configurable: true });
    const { hud, root, slotsEl, slots } = rig();
    const r = layoutRow(slotsEl, slots, 1)[2];
    const ghost = dragTo(slots[2], r, 11, 7, 512, 404);
    byDpr.push(ghost?.style.transform ?? "no ghost");
    hud.clear(); root.remove();
  }
  check("identical transforms at DPR 1 / 1.25 / 2", byDpr[0] === byDpr[1] && byDpr[1] === byDpr[2], byDpr.join(" | "));

  section("P0: ghost hygiene — offscreen before the first move, inline-only transform, no tooltip");
  {
    const { hud, root, slotsEl, slots } = rig();
    const r = layoutRow(slotsEl, slots, 1)[1];
    // Cross the threshold with the FIRST move event: beginDragVisuals runs, then moveGhost
    // repositions in the same handler — but the initial style must start offscreen.
    slots[1].dispatchEvent(ptr("pointerdown", r.left + 5, r.top + 5));
    check("no ghost before the threshold", ghostEl() === null);
    slots[1].dispatchEvent(ptr("pointermove", r.left + 5 + 4, r.top + 5)); // 4px < threshold
    check("a 4px wiggle never starts a drag", ghostEl() === null);
    slots[1].dispatchEvent(ptr("pointermove", 400, 300));
    const ghost = ghostEl()!;
    check("ghost has transition disabled (never lags the pointer)", ghost.style.transition === "none");
    check("ghost carries no tooltip", ghost.querySelector(".tip") === null);
    check("equipped-slot transform is overridden by the inline positioner", ghost.style.transform.startsWith("translate3d("));
    check("hover tooltips suppressed for the whole drag", slotsEl.classList.contains("no-tips"));
    hud.clear(); root.remove();
  }
}

function markerAndReorderTests(): void {
  section("insertion marker: independent overlay, correct gap on a single row");
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    dragTo(slots[0], rects[0], 30, 30, rects[3].left + rects[3].width * 0.8, rects[3].top + 10);
    const marker = slotsEl.querySelector<HTMLElement>(".hb-ins")!;
    check("marker exists inside the slots row", marker !== null);
    // Pointer past slot 3's center -> gap 4 -> marker anchored at slot 4's left edge.
    check("marker sits at the gap-4 anchor", marker.style.left === `${rects[4].left - 4 - rects[0].left}px`, marker.style.left);
    slots[0].dispatchEvent(ptr("pointerup", rects[3].left + rects[3].width * 0.8, rects[3].top + 10));
    check("drop commits from(0) -> to(3): gap AFTER the removed source shifts down by one",
      acts.reorders.length === 1 && acts.reorders[0][0] === 0 && acts.reorders[0][1] === 3, JSON.stringify(acts.reorders));
    check("a drag release never equips", acts.activates.length === 0);
    check("marker + ghost removed on drop", slotsEl.querySelector(".hb-ins") === null && ghostEl() === null);
    hud.clear(); root.remove();
  }

  section("deterministic five-slot reorders (every direction)");
  const cases: { from: number; overSlot: number; frac: number; expectTo: number }[] = [
    { from: 4, overSlot: 0, frac: 0.2, expectTo: 0 },  // last to front
    { from: 0, overSlot: 4, frac: 0.9, expectTo: 4 },  // first to last
    { from: 2, overSlot: 1, frac: 0.2, expectTo: 1 },  // one step left
    { from: 1, overSlot: 2, frac: 0.9, expectTo: 2 },  // one step right
  ];
  for (const c of cases) {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    const x = rects[c.overSlot].left + rects[c.overSlot].width * c.frac;
    const y = rects[c.overSlot].top + 20;
    dragTo(slots[c.from], rects[c.from], 20, 20, x, y);
    slots[c.from].dispatchEvent(ptr("pointerup", x, y));
    check(`drag ${c.from} over slot ${c.overSlot} -> reorder(${c.from}, ${c.expectTo})`,
      acts.reorders.length === 1 && acts.reorders[0][0] === c.from && acts.reorders[0][1] === c.expectTo,
      JSON.stringify(acts.reorders));
    hud.clear(); root.remove();
  }

  section("wrapped bar: the row nearest the pointer owns the gap");
  {
    const { hud, root, slotsEl, slots } = rig();
    // Two rows: slots 0-2 on top, 3-4 below.
    const rows: Rect[] = [];
    let x = 300;
    for (let i = 0; i < 3; i++) { rows.push({ left: x, top: 540, width: 66, height: 62 }); x += 72; }
    x = 320;
    for (let i = 3; i < 5; i++) { rows.push({ left: x, top: 610, width: 66, height: 62 }); x += 72; }
    slots.forEach((s, i) => setRect(s, rows[i], 66));
    setRect(slotsEl, { left: 300, top: 540, width: 216, height: 132 });
    dragTo(slots[0], rows[0], 20, 20, rows[4].left + 60, rows[4].top + 30);
    const marker = slotsEl.querySelector<HTMLElement>(".hb-ins")!;
    // Pointer past slot 4's center on the SECOND row -> gap 5 -> anchored after the last slot.
    check("second-row pointer anchors the marker on the second row",
      marker.style.top === `${rows[4].top - 540}px` && marker.style.left === `${rows[4].left + 66 + 1 - 300}px`,
      `left=${marker.style.left} top=${marker.style.top}`);
    hud.clear(); root.remove();
  }

  section("click semantics survive: press + release without travel equips");
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    slots[3].dispatchEvent(ptr("pointerdown", rects[3].left + 10, rects[3].top + 10));
    slots[3].dispatchEvent(ptr("pointermove", rects[3].left + 13, rects[3].top + 11)); // < 6px
    slots[3].dispatchEvent(ptr("pointerup", rects[3].left + 13, rects[3].top + 11));
    check("sub-threshold press activates the slot", acts.activates.length === 1 && acts.activates[0] === 3);
    check("no reorder fired", acts.reorders.length === 0);
    check("no ghost ever appeared", ghostEl() === null);
    hud.clear(); root.remove();
  }
}

function cancelTests(): void {
  const begin = (currentIndex = 1) => {
    const r = rig(currentIndex);
    const rects = layoutRow(r.slotsEl, r.slots, 1);
    dragTo(r.slots[0], rects[0], 20, 20, 450, 380);
    return { ...r, rects };
  };

  section("cancel: Escape (via Hud.cancelActiveDrag) aborts without committing");
  {
    const { hud, root, slotsEl, slots, acts, rects } = begin();
    check("drag is live (owns the input context)", hud.isInteractionActive());
    check("cancelActiveDrag reports the live drag", hud.cancelActiveDrag() === true);
    check("ghost + marker removed", ghostEl() === null && slotsEl.querySelector(".hb-ins") === null);
    check("input context released", !hud.isInteractionActive());
    check("tooltips unsuppressed", !slotsEl.classList.contains("no-tips"));
    slots[0].dispatchEvent(ptr("pointerup", rects[3].left + 10, rects[3].top + 10));
    check("the release after a cancel neither reorders nor equips", acts.reorders.length === 0 && acts.activates.length === 0);
    check("cancelActiveDrag is idempotent", hud.cancelActiveDrag() === false);
    hud.clear(); root.remove();
  }

  section("cancel: window blur / tab hide / resize / pointercancel");
  {
    const { hud, root } = begin();
    dom.window.dispatchEvent(new dom.window.Event("blur"));
    check("window blur cancels the drag", !hud.isInteractionActive() && ghostEl() === null);
    hud.clear(); root.remove();
  }
  {
    const { hud, root } = begin();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    check("tab hide cancels the drag", !hud.isInteractionActive() && ghostEl() === null);
    hud.clear(); root.remove();
  }
  {
    const { hud, root } = begin();
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    check("resize cancels the drag (captured rects/scale are stale)", !hud.isInteractionActive() && ghostEl() === null);
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slots, acts } = begin();
    slots[0].dispatchEvent(ptr("pointercancel", 0, 0));
    check("pointercancel tears down cleanly", !hud.isInteractionActive() && ghostEl() === null && acts.reorders.length === 0);
    hud.clear(); root.remove();
  }

  section("cancel: release far outside the hotbar is a change of mind, not a reorder");
  {
    const { hud, root, slots, acts } = begin();
    slots[0].dispatchEvent(ptr("pointerup", 30, 80)); // way above/left of the row
    check("outside release commits nothing", acts.reorders.length === 0 && acts.activates.length === 0);
    check("state fully torn down", !hud.isInteractionActive() && ghostEl() === null);
    hud.clear(); root.remove();
  }

  section("cancel: the dragged item disappearing under the drag (authoritative drop/pickup)");
  {
    const { hud, root, slotsEl, acts } = begin();
    const four = mkState(0, FIVE.slice(1)); // pistol (the dragged slot 0) vanished
    hud.update(four);
    check("authority shrinking the set cancels the drag", !hud.isInteractionActive() && ghostEl() === null);
    check("slots rebuilt to the authoritative four", slotsEl.querySelectorAll(".hb-slot").length === 4);
    check("nothing was committed", acts.reorders.length === 0);
    hud.clear(); root.remove();
  }

  section("no stuck state: the next update after any cancel realigns with authority");
  {
    const { hud, root, slotsEl } = begin();
    const before = [...slotsEl.querySelectorAll(".hb-slot")];
    hud.cancelActiveDrag();
    hud.update(mkState());
    const after = [...slotsEl.querySelectorAll(".hb-slot")];
    check("slots re-render after teardown (stale-DOM guard)", after.length === 5 && after[0] !== before[0]);
    check("a fresh drag works after the cancel", (() => {
      const rects = layoutRow(slotsEl, after as HTMLElement[], 1);
      const g = dragTo(after[0] as HTMLElement, rects[0], 10, 10, 480, 380);
      const ok = g !== null && hud.isInteractionActive();
      hud.cancelActiveDrag();
      return ok;
    })());
    hud.clear(); root.remove();
  }
}

function keyboardReorderTests(): void {
  section("keyboard/controller reorder: Shift+arrow moves the slot through the SAME canonical action");
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    slots[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    check("Shift+ArrowRight requests reorder(1, 2)", acts.reorders.length === 1 && acts.reorders[0][0] === 1 && acts.reorders[0][1] === 2, JSON.stringify(acts.reorders));
    slots[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }));
    check("Shift+ArrowLeft at the first slot is a no-op (bounds hold)", acts.reorders.length === 1);
    // The authoritative rebuild (reordered state) restores focus onto the moved slot.
    const reordered = mkState(2, [FIVE[0], FIVE[2], FIVE[1], FIVE[3], FIVE[4]]);
    hud.update(reordered);
    const newSlots = [...slotsEl.querySelectorAll<HTMLElement>(".hb-slot")];
    check("focus follows the moved slot after the authoritative rebuild", document.activeElement === newSlots[2],
      `active=${(document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? "none"}`);
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slots, acts } = rig();
    slots[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    check("plain arrows only walk focus (never reorder)", acts.reorders.length === 0);
    check("plain ArrowRight moves focus to the next slot", document.activeElement === slots[3]);
    slots[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    check("Enter still equips the focused slot", acts.activates.length === 1 && acts.activates[0] === 2);
    hud.clear(); root.remove();
  }
}

function tooltipClampTests(): void {
  section("tooltip viewport clamp: an edge slot's tip shifts inward instead of going off-screen");
  {
    const { hud, root, slotsEl, slots } = rig();
    layoutRow(slotsEl, slots, 1, 4); // row starts almost at the viewport's left edge
    const tip = slots[0].querySelector<HTMLElement>(".tip")!;
    setRect(tip, { left: -20, top: 520, width: 180, height: 60 });
    slots[0].dispatchEvent(new dom.window.MouseEvent("pointerenter", { bubbles: false }));
    check("overflowing tip gets a corrective --tip-shift", tip.style.getPropertyValue("--tip-shift") === "26px",
      tip.style.getPropertyValue("--tip-shift"));
    hud.clear(); root.remove();
  }
}

function main(): void {
  grabPointTests();
  markerAndReorderTests();
  cancelTests();
  keyboardReorderTests();
  tooltipClampTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll hotbar drag assertions passed.\n");
}

main();
