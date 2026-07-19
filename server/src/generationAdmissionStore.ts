import {
  readFileSync,
} from "node:fs";
import { parseGenerationWorldId } from "../../src/net/runReceipt.js";
import { writeJsonAtomic } from "./durableJson.js";

export const GENERATION_RETIRE_MS = 130_000;

interface AdmissionEntry {
  worldId: string;
  state: "active" | "retired";
  retiredUntil?: number;
}

interface AdmissionFile {
  version: 1;
  entries: AdmissionEntry[];
}

function generationKey(worldId: string): string | null {
  const world = parseGenerationWorldId(worldId);
  if (!world) return null;
  return `${world.isPvp ? "pvp:" : "coop:"}${world.roomCode}`;
}

export class GenerationAdmissionStore {
  private entries = new Map<string, AdmissionEntry>();
  private recovered: string[] = [];

  constructor(private path: string | null, nowMs = Date.now()) {
    this.load();
    for (const entry of this.entries.values()) {
      if (entry.state === "active") {
        this.recovered.push(entry.worldId);
        entry.state = "retired";
        entry.retiredUntil = nowMs + GENERATION_RETIRE_MS;
      }
    }
    this.cleanup(nowMs);
    this.persist();
  }

  recoveredActiveWorldIds(): string[] {
    return this.recovered.slice();
  }

  isRetired(worldId: string, nowMs = Date.now()): boolean {
    this.cleanup(nowMs);
    const world = parseGenerationWorldId(worldId);
    const key = generationKey(worldId);
    if (!world || !key) return false;
    const latest = this.latestFor(key);
    if (!latest) return false;
    const latestWorld = parseGenerationWorldId(latest.worldId);
    if (!latestWorld) return false;
    return latestWorld.generation > world.generation
      || (latestWorld.generation === world.generation && latest.state === "retired");
  }

  markActive(worldId: string, nowMs = Date.now()): void {
    const world = parseGenerationWorldId(worldId);
    const key = generationKey(worldId);
    if (!world || !key) return;
    if (this.isRetired(worldId, nowMs)) throw new Error("generation is retired");
    const latest = this.latestFor(key);
    const latestWorld = latest ? parseGenerationWorldId(latest.worldId) : null;
    if (latestWorld && latestWorld.generation > world.generation) {
      throw new Error("generation is stale");
    }
    this.entries.set(worldId, { worldId, state: "active" });
    this.cleanup(nowMs);
    this.persist();
  }

  retire(worldId: string, nowMs = Date.now()): void {
    const world = parseGenerationWorldId(worldId);
    const key = generationKey(worldId);
    if (!world || !key) return;
    const latest = this.latestFor(key);
    const latestWorld = latest ? parseGenerationWorldId(latest.worldId) : null;
    if (latestWorld && latestWorld.generation > world.generation) return;
    this.entries.set(worldId, {
      worldId,
      state: "retired",
      retiredUntil: nowMs + GENERATION_RETIRE_MS,
    });
    this.cleanup(nowMs);
    this.persist();
  }

  cleanup(nowMs = Date.now()): void {
    let isChanged = false;
    for (const [worldId, entry] of this.entries) {
      if (entry.state !== "retired" || (entry.retiredUntil ?? 0) > nowMs) continue;
      const key = generationKey(worldId);
      const world = parseGenerationWorldId(worldId);
      const latest = key ? this.latestFor(key) : null;
      const latestWorld = latest ? parseGenerationWorldId(latest.worldId) : null;
      if (world && latestWorld && latestWorld.generation > world.generation) {
        this.entries.delete(worldId);
        isChanged = true;
      }
    }
    if (isChanged) this.persist();
  }

  private latestFor(key: string): AdmissionEntry | null {
    let latest: AdmissionEntry | null = null;
    let latestGeneration = 0;
    for (const entry of this.entries.values()) {
      if (generationKey(entry.worldId) !== key) continue;
      const world = parseGenerationWorldId(entry.worldId);
      if (world && world.generation >= latestGeneration) {
        latest = entry;
        latestGeneration = world.generation;
      }
    }
    return latest;
  }

  private load(): void {
    if (!this.path) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as AdmissionFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error("unsupported generation admission state");
      }
      for (const entry of parsed.entries) {
        if (!parseGenerationWorldId(entry.worldId)) continue;
        if (entry.state !== "active" && entry.state !== "retired") continue;
        this.entries.set(entry.worldId, entry);
      }
    } catch {
      throw new Error("generation admission state is malformed");
    }
  }

  private persist(): void {
    if (!this.path) return;
    const data: AdmissionFile = {
      version: 1,
      entries: [...this.entries.values()],
    };
    writeJsonAtomic(this.path, data);
  }
}
