// ?dev=1 — the creative-mode sandbox. Boots the REAL Game into a single open arena and
// bolts a DOM control panel onto it. Everything here talks to the game exclusively
// through the dev* hooks on the Game class, so this file owns zero game internals.

import { Game } from "../game/game.js";
import type { DevSnapshot } from "../game/game.js";
import type { EnemyTier } from "../sim/balance.js";
import type { EnemyKind, PropKind, WeaponId } from "../sim/types.js";
import type { MutatorId, RollAffixId, BossAffixId } from "../sim/floorRolls.js";
import { ITEMS } from "../sim/items.js";
import { KIT_IDS, KIT_META, KIT_START_WEAPON } from "../sim/kits.js";
import type { KitId } from "../sim/kits.js";
import { WEAPONS } from "../sim/weapons.js";
import { weaponDisplayStats } from "../sim/weaponStats.js";
import { createMods } from "../sim/items.js";
import { ENEMY_ARCHETYPES } from "../sim/enemies.js";
import { CAMP_NODES } from "../sim/camp_nodes.js";
import { COSMETICS, COSMETIC_SLOTS } from "../game/cosmetics.js";
import type { CosmeticDef, CosmeticSlot } from "../game/cosmetics.js";
import { spriteSrc, weaponIconSrc, playerColor } from "../game/assets.js";
import { injectDevStyles } from "./styles.js";

// The two roster halves, split so the panel can title them apart (a boss thumbnail reads very
// differently from a chaff enemy). Both spawn through the same devSpawnEnemies hook.
const BASIC_ENEMIES: readonly EnemyKind[] = [
  "slime", "bat", "skeleton", "ghost", "spitter", "charger", "burrower", "orbiter", "shielder",
];
// Wave 1 deep bosses spawn the core; it raises its own husks / slabs / mirror pool.
const BOSS_KINDS: readonly EnemyKind[] = [
  "boss", "marrow", "choir", "weaver", "gilded", "jet", "tithe", "quorum",
];
const WEAPON_IDS: readonly WeaponId[] = [
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam", "sword", "longsword", "spear",
  "lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
  "reaper", "swarm", "midas", "phase", "vortex",
];
// Wave 1 randomness rows. These carry a dev-only glyph tint + one-line read so the panel is a
// visual catalog, not a wall of names (kept local so the panel still owns zero sim internals).
interface RandRow<T> { id: T; label: string; tint: string; desc: string; }
const MUTATORS: ReadonlyArray<RandRow<MutatorId>> = [
  { id: "denseDark", label: "Dense Dark", tint: "#6d5bd0", desc: "Vision tightens — the floor runs dark." },
  { id: "moltenFloor", label: "Molten Floor", tint: "#ff7a3b", desc: "Molten seams scar the floor." },
  { id: "twinnedElites", label: "Twinned Elites", tint: "#5ad1ff", desc: "Elites arrive in pairs." },
  { id: "fractureStorm", label: "Fracture Storm", tint: "#c98bff", desc: "Fracturing bursts sweep the arena." },
  { id: "amberfall", label: "Amberfall", tint: "#ffb43b", desc: "Amber rains down across the floor." },
  { id: "thinAir", label: "Thin Air", tint: "#9fe0ff", desc: "Thinner air shifts the dash cadence." },
];
const ROLL_AFFIXES: ReadonlyArray<RandRow<RollAffixId>> = [
  { id: "splits", label: "Splits", tint: "#7CFC98", desc: "Dies into smaller copies." },
  { id: "shielded", label: "Shielded", tint: "#5ad1ff", desc: "Carries a crust slab that must break first." },
  { id: "hazardTrail", label: "Hazard Trail", tint: "#ff7a3b", desc: "Leaves a burning trail behind it." },
  { id: "reflect", label: "Reflect", tint: "#e8e2d0", desc: "Kicks shots back on an armed beat." },
  { id: "enrage", label: "Enrage", tint: "#ff6a5a", desc: "Speeds up as its health drops." },
];
const BOSS_AFFIXES: ReadonlyArray<RandRow<BossAffixId>> = [
  { id: "emberwake", label: "Emberwake", tint: "#ff7a3b", desc: "Adds an ember-trail telegraph pattern." },
  { id: "sundering", label: "Sundering", tint: "#c98bff", desc: "Adds a sundering shockwave pattern." },
  { id: "amberrain", label: "Amberrain", tint: "#ffb43b", desc: "Adds an amber-rain zone pattern." },
];

const PROP_KINDS: readonly PropKind[] = ["crate", "pot", "barrel", "barrel_explosive", "brazier", "root_wall", "silt_mound", "clinker_brick"];
const PROP_LABEL: Record<PropKind, string> = {
  crate: "Crate", pot: "Pot", barrel: "Barrel", barrel_explosive: "Boom Barrel", brazier: "Brazier",
  root_wall: "Root Wall", silt_mound: "Silt Mound", clinker_brick: "Clinker Brick",
};

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

// A catalog thumbnail is EITHER real sprite art (enemies/bosses/kits/cosmetics/pets), a tinted
// glyph (the art-less mutator/affix rows), or a solid palette swatch (body colors).
type ThumbSpec = { src: string } | { glyph: string; tint: string } | { swatch: string };

function makeThumb(spec: ThumbSpec, extra = ""): HTMLElement {
  if ("src" in spec) {
    const img = h("img", `dev-thumb${extra ? " " + extra : ""}`) as HTMLImageElement;
    img.src = spec.src;
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    return img;
  }
  const el = h("div", `dev-thumb dev-thumb-glyph${extra ? " " + extra : ""}`);
  if ("swatch" in spec) { el.style.background = spec.swatch; el.style.color = spec.swatch; }
  else { el.textContent = spec.glyph; el.style.color = spec.tint; }
  return el;
}

// The shared inspector popover: one card, reused by every thumbnail, showing a large sprite +
// name + key stats on hover/focus — the exact "see what it is" read the weapon card gives, but
// as a floating popover so every row reuses it with no per-row card and no layout shift.
interface TipData { thumb: ThumbSpec; name: string; type?: string; stats?: string; }
interface Inspector { node: HTMLElement; bind(anchor: HTMLElement, data: TipData): void; }

function makeInspector(): Inspector {
  const node = h("div", "dev-tip hidden");
  const art = h("div", "dev-tip-art");
  const name = h("div", "dev-tip-name");
  const type = h("div", "dev-tip-type");
  const stats = h("div", "dev-tip-stats");
  const info = h("div", "dev-tip-info");
  info.append(name, type, stats);
  node.append(art, info);
  const hide = () => node.classList.add("hidden");
  const show = (anchor: HTMLElement, d: TipData) => {
    art.textContent = "";
    art.appendChild(makeThumb(d.thumb));
    name.textContent = d.name.toUpperCase();
    type.textContent = d.type ?? "";
    type.style.display = d.type ? "" : "none";
    stats.textContent = d.stats ?? "";
    stats.style.display = d.stats ? "" : "none";
    node.classList.remove("hidden");
    // Anchor the card's top to the hovered row (viewport coords; the card is position:fixed to
    // the left of the panel), clamped so a bottom row never pushes it off-screen.
    const r = anchor.getBoundingClientRect();
    const top = Math.max(8, Math.min(window.innerHeight - node.offsetHeight - 8, r.top - 4));
    node.style.top = `${top}px`;
  };
  return {
    node,
    bind(anchor, data) {
      anchor.addEventListener("mouseenter", () => show(anchor, data));
      anchor.addEventListener("mouseleave", hide);
      anchor.addEventListener("focusin", () => show(anchor, data));
      anchor.addEventListener("focusout", hide);
    },
  };
}

// One catalog row: thumbnail + name, an optional primary click on the thumbnail (spawn/equip/
// select), and optional trailing controls (the enemies' 1/5/10 buttons). Wired to the shared
// inspector so hovering the row surfaces its card.
interface EntrySpec {
  thumb: ThumbSpec;
  name: string;
  type?: string;
  stats?: string;
  onClick?: () => void;
  controls?: readonly HTMLElement[];
}

function catalogRow(inspector: Inspector, spec: EntrySpec): HTMLDivElement {
  const row = h("div", "dev-row dev-entry");
  const thumb = makeThumb(spec.thumb, spec.onClick ? "clickable" : "");
  row.append(thumb, h("span", "dev-lbl", spec.name));
  if (spec.controls) for (const c of spec.controls) row.appendChild(c);
  inspector.bind(row, { thumb: spec.thumb, name: spec.name, type: spec.type, stats: spec.stats });
  if (spec.onClick) thumb.addEventListener("click", spec.onClick);
  return row;
}

// The stats line for an enemy/boss archetype — HP/SPD/DMG (+ THREAT for the chaff roster; a
// boss's threat is 0, floor-scaled). The middot-joined read the inspector card shows.
function enemyStats(kind: EnemyKind, isBoss: boolean): string {
  const a = ENEMY_ARCHETYPES[kind];
  const parts = [`HP ${a.baseHp}`, `SPD ${a.baseSpeed}`, `DMG ${a.touchDamage}`];
  if (!isBoss) parts.push(`THREAT ${a.threat}`);
  return parts.join("  \u00b7  ");
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
}

function buildPanel(game: Game): void {
  const panel = h("div", "dev-panel");
  // The shared hover/focus inspector for every catalog thumbnail. Lives on <body> (not in the
  // scrolling panel) so it can float to the panel's left without clipping.
  const inspector = makeInspector();

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
  for (const kind of BASIC_ENEMIES) {
    spawnSec.appendChild(catalogRow(inspector, {
      thumb: { src: spriteSrc(ENEMY_ARCHETYPES[kind].sprite) },
      name: kind,
      type: `${ENEMY_ARCHETYPES[kind].movement} enemy`,
      stats: enemyStats(kind, false),
      onClick: () => game.devSpawnEnemies(kind, 1, isCursor(), pickedTier()),
      controls: [
        btn("1", () => game.devSpawnEnemies(kind, 1, isCursor(), pickedTier()), "mini"),
        btn("5", () => game.devSpawnEnemies(kind, 5, isCursor(), pickedTier()), "mini"),
        btn("10", () => game.devSpawnEnemies(kind, 10, isCursor(), pickedTier()), "mini"),
      ],
    }));
  }
  const clearRow = h("div", "dev-row");
  clearRow.appendChild(btn("Clear all enemies", () => game.devClearEnemies(), "wide danger"));
  spawnSec.appendChild(clearRow);
  panel.appendChild(spawnSec);

  // ---- bosses (own section: a boss thumbnail reads very differently from chaff) ----
  const bossSec = section("Bosses");
  for (const kind of BOSS_KINDS) {
    bossSec.appendChild(catalogRow(inspector, {
      thumb: { src: spriteSrc(ENEMY_ARCHETYPES[kind].sprite) },
      name: kind,
      type: "boss \u00b7 scales with floor",
      stats: enemyStats(kind, true),
      onClick: () => game.devSpawnEnemies(kind, 1, isCursor(), pickedTier()),
      controls: [btn("Spawn", () => game.devSpawnEnemies(kind, 1, isCursor(), pickedTier()), "mini")],
    }));
  }
  panel.appendChild(bossSec);

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
  const kitRows = new Map<KitId, HTMLDivElement>();
  const selectKit = (kit: KitId) => {
    game.devSetKit(kit);
    for (const [id, r] of kitRows) r.classList.toggle("on", id === kit);
  };
  kitSec.appendChild(h("div", "dev-note", "Click a kit for its stat lean + passive + starting weapon:"));
  const noneKitRow = catalogRow(inspector, {
    thumb: { glyph: "\u2014", tint: "#8f87a8" },
    name: "None",
    type: "no kit",
    stats: "Baseline blob — no kit lean, passive, or starting weapon.",
    onClick: () => selectKit("none"),
  });
  kitRows.set("none", noneKitRow);
  kitSec.appendChild(noneKitRow);
  for (const kit of KIT_IDS) {
    const meta = KIT_META[kit];
    const start = KIT_START_WEAPON[kit] as WeaponId;
    const row = catalogRow(inspector, {
      thumb: { src: weaponIconSrc(start) ?? "/sprites/gun.png" },
      name: meta.name,
      type: `${meta.role} \u00b7 ult: ${meta.ult}`,
      stats: `START ${WEAPONS[start].name.toUpperCase()}\n${meta.blurb}`,
      onClick: () => selectKit(kit),
    });
    kitRows.set(kit, row);
    kitSec.appendChild(row);
  }
  const ultRow = h("div", "dev-row");
  ultRow.appendChild(btn("Fill ult meter", () => game.devFillUlt(), "mini"));
  ultRow.appendChild(btn("Cast ult (F)", () => game.devCastUlt(), "mini"));
  kitSec.appendChild(ultRow);
  panel.appendChild(kitSec);

  // ---- pets (preview a companion on the blob; it follows in creative mode via selfPet) ----
  const petSec = section("Pets");
  petSec.appendChild(h("div", "dev-note", "Click to equip a companion — it trots along in the dev world."));
  const petRows = new Map<string, HTMLDivElement>();
  const selectPet = (petId: string | null) => {
    game.devSetPet(petId);
    for (const [id, r] of petRows) r.classList.toggle("on", id === (petId ?? "none"));
  };
  const noPetRow = catalogRow(inspector, {
    thumb: { glyph: "\u2014", tint: "#8f87a8" },
    name: "None",
    type: "no pet",
    stats: "No companion follows the blob.",
    onClick: () => selectPet(null),
  });
  petRows.set("none", noPetRow);
  petSec.appendChild(noPetRow);
  // The pet catalog is the companion camp nodes (doggie today; future pets drop in for free).
  for (const node of CAMP_NODES) {
    if (!node.pet) continue;
    const petId = node.pet;
    const row = catalogRow(inspector, {
      thumb: { src: `/sprites/pets/${petId}.png` },
      name: node.name,
      type: "companion",
      stats: node.desc,
      onClick: () => selectPet(petId),
    });
    petRows.set(petId, row);
    petSec.appendChild(row);
  }
  const initPet = game.devPet();
  for (const [id, r] of petRows) r.classList.toggle("on", id === (initPet ?? "none"));
  panel.appendChild(petSec);

  // ---- cosmetics (preview hats/faces/body on the blob via the real loadout render path) ----
  const cosSec = section("Cosmetics");
  cosSec.appendChild(h("div", "dev-note", "Click to wear it on your blob."));
  const cosRows = new Map<CosmeticSlot, Map<string, HTMLDivElement>>();
  const selectCosmetic = (slot: CosmeticSlot, id: string | null) => {
    game.devSetCosmetic(slot, id);
    const rows = cosRows.get(slot);
    if (rows) for (const [rid, r] of rows) r.classList.toggle("on", rid === (id ?? "none"));
  };
  const cosThumb = (def: CosmeticDef): ThumbSpec =>
    def.slot === "body" ? { swatch: playerColor(def.paletteIndex ?? 0) } : { src: `/sprites/cosmetics/${def.assetKey}_down.png` };
  for (const slotDef of COSMETIC_SLOTS) {
    // Titles are text honors, never a blob visual — nothing to preview in-world.
    if (slotDef.slot === "title") continue;
    const { slot, label, noneLabel } = slotDef;
    const rows = new Map<string, HTMLDivElement>();
    cosRows.set(slot, rows);
    cosSec.appendChild(h("div", "dev-note", `${label}:`));
    const noneRow = catalogRow(inspector, {
      thumb: slot === "body" ? { swatch: playerColor(0) } : { glyph: "\u2014", tint: "#8f87a8" },
      name: noneLabel,
      type: label,
      onClick: () => selectCosmetic(slot, null),
    });
    rows.set("none", noneRow);
    cosSec.appendChild(noneRow);
    for (const def of COSMETICS) {
      if (def.slot !== slot) continue;
      const row = catalogRow(inspector, {
        thumb: cosThumb(def),
        name: def.name,
        type: `${label} \u00b7 ${def.unlock}`,
        stats: def.unlock === "earned" && def.hint ? `Unlock: ${def.hint}.` : "Starter — owned from the first session.",
        onClick: () => selectCosmetic(slot, def.id),
      });
      rows.set(def.id, row);
      cosSec.appendChild(row);
    }
  }
  for (const [slot, rows] of cosRows) {
    const cur = game.devCosmetic(slot);
    for (const [rid, r] of rows) r.classList.toggle("on", rid === (cur ?? "none"));
  }
  panel.appendChild(cosSec);

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

  // ---- Wave 1 randomness: force every mutator / elite affix / boss affix in isolation ----
  const randSec = section("Wave 1 Randomness");
  const activeMutators: MutatorId[] = [];
  const mutRows = new Map<MutatorId, HTMLDivElement>();
  const syncMutators = () => { game.devForceMutators(activeMutators); };
  randSec.appendChild(h("div", "dev-note", "Mutators (\u22642, click to toggle):"));
  for (const m of MUTATORS) {
    const row = catalogRow(inspector, {
      thumb: { glyph: m.label[0], tint: m.tint },
      name: m.label,
      type: "floor mutator",
      stats: m.desc,
      onClick: () => {
        const i = activeMutators.indexOf(m.id);
        if (i !== -1) activeMutators.splice(i, 1);
        else { activeMutators.push(m.id); if (activeMutators.length > 2) activeMutators.shift(); }
        for (const [mid, mr] of mutRows) mr.classList.toggle("on", activeMutators.indexOf(mid) !== -1);
        syncMutators();
      },
    });
    mutRows.set(m.id, row);
    randSec.appendChild(row);
  }
  const clearMut = btn("Clear mutators", () => {
    activeMutators.length = 0;
    for (const mr of mutRows.values()) mr.classList.remove("on");
    syncMutators();
  }, "wide");
  randSec.appendChild(clearMut);
  // Elite affixes: force-spawn an elite carrying each rolled affix (on a chosen chassis).
  randSec.appendChild(h("div", "dev-note", "Elite affix (click to spawn an elite):"));
  const affixKindSel = h("select", "dev-sel") as HTMLSelectElement;
  for (const kind of ["slime", "spitter", "skeleton", "ghost", "charger"] as EnemyKind[]) {
    const opt = h("option"); opt.value = kind; opt.textContent = kind; affixKindSel.appendChild(opt);
  }
  randSec.appendChild(affixKindSel);
  for (const a of ROLL_AFFIXES) {
    randSec.appendChild(catalogRow(inspector, {
      thumb: { glyph: a.label[0], tint: a.tint },
      name: a.label,
      type: "elite affix",
      stats: a.desc,
      onClick: () => game.devSpawnAffixElite(a.id, affixKindSel.value as EnemyKind, isCursor()),
    }));
  }
  // Boss affixes: force the affix + spawn a boss to carry the extra telegraphed pattern.
  randSec.appendChild(h("div", "dev-note", "Boss affix (click to spawn a boss):"));
  for (const a of BOSS_AFFIXES) {
    randSec.appendChild(catalogRow(inspector, {
      thumb: { glyph: a.label[0], tint: a.tint },
      name: a.label,
      type: "boss affix",
      stats: a.desc,
      onClick: () => game.devForceBossAffix(a.id, isCursor()),
    }));
  }
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

  document.body.appendChild(panel);
  document.body.appendChild(inspector.node);

  // Poll the game for readouts + reflect current weapon/god/flow state. rAF keeps it in
  // step with the sim; text-only updates on fixed-width fields avoid any layout shift.
  const tick = () => {
    const s: DevSnapshot = game.devSnapshot();
    fpsV.textContent = String(Math.round(s.fps));
    fpsV.classList.toggle("warn", s.fps < 50);
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
