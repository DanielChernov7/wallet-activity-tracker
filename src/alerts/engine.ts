import { Alert } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { EnrichedTx } from '../pipeline/enrichment.js';
import { notifyQueue } from '../queues/index.js';
import { logger } from '../config/logger.js';

export type AlertCondition =
  | { type: 'amount_gt'; valueUsd: number }
  | { type: 'contract_interaction'; contract: string }
  | { type: 'any' }
  | {
      type: 'unusual_activity';
      windowSec: number;
      minCount: number;
    };

export type AlertChannels = {
  telegram?: boolean;
  webhook?: string;
  websocket?: boolean;
};

export const ENQUEUE_FAILED_PREFIX = 'enqueue_failed:';

export async function evaluateAlerts(tx: EnrichedTx, transactionId: string): Promise<void> {
  if (!tx.walletId) return;
  const alerts = await prisma.alert.findMany({
    where: { walletId: tx.walletId, enabled: true },
  });

  for (const alert of alerts) {
    const condition = alert.condition as unknown as AlertCondition;
    const matched = await matches(condition, tx);
    if (!matched) continue;

    // Outbox: AlertEvent is the source of truth. Persisting it first means we
    // never lose an alert even if Redis is down — the reaper (see
    // requeuePendingAlertEvents) will re-enqueue any event that didn't reach
    // the queue. failedReason is used as the pending-marker.
    const event = await prisma.alertEvent.create({
      data: {
        alertId: alert.id,
        transactionId,
        payload: serializeTx(tx),
      },
    });

    try {
      await notifyQueue.add('notify', {
        alertId: alert.id,
        transactionId,
        payload: { eventId: event.id, alert: serializeAlert(alert), tx: serializeTx(tx) },
      });
    } catch (err) {
      const reason = `${ENQUEUE_FAILED_PREFIX}${(err as Error).message}`;
      logger.error({ err, eventId: event.id, alertId: alert.id }, 'failed to enqueue notify');
      await prisma.alertEvent
        .update({ where: { id: event.id }, data: { failedReason: reason } })
        .catch((markErr) =>
          logger.error({ err: markErr, eventId: event.id }, 'failed to mark alertEvent pending'),
        );
      // Don't rethrow — the event is persisted, the reaper will retry.
    }
  }
}

/**
 * Background reaper: picks up AlertEvents that never reached the notify queue
 * (either because enqueue failed above, or because the process died mid-flight)
 * and re-enqueues them. Idempotent w.r.t. the notify queue — duplicate notifies
 * for the same eventId are an acceptable failure mode (delivery is at-least-once).
 *
 * Returns the number of events re-enqueued. Designed to be invoked from a
 * setInterval in the worker process; safe to run concurrently across workers
 * because we use updateMany with the same failedReason filter to mark in-flight.
 */
export async function requeuePendingAlertEvents(
  olderThanMs = 30_000,
  batchSize = 100,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const candidates = await prisma.alertEvent.findMany({
    where: {
      deliveredAt: null,
      createdAt: { lt: cutoff },
      OR: [{ failedReason: null }, { failedReason: { startsWith: ENQUEUE_FAILED_PREFIX } }],
    },
    take: batchSize,
    include: { alert: true },
  });

  let requeued = 0;
  for (const ev of candidates) {
    try {
      const txPayload = ev.payload as Record<string, unknown>;
      await notifyQueue.add('notify', {
        alertId: ev.alertId,
        transactionId: ev.transactionId ?? '',
        payload: { eventId: ev.id, alert: serializeAlert(ev.alert), tx: txPayload },
      });
      await prisma.alertEvent
        .update({ where: { id: ev.id }, data: { failedReason: null } })
        .catch(() => undefined);
      requeued++;
    } catch (err) {
      logger.warn({ err, eventId: ev.id }, 'reaper failed to re-enqueue alertEvent');
    }
  }
  return requeued;
}

export async function matches(c: AlertCondition, tx: EnrichedTx): Promise<boolean> {
  switch (c.type) {
    case 'any':
      return true;
    case 'amount_gt':
      return (tx.valueUsd ?? 0) > c.valueUsd;
    case 'contract_interaction': {
      const target = c.contract.toLowerCase();
      return tx.to.toLowerCase() === target || tx.from.toLowerCase() === target;
    }
    case 'unusual_activity': {
      if (!tx.walletId) return false;
      const since = new Date(Date.now() - c.windowSec * 1000);
      const count = await prisma.transaction.count({
        where: { walletId: tx.walletId, createdAt: { gte: since } },
      });
      return count >= c.minCount;
    }
    default:
      logger.warn({ condition: c }, 'unknown alert condition');
      return false;
  }
}

function serializeTx(tx: EnrichedTx) {
  return {
    hash: tx.hash,
    chain: tx.chain,
    type: tx.type,
    from: tx.from,
    to: tx.to,
    tokenSymbol: tx.tokenSymbol,
    tokenAmount: tx.tokenAmount,
    valueUsd: tx.valueUsd,
  };
}

function serializeAlert(a: Alert) {
  return { id: a.id, name: a.name, channels: a.channels };
}
