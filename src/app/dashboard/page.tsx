"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Breadth {
  exchange: string;
  as_of: string;
  regime: "risk_on" | "neutral" | "risk_off";
  index: null | {
    symbol: string; price: number; change_pct: number;
    sma50: number; sma200: number | null;
    above_50dma: boolean; above_200dma: boolean;
  };
  universe: {
    total: number; pct_above_50dma: number; pct_above_200dma: number;
    advancers: number; decliners: number; unchanged: number;
    new_52w_highs: number; avg_change_pct: number;
  };
  error?: string;
}

const REGIME = {
  risk_on:  { label: "Risk-On",  c: "var(--mio-up)", bg: "var(--mio-up-bg)", note: "Index above its moving averages and breadth is broad — trend-following setups have the wind behind them." },
  neutral:  { label: "Neutral",  c: "#b7791f",       bg: "rgba(217,164,42,0.14)", note: "Mixed signals — index and breadth disagree. Trade smaller, be selective, respect stops." },
  risk_off: { label: "Risk-Off", c: "var(--mio-dn)", bg: "var(--mio-dn-bg)", note: "Index below its 50-DMA and breadth is weak — long setups fail more often. Favour cash / defence." },
} as const;

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border p-4" style={{ background: "var(--mio-surface)", borderColor: "var(--mio-border)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--mio-text2)", letterSpacing: "0.06em" }}>{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1" style={{ color: accent ?? "var(--mio-text)" }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: "var(--mio-text3)" }}>{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData]     = useState<Breadth | null>(null);
  const [loading, setLoad]  = useState(true);
  const [warming, setWarm]  = useState(false);
  const [err, setErr]       = useState("");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const r = await fetch(`${API}/api/market/breadth?exchange=NSE`);
        const j = await r.json();
        if (!alive) return;
        if (j.warming) { setWarm(true); setLoad(false); timer = setTimeout(load, 8000); return; }
        if (j.error) setErr(j.error);
        else { setData(j); setWarm(false); }
      } catch {
        if (alive) setErr("Couldn't reach the market data service.");
      } finally {
        if (alive) setLoad(false);
      }
    }
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const reg = data ? REGIME[data.regime] : null;
  const u = data?.universe;
  const advPct = u && (u.advancers + u.decliners) > 0
    ? Math.round(100 * u.advancers / (u.advancers + u.decliners)) : 50;

  return (
    <div className="flex-1 overflow-auto mob-page-pad" style={{ padding: "1.5rem 1.75rem", background: "var(--mio-bg)" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-5">
          <div>
            <h1 className="text-xl font-bold" style={{ color: "var(--mio-ticker)" }}>Market Dashboard</h1>
            <div className="text-[12px]" style={{ color: "var(--mio-text2)" }}>
              NSE regime &amp; breadth{data ? ` · as of ${new Date(data.as_of).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}` : ""}
            </div>
          </div>
          <Link href="/screener" className="text-[12px] font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: "var(--mio-accent)", color: "#fff" }}>
            Run a scan &rarr;
          </Link>
        </div>

        {loading && (
          <div className="rounded-xl border p-10 text-center text-sm" style={{ background: "var(--mio-surface)", borderColor: "var(--mio-border)", color: "var(--mio-text2)" }}>
            Reading the market&hellip;
          </div>
        )}

        {!loading && warming && (
          <div className="rounded-xl border p-8 text-center text-sm" style={{ background: "var(--mio-surface)", borderColor: "var(--mio-border)", color: "var(--mio-text2)" }}>
            Warming the market data&hellip; this takes a few seconds after a restart. Refreshing automatically.
          </div>
        )}

        {!loading && !warming && err && (
          <div className="rounded-xl border p-6 text-sm" style={{ background: "var(--mio-dn-bg)", borderColor: "var(--mio-border)", color: "var(--mio-dn)" }}>
            {err} <Link href="/screener" style={{ color: "var(--mio-accent)", textDecoration: "underline" }}>Go to the screener</Link> and run a scan first — that warms the data the dashboard reads.
          </div>
        )}

        {!loading && data && reg && u && (
          <>
            {/* Regime banner */}
            <div className="rounded-xl border p-5 mb-5" style={{ background: reg.bg, borderColor: "var(--mio-border)" }}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--mio-text2)", letterSpacing: "0.08em" }}>Market regime</span>
                <span className="text-lg font-extrabold" style={{ color: reg.c }}>{reg.label}</span>
              </div>
              <p className="text-[13px] mt-1.5 mb-0" style={{ color: "var(--mio-text)", maxWidth: "70ch" }}>{reg.note}</p>
            </div>

            {/* Index + breadth grid */}
            <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
              {data.index && (
                <Tile label={`Index ${data.index.symbol}`}
                  value={data.index.price.toLocaleString("en-IN")}
                  sub={`${data.index.change_pct >= 0 ? "+" : ""}${data.index.change_pct}% today`}
                  accent={data.index.change_pct >= 0 ? "var(--mio-up)" : "var(--mio-dn)"} />
              )}
              {data.index && (
                <Tile label="Index vs DMA"
                  value={`${data.index.above_50dma ? "> 50" : "< 50"} / ${data.index.above_200dma ? "> 200" : "< 200"}`}
                  sub="50-DMA / 200-DMA"
                  accent={data.index.above_50dma && data.index.above_200dma ? "var(--mio-up)" : data.index.above_50dma ? "#b7791f" : "var(--mio-dn)"} />
              )}
              <Tile label="% above 50-DMA" value={`${u.pct_above_50dma}%`}
                sub={`${u.total.toLocaleString("en-IN")} stocks`}
                accent={u.pct_above_50dma >= 55 ? "var(--mio-up)" : u.pct_above_50dma <= 40 ? "var(--mio-dn)" : "#b7791f"} />
              <Tile label="% above 200-DMA" value={`${u.pct_above_200dma}%`}
                accent={u.pct_above_200dma >= 55 ? "var(--mio-up)" : u.pct_above_200dma <= 40 ? "var(--mio-dn)" : "#b7791f"} />
              <Tile label="New 52-wk highs" value={u.new_52w_highs.toLocaleString("en-IN")} accent="var(--mio-up)" />
              <Tile label="Avg change today" value={`${u.avg_change_pct >= 0 ? "+" : ""}${u.avg_change_pct}%`}
                accent={u.avg_change_pct >= 0 ? "var(--mio-up)" : "var(--mio-dn)"} />
            </div>

            {/* Advance / decline bar */}
            <div className="rounded-xl border p-4" style={{ background: "var(--mio-surface)", borderColor: "var(--mio-border)" }}>
              <div className="flex items-center justify-between text-[12px] mb-2">
                <span className="font-semibold tabular-nums" style={{ color: "var(--mio-up)" }}>{u.advancers.toLocaleString("en-IN")} advancing</span>
                <span className="uppercase tracking-wide text-[10px]" style={{ color: "var(--mio-text3)" }}>Advance / Decline</span>
                <span className="font-semibold tabular-nums" style={{ color: "var(--mio-dn)" }}>{u.decliners.toLocaleString("en-IN")} declining</span>
              </div>
              <div className="h-2.5 rounded-full overflow-hidden flex" style={{ background: "var(--mio-dn)" }}>
                <div style={{ width: `${advPct}%`, background: "var(--mio-up)", transition: "width .6s ease" }} />
              </div>
            </div>

            <p className="text-[11px] mt-4" style={{ color: "var(--mio-text3)" }}>
              Breadth is computed from the live scan universe; regime blends the index&rsquo;s own DMA trend with how broad participation is. Refreshes every ~10 minutes.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
