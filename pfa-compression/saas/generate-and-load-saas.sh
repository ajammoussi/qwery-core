#!/bin/bash

# SaaS/B2B analytics synthetic data generation and loading script

set -euo pipefail

SAAS_SCALE_FACTOR=${SAAS_SCALE_FACTOR:-1}
SAAS_MONTHS=${SAAS_MONTHS:-24}
SAAS_SEED=${SAAS_SEED:-42}
DATA_DIR=${DATA_DIR:-/tmp/saas_data}
DBNAME=${POSTGRES_DB:-saas_analytics}
PGUSER=${POSTGRES_USER:-postgres}

# During docker-entrypoint init, PostgreSQL is exposed on local unix socket.
unset PGHOST
unset PGPORT

echo "========================================="
echo "SaaS Analytics Data Generation and Loading"
echo "========================================="
echo "Scale Factor: ${SAAS_SCALE_FACTOR}"
echo "History Window (months): ${SAAS_MONTHS}"
echo "Seed: ${SAAS_SEED}"
echo "Data Directory: ${DATA_DIR}"
echo "Database: ${DBNAME}"
echo "========================================="

mkdir -p "${DATA_DIR}"

echo "[1/3] Generating synthetic SaaS analytics data..."
python3 /usr/local/bin/generate-saas-data.py

echo "      Data generation complete"
echo "[2/3] Loading synthetic data into PostgreSQL..."

import_table() {
  local table="$1"
  local file="${DATA_DIR}/${table}.csv"

  if [ -f "$file" ]; then
    echo "      Loading $table..."
    psql -v ON_ERROR_STOP=1 \
      --username "$PGUSER" \
      --dbname "$DBNAME" \
      -c "\\COPY $table FROM '$file' WITH (FORMAT csv)"
  fi
}

import_table "plans"
import_table "accounts"
import_table "users"
import_table "subscriptions"
import_table "invoices"
import_table "events"
import_table "feature_usage"

echo "      Data loading complete"

echo "[3/4] Creating indexes..."
psql -v ON_ERROR_STOP=1 \
  --username "$PGUSER" \
  --dbname "$DBNAME" \
  -f /usr/local/share/sql/post-load-indexes-saas.sql

echo "      Index creation complete"

echo ""
echo "========================================="
echo "[4/4] Data Verification"
echo "========================================="

psql -v ON_ERROR_STOP=1 \
  --username "$PGUSER" \
  --dbname "$DBNAME" \
  -c "
SELECT 'accounts' as table_name, count(*) as row_count FROM accounts
UNION ALL
SELECT 'users', count(*) FROM users
UNION ALL
SELECT 'subscriptions', count(*) FROM subscriptions
UNION ALL
SELECT 'plans', count(*) FROM plans
UNION ALL
SELECT 'events', count(*) FROM events
UNION ALL
SELECT 'feature_usage', count(*) FROM feature_usage
UNION ALL
SELECT 'invoices', count(*) FROM invoices
ORDER BY table_name;
"

echo ""
echo "========================================="
echo "SaaS Analytics Database Ready!"
echo "========================================="
echo ""
echo "Connection Details:"
echo "  Host: localhost"
echo "  Port: 5432"
echo "  Database: ${DBNAME}"
echo "  User: ${PGUSER}"
echo ""
echo "Example connection:"
echo "  psql -h localhost -U ${PGUSER} -d ${DBNAME}"
echo ""
