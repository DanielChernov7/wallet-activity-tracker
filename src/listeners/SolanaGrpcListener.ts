import { Chain } from '@prisma/client';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import type {
  ChainListener,
  RawTransactionEvent,
  WatchedAddress,
} from '../chains/ChainListener.js';
import { logger } from '../config/logger.js';
import { metrics } from '../metrics/index.js';

// The yellowstone client is typed loosely on purpose: the upstream package
// exports a default Client constructor and a SubscribeRequest type, but the
// runtime stream is a duplex node stream. We only need a tiny surface from it.
export type YellowstoneClientLike = {
  subscribe(): Promise<YellowstoneStream>;
};
export type YellowstoneStream = {
  write(req: unknown): Promise<void> | boolean;
  end?(): void;
  destroy?(): void;
  on(event: 'data', cb: (msg: SubscribeUpdate) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'end' | 'close', cb: () => void): void;
};

export type SubscribeUpdate = {
  filters?: string[];
  transaction?: SubscribeUpdateTransaction;
};
export type SubscribeUpdateTransaction = {
  slot?: string | bigint | number;
  transaction?: {
    signature?: Uint8Array;
    isVote?: boolean;
    transaction?: {
      signatures?: Uint8Array[];
      message?: { accountKeys?: Uint8Array[] };
    };
    meta?: {
      err?: unknown;
      preBalances?: (string | bigint | number)[];
      postBalances?: (string | bigint | number)[];
      preTokenBalances?: TokenBalance[];
      postTokenBalances?: TokenBalance[];
    };
  };
};
export type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

export type ClientFactory = (
  endpoint: string,
  xToken: string,
) => YellowstoneClientLike | Promise<YellowstoneClientLike>;

export type SolanaGrpcListenerOptions = {
  endpoint: string;
  xToken: string;
  walletAddresses?: string[];
  /** Injected only by tests — production code builds the real Yellowstone client. */
  clientFactory?: ClientFactory;
};

const FILTER_NAME = 'wat_filter';
const MAX_BACKOFF_MS = 30_000;

export class SolanaGrpcListener implements ChainListener {
  readonly chain: Chain = Chain.SOLANA;

  private readonly endpoint: string;
  private readonly xToken: string;
  private readonly clientFactory: ClientFactory;
  private readonly watched = new Map<string, string>(); // address -> walletId

  private client: YellowstoneClientLike | null = null;
  private stream: YellowstoneStream | null = null;
  private handler: ((ev: RawTransactionEvent) => void | Promise<void>) | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  /** Monotonic counter — stale handlers no-op when their generation != the current one. */
  private gen = 0;

  constructor(opts: SolanaGrpcListenerOptions) {
    this.endpoint = opts.endpoint;
    this.xToken = opts.xToken;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    for (const a of opts.walletAddresses ?? []) this.watched.set(a, a);
  }

  onTx(handler: (ev: RawTransactionEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(addresses: WatchedAddress[]): Promise<void> {
    for (const a of addresses) this.watched.set(a.address, a.walletId);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.teardownStream();
    this.client = null;
  }

  /** Detach listeners from the current stream and discard it. */
  private teardownStream(): void {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    // Bump generation so any in-flight handler from this stream becomes a no-op.
    this.gen++;
    try {
      const ee = s as unknown as { removeAllListeners?: () => void };
      ee.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      s.end?.();
    } catch {
      /* ignore */
    }
    try {
      s.destroy?.();
    } catch {
      /* ignore */
    }
  }

  async watch(address: string, walletId: string): Promise<void> {
    this.watched.set(address, walletId);
    // Re-subscribing with the new filter requires reconnecting.
    await this.refreshSubscription();
  }

  async unwatch(address: string): Promise<void> {
    if (!this.watched.delete(address)) return;
    await this.refreshSubscription();
  }

  /** Visible for tests — manually trigger one reconnect cycle. */
  async refreshSubscription(): Promise<void> {
    if (!this.stream) return;
    this.teardownStream();
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // Always start from a clean slate — kills any prior stream + its handlers.
    this.teardownStream();

    const m = metrics();
    const myGen = ++this.gen;
    try {
      this.client ??= await this.clientFactory(this.endpoint, this.xToken);
      const stream = await this.client.subscribe();
      this.stream = stream;

      const req = buildSubscribeRequest(Array.from(this.watched.keys()));
      await stream.write(req);
      m.rpcRequests.inc({ chain: this.chain, method: 'subscribe', status: 'ok' });

      // Generation guard — if the stream is replaced (reconnect, stop, refresh),
      // handlers from this connect attempt become no-ops instead of firing
      // against a stale stream reference.
      const isCurrent = (): boolean => myGen === this.gen && !this.stopped;

      stream.on('data', (msg) => {
        if (!isCurrent()) return;
        void this.handleMessage(msg);
      });
      stream.on('error', (err) => {
        if (!isCurrent()) return;
        m.rpcRequests.inc({ chain: this.chain, method: 'subscribe', status: 'error' });
        logger.warn({ err }, 'yellowstone stream error');
        this.scheduleReconnect();
      });
      stream.on('end', () => {
        if (!isCurrent()) return;
        this.scheduleReconnect();
      });
      stream.on('close', () => {
        if (!isCurrent()) return;
        this.scheduleReconnect();
      });

      this.reconnectAttempts = 0;
      logger.info({ wallets: this.watched.size, gen: myGen }, 'yellowstone subscribed');
    } catch (err) {
      m.rpcRequests.inc({ chain: this.chain, method: 'subscribe', status: 'error' });
      logger.error({ err }, 'yellowstone connect failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.pendingTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.reconnectAttempts++);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.stream = null;
      this.client = null;
      void this.connect();
    }, delay);
    this.pendingTimer.unref?.();
  }

  private async handleMessage(msg: SubscribeUpdate): Promise<void> {
    const upd = msg.transaction;
    if (!upd || !this.handler) return;
    const tx = upd.transaction;
    if (!tx) return;
    if (tx.isVote) return;
    if (tx.meta?.err != null && tx.meta.err !== undefined && tx.meta.err !== null) {
      // failed tx — defensive: explicit null check after meta.err
      if (tx.meta.err !== undefined) return;
    }
    if (tx.meta?.err) return;

    const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
      new PublicKey(k).toBase58(),
    );
    if (accountKeys.length === 0) return;

    const watchedHit = accountKeys.find((k) => this.watched.has(k));
    if (!watchedHit) return;

    const sigBytes = tx.signature ?? tx.transaction?.signatures?.[0];
    if (!sigBytes) return;
    const signature = bs58.encode(sigBytes);

    const slot = Number(upd.slot ?? 0);
    const deltas = computeBalanceDeltas(accountKeys, tx.meta);
    const watchedDelta = deltas.find((d) => d.address === watchedHit);
    const from = watchedDelta && watchedDelta.netLamports < 0n ? watchedHit : accountKeys[0]!;
    const to = watchedDelta && watchedDelta.netLamports < 0n ? accountKeys[0]! : watchedHit;

    await this.handler({
      chain: this.chain,
      hash: signature,
      blockNumber: BigInt(slot),
      from,
      to,
      raw: {
        kind: 'sol_grpc',
        signature,
        slot,
        accountKeys,
        deltas: deltas.map((d) => ({
          address: d.address,
          netLamports: d.netLamports.toString(),
          tokens: d.tokens.map((t) => ({
            mint: t.mint,
            owner: t.owner,
            net: t.net.toString(),
            decimals: t.decimals,
          })),
        })),
      },
      receivedAt: Date.now(),
    });
  }
}

async function defaultClientFactory(
  endpoint: string,
  xToken: string,
): Promise<YellowstoneClientLike> {
  // Dynamic import is required in ESM ("type": "module") and also avoids loading
  // the gRPC native bindings in test environments where the factory is mocked.
  const mod = (await import('@triton-one/yellowstone-grpc')) as unknown as {
    default?: new (e: string, t: string, opts?: object) => YellowstoneClientLike;
  } & { new?: never };
  const Ctor =
    (mod.default ?? (mod as unknown as new (e: string, t: string, opts?: object) => YellowstoneClientLike));
  return new Ctor(endpoint, xToken, {});
}

export function buildSubscribeRequest(addresses: string[]): {
  accounts: object;
  slots: object;
  transactions: Record<string, object>;
  blocks: object;
  blocksMeta: object;
  accountsDataSlice: unknown[];
} {
  return {
    accounts: {},
    slots: {},
    transactions: {
      [FILTER_NAME]: {
        vote: false,
        failed: false,
        accountInclude: addresses,
        accountExclude: [],
        accountRequired: [],
      },
    },
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
  };
}

type Delta = {
  address: string;
  netLamports: bigint;
  tokens: { mint: string; owner: string; net: bigint; decimals: number }[];
};

export function computeBalanceDeltas(
  accountKeys: string[],
  meta: SubscribeUpdateTransaction['transaction'] extends infer T
    ? T extends { meta?: infer M }
      ? M
      : never
    : never,
): Delta[] {
  const out: Delta[] = accountKeys.map((address) => ({ address, netLamports: 0n, tokens: [] }));
  if (!meta) return out;
  const pre = meta.preBalances ?? [];
  const post = meta.postBalances ?? [];
  for (let i = 0; i < accountKeys.length; i++) {
    const p = pre[i] !== undefined ? BigInt(pre[i] as string | number | bigint) : 0n;
    const q = post[i] !== undefined ? BigInt(post[i] as string | number | bigint) : 0n;
    out[i]!.netLamports = q - p;
  }
  const preTok = meta.preTokenBalances ?? [];
  const postTok = meta.postTokenBalances ?? [];
  const key = (b: TokenBalance) => `${b.accountIndex ?? -1}|${b.mint ?? ''}|${b.owner ?? ''}`;
  const preMap = new Map(preTok.map((b) => [key(b), b]));
  const postMap = new Map(postTok.map((b) => [key(b), b]));
  for (const [k, postBal] of postMap) {
    const preBal = preMap.get(k);
    const idx = postBal.accountIndex ?? -1;
    if (idx < 0 || idx >= out.length) continue;
    const before = preBal?.uiTokenAmount?.amount ? BigInt(preBal.uiTokenAmount.amount) : 0n;
    const after = postBal.uiTokenAmount?.amount ? BigInt(postBal.uiTokenAmount.amount) : 0n;
    const net = after - before;
    if (net === 0n) continue;
    out[idx]!.tokens.push({
      mint: postBal.mint ?? '',
      owner: postBal.owner ?? '',
      net,
      decimals: postBal.uiTokenAmount?.decimals ?? 0,
    });
  }
  return out;
}
