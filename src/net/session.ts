import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { ProfileDoc } from "./api.js";
import type { PetKind } from "../sim/types.js";
import type { RunResult } from "../game/game.js";

const CLIENT_ID_KEY = "blobrogue.clientId";
const NAME_KEY = "blobrogue.name";
const COLOR_KEY = "blobrogue.color";

function readOrMintClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    // Private mode / storage disabled: fall back to an in-memory id for this tab.
    return crypto.randomUUID();
  }
}

function readStoredColor(): number | null {
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
  } catch {
    return null;
  }
}

// Owns the persistent player identity (name + chosen blob color) and their saved stats.
// Works with or without a Convex client: with none, it just remembers everything locally.
export class Session {
  readonly clientId: string;
  name: string;
  // Chosen blob tint (client palette index). null = never picked (renders the natural
  // amber hero). Persisted locally always, and onto the Convex profile at login so
  // signed-in players keep it across devices.
  colorIndex: number | null;
  profile: ProfileDoc | null = null;
  private client: ConvexClient | null;

  constructor(client: ConvexClient | null) {
    this.client = client;
    this.clientId = readOrMintClientId();
    let stored = "";
    try { stored = localStorage.getItem(NAME_KEY) ?? ""; } catch { stored = ""; }
    this.name = stored;
    this.colorIndex = readStoredColor();
  }

  get playerId(): string | null {
    return this.profile?.playerId ?? null;
  }

  private persistName(name: string) {
    this.name = name;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
  }

  setColorIndex(colorIndex: number) {
    this.colorIndex = colorIndex;
    try { localStorage.setItem(COLOR_KEY, String(colorIndex)); } catch { /* ignore */ }
    // Persist the pick onto the profile in the background; the local value already applies.
    if (this.client) void this.login(this.name || "blob").catch(() => {});
  }

  async login(name: string): Promise<ProfileDoc | null> {
    this.persistName(name);
    if (!this.client) return null;
    this.profile = await this.client.mutation(api.players.ensurePlayer, {
      clientId: this.clientId,
      name,
      // Only an explicit local pick is sent — undefined never overwrites a saved pick.
      ...(this.colorIndex !== null ? { colorIndex: this.colorIndex } : {}),
    });
    // A signed-in account may carry a pick made on another device; adopt it locally.
    if (this.colorIndex === null && this.profile.colorIndex !== null) {
      this.colorIndex = this.profile.colorIndex;
      try { localStorage.setItem(COLOR_KEY, String(this.profile.colorIndex)); } catch { /* ignore */ }
    }
    return this.profile;
  }

  async refreshProfile(): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    this.profile = await this.client.query(api.players.getProfile, { clientId: this.clientId });
    return this.profile;
  }

  async recordRun(result: RunResult): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    try {
      this.profile = await this.client.mutation(api.players.recordRun, {
        clientId: this.clientId,
        floor: result.floor,
        kills: result.kills,
        coins: result.coins,
        deepestBossKill: result.deepestBossKill,
      });
    } catch {
      // Never let a stats-save failure interrupt the play loop.
    }
    return this.profile;
  }

  // The equipped companion, readable only off a live profile (pets are account progression;
  // there is deliberately no local fallback a guest could set).
  get activePet(): PetKind | null {
    return this.profile?.activePet ?? null;
  }

  async setActivePet(pet: PetKind | null): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    this.profile = await this.client.mutation(api.players.setActivePet, { clientId: this.clientId, pet });
    return this.profile;
  }
}
