import { createHmac, timingSafeEqual } from "node:crypto";

import { decodeCanonicalBase64Url } from "../../src/net/base64url.js";
import { isStrictJsonObject } from "../../src/net/strictJson.js";
import { isValidWorldId } from "../../src/net/worldId.js";

export type ControlWorldAction =
  | { action: "warp"; worldId: string; floor: number }
  | { action: "force-open-exit"; worldId: string };

export const MAX_CONTROL_FLOOR = 1000;

interface ControlActionClaims {
  action: "warp" | "force-open-exit";
  worldId: string;
  floor?: number;
  iat: number;
  exp: number;
  jti: string;
}

export type ControlAuthResult =
  | { isValid: true; action: ControlWorldAction; jti: string; exp: number }
  | { isValid: false };

export function verifyControlWorldAction(
  secret: string | null,
  authorization: string | undefined,
  action: ControlWorldAction,
  nowMs = Date.now(),
): ControlAuthResult {
  if (secret === null || authorization === undefined || !authorization.startsWith("Bearer ")) {
    return { isValid: false };
  }
  const token = authorization.slice(7);
  if (token.length < 1 || token.length > 512) return { isValid: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "brc1") return { isValid: false };
  const payloadBytes = decodeCanonicalBase64Url(parts[1], {
    maxEncodedLength: 400,
    isNonEmpty: true,
  });
  const signatureBytes = decodeCanonicalBase64Url(parts[2], {
    maxEncodedLength: 43,
    isNonEmpty: true,
    exactEncodedLength: 43,
    exactDecodedLength: 32,
  });
  if (payloadBytes === null || signatureBytes === null) return { isValid: false };
  const expected = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  if (expected.length !== signatureBytes.length || !timingSafeEqual(expected, signatureBytes)) {
    return { isValid: false };
  }

  let payloadText: string;
  let claims: ControlActionClaims;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    if (!isStrictJsonObject(payloadText)) return { isValid: false };
    claims = JSON.parse(payloadText) as ControlActionClaims;
  } catch {
    return { isValid: false };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (!isValidWorldId(claims.worldId)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.iat > nowSec + 5
    || claims.exp <= nowSec
    || claims.exp - claims.iat > 10
    || !/^[a-f0-9]{24}$/.test(claims.jti)) {
    return { isValid: false };
  }
  if (claims.action !== action.action || claims.worldId !== action.worldId) {
    return { isValid: false };
  }
  if (action.action === "warp") {
    if (claims.floor !== action.floor
      || !Number.isSafeInteger(claims.floor)
      || claims.floor < 1
      || claims.floor > MAX_CONTROL_FLOOR) {
      return { isValid: false };
    }
  } else if (claims.floor !== undefined) {
    return { isValid: false };
  }
  return { isValid: true, action, jti: claims.jti, exp: claims.exp };
}
