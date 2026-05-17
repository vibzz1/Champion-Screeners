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
      setPositions(await r.json());
    } catch {
      setError("Cannot connect to backend.");
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

  const totalCost = positions.reduce((s, p) => s + p.buy_price * p.quantity, 0);
  const totalValue = positions.reduce((s, p) => s + p.current_price * p.quantity, 0);
  const totalPnL = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  return (
    <div>
      <h2 className="text-lg font-bold mb-3" style={{ color: "#003366" }}>Portfolio Tracker</h2>
      {error && <p className="text-red-600 text-xs mb-2">{error}</p>}

      {/* Summary */}
      <div className="flex gap-3 mb-4 text-xs">
        {[
          { label: "Positions", value: positions.length.toString() },
          { label: "Total Cost", value: `$${totalCost.toLocaleString("en-US", { maximumFractionDigits: 2 })}` },
          { label: "Market Value", value: `$${totalValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}` },
          {
            label: "Total P&L",
            value: `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} (${totalPnLPct >= 0 ? "+" : ""}${totalPnLPct.toFixed(2)}%)`,
            color: totalPnL >= 0 ? "#007700" : "#cc0000",
          },
        ].map((c) => (
          <div key={c.label} className="border border-gray-300 rounded p-2 bg-white min-w-[130px]">
            <div className="text-gray-500 text-[10px]">{c.label}</div>
            <div className="font-bold text-sm mt-0.5" style={{ color: c.color || "#003366" }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Add position toggle */}
      <div className="mb-3">
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 text-xs text-white rounded"
          style={{ backgroundColor: "#003366" }}
        >
          {showForm ? "Cancel" : "+ Add Position"}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="border border-gray-300 rounded p-3 mb-4 bg-[#f8fbff] text-xs">
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Symbol *", key: "symbol", placeholder: "AAPL" },
              { label: "Name", key: "name", placeholder: "Apple Inc." },
              { label: "Quantity *", key: "quantity", placeholder: "10", type: "number" },
              { label: "Buy Price *", key: "buy_price", placeholder: "150.00", type: "number" },
              { label: "Current Price", key: "current_price", placeholder: "same as buy price" },
              { label: "Buy Date *", key: "buy_date", placeholder: "2024-01-15", type: "date" },
            ].map((f) => (
              <div key={f.key}>
                <label className="block font-semibold mb-1">{f.label}</label>
                <input
                  type={f.type || "text"}
                  className="border border-gray-300 rounded px-2 py-1 w-full"
                  placeholder={f.placeholder}
                  value={form[f.key as keyof typeof form]}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <button
            onClick={addPosition}
            className="mt-3 px-4 py-1.5 text-xs text-white rounded"
            style={{ backgroundColor: "#003366" }}
          >
            Add to Portfolio
          </button>
        </div>
      )}

      {/* Table */}
      {positions.length === 0 ? (
        <div className="text-xs text-gray-500 border border-gray-200 rounded p-4">
          No positions yet. Add one above.
        </div>
      ) : (
        <div className="border border-gray-300 rounded overflow-x-auto bg-white">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                {["Symbol", "Name", "Qty", "Buy Price", "Current Price", "Cost Basis", "Market Value", "P&L", "P&L %", "Buy Date", ""].map((h) => (
                  <th key={h} className="border border-gray-200 px-2 py-1 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const cost = p.buy_price * p.quantity;
                const value = p.current_price * p.quantity;
                const pnl = value - cost;
                const pnlPct = (pnl / cost) * 100;
                const green = pnl >= 0;

                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="border border-gray-200 px-2 py-1 font-semibold" style={{ color: "#003399" }}>{p.symbol}</td>
                    <td className="border border-gray-200 px-2 py-1 text-gray-600">{p.name}</td>
                    <td className="border border-gray-200 px-2 py-1">{p.quantity}</td>
                    <td className="border border-gray-200 px-2 py-1">${p.buy_price.toFixed(2)}</td>
                    <td className="border border-gray-200 px-2 py-1">
                      {editingPrice?.id === p.id ? (
                        <div className="flex gap-1">
                          <input
                            type="number"
                            className="border rounded px-1 py-0.5 w-20 text-xs"
                            value={editingPrice.value}
                            onChange={(e) => setEditingPrice({ id: p.id, value: e.target.value })}
                            onKeyDown={(e) => e.key === "Enter" && updatePrice(p.id, editingPrice.value)}
                            autoFocus
                          />
                          <button onClick={() => updatePrice(p.id, editingPrice.value)} className="text-green-700 font-bold">✓</button>
                          <button onClick={() => setEditingPrice(null)} className="text-gray-400">✕</button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer hover:underline"
                          title="Click to edit"
                          onClick={() => setEditingPrice({ id: p.id, value: p.current_price.toString() })}
                        >
                          ${p.current_price.toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="border border-gray-200 px-2 py-1">${cost.toFixed(2)}</td>
                    <td className="border border-gray-200 px-2 py-1">${value.toFixed(2)}</td>
                    <td className="border border-gray-200 px-2 py-1" style={{ color: green ? "#007700" : "#cc0000" }}>
                      {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                    </td>
                    <td className="border border-gray-200 px-2 py-1" style={{ color: green ? "#007700" : "#cc0000" }}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </td>
                    <td className="border border-gray-200 px-2 py-1 text-gray-500">{p.buy_date}</td>
                    <td className="border border-gray-200 px-2 py-1">
                      <button onClick={() => remove(p.id)} className="text-red-400 hover:text-red-600">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
