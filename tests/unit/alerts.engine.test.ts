import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chain, TxType } from '@prisma/client';

vi.mock('../../src/db/prisma.js', () => ({
  prisma: {
    transaction: { count: vi.fn() },
    alert: { findMany: vi.fn() },
    alertEvent: { create: vi.fn() },
  },
}));

vi.mock('../../src/queues/index.js', () => ({
  notifyQueue: { add: vi.fn() },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { matches, evaluateAlerts, type AlertCondition } from '../../src/alerts/engine.js';
import { prisma } from '../../src/db/prisma.js';
import { notifyQueue } from '../../src/queues/index.js';
import type { EnrichedTx } from '../../src/pipeline/enrichment.js';

function tx(over: Partial<EnrichedTx> = {}): EnrichedTx {
  return {
    hash: '0xabc',
    chain: Chain.ETHEREUM,
    type: TxType.TRANSFER,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    valueUsd: 100,
    walletId: 'wallet-1',
    raw: {},
    ...over,
  };
}

describe('alert engine — matches()', () => {
  describe('any', () => {
    it('always returns true', async () => {
      expect(await matches({ type: 'any' }, tx())).toBe(true);
      expect(await matches({ type: 'any' }, tx({ valueUsd: 0 }))).toBe(true);
    });
  });

  describe('amount_gt', () => {
    it('strictly greater than threshold', async () => {
      const c: AlertCondition = { type: 'amount_gt', valueUsd: 100 };
      expect(await matches(c, tx({ valueUsd: 101 }))).toBe(true);
      expect(await matches(c, tx({ valueUsd: 100 }))).toBe(false); // boundary: equal => false
      expect(await matches(c, tx({ valueUsd: 99 }))).toBe(false);
    });

    it('treats missing valueUsd as 0', async () => {
      const c: AlertCondition = { type: 'amount_gt', valueUsd: 0 };
      expect(await matches(c, tx({ valueUsd: undefined }))).toBe(false);
      expect(await matches(c, tx({ valueUsd: 0.0001 }))).toBe(true);
    });

    it('handles zero threshold with zero value', async () => {
      expect(await matches({ type: 'amount_gt', valueUsd: 0 }, tx({ valueUsd: 0 }))).toBe(false);
    });

    it('handles negative threshold (degenerate but defined)', async () => {
      expect(await matches({ type: 'amount_gt', valueUsd: -10 }, tx({ valueUsd: 0 }))).toBe(true);
      expect(await matches({ type: 'amount_gt', valueUsd: -10 }, tx({ valueUsd: -5 }))).toBe(true);
      expect(await matches({ type: 'amount_gt', valueUsd: -10 }, tx({ valueUsd: -10 }))).toBe(false);
    });
  });

  describe('contract_interaction', () => {
    const CONTRACT = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('matches when tx.to == contract (case-insensitive)', async () => {
      const c: AlertCondition = { type: 'contract_interaction', contract: CONTRACT };
      expect(await matches(c, tx({ to: CONTRACT.toLowerCase() }))).toBe(true);
      expect(await matches(c, tx({ to: CONTRACT }))).toBe(true);
    });

    it('matches when tx.from == contract', async () => {
      const c: AlertCondition = { type: 'contract_interaction', contract: CONTRACT };
      expect(await matches(c, tx({ from: CONTRACT.toLowerCase(), to: '0xdead' }))).toBe(true);
    });

    it('does not match when neither side touches the contract', async () => {
      const c: AlertCondition = { type: 'contract_interaction', contract: CONTRACT };
      expect(await matches(c, tx({ from: '0xdead', to: '0xbeef' }))).toBe(false);
    });
  });

  describe('unusual_activity', () => {
    beforeEach(() => {
      vi.mocked(prisma.transaction.count).mockReset();
    });

    it('returns true when count >= minCount', async () => {
      vi.mocked(prisma.transaction.count).mockResolvedValueOnce(10);
      const c: AlertCondition = { type: 'unusual_activity', windowSec: 300, minCount: 10 };
      expect(await matches(c, tx())).toBe(true);
    });

    it('returns false when count below threshold', async () => {
      vi.mocked(prisma.transaction.count).mockResolvedValueOnce(9);
      const c: AlertCondition = { type: 'unusual_activity', windowSec: 300, minCount: 10 };
      expect(await matches(c, tx())).toBe(false);
    });

    it('returns false (and skips DB) when walletId missing', async () => {
      const c: AlertCondition = { type: 'unusual_activity', windowSec: 60, minCount: 1 };
      expect(await matches(c, tx({ walletId: undefined }))).toBe(false);
      expect(prisma.transaction.count).not.toHaveBeenCalled();
    });

    it('uses the configured window when querying', async () => {
      vi.mocked(prisma.transaction.count).mockResolvedValueOnce(0);
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await matches({ type: 'unusual_activity', windowSec: 600, minCount: 1 }, tx());
      const call = vi.mocked(prisma.transaction.count).mock.calls[0]![0]!;
      const since = (call.where as { createdAt: { gte: Date } }).createdAt.gte;
      expect(since.getTime()).toBe(now - 600_000);
    });
  });

  describe('unknown condition', () => {
    it('returns false', async () => {
      // @ts-expect-error intentional bad input
      expect(await matches({ type: 'nope' }, tx())).toBe(false);
    });
  });
});

describe('alert engine — evaluateAlerts()', () => {
  it('no-op when tx has no walletId', async () => {
    await evaluateAlerts(tx({ walletId: undefined }), 'tx-1');
    expect(prisma.alert.findMany).not.toHaveBeenCalled();
  });

  it('creates AlertEvent and enqueues notify only for matching alerts', async () => {
    vi.mocked(prisma.alert.findMany).mockResolvedValueOnce([
      {
        id: 'a-match',
        walletId: 'wallet-1',
        name: 'big tx',
        condition: { type: 'amount_gt', valueUsd: 50 } as object,
        channels: { telegram: true } as object,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: 'a-miss',
        walletId: 'wallet-1',
        name: 'huge tx',
        condition: { type: 'amount_gt', valueUsd: 10_000 } as object,
        channels: {} as object,
        enabled: true,
        createdAt: new Date(),
      },
    ] as any);
    vi.mocked(prisma.alertEvent.create).mockResolvedValue({ id: 'evt-1' } as any);

    await evaluateAlerts(tx({ valueUsd: 100 }), 'tx-1');

    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    expect(notifyQueue.add).toHaveBeenCalledTimes(1);
    const [, job] = vi.mocked(notifyQueue.add).mock.calls[0]!;
    expect((job as any).alertId).toBe('a-match');
    expect((job as any).transactionId).toBe('tx-1');
  });
});
