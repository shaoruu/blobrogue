// ?dev=1 — the creative-mode sandbox. Boots the REAL Game into a single open arena and
// bolts a DOM control panel onto it. Everything here talks to the game exclusively
// through the dev* hooks on the Game class, so this file owns zero game internals.

import { Game } from "../game/game.js";
import type { DevSnapshot } from "../game/game.js";
import type { EnemyTier } from "../sim/balance.js";
import type { EnemyKind, PropKind, WeaponId, SpriteName } from "../sim/types.js";
import type { MutatorId, RollAffixId, BossAffixId } from "../sim/floorRolls.js";
import { ITEMS } from "../sim/items.js";
import { KIT_IDS, KIT_META } from "../sim/kits.js";
import type { KitId } from "../sim/kits.js";
import { WEAPONS } from "../sim/weapons.js";
import { weaponDisplayStats } from "../sim/weaponStats.js";
import { createMods } from "../sim/items.js";
import {
  BOSS_FLOORS,
  ENEMY_ARCHETYPES,
  bossDisplayName,
  bossKindForFloor,
} from "../sim/enemies.js";
import { CAMP_NODES } from "../sim/camp_nodes.js";
import { COSMETIC_SLOTS, cosmeticsForSlot, bodyPaletteIndex } from "../game/cosmetics.js";
import type { CosmeticLoadout, CosmeticSlot } from "../game/cosmetics.js";
import type { BlobLook } from "../ui/blobPreview.js";
import { ENEMY_KINDS } from "./sandboxCatalog.js";
import { spriteThumb, spritePreview, blobThumb, blobPreview, blankThumb, textBadge } from "./thumbs.js";
import { injectDevStyles } from "./styles.js";

const WEAPON_IDS: readonly WeaponId[] = [
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam", "sword", "longsword", "spear",
  "lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
  "reaper", "swarm", "midas", "phase", "vortex",
];
// Wave 1 randomness rows: id -> readout label (kept local so the panel owns zero sim internals).
const MUTATORS: ReadonlyArray<readonly [MutatorId, string]> = [
  ["denseDark", "Dense Dark"], ["moltenFloor", "Molten"], ["twinnedElites", "Twinned"],
  ["fractureStorm", "Fracture"], ["amberfall", "Amberfall"], ["thinAir", "Thin Air"],
];
const ROLL_AFFIXES: ReadonlyArray<readonly [RollAffixId, string]> = [
  ["splits", "Splits"], ["shielded", "Shielded"], ["hazardTrail", "Hazard Trail"],
  ["reflect", "Reflect"], ["enrage", "Enrage"],
];
const BOSS_AFFIXES: ReadonlyArray<readonly [BossAffixId, string]> = [
  ["emberwake", "Emberwake"], ["sundering", "Sundering"], ["amberrain", "Amberrain"],
];

const PROP_KINDS: readonly PropKind[] = ["crate", "pot", "barrel", "barrel_explosive", "brazier", "root_wall", "silt_mound", "clinker_brick", "gorge_debris", "pale_debris"];
const PROP_LABEL: Record<PropKind, string> = {
  crate: "Crate", pot: "Pot", barrel: "Barrel", barrel_explosive: "Boom Barrel", brazier: "Brazier",
  root_wall: "Root Wall", silt_mound: "Silt Mound", clinker_brick: "Clinker Brick", gorge_debris: "Shell Debris", pale_debris: "Pale Shell Debris",
};
const FPS_REFRESH_FRAMES = 15;
const FPS_SAMPLE_COUNT = 20;

// Sprite filenames mostly follow WeaponId; melee uses its display-name art filenames.
const WEAPON_ART_ID: Partial<Record<WeaponId, string>> = {
  sword: "cutlass", longsword: "claymore", spear: "pike",
  mortar: "thumper", beam: "beam2_px",
  swarm: "hive", phase: "umbra", vortex: "lodestone",
};
const weaponArtId = (id: WeaponId) => WEAPON_ART_ID[id] ?? id;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A panel button. Blurs on click so a stray Space/Enter can't re-fire it into the game.
function btn(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = h("button", `dev-btn${cls ? " " + cls : ""}`, label);
  b.type = "button";
  b.addEventListener("click", () => { onClick(); b.blur(); });
  return b;
}

// A clickable catalog tile: a thumbnail over a short name. The panel owns the active-state
// highlight (a group toggles `.on`), so this stays a dumb presentational cell.
function catalogCell(thumb: HTMLElement, name: string, onClick: () => void): HTMLDivElement {
  const cell = h("div", "dev-cat-cell");
  cell.appendChild(thumb);
  cell.appendChild(h("div", "dev-cat-name", name));
  cell.addEventListener("click", () => { onClick(); });
  return cell;
}

// A collapsible section. The header toggles a body wrapper; callers append their controls
// to the returned element and they land in the body (an appendChild override keeps every
// existing `sec.appendChild(...)` call site working unchanged). Starts expanded.
function section(title: string): HTMLDivElement {
  const sec = h("div", "dev-sec");
  const header = h("button", "dev-h", title) as HTMLButtonElement;
  header.type = "button";
  const caret = h("span", "dev-caret", "\u25be"); // ▾
  header.appendChild(caret);
  const body = h("div", "dev-body");
  sec.appendChild(header);
  sec.appendChild(body);
  header.addEventListener("click", () => {
    const collapsed = sec.classList.toggle("collapsed");
    caret.textContent = collapsed ? "\u25b8" : "\u25be"; // ▸ / ▾
    header.blur();
  });
  // Route callers' appendChild into the body so section content is collapsible without
  // touching any of the buildPanel call sites.
  (sec as unknown as { appendChild: (n: Node) => Node }).appendChild = (node: Node) => body.appendChild(node);
  return sec;
}

export function bootSandbox(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, overlay: HTMLElement): void {
  injectDevStyles();
  overlay.classList.add("hidden"); // the normal menu never shows in the sandbox

  const game = new Game(
    canvas, minimap, document.body,
    () => game.devStartSandbox(),          // death (god off): just respawn a fresh arena
    () => { window.location.href = window.location.pathname; }, // "quit" leaves dev mode
  );
  game.devStartSandbox();

  // QA scripting handle (dev page only, never the play bundle): lets headless capture
  // rigs drive floors/teleports without brittle UI automation.
  (window as Window & { __game?: Game }).__game = game;

  buildPanel(game);
  const params = new URLSearchParams(window.location.search);
  if (params.get("qa") === "pale") {
    const players = Number.parseInt(params.get("players") ?? "1", 10);
    const phase = Number.parseInt(params.get("phase") ?? "1", 10);
    game.devSetupPaleCapture(players, phase);
    game.devSetBossNameHidden(params.get("hideBossName") !== "0");
    game.devSetHitRadiusVisible(params.get("hitDebug") === "1");
  }
}

function buildPanel(game: Game): void {
  const panel = h("div", "dev-panel");
  const fpsMeter = h("div", "dev-fps-meter");
  const fpsMeterRate = h("span", "rate", "-- FPS");
  const fpsMeterDetail = h("span", "detail", "--.- ms \u00b7 --\u2013--");
  fpsMeter.append(fpsMeterRate, fpsMeterDetail);
  // The game's own loaded sprite registry — catalog thumbnails resolve through it, so a
  // panel entry shows exactly the frame the world renders (never a stale duplicate load).
  const sprites = game.devSprites();

  const title = h("div", "dev-title", "CREATIVE MODE");
  title.appendChild(h("span", "sub", "sandbox \u00b7 spawn \u00b7 test feel"));
  panel.appendChild(title);

  // Shared "spawn under the cursor instead of near the player" toggle.
  const atCursor = h("input");
  atCursor.type = "checkbox";
  const cursorLabel = h("label", "dev-chk");
  cursorLabel.append(atCursor, document.createTextNode("Spawn at cursor"));
  const cursorRow = h("div", "dev-row");
  cursorRow.appendChild(cursorLabel);
  panel.appendChild(cursorRow);
  const isCursor = () => atCursor.checked;

  // ---- spawning ----
  const spawnSec = section("Spawn Enemies");
  // Durability-tier selector: spawns land as the chosen tier so the tier ladder
  // (swarm/standard/elite/brute) can be A/B'd in a controlled arena.
  const tierSel = h("select", "dev-btn") as HTMLSelectElement;
  for (const tier of ["standard", "swarm", "elite", "brute"]) {
    const opt = h("option", "", tier) as HTMLOptionElement;
    opt.value = tier;
    tierSel.appendChild(opt);
  }
  const tierRow = h("div", "dev-row");
  const tierLabel = h("label", "dev-chk");
  tierLabel.append(document.createTextNode("Tier "), tierSel);
  tierRow.appendChild(tierLabel);
  spawnSec.appendChild(tierRow);
  const pickedTier = (): EnemyTier => tierSel.value as EnemyTier;
  for (const kind of ENEMY_KINDS) {
    const row = h("div", "dev-row");
    row.appendChild(spriteThumb(sprites, ENEMY_ARCHETYPES[kind].sprite));
    row.appendChild(h("span", "dev-lbl", kind));
    row.appendChild(btn("1", () => game.devSpawnEnemies(kind, 1, isCursor(), pickedTier()), "mini"));
    row.appendChild(btn("5", () => game.devSpawnEnemies(kind, 5, isCursor(), pickedTier()), "mini"));
    row.appendChild(btn("10", () => game.devSpawnEnemies(kind, 10, isCursor(), pickedTier()), "mini"));
    spawnSec.appendChild(row);
  }
  const clearRow = h("div", "dev-row");
  clearRow.appendChild(btn("Clear all enemies", () => game.devClearEnemies(), "wide danger"));
  spawnSec.appendChild(clearRow);
  panel.appendChild(spawnSec);

  // ---- weapons ----
  const weaponSec = section("Weapons");
  // Live inspection card: hover/focus a weapon to see its pickup + held art and stats;
  // click still equips/adds it. This makes the dev list visual, not a wall of names.
  const weaponPreview = h("div", "dev-weapon-preview");
  const pickupImg = h("img", "dev-weapon-img pickup");
  const heldImg = h("img", "dev-weapon-img held");
  pickupImg.alt = "weapon pickup"; heldImg.alt = "held weapon";
  const art = h("div", "dev-weapon-art"); art.append(pickupImg, heldImg);
  const info = h("div", "dev-weapon-info");
  const previewName = h("div", "dev-weapon-name");
  const previewType = h("div", "dev-weapon-type");
  const previewStats = h("div", "dev-weapon-stats");
  info.append(previewName, previewType, previewStats);
  weaponPreview.append(art, info);
  const showWeapon = (id: WeaponId) => {
    const artId = weaponArtId(id);
    pickupImg.src = `/sprites/weapon_${artId}.png`;
    heldImg.src = `/sprites/held_${artId}.png`;
    // Canonical live stats (src/sim/weaponStats.ts) — the SAME model the in-run drawer +
    // hotbar tooltip render from, so the QA surface can never drift from the sim.
    const card = weaponDisplayStats(id, createMods(), 0);
    previewName.textContent = WEAPONS[id].name.toUpperCase();
    previewType.textContent = card.role;
    const rows = [
      `POWER ${Math.round(card.power.perHit * 10) / 10}${card.power.count > 1 ? ` \u00d7${card.power.count}` : ""}`,
      `IMPACT ${card.impact.band}`, `CADENCE ${card.cadence.band}`, `REACH ${card.reach.band}`,
    ].join("  \u00b7  ");
    const notes = card.mechanics.map((mech) => mech.text).join("  \u00b7  ");
    previewStats.textContent = notes.length > 0 ? `${rows}\n${notes}` : rows;
  };
  showWeapon("pistol");
  weaponSec.appendChild(weaponPreview);
  const weaponRow = h("div", "dev-row");
  const weaponBtns = new Map<WeaponId, HTMLButtonElement>();
  for (const id of WEAPON_IDS) {
    const b = btn(WEAPONS[id].name, () => { game.devGiveWeapon(id); showWeapon(id); }, "mini");
    b.addEventListener("mouseenter", () => showWeapon(id));
    b.addEventListener("focus", () => showWeapon(id));
    weaponBtns.set(id, b);
    weaponRow.appendChild(b);
  }
  weaponSec.appendChild(weaponRow);
  panel.appendChild(weaponSec);

  // ---- blessings / items ----
  const itemSec = section("Blessings");
  itemSec.appendChild(btn("Open blessing chooser", () => game.devOfferBlessing(), "wide"));
  const itemRow = h("div", "dev-row");
  for (const item of ITEMS) {
    const b = btn(item.name, () => game.devGrantItem(item), "mini");
    b.title = item.descs[0];
    itemRow.appendChild(b);
  }
  itemSec.appendChild(itemRow);
  panel.appendChild(itemSec);

  // ---- player / loadout ----
  const playerSec = section("Player");
  const godBtn = btn("God mode: off", () => {
    const on = game.devToggleGod();
    godBtn.textContent = `God mode: ${on ? "on" : "off"}`;
    godBtn.classList.toggle("on", on);
  }, "wide");
  playerSec.appendChild(godBtn);
  const hpRow = h("div", "dev-row");
  hpRow.appendChild(btn("Heal full", () => game.devHealFull(), "mini"));
  hpRow.appendChild(btn("+1 max HP", () => game.devAddMaxHp(1), "mini"));
  hpRow.appendChild(btn("-1 max HP", () => game.devAddMaxHp(-1), "mini"));
  playerSec.appendChild(hpRow);
  panel.appendChild(playerSec);

  // ---- kits + ultimates (spec build-gate: all four kits + their ults testable in isolation) ----
  const kitSec = section("Kits & Ults");
  const kitRow = h("div", "dev-row");
  const kitBtns = new Map<KitId, HTMLButtonElement>();
  const selectKit = (kit: KitId) => {
    game.devSetKit(kit);
    for (const [id, b] of kitBtns) b.classList.toggle("on", id === kit);
  };
  const noneKit = btn("None", () => selectKit("none"), "mini");
  noneKit.prepend(textBadge("None"));
  kitRow.appendChild(noneKit);
  for (const kit of KIT_IDS) {
    const b = btn(KIT_META[kit].name, () => selectKit(kit), "mini");
    b.prepend(textBadge(KIT_META[kit].name));
    b.title = `${KIT_META[kit].role} \u00b7 ${KIT_META[kit].ult} \u2014 ${KIT_META[kit].blurb}`;
    kitBtns.set(kit, b);
    kitRow.appendChild(b);
  }
  kitSec.appendChild(h("div", "dev-note", "Kit (stat lean + passive + starting weapon):"));
  kitSec.appendChild(kitRow);
  const ultRow = h("div", "dev-row");
  ultRow.appendChild(btn("Fill ult meter", () => game.devFillUlt(), "mini"));
  ultRow.appendChild(btn("Cast ult (F)", () => game.devCastUlt(), "mini"));
  kitSec.appendChild(ultRow);
  panel.appendChild(kitSec);

  // ---- cosmetics (dress the blob; the equipped look shows live on your blob in the arena) ----
  const cosSec = section("Cosmetics");
  const loadout: CosmeticLoadout = { hat: null, face: null, body: null, title: null };
  const cosPreview = blobPreview(72);
  const cosCard = h("div", "dev-preview-card");
  cosCard.append(cosPreview.el, h("div", "dev-note", "Equipped look \u2014 live on your blob in the dev world."));
  cosSec.appendChild(cosCard);
  // A per-slot look isolates the picked item on a neutral body (hat-only / face-only, like the
  // closet), while the live preview + world blob show the full composited loadout.
  const lookForSlot = (slot: CosmeticSlot, id: string | null): BlobLook => ({
    colorIndex: slot === "body" ? bodyPaletteIndex(id, 0) : null,
    hat: slot === "hat" ? id : null,
    face: slot === "face" ? id : null,
  });
  const currentLook = (): BlobLook => ({ colorIndex: bodyPaletteIndex(loadout.body, 0), hat: loadout.hat, face: loadout.face });
  const applyCosmetics = () => { game.devSetCosmetics({ ...loadout }); cosPreview.setLook(currentLook()); };
  for (const slotDef of COSMETIC_SLOTS) {
    if (slotDef.slot === "title") continue; // titles are text honors, never worn in-world
    cosSec.appendChild(h("div", "dev-note", `${slotDef.label}:`));
    const grid = h("div", "dev-cat");
    const cells = new Map<string | null, HTMLElement>();
    const highlight = (id: string | null) => { for (const [cid, cell] of cells) cell.classList.toggle("on", cid === id); };
    const addCell = (id: string | null, name: string, thumb: HTMLElement) => {
      const cell = catalogCell(thumb, name, () => { loadout[slotDef.slot] = id; highlight(id); applyCosmetics(); });
      cells.set(id, cell);
      grid.appendChild(cell);
    };
    addCell(null, slotDef.noneLabel, blobThumb(lookForSlot(slotDef.slot, null)));
    for (const c of cosmeticsForSlot(slotDef.slot)) addCell(c.id, c.name, blobThumb(lookForSlot(slotDef.slot, c.id)));
    highlight(loadout[slotDef.slot]);
    cosSec.appendChild(grid);
  }
  panel.appendChild(cosSec);

  // ---- pets (equip a companion; it trots along behind you in the dev world) ----
  const petSec = section("Pets");
  const petPreview = spritePreview(sprites, 72);
  const petCard = h("div", "dev-preview-card");
  petCard.append(petPreview.el, h("div", "dev-note", "Equip a companion \u2014 it follows you in the dev world."));
  petSec.appendChild(petCard);
  const petGrid = h("div", "dev-cat");
  const petCells = new Map<string | null, HTMLElement>();
  const equipPet = (petId: string | null, sprite: SpriteName | null) => {
    game.devSetPet(petId);
    petPreview.setSprite(sprite);
    for (const [pid, cell] of petCells) cell.classList.toggle("on", pid === petId);
  };
  const addPetCell = (petId: string | null, name: string, thumb: HTMLElement, sprite: SpriteName | null) => {
    const cell = catalogCell(thumb, name, () => equipPet(petId, sprite));
    petCells.set(petId, cell);
    petGrid.appendChild(cell);
  };
  addPetCell(null, "None", blankThumb(), null);
  for (const node of CAMP_NODES) {
    if (node.pet === undefined) continue;
    const sprite = game.devPetSprite(node.pet);
    addPetCell(node.pet, node.name, sprite !== null ? spriteThumb(sprites, sprite) : blankThumb(), sprite);
  }
  petCells.get(null)?.classList.add("on"); // default: no pet equipped
  petSec.appendChild(petGrid);
  panel.appendChild(petSec);

  // ---- combo (gate the kill-chain HUD without having to sustain a live chain) ----
  const comboSec = section("Combo");
  const comboRow = h("div", "dev-row");
  // Values chosen to land squarely in each tier: x1 / x1.5 / x2 / x3.
  comboRow.appendChild(btn("x1", () => game.devSetCombo(0), "mini"));
  comboRow.appendChild(btn("x1.5", () => game.devSetCombo(6), "mini"));
  comboRow.appendChild(btn("x2", () => game.devSetCombo(12), "mini"));
  comboRow.appendChild(btn("x3", () => game.devSetCombo(25), "mini"));
  comboSec.appendChild(comboRow);
  const freezeBtn = btn("Freeze window: off", () => {
    const on = game.devFreezeCombo(!freezeOn);
    freezeOn = on;
    freezeBtn.textContent = `Freeze window: ${on ? "on" : "off"}`;
    freezeBtn.classList.toggle("on", on);
  }, "wide");
  let freezeOn = false;
  comboSec.appendChild(freezeBtn);
  panel.appendChild(comboSec);

  // ---- floor ----
  const floorSec = section("Floor");
  const floorRow = h("div", "dev-row");
  let floor = 1;
  const setFloor = (n: number) => { floor = Math.max(1, n); game.devSetFloor(floor); };
  floorRow.appendChild(btn("-", () => setFloor(floor - 1), "mini"));
  floorRow.appendChild(btn("+", () => setFloor(floor + 1), "mini"));
  floorRow.appendChild(btn("Next floor", () => setFloor(floor + 1), "mini"));
  floorRow.appendChild(btn("Boss (5)", () => setFloor(5), "mini"));
  floorSec.appendChild(floorRow);
  // Real generated floors (full biome + architecture + hazards + enemies), one per band —
  // the depth-progression eyeball row. God mode flips on so deep floors are tourable.
  const realRow = h("div", "dev-row");
  for (const [label, f] of [["Amber 3", 3], ["Roots 8", 8], ["Caves 13", 13], ["Deep 18", 18], ["Gild 23", 23], ["Ember 28", 28], ["Null 33", 33]] as const) {
    realRow.appendChild(btn(label, () => { floor = f; game.devLoadRealFloor(f); }, "mini"));
  }
  realRow.appendChild(btn("Real here", () => game.devLoadRealFloor(floor), "mini"));
  floorSec.appendChild(realRow);
  panel.appendChild(floorSec);

  const bossSec = section("Bosses");
  const bossRow = h("div", "dev-row");
  for (const bossFloor of BOSS_FLOORS) {
    const kind = bossKindForFloor(0, bossFloor);
    if (kind === null) continue;
    bossRow.appendChild(btn(
      `${bossDisplayName(kind)} · F${bossFloor}`,
      () => { floor = bossFloor; game.devLoadRealFloor(bossFloor); },
      "mini",
    ));
  }
  bossSec.appendChild(bossRow);
  panel.appendChild(bossSec);

  const paleSec = section("Pale F75 QA");
  const paleSetup = h("div", "dev-row");
  for (const players of [1, 2, 4]) {
    paleSetup.appendChild(btn(`${players}P setup`, () => game.devSetupPaleCapture(players, 1), "mini"));
  }
  paleSec.appendChild(paleSetup);
  const palePhases = h("div", "dev-row");
  for (const phase of [1, 2, 3]) {
    palePhases.appendChild(btn(`Freeze P${phase}`, () => game.devSetPalePhase(phase), "mini"));
  }
  paleSec.appendChild(palePhases);
  const paleBeats = h("div", "dev-row");
  paleBeats.appendChild(btn("Ring 2 tell", () => game.devSetPaleBeat("ring2"), "mini"));
  paleBeats.appendChild(btn("Sweep warn", () => game.devSetPaleBeat("sweepWindup"), "mini"));
  paleBeats.appendChild(btn("Sweep active", () => game.devSetPaleBeat("sweepActive"), "mini"));
  paleBeats.appendChild(btn("Crack-off", () => game.devSetPaleBeat("crackOff"), "mini"));
  paleSec.appendChild(paleBeats);
  const paleDebug = h("div", "dev-row");
  paleDebug.appendChild(btn("Hide boss name", () => game.devSetBossNameHidden(true), "mini"));
  paleDebug.appendChild(btn("Show hit circle", () => game.devSetHitRadiusVisible(true), "mini"));
  paleDebug.appendChild(btn("Full chill", () => game.devSetPaleWarmth(true), "mini"));
  paleDebug.appendChild(btn("Thaw", () => game.devSetPaleWarmth(false), "mini"));
  paleSec.appendChild(paleDebug);
  panel.appendChild(paleSec);

  // ---- Wave 1 randomness: force every mutator / elite affix / boss affix in isolation ----
  const randSec = section("Wave 1 Randomness");
  const mutRow = h("div", "dev-row");
  const activeMutators: MutatorId[] = [];
  const mutBtns = new Map<MutatorId, HTMLButtonElement>();
  const syncMutators = () => { game.devForceMutators(activeMutators); };
  for (const [id, label] of MUTATORS) {
    const b = btn(label, () => {
      const i = activeMutators.indexOf(id);
      if (i !== -1) activeMutators.splice(i, 1);
      else { activeMutators.push(id); if (activeMutators.length > 2) activeMutators.shift(); }
      for (const [mid, mb] of mutBtns) mb.classList.toggle("on", activeMutators.indexOf(mid) !== -1);
      syncMutators();
    }, "mini");
    b.prepend(textBadge(label));
    mutBtns.set(id, b);
    mutRow.appendChild(b);
  }
  randSec.appendChild(h("div", "dev-note", "Mutators (\u22642, toggles):"));
  randSec.appendChild(mutRow);
  const clearMut = btn("Clear mutators", () => {
    activeMutators.length = 0;
    for (const mb of mutBtns.values()) mb.classList.remove("on");
    syncMutators();
  }, "wide");
  randSec.appendChild(clearMut);
  // Elite affixes: force-spawn an elite carrying each rolled affix (on a chosen chassis).
  randSec.appendChild(h("div", "dev-note", "Elite affix (spawns an elite):"));
  const affixKindSel = h("select", "dev-sel") as HTMLSelectElement;
  for (const kind of ["slime", "spitter", "skeleton", "ghost", "charger"] as EnemyKind[]) {
    const opt = h("option"); opt.value = kind; opt.textContent = kind; affixKindSel.appendChild(opt);
  }
  randSec.appendChild(affixKindSel);
  const affixRow = h("div", "dev-row");
  for (const [id, label] of ROLL_AFFIXES) {
    const b = btn(label, () => game.devSpawnAffixElite(id, affixKindSel.value as EnemyKind, isCursor()), "mini");
    b.prepend(textBadge(label));
    affixRow.appendChild(b);
  }
  randSec.appendChild(affixRow);
  // Boss affixes: force the affix + spawn a boss to carry the extra telegraphed pattern.
  randSec.appendChild(h("div", "dev-note", "Boss affix (spawns a boss):"));
  const bossAffixRow = h("div", "dev-row");
  for (const [id, label] of BOSS_AFFIXES) {
    const b = btn(label, () => game.devForceBossAffix(id, isCursor()), "mini");
    b.prepend(textBadge(label));
    bossAffixRow.appendChild(b);
  }
  randSec.appendChild(bossAffixRow);
  panel.appendChild(randSec);

  // ---- props + inspect ----
  const worldSec = section("Props & Inspect");
  const propRow = h("div", "dev-row");
  for (const kind of PROP_KINDS) {
    propRow.appendChild(btn(PROP_LABEL[kind], () => game.devSpawnProp(kind, isCursor()), "mini"));
  }
  propRow.appendChild(btn("Chest", () => game.devSpawnChest(isCursor()), "mini"));
  worldSec.appendChild(propRow);
  const flowBtn = btn("Flow field: off", () => {
    const on = game.devToggleFlowDebug();
    flowBtn.textContent = `Flow field: ${on ? "on" : "off"}`;
    flowBtn.classList.toggle("on", on);
  }, "wide");
  worldSec.appendChild(flowBtn);
  const lightBtn = btn("Lighting & AO: on", () => {
    const on = game.devToggleLighting();
    lightBtn.textContent = `Lighting & AO: ${on ? "on" : "off"}`;
    lightBtn.classList.toggle("on", on);
  }, "wide");
  lightBtn.classList.add("on");
  worldSec.appendChild(lightBtn);
  panel.appendChild(worldSec);

  // ---- live readout ----
  const readSec = section("Readout");
  const read = h("div", "dev-read");
  const fpsV = h("span", "v");
  const enemyV = h("span", "v");
  const bulletV = h("span", "v");
  const partV = h("span", "v");
  const hpV = h("span", "v");
  const lightV = h("span", "v");
  read.append(
    h("span", "k", "fps"), fpsV,
    h("span", "k", "enemies"), enemyV,
    h("span", "k", "bullets"), bulletV,
    h("span", "k", "particles"), partV,
    h("span", "k", "hp"), hpV,
    h("span", "k", "light ms"), lightV,
  );
  readSec.appendChild(read);
  panel.appendChild(readSec);

  // ---- footer links ----
  const footer = section("Views");
  footer.appendChild(btn("Sprite / anim viewer", () => { window.location.search = "?dev=sprites"; }, "wide"));
  footer.appendChild(btn("Exit to game", () => { window.location.href = window.location.pathname; }, "wide"));
  panel.appendChild(footer);

  document.body.append(panel, fpsMeter);

  const fpsSamples = new Float64Array(FPS_SAMPLE_COUNT);
  let fpsSampleCount = 0;
  let fpsSampleIndex = 0;
  let framesUntilRefresh = 0;
  const tick = () => {
    if (framesUntilRefresh > 0) {
      framesUntilRefresh--;
      requestAnimationFrame(tick);
      return;
    }
    framesUntilRefresh = FPS_REFRESH_FRAMES - 1;
    const s: DevSnapshot = game.devSnapshot();
    if (s.fps > 0) {
      fpsSamples[fpsSampleIndex] = s.fps;
      fpsSampleIndex = (fpsSampleIndex + 1) % FPS_SAMPLE_COUNT;
      fpsSampleCount = Math.min(FPS_SAMPLE_COUNT, fpsSampleCount + 1);
    }
    let low = s.fps;
    let high = s.fps;
    for (let i = 0; i < fpsSampleCount; i++) {
      low = Math.min(low, fpsSamples[i]);
      high = Math.max(high, fpsSamples[i]);
    }
    const roundedFps = Math.round(s.fps);
    fpsV.textContent = String(Math.round(s.fps));
    fpsV.classList.toggle("warn", s.fps < 50);
    fpsMeterRate.textContent = `${roundedFps} FPS`;
    fpsMeterRate.classList.toggle("warn", s.fps < 50);
    fpsMeterDetail.textContent = `${s.fps > 0 ? (1000 / s.fps).toFixed(1) : "--.-"} ms \u00b7 ${Math.round(low)}\u2013${Math.round(high)}`;
    enemyV.textContent = String(s.enemies);
    bulletV.textContent = String(s.bullets);
    partV.textContent = String(s.particles);
    hpV.textContent = `${s.hp}/${s.maxHp}`;
    lightV.textContent = s.isLighting ? `${s.lightingMs.toFixed(2)}` : "off";
    floor = s.floor;
    for (const [id, b] of weaponBtns) b.classList.toggle("on", id === s.weapon);
    godBtn.classList.toggle("on", s.isGodMode);
    godBtn.textContent = `God mode: ${s.isGodMode ? "on" : "off"}`;
    flowBtn.classList.toggle("on", s.isFlowDebug);
    flowBtn.textContent = `Flow field: ${s.isFlowDebug ? "on" : "off"}`;
    lightBtn.classList.toggle("on", s.isLighting);
    lightBtn.textContent = `Lighting & AO: ${s.isLighting ? "on" : "off"}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
