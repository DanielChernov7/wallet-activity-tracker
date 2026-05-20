import { Telegraf } from 'telegraf';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import type { BotContext } from './context.js';
import { makeWatchCommand } from './commands/watch.js';
import { makeUnwatchCommand } from './commands/unwatch.js';
import { makeAlertsCommand } from './commands/alerts.js';
import { makeStatusCommand } from './commands/status.js';

const TokenSchema = z.string().min(20, 'TELEGRAM_BOT_TOKEN is required to run the bot');

export function buildBot(): Telegraf<BotContext> {
  const token = TokenSchema.parse(env.TELEGRAM_BOT_TOKEN);
  const bot = new Telegraf<BotContext>(token);
  const allowed = parseAllowlist(env.TELEGRAM_ALLOWED_USER_IDS);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (allowed && userId !== undefined && !allowed.has(userId)) {
      logger.warn({ userId }, 'unauthorized telegram user denied');
      await ctx.reply('You are not authorized to use this bot.');
      return;
    }
    const chatId = ctx.chat?.id ?? userId;
    if (chatId === undefined) return next();
    (ctx as BotContext).chatId = String(chatId);
    return next();
  });

  const deps = { prisma, logger };
  bot.command('watch', makeWatchCommand(deps));
  bot.command('unwatch', makeUnwatchCommand(deps));
  bot.command('alerts', makeAlertsCommand(deps));
  bot.command('status', makeStatusCommand(deps));

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Commands:',
        '/watch <address> [chain] [label] — start tracking',
        '/unwatch <address> [chain] — stop tracking',
        '/alerts <address> [chain] — last 10 alert events',
        '/status — wallets you track + 24h activity',
      ].join('\n'),
    );
  });

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, 'bot handler crashed');
  });

  return bot;
}

function parseAllowlist(raw: string | undefined): Set<number> | null {
  if (!raw || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return new Set(ids);
}

async function main(): Promise<void> {
  const bot = buildBot();
  await bot.launch();
  logger.info('telegram bot launched');

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'stopping telegram bot');
    bot.stop(signal);
    void prisma.$disconnect().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry && import.meta.url === `file://${entry}`) {
  main().catch((err) => {
    logger.fatal({ err }, 'bot failed to start');
    process.exit(1);
  });
}
