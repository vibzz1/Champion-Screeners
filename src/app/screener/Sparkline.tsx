"use client";

export function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const w = 80, h = 32, pad = 2;
  const pts = data
    .map((v, i) => `${pad + (i / (data.length - 1)) * (w - pad * 2)},${h - pad - ((v - mn) / rng) * (h - pad * 2)}`)
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={positive ? "#16a34a" : "#dc2626"} strokeWidth={1.4}/>
    </svg>
  );
}
