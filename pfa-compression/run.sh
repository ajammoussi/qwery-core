#!/bin/bash

# Multi-database setup script.
#
# Usage:
#   ./run.sh [target] [tpch_scale] [tpch_port] [saas_scale] [saas_port]
#
# Targets:
#   tpch  - run only the TPC-H database
#   saas  - run only the SaaS analytics database
#   both  - run both databases together
#
# Backward compatibility:
#   ./run.sh [tpch_scale] [tpch_port]

set -euo pipefail

usage() {
  echo "Usage: ./run.sh [tpch|saas|both] [tpch_scale] [tpch_port] [saas_scale] [saas_port]"
  echo "   or: ./run.sh [tpch_scale] [tpch_port]"
}

wait_for_health() {
  local container="$1"
  local max_checks="$2"
  local status=""

  for _ in $(seq 1 "$max_checks"); do
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then
      return 0
    fi

    if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
      echo ""
      echo "ERROR: Container $container failed to initialize. Showing logs:"
      docker logs "$container" || true
      return 1
    fi

    echo "   [$container] health status: ${status:-starting}"
    sleep 5
  done

  echo ""
  echo "ERROR: Timed out waiting for healthy container: $container"
  docker logs --tail 120 "$container" || true
  return 1
}

wait_for_ready_marker() {
  local container="$1"
  local marker="$2"
  local max_checks="$3"
  local dbcheck_type="$4"

  for _ in $(seq 1 "$max_checks"); do
    local container_state
    container_state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || true)

    if [ "$container_state" = "exited" ] || [ "$container_state" = "dead" ]; then
      echo ""
      echo "ERROR: Container $container exited before load finished. Recent logs:"
      docker logs --tail 200 "$container" || true
      return 1
    fi

    # If the loader prints the ready marker, we're done.
    if docker logs "$container" 2>&1 | grep -q "$marker"; then
      return 0
    fi

    # Table probing should only be used when init scripts were skipped due to an
    # existing PGDATA volume. During a fresh init, table creation happens before
    # bulk loading, and probing too early can produce a false "ready" state.
    if [ -n "${dbcheck_type:-}" ] && container_skipped_init "$container"; then
      if check_db_initialized "$container" "$dbcheck_type"; then
        echo "   [$container] detected initialized database via table check"
        return 0
      fi
    fi

    echo "   [$container] loading data..."
    sleep 5
  done

  echo ""
  echo "ERROR: Timed out waiting for load completion: $container"
  docker logs --tail 200 "$container" || true
  return 1
}

is_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}


# Check inside container whether expected TPC-H or SaaS tables exist.
# Usage: check_db_initialized <container> <type>
# types: tpch | saas
check_db_initialized() {
  local container="$1"
  local which="$2"
  local sql
  local dbname

  if [ "$which" = "tpch" ]; then
    sql="SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('nation','region','supplier','part','partsupp','customer','orders','lineitem') LIMIT 1;"
    dbname="tpch"
  elif [ "$which" = "saas" ]; then
    sql="SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('accounts','users','subscriptions','plans','events','feature_usage','invoices') LIMIT 1;"
    dbname="saas_analytics"
  else
    return 1
  fi
  if docker exec "$container" psql -U ${DB_USER:-postgres} -d "$dbname" -t -c "$sql" 2>/dev/null | grep -q '[a-z]'; then
    return 0
  fi
  return 1
}

# Detect the postgres entrypoint message emitted when PGDATA already exists.
container_skipped_init() {
  local container="$1"
  docker logs "$container" 2>&1 | grep -q "Database directory appears to contain a database; Skipping initialization"
}

TARGET="tpch"
TPCH_SCALE="1"
TPCH_PORT="55432"
SAAS_SCALE="1"
SAAS_PORT="55433"

if [ "$#" -ge 1 ] && is_number "$1"; then
  # Backward-compatible mode: first arg is TPCH scale.
  TARGET="tpch"
  TPCH_SCALE="$1"
  TPCH_PORT="${2:-55432}"
else
  TARGET="${1:-tpch}"
  TPCH_SCALE="${2:-1}"
  TPCH_PORT="${3:-55432}"
  SAAS_SCALE="${4:-1}"
  SAAS_PORT="${5:-55433}"
fi

case "$TARGET" in
  tpch|saas|both)
    ;;
  *)
    echo "ERROR: Unknown target '$TARGET'"
    usage
    exit 1
    ;;
esac

declare -a services=()
run_tpch="false"
run_saas="false"

if [ "$TARGET" = "tpch" ] || [ "$TARGET" = "both" ]; then
  services+=("tpch-postgres")
  run_tpch="true"
fi

if [ "$TARGET" = "saas" ] || [ "$TARGET" = "both" ]; then
  services+=("saas-postgres")
  run_saas="true"
fi

echo "Starting PostgreSQL container set"
echo "   Target: $TARGET"
echo "   TPC-H: scale=$TPCH_SCALE, port=$TPCH_PORT"
echo "   SaaS : scale=$SAAS_SCALE, port=$SAAS_PORT"
echo ""

SCALE_FACTOR="$TPCH_SCALE" \
DB_PORT="$TPCH_PORT" \
SAAS_SCALE_FACTOR="$SAAS_SCALE" \
SAAS_DB_PORT="$SAAS_PORT" \
docker-compose up -d --build "${services[@]}"

echo ""
echo "Waiting for selected databases to initialize..."
echo ""

if [ "$run_tpch" = "true" ]; then
  echo "Waiting for TPC-H healthcheck..."
  wait_for_health "tpch-postgres" 180
  echo "Waiting for TPC-H full load completion..."
  wait_for_ready_marker "tpch-postgres" "TPC-H Database Ready!" 360 tpch
fi

if [ "$run_saas" = "true" ]; then
  echo "Waiting for SaaS analytics healthcheck..."
  wait_for_health "saas-postgres" 180
  echo "Waiting for SaaS analytics full load completion..."
  wait_for_ready_marker "saas-postgres" "SaaS Analytics Database Ready!" 360 saas
fi

echo ""
echo "SUCCESS: Selected database services are ready."
echo ""

if [ "$run_tpch" = "true" ]; then
  echo "TPC-H connection:"
  echo "   psql -h 127.0.0.1 -U postgres -d tpch -p $TPCH_PORT"
  echo "   logs: docker logs -f tpch-postgres"
  echo ""
fi

if [ "$run_saas" = "true" ]; then
  echo "SaaS analytics connection:"
  echo "   psql -h 127.0.0.1 -U postgres -d saas_analytics -p $SAAS_PORT"
  echo "   logs: docker logs -f saas-postgres"
  echo ""
fi

echo "Stop all containers with:"
echo "   docker-compose down"
echo ""
