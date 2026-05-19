import type { Chain } from '@prisma/client';

export type WatchedAddress = {
  address: string;
  walletId: string;
};

export type RawTransactionEvent = {
  chain: Chain;
  hash: string;
  blockNumber?: bigint;
  from: string;
  to: string;
  raw: unknown;
  receivedAt: number;
};

/**
 * Strategy interface for per-chain listeners.
 * Each chain implements connect/disconnect and emits raw tx events via onTx.
 */
export interface ChainListener {
  readonly chain: Chain;

  start(addresses: WatchedAddress[]): Promise<void>;
  stop(): Promise<void>;

  watch(address: string, walletId: string): Promise<void>;
  unwatch(address: string): Promise<void>;

  onTx(handler: (ev: RawTransactionEvent) => void | Promise<void>): void;
}
