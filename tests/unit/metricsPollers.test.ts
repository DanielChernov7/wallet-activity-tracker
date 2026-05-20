import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub queues so the poller can compute depths and a controllable ping.
const pingMock = vi.fn<[], Promise<string>>();

vi.mock('../../src/queues/index.js', () => ({
  rawTxQueue: { getWaitingCount: async () => 0, getActiveCount: async () => 0 },
  enrichQueue: { getWaitingCount: async () => 0, getActiveCount: async () => 0 },
  notifyQueue: { getWaitingCount: async () => 0, getActiveCount: async () => 0 },
  metaConnection: { ping: () => pingMock() },
}));

vi.mock('../../src/db/prisma.js', () => ({
  prisma: { wallet: { groupBy: async () => [] } },
}));

import { startMetricsPollers, stopMetricsPollers } from '../../src/metrics/pollers.js';
import { metrics } from '../../src/metrics/index.js';

async function readGauge(name: string): Promise<number | undefined> {
  const json = await metrics().registry.getMetricsAsJSON();
  const found = json.find((m) => m.name === name);
  const v = found?.values?.[0] as { value?: number } | undefined;
  return v?.value;
}

describe('metrics pollers — redis_connected gauge', () => {
  beforeEach(() => {
    pingMock.mockReset();
  });
  afterEach(() => {
    stopMetricsPollers();
  });

  it('sets gauge to 1 when ping resolves', async () => {
    pingMock.mockResolvedValueOnce('PONG');
    startMetricsPollers();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readGauge('wat_redis_connected')).toBe(1);
  });

  it('sets gauge to 0 when ping rejects', async () => {
    pingMock.mockRejectedValueOnce(new Error('redis down'));
    startMetricsPollers();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readGauge('wat_redis_connected')).toBe(0);
  });

  it('stopMetricsPollers clears the interval (no further ticks)', async () => {
    pingMock.mockResolvedValue('PONG');
    startMetricsPollers();
    await new Promise((r) => setTimeout(r, 20));
    const before = pingMock.mock.calls.length;
    stopMetricsPollers();
    await new Promise((r) => setTimeout(r, 60));
    expect(pingMock.mock.calls.length).toBe(before);
  });
});
