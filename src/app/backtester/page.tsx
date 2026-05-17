"use client";
import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const EXCHANGES = ["NYSE", "NASDAQ", "OTC", "TSX", "LSE", "HKSE", "BSE", "SGX"];

const ENTRY_CONDITIONS = [
  "Price Crossed Above MA(50)",
  "Price Crossed Above MA(200)",
  "EMA(50) Crossed Above EMA(200)",
  "MACD Histogram Crossed Above Zero",
  "RSI(14) Crossed Above 30",
  "RSI(14) Crossed Above 50",
  "Bollinger Band Lower Touched",
  "New 52-Week High",
  "Price Crossed Above Resistance Line",
  "Bullish Engulfing Candlestick",
  "SuperTrend Bullish Signal",
  "Stochastic Crossed Above 20",
];

const EXIT_CONDITIONS = [
  "Price Crossed Below MA(50)",
  "Price Crossed Below MA(200)",
  "EMA(50) Crossed Below EMA(200)",
  "MACD Histogram Crossed Below Zero",
  "RSI(14) Crossed Above 70",
  "Bollinger Band Upper Touched",
  "Trailing Stop Hit",
  "Take Profit Target Hit",
  "Price Crossed Below Support Line",
  "Bearish Engulfing Candlestick",
  "SuperTrend Bearish Signal",
];

interface Summary {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  profit_factor: number;
}

interface Trade {
  id: number;
  symbol: string;
  entry: number;
  exit: number;
  pnl_pct: number;
  result: string;
  bars_held: number;
}

interface BacktestResult {
  summary: Summary;
  equity_curve: { bar: number; equity: number }[];
  trades: Trade[];
}

export default function BacktesterPage() {
  const [form, setForm] = useState({
    strategy_name: "My Strategy",
    entry_condition: ENTRY_CONDITIONS[0],
    exit_condition: EXIT_CONDITIONS[0],
    stop_loss: 5,
    take_profit: 10,
    exchange: "NASDAQ",
    capital: 10000,
  });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error("Server error");
      setResult(await res.json());
    } catch {
      setError("Could not connect to backend. Make sure the FastAPI server is running.");
    } finally {
      setLoading(false);
    }
  }

  const s = result?.summary;

  return (
    <div>
      <h2 className="text-lg font-bold mb-3" style={{ color: "#003366" }}>Strategy Backtester</h2>

      {/* Form */}
      <div className="border border-gray-300 rounded p-4 mb-4 bg-[#f8fbff]">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="col-span-2">
            <label className="block font-semibold mb-1">Strategy Name</label>
            <input
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.strategy_name}
              onChange={(e) => setForm({ ...form, strategy_name: e.target.value })}
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Entry Condition</label>
            <select
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.entry_condition}
              onChange={(e) => setForm({ ...form, entry_condition: e.target.value })}
            >
              {ENTRY_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-semibold mb-1">Exit Condition</label>
            <select
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.exit_condition}
              onChange={(e) => setForm({ ...form, exit_condition: e.target.value })}
            >
              {EXIT_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-semibold mb-1">Stop Loss (%)</label>
            <input
              type="number"
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.stop_loss}
              onChange={(e) => setForm({ ...form, stop_loss: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Take Profit (%)</label>
            <input
              type="number"
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.take_profit}
              onChange={(e) => setForm({ ...form, take_profit: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Exchange</label>
            <select
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.exchange}
              onChange={(e) => setForm({ ...form, exchange: e.target.value })}
            >
              {EXCHANGES.map((ex) => <option key={ex}>{ex}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-semibold mb-1">Starting Capital ($)</label>
            <input
              type="number"
              className="border border-gray-300 rounded px-2 py-1 w-full"
              value={form.capital}
              onChange={(e) => setForm({ ...form, capital: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={run}
            disabled={loading}
            className="px-4 py-1.5 rounded text-white text-xs font-semibold disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {loading ? "Running..." : "Run Backtest"}
          </button>
        </div>
        {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      </div>

      {/* Results */}
      {result && s && (
        <div>
          {/* Summary cards */}
          <div className="grid grid-cols-5 gap-2 mb-4 text-xs">
            {[
              { label: "Total Trades", value: s.total_trades },
              { label: "Win Rate", value: `${s.win_rate}%`, color: s.win_rate >= 50 ? "#007700" : "#cc0000" },
              { label: "Total Return", value: `${s.total_return_pct > 0 ? "+" : ""}${s.total_return_pct}%`, color: s.total_return_pct >= 0 ? "#007700" : "#cc0000" },
              { label: "Max Drawdown", value: `-${s.max_drawdown_pct}%`, color: "#cc0000" },
              { label: "Sharpe Ratio", value: s.sharpe_ratio },
              { label: "Profit Factor", value: s.profit_factor },
              { label: "Avg Win", value: `+${s.avg_win_pct}%`, color: "#007700" },
              { label: "Avg Loss", value: `-${s.avg_loss_pct}%`, color: "#cc0000" },
              { label: "Wins", value: s.wins },
              { label: "Losses", value: s.losses },
            ].map((c) => (
              <div key={c.label} className="border border-gray-300 rounded p-2 bg-white text-center">
                <div className="text-gray-500 text-[10px]">{c.label}</div>
                <div className="font-bold text-sm mt-0.5" style={{ color: c.color || "#003366" }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Equity curve */}
          <div className="border border-gray-300 rounded p-3 mb-4 bg-white">
            <div className="text-xs font-semibold mb-2" style={{ color: "#003366" }}>Equity Curve</div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={result.equity_curve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="bar" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => v != null ? `$${Number(v).toLocaleString()}` : ""} />
                <Line type="monotone" dataKey="equity" stroke="#cc6600" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Trade list */}
          <div className="border border-gray-300 rounded bg-white overflow-x-auto">
            <div className="text-xs font-semibold p-2" style={{ color: "#003366" }}>Sample Trades (first 20)</div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-left">
                  {["#", "Symbol", "Entry $", "Exit $", "P&L %", "Bars Held", "Result"].map((h) => (
                    <th key={h} className="border border-gray-200 px-2 py-1">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.trades.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="border border-gray-200 px-2 py-1">{t.id}</td>
                    <td className="border border-gray-200 px-2 py-1 font-semibold">{t.symbol}</td>
                    <td className="border border-gray-200 px-2 py-1">{t.entry}</td>
                    <td className="border border-gray-200 px-2 py-1">{t.exit}</td>
                    <td className="border border-gray-200 px-2 py-1" style={{ color: t.pnl_pct >= 0 ? "#007700" : "#cc0000" }}>
                      {t.pnl_pct > 0 ? "+" : ""}{t.pnl_pct}%
                    </td>
                    <td className="border border-gray-200 px-2 py-1">{t.bars_held}</td>
                    <td className="border border-gray-200 px-2 py-1" style={{ color: t.result === "Win" ? "#007700" : "#cc0000" }}>
                      {t.result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
