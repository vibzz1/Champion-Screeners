"use client";
import { useEffect, useState, useCallback, useMemo, useRef, cloneElement } from "react";

// ── Extracted modules ──────────────────────────────────────────────────────
import type { SavedScreener, OHLCV, Result } from "./types";
import { EXCHANGES, PAGE_SIZES, CHIPS, DEFAULTS, SCREENER_LS_KEY } from "./constants";
import { getScanHistory, saveScanHistory, getRecentScreeners, saveRecentScreener, fmtCap, fmtVol, tvUrl, fmtEarnings, earningsColor } from "./helpers";
import { InteractiveChart }  from "./InteractiveChart";
import { Sparkline }         from "./Sparkline";
import { FormulaEditor }     from "./FormulaEditor";
import { ScanProgress }      from "./ScanProgress";

const API           = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const LS_KEY        = SCREENER_LS_KEY;
const LAST_SCAN_KEY = "mio_last_scan_v2";

// ── Column definitions (outside component to avoid recreation) ─────────────
const COL_LS = "mio_cols_v2";
const FIXED_COL_IDS = new Set(["fav","idx","symbol","chart"]);

const ALL_COLS = [
  { id: "fav",      label: "★",        sortKey: "",                  defW: 28,  noSort: true,  noResize: true  },
  { id: "idx",      label: "#",        sortKey: "",                  defW: 32,  noSort: true,  noResize: true  },
  { id: "symbol",   label: "Symbol",   sortKey: "symbol",            defW: 90,  noSort: false, noResize: false },
  { id: "name",     label: "Company",  sortKey: "name",              defW: 140, noSort: false, noResize: false },
  { id: "sector",   label: "Sector",   sortKey: "sector",            defW: 90,  noSort: false, noResize: false },
  { id: "industry", label: "Industry", sortKey: "industry",          defW: 100, noSort: false, noResize: false },
  { id: "cap",      label: "Cap",      sortKey: "cap_size",          defW: 55,  noSort: false, noResize: false },
  { id: "mktcap",   label: "Mkt Cap",  sortKey: "market_cap",        defW: 70,  noSort: false, noResize: false },
  { id: "price",    label: "Price",    sortKey: "price",             defW: 65,  noSort: false, noResize: false },
  { id: "chg",      label: "Chg %",    sortKey: "change_pct",        defW: 60,  noSort: false, noResize: false },
  { id: "earnings", label: "Earnings", sortKey: "",                  defW: 65,  noSort: true,  noResize: false },
  { id: "volume",   label: "Volume",   sortKey: "volume",            defW: 75,  noSort: false, noResize: false },
  { id: "rsi",      label: "RSI",      sortKey: "rsi",               defW: 50,  noSort: false, noResize: false },
  { id: "macd",     label: "MACD",     sortKey: "macd_bullish",      defW: 70,  noSort: false, noResize: false },
  { id: "sma20",    label: "SMA20",    sortKey: "sma20",             defW: 60,  noSort: false, noResize: false },
  { id: "sma50",    label: "SMA50",    sortKey: "sma50",             defW: 60,  noSort: false, noResize: false },
  { id: "sma200",   label: "SMA200",   sortKey: "sma200",            defW: 65,  noSort: false, noResize: false },
  { id: "h52",      label: "% 52H",    sortKey: "pct_from_52w_high", defW: 55,  noSort: false, noResize: false },
  { id: "days",     label: "Days",     sortKey: "",                  defW: 45,  noSort: true,  noResize: false },
  { id: "chart",    label: "Chart",    sortKey: "",                  defW: 65,  noSort: true,  noResize: true  },
] as const;
type ColId = typeof ALL_COLS[number]["id"];
const ALL_COL_IDS: ColId[] = ALL_COLS.map(c => c.id);
const DEFAULT_HIDDEN: ColId[] = ["industry", "sma200"];

// ── Fetch with exponential-backoff retry ─────────────────────────────────────
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxRetries) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[MIO] fetch attempt ${attempt + 1} failed — retrying in ${delay}ms`, lastErr);
      await new Promise<void>(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function emit(type: string, detail: object = {}) {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

const CAP_COLORS: Record<string, string> = {
  Mega: "#7c3aed", Large: "#1d4ed8", Mid: "#0f766e", Small: "#92400e",
};

// ── Main page ──────────────────────────────────────────────────────────────
export default function ScreenerPage() {
  const [screeners, setScreeners]   = useState<SavedScreener[]>([]);
  const [editing, setEditing]       = useState<SavedScreener | null | "new">(null);
  const [active, setActive]         = useState<SavedScreener | null>(null);
  const [results, setResults]       = useState<Result[]>([]);
  const [loading, setLoading]       = useState(false);
  const [masterZoom, setMasterZoom] = useState(69);
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
  const [tick, setTick]                   = useState(0);
  const [prevTickerSet, setPrevTS]        = useState<Set<string> | null>(null);
  const [scanDiff, setScanDiff]           = useState<{prevCount:number;newCount:number;droppedCount:number;prevDate:string}|null>(null);
  const [jumpToTicker, setJumpToTicker]   = useState<string | null>(null);
  const [scanProgress, setScanProgress]   = useState<{phase:string;done:number;total:number;exchange:string;bar_min:number}|null>(null);
  const scanStartRef = useRef<number>(0);
  const [resultSearch, setRS]        = useState("");
  const [chartSize, setChartSize]    = useState<"sm"|"md"|"lg">("md");
  const [chartCols, setChartCols]    = useState<1|2>(1);
  const [recentScreeners, setRecent] = useState<SavedScreener[]>([]);
  const [scanDuration, setScanDuration] = useState<number | null>(null);
  const [restored,     setRestored]     = useState(false); // true when showing cached last-scan
  const [watchlistSyms, setWatchlistSyms] = useState<Set<string>>(new Set());
  const FAV_KEY = "mio_favorites_v1";
  const resultsRef = useRef<HTMLDivElement>(null);
  const CHART_H: Record<string, number> = { sm: 160, md: 230, lg: 380 };

  // ── Column customizer state ────────────────────────────────────────────────
  const [colOrder,    setColOrder]    = useState<ColId[]>(ALL_COL_IDS);
  const [hiddenCols,  setHiddenCols]  = useState<Set<ColId>>(new Set(DEFAULT_HIDDEN));
  const [colWidths,   setColWidths]   = useState<Partial<Record<ColId, number>>>({});
  const [showColMenu, setShowColMenu] = useState(false);
  const [dragCol,     setDragCol]     = useState<ColId | null>(null);
  const [dropCol,     setDropCol]     = useState<ColId | null>(null);

  // Load column prefs from localStorage
  useEffect(() => {
    try {
      const o = localStorage.getItem(COL_LS + "_order");
      if (o) {
        const parsed: ColId[] = JSON.parse(o);
        // Ensure any new columns are appended and removed ones are filtered
        const preserved = parsed.filter(id => ALL_COL_IDS.includes(id));
        const added     = ALL_COL_IDS.filter(id => !parsed.includes(id));
        setColOrder([...preserved, ...added]);
      }
      const h = localStorage.getItem(COL_LS + "_hidden");
      if (h) setHiddenCols(new Set(JSON.parse(h)));
      const w = localStorage.getItem(COL_LS + "_widths");
      if (w) setColWidths(JSON.parse(w));
    } catch {}
  }, []);

  function saveColOrder(order: ColId[]) {
    setColOrder(order);
    try { localStorage.setItem(COL_LS + "_order", JSON.stringify(order)); } catch {}
  }
  function saveHiddenCols(hidden: Set<ColId>) {
    setHiddenCols(hidden);
    try { localStorage.setItem(COL_LS + "_hidden", JSON.stringify([...hidden])); } catch {}
  }
  function saveColWidths(widths: Partial<Record<ColId, number>>) {
    setColWidths(widths);
    try { localStorage.setItem(COL_LS + "_widths", JSON.stringify(widths)); } catch {}
  }

  function toggleHidden(id: ColId) {
    if (FIXED_COL_IDS.has(id)) return;
    const next = new Set(hiddenCols);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveHiddenCols(next);
  }

  const visibleCols = useMemo(
    () => colOrder.filter(id => !hiddenCols.has(id)),
    [colOrder, hiddenCols],
  );

  // Drag-to-reorder handlers
  function onColDragStart(id: ColId) { setDragCol(id); }
  function onColDragOver(e: React.DragEvent, id: ColId) {
    e.preventDefault();
    if (dragCol && dragCol !== id) setDropCol(id);
  }
  function onColDrop(targetId: ColId) {
    if (!dragCol || dragCol === targetId) return;
    const next = [...colOrder];
    const fi   = next.indexOf(dragCol);
    const ti   = next.indexOf(targetId);
    if (fi < 0 || ti < 0) return;
    next.splice(fi, 1);
    next.splice(ti, 0, dragCol);
    saveColOrder(next);
    setDragCol(null);
    setDropCol(null);
  }
  function onColDragEnd() { setDragCol(null); setDropCol(null); }

  // Column resize
  function startColResize(e: React.MouseEvent, id: ColId, currentWidth: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX  = e.clientX;
    const startW  = currentWidth;
    document.body.classList.add("col-resize-active");
    function onMove(ev: MouseEvent) {
      const next = Math.max(40, startW + ev.clientX - startX);
      setColWidths(prev => ({ ...prev, [id]: next }));
    }
    function onUp(ev: MouseEvent) {
      const final = Math.max(40, startW + ev.clientX - startX);
      saveColWidths({ ...colWidths, [id]: final });
      document.body.classList.remove("col-resize-active");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  const DEFAULT_IDS = new Set(DEFAULTS.map(d => d.id));

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const saved: SavedScreener[] = raw ? JSON.parse(raw) : [];
      const savedMap = new Map(saved.map(s => [s.id, s]));
      const builtins = DEFAULTS.map(d => savedMap.get(d.id) ?? d);
      const custom   = saved.filter(s => !DEFAULT_IDS.has(s.id));
      setScreeners([...builtins, ...custom]);
    } catch { setScreeners(DEFAULTS); }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavorites(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => { setRecent(getRecentScreeners()); }, []);

  // Restore last scan from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_SCAN_KEY);
      if (!raw) return;
      const { screener, results, asOfDate: savedDate, timestamp } = JSON.parse(raw);
      if (screener && Array.isArray(results) && results.length > 0) {
        setActive(screener);
        setResults(results);
        if (savedDate) setAsOfDate(savedDate);
        setLastRefreshed(new Date(timestamp));
        setRestored(true);
      }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all watchlist symbols for badge display
  useEffect(() => {
    fetch(`${API}/api/watchlists/all-symbols`)
      .then(r => r.ok ? r.json() : [])
      .then((syms: string[]) => setWatchlistSyms(new Set(syms)))
      .catch(() => {});
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
    const defaultsMap = new Map(DEFAULTS.map(d => [d.id, d]));
    const toSave = list.filter(s => {
      const def = defaultsMap.get(s.id);
      if (!def) return true;
      return JSON.stringify(s) !== JSON.stringify(def);
    });
    localStorage.setItem(LS_KEY, JSON.stringify(toSave));
  }

  function saveScreener(s: SavedScreener) {
    const exists = screeners.find(x => x.id === s.id);
    persist(exists ? screeners.map(x => x.id===s.id ? s : x) : [...screeners, s]);
    setEditing(null);
    emit("mio:screeners-changed");
  }

  function deleteScreener(id: string) {
    if (!confirm("Delete this screen?")) return;
    persist(screeners.filter(x => x.id !== id));
    if (active?.id === id) { setActive(null); setResults([]); }
    emit("mio:screeners-changed");
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  const runScreen = useCallback(async (s: SavedScreener, histDate: string = "") => {
    setActive(s);
    setEditing(null);
    setShowFavorites(false);
    setLoading(true);
    scanStartRef.current = Date.now();
    setScanProgress(null);
    setScanDuration(null);
    setError("");
    setWarning("");
    setResults([]);
    setRS("");
    setIsLive(false);
    setPage(1);
    setSF("All");
    setCF("All");
    setPrevTS(null);
    setScanDiff(null);
    try {
      const res = await fetchWithRetry(`${API}/api/screener/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange: s.exchange, formula: s.formula, interval: s.interval ?? "1d", ...(histDate ? { as_of_date: histDate } : {}) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const scanResults: Result[] = data.results ?? [];
      setResults(scanResults);
      setIsLive(data.live ?? false);
      setLastRefreshed(new Date());
      setRestored(false);
      emit("mio:scan-active",   { id: s.id });
      emit("mio:scan-results",  { id: s.id, count: scanResults.length });
      // Persist last scan so page refresh restores results instantly
      try {
        const payload = JSON.stringify({ screener: s, results: scanResults, asOfDate: histDate, timestamp: Date.now() });
        localStorage.setItem(LAST_SCAN_KEY, payload);
      } catch {
        // If quota exceeded, save without ohlcv (strips chart data but keeps table)
        try {
          const stripped = scanResults.map(({ ohlcv: _o, ...r }) => ({ ...r, ohlcv: [] }));
          localStorage.setItem(LAST_SCAN_KEY, JSON.stringify({ screener: s, results: stripped, asOfDate: histDate, timestamp: Date.now() }));
        } catch {}
      }
      saveRecentScreener(s);
      setRecent(getRecentScreeners());
      if (data.warning) setWarning(data.warning);
      if (!histDate) {
        const _d = new Date(); const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
        const todayTickers: string[] = (data.results ?? []).map((r: Result) => r.ticker);
        const hist = getScanHistory(s.id);
        const prevDate = Object.keys(hist).filter(k => k < today).sort().pop();
        const prevSet  = prevDate ? new Set<string>(hist[prevDate]) : null;
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
      const msg = e instanceof Error ? e.message : String(e);
      const isNetwork = msg.includes("fetch") || msg.includes("network") || msg.includes("Failed");
      setError(
        isNetwork
          ? `Can't reach the backend (tried 3×). Check your connection or try again in a moment. (${msg})`
          : `Scan failed: ${msg}`
      );
    } finally {
      setScanDuration(Date.now() - scanStartRef.current);
      setLoading(false);
    }
  }, []);

  function handleSaveAndRun(s: SavedScreener) {
    saveScreener(s);
    runScreen(s, asOfDate);
  }

  // ── Sidebar event bridge ──────────────────────────────────────────────────
  useEffect(() => {
    function onRun(e: Event) {
      const { screener } = (e as CustomEvent<{ screener: SavedScreener }>).detail;
      runScreen(screener, asOfDate);
    }
    function onNew()  { setEditing("new"); }
    function onEdit(e: Event) {
      const { screener } = (e as CustomEvent<{ screener: SavedScreener }>).detail;
      setEditing(screener);
    }
    function onDelete(e: Event) {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      deleteScreener(id);
    }
    window.addEventListener("mio:run",    onRun);
    window.addEventListener("mio:new",    onNew);
    window.addEventListener("mio:edit",   onEdit);
    window.addEventListener("mio:delete", onDelete);
    return () => {
      window.removeEventListener("mio:run",    onRun);
      window.removeEventListener("mio:new",    onNew);
      window.removeEventListener("mio:edit",   onEdit);
      window.removeEventListener("mio:delete", onDelete);
    };
  }, [asOfDate, runScreen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── CSV export ───────────────────────────────────────────────────────────
  function exportCSV() {
    const headers = ["Symbol","Name","Sector","Industry","Cap","Market Cap","Price","Chg%","Volume","RSI","MACD","SMA20","SMA50","SMA200","% 52H","DaysInScan"];
    const rows = displayResults.map(r => [
      r.symbol, r.name, r.sector, r.industry, r.cap_size,
      fmtCap(r.market_cap, active?.exchange ?? "NSE"),
      r.price, r.change_pct, r.volume, r.rsi,
      r.macd_bullish ? "Bull" : "Bear",
      r.sma20, r.sma50, r.sma200, r.pct_from_52w_high,
      daysInScanMap[r.ticker] ?? 1,
    ]);
    const csv = [headers, ...rows].map(row => row.map(v => `"${v ?? ""}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const _fd = new Date(); const _fdate = `${_fd.getFullYear()}-${String(_fd.getMonth()+1).padStart(2,'0')}-${String(_fd.getDate()).padStart(2,'0')}`;
    a.download = `${active?.name ?? "scan"}_${_fdate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        if (showColMenu) { setShowColMenu(false); return; }
        if (editing) { setEditing(null); return; }
      }
      if (e.key === "/" && !inInput) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[placeholder*="Search"]')?.focus();
      }
      if ((e.key === "r" || e.key === "R") && !inInput && !e.metaKey && !e.ctrlKey) {
        if (active && !loading) runScreen(active, asOfDate);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, showColMenu]);

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

  // Sector summary counts
  const sectorCounts = useMemo(()=>{
    const m: Record<string,number> = {};
    displayResults.forEach(r=>{ if(r.sector) m[r.sector]=(m[r.sector]||0)+1; });
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  },[displayResults]);

  // ── Days in scan map (consecutive days per ticker) ─────────────────────
  const daysInScanMap = useMemo<Record<string, number>>(() => {
    if (!active) return {};
    const hist  = getScanHistory(active.id);
    const dates = Object.keys(hist).sort().reverse(); // newest first
    if (dates.length === 0) return {};
    const map: Record<string, number> = {};
    for (const r of results) {
      let streak = 0;
      for (const d of dates) {
        if ((hist[d] ?? []).includes(r.ticker)) streak++;
        else break;
      }
      if (streak > 0) map[r.ticker] = streak;
    }
    return map;
  }, [active, results]);

  function goToPage(p: number) {
    (document.activeElement as HTMLElement)?.blur();
    setPage(p);
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

  // Jump to chart card
  useEffect(() => {
    if (!jumpToTicker || view !== "charts") return;
    const t = setTimeout(() => {
      document.getElementById(`chart-${jumpToTicker}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setJumpToTicker(null);
    }, 80);
    return () => clearTimeout(t);
  }, [jumpToTicker, view]);

  // Tick every 60s for staleness re-render
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const favResults    = useMemo(()=>Object.values(favorites),[favorites]);
  const favTotalPages = Math.max(1, Math.ceil(favResults.length/pageSize));
  const favPaged      = favResults.slice((page-1)*pageSize, page*pageSize);

  // Earnings — fetch for current visible page only
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

  // ── Column header component (enhanced with drag/resize) ──────────────────
  function ColTH({ id, defW }: { id: ColId; defW: number }) {
    const def     = ALL_COLS.find(c => c.id === id)!;
    const isSort  = sortKey === def.sortKey && def.sortKey;
    const w       = colWidths[id] ?? defW;
    const isFixed = FIXED_COL_IDS.has(id);
    const isDragging = dragCol === id;
    const isDropTarget = dropCol === id && dragCol !== id;

    return (
      <th
        data-col={id}
        draggable={!isFixed}
        onDragStart={isFixed ? undefined : () => onColDragStart(id)}
        onDragOver={isFixed ? undefined : (e) => onColDragOver(e, id)}
        onDrop={isFixed ? undefined : () => onColDrop(id)}
        onDragEnd={isFixed ? undefined : onColDragEnd}
        onClick={def.sortKey && !def.noSort ? () => handleSort(def.sortKey!) : undefined}
        style={{
          width:           w,
          minWidth:        w,
          maxWidth:        w,
          backgroundColor: isSort ? "var(--mio-sort-bg)" : undefined,
          color:           isSort ? "var(--mio-sort-c)" : "var(--mio-text2)",
          boxShadow:       isSort ? "inset 0 -2px 0 var(--mio-sort-bar)" : undefined,
          opacity:         isDragging ? 0.4 : 1,
          borderLeft:      isDropTarget ? "2px solid var(--mio-sort-bar)" : undefined,
          cursor:          def.sortKey && !def.noSort ? "pointer" : (isFixed ? "default" : "grab"),
          position:        "relative",
          overflow:        "hidden",
          userSelect:      "none",
        }}
        className="px-2 py-1 select-none whitespace-nowrap text-left transition-colors hover:bg-blue-50"
      >
        {def.label}
        {def.sortKey && !def.noSort && (
          <span className="ml-1" style={{ color: isSort ? "var(--mio-sort-c)" : "var(--mio-border)", fontSize: "9px" }}>
            {isSort ? (sortDir==="asc" ? "▲" : "▼") : "↕"}
          </span>
        )}
        {/* Resize handle */}
        {!def.noResize && (
          <div
            onMouseDown={(e) => startColResize(e, id, w)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to resize"
            style={{
              position:   "absolute", top: 0, right: 0, bottom: 0, width: 4,
              cursor:     "col-resize",
              backgroundColor: "transparent",
            }}
            className="hover:bg-blue-300/50 transition-colors"
          />
        )}
      </th>
    );
  }

  // ── Cell renderer ─────────────────────────────────────────────────────────
  function renderCell(colId: ColId, r: Result, idx: number): React.ReactNode {
    const up       = (r.change_pct ?? 0) >= 0;
    const rc       = r.rsi == null ? "var(--mio-text3)" : r.rsi > 70 ? "var(--mio-dn)" : r.rsi < 30 ? "var(--mio-up)" : "var(--mio-text)";
    const volSurge = !!(r.avg_vol_20 && r.avg_vol_20 > 0 && r.volume > r.avg_vol_20 * 2);
    const isNew    = prevTickerSet !== null && !prevTickerSet.has(r.ticker);
    const isRepeat = prevTickerSet !== null && prevTickerSet.has(r.ticker);
    const dayCount = daysInScanMap[r.ticker];
    const w        = colWidths[colId] ?? ALL_COLS.find(c => c.id === colId)!.defW;

    const tdBase: React.CSSProperties = { width: w, minWidth: w, maxWidth: w, overflow: "hidden" };

    switch (colId) {
      case "fav":
        return (
          <td key={colId} className="px-1 py-1 text-center" style={tdBase}>
            <button onClick={() => toggleFavorite(r)}
              title={favorites[r.ticker] ? "Remove from favorites" : "Add to favorites"}
              className="text-base leading-none transition-colors"
              style={{ color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db" }}>
              {favorites[r.ticker] ? "★" : "☆"}
            </button>
          </td>
        );
      case "idx":
        return <td key={colId} className="px-2 py-1 text-gray-400" style={tdBase}>{(page-1)*pageSize+idx+1}</td>;
      case "symbol":
        return (
          <td key={colId} className="px-2 py-1 font-bold whitespace-nowrap" style={tdBase}>
            <button onClick={() => { setJumpToTicker(r.ticker); setView("charts"); }}
              className="hover:underline" style={{ color: "var(--mio-ticker)" }} title="View chart">
              {r.symbol}
            </button>
            {r.new_52w_high && <span className="ml-1 text-[10px] bg-green-100 text-green-700 rounded px-1">52H</span>}
            {isNew    && <span className="ml-1 text-[10px] bg-blue-100 text-blue-700 rounded px-1 font-semibold" title="New in this scan vs yesterday">🆕</span>}
            {isRepeat && <span className="ml-1 text-[10px] bg-gray-100 text-gray-500 rounded px-1" title="Was in yesterday's scan too">✓</span>}
            {watchlistSyms.has(r.symbol) && (
              <span className="ml-1 text-[10px] px-1 rounded font-bold" title="In your watchlist"
                style={{ backgroundColor: "#fef3c7", color: "#b45309", border: "1px solid #fcd34d" }}>
                WL
              </span>
            )}
          </td>
        );
      case "name":
        return <td key={colId} className="px-2 py-1 max-w-[140px] truncate text-gray-700" style={tdBase}>{r.name}</td>;
      case "sector":
        return (
          <td key={colId} className="px-2 py-1" style={tdBase}>
            <button onClick={() => { setSF(r.sector); setRS(""); goToPage(1); }}
              title={`Filter by ${r.sector}`}
              className="bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 text-[10px] hover:bg-blue-100 cursor-pointer truncate block max-w-full">
              {r.sector}
            </button>
          </td>
        );
      case "industry":
        return <td key={colId} className="px-2 py-1 text-gray-500 text-[11px] whitespace-nowrap truncate" style={tdBase}>{r.industry || "—"}</td>;
      case "cap":
        return (
          <td key={colId} className="px-2 py-1" style={tdBase}>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{
                color:           CAP_COLORS[r.cap_size] ?? "#6b7280",
                backgroundColor: (CAP_COLORS[r.cap_size] ?? "#6b7280") + "18",
                border:          "1px solid " + (CAP_COLORS[r.cap_size] ?? "#6b7280") + "50",
              }}>
              {r.cap_size}
            </span>
          </td>
        );
      case "mktcap":
        return <td key={colId} className="px-2 py-1 text-gray-600 text-[11px] whitespace-nowrap" style={tdBase}>{fmtCap(r.market_cap, active?.exchange ?? "NSE")}</td>;
      case "price":
        return <td key={colId} className="px-2 py-1 font-bold text-[13px] tabular-nums" style={tdBase}>{r.price?.toLocaleString()}</td>;
      case "chg":
        return <td key={colId} className="px-2 py-1 font-semibold tabular-nums" style={{ ...tdBase, color: up ? "var(--mio-up)" : "var(--mio-dn)" }}>{up ? "+" : ""}{r.change_pct}%</td>;
      case "earnings":
        return (
          <td key={colId} className="px-2 py-1 whitespace-nowrap tabular-nums" style={{ ...tdBase, color: earningsColor(earnings[r.ticker] ?? ""), fontWeight: earnings[r.ticker] ? 600 : 400 }}>
            {fmtEarnings(earnings[r.ticker] ?? "") || "—"}
          </td>
        );
      case "volume":
        return (
          <td key={colId} className="px-2 py-1 tabular-nums" style={{ ...tdBase, color: volSurge ? "#ea580c" : "#4b5563" }}>
            {fmtVol(r.volume)}
            {volSurge && r.avg_vol_20 && <span className="ml-0.5 text-[10px] font-bold text-orange-500">⚡{(r.volume / r.avg_vol_20).toFixed(1)}×</span>}
          </td>
        );
      case "rsi":
        return (
          <td key={colId} className="px-2 py-1" style={tdBase}>
            {r.rsi != null
              ? <span className="inline-block tabular-nums font-bold px-1.5 py-0.5 rounded text-[11px]"
                  style={{ color: rc, backgroundColor: r.rsi > 70 ? "var(--mio-dn-bg)" : r.rsi < 30 ? "var(--mio-up-bg)" : "var(--mio-neutral-bg)" }}>
                  {r.rsi}
                </span>
              : <span className="text-gray-400">—</span>}
          </td>
        );
      case "macd":
        return (
          <td key={colId} className="px-2 py-1" style={tdBase}>
            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.macd_bullish ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
              {r.macd_bullish ? "▲ Bull" : "▼ Bear"}
            </span>
          </td>
        );
      case "sma20":
        return <td key={colId} className="px-2 py-1 tabular-nums" style={{ ...tdBase, color: r.sma20 != null && r.price > r.sma20 ? "var(--mio-up)" : "var(--mio-dn)" }}>{r.sma20 ?? "—"}</td>;
      case "sma50":
        return <td key={colId} className="px-2 py-1 tabular-nums" style={{ ...tdBase, color: r.sma50 != null && r.price > r.sma50 ? "var(--mio-up)" : "var(--mio-dn)" }}>{r.sma50 ?? "—"}</td>;
      case "sma200":
        return <td key={colId} className="px-2 py-1 tabular-nums" style={{ ...tdBase, color: r.sma200 != null && r.price > r.sma200 ? "var(--mio-up)" : "var(--mio-dn)" }}>{r.sma200 ?? "—"}</td>;
      case "h52":
        return <td key={colId} className="px-2 py-1 tabular-nums" style={{ ...tdBase, color: (r.pct_from_52w_high ?? -99) >= -5 ? "var(--mio-up)" : "var(--mio-text2)" }}>{r.pct_from_52w_high != null ? `${r.pct_from_52w_high}%` : "—"}</td>;
      case "days":
        return (
          <td key={colId} className="px-2 py-1 text-center" style={tdBase}>
            {dayCount != null
              ? <span
                  title={`In this scan for ${dayCount} consecutive day${dayCount > 1 ? "s" : ""}`}
                  className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums"
                  style={{
                    backgroundColor: dayCount >= 3 ? "#dcfce7" : dayCount >= 2 ? "#fef9c3" : "#f3f4f6",
                    color:           dayCount >= 3 ? "#15803d" : dayCount >= 2 ? "#92400e" : "#6b7280",
                  }}>
                  {dayCount}d
                </span>
              : <span className="text-gray-300 text-[10px]">1d</span>}
          </td>
        );
      case "chart":
        return <td key={colId} className="px-0 py-0" style={tdBase}>{r.sparkline.length > 0 && <Sparkline data={r.sparkline} positive={up} />}</td>;
      default:
        return <td key={colId} />;
    }
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
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
        <button onClick={()=>goToPage(Math.max(1,page-1))} disabled={page===1} className="px-2 py-0.5 border border-gray-300 rounded disabled:opacity-40" style={{color:"var(--mio-ticker)"}}>◀</button>
        {Array.from({length:Math.min(total,7)},(_,i)=>{
          const p=total<=7?i+1:page<=4?i+1:page>=total-3?total-6+i:page-3+i;
          return <button key={p} onClick={()=>goToPage(p)} className="w-6 h-5 rounded text-center"
            style={{backgroundColor:page===p?"var(--mio-accent)":undefined,color:page===p?"white":"var(--mio-ticker)",border:page===p?"none":"1px solid #d1d5db"}}>{p}</button>;
        })}
        <button onClick={()=>goToPage(Math.min(total,page+1))} disabled={page===total} className="px-2 py-0.5 border border-gray-300 rounded disabled:opacity-40" style={{color:"var(--mio-ticker)"}}>▶</button>
      </div>}
      <button onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
        className="px-2 py-0.5 border border-gray-300 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-50">↑ Top</button>
    </div>;
  }

  const showEditor = editing !== null;

  return (
    <div className="flex h-full" style={{minHeight:"calc(100vh - 48px)"}}>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── Action bar ──────────────────────────────────────────────────── */}
        <div className="px-2 md:px-3 py-1.5 border-b border-gray-200 bg-slate-50 flex items-center flex-wrap gap-1.5 md:gap-2 text-xs shrink-0 shadow-sm">
          <button onClick={()=>setEditing("new")}
            className="px-3 py-1 rounded font-semibold text-white text-[11px] flex items-center gap-1 shadow-sm"
            style={{backgroundColor:"var(--mio-accent)"}}>
            + New Setup Scan
          </button>
          <button onClick={()=>setShowFavorites(v=>!v)}
            className="px-3 py-1 rounded text-[11px] font-semibold border flex items-center gap-1"
            style={{
              backgroundColor: showFavorites ? "#fef3c7" : "white",
              borderColor:     showFavorites ? "#f59e0b" : "#d1d5db",
              color:           showFavorites ? "#b45309" : "#374151",
            }}>
            {showFavorites ? "★" : "☆"} Favorites ({Object.keys(favorites).length})
          </button>

          {/* Recent scanners — hidden on mobile */}
          {recentScreeners.length > 0 && (
            <>
              <div className="hidden md:block h-4 w-px bg-gray-200 mx-0.5 shrink-0"/>
              <span className="hidden md:inline text-[10px] text-gray-400 shrink-0">Recent:</span>
              {recentScreeners.map(s => (
                <button key={s.id} onClick={() => runScreen(s, asOfDate)}
                  title={s.formula}
                  className="hidden md:flex px-2.5 py-1 rounded border border-gray-200 text-[11px] text-gray-600 bg-white hover:bg-blue-50 hover:border-blue-400 hover:text-blue-700 transition-colors max-w-[130px] truncate items-center gap-1 shrink-0">
                  <span className="text-gray-400 text-[10px]">↺</span>{s.name}
                </button>
              ))}
            </>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {displayResults.length > 0 && (
              <button onClick={exportCSV}
                title={`Export ${displayResults.length} results to CSV`}
                className="px-2.5 py-1 rounded border border-gray-200 bg-white text-[11px] text-gray-500 hover:bg-green-50 hover:border-green-400 hover:text-green-700 transition-colors flex items-center gap-1 shrink-0">
                ↓ CSV
              </button>
            )}
            {asOfDate && <span className="hidden md:inline text-amber-600 text-[10px] font-semibold">← historical</span>}
            <input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)}
              className="hidden md:block border border-gray-200 rounded px-1.5 py-0.5 text-[11px] bg-white text-gray-700 focus:outline-none focus:border-blue-400" />
            {asOfDate && (
              <button onClick={() => { setAsOfDate(""); if (active) runScreen(active, ""); }}
                className="px-2 py-0.5 rounded border border-blue-300 bg-blue-50 text-blue-600 hover:bg-blue-100 text-[10px] font-semibold whitespace-nowrap">
                Today
              </button>
            )}
          </div>
        </div>

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
                      style={{backgroundColor:favView===v?"var(--mio-accent)":"white",color:favView===v?"white":"var(--mio-ticker)",borderRight:v==="overview"?"1px solid #e5e7eb":undefined}}>
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
                <table className="text-xs w-full">
                  <thead>
                    <tr className="bg-gray-100 sticky top-0 z-10 border-b-2 border-gray-200">
                      <th className="px-1 py-1.5 w-6 text-center text-gray-500 font-semibold text-[11px]">★</th>
                      <th className="px-2 py-1.5 text-gray-500 font-semibold text-[11px] w-7">#</th>
                      <th className="px-2 py-1.5 text-left font-semibold text-gray-600 text-[11px]">Symbol</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Company</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Sector</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Cap</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Price</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Chg %</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">Volume</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">RSI</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">MACD</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">SMA20</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">SMA50</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px]">% 52H</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px] whitespace-nowrap">Earnings</th>
                      <th className="px-2 py-1.5 font-semibold text-gray-600 text-[11px] text-center">Chart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {favPaged.map((r,idx)=>{
                      const up=(r.change_pct??0)>=0;
                      const rc=r.rsi==null?"#aaa":r.rsi>70?"var(--mio-dn)":r.rsi<30?"var(--mio-up)":"#222";
                      const volSurge = !!(r.avg_vol_20 && r.avg_vol_20 > 0 && r.volume > r.avg_vol_20 * 2);
                      return <tr key={r.ticker} className={`${volSurge?"bg-orange-50/60 hover:bg-orange-50":"hover:bg-slate-50"} border-b border-gray-100 transition-all`}>
                        <td className="px-1 py-1 text-center">
                          <button onClick={()=>toggleFavorite(r)} title="Remove from favorites"
                            className="text-base leading-none" style={{color:"#f59e0b"}}>★</button>
                        </td>
                        <td className="px-2 py-1 text-gray-400">{(page-1)*pageSize+idx+1}</td>
                        <td className="px-2 py-1 font-bold whitespace-nowrap" style={{color:"var(--mio-ticker)"}}>
                          {r.symbol}{r.new_52w_high&&<span className="ml-1 text-[10px] bg-green-100 text-green-700 rounded px-1">52H</span>}
                        </td>
                        <td className="px-2 py-1 max-w-[140px] truncate text-gray-700">{r.name}</td>
                        <td className="px-2 py-1"><span className="bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 text-[10px]">{r.sector}</span></td>
                        <td className="px-2 py-1"><span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{color:CAP_COLORS[r.cap_size]??"#6b7280",backgroundColor:(CAP_COLORS[r.cap_size]??"#6b7280")+"18",border:"1px solid "+(CAP_COLORS[r.cap_size]??"#6b7280")+"50"}}>{r.cap_size}</span></td>
                        <td className="px-2 py-1 font-bold text-[13px] tabular-nums">{r.price?.toLocaleString()}</td>
                        <td className="px-2 py-1 font-semibold tabular-nums" style={{color:up?"var(--mio-up)":"var(--mio-dn)"}}>{up?"+":""}{r.change_pct}%</td>
                        <td className="px-2 py-1 tabular-nums" style={{color:volSurge?"#ea580c":"#4b5563"}}>
                          {fmtVol(r.volume)}{volSurge&&r.avg_vol_20&&<span className="ml-0.5 text-[10px] font-bold text-orange-500">⚡{(r.volume/r.avg_vol_20).toFixed(1)}×</span>}
                        </td>
                        <td className="px-2 py-1">
                          {r.rsi!=null
                            ? <span className="inline-block tabular-nums font-bold px-1.5 py-0.5 rounded text-[11px]"
                                style={{color:rc,backgroundColor:r.rsi>70?"#fee2e2":r.rsi<30?"#dcfce7":"#f3f4f6"}}>
                                {r.rsi}
                              </span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-2 py-1">
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.macd_bullish?"bg-green-100 text-green-700":"bg-red-100 text-red-600"}`}>
                            {r.macd_bullish?"▲ Bull":"▼ Bear"}
                          </span>
                        </td>
                        <td className="px-2 py-1 tabular-nums" style={{color:r.sma20!=null&&r.price>r.sma20?"var(--mio-up)":"var(--mio-dn)"}}>{r.sma20??"—"}</td>
                        <td className="px-2 py-1 tabular-nums" style={{color:r.sma50!=null&&r.price>r.sma50?"var(--mio-up)":"var(--mio-dn)"}}>{r.sma50??"—"}</td>
                        <td className="px-2 py-1 tabular-nums" style={{color:(r.pct_from_52w_high??-99)>=-5?"var(--mio-up)":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</td>
                        <td className="px-2 py-1 whitespace-nowrap tabular-nums" style={{color:earningsColor(earnings[r.ticker]??""),fontWeight:earnings[r.ticker]?600:400}}>{fmtEarnings(earnings[r.ticker]??"")}</td>
                        <td className="px-0 py-0">{r.sparkline.length>0&&<Sparkline data={r.sparkline} positive={up}/>}</td>
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
                  const rsiCol=r.rsi==null?"#aaa":r.rsi>70?"var(--mio-dn)":r.rsi<30?"var(--mio-up)":"#222";
                  return (
                    <div key={r.ticker} className="border border-gray-200 rounded bg-white shadow-sm overflow-hidden w-full">
                      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-100">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <button onClick={()=>toggleFavorite(r)} title="Remove from favorites"
                            className="text-xl leading-none shrink-0" style={{color:"#f59e0b"}}>★</button>
                          <span className="font-bold text-base" style={{color:"var(--mio-ticker)"}}>{r.symbol}</span>
                          {r.new_52w_high&&<span className="text-[10px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-gray-700 font-medium truncate block">{r.name}</span>
                          <span className="text-[11px] text-gray-400">{r.sector} · {r.industry}</span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-lg tabular-nums">{r.price?.toLocaleString()}</div>
                          <div className="text-sm font-semibold tabular-nums" style={{color:up?"var(--mio-up)":"var(--mio-dn)"}}>{up?"+":""}{r.change_pct}%</div>
                        </div>
                        <div className="flex gap-4 text-xs text-gray-500 shrink-0 pl-4 border-l border-gray-100">
                          <div>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></div>
                          <div style={{color:r.macd_bullish?"var(--mio-up)":"var(--mio-dn)",fontWeight:600}}>{r.macd_bullish?"▲ MACD Bull":"▼ MACD Bear"}</div>
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
            <div className="border-b border-gray-200 bg-slate-50 text-xs">
              {/* Row 1: scan info + view tabs */}
              <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap">
                {active ? (
                  <>
                    <span className="font-bold" style={{color:"var(--mio-accent)"}}>{active.name}</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-500">{active.exchange}</span>
                    {active.interval && active.interval !== "1d" && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-600">
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
                      void tick;
                      return <>
                        <span className="text-gray-300">·</span>
                        <span className="font-semibold" style={{color:"var(--mio-accent)"}}>{displayResults.length} match{displayResults.length!==1?"es":""}{displayResults.length!==results.length?` (${results.length} total)`:""}</span>
                        {scanDuration != null && <>
                          <span className="text-gray-300">·</span>
                          <span className="text-gray-400">{scanDuration < 1000 ? `${scanDuration}ms` : `${(scanDuration/1000).toFixed(1)}s`}</span>
                        </>}
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
                {/* Re-run button */}
                {active && !loading && (
                  <button
                    onClick={() => runScreen(active, asOfDate)}
                    title="Re-run this scan (R)"
                    className="px-2.5 py-1 rounded border text-[11px] flex items-center gap-1 transition-colors"
                    style={{ borderColor: "#d1d5db", color: "#374151", backgroundColor: "white" }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#eff6ff"; e.currentTarget.style.borderColor = "#93c5fd"; }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = "white"; e.currentTarget.style.borderColor = "#d1d5db"; }}>
                    ↺ Re-run
                  </button>
                )}
                {/* Restored-from-cache banner */}
                {restored && !loading && results.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700">
                    Restored · re-run to refresh
                  </span>
                )}
                {error && <span className="text-red-500">{error}</span>}
                {warning && <span className="text-amber-600 text-[10px] max-w-lg leading-tight">{warning}</span>}

                {/* View tabs — right side */}
                {!loading && results.length>0 && (
                  <div className="ml-auto flex items-center gap-2 flex-wrap">
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

                    {/* Columns button */}
                    {view === "overview" && (
                      <div className="relative">
                        <button
                          onClick={() => setShowColMenu(v => !v)}
                          className="px-2.5 py-1 rounded border text-[11px] flex items-center gap-1 transition-colors"
                          style={{
                            borderColor:     showColMenu ? "#3b82f6" : "#d1d5db",
                            backgroundColor: showColMenu ? "#eff6ff" : "white",
                            color:           showColMenu ? "#2563eb" : "#374151",
                          }}>
                          ⊞ Columns
                          {hiddenCols.size > 0 && (
                            <span className="px-1 rounded text-[10px] font-bold bg-blue-100 text-blue-700">{ALL_COL_IDS.length - FIXED_COL_IDS.size - hiddenCols.size + hiddenCols.size === 0 ? "" : `−${hiddenCols.size}`}</span>
                          )}
                        </button>
                        {showColMenu && (
                          <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-xl p-2 w-52"
                            style={{ maxHeight: 400, overflowY: "auto" }}>
                            <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide px-1 pb-1.5 mb-1 border-b border-gray-100">
                              Show / hide · drag headers to reorder
                            </div>
                            {colOrder.filter(id => !FIXED_COL_IDS.has(id)).map(id => {
                              const def = ALL_COLS.find(c => c.id === id)!;
                              const hidden = hiddenCols.has(id);
                              return (
                                <label key={id}
                                  className="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer hover:bg-gray-50 text-[11px] text-gray-700 select-none">
                                  <input type="checkbox" checked={!hidden} onChange={() => toggleHidden(id)}
                                    className="accent-blue-600 w-3 h-3" />
                                  {def.label}
                                </label>
                              );
                            })}
                            <div className="border-t border-gray-100 mt-1.5 pt-1.5 flex gap-1">
                              <button
                                onClick={() => saveHiddenCols(new Set())}
                                className="flex-1 text-[10px] py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">
                                Show all
                              </button>
                              <button
                                onClick={() => saveColOrder([...ALL_COL_IDS])}
                                className="flex-1 text-[10px] py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50">
                                Reset order
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* View toggle */}
                    <div className="flex border border-gray-200 rounded overflow-hidden">
                      {(["overview","charts"] as const).map(v=>(
                        <button key={v} onClick={()=>setView(v)}
                          className="px-3 py-1 text-[11px] font-medium capitalize transition-colors"
                          style={{backgroundColor:view===v?"var(--mio-accent)":"white",color:view===v?"white":"#374151",borderRight:v==="overview"?"1px solid #e5e7eb":undefined}}>
                          {v==="overview"?"📋 Table":"📈 Charts"}
                        </button>
                      ))}
                    </div>
                    {/* Chart controls */}
                    {view==="charts" && (
                      <>
                        <div className="flex border border-gray-200 rounded overflow-hidden">
                          {(["sm","md","lg"] as const).map((s,i)=>(
                            <button key={s} onClick={()=>setChartSize(s)}
                              className="px-2 py-1 text-[10px] font-medium transition-colors"
                              style={{backgroundColor:chartSize===s?"#e8f0fe":"white",color:chartSize===s?"var(--mio-accent)":"#888",borderRight:i<2?"1px solid #e5e7eb":undefined}}>
                              {s.toUpperCase()}
                            </button>
                          ))}
                        </div>
                        <div className="flex border border-gray-200 rounded overflow-hidden">
                          <button onClick={()=>setChartCols(1)}
                            className="px-2.5 py-1 text-[10px] font-medium transition-colors"
                            style={{backgroundColor:chartCols===1?"#e8f0fe":"white",color:chartCols===1?"var(--mio-accent)":"#888",borderRight:"1px solid #e5e7eb"}}
                            title="1 column">▬</button>
                          <button onClick={()=>setChartCols(2)}
                            className="px-2.5 py-1 text-[10px] font-medium transition-colors"
                            style={{backgroundColor:chartCols===2?"#e8f0fe":"white",color:chartCols===2?"var(--mio-accent)":"#888"}}
                            title="2 columns">⊞</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2: sector chips */}
              {!loading && sectorCounts.length>0 && (
                <div className="px-3 pb-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 shrink-0">Sectors:</span>
                  <div className="relative flex-1 min-w-0">
                    <div className="flex gap-1.5 items-center overflow-x-auto" style={{scrollbarWidth:"none",msOverflowStyle:"none"}}>
                      {sectorCounts.map(([sec,cnt])=>(
                        <button key={sec} onClick={()=>{setSF(sectorFilter===sec?"All":sec);setRS("");goToPage(1);}}
                          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors"
                          style={{
                            backgroundColor: sectorFilter===sec?"var(--mio-accent)":"#f1f5f9",
                            color:           sectorFilter===sec?"white":"#475569",
                            borderColor:     sectorFilter===sec?"var(--mio-accent)":"#e2e8f0",
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

            {/* Loading */}
            {loading && <ScanProgress progress={scanProgress} startMs={scanStartRef.current} exchange={active?.exchange??""} />}

            {/* Empty */}
            {!loading && !active && (
              <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                <div className="text-5xl mb-3">📊</div>
                <div className="text-sm font-medium">Click a screen to run it</div>
                <div className="text-xs mt-1 text-gray-300">or click "+ New Setup Scan" to create one</div>
              </div>
            )}

            {/* ── Overview table (dynamic columns) ───────────────────────── */}
            {!loading && results.length>0 && view==="overview" && (
              <div ref={resultsRef} className="flex-1 overflow-auto flex flex-col" onClick={() => showColMenu && setShowColMenu(false)}>
                <table className="text-xs" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
                  <thead>
                    <tr className="bg-gray-100 sticky top-0 z-10 border-b-2 border-gray-200">
                      {visibleCols.map(id => {
                        const def = ALL_COLS.find(c => c.id === id)!;
                        return <ColTH key={id} id={id} defW={def.defW} />;
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((r,idx)=>{
                      const volSurge = !!(r.avg_vol_20 && r.avg_vol_20 > 0 && r.volume > r.avg_vol_20 * 2);
                      return (
                        <tr key={r.ticker}
                          className={`${volSurge?"bg-orange-50/60 hover:bg-orange-50":"hover:bg-slate-50"} ${volSurge?"hover:shadow-[inset_3px_0_0_#f97316]":"hover:shadow-[inset_3px_0_0_#3b82f6]"} border-b border-gray-100 transition-all`}>
                          {visibleCols.map(colId => {
                            const cell = renderCell(colId, r, idx);
                            return cell ? cloneElement(cell as React.ReactElement<{'data-col'?:string}>, { 'data-col': colId }) : null;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Pagination count={displayResults.length} total={totalPages}/>
              </div>
            )}

            {/* ── Charts view ─────────────────────────────────────────────── */}
            {!loading && results.length>0 && view==="charts" && (
              <div ref={resultsRef} className="flex-1 overflow-auto flex flex-col">
                {/* Master zoom bar */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50 sticky top-0 z-10">
                  <span className="text-xs text-gray-500 font-medium">Zoom all charts</span>
                  <div className="flex items-center border border-gray-300 rounded overflow-hidden">
                    <button
                      onClick={() => setMasterZoom(v => Math.min(300, v + Math.max(1, Math.round(v * 0.15))))}
                      className="px-3 py-1 hover:bg-gray-200 text-gray-600 font-bold text-base leading-none border-r border-gray-300 transition-colors"
                      title="Zoom out">−</button>
                    <span className="px-2 text-xs text-gray-500 tabular-nums min-w-[40px] text-center">{masterZoom}b</span>
                    <button
                      onClick={() => setMasterZoom(v => Math.max(10, v - Math.max(1, Math.round(v * 0.15))))}
                      className="px-3 py-1 hover:bg-gray-200 text-gray-600 font-bold text-base leading-none border-l border-gray-300 transition-colors"
                      title="Zoom in">+</button>
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
                    const rsiCol=r.rsi==null?"#aaa":r.rsi>70?"var(--mio-dn)":r.rsi<30?"var(--mio-up)":"#222";
                    const isNew    = prevTickerSet !== null && !prevTickerSet.has(r.ticker);
                    const isRepeat = prevTickerSet !== null && prevTickerSet.has(r.ticker);
                    const dayCount = daysInScanMap[r.ticker];
                    return (
                      <div key={r.ticker} id={`chart-${r.ticker}`} className="border rounded bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden" style={{borderColor: jumpToTicker===r.ticker ? "var(--mio-accent)" : "#e5e7eb", outline: jumpToTicker===r.ticker ? "2px solid #93c5fd" : "none", outlineOffset: "1px"}}>
                        {chartCols===1 ? (
                          <div className="flex items-center gap-4 px-4 py-2.5 border-b border-gray-100">
                            <div className="flex items-center gap-2 min-w-[120px]">
                              <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                                className="text-xl leading-none transition-colors shrink-0"
                                style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                                {favorites[r.ticker] ? "★" : "☆"}
                              </button>
                              <span className="font-bold text-base" style={{color:"var(--mio-ticker)"}}>{r.symbol}</span>
                              {r.new_52w_high&&<span className="text-[10px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                              {isNew   &&<span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1 font-semibold" title="New vs yesterday">🆕</span>}
                              {isRepeat&&<span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1" title="Was in yesterday's scan">✓</span>}
                              {dayCount != null && dayCount > 1 && (
                                <span className="text-[10px] px-1 rounded font-bold"
                                  style={{ backgroundColor: dayCount >= 3 ? "#dcfce7" : "#fef9c3", color: dayCount >= 3 ? "#15803d" : "#92400e" }}>
                                  {dayCount}d
                                </span>
                              )}
                              {watchlistSyms.has(r.symbol) && (
                                <span className="text-[10px] px-1 rounded font-bold" title="In your watchlist"
                                  style={{ backgroundColor: "#fef3c7", color: "#b45309", border: "1px solid #fcd34d" }}>WL</span>
                              )}
                              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{color:CAP_COLORS[r.cap_size]??"#6b7280",backgroundColor:(CAP_COLORS[r.cap_size]??"#6b7280")+"18",border:"1px solid "+(CAP_COLORS[r.cap_size]??"#6b7280")+"50"}}>{r.cap_size}</span>
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
                              <div className="text-sm font-semibold tabular-nums" style={{color:up?"var(--mio-up)":"var(--mio-dn)"}}>{up?"+":""}{r.change_pct}%</div>
                            </div>
                            <div className="flex flex-col justify-center gap-0.5 text-xs text-gray-500 shrink-0 pl-4 border-l border-gray-100">
                              {/* Row 1: momentum + volume */}
                              <div className="flex items-center gap-3">
                                <span>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></span>
                                <span style={{color:r.macd_bullish?"var(--mio-up)":"var(--mio-dn)",fontWeight:600}}>{r.macd_bullish?"▲ MACD Bull":"▼ MACD Bear"}</span>
                                <span>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></span>
                                <span>{fmtCap(r.market_cap,active?.exchange??"NSE")}</span>
                                {earnings[r.ticker] && <span>E: <strong style={{color:earningsColor(earnings[r.ticker])}}>{fmtEarnings(earnings[r.ticker])}</strong></span>}
                              </div>
                              {/* Row 2: price context */}
                              <div className="flex items-center gap-3 text-gray-400">
                                <span>SMA20 <strong className="text-gray-600">{r.sma20??"—"}</strong></span>
                                <span>SMA50 <strong className="text-gray-600">{r.sma50??"—"}</strong></span>
                                <span>%52H <strong style={{color:(r.pct_from_52w_high??-99)>=-5?"var(--mio-up)":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</strong></span>
                                <a href={tvUrl(r.ticker,active?.exchange??"")} target="_blank" rel="noopener noreferrer"
                                  className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors whitespace-nowrap"
                                  title="Open on TradingView">TV ↗</a>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="px-3 py-2 border-b border-gray-100">
                            <div className="flex items-center gap-1.5">
                              <button onClick={()=>toggleFavorite(r)} title={favorites[r.ticker]?"Remove from favorites":"Add to favorites"}
                                className="text-base leading-none transition-colors shrink-0"
                                style={{color: favorites[r.ticker] ? "#f59e0b" : "#d1d5db"}}>
                                {favorites[r.ticker] ? "★" : "☆"}
                              </button>
                              <span className="font-bold text-sm" style={{color:"var(--mio-ticker)"}}>{r.symbol}</span>
                              {r.new_52w_high&&<span className="text-[10px] bg-green-100 text-green-700 rounded px-1 font-semibold">52H</span>}
                              {isNew   &&<span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1 font-semibold" title="New vs yesterday">🆕</span>}
                              {isRepeat&&<span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1" title="Was in yesterday's scan">✓</span>}
                              {dayCount != null && dayCount > 1 && (
                                <span className="text-[10px] px-1 rounded font-bold"
                                  style={{ backgroundColor: dayCount >= 3 ? "#dcfce7" : "#fef9c3", color: dayCount >= 3 ? "#15803d" : "#92400e" }}>
                                  {dayCount}d
                                </span>
                              )}
                              {watchlistSyms.has(r.symbol) && (
                                <span className="text-[10px] px-1 rounded font-bold" title="In your watchlist"
                                  style={{ backgroundColor: "#fef3c7", color: "#b45309", border: "1px solid #fcd34d" }}>WL</span>
                              )}
                              <span className="rounded px-1 py-0.5 text-[10px] font-semibold" style={{color:CAP_COLORS[r.cap_size]??"#6b7280",backgroundColor:(CAP_COLORS[r.cap_size]??"#6b7280")+"18",border:"1px solid "+(CAP_COLORS[r.cap_size]??"#6b7280")+"50"}}>{r.cap_size}</span>
                              <div className="flex-1 min-w-0 mx-1">
                                <span className="text-xs text-gray-600 font-medium truncate block">{r.name}</span>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-semibold text-sm tabular-nums">{r.price?.toLocaleString()}</div>
                                <div className="text-xs font-semibold tabular-nums" style={{color:up?"var(--mio-up)":"var(--mio-dn)"}}>{up?"+":""}{r.change_pct}%</div>
                              </div>
                            </div>
                            <div className="flex gap-2.5 mt-1.5 text-[10px] text-gray-500 flex-wrap">
                              <span>RSI <strong style={{color:rsiCol}}>{r.rsi??"—"}</strong></span>
                              <span style={{color:r.macd_bullish?"var(--mio-up)":"var(--mio-dn)",fontWeight:600}}>{r.macd_bullish?"▲ Bull":"▼ Bear"}</span>
                              <span>Vol <strong className="text-gray-700">{fmtVol(r.volume)}</strong></span>
                              <span className="text-gray-400">%52H <strong style={{color:(r.pct_from_52w_high??-99)>=-5?"var(--mio-up)":"#555"}}>{r.pct_from_52w_high!=null?`${r.pct_from_52w_high}%`:"—"}</strong></span>
                              {earnings[r.ticker] && <span style={{color:earningsColor(earnings[r.ticker]),fontWeight:600}}>E:{fmtEarnings(earnings[r.ticker])}</span>}
                              <a href={tvUrl(r.ticker,active?.exchange??"")} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] px-1 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors whitespace-nowrap"
                                title="Open on TradingView">TV ↗</a>
                            </div>
                          </div>
                        )}
                        <InteractiveChart data={r.ohlcv} masterBars={masterZoom} priceHeight={CHART_H[chartSize]}/>
                      </div>
                    );
                  })}
                </div>
                <Pagination count={displayResults.length} total={totalPages}/>
              </div>
            )}

            {!loading && active && results.length===0 && !error && (
              <div className="flex flex-col items-center justify-center flex-1 py-20 select-none">
                <div className="text-5xl mb-4 opacity-40">🔍</div>
                <div className="text-sm font-semibold text-gray-500 mb-1">No matches found</div>
                <div className="text-xs text-gray-400 mb-1">
                  <span className="font-medium" style={{color:"var(--mio-accent)"}}>{active.name}</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span>{active.exchange}</span>
                  {active.interval && active.interval !== "1d" && <>
                    <span className="mx-1 text-gray-300">·</span>
                    <span>{active.interval}</span>
                  </>}
                  {scanDuration != null && <>
                    <span className="mx-1 text-gray-300">·</span>
                    <span>{scanDuration < 1000 ? `${scanDuration}ms` : `${(scanDuration/1000).toFixed(1)}s`}</span>
                  </>}
                </div>
                <div className="text-xs text-gray-300 max-w-xs text-center leading-relaxed mt-1">
                  Try relaxing the formula conditions, switching the exchange, or checking a historical date.
                </div>
                <button onClick={()=>setEditing(active)}
                  className="mt-5 px-4 py-1.5 rounded border border-gray-300 text-xs text-gray-500 hover:bg-gray-50 hover:border-gray-400 transition-colors">
                  Edit Formula
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
