// One-off PR-evidence capture: open the real settings screen on the running dev server
// and screenshot the panel (normal + muted). Not part of any test gate.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const [, , url, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^SETTINGS/i }).click();
const panel = page.locator(".menu.settings-screen");
await panel.waitFor();
await panel.screenshot({ path: `${outDir}/settings-audio-group.png` });

const mute = panel.locator(".settings-mute");
await mute.click();
await panel.screenshot({ path: `${outDir}/settings-audio-muted.png` });
await mute.click();
await browser.close();
console.log("done");
