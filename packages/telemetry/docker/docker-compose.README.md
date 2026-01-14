# Telemetry Server Docker Compose Setup

This Docker Compose setup replicates the exact infrastructure defined in the cloud-init configuration for local development.

**Location**: All files are in the `docker/` directory.

## Services

- **ClickHouse**: Columnar database for storing telemetry data
  - HTTP interface: `localhost:8123`
  - Native protocol: `localhost:9000`
  - User: `otel` / Password: `otel`

- **OpenTelemetry Collector**: Collects, processes, and exports telemetry data
  - gRPC OTLP: `localhost:4317`
  - HTTP OTLP: `localhost:4318`
  - Version: `0.102.0` (matching cloud-init)

- **Grafana**: Visualization and dashboards
  - Web UI: `http://localhost:3001` (mapped to container port 3000)
  - Admin user: `admin` / Password: `khalil1234`
  - Plugins: `vertamedia-clickhouse-datasource`, `grafana-clickhouse-datasource`

## Quick Start

```bash
# Navigate to the docker directory
cd docker

# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

## Configuration Files

- `docker-compose.yml`: Main compose file
- `otel-config.yaml`: OpenTelemetry Collector configuration
- `grafana/grafana.ini`: Grafana server configuration
- `grafana/provisioning/datasources/datasources.yaml`: Auto-provisioned ClickHouse datasources
- `grafana/provisioning/dashboards/dashboards.yaml`: Dashboard provisioning config
- `grafana/dashboards/telemetry-dashboard.json`: LLM Observability Dashboard
- `clickhouse/users.xml`: ClickHouse user configuration

## Accessing Services

- **Grafana**: http://localhost:3001 (admin/khalil1234)
- **ClickHouse HTTP**: http://localhost:8123
- **ClickHouse Native**: localhost:9000

## Sending Telemetry Data

Send OTLP traces to:
- gRPC: `localhost:4317`
- HTTP: `http://localhost:4318/v1/traces`

Example with curl:
```bash
curl -X POST http://localhost:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans": [...]}'
```

## Differences from Cloud-Init

1. **Service names**: In Docker Compose, services use service names (e.g., `clickhouse`) instead of `localhost` for inter-service communication
2. **Network**: All services are on a Docker bridge network (`telemetry-network`)
3. **Volumes**: Data persists in Docker volumes instead of host directories
4. **Health checks**: ClickHouse has a health check to ensure it's ready before other services start

## Troubleshooting

### Check service status
```bash
docker-compose ps
```

### View service logs
```bash
docker-compose logs clickhouse
docker-compose logs otel-collector
docker-compose logs grafana
```

### Restart a service
```bash
docker-compose restart grafana
```

### Access ClickHouse CLI
```bash
docker-compose exec clickhouse clickhouse-client --user otel --password otel
```

### Verify ClickHouse connection
```bash
curl http://localhost:8123/ping
```

