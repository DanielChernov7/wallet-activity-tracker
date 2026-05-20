import type { DecodedCall } from './types.js';

export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

export interface SolanaInstructionInput {
  /** Accounts touched by the transaction (Solana transaction.message.accountKeys). */
  accountKeys: readonly string[];
  /** Optional log lines from RPC; we use them as a best-effort signal when accountKeys is incomplete. */
  logs?: readonly string[];
}

/**
 * Solana decoding is intentionally coarse-grained: parsing Jupiter v6's
 * route instruction payload requires an Anchor IDL. The most reliable signal
 * is the presence of the Jupiter program ID in accountKeys. We mark such
 * transactions as a Jupiter swap with no concrete amounts (best-effort).
 */
export function decodeJupiterCall(input: SolanaInstructionInput): DecodedCall | null {
  const touchesJupiter =
    input.accountKeys.includes(JUPITER_PROGRAM_ID) ||
    (input.logs?.some((l) => l.includes(JUPITER_PROGRAM_ID)) ?? false);
  if (!touchesJupiter) return null;
  return {
    protocol: 'jupiter',
    action: 'swap',
    raw: { programId: JUPITER_PROGRAM_ID },
  };
}
