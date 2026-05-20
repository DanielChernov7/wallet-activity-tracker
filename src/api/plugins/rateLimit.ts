import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import IORedis from 'ioredis';
import { env } from '../../config/env.js';

const SKIP_PATHS: ReadonlySet<string> = new Set(['/health', '/metrics']);

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const redis = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  await app.register(rateLimit, {
    global: false,
    redis,
    keyGenerator: (req: FastifyRequest) => req.apiKey ?? req.ip,
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    errorResponseBuilder: (_req, ctx) => ({
      error: 'Too Many Requests',
      retryAfter: Math.ceil(ctx.ttl / 1000),
    }),
  });

  app.addHook('onRoute', (route) => {
    const url = route.url;
    if (SKIP_PATHS.has(url)) return;
    const method = (Array.isArray(route.method) ? route.method[0] : route.method) ?? 'GET';
    const limit = limitForMethod(method);
    if (!limit) return;

    const opts = (route.config ?? {}) as { rateLimit?: object };
    if (opts.rateLimit) return; // route already opted in
    route.config = { ...route.config, rateLimit: { max: limit, timeWindow: '1 minute' } };
  });
}

function limitForMethod(method: string): number | null {
  switch (method.toUpperCase()) {
    case 'GET':
      return 100;
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 20;
    case 'DELETE':
      return 10;
    default:
      return null;
  }
}
