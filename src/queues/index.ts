import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis, { type Redis as RedisType } from 'ioredis';
import { env } from '../config/env.js';

// Dedicated IORedis instance for BullMQ. BullMQ requires maxRetriesPerRequest:null
// for blocking commands (BLPOP); we keep this connection isolated from the
// liveness/metrics path so a stuck BLPOP can't masquerade as a ping failure.
export const connection: RedisType = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Separate client for short-lived ops (pings, ad-hoc commands). Cheap to keep.
export const metaConnection: RedisType = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
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
