#!/bin/bash
# deploy.sh — Run on the server to pull latest code and restart
# Usage: bash deploy.sh

set -e
APP_DIR="/home/screener/app"

echo "=== Deploying latest code ==="
sudo -u screener git -C "$APP_DIR" pull

echo "=== Installing any new dependencies ==="
sudo -u screener "$APP_DIR/backend/venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt" -q

echo "=== Restarting service ==="
systemctl restart screener
sleep 2
systemctl status screener --no-pager

echo "=== Done ==="
