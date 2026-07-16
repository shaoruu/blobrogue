import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [, , url, outDir] = process.argv;
if (!url || !outDir) {
  console.error("usage: node tools/paleCapture.mjs <url> <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function boot(players, phase, isHitDebug = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const query = `/?dev=1&qa=pale&players=${players}&phase=${phase}&hideBossName=1&hitDebug=${isHitDebug ? 1 : 0}`;
  await page.goto(url + query, { waitUntil: "load" });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelector(".dev-panel")?.remove();
    document.querySelector(".floor-banner")?.remove();
  });
  return page;
}

for (const phase of [1, 2, 3]) {
  const page = await boot(1, phase);
  await page.evaluate((value) => window.__game.devSetPalePhase(value), phase);
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, `pale-1p-p${phase}.png`) });
  await page.close();
}

{
  const page = await boot(1, 1);
  await page.evaluate(() => window.__game.devSetPaleBeat("ring2"));
  await page.waitForTimeout(80);
  await page.screenshot({ path: join(outDir, "pale-ring2-exact-tell.png") });
  await page.close();
}

for (const beat of ["sweepWindup", "sweepActive"]) {
  const page = await boot(1, 3);
  await page.evaluate((value) => window.__game.devSetPaleBeat(value), beat);
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, `pale-1p-${beat}.png`) });
  await page.close();
}

{
  const page = await boot(4, 3);
  await page.evaluate(() => window.__game.devSetPaleBeat("sweepActive"));
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, "pale-4p-sweep-routes.png") });
  await page.close();
}

for (const isChilled of [true, false]) {
  const page = await boot(1, 3);
  await page.evaluate((value) => {
    window.__game.devSetPaleBeat("sweepWindup");
    window.__game.devSetPaleWarmth(value);
  }, isChilled);
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, isChilled ? "pale-warmth-chilled.png" : "pale-warmth-thawed.png") });
  await page.close();
}

for (const phase of [1, 2, 3]) {
  const page = await boot(1, phase, true);
  await page.evaluate((value) => window.__game.devSetPalePhase(value), phase);
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, `pale-hit-radius-p${phase}.png`) });
  await page.close();
}

async function record(name, setup, durationMs) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto(url + "/?dev=1&qa=pale&players=1&phase=3&hideBossName=1", { waitUntil: "load" });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    document.querySelector(".dev-panel")?.remove();
    document.querySelector(".floor-banner")?.remove();
  });
  await page.evaluate(setup);
  await page.waitForTimeout(durationMs);
  const video = page.video();
  await page.close();
  await context.close();
  const path = await video.path();
  renameSync(path, join(outDir, `${name}.webm`));
}

await record("pale-crack-off", () => window.__game.devSetPaleBeat("crackOff"), 1800);
await record("pale-sweep-exact", () => window.__game.devSetPaleBeat("sweepActive"), 2400);

await browser.close();
console.log(`captured Pale evidence in ${outDir}`);
