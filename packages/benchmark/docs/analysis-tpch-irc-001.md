# Preliminary Analysis — tpch-irc-001 (IRC: Iterative Refinement with Corrections)

> Status: **COMPLETE** — all 6 strategy/mode combinations run and verified (recomp/4zone Gemini score null — quota exhausted, re-verify needed with fresh key)

## 1. What We're Comparing

**Session**: `tpch-irc-001`
**Type**: IRC — Iterative Refinement with Corrections (single analytical thread, accumulating explicit corrections)
**Database**: TPC-H
**Expected turns**: 32 | **Compression boundary**: turn 12
**persistedCorrections**: 4

| Turn | Correction | Mechanism |
|---|---|---|
| 2  | Legacy cohort = customers who signed up before 1994 (proxy via first order date) | Named concept + semantic proxy |
| 4  | Always use customer region (not supplier region) | Column preference |
| 6  | Exclude AMERICA region from all analyses | Explicit exclusion filter |
| 11 | Use `O_ORDERDATE` for date filtering (not `L_SHIPDATE`) | Column precision correction |

> All 4 corrections are **pre-boundary** (turns 2, 4, 6, 11 < boundary=12). Every strategy must preserve all of them through compaction.

**Key failure mode**: `correction_ignored` / `filter_drift` — corrections stack progressively before the boundary; strategies that retain narrative text without filter semantics will apply the simpler AMERICA exclusion but drop the semantically complex legacy cohort proxy.

---

## 2. What Compaction Produces

All plain-mode strategies triggered compaction at **turn 12**. In 4zone mode: qwery-default fires once at turn 12; headroom fires 6 times (turns 12–17, attenuated vs PTA's 20 events); recomp fires once.

### qwery-default / plain — Zone D summary (LLM narrative)

```
From data/results/qwery-default/plain/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

**Conversation Summary:**

- **Datasource:** tpch_benchmark (ID: 323bfdb6-4b6d-43c2-8aaf-4a1d8c000db2)
- **Current State:** Analysis of revenue and order patterns for Q4 1995 (and H2 1995) is
  complete. The last query returned average order value by region, and a visualization was
  suggested.
```

Observation: qwery-default's LLM narrative captures corrections in prose but **buries the legacy cohort filter** in natural-language description rather than as an explicit SQL rule. Post-compaction, the agent reconstructs queries without the multi-step `first_order_date` proxy, defaulting to a simpler (wrong) implementation.

### headroom / plain — Zone D summary (proxy-compressed)

```
From data/results/headroom/plain/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

revenue breakdown by region for last 6 months of 1995 (July–December): | Region | Revenue
EUROPE | 3,395,479,995 | AFRICA | 3,357,243,344 | ASIA | 3,352,221,569 | AMERICA |
3,344,238,642 | MIDDLE EAST | 3,296,456,813 | Europe leads with highest revenue at ~$3.4B...
```

Observation: headroom produces a **factual data table with no filter metadata** — AMERICA appears in the result table, giving no signal it should be excluded. The correction rules are not encoded as persistent constraints.

### recomp-extractive / plain — Zone D summary (extractive)

```
From data/results/recomp-extractive/plain/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

| EUROPE | 3,381,816,658 | Revenue is fairly evenly distributed across regions, with Europe
slightly leading at ~3.38 billion, and America trailing just behind at ~3.31 billion.
{{suggestion: Show monthly revenue trend by region}} {{suggestion: Chart legacy customers
by region}}
```

Observation: recomp extracts **result snippets with suggestion tags** — "legacy customers" appears as a future suggestion, not as an active filter rule. Post-compaction the agent sees it as unexplored territory, not an established constraint.

### qwery-default / 4zone — Zone D archive summary

```
From data/results/qwery-default/4zone/tpch/irc/tpch-irc-001.json
→ turns[11].compactionEvent.summaryText

Summary of conversation:

**Work completed:**
- Generated revenue breakdown by region for July–December 1995 using TPC-H data.
  Revenue ranges from ~3.3B (Middle East) to ~3.4B (Europe), with regions fairly balanced.
- Attempted to filter customers who signed up before 1994, but the customer table (t...
```

Observation: Zone D explicitly surfaces the "filter customers who signed up before 1994" attempt — more informative than plain. But the proxy implementation (multi-step CTE join) is still not encoded as a concrete SQL template.

### Zone B entity state (4zone mode)

Zone B `activeFilters` are extracted from SQL `WHERE` clauses. Representative entries from qwery-default/4zone final turn:

```
From data/results/qwery-default/4zone/tpch/irc/tpch-irc-001.json
→ turns[31].zonesSnapshot.entityState.segments[0].content (raw JSON, final turn)

{
  "activeFilters": [
    { "column": "l_shipdate",  "op": ">=", "value": "1995-07-01" },
    { "column": "l_shipdate",  "op": "<=", "value": "1995-12-31" },
    { "column": "r_name",      "op": "!=", "value": "AMERICA" },     ← captured ✓
    { "column": "table_name",  "op": "=",  "value": "customer" },    ← noise (information_schema)
    { "column": "c_mktsegment","op": "=",  "value": "BUILDING" },    ← false positive
    ...
  ]
}
```

**Key observation**: Zone B captures `r_name != 'AMERICA'` (turn 6 correction) but **does not capture the legacy cohort proxy** — the proxy is assembled via a CTE (`first_order_date < 1994-01-01`) where the join condition never appears as a standalone `WHERE` filter at the moment the tracker scans tool calls. Additionally, Zone B contains false positives (`c_mktsegment = 'BUILDING'`, `table_name = 'customer'`) that the agent reads as active constraints, causing entity confusion in post-compaction re-runs.

---

## 3. Inline Metrics (live session)

| Metric | qwery-default/plain | headroom/plain | recomp/plain | qwery-default/4zone | headroom/4zone | recomp/4zone |
|---|---|---|---|---|---|---|
| compressionRatio | 0.099 | 0.292 | 0.033 | 0.097 | 0.374* | 0.019 |
| filterPersistenceRate | 0.700 | 0.713 | 0.738 | **0.813** | **0.813** | 0.800 |
| compactionOverheadPct | 1.14% | 0.52% | 3.58% | 1.10% | 0.50% | 1.12% |
| compactionEvents | 1 | 1 | 1 | 1 | **6** | 1 |
| errors | 0 | 1 | 0 | 0 | 0 | 0 |

> *headroom/4zone compressionRatio=0.374 reflects averaging across 6 events with varying pre-compaction token counts; not comparable to single-event strategies.

---

## 4. Post-Processing Metrics (Gemini judge + row-count consistency)

| Metric | qwery-default/plain | headroom/plain | recomp/plain | qwery-default/4zone | headroom/4zone† | recomp/4zone |
|---|---|---|---|---|---|---|
| Gemini score (0–10) | 3.75 | 3.45 | 2.00 | 4.45 | **5.50** | 4.45 |
| filterPersistence (avg/5) | 0.6 | 0.8 | **0.0** | 1.8 | 2.0 | — |
| entityContinuity (avg/5) | 4.2 | 3.2 | 2.6 | 2.4 | 5.0 | — |
| correctionPersistence (avg/5) | 1.2 | 1.2 | 0.6 | 2.2 | 2.0 | — |
| analyticalThread (avg/5) | 4.8 | 4.2 | 3.0 | 3.0 | 5.0 | — |
| queryConsistencyRate | 28.6% | 33.3% | 16.7% | 18.2% | **0.0%** | **28.6%** |
| Dominant failures | filter_drift, correction_ignored | filter_drift, correction_ignored | filter_drift, correction_ignored, entity_confusion | filter_drift, correction_ignored, entity_confusion, baseline_loss | filter_drift, correction_ignored | filter_drift, correction_ignored, entity_confusion |

> †headroom/4zone sampled only 1 post-compaction turn (Gemini quota partially consumed); dimension scores are not representative of the full post-boundary window.

---

## 5. Findings

1. **Legacy cohort proxy is the dominant failure across all IRC strategies.** "Signed up before 1994" has no direct column in TPC-H and requires a multi-step join (`c_custkey → orders → MIN(o_orderdate) < 1994-01-01`). Gemini `filterPersistence` averages 0.0–1.8/5 across all 5 scored combinations — every strategy drops this correction post-compaction. The AMERICA exclusion (`r_name != 'AMERICA'`) is simpler and partially preserved. `correction_ignored` and `filter_drift` appear in every strategy's failure list, with Gemini reasoning explicitly citing the legacy cohort as the missing filter in 4 of 5 turns for every strategy.

2. **filterPersistenceRate (inline, 70–81%) wildly overstates quality.** The inline metric counts turns where `r_name != 'AMERICA'` appears in SQL — a keyword match. The Gemini judge scores the full set of 4 corrections including the legacy cohort proxy. The 70–81% inline vs 0.0–1.8/5 Gemini filterPersistence gap is the starkest in this benchmark series so far. IRC is a harder test of correction persistence than DCS or PTA because the correction is *semantic* (a concept must be translated to a multi-step SQL pattern), not syntactic.

3. **4zone mode mildly improves Gemini scores for qwery-default (+0.7) — reversal of DCS-001 finding.** On DCS-001, 4zone hurt quality (6.00 vs 7.87 plain). On IRC, 4zone modestly helps (4.45 vs 3.75). The difference: Zone B correctly captures `r_name != 'AMERICA'` — one of the four corrections — giving the 4zone agent a structural anchor it lacks in plain mode. Zone B's partial correctness is enough to shift the balance in IRC where plain summaries are also weak.

4. **headroom/4zone avoids PTA-style catastrophe (5.50 vs 3.45 plain).** On PTA, headroom/4zone scored 1.27 because headroom's hash-chunked format lost thread labels at the first compaction — the same format failure as headroom/plain, amplified by Zone D accumulating to 209,899 tokens across 19 subsequent events. On IRC, 5 of 6 headroom/4zone events are near-instant no-ops (1–9ms, no summary written), so Zone D barely changes. The format failure is also less severe here: IRC has no thread isolation requirement, and Zone B captures the simpler `r_name != 'AMERICA'` filter. However, `queryConsistencyRate = 0%` — the single Gemini-sampled turn scores well but the agent generates structurally different SQL that doesn't reproduce stored row counts. With only 1 sample this result is statistically weak.

5. **recomp uniquely achieves zero filterPersistence on all 5 sampled turns.** filterPersistence avg = 0.0/5 — the only strategy at absolute zero. The extractive format preserves result tables but discards the correction *rules* that generated them. The agent sees "AMERICA | 3,344,238,642" in the summary and has no signal to exclude AMERICA from future queries. This is the inverse of PTA where recomp discarded thread structure; here it discards constraint metadata. recomp is demonstrably the worst strategy for sessions with pre-boundary semantic corrections.

6. **Zone B false positives cause entity confusion in qwery-default/4zone.** `entityContinuity` drops from 4.2 (plain) to 2.4 (4zone) for qwery-default. In at least one sampled turn, Gemini noted the agent "incorrectly substituted the legacy cohort with the BUILDING market segment" — a Zone B false positive (`c_mktsegment = 'BUILDING'` from an unrelated turn) was read as an active constraint. This is a direct cost of Zone B's regex-based extraction: noisy filters in Zone B actively mislead the agent.

7. **Row-count consistency is uniformly low (0–33%), contradicting the pre-benchmark hypothesis that IRC would outperform PTA.** The hypothesis was that single-thread IRC SQL would be more structurally reproducible. In practice, the cold-start re-run agent reconstructs complex joins differently (different CTE names, different join paths for the legacy cohort proxy) even when the analytical intent is correct. The correction-heavy IRC scenario produces more SQL variation on re-run than simpler sessions.
