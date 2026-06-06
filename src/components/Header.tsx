"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

/* ── IST market-hours helper ── */
function getISTInfo() {
  const now = new Date();
  // IST = UTC + 5:30  (getTimezoneOffset converts local→UTC, +330 converts UTC→IST)
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60_000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), d = ist.getUTCDay();
  const hh = h.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  const timeStr = `${hh}:${mm} IST`;
  // Mon=1 … Fri=5, market 9:15–15:30
  const mins = h * 60 + m;
  const isWeekday = d >= 1 && d <= 5;
  const isOpen = isWeekday && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
  return { timeStr, isOpen };
}

export default function Header() {
  const [dark, setDark]       = useState(false);
  const [istInfo, setIstInfo] = useState(getISTInfo);

  useEffect(() => {
    const saved = localStorage.getItem("mio_theme");
    if (saved === "dark") { setDark(true); document.documentElement.setAttribute("data-theme", "dark"); }
  }, []);

  // Tick every 30 s — enough for market status accuracy
  useEffect(() => {
    const id = setInterval(() => setIstInfo(getISTInfo()), 30_000);
    return () => clearInterval(id);
  }, []);

  function toggleDark() {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("mio_theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("mio_theme", "light");
    }
  }

  const { timeStr, isOpen } = istInfo;

  return (
    <div className="flex items-center justify-between px-3 md:px-4 py-2.5 border-b border-white/5" style={{ backgroundColor: "#0f172a" }}>
      {/* ── Left: hamburger + logo ─────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("mio:sidebar-toggle"))}
          className="md:hidden p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors text-lg leading-none"
          aria-label="Open navigation">
          ☰
        </button>
        <Link href="/" className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-white">
            Market In<span style={{ color: "#f59e0b" }}>O</span>ut
          </span>
        </Link>
      </div>

      {/* ── Right: market pulse + dark toggle ─────────────────────────── */}
      <div className="flex items-center gap-3">

        {/* Market status strip */}
        <div className="hidden sm:flex items-center gap-3 px-3 py-1 rounded-md" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
          {/* NSE status */}
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isOpen ? "animate-pulse" : ""}`}
              style={{ backgroundColor: isOpen ? "#4ade80" : "#475569" }}
            />
            <span className="text-[11px] font-semibold" style={{ color: isOpen ? "#4ade80" : "#64748b" }}>
              NSE {isOpen ? "OPEN" : "CLOSED"}
            </span>
          </div>

          {/* Separator */}
          <span style={{ width: 1, height: 12, backgroundColor: "rgba(255,255,255,0.12)", display: "inline-block" }}/>

          {/* IST clock */}
          <span className="text-[11px] tabular-nums font-medium" style={{ color: "#94a3b8" }}>
            {timeStr}
          </span>
        </div>

        {/* Dark mode toggle */}
        <button
          onClick={toggleDark}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
          style={{
            backgroundColor: dark ? "rgba(245,158,11,0.12)" : "rgba(255,255,255,0.06)",
            color: dark ? "#f59e0b" : "#64748b",
          }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = dark ? "rgba(245,158,11,0.2)" : "rgba(255,255,255,0.12)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = dark ? "rgba(245,158,11,0.12)" : "rgba(255,255,255,0.06)"; }}>
          {dark ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
