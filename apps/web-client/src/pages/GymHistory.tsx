"use client";

import Link from "next/link";
import { useRouter } from "next/router";
import { useState, useEffect } from "react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4001";

interface Settlement {
  id: string;
  settlementDate: string;
  serviceType: "gym" | "streaming";
  totalMinutes: number;
  chargeAmountCents: number;
  currency: string;
  status: "charged" | "skipped" | "failed" | "pending";
  breakdown: { base?: number; durationDiscount?: number; peakAdjustment?: number; ratePerMinute?: number } | null;
  createdAt: string;
}

export default function GymHistory() {
  const router = useRouter();
  const nfcUid = (router.query.uid as string) || "";
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nfcUid) return;
    setIsLoading(true);
    fetch(`${BACKEND}/api/gym/history/${encodeURIComponent(nfcUid)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load history");
        return r.json();
      })
      .then(({ settlements: data }) => setSettlements(data ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setIsLoading(false));
  }, [nfcUid]);

  function formatCents(cents: number, currency = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  }

  function statusBadge(status: Settlement["status"]) {
    const colors: Record<string, string> = {
      charged: "#16a34a",
      skipped: "#9ca3af",
      failed: "#dc2626",
      pending: "#f59e0b",
    };
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 600,
          color: "#fff",
          background: colors[status] ?? "#6b7280",
        }}
      >
        {status}
      </span>
    );
  }

  const shell = (children: React.ReactNode) => (
    <>
      <header
        style={{
          background: "#1e293b",
          color: "#fff",
          padding: "0 1.5rem",
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <Link href="/POSDashboard" style={{ color: "#94a3b8", textDecoration: "none", fontSize: 14 }}>
          ← Front Desk
        </Link>
        <span style={{ color: "#475569" }}>|</span>
        <span style={{ fontWeight: 700, fontSize: 16 }}>🏋️ Payment History</span>
      </header>
      <main style={{ maxWidth: 900, margin: "2rem auto", padding: "0 1.5rem" }}>{children}</main>
    </>
  );

  if (isLoading) return shell(<p style={{ color: "#94a3b8", padding: "2rem 0" }}>Loading history…</p>);
  if (error) return shell(
    <div style={{ padding: "1rem 1.25rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, color: "#dc2626" }}>
      Error: {error}
    </div>
  );

  if (settlements.length === 0) {
    return shell(
      <div
        style={{
          padding: "3rem",
          textAlign: "center",
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          color: "#64748b",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: "1rem" }}>📋</div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>No settlement history yet</div>
        <div style={{ fontSize: 14 }}>Charges appear here after midnight on each day you visit the gym.</div>
      </div>
    );
  }

  return shell(
    <>
      <div style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ margin: "0 0 0.25rem", fontSize: 20, fontWeight: 800 }}>Settlement History</h2>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>Charges collected at midnight · UID: {nfcUid}</p>
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Date", "Service", "Minutes", "Charge", "Status", "Breakdown"].map((h) => (
                  <th
                    key={h}
                    style={{ textAlign: "left", padding: "0.75rem 1rem", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settlements.map((s, i) => (
                <tr
                  key={s.id}
                  style={{ borderBottom: i < settlements.length - 1 ? "1px solid #f1f5f9" : "none" }}
                >
                  <td style={{ padding: "0.75rem 1rem", whiteSpace: "nowrap" }}>{s.settlementDate}</td>
                  <td style={{ padding: "0.75rem 1rem", textTransform: "capitalize" }}>{s.serviceType}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>{s.totalMinutes} min</td>
                  <td style={{ padding: "0.75rem 1rem", fontWeight: 700 }}>
                    {s.status === "skipped" ? <span style={{ color: "#94a3b8" }}>—</span> : formatCents(s.chargeAmountCents, s.currency)}
                  </td>
                  <td style={{ padding: "0.75rem 1rem" }}>{statusBadge(s.status)}</td>
                  <td style={{ padding: "0.75rem 1rem", fontSize: 12, color: "#6b7280" }}>
                    {s.breakdown && s.status === "charged" && (
                      <>
                        Base {formatCents(s.breakdown.base ?? 0)}
                        {s.breakdown.durationDiscount != null && ` − ${formatCents(s.breakdown.durationDiscount)} disc.`}
                        {s.breakdown.peakAdjustment != null && ` ${s.breakdown.peakAdjustment > 0 ? "+" : ""}${formatCents(Math.abs(s.breakdown.peakAdjustment))} peak`}
                        {s.breakdown.ratePerMinute != null && ` @ $${(s.breakdown.ratePerMinute / 100).toFixed(2)}/min`}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
