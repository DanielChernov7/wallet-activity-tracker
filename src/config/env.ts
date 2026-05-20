import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(v)))
  .default(false);

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  ETH_WSS_URL: z.string().optional(),
  ETH_HTTP_URL: z.string().optional(),
  BASE_WSS_URL: z.string().optional(),
  BASE_HTTP_URL: z.string().optional(),
  ARBITRUM_WSS_URL: z.string().optional(),
  ARBITRUM_HTTP_URL: z.string().optional(),

  SOLANA_RPC_URL: z.string().optional(),
  YELLOWSTONE_GRPC_URL: z.string().optional(),
  YELLOWSTONE_GRPC_TOKEN: z.string().optional(),
  YELLOWSTONE_ENDPOINT: z.string().optional(),
  YELLOWSTONE_TOKEN: z.string().optional(),

  COINGECKO_API_KEY: z.string().optional(),
  JUPITER_PRICE_URL: z.string().default('https://price.jup.ag/v6/price'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),

  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  ERC20_CACHE_ENABLED: boolish,
  MULTICALL3_ADDRESS: z
    .string()
    .default('0xcA11bde05977b3631167028862bE2a173976CA11'),

  LABEL_CACHE_REDIS_ENABLED: boolish,

  METRICS_AUTH_USER: z.string().optional(),
  METRICS_AUTH_PASS: z.string().optional(),

  API_KEYS: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
