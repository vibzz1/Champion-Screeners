from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import random
import math
import os
from database import get_db, engine
import models
from screener import run_screen, UNIVERSES, PRESETS, OHLCV_CACHE_DIR, parse_formula

models.Base.metadata.create_all(bind=engine)

app = FastAPI()

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
    interval: str = "1d"                   # "1d" (daily) or "75min"
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
    if body.formula and body.formula.strip():
        filters = parse_formula(body.formula)
        if not filters:
            # Formula was provided but nothing was recognized — refuse to return all stocks
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
    else:
        filters = body.model_dump(exclude={"exchange", "formula"}, exclude_none=True)
    results, is_live = run_screen(body.exchange, filters, as_of_date=body.as_of_date or None, interval=body.interval)
    return {"count": len(results), "results": results, "live": is_live}

@app.post("/api/screener/parse")
def parse_formula_endpoint(body: dict):
    """Parse a formula string and return the resulting filter dict."""
    formula = body.get("formula", "")
    return parse_formula(formula)

@app.delete("/api/screener/cache")
def clear_ohlcv_cache(exchange: Optional[str] = None):
    """Delete cached OHLCV pickle files so the next run re-downloads."""
    removed = []
    pattern = f"{exchange}_*.pkl" if exchange else "*.pkl"
    for f in OHLCV_CACHE_DIR.glob(pattern):
        f.unlink(missing_ok=True)
        removed.append(f.name)
    return {"removed": removed}
