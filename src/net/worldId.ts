// The pure, dependency-free world-id helpers shared by the client, the game server (ticket
// verifier), and the tests. Deliberately isolated from protocol.ts's wire code — which pulls
// in the whole authoritative sim (world.ts) — so the online lobby can reference the
// room -> world mapping without dragging the simulation onto the menu's critical path.

// World ids are minter-controlled but still bounded/charset-checked so a compromised minter
// can't inject log-breaking or unbounded ids ("room:ABCD", "arena-1", ...). Shared by the
// ticket verifier (server), the snapshot decoder (client), and the dev mint endpoint.
const WORLD_ID_RE = /^[a-zA-Z0-9:_-]{1,40}$/;

export function isValidWorldId(id: string): boolean {
  return WORLD_ID_RE.test(id);
}

// The single room-code -> authoritative-world-id mapping the CLIENT and SERVER share. The
// Convex minter keeps its own copy (convex/gsTicketCore.ts must stay import-free of app
// code for bundling); server/test/ticket.test.ts locks the two to byte agreement.
export function worldIdForRoomCode(code: string): string {
  return "room:" + code.trim().toUpperCase();
}
