from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import random
import math
import os
import threading
import pytz
from database import get_db, engine
import models
from screener import run_screen, UNIVERSES, PRESETS, OHLCV_CACHE_DIR, parse_formula, prewarm_ohlcv_cache, prewarm_intraday_ohlcv_cache, _SCREEN_PROGRESS, _LAST_TOPUP

models.Base.metadata.create_all(bind=engine)

# ── Sentry — initialise before the app so all exceptions are captured ─────────
_sentry_dsn = os.environ.get("SENTRY_DSN")
if _sentry_dsn:
    import sentry_sdk
    sentry_sdk.init(
        dsn=_sentry_dsn,
        traces_sample_rate=0.1,
        environment=os.environ.get("RAILWAY_ENVIRONMENT", "production"),
    )

app = FastAPI()

# ── Cache pre-warm scheduler ────────────────────────────────────────────────
def _prewarm_daily_background():
    """Warm daily OHLCV cache — runs at 08:00 IST (2:30 UTC) Mon–Fri."""
    try:
        prewarm_ohlcv_cache(["NSE"])
    except Exception as e:
        print(f"[prewarm] daily background error: {e}")

def _prewarm_intraday_background():
    """Warm intraday OHLCV cache — runs at 10:45 IST (5:15 UTC) Mon–Fri.
    First complete 75-min bar closes at 10:30 IST; 10:45 gives 15-min margin."""
    try:
        prewarm_intraday_ohlcv_cache([("NSE", 75)])
    except Exception as e:
        print(f"[prewarm] intraday background error: {e}")

# International daily caches are warmed out-of-band so the very first user scan
# never downloads a large universe inside the request (the timeout that forced
# Japan to be trimmed). Each call is a no-op when today's cache already exists.
_INTL_EXCHANGES = ["TSE", "KOSPI", "KOSDAQ", "TWSE", "SSE", "XETRA", "SP500"]

def _prewarm_international_background(force: bool = False):
    """Warm daily OHLCV for all international markets — daemon thread, off-peak.

    The China universe alone is ~3,600 tickers; downloading the intl markets
    hammers yfinance. If a Railway restart fires this mid-session it would starve
    NSE's own intraday top-up (also yfinance-backed), so today's NSE candle stops
    populating. Skip on startup while NSE is open; the scheduled 00:30 UTC run
    (pre-market) and lazy on-first-scan build still cover the caches."""
    try:
        from screener import _is_market_open
        if not force and _is_market_open("NSE"):
            print("[prewarm] intl: NSE open — deferring (protect NSE live-data path)")
            return
        prewarm_ohlcv_cache(_INTL_EXCHANGES)
    except Exception as e:
        print(f"[prewarm] international background error: {e}")

@app.on_event("startup")
async def startup_event():
    # Cap FastAPI/anyio's own thread pool — prevents it from growing to 40+ threads.
    # Without this, anyio spawns a new thread for every sync endpoint call.
    import anyio
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = 10

    # 0. Bhavcopy: backfill history if DB is empty; update today's data after 18:30 IST
    def _bhavcopy_startup():
        import datetime as _dt
        import pytz as _tz
        try:
            import nse_bhavcopy
            status = nse_bhavcopy.get_status()
            if not status.get("days_stored"):
                print("[bhavcopy] DB empty — starting backfill(400) …")
                nse_bhavcopy.backfill(days=400)
            elif status.get("latest_date", "") < _dt.date.today().isoformat():
                # Today's data may be available after 18:30 IST
                ist     = _tz.timezone("Asia/Kolkata")
                now_ist = _dt.datetime.now(_tz.utc).astimezone(ist)
                if now_ist.hour >= 18 and now_ist.minute >= 30:
                    nse_bhavcopy.update_today()
        except Exception as e:
            print(f"[bhavcopy] startup check failed: {e}")

    threading.Thread(target=_bhavcopy_startup, daemon=True).start()

    # 1. Pre-warm daily cache on startup (no-op if already fresh)
    threading.Thread(target=_prewarm_daily_background, daemon=True).start()
    # 1b. Also kick off intraday pre-warm on startup (no-op if cache fresh)
    threading.Thread(target=_prewarm_intraday_background, daemon=True).start()
    # 1c. Warm international universes out-of-band (TSE/KOSPI/KOSDAQ/TWSE/SSE/XETRA/SP500)
    threading.Thread(target=_prewarm_international_background, daemon=True).start()

    # 2. Schedule daily pre-warm jobs Mon–Fri
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
        scheduler = BackgroundScheduler(timezone=pytz.utc)
        # Daily OHLCV: 08:00 IST = 02:30 UTC
        scheduler.add_job(
            _prewarm_daily_background,
            CronTrigger(hour=2, minute=30, day_of_week="mon-fri", timezone=pytz.utc),
            id="nse_prewarm_daily",
            replace_existing=True,
        )
        # Intraday OHLCV: 10:45 IST = 05:15 UTC  (15 min after first complete 75-min bar)
        scheduler.add_job(
            _prewarm_intraday_background,
            CronTrigger(hour=5, minute=15, day_of_week="mon-fri", timezone=pytz.utc),
            id="nse_prewarm_intraday",
            replace_existing=True,
        )
        # International daily caches: 00:30 UTC — before all Asian opens, off-peak.
        scheduler.add_job(
            _prewarm_international_background,
            CronTrigger(hour=0, minute=30, day_of_week="mon-fri", timezone=pytz.utc),
            id="intl_prewarm_daily",
            replace_existing=True,
        )
        # Bhavcopy nightly update: 19:00 IST = 13:30 UTC  (NSE publishes ~6:30pm)
        def _bhav_update_job():
            try:
                import nse_bhavcopy
                nse_bhavcopy.invalidate_cache()   # flush in-memory cache
                ok = nse_bhavcopy.update_today()
                print(f"[bhavcopy] Nightly update: {'✓' if ok else 'skipped (holiday/weekend)'}")
            except Exception as e:
                print(f"[bhavcopy] Nightly update error: {e}")

        scheduler.add_job(
            _bhav_update_job,
            CronTrigger(hour=13, minute=30, day_of_week="mon-fri", timezone=pytz.utc),
            id="bhavcopy_nightly",
            replace_existing=True,
        )
        scheduler.start()
        print("[prewarm] Scheduler started — daily@08:00IST, intraday@10:45IST, intl@00:30UTC, bhavcopy@19:00IST (Mon–Fri)")
    except Exception as e:
        print(f"[prewarm] Scheduler setup failed: {e}")

@app.get("/api/screener/progress")
def screener_progress():
    return dict(_SCREEN_PROGRESS)

@app.get("/api/health")
def health_check():
    """Comprehensive health check — used by QA cron and Playwright smoke tests.
    Returns status='ok' only when yfinance responds AND the executor is alive."""
    import datetime
    import concurrent.futures
    from screener import _EXECUTOR

    # 1. yfinance quick probe (fast_info is cheap — no full download)
    yf_ok = False
    yf_error = None
    try:
        import yfinance as yf
        fi = yf.Ticker("RELIANCE.NS").fast_info
        _ = fi.market_cap   # triggers network call
        yf_ok = True
    except Exception as e:
        yf_error = str(e)

    # 2. Cache inventory
    cache_files = sorted(OHLCV_CACHE_DIR.glob("*.pkl")) if OHLCV_CACHE_DIR.exists() else []
    newest_cache_age_hours = None
    if cache_files:
        newest = max(cache_files, key=lambda f: f.stat().st_mtime)
        age_s = datetime.datetime.now().timestamp() - newest.stat().st_mtime
        newest_cache_age_hours = round(age_s / 3600, 1)

    # 3. Executor health (private attr — guard with try/except)
    try:
        executor_alive = not _EXECUTOR._shutdown
    except Exception:
        executor_alive = True  # assume alive if we can't check

    # 4. anyio thread pool — only readable from inside an async context;
    #    return None when called from sync endpoint (avoids RuntimeError)
    anyio_total = anyio_available = None
    try:
        import anyio
        limiter = anyio.to_thread.current_default_thread_limiter()
        anyio_total = limiter.total_tokens
        anyio_available = limiter.available_tokens
    except Exception:
        pass

    status = "ok" if (yf_ok and executor_alive) else "degraded"
    result = {
        "status": status,
        "yfinance": "ok" if yf_ok else f"error: {yf_error}",
        "cache_files": len(cache_files),
        "newest_cache_age_hours": newest_cache_age_hours,
        "executor_alive": executor_alive,
        "anyio_tokens_total": anyio_total,
        "anyio_tokens_available": anyio_available,
        "sentry_active": bool(_sentry_dsn),
    }
    return result

@app.post("/api/screener/validate")
def validate_formula_endpoint(body: dict):
    """Parse a formula and return {valid, warnings, filter_count, block_count}.
    Called by the frontend before saving a screener to give the user early feedback."""
    import re as _re
    formula = (body.get("formula") or "").strip()
    if not formula:
        return {"valid": True, "warnings": [], "filter_count": 0, "block_count": 0}

    blocks = [b.strip() for b in _re.split(r'\n\s*\n', formula) if b.strip()]
    warnings = []
    total_filters = 0

    exchange = body.get("exchange", "")
    for i, block in enumerate(blocks, 1):
        parsed = parse_formula(block, exchange=exchange)
        if not parsed:
            warnings.append(
                f"Block {i}: no recognised filter clauses — "
                "check for typos or unsupported syntax"
            )
        else:
            total_filters += len(parsed)

    return {
        "valid": len(warnings) == 0,
        "warnings": warnings,
        "filter_count": total_filters,
        "block_count": len(blocks),
    }

@app.get("/api/angel/status")
def angel_status():
    """Diagnostic endpoint — shows Angel One credential source, token validity,
    instrument map size, and the last intraday top-up result.
    Hit this URL after a morning scan to confirm Angel One is being used."""
    import os
    try:
        from angel_client import is_available, _get_instrument_map
        token_ok  = is_available()
        inst_size = len(_get_instrument_map()) if token_ok else 0
    except Exception as e:
        token_ok  = False
        inst_size = 0

    creds_from_env = all([
        os.environ.get("ANGEL_CLIENT_ID"),
        os.environ.get("ANGEL_PIN"),
        os.environ.get("ANGEL_TOTP_SECRET"),
        os.environ.get("ANGEL_API_KEY"),
    ])

    return {
        "credentials_from_env": creds_from_env,
        "token_valid":          token_ok,
        "instrument_map_size":  inst_size,
        "last_topup":           dict(_LAST_TOPUP) or None,
        "verdict": (
            "✅ Angel One active"          if token_ok and _LAST_TOPUP.get("source") in ("angel_one","mixed") else
            "⚠ Angel One token OK but last topup used yfinance" if token_ok else
            "❌ Angel One unavailable — all intraday data from yfinance"
        ),
    }

@app.get("/api/cache/status")
def cache_status():
    import datetime
    files = []
    if OHLCV_CACHE_DIR.exists():
        for f in sorted(OHLCV_CACHE_DIR.iterdir()):
            files.append({"name": f.name, "size_mb": round(f.stat().st_size / 1_048_576, 1)})
    return {
        "cache_dir": str(OHLCV_CACHE_DIR),
        "exists": OHLCV_CACHE_DIR.exists(),
        "today": datetime.date.today().isoformat(),
        "files": files,
    }

@app.get("/api/intraday/status")
def intraday_status():
    """Single diagnostic endpoint — answers: does today's intraday cache exist?
    what is the last bar date? is a top-up running? Hit this at any point during
    market hours to verify the pipeline is healthy without reading logs."""
    import datetime, pickle, pytz
    from screener import (OHLCV_CACHE_DIR, _LAST_TOPUP, _TOPUP_RUNNING,
                          _is_market_open, _ohlcv_intraday_cache_path)

    today = datetime.date.today().isoformat()
    exchange, bar_min = "NSE", 75
    cache_path = _ohlcv_intraday_cache_path(exchange, bar_min)

    result = {
        "today": today,
        "market_open": _is_market_open(exchange),
        "cache_file": cache_path.name,
        "cache_exists": cache_path.exists(),
        "cache_size_mb": round(cache_path.stat().st_size / 1_048_576, 1) if cache_path.exists() else None,
        "topup_running": list(_TOPUP_RUNNING),
        "last_topup": dict(_LAST_TOPUP) or None,
        "last_bar_date": None,
        "today_bar_count": None,
        "verdict": None,
    }

    if cache_path.exists():
        try:
            with open(cache_path, "rb") as f:
                data = pickle.load(f)
            sample = [df for df in (data.get(t) for t in list(data.keys())[:20]) if df is not None and not df.empty]
            if sample:
                last_dates = sorted(set(str(df.index[-1])[:10] for df in sample), reverse=True)
                result["last_bar_date"] = last_dates[0]
                result["today_bar_count"] = sum(1 for df in sample if str(df.index[-1])[:10] == today)
        except Exception as e:
            result["cache_read_error"] = str(e)

    # Verdict
    if not cache_path.exists():
        result["verdict"] = "⚠ No today's cache — prewarm hasn't run or failed"
    elif result["last_bar_date"] == today:
        result["verdict"] = "✅ Today's bars present"
    else:
        result["verdict"] = f"⚠ Cache has {result['last_bar_date']} bars, not today's — top-up pending"

    return result

@app.post("/api/bhavcopy/dedup")
def bhavcopy_dedup():
    """Remove stale/duplicate Bhavcopy dates (NSE served a prior day's file for
    a new date's URL). Also flushes the in-memory Bhavcopy cache."""
    import nse_bhavcopy
    res = nse_bhavcopy.purge_duplicate_dates()
    nse_bhavcopy.invalidate_cache()
    return res

@app.post("/api/cache/clear")
def clear_ohlcv_cache(exchange: str = None):
    """Delete OHLCV cache files so the next scan triggers a fresh download.
    Pass ?exchange=NSE to clear only one exchange; omit to clear all."""
    deleted = []
    errors = []
    if OHLCV_CACHE_DIR.exists():
        pattern = f"{exchange}_*.pkl" if exchange else "*.pkl"
        for f in OHLCV_CACHE_DIR.glob(pattern):
            try:
                f.unlink()
                deleted.append(f.name)
            except Exception as e:
                errors.append(f"{f.name}: {e}")
    return {"deleted": deleted, "errors": errors, "count": len(deleted)}

@app.post("/api/cache/clear-intraday")
def clear_intraday_cache(exchange: str = "NSE", bar_min: int = 75):
    """Delete only today's intraday cache file so the next scan does a fresh top-up.
    Leaves the daily OHLCV cache untouched."""
    deleted, errors = [], []
    if OHLCV_CACHE_DIR.exists():
        pattern = f"{exchange}_{bar_min}min_*.pkl"
        for f in OHLCV_CACHE_DIR.glob(pattern):
            try:
                f.unlink()
                deleted.append(f.name)
            except Exception as e:
                errors.append(f"{f.name}: {e}")
    return {"deleted": deleted, "errors": errors, "count": len(deleted)}

@app.get("/api/screener/bhavcopy/status")
def bhavcopy_status():
    """NSE Bhavcopy DB health — source, dates covered, tickers, and cache state."""
    try:
        import nse_bhavcopy
        return nse_bhavcopy.get_status()
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/screener/bhavcopy/backfill")
def bhavcopy_backfill(body: dict = {}):
    """Trigger a Bhavcopy backfill in the background. Returns immediately."""
    days = int(body.get("days", 400))
    import threading, nse_bhavcopy
    threading.Thread(
        target=nse_bhavcopy.backfill,
        kwargs={"days": days},
        daemon=True,
    ).start()
    return {"status": "backfill started", "days": days}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Backtester ──────────────────────────────────────────────────────────────

class BacktestRequest(BaseModel):
    strategy_name: str
    entry_condition: str
    exit_condition: str
    stop_loss: float
    take_profit: float
    exchange: str
    capital: float

class FormulaBacktestRequest(BaseModel):
    formula: str
    exchange: str
    interval: str = "1d"
    entry_date: str        # YYYY-MM-DD — run screener on this date to find entries
    hold_days: int = 20    # max trading bars to hold; exit at close on day hold_days
    stop_loss_pct: float = 5.0
    take_profit_pct: float = 10.0
    capital: float = 100000.0

@app.post("/api/backtest/formula_run")
def run_formula_backtest(req: FormulaBacktestRequest):
    """
    Formula-based backtester.
    1. Run screener on entry_date → matched tickers + entry prices.
    2. For each ticker load post-entry OHLCV from cache.
    3. Simulate equal-weight portfolio; exit on SL, TP, or hold_days elapsed.
    4. Return trades list + equity curve + summary stats.
    """
    import pandas as pd
    from screener import parse_formula, run_screen, _load_ohlcv_cache, _load_intraday_cache

    # Parse formula (pass exchange so advol unit conversion is correct)
    try:
        filters = parse_formula(req.formula, exchange=req.exchange)
    except Exception as e:
        raise HTTPException(400, f"Formula parse error: {e}")

    # Run screener for the entry date
    try:
        results, _ = run_screen(req.exchange, filters, as_of_date=req.entry_date, interval=req.interval)
    except Exception as e:
        raise HTTPException(500, f"Screener error: {e}")

    if not results:
        return {
            "trades": [],
            "summary": {
                "total_trades": 0, "wins": 0, "losses": 0, "win_rate": 0,
                "total_return_pct": 0, "max_drawdown_pct": 0, "avg_win_pct": 0,
                "avg_loss_pct": 0, "profit_factor": 0,
                "entry_date": req.entry_date, "matched_count": 0,
            },
            "equity_curve": [{"bar": 0, "equity": round(req.capital, 2)}],
        }

    # Load full OHLCV cache for exit price computation
    ohlcv_data = _load_ohlcv_cache(req.exchange)
    if not ohlcv_data:
        raise HTTPException(503, "OHLCV cache not available — run a scan first to warm the cache")

    entry_ts = pd.Timestamp(req.entry_date)
    n_stocks  = len(results)
    per_trade = req.capital / n_stocks

    trades       = []
    equity       = req.capital
    equity_curve = [{"bar": 0, "equity": round(equity, 2)}]

    for r in results:
        ticker      = r["ticker"]
        entry_price = r.get("price")
        if not entry_price or entry_price <= 0:
            continue

        df = ohlcv_data.get(ticker)
        if df is None or df.empty:
            continue

        # Rows strictly after entry date
        post = df[df.index > entry_ts].sort_index()
        if post.empty:
            # No future data — treat as open position at last known close
            exit_price  = entry_price
            exit_reason = "Open"
            bars_held   = 0
        else:
            sl_price = entry_price * (1 - req.stop_loss_pct / 100)
            tp_price = entry_price * (1 + req.take_profit_pct / 100)
            exit_price  = None
            exit_reason = "Hold"
            bars_held   = 0

            for _date, row in post.iterrows():
                bars_held += 1
                lo = float(row.get("Low",   row.get("low",   entry_price)))
                hi = float(row.get("High",  row.get("high",  entry_price)))
                cl = float(row.get("Close", row.get("close", entry_price)))

                if lo <= sl_price:
                    exit_price  = round(sl_price, 4)
                    exit_reason = "SL"
                    break
                if hi >= tp_price:
                    exit_price  = round(tp_price, 4)
                    exit_reason = "TP"
                    break
                if bars_held >= req.hold_days:
                    exit_price  = round(cl, 4)
                    exit_reason = "Hold"
                    break

            if exit_price is None:
                # Still open after full date range
                last = post.iloc[-1]
                exit_price  = round(float(last.get("Close", last.get("close", entry_price))), 4)
                exit_reason = "Open"
                bars_held   = len(post)

        pnl_pct = round((exit_price - entry_price) / entry_price * 100, 2)
        pnl_abs = round(per_trade * pnl_pct / 100, 2)
        equity += pnl_abs
        equity_curve.append({
            "bar":    len(trades) + 1,
            "equity": round(equity, 2),
            "ticker": r.get("symbol", ticker),
        })

        trades.append({
            "id":          len(trades) + 1,
            "symbol":      r.get("symbol", ticker),
            "entry":       round(entry_price, 2),
            "exit":        round(exit_price, 2),
            "pnl_pct":     pnl_pct,
            "pnl_abs":     pnl_abs,
            "result":      "Win" if pnl_pct > 0 else ("Loss" if pnl_pct < 0 else "BE"),
            "bars_held":   bars_held,
            "exit_reason": exit_reason,
            "sector":      r.get("sector", ""),
            "cap_size":    r.get("cap_size", ""),
        })

    if not trades:
        return {
            "trades": [],
            "summary": {
                "total_trades": 0, "wins": 0, "losses": 0, "win_rate": 0,
                "total_return_pct": 0, "max_drawdown_pct": 0, "avg_win_pct": 0,
                "avg_loss_pct": 0, "profit_factor": 0,
                "entry_date": req.entry_date, "matched_count": n_stocks,
            },
            "equity_curve": equity_curve,
        }

    wins   = [t for t in trades if t["pnl_pct"] > 0]
    losses = [t for t in trades if t["pnl_pct"] < 0]
    n      = len(trades)

    avg_win  = round(sum(t["pnl_pct"] for t in wins)   / len(wins),   2) if wins   else 0.0
    avg_loss = round(abs(sum(t["pnl_pct"] for t in losses) / len(losses)), 2) if losses else 0.0
    pf       = round(
        sum(t["pnl_pct"] for t in wins) / max(abs(sum(t["pnl_pct"] for t in losses)), 0.001), 2
    ) if wins and losses else (999.0 if wins else 0.0)

    # Max drawdown from equity curve
    peak   = req.capital
    max_dd = 0.0
    for pt in equity_curve:
        peak   = max(peak, pt["equity"])
        dd     = (peak - pt["equity"]) / peak * 100
        max_dd = max(max_dd, dd)

    return {
        "trades": trades[:100],
        "summary": {
            "total_trades":    n,
            "wins":            len(wins),
            "losses":          len(losses),
            "win_rate":        round(len(wins) / n * 100, 1),
            "total_return_pct": round((equity - req.capital) / req.capital * 100, 2),
            "max_drawdown_pct": round(max_dd, 2),
            "avg_win_pct":     avg_win,
            "avg_loss_pct":    avg_loss,
            "profit_factor":   pf,
            "entry_date":      req.entry_date,
            "matched_count":   n_stocks,
        },
        "equity_curve": equity_curve,
    }

def generate_equity_curve(capital: float, n: int = 60):
    curve = []
    value = capital
    for i in range(n):
        change = random.uniform(-0.03, 0.04)
        value = value * (1 + change)
        curve.append({"bar": i + 1, "equity": round(value, 2)})
    return curve

@app.post("/api/backtest/run")
def run_backtest(req: BacktestRequest):
    random.seed(hash(req.strategy_name + req.entry_condition))
    n_trades = random.randint(40, 120)
    wins = int(n_trades * random.uniform(0.45, 0.70))
    losses = n_trades - wins
    avg_win = random.uniform(2.5, 6.0)
    avg_loss = random.uniform(1.0, 2.5)
    total_return = (wins * avg_win - losses * avg_loss)
    max_dd = round(random.uniform(8, 25), 2)
    sharpe = round(random.uniform(0.8, 2.5), 2)

    trades = []
    for i in range(min(n_trades, 20)):
        win = i < wins
        pnl = round(random.uniform(1.5, avg_win * 2), 2) if win else round(-random.uniform(0.5, avg_loss * 2), 2)
        trades.append({
            "id": i + 1,
            "symbol": random.choice(["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL"]),
            "entry": round(random.uniform(100, 500), 2),
            "exit": 0,
            "pnl_pct": pnl,
            "result": "Win" if win else "Loss",
            "bars_held": random.randint(2, 30),
        })
        trades[-1]["exit"] = round(trades[-1]["entry"] * (1 + pnl / 100), 2)

    return {
        "summary": {
            "total_trades": n_trades,
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / n_trades * 100, 1),
            "total_return_pct": round(total_return, 2),
            "max_drawdown_pct": max_dd,
            "sharpe_ratio": sharpe,
            "avg_win_pct": round(avg_win, 2),
            "avg_loss_pct": round(avg_loss, 2),
            "profit_factor": round((wins * avg_win) / max(losses * avg_loss, 0.01), 2),
        },
        "equity_curve": generate_equity_curve(req.capital),
        "trades": trades,
    }

# ── Watchlists ──────────────────────────────────────────────────────────────

class WatchlistCreate(BaseModel):
    name: str

class StockAdd(BaseModel):
    symbol: str

@app.get("/api/watchlists")
def list_watchlists(db: Session = Depends(get_db)):
    return db.query(models.Watchlist).all()

@app.post("/api/watchlists")
def create_watchlist(body: WatchlistCreate, db: Session = Depends(get_db)):
    existing = db.query(models.Watchlist).filter_by(name=body.name).first()
    if existing:
        raise HTTPException(400, "Watchlist name already exists")
    wl = models.Watchlist(name=body.name)
    db.add(wl)
    db.commit()
    db.refresh(wl)
    return wl

@app.delete("/api/watchlists/{wl_id}")
def delete_watchlist(wl_id: int, db: Session = Depends(get_db)):
    wl = db.query(models.Watchlist).filter_by(id=wl_id).first()
    if not wl:
        raise HTTPException(404, "Not found")
    db.delete(wl)
    db.commit()
    return {"ok": True}

@app.get("/api/watchlists/{wl_id}/stocks")
def list_stocks(wl_id: int, db: Session = Depends(get_db)):
    return db.query(models.WatchlistStock).filter_by(watchlist_id=wl_id).all()

@app.post("/api/watchlists/{wl_id}/stocks")
def add_stock(wl_id: int, body: StockAdd, db: Session = Depends(get_db)):
    wl = db.query(models.Watchlist).filter_by(id=wl_id).first()
    if not wl:
        raise HTTPException(404, "Watchlist not found")
    s = models.WatchlistStock(watchlist_id=wl_id, symbol=body.symbol.upper())
    db.add(s)
    db.commit()
    db.refresh(s)
    return s

@app.delete("/api/watchlists/{wl_id}/stocks/{stock_id}")
def remove_stock(wl_id: int, stock_id: int, db: Session = Depends(get_db)):
    s = db.query(models.WatchlistStock).filter_by(id=stock_id, watchlist_id=wl_id).first()
    if not s:
        raise HTTPException(404, "Not found")
    db.delete(s)
    db.commit()
    return {"ok": True}

@app.get("/api/watchlists/all-symbols")
def all_watchlist_symbols(db: Session = Depends(get_db)):
    """Return deduplicated list of all symbols across every watchlist."""
    rows = db.query(models.WatchlistStock.symbol).all()
    return list({r.symbol for r in rows})

@app.get("/api/screener/quotes")
def get_quotes(symbols: str = ""):
    """
    Return latest price/change_pct/rsi for a comma-separated symbol list.
    Searches every exchange's OHLCV cache; returns whichever has data first.
    Symbols should be the base ticker without exchange suffix (e.g. RELIANCE, AAPL).
    """
    from screener import _load_ohlcv_cache, compute_indicators, UNIVERSES
    import re as _re

    if not symbols.strip():
        return {}

    wanted = {s.strip().upper() for s in symbols.split(",") if s.strip()}
    result: dict = {}

    # Suffix patterns to strip when matching
    _SUFFIX = _re.compile(r'\.(NS|BO|T|KS|KQ|DE)$', _re.IGNORECASE)

    for exchange in ["NSE", "BSE", "SP500", "NASDAQ", "NYSE", "TSE", "KOSPI", "KOSDAQ", "XETRA"]:
        if not (remaining := wanted - result.keys()):
            break
        cached = _load_ohlcv_cache(exchange)
        if not cached:
            continue
        for ticker, df in cached.items():
            base = _SUFFIX.sub("", ticker).upper()
            if base not in remaining:
                continue
            try:
                ind = compute_indicators(ticker, df, include_ohlcv=False)
                if ind:
                    result[base] = {
                        "price":      ind.get("price"),
                        "change_pct": ind.get("change_pct"),
                        "rsi":        ind.get("rsi"),
                        "volume":     ind.get("volume"),
                        "ticker":     ticker,
                        "exchange":   exchange,
                    }
            except Exception:
                pass

    return result

# ── Portfolio ───────────────────────────────────────────────────────────────

class PositionCreate(BaseModel):
    symbol: str
    name: Optional[str] = ""
    quantity: float
    buy_price: float
    current_price: float
    buy_date: str

class PositionUpdate(BaseModel):
    current_price: float

@app.get("/api/portfolio")
def list_positions(db: Session = Depends(get_db)):
    return db.query(models.PortfolioPosition).all()

@app.post("/api/portfolio")
def add_position(body: PositionCreate, db: Session = Depends(get_db)):
    p = models.PortfolioPosition(**body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p

@app.patch("/api/portfolio/{pos_id}")
def update_price(pos_id: int, body: PositionUpdate, db: Session = Depends(get_db)):
    p = db.query(models.PortfolioPosition).filter_by(id=pos_id).first()
    if not p:
        raise HTTPException(404, "Not found")
    p.current_price = body.current_price
    db.commit()
    db.refresh(p)
    return p

@app.delete("/api/portfolio/{pos_id}")
def delete_position(pos_id: int, db: Session = Depends(get_db)):
    p = db.query(models.PortfolioPosition).filter_by(id=pos_id).first()
    if not p:
        raise HTTPException(404, "Not found")
    db.delete(p)
    db.commit()
    return {"ok": True}

# ── Stock Screener ──────────────────────────────────────────────────────────

class ScreenerFilters(BaseModel):
    exchange: str = "NSE"
    interval: str = "1d"                   # "1d" (daily) | "75min" (NSE/BSE) | "78min" (US)
    formula: Optional[str] = None          # plain-text formula (parsed server-side)
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    change_pct_min: Optional[float] = None
    change_pct_max: Optional[float] = None
    volume_min: Optional[float] = None
    avg_vol_min: Optional[float] = None
    rsi_min: Optional[float] = None
    rsi_max: Optional[float] = None
    macd_signal: Optional[str] = None
    sma_condition: Optional[str] = None
    sma_conditions: Optional[List[str]] = None
    ema_condition: Optional[str] = None
    ema_conditions: Optional[List[str]] = None
    bb_condition: Optional[str] = None
    new_52w_high: Optional[bool] = None
    near_52w_high_pct: Optional[float] = None
    near_52w_low_pct: Optional[float] = None
    atr_ratio_min: Optional[float] = None
    candle_pos_min: Optional[float] = None
    dollar_vol_min: Optional[float] = None   # avg dollar volume in M (advol)
    rvol_min: Optional[float] = None         # relative volume min (rvol)
    gapup_min: Optional[float] = None        # gap up % min
    gapdn_min: Optional[float] = None        # gap down % min
    as_of_date: Optional[str] = None         # YYYY-MM-DD; None = today

@app.get("/api/screener/exchanges")
def get_exchanges():
    return list(UNIVERSES.keys())

@app.get("/api/screener/presets")
def get_presets():
    return PRESETS

@app.post("/api/screener/run")
def screener_run(body: ScreenerFilters):
    import re as _re
    if body.formula and body.formula.strip():
        # Split on one or more blank lines — MIO uses blank lines as OR between blocks
        blocks = [b.strip() for b in _re.split(r'\n\s*\n', body.formula.strip()) if b.strip()]
        filter_blocks = [parse_formula(b, exchange=body.exchange) for b in blocks]
        # Drop blocks where nothing was recognised
        filter_blocks = [f for f in filter_blocks if f]
        if not filter_blocks:
            return {
                "count": 0, "results": [],
                "warning": (
                    "No filter clauses were recognised in that formula. "
                    "Supported: rsi, macd, price, change, volume, sma(), ema(), "
                    "bb_upper/lower, near_52h, new_52w_high, advol(), "
                    "atr(1)>atr(N)*X, price>c[1], candle_pos. "
                    "Unsupported (auto-skipped): exch(), trend_dn, trend_up, !negation."
                )
            }
        if len(filter_blocks) == 1:
            # Single block — fast path, no merging needed
            results, is_live = run_screen(body.exchange, filter_blocks[0], as_of_date=body.as_of_date or None, interval=body.interval)
        else:
            # Multiple blocks (blank-line OR) — run each and union results
            seen, results, is_live = set(), [], False
            for fb in filter_blocks:
                block_results, live = run_screen(body.exchange, fb, as_of_date=body.as_of_date or None, interval=body.interval)
                is_live = is_live or live
                for r in block_results:
                    if r["ticker"] not in seen:
                        seen.add(r["ticker"])
                        results.append(r)
    else:
        filters = body.model_dump(exclude={"exchange", "formula"}, exclude_none=True)
        results, is_live = run_screen(body.exchange, filters, as_of_date=body.as_of_date or None, interval=body.interval)
    return {"count": len(results), "results": results, "live": is_live}

@app.post("/api/screener/parse")
def parse_formula_endpoint(body: dict):
    """Parse a formula string and return the resulting filter dict."""
    formula  = body.get("formula", "")
    exchange = body.get("exchange", "")
    return parse_formula(formula, exchange=exchange)

@app.post("/api/screener/explain")
def explain_ticker(body: dict):
    """Explain why a ticker passes or fails each filter clause in a formula."""
    import yfinance as yf
    import pandas as pd
    import numpy as np
    from screener import parse_formula, compute_indicators, apply_filters, _normalize_df

    ticker_raw = body.get("ticker", "").upper().strip()
    exchange   = body.get("exchange", "NSE")
    formula    = body.get("formula", "")
    as_of_date = body.get("as_of_date") or None

    # Append exchange suffix
    suffix = ".NS" if exchange in ("NSE", "BSE") else ""
    ticker = ticker_raw + suffix if not ticker_raw.endswith(suffix) else ticker_raw

    # Download fresh data for this one ticker
    try:
        raw = yf.download(ticker, period="1y", interval="1d",
                          auto_adjust=True, progress=False)
    except Exception as e:
        return {"error": f"Download failed: {e}"}

    df = _normalize_df(raw, ticker) if isinstance(raw.columns, pd.MultiIndex) else (
        lambda: (
            setattr(raw, "columns", raw.columns.get_level_values(0))
            or raw.dropna(subset=["Open","High","Low","Close"])
        )()
    )
    # Simpler: just clean the raw df directly for single-ticker download
    if df is None:
        try:
            r = raw.copy()
            if isinstance(r.columns, pd.MultiIndex):
                r.columns = r.columns.get_level_values(-1)
            r = r[["Open","High","Low","Close","Volume"]].dropna(subset=["Open","High","Low","Close"])
            df = r if len(r) >= 30 else None
        except Exception:
            pass
    if df is None:
        return {"error": f"No usable data for {ticker}"}

    ind = compute_indicators(ticker, df, as_of_date=as_of_date)
    if ind is None:
        return {"error": f"compute_indicators returned None — not enough history"}

    filters = parse_formula(formula, exchange=exchange) if formula else {}

    # Evaluate each filter key individually
    checks = {}
    from screener import _eval_sma, _eval_ema
    import re as _r

    def chk(key, val):
        p = ind["price"]
        if key == "price_min":      return p >= val
        if key == "price_max":      return p <= val
        if key == "change_pct_min": return (ind.get("change_pct") or 0) >= val
        if key == "change_pct_max": return (ind.get("change_pct") or 0) <= val
        if key == "volume_min":     return (ind.get("volume") or 0) >= val
        if key == "rsi_min":        return (ind.get("rsi") or 0) >= val
        if key == "rsi_max":        return (ind.get("rsi") or 100) <= val
        if key == "dollar_vol_min": return (ind.get("dollar_vol_20") or 0) >= val
        if key == "dollar_vol_50_min": return (ind.get("dollar_vol_50") or 0) >= val
        if key == "atr_ratio_min":  return (ind.get("atr_ratio") or 0) >= val
        if key == "candle_pos_min": return (ind.get("candle_pos") or 0) >= val
        if key == "new_52w_high":   return bool(ind.get("new_52w_high"))
        if key == "sma_conditions":
            return {c: _eval_sma(ind, c) for c in val}
        if key.startswith("not_price_below_sma"):
            m = _r.match(r'not_price_below_sma(\d+)_and_trend_dn_(\d+)', key)
            if m:
                n_s, bars_s = int(m.group(1)), int(m.group(2))
                sma_val  = ind.get(f"sma{n_s}")
                trend_dn = ind.get(f"sma{n_s}_trend_dn_{bars_s}", False)
                pb = sma_val is not None and p < sma_val
                return {"price_below_sma": pb, "sma_trend_dn": trend_dn, "pass": not (pb and trend_dn)}
        if "_trend_dn_" in key or "_trend_up_" in key:
            return bool(ind.get(key))
        return "—"

    for k, v in filters.items():
        checks[k] = {"required": v, "result": chk(k, v)}

    # Key indicator snapshot
    snapshot = {k: ind.get(k) for k in [
        "price","change_pct","sma10","sma20","sma50","sma200",
        "rsi","dollar_vol_20","dollar_vol_50","atr_ratio","candle_pos",
        "sma50_trend_dn_20","new_52w_high","last_date"
    ]}
    overall = apply_filters(ind, filters)

    return {"ticker": ticker, "overall_pass": overall,
            "snapshot": snapshot, "filter_checks": checks}

@app.get("/api/screener/earnings")
def get_earnings(symbols: str = ""):
    """Return next board-meeting / earnings dates for NSE symbols (comma-separated).
    Sourced from NSE official event calendar, cached 12 h. Returns '' for unknown symbols."""
    from earnings import get_earnings_calendar
    if not symbols.strip():
        return {}
    calendar = get_earnings_calendar()
    result = {}
    for raw in symbols.split(","):
        t = raw.strip()
        if not t:
            continue
        clean = t.replace(".NS", "").replace(".BO", "").upper()
        result[t] = calendar.get(clean, "")
    return result


@app.delete("/api/screener/cache")
def clear_ohlcv_cache(exchange: Optional[str] = None):
    """Delete cached OHLCV pickle files so the next run re-downloads."""
    removed = []
    pattern = f"{exchange}_*.pkl" if exchange else "*.pkl"
    for f in OHLCV_CACHE_DIR.glob(pattern):
        f.unlink(missing_ok=True)
        removed.append(f.name)
    return {"removed": removed}
