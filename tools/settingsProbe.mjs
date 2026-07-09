// One-off ship-gate probe against the running dev server: volume sliders persist across
// reload, mute round-trips restore the stored mix, raising master while muted auto-unmutes,
// and the sliders carry the a11y contract. Not part of any test gate.
import { chromium } from "playwright-core";

const url = process.argv[2];
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^SETTINGS/i }).click();
const panel = page.locator(".menu.settings-screen");
await panel.waitFor();

const slider = (label) => panel.locator(`input[aria-label="${label}"]`);
const setSlider = (label, v) => slider(label).evaluate((el, val) => {
  el.value = String(val);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, v);

await setSlider("master volume", 40);
await setSlider("music", 35);
await setSlider("sfx", 65);
check("live NN% value while dragging", (await panel.locator(".settings-val").first().textContent()) === "40%");
check("aria-valuetext mirrors NN%", (await slider("music").getAttribute("aria-valuetext")) === "35%");

const stored = await page.evaluate(() => [
  localStorage.getItem("blobrogue.vol.master.v2"),
  localStorage.getItem("blobrogue.vol.music.v2"),
  localStorage.getItem("blobrogue.vol.sfx.v2"),
]);
check("setters persist slider positions to blobrogue.vol.*.v2", stored.join() === "0.4,0.35,0.65", stored.join());

// keyboard: arrow key steps the native range by 5
await slider("sfx").focus();
await page.keyboard.press("ArrowRight");
check("keyboard arrow adjusts by step 5", (await slider("sfx").inputValue()) === "70");

// mute round-trip: sliders keep the stored mix, unmute restores it exactly
const mute = panel.locator(".settings-mute");
await mute.click();
check("mute keeps slider values (no zeroing)", (await slider("master volume").inputValue()) === "40"
  && (await slider("music").inputValue()) === "35" && (await slider("sfx").inputValue()) === "70");
check("muted sliders carry is-muted + aria-disabled", (await panel.locator(".settings-shake.is-muted").count()) === 3
  && (await slider("music").getAttribute("aria-disabled")) === "true");
check("inline muted note visible", ((await panel.locator(".settings-muted-note").textContent()) ?? "").includes("muted"));
check("mute never touches the stored mix", (await page.evaluate(() => localStorage.getItem("blobrogue.vol.master.v2"))) === "0.4");
await mute.click();
check("unmute restores state", (await panel.locator(".settings-shake.is-muted").count()) === 0
  && (await slider("music").getAttribute("aria-disabled")) === "false");

// raising master while muted auto-unmutes
await mute.click();
await setSlider("master volume", 55);
check("raising master while muted auto-unmutes", (await mute.textContent()) === "sound: on"
  && (await page.evaluate(() => localStorage.getItem("blobrogue.muted"))) === "0");

// live audio wiring: a slider drag must reach a real bus AudioParam ramp in the same tick
await page.evaluate(() => {
  const targets = [];
  const orig = AudioParam.prototype.setTargetAtTime;
  AudioParam.prototype.setTargetAtTime = function (v, ...rest) { targets.push(v); return orig.call(this, v, ...rest); };
  window.__gainTargets = targets;
});
await setSlider("master volume", 45);
check("slider drag live-applies the CURVED gain (0.45² = 0.2025) to the audio bus",
  await page.evaluate(() => window.__gainTargets.includes(0.45 * 0.45)
    && !window.__gainTargets.includes(0.45)));
await setSlider("master volume", 55);

// reload: values persist and hydrate the sliders
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: /^SETTINGS/i }).click();
await panel.waitFor();
check("values persist across reload", (await slider("master volume").inputValue()) === "55"
  && (await slider("music").inputValue()) === "35" && (await slider("sfx").inputValue()) === "70");
check("thumb hit area >= 24px and row >= 44px", await slider("music").evaluate((el) => {
  const row = el.closest(".settings-shake");
  return el.getBoundingClientRect().height >= 24 && row.getBoundingClientRect().height >= 44;
}));

// live migration: a legacy raw-gain value converts to a sqrt position on next boot
await page.evaluate(() => {
  localStorage.removeItem("blobrogue.vol.music.v2");
  localStorage.setItem("blobrogue.vol.music", "0.5");
});
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: /^SETTINGS/i }).click();
await panel.waitFor();
// the native input snaps its value to the step-5 grid, so read the NN% label (which
// reflects the true stored position) rather than inputValue
check("legacy gain 0.5 migrates to position 71% (same audible volume)",
  (await slider("music").evaluate((el) => el.closest(".settings-shake").querySelector(".settings-val").textContent)) === "71%");
check("…and the .v2 key is written one-time", await page.evaluate(
  () => Math.abs(Number(localStorage.getItem("blobrogue.vol.music.v2")) - Math.SQRT1_2) < 1e-9));

await browser.close();
process.exit(failed === 0 ? 0 : 1);
