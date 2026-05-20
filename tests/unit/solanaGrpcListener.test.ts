import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

vi.mock('../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SolanaGrpcListener } from '../../src/listeners/SolanaGrpcListener.js';
import type {
  YellowstoneClientLike,
  YellowstoneStream,
  SubscribeUpdate,
} from '../../src/listeners/SolanaGrpcListener.js';

function makeStream() {
  const ee = new EventEmitter();
  const stream: YellowstoneStream & { ee: EventEmitter; written: unknown[]; ended: boolean } = {
    ee,
    written: [],
    ended: false,
    on: ee.on.bind(ee) as YellowstoneStream['on'],
    write: vi.fn(async (req: unknown) => {
      (stream as any).written.push(req);
      return true;
    }),
    end: vi.fn(() => {
      stream.ended = true;
      queueMicrotask(() => ee.emit('end'));
    }),
    destroy: vi.fn(),
  };
  return stream;
}

function makeClient(stream: ReturnType<typeof makeStream>): YellowstoneClientLike {
  return { subscribe: vi.fn(async () => stream as unknown as YellowstoneStream) };
}

// Helper: build a SubscribeUpdate for a transfer between two accounts.
function buildTransferUpdate(args: {
  fromBase58: string;
  toBase58: string;
  signatureBytes: Uint8Array;
  slot: number;
  isVote?: boolean;
  failed?: boolean;
}): SubscribeUpdate {
  const fromKey = new PublicKey(args.fromBase58).toBytes();
  const toKey = new PublicKey(args.toBase58).toBytes();
  return {
    filters: ['wat_filter'],
    transaction: {
      slot: args.slot,
      transaction: {
        signature: args.signatureBytes,
        isVote: args.isVote ?? false,
        transaction: {
          signatures: [args.signatureBytes],
          message: { accountKeys: [fromKey, toKey] },
        },
        meta: args.failed
          ? { err: { InsufficientFundsForRent: {} } }
          : {
              err: null,
              preBalances: ['1000000', '500000'],
              postBalances: ['900000', '600000'],
              preTokenBalances: [],
              postTokenBalances: [],
            },
      },
    },
  };
}

const WATCHED = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // Binance Solana
const OTHER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SIG = new Uint8Array(64).fill(7);

describe('SolanaGrpcListener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes with the documented filter shape', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      walletAddresses: [WATCHED],
      clientFactory: () => client,
    });

    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    expect(stream.write).toHaveBeenCalledOnce();
    const req = (stream.write as any).mock.calls[0][0];
    expect(req.transactions.wat_filter).toMatchObject({
      vote: false,
      failed: false,
      accountInclude: expect.arrayContaining([WATCHED]),
      accountExclude: [],
      accountRequired: [],
    });
    await listener.stop();
  });

  it('emits a RawTransactionEvent when a watched wallet shows up in accountKeys', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: () => client,
    });

    const onTx = vi.fn();
    listener.onTx(onTx);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    stream.ee.emit(
      'data',
      buildTransferUpdate({ fromBase58: WATCHED, toBase58: OTHER, signatureBytes: SIG, slot: 42 }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).toHaveBeenCalledOnce();
    const ev = onTx.mock.calls[0]![0];
    expect(ev.chain).toBe('SOLANA');
    expect(ev.hash).toBe(bs58.encode(SIG));
    expect(ev.blockNumber).toBe(42n);
    expect(ev.from).toBe(WATCHED); // watched lost lamports → it's the sender
    expect(ev.to).toBe(OTHER);
    expect((ev.raw as { kind: string }).kind).toBe('sol_grpc');

    await listener.stop();
  });

  it('skips vote transactions', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: () => client,
    });
    const onTx = vi.fn();
    listener.onTx(onTx);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    stream.ee.emit(
      'data',
      buildTransferUpdate({
        fromBase58: WATCHED,
        toBase58: OTHER,
        signatureBytes: SIG,
        slot: 1,
        isVote: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('skips failed transactions', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: () => client,
    });
    const onTx = vi.fn();
    listener.onTx(onTx);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    stream.ee.emit(
      'data',
      buildTransferUpdate({
        fromBase58: WATCHED,
        toBase58: OTHER,
        signatureBytes: SIG,
        slot: 1,
        failed: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('skips transactions that do not touch a watched wallet', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: () => client,
    });
    const onTx = vi.fn();
    listener.onTx(onTx);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    stream.ee.emit(
      'data',
      buildTransferUpdate({
        fromBase58: OTHER,
        toBase58: 'BPFLoaderUpgradeab1e11111111111111111111111',
        signatureBytes: SIG,
        slot: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('accepts an async clientFactory (ESM dynamic import path)', async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const asyncFactory = vi.fn(async () => {
      await Promise.resolve();
      return client;
    });
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: asyncFactory,
    });
    listener.onTx(() => undefined);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);
    expect(asyncFactory).toHaveBeenCalledOnce();
    expect(stream.write).toHaveBeenCalledOnce();
    await listener.stop();
  });

  it('after reconnect, events emitted on the old stream are ignored (no leak)', async () => {
    const stream1 = makeStream();
    const stream2 = makeStream();
    let call = 0;
    const client: YellowstoneClientLike = {
      subscribe: vi.fn(async () => {
        call++;
        return (call === 1 ? stream1 : stream2) as unknown as YellowstoneStream;
      }),
    };
    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: () => client,
    });
    const onTx = vi.fn();
    listener.onTx(onTx);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);

    // Trigger reconnect.
    stream1.ee.emit('error', new Error('reset'));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(client.subscribe).toHaveBeenCalledTimes(2);

    // Emit a valid transaction on the *old* stream — must be dropped.
    stream1.ee.emit(
      'data',
      buildTransferUpdate({
        fromBase58: WATCHED,
        toBase58: OTHER,
        signatureBytes: SIG,
        slot: 7,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).not.toHaveBeenCalled();

    // The new stream still delivers normally.
    stream2.ee.emit(
      'data',
      buildTransferUpdate({
        fromBase58: WATCHED,
        toBase58: OTHER,
        signatureBytes: SIG,
        slot: 8,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onTx).toHaveBeenCalledOnce();

    await listener.stop();
  });

  it('reconnects with exponential backoff on stream error', async () => {
    const stream1 = makeStream();
    const stream2 = makeStream();
    const factory = vi.fn();
    let call = 0;
    const client: YellowstoneClientLike = {
      subscribe: vi.fn(async () => {
        call++;
        return (call === 1 ? stream1 : stream2) as unknown as YellowstoneStream;
      }),
    };
    factory.mockReturnValue(client);

    const listener = new SolanaGrpcListener({
      endpoint: 'https://test',
      xToken: 't',
      clientFactory: factory as any,
    });
    listener.onTx(() => undefined);
    await listener.start([{ address: WATCHED, walletId: 'w1' }]);
    expect(client.subscribe).toHaveBeenCalledTimes(1);

    stream1.ee.emit('error', new Error('rpc reset'));
    // First reconnect backoff: 1000ms
    await vi.advanceTimersByTimeAsync(1_001);
    expect(client.subscribe).toHaveBeenCalledTimes(2);

    await listener.stop();
  });
});
