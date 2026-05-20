import IORedis, { type Redis as RedisType } from 'ioredis';
import { Chain } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { lookupLabel, type AddressLabel } from './labels.js';

const TTL_SECONDS = 24 * 3600;
const SENTINEL_NULL = '__null__';

let redis: RedisType | null = null;

function getRedis(): RedisType | null {
  if (!env.LABEL_CACHE_REDIS_ENABLED) return null;
  if (redis) return redis;
  redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  redis.on('error', (err) => logger.warn({ err }, 'label-cache redis error'));
  return redis;
}

function key(chain: Chain, address: string): string {
  const norm = chain === Chain.SOLANA ? address : address.toLowerCase();
  return `label:${chain}:${norm}`;
}

/**
 * Two-tier label lookup: Redis (24h TTL, hot path) -> in-memory DB cache
 * (5min TTL, cold path). Negative results are also cached (SENTINEL_NULL) so
 * the DB isn't hit twice for unknown addresses within the TTL window.
 */
export async function getLabel(chain: Chain, address: string): Promise<AddressLabel | null> {
  const client = getRedis();
  if (!client) return lookupLabel(chain, address);

  const k = key(chain, address);
  try {
    const cached = await client.hgetall(k);
    if (cached && Object.keys(cached).length > 0) {
      if (cached.sentinel === SENTINEL_NULL) return null;
      if (cached.label) return { label: cached.label, category: cached.category || null };
    }
  } catch (err) {
    logger.warn({ err, k }, 'redis label hgetall failed; falling through to db');
  }

  const fresh = await lookupLabel(chain, address);
  try {
    if (fresh) {
      await client.hset(k, {
        label: fresh.label,
        category: fresh.category ?? '',
      });
    } else {
      await client.hset(k, { sentinel: SENTINEL_NULL });
    }
    await client.expire(k, TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, k }, 'redis label write failed');
  }
  return fresh;
}

/** Test helper — disconnect and reset the singleton. */
export async function __resetRedisLabelCache(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      // ignore
    }
    redis = null;
  }
}
