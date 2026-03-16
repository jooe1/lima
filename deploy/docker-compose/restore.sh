#!/usr/bin/env bash
# restore.sh — Restore a Lima PostgreSQL backup produced by backup.sh.
#
# Usage:
#   ./restore.sh <BACKUP_FILE>
#
# BACKUP_FILE can be a local path to a .sql.gz file, an s3:// URI, or a plain
# .sql file.  The script drops all objects in the target database before
# restoring, so use it only against a fresh or dedicated restore target.
#
# Environment variables (same defaults as backup.sh):
#   PGHOST      default: localhost
#   PGPORT      default: 5444
#   PGUSER      default: lima
#   PGPASSWORD  (required)
#   PGDATABASE  default: lima
#
# For S3 sources set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or use an
# IAM role, instance profile, etc.) in addition to BACKUP_S3_ENDPOINT if
# using non-AWS storage.
set -euo pipefail

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
    echo "Usage: $0 <backup-file.sql.gz|s3://bucket/key>" >&2
    exit 1
fi

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5444}"
PGUSER="${PGUSER:-lima}"
PGDATABASE="${PGDATABASE:-lima}"

TMPFILE=""
# ---- Download from S3 if needed ----------------------------------------
if [[ "$BACKUP_FILE" == s3://* ]]; then
    TMPFILE="$(mktemp /tmp/lima-restore-XXXXXX.sql.gz)"
    trap 'rm -f "$TMPFILE"' EXIT

    ENDPOINT_ARGS=""
    if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
        ENDPOINT_ARGS="--endpoint-url ${BACKUP_S3_ENDPOINT}"
    fi
    echo "[restore] Downloading ${BACKUP_FILE} ..."
    aws s3 cp "$BACKUP_FILE" "$TMPFILE" ${ENDPOINT_ARGS} \
        --region "${BACKUP_S3_REGION:-us-east-1}"
    BACKUP_FILE="$TMPFILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "[restore] File not found: ${BACKUP_FILE}" >&2
    exit 1
fi

echo "[restore] Target: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
echo "[restore] WARNING: this will DROP and recreate all objects in ${PGDATABASE}."
read -r -p "Type YES to continue: " confirm
if [[ "$confirm" != "YES" ]]; then
    echo "[restore] Aborted."
    exit 0
fi

# ---- Drop and recreate the database ------------------------------------
echo "[restore] Recreating database ..."
PGPASSWORD="${PGPASSWORD:-}" psql \
    --host="$PGHOST" --port="$PGPORT" \
    --username="$PGUSER" --no-password \
    -d postgres \
    -c "DROP DATABASE IF EXISTS \"${PGDATABASE}\";"
PGPASSWORD="${PGPASSWORD:-}" psql \
    --host="$PGHOST" --port="$PGPORT" \
    --username="$PGUSER" --no-password \
    -d postgres \
    -c "CREATE DATABASE \"${PGDATABASE}\" OWNER \"${PGUSER}\";"

# ---- Restore -----------------------------------------------------------
echo "[restore] Restoring from ${BACKUP_FILE} ..."
if [[ "$BACKUP_FILE" == *.gz ]]; then
    gunzip -c "$BACKUP_FILE" | PGPASSWORD="${PGPASSWORD:-}" psql \
        --host="$PGHOST" --port="$PGPORT" \
        --username="$PGUSER" --no-password \
        --dbname="$PGDATABASE" \
        --single-transaction \
        --on-error-stop
else
    PGPASSWORD="${PGPASSWORD:-}" psql \
        --host="$PGHOST" --port="$PGPORT" \
        --username="$PGUSER" --no-password \
        --dbname="$PGDATABASE" \
        --single-transaction \
        --on-error-stop \
        -f "$BACKUP_FILE"
fi

echo "[restore] Restore complete."
