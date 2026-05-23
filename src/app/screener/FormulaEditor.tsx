"use client";
import { useState, useRef } from "react";
import type { SavedScreener } from "./types";
import { EXCHANGES, CHIPS } from "./constants";
import { uid } from "./helpers";

export function FormulaEditor({
  initial, onRun, onSave, onCancel,
}: {
  initial: SavedScreener | null;
  onRun:    (s: SavedScreener) => void;
  onSave:   (s: SavedScreener) => void;
  onCancel: () => void;
}) {
  const blank: SavedScreener = { id: uid(), name: "", exchange: "NSE", formula: "" };
  const [form, setForm] = useState<SavedScreener>(initial ?? blank);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function appendChip(chip: string) {
    setForm(f => {
      const cur = f.formula.trim();
      return { ...f, formula: cur ? `${cur} and ${chip}` : chip };
    });
    taRef.current?.focus();
  }

  const canSave = form.name.trim().length > 0 && form.formula.trim().length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6" style={{background:"#f6f7fb"}}>
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-gray-800 tracking-tight">
            {initial ? "Edit Screen" : "New Setup Scan"}
          </h2>
          <button onClick={onCancel}
            className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors text-base">
            ✕
          </button>
        </div>

        {/* Name + Exchange */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-3 flex flex-wrap gap-4 items-end shadow-sm">
          <div className="flex-1 min-w-40">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Screen Name</label>
            <input
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
              placeholder="e.g. Momentum Stocks"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Exchange</label>
            <select
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
              value={form.exchange}
              onChange={e => setForm(f => ({ ...f, exchange: e.target.value }))}>
              {EXCHANGES.map(ex => <option key={ex}>{ex}</option>)}
            </select>
          </div>
        </div>

        {/* Formula textarea */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-3 shadow-sm">
          <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Formula Expression</label>
          <textarea
            ref={taRef}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono bg-gray-50 resize-y focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:bg-white transition-all"
            rows={5}
            placeholder="rsi > 60 and macd = bullish and price > sma(50) and sma(50) > sma(200)"
            value={form.formula}
            onChange={e => setForm(f => ({ ...f, formula: e.target.value }))}
            spellCheck={false}
          />
          <p className="text-[10px] text-gray-400 mt-1.5">
            Separate conditions with <code className="bg-gray-100 px-1 rounded font-mono">and</code>. All conditions must pass (AND logic). Paste MIO formulas directly — unsupported clauses are skipped.
          </p>
        </div>

        {/* Quick add chips */}
        <div className="mb-4">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Quick add</div>
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map(chip => (
              <button key={chip} onClick={() => appendChip(chip)}
                className="px-2.5 py-0.5 rounded-full border border-gray-200 text-[11px] font-mono text-gray-500 bg-white hover:bg-blue-50 hover:border-blue-400 hover:text-blue-700 transition-all shadow-sm">
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Syntax reference */}
        <details className="mb-5">
          <summary className="text-[11px] text-gray-400 cursor-pointer hover:text-gray-600 select-none font-medium">Syntax reference ▸</summary>
          <div className="mt-2 text-[11px] font-mono bg-white border border-gray-200 rounded-xl p-3 text-gray-600 space-y-0.5 leading-relaxed shadow-sm">
            <div className="text-gray-400 text-[10px] not-italic font-sans mb-1 font-semibold uppercase tracking-wide">── Indicators ──</div>
            <div><span className="text-blue-600">rsi &gt; 60</span> · <span className="text-blue-600">rsi &lt; 30</span></div>
            <div><span className="text-blue-600">macd = bullish</span> · <span className="text-blue-600">macd = bearish</span></div>
            <div><span className="text-blue-600">price &gt; sma(20|50|200)</span> · <span className="text-blue-600">sma(10) &gt; sma(20)</span> · <span className="text-blue-600">sma(50) &gt; sma(200)</span></div>
            <div><span className="text-blue-600">price &gt; ema(20|50)</span> · <span className="text-blue-600">ema(20) &gt; ema(50)</span></div>
            <div><span className="text-blue-600">price &gt; bb_upper</span> · <span className="text-blue-600">price &lt; bb_lower</span> · <span className="text-blue-600">price near bb_upper</span></div>
            <div><span className="text-blue-600">near_52h &lt; 5</span> · <span className="text-blue-600">near_52l &lt; 20</span> · <span className="text-blue-600">new_52w_high</span></div>
            <div><span className="text-blue-600">change &gt; 2</span> · <span className="text-blue-600">change &lt; -2</span> · <span className="text-blue-600">volume &gt; 1000000</span></div>
            <div><span className="text-blue-600">price &gt; 100</span> · <span className="text-blue-600">price &lt; 500</span></div>
            <div className="text-gray-400 text-[10px] not-italic font-sans mt-2 mb-1 font-semibold uppercase tracking-wide">── MIO formula syntax (paste directly) ──</div>
            <div><span className="text-purple-600">advol(20) &gt; 50</span> <span className="text-gray-400">= avg daily vol &gt; 50K shares</span></div>
            <div><span className="text-purple-600">price &gt; c[1]</span> <span className="text-gray-400">= positive day (close &gt; prev close)</span></div>
            <div><span className="text-purple-600">atr(1) &gt; atr(20) * 0.6</span> <span className="text-gray-400">= active candle (range vs avg)</span></div>
            <div><span className="text-purple-600">price &gt; low + ((high - low) * 0.4)</span> <span className="text-gray-400">= closed in upper 60% of range</span></div>
            <div className="text-gray-400 text-[10px] not-italic font-sans mt-1">exch(), trend_dn, trend_up, !negation → auto-skipped</div>
          </div>
        </details>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button onClick={() => canSave && onRun(form)} disabled={!canSave}
            className="flex-1 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-1.5 shadow-sm transition-opacity"
            style={{ backgroundColor: "#003366" }}>
            ▶ Run Screen
          </button>
          <button onClick={() => canSave && onSave(form)} disabled={!canSave}
            className="px-5 py-2 rounded-lg text-sm font-semibold border disabled:opacity-40 transition-colors hover:bg-blue-50"
            style={{ borderColor: "#003366", color: "#003366", backgroundColor: "white" }}>
            Save
          </button>
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-100 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
