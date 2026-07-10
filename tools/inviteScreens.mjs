// Headless PR-evidence screenshots of the room-invite surfaces: boots the REAL app on a
// vite dev server, then drives the REAL Menu class in-page (imported through vite's module
// graph, styled by the production index.html CSS) with scripted lobby/room data — the same
// honest scripted-data approach as tools/coopScreens.ts. Not part of any test gate.
//
// Run (dev server already up):
//   node tools/inviteScreens.mjs <url> <before|after> <outDir>

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , url, mode, outDir] = process.argv;
if (!url || !mode || !outDir) {
  console.error("usage: node tools/inviteScreens.mjs <url> <before|after> <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const SETUP = `(async () => {
  const { Menu } = await import("/src/ui/menu.ts");
  const { Session } = await import("/src/net/session.ts");
  const overlay = document.getElementById("overlay");
  const fakeClient = {
    mutation: async () => null,
    query: async () => new Promise(() => {}),
    action: async () => ({}),
    onUpdate: () => () => {},
  };
  const session = new Session(fakeClient);
  session.name = "ian";
  session.markNameConfirmed?.();
  const menu = new Menu(overlay, session, fakeClient, null, { startSolo() {}, startOnline() {} });
  window.__inviteMenu = menu;
  window.__inviteLobby = {
    code: "ABCD", status: "lobby", hostPlayerId: "p1", isQuickPlay: false,
    selfId: "p1", isHost: true, isActive: true, isSelfReady: false, isPartyReady: true,
    players: () => [
      { playerId: "p1", name: "ian", colorIndex: 1, isHost: true, gsWorldId: null, isReady: false, pingMs: 42 },
      { playerId: "p2", name: "gf", colorIndex: 3, isHost: false, gsWorldId: null, isReady: true, pingMs: 87 },
    ],
    expectedWorldId: () => "room:ABCD",
    onChange: () => () => {},
    setReady: () => {}, start: async () => {}, reopen: async () => {},
    leave: () => {}, reportWorld: () => {}, mintTicket: async () => "t",
  };
})()`;

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.evaluate(SETUP);

  const shot = async (name) => {
    await page.waitForTimeout(250);
    const file = join(outDir, `${mode}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote ${file}`);
  };

  // 1. The room lobby (main: code badge only; branch: badge + COPY INVITE).
  await page.evaluate(`window.__inviteMenu.showOnlineLobby(window.__inviteLobby, null)`);
  await shot("room-lobby");

  if (mode === "after") {
    // 2. The copied confirmation (real navigator.clipboard write in-page).
    await page.click(".invite-copy");
    await page.waitForTimeout(300);
    await shot("room-lobby-copied");
    const copied = await page.evaluate(`navigator.clipboard.readText()`);
    console.log(`clipboard now holds: ${copied}`);

    // 3. An invite join in flight (the inline connecting state, actions disabled).
    await page.evaluate(`(async () => {
      const { inviteJoiningNote } = await import("/src/ui/onlineCopy.ts");
      await window.__inviteMenu.showOnlineHome(inviteJoiningNote("ABCD"), { isBusy: true });
    })()`);
    await shot("invite-joining");

    // 4. The room-full fallback landing (spec reason + live actions on the online home).
    await page.evaluate(`(async () => {
      const { inviteFailState } = await import("/src/ui/onlineCopy.ts");
      await window.__inviteMenu.showOnlineHome(inviteFailState("that room is full").note);
    })()`);
    await shot("invite-room-full");

    // 5. The expired/invalid fallback landing.
    await page.evaluate(`(async () => {
      const { inviteFailState } = await import("/src/ui/onlineCopy.ts");
      await window.__inviteMenu.showOnlineHome(inviteFailState("no room with that code").note);
    })()`);
    await shot("invite-invalid");

    // 6. The retryable network failure with TRY AGAIN inside the reserved status line.
    await page.evaluate(`(async () => {
      const { INVITE_UNREACHABLE_NOTE } = await import("/src/ui/onlineCopy.ts");
      await window.__inviteMenu.showOnlineHome(INVITE_UNREACHABLE_NOTE, { retry: () => {} });
    })()`);
    await shot("invite-unreachable");
  }

  await browser.close();
}

void main();
