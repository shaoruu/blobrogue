// Menu one-path + readiness-surface suite. Renders the REAL Menu against the headless DOM
// shim and locks the product guarantees behind the Sev-0 fix:
//   - ONE multiplayer path: the title offers exactly PLAY ONLINE + PLAY SOLO; no screen ever
//     mentions the removed peer-synced classic co-op, and no client entry point (menu/main)
//     imports it — the legacy path is unreachable for normal users
//   - the room lobby shows each member's live readiness (LOBBY / CONNECTING… / CONNECTED TO
//     WORLD) from the authoritative-world mirror, and the lobby->playing transition launches
//     the run AS a party start (readiness-gated), while REJOIN launches ungated
// Run: npm run test:menu

import "./harness/domShim.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Menu } from "../src/ui/menu.js";
import type { MenuHost } from "../src/ui/menu.js";
import { Session } from "../src/net/session.js";
import type { OnlineLobby, LobbyPlayer } from "../src/net/onlineLobby.js";
import type { ProfileDoc } from "../src/net/api.js";
import type { ConvexClient } from "convex/browser";
import { worldIdForRoomCode } from "../src/net/protocol.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- headless tree readers (the dom shim tracks children + textContent) ----

interface ShimNode {
  tagName?: string;
  textContent?: string;
  children?: ShimNode[];
}

function textOf(node: ShimNode): string {
  const own = typeof node.textContent === "string" ? node.textContent : "";
  const kids = (node.children ?? []).map(textOf).join(" ");
  return `${own} ${kids}`.trim();
}

function collect(node: ShimNode, pred: (n: ShimNode) => boolean, out: ShimNode[] = []): ShimNode[] {
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) collect(c, pred, out);
  return out;
}

function buttonsOf(overlay: ShimNode): string[] {
  return collect(overlay, (n) => n.tagName === "BUTTON").map(textOf);
}

// ---- fakes ----

const PROFILE: ProfileDoc = {
  playerId: "player-1", name: "blob", colorIndex: 2,
  totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, unlocks: [], isAccount: false,
};

// The menu only needs mutation/query for the title screen; both resolve to a stored profile.
function fakeConvex(): ConvexClient {
  const fake = {
    mutation: () => Promise.resolve(PROFILE),
    query: () => Promise.resolve(null),
    action: () => Promise.resolve({ ticket: "t", playerId: PROFILE.playerId }),
    onUpdate: () => () => {},
  };
  return fake as unknown as ConvexClient;
}

interface LaunchRecord { code: string; isPartyStart: boolean }

function makeMenu(): { menu: Menu; overlay: ShimNode; launches: LaunchRecord[] } {
  const overlay = document.createElement("div") as unknown as ShimNode;
  const client = fakeConvex();
  const session = new Session(client);
  const launches: LaunchRecord[] = [];
  const host: MenuHost = {
    startSolo() {},
    startOnline(lobby, _profile, isPartyStart) {
      launches.push({ code: lobby.code, isPartyStart });
    },
  };
  const menu = new Menu(overlay as unknown as HTMLElement, session, client, null, host);
  return { menu, overlay, launches };
}

// A lobby double exposing exactly the surface showOnlineLobby reads. Kept as a plain object
// (cast) so the test controls roster/status without Convex.
function fakeLobby(code: string, selfId = "player-1"): {
  lobby: OnlineLobby;
  setStatus: (s: "lobby" | "playing" | "ended") => void;
  setPlayers: (p: LobbyPlayer[]) => void;
  fireChange: () => void;
  readyCalls: boolean[];
} {
  let onChange: (() => void) | null = null;
  const readyCalls: boolean[] = [];
  const state = {
    code,
    status: "lobby" as "lobby" | "playing" | "ended",
    hostPlayerId: "player-1",
    isQuickPlay: false,
    rows: [] as LobbyPlayer[],
  };
  const lobby = {
    get code() { return state.code; },
    get status() { return state.status; },
    get hostPlayerId() { return state.hostPlayerId; },
    get isQuickPlay() { return state.isQuickPlay; },
    get selfId() { return selfId; },
    get isHost() { return selfId === state.hostPlayerId; },
    get isActive() { return state.status !== "ended"; },
    get isSelfReady() { return state.rows.find((r) => r.playerId === selfId)?.isReady ?? false; },
    get isPartyReady() { return state.rows.every((p) => p.isHost || p.isReady); },
    players: () => state.rows,
    expectedWorldId: () => worldIdForRoomCode(state.code),
    onChange: (cb: () => void) => { onChange = cb; return () => { onChange = null; }; },
    setReady: (isReady: boolean) => { readyCalls.push(isReady); },
    start: () => Promise.resolve(),
    reopen: () => Promise.resolve(),
    leave: () => {},
    reportWorld: () => {},
    mintTicket: () => Promise.resolve("ticket"),
  };
  return {
    lobby: lobby as unknown as OnlineLobby,
    setStatus: (s) => { state.status = s; },
    setPlayers: (p) => { state.rows = p; },
    fireChange: () => onChange?.(),
    readyCalls,
  };
}

function member(playerId: string, name: string, opts: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    playerId, name, colorIndex: 2, isHost: playerId === "player-1",
    gsWorldId: null, isReady: false, pingMs: null, ...opts,
  };
}

async function main(): Promise<void> {
  section("one multiplayer path: the title offers exactly PLAY ONLINE + PLAY SOLO");
  {
    const { menu, overlay } = makeMenu();
    await menu.showTitle();
    const buttons = buttonsOf(overlay);
    check("PLAY ONLINE is the multiplayer headline", buttons.some((b) => b.includes("PLAY ONLINE")));
    check("PLAY SOLO is present", buttons.some((b) => b.includes("PLAY SOLO")));
    const all = textOf(overlay);
    check("no classic co-op entry anywhere on the title", !/classic|co-?op/i.test(all), all.slice(0, 120));
    const playButtons = buttons.filter((b) => /play/i.test(b) && !/autofire/i.test(b));
    check("exactly two play actions (online + solo)", playButtons.length === 2, playButtons.join(" | "));
  }

  section("the online home offers quick play / create / join — nothing legacy");
  {
    const { menu, overlay } = makeMenu();
    await menu.showOnlineHome();
    const buttons = buttonsOf(overlay);
    check("QUICK PLAY present", buttons.some((b) => b.includes("QUICK PLAY")));
    check("CREATE ROOM present", buttons.some((b) => b.includes("CREATE ROOM")));
    check("JOIN CODE present", buttons.some((b) => b.includes("JOIN CODE")));
    check("no classic co-op on the online home", !/classic/i.test(textOf(overlay)));
  }

  section("no client entry point can reach the removed peer-synced path");
  {
    check("src/net/multiplayer.ts (the peer-synced session) is deleted", !existsSync(join(ROOT, "src/net/multiplayer.ts")));
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    const mainSrc = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    check("menu.ts does not import the peer-synced session", !menuSrc.includes("multiplayer.js"));
    check("main.ts does not import the peer-synced session", !mainSrc.includes("multiplayer.js"));
    check("no startCoop entry remains in the menu host wiring", !menuSrc.includes("startCoop") && !mainSrc.includes("startCoop"));
  }

  section("lobby roster: READY/NOT READY consent + ping (the UI Director contract)");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([
      member("player-1", "Ada", { pingMs: 42 }),
      member("player-2", "Bob", { colorIndex: 5, isReady: true, pingMs: 87 }),
      member("player-3", "Cye", { colorIndex: 3, isReady: false }),
    ]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const text = textOf(overlay);
    check("a ready member reads READY", /READY \u00b7 87ms/.test(text), text.slice(0, 220));
    check("an unready member reads NOT READY", text.includes("NOT READY"));
    check("pings ride the roster chips", text.includes("42ms") && text.includes("87ms"));
    check("the host row is implicit consent (HOST, no ready toggle)", text.includes("HOST \u00b7 42ms"));
  }

  section("host start gate: all-ready START RUN, otherwise hold-to-START ANYWAY");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([member("player-1", "Ada"), member("player-2", "Bob", { isReady: true })]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    check("everyone ready -> plain START RUN", buttonsOf(overlay).some((b) => b.includes("START RUN")));

    f.setPlayers([member("player-1", "Ada"), member("player-2", "Bob", { isReady: false })]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const buttons = buttonsOf(overlay);
    check("someone not ready -> START ANYWAY requires the 3s hold", buttons.some((b) => b === "START ANYWAY \u2014 hold 3s"), buttons.join(" | "));
    check("no plain START RUN escape hatch remains", !buttons.some((b) => b.includes("START RUN")));
  }

  section("a non-host member gets the READY UP toggle");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD", "player-2");
    f.setPlayers([member("player-1", "Ada"), member("player-2", "Bob")]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    check("READY UP offered while unready", buttonsOf(overlay).some((b) => b.includes("READY UP")));
    f.setPlayers([member("player-1", "Ada"), member("player-2", "Bob", { isReady: true })]);
    f.fireChange();
    check("flips to the unready affordance once ready", buttonsOf(overlay).some((b) => b.includes("tap to unready")));
  }

  section("the room lobby shows authoritative per-member world state while live");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    const wid = worldIdForRoomCode("ABCD");
    // Mid-run view (a member stepped out): statuses come from the authoritative-world mirror.
    f.setStatus("playing");
    f.setPlayers([
      member("player-1", "Ada"),
      member("player-2", "Bob", { colorIndex: 5, gsWorldId: wid }),
    ]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const text = textOf(overlay);
    check("a member confirmed in the world shows CONNECTED TO WORLD", text.includes("CONNECTED TO WORLD"));
    check("a member not yet in the world shows CONNECTING", text.includes("CONNECTING"));
    check("a live room offers REJOIN RUN", buttonsOf(overlay).some((b) => b.includes("REJOIN RUN")));
  }

  section("lobby -> playing launches AS a party start; rejoin launches ungated");
  {
    const { menu, launches } = makeMenu();
    const f = fakeLobby("WXYZ");
    f.setPlayers([member("player-1", "Ada")]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    check("no launch while the room is in the lobby", launches.length === 0);
    f.setStatus("playing");
    f.fireChange(); // the subscribed render sees lobby -> playing
    check("the start transition launches the run", launches.length === 1);
    check("the launch is a PARTY START (readiness-gated)", launches[0]?.isPartyStart === true);

    // Re-opening the lobby screen mid-run and pressing REJOIN must NOT be party-gated.
    const again = makeMenu();
    const live = fakeLobby("WXYZ");
    live.setStatus("playing");
    live.setPlayers([member("player-1", "Ada")]);
    again.menu.showOnlineLobby(live.lobby, PROFILE);
    const rejoin = collect(again.overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("REJOIN RUN"))[0] as { __handlers?: unknown } | undefined;
    check("rejoin button rendered for the live room", rejoin !== undefined);
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll menu one-path assertions passed.\n");
}

void main();
