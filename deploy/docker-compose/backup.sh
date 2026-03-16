#!/usr/bin/env bash
# backup.sh — Create a point-in-time backup of the Lima PostgreSQL database.
#
# Usage:
#   ./backup.sh [OUTPUT_DIR]
#
# OUTPUT_DIR defaults to ./backups. The script creates a timestamped gzip-
# compressed SQL dump and optionally uploads it to S3-compatible storage when
# the environment variables below are set.
#
# Required environment variables (or defaults from docker-compose.yml):
#   PGHOST       default: localhost
#   PGPORT       default: 5444
#   PGUSER       default: lima
#   PGPASSWORD   default: (empty — set this!)
#   PGDATABASE   default: lima
#
# Optional S3 upload (requires aws CLI or compatible):
#   BACKUP_S3_BUCKET    e.g. my-lima-backups
#   BACKUP_S3_ENDPOINT  e.g. http://minio:9000  (blank = AWS S3)
#   BACKUP_S3_REGION    default: us-east-1
set -euo pipefail

OUTPUT_DIR="${1:-./backups}"
mkdir -p "$OUTPUT_DIR"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5444}"
PGUSER="${PGUSER:-lima}"
PGDATABASE="${PGDATABASE:-lima}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="lima-backup-${TIMESTAMP}.sql.gz"
FILEPATH="${OUTPUT_DIR}/${FILENAME}"

echo "[backup] Starting PostgreSQL dump: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
PGPASSWORD="${PGPASSWORD:-}" pg_dump \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$PGUSER" \
    --no-password \
    --format=plain \
    --no-owner \
    --no-acl \
    "$PGDATABASE" | gzip > "$FILEPATH"

SIZE="$(du -h "$FILEPATH" | cut -f1)"
echo "[backup] Written ${FILEPATH} (${SIZE})"

# ---- Optional S3 upload ------------------------------------------------
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
    ENDPOINT_ARGS=""
    if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
        ENDPOINT_ARGS="--endpoint-url ${BACKUP_S3_ENDPOINT}"
    fi
    echo "[backup] Uploading to s3://${BACKUP_S3_BUCKET}/${FILENAME} ..."
    aws s3 cp "$FILEPATH" \
        "s3://${BACKUP_S3_BUCKET}/${FILENAME}" \
        ${ENDPOINT_ARGS} \
        --region "${BACKUP_S3_REGION:-us-east-1}"
    echo "[backup] Upload complete."
fi

echo "[backup] Done: ${FILEPATH}"
