// Weapon tooltip stat cards: the values shown on hover MUST equal what the authoritative
// sim actually fires (resolveShot / currentDamageMult / currentFireRate), including blessing
// mods, raw caps, low-HP scalers, and the melee/projectile split — plus the hotbar icon's
// missing-sprite fallback contract (exercised against a minimal DOM stub).
//
// Run: npx tsx test/weaponstats.test.ts

import { weaponCard, weaponCardKey, fmtNum } from "../src/sim/weaponStats.js";
import { WEAPONS } from "../src/sim/weapons.js";
import type { WeaponId } from "../src/sim/types.js";
import { createMods, recomputeMods } from "../src/sim/items.js";
import { resolveShot, currentDamageMult, currentFireRate } from "../src/sim/world.js";
import type { ShotContext } from "../src/sim/world.js";
import { CAPS } from "../src/sim/balance.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function neutral(): ShotContext {
  return { mods: createMods(), hp: 6, maxHp: 6 };
}

function withBuild(itemPicks: string[], hp = 6, maxHp = 6): ShotContext {
  const mods = createMods();
  recomputeMods(mods, itemPicks);
  return { mods, hp, maxHp };
}

function lineOf(card: ReturnType<typeof weaponCard>, label: string) {
  return card.lines.find((l) => l.label === label);
}

section("every weapon produces a complete card");
for (const id of Object.keys(WEAPONS) as WeaponId[]) {
  const card = weaponCard(id, neutral());
  const hasCore = card.lines.some((l) => l.label === "damage") && card.lines.some((l) => l.label === "cooldown");
  const kindOk = WEAPONS[id].melee ? card.kind === "melee" : card.kind === "ranged";
  const shapeOk = WEAPONS[id].melee
    ? card.lines.some((l) => l.label === "reach") && card.lines.some((l) => l.label.includes("arc")) && card.lines.some((l) => l.label === "swing time")
    : card.lines.some((l) => l.label === "speed") && card.lines.some((l) => l.label === "range");
  check(`${id}: card + verb + kind + class-specific lines`, hasCore && kindOk && shapeOk && card.verb.length > 0,
    `kind=${card.kind} lines=${card.lines.map((l) => l.label).join(",")}`);
}

section("unmodified player: every delta is neutral and current === base");
{
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const card = weaponCard(id, neutral());
    const clean = card.lines.every((l) => l.delta === 0 && l.base === l.current);
    check(`${id}: neutral card shows no deltas`, clean,
      card.lines.filter((l) => l.delta !== 0).map((l) => `${l.label}:${l.base}->${l.current}`).join(" "));
  }
}

section("modified values match the authoritative shot math exactly");
{
  // Hair Trigger Lv2 + Split Shot Lv1 + Full Metal Lv3 + Glass Cannon Lv1.
  const p = withBuild(["hair_trigger", "hair_trigger", "split_shot", "full_metal", "full_metal", "full_metal", "glass_cannon"]);
  const card = weaponCard("pistol", p);
  const spec = resolveShot(p, "pistol");
  check("damage line = resolveShot damage", lineOf(card, "damage")?.current === fmtNum(spec.damage),
    `${lineOf(card, "damage")?.current} vs ${fmtNum(spec.damage)}`);
  check("damage delta improved", lineOf(card, "damage")?.delta === 1);
  check("pellets line = resolveShot pellets", lineOf(card, "pellets")?.current === `x${fmtNum(spec.pellets, 0)}`);
  check("pierce line = resolveShot pierce", lineOf(card, "pierce")?.current === fmtNum(spec.pierce, 0));
  const cd = WEAPONS.pistol.fireCd / currentFireRate(p);
  check("cooldown line = fireCd / currentFireRate", lineOf(card, "cooldown")?.current === `${fmtNum(cd, 2)}s`);
  check("cooldown delta improved (lower is better)", lineOf(card, "cooldown")?.delta === 1);
  check("spread appeared and reads worsened (multi-pellet cone)", lineOf(card, "spread")?.delta === -1);
}

section("raw caps bind the tooltip exactly as they bind combat");
{
  const p = neutral();
  p.mods.damageMult = 99; // beyond the 2.25 cap
  p.mods.fireRateMult = 99; // beyond the 1.80 cap
  const card = weaponCard("rapid", p);
  const spec = resolveShot(p, "rapid");
  check("capped damage shown", lineOf(card, "damage")?.current === fmtNum(spec.damage)
    && Math.abs(spec.damage - WEAPONS.rapid.damage * CAPS.damageMult) < 1e-9);
  const cd = WEAPONS.rapid.fireCd / currentFireRate(p);
  check("capped fire rate shown", lineOf(card, "cooldown")?.current === `${fmtNum(cd, 2)}s`
    && Math.abs(currentFireRate(p) - CAPS.fireRateMult) < 1e-9);
}

section("pierce respects the sim's hard cap of 4 (intrinsic + blessing)");
{
  const p = withBuild(["full_metal", "full_metal", "full_metal"]); // +3 pierce
  const card = weaponCard("cannon", p); // basePierce 2 -> 2+3=5 -> capped 4
  check("cannon pierce caps at 4", lineOf(card, "pierce")?.current === "4",
    `pierce=${lineOf(card, "pierce")?.current}`);
  check("cap still reads as an improvement over base 2", lineOf(card, "pierce")?.delta === 1
    && lineOf(card, "pierce")?.base === "2");
}

section("low-HP scalers (berserk/adrenaline) show their live effect");
{
  const full = withBuild(["berserk"], 6, 6);
  const low = withBuild(["berserk"], 1, 6);
  const dmgFull = resolveShot(full, "pistol").damage;
  const dmgLow = resolveShot(low, "pistol").damage;
  check("berserk raises damage as HP drops", dmgLow > dmgFull, `${dmgFull} -> ${dmgLow}`);
  const cardLow = weaponCard("pistol", low);
  check("tooltip shows the live low-HP value", lineOf(cardLow, "damage")?.current === fmtNum(dmgLow));
  check("berserk at FULL HP shows no damage delta", weaponCard("pistol", full).lines.find((l) => l.label === "damage")?.delta === 0);
}

section("melee vs projectile: class-specific lines and math");
{
  const p = withBuild(["hair_trigger"]);
  const melee = weaponCard("spear", p);
  check("spear is a thrust card", melee.lines.some((l) => l.label === "thrust arc"));
  const m = WEAPONS.spear.melee!;
  check("reach/arc/swing come from the melee spec",
    lineOf(melee, "reach")?.current === `${fmtNum(m.reach, 0)}px`
    && lineOf(melee, "swing time")?.current === `${fmtNum(m.swingDur ?? 0.2, 2)}s`);
  check("melee damage = weapon damage x currentDamageMult",
    lineOf(melee, "damage")?.current === fmtNum(WEAPONS.spear.damage * currentDamageMult(p)));
  check("melee has no projectile lines",
    !melee.lines.some((l) => l.label === "speed" || l.label === "range" || l.label === "pellets"));
  const ranged = weaponCard("railgun", p);
  const spec = resolveShot(p, "railgun");
  check("ranged range = speed x life", lineOf(ranged, "range")?.current === `${fmtNum(spec.speed * spec.life, 0)}px`);
}

section("bullet-behavior lines surface only where the weapon has them");
{
  const p = neutral();
  check("ricochet shows bounces", lineOf(weaponCard("ricochet", p), "bounces")?.current === "2");
  check("tesla shows chains", lineOf(weaponCard("tesla", p), "chains")?.current === "3");
  check("pistol shows neither",
    !weaponCard("pistol", p).lines.some((l) => l.label === "bounces" || l.label === "chains"));
  const deadeye = withBuild(["deadeye"]);
  const critCard = weaponCard("pistol", deadeye);
  check("deadeye surfaces crit lines", lineOf(critCard, "crit")?.current === "25%"
    && lineOf(critCard, "crit damage")?.current === "x2.5");
}

section("card key: stable for identical state, changes when mods change");
{
  const a = weaponCardKey(weaponCard("pistol", neutral()));
  const b = weaponCardKey(weaponCard("pistol", neutral()));
  const c = weaponCardKey(weaponCard("pistol", withBuild(["hair_trigger"])));
  check("identical state -> identical key", a === b);
  check("mods change the key", a !== c);
}

// ---- hotbar icon fallback (weaponIconEl) against a minimal DOM stub --------------------

interface FakeStyle { cssText: string; imageRendering: string; width: string; height: string; }
interface FakeNode {
  tag: string;
  style: FakeStyle;
  width: number;
  height: number;
  alt: string;
  decoding: string;
  src: string;
  replacedWith: FakeNode | null;
  getContext(kind: string): null;
  addEventListener(name: string, fn: () => void, opts?: { once: boolean }): void;
  replaceWith(node: FakeNode): void;
  listeners: Map<string, () => void>;
}

function fakeNode(tag: string): FakeNode {
  const node: FakeNode = {
    tag,
    style: { cssText: "", imageRendering: "", width: "", height: "" },
    width: 0, height: 0, alt: "", decoding: "", src: "",
    replacedWith: null,
    getContext: () => null,
    listeners: new Map(),
    addEventListener(name: string, fn: () => void) { node.listeners.set(name, fn); },
    replaceWith(other: FakeNode) { node.replacedWith = other; },
  };
  return node;
}

async function iconFallbackTests(): Promise<void> {
  section("hotbar icon: sprite when known, pixel-gun fallback when missing or broken");
  (globalThis as { document?: { createElement(tag: string): FakeNode } }).document = {
    createElement: (tag: string) => fakeNode(tag),
  };
  const { weaponIconEl } = await import("../src/game/hudIcons.js");
  const { weaponIconSrc } = await import("../src/game/assets.js");

  check("known weapon resolves a sprite src", weaponIconSrc("pistol") === "/sprites/weapon_pistol.png");
  check("unknown id resolves no sprite", weaponIconSrc("not_a_weapon" as WeaponId) === null);

  const known = weaponIconEl("pistol", "Pistol") as { tag?: string; src?: string };
  check("known weapon renders an <img> pointing at its sprite",
    known.tag === "img" && known.src === "/sprites/weapon_pistol.png");

  const missing = weaponIconEl("not_a_weapon" as WeaponId, "???") as { tag?: string };
  check("missing sprite mapping falls back to the pixel gun canvas", missing.tag === "canvas");

  // A mapped sprite whose file 404s: the <img>'s error handler swaps in the canvas fallback.
  const broken = weaponIconEl("railgun", "Longshot") as { tag?: string; listeners?: Map<string, () => void>; replacedWith?: { tag: string } | null };
  broken.listeners?.get("error")?.();
  check("load error swaps the <img> for the canvas fallback", broken.replacedWith?.tag === "canvas",
    `replacedWith=${broken.replacedWith?.tag}`);
}

await iconFallbackTests();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  FAILED: " + f).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("\nAll weapon-stat/tooltip assertions passed.\n");
