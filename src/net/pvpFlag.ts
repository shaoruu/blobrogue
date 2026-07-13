// TEMPORARY PRODUCTION KILL SWITCH — PVP / ARENA is offline until the server-side Patch 0 lands.
//
// This module is the ONE authoritative source of truth for the CLIENT and the GAME SERVER
// (both import it directly). Convex cannot import app code — its runtime bundles in isolation —
// so convex/pvpFlag.ts carries a byte-mirror of the same policy, and test/pvpkillswitch.test.ts
// locks the two to agreement. Re-enabling PVP is therefore ONE deliberate flip on each side
// (never a scatter of drifting uncoordinated booleans).
//
// FAIL CLOSED: resolvePvpPublicEnabled treats anything other than the boolean literal `true`
// (a missing/undefined source, an accidental `false`) as OFF. The exported constant is the
// resolved policy, and every consumer guards as "reject unless explicitly enabled".
//
// RE-ENABLE STEP (both sides, in one reviewed change):
//   1. flip the literal below to `true`
//   2. flip PVP_PUBLIC_ENABLED in convex/pvpFlag.ts to `true`
//   3. ship the client bundle AND run `npx convex deploy` (the backend guard is independent)

// The stable machine code + the exact player-facing copy for a blocked PVP action. Shared so
// the UI, the client entry guards, the game-server reject frame, and the Convex mirror can
// never disagree on either string.
export const PVP_DISABLED_CODE = "pvp_disabled";
export const PVP_DISABLED_MESSAGE = "Arena is temporarily offline for a patch";

// Fail-closed resolution: only the boolean literal `true` enables PVP; a missing/undefined
// source resolves OFF. Kept pure + exported so the fail-closed behavior is unit-testable.
export function resolvePvpPublicEnabled(flag: boolean | undefined): boolean {
  return flag === true;
}

// The resolved policy. Typed `boolean` (not the literal) so every consumer's guard type-checks
// under either setting without tsc flagging a constant condition.
export const PVP_PUBLIC_ENABLED: boolean = resolvePvpPublicEnabled(false);

// The CLIENT-SIDE PREFLIGHT rejection: thrown locally by the OnlineLobby entry guards before a
// pvp request ever leaves the browser. It never crosses an RPC boundary — that is the BACKEND's
// job, and the backend deliberately uses a tagged ConvexError instead (convex/pvpFlag.ts), whose
// structured `.data` survives Convex's production error redaction where a plain Error would not.
// Both funnel through the same normalizer (src/net/onlineError.ts) to the identical clean copy.
export class PvpDisabledError extends Error {
  readonly code = PVP_DISABLED_CODE;
  constructor() {
    super(PVP_DISABLED_MESSAGE);
    this.name = "PvpDisabledError";
  }
}

// The single client-side guard used at every OnlineLobby PVP entry: reject a pvp action while
// disabled, pass co-op (and any non-pvp mode) through untouched. Pure so it is trivially
// unit-testable and so the co-op path provably never changes. (The game server enforces the
// same policy via config.pvpPublicEnabled; the Convex backend via convex/pvpFlag.ts.)
export function assertPvpModeAllowed(mode: "coop" | "pvp" | undefined): void {
  if (mode === "pvp" && !PVP_PUBLIC_ENABLED) throw new PvpDisabledError();
}
