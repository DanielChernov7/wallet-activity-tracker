import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { wsHub } from '../notifications/wsHub.js';
import { metricsRoute } from './routes/metrics.js';
import { startMetricsPollers, stopMetricsPollers } from '../metrics/pollers.js';
import { authPlugin } from './plugins/auth.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { CreateWalletSchema, CreateAlertSchema } from './schemas.js';
import { parseAddress } from '../bot/address.js';

export type BuildServerOptions = {
  skipPollers?: boolean;
  skipRateLimit?: boolean;
};

export async function buildServer(opts: BuildServerOptions = {}) {
  const app = Fastify({ logger });
  await app.register(websocket);

  await app.register(authPlugin);
  if (!opts.skipRateLimit) {
    await app.register(rateLimitPlugin);
  }

  app.get('/health', async () => ({ ok: true, ts: Date.now(), wsClients: wsHub.size() }));

  await metricsRoute(app);
  if (!opts.skipPollers) startMetricsPollers();

  app.get('/wallets', async () => prisma.wallet.findMany({ orderBy: { createdAt: 'desc' } }));

  app.post('/wallets', async (req, reply) => {
    const parseResult = CreateWalletSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parseResult.error.issues });
    }
    const body = parseResult.data;
    // Re-parse to get the canonical form (lowercase EVM / base58 Solana) the rest
    // of the system stores. The schema already validated, so this can't throw.
    const canonical = parseAddress(body.address, body.chain).canonical;
    const wallet = await prisma.wallet.upsert({
      where: { chain_address: { chain: body.chain, address: canonical } },
      create: { ...body, address: canonical },
      update: { label: body.label, active: true },
    });
    return reply.code(201).send(wallet);
  });

  app.delete('/wallets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.wallet.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound' });
    await prisma.wallet.update({ where: { id }, data: { active: false } });
    return { ok: true };
  });

  app.get('/wallets/:id/transactions', async (req) => {
    const { id } = req.params as { id: string };
    return prisma.transaction.findMany({
      where: { walletId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  app.post('/alerts', async (req, reply) => {
    const parseResult = CreateAlertSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parseResult.error.issues });
    }
    const body = parseResult.data;
    const wallet = await prisma.wallet.findUnique({ where: { id: body.walletId } });
    if (!wallet) return reply.code(404).send({ error: 'WalletNotFound' });

    const alert = await prisma.alert.create({
      data: {
        walletId: body.walletId,
        name: body.name,
        condition: body.condition,
        channels: body.channels,
        apiKey: req.apiKey ?? null,
      },
    });
    return reply.code(201).send(alert);
  });

  app.delete('/alerts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.alert.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound' });
    // Ownership: if the alert is tied to an apiKey, only the same key may delete it.
    // When auth is disabled (no apiKey at all), we still allow deletion (dev mode).
    if (existing.apiKey && existing.apiKey !== req.apiKey) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    await prisma.alert.delete({ where: { id } });
    return { ok: true };
  });

  app.get('/ws', { websocket: true }, (socket) => {
    wsHub.add(socket);
    socket.send(JSON.stringify({ event: 'hello', data: { ts: Date.now() } }));
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  buildServer()
    .then(async (app) => {
      await app.listen({ port: env.API_PORT, host: '0.0.0.0' });

      const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        logger.info({ signal }, 'api shutting down');
        stopMetricsPollers();
        try {
          await app.close();
        } catch (err) {
          logger.warn({ err }, 'app.close() failed');
        }
        await prisma.$disconnect().catch(() => undefined);
        process.exit(0);
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
    })
    .catch((err) => {
      logger.fatal({ err }, 'api failed to start');
      process.exit(1);
    });
}
