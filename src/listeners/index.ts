import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { ChainListener } from '../chains/ChainListener.js';
import { SolanaListener } from '../chains/solana/SolanaListener.js';
import { SolanaGrpcListener } from './SolanaGrpcListener.js';

export { SolanaGrpcListener } from './SolanaGrpcListener.js';

export function createSolanaListener(walletAddresses: string[] = []): ChainListener {
  if (env.YELLOWSTONE_ENDPOINT) {
    logger.info({ endpoint: env.YELLOWSTONE_ENDPOINT }, 'using Yellowstone gRPC for Solana');
    return new SolanaGrpcListener({
      endpoint: env.YELLOWSTONE_ENDPOINT,
      xToken: env.YELLOWSTONE_TOKEN ?? '',
      walletAddresses,
    });
  }
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error('No Solana listener configured: set YELLOWSTONE_ENDPOINT or SOLANA_RPC_URL');
  }
  logger.info('using onLogs fallback for Solana');
  return new SolanaListener({ rpcUrl });
}
