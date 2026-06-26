// Copied from OpenRemit/backend/src/lib/openPayments.ts and converted to CommonJS.
// Provides normaliseWalletAddress + isFinalizedGrant helpers used by pos-payment.js.
// getClient() is provided by the existing open-payments.js singleton.
"use strict";

const { isPendingGrant, isFinalizedGrant } = require('@interledger/open-payments');

/**
 * Convert shorthand "$ilp.example.com/alice" → "https://ilp.example.com/alice".
 * The SDK also accepts full https:// URLs, so this is safe to call either way.
 * @param {string} addr
 * @returns {string}
 */
function normaliseWalletAddress(addr) {
  return addr.startsWith('$') ? `https://${addr.slice(1)}` : addr;
}

module.exports = { normaliseWalletAddress, isFinalizedGrant, isPendingGrant };
