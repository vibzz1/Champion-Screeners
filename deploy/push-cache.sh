#!/usr/bin/env bash
# Run FROM YOUR MAC to seed the VPS with the local cache (bhavcopy.db + OHLCV
# pickles). Skips a ~400-day NSE backfill on first boot.
#   bash deploy/push-cache.sh root@YOUR_VPS_IP
set -euo pipefail
TARGET="${1:?Usage: push-cache.sh user@vps_ip}"
LOCAL="$(cd "$(dirname "$0")/../backend/cache" && pwd)"
echo "Syncing $LOCAL  ->  $TARGET:/opt/screener/data/"
rsync -avz --progress \
  --exclude '*.fuse_hidden*' --exclude '*-wal' --exclude '*-shm' \
  "$LOCAL/" "$TARGET:/opt/screener/data/"
ssh "$TARGET" "chown -R screener:screener /opt/screener/data && systemctl restart screener-api"
echo "done — cache seeded, backend restarted."
