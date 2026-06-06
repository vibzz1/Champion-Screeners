"use client";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import type { OHLCV } from "./types";

export function InteractiveChart({ data, masterBars, priceHeight = 230 }: {
  data: OHLCV[]; masterBars?: number; priceHeight?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [w, setW]            = useState(800);
  const [visibleBars, setVB] = useState(Math.min(masterBars ?? 121, data.length));

  useEffect(() => {
    if (masterBars != null) setVB(Math.min(masterBars, data.length));
  }, [masterBars, data.length]);

  const [rightOffset, setRO]  = useState(0);
  const [showSma50, setS50]   = useState(false);
  const [hoveredIdx, setHovI] = useState<number | null>(null);
  const drag  = useRef<{ startX: number; startRO: number } | null>(null);
  const pinch = useRef<{ dist: number; vb: number } | null>(null);

  const PRICE_H = priceHeight;
  const VOL_H   = 52;
  const GAP     = 6;
  const PAD = { t: 8, b: 22, l: 6, r: 58 };
  const TOTAL_H = PAD.t + PRICE_H + GAP + VOL_H + PAD.b;
  const VOL_TOP = PAD.t + PRICE_H + GAP;

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
  function onMouseDown(e: React.MouseEvent) { drag.current = { startX: e.clientX, startRO: rightOffset }; }
  function onMouseMove(e: React.MouseEvent) {
    const pxPerBar = (w - PAD.l - PAD.r) / visibleBars;
    if (drag.current) {
      const barsDelta = Math.round((e.clientX - drag.current.startX) / pxPerBar);
      setRO(Math.max(0, Math.min(total - visibleBars, drag.current.startRO - barsDelta)));
    } else {
      // Track hovered bar for crosshair tooltip
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left - PAD.l;
        const idx = Math.floor(x / pxPerBar);
        setHovI(idx >= 0 && idx < visible.length ? idx : null);
      }
    }
  }
  function onMouseUp() { drag.current = null; }
  function onMouseLeave() { drag.current = null; setHovI(null); }

  /* ── Touch: pan (1 finger) + pinch zoom (2 fingers) ── */
  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 1) {
      drag.current  = { startX: e.touches[0].clientX, startRO: rightOffset };
      pinch.current = null;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinch.current = { dist: Math.hypot(dx, dy), vb: visibleBars };
      drag.current  = null;
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    e.preventDefault();
    if (e.touches.length === 1 && drag.current) {
      const pxPerBar = (w - PAD.l - PAD.r) / visibleBars;
      const barsDelta = Math.round((e.touches[0].clientX - drag.current.startX) / pxPerBar);
      setRO(Math.max(0, Math.min(total - visibleBars, drag.current.startRO - barsDelta)));
    } else if (e.touches.length === 2 && pinch.current) {
      const dx   = e.touches[0].clientX - e.touches[1].clientX;
      const dy   = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = pinch.current.dist / dist;          // > 1 = zoom in, < 1 = zoom out
      setVB(Math.min(total, Math.max(10, Math.round(pinch.current.vb * ratio))));
    }
  }
  function onTouchEnd() { drag.current = null; pinch.current = null; }

  if (!visible.length)
    return <div className="flex items-center justify-center text-gray-300 text-xs" style={{ height: TOTAL_H }}>No chart data</div>;

  const W = w - PAD.l - PAD.r;
  const prices = visible.flatMap(d => [d.high, d.low]);
  const smaSeries = [
    ...visible.map(d => d.sma20).filter((v): v is number => v != null),
    ...(showSma50 ? visible.map(d => d.sma50).filter((v): v is number => v != null) : []),
  ];
  const maxP = Math.max(...prices, ...smaSeries);
  const minP = Math.min(...prices, ...smaSeries);
  const rng  = maxP - minP || 1;
  const sy   = (p: number) => PAD.t + PRICE_H - ((p - minP) / rng) * PRICE_H;

  const vols    = visible.map(d => d.volume);
  const maxV    = Math.max(...vols) || 1;
  const volBarH = (v: number) => Math.max(1, (v / maxV) * VOL_H);
  const volBarY = (v: number) => VOL_TOP + VOL_H - volBarH(v);

  const slotW = W / visible.length;
  const bodyW = Math.max(1, slotW * 0.65);
  const cx    = (i: number) => PAD.l + (i + 0.5) * slotW;

  const priceTicks = Array.from({ length: 5 }, (_, i) => minP + (rng / 4) * i);

  function fmtV(v: number) {
    return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
         : v >= 1_000     ? `${(v / 1_000).toFixed(0)}K`
         : `${v}`;
  }

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
      style={{ cursor: drag.current ? "grabbing" : "crosshair", touchAction: "none" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <svg width={w} height={TOTAL_H} style={{ display: "block" }}>
        <line x1={PAD.l} y1={VOL_TOP - 1} x2={PAD.l + W} y2={VOL_TOP - 1} stroke="#e5e7eb" strokeWidth={0.5}/>
        {priceTicks.map((p, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={sy(p)} x2={PAD.l + W} y2={sy(p)} stroke="#f0f0f0" strokeWidth={0.5}/>
            <text x={PAD.l + W + 4} y={sy(p) + 3} fontSize={9} fill="#bbb">
              {p >= 1000 ? `${(p / 1000).toFixed(1)}k` : p.toFixed(p < 10 ? 2 : 0)}
            </text>
          </g>
        ))}
        {visible.map((bar, i) => {
          const bull = bar.close >= bar.open;
          const col  = bull ? "#16a34a" : "#dc2626";
          const by1  = sy(Math.max(bar.open, bar.close));
          const by2  = sy(Math.min(bar.open, bar.close));
          return (
            <g key={i}>
              <line x1={cx(i)} y1={sy(bar.high)} x2={cx(i)} y2={sy(bar.low)} stroke={col} strokeWidth={0.8}/>
              <rect x={cx(i) - bodyW / 2} y={by1} width={bodyW} height={Math.max(1, by2 - by1)} fill={col} opacity={0.88}/>
            </g>
          );
        })}
        {sma20segs.map((pts, i) => <polyline key={i} points={pts.join(" ")} fill="none" stroke="#f97316" strokeWidth={1.5} opacity={0.9}/>)}
        {sma50segs.map((pts, i) => <polyline key={i} points={pts.join(" ")} fill="none" stroke="#3b82f6" strokeWidth={1.5} opacity={0.9}/>)}

        <text x={PAD.l + 3} y={VOL_TOP + 10} fontSize={8} fill="#bbb">Vol</text>
        <text x={PAD.l + W + 4} y={VOL_TOP + 10} fontSize={8} fill="#bbb">{fmtV(maxV)}</text>
        <text x={PAD.l + W + 4} y={VOL_TOP + VOL_H / 2 + 3} fontSize={8} fill="#bbb">{fmtV(maxV / 2)}</text>
        <line x1={PAD.l} y1={VOL_TOP + VOL_H / 2} x2={PAD.l + W} y2={VOL_TOP + VOL_H / 2} stroke="#f0f0f0" strokeWidth={0.5}/>
        {visible.map((bar, i) => {
          const bull = bar.close >= bar.open;
          return <rect key={i} x={cx(i) - bodyW / 2} y={volBarY(bar.volume)} width={bodyW} height={volBarH(bar.volume)} fill={bull ? "#16a34a" : "#dc2626"} opacity={0.55}/>;
        })}
        <text x={PAD.l + 4} y={TOTAL_H - 6} fontSize={9} fill="#bbb">{visible[0]?.date?.split(" ")[0]} – {visible[visible.length - 1]?.date}</text>
        <text x={PAD.l + W} y={TOTAL_H - 6} fontSize={9} fill="#bbb" textAnchor="end">{visible.length}d</text>

        {/* ── Crosshair + OHLCV tooltip ── */}
        {hoveredIdx !== null && (() => {
          const bar = visible[hoveredIdx];
          if (!bar) return null;
          const x   = cx(hoveredIdx);
          const bull = bar.close >= bar.open;
          // Tooltip box: flip to left side if hovered bar is in right 45% of chart
          const tipW = 108;
          const tipH = 80;
          const tipX = (hoveredIdx / visible.length) > 0.55 ? x - tipW - 8 : x + 8;
          const tipY = PAD.t + 4;
          const fmt  = (n: number) => n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n.toFixed(n < 10 ? 2 : 0);
          const rows = [
            ["O", fmt(bar.open)],
            ["H", fmt(bar.high)],
            ["L", fmt(bar.low)],
            ["C", fmt(bar.close)],
            ["V", fmtV(bar.volume)],
          ];
          if (bar.sma20 != null) rows.push(["S20", fmt(bar.sma20)]);
          const lineH = 11.5;
          return (
            <g style={{ pointerEvents: "none" }}>
              {/* vertical crosshair */}
              <line x1={x} y1={PAD.t} x2={x} y2={PAD.t + PRICE_H + GAP + VOL_H} stroke="#94a3b8" strokeWidth={0.8} strokeDasharray="3 2" opacity={0.7}/>
              {/* price label on right axis */}
              {bar.close != null && (
                <g>
                  <rect x={PAD.l + W + 2} y={sy(bar.close) - 6} width={54} height={12} rx={2} fill={bull ? "#16a34a" : "#dc2626"} opacity={0.85}/>
                  <text x={PAD.l + W + 5} y={sy(bar.close) + 3.5} fontSize={8.5} fill="#fff" fontWeight={600}>{fmt(bar.close)}</text>
                </g>
              )}
              {/* tooltip box */}
              <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={4} fill="rgba(15,23,42,0.88)" stroke="rgba(255,255,255,0.12)" strokeWidth={0.8}/>
              {/* date header */}
              <text x={tipX + 7} y={tipY + 11} fontSize={8.5} fill="#94a3b8" fontWeight={600}>
                {bar.date?.split(" ")[0] ?? ""}
              </text>
              {/* OHLCV rows */}
              {rows.map(([label, val], i) => (
                <g key={label}>
                  <text x={tipX + 7}  y={tipY + 22 + i * lineH} fontSize={8.5} fill="#64748b">{label}</text>
                  <text x={tipX + tipW - 7} y={tipY + 22 + i * lineH} fontSize={8.5} fill={label === "C" ? (bull ? "#4ade80" : "#f87171") : "#e2e8f0"} textAnchor="end" fontWeight={label === "C" ? 700 : 400}>{val}</text>
                </g>
              ))}
            </g>
          );
        })()}
      </svg>

      <div className="flex items-center gap-3 px-3 pb-1 text-[10px] text-gray-400">
        <span title="Scroll to zoom · Drag to pan" className="cursor-help select-none opacity-40 hover:opacity-80 transition-opacity text-[11px]">ⓘ</span>
        <div className="flex items-center border border-gray-200 rounded overflow-hidden">
          <button onClick={() => setVB(v => Math.min(total, Math.max(10, v + Math.max(1, Math.round(v * 0.1)))))}
            className="px-2 py-0.5 hover:bg-gray-100 text-gray-500 font-bold text-sm leading-none border-r border-gray-200" title="Zoom out">−</button>
          <button onClick={() => setVB(v => Math.min(total, Math.max(10, v - Math.max(1, Math.round(v * 0.1)))))}
            className="px-2 py-0.5 hover:bg-gray-100 text-gray-500 font-bold text-sm leading-none" title="Zoom in">+</button>
        </div>
        <button onClick={() => setS50(v => !v)}
          className="ml-auto px-2 py-0.5 rounded border text-[10px]"
          style={{ borderColor: showSma50 ? "#2f68c5" : "#e5e7eb", color: showSma50 ? "#2f68c5" : "#aaa", backgroundColor: showSma50 ? "#eff6ff" : "white" }}>
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
