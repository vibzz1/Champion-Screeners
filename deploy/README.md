# Screener migration — single-box VPS (backend + frontend + Caddy)

Replaces Railway (backend) **and** Netlify (frontend) with **one VPS**, so the
only recurring cost is one server (~₹550–650/mo). Kills the usage-overage
billing that broke Railway and the separate Netlify charge.

```
                Cloudflare DNS (free)
                        │
                   ┌────▼────┐  :443 auto-HTTPS
                   │  Caddy  │
                   └──┬───┬──┘
        /api/*  ──────┘   └────── everything else
        ┌──────────────┐   ┌──────────────────┐
        │ uvicorn :8000│   │ next start :3000  │
        │  (FastAPI)   │   │  (Next.js SPA)    │
        └──────┬───────┘   └──────────────────┘
     CACHE_DIR=/opt/screener/data  (bhavcopy.db = 400 days NSE history)
```

## Host pick
**Contabo Cloud VPS 10** — ~$6.23/mo, 4 vCPU / **8 GB** / 75 GB NVMe, monthly, no
annual lock-in. 8 GB clears the China 3,609-ticker scan with headroom. (RackNerd
4 GB @ $59.99/yr is cheaper but needs the upfront year.)

## Steps (≈20 min)

**1. Buy the VPS** — Contabo VPS 10, Ubuntu 24.04, add your SSH key. Note the IP.

**2. Point a domain at it** — cheapest ₹99–800/yr domain on **Cloudflare (free
plan)**. Add an `A` record `@ → VPS_IP` (grey cloud / DNS-only is simplest so
Caddy can issue the cert). Wait for it to resolve.

**3. Probe the IP first (₹0, 2 min)** — budget IPs can be throttled by Yahoo/NSE:
```bash
ssh root@VPS_IP
curl -fsSL https://raw.githubusercontent.com/vibzz1/champion-screeners/main/deploy/probe.sh | bash
```
All PASS (step 3 may WARN — fine, it's a BSE-only fallback) → continue.
yfinance <90 % → destroy the box, try RackNerd/another region.

**4. Provision (one command):**
```bash
curl -fsSL https://raw.githubusercontent.com/vibzz1/champion-screeners/main/deploy/setup.sh | bash -s -- your.domain.com
```

**5. Seed the cache** (from your Mac — skips the 400-day NSE backfill):
```bash
bash deploy/push-cache.sh root@VPS_IP
curl -X POST https://your.domain.com/api/bhavcopy/dedup   # clear the stale dup candle
```

**6. Retire the old stack** — point the domain at the VPS, cancel Netlify, stop
paying Railway. Done.

## Security — do this during migration
- **Rotate the Angel One credentials.** Client ID / PIN / TOTP secret / API key
  are hardcoded in `backend/angel_client.py` and thus in git history. Regenerate
  the SmartAPI key, then put the new values in `/etc/screener.env` (chmod 600,
  never committed). Consider making the GitHub repo **private**.
- Secrets live only in `/etc/screener.env` on the box, outside the checkout.

## Day-2 ops
```bash
systemctl status screener-api screener-web caddy   # health
journalctl -u screener-api -f                       # backend logs
git -C /opt/screener/app pull && systemctl restart screener-api screener-web   # deploy (or re-run setup.sh)
ls /opt/screener/backups                            # nightly bhavcopy.db snapshots (7 kept)
```
Off-box backup: edit `/usr/local/bin/screener-backup`, enable the `rclone` line
to a Cloudflare R2 bucket (free) — a free/cheap VPS is disposable, the DB isn't.

## Why one box (not two services)
The frontend is a static client SPA that only calls `${NEXT_PUBLIC_API_URL}/api/*`.
Serving it from the same host as same-origin `/api` means **no CORS, no second
bill, no second thing to break** — Caddy just splits `/api/*` to uvicorn and the
rest to Next.
