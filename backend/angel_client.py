"""
angel_client.py — Angel One SmartAPI data provider for NSE/BSE

Replaces yfinance for Indian market data.
Credentials read from environment variables (never hardcoded in git).

Flow:
  1. _get_token()        — login once, cache token 23h, auto-refresh
  2. _get_instrument_map() — download Angel One master once/day, map NSE symbol → token
  3. download_nse_ohlcv()  — fetch OHLCV for all NSE tickers concurrently
"""

import os
import json
import time
import datetime
import requests
import pyotp
import pandas as pd
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional, List

# ── Credentials (env vars → fallback to local dev values) ─────────────────
_CLIENT_ID   = os.environ.get("ANGEL_CLIENT_ID",   "V119180")
_PIN         = os.environ.get("ANGEL_PIN",          "1235")
_TOTP_SECRET = os.environ.get("ANGEL_TOTP_SECRET",  "ANOTHBL5HZBJ7YBP6C2SFWEL3U")
_API_KEY     = os.environ.get("ANGEL_API_KEY",      "AgqDUsEv")

_BASE_URL    = "https://apiconnect.angelone.in"
_MASTER_URL  = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

_CACHE_DIR   = Path(__file__).parent / "cache"
_MASTER_FILE = _CACHE_DIR / "angel_master.json"
_TOKEN_FILE  = _CACHE_DIR / "angel_token.json"
_CACHE_DIR.mkdir(exist_ok=True)

# Module-level token state
_session_token: Optional[str] = None
_token_expiry:  float          = 0.0
_instrument_map: Optional[Dict[str, str]] = None   # NSE symbol (no suffix) → token id


# ── Headers ────────────────────────────────────────────────────────────────
def _hdrs(auth_token: Optional[str] = None) -> dict:
    h = {
        "Content-Type":       "application/json",
        "Accept":             "application/json",
        "X-UserType":         "USER",
        "X-SourceID":         "WEB",
        "X-ClientLocalIP":    "127.0.0.1",
        "X-ClientPublicIP":   "127.0.0.1",
        "X-MACAddress":       "00:00:00:00:00:00",
        "X-PrivateKey":       _API_KEY,
    }
    if auth_token:
        h["Authorization"] = f"Bearer {auth_token}"
    return h


# ── Token management ───────────────────────────────────────────────────────
def _refresh_token() -> Optional[str]:
    global _session_token, _token_expiry
    try:
        totp_code = pyotp.TOTP(_TOTP_SECRET).now()
        r = requests.post(
            f"{_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword",
            headers=_hdrs(),
            json={"clientcode": _CLIENT_ID, "password": _PIN, "totp": totp_code},
            timeout=15,
        )
        data = r.json()
        if data.get("status"):
            token  = data["data"]["jwtToken"]
            expiry = time.time() + 23 * 3600          # 23h (token is valid 24h)
            _session_token = token
            _token_expiry  = expiry
            _TOKEN_FILE.write_text(json.dumps({"token": token, "expiry": expiry}))
            print("[angel] Token refreshed OK")
            return token
        else:
            print(f"[angel] Login failed: {data.get('message')}")
            return None
    except Exception as e:
        print(f"[angel] Token refresh error: {e}")
        return None


def _get_token() -> Optional[str]:
    global _session_token, _token_expiry
    # In-memory cache
    if _session_token and time.time() < _token_expiry - 300:
        return _session_token
    # File cache
    try:
        if _TOKEN_FILE.exists():
            cached = json.loads(_TOKEN_FILE.read_text())
            if cached.get("expiry", 0) > time.time() + 300:
                _session_token = cached["token"]
                _token_expiry  = cached["expiry"]
                return _session_token
    except Exception:
        pass
    return _refresh_token()


# ── Instrument master ──────────────────────────────────────────────────────
def _get_instrument_map() -> Dict[str, str]:
    """Returns {NSE_SYMBOL: angel_token} for all NSE equity stocks."""
    global _instrument_map
    if _instrument_map is not None:
        return _instrument_map

    today = datetime.date.today().isoformat()
    if _MASTER_FILE.exists():
        try:
            cached = json.loads(_MASTER_FILE.read_text())
            if cached.get("date") == today:
                _instrument_map = cached["map"]
                print(f"[angel] Instrument master from cache: {len(_instrument_map)} symbols")
                return _instrument_map
        except Exception:
            pass

    try:
        print("[angel] Downloading instrument master…")
        r = requests.get(_MASTER_URL, timeout=30)
        instruments = r.json()
        m: Dict[str, str] = {}
        for item in instruments:
            if item.get("exch_seg") == "NSE" and item.get("instrumenttype") == "":
                sym = item.get("symbol", "")
                if sym.endswith("-EQ"):
                    m[sym[:-3]] = item["token"]          # "RELIANCE-EQ" → "RELIANCE": "2885"
        _instrument_map = m
        _MASTER_FILE.write_text(json.dumps({"date": today, "map": m}))
        print(f"[angel] Instrument master: {len(m)} NSE equity symbols")
        return m
    except Exception as e:
        print(f"[angel] Instrument master failed: {e}")
        _instrument_map = {}
        return {}


# ── OHLCV fetch helpers ────────────────────────────────────────────────────
def _to_df(candles: list) -> Optional[pd.DataFrame]:
    if not candles:
        return None
    df = pd.DataFrame(candles, columns=["Date", "Open", "High", "Low", "Close", "Volume"])
    df["Date"] = pd.to_datetime(df["Date"]).dt.tz_localize(None)
    df = df.set_index("Date")
    for c in ["Open", "High", "Low", "Close"]:
        df[c] = df[c].astype(float)
    df["Volume"] = df["Volume"].astype(float).astype(int)
    return df.dropna()


def _fetch_one_daily(token_id: str, auth_token: str) -> Optional[pd.DataFrame]:
    today    = datetime.date.today()
    from_dt  = (today - datetime.timedelta(days=400)).strftime("%Y-%m-%d 09:00")
    to_dt    = today.strftime("%Y-%m-%d 15:30")
    try:
        r = requests.post(
            f"{_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData",
            headers=_hdrs(auth_token),
            json={"exchange": "NSE", "symboltoken": token_id,
                  "interval": "ONE_DAY", "fromdate": from_dt, "todate": to_dt},
            timeout=12,
        )
        data = r.json()
        if not data.get("status") or not data.get("data"):
            return None
        df = _to_df(data["data"])
        return df if df is not None and len(df) >= 30 else None
    except Exception:
        return None


def _fetch_one_intraday(token_id: str, auth_token: str, today_only: bool = False) -> Optional[pd.DataFrame]:
    """Fetch 15-min bars for one symbol.

    today_only=False (default): 60 days of history for the full intraday cache.
    today_only=True:  only today's session (09:00–15:30) — used for the daily
                      top-up that stitches today's bars onto yesterday's cache.
                      Much faster per call (~25 rows vs ~1500).
    """
    today   = datetime.date.today()
    from_dt = today.strftime("%Y-%m-%d 09:00") if today_only else \
              (today - datetime.timedelta(days=65)).strftime("%Y-%m-%d 09:00")
    to_dt   = today.strftime("%Y-%m-%d 15:30")
    try:
        r = requests.post(
            f"{_BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData",
            headers=_hdrs(auth_token),
            json={"exchange": "NSE", "symboltoken": token_id,
                  "interval": "FIFTEEN_MINUTE", "fromdate": from_dt, "todate": to_dt},
            timeout=12,
        )
        data = r.json()
        if not data.get("status") or not data.get("data"):
            return None
        df = _to_df(data["data"])
        if df is None or df.empty:
            return None
        # For today_only we accept any number of bars (market may have just opened);
        # for the full download we require enough history for indicator calc.
        return df if today_only or len(df) >= 20 else None
    except Exception:
        return None


# ── Public API ─────────────────────────────────────────────────────────────
def download_nse_ohlcv(
    tickers:     List[str],
    intraday:    bool = False,
    today_only:  bool = False,
    max_workers: int  = 6,
) -> Dict[str, pd.DataFrame]:
    """
    Download OHLCV for NSE tickers (SYMBOL.NS format).
    Returns {ticker: DataFrame}.  Silently skips symbols not in master.
    Falls back to {} on auth failure so caller can fall back to yfinance.

    today_only=True (intraday only): fetch only today's 15-min bars (09:00–15:30).
                  Much faster than a 60-day pull — used for the daily top-up.
    """
    auth_token = _get_token()
    if not auth_token:
        print("[angel] No token — caller should fall back to yfinance")
        return {}

    inst_map = _get_instrument_map()
    if not inst_map:
        print("[angel] Empty instrument map — caller should fall back to yfinance")
        return {}

    # Map tickers → Angel One token ids
    jobs: List[tuple] = []
    for t in tickers:
        nse_sym = t.replace(".NS", "").replace(".BO", "")
        tid = inst_map.get(nse_sym)
        if tid:
            jobs.append((t, tid))
    missing = len(tickers) - len(jobs)
    if missing:
        print(f"[angel] {missing} symbols not in master (will use yfinance fallback)")

    mode_str = "today-only 15min" if (intraday and today_only) else ("15min" if intraday else "daily")
    print(f"[angel] Fetching {mode_str} OHLCV for {len(jobs)} symbols ({max_workers} workers)…")

    result: Dict[str, pd.DataFrame] = {}

    if intraday and today_only:
        def fetch_fn(tid, tok): return _fetch_one_intraday(tid, tok, today_only=True)
    elif intraday:
        def fetch_fn(tid, tok): return _fetch_one_intraday(tid, tok, today_only=False)
    else:
        fetch_fn = _fetch_one_daily

    def _worker(args):
        ticker, tid = args
        return ticker, fetch_fn(tid, auth_token)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for i, (ticker, df) in enumerate(pool.map(_worker, jobs), 1):
            if df is not None:
                result[ticker] = df
            if i % 300 == 0:
                print(f"[angel] {i}/{len(jobs)} done, {len(result)} OK")

    print(f"[angel] Done: {len(result)}/{len(jobs)} symbols downloaded")
    return result


def is_available() -> bool:
    """Quick check — returns True if Angel One token can be obtained."""
    return _get_token() is not None
