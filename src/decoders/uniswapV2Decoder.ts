import { ethers } from 'ethers';
import type { Action, DecodedCall } from './types.js';

// Minimal ABI fragments. We dispatch by 4-byte selector, so the order doesn't
// matter — Interface builds the lookup tables for us.
const FRAGMENTS = [
  // Swap variants (V2 router)
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  // Fee-on-transfer variants share the same shape (path + amounts) so we decode the same fields.
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',

  // Liquidity
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)',
  'function removeLiquidityWithPermit(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline, bool approveMax, uint8 v, bytes32 r, bytes32 s) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityETHWithPermit(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline, bool approveMax, uint8 v, bytes32 r, bytes32 s) returns (uint256 amountToken, uint256 amountETH)',
] as const;

export const uniswapV2Iface = new ethers.Interface(FRAGMENTS);

const SWAP_FN_NAMES = new Set([
  'swapExactTokensForTokens',
  'swapTokensForExactTokens',
  'swapExactETHForTokens',
  'swapTokensForExactETH',
  'swapExactTokensForETH',
  'swapETHForExactTokens',
  'swapExactTokensForTokensSupportingFeeOnTransferTokens',
  'swapExactETHForTokensSupportingFeeOnTransferTokens',
  'swapExactTokensForETHSupportingFeeOnTransferTokens',
]);

const ADD_LIQUIDITY_FNS = new Set(['addLiquidity', 'addLiquidityETH']);
const REMOVE_LIQUIDITY_FNS = new Set([
  'removeLiquidity',
  'removeLiquidityETH',
  'removeLiquidityWithPermit',
  'removeLiquidityETHWithPermit',
]);

export function decodeUniswapV2(data: string): DecodedCall | null {
  let parsed;
  try {
    parsed = uniswapV2Iface.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const name = parsed.name;
  const args = parsed.args;

  if (SWAP_FN_NAMES.has(name)) {
    const path = (args.getValue('path') ?? []) as readonly string[];
    if (path.length < 2) return null;
    const inAddr = path[0]!;
    const outAddr = path[path.length - 1]!;
    const { amountIn, amountOut } = extractAmounts(name, args);
    return {
      protocol: 'uniswap_v2',
      action: 'swap',
      tokenIn: { address: inAddr.toLowerCase(), amount: amountIn },
      tokenOut: { address: outAddr.toLowerCase(), amount: amountOut },
      raw: { fn: name, path: path.map((a) => a.toLowerCase()) },
    };
  }

  if (ADD_LIQUIDITY_FNS.has(name)) {
    const isEth = name === 'addLiquidityETH';
    const tokenA = (isEth ? args.getValue('token') : args.getValue('tokenA')) as string;
    const tokenB = isEth ? '__ETH__' : (args.getValue('tokenB') as string);
    return {
      protocol: 'uniswap_v2',
      action: 'add_liquidity',
      tokenIn: { address: tokenA.toLowerCase(), amount: 0n },
      tokenOut: { address: tokenB === '__ETH__' ? tokenB : tokenB.toLowerCase(), amount: 0n },
      raw: { fn: name },
    };
  }

  if (REMOVE_LIQUIDITY_FNS.has(name)) {
    const isEth = name.startsWith('removeLiquidityETH');
    const tokenA = (isEth ? args.getValue('token') : args.getValue('tokenA')) as string;
    const tokenB = isEth ? '__ETH__' : (args.getValue('tokenB') as string);
    return {
      protocol: 'uniswap_v2',
      action: 'remove_liquidity',
      tokenIn: { address: tokenA.toLowerCase(), amount: 0n },
      tokenOut: { address: tokenB === '__ETH__' ? tokenB : tokenB.toLowerCase(), amount: 0n },
      raw: { fn: name },
    };
  }

  return null;
}

function extractAmounts(name: string, args: ethers.Result): { amountIn: bigint; amountOut: bigint } {
  // ExactIn variants encode amountIn + amountOutMin (or just amountOutMin for ETH).
  // ExactOut variants encode amountOut + amountInMax (or amountOut + msg.value for ETH-in).
  const get = (key: string): bigint | undefined => {
    try {
      return args.getValue(key) as bigint;
    } catch {
      return undefined;
    }
  };
  const amountIn = get('amountIn') ?? 0n;
  const amountOut = get('amountOut') ?? get('amountOutMin') ?? 0n;
  void name;
  return { amountIn, amountOut };
}

export const V2_ACTION_TO_LABEL: Record<Action, Action> = {
  swap: 'swap',
  add_liquidity: 'add_liquidity',
  remove_liquidity: 'remove_liquidity',
  unknown: 'unknown',
};
