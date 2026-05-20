import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { authPlugin, parseApiKeys, _isOpenPathForTests } from '../../src/api/plugins/auth.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authPlugin);
  app.get('/health', async () => ({ ok: true }));
  app.get('/metrics', async () => 'metrics data');
  app.get('/wallets', async () => []);
  app.post('/wallets', async (req) => ({ apiKey: req.apiKey ?? null }));
  return app;
}

describe('parseApiKeys', () => {
  it('returns empty set for undefined / empty / whitespace', () => {
    expect(parseApiKeys(undefined).size).toBe(0);
    expect(parseApiKeys('').size).toBe(0);
    expect(parseApiKeys('   ').size).toBe(0);
  });
  it('splits and trims', () => {
    const s = parseApiKeys(' a , b ,c ,, ');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.size).toBe(3);
  });
});

describe('isOpenPath', () => {
  it('matches /health and /metrics regardless of query string', () => {
    expect(_isOpenPathForTests('/health')).toBe(true);
    expect(_isOpenPathForTests('/health?x=1')).toBe(true);
    expect(_isOpenPathForTests('/metrics')).toBe(true);
    expect(_isOpenPathForTests('/wallets')).toBe(false);
  });
});

describe('API auth plugin', () => {
  beforeEach(() => {
    delete process.env.API_KEYS;
  });

  it('with no API_KEYS — auth disabled, all routes accessible', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/wallets' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('with API_KEYS set — 401 without key', async () => {
    process.env.API_KEYS = 'secret-1,secret-2';
    // Re-import so the env-driven module reads the new value. Vitest module cache
    // is per-test-file; we use isolateModules.
    await vi.resetModules();
    const { authPlugin: freshPlugin } = await import('../../src/api/plugins/auth.js');
    const app = Fastify({ logger: false });
    await app.register(freshPlugin);
    app.get('/health', async () => ({ ok: true }));
    app.get('/wallets', async () => []);

    const noKey = await app.inject({ method: 'GET', url: '/wallets' });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json()).toEqual({ error: 'Unauthorized' });

    const wrongKey = await app.inject({
      method: 'GET',
      url: '/wallets',
      headers: { 'x-api-key': 'nope' },
    });
    expect(wrongKey.statusCode).toBe(401);

    const goodKey = await app.inject({
      method: 'GET',
      url: '/wallets',
      headers: { 'x-api-key': 'secret-1' },
    });
    expect(goodKey.statusCode).toBe(200);

    const healthNoKey = await app.inject({ method: 'GET', url: '/health' });
    expect(healthNoKey.statusCode).toBe(200);

    await app.close();
  });

  it('populates request.apiKey when auth passes', async () => {
    process.env.API_KEYS = 'tok-1';
    await vi.resetModules();
    const { authPlugin: freshPlugin } = await import('../../src/api/plugins/auth.js');
    const app = Fastify({ logger: false });
    await app.register(freshPlugin);
    app.post('/wallets', async (req) => ({ apiKey: req.apiKey ?? null }));

    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { 'x-api-key': 'tok-1' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiKey: 'tok-1' });
    await app.close();
  });
});
