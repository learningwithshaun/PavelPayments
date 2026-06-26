/**
 * paymentController.js
 *
 * POST /api/trigger-payment
 * Called by the edge-terminal when an NFC scan is detected.
 * Looks up the user's active mandate and creates an outgoing payment.
 */

"use strict";

const openPaymentsService = require("../services/open-payments");
const billingService = require("../services/billing");
const { Transaction, User } = require("../models");

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function triggerPayment(req, res) {
  const { uid, terminalId } = req.body;

  if (!uid || typeof uid !== "string") {
    return res.status(400).json({ message: "Missing or invalid uid" });
  }

  try {
    // 1. Determine charge amount based on billing rules
    const charge = await billingService.calculateCharge({ uid, terminalId });

    // 2. Execute the outgoing payment via Open Payments SDK
    const payment = await openPaymentsService.createOutgoingPayment({
      uid,
      amount: charge.amount,
      currency: charge.currency,
      description: charge.description,
    });

    // 3. Persist the transaction record
    const user = await User.findOne({ where: { nfcUid: uid } });
    if (!user) {
      throw new Error(`No user found for NFC UID: ${uid}`);
    }

    const tx = await Transaction.create({
      userId: user.id,
      walletAddress: user.walletAddress,
      paymentId: payment.id,
      amount: charge.amount,
      currency: charge.currency,
      description: charge.description,
      status: "completed",
    });

    return res.status(201).json({ success: true, transaction: tx });
  } catch (err) {
    console.error("[paymentController] triggerPayment error:", err);
    return res.status(500).json({ message: "Payment failed", error: err.message });
  }
}

module.exports = { triggerPayment };
