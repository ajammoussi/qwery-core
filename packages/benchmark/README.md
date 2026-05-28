# Compression Benchmark

Test sessions and runner for benchmarking conversation compression methods in Qwery.

## Overview

- **35 total sessions** across 2 databases and 5 conversation types
- **Model**: ollama-cloud/minimax-m2.7 (context: 204,800 tokens, output: 131,072 tokens)
- **Purpose**: Establish baseline responses for compression method comparison

## Directory Structure

```
packages/benchmark/
├── package.json
├── tsconfig.json
├── data/
|   ├── schema.json          # JSON schema for session files
│   ├── sessions/            # Test case JSON files
│   │   ├── tpch/
│   │   │   ├── rci/         # 5 sessions
│   │   │   ├── irc/         # 4 sessions
│   │   │   ├── pta/         # 4 sessions
│   │   │   ├── dcs/         # 4 sessions
│   │   │   └── sncj/        # 3 sessions
│   │   └── saas/
│   │       ├── rci/         # 3 sessions
│   │       ├── irc/         # 3 sessions
│   │       ├── pta/         # 3 sessions
│   │       ├── dcs/         # 3 sessions
│   │       └── sncj/        # 3 sessions
│   ├── results/             # Benchmark results (organized by compression method)
│   │   ├── baseline-no-compression/   # Raw baseline (no compression)
│   │   │   ├── tpch/
│   │   │   └── saas/
│   │   ├── llmlingua/                # LLMLingua compression results
│   │   ├── longllmlingua/            # LongLLMLingua compression results
│   │   └── ...                       # Other compression methods
│   └── reports/             # Generated comparison reports
└── src/
    ├── types.ts             # TypeScript types
    ├── session-loader.ts    # Load/save utilities
    ├── runner.ts            # Agent runner
    ├── run-all.ts           # Main CLI runner
    ├── extract-results.ts   # Report generator
    └── validate-session.ts  # Validate session files
```

## Quick Start

### 1. Start Databases

```bash
cd pfa-compression
bash run.sh both
```

### 2. Install Dependencies

```bash
cd packages/benchmark
pnpm install
```

### 3. Run Baseline Sessions (No Compression)

```bash
pnpm run:baseline
```

This will save results to `data/results/baseline-no-compression/`.

### 4. Generate Report

```bash
pnpm extract:baseline
```

## Compression Methods

The following compression methods are supported:

| Method                    | Description                               |
| ------------------------- | ----------------------------------------- |
| `baseline-no-compression` | Raw baseline without any compression      |
| `llmlingua-2`             | LLMLingua-2 token compression via [`@atjsh/llmlingua-2`](https://www.npmjs.com/package/@atjsh/llmlingua-2) (pure JS) |
| `longllmlingua`           | LongLLMLingua with question-aware scoring |
| `sliding-window`          | Simple sliding window truncation          |
| `qwery-default`           | Qwery's default compression strategy      |
| `entity-state`            | Entity state block + active window        |
| `headroom`                | Headroom AI LLM-based summarization       |
| `recomp-extractive`       | RECOMP extractive — query-aware sentence selection via Contriever (local ONNX, zero-shot) |

### `llmlingua-2` prerequisites

- The first run downloads a BERT-class model from Hugging Face Hub (default: `atjsh/llmlingua-2-js-tinybert-meetingbank`, ~57 MB). Subsequent runs use the cached copy under `~/.cache/huggingface/`.
- No external service required — compression runs in-process via `@huggingface/transformers` + `@tensorflow/tfjs`.
- Compression is applied **in place** on older message parts (not as a single summary): tool outputs are compressed aggressively, assistant text/reasoning lightly, user-message text very lightly. Tool *inputs* (the SQL queries) and `errorText` are never compressed. The active user turn and everything after it is protected.
- All compression passes `forceReserveDigit: true` so numeric callback values (revenue figures, IDs, row counts) survive.
- Environment variables (rate = fraction of tokens retained; **higher = lighter compression**):
  - `LLMLINGUA_MODEL` — Hugging Face repo id. Default `atjsh/llmlingua-2-js-tinybert-meetingbank`. Larger BERT/XLM-RoBERTa variants are available; see the package README.
  - `LLMLINGUA_RATE_TOOL` — rate for tool outputs (JSON result rows, schema dumps). Default `0.5` (retain 50%).
  - `LLMLINGUA_RATE_LLM` — rate for assistant `text` and `reasoning` parts. Default `0.8` (retain 80%).
  - `LLMLINGUA_RATE_USER` — rate for prior user-message text. Default `0.85` (retain 85%).
  - `LLMLINGUA_MIN_TOKENS` — skip any part shorter than this. Default `32`.

## Context Modes

Context modes control how the selected compression strategy is applied.

| Mode    | Description |
| ------- | ----------- |
| `plain` | Run the base compression strategy as-is. |
| `4zone` | Wrap the base strategy with the 4-zone context manager. |

## CLI Options

### Basic Commands

```bash
# Run baseline (no compression) - DEFAULT
pnpm run:baseline

# Run only TPCH database
pnpm run:tpch

# Run only SaaS database
pnpm run:saas

# Run with specific compression method
pnpm run -- --compression-method llmlingua

# Run with 4-zone context wrapper
pnpm run -- --context-mode 4zone

# Run with custom model
pnpm run -- --model "azure/gpt-4o"
```

### Filtering & Selection

```bash
# Default context mode: plain (no 4-zone wrapper)

# Run specific conversation type
pnpm run -- --type rci

# Limit number of sessions (runs first N)
pnpm run -- --limit 5

# Run specific indices (4 and 5)
pnpm run:baseline -- --db tpch --type rci --indices 4,5

# Run a range (2 through 4)  
pnpm run:baseline -- --db tpch --type rci --indices 2-4

# Mix individual and ranges (1, 3, 5-7, 10)
pnpm run:baseline -- --db tpch --type rci --indices 1,3,5-7,10

# Run specific indices with different compression
pnpm run -- --db saas --type irc --indices 1,2 --compression-method llmlingua

# Run specific indices with 4-zone + compression
pnpm run:compression -- llmlingua --db saas --type irc --indices 1,2 --context-mode 4zone
```

## Headroom Compression

### Setup

```bash
# Option A: full ML compression
python -m venv .venv-headroom
.venv-headroom/bin/pip install "headroom-ai[ml,proxy]"
```

### Running

```bash
pnpm run:headroom       # Run headroom benchmarks
set HEADROOM_PYTHON=C:\path\to\conda\env\python.exe && pnpm run:headroom  # With custom Python
```

## RECOMP Extractive Compression

RECOMP Extractive (Xu et al., ICLR 2024) selects complete sentences from the context based on their relevance to the current user query. It uses a Contriever dual-encoder (110M params) running locally via ONNX (Transformers.js) to embed each sentence and the query, then retains the top-K sentences by cosine similarity.

### Setup

The Contriever ONNX model (~440MB) downloads automatically on first run and caches locally.

### Running

```bash
pnpm run:recomp                              # Run all sessions with RECOMP
pnpm run:recomp -- --db tpch                 # Filter by database
pnpm run:recomp -- --type dcs                # Filter by conversation type
pnpm run:recomp -- --context-mode 4zone      # With 4-zone wrapper
```

### Configuration

| Env Variable  | Default                         | Description                                |
|---------------|---------------------------------|--------------------------------------------|
| `RECOMP_K`    | `10`                            | Number of sentences to retain               |
| `RECOMP_SIMILARITY` | `cosine`                  | `cosine` or `dot` (dot matches the paper)  |
| `RECOMP_MODEL` | `Xenova/contriever-msmarco`   | HF ONNX model ID for embeddings            |

### Reporting & Validation

```bash
# Validate sessions without running
pnpm validate

# Extract reports
pnpm extract                              # All methods
pnpm extract:baseline                     # Baseline only
pnpm extract baseline-no-compression      # Specific method (positional arg)
```

## Output Structure

Results are saved in a hierarchy that clearly identifies the compression method:

```
data/results/
├── baseline-no-compression/
│   ├── tpch/
│   │   ├── rci/
│   │   │   └── tpch-rci-001.json
│   │   ├── irc/
│   │   ├── pta/
│   │   ├── dcs/
│   │   └── sncj/
│   └── saas/
│       └── ...
├── llmlingua/
│   └── ... (same structure)
└── longllmlingua/
    └── ... (same structure)
```

## Result File Format

Each result file contains:

```json
{
  "sessionId": "tpch-rci-001",
  "database": "tpch",
  "conversationType": "RCI",
  "compressionMethod": "baseline-no-compression",
  "conversationId": "uuid",
  "conversationSlug": "slug",
  "startedAt": "2024-01-01T00:00:00Z",
  "completedAt": "2024-01-01T00:30:00Z",
  "turns": [
    {
      "turnNumber": 1,
      "userMessage": "Revenue dropped...",
      "assistantMessages": [
        {
          "messageId": "message-uuid",
          "startedAt": "2024-01-01T00:00:05Z",
          "completedAt": "2024-01-01T00:00:07Z",
          "parts": [
            { "type": "text", "text": "I'll analyze..." }
          ]
        }
      ],
      "agentResponse": "I'll analyze...",
      "toolCalls": [
        {
          "toolName": "runQuery",
          "toolInput": { "query": "SELECT..." },
          "toolOutput": { "columns": [...], "rows": [...] },
          "executionTimeMs": 150,
          "success": true
        }
      ],
      "responseTimeMs": 2500,
      "inputTokens": 500,
      "outputTokens": 200
    }
  ],
  "metrics": {
    "totalTurns": 42,
    "totalInputTokens": 25000,
    "totalOutputTokens": 10000,
    "totalToolCalls": 35,
    "avgResponseTimeMs": 2200
  },
  "errors": []
}
```

## Session Distribution

| Type      | TPCH   | SaaS   | Total  |
| --------- | ------ | ------ | ------ |
| RCI       | 5      | 3      | 8      |
| IRC       | 4      | 3      | 7      |
| PTA       | 4      | 3      | 7      |
| DCS       | 4      | 3      | 7      |
| SNCJ      | 3      | 3      | 6      |
| **Total** | **20** | **15** | **35** |

## Comparison Workflow

1. **Run baseline**:

   ```bash
   pnpm run:baseline
   ```

2. **Enable compression method** in agent configuration

3. **Run with compression**:

   ```bash
   pnpm run -- --compression-method longllmlingua
   ```

4. **Generate comparison report**:

   ```bash
   pnpm extract
   ```

5. **Compare metrics** across methods from reports in `data/reports/`

## Metrics

### Inline Metrics (computed on every run)

These are computed automatically from stored turn data. `extract-results.ts` also recomputes them from older result files for backward compatibility.

| Metric | Description |
| ------ | ----------- |
| Filter Persistence Rate | % post-compaction turns where established filters appear in SQL |
| Reference Resolution Accuracy | % anaphoric/callback references resolved correctly |
| Tool Success Rate | % tool calls that succeeded |
| SQL Validity Rate | % `runQuery` calls with no syntax or semantic error |
| Schema Grounding Rate | % `runQuery` SQL where all table refs exist in `getSchema` output |
| Total Compaction Latency | Sum of all compaction event latencies |
| Compaction Overhead % | `totalCompactionLatencyMs / totalResponseTimeMs × 100` |
| Total Input / Output Tokens | Token totals across all turns |
| Avg Response Time | Mean turn response time in ms |

### Post-processing Metrics (from `verify:consistency`)

These require a live database and are patched back into the result JSON with `--patch`. They are the primary quality comparison signal between compression strategies.

| Metric | Description |
| ------ | ----------- |
| Query Consistency Rate | % sampled post-compaction turns where re-running the agent from `[summary + user turn]` produces SQL with matching row counts |
| **Gemini Context Score** | 0–10 aggregate from Gemini's multi-dimension judgment |
| ↳ filter_persistence | 0–5: Were established filters and exclusions applied? |
| ↳ entity_continuity | 0–5: Were the right entities (dates, categories, groups) referenced? |
| ↳ correction_persistence | 0–5: Were explicit user corrections from earlier turns respected? |
| ↳ analytical_thread | 0–5: Did the agent understand what was being investigated? |
| Failure Categories | Tags: `filter_drift`, `entity_confusion`, `baseline_loss`, `correction_ignored` |

The overall score is `avg(4 dimensions) × 2`, normalised to 0–10.

## Consistency Verification

`verify:consistency` re-runs the benchmark model in a stripped context (only the compressed summary + the turn's user message) and compares the result against the original. Gemini (1M context) acts as judge — it sees the complete original conversation and scores how well the summary preserved analytical context.

### Usage

```bash
pnpm verify:consistency \
  --result data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json \
  --connection-string postgres://postgres:postgres@localhost:55432/tpch \
  [--sample 5] \
  [--model ollama-cloud/minimax-m2.5] \
  [--patch]
```

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `--result` | required | Path to a `BenchmarkResult` JSON |
| `--connection-string` | required | PostgreSQL connection string for SQL re-execution |
| `--sample` | `5` | Number of post-compaction turns to sample |
| `--model` | `ollama-cloud/minimax-m2.5` | Model for the re-run (should match the original benchmark model) |
| `--patch` | `false` | Write `queryConsistencyRate`, `geminiJudge`, and `geminiContextScore` back to the result JSON |

### Requirements

- `GEMINI_API_KEY` and `GEMINI_MODEL` set in `apps/web/.env`
- Database running at the provided connection string
- The result must have a compaction event with `summaryText` (strategies that use `structuredState` only are not yet supported)

### Connection strings

| Database | Connection string |
| -------- | ----------------- |
| TPCH | `postgres://postgres:postgres@localhost:55432/tpch` |
| SaaS | `postgres://postgres:postgres@localhost:55433/saas_analytics` |

## Database Connection

| Database | Host      | Port  | Database Name  |
| -------- | --------- | ----- | -------------- |
| TPCH     | localhost | 55432 | tpch           |
| SaaS     | localhost | 55433 | saas_analytics |

Default credentials: `postgres` / `postgres`
