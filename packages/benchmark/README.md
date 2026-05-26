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
| `llmlingua`               | Basic LLMLingua token compression         |
| `longllmlingua`           | LongLLMLingua with question-aware scoring |
| `sliding-window`          | Simple sliding window truncation          |
| `qwery-default`           | Qwery's default compression strategy      |
| `entity-state`            | Entity state block + active window        |

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

### Primary Metrics

| Metric                        | Description                                 | Target |
| ----------------------------- | ------------------------------------------- | ------ |
| Filter Persistence Rate       | Corrections appearing in subsequent queries | ≥ 0.92 |
| Entity Recall                 | Callback values matching earlier results    | ≥ 0.85 |
| Reference Resolution Accuracy | Anaphoric references resolved correctly     | ≥ 0.90 |
| Schema Grounding Accuracy     | No hallucinated columns/tables              | ≥ 0.95 |

### Efficiency Metrics

| Metric              | Description              |
| ------------------- | ------------------------ |
| Total Input Tokens  | Sum of prompt tokens     |
| Total Output Tokens | Sum of completion tokens |
| Avg Response Time   | Mean time per turn       |
| Tool Calls per Turn | Average tool invocations |

## Database Connection

| Database | Host      | Port  | Database Name  |
| -------- | --------- | ----- | -------------- |
| TPCH     | localhost | 55432 | tpch           |
| SaaS     | localhost | 55433 | saas_analytics |

Default credentials: `postgres` / `postgres`
