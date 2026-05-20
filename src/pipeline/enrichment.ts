import { Chain, TxType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getUsdPrice } from '../prices/prices.js';
import { getLabel } from '../labels/redisLabelCache.js';
import { getErc20Metadata } from '../cache/index.js';
import { dispatchDecode, chainIdOf, type DecodedCall } from '../decoders/index.js';
import { logger } from '../config/logger.js';

export type TxMetadata = {
  decoded?: DecodedCall;
  fromLabel?: { label: string; category: string | null };
  toLabel?: { label: string; category: string | null };
  tags?: string[];
};

export type EnrichedTx = {
  hash: string;
  chain: Chain;
  type: TxType;
  blockNumber?: bigint;
  from: string;
  to: string;
  fromLabel?: string;
  toLabel?: string;
  tokenSymbol?: string;
  tokenAmount?: string;
  valueUsd?: number;
  walletId?: string;
  raw: unknown;
  metadata?: TxMetadata;
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
  const decoded = decode(input);
  const type = classify(input, decoded);
  const [wallet, fromLabel, toLabel] = await Promise.all([
    findOwningWallet(input.chain, [input.from, input.to]),
    getLabel(input.chain, input.from).catch(() => null),
    getLabel(input.chain, input.to).catch(() => null),
  ]);

  let valueUsd: number | undefined;
  let tokenSymbol: string | undefined;
  let tokenAmount: string | undefined;

  if (input.raw?.kind === 'erc20_transfer') {
    const meta = await safe(() => getErc20Metadata(input.chain, input.raw.tokenContract));
    tokenSymbol = meta?.symbol ?? input.raw.tokenSymbol ?? undefined;
    tokenAmount = input.raw.value;
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

  // Enrich decoded swap tokens via the ERC20 metadata cache for symbol display.
  if (decoded?.action === 'swap' && (decoded.tokenIn || decoded.tokenOut)) {
    await Promise.all([
      enrichDecodedToken(input.chain, decoded, 'tokenIn'),
      enrichDecodedToken(input.chain, decoded, 'tokenOut'),
    ]);
  }

  const tags: string[] = [];
  if (toLabel?.category === 'EXCHANGE') tags.push('exchange_deposit');
  if (fromLabel?.category === 'EXCHANGE') tags.push('exchange_withdrawal');
  if (toLabel?.category === 'BRIDGE' || fromLabel?.category === 'BRIDGE') tags.push('bridge');
  if (toLabel?.category === 'DEX_ROUTER') tags.push('dex_interaction');

  const metadata: TxMetadata = {
    decoded: decoded ?? undefined,
    fromLabel: fromLabel ? { label: fromLabel.label, category: fromLabel.category } : undefined,
    toLabel: toLabel ? { label: toLabel.label, category: toLabel.category } : undefined,
    tags: tags.length > 0 ? tags : undefined,
  };

  return {
    hash: input.hash,
    chain: input.chain,
    type,
    blockNumber: input.blockNumber,
    from: input.from,
    to: input.to,
    fromLabel: fromLabel?.label,
    toLabel: toLabel?.label,
    tokenSymbol,
    tokenAmount,
    valueUsd,
    walletId: wallet?.id,
    raw: input.raw,
    metadata: hasMetadata(metadata) ? metadata : undefined,
  };
}

function hasMetadata(m: TxMetadata): boolean {
  return Boolean(m.decoded || m.fromLabel || m.toLabel || m.tags);
}

function decode(input: RawInput): DecodedCall | null {
  if (input.chain === Chain.SOLANA) {
    const accountKeys = (input.raw?.accountKeys ?? []) as string[];
    const logs = (input.raw?.logs ?? []) as string[];
    if (accountKeys.length === 0 && logs.length === 0) return null;
    return dispatchDecode({ kind: 'solana', input: { accountKeys, logs } });
  }
  const data = (input.raw?.data ?? input.raw?.input) as string | undefined;
  if (!data) return null;
  return dispatchDecode({
    kind: 'evm',
    to: input.to,
    data,
    chainId: chainIdOf(input.chain),
  });
}

export function classify(input: RawInput, decoded?: DecodedCall | null): TxType {
  if (decoded) {
    if (decoded.action === 'swap') return TxType.SWAP;
    if (decoded.action === 'add_liquidity') return TxType.ADD_LIQUIDITY;
    if (decoded.action === 'remove_liquidity') return TxType.REMOVE_LIQUIDITY;
  }
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

async function enrichDecodedToken(
  chain: Chain,
  decoded: DecodedCall,
  side: 'tokenIn' | 'tokenOut',
): Promise<void> {
  const tok = decoded[side];
  if (!tok || tok.symbol || !tok.address.startsWith('0x')) return;
  const meta = await safe(() => getErc20Metadata(chain, tok.address));
  if (meta?.symbol) tok.symbol = meta.symbol;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, 'enrichment subroutine failed');
    return undefined;
  }
}
