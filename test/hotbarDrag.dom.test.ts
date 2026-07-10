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

const { Hud, TIP_SHOW_DELAY_MS, TIP_HIDE_DELAY_MS, LONG_PRESS_MS } = await import("../src/game/hud.js");
const { createMods } = await import("../src/sim/items.js");
const { weaponDisplayStats } = await import("../src/sim/weaponStats.js");
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
    hp: 5, maxHp: 6, floor: 2, kills: 7, coins: 30, mutators: [],
    weapons: ids.map((w, i) => ({ ...w, isCurrent: i === currentIndex, card: weaponDisplayStats(w.id, createMods(), 0) })),
    swap: null,
    isCleared: false, enemiesLeft: 3, isObjectiveHidden: false, isParty: false, isBossActive: false, bossHpFrac: 0, bossName: "",
    coopLabel: null, waitLabel: null, dashFill: 1,
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

type Actions = { activates: number[]; reorders: [number, number][]; inspects: number[]; drops: number[] };

function rig(currentIndex = 1, ids = FIVE): { hud: InstanceType<HudModule["Hud"]>; root: HTMLElement; slotsEl: HTMLElement; slots: HTMLElement[]; tipEl: HTMLElement; acts: Actions } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const acts: Actions = { activates: [], reorders: [], inspects: [], drops: [] };
  hud.setHotbarActions({
    onSlotActivate: (i) => acts.activates.push(i),
    onSlotReorder: (from, to) => acts.reorders.push([from, to]),
    onSlotInspect: (i) => acts.inspects.push(i),
    onSlotSwap: () => {},
    onSlotDrop: (i) => acts.drops.push(i),
    onSwapDismiss: () => {},
  });
  hud.update(mkState(currentIndex, ids));
  const slotsEl = root.querySelector<HTMLElement>("[data-hb-slots]")!;
  const slots = [...slotsEl.querySelectorAll<HTMLElement>(".hb-slot")];
  const tipEl = root.querySelector<HTMLElement>("#hb-tip")!;
  return { hud, root, slotsEl, slots, tipEl, acts };
}

function tipShown(tipEl: HTMLElement): boolean {
  return tipEl.classList.contains("show") && tipEl.getAttribute("aria-hidden") === "false";
}

function enter(slot: HTMLElement): void {
  slot.dispatchEvent(new dom.window.MouseEvent("pointerenter", { bubbles: false }));
}
function leave(slot: HTMLElement): void {
  slot.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false }));
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Hover and wait out the 120ms show debounce.
async function hoverShow(slot: HTMLElement): Promise<void> {
  enter(slot);
  await wait(TIP_SHOW_DELAY_MS + 40);
}
// Leave and wait out the 80ms hide grace.
async function leaveSettle(slot: HTMLElement): Promise<void> {
  leave(slot);
  await wait(TIP_HIDE_DELAY_MS + 40);
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

async function grabPointTests(): Promise<void> {
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
    const { hud, root, slotsEl, slots, tipEl } = rig();
    const r = layoutRow(slotsEl, slots, 1)[1];
    await hoverShow(slots[1]); // hover tooltip up before the press
    check("hover shows the floating tooltip before the drag", tipShown(tipEl));
    // Cross the threshold with the FIRST move event: beginDragVisuals runs, then moveGhost
    // repositions in the same handler — but the initial style must start offscreen.
    slots[1].dispatchEvent(ptr("pointerdown", r.left + 5, r.top + 5));
    check("no ghost before the threshold", ghostEl() === null);
    slots[1].dispatchEvent(ptr("pointermove", r.left + 5 + 4, r.top + 5)); // 4px < threshold
    check("a 4px wiggle never starts a drag", ghostEl() === null);
    slots[1].dispatchEvent(ptr("pointermove", r.left + 40, r.top + 10)); // past threshold, still INSIDE the row
    const ghost = ghostEl()!;
    check("ghost has transition disabled (never lags the pointer)", ghost.style.transition === "none");
    check("ghost carries no tooltip", ghost.querySelector(".hb-tip, .tip") === null);
    check("ghost names its verb: a MOVE tag (grayscale-distinct from a real slot)",
      ghost.querySelector(".hb-move")?.textContent === "MOVE");
    check("equipped-slot transform is overridden by the inline positioner", ghost.style.transform.startsWith("translate3d("));
    check("the tooltip dropped when the drag began", !tipShown(tipEl));
    enter(slots[2]);
    check("hovering mid-drag never resurfaces the tooltip", !tipShown(tipEl));
    hud.clear(); root.remove();
  }

  section("P0: pressing hides the tooltip IMMEDIATELY (action outranks inspection)");
  {
    const { hud, root, slotsEl, slots, tipEl } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    await hoverShow(slots[2]);
    check("tooltip up on hover", tipShown(tipEl));
    slots[2].dispatchEvent(ptr("pointerdown", rects[2].left + 10, rects[2].top + 10));
    check("pointerdown alone drops the tooltip (before any movement)", !tipShown(tipEl));
    slots[2].dispatchEvent(ptr("pointerup", rects[2].left + 10, rects[2].top + 10));
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

function discardTests(): void {
  section("drag-out-to-discard: the ghost flips MOVE <-> DROP across the discard band");
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    // Start a reorder INSIDE the row: MOVE tag, insertion bar visible, a drop-target ring.
    dragTo(slots[0], rects[0], 20, 20, rects[2].left + rects[2].width * 0.2, rects[2].top + 10);
    const ghost = ghostEl()!;
    const marker = slotsEl.querySelector<HTMLElement>(".hb-ins")!;
    check("inside the row the ghost reads MOVE", ghost.querySelector(".hb-move")?.textContent === "MOVE" && !ghost.classList.contains("discard"));
    check("inside the row the insertion bar shows", marker.style.display !== "none");
    check("inside the row a slot wears the drop-target ring", slotsEl.querySelector(".hb-slot.drop-target") !== null);
    // Cross OUT into the discard band: DROP read, no bar, no highlight.
    slots[0].dispatchEvent(ptr("pointermove", 30, 80));
    check("in the discard band the ghost flips to a red DROP read",
      ghost.classList.contains("discard") && ghost.querySelector(".hb-move")?.textContent === "DROP");
    check("in the discard band the insertion bar is hidden", marker.style.display === "none");
    check("in the discard band no slot wears the drop-target ring", slotsEl.querySelector(".hb-slot.drop-target") === null);
    // Cross BACK inside: revert to MOVE + reorder feedback.
    slots[0].dispatchEvent(ptr("pointermove", rects[3].left + rects[3].width * 0.2, rects[3].top + 10));
    check("crossing back reverts the ghost to MOVE",
      !ghost.classList.contains("discard") && ghost.querySelector(".hb-move")?.textContent === "MOVE");
    check("crossing back restores the insertion bar + drop-target",
      marker.style.display !== "none" && slotsEl.querySelector(".hb-slot.drop-target") !== null);
    slots[0].dispatchEvent(ptr("pointerup", rects[3].left + rects[3].width * 0.2, rects[3].top + 10));
    check("a release back inside reorders (never drops)", acts.drops.length === 0 && acts.reorders.length === 1);
    hud.clear(); root.remove();
  }

  section("drag-out-to-discard: the LAST remaining weapon can never be dropped");
  {
    const { hud, root, slotsEl, slots, acts } = rig(0, [FIVE[0]]); // one weapon owned
    const rects = layoutRow(slotsEl, slots, 1);
    dragTo(slots[0], rects[0], 20, 20, 30, 80); // straight out into the discard band
    const ghost = ghostEl()!;
    check("the ghost warns CAN'T DROP LAST", ghost.classList.contains("cant") && ghost.querySelector(".hb-move")?.textContent === "CAN'T DROP LAST");
    slots[0].dispatchEvent(ptr("pointerup", 30, 80));
    check("releasing the last weapon outside cancels — nothing dropped", acts.drops.length === 0 && acts.reorders.length === 0);
    hud.clear(); root.remove();
  }

  section("nearest-slot snap: the drop-target is the nearest slot, before/after by its half");
  {
    const { hud, root, slotsEl, slots } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    // Pointer in the LEFT half of slot 3 -> target slot 3, insert BEFORE it.
    dragTo(slots[0], rects[0], 20, 20, rects[3].left + rects[3].width * 0.2, rects[3].top + 10);
    const target = slotsEl.querySelector<HTMLElement>(".hb-slot.drop-target")!;
    check("left half snaps the ring onto the nearest slot, nudged 'before'",
      target === slots[3] && target.classList.contains("nudge-before"));
    // Pointer in the RIGHT half of slot 3 -> still slot 3, insert AFTER it.
    slots[0].dispatchEvent(ptr("pointermove", rects[3].left + rects[3].width * 0.85, rects[3].top + 10));
    const t2 = slotsEl.querySelector<HTMLElement>(".hb-slot.drop-target")!;
    check("right half keeps the same nearest slot, nudged 'after'",
      t2 === slots[3] && t2.classList.contains("nudge-after"));
    hud.clear(); root.remove();
  }
}

async function cancelTests(): Promise<void> {
  const begin = (currentIndex = 1) => {
    const r = rig(currentIndex);
    const rects = layoutRow(r.slotsEl, r.slots, 1);
    dragTo(r.slots[0], rects[0], 20, 20, 450, 380);
    return { ...r, rects };
  };

  section("cancel: Escape (via Hud.cancelActiveDrag) aborts without committing");
  {
    const { hud, root, slotsEl, slots, tipEl, acts, rects } = begin();
    check("drag is live (owns the input context)", hud.isInteractionActive());
    check("cancelActiveDrag reports the live drag", hud.cancelActiveDrag() === true);
    check("ghost + marker removed", ghostEl() === null && slotsEl.querySelector(".hb-ins") === null);
    check("input context released", !hud.isInteractionActive());
    await hoverShow(slots[1]);
    check("tooltips work again after the cancel", tipShown(tipEl));
    await leaveSettle(slots[1]);
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

  section("discard: release far outside the hotbar DROPS the dragged weapon (>1 owned)");
  {
    const { hud, root, slots, acts } = begin();
    slots[0].dispatchEvent(ptr("pointermove", 30, 80)); // into the discard band first
    slots[0].dispatchEvent(ptr("pointerup", 30, 80)); // way above/left of the row
    check("outside release drops the dragged slot, never reorders/equips",
      acts.drops.length === 1 && acts.drops[0] === 0 && acts.reorders.length === 0 && acts.activates.length === 0,
      JSON.stringify(acts.drops));
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

// Give the singleton tooltip a measurable box: viewport rect (w×h) + its unzoomed CSS
// width (offsetWidth), so positionTip's scale math is exercised exactly.
function sizeTip(tipEl: HTMLElement, w: number, h: number, cssWidth = w): void {
  setRect(tipEl, { left: 0, top: 0, width: w, height: h }, cssWidth);
}

async function tooltipClampTests(): Promise<void> {
  section("floating tooltip anchoring: centered ~10px above the slot, 12px viewport clamps");
  {
    const { hud, root, slotsEl, slots, tipEl } = rig();
    const rects = layoutRow(slotsEl, slots, 1); // slot 0: left 300, top 600, w 66
    sizeTip(tipEl, 200, 90);
    await hoverShow(slots[0]);
    check("anchored centered above the slot with a 10px gap",
      tipEl.style.left === `${Math.round(rects[0].left + 33 - 100)}px` && tipEl.style.top === `${600 - 10 - 90}px`,
      `left=${tipEl.style.left} top=${tipEl.style.top}`);
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slotsEl, slots, tipEl } = rig();
    layoutRow(slotsEl, slots, 1, 4); // row hugs the viewport's left edge
    sizeTip(tipEl, 200, 90);
    await hoverShow(slots[0]); // desired left would be 4+33-100 = -63
    check("left edge clamps to the 12px viewport margin", tipEl.style.left === "12px", tipEl.style.left);
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slotsEl, slots, tipEl } = rig();
    const rects = layoutRow(slotsEl, slots, 1, dom.window.innerWidth - 360); // row hugs the right edge
    sizeTip(tipEl, 200, 90);
    await hoverShow(slots[4]);
    const desired = rects[4].left + rects[4].width / 2 - 100;
    const max = dom.window.innerWidth - 12 - 200;
    check("right edge clamps to the 12px viewport margin",
      desired > max && tipEl.style.left === `${max}px`, `desired=${desired} left=${tipEl.style.left}`);
    hud.clear(); root.remove();
  }
  {
    // 200% ui-scale: the tooltip element itself is zoomed, so the measured viewport
    // position divides back into its own coordinate space (rect w 200 vs CSS width 100).
    const { hud, root, slotsEl, slots, tipEl } = rig();
    const rects = layoutRow(slotsEl, slots, 2);
    sizeTip(tipEl, 200, 90, 100);
    await hoverShow(slots[0]);
    const wantLeft = Math.round((rects[0].left + rects[0].width / 2 - 100) / 2);
    const wantTop = Math.round((rects[0].top - 10 - 90) / 2);
    check("200% zoom divides the anchored position into zoomed px",
      tipEl.style.left === `${wantLeft}px` && tipEl.style.top === `${wantTop}px`,
      `left=${tipEl.style.left} top=${tipEl.style.top}`);
    hud.clear(); root.remove();
  }
  {
    // Tiny viewport: no vertical room above the bar -> the floating tip does NOT render
    // (it must never cover the bar or gameplay); the tap/long-press drawer is the info
    // surface there.
    const { hud, root, slotsEl, slots, tipEl } = rig();
    layoutRow(slotsEl, slots, 1, 300, 40); // slots at y=40, tip is 90 tall — cannot fit above
    sizeTip(tipEl, 200, 90);
    await hoverShow(slots[0]);
    check("no vertical room = the tooltip stays down (drawer is the fallback surface)", !tipShown(tipEl));
    hud.clear(); root.remove();
  }
}

async function qaGateTests(): Promise<void> {
  section("QA gate: ONE floating tooltip across input modes — identical content, no duplicate");
  {
    const { hud, root, slots, tipEl } = rig();
    await hoverShow(slots[0]);
    check("hover shows the hovered weapon", tipShown(tipEl) && tipEl.querySelector(".tn")?.textContent === "PISTOL");
    const hoverHTML = tipEl.innerHTML;
    await leaveSettle(slots[0]);
    slots[0].focus();
    check("keyboard focus shows IDENTICAL content for the same slot", tipShown(tipEl) && tipEl.innerHTML === hoverHTML);
    check("focus links the tooltip accessibly (aria-describedby)", slots[0].getAttribute("aria-describedby") === "hb-tip");
    slots[3].focus();
    check("focus moving re-points the ONE tooltip (no stale duplicate)",
      tipEl.querySelector(".tn")?.textContent === "CUTLASS" && root.querySelectorAll(".hb-tip").length === 1
      && slots[0].getAttribute("aria-describedby") === null && slots[3].getAttribute("aria-describedby") === "hb-tip");
    enter(slots[2]); // tip already up: pointer retargets instantly, no debounce
    check("pointer takeover swaps the same element's content", tipEl.querySelector(".tn")?.textContent === "TESLA");
    await leaveSettle(slots[2]);
    check("pointer leaving falls back to the still-focused slot's card", tipShown(tipEl) && tipEl.querySelector(".tn")?.textContent === "CUTLASS");
    slots[3].blur();
    check("blur with no hover hides the tooltip (aria-hidden)", !tipShown(tipEl) && tipEl.getAttribute("aria-hidden") === "true");
    hud.clear(); root.remove();
  }

  section("QA gate: Escape dismisses the focused tooltip and never leaks to pause");
  {
    const { hud, root, slots, tipEl, acts } = rig();
    slots[2].focus();
    check("focus shows the tooltip", document.activeElement === slots[2] && tipShown(tipEl));
    const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    let reachedWindow = false;
    const windowSpy = () => { reachedWindow = true; };
    dom.window.addEventListener("keydown", windowSpy);
    slots[2].dispatchEvent(esc);
    dom.window.removeEventListener("keydown", windowSpy);
    check("Escape blurs the slot and hides the tooltip", document.activeElement !== slots[2] && !tipShown(tipEl));
    check("Escape was swallowed at the slot (no pause fall-through)", esc.defaultPrevented && !reachedWindow);
    check("Escape triggered no hotbar action", acts.activates.length === 0 && acts.reorders.length === 0);
    hud.clear(); root.remove();
  }

  section("QA gate: hidden with the hotbar, never orphaned or stale through churn");
  {
    const { hud, root, slots, tipEl } = rig();
    check("exactly one root-level tooltip, outside #hud clipping",
      root.querySelectorAll(".hb-tip").length === 1 && tipEl.parentElement === root && root.querySelector("#hud .hb-tip") === null);
    await hoverShow(slots[0]);
    check("tooltip up", tipShown(tipEl));
    hud.setVisible(false);
    check("hiding the hotbar hides the tooltip with it", !tipShown(tipEl));
    hud.setVisible(true);
    await hoverShow(root.querySelector<HTMLElement>(".hb-slot")!);
    check("tooltip shows pistol again", tipShown(tipEl) && tipEl.querySelector(".tn")?.textContent === "PISTOL");
    hud.update(mkState(0, FIVE.slice(1))); // the pistol vanished; a different weapon now sits at index 0
    check("churn that replaces the anchored weapon HIDES the tooltip (never a stale card)", !tipShown(tipEl));
    hud.clear(); root.remove();
  }

  section("QA gate: live values re-render under the cursor; rapid cycling leaks nothing");
  {
    const { hud, root, slotsEl, slots, tipEl } = rig();
    await hoverShow(slots[0]);
    check("baseline pistol POWER 2", tipEl.querySelector(".tv")?.textContent === "2");
    const mods = createMods();
    mods.damageMult = 2;
    hud.update({ ...mkState(), weapons: FIVE.map((w, i) => ({ ...w, isCurrent: i === 1, card: weaponDisplayStats(w.id, mods, 0) })) });
    check("a mod change re-renders the SHOWING tooltip live (same weapon, fresh values)",
      tipShown(tipEl) && tipEl.querySelector(".tv")?.textContent === "4", tipEl.querySelector(".tv")?.textContent ?? "");

    // Rapid equip/pickup cycling: no window/document listener growth, no DOM growth.
    let winAdds = 0, docAdds = 0;
    const winOrig = dom.window.addEventListener.bind(dom.window);
    const docOrig = document.addEventListener.bind(document);
    (dom.window as unknown as { addEventListener: typeof winOrig }).addEventListener = ((...a: Parameters<typeof winOrig>) => { winAdds++; winOrig(...a); }) as typeof winOrig;
    (document as unknown as { addEventListener: typeof docOrig }).addEventListener = ((...a: Parameters<typeof docOrig>) => { docAdds++; docOrig(...a); }) as typeof docOrig;
    for (let i = 0; i < 60; i++) {
      hud.update(mkState(i % 2 === 0 ? 0 : 1, i % 3 === 0 ? FIVE.slice(1) : FIVE));
      const cur = [...slotsEl.querySelectorAll<HTMLElement>(".hb-slot")];
      if (cur[0]) enter(cur[0]);
      cur[1]?.focus();
      if (cur[0]) leave(cur[0]);
    }
    (dom.window as unknown as { addEventListener: typeof winOrig }).addEventListener = winOrig;
    (document as unknown as { addEventListener: typeof docOrig }).addEventListener = docOrig;
    check("60 rebuild/hover/focus cycles add ZERO window/document listeners", winAdds === 0 && docAdds === 0, `win=${winAdds} doc=${docAdds}`);
    check("DOM stays exactly one slot set + one tooltip (no accumulation)",
      slotsEl.querySelectorAll(".hb-slot").length === 5 && root.querySelectorAll(".hb-tip").length === 1);
    check("no stray ghost after the churn", ghostEl() === null);
    hud.clear(); root.remove();
  }
}

async function tipTimingTests(): Promise<void> {
  section("tooltip timing: 120ms show / 80ms hide debounce with cancellation, focus immediate");
  {
    const { hud, root, slots, tipEl } = rig();
    enter(slots[0]);
    check("no tip synchronously on enter", !tipShown(tipEl));
    await wait(50);
    check("still down before the 120ms debounce", !tipShown(tipEl));
    leave(slots[0]);
    await wait(TIP_SHOW_DELAY_MS + 80);
    check("a pass-over (leave before 120ms) NEVER flashes a tip", !tipShown(tipEl));

    await hoverShow(slots[0]);
    check("a settled hover shows after 120ms", tipShown(tipEl));
    leave(slots[0]);
    check("leaving keeps the tip for the 80ms grace (no flicker)", tipShown(tipEl));
    await wait(30);
    enter(slots[0]); // back within 80ms
    await wait(TIP_HIDE_DELAY_MS + 40);
    check("re-entering within 80ms cancels the hide", tipShown(tipEl));

    enter(slots[2]); // already shown: crossing to a neighbor retargets instantly
    check("slot-to-slot movement retargets instantly while shown", tipShown(tipEl) && tipEl.querySelector(".tn")?.textContent === "TESLA");
    await leaveSettle(slots[2]);
    check("tip hides 80ms after the pointer leaves for good", !tipShown(tipEl));

    slots[1].focus();
    check("keyboard focus shows immediately (no debounce)", tipShown(tipEl) && tipEl.querySelector(".tn")?.textContent === "SHOTGUN");
    slots[1].blur();
    hud.clear(); root.remove();
  }

  section("weapon switching (1-9 / wheel / Q / gamepad) shows NO stat card (hover/focus only)");
  {
    const { hud, root, tipEl } = rig(0); // pistol equipped
    check("no card on the first render", !tipShown(tipEl));
    hud.update(mkState(1)); // cycled to the shotgun, no hover/focus anywhere
    check("switching weapons flashes no card", !tipShown(tipEl));
    hud.update(mkState(2)); // cycled again
    check("cycling again still shows no card", !tipShown(tipEl));
    hud.clear(); root.remove();
  }
}

async function longPressTests(): Promise<void> {
  section(`touch long-press (${LONG_PRESS_MS}ms): inspect drawer without equipping`);
  const touchPtr = (type: string, x: number, y: number) => {
    const e = ptr(type, x, y);
    Object.defineProperty(e, "pointerType", { value: "touch" });
    return e;
  };
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    slots[3].dispatchEvent(touchPtr("pointerdown", rects[3].left + 10, rects[3].top + 10));
    await wait(LONG_PRESS_MS + 60);
    check("a still 350ms touch press requests the inspect", acts.inspects.length === 1 && acts.inspects[0] === 3, JSON.stringify(acts.inspects));
    check("the press state tore down (no drag, no context)", !hud.isInteractionActive());
    slots[3].dispatchEvent(touchPtr("pointerup", rects[3].left + 10, rects[3].top + 10));
    check("the release after an inspect NEVER equips", acts.activates.length === 0);
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    slots[0].dispatchEvent(touchPtr("pointerdown", rects[0].left + 20, rects[0].top + 20));
    slots[0].dispatchEvent(touchPtr("pointermove", rects[0].left + 40, rects[0].top + 20)); // real drag motion
    await wait(LONG_PRESS_MS + 60);
    check("drag motion cancels the pending long-press", acts.inspects.length === 0);
    check("the drag itself is live instead", hud.isInteractionActive() && ghostEl() !== null);
    slots[0].dispatchEvent(touchPtr("pointerup", rects[0].left + 40, rects[0].top + 20));
    hud.clear(); root.remove();
  }
  {
    const { hud, root, slotsEl, slots, acts } = rig();
    const rects = layoutRow(slotsEl, slots, 1);
    slots[2].dispatchEvent(ptr("pointerdown", rects[2].left + 10, rects[2].top + 10)); // mouse, not touch
    await wait(LONG_PRESS_MS + 60);
    check("a held MOUSE press never long-presses", acts.inspects.length === 0);
    slots[2].dispatchEvent(ptr("pointerup", rects[2].left + 10, rects[2].top + 10));
    check("the mouse release still click-equips", acts.activates.length === 1 && acts.activates[0] === 2);
    hud.clear(); root.remove();
  }
}

async function main(): Promise<void> {
  await grabPointTests();
  markerAndReorderTests();
  discardTests();
  await cancelTests();
  keyboardReorderTests();
  await tooltipClampTests();
  await tipTimingTests();
  await longPressTests();
  await qaGateTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll hotbar drag assertions passed.\n");
}

await main();
