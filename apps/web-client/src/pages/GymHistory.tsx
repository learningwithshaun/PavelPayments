"use client";

import Link from "next/link";
import { useRouter } from "next/router";
import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4001";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FlowSession {
  id: string;
  walletAddress: string;
  name: string | null;
  tapInAt: string;
  tapOutAt?: string;
  elapsedMinutes: number;
  runningCents: number;
  totalCents?: number;
  currency: string;
  ratePerMinuteCents: number;
  exitQrUrl: string;
  status: string;
}

interface GymVisit {
  id: string;
  tapInAt: string;
  tapOutAt: string | null;
  minutesAccumulated: number;
  terminalId: string;
  date: string;
  User: { nfcUid: string; name: string | null; walletAddress: string | null };
}

interface Settlement {
  id: string;
  settlementDate: string;
  serviceType: "gym" | "streaming";
  totalMinutes: number;
  chargeAmountCents: number;
  currency: string;
  status: "charged" | "skipped" | "failed" | "pending";
  breakdown: { base?: number; durationDiscount?: number; peakAdjustment?: number; ratePerMinute?: number } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function elapsed(tapInAt: string) {
  const ms = Date.now() - new Date(tapInAt).getTime();
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function shortWallet(addr: string) {
  if (!addr || addr === "pending") return addr;
  const clean = addr.replace(/^https?:\/\//, "");
  return clean.length > 32 ? clean.slice(0, 30) + "…" : clean;
}

// ── Inline name editor component ──────────────────────────────────────────────

function NameCell({ current, onSave }: { current: string | null; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    await onSave(value.trim());
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }}
          style={{ padding: "2px 6px", border: "1px solid #6366f1", borderRadius: 4, fontSize: 13, width: 130 }}
        />
        <button onClick={submit} disabled={saving} style={{ padding: "2px 8px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
          {saving ? "…" : "✓"}
        </button>
        <button onClick={() => setEditing(false)} style={{ padding: "2px 6px", background: "none", border: "1px solid #d1d5db", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>✕</button>
      </span>
    );
  }

  return (
    <span
      onClick={() => { setValue(current ?? ""); setEditing(true); }}
      title="Click to add/edit name"
      style={{ cursor: "pointer", color: current ? "#0f172a" : "#94a3b8", fontStyle: current ? "normal" : "italic", display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      {current ?? "Add name"}
      <span style={{ fontSize: 10, color: "#c7d2fe" }}>✎</span>
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GymHistory() {
  const router = useRouter();

  // Live PavelFlow sessions
  const [flowSessions, setFlowSessions] = useState<FlowSession[]>([]);
  const [flowLoading, setFlowLoading] = useState(true);
  const [exitQrSession, setExitQrSession] = useState<FlowSession | null>(null);
  const [, setTick] = useState(0);

  // All gym visits (persistent)
  const [visits, setVisits] = useState<GymVisit[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(true);

  // PavelFlow history (completed)
  const [flowHistory, setFlowHistory] = useState<FlowSession[]>([]);
  const [flowHistLoading, setFlowHistLoading] = useState(true);

  // UID-scoped settlement history
  const [uidInput, setUidInput] = useState((router.query.uid as string) ?? "");
  const [searchUid, setSearchUid] = useState((router.query.uid as string) ?? "");
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);

  // ── Fetch helpers ─────────────────────────────────────────────────────────

  const fetchFlow = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/gym/flow/active`);
      if (!r.ok) return;
      const { sessions } = await r.json();
      setFlowSessions(sessions ?? []);
    } catch { /* ignore */ } finally { setFlowLoading(false); }
  }, []);

  const fetchVisits = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/gym/visits?limit=100`);
      if (!r.ok) return;
      const { sessions } = await r.json();
      setVisits(sessions ?? []);
    } catch { /* ignore */ } finally { setVisitsLoading(false); }
  }, []);

  const fetchFlowHistory = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/gym/flow/history?limit=100`);
      if (!r.ok) return;
      const { sessions } = await r.json();
      setFlowHistory(sessions ?? []);
    } catch { /* ignore */ } finally { setFlowHistLoading(false); }
  }, []);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchFlow();
    fetchVisits();
    fetchFlowHistory();
    const pollId = setInterval(fetchFlow, 5000);
    const tickId = setInterval(() => setTick(t => t + 1), 1000);
    return () => { clearInterval(pollId); clearInterval(tickId); };
  }, [fetchFlow, fetchVisits, fetchFlowHistory]);

  // Keep exit-QR modal fresh; auto-close when session ends
  useEffect(() => {
    if (!exitQrSession) return;
    const updated = flowSessions.find(s => s.id === exitQrSession.id);
    if (updated) setExitQrSession(updated); else setExitQrSession(null);
  }, [flowSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settlement history (UID scoped)
  useEffect(() => {
    if (!searchUid) { setSettlements([]); return; }
    setHistLoading(true); setHistError(null);
    fetch(`${BACKEND}/api/gym/history/${encodeURIComponent(searchUid)}`)
      .then(r => { if (!r.ok) throw new Error("Failed to load history"); return r.json(); })
      .then(({ settlements: data }) => setSettlements(data ?? []))
      .catch(e => setHistError(e.message))
      .finally(() => setHistLoading(false));
  }, [searchUid]);

  // ── Name save handlers ────────────────────────────────────────────────────

  async function saveGymMemberName(uid: string, name: string) {
    await fetch(`${BACKEND}/api/gym/members/name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, name }),
    });
    setVisits(prev => prev.map(v =>
      v.User.nfcUid === uid ? { ...v, User: { ...v.User, name: name || null } } : v
    ));
  }

  async function saveFlowSessionName(sessionId: string, name: string) {
    await fetch(`${BACKEND}/api/gym/flow/name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, name }),
    });
    setFlowHistory(prev => prev.map(s =>
      s.id === sessionId ? { ...s, name: name || null } : s
    ));
  }

  // ── Status badge ──────────────────────────────────────────────────────────

  function statusBadge(status: Settlement["status"]) {
    const colors: Record<string, string> = {
      charged: "#16a34a", skipped: "#9ca3af", failed: "#dc2626", pending: "#f59e0b",
    };
    return (
      <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 600, color: "#fff", background: colors[status] ?? "#6b7280" }}>
        {status}
      </span>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <header style={S.header}>
        <Link href="/POSDashboard" style={S.back}>← Front Desk</Link>
        <span style={{ color: "#475569" }}>|</span>
        <span style={{ fontWeight: 700, fontSize: 16 }}>🏋️ Gym — History & Live Sessions</span>
      </header>

      <main style={{ maxWidth: 1100, margin: "2rem auto", padding: "0 1.5rem", display: "flex", flexDirection: "column", gap: "2.5rem" }}>

        {/* ── Live PavelFlow Sessions ─────────────────────────────────────── */}
        <section>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem" }}>
            <h2 style={S.sectionH2}>〰️ Live Streams</h2>
            {flowSessions.length > 0 && (
              <span style={S.liveBadge}>● {flowSessions.length} streaming now</span>
            )}
          </div>
          {flowLoading ? (
            <p style={S.dim}>Loading…</p>
          ) : flowSessions.length === 0 ? (
            <div style={S.emptyCard}>No active streams right now.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {flowSessions.map(s => (
                <button key={s.id} onClick={() => setExitQrSession(s)} style={S.flowRow}>
                  <span style={{ fontSize: 22 }}>〰️</span>
                  <div style={{ flex: 1, textAlign: "left" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
                      {s.name ?? shortWallet(s.walletAddress)}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                      In since {fmtTime(s.tapInAt)} · {elapsed(s.tapInAt)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 800, fontSize: 18, color: "#16a34a" }}>{money(s.runningCents, s.currency)}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>running total</div>
                  </div>
                  <div style={S.exitQrHint}>
                    <span style={{ fontSize: 16 }}>📱</span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>Exit QR</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── All Gym Visits ──────────────────────────────────────────────── */}
        <section>
          <h2 style={{ ...S.sectionH2, marginBottom: "1rem" }}>🗂️ All Gym Visits</h2>
          {visitsLoading ? (
            <p style={S.dim}>Loading…</p>
          ) : visits.length === 0 ? (
            <div style={S.emptyCard}>No visits recorded yet.</div>
          ) : (
            <div style={S.card}>
              <table style={S.table}>
                <thead>
                  <tr style={S.thead}>
                    {["Member / UID", "Date", "Tap In", "Tap Out", "Duration", "Terminal"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visits.map((v, i) => (
                    <tr key={v.id} style={{ borderBottom: i < visits.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                      <td style={S.td}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <NameCell
                            current={v.User?.name ?? null}
                            onSave={name => saveGymMemberName(v.User.nfcUid, name)}
                          />
                          <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{v.User?.nfcUid}</span>
                        </div>
                      </td>
                      <td style={S.td}>{fmtDate(v.tapInAt)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtTime(v.tapInAt)}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {v.tapOutAt
                          ? fmtTime(v.tapOutAt)
                          : <span style={{ color: "#16a34a", fontWeight: 600 }}>● Inside now</span>}
                      </td>
                      <td style={S.td}>{v.tapOutAt ? `${v.minutesAccumulated} min` : <span style={{ color: "#94a3b8" }}>—</span>}</td>
                      <td style={{ ...S.td, color: "#94a3b8", fontSize: 12 }}>{v.terminalId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── PavelFlow History ───────────────────────────────────────────── */}
        <section>
          <h2 style={{ ...S.sectionH2, marginBottom: "1rem" }}>〰️ Stream History</h2>
          {flowHistLoading ? (
            <p style={S.dim}>Loading…</p>
          ) : flowHistory.length === 0 ? (
            <div style={S.emptyCard}>No completed streams yet.</div>
          ) : (
            <div style={S.card}>
              <table style={S.table}>
                <thead>
                  <tr style={S.thead}>
                    {["Member / Wallet", "Date", "Started", "Ended", "Duration", "Total", "Status"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flowHistory.map((s, i) => {
                    const mins = s.tapOutAt
                      ? Math.ceil((new Date(s.tapOutAt).getTime() - new Date(s.tapInAt).getTime()) / 60000)
                      : null;
                    return (
                      <tr key={s.id} style={{ borderBottom: i < flowHistory.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={S.td}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <NameCell
                              current={s.name ?? null}
                              onSave={name => saveFlowSessionName(s.id, name)}
                            />
                            <span style={{ fontSize: 11, color: "#94a3b8" }}>{shortWallet(s.walletAddress)}</span>
                          </div>
                        </td>
                        <td style={S.td}>{fmtDate(s.tapInAt)}</td>
                        <td style={{ ...S.td, whiteSpace: "nowrap" }}>{fmtTime(s.tapInAt)}</td>
                        <td style={{ ...S.td, whiteSpace: "nowrap" }}>{s.tapOutAt ? fmtTime(s.tapOutAt) : "—"}</td>
                        <td style={S.td}>{mins != null ? `${mins} min` : "—"}</td>
                        <td style={{ ...S.td, fontWeight: 700, color: "#16a34a" }}>
                          {s.totalCents != null ? money(s.totalCents, s.currency) : "—"}
                        </td>
                        <td style={S.td}>
                          <span style={{ padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 600,
                            background: s.status === "completed" ? "#dcfce7" : "#f1f5f9",
                            color: s.status === "completed" ? "#16a34a" : "#64748b" }}>
                            {s.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Settlement History (UID scoped) ─────────────────────────────── */}
        <section>
          <h2 style={{ ...S.sectionH2, marginBottom: "0.75rem" }}>📋 Settlement History</h2>
          <p style={{ fontSize: 13, color: "#64748b", marginBottom: "1rem", marginTop: 0 }}>
            Midnight settlements by NFC UID — populated after the first full session day.
          </p>
          <form onSubmit={e => { e.preventDefault(); setSearchUid(uidInput.trim()); }}
            style={{ display: "flex", gap: 8, marginBottom: "1.25rem" }}>
            <input value={uidInput} onChange={e => setUidInput(e.target.value)}
              placeholder="NFC UID or member ID…" style={S.searchInput} />
            <button type="submit" style={S.searchBtn}>Search</button>
          </form>

          {histLoading && <p style={S.dim}>Loading…</p>}
          {histError && <div style={S.errorBox}>{histError}</div>}
          {!histLoading && !histError && searchUid && settlements.length === 0 && (
            <div style={S.emptyCard}>No settlement records for this UID yet.</div>
          )}
          {!searchUid && <div style={S.emptyCard}>Enter an NFC UID above to load settlement records.</div>}

          {settlements.length > 0 && (
            <div style={{ ...S.card, overflowX: "auto" }}>
              <table style={S.table}>
                <thead>
                  <tr style={S.thead}>
                    {["Date", "Service", "Minutes", "Charge", "Status", "Breakdown"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s, i) => (
                    <tr key={s.id} style={{ borderBottom: i < settlements.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                      <td style={S.td}>{s.settlementDate}</td>
                      <td style={{ ...S.td, textTransform: "capitalize" }}>{s.serviceType}</td>
                      <td style={S.td}>{s.totalMinutes} min</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>
                        {s.status === "skipped" ? <span style={{ color: "#94a3b8" }}>—</span> : money(s.chargeAmountCents, s.currency)}
                      </td>
                      <td style={S.td}>{statusBadge(s.status)}</td>
                      <td style={{ ...S.td, fontSize: 12, color: "#6b7280" }}>
                        {s.breakdown && s.status === "charged" && (
                          <>
                            Base {money(s.breakdown.base ?? 0)}
                            {s.breakdown.durationDiscount != null && ` − ${money(s.breakdown.durationDiscount)} disc.`}
                            {s.breakdown.peakAdjustment != null && ` ${(s.breakdown.peakAdjustment ?? 0) > 0 ? "+" : ""}${money(Math.abs(s.breakdown.peakAdjustment ?? 0))} peak`}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* ── Exit QR Modal ────────────────────────────────────────────────── */}
      {exitQrSession && (
        <div style={S.modalOverlay} onClick={() => setExitQrSession(null)}>
          <div style={S.modalCard} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>Exit QR — PavelFlow</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Customer scans to close their stream and settle</div>
              </div>
              <button onClick={() => setExitQrSession(null)} style={S.closeBtn}>✕</button>
            </div>
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>Wallet</div>
              <div style={{ fontSize: 13, fontWeight: 600, wordBreak: "break-all" }}>{shortWallet(exitQrSession.walletAddress)}</div>
              <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
                <div><div style={{ fontSize: 11, color: "#64748b" }}>Time in gym</div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{elapsed(exitQrSession.tapInAt)}</div></div>
                <div><div style={{ fontSize: 11, color: "#64748b" }}>Running total</div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#16a34a" }}>{money(exitQrSession.runningCents, exitQrSession.currency)}</div></div>
                <div><div style={{ fontSize: 11, color: "#64748b" }}>Rate</div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>${(exitQrSession.ratePerMinuteCents / 100).toFixed(2)}/min</div></div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "center", padding: "1.25rem", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10 }}>
              <QRCodeSVG value={exitQrSession.exitQrUrl} size={220} level="H" bgColor="#ffffff" fgColor="#0f172a" />
            </div>
            <p style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", margin: "12px 0 0" }}>
              Customer scans → confirms exit → stream settles automatically
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  header:      { background: "#1e293b", color: "#fff", padding: "0 1.5rem", height: 56, display: "flex", alignItems: "center", gap: "1rem", position: "sticky", top: 0, zIndex: 100 },
  back:        { color: "#94a3b8", textDecoration: "none", fontSize: 14 },
  sectionH2:   { margin: 0, fontSize: 18, fontWeight: 800 },
  liveBadge:   { display: "inline-block", padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600, background: "#dcfce7", color: "#16a34a" },
  dim:         { color: "#94a3b8", fontSize: 14, margin: 0 },
  emptyCard:   { padding: "1.5rem 2rem", textAlign: "center" as const, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, color: "#94a3b8", fontSize: 14 },
  errorBox:    { padding: "0.75rem 1rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 14 },
  card:        { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  table:       { width: "100%", borderCollapse: "collapse" as const, fontSize: 14 },
  thead:       { background: "#f8fafc", borderBottom: "1px solid #e2e8f0" },
  th:          { textAlign: "left" as const, padding: "0.65rem 1rem", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" as const, fontSize: 13 },
  td:          { padding: "0.65rem 1rem", color: "#1e293b", verticalAlign: "middle" as const },
  flowRow:     { width: "100%", display: "flex", alignItems: "center", gap: 16, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.875rem 1rem", cursor: "pointer", textAlign: "left" as const, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  exitQrHint:  { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 2, padding: "0.4rem 0.75rem", borderRadius: 8, background: "#f0fdf4", border: "1px solid #bbf7d0" },
  searchInput: { flex: 1, padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, outline: "none" },
  searchBtn:   { padding: "0.5rem 1.25rem", background: "#1e293b", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer" },
  modalOverlay:{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: "1rem" },
  modalCard:   { background: "#fff", borderRadius: 16, padding: "1.5rem", width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" },
  closeBtn:    { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", lineHeight: 1, padding: 4 },
};