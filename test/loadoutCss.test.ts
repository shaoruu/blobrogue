import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { applyPadAction } from "../src/ui/menuGamepad.js";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const dom = new JSDOM(`
  <style>${css}</style>
  <button class="loadout-next" disabled>NEXT PET</button>
  <button class="loadout-review-next" disabled>NEXT REVIEW</button>
  <button class="loadout-confirm" disabled>
    <span class="loadout-confirm-action">CONFIRM &amp; START SOLO</span>
    <span class="loadout-confirm-loadout" data-short-name="MENDER + DRAGON">MENDER + BABY DRAGON</span>
  </button>
`);

for (const className of ["loadout-next", "loadout-review-next", "loadout-confirm"]) {
  const button = dom.window.document.querySelector<HTMLElement>(`.${className}`);
  if (!button) {
    check(`${className} fixture exists`, false);
    continue;
  }
  const style = dom.window.getComputedStyle(button);
  check(`${className} is native-disabled`, button.matches(":disabled"));
  check(`${className} uses not-allowed cursor`, style.cursor === "not-allowed", style.cursor);
  check(`${className} has zero lift`, style.transform === "none", style.transform);
  check(`${className} uses a dark hatch`, style.backgroundImage.includes("repeating-linear-gradient"), style.backgroundImage);
  check(`${className} is desaturated`, style.filter.includes("saturate"), style.filter);
}

check("disabled hover and active selectors preserve the disabled treatment",
  css.includes(".loadout-next:disabled:hover")
  && css.includes(".loadout-review-next:disabled:hover")
  && css.includes(".loadout-confirm:disabled:hover")
  && css.includes(".loadout-confirm:disabled:active"));
check("final CTA action and loadout are separate spans",
  dom.window.document.querySelectorAll(".loadout-confirm > span").length === 2);
check("responsive shortName rules exist at 560px and 360px",
  css.includes("@media (max-width:560px)")
  && css.includes("content:attr(data-short-name)")
  && css.includes("@media (max-width:360px)"));
check("action text never uses truncation",
  css.includes(".loadout-confirm-action{")
  && css.includes("white-space:nowrap")
  && css.includes("text-overflow:clip"));

Reflect.set(globalThis, "window", dom.window);
Reflect.set(globalThis, "document", dom.window.document);
Reflect.set(globalThis, "HTMLElement", dom.window.HTMLElement);
Reflect.set(globalThis, "HTMLButtonElement", dom.window.HTMLButtonElement);
Reflect.set(globalThis, "matchMedia", () => ({ matches: false }));
const overlay = dom.window.document.createElement("div");
const kitGrid = dom.window.document.createElement("div");
kitGrid.setAttribute("role", "radiogroup");
kitGrid.dataset.desktopColumns = "2";
kitGrid.dataset.mobileColumns = "1";
const kitNames = ["gunner", "mender", "bulwark", "phantom"];
for (const [index, name] of kitNames.entries()) {
  const card = dom.window.document.createElement("button");
  card.setAttribute("role", "radio");
  card.setAttribute("data-kit", name);
  card.tabIndex = index === 0 ? 0 : -1;
  if (name === "bulwark") card.setAttribute("aria-disabled", "true");
  kitGrid.appendChild(card);
}
overlay.appendChild(kitGrid);
dom.window.document.body.appendChild(overlay);
const hooks = { onTab: () => {} };
(kitGrid.children[0] as HTMLElement).focus();
applyPadAction("focusDown", overlay, hooks);
check("gamepad Down follows 2×2 geometry Gunner → locked Bulwark",
  dom.window.document.activeElement?.getAttribute("data-kit") === "bulwark"
  && dom.window.document.activeElement?.getAttribute("aria-disabled") === "true");

const petGrid = dom.window.document.createElement("div");
petGrid.setAttribute("role", "radiogroup");
petGrid.dataset.desktopColumns = "3";
petGrid.dataset.mobileColumns = "2";
for (const [index, name] of ["none", "doggie", "cat", "dragon", "slime"].entries()) {
  const card = dom.window.document.createElement("button");
  card.setAttribute("role", "radio");
  card.setAttribute("data-pet", name);
  card.tabIndex = index === 0 ? 0 : -1;
  petGrid.appendChild(card);
}
overlay.replaceChildren(petGrid);
(petGrid.children[0] as HTMLElement).focus();
applyPadAction("focusDown", overlay, hooks);
check("gamepad Down follows 3×2 geometry No Pet → Baby Dragon",
  dom.window.document.activeElement?.getAttribute("data-pet") === "dragon");

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
