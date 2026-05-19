import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  ETH_WSS_URL: z.string().optional(),
  BASE_WSS_URL: z.string().optional(),
  ARBITRUM_WSS_URL: z.string().optional(),

  SOLANA_RPC_URL: z.string().optional(),
  YELLOWSTONE_GRPC_URL: z.string().optional(),
  YELLOWSTONE_GRPC_TOKEN: z.string().optional(),

  COINGECKO_API_KEY: z.string().optional(),
  JUPITER_PRICE_URL: z.string().default('https://price.jup.ag/v6/price'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
