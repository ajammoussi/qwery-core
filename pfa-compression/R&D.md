## R&D

## 1. Problem Statement

Large language models (LLMs) used in conversational SQL analytics suffer from a well-documented degradation pattern in long sessions. As the conversation grows, the model's effective attention becomes diluted across an increasingly large context window, causing it to lose track of earlier user constraints, schema nuances, and analytical intent. This phenomenon — colloquially referred to as context rot — manifests as filter amnesia (forgetting WHERE clauses established earlier), entity confusion (mixing up similarly named tables or columns), and goal drift (losing sight of the user's overarching analytical objective).

The present document surveys the principal families of context compression techniques emerging from the research literature, evaluates their suitability for a structured-data SQL chatbot setting, and proposes a concrete integration architecture with benchmarking methodology. We extend the taxonomy introduced in Section 0 (Soft vs. Hard compression) with a third axis — memory architecture — and map each technique to its expected impact on the three failure modes above.

**Core constraint:** Our SQL chatbot operates against black-box API models (Claude, GPT-4o). This means techniques requiring gradient-based fine-tuning (AutoCompressor, Gisting in its original form) cannot be applied directly to the inference model. They may be applied to a smaller auxiliary compressor model running in-process.

## 2. Taxonomy of Compression Approaches

### 2.2 Hard Compression — Direct Token Reduction
Hard compression operates entirely on the plain-text token sequence, shortening it without introducing new token types or requiring model training. This makes hard compression immediately compatible with black-box API models and deployable without any fine-tuning infrastructure.

#### 2.2.1 LLMLingua
LLMLingua (Jiang et al., 2023) uses a small, independently loaded language model (typically LLaMA-7B or Phi-2) to score each token in the prompt by its conditional perplexity under that small model. The core intuition is information-theoretic: tokens with low perplexity — those that are highly predictable given their context — contribute little to the model's overall entropy and can be safely removed without degrading downstream understanding.

The full LLMLingua pipeline involves three components:

- Budget Controller: Allocates different compression ratios to different prompt segments. Instructions are preserved at high fidelity; few-shot demonstrations are aggressively compressed; the question itself is kept intact. In a SQL chatbot, this maps to: schema (high fidelity) → old turn summaries (aggressive) → recent turns (preserved) → current query (intact).

- Token-Level Iterative Compression: Processes the prompt in a sliding window, re-evaluating token importance conditioned on previously retained tokens. This accounts for interdependencies — a token that appears dispensable in isolation may be critical for decoding a subsequent token.

- Distribution Alignment via Instruction Tuning: An optional fine-tuning step that aligns the small compressor model's internal distribution with the target (large) model's distribution, improving compression quality at the token boundary.

#### 2.2.2 LongLLMLingua
LongLLMLingua (Jiang et al., 2024) extends the base LLMLingua method specifically for the long-context regime, addressing two failure modes that emerge when naively applying LLMLingua to contexts exceeding 10k tokens: (1) the compressor model itself loses coherence at long range, and (2) the placement bias inherent to LLMs — where models preferentially attend to the beginning and end of the context — causes critical mid-context information to be systematically underweighted.
LongLLMLingua's contributions are five-fold:

|Component|Description and SQL-chatbot interpretation|
|---|---|
| 1. Question-aware coarse-to-fine compression | Unlike LLMLingua, which evaluates token importance without knowledge of the downstream query, LongLLMLingua conditions the importance scoring on the current user question. A perplexity contrast score is computed as the difference in token perplexity with and without the question in context. Tokens whose perplexity drops significantly when the question is provided are deemed question-relevant and preserved. This is directly applicable to SQL sessions: when a user asks "what is the average revenue per region?", tokens in the history that mention 'revenue', 'region', 'AVG', or related entities receive elevated importance scores. |
| 2. Document reordering | After compression, document segments (in our case, conversation turn summaries) are reordered to place the most question-relevant segments adjacent to the current query. This directly counteracts the LLM position bias problem — ensuring that the most relevant historical context is not buried in the middle of a long context window but positioned where the model's attention is strongest.|
| 3. Dynamic compression ratios | Rather than applying a fixed compression ratio globally, LongLLMLingua assigns per-segment compression ratios based on question relevance scores. Highly relevant segments are compressed lightly (or not at all); irrelevant segments are compressed aggressively. This gives a finer-grained budget allocation than the LLMLingua budget controller, which operates at the coarse instruction/demonstration/question level.|
| 4. Post-compression token restoration | A recovery module identifies tokens that were pruned but are strongly predicted by the retained context, and optionally restores them. This is particularly useful for SQL keywords and column names that may have been pruned due to local perplexity scores but are syntactically necessary for the model to generate valid SQL.|
| 5. Subsequence recovery | A post-processing step that identifies key entities (table names, column names, filter values) in the generated response and maps them back to their original positions in the uncompressed context. This enables grounding verification — checking whether the model's response is traceable to an actual token in the source history, flagging potential hallucinations. |

### 2.3 Selective Retention and Memory Architectures
A third family of approaches neither compresses tokens informationally nor replaces them with soft tokens — instead, it selectively retains different parts of the conversation in different memory tiers. MemGPT (Packer et al., 2023) is the canonical example: it models the LLM's context window as RAM and an external vector store as disk, implementing explicit read/write operations to move content between tiers based on relevance to the current query.

For our SQL chatbot, a simplified memory architecture maintains three tiers: a frozen prefix (schema, global constraints), an active sliding window (recent turns in full), and a compressed archive (older turns as structured JSON summaries or dense embeddings). On each new turn, the system retrieves relevant archive segments via embedding similarity to the current query and injects them into the active window alongside the recent turns.

## PART II — Integration Architecture for the SQL Chatbot

## 3. System Architecture Overview

The following architecture layers the three compression families into a unified pipeline that operates continuously during a session, without requiring the user to restart the conversation. The design principle is progressive degradation with semantic anchoring: as the session grows longer, older turns are progressively compressed, but a set of semantic anchors (schema, entity state, user-stated constraints) are always preserved at full fidelity.

**Design principle:** Never compress the schema. Never compress the current turn. Never compress a user correction. Everything else is fair game, with compression intensity increasing monotonically with turn age.

### 3.1 Context Zones
The context window is divided into four zones, managed independently:

|Zone|Contents and management policy|
|---|---|
|Zone A — Frozen prefix|Schema definition, column descriptions, global user constraints (e.g., 'always filter active users'). Never modified. Served via prompt caching.|
|Zone B — Entity state block|A rolling JSON structure tracking: tables referenced, active filters, columns of interest, last-used aggregations, and open analytical threads. Updated on every turn. ~200–400 tokens.|
|Zone C — Active window|The last 4–6 turns verbatim. Full fidelity, no compression. Slides forward on each turn.|
|Zone D — Compressed archive|All turns older than Zone C. Processed by the LongLLMLingua compressor. Retrieved selectively per query via embedding similarity.|

### 3.2 The Compression Pipeline
When a new user message arrives, the following sequence executes:

Query arrives → entity state block updated with any new tables, columns, or constraints mentioned.

**Zone C overflow check:** if Zone C exceeds 6 turns, the oldest turn is evicted to Zone D.

**Zone D compression:** the evicted turn is processed by the LongLLMLingua compressor conditioned on the current query. A compressed representation is stored in the archive.

**Archive retrieval:** top-k most relevant Zone D segments are retrieved via cosine similarity between their embeddings and the current query embedding, and injected between Zone B and Zone C.

**Context assembly:** [Zone A] + [Zone B] + [retrieved Zone D segments] + [Zone C] + [current query].
Main model call with assembled context.

**Response validation:** subsequence recovery checks whether all SQL entities in the response are traceable to the assembled context. Ungrounded entities are flagged.

### 3.3 LongLLMLingua Integration — Detailed
LongLLMLingua runs as a sidecar service using a small language model (recommended: Phi-3-mini-4k or Qwen2-1.5B for latency; LLaMA-3-8B for quality). It is invoked asynchronously — the compression of the evicted turn happens in the background while the current turn is being processed, so it does not add to the user-perceived latency of any individual response.

#### 3.3.1 Coarse-to-Fine Compression Configuration
The budget controller is configured with SQL-specific segment labels:

```javascript
compression_config = {
"segment_types": {
"schema": { "ratio": 1.0, "min_ratio": 1.0 }, # never compress
"entity_state": { "ratio": 1.0, "min_ratio": 1.0 }, # never compress
"user_correction": { "ratio": 1.0, "min_ratio": 1.0 }, # never compress
"query_result": { "ratio": 0.4, "min_ratio": 0.2 }, # compress heavily
"assistant_turn": { "ratio": 0.5, "min_ratio": 0.3 }, # moderate compression
"user_turn_old": { "ratio": 0.7, "min_ratio": 0.5 }, # light compression
},
"question_aware": True, # condition on current user query
"reorder": True, # move relevant segments near the query
"dynamic_ratio": True, # adjust per-segment ratio by relevance score
}
```

#### 3.3.2 Question-Aware Scoring for SQL
The question-aware scoring mechanism is particularly powerful for SQL chatbots because user queries are highly structured and often share lexical overlap with the historical context that matters most. The perplexity contrast score Δ(t) for token t is computed as:

$Δ(t) = perplexity(t | context, without query) − perplexity(t | context, with query)$

- A high Δ(t) means the current query significantly reduces uncertainty about token t — indicating that t is question-relevant and should be preserved.

**For SQL sessions:** tokens like table names, column identifiers, filter values, and aggregate function names will naturally score high Δ when the current question references them. Generic connective tokens ('the', 'and', 'was') will score near zero and be pruned.

#### 3.3.3 Document Reordering for Position Bias Mitigation
After compression, the Zone D segments selected for injection are not simply appended in chronological order. Instead, they are reordered by their question-relevance score (Δ-sum over tokens), placing the most relevant segment immediately before Zone C. This ensures that the most relevant historical context sits adjacent to the current conversation and the current query — the positions where LLM attention is strongest.

In practice for SQL chatbots, this means that if the user asks a follow-up about a metric they first discussed 40 turns ago, that segment will be surfaced and positioned near the current query rather than being buried at the start of the context, dramatically improving the model's ability to reference it accurately.

### 3.4 Entity State Tracker
The entity state block (Zone B) is a structured JSON object that serves as a persistent, uncompressed summary of the session's analytical state. Unlike the turn history, it is not a verbatim transcript but a continuously updated semantic summary. It is written by a lightweight extraction call after each turn.

```json
{
"active_tables": ["orders", "customers", "products"],
"active_columns": ["revenue", "region", "customer_id", "order_date"],
"active_filters": [
{ "column": "status", "op": "=", "value": "active" },
{ "column": "region", "op": "IN", "value": ["EU", "APAC"] }
],
"active_aggregations": ["AVG(revenue)", "COUNT(DISTINCT customer_id)"],
"open_threads": [
"User is investigating revenue drop in Q3 2024 in EU region",
"Pending: breakdown by product_category requested but not yet run"
],
"user_corrections": [
"Always use order_date not created_at for time filtering",
"Customer table uses soft deletes — always add WHERE deleted_at IS NULL"
]
}
```

This structure costs roughly 200–400 tokens regardless of session length, and it directly addresses filter amnesia — the most common and most damaging failure mode in long SQL chat sessions. 

The user_corrections field is particularly important: any explicit correction or clarification from the user is recorded here and guaranteed to persist for the entire session.

PART III — Benchmarking and Experimental Methodology

4. Metrics and Evaluation Framework
   4.1 Primary Metrics
   4.1.1 Faithfulness Metrics
   These measure whether the compressed context preserves the information the model actually needs:

|Metric|Definition and target|
|-------|----------------------|
|Query re-execution consistency (QRC)|Take a query from turn N. Remove turns 1 to N-1 and replace with the compressed context. Re-execute the query. Measure exact SQL match rate and execution-result equivalence (result set identity, not string match). Target: QRC ≥ 0.90 at 3× compression.|
|Entity recall (ER)|After compression, probe the model with direct questions about entities mentioned before the compression boundary ('which table are we analyzing?', 'what filter did we establish in the first turn?'). Measure F1 on recalled entities. Target: ER ≥ 0.85.|
|Schema grounding accuracy (SGA)|Rate of SQL column/table references in model outputs that exist in the actual schema. Proxy for hallucination resistance. Target: SGA ≥ 0.98 (baseline without compression) maintained at ≥ 0.95 with compression.|
|Filter persistence rate (FPR)|The fraction of sessions where an established filter (recorded in entity state) correctly appears in all subsequent queries. This is the primary failure mode metric. Target: FPR ≥ 0.92.|

#### 4.1.2 Output Quality Metrics
|Metric|Definition|
|-------|----------|
|SQL validity rate (SVR)|Percentage of generated queries that parse without error and execute against the database. Measured at turn 5, 15, 30, and 50 to track degradation over session length.|
|Execution accuracy (EA)|Percentage of generated queries that return the same result set as a reference query written by a human expert for the same intent. The gold standard for correctness.|
|Correction rate (CR)|Frequency with which the user sends a correction ('no, I meant...', 'that's wrong'). This is the in-production quality signal. Lower is better.|
|Reference resolution accuracy (RRA)|When a user says 'do the same but for last year' or 'add that filter from before', does the model resolve the reference correctly? Measured on a test set of sessions with deliberate anaphoric references across compression boundaries.|

#### 4.1.3 Efficiency Metrics
|Metric|Definition and target|
|-------|----------------------|
|Compression ratio (CR-tok)|Compressed tokens / original tokens. Measured per-segment and aggregate. Target: ≥ 3× for query result segments, ≥ 2× overall archive.|
|Context budget utilization (CBU)|Fraction of sessions that reach the context limit before session end, with and without compression. Should drop to near 0 with compression active.|
|Compression latency (CL)|Wall-clock time for the LongLLMLingua compressor to process one evicted turn. Must remain below 500ms for asynchronous operation not to queue up.|
|Total session cost (TSC)|Total tokens billed across all API calls for a session of fixed length. Target: ≥ 40% reduction vs. naive sliding window.|

### 4.2 Benchmark Dataset Construction
A synthetic benchmark of 100 multi-turn SQL sessions should be constructed as follows. Each session uses one of three real-world-style schemas (e-commerce, SaaS analytics, logistics). Sessions are seeded with an initial analytical goal (e.g., 'investigate why Q3 revenue dropped') and populated with 30–50 turns covering: exploratory queries, dead ends, corrections, refinements, and callback questions that explicitly reference information from 10+ turns earlier.

Each session includes at least:

- 3 explicit user corrections that must persist for the remainder of the session.
- 2 anaphoric references ('same query but for...' / 'like we did before') that cross a compression boundary.
- 1 'callback' question referencing a specific result from more than 15 turns ago.
- At least 5 aggregate queries (AVG, SUM, COUNT DISTINCT) that reference filters established early in the session.

### 4.3 Experimental Conditions
|Condition|Description|
|---------|-----------|
|Baseline — naive truncation|Sliding window, oldest turns dropped when limit reached. No compression.|
|Condition A — entity state only|Frozen prefix + entity state block, no turn compression. Tests the value of structured state tracking alone.|
|Condition B — rolling prose summary|Oldest turns summarized into free-form prose. Standard approach in most production systems.|
|Condition C — LLMLingua hard compression|Base LLMLingua applied to Zone D segments. No question-aware scoring.|
|Condition D — LongLLMLingua|Full LongLLMLingua pipeline: question-aware scoring, reordering, dynamic ratios, entity restoration.|
|Condition E — Full architecture|Zone A (frozen) + Zone B (entity state) + LongLLMLingua Zone D + Zone C (active window). The proposed system.
