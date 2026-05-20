import { Chain, PrismaClient } from '@prisma/client';

type LabelCategory =
  | 'EXCHANGE'
  | 'DEX_ROUTER'
  | 'BRIDGE'
  | 'DEFI_PROTOCOL'
  | 'MIXER'
  | 'TOKEN';

type Seed = { chain: Chain; address: string; label: string; category: LabelCategory };

/**
 * Curated public addresses. EVM addresses stored lowercase to match the
 * normalisation done by EvmListener. Solana addresses are case-sensitive base58.
 */
const SEEDS: Seed[] = [
  // ── EVM EXCHANGE (any EVM chain — Binance / Coinbase / Kraken / OKX hot+cold wallets are EOAs)
  { chain: Chain.ETHEREUM, address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance Hot Wallet', category: 'EXCHANGE' },
  { chain: Chain.ETHEREUM, address: '0x21a31ee1afc51d94c2efccaa2092ad1028285549', label: 'Binance Cold Wallet', category: 'EXCHANGE' },
  { chain: Chain.ETHEREUM, address: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', label: 'Coinbase', category: 'EXCHANGE' },
  { chain: Chain.ETHEREUM, address: '0x2910543af39aba0cd09dbb2d50200b3e800a63d2', label: 'Kraken', category: 'EXCHANGE' },
  { chain: Chain.ETHEREUM, address: '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', label: 'OKX', category: 'EXCHANGE' },

  // ── DEX_ROUTER on Ethereum
  { chain: Chain.ETHEREUM, address: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', label: 'Uniswap V2 Router', category: 'DEX_ROUTER' },
  { chain: Chain.ETHEREUM, address: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'Uniswap V3 Router', category: 'DEX_ROUTER' },
  { chain: Chain.ETHEREUM, address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'Uniswap V3 Router2', category: 'DEX_ROUTER' },
  { chain: Chain.ETHEREUM, address: '0x1111111254eeb25477b68fb85ed929f73a960582', label: '1inch v5', category: 'DEX_ROUTER' },

  // ── DEX_ROUTER on Base
  { chain: Chain.BASE, address: '0x2626664c2603336e57b271c5c0b26f421741e481', label: 'Uniswap V3 Router2', category: 'DEX_ROUTER' },
  { chain: Chain.BASE, address: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', label: 'Aerodrome Router', category: 'DEX_ROUTER' },

  // ── DEX_ROUTER on Arbitrum
  { chain: Chain.ARBITRUM, address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'Uniswap V3 Router2', category: 'DEX_ROUTER' },
  { chain: Chain.ARBITRUM, address: '0xc873fecbd354f5a56e00e710b90ef4201db2448d', label: 'Camelot Router', category: 'DEX_ROUTER' },

  // ── BRIDGE
  { chain: Chain.ETHEREUM, address: '0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef', label: 'Arbitrum Gateway', category: 'BRIDGE' },
  { chain: Chain.ETHEREUM, address: '0x8731d54e9d02c286767d56ac03e8037c07e01e98', label: 'Stargate Router', category: 'BRIDGE' },

  // ── DEFI_PROTOCOL
  { chain: Chain.ETHEREUM, address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', label: 'Aave V3 Pool', category: 'DEFI_PROTOCOL' },
  { chain: Chain.ETHEREUM, address: '0xc3d688b66703497daa19211eedff47f25384cdc3', label: 'Compound V3', category: 'DEFI_PROTOCOL' },
  { chain: Chain.ETHEREUM, address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', label: 'Lido', category: 'DEFI_PROTOCOL' },

  // ── Solana EXCHANGE
  { chain: Chain.SOLANA, address: '5tzFkiKscXHK5ZXCGbSubsUxEyQX11K6fsBdBMeJNT6o', label: 'Binance (Solana)', category: 'EXCHANGE' },
  { chain: Chain.SOLANA, address: 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', label: 'Kraken (Solana)', category: 'EXCHANGE' },

  // ── Solana DEX_ROUTER
  { chain: Chain.SOLANA, address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter Aggregator', category: 'DEX_ROUTER' },
  { chain: Chain.SOLANA, address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'Raydium AMM v4', category: 'DEX_ROUTER' },
  { chain: Chain.SOLANA, address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpool', category: 'DEX_ROUTER' },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    for (const s of SEEDS) {
      const existing = await prisma.addressLabel.findUnique({
        where: { chain_address: { chain: s.chain, address: s.address } },
      });
      if (!existing) {
        await prisma.addressLabel.create({ data: s });
        created++;
      } else if (existing.label !== s.label || existing.category !== s.category) {
        await prisma.addressLabel.update({
          where: { chain_address: { chain: s.chain, address: s.address } },
          data: { label: s.label, category: s.category },
        });
        updated++;
      } else {
        unchanged++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `addressLabel seed: ${created} created, ${updated} updated, ${unchanged} unchanged (${SEEDS.length} total)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
