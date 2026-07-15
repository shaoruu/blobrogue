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
//   - the title character stage: the player's ACTUAL blob (shared renderer) in a reserved
//     hero box — guest default, hydration repaints content only, Play stays dominant
//   - the closet: INSTANT equip (no staging/save/discard model), optimistic persistence
//     with revert-on-failure and last-click-wins, locked items readable but never equippable
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
import { getSelectedKit, setSelectedKit } from "../src/net/kitSelection.js";
import type { RunLoadout } from "../src/net/kitSelection.js";
import { NUDGE_DISMISSED_AT_KEY, NUDGE_SHOWN_AT_KEY } from "../src/ui/signinNudge.js";
import { gridTargetIndex, padActions } from "../src/ui/menuGamepad.js";
import { CHANGELOG, LATEST_VERSION } from "../src/generated/changelog.js";
import {
  COPY_INVITE_LABEL, INVITE_COPIED_LABEL, INVITE_SHARED_LABEL, INVITE_COPY_FAILED_LABEL,
  INVITE_OFFLINE_NOTE, INVITE_UNREACHABLE_NOTE, ARENA_LABEL, ARENA_PATCHING_LABEL,
} from "../src/ui/onlineCopy.js";
import { PVP_PUBLIC_ENABLED, PVP_DISABLED_MESSAGE } from "../src/net/pvpFlag.js";

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

// The invite sections drive the REAL OnlineLobby, whose 5s heartbeat interval would hold
// the Node process open after the last check; unref'd intervals behave identically while
// letting the suite exit. (setTimeout stays real — settle() depends on it firing.)
const nodeSetInterval = setInterval;
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  const t = nodeSetInterval(fn, ms);
  t.unref();
  return t;
}) as typeof setInterval;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- headless tree readers (the dom shim tracks children + textContent) ----

interface ShimNode {
  tagName?: string;
  className?: string;
  textContent?: string;
  disabled?: boolean;
  value?: string;
  width?: number;
  height?: number;
  onclick?: () => void;
  children?: ShimNode[];
  getAttribute?(name: string): string | null;
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
    totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, amber: 0, unlocks: [], isAccount: false,
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

interface EnsureArgs {
  name?: string;
  colorIndex?: number;
  cosmetics?: Partial<Record<"hat" | "face" | "body" | "title", string>>;
  kitId?: string;
  petId?: string | null;
  isKitChoiceMade?: boolean;
  isPetChoiceMade?: boolean;
}

// One deferred ensurePlayer write the test settles by hand (the rapid-switch suite).
interface PendingPersist {
  args: EnsureArgs;
  resolveEcho: () => void;
  fail: () => void;
}

interface PendingLoadoutPersist {
  resolveSuccess: () => void;
}

interface FakeOpts {
  profile?: ProfileDoc;
  lb?: LeaderboardEntryDoc[] | "fail";
  standing?: { floor: number; kills: number; rank: number | null } | null | "fail";
  mine?: { entry: LeaderboardEntryDoc; rank: number | null } | null | "fail";
  // How ensurePlayer answers: "echo" (default — accepted picks round-trip exactly like
  // the real backend), "static" (the fixture untouched — a server refusing every pick),
  // "fail" (network failure), "manual" (the test settles each write by hand, in any order).
  persist?: "echo" | "static" | "fail" | "manual";
  loadoutPersist?: "ok" | "fail" | "manual" | "pet_rejected";
  isLoadoutPreserved?: boolean;
  // The rooms:join answer for invite tests: a joined room, or the server's real refusal.
  // Read at CALL time, so a test can flip it between attempts (the TRY AGAIN path).
  join?: { code: string; status: "lobby" | "playing" } | "full" | "ended" | "missing" | "classic" | "error";
}

interface FakeConvex {
  client: ConvexClient;
  pendingPersists: PendingPersist[];
  pendingLoadoutPersists: PendingLoadoutPersist[];
  mutationCalls: () => number;
}

// The menu's Convex surface, routed by function name: profile upserts/reads resolve to the
// fixture, the leaderboard resolves (or fails) per test. rooms:join answers invite tests, and
// mutation names are recorded (in order) via the shared `calls` array for the guest identity path.
function fakeConvex(opts: FakeOpts = {}, calls: string[] = []): FakeConvex {
  const profile = opts.profile ?? PROFILE;
  const pendingPersists: PendingPersist[] = [];
  const pendingLoadoutPersists: PendingLoadoutPersist[] = [];
  let mutationCount = 0;
  const echo = (args: EnsureArgs): ProfileDoc => {
    const cosmetics = { ...profile.cosmetics };
    for (const slot of ["hat", "face", "body", "title"] as const) {
      const v = args.cosmetics?.[slot];
      if (v !== undefined) cosmetics[slot] = v === "none" ? null : v;
    }
    return { ...profile, cosmetics, colorIndex: args.colorIndex ?? profile.colorIndex };
  };
  const fake = {
    mutation: (ref: unknown, args?: EnsureArgs) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
      calls.push(name);
      if (name === "rooms:join") {
        // The EXACT error strings convex/rooms.ts throws — the mapping under test
        // consumes these, so the fixture must never drift from the real mutation.
        if (opts.join === "full") return Promise.reject(new Error("that room is full"));
        if (opts.join === "ended") return Promise.reject(new Error("that game has ended"));
        if (opts.join === "missing") return Promise.reject(new Error("no room with that code"));
        if (opts.join === "classic") return Promise.reject(new Error("that code is a classic co-op room"));
        if (opts.join === "error" || opts.join === undefined) return Promise.reject(new Error("boom"));
        return Promise.resolve({
          roomId: "room-doc-1", code: opts.join.code, seed: 1, floor: 1,
          status: opts.join.status, loadoutGeneration: 1,
          kitId: args?.kitId ?? "gunner", petId: args?.petId ?? null,
        });
      }
      if (name === "players:confirmRunLoadout") {
        mutationCount++;
        if (opts.loadoutPersist === "fail") return Promise.reject(new Error("offline"));
        const result = {
          ok: true,
          profile: {
            ...profile,
            lastKitId: args?.kitId ?? "gunner",
            equippedPet: args?.petId ?? null,
          },
        };
        if (opts.loadoutPersist === "pet_rejected" && args?.petId !== null) {
          return Promise.resolve({ ok: false, reason: "pet_unowned", profile });
        }
        if (opts.loadoutPersist === "manual") {
          return new Promise((resolve) => {
            pendingLoadoutPersists.push({ resolveSuccess: () => resolve(result) });
          });
        }
        return Promise.resolve(result);
      }
      if (name === "players:setCustomName") {
        // The account custom-name override: the server echoes the sanitized name as the
        // effective display name (fail mode still models a network failure).
        mutationCount++;
        if (opts.persist === "fail") return Promise.reject(new Error("offline"));
        return Promise.resolve({ ...profile, name: (args ?? {}).name ?? profile.name });
      }
      // profile writes (players:ensurePlayer): apply the persist mode
      mutationCount++;
      const sent = args ?? {};
      if (opts.persist === "fail") return Promise.reject(new Error("offline"));
      if (opts.persist === "static") return Promise.resolve(profile);
      if (opts.persist === "manual") {
        return new Promise((resolve, reject) => {
          pendingPersists.push({
            args: sent,
            resolveEcho: () => resolve(echo(sent)),
            fail: () => reject(new Error("offline")),
          });
        });
      }
      return Promise.resolve(echo(sent));
    },
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
  return {
    client: fake as never as ConvexClient,
    pendingPersists,
    pendingLoadoutPersists,
    mutationCalls: () => mutationCount,
  };
}

type FakeAuth = AuthClient & { fire(): void; setSignedIn(v: boolean): void; setCompleting(v: boolean): void; signInWithGoogle: () => Promise<void> };

function fakeAuth(isSignedIn: boolean, isCompletingSignIn = false): FakeAuth {
  const listeners = new Set<() => void>();
  const state = { isSignedIn, isCompletingSignIn };
  const auth = {
    get isSignedIn() { return state.isSignedIn; },
    get isCompletingSignIn() { return state.isCompletingSignIn; },
    signInWithGoogle: (() => Promise.resolve()) as () => Promise<void>,
    signOut: () => Promise.resolve(),
    onChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    fire: () => { for (const cb of listeners) cb(); },
    setSignedIn: (v: boolean) => { state.isSignedIn = v; },
    setCompleting: (v: boolean) => { state.isCompletingSignIn = v; },
  };
  return auth as unknown as FakeAuth;
}

interface LaunchRecord { code: string; isPartyStart: boolean }

function makeMenu(opts: FakeOpts & { auth?: AuthClient | null } = {}): {
  menu: Menu;
  overlay: ShimNode;
  launches: LaunchRecord[];
  soloLaunches: RunLoadout[];
  session: Session;
  pendingPersists: PendingPersist[];
  pendingLoadoutPersists: PendingLoadoutPersist[];
  mutationCalls: () => number;
  calls: string[];
} {
  // Section isolation: the shim shares ONE localStorage; stale appearance picks from a
  // previous section must never leak into a fresh session.
  localStorage.removeItem("blobrogue.cosmetics");
  localStorage.removeItem("blobrogue.color");
  if (!opts.isLoadoutPreserved) localStorage.removeItem("blobrogue.lastPetId");
  localStorage.removeItem("blobrogue.closet.seenUnlocks");
  // Sections run as an already-confirmed guest so online flows land on the surfaces under
  // test; the one-time name gate has its own sections (which clear this latch explicitly).
  localStorage.setItem("blobrogue.nameConfirmed", "1");
  const overlay = document.createElement("div") as unknown as ShimNode;
  const calls: string[] = [];
  const convex = fakeConvex(opts, calls);
  const session = new Session(convex.client);
  const launches: LaunchRecord[] = [];
  const soloLaunches: RunLoadout[] = [];
  const host: MenuHost = {
    startSolo(_profile, loadout) { soloLaunches.push(loadout); },
    startOnline(lobby, _profile, isPartyStart) {
      launches.push({ code: lobby.code, isPartyStart });
    },
  };
  const menu = new Menu(overlay as unknown as HTMLElement, session, convex.client, opts.auth ?? null, host);
  return {
    menu, overlay, launches, soloLaunches, session,
    pendingPersists: convex.pendingPersists,
    pendingLoadoutPersists: convex.pendingLoadoutPersists,
    mutationCalls: convex.mutationCalls,
    calls,
  };
}

// A lobby double exposing exactly the surface showOnlineLobby reads. Kept as a plain object
// (cast) so the test controls roster/status without Convex.
function fakeLobby(code: string, selfId = "player-1", isQuickPlay = false): {
  lobby: OnlineLobby;
  setStatus: (s: "lobby" | "playing" | "ended") => void;
  setPlayers: (p: LobbyPlayer[]) => void;
  fireChange: () => void;
  readyCalls: boolean[];
  startCalls: () => number;
} {
  let onChange: (() => void) | null = null;
  const readyCalls: boolean[] = [];
  let startCallCount = 0;
  const state = {
    code,
    status: "lobby" as "lobby" | "playing" | "ended",
    hostPlayerId: "player-1",
    isQuickPlay,
    rows: [] as LobbyPlayer[],
  };
  const lobby = {
    get code() { return state.code; },
    get status() { return state.status; },
    get hostPlayerId() { return state.hostPlayerId; },
    get isQuickPlay() { return state.isQuickPlay; },
    get loadoutGeneration() { return 1; },
    get selfId() { return selfId; },
    get isHost() { return selfId === state.hostPlayerId; },
    get isActive() { return state.status !== "ended"; },
    get isSelfReady() { return state.rows.find((r) => r.playerId === selfId)?.isReady ?? false; },
    get isSelfLoadoutConfirmed() { return state.rows.find((r) => r.playerId === selfId)?.isLoadoutConfirmed ?? false; },
    get selfLoadout() {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      return row?.kitId ? { kitId: row.kitId, petId: row.petId } : null;
    },
    get selfPreselection() {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      return row?.kitId ? { kitId: row.kitId, petId: row.petId } : null;
    },
    get isPartyReady() { return state.rows.every((p) => p.isLoadoutConfirmed && p.isReady); },
    players: () => state.rows,
    expectedWorldId: () => worldIdForRoomCode(state.code),
    onChange: (cb: () => void) => { onChange = cb; return () => { onChange = null; }; },
    setReady: (isReady: boolean) => {
      readyCalls.push(isReady);
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      if (row) row.isReady = isReady;
      return Promise.resolve(null);
    },
    start: () => { startCallCount++; return Promise.resolve(null); },
    beginLoadoutEdit: () => {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      if (row) {
        readyCalls.push(false);
        row.isKitChoiceMade = false;
        row.isPetChoiceMade = false;
        row.isLoadoutConfirmed = false;
        row.isReady = false;
      }
      return Promise.resolve(null);
    },
    chooseDraftKit: (kitId: string) => {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      if (row) {
        row.kitId = kitId;
        row.isKitChoiceMade = true;
        row.isLoadoutConfirmed = false;
        row.isReady = false;
      }
    },
    chooseDraftPet: (petId: string | null) => {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      if (row) {
        row.petId = petId;
        row.isPetChoiceMade = true;
        row.isLoadoutConfirmed = false;
        row.isReady = false;
      }
    },
    confirmLoadout: (loadout: RunLoadout) => {
      const row = state.rows.find((candidate) => candidate.playerId === selfId);
      if (row) {
        row.kitId = loadout.kitId;
        row.petId = loadout.petId;
        row.isKitChoiceMade = true;
        row.isPetChoiceMade = true;
        row.isLoadoutConfirmed = true;
        row.isReady = false;
      }
      return Promise.resolve(null);
    },
    reopen: () => Promise.resolve(true),
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
    startCalls: () => startCallCount,
  };
}

function member(playerId: string, name: string, opts: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    playerId, name, colorIndex: 2, isHost: playerId === "player-1",
    gsWorldId: null, isReady: false, pingMs: null,
    kitId: "gunner", petId: null,
    isKitChoiceMade: true, isPetChoiceMade: true, isLoadoutConfirmed: true,
    ...opts,
  };
}

const RUN = { floor: 3, kills: 12, coins: 7, amber: 0, durationMs: 61_000 };

function reachLoadoutReview(
  overlay: ShimNode,
  kitId = "gunner",
  petId = "none",
): void {
  const kit = byClass(overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === kitId);
  kit?.onclick?.();
  collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
  const pet = byClass(overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === petId);
  pet?.onclick?.();
  byClass(overlay, "loadout-review-next")[0]?.onclick?.();
}

async function passLoadoutGate(
  overlay: ShimNode,
  kitId = "gunner",
  petId = "none",
): Promise<void> {
  reachLoadoutReview(overlay, kitId, petId);
  byClass(overlay, "loadout-confirm")[0]?.onclick?.();
  await settle();
  await settle();
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

  section("title hierarchy: launchpad, not control panel — explicit destinations, settings off-surface");
  {
    const { menu, overlay } = makeMenu();
    await menu.showTitle();
    const buttons = buttonsOf(overlay);
    check("PROFILE destination", buttons.some((b) => b.includes("PROFILE")));
    check("SETTINGS destination", buttons.some((b) => b.includes("SETTINGS")));
    // The right side is a UNIFORM .dest nav: PROFILE, LEADERBOARD, SETTINGS, WHAT'S NEW —
    // every one the same component (kills the "scattered" read).
    const navs = byClass(overlay, "nav-btn");
    check("the right nav is four uniform .dest destinations in order",
      navs.length === 4 && navs.every((n) => (n.className ?? "").includes("dest"))
      && textOf(navs[0]).includes("PROFILE") && textOf(navs[1]).includes("LEADERBOARD")
      && textOf(navs[2]).includes("SETTINGS") && textOf(navs[3]).includes("WHAT'S NEW"),
      navs.map(textOf).join("|"));
    check("the leaderboard's explicit door is the LEADERBOARD nav destination", buttons.some((b) => b.includes("LEADERBOARD")));
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

  section("solo kit discoverability: a glanceable + changeable kit chip on the title");
  {
    localStorage.removeItem("blobrogue.selectedKit"); // a brand-new player who never opened the picker
    const { menu, overlay } = makeMenu();
    await menu.showTitle();
    const chip = () => byClass(overlay, "kit-chip")[0];
    check("the title carries a kit chip next to PLAY SOLO", chip() !== undefined);
    check("the chip names the DEFAULTED kit (Gunner) so solo isn't silently kitless", textOf(chip()).includes("GUNNER"));
    check("the chip carries the kit accent for glanceability", chip()?.getAttribute?.("data-kit") === "gunner");
    check("the chip is a real button (keyboard + click reachable)", chip()?.tagName === "BUTTON");
    // Changing the pick (what the chip's picker does) persists via localStorage — GUESTS included,
    // no auth gate — and the title re-reads it into the chip on the next render.
    setSelectedKit("mender"); // Mender unlocks at account LV1, so a fresh guest can actually pick it
    check("the pick persists for guests (plain localStorage, no account)", getSelectedKit() === "mender");
    await menu.showTitle();
    check("the chip reflects the changed kit on re-render", textOf(chip()).includes("MENDER") && chip()?.getAttribute?.("data-kit") === "mender");
    // The chip opens the same mandatory two-step chooser, but saving this convenience does
    // not authorize a run.
    await menu.showKitPicker();
    const cards = byClass(overlay, "kit-option");
    check("the kit picker screen renders all four kit cards", cards.length === 4, `cards=${cards.length}`);
    check("the remembered kit is visibly LAST USED, not silently confirmed",
      cards.some((card) => (card.className ?? "").includes("last-used") && textOf(card).includes("MENDER")));
    check("NEXT stays disabled until the player explicitly selects a card",
      collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT"))[0]?.disabled === true);
    check("the picker offers a back door to the title", buttonsOf(overlay).some((b) => /back/i.test(b)));
    await passLoadoutGate(overlay, "mender");
    localStorage.removeItem("blobrogue.selectedKit"); // restore the fresh-player default for later sections
  }

  section("solo requires explicit KIT, explicit PET, then one final combined confirmation");
  {
    localStorage.removeItem("blobrogue.selectedKit");
    localStorage.removeItem("blobrogue.lastPetId");
    const { menu, overlay, soloLaunches, calls } = makeMenu();
    await menu.showTitle();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    check("PLAY SOLO opens KIT instead of starting", textOf(overlay).includes("CHOOSE YOUR KIT") && soloLaunches.length === 0);
    check("new run starts with loadoutConfirmed=false",
      byClass(overlay, "loadout-gate")[0]?.getAttribute?.("data-loadout-confirmed") === "false");
    check("a defaulted Gunner is not called LAST USED",
      !byClass(overlay, "kit-option").some((card) => textOf(card).includes("GUNNER") && textOf(card).includes("LAST USED")));
    const next = collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0];
    check("KIT preselection is not consent", next?.disabled === true);
    check("kit cards use the canonical role, weapon, and ultimate metadata",
      byClass(overlay, "kit-option").some((card) => textOf(card).includes("MENDER")
        && textOf(card).includes("HEALER · SUNLANCE · ULT SANCTUARY"))
      && byClass(overlay, "kit-option").some((card) => textOf(card).includes("BULWARK")
        && textOf(card).includes("TANK · BOOMSTICK · ULT AEGIS")));
    check("locked kit shows exact account requirement and progress",
      byClass(overlay, "kit-option").some((card) => textOf(card).includes("BULWARK")
        && textOf(card).includes("REACH ACCOUNT LV 3 · LV 1/3")));
    const lockedBulwark = byClass(overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === "bulwark");
    check("locked kit remains native-enabled, focusable, and aria-disabled",
      lockedBulwark?.disabled !== true
      && lockedBulwark?.getAttribute?.("aria-disabled") === "true"
      && typeof lockedBulwark?.focus === "function");
    lockedBulwark?.onclick?.();
    check("activating a locked kit announces its exact requirement without selecting",
      textOf(byClass(overlay, "loadout-live")[0] ?? {}) === "REACH ACCOUNT LV 3 · LV 1/3"
      && next?.disabled === true);
    fireWindowEvent("keydown", { key: "2" });
    check("number-key selection drafts Mender but does not advance", textOf(overlay).includes("MENDER")
      && byClass(overlay, "kit-option").some((card) => card.getAttribute?.("data-kit") === "mender"
        && (card.className ?? "").includes("selected")));
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    check("PET renders second with no final confirmation control",
      textOf(overlay).includes("CHOOSE YOUR PET")
      && byClass(overlay, "loadout-confirm").length === 0
      && byClass(overlay, "loadout-review-next")[0]?.disabled === true);
    check("PET options are registry-derived: No Pet plus four companions and one hidden reserve",
      byClass(overlay, "pet-option").filter((card) => card.tagName === "BUTTON").length === 5
      && byClass(overlay, "pet-option").some((card) => (card.className ?? "").includes("reserved")));
    check("locked rescue copy uses the CAMP_NODES floor and progress",
      byClass(overlay, "pet-option").some((card) => textOf(card).includes("DOGGIE")
        && textOf(card).includes("REACH FLOOR 3 TO RESCUE · 0/3")));
    const lockedDoggie = byClass(overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === "doggie");
    check("locked pet remains native-enabled, focusable, and aria-disabled",
      lockedDoggie?.disabled !== true
      && lockedDoggie?.getAttribute?.("aria-disabled") === "true"
      && typeof lockedDoggie?.focus === "function");
    lockedDoggie?.onclick?.();
    check("activating a locked pet announces its exact rescue progress",
      textOf(byClass(overlay, "loadout-live")[0] ?? {}) === "REACH FLOOR 3 TO RESCUE · 0/3"
      && byClass(overlay, "loadout-review-next")[0]?.disabled === true);
    check("pet copy stays honest about cosmetic-only behavior",
      textOf(overlay).includes("COSMETIC COMPANION · FOLLOWS YOU · NO COMBAT EFFECT")
      && textOf(overlay).includes("PLAYER BLOB")
      && textOf(overlay).includes("Travel alone · no gameplay change."));
    const petThumbs = byClass(overlay, "pet-card-thumb");
    check("every registry pet card has a fixed 56px shared-render thumbnail",
      petThumbs.filter((thumb) => thumb.tagName === "CANVAS").length === 4
      && petThumbs.filter((thumb) => thumb.tagName === "CANVAS")
        .every((thumb) => thumb.width === 56 && thumb.height === 56));
    const loadoutPreview = byClass(overlay, "loadout-preview-canvas")[0];
    check("preview canvas reserves explicit dimensions before sprite hydration",
      loadoutPreview?.width === 220 && loadoutPreview?.height === 244);
    check("fresh No Pet is available but not mislabeled LAST USED",
      !byClass(overlay, "pet-option").some((card) => card.getAttribute?.("data-pet") === "none" && textOf(card).includes("LAST USED")));
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("BACK · KIT"))[0]?.onclick?.();
    check("Pet → Kit keeps the Mender draft", byClass(overlay, "kit-option").some(
      (card) => card.getAttribute?.("data-kit") === "mender" && (card.className ?? "").includes("selected"),
    ));
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    fireWindowEvent("keydown", { key: "1" });
    check("explicit No Pet activation only enables NEXT REVIEW",
      byClass(overlay, "loadout-review-next")[0]?.disabled === false
      && byClass(overlay, "loadout-confirm").length === 0);
    check("KIT and PET activation persist nothing and launch nothing",
      localStorage.getItem("blobrogue.selectedKit") === null
      && calls.every((name) => name !== "players:confirmRunLoadout")
      && soloLaunches.length === 0);
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    check("REVIEW is a distinct fourth screen with both summaries",
      textOf(overlay).includes("REVIEW LOADOUT")
      && textOf(overlay).includes("HEALER · SUNLANCE")
      && textOf(overlay).includes("PASSIVE · LIFEBLOOM")
      && textOf(overlay).includes("ULT · SANCTUARY")
      && textOf(overlay).includes("NO COMPANION"));
    check("only REVIEW owns the combined destination CTA",
      textOf(byClass(overlay, "loadout-confirm")[0]).includes("CONFIRM & START SOLO")
      && byClass(overlay, "loadout-gate")[0]?.getAttribute?.("data-loadout-confirmed") === "false");
    const finalCta = byClass(overlay, "loadout-confirm")[0];
    check("final CTA has separate action and loadout spans",
      textOf(byClass(finalCta ?? {}, "loadout-confirm-action")[0] ?? {}) === "CONFIRM & START SOLO"
      && textOf(byClass(finalCta ?? {}, "loadout-confirm-loadout")[0] ?? {}) === "MENDER + NO PET");
    check("final CTA aria-label includes destination, kit, and pet",
      finalCta?.getAttribute?.("aria-label") === "CONFIRM & START SOLO · MENDER + NO PET");
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "BACK · PET")[0]?.onclick?.();
    check("Back Review → Pet preserves the deliberate No Pet draft",
      textOf(overlay).includes("CHOOSE YOUR PET")
      && byClass(overlay, "pet-option").some((card) => card.getAttribute?.("data-pet") === "none"
        && (card.className ?? "").includes("selected")));
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    byClass(overlay, "review-edit-kit")[0]?.onclick?.();
    check("EDIT KIT preserves the valid pet draft",
      byClass(overlay, "kit-option").some((card) => card.getAttribute?.("data-kit") === "mender"
        && (card.className ?? "").includes("selected")));
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    check("the preserved pet choice can continue directly back to Review",
      byClass(overlay, "loadout-review-next")[0]?.disabled === false);
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    byClass(overlay, "review-edit-pet")[0]?.onclick?.();
    check("EDIT PET preserves the valid Mender draft",
      textOf(overlay).includes("KIT MENDER")
      && byClass(overlay, "pet-option").some((card) => card.getAttribute?.("data-pet") === "none"
        && (card.className ?? "").includes("selected")));
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    check("Review navigation still persisted and launched nothing",
      calls.every((name) => name !== "players:confirmRunLoadout") && soloLaunches.length === 0);
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    check("one final CTA persists and launches the exact explicit-null pair",
      calls.filter((name) => name === "players:confirmRunLoadout").length === 1
      && soloLaunches.length === 1
      && soloLaunches[0]?.kitId === "mender"
      && soloLaunches[0]?.petId === null);
    await menu.showTitle();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    const sameSessionMender = byClass(overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === "mender");
    check("same Menu reopens with Mender LAST USED but unselected",
      textOf(sameSessionMender ?? {}).includes("LAST USED")
      && sameSessionMender?.getAttribute?.("aria-checked") === "false"
      && collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT"))[0]?.disabled === true);
    sameSessionMender?.onclick?.();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    const sameSessionNoPet = byClass(overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === "none");
    check("same Menu reopens with No Pet LAST USED but unselected",
      textOf(sameSessionNoPet ?? {}).includes("LAST USED")
      && sameSessionNoPet?.getAttribute?.("aria-checked") === "false"
      && byClass(overlay, "loadout-review-next")[0]?.disabled === true);
    await menu.showTitle();
    const reload = makeMenu({ isLoadoutPreserved: true });
    await reload.menu.showTitle();
    collect(reload.overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    check("guest reload preselects Mender but the new run gates again",
      byClass(reload.overlay, "kit-option").some((card) => textOf(card).includes("MENDER")
        && textOf(card).includes("LAST USED"))
      && collect(reload.overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT"))[0]?.disabled === true
      && reload.soloLaunches.length === 0);
    await reload.menu.showTitle();
    localStorage.removeItem("blobrogue.selectedKit");
    localStorage.removeItem("blobrogue.lastPetId");
  }

  section("long pet names provide a responsive shortName without dropping the action");
  {
    const profile = makeProfile({
      unlocks: ["pet_dragon"],
      equippedPet: "dragon",
      lastKitId: "mender",
      masteryLevel: 1,
    });
    const made = makeMenu({ profile });
    await made.session.login();
    await made.menu.showTitle();
    collect(made.overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    reachLoadoutReview(made.overlay, "mender", "dragon");
    const loadout = byClass(made.overlay, "loadout-confirm-loadout")[0];
    check("full label keeps BABY DRAGON", textOf(loadout ?? {}) === "MENDER + BABY DRAGON");
    check("responsive data uses MENDER + DRAGON", loadout?.getAttribute?.("data-short-name") === "MENDER + DRAGON");
    check("action span remains complete", textOf(byClass(made.overlay, "loadout-confirm-action")[0] ?? {}) === "CONFIRM & START SOLO");
    await made.menu.showTitle();
  }

  section("pet persistence failure stays on Review and Use No Pet still requires confirmation");
  {
    localStorage.removeItem("blobrogue.selectedKit");
    localStorage.removeItem("blobrogue.lastPetId");
    const profile = makeProfile({
      unlocks: ["pet_doggie"],
      equippedPet: "doggie",
      lastKitId: "gunner",
      masteryLevel: 1,
    });
    const fakeOpts: FakeOpts = { profile, persist: "echo", loadoutPersist: "ok" };
    const { menu, overlay, soloLaunches, session } = makeMenu(fakeOpts);
    await session.login();
    fakeOpts.loadoutPersist = "pet_rejected";
    await menu.showTitle();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    byClass(overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === "gunner")?.onclick?.();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    byClass(overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === "doggie")?.onclick?.();
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    check("failed pet save remains on REVIEW and launches nothing",
      textOf(overlay).includes("REVIEW LOADOUT") && textOf(overlay).includes("Rescue that pet")
      && soloLaunches.length === 0);
    const noPet = byClass(overlay, "loadout-no-pet")[0];
    check("failure offers an explicit Use No Pet edit", noPet !== undefined && noPet.hidden !== true);
    noPet.onclick?.();
    await settle();
    check("Use No Pet updates Review but still requires the one final CTA",
      textOf(overlay).includes("NO COMPANION") && soloLaunches.length === 0);
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    check("the retried Review CTA launches only the explicit null pair",
      soloLaunches.length === 1 && soloLaunches[0]?.petId === null);
  }

  section("offline solo permits a known unlocked kit only with explicit No Pet");
  {
    localStorage.removeItem("blobrogue.selectedKit");
    localStorage.removeItem("blobrogue.lastPetId");
    const overlay = document.createElement("div") as never as ShimNode;
    const session = new Session(null);
    const soloLaunches: RunLoadout[] = [];
    const menu = new Menu(overlay as never as HTMLElement, session, null, null, {
      startSolo(_profile, loadout) { soloLaunches.push(loadout); },
      startOnline() {},
    });
    await menu.showTitle();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("PLAY"))[0]?.onclick?.();
    await passLoadoutGate(overlay, "mender", "none");
    check("offline final CTA launches explicit Mender + No Pet",
      soloLaunches.length === 1
      && soloLaunches[0]?.kitId === "mender"
      && soloLaunches[0]?.petId === null);
  }

  section("a delayed final confirmation cannot launch after the player cancels");
  {
    const fakeOpts: FakeOpts = { loadoutPersist: "ok" };
    const made = makeMenu(fakeOpts);
    await made.session.login();
    fakeOpts.loadoutPersist = "manual";
    await made.menu.showTitle();
    collect(made.overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "PLAY SOLO")[0]?.onclick?.();
    byClass(made.overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === "gunner")?.onclick?.();
    collect(made.overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    byClass(made.overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === "none")?.onclick?.();
    byClass(made.overlay, "loadout-review-next")[0]?.onclick?.();
    byClass(made.overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    check("the save is genuinely pending", made.pendingLoadoutPersists.length === 1);
    check("pending confirmation disables both Edit actions",
      byClass(made.overlay, "review-edit-kit")[0]?.disabled === true
      && byClass(made.overlay, "review-edit-pet")[0]?.disabled === true);
    collect(made.overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "CANCEL")[0]?.onclick?.();
    await settle();
    check("cancel returns to the origin without launching", buttonsOf(made.overlay).some((button) => button.includes("PLAY SOLO"))
      && made.soloLaunches.length === 0);
    made.pendingLoadoutPersists[0]?.resolveSuccess();
    await settle();
    await settle();
    check("late success neither resurrects the gate nor starts a run",
      buttonsOf(made.overlay).some((button) => button.includes("PLAY SOLO"))
      && made.soloLaunches.length === 0
      && !textOf(made.overlay).includes("CHOOSE YOUR PET"));
  }

  section("solo, quick-play, and private replay all gate again before a new generation");
  {
    const solo = makeMenu();
    solo.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null });
    fireWindowEvent("keydown", { key: "Enter" });
    check("solo Play Again returns to KIT before launch",
      textOf(solo.overlay).includes("CHOOSE YOUR KIT") && solo.soloLaunches.length === 0);
    await solo.menu.showTitle();

    const quick = makeMenu();
    const quickLobby = fakeLobby("FAST", "player-1", true);
    quick.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: quickLobby.lobby });
    fireWindowEvent("keydown", { key: "Enter" });
    check("quick-play Play Again opens the replay KIT gate before matchmaking",
      textOf(quick.overlay).includes("CHOOSE YOUR KIT")
      && quick.calls.every((name) => name !== "rooms:quickPlay"));
    await quick.menu.showTitle();

    const privateReplay = makeMenu();
    const privateLobby = fakeLobby("ABCD");
    privateReplay.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: privateLobby.lobby });
    fireWindowEvent("keydown", { key: "Enter" });
    await settle();
    await settle();
    check("private replay reopens into the generation-bound KIT gate",
      textOf(privateReplay.overlay).includes("CHOOSE YOUR KIT")
      && textOf(privateReplay.overlay).includes("ROOM ABCD"));
    await privateReplay.menu.showTitle();
  }

  section("the hero blob stage: identity showpiece in the raised hero band");
  {
    // A dressed profile: the stage must mirror the ACTUAL equipped loadout once hydrated.
    const dressed = makeProfile({ cosmetics: { hat: "hat_top", face: "face_shades", body: "body_cyan", title: null }, colorIndex: 1 });
    const { menu, overlay } = makeMenu({ profile: dressed, lb: LB_ENTRIES.slice(0, 2) });
    await menu.showTitle();
    const hero = () => byClass(overlay, "home-hero")[0];
    const stage = () => byClass(hero() ?? {}, "blob-stage")[0];
    check("the two-column hero band renders: wordmark | blob stage",
      byClass(hero() ?? {}, "hero-mark").length === 1 && stage() !== undefined);
    check("the body columns are untouched: glance under Play, identity/destinations right",
      byClass(byClass(overlay, "home-left")[0] ?? {}, "lb-preview").length === 1
      && byClass(byClass(overlay, "home-right")[0] ?? {}, "identity-card").length === 1
      && byClass(overlay, "lb-row").length === 3);
    check("it draws through the shared preview renderer (the world/closet code path)",
      byClass(stage() ?? {}, "blob-preview").length === 1);
    const canvasBefore = collect(stage() ?? {}, (n) => n.tagName === "CANVAS")[0];
    check("the canvas reserves its fixed 160px centerpiece box from creation", canvasBefore?.width === 160 && canvasBefore?.height === 160);
    check("the stage is a SHOWPIECE, not a control (no button inside it)",
      collect(stage() ?? {}, (n) => n.tagName === "BUTTON").length === 0);
    check("before hydration a fresh guest shows the DEFAULT blob (accepted copy)",
      stage()?.getAttribute?.("aria-label") === "Your blob", stage()?.getAttribute?.("aria-label") ?? "");
    const buttonsBefore = buttonsOf(overlay).length;
    await settle();
    check("hydration repaints CONTENT only (same canvas node, zero layout shift)",
      collect(stage() ?? {}, (n) => n.tagName === "CANVAS")[0] === canvasBefore && buttonsOf(overlay).length === buttonsBefore);
    check("the hydrated stage mirrors the EQUIPPED loadout (accepted aria copy: hat, glasses)",
      stage()?.getAttribute?.("aria-label") === "Your blob wearing Top Hat, Shades", stage()?.getAttribute?.("aria-label") ?? "");
    const buttons = buttonsOf(overlay);
    check("PLAY stays the FIRST action; CUSTOMIZE rides DOM-LAST (anchored beside the blob via CSS)",
      (buttons[0] ?? "").includes("PLAY ONLINE") && (buttons[buttons.length - 1] ?? "") === "CUSTOMIZE", buttons.join("|").slice(0, 80));
    // The accepted shell + stage geometry, verbatim from the placement decision.
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    check("shell: 300px hero row over minmax(0,1fr), height min(700px,100vh-40px), min 620px",
      /\.menu-home\{ display:grid; grid-template-rows:300px minmax\(0,1fr\); gap:14px;\s*\n\s*height:min\(732px,calc\(100vh - 20px\)\); min-height:560px; position:relative; \}/.test(html));
    check("hero band: a CENTERED column with a big 200px stage; stage canvas is 160px",
      /\.home-hero\{ grid-row:1; grid-column:1; display:flex; flex-direction:column; align-items:center; justify-content:center;/.test(html)
      && /\.home-hero \.blob-stage\{[^}]*width:200px; height:200px;/.test(html)
      && /\.home-hero \.blob-stage \.blob-preview\{[^}]*width:160px; height:160px;/.test(html));
    check("the blob STANDS: radial plinth glow behind + soft ground-shadow ellipse",
      /\.home-hero \.blob-stage::before\{[^}]*radial-gradient/.test(html)
      && /\.home-hero \.blob-stage::after\{[^}]*border-radius:50%; background:rgba\(5,3,11/.test(html));
    // The accepted responsive rules: narrow shrinks the centerpiece (240px row, 150/128),
    // short viewports compact it (180px row, 120/96) so Play + the glance stay on screen.
    const narrowCss = html.slice(html.indexOf("@media (max-width:680px)"), html.indexOf("@media (max-height:679px)"));
    check("narrow: 240px hero row with a 150px stage (128px blob)",
      /grid-template-rows:240px minmax\(0,1fr\)/.test(narrowCss)
      && /width:150px; height:150px/.test(narrowCss) && /width:128px; height:128px/.test(narrowCss));
    const shortCss = html.slice(html.indexOf("@media (max-height:619px)"));
    check("short: 180px hero row with a 120px stage (96px blob)",
      /grid-template-rows:180px minmax\(0,1fr\)/.test(shortCss)
      && /width:120px; height:120px/.test(shortCss) && /width:96px; height:96px/.test(shortCss));
    // The accepted rendering-loop rules live in the shared preview: rAF only while
    // visible, pause on hide/overlay/tab-hide, static idle frame under reduced motion.
    const previewSrc = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
    check("the idle loop pauses on tab hide and honors prefers-reduced-motion",
      previewSrc.includes("visibilitychange") && previewSrc.includes("prefers-reduced-motion") && previewSrc.includes("setPaused"));
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    check("the menu parks the title loop while hidden (in-run) and while the overlay covers it",
      /hide\(\) \{[\s\S]{0,400}setPaused\(true\)/.test(menuSrc) && menuSrc.includes("this.titleStage?.setPaused(true);") && menuSrc.includes("this.titleStage?.setPaused(false);"));

    // Signed-out/guest: the default blob (amber, no hat/glasses) — never blank; a saved
    // guest body-color pick still renders through the same shared look resolution.
    const guest = makeMenu({ lb: [] });
    await guest.menu.showTitle();
    await settle();
    check("a guest with no picks keeps the DEFAULT label after hydration",
      byClass(guest.overlay, "blob-stage")[0]?.getAttribute?.("aria-label") === "Your blob");
    const picked = makeMenu({ lb: [] });
    void picked.session.setColorIndex(2); // the guest's swatch pick, applied locally at once
    await picked.menu.showTitle();
    check("a guest body-color pick renders the stage without overlay copy (color is paint, not aria)",
      byClass(picked.overlay, "blob-stage").length === 1
      && byClass(picked.overlay, "blob-stage")[0]?.getAttribute?.("aria-label") === "Your blob"
      && picked.session.cosmetics.body === "body_green");
  }

  section("attention hierarchy gate: calm identity, brightest PLAY, no reflow under worst case");
  {
    // Worst case: the flashiest equippable set, a signed-in identity still resolving its
    // name/avatar, and a profile carrying fresh unlock badges — nothing may reflow, and
    // Play must stay the same dominant node.
    const flashy = makeProfile({
      cosmetics: { hat: "hat_halo", face: "face_monocle", body: "body_pink", title: "title_depth_diver" },
      colorIndex: 3,
      unlocks: ["hat_halo", "face_monocle", "hat_crown", "title_depth_diver"],
      deepestFloor: 22, totalKills: 900,
    });
    const auth = fakeAuth(true);
    const { menu, overlay } = makeMenu({ profile: flashy, lb: LB_ENTRIES, standing: { floor: 22, kills: 900, rank: 7 }, auth });
    await menu.showTitle();
    const playNode = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    const stageCanvas = collect(byClass(overlay, "blob-stage")[0] ?? {}, (n) => n.tagName === "CANVAS")[0];
    const nodesBefore = collect(overlay, () => true).length;
    const buttonsBefore = buttonsOf(overlay).length;
    await settle();
    check("worst-case hydration adds/removes NO nodes anywhere on the home",
      collect(overlay, () => true).length === nodesBefore, `${nodesBefore} -> ${collect(overlay, () => true).length}`);
    check("...and no buttons", buttonsOf(overlay).length === buttonsBefore);
    check("the Play node is the SAME node after the flashy loadout landed",
      collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0] === playNode);
    check("the stage canvas never resizes (fixed reserved bounds)",
      collect(byClass(overlay, "blob-stage")[0] ?? {}, (n) => n.tagName === "CANVAS")[0] === stageCanvas && stageCanvas?.width === 160);
    check("PLAY is still the first action in order", (buttonsOf(overlay)[0] ?? "").includes("PLAY ONLINE"));
    // The stage chrome stays quiet by construction: no CSS animation and no amber FILL
    // anywhere on it (the plinth glow is a low-alpha wash, never a competing highlight);
    // the calm idle lives canvas-side (blink/wave under the cosmetic transform caps), so
    // an equipped set can never emit motion or glow that outranks Play.
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    const stageCss = html.slice(html.indexOf("THE HERO BLOB STAGE"), html.indexOf(".body{"));
    check("stage CSS carries no animation and no amber fill (Play stays the only amber mass)",
      !/animation:/.test(stageCss) && !/background:var\(--amber\)/.test(stageCss), "");
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    check("the title stage opts into the CALM idle (blink/wave, capped)", menuSrc.includes("isCalmIdle: true"));
    const previewSrc = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
    check("the wave tilt stays under the cosmetic rot cap (hats follow, quietly)",
      previewSrc.includes("const WAVE_ROT = 0.05"));
  }

  section("CUSTOMIZE opens the closet as an OVERLAY — Play never leaves the screen");
  {
    const { menu, overlay, session } = makeMenu();
    await menu.showTitle();
    await settle();
    const playNode = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    collect(overlay, (n) => n.tagName === "BUTTON" && typeof n.className === "string" && n.className.includes("stage-customize"))[0]?.onclick?.();
    check("the closet panel overlays the title", byClass(overlay, "closet-pop").length === 1 && byClass(overlay, "closet-scrim").length === 1);
    check("the title (and Play) is STILL in the tree behind it — no mode swap",
      collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0] === playNode);
    check("the overlay carries the autosave promise in copy", textOf(byClass(overlay, "closet-pop")[0] ?? {}).includes("changes save instantly"));
    // Equip from the overlay: the SHARED loadout state updates the title stage LIVE —
    // the blob behind the scrim visibly changes before the overlay ever closes.
    byClass(overlay, "cos-card").find((c) => textOf(c).includes("Top Hat"))?.onclick?.();
    check("instant equip works inside the overlay", session.cosmetics.hat === "hat_top");
    check("...and updates the title stage LIVE (shared CosmeticLoadout state)",
      byClass(overlay, "blob-stage")[0]?.getAttribute?.("aria-label") === "Your blob wearing Top Hat",
      byClass(overlay, "blob-stage")[0]?.getAttribute?.("aria-label") ?? "");
    await settle();
    byClass(byClass(overlay, "closet-pop")[0] ?? {}, "panel-close")[0]?.onclick?.();
    check("closing removes the overlay", byClass(overlay, "closet-pop").length === 0 && byClass(overlay, "closet-scrim").length === 0);
    check("...returning to the UNCHANGED title (same Play node, never rebuilt)",
      collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0] === playNode);
    check("...still wearing the updated blob",
      byClass(overlay, "blob-stage")[0]?.getAttribute?.("aria-label")?.includes("Top Hat") === true);
    // Escape drives the same overlay close (B on a pad dispatches this exact event).
    collect(overlay, (n) => n.tagName === "BUTTON" && typeof n.className === "string" && n.className.includes("stage-customize"))[0]?.onclick?.();
    check("re-opened for the Escape path", byClass(overlay, "closet-pop").length === 1);
    fireWindowEvent("keydown", { key: "Escape" });
    check("Escape/B closes the overlay and the title stands", byClass(overlay, "closet-pop").length === 0
      && collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0] === playNode);
  }

  section("instant equip autosaves server-authoritative: the change survives a reload");
  {
    const first = makeMenu();
    await first.menu.showProfile("closet");
    await settle();
    byClass(first.overlay, "cos-card").find((c) => textOf(c).includes("Top Hat"))?.onclick?.();
    await settle();
    check("equip accepted and persisted", first.session.cosmetics.hat === "hat_top");
    // Simulate the reload: a brand-new Session over the SAME storage + backend.
    const reloaded = new Session(fakeConvex().client);
    check("the pick is already worn before any network (local persistence)", reloaded.cosmetics.hat === "hat_top");
    await reloaded.login("blob");
    check("...and the server-side loadout agrees after login (it stuck)", reloaded.cosmetics.hat === "hat_top");
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
    const { session } = makeMenu({ persist: "static" }); // backend answers with the EMPTY loadout
    void session.setCosmetic("hat", "hat_halo"); // locked pick, applied optimistically
    check("optimistic local apply", session.cosmetics.hat === "hat_halo");
    await session.login("blob");
    check("the server's answer reconciles the local pick away", session.cosmetics.hat === null, String(session.cosmetics.hat));
    // An ACCEPTED pick round-trips and stays.
    const accepted = makeMenu({ profile: makeProfile({ cosmetics: { hat: "hat_top", face: null, body: null, title: null } }) });
    void accepted.session.setCosmetic("hat", "hat_top");
    await accepted.session.login("blob");
    check("an accepted pick survives reconcile", accepted.session.cosmetics.hat === "hat_top");
  }

  section("destinations exist for BOTH auth states; Escape mirrors Back with named focus restore");
  {
    const signed = makeMenu({ auth: fakeAuth(true) });
    await signed.menu.showTitle();
    const navs = byClass(signed.overlay, "nav-btn").map(textOf);
    check("signed-in title keeps the four uniform destinations", navs.length === 4
      && navs[0].includes("PROFILE") && navs[1].includes("LEADERBOARD") && navs[2].includes("SETTINGS") && navs[3].includes("WHAT'S NEW"), navs.join("|"));
    check("...and the LEADERBOARD nav door", byClass(signed.overlay, "nav-leaderboard").length === 1);

    const { menu, overlay } = makeMenu({ lb: LB_ENTRIES });
    await menu.showSettings();
    check("settings screen is open", textOf(overlay).includes("SETTINGS") && textOf(overlay).includes("everything saves instantly"));
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape returns to the title", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
    const focusedAfterSettings = lastFocused();
    check("focus restored to the SETTINGS destination by name",
      focusedAfterSettings?.className?.includes("nav-settings") === true,
      `${focusedAfterSettings?.className}`);

    await menu.showProfile();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from profile restores the PROFILE destination", lastFocused()?.className?.includes("nav-profile") === true, lastFocused()?.className);

    await menu.showLeaderboard();
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape from leaderboard restores the LEADERBOARD nav destination", lastFocused()?.className?.includes("nav-leaderboard") === true, lastFocused()?.className);

    await menu.showOnlineHome();
    await passLoadoutGate(overlay);
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
    check("no guest CTA while the exchange is pending", !buttonsOf(overlay).some((b) => b.includes("SIGN IN WITH GOOGLE")));
    const playBefore = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    auth.setCompleting(false);
    auth.setSignedIn(true);
    auth.fire();
    const playAfter = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    check("the exchange settles into the account state in place", textOf(overlay).includes("Progress saved across devices"));
    check("the shell around the identity card is NOT rebuilt (same play node)", playBefore === playAfter);

    // The failure path settles into the guest CTA instead — same box.
    const failAuth = fakeAuth(false, true);
    const failed = makeMenu({ auth: failAuth, lb: [] });
    await failed.menu.showTitle();
    failAuth.setCompleting(false);
    failAuth.fire();
    check("a failed exchange settles into the guest CTA", buttonsOf(failed.overlay).some((b) => b.includes("SIGN IN WITH GOOGLE")));
  }

  section("failure/retry geometry: action-screen status lines are reserved boxes");
  {
    const { menu, overlay } = makeMenu();
    await menu.showOnlineHome("finding a room\u2026");
    await passLoadoutGate(overlay);
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
    check("guest card title is SAVE YOUR BLOB", guestText.includes("SAVE YOUR BLOB"));
    check("guest sees the Google CTA", buttonsOf(guest.overlay).some((b) => b.includes("SIGN IN WITH GOOGLE")));
    check("value copy is the accepted line", guestText.includes("Keep progress, cosmetics, and ranked runs across devices."));
    check("the optional note keeps guest play un-gated", guestText.includes("Optional \u00b7 Play anytime as guest."));
    check("the HOME carries no name input (identity edits live in Profile)", collect(guest.overlay, (n) => n.tagName === "INPUT").length === 0);
    // Busy: the CTA flips to OPENING GOOGLE… and Play stays enabled.
    const hangAuth = fakeAuth(false);
    hangAuth.signInWithGoogle = () => new Promise(() => {});
    const busy = makeMenu({ auth: hangAuth });
    await busy.menu.showTitle();
    const cta = collect(busy.overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("SIGN IN WITH GOOGLE"))[0];
    cta?.onclick?.();
    check("busy CTA reads OPENING GOOGLE\u2026", textOf(busy.overlay).includes("OPENING GOOGLE"));
    const playBtn = collect(busy.overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    check("Play stays enabled while the CTA is busy", playBtn?.disabled !== true);
    // Error: honest reassurance + TRY AGAIN, same boxes; guest state untouched.
    const failAuth2 = fakeAuth(false);
    failAuth2.signInWithGoogle = () => Promise.reject(new Error("popup closed"));
    const errored = makeMenu({ auth: failAuth2 });
    await errored.menu.showTitle();
    collect(errored.overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("SIGN IN WITH GOOGLE"))[0]?.onclick?.();
    await settle();
    const errText = textOf(errored.overlay);
    check("a failed sign-in reassures that guest progress is safe", errText.includes("guest progress is still safe"));
    check("...and offers TRY AGAIN in the same box", buttonsOf(errored.overlay).some((b) => b.includes("TRY AGAIN")));

    const signed = makeMenu({ auth: fakeAuth(true) });
    await signed.menu.showTitle();
    check("signed-in shows the avatar patch + account state (display only)", byClass(signed.overlay, "id-patch").length === 1 && textOf(signed.overlay).includes("Progress saved across devices"));
    check("sign-out does NOT live on the title (it belongs to the profile)", !buttonsOf(signed.overlay).some((b) => b === "sign out"));
    check("signed-in has NO sign-in CTA", !buttonsOf(signed.overlay).some((b) => b.includes("SIGN IN WITH GOOGLE")));
    check("signed-in value line", textOf(signed.overlay).includes("Progress saved across devices"));
    check("signed-in offers VIEW PROFILE", buttonsOf(signed.overlay).some((b) => b.includes("VIEW PROFILE")));
    check("signed-in note", textOf(signed.overlay).includes("Signed in with Google"));
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
    check("the guest NAME INPUT lives here (moved off the home card)", collect(fresh.overlay, (n) => n.tagName === "INPUT").length === 1);

    // Manual sign-in is ALWAYS available from the Profile, independent of nudge cooldowns.
    localStorage.setItem(NUDGE_DISMISSED_AT_KEY, String(Date.now()));
    const cooled = makeMenu({ auth: fakeAuth(false), mine: null });
    await cooled.menu.showProfile();
    await settle();
    check("Profile offers manual SIGN IN even under a nudge cooldown",
      buttonsOf(cooled.overlay).some((b) => b.includes("SIGN IN WITH GOOGLE")));
    localStorage.removeItem(NUDGE_DISMISSED_AT_KEY);

    // Failed own-run fetch: same geometry, honest note.
    const broken = makeMenu({ mine: "fail" });
    await broken.menu.showProfile();
    await settle();
    check("a failed top-run fetch stays honest in the same box", textOf(broken.overlay).includes("top run unavailable"));
  }

  section("editable username on the Overview card: guests rename anytime, accounts set a custom name");
  {
    const { menu, overlay, session, mutationCalls } = makeMenu();
    await menu.showProfile();
    await settle();
    const input = () => collect(overlay, (n) => n.tagName === "INPUT")[0];
    const saveBtn = () => collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n) === "SAVE")[0];
    check("the editor rides the profile card and shows the CURRENT name",
      byClass(overlay, "pc-nameedit").length === 1 && input()?.value === session.name, `${input()?.value ?? ""} vs ${session.name}`);
    check("guests get an explicit SAVE control", saveBtn() !== undefined);
    const callsBefore = mutationCalls();
    input()!.value = "  Sir\u200b   Blobby  ";
    saveBtn()?.onclick?.();
    await settle();
    check("the rename persists through the sanitized login path (trim/collapse/strip/cap)",
      session.name === "Sir Blobby", session.name);
    check("...with exactly one write", mutationCalls() === callsBefore + 1);
    check("the field shows the committed value", input()?.value === "Sir Blobby");
    check("the card headline updates in place", textOf(overlay).includes("SIR BLOBBY"));
    check("saved feedback is inline (nothing modal)", textOf(overlay).includes("saved \u2014 shows in lobbies"));
    input()!.value = "   ";
    saveBtn()?.onclick?.();
    await settle();
    check("an emptied input keeps the standing name (never blank)", session.name === "Sir Blobby" && input()?.value === "Sir Blobby");
    input()!.value = "blob";
    saveBtn()?.onclick?.();
    await settle();
    check("the literal 'blob' placeholder can never come back", session.name === "Sir Blobby");

    // Signed-in: accounts set a custom display-name OVERRIDE (server-authoritative), so the
    // field is EDITABLE with a SAVE control. The write lands on lobbies + the leaderboard,
    // and login/recordRun never revert it (the Google name is only the fallback).
    const signed = makeMenu({ auth: fakeAuth(true) });
    await signed.menu.showProfile();
    await settle();
    const sInput = () => collect(signed.overlay, (n) => n.tagName === "INPUT")[0];
    const sSave = () => collect(signed.overlay, (n) => n.tagName === "BUTTON" && textOf(n) === "SAVE")[0];
    check("signed-in name field is editable", sInput()?.disabled !== true);
    check("accounts get an explicit SAVE control", sSave() !== undefined);
    check("honest copy names the destination", textOf(signed.overlay).includes("shows in lobbies & on the leaderboard"));
    const setNameCalls = () => signed.calls.filter((c) => c === "players:setCustomName").length;
    const sCallsBefore = setNameCalls();
    sInput()!.value = "  Captain\u200b   Blob  ";
    sSave()?.onclick?.();
    await settle();
    check("saving an account name writes the custom-name override (one setCustomName call)",
      setNameCalls() === sCallsBefore + 1);
    check("the account's chosen name commits sanitized", signed.session.name === "Captain Blob", signed.session.name);
    check("the field shows the committed custom name", sInput()?.value === "Captain Blob");
  }

  section("global pixel scrollbar: token-styled, applied everywhere, stable gutters");
  {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    check("WebKit parts styled (bar/track/thumb/corner)",
      html.includes("::-webkit-scrollbar{") && html.includes("::-webkit-scrollbar-track{")
      && html.includes("::-webkit-scrollbar-thumb{") && html.includes("::-webkit-scrollbar-corner{"));
    check("Firefox fallback on every element", html.includes("*{ scrollbar-width:thin; scrollbar-color:var(--dun-4) var(--dun-0); }"));
    check("squared pixel feel: flat token thumb, radius 0, amber-lo hover",
      /::-webkit-scrollbar-thumb\{ background:var\(--dun-4\); border:2px solid var\(--dun-0\); border-radius:0; \}/.test(html)
      && html.includes("::-webkit-scrollbar-thumb:hover{ background:var(--amber-lo)"));
    check("fixed panels reserve a stable scrollbar gutter (zero-CLS)",
      html.includes(".menu, .closet-grid, .pc-build, .hb-drawer{ scrollbar-gutter:stable; }"));
  }

  section("closet instant equip: one click equips immediately — no save step, no staging model");
  {
    const { menu, overlay, session, mutationCalls } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const cats = () => byClass(overlay, "closet-cat");
    const cards = () => byClass(overlay, "cos-card");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const noteText = () => textOf(byClass(overlay, "closet-note")[0]);

    check("real categories only, in order", cats().map(textOf).join("|") === "Hats|Glasses|Blob Color|Titles", cats().map(textOf).join("|"));
    check("the always-owned DEFAULT card leads the grid and reads EQUIPPED",
      textOf(cards()[0] ?? {}).includes("No Hat") && textOf(cards()[0] ?? {}).includes("EQUIPPED"));
    check("the equipped card wears the persistent \u2713 badge", byClass(cardByName("No Hat") ?? {}, "cos-check").length === 1);

    const callsBefore = mutationCalls();
    cardByName("Top Hat")?.onclick?.();
    check("clicking an OWNED card equips IMMEDIATELY (no confirm, no save)", session.cosmetics.hat === "hat_top");
    check("the card reads EQUIPPED at once", textOf(cardByName("Top Hat") ?? {}).includes("EQUIPPED"));
    check("...with the equipped state class and \u2713 badge",
      cardByName("Top Hat")?.className?.includes("equipped") === true && byClass(cardByName("Top Hat") ?? {}, "cos-check").length === 1);
    check("the previous item in the category lost the equipped state",
      !textOf(cardByName("No Hat") ?? {}).includes("EQUIPPED") && byClass(cardByName("No Hat") ?? {}, "cos-check").length === 0);
    check("the in-flight write rides the tiny corner spinner (card already reads EQUIPPED)",
      byClass(cardByName("Top Hat") ?? {}, "cos-saving").length === 1);
    check("exactly one background persist fired", mutationCalls() === callsBefore + 1);
    await settle();
    check("success clears the spinner (no toast)", byClass(cardByName("Top Hat") ?? {}, "cos-saving").length === 0);
    check("...and the equip stands after the server round-trip", session.cosmetics.hat === "hat_top" && textOf(cardByName("Top Hat") ?? {}).includes("EQUIPPED"));
    check("no inline message on success", noteText() === "");

    // Selecting the already-equipped item is a no-op.
    const callsAfter = mutationCalls();
    cardByName("Top Hat")?.onclick?.();
    check("clicking the equipped card is a no-op (no write, state stands)",
      mutationCalls() === callsAfter && session.cosmetics.hat === "hat_top");

    // The staging chrome is GONE.
    const btns = buttonsOf(overlay);
    check("no EQUIP / RESET PREVIEW buttons exist", !btns.some((b) => b === "EQUIP" || /RESET/i.test(b)));
    check("no action strip / discard chrome in the DOM",
      byClass(overlay, "closet-actions").length === 0 && byClass(overlay, "closet-discard").length === 0 && byClass(overlay, "closet-keep").length === 0);
    check("no preview/unsaved copy anywhere on the surface",
      !/previewing|unsaved|discard/i.test(textOf(overlay)), textOf(overlay).slice(0, 120));

    // Closing just closes — there is nothing to discard and no confirmation.
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("Escape just closes (no discard dialog exists)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
    check("the equip survived the close", session.cosmetics.hat === "hat_top");
  }

  section("optimistic persistence: a failed write reverts stage + badge with ONE inline notice");
  {
    const { menu, overlay, session } = makeMenu({ persist: "fail" });
    await menu.showProfile("closet");
    await settle();
    const cards = () => byClass(overlay, "cos-card");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const noteText = () => textOf(byClass(overlay, "closet-note")[0]);

    cardByName("Top Hat")?.onclick?.();
    check("the optimistic apply is instant", session.cosmetics.hat === "hat_top" && textOf(cardByName("Top Hat") ?? {}).includes("EQUIPPED"));
    await settle();
    check("failure reverts to the previously-equipped item", session.cosmetics.hat === null);
    check("the default card wears EQUIPPED again (badge restored)",
      textOf(cardByName("No Hat") ?? {}).includes("EQUIPPED") && byClass(cardByName("No Hat") ?? {}, "cos-check").length === 1);
    check("the failed card lost the equipped state", !textOf(cardByName("Top Hat") ?? {}).includes("EQUIPPED"));
    check("ONE non-blocking inline message", noteText() === "COULDN'T SAVE \u2014 REVERTED", noteText());
    check("nothing modal appeared", !buttonsOf(overlay).some((b) => /DISCARD|KEEP|OK|RETRY/i.test(b)));

    // A failed body-color write reverts BOTH color layers (party color + body item).
    byClass(overlay, "closet-cat").find((c) => textOf(c) === "Blob Color")?.onclick?.();
    cardByName("Cyan")?.onclick?.();
    check("a body color equips both layers instantly", session.colorIndex === 1 && session.cosmetics.body === "body_cyan");
    await settle();
    check("failure reverts both color layers", session.colorIndex === null && session.cosmetics.body === null, `${String(session.colorIndex)}/${String(session.cosmetics.body)}`);
    check("...with the same inline notice", noteText() === "COULDN'T SAVE \u2014 REVERTED");
  }

  section("rapid switching is last-click-wins: a slow earlier response can never override");
  {
    const { menu, overlay, session, pendingPersists } = makeMenu({ persist: "manual" });
    await menu.showProfile("closet");
    await settle();
    pendingPersists.shift()?.resolveEcho(); // settle the closet-open identity hydrate
    await settle();
    const cards = () => byClass(overlay, "cos-card");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const noteText = () => textOf(byClass(overlay, "closet-note")[0]);

    cardByName("Top Hat")?.onclick?.();   // write #1 — will settle LAST (slow)
    cardByName("Party Cone")?.onclick?.(); // write #2 — the newest pick
    check("two writes are in flight", pendingPersists.length === 2, String(pendingPersists.length));
    check("the newest pick applied locally at once", session.cosmetics.hat === "hat_party");
    check("...and its card reads EQUIPPED", textOf(cardByName("Party Cone") ?? {}).includes("EQUIPPED"));

    pendingPersists[1]?.resolveEcho(); // the NEWER write lands first
    await settle();
    check("the newer response settles its own pick (spinner cleared)",
      session.cosmetics.hat === "hat_party" && byClass(cardByName("Party Cone") ?? {}, "cos-saving").length === 0);

    pendingPersists[0]?.fail(); // the slow EARLIER write dies late
    await settle();
    check("the stale failure cannot revert the newer pick", session.cosmetics.hat === "hat_party");
    check("no revert notice for a superseded write", noteText() === "", noteText());
    check("the newer card still reads EQUIPPED", textOf(cardByName("Party Cone") ?? {}).includes("EQUIPPED"));
  }

  section("locked items: never equippable, always readable — the condition IS the chip");
  {
    const { menu, overlay, session, mutationCalls } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const crown = () => byClass(overlay, "cos-card").find((c) => textOf(c).includes("Crown"));
    check("locked card stays FOCUSABLE (not disabled) so the condition is readable", crown()?.disabled !== true);
    check("locked state class + lock glyph", crown()?.className?.includes("locked") === true && byClass(crown() ?? {}, "cos-lock").length === 1);
    check("the chip IS the exact configured condition", textOf(crown() ?? {}).includes("REACH FLOOR 10"), textOf(crown() ?? {}));
    check("aria-label reads name, locked, condition", crown()?.getAttribute?.("aria-label") === "Crown, locked \u2014 reach floor 10", crown()?.getAttribute?.("aria-label") ?? "");
    const calls = mutationCalls();
    crown()?.onclick?.();
    check("activating a locked card equips NOTHING (no write)", session.cosmetics.hat === null && mutationCalls() === calls);
    check("...and reads the condition out inline", textOf(byClass(overlay, "closet-note")[0]) === "LOCKED \u2014 REACH FLOOR 10");
    check("the locked card never gains the equipped state", crown()?.className?.includes("equipped") !== true);
  }

  section("state language survives grayscale + color-vision deficiencies (geometry, glyph, text)");
  {
    const { menu, overlay } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const cards = () => byClass(overlay, "cos-card");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const equipped = cardByName("No Hat");
    const owned = cardByName("Top Hat");
    const locked = cardByName("Crown");
    check("three distinct state CLASSES (never hue alone)",
      equipped?.className?.includes("equipped") === true && owned?.className?.includes("owned") === true && locked?.className?.includes("locked") === true);
    check("equipped is marked by the \u2713 badge + EQUIPPED chip", byClass(equipped ?? {}, "cos-check").length === 1 && textOf(equipped ?? {}).includes("EQUIPPED"));
    check("owned carries neither badge nor chip copy", byClass(owned ?? {}, "cos-check").length === 0 && !textOf(owned ?? {}).includes("EQUIPPED"));
    check("locked is marked by the lock glyph + condition chip", byClass(locked ?? {}, "cos-lock").length === 1 && textOf(locked ?? {}).includes("REACH FLOOR 10"));
    // The CSS side: equipped = lift + double frame (geometry), locked = hatch overlay,
    // and the focus ring is EXTERNAL cream — distinct from the equipped amber frame.
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    check("equipped card geometry: 3px lift + double frame", /\.cos-card\.equipped[^}]*translateY\(-3px\)/.test(html) && /\.cos-card\.equipped[^}]*inset 0 0 0 4px/.test(html));
    check("locked card geometry: hatch overlay + desaturated thumb", /\.cos-card\.locked::after[^}]*repeating-linear-gradient/.test(html) && /\.cos-card\.locked \.cos-icon[^}]*grayscale/.test(html));
    check("focus ring is the ONE standard cream ring (--focus-ring = 3px solid var(--cream))",
      /\.cos-card:focus-visible\{ outline:var\(--focus-ring\); outline-offset:2px/.test(html)
      && /--focus-ring:\s*3px solid var\(--cream\)/.test(html));
    // Blob-color swatches carry a NAME label in addition to the color chip.
    byClass(overlay, "closet-cat").find((c) => textOf(c) === "Blob Color")?.onclick?.();
    const cyan = cardByName("Cyan");
    check("color swatches ride with a text label, never color alone",
      byClass(cyan ?? {}, "cos-swatch").length === 1 && byClass(cyan ?? {}, "cos-name").some((n) => textOf(n) === "Cyan"));
    // And the deleted staging model can never come back silently.
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    check("the staging model is deleted from the source",
      !menuSrc.includes("requestLeave") && !menuSrc.includes("PREVIEWING") && !menuSrc.includes("closet-equip") && !menuSrc.includes("discard unsaved") && !menuSrc.includes("KEEP BROWSING"));
  }

  section("closet thumbnails composite base + item through the SHARED renderer (preview == equipped)");
  {
    const { menu, overlay } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    const cards = () => byClass(overlay, "cos-card");
    const cardByName = (n: string) => cards().find((c) => textOf(c).includes(n));
    const canvasIn = (card: ShimNode | undefined): ShimNode[] =>
      collect(byClass(card ?? {}, "cos-icon")[0] ?? {}, (n) => n.tagName === "CANVAS");
    // Hat/glasses cards render a mini-canvas COMPOSITE (base body + this one item) rather than
    // a raw stretched icon — the exact path the mirror/world use, so a thumbnail can't drift.
    check("a hat card thumbnail is a composited canvas (fixed 40px \u2014 zero layout shift)",
      canvasIn(cardByName("Top Hat")).length === 1 && canvasIn(cardByName("Top Hat"))[0]?.width === 40);
    check("the No-Hat card composites the plain cowboy base (still a canvas, not a glyph)",
      canvasIn(cardByName("No Hat")).length === 1);
    menu.cycleTabs(1); // -> Glasses
    check("a glasses card thumbnail is a composited canvas too",
      canvasIn(cardByName("Round Specs")).length === 1);
    menu.cycleTabs(1); // -> Blob Color: swatches only, never a composite canvas
    check("body-color cards keep their swatch (no composite canvas)",
      byClass(cardByName("Cyan") ?? {}, "cos-swatch").length === 1 && canvasIn(cardByName("Cyan")).length === 0);
    menu.cycleTabs(1); // -> Titles: glyphs only, never a composite canvas
    check("title cards keep their glyph (no composite canvas)",
      canvasIn(cardByName("Depth Diver")).length === 0);
    // ONE render path: the closet card and the big mirror both draw the blob through
    // blobPreview's shared drawBlob (base sprite + drawLoadoutOverlays at side orientation),
    // and the card no longer reaches for the raw down-facing cosmeticIcon.
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    const previewSrc = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
    check("closet cards composite through the shared drawBlob (not the raw cosmeticIcon)",
      menuSrc.includes("drawBlob(g, cardLook") && !menuSrc.includes("cosmeticIcon"));
    check("drawBlob is the ONE shared blob renderer (base + side-orientation overlays), used by both surfaces",
      previewSrc.includes("export function drawBlob") && previewSrc.includes("heroBodySprite(look.hat)")
      && /drawLoadoutOverlays\(ctx, look\.hat, look\.face, \{[\s\S]*?orientation: "side"/.test(previewSrc)
      && previewSrc.includes("drawBlob(g, look,"));
    // Missing/streaming art keeps the safe fallback: nothing fabricated, and a glyph stands
    // for a hat/face id that has no generated art at all.
    check("the glyph fallback remains for an id with no art (defensive contract)",
      menuSrc.includes("!hasCosmeticArt(def.id)") && menuSrc.includes("\\u25cf"));
  }

  section("controller parity: pure pad mapping + LB/RB category cycling + B just closes");
  {
    // Edge detection: a held button fires exactly once.
    const idle = new Array<boolean>(16).fill(false);
    const aDown = idle.slice(); aDown[0] = true;
    check("A press maps to activate (equips the focused owned card instantly)", padActions(idle, aDown).join(",") === "activate");
    check("A held fires nothing further", padActions(aDown, aDown).length === 0);
    const bDown = idle.slice(); bDown[1] = true;
    check("B maps to back (the same Escape path)", padActions(idle, bDown).join(",") === "back");
    const dpad = idle.slice(); dpad[13] = true;
    check("D-pad down preserves its spatial direction", padActions(idle, dpad).join(",") === "focusDown");
    check("2×2 Kit Down maps Gunner → Bulwark", gridTargetIndex(0, 4, 2, "down") === 2);
    check("3×2 Pet Down maps No Pet → Baby Dragon", gridTargetIndex(0, 5, 3, "down") === 3);
    check("Pet's reserved sixth cell never steals focus", gridTargetIndex(2, 5, 3, "down") === 2);
    const lb = idle.slice(); lb[4] = true;
    const rb = idle.slice(); rb[5] = true;
    check("LB/RB map to tab cycling", padActions(idle, lb).join(",") === "tabPrev" && padActions(idle, rb).join(",") === "tabNext");

    // LB/RB cycles the closet's REAL categories through the menu's tab hook.
    const { menu, overlay, session } = makeMenu();
    await menu.showProfile("closet");
    await settle();
    menu.cycleTabs(1);
    const cards = () => byClass(overlay, "cos-card").map(textOf);
    check("RB cycles to the next real category (Glasses)", cards().some((c) => c.includes("No Glasses")), cards().join("|").slice(0, 80));
    menu.cycleTabs(-1);
    check("LB cycles back (Hats)", cards().some((c) => c.includes("No Hat")));

    // A pick then the visible close: the equip is already committed — close just closes,
    // with NO second confirm anywhere.
    byClass(overlay, "cos-card").find((c) => textOf(c).includes("Top Hat"))?.onclick?.();
    byClass(overlay, "panel-close")[0]?.onclick?.();
    await settle();
    check("close after an equip just closes (no confirmation exists)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));
    check("...and the instant equip stands", session.cosmetics.hat === "hat_top");
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
    const cards = () => byClass(overlay, "cos-card");
    cats().find((c) => textOf(c) === "Blob Color")?.onclick?.();
    check("body colors render as cards with the Amber default", cards().some((c) => textOf(c).includes("Amber (classic)")));
    cards().find((c) => textOf(c).includes("Cyan"))?.onclick?.();
    check("one tap equips a body color and drives BOTH color layers", session.colorIndex === 1 && session.cosmetics.body === "body_cyan");
    fireWindowEvent("keydown", { key: "Escape" });
    await settle();
    check("closing just closes (nothing to discard, no confirmation)", buttonsOf(overlay).some((b) => b.includes("PLAY ONLINE")));

    // NEW badge: a real unlock earned since the last visit wears the tag ONCE.
    const fresh = makeMenu({ profile: makeProfile({ unlocks: ["hat_crown"] }) });
    await fresh.menu.showProfile("closet");
    await settle();
    const crownCard = () => byClass(fresh.overlay, "cos-card").find((c) => textOf(c).includes("Crown"));
    check("a freshly earned unlock reads NEW (and is equippable)", textOf(crownCard() ?? {}).includes("NEW") && crownCard()?.disabled !== true);
    await fresh.menu.showProfile("closet");
    await settle();
    check("the NEW badge clears on the next visit (marked seen)", !textOf(crownCard() ?? {}).includes("NEW"));
  }

  section("post-run sign-in nudge: guests once per session, cooldown-guarded, honest copy");
  {
    localStorage.removeItem(NUDGE_DISMISSED_AT_KEY);
    localStorage.removeItem(NUDGE_SHOWN_AT_KEY);
    const guest = makeMenu({ auth: fakeAuth(false) });
    guest.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null, newUnlocks: ["hat_crown"] });
    const text = textOf(guest.overlay);
    check("nudge offers Google sign-in", buttonsOf(guest.overlay).some((b) => b.includes("Sign in with Google")));
    check("nudge offers 'not now'", buttonsOf(guest.overlay).some((b) => b === "not now"));
    check("the earned cosmetic strengthens the pitch", text.includes("Crown") && text.includes("only lives in this browser"));
    check("unlock banner celebrates the earn", text.includes("NEW COSMETIC UNLOCKED"));
    check("rendering the nudge records the shown-cooldown", localStorage.getItem(NUDGE_SHOWN_AT_KEY) !== null);
    // Without the earn, the pitch references the ACTUAL unsynced run.
    localStorage.removeItem(NUDGE_SHOWN_AT_KEY);
    const plain = makeMenu({ auth: fakeAuth(false) });
    plain.menu.showGameOver(RUN, PROFILE, { isNewBest: false, online: null });
    check("the plain pitch names the banked run", textOf(plain.overlay).includes(`your floor ${RUN.floor} run only lives in this browser`));
    localStorage.removeItem(NUDGE_SHOWN_AT_KEY);

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
    reachLoadoutReview(overlay);
    check("online REVIEW owns CONFIRM & CONTINUE ONLINE",
      textOf(byClass(overlay, "loadout-confirm")[0]).includes("CONFIRM & CONTINUE ONLINE"));
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    const buttons = buttonsOf(overlay);
    check("QUICK PLAY present", buttons.some((b) => b.includes("QUICK PLAY")));
    check("CREATE ROOM present", buttons.some((b) => b.includes("CREATE ROOM")));
    check("JOIN CODE present", buttons.some((b) => b.includes("JOIN CODE")));
    check("no classic co-op on the online home", !/classic/i.test(textOf(overlay)));
    // The match-mode toggle: CO-OP (team dungeon) vs ARENA (pvp deathmatch). CO-OP is always
    // live; ARENA is behind the TEMP kill switch (client entry guards covered by onlinelobby.test.ts).
    check("CO-OP mode toggle present on the online home", buttons.some((b) => b.trim() === "CO-OP"));

    // TEMP PVP KILL SWITCH: ARENA stays VISIBLE but disabled, with the PATCHING copy, so players
    // see it is temporary — never silently gone. CO-OP remains selectable and fully functional.
    check("PVP is disabled in this build (the containment default)", PVP_PUBLIC_ENABLED === false);
    const arenaBtn = collect(overlay, (n) => n.tagName === "BUTTON" && (textOf(n).includes("ARENA") || textOf(n).includes("PATCHING")))[0];
    check("the ARENA toggle is still shown (not hidden)", arenaBtn !== undefined);
    check("...with the PATCHING copy, not the plain ARENA label", textOf(arenaBtn ?? {}).trim() === ARENA_PATCHING_LABEL && ARENA_PATCHING_LABEL !== ARENA_LABEL, textOf(arenaBtn ?? {}));
    check("...and is disabled so it cannot start a pvp flow", arenaBtn?.disabled === true);
    check("...with a tooltip explaining why", (arenaBtn as { title?: string } | undefined)?.title === PVP_DISABLED_MESSAGE);
    // The disabled ARENA click handler is a no-op guard: clicking it must never mutate the
    // selected mode (a stale click can't arm pvp; QUICK PLAY / CREATE still carry co-op).
    arenaBtn?.onclick?.();
    check("CO-OP remains present as the selectable mode", buttons.some((b) => b.trim() === "CO-OP"));
  }

  section("the one-time name gate: a guest's FIRST online start sets name+color in one place");
  {
    localStorage.removeItem("blobrogue.name");
    // The profile echoes the gate's pick (a real backend stores and returns it), so the
    // authority reconcile keeps the committed body item.
    const { menu, overlay, session } = makeMenu({
      auth: fakeAuth(false),
      profile: makeProfile({ colorIndex: 3, cosmetics: { hat: null, face: null, body: "body_pink", title: null } }),
    });
    localStorage.removeItem("blobrogue.nameConfirmed");
    await menu.showTitle();
    check("the gate never renders on the title", !textOf(overlay).includes("WHAT'S YOUR NAME?"));
    await menu.showOnlineHome();
    const all = textOf(overlay);
    check("an unconfirmed guest's online start opens the gate", all.includes("WHAT'S YOUR NAME?"));
    check("the gate reuses the canonical menu shell", byClass(overlay, "menu").length === 1 && byClass(overlay, "name-gate").length === 1);
    check("the sub-line explains who sees the name", all.includes("Teammates will see this in your run."));
    check("the change-later note is present", all.includes("You can change this later in Profile."));
    const input = collect(overlay, (n) => n.tagName === "INPUT")[0] as ShimNode & { value?: string };
    check("the input is pre-filled with the generated default",
      typeof input?.value === "string" && input.value === session.name && input.value.length > 0 && input.value.toLowerCase() !== "blob",
      String(input?.value));
    const swatches = byClass(overlay, "swatch");
    check("the color swatches render here too (the full party palette)", swatches.length === 6, String(swatches.length));
    const selected = swatches.filter((s) => (s.className ?? "").split(" ").includes("sel"));
    check("exactly one swatch wears the SELECTED state", selected.length === 1);
    check("the selected state is GEOMETRY (check glyph), not hue", textOf(selected[0] ?? {}).includes("\u2713"));
    check("a live blob preview reflects the pick", byClass(overlay, "blob-preview").length === 1);

    const before = String(input.value);
    byClass(overlay, "gate-dice")[0]?.onclick?.();
    check("the dice rerolls another generated default", String(input.value) !== before && String(input.value).includes("Blob"), String(input.value));

    byClass(overlay, "swatch")[3]?.onclick?.();
    const selIdx = byClass(overlay, "swatch").findIndex((s) => (s.className ?? "").split(" ").includes("sel"));
    check("clicking a swatch moves the SELECTED state (rebuilt in place)", selIdx === 3, String(selIdx));

    (input as { value?: string }).value = "  Zippy\u200b  Zap  ";
    collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0]?.onclick?.();
    await settle();
    check("PLAY ONLINE commits the sanitized typed name", session.name === "Zippy Zap", session.name);
    check("...and the picked color (party color + body item together)", session.colorIndex === 3 && session.cosmetics.body === "body_pink", `${session.colorIndex}/${session.cosmetics.body}`);
    check("...and latches nameConfirmed", localStorage.getItem("blobrogue.nameConfirmed") === "1");
    check("...and proceeds to the required KIT gate", textOf(overlay).includes("CHOOSE YOUR KIT"));
    await passLoadoutGate(overlay);
    check("KIT → PET confirmation proceeds to the online home", buttonsOf(overlay).some((b) => b.includes("QUICK PLAY")));
    await menu.showOnlineHome();
    check("a confirmed guest skips straight to online (never re-prompted)",
      buttonsOf(overlay).some((b) => b.includes("QUICK PLAY")) && !textOf(overlay).includes("WHAT'S YOUR NAME?"));
  }

  section("name gate validation: junk input keeps the generated default — never empty, never 'blob'");
  {
    localStorage.removeItem("blobrogue.name");
    const { menu, overlay, session } = makeMenu({ auth: fakeAuth(false) });
    localStorage.removeItem("blobrogue.nameConfirmed");
    const generated = session.name;
    await menu.showOnlineHome();
    const input = collect(overlay, (n) => n.tagName === "INPUT")[0] as ShimNode & { value?: string };
    input.value = "  \u200b\u0007  ";
    collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0]?.onclick?.();
    await settle();
    check("junk input keeps the generated default", session.name === generated, session.name);
    check("the committed name is never 'blob'", session.name.toLowerCase() !== "blob");
    check("the name gate still proceeds to KIT", textOf(overlay).includes("CHOOSE YOUR KIT"));
    await passLoadoutGate(overlay);
    check("the combined gate still reaches online home", buttonsOf(overlay).some((b) => b.includes("QUICK PLAY")));
  }

  section("name gate routing: back declines without latching; signed-in players skip");
  {
    const declined = makeMenu({ auth: fakeAuth(false) });
    localStorage.removeItem("blobrogue.nameConfirmed");
    await declined.menu.showOnlineHome();
    check("gate open", textOf(declined.overlay).includes("WHAT'S YOUR NAME?"));
    collect(declined.overlay, (n) => n.tagName === "BUTTON" && textOf(n) === "back")[0]?.onclick?.();
    await settle();
    check("back returns to the title", buttonsOf(declined.overlay).some((b) => b.includes("PLAY SOLO")));
    check("declining does not latch the confirmation", localStorage.getItem("blobrogue.nameConfirmed") === null);

    const signed = makeMenu({ auth: fakeAuth(true) });
    localStorage.removeItem("blobrogue.nameConfirmed");
    await signed.menu.showOnlineHome();
    check("signed-in players use their Google name and skip the prompt",
      textOf(signed.overlay).includes("CHOOSE YOUR KIT") && !textOf(signed.overlay).includes("WHAT'S YOUR NAME?"));
    await passLoadoutGate(signed.overlay);
    localStorage.setItem("blobrogue.nameConfirmed", "1");
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
    const { menu, overlay, session } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([
      member("player-1", "Ada", { pingMs: 42 }),
      member("player-2", "Bob", { colorIndex: 5, isReady: true, pingMs: 87 }),
      member("player-3", "Cye", { colorIndex: 3, isReady: false }),
    ]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const text = textOf(overlay);
    check("a ready member reads LOADOUT ✓ / READY ✓",
      text.includes("LOADOUT ✓ · READY ✓ · 87ms"), text.slice(0, 220));
    check("an unready member reads NOT READY", text.includes("NOT READY"));
    check("pings ride the roster chips", text.includes("42ms") && text.includes("87ms"));
    check("the host is identified and still carries explicit readiness", text.includes("HOST") && text.includes("NOT READY \u00b7 42ms"));
    check("every row shows the confirmed combined pair", text.includes("GUNNER + NO PET") && text.includes("LOADOUT ✓"));
    // The header confirms the identity THIS player joins as: YOU: [swatch] <name>.
    const you = byClass(overlay, "lobby-you");
    check("the lobby header carries the YOU confirmation", you.length === 1 && textOf(you[0]).includes("YOU:"), textOf(you[0] ?? {}));
    check("...with this player's actual name", textOf(you[0] ?? {}).includes(session.name), session.name);
    check("...and their committed color swatch", byClass(you[0] ?? {}, "you-swatch").length === 1);
  }

  section("lobby roster follows the authoritative blocker ladder");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([
      member("player-1", "Kitless", {
        isKitChoiceMade: false, isPetChoiceMade: false, isLoadoutConfirmed: false,
      }),
      member("player-2", "Petless", {
        isPetChoiceMade: false, isLoadoutConfirmed: false,
      }),
      member("player-3", "Unconfirmed", {
        isLoadoutConfirmed: false,
      }),
      member("player-4", "Unready"),
      member("player-5", "Ready", { isReady: true }),
    ]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const text = textOf(overlay);
    check("missing kit is named exactly", text.includes("CHOOSE KIT"));
    check("missing pet is named exactly", text.includes("CHOOSE PET"));
    check("unconfirmed pair is named exactly", text.includes("CONFIRM LOADOUT"));
    check("confirmed-but-unready is distinct", text.includes("LOADOUT ✓ · NOT READY"));
    check("ready is the final state", text.includes("LOADOUT ✓ · READY ✓"));
    f.setPlayers([
      member("player-1", "UnreadyHost"),
      member("player-2", "KitlessBob", {
        isKitChoiceMade: false, isPetChoiceMade: false, isLoadoutConfirmed: false,
      }),
    ]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    check("party-wide ladder prioritizes CHOOSE KIT over an earlier NOT READY row",
      textOf(overlay).includes("KitlessBob must choose a kit"));
  }

  section("private CHANGE LOADOUT uses the same gate and clears ready on final confirmation");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([member("player-1", "Ada", { isReady: true })]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    byClass(overlay, "change-loadout")[0]?.onclick?.();
    await settle();
    check("entering the editor first removes ready consent", f.readyCalls[0] === false);
    check("the shared KIT gate opens with room context",
      textOf(overlay).includes("CHOOSE YOUR KIT") && textOf(overlay).includes("ROOM ABCD"));
    reachLoadoutReview(overlay, "mender", "none");
    check("private REVIEW uses CONFIRM LOADOUT and never Ready",
      textOf(byClass(overlay, "loadout-confirm")[0]).includes("CONFIRM LOADOUT")
      && f.readyCalls.every((isReady) => !isReady));
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    const roster = textOf(overlay);
    check("final confirm returns to lobby with the new pair and NOT READY",
      roster.includes("MENDER + NO PET") && roster.includes("NOT READY"));
    check("Review confirmation never readies implicitly",
      f.readyCalls.every((isReady) => !isReady)
      && buttonsOf(overlay).some((button) => button.includes("READY UP")));
  }

  section("host start gate: every member must be loadout-confirmed and ready");
  {
    const { menu, overlay } = makeMenu();
    const f = fakeLobby("ABCD");
    f.setPlayers([member("player-1", "Ada", { isReady: true }), member("player-2", "Bob", { isReady: true })]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const enabledStart = collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("START RUN"))[0];
    check("everyone ready -> enabled START RUN", enabledStart?.disabled === false);
    enabledStart?.onclick?.();
    await settle();
    check("enabled START reaches the authoritative mutation", f.startCalls() === 1);

    f.setPlayers([member("player-1", "Ada", { isReady: true }), member("player-2", "Bob", { isReady: false })]);
    menu.showOnlineLobby(f.lobby, PROFILE);
    const buttons = buttonsOf(overlay);
    const disabledStart = collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("START RUN"))[0];
    check("incomplete party hard-disables START", disabledStart?.disabled === true);
    disabledStart?.onclick?.();
    await settle();
    check("disabled START sends no mutation", f.startCalls() === 1);
    check("disabled START retains the exact blocker copy", textOf(overlay).includes("Bob is not ready"));
    check("START remains visible instead of offering a partial-launch escape hatch", buttons.some((b) => b.includes("START RUN")));
    const blockerCases: Array<{ label: string; opts: Partial<LobbyPlayer>; copy: string }> = [
      {
        label: "kitless",
        opts: { isKitChoiceMade: false, isPetChoiceMade: false, isLoadoutConfirmed: false, isReady: false },
        copy: "Bob must choose a kit",
      },
      {
        label: "petless",
        opts: { isPetChoiceMade: false, isLoadoutConfirmed: false, isReady: false },
        copy: "Bob must choose a pet or No Pet",
      },
      {
        label: "unconfirmed",
        opts: { isLoadoutConfirmed: false, isReady: false },
        copy: "Bob must confirm loadout",
      },
    ];
    for (const blockerCase of blockerCases) {
      f.setPlayers([member("player-1", "Ada", { isReady: true }), member("player-2", "Bob", blockerCase.opts)]);
      menu.showOnlineLobby(f.lobby, PROFILE);
      const blocked = collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("START RUN"))[0];
      blocked?.onclick?.();
      check(`${blockerCase.label} hard-disables START and sends no mutation`,
        blocked?.disabled === true && f.startCalls() === 1);
      check(`${blockerCase.label} keeps the exact blocker copy`, textOf(overlay).includes(blockerCase.copy));
    }
    check("START ANYWAY is removed", !buttons.some((b) => b.includes("START ANYWAY")));
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

  section("invite links: KIT → PET → JOIN CODE, then the SAME validated join as manual");
  {
    const { menu, overlay, launches, calls } = makeMenu({ join: { code: "ABCD", status: "lobby" } });
    const loc = window.location as unknown as { pathname: string; search: string; href: string };
    loc.pathname = "/r/ABCD"; loc.search = ""; loc.href = "http://localhost/r/ABCD";
    await menu.openInvite("ABCD");
    check("the invite renders KIT before any join", textOf(overlay).includes("CHOOSE YOUR KIT") && !calls.includes("rooms:join"));
    check("invite context names INVITE and room code exactly once",
      textOf(byClass(overlay, "loadout-context")[0] ?? {}) === "INVITE · ROOM ABCD");
    check("the URL is not consumed before final confirmation", loc.pathname === "/r/ABCD");
    byClass(overlay, "kit-option").find((card) => card.getAttribute?.("data-kit") === "gunner")?.onclick?.();
    collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("NEXT · CHOOSE PET"))[0]?.onclick?.();
    check("invite PET context includes INVITE and room code once",
      textOf(byClass(overlay, "loadout-context")[0] ?? {}) === "KIT GUNNER · INVITE · ROOM ABCD");
    byClass(overlay, "pet-option").find((card) => card.getAttribute?.("data-pet") === "none")?.onclick?.();
    byClass(overlay, "loadout-review-next")[0]?.onclick?.();
    check("invite REVIEW context includes INVITE and room code once",
      textOf(byClass(overlay, "loadout-context")[0] ?? {}) === "INVITE · ROOM ABCD");
    check("invite REVIEW owns the exact combined destination CTA",
      textOf(byClass(overlay, "loadout-confirm")[0]).includes("CONFIRM & JOIN ABCD")
      && !calls.includes("rooms:join"));
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    const text = textOf(overlay);
    check("success+lobby lands IN the room lobby (auto-joined, nothing to retype)", text.includes("ROOM ABCD"));
    check("the code badge renders the joined room", textOf(byClass(overlay, "code-badge")[0] ?? {}) === "ABCD");
    check("a lobby-status invite never cold-launches gameplay", launches.length === 0);
    check("the invite is stripped once resolved (refresh/back can't re-join)", loc.pathname === "/", loc.pathname);
  }

  section("invite onto a live run: the existing join-live path drops into the run");
  {
    const { menu, overlay, launches } = makeMenu({ join: { code: "WXYZ", status: "playing" } });
    const loc = window.location as unknown as { pathname: string; search: string; href: string };
    loc.pathname = "/"; loc.search = "?room=WXYZ"; loc.href = "http://localhost/?room=WXYZ";
    await menu.openInvite("WXYZ");
    check("a live-room late join still gates before spawn", launches.length === 0);
    await passLoadoutGate(overlay);
    check("success+already-playing launches through the join-live path", launches.length === 1 && launches[0]?.code === "WXYZ");
    check("...ungated (a drop-in, not a party start)", launches[0]?.isPartyStart === false);
    check("the query-form invite is consumed on resolve too", loc.search === "", loc.search);
  }

  section("invite fallbacks: each refusal maps to the spec copy; the screen stays interactive");
  {
    const expectations: Array<{ join: "full" | "ended" | "missing" | "classic"; reason: string }> = [
      { join: "full", reason: "THAT ROOM IS FULL (4/4)" },
      { join: "ended", reason: "THIS INVITE HAS ENDED" },
      { join: "missing", reason: "INVITE LINK EXPIRED OR INVALID" },
      { join: "classic", reason: "THIS INVITE ISN'T AN ONLINE ROOM" },
    ];
    for (const { join, reason } of expectations) {
      const { menu, overlay } = makeMenu({ join });
      await menu.openInvite("ABCD");
      await passLoadoutGate(overlay);
      const text = textOf(overlay);
      check(`${join}: the exact spec reason renders`, text.includes(reason), text.slice(0, 160));
      check(`${join}: failure stays in REVIEW with the final CTA retryable`,
        text.includes("REVIEW LOADOUT") && byClass(overlay, "loadout-confirm")[0]?.disabled !== true);
      collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("BACK · PET"))[0]?.onclick?.();
      collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node).includes("BACK · KIT"))[0]?.onclick?.();
      collect(overlay, (node) => node.tagName === "BUTTON" && textOf(node) === "BACK")[0]?.onclick?.();
      await settle();
    }
  }

  section("network failure stays in the gate and final CTA retries the same validated join");
  {
    const fakeOpts: FakeOpts = { join: "error" };
    const { menu, overlay } = makeMenu(fakeOpts);
    await menu.openInvite("ABCD");
    await passLoadoutGate(overlay);
    check("an unrecognized failure reads as the network state", textOf(overlay).includes(INVITE_UNREACHABLE_NOTE));
    check("the same final CTA remains enabled for retry", byClass(overlay, "loadout-confirm")[0]?.disabled !== true);
    fakeOpts.join = { code: "ABCD", status: "lobby" };
    byClass(overlay, "loadout-confirm")[0]?.onclick?.();
    await settle();
    await settle();
    check("TRY AGAIN re-runs the join and lands in the room", textOf(overlay).includes("ROOM ABCD"), textOf(overlay).slice(0, 120));
  }

  section("an invite in the offline build: the title + one honest status line, no dead end");
  {
    const overlay = document.createElement("div") as unknown as ShimNode;
    const session = new Session(null);
    const menu = new Menu(overlay as unknown as HTMLElement, session, null, null, { startSolo() {}, startOnline() {} });
    await menu.openInvite("ABCD");
    check("the title renders with its play action", buttonsOf(overlay).some((b) => b.includes("PLAY")));
    check("the honest line is the spec's exact copy", textOf(overlay).includes(INVITE_OFFLINE_NOTE));
    check("...inside the reserved home-status box", textOf(byClass(overlay, "home-status")[0] ?? {}) === INVITE_OFFLINE_NOTE);
  }

  section("guest invite: a signed-out player joins as a guest — the invite never forces sign-in");
  {
    const guest = makeMenu({ join: { code: "GHJK", status: "lobby" }, auth: null });
    await guest.menu.openInvite("GHJK");
    await passLoadoutGate(guest.overlay);
    check("the guest lands in the room lobby", textOf(guest.overlay).includes("ROOM GHJK"));
    const flushIdx = guest.calls.indexOf("players:ensurePlayer");
    const joinIdx = guest.calls.indexOf("rooms:join");
    check("identity comes from the ordinary guest ensurePlayer path, before the join",
      flushIdx !== -1 && joinIdx !== -1 && flushIdx < joinIdx, guest.calls.join(" -> "));
    check("no sign-in demand anywhere on the landing", !textOf(guest.overlay).includes("SIGN IN"));
  }

  section("a FIRST-TIME guest invite passes the one-time name gate, then the join continues");
  {
    const { menu, overlay } = makeMenu({ join: { code: "ABCD", status: "lobby" } });
    localStorage.removeItem("blobrogue.nameConfirmed");
    await menu.openInvite("ABCD");
    check("the identity gate renders BEFORE any join", textOf(overlay).includes("WHAT'S YOUR NAME?"));
    const play = collect(overlay, (n) => n.tagName === "BUTTON" && textOf(n).includes("PLAY ONLINE"))[0];
    play?.onclick?.();
    await settle();
    check("name confirmation continues to the invite KIT gate", textOf(overlay).includes("CHOOSE YOUR KIT"));
    await passLoadoutGate(overlay);
    check("KIT → PET → JOIN continues into the room lobby", textOf(overlay).includes("ROOM ABCD"), textOf(overlay).slice(0, 120));
    check("the gate latched (next invite skips it)", localStorage.getItem("blobrogue.nameConfirmed") === "1");
  }

  section("COPY INVITE: one tap shares the FULL URL with honest per-outcome confirmation");
  {
    const nav = navigator as unknown as {
      clipboard?: { writeText(text: string): Promise<void> };
      share?: (data: { url: string }) => Promise<void>;
      maxTouchPoints?: number;
    };
    const copiedUrls: string[] = [];
    nav.clipboard = { writeText: (t) => { copiedUrls.push(t); return Promise.resolve(); } };
    const { menu, overlay } = makeMenu({ join: { code: "ABCD", status: "lobby" } });
    await menu.openInvite("ABCD");
    await passLoadoutGate(overlay);
    const btn = byClass(overlay, "invite-copy")[0];
    check("the control idles as COPY INVITE", textOf(btn ?? {}) === COPY_INVITE_LABEL);
    const buttonsBefore = buttonsOf(overlay).length;
    btn.onclick?.();
    await settle();
    check("one tap copies the FULL shareable URL (not just the code)", copiedUrls[0] === "http://localhost/r/ABCD", copiedUrls.join("|"));
    check("the confirmation reads COPIED! in the same button", textOf(btn) === INVITE_COPIED_LABEL);
    check("feedback swaps the LABEL only — no button appears or moves", buttonsOf(overlay).length === buttonsBefore);

    // A blocked clipboard: honest failure + the raw URL in the reserved line.
    nav.clipboard = { writeText: () => Promise.reject(new Error("denied")) };
    btn.onclick?.();
    await settle();
    check("a blocked clipboard reads COPY FAILED (never a fake COPIED!)", textOf(btn) === INVITE_COPY_FAILED_LABEL);
    check("...and the reserved line hands over the raw URL", textOf(byClass(overlay, "invite-url")[0]).includes("/r/ABCD"));

    // Touch device: the native share sheet wins.
    const sharedUrls: string[] = [];
    nav.maxTouchPoints = 1;
    nav.share = (d) => { sharedUrls.push(d.url); return Promise.resolve(); };
    btn.onclick?.();
    await settle();
    check("touch devices get the native share sheet with the same URL", sharedUrls[0] === "http://localhost/r/ABCD");
    check("a completed share confirms SHARED!", textOf(btn) === INVITE_SHARED_LABEL);
    delete nav.share;
    delete nav.clipboard;
    nav.maxTouchPoints = 0;
  }

  section("invite affordance keeps the fixed geometry (reserved boxes from first paint)");
  {
    const { menu, overlay } = makeMenu({ join: { code: "ABCD", status: "lobby" } });
    await menu.openInvite("ABCD");
    await passLoadoutGate(overlay);
    check("the badge + invite control share one row", byClass(overlay, "code-row").length === 1);
    check("the invite-url line is reserved EMPTY from first paint", byClass(overlay, "invite-url").length === 1 && textOf(byClass(overlay, "invite-url")[0]) === "");
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    check("the control's width is reserved in CSS (label swaps can't shift)", /\.invite-copy\s*\{[^}]*min-width/.test(html));
    check("the URL line's height is reserved in CSS (failure fill can't shift)", /invite-url\s*\{[^}]*min-height/.test(html));
  }

  section("What's New: the uniform WHAT'S NEW nav destination, single-sourced from CHANGELOG.md");
  {
    const SEEN_KEY = "blobrogue.changelogSeen";
    const latest = LATEST_VERSION; // the newest changelog section's version key

    // A brand-new player (no stored key): the dest shows, WITHOUT the unread cue, and the
    // boot popup is silent (it just catches them up). It rides the uniform nav stack.
    localStorage.removeItem(SEEN_KEY);
    const fresh = makeMenu();
    await fresh.menu.showTitle();
    const wn = byClass(fresh.overlay, "nav-whatsnew");
    check("WHAT'S NEW is a uniform .dest in the nav stack", wn.length === 1
      && (wn[0].className ?? "").includes("dest") && (wn[0].className ?? "").includes("nav-btn") && textOf(wn[0]).includes("WHAT'S NEW"));
    check("PLAY stays first, What's New rides out of the Play path (never buttons[0])",
      (buttonsOf(fresh.overlay)[0] ?? "").includes("PLAY"));
    check("a brand-new player sees NO unread cue (no NEW chip, no dot)",
      byClass(fresh.overlay, "wn-new").length === 0 && byClass(fresh.overlay, "wn-dot").length === 0);
    fresh.menu.maybeShowChangelogPopup();
    check("a brand-new player gets NO popup", byClass(fresh.overlay, "changelog-scrim").length === 0);
    check("...and is caught up silently (seen := latest)", localStorage.getItem(SEEN_KEY) === latest);

    // A returning player on a NEW build (stored key from an older version): the button wears
    // the grayscale-distinct NEW chip + the amber square dot, and the boot popup opens once.
    localStorage.setItem(SEEN_KEY, "2026-07-06");
    const ret = makeMenu();
    await ret.menu.showTitle();
    check("a returning player on a new build sees the NEW chip + amber dot",
      byClass(ret.overlay, "wn-new").length === 1 && textOf(byClass(ret.overlay, "wn-new")[0]) === "NEW"
      && byClass(ret.overlay, "wn-dot").length === 1);
    ret.menu.maybeShowChangelogPopup();
    check("...and the ONE-TIME popup auto-opens at the menu", byClass(ret.overlay, "changelog-scrim").length === 1);
    check("the popup header flags the update (UPDATED · WHAT'S NEW)", textOf(byClass(ret.overlay, "cl-title")[0]).includes("UPDATED"));
    const gotIt = collect(ret.overlay, (n) => n.tagName === "BUTTON" && textOf(n) === "GOT IT");
    check("the popup carries a [GOT IT] primary", gotIt.length === 1);
    check("the panel renders version sections + the Unreleased IN PROGRESS marker",
      byClass(ret.overlay, "cl-section").length === CHANGELOG.length && textOf(byClass(ret.overlay, "cl-body")[0]).includes("IN PROGRESS"));
    check("opening the popup marks the build seen (dot cleared next paint)", localStorage.getItem(SEEN_KEY) === latest);
    gotIt[0].onclick?.();
    check("GOT IT closes the popup", byClass(ret.overlay, "changelog-scrim").length === 0);

    // Caught up: no cue, no popup.
    localStorage.setItem(SEEN_KEY, latest);
    const caught = makeMenu();
    await caught.menu.showTitle();
    check("a caught-up player sees no unread cue", byClass(caught.overlay, "wn-dot").length === 0);
    caught.menu.maybeShowChangelogPopup();
    check("...and no popup", byClass(caught.overlay, "changelog-scrim").length === 0);

    // Clicking the button opens the plain panel (no GOT IT) and clears the unread cue live.
    localStorage.setItem(SEEN_KEY, "2026-07-06");
    const click = makeMenu();
    await click.menu.showTitle();
    check("unread before click", byClass(click.overlay, "wn-dot").length === 1);
    byClass(click.overlay, "nav-whatsnew")[0]?.onclick?.();
    check("clicking opens the panel (no GOT IT — not the popup)",
      byClass(click.overlay, "changelog-scrim").length === 1
      && collect(click.overlay, (n) => n.tagName === "BUTTON" && textOf(n) === "GOT IT").length === 0);
    check("opening clears the unread cue on the title dest in place",
      byClass(byClass(click.overlay, "nav-whatsnew")[0] ?? {}, "wn-dot").length === 0);
    check("...and marks the build seen", localStorage.getItem(SEEN_KEY) === latest);
    fireWindowEvent("keydown", { key: "Escape" });
    check("Escape closes the panel", byClass(click.overlay, "changelog-scrim").length === 0);
    localStorage.removeItem(SEEN_KEY);
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll menu one-path + redesign assertions passed.\n");
}

void main();
