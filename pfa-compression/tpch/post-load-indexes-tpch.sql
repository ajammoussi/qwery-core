-- TPC-H post-load indexes
-- Run after bulk COPY to avoid index maintenance overhead during large imports.

CREATE INDEX IF NOT EXISTS idx_orders_custkey ON ORDERS(O_CUSTKEY);
CREATE INDEX IF NOT EXISTS idx_lineitem_orderkey ON LINEITEM(L_ORDERKEY);
CREATE INDEX IF NOT EXISTS idx_lineitem_partsupp ON LINEITEM(L_PARTKEY, L_SUPPKEY);
CREATE INDEX IF NOT EXISTS idx_partsupp_partkey ON PARTSUPP(PS_PARTKEY);
CREATE INDEX IF NOT EXISTS idx_partsupp_suppkey ON PARTSUPP(PS_SUPPKEY);
CREATE INDEX IF NOT EXISTS idx_customer_nationkey ON CUSTOMER(C_NATIONKEY);
CREATE INDEX IF NOT EXISTS idx_supplier_nationkey ON SUPPLIER(S_NATIONKEY);
