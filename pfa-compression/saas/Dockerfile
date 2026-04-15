FROM postgres:16-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    postgresql-client

COPY saas/init-saas.sql /docker-entrypoint-initdb.d/10-init-saas.sql
COPY saas/post-load-indexes-saas.sql /usr/local/share/sql/post-load-indexes-saas.sql
COPY saas/generate-saas-data.py /usr/local/bin/generate-saas-data.py
COPY saas/generate-and-load-saas.sh /docker-entrypoint-initdb.d/20-generate-and-load-saas.sh

RUN chmod +x /docker-entrypoint-initdb.d/20-generate-and-load-saas.sh

WORKDIR /var/lib/postgresql
