"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shared dark theme for the streaming surfaces (dashboard + player).
// Mirrors the structure of the gym POS palette so the two services feel like
// one product, but swaps the green accent for a streaming violet.
// ─────────────────────────────────────────────────────────────────────────────

export const STREAM_C = {
  bg: "#0b1120",
  panel: "#111a2e",
  panelSoft: "#0f1729",
  line: "#1f2a40",
  text: "#f1f5f9",
  dim: "#8694ad",
  accent: "#a855f7", // violet-500
  accentDeep: "#7c3aed", // violet-600
  accentSoft: "#2e1065", // deep violet
  green: "#22c55e",
  greenDeep: "#16a34a",
  amber: "#fbbf24",
} as const;

/** USD formatter — backend amounts are in cents (assetScale 2). */
export function streamMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Shared keyframes + hover rules injected once per surface via a <style> tag. */
export const STREAM_CSS = `
.s-fadeUp{animation:s-fadeUp .35s ease both}
@keyframes s-fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.s-pop{animation:s-pop .4s cubic-bezier(.34,1.56,.64,1) both}
@keyframes s-pop{0%{opacity:0;transform:scale(.85)}100%{opacity:1;transform:scale(1)}}
.s-btn{transition:transform .15s,filter .15s,background .15s}
.s-btn:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.08)}
.s-btn:active:not(:disabled){transform:translateY(0)}
.s-card{transition:border-color .15s,transform .15s,background .15s}
.s-card:hover{transform:translateY(-1px)}
.s-bar{transition:width .4s cubic-bezier(.4,0,.2,1)}
.s-live{position:relative;display:inline-block;width:8px;height:8px;border-radius:999px;background:#a855f7}
.s-live::after{content:"";position:absolute;inset:0;border-radius:999px;background:#a855f7;animation:s-ping 1.4s cubic-bezier(0,0,.2,1) infinite}
@keyframes s-ping{75%,100%{transform:scale(2.4);opacity:0}}
.s-meter{animation:s-pulse 1.6s ease-in-out infinite}
@keyframes s-pulse{0%,100%{opacity:1}50%{opacity:.72}}
`;
