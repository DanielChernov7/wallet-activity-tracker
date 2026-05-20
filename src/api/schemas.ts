import { z } from 'zod';
import { Chain } from '@prisma/client';
import { parseAddress } from '../bot/address.js';

export const ChainEnum = z.nativeEnum(Chain);

/** EVM checksum / Solana base58 — same validator the bot uses. */
const AddressSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      parseAddress(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid address: ${(err as Error).message}`,
      });
    }
  });

export const CreateWalletSchema = z.object({
  address: AddressSchema,
  chain: ChainEnum,
  label: z.string().min(1).max(64).optional(),
});
export type CreateWalletInput = z.infer<typeof CreateWalletSchema>;

export const AlertConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('amount_gt'), valueUsd: z.number().finite() }),
  z.object({ type: z.literal('contract_interaction'), contract: z.string().min(1) }),
  z.object({
    type: z.literal('unusual_activity'),
    windowSec: z.number().int().positive(),
    minCount: z.number().int().positive(),
  }),
]);
export type AlertConditionInput = z.infer<typeof AlertConditionSchema>;

export const AlertChannelsSchema = z
  .object({
    telegram: z.boolean().optional(),
    telegramChatId: z.string().optional(),
    webhook: z.string().url().optional(),
    websocket: z.boolean().optional(),
  })
  .refine(
    (c) => Boolean(c.telegram || c.webhook || c.websocket),
    { message: 'at least one channel must be enabled' },
  );
export type AlertChannelsInput = z.infer<typeof AlertChannelsSchema>;

export const CreateAlertSchema = z.object({
  walletId: z.string().min(1),
  name: z.string().min(1).max(120),
  condition: AlertConditionSchema,
  channels: AlertChannelsSchema,
});
export type CreateAlertInput = z.infer<typeof CreateAlertSchema>;
