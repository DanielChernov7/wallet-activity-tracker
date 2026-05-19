import { request } from 'undici';
import { Chain } from '@prisma/client';
import { env } from '../config/env.js';

type PriceQuery =
  | { chain: Chain; native: true; amount: string }
  | { chain: Chain; contract: string; amount: string; native?: false };

const cache = new Map<string, { price: number; ts: number }>();
const TTL_MS = 60_000;

const COINGECKO_NATIVE_IDS: Record<Chain, string> = {
  ETHEREUM: 'ethereum',
  BASE: 'ethereum',
  ARBITRUM: 'ethereum',
  SOLANA: 'solana',
};

export async function getUsdPrice(q: PriceQuery): Promise<number> {
  const key = 'native' in q && q.native ? `n:${q.chain}` : `c:${q.chain}:${(q as any).contract}`;
  const now = Date.now();
  const hit = cache.get(key);

  let price: number;
  if (hit && now - hit.ts < TTL_MS) {
    price = hit.price;
  } else {
    price = await fetchPrice(q);
    cache.set(key, { price, ts: now });
  }

  const decimals = inferDecimals(q);
  const human = Number(q.amount) / 10 ** decimals;
  return human * price;
}

function inferDecimals(q: PriceQuery): number {
  if ('native' in q && q.native) {
    return q.chain === Chain.SOLANA ? 9 : 18;
  }
  return 18; // TODO: resolve from ERC20 metadata cache
}

async function fetchPrice(q: PriceQuery): Promise<number> {
  if ('native' in q && q.native) {
    const id = COINGECKO_NATIVE_IDS[q.chain];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const res = await request(url, {
      headers: env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY } : {},
    });
    const json = (await res.body.json()) as Record<string, { usd: number }>;
    return json[id]?.usd ?? 0;
  }
  // For SPL on Solana, prefer Jupiter; for ERC20 fallback to coingecko contract endpoint.
  if (q.chain === Chain.SOLANA) {
    const url = `${env.JUPITER_PRICE_URL}?ids=${q.contract}`;
    const res = await request(url);
    const json = (await res.body.json()) as { data?: Record<string, { price: number }> };
    return json.data?.[q.contract]?.price ?? 0;
  }
  const platform = q.chain === Chain.ETHEREUM ? 'ethereum' : q.chain.toLowerCase();
  const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${q.contract}&vs_currencies=usd`;
  const res = await request(url);
  const json = (await res.body.json()) as Record<string, { usd: number }>;
  return json[q.contract.toLowerCase()]?.usd ?? 0;
}
