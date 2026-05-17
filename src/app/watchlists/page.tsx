"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Watchlist { id: number; name: string }
interface Stock { id: number; symbol: string; added_at: string }

export default function WatchlistsPage() {
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [selected, setSelected] = useState<Watchlist | null>(null);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [newList, setNewList] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [error, setError] = useState("");

  async function loadLists() {
    try {
      const r = await fetch(`${API}/api/watchlists`);
      const data = await r.json();
      setLists(data);
      if (data.length && !selected) {
        setSelected(data[0]);
      }
    } catch {
      setError("Cannot connect to backend.");
    }
  }

  async function loadStocks(wl: Watchlist) {
    const r = await fetch(`${API}/api/watchlists/${wl.id}/stocks`);
    setStocks(await r.json());
  }

  useEffect(() => { loadLists(); }, []);
  useEffect(() => { if (selected) loadStocks(selected); }, [selected]);

  async function createList() {
    if (!newList.trim()) return;
    await fetch(`${API}/api/watchlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newList.trim() }),
    });
    setNewList("");
    await loadLists();
  }

  async function deleteList(wl: Watchlist) {
    await fetch(`${API}/api/watchlists/${wl.id}`, { method: "DELETE" });
    if (selected?.id === wl.id) { setSelected(null); setStocks([]); }
    await loadLists();
  }

  async function addStock() {
    if (!newSymbol.trim() || !selected) return;
    await fetch(`${API}/api/watchlists/${selected.id}/stocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: newSymbol.trim().toUpperCase() }),
    });
    setNewSymbol("");
    loadStocks(selected);
  }

  async function removeStock(stockId: number) {
    if (!selected) return;
    await fetch(`${API}/api/watchlists/${selected.id}/stocks/${stockId}`, { method: "DELETE" });
    loadStocks(selected);
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-3" style={{ color: "#003366" }}>Watch Lists</h2>
      {error && <p className="text-red-600 text-xs mb-2">{error}</p>}

      <div className="flex gap-4">
        {/* Left: list panel */}
        <div className="w-48 shrink-0">
          <div className="border border-gray-300 rounded overflow-hidden mb-2">
            <div className="text-[11px] font-bold text-white px-2 py-1" style={{ backgroundColor: "#003366" }}>
              My Watch Lists
            </div>
            {lists.length === 0 && (
              <div className="px-2 py-2 text-xs text-gray-500">No lists yet.</div>
            )}
            {lists.map((wl) => (
              <div
                key={wl.id}
                className="flex items-center justify-between px-2 py-1 hover:bg-blue-50 cursor-pointer text-xs"
                style={{ backgroundColor: selected?.id === wl.id ? "#e8f0fe" : undefined }}
                onClick={() => setSelected(wl)}
              >
                <span style={{ color: "#003399", fontWeight: selected?.id === wl.id ? "bold" : "normal" }}>
                  {wl.name}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteList(wl); }}
                  className="text-red-400 hover:text-red-600 ml-1"
                >×</button>
              </div>
            ))}
          </div>
          {/* Create new list */}
          <div className="flex gap-1">
            <input
              className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 min-w-0"
              placeholder="New list name"
              value={newList}
              onChange={(e) => setNewList(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createList()}
            />
            <button
              onClick={createList}
              className="px-2 py-1 text-xs text-white rounded"
              style={{ backgroundColor: "#003366" }}
            >+</button>
          </div>
        </div>

        {/* Right: stocks panel */}
        <div className="flex-1">
          {!selected ? (
            <div className="text-xs text-gray-500 mt-4">Select or create a watch list.</div>
          ) : (
            <div className="border border-gray-300 rounded overflow-hidden">
              <div className="text-[11px] font-bold text-white px-2 py-1 flex items-center justify-between" style={{ backgroundColor: "#003366" }}>
                <span>{selected.name}</span>
                <span>{stocks.length} stocks</span>
              </div>

              {/* Add stock */}
              <div className="flex gap-2 p-2 border-b border-gray-200 bg-[#f8fbff]">
                <input
                  className="border border-gray-300 rounded px-2 py-1 text-xs w-32"
                  placeholder="Symbol (e.g. AAPL)"
                  value={newSymbol}
                  onChange={(e) => setNewSymbol(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addStock()}
                />
                <button
                  onClick={addStock}
                  className="px-3 py-1 text-xs text-white rounded"
                  style={{ backgroundColor: "#003366" }}
                >Add Symbol</button>
              </div>

              {stocks.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-500">No symbols in this list.</div>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-100 text-left">
                      <th className="border border-gray-200 px-2 py-1">Symbol</th>
                      <th className="border border-gray-200 px-2 py-1">Date Added</th>
                      <th className="border border-gray-200 px-2 py-1 w-12">Remove</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stocks.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="border border-gray-200 px-2 py-1 font-semibold" style={{ color: "#003399" }}>{s.symbol}</td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-500">
                          {new Date(s.added_at).toLocaleDateString()}
                        </td>
                        <td className="border border-gray-200 px-2 py-1 text-center">
                          <button onClick={() => removeStock(s.id)} className="text-red-400 hover:text-red-600">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
