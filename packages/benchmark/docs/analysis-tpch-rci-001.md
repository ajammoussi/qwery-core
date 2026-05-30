# Preliminary Analysis — tpch-rci-001 (RCI: Reference Chain with Indirect Corrections)

> Status: **COMPLETE** — all 8 strategy/mode combinations run and verified

## 1. What We're Comparing

**Session**: `tpch-rci-001`
**Type**: RCI — Reference Chain with Indirect Corrections (single analytical thread, corrections applied as procedural rules, callback references across compression boundary)
**Database**: TPC-H
**Turns**: 42 | **Compression boundary**: turn 14
**persistedCorrections**: 3

| Turn | Correction | Mechanism |
|---|---|---|
| 4  | Only completed orders (`O_ORDERSTATUS = 'O'`), exclude `'F'` and `'P'` | Filter rule |
| 9  | Always use `O_ORDERDATE` for date filtering, not other date columns | Column precision |
| 19 | Exclude AMERICA region from all analyses | Exclusion filter |

> Corrections at turns 4 and 9 are **pre-boundary** (turn 14). Turn 19 is **post-boundary** — it appears in Zone C's active window for plain strategies but may be compressed by 4zone's token-overflow.

**Key failure mode**: `callback_miss` / `correction_ignored` — the user repeatedly references earlier analytical results ("the weekly order volume we looked at earlier", "the same filters we've established"). The agent must both preserve correction rules and recall the analytical context those rules were applied to. RCI tests whether compaction preserves a re-usable reference context, not just individual filter rules.

---

## 2. What Compaction Produces

All plain-mode strategies triggered compaction at **turn 14**. In 4zone mode: qwery-default fires once at turn 14; headroom fires once; recomp fires 8 times (turns 14–29); llmlingua-2 fires once.

### qwery-default / plain — Zone D summary (LLM narrative)

```
From data/results/qwery-default/plain/tpch/rci/tpch-rci-001.json
→ turns[13].compactionEvent.summaryText

**Summary of Revenue Investigation Work**

**Initial Request:** Investigate an 18% revenue drop from Q2 to Q3 1995.

**What Has Been Done:**

1. **Verified Revenue Numbers:** Initial analysis revealed the reported 18% drop was inaccurate.
Using the `orders` table with `o_orderdate`, the actual Q2 vs ...
```

Observation: qwery-default's narrative captures the revenue investigation as a unified story. The filter rule (`o_orderstatus = 'O'`) is mentioned in prose but not formatted as an explicit constraint. The callback reference context ("the weekly order volume") is embedded in the narrative flow — the agent reads this and reconstructs the analytical sequence.

### headroom / plain — proxy-compressed summary

```
From data/results/headroom/plain/tpch/rci/tpch-rci-001.json
→ turns[13].compactionEvent.summaryText

[assistant]
I'll help you investigate the revenue drop. Let me first explore the schema to understand
the available data, then analyze Q2 vs Q3 1995 revenue.
Interesting - the orders table shows only a ~0.8% drop. Let me check the lineitem table
for actual revenue (extended price minus discounts), which is more accurate:
The lineitem shows Q3 > Q2 (by shipped items). Let me check by order date ins...
```

Observation: headroom's hash-chunked summary preserves the early analytical exploration flow. Filter rules (`O_ORDERSTATUS = 'O'` from turn 4) are absent from the visible portion — they survive only if the agent retrieves the relevant chunks. The callback references ("the weekly order volume") have no structured representation.

### recomp-extractive / plain — extractive snippets

```
From data/results/recomp-extractive/plain/tpch/rci/tpch-rci-001.json
→ turns[13].compactionEvent.summaryText

**Top Suppliers with Declining Revenue: Q2 → Q3 (Germany orders)** - **Supplier#000000006**
and **Supplier#000000031** had $0 revenue in Q3 — completely dropped off for Germany -
This is a supply-side issue rather than product/market shift — these specific suppliers
are underperforming ...
```

Observation: recomp extracts a specific analytical finding (Germany supplier drop) from deep in the conversation. The filter rules and callback references are absent. The surviving content is a fragment of one thread, not the full analytical context.

### Zone B entity state (4zone mode)

For RCI, Zone B's `activeFilters` captures date range filters and the `o_orderstatus = 'O'` correction from SQL WHERE clauses. The AMERICA exclusion (turn 19, post-boundary) is also captured when the agent writes the corresponding SQL. `activeTables` arrays are noisy from NLP parsing — words like "the", "Q2", "this", "now" appear as table names.

```
From data/results/qwery-default/4zone/tpch/rci/tpch-rci-001.json
→ turns[41].zonesSnapshot.entityState.segments[0].content (final turn)

{
  "activeTables": [
    "the", "Q2", "this", "orders", "lineitem",
    "o_orderdate", "now", "just", "customer", ...
    "AUTOMOBILE", "part_revenue", "Q1",
    "germany_loss_suppliers", "weekly_data", ...
  ],
  "activeFilters": [
    { "column": "o_orderdate",  "op": ">=", "value": "1995-01-01" },
    { "column": "o_orderdate",  "op": "<",  "value": "1995-07-01" },
    { "column": "o_orderstatus", "op": "=",  "value": "O" },
    ...
  ]
}
```

**Key observation**: Zone B captures `o_orderstatus = 'O'` (turn 4 correction) correctly as an active filter. The `O_ORDERDATE` column preference (turn 9) does not appear as a filter — it is a column usage rule, not a WHERE clause predicate, so Zone B's SQL-scanner never captures it. Zone B provides a partial anchor for the simplest correction but misses the column precision rule entirely.

---

## 3. Inline Metrics (live session)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| compressionRatio | 0.103 | 0.076 | 0.125 | 0.336* | 0.003 | 0.020 | 0.233 | 0.020 |
| filterPersistenceRate | 95.2% | **98.8%** | 96.4% | 95.2% | 95.2% | 95.2% | 97.6% | 95.2% |
| compactionOverheadPct | 1.87% | 4.35% | 31.91% | 0.53% | 0.40% | 15.13% | 19.00% | 0.29% |
| compactionEvents | 1 | 1 | 1 | 1 | 1 | **8** | 1 | 1 |
| errors | 20 | 16 | 12 | 17 | 10 | 23 | 13 | 17 |

> *headroom/4zone compressionRatio=0.336 is not directly comparable to single-event strategies.
> All strategies show high error counts — RCI's 42-turn session with repeated callback references is the longest in the series, producing more tool retries regardless of compression strategy.

---

## 4. Post-Processing Metrics (Gemini judge + row-count consistency)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| Gemini score (0–10) | 5.26 | 5.48 | 3.79 | **8.40** | 4.24 | 5.75 | 2.00 | 6.46 |
| filterPersistence (avg/5) | 0.80 | 0.80 | 0.40 | **4.60** | 0.60 | 1.60 | 1.00 | 1.50 |
| entityContinuity (avg/5) | 3.00 | 2.80 | 2.80 | 3.40 | 2.80 | 3.40 | 1.00 | **3.50** |
| correctionPersistence (avg/5) | 1.80 | 1.80 | 2.00 | **4.40** | 0.80 | 1.80 | 1.00 | 2.50 |
| analyticalThread (avg/5) | 2.80 | 3.00 | 2.40 | 3.40 | **4.20** | 3.20 | 1.00 | 3.50 |
| callbackResolution (avg/5) | 4.60 | **5.00** | 2.20 | **5.00** | 2.00 | 4.20 | 1.00 | **5.00** |
| queryConsistencyRate | — | — | — | — | — | — | — | — |
| Dominant failures | filter_drift, correction_ignored, entity_confusion, callback_miss | filter_drift, entity_confusion, correction_ignored | filter_drift, entity_confusion, correction_ignored, callback_miss | filter_drift, entity_confusion, correction_ignored | filter_drift, entity_confusion, correction_ignored, callback_miss | filter_drift, entity_confusion, correction_ignored, baseline_loss, callback_miss | filter_drift, entity_confusion, correction_ignored, callback_miss | filter_drift, entity_confusion, correction_ignored |

> queryConsistencyRate was not computed for RCI (the dimension was added after these verifies ran). The row-count consistency signal is captured indirectly through callbackResolution, which measures whether the agent reconstructs queries with the same intent.

---

## 5. Findings

1. **callbackResolution is the distinctive RCI dimension — and 4zone dominates it.** qwery-default/4zone, headroom/4zone, and llmlingua-2/4zone all achieve 5.0/5 callbackResolution. Zone B's activeFilters store `o_orderstatus = 'O'` as a persistent constraint, giving the 4zone agent a structural anchor for callback references like "apply the same filters we've established." In plain mode, only qwery-default/plain scores well (4.6) — its narrative summary preserves the analytical sequence, enabling the agent to reconstruct callback intent even without structured filter storage.

2. **headroom/4zone scores 8.40 — the best overall — driven by filterPersistence (4.6) and correctionPersistence (4.4).** This is consistent with the SNCJ and saas-PTA pattern: headroom/4zone performs well when Zone A or Zone B can compensate for headroom's hash-chunked narrative format. On RCI, Zone B captures the `o_orderstatus = 'O'` filter directly, and headroom's single compaction event (unlike PTA's 20) limits Zone D accumulation. The callbackResolution=5.0 confirms that Zone B's filter storage is the mechanism — the agent can answer "what filters are we applying" correctly.

3. **headroom/plain scores 3.79 vs headroom/4zone 8.40 — the widest 4zone gap in the RCI series (+4.61).** On PTA, headroom/4zone collapsed (1.27 vs 7.39 plain). On RCI, the direction reverses: 4zone rescues headroom. The difference is that RCI's callbackResolution and filterPersistence dimensions are directly served by Zone B's `activeFilters`. PTA required narrative thread labels that Zone B cannot encode. RCI's challenges are filter-oriented — exactly what Zone B addresses.

4. **llmlingua-2/plain scores 2.00 — the lowest in the RCI series — with every dimension at exactly 1.0/5.** The 45-character summary is a log header (`[llmlingua-2] compressed parts — tool:27 llm:54 user:0`). The cold-start agent has no analytical context at all. llmlingua-2/4zone recovers to 6.46 — Zone B provides the filter anchor that plain completely lacks, and Zone A provides schema context. The 4.46-point gap between llmlingua-2 plain and 4zone is the largest of any session type, confirming that llmlingua-2's degradation is near-total in plain mode.

5. **recomp/4zone fires 8 compaction events — the most of any RCI strategy — and still scores only 5.75.** Each event re-compresses a growing Zone D, and the extractive format accumulates fragmented snippets rather than a unified reference context. Gemini notes `callback_miss` in the failure categories for recomp/4zone alongside recomp/plain — the extractive format cannot structure callback references regardless of firing frequency.

6. **4zone mode lifts every strategy on RCI (average +1.94 points).** Unlike DCS where 4zone sometimes hurt (qwery-default: −1.87), and unlike IRC where 4zone was mildly helpful (+0.7–2.45), RCI shows a consistent 4zone benefit across all four strategies. RCI's corrections are filter-oriented (`o_orderstatus`, `r_name`) and column-preference-oriented (`O_ORDERDATE`) — Zone B captures the filters and Zone A stores schema column context. Every 4zone strategy gets a measurable lift from the structured zones.

7. **Inline filterPersistenceRate (95–99%) is meaningless for RCI.** The inline metric is consistently above 95% across all 8 strategies — but Gemini filterPersistence ranges from 0.40 to 4.60. RCI's 42-turn length means the simple keyword-matching metric saturates: nearly every turn contains some SQL with the correction-adjacent keywords. The gap between inline and Gemini-measured filterPersistence is larger on RCI than any other session type.
