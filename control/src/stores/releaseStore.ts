// Immutable release catalog over `${root}/releases/<id>` with atomic `current`/`staging`
// symlinks. A release directory is written once by the promote step and never edited; deploy
// only re-points a symlink. releaseIds are always validated before they touch a path, so a
// path-traversal value can never form a filesystem path.

import { isValidReleaseId } from "../ids.js";
import type { ReleaseStore } from "../interfaces.js";
import type { FileSystemPort } from "../ports.js";
import type { Release, ReleaseManifest } from "../types.js";
import { parseManifest } from "./manifest.js";

export class FsReleaseStore implements ReleaseStore {
  private readonly releasesDir: string;
  private readonly currentLink: string;
  private readonly stagingLink: string;

  constructor(private fs: FileSystemPort, root: string) {
    this.releasesDir = `${root}/releases`;
    this.currentLink = `${root}/current`;
    this.stagingLink = `${root}/staging`;
  }

  private releaseDir(id: string): string {
    return `${this.releasesDir}/${id}`;
  }

  private linkTargetId(target: string | null): string | null {
    if (target === null) return null;
    const base = target.replace(/\/+$/, "").split("/").pop() ?? null;
    return base !== null && isValidReleaseId(base) ? base : null;
  }

  private async manifestOf(id: string): Promise<ReleaseManifest | null> {
    if (!isValidReleaseId(id)) return null;
    const raw = await this.fs.readFile(`${this.releaseDir(id)}/manifest.json`);
    return raw === null ? null : parseManifest(raw);
  }

  async list(): Promise<Release[]> {
    const exists = await this.fs.exists(this.releasesDir);
    if (!exists) return [];
    const entries = await this.fs.listDir(this.releasesDir);
    const currentId = await this.currentId();
    const stagingId = await this.stagingId();
    const out: Release[] = [];
    for (const e of entries) {
      if (!e.isDirectory || !isValidReleaseId(e.name)) continue;
      const manifest = await this.manifestOf(e.name);
      if (manifest === null) continue;
      out.push({
        releaseId: e.name,
        manifest,
        isCurrent: e.name === currentId,
        isStaging: e.name === stagingId,
        isRetained: true,
      });
    }
    out.sort((a, b) => (a.manifest.builtAt < b.manifest.builtAt ? 1 : -1));
    return out;
  }

  async get(releaseId: string): Promise<Release | null> {
    const manifest = await this.manifestOf(releaseId);
    if (manifest === null) return null;
    return {
      releaseId,
      manifest,
      isCurrent: releaseId === (await this.currentId()),
      isStaging: releaseId === (await this.stagingId()),
      isRetained: true,
    };
  }

  private async currentId(): Promise<string | null> {
    return this.linkTargetId(await this.fs.readSymlink(this.currentLink));
  }
  private async stagingId(): Promise<string | null> {
    return this.linkTargetId(await this.fs.readSymlink(this.stagingLink));
  }

  async current(): Promise<Release | null> {
    const id = await this.currentId();
    return id === null ? null : this.get(id);
  }
  async staging(): Promise<Release | null> {
    const id = await this.stagingId();
    return id === null ? null : this.get(id);
  }

  async switchCurrent(releaseId: string): Promise<void> {
    if (!isValidReleaseId(releaseId)) throw new Error("invalid releaseId");
    if (!(await this.fs.exists(this.releaseDir(releaseId)))) throw new Error("release not present");
    await this.fs.swapSymlink(this.currentLink, `releases/${releaseId}`);
  }

  async switchStaging(releaseId: string): Promise<void> {
    if (!isValidReleaseId(releaseId)) throw new Error("invalid releaseId");
    if (!(await this.fs.exists(this.releaseDir(releaseId)))) throw new Error("release not present");
    await this.fs.swapSymlink(this.stagingLink, `releases/${releaseId}`);
  }

  // Prune oldest releases beyond `keep`, never removing the current or staging targets.
  async prune(keep: number): Promise<string[]> {
    const all = await this.list();
    const protectedIds = new Set<string>();
    const cur = await this.currentId();
    const stg = await this.stagingId();
    if (cur !== null) protectedIds.add(cur);
    if (stg !== null) protectedIds.add(stg);
    const prunable = all.filter((r) => !protectedIds.has(r.releaseId));
    const toPrune = prunable.slice(Math.max(0, keep - protectedIds.size));
    const pruned: string[] = [];
    for (const r of toPrune) {
      await this.fs.removeDir(this.releaseDir(r.releaseId));
      pruned.push(r.releaseId);
    }
    return pruned;
  }
}
