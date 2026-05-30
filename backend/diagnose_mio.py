#!/usr/bin/env python3
"""
diagnose_mio.py — Compare our May 6 scan with MIO ground truth.
Run from backend/ directory:
    python diagnose_mio.py
"""
import sys, pickle, re as _re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from screener import parse_formula, compute_indicators, apply_filters, UNIVERSES, OHLCV_CACHE_DIR, _NOT_BELOW_RE
from screener import _eval_sma

FORMULA = (
    "advol(20) > 100 and advol(50) > 100 "
    "and !(sma(20) < sma(50))@{0..20} "
    "and !(price < sma(50) and sma(50) trend_dn 20) "
    "and price > sma(10) and price > sma(20) "
    "and sma(10) > sma(20) and price > c[1] "
    "and atr(1) > atr(20) * 0.6 "
    "and price > low + ((high - low) * 0.4)"
)
AS_OF    = "2026-05-06"
EXCHANGE = "NSE"

# ── Load MIO ground truth ──────────────────────────────────────────────────
mio_file = Path(__file__).parent / "data/mio_may6_groundtruth.txt"
mio_tickers = set()
for line in mio_file.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#"):
        mio_tickers.add(line)
print(f"MIO ground truth: {len(mio_tickers)} tickers")

# ── Load OHLCV cache ───────────────────────────────────────────────────────
cache_files = sorted(OHLCV_CACHE_DIR.glob("NSE_*.pkl"))
if not cache_files:
    print("ERROR: No NSE cache found. Run a scan first to populate it.")
    sys.exit(1)
cache_file = cache_files[-1]
print(f"Loading cache: {cache_file.name}")
with open(cache_file, "rb") as f:
    ohlcv_data = pickle.load(f)
print(f"Cache: {len(ohlcv_data)} tickers")

# ── Parse formula ──────────────────────────────────────────────────────────
filters = parse_formula(FORMULA, exchange=EXCHANGE)
print(f"Parsed filters: {sorted(filters.keys())}\n")

# ── Run scan ───────────────────────────────────────────────────────────────
tickers      = UNIVERSES[EXCHANGE]
our_tickers  = set()
indicator_map: dict = {}

print(f"Scanning {len(tickers)} NSE tickers for {AS_OF} ...")
no_data = []
for ticker in tickers:
    df = ohlcv_data.get(ticker)
    if df is None:
        no_data.append(ticker)
        continue
    ind = compute_indicators(ticker, df, as_of_date=AS_OF, include_ohlcv=False)
    if ind is None:
        no_data.append(ticker)
        continue
    indicator_map[ticker] = ind
    if apply_filters(ind, filters):
        our_tickers.add(ticker)

print(f"Our scan:  {len(our_tickers)} matches")
print(f"No data:   {len(no_data)} tickers skipped")

# ── Universe intersection ──────────────────────────────────────────────────
universe_set    = set(tickers)
mio_in_universe = mio_tickers & universe_set
mio_not_in_univ = mio_tickers - universe_set
print(f"\nMIO total: {len(mio_tickers)} | in our universe: {len(mio_in_universe)} | not in universe: {len(mio_not_in_univ)}")
if mio_not_in_univ:
    print(f"  MIO tickers not in our universe: {sorted(mio_not_in_univ)}")

matched   = our_tickers & mio_in_universe
false_pos = our_tickers - mio_in_universe   # we pass, MIO doesn't
false_neg = mio_in_universe - our_tickers   # MIO passes, we don't

print(f"\nMatched:         {len(matched)}")
print(f"False positives: {len(false_pos)}  (we pass, MIO doesn't)")
print(f"False negatives: {len(false_neg)}  (MIO passes, we don't)")
print(f"Total mismatch:  {len(false_pos) + len(false_neg)}")

# ── Helper: explain which filter(s) failed ─────────────────────────────────
def failed_filters(ind: dict, f: dict) -> list[str]:
    reasons = []
    p = ind["price"]

    if f.get("dollar_vol_min") is not None:
        dv = ind.get("dollar_vol_20")
        if dv is None or dv < f["dollar_vol_min"]:
            reasons.append(f"advol20={dv:.2f} < {f['dollar_vol_min']}")

    if f.get("dollar_vol_50_min") is not None:
        dv50 = ind.get("dollar_vol_50")
        if dv50 is None or dv50 < f["dollar_vol_50_min"]:
            reasons.append(f"advol50={dv50} < {f['dollar_vol_50_min']}")

    for fkey, fval in f.items():
        if fval is True and '_not_below_sma' in fkey and '_lookback_' in fkey:
            if not ind.get(fkey, False):
                reasons.append(f"sma_lookback FAIL ({fkey}=False)")

    for cond in f.get("sma_conditions", []):
        if not _eval_sma(ind, cond):
            reasons.append(f"sma_cond FAIL: {cond}")

    for fkey, fval in f.items():
        if fval is True and fkey.startswith('not_price_below_sma'):
            m = _NOT_BELOW_RE.match(fkey)
            if m:
                n_s, bars_s = int(m.group(1)), int(m.group(2))
                sma_val = ind.get(f"sma{n_s}")
                trend_dn = ind.get(f"sma{n_s}_trend_dn_{bars_s}", False)
                if sma_val is not None and p < sma_val and trend_dn:
                    reasons.append(f"price<sma{n_s}({sma_val:.2f}) & trend_dn")

    for fkey, fval in f.items():
        if fval is True and fkey.startswith('not_sma') and '_trend_dn_' in fkey:
            actual_key = fkey[4:]
            if ind.get(actual_key, False):
                reasons.append(f"trend_dn ({actual_key}=True)")

    chg = ind.get("change_pct")
    if f.get("change_pct_min") is not None and (chg is None or chg < f["change_pct_min"]):
        reasons.append(f"change={chg} < {f['change_pct_min']}")

    ar = ind.get("atr_ratio")
    if f.get("atr_ratio_min") is not None and (ar is None or ar < f["atr_ratio_min"]):
        reasons.append(f"atr_ratio={ar} < {f['atr_ratio_min']}")

    cp = ind.get("candle_pos")
    if f.get("candle_pos_min") is not None and (cp is None or cp < f["candle_pos_min"]):
        reasons.append(f"candle_pos={cp} < {f['candle_pos_min']}")

    return reasons


def fmt_ind(ind: dict) -> str:
    return (
        f"  price={ind.get('price')}  chg={ind.get('change_pct')}%  "
        f"advol20={ind.get('dollar_vol_20')}M  advol50={ind.get('dollar_vol_50')}M\n"
        f"  sma10={ind.get('sma10')}  sma20={ind.get('sma20')}  sma50={ind.get('sma50')}\n"
        f"  atr_ratio={ind.get('atr_ratio')}  candle_pos={ind.get('candle_pos')}\n"
        f"  lookback20={ind.get('sma20_not_below_sma50_lookback_20')}  "
        f"sma50_trend_dn_20={ind.get('sma50_trend_dn_20')}"
    )


# ── FALSE NEGATIVES: MIO has, we don't ────────────────────────────────────
print("\n" + "="*80)
print(f"FALSE NEGATIVES — {len(false_neg)} stocks MIO passes but WE REJECT:")
print("="*80)
fn_reasons: dict[str, list[str]] = {}
for ticker in sorted(false_neg):
    ind = indicator_map.get(ticker)
    if ind is None:
        print(f"\n{ticker}: *** NO DATA IN CACHE ***")
        fn_reasons[ticker] = ["no_data"]
        continue
    reasons = failed_filters(ind, filters)
    fn_reasons[ticker] = reasons
    label = ', '.join(reasons) if reasons else "PASSES ALL? (logic bug)"
    print(f"\n{ticker}: {label}")
    print(fmt_ind(ind))

# ── FALSE POSITIVES: we pass, MIO doesn't ─────────────────────────────────
print("\n" + "="*80)
print(f"FALSE POSITIVES — {len(false_pos)} stocks WE PASS but MIO REJECTS:")
print("="*80)
for ticker in sorted(false_pos):
    ind = indicator_map.get(ticker)
    if ind is None:
        print(f"\n{ticker}: *** NO DATA ***")
        continue
    print(f"\n{ticker}: passes all our filters")
    print(fmt_ind(ind))

# ── Summary by failure reason ──────────────────────────────────────────────
from collections import Counter
reason_counter: Counter = Counter()
for reasons in fn_reasons.values():
    for r in reasons:
        # Bucket by leading keyword
        key = r.split("=")[0].split("<")[0].strip()
        reason_counter[key] += 1

print("\n" + "="*80)
print("FALSE NEGATIVE FAILURE BREAKDOWN:")
for reason, count in reason_counter.most_common():
    print(f"  {count:3d}  {reason}")
