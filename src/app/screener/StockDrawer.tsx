"use client";
import { useEffect, useState } from "react";
import type { Result } from "./types";
import { InteractiveChart } from "./InteractiveChart";
import { fmtCap, fmtVol, tvUrl } from "./helpers";

interface WL { id: number; name: string }

export function StockDrawer({ stock, onClose, exchange, masterBars, inWatchlist, onWatchlistChange, api }: {
  stock: Result | null;
  onClose: () => void;
  exchange: string;
  masterBars: number;
  inWatchlist: boolean;
  onWatchlistChange: () => void;
  api: string;
}) {
  const [wls, setWls]   = useState<WL[]>([]);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // Reset + load watchlists whenever a new stock opens the drawer.
  useEffect(() => {
    if (!stock) return;
    setMenu(false); setNote(""); setBusy(false);
    fetch(`${api}/api/watchlists`).then(r => r.ok ? r.json() : []).then(setWls).catch(() => {});
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stock, api, onClose]);

  if (!stock) return null;
  const s = stock;
  const up = (s.change_pct ?? 0) >= 0;
  const upC = up ? "var(--mio-up)" : "var(--mio-dn)";

  async function addTo(wlId: number) {
    setBusy(true);
    try {
      const r = await fetch(`${api}/api/watchlists/${wlId}/stocks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s.symbol }),
      });
      if (r.ok) { setNote(`Added ${s.symbol} to watchlist`); setMenu(false); onWatchlistChange(); }
      else setNote("Couldn't add — try again");
    } catch { setNote("Couldn't reach the server"); }
    finally { setBusy(false); }
  }

  async function newListAndAdd() {
    const name = (window.prompt("New watchlist name:", "My Watchlist") || "").trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch(`${api}/api/watchlists`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (r.ok) { const wl: WL = await r.json(); setWls(p => [...p, wl]); await addTo(wl.id); }
      else setNote("That name may already exist");
    } catch { setNote("Couldn't create the list"); }
    finally { setBusy(false); }
  }

  const Stat = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div className="rounded-lg px-3 py-2" style={{ background: "var(--mio-surface2)" }}>
      <div className="text-[9.5px] uppercase tracking-wide" style={{ color: "var(--mio-text3)", letterSpacing: "0.06em" }}>{label}</div>
      <div className="text-[13px] font-bold tabular-nums mt-0.5" style={{ color: color ?? "var(--mio-text)" }}>{value}</div>
    </div>
  );
  const smaColor = (v: number | null) => v == null ? "var(--mio-text3)" : (s.price > v ? "var(--mio-up)" : "var(--mio-dn)");
  const fmtSma = (v: number | null) => v == null ? "—" : v >= 1000 ? `${(v/1000).toFixed(1)}K` : v.toFixed(0);

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(4,8,16,0.55)" }} />
      {/* Panel */}
      <aside role="dialog" aria-label={`${s.symbol} detail`}
        className="fixed top-0 right-0 h-full flex flex-col"
        style={{ zIndex: 201, width: "min(460px, 100vw)", background: "var(--mio-surface)",
                 borderLeft: "1px solid var(--mio-border)", boxShadow: "-12px 0 40px rgba(0,0,0,0.4)" }}>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--mio-border)" }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold" style={{ color: "var(--mio-ticker)" }}>{s.symbol}</span>
              {s.new_52w_high && <span className="text-[10px] font-bold px-1 rounded" style={{ background: "var(--mio-up-bg)", color: "var(--mio-up)" }}>52H</span>}
              {inWatchlist && <span className="text-[10px] font-bold px-1 rounded" style={{ background: "#fef3c7", color: "#b45309" }}>WL</span>}
            </div>
            <div className="text-[12px] truncate" style={{ color: "var(--mio-text2)" }}>{s.name}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold tabular-nums" style={{ color: "var(--mio-text)" }}>{s.price?.toLocaleString()}</div>
            <div className="text-[12px] font-semibold tabular-nums" style={{ color: upC }}>{up ? "+" : ""}{s.change_pct}%</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-xl leading-none px-1"
            style={{ color: "var(--mio-text3)" }}>×</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Chart */}
          <div className="rounded-xl overflow-hidden border mb-4" style={{ borderColor: "var(--mio-border)" }}>
            {s.ohlcv && s.ohlcv.length > 0
              ? <InteractiveChart data={s.ohlcv} masterBars={masterBars} priceHeight={200} />
              : <div className="p-8 text-center text-[12px]" style={{ color: "var(--mio-text3)" }}>No chart data</div>}
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <Stat label="RSI" value={s.rsi != null ? String(s.rsi) : "—"}
              color={s.rsi == null ? undefined : s.rsi > 70 ? "var(--mio-dn)" : s.rsi < 30 ? "var(--mio-up)" : "var(--mio-text)"} />
            <Stat label="MACD" value={s.macd_bullish ? "Bullish" : "Bearish"} color={s.macd_bullish ? "var(--mio-up)" : "var(--mio-dn)"} />
            <Stat label="% from 52H" value={s.pct_from_52w_high != null ? `${s.pct_from_52w_high}%` : "—"}
              color={(s.pct_from_52w_high ?? -99) >= -5 ? "var(--mio-up)" : "var(--mio-text)"} />
            <Stat label="SMA 20" value={fmtSma(s.sma20)} color={smaColor(s.sma20)} />
            <Stat label="SMA 50" value={fmtSma(s.sma50)} color={smaColor(s.sma50)} />
            <Stat label="SMA 200" value={fmtSma(s.sma200)} color={smaColor(s.sma200)} />
            <Stat label="Volume" value={fmtVol(s.volume)} />
            <Stat label="Mkt Cap" value={fmtCap(s.market_cap, exchange)} />
            <Stat label="Cap" value={s.cap_size || "—"} />
          </div>

          {/* Sector / industry */}
          <div className="text-[12px] mb-4" style={{ color: "var(--mio-text2)" }}>
            <span style={{ color: "var(--mio-text3)" }}>Sector:</span> {s.sector || "—"}
            {s.industry && <> · <span style={{ color: "var(--mio-text3)" }}>Industry:</span> {s.industry}</>}
          </div>
        </div>

        {/* Sticky action bar */}
        <div className="px-5 py-3 flex items-center gap-2 relative" style={{ borderTop: "1px solid var(--mio-border)", background: "var(--mio-surface2)" }}>
          <div className="relative">
            <button onClick={() => setMenu(m => !m)} disabled={busy}
              className="text-[12px] font-semibold px-3 py-2 rounded-lg"
              style={{ background: inWatchlist ? "var(--mio-surface)" : "var(--mio-accent)",
                       color: inWatchlist ? "var(--mio-text2)" : "#fff",
                       border: inWatchlist ? "1px solid var(--mio-border)" : "none" }}>
              {busy ? "Saving…" : inWatchlist ? "✓ In a watchlist · add to another" : "+ Add to watchlist"}
            </button>
            {menu && (
              <div className="absolute bottom-full left-0 mb-1 rounded-lg overflow-hidden shadow-lg"
                style={{ minWidth: 200, background: "var(--mio-surface)", border: "1px solid var(--mio-border)" }}>
                {wls.map(w => (
                  <button key={w.id} onClick={() => addTo(w.id)} disabled={busy}
                    className="block w-full text-left px-3 py-2 text-[12px] hover:opacity-80"
                    style={{ color: "var(--mio-text)", borderBottom: "1px solid var(--mio-border2)" }}>
                    {w.name}
                  </button>
                ))}
                <button onClick={newListAndAdd} disabled={busy}
                  className="block w-full text-left px-3 py-2 text-[12px] font-semibold"
                  style={{ color: "var(--mio-accent)" }}>
                  + New list…
                </button>
              </div>
            )}
          </div>
          <a href={tvUrl(s.ticker, exchange)} target="_blank" rel="noopener noreferrer"
            className="text-[12px] font-semibold px-3 py-2 rounded-lg"
            style={{ background: "var(--mio-surface)", color: "var(--mio-ticker)", border: "1px solid var(--mio-border)" }}>
            TradingView ↗
          </a>
          {note && <span className="text-[11px] ml-auto" style={{ color: "var(--mio-up)" }}>{note}</span>}
        </div>
      </aside>
    </>
  );
}
