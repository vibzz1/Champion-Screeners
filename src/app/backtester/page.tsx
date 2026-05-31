"use client";
import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine } from "recharts";
import type { SavedScreener } from "@/app/screener/types";
import { DEFAULTS, SCREENER_LS_KEY } from "@/app/screener/constants";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Summary {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  profit_factor: number;
  entry_date: string;
  matched_count: number;
}

interface Trade {
  id: number;
  symbol: string;
  entry: number;
  exit: number;
  pnl_pct: number;
  pnl_abs: number;
  result: string;
  bars_held: number;
  exit_reason: string;
  sector: string;
  cap_size: string;
}

interface BacktestResult {
  summary: Summary;
  equity_curve: { bar: number; equity: number; ticker?: string }[];
  trades: Trade[];
}

function loadScreeners(): SavedScreener[] {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SCREENER_LS_KEY);
    const saved: SavedScreener[] = raw ? JSON.parse(raw) : [];
    const savedMap = new Map(saved.map(s => [s.id, s]));
    const defaultIds = new Set(DEFAULTS.map(d => d.id));
    const builtins = DEFAULTS.map(d => savedMap.get(d.id) ?? d);
    const custom = saved.filter(s => !defaultIds.has(s.id));
    return [...builtins, ...custom];
  } catch { return DEFAULTS; }
}

// default entry date = 3 months ago
function defaultEntryDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().slice(0, 10);
}

export default function BacktesterPage() {
  const [screeners, setScreeners] = useState<SavedScreener[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [formula, setFormula] = useState("");
  const [exchange, setExchange] = useState("NSE");
  const [entryDate, setEntryDate] = useState(defaultEntryDate());
  const [holdDays, setHoldDays] = useState(20);
  const [stopLoss, setStopLoss] = useState(7);
  const [takeProfit, setTakeProfit] = useState(15);
  const [capital, setCapital] = useState(100000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const list = loadScreeners();
    setScreeners(list);
    if (list.length > 0) {
      setSelectedId(list[0].id);
      setFormula(list[0].formula);
      setExchange(list[0].exchange);
    }
  }, []);

  function onSelectScreener(id: string) {
    setSelectedId(id);
    const s = screeners.find(x => x.id === id);
    if (s) { setFormula(s.formula); setExchange(s.exchange); }
  }

  async function run() {
    if (!formula.trim()) { setError("Enter a formula to test."); return; }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(`${API}/api/backtest/formula_run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formula,
          exchange,
          entry_date: entryDate,
          hold_days: holdDays,
          stop_loss_pct: stopLoss,
          take_profit_pct: takeProfit,
          capital,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Server error ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const s = result?.summary;

  const statCards = s ? [
    { label: "Matched stocks", value: s.matched_count, note: `on ${s.entry_date}` },
    { label: "Total trades",   value: s.total_trades },
    { label: "Win rate",       value: `${s.win_rate}%`,
      color: s.win_rate >= 50 ? "var(--mio-up)" : "var(--mio-dn)" },
    { label: "Total return",
      value: `${s.total_return_pct >= 0 ? "+" : ""}${s.total_return_pct}%`,
      color: s.total_return_pct >= 0 ? "var(--mio-up)" : "var(--mio-dn)" },
    { label: "Max drawdown",   value: `-${s.max_drawdown_pct}%`, color: "var(--mio-dn)" },
    { label: "Profit factor",  value: s.profit_factor,
      color: s.profit_factor >= 1.5 ? "var(--mio-up)" : s.profit_factor < 1 ? "var(--mio-dn)" : "#92400e" },
    { label: "Avg win",        value: `+${s.avg_win_pct}%`,  color: "var(--mio-up)" },
    { label: "Avg loss",       value: `-${s.avg_loss_pct}%`, color: "var(--mio-dn)" },
    { label: "Wins / Losses",  value: `${s.wins} / ${s.losses}` },
  ] : [];

  return (
    <div className="max-w-5xl">
      <h2 className="text-lg font-bold mb-3" style={{ color: "var(--mio-accent)" }}>Strategy Backtester</h2>
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        Select a screener formula and an entry date. The backtester runs the formula on that date,
        buys every matched stock in equal weight, then tracks each position until the stop-loss,
        take-profit, or holding period is reached.
      </p>

      {/* ── Config form ─────────────────────────────────────────────────── */}
      <div className="border border-gray-200 rounded-lg p-4 mb-4 bg-[#f8fbff]">
        <div className="grid grid-cols-2 gap-3 text-xs">

          {/* Screener selector */}
          <div className="col-span-2">
            <label className="block font-semibold mb-1 text-gray-600">Load from saved screener</label>
            <select
              className="border border-gray-300 rounded px-2 py-1 w-full bg-white text-xs"
              value={selectedId}
              onChange={e => onSelectScreener(e.target.value)}>
              <option value="">— custom formula below —</option>
              {screeners.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.exchange})</option>
              ))}
            </select>
          </div>

          {/* Formula */}
          <div className="col-span-2">
            <label className="block font-semibold mb-1 text-gray-600">Formula</label>
            <textarea
              rows={2}
              className="border border-gray-300 rounded px-2 py-1.5 w-full font-mono text-[11px] resize-none focus:outline-none focus:border-blue-400"
              value={formula}
              onChange={e => setFormula(e.target.value)}
              placeholder="e.g. rsi > 60 and sma20 > sma50 and volume > 500000"
            />
          </div>

          {/* Exchange */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Exchange</label>
            <select className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={exchange} onChange={e => setExchange(e.target.value)}>
              {["NSE","BSE","NYSE","NASDAQ","LSE","TSE"].map(ex => <option key={ex}>{ex}</option>)}
            </select>
          </div>

          {/* Entry date */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Entry date</label>
            <input type="date" className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={entryDate} onChange={e => setEntryDate(e.target.value)} />
          </div>

          {/* Hold days */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Max hold (trading days)</label>
            <input type="number" min={1} max={252}
              className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={holdDays} onChange={e => setHoldDays(Number(e.target.value))} />
          </div>

          {/* Capital */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Starting capital (₹ / $)</label>
            <input type="number" min={1000}
              className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={capital} onChange={e => setCapital(Number(e.target.value))} />
          </div>

          {/* Stop loss */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Stop loss %</label>
            <input type="number" min={0.5} max={50} step={0.5}
              className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={stopLoss} onChange={e => setStopLoss(Number(e.target.value))} />
          </div>

          {/* Take profit */}
          <div>
            <label className="block font-semibold mb-1 text-gray-600">Take profit %</label>
            <input type="number" min={0.5} max={200} step={0.5}
              className="border border-gray-300 rounded px-2 py-1 w-full bg-white"
              value={takeProfit} onChange={e => setTakeProfit(Number(e.target.value))} />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={run} disabled={loading}
            className="px-5 py-1.5 rounded text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5"
            style={{ backgroundColor: "var(--mio-accent)" }}>
            {loading && <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/>}
            {loading ? "Running…" : "▶ Run Backtest"}
          </button>
          {loading && <span className="text-xs text-gray-400">Running screener on {entryDate}, then computing exits…</span>}
        </div>
        {error && <p className="text-red-600 text-xs mt-2 bg-red-50 rounded px-2 py-1">{error}</p>}
      </div>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {result && s && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-5">
            {statCards.map(c => (
              <div key={c.label} className="border border-gray-200 rounded-lg p-2.5 bg-white text-center shadow-sm">
                <div className="text-gray-400 text-[10px] mb-0.5">{c.label}</div>
                <div className="font-bold text-base tabular-nums leading-tight"
                  style={{ color: c.color || "var(--mio-accent)" }}>{c.value}</div>
                {c.note && <div className="text-[9px] text-gray-400 mt-0.5">{c.note}</div>}
              </div>
            ))}
          </div>

          {/* Equity curve */}
          <div className="border border-gray-200 rounded-lg p-3 bg-white shadow-sm">
            <div className="text-xs font-semibold mb-2" style={{ color: "var(--mio-accent)" }}>
              Portfolio equity curve
              <span className="ml-2 text-[10px] text-gray-400 font-normal">
                starting {capital.toLocaleString()} → {result.equity_curve.at(-1)?.equity.toLocaleString()}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={result.equity_curve} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" />
                <XAxis dataKey="bar" tick={{ fontSize: 10 }} label={{ value: "trades", position: "insideRight", offset: -5, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => (v >= 1000 ? `${(v/1000).toFixed(0)}K` : `${v}`)} width={55} />
                <Tooltip
                  formatter={(v, _, p) => [`${Number(v).toLocaleString()}`, "Equity"]}
                  labelFormatter={(bar, payload) => {
                    const ticker = payload?.[0]?.payload?.ticker;
                    return ticker ? `Trade ${bar}: ${ticker}` : `Trade ${bar}`;
                  }}
                  contentStyle={{ fontSize: 11 }} />
                <ReferenceLine y={capital} stroke="#94a3b8" strokeDasharray="4 2" />
                <Line
                  type="monotone" dataKey="equity"
                  stroke={s.total_return_pct >= 0 ? "var(--mio-up)" : "var(--mio-dn)"}
                  dot={{ r: 3, fill: "#fff", stroke: s.total_return_pct >= 0 ? "var(--mio-up)" : "var(--mio-dn)", strokeWidth: 1.5 }}
                  strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Trade list */}
          <div className="border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: "var(--mio-accent)" }}>
                Trade log ({result.trades.length} trades)
              </span>
              <span className="text-[10px] text-gray-400">— equal-weight, {holdDays}d max hold, SL {stopLoss}%, TP {takeProfit}%</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-left text-[11px] text-gray-500 font-semibold border-b border-gray-200">
                    {["#","Symbol","Sector","Entry","Exit","P&L %","P&L abs","Bars","Exit"].map(h => (
                      <th key={h} className="px-2 py-1.5 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50 border-b border-gray-100">
                      <td className="px-2 py-1 text-gray-400">{t.id}</td>
                      <td className="px-2 py-1 font-bold" style={{ color: "#003399" }}>{t.symbol}</td>
                      <td className="px-2 py-1 text-gray-500 text-[10px]">{t.sector || "—"}</td>
                      <td className="px-2 py-1 tabular-nums">{t.entry.toLocaleString()}</td>
                      <td className="px-2 py-1 tabular-nums">{t.exit.toLocaleString()}</td>
                      <td className="px-2 py-1 tabular-nums font-semibold"
                        style={{ color: t.pnl_pct > 0 ? "var(--mio-up)" : t.pnl_pct < 0 ? "var(--mio-dn)" : "#6b7280" }}>
                        {t.pnl_pct > 0 ? "+" : ""}{t.pnl_pct}%
                      </td>
                      <td className="px-2 py-1 tabular-nums"
                        style={{ color: t.pnl_abs > 0 ? "var(--mio-up)" : t.pnl_abs < 0 ? "var(--mio-dn)" : "#6b7280" }}>
                        {t.pnl_abs > 0 ? "+" : ""}{t.pnl_abs.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 tabular-nums text-gray-500">{t.bars_held}</td>
                      <td className="px-2 py-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          t.exit_reason === "TP"   ? "bg-green-100 text-green-700" :
                          t.exit_reason === "SL"   ? "bg-red-100 text-red-600"    :
                          t.exit_reason === "Open" ? "bg-blue-50 text-blue-500"   :
                          "bg-gray-100 text-gray-500"
                        }`}>{t.exit_reason}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
