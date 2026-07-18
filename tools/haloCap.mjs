// Capture Razor Halo's low/mid/high progression through the real Game renderer.
//
// Usage:
//   node tools/haloCap.mjs [outDir] [baseUrl]
//   npm run screens:halo -- [outDir] [baseUrl]

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.argv[2] ?? join(ROOT, "artifacts", "screenshots", "halo");
const EXTERNAL_URL = process.argv[3] ?? null;
const SCENES = ["low", "mid", "high"];
const CHROME = "/usr/bin/google-chrome";

mkdirSync(OUT_DIR, { recursive: true });

function startDevServer() {
  return new Promise((resolve, reject) => {
    const processHandle = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: ROOT,
      env: process.env,
      detached: process.platform !== "win32",
    });
    let isSettled = false;
    const onData = (buffer) => {
      const text = buffer.toString();
      process.stdout.write(`[vite] ${text}`);
      const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (match !== null && !isSettled) {
        isSettled = true;
        resolve({ processHandle, url: match[1].replace(/\/$/, "") });
      }
    };
    processHandle.stdout.on("data", onData);
    processHandle.stderr.on("data", (buffer) => process.stderr.write(`[vite:err] ${buffer}`));
    processHandle.on("exit", (code) => {
      if (!isSettled) reject(new Error(`vite exited before ready (code ${code})`));
    });
    setTimeout(() => {
      if (!isSettled) reject(new Error("vite did not report a Local URL in time"));
    }, 60000);
  });
}

async function main() {
  let devProcess = null;
  let url = EXTERNAL_URL;
  if (url === null) {
    const started = await startDevServer();
    devProcess = started.processHandle;
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
    if (devProcess !== null) {
      if (process.platform === "win32" || devProcess.pid === undefined) {
        devProcess.kill("SIGTERM");
      } else {
        process.kill(-devProcess.pid, "SIGTERM");
      }
      devProcess.stdout.destroy();
      devProcess.stderr.destroy();
      devProcess.unref();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
