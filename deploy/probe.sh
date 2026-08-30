#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# probe.sh — RUN THIS FIRST on a fresh VPS, BEFORE migrating.
# Validates that this server's IP can actually reach the 3 data sources the app
# depends on. Budget-host IPs (Hetzner/Contabo/RackNerd) are sometimes rate-
# limited by Yahoo/NSE — this is a ~2-minute, ~₹0 go/no-go check.
#
# Usage:  bash probe.sh
# PASS  → safe to run setup.sh
# FAIL  → destroy the box, try another host
# ─────────────────────────────────────────────────────────────────────────────
set -u
echo "== screener host probe =="

# 1) NSE Bhavcopy reachability (needs a real trading weekday; tries last 5 days)
echo "--- [1/3] NSE Bhavcopy ---"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
nse_ok=0
for i in 1 2 3 4 5; do
  d=$(date -u -d "-$i day" +%d%m%Y 2>/dev/null || date -v-"$i"d +%d%m%Y)
  code=$(curl -s -o /tmp/_bhav.csv -w "%{http_code}" -m 30 -A "$UA" \
    -H "Referer: https://www.nseindia.com/" \
    "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv")
  sz=$(wc -c </tmp/_bhav.csv 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$sz" -gt 50000 ]; then
    echo "  OK  $d -> HTTP 200, ${sz} bytes"; nse_ok=1; break
  fi
done
[ "$nse_ok" = 1 ] && echo "  PASS" || echo "  FAIL — NSE archive blocked or unreachable from this IP"

# 2) yfinance bulk resolution rate (the real throttling tell)
echo "--- [2/3] yfinance bulk (300 NSE tickers) ---"
python3 - <<'PY'
import sys, subprocess
try:
    import yfinance  # noqa
except Exception:
    subprocess.run([sys.executable,"-m","pip","install","-q","yfinance"], check=False)
import warnings, yfinance as yf
warnings.filterwarnings("ignore")
import urllib.request
# pull the repo's NSE list (first 300) or fall back to a small built-in set
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
print("  PASS" if pct>=90 else "  FAIL — yfinance is throttling this IP (<90% resolved)")
PY

# 3) Angel One SmartAPI login (uses env vars if set, else the app's defaults)
echo "--- [3/3] Angel One SmartAPI login ---"
python3 - <<'PY'
import os, sys, subprocess
for pkg in ("pyotp","smartapi-python","logzero","requests"):
    try: __import__(pkg.replace("-","_").replace("smartapi_python","SmartApi"))
    except Exception: subprocess.run([sys.executable,"-m","pip","install","-q",pkg],check=False)
try:
    from SmartApi import SmartConnect
    import pyotp
    cid=os.environ.get("ANGEL_CLIENT_ID","V119180")
    pin=os.environ.get("ANGEL_PIN","1235")
    tot=os.environ.get("ANGEL_TOTP_SECRET","ANOTHBL5HZBJ7YBP6C2SFWEL3U")
    key=os.environ.get("ANGEL_API_KEY","AgqDUsEv")
    s=SmartConnect(api_key=key)
    r=s.generateSession(cid,pin,pyotp.TOTP(tot).now())
    print("  PASS — login OK" if r.get("status") else f"  FAIL — {r.get('message')}")
except Exception as e:
    print(f"  WARN — could not test ({type(e).__name__}: {e}). Angel is a fallback for BSE only; NSE runs on Bhavcopy.")
PY

echo "== done. All three PASS (or #3 WARN) → run setup.sh =="
