#!/bin/bash
# setup.sh — Run once on a fresh Ubuntu 24.04 Hetzner server as root
# Usage: bash setup.sh

set -e
echo "=== Champion Screener — Server Setup ==="

# ── 1. System packages ────────────────────────────────────────────────────
apt-get update -y
apt-get install -y python3 python3-pip python3-venv git nginx certbot python3-certbot-nginx ufw

# ── 2. Firewall ───────────────────────────────────────────────────────────
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "Firewall configured"

# ── 3. App user ───────────────────────────────────────────────────────────
if ! id -u screener &>/dev/null; then
    useradd -m -s /bin/bash screener
    echo "User 'screener' created"
fi

# ── 4. Clone / update repo ────────────────────────────────────────────────
APP_DIR="/home/screener/app"
if [ -d "$APP_DIR/.git" ]; then
    echo "Repo exists — pulling latest…"
    sudo -u screener git -C "$APP_DIR" pull
else
    echo "Cloning repo…"
    sudo -u screener git clone https://github.com/vibzz1/Champion-Screeners.git "$APP_DIR"
fi

# ── 5. Python venv + deps ─────────────────────────────────────────────────
sudo -u screener python3 -m venv "$APP_DIR/backend/venv"
sudo -u screener "$APP_DIR/backend/venv/bin/pip" install --upgrade pip
sudo -u screener "$APP_DIR/backend/venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"
echo "Python dependencies installed"

# ── 6. Cache dirs ─────────────────────────────────────────────────────────
sudo -u screener mkdir -p "$APP_DIR/backend/cache/ohlcv"
echo "Cache directories created"

# ── 7. Systemd service ────────────────────────────────────────────────────
cp /tmp/screener.service /etc/systemd/system/screener.service
systemctl daemon-reload
systemctl enable screener
systemctl restart screener
echo "Systemd service installed and started"

# ── 8. Nginx config ───────────────────────────────────────────────────────
cp /tmp/screener-nginx /etc/nginx/sites-available/screener
ln -sf /etc/nginx/sites-available/screener /etc/nginx/sites-enabled/screener
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "Nginx configured"

echo ""
echo "=== Setup complete! ==="
echo "Backend running at http://$(curl -s ifconfig.me):80"
echo "Next: point your domain and run: certbot --nginx -d yourdomain.com"
