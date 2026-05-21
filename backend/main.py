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
from screener import run_screen, UNIVERSES, PRESETS, OHLCV_CACHE_DIR, parse_formula, prewarm_ohlcv_cache, prewarm_intraday_ohlcv_cache

models.Base.metadata.create_all(bind=engine)

app = FastAPI()

# ── Cache pre-warm scheduler ────────────────────────────────────────────────
def _prewarm_daily_background():
    """Warm daily OHLCV cache — runs at 08:00 IST (2:30 UTC) Mon–Fri."""
    try:
        prewarm_ohlcv_cache(["NSE"])
    except Exception as e:
        print(f"[prewarm] daily background error: {e}")

def _prewarm_intraday_background():
    """Warm intraday OHLCV cache — runs at 09:45 IST (4:15 UTC) Mon–Fri.
    Scheduled 30 min after NSE opens (09:15 IST) so today's bars exist."""
    try:
        prewarm_intraday_ohlcv_cache([("NSE", 75)])
    except Exception as e:
        print(f"[prewarm] intraday background error: {e}")

@app.on_event("startup")
async def startup_event():
    # 1. Pre-warm daily cache on startup (no-op if already fresh)
    threading.Thread(target=_prewarm_daily_background, daemon=True).start()
    # 1b. Also kick off intraday pre-warm on startup (no-op if cache fresh)
    threading.Thread(target=_prewarm_intraday_background, daemon=True).start()

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
        # Intraday OHLCV: 09:45 IST = 04:15 UTC  (30 min after NSE open)
        scheduler.add_job(
            _prewarm_intraday_background,
            CronTrigger(hour=4, minute=15, day_of_week="mon-fri", timezone=pytz.utc),
            id="nse_prewarm_intraday",
            replace_existing=True,
        )
        scheduler.start()
        print("[prewarm] Scheduler started — daily@08:00IST, intraday@09:45IST (Mon–Fri)")
    except Exception as e:
        print(f"[prewarm] Scheduler setup failed: {e}")

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
        filter_blocks = [parse_formula(b) for b in blocks]
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
    formula = body.get("formula", "")
    return parse_formula(formula)

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

    filters = parse_formula(formula) if formula else {}

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
