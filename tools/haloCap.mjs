// Capture Razor Halo's low/mid/high progression through the real Game renderer.
//
// Usage:
//   node tools/haloCap.mjs [outDir] [baseUrl]
//   npm run screens:halo -- [outDir] [baseUrl]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.argv[2] ?? join(ROOT, "artifacts", "screenshots", "halo");
const EXTERNAL_URL = process.argv[3] ?? null;
const SCENES = ["low", "mid", "high"];
const CHROME = "/usr/bin/google-chrome";

mkdirSync(OUT_DIR, { recursive: true });

async function startDevServer() {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: ROOT,
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    await server.close();
    throw new Error("Vite did not expose a local capture URL");
  }
  return { server, url: url.replace(/\/$/, "") };
}

async function main() {
  let devServer = null;
  let url = EXTERNAL_URL;
  if (url === null) {
    const started = await startDevServer();
    devServer = started.server;
    url = started.url;
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    for (const scene of SCENES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`${url}/?dev=halo&scene=${scene}`, { waitUntil: "load" });
      await page.waitForFunction(
        () => window.__haloVisual !== undefined && window.__haloVisual.isReady(),
        null,
        { timeout: 30000 },
      );
      if (scene === "high") {
        await page.waitForFunction(
          () => (window.__haloVisual?.state()?.flare ?? 0) > 0.3,
          null,
          { timeout: 30000 },
        );
      } else {
        await page.waitForTimeout(1200);
      }
      const path = join(OUT_DIR, `razor-halo-${scene}.png`);
      await page.screenshot({ path });
      process.stdout.write(`wrote ${path}\n`);
      await page.close();
    }
  } finally {
    await browser.close();
    if (devServer !== null) await devServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
