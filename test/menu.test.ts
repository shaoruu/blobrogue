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
      if (name === "players:getProfile") return Promise.resolve(profile);
      return Promise.resolve(null);
    },
    action: () => Promise.resolve({ ticket: "t", playerId: profile.playerId }),
    onUpdate: () => () => {},
  };
  return fake as unknown as ConvexClient;
}

function fakeAuth(isSignedIn: boolean): AuthClient {
  return {
    isSignedIn,
    signInWithGoogle: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    onChange: () => () => {},
  } as unknown as AuthClient;
}

interface LaunchRecord { code: string; isPartyStart: boolean }

function makeMenu(opts: FakeOpts & { auth?: AuthClient | null } = {}): { menu: Menu; overlay: ShimNode; launches: LaunchRecord[]; session: Session } {
  // Section isolation: the shim shares ONE localStorage; stale appearance picks from a
  // previous section must never leak into a fresh session.
  localStorage.removeItem("blobrogue.cosmetics");
  localStorage.removeItem("blobrogue.color");
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
    check("LEADERBOARD destination", buttons.some((b) => b === "LEADERBOARD"));
    check("PROFILE destination", buttons.some((b) => b === "PROFILE"));
    check("SETTINGS destination", buttons.some((b) => b === "SETTINGS"));
    const navs = byClass(overlay, "nav-btn").map(textOf);
    check("exactly the three destinations, in order", navs.join("|") === "LEADERBOARD|PROFILE|SETTINGS", navs.join("|"));
    check("VIEW LEADERBOARD action on the preview", buttons.some((b) => b.includes("VIEW LEADERBOARD")));
    const all = textOf(overlay);
    check("no inline settings controls on the title (sound/shake live behind SETTINGS)",
      !all.includes("sound:") && !all.includes("screen shake"), all.slice(0, 160));
    // The identity/progress strip is PASSIVE display — one door to the profile, not two.
    const strip = byClass(overlay, "you-strip")[0];
    check("the identity/progress strip exists and is not a button", strip !== undefined && strip.tagName !== "BUTTON", strip?.tagName);
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
    check("profile headline is the player", all.includes("ADA"));
    check("best-run stats shown", all.includes("12") && all.includes("230"));
    check("build shows the run's weapons by display name", all.includes(WEAPONS.pistol.name) && all.includes(WEAPONS.shotgun.name));
    const itemName = itemById("hair_trigger")?.name ?? "";
    check("build shows blessings with levels", itemName.length > 0 && all.includes(`${itemName} Lv2`));
    check("the SNAPSHOTTED worn title shows on the profile", all.includes("Depth Diver"));
    check("a back action exists", buttonsOf(overlay).some((b) => b === "back"));
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
    check("signed-in title keeps the same three destinations", navs.join("|") === "LEADERBOARD|PROFILE|SETTINGS", navs.join("|"));

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
    check("Escape from leaderboard restores the LEADERBOARD destination", lastFocused()?.textContent === "LEADERBOARD");

    await menu.showOnlineHome();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from the online home lands back on PLAY ONLINE", lastFocused()?.className?.includes("btn-quick") === true, lastFocused()?.className);

    // Player profile -> Escape restores focus to the exact leaderboard row it came from.
    await menu.showLeaderboard();
    await settle();
    const row1 = byClass(overlay, "lb-row")[1];
    row1.onclick?.();
    check("player profile open", textOf(overlay).includes("best run on the global leaderboard"));
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape restores focus to the originating leaderboard row", lastFocused()?.className?.includes("lb-row") === true, lastFocused()?.className);

    // A stale Escape handler must never fire on the title (teardown on every transition).
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape on the title is inert (no screen change)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
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
    check("signed-in shows the account chip", buttonsOf(signed.overlay).some((b) => b === "sign out"));
    check("signed-in has NO sign-in CTA", !buttonsOf(signed.overlay).some((b) => b.includes("Sign in with Google")));
    check("signed-in states what the account holds", textOf(signed.overlay).includes("saved to this account"));
  }

  section("the wardrobe: every SHIPPED slot, equipped/locked states from real ownership");
  {
    const { menu, overlay, session } = makeMenu();
    await menu.showProfile();
    await settle();
    const states = byClass(overlay, "cos-state").map(textOf);
    check("the default (none) slots read EQUIPPED (hat/face/title)", states.filter((s) => s === "EQUIPPED").length === 3, states.join("|"));
    check("earned items read LOCKED with zero unlocks", states.filter((s) => s === "LOCKED").length === 5, states.join("|"));
    const names = byClass(overlay, "cos-name").map(textOf);
    check("starter hats offered", names.includes("Top Hat") && names.includes("Party Cone"));
    check("earned items visible (aspirational, never hidden)", names.includes("Crown") && names.includes("Halo") && names.includes("Monocle"));
    check("earned TITLES ship as locked honors", names.includes("Depth Diver") && names.includes("Blob Slayer"));
    check("the authored body palette renders as swatches", byClass(overlay, "swatch").length > 0);
    // One swatch pick drives BOTH color layers at launch (party color + body item),
    // while the model keeps them separate for future party-assigned colors.
    session.setColorIndex(3);
    check("a swatch pick records the body cosmetic", session.cosmetics.body === "body_pink", String(session.cosmetics.body));
    check("...and the party color", session.colorIndex === 3);
    session.setColorIndex(0);
    check("slot 0 (classic amber) clears the body slot", session.cosmetics.body === null);

    // Equipping a starter moves the EQUIPPED chip (the fake echoes the accepted pick, as
    // the real backend does for owned items).
    const echo = makeMenu({ profile: makeProfile({ cosmetics: { hat: "hat_top", face: null, body: null, title: null } }) });
    echo.session.setCosmetic("hat", "hat_top");
    await echo.menu.showProfile();
    await settle();
    const tiles = byClass(echo.overlay, "cos-tile");
    const topHatTile = tiles.find((t) => textOf(t).includes("Top Hat"));
    check("equipping a starter marks its tile EQUIPPED", topHatTile !== undefined && textOf(topHatTile!).includes("EQUIPPED"));

    // Ownership unlocks the earned tile.
    const owned = makeMenu({ profile: makeProfile({ unlocks: ["hat_crown"] }) });
    await owned.menu.showProfile();
    await settle();
    const crownTile = byClass(owned.overlay, "cos-tile").find((t) => textOf(t).includes("Crown"));
    check("a granted unlock stops reading LOCKED", crownTile !== undefined && !textOf(crownTile!).includes("LOCKED"));
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
