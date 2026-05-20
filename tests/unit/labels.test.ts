import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chain } from '@prisma/client';

vi.mock('../../src/db/prisma.js', () => ({
  prisma: { addressLabel: { findMany: vi.fn() } },
}));

import { lookupLabel, __resetLabelCache } from '../../src/labels/labels.js';
import { prisma } from '../../src/db/prisma.js';

const rows = [
  { chain: Chain.ETHEREUM, address: '0xabc', label: 'USDC', category: 'token' },
  { chain: Chain.SOLANA, address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter', category: 'dex' },
];

describe('labels cache', () => {
  beforeEach(() => {
    __resetLabelCache();
    vi.mocked(prisma.addressLabel.findMany).mockReset();
    vi.mocked(prisma.addressLabel.findMany).mockResolvedValue(rows as any);
  });

  it('returns label for EVM in a case-insensitive way', async () => {
    const hit = await lookupLabel(Chain.ETHEREUM, '0xABC');
    expect(hit).toEqual({ label: 'USDC', category: 'token' });
  });

  it('returns null for unknown address', async () => {
    expect(await lookupLabel(Chain.ETHEREUM, '0xdead')).toBeNull();
  });

  it('respects Solana base58 case sensitivity', async () => {
    const hit = await lookupLabel(Chain.SOLANA, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(hit?.label).toBe('Jupiter');
    const miss = await lookupLabel(Chain.SOLANA, 'jup6lkbzbjs1jkkwapdhny74zcz3tluzoi5qnyvtav4');
    expect(miss).toBeNull();
  });

  it('caches and avoids repeated DB calls within TTL', async () => {
    await lookupLabel(Chain.ETHEREUM, '0xabc');
    await lookupLabel(Chain.ETHEREUM, '0xabc');
    await lookupLabel(Chain.ETHEREUM, '0xdead');
    expect(prisma.addressLabel.findMany).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent refreshes into a single DB call', async () => {
    await Promise.all([
      lookupLabel(Chain.ETHEREUM, '0xabc'),
      lookupLabel(Chain.ETHEREUM, '0xabc'),
      lookupLabel(Chain.SOLANA, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
    ]);
    expect(prisma.addressLabel.findMany).toHaveBeenCalledTimes(1);
  });
});
