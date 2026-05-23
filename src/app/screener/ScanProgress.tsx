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
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
      <div className="text-4xl animate-pulse">📡</div>
      <div className="text-sm font-semibold text-gray-700 text-center">{phaseLabel}</div>
      <div className="w-full max-w-sm">
        <div className="flex justify-between text-[11px] text-gray-400 mb-1">
          <span>{isCache ? "100%" : `${pct}%`}</span>
          <span className="tabular-nums">⏱ {elapsedStr}</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700"
            style={{
              width: isCache ? "100%" : phase === "connecting" ? "4%" : `${Math.max(4, pct)}%`,
              background: isCache ? "#16a34a" : "linear-gradient(90deg,#3b82f6,#6366f1)",
            }}/>
        </div>
        {!isCache && progress && progress.total > 0 && (
          <div className="text-[10px] text-gray-400 mt-1 text-center tabular-nums">
            {progress.done} / {progress.total} {phase === "filtering" ? "stocks filtered" : "batches downloaded"}
          </div>
        )}
      </div>
      <div className="text-[11px] text-gray-400 text-center max-w-xs leading-relaxed">{hint}</div>
    </div>
  );
}
