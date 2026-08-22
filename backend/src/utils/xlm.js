"use strict";

const STROOPS_PER_XLM = 10_000_000n;
const XLM_DECIMAL_PLACES = 7;

function isDigits(part) {
  if (part === "") return false;
  for (const character of part) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

// Rounds a decimal string with more than 7 fractional digits (or any digit
// string) to the nearest stroop using pure string math, so no IEEE-754 double
// is ever involved. Half-up rounding; `neg` applies the sign afterwards.
function roundFractionToStroops(wholeText, fractionText, neg) {
  const kept = fractionText.slice(0, XLM_DECIMAL_PLACES).padEnd(XLM_DECIMAL_PLACES, "0");
  const dropped = fractionText.slice(XLM_DECIMAL_PLACES);
  let stroops = BigInt(wholeText) * STROOPS_PER_XLM + BigInt(kept);
  if (dropped.length > 0 && Number(dropped[0]) >= 5) stroops += 1n;
  return neg ? -stroops : stroops;
}

/**
 * Convert an XLM amount to integer stroops, tolerating values that carry more
 * precision than Stellar's 7 decimals by rounding half-up to the nearest
 * stroop. This exists for boundary data that predates exact handling — legacy
 * event payloads serialized from doubles, or third-party strings. Values at
 * or below 7 decimals are converted exactly, exactly like xlmToStroops.
 *
 * @param {string|number|bigint} value - XLM amount.
 * @returns {bigint} Amount in stroops.
 * @throws {Error} If the value is not a decimal number.
 */
function xlmToStroopsRounded(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("XLM amount must be finite");
    // Doubles are the lossy artifact being repaired here; stringify first,
    // then round the decimal expansion — never do arithmetic on the double.
    value = value.toString();
  }
  const text = String(value).trim();
  const parts = text.split(".");
  const wholeText = parts[0].replace(/^-/, "");
  const fractionText = parts[1] || "";
  const negative = text.startsWith("-");
  if (
    parts.length > 2 ||
    !isDigits(wholeText) ||
    (parts.length === 2 && !isDigits(fractionText))
  ) {
    throw new Error("XLM amount must be a decimal number");
  }
  return roundFractionToStroops(wholeText, fractionText, negative);
}

/**
 * Canonicalize any XLM-like input to the exact 7-decimal string form used
 * across API responses and NUMERIC(20,7) columns. Conversion happens only
 * here and at the chain/display boundaries; everything inside the system is
 * either this string or integer stroops.
 *
 * @param {string|number|bigint|null|undefined} value - XLM amount.
 * @param {string} [fallback] - Returned when value is null/undefined/"".
 * @returns {string} Amount as a fixed 7-decimal string, e.g. "1.2345678".
 * @throws {Error} If value is present but not a decimal number.
 */
function normalizeXlm(value, fallback = "0.0000000") {
  if (value === null || value === undefined || value === "") return fallback;
  return stroopsToXlm(xlmToStroopsRounded(value));
}

/**
 * Compare two XLM amounts exactly (via stroops).
 *
 * @param {string|number|bigint} a
 * @param {string|number|bigint} b
 * @returns {-1|0|1} Negative when a < b, zero when equal, positive when a > b.
 */
function compareXlm(a, b) {
  const stroopsA = xlmToStroopsRounded(a);
  const stroopsB = xlmToStroopsRounded(b);
  if (stroopsA < stroopsB) return -1;
  if (stroopsA > stroopsB) return 1;
  return 0;
}

/**
 * Sum XLM amounts exactly and return the canonical 7-decimal string.
 *
 * @param {Array<string|number|bigint>} amounts
 * @returns {string} Exact sum as a fixed 7-decimal string.
 */
function sumXlm(amounts) {
  let total = 0n;
  for (const amount of amounts) total += xlmToStroopsRounded(amount);
  return stroopsToXlm(total);
}

function xlmToStroops(value) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("XLM amount must be finite");
    text = value.toFixed(XLM_DECIMAL_PLACES);
  } else {
    text = String(value).trim();
  }

  const parts = text.split(".");
  const wholeText = parts[0];
  const fractionText = parts[1] || "";
  if (
    parts.length > 2 ||
    !wholeText ||
    !isDigits(wholeText) ||
    (parts.length === 2 && (!fractionText || fractionText.length > XLM_DECIMAL_PLACES || !isDigits(fractionText)))
  ) {
    throw new Error("XLM amount must have at most 7 decimal places");
  }

  const whole = BigInt(wholeText);
  const fraction = BigInt(fractionText.padEnd(XLM_DECIMAL_PLACES, "0"));
  return whole * STROOPS_PER_XLM + fraction;
}

function stroopsToXlm(stroops) {
  const amount = BigInt(stroops);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM)
    .toString()
    .padStart(XLM_DECIMAL_PLACES, "0");
  return `${sign}${whole}.${fraction}`;
}

module.exports = {
  STROOPS_PER_XLM,
  xlmToStroops,
  xlmToStroopsRounded,
  stroopsToXlm,
  normalizeXlm,
  compareXlm,
  sumXlm,
};
