// Deterministic tree checksum shared by the build pipeline and the ArtifactVerifier. Kept
// byte-identical to `sha256sum` output so the bash packer and this TS verifier agree without an
// extra runtime:
//
//   line(i)   = "<sha256hex(file_i)>  <relpath_i>\n"   (two spaces — sha256sum format)
//   checksum  = sha256hex( concat(lines sorted by relpath, C locale) )
//
// Per-file hashes MUST be computed over the file's exact bytes (sha256sum semantics). A utf8
// read + re-encode is lossy for binary files (sprite PNGs, native addons), so callers hash the
// Uint8Array from FileSystemPort.readFileBytes, never a decoded string.
//
// The build script writes `checksum` into manifest.json; the verifier recomputes it from the
// on-box files and rejects any mismatch. A drift between the two implementations would fail the
// integration test that packs + verifies a real tree.

import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof data === "string") hash.update(data, "utf8");
  else hash.update(data);
  return hash.digest("hex");
}

export interface FileDigest {
  path: string;
  sha256: string;
}

export function treeChecksum(files: FileDigest[]): string {
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = sorted.map((f) => `${f.sha256}  ${f.path}\n`).join("");
  return sha256Hex(body);
}
