# Benchmark Architecture: Generic Compression Layer

Technical reference for the compression abstraction built on top of Qwery's agent infrastructure.

---

## 1. How Qwery Works (from the benchmark's perspective)

### Agent Execution

The Qwery agent runs via `runAgentToCompletion()` — a streaming, multi-step LLM loop that:

1. Takes the full `conversationMessages` array as input
2. Calls the LLM with all messages in context (no implicit truncation)
3. Invokes any tools the model requests (`runQuery`, `getSchema`, `describeTables`, etc.)
4. Repeats until the model emits a stop signal or `maxSteps` is reached
5. Returns the final message list with all assistant turns appended

Message history is **fully accumulated in memory** each turn and separately **persisted to disk** via `@qwery/repository-file`. The in-memory list grows unchecked turn-over-turn — context management is the responsibility of the compaction layer sitting above the agent, not inside it.

### The Compaction Hook Surface

`SessionCompaction` (from `@qwery/agent-factory-sdk`) exposes three static async methods that Qwery calls around each agent turn:

| Method | Signature | Called when |
|---|---|---|
| `isOverflow` | `(input: IsOverflowInput) → Promise<boolean>` | After every turn to check if context is full |
| `process` | `(input: ProcessInput) → Promise<'continue'>` | When `isOverflow` returns `true`; generates summary |
| `prune` | `(input: PruneInput) → Promise<void>` | At session start to clear old tool outputs from DB |

These are **mutable references on an exported module object**, not class methods. This makes them monkey-patchable: the benchmark swaps them out at session start and restores them at session end. The agent code calls `SessionCompaction.isOverflow(...)`, so it transparently calls whatever implementation is currently assigned.

### Message Shape

Each persisted message has:

```
StoredMessage {
  id, conversationId, role ('user' | 'assistant' | 'system')
  content: { parts: MessagePart[] }
  metadata: { summary?, hidden?, agent?, tokens?, model?, ... }
}
```

`MessagePart` varies by type: `text`, `reasoning`, `step-start`, `step-finish`, `tool-<name>`. Tool parts carry `input`, `output`, and `state` (`output-available`, `output-error`). The compaction/pruning logic operates on these parts directly.

---

## 2. Benchmark Harness: Session Lifecycle

```
run-all.ts (CLI)
  │  parse --db, --type, --compression-method, --context-mode, --indices, --model
  │  load sessions from data/sessions/
  ▼
runner.ts: runSession(session, config)
  │
  ├─ createBenchmarkRepositories(storageDir)
  │    └─ seeds fixed IDs: user/org/project (idempotent)
  │
  ├─ getStrategy(compressionMethod, contextMode)       ← registry lookup
  │
  ├─ installStrategy(strategy, { boundaryTurn, currentTurnRef })
  │    ├─ snapshots originals: SessionCompaction.{isOverflow, process, prune}
  │    ├─ calls strategy.factory(ctx, originals) → hooks
  │    ├─ wraps hooks.process with timing (fills lastCompactionRef, preTokensRef)
  │    └─ monkey-patches SessionCompaction with hooks + wrapped process
  │
  ├─ for each turn in session.turns:
  │    ├─ push user message to conversationMessages[]
  │    ├─ runAgentToCompletion(...)          ← real Qwery agent, hits real DB
  │    ├─ check isOverflow + call process if needed
  │    ├─ read persisted messages from DB to detect compaction events
  │    ├─ capture: inputTokens, outputTokens, reasoningTokens, cachedTokens,
  │    │           latencyMs, toolCalls[], compactionEvent?, zonesSnapshot?
  │    └─ rebuild conversationMessages from finishedMessages
  │
  ├─ restore()                               ← puts originals back
  │
  └─ saveResult(result, method, contextMode)
       → data/results/{method}/{contextMode?}/{db}/{type}/{sessionId}.json
```

**Compaction detection**: after each turn, the runner scans newly-persisted messages for an assistant message with `metadata.summary === true`. If found alongside a `lastCompactionRef` record, it constructs a `CompactionEvent` attached to that `TurnResult`.

**Boundary-driven triggering**: sessions carry a `compressionBoundaryTurn` annotation. All strategies (except baseline) use `makeBoundaryIsOverflow` which fires exactly once when `currentTurnRef.value >= boundaryTurn`, regardless of actual token counts. This makes all methods compress at the same conversation point for fair comparison.

---

## 3. Compression Abstraction: Class Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         packages/benchmark/src/compaction/                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                   CompactionStrategy                      │               │
│  │──────────────────────────────────────────────────────────│               │
│  │  name: CompressionMethod                                  │               │
│  │  factory: (ctx: StrategyContext,                          │               │
│  │            originals: StrategyOriginals) → StrategyHooks  │               │
│  └──────────────────────────────────────────────────────────┘               │
│              ▲                         ▲                                    │
│              │ implements               │ implements                         │
│  ┌───────────┴────────┐   ┌────────────┴───────────────────┐               │
│  │  baselineStrategy  │   │      qweryDefaultStrategy        │               │
│  │────────────────────│   │────────────────────────────────│               │
│  │  isOverflow → false│   │  isOverflow: makeBoundary...()  │               │
│  │  process → noop    │   │  process → originals.process()  │               │
│  └────────────────────┘   └────────────────────────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                      StrategyHooks                        │               │
│  │──────────────────────────────────────────────────────────│               │
│  │  isOverflow?  : typeof SessionCompaction.isOverflow       │               │
│  │  process      : typeof SessionCompaction.process          │               │
│  │  prune?       : typeof SessionCompaction.prune            │               │
│  │  getState?    : (opts?) → Record<string,unknown>          │               │
│  └──────────────────────────────────────────────────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                    StrategyContext                        │               │
│  │──────────────────────────────────────────────────────────│               │
│  │  boundaryTurn: number                                     │               │
│  │  currentTurnRef: { value: number }          (mutable ref) │               │
│  └──────────────────────────────────────────────────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                  installStrategy()                        │               │
│  │──────────────────────────────────────────────────────────│               │
│  │  - Snapshots SessionCompaction.{isOverflow,process,prune} │               │
│  │  - Calls strategy.factory(ctx, originals) → hooks         │               │
│  │  - Wraps hooks.process with timing (fills lastCompaction) │               │
│  │  - Wraps hooks.isOverflow with preTokensRef capture       │               │
│  │  - Monkey-patches SessionCompaction                       │               │
│  │  Returns: { restore(), lastCompactionRef, preTokensRef,   │               │
│  │             getState? }                                    │               │
│  └──────────────────────────────────────────────────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                      registry.ts                          │               │
│  │──────────────────────────────────────────────────────────│               │
│  │  CORE_STRATEGIES: Map<CompressionMethod, CompactionStrategy>│              │
│  │  getStrategy(method, contextMode):                         │               │
│  │    if contextMode === '4zone': return with4Zone(base)      │               │
│  │    else: return base                                       │               │
│  └──────────────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                     4-Zone Wrapper (wrappers/with-4zone.ts)                 │
│                                                                             │
│  with4Zone(baseStrategy) → CompactionStrategy                               │
│    │                                                                        │
│    └─ factory creates per-session:                                          │
│         ┌────────────────────────────────────────────────────────┐         │
│         │              ZoneContextManager                         │         │
│         │────────────────────────────────────────────────────────│         │
│         │  zoneA: ZoneSegment[]   ← Schema + global constraints  │         │
│         │  zoneB: ZoneSegment[]   ← Entity state JSON            │         │
│         │  zoneC: ZoneSegment[]   ← Active window (last N turns) │         │
│         │  zoneD: ZoneSegment[]   ← Compressed archive           │         │
│         │  config: ZoneConfiguration                              │         │
│         │  ─────────────────────────────────────────────────     │         │
│         │  addToZoneC(seg)        → enforceActiveWindowLimit()   │         │
│         │    └─ evict oldest turn → addToZoneD(seg)              │         │
│         │  retrieveFromZoneD(query) → top-K by relevance score   │         │
│         │  assembleContext(query) → [A]+[B]+[retrieved D]+[C]+q  │         │
│         │  syncEntityStateToZoneB() → serialise tracker to JSON  │         │
│         └────────────────────────────────────────────────────────┘         │
│                   │ owns                                                    │
│         ┌─────────┴──────────────────────────────────────────────┐         │
│         │             EntityStateTracker                          │         │
│         │────────────────────────────────────────────────────────│         │
│         │  activeTables: string[]                                 │         │
│         │  activeColumns: string[]                                │         │
│         │  activeFilters: EntityFilter[]                          │         │
│         │  activeAggregations: EntityAggregation[]               │         │
│         │  openThreads: string[]                                  │         │
│         │  userCorrections: string[]                              │         │
│         │  ─────────────────────────────────────────────────     │         │
│         │  extractFromText(text, isCorrection): SQLExtraction     │         │
│         │    ├─ table: FROM|JOIN <name>                          │         │
│         │    ├─ column: SELECT/GROUP BY/ORDER BY lists            │         │
│         │    ├─ filter: col op value  WHERE patterns              │         │
│         │    └─ aggregation: SUM|AVG|COUNT|MIN|MAX(...)           │         │
│         │  extractFromToolCalls(toolCalls): void                  │         │
│         │    └─ reads runQuery SQL WHERE clauses (correct ops)    │         │
│         └────────────────────────────────────────────────────────┘         │
│                                                                             │
│  4-Zone hooks:                                                              │
│                                                                             │
│  isOverflow(input):                                                         │
│    processMessagesIntoZones(input.messages, zoneManager)                    │
│    softLimit = min(0.6 × modelContext, 8000)                                │
│    return zoneManager.totalTokens > softLimit || baseHooks.isOverflow()     │
│                                                                             │
│  process(input):                                                            │
│    processMessagesIntoZones(input.messages, zoneManager)                    │
│    input.messages = buildAssembledMessages(zoneManager, query, parentID)    │
│    if overflow:                                                              │
│      syntheticInput = buildZoneDOnlyInput(zoneD, input)                     │
│      await baseHooks.process(syntheticInput)   ← compress archive only      │
│      replace zoneD with summary from repository                             │
│    return await originals.process(input)                                    │
│                                                                             │
│  getState():  → ZoneSnapshot (per-turn or final)                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│           Qwery Production Layer (agent-factory-sdk)                        │
│                                                                             │
│  SessionCompaction  (module-level mutable object — the monkey-patch target) │
│  ─────────────────────────────────────────────────────────────────────────  │
│  .isOverflow(input): checks promptCount > usable context window             │
│  .process(input):    generates LLM summary → saves metadata.summary msg     │
│  .prune(input):      clears old tool outputs beyond 40k-token protect window│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Flow: One Turn Under a Strategy

```
runner.ts: turn N
  │
  ├─ push user message → conversationMessages[]
  │
  ├─ currentTurnRef.value = N
  │
  ├─ runAgentToCompletion(conversationMessages, ...)
  │    │  (real Qwery agent: calls LLM, runs tools, persists messages to DB)
  │    └─ returns finishedMessages[] with all new assistant parts
  │
  ├─ SessionCompaction.isOverflow(tokens, model)      ← SWAPPED method
  │    │  baseline: always false
  │    │  qwery-default: true exactly once when N >= boundaryTurn
  │    │  4zone-wrapper: true when zoneTokens > 60% of modelContext
  │    └─ if true: preTokensRef.value = input.tokens + cache.read
  │
  ├─ if overflow:
  │    SessionCompaction.process(messages, conversationSlug, ...)  ← SWAPPED
  │      │  startedAtMs = now
  │      │  (strategy-specific compression runs here)
  │      └─ lastCompactionRef.value = { latencyMs, turnNumber, preCompactionTokens }
  │
  ├─ read persisted messages from DB
  │    └─ detectCompactionEvent() → scan for metadata.summary === true msg
  │         → build CompactionEvent { method, contextMode, summaryText,
  │                                   summaryTokens, preCompactionTokens, latencyMs }
  │
  ├─ if contextMode === '4zone': getState({ prune:true }) → ZoneSnapshot
  │
  └─ TurnResult { userMessage, agentResponse, toolCalls,
                  inputTokens, outputTokens, latencyMs,
                  compactionEvent?, zonesSnapshot? }
```

---

## 5. 4-Zone Context Assembly Order

When `buildAssembledMessages()` runs on every `process()` call, it reconstructs the message list passed to the LLM in this order:

```
[system]   "4-ZONE CONTEXT: ..."                            (always present)
[system]   Zone A — Schema definition + column descriptions  (frozen, cached)
[system]   Zone B — Entity state JSON                        (~200-400 tokens)
[assistant] "[HISTORY OF THE MODEL]" + top-K Zone D segments (retrieved by query)
[user|assistant] Zone C segments (last 6 turns, oldest first)
[user]     current query (parentID message)
```

Zone D retrieval ranking (`calculateRelevanceScore`):
- +1 per query word that appears in the segment content
- ×2 multiplier if `segmentType === 'user_correction'`
- ×1.5 multiplier if `segmentType === 'filter'`
- + cosine similarity × 10 if a hash-based 128-dim embedding is present

---

## 6. Output Schema

### Result File Location
```
data/results/
  {compressionMethod}/          e.g. baseline-no-compression, qwery-default
    {contextMode}/              omitted for baseline; plain | 4zone otherwise
      {db}/                     tpch | saas
        {type}/                 rci | irc | pta | dcs | sncj
          {sessionId}.json
```

### BenchmarkResult (top-level)
```
sessionId, database, conversationType
compressionMethod, contextMode
conversationId, conversationSlug
startedAt, completedAt
turns: TurnResult[]
finalZoneSnapshot?          (4zone mode only)
metrics: SessionMetrics
errors: string[]
```

### TurnResult
```
turnNumber, userMessage, agentResponse
assistantMessages: AssistantMessageDetail[]  (full parts including reasoning)
toolCalls: ToolCallResult[]
inputTokens, outputTokens, reasoningTokens, cachedInputTokens
responseTimeMs, cost
annotations?: TurnAnnotations              (from session definition)
compactionEvent?: CompactionEvent          (if compression fired this turn)
zonesSnapshot?: ZoneSnapshot               (4zone mode: per-turn zone state)
```

### CompactionEvent
```
method, contextMode
triggeredAt: 'turn-boundary' | 'token-overflow' | 'forced'
summaryText?           (text of the generated summary message)
summaryTokens?
preCompactionTokens?   (input tokens at the moment isOverflow fired)
latencyMs              (wall time of process() call)
```

### ZoneSnapshot (4zone mode)
```
schemaAndConstraints:   { segments[], totalTokens }
entityState:            { segments[], totalTokens, parsedState }
activeWindow:           { turnNumbers[], segmentComposition, totalTokens }
compressedArchive:      { segmentCount, segmentComposition, totalTokens }
summary:                { totalZoneTokens, zoneTokens{A,B,C,D}, isFull flags }
```

---

## 7. Observations from Actual Outputs

### Baseline (35 sessions complete)
- `toolCalls` array is always empty in results despite tools being invoked — `onToolMetadata` events are not being captured (tool call data lives inside `assistantMessages[].parts` instead, tagged as `tool-<name>` parts)
- Token counts grow monotonically turn-over-turn, confirming full context accumulation with no truncation

### qwery-default / plain (tpch-dcs-001)
- `compressionRatio: 0.109` — summary tokens / pre-compaction tokens; compaction fires at turn 15
- `compactionLatencyMs: 8,712ms` — LLM summary call confirmed
- Filter persistence rate: 29.4%; 0 of 12 post-compaction queries apply the `5-LOW` exclusion

### qwery-default / 4zone (tpch-dcs-001)
- `compressionRatio: 0.017` — near-zero because only Zone D (the archive) is compressed, not the full conversation
- `compactionLatencyMs: 15,149ms` — 4-zone delegates Zone D compression to the base strategy's `process`
- Filter persistence rate: 44.1%; 3 of 13 post-compaction queries apply the `5-LOW` exclusion (Zone B in context)
- Entity state false positives in `activeTables`: `["July", "now", "our", "GERMANY"]` — the FROM/JOIN regex also matches words in prose. Known limitation; does not affect `activeFilters` which are extracted from tool call SQL only
- Zone A (schema) tokens are 0 for early turns, then populated when `getSchema` tool output is intercepted via the tool-part scan in `processMessagesIntoZones`
- Zone D filled to capacity (50 segments) — archive eviction working correctly
- Zone C holding last 6 turns (isFull = true) — sliding window working correctly

---

## 8. Strategies Still To Implement

To add a new compression strategy, create a file under `src/compaction/strategies/` and export a `CompactionStrategy`:

```typescript
export const myStrategy: CompactionStrategy = {
  name: 'llmlingua-2',
  factory: (ctx, originals) => ({
    isOverflow: makeBoundaryIsOverflow(ctx),   // deterministic boundary trigger
    process: async (input) => {
      // compress input.messages using LLMLingua, then call originals.process
      input.messages = await llmLinguaCompress(input.messages);
      return originals.process(input);
    },
  }),
};
```

Then register it in `registry.ts`:
```typescript
const CORE_STRATEGIES = {
  ...
  'llmlingua-2': myStrategy,
};
```

The strategy is then automatically available via `--compression-method llmlingua-2` and can be composed with `--context-mode 4zone`.

`ZoneCompressionBackend` in `zone-strategy-base.ts` also provides a plug point for wiring a hard-compression backend directly into Zone D eviction within the 4-zone wrapper, instead of using the base strategy's `process`.
