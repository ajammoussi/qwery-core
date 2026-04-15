#!/bin/bash

# TPC-H Data Generation and Loading Script
# This script generates official TPC-H benchmark data and loads it into PostgreSQL

set -euo pipefail

# Configuration
SCALE_FACTOR=${SCALE_FACTOR:-1}  # 1 = ~1GB, 10 = ~10GB, 100 = ~100GB
DATA_DIR=${DATA_DIR:-/tmp/tpch_data}
DBNAME=${POSTGRES_DB:-tpch}
PGUSER=${POSTGRES_USER:-postgres}

# During docker-entrypoint init, PostgreSQL is exposed on local unix socket.
unset PGHOST
unset PGPORT

echo "========================================="
echo "TPC-H Data Generation and Loading"
echo "========================================="
echo "Scale Factor: ${SCALE_FACTOR} GB"
echo "Data Directory: ${DATA_DIR}"
echo "Database: ${DBNAME}"
echo "========================================="

# Create data directory
mkdir -p "${DATA_DIR}"
cd "${DATA_DIR}"

# dbgen expects dists.dss in current working directory
cp -f /tmp/dists.dss ./dists.dss

# Generate TPC-H data using dbgen
echo "[1/3] Generating TPC-H data (Scale Factor: ${SCALE_FACTOR})..."
echo "      This may take a few minutes for large scale factors..."

dbgen -s "${SCALE_FACTOR}" -f

echo "      ✓ Data generation complete"

# Load data into PostgreSQL
echo "[2/3] Loading TPC-H data into PostgreSQL..."

# Import tables with pipe-separated values
import_table() {
  local table="$1"
  local file="${DATA_DIR}/${table}.tbl"
  
  if [ -f "$file" ]; then
    echo "      Loading $table..."
    sed 's/|$//' "$file" | psql -v ON_ERROR_STOP=1 \
      --username "$PGUSER" \
      --dbname "$DBNAME" \
      -c "\COPY $table FROM STDIN WITH (FORMAT csv, DELIMITER '|')"
  fi
}

# Load all tables
import_table "region"
import_table "nation"
import_table "supplier"
import_table "part"
import_table "partsupp"
import_table "customer"
import_table "orders"
import_table "lineitem"

echo "      ✓ Data loading complete"

# Verify data
echo ""
echo "========================================="
echo "[3/3] Data Verification"
echo "========================================="

psql -v ON_ERROR_STOP=1 \
  --username "$PGUSER" \
  --dbname "$DBNAME" \
  -c "
SELECT 
  'nation' as table_name, count(*) as row_count FROM nation
UNION ALL
SELECT 'region', count(*) FROM region
UNION ALL
SELECT 'supplier', count(*) FROM supplier
UNION ALL
SELECT 'part', count(*) FROM part
UNION ALL
SELECT 'partsupp', count(*) FROM partsupp
UNION ALL
SELECT 'customer', count(*) FROM customer
UNION ALL
SELECT 'orders', count(*) FROM orders
UNION ALL
SELECT 'lineitem', count(*) FROM lineitem
ORDER BY table_name;
"

echo ""
echo "========================================="
echo "✓ TPC-H Database Ready!"
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
