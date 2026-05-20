import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { CommandContext } from '../context.js';
import { shortAddress } from '../address.js';

export type StatusDeps = {
  prisma: PrismaClient;
  logger: Logger;
};

export function makeStatusCommand(deps: StatusDeps) {
  return async function statusHandler(ctx: CommandContext): Promise<void> {
    const wallets = await deps.prisma.wallet.findMany({
      where: { telegramChatId: ctx.chatId, active: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    if (wallets.length === 0) {
      await ctx.reply('No wallets tracked. Use /watch <address>.');
      return;
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const lines = await Promise.all(
      wallets.map(async (w) => {
        const [count24h, latest] = await Promise.all([
          deps.prisma.transaction.count({
            where: { walletId: w.id, createdAt: { gte: since } },
          }),
          deps.prisma.transaction.findFirst({
            where: { walletId: w.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
        ]);
        const last = latest ? ago(latest.createdAt) : 'never';
        const label = w.label ? ` · <i>${escape(w.label)}</i>` : '';
        return `• <b>${w.chain}</b> ${shortAddress(w.address)}${label}\n   24h: <b>${count24h}</b> · last: ${last}`;
      }),
    );

    await ctx.reply(
      [`<b>Tracking ${wallets.length} wallet(s)</b>`, ...lines].join('\n'),
      { parse_mode: 'HTML' },
    );
  };
}

function ago(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
