import { Chain, PrismaClient } from '@prisma/client';

type Seed = { chain: Chain; address: string; label: string; category: string };

/**
 * Curated public addresses. EVM addresses stored lowercase to match the
 * normalisation done by EvmListener. Solana addresses are case-sensitive base58.
 */
const SEEDS: Seed[] = [
  // ── EVM: CEX hot wallets ────────────────────────────────────────────────
  { chain: Chain.ETHEREUM, address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance 14', category: 'cex' },
  { chain: Chain.ETHEREUM, address: '0x21a31ee1afc51d94c2efccaa2092ad1028285549', label: 'Binance 15', category: 'cex' },
  { chain: Chain.ETHEREUM, address: '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', label: 'Binance 16', category: 'cex' },
  { chain: Chain.ETHEREUM, address: '0x56eddb7aa87536c09ccc2793473599fd21a8b17f', label: 'Binance 17', category: 'cex' },
  { chain: Chain.ETHEREUM, address: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3', label: 'Coinbase 1', category: 'cex' },

  // ── EVM: DEX routers ────────────────────────────────────────────────────
  { chain: Chain.ETHEREUM, address: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', label: 'Uniswap V2: Router', category: 'dex' },
  { chain: Chain.ETHEREUM, address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'Uniswap V3: SwapRouter02', category: 'dex' },
  { chain: Chain.ETHEREUM, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', label: 'Uniswap: Universal Router', category: 'dex' },

  // ── EVM: tokens ─────────────────────────────────────────────────────────
  { chain: Chain.ETHEREUM, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', label: 'USDC', category: 'token' },
  { chain: Chain.ETHEREUM, address: '0xdac17f958d2ee523a2206206994597c13d831ec7', label: 'USDT', category: 'token' },
  { chain: Chain.ETHEREUM, address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', label: 'WETH', category: 'token' },

  // ── EVM: mixers (sanctions / unusual-activity signal) ───────────────────
  { chain: Chain.ETHEREUM, address: '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', label: 'Tornado Cash: 10 ETH', category: 'mixer' },
  { chain: Chain.ETHEREUM, address: '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', label: 'Tornado Cash: 100 ETH', category: 'mixer' },

  // ── Base ────────────────────────────────────────────────────────────────
  { chain: Chain.BASE, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', label: 'USDC (Base)', category: 'token' },
  { chain: Chain.BASE, address: '0x4200000000000000000000000000000000000006', label: 'WETH (Base)', category: 'token' },
  { chain: Chain.BASE, address: '0x2626664c2603336e57b271c5c0b26f421741e481', label: 'Uniswap V3: SwapRouter02 (Base)', category: 'dex' },

  // ── Arbitrum ────────────────────────────────────────────────────────────
  { chain: Chain.ARBITRUM, address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', label: 'USDC (Arbitrum)', category: 'token' },
  { chain: Chain.ARBITRUM, address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', label: 'WETH (Arbitrum)', category: 'token' },
  { chain: Chain.ARBITRUM, address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'Uniswap V3: SwapRouter02 (Arbitrum)', category: 'dex' },

  // ── Solana (base58, case-sensitive) ─────────────────────────────────────
  { chain: Chain.SOLANA, address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter Aggregator v6', category: 'dex' },
  { chain: Chain.SOLANA, address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'Raydium AMM v4', category: 'dex' },
  { chain: Chain.SOLANA, address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpool', category: 'dex' },
  { chain: Chain.SOLANA, address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label: 'Binance (Solana)', category: 'cex' },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let created = 0;
  let updated = 0;
  try {
    for (const s of SEEDS) {
      const existing = await prisma.addressLabel.findUnique({
        where: { chain_address: { chain: s.chain, address: s.address } },
      });
      if (existing) {
        if (existing.label !== s.label || existing.category !== s.category) {
          await prisma.addressLabel.update({
            where: { chain_address: { chain: s.chain, address: s.address } },
            data: { label: s.label, category: s.category },
          });
          updated++;
        }
      } else {
        await prisma.addressLabel.create({ data: s });
        created++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`label seed: ${created} created, ${updated} updated, ${SEEDS.length} total`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
