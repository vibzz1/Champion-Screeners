"use client";
import { useEffect, useState } from "react";

export function ScanProgress({ progress, startMs, exchange }: {
  progress: { phase: string; done: number; total: number; exchange: string; bar_min: number } | null;
  startMs: number;
  exchange: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startMs) / 1000)), 500);
    return () => clearInterval(id);
  }, [startMs]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const pct     = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const phase   = progress?.phase ?? "connecting";
  const isCache = phase === "cache";

  const phaseLabel =
    isCache                    ? "Loaded from cache" :
    phase === "topup"          ? `Refreshing today's bars · batch ${progress?.done ?? 0} / ${progress?.total ?? "…"}` :
    phase === "downloading"    ? `Downloading ${progress?.exchange || exchange} · batch ${progress?.done ?? 0} / ${progress?.total ?? "…"}` :
    phase === "filtering"      ? `Filtering ${progress?.exchange || exchange} stocks…` :
    phase === "idle"           ? "Finalising…" :
                                 `Connecting to ${exchange} server…`;

  const hint = isCache
    ? "Cache hit — results arriving shortly"
    : elapsed < 15
    ? "First run downloads all tickers (~2–5 min). Subsequent runs use cache (<5 s)."
    : elapsed < 90
    ? "Still downloading — hang tight…"
    : "Large universe. You can run a smaller scan while waiting.";

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-md flex flex-col items-center gap-5 bg-white border border-gray-200 rounded-xl px-8 py-10"
        style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        {/* Spinner — no emoji */}
        <svg className="w-11 h-11 animate-spin shrink-0" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="19" stroke="var(--mio-border)" strokeWidth="4"/>
          <path d="M43 24C43 13.507 34.493 5 24 5" stroke="var(--mio-accent)" strokeWidth="4" strokeLinecap="round"/>
        </svg>
        <div className="text-sm font-semibold text-gray-700 text-center">{phaseLabel}</div>
        <div className="w-full">
          <div className="flex justify-between text-[11px] text-gray-400 mb-1">
            <span className="tabular-nums">{isCache ? "100%" : `${pct}%`}</span>
            <span className="tabular-nums">{elapsedStr}</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{
                width: isCache ? "100%" : phase === "connecting" ? "4%" : `${Math.max(4, pct)}%`,
                background: isCache ? "var(--mio-up)" : "linear-gradient(90deg,#3b82f6,#6366f1)",
              }}/>
          </div>
          {!isCache && progress && progress.total > 0 && (
            <div className="text-[10px] text-gray-400 mt-1.5 text-center tabular-nums">
              {progress.done} / {progress.total} {phase === "filtering" ? "stocks filtered" : "batches downloaded"}
            </div>
          )}
        </div>
        <div className="text-[11px] text-gray-400 text-center leading-relaxed border-t border-gray-100 pt-4 w-full">{hint}</div>
      </div>
    </div>
  );
}
