// One-off PR-evidence capture for the hotbar cap + swap prompt: drives the ?dev sandbox
// on a running dev server, grants weapons through the real dev hooks, and screenshots the
// bottom-center hotbar region. Not part of any test gate.
//
// Usage: node tools/hotbarShots.mjs <url> <outDir> <mode>
//   mode "before": grant 10 weapons (the old unbounded bar)
//   mode "after":  fill to the cap, then stand on a new weapon (the swap prompt)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const [, , url, outDir, mode] = process.argv;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url + "?dev=1", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__game));
await page.evaluate(() => {
  const panel = document.querySelector(".dev-panel");
  if (panel) panel.style.display = "none";
});
// Let the one-time controls onboarding hint fade out so it never overlaps the hotbar.
await page.waitForTimeout(6000);

const grant = (ids) => page.evaluate((weapons) => {
  for (const id of weapons) window.__game.devGiveWeapon(id);
}, ids);

if (mode === "before") {
  await grant(["shotgun", "railgun", "tesla", "smg", "cannon", "rapid", "burst", "homing", "sawnoff", "flamer"]);
  await page.waitForTimeout(1600); // the equip-confirm tooltip flash fades first
  await page.screenshot({ path: `${outDir}/before-overflowing-hotbar.png` });
} else {
  // Fresh spawn: the bar already shows all capacity boxes, so the cap is visible from
  // weapon one and pickups never shift the layout.
  await page.screenshot({ path: `${outDir}/after-capacity-boxes.png` });
  await grant(["shotgun", "railgun", "tesla", "smg", "cannon"]); // pistol + 5 = the cap
  await page.waitForTimeout(1600); // the equip-confirm tooltip flash fades first
  await page.screenshot({ path: `${outDir}/after-full-hotbar.png` });
  // A new weapon lands underfoot: the sim refuses the auto-collect and the prompt raises.
  await page.evaluate(async () => {
    const { WEAPON_PICKUP_RADIUS } = await import("/src/sim/constants.ts");
    const w = window.__game.devWorld();
    const p = w.players.get("local");
    w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x: p.x, y: p.y, radius: WEAPON_PICKUP_RADIUS, weapon: "flamer" });
  });
  await page.waitForTimeout(600);
  await page.waitForSelector(".hb-swap.show");
  await page.screenshot({ path: `${outDir}/after-swap-prompt.png` });
  // The trade itself: click slot 3 in the prompt, the replaced weapon drops to the floor.
  await page.click(".hb-swap .hs-slot:nth-child(3)");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/after-swap-resolved.png` });
}
await browser.close();
console.log("done " + mode);
