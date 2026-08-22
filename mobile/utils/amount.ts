/**
 * utils/amount.ts
 * Fixed-point Stellar amount utility using BigInt stroops (1 XLM = 10,000,000 stroops).
 *
 * Stellar amounts have exactly 7 decimal places of precision. Relying on IEEE-754
 * double floating-point numbers (`parseFloat`, `.toFixed(7)`) introduces rounding and
 * comparison errors near precision boundaries (e.g., `9.5000007 + 0.5`).
 *
 * This module provides parsing, comparison, and string formatting routines using
 * BigInt stroop integers to ensure exact arithmetic compatible with Stellar Horizon.
 */

export const STROOPS_PER_XLM = 10_000_000n;
export const FEE_BUFFER_STROOPS = 5_000_000n; // 0.5 XLM network fee buffer

/**
 * Parses a numeric, string, or arbitrary representation of a Stellar amount into BigInt stroops.
 * Returns `null` if the input is null/undefined, empty, negative, invalid, or has > 7 decimal places.
 */
export function parseAmountToStroops(amount: unknown): bigint | null {
  if (amount === null || amount === undefined) {
    return null;
  }

  let str: string;
  if (typeof amount === 'string') {
    str = amount.trim();
  } else if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || Number.isNaN(amount)) {
      return null;
    }
    str = amount.toString();
  } else {
    return null;
  }

  if (!str) {
    return null;
  }

  // Regex to validate non-negative decimal format with at most 7 decimal places
  if (!/^\d+(\.\d{1,7})?$/.test(str)) {
    return null;
  }

  const [intPart, decPart = ''] = str.split('.');
  const paddedDec = decPart.padEnd(7, '0');

  try {
    const stroops = BigInt(intPart + paddedDec);
    return stroops >= 0n ? stroops : null;
  } catch {
    return null;
  }
}

/**
 * Formats BigInt stroops into an exact 7-decimal fixed-point string representation
 * (e.g. `10000000n` -> `"1.0000000"`). This format is required by Stellar Horizon and backend API.
 */
export function formatStroopsToXLM(stroops: bigint): string {
  if (typeof stroops !== 'bigint') {
    try {
      stroops = BigInt(stroops);
    } catch {
      return '0.0000000';
    }
  }
  const sign = stroops < 0n ? '-' : '';
  const abs = stroops < 0n ? -stroops : stroops;
  const str = abs.toString().padStart(8, '0');
  const intPart = str.slice(0, str.length - 7);
  const decPart = str.slice(str.length - 7);
  return `${sign}${intPart}.${decPart}`;
}

/**
 * Formats BigInt stroops for UI display with a specified number of decimal places (default 2).
 * Truncates extra decimals without floating-point errors (e.g. `105000000n` -> `"10.50"`).
 */
export function formatStroopsToDisplay(stroops: bigint, decimals: number = 2): string {
  const fullXLM = formatStroopsToXLM(stroops);
  if (decimals === 7) {
    return fullXLM;
  }
  const [intPart, decPart] = fullXLM.split('.');
  if (decimals <= 0) {
    return intPart;
  }
  const truncatedDec = decPart.slice(0, decimals).padEnd(decimals, '0');
  return `${intPart}.${truncatedDec}`;
}

/**
 * Compares two BigInt stroop amounts.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareStroops(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Returns true if available balance in stroops is greater than or equal to required stroops.
 */
export function isBalanceSufficient(availableStroops: bigint, requiredStroops: bigint): boolean {
  return availableStroops >= requiredStroops;
}
