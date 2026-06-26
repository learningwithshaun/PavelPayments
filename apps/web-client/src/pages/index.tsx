import Link from "next/link";

const SECTIONS = [
  {
    href: "/Dashboard",
    label: "Wallet",
    icon: "💳",
    description: "Connect your Open Payments wallet and authorise spending mandates.",
    accent: "#2563eb",
    bg: "#eff6ff",
    border: "#bfdbfe",
  },
  {
    href: "/POSDashboard",
    label: "Gym",
    icon: "🏋️",
    description: "Front desk checkout — sell a pass and let members pay by scanning a code.",
    accent: "#16a34a",
    bg: "#f0fdf4",
    border: "#bbf7d0",
  },
  {
    href: "/StreamingDashboard",
    label: "Streaming",
    icon: "🎬",
    description: "Stream content and pay per minute, settled automatically at midnight.",
    accent: "#7c3aed",
    bg: "#faf5ff",
    border: "#e9d5ff",
  },
];

export default function HomePage() {
  return (
    <>
      {/* Top bar */}
      <header
        style={{
          background: "#1e293b",
          color: "#fff",
          padding: "0 1.5rem",
          height: 56,
          display: "flex",
          alignItems: "center",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.3px" }}>PavelPayments</span>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "3rem 1.5rem" }}>
        {/* Hero */}
        <div style={{ marginBottom: "2.5rem" }}>
          <h1 style={{ margin: "0 0 0.5rem", fontSize: 32, fontWeight: 800, color: "#1e293b" }}>
            Interledger-Powered Payments
          </h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 16, maxWidth: 500 }}>
            Dynamic billing for gym sessions, static subscriptions, and pay-per-minute streaming —
            all settled via Open Payments at midnight.
          </p>
        </div>

        {/* Section cards */}
        <div style={{ display: "grid", gap: "1rem" }}>
          {SECTIONS.map(({ href, label, icon, description, accent, bg, border }) => (
            <Link
              key={href}
              href={href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1.25rem",
                padding: "1.25rem 1.5rem",
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: 12,
                textDecoration: "none",
                color: "#1e293b",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                transition: "box-shadow 0.15s",
              }}
            >
              <span
                style={{
                  fontSize: 32,
                  width: 56,
                  height: 56,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#fff",
                  borderRadius: 12,
                  flexShrink: 0,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                }}
              >
                {icon}
              </span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 17, color: accent }}>{label}</div>
                <div style={{ fontSize: 14, color: "#64748b", marginTop: 2 }}>{description}</div>
              </div>
              <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 20 }}>→</span>
            </Link>
          ))}
        </div>

        <p style={{ marginTop: "2.5rem", color: "#94a3b8", fontSize: 13, textAlign: "center" }}>
          Powered by Interledger · Open Payments · GNAP
        </p>
      </main>
    </>
  );
}
