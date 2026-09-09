# Morning candle-coverage monitor (box-side, Telegram)

Every trading weekday at **10:32 IST** the box checks that today's intraday
75-min candle formed across the whole NSE universe and pushes a one-line status
to Telegram. Silent-on-clean is **off** by default, so you get a daily ✅ (or ⚠)
that also confirms the monitor itself is alive.

Why on the box and not a cloud routine: the Anthropic cloud sandbox blocks
egress to `mio-screener.duckdns.org` (org policy, `curl exit 56`). The box has
the data + open internet, so it runs the check locally and only calls *out* to
Telegram.

Files:
- `backend/coverage_check.py` — the check (stdlib only; hits localhost, pushes to Telegram)
- `deploy/mio-coverage.service` — oneshot unit
- `deploy/mio-coverage.timer` — 10:32 Mon–Fri
- `deploy/mio-coverage.env.example` — secret template

## One-time setup

### 1. Create the Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **token**.
2. Message your new bot once (say "hi") so it can see your chat.
3. Get your **chat id**:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
   ```
   (or message **@userinfobot**).

### 2. Put secrets on the box
```bash
sudo tee /etc/mio-coverage.env >/dev/null <<'EOF'
TELEGRAM_BOT_TOKEN=PASTE_TOKEN_HERE
TELEGRAM_CHAT_ID=PASTE_CHAT_ID_HERE
EOF
sudo chmod 600 /etc/mio-coverage.env
```

### 3. Deploy the code + install the timer
Run as **root** (you ssh in as root). Do NOT use `sudo -u screener git pull` — the
repo's `.git` is root-owned from prior root pulls, so a screener pull dies with
`FETCH_HEAD: Permission denied`. `safe.directory` is already set for root.
```bash
cd /opt/screener/app && git pull
cp deploy/mio-coverage.service deploy/mio-coverage.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mio-coverage.timer
```

### 4. Test it now (sends a real Telegram message)
```bash
sudo systemctl start mio-coverage.service
journalctl -u mio-coverage.service -n 20 --no-pager
```
You should get a Telegram push within a few seconds. Check the next scheduled run:
```bash
systemctl list-timers mio-coverage.timer --no-pager
```

## Notes
- Internal API assumed at `127.0.0.1:8000`. If the API listens elsewhere, add
  `COVERAGE_URL=...` to `/etc/mio-coverage.env`.
- Weekday NSE holidays: `market_open` is clock-based, so a holiday can still
  produce a ⚠. Ignore it, or flip `COVERAGE_ALWAYS=0` to only hear about gaps.
- To pause: `sudo systemctl disable --now mio-coverage.timer`.
