import { createHmac, randomBytes } from "node:crypto";

import type { GameServerWorldAction } from "../types.js";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function mintGameServerControlToken(
  secret: string,
  action: GameServerWorldAction,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = {
    ...action,
    iat,
    exp: iat + 5,
    jti: randomBytes(12).toString("hex"),
  };
  const encoded = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const body = `brc1.${encoded}`;
  const signature = base64Url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}
