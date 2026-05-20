import { Telegraf } from 'telegraf';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let bot: Telegraf | null = null;

export function getTelegramBot(): Telegraf | null {
  if (bot) return bot;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  return bot;
}

export async function sendTelegram(text: string, chatId?: string): Promise<void> {
  const b = getTelegramBot();
  const target = chatId ?? env.TELEGRAM_CHAT_ID;
  if (!b || !target) {
    logger.warn('telegram not configured, skipping');
    return;
  }
  await b.telegram.sendMessage(target, text, { parse_mode: 'HTML' });
}

export function formatTxMessage(payload: {
  alert: { name: string };
  tx: {
    chain: string;
    type: string;
    hash: string;
    from: string;
    to: string;
    fromLabel?: string;
    toLabel?: string;
    valueUsd?: number;
    tokenSymbol?: string;
    tokenAmount?: string;
  };
}): string {
  const { alert, tx } = payload;
  const usd = tx.valueUsd ? `$${tx.valueUsd.toFixed(2)}` : 'n/a';
  return [
    `<b>${escapeHtml(alert.name)}</b>`,
    `Chain: <code>${tx.chain}</code>  Type: <code>${tx.type}</code>`,
    `From: ${renderParty(tx.from, tx.fromLabel)}`,
    `To: ${renderParty(tx.to, tx.toLabel)}`,
    tx.tokenSymbol ? `Token: <code>${tx.tokenSymbol}</code>  Amount: <code>${tx.tokenAmount}</code>` : '',
    `Value: <b>${usd}</b>`,
    `Tx: <code>${tx.hash}</code>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderParty(address: string, label?: string): string {
  if (label) return `<b>${escapeHtml(label)}</b> (<code>${address}</code>)`;
  return `<code>${address}</code>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
