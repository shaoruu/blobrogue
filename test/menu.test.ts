// Menu one-path + readiness-surface + title-redesign suite. Renders the REAL Menu against
// the headless DOM shim and locks the product guarantees:
//   - ONE multiplayer path: the title offers exactly PLAY ONLINE + PLAY SOLO; no screen ever
//     mentions the removed peer-synced classic co-op, and no client entry point (menu/main)
//     imports it — the legacy path is unreachable for normal users
//   - the title's attention hierarchy: PLAY first; the compact global top-runs preview
//     renders its FINAL fixed geometry (5 rows) from first paint, hydration fills in place
//     (cached/uncached/failed all keep the same row count — zero layout shift), and a row
//     click opens that player's public profile (look + that run's build)
//   - explicit destinations: PROFILE & CLOSET / LEADERBOARD / SETTINGS; the full settings
//     panel is NOT inline on the title anymore
//   - the reserved identity card: guests get the Google CTA with concrete benefit copy,
//     signed-in players get the account chip — never both, and guest play is never gated
//   - the closet: equipped/locked states from real ownership; locked items carry their hint
//   - the post-run guest sign-in nudge: shown once per session with a persistent dismissal
//     cooldown; never for signed-in players; the cosmetic-unlock banner rides the same screen
//   - the room lobby shows each member's live readiness (LOBBY / CONNECTING… / CONNECTED TO
//     WORLD) from the authoritative-world mirror, and the lobby->playing transition launches
//     the run AS a party start (readiness-gated), while REJOIN launches ungated
// Run: npm run test:menu

import "./harness/domShim.js";
import { fireWindowEvent, lastFocused } from "./harness/domShim.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Menu } from "../src/ui/menu.js";
import type { MenuHost } from "../src/ui/menu.js";
import { Session } from "../src/net/session.js";
import type { AuthClient } from "../src/net/auth.js";
import type { OnlineLobby, LobbyPlayer } from "../src/net/onlineLobby.js";
import type { ProfileDoc, LeaderboardEntryDoc } from "../src/net/api.js";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { worldIdForRoomCode } from "../src/net/protocol.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { itemById } from "../src/sim/items.js";
import { NUDGE_DISMISSED_AT_KEY } from "../src/ui/signinNudge.js";
import { padActions } from "../src/ui/menuGamepad.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// Let the fire-and-forget hydration promises (profile login, leaderboard fetch) settle.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- headless tree readers (the dom shim tracks children + textContent) ----

interface ShimNode {
  tagName?: string;
  className?: string;
  textContent?: string;
  disabled?: boolean;
  onclick?: () => void;
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

function byClass(overlay: ShimNode, cls: string): ShimNode[] {
  return collect(overlay, (n) => typeof n.className === "string" && n.className.split(" ").includes(cls));
}

// ---- fakes ----

function makeProfile(overrides: Partial<ProfileDoc> = {}): ProfileDoc {
  return {
    playerId: "player-1", name: "blob", colorIndex: 2,
    cosmetics: { hat: null, face: null, body: null, title: null },
    totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, unlocks: [], isAccount: false,
    ...overrides,
  };
}

const PROFILE = makeProfile();

const LB_ENTRIES: LeaderboardEntryDoc[] = [
  {
    name: "Ada", colorIndex: 3, hat: "hat_crown", face: null, body: "body_pink", title: "title_depth_diver",
    floor: 12, kills: 230, coins: 90, durationMs: 754_000,
    weapons: ["pistol", "shotgun"], items: [{ id: "hair_trigger", count: 2 }], achievedAt: 1,
  },
  {
    name: "MaximumLengthBlobXX!", colorIndex: 5, hat: null, face: "face_shades", body: null, title: null,
    floor: 9, kills: 100, coins: 40, durationMs: 300_000,
    weapons: ["pistol"], items: [], achievedAt: 2,
  },
  {
    // A historical row whose cosmetic/build ids were RETIRED from the catalogs: must render
    // safely (no crash, no raw internal ids on the title surface, title hidden).
    name: "OldTimer", colorIndex: 1, hat: "hat_retired_2019", face: "face_gone", body: "body_gone", title: "title_gone",
    floor: 7, kills: 50, coins: 10, durationMs: 200_000,
    weapons: ["blunderbuss_x"], items: [{ id: "retired_item", count: 1 }], achievedAt: 3,
  },
];

interface FakeOpts {
  profile?: ProfileDoc;
  lb?: LeaderboardEntryDoc[] | "fail";
  standing?: { floor: number; kills: number; rank: number | null } | null | "fail";
  mine?: { entry: LeaderboardEntryDoc; rank: number | null } | null | "fail";
}

// The menu's Convex surface, routed by function name: profile upserts/reads resolve to the
// fixture, the leaderboard resolves (or fails) per test.
function fakeConvex(opts: FakeOpts = {}): ConvexClient {
  const profile = opts.profile ?? PROFILE;
  const fake = {
    mutation: () => Promise.resolve(profile),
    query: (ref: unknown) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
      if (name === "leaderboard:top") {
        return opts.lb === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(opts.lb ?? []);
      }
      if (name === "leaderboard:standing") {
        return opts.standing === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(opts.standing ?? null);
      }
      if (name === "leaderboard:mine") {
        return opts.mine === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(opts.mine ?? null);
      }
      if (name === "players:getProfile") return Promise.resolve(profile);
      return Promise.resolve(null);
    },
    action: () => Promise.resolve({ ticket: "t", playerId: profile.playerId }),
    onUpdate: () => () => {},
  };
  return fake as unknown as ConvexClient;
}

type FakeAuth = AuthClient & { fire(): void; setSignedIn(v: boolean): void; setCompleting(v: boolean): void };

function fakeAuth(isSignedIn: boolean, isCompletingSignIn = false): FakeAuth {
  const listeners = new Set<() => void>();
  const state = { isSignedIn, isCompletingSignIn };
  const auth = {
    get isSignedIn() { return state.isSignedIn; },
    get isCompletingSignIn() { return state.isCompletingSignIn; },
    signInWithGoogle: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    onChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    fire: () => { for (const cb of listeners) cb(); },
    setSignedIn: (v: boolean) => { state.isSignedIn = v; },
    setCompleting: (v: boolean) => { state.isCompletingSignIn = v; },
  };
  return auth as unknown as FakeAuth;
}

interface LaunchRecord { code: string; isPartyStart: boolean }

function makeMenu(opts: FakeOpts & { auth?: AuthClient | null } = {}): { menu: Menu; overlay: ShimNode; launches: LaunchRecord[]; session: Session } {
  // Section isolation: the shim shares ONE localStorage; stale appearance picks from a
  // previous section must never leak into a fresh session.
  localStorage.removeItem("blobrogue.cosmetics");
  localStorage.removeItem("blobrogue.color");
  localStorage.removeItem("blobrogue.closet.seenUnlocks");
  const overlay = document.createElement("div") as unknown as ShimNode;
  const client = fakeConvex(opts);
  const session = new Session(client);
  const launches: LaunchRecord[] = [];
  const host: MenuHost = {
    startSolo() {},
    startOnline(lobby, _profile, isPartyStart) {
      launches.push({ code: lobby.code, isPartyStart });
    },
  };
  const menu = new Menu(overlay as unknown as HTMLElement, session, client, opts.auth ?? null, host);
  return { menu, overlay, launches, session };
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

const RUN = { floor: 3, kills: 12, coins: 7, durationMs: 61_000 };

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

  section("title hierarchy: launchpad, not control panel — explicit destinations, settings off-surface");
  {
    const { menu, overlay } = makeMenu();
    await menu.showTitle();
    const buttons = buttonsOf(overlay);
    check("PROFILE destination", buttons.some((b) => b.startsWith("PROFILE")));
    check("SETTINGS destination", buttons.some((b) => b.startsWith("SETTINGS")));
    const navs = byClass(overlay, "nav-btn").map(textOf);
    check("the right side is about YOU: exactly PROFILE + SETTINGS (90px destination cards)",
      navs.length === 2 && navs[0].startsWith("PROFILE") && navs[1].startsWith("SETTINGS"), navs.join("|"));
    check("the leaderboard's explicit door is VIEW LEADERBOARD on the glance", buttons.some((b) => b.includes("VIEW LEADERBOARD")));
    check("the glance header is GLOBAL LEADERBOARD", textOf(overlay).includes("Global leaderboard"));
    const all = textOf(overlay);
    check("no inline settings controls on the title (sound/shake live behind SETTINGS)",
      !all.includes("sound:") && !all.includes("screen shake"), all.slice(0, 160));
    // Canonical home markup: home-body > home-left/home-right; reserved identity card;
    // fixed home-status; NO footer, NO right-side leaderboard door.
    check("canonical shell classes render", byClass(overlay, "menu-home").length === 1
      && byClass(overlay, "home-body").length === 1
      && byClass(overlay, "home-left").length === 1
      && byClass(overlay, "home-right").length === 1);
    check("the reserved identity card exists", byClass(overlay, "identity-card").length === 1);
    check("the fixed home-status line exists (reserved, empty)", byClass(overlay, "home-status").length === 1 && textOf(byClass(overlay, "home-status")[0]) === "");
    check("no home footer", byClass(overlay, "foot").length === 0);
    check("no Controls DESTINATION (the settings card may describe controls)", !buttonsOf(overlay).some((b) => /^controls\b/i.test(b.trim())));
  }

  section("top-runs glance: FINAL geometry from first paint; hydration fills in place");
  {
    const { menu, overlay } = makeMenu({ lb: LB_ENTRIES.slice(0, 2) });
    await menu.showTitle();
    const before = byClass(overlay, "lb-row");
    check("exactly 3 fixed rows at first paint (a glance, not a dashboard)", before.length === 3, String(before.length));
    check("skeleton rows are disabled (no dead click targets)", before.every((r) => r.disabled === true));
    const buttonsBefore = buttonsOf(overlay).length;
    await settle();
    const after = byClass(overlay, "lb-row");
    check("hydration keeps exactly 3 rows (zero layout shift)", after.length === 3);
    check("hydration adds/removes NO buttons (no click-target movement)", buttonsOf(overlay).length === buttonsBefore, `${buttonsBefore} -> ${buttonsOf(overlay).length}`);
    const rowText = textOf(after[0] as ShimNode);
    check("row 1 carries the top run", rowText.includes("Ada") && rowText.includes("FL 12"), rowText);
    check("a maximum-length name still rides its fixed row", textOf(after[1]).includes("MaximumLengthBlobXX!"));
    check("rows with entries are enabled", after[0].disabled === false && after[1].disabled === false);
    check("rows past the entries stay disabled placeholders", after[2].disabled === true && textOf(after[2]).includes("\u2014"));
  }

  section("the fixed own-rank state line: filled only when the player's best sits outside the rows");
  {
    // Present (reserved, empty) from first paint; hydration fills content only.
    const outside = makeMenu({ lb: LB_ENTRIES.slice(0, 2), standing: { floor: 6, kills: 40, rank: 7 } });
    await outside.menu.showTitle();
    const lineAtPaint = byClass(outside.overlay, "lb-standing");
    check("exactly one reserved state line in the panel", lineAtPaint.length === 1);
    await settle();
    check("a rank outside the rows fills the line", textOf(byClass(outside.overlay, "lb-standing")[0]).includes("rank #7"));
    check("...with the player's own best floor", textOf(byClass(outside.overlay, "lb-standing")[0]).includes("FL 6"));

    const onBoard = makeMenu({ lb: LB_ENTRIES.slice(0, 2), standing: { floor: 12, kills: 230, rank: 1 } });
    await onBoard.menu.showTitle();
    await settle();
    check("a rank INSIDE the rows keeps the line empty (the name is already on the board)",
      textOf(byClass(onBoard.overlay, "lb-standing")[0]) === "");

    const deep = makeMenu({ lb: LB_ENTRIES.slice(0, 2), standing: { floor: 2, kills: 5, rank: null } });
    await deep.menu.showTitle();
    await settle();
    check("below the ranked window reads honestly", textOf(byClass(deep.overlay, "lb-standing")[0]).includes("below the top 50"));

    const none = makeMenu({ lb: LB_ENTRIES.slice(0, 2), standing: null });
    await none.menu.showTitle();
    await settle();
    check("no charted run keeps the line empty", textOf(byClass(none.overlay, "lb-standing")[0]) === "");

    const broken = makeMenu({ lb: LB_ENTRIES.slice(0, 2), standing: "fail" });
    await broken.menu.showTitle();
    await settle();
    check("a failed standing fetch keeps the line empty (same geometry)", textOf(byClass(broken.overlay, "lb-standing")[0]) === "");

    // The line is SHARED: a board-level state (offline) always outranks the rank readout.
    const offline = makeMenu({ lb: "fail", standing: { floor: 6, kills: 40, rank: 7 } });
    await offline.menu.showTitle();
    await settle();
    const sharedLine = textOf(byClass(offline.overlay, "lb-standing")[0]);
    check("an offline board outranks the rank readout in the shared line",
      sharedLine.includes("leaderboard unavailable") && !sharedLine.includes("rank #7"), sharedLine);
  }

  section("safe anonymized fallback: a blank name never renders empty or raw");
  {
    const blank: LeaderboardEntryDoc = { ...LB_ENTRIES[1], name: "   " };
    const { menu, overlay } = makeMenu({ lb: [blank] });
    await menu.showTitle();
    await settle();
    const row = byClass(overlay, "lb-row")[0];
    check("the row shows an anonymous label", textOf(row).includes("anonymous blob"));
    row.onclick?.();
    check("the profile headline anonymizes too", textOf(overlay).includes("ANONYMOUS BLOB"));
    await menu.showTitle();
  }

  section("top-runs glance failure: same geometry, honest note, no dead end");
  {
    const { menu, overlay } = makeMenu({ lb: "fail" });
    await menu.showTitle();
    await settle();
    const rows = byClass(overlay, "lb-row");
    check("still exactly 3 rows after a failed fetch", rows.length === 3);
    check("all rows disabled", rows.every((r) => r.disabled === true));
    check("the reserved note line explains", textOf(overlay).includes("leaderboard unavailable"));
  }

  section("a leaderboard row opens that player's public profile: look + that run's build");
  {
    const { menu, overlay } = makeMenu({ lb: LB_ENTRIES });
    await menu.showTitle();
    await settle();
    const row = byClass(overlay, "lb-row")[0];
    check("row is clickable", typeof row.onclick === "function");
    row.onclick?.();
    const all = textOf(overlay);
    check("the fixed profile card renders", byClass(overlay, "profile-card").length === 1);
    check("the 192px appearance stage exists", byClass(overlay, "blob-stage").length === 1);
    check("appearance/name lead the card", all.includes("ADA"));
    check("the ranked result rides the left column", all.includes("rank #1") && all.includes("best FL 12"));
    check("read-only context is explicit", all.includes("read only"));
    check("best-run stats shown", all.includes("12") && all.includes("230"));
    check("build shows the run's weapons by display name", all.includes(WEAPONS.pistol.name) && all.includes(WEAPONS.shotgun.name));
    const itemName = itemById("hair_trigger")?.name ?? "";
    check("build shows blessings with levels", itemName.length > 0 && all.includes(`${itemName} Lv2`));
    check("the SNAPSHOTTED worn title shows on the profile", all.includes("Depth Diver"));
    check("lifetime stats are an honest PRIVATE state (never faked)", all.includes("lifetime stats are private"));
    const btns = buttonsOf(overlay);
    check("a back action exists", btns.some((b) => b === "back"));
    check("NO edit controls on another player's profile", !btns.some((b) => b.includes("CUSTOMIZE") || b === "sign out" || b.includes("OVERVIEW") || b.includes("CLOSET")));
    check("no account/private fields leak (name/appearance/run data only)", !all.includes("@") && !all.toLowerCase().includes("email"));

    // Retired-id fallback: the historical row renders safely — the retired title is HIDDEN
    // (never a raw internal id on a public surface) and the unknown build ids show as data.
    await menu.showLeaderboard();
    await settle();
    const retiredRow = byClass(overlay, "lb-row")[2];
    retiredRow.onclick?.();
    const retired = textOf(overlay);
    check("a retired-cosmetics row still opens its profile", retired.includes("OLDTIMER"));
    check("a retired TITLE id renders as no title (never a raw id)", !retired.includes("title_gone"));
    check("retired hat/face/body ids never leak as text either", !retired.includes("hat_retired_2019") && !retired.includes("face_gone") && !retired.includes("body_gone"));
    // Return to the title so this menu's Escape handler is torn down — the shim shares one
    // window across sections (the real app only ever has one live menu).
    await menu.showTitle();
  }

  section("persistence authority: a pick the server refuses never lingers as local truth");
  {
    const { session } = makeMenu(); // fake backend always answers with EMPTY loadout
    session.setCosmetic("hat", "hat_halo"); // locked pick, applied optimistically
    check("optimistic local apply", session.cosmetics.hat === "hat_halo");
    await session.login("blob");
    check("the server's answer reconciles the local pick away", session.cosmetics.hat === null, String(session.cosmetics.hat));
    // An ACCEPTED pick round-trips and stays.
    const accepted = makeMenu({ profile: makeProfile({ cosmetics: { hat: "hat_top", face: null, body: null, title: null } }) });
    accepted.session.setCosmetic("hat", "hat_top");
    await accepted.session.login("blob");
    check("an accepted pick survives reconcile", accepted.session.cosmetics.hat === "hat_top");
  }

  section("destinations exist for BOTH auth states; Escape mirrors Back with named focus restore");
  {
    const signed = makeMenu({ auth: fakeAuth(true) });
    await signed.menu.showTitle();
    const navs = byClass(signed.overlay, "nav-btn").map(textOf);
    check("signed-in title keeps the same destinations", navs.length === 2 && navs[0].startsWith("PROFILE") && navs[1].startsWith("SETTINGS"), navs.join("|"));
    check("...and the same leaderboard door", buttonsOf(signed.overlay).some((b) => b.includes("VIEW LEADERBOARD")));

    const { menu, overlay } = makeMenu({ lb: LB_ENTRIES });
    await menu.showSettings();
    check("settings screen is open", textOf(overlay).includes("SETTINGS") && textOf(overlay).includes("everything saves instantly"));
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape returns to the title", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
    const focusedAfterSettings = lastFocused();
    check("focus restored to the SETTINGS destination by name",
      focusedAfterSettings?.className?.includes("nav-btn") === true && focusedAfterSettings?.textContent === "SETTINGS",
      `${focusedAfterSettings?.className} / ${focusedAfterSettings?.textContent}`);

    await menu.showProfile();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from profile restores the PROFILE destination", lastFocused()?.textContent === "PROFILE");

    await menu.showLeaderboard();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from leaderboard restores the VIEW LEADERBOARD door", lastFocused()?.className?.includes("lb-view") === true, lastFocused()?.className);

    await menu.showOnlineHome();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from the online home lands back on PLAY ONLINE", lastFocused()?.className?.includes("btn-quick") === true, lastFocused()?.className);

    // Player profile -> Escape restores focus to the exact leaderboard row it came from.
    await menu.showLeaderboard();
    await settle();
    const row1 = byClass(overlay, "lb-row")[1];
    row1.onclick?.();
    check("player profile open", textOf(overlay).includes("read only"));
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape restores focus to the originating leaderboard row", lastFocused()?.className?.includes("lb-row") === true, lastFocused()?.className);

    // A stale Escape handler must never fire on the title (teardown on every transition).
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape on the title is inert (no screen change)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
  }

  section("synchronous shell + in-place auth settle (the post-OAuth boot)");
  {
    // Returning from Google: the identity card renders its reserved pending state at
    // FIRST paint (no guest-CTA flash), then settles IN PLACE when the exchange lands —
    // the shell around it (play buttons, glance, destinations) never rebuilds.
    const auth = fakeAuth(false, true);
    const { menu, overlay } = makeMenu({ auth, lb: LB_ENTRIES.slice(0, 2) });
    await menu.showTitle();
    check("pending state renders in the reserved identity card", textOf(overlay).includes("signing you in"));
    check("no guest CTA while the exchange is pending", !buttonsOf(overlay).some((b) => b.includes("Sign in with Google")));
    const playBefore = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    auth.setCompleting(false);
    auth.setSignedIn(true);
    auth.fire();
    const playAfter = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    check("the exchange settles into the account chip in place", byClass(overlay, "account").length === 1);
    check("the shell around the identity card is NOT rebuilt (same play node)", playBefore === playAfter);

    // The failure path settles into the guest CTA instead — same box.
    const failAuth = fakeAuth(false, true);
    const failed = makeMenu({ auth: failAuth, lb: [] });
    await failed.menu.showTitle();
    failAuth.setCompleting(false);
    failAuth.fire();
    check("a failed exchange settles into the guest CTA", buttonsOf(failed.overlay).some((b) => b.includes("Sign in with Google")));
  }

  section("failure/retry geometry: action-screen status lines are reserved boxes");
  {
    const { menu, overlay } = makeMenu();
    await menu.showOnlineHome("finding a room\u2026");
    check("the online home status is a reserved .status-line", byClass(overlay, "status-line").length === 1);
    check("status copy renders inside it", textOf(byClass(overlay, "status-line")[0]).includes("finding a room"));
  }

  section("sign-out flushes prior-user data (no stale profile leaks into the guest render)");
  {
    const { session } = makeMenu({ profile: makeProfile({ cosmetics: { hat: "hat_top", face: null, body: null, title: null }, deepestFloor: 9, unlocks: ["hat_crown"] }) });
    await session.login("someone");
    check("profile cached after login", session.profile !== null && session.profile.deepestFloor === 9);
    check("profile cosmetics adopted while cached", session.cosmetics.hat === "hat_top");
    session.clearProfile();
    check("clearProfile drops the cached row", session.profile === null);
    check("cosmetics fall back to this browser's own picks only", session.cosmetics.hat === null);
  }

  section("reserved identity card: guest CTA with benefits vs the account chip");
  {
    const guest = makeMenu({ auth: fakeAuth(false) });
    await guest.menu.showTitle();
    const guestText = textOf(guest.overlay);
    check("guest sees the Google CTA", buttonsOf(guest.overlay).some((b) => b.includes("Sign in with Google")));
    check("CTA pitches concrete benefits", guestText.includes("cosmetics & leaderboard runs") && guestText.includes("across devices"));
    check("guest keeps the name input (play is never gated)", collect(guest.overlay, (n) => n.tagName === "INPUT").length === 1);

    const signed = makeMenu({ auth: fakeAuth(true) });
    await signed.menu.showTitle();
    check("signed-in shows the account chip (display only)", byClass(signed.overlay, "account").length === 1);
    check("sign-out does NOT live on the title (it belongs to the profile)", !buttonsOf(signed.overlay).some((b) => b === "sign out"));
    check("signed-in has NO sign-in CTA", !buttonsOf(signed.overlay).some((b) => b.includes("Sign in with Google")));
    check("signed-in states what the account holds", textOf(signed.overlay).includes("saved to this account"));
  }

  section("own profile Overview: the same fixed surface, owner extras, real data only");
  {
    const MINE = { entry: { ...LB_ENTRIES[0], name: "blob" }, rank: 4 };
    const { menu, overlay } = makeMenu({
      auth: fakeAuth(true),
      profile: makeProfile({ deepestFloor: 12, totalKills: 230, totalCoins: 90, gamesPlayed: 8 }),
      mine: MINE,
    });
    await menu.showProfile();
    await settle();
    const all = textOf(overlay);
    check("the SAME fixed card surface renders", byClass(overlay, "profile-card").length === 1 && byClass(overlay, "blob-stage").length === 1);
    check("CUSTOMIZE BLOB is the closet door", buttonsOf(overlay).some((b) => b === "CUSTOMIZE BLOB"));
    check("Overview/Closet tabs exist", buttonsOf(overlay).some((b) => b === "OVERVIEW") && buttonsOf(overlay).some((b) => b === "CLOSET"));
    check("own ranked result from the REAL charted entry", all.includes("rank #4") && all.includes("best FL 12"));
    check("own top-run build renders", all.includes(WEAPONS.pistol.name));
    check("REAL lifetime stats render (deepest/kills/coins/runs)", all.includes("230") && all.includes("8"));
    check("account + sign-out live HERE", byClass(overlay, "account").length === 1 && buttonsOf(overlay).some((b) => b === "sign out"));

    // Uncharted guest: every region keeps its box with honest empty states.
    const fresh = makeMenu({ mine: null });
    await fresh.menu.showProfile();
    await settle();
    const freshAll = textOf(fresh.overlay);
    check("uncharted profile keeps the card with honest states", byClass(fresh.overlay, "profile-card").length === 1 && freshAll.includes("no charted run yet"));
    check("guest account region is the honest guest line", freshAll.includes("playing as guest"));

    // Failed own-run fetch: same geometry, honest note.
    const broken = makeMenu({ mine: "fail" });
    await broken.menu.showProfile();
    await settle();
    check("a failed top-run fetch stays honest in the same box", textOf(broken.overlay).includes("top run unavailable"));
  }

  section("the closet: browse previews, EQUIP commits per category, reset + discard guard");
  {
    const { menu, overlay, session } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const cats = () => byClass(overlay, "closet-cat");
    const cards = () => byClass(overlay, "cos-tile");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const stageState = () => textOf(byClass(overlay, "closet-stage-state")[0]);

    check("real categories only, in order", cats().map(textOf).join("|") === "Hats|Glasses|Blob Color|Titles", cats().map(textOf).join("|"));
    check("the always-unlocked No Hat card exists and reads EQUIPPED", textOf(cardByName("No Hat") ?? {}).includes("EQUIPPED"));
    const crown = cardByName("Crown");
    check("locked cards are DISABLED (cannot focus/equip)", crown?.disabled === true);
    check("locked cards wear their exact configured condition", textOf(crown ?? {}).includes("reach floor 10"));
    check("stage starts in the EQUIPPED state", stageState() === "EQUIPPED");

    // Browsing writes the TEMPORARY preview only.
    cardByName("Top Hat")?.onclick?.();
    check("browsing flips the stage to PREVIEWING", stageState().includes("PREVIEWING"));
    check("...but persists NOTHING", session.cosmetics.hat === null);
    check("the browsed card reads PREVIEWING", textOf(cardByName("Top Hat") ?? {}).includes("PREVIEWING"));

    // Pending picks survive category switches.
    cats().find((c) => textOf(c) === "Glasses")?.onclick?.();
    cardByName("Shades")?.onclick?.();
    cats().find((c) => textOf(c) === "Hats")?.onclick?.();
    check("the hat preview survived the category round-trip", textOf(cardByName("Top Hat") ?? {}).includes("PREVIEWING"));

    // EQUIP persists the ACTIVE category only.
    byClass(overlay, "closet-equip")[0]?.onclick?.();
    check("EQUIP persisted the active category", session.cosmetics.hat === "hat_top");
    check("...and ONLY the active category (glasses stay a preview)", session.cosmetics.face === null && stageState().includes("PREVIEWING"));

    // RESET restores equipped without any write.
    byClass(overlay, "closet-reset")[0]?.onclick?.();
    check("RESET discards pending picks", stageState() === "EQUIPPED");
    check("...without writing", session.cosmetics.face === null && session.cosmetics.hat === "hat_top");

    // Leaving with unsaved picks demands an explicit decision (same fixed strip).
    cats().find((c) => textOf(c) === "Glasses")?.onclick?.();
    cardByName("Round Specs")?.onclick?.();
    fireWindowEvent("keydown", { key: "Escape" });
    check("Escape with unsaved preview swaps in the discard confirmation", textOf(overlay).includes("discard unsaved preview?"));
    byClass(overlay, "closet-keep")[0]?.onclick?.();
    check("KEEP BROWSING stays in the closet with the preview intact", stageState().includes("PREVIEWING"));
    fireWindowEvent("keydown", { key: "Escape" });
    byClass(overlay, "closet-discard")[0]?.onclick?.();
    await settle();
    check("DISCARD leaves to the title with nothing written", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")) && session.cosmetics.face === null);
  }

  section("controller parity: pure pad mapping + LB/RB category cycling + guarded close");
  {
    // Edge detection: a held button fires exactly once.
    const idle = new Array<boolean>(16).fill(false);
    const aDown = idle.slice(); aDown[0] = true;
    check("A press maps to activate", padActions(idle, aDown).join(",") === "activate");
    check("A held fires nothing further", padActions(aDown, aDown).length === 0);
    const bDown = idle.slice(); bDown[1] = true;
    check("B maps to back (the guarded Escape path)", padActions(idle, bDown).join(",") === "back");
    const dpad = idle.slice(); dpad[13] = true;
    check("D-pad down maps to focusNext", padActions(idle, dpad).join(",") === "focusNext");
    const lb = idle.slice(); lb[4] = true;
    const rb = idle.slice(); rb[5] = true;
    check("LB/RB map to tab cycling", padActions(idle, lb).join(",") === "tabPrev" && padActions(idle, rb).join(",") === "tabNext");

    // LB/RB cycles the closet's REAL categories through the menu's tab hook.
    const { menu, overlay, session } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    menu.cycleTabs(1);
    const cards = () => byClass(overlay, "cos-tile").map(textOf);
    check("RB cycles to the next real category (Glasses)", cards().some((c) => c.includes("No Glasses")), cards().join("|").slice(0, 80));
    menu.cycleTabs(-1);
    check("LB cycles back (Hats)", cards().some((c) => c.includes("No Hat")));

    // The visible close routes through the SAME discard guard.
    byClass(overlay, "cos-tile").find((c) => textOf(c).includes("Top Hat"))?.onclick?.();
    byClass(overlay, "panel-close")[0]?.onclick?.();
    check("close with unsaved preview raises the discard confirmation", textOf(overlay).includes("discard unsaved preview?"));
    byClass(overlay, "closet-discard")[0]?.onclick?.();
    await settle();
    check("discard via close leaves cleanly with nothing written", session.cosmetics.hat === null);
  }

  section("run build is the trusted HISTORICAL snapshot — absent says so honestly");
  {
    const noBuild: LeaderboardEntryDoc = { ...LB_ENTRIES[0], weapons: [], items: [] };
    const { menu, overlay } = makeMenu({ lb: [noBuild] });
    await menu.showTitle();
    await settle();
    byClass(overlay, "lb-row")[0]?.onclick?.();
    check("an entry recorded without a build reads RUN BUILD NOT SAVED", textOf(overlay).includes("RUN BUILD NOT SAVED"));
    check("...and never falls back to a current loadout", !textOf(overlay).includes(WEAPONS.pistol.name));
    await menu.showTitle();
  }

  section("closet: body color category, NEW badges, and clean-exit behavior");
  {
    const { menu, overlay, session } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const cats = () => byClass(overlay, "closet-cat");
    const cards = () => byClass(overlay, "cos-tile");
    cats().find((c) => textOf(c) === "Blob Color")?.onclick?.();
    check("body colors render as cards with the Amber default", cards().some((c) => textOf(c).includes("Amber (classic)")));
    cards().find((c) => textOf(c).includes("Cyan"))?.onclick?.();
    byClass(overlay, "closet-equip")[0]?.onclick?.();
    check("equipping a body color drives BOTH color layers", session.colorIndex === 1 && session.cosmetics.body === "body_cyan");
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("leaving with nothing unsaved just closes (no confirmation)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));

    // NEW badge: a real unlock earned since the last visit wears the star ONCE.
    const fresh = makeMenu({ profile: makeProfile({ unlocks: ["hat_crown"] }) });
    await fresh.menu.showProfile("closet");
    await settle();
    const crownCard = () => byClass(fresh.overlay, "cos-tile").find((c) => textOf(c).includes("Crown"));
    check("a freshly earned unlock reads NEW (and is enabled)", textOf(crownCard() ?? {}).includes("NEW") && crownCard()?.disabled !== true);
    await fresh.menu.showProfile("closet");
    await settle();
    check("the NEW badge clears on the next visit (marked seen)", !textOf(crownCard() ?? {}).includes("NEW"));
  }

  section("post-run sign-in nudge: guests once per session, cooldown-guarded, honest copy");
  {
    localStorage.removeItem(NUDGE_DISMISSED_AT_KEY);
    const guest = makeMenu({ auth: fakeAuth(false) });
    guest.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null, newUnlocks: ["hat_crown"] });
    const text = textOf(guest.overlay);
    check("nudge offers Google sign-in", buttonsOf(guest.overlay).some((b) => b.includes("Sign in with Google")));
    check("nudge offers 'not now'", buttonsOf(guest.overlay).some((b) => b === "not now"));
    check("the earned cosmetic strengthens the pitch", text.includes("Crown") && text.includes("only lives in this browser"));
    check("unlock banner celebrates the earn", text.includes("NEW COSMETIC UNLOCKED"));

    guest.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null });
    check("never twice in one session", !buttonsOf(guest.overlay).some((b) => b === "not now"));

    localStorage.setItem(NUDGE_DISMISSED_AT_KEY, String(Date.now()));
    const dismissed = makeMenu({ auth: fakeAuth(false) });
    dismissed.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null });
    check("a fresh session inside the dismissal cooldown stays quiet", !buttonsOf(dismissed.overlay).some((b) => b === "not now"));
    localStorage.removeItem(NUDGE_DISMISSED_AT_KEY);

    const signed = makeMenu({ auth: fakeAuth(true) });
    signed.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null });
    check("signed-in players are never nudged", !buttonsOf(signed.overlay).some((b) => b.includes("Sign in with Google")));

    const noProgress = makeMenu({ auth: fakeAuth(false) });
    noProgress.menu.showGameOver(RUN, null, { isNewBest: false, online: null });
    check("an unsaved run (dead backend) never nudges — the pitch would be hollow", !buttonsOf(noProgress.overlay).some((b) => b.includes("Sign in with Google")));
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
    const rejoin = collect(again.overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("REJOIN RUN"))[0];
    check("rejoin button rendered for the live room", rejoin !== undefined);
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll menu one-path + redesign assertions passed.\n");
}

void main();
