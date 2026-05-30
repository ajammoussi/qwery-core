# Consolidated Analysis: Context Compression Strategies across Session Types

**Sessions covered**: `tpch-dcs-001`, `tpch-pta-001`, `tpch-irc-001`, `tpch-sncj-001`, `tpch-rci-001`, `saas-pta-001`
**Strategies**: baseline-no-compression, qwery-default, headroom, recomp-extractive, llmlingua-2
**Modes**: plain, 4zone
**Databases**: TPC-H SF=1, SaaS analytics
**Last updated**: 2026-05-30 (updated with RCI, llmlingua-2 batch, DCS re-evaluation)

For per-session deep dives see:
- [analysis-tpch-dcs-001.md](./analysis-tpch-dcs-001.md)
- [analysis-tpch-pta-001.md](./analysis-tpch-pta-001.md)
- [analysis-tpch-irc-001.md](./analysis-tpch-irc-001.md)
- [analysis-tpch-sncj-001.md](./analysis-tpch-sncj-001.md)
- [analysis-tpch-rci-001.md](./analysis-tpch-rci-001.md)
- [analysis-saas-pta-001.md](./analysis-saas-pta-001.md)

---

## 1. Session Type Reference

| Type | Description | Turns | Boundary | Corrections | Key failure mode |
|---|---|---|---|---|---|---|
| **DCS** | Deep Callback Session — 2 pre-boundary rules, tested via deep callbacks | 32 | 15 | 2 | filter_drift |
| **PTA** | Parallel Thread Analysis — 2 interleaved analytical threads, 3 corrections | 35 | 15 | 3 | thread_bleed, filter_drift |
| **IRC** | Iterative Refinement with Corrections — 4 pre-boundary corrections including a semantic proxy | 32 | 12 | 4 | correction_ignored, filter_drift |
| **SNCJ** | Schema Navigation and Complex Joins — 2 corrections, 5 cross-boundary schema recall anaphors | 30 | ~12 | 2 | schemaGrounding, filter_drift |
| **RCI** | Reference Chain with Indirect Corrections — 3 filter/column-precision rules, callback references to prior results across the boundary | 42 | 14 | 3 | callback_miss, correction_ignored |
| **saas-PTA** | PTA on SaaS analytics DB — churn + feature adoption threads, domain-specific corrections | 36 | ~12 | 4 | filter_drift, correction_ignored |

**Correction complexity increases from DCS → PTA → IRC**: DCS has the fewest constraints (2), PTA adds thread isolation, IRC has the most pre-boundary corrections (4) with the hardest one requiring a semantic SQL proxy. **SNCJ is orthogonal** — its challenge is schema recall across the boundary, not correction density. **RCI adds the callback dimension** — the agent must not only remember corrections but re-construct analytical context from user references like "the same filters we've established."

---

## 2. Full Coverage Matrix

| Session | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone | baseline |
|---|---|---|---|---|---|---|---|---|---|---|
| tpch-dcs-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| tpch-pta-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| tpch-irc-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| tpch-sncj-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| tpch-rci-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| saas-pta-001  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |

---

## 3. Cross-Session Metrics Summary

### 3a. Inline Metrics (live session)

| Session | Strategy | Mode | compressionRatio | filterPersistenceRate | compactionOverheadPct | compactionEvents |
|---|---|---|---|---|---|---|
| DCS-001 | baseline | plain | — | 32.4% | — | 0 |
| DCS-001 | qwery-default | plain | 0.109 | 29.4% | 0.62% | 1 |
| DCS-001 | qwery-default | 4zone | 0.017 | **44.1%** | ~0% | 1 |
| DCS-001 | headroom | plain | 0.269 | 32.4% | 0.62% | 1 |
| DCS-001 | headroom | 4zone | 0.390 | 41.2% | 0.83% | 1 |
| DCS-001 | recomp-extractive | plain | 0.022 | 38.2% | 1.52% | 1 |
| DCS-001 | recomp-extractive | 4zone | 0.031 | 35.3% | 0.82% | 1 |
| DCS-001 | llmlingua-2 | plain | 0 | 26.5% | 34.96% | 1 |
| DCS-001 | llmlingua-2 | 4zone | 0.010 | 35.3% | 0.55% | 4 |
| PTA-001 | qwery-default | plain | 0.112 | 93.3% | 1.91% | 1 |
| PTA-001 | qwery-default | 4zone | 0.026 | 78.3% | ~0% | 1 |
| PTA-001 | headroom | plain | 0.182 | 78.3% | 0.62% | 1 |
| PTA-001 | headroom | 4zone | 4.499* | 88.3% | 0.45% | **20** |
| PTA-001 | recomp-extractive | plain | 0.029 | 68.3% | 0.93% | 1 |
| PTA-001 | recomp-extractive | 4zone | 0.025 | 83.3% | 9.77% | 2 |
| PTA-001 | llmlingua-2 | plain | 0 | 86.7% | 10.72% | 1 |
| PTA-001 | llmlingua-2 | 4zone | 0.024 | 83.3% | 0.33% | 1 |
| IRC-001 | qwery-default | plain | 0.099 | 70.0% | 1.14% | 1 |
| IRC-001 | qwery-default | 4zone | 0.097 | 81.3% | 1.10% | 1 |
| IRC-001 | headroom | plain | 0.292 | 71.3% | 0.52% | 1 |
| IRC-001 | headroom | 4zone | 0.374 | 81.3% | 0.50% | 6 |
| IRC-001 | recomp-extractive | plain | 0.033 | 73.8% | 3.58% | 1 |
| IRC-001 | recomp-extractive | 4zone | 0.019 | 80.0% | 1.12% | 1 |
| IRC-001 | llmlingua-2 | plain | 0 | 80.0% | 8.21% | 1 |
| IRC-001 | llmlingua-2 | 4zone | 0.022 | **83.8%** | 0.22% | 1 |
| SNCJ-001 | qwery-default | plain | 0.099 | 83.3% | 4.63% | 1 |
| SNCJ-001 | qwery-default | 4zone | 0.071 | 88.9% | 29.24% | 11 |
| SNCJ-001 | headroom | plain | 0.234 | 88.9% | **184.79%** | 1 |
| SNCJ-001 | headroom | 4zone | 1.911* | 86.1% | 1.26% | 15 |
| SNCJ-001 | recomp-extractive | plain | 0.020 | 88.9% | 2.51% | 1 |
| SNCJ-001 | recomp-extractive | 4zone | 0.023 | 88.9% | 35.88% | 5 |
| SNCJ-001 | llmlingua-2 | plain | 0 | 88.9% | 21.19% | 1 |
| SNCJ-001 | llmlingua-2 | 4zone | 0.009 | 86.1% | 0.45% | 5 |
| RCI-001 | qwery-default | plain | 0.103 | 95.2% | 1.87% | 1 |
| RCI-001 | qwery-default | 4zone | 0.076 | **98.8%** | 4.35% | 1 |
| RCI-001 | headroom | plain | 0.125 | 96.4% | 31.91% | 1 |
| RCI-001 | headroom | 4zone | 0.336* | 95.2% | 0.53% | 1 |
| RCI-001 | recomp-extractive | plain | 0.003 | 95.2% | 0.40% | 1 |
| RCI-001 | recomp-extractive | 4zone | 0.020 | 95.2% | 15.13% | **8** |
| RCI-001 | llmlingua-2 | plain | 0.233 | 97.6% | 19.00% | 1 |
| RCI-001 | llmlingua-2 | 4zone | 0.020 | 95.2% | 0.29% | 1 |
| saas-PTA | qwery-default | plain | 0.079 | 78.1% | 2.34% | 1 |
| saas-PTA | qwery-default | 4zone | 0.062 | 72.9% | 16.41% | 2 |
| saas-PTA | headroom | plain | 0.089 | **84.4%** | 1.02% | 1 |
| saas-PTA | headroom | 4zone | 0.419* | 77.1% | 0.38% | 2 |
| saas-PTA | recomp-extractive | plain | 0.255 | 71.9% | 0.03% | 1 |
| saas-PTA | recomp-extractive | 4zone | 0.022 | 67.7% | 2.19% | 1 |

> *headroom/4zone compressionRatio > 1 is a metric artifact from averaging multiple per-event ratios with varying pre-compaction token counts.

### 3b. Post-Processing Metrics (Gemini judge)

| Session | Strategy | Mode | Gemini (0–10) | queryConsistencyRate | Dominant failures |
|---|---|---|---|---|---|
| DCS-001 | qwery-default | plain | 7.87 | **100%** | filter_drift, correction_ignored |
| DCS-001 | qwery-default | 4zone | 6.00 | 80% | filter_drift, correction_ignored |
| DCS-001 | headroom | plain | **10.00** | 60% | none |
| DCS-001 | headroom | 4zone | 6.33 | 50% | filter_drift, correction_ignored, entity_confusion, baseline_loss |
| DCS-001 | recomp-extractive | plain | 6.00 | 80% | filter_drift, correction_ignored |
| DCS-001 | recomp-extractive | 4zone | 7.56 | 60% | filter_drift, correction_ignored, entity_confusion |
| DCS-001 | llmlingua-2 | plain | 6.60 | 100%† | filter_drift, correction_ignored |
| DCS-001 | llmlingua-2 | 4zone | 6.40 | 66.7% | filter_drift, correction_ignored, entity_confusion |
| PTA-001 | qwery-default | plain | 8.46 | 12.5% | filter_drift, correction_ignored |
| PTA-001 | qwery-default | 4zone | **9.63** | 20.0% | entity_confusion, baseline_loss |
| PTA-001 | headroom | plain | 7.39 | 28.6% | entity_confusion, filter_drift, correction_ignored |
| PTA-001 | headroom | 4zone | 🔴 1.27 | 12.5% | filter_drift, entity_confusion, correction_ignored, baseline_loss |
| PTA-001 | recomp-extractive | plain | 4.31 | 0% | entity_confusion, thread_bleed, baseline_loss |
| PTA-001 | recomp-extractive | 4zone | 4.62 | **57.1%** | filter_drift, entity_confusion, baseline_loss |
| PTA-001 | llmlingua-2 | plain | 5.75 | 0%† | filter_drift, entity_confusion, correction_ignored, baseline_loss |
| PTA-001 | llmlingua-2 | 4zone | 4.74 | 37.5% | filter_drift, entity_confusion, correction_ignored, baseline_loss, thread_bleed |
| IRC-001 | qwery-default | plain | 3.75 | 28.6% | filter_drift, correction_ignored |
| IRC-001 | qwery-default | 4zone | 4.45 | 18.2% | filter_drift, correction_ignored, entity_confusion |
| IRC-001 | headroom | plain | 3.45 | 33.3% | filter_drift, correction_ignored |
| IRC-001 | headroom | 4zone | 5.50‡ | 0% | filter_drift, correction_ignored |
| IRC-001 | recomp-extractive | plain | 2.00 | 16.7% | filter_drift, correction_ignored, entity_confusion |
| IRC-001 | recomp-extractive | 4zone | 4.45 | **28.6%** | filter_drift, correction_ignored, entity_confusion |
| IRC-001 | llmlingua-2 | plain | 4.10 | 57.1%† | filter_drift, correction_ignored, entity_confusion, baseline_loss |
| IRC-001 | llmlingua-2 | 4zone | 4.85 | 66.7%† | filter_drift, correction_ignored, entity_confusion |
| SNCJ-001 | qwery-default | plain | 8.49 | 40.0% | none(2), filter_drift(3), baseline_loss(1) |
| SNCJ-001 | qwery-default | 4zone | 8.39 | 28.6% | none(2), filter_drift(1), correction_ignored(2) |
| SNCJ-001 | headroom | plain | 6.29 | 40.0% | filter_drift(4), entity_confusion(3), baseline_loss(3) |
| SNCJ-001 | headroom | 4zone | **8.83** | 40.0% | filter_drift(3), correction_ignored(3) |
| SNCJ-001 | recomp-extractive | plain | 7.29 | **80.0%** | filter_drift(3), correction_ignored(3) |
| SNCJ-001 | recomp-extractive | 4zone | 7.88 | 60.0% | filter_drift(2), correction_ignored(3) |
| SNCJ-001 | llmlingua-2 | plain | 5.54 | 60.0% | filter_drift(2), correction_ignored(2), baseline_loss(2) |
| SNCJ-001 | llmlingua-2 | 4zone | 6.29 | 50.0% | filter_drift(1), correction_ignored(1) |
| RCI-001 | qwery-default | plain | 5.26 | — | filter_drift, correction_ignored, entity_confusion, callback_miss |
| RCI-001 | qwery-default | 4zone | 5.48 | — | filter_drift, entity_confusion, correction_ignored |
| RCI-001 | headroom | plain | 3.79 | — | filter_drift, entity_confusion, correction_ignored, callback_miss |
| RCI-001 | headroom | 4zone | **8.40** | — | filter_drift, entity_confusion, correction_ignored |
| RCI-001 | recomp-extractive | plain | 4.24 | — | filter_drift, entity_confusion, correction_ignored, callback_miss |
| RCI-001 | recomp-extractive | 4zone | 5.75 | — | filter_drift, entity_confusion, correction_ignored, baseline_loss, callback_miss |
| RCI-001 | llmlingua-2 | plain | 2.00 | —† | filter_drift, entity_confusion, correction_ignored, callback_miss |
| RCI-001 | llmlingua-2 | 4zone | 6.46 | — | filter_drift, entity_confusion, correction_ignored |
| saas-PTA | qwery-default | plain | 6.98 | 15.4% | filter_drift(5), correction_ignored(5) |
| saas-PTA | qwery-default | 4zone | 7.14 | 28.6% | filter_drift(5), correction_ignored(5) |
| saas-PTA | headroom | plain | 7.60 | 7.1% | filter_drift(4), correction_ignored(4) |
| saas-PTA | headroom | 4zone | **8.71** | 7.7% | filter_drift(3), correction_ignored(3) |
| saas-PTA | recomp-extractive | plain | 7.91 | 5.9% | filter_drift(4), correction_ignored(4) |
| saas-PTA | recomp-extractive | 4zone | 7.85 | **21.4%** | filter_drift(1), correction_ignored(1) |

> †llmlingua-2 queryConsistencyRate values are evaluation artefacts — the "summary" is a log header with no analytical context. See Finding 9.
> ‡headroom/4zone IRC sampled only 1 Gemini turn (quota exhausted mid-verify); score not statistically representative.
> RCI queryConsistencyRate was not computed (the dimension was added after these verifies ran).

---

## 4. What Each Strategy Produces at Compaction

The format of the compressed summary is the primary determinant of post-compaction quality. Each strategy produces structurally different output.

### qwery-default / plain — LLM narrative (DCS-001)

```
From data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json
→ turns[14].compactionEvent.summaryText

## Conversation Summary

**What was done:**
- Analyzed TPC-H benchmark dataset across multiple dimensions
- Queried total revenue by region for 1995 (America led with ~$6.8B)
- Queried Europe-specific revenue for 1995: $6,605,155,201.17
- Identified top 10 suppliers by volume (Supplier#2298 leads with 14,744 units)
...
```

**Format signature**: Structured prose with explicit section headers, result numbers, and analytical context. Corrections appear embedded in result descriptions ("Europe revenue excluding 5-LOW orders: $6.6B") which the agent re-reads as a baseline to replicate. The narrative frame is the key mechanism — the agent treats described results as constraints to reproduce.

### qwery-default / 4zone — Zone D archive + Zone B entity state (DCS-001)

```
From data/results/qwery-default/4zone/tpch/dcs/tpch-dcs-001.json
→ turns[19].zonesSnapshot.entityState.segments[0].content.raw

{
  "activeFilters": [
    { "column": "l_shipdate",      "op": ">=",  "value": "1995-01-01" },
    { "column": "l_shipdate",      "op": "<",   "value": "1996-01-01" },
    { "column": "o_orderpriority", "op": "!=",  "value": "5-LOW" },     ← exclusion captured
    { "column": "r_name",          "op": "=",   "value": "EUROPE" },
    { "column": "n_name",          "op": "=",   "value": "GERMANY" }
  ]
}
```

Zone B is populated from actual SQL `WHERE` clauses in `runQuery` tool calls — not from prose extraction. This gives correct operator semantics (`!=` for exclusion, `>=`/`<` for date ranges). Zone B is read alongside Zone D (the LLM archive) and Zone C (last N turns verbatim).

### headroom / plain — hash-chunked proxy compression (IRC-001)

```
From data/results/headroom/plain/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

revenue breakdown by region for last 6 months of 1995 (July–December): | Region | Revenue
EUROPE | 3,395,479,995 | AFRICA | 3,357,243,344 | ASIA | 3,352,221,569 | AMERICA |
3,344,238,642 | MIDDLE EAST | 3,296,456,813 | Europe leads with highest revenue at ~$3.4B...
[200 items compressed to 1. Retrieve more: hash=146e404992c3f34e79d1fa7c]
```

**Format signature**: Result tables with hash-addressed retrieval pointers. The actual filter rules ("exclude AMERICA", "legacy cohort") are absent from the visible summary — they survive only if the agent retrieves the relevant hash chunks. AMERICA appears in the result table as a data point, not flagged as excluded, actively misleading the agent.

### recomp-extractive / plain — extractive snippet (IRC-001)

```
From data/results/recomp-extractive/plain/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

| EUROPE | 3,381,816,658 | Revenue is fairly evenly distributed across regions, with Europe
slightly leading at ~3.38 billion, and America trailing just behind at ~3.31 billion.
{{suggestion: Show monthly revenue trend by region}} {{suggestion: Chart legacy customers
by region}}
```

**Format signature**: Extractive slices of result tables with auto-generated suggestion tags. Corrections appear as future suggestions ("Chart legacy customers by region"), not as established rules. The agent reads these as unexplored territory, not as constraints to enforce.

---

## 5. Zone B Entity State: What It Captures vs What It Misses

Zone B is populated by `EntityStateTracker.extractFromToolCalls()` which scans SQL `WHERE` clauses in `runQuery` tool inputs. This means it captures filters that appear as direct predicates — but misses corrections that require semantic inference or multi-step CTEs.

### What Zone B captures correctly (DCS-001)

```
{ "column": "o_orderpriority", "op": "!=", "value": "5-LOW" }
```

The `5-LOW` exclusion appears verbatim as a `WHERE` clause in the agent's SQL. Zone B captures it with correct `!=` semantics.

### What Zone B misses (IRC-001 — legacy cohort proxy)

The "legacy customers = signed up before 1994" correction requires:

```sql
-- Agent assembles a CTE to proxy for signup date:
WITH legacy_customers AS (
  SELECT c_custkey
  FROM customer c
  JOIN orders o ON c.c_custkey = o.o_custkey
  GROUP BY c_custkey
  HAVING MIN(o.o_orderdate) < '1994-01-01'
)
```

The join condition `MIN(o.o_orderdate) < '1994-01-01'` is a `HAVING` clause, not a direct `WHERE` filter. Zone B's SQL scanner does not capture `HAVING` conditions or CTE definitions — so the legacy cohort proxy never enters Zone B's `activeFilters`. Post-compaction, the agent loses the proxy implementation and defaults to incorrect implementations (`c_mktsegment = 'BUILDING'`, `c_acctbal > 0`).

### Zone B false positives (IRC-001)

```
From data/results/qwery-default/4zone/tpch/irc/tpch-irc-001.json
→ turns[31].zonesSnapshot.entityState.segments[0].content (final turn)

"activeFilters": [
  { "column": "table_name",   "op": "=",  "value": "customer" },   ← noise: information_schema query
  { "column": "c_mktsegment", "op": "=",  "value": "BUILDING" },   ← false positive from unrelated turn
  { "column": "r_name",       "op": "!=", "value": "AMERICA"  },   ← correct
  ...
]
```

The false positives (`table_name = 'customer'` from `information_schema.columns` queries, `c_mktsegment = 'BUILDING'` from a browsing query) are read by the post-compaction agent as active constraints. Gemini confirmed in one sampled IRC turn: the agent "incorrectly substituted the legacy cohort with the BUILDING market segment." Zone B's noise actively causes incorrect SQL.

---

## 6. Session-Level Findings

### 6a. DCS-001 (2 corrections, boundary 15)

See [analysis-tpch-dcs-001.md](./analysis-tpch-dcs-001.md) for the full per-session deep dive.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| compressionRatio | 0.109 | 0.017 | 0.269 | 0.390 | 0.022 | 0.031 | 0 | 0.010 |
| filterPersistenceRate | 29.4% | 44.1% | 32.4% | 41.2% | 38.2% | 35.3% | 26.5% | 35.3% |
| Gemini (0–10) | 7.87 | 6.00 | **10.00** | 6.33 | 6.00 | 7.56 | 6.60 | 6.40 |
| queryConsistencyRate | **100%** | 80% | 60% | 50% | 80% | 60% | 100%† | 66.7%† |

**Key findings**:
- **headroom/plain scores a perfect 10.00** — the highest single result in the series. DCS's simplicity (2 column-value corrections, single compaction event) aligns with headroom's hash-retrieval format.
- **4zone interaction is strategy-dependent**: qwery-default hurt (−1.87), headroom hurt (−3.67), recomp helped (+1.56), llmlingua-2 neutral (−0.20). Zone D narrative is the primary carrier; Zone B noise subtracts from it.
- **recomp/4zone (7.56) beats recomp/plain (6.00)** — Zone B anchors the `5-LOW` exclusion that the extractive snippet mentions but doesn't enforce.
- qwery-default/plain's 100% queryConsistencyRate is the only non-artefactual perfect score in the series.

### 6b. PTA-001 (3 corrections + 2 threads, boundary 15)

**Defining dimension**: `threadIsolation` — corrections established in Thread A must not contaminate Thread B queries, and vice versa.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| filterPersistenceRate | 93.3% | 78.3% | 78.3% | **88.3%** | 68.3% | 83.3% | 86.7% | 83.3% |
| Gemini (0–10) | 8.46 | **9.63** | 7.39 | 🔴 1.27 | 4.31 | 4.62 | 5.75 | 4.74 |
| queryConsistencyRate | 12.5% | 20.0% | 28.6% | 12.5% | 0% | **57.1%** | 0%† | 37.5% |

**Key findings**:
- qwery-default's LLM summary explicitly labels "Thread 1" and "Thread 2" — the only strategy to produce structural thread separation in Zone D. This is why it uniquely achieves full threadIsolation (5/5) post-compaction.
- headroom/4zone scores 1.27 vs 7.39 plain. The first compaction at turn 15 produces a hash-chunked archive with no thread labels — headroom's format is thread-unaware regardless of mode. 4zone then fires 19 more real events, growing Zone D from 3,866 to 209,899 tokens (accumulation, not compression), which makes recovery impossible. But the thread context was already lost by turn 17. See Finding 5.
- recomp/4zone shows a surprising queryConsistencyRate spike (0% → 57.1%) — Zone A schema context makes SQL structurally reproducible even though analytical narrative is lost. The agent "knows the rules but not where the analysis was heading."
- **llmlingua-2/plain (5.75) outperforms recomp/plain (4.31) — the first session where llmlingua-2 beats a non-llmlingua strategy.** The log-header format provides zero context, but the agent's general schema knowledge produces better results than recomp's fragmented Thread B snippets. llmlingua-2/4zone (4.74) scores lower than plain (5.75) — the only strategy where 4zone hurts on PTA. Zone B captures `o_orderstatus = 'F'` as an active filter, anchoring the agent to Thread A's rule, but the filter has no thread label — threadIsolation drops from 4.0 to 3.2 with `thread_bleed` appearing as a failure category.

### 6c. IRC-001 (4 corrections, all pre-boundary, boundary 12)

**Defining dimension**: `correctionPersistence` — 4 rules established before turn 12, including the legacy cohort semantic proxy.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| filterPersistenceRate | 70.0% | 81.3% | 71.3% | 81.3% | 73.8% | 80.0% | 80.0% | **83.8%** |
| Gemini (0–10) | 3.75 | 4.45 | 3.45 | 5.50‡ | 2.00 | 4.45 | 4.10 | **4.85** |
| queryConsistencyRate | 28.6% | 18.2% | 33.3% | 0% | 16.7% | 28.6% | 57.1%† | 66.7%† |
| filterPersistence dim (avg/5) | 0.6 | 1.8 | 0.8 | 2.0 | **0.0** | 1.0 | 1.2 | 1.8 |

**Key findings**:
- All Gemini scores are the lowest of any session type (2.00–5.50 vs 4.31–9.63 on PTA and DCS). IRC is the hardest compression challenge.
- filterPersistenceRate (inline, 70–81%) vs Gemini filterPersistence dimension (0–2/5) shows the starkest measurement gap in this series. The inline metric only checks for `r_name != 'AMERICA'` keyword presence; Gemini also scores the legacy cohort proxy — which all strategies lose.
- 4zone mildly helps on IRC (+0.7 for qwery-default) — the opposite of DCS-001 (-1.87). Zone B captures `r_name != 'AMERICA'` as a simple filter, giving 4zone a partial anchor plain lacks.
- **llmlingua-2/plain (4.10) narrowly beats recomp/plain (2.00)** — the first session where llmlingua-2 is not the worst plain strategy. recomp's extractive format discards correction rules aggressively on IRC; llmlingua-2's blank slate suffers no misleading fragments. llmlingua-2/4zone (4.85) is the second-best 4zone strategy after headroom/4zone (5.50), with Zone A/B providing the only context the compressed session has.

### 6d. SNCJ-001 (2 corrections, 5 cross-boundary schema anaphors, boundary ~12)

**Defining dimension**: `schemaGrounding` — the user repeatedly asks for column names, join keys, and enum values that were revealed in pre-compaction turns.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| filterPersistenceRate | 83.3% | 88.9% | 88.9% | 86.1% | 88.9% | 88.9% | 88.9% | 86.1% |
| Gemini (0–10) | 8.49 | 8.39 | 6.29 | **8.83** | 7.29 | 7.88 | 5.54 | 6.29 |
| schemaGrounding (avg/5) | **5.0** | **5.0** | **5.0** | **5.0** | **5.0** | 4.0 | 3.0 | 3.0 |
| entityContinuity (avg/5) | 4.2 | 4.0 | 2.0 | **4.8** | 3.2 | **4.6** | 3.0 | 3.5 |
| queryConsistencyRate | 40.0% | 28.6% | 40.0% | 40.0% | **80.0%** | 60.0% | 60.0% | 50.0% |

**Key findings**:
- All strategies achieve schemaGrounding = 5.0/5 except llmlingua-2 (3.0 plain and 4zone). Zone A stores `getSchema` outputs verbatim — the exact source for answering "what columns does REGION have again?" For SNCJ, Zone A is the single most effective mechanism in the 4zone architecture.
- **headroom/4zone achieves the best score in the series (8.83/10)** — a complete reversal of the PTA catastrophe (1.27). Zone A holds schema context while 15 compaction events compress Zone D. headroom's hash-chunked format loses entity continuity in plain mode (entityContinuity=2.0); Zone A restores it directly (4.8 in 4zone).
- **headroom/plain compaction overhead is 184.79%** — the highest in the benchmark series. The proxy takes more time compressing than the agent spends on LLM calls. Combined with the lowest SNCJ Gemini score (6.29), this is the only combination where compression is unambiguously counterproductive.
- **recomp/plain achieves 80% queryConsistencyRate** — highest after qwery-default/DCS. SNCJ's stable FK join patterns (`ORDERS→CUSTOMER→NATION→REGION`) survive extractive compression and are reproduced identically by the cold-start agent.

### 6e. RCI-001 (3 corrections + callback references, boundary 14)

**Defining dimension**: `callbackResolution` — the user refers back to earlier analytical results ("the weekly order volume we looked at earlier") that must be reconstructed from compressed context alongside the filter rules.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| filterPersistenceRate | 95.2% | **98.8%** | 96.4% | 95.2% | 95.2% | 95.2% | 97.6% | 95.2% |
| Gemini (0–10) | 5.26 | 5.48 | 3.79 | **8.40** | 4.24 | 5.75 | 2.00 | 6.46 |
| callbackResolution (avg/5) | 4.60 | **5.00** | 2.20 | **5.00** | 2.00 | 4.20 | 1.00 | **5.00** |
| filterPersistence dim (avg/5) | 0.80 | 0.80 | 0.40 | **4.60** | 0.60 | 1.60 | 1.00 | 1.50 |
| correctionPersistence (avg/5) | 1.80 | 1.80 | 2.00 | **4.40** | 0.80 | 1.80 | 1.00 | 2.50 |

**Key findings**:
- **headroom/4zone leads at 8.40** — the same pattern as SNCJ and saas-PTA. Zone B captures `o_orderstatus = 'O'` as an active filter, giving the 4zone agent a structural anchor for callback references ("apply the same filters"). Plain headroom (3.79) lacks this anchor and falls to second-worst. The 4.61 gap is the widest 4zone benefit on RCI.
- **callbackResolution is served by Zone B**, not Zone D. All three 4zone strategies with Zone B hit 5.0/5 callbackResolution (qwery-default, headroom, llmlingua-2). Only recomp/4zone scores lower (4.20) — its 8 compaction events fragment Zone D so aggressively that even Zone B cannot fully compensate.
- **llmlingua-2/plain scores 2.00 — the lowest RCI score — with all dimensions at exactly 1.0/5.** The 45-character log-header summary provides zero callback context. llmlingua-2/4zone recovers to 6.46, the largest plain-to-4zone jump (+4.46) of any RCI strategy. Zone B's filter storage is the mechanism.
- **Inline filterPersistenceRate (95–99%) is meaningless for RCI** — the 42-turn session saturates the keyword-matching metric. Gemini filterPersistence ranges from 0.40 to 4.60, confirming the measurement gap is worst on the longest session type.
- **RCI ranks below IRC in difficulty** (2.00–8.40 vs IRC's 2.00–5.50). The corrections are simpler (direct column filters, no semantic proxy) and the callback references are filter-oriented, matching what Zone B stores. The 8.40 ceiling shows that RCI is solvable by 4zone strategies — unlike IRC where no strategy exceeds 5.50.

### 6f. saas-PTA-001 (4 corrections, 2 threads, SaaS domain — cross-database PTA comparison)

**Defining dimension**: `threadIsolation` — same stress test as tpch-pta-001 but on SaaS analytics schema (subscriptions, feature_usage, accounts).

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone |
|---|---|---|---|---|---|---|
| filterPersistenceRate | 78.1% | 72.9% | **84.4%** | 77.1% | 71.9% | 67.7% |
| Gemini (0–10) | 6.98 | 7.14 | 7.60 | **8.71** | 7.91 | 7.85 |
| filterPersistence (avg/5) | 0.40 | 0.80 | 1.20 | **3.20** | 1.60 | 2.00 |
| threadIsolation (avg/5) | **5.0** | **5.0** | **5.0** | **5.0** | **5.0** | **5.0** |
| queryConsistencyRate | 15.4% | 28.6% | 7.1% | 7.7% | 5.9% | **21.4%** |

**Key findings**:
- **threadIsolation = 5.0/5 for all strategies** — complete reversal of tpch-pta-001 where only qwery-default maintained isolation. Cause: saas threads use structurally distinct tables (`subscriptions`/`end_date` for churn vs `feature_usage`/`usage_count` for feature adoption). Cross-thread bleed is structurally impossible regardless of compression format. tpch PTA required *narrative* thread labels; saas PTA requires none.
- **recomp/plain jumps from 4.31 → 7.91** — the largest single cross-database shift in the series. SaaS domain vocabulary (`churn`, `cancelled`, `activation`, `trial`) appears naturally in query results and survives extractive compression. The agent sees "no canceled status found" in the context and correctly infers the churn definition. tpch PTA's failure was generic narrative labels that extraction destroyed; saas PTA's corrections are encoded in the domain data itself.
- **qwery-default/plain scores lowest (6.98)** — its relative advantage disappears when thread isolation is no longer a differentiator. filterPersistence (0.40/5) remains as weak as on tpch PTA, now more visible without the thread isolation advantage to compensate.
- **headroom/4zone again best (8.71)** — consistent with SNCJ pattern. Zone A holds the SaaS schema; the smaller, well-structured saas table set (vs tpch's 8-table FK web) makes Zone A content more precise and less noisy.

---

## 7. Cross-Cutting Findings

### Finding 1: filter_drift is universal — no strategy consistently enforces pre-boundary corrections after compaction

`filter_drift` or `correction_ignored` appears in every strategy's failure categories across all session types. The failure is not about which strategy you use — it is about whether the compression format encodes rules as constraints vs results.

| Strategy | DCS-001 | PTA-001 | IRC-001 | RCI-001 | Mechanism |
|---|---|---|---|---|---|
| qwery-default/plain | 7.87 | 8.46 | 3.75 | 5.26 | Rules embedded in prose — reproduced when user re-invokes them, not proactively |
| headroom/plain | **10.00** | 7.39 | 3.45 | 3.79 | Rules in hash-retrieved chunks — works on simple sessions, fails on complex ones |
| recomp-extractive/plain | 6.00 | 4.31 | 2.00 | 4.24 | Rules stripped by extraction — only results survive |
| llmlingua-2/plain | 6.60 | 5.75 | 4.10 | 2.00 | No summary — score reflects inference from schema alone |
| headroom/4zone | 6.33 | 1.27 | 5.50 | **8.40** | Zone B rescues filter-oriented sessions; Zone Z accumulation destroys thread-isolation sessions |
| qwery-default/4zone | 6.00 | **9.63** | 4.45 | 5.48 | Zone B + structured narrative compound well when narrative is strong |

RCI confirms the pattern: filter_drift and correction_ignored dominate even on a session type where corrections are simple column-value filters. The 4zone strategies that achieve high callbackResolution (5.0/5) still show filter_drift in their failure categories — Zone B stores the filters but the agent does not apply them proactively.

### Finding 2: The filterPersistenceRate inline metric is a weak signal at best, misleading at worst

Inline filterPersistenceRate counts whether correction keywords appear in agent responses/SQL — not whether the correct SQL semantics are applied. Across sessions:

| Session | Inline rate range | Gemini filterPersistence avg (max=5) | Gap |
|---|---|---|---|
| DCS-001 | 29–50% | ~2.8/5 for qwery-default | Moderate |
| PTA-001 | 68–93% | 0–3.6/5 depending on strategy | Large |
| IRC-001 | 70–81% | **0.0–1.8/5** across all strategies | **Extreme** |
| RCI-001 | 95–99% | 0.4–4.6/5 across all strategies | **Extreme** |

IRC is the worst case because the legacy cohort correction ("signed up before 1994") requires a proxy implementation that produces result values and table names, giving the inline metric a false positive even when the SQL is semantically wrong. RCI's inline rate saturates at 95–99% because the 42-turn session produces SQL with correction-adjacent keywords in nearly every turn — the metric flatlines at ceiling while Gemini filterPersistence ranges from 0.40 to 4.60. The Gemini judge, having access to the full original conversation (1M context window), correctly identifies when the proxy is wrong.

### Finding 3: 4zone interaction effects are strategy- and session-type-dependent, driven by which zone carries the primary analytical load

| Strategy | DCS (4z vs pl) | PTA (4z vs pl) | IRC (4z vs pl) | SNCJ (4z vs pl) | RCI (4z vs pl) |
|---|---|---|---|---|---|
| qwery-default | 7.87→6.00 **(hurt)** | 8.46→**9.63 (help)** | 3.75→4.45 (mild) | 8.49→8.39 **(neutral)** | 5.26→5.48 (mild) |
| headroom | 10.00→6.33 **(hurt)** | 7.39→**1.27 (disaster)** | 3.45→5.50 (help) | 6.29→**8.83 (best)** | 3.79→**8.40 (best)** |
| recomp-extractive | 6.00→7.56 (help) | 4.31→4.62 (neutral) | 2.00→4.45 (help) | 7.29→7.88 (moderate) | 4.24→5.75 (help) |
| llmlingua-2 | 6.60→6.40 (neutral) | 5.75→4.74 **(hurt)** | 4.10→4.85 (help) | 5.54→6.29 (help) | 2.00→**6.46 (rescue)** |

The zone that carries the primary load determines the outcome:
- **DCS**: Zone D (LLM narrative) is strong enough that Zone B noise subtracts from quality. 4zone hurts qwery-default and headroom; only recomp benefits because Zone B fills recomp's extractive gap.
- **PTA**: Zone D must preserve thread labels. headroom's hash-chunked format loses them at the first compaction; Zone D then accumulates to 209,899 tokens. llmlingua-2's 4zone also hurts (Zone B anchor causes thread_bleed without thread labels).
- **IRC**: Mixed — 4zone mildly helps most strategies but no one breaks 5.50. Zone B captures `r_name != 'AMERICA'` but misses the legacy cohort proxy.
- **SNCJ**: Zone A (schema) is decisive. headroom/4zone becomes best in series because Zone A answers schema recall questions directly.
- **RCI**: Zone B (filters) carries the load. headroom/4zone and llmlingua-2/4zone are rescued from plain-mode failure. callbackResolution is directly served by Zone B's activeFilters.

The implication: **the 4zone architecture is most beneficial when Zone A schema context or Zone B filter anchors are the primary gap in plain mode** (schema-heavy sessions like SNCJ, filter-oriented sessions like RCI). It is least beneficial (or harmful) when the gap is in narrative structure that no zone can encode (semantic corrections like the IRC legacy cohort proxy, or thread labels on PTA).

### Finding 4: recomp-extractive degrades monotonically with correction complexity

recomp strips context to extracted result snippets. Corrections are metadata about intent — they appear in user messages, not result tables. Extraction by definition removes them.

| Session | Gemini score | Dominant failures |
|---|---|---|
| DCS-001 | 6.00 (competitive with qwery-default) | filter_drift, correction_ignored |
| PTA-001 | 4.31 (worst plain strategy) | entity_confusion, **thread_bleed**, baseline_loss |
| IRC-001 | 2.00 (worst overall) | filter_drift, **correction_ignored** (0/5 filterPersistence) |

DCS-001 has the fewest corrections and they're concrete column=value rules that often appear in result descriptions. PTA adds thread structure that extraction destroys (explicit "Thread 1 / Thread 2" labels don't survive). IRC adds a semantic proxy that has no result-table representation. recomp loses quality at each step.

### Finding 5: headroom/4zone's 1.27 on PTA is caused by headroom's format, not 4zone's firing frequency

The first compaction event at PTA turn 15 (2,540ms, a real proxy call) converts 14 turns of interleaved Thread A / Thread B content into a hash-chunked archive with no thread labels — the same structural failure as headroom/plain, but more consequential. By the first post-compaction sample (turn 17), all five Gemini dimensions except analyticalThread are already at 0/5. Thread context was gone before the "frequency problem" had time to matter.

The per-session headroom/4zone event analysis confirms the format-first explanation:

| Session | Real events (>100ms) | Near-instant no-ops | Zone D growth | Gemini |
|---|---|---|---|---|
| PTA-001 | **20** (all events real, Zone D: 3,866→209,899 tok) | 0 | 54× | **1.27** |
| IRC-001 | 1 (last event only, 4,805ms) | 5 (1–9ms, no summary written) | minimal | 5.50 |
| SNCJ-001 | 14 (Zone D: 2,782→42,903 tok) | 1 (first event, 3ms) | 15× | **8.83** |
| RCI-001 | 0 (single event at 6,339ms) | 0 | single event | **8.40** |

IRC improves because headroom barely fires real events — Zone D barely changes. SNCJ fires 14 real events and Zone D grows 15×, yet scores 8.83 because Zone A holds the schema that SNCJ needs. RCI fires once and scores 8.40 — Zone B captures `o_orderstatus = 'O'` as a filter, and the single-event boundary prevents Zone D accumulation. PTA fires 20 real events and Zone D grows 54×, but the agent was already thread-confused from the first event — the accumulation makes recovery impossible rather than causing the initial failure.

**The 1.27 is headroom's thread-unaware format colliding with PTA's thread-isolation requirement, amplified by Zone D accumulation.** It is not a general headroom/4zone architecture failure: headroom/4zone delivers 5.50 on IRC, 8.83 on SNCJ, and 8.40 on RCI.

### Finding 6: Schema structure determines thread isolation — not compression format

The saas-pta-001 result proves that threadIsolation failures on tpch-pta-001 were not caused by compression format weaknesses alone. When threads use structurally distinct tables (saas: `subscriptions` vs `feature_usage`), every strategy achieves 5.0/5 threadIsolation regardless of format. When threads share tables (tpch: both use `ORDERS`/`LINEITEM`), only qwery-default's explicit narrative labeling maintains isolation.

**Implication**: the threadIsolation problem in tpch PTA is an evaluation artifact of that session's schema, not a general finding about compression. On production SaaS analytics workloads — where different analytical questions naturally use different tables — this failure mode may rarely occur.

The failure that generalises across both databases: **filter_drift and correction_ignored remain universal**. filterPersistence averages 0.40–3.20/5 on saas PTA, same failure bands as tpch PTA. The domain corrections (churn = cancelled, exclude trial) are business rules that every format still drops post-compaction.

### Finding 7: Domain vocabulary in saas enables recomp to recover from its tpch PTA collapse

| Session | recomp/plain Gemini | Root cause |
|---|---|---|
| tpch-pta-001 | 4.31 | Generic "Thread 1 / Thread 2" narrative labels destroyed by extraction |
| saas-pta-001 | **7.91** | Domain vocabulary (`churn`, `cancelled`, `trial`, `activation`) survives in result snippets |

recomp's extractive format preserves result data, not intent metadata. tpch PTA's corrections lived in narrative labels that had no result representation. saas PTA's corrections are encoded in the domain data itself — the agent discovering "no canceled status found" in the compacted context correctly infers the churn definition without a rule having been explicitly preserved. **This means recomp's quality is highly schema-dependent**: it works well when the correction vocabulary is domain-specific and appears in query results; it fails when corrections are generic narrative structures.

### Finding 8: Zone B captures syntactic filters, not semantic corrections

Zone B is populated from SQL `WHERE` clause extraction. The fundamental limitation:

**Captured correctly**: Direct column predicates (`r_name != 'AMERICA'`, `o_orderpriority != '5-LOW'`) — these appear verbatim in WHERE clauses.

**Not captured**: `HAVING` aggregation conditions, CTE definitions, corrections stated in natural language without SQL correspondence ("use customer region not supplier region"), and any correction whose SQL implementation is assembled across multiple turns with varying column names.

This means Zone B is most useful for DCS-type sessions (simple column exclusion rules) and least useful for IRC-type sessions (semantic proxies via complex CTEs). The Zone B advantage on filterPersistenceRate is real but bounded.

### Finding 9: Zone B false positives actively degrade quality on IRC

On IRC, Zone B accumulates false positives from unrelated SQL operations: `table_name = 'customer'` (from `information_schema` schema inspection queries), `c_mktsegment = 'BUILDING'` (from a casual browsing query in turns 1–10). These appear in Zone B as active constraints and the post-compaction agent applies them, generating wrong SQL.

On DCS and PTA, this effect was less pronounced because the fewer corrections mean less noise relative to signal. IRC's 4 pre-boundary corrections with complex interactions make Zone B noise relatively more damaging.

### Finding 10: Row-count consistency (queryConsistencyRate) measures structural SQL reproducibility, not quality

Across all sessions, queryConsistencyRate is uniformly low — typically 0–33% — except for a few outliers:

| Exception | Rate | Explanation |
|---|---|---|
| qwery-default/plain DCS-001 | 100% | Simple 2-table aggregation queries with explicit filter values in the summary |
| llmlingua-2/plain DCS-001 | 100%† | Artefact — log-header summary; row-count match is coincidence from schema-gnessable queries |
| recomp/4zone PTA-001 | 57.1% | Zone A schema context anchors SQL structure |
| llmlingua-2/plain IRC-001 | 57.1%† | Same artefact — no analytical context, coincidence match |
| llmlingua-2/4zone IRC-001 | 66.7%† | Same artefact |

The low baseline reflects that complex multi-join queries with CTEs (IRC) and cross-thread SQL (PTA) are structurally non-deterministic — a cold-start agent reconstructing from compressed context writes semantically equivalent but structurally different SQL. This is an LLM property, not a compression failure.

> † llmlingua-2 queryConsistencyRate values are evaluation artefacts — the summary is a log header with no analytical content. See Finding 9.

### Finding 11: llmlingua-2 produces a log header, not a summary — all quality metrics are evaluation artefacts

llmlingua-2 produces a ~80-character log header as "summary" on every session type:

| Session | Summary text |
|---|---|
| DCS-001 | `[llmlingua-2] compressed parts — tokens 4657 → 3858` |
| IRC-001 | `[llmlingua-2] compressed parts — tool:20 llm:36 user:0; saved 23383 tokens (57343 → 33960, 59.2% retained)` |
| PTA-001 | `[llmlingua-2] compressed parts — tool:25 llm:49 user:0; saved 19146 tokens (45402 → 26256, 57.8% retained)` |
| RCI-001 | `[llmlingua-2] compressed parts — tool:27 llm:54 user:0; saved 18330 tokens (47742 → 29412, 61.6% retained)` |
| SNCJ-001 | `[llmlingua-2] compressed parts — tokens 6375 → 4453` |

No analytical content survives. The post-compaction agent has zero context for answering user questions, running queries, or following corrections. All quality metrics reflect what the agent can infer from schema alone (plain mode) or from Zone A/B (4zone mode):

- **queryConsistencyRate values (0–100%) are pure noise** — row-count "matches" are coincidence from queries whose results are guessable from schema.
- **Gemini scores in 4zone mode (4.85–6.46) reflect Zone A/B, not llmlingua-2's compression** — the summary provides nothing. llmlingua-2/4zone on RCI scores 6.46 entirely from Zone B's `activeFilters` and Zone A's schema context.
- **llmlingua-2/plain scores (2.00–6.60) measure the agent's ability to work without any compressed context** — effectively a lower bound for each session type. On RCI (2.00) and IRC (4.10), the blank-slate agent still outperforms recomp/plain's misleading fragments (2.00 and 2.00 respectively).

Compaction overhead varies by session (8–35%), consistently higher than qwery-default and headroom but lower than the worst recomp events. llmlingua-2 is unsuitable for production use in its current form — the compressed output must be re-injected into the LLM context window (not the log metadata) for comparison to be meaningful.

---

## 8. Zone B Architecture Assessment

Zone B was designed to track structured entity state (active filters, corrections, open threads) as enforced context for the post-compaction agent. After five session types:

**Zone B's contribution is real but partial:**

- DCS-001: Zone B stores `o_orderpriority != '5-LOW'` correctly → live filterPersistenceRate 44% vs 29% plain. The live agent uses it.
- PTA-001: Zone B captures SQL filter snapshots but not thread labels → improvement on filter anchoring, no improvement on thread isolation.
- IRC-001: Zone B captures `r_name != 'AMERICA'` → partial improvement. Misses legacy cohort → the correction that matters most.
- SNCJ-001: Zone B captures `o_orderstatus = 'O'` and `C_NATIONKEY` → contributes to high schemaGrounding scores alongside Zone A.
- RCI-001: Zone B captures `o_orderstatus = 'O'` → drives callbackResolution to 5.0/5 for three of four 4zone strategies. RCI is the session type where Zone B's benefit is clearest.

**The unresolved gap**: Zone B stores what the agent *did*, not what it *should do*. A filter applied in turn 5 to a specific query is stored as an active filter — but the agent treats it as informational context, not a constraint to enforce on all future queries. The gap between "agent reads Zone B" and "agent enforces Zone B" is the primary open problem.

**The false positive problem**: Zone B's regex-based SQL extraction creates noise from `information_schema` queries, `HAVING` clause misclassification, and CTE join conditions being parsed as table names. This noise grows as the session length increases and the query variety increases.

---

## 9. Strategy Ranking by Session Type

### Best strategy per session (plain mode, by Gemini score)

| Session | Best | Score | Runner-up | Score |
|---|---|---|---|---|
| DCS-001 | headroom | **10.00** | qwery-default | 7.87 |
| PTA-001 (tpch) | qwery-default | **8.46** | headroom | 7.39 |
| IRC-001 | qwery-default | **3.75** | llmlingua-2 | 4.10 |
| SNCJ-001 | qwery-default | **8.49** | recomp-extractive | 7.29 |
| RCI-001 | qwery-default | **5.26** | recomp-extractive | 4.24 |
| PTA-001 (saas) | recomp-extractive | **7.91** | headroom | 7.60 |

qwery-default/plain was the best plain strategy on all tpch session types until DCS was re-evaluated — headroom/plain's perfect 10.00 now leads DCS. The LLM narrative format remains resilient: qwery-default leads on PTA (8.46), SNCJ (8.49), and RCI (5.26). headroom/plain leads on DCS only — a result of DCS's simplicity (2 direct column-value corrections) aligning with headroom's hash-retrieval format. recomp-extractive/plain leads on saas-pta-001 (7.91).

Note: IRC plain-mode rankings changed with llmlingua-2 data (4.10 vs qwery-default's 3.75), but these were scored on different Gemini judge versions and are not directly comparable.

### 4zone mode impact by strategy

| Strategy | DCS | PTA | IRC | SNCJ | RCI | Pattern |
|---|---|---|---|---|---|---|
| qwery-default | −1.87 | +1.17 | +0.70 | −0.10 | +0.22 | Helps when plain is weak; neutral/hurt when plain is strong |
| headroom | −3.67 | −6.12 (catastrophic) | +2.05 | +2.54 | +4.61 | Zone A/B determines outcome: rescues when filters/schema dominate, collapses on narrative sessions |
| recomp-extractive | +1.56 | +0.31 | +2.45 | +0.59 | +1.51 | Consistent modest benefit — Zone A/B fill recomp's narrative gap |
| llmlingua-2 | −0.20 | −1.01 | +0.75 | +0.75 | +4.46 | Zone A/B rescue llmlingua-2 from blank-slate degradation; PTA anomaly where Zone B causes thread_bleed |

**headroom has the widest variance** (−6.12 to +2.54 on tpch; +2.05 saas-pta headroom/4zone=8.71) — it is simultaneously the worst possible choice (PTA/4zone) and the best-performing combination in the series (SNCJ/4zone). The session type determines which.

---

## 10. Open Questions

1. **Zone B constraint enforcement**: Zone B is read as informational context. A system prompt directive ("apply all `activeFilters` to every `runQuery` call") could change this. Whether that directive causes its own side effects (over-filtering) is untested.

2. **Zone B HAVING/CTE support**: The legacy cohort failure on IRC is a clear gap. Extending `EntityStateTracker.extractFromToolCalls()` to parse `HAVING` conditions and CTE definitions would directly address the most common IRC failure mode.

3. **headroom/plain DCS perfect 10.00**: headroom/plain achieves a perfect Gemini score on DCS — all 5 dimensions at maximum, no failure categories. The per-turn verification data is incomplete (individual turn scores missing), so we cannot confirm whether this is a genuinely perfect result or an aggregation artifact. Re-running the Gemini verification with full per-turn data would settle this.

4. **Cross-database generalizability**: All sessions above are TPC-H. The saas database (SaaS analytics schema) tests whether findings hold on a different schema structure. saas-dcs-001 and saas-rci-001 results are available for llmlingua-2 and baseline; other strategies not yet run.

5. **RCI callbackResolution measurement**: queryConsistencyRate was not computed for RCI verifies. Adding it would allow direct comparison with other session types and confirm whether RCI's callback-miss failures correlate with SQL non-reproducibility.

6. **Zone A quantified contribution**: SNCJ shows Zone A is decisive for schema recall. Ablating Zone A from 4zone on SNCJ would directly measure the schema-recall contribution vs Zone B/D. Currently inferred from schemaGrounding dimension scores.

7. **headroom/plain overhead on SNCJ (184%)**: This is an anomaly worth diagnosing — is the headroom proxy doing something unexpected with schema-heavy content, or is this specific to the SNCJ session structure?

8. **saas-dcs-001**: The direct cross-database counterpart to tpch-dcs-001 (2 simple corrections, no thread complexity). Running this would isolate whether the recomp/saas recovery is PTA-specific (domain vocabulary) or a general saas property. llmlingua-2 and baseline already have saas-dcs results.

9. **Gemini version consistency**: llmlingua-2 and DCS headroom/recomp results were scored with an updated Gemini judge code path (grounded evaluation with SQL-based entity state). Earlier scores (qwery-default, headroom/plain rc/plain on IRC/PTA/SNCJ) used an earlier version. Cross-session comparisons that span these cohorts — like llmlingua-2/plain beating qwery-default/plain on IRC — may reflect judge version differences rather than compression quality differences. Re-scoring all strategies on a single judge version would eliminate this confound.
