import type { WeaponId } from "./types.js";
import { WEAPON_VARIETY } from "./balance.js";

export const RECENT_WEAPON_OFFER_LIMIT = WEAPON_VARIETY.recentDrops;
export const RECENT_BLESSING_OFFER_LIMIT = 4;

export interface WeaponOfferHistory {
  weaponSeenCounts: Partial<Record<WeaponId, number>>;
  recentWeaponOffers: WeaponId[];
}

export interface BlessingOfferHistory {
  blessingSeenCounts: Record<string, number>;
  recentBlessingOffers: string[][];
}

export function createWeaponOfferHistory(): WeaponOfferHistory {
  return { weaponSeenCounts: {}, recentWeaponOffers: [] };
}

export function createBlessingOfferHistory(): BlessingOfferHistory {
  return { blessingSeenCounts: {}, recentBlessingOffers: [] };
}

export function resetWeaponOfferHistory(history: WeaponOfferHistory): void {
  history.weaponSeenCounts = {};
  history.recentWeaponOffers = [];
}

export function resetBlessingOfferHistory(history: BlessingOfferHistory): void {
  history.blessingSeenCounts = {};
  history.recentBlessingOffers = [];
}

export function weaponSeenCount(history: WeaponOfferHistory, id: WeaponId): number {
  return history.weaponSeenCounts[id] ?? 0;
}

export function recordWeaponOffer(history: WeaponOfferHistory, id: WeaponId): void {
  history.weaponSeenCounts[id] = weaponSeenCount(history, id) + 1;
  history.recentWeaponOffers.push(id);
  if (history.recentWeaponOffers.length > RECENT_WEAPON_OFFER_LIMIT) {
    history.recentWeaponOffers.splice(0, history.recentWeaponOffers.length - RECENT_WEAPON_OFFER_LIMIT);
  }
}

export function weaponSeenWeight(history: WeaponOfferHistory, id: WeaponId): number {
  const count = weaponSeenCount(history, id);
  return count === 0 ? 3 : count === 1 ? 1 : 0.25;
}

export function blessingSeenCount(history: BlessingOfferHistory, id: string): number {
  return history.blessingSeenCounts[id] ?? 0;
}

export function blessingHistoryWeight(history: BlessingOfferHistory, id: string): number {
  const offers = history.recentBlessingOffers;
  const latest = offers[offers.length - 1];
  if (latest?.includes(id)) return 0.1;
  for (let i = Math.max(0, offers.length - RECENT_BLESSING_OFFER_LIMIT); i < offers.length - 1; i++) {
    if (offers[i].includes(id)) return 0.35;
  }
  return blessingSeenCount(history, id) === 0 ? 2 : 1;
}

export function recordBlessingOffer(history: BlessingOfferHistory, ids: readonly string[]): void {
  const completeOffer = [...new Set(ids)];
  if (completeOffer.length === 0) return;
  for (const id of completeOffer) {
    history.blessingSeenCounts[id] = blessingSeenCount(history, id) + 1;
  }
  history.recentBlessingOffers.push(completeOffer);
  if (history.recentBlessingOffers.length > RECENT_BLESSING_OFFER_LIMIT) {
    history.recentBlessingOffers.splice(
      0,
      history.recentBlessingOffers.length - RECENT_BLESSING_OFFER_LIMIT,
    );
  }
}

export function stablePlayerIdHash(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = ((hash * 33) ^ id.charCodeAt(i)) | 0;
  return hash;
}
