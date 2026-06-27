/**
 * gymController.js
 *
 * Handles all gym-related API endpoints:
 *  - POST /api/gym/tap-in           — record gym entry
 *  - POST /api/gym/tap-out          — record gym exit
 *  - GET  /api/gym/session/:uid     — current session status + today's minutes
 *  - POST /api/gym/subscribe        — initiate a gym subscription (GNAP flow)
 *  - GET  /api/gym/subscriptions/:uid — list active subscriptions for a user
 *
 * Pricing constants (cents) are imported from billing.js so they can be
 * displayed on the frontend without a separate API call.
 */

"use strict";

const gymSessionService = require("../services/gym-session");
const gnapAuthService = require("../services/gnap-auth");
const billingService = require("../services/billing");
const { User, Subscription, Mandate } = require("../models");

// ── Tap In ────────────────────────────────────────────────────────────────────

/**
 * POST /api/gym/tap-in
 * Body: { uid: string, terminalId?: string }
 */
async function tapIn(req, res) {
  const { uid, terminalId = "gym-door-1" } = req.body;
  if (!uid || typeof uid !== "string") {
    return res.status(400).json({ error: "uid is required" });
  }

  try {
    const session = await gymSessionService.tapIn({ nfcUid: uid, terminalId });
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Tap Out ───────────────────────────────────────────────────────────────────

/**
 * POST /api/gym/tap-out
 * Body: { uid: string, terminalId?: string }
 */
async function tapOut(req, res) {
  const { uid, terminalId = "gym-door-1" } = req.body;
  if (!uid || typeof uid !== "string") {
    return res.status(400).json({ error: "uid is required" });
  }

  try {
    const session = await gymSessionService.tapOut({ nfcUid: uid, terminalId });
    res.status(200).json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Session Status ────────────────────────────────────────────────────────────

/**
 * GET /api/gym/session/:uid
 * Returns the open session (if any) and today's accumulated minutes.
 * Also includes estimated charge so the UI can display a live preview.
 */
async function getSession(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid is required" });

  try {
    const { currentSession, todayMinutes, peakMinutes, user } =
      await gymSessionService.getSessionStatus({ nfcUid: uid });

    // Find the user's active gym subscription for the charge preview
    const subscription = await Subscription.findOne({
      where: { userId: user.id, serviceType: "gym", isActive: true },
      order: [["createdAt", "DESC"]],
    });

    let estimatedCharge = null;
    if (subscription && todayMinutes > 0) {
      const result =
        subscription.subscriptionType === "dynamic"
          ? billingService.calculateGymDynamicCharge({
              tier: subscription.tier,
              totalMinutes: todayMinutes,
              peakMinutes,
              currency: user.preferredCurrency ?? "USD",
            })
          : billingService.calculateGymStaticCharge({
              tier: subscription.tier,
              currency: user.preferredCurrency ?? "USD",
            });
      estimatedCharge = result;
    }

    res.json({
      currentSession,
      todayMinutes,
      peakMinutes,
      estimatedCharge,
      subscription: subscription
        ? { tier: subscription.tier, subscriptionType: subscription.subscriptionType }
        : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

/**
 * POST /api/gym/subscribe
 * Body: {
 *   walletAddress: string,
 *   nfcUid: string,
 *   subscriptionType: "dynamic" | "static",
 *   tier: "daily" | "weekly" | "monthly" | "yearly"
 * }
 *
 * Initiates a GNAP grant and creates a pending Subscription record.
 * The Subscription is activated when the GNAP callback fires.
 */
async function subscribe(req, res) {
  const { walletAddress, nfcUid, subscriptionType = "dynamic", tier = "daily" } = req.body;

  if (!walletAddress || !nfcUid) {
    return res.status(400).json({ error: "walletAddress and nfcUid are required" });
  }
  if (!["dynamic", "static"].includes(subscriptionType)) {
    return res.status(400).json({ error: "subscriptionType must be dynamic or static" });
  }
  if (!["daily", "weekly", "monthly", "yearly"].includes(tier)) {
    return res.status(400).json({ error: "tier must be daily, weekly, monthly, or yearly" });
  }

  try {
    // Upsert user
    let user = await User.findOne({ where: { nfcUid } });
    if (!user) {
      user = await User.create({ nfcUid, walletAddress });
    } else if (!user.walletAddress) {
      await user.update({ walletAddress });
    }

    // Determine base rate
    const baseRateCents =
      subscriptionType === "dynamic"
        ? billingService.GYM_DYNAMIC_BASE[tier]
        : billingService.GYM_STATIC_BASE[tier];

    // For static weekly+, add an interval limit to the GNAP grant so the
    // wallet provider enforces the per-period spending cap.
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

    // Create a pending subscription (isActive: false until callback)
    const today = new Date().toISOString().slice(0, 10);
    const sub = await Subscription.create({
      userId: user.id,
      serviceType: "gym",
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
          serviceType: "gym",
        },
      });
      interactRedirectUrl = grant.interactRedirectUrl;
    } catch (grantErr) {
      await sub.destroy();
      throw grantErr;
    }

    res.json({ interactRedirectUrl, subscriptionId: sub.id });
  } catch (err) {
    console.error("[gym/subscribe]", err);
    res.status(500).json({ error: err.message });
  }
}

// ── List Subscriptions ────────────────────────────────────────────────────────

/**
 * GET /api/gym/subscriptions/:uid
 */
async function listSubscriptions(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid is required" });

  try {
    const user = await User.findOne({ where: { nfcUid: uid } });
    if (!user) return res.json({ subscriptions: [] });

    const subscriptions = await Subscription.findAll({
      where: { userId: user.id, isActive: true },
      order: [["createdAt", "DESC"]],
    });

    res.json({ subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Pricing Info ──────────────────────────────────────────────────────────────

/**
 * GET /api/gym/pricing
 * Returns all rate constants so the frontend can render a pricing table
 * without hardcoding values.
 */
function getPricing(_req, res) {
  res.json({
    dynamic: billingService.GYM_DYNAMIC_BASE,
    static: billingService.GYM_STATIC_BASE,
    currency: "USD",
    assetScale: 2,
    peakHours: ["06:00–09:00", "17:00–20:00"],
    maxDurationDiscountMinutes: 120,
    maxDurationDiscountPercent: 50,
  });
}

// ── History ───────────────────────────────────────────────────────────────────

/**
 * GET /api/gym/history/:uid
 * Returns all DailySettlement records for a user across both gym and streaming.
 */
async function getHistory(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid is required" });

  try {
    const { DailySettlement } = require("../models");
    const user = await User.findOne({ where: { nfcUid: uid } });
    if (!user) return res.json({ settlements: [] });

    const settlements = await DailySettlement.findAll({
      where: { userId: user.id },
      order: [["settlementDate", "DESC"]],
      limit: 90,
    });

    res.json({ settlements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POS Incoming Payment ─────────────────────────────────────────────────────

/**
 * POS_PASSES maps the frontend durationKey to a fixed amount (in cents).
 * Amounts are expressed in ZAR-cents (100 = R1.00) so the QR and receipt
 * always show the right local currency for the demo.
 */
const POS_PASSES = {
  '30min':   { tier: 'daily',   amountCents: 1500,  label: '30 Min Pass' },
  '1hr':     { tier: 'daily',   amountCents: 3000,  label: '1 Hour Pass' },
  '2hr':     { tier: 'daily',   amountCents: 5000,  label: '2 Hour Pass' },
  'day':     { tier: 'daily',   amountCents: 6000,  label: 'Day Pass' },
  'weekly':  { tier: 'weekly',  amountCents: 14000, label: 'Weekly Pass' },
  'monthly': { tier: 'monthly', amountCents: 40000, label: 'Monthly Pass' },
  'yearly':  { tier: 'yearly',  amountCents: 80000, label: 'Yearly Pass' },
};

/**
 * POST /api/gym/pos/incoming-payment
 * Body: { durationKey: string }
 * Creates an Open Payments incoming payment on the merchant wallet and returns
 * the payment URL ready to be encoded into a QR code.
 */
async function createPOSPayment(req, res) {
  const { durationKey = '1hr' } = req.body;
  const logs = [];

  const log = (level, message, data) => {
    const entry = { timestamp: new Date().toISOString(), level, message, ...(data !== undefined && { data }) };
    logs.push(entry);
    console.log(`[POS][${level}]`, message, data ?? '');
  };

  const pass = POS_PASSES[durationKey];
  if (!pass) {
    return res.status(400).json({ error: `Unknown durationKey: ${durationKey}. Valid keys: ${Object.keys(POS_PASSES).join(', ')}` });
  }

  const currency = process.env.PAYMENT_CURRENCY ?? 'USD';

  try {
    log('INFO', `POST /incoming-payments — creating "${pass.label}"`, {
      durationKey,
      amountCents: pass.amountCents,
      currency,
    });

    const posPaymentService = require('../services/pos-payment');
    const result = await posPaymentService.createPOSIncomingPayment({
      amountCents: pass.amountCents,
      currency,
      description: `PavelGym — ${pass.label}`,
    });

    // The merchant wallet's real asset wins (it may differ from PAYMENT_CURRENCY).
    const displayCurrency = result.assetCode ?? currency;

    log('INFO', `Incoming payment created → ID: ${result.incomingPaymentId}`, {
      paymentUrl: result.paymentUrl,
      assetCode:  result.assetCode,
      expiresAt:  result.expiresAt,
    });

    // The QR encodes a mobile-friendly pay page on THIS server (not the raw
    // incoming-payment API URL) so a scanning phone gets a real "confirm & pay"
    // experience that redirects to the customer's Interledger wallet.
    const base = posBaseUrl(req);
    const payPageUrl =
      `${base}/api/gym/pos/pay-page` +
      `?ip=${encodeURIComponent(result.incomingPaymentId)}` +
      `&amount=${pass.amountCents}` +
      `&currency=${encodeURIComponent(displayCurrency)}` +
      `&label=${encodeURIComponent(pass.label)}`;

    log('INFO', 'QR ready — encodes customer pay page', { payPageUrl });
    log('INFO', 'Listening for settlement on the merchant wallet...');

    res.json({
      paymentUrl:        payPageUrl,
      incomingPaymentId: result.incomingPaymentId,
      amount:            pass.amountCents,
      currency:          displayCurrency,
      label:             pass.label,
      expiresAt:         result.expiresAt,
      logs,
    });
  } catch (err) {
    log('ERROR', `Failed to create incoming payment: ${err.message}`);
    console.error('[gym/pos/incoming-payment]', err);
    res.status(500).json({ error: err.message, logs });
  }
}

// ── POS Payment Status ────────────────────────────────────────────────────────

/**
 * GET /api/gym/pos/payment-status/:incomingPaymentId
 * The incomingPaymentId is the full URL (URI-encoded in the route param).
 * Returns { status: 'pending'|'completed', receivedAmount, incomingAmount }.
 */
async function getPOSPaymentStatus(req, res) {
  const rawId = req.params.incomingPaymentId;
  if (!rawId) {
    return res.status(400).json({ error: 'incomingPaymentId is required' });
  }

  try {
    const posPaymentService = require('../services/pos-payment');
    const result = await posPaymentService.getPOSPaymentStatus(decodeURIComponent(rawId));

    if (result.status === 'completed') {
      console.log('[POS] RECEIPT CONFIRMED', JSON.stringify(result, null, 2));
    }

    res.json(result);
  } catch (err) {
    console.error('[gym/pos/payment-status]', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POS Customer Pay Flow (interactive Open Payments) ─────────────────────────

/**
 * Resolve the public base URL the customer's phone must use to reach this
 * server. Prefer an explicit PUBLIC_BASE_URL (e.g. an ngrok URL); otherwise
 * auto-detect a LAN IPv4, skipping virtual/WSL adapters; finally fall back to
 * the request host.
 */
function posBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const skip = /(WSL|vEthernet|Loopback|Docker|VirtualBox|VMware|Hyper-V)/i;
  let ip = null;
  for (const name of Object.keys(ifaces)) {
    if (skip.test(name)) continue;
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) { ip = i.address; break; }
    }
    if (ip) break;
  }
  const port = process.env.BACKEND_PORT ?? 4001;
  return ip ? `http://${ip}:${port}` : `${req.protocol}://${req.get('host')}`;
}

const _payPageStyles = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f17;color:#e6edf3;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:420px;background:#111827;border:1px solid #1f2937;border-radius:16px;
    padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  .brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#60a5fa;margin-bottom:18px}
  .label{font-size:15px;color:#9ca3af}
  .amount{font-size:40px;font-weight:700;margin:6px 0 22px}
  label{display:block;font-size:13px;color:#9ca3af;margin:0 0 8px}
  input{width:100%;padding:14px 16px;border-radius:10px;border:1px solid #374151;background:#0b0f17;
    color:#e6edf3;font-size:15px;outline:none}
  input:focus{border-color:#60a5fa}
  button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:10px;background:#2563eb;
    color:#fff;font-size:16px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:progress}
  .hint{margin-top:14px;font-size:12px;color:#6b7280;line-height:1.5}
  .err{margin-top:14px;font-size:13px;color:#f87171;min-height:18px}
  .ok{text-align:center}
  .ok .tick{font-size:56px}
  .ok h1{font-size:22px;margin:10px 0 6px}
  .ok p{color:#9ca3af;font-size:14px}
`;

/**
 * GET /api/gym/pos/pay-page
 * The HTML page a customer's phone opens after scanning the QR. Collects the
 * customer's wallet address and kicks off the interactive grant.
 */
function getPOSPayPage(req, res) {
  const ip = String(req.query.ip ?? '');
  const amount = Number(req.query.amount ?? 0);
  const currency = String(req.query.currency ?? 'USD');
  const label = String(req.query.label ?? 'Gym Pass');
  const amountDisplay = (amount / 100).toFixed(2);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay — PavelGym</title><style>${_payPageStyles}</style></head>
<body>
  <div class="card">
    <div class="brand">PavelGym · POS</div>
    <div class="label">${esc(label)}</div>
    <div class="amount">${esc(currency)} ${amountDisplay}</div>
    <form id="f">
      <label for="w">Your Interledger wallet address</label>
      <input id="w" name="w" autocomplete="off" autocapitalize="none" spellcheck="false"
        placeholder="https://ilp.interledger-test.dev/you" required>
      <button id="b" type="submit">Continue to wallet →</button>
      <div class="err" id="e"></div>
      <div class="hint">You'll be redirected to your wallet to confirm the payment.
        Use a testnet wallet from wallet.interledger-test.dev.</div>
    </form>
  </div>
  <script>
    var ip = ${JSON.stringify(ip)};
    var f = document.getElementById('f'), b = document.getElementById('b'), e = document.getElementById('e');
    f.addEventListener('submit', async function(ev){
      ev.preventDefault();
      e.textContent = ''; b.disabled = true; b.textContent = 'Preparing…';
      try {
        var r = await fetch('/api/gym/pos/pay', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ incomingPaymentId: ip, walletAddress: document.getElementById('w').value.trim() })
        });
        var d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not start payment');
        window.location.href = d.interactUrl;
      } catch (err) {
        e.textContent = err.message; b.disabled = false; b.textContent = 'Continue to wallet →';
      }
    });
  </script>
</body></html>`);
}

/**
 * POST /api/gym/pos/pay
 * Body: { incomingPaymentId, walletAddress }
 * Creates the quote + interactive grant and returns the wallet consent URL.
 */
async function startPOSPayment(req, res) {
  const { incomingPaymentId, walletAddress } = req.body ?? {};
  if (!incomingPaymentId || !walletAddress) {
    return res.status(400).json({ error: 'incomingPaymentId and walletAddress are required' });
  }
  // The receiver MUST be a full incoming-payment URL (…/incoming-payments/…).
  // If the QR is stale or the value got truncated, fail early with the actual
  // value so it's obvious what went wrong instead of a generic SDK 400.
  if (!/^https?:\/\/.+\/incoming-payments\/.+$/.test(incomingPaymentId)) {
    console.error('[gym/pos/pay] bad receiver:', JSON.stringify(incomingPaymentId));
    return res.status(400).json({
      error: `Invalid payment reference (expected a full incoming-payment URL). ` +
             `Got: ${incomingPaymentId}. Re-generate the QR from the gym dashboard and scan it again.`,
    });
  }
  console.log('[gym/pos/pay] receiver:', incomingPaymentId, '| customer:', walletAddress);
  try {
    const posPaymentService = require('../services/pos-payment');
    const base = posBaseUrl(req);
    const { interactUrl } = await posPaymentService.createPaymentConsent({
      incomingPaymentId,
      customerWalletAddress: walletAddress,
      buildCallbackUrl: (payId) =>
        `${base}/api/gym/pos/pay/callback?payId=${encodeURIComponent(payId)}`,
    });
    res.json({ interactUrl });
  } catch (err) {
    // OpenPaymentsClientError hides the cause in `.description`/`.status`;
    // surface it so the pay page shows why the testnet rejected the request.
    const detail = [err.message, err.description, err.status ? `(HTTP ${err.status})` : null]
      .filter(Boolean).join(' — ');
    console.error('[gym/pos/pay]', detail, err.validationErrors ?? '');
    res.status(500).json({ error: detail });
  }
}

function _resultPage(ok, title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Paid' : 'Payment failed'} — PavelGym</title><style>${_payPageStyles}</style></head>
<body><div class="card ok">
  <div class="tick">${ok ? '✅' : '⚠️'}</div>
  <h1>${title}</h1><p>${message}</p>
</div></body></html>`;
}

/**
 * GET /api/gym/pos/pay/callback
 * The wallet redirects the customer here after consent. Continue the grant and
 * create the outgoing payment, then show a result page. The POS terminal picks
 * up the settlement independently via its status polling.
 */
async function posPaymentCallback(req, res) {
  const { payId, interact_ref, result } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (result === 'grant_rejected' || !interact_ref) {
    return res.status(200).send(_resultPage(false, 'Payment cancelled',
      'You declined the authorisation at your wallet. You can scan again to retry.'));
  }
  try {
    const posPaymentService = require('../services/pos-payment');
    await posPaymentService.finalizePaymentConsent({ payId: String(payId), interactRef: String(interact_ref) });
    res.status(200).send(_resultPage(true, 'Payment authorised',
      'Your payment is on its way. You can return to the turnstile — it will unlock automatically.'));
  } catch (err) {
    console.error('[gym/pos/pay/callback]', err);
    res.status(200).send(_resultPage(false, 'Payment failed', err.message));
  }
}

/**
 * GET /api/gym/sessions/:uid
 * Returns all GymSessions for the given NFC UID for today's date.
 * Used by the History page to show live activity before the midnight settlement cron runs.
 */
async function getTodaySessions(req, res) {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'uid is required' });
  try {
    const { User, GymSession } = require('../models');
    const user = await User.findOne({ where: { nfcUid: uid } });
    if (!user) return res.json({ sessions: [], user: null });
    const today = new Date().toISOString().slice(0, 10);
    const sessions = await GymSession.findAll({
      where: { userId: user.id, date: today },
      order: [['tapInAt', 'DESC']],
    });
    res.json({ sessions, user: { nfcUid: user.nfcUid, name: user.name ?? null, walletAddress: user.walletAddress } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── All Gym Visits (persistent history) ───────────────────────────────────────
/**
 * GET /api/gym/visits?limit=50&offset=0
 * Returns all GymSessions across all dates, most recent first, with member name.
 */
async function getAllVisits(req, res) {
  try {
    const { GymSession, User } = require('../models');
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const sessions = await GymSession.findAll({
      include: [{ model: User, attributes: ['nfcUid', 'name', 'walletAddress'] }],
      order: [['tapInAt', 'DESC']],
      limit,
      offset,
    });
    const total = await GymSession.count();
    res.json({ sessions, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── PavelFlow history (completed sessions) ─────────────────────────────────────
/**
 * GET /api/gym/flow/history?limit=50&offset=0
 * Returns completed / cancelled FlowSessions, most recent first.
 */
async function getFlowHistory(req, res) {
  try {
    const { FlowSession } = require('../models');
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const { Op } = require('sequelize');
    const sessions = await FlowSession.findAll({
      where: { status: { [Op.in]: ['completed', 'cancelled'] } },
      order: [['tapInAt', 'DESC']],
      limit,
      offset,
    });
    const total = await FlowSession.count({ where: { status: { [Op.in]: ['completed', 'cancelled'] } } });
    res.json({ sessions, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Save member name ───────────────────────────────────────────────────────────
/**
 * POST /api/gym/members/name
 * Body: { uid, name }  — saves / updates the display name for an NFC UID.
 */
async function saveMemberName(req, res) {
  const { uid, name } = req.body ?? {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ error: 'uid required' });
  if (typeof name !== 'string')         return res.status(400).json({ error: 'name required' });
  try {
    const [user, created] = await User.findOrCreate({
      where: { nfcUid: uid },
      defaults: { nfcUid: uid, name: name.trim() },
    });
    if (!created) await user.update({ name: name.trim() });
    res.json({ ok: true, user: { nfcUid: user.nfcUid, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Save PavelFlow session name ────────────────────────────────────────────────
/**
 * POST /api/gym/flow/name
 * Body: { sessionId, name }  — saves a display name on a FlowSession row.
 */
async function saveFlowName(req, res) {
  const { sessionId, name } = req.body ?? {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try {    const { FlowSession } = require('../models');    const session = await FlowSession.findByPk(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await session.update({ name: name.trim() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── PavelFlow exit — Open Payments step 1: create consent ────────────────────
/**
 * POST /api/gym/flow/init-exit-payment
 * Body: { exitToken }
 * Calculates the amount owed (with daily cap), creates a merchant incoming
 * payment, then creates an interactive outgoing-payment consent on the
 * customer's wallet. Returns { interactUrl, totalCents } to redirect the phone.
 */
async function initFlowExitPayment(req, res) {
  const { exitToken } = req.body ?? {};
  if (!exitToken) return res.status(400).json({ error: 'exitToken is required' });
  try {
    const { FlowSession } = require('../models');
    const { Op } = require('sequelize');
    const session = await FlowSession.findOne({ where: { exitToken: String(exitToken) } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'streaming') {
      return res.status(409).json({ error: 'Session already ended', totalCents: session.totalCents });
    }
    // Wallet must be confirmed before we can charge it
    if (!session.walletAddress || session.walletAddress === 'pending') {
      return res.status(400).json({ error: 'Wallet address not yet confirmed for this session' });
    }

    // Calculate amount with per-day cap
    const now = new Date();
    const elapsedMs      = now.getTime() - new Date(session.tapInAt).getTime();
    const elapsedMinutes = Math.ceil(elapsedMs / 60000);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const alreadyToday = (await FlowSession.sum('totalCents', {
      where: {
        walletAddress: session.walletAddress,
        status: 'completed',
        tapOutAt: { [Op.gte]: startOfDay },
        id: { [Op.ne]: session.id },
      },
    })) ?? 0;
    const remainingCap = Math.max(0, FLOW_MAX_DAILY_CENTS - alreadyToday);
    const totalCents   = Math.min(elapsedMinutes * session.ratePerMinuteCents, remainingCap);

    // Already hit the daily cap — close without charging
    if (totalCents === 0) {
      await session.update({ tapOutAt: now, totalCents: 0, status: 'completed' });
      return res.json({ ok: true, totalCents: 0, alreadyCapped: true });
    }

    const currency = process.env.PAYMENT_CURRENCY ?? 'USD';
    const posPaymentService = require('../services/pos-payment');

    // Step 1: incoming payment on merchant wallet
    const ipResult = await posPaymentService.createPOSIncomingPayment({
      amountCents: totalCents,
      currency,
      description: `PavelFlow — ${elapsedMinutes} min at PavelGym`,
    });

    // Step 2: quote + interactive consent on customer wallet
    const base = posBaseUrl(req);
    const { payId, interactUrl } = await posPaymentService.createPaymentConsent({
      incomingPaymentId:      ipResult.incomingPaymentId,
      customerWalletAddress:  session.walletAddress,
      buildCallbackUrl: (pid) =>
        `${base}/api/gym/flow/exit-callback` +
        `?payId=${encodeURIComponent(pid)}` +
        `&exitToken=${encodeURIComponent(String(exitToken))}` +
        `&totalCents=${totalCents}`,
    });

    res.json({ ok: true, payId, interactUrl, totalCents, elapsedMinutes, currency });
  } catch (err) {
    console.error('[gym/flow/init-exit-payment]', err);
    res.status(500).json({ error: err.message });
  }
}

// ── PavelFlow exit — Open Payments step 2: wallet callback ───────────────────
/**
 * GET /api/gym/flow/exit-callback
 * The customer's wallet redirects here after they approve (or decline) payment.
 * Finalises the outgoing payment and marks the FlowSession completed.
 */
async function flowExitCallback(req, res) {
  const { payId, exitToken, totalCents, interact_ref, result } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (result === 'grant_rejected' || !interact_ref) {
    return res.status(200).send(_resultPage(false, 'Payment declined',
      'You declined the payment at your wallet. Scan the exit QR again to try once more.'));
  }
  try {
    const { FlowSession } = require('../models');
    const posPaymentService = require('../services/pos-payment');

    // Finalise the outgoing payment (money moves here)
    await posPaymentService.finalizePaymentConsent({
      payId: String(payId),
      interactRef: String(interact_ref),
    });

    // Mark session completed
    const session = await FlowSession.findOne({ where: { exitToken: String(exitToken) } });
    if (session && session.status === 'streaming') {
      await session.update({ tapOutAt: new Date(), totalCents: Number(totalCents), status: 'completed' });
    }

    const charged = (Number(totalCents) / 100).toFixed(2);
    res.status(200).send(_resultPage(true, 'Stream settled!',
      `$${charged} charged successfully. Thanks for training at PavelGym! 🏋️`));
  } catch (err) {
    console.error('[gym/flow/exit-callback]', err);
    res.status(200).send(_resultPage(false, 'Payment failed', err.message));
  }
}

module.exports = { tapIn, tapOut, getSession, subscribe, listSubscriptions, getPricing, getHistory, getTodaySessions, createPOSPayment, getPOSPaymentStatus, getPOSPayPage, startPOSPayment, posPaymentCallback, checkFlowBalance, startFlow, listActiveFlows, getFlowEntryPage, confirmEntry, getFlowExitPage, exitFlow, initFlowExitPayment, flowExitCallback, getAllVisits, getFlowHistory, saveMemberName, saveFlowName };

// ── PavelFlow — web-monetization-style streaming gym sessions ─────────────────

const FLOW_RATE_PER_MINUTE_CENTS = 50;   // $0.50 / min
const FLOW_MAX_DAILY_CENTS       = 6000; // $60.00 cap — same as Day Pass

/**
 * POST /api/gym/flow/check-balance
 * Body: { walletAddress }
 * Resolves the customer's wallet address via Open Payments to confirm it exists.
 * (A true balance query requires a customer-issued grant, which we can't do pre-entry.
 *  The wallet address resolution at least verifies the wallet is reachable and tells
 *  us its asset currency — the wallet's own app will block the payment if funds are low.)
 */
async function checkFlowBalance(req, res) {
  const { walletAddress } = req.body ?? {};
  if (!walletAddress || typeof walletAddress !== 'string') {
    return res.status(400).json({ ok: false, reason: 'walletAddress is required' });
  }
  try {
    const { normaliseWalletAddress } = require('../services/pos-open-payments');
    const { getClient } = require('../services/open-payments');
    const url = normaliseWalletAddress(walletAddress.trim());
    const client = await getClient();
    const wallet = await client.walletAddress.get({ url });
    res.json({
      ok: true,
      walletInfo: { id: wallet.id, assetCode: wallet.assetCode, assetScale: wallet.assetScale },
      maxChargeCents: FLOW_MAX_DAILY_CENTS,
      ratePerMinuteCents: FLOW_RATE_PER_MINUTE_CENTS,
    });
  } catch (err) {
    res.json({ ok: false, reason: `Wallet not found or unreachable: ${err.message}` });
  }
}

/**
 * POST /api/gym/flow/start
 * No body required — wallet is collected on the customer's phone via the entry-page QR.
 * Creates a FlowSession immediately and returns the entry QR URL.
 */
async function startFlow(req, res) {
  try {
    const { FlowSession } = require('../models');
    const crypto = require('crypto');
    const entryToken = crypto.randomBytes(32).toString('hex');
    const exitToken  = crypto.randomBytes(32).toString('hex');
    const session = await FlowSession.create({
      walletAddress: 'pending', // filled in by the customer on their phone
      entryToken,
      exitToken,
      tapInAt: new Date(),
      status: 'streaming',
      ratePerMinuteCents: FLOW_RATE_PER_MINUTE_CENTS,
      currency: process.env.PAYMENT_CURRENCY ?? 'USD',
    });
    const base = posBaseUrl(req);
    res.json({
      sessionId: session.id,
      entryQrUrl: `${base}/api/gym/flow/entry-page?token=${entryToken}`,
      tapInAt: session.tapInAt,
      ratePerMinuteCents: session.ratePerMinuteCents,
      maxDailyCents: FLOW_MAX_DAILY_CENTS,
    });
  } catch (err) {
    console.error('[gym/flow/start]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/gym/flow/active
 * Returns all currently-streaming FlowSessions with live running totals.
 */
async function listActiveFlows(req, res) {
  try {
    const { FlowSession } = require('../models');
    const sessions = await FlowSession.findAll({
      where: { status: 'streaming' },
      order: [['tapInAt', 'ASC']],
    });
    const base = posBaseUrl(req);
    const now  = Date.now();
    res.json({
      sessions: sessions.map(s => {
        const elapsedMs      = now - new Date(s.tapInAt).getTime();
        const elapsedMinutes = Math.ceil(elapsedMs / 60000);
        const runningCents   = Math.min(elapsedMinutes * s.ratePerMinuteCents, FLOW_MAX_DAILY_CENTS);
        return {
          id: s.id,
          walletAddress: s.walletAddress,
          tapInAt: s.tapInAt,
          elapsedMinutes,
          runningCents,
          currency: s.currency,
          ratePerMinuteCents: s.ratePerMinuteCents,
          exitQrUrl: `${base}/api/gym/flow/exit-page?token=${s.exitToken}`,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/gym/flow/entry-page?token=...
 * Mobile HTML page shown after the customer scans the entry QR.
 */
async function getFlowEntryPage(req, res) {
  const { token } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!token) return res.status(400).send(_resultPage(false, 'Invalid QR', 'Missing session token.'));
  try {
    const { FlowSession } = require('../models');
    const session = await FlowSession.findOne({ where: { entryToken: String(token) } });
    if (!session) return res.status(404).send(_resultPage(false, 'Session not found', 'This QR has already been used or is invalid.'));
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const tokenJson = JSON.stringify(String(token));
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PavelFlow — Entry</title><style>${_payPageStyles}</style></head>
<body><div class="card">
  <div class="brand">PavelFlow · Web Monetization</div>
  <div class="label">Rate</div>
  <div class="amount" style="font-size:24px">$${(FLOW_RATE_PER_MINUTE_CENTS/100).toFixed(2)}<span style="font-size:13px;color:#9ca3af">/min &nbsp;·&nbsp; max $${(FLOW_MAX_DAILY_CENTS/100).toFixed(2)}/day</span></div>
  <form id="f">
    <label for="w">Your Interledger wallet address</label>
    <input id="w" autocomplete="off" autocapitalize="none" spellcheck="false"
      placeholder="https://ilp.interledger-test.dev/you" required>
    <div id="chk" style="margin-top:10px;font-size:12px;color:#6b7280;min-height:18px"></div>
    <button id="btn" type="submit">✓ Start streaming</button>
    <div class="err" id="e"></div>
    <div class="hint">Micropayments stream from your wallet while you train. Scan the exit QR at the front desk when done.</div>
  </form>
  <div id="msg"></div>
</div>
<script>
  var f=document.getElementById('f'),btn=document.getElementById('btn'),e=document.getElementById('e'),chk=document.getElementById('chk'),w=document.getElementById('w');
  w.addEventListener('blur',async function(){
    var v=w.value.trim(); if(!v) return;
    chk.textContent='Checking wallet...'; chk.style.color='#6b7280';
    try{
      var r=await fetch('/api/gym/flow/check-balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletAddress:v})});
      var d=await r.json();
      if(d.ok){chk.textContent='✓ Wallet valid ('+d.walletInfo.assetCode+')';chk.style.color='#4ade80';}
      else{chk.textContent='⚠ '+d.reason;chk.style.color='#f87171';}
    }catch(ex){chk.textContent='';}
  });
  f.addEventListener('submit',async function(ev){
    ev.preventDefault();
    var walletAddress=w.value.trim();
    e.textContent=''; btn.disabled=true; btn.textContent='Checking in...';
    try{
      var r=await fetch('/api/gym/flow/confirm-entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entryToken:${tokenJson},walletAddress:walletAddress})});
      var d=await r.json();
      if(!r.ok) throw new Error(d.error||'Failed');
      f.style.display='none';
      document.getElementById('msg').innerHTML='<div style="text-align:center;padding-top:16px"><div style="font-size:56px">&#x2705;</div><h1 style="font-size:22px;margin:10px 0 6px;color:#4ade80">You are in!</h1><p style="color:#9ca3af;font-size:14px">Session started &#8212; enjoy your workout!<br>Scan the exit QR at the front desk when done.</p></div>';
    }catch(ex){e.textContent=ex.message;btn.disabled=false;btn.textContent='✓ Start streaming';}
  });
</script></body></html>`);
  } catch (err) {
    res.status(500).send(_resultPage(false, 'Error', err.message));
  }
}

/**
 * POST /api/gym/flow/confirm-entry
 * Body: { entryToken, walletAddress }
 * Saves the customer's wallet address and confirms the entry.
 */
async function confirmEntry(req, res) {
  const { entryToken, walletAddress } = req.body ?? {};
  if (!entryToken) return res.status(400).json({ error: 'entryToken is required' });
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  try {
    const { FlowSession } = require('../models');
    const session = await FlowSession.findOne({ where: { entryToken: String(entryToken), status: 'streaming' } });
    if (!session) return res.status(404).json({ error: 'Session not found or already ended' });
    await session.update({ walletAddress: walletAddress.trim() });
    res.json({ ok: true, sessionId: session.id, tapInAt: session.tapInAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/gym/flow/exit-page?token=...
 * Mobile HTML page shown after the customer scans the exit QR.
 * Shows live elapsed time + running total, and a Confirm Exit button.
 */
async function getFlowExitPage(req, res) {
  const { token } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!token) return res.status(400).send(_resultPage(false, 'Invalid QR', 'Missing session token.'));
  try {
    const { FlowSession } = require('../models');
    const session = await FlowSession.findOne({ where: { exitToken: String(token) } });
    if (!session) return res.status(404).send(_resultPage(false, 'Session not found', 'This exit QR is invalid.'));
    if (session.status !== 'streaming') {
      return res.send(_resultPage(true, 'Already checked out', `Total charged: $${(session.totalCents/100).toFixed(2)}. Thanks for training at PavelGym!`));
    }
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const shortWallet = session.walletAddress.replace(/^https?:\/\//, '').slice(0, 42);
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PavelFlow — Exit</title><style>${_payPageStyles}</style></head>
<body><div class="card">
  <div class="brand">PavelFlow · Check-out</div>
  <div class="label">Wallet</div>
  <div style="font-size:13px;color:#9ca3af;margin-bottom:16px;word-break:break-all">${esc(shortWallet)}</div>
  <div class="label">Time trained</div>
  <div class="amount" style="font-size:28px" id="elapsed">—</div>
  <div class="label">Amount to settle</div>
  <div class="amount" id="total">—</div>
  <div id="msg"></div>
  <button id="btn" onclick="pay_and_exit()">Pay & Exit — authorise in your wallet</button>
  <div class="hint">You'll be redirected to your Interledger wallet to approve the exact amount.
    No more will be taken after you confirm.</div>
</div>
<script>
  var tapInAt=new Date(${JSON.stringify(new Date(session.tapInAt).toISOString())});
  var rate=${FLOW_RATE_PER_MINUTE_CENTS}, maxCents=${FLOW_MAX_DAILY_CENTS};
  function update(){
    var ms=Date.now()-tapInAt.getTime();
    var m=Math.ceil(ms/60000), s=Math.floor((ms%60000)/1000);
    document.getElementById('elapsed').textContent=m+'m '+String(s).padStart(2,'0')+'s';
    var c=Math.min(m*rate,maxCents);
    document.getElementById('total').textContent='$'+(c/100).toFixed(2);
  }
  update(); setInterval(update,1000);
  async function pay_and_exit(){
    var btn=document.getElementById('btn'), msg=document.getElementById('msg');
    btn.disabled=true; btn.textContent='Preparing payment…';
    try {
      var r=await fetch('/api/gym/flow/init-exit-payment',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({exitToken:${JSON.stringify(String(token))}})
      });
      var d=await r.json();
      if(!r.ok) throw new Error(d.error||'Failed to initiate payment');
      if(d.alreadyCapped){
        btn.textContent='✅ Done — daily cap reached!';
        msg.innerHTML='<p style="color:#4ade80;margin-top:12px;font-size:15px">You already reached the $'+(${FLOW_MAX_DAILY_CENTS}/100).toFixed(2)+' daily max earlier today. No charge for this session.</p>';
        return;
      }
      // Redirect to wallet consent page
      window.location.href = d.interactUrl;
    } catch(e){
      btn.disabled=false; btn.textContent='Pay & Exit — authorise in your wallet';
      msg.innerHTML='<p style="color:#f87171;margin-top:8px">'+e.message+'</p>';
    }
  }
</script></body></html>`);
  } catch (err) {
    res.status(500).send(_resultPage(false, 'Error', err.message));
  }
}

/**
 * POST /api/gym/flow/exit
 * Body: { exitToken }
 * Ends the streaming session and calculates the final total.
 */
async function exitFlow(req, res) {
  const { exitToken } = req.body ?? {};
  if (!exitToken) return res.status(400).json({ error: 'exitToken is required' });
  try {
    const { FlowSession } = require('../models');
    const session = await FlowSession.findOne({ where: { exitToken: String(exitToken) } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'streaming') {
      return res.status(409).json({ error: 'Session already ended', totalCents: session.totalCents });
    }
    const now = new Date();
    const elapsedMs      = now.getTime() - new Date(session.tapInAt).getTime();
    const elapsedMinutes = Math.ceil(elapsedMs / 60000);

    // Per-day cap: subtract what this wallet already paid today
    const { Op } = require('sequelize');
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const alreadyToday = (await FlowSession.sum('totalCents', {
      where: {
        walletAddress: session.walletAddress,
        status: 'completed',
        tapOutAt: { [Op.gte]: startOfDay },
        id: { [Op.ne]: session.id },
      },
    })) ?? 0;
    const remainingCap = Math.max(0, FLOW_MAX_DAILY_CENTS - alreadyToday);
    const totalCents   = Math.min(elapsedMinutes * session.ratePerMinuteCents, remainingCap);

    await session.update({ tapOutAt: now, totalCents, status: 'completed' });
    res.json({
      ok: true,
      sessionId: session.id,
      walletAddress: session.walletAddress,
      tapInAt: session.tapInAt,
      tapOutAt: now,
      elapsedMinutes,
      totalCents,
      currency: session.currency,
    });
  } catch (err) {
    console.error('[gym/flow/exit]', err);
    res.status(500).json({ error: err.message });
  }
}
