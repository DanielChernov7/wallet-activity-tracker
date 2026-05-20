import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chain } from '@prisma/client';

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createErc20MetadataCache } from '../../src/cache/erc20MetadataCache.js';
import { ethers } from 'ethers';

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function makeRedis() {
  const store = new Map<string, Record<string, string>>();
  return {
    store,
    hgetall: vi.fn(async (key: string) => store.get(key) ?? {}),
    hset: vi.fn(async (key: string, value: Record<string, string>) => {
      const cur = store.get(key) ?? {};
      store.set(key, { ...cur, ...value });
      return 1;
    }),
    expire: vi.fn(async () => 1),
  };
}

function encodeUint8(d: number): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [d]);
}
function encodeString(s: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(['string'], [s]);
}

describe('ERC20 metadata cache', () => {
  let redis: ReturnType<typeof makeRedis>;
  let provider: any;
  let aggregate3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    redis = makeRedis();
    aggregate3 = vi.fn();
    provider = {};
    // Patch ethers.Contract so the constructed multicall uses our mock.
    vi.spyOn(ethers, 'Contract').mockImplementation(
      () => ({ aggregate3: { staticCall: aggregate3 } }) as any,
    );
  });

  it('cache miss → multicall → cached on subsequent calls', async () => {
    aggregate3.mockResolvedValueOnce([
      { success: true, returnData: encodeString('USDC') },
      { success: true, returnData: encodeString('USD Coin') },
      { success: true, returnData: encodeUint8(6) },
    ]);
    const cache = createErc20MetadataCache({ redis: redis as any, provider });

    const first = await cache.get(Chain.ETHEREUM, TOKEN);
    expect(first).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(aggregate3).toHaveBeenCalledTimes(1);
    expect(redis.hset).toHaveBeenCalledOnce();
    expect(redis.expire).toHaveBeenCalledWith(`erc20:1:${TOKEN.toLowerCase()}`, 7 * 24 * 3600);

    const second = await cache.get(Chain.ETHEREUM, TOKEN);
    expect(second).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(aggregate3).toHaveBeenCalledTimes(1); // no extra call — served from Redis
  });

  it('falls back to CoinGecko when Multicall fails', async () => {
    aggregate3.mockResolvedValueOnce([
      { success: false, returnData: '0x' },
      { success: false, returnData: '0x' },
      { success: false, returnData: '0x' },
    ]);
    const fetchFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        json: async () => ({
          symbol: 'usdc',
          name: 'USD Coin',
          detail_platforms: { ethereum: { decimal_place: 6 } },
          image: { small: 'https://x/y.png' },
        }),
      },
    });
    const cache = createErc20MetadataCache({ redis: redis as any, provider, fetchFn: fetchFn as any });

    const meta = await cache.get(Chain.ETHEREUM, TOKEN);
    expect(meta).toEqual({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logoUri: 'https://x/y.png',
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(redis.hset).toHaveBeenCalledOnce();
  });

  it('returns null when both Multicall and CoinGecko fail', async () => {
    aggregate3.mockRejectedValueOnce(new Error('rpc down'));
    const fetchFn = vi.fn().mockResolvedValue({ statusCode: 502, body: { json: async () => ({}) } });
    const cache = createErc20MetadataCache({ redis: redis as any, provider, fetchFn: fetchFn as any });

    expect(await cache.get(Chain.ETHEREUM, TOKEN)).toBeNull();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('returns null for Solana (no chain id)', async () => {
    const cache = createErc20MetadataCache({ redis: redis as any, provider });
    expect(await cache.get(Chain.SOLANA, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toBeNull();
    expect(aggregate3).not.toHaveBeenCalled();
  });

  it('cache hit reads metadata from Redis without RPC', async () => {
    redis.store.set(`erc20:1:${TOKEN.toLowerCase()}`, {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: '6',
    });
    const cache = createErc20MetadataCache({ redis: redis as any, provider });
    const hit = await cache.get(Chain.ETHEREUM, TOKEN);
    expect(hit).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(aggregate3).not.toHaveBeenCalled();
  });

  it('prime() writes through to Redis with TTL', async () => {
    const cache = createErc20MetadataCache({ redis: redis as any, provider });
    await cache.prime(Chain.ETHEREUM, TOKEN, { symbol: 'X', name: 'X', decimals: 18 });
    expect(redis.hset).toHaveBeenCalledOnce();
    expect(redis.expire).toHaveBeenCalledWith(`erc20:1:${TOKEN.toLowerCase()}`, 7 * 24 * 3600);
  });
});
