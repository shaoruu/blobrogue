import { ConvexClient } from "convex/browser";
import { Game } from "./game/game.js";
import type { RunResult } from "./game/game.js";
import type { ProfileDoc } from "./net/api.js";
import { CONVEX_URL } from "./net/config.js";
import { Session } from "./net/session.js";
import { Menu } from "./ui/menu.js";
import type { Multiplayer } from "./net/multiplayer.js";

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
  bootNormal();
}

function bootNormal() {
  // The single online entry point. With no VITE_CONVEX_URL this stays null and the
  // entire multiplayer/identity layer is inert — solo play is unaffected.
  const client = CONVEX_URL ? new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false }) : null;
  const session = new Session(client);

  let activeCoop: Multiplayer | null = null;

  async function onGameOver(result: RunResult) {
    const wasCoop = activeCoop !== null;
    if (activeCoop) { activeCoop.leave(); activeCoop = null; }
    // Snapshot the previous best before recordRun bumps it, so we can celebrate a PB.
    const prevBest = session.profile?.deepestFloor ?? 0;
    const saved = await session.recordRun(result);
    const isNewBest = saved !== null && result.floor > prevBest;
    menu.showGameOver(result, saved ?? session.profile, wasCoop, isNewBest);
  }

  function onExit() {
    if (activeCoop) { activeCoop.leave(); activeCoop = null; }
    void menu.showTitle();
  }

  const game = new Game(canvas, minimap, document.body, (result) => void onGameOver(result), onExit);

  const menu = new Menu(overlay, session, client, {
    startSolo(profile: ProfileDoc | null) {
      activeCoop = null;
      menu.hide();
      game.start({ mode: "solo", coop: null, profile });
    },
    startCoop(mp: Multiplayer, profile: ProfileDoc | null) {
      activeCoop = mp;
      menu.hide();
      game.start({ mode: "coop", coop: mp, profile });
    },
  });

  void menu.showTitle();
}
