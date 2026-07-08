// Verifies an on-box release is EXACTLY the tested artifact before it can be promoted. It
// recomputes the tree checksum from the release's files, re-derives the releaseId from
// (commit, version, checksum), and requires all three build gates to be "pass". Any mismatch,
// missing file, or non-pass gate is a rejection — a tampered or partially-uploaded release can
// never be deployed.

import { sha256Hex, treeChecksum, type FileDigest } from "./checksum.js";
import { deriveReleaseId, isValidReleaseId } from "./ids.js";
import type { ArtifactVerifier } from "./interfaces.js";
import type { FileSystemPort } from "./ports.js";
import type { ReleaseManifest, VerifyOutcome } from "./types.js";
import { parseManifest } from "./stores/manifest.js";

export class ChecksumArtifactVerifier implements ArtifactVerifier {
  private readonly releasesDir: string;

  constructor(private fs: FileSystemPort, root: string) {
    this.releasesDir = `${root}/releases`;
  }

  async verify(releaseId: string): Promise<VerifyOutcome> {
    if (!isValidReleaseId(releaseId)) return { ok: false, reason: "invalid_release_id" };
    const dir = `${this.releasesDir}/${releaseId}`;
    const raw = await this.fs.readFile(`${dir}/manifest.json`);
    if (raw === null) return { ok: false, reason: "manifest_missing" };
    const manifest = parseManifest(raw);
    if (manifest === null) return { ok: false, reason: "manifest_unparseable" };

    if (manifest.releaseId !== releaseId) return { ok: false, reason: "manifest_id_mismatch" };

    const gateFail = this.failedGate(manifest);
    if (gateFail !== null) return { ok: false, reason: `gate_${gateFail}_not_pass` };

    if (manifest.files.length === 0) return { ok: false, reason: "no_files" };
    const digests: FileDigest[] = [];
    for (const rel of manifest.files) {
      if (rel.includes("..") || rel.startsWith("/")) return { ok: false, reason: "unsafe_file_path" };
      const content = await this.fs.readFile(`${dir}/${rel}`);
      if (content === null) return { ok: false, reason: `file_missing:${rel}` };
      digests.push({ path: rel, sha256: sha256Hex(content) });
    }
    const computed = treeChecksum(digests);
    if (computed !== manifest.checksum) return { ok: false, reason: "checksum_mismatch" };

    const derived = deriveReleaseId(manifest.commit, manifest.version, manifest.checksum);
    if (derived !== releaseId) return { ok: false, reason: "release_id_not_derived_from_content" };

    return { ok: true, release: { releaseId, manifest } };
  }

  private failedGate(m: ReleaseManifest): string | null {
    if (m.gates.typecheck !== "pass") return "typecheck";
    if (m.gates.unitTests !== "pass") return "unitTests";
    if (m.gates.goldens !== "pass") return "goldens";
    return null;
  }
}
