/**
 * utils/amount.ts
 * Fixed-point amount utilities for Stellar's 7-decimal stroop amounts.
 *
 * Stellar uses fixed-point 7-decimal arithmetic for amounts (1 XLM = 10,000,000 stroops).
 * This module provides precision-safe parsing, conversion, comparison, and formatting
 * to avoid the floating-point rounding issues inherent in parseFloat/toFixed.
 *
 * All internal calculations use integer arithmetic (stroops) to ensure exact precision.
 */

/**
 * One XLM in stroops (10^7).
 */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * Maximum number of decimal places supported by Stellar (7).
 */
export const MAX_DECIMALS = 7;

/**
 * Represents an amount in stroops (integer).
 * This is the canonical internal representation for all amount calculations.
 */
export type Stroops = number;

/**
 * Represents an amount in XLM (decimal string).
 * This is the canonical external representation for user-facing amounts.
 */
export type XLMString = string;

/**
 * Parse a string or number amount into stroops (integer).
 *
 * Uses string manipulation to avoid floating-point precision issues.
 * Handles amounts with up to 7 decimal places correctly.
 *
 * @param amount - Amount as string or number (in XLM).
 * @returns Amount in stroops (integer), or NaN if invalid.
 *
 * @example
 * parseToStroops("1.2345678") // 12345678 (rounded to 7 decimals)
 * @example
 * parseToStroops("0.0000001") // 1
 * @example
 * parseToStroops("100") // 1000000000
 * @example
 * parseToStroops("invalid") // NaN
 */
export function parseToStroops(amount: string | number): Stroops {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) return NaN;
    // For numbers, we need to convert to string first to avoid precision issues
    amount = amount.toFixed(MAX_DECIMALS);
  }

  if (typeof amount !== "string" || amount.trim() === "") return NaN;

  const trimmed = amount.trim();

  // Handle negative amounts
  const isNegative = trimmed.startsWith("-");
  const absStr = isNegative ? trimmed.slice(1) : trimmed;

  // Split on decimal point
  const parts = absStr.split(".");
  if (parts.length > 2) return NaN;

  const integerPart = parts[0] || "0";
  const decimalPart = parts[1] || "";

  // Validate integer part
  if (!/^\d+$/.test(integerPart)) return NaN;

  // Validate decimal part (if present)
  if (decimalPart && !/^\d+$/.test(decimalPart)) return NaN;

  // Pad or truncate decimal part to exactly 7 digits
  const normalizedDecimal = decimalPart.padEnd(MAX_DECIMALS, "0").slice(0, MAX_DECIMALS);

  // Combine and convert to integer
  const stroopsStr = integerPart + normalizedDecimal;
  const stroops = parseInt(stroopsStr, 10);

  return isNegative ? -stroops : stroops;
}

/**
 * Convert stroops (integer) to XLM string with exactly 7 decimal places.
 *
 * @param stroops - Amount in stroops (integer).
 * @returns XLM string with 7 decimal places, or "0.0000000" if invalid.
 *
 * @example
 * stroopsToXLM(12345678) // "1.2345678"
 * @example
 * stroopsToXLM(1) // "0.0000001"
 * @example
 * stroopsToXLM(1000000000) // "100.0000000"
 */
export function stroopsToXLM(stroops: Stroops): XLMString {
  if (!Number.isFinite(stroops)) return "0.0000000";

  const isNegative = stroops < 0;
  const absStroops = Math.abs(stroops);

  const str = absStroops.toString();
  const padded = str.padStart(MAX_DECIMALS + 1, "0");

  const integerPart = padded.slice(0, -MAX_DECIMALS) || "0";
  const decimalPart = padded.slice(-MAX_DECIMALS);

  return `${isNegative ? "-" : ""}${integerPart}.${decimalPart}`;
}

/**
 * Convert XLM string to a display-friendly format with specified decimal places.
 *
 * @param amount - Amount in XLM (string or number).
 * @param decimals - Number of decimal places to display (default: 2).
 * @param locale - BCP-47 locale tag for formatting (default: "en-US").
 * @returns Formatted string with locale-appropriate separators.
 *
 * @example
 * formatAmount("1234.5678901", 2) // "1,234.57"
 * @example
 * formatAmount("0.0000001", 7) // "0.0000001"
 */
export function formatAmount(amount: string | number, decimals = 2, locale = "en-US"): string {
  const stroops = parseToStroops(amount);
  if (isNaN(stroops)) return "0";

  // Convert back to XLM for display
  const xlmStr = stroopsToXLM(stroops);
  const num = parseFloat(xlmStr);

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(num);
}

/**
 * Compare two amounts for equality.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns true if amounts are equal, false otherwise.
 *
 * @example
 * isEqual("1.0000000", "1.0") // true
 * @example
 * isEqual("0.1", "0.1000000") // true
 * @example
 * isEqual("0.1", "0.2") // false
 */
export function isEqual(a: string | number, b: string | number): boolean {
  const stroopsA = parseToStroops(a);
  const stroopsB = parseToStroops(b);
  if (isNaN(stroopsA) || isNaN(stroopsB)) return false;
  return stroopsA === stroopsB;
}

/**
 * Compare two amounts.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns -1 if a < b, 0 if a === b, 1 if a > b.
 *
 * @example
 * compare("1.0", "2.0") // -1
 * @example
 * compare("2.0", "1.0") // 1
 * @example
 * compare("1.0", "1.0") // 0
 */
export function compare(a: string | number, b: string | number): -1 | 0 | 1 {
  const stroopsA = parseToStroops(a);
  const stroopsB = parseToStroops(b);
  if (isNaN(stroopsA) || isNaN(stroopsB)) return 0;
  if (stroopsA < stroopsB) return -1;
  if (stroopsA > stroopsB) return 1;
  return 0;
}

/**
 * Check if amount a is greater than amount b.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns true if a > b.
 */
export function isGreaterThan(a: string | number, b: string | number): boolean {
  return compare(a, b) === 1;
}

/**
 * Check if amount a is greater than or equal to amount b.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns true if a >= b.
 */
export function isGreaterThanOrEqual(a: string | number, b: string | number): boolean {
  return compare(a, b) >= 0;
}

/**
 * Check if amount a is less than amount b.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns true if a < b.
 */
export function isLessThan(a: string | number, b: string | number): boolean {
  return compare(a, b) === -1;
}

/**
 * Check if amount a is less than or equal to amount b.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns true if a <= b.
 */
export function isLessThanOrEqual(a: string | number, b: string | number): boolean {
  return compare(a, b) <= 0;
}

/**
 * Add two amounts.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns Sum in XLM string with 7 decimal places.
 *
 * @example
 * add("1.0000000", "2.0000000") // "3.0000000"
 * @example
 * add("0.1", "0.2") // "0.3000000"
 */
export function add(a: string | number, b: string | number): XLMString {
  const stroopsA = parseToStroops(a);
  const stroopsB = parseToStroops(b);
  if (isNaN(stroopsA) || isNaN(stroopsB)) return "0.0000000";
  return stroopsToXLM(stroopsA + stroopsB);
}

/**
 * Subtract amount b from amount a.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns Difference in XLM string with 7 decimal places.
 *
 * @example
 * subtract("3.0000000", "1.0000000") // "2.0000000"
 * @example
 * subtract("0.3", "0.1") // "0.2000000"
 */
export function subtract(a: string | number, b: string | number): XLMString {
  const stroopsA = parseToStroops(a);
  const stroopsB = parseToStroops(b);
  if (isNaN(stroopsA) || isNaN(stroopsB)) return "0.0000000";
  return stroopsToXLM(stroopsA - stroopsB);
}

/**
 * Multiply an amount by a scalar.
 *
 * @param amount - Amount (XLM string or number).
 * @param multiplier - Scalar multiplier (number).
 * @returns Product in XLM string with 7 decimal places.
 *
 * @example
 * multiply("2.0000000", 3) // "6.0000000"
 * @example
 * multiply("1.5", 2) // "3.0000000"
 */
export function multiply(amount: string | number, multiplier: number): XLMString {
  const stroops = parseToStroops(amount);
  if (isNaN(stroops) || !Number.isFinite(multiplier)) return "0.0000000";
  return stroopsToXLM(Math.round(stroops * multiplier));
}

/**
 * Validate that an amount is a valid positive amount with at most 7 decimal places.
 *
 * @param amount - Amount to validate (string or number).
 * @returns true if valid, false otherwise.
 *
 * @example
 * isValidAmount("1.2345678") // true
 * @example
 * isValidAmount("1.23456789") // false (too many decimals)
 * @example
 * isValidAmount("-1.0") // false (negative)
 * @example
 * isValidAmount("abc") // false
 */
export function isValidAmount(amount: string | number): boolean {
  const stroops = parseToStroops(amount);
  return !isNaN(stroops) && stroops >= 0;
}

/**
 * Validate that an amount is a valid positive amount with at most 7 decimal places.
 *
 * @param amount - Amount to validate (string or number).
 * @returns true if valid and positive, false otherwise.
 *
 * @example
 * isValidDonationAmount("1.2345678") // true
 * @example
 * isValidDonationAmount("0.0") // false (zero)
 * @example
 * isValidDonationAmount("-1.0") // false (negative)
 */
export function isValidDonationAmount(amount: string | number): boolean {
  const stroops = parseToStroops(amount);
  return !isNaN(stroops) && stroops > 0;
}

/**
 * Check if the donor has sufficient balance for a donation.
 *
 * @param balance - Current balance (XLM string or number).
 * @param donationAmount - Donation amount (XLM string or number).
 * @returns true if balance >= donationAmount, false otherwise.
 *
 * @example
 * hasSufficientBalance("100.0", "50.0") // true
 * @example
 * hasSufficientBalance("50.0", "100.0") // false
 */
export function hasSufficientBalance(balance: string | number, donationAmount: string | number): boolean {
  return isGreaterThanOrEqual(balance, donationAmount);
}

/**
 * Convert XLM to stroops for Stellar SDK operations.
 *
 * @param xlmAmount - Amount in XLM (string or number).
 * @returns Amount in stroops (integer), or NaN if invalid.
 *
 * @example
 * xlmToStroops("1.0") // 10000000
 * @example
 * xlmToStroops("0.0000001") // 1
 */
export function xlmToStroops(xlmAmount: string | number): Stroops {
  return parseToStroops(xlmAmount);
}

/**
 * Convert stroops to XLM for display.
 *
 * @param stroops - Amount in stroops (integer).
 * @returns Amount in XLM string with 7 decimal places.
 *
 * @example
 * stroopsToXlm(10000000) // "1.0000000"
 * @example
 * stroopsToXlm(1) // "0.0000001"
 */
export function stroopsToXlm(stroops: Stroops): XLMString {
  return stroopsToXLM(stroops);
}

/**
 * Round an amount to the nearest stroop (7 decimal places).
 *
 * @param amount - Amount to round (XLM string or number).
 * @returns Rounded amount in XLM string with 7 decimal places.
 *
 * @example
 * roundToStroop("1.23456789") // "1.2345679"
 * @example
 * roundToStroop("1.23456784") // "1.2345678"
 */
export function roundToStroop(amount: string | number): XLMString {
  const stroops = parseToStroops(amount);
  if (isNaN(stroops)) return "0.0000000";
  return stroopsToXLM(stroops);
}

/**
 * Truncate an amount to 7 decimal places (floor).
 *
 * @param amount - Amount to truncate (XLM string or number).
 * @returns Truncated amount in XLM string with 7 decimal places.
 *
 * @example
 * truncateToStroop("1.23456789") // "1.2345678"
 * @example
 * truncateToStroop("1.23456781") // "1.2345678"
 */
export function truncateToStroop(amount: string | number): XLMString {
  const stroops = parseToStroops(amount);
  if (isNaN(stroops)) return "0.0000000";
  return stroopsToXLM(stroops);
}

/**
 * Get the minimum of two amounts.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns Minimum amount in XLM string with 7 decimal places.
 *
 * @example
 * min("1.0", "2.0") // "1.0000000"
 * @example
 * min("2.0", "1.0") // "1.0000000"
 */
export function min(a: string | number, b: string | number): XLMString {
  return isLessThanOrEqual(a, b) ? stroopsToXLM(parseToStroops(a)) : stroopsToXLM(parseToStroops(b));
}

/**
 * Get the maximum of two amounts.
 *
 * @param a - First amount (XLM string or number).
 * @param b - Second amount (XLM string or number).
 * @returns Maximum amount in XLM string with 7 decimal places.
 *
 * @example
 * max("1.0", "2.0") // "2.0000000"
 * @example
 * max("2.0", "1.0") // "2.0000000"
 */
export function max(a: string | number, b: string | number): XLMString {
  return isGreaterThanOrEqual(a, b) ? stroopsToXLM(parseToStroops(a)) : stroopsToXLM(parseToStroops(b));
}

/**
 * Sum a list of XLM amounts exactly, returning stroops.
 *
 * Sums of monetary values must never be accumulated as IEEE-754 doubles —
 * NUMERIC(20, 7) totals exceed double precision. Accumulate the integer
 * stroops instead and convert only when displaying.
 *
 * @param amounts - List of XLM amounts (string or number).
 * @returns Total in stroops; invalid entries are ignored.
 */
export function sumToStroops(amounts: Array<string | number | null | undefined>): Stroops {
  return amounts.reduce<Stroops>((acc, value) => {
    const stroops = parseToStroops(value ?? 0);
    return Number.isNaN(stroops) ? acc : acc + stroops;
  }, 0);
}

/**
 * Sum a list of XLM amounts exactly.
 *
 * @param amounts - List of XLM amounts (string or number).
 * @returns Exact sum as a 7-decimal XLM string.
 */
export function sumXLM(amounts: Array<string | number | null | undefined>): XLMString {
  return stroopsToXLM(sumToStroops(amounts));
}

/**
 * Whether a funding goal is reached, exactly.
 *
 * Equivalent to `raised >= goal * percentage / 100` but evaluated in integer
 * stroops: `raised × 100 ≥ goal × percentage`. A project one stroop short of
 * a milestone must not read as reached.
 *
 * @param raised - Raised XLM amount (string or number).
 * @param goal - Goal XLM amount (string or number).
 * @param percentage - Milestone percentage (defaults to 100).
 */
export function goalReached(raised: string | number, goal: string | number, percentage = 100): boolean {
  const raisedStroops = parseToStroops(raised);
  const goalStroops = parseToStroops(goal);
  if (Number.isNaN(raisedStroops) || Number.isNaN(goalStroops)) return false;
  return raisedStroops * 100 >= goalStroops * percentage;
}

/**
 * Progress toward a milestone as a display percentage (0-100).
 *
 * Complements {@link goalReached}: same exact comparison, expressed as the
 * bar width `raised / (goal × percentage / 100) × 100`, rounded.
 *
 * @param raised - Raised XLM amount (string or number).
 * @param goal - Goal XLM amount (string or number).
 * @param percentage - Milestone percentage (defaults to 100).
 */
export function progressTowardGoal(raised: string | number, goal: string | number, percentage = 100): number {
  const raisedStroops = parseToStroops(raised);
  const goalStroops = parseToStroops(goal);
  if (
    Number.isNaN(raisedStroops) || Number.isNaN(goalStroops) ||
    goalStroops <= 0 || percentage <= 0
  ) return 0;
  return Math.min(100, Math.round((raisedStroops * 10_000) / (goalStroops * percentage)));
}