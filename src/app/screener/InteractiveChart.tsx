"use client";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import type { OHLCV } from "./types";

export function InteractiveChart({ data, masterBars, priceHeight = 230 }: {
  data: OHLCV[]; masterBars?: number; priceHeight?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [w, setW]            = useState(800);
  const [visibleBars, setVB] = useState(Math.min(masterBars ?? 69, data.length));

  useEffect(() => {
    if (masterBars != null) setVB(Math.min(masterBars, data.length));
  }, [masterBars, data.length]);

  const [rightOffset, setRO] = useState(0);
  const [showSma50, setS50]  = useState(false);
  const drag = useRef<{ startX: number; startRO: number } | null>(null);

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
    if (!drag.current) return;
    const pxPerBar = (w - PAD.l - PAD.r) / visibleBars;
    const barsDelta = Math.round((e.clientX - drag.current.startX) / pxPerBar);
    setRO(Math.max(0, Math.min(total - visibleBars, drag.current.startRO - barsDelta)));
  }
  function onMouseUp() { drag.current = null; }

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
      style={{ cursor: drag.current ? "grabbing" : "crosshair" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
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
