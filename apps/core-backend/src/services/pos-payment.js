// Copied from OpenRemit/backend/src/lib/quoteFlow.ts and converted to CommonJS.
// Trimmed to steps 1–3 only: resolve merchant wallet → request incoming-payment
// grant → create incoming payment. Returns the payment URL for QR encoding.
// Steps 4–6 (quote grant, quote creation, DB write) are not needed for POS.
"use strict";

const crypto = require('crypto');
const { getClient } = require('./open-payments');
const { normaliseWalletAddress, isFinalizedGrant, isPendingGrant } = require('./pos-open-payments');

// In-memory store for active POS payments so the status endpoint can reuse
// the same access token without requesting a new grant each poll cycle.
// Map<incomingPaymentId: string, { accessToken: string, resourceServer: string }>
const _activePayments = new Map();

// In-memory store for pending customer consents (the interactive half of the
// flow). Keyed by a short-lived payId carried through the wallet redirect.
// Map<payId: string, { grantContinueUri, grantContinueToken, quoteId, resourceServer, walletId, incomingPaymentId }>
const _pendingConsents = new Map();

/**
 * Create an incoming payment on the merchant's wallet.
 * This is the QR payload — the raw incoming payment URL is what the customer's
 * Interledger wallet reads when they scan the code.
 *
 * Steps taken (from quoteFlow.ts steps 1–3 only):
 *   1. Resolve the merchant wallet address
 *   2. Request a non-interactive incoming-payment grant on the merchant's auth server
 *   3. Create the incoming payment with the exact amount
 *
 * @param {{ amountCents: number, currency: string, description: string }} opts
 * @returns {{ incomingPaymentId: string, paymentUrl: string, expiresAt: string|null }}
 */
async function createPOSIncomingPayment({ amountCents, currency, description }) {
  const merchantWalletUrl = normaliseWalletAddress(
    process.env.MERCHANT_WALLET_ADDRESS ?? process.env.WALLET_ADDRESS
  );
  const client = await getClient();

  // Step 1: Resolve merchant wallet
  const merchantWallet = await client.walletAddress.get({ url: merchantWalletUrl });

  // Step 2: Non-interactive incoming-payment grant (merchant's auth server)
  const incomingPaymentGrant = await client.grant.request(
    { url: merchantWallet.authServer },
    {
      access_token: {
        access: [{ type: 'incoming-payment', actions: ['create', 'read', 'complete'] }],
      },
    }
  );
  if (!isFinalizedGrant(incomingPaymentGrant)) {
    throw new Error('Expected non-interactive incoming-payment grant');
  }

  // Step 3: Create incoming payment with exact amount on merchant wallet.
  // Use the merchant wallet's real asset so the request is always valid, and
  // scale the scale-2 cents amount up/down to the wallet's asset scale.
  const assetCode  = merchantWallet.assetCode;
  const assetScale = merchantWallet.assetScale;
  const scaleDelta = assetScale - 2;
  const value = scaleDelta >= 0
    ? (BigInt(amountCents) * (10n ** BigInt(scaleDelta))).toString()
    : (BigInt(amountCents) / (10n ** BigInt(-scaleDelta))).toString();

  const incomingPayment = await client.incomingPayment.create(
    {
      url: merchantWallet.resourceServer,
      accessToken: incomingPaymentGrant.access_token.value,
    },
    {
      walletAddress: merchantWallet.id,
      incomingAmount: {
        value,
        assetCode,
        assetScale,
      },
      metadata: { description },
    }
  );

  // Store access token + resource server so the status endpoint can reuse them
  // without requesting a new grant on every poll cycle.
  _activePayments.set(incomingPayment.id, {
    accessToken:    incomingPaymentGrant.access_token.value,
    resourceServer: merchantWallet.resourceServer,
  });

  return {
    incomingPaymentId: incomingPayment.id,
    paymentUrl:        incomingPayment.id, // raw incoming payment URL
    expiresAt:         incomingPayment.expiresAt ?? null,
    assetCode,
    assetScale,
    value,
  };
}

/**
 * Fetch the current state of a POS incoming payment.
 * Reuses the stored access token from when the payment was created.
 *
 * @param {string} incomingPaymentId  The full incoming payment URL (used as ID)
 * @returns {{ status: 'pending'|'completed', receivedAmount: object, incomingAmount: object }}
 */
async function getPOSPaymentStatus(incomingPaymentId) {
  const stored = _activePayments.get(incomingPaymentId);
  if (!stored) {
    throw new Error('Payment not found or already completed');
  }

  const client = await getClient();
  const payment = await client.incomingPayment.get({
    url:         incomingPaymentId,
    accessToken: stored.accessToken,
  });

  const received = BigInt(payment.receivedAmount?.value ?? '0');
  const expected = BigInt(payment.incomingAmount?.value ?? '0');
  const completed = payment.completed || (expected > 0n && received >= expected);

  if (completed) {
    _activePayments.delete(incomingPaymentId);
  }

  return {
    status:         completed ? 'completed' : 'pending',
    receivedAmount: payment.receivedAmount,
    incomingAmount: payment.incomingAmount,
    completed:      payment.completed,
  };
}

/**
 * Customer side, part 1 — quote the payment on the customer's wallet and request
 * an INTERACTIVE outgoing-payment grant. The auth server returns a redirect URL
 * pointing at the customer's wallet consent screen; the caller redirects the
 * customer's browser there to approve the payment.
 *
 * @param {{ incomingPaymentId: string, customerWalletAddress: string, buildCallbackUrl: (payId: string) => string }} opts
 * @returns {{ payId: string, interactUrl: string, debitAmount: object, receiveAmount: object }}
 */
async function createPaymentConsent({ incomingPaymentId, customerWalletAddress, buildCallbackUrl }) {
  const client = await getClient();
  const customerUrl = normaliseWalletAddress(customerWalletAddress);

  // Resolve the customer's (sending) wallet
  const sendingWallet = await client.walletAddress.get({ url: customerUrl });

  // Non-interactive quote grant on the customer's auth server
  const quoteGrant = await client.grant.request(
    { url: sendingWallet.authServer },
    { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
  );
  if (!isFinalizedGrant(quoteGrant)) {
    throw new Error('Expected non-interactive quote grant');
  }

  // Create the quote — receiver is the merchant's incoming payment URL.
  // The incoming payment already carries incomingAmount (fixed receive), so we
  // omit debitAmount and let the quote compute what the customer must pay.
  const quote = await client.quote.create(
    { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
    { walletAddress: sendingWallet.id, receiver: incomingPaymentId, method: 'ilp' }
  );

  // Generate the payId up front so the callback URL can carry it back to us
  const payId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const callbackUrl = buildCallbackUrl(payId);

  // Interactive outgoing-payment grant → returns a redirect to the wallet's
  // consent screen, where the customer approves the exact debit amount.
  const outgoingGrant = await client.grant.request(
    { url: sendingWallet.authServer },
    {
      access_token: {
        access: [
          {
            type: 'outgoing-payment',
            actions: ['create', 'read'],
            identifier: sendingWallet.id,
            limits: {
              debitAmount: {
                value:      quote.debitAmount.value,
                assetCode:  quote.debitAmount.assetCode,
                assetScale: quote.debitAmount.assetScale,
              },
            },
          },
        ],
      },
      interact: {
        start: ['redirect'],
        finish: { method: 'redirect', uri: callbackUrl, nonce },
      },
    }
  );

  if (!isPendingGrant(outgoingGrant) || !outgoingGrant.interact?.redirect) {
    throw new Error('Expected interactive outgoing-payment grant with interact.redirect');
  }

  _pendingConsents.set(payId, {
    grantContinueUri:   outgoingGrant.continue.uri,
    grantContinueToken: outgoingGrant.continue.access_token.value,
    quoteId:            quote.id,
    resourceServer:     sendingWallet.resourceServer,
    walletId:           sendingWallet.id,
    incomingPaymentId,
  });

  return {
    payId,
    interactUrl:   outgoingGrant.interact.redirect,
    debitAmount:   quote.debitAmount,
    receiveAmount: quote.receiveAmount,
  };
}

/**
 * Customer side, part 2 — the wallet redirected the customer back to us with an
 * interact_ref. Continue the grant to obtain an access token, then create the
 * outgoing payment from the quote. This is the moment money actually moves.
 *
 * @param {{ payId: string, interactRef: string }} opts
 * @returns {object} the created outgoing payment
 */
async function finalizePaymentConsent({ payId, interactRef }) {
  const pending = _pendingConsents.get(payId);
  if (!pending) throw new Error('Payment session not found or already completed');

  const client = await getClient();

  // Exchange interact_ref for an outgoing-payment access token
  const finalizedGrant = await client.grant.continue(
    { url: pending.grantContinueUri, accessToken: pending.grantContinueToken },
    { interact_ref: interactRef }
  );
  if (!isFinalizedGrant(finalizedGrant)) {
    throw new Error('Grant continuation did not return an access token (consent denied or expired)');
  }

  // Create the outgoing payment using the quote from part 1 → funds transfer
  const outgoingPayment = await client.outgoingPayment.create(
    { url: pending.resourceServer, accessToken: finalizedGrant.access_token.value },
    { walletAddress: pending.walletId, quoteId: pending.quoteId, metadata: { description: 'PavelGym POS payment' } }
  );

  _pendingConsents.delete(payId);
  return outgoingPayment;
}

module.exports = {
  createPOSIncomingPayment,
  getPOSPaymentStatus,
  createPaymentConsent,
  finalizePaymentConsent,
};
