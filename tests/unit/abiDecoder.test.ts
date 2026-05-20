import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { decodeCall } from '../../src/decoders/abiDecoder.js';
import { decodeUniswapV3, decodeV3Path } from '../../src/decoders/uniswapV3Decoder.js';
import { decodeJupiterCall, JUPITER_PROGRAM_ID } from '../../src/decoders/jupiterDecoder.js';
import { uniswapV2Iface } from '../../src/decoders/uniswapV2Decoder.js';
import { uniswapV3Iface } from '../../src/decoders/uniswapV3Decoder.js';

const ETH = 1;
const BASE = 8453;
const ARBITRUM = 42161;

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const RECIPIENT = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const ROUTER_V2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const ROUTER_V3 = '0xe592427a0aece92de3edee1f18e0157c05861564';

// ── Calldata fixtures ─────────────────────────────────────────────────────
// Constructed via the same Interface a real router exposes — the bytes are
// indistinguishable from on-chain calldata, so any drift in our decoder
// surfaces immediately. Frozen as hex constants once built.
const V2_SWAP_EXACT_TOKENS_FOR_TOKENS = uniswapV2Iface.encodeFunctionData(
  'swapExactTokensForTokens',
  [1_000_000n, 950_000n, [USDC, WETH], RECIPIENT, 1_700_000_000n],
);

const V2_SWAP_EXACT_ETH_FOR_TOKENS = uniswapV2Iface.encodeFunctionData(
  'swapExactETHForTokens',
  [950_000n, [WETH, USDC], RECIPIENT, 1_700_000_000n],
);

const V2_ADD_LIQUIDITY = uniswapV2Iface.encodeFunctionData('addLiquidity', [
  USDC,
  DAI,
  1_000_000n,
  1_000_000n,
  990_000n,
  990_000n,
  RECIPIENT,
  1_700_000_000n,
]);

const V2_REMOVE_LIQUIDITY_ETH = uniswapV2Iface.encodeFunctionData('removeLiquidityETH', [
  USDC,
  100n,
  1n,
  1n,
  RECIPIENT,
  1_700_000_000n,
]);

const V3_EXACT_INPUT_SINGLE = uniswapV3Iface.encodeFunctionData(
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  [
    [USDC, WETH, 3000, RECIPIENT, 1_700_000_000n, 1_000_000n, 0n, 0n],
  ],
);

// SwapRouter02 (no deadline)
const V3_EXACT_INPUT_SINGLE_02 = uniswapV3Iface.encodeFunctionData(
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  [[USDC, WETH, 500, RECIPIENT, 5_000_000n, 0n, 0n]],
);

const V3_PATH = ethers.solidityPacked(
  ['address', 'uint24', 'address', 'uint24', 'address'],
  [USDC, 500, WETH, 3000, DAI],
);
const V3_EXACT_INPUT_MULTIHOP = uniswapV3Iface.encodeFunctionData(
  'exactInput((bytes,address,uint256,uint256,uint256))',
  [[V3_PATH, RECIPIENT, 1_700_000_000n, 1_000_000n, 0n]],
);

const V3_MULTICALL = uniswapV3Iface.encodeFunctionData('multicall(bytes[])', [
  [V3_EXACT_INPUT_SINGLE, V3_EXACT_INPUT_SINGLE_02],
]);

// ── Tests ─────────────────────────────────────────────────────────────────

describe('decodeCall — dispatcher', () => {
  it('returns null for non-EVM chain ids', () => {
    expect(decodeCall(ROUTER_V2, V2_SWAP_EXACT_TOKENS_FOR_TOKENS, 0)).toBeNull();
    expect(decodeCall(ROUTER_V2, V2_SWAP_EXACT_TOKENS_FOR_TOKENS, 137)).toBeNull();
  });

  it('returns null for empty calldata', () => {
    expect(decodeCall(ROUTER_V2, '0x', ETH)).toBeNull();
    expect(decodeCall(ROUTER_V2, '', ETH)).toBeNull();
  });

  it('returns null for unknown selector', () => {
    expect(decodeCall(ROUTER_V2, '0xdeadbeefcafebabe', ETH)).toBeNull();
  });

  it('works on Base + Arbitrum (same selectors)', () => {
    expect(decodeCall(ROUTER_V3, V3_EXACT_INPUT_SINGLE, BASE)?.action).toBe('swap');
    expect(decodeCall(ROUTER_V3, V3_EXACT_INPUT_SINGLE, ARBITRUM)?.action).toBe('swap');
  });
});

describe('decodeCall — Uniswap V2', () => {
  it('swapExactTokensForTokens: tokenIn/Out from path endpoints', () => {
    const decoded = decodeCall(ROUTER_V2, V2_SWAP_EXACT_TOKENS_FOR_TOKENS, ETH);
    expect(decoded).toMatchObject({ protocol: 'uniswap_v2', action: 'swap' });
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(WETH);
    expect(decoded?.tokenIn?.amount).toBe(1_000_000n);
    expect(decoded?.tokenOut?.amount).toBe(950_000n);
  });

  it('swapExactETHForTokens: still picks path endpoints', () => {
    const decoded = decodeCall(ROUTER_V2, V2_SWAP_EXACT_ETH_FOR_TOKENS, ETH);
    expect(decoded?.action).toBe('swap');
    expect(decoded?.tokenIn?.address).toBe(WETH);
    expect(decoded?.tokenOut?.address).toBe(USDC);
  });

  it('addLiquidity → action add_liquidity, tokenA/B as in/out', () => {
    const decoded = decodeCall(ROUTER_V2, V2_ADD_LIQUIDITY, ETH);
    expect(decoded?.action).toBe('add_liquidity');
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(DAI);
  });

  it('removeLiquidityETH → action remove_liquidity with ETH sentinel', () => {
    const decoded = decodeCall(ROUTER_V2, V2_REMOVE_LIQUIDITY_ETH, ETH);
    expect(decoded?.action).toBe('remove_liquidity');
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe('__eth__');
  });
});

describe('decodeCall — Uniswap V3', () => {
  it('exactInputSingle (with deadline): pulls params.tokenIn/Out and fee', () => {
    const decoded = decodeCall(ROUTER_V3, V3_EXACT_INPUT_SINGLE, ETH);
    expect(decoded).toMatchObject({ protocol: 'uniswap_v3', action: 'swap' });
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(WETH);
    expect(decoded?.raw.fee).toBe(3000);
  });

  it('exactInputSingle (SwapRouter02, no deadline)', () => {
    const decoded = decodeUniswapV3(V3_EXACT_INPUT_SINGLE_02);
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(WETH);
  });

  it('exactInput: walks packed path, picks first and last token', () => {
    const decoded = decodeCall(ROUTER_V3, V3_EXACT_INPUT_MULTIHOP, ETH);
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(DAI);
    expect((decoded?.raw.path as string[]).length).toBe(3);
  });

  it('multicall: recurses into inner calls, takes first.in + last.out', () => {
    const decoded = decodeCall(ROUTER_V3, V3_MULTICALL, ETH);
    expect(decoded?.action).toBe('swap');
    expect(decoded?.raw.fn).toBe('multicall');
    expect(decoded?.tokenIn?.address).toBe(USDC);
    expect(decoded?.tokenOut?.address).toBe(WETH);
  });
});

describe('decodeV3Path', () => {
  it('parses 20-3-20-3-20 packed encoding', () => {
    const { tokens, fees } = decodeV3Path(V3_PATH);
    expect(tokens).toEqual([USDC, WETH, DAI]);
    expect(fees).toEqual([500, 3000]);
  });
});

describe('decodeJupiterCall', () => {
  it('matches when Jupiter program ID is in accountKeys', () => {
    const decoded = decodeJupiterCall({ accountKeys: ['some_pubkey', JUPITER_PROGRAM_ID] });
    expect(decoded).toEqual({
      protocol: 'jupiter',
      action: 'swap',
      raw: { programId: JUPITER_PROGRAM_ID },
    });
  });

  it('matches via logs when accountKeys empty', () => {
    const decoded = decodeJupiterCall({
      accountKeys: [],
      logs: [`Program ${JUPITER_PROGRAM_ID} invoke [1]`],
    });
    expect(decoded?.protocol).toBe('jupiter');
  });

  it('returns null when Jupiter is not involved', () => {
    expect(decodeJupiterCall({ accountKeys: ['x', 'y'] })).toBeNull();
  });
});
