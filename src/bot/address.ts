import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { Chain } from '@prisma/client';

export type ParsedAddress = {
  chain: Chain;
  /** Canonical form: checksum for EVM (then we lowercase before persisting), base58 for Solana. */
  canonical: string;
};

const EVM_CHAINS: ReadonlySet<Chain> = new Set([Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM]);

export function parseChain(input: string | undefined): Chain | undefined {
  if (!input) return undefined;
  const norm = input.trim().toUpperCase();
  if (norm in Chain) return Chain[norm as keyof typeof Chain];
  switch (norm) {
    case 'ETH':
      return Chain.ETHEREUM;
    case 'ARB':
      return Chain.ARBITRUM;
    case 'SOL':
      return Chain.SOLANA;
    default:
      return undefined;
  }
}

export function isEvmChain(chain: Chain): boolean {
  return EVM_CHAINS.has(chain);
}

/**
 * Validates and normalises an address. Returns canonical lowercase for EVM
 * and the original base58 string for Solana.
 *
 * If hint is given the address must validate against that family. Otherwise
 * we auto-detect EVM vs Solana from the literal shape.
 */
export function parseAddress(raw: string, hint?: Chain): ParsedAddress {
  const value = raw.trim();

  if (hint && isEvmChain(hint)) {
    const checksummed = ethers.getAddress(value);
    return { chain: hint, canonical: checksummed.toLowerCase() };
  }
  if (hint === Chain.SOLANA) {
    assertSolana(value);
    return { chain: Chain.SOLANA, canonical: value };
  }

  if (value.startsWith('0x')) {
    const checksummed = ethers.getAddress(value);
    return { chain: Chain.ETHEREUM, canonical: checksummed.toLowerCase() };
  }
  assertSolana(value);
  return { chain: Chain.SOLANA, canonical: value };
}

function assertSolana(value: string): void {
  // PublicKey throws on invalid base58 or wrong length.
  const pk = new PublicKey(value);
  if (pk.toBase58() !== value) {
    throw new Error('not a canonical base58 Solana address');
  }
}

export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
