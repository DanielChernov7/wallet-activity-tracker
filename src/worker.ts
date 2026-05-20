import { Chain } from '@prisma/client';
import { Worker } from 'bullmq';
import {
  QUEUES,
  connection,
  type RawTxJob,
  type EnrichJob,
  type NotifyJob,
  enrichQueue,
} from './queues/index.js';
import { prisma } from './db/prisma.js';
import { enrich } from './pipeline/enrichment.js';
import { evaluateAlerts, requeuePendingAlertEvents } from './alerts/engine.js';
import { sendTelegram, formatTxMessage } from './notifications/telegram.js';
import { sendWebhook } from './notifications/webhook.js';
import { wsHub } from './notifications/wsHub.js';
import { logger } from './config/logger.js';
import { metrics } from './metrics/index.js';

const M = metrics();

/**
 * Raw tx worker — persists the raw event and hands off to enrichment.
 */
const rawTxWorker = new Worker<RawTxJob>(
  QUEUES.RAW_TX,
  async (job) => {
    const { chain, hash, raw } = job.data;
    const r = raw as { from?: string; to?: string; blockNumber?: string };
    const from = r.from ?? '';
    const to = r.to ?? '';

    try {
      const tx = await prisma.transaction.upsert({
        where: {
          chain_hash_fromAddress_toAddress: { chain: chain as Chain, hash, fromAddress: from, toAddress: to },
        },
        create: {
          chain: chain as Chain,
          hash,
          type: 'UNKNOWN',
          fromAddress: from,
          toAddress: to,
          raw: raw as object,
        },
        update: {},
      });
      await enrichQueue.add('enrich', { rawTxId: tx.id });
      M.transactionsProcessed.inc({ chain, tx_type: 'UNKNOWN', status: 'ok' });
    } catch (err) {
      M.transactionsProcessed.inc({ chain, tx_type: 'UNKNOWN', status: 'error' });
      throw err;
    }
  },
  { connection, concurrency: 16 },
);

/**
 * Enrichment worker — decodes, prices, labels, links wallet, persists final state, fires alerts.
 */
const enrichWorker = new Worker<EnrichJob>(
  QUEUES.ENRICH,
  async (job) => {
    const tx = await prisma.transaction.findUnique({ where: { id: job.data.rawTxId } });
    if (!tx) return;

    const endTimer = M.enrichmentDuration.startTimer({ chain: tx.chain });
    const enriched = await enrich({
      chain: tx.chain,
      hash: tx.hash,
      blockNumber: tx.blockNumber ?? undefined,
      from: tx.fromAddress,
      to: tx.toAddress,
      raw: tx.raw,
    });
    endTimer();

    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        type: enriched.type,
        tokenSymbol: enriched.tokenSymbol,
        tokenAmount: enriched.tokenAmount,
        valueUsd: enriched.valueUsd,
        walletId: enriched.walletId,
        metadata: enriched.metadata
          ? (JSON.parse(JSON.stringify(enriched.metadata, bigintReplacer)) as object)
          : undefined,
      },
    });

    wsHub.broadcast('transaction', { ...enriched, id: tx.id });
    await evaluateAlerts(enriched, tx.id);
  },
  { connection, concurrency: 8 },
);

/**
 * Notify worker — multi-channel fan-out with per-channel error isolation.
 */
const notifyWorker = new Worker<NotifyJob>(
  QUEUES.NOTIFY,
  async (job) => {
    const { alertId, payload } = job.data;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return;
    const channels = alert.channels as { telegram?: boolean; webhook?: string; websocket?: boolean };

    const errors: string[] = [];

    const conditionType = (alert.condition as { type?: string })?.type ?? 'unknown';

    if (channels.telegram) {
      const end = M.notificationDuration.startTimer({ channel: 'telegram' });
      try {
        await sendTelegram(formatTxMessage(payload as any));
        M.alertsFired.inc({ channel: 'telegram', condition: conditionType });
      } catch (e) {
        errors.push(`telegram: ${(e as Error).message}`);
      } finally {
        end();
      }
    }
    if (channels.webhook) {
      const end = M.notificationDuration.startTimer({ channel: 'webhook' });
      try {
        await sendWebhook(channels.webhook, payload);
        M.alertsFired.inc({ channel: 'webhook', condition: conditionType });
      } catch (e) {
        errors.push(`webhook: ${(e as Error).message}`);
      } finally {
        end();
      }
    }
    if (channels.websocket) {
      const end = M.notificationDuration.startTimer({ channel: 'websocket' });
      wsHub.broadcast('alert', payload);
      M.alertsFired.inc({ channel: 'websocket', condition: conditionType });
      end();
    }

    const eventId = (payload as any).eventId as string | undefined;
    if (eventId) {
      await prisma.alertEvent.update({
        where: { id: eventId },
        data: {
          deliveredAt: errors.length === 0 ? new Date() : null,
          failedReason: errors.length ? errors.join('; ') : null,
        },
      });
    }
    if (errors.length) throw new Error(errors.join('; '));
  },
  { connection, concurrency: 8 },
);

for (const [name, w] of Object.entries({ rawTxWorker, enrichWorker, notifyWorker })) {
  w.on('failed', (job, err) => logger.error({ name, jobId: job?.id, err }, 'job failed'));
  w.on('completed', (job) => logger.debug({ name, jobId: job.id }, 'job done'));
}

// Outbox reaper — picks up AlertEvents that didn't reach the notify queue.
const REAPER_INTERVAL_MS = 30_000;
const reaperTimer: NodeJS.Timeout = setInterval(() => {
  void requeuePendingAlertEvents().catch((err) => logger.warn({ err }, 'reaper tick failed'));
}, REAPER_INTERVAL_MS);
reaperTimer.unref?.();

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down workers');
  clearInterval(reaperTimer);
  await Promise.all([rawTxWorker.close(), enrichWorker.close(), notifyWorker.close()]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

logger.info('workers ready');
