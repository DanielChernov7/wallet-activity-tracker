import { ethers } from 'ethers';
import { Chain } from '@prisma/client';
import type {
  ChainListener,
  RawTransactionEvent,
  WatchedAddress,
} from '../ChainListener.js';
import { logger } from '../../config/logger.js';
import { metrics } from '../../metrics/index.js';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const erc20Iface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export type EvmListenerOptions = {
  chain: Chain;
  wssUrl: string;
};

export class EvmListener implements ChainListener {
  readonly chain: Chain;
  private readonly wssUrl: string;
  private provider?: ethers.WebSocketProvider;
  private readonly watched = new Map<string, string>(); // address(lowercase) -> walletId
  private handler: ((ev: RawTransactionEvent) => void | Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(opts: EvmListenerOptions) {
    this.chain = opts.chain;
    this.wssUrl = opts.wssUrl;
  }

  onTx(handler: (ev: RawTransactionEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(addresses: WatchedAddress[]): Promise<void> {
    for (const a of addresses) {
      this.watched.set(a.address.toLowerCase(), a.walletId);
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.provider?.destroy();
    this.provider = undefined;
  }

  async watch(address: string, walletId: string): Promise<void> {
    this.watched.set(address.toLowerCase(), walletId);
  }

  async unwatch(address: string): Promise<void> {
    this.watched.delete(address.toLowerCase());
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const provider = new ethers.WebSocketProvider(this.wssUrl);
    this.provider = provider;

    // Listen to ERC20 Transfer logs; addresses are filtered in handler.
    provider.on(
      { topics: [ERC20_TRANSFER_TOPIC] },
      (log: ethers.Log) => void this.handleLog(log),
    );

    // Native value transfers: tap every block, fetch txs that touch watched.
    provider.on('block', (blockNumber: number) => void this.handleBlock(blockNumber));

    const ws = (provider.websocket as unknown as { on?: (e: string, cb: () => void) => void });
    ws.on?.('close', () => this.scheduleReconnect());
    ws.on?.('error', () => this.scheduleReconnect());

    this.reconnectAttempts = 0;
    logger.info({ chain: this.chain }, 'evm listener connected');
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts++);
    logger.warn({ chain: this.chain, delay }, 'evm ws closed, reconnecting');
    setTimeout(() => void this.connect().catch(() => this.scheduleReconnect()), delay);
  }

  private async handleLog(log: ethers.Log): Promise<void> {
    try {
      const parsed = erc20Iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;
      const from = String(parsed.args.from).toLowerCase();
      const to = String(parsed.args.to).toLowerCase();
      const watchedId = this.watched.get(from) ?? this.watched.get(to);
      if (!watchedId) return;

      await this.emit({
        chain: this.chain,
        hash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
        from,
        to,
        raw: {
          kind: 'erc20_transfer',
          tokenContract: log.address,
          value: String(parsed.args.value),
          log,
        },
        receivedAt: Date.now(),
      });
    } catch (err) {
      logger.error({ err, chain: this.chain }, 'failed to parse erc20 log');
    }
  }

  private async handleBlock(blockNumber: number): Promise<void> {
    if (!this.provider || this.watched.size === 0) return;
    const m = metrics();
    try {
      const block = await this.provider.getBlock(blockNumber, true);
      m.rpcRequests.inc({ chain: this.chain, method: 'eth_getBlockByNumber', status: 'ok' });
      if (!block) return;
      for (const tx of block.prefetchedTransactions ?? []) {
        const from = tx.from?.toLowerCase() ?? '';
        const to = tx.to?.toLowerCase() ?? '';
        if (!this.watched.has(from) && !this.watched.has(to)) continue;

        await this.emit({
          chain: this.chain,
          hash: tx.hash,
          blockNumber: BigInt(blockNumber),
          from,
          to,
          raw: {
            kind: 'native',
            value: tx.value.toString(),
            data: tx.data,
            gasPrice: tx.gasPrice?.toString(),
          },
          receivedAt: Date.now(),
        });
      }
    } catch (err) {
      m.rpcRequests.inc({ chain: this.chain, method: 'eth_getBlockByNumber', status: 'error' });
      logger.error({ err, chain: this.chain, blockNumber }, 'failed to scan block');
    }
  }

  private async emit(ev: RawTransactionEvent): Promise<void> {
    if (!this.handler) return;
    await this.handler(ev);
  }
}
