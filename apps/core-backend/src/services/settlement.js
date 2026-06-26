/**
 * settlement.js
 *
 * Midnight settlement cron job.
 *
 * Called once per day (00:00) to:
 *  1. Auto-close any still-open gym / streaming sessions
 *  2. Calculate each active subscriber's charge for "yesterday"
 *  3. Fire an Open Payments outgoing payment using their stored Mandate
 *  4. Write a DailySettlement record (charged / skipped / failed)
 *  5. Advance nextBillingDate for non-daily tiers
 *
 * The settlement date processed is always "yesterday" relative to when
 * the job runs (midnight = start of new day, settle the completed day).
 */

"use strict";

const { Op } = require("sequelize");
const {
  Subscription,
  Mandate,
  User,
  Transaction,
  DailySettlement,
  StreamSession,
} = require("../models");
const gymSessionService = require("./gym-session");
const billingService = require("./billing");
const openPaymentsService = require("./open-payments");

/**
 * Returns the YYYY-MM-DD string for yesterday in local time.
 */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Advance a billing date by one tier period.
 * @param {string} date  — YYYY-MM-DD
 * @param {string} tier  — daily | weekly | monthly | yearly
 * @returns {string}
 */
function advanceBillingDate(date, tier) {
  const d = new Date(date);
  switch (tier) {
    case "weekly":  d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly":  d.setFullYear(d.getFullYear() + 1); break;
    default:        d.setDate(d.getDate() + 1); // daily
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Settle one subscription for the given date.
 * Returns a DailySettlement record.
 *
 * @param {Subscription} subscription
 * @param {string} settleDate — YYYY-MM-DD
 */
async function settleOne(subscription, settleDate) {
  const user = await User.findByPk(subscription.userId);
  if (!user) return;

  // Prevent duplicate settlement processing for the same user/service/date.
  const existingSettlement = await DailySettlement.findOne({
    where: {
      userId: user.id,
      serviceType: subscription.serviceType,
      settlementDate: settleDate,
      status: { [Op.in]: ["charged", "skipped"] },
    },
  });
  if (existingSettlement) {
    console.log(
      `[settlement] Already settled for user=${user.id} service=${subscription.serviceType} date=${settleDate}`
    );
    return;
  }

  const mandate = await Mandate.findByPk(subscription.mandateId);
  if (!mandate || !mandate.isActive) {
    console.warn(`[settlement] No active mandate for subscription ${subscription.id}`);
    return;
  }

  let chargeResult;
  let totalMinutes = 0;
  let breakdown = {};

  if (subscription.serviceType === "gym") {
    // Close any open sessions before summing
    await gymSessionService.closeOpenSessions(user.id);

    const { totalMinutes: mins, peakMinutes } = await gymSessionService.getDailyMinutes({
      userId: user.id,
      date: settleDate,
    });

    totalMinutes = mins;

    // Dynamic: skip if user did not visit
    if (subscription.subscriptionType === "dynamic" && totalMinutes === 0) {
      await DailySettlement.create({
        userId: user.id,
        serviceType: "gym",
        settlementDate: settleDate,
        totalMinutes: 0,
        chargeAmountCents: 0,
        currency: user.preferredCurrency ?? "USD",
        status: "skipped",
        breakdown: {},
      });
      return;
    }

    chargeResult =
      subscription.subscriptionType === "dynamic"
        ? billingService.calculateGymDynamicCharge({
            tier: subscription.tier,
            totalMinutes,
            peakMinutes,
            currency: user.preferredCurrency ?? "USD",
          })
        : billingService.calculateGymStaticCharge({
            tier: subscription.tier,
            currency: user.preferredCurrency ?? "USD",
          });

    breakdown = chargeResult.breakdown;

  } else if (subscription.serviceType === "streaming") {
    // Web Monetization model: payment was streamed in real time straight to the
    // service wallet while the user watched, so settlement does NOT charge again.
    // We only record the day's streamed total for history/reporting and return
    // before any outgoing payment is fired.
    const streamSessions = await StreamSession.findAll({
      where: {
        userId: user.id,
        date: settleDate,
        endedAt: { [Op.ne]: null },
      },
    });

    const totalStreamed = streamSessions.reduce((sum, s) => sum + (s.streamedCents ?? 0), 0);
    const streamedMinutes = streamSessions.reduce((sum, s) => sum + (s.minutesWatched ?? 0), 0);

    await DailySettlement.create({
      userId: user.id,
      serviceType: "streaming",
      settlementDate: settleDate,
      totalMinutes: streamedMinutes,
      chargeAmountCents: 0, // nothing is charged at settlement — WM paid in real time
      currency: user.preferredCurrency ?? "USD",
      status: "skipped",
      breakdown: {
        method: "web-monetization",
        totalStreamedCents: totalStreamed,
        sessions: streamSessions.map((s) => ({
          contentId: s.contentId,
          contentTitle: s.contentTitle,
          minutesWatched: s.minutesWatched ?? 0,
          streamedCents: s.streamedCents ?? 0,
          assetCode: s.assetCode ?? "USD",
        })),
      },
    });
    return;
  }

  // Fire Open Payments outgoing payment
  let paymentId = null;
  let settlementStatus = "failed";
  let transactionId = null;

  try {
    const payment = await openPaymentsService.createOutgoingPaymentFromMandate({
      mandate,
      walletAddress: user.walletAddress,
      amount: chargeResult.amount,
      currency: chargeResult.currency,
      description: `${subscription.serviceType} settlement — ${settleDate} (${subscription.tier} ${subscription.subscriptionType})`,
    });

    paymentId = payment.id;

    // Record transaction
    const tx = await Transaction.create({
      userId: user.id,
      walletAddress: user.walletAddress,
      paymentId,
      amount: chargeResult.amount,
      currency: chargeResult.currency,
      description: `${subscription.serviceType} — ${settleDate}`,
      status: "completed",
    });

    transactionId = tx.id;
    settlementStatus = "charged";
  } catch (err) {
    console.error(`[settlement] Payment failed for user ${user.id}:`, err.message);
    settlementStatus = "failed";
  }

  await DailySettlement.create({
    userId: user.id,
    serviceType: subscription.serviceType,
    settlementDate: settleDate,
    totalMinutes,
    chargeAmountCents: chargeResult.amount,
    currency: chargeResult.currency,
    transactionId,
    status: settlementStatus,
    breakdown,
  });

  // Advance next billing date for non-daily tiers on a successful charge
  if (settlementStatus === "charged" && subscription.tier !== "daily") {
    await subscription.update({
      nextBillingDate: advanceBillingDate(subscription.nextBillingDate, subscription.tier),
    });
  }
}

/**
 * Main settlement entry point — called by the cron job at midnight.
 * Processes all active subscriptions whose nextBillingDate <= today.
 */
async function runDailySettlement() {
  const settleDate = yesterday();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[settlement] Starting settlement for ${settleDate}`);

  const subscriptions = await Subscription.findAll({
    where: {
      isActive: true,
      nextBillingDate: { [Op.lte]: today },
    },
  });

  console.log(`[settlement] Processing ${subscriptions.length} subscription(s)`);

  for (const sub of subscriptions) {
    try {
      await settleOne(sub, settleDate);
    } catch (err) {
      console.error(`[settlement] Error settling subscription ${sub.id}:`, err.message);
    }
  }

  console.log(`[settlement] Completed settlement for ${settleDate}`);
}

module.exports = { runDailySettlement, settleOne };
