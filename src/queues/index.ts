import { Queue, QueueEvents, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

export const connection: ConnectionOptions = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const QUEUES = {
  RAW_TX: 'raw_transactions',
  ENRICH: 'parse_and_enrich',
  NOTIFY: 'notify',
} as const;

export type RawTxJob = {
  chain: 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'SOLANA';
  hash: string;
  raw: unknown;
  receivedAt: number;
};

export type EnrichJob = {
  rawTxId: string;
};

export type NotifyJob = {
  alertId: string;
  transactionId: string;
  payload: Record<string, unknown>;
};

const defaultJobOpts = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
};

export const rawTxQueue = new Queue<RawTxJob>(QUEUES.RAW_TX, {
  connection,
  defaultJobOptions: defaultJobOpts,
});

export const enrichQueue = new Queue<EnrichJob>(QUEUES.ENRICH, {
  connection,
  defaultJobOptions: defaultJobOpts,
});

export const notifyQueue = new Queue<NotifyJob>(QUEUES.NOTIFY, {
  connection,
  defaultJobOptions: defaultJobOpts,
});

export { Worker, QueueEvents };
