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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const { Hud, buildSlot, buildEmptySlot, buildBuffChip, buildMoreChip, MAX_BUFF_SLOTS, objectiveCopy, weaponTipRows, weaponTipNotes, renderTipInto, fmtStat } = await import("../src/game/hud.js");
const { buildArenaMatchHud } = await import("../src/game/arenaHud.js");
const { MAX_OWNED_WEAPONS } = await import("../src/sim/constants.js");
const { BlessingOverlay } = await import("../src/ui/blessing.js");
const { ShopPanel } = await import("../src/ui/shopPanel.js");
const { shopActionCopy, shopOwnershipCopy, shopChipCopy, shopPanelView, shopFooterCopy, isResolvedShopStatus } = await import("../src/ui/shopCopy.js");
const { buildShopState, shopViewerOf } = await import("../src/sim/shop.js");

// A shop-viewer source with sensible defaults (the premium run fields at their fresh-run
// identities) — the shop copy/panel assertions only vary coins/ownership.
function viewerSrc(o: Partial<import("../src/sim/shop.js").ShopViewerSource> = {}): import("../src/sim/shop.js").ShopViewerSource {
  return {
    id: "local", coins: 30, hp: 4, maxHp: 6, weapon: "pistol", ownedWeapons: [], ownedItemIds: [],
    premiumHpBuys: 0, isAmberCacheArmed: false, reviveTokens: 0, extraWeaponSlots: 0, hpTithe: 0,
    mods: { maxHpBonus: 0 },
    ...o,
  };
}
const { generateDungeon } = await import("../src/sim/dungeon.js");
const { bossDisplayName } = await import("../src/sim/enemies.js");
const { ITEMS, itemDesc, createMods } = await import("../src/sim/items.js");
const { weaponDisplayStats } = await import("../src/sim/weaponStats.js");
const { settings } = await import("../src/game/settings.js");
type HudModule = typeof import("../src/game/hud.js");
type HudState = Parameters<InstanceType<HudModule["Hud"]>["update"]>[0];
type WeaponId = HudState["weapons"][number]["id"];

// Unmodified live weapon card (fresh mods, full HP) — the shape game.ts feeds.
function wcard(id: WeaponId) {
  return weaponDisplayStats(id, createMods(), 0);
}
function wslot(id: WeaponId, name: string, isCurrent: boolean) {
  return { id, name, isCurrent, card: wcard(id) };
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
    hp: 5, maxHp: 6, floor: 2, kills: 7, coins: 30, mutators: [],
    weapons: [
      wslot("pistol", "Pistol", false),
      wslot("shotgun", "Shotgun", true),
      wslot("tesla", "Tesla", false),
    ],
    weaponCap: MAX_OWNED_WEAPONS,
    swap: null,
    isCleared: false, enemiesLeft: 3, isObjectiveHidden: false, isParty: false, isBossActive: false, bossHpFrac: 0, bossName: "",
    coopLabel: null, waitLabel: null, dashFill: 1,
    combo: 0, comboMult: 1, comboColor: "#fff", comboFrac: 0,
    items: [],
    party: [],
    ult: null,
    sig: null,
    isArena: false,
    arenaMatch: null,
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
  check("slot aria-label stays concise (the card rides the linked tooltip on focus)",
    slot.getAttribute("aria-label") === "Shotgun, slot 2, equipped", slot.getAttribute("aria-label") ?? "");
  check("slot carries no native title and no embedded tooltip (the floating singleton owns it)",
    slot.getAttribute("title") === null && slot.querySelector(".tip, .hb-tip") === null);
  check("equipped slot is lit", slot.classList.contains("on"));
  // The cap contract: MAX_OWNED_WEAPONS never exceeds the number-key row, so EVERY slot
  // that can exist carries its select key — no unreachable slots, ever.
  check("the hotbar cap fits the number-key row", MAX_OWNED_WEAPONS <= 9, `cap=${MAX_OWNED_WEAPONS}`);
  for (let i = 0; i < MAX_OWNED_WEAPONS; i++) {
    const s = buildSlot(wslot("tesla", "Tesla", false), i);
    check(`slot ${i + 1} carries its select-key badge`, s.querySelector(".hb-key")?.textContent === String(i + 1));
  }

  section("empty capacity boxes: visible cap, inert, invisible to interaction machinery");
  const empty = buildEmptySlot(4);
  check("empty box shows its future select key", empty.querySelector(".hb-key")?.textContent === "5");
  check("empty box is not a .hb-slot (drag/keyboard/tooltips never see it)", !empty.classList.contains("hb-slot") && empty.classList.contains("hb-empty"));
  check("empty box is inert for a11y", empty.getAttribute("aria-hidden") === "true" && empty.tabIndex !== 0 && empty.getAttribute("role") === null);
}

// Render the floating tooltip's content for one weapon (the pure builder the Hud
// singleton uses), against an optional equipped card.
function tipFor(id: WeaponId, name: string, isCurrent = false, vs: ReturnType<typeof wcard> | null = null): HTMLElement {
  const tip = document.createElement("div");
  renderTipInto(tip, wslot(id, name, isCurrent), isCurrent ? null : vs);
  return tip;
}

function weaponTooltipTests(): void {
  section("weapon card tooltip: pixel icon + name header, room-job verb, core rows");
  const tip = tipFor("shotgun", "Shotgun", true);
  check("header carries the pixel-rendered weapon icon", tip.querySelector(".th .ti img, .th .ti .glyphfb") !== null);
  check("header names the weapon", tip.querySelector(".th .tn")?.textContent === "SHOTGUN");
  check("the room job leads the card", tip.querySelector(".tj")?.textContent === "SHRED UP CLOSE");
  const rows = [...tip.querySelectorAll(".tr")].map((r) =>
    `${r.querySelector(".tk")?.textContent}=${r.querySelector(".tv")?.textContent}`);
  check("core rows: exact per-pellet POWER, then IMPACT/CADENCE/REACH bands + COVERAGE category",
    rows.join("|") === "POWER=1.7 \u00d75|IMPACT=SOLID|CADENCE=STEADY|REACH=CLOSE|COVERAGE=WIDE", rows.join("|"));
  check("tradeoff line: the shotgun's self-kick", [...tip.querySelectorAll(".tm")].map((n) => n.textContent).join("|") === "KICKS YOU BACK");
  check("equipped card marks itself EQUIPPED and hides ALL comparison words",
    tip.querySelector(".tx")?.textContent === "EQUIPPED" && tip.querySelector(".td") === null);

  section("weapon card tooltip: five rows always, px never displayed");
  const pistol = tipFor("pistol", "Pistol");
  check("plain gun renders all five rows (FOCUSED is its coverage)",
    [...pistol.querySelectorAll(".tr .tk")].map((k) => k.textContent).join(",") === "POWER,IMPACT,CADENCE,REACH,COVERAGE"
    && pistol.querySelectorAll(".tr")[4].querySelector(".tv")?.textContent === "FOCUSED");
  check("plain pistol carries zero technique lines", pistol.querySelectorAll(".tm").length === 0);
  check("band/category rows never leak a number (no px, no internals)",
    (["pistol", "railgun", "sword", "mortar"] as WeaponId[]).every((id) =>
      [...tipFor(id, id).querySelectorAll(".tr")].slice(1).every((r) => !/\d/.test(r.querySelector(".tv")?.textContent ?? "0"))));
  const sword = tipFor("sword", "Cutlass");
  check("melee coverage reads its geometry", sword.querySelectorAll(".tr")[4].querySelector(".tv")?.textContent === "SWEEP");
  const spear = tipFor("spear", "Pike");
  check("a thrust reads THRUST and keeps its technique line",
    spear.querySelectorAll(".tr")[4].querySelector(".tv")?.textContent === "THRUST"
    && [...spear.querySelectorAll(".tm")].some((n) => n.textContent === "PIERCING THRUST"));
  check("row budget holds: exactly five stat rows + at most three technique lines",
    (["shotgun", "sawnoff", "mortar", "tesla", "longsword", "flamer"] as WeaponId[]).every((id) => {
      const t = tipFor(id, id, false, wcard("shotgun"));
      return t.querySelectorAll(".tr").length === 5 && t.querySelectorAll(".tm").length <= 3;
    }));

  section("weapon card tooltip: comparison WORDS vs the equipped slot (accepted vocabulary)");
  const cmpWords = (rowsVs: ReturnType<typeof weaponTipRows>) => rowsVs.map((r) => r.cmp.map((c) => c.word).join("+"));
  // Shotgun hovered while the pistol is equipped: lighter per pellet but more of them —
  // the two POWER facts stay separate, never summed into a fake total.
  const sgVsPistol = cmpWords(weaponTipRows(wcard("shotgun"), wcard("pistol")));
  check("POWER splits into LIGHTER + MORE SHOTS (never a guaranteed sum)", sgVsPistol[0] === "LIGHTER+MORE SHOTS", sgVsPistol[0]);
  check("IMPACT tie says nothing (both SOLID)", sgVsPistol[1] === "");
  check("CADENCE reads SLOWER", sgVsPistol[2] === "SLOWER");
  check("REACH reads SHORTER", sgVsPistol[3] === "SHORTER");
  check("COVERAGE within the pattern family reads WIDER", sgVsPistol[4] === "WIDER");
  const rgVsCannon = cmpWords(weaponTipRows(wcard("railgun"), wcard("cannon")));
  check("equal volley sizes: HEAVIER with no shots word", rgVsCannon[0] === "HEAVIER");
  check("REACH reads LONGER; identical coverage reads SAME", rgVsCannon[3] === "LONGER" && rgVsCannon[4] === "SAME");
  check("IMPACT compares MORE/LESS by band",
    cmpWords(weaponTipRows(wcard("railgun"), wcard("pistol")))[1] === "MORE"
    && cmpWords(weaponTipRows(wcard("rapid"), wcard("pistol")))[1] === "LESS");
  check("behavior coverage across categories stays neutral DIFFERENT",
    cmpWords(weaponTipRows(wcard("tesla"), wcard("shotgun")))[4] === "DIFFERENT");
  check("BURST vs WIDE reads TIGHTER", cmpWords(weaponTipRows(wcard("burst"), wcard("shotgun")))[4] === "TIGHTER");
  check("melee reach compares on the shared scale (sword vs railgun: SHORTER)",
    cmpWords(weaponTipRows(wcard("sword"), wcard("railgun")))[3] === "SHORTER");
  check("no comparison at all without an equipped card", weaponTipRows(wcard("pistol"), null).every((r) => r.cmp.length === 0));
  const tipVs = tipFor("shotgun", "Shotgun", false, wcard("pistol"));
  const tokens = [...tipVs.querySelectorAll(".td")].map((d) => `${d.textContent}:${d.className.replace("td ", "")}`);
  check("directional tokens lead with a shape glyph, then the word, then tint (grayscale/color-blind safe)",
    tokens.join("|") === "\u25bc LIGHTER:down|\u25b2 MORE SHOTS:up|\u25bc SLOWER:down|\u25bc SHORTER:down|WIDER:eq", tokens.join("|"));
  check("neutral tokens carry no directional glyph", tokens[4] === "WIDER:eq");

  section("weapon card tooltip: mechanics diff as GAINS / LOSES / CHANGES");
  const equipped = wcard("shotgun");
  const vsShotgun = weaponTipNotes(wcard("tesla"), equipped);
  check("new mechanic reads GAINS", vsShotgun.some((n) => n.marker === "gains" && n.text === "CHAINS TO 3 MORE"), JSON.stringify(vsShotgun));
  check("the equipped weapon's dropped mechanic reads LOSES",
    vsShotgun.some((n) => n.marker === "loses" && n.text === "KICKS YOU BACK"), JSON.stringify(vsShotgun));
  const ricochetVsNailer = weaponTipNotes(wcard("ricochet"), wcard("nailer"));
  check("same mechanic at a new magnitude reads CHANGES",
    ricochetVsNailer.some((n) => n.marker === "changes" && n.text === "RICOCHETS \u00d72"), JSON.stringify(ricochetVsNailer));
  const flamerVsFlamer = weaponTipNotes(wcard("flamer"), wcard("flamer"));
  check("shared mechanics stay unmarked", flamerVsFlamer.every((n) => n.marker === null));
  check("no comparison = plain technique lines", weaponTipNotes(wcard("mortar"), null).every((n) => n.marker === null));
  const teslaTip = tipFor("tesla", "Tesla", false, equipped);
  const noteLines = [...teslaTip.querySelectorAll(".tm")].map((n) => `${n.className}:${n.textContent}`);
  check("diff lines render marked with the prefix", noteLines.join("|") === "tm gains:GAINS \u00b7 CHAINS TO 3 MORE|tm loses:LOSES \u00b7 KICKS YOU BACK", noteLines.join("|"));

  section("weapon card tooltip: live mod-adjusted values (never raw balance constants)");
  const mods = createMods();
  mods.damageMult = 1.5;
  mods.extraPellets = 2;
  const modded = weaponDisplayStats("shotgun", mods, 0);
  const moddedRows = weaponTipRows(modded, null);
  check("POWER reflects the damage mult and the modded volley", moddedRows[0].v === `${fmtStat(1.7 * 1.5)} \u00d77`, moddedRows[0].v);
  check("damage mods move the IMPACT band live", moddedRows[1].v === "HEAVY", moddedRows[1].v); // 1.7 -> 2.55
  const moddedPistol = weaponDisplayStats("pistol", mods, 0);
  check("extra pellets move a FOCUSED gun's coverage to BURST live",
    weaponTipRows(moddedPistol, null)[4].v === "BURST");
  const pierceMods = createMods();
  pierceMods.pierce = 1;
  check("pierce mods surface a live PIERCES line",
    weaponTipNotes(weaponDisplayStats("pistol", pierceMods, 0), null).some((n) => n.text === "PIERCES 1 BODY"));
  check("fmtStat trims to one decimal", fmtStat(6.25) === "6.3" && fmtStat(2) === "2" && fmtStat(1.9230769) === "1.9");

  section("weapon card tooltip: QA gates — rendered content is never nonsense, arrows stay semantic");
  const allIds = ["pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
    "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam", "sword", "longsword", "spear"] as WeaponId[];
  check("no tooltip ever renders NaN / undefined / N/A (all weapons, with and without comparison)",
    allIds.every((id) => {
      const text = tipFor(id, id, false, wcard("shotgun")).textContent ?? "";
      const plain = tipFor(id, id, false, null).textContent ?? "";
      return [text, plain].every((t) => !t.includes("NaN") && !t.includes("undefined") && !t.includes("N/A"));
    }));
  // CADENCE derives from fireCd, a lower-is-better raw stat: the word must follow the
  // semantic direction (lower fireCd = FASTER), never the raw number's direction.
  const fasterRaw = weaponTipRows(wcard("rapid"), wcard("railgun")); // fireCd 0.07 vs 0.85
  check("lower-is-better raw (fireCd) reads FASTER on the semantic CADENCE row",
    fasterRaw[2].cmp.length === 1 && fasterRaw[2].cmp[0].word === "FASTER" && fasterRaw[2].cmp[0].dir === 1);
  check("self-comparison stays silent except a neutral coverage SAME",
    weaponTipRows(wcard("shotgun"), wcard("shotgun")).every((r, i) =>
      i === 4 ? r.cmp.length === 1 && r.cmp[0].word === "SAME" && r.cmp[0].dir === 0 : r.cmp.length === 0));
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

  section("UI Part4: weapon stat drawer renders the SAME WeaponDisplayStats as the tooltip");
  let dropCalls = 0;
  hud.openWeaponDrawer({ id: "shotgun", name: "Shotgun", stats: wcard("shotgun"), onDrop: () => dropCalls++ });
  check("weapon drawer opens", hud.isDrawerOpen());
  check("drawer titles the weapon", root.querySelector(".hd-head span")?.textContent === "SHOTGUN");
  check("drawer leads with the rarity tier + room job", root.querySelector(".hd-role")?.textContent === "COMMON \u00b7 SHRED UP CLOSE");
  const statTexts = [...root.querySelectorAll(".hd-stat")].map((s) => s.textContent);
  check("stat boxes are the tooltip's card rows (shared vocabulary, one source)",
    statTexts.join("|") === "POWER1.7 \u00d75|IMPACTSOLID|CADENCESTEADY|REACHCLOSE|COVERAGEWIDE", statTexts.join("|"));
  check("drawer carries the technique lines", root.querySelector(".hd-special")?.textContent === "KICKS YOU BACK");
  const dropBtn = root.querySelector<HTMLButtonElement>(".hd-drop")!;
  check("touch DROP action present", dropBtn.textContent === "DROP (Q)");
  dropBtn.click();
  check("DROP releases the input context BEFORE acting, then acts once", dropCalls === 1 && !hud.isDrawerOpen());

  hud.openWeaponDrawer({ id: "pistol", name: "Pistol", stats: wcard("pistol"), onDrop: null });
  check("no DROP action when the weapon can't drop", root.querySelector(".hd-drop") === null);
  check("plain gun still shows all five rows and no technique lines",
    [...root.querySelectorAll(".hd-stat")].length === 5 && root.querySelector(".hd-special") === null);
  hud.closeDrawer();

  section("UI Part4b: an effect-wave weapon flows through the SAME shared stats model");
  hud.openWeaponDrawer({ id: "snapwire", name: "Snapwire", stats: wcard("snapwire"), onDrop: null });
  check("the trap states its rarity tier + room-verb role from the shared model",
    root.querySelector(".hd-role")?.textContent === `RARE \u00b7 ${weaponDisplayStats("snapwire", createMods(), 0).role}`);
  check("the trap surfaces its authored technique line (ARMED TRAP)",
    [...root.querySelectorAll(".hd-special")].some((n) => n.textContent === "ARMED LINE TRAP"));

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
  check("the remaining capacity renders as inert empty boxes (the bar is always cap-wide)",
    root.querySelectorAll(".hb-slots .hb-empty").length === MAX_OWNED_WEAPONS - 3
    && root.querySelectorAll(".hb-slots > *").length === MAX_OWNED_WEAPONS);
  check("blessing row hidden while empty", !root.querySelector(".hb-buffs")!.classList.contains("show"));
  check("interaction hint shown with 2+ weapons", root.querySelector("[data-hb-hint]")!.classList.contains("show"));
  check("below the cap the hint keeps the classic verbs", root.querySelector("[data-hb-hint]")!.textContent === "CLICK EQUIP \u00b7 DRAG REORDER \u00b7 Q DROP");

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

  section("the full hotbar is legible: FULL hint copy + the swap prompt");
  const fullIds: WeaponId[] = ["pistol", "shotgun", "tesla", "railgun", "smg", "cannon", "rapid", "burst", "sword"];
  const fullWeapons = fullIds.slice(0, MAX_OWNED_WEAPONS).map((id, i) => wslot(id, id, i === 0));
  hud.update(mkState({ weapons: fullWeapons }));
  check("at the cap the bar renders exactly MAX slots and zero empties",
    root.querySelectorAll(".hb-slots .hb-slot").length === MAX_OWNED_WEAPONS
    && root.querySelectorAll(".hb-slots .hb-empty").length === 0);
  check("at the cap the hint names the state and the ways out",
    root.querySelector("[data-hb-hint]")!.textContent === "HOTBAR FULL \u00b7 Q DROP \u00b7 SWAP AT A NEW WEAPON");
  const swapEl = root.querySelector<HTMLElement>("[data-hb-swap]")!;
  check("no blocked pickup underfoot -> no swap prompt", !swapEl.classList.contains("show"));

  const swapCalls: number[] = [];
  let dismissed = 0;
  hud.setHotbarActions({
    onSlotActivate: () => {}, onSlotReorder: () => {}, onSlotInspect: () => {},
    onSlotSwap: (i) => swapCalls.push(i),
    onSwapDismiss: () => { dismissed++; },
  });
  hud.update(mkState({ weapons: fullWeapons, swap: { id: "flamer", name: "Flamer" } }));
  check("a blocked pickup surfaces the swap prompt", swapEl.classList.contains("show"));
  check("the prompt names the state and the incoming weapon",
    swapEl.querySelector(".hs-tag")?.textContent === "HOTBAR FULL"
    && swapEl.querySelector(".hs-name")?.textContent === "SWAP FOR FLAMER?");
  const swapSlots = [...swapEl.querySelectorAll<HTMLButtonElement>(".hs-slot")];
  check("one swap button per current slot, keyed like the hotbar",
    swapSlots.length === MAX_OWNED_WEAPONS
    && swapSlots.map((b) => b.querySelector(".hs-key")?.textContent).join(",") === Array.from({ length: MAX_OWNED_WEAPONS }, (_, i) => String(i + 1)).join(","));
  check("swap buttons say what they trade away", swapSlots[2].getAttribute("aria-label") === "Swap out tesla, slot 3");
  swapSlots[2].dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  check("clicking a slot button routes the swap action with its index", swapCalls.join(",") === "2");
  const leave = swapEl.querySelector<HTMLButtonElement>(".hs-leave")!;
  check("the decline affordance is explicit", leave.textContent === "LEAVE IT");
  leave.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  check("LEAVE IT routes the dismiss action", dismissed === 1);
  hud.update(mkState({ weapons: fullWeapons, swap: null }));
  check("walking away (or declining) hides the prompt", !swapEl.classList.contains("show"));
}

function arenaHudDomTests(): void {
  section("arena HUD: one continuous numeric HP bar, never a heart-sprite row");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  hud.showBanner("FLOOR 9 \u00b7 CLEAR \u00b7 GO DOWN");
  hud.clear();
  const floorBanner = root.querySelector<HTMLElement>(".floor-banner")!;
  check("an arena run cannot inherit a prior co-op floor banner",
    floorBanner.textContent === "" && floorBanner.style.opacity === "0");
  const match = buildArenaMatchHud({
    match: {
      ph: "live",
      end: 6080,
      sc: [
        { id: "p2", f: 1, a: false },
        { id: "p1", f: 3, a: true },
      ],
      win: null,
    },
    tick: 100,
    selfId: "p1",
    respawnTicks: 0,
    nameOf: (id, isSelf) => isSelf ? "YOU" : id === "p2" ? "RIVAL" : id,
  });
  settings.setHpDisplay("hearts");
  hud.update(mkState({
    hp: 75,
    maxHp: 100,
    isArena: true,
    arenaMatch: match,
    isCleared: true,
    waitLabel: "1/2 READY TO GO DOWN",
    party: [
      { id: "p2", name: "Rival", hp: 50, maxHp: 100, colorIndex: 2, isDown: false, isAbsent: false },
    ],
  }));
  const hearts = root.querySelector<HTMLElement>("[data-hearts]")!;
  const hpBar = root.querySelector<HTMLElement>("[data-arena-hp]")!;
  const hpFill = root.querySelector<HTMLElement>("[data-arena-hp-fill]")!;
  const hpNum = root.querySelector<HTMLElement>("[data-hpnum]")!;
  check("100-HP arena renders zero heart canvases", hearts.childElementCount === 0);
  check("heart row is hidden and the single bar is visible",
    hearts.classList.contains("hidden") && !hpBar.classList.contains("hidden") && hpBar.querySelectorAll("i").length === 1);
  check("bar fill tracks current/max continuously", hpFill.style.transform === "scaleX(0.75)", hpFill.style.transform);
  check("numeric HP remains visible even under the hearts-only preference",
    hpNum.textContent === "75/100" && !hpNum.classList.contains("hidden"));

  section("arena HUD: authoritative scoreboard/timer replaces all co-op floor and exit copy");
  const objective = root.querySelector<HTMLElement>("[data-objective]")!;
  const waitline = root.querySelector<HTMLElement>("[data-waitline]")!;
  const board = root.querySelector<HTMLElement>("[data-arena-board]")!;
  check("objective lane is the arena timer and local frag score",
    objective.textContent === "ARENA \u00b7 4:59 \u00b7 3 FRAGS", objective.textContent ?? "");
  check("arena objective cannot contain floor-clear or descend copy",
    !/FLOOR|CLEAR|GO DOWN/.test(objective.textContent ?? ""));
  check("READY TO GO DOWN is suppressed defensively",
    !waitline.classList.contains("show") && waitline.textContent === "");
  check("opponents never render as co-op party HP rows", root.querySelectorAll(".party-row").length === 0);
  check("PvE kill and coin chips are hidden in arena", root.querySelector("[data-statrow]")?.classList.contains("hidden") === true);
  check("scoreboard title and rows render",
    board.querySelector(".arena-board-title")?.textContent === "FRAGS"
    && board.querySelectorAll(".arena-score").length === 2);
  check("self row and dead opponent state are distinct",
    board.querySelector(".arena-score.self .arena-score-name")?.textContent === "YOU"
    && board.querySelector(".arena-score.dead .arena-score-name")?.textContent === "RIVAL");

  section("arena HUD: countdown, respawn, and result share the fixed center slot");
  const center = root.querySelector<HTMLElement>("[data-arena-center]")!;
  const countdown = buildArenaMatchHud({
    match: { ph: "countdown", end: 160, sc: [{ id: "p1", f: 0, a: true }], win: null },
    tick: 100,
    selfId: "p1",
    respawnTicks: 0,
    nameOf: () => "YOU",
  });
  hud.update(mkState({ hp: 100, maxHp: 100, isArena: true, arenaMatch: countdown }));
  check("countdown renders from match.end and snapshot.tick",
    center.querySelector(".arena-center-title")?.textContent === "3"
    && center.querySelector(".arena-center-detail")?.textContent === "GET READY");
  const respawning = buildArenaMatchHud({
    match: { ph: "live", end: 6080, sc: [{ id: "p1", f: 3, a: false }], win: null },
    tick: 100,
    selfId: "p1",
    respawnTicks: 41,
    nameOf: () => "YOU",
  });
  hud.update(mkState({ hp: 0, maxHp: 100, isArena: true, arenaMatch: respawning }));
  check("respawn state renders the authoritative self.rsp countdown",
    center.textContent === "YOU WERE FRAGGEDRESPAWNING IN 3");
  const result = buildArenaMatchHud({
    match: { ph: "over", end: 0, sc: [{ id: "p1", f: 8, a: true }], win: "p1" },
    tick: 100,
    selfId: "p1",
    respawnTicks: 0,
    nameOf: () => "YOU",
  });
  hud.update(mkState({ hp: 100, maxHp: 100, isArena: true, arenaMatch: result }));
  check("result renders from match.win", center.textContent === "VICTORY");

  section("co-op control: the original heart and FLOOR/CLEAR/GO DOWN path returns unchanged");
  settings.setHpDisplay("both");
  hud.update(mkState({ hp: 5, maxHp: 6, isArena: false, arenaMatch: null, isCleared: true }));
  check("co-op restores its six-heart row", hearts.childElementCount === 6 && !hearts.classList.contains("hidden"));
  check("co-op hides the arena bar and scoreboard",
    hpBar.classList.contains("hidden") && board.classList.contains("hidden"));
  check("co-op restores its kill and coin chips", root.querySelector("[data-statrow]")?.classList.contains("hidden") === false);
  check("co-op keeps its original cleared-floor objective",
    objective.textContent === "FLOOR 2 \u00b7 CLEAR \u00b7 GO DOWN");
  root.remove();
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
  check("fighting floor leads with the floor then the enemies-left copy", objective.textContent === "FLOOR 2 \u00b7 3 ENEMIES LEFT" && objective.classList.contains("show"));
  hud.update(mkState({ enemiesLeft: 1 }));
  check("singular enemy copy", objective.textContent === "FLOOR 2 \u00b7 1 ENEMY LEFT");
  hud.update(mkState({ enemiesLeft: 0 }));
  check("uncleared with an empty board reads INCOMING (never a lying zero)", objective.textContent === "FLOOR 2 \u00b7 ENEMIES INCOMING\u2026");
  hud.update(mkState({ isCleared: true, enemiesLeft: 0 }));
  check("cleared floor flips to FLOOR CLEAR \u00b7 GO DOWN with the clear accent",
    objective.textContent === "FLOOR 2 \u00b7 CLEAR \u00b7 GO DOWN" && objective.classList.contains("clear"));
  hud.update(mkState({ isCleared: true, enemiesLeft: 0, isParty: true }));
  check("a party's cleared floor reads MEET AT EXIT (the coordination moment)",
    objective.textContent === "FLOOR 2 \u00b7 CLEAR \u00b7 MEET AT EXIT");

  section("floor-mutator readout: legible, and collapsed off deep floors (no layout shift)");
  const mutators = root.querySelector<HTMLElement>("[data-mutators]")!;
  hud.update(mkState({ mutators: [] }));
  check("no mutators: the readout is empty and collapsed (ordinary floor stays pristine)",
    mutators.textContent === "" && !mutators.classList.contains("has-mutators"));
  hud.update(mkState({ mutators: ["Molten Floor", "Thin Air"] }));
  check("active mutators read as a compact middot-joined list",
    mutators.textContent === "Molten Floor \u00b7 Thin Air" && mutators.classList.contains("has-mutators"));
  hud.update(mkState({ mutators: [] }));
  check("clearing the mutators collapses the readout again", mutators.textContent === "" && !mutators.classList.contains("has-mutators"));

  hud.update(mkState({ isBossActive: true, bossHpFrac: 0.8, combo: 4, comboMult: 1.5, comboFrac: 0.5 }));
  check("a boss shows the bar + the floor stays readable (FLOOR N, no enemy count)",
    root.querySelector("[data-bossbar]")!.classList.contains("show") && objective.textContent === "FLOOR 2");
  check("the lane marks boss so the combo yields at 70%", lane.classList.contains("boss"));

  section("boss bar label: the tracked boss's authored name (flavor-spec canon)");
  const bossLabel = root.querySelector<HTMLElement>("[data-bossname]")!;
  const rosterNames = {
    boss: "The Slime King",
    marrow: "Marrow",
    weaver: "The Weaver",
    gilded: "The Gilded Warden",
    choir: "The Hollow Choir",
  } as const;
  for (const kind of Object.keys(rosterNames) as (keyof typeof rosterNames)[]) {
    check(`kind "${kind}" resolves to its authored name`, bossDisplayName(kind) === rosterNames[kind], bossDisplayName(kind));
    hud.update(mkState({ isBossActive: true, bossHpFrac: 0.6, bossName: bossDisplayName(kind) }));
    check(`the bar titles the ${kind} fight with its real name`,
      bossLabel.textContent === rosterNames[kind], bossLabel.textContent ?? "");
  }
  hud.update(mkState({ isBossActive: true, bossHpFrac: 0.6, bossName: "" }));
  check("an unauthored kind falls back to the generic BOSS label", bossLabel.textContent === "BOSS");
  hud.update(mkState({ isBossActive: false, combo: 4, comboMult: 1.5, comboFrac: 0.5 }));
  check("boss down: the lane releases and the objective returns",
    !lane.classList.contains("boss") && objective.classList.contains("show"));

  hud.update(mkState({ isObjectiveHidden: true }));
  check("the sandbox has no objective line", !objective.classList.contains("show"));

  section("UI Director hierarchy: the co-op wait line rides the lane; BL carries ONLY the dash");
  hud.update(mkState({ waitLabel: "WAITING AT EXIT \u00b7 1/2 \u2014 WAITING FOR GF" }));
  check("the coordination copy shows in the lane's wait slot",
    waitline.classList.contains("show") && waitline.textContent!.includes("WAITING AT EXIT"));
  hud.update(mkState());
  check("no coordination owed -> the wait slot fades (fixed height, no shift)", !waitline.classList.contains("show"));

  // The interact prompt is world-anchored now (a floating [E] chip drawn on the canvas over
  // its target — Game.renderInteractPrompt), so the bottom-left chrome carries only the dash.
  const bl = root.querySelector(".hud-corner.bl")!;
  check("the BL corner keeps the dash meter", bl.querySelector(".dash") !== null);
  check("the detached bottom-left interact prompt is gone from chrome", root.querySelector("[data-prompt]") === null);

  hud.clear();
  check("clear() resets the lane states",
    !objective.classList.contains("show") && !lane.classList.contains("boss"));

  section("objectiveCopy: the canonical strings");
  check("N ENEMIES LEFT", objectiveCopy(false, 7) === "7 ENEMIES LEFT");
  check("FLOOR CLEAR \u00b7 GO DOWN", objectiveCopy(true, 0) === "FLOOR CLEAR \u00b7 GO DOWN");
  check("cleared wins regardless of a stale count", objectiveCopy(true, 3) === "FLOOR CLEAR \u00b7 GO DOWN");
  check("party cleared copy points at the MEET", objectiveCopy(true, 0, true) === "FLOOR CLEAR \u00b7 MEET AT EXIT");
}

// ---- Patch's shop: the state-copy matrix + the compact panel (accepted UX call) ----

function shopCopyTests(): void {
  section("shopActionCopy: the accepted state matrix, exact strings");
  check("affordable reads BUY \u00b7 N COINS", shopActionCopy("buy", 12, 30) === "BUY \u00b7 12 COINS");
  check("a 1-coin price stays grammatical", shopActionCopy("buy", 1, 30) === "BUY \u00b7 1 COIN");
  check("broke reads NEED N MORE COINS (the exact shortfall, coins named)", shopActionCopy("broke", 12, 9) === "NEED 3 MORE COINS");
  check("sold reads SOLD", shopActionCopy("sold", 12, 30) === "SOLD");
  check("owned reads OWNED", shopActionCopy("owned", 12, 30) === "OWNED");
  check("a capped hotbar reads HOTBAR FULL", shopActionCopy("full", 12, 30) === "HOTBAR FULL");
  check("maxed blessing reads MAX LV", shopActionCopy("maxLevel", 24, 30) === "MAX LV");
  check("full-HP heart reads FULL HEALTH", shopActionCopy("fullHealth", 6, 30) === "FULL HEALTH");
  check("spent reroll reads NO REROLLS LEFT", shopActionCopy("exhausted", 8, 30) === "NO REROLLS LEFT");

  section("shopOwnershipCopy: ownership is EXPLICIT, never ambiguous");
  const shop = buildShopState(0xDEA1, 3, generateDungeon(0xDEA1, 3).rooms.find((r) => r.kind === "shop")!);
  const weapon = shop.slots.find((s) => s.kind === "weapon")!;
  const blessing = shop.slots.find((s) => s.kind === "blessing")!;
  const heart = shop.slots.find((s) => s.kind === "heart")!;
  const reroll = shop.slots.find((s) => s.kind === "reroll")!;
  check("shared weapon pedestal: SHARED \u2014 FIRST BUY CLAIMS", shopOwnershipCopy(weapon) === "SHARED \u2014 FIRST BUY CLAIMS");
  check("personal blessing pedestal: FOR YOU", shopOwnershipCopy(blessing) === "FOR YOU");
  check("heart station: FOR YOU", shopOwnershipCopy(heart) === "FOR YOU");
  check("reroll post: SHARED \u2014 RESTOCKS FOR EVERYONE", shopOwnershipCopy(reroll) === "SHARED \u2014 RESTOCKS FOR EVERYONE");

  section("shopChipCopy: pedestal shelf chips — price when for sale, the state word when not");
  check("buyable chip is the bare price", shopChipCopy("buy", 12) === "12c" && shopChipCopy("broke", 12) === "12c");
  check("blocked chips carry the state word",
    shopChipCopy("sold", 12) === "SOLD" && shopChipCopy("owned", 12) === "OWNED"
    && shopChipCopy("maxLevel", 24) === "MAX LV" && shopChipCopy("fullHealth", 6) === "FULL HEALTH");

  section("status grouping: broke stays LIVE; everything else non-buy is RESOLVED");
  check("buy and broke are never in the resolved group",
    !isResolvedShopStatus("buy") && !isResolvedShopStatus("broke"));
  check("sold/owned/maxLevel/fullHealth/exhausted all resolve",
    (["sold", "owned", "maxLevel", "fullHealth", "exhausted"] as const).every(isResolvedShopStatus));

  section("shopFooterCopy: the explicit multi-buy framing, state-dependent");
  const rich = shopViewerOf(viewerSrc({ coins: 99 }));
  const poor = shopViewerOf(viewerSrc({ coins: 0 }));
  check("your own buy reads BOUGHT ✓ · other stations still open",
    shopFooterCopy(shop, rich, true) === "BOUGHT \u2713 \u00b7 other stations still open");
  check("with affordable stations the footer says spend at ANY of them",
    shopFooterCopy(shop, rich, false) === "Spend at any station you can afford");
  check("with nothing affordable the footer says earn and come back",
    shopFooterCopy(shop, poor, false) === "Earn more coins and come back before you descend");
}

function shopPanelTests(): void {
  section("shop panel: compact, labeled, keyboard-first, aria-correct");
  const shop = buildShopState(0xDEA1, 3, generateDungeon(0xDEA1, 3).rooms.find((r) => r.kind === "shop")!);
  const weapon = shop.slots.find((s) => s.kind === "weapon")!;
  const viewerOf = (coins: number) => shopViewerOf(viewerSrc({ coins, ownedWeapons: ["pistol"] }));
  const mods = createMods();

  const panel = new ShopPanel();
  const bought: number[] = [];
  let closes = 0;
  panel.open(shopPanelView(shop, weapon, viewerOf(30), mods, 3), (slot) => bought.push(slot), () => closes++);
  const root = document.querySelector<HTMLElement>(".shop-panel")!;
  const buy = root.querySelector<HTMLButtonElement>(".shop-buy")!;
  check("opens as a labeled dialog", panel.isOpen && root.getAttribute("role") === "dialog"
    && root.getAttribute("aria-labelledby") === "shop-item-name");
  // The stat line derives from weaponDisplayStats (the ONE live model the hotbar tooltip
  // reads): role verb first, then POWER + the shared CADENCE/REACH/COVERAGE bands.
  const expectedStats = weaponDisplayStats(weapon.weapon!, createMods(), 0);
  const lineTexts = [...root.querySelectorAll(".shop-lines p")].map((p) => p.textContent!);
  check("the item is fully labeled: name + kind + ownership + the tooltip-model stat line",
    root.textContent!.includes("WEAPON") && root.textContent!.includes("SHARED \u2014 FIRST BUY CLAIMS")
    && lineTexts[0] === expectedStats.role
    && new RegExp(`^POWER [\\d.]+.* \\u00b7 ${expectedStats.cadence.band} \\u00b7 ${expectedStats.reach.band} \\u00b7 ${expectedStats.coverage.kind}$`).test(lineTexts[1]));
  check("the action row is a real focusable button with a live region",
    buy.tagName === "BUTTON" && buy.getAttribute("aria-live") === "polite" && document.activeElement === buy);
  const buyLabel = () => buy.querySelector(".shop-buy-label")?.textContent ?? "";
  check("affordable: BUY \u00b7 12 COINS, enabled, no glyph, live classes only",
    buyLabel() === "BUY \u00b7 12 COINS" && !buy.disabled
    && buy.querySelector(".shop-buy-glyph") === null
    && !buy.classList.contains("resolved") && !buy.classList.contains("broke"));
  check("the header anchors the viewer's live balance (aria-live on change only)",
    root.querySelector(".shop-coins")?.textContent === "YOUR COINS: 30"
    && root.querySelector(".shop-coins")?.getAttribute("aria-live") === "polite");
  check("the footer frames the multi-buy contract while stations are affordable",
    root.querySelector(".shop-foot")?.textContent === "Spend at any station you can afford");

  buy.click();
  check("clicking BUY sends exactly one buy intent for the focused slot",
    bought.length === 1 && bought[0] === weapon.id);

  // The buyer's own claim lands: the panel STAYS OPEN, resolves to OWNED, and the footer
  // reinforces "keep shopping" — a buy is never a silent close.
  weapon.soldTo = "local";
  panel.update(shopPanelView(shop, weapon, shopViewerOf(viewerSrc({ coins: 18, ownedWeapons: ["pistol", weapon.weapon!] })), mods, 3, true));
  check("your own buy keeps the panel open and resolves to OWNED",
    panel.isOpen && buyLabel() === "OWNED" && buy.disabled);
  check("the resolved row wears the muted group's check (distinct from broke in grayscale)",
    buy.classList.contains("resolved") && buy.querySelector(".shop-buy-glyph")?.textContent === "\u2713"
    && buy.querySelector(".shop-buy-glyph")?.getAttribute("aria-hidden") === "true");
  check("the BOUGHT ✓ footer names the other stations still open",
    root.querySelector(".shop-foot")?.textContent === "BOUGHT \u2713 \u00b7 other stations still open"
    && root.querySelector(".shop-foot")!.classList.contains("bought"));
  check("the balance ticks down after the buy", root.querySelector(".shop-coins")?.textContent === "YOUR COINS: 18");

  // The authoritative claim lands for a TEAMMATE (they won the race): the open panel
  // re-renders to an honest SOLD and the buy control disables — no ambiguous depletion.
  weapon.soldTo = "teammate";
  panel.update(shopPanelView(shop, weapon, viewerOf(30), mods, 3));
  check("a mid-look claim flips the row to SOLD and disables it",
    buyLabel() === "SOLD" && buy.disabled && buy.classList.contains("resolved"));
  buy.click();
  check("a disabled row sends nothing", bought.length === 1);

  weapon.soldTo = null;
  panel.update(shopPanelView(shop, weapon, viewerOf(3), mods, 3));
  check("broke re-render reads NEED 9 MORE COINS, disabled", buyLabel() === "NEED 9 MORE COINS" && buy.disabled);
  check("broke is the LIVE unaffordable group: coin glyph, .broke, never .resolved",
    buy.classList.contains("broke") && !buy.classList.contains("resolved")
    && buy.querySelector(".shop-buy-glyph canvas") !== null);
  check("the balance follows the viewer live", root.querySelector(".shop-coins")?.textContent === "YOUR COINS: 3");
  check("with nothing affordable the footer says earn and come back",
    root.querySelector(".shop-foot")?.textContent === "Earn more coins and come back before you descend");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes and fires onClose exactly once", !panel.isOpen && closes === 1);

  // Keyboard purchase: Enter on the focused (buyable) row buys.
  panel.open(shopPanelView(shop, weapon, viewerOf(30), mods, 3), (slot) => bought.push(slot), () => closes++);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  check("Enter buys from the keyboard", bought.length === 2 && bought[1] === weapon.id);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
  check("E closes the panel too (the same key that opened it)", !panel.isOpen && closes === 2);

  // The blessing view carries the pick-card language (NEW/UPGRADE + exact effect).
  const blessing = shop.slots.find((s) => s.kind === "blessing")!;
  const bView = shopPanelView(shop, blessing, viewerOf(30), mods, 3);
  check("a fresh blessing is tagged NEW with its exact Lv1 effect line",
    bView.tag === "NEW" && bView.lines.length >= 1 && bView.ownership === "FOR YOU");
  const upView = shopPanelView(shop, blessing, shopViewerOf(viewerSrc({ ownedWeapons: ["pistol"], ownedItemIds: [blessing.itemId!] })), mods, 3);
  check("an owned blessing is tagged UPGRADE LV2 (the level this buy reaches)", upView.tag === "UPGRADE LV2");
}

// KIT/XP spec §6 HUD dependencies: HP-number display modes, the teammate-HP party panel,
// and the universal ult meter (separate from combo/Resonance).
function kitHudTests(): void {
  section("HP number display modes (hearts / hearts+number / number-only)");
  const root = document.createElement("div");
  const hud = new Hud(root);
  settings.setHpDisplay("both");
  hud.update(mkState({ hp: 5, maxHp: 6 }));
  const hpNum = root.querySelector("[data-hpnum]") as HTMLElement;
  const hearts = root.querySelector("[data-hearts]") as HTMLElement;
  check("both: numeric HP reads current/max", hpNum.textContent === "5/6", hpNum.textContent ?? "");
  check("both: hearts + number both visible", !hearts.classList.contains("hidden") && !hpNum.classList.contains("hidden"));
  settings.setHpDisplay("hearts");
  hud.update(mkState({ hp: 5, maxHp: 6 }));
  check("hearts-only: the number is hidden", hpNum.classList.contains("hidden") && !hearts.classList.contains("hidden"));
  settings.setHpDisplay("number");
  hud.update(mkState({ hp: 5, maxHp: 6 }));
  check("number-only: the heart row is hidden", hearts.classList.contains("hidden") && !hpNum.classList.contains("hidden"));
  settings.setHpDisplay("both"); // restore default

  section("teammate HP party panel (the Mender dependency)");
  hud.update(mkState({
    party: [
      { id: "p1", name: "Ada", hp: 3, maxHp: 8, colorIndex: 2, isDown: false, isAbsent: false },
      { id: "p2", name: "Bo", hp: 0, maxHp: 6, colorIndex: 1, isDown: true, isAbsent: false },
      { id: "p3", name: "Cy", hp: 4, maxHp: 6, colorIndex: null, isDown: false, isAbsent: true },
    ],
  }));
  const rows = root.querySelectorAll("[data-party] .party-row");
  check("one nameplate row per teammate", rows.length === 3, `rows=${rows.length}`);
  const first = rows[0];
  check("a living teammate shows numeric HP", (first.querySelector(".party-hp") as HTMLElement).textContent === "3/8");
  check("a downed teammate reads DOWN + carries the down class", rows[1].classList.contains("down") && (rows[1].querySelector(".party-hp") as HTMLElement).textContent === "DOWN");
  check("an absent teammate carries the away class", rows[2].classList.contains("away"));
  hud.update(mkState({ party: [] }));
  check("solo clears the party panel", root.querySelectorAll("[data-party] .party-row").length === 0);

  section("universal ult meter: NAMED + LOUD ready (separate from combo/Resonance)");
  hud.update(mkState({ ult: null }));
  const ult = root.querySelector("[data-ult]") as HTMLElement;
  const ultK = root.querySelector("[data-ult-k]") as HTMLElement;
  const ultRdy = root.querySelector("[data-ult-rdy]") as HTMLElement;
  const ultKey = root.querySelector("[data-ult-key]") as HTMLElement;
  const ultPct = root.querySelector("[data-ult-pct]") as HTMLElement;
  const ultFill = root.querySelector("[data-ult-fill]") as HTMLElement;
  const cluster = root.querySelector("[data-klcluster]") as HTMLElement;
  const kitBadge = root.querySelector("[data-kitbadge]") as HTMLElement;
  check("a neutral-kit player hides the ult meter AND the kit badge", ult.hasAttribute("hidden") && kitBadge.hasAttribute("hidden"));
  hud.update(mkState({ ult: { charge: 0.5, isReady: false, cd: 0, kit: "gunner", name: "Overdrive" } }));
  check("a charging meter is visible and not ready", !ult.hasAttribute("hidden") && !ult.classList.contains("ready"));
  check("the fill reflects the charge", (root.querySelector("[data-ult-fill]") as HTMLElement).style.getPropertyValue("--ult-fill") === "0.5");
  check("the meter is NAMED by the kit's ult (fixes 'idk what my ult is')", ultK.textContent === "OVERDRIVE");
  check("charging shows a low-emphasis NN% readout", ultPct.textContent === "50%");
  check("the READY suffix is present but hidden while charging (reserved, never a reflow)", !ultRdy.classList.contains("show"));
  check("the kit BADGE answers 'which class am I' (name + accent)", !kitBadge.hasAttribute("hidden")
    && (root.querySelector("[data-kit-name]") as HTMLElement).textContent === "GUNNER");
  check("the cluster carries the kit accent for gunner", cluster.getAttribute("data-kit") === "gunner");
  hud.update(mkState({ ult: { charge: 1, isReady: true, cd: 0, kit: "gunner", name: "Overdrive" } }));
  check("a full meter lights the LOUD ready: <ULT> READY, keycap active", ult.classList.contains("ready")
    && ultK.textContent === "OVERDRIVE" && ultRdy.classList.contains("show") && ultKey.classList.contains("is-active"));
  check("the full ready line reads 'OVERDRIVE READY'", (ultK.textContent + ultRdy.textContent) === "OVERDRIVE READY");
  check("READY is a SOLID block (fill=1), the loud read (grayscale-distinct from a partial fill)", ultFill.style.getPropertyValue("--ult-fill") === "1");
  check("READY drops the NN% readout (the name already says READY)", ultPct.textContent === "");
  hud.update(mkState({ ult: { charge: 0, isReady: false, cd: 0.75, kit: "gunner", name: "Overdrive" } }));
  check("after a cast the 8s cooldown state shows, never ready", ult.classList.contains("cd")
    && !ult.classList.contains("ready") && !ultKey.classList.contains("is-active"));
  check("LOCKOUT REFILLS from 0 (1-cd), unconfusable with the solid ready block", ultFill.style.getPropertyValue("--ult-fill") === "0.25");
  check("LOCKOUT shows a countdown (Ns), not a percent", ultPct.textContent === "6s");
  // A different kit reads distinct: name + accent both change (no confusion with the amber gunner).
  hud.update(mkState({ ult: { charge: 0.3, isReady: false, cd: 0, kit: "mender", name: "Sanctuary" } }));
  check("switching kits re-names + re-tints the meter (Sanctuary / mender accent)",
    ultK.textContent === "SANCTUARY" && cluster.getAttribute("data-kit") === "mender"
    && (root.querySelector("[data-kit-name]") as HTMLElement).textContent === "MENDER");
  check("pulseUlt is the leading-edge flash ping (re-triggerable, opacity-only, never a layout shift)", (() => {
    const fill = root.querySelector("[data-ult-fill]") as HTMLElement;
    fill.classList.remove("mote-pulse");
    hud.pulseUlt();
    return fill.classList.contains("mote-pulse");
  })());
}

// The neutral-kit HIDE PATH: a kit="none" / ult===null player must show NO kit/ult/signature
// chrome — never a nameless "ULT" + fallback accent. Two independent halves must both hold:
//   (1) the HUD JS SETS the `hidden` attribute on every kit/sig element (and clears data-kit), and
//   (2) index.html has a CSS rule that makes that `hidden` attribute actually hide the element.
// Half (2) is the real bug: the chrome carries an explicit `display`, which OVERRIDES the UA
// [hidden]{display:none} (author origin beats UA regardless of specificity), so without a
// companion author `[hidden]` rule the element paints anyway. jsdom cannot reproduce the
// browser's origin cascade (it reports display:none either way), so this half is guarded by
// asserting the rule's PRESENCE + specificity in the shipped stylesheet.
function kitChromeHideTests(): void {
  section("neutral-kit hide path: the JS hides the whole kit/ult/signature cluster");
  const root = document.createElement("div");
  const hud = new Hud(root);
  hud.update(mkState({ ult: null, sig: null }));
  const ult = root.querySelector("[data-ult]") as HTMLElement;
  const kitBadge = root.querySelector("[data-kitbadge]") as HTMLElement;
  const momentum = root.querySelector("[data-momentum]") as HTMLElement;
  const oshield = root.querySelector("[data-oshield]") as HTMLElement;
  const pulse = root.querySelector("[data-pulse]") as HTMLElement;
  const cluster = root.querySelector("[data-klcluster]") as HTMLElement;
  const dash = root.querySelector(".dash") as HTMLElement;
  check("ult meter is hidden", ult.hasAttribute("hidden"));
  check("kit badge is hidden", kitBadge.hasAttribute("hidden"));
  check("HEAT (momentum) signature is hidden", momentum.hasAttribute("hidden"));
  check("overshield signature is hidden", oshield.hasAttribute("hidden"));
  check("PULSE signature is hidden", pulse.hasAttribute("hidden"));
  check("no kit accent is set on the cluster", !cluster.hasAttribute("data-kit"));
  check("the always-on DASH meter stays present and NOT hidden", dash !== null && !dash.hasAttribute("hidden"));
  // A real kit lights the chrome back up (the attribute is cleared) — the fix stays correct once
  // solo gets a kit, and only the neutral state is stripped.
  hud.update(mkState({ ult: { charge: 0.4, isReady: false, cd: 0, kit: "gunner", name: "Overdrive" }, sig: { momentum: { stacks: 2, max: 5, isOverheat: false }, overshield: null, pulse: null } }));
  check("a real kit un-hides the ult meter + kit badge + its signature", !ult.hasAttribute("hidden") && !kitBadge.hasAttribute("hidden") && !momentum.hasAttribute("hidden"));

  section("neutral-kit hide path: index.html makes [hidden] actually hide the chrome");
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
  const css = html.replace(/\s+/g, " ");
  // ONE global reset kills the whole class of bug: any authored `display:` defeats the UA
  // [hidden] rule, so a bare, high-specificity-proof `[hidden]{display:none !important}` is what
  // guarantees the (correctly attribute-toggled) chrome actually disappears — no per-element
  // patch needed, and no future toggled element re-opens the landmine.
  // A BARE `[hidden]` selector (not a compound like `.ultmeter[hidden]`): the char before it must
  // not continue a selector token (alnum / . / # / - / _ / ] / )).
  check("a single global [hidden]{display:none !important} reset ships in the CSS",
    /[^A-Za-z0-9_.#\]\)-]\s*\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css));
  // The kit/ult/signature chrome carries an explicit `display` (the exact trap), so the global
  // rule must not be undone by a later, more-specific author rule re-showing them while hidden.
  for (const cls of ["ultmeter", "kitbadge", "momentum", "pulse", "oshield"]) {
    const reShow = new RegExp(`\\.${cls}\\[hidden\\][^{]*\\{[^}]*display\\s*:\\s*(?!none)`);
    check(`no author rule re-shows .${cls} while it carries [hidden]`, !reShow.test(css));
  }
}

// HEAT DECLUTTER: a Gunner's HEAT/momentum pip row is a *readout* — an empty 0-stack row is
// pure clutter, so it earns a row ONLY once heat is building (stacks > 0) or the boil-over burst
// is live. The kit is still a Gunner, so the ult meter + kit badge stay up; only the pip row
// hides. Two guarantees ride along: the hide is a real display:none REMOVAL FROM FLOW (never a
// space-reserving visibility/opacity), and — because the row sits ABOVE the bottom-anchored DASH
// — collapsing it must not move DASH.
function heatDeclutterTests(): void {
  section("HEAT declutter: the momentum row hides at 0 stacks, appears once heat is relevant");
  const root = document.createElement("div");
  document.body.appendChild(root); // connected so the UA [hidden]{display:none} rule resolves
  const hud = new Hud(root);
  const gunner: NonNullable<HudState["ult"]> = { charge: 0.5, isReady: false, cd: 0, kit: "gunner", name: "Overdrive" };
  type Momentum = NonNullable<NonNullable<HudState["sig"]>["momentum"]>;
  const sigWith = (momentum: Momentum): Partial<HudState> => ({ ult: gunner, sig: { momentum, overshield: null, pulse: null } });
  const momentum = root.querySelector("[data-momentum]") as HTMLElement;
  const pips = root.querySelector("[data-momentum-pips]") as HTMLElement;
  const kitBadge = root.querySelector("[data-kitbadge]") as HTMLElement;
  const ult = root.querySelector("[data-ult]") as HTMLElement;
  const displayOf = (el: HTMLElement) => dom.window.getComputedStyle(el).display;

  hud.update(mkState(sigWith({ stacks: 0, max: 5, isOverheat: false })));
  check("a Gunner idling at 0 stacks (not overheating) earns NO HEAT row", momentum.hasAttribute("hidden"));
  // The hide is a real display:none REMOVAL from flow (jsdom honors the UA [hidden]{display:none}),
  // so the row reserves ZERO space — the declutter is real, not a blanked-but-present gap.
  check("the hidden HEAT row is display:none (removed from flow, reserves no space)", displayOf(momentum) === "none");
  check("the kit stays a Gunner: ult meter + kit badge remain shown at 0 stacks",
    !ult.hasAttribute("hidden") && !kitBadge.hasAttribute("hidden"));

  hud.update(mkState(sigWith({ stacks: 1, max: 5, isOverheat: false })));
  check("the HEAT row appears the instant heat starts building (stacks > 0)",
    !momentum.hasAttribute("hidden") && displayOf(momentum) !== "none");
  check("the row lights exactly the built pips", [...pips.children].filter((p) => p.classList.contains("on")).length === 1);

  hud.update(mkState(sigWith({ stacks: 0, max: 5, isOverheat: true })));
  check("the boil-over burst shows the row even at 0 stacks (overheat is relevant)",
    !momentum.hasAttribute("hidden") && momentum.classList.contains("overheat"));

  hud.update(mkState(sigWith({ stacks: 0, max: 5, isOverheat: false })));
  check("dropping back to a cold 0 stacks hides the row again", momentum.hasAttribute("hidden"));

  section("HEAT declutter: DASH never jumps when the HEAT row hides/shows (the no-jump guarantee)");
  const cluster = root.querySelector("[data-klcluster]") as HTMLElement;
  const dash = root.querySelector(".dash") as HTMLElement;
  const kids = [...cluster.children];
  // The structural precondition for the collapse-upward, no-jump behavior: DASH is the terminal
  // flow child (pinned to the corner's bottom edge) and HEAT is a sibling ABOVE it.
  check("DASH is the bottom-pinned terminal row, with HEAT stacked above it",
    kids[kids.length - 1] === dash && kids.indexOf(momentum) < kids.indexOf(dash));
  // jsdom has no layout engine (getBoundingClientRect is all-zero, verified), so the no-jump
  // proof is its MECHANISM, not a pixel diff: HEAT collapses to display:none ABOVE a
  // bottom-anchored DASH, so DASH's flow position can't shift. We assert DASH itself is
  // unaffected across the toggle, and pin the bottom-anchor invariant in the shipped CSS.
  hud.update(mkState(sigWith({ stacks: 3, max: 5, isOverheat: false })));
  const dashShown = { present: !dash.hasAttribute("hidden"), display: displayOf(dash), top: dash.getBoundingClientRect().top };
  hud.update(mkState(sigWith({ stacks: 0, max: 5, isOverheat: false })));
  const dashHidden = { present: !dash.hasAttribute("hidden"), display: displayOf(dash), top: dash.getBoundingClientRect().top };
  check("DASH stays present + painting whether HEAT is shown or hidden",
    dashShown.present && dashHidden.present && dashShown.display === dashHidden.display && dashShown.display !== "none");
  check("DASH's box is identical with HEAT shown vs hidden (no jump)", dashShown.top === dashHidden.top);

  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
  check("the BL cluster is bottom-anchored in the shipped CSS (so it collapses upward, DASH pinned)",
    /\.hud-corner\.bl\s*\{[^}]*\bbottom\s*:/.test(html));
  root.remove();
}

function main(): void {
  weaponSlotTests();
  weaponTooltipTests();
  kitHudTests();
  kitChromeHideTests();
  heatDeclutterTests();
  buffChipTests();
  buffOverflowTests();
  blessingCardTests();
  drawerTests();
  hudIntegrationTests();
  arenaHudDomTests();
  hierarchyTests();
  shopCopyTests();
  shopPanelTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll HUD DOM assertions passed.\n");
}

main();
