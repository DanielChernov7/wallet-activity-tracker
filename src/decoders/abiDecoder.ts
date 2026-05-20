import type { DecodedCall } from './types.js';
import { decodeUniswapV2 } from './uniswapV2Decoder.js';
import { decodeUniswapV3 } from './uniswapV3Decoder.js';

const EVM_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453, 42161]);

/**
 * Try every EVM router decoder we know about. The decoders are pure
 * selector-driven Interface lookups, so cost is trivial and order only
 * matters when a selector collides across protocols (none do today).
 */
export function decodeCall(to: string, data: string, chainId: number): DecodedCall | null {
  if (!EVM_CHAIN_IDS.has(chainId)) return null;
  if (!data || data === '0x' || data.length < 10) return null;
  void to; // reserved for protocol gating once selector collisions appear

  return decodeUniswapV3(data) ?? decodeUniswapV2(data) ?? null;
}
