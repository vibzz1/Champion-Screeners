"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";

// ── Extracted modules ──────────────────────────────────────────────────────
import type { SavedScreener, OHLCV, Result } from "./types";
import { EXCHANGES, PAGE_SIZES, CHIPS }      from "./constants";
import { getScanHistory, saveScanHistory, fmtCap, fmtVol, tvUrl, fmtEarnings, earningsColor } from "./helpers";
import { InteractiveChart }  from "./InteractiveChart";
import { Sparkline }         from "./Sparkline";
import { FormulaEditor }     from "./FormulaEditor";
import { ScanProgress }      from "./ScanProgress";

const API     = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const LS_KEY  = "mio_screeners_v6";

const CAP_COLORS: Record<string, string> = {
  Mega: "#7c3aed", Large: "#1d4ed8", Mid: "#0f766e", Small: "#92400e",
};

// ── Default screeners ──────────────────────────────────────────────────────
const DEFAULTS: SavedScreener[] = [
  { id: "d1", name: "India Setup Scan", exchange: "NSE",   formula: "advol(20) > 50 and advol(50) > 50 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d2", name: "NPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_dn 1" },
  { id: "d3", name: "PPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (price > sma(100) or price > sma(200)) and (pgo(50) < 4 or pgo(20) < 4) and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_up 1" },
  { id: "d4", name: "US Setup Scan",        exchange: "SP500", formula: "advol(20) > 200 and advol(50) > 200 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d5", name: "India Setup Scan 75m", exchange: "NSE",   interval: "75min", formula: "advol(20) > 30 and advol(50) > 30 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d6", name: "US Setup Scan 78m",    exchange: "SP500", interval: "78min", formula: "advol(20) > 100 and advol(50) > 100 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d7", name: "Japan Setup Scan",     exchange: "TSE",   formula: "advol(20) > 1000 and advol(50) > 1000 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d8", name: "Korea Setup Scan (KOSPI)",  exchange: "KOSPI",  formula: "advol(20) > 5000 and advol(50) > 5000 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d10", name: "Korea Setup Scan (KOSDAQ)", exchange: "KOSDAQ", formula: "advol(20) > 2000 and advol(50) > 2000 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d9", name: "Germany Setup Scan",    exchange: "XETRA",  formula: "advol(20) > 10 and advol(50) > 10 and !(sma(20) < sma(50)) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
];

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
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [tick, setTick]                   = useState(0); // increments every 60s for staleness re-render
  const [prevTickerSet, setPrevTS]        = useState<Set<string> | null>(null); // null = no history yet
  const [scanDiff, setScanDiff]           = useState<{prevCount:number;newCount:number;droppedCount:number;prevDate:string}|null>(null);
  const [jumpToTicker, setJumpToTicker]   = useState<string | null>(null);
  const [scanProgress, setScanProgress]   = useState<{phase:string;done:number;total:number;exchange:string;bar_min:number}|null>(null);
  const scanStartRef = useRef<number>(0);
  const [resultSearch, setRS]        = useState("");
  const [chartSize, setChartSize]    = useState<"sm"|"md"|"lg">("md");
  const [chartCols, setChartCols]    = useState<1|2>(1);
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
    scanStartRef.current = Date.now();
    setScanProgress(null);
    setError("");
    setWarning("");
    setResults([]);
    setIsLive(false);
    setPage(1);
    setSF("All");
    setCF("All");
    setPrevTS(null);
    setScanDiff(null);
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
      setLastRefreshed(new Date());
      if (data.warning) setWarning(data.warning);
      // ── Scan history: only for live scans (not historical as_of_date) ──────
      if (!histDate) {
        const today = new Date().toISOString().slice(0, 10);
        const todayTickers: string[] = (data.results ?? []).map((r: Result) => r.ticker);
        const hist = getScanHistory(s.id);
        const prevDate = Object.keys(hist).filter(k => k < today).sort().pop();
        const prevSet = prevDate ? new Set<string>(hist[prevDate]) : null;
        setPrevTS(prevSet);
        if (prevSet && todayTickers.length > 0) {
          const currSet = new Set(todayTickers);
          setScanDiff({
            prevCount:    prevSet.size,
            newCount:     todayTickers.filter(t => !prevSet.has(t)).length,
            droppedCount: [...prevSet].filter(t => !currSet.has(t)).length,
            prevDate: prevDate!,
          });
        }
        saveScanHistory(s.id, today, todayTickers);
      }
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

  // Poll backend progress while a scan is loading
  useEffect(() => {
    if (!loading) { setScanProgress(null); return; }
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${API}/api/screener/progress`);
        if (r.ok) setScanProgress(await r.json());
      } catch {}
    }, 1200);
    return () => clearInterval(id);
  }, [loading]);

  // Jump to a specific chart card when navigating from table → charts view
  useEffect(() => {
    if (!jumpToTicker || view !== "charts") return;
    const t = setTimeout(() => {
      document.getElementById(`chart-${jumpToTicker}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setJumpToTicker(null);
    }, 80);
    return () => clearTimeout(t);
  }, [jumpToTicker, view]);

  // Tick every 60s so staleness badge re-computes without a full re-fetch
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

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
      className="border border-gray-200 px-2 py-1.5 cursor-pointer select-none whitespace-nowrap hover:bg-blue-100 text-left font-semibold text-gray-600 text-[11px]"
      style={{backgroundColor:on?"#dbeafe":undefined}}>
      {label}
      <span className="ml-1" style={{color:on?"#2563eb":"#9ca3af",fontSize:"9px"}}>
        {on?(sortDir==="asc"?"▲":"▼"):"↕"}
      </span>
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
                  onClick={() => { setAsOfDate(""); if (active) runScreen(active, ""); }}
                  className="px-1.5 rounded border border-blue-300 bg-blue-50 text-blue-600 hover:bg-blue-100 text-[10px] font-semibold whitespace-nowrap"
                  title="Switch to live/today data">
                  Today
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
                className="border-b border-gray-100 transition-all duration-150"
                style={{
                  backgroundColor: isActive?"#eef2ff": "transparent",
                  borderLeft: isActive?"3px solid #003366":"3px solid transparent",
                }}>
                <div className="flex items-center gap-1 px-2 pt-2">
                  <button onClick={()=>s.formula.trim() ? runScreen(s, asOfDate) : setEditing(s)} className="flex-1 text-left min-w-0">
                    <div className="text-xs font-semibold truncate flex items-center gap-1" style={{color: isActive?"#003366":"#1a1a2e"}}>
                      {isActive && <span className="text-[8px]">▶</span>}{s.name}
                      {!s.formula.trim() && <span className="text-[9px] text-amber-500 font-normal">set formula</span>}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[9px] font-semibold px-1 py-0 rounded"
                        style={{backgroundColor: isActive?"#c7d2fe":"#e5e7eb", color: isActive?"#3730a3":"#6b7280"}}>
                        {s.exchange}
                      </span>
                      {s.interval && s.interval !== "1d" && (
                        <span className="text-[9px] font-semibold px-1 py-0 rounded bg-purple-100 text-purple-600">
                          {s.interval}
                        </span>
                      )}
                    </div>
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
                    <tr className="bg-gray-100 sticky top-0 z-10">
                      <th className="border border-gray-200 px-1 py-1.5 w-6 text-center text-gray-500 font-semibold text-[11px]">★</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-gray-500 font-semibold text-[11px] w-7">#</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-600 text-[11px]">Symbol</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Company</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Sector</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Cap</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Price</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Chg %</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Volume</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">RSI</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">MACD</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">SMA20</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">SMA50</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px]">% 52H</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px] whitespace-nowrap">Earnings</th>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px] text-center">Chart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {favPaged.map((r,idx)=>{
                      const up=(r.change_pct??0)>=0;
                      const rc=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                      const volSurge = !!(r.avg_vol_20 && r.avg_vol_20 > 0 && r.volume > r.avg_vol_20 * 2);
                      return <tr key={r.ticker} className={`${volSurge?"bg-orange-50 hover:bg-orange-100":"hover:bg-amber-50"} border-b border-gray-100`}>
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
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:volSurge?"#ea580c":"#4b5563"}}>
                          {fmtVol(r.volume)}{volSurge&&r.avg_vol_20&&<span className="ml-0.5 text-[9px] font-bold text-orange-500">⚡{(r.volume/r.avg_vol_20).toFixed(1)}×</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1">
                          {r.rsi!=null
                            ? <span className="inline-block tabular-nums font-bold px-1.5 py-0.5 rounded text-[11px]"
                                style={{color:rc,backgroundColor:r.rsi>70?"#fee2e2":r.rsi<30?"#dcfce7":"#f3f4f6"}}>
                                {r.rsi}
                              </span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1">
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.macd_bullish?"bg-green-100 text-green-700":"bg-red-100 text-red-600"}`}>
                            {r.macd_bullish?"▲ Bull":"▼ Bear"}
                          </span>
                        </td>
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
                          <a href={tvUrl(r.ticker)} target="_blank" rel="noopener noreferrer"
                            className="ml-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors whitespace-nowrap self-center"
                            title="Open on TradingView">TV ↗</a>
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
                    {!loading && results.length>0 && (()=>{
                      const minAgo = lastRefreshed ? Math.floor((Date.now()-lastRefreshed.getTime())/60_000) : null;
                      const stale  = minAgo !== null && minAgo >= 30;
                      void tick; // subscribe to 60s re-render
                      return <>
                        <span className="text-gray-300">·</span>
                        <span className="font-semibold" style={{color:"#003366"}}>{displayResults.length} match{displayResults.length!==1?"es":""}{displayResults.length!==results.length?` (${results.length} total)`:""}</span>
                        {lastRefreshed && <>
                          <span className="text-gray-300">·</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${stale?"bg-amber-100 text-amber-700":"bg-gray-100 text-gray-500"}`}
                            title={stale?"Data may be stale — re-run to refresh":undefined}>
                            {stale?"⚠ ":""}Data as of {lastRefreshed.toTimeString().slice(0,5)}{minAgo&&minAgo>0?` · ${minAgo}m ago`:""}
                          </span>
                        </>}
                      </>;
                    })()}
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
                    {/* Chart controls — only in charts view */}
                    {view==="charts" && (
                      <>
                        {/* Height */}
                        <div className="flex border border-gray-200 rounded overflow-hidden">
                          {(["sm","md","lg"] as const).map((s,i)=>(
                            <button key={s} onClick={()=>setChartSize(s)}
                              className="px-2 py-1 text-[10px] font-medium transition-colors"
                              style={{backgroundColor:chartSize===s?"#e8f0fe":"white",color:chartSize===s?"#003366":"#888",borderRight:i<2?"1px solid #e5e7eb":undefined}}>
                              {s.toUpperCase()}
                            </button>
                          ))}
                        </div>
                        {/* Layout: 1-col / 2-col */}
                        <div className="flex border border-gray-200 rounded overflow-hidden">
                          <button onClick={()=>setChartCols(1)}
                            className="px-2.5 py-1 text-[10px] font-medium transition-colors"
                            style={{backgroundColor:chartCols===1?"#e8f0fe":"white",color:chartCols===1?"#003366":"#888",borderRight:"1px solid #e5e7eb"}}
                            title="1 column">▬</button>
                          <button onClick={()=>setChartCols(2)}
                            className="px-2.5 py-1 text-[10px] font-medium transition-colors"
                            style={{backgroundColor:chartCols===2?"#e8f0fe":"white",color:chartCols===2?"#003366":"#888"}}
                            title="2 columns">⊞</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2: sector breakdown chips — only when results exist */}
              {!loading && sectorCounts.length>0 && (
                <div className="px-3 pb-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 shrink-0">Sectors:</span>
                  <div className="relative flex-1 min-w-0">
                    <div className="flex gap-1.5 items-center overflow-x-auto" style={{scrollbarWidth:"none",msOverflowStyle:"none"}}>
                      {sectorCounts.map(([sec,cnt])=>(
                        <button key={sec} onClick={()=>{setSF(sectorFilter===sec?"All":sec);setRS("");goToPage(1);}}
                          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors"
                          style={{
                            backgroundColor: sectorFilter===sec?"#003366":"#f1f5f9",
                            color: sectorFilter===sec?"white":"#475569",
                            borderColor: sectorFilter===sec?"#003366":"#e2e8f0",
                          }}>
                          {sec} <span className="opacity-70">{cnt}</span>
                        </button>
                      ))}
                      {sectorFilter!=="All" && (
                        <button onClick={()=>{setSF("All");goToPage(1);}} className="shrink-0 px-2 py-0.5 rounded-full text-[10px] border border-gray-300 text-gray-500 hover:bg-gray-100">✕ Clear</button>
                      )}
                    </div>
                    <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent pointer-events-none"/>
                  </div>
                </div>
              )}
            </div>

            {/* ── Scan diff banner ────────────────────────────────────────── */}
            {!loading && scanDiff && results.length > 0 && (
              <div className="px-3 py-1 flex items-center gap-2 text-[11px] border-b border-gray-100 bg-gray-50">
                <span className="text-gray-400">vs {scanDiff.prevDate}:</span>
                <span className="font-semibold text-gray-600">{scanDiff.prevCount} → {scanDiff.newCount+scanDiff.prevCount-scanDiff.droppedCount} results</span>
                {scanDiff.newCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold">↑{scanDiff.newCount} new</span>
                )}
                {scanDiff.droppedCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-500 font-semibold">↓{scanDiff.droppedCount} dropped</span>
                )}
                {scanDiff.newCount === 0 && scanDiff.droppedCount === 0 && (
                  <span className="text-gray-400">same as yesterday</span>
                )}
              </div>
            )}

            {/* Loading — real progress */}
            {loading && <ScanProgress progress={scanProgress} startMs={scanStartRef.current} exchange={active?.exchange??""} />}

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
                    <tr className="bg-gray-100 sticky top-0 z-10">
                      <th className="border border-gray-200 px-1 py-1.5 w-6 text-center text-gray-500 font-semibold text-[11px]">★</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-gray-500 font-semibold text-[11px] w-7">#</th>
                      <TH label="Symbol" k="symbol"/>
                      <TH label="Company" k="name"/>
                      <TH label="Sector" k="sector"/>
                      <TH label="Industry" k="industry"/>
                      <TH label="Cap" k="cap_size"/>
                      <TH label="Mkt Cap" k="market_cap"/>
                      <TH label="Price" k="price"/>
                      <TH label="Chg %" k="change_pct"/>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px] whitespace-nowrap">Earnings</th>
                      <TH label="Volume" k="volume"/>
                      <TH label="RSI" k="rsi"/>
                      <TH label="MACD" k="macd_bullish"/>
                      <TH label="SMA20" k="sma20"/>
                      <TH label="SMA50" k="sma50"/>
                      <TH label="SMA200" k="sma200"/>
                      <TH label="% 52H" k="pct_from_52w_high"/>
                      <th className="border border-gray-200 px-2 py-1.5 font-semibold text-gray-600 text-[11px] text-center">Chart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((r,idx)=>{
                      const up=(r.change_pct??0)>=0;
                      const rc=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                      const volSurge = !!(r.avg_vol_20 && r.avg_vol_20 > 0 && r.volume > r.avg_vol_20 * 2);
                      const isNew    = prevTickerSet !== null && !prevTickerSet.has(r.ticker);
                      const isRepeat = prevTickerSet !== null && prevTickerSet.has(r.ticker);
                      return <tr key={r.ticker} className={`${volSurge?"bg-orange-50 hover:bg-orange-100":"hover:bg-blue-50"} border-b border-gray-100`}>
                        <td className="border border-gray-200 px-1 py-1 text-center">
                          <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                            className="text-base leading-none transition-colors"
                            style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                            {favorites[r.ticker] ? "★" : "☆"}
                          </button>
                        </td>
                        <td className="border border-gray-200 px-2 py-1 text-gray-400">{(page-1)*pageSize+idx+1}</td>
                        <td className="border border-gray-200 px-2 py-1 font-bold whitespace-nowrap">
                          <button
                            onClick={()=>{ setJumpToTicker(r.ticker); setView("charts"); }}
                            className="hover:underline"
                            style={{color:"#003399"}}
                            title="View chart">
                            {r.symbol}
                          </button>
                          {r.new_52w_high&&<span className="ml-1 text-[9px] bg-green-100 text-green-700 rounded px-1">52H</span>}
                          {isNew   &&<span className="ml-1 text-[9px] bg-blue-100 text-blue-700 rounded px-1 font-semibold">🆕</span>}
                          {isRepeat&&<span className="ml-1 text-[9px] bg-gray-100 text-gray-500 rounded px-1">✓</span>}
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
                        <td className="border border-gray-200 px-2 py-1 tabular-nums" style={{color:volSurge?"#ea580c":"#4b5563"}}>
                          {fmtVol(r.volume)}{volSurge&&r.avg_vol_20&&<span className="ml-0.5 text-[9px] font-bold text-orange-500">⚡{(r.volume/r.avg_vol_20).toFixed(1)}×</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1">
                          {r.rsi!=null
                            ? <span className="inline-block tabular-nums font-bold px-1.5 py-0.5 rounded text-[11px]"
                                style={{color:rc,backgroundColor:r.rsi>70?"#fee2e2":r.rsi<30?"#dcfce7":"#f3f4f6"}}>
                                {r.rsi}
                              </span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="border border-gray-200 px-2 py-1">
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.macd_bullish?"bg-green-100 text-green-700":"bg-red-100 text-red-600"}`}>
                            {r.macd_bullish?"▲ Bull":"▼ Bear"}
                          </span>
                        </td>
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
                <div className={`p-3 grid gap-3 ${chartCols===2?"grid-cols-2":"grid-cols-1"}`}>
                  {paged.map(r=>{
                    const up=(r.change_pct??0)>=0;
                    const rsiCol=r.rsi==null?"#aaa":r.rsi>70?"#dc2626":r.rsi<30?"#16a34a":"#222";
                    const isNew    = prevTickerSet !== null && !prevTickerSet.has(r.ticker);
                    const isRepeat = prevTickerSet !== null && prevTickerSet.has(r.ticker);
                    return (
                      <div key={r.ticker} id={`chart-${r.ticker}`} className="border rounded bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden" style={{borderColor: jumpToTicker===r.ticker ? "#003366" : "#e5e7eb", outline: jumpToTicker===r.ticker ? "2px solid #93c5fd" : "none", outlineOffset: "1px"}}>
                        {chartCols===1 ? (
                          /* ── 1-col: full horizontal header ── */
                          <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-100">
                            <div className="flex items-center gap-2 min-w-[120px]">
                              <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                                className="text-xl leading-none transition-colors shrink-0"
                                style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                                {favorites[r.ticker] ? "★" : "☆"}
                              </button>
                              <span className="font-bold text-base" style={{color:"#003399"}}>{r.symbol}</span>
                              {r.new_52w_high&&<span className="text-[9px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                              {isNew   &&<span className="text-[9px] bg-blue-100 text-blue-700 rounded px-1 font-semibold">🆕</span>}
                              {isRepeat&&<span className="text-[9px] bg-gray-100 text-gray-500 rounded px-1">✓</span>}
                              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-gray-700 font-medium truncate block">{r.name}</span>
                              <span className="text-[11px] text-gray-400">
                                <button onClick={()=>{setSF(r.sector);setRS("");goToPage(1);}}
                                  className="hover:text-blue-600 hover:underline">{r.sector}</button>
                                {r.industry ? ` · ${r.industry}` : ""}
                              </span>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-bold text-lg tabular-nums">{r.price?.toLocaleString()}</div>
                              <div className="text-sm font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</div>
                            </div>
                            <div className="flex gap-4 text-xs text-gray-500 shrink-0 pl-4 border-l border-gray-100">
                              <div>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></div>
                              <div style={{color:r.macd_bullish?"#16a34a":"#dc2626",fontWeight:600}}>{r.macd_bullish?"▲ MACD Bull":"▼ MACD Bear"}</div>
                              <div>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></div>
                              <div>{fmtCap(r.market_cap,active?.exchange??"NSE")}</div>
                              <div className="text-gray-400">SMA20 <strong className="text-gray-600">{r.sma20??"—"}</strong></div>
                              <div className="text-gray-400">SMA50 <strong className="text-gray-600">{r.sma50??"—"}</strong></div>
                              <div className="text-gray-400">% 52H <strong style={{color:(r.pct_from_52w_high??-99)>=-5?"#16a34a":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</strong></div>
                              {earnings[r.ticker] && <div className="text-gray-400">Earnings <strong style={{color:earningsColor(earnings[r.ticker])}}>{fmtEarnings(earnings[r.ticker])}</strong></div>}
                              <a href={tvUrl(r.ticker,active?.exchange??"")} target="_blank" rel="noopener noreferrer"
                                className="ml-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors whitespace-nowrap self-center"
                                title="Open on TradingView">TV ↗</a>
                            </div>
                          </div>
                        ) : (
                          /* ── 2-col: compact stacked header ── */
                          <div className="px-3 py-2 border-b border-gray-100">
                            <div className="flex items-center gap-1.5">
                              <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                                className="text-base leading-none transition-colors shrink-0"
                                style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                                {favorites[r.ticker] ? "★" : "☆"}
                              </button>
                              <span className="font-bold text-sm" style={{color:"#003399"}}>{r.symbol}</span>
                              {r.new_52w_high&&<span className="text-[9px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                              {isNew   &&<span className="text-[9px] bg-blue-100 text-blue-700 rounded px-1 font-semibold">🆕</span>}
                              {isRepeat&&<span className="text-[9px] bg-gray-100 text-gray-500 rounded px-1">✓</span>}
                              <span className="rounded px-1 py-0.5 text-[9px] font-semibold text-white" style={{backgroundColor:CAP_COLORS[r.cap_size]??"#555"}}>{r.cap_size}</span>
                              <div className="flex-1 min-w-0 mx-1">
                                <span className="text-xs text-gray-600 font-medium truncate block">{r.name}</span>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-semibold text-sm tabular-nums">{r.price?.toLocaleString()}</div>
                                <div className="text-xs font-semibold tabular-nums" style={{color:up?"#16a34a":"#dc2626"}}>{up?"+":""}{r.change_pct}%</div>
                              </div>
                            </div>
                            <div className="flex gap-2.5 mt-1.5 text-[10px] text-gray-500 flex-wrap">
                              <span>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></span>
                              <span style={{color:r.macd_bullish?"#16a34a":"#dc2626",fontWeight:600}}>{r.macd_bullish?"▲ Bull":"▼ Bear"}</span>
                              <span>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></span>
                              <span className="text-gray-400">%52H <strong style={{color:(r.pct_from_52w_high??-99)>=-5?"#16a34a":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</strong></span>
                              {earnings[r.ticker] && <span style={{color:earningsColor(earnings[r.ticker]),fontWeight:600}}>E:{fmtEarnings(earnings[r.ticker])}</span>}
                              <a href={tvUrl(r.ticker,active?.exchange??"")} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] px-1 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors whitespace-nowrap"
                                title="Open on TradingView">TV ↗</a>
                            </div>
                          </div>
                        )}
                        {/* Interactive chart */}
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
