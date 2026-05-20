import { ethers } from 'ethers';
import IORedis from 'ioredis';
import { Chain } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createErc20MetadataCache, type Erc20Cache, type Erc20Metadata } from './erc20MetadataCache.js';

let instance: Erc20Cache | null = null;

function resolveHttpUrl(chain: Chain): string | undefined {
  switch (chain) {
    case Chain.ETHEREUM:
      return env.ETH_HTTP_URL;
    case Chain.BASE:
      return env.BASE_HTTP_URL;
    case Chain.ARBITRUM:
      return env.ARBITRUM_HTTP_URL;
    default:
      return undefined;
  }
}

function build(): Erc20Cache | null {
  if (!env.ERC20_CACHE_ENABLED) return null;
  // Provider for Multicall: prefer Ethereum HTTP for L1 reads. Per-chain providers
  // could be wired here later if reads to L2 metadata become needed.
  const httpUrl = resolveHttpUrl(Chain.ETHEREUM);
  if (!httpUrl) {
    logger.warn('ERC20_CACHE_ENABLED but no ETH_HTTP_URL configured; cache disabled');
    return null;
  }
  const provider = new ethers.JsonRpcProvider(httpUrl);
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return createErc20MetadataCache({ provider, redis });
}

export function getErc20Cache(): Erc20Cache | null {
  if (instance) return instance;
  instance = build();
  return instance;
}

/**
 * Convenience wrapper. Returns null when the feature flag is off or the lookup
 * fails — callers must handle the null branch (enrichment falls back to its
 * legacy assumed-18-decimals path so behaviour is unchanged when disabled).
 */
export async function getErc20Metadata(chain: Chain, address: string): Promise<Erc20Metadata | null> {
  const cache = getErc20Cache();
  if (!cache) return null;
  return cache.get(chain, address);
}
