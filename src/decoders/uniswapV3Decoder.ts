import { ethers } from 'ethers';
import type { DecodedCall, DecodedToken } from './types.js';

const FRAGMENTS = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  // SwapRouter02 variant (no deadline field)
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
  'function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params) payable returns (uint256 amountIn)',
  'function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) params) payable returns (uint256 amountIn)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
] as const;

export const uniswapV3Iface = new ethers.Interface(FRAGMENTS);

const PATH_FNS = new Set(['exactInput', 'exactOutput']);
const SINGLE_FNS = new Set(['exactInputSingle', 'exactOutputSingle']);

export function decodeUniswapV3(data: string): DecodedCall | null {
  let parsed: ReturnType<typeof uniswapV3Iface.parseTransaction>;
  try {
    parsed = uniswapV3Iface.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!parsed) return null;

  if (parsed.name === 'multicall') {
    const inner = (parsed.args.getValue('data') ?? []) as readonly string[];
    return decodeMulticall(inner);
  }
  return decodeSingleCall(parsed);
}

function decodeSingleCall(parsed: ethers.TransactionDescription): DecodedCall | null {
  const name = parsed.name;
  if (SINGLE_FNS.has(name)) {
    const p = parsed.args.getValue('params') as ethers.Result;
    const tokenIn = p.getValue('tokenIn') as string;
    const tokenOut = p.getValue('tokenOut') as string;
    const amountInExact = name === 'exactInputSingle';
    const amountIn = (amountInExact
      ? (p.getValue('amountIn') as bigint)
      : (p.getValue('amountInMaximum') as bigint)) ?? 0n;
    const amountOut = (amountInExact
      ? (p.getValue('amountOutMinimum') as bigint)
      : (p.getValue('amountOut') as bigint)) ?? 0n;
    return {
      protocol: 'uniswap_v3',
      action: 'swap',
      tokenIn: { address: tokenIn.toLowerCase(), amount: amountIn },
      tokenOut: { address: tokenOut.toLowerCase(), amount: amountOut },
      raw: { fn: name, fee: Number(p.getValue('fee')) },
    };
  }
  if (PATH_FNS.has(name)) {
    const p = parsed.args.getValue('params') as ethers.Result;
    const pathBytes = p.getValue('path') as string;
    const route = decodeV3Path(pathBytes);
    if (route.tokens.length < 2) return null;
    const amountInExact = name === 'exactInput';
    const amountIn = (amountInExact
      ? (p.getValue('amountIn') as bigint)
      : (p.getValue('amountInMaximum') as bigint)) ?? 0n;
    const amountOut = (amountInExact
      ? (p.getValue('amountOutMinimum') as bigint)
      : (p.getValue('amountOut') as bigint)) ?? 0n;
    return {
      protocol: 'uniswap_v3',
      action: 'swap',
      tokenIn: { address: route.tokens[0]!, amount: amountIn },
      tokenOut: { address: route.tokens[route.tokens.length - 1]!, amount: amountOut },
      raw: { fn: name, path: route.tokens, fees: route.fees },
    };
  }
  return null;
}

function decodeMulticall(innerCalls: readonly string[]): DecodedCall | null {
  // Recurse: pick the first inner call that decodes to a swap; merge token info.
  let firstSwap: DecodedCall | null = null;
  let lastSwap: DecodedCall | null = null;
  for (const call of innerCalls) {
    const decoded = decodeUniswapV3(call);
    if (decoded && decoded.action === 'swap') {
      firstSwap ??= decoded;
      lastSwap = decoded;
    }
  }
  if (!firstSwap || !lastSwap) return null;
  return {
    protocol: 'uniswap_v3',
    action: 'swap',
    tokenIn: firstSwap.tokenIn,
    tokenOut: lastSwap.tokenOut,
    raw: { fn: 'multicall', legs: innerCalls.length },
  };
}

/**
 * Uniswap V3 path encoding: 20-byte address | 3-byte fee | 20-byte address | ...
 * Returns the ordered token list and the fee tiers between them.
 */
export function decodeV3Path(path: string): { tokens: string[]; fees: number[] } {
  const hex = path.startsWith('0x') ? path.slice(2) : path;
  const tokens: string[] = [];
  const fees: number[] = [];
  let i = 0;
  while (i + 40 <= hex.length) {
    tokens.push('0x' + hex.slice(i, i + 40).toLowerCase());
    i += 40;
    if (i + 6 > hex.length) break;
    fees.push(parseInt(hex.slice(i, i + 6), 16));
    i += 6;
  }
  return { tokens, fees };
}

void ({} as DecodedToken);
