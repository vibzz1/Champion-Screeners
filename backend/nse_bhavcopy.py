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
import re
import sqlite3
import datetime
import logging
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
CACHE_DIR = Path(os.environ.get("CACHE_DIR", Path(__file__).parent / "cache"))
DB_PATH   = CACHE_DIR / "bhavcopy.db"
UNIVERSE_FILE = CACHE_DIR / "nse_universe_official.txt"   # refreshed from NSE's own equity lists

# Stock series to keep. EQ alone drops stocks NSE moves to trade-to-trade (BE/BZ —
# often after big runs, under ASM/GSM surveillance) and every SME stock (SM/ST), so
# their data froze while they kept trading. Measured 9 Oct 2026: 263 BE/BZ + 449 SME.
STOCK_SERIES = {"EQ", "BE", "BZ", "SM", "ST"}
_UNIVERSE_URLS = (
    "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",                 # main board
    "https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv",     # SME
)
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

CREATE TABLE IF NOT EXISTS corp_actions (
    symbol  TEXT NOT NULL,
    ex_date TEXT NOT NULL,
    subject TEXT NOT NULL,
    factor  REAL,            -- exact price factor; NULL = demerger/rights, ratio taken from the ex-date gap
    PRIMARY KEY (symbol, ex_date, subject)
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

        # Keep stock series (EQ + trade-to-trade BE/BZ + SME SM/ST)
        series_col = next((c for c in df.columns if c.upper() == "SERIES"), None)
        if series_col:
            df = df[df[series_col].astype(str).str.strip().isin(STOCK_SERIES)].copy()

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
        # one row per symbol (a stock can rarely print in two series on the same day)
        df = df.sort_values("volume").drop_duplicates("symbol", keep="last")
        log.info(f"[bhavcopy] {d}: parsed {len(df)} stock rows")
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


def download_and_store(d: datetime.date, force: bool = False) -> bool:
    """Download + store one day. Skips if already stored (unless force). True on success."""
    if not force and _is_already_stored(d):
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
             progress_cb=None, force: bool = False) -> Tuple[int, int]:
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
        if not force and _is_already_stored(d):
            already += 1
            stored  += 1   # counts towards target
            continue
        ok = download_and_store(d, force=force)   # force: re-ingest (e.g. after widening STOCK_SERIES)
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


# ── Official NSE universe (main board + SME, companies only — no ETFs) ──────────
def refresh_official_universe() -> List[str]:
    """Fetch NSE's equity master lists and cache them. New listings appear the day
    they list, so IPOs join the scan universe automatically. Raises on failure."""
    sess = _get_session()
    syms = set()
    for url in _UNIVERSE_URLS:
        r = sess.get(url, timeout=30)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text))
        df.columns = df.columns.str.strip()
        col = next(c for c in df.columns if c.upper() == "SYMBOL")
        syms |= {s.strip() for s in df[col].astype(str) if s.strip()}
    if len(syms) < 2000:                       # sanity: never shrink the universe on a bad fetch
        raise ValueError(f"official universe looks truncated ({len(syms)} symbols)")
    out = sorted(syms)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    UNIVERSE_FILE.write_text(f"# NSE official equity universe — {len(out)} symbols — "
                             f"{datetime.datetime.now().isoformat(timespec='seconds')}\n" + "\n".join(out) + "\n")
    log.info(f"[bhavcopy] official universe refreshed: {len(out)} symbols")
    return out


def official_universe() -> Optional[List[str]]:
    """Cached official universe (symbols without suffix), or None if never fetched."""
    if not UNIVERSE_FILE.exists():
        return None
    syms = [l.strip() for l in UNIVERSE_FILE.read_text().splitlines() if l.strip() and not l.startswith("#")]
    return syms or None


# ── Corporate actions (splits / bonuses / demergers) ───────────────────────────
# Bhavcopy prices are raw. On a 1:1 bonus the price halves overnight, every moving
# average breaks for 50+ sessions and the stock silently drops out of trend scans.
# The DB stays raw; load_ohlcv() back-adjusts history (prices ÷ f, volume × f,
# turnover unchanged) from:
#   1. NSE's corporate-action feed — splits/bonuses/consolidations carry an exact
#      ratio (applied when the ex-date gap confirms it); demergers/rights don't, so
#      their ratio is the ex-date opening gap;
#   2. any overnight gap no NSE price band allows (max band 20%) — the feed misses
#      some events outright (HEG's Oct-2024 split isn't in it).
_CA_URL = ("https://www.nseindia.com/api/corporates-corporateActions"
           "?index={idx}&from_date={a:%d-%m-%Y}&to_date={b:%d-%m-%Y}")
_CA_HEADERS = {"Accept":  "application/json, text/plain, */*",
               "Accept-Encoding": "gzip, deflate",   # NSE answers "br" with brotli, unreadable without the brotli package
               "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-actions"}
CA_GAP_MIN   = 1.35    # prev close ÷ open beyond 1.35× either way (−26% / +35%) is outside every price band
CA_EVENT_GAP = 1.10    # demerger/rights without a stated ratio: adjust only for a real gap
_CA_SNAP     = tuple(f for r in (1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 10.0) for f in (r, 1 / r))  # round split/bonus/consolidation ratios


def _ca_factor(subject: str) -> Tuple[bool, Optional[float]]:
    """(relevant, factor) for a feed subject line. factor None = demerger/rights-style
    event whose ratio comes from the price gap. Dividends, AGMs etc. → (False, None)."""
    s = " ".join(subject.lower().split())
    if any(w in s for w in ("ncrps", "preference", "debenture")):
        return False, None
    m = re.search(r"bonus\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)", s)            # "Bonus 1:3" = 1 new per 3 held
    if m and float(m[2]) > 0:
        return True, (float(m[1]) + float(m[2])) / float(m[2])
    m = re.search(r"(?:split|sub-division|consolidation).*?from\s*r[se]\.?\s*(\d+(?:\.\d+)?)"
                  r".*?to\s*r[se]\.?\s*(\d+(?:\.\d+)?)", s)                         # face value From Rs 10 To Rs 2
    if m and float(m[2]) > 0:
        return True, float(m[1]) / float(m[2])
    if any(w in s for w in ("demerger", "rights", "scheme of arrangement", "capital reduction")):
        return True, None
    return False, None


def refresh_corp_actions(start: Optional[datetime.date] = None,
                         end: Optional[datetime.date] = None) -> int:
    """Pull NSE's corporate-action feed (main board + SME) into corp_actions.
    Default window: last 45 days → next 60; the first run covers the DB's whole
    history. Returns rows stored. Raises if every request failed."""
    today = datetime.date.today()
    with _get_conn() as c:
        have  = c.execute("SELECT COUNT(*) FROM corp_actions").fetchone()[0]
        first = c.execute("SELECT MIN(date) FROM ohlcv").fetchone()[0]
    if start is None:
        start = (datetime.date.fromisoformat(first) if not have and first
                 else today - datetime.timedelta(days=45))
    end = end or today + datetime.timedelta(days=60)

    sess, rows, ok = _get_session(), [], 0
    for idx in ("equities", "sme"):
        a = start
        while a <= end:
            b = min(a + datetime.timedelta(days=89), end)
            try:
                r = sess.get(_CA_URL.format(idx=idx, a=a, b=b), headers=_CA_HEADERS, timeout=40)
                r.raise_for_status()
                data, ok = r.json(), ok + 1
            except Exception as e:
                log.warning(f"[bhavcopy] corp actions {idx} {a}..{b} failed: {e}")
                data = []
            for x in data if isinstance(data, list) else []:          # "no data" comes back as a dict
                subj = " ".join(str(x.get("subject") or "").split())
                relevant, f = _ca_factor(subj)
                if not relevant or f == 1:
                    continue
                try:
                    ex = datetime.datetime.strptime(str(x.get("exDate", "")).strip(), "%d-%b-%Y").date()
                except ValueError:
                    continue
                rows.append((str(x["symbol"]).strip(), ex.isoformat(), subj, f))
            a = b + datetime.timedelta(days=1)
            time.sleep(0.5)
    if not ok:
        raise RuntimeError("NSE corporate-action feed unreachable")
    with _get_conn() as c:
        c.executemany("INSERT OR REPLACE INTO corp_actions VALUES (?,?,?,?)", rows)
    log.info(f"[bhavcopy] corp actions {start}..{end}: {len(rows)} split/bonus/demerger rows")
    return len(rows)


def load_corp_actions() -> pd.DataFrame:
    with _get_conn() as c:
        ev = pd.read_sql_query("SELECT symbol, ex_date, factor FROM corp_actions", c)
    ev["ex_date"] = pd.to_datetime(ev["ex_date"])
    return ev


def apply_corp_actions(df: pd.DataFrame, events: Optional[pd.DataFrame],
                       today: Optional[datetime.date] = None) -> Tuple[pd.DataFrame, int]:
    """Back-adjust a long OHLCV frame (symbol, date, Open, High, Low, Close, Volume;
    sorted by symbol then date) for corporate actions. events: symbol, ex_date,
    factor (NaN = take the gap). Returns (adjusted frame, adjustments applied)."""
    df  = df.reset_index(drop=True)
    sym = df["symbol"].to_numpy()
    g   = df.groupby("symbol", sort=False)
    prev_c = g["Close"].shift(1).to_numpy(float)
    gap_o  = prev_c / df["Open"].where(df["Open"] > 0).to_numpy(float)
    gap_c  = prev_c / df["Close"].where(df["Close"] > 0).to_numpy(float)
    recent = ((df["date"] - g["date"].shift(1)).dt.days <= 15).to_numpy()   # a resumed listing isn't an ex-date
    fac  = np.ones(len(df))
    done = np.zeros(len(df), bool)
    pending: Dict[str, float] = {}

    def confirms(f, r):
        tol = max(0.12, 0.35 * abs(np.log(f)))
        return min(abs(np.log(gap_o[r] / f)), abs(np.log(gap_c[r] / f))) <= tol

    if events is not None and len(events):
        ev = events.dropna(subset=["ex_date"]).sort_values("ex_date")
        bars = pd.DataFrame({"symbol": sym, "bar": df["date"], "row": np.arange(len(df))}).sort_values("bar")
        m = pd.merge_asof(ev, bars, left_on="ex_date", right_on="bar", by="symbol", direction="forward")
        on_bar = m[m["row"].notna() & ((m["bar"] - m["ex_date"]).dt.days <= 15)]
        for r, fs in on_bar[on_bar["factor"].notna()].groupby("row")["factor"]:
            r = int(r)
            if not (recent[r] and np.isfinite(gap_o[r]) and np.isfinite(gap_c[r])):
                continue
            # bonus + split on one day multiply (LINC, NAZARA); a re-worded duplicate listing must not
            for f in (float(np.prod(fs)), float(np.prod(fs.unique()))):
                if confirms(f, r):
                    fac[r], done[r] = f, True
                    break
        for r in on_bar.loc[on_bar["factor"].isna(), "row"].astype(int).unique():
            if not done[r] and recent[r] and gap_o[r] >= CA_EVENT_GAP:    # demerger / rights
                fac[r], done[r] = gap_o[r], True
        # ex-date is today and tonight's Bhavcopy isn't in yet (morning intraday scans):
        # restate all stored history in post-split terms so today's live bar lines up
        today_ts = pd.Timestamp(today or datetime.date.today())
        due = m[m["row"].isna() & m["factor"].notna() & (m["ex_date"] <= today_ts)]
        for s, f in due.groupby("symbol")["factor"].prod().items():
            pending[s] = f

    unlisted = ~done & recent & (((gap_o >= CA_GAP_MIN) & (gap_c >= CA_GAP_MIN)) |
                                 ((gap_o <= 1 / CA_GAP_MIN) & (gap_c <= 1 / CA_GAP_MIN)))   # split / consolidation
    for r in np.flatnonzero(unlisted):
        snap = min(_CA_SNAP, key=lambda s: abs(np.log(gap_o[r] / s)))
        fac[r] = snap if abs(np.log(gap_o[r] / snap)) <= 0.05 else gap_o[r]

    n = int((fac != 1).sum()) + len(pending)
    if not n:
        return df, 0
    lf = np.log(fac)
    later = pd.Series(lf[::-1]).groupby(sym[::-1], sort=False).cumsum().to_numpy()[::-1] - lf
    div = np.exp(later) * (pd.Series(sym).map(pending).fillna(1.0).to_numpy() if pending else 1.0)
    for col in ("Open", "High", "Low", "Close"):
        df[col] = (df[col] / div).round(4)
    df["Volume"] = (df["Volume"] * div).round()
    return df, n


# ── In-memory cache ────────────────────────────────────────────────────────────
_cache:      Optional[Dict[str, pd.DataFrame]] = None
_cache_date: Optional[str] = None
_ca_applied: Optional[int] = None    # corporate-action adjustments in the last load


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
    global _cache, _cache_date, _ca_applied

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
    try:
        df_all, _ca_applied = apply_corp_actions(df_all, load_corp_actions())
        log.info(f"[bhavcopy] corporate-action adjustments: {_ca_applied}")
    except Exception as e:                       # never let an adjustment bug block scans
        log.warning(f"[bhavcopy] corporate-action adjustment skipped (raw prices): {e}")

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
            n_ca, ca_last = c.execute(
                "SELECT COUNT(*), MAX(ex_date) FROM corp_actions"
            ).fetchone()
        return {
            "source":      "nse_bhavcopy",
            "db_path":     str(DB_PATH),
            "latest_date": latest,
            "days_stored": n_days,
            "tickers":     n_tickers,
            "rows":        n_rows,
            "corp_actions":            n_ca,
            "corp_actions_latest_ex":  ca_last,
            "corp_action_adjustments": _ca_applied,   # None until the first load
            "cache_warm":  _cache is not None,
        }
    except Exception as e:
        return {"source": "nse_bhavcopy", "error": str(e)}
