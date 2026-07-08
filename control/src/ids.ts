// releaseId grammar + random id helpers. The control service NEVER constructs a releaseId from
// request input — it only validates and looks one up. The id is minted by the build pipeline as
// `<commitShort>-<version>-<checksum12>`, which binds the artifact to its commit, version, and
// content hash in a single opaque, verifiable token.

import { randomBytes } from "node:crypto";

// e.g. "a1b2c3d4e5f6-1.4.0-9f8e7d6c5b4a"
const RELEASE_ID_RE = /^[a-z0-9]+-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}$/;

export function isValidReleaseId(id: string): boolean {
  return typeof id === "string" && id.length <= 128 && RELEASE_ID_RE.test(id);
}

export interface ParsedReleaseId {
  commit: string;
  version: string;
  checksum12: string;
}

export function parseReleaseId(id: string): ParsedReleaseId | null {
  if (!isValidReleaseId(id)) return null;
  const lastDash = id.lastIndexOf("-");
  const checksum12 = id.slice(lastDash + 1);
  const rest = id.slice(0, lastDash);
  const firstDash = rest.indexOf("-");
  return { commit: rest.slice(0, firstDash), version: rest.slice(firstDash + 1), checksum12 };
}

export function deriveReleaseId(commit: string, version: string, checksum: string): string {
  return `${commit}-${version}-${checksum.slice(0, 12)}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}
