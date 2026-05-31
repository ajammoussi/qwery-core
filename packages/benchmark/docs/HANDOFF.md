# Benchmark Handoff Document

> **Branch**: `feat/zone-archi-entity-state`  
> **Last updated**: 2026-05-29  
> **Architecture reference**: [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Goal

Benchmark and compare multiple context compression strategies for Qwery's multi-turn SQL analytics agent. The benchmark replays annotated conversation sessions against a live PostgreSQL database, captures tool calls, token usage, and quality metrics per turn, and produces per-strategy reports.

**Strategies under evaluation** (defined in `src/compaction/registry.ts`):
- `baseline-no-compression` — no compaction, full context accumulates
- `qwery-default` — LLM-based summary via `SessionCompaction.process`
- `headroom` — external Python-based compression via Headroom proxy
- `entity-state` — structured entity state tracking (4-zone architecture)
- `llmlingua-2`, `longllmlingua`, `sliding-window` — planned/partial

---

## Current Progress

### Completed

All four compression strategies have been benchmarked on the TPC-H DCS-001 scenario and a multi-dimension Gemini judge has been implemented and run. See **[HANDOFF-Benchmark.md](./HANDOFF-Benchmark.md)** for full results, metric rationale, findings, and 4-zone assessment.

**Summary of what's implemented:**
- Full benchmark runner with per-turn tool call capture, compaction detection, and token accounting (`runner.ts`, `session-loader.ts`)
- Inline metrics: `sqlValidityRate`, `schemaGroundingRate`, `filterPersistenceRate`, `referenceResolutionAccuracy`, `compactionOverheadPct`, `totalCompactionLatencyMs`
- Post-processing judge pipeline (`verify-consistency.ts`): re-runs benchmark model with stripped context, compares SQL row counts, invokes Gemini multi-dimension judge (0–10 score with per-dimension breakdown and failure category tags)
- 4-zone architecture wrapper (`with-4zone.ts`) composing on top of any base compression strategy

**Strategies benchmarked on tpch-dcs-001:**

| Strategy | mode | Gemini score | queryConsistency | filterPersistence | compactionOverhead |
|---|---|---|---|---|---|
| qwery-default | plain | 7.87 / 10 | 100% | 29.4% | 0.62% |
| qwery-default | 4zone | 6.00 / 10 | 80% | **44.1%** | ~0% |
| headroom | plain | 6.88 / 10 | 80% | 32.4% | 0.62% |
| recomp-extractive | plain | 6.0 / 10 | 80% | 38.2% | 1.52% |
| llmlingua-2 | plain | 6.3 / 10 | 22%* | 50.0% | **23.5%** |

*llmlingua-2 consistency rate is an evaluation artefact, not a real quality signal (see HANDOFF-Benchmark.md §Findings).

**Key finding**: filter_drift is universal — all strategies fail to consistently apply established exclusion rules after compaction. 4zone outperforms plain on the inline filter persistence metric (44% vs 29%), but the re-run Gemini score favours plain because Zone B is treated as informational context rather than enforced constraints. See `docs/analysis.md` for the full breakdown.

---

## What Worked

- **Inferring `toolName` from `type` prefix**: The `tool-getSchema` pattern reliably yields `getSchema`. Applies to all tool parts persisted by the agent SDK.
- **Using last persisted message as `parentID`**: `session-compaction.ts` only looks up messages by ID in the DB — the locally-generated `userMessageId` never gets persisted, so the fix to use `preCompactionMessages.at(-1)?.id` is the correct approach.
- **50ms latency threshold for compaction detection**: Clean separation between real LLM calls (5–30s) and no-op returns (~1ms).
- **SQL context guard in EntityStateTracker**: Simple regex `\b(SELECT|FROM|WHERE|...)\b` on the text before running any SQL regex patterns eliminates false positives from conversational prose.
- **Stash + branch + pop for conflict-free rebasing**: When moving changes from `feat/zone-archi-entity-state` to `feat/headroom-entity-state` (based on `origin/feat/headroom`), `git stash push -- <specific files>` then `git checkout -b ... origin/feat/headroom` then `git stash pop` produced exactly 3 localized conflicts in `runner.ts`, all cleanly resolved.

---

## What Didn't Work

- **`generateChart` tool always fails with minimax-m2.5**: The model wraps JSON in markdown code blocks (`` ```json ... ``` ``) instead of raw JSON. `generateObject` can't parse this. This is a model compatibility issue (`JSON response format schema is only supported with structuredOutputs`). **Do not try to fix this at the benchmark level** — it requires either switching models or fixing the tool in `agent-factory-sdk`.
- **Zone A not populating when DB is down**: Zone A only gets schema content when `getSchema` succeeds. If the PostgreSQL containers aren't running, every session will have `Zone A totalTokens = 0`. Always start DB before benchmarking.
- **`pnpm run:baseline -- --db tpch ...`**: The `--` separator causes `parseArgs` to treat `--db` as a positional (which overrides compression method). **Use `pnpm run:baseline --db tpch ...` without `--`.**

---

## Environment Setup

The benchmark requires two PostgreSQL containers. Start them once before any benchmark run:

```bash
cd pfa-compression
docker compose up -d
# wait for healthy:
docker ps  # tpch-postgres: Up (healthy) :55432, saas-postgres: Up (healthy) :55433
```

Data: TPC-H SF=1 (~6M lineitem rows) at `localhost:55432`, SaaS analytics at `localhost:55433`.

---

## Metrics Reference

All metrics live in `SessionMetrics` (`src/types.ts`) and are computed in `calculateMetrics()` (`src/session-loader.ts`) or populated later by `verify:consistency`.

| Metric | Null when | What it shows |
|--------|-----------|---------------|
| `totalInputTokens` | never | Token cost — input |
| `totalOutputTokens` | never | Token cost — output |
| `totalCost` | never | Total USD cost |
| `totalResponseTimeMs` | never | Wall-clock session time |
| `avgResponseTimeMs` | never | Average per-turn response time |
| `compressionRatio` | no compaction events | How aggressively context was compressed (summary/pre tokens) |
| `compactionLatencyMs` | no compaction events | Latency of the FIRST compaction call (kept for compat) |
| `totalCompactionLatencyMs` | no compaction events | Sum of ALL compaction call latencies |
| `compactionOverheadPct` | no compaction events | totalCompactionLatencyMs / totalResponseTimeMs × 100 |
| `toolSuccessRate` | no tool calls | % of turns where all runQuery calls succeeded (per-turn) |
| `sqlValidityRate` | no runQuery calls | % of individual runQuery calls with no SQL syntax error |
| `schemaGroundingRate` | no getSchema calls | % of runQuery SQL where all table refs exist in the captured schema |
| `filterPersistenceRate` | no persistedCorrections | % of post-boundary turns that honor established filter corrections |
| `referenceResolutionAccuracy` | no cross-boundary refs | % of cross-boundary callbacks/anaphora correctly resolved |
| `queryConsistencyRate` | not run yet | % of re-executed post-compaction queries matching stored row count — run `verify:consistency` |
| `geminiContextScore` | not run yet | 0–10 Gemini quality score for context preservation — run `verify:consistency` |
| `entityStateAccuracy` | non-4zone runs | % of `persistedCorrections` captured in Zone B `activeFilters`/`userCorrections` |

### Running `verify:consistency`

```bash
pnpm verify:consistency \
  --result data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json \
  --connection-string postgres://postgres:postgres@localhost:55432/tpch \
  --sample 5 \
  --patch
```

- `--result` — path to a `BenchmarkResult` JSON (from a strategy with a compaction summary)
- `--connection-string` — PostgreSQL URL for the database used in that session
- `--sample N` — number of post-compaction turns to test (default 5)
- `--patch` — write `queryConsistencyRate` and `geminiContextScore` back into the result JSON
- `GEMINI_API_KEY` and `GEMINI_MODEL` are read from `apps/web/.env`

**What it does**: For each sampled turn after the compression boundary, re-runs the benchmark model with the compressed context reconstructed to match what the real agent would have seen:
- **plain**: `[compressed-summary, user-turn]`
- **4zone**: `[Zone A schema, Zone B entity state, Zone D summary, Zone C recent turns, user-turn]`

Compares the generated SQL and row counts against the stored reference, then asks Gemini (1M context window — sees the full original session) to score how well the compression preserved the analytical context (0–10).

**Connection strings for standard databases:**
- tpch: `postgres://postgres:postgres@localhost:55432/tpch`
- saas: `postgres://postgres:postgres@localhost:55433/saas_analytics`

---

## Next Steps

### 1. Zone B constraint enforcement

Zone B correctly stores active filters (with correct operator semantics, extracted from SQL tool calls). The remaining gap is that the agent treats Zone B as informational context rather than mandatory constraints. Adding a directive in the 4zone context assembly — instructing the agent to apply `activeFilters` to every `runQuery` call — is the next architectural step.

### 2. Extend to other session types

Currently only DCS has been tested. Run qwery-default on IRC and RCI scenarios (already have results for tpch-irc-001 and tpch-rci-001) then run verify:consistency to get per-type judge scores:
```bash
pnpm verify:consistency \
  --result data/results/qwery-default/plain/tpch/irc/tpch-irc-001.json \
  --connection-string postgres://postgres:postgres@localhost:55432/tpch \
  --sample 5 --patch
```

### 4. Run remaining session types and strategies

Extend coverage across all 5 conversation types (DCS, IRC, PTA, RCI, SNCJ) and both databases. Priority order: qwery-default plain → qwery-default 4zone → headroom plain → baseline-no-compression plain.

### 5. Cross-strategy comparison report

Once multiple sessions are available per strategy, `extract-results.ts` produces per-method aggregated reports. A higher-level comparison script comparing strategies head-to-head on the same sessions (same scenario, different method) would be valuable for the final evaluation section.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/runner.ts` | Session execution engine, tool call capture, compaction detection |
| `src/session-loader.ts` | `calculateMetrics()`, result saving, message conversion |
| `src/types.ts` | All TypeScript interfaces (`SessionMetrics`, `BenchmarkResult`, `CompressionMethod`) |
| `src/compaction/strategy.ts` | `CompactionStrategy` type, `installStrategy()`, `makeBoundaryIsOverflow()` |
| `src/compaction/registry.ts` | Strategy lookup by name |
| `src/compaction/strategies/` | One file per strategy (`baseline.ts`, `qwery-default.ts`, `headroom.ts`) |
| `src/compaction/wrappers/with-4zone.ts` | 4-zone wrapper that composes on top of any base strategy |
| `src/zone-architecture/entity-state-tracker.ts` | Regex-based SQL entity extraction from text |
| `src/extract-results.ts` | Report generation from saved result JSON files |
| `src/run-all.ts` | CLI entry point, argument parsing, datasource setup |
| `data/sessions/` | Annotated benchmark sessions (ground truth, committed) |
| `data/results/` | Per-strategy per-session JSON output (not committed) |
| `data/reports/` | Aggregated reports from `extract-results.ts` (not committed) |
| `ARCHITECTURE.md` | Full technical reference: class diagram, data flow, zone assembly, output schema |
