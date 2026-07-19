// Headless capture of the REAL running arena client (vite dev server + Chrome) for PVP arena
// visuals. Drives ?dev=arena, which boots the shipping online client against an in-page
// scripted socket replaying authoritative snapshots (see src/dev/arenaHarness.ts). The public
// kill switch is never touched — arena presentation selects off the authoritative pvp: world id.
//
// Usage:
//   node tools/arenaCap.mjs [outDir] [baseUrl]
//     outDir  — where PNGs land (default /workspace/arena-shots)
//     baseUrl — an already-running dev server; omit to have this script start `npm run dev`.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.argv[2] ?? "/workspace/arena-shots";
const EXTERNAL_URL = process.argv[3] ?? null;
const SCENES = [
  "live-hearth",
  "live-contested",
  "live-tar",
  "live-gust",
  "live-spark",
  "live-ult-salvo",
  "live-ult-triage",
  "live-ult-shove",
  "live-ult-slip",
];
const ULT_SCENES = new Map([
  ["live-ult-salvo", { auk: "gunner", kind: "salvo", minT: 0.48, maxT: 0.58 }],
  ["live-ult-triage", { auk: "mender", kind: "triage", minT: 0.45, maxT: 0.54 }],
  ["live-ult-shove", { auk: "bulwark", kind: "shove", minT: 0.58, maxT: 0.70 }],
  ["live-ult-slip", { auk: "phantom", kind: "slip", minT: 0.82, maxT: 0.90 }],
]);
const CHROME = "/usr/bin/google-chrome";

mkdirSync(OUT_DIR, { recursive: true });

function startDevServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: new URL("..", import.meta.url),
      env: process.env,
      detached: true,
    });
    let settled = false;
    let timeout = null;
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(`[vite] ${text}`);
      const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (match && !settled) {
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        resolve({ proc, url: match[1].replace(/\/$/, "") });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (buf) => process.stderr.write(`[vite:err] ${buf}`));
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`vite exited before ready (code ${code})`));
    });
    timeout = setTimeout(() => {
      if (!settled) reject(new Error("vite did not report a Local URL in time"));
    }, 60000);
  });
}

async function main() {
  let devProc = null;
  let url = EXTERNAL_URL;
  if (url === null) {
    const started = await startDevServer();
    devProc = started.proc;
    url = started.url;
    console.log(`dev server ready at ${url}`);
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const captured = [];
  try {
    for (const scene of SCENES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await page.goto(`${url}/?dev=arena&scene=${scene}`, { waitUntil: "load" });
      await page.waitForFunction(
        () => window.__arena !== undefined && window.__arena.isReady(),
        null,
        { timeout: 30000 },
      );
      const expectedUlt = ULT_SCENES.get(scene);
      if (expectedUlt === undefined) {
        await page.waitForTimeout(2600);
      } else {
        await page.waitForFunction(
          ({ auk, kind, minT, maxT }) => {
            const debug = window.__arena?.debug();
            return debug !== undefined
              && debug.auk === auk
              && debug.ultArena === kind
              && debug.ultFx > 0
              && debug.ultFxT >= minT
              && debug.ultFxT <= maxT;
          },
          expectedUlt,
          { timeout: 30000 },
        );
      }
      const active = await page.evaluate(() => window.__arena.currentScene());
      if (active !== scene) throw new Error(`scene mismatch: asked ${scene}, got ${active}`);
      if (expectedUlt !== undefined) {
        const debug = await page.evaluate(() => window.__arena.debug());
        if (debug.auk !== expectedUlt.auk || debug.ultArena !== expectedUlt.kind
          || debug.ultT <= 0 || debug.ultFx <= 0
          || debug.ultFxT < expectedUlt.minT || debug.ultFxT > expectedUlt.maxT) {
          throw new Error(`ult state mismatch for ${scene}: ${JSON.stringify(debug)}`);
        }
        console.log(`  [${scene}] auk=${debug.auk} ultArena=${debug.ultArena} ultT=${debug.ultT} ultFx=${debug.ultFx} ultFxT=${debug.ultFxT.toFixed(3)}`);
      }
      const wave = scene.startsWith("live-ult-") ? "wave3" : "wave2";
      const path = join(OUT_DIR, `${wave}-${scene}.png`);
      await page.screenshot({ path });
      captured.push(path);
      if (errors.length > 0) console.warn(`  [${scene}] page errors: ${errors.join(" | ")}`);
      console.log(`  captured ${path}`);
      await page.close();
    }
  } finally {
    await browser.close();
    if (devProc !== null) {
      try {
        process.kill(-devProc.pid, "SIGTERM");
      } catch {
        devProc.kill("SIGTERM");
      }
    }
  }

  console.log(`\ncaptured ${captured.length} arena screenshots:`);
  for (const path of captured) console.log(`  ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
