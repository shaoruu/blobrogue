import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 938, height: 864 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];
const SCREENSHOT_STEPS = new Set(
  VIEWPORTS.flatMap(({ width, height }) => [
    `${width}x${height}:kit`,
    `${width}x${height}:pet-before`,
    `${width}x${height}:pet`,
    `${width}x${height}:review`,
  ]),
);

const screenshotDir = process.env.LOADOUT_SCREENSHOT_DIR;
const externalUrl = process.env.LOADOUT_TEST_URL;
const port = process.env.LOADOUT_TEST_PORT ?? "4175";
const url = externalUrl ?? `http://127.0.0.1:${port}`;
let server = null;

async function waitForServer(target) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${target}`);
}

async function startServer() {
  if (externalUrl) return;
  server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", port, "--strictPort"],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  server.once("exit", (code) => {
    if (code !== null && code !== 0) process.stderr.write(output);
  });
  await waitForServer(url);
}

async function settleLayout(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map((image) => image.decode().catch(() => undefined)),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function installGate(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    const [{ Menu }, { Session }] = await Promise.all([
      import("/src/ui/menu.ts"),
      import("/src/net/session.ts"),
    ]);
    const overlay = document.getElementById("overlay");
    if (!overlay) throw new Error("Missing overlay");
    const session = new Session(null);
    session.profile = {
      playerId: "layout-check",
      name: "Layout Check",
      colorIndex: 2,
      cosmetics: { hat: null, face: null, body: null, title: null },
      totalKills: 0,
      deepestFloor: 30,
      totalCoins: 0,
      gamesPlayed: 0,
      amber: 0,
      masteryLevel: 10,
      unlocks: ["pet_cat", "pet_dragon", "pet_slime"],
      isAccount: false,
    };
    const menu = new Menu(overlay, session, null, null, {
      startSolo() {
        throw new Error("Layout test must not start gameplay");
      },
      startOnline() {
        throw new Error("Layout test must not start online gameplay");
      },
    });
    window.__loadoutLayoutMenu = menu;
    await menu.showKitPicker();
  });
  await settleLayout(page);
}

async function measureStep(page, step) {
  return page.evaluate(({ currentStep }) => {
    const root = document.querySelector(".loadout-gate");
    const body = document.querySelector(".loadout-body");
    const footer = document.querySelector(".loadout-footer");
    const grid = document.querySelector(
      currentStep === "kit"
        ? ".loadout-kit-grid"
        : currentStep === "pet"
          ? ".loadout-pet-grid"
          : ".loadout-review-grid",
    );
    if (!(root instanceof HTMLElement)
      || !(body instanceof HTMLElement)
      || !(footer instanceof HTMLElement)
      || !(grid instanceof HTMLElement)) {
      throw new Error(`Missing ${currentStep} layout`);
    }

    const failures = [];
    const boxes = (selector) => [...document.querySelectorAll(selector)]
      .filter((node) => node instanceof HTMLElement && !node.hidden)
      .map((node) => ({
        label: node.className || node.tagName,
        rect: node.getBoundingClientRect().toJSON(),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
    const horizontalTargets = boxes([
      ".loadout-gate",
      ".loadout-body",
      ".loadout-kit-grid",
      ".loadout-pet-grid",
      ".loadout-review-grid",
      ".loadout-card",
      ".loadout-card-title",
      ".loadout-card-description",
      ".loadout-card-state",
      ".review-title",
      ".review-description",
      ".review-pet-effect",
    ].join(","));
    for (const target of horizontalTargets) {
      if (target.scrollWidth > target.clientWidth + 1) {
        failures.push(`${target.label} scrollWidth ${target.scrollWidth} > clientWidth ${target.clientWidth}`);
      }
    }

    const cardSelector = currentStep === "review" ? ".loadout-review-card" : ".loadout-card";
    for (const card of document.querySelectorAll(cardSelector)) {
      if (!(card instanceof HTMLElement)) continue;
      const cardRect = card.getBoundingClientRect();
      if (cardRect.left < root.getBoundingClientRect().left - 1
        || cardRect.right > root.getBoundingClientRect().right + 1) {
        failures.push(`${card.className} is horizontally clipped`);
      }
      for (const child of card.querySelectorAll("*")) {
        if (!(child instanceof HTMLElement) || getComputedStyle(child).visibility === "hidden") continue;
        const childRect = child.getBoundingClientRect();
        if (child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1) {
          failures.push(`${child.className || child.tagName}: horizontal content overflow`);
        }
        if (child.clientHeight > 0 && child.scrollHeight > child.clientHeight + 1) {
          failures.push(`${child.className || child.tagName}: vertical content overflow`);
        }
        if (childRect.left < cardRect.left - 1 || childRect.right > cardRect.right + 1
          || childRect.top < cardRect.top - 1 || childRect.bottom > cardRect.bottom + 1) {
          failures.push(`${child.className || child.tagName}: child escapes card bounds`);
        }
      }
      const regions = [...card.querySelectorAll(
        currentStep === "review"
          ? ".loadout-review-content, .review-edit"
          : ".loadout-card-header, .loadout-card-description, .loadout-card-state",
      )].filter((node) => node instanceof HTMLElement);
      for (let first = 0; first < regions.length; first++) {
        for (let second = first + 1; second < regions.length; second++) {
          const firstRect = regions[first].getBoundingClientRect();
          const secondRect = regions[second].getBoundingClientRect();
          const isIntersecting = firstRect.left < secondRect.right - 0.5
            && firstRect.right > secondRect.left + 0.5
            && firstRect.top < secondRect.bottom - 0.5
            && firstRect.bottom > secondRect.top + 0.5;
          if (isIntersecting) {
            failures.push(`${card.className}: ${regions[first].className} intersects ${regions[second].className}`);
          }
        }
      }
      const description = card.querySelector(
        currentStep === "review" ? ".review-description, .review-pet-effect" : ".loadout-card-description",
      );
      const state = card.querySelector(".loadout-card-state");
      if (description instanceof HTMLElement && state instanceof HTMLElement
        && state.getBoundingClientRect().top < description.getBoundingClientRect().bottom - 0.5) {
        failures.push(`${card.className}: status footer is not below description`);
      }
      const badge = card.querySelector(".loadout-card-badge");
      const title = card.querySelector(".loadout-card-title");
      const header = card.querySelector(".loadout-card-header");
      if (badge instanceof HTMLElement && title instanceof HTMLElement && header instanceof HTMLElement) {
        const badgeRect = badge.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const collides = badgeRect.left < titleRect.right - 0.5
          && badgeRect.right > titleRect.left + 0.5
          && badgeRect.top < titleRect.bottom - 0.5
          && badgeRect.bottom > titleRect.top + 0.5;
        if (collides) failures.push(`${card.className}: badge collides with title`);
        if (badgeRect.left < headerRect.left - 0.5 || badgeRect.right > headerRect.right + 0.5
          || badgeRect.top < headerRect.top - 0.5 || badgeRect.bottom > headerRect.bottom + 0.5) {
          failures.push(`${card.className}: badge escapes header`);
        }
      }
    }

    const initialFooterRect = footer.getBoundingClientRect();
    if (initialFooterRect.top < 0 || initialFooterRect.bottom > innerHeight + 1) {
      failures.push("footer is not visible before body scroll");
    }
    body.scrollTop = body.scrollHeight;
    const cards = [...grid.querySelectorAll(cardSelector)].filter(
      (card) => card instanceof HTMLElement && getComputedStyle(card).visibility !== "hidden",
    );
    const lastCard = cards.at(-1);
    if (lastCard instanceof HTMLElement) {
      const lastRect = lastCard.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      if (lastRect.bottom > footer.getBoundingClientRect().top - 8
        || lastRect.bottom > bodyRect.bottom - 7
        || lastRect.top < bodyRect.top - 1) {
        failures.push(`last card is not fully reachable in body viewport`);
      }
    }
    const footerRect = footer.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (footerRect.top < bodyRect.bottom + 7) failures.push("footer lacks eight-pixel body clearance");
    if (footerRect.top < 0 || footerRect.bottom > innerHeight + 1) failures.push("footer is not visible at max scroll");

    const rootRect = root.getBoundingClientRect();
    if (rootRect.left < -1 || rootRect.right > innerWidth + 1) failures.push("gate is clipped at viewport edges");
    if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("viewport has horizontal overflow");
    return {
      failures,
      metrics: {
        root: rootRect.toJSON(),
        body: bodyRect.toJSON(),
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        grid: grid.getBoundingClientRect().toJSON(),
        gridScrollWidth: grid.scrollWidth,
        gridClientWidth: grid.clientWidth,
        footer: footerRect.toJSON(),
      },
    };
  }, { currentStep: step });
}

async function verifyNoShift(page, step) {
  const geometry = async () => page.locator(".loadout-gate").evaluate((node) => {
    const values = [node, ...node.querySelectorAll(
      ".loadout-card, .loadout-card-title, .loadout-card-state, .loadout-review-card",
    )];
    return values.map((value) => {
      const rect = value.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
  });
  const before = await geometry();
  await page.waitForTimeout(250);
  const after = await geometry();
  const isStable = before.length === after.length && before.every((box, boxIndex) =>
    box.every((value, valueIndex) => Math.abs(value - after[boxIndex][valueIndex]) <= 1));
  if (!isStable) {
    throw new Error(`${step}: layout shifted after fonts and images settled`);
  }
}

async function capture(page, viewport, step) {
  if (!screenshotDir) return;
  const key = `${viewport.width}x${viewport.height}:${step}`;
  if (!SCREENSHOT_STEPS.has(key)) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: join(screenshotDir, `${step}-${viewport.width}x${viewport.height}.png`),
  });
}

async function semanticFailures(page, step, isSelected = false) {
  return page.evaluate(({ currentStep, hasSelection }) => {
    const failures = [];
    const gate = document.querySelector(".loadout-gate");
    const cards = [...document.querySelectorAll(".loadout-card[role='radio']")];
    if (!(gate instanceof HTMLElement)) return ["missing loadout gate"];
    if (cards.some((card) => !card.getAttribute("aria-label")?.trim())) {
      failures.push("a radio has an empty aria-label");
    }
    if (cards.some((card) => card.getBoundingClientRect().height < 44
      || card.getBoundingClientRect().width < 44)) {
      failures.push("a radio is smaller than 44px");
    }
    if (cards[0] instanceof HTMLElement) {
      cards[0].focus();
      const style = getComputedStyle(cards[0]);
      if (style.outlineWidth !== "3px" || style.outlineStyle !== "solid") {
        failures.push("focused radio does not expose the three-pixel focus ring");
      }
      if (style.touchAction !== "manipulation") failures.push("radio touch action is not manipulation");
    }
    if (currentStep === "kit") {
      if (cards.length !== 4 || cards.some((card) => card.getAttribute("aria-checked") !== "false")) {
        failures.push("KIT radios do not begin unselected");
      }
      if (!(document.querySelector(".loadout-next") instanceof HTMLButtonElement)
        || !document.querySelector(".loadout-next").disabled) {
        failures.push("KIT next is not disabled before explicit activation");
      }
    }
    if (currentStep === "pet") {
      const next = document.querySelector(".loadout-review-next");
      const doggie = document.querySelector('.pet-option[data-pet="doggie"]');
      const statuses = [...document.querySelectorAll(".pet-option .loadout-card-state")]
        .map((state) => state.textContent?.trim() ?? "");
      const columns = getComputedStyle(document.querySelector(".loadout-pet-grid")).gridTemplateColumns
        .split(" ").filter(Boolean).length;
      const expectedColumns = innerWidth <= 620 ? 2 : 3;
      if (columns !== expectedColumns) failures.push(`PET grid has ${columns} columns, expected ${expectedColumns}`);
      if (!(doggie instanceof HTMLButtonElement)
        || doggie.disabled
        || doggie.getAttribute("aria-disabled") !== "true"
        || !doggie.getAttribute("aria-label")?.includes("REACH FLOOR 3 TO RESCUE")) {
        failures.push("locked Doggie is not native-enabled, focusable, aria-disabled, and fully labelled");
      }
      if (!statuses.includes("REACH FLOOR 3 TO RESCUE · 3/3") || !statuses.includes("RESCUED")) {
        failures.push("mixed locked and RESCUED fixtures are missing");
      }
      if (!(next instanceof HTMLButtonElement) || next.disabled === hasSelection) {
        failures.push(`PET next disabled state does not match explicit selection=${hasSelection}`);
      }
      const checked = cards.filter((card) => card.getAttribute("aria-checked") === "true");
      if (checked.length !== (hasSelection ? 1 : 0)) failures.push("PET aria-checked count is incorrect");
      if (hasSelection && !statuses.includes("SELECTED ✓")) failures.push("selected status is missing");
    }
    if (currentStep === "review") {
      const confirm = document.querySelector(".loadout-confirm");
      if (!(confirm instanceof HTMLButtonElement)
        || confirm.disabled
        || confirm.getBoundingClientRect().height < 44
        || confirm.getBoundingClientRect().bottom > innerHeight + 1) {
        failures.push("REVIEW confirm is not enabled, reachable, and at least 44px");
      }
    }
    return failures;
  }, { currentStep: step, hasSelection: isSelected });
}

async function petCardSizes(page) {
  return page.locator(".loadout-pet-grid").evaluate((grid) =>
    [...grid.querySelectorAll(".loadout-card")].map((card) => {
      const rect = card.getBoundingClientRect();
      return [rect.width, rect.height];
    }));
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await installGate(page);
  const results = [];

  await capture(page, viewport, "kit");
  const kitResult = { step: "kit", ...(await measureStep(page, "kit")) };
  kitResult.failures.push(...await semanticFailures(page, "kit"));
  results.push(kitResult);
  await verifyNoShift(page, "kit");
  await page.click('.kit-option[data-kit="mender"]');
  await page.click(".loadout-next");
  await settleLayout(page);

  await capture(page, viewport, "pet-before");
  const petBeforeResult = { step: "pet-before", ...(await measureStep(page, "pet")) };
  petBeforeResult.failures.push(...await semanticFailures(page, "pet"));
  results.push(petBeforeResult);
  await verifyNoShift(page, "pet-before");
  const petSizesBeforeSelection = await petCardSizes(page);
  await page.click('.pet-option[data-pet="dragon"]');
  await settleLayout(page);
  const petSizesAfterSelection = await petCardSizes(page);
  if (petSizesBeforeSelection.length !== petSizesAfterSelection.length
    || petSizesBeforeSelection.some((box, boxIndex) =>
      box.some((value, valueIndex) => Math.abs(value - petSizesAfterSelection[boxIndex][valueIndex]) > 1))) {
    throw new Error(`${viewport.width}x${viewport.height}: pet card geometry shifted after selection`);
  }
  await capture(page, viewport, "pet");
  const petResult = { step: "pet", ...(await measureStep(page, "pet")) };
  petResult.failures.push(...await semanticFailures(page, "pet", true));
  results.push(petResult);
  await verifyNoShift(page, "pet");
  await page.click(".loadout-review-next");
  await settleLayout(page);

  await capture(page, viewport, "review");
  const reviewResult = { step: "review", ...(await measureStep(page, "review")) };
  reviewResult.failures.push(...await semanticFailures(page, "review", true));
  results.push(reviewResult);
  await verifyNoShift(page, "review");
  await context.close();
  return results;
}

async function main() {
  await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const failures = [];
  try {
    for (const viewport of VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      const results = await runViewport(browser, viewport);
      for (const result of results) {
        process.stdout.write(`${label} ${result.step}: ${JSON.stringify(result.metrics)}\n`);
        for (const failure of result.failures) failures.push(`${label} ${result.step}: ${failure}`);
      }
    }
  } finally {
    await browser.close();
    server?.kill("SIGTERM");
  }
  if (failures.length > 0) {
    throw new Error(`Loadout layout failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

void main();
