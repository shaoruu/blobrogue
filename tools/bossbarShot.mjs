// One-off PR-evidence capture: the named boss bar, live against the ?dev=1 sandbox.
// Spawns one boss of the given kind and screenshots the real HUD. Not part of any gate.
//   node tools/bossbarShot.mjs <url> <kind> <outPath>

import { chromium } from "playwright-core";

const [, , url, kind, outPath] = process.argv;
if (!url || !kind || !outPath) {
  console.error("usage: node tools/bossbarShot.mjs <url> <kind> <outPath>");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url + "/?dev=1", { waitUntil: "load" });
await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 30000 });
await page.waitForTimeout(1500); // sprites/boot settle

await page.evaluate((k) => {
  document.querySelector(".dev-panel")?.remove(); // a clean gameplay frame
  window.__game.devSpawnEnemies(k, 1, false);
}, kind);
await page.waitForTimeout(900); // entrance settles, bar fades in

const label = await page.evaluate(() => document.querySelector("[data-bossname]")?.textContent ?? null);
const isShown = await page.evaluate(() => document.querySelector("[data-bossbar]")?.classList.contains("show") ?? false);
await page.screenshot({ path: outPath });
console.log(JSON.stringify({ kind, label, isShown, outPath }));
await browser.close();
