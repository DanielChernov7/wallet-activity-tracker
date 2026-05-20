import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chain, TxType } from '@prisma/client';

vi.mock('../../src/db/prisma.js', () => ({
  prisma: {
    transaction: { count: vi.fn() },
    alert: { findMany: vi.fn() },
    alertEvent: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../src/queues/index.js', () => ({
  notifyQueue: { add: vi.fn() },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  evaluateAlerts,
  requeuePendingAlertEvents,
  ENQUEUE_FAILED_PREFIX,
} from '../../src/alerts/engine.js';
import { prisma } from '../../src/db/prisma.js';
import { notifyQueue } from '../../src/queues/index.js';
import type { EnrichedTx } from '../../src/pipeline/enrichment.js';

const tx: EnrichedTx = {
  hash: '0xabc',
  chain: Chain.ETHEREUM,
  type: TxType.TRANSFER,
  from: '0xa',
  to: '0xb',
  valueUsd: 1000,
  walletId: 'wallet-1',
  raw: {},
};

const alertRow = {
  id: 'a-1',
  walletId: 'wallet-1',
  name: 'big tx',
  condition: { type: 'any' } as object,
  channels: { webhook: 'https://x' } as object,
  enabled: true,
  apiKey: null,
  createdAt: new Date(),
};

describe('outbox semantics in evaluateAlerts', () => {
  beforeEach(() => {
    vi.mocked(prisma.alert.findMany).mockResolvedValue([alertRow] as any);
    vi.mocked(prisma.alertEvent.create).mockResolvedValue({ id: 'ev-1' } as any);
    vi.mocked(prisma.alertEvent.update).mockResolvedValue({} as any);
    vi.mocked(notifyQueue.add).mockReset();
  });

  it('persists AlertEvent first, then enqueues — happy path', async () => {
    vi.mocked(notifyQueue.add).mockResolvedValue({} as any);
    await evaluateAlerts(tx, 'tx-1');

    const createCall = vi.mocked(prisma.alertEvent.create).mock.invocationCallOrder[0]!;
    const enqueueCall = vi.mocked(notifyQueue.add).mock.invocationCallOrder[0]!;
    expect(createCall).toBeLessThan(enqueueCall);
    expect(prisma.alertEvent.update).not.toHaveBeenCalled();
  });

  it('when enqueue fails, marks AlertEvent with enqueue_failed reason and does not rethrow', async () => {
    vi.mocked(notifyQueue.add).mockRejectedValueOnce(new Error('redis down'));

    await expect(evaluateAlerts(tx, 'tx-1')).resolves.toBeUndefined();

    expect(prisma.alertEvent.update).toHaveBeenCalledOnce();
    const updateArg = vi.mocked(prisma.alertEvent.update).mock.calls[0]![0]!;
    expect((updateArg.data as { failedReason: string }).failedReason).toMatch(
      new RegExp(`^${ENQUEUE_FAILED_PREFIX}`),
    );
  });
});

describe('requeuePendingAlertEvents — reaper', () => {
  beforeEach(() => {
    vi.mocked(notifyQueue.add).mockReset();
    vi.mocked(prisma.alertEvent.update).mockReset();
  });

  it('picks up pending events and re-enqueues them', async () => {
    vi.mocked(prisma.alertEvent.findMany).mockResolvedValueOnce([
      {
        id: 'ev-1',
        alertId: 'a-1',
        transactionId: 'tx-1',
        payload: { hash: '0x1' },
        deliveredAt: null,
        failedReason: `${ENQUEUE_FAILED_PREFIX}redis down`,
        createdAt: new Date(Date.now() - 60_000),
        alert: alertRow,
      },
      {
        id: 'ev-2',
        alertId: 'a-1',
        transactionId: 'tx-2',
        payload: { hash: '0x2' },
        deliveredAt: null,
        failedReason: null,
        createdAt: new Date(Date.now() - 60_000),
        alert: alertRow,
      },
    ] as any);
    vi.mocked(notifyQueue.add).mockResolvedValue({} as any);
    vi.mocked(prisma.alertEvent.update).mockResolvedValue({} as any);

    const n = await requeuePendingAlertEvents();
    expect(n).toBe(2);
    expect(notifyQueue.add).toHaveBeenCalledTimes(2);
    // failedReason cleared on success
    expect(prisma.alertEvent.update).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(prisma.alertEvent.update).mock.calls) {
      expect((call[0]!.data as { failedReason: null | string }).failedReason).toBeNull();
    }
  });

  it('returns 0 when nothing is pending', async () => {
    vi.mocked(prisma.alertEvent.findMany).mockResolvedValueOnce([]);
    expect(await requeuePendingAlertEvents()).toBe(0);
    expect(notifyQueue.add).not.toHaveBeenCalled();
  });

  it('continues iterating if a single enqueue fails', async () => {
    vi.mocked(prisma.alertEvent.findMany).mockResolvedValueOnce([
      {
        id: 'ev-1',
        alertId: 'a-1',
        transactionId: 't',
        payload: {},
        deliveredAt: null,
        failedReason: null,
        createdAt: new Date(0),
        alert: alertRow,
      },
      {
        id: 'ev-2',
        alertId: 'a-1',
        transactionId: 't',
        payload: {},
        deliveredAt: null,
        failedReason: null,
        createdAt: new Date(0),
        alert: alertRow,
      },
    ] as any);
    vi.mocked(notifyQueue.add)
      .mockRejectedValueOnce(new Error('redis flap'))
      .mockResolvedValueOnce({} as any);
    vi.mocked(prisma.alertEvent.update).mockResolvedValue({} as any);

    const n = await requeuePendingAlertEvents();
    expect(n).toBe(1); // only the second succeeded
  });
});
