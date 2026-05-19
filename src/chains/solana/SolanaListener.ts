import { Connection, PublicKey } from '@solana/web3.js';
import { Chain } from '@prisma/client';
import type {
  ChainListener,
  RawTransactionEvent,
  WatchedAddress,
} from '../ChainListener.js';
import { logger } from '../../config/logger.js';

/**
 * Baseline Solana listener using onLogs subscriptions (one per watched address).
 * For production scale switch to Yellowstone gRPC (geyser) — see TODO below.
 */
export class SolanaListener implements ChainListener {
  readonly chain: Chain = Chain.SOLANA;
  private readonly rpcUrl: string;
  private connection?: Connection;
  private readonly subs = new Map<string, { walletId: string; subId: number }>();
  private handler: ((ev: RawTransactionEvent) => void | Promise<void>) | null = null;

  constructor(opts: { rpcUrl: string }) {
    this.rpcUrl = opts.rpcUrl;
  }

  onTx(handler: (ev: RawTransactionEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(addresses: WatchedAddress[]): Promise<void> {
    this.connection = new Connection(this.rpcUrl, { commitment: 'confirmed' });
    for (const a of addresses) await this.watch(a.address, a.walletId);
    logger.info({ chain: this.chain, count: addresses.length }, 'solana listener started');
  }

  async stop(): Promise<void> {
    if (!this.connection) return;
    for (const { subId } of this.subs.values()) {
      await this.connection.removeOnLogsListener(subId).catch(() => undefined);
    }
    this.subs.clear();
    this.connection = undefined;
  }

  async watch(address: string, walletId: string): Promise<void> {
    if (!this.connection) throw new Error('solana listener not started');
    if (this.subs.has(address)) return;
    const pubkey = new PublicKey(address);
    const subId = this.connection.onLogs(
      pubkey,
      (logInfo, ctx) => {
        if (!this.handler) return;
        void this.handler({
          chain: this.chain,
          hash: logInfo.signature,
          blockNumber: BigInt(ctx.slot),
          from: address,
          to: address,
          raw: { kind: 'sol_logs', logs: logInfo.logs, err: logInfo.err },
          receivedAt: Date.now(),
        });
      },
      'confirmed',
    );
    this.subs.set(address, { walletId, subId });
  }

  async unwatch(address: string): Promise<void> {
    const entry = this.subs.get(address);
    if (!entry || !this.connection) return;
    await this.connection.removeOnLogsListener(entry.subId).catch(() => undefined);
    this.subs.delete(address);
  }
}

// TODO: Yellowstone gRPC adapter for higher throughput + program-level filtering.
