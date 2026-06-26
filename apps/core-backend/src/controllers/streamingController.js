/**
 * streamingController.js
 *
 * API endpoints for the streaming service:
 *  - POST /api/stream/start          — user presses Play
 *  - POST /api/stream/end            — user pauses or stops
 *  - GET  /api/stream/session/:uid   — current session + today's minutes + estimated charge
 *  - POST /api/stream/subscribe      — initiate a streaming subscription (GNAP flow)
 *  - GET  /api/stream/subscriptions/:uid
 *  - GET  /api/stream/pricing        — rate constants for the frontend
 */

"use strict";

const streamingSessionService = require("../services/streaming-session");
const gnapAuthService = require("../services/gnap-auth");
const billingService = require("../services/billing");
const { User, Subscription } = require("../models");

// ── Start stream ──────────────────────────────────────────────────────────────

/**
 * POST /api/stream/start
 * Body: { uid, contentId, contentTitle?, contentType? }
 */
async function startStream(req, res) {
  const { uid, contentId, contentTitle, contentType } = req.body;
  if (!uid || !contentId) {
    return res.status(400).json({ error: "uid and contentId are required" });
  }

  try {
    const session = await streamingSessionService.startStream({
      nfcUid: uid,
      contentId,
      contentTitle,
      contentType,
    });
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── End stream ────────────────────────────────────────────────────────────────

/**
 * POST /api/stream/end
 * Body: { sessionId }
 */
async function endStream(req, res) {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  try {
    const session = await streamingSessionService.endStream({ sessionId });
    res.json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Session status ────────────────────────────────────────────────────────────

/**
 * GET /api/stream/session/:uid
 */
async function getSession(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid is required" });

  try {
    const { currentSession, todayMinutes, user } =
      await streamingSessionService.getStreamStatus({ nfcUid: uid });

    const subscription = await Subscription.findOne({
      where: { userId: user.id, serviceType: "streaming", isActive: true },
      order: [["createdAt", "DESC"]],
    });

    let estimatedCharge = null;
    if (subscription && todayMinutes > 0) {
      estimatedCharge = billingService.calculateStreamingCharge({
        tier: subscription.tier,
        totalMinutes: todayMinutes,
        currency: user.preferredCurrency ?? "USD",
      });
    }

    res.json({ currentSession, todayMinutes, estimatedCharge, subscription });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

/**
 * POST /api/stream/subscribe
 * Body: { walletAddress, nfcUid, subscriptionType, tier }
 */
async function subscribe(req, res) {
  const { walletAddress, nfcUid, subscriptionType = "dynamic", tier = "monthly" } = req.body;

  if (!walletAddress || !nfcUid) {
    return res.status(400).json({ error: "walletAddress and nfcUid are required" });
  }

  try {
    let user = await User.findOne({ where: { nfcUid } });
    if (!user) {
      user = await User.create({ nfcUid, walletAddress });
    } else if (!user.walletAddress) {
      await user.update({ walletAddress });
    }

    const baseRateCents =
      subscriptionType === "dynamic"
        ? billingService.STREAMING_RATE_PER_MINUTE[tier] * 60 // hourly equivalent
        : billingService.GYM_STATIC_BASE[tier]; // reuse flat rates as a pricing reference

    let grantOpts = {};
    if (subscriptionType === "static" && tier !== "daily") {
      const intervalMap = { weekly: "P1W", monthly: "P1M", yearly: "P1Y" };
      const startISO = new Date().toISOString().split(".")[0] + "Z";
      grantOpts = {
        debitAmountCents: baseRateCents,
        currency: user.preferredCurrency ?? "USD",
        interval: `R/${startISO}/${intervalMap[tier]}`,
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const sub = await Subscription.create({
      userId: user.id,
      serviceType: "streaming",
      subscriptionType,
      tier,
      baseRateCents,
      startDate: today,
      nextBillingDate: today,
      isActive: false,
    });

    let interactRedirectUrl;
    try {
      const grant = await gnapAuthService.initiateGrant(walletAddress, {
        ...grantOpts,
        context: {
          userId: user.id,
          pendingSubscriptionId: sub.id,
          serviceType: "streaming",
        },
      });
      interactRedirectUrl = grant.interactRedirectUrl;
    } catch (grantErr) {
      await sub.destroy();
      throw grantErr;
    }

    res.json({ interactRedirectUrl, subscriptionId: sub.id });
  } catch (err) {
    console.error("[stream/subscribe]", err);
    res.status(500).json({ error: err.message });
  }
}

// ── List subscriptions ────────────────────────────────────────────────────────

async function listSubscriptions(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid is required" });

  try {
    const user = await User.findOne({ where: { nfcUid: uid } });
    if (!user) return res.json({ subscriptions: [] });

    const subscriptions = await Subscription.findAll({
      where: { userId: user.id, serviceType: "streaming", isActive: true },
      order: [["createdAt", "DESC"]],
    });

    res.json({ subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Pricing info ──────────────────────────────────────────────────────────────

function getPricing(_req, res) {
  res.json({
    ratesPerMinute: billingService.STREAMING_RATE_PER_MINUTE,
    currency: "USD",
    assetScale: 2,
  });
}

module.exports = { startStream, endStream, getSession, subscribe, listSubscriptions, getPricing };
