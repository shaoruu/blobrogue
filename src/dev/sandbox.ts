// ?dev=1 — the creative-mode sandbox. Boots the REAL Game into a single open arena and
// bolts a DOM control panel onto it. Everything here talks to the game exclusively
// through the dev* hooks on the Game class, so this file owns zero game internals.

import { Game } from "../game/game.js";
import type { DevSnapshot } from "../game/game.js";
import type { EnemyTier } from "../sim/balance.js";
import type { EnemyKind, PropKind, WeaponId } from "../sim/types.js";
import { ITEMS } from "../sim/items.js";
import { WEAPONS } from "../sim/weapons.js";
import { weaponDisplayStats } from "../sim/weaponStats.js";
import { createMods } from "../sim/items.js";
import { injectDevStyles } from "./styles.js";

const ENEMY_KINDS: readonly EnemyKind[] = [
  "slime", "bat", "skeleton", "ghost", "spitter", "charger", "burrower", "orbiter", "shielder",
  "boss", "marrow", "choir", "weaver", "gilded",
];
const WEAPON_IDS: readonly WeaponId[] = [
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam", "sword", "longsword", "spear",
  "lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
  "reaper", "swarm", "midas", "phase", "vortex",
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
