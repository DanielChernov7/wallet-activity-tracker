import type { PrismaClient, TxType } from '@prisma/client';
import type { Logger } from 'pino';
import type { CommandContext } from '../context.js';
import { parseAddress, parseChain, shortAddress } from '../address.js';

const TYPE_EMOJI: Record<TxType, string> = {
  TRANSFER: '↗️',
  ERC20_TRANSFER: '🪙',
  SWAP: '🔄',
  NFT_MINT: '🎨',
  NFT_TRANSFER: '🖼️',
  CONTRACT_CALL: '⚙️',
  SOL_TRANSFER: '◎',
  SPL_TRANSFER: '🪙',
  UNKNOWN: '❓',
};

export type AlertsDeps = {
  prisma: PrismaClient;
  logger: Logger;
};

export function makeAlertsCommand(deps: AlertsDeps) {
  return async function alertsHandler(ctx: CommandContext): Promise<void> {
    const parts = (ctx.message.text ?? '').split(/\s+/).slice(1);
    if (parts.length === 0) {
      await ctx.reply('Usage: /alerts <address> [chain]');
      return;
    }
    let parsed;
    try {
      parsed = parseAddress(parts[0]!, parseChain(parts[1]));
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

    const events = await deps.prisma.alertEvent.findMany({
      where: { alert: { walletId: wallet.id } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { alert: { select: { name: true } } },
    });

    if (events.length === 0) {
      await ctx.reply(`No alert events yet for ${shortAddress(parsed.canonical)}.`);
      return;
    }

    const lines = events.map((e) => {
      const payload = e.payload as { tx?: { type?: TxType; valueUsd?: number } };
      const type = payload.tx?.type ?? 'UNKNOWN';
      const emoji = TYPE_EMOJI[type as TxType] ?? '❓';
      const usd = payload.tx?.valueUsd ? `$${payload.tx.valueUsd.toFixed(2)}` : '—';
      return `${emoji} <b>${escape(e.alert.name)}</b> · ${usd} · <i>${ago(e.createdAt)}</i>`;
    });

    await ctx.reply(
      [`<b>Last ${events.length} alerts</b> for ${shortAddress(parsed.canonical)}`, ...lines].join(
        '\n',
      ),
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
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
