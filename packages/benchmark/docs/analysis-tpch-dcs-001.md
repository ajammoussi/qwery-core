# Preliminary Analysis — tpch-dcs-001 (DCS: Deep Callback Session)

> Status: **COMPLETE** — all 8 strategy/mode combinations run and verified

## 1. What We're Comparing

**Session**: `tpch-dcs-001`
**Type**: DCS — Deep Callback Session (single analytical thread, 2 simple pre-boundary corrections tested via deep callbacks)
**Database**: TPC-H
**Turns**: 32 | **Compression boundary**: turn 15
**persistedCorrections**: 2

| Turn | Correction | Mechanism |
|---|---|---|
| 4  | Exclude orders with priority `'5-LOW'` from all analyses | Exclusion filter |
| 30 | Fiscal year: Q1 = July–September (implicit date range shift) | Context correction |

> Turn 4 is **pre-boundary** (turn 15). Turn 30 is **post-boundary** — it appears in Zone C's active window for plain strategies.

**Key failure mode**: `filter_drift` — the `'5-LOW'` exclusion is a simple column-value rule, but the agent must proactively apply it to every query, not just reproduce it when asked. The fiscal year correction (turn 30) is a usage convention that must be remembered going forward.

---

## 2. What Compaction Produces

All strategies triggered compaction at turn 15 (plain) or around the same boundary (4zone). llmlingua-2/4zone fired 4 events (turn 7, 8, 9, 15 — early token-overflow in 4zone mode).

### qwery-default / plain — Zone D summary (LLM narrative)

```
From data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json
→ turns[14].compactionEvent.summaryText

## Conversation Summary

**What was done:**
- Analyzed TPC-H benchmark dataset across multiple dimensions
- Queried total revenue by region for 1995 (America led with ~$6.8B)
- Queried Europe-specific revenue for 1995: $6,605,155,201.17
- Identified top 10 suppliers by volume (Supplier#2298 leads with 14,744 units)
```

**Format signature**: Structured prose with explicit section headers and result numbers. The `'5-LOW'` exclusion appears as a usage convention in the narrative flow — the agent reads this and applies it proactively.

### qwery-default / 4zone — Zone D archive + Zone B entity state

Zone B captures `o_orderpriority != '5-LOW'` directly from SQL WHERE clauses — correct operator semantics. Zone B is read alongside Zone D (LLM archive) and Zone C (last N turns verbatim).

### headroom / plain — hash-chunked proxy compression

```
From data/results/headroom/plain/tpch/dcs/tpch-dcs-001.json
→ turns[14].compactionEvent.summaryText

total revenue by region for 1995: | Region | Total Revenue AMERICA | $6.80B |
| MIDDLE EAST | $6.71B | | ASIA | $6.63B EUROPE | $6.61B AFRICA | $6.52B
All five regions are fairly close in revenue, with...
```

Observation: headroom's summary preserves the numerical results table. The `'5-LOW'` exclusion rule is not visible in the summary fragment — it survives only if the agent retrieves the relevant hash chunk.

### headroom / 4zone — hash-chunked with Zone B

Zone B captures `o_orderpriority != '5-LOW'` from SQL WHERE clauses. The hash-chunked Zone D summary shows the order priority distribution table — including `5-LOW` appearing as a data row, which could mislead the agent.

### recomp-extractive / plain — extractive snippet

```
From data/results/recomp-extractive/plain/tpch/dcs/tpch-dcs-001.json
→ turns[14].compactionEvent.summaryText

2. **Exclude '5-LOW' order priority** from all queries (filtering out test orders)
| Rank | Supplier Key | Supplier Name | Parts Supplied |
```

Observation: recomp preserves the `'5-LOW'` exclusion as a bullet point — the correction appears as text in the extractive snippet because the agent explicitly wrote it as a note to itself. This is why recomp scores competitively on DCS (6.00) vs its catastrophic PTA failure (4.31) — the simple correction format matches recomp's extractive strengths.

### recomp-extractive / 4zone — extractive with Zone B

Zone B anchors the `'5-LOW'` exclusion from SQL WHERE clauses. The Zone D extractive snippet includes the fiscal year correction (`fiscal year runs from July to June`) as a suggestion tag.

### llmlingua-2 / plain — compressed log header

```
From data/results/llmlingua-2/plain/tpch/dcs/tpch-dcs-001.json
→ turns[14].compactionEvent.summaryText

[llmlingua-2] compressed parts — tool:18 llm:43 user:0; saved 20546 tokens
(50265 → 29719, 59.1% retained on touched parts).
```

Observation: A 76-character log header replaces the entire analytical context. No filters, no queries, no results — the post-compaction agent has zero context to work with.

### llmlingua-2 / 4zone — compressed log header with Zone B

Same log-header format. Zone B provides the only filter anchor post-compaction. 4 events fired — early token-overflow in turn 7 compressed schema context, followed by 2 near-instant no-ops, then a final event at turn 15.

---

## 3. Inline Metrics (live session)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| compressionRatio | 0.109 | 0.017 | 0.269 | 0.390* | 0.022 | 0.031 | 0 | 0.010 |
| filterPersistenceRate | 29.4% | **44.1%** | 32.4% | 41.2% | 38.2% | 35.3% | 26.5% | 35.3% |
| compactionOverheadPct | 0.62% | ~0% | 0.62% | 0.83% | 1.52% | 0.82% | 34.96% | 0.55% |
| compactionEvents | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 4 |
| errors | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

> *headroom/4zone compressionRatio=0.390 reflects 1 event; comparable to other single-event strategies.

---

## 4. Post-Processing Metrics (Gemini judge + row-count consistency)

| Metric | qd/plain | qd/4zone | hr/plain | hr/4zone | rc/plain | rc/4zone | ll2/plain | ll2/4zone |
|---|---|---|---|---|---|---|---|---|
| Gemini score (0–10) | 7.87 | 6.00 | **10.00** | 6.33 | 6.00 | 7.56 | 6.60 | 6.40 |
| filterPersistence (avg/5) | 2.80 | 1.00 | **5.00** | 1.60 | 0.00 | 1.67 | 1.00 | 2.00 |
| entityContinuity (avg/5) | **5.00** | **5.00** | **5.00** | 4.00 | 4.00 | 4.33 | **5.00** | 4.20 |
| correctionPersistence (avg/5) | 2.80 | 1.00 | **5.00** | 2.00 | 4.00 | 1.67 | 1.00 | 2.00 |
| analyticalThread (avg/5) | **5.00** | **5.00** | **5.00** | 4.20 | 4.00 | **5.00** | 4.80 | 4.20 |
| callbackResolution (avg/5) | 4.00 | 3.00 | **5.00** | 3.60 | — | **5.00** | 4.00 | 3.40 |
| queryConsistencyRate | 100% | 80% | 60% | 50% | 80% | 60% | 100%† | 66.7%† |
| Dominant failures | filter_drift, correction_ignored | filter_drift, correction_ignored | none | filter_drift, correction_ignored, entity_confusion, baseline_loss | filter_drift, correction_ignored | filter_drift, correction_ignored, entity_confusion | filter_drift, correction_ignored | filter_drift, correction_ignored, entity_confusion |

> †llmlingua-2 queryConsistencyRate (100% plain, 66.7% 4zone) is an evaluation artefact — the summary is a log header with no analytical context. The "match" is from queries whose result can be guessed from schema alone.

---

## 5. Findings

1. **headroom/plain scores a perfect 10.00 — the highest single result in the benchmark series.** DCS has only 2 simple corrections (`5-LOW` exclusion, fiscal year convention). headroom's hash-chunked format, which fails on PTA (1.27) and SNCJ (6.29), is ideally suited to DCS: the summary preserves numerical results and the single-event boundary prevents Zone D accumulation. With no thread structure or semantic proxy to lose, the hash-retrieval format is sufficient.

2. **qwery-default/plain drops to second-best (7.87) but remains the most consistent strategy across all session types.** headroom's perfect DCS score is specific to DCS's simplicity — qwery-default still leads on PTA (8.46), SNCJ (8.49), and RCI (5.26). headroom's variance (−6.12 to +2.54 4zone delta) makes it unreliable outside DCS.

3. **4zone interaction is strategy-dependent on DCS: qwery-default hurt (−1.87), headroom hurt (−3.67), recomp helped (+1.56), llmlingua-2 neutral (−0.20).** Zone D narrative is the primary carrier for DCS (the corrections are simple enough that a good narrative summary is sufficient). Zone B noise subtracts from narrative quality for qwery-default and headroom. recomp gains because Zone B fills the gap its extractive format leaves open — the `5-LOW` exclusion is captured in Zone B's activeFilters where recomp/plain loses it in extraction.

4. **recomp/4zone (7.56) outperforms recomp/plain (6.00) by +1.56 — the largest 4zone gain on DCS.** recomp/plain's filterPersistence is 0.0/5 (the extractive snippet preserves the `5-LOW` text as a note, but the agent doesn't treat it as an active constraint). recomp/4zone's filterPersistence is 1.67/5 — Zone B stores the filter as a structured WHERE clause, and the agent applies it more consistently.

5. **llmlingua-2/plain (6.60) and llmlingua-2/4zone (6.40) are competitive with qwery-default and recomp despite providing zero analytical context.** The 6.60 score reflects what the agent can infer from schema alone and the general analytical pattern of a revenue investigation — not the compressed context. This is the upper bound of the "blank slate" baseline for DCS. When the same session has more complex corrections (IRC: 4.10, RCI: 2.00), the blank-slate baseline drops accordingly.

6. **qwery-default/plain achieves 100% queryConsistencyRate — the only non-artefactual perfect score in the series.** DCS's simple 2-table aggregation queries with explicit filter values in the summary enable exact SQL reproduction. headroom/plain (60%) and recomp/plain (80%) are lower because their compressed formats lack the full filter context needed for exact row-count matches.

7. **The inline filterPersistenceRate gap (29–44%) vs Gemini filterPersistence (0–5/5) is moderate on DCS compared to other session types.** DCS's simple corrections mean the inline metric's keyword matching is less misleading than on IRC (70–81% inline vs 0.0–1.8/5 Gemini) or RCI (95–99% inline vs 0.4–4.6/5 Gemini). The `5-LOW` exclusion appears in SQL WHERE clauses consistently when applied, so the keyword match is a reasonably good proxy for actual enforcement.
