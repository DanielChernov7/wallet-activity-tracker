import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chain, TxType } from '@prisma/client';

vi.mock('../../src/db/prisma.js', () => ({
  prisma: {
    wallet: { findFirst: vi.fn() },
  },
}));

vi.mock('../../src/prices/prices.js', () => ({
  getUsdPrice: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { classify, enrich } from '../../src/pipeline/enrichment.js';
import { prisma } from '../../src/db/prisma.js';
import { getUsdPrice } from '../../src/prices/prices.js';

describe('enrichment — classify()', () => {
  const base = {
    chain: Chain.ETHEREUM,
    hash: '0x1',
    from: '0xa',
    to: '0xb',
  };

  it('erc20_transfer kind → ERC20_TRANSFER', () => {
    expect(classify({ ...base, raw: { kind: 'erc20_transfer' } })).toBe(TxType.ERC20_TRANSFER);
  });

  it('native kind → TRANSFER', () => {
    expect(classify({ ...base, raw: { kind: 'native' } })).toBe(TxType.TRANSFER);
  });

  it('sol_logs kind → SOL_TRANSFER', () => {
    expect(classify({ ...base, chain: Chain.SOLANA, raw: { kind: 'sol_logs' } })).toBe(
      TxType.SOL_TRANSFER,
    );
  });

  it('missing/unknown kind → UNKNOWN', () => {
    expect(classify({ ...base, raw: {} })).toBe(TxType.UNKNOWN);
    expect(classify({ ...base, raw: { kind: 'weird' } })).toBe(TxType.UNKNOWN);
    expect(classify({ ...base, raw: null })).toBe(TxType.UNKNOWN);
  });
});

describe('enrichment — enrich()', () => {
  beforeEach(() => {
    vi.mocked(prisma.wallet.findFirst).mockReset();
    vi.mocked(getUsdPrice).mockReset();
  });

  it('links walletId when from or to is a tracked wallet', async () => {
    vi.mocked(prisma.wallet.findFirst).mockResolvedValueOnce({ id: 'w-1' } as any);
    vi.mocked(getUsdPrice).mockResolvedValueOnce(250);

    const result = await enrich({
      chain: Chain.ETHEREUM,
      hash: '0xdeadbeef',
      from: '0xfrom',
      to: '0xto',
      raw: { kind: 'native', value: '1000000000000000000' },
    });

    expect(result.walletId).toBe('w-1');
    expect(result.type).toBe(TxType.TRANSFER);
    expect(result.tokenSymbol).toBe('ETH');
    expect(result.valueUsd).toBe(250);
  });

  it('uses SOL as native symbol on Solana chain', async () => {
    vi.mocked(prisma.wallet.findFirst).mockResolvedValueOnce(null);
    vi.mocked(getUsdPrice).mockResolvedValueOnce(50);

    const result = await enrich({
      chain: Chain.SOLANA,
      hash: 'sig',
      from: 'a',
      to: 'b',
      raw: { kind: 'native', value: '1000000000' },
    });

    expect(result.tokenSymbol).toBe('SOL');
    expect(result.walletId).toBeUndefined();
  });

  it('passes erc20 contract + amount through to price lookup', async () => {
    vi.mocked(prisma.wallet.findFirst).mockResolvedValueOnce(null);
    vi.mocked(getUsdPrice).mockResolvedValueOnce(42);

    const result = await enrich({
      chain: Chain.ETHEREUM,
      hash: '0x1',
      from: '0xfrom',
      to: '0xto',
      raw: { kind: 'erc20_transfer', tokenContract: '0xCONTRACT', value: '1000' },
    });

    expect(result.type).toBe(TxType.ERC20_TRANSFER);
    expect(result.tokenAmount).toBe('1000');
    expect(result.valueUsd).toBe(42);
    expect(getUsdPrice).toHaveBeenCalledWith({
      chain: Chain.ETHEREUM,
      contract: '0xCONTRACT',
      amount: '1000',
    });
  });

  it('swallows price-lookup errors and leaves valueUsd undefined', async () => {
    vi.mocked(prisma.wallet.findFirst).mockResolvedValueOnce(null);
    vi.mocked(getUsdPrice).mockRejectedValueOnce(new Error('coingecko down'));

    const result = await enrich({
      chain: Chain.ETHEREUM,
      hash: '0x1',
      from: '0xfrom',
      to: '0xto',
      raw: { kind: 'native', value: '1' },
    });

    expect(result.valueUsd).toBeUndefined();
    expect(result.type).toBe(TxType.TRANSFER);
  });

  it('UNKNOWN kind: no price lookup, no token fields', async () => {
    vi.mocked(prisma.wallet.findFirst).mockResolvedValueOnce(null);

    const result = await enrich({
      chain: Chain.ETHEREUM,
      hash: '0x1',
      from: '0xfrom',
      to: '0xto',
      raw: { kind: 'contract_call' },
    });

    expect(result.type).toBe(TxType.UNKNOWN);
    expect(result.tokenSymbol).toBeUndefined();
    expect(result.valueUsd).toBeUndefined();
    expect(getUsdPrice).not.toHaveBeenCalled();
  });
});
