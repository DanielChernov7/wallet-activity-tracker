import { Chain } from '@prisma/client';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './db/prisma.js';
import { rawTxQueue } from './queues/index.js';
import { EvmListener } from './chains/evm/EvmListener.js';
import { createSolanaListener } from './listeners/index.js';
import type { ChainListener, RawTransactionEvent } from './chains/ChainListener.js';

async function loadWatchedFor(chain: Chain) {
  const wallets = await prisma.wallet.findMany({ where: { chain, active: true } });
  return wallets.map((w) => ({ address: w.address, walletId: w.id }));
}

async function bootListener(listener: ChainListener) {
  listener.onTx(async (ev: RawTransactionEvent) => {
    await rawTxQueue.add('raw', {
      chain: ev.chain,
      hash: ev.hash,
      raw: {
        from: ev.from,
        to: ev.to,
        blockNumber: ev.blockNumber?.toString(),
        ...(ev.raw as object),
      },
      receivedAt: ev.receivedAt,
    });
  });
  const watched = await loadWatchedFor(listener.chain);
  await listener.start(watched);
}

async function main() {
  const listeners: ChainListener[] = [];

  if (env.ETH_WSS_URL) {
    listeners.push(new EvmListener({ chain: Chain.ETHEREUM, wssUrl: env.ETH_WSS_URL }));
  }
  if (env.BASE_WSS_URL) {
    listeners.push(new EvmListener({ chain: Chain.BASE, wssUrl: env.BASE_WSS_URL }));
  }
  if (env.ARBITRUM_WSS_URL) {
    listeners.push(new EvmListener({ chain: Chain.ARBITRUM, wssUrl: env.ARBITRUM_WSS_URL }));
  }
  if (env.YELLOWSTONE_ENDPOINT || env.SOLANA_RPC_URL) {
    // Address allowlist is populated by bootListener() from the DB; we pass [] here
    // and rely on watch() calls during boot to subscribe with the real filter.
    listeners.push(createSolanaListener([]));
  }

  if (listeners.length === 0) {
    logger.warn('no chain listeners configured — set *_WSS_URL or SOLANA_RPC_URL in .env');
  }

  for (const l of listeners) await bootListener(l);
  logger.info({ count: listeners.length }, 'chain listeners running');

  async function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down listeners');
    await Promise.all(listeners.map((l) => l.stop()));
    await prisma.$disconnect();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal');
  process.exit(1);
});
