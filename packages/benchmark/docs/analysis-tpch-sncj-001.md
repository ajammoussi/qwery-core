# Preliminary Analysis — tpch-sncj-001 (SNCJ: Schema Navigation and Complex Joins)

> Status: **COMPLETE** — all 8 strategy/mode combinations run and verified (peer contribution)

## 1. What We're Comparing

**Session**: `tpch-sncj-001`
**Type**: SNCJ — Schema Navigation and Complex Joins (multi-table join construction, schema recall across compression boundary)
**Database**: TPC-H
**Turns**: 30 | **Compression boundary**: ~12 (plain) / token-overflow from turn 2 (4zone)
**persistedCorrections**: 2

| Turn | Correction | Type |
|---|---|---|
| 10 | Always use `C_NATIONKEY = N_NATIONKEY` for Customer-Nation joins | join_key |
| 16 | Filter to only open orders with status `'O'` | filter_rule |

> Turn 10 correction is **pre-boundary** for plain (must survive compaction). Turn 16 is **post-boundary** for plain (in Zone C active window). Both are post-boundary for 4zone (token-overflow fires at turn 2).

**Anaphoric references** (all cross compression boundary): 5 — including "What columns does the REGION table have again?" (turn 12→6), "What were the possible values for O_ORDERSTATUS?" (turn 15→2), "Earlier you mentioned ORDERS has a column for order priority" (turn 22→2), "the same query" (turn 24→20), "the same four-table join" (turn 29→26).

**Key failure mode**: `schemaGrounding` failure — the agent is asked to recall schema structure (column names, join keys, status enum values) that it saw before compaction. Unlike corrections, these are not rules but factual schema properties. Zone A directly addresses this.

---

## 2. What Compaction Produces

### qwery-default / plain — Zone D summary (LLM narrative)

```
From data/results/qwery-default/plain/tpch/sncj/tpch-sncj-001.json
→ turns[11].compactionEvent.summaryText

## Internal Summary

### What Was Done
- Explored the TPC-H benchmark schema and examined the structure of ORDERS,
  CUSTOMER, NATION, and REGION tables
- Ran queries to analyze orders for January 1995, including customer names,
  nations, and regions
```

Observation: qwery-default encodes the schema exploration narrative — it describes what tables were examined. When the agent is later asked "what columns does REGION have again?" it can reconstruct from this narrative context. The join key correction (turn 10: `C_NATIONKEY`) is embedded in the summary as a usage pattern.

### headroom / plain — proxy-compressed summary

```
From data/results/headroom/plain/tpch/sncj/tpch-sncj-001.json
→ turns[11].compactionEvent.summaryText

[assistant]
## TPC-H Schema Overview

This is a standard **TPC-H benchmark** database with 8 tables. Here's how they relate:

### Entity Relationship Diagram

| Table | Description | Key Columns | Relationship |
|-------|-------------|-------------|--------------|
| **customer** | Customer information | C_CUSTKEY, C_NAME, C_NATIONKEY | ...
```

Observation: headroom captures the schema overview table produced by the agent in an early turn. This is the raw ERD text — not compressed from the agent's queries, but literally the assistant's earlier schema description. Post-compaction, the agent re-reads this, giving it structural schema recall. However, the join key correction (`C_NATIONKEY = N_NATIONKEY`) and the `O_ORDERSTATUS = 'O'` filter are buried or absent from this table view.

### recomp-extractive / plain — extractive snippet

```
From data/results/recomp-extractive/plain/tpch/sncj/tpch-sncj-001.json
→ turns[11].compactionEvent.summaryText

- **nation** → **region** via `n_regionkey = r_regionkey` (one region → many nations)
| `c_comment` | varchar | Notes | The key joins are: The **REGION** table has these
columns: | r_regionkey | integer | The query now includes region names by adding...
```

Observation: recomp extracts join-relationship snippets verbatim — schema facts survive extraction because they appear repeatedly in the agent's responses. `n_regionkey = r_regionkey` is preserved. Join patterns are structurally reproducible, explaining recomp/plain's **80% queryConsistencyRate** — the highest single-session rate after qwery-default/DCS.

### Zone B entity state (4zone mode)

For SNCJ, Zone B's `activeFilters` captures date and status filters but is dominated by noise in `activeTables` and `activeColumns`:

```
From data/results/headroom/4zone/tpch/sncj/tpch-sncj-001.json
→ turns[29].zonesSnapshot.entityState.segments[0].content (final turn)

{
  "activeTables": [
    "ORDERS", "orders", "customer", "nation", "region",
    "in", "this", "the", "January", "was", "and",   ← noise tokens
    "keys", "Table", "Key", "but"                    ← noise tokens
  ],
  "activeColumns": [
    "reminder", "o_custkey", "join", "bring",        ← noise
    "c_nationkey", "C_NATIONKEY",                    ← signal: join key captured
    "status", "orders", "count", "customers"
  ],
  "activeFilters": [
    { "column": "o_orderdate", "op": ">=", "value": "1995-01-01" },
    { "column": "o_orderstatus", "op": "=", "value": "O" }   ← turn 16 correction captured
  ]
}
```

**Key observation**: Zone B correctly captures `o_orderstatus = 'O'` (turn 16 correction) and `C_NATIONKEY` in `activeColumns`. The `activeTables` array is extremely noisy for SNCJ because the agent writes schema descriptions in prose — words like "the", "in", "keys" are extracted as table names. Despite this noise, Zone B provides enough signal that schemaGrounding reaches 5.0/5 in 4zone mode.

---

## 3. Inline Metrics (live session)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| compressionRatio | 0.099 | 0.071 | 0.234 | 1.911* | 0.020 | 0.023 | 0 | 0.009 |
| filterPersistenceRate | 83.3% | **88.9%** | **88.9%** | 86.1% | **88.9%** | **88.9%** | **88.9%** | 86.1% |
| compactionOverheadPct | 4.63% | 29.24% | **184.79%** | 1.26% | 2.51% | 35.88% | 21.19% | 0.45% |
| compactionEvents | 1 | 11 | 1 | **15** | 1 | 5 | 1 | 5 |

> *headroom/4zone compressionRatio=1.911 is a metric artifact (15 events averaging varying pre-compaction sizes).
> headroom/plain overhead=184.79% means the proxy compression call took ~1.85× more time than the entire agent LLM session — the costliest single combination in this benchmark series.

---

## 4. Post-Processing Metrics (Gemini judge + row-count consistency)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| Gemini score (0–10) | 8.49 | 8.39 | 6.29 | **8.83** | 7.29 | 7.88 | 5.54 | 6.29 |
| filterPersistence (avg/5) | 2.80 | 3.00 | 1.00 | 2.60 | 2.20 | 2.80 | 2.00 | 3.00 |
| entityContinuity (avg/5) | 4.20 | 4.00 | 2.00 | **4.80** | 3.20 | **4.60** | 3.00 | 3.50 |
| correctionPersistence (avg/5) | 4.20 | 3.75 | 3.40 | 3.60 | 3.20 | 3.20 | 2.40 | 3.00 |
| analyticalThread (avg/5) | 3.60 | 4.25 | 2.40 | **4.60** | 3.20 | 4.20 | 2.80 | 3.00 |
| schemaGrounding (avg/5) | **5.00** | **5.00** | **5.00** | **5.00** | **5.00** | 4.00 | 3.00 | 3.00 |
| queryConsistencyRate | 40.0% | 28.6% | 40.0% | 40.0% | **80.0%** | 60.0% | 60.0% | 50.0% |
| Dominant failures | none(2), filter_drift(3), baseline_loss(1) | none(2), filter_drift(1), correction_ignored(2) | filter_drift(4), entity_confusion(3), baseline_loss(3) | filter_drift(3), correction_ignored(3) | filter_drift(3), correction_ignored(3) | filter_drift(2), correction_ignored(3) | filter_drift(2), correction_ignored(2), baseline_loss(2) | filter_drift(1), correction_ignored(1) |

---

## 5. Findings

1. **SNCJ Gemini scores are the highest of any session type (5.54–8.83).** The anaphoric references in SNCJ ask about schema structure — column names, join keys, status enum values — which are deterministic facts about the database, not analytical judgments. Every strategy that preserves any schema context scores well. This contrasts with IRC (2.00–5.50) where the legacy cohort proxy requires multi-step semantic reasoning, or PTA (1.27–9.63) where thread separation requires narrative structure.

2. **Zone A eliminates the schemaGrounding failure mode for 4zone strategies.** All 4zone strategies achieve schemaGrounding = 5.0/5 (llmlingua-2/4zone achieves 3.0, qd and hr reach 5.0). In plain mode, llmlingua-2 drops to 3.0 — it compresses away schema content at 21% overhead and the cold-start agent can't reconstruct which columns belong to which table. Zone A holds the raw `getSchema` output verbatim regardless of Zone D compression.

3. **headroom/4zone is the best-performing combination overall (8.83/10) — a complete reversal of PTA.** The mechanism is different from the PTA catastrophe and recovery:
   - On PTA: headroom/4zone failed because 20 compaction events ground Zone D to dust without thread labels to compensate.
   - On SNCJ: 15 compaction events occur but Zone A holds the schema, Zone B captures the join key and status filter, and Zone D's loss of narrative is offset. The agent navigates joins using Zone A rather than recalling them from Zone D.
   - entityContinuity: 2.0 (plain) → **4.8 (4zone)** — the largest single-dimension improvement in this benchmark series. Plain headroom's hash-chunks lose entity context; Zone A restores it directly.

4. **headroom/plain has 184.79% compaction overhead — the worst of any combination.** The headroom proxy is spending more wall-clock time compressing the SNCJ session than the actual LLM calls take. The result (6.29 Gemini) is also the worst for the session. The combination of maximum cost and minimum quality makes headroom/plain the only result in this series where the compression is unambiguously counterproductive vs baseline.

5. **recomp/plain achieves 80% queryConsistencyRate — highest in this series after qwery-default/DCS (100%).** SNCJ queries use stable, repeatable join patterns: `ORDERS JOIN CUSTOMER ON o_custkey = c_custkey JOIN NATION ON c_nationkey = n_nationkey JOIN REGION ON n_regionkey = r_regionkey`. The extractive format preserves these join chains verbatim. A cold-start agent reconstructing from this extractive context writes identical SQL. SNCJ's schema structure is the reason — not compression quality.

6. **qwery-default plain ≈ 4zone (8.49 vs 8.39, Δ=0.10).** This is the smallest plain/4zone gap in the series. qwery-default's LLM narrative already encodes schema exploration context well ("examined ORDERS, CUSTOMER, NATION, REGION tables"), so Zone A adds only marginal benefit. On sessions where plain summaries are weak (IRC), 4zone helps more. On sessions where plain summaries are strong (SNCJ, DCS), the gap narrows or reverses.

7. **filter_drift and correction_ignored persist even in the session type with highest overall scores.** The `C_NATIONKEY` join correction (turn 10) and `O_ORDERSTATUS = 'O'` filter (turn 16) both appear in failure categories across all strategies. High Gemini scores on SNCJ reflect that schemaGrounding and entityContinuity are strong, compensating for persistent filter/correction weaknesses. The correction problem is orthogonal to the schema navigation problem.
