import { ConvexClient } from "convex/browser";
import { Game } from "./game/game.js";
import type { RunResult, ExitReason } from "./game/game.js";
import type { ProfileDoc } from "./net/api.js";
import { CONVEX_URL, resolveGsUrl, defaultGsUrl, devTicketUrl, isExplicitGsOverride } from "./net/config.js";
import { Session } from "./net/session.js";
import { AuthClient } from "./net/auth.js";
import { Menu } from "./ui/menu.js";
import { bindMenuGamepad } from "./ui/menuGamepad.js";
import { bindUiScale } from "./ui/settings.js";
import { exitNoteFor, INVITE_INVALID_NOTE, INVITE_OFFLINE_NOTE } from "./ui/onlineCopy.js";
import { parseInviteCode, hasInviteIntent, stripInviteFromLocation } from "./net/inviteLink.js";
import type { OnlineLobby } from "./net/onlineLobby.js";

declare global {
  interface Window {
    // Dev-server-only QA hook (see bootNormal); never assigned in production builds.
    __blobdev?: { game: Game; hideMenu: () => void };
  }
}

const canvas = document.getElementById("game") as HTMLCanvasElement;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLElement;

// Hidden dev route: `?dev=1` (sandbox) / `?dev=sprites` (viewer). Never linked from the
// menu, so a normal player can't reach it. The whole dev layer is dynamically imported
// only when the flag is present, keeping it out of the normal play bundle entirely.
const devMode = new URLSearchParams(window.location.search).get("dev");
if (devMode !== null) {
  void import("./dev/main.js").then((m) => m.bootDev(devMode, canvas, minimap, overlay));
} else {
  void bootNormal();
}

async function bootNormal() {
  bindUiScale(); // persisted HUD/overlay scale, applied before anything renders
  // The single online entry point. With no VITE_CONVEX_URL this stays null and the
  // entire multiplayer/identity layer is inert — solo play is unaffected.
  const client = CONVEX_URL ? new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false }) : null;
  // Optional Google sign-in. Only exists when a Convex backend is configured; if the
  // auth functions aren't deployed yet, the sign-in button is present-but-inert.
  const auth = client && CONVEX_URL ? new AuthClient(client, CONVEX_URL) : null;
  const session = new Session(client);

  let activeOnline: OnlineLobby | null = null;
  // Menu-vs-run truth for the warm invite path: a history navigation onto an invite URL
  // routes into that room's lobby only while the menu owns the screen — it must never
  // yank a live run out from under the player.
  let isInRun = false;

  async function onGameOver(result: RunResult) {
    isInRun = false;
    // An online room SURVIVES the wipe: the party regroups in the same lobby (the menu's
    // game-over screen offers "back to lobby" / "play again" and owns leaving the room).
    const online = activeOnline;
    // Snapshot the previous best + unlocks before recordRun folds the run, so the results
    // screen can celebrate a PB and any cosmetics this run just earned.
    const prevProfile = session.profile;
    const prevBest = prevProfile?.deepestFloor ?? 0;
    const saved = await session.recordRun(result);
    const isNewBest = saved !== null && result.floor > prevBest;
    // Only diff unlocks against a KNOWN before-state — a cold start with no prior profile
    // can't tell "new this run" from "earned long ago", so it stays quiet.
    const newUnlocks = saved && prevProfile ? saved.unlocks.filter((id) => !prevProfile.unlocks.includes(id)) : [];
    menu.showGameOver(result, saved ?? session.profile, { isNewBest, online, newUnlocks });
  }

  function onExit(reason?: ExitReason, detail?: string) {
    isInRun = false;
    // Stepping out of an online run (Esc/cancel, a failed start, an outage) lands back in
    // the room lobby, not the title — the run may still be live for friends (the lobby's
    // REJOIN RUN / leave buttons are the contract's resume-failed choices). The exact copy
    // for every reason lives in src/ui/onlineCopy.ts.
    if (activeOnline && activeOnline.isActive) {
      menu.showOnlineLobby(activeOnline, session.profile, exitNoteFor(reason, detail));
      return;
    }
    // The room itself is GONE (ended/expired while we were away): surface RUN ENDED WHILE
    // AWAY on the online home instead of silently dropping to the title.
    const isOnlineEnding = reason === "connection_lost" || reason === "run_ended_away" || reason === "superseded";
    activeOnline = null;
    if (isOnlineEnding && client) {
      void menu.showOnlineHome(exitNoteFor("run_ended_away"));
      return;
    }
    void menu.showTitle();
  }

  function leaveOnlineIfAny() {
    if (activeOnline) { activeOnline.leave(); activeOnline = null; }
  }

  const game = new Game(
    canvas, minimap, document.body,
    (result) => void onGameOver(result),
    onExit,
    // Progressive deepest-floor banking on each descend (fire-and-forget); no-ops without a
    // Convex client. This is what keeps the leaderboard's floor honest when a run ends by a
    // teammate continuing / a disconnect / a quit instead of a clean full-party wipe.
    (floor) => session.recordFloorProgress(floor),
  );
  // Dev-server-only QA hook (dropped from production builds): lets headless tooling —
  // screenshot capture, manual floor QA — drive the real game without menu automation.
  if (import.meta.env.DEV) {
    window.__blobdev = { game, hideMenu: () => menu.hide() };
  }

  const menu = new Menu(overlay, session, client, auth, {
    startSolo(profile: ProfileDoc | null) {
      leaveOnlineIfAny();
      isInRun = true;
      menu.hide();
      game.start({ mode: "solo", coop: null, profile, selfColorIndex: session.colorIndex, selfCosmetics: session.cosmetics });
    },
    startOnline(lobby: OnlineLobby, profile: ProfileDoc | null, isPartyStart: boolean) {
      if (activeOnline && activeOnline !== lobby) activeOnline.leave();
      activeOnline = lobby;
      isInRun = true;
      menu.hide();
      game.start({
        mode: "online",
        online: {
          url: defaultGsUrl(),
          // The lobby mints a Convex ticket bound to THIS room's world id (verified against
          // room membership server-side) — that binding is what puts the party in one world.
          getTicket: () => lobby.mintTicket(),
          roomCode: lobby.code,
          // ...and the client ASSERTS the server honored it: every snapshot's world id must
          // equal the room's world or the run refuses to play (close + explicit lobby error).
          expectedWorldId: lobby.expectedWorldId(),
          selfPlayerId: lobby.selfId || null,
          // A lobby START gates gameplay behind the readiness veil until every current room
          // member is connected to the world; drop-ins/rejoins/quick play join a live run.
          party: isPartyStart ? () => lobby.players() : null,
          onWorldPresence: (worldId) => lobby.reportWorld(worldId),
        },
        profile,
        selfColorIndex: session.colorIndex,
        selfCosmetics: session.cosmetics,
      });
    },
  });

  // Controller parity for the menu surfaces: D-pad focus, A activate, B = the guarded
  // Escape path, LB/RB tab/category cycling. Inert while the overlay is hidden (in-run).
  bindMenuGamepad(overlay, { onTab: (dir) => menu.cycleTabs(dir) });

  // Preload the pixel fonts before any canvas draw — canvas ctx.font silently falls back
  // to a system font if the web font isn't loaded yet at draw time (DOM text reflows on
  // load, canvas does not). Guarantees HUD/GO-DOWN/name labels are pixel from frame 1.
  const fontsReady = Promise.all([
    document.fonts.load('10px "Press Start 2P"'),
    document.fonts.load('700 11px "Silkscreen"'),
    document.fonts.load('16px "VT323"'),
    document.fonts.ready,
  ]).catch(() => {});

  // SYNCHRONOUS auth restore (localStorage only — no network): the home shell renders
  // immediately with the correct signed-in/out state for every ordinary load. The one
  // async case — returning from Google with `?code=` — paints the identity region in its
  // reserved "signing you in" state and settles in place when the exchange finishes
  // (the menu listens on auth.onChange); the shell never waits on the network.
  if (auth) auth.restoreLocal();

  // Give the pixel fonts a short head start before the title paints: DOM text set in a
  // fallback font reflows (layout shift) when the web font lands. Cached fonts win the
  // race instantly; a cold/offline fetch never delays the menu past the cap.
  await Promise.race([fontsReady, new Promise((resolve) => setTimeout(resolve, 250))]);

  // Explicit `?gs=<wsUrl>` override: the DIRECT dev/ops join (two-tab local proof, load
  // harness) — no lobby, tickets minted by that server's own /dev-ticket endpoint (dev-auth
  // only, hard-disabled in production). Identity still rides along so names/colors show.
  const gsOverride = resolveGsUrl(window.location.search);
  if (gsOverride && isExplicitGsOverride(window.location.search)) {
    const getTicket = async (): Promise<string> => {
      const params = new URLSearchParams({ playerId: `guest-${Math.random().toString(36).slice(2, 8)}` });
      if (session.name) params.set("name", session.name);
      if (session.colorIndex !== null) params.set("color", String(session.colorIndex));
      const cosmetics = session.cosmetics;
      if (cosmetics.hat !== null) params.set("hat", cosmetics.hat);
      if (cosmetics.face !== null) params.set("face", cosmetics.face);
      const res = await fetch(`${devTicketUrl(gsOverride)}?${params}`);
      if (!res.ok) throw new Error(`ticket endpoint ${res.status}`);
      const data = (await res.json()) as { ticket: string };
      return data.ticket;
    };
    menu.hide();
    game.start({
      mode: "online",
      // Direct dev join: no room, so no expected world / party gate — the dev world is
      // whatever the dev ticket names.
      online: { url: gsOverride, getTicket, roomCode: null, expectedWorldId: null, selfPlayerId: null, party: null },
      profile: null,
      selfColorIndex: session.colorIndex,
      selfCosmetics: session.cosmetics,
    });
    return;
  }

  // An invite URL that carries NO joinable code — mangled grammar, or any invite on a
  // build with no backend. Resolved immediately: the URL is consumed and the player lands
  // on an honest interactive screen (never a guessed join, never a dead end).
  function landUnjoinableInvite(): Promise<void> {
    stripInviteFromLocation();
    if (client) return menu.showOnlineHome(INVITE_INVALID_NOTE).then(() => undefined);
    return menu.showTitle(undefined, INVITE_OFFLINE_NOTE);
  }

  // Warm invite arrivals: the app is already open and a history navigation lands on an
  // invite URL — same parse, same validated join as a cold load. Menu-time only (never
  // yanks a live run); openInvite consumes the URL once its attempt resolves.
  window.addEventListener("popstate", () => {
    if (isInRun || !hasInviteIntent(window.location.pathname, window.location.search)) return;
    const inviteCode = parseInviteCode(window.location.pathname, window.location.search);
    if (inviteCode && client) void menu.openInvite(inviteCode);
    else void landUnjoinableInvite();
  });

  // Cold-load room invite (/r/<CODE> or ?room=CODE), beside the ?online=1 / ?gs= routes:
  // the canonical shell renders first, then the join auto-attempts through the same
  // validated path as manual JOIN CODE (Menu.openInvite -> doJoinOnline). The URL is
  // consumed when the attempt resolves — success or failure — so refresh/back never
  // re-triggers a stale join.
  if (hasInviteIntent(window.location.pathname, window.location.search)) {
    const inviteCode = parseInviteCode(window.location.pathname, window.location.search);
    if (inviteCode && client) await menu.openInvite(inviteCode);
    else await landUnjoinableInvite();
    if (auth) void auth.completeOAuth();
    return;
  }

  // `?online=1` deep-links to the online rooms screen (create/join/quick-play). It never
  // auto-joins a world anymore — the lobby is the front door. Without a Convex backend the
  // link degrades to the plain title (online play needs the ticket minter).
  if (gsOverride && client) {
    await menu.showOnlineHome();
    if (auth) void auth.completeOAuth();
    return;
  }

  void menu.showTitle();
  // Menu-only, boot-only "What's New": a returning player on a new build gets ONE popup;
  // a brand-new player is caught up silently. Never on an invite/deep-join path (those
  // return above), never mid-run — and it never blocks or delays Play.
  menu.maybeShowChangelogPopup();
  // The pending-OAuth exchange (rare: only right after returning from Google) runs AFTER
  // the shell painted; the identity region settles in place via auth.onChange.
  if (auth) void auth.completeOAuth();
}
