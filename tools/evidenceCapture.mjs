// Headless PR-evidence capture against the REAL running game (vite dev server + Chrome).
// Not part of any test gate. Produces honestly-labeled screenshots/clips from live
// sessions on actual branch code:
//   1. Controlled tier arena (?dev=1 sandbox, floor 6): spawns one skeleton per
//      durability tier, holds base-pistol autofire on it, and measures kill time live
//      in-page (first landed hit -> death). The target is held stationary so the
//      measurement is clean; every number on screen is read from the running sim.
//   2. Audio instrumentation probe: wraps AudioContext.createOscillator (creation +
//      start) and window.fetch before the game boots, then plays a REAL generated
//      floor 3 (spike hazards + mobs) while firing. The overlay shows oscillator
//      starts and every /audio/ file the session fetched (decoded vs 404).
//
// Run (PR server on :5173, main on :5174):
//   node tools/evidenceCapture.mjs tier   <url> <label> <outDir>
//   node tools/evidenceCapture.mjs audio  <url> <label> <outDir>

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , mode, url, label, outDir] = process.argv;
if (!mode || !url || !label || !outDir) {
  console.error("usage: node tools/evidenceCapture.mjs <tier|audio> <url> <label> <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const AUDIO_PROBE = `(() => {
  const probe = { oscCreated: 0, oscStarted: 0, decoded: [], failed: [] };
  window.__audioProbe = probe;
  const wrapCtx = (Ctor) => {
    if (!Ctor) return;
    const origOsc = Ctor.prototype.createOscillator;
    Ctor.prototype.createOscillator = function (...a) {
      probe.oscCreated++;
      const node = origOsc.apply(this, a);
      const origStart = node.start.bind(node);
      node.start = (...s) => { probe.oscStarted++; return origStart(...s); };
      return node;
    };
  };
  wrapCtx(window.AudioContext);
  wrapCtx(window.webkitAudioContext);
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const res = await origFetch(...a);
    const u = String(a[0]);
    if (u.includes("/audio/")) {
      // The vite dev server answers unknown paths with the SPA page (200 text/html);
      // classify by content-type so "audio file present" means an actual audio body.
      const ct = res.headers.get("content-type") ?? "";
      const isAudio = res.ok && !ct.includes("text/html");
      (isAudio ? probe.decoded : probe.failed).push(u.split("/audio/")[1]);
    }
    return res;
  };
})();`;

function bannerScript(text) {
  return `(() => {
    const b = document.createElement("div");
    b.id = "__evidence_banner";
    b.textContent = ${JSON.stringify(text)};
    Object.assign(b.style, {
      position: "fixed", left: "8px", top: "8px", zIndex: 99999, maxWidth: "760px",
      background: "rgba(10,8,6,.88)", color: "#ffd27a", border: "1px solid #ffb43b",
      font: "12px/1.5 monospace", padding: "6px 10px", whiteSpace: "pre-wrap",
    });
    document.body.appendChild(b);
  })();`;
}

async function boot(context, path) {
  const page = await context.newPage();
  await page.goto(url + path, { waitUntil: "load" });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(1200); // sprites/boot settle
  return page;
}

async function tierArena(context) {
  const page = await boot(context, "/?dev=1");
  await page.evaluate(bannerScript(
    `CONTROLLED TIER ARENA \u2014 live capture, ${label}\n` +
    "?dev=1 sandbox \u00b7 devSetFloor(6) \u00b7 base pistol autofire \u00b7 one skeleton per tier, held stationary\n" +
    "HP read from the running sim; TTK measured in-page (first landed hit \u2192 death)",
  ));
  await page.evaluate(() => {
    const g = window.__game;
    if (!g.devSnapshot().isGodMode) g.devToggleGod();
    g.devSetFloor(6);
    const board = document.createElement("div");
    board.id = "__tier_board";
    Object.assign(board.style, {
      position: "fixed", left: "8px", bottom: "8px", zIndex: 99999,
      background: "rgba(10,8,6,.88)", color: "#e8e0cf", border: "1px solid #6a5a3f",
      font: "13px/1.6 monospace", padding: "8px 12px", whiteSpace: "pre",
    });
    board.textContent = "tier      HP(F6)   focused TTK\n";
    document.body.appendChild(board);
  });

  const results = [];
  for (const tier of ["swarm", "standard", "elite", "brute"]) {
    // Spawn one tiered skeleton, park it at a fixed offset, and arm the in-page watcher.
    const maxHp = await page.evaluate((t) => {
      const g = window.__game;
      g.devClearEnemies();
      g.devSpawnEnemies("skeleton", 1, false, t);
      const w = g.world;
      const e = w.enemies[w.enemies.length - 1];
      const p = w.players.get("local");
      e.x = p.x + 300; e.y = p.y;
      e.speed = 0;            // held stationary for a clean measurement
      e.spawnTimer = 0;
      window.__watch = { id: e.id, maxHp: e.maxHp, t0: null, ttk: null };
      const tick = () => {
        const en = w.enemies.find((x) => x.id === window.__watch.id);
        // A dead body is swept from the array once its death anim ends — treat "gone"
        // exactly like "dead" so the stop watch always closes.
        if (en && window.__watch.t0 === null && en.hp < en.maxHp) window.__watch.t0 = performance.now();
        if (!en || en.dead) {
          if (window.__watch.t0 !== null && window.__watch.ttk === null) {
            window.__watch.ttk = (performance.now() - window.__watch.t0) / 1000;
          }
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return e.maxHp;
    }, tier);

    await page.waitForTimeout(400);
    // Hold fire on the target, re-aiming as knockback/brace slides move it.
    let isDown = false;
    for (let guard = 0; guard < 300; guard++) {
      const state = await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const e = w.enemies.find((x) => x.id === window.__watch.id);
        if (!e || e.dead) return { done: true, x: 0, y: 0 };
        return { done: false, x: e.x - g.cam.x, y: e.y - g.cam.y };
      });
      if (state.done) { await page.waitForTimeout(200); break; }
      if (state.x > 0) {
        await page.mouse.move(state.x, state.y);
        if (!isDown) { await page.mouse.down(); isDown = true; }
      }
      // One mid-fight frame of the toughest silhouette actually soaking sustained fire.
      if (tier === "brute" && guard === 14) await page.screenshot({ path: join(outDir, "tier-arena-brute-midfight.png") });
      await page.waitForTimeout(100);
    }
    if (isDown) await page.mouse.up();
    const ttk = await page.evaluate(() => window.__watch.ttk);
    results.push({ tier, maxHp, ttk });
    await page.evaluate(({ t, hp, k }) => {
      document.getElementById("__tier_board").textContent +=
        `${t.padEnd(10)}${String(hp).padEnd(9)}${k === null ? "?" : k.toFixed(2) + "s"}\n`;
    }, { t: tier, hp: maxHp, k: ttk });
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "tier-arena.png") });
  console.log("tier results:", JSON.stringify(results));
  await page.close();
}

async function audioProbe(context) {
  const page = await boot(context, "/?dev=1");
  await page.evaluate(bannerScript(
    `AUDIO INSTRUMENTATION \u2014 live capture, ${label}\n` +
    "AudioContext.createOscillator + node.start wrapped BEFORE boot \u00b7 window.fetch(/audio/*) logged\n" +
    "?dev=1 \u2192 devLoadRealFloor(3): real generated floor (spike hazards + mobs), autofire near a hazard",
  ));
  // The first click is the gesture that unlocks audio; then load a REAL floor 3 and
  // stand next to a spike group so its telegraph/active cues fire on camera.
  await page.mouse.click(640, 400);
  await page.evaluate(() => {
    const g = window.__game;
    g.devLoadRealFloor(3);
    const w = g.world;
    const spike = w.floorHazards.find((h) => h.kind === "spikes") ?? w.floorHazards[0];
    if (spike) g.devTeleport((spike.tx + 2.5) * 32, (spike.ty + 0.5) * 32);
    const panel = document.createElement("div");
    panel.id = "__audio_panel";
    Object.assign(panel.style, {
      position: "fixed", left: "8px", bottom: "8px", zIndex: 99999, maxWidth: "740px",
      background: "rgba(10,8,6,.9)", color: "#e8e0cf", border: "1px solid #6a5a3f",
      font: "12px/1.55 monospace", padding: "8px 12px", whiteSpace: "pre-wrap",
    });
    document.body.appendChild(panel);
    const render = () => {
      const p = window.__audioProbe;
      const okList = [...new Set(p.decoded)];
      const failList = [...new Set(p.failed)];
      panel.textContent =
        `OscillatorNode created: ${p.oscCreated}   started: ${p.oscStarted}\n` +
        `authored audio files loaded (${okList.length}): ${okList.slice(0, 26).join(", ")}${okList.length > 26 ? ", \u2026" : ""}\n` +
        `pending asset hooks missing \u2192 silent/authored fallback (${failList.length}): ${failList.slice(0, 10).join(", ")}${failList.length > 10 ? ", \u2026" : ""}`;
    };
    render();
    window.setInterval(render, 500);
  });
  // Fire + move a little for ~14s while hazard cycles telegraph/erupt around the player.
  await page.mouse.move(760, 360);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.down(i % 2 === 0 ? "a" : "d");
    await page.waitForTimeout(1000);
    await page.keyboard.up(i % 2 === 0 ? "a" : "d");
  }
  await page.mouse.up();
  const probe = await page.evaluate(() => ({
    oscCreated: window.__audioProbe.oscCreated,
    oscStarted: window.__audioProbe.oscStarted,
    decoded: [...new Set(window.__audioProbe.decoded)].length,
    failed: [...new Set(window.__audioProbe.failed)].length,
  }));
  await page.screenshot({ path: join(outDir, `audio-probe-${label.replace(/[^a-z0-9-]+/gi, "-")}.png`) });
  console.log("audio probe:", JSON.stringify(probe));
  await page.close();
}

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: mode === "tier" ? { dir: outDir, size: { width: 1280, height: 720 } } : undefined,
});
await context.addInitScript(AUDIO_PROBE);

if (mode === "tier") await tierArena(context);
else await audioProbe(context);

await context.close();
await browser.close();
