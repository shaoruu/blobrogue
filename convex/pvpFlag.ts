// Convex mirror of the independent private/public PVP rollout switches. Private is ENABLED;
// public stays dark.
//
// Byte-mirror of the flag policy in src/net/pvpFlag.ts for the Convex runtime, which cannot
// import app code (it bundles in isolation — the same reason gsTicketCore.ts duplicates the
// world-id mapping). test/pvpkillswitch.test.ts locks the flags, codes, and copy to the client
// module. Durable authorization remains the room's canonical pvpPolicy.
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

export const PVP_PUBLIC_DISABLED_CODE = "public_disabled";
export const PVP_PRIVATE_DISABLED_CODE = "private_disabled";
export const PVP_DISABLED_MESSAGE = "Arena is temporarily offline for a patch";

// The exact structured shape carried across the Convex client boundary for a blocked PVP action.
// A `type` (not an `interface`) so it satisfies ConvexError's `Value` (index-signature) bound.
export type PvpDisabledData = {
  code: typeof PVP_PUBLIC_DISABLED_CODE | typeof PVP_PRIVATE_DISABLED_CODE;
  message: typeof PVP_DISABLED_MESSAGE;
};

// Fail-closed: only the boolean literal `true` enables PVP; anything else resolves OFF.
export function resolvePvpPublicEnabled(flag: boolean | undefined): boolean {
  return flag === true;
}

// Independent backend rollout guards. A later enable requires coordinated client/Convex/GS work.
export const PVP_PUBLIC_ENABLED: boolean = resolvePvpPublicEnabled(false);
export const PVP_PRIVATE_ENABLED: boolean = resolvePvpPublicEnabled(true);

// The single backend guard: reject a pvp action while disabled with a TAGGED ConvexError whose
// structured data survives the RPC boundary; pass co-op through untouched. Called at the top of
// every PVP-capable mutation/action so each path rejects independently (an existing pvp room doc
// never bypasses it — join derives the mode from the room and guards on it).
export function assertPvpAccessAllowed(
  mode: "coop" | "pvp" | undefined,
  access: "private" | "public",
): void {
  if (mode !== "pvp") return;
  const isEnabled = access === "private" ? PVP_PRIVATE_ENABLED : PVP_PUBLIC_ENABLED;
  if (isEnabled) return;
  const code = access === "private" ? PVP_PRIVATE_DISABLED_CODE : PVP_PUBLIC_DISABLED_CODE;
  throw new ConvexError({ code, message: PVP_DISABLED_MESSAGE } satisfies PvpDisabledData);
}
