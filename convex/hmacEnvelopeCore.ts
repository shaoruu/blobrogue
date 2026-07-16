import { decodeCanonicalBase64Url } from "../src/net/base64url.js";

const MAX_ENVELOPE_LENGTH = 16 * 1024;
const MAX_PAYLOAD_SEGMENT_LENGTH = 12 * 1024;
const HMAC_SHA256_BYTES = 32;
const HMAC_SHA256_BASE64URL_LENGTH = 43;

export async function verifyHmacEnvelope(
  secret: string,
  envelope: string,
  prefix: string,
): Promise<Uint8Array | null> {
  if (envelope.length === 0 || envelope.length > MAX_ENVELOPE_LENGTH) return null;
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const payloadBytes = decodeCanonicalBase64Url(parts[1], {
    maxEncodedLength: MAX_PAYLOAD_SEGMENT_LENGTH,
    isNonEmpty: true,
  });
  const signatureBytes = decodeCanonicalBase64Url(parts[2], {
    maxEncodedLength: HMAC_SHA256_BASE64URL_LENGTH,
    isNonEmpty: true,
    exactEncodedLength: HMAC_SHA256_BASE64URL_LENGTH,
    exactDecodedLength: HMAC_SHA256_BYTES,
  });
  if (!payloadBytes || !signatureBytes) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const isSignatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signatureBytes).buffer,
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  return isSignatureValid ? payloadBytes : null;
}
