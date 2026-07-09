// HUD DOM suite: the hotbar chrome rendered into a real (jsdom) document, pinned to the
// UI Director gate. Weapon slots keep their labeled, keyboard-accessible shape (key badge
// + name + button semantics, equipped slot dominant); the blessing row is at most
// MAX_BUFF_SLOTS compact ICON-ONLY slots — tint border, LV badge, "+N" overflow chip, no
// long chip text in the row — with the full name / exact current effect / next-level delta
// in the hover-focus tooltip and aria-label; the hold-Tab panel carries the full build and
// the RELEASE TAB TO CLOSE footer; blessing CHOICE cards stay fully labeled (never
// icon-only): icon + name + NEW/UPGRADE LVn tag + rarity + exact effect + input glyph.
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
  KeyboardEvent: dom.window.KeyboardEvent,
});

const { Hud, buildSlot, buildBuffChip, buildMoreChip, MAX_BUFF_SLOTS, objectiveCopy, dealerTagCopy, weaponTipRows, fmtStat } = await import("../src/game/hud.js");
const { BlessingOverlay } = await import("../src/ui/blessing.js");
const { ITEMS, itemDesc, createMods } = await import("../src/sim/items.js");
const { weaponHudStats } = await import("../src/sim/weaponStats.js");
type HudModule = typeof import("../src/game/hud.js");
type HudState = Parameters<InstanceType<HudModule["Hud"]>["update"]>[0];
type WeaponId = HudState["weapons"][number]["id"];

// Unmodified live stats for a weapon (fresh mods, full HP) — the shape game.ts feeds.
function wstat(id: WeaponId) {
  return weaponHudStats(id, createMods(), 0);
}
function wslot(id: WeaponId, name: string, isCurrent: boolean) {
  return { id, name, isCurrent, stats: wstat(id) };
}

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
      wslot("pistol", "Pistol", false),
      wslot("shotgun", "Shotgun", true),
      wslot("tesla", "Tesla", false),
    ],
    isCleared: false, enemiesLeft: 3, isObjectiveHidden: false, isParty: false, isBossActive: false, bossHpFrac: 0,
    coopLabel: null, waitLabel: null, prompt: null, dashFill: 1,
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
  const slot = buildSlot(wslot("shotgun", "Shotgun", true), 1);
  check("slot keeps its select-key badge", slot.querySelector(".hb-key")?.textContent === "2");
  check("slot keeps its weapon-name label", slot.querySelector(".hb-name")?.textContent === "SHOTGUN");
  check("slot is a tabbable button", slot.tabIndex === 0 && slot.getAttribute("role") === "button");
  check("slot aria-label names weapon + slot + equipped state + live stats",
    slot.getAttribute("aria-label") === "Shotgun, slot 2, equipped. DMG 1.7 \u00d75, RATE 1.9/S, RANGE 160 PX",
    slot.getAttribute("aria-label") ?? "");
  check("equipped slot is lit", slot.classList.contains("on"));
  const tenth = buildSlot(wslot("tesla", "Tesla", false), 9);
  check("slots past 9 carry no key badge", tenth.querySelector(".hb-key") === null);
}

function weaponTooltipTests(): void {
  section("weapon stat tooltip: name + live DMG/RATE/RANGE rows in the pixel tip chrome");
  const slot = buildSlot(wslot("shotgun", "Shotgun", true), 1);
  const tip = slot.querySelector(".tip")!;
  check("slot carries a tooltip element", tip !== null && tip.getAttribute("role") === "tooltip");
  check("no native title attribute (would double the custom tip)", slot.getAttribute("title") === null);
  check("tooltip names the weapon", tip.querySelector(".tn")?.textContent === "SHOTGUN");
  const rows = [...tip.querySelectorAll(".tr")].map((r) =>
    `${r.querySelector(".tk")?.textContent}=${r.querySelector(".tv")?.textContent}`);
  check("rows read DMG \u00d7volley / RATE / RANGE", rows.join("|") === "DMG=1.7 \u00d75|RATE=1.9/S|RANGE=160 PX", rows.join("|"));
  check("equipped card marks itself EQUIPPED and carries no deltas",
    tip.querySelector(".tx")?.textContent === "EQUIPPED" && tip.querySelector(".td") === null);
  check("plain gun shows no special line", tip.querySelector(".ts") === null);

  section("weapon stat tooltip: melee relabels RANGE to REACH; specials derive from weapon data");
  const sword = buildSlot(wslot("sword", "Cutlass", false), 0);
  check("melee row reads REACH", [...sword.querySelectorAll(".tr .tk")].map((k) => k.textContent).join(",") === "DMG,RATE,REACH");
  const tesla = buildSlot(wslot("tesla", "Tesla", false), 2);
  check("tesla names its chain", tesla.querySelector(".ts")?.textContent === "CHAINS TO 3 MORE");
  const spear = buildSlot(wslot("spear", "Pike", false), 3);
  check("thrust melee names its verb", spear.querySelector(".ts")?.textContent === "PIERCING THRUST");

  section("weapon stat tooltip: restrained deltas vs the equipped weapon");
  const equipped = wstat("shotgun"); // volley 1.7×5 = 8.5, rate 1.9, range 160
  const cannonRows = weaponTipRows(wstat("cannon"), equipped); // 9 dmg, slow, long range
  check("bigger volley damage marks up", cannonRows[0].delta === 1);
  check("slower rate marks down", cannonRows[1].delta === -1);
  check("longer range marks up", cannonRows[2].delta === 1);
  const swordRows = weaponTipRows(wstat("sword"), equipped);
  check("melee reach is NEVER compared against bullet range (incomparable classes)", swordRows[2].delta === null);
  check("melee damage/rate still compare", swordRows[0].delta !== null && swordRows[1].delta !== null);
  const selfRows = weaponTipRows(wstat("shotgun"), wstat("shotgun"));
  check("identical stats read as no delta (dead zone)", selfRows.every((r) => r.delta === 0));
  check("no-equipped comparison yields null deltas", weaponTipRows(wstat("pistol"), null).every((r) => r.delta === null));
  const slotVs = buildSlot(wslot("cannon", "Thunderbolt", false), 0, equipped);
  const arrows = [...slotVs.querySelectorAll(".td")].map((d) => `${d.textContent}${d.classList.contains("up") ? "+" : "-"}`);
  check("delta arrows render with up/down classes", arrows.join(",") === "\u25b2+,\u25bc-,\u25b2+", arrows.join(","));

  section("weapon stat tooltip: live mod-adjusted values (never raw balance constants)");
  const mods = createMods();
  mods.damageMult = 1.5;
  mods.extraPellets = 2;
  const modded = weaponHudStats("shotgun", mods, 0);
  const moddedRows = weaponTipRows(modded, null);
  check("damage row reflects the damage mult", moddedRows[0].v === `${fmtStat(1.7 * 1.5)} \u00d77`, moddedRows[0].v);
  check("fmtStat trims to one decimal", fmtStat(6.25) === "6.3" && fmtStat(2) === "2" && fmtStat(1.9230769) === "1.9");
}

function buffChipTests(): void {
  section("blessing slots are ICON-ONLY: tint border, LV badge, zero name text in the row");
  const chip = buildBuffChip(ITEM_LV2);
  check("legacy name/level text nodes are gone", chip.querySelector(".bn") === null && chip.querySelector(".bl") === null);
  const rowText = [...chip.childNodes]
    .filter((n) => !(n instanceof dom.window.HTMLElement && (n.classList.contains("tip") || n.classList.contains("lv"))))
    .map((n) => n.textContent).join("").trim();
  check("no name text in the chip row (icon only)", rowText === "", `text="${rowText}"`);
  check("tint border variable set from the blessing", chip.style.getPropertyValue("--t") === "#ff5a5a");
  check("rare blessing keeps its rare glow class", chip.classList.contains("rare"));
  check("icon element present", chip.querySelector("img, .glyphfb") !== null);

  section("LV badge: current level in the corner, max state marked");
  check("badge shows the current level", chip.querySelector(".lv")?.textContent === "2");
  check("non-maxed badge carries no max class", chip.querySelector(".lv.max") === null);
  const maxChipBadge = buildBuffChip(ITEM_MAX).querySelector(".lv");
  check("maxed badge shows LV3 with the max class", maxChipBadge?.textContent === "3" && maxChipBadge.classList.contains("max"));

  section("tooltip: full name + exact current effect + next-level delta");
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

function buffOverflowTests(): void {
  section("blessing row caps at MAX_BUFF_SLOTS with a +N overflow chip");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const many = Array.from({ length: 11 }, (_, i) => ({
    ...ITEM_LV2, id: `it_${i}`, name: `Blessing ${i}`, rarity: "common", count: 1, nextDesc: "more.",
  }));
  hud.update(mkState({ items: many }));
  const chips = [...root.querySelectorAll(".hb-buffs .hb-buff")];
  check(`row renders exactly ${MAX_BUFF_SLOTS} slots for 11 blessings`, chips.length === MAX_BUFF_SLOTS, `n=${chips.length}`);
  const more = chips[chips.length - 1];
  check("last slot is the overflow chip", more.classList.contains("more"));
  check("overflow chip counts the hidden blessings", more.childNodes[0].textContent === "+4");
  check("overflow chip is tabbable and points at the Tab panel",
    (more as HTMLElement).tabIndex === 0 && more.getAttribute("aria-label") === "4 more blessings. Hold Tab for the full build.");
  check("overflow tooltip names the Tab panel", more.querySelector(".tip .tx")?.textContent === "HOLD TAB FOR THE FULL BUILD");

  const exactly8 = many.slice(0, MAX_BUFF_SLOTS);
  hud.update(mkState({ items: exactly8 }));
  check("exactly 8 blessings render 8 real slots, no overflow chip",
    root.querySelectorAll(".hb-buffs .hb-buff").length === MAX_BUFF_SLOTS && root.querySelector(".hb-buff.more") === null);
  root.remove();

  const standalone = buildMoreChip(7);
  check("overflow chip builder is pure of the row state", standalone.childNodes[0].textContent === "+7");
}

function blessingCardTests(): void {
  section("blessing CHOICE cards stay fully labeled (never icon-only)");
  const overlay = new BlessingOverlay();
  const fresh = ITEMS[0];
  const owned = ITEMS[1];
  overlay.show([{ item: fresh, nextLevel: 1 }, { item: owned, nextLevel: 2 }], () => {});
  const cards = [...document.querySelectorAll(".blessing-card")];
  check("one card per choice", cards.length === 2);
  const [cNew, cUp] = cards;
  check("card keeps its 56px icon frame", cNew.querySelector(".bc-icon") !== null);
  check("card keeps the full blessing name", cNew.querySelector(".bc-name")?.textContent === fresh.name);
  check("fresh pick carries the NEW tag", cNew.querySelector(".bc-tag.new")?.textContent === "NEW");
  check("upgrade pick carries UPGRADE LVn", cUp.querySelector(".bc-tag.up")?.textContent === "UPGRADE LV2");
  check("rarity label always present (upgrades included)",
    cNew.querySelector(".bc-rarity")?.textContent === fresh.rarity.toUpperCase() && cUp.querySelector(".bc-rarity")?.textContent === owned.rarity.toUpperCase());
  check("card shows the exact effect the pick would grant",
    cNew.querySelector(".bc-desc")?.textContent === itemDesc(fresh, 1) && cUp.querySelector(".bc-desc")?.textContent === itemDesc(owned, 2));
  check("input glyphs 1/2 on the cards", cNew.querySelector(".bc-key")?.textContent === "1" && cUp.querySelector(".bc-key")?.textContent === "2");
  overlay.hide();
}

function drawerTests(): void {
  section("UI Part4: blessing summary collapses to a BUILD pill that opens the full drawer");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  hud.update(mkState({ items: [ITEM_LV2, ITEM_MAX] }));
  const pill = root.querySelector<HTMLButtonElement>("[data-hb-build]")!;
  check("pill labels BUILD \u00b7 N", pill.textContent === "BUILD \u00b7 2", `text="${pill.textContent}"`);
  check("pill is a real button with dialog affordance", pill.tagName === "BUTTON" && pill.getAttribute("aria-haspopup") === "dialog");
  check("pill aria names the action", pill.getAttribute("aria-label") === "2 blessings. Open the full build.");
  check("pill flagged once blessings exist", pill.classList.contains("has"));

  check("no HUD input context at rest", !hud.isInteractionActive() && !hud.isDrawerOpen());
  pill.click();
  check("tapping the pill opens the full build drawer", hud.isDrawerOpen());
  check("an open drawer owns the input context (gameplay gated)", hud.isInteractionActive());
  const rows = [...root.querySelectorAll(".hb-drawer .hd-row")];
  check("drawer lists the FULL build", rows.length === 2);
  check("drawer head counts the build", root.querySelector(".hd-head span")?.textContent === "BUILD \u00b7 2");
  check("row carries name + level", rows[0].querySelector(".hd-name")?.textContent === "SHARPENED FANGS \u00b7 LV2");
  check("row carries the exact current effect", rows[0].querySelector(".hd-desc")?.textContent === ITEM_LV2.desc);
  check("row carries the next-level delta", rows[0].querySelector(".hd-next")?.textContent === `NEXT LV3 \u2014 ${ITEM_LV2.nextDesc}`);
  check("maxed row omits the delta line", rows[1].querySelector(".hd-next") === null);

  root.querySelector<HTMLButtonElement>(".hd-close")!.click();
  check("CLOSE dismisses the drawer and releases the context", !hud.isDrawerOpen() && !hud.isInteractionActive());

  section("UI Part4: weapon stat drawer replaces hover-only info (tap the equipped slot)");
  let dropCalls = 0;
  hud.openWeaponDrawer({ id: "shotgun", name: "Shotgun", damage: 2, pellets: 1, rate: 1.9, range: 160, isMelee: false, special: null, onDrop: () => dropCalls++ });
  check("weapon drawer opens", hud.isDrawerOpen());
  check("drawer titles the weapon", root.querySelector(".hd-head span")?.textContent === "SHOTGUN");
  const statTexts = [...root.querySelectorAll(".hd-stat")].map((s) => s.textContent);
  check("stat sheet shows DMG / RATE / RANGE", statTexts.join("|") === "DMG2|RATE1.9/S|RANGE160 PX", statTexts.join("|"));
  check("plain gun carries no special line", root.querySelector(".hd-special") === null);
  const dropBtn = root.querySelector<HTMLButtonElement>(".hd-drop")!;
  check("touch DROP action present", dropBtn.textContent === "DROP (Q)");
  dropBtn.click();
  check("DROP releases the input context BEFORE acting, then acts once", dropCalls === 1 && !hud.isDrawerOpen());

  hud.openWeaponDrawer({ id: "pistol", name: "Pistol", damage: 1, pellets: 1, rate: 6.3, range: 616, isMelee: false, special: null, onDrop: null });
  check("final weapon offers no DROP action", root.querySelector(".hd-drop") === null);

  hud.openWeaponDrawer({ id: "tesla", name: "Tesla", damage: 3, pellets: 3, rate: 2.5, range: 450, isMelee: false, special: "CHAINS TO 3 MORE", onDrop: null });
  const teslaStats = [...root.querySelectorAll(".hd-stat")].map((s) => s.textContent);
  check("volley weapons read DMG \u00d7N in the drawer", teslaStats[0] === "DMG3 \u00d73", teslaStats[0]);
  check("drawer carries the weapon's special line", root.querySelector(".hd-special")?.textContent === "CHAINS TO 3 MORE");
  hud.closeDrawer();
  hud.openWeaponDrawer({ id: "pistol", name: "Pistol", damage: 1, pellets: 1, rate: 6.3, range: 616, isMelee: false, special: null, onDrop: null });

  section("UI Part4: the scrim swallows the tap and closes the drawer");
  check("scrim shown while open", root.querySelector(".hb-scrim")!.classList.contains("show"));
  root.querySelector(".hb-scrim")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
  check("scrim tap closes the drawer", !hud.isDrawerOpen());
  check("scrim hidden again", !root.querySelector(".hb-scrim")!.classList.contains("show"));
  root.remove();
}

function hudIntegrationTests(): void {
  section("Hud.update wires slots + blessing row + hint into the live DOM");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  check("Tab panel footer reads RELEASE TAB TO CLOSE", root.textContent!.includes("RELEASE TAB TO CLOSE"));
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
      wslot("tesla", "Tesla", false),
      wslot("pistol", "Pistol", false),
      wslot("shotgun", "Shotgun", true),
    ],
    items: [ITEM_LV2, ITEM_MAX],
  }));
  check("reordered inventory re-renders in the new order", [...root.querySelectorAll(".hb-slot .hb-name")].map((n) => n.textContent).join(",") === "TESLA,PISTOL,SHOTGUN");
  check("key badges remap to the new positions", [...root.querySelectorAll(".hb-slot .hb-key")].map((n) => n.textContent).join(",") === "1,2,3");
  check("equipped highlight follows the weapon id", root.querySelectorAll(".hb-slot")[2].classList.contains("on"));
}

function hierarchyTests(): void {
  section("UI Director hierarchy: ONE top-center objective lane (boss wins; combo yields)");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const lane = root.querySelector<HTMLElement>("[data-objlane]")!;
  const objective = root.querySelector<HTMLElement>("[data-objective]")!;
  const waitline = root.querySelector<HTMLElement>("[data-waitline]")!;

  check("the lane stacks bossbar -> objective -> waitline -> combo in ONE container",
    [...lane.children].map((c) => c.getAttribute("data-bossbar") !== null ? "boss"
      : c.getAttribute("data-objective") !== null ? "obj"
      : c.getAttribute("data-waitline") !== null ? "wait"
      : c.getAttribute("data-combo") !== null ? "combo" : "?").join(",") === "boss,obj,wait,combo");

  hud.update(mkState({ enemiesLeft: 3 }));
  check("fighting floor reads the enemies-left copy", objective.textContent === "3 ENEMIES LEFT" && objective.classList.contains("show"));
  hud.update(mkState({ enemiesLeft: 1 }));
  check("singular enemy copy", objective.textContent === "1 ENEMY LEFT");
  hud.update(mkState({ enemiesLeft: 0 }));
  check("uncleared with an empty board reads INCOMING (never a lying zero)", objective.textContent === "ENEMIES INCOMING\u2026");
  hud.update(mkState({ isCleared: true, enemiesLeft: 0 }));
  check("cleared floor flips to FLOOR CLEAR \u00b7 GO DOWN with the clear accent",
    objective.textContent === "FLOOR CLEAR \u00b7 GO DOWN" && objective.classList.contains("clear"));
  hud.update(mkState({ isCleared: true, enemiesLeft: 0, isParty: true }));
  check("a party's cleared floor reads MEET AT EXIT (the coordination moment)",
    objective.textContent === "FLOOR CLEAR \u00b7 MEET AT EXIT");

  hud.update(mkState({ isBossActive: true, bossHpFrac: 0.8, combo: 4, comboMult: 1.5, comboFrac: 0.5 }));
  check("a boss WINS the lane: bar shown, normal objective hidden",
    root.querySelector("[data-bossbar]")!.classList.contains("show") && !objective.classList.contains("show"));
  check("the lane marks boss so the combo yields at 70%", lane.classList.contains("boss"));
  hud.update(mkState({ isBossActive: false, combo: 4, comboMult: 1.5, comboFrac: 0.5 }));
  check("boss down: the lane releases and the objective returns",
    !lane.classList.contains("boss") && objective.classList.contains("show"));

  hud.update(mkState({ isObjectiveHidden: true }));
  check("the sandbox has no objective line", !objective.classList.contains("show"));

  section("UI Director hierarchy: the co-op wait line rides the lane; BL carries the prompt");
  hud.update(mkState({ waitLabel: "WAITING AT EXIT \u00b7 1/2 \u2014 WAITING FOR GF" }));
  check("the coordination copy shows in the lane's wait slot",
    waitline.classList.contains("show") && waitline.textContent!.includes("WAITING AT EXIT"));
  hud.update(mkState());
  check("no coordination owed -> the wait slot fades (fixed height, no shift)", !waitline.classList.contains("show"));

  const prompt = root.querySelector<HTMLElement>("[data-prompt]")!;
  check("BL prompt hidden with no context", !prompt.classList.contains("show"));
  hud.update(mkState({ prompt: { key: "E", label: "HOLD \u2014 REVIVE GF", isActive: false } }));
  check("the revive affordance shows key cap + label in the BL cluster",
    prompt.classList.contains("show") && !prompt.classList.contains("active")
    && prompt.textContent!.includes("E") && prompt.textContent!.includes("REVIVE GF"));
  hud.update(mkState({ prompt: { key: "E", label: "REVIVING GF\u2026 62%", isActive: true } }));
  check("a running channel lights the prompt", prompt.classList.contains("active") && prompt.textContent!.includes("62%"));
  const bl = root.querySelector(".hud-corner.bl")!;
  check("the prompt lives WITH the dash in the BL cluster", bl.querySelector(".dash") !== null && bl.querySelector("[data-prompt]") !== null);

  hud.clear();
  check("clear() resets lane + prompt states",
    !objective.classList.contains("show") && !lane.classList.contains("boss") && !prompt.classList.contains("show"));

  section("dealerTagCopy: the Dealer's at-a-glance state matrix (UI gate)");
  const buyer = { coins: 10, hp: 3, maxHp: 6, isOwned: false };
  check("affordable heart reads HEART \u00b7 6 COINS",
    JSON.stringify(dealerTagCopy({ kind: "heart", name: "Heart", price: 6 }, buyer)) === JSON.stringify({ text: "HEART \u00b7 6 COINS", state: "buy" }));
  check("affordable stall reads NAME \u00b7 PRICE COINS",
    dealerTagCopy({ kind: "weapon", name: "Railgun", price: 12 }, { ...buyer, coins: 12 }).text === "RAILGUN \u00b7 12 COINS");
  check("broke reads NEED N MORE (the exact shortfall)",
    JSON.stringify(dealerTagCopy({ kind: "heart", name: "Heart", price: 6 }, { ...buyer, coins: 4 })) === JSON.stringify({ text: "NEED 2 MORE", state: "broke" }));
  check("full health outranks coins (the touch would be pointless)",
    dealerTagCopy({ kind: "heart", name: "Heart", price: 6 }, { ...buyer, hp: 6 }).text === "FULL HEALTH");
  check("an owned stall reads OWNED (party ownership explicit)",
    dealerTagCopy({ kind: "weapon", name: "Railgun", price: 12 }, { ...buyer, coins: 50, isOwned: true }).text === "OWNED");

  section("objectiveCopy: the canonical strings");
  check("N ENEMIES LEFT", objectiveCopy(false, 7) === "7 ENEMIES LEFT");
  check("FLOOR CLEAR \u00b7 GO DOWN", objectiveCopy(true, 0) === "FLOOR CLEAR \u00b7 GO DOWN");
  check("cleared wins regardless of a stale count", objectiveCopy(true, 3) === "FLOOR CLEAR \u00b7 GO DOWN");
  check("party cleared copy points at the MEET", objectiveCopy(true, 0, true) === "FLOOR CLEAR \u00b7 MEET AT EXIT");
}

function main(): void {
  weaponSlotTests();
  weaponTooltipTests();
  buffChipTests();
  buffOverflowTests();
  blessingCardTests();
  drawerTests();
  hudIntegrationTests();
  hierarchyTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll HUD DOM assertions passed.\n");
}

main();
