"use client";
import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const EXCHANGES = ["NSE", "BSE", "SP500", "NASDAQ", "NYSE"];
const PAGE_SIZES = [20, 50, 100];
const LS_KEY = "mio_screeners_v5";

const CAP_COLORS: Record<string, string> = {
  Mega: "#7c3aed", Large: "#1d4ed8", Mid: "#0f766e", Small: "#92400e",
};

// ── Types ──────────────────────────────────────────────────────────────────
interface SavedScreener {
  id: string;
  name: string;
  exchange: string;
  formula: string;
  interval?: string;   // "1d" (default) | "75min" (NSE/BSE) | "78min" (US)
}

interface OHLCV {
  date: string; open: number; high: number; low: number; close: number; volume: number;
  sma20?: number | null; sma50?: number | null;
}
interface Result {
  symbol: string; ticker: string; name: string; sector: string; industry: string;
  cap_size: string; market_cap: number | null;
  price: number; change_pct: number; volume: number;
  sma20: number | null; sma50: number | null; sma200: number | null;
  rsi: number | null; macd_bullish: boolean;
  high_52w: number | null; pct_from_52w_high: number | null; new_52w_high: boolean;
  sparkline: number[]; ohlcv: OHLCV[];
}

// ── Default screeners ──────────────────────────────────────────────────────
const DEFAULTS: SavedScreener[] = [
  { id: "d1", name: "India Setup Scan", exchange: "NSE",   formula: "advol(20) > 50 and advol(50) > 50 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)\n\nadvol(20) > 20 and price > 10 and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d2", name: "NPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_dn 1" },
  { id: "d3", name: "PPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (price > sma(100) or price > sma(200)) and (pgo(50) < 4 or pgo(20) < 4) and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_up 1" },
  { id: "d4", name: "US Setup Scan",        exchange: "SP500", formula: "advol(20) > 200 and advol(50) > 200 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)\n\nadvol(20) > 50 and price > 5 and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d5", name: "India Setup Scan 75m", exchange: "NSE",   interval: "75min", formula: "advol(20) > 30 and advol(50) > 30 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)\n\nadvol(20) > 10 and price > 10 and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d6", name: "US Setup Scan 78m",    exchange: "SP500", interval: "78min", formula: "advol(20) > 100 and advol(50) > 100 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)\n\nadvol(20) > 30 and price > 5 and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
];

// ── Quick-add chips ────────────────────────────────────────────────────────
const CHIPS = [
  "rsi > 60", "rsi < 30", "rsi > 50 and rsi < 70",
  "macd = bullish", "macd = bearish",
  "price > sma(20)", "price > sma(50)", "price > sma(200)",
  "sma(20) > sma(50)", "sma(50) > sma(200)",
  "near_52h < 5", "near_52h < 10", "new_52w_high",
  "change > 2", "change < -2",
  "volume > 1000000",
  "price > ema(20)", "ema(20) > ema(50)",
  "price > bb_upper", "price < bb_lower",
];

// ── Interactive candlestick chart with SMA20/50, volume, zoom + pan ────────
function InteractiveChart({ data, masterBars, priceHeight = 230 }: { data: OHLCV[]; masterBars?: number; priceHeight?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [w, setW]            = useState(800);
  const [visibleBars, setVB] = useState(Math.min(masterBars ?? 69, data.length));

  // Sync to master zoom when it changes
  useEffect(() => {
    if (masterBars != null) setVB(Math.min(masterBars, data.length));
  }, [masterBars, data.length]);
  const [rightOffset, setRO] = useState(0);
  const [showSma50, setS50]  = useState(false);
  const drag = useRef<{ startX: number; startRO: number } | null>(null);

  // Layout constants
  const PRICE_H = priceHeight;  // height of price panel — controlled by parent
  const VOL_H   = 52;           // height of volume panel
  const GAP     = 6;     // gap between panels
  const PAD = { t: 8, b: 22, l: 6, r: 58 };
  const TOTAL_H = PAD.t + PRICE_H + GAP + VOL_H + PAD.b;
  const VOL_TOP = PAD.t + PRICE_H + GAP;  // y-start of volume panel

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(e => setW(e[0].contentRect.width));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const total   = data.length;
  const end     = Math.max(visibleBars, total - rightOffset);
  const start   = Math.max(0, end - visibleBars);
  const visible = data.slice(start, Math.min(end, total));

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const step = Math.max(1, Math.round(visibleBars * 0.08));
    setVB(v => Math.min(total, Math.max(10, e.deltaY > 0 ? v + step : v - step)));
  }
  function onMouseDown(e: React.MouseEvent) {
    drag.current = { startX: e.clientX, startRO: rightOffset };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!drag.current) return;
    const pxPerBar = (w - PAD.l - PAD.r) / visibleBars;
    const barsDelta = Math.round((e.clientX - drag.current.startX) / pxPerBar);
    setRO(Math.max(0, Math.min(total - visibleBars, drag.current.startRO - barsDelta)));
  }
  function onMouseUp() { drag.current = null; }

  if (!visible.length)
    return <div className="flex items-center justify-center text-gray-300 text-xs" style={{ height: TOTAL_H }}>No chart data</div>;

  const W = w - PAD.l - PAD.r;

  // ── Price panel geometry ───────────────────────────────────────────────────
  const prices = visible.flatMap(d => [d.high, d.low]);
  const smaSeries = [
    ...visible.map(d => d.sma20).filter((v): v is number => v != null),
    ...(showSma50 ? visible.map(d => d.sma50).filter((v): v is number => v != null) : []),
  ];
  const maxP = Math.max(...prices, ...smaSeries);
  const minP = Math.min(...prices, ...smaSeries);
  const rng  = maxP - minP || 1;
  const sy   = (p: number) => PAD.t + PRICE_H - ((p - minP) / rng) * PRICE_H;

  // ── Volume panel geometry ─────────────────────────────────────────────────
  const vols  = visible.map(d => d.volume);
  const maxV  = Math.max(...vols) || 1;
  // bar grows upward from bottom of volume panel
  const volBarH = (v: number) => Math.max(1, (v / maxV) * VOL_H);
  const volBarY = (v: number) => VOL_TOP + VOL_H - volBarH(v);

  // ── Shared slot geometry ──────────────────────────────────────────────────
  const slotW = W / visible.length;
  const bodyW = Math.max(1, slotW * 0.65);
  const cx    = (i: number) => PAD.l + (i + 0.5) * slotW;

  // Price axis ticks
  const priceTicks = Array.from({ length: 5 }, (_, i) => minP + (rng / 4) * i);

  // Volume axis: 2 labels (0 + max)
  function fmtV(v: number) {
    return v >= 1_000_000 ? `${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v/1_000).toFixed(0)}K` : `${v}`;
  }

  // SMA polylines — skip null gaps
  function smaPolyline(key: "sma20" | "sma50") {
    const segments: string[][] = [];
    let seg: string[] = [];
    visible.forEach((d, i) => {
      const v = d[key];
      if (v != null) { seg.push(`${cx(i).toFixed(1)},${sy(v).toFixed(1)}`); }
      else { if (seg.length > 1) segments.push(seg); seg = []; }
    });
    if (seg.length > 1) segments.push(seg);
    return segments;
  }

  const sma20segs = smaPolyline("sma20");
  const sma50segs = showSma50 ? smaPolyline("sma50") : [];

  return (
    <div ref={containerRef} className="w-full select-none"
      style={{ cursor: drag.current ? "grabbing" : "crosshair" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
      <svg width={w} height={TOTAL_H} style={{ display: "block" }}>

        {/* ── Price panel ── */}
        {/* Divider between panels */}
        <line x1={PAD.l} y1={VOL_TOP - 1} x2={PAD.l + W} y2={VOL_TOP - 1} stroke="#e5e7eb" strokeWidth={0.5}/>

        {/* Price grid + axis labels */}
        {priceTicks.map((p, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={sy(p)} x2={PAD.l + W} y2={sy(p)} stroke="#f0f0f0" strokeWidth={0.5}/>
            <text x={PAD.l + W + 4} y={sy(p) + 3} fontSize={9} fill="#bbb">
              {p >= 1000 ? `${(p/1000).toFixed(1)}k` : p.toFixed(p < 10 ? 2 : 0)}
            </text>
          </g>
        ))}

        {/* Candles */}
        {visible.map((bar, i) => {
          const bull = bar.close >= bar.open;
          const col  = bull ? "#16a34a" : "#dc2626";
          const by1  = sy(Math.max(bar.open, bar.close));
          const by2  = sy(Math.min(bar.open, bar.close));
          return (
            <g key={i}>
              <line x1={cx(i)} y1={sy(bar.high)} x2={cx(i)} y2={sy(bar.low)} stroke={col} strokeWidth={0.8}/>
              <rect x={cx(i) - bodyW/2} y={by1} width={bodyW} height={Math.max(1, by2 - by1)}
                fill={col} opacity={0.88}/>
            </g>
          );
        })}

        {/* SMA20 */}
        {sma20segs.map((pts, i) => (
          <polyline key={i} points={pts.join(" ")} fill="none" stroke="#f97316" strokeWidth={1.5} opacity={0.9}/>
        ))}
        {/* SMA50 */}
        {sma50segs.map((pts, i) => (
          <polyline key={i} points={pts.join(" ")} fill="none" stroke="#3b82f6" strokeWidth={1.5} opacity={0.9}/>
        ))}

        {/* ── Volume panel ── */}
        {/* "Vol" label */}
        <text x={PAD.l + 3} y={VOL_TOP + 10} fontSize={8} fill="#bbb">Vol</text>
        {/* Max volume label */}
        <text x={PAD.l + W + 4} y={VOL_TOP + 10} fontSize={8} fill="#bbb">{fmtV(maxV)}</text>
        {/* Mid volume label */}
        <text x={PAD.l + W + 4} y={VOL_TOP + VOL_H/2 + 3} fontSize={8} fill="#bbb">{fmtV(maxV/2)}</text>
        {/* Mid grid line */}
        <line x1={PAD.l} y1={VOL_TOP + VOL_H/2} x2={PAD.l + W} y2={VOL_TOP + VOL_H/2} stroke="#f0f0f0" strokeWidth={0.5}/>

        {/* Volume bars */}
        {visible.map((bar, i) => {
          const bull = bar.close >= bar.open;
          const col  = bull ? "#16a34a" : "#dc2626";
          const bh   = volBarH(bar.volume);
          const by   = volBarY(bar.volume);
          return (
            <rect key={i}
              x={cx(i) - bodyW/2} y={by} width={bodyW} height={bh}
              fill={col} opacity={0.55}/>
          );
        })}

        {/* ── Bottom labels ── */}
        <text x={PAD.l + 4} y={TOTAL_H - 6} fontSize={9} fill="#bbb">
          {visible[0]?.date?.split(" ")[0]} – {visible[visible.length - 1]?.date}
        </text>
        <text x={PAD.l + W} y={TOTAL_H - 6} fontSize={9} fill="#bbb" textAnchor="end">
          {visible.length}d
        </text>
      </svg>

      {/* Controls */}
      <div className="flex items-center gap-3 px-3 pb-1 text-[10px] text-gray-400">
        <span>scroll=zoom · drag=pan</span>

        {/* Zoom buttons */}
        <div className="flex items-center border border-gray-200 rounded overflow-hidden">
          <button
            onClick={() => setVB(v => Math.min(total, Math.max(10, v + Math.max(1, Math.round(v * 0.1)))))}
            className="px-2 py-0.5 hover:bg-gray-100 text-gray-500 font-bold text-sm leading-none border-r border-gray-200"
            title="Zoom out">−</button>
          <button
            onClick={() => setVB(v => Math.min(total, Math.max(10, v - Math.max(1, Math.round(v * 0.1)))))}
            className="px-2 py-0.5 hover:bg-gray-100 text-gray-500 font-bold text-sm leading-none"
            title="Zoom in">+</button>
        </div>

        <button onClick={() => setS50(v => !v)}
          className="ml-auto px-2 py-0.5 rounded border text-[10px]"
          style={{ borderColor: showSma50 ? "#3b82f6" : "#e5e7eb", color: showSma50 ? "#3b82f6" : "#aaa", backgroundColor: showSma50 ? "#eff6ff" : "white" }}>
          SMA50
        </button>
        <span className="inline-flex items-center gap-1">
          <span style={{ width: 16, borderTop: "2px solid #f97316", display: "inline-block" }}/>SMA20
          {showSma50 && <><span style={{ width: 16, borderTop: "2px solid #3b82f6", display: "inline-block", marginLeft: 6 }}/>SMA50</>}
        </span>
      </div>
    </div>
  );
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data||data.length<2) return null;
  const mn=Math.min(...data), mx=Math.max(...data), rng=mx-mn||1;
  const w=80, h=32, pad=2;
  const pts=data.map((v,i)=>`${pad+(i/(data.length-1))*(w-pad*2)},${h-pad-((v-mn)/rng)*(h-pad*2)}`).join(" ");
  return <svg width={w} height={h} style={{display:"block"}}><polyline points={pts} fill="none" stroke={positive?"#16a34a":"#dc2626"} strokeWidth={1.4}/></svg>;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2,9);

function fmtCap(cap: number|null, exchange: string) {
  if(cap==null) return "—";
  const indian = exchange==="NSE"||exchange==="BSE";
  if(indian){ if(cap>=100000) return `₹${(cap/100000).toFixed(1)}L Cr`; if(cap>=1000) return `₹${(cap/1000).toFixed(0)}K Cr`; return `₹${cap} Cr`; }
  if(cap>=1000000) return `$${(cap/1000000).toFixed(1)}T`; if(cap>=1000) return `$${(cap/1000).toFixed(0)}B`; return `$${cap}M`;
}
function fmtVol(v: number) { return v>=1_000_000?`${(v/1_000_000).toFixed(1)}M`:v>=1000?`${(v/1000).toFixed(0)}K`:`${v}`; }

function fmtEarnings(dateStr: string): string {
  if(!dateStr) return "—";
  const d = new Date(dateStr.replace(/-/g," "));
  if(isNaN(d.getTime())) return dateStr;
  const mon=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${mon[d.getMonth()]}`;
}
function earningsColor(dateStr: string): string {
  if(!dateStr) return "#9ca3af";
  const d = new Date(dateStr.replace(/-/g," "));
  if(isNaN(d.getTime())) return "#374151";
  const days = Math.ceil((d.getTime()-Date.now())/86400000);
  return days<=14 ? "#d97706" : "#374151";
}

// ── Formula Editor ─────────────────────────────────────────────────────────
function FormulaEditor({
  initial, onRun, onSave, onCancel,
}: {
  initial: SavedScreener | null;
  onRun:   (s: SavedScreener) => void;
  onSave:  (s: SavedScreener) => void;
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
    <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold text-gray-800">
            {initial ? "Edit Screen" : "New Setup Scan"}
          </h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>

        {/* Name + Exchange */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-40">
            <label className="block text-xs font-semibold text-gray-500 mb-1">Screen Name</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm bg-white"
              placeholder="e.g. Momentum Stocks"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Exchange</label>
            <select
              className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white"
              value={form.exchange}
              onChange={e => setForm(f => ({ ...f, exchange: e.target.value }))}>
              {EXCHANGES.map(ex => <option key={ex}>{ex}</option>)}
            </select>
          </div>
        </div>

        {/* Formula textarea */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <label className="block text-xs font-semibold text-gray-500 mb-2">Formula Expression</label>
          <textarea
            ref={taRef}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono bg-white resize-y"
            rows={5}
            placeholder={`rsi > 60 and macd = bullish and price > sma(50) and sma(50) > sma(200)`}
            value={form.formula}
            onChange={e => setForm(f => ({ ...f, formula: e.target.value }))}
            spellCheck={false}
          />
          <p className="text-[10px] text-gray-400 mt-1">
            Separate conditions with <code className="bg-gray-100 px-1 rounded">and</code>. All conditions must pass (AND logic). Paste MIO formulas directly — unsupported clauses are skipped.
          </p>
        </div>

        {/* Quick-add chips */}
        <div className="mb-5">
          <div className="text-xs font-semibold text-gray-500 mb-2">Quick add →</div>
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map(chip => (
              <button key={chip}
                onClick={() => appendChip(chip)}
                className="px-2 py-0.5 rounded border border-gray-300 text-[11px] font-mono text-gray-600 bg-white hover:bg-blue-50 hover:border-blue-400 hover:text-blue-700 transition-colors">
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Syntax reference */}
        <details className="mb-5">
          <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">
            Syntax reference ▸
          </summary>
          <div className="mt-2 text-[11px] font-mono bg-gray-50 border border-gray-200 rounded p-3 text-gray-600 space-y-0.5 leading-relaxed">
            <div className="text-gray-400 text-[10px] not-italic font-sans mb-1">── Indicators ──</div>
            <div><span className="text-blue-600">rsi &gt; 60</span> · <span className="text-blue-600">rsi &lt; 30</span></div>
            <div><span className="text-blue-600">macd = bullish</span> · <span className="text-blue-600">macd = bearish</span></div>
            <div><span className="text-blue-600">price &gt; sma(20|50|200)</span> · <span className="text-blue-600">sma(10) &gt; sma(20)</span> · <span className="text-blue-600">sma(50) &gt; sma(200)</span></div>
            <div><span className="text-blue-600">price &gt; ema(20|50)</span> · <span className="text-blue-600">ema(20) &gt; ema(50)</span></div>
            <div><span className="text-blue-600">price &gt; bb_upper</span> · <span className="text-blue-600">price &lt; bb_lower</span> · <span className="text-blue-600">price near bb_upper</span></div>
            <div><span className="text-blue-600">near_52h &lt; 5</span> · <span className="text-blue-600">near_52l &lt; 20</span> · <span className="text-blue-600">new_52w_high</span></div>
            <div><span className="text-blue-600">change &gt; 2</span> · <span className="text-blue-600">change &lt; -2</span> · <span className="text-blue-600">volume &gt; 1000000</span></div>
            <div><span className="text-blue-600">price &gt; 100</span> · <span className="text-blue-600">price &lt; 500</span></div>
            <div className="text-gray-400 text-[10px] not-italic font-sans mt-2 mb-1">── MIO formula syntax (paste directly) ──</div>
            <div><span className="text-purple-600">advol(20) &gt; 50</span> <span className="text-gray-400">= avg daily vol &gt; 50K shares</span></div>
            <div><span className="text-purple-600">price &gt; c[1]</span> <span className="text-gray-400">= positive day (close &gt; prev close)</span></div>
            <div><span className="text-purple-600">atr(1) &gt; atr(20) * 0.6</span> <span className="text-gray-400">= active candle (range vs avg)</span></div>
            <div><span className="text-purple-600">price &gt; low + ((high - low) * 0.4)</span> <span className="text-gray-400">= closed in upper 60% of range</span></div>
            <div className="text-gray-400 text-[10px] not-italic font-sans mt-1">exch(), trend_dn, trend_up, !negation → auto-skipped</div>
          </div>
        </details>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={() => canSave && onRun(form)}
            disabled={!canSave}
            className="flex-1 py-2 rounded text-white text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-1"
            style={{ backgroundColor: "#003366" }}>
            ▶ Run Screen
          </button>
          <button
            onClick={() => canSave && onSave(form)}
            disabled={!canSave}
            className="px-5 py-2 rounded text-sm font-semibold border disabled:opacity-40"
            style={{ borderColor: "#003366", color: "#003366", backgroundColor: "white" }}>
            Save
          </button>
          <button onClick={onCancel}
            className="px-4 py-2 rounded border border-gray-300 text-sm text-gray-500 hover:bg-gray-100">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function ScreenerPage() {
  const [screeners, setScreeners]   = useState<SavedScreener[]>([]);
  const [editing, setEditing]       = useState<SavedScreener | null | "new">(null);
  const [active, setActive]         = useState<SavedScreener | null>(null);
  const [results, setResults]       = useState<Result[]>([]);
  const [loading, setLoading]       = useState(false);
  const [masterZoom, setMasterZoom] = useState(69); // shared bars-visible for all charts
  const [error, setError]           = useState("");
  const [warning, setWarning]       = useState("");
  const [view, setView]             = useState<"overview"|"charts">("overview");
  const [sortKey, setSortKey]       = useState("change_pct");
  const [sortDir, setSortDir]       = useState<"asc"|"desc">("desc");
  const [page, setPage]             = useState(1);
  const [sectorFilter, setSF]       = useState("All");
  const [capFilter, setCF]          = useState("All");
  const [pageSize, setPageSize]     = useState(20);
  const [asOfDate, setAsOfDate]      = useState("");
  const [isLive, setIsLive]          = useState(false);
  const [favorites, setFavorites]    = useState<Record<string, Result>>({});
  const [showFavorites, setShowFavorites] = useState(false);
  const [favView, setFavView]        = useState<"overview"|"charts">("overview");
  const [earnings, setEarnings]      = useState<Record<string, string>>({});
  const [resultSearch, setRS]        = useState("");
  const [chartSize, setChartSize]    = useState<"sm"|"md"|"lg">("md");
  const [sidebarOpen, setSBO]        = useState(true);
  const FAV_KEY = "mio_favorites_v1";
  const resultsRef = useRef<HTMLDivElement>(null);
  const CHART_H: Record<string, number> = { sm: 160, md: 230, lg: 380 };

  // ── Persistence ──────────────────────────────────────────────────────────
  // Built-ins (d1–d6) always come from DEFAULTS in code — never from localStorage.
  // localStorage only stores user-created custom screeners (non-"d" prefix IDs).
  const DEFAULT_IDS = new Set(DEFAULTS.map(d => d.id));

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const saved: SavedScreener[] = raw ? JSON.parse(raw) : [];
      // Keep only user-created screeners (not built-ins)
      const custom = saved.filter(s => !DEFAULT_IDS.has(s.id));
      setScreeners([...DEFAULTS, ...custom]);
    } catch { setScreeners(DEFAULTS); }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavorites(JSON.parse(raw));
    } catch {}
  }, []);

  function toggleFavorite(r: Result) {
    setFavorites(prev => {
      const next = { ...prev };
      if (next[r.ticker]) delete next[r.ticker];
      else next[r.ticker] = r;
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
      return next;
    });
  }

  function persist(list: SavedScreener[]) {
    setScreeners(list);
    // Only persist custom screeners; built-ins always loaded fresh from code
    const custom = list.filter(s => !DEFAULT_IDS.has(s.id));
    localStorage.setItem(LS_KEY, JSON.stringify(custom));
  }

  function saveScreener(s: SavedScreener) {
    const exists = screeners.find(x => x.id === s.id);
    persist(exists ? screeners.map(x => x.id===s.id ? s : x) : [...screeners, s]);
    setEditing(null);
  }

  function deleteScreener(id: string) {
    if (!confirm("Delete this screen?")) return;
    persist(screeners.filter(x => x.id !== id));
    if (active?.id === id) { setActive(null); setResults([]); }
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  const runScreen = useCallback(async (s: SavedScreener, histDate: string = "") => {
    setActive(s);
    setEditing(null);
    setShowFavorites(false);
    setLoading(true);
    setError("");
    setWarning("");
    setResults([]);
    setIsLive(false);
    setPage(1);
    setSF("All");
    setCF("All");
    try {
      const res = await fetch(`${API}/api/screener/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange: s.exchange, formula: s.formula, interval: s.interval ?? "1d", ...(histDate ? { as_of_date: histDate } : {}) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResults(data.results ?? []);
      setIsLive(data.live ?? false);
      if (data.warning) setWarning(data.warning);
    } catch(e) {
      setError(`Backend error: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleSaveAndRun(s: SavedScreener) {
    saveScreener(s);
    runScreen(s, asOfDate);
  }

  // ── Sort / filter ─────────────────────────────────────────────────────────
  function handleSort(k: string) {
    if(sortKey===k) setSortDir(d=>d==="asc"?"desc":"asc");
    else { setSortKey(k); setSortDir("desc"); }
  }
  const sectors = useMemo(()=>["All",...Array.from(new Set(results.map(r=>r.sector))).sort()],[results]);
  const sorted  = useMemo(()=>[...results].sort((a,b)=>{
    const av=((a as unknown) as Record<string,unknown>)[sortKey];
    const bv=((b as unknown) as Record<string,unknown>)[sortKey];
    const dir = sortDir==="asc" ? 1 : -1;
    if(av==null && bv==null) return 0;
    if(av==null) return 1;
    if(bv==null) return -1;
    if(typeof av==="string" && typeof bv==="string")
      return dir * av.localeCompare(bv);
    return dir * ((av as number) - (bv as number));
  }),[results,sortKey,sortDir]);
  const filtered = useMemo(()=>sorted.filter(r=>{
    if(sectorFilter!=="All"&&r.sector!==sectorFilter) return false;
    if(capFilter!=="All"&&r.cap_size!==capFilter) return false;
    return true;
  }),[sorted,sectorFilter,capFilter]);
  const displayResults = useMemo(()=>{
    const q = resultSearch.trim().toLowerCase();
    return q ? filtered.filter(r=>r.symbol.toLowerCase().includes(q)||r.name.toLowerCase().includes(q)) : filtered;
  },[filtered,resultSearch]);
  const totalPages = Math.max(1, Math.ceil(displayResults.length/pageSize));
  const paged      = displayResults.slice((page-1)*pageSize, page*pageSize);
  useEffect(()=>{setPage(1);},[sectorFilter,capFilter,sortKey,sortDir,pageSize,resultSearch]);
  useEffect(()=>{setPage(1);},[showFavorites]);

  // Sector summary counts from full filtered set (not paged)
  const sectorCounts = useMemo(()=>{
    const m: Record<string,number> = {};
    displayResults.forEach(r=>{ if(r.sector) m[r.sector]=(m[r.sector]||0)+1; });
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  },[displayResults]);
  function goToPage(p: number) {
    (document.activeElement as HTMLElement)?.blur();
    setPage(p);
    // Double rAF: wait for React to commit + browser scroll-anchoring to settle,
    // then force scroll to top. This reliably overrides Chrome's scroll anchoring.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      if (resultsRef.current) resultsRef.current.scrollTop = 0;
    }));
  }

  const favResults   = useMemo(()=>Object.values(favorites),[favorites]);
  const favTotalPages = Math.max(1, Math.ceil(favResults.length/pageSize));
  const favPaged     = favResults.slice((page-1)*pageSize, page*pageSize);

  // Earnings — fetch from NSE for the current visible page only
  const pagedTickers = useMemo(
    ()=>(showFavorites ? favPaged : paged).map(r=>r.ticker).join(","),
    [showFavorites, favPaged, paged]
  );
  useEffect(()=>{
    if(!pagedTickers) return;
    fetch(`${API}/api/screener/earnings?symbols=${encodeURIComponent(pagedTickers)}`)
      .then(r=>r.ok?r.json():{})
      .then(data=>setEarnings(prev=>({...prev,...data})))
      .catch(()=>{});
  },[pagedTickers]);

  function TH({label,k}:{label:string;k:string}) {
    const on=sortKey===k;
    return <th onClick={()=>handleSort(k)}
      className="border border-gray-200 px-2 py-1 cursor-pointer select-none whitespace-nowrap hover:bg-blue-50 text-left"
      style={{backgroundColor:on?"#e8f0fe":undefined}}>
      {label}{on?(sortDir==="asc"?" ▲":" ▼"):""}
    </th>;
  }

  function Pagination({ count, total }: { count: number; total: number }) {
    if(count===0) return null;
    return <div className="flex items-center justify-between px-3 py-2 bg-white text-xs sticky bottom-0 shadow-[0_-4px_12px_rgba(0,0,0,0.07)] border-t border-gray-100">
      <div className="flex items-center gap-2 text-gray-500">
        <span>{(page-1)*pageSize+1}–{Math.min(page*pageSize,count)} of {count}</span>
        <select value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));}}
          className="border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white ml-1">
          {PAGE_SIZES.map(s=><option key={s} value={s}>{s} / page</option>)}
        </select>
      </div>
      {total>1 && <div className="flex gap-1">
        <button onClick={()=>goToPage(Math.max(1,page-1))} disabled={page===1} className="px-2 py-0.5 border border-gray-300 rounded disabled:opacity-40" style={{color:"#003399"}}>◀</button>
        {Array.from({length:Math.min(total,7)},(_,i)=>{
          const p=total<=7?i+1:page<=4?i+1:page>=total-3?total-6+i:page-3+i;
          return <button key={p} onClick={()=>goToPage(p)} className="w-6 h-5 rounded text-center"
            style={{backgroundColor:page===p?"#003366":undefined,color:page===p?"white":"#003399",border:page===p?"none":"1px solid #d1d5db"}}>{p}</button>;
        })}
        <button onClick={()=>goToPage(Math.min(total,page+1))} disabled={page===total} className="px-2 py-0.5 border border-gray-300 rounded disabled:opacity-40" style={{color:"#003399"}}>▶</button>
      </div>}
      <button onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
        className="px-2 py-0.5 border border-gray-300 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-50">↑ Top</button>
    </div>;
  }

  const showEditor = editing !== null;

  return (
    <div className="flex h-full" style={{minHeight:"calc(100vh - 48px)"}}>

      {/* ── Left panel ──────────────────────────────────────────────────── */}
      <div className={`${sidebarOpen?"w-56":"w-8"} shrink-0 border-r border-gray-200 bg-[#f8f9fb] flex flex-col transition-all duration-200 relative`}>
        {/* Collapse toggle */}
        <button onClick={()=>setSBO(v=>!v)}
          className="absolute -right-3 top-4 z-20 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-400 hover:text-gray-700 text-[10px]">
          {sidebarOpen?"◀":"▶"}
        </button>
        {!sidebarOpen && <div className="flex-1"/>}
        {sidebarOpen && <><div className="px-3 py-3 border-b border-gray-200 bg-white space-y-2">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">My Stock Screens</div>
          <button onClick={()=>setEditing("new")}
            className="w-full py-1.5 rounded text-white text-xs font-semibold"
            style={{backgroundColor:"#003366"}}>
            + New Setup Scan
          </button>
          <button
            onClick={()=>setShowFavorites(v=>!v)}
            className="w-full py-1.5 rounded text-xs font-semibold border flex items-center justify-center gap-1"
            style={{
              backgroundColor: showFavorites ? "#fef3c7" : "white",
              borderColor: showFavorites ? "#f59e0b" : "#d1d5db",
              color: showFavorites ? "#b45309" : "#374151",
            }}>
            {showFavorites ? "★" : "☆"} Favorites ({Object.keys(favorites).length})
          </button>
          {/* Historical date picker */}
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Hist Date {asOfDate && <span className="text-amber-500 normal-case font-normal ml-1">← historical</span>}
            </label>
            <div className="flex gap-1">
              <input
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={asOfDate}
                onChange={e => setAsOfDate(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-1.5 py-1 text-[11px] bg-white text-gray-700"
              />
              {asOfDate && (
                <button
                  onClick={() => setAsOfDate("")}
                  className="px-1.5 rounded border border-gray-300 text-gray-400 hover:text-gray-700 text-[11px]"
                  title="Clear — run today">
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {screeners.length===0 && (
            <div className="text-center text-xs text-gray-400 mt-8 px-3">No screens yet.</div>
          )}
          {screeners.map(s => {
            const isActive = active?.id===s.id && !showEditor;
            return (
              <div key={s.id}
                className="border-b border-gray-100 transition-colors"
                style={{backgroundColor: isActive?"#e8f0fe": "transparent"}}>
                <div className="flex items-center gap-1 px-2 pt-2">
                  <button onClick={()=>s.formula.trim() ? runScreen(s, asOfDate) : setEditing(s)} className="flex-1 text-left min-w-0">
                    <div className="text-xs font-semibold truncate" style={{color: isActive?"#003366":"#1a1a2e"}}>
                      {isActive && "▶ "}{s.name}
                      {!s.formula.trim() && <span className="ml-1 text-[9px] text-amber-500 font-normal">set formula</span>}
                    </div>
                    <div className="text-[10px] text-gray-400">{s.exchange}</div>
                  </button>
                  <button onClick={()=>setEditing(s)} className="text-gray-400 hover:text-blue-600 text-xs px-1 shrink-0" title="Edit">✎</button>
                  <button onClick={()=>deleteScreener(s.id)} className="text-gray-400 hover:text-red-500 text-xs px-1 shrink-0" title="Delete">✕</button>
                </div>
                <div className="px-2 pb-2 text-[10px] text-gray-400 font-mono truncate">{s.formula}</div>
              </div>
            );
          })}
        </div></>}
      </div>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Formula editor */}
        {showEditor && (
          <FormulaEditor
            initial={editing==="new" ? null : editing as SavedScreener}
            onRun={handleSaveAndRun}
            onSave={saveScreener}
            onCancel={()=>setEditing(null)}
          />
        )}

        {/* Favorites view */}
        {!showEditor && showFavorites && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 border-b border-gray-200 bg-white text-xs flex items-center gap-2">
              <span className="font-bold text-amber-500">★ Favorites</span>
              <span className="text-gray-300">·</span>
              <span className="text-gray-500">{favResults.length} saved</span>
              {favResults.length > 0 && (
                <div className="ml-auto flex rounded overflow-hidden border border-gray-200">
                  {(["overview","charts"] as const).map(v=>(
                    <button key={v} onClick={()=>setFavView(v)} className="px-2 py-0.5 text-[11px] capitalize"
                      style={{backgroundColor:favView===v?"#003366":"white",color:favView===v?"white":"#003399",borderRight:v==="overview"?"1px solid #e5e7eb":undefined}}>
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {favResults.length === 0 && (
              <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                <div className="text-4xl mb-3">☆</div>
                <div className="text-sm font-medium">No favorites yet</div>
                <div className="text-xs mt-1 text-gray-300">Click ☆ on any stock in a scan to save it here</div>
              </div>
            )}
            {favResults.length > 0 && favView === "overview" && (
              <div ref={resultsRef} className="flex-1 overflow-auto flex flex-col">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-gray-50 sticky top-0 z-10">
                      <th className="border border-gray-200 px-1 py-1 w-6 text-center text-gray-400">★</th>
                      <th className="border border-gray-200 px-2 py-1 text-gray-400 w-7">#</th>
                      <th className="border border-gray-200 px-2 py-1 text-left">Symbol</th>
                      <th className="border border-gray-200 px-2 py-1">Company</th>
                      <th className="border border-gray-200 px-2 py-1">Sector</th>
                      <th className="border border-gray-200 px-2 py-1">Cap</th>
                      <th className="border border-gray-200 px-2 py-1">Price</th>
                      <th className="border border-gray-200 px-2 py-1">Chg %</th>
                      <th className="border border-gray-200 px-2 py-1">Volume</th>
                      <th className="border border-gray-200 px-2 py-1">RSI</th>
                      <th className="border border-gray-200 px-2 py-1">MACD</th>
                      <th className="border border-gray-200 px-2 py-1">SMA20</th>
                      <th className="border border-gray-200 px-2 py-1">SMA50</th>
                      <th className="border border-gray-200 px-2 py-1">% 52H</th>
                      <th className="border border-gray-200 px-2 py-1 whitespace-nowrap">Earnings</th>
                      <th className="border border-gray-200 px-2 py-1 text-center">Chart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {favPaged.map((r,idx)=>{
                      const up=(r.change_pct??0)>=0;
                      const rc=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                      return <tr key={r.ticker} className="hover:bg-amber-50 border-b border-gray-100">
                        <td className="border border-gray-200 px-1 py-1 text-center">
                          <button onClick={()=>toggleFavorite(r)} title="Remove from favorites"
                            className="text-base leading-none" style={{color:"#f59e0b"}}>★</button>
                        </td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-400">{(page-1)*pageSize+idx+1}</td>
                        <td className="border border-gray-200 px-2 py-1 font-bold whitespace-nowrap" style={{color:"#003399"}}>
                          {r.symbol}{r.new_52w_high&&<span className="ml-1 text-[9px] bg-green-100 text-green-700 rounded px-1">52H</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1 max-w-[140px] truncate text-gray-700">{r.name}</td>
                        <td className="border border-gray-200 px-2 py-1"><span className="bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 text-[10px]">{r.sector}</span></td>
                        <td className="border border-gray-200 px-2 py-1"><span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span></td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums">{r.price?.toLocaleString()}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums text-gray-600">{fmtVol(r.volume)}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums" style={{color:rc}}>{r.rsi??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold" style={{color:r.macd_bullish?"#16a34a":"#dc2626"}}>{r.macd_bullish?"▲ Bull":"▼ Bear"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:r.sma20!=null&&r.price>r.sma20?"#16a34a":"#dc2626"}}>{r.sma20??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:r.sma50!=null&&r.price>r.sma50?"#16a34a":"#dc2626"}}>{r.sma50??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:(r.pct_from_52w_high??-99)>=-5?"#16a34a":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 whitespace-nowrap tabular-nums" style={{color:earningsColor(earnings[r.ticker]??""),fontWeight:earnings[r.ticker]?600:400}}>{fmtEarnings(earnings[r.ticker]??"")}</td>
                        <td className="border border-gray-200 px-0 py-0">{r.sparkline.length>0&&<Sparkline data={r.sparkline} positive={up}/>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
                <Pagination count={favResults.length} total={favTotalPages}/>
              </div>
            )}
            {favResults.length > 0 && favView === "charts" && (
              <div ref={resultsRef} className="flex-1 overflow-auto p-3 flex flex-col gap-3">
                {favPaged.map(r=>{
                  const up=(r.change_pct??0)>=0;
                  const rsiCol=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                  return (
                    <div key={r.ticker} className="border border-gray-200 rounded bg-white shadow-sm overflow-hidden w-full">
                      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-100">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <button onClick={()=>toggleFavorite(r)} title="Remove from favorites"
                            className="text-xl leading-none shrink-0" style={{color:"#f59e0b"}}>★</button>
                          <span className="font-bold text-base" style={{color:"#003399"}}>{r.symbol}</span>
                          {r.new_52w_high&&<span className="text-[9px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-gray-700 font-medium truncate block">{r.name}</span>
                          <span className="text-[11px] text-gray-400">{r.sector} · {r.industry}</span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-lg tabular-nums">{r.price?.toLocaleString()}</div>
                          <div className="text-sm font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</div>
                        </div>
                        <div className="flex gap-4 text-xs text-gray-500 shrink-0 pl-4 border-l border-gray-100">
                          <div>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></div>
                          <div style={{color:r.macd_bullish?"#16a34a":"#dc2626",fontWeight:600}}>{r.macd_bullish?"▲ MACD Bull":"▼ MACD Bear"}</div>
                          <div>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></div>
                          {earnings[r.ticker] && <div className="text-gray-400">Earnings <strong style={{color:earningsColor(earnings[r.ticker])}}>{fmtEarnings(earnings[r.ticker])}</strong></div>}
                        </div>
                      </div>
                      <InteractiveChart data={r.ohlcv} masterBars={masterZoom} />
                    </div>
                  );
                })}
                <Pagination count={favResults.length} total={favTotalPages}/>
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {!showEditor && !showFavorites && (
          <>
            {/* ── Toolbar ─────────────────────────────────────────────── */}
            <div className="border-b border-gray-200 bg-white text-xs">
              {/* Row 1: scan info + view tabs */}
              <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap">
                {active ? (
                  <>
                    <span className="font-bold" style={{color:"#003366"}}>{active.name}</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-500">{active.exchange}</span>
                    {active.interval && active.interval !== "1d" && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700">
                        {active.interval === "75min" ? "75m" : active.interval === "78min" ? "78m" : active.interval}
                      </span>
                    )}
                    {asOfDate && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">HIST {asOfDate}</span>}
                    {isLive && !asOfDate && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 border border-green-300">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block"/>LIVE
                      </span>
                    )}
                    {!loading && results.length>0 && <><span className="text-gray-300">·</span><span className="font-semibold" style={{color:"#003366"}}>{displayResults.length} match{displayResults.length!==1?"es":""}{displayResults.length!==results.length?` (${results.length} total)`:""}</span></>}
                  </>
                ) : (
                  <span className="text-gray-400 italic">← Click a screen to run it, or create a new one</span>
                )}
                {error && <span className="text-red-500">{error}</span>}
                {warning && <span className="text-amber-600 text-[10px] max-w-lg leading-tight">{warning}</span>}

                {/* View tabs — right side */}
                {!loading && results.length>0 && (
                  <div className="ml-auto flex items-center gap-3">
                    {/* Search */}
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300 text-[11px]">🔍</span>
                      <input value={resultSearch} onChange={e=>setRS(e.target.value)}
                        placeholder="Search symbol / name…"
                        className="border border-gray-200 rounded pl-6 pr-2 py-0.5 text-[11px] bg-white w-44 focus:outline-none focus:border-blue-400"/>
                    </div>
                    {/* Sector + Cap filters */}
                    <select className="border border-gray-200 rounded px-1.5 py-0.5 text-[11px] bg-white" value={sectorFilter} onChange={e=>{setSF(e.target.value);setRS("");}}>
                      {sectors.map(s=><option key={s}>{s}</option>)}
                    </select>
                    <select className="border border-gray-200 rounded px-1.5 py-0.5 text-[11px] bg-white" value={capFilter} onChange={e=>setCF(e.target.value)}>
                      {["All","Mega","Large","Mid","Small"].map(c=><option key={c}>{c}</option>)}
                    </select>
                    {/* View toggle — tab style */}
                    <div className="flex border border-gray-200 rounded overflow-hidden">
                      {(["overview","charts"] as const).map(v=>(
                        <button key={v} onClick={()=>setView(v)}
                          className="px-3 py-1 text-[11px] font-medium capitalize transition-colors"
                          style={{backgroundColor:view===v?"#003366":"white",color:view===v?"white":"#374151",borderRight:v==="overview"?"1px solid #e5e7eb":undefined}}>
                          {v==="overview"?"📋 Table":"📈 Charts"}
                        </button>
                      ))}
                    </div>
                    {/* Chart height — only in charts view */}
                    {view==="charts" && (
                      <div className="flex border border-gray-200 rounded overflow-hidden">
                        {(["sm","md","lg"] as const).map((s,i)=>(
                          <button key={s} onClick={()=>setChartSize(s)}
                            className="px-2 py-1 text-[10px] font-medium transition-colors"
                            style={{backgroundColor:chartSize===s?"#e8f0fe":"white",color:chartSize===s?"#003366":"#888",borderRight:i<2?"1px solid #e5e7eb":undefined}}>
                            {s.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2: sector breakdown chips — only when results exist */}
              {!loading && sectorCounts.length>0 && (
                <div className="px-3 pb-1.5 flex gap-1.5 flex-wrap items-center">
                  <span className="text-[10px] text-gray-400 mr-1">Sectors:</span>
                  {sectorCounts.map(([sec,cnt])=>(
                    <button key={sec} onClick={()=>{setSF(sectorFilter===sec?"All":sec);setRS("");goToPage(1);}}
                      className="px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors"
                      style={{
                        backgroundColor: sectorFilter===sec?"#003366":"#f1f5f9",
                        color: sectorFilter===sec?"white":"#475569",
                        borderColor: sectorFilter===sec?"#003366":"#e2e8f0",
                      }}>
                      {sec} <span className="opacity-70">{cnt}</span>
                    </button>
                  ))}
                  {sectorFilter!=="All" && (
                    <button onClick={()=>{setSF("All");goToPage(1);}} className="px-2 py-0.5 rounded-full text-[10px] border border-gray-300 text-gray-500 hover:bg-gray-100">✕ Clear</button>
                  )}
                </div>
              )}
            </div>

            {/* Loading — progress bar */}
            {loading && (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-72 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-400 to-blue-600 rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]"
                    style={{width:"60%",animation:"pulse 1.5s ease-in-out infinite"}}/>
                </div>
                <div className="text-xs text-gray-500 animate-pulse">⚡ Screening {active?.exchange}… first run ~2-3 min, cached runs &lt;5s</div>
              </div>
            )}

            {/* Empty */}
            {!loading && !active && (
              <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                <div className="text-5xl mb-3">📊</div>
                <div className="text-sm font-medium">Click a screen to run it</div>
                <div className="text-xs mt-1 text-gray-300">or click "+ New Setup Scan" to create one</div>
              </div>
            )}

            {/* ── Overview table ─────────────────────────────────────────── */}
            {!loading && results.length>0 && view==="overview" && (
              <div ref={resultsRef} className="flex-1 overflow-auto flex flex-col">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-gray-50 sticky top-0 z-10">
                      <th className="border border-gray-200 px-1 py-1 w-6 text-center text-gray-400">★</th>
                      <th className="border border-gray-200 px-2 py-1 text-gray-400 w-7">#</th>
                      <TH label="Symbol" k="symbol"/>
                      <th className="border border-gray-200 px-2 py-1">Company</th>
                      <th className="border border-gray-200 px-2 py-1">Sector</th>
                      <th className="border border-gray-200 px-2 py-1">Industry</th>
                      <th className="border border-gray-200 px-2 py-1">Cap</th>
                      <th className="border border-gray-200 px-2 py-1">Mkt Cap</th>
                      <TH label="Price" k="price"/>
                      <TH label="Chg %" k="change_pct"/>
                      <th className="border border-gray-200 px-2 py-1 whitespace-nowrap">Earnings</th>
                      <TH label="Volume" k="volume"/>
                      <TH label="RSI" k="rsi"/>
                      <th className="border border-gray-200 px-2 py-1">MACD</th>
                      <TH label="SMA20" k="sma20"/>
                      <TH label="SMA50" k="sma50"/>
                      <TH label="SMA200" k="sma200"/>
                      <TH label="% 52H" k="pct_from_52w_high"/>
                      <th className="border border-gray-200 px-2 py-1 text-center">Chart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((r,idx)=>{
                      const up=(r.change_pct??0)>=0;
                      const rc=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                      return <tr key={r.ticker} className="hover:bg-blue-50 border-b border-gray-100">
                        <td className="border border-gray-200 px-1 py-1 text-center">
                          <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                            className="text-base leading-none transition-colors"
                            style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                            {favorites[r.ticker] ? "★" : "☆"}
                          </button>
                        </td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-400">{(page-1)*pageSize+idx+1}</td>
                        <td className="border border-gray-200 px-2 py-1 font-bold whitespace-nowrap" style={{color:"#003399"}}>
                          {r.symbol}{r.new_52w_high&&<span className="ml-1 text-[9px] bg-green-100 text-green-700 rounded px-1">52H</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1 max-w-[140px] truncate text-gray-700">{r.name}</td>
                        <td className="border border-gray-200 px-2 py-1">
                          <button onClick={()=>{setSF(r.sector);setRS("");goToPage(1);}} title={`Filter by ${r.sector}`}
                            className="bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 text-[10px] hover:bg-blue-100 cursor-pointer">{r.sector}</button>
                        </td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-500 text-[11px] whitespace-nowrap">{r.industry||"—"}</td>
                        <td className="border border-gray-200 px-2 py-1"><span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span></td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-600 text-[11px] whitespace-nowrap">{fmtCap(r.market_cap,active?.exchange??"NSE")}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums">{r.price?.toLocaleString()}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</td>
                        <td className="border border-gray-200 px-2 py-1 whitespace-nowrap tabular-nums" style={{color:earningsColor(earnings[r.ticker]??""),fontWeight:earnings[r.ticker]?600:400}}>{fmtEarnings(earnings[r.ticker]??"")||"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums text-gray-600">{fmtVol(r.volume)}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold tabular-nums" style={{color:rc}}>{r.rsi??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 font-semibold" style={{color:r.macd_bullish?"#16a34a":"#dc2626"}}>{r.macd_bullish?"▲ Bull":"▼ Bear"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:r.sma20!=null&&r.price>r.sma20?"#16a34a":"#dc2626"}}>{r.sma20??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:r.sma50!=null&&r.price>r.sma50?"#16a34a":"#dc2626"}}>{r.sma50??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:r.sma200!=null&&r.price>r.sma200?"#16a34a":"#dc2626"}}>{r.sma200??"—"}</td>
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:(r.pct_from_52w_high??-99)>=-5?"#16a34a":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</td>
                        <td className="border border-gray-200 px-0 py-0">{r.sparkline.length>0&&<Sparkline data={r.sparkline} positive={up}/>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
                <Pagination count={displayResults.length} total={totalPages}/>
              </div>
            )}

            {/* ── Charts view — 1 card per row, full width ──────────────── */}
            {!loading && results.length>0 && view==="charts" && (
              <div ref={resultsRef} className="flex-1 overflow-auto flex flex-col">
                {/* Master zoom bar */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50 sticky top-0 z-10">
                  <span className="text-xs text-gray-500 font-medium">Zoom all charts</span>
                  <div className="flex items-center border border-gray-300 rounded overflow-hidden">
                    <button
                      onClick={() => setMasterZoom(v => Math.min(300, v + Math.max(1, Math.round(v * 0.15))))}
                      className="px-3 py-1 hover:bg-gray-200 text-gray-600 font-bold text-base leading-none border-r border-gray-300 transition-colors"
                      title="Zoom out all charts">−</button>
                    <span className="px-2 text-xs text-gray-500 tabular-nums min-w-[40px] text-center">{masterZoom}b</span>
                    <button
                      onClick={() => setMasterZoom(v => Math.max(10, v - Math.max(1, Math.round(v * 0.15))))}
                      className="px-3 py-1 hover:bg-gray-200 text-gray-600 font-bold text-base leading-none border-l border-gray-300 transition-colors"
                      title="Zoom in all charts">+</button>
                  </div>
                  <button
                    onClick={() => setMasterZoom(69)}
                    className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 transition-colors">
                    Reset
                  </button>
                </div>
                <div className="p-3 flex flex-col gap-3">
                  {paged.map(r=>{
                    const up=(r.change_pct??0)>=0;
                    const rsiCol=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                    return (
                      <div key={r.ticker} className="border border-gray-200 rounded bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden w-full">
                        {/* Header row */}
                        <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-100">
                          {/* Star + Symbol + badges */}
                          <div className="flex items-center gap-2 min-w-[120px]">
                            <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                              className="text-xl leading-none transition-colors shrink-0"
                              style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                              {favorites[r.ticker] ? "★" : "☆"}
                            </button>
                            <span className="font-bold text-base" style={{color:"#003399"}}>{r.symbol}</span>
                            {r.new_52w_high&&<span className="text-[9px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span>
                          </div>
                          {/* Company + sector */}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-gray-700 font-medium truncate block">{r.name}</span>
                            <span className="text-[11px] text-gray-400">
                              <button onClick={()=>{setSF(r.sector);setRS("");goToPage(1);}}
                                className="hover:text-blue-600 hover:underline">{r.sector}</button>
                              {r.industry ? ` · ${r.industry}` : ""}
                            </span>
                          </div>
                          {/* Price + change */}
                          <div className="text-right shrink-0">
                            <div className="font-bold text-lg tabular-nums">{r.price?.toLocaleString()}</div>
                            <div className="text-sm font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</div>
                          </div>
                          {/* Key stats */}
                          <div className="flex gap-4 text-xs text-gray-500 shrink-0 pl-4 border-l border-gray-100">
                            <div>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></div>
                            <div style={{color:r.macd_bullish?"#16a34a":"#dc2626",fontWeight:600}}>{r.macd_bullish?"▲ MACD Bull":"▼ MACD Bear"}</div>
                            <div>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></div>
                            <div>{fmtCap(r.market_cap,active?.exchange??"NSE")}</div>
                            <div className="text-gray-400">SMA20 <strong className="text-gray-600">{r.sma20??"—"}</strong></div>
                            <div className="text-gray-400">SMA50 <strong className="text-gray-600">{r.sma50??"—"}</strong></div>
                            <div className="text-gray-400">% 52H <strong style={{color:(r.pct_from_52w_high??-99)>=-5?"#16a34a":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</strong></div>
                            {earnings[r.ticker] && <div className="text-gray-400">Earnings <strong style={{color:earningsColor(earnings[r.ticker])}}>{fmtEarnings(earnings[r.ticker])}</strong></div>}
                          </div>
                        </div>
                        {/* Full-width interactive chart */}
                        <InteractiveChart data={r.ohlcv} masterBars={masterZoom} priceHeight={CHART_H[chartSize]}/>
                      </div>
                    );
                  })}
                </div>
                <Pagination count={displayResults.length} total={totalPages}/>
              </div>
            )}

            {!loading && active && results.length===0 && !error && (
              <div className="text-center text-xs text-gray-400 mt-16">
                No stocks matched <code className="bg-gray-100 px-1 rounded font-mono">{active.formula}</code> on <strong>{active.exchange}</strong>.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
