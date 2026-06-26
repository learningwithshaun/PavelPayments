/**
 * billing.js
 *
 * Multi-mode billing engine for gym and streaming services.
 *
 * GYM DYNAMIC:  base rate per tier, reduced by visit duration and time-of-day.
 * GYM STATIC:   flat fee per tier, charged regardless of visit duration.
 * STREAMING:    per-minute rate multiplied by total minutes watched.
 *
 * All amounts are in minor currency units (cents, assetScale 2).
 */

"use strict";

const DEFAULT_CURRENCY = "USD";
const ASSET_SCALE = 2;

// ── Gym base rates (cents per day-equivalent) ─────────────────────────────────
const GYM_DYNAMIC_BASE = {
  daily: 600,    // $6.00 / visit
  weekly: 500,   // $5.00 / day equivalent
  monthly: 400,  // $4.00 / day equivalent
  yearly: 300,   // $3.00 / day equivalent
};

const GYM_STATIC_BASE = {
  daily: 600,      // $6.00 / day
  weekly: 2800,    // $28.00 / week  (~$4/day)
  monthly: 8000,   // $80.00 / month (~$2.67/day)
  yearly: 80000,   // $800.00 / year (~$2.19/day)
};

// Peak hours: 06:00–09:00 and 17:00–20:00 local time
const PEAK_RANGES = [
  { start: 6, end: 9 },
  { start: 17, end: 20 },
];

// Streaming per-minute rates in cents
const STREAMING_RATE_PER_MINUTE = {
  daily: 5,    // $0.05 / min
  weekly: 4,   // $0.04 / min
  monthly: 3,  // $0.03 / min
  yearly: 2,   // $0.02 / min
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the given hour (0-23) falls within a peak window.
 * @param {number} hour
 */
function isPeakHour(hour) {
  return PEAK_RANGES.some((r) => hour >= r.start && hour < r.end);
}

/**
 * Determines peak minute count from an array of GymSession records.
 * A session minute counts as peak if its start hour is a peak hour.
 *
 * @param {Array<{ tapInAt: Date, minutesAccumulated: number }>} sessions
 * @returns {number}
 */
function computePeakMinutes(sessions) {
  let peak = 0;
  for (const s of sessions) {
    const startHour = new Date(s.tapInAt).getHours();
    if (isPeakHour(startHour)) {
      peak += s.minutesAccumulated ?? 0;
    }
  }
  return peak;
}

// ── Gym Dynamic ───────────────────────────────────────────────────────────────

/**
 * Calculate a dynamic gym charge based on time spent and tier.
 *
 * Duration discount: linear up to 50% off between 0–120 minutes.
 * Peak surcharge:    +50¢ when >50% of minutes are peak; -30¢ otherwise.
 *
 * @param {{ tier: string, totalMinutes: number, peakMinutes: number, currency?: string }} opts
 * @returns {{ amount: number, currency: string, assetScale: number, breakdown: object }}
 */
function calculateGymDynamicCharge({ tier, totalMinutes, peakMinutes, currency = DEFAULT_CURRENCY }) {
  const base = GYM_DYNAMIC_BASE[tier] ?? GYM_DYNAMIC_BASE.daily;

  // Duration discount — max 50% at 120+ minutes, linear between 0–120 min
  const discountFraction = Math.min(totalMinutes, 120) / 120;
  const durationDiscount = Math.round(base * 0.5 * discountFraction);

  // Peak adjustment
  const peakRatio = totalMinutes > 0 ? peakMinutes / totalMinutes : 0;
  const peakAdjustment = peakRatio > 0.5 ? 50 : -30;

  const amount = Math.max(0, base - durationDiscount + peakAdjustment);

  return {
    amount,
    currency,
    assetScale: ASSET_SCALE,
    breakdown: { base, durationDiscount, peakAdjustment },
  };
}

// ── Gym Static ────────────────────────────────────────────────────────────────

/**
 * Calculate a flat gym charge for the given tier.
 * No usage-based discounts — same amount every billing cycle.
 *
 * @param {{ tier: string, currency?: string }} opts
 * @returns {{ amount: number, currency: string, assetScale: number, breakdown: object }}
 */
function calculateGymStaticCharge({ tier, currency = DEFAULT_CURRENCY }) {
  const amount = GYM_STATIC_BASE[tier] ?? GYM_STATIC_BASE.daily;

  return {
    amount,
    currency,
    assetScale: ASSET_SCALE,
    breakdown: { base: amount, durationDiscount: 0, peakAdjustment: 0 },
  };
}

// ── Streaming ─────────────────────────────────────────────────────────────────

/**
 * Calculate a streaming charge based on minutes watched.
 *
 * @param {{ tier: string, totalMinutes: number, currency?: string }} opts
 * @returns {{ amount: number, currency: string, assetScale: number, breakdown: object }}
 */
function calculateStreamingCharge({ tier, totalMinutes, currency = DEFAULT_CURRENCY }) {
  const ratePerMinute = STREAMING_RATE_PER_MINUTE[tier] ?? STREAMING_RATE_PER_MINUTE.daily;
  const amount = Math.max(0, totalMinutes * ratePerMinute);

  return {
    amount,
    currency,
    assetScale: ASSET_SCALE,
    breakdown: { ratePerMinute, totalMinutes },
  };
}

// ── Streaming (per-title upfront + refund) ────────────────────────────────────

/**
 * Calculate the charge for a single piece of content under the
 * "pay upfront, refund the unwatched portion" model.
 *
 * The user is charged `priceCents` upfront when they press play. The amount
 * they actually owe is `priceCents × watchedFraction`; the remainder is
 * refunded back to their wallet at settlement.
 *
 * Live content has no finite duration, so it is charged flat (no refund).
 *
 * @param {{ priceCents: number, watchedFraction: number, contentType?: string }} opts
 * @returns {{ priceCents: number, upfrontCents: number, actualChargeCents: number,
 *             refundCents: number, watchedFraction: number, assetScale: number }}
 */
function calculateMovieCharge({ priceCents, watchedFraction, contentType = "movie" }) {
  const price = Math.max(0, Math.round(priceCents ?? 0));

  if (contentType === "live") {
    return {
      priceCents: price,
      upfrontCents: price,
      actualChargeCents: price,
      refundCents: 0,
      watchedFraction: 1,
      assetScale: ASSET_SCALE,
    };
  }

  const fraction = Math.min(Math.max(watchedFraction ?? 0, 0), 1);
  const actualChargeCents = Math.round(price * fraction);
  const refundCents = Math.max(0, price - actualChargeCents);

  return {
    priceCents: price,
    upfrontCents: price,
    actualChargeCents,
    refundCents,
    watchedFraction: fraction,
    assetScale: ASSET_SCALE,
  };
}

// ── Legacy compat ─────────────────────────────────────────────────────────────
// Kept for the existing /api/trigger-payment NFC route.

const { User } = require("../models");
const DEFAULT_CHARGE_MINOR = 100;

async function calculateCharge({ uid, terminalId }) {
  const user = await User.findOne({ where: { nfcUid: uid } });
  if (!user) {
    return { amount: DEFAULT_CHARGE_MINOR, currency: DEFAULT_CURRENCY, assetScale: ASSET_SCALE, description: `Entry at terminal ${terminalId}` };
  }
  const amount = user.isPremium ? Math.round(DEFAULT_CHARGE_MINOR * 0.8) : DEFAULT_CHARGE_MINOR;
  return { amount, currency: user.preferredCurrency ?? DEFAULT_CURRENCY, assetScale: ASSET_SCALE, description: `Entry at terminal ${terminalId} — user ${user.id}` };
}

module.exports = {
  calculateCharge,
  calculateGymDynamicCharge,
  calculateGymStaticCharge,
  calculateStreamingCharge,
  calculateMovieCharge,
  computePeakMinutes,
  GYM_DYNAMIC_BASE,
  GYM_STATIC_BASE,
  STREAMING_RATE_PER_MINUTE,
};
