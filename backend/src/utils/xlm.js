"use strict";

const STROOPS_PER_XLM = 10_000_000n;
const XLM_DECIMAL_PLACES = 7;

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
  const isDigits = (part) => {
    for (const character of part) {
      if (character < "0" || character > "9") return false;
    }
    return true;
  };
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
  stroopsToXlm,
};
