import json
import os
from datetime import datetime, timedelta

CACHE_FILE = os.path.join(os.path.dirname(__file__), "cache", "earnings_dates.json")
CACHE_TTL_HOURS = 12
_RANGE_DAYS = 90

_RESULT_KEYWORDS = (
    "financial results",
    "quarterly results",
    "half yearly results",
    "annual results",
)

_NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
}


def _nse_session():
    import requests
    s = requests.Session()
    s.headers.update(_NSE_HEADERS)
    try:
        s.get(
            "https://www.nseindia.com",
            timeout=15,
            headers={**_NSE_HEADERS, "Accept": "text/html"},
        )
    except Exception:
        pass
    return s


def _fetch_from_nse() -> dict:
    """Fetch NSE board-meeting calendar for the next 90 days.
    Returns {SYMBOL: 'DD-Mon-YYYY'} for financial-results events only.
    Raises on any network or parse failure — callers must handle."""
    today = datetime.today()
    to_dt = today + timedelta(days=_RANGE_DAYS)
    params = {
        "index": "equities",
        "from_date": today.strftime("%d-%m-%Y"),
        "to_date": to_dt.strftime("%d-%m-%Y"),
    }
    s = _nse_session()
    r = s.get(
        "https://www.nseindia.com/api/event-calendar",
        params=params,
        timeout=20,
        headers={
            **_NSE_HEADERS,
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.nseindia.com/market-data/board-meetings",
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    r.raise_for_status()
    events = r.json()
    if not isinstance(events, list):
        raise ValueError(f"Unexpected NSE response type: {type(events)}")

    result: dict = {}
    for ev in events:
        sym = (ev.get("symbol") or "").strip().upper()
        purpose = (ev.get("purpose") or "").lower()
        ev_date = (ev.get("date") or "").strip()
        if not sym or not ev_date:
            continue
        if not any(kw in purpose for kw in _RESULT_KEYWORDS):
            continue
        if sym not in result:
            result[sym] = ev_date
    return result


def _load_cache():
    try:
        with open(CACHE_FILE) as f:
            cached = json.load(f)
        fetched_at = datetime.fromisoformat(cached["fetched_at"])
        if datetime.now() - fetched_at < timedelta(hours=CACHE_TTL_HOURS):
            return cached["data"]
    except Exception:
        pass
    return None


def _save_cache(data: dict) -> None:
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump({"fetched_at": datetime.now().isoformat(), "data": data}, f)


def get_earnings_calendar() -> dict:
    """Return cached or freshly fetched NSE earnings calendar.
    Returns {} on any failure — never raises."""
    cached = _load_cache()
    if cached is not None:
        return cached
    try:
        data = _fetch_from_nse()
        _save_cache(data)
        return data
    except Exception:
        return {}


def earnings_date_for(nse_symbol: str) -> str:
    """Return earnings date string for a symbol, or '' if not found."""
    clean = nse_symbol.replace(".NS", "").replace(".BO", "").upper()
    return get_earnings_calendar().get(clean, "")
