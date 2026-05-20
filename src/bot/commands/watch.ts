import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { CommandContext } from '../context.js';
import type { Logger } from 'pino';
import { parseAddress, parseChain, shortAddress } from '../address.js';

const ArgsSchema = z
  .array(z.string())
  .min(1, 'usage: /watch <address> [chain] [label...]')
  .max(8);

export type WatchDeps = {
  prisma: PrismaClient;
  logger: Logger;
};

export function makeWatchCommand(deps: WatchDeps) {
  return async function watchHandler(ctx: CommandContext): Promise<void> {
    const text = ctx.message.text ?? '';
    const parts = text.split(/\s+/).slice(1);
    const args = ArgsSchema.safeParse(parts);
    if (!args.success) {
      await ctx.reply('Usage: /watch <address> [chain] [label...]');
      return;
    }

    const [addressRaw, maybeChain, ...labelParts] = args.data;
    const chainHint = parseChain(maybeChain);
    // If the second token didn't parse as chain, treat it as part of the label.
    const labelTokens = chainHint ? labelParts : (maybeChain ? [maybeChain, ...labelParts] : []);
    const label = labelTokens.join(' ').trim() || null;

    let parsed;
    try {
      parsed = parseAddress(addressRaw!, chainHint);
    } catch (err) {
      deps.logger.warn({ err, addressRaw }, 'watch: invalid address');
      await ctx.reply(`Invalid address: ${(err as Error).message}`);
      return;
    }

    const wallet = await deps.prisma.wallet.upsert({
      where: { chain_address: { chain: parsed.chain, address: parsed.canonical } },
      create: {
        chain: parsed.chain,
        address: parsed.canonical,
        label,
        telegramChatId: ctx.chatId,
        active: true,
      },
      update: {
        active: true,
        label: label ?? undefined,
        telegramChatId: ctx.chatId,
      },
    });

    deps.logger.info(
      { walletId: wallet.id, chain: wallet.chain, chatId: ctx.chatId },
      'wallet watched via bot',
    );

    await ctx.reply(
      [
        `Tracking <b>${parsed.chain}</b> ${shortAddress(parsed.canonical)}`,
        label ? `Label: <i>${escape(label)}</i>` : null,
        `id: <code>${wallet.id}</code>`,
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML' },
    );
  };
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
