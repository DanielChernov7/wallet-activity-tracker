import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { Chain } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { wsHub } from '../notifications/wsHub.js';
import { metricsRoute } from './routes/metrics.js';
import { startMetricsPollers } from '../metrics/pollers.js';
import { authPlugin } from './plugins/auth.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';

const ChainEnum = z.nativeEnum(Chain);

const CreateWallet = z.object({
  address: z.string().min(1),
  chain: ChainEnum,
  label: z.string().optional(),
});

const CreateAlert = z.object({
  walletId: z.string(),
  name: z.string(),
  condition: z.record(z.unknown()),
  channels: z.record(z.unknown()),
});

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
    const body = CreateWallet.parse(req.body);
    const wallet = await prisma.wallet.upsert({
      where: { chain_address: { chain: body.chain, address: body.address } },
      create: body,
      update: { label: body.label, active: true },
    });
    return reply.code(201).send(wallet);
  });

  app.delete('/wallets/:id', async (req) => {
    const { id } = req.params as { id: string };
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
    const body = CreateAlert.parse(req.body);
    const alert = await prisma.alert.create({ data: body });
    return reply.code(201).send(alert);
  });

  app.delete('/alerts/:id', async (req) => {
    const { id } = req.params as { id: string };
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
    .then((app) => app.listen({ port: env.API_PORT, host: '0.0.0.0' }))
    .catch((err) => {
      logger.fatal({ err }, 'api failed to start');
      process.exit(1);
    });
}
