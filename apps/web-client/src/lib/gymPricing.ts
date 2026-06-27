"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Gym pricing helper — mirrors apps/core-backend/src/services/billing.js so the
// front desk can show a faithful, LIVE estimate of the dynamic charge.
//
// Model (both modes):
//   • The customer pays an UPFRONT amount at the till (no subscription needed).
//   • The real settled charge is DYNAMIC: it goes DOWN the longer they train.
//   • Peak hours shrink that reduction — you save less when the gym is busy.
//   • The difference is settled at the end of the business day.
//
// Pay as you go  → upfront per-visit fee, reduced by today's minutes.
// Membership     → upfront subscription, then a daily charge that reduces per day.
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = "payg" | "member";
export type Tier = "day" | "stream" | "weekly" | "monthly" | "yearly";

export interface Pass {
  key: Tier;
  label: string;
  /** Amount charged upfront at the till, in cents (matches backend POS_PASSES). 0 for streaming passes. */
  upfrontCents: number;
  note: string;
  icon: string;
  /** Billing days the upfront covers — used to derive the daily base for members. */
  days: number;
  /** True for web-monetization style passes — no fixed amount, streams until tap-out. */
  streaming?: boolean;
}

export const PAY_AS_YOU_GO: Pass[] = [
  { key: "day",    label: "Day Pass",   upfrontCents: 6000, note: "All-day access — paid upfront", icon: "☀️", days: 1 },
  { key: "stream", label: "PavelFlow",  upfrontCents: 0,    note: "Streams until you tap out",    icon: "〰️", days: 1, streaming: true },
];

export const MEMBERSHIPS: Pass[] = [
  { key: "weekly",  label: "Weekly",  upfrontCents: 14000, note: "7 days",   icon: "📅", days: 7 },
  { key: "monthly", label: "Monthly", upfrontCents: 40000, note: "30 days",  icon: "⭐", days: 30 },
  { key: "yearly",  label: "Yearly",  upfrontCents: 80000, note: "Save 30%", icon: "🏆", days: 365 },
];

/** Peak windows (local time), mirroring billing.js: 06:00–09:00 and 17:00–20:00. */
export const PEAK_RANGES = [
  { start: 6, end: 9 },
  { start: 17, end: 20 },
];

export function isPeakNow(date = new Date()): boolean {
  const h = date.getHours();
  return PEAK_RANGES.some((r) => h >= r.start && h < r.end);
}

/** Max reduction caps — peak hours roughly halve the achievable discount. */
const MAX_DISCOUNT_OFFPEAK = 0.5; // up to 50% off
const MAX_DISCOUNT_PEAK = 0.25; // up to 25% off when busy
const FULL_DISCOUNT_AT_MIN = 120; // discount maxes out at 2 hours

/**
 * The "base" the dynamic discount is applied to:
 *   • Pay as you go → the upfront visit fee.
 *   • Membership    → the per-day slice of the subscription (upfront ÷ days).
 */
export function dailyBaseCents(pass: Pass, mode: Mode): number {
  if (mode === "payg") return pass.upfrontCents;
  return Math.round(pass.upfrontCents / pass.days);
}

export interface Estimate {
  baseCents: number;
  discountCents: number;
  finalCents: number;
  savedCents: number;
  /** Fraction 0–1 of the base that was discounted (for the progress bar). */
  discountFraction: number;
  /** Cap currently in effect (0.5 off-peak, 0.25 peak). */
  maxFraction: number;
  peak: boolean;
}

/**
 * Estimate the settled charge for a base amount given minutes trained and peak.
 * Linear discount up to the cap between 0 and FULL_DISCOUNT_AT_MIN minutes.
 */
export function estimate(baseCents: number, minutes: number, peak: boolean): Estimate {
  const maxFraction = peak ? MAX_DISCOUNT_PEAK : MAX_DISCOUNT_OFFPEAK;
  const progress = Math.min(Math.max(minutes, 0), FULL_DISCOUNT_AT_MIN) / FULL_DISCOUNT_AT_MIN;
  const discountFraction = maxFraction * progress;
  const discountCents = Math.round(baseCents * discountFraction);
  const finalCents = Math.max(0, baseCents - discountCents);
  return {
    baseCents,
    discountCents,
    finalCents,
    savedCents: discountCents,
    discountFraction,
    maxFraction,
    peak,
  };
}

export function money(cents: number): string {
  return `R${(cents / 100).toFixed(2)}`;
}
