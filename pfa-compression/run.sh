#!/bin/bash

# Quick TPC-H Setup Script
# Usage: ./run.sh [SCALE_FACTOR] [DB_PORT]

set -euo pipefail

SCALE_FACTOR=${1:-1}
DB_PORT=${2:-55432}

echo "🚀 Starting TPC-H PostgreSQL Container"
echo "   Scale Factor: $SCALE_FACTOR GB"
echo "   Port: $DB_PORT"
echo ""

SCALE_FACTOR="$SCALE_FACTOR" DB_PORT="$DB_PORT" docker-compose up -d --build

echo ""
echo "⏳ Waiting for database initialization..."
echo "   (This may take a few minutes for large scale factors)"
echo ""

# Wait for health check to pass
echo "   Waiting for container healthcheck..."
for i in $(seq 1 180); do
  status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' tpch-postgres 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
    echo ""
    echo "❌ Container failed to initialize. Showing logs:"
    docker logs tpch-postgres || true
    exit 1
  fi
  echo "   Status: ${status:-starting}"
  sleep 5
done

if [ "${status:-}" != "healthy" ]; then
  echo ""
  echo "❌ Timed out waiting for healthy container. Showing recent logs:"
  docker logs --tail 120 tpch-postgres || true
  exit 1
fi

echo "   Healthcheck passed. Waiting for full TPC-H load completion..."
for i in $(seq 1 360); do
  container_state=$(docker inspect --format='{{.State.Status}}' tpch-postgres 2>/dev/null || true)
  if [ "$container_state" = "exited" ] || [ "$container_state" = "dead" ]; then
    echo ""
    echo "❌ Container exited before load finished. Recent logs:"
    docker logs --tail 200 tpch-postgres || true
    exit 1
  fi

  if docker logs tpch-postgres 2>&1 | grep -q "✓ TPC-H Database Ready!"; then
    break
  fi

  echo "   Loading data..."
  sleep 5
done

if ! docker logs tpch-postgres 2>&1 | grep -q "✓ TPC-H Database Ready!"; then
  echo ""
  echo "❌ Timed out waiting for full data load. Recent logs:"
  docker logs --tail 200 tpch-postgres || true
  exit 1
fi

echo "✅ TPC-H Database is Ready!"
echo ""
echo "📊 Connection Details:"
echo "   Host: localhost"
echo "   Port: $DB_PORT"
echo "   User: postgres"
echo "   Password: postgres"
echo "   Database: tpch"
echo ""
echo "🔗 Connect with:"
echo "   psql -h 127.0.0.1 -U postgres -d tpch -p $DB_PORT"
echo ""
echo "📝 View logs:"
echo "   docker logs -f tpch-postgres"
echo ""
echo "🛑 Stop with:"
echo "   docker-compose down"
echo ""
