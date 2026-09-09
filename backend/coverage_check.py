#!/usr/bin/env python3
"""Morning NSE intraday candle-coverage check -> Telegram push.

Run on the VPS by a systemd timer at 10:32 IST on trading weekdays, i.e. just
after the first 75-min candle closes at 10:30. It hits the screener's own
coverage endpoint on localhost (forcing a refresh so any missing names get one
last pull), then pushes a terse status line to Telegram.

This replaces the cloud-routine approach, which cannot reach the VPS: the
Anthropic cloud sandbox blocks egress to mio-screener.duckdns.org by org policy
(curl exit 56 / connect_rejected). Running the check *on the box* has no such
limit and needs no public round-trip.

Config comes from the environment (see /etc/mio-coverage.env):
  TELEGRAM_BOT_TOKEN   bot token from @BotFather (required)
  TELEGRAM_CHAT_ID     your chat id (required)
  COVERAGE_URL         override the endpoint (default localhost:8000, refresh=1)
  COVERAGE_MIN         threshold %% below which it flags a gap (default 98)
  COVERAGE_ALWAYS      "1" (default) pushes daily even when clean; "0" = gaps only
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = os.environ.get(
    "COVERAGE_URL",
    "http://127.0.0.1:8000/api/intraday/coverage?refresh=1",
)
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
COVERAGE_MIN = float(os.environ.get("COVERAGE_MIN", "98"))
ALWAYS = os.environ.get("COVERAGE_ALWAYS", "1").strip() != "0"
# The forced refresh (refresh=1) does a full intraday pull and can run ~4 min,
# so give it real headroom; a stall past this falls back to a fast plain read.
FETCH_TIMEOUT = float(os.environ.get("COVERAGE_TIMEOUT", "300"))


def tg(text: str) -> None:
    """Send a plain-text message to the configured Telegram chat."""
    if not TOKEN or not CHAT:
        print("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set", file=sys.stderr)
        return
    data = urllib.parse.urlencode(
        {"chat_id": CHAT, "text": text, "disable_web_page_preview": "true"}
    ).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TOKEN}/sendMessage", data=data
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
    except Exception as e:  # don't let a Telegram hiccup crash the unit
        print(f"telegram send failed: {e}", file=sys.stderr)


def fetch(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def main() -> None:
    stale = False
    try:
        d = fetch(API, FETCH_TIMEOUT)
    except Exception as e_refresh:
        # Forced refresh stalled/timed out. Fall back to a fast unrefreshed read
        # so we still deliver a report (tagged) rather than a bare "unreachable".
        try:
            d = fetch(API.replace("refresh=1", "refresh=0"), 60)
            stale = True
        except Exception as e_plain:
            tg(
                "⚠ MIO coverage check couldn't reach the screener API "
                f"(refresh: {e_refresh}; plain: {e_plain})"
            )
            return

    # Weekday NSE holidays: market_open is clock-based, so this won't catch
    # every holiday, but when the endpoint already knows the market is shut we
    # skip quietly rather than push a spurious gap alert.
    if not d.get("market_open", True):
        return

    total = int(d.get("total", 0) or 0)
    fresh = int(d.get("fresh", 0) or 0)
    pct = float(d.get("coverage_pct", 0.0) or 0.0)
    missing = d.get("missing_liquid") or []
    mlc = int(d.get("missing_liquid_count", len(missing)) or 0)
    as_of = str(d.get("as_of", "")).replace("T", " ")[:16]

    gap = pct < COVERAGE_MIN or mlc > 0
    if not gap and not ALWAYS:
        return

    head = (
        "⚠ NSE intraday feed has gaps this morning"
        if gap
        else "✅ NSE intraday feed healthy"
    )
    lines = [head, f"coverage {pct:.1f}% ({fresh}/{total} fresh)  ·  {as_of}"]
    if stale:
        lines.append("(forced refresh timed out — read without a fresh pull; coverage may be understated)")
    if mlc:
        lines.append(f"{mlc} liquid name(s) missing today's candle:")
        for m in missing[:10]:
            lines.append(f"  • {m.get('symbol')} ({m.get('advol')} ₹M/day)")
        if mlc > 10:
            lines.append(f"  … and {mlc - 10} more")
        lines.append("→ worth a manual re-run of the scan before trading.")
    tg("\n".join(lines))


if __name__ == "__main__":
    main()
