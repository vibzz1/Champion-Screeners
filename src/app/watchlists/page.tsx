"use client";
import { useEffect, useState, useCallback } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Watchlist { id: number; name: string }
interface Stock { id: number; symbol: string; added_at: string }
interface Quote { price: number | null; change_pct: number | null; rsi: number | null; exchange: string }

export default function WatchlistsPage() {
  const [lists,      setLists]      = useState<Watchlist[]>([]);
  const [selected,   setSelected]   = useState<Watchlist | null>(null);
  const [stocks,     setStocks]     = useState<Stock[]>([]);
  const [quotes,     setQuotes]     = useState<Record<string, Quote>>({});
  const [newList,    setNewList]    = useState("");
  const [newSymbol,  setNewSymbol]  = useState("");
  const [error,      setError]      = useState("");
  const [loadingQ,   setLoadingQ]   = useState(false);

  async function loadLists() {
    try {
      const r = await fetch(`${API}/api/watchlists`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setLists(data);
      setError("");
      if (data.length && !selected) setSelected(data[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Cannot connect to backend."); }
  }

  const fetchQuotes = useCallback(async (syms: string[]) => {
    if (!syms.length) return;
    setLoadingQ(true);
    try {
      const r = await fetch(`${API}/api/screener/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
      if (r.ok) setQuotes(await r.json());
    } catch {}
    finally { setLoadingQ(false); }
  }, []);

  async function loadStocks(wl: Watchlist) {
    const r = await fetch(`${API}/api/watchlists/${wl.id}/stocks`);
    const data: Stock[] = await r.json();
    setStocks(data);
    setQuotes({});
    fetchQuotes(data.map(s => s.symbol));
  }

  useEffect(() => { loadLists(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected) loadStocks(selected); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (selected?.id === wl.id) { setSelected(null); setStocks([]); setQuotes({}); }
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

  const totalPnl = stocks.length
    ? stocks.reduce((sum, s) => sum + (quotes[s.symbol]?.change_pct ?? 0), 0) / stocks.length
    : null;

  return (
    <div className="mob-page-pad md:p-0">
      <h2 className="text-lg font-bold mb-3" style={{ color: "var(--mio-accent)" }}>Watch Lists</h2>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 mb-4 px-4 py-3 rounded-xl border text-xs"
          style={{ backgroundColor: "var(--mio-dn-bg)", borderColor: "var(--mio-dn)", color: "var(--mio-dn)" }}>
          <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.5" fill="currentColor"/>
          </svg>
          <div className="flex-1">
            <div className="font-semibold mb-0.5">Backend offline</div>
            <div style={{ color: "var(--mio-text2)" }}>{error}</div>
          </div>
          <button onClick={loadLists} className="shrink-0 px-2.5 py-1 rounded border text-[10px] font-semibold"
            style={{ borderColor: "var(--mio-dn)", color: "var(--mio-dn)" }}>↺ Retry</button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4">
        {/* ── Left: list panel ─────────────────────────────────────────── */}
        <div className="w-full sm:w-52 shrink-0">
          <div className="border border-gray-200 rounded-xl overflow-hidden mb-2 bg-white" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 py-2 bg-gray-50 border-b border-gray-100">
              My Watch Lists
            </div>
            {lists.length === 0 && (
              <div className="px-3 py-3 text-xs text-gray-400">No lists yet.</div>
            )}
            {lists.map(wl => {
              const isSel = selected?.id === wl.id;
              return (
                <div key={wl.id}
                  className="flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs border-b border-gray-100 last:border-0 transition-colors"
                  style={{
                    backgroundColor: isSel ? "var(--mio-sort-bg)" : undefined,
                    boxShadow:       isSel ? "inset 3px 0 0 var(--mio-accent)" : undefined,
                  }}
                  onClick={() => setSelected(wl)}>
                  <span style={{ color: isSel ? "var(--mio-sort-c)" : "var(--mio-ticker)", fontWeight: isSel ? 600 : 400 }}>
                    {wl.name}
                  </span>
                  <button onClick={e => { e.stopPropagation(); deleteList(wl); }}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-1 text-base leading-none">×</button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-1">
            <input
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs flex-1 min-w-0 bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-all"
              placeholder="New list name"
              value={newList}
              onChange={e => setNewList(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createList()}
            />
            <button onClick={createList}
              className="px-2.5 py-1 text-xs text-white rounded-lg font-semibold transition-opacity hover:opacity-90"
              style={{ backgroundColor: "var(--mio-accent)" }}>+</button>
          </div>
        </div>

        {/* ── Right: stocks panel ──────────────────────────────────────── */}
        <div className="flex-1">
          {!selected ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              <div className="text-sm font-medium text-gray-500">Select or create a watch list</div>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden bg-white" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {/* Header */}
              <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-2 text-xs bg-white border-b border-gray-100">
                <span className="font-bold tracking-tight" style={{ color: "var(--mio-accent)", fontSize: 14 }}>{selected.name}</span>
                <div className="flex items-center gap-2">
                  {totalPnl !== null && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums leading-none"
                      style={{
                        color:           totalPnl >= 0 ? "var(--mio-up)" : "var(--mio-dn)",
                        backgroundColor: totalPnl >= 0 ? "var(--mio-up-bg)" : "var(--mio-dn-bg)",
                      }}>
                      avg {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}% today
                    </span>
                  )}
                  <span className="text-gray-400">{stocks.length} stock{stocks.length !== 1 ? "s" : ""}</span>
                  {loadingQ && <span className="text-gray-300 text-[10px]">loading prices…</span>}
                </div>
              </div>

              {/* Add stock */}
              <div className="flex gap-2 p-2 border-b border-gray-100 bg-slate-50">
                <input
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-40 bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-all"
                  placeholder="Symbol (e.g. RELIANCE)"
                  value={newSymbol}
                  onChange={e => setNewSymbol(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addStock()}
                />
                <button onClick={addStock}
                  className="px-3 py-1 text-xs text-white rounded-lg font-semibold transition-opacity hover:opacity-90"
                  style={{ backgroundColor: "var(--mio-accent)" }}>
                  + Add
                </button>
                <button onClick={() => selected && loadStocks(selected)}
                  title="Refresh prices"
                  className="px-2.5 py-1 text-xs border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                  ↺
                </button>
              </div>

              {stocks.length === 0 ? (
                <div className="px-3 py-6 text-xs text-gray-400 text-center">
                  No symbols yet — add one above.
                </div>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-left text-[11px] text-gray-500 font-semibold border-b border-gray-200">
                      <th className="px-3 py-1.5">Symbol</th>
                      <th className="px-3 py-1.5 text-right">Price</th>
                      <th className="px-3 py-1.5 text-right">Chg %</th>
                      <th className="px-3 py-1.5 text-right">RSI</th>
                      <th className="px-3 py-1.5 text-gray-400">Exchange</th>
                      <th className="px-3 py-1.5 text-gray-400">Added</th>
                      <th className="px-1 py-1.5 w-8"/>
                    </tr>
                  </thead>
                  <tbody>
                    {stocks.map(s => {
                      const q = quotes[s.symbol];
                      const up = (q?.change_pct ?? 0) >= 0;
                      const rsiCol = !q?.rsi ? "var(--mio-text3)" : q.rsi > 70 ? "var(--mio-dn)" : q.rsi < 30 ? "var(--mio-up)" : "var(--mio-text)";
                      return (
                        <tr key={s.id} className="hover:bg-slate-50 border-b border-gray-100 last:border-0 transition-colors">
                          <td className="px-3 py-1.5 font-bold" style={{ color: "var(--mio-ticker)" }}>{s.symbol}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-700">
                            {q?.price != null ? q.price.toLocaleString() : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold"
                            style={{ color: q?.change_pct != null ? (up ? "var(--mio-up)" : "var(--mio-dn)") : "var(--mio-text3)" }}>
                            {q?.change_pct != null ? `${up ? "+" : ""}${q.change_pct}%` : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {q?.rsi != null
                              ? <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold"
                                  style={{ color: rsiCol, backgroundColor: q.rsi > 70 ? "var(--mio-dn-bg)" : q.rsi < 30 ? "var(--mio-up-bg)" : "var(--mio-neutral-bg)" }}>
                                  {q.rsi}
                                </span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-gray-400 text-[10px]">{q?.exchange ?? "—"}</td>
                          <td className="px-3 py-1.5 text-gray-400">
                            {new Date(s.added_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                          </td>
                          <td className="px-1 py-1.5 text-center">
                            <button onClick={() => removeStock(s.id)}
                              className="text-gray-300 hover:text-red-500 transition-colors text-base leading-none">×</button>
                          </td>
                        </tr>
                      );
                    })}
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
