// Release store + artifact verifier tests: a well-formed release verifies; a tampered checksum,
// missing file, failing/skipped gate, mismatched id, or invalid id is rejected. Also confirms the
// tree checksum is deterministic and (when available) matches `sha256sum` — the parity the bash
// packer relies on.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChecksumArtifactVerifier } from "../src/artifactVerifier.js";
import { sha256Hex, treeChecksum } from "../src/checksum.js";
import { FsReleaseStore } from "../src/stores/releaseStore.js";
import { InMemoryFileSystem, TestRunner, stageRelease } from "./harness.js";

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
      const cli = await sha256sumCli(file);
      if (cli === null) {
        t.check("sha256sum unavailable — parity check skipped", true);
      } else {
        t.check("node sha256 matches sha256sum for a file", sha256Hex(content) === cli, `node=${sha256Hex(content).slice(0, 12)} cli=${cli.slice(0, 12)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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
