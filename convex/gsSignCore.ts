// Signed run-result bodies: HMAC-SHA256 over the EXACT raw JSON string, base64url. This one
// module is imported by BOTH sides of the trust boundary — the game server's reporter signs
// with it (Node ships Web Crypto globally) and the Convex HTTP action verifies with it — so
// there is a single implementation and no canonicalization step that could disagree. The
// shared secret is GS_AUTH_SECRET, the same secret that already authenticates join tickets:
// one server<->Convex trust relationship, two message kinds.

// Extension-qualified so the game server's nodenext build can compile this module too
// (Convex's bundler accepts either form).
import { b64urlFromBytes } from "./gsTicketCore.js";

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

export async function signRunBody(secret: string, body: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return b64urlFromBytes(sig);
}

// Constant-time-ish compare: both operands are fixed-length HMAC outputs, and the expected
// side is derived from the secret (never attacker-controlled), so char-wise XOR suffices.
export async function verifyRunBody(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = await signRunBody(secret, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
