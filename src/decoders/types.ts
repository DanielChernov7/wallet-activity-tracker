export type Protocol = 'uniswap_v2' | 'uniswap_v3' | 'jupiter' | 'unknown';
export type Action = 'swap' | 'add_liquidity' | 'remove_liquidity' | 'unknown';

export interface DecodedToken {
  address: string;
  symbol?: string;
  amount: bigint;
}

export interface DecodedCall {
  protocol: Protocol;
  action: Action;
  tokenIn?: DecodedToken;
  tokenOut?: DecodedToken;
  raw: Record<string, unknown>;
}

export const CHAIN_ID_SOLANA = 0;
