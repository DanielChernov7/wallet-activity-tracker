import { Chain } from '@prisma/client';
import { rawTxQueue, enrichQueue, notifyQueue, connection } from '../queues/index.js';
import { prisma } from '../db/prisma.js';
import { metrics } from './index.js';
import { logger } from '../config/logger.js';

const POLL_INTERVAL_MS = 15_000;

let timer: NodeJS.Timeout | null = null;

export function startMetricsPollers(): void {
  const m = metrics();
  const queues = [
    { q: rawTxQueue, name: 'raw_transactions' },
    { q: enrichQueue, name: 'parse_and_enrich' },
    { q: notifyQueue, name: 'notify' },
  ];

  const tick = async (): Promise<void> => {
    try {
      // Queue depths
      for (const { q, name } of queues) {
        const [waiting, active] = await Promise.all([q.getWaitingCount(), q.getActiveCount()]);
        m.queueSize.set({ queue_name: name }, waiting + active);
      }

      // Active wallets per chain
      const grouped = await prisma.wallet.groupBy({
        by: ['chain'],
        where: { active: true },
        _count: { _all: true },
      });
      const present = new Set<Chain>();
      for (const row of grouped) {
        m.walletsMonitored.set({ chain: row.chain }, row._count._all);
        present.add(row.chain);
      }
      for (const c of Object.values(Chain)) {
        if (!present.has(c)) m.walletsMonitored.set({ chain: c }, 0);
      }

      // Redis liveness — ping via the BullMQ connection
      try {
        const client = connection as unknown as { ping?: () => Promise<string> };
        if (client.ping) {
          await client.ping();
          m.redisConnected.set(1);
        } else {
          m.redisConnected.set(0);
        }
      } catch {
        m.redisConnected.set(0);
      }
    } catch (err) {
      logger.warn({ err }, 'metrics poller tick failed');
    }
  };

  void tick();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopMetricsPollers(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
