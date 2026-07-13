// TEMPORARY PRODUCTION KILL SWITCH (Convex mirror) — PVP / ARENA is offline until Patch 0.
//
// Byte-mirror of src/net/pvpFlag.ts for the Convex runtime, which cannot import app code (it
// bundles in isolation — the same reason gsTicketCore.ts duplicates the world-id mapping).
// test/pvpkillswitch.test.ts locks the flag value, the code, and the copy to the src module.
// See src/net/pvpFlag.ts for the full rationale and the two-sided re-enable step.
//
// This is the BACKEND source of truth, enforced independently of the client UI: rooms.create /
// rooms.quickPlay / rooms.join and gsTicket.mint all guard on it, so a stale/older client with
// a cached bundle can never create or join a PVP room while disabled.

export const PVP_DISABLED_CODE = "pvp_disabled";
export const PVP_DISABLED_MESSAGE = "Arena is temporarily offline for a patch";

// Fail-closed: only the boolean literal `true` enables PVP; anything else resolves OFF.
export function resolvePvpPublicEnabled(flag: boolean | undefined): boolean {
  return flag === true;
}

// The resolved backend policy. RE-ENABLE = flip to `true` here AND in src/net/pvpFlag.ts,
// then `npx convex deploy` (this guard runs server-side, independent of the client bundle).
export const PVP_PUBLIC_ENABLED: boolean = resolvePvpPublicEnabled(false);

// The typed rejection thrown by the Convex PVP entry points. Its message is the clean
// player-facing copy (surfaced by even a stale client), its `code` the stable machine token.
export class PvpDisabledError extends Error {
  readonly code = PVP_DISABLED_CODE;
  constructor() {
    super(PVP_DISABLED_MESSAGE);
    this.name = "PvpDisabledError";
  }
}

// The single backend guard: reject a pvp action while disabled, pass co-op through untouched.
// Called at the top of every PVP-capable mutation/action so each path rejects independently
// (an existing pvp room doc never bypasses it — join derives the mode from the room and guards).
export function assertPvpModeAllowed(mode: "coop" | "pvp" | undefined): void {
  if (mode === "pvp" && !PVP_PUBLIC_ENABLED) throw new PvpDisabledError();
}
