// Safe parser for a release manifest.json. The file lives on-box but is still treated as
// untrusted structured data (a corrupt or partial manifest must never throw into a handler) —
// mirrors the strict-decode discipline of the game server's protocol layer.

import type { GateResult, ReleaseGates, ReleaseManifest } from "../types.js";

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asGate(v: unknown): GateResult | null {
  return v === "pass" || v === "fail" || v === "skip" ? v : null;
}

export function parseManifest(raw: string): ReleaseManifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const releaseId = asString(o.releaseId);
  const version = asString(o.version);
  const commit = asString(o.commit);
  const builtAt = asString(o.builtAt);
  const checksum = asString(o.checksum);
  if (releaseId === null || version === null || commit === null || builtAt === null || checksum === null) return null;

  const g = typeof o.gates === "object" && o.gates !== null ? (o.gates as Record<string, unknown>) : null;
  if (g === null) return null;
  const typecheck = asGate(g.typecheck);
  const unitTests = asGate(g.unitTests);
  const goldens = asGate(g.goldens);
  if (typecheck === null || unitTests === null || goldens === null) return null;
  const gates: ReleaseGates = { typecheck, unitTests, goldens };

  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : null;
  if (files === null) return null;

  return { releaseId, version, commit, builtAt, checksum, gates, files };
}

export function stringifyManifest(m: ReleaseManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}
