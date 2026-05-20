import { describe, it, expect, vi } from 'vitest';
import { Chain } from '@prisma/client';
import { makeWatchCommand } from '../../src/bot/commands/watch.js';

function makeCtx(text: string, chatId = '12345') {
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    chatId,
    message: { text },
    reply,
  } as any;
}

function makePrisma() {
  return {
    wallet: {
      upsert: vi.fn().mockResolvedValue({
        id: 'wallet-1',
        chain: Chain.ETHEREUM,
        address: '0xabc',
        label: null,
      }),
    },
  } as any;
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

describe('bot /watch', () => {
  it('upserts EVM wallet with checksum normalised to lowercase', async () => {
    const prisma = makePrisma();
    const handler = makeWatchCommand({ prisma, logger });
    // valid checksum address (Vitalik)
    const ctx = makeCtx('/watch 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');

    await handler(ctx);

    expect(prisma.wallet.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.wallet.upsert.mock.calls[0][0];
    expect(call.where.chain_address.chain).toBe(Chain.ETHEREUM);
    expect(call.where.chain_address.address).toBe(
      '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    );
    expect(call.create.telegramChatId).toBe('12345');
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it('rejects invalid address and does not touch DB', async () => {
    const prisma = makePrisma();
    const handler = makeWatchCommand({ prisma, logger });
    const ctx = makeCtx('/watch 0xdeadbeef');

    await handler(ctx);

    expect(prisma.wallet.upsert).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^Invalid address:/));
  });

  it('parses Solana base58 address without hint', async () => {
    const prisma = makePrisma();
    prisma.wallet.upsert.mockResolvedValueOnce({
      id: 'w2',
      chain: Chain.SOLANA,
      address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      label: null,
    });
    const handler = makeWatchCommand({ prisma, logger });
    const ctx = makeCtx('/watch JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

    await handler(ctx);

    const call = prisma.wallet.upsert.mock.calls[0][0];
    expect(call.where.chain_address.chain).toBe(Chain.SOLANA);
  });

  it('treats trailing tokens after chain as label', async () => {
    const prisma = makePrisma();
    const handler = makeWatchCommand({ prisma, logger });
    const ctx = makeCtx(
      '/watch 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ETH vitalik wallet',
    );

    await handler(ctx);
    expect(prisma.wallet.upsert.mock.calls[0][0].create.label).toBe('vitalik wallet');
  });

  it('shows usage when no args', async () => {
    const prisma = makePrisma();
    const handler = makeWatchCommand({ prisma, logger });
    const ctx = makeCtx('/watch');

    await handler(ctx);
    expect(prisma.wallet.upsert).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });
});
