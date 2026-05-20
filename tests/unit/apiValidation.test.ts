import { describe, it, expect } from 'vitest';
import {
  CreateWalletSchema,
  CreateAlertSchema,
  AlertConditionSchema,
} from '../../src/api/schemas.js';

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

describe('CreateWalletSchema — address validation', () => {
  it('accepts a valid checksum EVM address', () => {
    const r = CreateWalletSchema.safeParse({ address: VITALIK, chain: 'ETHEREUM' });
    expect(r.success).toBe(true);
  });

  it('accepts a valid base58 Solana pubkey', () => {
    const r = CreateWalletSchema.safeParse({ address: JUP, chain: 'SOLANA' });
    expect(r.success).toBe(true);
  });

  it('rejects garbage that starts with 0x', () => {
    const r = CreateWalletSchema.safeParse({ address: '0xdeadbeef', chain: 'ETHEREUM' });
    expect(r.success).toBe(false);
  });

  it('rejects non-base58 Solana address', () => {
    const r = CreateWalletSchema.safeParse({ address: 'not-a-real-address', chain: 'SOLANA' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown chain', () => {
    const r = CreateWalletSchema.safeParse({ address: VITALIK, chain: 'POLYGON' });
    expect(r.success).toBe(false);
  });
});

describe('AlertConditionSchema — discriminated union', () => {
  it('accepts amount_gt with finite valueUsd', () => {
    expect(AlertConditionSchema.safeParse({ type: 'amount_gt', valueUsd: 100 }).success).toBe(true);
  });

  it('rejects amount_gt without valueUsd', () => {
    expect(AlertConditionSchema.safeParse({ type: 'amount_gt' }).success).toBe(false);
  });

  it('rejects unknown discriminator', () => {
    expect(AlertConditionSchema.safeParse({ type: 'whatever', x: 1 }).success).toBe(false);
  });

  it('rejects unusual_activity with non-integer windowSec', () => {
    const r = AlertConditionSchema.safeParse({
      type: 'unusual_activity',
      windowSec: 0,
      minCount: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('CreateAlertSchema', () => {
  it('rejects when no channel is enabled', () => {
    const r = CreateAlertSchema.safeParse({
      walletId: 'w1',
      name: 'x',
      condition: { type: 'any' },
      channels: {},
    });
    expect(r.success).toBe(false);
  });

  it('accepts a fully-specified alert', () => {
    const r = CreateAlertSchema.safeParse({
      walletId: 'w1',
      name: 'big swap',
      condition: { type: 'amount_gt', valueUsd: 10_000 },
      channels: { webhook: 'https://example.com/hook' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects non-URL webhook', () => {
    const r = CreateAlertSchema.safeParse({
      walletId: 'w1',
      name: 'x',
      condition: { type: 'any' },
      channels: { webhook: 'not-a-url' },
    });
    expect(r.success).toBe(false);
  });
});
