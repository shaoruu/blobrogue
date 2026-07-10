// One-shot PR-artifact capture for the weapon rarity/mystery treatment. Drives the REAL
// game through the dev-only __blobdev QA hook against a local vite dev server — no mocks,
// the exact production render paths. Not part of any test suite.
//
// Usage: node tools/rarity_screenshots.mjs [outDir]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/rarity-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu", "--force-color-profile=srgb"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__blobdev !== undefined, null, { timeout: 20000 });

// Boot straight into the dev sandbox arena (the real Game, real render).
await page.evaluate(() => {
  const { game, hideMenu } = window.__blobdev;
  hideMenu();
  game.devStartSandbox();
});
await page.waitForTimeout(1200);

// ---- shot 1: the rarity pickup treatment (common / rare / legendary / mystery) ----
await page.evaluate(() => {
  const { game } = window.__blobdev;
  const w = game.world;
  const p = w.players.get("local");
  game.devToggleGod();
  const drops = [
    { weapon: "shotgun" },                                    // common: classic amber
    { weapon: "railgun" },                                    // rare: cool blue
    { weapon: "reaper" },                                     // legendary: gold + ring
    { weapon: "midas", isMystery: true, twist: "blessed" },   // mystery: purple ???
  ];
  drops.forEach((d, i) => {
    w.pickups.push({
      id: w.nextPickupId++, kind: "weapon", x: p.x - 190 + i * 120, y: p.y - 110,
      radius: 16, weapon: d.weapon, isMystery: d.isMystery, twist: d.twist,
    });
  });
});
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/1_pickup_rarity_glows.png`, clip: { x: 240, y: 120, width: 800, height: 420 } });

// ---- shot 2: hotbar frame tints + the legendary tooltip badge ----
await page.evaluate(() => {
  const { game } = window.__blobdev;
  for (const id of ["railgun", "reaper", "vortex"]) game.devGiveWeapon(id);
});
await page.waitForTimeout(400);
const slots = await page.locator(".hb-slot").all();
// Hover the Reaper slot (index 2: pistol, railgun, reaper, vortex) to raise its tooltip.
await slots[2].hover();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/2_hotbar_tints_legendary_tooltip.png`, clip: { x: 280, y: 330, width: 720, height: 465 } });
await page.mouse.move(20, 20); // drop the hover so no tooltip lingers into later shots

// ---- shot 3: the mystery reveal moment ----
await page.evaluate(() => {
  const { game } = window.__blobdev;
  const w = game.world;
  const p = w.players.get("local");
  w.pickups.push({
    id: w.nextPickupId++, kind: "weapon", x: p.x + 60, y: p.y,
    radius: 16, weapon: "phase", isMystery: true, twist: "blessed",
  });
  game.devTeleport(p.x + 60, p.y);
});
await page.waitForTimeout(450);
await page.screenshot({ path: `${OUT}/3_mystery_reveal.png`, clip: { x: 340, y: 150, width: 620, height: 360 } });

// ---- shot 4: Patch's shop with a mystery pedestal + rarity pricing ----
await page.evaluate(() => {
  const { game } = window.__blobdev;
  const w = game.world;
  // A real generated floor 6 whose shop stalls a mystery pedestal: walk seeds until one
  // does (deterministic per seed — the same search the rarity suite runs).
  for (let s = 0; s < 400; s++) {
    w.seed = 0xCAFE + s * 337;
    game.devLoadRealFloor(6);
    if (w.shop && w.shop.slots.some((sl) => sl.isMystery)) break;
  }
  game.devClearEnemies();
  const slot = w.shop.slots.find((sl) => sl.isMystery);
  const p = w.players.get("local");
  p.coins = 40;
  game.devTeleport(slot.x, slot.y - 40);
});
await page.waitForTimeout(1600); // outlive the equip-confirm tooltip before the clean shot
await page.keyboard.press("e"); // the explicit interact opens the panel on the focused station
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/4_shop_mystery_pedestal.png` });

await browser.close();
console.log(`wrote 4 screenshots to ${OUT}`);
