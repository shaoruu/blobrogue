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
import { NUDGE_DISMISSED_AT_KEY, NUDGE_SHOWN_AT_KEY } from "../src/ui/signinNudge.js";
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

interface EnsureArgs {
  name?: string;
  colorIndex?: number;
  cosmetics?: Partial<Record<"hat" | "face" | "body" | "title", string>>;
}

// One deferred ensurePlayer write the test settles by hand (the rapid-switch suite).
interface PendingPersist {
  args: EnsureArgs;
  resolveEcho: () => void;
  fail: () => void;
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
}

interface FakeConvex {
  client: ConvexClient;
  pendingPersists: PendingPersist[];
  mutationCalls: () => number;
}

// The menu's Convex surface, routed by function name: profile upserts/reads resolve to the
// fixture, the leaderboard resolves (or fails) per test.
function fakeConvex(opts: FakeOpts = {}): FakeConvex {
  const profile = opts.profile ?? PROFILE;
  const pendingPersists: PendingPersist[] = [];
  let calls = 0;
  const echo = (args: EnsureArgs): ProfileDoc => {
    const cosmetics = { ...profile.cosmetics };
    for (const slot of ["hat", "face", "body", "title"] as const) {
      const v = args.cosmetics?.[slot];
      if (v !== undefined) cosmetics[slot] = v === "none" ? null : v;
    }
    return { ...profile, cosmetics, colorIndex: args.colorIndex ?? profile.colorIndex };
  };
  const fake = {
    mutation: (_ref: unknown, args?: EnsureArgs) => {
      calls++;
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
  return { client: fake as unknown as ConvexClient, pendingPersists, mutationCalls: () => calls };
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
  session: Session;
  pendingPersists: PendingPersist[];
  mutationCalls: () => number;
} {
  // Section isolation: the shim shares ONE localStorage; stale appearance picks from a
  // previous section must never leak into a fresh session.
  localStorage.removeItem("blobrogue.cosmetics");
  localStorage.removeItem("blobrogue.color");
  localStorage.removeItem("blobrogue.closet.seenUnlocks");
  // Sections run as an already-confirmed guest so online flows land on the surfaces under
  // test; the one-time name gate has its own sections (which clear this latch explicitly).
  localStorage.setItem("blobrogue.nameConfirmed", "1");
  const overlay = document.createElement("div") as unknown as ShimNode;
  const convex = fakeConvex(opts);
  const session = new Session(convex.client);
  const launches: LaunchRecord[] = [];
  const host: MenuHost = {
    startSolo() {},
    startOnline(lobby, _profile, isPartyStart) {
      launches.push({ code: lobby.code, isPartyStart });
    },
  };
  const menu = new Menu(overlay as unknown as HTMLElement, session, convex.client, opts.auth ?? null, host);
  return { menu, overlay, launches, session, pendingPersists: convex.pendingPersists, mutationCalls: convex.mutationCalls };
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
    check("the canvas reserves its fixed 96px box from creation", canvasBefore?.width === 96 && canvasBefore?.height === 96);
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
    check("shell: 150px hero row over minmax(0,1fr), height min(548px,100vh-40px), min 508px",
      /\.menu-home\{ display:grid; grid-template-rows:150px minmax\(0,1fr\); gap:14px;\s*\n\s*height:min\(548px,calc\(100vh - 40px\)\); min-height:508px; \}/.test(html));
    check("hero band: 1fr wordmark | 132px stage; stage canvas is 96px",
      /\.home-hero\{ grid-row:1; display:grid; grid-template-columns:1fr 132px;/.test(html)
      && /\.home-hero \.blob-stage\{[^}]*width:132px; height:132px;/.test(html)
      && /\.home-hero \.blob-stage \.blob-preview\{[^}]*width:96px; height:96px;/.test(html));
    check("the blob STANDS: radial plinth glow behind + soft ground-shadow ellipse",
      /\.home-hero \.blob-stage::before\{[^}]*radial-gradient/.test(html)
      && /\.home-hero \.blob-stage::after\{[^}]*border-radius:50%; background:rgba\(5,3,11/.test(html));
    // The accepted responsive rules: narrow stacks the hero (104/80), short viewports
    // compact it (100px row, 88/64) so Play + the glance stay on screen.
    const narrowCss = html.slice(html.indexOf("@media (max-width:680px)"), html.indexOf("@media (max-height:679px)"));
    check("narrow: hero stacks centered with a 104px stage (80px blob)",
      /\.home-hero\{ grid-template-columns:1fr; justify-items:center; gap:8px; \}/.test(narrowCss)
      && /width:104px; height:104px/.test(narrowCss) && /width:80px; height:80px/.test(narrowCss));
    const shortCss = html.slice(html.indexOf("@media (max-height:679px)"));
    check("short: 100px hero row with an 88px stage (64px blob)",
      /grid-template-rows:100px minmax\(0,1fr\)/.test(shortCss)
      && /width:88px; height:88px/.test(shortCss) && /width:64px; height:64px/.test(shortCss));
    // The accepted rendering-loop rules live in the shared preview: rAF only while
    // visible, pause on hide/overlay/tab-hide, static idle frame under reduced motion.
    const previewSrc = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
    check("the idle loop pauses on tab hide and honors prefers-reduced-motion",
      previewSrc.includes("visibilitychange") && previewSrc.includes("prefers-reduced-motion") && previewSrc.includes("setPaused"));
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    check("the menu parks the title loop while hidden (in-run) and while the overlay covers it",
      /hide\(\) \{[\s\S]{0,220}setPaused\(true\)/.test(menuSrc) && menuSrc.includes("this.titleStage?.setPaused(true);") && menuSrc.includes("this.titleStage?.setPaused(false);"));

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
      collect(byClass(overlay, "blob-stage")[0] ?? {}, (n) => n.tagName === "CANVAS")[0] === stageCanvas && stageCanvas?.width === 96);
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
    check("focus ring is an EXTERNAL cream outline (not the amber frame)", /\.cos-card:focus-visible\{ outline:2px solid var\(--cream\); outline-offset:3px/.test(html));
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
    check("D-pad down maps to focusNext", padActions(idle, dpad).join(",") === "focusNext");
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
    const buttons = buttonsOf(overlay);
    check("QUICK PLAY present", buttons.some((b) => b.includes("QUICK PLAY")));
    check("CREATE ROOM present", buttons.some((b) => b.includes("CREATE ROOM")));
    check("JOIN CODE present", buttons.some((b) => b.includes("JOIN CODE")));
    check("no classic co-op on the online home", !/classic/i.test(textOf(overlay)));
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
    check("...and proceeds to the online home", buttonsOf(overlay).some((b) => b.includes("QUICK PLAY")));
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
    check("the gate still proceeds", buttonsOf(overlay).some((b) => b.includes("QUICK PLAY")));
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
      buttonsOf(signed.overlay).some((b) => b.includes("QUICK PLAY")) && !textOf(signed.overlay).includes("WHAT'S YOUR NAME?"));
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
    check("a ready member reads READY", /READY \u00b7 87ms/.test(text), text.slice(0, 220));
    check("an unready member reads NOT READY", text.includes("NOT READY"));
    check("pings ride the roster chips", text.includes("42ms") && text.includes("87ms"));
    check("the host row is implicit consent (HOST, no ready toggle)", text.includes("HOST \u00b7 42ms"));
    // The header confirms the identity THIS player joins as: YOU: [swatch] <name>.
    const you = byClass(overlay, "lobby-you");
    check("the lobby header carries the YOU confirmation", you.length === 1 && textOf(you[0]).includes("YOU:"), textOf(you[0] ?? {}));
    check("...with this player's actual name", textOf(you[0] ?? {}).includes(session.name), session.name);
    check("...and their committed color swatch", byClass(you[0] ?? {}, "you-swatch").length === 1);
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
