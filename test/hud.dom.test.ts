// HUD DOM suite: the hotbar chrome rendered into a real (jsdom) document. Asserts the
// weapon slots keep their labeled, keyboard-accessible shape (key badge + name + button
// semantics), and the blessing row is compact ICON-ONLY slots — tint border, Lv1-3 pips,
// no long chip text in the row — with the full name / current effect / exact next-level
// delta living in the hover-focus tooltip and the aria-label.
//
// Run: npm run test:hud

import { JSDOM, VirtualConsole } from "jsdom";

// jsdom lacks a canvas backend; a silent virtual console swallows its "getContext not
// implemented" notices (pxIcon already tolerates a null context).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
});

const { Hud, buildSlot, buildBuffChip } = await import("../src/game/hud.js");
type HudModule = typeof import("../src/game/hud.js");
type HudState = Parameters<InstanceType<HudModule["Hud"]>["update"]>[0];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function mkState(over: Partial<HudState> = {}): HudState {
  return {
    hp: 5, maxHp: 6, floor: 2, kills: 7, coins: 30,
    weapons: [
      { id: "pistol", name: "Pistol", isCurrent: false },
      { id: "shotgun", name: "Shotgun", isCurrent: true },
      { id: "tesla", name: "Tesla", isCurrent: false },
    ],
    isCleared: false, enemiesLeft: 3, isBossActive: false, bossHpFrac: 0,
    coopLabel: null, dashFill: 1,
    combo: 0, comboMult: 1, comboColor: "#fff", comboFrac: 0,
    items: [],
    ...over,
  };
}

const ITEM_LV2 = {
  id: "it_dmg", name: "Sharpened Fangs", desc: "+85% damage, but -2 max hearts.",
  nextDesc: "+100% damage, but -2 max hearts.", glyph: "!", tint: "#ff5a5a", rarity: "rare", count: 2,
};
const ITEM_MAX = {
  id: "it_speed", name: "Swift Boots", desc: "+35% move speed.",
  nextDesc: null, glyph: ">", tint: "#5ab6ff", rarity: "common", count: 3,
};

function weaponSlotTests(): void {
  section("weapon slots keep their labeled, accessible shape");
  const slot = buildSlot({ id: "shotgun", name: "Shotgun", isCurrent: true }, 1);
  check("slot keeps its select-key badge", slot.querySelector(".hb-key")?.textContent === "2");
  check("slot keeps its weapon-name label", slot.querySelector(".hb-name")?.textContent === "SHOTGUN");
  check("slot is a tabbable button", slot.tabIndex === 0 && slot.getAttribute("role") === "button");
  check("slot aria-label names weapon + slot + equipped state", slot.getAttribute("aria-label") === "Shotgun, slot 2, equipped");
  check("equipped slot is lit", slot.classList.contains("on"));
  const tenth = buildSlot({ id: "tesla", name: "Tesla", isCurrent: false }, 9);
  check("slots past 9 carry no key badge", tenth.querySelector(".hb-key") === null);
}

function buffChipTests(): void {
  section("blessing slots are ICON-ONLY: tint border, Lv pips, zero row text");
  const chip = buildBuffChip(ITEM_LV2);
  check("legacy name/level text nodes are gone", chip.querySelector(".bn") === null && chip.querySelector(".bl") === null);
  const rowText = [...chip.childNodes]
    .filter((n) => !(n instanceof dom.window.HTMLElement && (n.classList.contains("tip") || n.classList.contains("pips"))))
    .map((n) => n.textContent).join("").trim();
  check("no visible text in the chip row (icon only)", rowText === "", `text="${rowText}"`);
  check("tint border variable set from the blessing", chip.style.getPropertyValue("--t") === "#ff5a5a");
  check("rare blessing keeps its rare glow class", chip.classList.contains("rare"));
  check("icon element present", chip.querySelector("img, .glyphfb") !== null);

  section("level pips: one per possible level, lit up to the current level");
  const pips = [...chip.querySelectorAll(".pips .pip")];
  check("exactly three pips", pips.length === 3);
  check("Lv2 lights exactly two pips", pips.filter((p) => p.classList.contains("lit")).length === 2);
  check("pips light in order", pips[0].classList.contains("lit") && pips[1].classList.contains("lit") && !pips[2].classList.contains("lit"));
  const maxPips = [...buildBuffChip(ITEM_MAX).querySelectorAll(".pips .pip.lit")];
  check("Lv3 lights all three pips", maxPips.length === 3);

  section("tooltip: full name + current effect + exact next-level delta");
  check("tooltip names the blessing", chip.querySelector(".tip .tn")?.textContent === "SHARPENED FANGS");
  check("tooltip carries the current level's effect", chip.querySelector(".tip .tc")?.textContent === "LV2 — +85% damage, but -2 max hearts.");
  check("tooltip carries the exact next-level delta", chip.querySelector(".tip .tx")?.textContent === "NEXT LV3 — +100% damage, but -2 max hearts.");
  const maxChip = buildBuffChip(ITEM_MAX);
  check("maxed blessing shows MAX LEVEL instead of a delta", maxChip.querySelector(".tip .tx")?.textContent === "MAX LEVEL" && maxChip.querySelector(".tip .tx.max") !== null);

  section("accessibility: focusable with a complete aria-label");
  check("chip is tabbable", chip.tabIndex === 0);
  check("aria-label = name + level + effect + next delta",
    chip.getAttribute("aria-label") === "Sharpened Fangs, level 2: +85% damage, but -2 max hearts. Next level: +100% damage, but -2 max hearts.");
  check("maxed aria-label omits the next-level clause",
    buildBuffChip(ITEM_MAX).getAttribute("aria-label") === "Swift Boots, level 3: +35% move speed.");
}

function hudIntegrationTests(): void {
  section("Hud.update wires slots + blessing row + hint into the live DOM");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  hud.update(mkState());
  check("one labeled slot per owned weapon", root.querySelectorAll(".hb-slots .hb-slot").length === 3);
  check("slot order follows inventory order", [...root.querySelectorAll(".hb-slot .hb-name")].map((n) => n.textContent).join(",") === "PISTOL,SHOTGUN,TESLA");
  check("blessing row hidden while empty", !root.querySelector(".hb-buffs")!.classList.contains("show"));
  check("interaction hint shown with 2+ weapons", root.querySelector("[data-hb-hint]")!.classList.contains("show"));

  hud.update(mkState({ items: [ITEM_LV2, ITEM_MAX] }));
  check("blessing row appears with picks", root.querySelector(".hb-buffs")!.classList.contains("show"));
  check("one icon slot per distinct blessing", root.querySelectorAll(".hb-buffs .hb-buff").length === 2);

  // A reorder (same set, new order) rebuilds the slots to match.
  hud.update(mkState({
    weapons: [
      { id: "tesla", name: "Tesla", isCurrent: false },
      { id: "pistol", name: "Pistol", isCurrent: false },
      { id: "shotgun", name: "Shotgun", isCurrent: true },
    ],
    items: [ITEM_LV2, ITEM_MAX],
  }));
  check("reordered inventory re-renders in the new order", [...root.querySelectorAll(".hb-slot .hb-name")].map((n) => n.textContent).join(",") === "TESLA,PISTOL,SHOTGUN");
  check("key badges remap to the new positions", [...root.querySelectorAll(".hb-slot .hb-key")].map((n) => n.textContent).join(",") === "1,2,3");
  check("equipped highlight follows the weapon id", root.querySelectorAll(".hb-slot")[2].classList.contains("on"));
}

function main(): void {
  weaponSlotTests();
  buffChipTests();
  hudIntegrationTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll HUD DOM assertions passed.\n");
}

main();
