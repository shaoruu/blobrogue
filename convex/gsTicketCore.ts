// The game-server auth-ticket MINT, as pure logic on Web Crypto (no Node Buffer/btoa), so it
// runs inside the Convex default runtime AND can be imported directly by the server's
// agreement test. The format MUST match server/src/auth.ts verifyTicket byte-for-byte:
//
//   ticket  = "v1." + b64url(utf8(JSON.stringify(payload))) + "." + b64url(sig)
//   payload = { pid, exp } plus OPTIONAL identity/room claims appended in a FIXED order:
//             wld (authorized world id), nm (display name), cl (party color index),
//             ht (cosmetic hat id), fc (cosmetic face id), kt (chosen kit id),
//             ml (account mastery level).
//             JSON.stringify preserves insertion order, so both mints build the object in
//             exactly this order — that is what keeps the two implementations byte-identical.
//   sig     = HMAC-SHA256(secret, "v1." + b64url(payload))     (signed over the BODY string)
//   b64url  = base64 with '+'->'-', '/'->'_', padding stripped
//
// verifyTicket re-signs the received body (it never re-serializes the payload), so the only
// bytes that must agree are this exact assembly — which server/test/ticket.test.ts locks by
// asserting mintGsTicket === the server's own mintTicket for identical inputs (with and
// without the optional claims).
//
// The wld claim is what makes a room private: the ticket is minted by Convex ONLY after the
// player proved room membership (see convex/gsTicket.ts), and the game server binds the
// connection to exactly the world the ticket names — a client can never assert a world id.

export interface GsTicketPayload {
  pid: string;  // authenticated playerId
  exp: number;  // unix seconds expiry
  wld?: string; // authorized world id (absent -> the default/public world)
  nm?: string;  // display name shown to other players
  cl?: number;  // party color index (name label / minimap identity tint)
  ht?: string;  // cosmetic hat id (visual-only; see convex/cosmeticsCore.ts)
  fc?: string;  // cosmetic face id (visual-only)
  kt?: string;  // chosen KIT id (validated at mint against the account's Mastery unlocks)
  ml?: number;  // account MASTERY level (the game server re-gates kt against it)
  pt?: string;  // cosmetic companion pet id (visual-only; see src/sim/camp_nodes.ts)
}

// Optional identity/room claims for a mint. Field names are the long-form of the wire keys.
export interface GsTicketClaims {
  worldId?: string;
  name?: string;
  colorIndex?: number;
  hat?: string;
  face?: string;
  kit?: string;
  masteryLevel?: number;
  pet?: string;
}

// The single room-code -> authoritative-world-id mapping. Convex mints with it; the game
// server just binds whatever verified world id the ticket carries.
export function worldIdForRoomCode(code: string): string {
  return "room:" + code.trim().toUpperCase();
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64urlFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (hasB1) out += B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (hasB2) out += B64_ALPHABET[b2 & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

// Mint a signed ticket valid for ttlSecs. Deterministic w.r.t. nowMs so the agreement test can
// assert byte equality against the server's Node-crypto mint. Claims append in the FIXED key
// order pid, exp, wld, nm, cl, ht, fc, kt, ml, pt — the byte contract with server/src/auth.ts mintTicket.
export async function mintGsTicket(
  secret: string,
  playerId: string,
  ttlSecs = 120,
  nowMs = Date.now(),
  claims: GsTicketClaims = {},
): Promise<string> {
  const payload: GsTicketPayload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSecs };
  if (claims.worldId !== undefined) payload.wld = claims.worldId;
  if (claims.name !== undefined) payload.nm = claims.name;
  if (claims.colorIndex !== undefined) payload.cl = claims.colorIndex;
  if (claims.hat !== undefined) payload.ht = claims.hat;
  if (claims.face !== undefined) payload.fc = claims.face;
  if (claims.kit !== undefined) payload.kt = claims.kit;
  if (claims.masteryLevel !== undefined) payload.ml = claims.masteryLevel;
  if (claims.pet !== undefined) payload.pt = claims.pet;
  const enc = new TextEncoder();
  const body = "v1." + b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + b64urlFromBytes(sig);
}
