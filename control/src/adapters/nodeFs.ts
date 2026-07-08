// Real filesystem adapter (node:fs/promises). Writes are atomic (temp file + rename) and symlink
// swaps are atomic (temp symlink + rename over the link), so a crash mid-deploy never leaves a
// half-written manifest or a dangling `current`. This is the only module that touches release
// files on the box; tests use the in-memory fake instead.

import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DirEntry, FileSystemPort } from "../ports.js";

export class NodeFileSystem implements FileSystemPort {
  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  }

  async appendFile(path: string, data: string, mode = 0o600): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, { mode });
  }

  async ensureDir(path: string, mode = 0o700): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isSymlink: e.isSymbolicLink() }));
    } catch {
      return [];
    }
  }

  async readSymlink(path: string): Promise<string | null> {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  }

  async swapSymlink(linkPath: string, target: string): Promise<void> {
    await mkdir(dirname(linkPath), { recursive: true });
    const tmp = `${linkPath}.tmp.${process.pid}.${Date.now()}`;
    await symlink(target, tmp);
    await rename(tmp, linkPath);
  }

  async removeDir(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
