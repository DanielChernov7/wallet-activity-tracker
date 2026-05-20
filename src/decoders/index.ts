import { Chain } from '@prisma/client';
import type { DecodedCall } from './types.js';
import { decodeCall } from './abiDecoder.js';
import { decodeJupiterCall, type SolanaInstructionInput } from './jupiterDecoder.js';
import { CHAIN_ID_SOLANA } from './types.js';

export * from './types.js';
export { decodeCall } from './abiDecoder.js';
export { decodeUniswapV2 } from './uniswapV2Decoder.js';
export { decodeUniswapV3, decodeV3Path } from './uniswapV3Decoder.js';
export { decodeJupiterCall, JUPITER_PROGRAM_ID } from './jupiterDecoder.js';

const CHAIN_TO_ID: Record<Chain, number> = {
  ETHEREUM: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  SOLANA: CHAIN_ID_SOLANA,
};

export function chainIdOf(chain: Chain): number {
  return CHAIN_TO_ID[chain];
}

export type DispatchInput =
  | { kind: 'evm'; to: string; data: string; chainId: number }
  | { kind: 'solana'; input: SolanaInstructionInput };

export function dispatchDecode(input: DispatchInput): DecodedCall | null {
  if (input.kind === 'evm') return decodeCall(input.to, input.data, input.chainId);
  return decodeJupiterCall(input.input);
}
