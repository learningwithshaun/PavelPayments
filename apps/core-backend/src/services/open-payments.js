/**
 * open-payments.js
 *
 * Thin wrapper around the @interledger/open-payments SDK.
 * Handles wallet address resolution and outgoing payment creation.
 */

"use strict";

const { createAuthenticatedClient } = require("@interledger/open-payments");
const keyConfig = require("../config/keys");

let _client = null;

/** Lazily initialise the authenticated Open Payments client. */
async function getClient() {
  if (_client) return _client;

  if (!process.env.WALLET_ADDRESS) {
    throw new Error("Missing WALLET_ADDRESS in .env");
  }
  if (!process.env.KEY_ID) {
    throw new Error("Missing KEY_ID in .env");
  }
  if (!keyConfig.privateKeyPath) {
    throw new Error("Missing keys/private.key file");
  }

  _client = await createAuthenticatedClient({
    walletAddressUrl: process.env.WALLET_ADDRESS,
    privateKey: keyConfig.privateKeyPath,
    keyId: process.env.KEY_ID,
    validateResponses: false,
  });

  return _client;
}

/**
 * Resolve a wallet address / payment pointer to its full metadata.
 * @param {string} walletAddressUrl
 */
async function resolveWalletAddress(walletAddressUrl) {
  const client = await getClient();
  return client.walletAddress.get({ url: walletAddressUrl });
}

/**
 * Create an outgoing payment against a user's wallet using a stored access token.
 *
 * @param {{ uid: string, amount: number, currency: string, description: string }} options
 */
async function createOutgoingPayment({ uid, amount, currency, description }) {
  const client = await getClient();

  // Retrieve stored access token & wallet address for this user
  // (In production, look these up from your DB / Mandate model)
  const { accessToken, walletAddressUrl } = await _getTokenForUser(uid);

  const walletAddress = await client.walletAddress.get({ url: walletAddressUrl });

  const payment = await client.outgoingPayment.create(
    {
      url: walletAddress.resourceServer,
      accessToken,
    },
    {
      walletAddress: walletAddressUrl,
      quoteId: undefined, // Provide a quote ID for quote-based flows
      incomingAmount: { value: String(amount), assetCode: currency, assetScale: 2 },
      metadata: { description },
    }
  );

  return payment;
}

/** Look up the active mandate (access token + wallet) for a user by nfcUid. */
async function _getTokenForUser(uid) {
  const { User, Mandate } = require("../models");
  const user = await User.findOne({ where: { nfcUid: uid } });
  if (!user) throw new Error(`No user found for NFC UID: ${uid}`);

  const mandate = await Mandate.findOne({
    where: { userId: user.id, isActive: true },
    order: [["createdAt", "DESC"]],
  });
  if (!mandate) throw new Error(`No active mandate for user: ${user.id}`);

  return { accessToken: mandate.accessToken, walletAddressUrl: user.walletAddress };
}

/**
 * Create an outgoing payment using a pre-fetched Mandate record.
 * Used by the settlement cron which already has the mandate in hand.
 *
 * @param {{ mandate: object, walletAddress: string, amount: number, currency: string, description: string }} opts
 */
async function createOutgoingPaymentFromMandate({ mandate, walletAddress, amount, currency, description }) {
  const client = await getClient();
  const wallet = await client.walletAddress.get({ url: walletAddress });

  const payment = await client.outgoingPayment.create(
    { url: wallet.resourceServer, accessToken: mandate.accessToken },
    {
      walletAddress,
      incomingAmount: { value: String(amount), assetCode: currency, assetScale: 2 },
      metadata: { description },
    }
  );

  return payment;
}

module.exports = { getClient, resolveWalletAddress, createOutgoingPayment, createOutgoingPaymentFromMandate };
