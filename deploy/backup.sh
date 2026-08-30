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

# keep last 7
ls -1t "$DEST"/bhavcopy_*.db.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

# OFF-BOX copy (configure once: `rclone config` -> remote named 'backup'):
# rclone copy "$DEST/bhavcopy_$STAMP.db.gz" backup:screener-backups/
echo "backup ok: $DEST/bhavcopy_$STAMP.db.gz"
