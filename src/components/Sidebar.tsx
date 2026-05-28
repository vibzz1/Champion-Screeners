"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import type { SavedScreener } from "@/app/screener/types";
import { DEFAULTS, SCREENER_LS_KEY } from "@/app/screener/constants";

function loadScreeners(): SavedScreener[] {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SCREENER_LS_KEY);
    const saved: SavedScreener[] = raw ? JSON.parse(raw) : [];
    const savedMap = new Map(saved.map(s => [s.id, s]));
    const defaultIds = new Set(DEFAULTS.map(d => d.id));
    // Built-ins: use user's saved version if they've edited it, else code default
    const builtins = DEFAULTS.map(d => savedMap.get(d.id) ?? d);
    // Custom: any saved screener not in DEFAULTS
    const custom = saved.filter(s => !defaultIds.has(s.id));
    return [...builtins, ...custom];
  } catch { return DEFAULTS; }
}

const OTHER_NAV = [
  { label: "Strategy Backtester", href: "/backtester" },
  { label: "Watch Lists",         href: "/watchlists"  },
  { label: "Portfolio Tracker",   href: "/portfolio"   },
];

// Design tokens
const BG      = "#0f172a";
const BG2     = "#1e293b";
const BORDER  = "rgba(255,255,255,0.07)";
const TEXT_DIM = "#64748b";
const TEXT_MED = "#94a3b8";
const TEXT_LT  = "#e2e8f0";
const ACTIVE_C = "#60a5fa";
const ACTIVE_B = "rgba(96,165,250,0.12)";
const AMBER    = "#f59e0b";

const WIDTH_KEY     = "mio_sidebar_width";
const DEFAULT_WIDTH = 192;
const MIN_WIDTH     = 140;
const MAX_WIDTH     = 320;

export default function Sidebar() {
  const pathname   = usePathname();
  const onScreener = pathname === "/screener";

  const [collapsed,  setCollapsed]  = useState(false);
  const [open,       setOpen]       = useState(true);
  const [screeners,  setScreeners]  = useState<SavedScreener[]>(DEFAULTS);
  const [activeId,   setActiveId]   = useState<string | null>(null);
  const [width,      setWidth]      = useState(DEFAULT_WIDTH);
  const [dragging,   setDragging]   = useState(false);

  // Load persisted width on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(WIDTH_KEY);
      if (saved) setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(saved))));
    } catch {}
  }, []);

  const refresh = useCallback(() => setScreeners(loadScreeners()), []);

  useEffect(() => {
    refresh();
    function onChanged() { refresh(); }
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

  useEffect(() => { if (onScreener) setOpen(true); }, [onScreener]);

  // ── Drag-to-resize ──────────────────────────────────────────────────────
  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = width;
    setDragging(true);

    function onMove(ev: MouseEvent) {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      setWidth(next);
    }
    function onUp(ev: MouseEvent) {
      const final = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      setWidth(final);
      try { localStorage.setItem(WIDTH_KEY, String(final)); } catch {}
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }

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
      className="relative shrink-0 min-h-screen flex flex-col"
      style={{
        width:           collapsed ? "2rem" : `${width}px`,
        backgroundColor: BG,
        borderRight:     `1px solid ${BORDER}`,
        transition:      dragging ? "none" : "width 0.2s",
        userSelect:      dragging ? "none" : undefined,
      }}>

      {/* ── Toggle button ───────────────────────────────────────────────── */}
      <button
        onClick={() => setCollapsed(v => !v)}
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
        className="absolute -right-3 top-5 z-30 w-6 h-6 rounded-full bg-white shadow-md flex items-center justify-center text-[10px] transition-colors hover:bg-gray-50"
        style={{ color: "#475569", border: "1px solid #e2e8f0" }}>
        {collapsed ? "▶" : "◀"}
      </button>

      {/* ── Drag handle (only when expanded) ────────────────────────────── */}
      {!collapsed && (
        <div
          onMouseDown={startDrag}
          title="Drag to resize"
          className="absolute top-0 bottom-0 z-20 flex items-center justify-center group"
          style={{ right: 0, width: "6px", cursor: "col-resize" }}>
          {/* Visual indicator — 3 dots, visible on hover/drag */}
          <div className="flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ opacity: dragging ? 1 : undefined }}>
            {[0,1,2].map(i => (
              <div key={i} className="w-[3px] h-[3px] rounded-full"
                style={{ backgroundColor: dragging ? ACTIVE_C : TEXT_DIM }}/>
            ))}
          </div>
        </div>
      )}

      {/* ── Full content (hidden when collapsed) ────────────────────────── */}
      {!collapsed && (
        <>
          {/* Section label */}
          <div className="px-3 py-2 text-[10px] font-bold tracking-widest uppercase"
            style={{ color: TEXT_DIM, borderBottom: `1px solid ${BORDER}` }}>
            Analytics Tools
          </div>

          {/* Stock Screener toggle */}
          <button
            onClick={() => { if (!onScreener) { window.location.href = "/screener"; return; } setOpen(v => !v); }}
            className="w-full flex items-center justify-between px-3 py-2 text-left text-[12px] transition-colors"
            style={{
              color:           onScreener ? AMBER : TEXT_MED,
              fontWeight:      onScreener ? 600 : 400,
              borderBottom:    `1px solid ${BORDER}`,
              backgroundColor: "transparent",
            }}
            onMouseEnter={e => { if (!onScreener) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.04)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}>
            <span>Stock Screener</span>
            <span style={{ color: TEXT_DIM, fontSize: "9px" }}>{open ? "▾" : "▸"}</span>
          </button>

          {/* Scanner dropdown */}
          {open && (
            <div style={{ backgroundColor: BG2, borderBottom: `1px solid ${BORDER}` }}>
              {/* + New */}
              <button onClick={handleNew}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold flex items-center gap-1 transition-colors"
                style={{ color: ACTIVE_C, borderBottom: `1px solid ${BORDER}` }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = ACTIVE_B; }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}>
                <span className="text-base leading-none font-normal">+</span> New Setup Scan
              </button>

              {/* Scanner list */}
              <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 180px)" }}>
                {screeners.map(s => {
                  const isActive = activeId === s.id;
                  return (
                    <div key={s.id}
                      className="group flex items-center transition-all duration-100"
                      style={{
                        backgroundColor: isActive ? ACTIVE_B : "transparent",
                        borderLeft:      isActive ? `3px solid ${ACTIVE_C}` : "3px solid transparent",
                        borderBottom:    `1px solid ${BORDER}`,
                      }}>
                      <button onClick={() => handleRun(s)}
                        className="flex-1 text-left px-2 py-1.5 min-w-0" title={s.formula}>
                        {/* ↑ Scanner name: increased to 12px */}
                        <div className="font-semibold truncate text-[12px]"
                          style={{ color: isActive ? ACTIVE_C : TEXT_LT }}>
                          {s.name}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-[9px] font-semibold px-1 rounded"
                            style={{
                              backgroundColor: isActive ? "rgba(96,165,250,0.2)" : "rgba(255,255,255,0.08)",
                              color:           isActive ? ACTIVE_C : TEXT_DIM,
                            }}>
                            {s.exchange}
                          </span>
                          {s.interval && s.interval !== "1d" && (
                            <span className="text-[9px] font-semibold px-1 rounded"
                              style={{ backgroundColor: "rgba(168,85,247,0.15)", color: "#c084fc" }}>
                              {s.interval}
                            </span>
                          )}
                        </div>
                      </button>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1 shrink-0 gap-0.5">
                        <button onClick={() => emit("mio:edit", { screener: s })}
                          className="p-0.5 text-[11px] transition-colors"
                          style={{ color: TEXT_DIM }}
                          onMouseEnter={e => { e.currentTarget.style.color = ACTIVE_C; }}
                          onMouseLeave={e => { e.currentTarget.style.color = TEXT_DIM; }}
                          title="Edit">✎</button>
                        <button onClick={() => emit("mio:delete", { id: s.id })}
                          className="p-0.5 text-[11px] transition-colors"
                          style={{ color: TEXT_DIM }}
                          onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
                          onMouseLeave={e => { e.currentTarget.style.color = TEXT_DIM; }}
                          title="Delete">✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Other nav */}
          {OTHER_NAV.map(item => {
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}
                className="block px-3 py-2 text-[12px] transition-colors"
                style={{
                  color:        active ? AMBER : TEXT_MED,
                  fontWeight:   active ? 600 : 400,
                  borderBottom: `1px solid ${BORDER}`,
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = TEXT_LT; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = TEXT_MED; }}>
                {item.label}
              </Link>
            );
          })}
        </>
      )}
    </aside>
  );
}
