# Consolidated Analysis: Context Compression Strategies across Session Types

**Sessions covered**: `tpch-dcs-001`, `tpch-pta-001`, `tpch-irc-001`, `tpch-sncj-001`
**Strategies**: baseline-no-compression, qwery-default, headroom, recomp-extractive, llmlingua-2
**Modes**: plain, 4zone
**Database**: TPC-H SF=1
**Last updated**: 2026-05-30

For per-session deep dives see:
- [analysis-tpch-dcs-001 (original)](./analysis.md#dcs-001) — this document
- [analysis-tpch-pta-001.md](./analysis-tpch-pta-001.md)
- [analysis-tpch-irc-001.md](./analysis-tpch-irc-001.md)
- [analysis-tpch-sncj-001.md](./analysis-tpch-sncj-001.md)

---

## 1. Session Type Reference

| Type | Description | Turns | Boundary | Corrections | Key failure mode |
|---|---|---|---|---|---|
| **DCS** | Deep Callback Session — 2 pre-boundary rules, tested via deep callbacks | 32 | 15 | 2 | filter_drift |
| **PTA** | Parallel Thread Analysis — 2 interleaved analytical threads, 3 corrections | 35 | 15 | 3 | thread_bleed, filter_drift |
| **IRC** | Iterative Refinement with Corrections — 4 pre-boundary corrections including a semantic proxy | 32 | 12 | 4 | correction_ignored, filter_drift |
| **SNCJ** | Schema Navigation and Complex Joins — 2 corrections, 5 cross-boundary schema recall anaphors | 30 | ~12 | 2 | schemaGrounding, filter_drift |

**Correction complexity increases from DCS → PTA → IRC**: DCS has the fewest constraints (2), PTA adds thread isolation, IRC has the most pre-boundary corrections (4) with the hardest one requiring a semantic SQL proxy. **SNCJ is orthogonal** — its challenge is schema recall across the boundary, not correction density.

---

## 2. Full Coverage Matrix

| Session | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone | baseline |
|---|---|---|---|---|---|---|---|---|---|
| tpch-dcs-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| tpch-pta-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| tpch-irc-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| tpch-sncj-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |

---

## 3. Cross-Session Metrics Summary

### 3a. Inline Metrics (live session)

| Session | Strategy | Mode | compressionRatio | filterPersistenceRate | compactionOverheadPct | compactionEvents |
|---|---|---|---|---|---|---|
| DCS-001 | baseline | plain | — | 32.4% | — | 0 |
| DCS-001 | qwery-default | plain | 0.109 | 29.4% | 0.62% | 1 |
| DCS-001 | qwery-default | 4zone | 0.017 | **44.1%** | ~0% | 1 |
| DCS-001 | headroom | plain | 0.269 | 32.4% | 0.62% | 1 |
| DCS-001 | headroom | 4zone | 0.384 | — | — | — |
| DCS-001 | recomp-extractive | plain | 0.022 | 38.2% | 1.52% | 1 |
| DCS-001 | recomp-extractive | 4zone | 0.031 | — | — | — |
| DCS-001 | llmlingua-2 | plain | 0.828 | 50.0% | **23.49%** | 1 |
| PTA-001 | qwery-default | plain | 0.112 | **93.3%** | 1.91% | 1 |
| PTA-001 | qwery-default | 4zone | 0.026 | 78.3% | ~0% | 1 |
| PTA-001 | headroom | plain | 0.182 | 78.3% | 0.62% | 1 |
| PTA-001 | headroom | 4zone | 4.499* | **88.3%** | 0.45% | **20** |
| PTA-001 | recomp-extractive | plain | 0.029 | 68.3% | 0.93% | 1 |
| PTA-001 | recomp-extractive | 4zone | 0.025 | 83.3% | 9.77% | 2 |
| IRC-001 | qwery-default | plain | 0.099 | 70.0% | 1.14% | 1 |
| IRC-001 | qwery-default | 4zone | 0.097 | 81.3% | 1.10% | 1 |
| IRC-001 | headroom | plain | 0.292 | 71.3% | 0.52% | 1 |
| IRC-001 | headroom | 4zone | 0.374 | 81.3% | 0.50% | 6 |
| IRC-001 | recomp-extractive | plain | 0.033 | 73.8% | 3.58% | 1 |
| IRC-001 | recomp-extractive | 4zone | 0.019 | 80.0% | 1.12% | 1 |
| SNCJ-001 | qwery-default | plain | 0.099 | 83.3% | 4.63% | 1 |
| SNCJ-001 | qwery-default | 4zone | 0.071 | 88.9% | 29.24% | 11 |
| SNCJ-001 | headroom | plain | 0.234 | 88.9% | **184.79%** | 1 |
| SNCJ-001 | headroom | 4zone | 1.911* | 86.1% | 1.26% | 15 |
| SNCJ-001 | recomp-extractive | plain | 0.020 | 88.9% | 2.51% | 1 |
| SNCJ-001 | recomp-extractive | 4zone | 0.023 | 88.9% | 35.88% | 5 |
| SNCJ-001 | llmlingua-2 | plain | 0 | 88.9% | 21.19% | 1 |
| SNCJ-001 | llmlingua-2 | 4zone | 0.009 | 86.1% | 0.45% | 5 |

> *headroom/4zone compressionRatio > 1 is a metric artifact from averaging multiple per-event ratios with varying pre-compaction token counts.

### 3b. Post-Processing Metrics (Gemini judge)

| Session | Strategy | Mode | Gemini (0–10) | queryConsistencyRate | Dominant failures |
|---|---|---|---|---|---|
| DCS-001 | qwery-default | plain | **7.87** | **100%** | filter_drift, correction_ignored |
| DCS-001 | qwery-default | 4zone | 6.00 | 80% | filter_drift, correction_ignored |
| DCS-001 | headroom | plain | 6.88 | 80% | filter_drift, entity_confusion |
| DCS-001 | recomp-extractive | plain | 6.00 | 80% | filter_drift, correction_ignored |
| DCS-001 | llmlingua-2 | plain | 6.30 | 22%† | entity_confusion |
| PTA-001 | qwery-default | plain | 8.46 | 12.5% | filter_drift, correction_ignored |
| PTA-001 | qwery-default | 4zone | **9.63** | 20.0% | entity_confusion, baseline_loss |
| PTA-001 | headroom | plain | 7.39 | 28.6% | entity_confusion, filter_drift, correction_ignored |
| PTA-001 | headroom | 4zone | 🔴 1.27 | 12.5% | filter_drift, entity_confusion, correction_ignored, baseline_loss |
| PTA-001 | recomp-extractive | plain | 4.31 | 0% | entity_confusion, thread_bleed, baseline_loss |
| PTA-001 | recomp-extractive | 4zone | 4.62 | **57.1%** | filter_drift, entity_confusion, baseline_loss |
| IRC-001 | qwery-default | plain | 3.75 | 28.6% | filter_drift, correction_ignored |
| IRC-001 | qwery-default | 4zone | 4.45 | 18.2% | filter_drift, correction_ignored, entity_confusion |
| IRC-001 | headroom | plain | 3.45 | 33.3% | filter_drift, correction_ignored |
| IRC-001 | headroom | 4zone | 5.50‡ | 0% | filter_drift, correction_ignored |
| IRC-001 | recomp-extractive | plain | 2.00 | 16.7% | filter_drift, correction_ignored, entity_confusion |
| IRC-001 | recomp-extractive | 4zone | **4.45** | **28.6%** | filter_drift, correction_ignored, entity_confusion |
| SNCJ-001 | qwery-default | plain | 8.49 | 40.0% | none(2), filter_drift(3), baseline_loss(1) |
| SNCJ-001 | qwery-default | 4zone | 8.39 | 28.6% | none(2), filter_drift(1), correction_ignored(2) |
| SNCJ-001 | headroom | plain | 6.29 | 40.0% | filter_drift(4), entity_confusion(3), baseline_loss(3) |
| SNCJ-001 | headroom | 4zone | **8.83** | 40.0% | filter_drift(3), correction_ignored(3) |
| SNCJ-001 | recomp-extractive | plain | 7.29 | **80.0%** | filter_drift(3), correction_ignored(3) |
| SNCJ-001 | recomp-extractive | 4zone | 7.88 | 60.0% | filter_drift(2), correction_ignored(3) |
| SNCJ-001 | llmlingua-2 | plain | 5.54 | 60.0% | filter_drift(2), correction_ignored(2), baseline_loss(2) |
| SNCJ-001 | llmlingua-2 | 4zone | 6.29 | 50.0% | filter_drift(1), correction_ignored(1) |

> †llmlingua-2 queryConsistencyRate=22% is an evaluation artefact — the "summary" is a log header with no analytical context. See Finding 9.
> ‡headroom/4zone IRC sampled only 1 Gemini turn (quota exhausted mid-verify); score not statistically representative.

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

**What compaction produces**: All strategies test whether the `5-LOW` exclusion and fiscal year correction survive into the summary.

| Metric | qd/plain | qd/4zone | hr/plain | rc/plain | ll2/plain |
|---|---|---|---|---|---|
| compressionRatio | 0.109 | 0.017 | 0.269 | 0.022 | 0.828 |
| filterPersistenceRate | 29.4% | **44.1%** | 32.4% | 38.2% | 50.0% |
| Gemini (0–10) | **7.87** | 6.00 | 6.88 | 6.00 | 6.30 |
| queryConsistencyRate | **100%** | 80% | 80% | 80% | 22%† |

**Key finding**: 4zone helps the live agent (filterPersistence +15pp) but hurts the Gemini re-run score (-1.87). Zone B stores `o_orderpriority != '5-LOW'` correctly, and the live agent applies it more consistently. But on cold re-run, the Zone B JSON is read as informational context, not an enforced constraint — the narrative-embedded constraint in the plain summary is more compelling to the model. qwery-default/plain achieves the only 100% queryConsistencyRate in the entire benchmark series.

### 6b. PTA-001 (3 corrections + 2 threads, boundary 15)

**Defining dimension**: `threadIsolation` — corrections established in Thread A must not contaminate Thread B queries, and vice versa.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone |
|---|---|---|---|---|---|---|
| filterPersistenceRate | 93.3% | 78.3% | 78.3% | **88.3%** | 68.3% | 83.3% |
| Gemini (0–10) | 8.46 | **9.63** | 7.39 | 🔴 1.27 | 4.31 | 4.62 |
| queryConsistencyRate | 12.5% | 20.0% | 28.6% | 12.5% | 0% | **57.1%** |

**Key findings**:
- qwery-default's LLM summary explicitly labels "Thread 1" and "Thread 2" — the only strategy to produce structural thread separation in Zone D. This is why it uniquely achieves full threadIsolation (5/5) post-compaction.
- headroom/4zone scores 1.27 vs 7.39 plain. The first compaction at turn 15 produces a hash-chunked archive with no thread labels — headroom's format is thread-unaware regardless of mode. 4zone then fires 19 more real events, growing Zone D from 3,866 to 209,899 tokens (accumulation, not compression), which makes recovery impossible. But the thread context was already lost by turn 17. See Finding 5.
- recomp/4zone shows a surprising queryConsistencyRate spike (0% → 57.1%) — Zone A schema context makes SQL structurally reproducible even though analytical narrative is lost. The agent "knows the rules but not where the analysis was heading."

### 6c. IRC-001 (4 corrections, all pre-boundary, boundary 12)

**Defining dimension**: `correctionPersistence` — 4 rules established before turn 12, including the legacy cohort semantic proxy.

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone |
|---|---|---|---|---|---|---|
| filterPersistenceRate | 70.0% | 81.3% | 71.3% | 81.3% | 73.8% | 80.0% |
| Gemini (0–10) | 3.75 | 4.45 | 3.45 | 5.50‡ | 2.00 | **4.45** |
| queryConsistencyRate | 28.6% | 18.2% | 33.3% | 0% | 16.7% | **28.6%** |
| filterPersistence dim (avg/5) | 0.6 | 1.8 | 0.8 | 2.0 | **0.0** | — |

**Key findings**:
- All Gemini scores are the lowest of any session type (2.00–5.50 vs 4.31–9.63 on PTA and DCS). IRC is the hardest compression challenge.
- filterPersistenceRate (inline, 70–81%) vs Gemini filterPersistence dimension (0–2/5) shows the starkest measurement gap in this series. The inline metric only checks for `r_name != 'AMERICA'` keyword presence; Gemini also scores the legacy cohort proxy — which all strategies lose.
- 4zone mildly helps on IRC (+0.7 for qwery-default) — the opposite of DCS-001 (-1.87). Zone B captures `r_name != 'AMERICA'` as a simple filter, giving 4zone a partial anchor plain lacks.

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

---

## 7. Cross-Cutting Findings

### Finding 1: filter_drift is universal — no strategy consistently enforces pre-boundary corrections after compaction

`filter_drift` or `correction_ignored` appears in every strategy's failure categories across all three session types. The failure is not about which strategy you use — it is about whether the compression format encodes rules as constraints vs results.

| Strategy | DCS-001 | PTA-001 | IRC-001 | Mechanism |
|---|---|---|---|---|
| qwery-default/plain | 0/12 correct 5-LOW queries | partial | 0.6/5 filterPersistence | Rules embedded in prose — reproduced when user re-invokes them, not proactively |
| headroom/plain | 2/14 correct | entity_confusion | 0.8/5 | Rules in hash-retrieved chunks — not visible unless chunk is retrieved |
| recomp-extractive/plain | 0/11 correct | thread_bleed | **0/5** | Rules stripped by extraction — only results survive |
| qwery-default/4zone | 3/13 correct | best overall | 1.8/5 | Zone B gives partial anchor; narrative still needed for semantic proxies |

### Finding 2: The filterPersistenceRate inline metric is a weak signal at best, misleading at worst

Inline filterPersistenceRate counts whether correction keywords appear in agent responses/SQL — not whether the correct SQL semantics are applied. Across sessions:

| Session | Inline rate range | Gemini filterPersistence avg (max=5) | Gap |
|---|---|---|---|
| DCS-001 | 29–50% | ~2.8/5 for qwery-default | Moderate |
| PTA-001 | 68–93% | 0–3.6/5 depending on strategy | Large |
| IRC-001 | 70–81% | **0.0–1.8/5** across all strategies | **Extreme** |

IRC is the worst case because the legacy cohort correction ("signed up before 1994") requires a proxy implementation that produces result values and table names, giving the inline metric a false positive even when the SQL is semantically wrong. The Gemini judge, having access to the full original conversation (1M context window), correctly identifies when the proxy is wrong.

### Finding 3: 4zone interaction effects are strategy- and session-type-dependent, driven by which zone carries the primary analytical load

| Strategy | DCS-001 (4zone vs plain) | PTA-001 (4zone vs plain) | IRC-001 (4zone vs plain) | SNCJ-001 (4zone vs plain) |
|---|---|---|---|---|
| qwery-default | 7.87 → 6.00 **(hurt)** | 8.46 → **9.63 (help)** | 3.75 → 4.45 (mild help) | 8.49 → 8.39 **(neutral)** |
| headroom | — | 7.39 → **1.27 (catastrophic)** | 3.45 → 5.50 (help) | 6.29 → **8.83 (best in series)** |
| recomp-extractive | — | 4.31 → 4.62 (neutral) | 2.00 → 4.45 (help) | 7.29 → 7.88 (moderate help) |
| llmlingua-2 | — | — | — | 5.54 → 6.29 (help) |

The zone that carries the primary load determines the outcome:
- **DCS/IRC**: Zone D (LLM narrative) does the heavy lifting. qwery-default's plain narrative is strong; Zone B noise subtracts from it. 4zone hurts qwery-default on DCS.
- **PTA**: Zone D must preserve thread labels. headroom's hash-chunked format loses them at the first compaction; Zone D then accumulates to 209,899 tokens across 19 further events, making recovery impossible.
- **SNCJ**: Zone A (schema) is the decisive zone. 4zone makes headroom the best performer because Zone A answers schema recall questions directly, making Zone D compression irrelevant.

The implication: **the 4zone architecture is most beneficial when Zone A schema context is the primary gap in plain mode** (schema-heavy sessions like SNCJ), and least beneficial (or harmful) when the gap is in narrative structure that Zone B cannot encode (semantic corrections like the IRC legacy cohort proxy).

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

IRC improves because headroom barely fires real events — Zone D barely changes. SNCJ fires 14 real events and Zone D grows 15×, yet scores 8.83 because Zone A holds the schema that SNCJ needs. PTA fires 20 real events and Zone D grows 54×, but the agent was already thread-confused from the first event — the accumulation makes recovery impossible rather than causing the initial failure.

**The 1.27 is headroom's thread-unaware format colliding with PTA's thread-isolation requirement, amplified by Zone D accumulation.** It is not a general headroom/4zone architecture failure: headroom/4zone delivers 5.50 on IRC and 8.83 on SNCJ.

### Finding 6: Zone B captures syntactic filters, not semantic corrections

Zone B is populated from SQL `WHERE` clause extraction. The fundamental limitation:

**Captured correctly**: Direct column predicates (`r_name != 'AMERICA'`, `o_orderpriority != '5-LOW'`) — these appear verbatim in WHERE clauses.

**Not captured**: `HAVING` aggregation conditions, CTE definitions, corrections stated in natural language without SQL correspondence ("use customer region not supplier region"), and any correction whose SQL implementation is assembled across multiple turns with varying column names.

This means Zone B is most useful for DCS-type sessions (simple column exclusion rules) and least useful for IRC-type sessions (semantic proxies via complex CTEs). The Zone B advantage on filterPersistenceRate is real but bounded.

### Finding 7: Zone B false positives actively degrade quality on IRC

On IRC, Zone B accumulates false positives from unrelated SQL operations: `table_name = 'customer'` (from `information_schema` schema inspection queries), `c_mktsegment = 'BUILDING'` (from a casual browsing query in turns 1–10). These appear in Zone B as active constraints and the post-compaction agent applies them, generating wrong SQL.

On DCS and PTA, this effect was less pronounced because the fewer corrections mean less noise relative to signal. IRC's 4 pre-boundary corrections with complex interactions make Zone B noise relatively more damaging.

### Finding 8: Row-count consistency (queryConsistencyRate) measures structural SQL reproducibility, not quality

Across all sessions, queryConsistencyRate is uniformly low — typically 0–33% — except for two outliers:

| Exception | Rate | Explanation |
|---|---|---|
| qwery-default/plain DCS-001 | **100%** | Simple 2-table aggregation queries with explicit filter values in the summary; the agent reproduces them exactly |
| recomp/4zone PTA-001 | **57.1%** | Zone A schema context anchors SQL structure; agent writes consistent table/column references even without narrative context |

The low baseline reflects that complex multi-join queries with CTEs (IRC) and cross-thread SQL (PTA) are structurally non-deterministic — a cold-start agent reconstructing from compressed context writes semantically equivalent but structurally different SQL. This is an LLM property, not a compression failure.

### Finding 9: llmlingua-2 queryConsistencyRate is an evaluation artefact

llmlingua-2 (tested on DCS-001 only) produces a 91-character log header as "summary":

```
[llmlingua-2] compressed parts — tokens 4657 → 3858
```

`verify:consistency` uses this as the re-run context. The agent has no analytical context at all — its 22% row-count "match" is pure coincidence from queries whose result is easy to guess from schema alone. The 6.30 Gemini score reflects the judge's evaluation of what it can infer, not what was preserved. llmlingua-2 requires a dedicated evaluation path that re-injects the compressed context (not the log metadata) before comparison is meaningful.

llmlingua-2 is also disqualified by its 23.5% compaction overhead (~267 seconds per compaction on this hardware), making it impractical for interactive sessions regardless of quality.

---

## 8. Zone B Architecture Assessment

Zone B was designed to track structured entity state (active filters, corrections, open threads) as enforced context for the post-compaction agent. After three session types:

**Zone B's contribution is real but partial:**

- DCS-001: Zone B stores `o_orderpriority != '5-LOW'` correctly → live filterPersistenceRate 44% vs 29% plain. The live agent uses it.
- PTA-001: Zone B captures SQL filter snapshots but not thread labels → improvement on filter anchoring, no improvement on thread isolation.
- IRC-001: Zone B captures `r_name != 'AMERICA'` → partial improvement. Misses legacy cohort → the correction that matters most.

**The unresolved gap**: Zone B stores what the agent *did*, not what it *should do*. A filter applied in turn 5 to a specific query is stored as an active filter — but the agent treats it as informational context, not a constraint to enforce on all future queries. The gap between "agent reads Zone B" and "agent enforces Zone B" is the primary open problem.

**The false positive problem**: Zone B's regex-based SQL extraction creates noise from `information_schema` queries, `HAVING` clause misclassification, and CTE join conditions being parsed as table names. This noise grows as the session length increases and the query variety increases.

---

## 9. Strategy Ranking by Session Type

### Best strategy per session (plain mode, by Gemini score)

| Session | Best | Score | Runner-up | Score |
|---|---|---|---|---|
| DCS-001 | qwery-default | **7.87** | headroom | 6.88 |
| PTA-001 | qwery-default | **8.46** | headroom | 7.39 |
| IRC-001 | qwery-default | **3.75** | headroom | 3.45 |
| SNCJ-001 | qwery-default | **8.49** | recomp-extractive | 7.29 |

qwery-default/plain is the best plain strategy on every session type. The LLM narrative format is resilient: it degrades on IRC but remains ahead of alternatives. headroom/plain is never the best (penalized by hash-chunking losing entity continuity) and has catastrophic overhead on SNCJ.

### 4zone mode impact by strategy

| Strategy | DCS | PTA | IRC | SNCJ | Pattern |
|---|---|---|---|---|---|
| qwery-default | −1.87 | +1.17 | +0.70 | −0.10 | Helps when plain is weak; neutral/hurt when plain is strong |
| headroom | — | −6.12 (catastrophic) | +2.05 | +2.54 | Zone A determines outcome: rescues on schema sessions, collapses on narrative sessions |
| recomp-extractive | — | +0.31 | +2.45 | +0.59 | Consistent modest benefit — Zone A/B fill recomp's narrative gap |
| llmlingua-2 | — | — | — | +0.75 | Zone A compensates for lossy compression on schema-heavy content |

**headroom has the widest variance** (−6.12 to +2.54) — it is simultaneously the worst possible choice (PTA/4zone) and the best-performing combination in the series (SNCJ/4zone). The session type determines which.

---

## 10. Open Questions

1. **Zone B constraint enforcement**: Zone B is read as informational context. A system prompt directive ("apply all `activeFilters` to every `runQuery` call") could change this. Whether that directive causes its own side effects (over-filtering) is untested.

2. **Zone B HAVING/CTE support**: The legacy cohort failure on IRC is a clear gap. Extending `EntityStateTracker.extractFromToolCalls()` to parse `HAVING` conditions and CTE definitions would directly address the most common IRC failure mode.

3. **headroom/4zone on DCS-001**: The only missing headroom/4zone result. DCS has a deterministic single-event boundary — headroom/4zone may fire 0 or 1 events, eliminating the frequency problem entirely. Would confirm whether the PTA catastrophe is purely a frequency artifact.

4. **Cross-database generalizability**: All sessions above are TPC-H. The saas database (SaaS analytics schema) tests whether findings hold on a different schema structure. saas-dcs-001 results are available for llmlingua-2 and baseline; other strategies not yet run.

5. **RCI session type**: tpch-rci-001 (Reference Chain with Indirect corrections) has qwery-default/plain results but no verify and no 4zone runs. Expected difficulty level: between IRC and PTA.

6. **Zone A quantified contribution**: SNCJ shows Zone A is decisive for schema recall. Ablating Zone A from 4zone on SNCJ would directly measure the schema-recall contribution vs Zone B/D. Currently inferred from schemaGrounding dimension scores.

7. **headroom/plain overhead on SNCJ (184%)**: This is an anomaly worth diagnosing — is the headroom proxy doing something unexpected with schema-heavy content, or is this specific to the SNCJ session structure?
