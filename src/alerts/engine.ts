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

export async function evaluateAlerts(tx: EnrichedTx, transactionId: string): Promise<void> {
  if (!tx.walletId) return;
  const alerts = await prisma.alert.findMany({
    where: { walletId: tx.walletId, enabled: true },
  });

  for (const alert of alerts) {
    const condition = alert.condition as unknown as AlertCondition;
    const matched = await matches(condition, tx);
    if (!matched) continue;

    const event = await prisma.alertEvent.create({
      data: {
        alertId: alert.id,
        transactionId,
        payload: serializeTx(tx),
      },
    });

    await notifyQueue.add('notify', {
      alertId: alert.id,
      transactionId,
      payload: { eventId: event.id, alert: serializeAlert(alert), tx: serializeTx(tx) },
    });
  }
}

async function matches(c: AlertCondition, tx: EnrichedTx): Promise<boolean> {
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
