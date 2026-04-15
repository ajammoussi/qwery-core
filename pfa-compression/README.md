# Multi-Database PostgreSQL Container Setup

Automated PostgreSQL setup with two analytical datasets:

- **Database 1: TPC-H** (official benchmark data via `dbgen`)
- **Database 2: SaaS/B2B Analytics** (fully synthetic Python-generated data)

Everything is designed to stay minimal and low-boilerplate while still being robust and production-like.

## Features

✨ **Fully Automated**
- One-command setup
- Official TPC-H data generation using `dbgen` toolchain
- Synthetic SaaS analytics data generation using Python
- Automatic schema creation and data loading
- No manual seed data

📊 **Scalable**
- Configurable scale factors (1GB to 100GB+)
- Official TPC-H benchmark compliance
- Realistic SaaS distributions (monthly churn, power-law feature usage)

🔀 **Flexible Execution**
- Run only TPC-H
- Run only SaaS analytics
- Run both databases together

🚀 **Production-Ready**
- Health checks included
- Data persistence with Docker volumes
- Network isolation

## Prerequisites

- Docker & Docker Compose installed
- At least 20GB free disk space (for SF=10)
- 8GB+ RAM recommended

## Quick Start

### 1. Basic Setup

```bash
cd pfa-compression
bash run.sh
```

This will:
- Build the custom PostgreSQL image with TPC-H tools
- Start PostgreSQL container
- Generate official TPC-H data (1GB)
- Create all 8 tables with proper schema
- Load the data automatically
- Show row counts for verification

### 2. Run SaaS Analytics Database Only

```bash
bash run.sh saas
```

### 3. Run Both Databases Together

```bash
bash run.sh both
```

### 4. Custom Scale Factors

Set TPC-H scale only (backward compatible):

```bash
bash run.sh 10
```

Set both scale factors with explicit target:

```bash
bash run.sh both 10 55432 2 55433
```

Arguments for explicit mode:

```text
bash run.sh [tpch|saas|both] [tpch_scale] [tpch_port] [saas_scale] [saas_port]
```

Scale factors:
- `1` = ~1GB of data
- `10` = ~10GB of data
- `100` = ~100GB of data (may take hours)
- SaaS `SAAS_SCALE_FACTOR=1` = baseline synthetic dataset

### 5. Custom Database Credentials

```bash
DB_USER=myuser DB_PASSWORD=mypass DB_PORT=5433 bash run.sh
```

Default credentials:
- User: `postgres`
- Password: `postgres`
- TPC-H Host Port: `55432` (container internal port remains `5432`)
- SaaS Host Port: `55433` (container internal port remains `5432`)
- Databases: `tpch`, `saas_analytics`

## Usage

### Connect to the Databases

```bash
# TPC-H (from host machine)
psql -h 127.0.0.1 -U postgres -d tpch -p 55432

# SaaS analytics (from host machine)
psql -h 127.0.0.1 -U postgres -d saas_analytics -p 55433

# Inside containers
docker exec -it tpch-postgres psql -U postgres -d tpch
docker exec -it saas-postgres psql -U postgres -d saas_analytics
```

### Run TPC-H Queries

Example: Find top 10 nations by revenue

```sql
-- TPC-H Query 5: Top 10 nations by aggregate volume
SELECT 
  n_name,
  SUM(l_extendedprice * (1 - l_discount)) as revenue
FROM customer
JOIN orders ON c_custkey = o_custkey
JOIN lineitem ON o_orderkey = l_orderkey
JOIN supplier ON l_suppkey = s_suppkey
JOIN nation ON s_nationkey = n_nationkey
WHERE o_orderdate >= '1994-01-01' AND o_orderdate < '1995-01-01'
GROUP BY n_name
ORDER BY revenue DESC
LIMIT 10;
```

### Check Database Status

```bash
# View container logs
docker logs tpch-postgres

# Check row counts
docker exec -it tpch-postgres psql -U postgres -d tpch -c \
  "SELECT tablename, 
    (SELECT count(*) FROM tablename) as rows 
   FROM pg_tables WHERE schemaname='public';"

# Check disk usage
docker exec -it tpch-postgres du -sh /var/lib/postgresql/data
```

## Files

- **docker-compose.yml** - Complete orchestration setup
- **run.sh** - Single entrypoint for `tpch`, `saas`, or `both`
- **tpch/Dockerfile** - Custom PostgreSQL 16 image with TPC-H dbgen
- **tpch/init-tpch.sql** - TPC-H schema definition (8 tables)
- **tpch/generate-and-load-tpch.sh** - TPC-H data generation and loading script
- **saas/Dockerfile** - Lightweight PostgreSQL 16 image for SaaS synthetic generation
- **saas/init-saas.sql** - SaaS analytics schema definition (7 tables)
- **saas/generate-saas-data.py** - Synthetic SaaS data generator with realistic distributions
- **saas/generate-and-load-saas.sh** - SaaS data loading script

## Folder Layout

```text
pfa-compression/
  docker-compose.yml
  run.sh
  .env
  .env.example
  tpch/
    Dockerfile
    init-tpch.sql
    generate-and-load-tpch.sh
  saas/
    Dockerfile
    init-saas.sql
    generate-saas-data.py
    generate-and-load-saas.sh
```

## SaaS Analytics Tables

The synthetic dataset creates 7 core SaaS/B2B analytics tables:

| Table | Purpose | Primary Use |
|-------|---------|------------|
| accounts | Customer organizations | Dimension table |
| users | End users per account | Dimension table |
| subscriptions | Plan assignments and lifecycle | Fact table |
| plans | Product and pricing catalog | Dimension table |
| events | Product event stream | Fact table |
| feature_usage | Daily feature aggregation | Fact table |
| invoices | Billing and payment outcomes | Fact table |

Synthetic behavior modeled in generation:
- Monthly churn hazard near 5%
- Feature activity with a power-law skew
- Mixed billing cycles (`monthly` and `annual`)
- Realistic event/session timestamps over time

## TPC-H Tables

The setup creates 8 standard TPC-H tables:

| Table | Purpose | Primary Use |
|-------|---------|------------|
| NATION | Countries/regions | Dimension table |
| REGION | Geographic regions | Dimension table |
| SUPPLIER | Suppliers catalog | Dimension table |
| PART | Parts catalog | Dimension table |
| PARTSUPP | Part-Supplier relationships | Dimension table |
| CUSTOMER | Customer directory | Dimension table |
| ORDERS | Sales orders | Fact table |
| LINEITEM | Order line items | Fact table |

**Total rows** (at SF=1):
- NATION: 25
- REGION: 5
- SUPPLIER: 10,000
- PART: 200,000
- PARTSUPP: 800,000
- CUSTOMER: 150,000
- ORDERS: 1,500,000
- LINEITEM: 6,000,000

## How It Works

### 1. Image Building
```bash
$ docker-compose up -d
→ Builds Dockerfile with PostgreSQL 16 Alpine base
→ Clones official TPC-H dbgen repository
→ Compiles dbgen executable
```

### 2. Container Start
```bash
→ PostgreSQL instance starts
→ Health check waits for readiness (max 30s)
```

### 3. Data Generation
```bash
→ Runs: dbgen -s {SCALE_FACTOR} -f
→ Generates pipe-delimited files for each table
→ Location: /tmp/tpch_data/*.tbl
```

### 4. Schema Creation
```bash
→ Executes init-tpch.sql
→ Creates all 8 tables with proper constraints
→ Creates performance indexes
```

### 5. Data Loading
```bash
→ Uses COPY command for fast bulk loading
→ Loads from pipe-delimited text files
→ Verifies row counts
```

## Troubleshooting

### Container fails to start
```bash
# Check logs
docker logs tpch-postgres

# Rebuild image
docker-compose build --no-cache
docker-compose up -d
```

### Insufficient disk space
```bash
# Check available space
df -h /var/lib/docker/volumes

# Try smaller scale factor
SCALE_FACTOR=5 docker-compose up -d
```

### Slow data loading
- This is normal. Large scale factors take time:
  - SF=1: ~5-10 minutes
  - SF=10: ~30-60 minutes
  - SF=100: several hours

### Connection refused
```bash
# Verify container is running
docker ps | grep tpch-postgres
docker ps | grep saas-postgres

# Wait longer for startup (health check may take 30-40s)
docker logs -f tpch-postgres

# Verify host port mapping (left side should be 55432 by default)
docker port tpch-postgres
docker port saas-postgres
```

### Password authentication failed for user "postgres"
This usually means your client reached a different PostgreSQL instance.

```bash
# Confirm which host port is mapped to this container
docker port tpch-postgres

# Verify from inside the container (should succeed)
docker exec -it tpch-postgres psql -U postgres -h 127.0.0.1 -d tpch -c '\conninfo'

# Verify from the host using the mapped port
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d tpch -p 55432 -c '\conninfo'
```

If host ports are already used on your machine, run with other ports:

```bash
DB_PORT=55440 SAAS_DB_PORT=55441 bash run.sh both
```

## Cleanup

```bash
# Stop and remove containers
docker-compose down

# Remove volumes (keep data)
docker-compose down -v

# Full cleanup (remove everything)
docker-compose down -v
docker system prune -a
```

## Performance Notes

- Write speed depends on disk I/O
- SSD recommended for scale factors > 10
- Use `SCALE_FACTOR=1` for quick testing
- Once loaded, queries run very fast

## Integration with Qwery

To use these databases with Qwery:

1. Start the container (see Quick Start)
2. In Qwery, add a PostgreSQL datasource for TPC-H:
   - Host: `localhost`
  - Port: `55432`
   - Database: `tpch`
   - User: `postgres`
   - Password: `postgres`
3. Add a second PostgreSQL datasource for SaaS analytics:
  - Host: `localhost`
  - Port: `55433`
  - Database: `saas_analytics`
  - User: `postgres`
  - Password: `postgres`
4. Query using natural language!

```
Example: "Show me the top 10 suppliers by revenue"
Example: "Show monthly churn rate by segment over the last 12 months"
```

## References

- [TPC-H Benchmark Specification](http://www.tpc.org/tpch/)
- [Official dbgen Repository](https://github.com/electrum/tpch-dbgen)
- [PostgreSQL COPY Command](https://www.postgresql.org/docs/current/sql-copy.html)

## License

TPC-H is a registered trademark of Transaction Processing Performance Council.
This automation script is provided for benchmarking and testing purposes.
