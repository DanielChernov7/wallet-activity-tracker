import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { CommandContext } from '../context.js';
import { parseAddress, parseChain, shortAddress } from '../address.js';

export type UnwatchDeps = {
  prisma: PrismaClient;
  logger: Logger;
  onUnwatch?: (chain: string, address: string) => Promise<void> | void;
};

export function makeUnwatchCommand(deps: UnwatchDeps) {
  return async function unwatchHandler(ctx: CommandContext): Promise<void> {
    const text = ctx.message.text ?? '';
    const parts = text.split(/\s+/).slice(1);
    if (parts.length === 0) {
      await ctx.reply('Usage: /unwatch <address> [chain]');
      return;
    }
    const chainHint = parseChain(parts[1]);
    let parsed;
    try {
      parsed = parseAddress(parts[0]!, chainHint);
    } catch (err) {
      await ctx.reply(`Invalid address: ${(err as Error).message}`);
      return;
    }

    const wallet = await deps.prisma.wallet.findUnique({
      where: { chain_address: { chain: parsed.chain, address: parsed.canonical } },
    });
    if (!wallet) {
      await ctx.reply('Not tracked.');
      return;
    }
    if (wallet.telegramChatId && wallet.telegramChatId !== ctx.chatId) {
      await ctx.reply('This wallet is tracked by another user.');
      return;
    }

    await deps.prisma.wallet.update({
      where: { id: wallet.id },
      data: { active: false },
    });

    try {
      await deps.onUnwatch?.(parsed.chain, parsed.canonical);
    } catch (err) {
      deps.logger.warn({ err, walletId: wallet.id }, 'onUnwatch hook failed');
    }

    await ctx.reply(`Stopped tracking ${parsed.chain} ${shortAddress(parsed.canonical)}.`);
  };
}
