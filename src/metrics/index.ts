import * as prom from 'prom-client';

const PREFIX = 'wat_';

export type MetricsRegistry = {
  registry: prom.Registry;
  transactionsProcessed: prom.Counter<'chain' | 'tx_type' | 'status'>;
  alertsFired: prom.Counter<'channel' | 'condition'>;
  rpcRequests: prom.Counter<'chain' | 'method' | 'status'>;
  enrichmentDuration: prom.Histogram<'chain'>;
  notificationDuration: prom.Histogram<'channel'>;
  walletsMonitored: prom.Gauge<'chain'>;
  queueSize: prom.Gauge<'queue_name'>;
  redisConnected: prom.Gauge<string>;
};

/**
 * Build a fresh metrics registry. The application uses a process-wide
 * singleton (see {@link metrics}), but tests build their own isolated
 * Registry via this factory so concurrent tests don't share state.
 */
export function buildMetrics(): MetricsRegistry {
  const registry = new prom.Registry();
  prom.collectDefaultMetrics({ register: registry, prefix: PREFIX });

  const transactionsProcessed = new prom.Counter({
    name: `${PREFIX}transactions_processed_total`,
    help: 'Number of raw transactions processed by the pipeline',
    labelNames: ['chain', 'tx_type', 'status'] as const,
    registers: [registry],
  });

  const alertsFired = new prom.Counter({
    name: `${PREFIX}alerts_fired_total`,
    help: 'Number of alerts successfully delivered or attempted',
    labelNames: ['channel', 'condition'] as const,
    registers: [registry],
  });

  const rpcRequests = new prom.Counter({
    name: `${PREFIX}rpc_requests_total`,
    help: 'Number of RPC calls by chain, method and status',
    labelNames: ['chain', 'method', 'status'] as const,
    registers: [registry],
  });

  const enrichmentDuration = new prom.Histogram({
    name: `${PREFIX}enrichment_duration_seconds`,
    help: 'Time spent enriching a transaction',
    labelNames: ['chain'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const notificationDuration = new prom.Histogram({
    name: `${PREFIX}notification_duration_seconds`,
    help: 'Time spent dispatching a single notification',
    labelNames: ['channel'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const walletsMonitored = new prom.Gauge({
    name: `${PREFIX}wallets_monitored`,
    help: 'Number of active wallets being monitored, per chain',
    labelNames: ['chain'] as const,
    registers: [registry],
  });

  const queueSize = new prom.Gauge({
    name: `${PREFIX}queue_size`,
    help: 'Approximate BullMQ queue depth (waiting + active)',
    labelNames: ['queue_name'] as const,
    registers: [registry],
  });

  const redisConnected = new prom.Gauge({
    name: `${PREFIX}redis_connected`,
    help: 'Whether Redis is reachable (1) or not (0)',
    registers: [registry],
  });

  return {
    registry,
    transactionsProcessed,
    alertsFired,
    rpcRequests,
    enrichmentDuration,
    notificationDuration,
    walletsMonitored,
    queueSize,
    redisConnected,
  };
}

let singleton: MetricsRegistry | null = null;
export function metrics(): MetricsRegistry {
  singleton ??= buildMetrics();
  return singleton;
}
