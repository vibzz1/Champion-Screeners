#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# probe.sh — RUN THIS FIRST on a fresh VPS, BEFORE migrating.
# Validates that this server's IP can actually reach the data sources the app
# depends on. Budget-host IPs are sometimes rate-limited by Yahoo/NSE — this is
# a ~2-minute, ~₹0 go/no-go check.  Run as root:
#   curl -fsSL https://raw.githubusercontent.com/vibzz1/champion-screeners/main/deploy/probe.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -u
echo "== screener host probe =="

# ── bootstrap: fresh Ubuntu has no pip, and 24.04 blocks system pip (PEP668),
#    so we use an isolated venv. ──────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
if ! dpkg -s python3-venv >/dev/null 2>&1; then
  echo "  (installing python3-venv + curl …)"
  apt-get update -qq && apt-get install -yqq python3-venv curl >/dev/null
fi
PV=/tmp/probe-venv
[ -x "$PV/bin/python" ] || python3 -m venv "$PV"
"$PV/bin/pip" install -q --upgrade pip >/dev/null
"$PV/bin/pip" install -q yfinance >/dev/null
PY="$PV/bin/python"

# ── [1/2] NSE Bhavcopy reachability (tries last 5 weekdays) ──────────────────
echo "--- [1/2] NSE Bhavcopy ---"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
nse_ok=0
for i in 1 2 3 4 5; do
  d=$(date -u -d "-$i day" +%d%m%Y 2>/dev/null || date -v-"$i"d +%d%m%Y)
  code=$(curl -s -o /tmp/_bhav.csv -w "%{http_code}" -m 30 -A "$UA" \
    -H "Referer: https://www.nseindia.com/" \
    "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv")
  sz=$(wc -c </tmp/_bhav.csv 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$sz" -gt 50000 ]; then
    echo "  PASS  $d -> HTTP 200, ${sz} bytes"; nse_ok=1; break
  fi
done
[ "$nse_ok" = 1 ] || echo "  FAIL — NSE archive blocked/unreachable from this IP"

# ── [2/2] yfinance bulk resolution (the real throttling tell) ───────────────
echo "--- [2/2] yfinance bulk (300 NSE tickers) ---"
"$PY" - <<'PYEOF'
import warnings, urllib.request, yfinance as yf
warnings.filterwarnings("ignore")
try:
    txt=urllib.request.urlopen("https://raw.githubusercontent.com/vibzz1/champion-screeners/main/backend/data/nse_tickers.txt",timeout=20).read().decode()
    syms=[l.strip()+".NS" for l in txt.splitlines() if l.strip() and not l.startswith("#")][:300]
except Exception:
    syms=[s+".NS" for s in ["RELIANCE","TCS","INFY","HDFCBANK","ICICIBANK","SBIN","ITC","LT","AXISBANK","BHARTIARTL"]]
raw=yf.download(syms,period="1mo",auto_adjust=True,progress=False,group_by="ticker",threads=True)
ok=0
for s in syms:
    try:
        if not raw[s].dropna().empty: ok+=1
    except Exception: pass
pct=round(ok/len(syms)*100)
print(f"  resolved {ok}/{len(syms)} = {pct}%")
print("  PASS — IP is clean" if pct>=90 else "  FAIL — yfinance throttling this IP (<90%)")
PYEOF

echo "== done. NSE PASS + yfinance >=90% -> run setup.sh =="
