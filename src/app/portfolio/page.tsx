"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Position {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  buy_price: number;
  current_price: number;
  buy_date: string;
}

const EMPTY_FORM = { symbol: "", name: "", quantity: "", buy_price: "", current_price: "", buy_date: "" };

export default function PortfolioPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingPrice, setEditingPrice] = useState<{ id: number; value: string } | null>(null);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  async function load() {
    try {
      const r = await fetch(`${API}/api/portfolio`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPositions(await r.json());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot connect to backend.");
    }
  }

  useEffect(() => { load(); }, []);

  async function addPosition() {
    const body = {
      symbol: form.symbol.toUpperCase(),
      name: form.name,
      quantity: Number(form.quantity),
      buy_price: Number(form.buy_price),
      current_price: Number(form.current_price || form.buy_price),
      buy_date: form.buy_date,
    };
    await fetch(`${API}/api/portfolio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setForm(EMPTY_FORM);
    setShowForm(false);
    load();
  }

  async function updatePrice(id: number, price: string) {
    await fetch(`${API}/api/portfolio/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_price: Number(price) }),
    });
    setEditingPrice(null);
    load();
  }

  async function remove(id: number) {
    await fetch(`${API}/api/portfolio/${id}`, { method: "DELETE" });
    load();
  }

  const totalCost  = positions.reduce((s, p) => s + p.buy_price * p.quantity, 0);
  const totalValue = positions.reduce((s, p) => s + p.current_price * p.quantity, 0);
  const totalPnL   = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  return (
    <div className="mob-page-pad md:p-0 max-w-5xl">
      <h2 className="text-lg font-bold mb-3" style={{ color: "var(--mio-accent)" }}>Portfolio Tracker</h2>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 mb-4 px-4 py-3 rounded-lg border text-xs"
          style={{ backgroundColor: "var(--mio-dn-bg)", borderColor: "var(--mio-dn)", color: "var(--mio-dn)" }}>
          <span className="text-base leading-none mt-0.5">🔌</span>
          <div className="flex-1">
            <div className="font-semibold mb-0.5">Backend offline</div>
            <div style={{ color: "var(--mio-text2)" }}>{error}</div>
          </div>
          <button onClick={load} className="shrink-0 px-2.5 py-1 rounded border text-[10px] font-semibold transition-colors"
            style={{ borderColor: "var(--mio-dn)", color: "var(--mio-dn)" }}>↺ Retry</button>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-xs">
        {[
          { label: "Positions",    value: positions.length.toString() },
          { label: "Total Cost",   value: `₹${totalCost.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` },
          { label: "Market Value", value: `₹${totalValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` },
          {
            label: "Total P&L",
            value: `${totalPnL >= 0 ? "+" : ""}₹${Math.abs(totalPnL).toFixed(0)} (${totalPnLPct >= 0 ? "+" : ""}${totalPnLPct.toFixed(2)}%)`,
            color: totalPnL >= 0 ? "var(--mio-up)" : "var(--mio-dn)",
          },
        ].map((c) => (
          <div key={c.label} className="border border-gray-200 rounded-lg p-3 bg-white shadow-sm">
            <div className="text-gray-400 text-[10px] mb-0.5">{c.label}</div>
            <div className="font-bold text-sm tabular-nums" style={{ color: c.color || "var(--mio-accent)" }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Add position toggle */}
      <div className="mb-3">
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 text-xs text-white rounded font-semibold transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--mio-accent)" }}>
          {showForm ? "Cancel" : "+ Add Position"}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="border border-gray-200 rounded-lg p-4 mb-4 bg-[#f8fbff] text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: "Symbol *",      key: "symbol",        placeholder: "RELIANCE",    type: "text"   },
              { label: "Name",          key: "name",          placeholder: "Reliance Ind.", type: "text"  },
              { label: "Quantity *",    key: "quantity",      placeholder: "10",           type: "number" },
              { label: "Buy Price *",   key: "buy_price",     placeholder: "2400.00",      type: "number" },
              { label: "Current Price", key: "current_price", placeholder: "same as buy",  type: "number" },
              { label: "Buy Date *",    key: "buy_date",      placeholder: "2024-01-15",   type: "date"   },
            ].map((f) => (
              <div key={f.key}>
                <label className="block font-semibold mb-1 text-gray-600">{f.label}</label>
                <input
                  type={f.type}
                  className="border border-gray-200 rounded px-2 py-1 w-full bg-white focus:outline-none focus:border-blue-400"
                  placeholder={f.placeholder}
                  value={form[f.key as keyof typeof form]}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <button
            onClick={addPosition}
            className="mt-3 px-4 py-1.5 text-xs text-white rounded font-semibold transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--mio-accent)" }}>
            Add to Portfolio
          </button>
        </div>
      )}

      {/* Table */}
      {positions.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400 border border-gray-200 rounded-lg bg-white">
          <div className="text-4xl mb-3 opacity-40">💼</div>
          <div className="text-sm font-medium">No positions yet</div>
          <div className="text-xs mt-1 text-gray-300">Click "+ Add Position" above to get started</div>
        </div>
      ) : positions.length > 0 ? (
        <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white shadow-sm">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-left border-b border-gray-200">
                {["Symbol", "Name", "Qty", "Buy", "Current", "Cost", "Value", "P&L", "P&L %", "Date", ""].map((h) => (
                  <th key={h} className="px-2 py-1.5 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const cost  = p.buy_price * p.quantity;
                const value = p.current_price * p.quantity;
                const pnl   = value - cost;
                const pnlPct = (pnl / cost) * 100;
                const green = pnl >= 0;

                return (
                  <tr key={p.id} className="hover:bg-slate-50 border-b border-gray-100 last:border-0 transition-colors">
                    <td className="px-2 py-1.5 font-bold" style={{ color: "var(--mio-ticker)" }}>{p.symbol}</td>
                    <td className="px-2 py-1.5 text-gray-500 truncate max-w-[120px]">{p.name}</td>
                    <td className="px-2 py-1.5 tabular-nums">{p.quantity}</td>
                    <td className="px-2 py-1.5 tabular-nums">{p.buy_price.toLocaleString()}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {editingPrice?.id === p.id ? (
                        <div className="flex gap-1">
                          <input
                            type="number"
                            className="border rounded px-1 py-0.5 w-20 text-xs focus:outline-none focus:border-blue-400"
                            value={editingPrice.value}
                            onChange={(e) => setEditingPrice({ id: p.id, value: e.target.value })}
                            onKeyDown={(e) => e.key === "Enter" && updatePrice(p.id, editingPrice.value)}
                            autoFocus
                          />
                          <button onClick={() => updatePrice(p.id, editingPrice.value)}
                            className="font-bold" style={{ color: "var(--mio-up)" }}>✓</button>
                          <button onClick={() => setEditingPrice(null)} className="text-gray-400">✕</button>
                        </div>
                      ) : (
                        <span className="cursor-pointer hover:underline" title="Click to edit"
                          onClick={() => setEditingPrice({ id: p.id, value: p.current_price.toString() })}>
                          {p.current_price.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums text-gray-600">{cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td className="px-2 py-1.5 tabular-nums text-gray-600">{value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td className="px-2 py-1.5 tabular-nums font-semibold"
                      style={{ color: green ? "var(--mio-up)" : "var(--mio-dn)" }}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(0)}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums font-semibold"
                      style={{ color: green ? "var(--mio-up)" : "var(--mio-dn)" }}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </td>
                    <td className="px-2 py-1.5 text-gray-400">{p.buy_date}</td>
                    <td className="px-1 py-1.5 text-center">
                      <button onClick={() => remove(p.id)}
                        className="text-gray-300 hover:text-red-500 transition-colors text-base leading-none">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
