#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — one-shot provisioner for the single-box screener stack.
# Runs the FastAPI backend + Next.js frontend + Caddy (auto-HTTPS) on one VPS.
# Idempotent: safe to re-run (it updates code + restarts services).
#
# Fresh Ubuntu 24.04, as root:
#   curl -fsSL https://raw.githubusercontent.com/vibzz1/champion-screeners/main/deploy/setup.sh | bash -s -- your.domain.com
# or:
#   bash setup.sh your.domain.com [git_ref]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# curl|bash can hand us a stripped PATH → apt-get/systemctl "command not found"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

DOMAIN="${1:?Usage: setup.sh <domain> [git_ref]}"
GIT_REF="${2:-main}"
REPO="https://github.com/vibzz1/champion-screeners.git"
APP=/opt/screener/app
DATA=/opt/screener/data
USER=screener

echo "==> Provisioning screener on $DOMAIN (ref $GIT_REF)"

# ── packages ────────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq git python3-venv python3-pip rsync ufw curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https sqlite3 rclone

# Node 20 (Next 16 needs >=18.18)
if ! node -v 2>/dev/null | grep -qE "v(20|22)"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -yq nodejs
fi

# Caddy
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -q && apt-get install -yq caddy
fi

# ── user + dirs ─────────────────────────────────────────────────────────────
id -u "$USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER"
mkdir -p "$APP" "$DATA"

# ── code ────────────────────────────────────────────────────────────────────
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --depth 1 origin "$GIT_REF" && git -C "$APP" reset --hard "origin/$GIT_REF"
else
  git clone --depth 1 -b "$GIT_REF" "$REPO" "$APP"
fi
chown -R "$USER:$USER" "$APP" "$DATA"

# ── env file (secrets live OUTSIDE the repo) ────────────────────────────────
if [ ! -f /etc/screener.env ]; then
  cat >/etc/screener.env <<EOF
# Cache path OUTSIDE the git checkout so 'git pull' never touches the 128MB DB.
CACHE_DIR=$DATA
# Angel One (BSE fallback). ROTATE these and fill them in — do NOT rely on the
# hardcoded defaults in the repo. NSE runs on Bhavcopy and needs none of this.
#ANGEL_CLIENT_ID=
#ANGEL_PIN=
#ANGEL_TOTP_SECRET=
#ANGEL_API_KEY=
#SENTRY_DSN=
EOF
  chmod 600 /etc/screener.env
fi

# ── backend ─────────────────────────────────────────────────────────────────
sudo -u "$USER" python3 -m venv "$APP/backend/venv"
sudo -u "$USER" "$APP/backend/venv/bin/pip" install -q --upgrade pip
sudo -u "$USER" "$APP/backend/venv/bin/pip" install -q -r "$APP/backend/requirements.txt"

# ── frontend (build with same-origin API base) ─────────────────────────────
cd "$APP"
sudo -u "$USER" npm ci --no-audit --no-fund
sudo -u "$USER" env NEXT_PUBLIC_API_URL="https://$DOMAIN" npm run build

# ── systemd units ───────────────────────────────────────────────────────────
cp "$APP/deploy/screener-api.service" /etc/systemd/system/
cp "$APP/deploy/screener-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now screener-api screener-web

# ── Caddy ───────────────────────────────────────────────────────────────────
sed "s/{\$DOMAIN}/$DOMAIN/g" "$APP/deploy/Caddyfile" >/etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

# ── nightly off-box-ready backup + firewall ─────────────────────────────────
install -m 755 "$APP/deploy/backup.sh" /usr/local/bin/screener-backup
( crontab -l 2>/dev/null | grep -v screener-backup; echo "30 20 * * * /usr/local/bin/screener-backup >/dev/null 2>&1" ) | crontab -

ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
yes | ufw enable  >/dev/null 2>&1 || true

echo "==> DONE."
echo "    Backend : systemctl status screener-api"
echo "    Frontend: systemctl status screener-web"
echo "    Site    : https://$DOMAIN   (after DNS points here + cert issues, ~30s)"
echo "    NEXT: (1) rsync your local backend/cache -> $DATA to skip the 400-day NSE backfill"
echo "          (2) curl -X POST https://$DOMAIN/api/bhavcopy/dedup   # clear the stale dup candle"
