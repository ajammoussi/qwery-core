/**
 * Compression faithfulness test.
 *
 * For each sampled post-compaction turn:
 *  1. Re-run the benchmark model with ONLY [compressed-summary + user-turn] as context
 *  2. Compare generated SQL and row-count against the stored reference
 *  3. Send everything to Gemini (full 1M context) to score context preservation quality 0-10
 *
 * The Gemini judge is grounded in session annotations (persistedCorrections, anaphoricReferences,
 * callbacks) rather than inferring from free text — making evaluation precise and reproducible.
 * Scoring is weighted by conversation type (DCS, IRC, PTA, RCI, SNCJ) with type-specific
 * extra dimensions added where applicable.
 *
 * Usage:
 *   pnpm verify:consistency \
 *     --result data/results/qwery-default/plain/tpch/dcs/tpch-dcs-001.json \
 *     --connection-string postgres://postgres:postgres@localhost:55432/tpch \
 *     [--sample 5] [--model ollama-cloud/minimax-m2.5] [--patch]
 */

import { parseArgs } from 'util';
import { readFile, writeFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type {
  BenchmarkResult,
  BenchmarkSession,
  TurnResult,
  GeminiJudgeResult,
  ZoneSnapshot,
} from './types.js';
import { extractToolCallsFromParts } from './utils/extract-tool-calls.js';
import {
  createBenchmarkRepositories,
  ensureDatasource,
} from './runner.js';
import { runAgentToCompletion } from '@qwery/agent-factory-sdk/agents/run-agent-to-completion';
import type { UIMessage } from '@qwery/agent-factory-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env loading ───────────────────────────────────────────────────────────

async function loadEnvFile(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf('=');
      if (sep <= 0) continue;
      const key = trimmed.slice(0, sep).trim();
      const raw = trimmed.slice(sep + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] =
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
    }
    return true;
  } catch {
    return false;
  }
}

async function loadBenchmarkEnv() {
  const root = join(__dirname, '..', '..', '..');
  for (const p of [join(root, 'apps', 'server', '.env'), join(root, 'apps', 'web', '.env')]) {
    await loadEnvFile(p);
  }
}

// ── SQL helpers ───────────────────────────────────────────────────────────

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── pg re-execution ───────────────────────────────────────────────────────

async function executeSQL(
  connectionString: string,
  sql: string,
): Promise<{ rowCount: number | null; error?: string }> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(sql);
    return { rowCount: result.rows.length };
  } catch (err) {
    return { rowCount: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

// ── conversation-type context ─────────────────────────────────────────────

const CONV_TYPE_CONTEXT: Record<string, string> = {
  DCS: 'Deep Callback Session — the primary challenge is recalling specific facts established in turns long before the compression boundary. Focus on whether distant-turn references are resolved with the correct values.',
  IRC: 'Iterative Refinement with Corrections — the primary challenge is accumulating multiple explicit corrections across many turns without losing earlier ones as new ones are added.',
  PTA: 'Parallel Thread Analysis — the primary challenge is thread isolation. The conversation runs two distinct analytical threads (Thread A and Thread B); corrections and filters for one thread must not bleed into the other.',
  RCI: 'Root Cause Investigation — the primary challenge is maintaining the correct analytical direction. The agent explores hypotheses, some of which are dead ends; it must not re-pursue ruled-out paths.',
  SNCJ: 'Schema Navigation and Complex Join Building — the primary challenge is schema grounding. Table names, column names, and join keys from early schema exploration must be recalled correctly even after compression.',
};

// ── dimension weights by conversation type ────────────────────────────────

const DIMENSION_WEIGHTS: Record<string, Record<string, number>> = {
  IRC:  { filterPersistence: 1, entityContinuity: 0.5, correctionPersistence: 2,   analyticalThread: 0.5 },
  DCS:  { filterPersistence: 1, entityContinuity: 1,   correctionPersistence: 1,   analyticalThread: 1,   callbackResolution: 2 },
  PTA:  { filterPersistence: 1, entityContinuity: 1.5, correctionPersistence: 1,   analyticalThread: 1,   threadIsolation: 2 },
  RCI:  { filterPersistence: 1.5, entityContinuity: 1, correctionPersistence: 1,   analyticalThread: 1.5, callbackResolution: 1.5 },
  SNCJ: { filterPersistence: 0.5, entityContinuity: 2, correctionPersistence: 1.5, analyticalThread: 1,   schemaGrounding: 2 },
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  filterPersistence: 1, entityContinuity: 1, correctionPersistence: 1, analyticalThread: 1,
};

function getWeights(conversationType: string): Record<string, number> {
  return DIMENSION_WEIGHTS[conversationType.toUpperCase()] ?? DEFAULT_WEIGHTS;
}

function computeWeightedOverall(
  dims: GeminiJudgeResult['dimensions'],
  weights: Record<string, number>,
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const dim = dims[key as keyof typeof dims];
    if (dim !== undefined) {
      weightedSum += dim.score * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 2 * 100) / 100;
}

// ── extra dimension per conversation type ─────────────────────────────────

type ExtraDimKey = 'callbackResolution' | 'threadIsolation' | 'schemaGrounding';

function getExtraDimension(conversationType: string): ExtraDimKey | null {
  const t = conversationType.toUpperCase();
  if (t === 'DCS' || t === 'RCI') return 'callbackResolution';
  if (t === 'PTA') return 'threadIsolation';
  if (t === 'SNCJ') return 'schemaGrounding';
  return null;
}

const EXTRA_DIM_LABEL: Record<ExtraDimKey, string> = {
  callbackResolution: 'callbackResolution',
  threadIsolation: 'threadIsolation',
  schemaGrounding: 'schemaGrounding',
};

const EXTRA_DIM_DESCRIPTION: Record<ExtraDimKey, string> = {
  callbackResolution:
    'Did the re-run correctly recall and apply a specific fact or value established in a turn far before the compression boundary? (0 = fact completely missing, 5 = fact correctly retrieved and applied)',
  threadIsolation:
    'Were thread-specific corrections correctly isolated? Corrections for Thread A must NOT appear in Thread B queries, and vice versa. (0 = bleed across threads, 5 = perfect isolation)',
  schemaGrounding:
    'Did the re-run use correct table and column names from schema exploration in earlier turns? (0 = hallucinated schema, 5 = correct schema grounding throughout)',
};

// ── relevant callbacks / refs for this turn ───────────────────────────────

function formatRelevantRefs(
  callbacks: BenchmarkSession['callbacks'],
  anaphoricRefs: BenchmarkSession['anaphoricReferences'],
  evaluatedTurnNumber: number,
): string {
  const lines: string[] = [];
  for (const cb of callbacks) {
    if (cb.sourceTurn === evaluatedTurnNumber) {
      lines.push(
        `- Turn ${cb.sourceTurn} → Turn ${cb.targetTurn} [${cb.callbackType}]: expected entity = "${cb.expectedEntity}"${cb.crossesCompressionBoundary ? ' (CROSSES compression boundary)' : ''}`,
      );
    }
  }
  for (const ref of anaphoricRefs) {
    if (ref.sourceTurn === evaluatedTurnNumber) {
      lines.push(
        `- Turn ${ref.sourceTurn} → Turn ${ref.targetTurn}: phrase "${ref.phrase}" should resolve to "${ref.expectedResolution}"${ref.crossesCompressionBoundary ? ' (CROSSES compression boundary)' : ''}`,
      );
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(none for this turn)';
}

// ── Gemini judge ──────────────────────────────────────────────────────────

async function geminiJudge(args: {
  sessionTurns: BenchmarkSession['turns'];
  compressionSummary: string;
  compressionBoundaryTurn: number;
  userMessage: string;
  rerunResponse: string;
  rerunSQL: string[];
  referenceResponse: string;
  referenceSQL: string[];
  persistedCorrections: BenchmarkSession['persistedCorrections'];
  anaphoricReferences: BenchmarkSession['anaphoricReferences'];
  callbacks: BenchmarkSession['callbacks'];
  conversationType: string;
  evaluatedTurnNumber: number;
}): Promise<GeminiJudgeResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping Gemini judge');
    return null;
  }

  const weights = getWeights(args.conversationType);
  const extraDimKey = getExtraDimension(args.conversationType);
  const convTypeContext = CONV_TYPE_CONTEXT[args.conversationType.toUpperCase()] ?? '';

  const historyText = args.sessionTurns
    .map((t) => `Turn ${t.turnNumber} [User]: ${t.content}`)
    .join('\n');

  const correctionsBlock = args.persistedCorrections.length > 0
    ? args.persistedCorrections
        .map((c) => `- Turn ${c.turnEstablished} [${c.type}]: "${c.correctionText}"`)
        .join('\n')
    : '(none)';

  const refsBlock = formatRelevantRefs(
    args.callbacks,
    args.anaphoricReferences,
    args.evaluatedTurnNumber,
  );

  // Build the type-specific extra dimension block
  const extraDimBlock = extraDimKey
    ? `\n- **${EXTRA_DIM_LABEL[extraDimKey]}**: ${EXTRA_DIM_DESCRIPTION[extraDimKey]}`
    : '';

  const extraDimJsonField = extraDimKey
    ? `\n    "${EXTRA_DIM_LABEL[extraDimKey]}": { "score": <0-5>, "reasoning": "<one sentence>" },`
    : '';

  // New failure category tags relevant to this type
  const typeFailureTags = (() => {
    const t = args.conversationType.toUpperCase();
    if (t === 'PTA') return `\n- \`thread_bleed\` — a correction specific to Thread A was applied in Thread B or vice versa`;
    if (t === 'DCS' || t === 'RCI') return `\n- \`callback_miss\` — the agent failed to recall a specific fact from a distant turn`;
    if (t === 'SNCJ') return `\n- \`schema_hallucination\` — the agent referenced a table or column that does not exist`;
    if (t === 'RCI') return `\n- \`dead_end_regression\` — the agent re-pursued a hypothesis already ruled out`;
    return '';
  })();

  const prompt = `You are evaluating an AI analytics agent that operates on SQL databases.

## Full Conversation Ground Truth (Turns 1–${args.sessionTurns.length})
${historyText}

## Compression Summary (replaced turns 1–${args.compressionBoundaryTurn} of the conversation above)
${args.compressionSummary}

## Established Corrections (Ground Truth — from session annotations, not inferred)
These corrections were explicitly established in the session and MUST be present in any faithful compression:
${correctionsBlock}

## Active References for This Turn (cross-boundary callbacks/anaphora, if any)
${refsBlock}

## Session Type: ${args.conversationType}
${convTypeContext}

## Turn Being Evaluated
User: ${args.userMessage}

## Re-run Agent Response (given ONLY the compressed summary as prior context):
${args.rerunResponse}
SQL: ${args.rerunSQL.length > 0 ? args.rerunSQL.join('\n---\n') : '(none)'}

## Reference Agent Response (original run with full accumulated context):
${args.referenceResponse}
SQL: ${args.referenceSQL.length > 0 ? args.referenceSQL.join('\n---\n') : '(none)'}

## Your Task
Score the RE-RUN response on the dimensions below (0–5 each), then tag any failure categories.
Use the "Established Corrections" list above as definitive ground truth — do not infer constraints from the conversation text.

### Dimensions (0 = completely absent, 5 = perfectly preserved)
- **filterPersistence**: Did the re-run apply all established filters and exclusion rules listed in "Established Corrections"?
- **entityContinuity**: Did the re-run reference the correct entities — date ranges, named groups, categories, segments?
- **correctionPersistence**: Did the re-run respect ALL explicit corrections from "Established Corrections" (column preferences, exclusions, date conventions)?
- **analyticalThread**: Does the re-run understand *what is being investigated* — the trend, comparison, or root cause established in the conversation?${extraDimBlock}

### Failure Categories (include all that apply, or use ["none"] if no failures)
- \`filter_drift\` — an established filter was omitted or wrong
- \`entity_confusion\` — wrong entity, date range, or category referenced
- \`baseline_loss\` — a prior baseline value or analytical reference was not retained
- \`correction_ignored\` — an explicit user correction from an earlier turn was not applied${typeFailureTags}

Respond ONLY with valid JSON matching this exact shape:
{
  "dimensions": {
    "filterPersistence":      { "score": <0-5>, "reasoning": "<one sentence>" },
    "entityContinuity":       { "score": <0-5>, "reasoning": "<one sentence>" },
    "correctionPersistence":  { "score": <0-5>, "reasoning": "<one sentence>" },
    "analyticalThread":       { "score": <0-5>, "reasoning": "<one sentence>" }${extraDimJsonField}
  },
  "failureCategories": ["<category>" | "none"]
}`;

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const MAX_RETRIES = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
      console.warn(`  Gemini 503 — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      let text = (response.text ?? '').trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

      const raw = JSON.parse(text) as {
        dimensions: Record<string, { score: number; reasoning: string }>;
        failureCategories: string[];
      };

      const dims = raw.dimensions;
      if (!dims?.filterPersistence || !dims?.entityContinuity || !dims?.correctionPersistence || !dims?.analyticalThread) {
        throw new Error('Unexpected response shape — missing core dimensions');
      }

      const resultDims: GeminiJudgeResult['dimensions'] = {
        filterPersistence: dims.filterPersistence!,
        entityContinuity: dims.entityContinuity!,
        correctionPersistence: dims.correctionPersistence!,
        analyticalThread: dims.analyticalThread!,
      };

      if (extraDimKey && dims[EXTRA_DIM_LABEL[extraDimKey]]) {
        (resultDims as Record<string, { score: number; reasoning: string }>)[extraDimKey] =
          dims[EXTRA_DIM_LABEL[extraDimKey]]!;
      }

      const overall = computeWeightedOverall(resultDims, weights);

      return {
        dimensions: resultDims,
        failureCategories: (raw.failureCategories ?? ['none']) as GeminiJudgeResult['failureCategories'],
        overall,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is503 = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');
      lastErr = err;
      if (!is503 || attempt === MAX_RETRIES - 1) break;
    }
  }

  console.warn(`Gemini judge error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  return null;
}

// ── entity state accuracy (4-zone only) ──────────────────────────────────

function computeEntityStateAccuracy(
  persistedCorrections: BenchmarkSession['persistedCorrections'],
  zonesSnapshot: ZoneSnapshot | undefined,
): number | null {
  if (!zonesSnapshot || persistedCorrections.length === 0) return null;
  const seg = zonesSnapshot.entityState?.segments?.[0];
  if (!seg) return null;
  const raw = seg.content?.raw;
  if (!raw) return null;

  let state: { activeFilters?: unknown[]; userCorrections?: string[] };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch {
    return null;
  }

  // Search the full raw JSON string (lowercased) — this covers column names in activeFilters,
  // values, userCorrections, etc. without needing to deserialize sub-fields.
  const captured = raw.toLowerCase();

  const matched = persistedCorrections.filter((c) => {
    // Extract significant words from the correction text (skip short tokens and punctuation)
    const keywords = c.correctionText
      .toLowerCase()
      .split(/[\s='"(),[\]{}]+/)
      .filter((w) => w.length > 4);
    return keywords.some((kw) => captured.includes(kw));
  }).length;

  return matched / persistedCorrections.length;
}

// ── agent re-execution ────────────────────────────────────────────────────

interface ZonesContext {
  zoneA?: string;       // schema raw
  zoneB?: string;       // entity state raw JSON
  zoneC: Array<{ userMessage: string; agentResponse: string }>; // recent turns
}

async function rerunTurnWithSummary(args: {
  compressionSummary: string;
  userMessage: string;
  model: string;
  repositories: Awaited<ReturnType<typeof createBenchmarkRepositories>>;
  datasourceId: string;
  zonesContext?: ZonesContext; // provided for 4-zone runs
}): Promise<TurnResult | null> {
  const conversationId = uuidv4();
  const conversationSlug = `verify-${Date.now()}`;

  // For plain: [Zone-D-summary, user-question]
  // For 4zone:  [Zone-A-schema, Zone-B-state, Zone-D-summary, ...Zone-C-turns, user-question]
  // This mirrors what the real agent receives in each mode.
  const syntheticMessages: UIMessage[] = [];

  if (args.zonesContext) {
    const { zoneA, zoneB, zoneC } = args.zonesContext;
    if (zoneA) {
      syntheticMessages.push({
        id: uuidv4(),
        role: 'assistant',
        parts: [{ type: 'text', text: `## Database Schema\n${zoneA}` }],
      });
    }
    if (zoneB) {
      syntheticMessages.push({
        id: uuidv4(),
        role: 'assistant',
        parts: [{ type: 'text', text: `## Current Analysis State (active filters, corrections, entities)\n${zoneB}` }],
      });
    }
    // Zone D: compressed archive
    syntheticMessages.push({
      id: uuidv4(),
      role: 'assistant',
      parts: [{ type: 'text', text: args.compressionSummary }],
    });
    // Zone C: recent full-fidelity turns
    for (const turn of zoneC) {
      syntheticMessages.push({ id: uuidv4(), role: 'user', parts: [{ type: 'text', text: turn.userMessage }] });
      syntheticMessages.push({ id: uuidv4(), role: 'assistant', parts: [{ type: 'text', text: turn.agentResponse }] });
    }
  } else {
    syntheticMessages.push({
      id: uuidv4(),
      role: 'assistant',
      parts: [{ type: 'text', text: args.compressionSummary }],
    });
  }

  syntheticMessages.push({
    id: uuidv4(),
    role: 'user',
    parts: [{ type: 'text', text: args.userMessage }],
  });

  try {
    const agentResult = await runAgentToCompletion({
      conversationId,
      conversationSlug,
      messages: syntheticMessages,
      agentId: 'query',
      model: args.model,
      repositories: args.repositories,
      abortSignal: new AbortController().signal,
      maxSteps: 10,
      datasources: [args.datasourceId],
    });

    const allParts = agentResult.messages
      .filter((m: { role: string }) => m.role === 'assistant')
      .flatMap((m: { parts?: unknown[] }) => (m.parts ?? []) as Parameters<typeof extractToolCallsFromParts>[0]);

    const toolCalls = extractToolCallsFromParts(allParts);
    const agentResponse = agentResult.messages
      .filter((m: { role: string }) => m.role === 'assistant')
      .flatMap((m: { parts?: unknown[] }) =>
        (m.parts ?? [])
          .filter((p: unknown) => (p as { type?: string }).type === 'text')
          .map((p: unknown) => (p as { text?: string }).text ?? ''),
      )
      .join('\n');

    return {
      turnNumber: 0,
      userMessage: args.userMessage,
      assistantMessages: [],
      agentResponse,
      toolCalls,
      responseTimeMs: 0,
      inputTokens: agentResult.usage?.promptTokens ?? 0,
      outputTokens: agentResult.usage?.completionTokens ?? 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cost: 0,
    };
  } catch (err) {
    console.warn(`Agent re-run failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── session JSON path resolution ──────────────────────────────────────────

function resolveSessionPath(result: BenchmarkResult): string {
  return join(
    __dirname,
    '..',
    'data',
    'sessions',
    result.database,
    result.conversationType.toLowerCase(),
    `${result.sessionId}.json`,
  );
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  await loadBenchmarkEnv();

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      result: { type: 'string' },
      'connection-string': { type: 'string' },
      sample: { type: 'string', default: '5' },
      model: { type: 'string', default: 'ollama-cloud/minimax-m2.5' },
      patch: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const resultPath = values['result'];
  const connectionString = values['connection-string'];

  if (!resultPath || !connectionString) {
    console.error('Usage: pnpm verify:consistency --result <path> --connection-string <pg-url> [--sample 5] [--model <model>] [--patch]');
    process.exit(1);
  }

  const sampleSize = parseInt(values['sample'] ?? '5', 10);
  const model = values['model'] ?? 'ollama-cloud/minimax-m2.5';
  const shouldPatch = values['patch'] ?? false;

  const result = JSON.parse(await readFile(resultPath, 'utf-8')) as BenchmarkResult;

  const sessionPath = resolveSessionPath(result);
  let session: BenchmarkSession;
  try {
    session = JSON.parse(await readFile(sessionPath, 'utf-8')) as BenchmarkSession;
  } catch {
    console.error(`Could not load session JSON at: ${sessionPath}`);
    process.exit(1);
  }

  const compactionTurn = result.turns.find((t) => t.compactionEvent?.summaryText);
  if (!compactionTurn) {
    console.log('No compaction event with summaryText found — nothing to test.');
    console.log('(Entity-state strategies use structuredState; support can be added later.)');
    process.exit(0);
  }

  const compressionSummary = compactionTurn.compactionEvent!.summaryText!;
  const compressionBoundaryTurn = compactionTurn.turnNumber;
  const conversationType = result.conversationType;

  const postCompactionTurns = result.turns.filter(
    (t) =>
      t.turnNumber > compressionBoundaryTurn &&
      t.toolCalls.some((tc) => tc.toolName === 'runQuery'),
  );

  if (postCompactionTurns.length === 0) {
    console.log('No post-compaction turns with runQuery calls found.');
    process.exit(0);
  }

  const sampled =
    postCompactionTurns.length <= sampleSize
      ? postCompactionTurns
      : (() => {
          const step = Math.floor(postCompactionTurns.length / sampleSize);
          return Array.from({ length: sampleSize }, (_, i) => postCompactionTurns[i * step]!);
        })();

  const is4Zone = result.contextMode === '4zone';

  console.log(`\n=== Consistency Check: ${result.sessionId} (${result.compressionMethod}/${result.contextMode}) ===`);
  console.log(`Session type: ${conversationType}`);
  console.log(`Compression boundary: turn ${compressionBoundaryTurn}`);
  console.log(`Persisted corrections: ${session.persistedCorrections.length}`);
  console.log(`Post-compaction turns with queries: ${postCompactionTurns.length}`);
  console.log(`Sampling ${sampled.length} turns`);
  if (is4Zone) console.log('4-zone mode: entityStateAccuracy will be computed');
  console.log();

  const storageDir = join(__dirname, '..', 'data', `verify-${Date.now()}.db`);
  const repositories = await createBenchmarkRepositories(storageDir);

  const url = new URL(connectionString);
  const datasourceId = await ensureDatasource(repositories, 'verify-datasource', 'postgresql', {
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.slice(1),
    username: url.username,
    password: url.password,
  });

  let totalQueries = 0;
  let exactMatches = 0;
  let rowCountMatches = 0;
  const perTurnJudgments: GeminiJudgeResult[] = [];
  const perTurnDetails: Array<{ turnNumber: number } & GeminiJudgeResult> = [];
  const entityStateAccuracies: number[] = [];

  try {
    for (const refTurn of sampled) {
      const refSQLCalls = refTurn.toolCalls.filter((tc) => tc.toolName === 'runQuery');
      console.log(`\n── Turn ${refTurn.turnNumber} ──`);
      console.log(`User: ${refTurn.userMessage.slice(0, 120)}${refTurn.userMessage.length > 120 ? '…' : ''}`);

      // Entity state accuracy for 4-zone runs
      if (is4Zone && refTurn.zonesSnapshot) {
        const acc = computeEntityStateAccuracy(session.persistedCorrections, refTurn.zonesSnapshot);
        if (acc !== null) {
          entityStateAccuracies.push(acc);
          console.log(`  Zone B entity state accuracy: ${(acc * 100).toFixed(0)}% of corrections captured`);
        }
      }

      // Build zone context for 4-zone re-runs so the agent sees what it really would have seen
      let zonesContext: ZonesContext | undefined;
      if (is4Zone && refTurn.zonesSnapshot) {
        const snap = refTurn.zonesSnapshot;
        const zoneA = snap.schemaAndConstraints?.segments?.[0]?.content?.raw;
        const zoneB = snap.entityState?.segments?.[0]?.content?.raw;
        const zoneCNums = new Set(snap.activeWindow?.turnNumbers ?? []);
        const zoneC = result.turns
          .filter((t) => zoneCNums.has(t.turnNumber) && t.turnNumber < refTurn.turnNumber)
          .sort((a, b) => a.turnNumber - b.turnNumber)
          .map((t) => ({ userMessage: t.userMessage, agentResponse: t.agentResponse }));
        zonesContext = { zoneA, zoneB, zoneC };
        console.log(`  Zone C turns included in re-run: [${[...zoneCNums].filter(n => n < refTurn.turnNumber).sort((a,b)=>a-b).join(', ')}]`);
      }

      const rerun = await rerunTurnWithSummary({
        compressionSummary,
        userMessage: refTurn.userMessage,
        model,
        repositories,
        datasourceId,
        zonesContext,
      });

      const rerunSQLCalls = rerun ? rerun.toolCalls.filter((tc) => tc.toolName === 'runQuery') : [];
      const rerunSQLStrings = rerunSQLCalls.map((tc) => String(tc.toolInput['query'] ?? ''));
      const refSQLStrings = refSQLCalls.map((tc) => String(tc.toolInput['query'] ?? ''));

      for (let i = 0; i < refSQLCalls.length; i++) {
        const refCall = refSQLCalls[i]!;
        const rerunCall = rerunSQLCalls[i] ?? rerunSQLCalls[0];
        totalQueries++;

        const refSQL = String(refCall.toolInput['query'] ?? '');
        const rerunSQL = rerunCall ? String(rerunCall.toolInput['query'] ?? '') : '';

        const exact = rerunSQL && normalizeSql(refSQL) === normalizeSql(rerunSQL);
        if (exact) exactMatches++;

        const refRows = await executeSQL(connectionString, refSQL);
        const rerunRows = rerunSQL ? await executeSQL(connectionString, rerunSQL) : { rowCount: null };

        const rowMatch =
          refRows.rowCount !== null &&
          rerunRows.rowCount !== null &&
          refRows.rowCount === rerunRows.rowCount;
        if (rowMatch) rowCountMatches++;

        console.log(
          `  Query ${i + 1}: exact=${exact ? 'YES' : 'NO'} | rows ref=${refRows.rowCount ?? 'err'} rerun=${rerunRows.rowCount ?? 'err'} match=${rowMatch ? 'YES' : 'NO'}`,
        );
      }

      // Gemini multi-dimension judge
      const judgment = await geminiJudge({
        sessionTurns: session.turns.filter((t) => t.turnNumber <= refTurn.turnNumber),
        compressionSummary,
        compressionBoundaryTurn,
        userMessage: refTurn.userMessage,
        rerunResponse: rerun?.agentResponse ?? '(agent failed to respond)',
        rerunSQL: rerunSQLStrings,
        referenceResponse: refTurn.agentResponse,
        referenceSQL: refSQLStrings,
        persistedCorrections: session.persistedCorrections,
        anaphoricReferences: session.anaphoricReferences,
        callbacks: session.callbacks,
        conversationType,
        evaluatedTurnNumber: refTurn.turnNumber,
      });

      if (judgment) {
        perTurnJudgments.push(judgment);
        perTurnDetails.push({ turnNumber: refTurn.turnNumber, ...judgment });
        const { dimensions: d, failureCategories: fc, overall } = judgment;
        console.log(`  Gemini overall: ${overall.toFixed(1)}/10`);
        console.log(`    filter_persistence:     ${d.filterPersistence.score}/5 — ${d.filterPersistence.reasoning}`);
        console.log(`    entity_continuity:      ${d.entityContinuity.score}/5 — ${d.entityContinuity.reasoning}`);
        console.log(`    correction_persistence: ${d.correctionPersistence.score}/5 — ${d.correctionPersistence.reasoning}`);
        console.log(`    analytical_thread:      ${d.analyticalThread.score}/5 — ${d.analyticalThread.reasoning}`);
        if (d.callbackResolution) console.log(`    callback_resolution:    ${d.callbackResolution.score}/5 — ${d.callbackResolution.reasoning}`);
        if (d.threadIsolation)    console.log(`    thread_isolation:       ${d.threadIsolation.score}/5 — ${d.threadIsolation.reasoning}`);
        if (d.schemaGrounding)    console.log(`    schema_grounding:       ${d.schemaGrounding.score}/5 — ${d.schemaGrounding.reasoning}`);
        const failures = fc.filter((c) => c !== 'none');
        if (failures.length > 0) console.log(`    failures: ${failures.join(', ')}`);
      }
    }

    // Aggregate
    const queryConsistencyRate = totalQueries > 0 ? rowCountMatches / totalQueries : null;
    const exactMatchRate = totalQueries > 0 ? exactMatches / totalQueries : null;

    const avgScore = (key: string) =>
      perTurnJudgments.length > 0
        ? Math.round(
            (perTurnJudgments.reduce((s, j) => {
              const dim = j.dimensions[key as keyof typeof j.dimensions];
              return s + (dim?.score ?? 0);
            }, 0) /
              perTurnJudgments.length) *
              100,
          ) / 100
        : null;

    const geminiOverall =
      perTurnJudgments.length > 0
        ? Math.round(
            (perTurnJudgments.reduce((s, j) => s + j.overall, 0) / perTurnJudgments.length) * 100,
          ) / 100
        : null;

    const entityStateAccuracy =
      entityStateAccuracies.length > 0
        ? Math.round(
            (entityStateAccuracies.reduce((s, v) => s + v, 0) / entityStateAccuracies.length) * 1000,
          ) / 1000
        : null;

    const allFailures = perTurnJudgments.flatMap((j) => j.failureCategories.filter((c) => c !== 'none'));
    const failureCounts: Record<string, number> = {};
    for (const f of allFailures) failureCounts[f] = (failureCounts[f] ?? 0) + 1;

    console.log('\n=== Summary ===');
    console.log(`Sampled turns: ${sampled.length}  |  Queries evaluated: ${totalQueries}`);
    if (exactMatchRate !== null)
      console.log(`SQL exact match rate:         ${(exactMatchRate * 100).toFixed(1)}%`);
    if (queryConsistencyRate !== null)
      console.log(`Row-count match rate:         ${(queryConsistencyRate * 100).toFixed(1)}%`);
    if (entityStateAccuracy !== null)
      console.log(`Zone B entity state accuracy: ${(entityStateAccuracy * 100).toFixed(0)}% of corrections captured`);
    if (geminiOverall !== null) {
      console.log(`\nGemini context score:         ${geminiOverall.toFixed(2)} / 10`);
      console.log(`  filter_persistence:         ${avgScore('filterPersistence')?.toFixed(2) ?? 'n/a'} / 5`);
      console.log(`  entity_continuity:          ${avgScore('entityContinuity')?.toFixed(2) ?? 'n/a'} / 5`);
      console.log(`  correction_persistence:     ${avgScore('correctionPersistence')?.toFixed(2) ?? 'n/a'} / 5`);
      console.log(`  analytical_thread:          ${avgScore('analyticalThread')?.toFixed(2) ?? 'n/a'} / 5`);
      if (getExtraDimension(conversationType) === 'callbackResolution')
        console.log(`  callback_resolution:        ${avgScore('callbackResolution')?.toFixed(2) ?? 'n/a'} / 5`);
      if (getExtraDimension(conversationType) === 'threadIsolation')
        console.log(`  thread_isolation:           ${avgScore('threadIsolation')?.toFixed(2) ?? 'n/a'} / 5`);
      if (getExtraDimension(conversationType) === 'schemaGrounding')
        console.log(`  schema_grounding:           ${avgScore('schemaGrounding')?.toFixed(2) ?? 'n/a'} / 5`);
      if (Object.keys(failureCounts).length > 0) {
        console.log(`  failure categories:         ${Object.entries(failureCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);
      }
    }

    if (shouldPatch && (queryConsistencyRate !== null || geminiOverall !== null || entityStateAccuracy !== null)) {
      result.metrics.queryConsistencyRate = queryConsistencyRate !== null
        ? Math.round(queryConsistencyRate * 1000) / 1000
        : result.metrics.queryConsistencyRate;

      if (entityStateAccuracy !== null) {
        result.metrics.entityStateAccuracy = entityStateAccuracy;
      }

      if (perTurnJudgments.length > 0) {
        const buildAvgDim = (key: string) => ({
          score: avgScore(key) ?? 0,
          reasoning: `avg of ${perTurnJudgments.length} turns`,
        });
        const extraKey = getExtraDimension(conversationType);
        result.metrics.geminiJudge = {
          dimensions: {
            filterPersistence: buildAvgDim('filterPersistence'),
            entityContinuity: buildAvgDim('entityContinuity'),
            correctionPersistence: buildAvgDim('correctionPersistence'),
            analyticalThread: buildAvgDim('analyticalThread'),
            ...(extraKey ? { [extraKey]: buildAvgDim(extraKey) } : {}),
          },
          failureCategories: [...new Set(allFailures)] as GeminiJudgeResult['failureCategories'],
          overall: geminiOverall ?? 0,
        };
        result.metrics.geminiContextScore = geminiOverall;
        result.metrics.geminiJudgePerTurn = perTurnDetails;
      }

      await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`\nPatched result file: ${resultPath}`);
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
