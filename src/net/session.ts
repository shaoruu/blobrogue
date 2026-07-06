import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { ProfileDoc } from "./api.js";
import type { RunResult } from "../game/game.js";

const CLIENT_ID_KEY = "blobrogue.clientId";
const NAME_KEY = "blobrogue.name";

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

// Owns the persistent player identity and their saved stats. Works with or without
// a Convex client: with none, it just remembers the display name locally.
export class Session {
  readonly clientId: string;
  name: string;
  profile: ProfileDoc | null = null;
  private client: ConvexClient | null;

  constructor(client: ConvexClient | null) {
    this.client = client;
    this.clientId = readOrMintClientId();
    let stored = "";
    try { stored = localStorage.getItem(NAME_KEY) ?? ""; } catch { stored = ""; }
    this.name = stored;
  }

  get playerId(): string | null {
    return this.profile?.playerId ?? null;
  }

  private persistName(name: string) {
    this.name = name;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
  }

  async login(name: string): Promise<ProfileDoc | null> {
    this.persistName(name);
    if (!this.client) return null;
    this.profile = await this.client.mutation(api.players.ensurePlayer, { clientId: this.clientId, name });
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
      });
    } catch {
      // Never let a stats-save failure interrupt the play loop.
    }
    return this.profile;
  }
}
