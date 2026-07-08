// The game-server auth-ticket MINT, as pure logic on Web Crypto (no Node Buffer/btoa), so it
// runs inside the Convex default runtime AND can be imported directly by the server's
// agreement test. The format MUST match server/src/auth.ts verifyTicket byte-for-byte:
//
//   ticket  = "v1." + b64url(utf8(JSON.stringify({ pid, exp }))) + "." + b64url(sig)
//   sig     = HMAC-SHA256(secret, "v1." + b64url(payload))     (signed over the BODY string)
//   b64url  = base64 with '+'->'-', '/'->'_', padding stripped
//
// verifyTicket re-signs the received body (it never re-serializes the payload), so the only
// bytes that must agree are this exact assembly — which server/test/ticket.test.ts locks by
// asserting mintGsTicket === the server's own mintTicket for identical inputs.

export interface GsTicketPayload {
  pid: string; // authenticated playerId
  exp: number; // unix seconds expiry
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
// assert byte equality against the server's Node-crypto mint.
export async function mintGsTicket(secret: string, playerId: string, ttlSecs = 120, nowMs = Date.now()): Promise<string> {
  const payload: GsTicketPayload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSecs };
  const enc = new TextEncoder();
  const body = "v1." + b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + b64urlFromBytes(sig);
}
