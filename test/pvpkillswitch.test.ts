// TEMP PVP KILL SWITCH — source-of-truth + typed-error + defense-wiring suite.
//
// The kill switch is defense-in-depth across five layers (client UI, client entry guards,
// Convex mutations, the Convex ticket mint, and the game server). This suite locks the parts
// that guarantee it fails CLOSED, stays coordinated, and surfaces a TYPED, CLIENT-VISIBLE error:
//   1. FAIL-CLOSED resolver — only the boolean literal `true` enables PVP; missing/false is OFF
//   2. ONE coordinated policy — the src flag and the Convex mirror agree (value, code, copy)
//   3. BACKEND typed error — the Convex guard throws a TAGGED ConvexError whose structured
//      { code, message } data survives the RPC boundary (a plain Error would be redacted to a
//      generic "[Request ID …] Server Error" in prod — the exact contract bug the TD caught)
//   4. CLIENT normalization — every pvp_disabled shape (real ConvexError, tagged object, local
//      preflight, WS frame) normalizes to the exact clean copy; a generic error is NOT
//      misclassified and never leaks transport framing
//   5. WIRING — each Convex entry point (create/quickPlay/join, guarding BEFORE db writes), the
//      ticket mint, and the game-server join path actually invoke the guard
//
// The per-layer BEHAVIOR is proven elsewhere: client UI + entry guards in menu.test.ts /
// onlinelobby.test.ts; the game-server reject in server/test/pvpdisabled.test.ts.
// Run: npm run test:pvpkillswitch

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConvexError } from "convex/values";

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
} from "../convex/pvpFlag.js";
import { normalizeOnlineError } from "../src/net/onlineError.js";

const CONVEX_ERROR_TAG = Symbol.for("ConvexError");
const CLEAN_COPY = "Arena is temporarily offline for a patch";

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
function hasConvexTag(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { [k: symbol]: boolean })[CONVEX_ERROR_TAG] === true;
}
function sameData(v: unknown, expected: { code: string; message: string }): boolean {
  return v instanceof ConvexError && JSON.stringify(v.data) === JSON.stringify(expected);
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

section("BACKEND typed error: the Convex guard throws a TAGGED ConvexError that survives the RPC boundary");
{
  // This is the crux of the pre-merge contract bug the TD caught: a plain `throw new Error(...)`
  // is redacted by Convex in production (the client sees "[Request ID …] Server Error", message
  // stripped). Only a ConvexError's structured `.data` is delivered to the client verbatim.
  const e = thrown(() => cvxAssert("pvp"));
  check("the backend guard throws", e !== null);
  check("...a real ConvexError (NOT a plain custom Error subclass)", e instanceof ConvexError);
  check("...an Error subtype whose name marshals as 'ConvexError'", e instanceof Error && e.name === "ConvexError");
  check("...carrying the Symbol.for('ConvexError') runtime tag the SDK uses to identify it", hasConvexTag(e));
  check("...with EXACTLY { code:'pvp_disabled', message:'Arena is temporarily offline for a patch' }",
    sameData(e, { code: "pvp_disabled", message: CLEAN_COPY }));
  check("the backend guard NEVER rejects co-op (contract unchanged)", thrown(() => cvxAssert("coop")) === null);
  check("the backend guard NEVER rejects an absent (defaulted co-op) mode", thrown(() => cvxAssert(undefined)) === null);
}

section("CLIENT preflight: the local (pre-RPC) guard throws the typed PvpDisabledError; co-op passes");
{
  // The client entry guard rejects BEFORE a request leaves the browser; it is deliberately a
  // local Error subclass (never crosses RPC), distinct from the backend ConvexError.
  const e = thrown(() => srcAssert("pvp"));
  check("the client preflight guard throws a local PvpDisabledError", e instanceof SrcPvpDisabledError);
  check("...it is NOT a ConvexError (distinct from the backend type)", !(e instanceof ConvexError) && !hasConvexTag(e));
  check("...carrying the pvp_disabled code", e instanceof SrcPvpDisabledError && e.code === "pvp_disabled");
  check("...and the clean player-facing message", e instanceof Error && e.message === CLEAN_COPY);
  check("client preflight NEVER rejects co-op", thrown(() => srcAssert("coop")) === null);
  check("client preflight NEVER rejects an absent (defaulted co-op) mode", thrown(() => srcAssert(undefined)) === null);
}

section("CLIENT normalization: every pvp_disabled shape -> the exact clean copy; generic errors are NOT misclassified");
{
  // 1. The ACTUAL Convex SDK boundary object: a tagged ConvexError instance carrying .data.
  const conv = normalizeOnlineError(new ConvexError({ code: "pvp_disabled", message: CLEAN_COPY }), "fallback");
  check("a real ConvexError normalizes to code pvp_disabled", conv.code === "pvp_disabled");
  check("...and to ONLY the exact clean copy (no Uncaught/JSON/request-id)", conv.message === CLEAN_COPY);

  // 2. A structurally-tagged object (defensive: same runtime tag on a plain object, cross-realm).
  const tagged = normalizeOnlineError({ [CONVEX_ERROR_TAG]: true, data: { code: "pvp_disabled", message: CLEAN_COPY } }, "fallback");
  check("a tagged ConvexError-shaped object normalizes identically", tagged.code === "pvp_disabled" && tagged.message === CLEAN_COPY);

  // 3. The local client-preflight error.
  const pre = normalizeOnlineError(new SrcPvpDisabledError(), "fallback");
  check("the local preflight PvpDisabledError normalizes identically", pre.code === "pvp_disabled" && pre.message === CLEAN_COPY);

  // 4. A game-server WS error frame { t:'error', code, msg }.
  const frame = normalizeOnlineError({ t: "error", code: "pvp_disabled", msg: CLEAN_COPY }, "fallback");
  check("a game-server WS error frame normalizes identically", frame.code === "pvp_disabled" && frame.message === CLEAN_COPY);

  // 5. A generic/redacted production server error must NOT be misclassified as pvp_disabled, and
  //    must NEVER surface transport framing (request id / brackets / Uncaught / JSON).
  const generic = normalizeOnlineError(new Error("[CONVEX M(rooms:create)] [Request ID: abc123] Server Error"), "could not create room");
  check("a generic server error is NOT classified as pvp_disabled", generic.code === null);
  check("...and never leaks request-id / bracket / Uncaught / JSON framing", !/pvp_disabled|Request ID|Uncaught|[[\]{}]/i.test(generic.message), generic.message);

  // 6. An ordinary rooms error keeps ordinary cleaning (dev path), code null — never a pvp code.
  const full = normalizeOnlineError(new Error("that room is full"), "could not join");
  check("an ordinary error message is preserved with code null", full.code === null && full.message === "that room is full");

  // 7. Unknown junk falls back cleanly with no code.
  const junk = normalizeOnlineError(undefined, "could not do that");
  check("unknown junk -> fallback, code null", junk.code === null && junk.message === "could not do that");
}

section("BACKEND source: the guard throws ConvexError with structured data (NOT a custom Error subclass)");
{
  const cvxFlag = src("convex/pvpFlag.ts");
  check("convex/pvpFlag.ts imports the tagged ConvexError from convex/values", /import \{ ConvexError \} from "convex\/values"/.test(cvxFlag));
  check("the guard throws new ConvexError with the structured { code, message } data", /throw new ConvexError\(PVP_DISABLED_DATA\)/.test(cvxFlag));
  check("PVP_DISABLED_DATA is exactly { code, message }", /PVP_DISABLED_DATA[^\n]*=\s*\{ code: PVP_DISABLED_CODE, message: PVP_DISABLED_MESSAGE \}/.test(cvxFlag));
  check("convex/pvpFlag.ts no longer declares a plain custom Error subclass (the caught bug)", !/class\s+\w*Error\s+extends\s+Error/.test(cvxFlag));
}

section("WIRING: every backend + server layer actually invokes the guard, and the mutations reject BEFORE db writes");
{
  const rooms = src("convex/rooms.ts");
  check("convex/rooms.ts imports the guard from the single flag module", /assertPvpModeAllowed.*from ".\/pvpFlag"/.test(rooms));
  // create + quickPlay guard their `mode` arg; join guards the EXISTING room's mode.
  check("convex rooms.create invokes assertPvpModeAllowed(mode)", /assertPvpModeAllowed\(mode\)/.test(rooms));
  check("convex rooms.join guards the existing room's mode (no bypass by an old pvp doc)", /assertPvpModeAllowed\(modeOf\(room\)\)/.test(rooms));
  const guardCount = (rooms.match(/assertPvpModeAllowed\(/g) ?? []).length;
  check("convex rooms guards all three entry points (create + quickPlay + join)", guardCount >= 3, `guards=${guardCount}`);
  // create + quickPlay reject before resolving the authenticated player row.
  const guardBeforeCallerResolution = (rooms.match(/assertPvpModeAllowed\(mode\);[\s\S]{0,320}?resolveRoomCaller\(/g) ?? []).length;
  check("create + quickPlay reject before authenticated caller resolution",
    guardBeforeCallerResolution === 2, `matches=${guardBeforeCallerResolution}`);
  // join rejects the existing pvp doc BEFORE any presence/patch write.
  const joinGuardIdx = rooms.indexOf("assertPvpModeAllowed(modeOf(room))");
  const joinWriteIdx = rooms.indexOf("ensurePresence(ctx, room._id", joinGuardIdx >= 0 ? joinGuardIdx : 0);
  check("join rejects an existing pvp doc BEFORE its presence write", joinGuardIdx !== -1 && joinWriteIdx > joinGuardIdx, `guard=${joinGuardIdx} write=${joinWriteIdx}`);

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
