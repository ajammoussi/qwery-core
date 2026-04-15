FROM postgres:16-alpine

RUN apk add --no-cache \
    build-base \
    gcc \
    make \
    wget \
    git \
    bash \
    perl

WORKDIR /tmp

# Download and build TPC-H dbgen tool.
# Force legacy C standard for the original dbgen sources to compile reliably on modern GCC.
RUN set -eux; \
        for i in 1 2 3; do \
            git clone --depth 1 https://github.com/electrum/tpch-dbgen.git && break || \
            (echo "git clone failed, retry ${i}" && rm -rf tpch-dbgen && sleep 2); \
        done; \
        cd tpch-dbgen; \
        cp makefile.suite Makefile; \
        sed -i 's/^CC\s*=.*/CC      = gcc/' Makefile; \
        sed -i 's/^DATABASE=.*/DATABASE=POSTGRESQL/' Makefile; \
        sed -i 's/^MACHINE =.*/MACHINE = LINUX/' Makefile; \
        sed -i 's/^WORKLOAD =.*/WORKLOAD = TPCH/' Makefile; \
        sed -i 's/^CFLAGS\s*=.*/CFLAGS  = -O2 -std=gnu89 -fcommon -w -DDBNAME=\\"dss\\" -D$(MACHINE) -D$(DATABASE) -D$(WORKLOAD) -DRNG_TEST -D_FILE_OFFSET_BITS=64/' Makefile; \
        make -f Makefile dbgen

# Copy TPC-H schema and query generation scripts
RUN cp /tmp/tpch-dbgen/dists.dss /tmp/ && \
    cp /tmp/tpch-dbgen/dbgen /usr/local/bin/ && \
    chmod +x /usr/local/bin/dbgen

# Install psql client and preparation script
RUN apk add --no-cache postgresql-client

# Copy initialization scripts (run once on first DB init)
COPY tpch/init-tpch.sql /docker-entrypoint-initdb.d/10-init-tpch.sql
COPY tpch/post-load-indexes-tpch.sql /usr/local/share/sql/post-load-indexes-tpch.sql
COPY tpch/generate-and-load-tpch.sh /docker-entrypoint-initdb.d/20-generate-and-load-tpch.sh
RUN chmod +x /docker-entrypoint-initdb.d/20-generate-and-load-tpch.sh

WORKDIR /var/lib/postgresql
