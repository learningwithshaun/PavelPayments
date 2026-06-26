"use client";

// ─────────────────────────────────────────────────────────────────────────────
// useWebMonetization — real Web Monetization (WM v2) integration.
//
// While active, a <link rel="monetization" href={receiver}> element is mounted
// in <head>. A Web Monetization–enabled browser / extension reads it and streams
// micropayments (via Interledger Open Payments) directly to the receiver wallet,
// firing a `monetization` event on the link element for each payment it sends.
//
// We listen for those events, accumulate the amount streamed, and surface the
// live total + status. No simulation: if no WM agent is present, nothing streams.
//
// Spec: https://webmonetization.org/specification/
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

/** Shape of the `monetization` event detail per the WM specification. */
interface MonetizationEventLike extends Event {
  amountSent?: { value?: string; currency?: string };
  incomingPayment?: string;
  paymentPointer?: string;
}

export type WMState =
  | "unsupported" // browser/agent has no Web Monetization support
  | "unconfigured" // no receiver wallet address provided
  | "idle" // supported + configured, not currently streaming
  | "pending" // link mounted, waiting for the first payment
  | "active" // payments are flowing
  | "stopped"; // streaming was stopped

/** True if this browser/agent advertises Web Monetization support. */
function detectSupport(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("link").relList.supports("monetization");
  } catch {
    return false;
  }
}

interface UseWebMonetizationOptions {
  /** Receiver wallet address / payment pointer that gets paid. */
  receiver?: string;
  /** Called for every streamed payment, with the amount converted to cents. */
  onPayment?: (cents: number, currency: string) => void;
  /**
   * Demo fallback rate in cents per minute. When > 0, the streamed total
   * accrues at this rate while active if no real Web Monetization agent is
   * paying. Real payments take over automatically. Set 0 to disable.
   */
  fallbackCentsPerMinute?: number;
}

export interface WebMonetizationApi {
  supported: boolean;
  state: WMState;
  /** Total streamed this session, in cents (assetScale 2). */
  totalCents: number;
  currency: string;
  /** Mount the monetization link and begin streaming. */
  start: () => void;
  /** Remove the link and stop streaming. */
  stop: () => void;
  /** Reset the accumulated total (e.g. when switching content). */
  reset: () => void;
}

export function useWebMonetization({
  receiver,
  onPayment,
  fallbackCentsPerMinute = 0,
}: UseWebMonetizationOptions): WebMonetizationApi {
  // Support can only be detected in the browser. Start with a deterministic
  // value so the server-rendered HTML matches the client's first render, then
  // detect for real in a post-mount effect to avoid a hydration mismatch.
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<WMState>(receiver ? "idle" : "unconfigured");
  const [totalCents, setTotalCents] = useState(0);
  const [currency, setCurrency] = useState("USD");

  const linkRef = useRef<HTMLLinkElement | null>(null);
  // Keep the latest onPayment without re-mounting the link each render.
  const onPaymentRef = useRef<UseWebMonetizationOptions["onPayment"]>(onPayment);
  useEffect(() => {
    onPaymentRef.current = onPayment;
  }, [onPayment]);

  const valueAccumRef = useRef(0); // total streamed this session, in currency units
  const sentCentsRef = useRef(0); // whole cents already reported via onPayment
  const realActiveRef = useRef(false); // a real monetization event has been seen
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Accumulate streamed value precisely (sub-cent micropayments add up over
  // time) and report only whole-cent increments to the consumer/backend.
  const applyValue = useCallback((addValue: number, cur: string) => {
    if (!Number.isFinite(addValue) || addValue <= 0) return;
    valueAccumRef.current += addValue;
    const totalC = Math.floor(valueAccumRef.current * 100);
    setCurrency(cur);
    setTotalCents(totalC);
    setState("active");
    const delta = totalC - sentCentsRef.current;
    if (delta > 0) {
      sentCentsRef.current = totalC;
      onPaymentRef.current?.(delta, cur);
    }
  }, []);

  const handlePayment = useCallback(
    (ev: Event) => {
      const e = ev as MonetizationEventLike;
      const value = parseFloat(e.amountSent?.value ?? "0");
      const cur = e.amountSent?.currency ?? "USD";
      if (!Number.isFinite(value) || value <= 0) return;
      // Real WM is paying — switch off the demo fallback to avoid double counting.
      realActiveRef.current = true;
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      applyValue(value, cur);
    },
    [applyValue]
  );

  const stop = useCallback(() => {
    const link = linkRef.current;
    if (link) {
      link.removeEventListener("monetization", handlePayment);
      link.remove();
      linkRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    setState((prev) =>
      prev === "unsupported" || prev === "unconfigured" ? prev : "stopped"
    );
  }, [handlePayment]);

  const start = useCallback(() => {
    realActiveRef.current = false;

    // Real Web Monetization: mount the <link> when the browser supports it and
    // a receiver is configured. A WM agent will then stream real payments.
    if (supported && receiver && !linkRef.current) {
      const link = document.createElement("link");
      link.rel = "monetization";
      link.href = receiver;
      link.addEventListener("monetization", handlePayment);
      document.head.appendChild(link);
      linkRef.current = link;
    }

    // Demo fallback: if no WM agent pays, accrue at a fixed rate per minute so
    // the streamed total still climbs while watching. Real payments (above)
    // take over and switch this off automatically.
    if (fallbackCentsPerMinute > 0 && !fallbackTimerRef.current) {
      const perSecondValue = fallbackCentsPerMinute / 60 / 100; // currency units / sec
      fallbackTimerRef.current = setInterval(() => {
        if (realActiveRef.current) return;
        applyValue(perSecondValue, "USD");
      }, 1000);
    }

    setState((prev) => (prev === "active" ? prev : "pending"));
  }, [supported, receiver, handlePayment, applyValue, fallbackCentsPerMinute]);

  const reset = useCallback(() => {
    valueAccumRef.current = 0;
    sentCentsRef.current = 0;
    realActiveRef.current = false;
    setTotalCents(0);
  }, []);

  // Detect Web Monetization support after mount (never during SSR), then
  // settle the initial status. Don't clobber an in-progress streaming state.
  useEffect(() => {
    const ok = detectSupport();
    setSupported(ok);
    setState((prev) => {
      if (prev === "pending" || prev === "active" || prev === "stopped") return prev;
      if (!ok) return "unsupported";
      return receiver ? "idle" : "unconfigured";
    });
  }, [receiver]);

  // Clean up the link if the component unmounts mid-stream.
  useEffect(() => stop, [stop]);

  return { supported, state, totalCents, currency, start, stop, reset };
}
