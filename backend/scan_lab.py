#!/usr/bin/env python3
"""
scan_lab.py — offline validation harness for the India Setup Scan (dev tool; the app
never imports this).

Rebuilds the scan from NSE's official full-market bhavcopies (every series, history
stitched by symbol) with a vectorised evaluator that mirrors
screener.compute_indicators + apply_filters exactly (`--verify` proves it name-for-name
against the engine), so any scan variant can be scored in seconds on:

  * the master's labelled setups      — recall within ±3 sessions (labels are fuzzy)
  * MIO's real 2026-05-06 result list — recall / precision (formula incl. liquidity)
  * the master's daily count           — CC India D Setup = 164 on 2026-10-09 (no liquidity)
  * daily result counts                — is the list manageable?

Data: backend/cache/nse_bhav_full/YYYYMMDD.csv (UDiFF bhavcopy, unzipped).
Usage: python3 scan_lab.py [--verify 2026-10-09] [--days 40]
"""
import os, sys, csv, argparse, collections
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "cache", "nse_bhav_full")
STOCK_SERIES = {"EQ", "BE", "BZ", "SM", "ST"}
MASTER_CSV = "/Users/vibhortyagi/Documents/Claude/Projects/Swing/master_labeled_setups.csv"
MIO_MAY6 = os.path.join(HERE, "data", "mio_may6_groundtruth.txt")


# ── data ────────────────────────────────────────────────────────────────────
def load(data_dir=DATA, series=STOCK_SERIES):
    cols = ["TradDt", "FinInstrmTp", "ISIN", "TckrSymb", "SctySrs",
            "OpnPric", "HghPric", "LwPric", "ClsPric", "PrvsClsgPric", "TtlTradgVol"]
    frames = [pd.read_csv(os.path.join(data_dir, f), usecols=cols)
              for f in sorted(os.listdir(data_dir)) if f.endswith(".csv")]
    df = pd.concat(frames, ignore_index=True)
    df["ser"] = df["SctySrs"].astype(str).str.strip()
    df = df[(df["FinInstrmTp"].astype(str).str.strip() == "STK") & df["ser"].isin(series)]
    df = df[~df["ISIN"].astype(str).str.startswith("INF")]            # MF / ETF units
    df = df.rename(columns={"TradDt": "date", "TckrSymb": "sym", "OpnPric": "O", "HghPric": "H",
                            "LwPric": "L", "ClsPric": "C",
                            "PrvsClsgPric": "PC", "TtlTradgVol": "V"})
    df["sym"] = df["sym"].astype(str).str.strip()
    df = df.sort_values("V").drop_duplicates(["sym", "date"], keep="last")   # one row per symbol-day
    return df.sort_values(["sym", "date"]).reset_index(drop=True)[["sym", "date", "ser", "O", "H", "L", "C", "PC", "V"]]


def adjust(df, lo=0.9, hi=1.11):
    """Back-adjust for splits/bonuses/rights using NSE's own adjusted previous close:
    on an ex-date PC[t] != C[t-1]; factor = PC[t] / C[t-1] scales all earlier bars."""
    df = df.copy()
    prevC = df.groupby("sym", sort=False)["C"].shift(1)
    fac = (df["PC"] / prevC).where(lambda x: (x < lo) | (x > hi), 1.0).fillna(1.0)
    # adj for row s = product of factors strictly after s (within the symbol)
    rev = fac.iloc[::-1].groupby(df["sym"].iloc[::-1], sort=False).cumprod().iloc[::-1]
    adj = (rev / fac).astype(float)
    for c in ("O", "H", "L", "C"):
        df[c] = (df[c] * adj).round(4)
    df["V"] = df["V"] / adj
    df["ca"] = fac != 1.0
    return df


# ── features (mirror of compute_indicators, daily bars) ─────────────────────
def features(df, index_close=None):
    key = df["sym"]
    C, H, L, V = (df[c].astype(float) for c in "CHLV")

    def roll(s, w, fn="mean", minp=None):
        r = s.groupby(key, sort=False).rolling(w, min_periods=minp or w)
        return getattr(r, fn)().reset_index(level=0, drop=True)

    def shift(s, k):
        return s.groupby(key, sort=False).shift(k)

    f = df.copy()
    f["n"] = df.groupby("sym", sort=False).cumcount() + 1
    pc = shift(C, 1)
    tr = pd.concat([H - L, (H - pc).abs(), (L - pc).abs()], axis=1).max(axis=1)
    f["atr_ratio"] = (tr / roll(tr, 20)).round(4)
    for n in (5, 10, 20, 50, 200):
        s = roll(C, n)
        f[f"s{n}"] = s.round(4)                      # today's SMA
        f[f"s{n}p"] = shift(s, 1).round(4)           # engine sma(): previous bar
    f["chg"] = ((C - pc) / pc * 100).round(2)
    rng = H - L
    f["cpos"] = ((C - L) / rng.where(rng > 0)).round(4)
    dv = C * V
    f["dv20"] = (roll(dv, 20, minp=1) / 1e6).round(3)   # engine: tail(20).mean()
    f["dv50"] = (roll(dv, 50) / 1e6).round(3)           # engine: None if < 50 bars
    s20, s50 = roll(C, 20), roll(C, 50)
    ge = (s20 >= s50).astype(float)
    f["lb_excl"] = (roll(shift(ge, 1), 20, "max", 1) > 0) & (f["n"] >= 51)   # bars t-20..t-1
    f["lb_incl"] = (roll(ge, 21, "max", 1) > 0) & (f["n"] >= 51)             # bars t-20..t
    f["td20p"] = (f["s50p"] < shift(s50, 21)) & (f["n"] >= 72)   # engine: prev-bar SMA50 vs 20 before it
    f["td20t"] = (f["s50"] < shift(s50, 20)) & (f["n"] >= 71)    # today's SMA50 (rounded, as engine) vs 20 bars ago
    f["pdh"] = H > shift(H, 1)                                  # trigger takes out the previous day's high
    f["ret20"] = C / shift(C, 20) - 1
    if index_close is not None:
        ix = index_close.sort_index()
        ixr = (ix / ix.shift(20) - 1).rename("ixr20")
        f = f.merge(ixr, left_on="date", right_index=True, how="left")
        f["rs20"] = f["ret20"] - f["ixr20"]
    h52 = roll(H, 252, "max", 1).round(2)
    f["pct52"] = ((C - h52) / h52 * 100).round(2)
    return f


# ── the scan, parameterised ─────────────────────────────────────────────────
# sma:   "prev" (engine today) | "today"
# m2050: "strict" (app d1: sma20 > sma50) | "excl" (MIO lookback, engine now) | "incl" (bars 0..20)
# m1020: "strict" | ("tol", x) | "drop"
# liq:   apply advol(20) > 100 and advol(50) > 100
# g52:   None or min % from 52-week high (e.g. -25)
def scan(f, cfg, dates):
    sub = f[f["date"].isin(set(dates))]
    t = cfg.get("sma", "prev") == "today"
    s10, s20, s50 = (sub[f"s{n}"] if t else sub[f"s{n}p"] for n in (10, 20, 50))
    P = sub["C"]
    m = (sub["chg"] > 0) & (sub["atr_ratio"] >= 0.6) & (sub["cpos"] >= 0.4) & (P > s10) & (P > s20)
    m1020 = cfg.get("m1020", "strict")
    if m1020 == "strict":
        m &= s10 > s20
    elif isinstance(m1020, tuple):
        m &= s10 > s20 * (1 - m1020[1])              # engine: sma(10) > sma(20) * k
    m2050 = cfg.get("m2050", "strict")
    m &= (s20 > s50) if m2050 == "strict" else sub["lb_" + m2050]
    m &= ~((P < s50) & (sub["td20t"] if t else sub["td20p"]))
    if cfg.get("ext") is not None:
        m &= P < s20 * cfg["ext"]                     # engine: price < sma(20) * k
    if cfg.get("liq", True):
        m &= (sub["dv50"] >= 100) if cfg.get("liqmode") == "50" else ((sub["dv20"] >= 100) & (sub["dv50"] >= 100))
    st2 = cfg.get("stage2")
    if st2:
        s200 = sub["s200"] if t else sub["s200p"]
        m &= P > s200
        if st2 == "full":
            m &= s50 > s200
    if cfg.get("pdh"):
        m &= sub["pdh"]
    if cfg.get("rs") is not None:
        m &= sub["rs20"] > cfg["rs"]
    if cfg.get("g52") is not None:
        m &= sub["pct52"] >= cfg["g52"]
    hit = sub[m]
    return {d: set(g["sym"]) for d, g in hit.groupby("date")}


# ── metrics ─────────────────────────────────────────────────────────────────
def master_trades():
    return [r for r in csv.DictReader(open(MASTER_CSV)) if r["quality"] != "short"]


def master_recall(f, cfg, trades, cal):
    pos = {d: i for i, d in enumerate(cal)}
    want = {}
    for r in trades:
        i = pos.get(r["entry_date"])
        if i is not None:
            want[(r["ticker"], r["entry_date"])] = cal[max(0, i - 3): i + 4]
    res = scan(f, {**cfg}, sorted({d for w in want.values() for d in w}))
    hit = {k for k, w in want.items() if any(k[0] in res.get(d, ()) for d in w)}
    rows = [(r, (r["ticker"], r["entry_date"]) in hit) for r in trades if (r["ticker"], r["entry_date"]) in want]
    c = lambda pred: (sum(1 for r, h in rows if h and pred(r)), sum(1 for r, h in rows if pred(r)))
    return {"all": c(lambda r: True), "great": c(lambda r: r["quality"] == "great"),
            "worked": c(lambda r: r["outcome"] == "worked"), "failed": c(lambda r: r["outcome"] == "failed"),
            "missed": sorted(f"{r['ticker']}({r['quality'][0]})" for r, h in rows if not h)}


def mio_may6(f, cfg):
    norm = lambda s: s.strip().upper().replace(".NS", "")
    truth = {norm(l) for l in open(MIO_MAY6) if l.strip() and not l.startswith("#")}
    truth = (truth - {"ANANTRA"}) | {"ANANTRAJ"}
    ours = scan(f, {**cfg, "liq": True}, ["2026-05-06"]).get("2026-05-06", set())
    traded = set(f.loc[f["date"] == "2026-05-06", "sym"])
    t = truth & traded
    return len(ours & t) / max(len(t), 1), len(ours & truth) / max(len(ours), 1), len(ours)


def daily_counts(f, cfg, days):
    res = scan(f, cfg, days)
    v = [len(res.get(d, ())) for d in days]
    return int(np.median(v)), int(np.percentile(v, 90)), max(v)


# ── engine cross-check ──────────────────────────────────────────────────────
def verify(df, f, date):
    sys.path.insert(0, HERE)
    import re, subprocess
    from screener import compute_indicators, parse_formula, apply_filters
    app = re.search(r'id:\s*"d1".*?formula:\s*"([^"]+)"', open(os.path.join(HERE, "..", "src/app/screener/constants.ts")).read(), re.S).group(1)
    app = app.replace("@{0..20}", "")                       # strict form, as production has it
    mio = app.replace("!(sma(20) < sma(50))", "!(sma(20) < sma(50))@{0..20}")
    Fa, Fm = parse_formula(app, exchange="NSE"), parse_formula(mio, exchange="NSE")
    Fm_nl = parse_formula(re.sub(r"advol\(\d+\) > \d+ and ", "", mio), exchange="NSE")
    eng = collections.defaultdict(set)
    syms = set(df.loc[df["date"] == date, "sym"])
    for sym, g in df[df["sym"].isin(syms) & (df["date"] <= date)].groupby("sym"):
        d = pd.DataFrame({"Open": g["O"].values, "High": g["H"].values, "Low": g["L"].values,
                          "Close": g["C"].values, "Volume": g["V"].values}, index=pd.to_datetime(g["date"].values))
        ind = compute_indicators(sym + ".NS", d, as_of_date=date, include_ohlcv=False)
        if not ind:
            continue
        for k, F in (("app", Fa), ("mio", Fm), ("mio_noliq", Fm_nl)):
            if apply_filters(ind, F):
                eng[k].add(sym)
    src = open(os.path.join(HERE, "screener.py")).read()
    lb = "incl" if "sma20_series.iloc[-21:]  #" in src else "excl"   # which lookback this engine has
    print(f"  (engine under test uses lookback window '{lb}')")
    vec = {"app": scan(f, {"m2050": "strict"}, [date]).get(date, set()),
           "mio": scan(f, {"m2050": lb}, [date]).get(date, set()),
           "mio_noliq": scan(f, {"m2050": lb, "liq": False}, [date]).get(date, set())}
    for k in ("app", "mio", "mio_noliq"):
        a, b = eng[k], vec[k]
        print(f"  {k:<10} engine {len(a):>4} | vectorised {len(b):>4} | identical: {a == b}"
              + ("" if a == b else f"  engine-only {sorted(a - b)[:8]}  vec-only {sorted(b - a)[:8]}"))


FINAL = {"sma": "today", "m2050": "incl", "m1020": ("tol", 0.01), "ext": 1.2, "liqmode": "50"}

CONFIGS = [
    ("A  production today (app d1)",        {"sma": "prev",  "m2050": "strict", "m1020": "strict"}),
    ("B  MIO exact formula",                {"sma": "prev",  "m2050": "excl",   "m1020": "strict"}),
    ("C  + lookback incl. today",           {"sma": "prev",  "m2050": "incl",   "m1020": "strict"}),
    ("D  + today's SMAs",                   {"sma": "today", "m2050": "incl",   "m1020": "strict"}),
    ("E  D + 10/20 within 1%",              {"sma": "today", "m2050": "incl",   "m1020": ("tol", 0.01)}),
    ("F  D + no 10/20 rule",                {"sma": "today", "m2050": "incl",   "m1020": "drop"}),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", default=None, help="date to prove vectorised == engine")
    ap.add_argument("--days", type=int, default=40, help="recent sessions for daily counts")
    ap.add_argument("--g52", type=float, nargs="*", default=[], help="52w-high gates to try on D/E/F")
    a = ap.parse_args()
    df = load(); f = features(df)
    cal = sorted(df["date"].unique())
    print(f"data: {len(cal)} sessions {cal[0]} → {cal[-1]} | {df['sym'].nunique()} symbols")
    if a.verify:
        print(f"\nverify vectorised vs engine on {a.verify}:"); verify(df, f, a.verify)
    trades = master_trades(); days = cal[-a.days:]
    cfgs = list(CONFIGS)
    for g in a.g52:
        for lbl, c in CONFIGS[3:]:
            cfgs.append((f"{lbl[:2]}+ 52w gate ≥{g:g}%", {**c, "g52": g}))
    print(f"\n{'config':<30}{'master ±3d':>11}{'great':>7}{'worked':>8}{'failed':>7} |"
          f"{'liq-off':>8}{'great':>7} |{'MIO rec':>8}{'prec':>6} |{'CC 9Oct':>8} |{'daily med/p90/max':>19}")
    for lbl, c in cfgs:
        m = master_recall(f, {**c, "liq": True}, trades, cal)
        mn = master_recall(f, {**c, "liq": False}, trades, cal)
        rec, prec, _ = mio_may6(f, c)
        cc = len(scan(f, {**c, "liq": False}, ["2026-10-09"]).get("2026-10-09", ()))
        med, p90, mx = daily_counts(f, {**c, "liq": True}, days)
        fr = lambda t: f"{t[0]}/{t[1]}"
        print(f"{lbl:<30}{fr(m['all']):>11}{fr(m['great']):>7}{fr(m['worked']):>8}{fr(m['failed']):>7} |"
              f"{fr(mn['all']):>8}{fr(mn['great']):>7} |{100*rec:>7.1f}%{100*prec:>5.0f}% |{cc:>5}/164 |{med:>9}/{p90}/{mx}")


if __name__ == "__main__":
    main()
