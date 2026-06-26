"use client";

import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4001";

export type POSStatus = "idle" | "generating" | "pending" | "completed" | "failed";

export interface LogEntry {
  timestamp: string;
  level: "INFO" | "ERROR" | "SUCCESS";
  message: string;
  data?: unknown;
}

export interface POSPaymentState {
  status: POSStatus;
  qrUrl: string | null;
  /** Amount in cents (e.g. 1500 = R15.00) */
  amount: number;
  currency: string;
  label: string;
  incomingPaymentId: string | null;
  logs: LogEntry[];
}

export function usePOSPayment() {
  const [state, setState] = useState<POSPaymentState>({
    status: "idle",
    qrUrl: null,
    amount: 0,
    currency: "USD",
    label: "",
    incomingPaymentId: null,
    logs: [],
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendLog = useCallback((level: LogEntry["level"], message: string, data?: unknown) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data !== undefined && { data }),
    };
    setState((prev) => ({ ...prev, logs: [...prev.logs, entry] }));
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const generatePayment = useCallback(
    async (durationKey: string) => {
      stopPolling();
      setState((prev) => ({
        ...prev,
        status: "generating",
        qrUrl: null,
        incomingPaymentId: null,
        logs: [],
      }));

      try {
        const res = await fetch(`${BACKEND}/api/gym/pos/incoming-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationKey }),
        });

        const data = await res.json();

        // Merge backend-emitted logs into the terminal panel
        if (Array.isArray(data.logs)) {
          setState((prev) => ({ ...prev, logs: [...prev.logs, ...data.logs] }));
        }

        if (!res.ok) throw new Error(data.error ?? "Failed to create payment");

        setState((prev) => ({
          ...prev,
          status: "pending",
          qrUrl: data.paymentUrl,
          amount: data.amount,
          currency: data.currency,
          label: data.label,
          incomingPaymentId: data.incomingPaymentId,
        }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        appendLog("ERROR", `Failed to generate payment: ${msg}`);
        setState((prev) => ({ ...prev, status: "failed" }));
      }
    },
    [stopPolling, appendLog]
  );

  // Poll every 2.5 s while a payment is pending
  useEffect(() => {
    if (state.status !== "pending" || !state.incomingPaymentId) {
      stopPolling();
      return;
    }

    const incomingPaymentId = state.incomingPaymentId;

    const poll = async () => {
      try {
        const encoded = encodeURIComponent(incomingPaymentId);
        const res = await fetch(`${BACKEND}/api/gym/pos/payment-status/${encoded}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          stopPolling();
          appendLog("SUCCESS", "RECEIPT CONFIRMED — Turnstile Unlocked", {
            receivedAmount: data.receivedAmount,
            incomingAmount: data.incomingAmount,
          });
          setState((prev) => ({ ...prev, status: "completed" }));
        }
      } catch {
        // Silent — transient network errors during polling are non-fatal
      }
    };

    pollRef.current = setInterval(poll, 2500);
    return () => stopPolling();
  }, [state.status, state.incomingPaymentId, stopPolling, appendLog]);

  /** Instantly trigger the completed state without a real payment (demo fallback). */
  const mockSuccess = useCallback(() => {
    stopPolling();
    appendLog("SUCCESS", "RECEIPT CONFIRMED — [MOCK] Transaction Settled", {
      receivedAmount: { value: String(state.amount), assetCode: state.currency, assetScale: 2 },
      incomingAmount: { value: String(state.amount), assetCode: state.currency, assetScale: 2 },
      mock: true,
    });
    setState((prev) => ({ ...prev, status: "completed" }));
  }, [stopPolling, appendLog, state.amount, state.currency]);

  const reset = useCallback(() => {
    stopPolling();
    setState({
      status: "idle",
      qrUrl: null,
      amount: 0,
      currency: "USD",
      label: "",
      incomingPaymentId: null,
      logs: [],
    });
  }, [stopPolling]);

  return { ...state, generatePayment, mockSuccess, reset };
}
