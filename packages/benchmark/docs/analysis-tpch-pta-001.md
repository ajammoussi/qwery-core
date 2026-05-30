# Preliminary Analysis — tpch-pta-001 (PTA: Parallel Thread Analysis)

> Status: **COMPLETE** — all 6 strategy/mode combinations run and verified

## 1. What We're Comparing

**Session**: `tpch-pta-001`
**Type**: PTA — Parallel Thread Analysis (two simultaneous analytical threads interleaved)
**Database**: TPC-H
**Expected turns**: 35 | **Compression boundary**: turn 15
**persistedCorrections**: 3

| Turn | Correction | Thread |
|---|---|---|
| 3  | Exclude `O_ORDERSTATUS = 'F'` from all order queries | A |
| 5  | Use `NATION` table for supplier location (not `REGION`) | B |
| 28 | Exclude ASIA region from Thread A analysis | A |

**Key failure mode**: `thread_bleed` — a correction established in Thread A (e.g., exclude status='F') must not contaminate Thread B SQL, and vice versa. The Gemini dimension `threadIsolation` measures this directly.

---

## 2. What Compaction Produces

Plain-mode strategies triggered compaction at **turn 15** (first turn past the boundary). In 4zone mode, qwery-default triggered at turn 18 — Zone B absorbs entity state incrementally, delaying the need for a full Zone D compaction.

### qwery-default / plain — Zone D summary (LLM narrative)

```
From data/results/qwery-default/plain/tpch/pta/tpch-pta-001.json
→ turns[14].compactionEvent.summaryText

## Internal Conversation Summary

### What Was Done

The conversation focused on analyzing TPC-H benchmark data with two primary analytical threads:

**Thread 1 - Orders Volume Trends by Month:**
- Queried orders aggregated by month from January 1992 to August 1998
- Found stable monthly volumes (~17,000-19,700 orders)
- Identified February dip pattern (shortest month effect)
- Peak: August 1996 (19,724 orders)
- Ran follow-up: 1995 by priority and month-over-month revenue changes

**Thread 2 - [supplier performance / nation-level analysis]**
...
```

Observation: qwery-default correctly **delineates both threads** in its narrative and labels them explicitly. This structural separation is what enables the agent to avoid thread_bleed post-compaction.

### headroom / plain — Zone D summary (proxy-compressed)

```
From data/results/headroom/plain/tpch/pta/tpch-pta-001.json
→ turns[14].compactionEvent.summaryText

(1992-1998)**
[200 items compressed to 1. Retrieve more: hash=146e404992c3f34e79d1fa7c]
**1995 Orders 12 1995 5 priority levels: 3,832 3,868
[271 items compressed to 9. Retrieve more: hash=45d77cff32a3ed15302d38ea]
I'll exclude orders with status 'F' from all future order analysis...
```

Observation: headroom produces **hash-referenced chunks** — the agent can retrieve full context on demand but does not get a structured thread-separated view by default. The filter correction (exclude status='F') is visible in the summary fragment, but the thread boundary is not.

### recomp-extractive / plain — Zone D summary (extractive compression)

```
From data/results/recomp-extractive/plain/tpch/pta/tpch-pta-001.json
→ turns[14].compactionEvent.summaryText

Now let me investigate the supplier performance. **Top efficient suppliers** — highest availability
with relatively low costs: Yes — the top efficient suppliers (from Thread B) are being used to
fulfill high-priority March orders from multiple regions: **Key insight:** The efficient suppliers
are well-integrated into the supply chain for critical orders.
I don't have the previous "Thread B" result
```

Observation: recomp extracted only a **fragmented slice of Thread B**, and the agent itself notes "I don't have the previous Thread B result" — the extraction discarded most of Thread A context. This explains the catastrophic 4.31/10 Gemini score.

---

## 3. Inline Metrics (live session)

| Metric | qwery-default/plain | headroom/plain | recomp/plain | qwery-default/4zone | headroom/4zone | recomp/4zone |
|---|---|---|---|---|---|---|
| compressionRatio | 0.112 | 0.182 | 0.029 | 0.026 | 4.499* | 0.025 |
| filterPersistenceRate | 0.933 | 0.783 | 0.683 | 0.783 | **0.883** | 0.833 |
| compactionOverheadPct | 1.91% | 0.62% | 0.93% | **0%** | 0.45% | 9.77% |
| sqlValidityRate | 0.974 | 0.879 | 0.940 | 0.950 | 0.895 | 0.897 |
| schemaGroundingRate | 0.486 | 0.636 | 0.694 | **0.625** | 0.568 | 0.553 |
| totalResponseTimeMs | 1,678,201 | 2,268,531 | 2,301,552 | 1,828,728 | — | 1,223,157 |

> *headroom/4zone compressionRatio=4.499 is a metric artifact: headroom fires compaction on every turn (20 events vs 1 for plain), and the ratio averaging across events with varying preCompactionTokens produces a nonsensical result. The raw per-event ratios span 0.01–0.8.

---

## 4. Post-Processing Metrics (Gemini judge + row-count consistency)

| Metric | qwery-default/plain | headroom/plain | recomp/plain | qwery-default/4zone | headroom/4zone | recomp/4zone |
|---|---|---|---|---|---|---|
| Gemini score (0–10) | **8.46** | 7.39 | 4.31 | **9.63** | 🔴 1.27 | 4.62 |
| filterPersistence (0–5) | 2.5 | 3.6 | 1.0 | **5.0** | 0.0 | 0.0 |
| entityContinuity (0–5) | 5.0 | 3.2 | 2.0 | 4.2 | 0.25 | 0.0 |
| correctionPersistence (0–5) | 2.5 | 3.6 | 1.0 | **5.0** | 0.0 | **5.0** |
| analyticalThread (0–5) | 5.0 | 4.0 | 3.0 | **5.0** | 1.25 | 0.0 |
| threadIsolation (0–5) | **5.0** | 4.0 | 3.0 | **5.0** | 1.25 | **5.0** |
| queryConsistencyRate | 12.5% | 28.6% | 0% | 20.0% | 12.5% | **57.1%** |
| Dominant failures | filter_drift, correction_ignored | entity_confusion, filter_drift, correction_ignored | entity_confusion, thread_bleed, baseline_loss, correction_ignored | entity_confusion(1), baseline_loss(1) | filter_drift(3), entity_confusion(4), correction_ignored(4), baseline_loss(2) | filter_drift, entity_confusion, baseline_loss |

> Note: qwery-default sampled only 2 post-compaction turns (vs 5 for others), so high scores may reflect limited coverage. `geminiJudgePerTurn` not stored for plain runs (code change landed after these verifies ran).

---

## 5. Zone B Entity State (4zone mode)

```
From data/results/qwery-default/4zone/tpch/pta/tpch-pta-001.json
→ turns[17].zonesSnapshot.entityState.segments[0].content.raw   (turn 18, totalTokens=409)

{
  "activeTables": ["o_orderdate", "orders", "supplier", "partsupp", "nation",
    "lineitem", "customer", "part", "efficient_suppliers", ...
    "Thread", "the", "ASIA", "a"  ← noise: non-table tokens parsed in
  ],
  "activeColumns": [
    "reminder", "you", "twice", "shipped", "orders", "suppliers"  ← noisy
  ],
  "activeFilters": [
    { "column": "prev_month_revenue", "op": "IS NOT NULL", "value": null },
    { "column": "o_orderdate",        "op": ">=",           "value": "1995-03-01" },
    { "column": "o_orderdate",        "op": "<",            "value": "1995-04-01" },
    { "column": "o_orderpriority",    "op": "IN",           "value": null },
    ...
  ]
}
```

**Key observation**: Zone B captures `activeFilters` from actual SQL queries (March date range, priority filter) but **does not** encode persisted correction *rules* as explicit entries (e.g., "exclude O_ORDERSTATUS='F'" is not present as a standalone rule). The `activeTables` and `activeColumns` arrays contain significant noise from NLP parsing (words like "Thread", "the", "reminder" extracted as identifiers). The Gemini score improvement likely comes from the agent using the Zone D LLM summary (thread-structured) plus Zone B SQL filter anchors together, not from Zone B alone.

---

## 6. Findings

### Established from plain mode

1. **qwery-default's LLM narrative uniquely preserves thread structure.** The explicit "Thread 1 / Thread 2" labeling in Zone D is the key mechanism. The agent picks this up post-compaction and maintains thread isolation (5/5). Neither headroom's hash-chunked format nor recomp's extractive snippets produce equivalent structure.

2. **recomp catastrophically fails PTA.** compressionRatio of 0.029 means it barely compressed anything (29 tokens surviving per 1000 pre-compaction), yet the surviving content is the *wrong* content — fragmented Thread B snippets with Thread A corrections discarded. The agent explicitly acknowledges it "doesn't have Thread B result." Result: 0% row-count match, thread_bleed in failure categories.

3. **Row-count consistency is uniformly low on PTA (0–28.6%)**, in sharp contrast to DCS-001 where qwery-default hit ~60%. PTA SQL varies between threads in structure (Thread A uses `ORDERS`/`LINEITEM` aggregations; Thread B uses `SUPPLIER`/`PARTSUPP`/`NATION` joins). The cold verify re-runs the same query against the same dataset but with compressed context, and the agent tends to write structurally different SQL (different join paths, date filters) rather than regenerating the exact stored query. This is a PTA-structural artifact, not a compression failure per se.

4. **Inline filterPersistenceRate overstates headroom's quality.** headroom's 78.3% live-session rate looks good, but the Gemini judge scores entity_confusion and filter_drift in 4 out of 5 sampled turns — the agent applies filters inconsistently across threads, which keyword matching in filterPersistenceRate can't detect.

5. **PTA correction boundary asymmetry**: Turn 28 correction (exclude ASIA) comes *after* the compressionBoundaryTurn=15. All three strategies saw this correction in the active window, so it should be preserved regardless — but recomp still fails it (correction_ignored in failure categories), suggesting the extractive context is so fragmented that even recent corrections get lost in noise.

6. **headroom/4zone collapses (1.27/10 vs 7.39/10 plain) — but the cause is headroom's format, not 4zone's firing frequency.** The first compaction event at turn 15 (2,540ms — a real proxy call) converts 14 turns of interleaved Thread A / Thread B content into a hash-chunked archive with no thread labels. This is the same structural failure as headroom/plain, just more consequential here: by the first sampled post-compaction turn (turn 17), all five Gemini dimensions except analyticalThread are already at 0/5. The thread context was lost in that single event.

   What makes this look like a frequency problem is the secondary effect: the subsequent 19 events fire in 36–644ms and grow Zone D from 3,866 to 209,899 tokens without compressing it — headroom's proxy accumulates rather than compacts when called repeatedly on its own output. This progressive growth eventually overwhelms Zone C's active window, making recovery impossible. But the agent was already confused before the accumulation began.

   Comparison across sessions confirms this: on IRC, 5 of 6 headroom/4zone events are near-instant no-ops (1–9ms, no summary written) — Zone D barely changes, and 4zone improves over plain (5.50 vs 3.45). On SNCJ, Zone D grows 2,782 → 42,903 tokens across 14 real events, yet the score is 8.83 — Zone A holds the schema so Zone D growth is irrelevant. The 1.27 is caused by PTA's thread-isolation requirement meeting headroom's thread-unaware format at the first compaction, not by 4zone firing 20 times.

### Pending (4zone mode)

7. **recomp/4zone shows split personality: correctionPersistence 1→5, threadIsolation 3→5, but analyticalThread 3→0 and entityContinuity 2→0.** The Zone B entity state appears to anchor explicit corrections well (Gemini scores correctionPersistence/threadIsolation at max), but the extractive Zone D archive loses the analytical *flow* — the agent knows the rules but can't reconstruct where the analysis was heading. Most striking: queryConsistencyRate jumps from 0% to 57.1% — Zone A schema context makes the re-run SQL structurally reproducible even when the narrative context is fragmented.

8. **4zone is not uniformly better on PTA.** Strategy-dependent interaction effects dominate:
   - qwery-default: 8.46 → **9.63** (Zone B + structured Zone D narrative compound well)
   - recomp: 4.31 → 4.62 (modest, dimension-swapping — structural SQL improves, narrative degrades)
   - headroom: 7.39 → **1.27** (headroom's hash-chunked format loses thread labels at the first compaction; the 4zone accumulation effect compounds it but is not the root cause)

7. **Does 4zone help queryConsistencyRate on PTA?** DCS-001 saw 4zone *hurt* consistency (80% vs 100% plain for qwery-default). On PTA where plain consistency is already near zero, any structured Zone B anchoring of SQL patterns could only help.
