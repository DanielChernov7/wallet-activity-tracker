import { ethers } from 'ethers';
import { request } from 'undici';
import type Redis from 'ioredis';
import { Chain } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Erc20Metadata {
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
}

const TTL_SECONDS = 7 * 24 * 3600;

const CHAIN_ID: Record<Chain, number | null> = {
  ETHEREUM: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  SOLANA: null,
};

const COINGECKO_PLATFORM: Record<Chain, string | null> = {
  ETHEREUM: 'ethereum',
  BASE: 'base',
  ARBITRUM: 'arbitrum-one',
  SOLANA: null,
};

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
];

const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Call3[]',
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'aggregate3',
    outputs: [
      {
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Result[]',
        name: 'returnData',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export type Erc20CacheDeps = {
  redis: Redis;
  provider: ethers.JsonRpcProvider | ethers.Provider;
  fetchFn?: typeof request;
};

export type Erc20Cache = {
  get(chain: Chain, address: string): Promise<Erc20Metadata | null>;
  prime(chain: Chain, address: string, value: Erc20Metadata): Promise<void>;
};

export function createErc20MetadataCache(deps: Erc20CacheDeps): Erc20Cache {
  const fetchFn = deps.fetchFn ?? request;
  const erc20Iface = new ethers.Interface(ERC20_ABI);
  const multicall = new ethers.Contract(env.MULTICALL3_ADDRESS, MULTICALL3_ABI, deps.provider);

  async function readCache(chainId: number, address: string): Promise<Erc20Metadata | null> {
    const key = redisKey(chainId, address);
    const raw = await deps.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    const decimals = Number(raw.decimals);
    if (!raw.symbol || !raw.name || !Number.isFinite(decimals)) return null;
    return {
      symbol: raw.symbol,
      name: raw.name,
      decimals,
      logoUri: raw.logoUri || undefined,
    };
  }

  async function writeCache(chainId: number, address: string, value: Erc20Metadata): Promise<void> {
    const key = redisKey(chainId, address);
    const payload: Record<string, string> = {
      symbol: value.symbol,
      name: value.name,
      decimals: String(value.decimals),
    };
    if (value.logoUri) payload.logoUri = value.logoUri;
    await deps.redis.hset(key, payload);
    await deps.redis.expire(key, TTL_SECONDS);
  }

  async function fromMulticall(address: string): Promise<Erc20Metadata | null> {
    const calls = (['symbol', 'name', 'decimals'] as const).map((fn) => ({
      target: address,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData(fn),
    }));
    try {
      const results: { success: boolean; returnData: string }[] = await multicall.aggregate3.staticCall(
        calls,
      );
      const decode = <T>(idx: number, fn: 'symbol' | 'name' | 'decimals'): T | null => {
        const r = results[idx];
        if (!r?.success || r.returnData === '0x') return null;
        try {
          const [v] = erc20Iface.decodeFunctionResult(fn, r.returnData);
          return v as T;
        } catch {
          return null;
        }
      };
      const symbol = decode<string>(0, 'symbol');
      const name = decode<string>(1, 'name');
      const decimals = decode<bigint | number>(2, 'decimals');
      if (symbol === null || name === null || decimals === null) return null;
      return { symbol, name, decimals: Number(decimals) };
    } catch (err) {
      logger.warn({ err, address }, 'multicall3 failed');
      return null;
    }
  }

  async function fromCoinGecko(chain: Chain, address: string): Promise<Erc20Metadata | null> {
    const platform = COINGECKO_PLATFORM[chain];
    if (!platform) return null;
    const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}`;
    try {
      const res = await fetchFn(url, {
        headers: env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY } : {},
      });
      if (res.statusCode >= 300) return null;
      const json = (await res.body.json()) as {
        symbol?: string;
        name?: string;
        detail_platforms?: Record<string, { decimal_place?: number }>;
        image?: { small?: string };
      };
      const decimals = json.detail_platforms?.[platform]?.decimal_place;
      if (!json.symbol || !json.name || typeof decimals !== 'number') return null;
      return {
        symbol: json.symbol.toUpperCase(),
        name: json.name,
        decimals,
        logoUri: json.image?.small,
      };
    } catch (err) {
      logger.warn({ err, address, chain }, 'coingecko erc20 metadata failed');
      return null;
    }
  }

  return {
    async get(chain, address) {
      const chainId = CHAIN_ID[chain];
      if (chainId == null) return null;
      const normalized = address.toLowerCase();

      const cached = await readCache(chainId, normalized);
      if (cached) return cached;

      const onchain = await fromMulticall(normalized);
      if (onchain) {
        await writeCache(chainId, normalized, onchain);
        return onchain;
      }

      const fallback = await fromCoinGecko(chain, normalized);
      if (fallback) {
        await writeCache(chainId, normalized, fallback);
        return fallback;
      }

      return null;
    },
    async prime(chain, address, value) {
      const chainId = CHAIN_ID[chain];
      if (chainId == null) return;
      await writeCache(chainId, address.toLowerCase(), value);
    },
  };
}

function redisKey(chainId: number, address: string): string {
  return `erc20:${chainId}:${address.toLowerCase()}`;
}
