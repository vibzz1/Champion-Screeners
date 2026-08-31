#!/usr/bin/env bash
# Nightly backup of the irreplaceable NSE history DB (400+ trading days).
# Keeps 7 local rotating copies in /opt/screener/backups.
# OFF-BOX (recommended): uncomment the rclone line and configure a remote
# (Cloudflare R2 free tier, or `rclone sync` to your Mac) so a dead VPS can't
# take the DB with it.
set -euo pipefail
DATA=/opt/screener/data
DEST=/opt/screener/backups
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d)
DB="$DATA/bhavcopy.db"
[ -f "$DB" ] || { echo "no bhavcopy.db yet"; exit 0; }

# consistent snapshot even while the API is reading it
command -v sqlite3 >/dev/null && sqlite3 "$DB" ".backup '$DEST/bhavcopy_$STAMP.db'" \
  || cp "$DB" "$DEST/bhavcopy_$STAMP.db"
gzip -f "$DEST/bhavcopy_$STAMP.db"

# keep last 7 local
ls -1t "$DEST"/bhavcopy_*.db.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

# ── OFF-BOX copy → Cloudflare R2 (free 10GB) ────────────────────────────────
# Enabled automatically once an rclone remote named 'backup' exists.
# One-time on the VPS:  rclone config   (see deploy/README.md → "Off-box backup")
BUCKET="${R2_BUCKET:-screener-backups}"
if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -q '^backup:'; then
  if rclone copy "$DEST/bhavcopy_$STAMP.db.gz" "backup:$BUCKET/" 2>/tmp/rclone.err; then
    # keep only the last 14 off-box, prune the rest
    rclone delete --min-age 14d "backup:$BUCKET/" 2>/dev/null || true
    echo "backup ok (local + R2): bhavcopy_$STAMP.db.gz"
  else
    echo "WARN local backup ok but R2 push failed: $(cat /tmp/rclone.err)"
  fi
else
  echo "backup ok (local only — no 'backup' rclone remote): $DEST/bhavcopy_$STAMP.db.gz"
fi
