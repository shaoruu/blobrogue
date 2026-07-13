// TEMP PVP KILL SWITCH — source-of-truth + defense-wiring suite.
//
// The kill switch is defense-in-depth across five layers (client UI, client entry guards,
// Convex mutations, the Convex ticket mint, and the game server). This suite locks the parts
// that guarantee it fails CLOSED and stays coordinated:
//   1. FAIL-CLOSED resolver — only the boolean literal `true` enables PVP; missing/false is OFF
//   2. ONE coordinated policy — the src flag and the Convex mirror agree (value, code, copy)
//   3. TYPED rejection — assertPvpModeAllowed throws the exact pvp_disabled code + clean copy
//      for pvp, and passes co-op / undefined through untouched (co-op provably unchanged)
//   4. WIRING — each Convex entry point (create/quickPlay/join), the ticket mint, and the game
//      server join path actually invoke the guard (a defense that isn't wired is no defense)
//
// The per-layer BEHAVIOR is proven elsewhere: client UI + entry guards in menu.test.ts /
// onlinelobby.test.ts; the game-server reject in server/test/pvpdisabled.test.ts.
// Run: npm run test:pvpkillswitch

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PVP_PUBLIC_ENABLED as SRC_ENABLED,
  PVP_DISABLED_CODE as SRC_CODE,
  PVP_DISABLED_MESSAGE as SRC_MSG,
  resolvePvpPublicEnabled as srcResolve,
  assertPvpModeAllowed as srcAssert,
  PvpDisabledError as SrcPvpDisabledError,
} from "../src/net/pvpFlag.js";
import {
  PVP_PUBLIC_ENABLED as CVX_ENABLED,
  PVP_DISABLED_CODE as CVX_CODE,
  PVP_DISABLED_MESSAGE as CVX_MSG,
  resolvePvpPublicEnabled as cvxResolve,
  assertPvpModeAllowed as cvxAssert,
  PvpDisabledError as CvxPvpDisabledError,
} from "../convex/pvpFlag.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function src(rel: string): string { return readFileSync(join(ROOT, rel), "utf8"); }

// Capture whatever a guard throws (or null if it returns).
function thrown(fn: () => void): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

section("FAIL CLOSED: only the boolean literal true enables PVP");
{
  for (const [label, resolve] of [["src", srcResolve], ["convex", cvxResolve]] as const) {
    check(`${label}: missing/undefined source resolves OFF`, resolve(undefined) === false);
    check(`${label}: an explicit false resolves OFF`, resolve(false) === false);
    check(`${label}: only literal true resolves ON`, resolve(true) === true);
  }
  check("the shipped src policy is OFF (containment default)", SRC_ENABLED === false);
  check("the shipped convex policy is OFF (containment default)", CVX_ENABLED === false);
}

section("ONE coordinated policy: the src flag and the Convex mirror agree");
{
  check("PVP_PUBLIC_ENABLED agrees across the two sources", SRC_ENABLED === CVX_ENABLED);
  check("the pvp_disabled code agrees", SRC_CODE === CVX_CODE && SRC_CODE === "pvp_disabled", SRC_CODE);
  check("the clean player-facing copy agrees", SRC_MSG === CVX_MSG && SRC_MSG === "Arena is temporarily offline for a patch", SRC_MSG);
}

section("TYPED rejection: pvp throws the exact code + copy; co-op and undefined pass");
{
  for (const [label, assert, Err] of [
    ["src", srcAssert, SrcPvpDisabledError],
    ["convex", cvxAssert, CvxPvpDisabledError],
  ] as const) {
    const e = thrown(() => assert("pvp"));
    check(`${label}: assertPvpModeAllowed('pvp') throws`, e !== null);
    check(`${label}: it is a typed PvpDisabledError`, e instanceof Err);
    check(`${label}: carrying the pvp_disabled code`, e instanceof Err && e.code === "pvp_disabled");
    check(`${label}: with the clean player-facing message`, e instanceof Error && e.message === "Arena is temporarily offline for a patch");
    check(`${label}: co-op is NEVER rejected (contract unchanged)`, thrown(() => assert("coop")) === null);
    check(`${label}: an absent mode (defaulted co-op) is NEVER rejected`, thrown(() => assert(undefined)) === null);
  }
}

section("WIRING: every backend + server layer actually invokes the guard");
{
  const rooms = src("convex/rooms.ts");
  check("convex/rooms.ts imports the guard from the single flag module", /assertPvpModeAllowed.*from ".\/pvpFlag"/.test(rooms));
  // create + quickPlay guard their `mode` arg; join guards the EXISTING room's mode.
  check("convex rooms.create invokes assertPvpModeAllowed(mode)", /assertPvpModeAllowed\(mode\)/.test(rooms));
  check("convex rooms.join guards the existing room's mode (no bypass by an old pvp doc)", /assertPvpModeAllowed\(modeOf\(room\)\)/.test(rooms));
  const guardCount = (rooms.match(/assertPvpModeAllowed\(/g) ?? []).length;
  check("convex rooms guards all three entry points (create + quickPlay + join)", guardCount >= 3, `guards=${guardCount}`);

  const ticket = src("convex/gsTicket.ts");
  check("convex/gsTicket.ts imports the guard from the single flag module", /assertPvpModeAllowed.*from ".\/pvpFlag"/.test(ticket));
  check("the ticket mint guards the room's mode before binding a world id", /assertPvpModeAllowed\(mode\)/.test(ticket));

  const router = src("server/src/messageRouter.ts");
  check("game server join rejects a pvp world id while disabled", /isPvpWorldId\(worldId\) && !this\.ctx\.config\.pvpPublicEnabled/.test(router));
  check("...with the typed pvp_disabled reject frame (shared code + copy)",
    /reject\(conn, PVP_DISABLED_CODE, PVP_DISABLED_MESSAGE\)/.test(router)
    && /PVP_DISABLED_CODE, PVP_DISABLED_MESSAGE.*from "..\/..\/src\/net\/pvpFlag.js"/.test(router));

  const cfg = src("server/src/config.ts");
  check("game server config defaults pvpPublicEnabled to the single shared source of truth",
    /pvpPublicEnabled: PVP_PUBLIC_ENABLED/.test(cfg)
    && /PVP_PUBLIC_ENABLED.*from "..\/..\/src\/net\/pvpFlag.js"/.test(cfg));
  check("...and is NOT env-configurable (no ops lever that could drift from the shared flag)", !/GS_PVP/.test(cfg));
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
process.stdout.write("\nAll PVP kill-switch source-of-truth + wiring assertions passed.\n");
