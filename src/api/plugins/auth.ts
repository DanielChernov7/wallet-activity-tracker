import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: string;
  }
}

const OPEN_PATHS: ReadonlySet<string> = new Set(['/health', '/metrics']);

export function parseApiKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export async function authPlugin(app: FastifyInstance): Promise<void> {
  const keys = parseApiKeys(env.API_KEYS);
  const enabled = keys.size > 0;

  app.addHook('onRequest', async (req, reply) => {
    if (isOpenPath(req.url)) return;
    if (!enabled) return;

    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !keys.has(provided)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return reply;
    }
    req.apiKey = provided;
    return;
  });
}

function isOpenPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return OPEN_PATHS.has(path);
}

export function _isOpenPathForTests(url: string): boolean {
  return isOpenPath(url);
}

// Convenience to read api key inside route handlers without exposing internals.
export function apiKeyOf(req: FastifyRequest): string | undefined {
  return req.apiKey;
}
