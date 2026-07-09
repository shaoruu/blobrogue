// Release store + artifact verifier tests: a well-formed release verifies; a tampered checksum,
// missing file, failing/skipped gate, mismatched id, or invalid id is rejected. Also confirms the
// tree checksum is deterministic and (when available) matches `sha256sum` — the parity the bash
// packer relies on.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeFileSystem } from "../src/adapters/nodeFs.js";
import { ChecksumArtifactVerifier } from "../src/artifactVerifier.js";
import { sha256Hex, treeChecksum } from "../src/checksum.js";
import { deriveReleaseId } from "../src/ids.js";
import { FsReleaseStore } from "../src/stores/releaseStore.js";
import { BINARY_SPRITE_BYTES, InMemoryFileSystem, TestRunner, stageRelease } from "./harness.js";

function sha256sumCli(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("sha256sum", [path], (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.split(/\s+/)[0] ?? null);
    });
  });
}

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("checksum: deterministic + sha256sum parity", async () => {
    const a = treeChecksum([{ path: "b", sha256: "22" }, { path: "a", sha256: "11" }]);
    const b = treeChecksum([{ path: "a", sha256: "11" }, { path: "b", sha256: "22" }]);
    t.check("tree checksum is order-independent (sorted)", a === b);

    const dir = await mkdtemp(join(tmpdir(), "brc-cksum-"));
    try {
      const file = join(dir, "sample.txt");
      const content = "hello blobrogue\n";
      await writeFile(file, content);
      const binFile = join(dir, "sample.png");
      await writeFile(binFile, BINARY_SPRITE_BYTES);
      const cli = await sha256sumCli(file);
      const binCli = await sha256sumCli(binFile);
      if (cli === null || binCli === null) {
        t.check("sha256sum unavailable — parity check skipped", true);
      } else {
        t.check("node sha256 matches sha256sum for a text file", sha256Hex(content) === cli, `node=${sha256Hex(content).slice(0, 12)} cli=${cli.slice(0, 12)}`);
        t.check("node sha256 matches sha256sum for a BINARY file", sha256Hex(BINARY_SPRITE_BYTES) === binCli, `node=${sha256Hex(BINARY_SPRITE_BYTES).slice(0, 12)} cli=${binCli.slice(0, 12)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Pack + verify round trip over a REAL tree on the REAL filesystem, with per-file hashes
  // computed the way the bash packer computes them (`sha256sum` over raw bytes). The tree
  // includes binary files (a sprite PNG, a fake native .node addon) whose bytes do not survive
  // a utf8 decode — the exact drift that once rejected every real release with
  // checksum_mismatch.
  await t.suite("verifier: packs + verifies a real tree containing binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "brc-pack-"));
    try {
      const tree: Record<string, string | Uint8Array> = {
        "server/dist/server/src/main.js": "console.log('gs');\n",
        "client/dist/index.html": "<!doctype html>\n",
        "client/dist/assets/sprites.png": BINARY_SPRITE_BYTES,
        "server/node_modules/native/build/addon.node": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0xff, 0x80, 0xc0, 0xee]),
      };
      const commit = "abc123def456";
      const version = "1.2.3";
      // Stage first, then hash the on-disk files — like the packer, which hashes what it staged.
      const stage = join(root, "stage");
      for (const [rel, data] of Object.entries(tree)) {
        const abs = join(stage, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, data);
      }
      const files = Object.keys(tree).sort();
      const digests: { path: string; sha256: string }[] = [];
      let isCliUsed = true;
      for (const rel of files) {
        const cli = await sha256sumCli(join(stage, rel));
        if (cli === null) isCliUsed = false;
        digests.push({ path: rel, sha256: cli ?? createHash("sha256").update(await readFile(join(stage, rel))).digest("hex") });
      }
      t.check(isCliUsed ? "per-file hashes computed by the real sha256sum CLI" : "sha256sum unavailable — packed with node raw-byte hashes", true);
      const checksum = treeChecksum(digests);
      const releaseId = deriveReleaseId(commit, version, checksum);
      const dir = join(root, "releases", releaseId);
      for (const rel of files) {
        const abs = join(dir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, tree[rel]);
      }
      const manifest = { releaseId, version, commit, builtAt: "2026-01-01T00:00:00Z", checksum, gates: { typecheck: "pass", unitTests: "pass", goldens: "pass" }, files };
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

      const verifier = new ChecksumArtifactVerifier(new NodeFileSystem(), root);
      const res = await verifier.verify(releaseId);
      t.check("packed tree with binaries verifies byte-for-byte", res.ok, res.ok ? releaseId : res.reason);

      // Integrity is not weakened: flip one byte inside the binary sprite and the release
      // must be rejected.
      const spritePath = join(dir, "client/dist/assets/sprites.png");
      const spriteBytes = Buffer.from(await readFile(spritePath));
      spriteBytes[spriteBytes.length - 1] ^= 0xff;
      await writeFile(spritePath, spriteBytes);
      const tampered = await verifier.verify(releaseId);
      t.check("tampered binary file rejected", !tampered.ok && (tampered.ok || tampered.reason === "checksum_mismatch"), tampered.ok ? "accepted" : tampered.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.suite("verifier: accepts a good release, rejects tampering", async () => {
    const root = "/opt/blobrogue-gs";
    const fs = new InMemoryFileSystem();
    const verifier = new ChecksumArtifactVerifier(fs, root);

    const good = stageRelease(fs, root);
    const okRes = await verifier.verify(good);
    t.check("well-formed release verifies", okRes.ok, okRes.ok ? okRes.release.releaseId : okRes.reason);

    const fs2 = new InMemoryFileSystem();
    const v2 = new ChecksumArtifactVerifier(fs2, root);
    const tampered = stageRelease(fs2, root, { tamperChecksum: "deadbeef".repeat(8) });
    const tRes = await v2.verify(tampered);
    t.check("checksum mismatch rejected", !tRes.ok && (tRes.ok || tRes.reason === "checksum_mismatch"));

    const fs3 = new InMemoryFileSystem();
    const v3 = new ChecksumArtifactVerifier(fs3, root);
    const dropped = stageRelease(fs3, root, { dropFile: "client/dist/index.html" });
    const dRes = await v3.verify(dropped);
    t.check("missing listed file rejected", !dRes.ok && (dRes.ok || dRes.reason.startsWith("file_missing")));

    const fs4 = new InMemoryFileSystem();
    const v4 = new ChecksumArtifactVerifier(fs4, root);
    const badGate = stageRelease(fs4, root, { gates: { typecheck: "pass", unitTests: "fail", goldens: "pass" } });
    const gRes = await v4.verify(badGate);
    t.check("failing gate rejected", !gRes.ok && (gRes.ok || gRes.reason === "gate_unitTests_not_pass"));

    const fs5 = new InMemoryFileSystem();
    const v5 = new ChecksumArtifactVerifier(fs5, root);
    const skipGate = stageRelease(fs5, root, { gates: { typecheck: "pass", unitTests: "pass", goldens: "skip" } });
    t.check("skipped gate rejected", !(await v5.verify(skipGate)).ok);

    t.check("invalid releaseId rejected", !(await verifier.verify("../etc/passwd")).ok);
    t.check("unknown releaseId rejected", !(await verifier.verify("zzz999999999-9.9.9-abcabcabcabc")).ok);
  });

  await t.suite("release store: symlink current/staging + prune", async () => {
    const root = "/opt/blobrogue-gs";
    const fs = new InMemoryFileSystem();
    const store = new FsReleaseStore(fs, root);
    const a = stageRelease(fs, root, { version: "1.0.0" });
    const b = stageRelease(fs, root, { version: "1.0.1" });

    t.check("no current before switch", (await store.current()) === null);
    await store.switchCurrent(a);
    t.check("current resolves after switch", (await store.current())?.releaseId === a);
    await store.switchCurrent(b);
    t.check("current re-points atomically", (await store.current())?.releaseId === b);
    const list = await store.list();
    t.check("list includes both, flags current", list.length === 2 && list.some((r) => r.releaseId === b && r.isCurrent));

    await store.switchStaging(a);
    t.check("staging resolves independently", (await store.staging())?.releaseId === a);

    const c = stageRelease(fs, root, { version: "1.0.2" });
    const pruned = await store.prune(1);
    t.check("prune keeps current+staging, removes others", !pruned.includes(a) && !pruned.includes(b) && pruned.includes(c), `pruned=${pruned.join(",")}`);
    t.check("current survives prune", (await store.current())?.releaseId === b);
  });
}
