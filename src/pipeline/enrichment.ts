import { Chain, TxType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getUsdPrice } from '../prices/prices.js';
import { logger } from '../config/logger.js';

export type EnrichedTx = {
  hash: string;
  chain: Chain;
  type: TxType;
  blockNumber?: bigint;
  from: string;
  to: string;
  tokenSymbol?: string;
  tokenAmount?: string;
  valueUsd?: number;
  walletId?: string;
  raw: unknown;
};

type RawInput = {
  chain: Chain;
  hash: string;
  blockNumber?: bigint;
  from: string;
  to: string;
  raw: any;
};

export async function enrich(input: RawInput): Promise<EnrichedTx> {
  const type = classify(input);
  const wallet = await findOwningWallet(input.chain, [input.from, input.to]);

  let valueUsd: number | undefined;
  let tokenSymbol: string | undefined;
  let tokenAmount: string | undefined;

  if (input.raw?.kind === 'erc20_transfer') {
    tokenSymbol = input.raw.tokenSymbol ?? undefined;
    tokenAmount = input.raw.value;
    // Price lookup is contract-based; assumes prices module resolves by chain+contract.
    valueUsd = await safe(() =>
      getUsdPrice({ chain: input.chain, contract: input.raw.tokenContract, amount: input.raw.value }),
    );
  } else if (input.raw?.kind === 'native') {
    tokenSymbol = nativeSymbol(input.chain);
    tokenAmount = input.raw.value;
    valueUsd = await safe(() =>
      getUsdPrice({ chain: input.chain, native: true, amount: input.raw.value }),
    );
  }

  return {
    hash: input.hash,
    chain: input.chain,
    type,
    blockNumber: input.blockNumber,
    from: input.from,
    to: input.to,
    tokenSymbol,
    tokenAmount,
    valueUsd,
    walletId: wallet?.id,
    raw: input.raw,
  };
}

function classify(input: RawInput): TxType {
  const k = input.raw?.kind;
  if (k === 'erc20_transfer') return TxType.ERC20_TRANSFER;
  if (k === 'native') return TxType.TRANSFER;
  if (k === 'sol_logs') return TxType.SOL_TRANSFER;
  return TxType.UNKNOWN;
}

function nativeSymbol(chain: Chain): string {
  switch (chain) {
    case Chain.ETHEREUM:
    case Chain.BASE:
    case Chain.ARBITRUM:
      return 'ETH';
    case Chain.SOLANA:
      return 'SOL';
  }
}

async function findOwningWallet(chain: Chain, addresses: string[]) {
  return prisma.wallet.findFirst({
    where: { chain, address: { in: addresses }, active: true },
  });
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, 'enrichment subroutine failed');
    return undefined;
  }
}
