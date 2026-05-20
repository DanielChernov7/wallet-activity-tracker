import type { Context, NarrowedContext, Types } from 'telegraf';

export type BotContext = Context & {
  /** Caller's chat id as string; available inside command handlers. */
  chatId: string;
};

export type CommandContext = NarrowedContext<
  BotContext,
  Types.MountMap['text']
>;
