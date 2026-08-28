const { StrKey } = require('@stellar/stellar-sdk');

/**
 * Cross-runtime validation helper for Stellar addresses.
 * Derived from shared/rules/validation.json definitions.
 */
function isValidStellarAddress(address) {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch (err) {
    return false;
  }
}

module.exports = {
  isValidStellarAddress
};
