// TEMPORARY PRODUCTION KILL SWITCH (Convex mirror) — PVP / ARENA is offline until Patch 0.
//
// Byte-mirror of the flag policy in src/net/pvpFlag.ts for the Convex runtime, which cannot
// import app code (it bundles in isolation — the same reason gsTicketCore.ts duplicates the
// world-id mapping). test/pvpkillswitch.test.ts locks the flag value, the code, and the copy
// to the src module. See src/net/pvpFlag.ts for the full rationale and the two-sided re-enable.
//
// This is the BACKEND source of truth, enforced independently of the client UI: rooms.create /
// rooms.quickPlay / rooms.join and gsTicket.mint all guard on it, so a stale/older client with
// a cached bundle can never create or join a PVP room while disabled.
//
// TYPED CLIENT-VISIBLE ERROR — we throw ConvexError, NOT a plain Error. Convex delivers
// ConvexError.data to the client verbatim (dev AND prod), whereas an ordinary thrown Error is
// redacted in production to a generic "[Request ID: ...] Server Error" with the message stripped
// — exactly the failure this kill switch must avoid. The { code, message } payload lets the
// client normalize to the clean copy (see src/net/onlineError.ts).

import { ConvexError } from "convex/values";

export const PVP_DISABLED_CODE = "pvp_disabled";
export const PVP_DISABLED_MESSAGE = "Arena is temporarily offline for a patch";

// The exact structured shape carried across the Convex client boundary for a blocked PVP action.
// A `type` (not an `interface`) so it satisfies ConvexError's `Value` (index-signature) bound.
export type PvpDisabledData = {
  code: typeof PVP_DISABLED_CODE;
  message: typeof PVP_DISABLED_MESSAGE;
};

export const PVP_DISABLED_DATA: PvpDisabledData = { code: PVP_DISABLED_CODE, message: PVP_DISABLED_MESSAGE };

// Fail-closed: only the boolean literal `true` enables PVP; anything else resolves OFF.
export function resolvePvpPublicEnabled(flag: boolean | undefined): boolean {
  return flag === true;
}

// The resolved backend policy. RE-ENABLE = flip to `true` here AND in src/net/pvpFlag.ts,
// then `npx convex deploy` (this guard runs server-side, independent of the client bundle).
export const PVP_PUBLIC_ENABLED: boolean = resolvePvpPublicEnabled(false);

// The single backend guard: reject a pvp action while disabled with a TAGGED ConvexError whose
// structured data survives the RPC boundary; pass co-op through untouched. Called at the top of
// every PVP-capable mutation/action so each path rejects independently (an existing pvp room doc
// never bypasses it — join derives the mode from the room and guards on it).
export function assertPvpModeAllowed(mode: "coop" | "pvp" | undefined): void {
  if (mode === "pvp" && !PVP_PUBLIC_ENABLED) {
    throw new ConvexError(PVP_DISABLED_DATA);
  }
}
