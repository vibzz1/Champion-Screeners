"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import type { SavedScreener } from "@/app/screener/types";
import { DEFAULTS, SCREENER_LS_KEY } from "@/app/screener/constants";

function loadScreeners(): SavedScreener[] {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SCREENER_LS_KEY);
    const saved: SavedScreener[] = raw ? JSON.parse(raw) : [];
    const defaultIds = new Set(DEFAULTS.map(d => d.id));
    const custom = saved.filter(s => !defaultIds.has(s.id));
    return [...DEFAULTS, ...custom];
  } catch { return DEFAULTS; }
}

const OTHER_NAV = [
  { label: "Strategy Backtester", href: "/backtester" },
  { label: "Watch Lists",         href: "/watchlists"  },
  { label: "Portfolio Tracker",   href: "/portfolio"   },
];

export default function Sidebar() {
  const pathname   = usePathname();
  const onScreener = pathname === "/screener";

  const [open,      setOpen]     = useState(true);
  const [screeners, setScreeners] = useState<SavedScreener[]>(DEFAULTS);
  const [activeId,  setActiveId]  = useState<string | null>(null);

  const refresh = useCallback(() => setScreeners(loadScreeners()), []);

  useEffect(() => {
    refresh();

    function onChanged()  { refresh(); }
    function onActive(e: Event) {
      setActiveId((e as CustomEvent<{ id: string }>).detail.id);
    }

    window.addEventListener("mio:screeners-changed", onChanged);
    window.addEventListener("mio:scan-active",       onActive);
    return () => {
      window.removeEventListener("mio:screeners-changed", onChanged);
      window.removeEventListener("mio:scan-active",       onActive);
    };
  }, [refresh]);

  // Auto-expand when landing on /screener
  useEffect(() => { if (onScreener) setOpen(true); }, [onScreener]);

  function emit(type: string, detail: object = {}) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function handleRun(s: SavedScreener) {
    if (!onScreener) { window.location.href = "/screener"; return; }
    setActiveId(s.id);
    emit("mio:run", { screener: s });
  }

  function handleNew() {
    if (!onScreener) { window.location.href = "/screener"; return; }
    emit("mio:new");
  }

  return (
    <aside
      className="w-44 shrink-0 border-r border-gray-300 bg-[#f0f4f8] min-h-screen text-xs flex flex-col"
      style={{ fontSize: "12px" }}
    >
      {/* Section heading */}
      <div className="px-2 py-1 font-bold text-white text-[11px]" style={{ backgroundColor: "#003366" }}>
        Analytics Tools
      </div>

      {/* ── Stock Screener (collapsible) ────────────────────────────────── */}
      <button
        onClick={() => { if (!onScreener) { window.location.href = "/screener"; return; } setOpen(v => !v); }}
        className="w-full flex items-center justify-between px-2 py-[5px] hover:bg-blue-50 transition-colors text-left border-b border-gray-200"
        style={{ color: onScreener ? "#cc6600" : "#003399", fontWeight: onScreener ? "bold" : "normal" }}>
        <span>Stock Screener</span>
        <span className="text-[9px] text-gray-400 ml-1">{open ? "▾" : "▸"}</span>
      </button>

      {/* Dropdown scanner list */}
      {open && (
        <div className="bg-white border-b border-gray-200 flex flex-col">
          {/* + New Setup Scan */}
          <button
            onClick={handleNew}
            className="w-full text-left px-3 py-1.5 text-[11px] font-semibold border-b border-gray-100 hover:bg-blue-50 transition-colors flex items-center gap-1"
            style={{ color: "#003366" }}>
            <span className="text-base leading-none font-normal">+</span> New Setup Scan
          </button>

          {/* Scanner list */}
          <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 160px)" }}>
            {screeners.map(s => {
              const isActive = activeId === s.id;
              return (
                <div key={s.id}
                  className="group flex items-center border-b border-gray-100 transition-all duration-100"
                  style={{
                    backgroundColor: isActive ? "#eef2ff" : "transparent",
                    borderLeft: isActive ? "3px solid #003366" : "3px solid transparent",
                  }}>
                  <button
                    onClick={() => handleRun(s)}
                    className="flex-1 text-left px-2 py-1.5 min-w-0"
                    title={s.formula}>
                    <div className="font-semibold truncate text-[11px]"
                      style={{ color: isActive ? "#003366" : "#1a1a2e" }}>
                      {s.name}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[9px] font-semibold px-1 rounded"
                        style={{
                          backgroundColor: isActive ? "#c7d2fe" : "#e5e7eb",
                          color:           isActive ? "#3730a3" : "#6b7280",
                        }}>
                        {s.exchange}
                      </span>
                      {s.interval && s.interval !== "1d" && (
                        <span className="text-[9px] font-semibold px-1 rounded bg-purple-100 text-purple-600">
                          {s.interval}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Edit / Delete — visible on hover */}
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1 shrink-0 gap-0.5">
                    <button onClick={() => emit("mio:edit", { screener: s })}
                      className="p-0.5 text-gray-400 hover:text-blue-600 text-xs" title="Edit">✎</button>
                    <button onClick={() => emit("mio:delete", { id: s.id })}
                      className="p-0.5 text-gray-400 hover:text-red-500 text-xs" title="Delete">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Other nav items ─────────────────────────────────────────────── */}
      {OTHER_NAV.map(item => {
        const active = pathname === item.href;
        return (
          <Link key={item.href} href={item.href}
            className="block px-2 py-[5px] hover:underline border-b border-gray-200"
            style={{ color: active ? "#cc6600" : "#003399", fontWeight: active ? "bold" : "normal" }}>
            {item.label}
          </Link>
        );
      })}
    </aside>
  );
}
