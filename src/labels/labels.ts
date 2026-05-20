import { Chain } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export type AddressLabel = { label: string; category: string | null };

const TTL_MS = 5 * 60_000;
let cache = new Map<string, AddressLabel>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

function key(chain: Chain, address: string): string {
  return `${chain}:${normalize(chain, address)}`;
}

function normalize(chain: Chain, address: string): string {
  return chain === Chain.SOLANA ? address : address.toLowerCase();
}

async function refresh(): Promise<void> {
  const rows = await prisma.addressLabel.findMany();
  const next = new Map<string, AddressLabel>();
  for (const r of rows) {
    next.set(key(r.chain, r.address), { label: r.label, category: r.category });
  }
  cache = next;
  loadedAt = Date.now();
}

async function ensureFresh(): Promise<void> {
  if (Date.now() - loadedAt < TTL_MS) return;
  if (inflight) return inflight;
  inflight = refresh().finally(() => {
    inflight = null;
  });
  await inflight;
}

export async function lookupLabel(chain: Chain, address: string): Promise<AddressLabel | null> {
  await ensureFresh();
  return cache.get(key(chain, address)) ?? null;
}

/** Test helper — drop the cache so the next lookup re-reads from DB. */
export function __resetLabelCache(): void {
  cache = new Map();
  loadedAt = 0;
  inflight = null;
}
