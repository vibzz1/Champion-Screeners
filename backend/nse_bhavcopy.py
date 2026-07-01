"""
nse_bhavcopy.py — NSE Bhavcopy downloader + SQLite OHLCV store

Replaces yfinance as the primary daily EOD data source for NSE screener runs.
Intraday (75 min) data still comes from Angel One — this module is daily-only.

Data flow:
  Nightly (~6:30pm IST):  update_today()          → downloads today's Bhavcopy → bhavcopy.db
  Cold-start:             backfill(days=400)       → downloads last N trading days (once)
  Screener at scan time:  load_ohlcv(tickers)      → Dict[str, DataFrame]  (same API as yfinance)

Volume units:
  Bhavcopy TURNOVER_LACS column = daily rupee turnover in LAKHS.
  We store it as the "TurnoverLacs" column in each ticker's DataFrame.
  compute_indicators() uses TurnoverLacs for avg_vol metrics when present,
  so advol(N) > X in formulas is correctly interpreted in LAKHS (matching MIO).
"""

import io
import os
import sqlite3
import datetime
import logging
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
import pandas as pd

log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
CACHE_DIR = Path(os.environ.get("CACHE_DIR", Path(__file__).parent / "cache"))
DB_PATH   = CACHE_DIR / "bhavcopy.db"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── HTTP session ───────────────────────────────────────────────────────────────
_sess:    Optional[requests.Session] = None
_sess_ts: float = 0.0
_SESS_TTL = 600   # re-init session every 10 min

_HEADERS = {
    "User-Agent":      ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/125.0.0.0 Safari/537.36"),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.nseindia.com/",
}

def _get_session() -> requests.Session:
    global _sess, _sess_ts
    if _sess and time.time() - _sess_ts < _SESS_TTL:
        return _sess
    s = requests.Session()
    s.headers.update(_HEADERS)
    try:
        s.get("https://www.nseindia.com", timeout=10)
        time.sleep(0.5)
    except Exception as e:
        log.debug(f"[bhavcopy] NSE session prime failed (non-fatal): {e}")
    _sess, _sess_ts = s, time.time()
    return s


# ── SQLite schema ──────────────────────────────────────────────────────────────
_SCHEMA = """
CREATE TABLE IF NOT EXISTS ohlcv (
    symbol       TEXT NOT NULL,
    date         TEXT NOT NULL,
    open         REAL,
    high         REAL,
    low          REAL,
    close        REAL,
    volume       INTEGER,
    turnover_lacs REAL,
    PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_sym_date ON ohlcv (symbol, date);

CREATE TABLE IF NOT EXISTS fetched_dates (
    date TEXT PRIMARY KEY,
    rows INTEGER,
    fetched_at TEXT
);
"""

def _get_conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    return c

def _init_db() -> None:
    with _get_conn() as c:
        c.executescript(_SCHEMA)

_init_db()


# ── Bhavcopy download ──────────────────────────────────────────────────────────
def _bhav_urls(d: datetime.date) -> List[str]:
    """Return candidate URLs for a given date (primary + fallback)."""
    ds = d.strftime("%d%m%Y")
    return [
        f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{ds}.csv",
        f"https://archives.nseindia.com/products/content/sec_bhavdata_full_{ds}.csv",
    ]


def _parse_bhav_csv(text: str, d: datetime.date) -> Optional[pd.DataFrame]:
    """Parse raw Bhavcopy CSV text into a clean DataFrame."""
    try:
        df = pd.read_csv(io.StringIO(text))
        df.columns = df.columns.str.strip()

        # Validate the file's internal trade date matches the requested date.
        # NSE sometimes serves the PREVIOUS day's file for a new date's URL
        # (holidays, or before the day's file is regenerated). Stamping the
        # requested date onto stale content silently duplicates the prior day
        # for every ticker. DATE1 (e.g. "25-Jun-2026") is the ground truth.
        date_col = next((c for c in df.columns if c.upper() == "DATE1"), None)
        if date_col is not None and len(df):
            try:
                internal = pd.to_datetime(
                    str(df[date_col].iloc[0]).strip(), format="%d-%b-%Y"
                ).date()
                if internal != d:
                    log.warning(f"[bhavcopy] {d}: file DATE1={internal} != requested "
                                f"{d} — rejecting stale/duplicate file")
                    return None
            except Exception as _e:
                log.warning(f"[bhavcopy] {d}: DATE1 parse failed ({_e}) — proceeding")

        # Keep EQ series (equity) only
        series_col = next((c for c in df.columns if c.upper() == "SERIES"), None)
        if series_col:
            df = df[df[series_col].str.strip() == "EQ"].copy()

        # Normalise column names across NSE format versions
        col_map = {
            "SYMBOL":       "symbol",
            "OPEN_PRICE":   "open",
            "HIGH_PRICE":   "high",
            "LOW_PRICE":    "low",
            "CLOSE_PRICE":  "close",
            "TTL_TRD_QNTY": "volume",
            "TURNOVER_LACS":"turnover_lacs",
            # older format aliases
            "OPEN":    "open",
            "HIGH":    "high",
            "LOW":     "low",
            "CLOSE":   "close",
            "TOTTRDQTY": "volume",
        }
        df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})

        required = {"symbol", "open", "high", "low", "close", "volume"}
        if not required.issubset(df.columns):
            log.warning(f"[bhavcopy] {d}: unexpected columns {list(df.columns)}")
            return None

        df["symbol"] = df["symbol"].str.strip()
        df["date"]   = d.isoformat()
        for col in ["open", "high", "low", "close"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype(int)

        if "turnover_lacs" in df.columns:
            df["turnover_lacs"] = pd.to_numeric(df["turnover_lacs"], errors="coerce")
        else:
            # Compute turnover in lakhs from price × volume
            df["turnover_lacs"] = (df["close"] * df["volume"]) / 100_000

        cols = ["symbol", "date", "open", "high", "low", "close", "volume", "turnover_lacs"]
        df = df[cols].dropna(subset=["close"])
        log.info(f"[bhavcopy] {d}: parsed {len(df)} EQ rows")
        return df
    except Exception as e:
        log.error(f"[bhavcopy] {d}: parse error — {e}")
        return None


def download_bhavcopy(d: datetime.date, retries: int = 3) -> Optional[pd.DataFrame]:
    """Download one day's Bhavcopy from NSE. Returns clean DataFrame or None."""
    sess = _get_session()
    for url in _bhav_urls(d):
        for attempt in range(retries):
            try:
                r = sess.get(url, timeout=25)
                if r.status_code == 404:
                    break   # holiday / weekend — try next URL
                if r.status_code == 200 and len(r.content) > 5_000:
                    df = _parse_bhav_csv(r.text, d)
                    if df is not None and not df.empty:
                        return df
                    break
                log.debug(f"[bhavcopy] {d} {url}: status={r.status_code} size={len(r.content)}")
            except Exception as e:
                log.warning(f"[bhavcopy] {d} attempt {attempt+1}: {e}")
                time.sleep(1.5 ** attempt)
    return None


def _is_already_stored(d: datetime.date) -> bool:
    with _get_conn() as c:
        return bool(c.execute(
            "SELECT 1 FROM fetched_dates WHERE date=?", (d.isoformat(),)
        ).fetchone())


def store_bhavcopy(df: pd.DataFrame, d: datetime.date) -> int:
    """Upsert one day's rows into the DB. Returns row count."""
    rows = df[["symbol","date","open","high","low","close","volume","turnover_lacs"]].values.tolist()
    with _get_conn() as c:
        c.executemany(
            "INSERT OR REPLACE INTO ohlcv "
            "(symbol,date,open,high,low,close,volume,turnover_lacs) VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        c.execute(
            "INSERT OR REPLACE INTO fetched_dates (date,rows,fetched_at) VALUES (?,?,?)",
            (d.isoformat(), len(rows), datetime.datetime.now().isoformat()),
        )
    return len(rows)


def download_and_store(d: datetime.date) -> bool:
    """Download + store one day. Skips if already stored. Returns True on success."""
    if _is_already_stored(d):
        return True
    df = download_bhavcopy(d)
    if df is None or df.empty:
        return False   # holiday / weekend / future date
    store_bhavcopy(df, d)
    return True


def purge_duplicate_dates() -> dict:
    """Remove any stored date whose bars are identical to the previous stored
    date — a stale/duplicate Bhavcopy file NSE served under a new date's URL
    (before the DATE1 validation existed). Keeps the earlier (real) date.
    Returns {"removed": [...], "checked": n}."""
    removed = []
    with _get_conn() as c:
        dates = [r[0] for r in c.execute(
            "SELECT DISTINCT date FROM ohlcv ORDER BY date").fetchall()]
        prev_rows = None
        for d in dates:
            rows = c.execute(
                "SELECT symbol,open,high,low,close,volume FROM ohlcv "
                "WHERE date=? ORDER BY symbol", (d,)).fetchall()
            if prev_rows is not None and len(rows) > 100 and rows == prev_rows:
                c.execute("DELETE FROM ohlcv WHERE date=?", (d,))
                c.execute("DELETE FROM fetched_dates WHERE date=?", (d,))
                removed.append(d)
                # keep prev_rows as the real prior date for the next comparison
            else:
                prev_rows = rows
        c.commit()
    return {"removed": removed, "checked": len(dates)}


# ── Backfill ───────────────────────────────────────────────────────────────────
def _candidate_weekdays(n_trading_days: int) -> List[datetime.date]:
    """Return enough past Mon-Fri dates to cover n_trading_days (roughly)."""
    days, d = [], datetime.date.today() - datetime.timedelta(days=1)
    while len(days) < n_trading_days * 2:
        if d.weekday() < 5:
            days.append(d)
        d -= datetime.timedelta(days=1)
    return days


def backfill(days: int = 400, delay: float = 0.35,
             progress_cb=None) -> Tuple[int, int]:
    """Download last `days` trading days of history.

    Args:
        days:        target number of trading days to fill
        delay:       seconds between requests (be polite to NSE)
        progress_cb: optional callback(done, total) for progress reporting

    Returns:
        (stored, skipped)  — skipped = weekends/holidays/already-stored
    """
    log.info(f"[bhavcopy] Backfill starting — target {days} trading days …")
    candidates = _candidate_weekdays(days)
    stored = already = skipped = 0

    for i, d in enumerate(candidates):
        if stored >= days:
            break
        if _is_already_stored(d):
            already += 1
            stored  += 1   # counts towards target
            continue
        ok = download_and_store(d)
        if ok:
            stored  += 1
        else:
            skipped += 1   # holiday / weekend
        if progress_cb:
            progress_cb(stored, days)
        time.sleep(delay)

    log.info(f"[bhavcopy] Backfill done: {stored} days stored "
             f"({already} already existed, {skipped} holidays/weekends skipped)")
    return stored, skipped


def update_today() -> bool:
    """Download today's Bhavcopy (call after 6:30pm IST). Returns True on success."""
    d = datetime.date.today()
    if d.weekday() >= 5:
        log.info("[bhavcopy] Today is weekend — no update needed")
        return False
    return download_and_store(d)


# ── In-memory cache ────────────────────────────────────────────────────────────
_cache:      Optional[Dict[str, pd.DataFrame]] = None
_cache_date: Optional[str] = None


def invalidate_cache() -> None:
    global _cache, _cache_date
    _cache = _cache_date = None


def load_ohlcv(
    tickers: Optional[List[str]] = None,
    min_bars: int = 55,
) -> Dict[str, pd.DataFrame]:
    """Load OHLCV for all (or specified) tickers from the SQLite DB.

    Returns Dict[str, pd.DataFrame] keyed by "SYMBOL.NS" — same shape as
    yfinance output, fully compatible with screener.py.  Each DataFrame has
    columns: Open, High, Low, Close, Volume, TurnoverLacs (DatetimeIndex).

    Results are in-memory cached for the current calendar day so that
    multiple scans in the same session hit the DB only once.
    """
    global _cache, _cache_date

    today = datetime.date.today().isoformat()

    # Return from in-memory cache if fresh
    if _cache is not None and _cache_date == today:
        if tickers is None:
            return _cache
        return {t: _cache[t] for t in tickers if t in _cache}

    log.info("[bhavcopy] Loading OHLCV from DB …")
    t0 = time.time()

    with _get_conn() as c:
        df_all = pd.read_sql_query(
            "SELECT symbol, date, open, high, low, close, volume, turnover_lacs "
            "FROM ohlcv ORDER BY symbol, date",
            c,
        )

    if df_all.empty:
        log.warning("[bhavcopy] DB is empty — run backfill() first")
        return {}

    df_all["date"] = pd.to_datetime(df_all["date"])
    df_all = df_all.rename(columns={
        "open":          "Open",
        "high":          "High",
        "low":           "Low",
        "close":         "Close",
        "volume":        "Volume",
        "turnover_lacs": "TurnoverLacs",
    })

    result: Dict[str, pd.DataFrame] = {}
    for sym, grp in df_all.groupby("symbol", sort=False):
        grp = grp.set_index("date").sort_index()
        grp = grp[["Open", "High", "Low", "Close", "Volume", "TurnoverLacs"]]
        if len(grp) >= min_bars:
            result[f"{sym}.NS"] = grp

    elapsed = time.time() - t0
    log.info(f"[bhavcopy] Loaded {len(result)} tickers in {elapsed:.1f}s")

    _cache      = result
    _cache_date = today
    if tickers is None:
        return result
    return {t: result[t] for t in tickers if t in result}


# ── Status / health ────────────────────────────────────────────────────────────
def get_status() -> Dict:
    """Return DB health info — used by /api/screener/cache endpoint."""
    try:
        with _get_conn() as c:
            latest = c.execute(
                "SELECT MAX(date) FROM fetched_dates"
            ).fetchone()[0]
            n_days = c.execute(
                "SELECT COUNT(*) FROM fetched_dates"
            ).fetchone()[0]
            n_tickers = c.execute(
                "SELECT COUNT(DISTINCT symbol) FROM ohlcv"
            ).fetchone()[0]
            n_rows = c.execute(
                "SELECT COUNT(*) FROM ohlcv"
            ).fetchone()[0]
        return {
            "source":      "nse_bhavcopy",
            "db_path":     str(DB_PATH),
            "latest_date": latest,
            "days_stored": n_days,
            "tickers":     n_tickers,
            "rows":        n_rows,
            "cache_warm":  _cache is not None,
        }
    except Exception as e:
        return {"source": "nse_bhavcopy", "error": str(e)}
