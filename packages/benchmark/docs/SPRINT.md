# Benchmark Sprint — 3-Person Parallel Execution

> **Branch**: `feat/zone-archi-entity-state`
> **Deadline**: tomorrow
> **Goal**: one session per type, run both plain and 4zone — extends the DCS-001 plain vs 4zone comparison to all session types

Each person owns a set of session types and runs **all 3 strategies × both modes (plain + 4zone)** on their sessions.

All commands run from within `packages/benchmark`.

---

## Setup (everyone, before anything else)

```bash
# 1. Start DB containers (from your pfa-compression directory):
docker compose up -d
docker ps   # wait for both to show "healthy"
```

```bash
# 2. apps/web/.env (create if missing):
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
OLLAMA_API_KEY=...
OLLAMA_MODEL=minimax-m2.5
```

```bash
# 3. Pull latest branch:
git pull origin feat/zone-archi-entity-state
cd packages/benchmark
```

---

## What's already done — do NOT re-run

| Strategy | Sessions with results |
|---|---|
| `baseline-no-compression` | Full coverage: tpch (all 5 types) + saas (all 5 types) |
| `qwery-default/plain` | tpch-dcs-001/002/003, tpch-irc-001, tpch-rci-001 |
| `qwery-default/4zone` | tpch-dcs-001 |
| `headroom/plain` | tpch-dcs-001 |
| `headroom/4zone` | tpch-dcs-001 |
| `recomp-extractive/plain` | tpch-dcs-001 |
| `recomp-extractive/4zone` | tpch-dcs-001 |
| `llmlingua-2/plain` | tpch-dcs-001, saas-dcs-001/002 |

---

## Session time estimates

| Strategy | plain | 4zone |
|---|---|---|
| `qwery-default` | ~23 min | ~16 min |
| `headroom` | ~12 min | ~27 min |
| `recomp-extractive` | ~22 min | ~10 min |
| `verify:consistency` (5 samples) | ~15 min | ~15 min |
| **Full 3-strategy comparison (one mode)** | **~57 min + ~45 min verify** | **~53 min + ~45 min verify** |

---

## Push results as you go

```bash
git add data/results/{method}/{mode}/{db}/{type}/*.json
git commit -m "bench({method}/{mode}): {db} {type} {session}"
git push origin feat/zone-archi-entity-state
```

Pull between your own runs to stay in sync with the others.

---

## After each session type is fully complete: write a preliminary analysis

Once **all 3 strategies × both modes** are done for a given session type (runs + verifies), write a short analysis file before moving to the next type. These feed the final consolidated analysis.

**File**: `docs/analysis-{db}-{type}-001.md`
e.g. `docs/analysis-tpch-pta-001.md`, `docs/analysis-saas-dcs-001.md`

**Structure** (mirror `docs/analysis.md`):
1. **What we're comparing** — strategies, modes, session scenario description, `persistedCorrections` count from `data/sessions/{db}/{type}/{session}.json`
2. **What compaction produces** — snippet of `turns[N].compactionEvent.summaryText` (plain) and `turns[N].zonesSnapshot.entityState.segments[0].content.raw` (4zone), with file + key path reference
3. **Inline metrics table** — compressionRatio, filterPersistenceRate, compactionOverhead, sqlValidityRate per strategy/mode
4. **Post-processing metrics table** — Gemini score, queryConsistencyRate, dominant failure categories per strategy/mode
5. **Findings** — 3–5 bullets: what's new vs DCS-001? Does the type-specific dimension (thread_isolation for PTA, schemaGrounding for SNCJ, callbackResolution for IRC/RCI) change the story? Does the plain vs 4zone gap hold?

Commit the analysis file alongside the result files.

---

## Person 1 — tpch PTA + tpch IRC (plain + 4zone) (~6 hrs)

**PTA** (Parallel Thread Analysis): thread isolation — corrections in Thread A must not bleed into Thread B.
**IRC** (Iterative Refinement with Corrections): accumulating corrections without later ones erasing earlier ones.

```bash
# ── tpch-pta-001 PLAIN — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db tpch --type pta --limit 1
pnpm run:headroom      --db tpch --type pta --limit 1
pnpm run:recomp        --db tpch --type pta --limit 1

# ── tpch-pta-001 4ZONE — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db tpch --type pta --limit 1 --context-mode 4zone
pnpm run:headroom      --db tpch --type pta --limit 1 --context-mode 4zone
pnpm run:recomp        --db tpch --type pta --limit 1 --context-mode 4zone

# ── tpch-irc-001 PLAIN — headroom + recomp only (qwery-default already done) ─

pnpm run:headroom      --db tpch --type irc --limit 1
pnpm run:recomp        --db tpch --type irc --limit 1

# ── tpch-irc-001 4ZONE — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db tpch --type irc --limit 1 --context-mode 4zone
pnpm run:headroom      --db tpch --type irc --limit 1 --context-mode 4zone
pnpm run:recomp        --db tpch --type irc --limit 1 --context-mode 4zone
```

After each run, immediately verify (replace `{mode}`, `{method}`, `{type}`):

```bash
pnpm verify:consistency \
  --result data/results/{method}/{mode}/tpch/{type}/tpch-{type}-001.json \
  --connection-string postgres://postgres:postgres@localhost:55432/tpch \
  --sample 5 --patch
```

---

## Person 2 — tpch SNCJ + tpch RCI (plain + 4zone) (~6 hrs)

**SNCJ** (Schema Navigation and Complex Joins): schema grounding — table/column names from early exploration must survive compression.
**RCI** (Root Cause Investigation): analytical direction — not re-pursuing ruled-out hypotheses.

```bash
# ── tpch-sncj-001 PLAIN — all 3 strategies ───────────────────────────────────

pnpm run:qwery-default --db tpch --type sncj --limit 1
pnpm run:headroom      --db tpch --type sncj --limit 1
pnpm run:recomp        --db tpch --type sncj --limit 1

# ── tpch-sncj-001 4ZONE — all 3 strategies ───────────────────────────────────

pnpm run:qwery-default --db tpch --type sncj --limit 1 --context-mode 4zone
pnpm run:headroom      --db tpch --type sncj --limit 1 --context-mode 4zone
pnpm run:recomp        --db tpch --type sncj --limit 1 --context-mode 4zone

# ── tpch-rci-001 PLAIN — headroom + recomp only (qwery-default already done) ─

pnpm run:headroom      --db tpch --type rci --limit 1
pnpm run:recomp        --db tpch --type rci --limit 1

# ── tpch-rci-001 4ZONE — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db tpch --type rci --limit 1 --context-mode 4zone
pnpm run:headroom      --db tpch --type rci --limit 1 --context-mode 4zone
pnpm run:recomp        --db tpch --type rci --limit 1 --context-mode 4zone
```

After each run:

```bash
pnpm verify:consistency \
  --result data/results/{method}/{mode}/tpch/{type}/tpch-{type}-001.json \
  --connection-string postgres://postgres:postgres@localhost:55432/tpch \
  --sample 5 --patch
```

---

## Person 3 — saas database: DCS + PTA (plain + 4zone) (~6 hrs)

The saas database (SaaS analytics schema) has zero qwery-default/headroom/recomp results. saas-dcs-001 is the direct cross-database counterpart to tpch-dcs-001 — running both modes provides a tpch vs saas comparison at the same level of analysis depth.

```bash
# ── saas-dcs-001 PLAIN — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db saas --type dcs --limit 1
pnpm run:headroom      --db saas --type dcs --limit 1
pnpm run:recomp        --db saas --type dcs --limit 1

# ── saas-dcs-001 4ZONE — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db saas --type dcs --limit 1 --context-mode 4zone
pnpm run:headroom      --db saas --type dcs --limit 1 --context-mode 4zone
pnpm run:recomp        --db saas --type dcs --limit 1 --context-mode 4zone

# ── saas-pta-001 PLAIN — all 3 strategies ────────────────────────────────────

pnpm run:qwery-default --db saas --type pta --limit 1
pnpm run:headroom      --db saas --type pta --limit 1
pnpm run:recomp        --db saas --type pta --limit 1

# ── saas-pta-001 4ZONE — all 3 strategies (drop if short on time) ────────────

pnpm run:qwery-default --db saas --type pta --limit 1 --context-mode 4zone
pnpm run:headroom      --db saas --type pta --limit 1 --context-mode 4zone
pnpm run:recomp        --db saas --type pta --limit 1 --context-mode 4zone
```

After each run:

```bash
pnpm verify:consistency \
  --result data/results/{method}/{mode}/saas/{type}/saas-{type}-001.json \
  --connection-string postgres://postgres:postgres@localhost:55433/saas_analytics \
  --sample 5 --patch
```

---

## Target coverage matrix

| Session | qwery-default plain | qwery-default 4zone | headroom plain | headroom 4zone | recomp plain | recomp 4zone |
|---|---|---|---|---|---|---|
| tpch-dcs-001 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| tpch-irc-001 | ✓ | P1 | P1 | P1 | P1 | P1 |
| tpch-rci-001 | ✓ | P2 | P2 | P2 | P2 | P2 |
| tpch-pta-001 | P1 | P1 | P1 | P1 | P1 | P1 |
| tpch-sncj-001 | P2 | P2 | P2 | P2 | P2 | P2 |
| saas-dcs-001 | P3 | P3 | P3 | P3 | P3 | P3 |
| saas-pta-001 | P3 | P3* | P3 | P3* | P3 | P3* |

*saas-pta-001 4zone: drop if time is tight

---

## CLI quirks

- **No `--` separator**: `pnpm run:headroom --db tpch` not `pnpm run:headroom -- --db tpch`
- **Headroom leaves a stale proxy on port 8787** — kill it before each headroom run:
  ```bash
  fuser -k 8787/tcp 2>/dev/null; true
  ```
- `--limit 1` picks the first session of that type — verify the session ID in console output
- `pnpm run:recomp` is the alias for `recomp-extractive` (check `package.json` if unsure)
- Zone A stays empty if DB containers aren't running — always check `docker ps` first
- `verify:consistency` has built-in 503 retry (2s/4s/8s backoff) — leave it running if it pauses
- 4zone result files land in `data/results/{method}/4zone/...` not `plain`
