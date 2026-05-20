import { describe, it, expect } from 'vitest';
import { buildMetrics } from '../../src/metrics/index.js';

async function findMetric(reg: ReturnType<typeof buildMetrics>['registry'], name: string) {
  const json = await reg.getMetricsAsJSON();
  return json.find((m) => m.name === name);
}

describe('metrics', () => {
  it('exposes the documented counter, histogram and gauge families', async () => {
    const m = buildMetrics();
    const text = await m.registry.metrics();
    expect(text).toContain('wat_transactions_processed_total');
    expect(text).toContain('wat_alerts_fired_total');
    expect(text).toContain('wat_rpc_requests_total');
    expect(text).toContain('wat_enrichment_duration_seconds');
    expect(text).toContain('wat_notification_duration_seconds');
    expect(text).toContain('wat_wallets_monitored');
    expect(text).toContain('wat_queue_size');
    expect(text).toContain('wat_redis_connected');
  });

  it('increments transactions_processed_total with labels', async () => {
    const m = buildMetrics();
    m.transactionsProcessed.inc({ chain: 'ETHEREUM', tx_type: 'SWAP', status: 'ok' });
    m.transactionsProcessed.inc({ chain: 'ETHEREUM', tx_type: 'SWAP', status: 'ok' });
    m.transactionsProcessed.inc({ chain: 'SOLANA', tx_type: 'UNKNOWN', status: 'ok' });

    const metric = await findMetric(m.registry, 'wat_transactions_processed_total');
    const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
    const ethSwap = values.find(
      (v) => v.labels.chain === 'ETHEREUM' && v.labels.tx_type === 'SWAP' && v.labels.status === 'ok',
    );
    expect(ethSwap?.value).toBe(2);
  });

  it('histogram observe accepts valid labels and records into buckets', async () => {
    const m = buildMetrics();
    expect(() => m.enrichmentDuration.observe({ chain: 'BASE' }, 0.42)).not.toThrow();
    m.enrichmentDuration.observe({ chain: 'BASE' }, 1.2);

    const metric = await findMetric(m.registry, 'wat_enrichment_duration_seconds');
    expect(metric).toBeDefined();
    const countSample = (metric?.values ?? []).find(
      (v: any) => v.metricName?.endsWith('_count') && v.labels.chain === 'BASE',
    ) as { value?: number } | undefined;
    expect(countSample?.value).toBe(2);
  });

  it('gauge set/inc/dec moves value correctly', async () => {
    const m = buildMetrics();
    m.walletsMonitored.set({ chain: 'ETHEREUM' }, 5);
    m.walletsMonitored.inc({ chain: 'ETHEREUM' }, 2);
    m.walletsMonitored.dec({ chain: 'ETHEREUM' }, 1);

    const metric = await findMetric(m.registry, 'wat_wallets_monitored');
    const v = (metric?.values ?? []).find((x) => x.labels.chain === 'ETHEREUM') as
      | { value: number }
      | undefined;
    expect(v?.value).toBe(6);
  });

  it('two registries built via buildMetrics are isolated', async () => {
    const a = buildMetrics();
    const b = buildMetrics();
    a.alertsFired.inc({ channel: 'telegram', condition: 'amount_gt' });
    const aMetric = await findMetric(a.registry, 'wat_alerts_fired_total');
    const bMetric = await findMetric(b.registry, 'wat_alerts_fired_total');
    expect((aMetric?.values ?? []).length).toBe(1);
    expect((bMetric?.values ?? []).length).toBe(0);
  });
});
