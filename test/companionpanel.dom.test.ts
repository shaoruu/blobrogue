// Companion panel DOM suite, pinned to the UI Director gate: the shippable profile/lobby
// picker that later mounts inside the Amber Camp station unchanged (host-agnostic adapter).
// Locks: the "CHOOSE A COMPANION" header, one 64px preview canvas per roster pet, name +
// behavior + EXACT bounded stats (numbers straight from PET_BALANCE — power never hidden in
// flavor) on unlocked cards, silhouette-with-one-clue on locked cards (no stats leak),
// Equip/Equipped/Locked button states with aria labels (controller/mobile targets), the
// never-block-shots-or-loot promise, guest lockout, equip/unequip intents through the host,
// and refresh() reflecting new unlocks.
//
// Run: npm run test:petpanel

import { JSDOM, VirtualConsole } from "jsdom";

// jsdom lacks a canvas backend and (without pretendToBeVisual) requestAnimationFrame; the
// panel skips its idle animation in both cases and stays fully functional statically.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
});

const { createCompanionPanel } = await import("../src/ui/companionPanel.js");
const { PETS, PET_KINDS, PET_BALANCE, petStats } = await import("../src/sim/pets.js");
type PetKind = (typeof PET_KINDS)[number];
type PanelState = { isAccount: boolean; unlockedPets: readonly PetKind[]; activePet: PetKind | null };

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function mountPanel(initial: PanelState) {
  const state: PanelState = { ...initial };
  const equips: Array<PetKind | null> = [];
  const panel = createCompanionPanel({
    getState: () => ({ ...state }),
    equip: (pet) => {
      equips.push(pet);
      state.activePet = pet;
      return Promise.resolve();
    },
  });
  document.body.appendChild(panel.root);
  return { panel, state, equips };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const cardOf = (root: HTMLElement, kind: PetKind): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>(".pet-card")][PET_KINDS.indexOf(kind)];

{
  section("director copy + structure (guest view: everything locked, nothing leaks)");
  const { panel } = mountPanel({ isAccount: false, unlockedPets: [], activePet: null });
  const root = panel.root;
  check("header reads CHOOSE A COMPANION", root.querySelector(".pets-title")?.textContent === "CHOOSE A COMPANION");
  check("the readability promise is stated in plain words",
    (root.querySelector(".pets-foot")?.textContent ?? "").includes("never block your shots or your loot"));
  check("the bounded-power cap is stated as a number, not flavor",
    (root.querySelector(".pets-foot")?.textContent ?? "").includes("10% of your damage"));
  const cards = root.querySelectorAll(".pet-card");
  check("one card per roster pet", cards.length === PET_KINDS.length);
  check("every card carries a 64px preview canvas",
    [...root.querySelectorAll<HTMLCanvasElement>(".pet-preview")].every((c) => c.width === 64 && c.height === 64)
    && root.querySelectorAll(".pet-preview").length === PET_KINDS.length);
  check("guest cards are all locked silhouettes", root.querySelectorAll(".pet-card.locked").length === PET_KINDS.length);
  const pupCard = cardOf(root, "ember_pup");
  check("a locked card shows exactly ONE clue — its milestone",
    pupCard.querySelector(".pet-clue")?.textContent === PETS.ember_pup.requirement.label
    && pupCard.querySelectorAll(".pet-clue").length === 1);
  check("a locked card leaks no stats or behavior copy",
    pupCard.querySelector(".pet-exact") === null && pupCard.querySelector(".pet-behavior") === null);
  const btn = pupCard.querySelector<HTMLButtonElement>(".pet-equip");
  check("locked button is disabled and labeled for assistive tech",
    btn?.disabled === true && btn.textContent === "LOCKED" && (btn.getAttribute("aria-label") ?? "").includes(PETS.ember_pup.requirement.label));
  panel.destroy();
  root.remove();
}

{
  section("guest equip intents are refused with the sign-in nudge (never a host call)");
  const { panel, equips } = mountPanel({ isAccount: false, unlockedPets: [], activePet: null });
  cardOf(panel.root, "ember_pup").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  check("no equip intent left the panel", equips.length === 0);
  check("the nudge names the fix", (panel.root.querySelector(".pet-note")?.textContent ?? "").includes("sign in"));
  panel.destroy();
  panel.root.remove();
}

{
  section("unlocked cards: name/behavior + exact bounded stats; Equip / Equipped flow");
  const { panel, equips } = mountPanel({ isAccount: true, unlockedPets: ["ember_pup", "lantern_wisp"], activePet: "lantern_wisp" });
  const root = panel.root;
  check("roster progress is counted", root.querySelector(".pets-count")?.textContent === `2/${PET_KINDS.length} unlocked`);

  const pup = cardOf(root, "ember_pup");
  check("unlocked card names the pet + behavior", pup.querySelector(".pet-name")?.textContent === "Ember Pup"
    && pup.querySelector(".pet-behavior")?.textContent === PETS.ember_pup.role);
  const [statA, statB] = petStats("ember_pup");
  const exact = pup.querySelector(".pet-exact")?.textContent ?? "";
  check("exact stats come straight from PET_BALANCE", exact.includes(statA) && exact.includes(statB));
  check("the stat line carries real numbers (cadence + reach)",
    exact.includes(`every ${PET_BALANCE.ember_pup.nipCd}s`) && exact.includes(`${PET_BALANCE.ember_pup.engageRange}px`));

  const wispBtn = cardOf(root, "lantern_wisp").querySelector<HTMLButtonElement>(".pet-equip");
  const pupBtn = pup.querySelector<HTMLButtonElement>(".pet-equip");
  check("the equipped pet reads EQUIPPED; an unlocked one reads EQUIP",
    wispBtn?.textContent === "EQUIPPED" && pupBtn?.textContent === "EQUIP");
  check("bonebird stays a locked silhouette with its one clue",
    cardOf(root, "bonebird").classList.contains("locked")
    && cardOf(root, "bonebird").querySelector(".pet-clue")?.textContent === PETS.bonebird.requirement.label);

  pupBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  check("clicking EQUIP sends the equip intent", equips.length === 1 && equips[0] === "ember_pup");
  const pupBtn2 = cardOf(root, "ember_pup").querySelector<HTMLButtonElement>(".pet-equip");
  check("the panel re-rendered to EQUIPPED", pupBtn2?.textContent === "EQUIPPED" && cardOf(root, "ember_pup").classList.contains("sel"));
  pupBtn2!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  check("clicking EQUIPPED dismisses (equip null)", equips.length === 2 && equips[1] === null);
  panel.destroy();
  root.remove();
}

{
  section("controller/mobile targets + refresh() reflects fresh unlocks");
  const state: PanelState = { isAccount: true, unlockedPets: ["ember_pup"], activePet: null };
  const equips: Array<PetKind | null> = [];
  const panel = createCompanionPanel({
    getState: () => ({ ...state }),
    equip: (pet) => { equips.push(pet); state.activePet = pet; return Promise.resolve(); },
  });
  document.body.appendChild(panel.root);
  // The WHOLE card is a target (touch/controller), not only the button.
  cardOf(panel.root, "ember_pup").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  check("card-level tap equips", equips.length === 1 && equips[0] === "ember_pup");
  check("every equip button declares an accessible action label",
    [...panel.root.querySelectorAll<HTMLButtonElement>(".pet-equip")].every((b) => (b.getAttribute("aria-label") ?? "").length > 0));

  state.unlockedPets = ["ember_pup", "bonebird"];
  panel.refresh();
  const bird = cardOf(panel.root, "bonebird");
  check("refresh() promotes a freshly unlocked pet from silhouette to full card",
    !bird.classList.contains("locked") && bird.querySelector(".pet-exact") !== null);
  check("destroy() is safe without rAF (jsdom)", (panel.destroy(), true));
  panel.root.remove();
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
process.stdout.write("\nCompanion panel holds the UI Director gate.\n");
