import { ConvexClient } from "convex/browser";
import { Game } from "./game/game.js";
import type { RunResult, ExitReason } from "./game/game.js";
import type { ProfileDoc } from "./net/api.js";
import { CONVEX_URL, resolveGsUrl, defaultGsUrl, devTicketUrl, isExplicitGsOverride } from "./net/config.js";
import { Session } from "./net/session.js";
import { AuthClient } from "./net/auth.js";
import { Menu } from "./ui/menu.js";
import { bindUiScale } from "./ui/settings.js";
import type { Multiplayer } from "./net/multiplayer.js";
import type { OnlineLobby } from "./net/onlineLobby.js";

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

  let activeCoop: Multiplayer | null = null;
  let activeOnline: OnlineLobby | null = null;

  async function onGameOver(result: RunResult, isPartyWiped: boolean) {
    const wasCoop = activeCoop !== null;
    if (activeCoop) { activeCoop.leave(); activeCoop = null; }
    // An online room SURVIVES the wipe: the party regroups in the same lobby (the menu's
    // game-over screen reopens the room on a wipe and owns leaving it).
    const online = activeOnline;
    // Snapshot the previous best before recordRun bumps it, so we can celebrate a PB.
    const prevBest = session.profile?.deepestFloor ?? 0;
    const saved = await session.recordRun(result);
    const isNewBest = saved !== null && result.floor > prevBest;
    menu.showGameOver(result, saved ?? session.profile, { wasCoop, isNewBest, online, isPartyWiped });
  }

  function onExit(reason?: ExitReason) {
    if (activeCoop) { activeCoop.leave(); activeCoop = null; }
    // Stepping out of an online run (Esc, or the server was unreachable) lands back in the
    // room lobby, not the title — the run may still be live for friends (REJOIN RUN).
    if (activeOnline && activeOnline.isActive) {
      const note = reason === "connect_failed" ? "couldn't reach the game server \u2014 try again in a moment" : "";
      menu.showOnlineLobby(activeOnline, session.profile, note);
      return;
    }
    activeOnline = null;
    void menu.showTitle();
  }

  function leaveOnlineIfAny() {
    if (activeOnline) { activeOnline.leave(); activeOnline = null; }
  }

  const game = new Game(canvas, minimap, document.body, (result, isPartyWiped) => void onGameOver(result, isPartyWiped), onExit);

  const menu = new Menu(overlay, session, client, auth, {
    startSolo(profile: ProfileDoc | null) {
      activeCoop = null;
      leaveOnlineIfAny();
      menu.hide();
      game.start({ mode: "solo", coop: null, profile, selfColorIndex: session.colorIndex });
    },
    startCoop(mp: Multiplayer, profile: ProfileDoc | null) {
      activeCoop = mp;
      leaveOnlineIfAny();
      menu.hide();
      game.start({ mode: "coop", coop: mp, profile });
    },
    startOnline(lobby: OnlineLobby, profile: ProfileDoc | null) {
      activeCoop = null;
      if (activeOnline && activeOnline !== lobby) activeOnline.leave();
      activeOnline = lobby;
      menu.hide();
      game.start({
        mode: "online",
        online: {
          url: defaultGsUrl(),
          // The lobby mints a Convex ticket bound to THIS room's world id (verified against
          // room membership server-side) — that binding is what puts the party in one world.
          getTicket: () => lobby.mintTicket(),
          roomCode: lobby.code,
        },
        profile,
        selfColorIndex: session.colorIndex,
      });
    },
  });

  // Preload the pixel fonts before any canvas draw — canvas ctx.font silently falls back
  // to a system font if the web font isn't loaded yet at draw time (DOM text reflows on
  // load, canvas does not). Guarantees HUD/GO-DOWN/name labels are pixel from frame 1.
  void Promise.all([
    document.fonts.load('10px "Press Start 2P"'),
    document.fonts.load('700 11px "Silkscreen"'),
    document.fonts.load('16px "VT323"'),
    document.fonts.ready,
  ]).catch(() => {});

  // Complete any pending Google OAuth redirect and attach auth before first render,
  // so the menu shows the correct signed-in/out state immediately (no flicker). Any
  // failure (e.g. auth backend not deployed) is swallowed — the menu still loads.
  if (auth) {
    try { await auth.init(); } catch { /* menu stays usable */ }
  }

  // Explicit `?gs=<wsUrl>` override: the DIRECT dev/ops join (two-tab local proof, load
  // harness) — no lobby, tickets minted by that server's own /dev-ticket endpoint (dev-auth
  // only, hard-disabled in production). Identity still rides along so names/colors show.
  const gsOverride = resolveGsUrl(window.location.search);
  if (gsOverride && isExplicitGsOverride(window.location.search)) {
    const getTicket = async (): Promise<string> => {
      const params = new URLSearchParams({ playerId: `guest-${Math.random().toString(36).slice(2, 8)}` });
      if (session.name) params.set("name", session.name);
      if (session.colorIndex !== null) params.set("color", String(session.colorIndex));
      const res = await fetch(`${devTicketUrl(gsOverride)}?${params}`);
      if (!res.ok) throw new Error(`ticket endpoint ${res.status}`);
      const data = (await res.json()) as { ticket: string };
      return data.ticket;
    };
    menu.hide();
    game.start({ mode: "online", online: { url: gsOverride, getTicket, roomCode: null }, profile: null, selfColorIndex: session.colorIndex });
    return;
  }

  // `?online=1` deep-links to the online rooms screen (create/join/quick-play). It never
  // auto-joins a world anymore — the lobby is the front door. Without a Convex backend the
  // link degrades to the plain title (online play needs the ticket minter).
  if (gsOverride && client) {
    await menu.showOnlineHome();
    return;
  }

  void menu.showTitle();
}
