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
  PVP_PUBLIC_ENABLED as SRC_PUBLIC_ENABLED,
  PVP_PRIVATE_ENABLED as SRC_PRIVATE_ENABLED,
  PVP_PUBLIC_DISABLED_CODE as SRC_PUBLIC_CODE,
  PVP_PRIVATE_DISABLED_CODE as SRC_PRIVATE_CODE,
  PVP_DISABLED_MESSAGE as SRC_MSG,
  resolvePvpPublicEnabled as srcResolve,
  assertPvpAccessAllowed as srcAssert,
  PvpDisabledError as SrcPvpDisabledError,
} from "../src/net/pvpFlag.js";
import {
  PVP_PUBLIC_ENABLED as CVX_PUBLIC_ENABLED,
  PVP_PRIVATE_ENABLED as CVX_PRIVATE_ENABLED,
  PVP_PUBLIC_DISABLED_CODE as CVX_PUBLIC_CODE,
  PVP_PRIVATE_DISABLED_CODE as CVX_PRIVATE_CODE,
  PVP_DISABLED_MESSAGE as CVX_MSG,
  resolvePvpPublicEnabled as cvxResolve,
  assertPvpAccessAllowed as cvxAssert,
} from "../convex/pvpFlag.js";
import {
  PRIVATE_DRAFT_PVP_POLICY as SRC_POLICY,
  PVP_POLICY_MAX_PLAYERS as SRC_MAX_PLAYERS,
  validatePvpRoomPolicy as srcValidatePolicy,
} from "../src/net/pvpPolicy.js";
import {
  PRIVATE_DRAFT_PVP_POLICY as CVX_POLICY,
  PVP_POLICY_MAX_PLAYERS as CVX_MAX_PLAYERS,
  validatePvpRoomPolicy as cvxValidatePolicy,
} from "../convex/pvpPolicy.js";
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
  check("the shipped src flags are PRIVATE ON / PUBLIC OFF", SRC_PRIVATE_ENABLED === true && SRC_PUBLIC_ENABLED === false);
  check("the shipped Convex flags are PRIVATE ON / PUBLIC OFF", CVX_PRIVATE_ENABLED === true && CVX_PUBLIC_ENABLED === false);
}

section("ONE coordinated policy: the src flag and the Convex mirror agree");
{
  check("private/public rollout flags agree",
    SRC_PUBLIC_ENABLED === CVX_PUBLIC_ENABLED && SRC_PRIVATE_ENABLED === CVX_PRIVATE_ENABLED);
  check("stable disabled codes agree",
    SRC_PUBLIC_CODE === CVX_PUBLIC_CODE
    && SRC_PRIVATE_CODE === CVX_PRIVATE_CODE
    && SRC_PUBLIC_CODE === "public_disabled"
    && SRC_PRIVATE_CODE === "private_disabled");
  check("the clean player-facing copy agrees", SRC_MSG === CVX_MSG && SRC_MSG === "Arena is temporarily offline for a patch", SRC_MSG);
  check("canonical policy and cap agree", SRC_POLICY === CVX_POLICY
    && SRC_POLICY === "private_draft_v1"
    && SRC_MAX_PLAYERS === CVX_MAX_PLAYERS
    && SRC_MAX_PLAYERS === 4);
  check("co-op requires no policy and PVP requires exact private policy",
    srcValidatePolicy("coop", false, null) === null
    && cvxValidatePolicy("coop", false, null) === null
    && srcValidatePolicy("pvp", false, null) === "policy_required"
    && cvxValidatePolicy("pvp", false, "private_draft_v1") === null
    && srcValidatePolicy("pvp", true, "private_draft_v1") === "policy_mismatch");
}

section("BACKEND typed error: the Convex guard throws a TAGGED ConvexError that survives the RPC boundary");
{
  // This is the crux of the pre-merge contract bug the TD caught: a plain `throw new Error(...)`
  // is redacted by Convex in production (the client sees "[Request ID …] Server Error", message
  // stripped). Only a ConvexError's structured `.data` is delivered to the client verbatim.
  check("the backend guard passes private pvp while PRIVATE is ON", thrown(() => cvxAssert("pvp", "private")) === null);
  const e = thrown(() => cvxAssert("pvp", "public"));
  check("the backend guard throws for public pvp while PUBLIC is OFF", e !== null);
  check("...a real ConvexError (NOT a plain custom Error subclass)", e instanceof ConvexError);
  check("...an Error subtype whose name marshals as 'ConvexError'", e instanceof Error && e.name === "ConvexError");
  check("...carrying the Symbol.for('ConvexError') runtime tag the SDK uses to identify it", hasConvexTag(e));
  check("public intent uses its independent code",
    sameData(e, { code: "public_disabled", message: CLEAN_COPY }));
  check("the backend guard NEVER rejects co-op", thrown(() => cvxAssert("coop", "private")) === null);
  check("the backend guard NEVER rejects absent/default co-op", thrown(() => cvxAssert(undefined, "public")) === null);
}

section("CLIENT preflight: the local (pre-RPC) guard throws the typed PvpDisabledError; co-op passes");
{
  // The client entry guard rejects BEFORE a request leaves the browser; it is deliberately a
  // local Error subclass (never crosses RPC), distinct from the backend ConvexError.
  check("the client preflight guard passes private pvp while PRIVATE is ON", thrown(() => srcAssert("pvp", "private")) === null);
  const e = thrown(() => srcAssert("pvp", "public"));
  check("the client preflight guard throws a local PvpDisabledError for public pvp", e instanceof SrcPvpDisabledError);
  check("...it is NOT a ConvexError (distinct from the backend type)", !(e instanceof ConvexError) && !hasConvexTag(e));
  check("...carrying the public_disabled code", e instanceof SrcPvpDisabledError && e.code === "public_disabled");
  check("...and the clean player-facing message", e instanceof Error && e.message === CLEAN_COPY);
  check("client preflight NEVER rejects co-op", thrown(() => srcAssert("coop", "private")) === null);
  check("client preflight NEVER rejects absent/default co-op", thrown(() => srcAssert(undefined, "public")) === null);
}

section("CLIENT normalization: every pvp_disabled shape -> the exact clean copy; generic errors are NOT misclassified");
{
  // 1. The ACTUAL Convex SDK boundary object: a tagged ConvexError instance carrying .data.
  const conv = normalizeOnlineError(new ConvexError({ code: "private_disabled", message: CLEAN_COPY }), "fallback");
  check("a real ConvexError normalizes to code private_disabled", conv.code === "private_disabled");
  check("...and to ONLY the exact clean copy (no Uncaught/JSON/request-id)", conv.message === CLEAN_COPY);

  // 2. A structurally-tagged object (defensive: same runtime tag on a plain object, cross-realm).
  const tagged = normalizeOnlineError({ [CONVEX_ERROR_TAG]: true, data: { code: "private_disabled", message: CLEAN_COPY } }, "fallback");
  check("a tagged ConvexError-shaped object normalizes identically", tagged.code === "private_disabled" && tagged.message === CLEAN_COPY);

  // 3. The local client-preflight error.
  const pre = normalizeOnlineError(new SrcPvpDisabledError("private"), "fallback");
  check("the local preflight PvpDisabledError normalizes identically", pre.code === "private_disabled" && pre.message === CLEAN_COPY);

  // 4. A game-server WS error frame { t:'error', code, msg }.
  const frame = normalizeOnlineError({ t: "error", code: "private_disabled", msg: CLEAN_COPY }, "fallback");
  check("a game-server WS error frame normalizes identically", frame.code === "private_disabled" && frame.message === CLEAN_COPY);

  // 5. A generic/redacted production server error must NOT be misclassified as pvp_disabled, and
  //    must NEVER surface transport framing (request id / brackets / Uncaught / JSON).
  const generic = normalizeOnlineError(new Error("[CONVEX M(rooms:create)] [Request ID: abc123] Server Error"), "could not create room");
  check("a generic server error is NOT classified as a PVP policy error", generic.code === null);
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
  check("the guard throws new ConvexError with structured code + message",
    /throw new ConvexError\(\{ code, message: PVP_DISABLED_MESSAGE \}/.test(cvxFlag));
  check("convex/pvpFlag.ts no longer declares a plain custom Error subclass (the caught bug)", !/class\s+\w*Error\s+extends\s+Error/.test(cvxFlag));
}

section("WIRING: every backend + server layer actually invokes the guard, and the mutations reject BEFORE db writes");
{
  const rooms = src("convex/rooms.ts");
  check("Convex rooms imports policy and independent access guards",
    /assertPvpAccessAllowed/.test(rooms) && /validatePvpRoomPolicy/.test(rooms));
  const createArgs = rooms.slice(
    rooms.indexOf("export const create"),
    rooms.indexOf("handler:", rooms.indexOf("export const create")),
  );
  check("private create policy is selected by Convex, never accepted as an argument",
    /privatePolicyForCreate\(roomKind, roomMode\)/.test(rooms)
    && !createArgs.includes("pvpPolicy"));
  check("public quick play uses the public rollout guard",
    /assertPvpAccessAllowed\(wantMode, "public"\)/.test(rooms));
  const joinGuardIdx = rooms.indexOf("const pvpPolicy = assertRoomPolicy(room)");
  const joinWriteIdx = rooms.indexOf("ensurePresence(ctx, room._id", joinGuardIdx >= 0 ? joinGuardIdx : 0);
  check("join validates durable policy BEFORE its presence write",
    joinGuardIdx !== -1 && joinWriteIdx > joinGuardIdx, `guard=${joinGuardIdx} write=${joinWriteIdx}`);

  const ticket = src("convex/gsTicket.ts");
  check("PVP mint selects the v2 policy-bound minter",
    /mintPvpGsTicket/.test(ticket) && /snapshot\.pvpPolicy/.test(ticket));

  const router = src("server/src/messageRouter.ts");
  check("game server requires signed PVP policy before room creation",
    /auth\.pvpPolicy === undefined/.test(router) && /"policy_required"/.test(router));
  check("game server checks private/public flags independently",
    /pvpPrivateEnabled/.test(router) && /pvpPublicEnabled/.test(router));
  check("existing world policy mismatch rejects before bind",
    /existingRoom\.pvpPolicy !== pvpPolicy/.test(router));

  const cfg = src("server/src/config.ts");
  check("game server config defaults both rollout flags to shared sources",
    /pvpPublicEnabled: PVP_PUBLIC_ENABLED/.test(cfg)
    && /pvpPrivateEnabled: PVP_PRIVATE_ENABLED/.test(cfg));
  check("...and is NOT env-configurable (no ops lever that could drift from the shared flag)", !/GS_PVP/.test(cfg));
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
process.stdout.write("\nAll PVP kill-switch source-of-truth + wiring assertions passed.\n");
