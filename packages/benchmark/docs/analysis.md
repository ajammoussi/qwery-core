# Results Analysis: qwery-default plain vs 4zone

**Session:** `tpch-dcs-001` — TPC-H Deep Callback Session, 32 turns
**Run date:** 2026-05-29

---

## What we're comparing

This document compares **qwery-default** — an LLM-based compression strategy that rewrites conversation history into a structured summary — under two context architectures:

**plain**: the entire conversation history is compressed into a single LLM summary when the context fills.

**4zone**: the same compression algorithm runs on only Zone D (the archive). Three additional zones are always preserved at full fidelity alongside it:
- Zone A — database schema (from `getSchema` tool outputs)
- Zone B — rolling structured JSON of active filters, corrections, and entities (extracted from SQL `runQuery` tool calls)
- Zone C — the last N turns at full fidelity

The 4zone wrapper is strategy-agnostic: headroom and recomp-extractive also have 4zone variants.

---

## Session scenario

`tpch-dcs-001` is a **Deep Callback Session (DCS)** on TPC-H SF=1 (~6M lineitem rows). The primary stress test: two constraints are established in early turns, and the agent must apply them consistently for the rest of the session after the compression boundary.

From `data/sessions/tpch/dcs/tpch-dcs-001.json`:

```json
"persistedCorrections": [
  {
    "turnEstablished": 3,
    "type": "date_column",
    "correctionText": "Fiscal year runs July to June - Q1 is July-September"
  },
  {
    "turnEstablished": 4,
    "type": "exclusion",
    "correctionText": "Exclude orders with O_ORDERPRIORITY = '5-LOW'"
  }
]
```

The `5-LOW` exclusion is the harder test: it requires joining `orders` to `lineitem` and adding `WHERE o_orderpriority != '5-LOW'` to every relevant query.

Compression boundaries: plain at turn 15, 4zone at turn 16.

---

## What each mode produces at compaction

### plain — Zone D summary (rewrites turns 1–14)

From `data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json` → `turns[14].compactionEvent.summaryText`:

```
## Conversation Summary

**What was done:**
- Analyzed TPC-H benchmark dataset across multiple dimensions
- Queried total revenue by region for 1995 (America led with ~$6.8B)
- Queried Europe-specific revenue for 1995: $6,605,155,201.17
- Identified top 10 suppliers by volume (Supplier#2298 leads with 14,744 units)
...
```

The summary lists analytical results (numbers and rankings) but frames constraints as incidental context rather than standing rules. The `5-LOW` exclusion appears as part of a results description, not as a filter the agent should continue applying.

### 4zone — Zone D summary + Zone B entity state

The Zone D summary for 4zone (from `data/results/qwery-default/4zone/tpch/dcs/tpch-dcs-001.json` → `turns[15].compactionEvent.summaryText`) covers a narrower slice — only the archive portion, not the full history.

Zone B, updated every turn from actual SQL WHERE clauses, captures the exclusion rule with correct semantics. From `turns[19].zonesSnapshot.entityState.segments[0].content.raw`:

```json
{
  "activeFilters": [
    { "column": "l_shipdate",      "op": ">=",  "value": "1995-01-01" },
    { "column": "l_shipdate",      "op": "<",   "value": "1996-01-01" },
    { "column": "o_orderpriority", "op": "!=",  "value": "5-LOW" },
    { "column": "r_name",          "op": "=",   "value": "EUROPE" },
    { "column": "n_name",          "op": "=",   "value": "GERMANY" }
  ],
  "userCorrections": []
}
```

The `!=` operator is correct — exclusion semantics preserved. Zone B is populated from actual SQL tool inputs, not from prose text, which is why the operator is right.

---

## Inline metrics

Computed during the live session from stored turn data. No re-running required.

### qwery-default plain vs 4zone

| Metric | plain | 4zone |
|---|---|---|
| Compression ratio | 0.109 | 0.017 |
| Compaction overhead | 0.62% | ~0% |
| Total response time | 1,401,765ms (~23 min) | 1,394,838ms (~23 min) |
| SQL validity rate | 100% | 96.8% |
| Schema grounding rate | 87.5% | 93.5% |
| **Filter persistence rate** | **29.4%** | **44.1%** |
| Post-compaction queries with `5-LOW` exclusion | **0 / 12** | **3 / 13** |

**Compression ratio** is the fraction of context that survives compaction. The 4zone value (0.017) is near-zero because only Zone D (the archived portion) is compressed — a small slice. The plain value (0.109) represents the ratio of the full-history LLM summary to the pre-compaction token count.

**Filter persistence rate** is a keyword-based inline check: for each `persistedCorrection`, does its text appear in post-compaction agent responses and SQL? The 4zone agent scores 44% vs 29% for plain, and correctly applies the `5-LOW` exclusion in 3 of 13 post-compaction queries (vs 0 for plain). Zone B is making a measurable difference in the live session.

### All strategies on tpch-dcs-001

| Strategy | mode | compressionRatio | overhead% | filterPersistence | 5-LOW / total queries | sqlValidity | responseTimeMs |
|---|---|---|---|---|---|---|---|
| baseline | plain | — | — | 32.4% | n/a | — | 1,439,078 |
| qwery-default | plain | 0.109 | 0.62% | 29.4% | 0 / 12 | 100% | 1,401,765 |
| qwery-default | **4zone** | 0.017 | ~0% | **44.1%** | **3 / 13** | 96.8% | 1,394,838 |
| headroom | plain | 0.269 | 0.62% | 32.4% | 2 / 14 | 96.6% | 711,735 |
| recomp-extractive | plain | 0.022 | 1.52% | 38.2% | 0 / 11 | 100% | 1,316,547 |
| llmlingua-2 | plain | 0.828 | **23.49%** | 50.0% | 6 / 14 | 100% | 1,139,273 |

---

## Post-processing metrics (verify:consistency)

`verify:consistency` re-runs the agent on sampled post-compaction turns using only the compressed context, then compares SQL output and asks Gemini to score context preservation across five dimensions.

**Methodology note — 4zone re-runs receive the full zone context:**

For plain, the re-run gets `[summary → user question]` — matching what the real agent had.

For 4zone, the re-run gets `[Zone A schema → Zone B entity state → Zone D summary → Zone C recent turns → user question]` — matching what the real agent had. Earlier evaluation that only injected Zone D showed artificially low scores for 4zone (40% row-count match). With the correct context, it reaches 80%.

### Results (5 sampled turns, same turns for both)

| Metric | plain | 4zone |
|---|---|---|
| Gemini context score | **7.87 / 10** | 6.00 / 10 |
| Row-count match | **100%** | 80% |
| filter_persistence (avg/5) | 2.8 / 5 | 1.0 / 5 |
| entity_continuity (avg/5) | 5.0 / 5 | 5.0 / 5 |
| correction_persistence (avg/5) | 2.8 / 5 | 1.0 / 5 |
| callback_resolution (avg/5) | 4.0 / 5 | 3.0 / 5 |
| Zone B entity state accuracy | — | 50% |

**Zone B entity state accuracy** (4zone only): 1 of 2 `persistedCorrections` captured in Zone B. The `5-LOW` exclusion filter is correctly stored (`op: "!="` confirmed in the snippet above). The fiscal year definition ("Fiscal year runs July to June") cannot be expressed as a filter predicate — it has no representation in `activeFilters` or `userCorrections`, giving 1/2 = 50%.

### Post-processing for all strategies (plain mode)

| Strategy | Gemini score | queryConsistencyRate | dominant failures |
|---|---|---|---|
| qwery-default | **7.87 / 10** | **100%** | filter_drift(3), correction_ignored(2) |
| headroom | 6.88 / 10 | 80% | filter_drift, entity_confusion |
| recomp-extractive | 6.0 / 10 | 80% | filter_drift, correction_ignored |
| llmlingua-2 | 6.3 / 10 | 22%† | entity_confusion |

†llmlingua-2's 22% row-count match is an evaluation artefact, not a real quality signal — see Finding 3 below.

---

## Findings

### 1. The two metrics tell different stories about 4zone

**Filter persistence rate (inline)**: 4zone wins clearly — 44% vs 29%, and 3 vs 0 actual SQL applications of the exclusion rule. This is measured during the live session with the full zone context present.

**Gemini context score (re-run)**: plain wins — 7.87 vs 6.00. This measures how well the compressed context alone supports re-answering a question in isolation.

These are not contradictory. Filter persistence measures what the real agent does across a full session. The Gemini score measures what a cold re-run produces from just the summary. For a production system, the inline filter persistence rate is the more relevant signal.

### 2. Zone B is read but not applied proactively

Zone B stores `o_orderpriority != '5-LOW'` correctly. But the re-run agent treats it as informational context rather than a mandatory constraint. On standalone turns ("average quantity per line item", "discount vs quantity"), the agent doesn't apply the filter unprompted — scoring 0/5 on filter_persistence for those turns.

The exception: when the user explicitly refers back to an established rule ("show me Europe revenue **excluding the low priority orders as we established**"), the 4zone agent scores 10/10 — it reads Zone B and applies the filter correctly when prompted.

This gap — Zone B is read but not enforced — is the primary reason 4zone scores lower on the re-run test despite outperforming plain in the live session.

### 3. Plain's narrative summary is implicitly more constraining than Zone B JSON

The plain qwery-default summary embeds constraints inside analytical prose:
> "Europe revenue for 1995 excluding 5-LOW orders: $6.6B"

The agent recognises this framing as a baseline to replicate and applies the filter when re-asked. Zone B's structured JSON (`{"op": "!=", "value": "5-LOW"}`) is more precise, but the LLM does not treat it as an instruction without an explicit directive to do so.

### 4. filter_drift is universal across all strategies

All strategies fail to consistently apply the `5-LOW` exclusion after compaction. Zero strategies reach even 50% of post-compaction queries applying the rule without explicit user re-prompting.

Root causes differ by strategy:
- **qwery-default (plain)**: the LLM summary focuses on analytical results, not operational constraints. The exclusion rule is mentioned but not stated as a standing rule.
- **headroom**: the rule text is present in the compressed message join but buried among data tables. Applied in 2/14 queries.
- **recomp-extractive**: the compressor removes the leading list item containing the fiscal year rule and starts mid-sentence. Metadata leaks into the summary ("Method: RECOMP Extractive, Tokens before: 1719...").
- **llmlingua-2**: best result (6/14) because it compresses in-place — the turn establishing the rule remains in context with ~17% tokens removed.

### 5. llmlingua-2 queryConsistencyRate is an evaluation artefact

`verify:consistency` uses the compaction `summaryText` as re-run context. For llmlingua-2, the "summary" is a 91-character log line: `[llmlingua-2] compressed parts — tokens 4657 → 3858`. The re-run agent has no analytical context at all, producing completely different SQL → 22% row-count match. The number measures the absence of a summary, not strategy quality. llmlingua-2 would require a different evaluation path.

### 6. llmlingua-2 overhead is a practical dealbreaker

23.5% compaction overhead = ~267 seconds of compression time for 15 turns before the agent can continue. Every other strategy is under 2%. This disqualifies it for interactive sessions regardless of context quality.

### 7. Total token cost is invariant across strategies

All four strategies produce 254k–279k input tokens for the same 32-turn session. Compressing at turn 15 doesn't reduce API cost because the conversation rebuilds on the compressed context for the remaining 17 turns. The benefit of compression is keeping the context window manageable, not reducing spend.

---

## Summary

| Question | Answer |
|---|---|
| Does 4zone help the live agent? | Yes — filter persistence 44% vs 29%, 3 vs 0 correct exclusion queries |
| Does 4zone improve the re-run score? | No — 6.00 vs 7.87 Gemini, 80% vs 100% row-count match |
| Why the gap? | Zone B is informational context, not enforced as a constraint |
| Best overall strategy on this scenario? | qwery-default/plain: highest Gemini score, 100% row-count match, lowest overhead |
| Universal failure? | Yes — filter_drift appears in every strategy; no strategy consistently enforces established rules after compaction |
