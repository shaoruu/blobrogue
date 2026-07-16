const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) return null;
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = B64_ALPHABET.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

export async function verifyHmacEnvelope(
  secret: string,
  envelope: string,
  prefix: string,
): Promise<Uint8Array | null> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const payloadBytes = decodeBase64Url(parts[1]);
  const signatureBytes = decodeBase64Url(parts[2]);
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
