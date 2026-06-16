// ── Misc ───────────────────────────────────────────────────────────────────
export const uid = () => Math.random().toString(36).slice(2, 9);

// ── Recently used screeners ─────────────────────────────────────────────────
import type { SavedScreener } from "./types";
const RECENT_KEY = "mio_recent_v1";
export function getRecentScreeners(): SavedScreener[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); }
  catch { return []; }
}
export function saveRecentScreener(s: SavedScreener) {
  try {
    const prev = getRecentScreeners().filter(r => r.id !== s.id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([s, ...prev].slice(0, 2)));
  } catch {}
}

// ── Scan history (localStorage) ────────────────────────────────────────────
export const HIST_KEY = "mio_scan_hist_v1_"; // + screenerId

export function getScanHistory(screenerId: string): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(HIST_KEY + screenerId) ?? "{}"); }
  catch { return {}; }
}

export function saveScanHistory(screenerId: string, date: string, tickers: string[]) {
  const hist = getScanHistory(screenerId);
  hist[date] = tickers;
  // Keep 7 most recent dates
  const pruned: Record<string, string[]> = {};
  Object.keys(hist).sort().slice(-7).forEach(k => { pruned[k] = hist[k]; });
  try { localStorage.setItem(HIST_KEY + screenerId, JSON.stringify(pruned)); } catch {}
}

// ── Market cap formatter ────────────────────────────────────────────────────
export function fmtCap(cap: number | null, exchange: string) {
  if (cap == null) return "—";
  if (exchange === "NSE" || exchange === "BSE") {
    if (cap >= 100000) return `₹${(cap / 100000).toFixed(1)}L Cr`;
    if (cap >= 1000)   return `₹${(cap / 1000).toFixed(0)}K Cr`;
    return `₹${cap} Cr`;
  }
  if (exchange === "TSE") {
    if (cap >= 1000000) return `¥${(cap / 1000000).toFixed(1)}T`;
    if (cap >= 1000)    return `¥${(cap / 1000).toFixed(0)}B`;
    return `¥${cap}M`;
  }
  if (exchange === "KOSPI" || exchange === "KOSDAQ") {
    if (cap >= 1000000) return `₩${(cap / 1000000).toFixed(1)}T`;
    if (cap >= 1000)    return `₩${(cap / 1000).toFixed(0)}B`;
    return `₩${cap}M`;
  }
  if (exchange === "XETRA") {
    if (cap >= 1000000) return `€${(cap / 1000000).toFixed(1)}T`;
    if (cap >= 1000)    return `€${(cap / 1000).toFixed(0)}B`;
    return `€${cap}M`;
  }
  if (exchange === "TWSE") {
    if (cap >= 1000000) return `NT$${(cap / 1000000).toFixed(1)}T`;
    if (cap >= 1000)    return `NT$${(cap / 1000).toFixed(0)}B`;
    return `NT$${cap}M`;
  }
  if (exchange === "SSE") {
    if (cap >= 1000000) return `¥${(cap / 1000000).toFixed(1)}T`;
    if (cap >= 1000)    return `¥${(cap / 1000).toFixed(0)}B`;
    return `¥${cap}M`;
  }
  if (cap >= 1000000) return `$${(cap / 1000000).toFixed(1)}T`;
  if (cap >= 1000)    return `$${(cap / 1000).toFixed(0)}B`;
  return `$${cap}M`;
}

// ── Volume formatter ────────────────────────────────────────────────────────
export function fmtVol(v: number) {
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
       : v >= 1000      ? `${(v / 1000).toFixed(0)}K`
       : `${v}`;
}

// ── TradingView URL helper ──────────────────────────────────────────────────
export function tvUrl(ticker: string, exchange?: string): string {
  const ex = exchange || (
    ticker.endsWith(".NS") ? "NSE"    :
    ticker.endsWith(".BO") ? "BSE"    :
    ticker.endsWith(".T")  ? "TSE"    :
    ticker.endsWith(".KS") ? "KOSPI"  :
    ticker.endsWith(".KQ") ? "KOSDAQ" :
    ticker.endsWith(".DE") ? "XETRA"  :
    ticker.endsWith(".TW") ? "TWSE"   :
    (ticker.endsWith(".SS") || ticker.endsWith(".SZ")) ? "SSE" : ""
  );
  let sym: string;
  if      (ex === "NSE")    sym = `NSE:${ticker.replace(".NS", "").replace(".BO", "")}`;
  else if (ex === "BSE")    sym = `BSE:${ticker.replace(".BO", "").replace(".NS", "")}`;
  else if (ex === "TSE")    sym = `TSE:${ticker.replace(".T", "")}`;
  else if (ex === "KOSPI")  sym = `KRX:${ticker.replace(".KS", "")}`;
  else if (ex === "KOSDAQ") sym = `KOSDAQ:${ticker.replace(".KQ", "")}`;
  else if (ex === "XETRA")  sym = `XETR:${ticker.replace(".DE", "")}`;
  else if (ex === "TWSE")   sym = `TWSE:${ticker.replace(".TW", "")}`;
  // China: Shanghai (.SS) → SSE prefix, Shenzhen (.SZ) → SZSE prefix
  else if (ex === "SSE")    sym = ticker.endsWith(".SZ")
                                  ? `SZSE:${ticker.replace(".SZ", "")}`
                                  : `SSE:${ticker.replace(".SS", "")}`;
  else sym = ticker.replace(/\.(NS|BO|T|KS|KQ|DE|TW|SS|SZ)$/, ""); // US: no prefix
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
}

// ── Earnings date helpers ───────────────────────────────────────────────────
export function fmtEarnings(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr.replace(/-/g, " "));
  if (isNaN(d.getTime())) return dateStr;
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${mon[d.getMonth()]}`;
}

export function earningsColor(dateStr: string): string {
  if (!dateStr) return "#9ca3af";
  const d = new Date(dateStr.replace(/-/g, " "));
  if (isNaN(d.getTime())) return "#374151";
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  return days <= 14 ? "#d97706" : "#374151";
}
