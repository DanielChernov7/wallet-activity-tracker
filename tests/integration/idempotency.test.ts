import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Chain, TxType } from '@prisma/client';

const prisma = new PrismaClient();
const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d('transaction idempotency (chain, hash, from, to)', () => {
  const hash = `0xidem-${Date.now()}`;
  const from = '0xfrom';
  const to = '0xto';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { hash } });
    await prisma.$disconnect();
  });

  it('upsert with the same unique key does not create duplicates', async () => {
    const where = {
      chain_hash_fromAddress_toAddress: { chain: Chain.ETHEREUM, hash, fromAddress: from, toAddress: to },
    };

    const a = await prisma.transaction.upsert({
      where,
      create: { chain: Chain.ETHEREUM, hash, type: TxType.UNKNOWN, fromAddress: from, toAddress: to, raw: {} },
      update: {},
    });
    const b = await prisma.transaction.upsert({
      where,
      create: { chain: Chain.ETHEREUM, hash, type: TxType.UNKNOWN, fromAddress: from, toAddress: to, raw: {} },
      update: {},
    });

    expect(a.id).toBe(b.id);

    const count = await prisma.transaction.count({ where: { hash } });
    expect(count).toBe(1);
  });

  it('different (from, to) pair produces a separate row even with same hash', async () => {
    const altTo = '0xto2';
    await prisma.transaction.upsert({
      where: {
        chain_hash_fromAddress_toAddress: { chain: Chain.ETHEREUM, hash, fromAddress: from, toAddress: altTo },
      },
      create: { chain: Chain.ETHEREUM, hash, type: TxType.UNKNOWN, fromAddress: from, toAddress: altTo, raw: {} },
      update: {},
    });

    const count = await prisma.transaction.count({ where: { hash } });
    expect(count).toBe(2);
  });
});
