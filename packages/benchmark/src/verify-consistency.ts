/**
 * Compression faithfulness test.
 *
 * For each sampled post-compaction turn:
 *  1. Re-run the benchmark model with ONLY [compressed-summary + user-turn] as context
 *  2. Compare generated SQL and row-count against the stored reference
 *  3. Send everything to Gemini (full 1M context) to score context preservation quality 0-10
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
import type { BenchmarkResult, BenchmarkSession, TurnResult, GeminiJudgeResult } from './types.js';
import { extractToolCallsFromParts } from './utils/extract-tool-calls.js';
import {
  createBenchmarkRepositories,
  ensureDatasource,
} from './runner.js';
import { runAgentToCompletion } from '@qwery/agent-factory-sdk/agents/run-agent-to-completion';
import type { UIMessage } from '@qwery/agent-factory-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env loading (same pattern as run-all.ts) ──────────────────────────────

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
  // Dynamically import pg to avoid a hard dependency when not re-executing
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(sql);
    // rows.length is always reliable for SELECT; rowCount is null for SELECT in some pg versions
    return { rowCount: result.rows.length };
  } catch (err) {
    return { rowCount: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => {});
  }
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
}): Promise<GeminiJudgeResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping Gemini judge');
    return null;
  }

  const historyText = args.sessionTurns
    .map((t) => `Turn ${t.turnNumber} [User]: ${t.content}`)
    .join('\n');

  const prompt = `You are evaluating an AI analytics agent that operates on SQL databases.

## Full Conversation Ground Truth (Turns 1–${args.sessionTurns.length})
${historyText}

## Compression Summary (replaced turns 1–${args.compressionBoundaryTurn} of the conversation above)
${args.compressionSummary}

## Turn Being Evaluated
User: ${args.userMessage}

## Re-run Agent Response (given ONLY the compressed summary as prior context):
${args.rerunResponse}
SQL: ${args.rerunSQL.length > 0 ? args.rerunSQL.join('\n---\n') : '(none)'}

## Reference Agent Response (original run with full accumulated context):
${args.referenceResponse}
SQL: ${args.referenceSQL.length > 0 ? args.referenceSQL.join('\n---\n') : '(none)'}

## Your Task
Score the RE-RUN response on four dimensions (0–5 each), then tag any failure categories.

### Dimensions (0 = completely absent, 5 = perfectly preserved)
- **filterPersistence**: Did the re-run apply all established filters and exclusion rules from earlier turns?
- **entityContinuity**: Did the re-run reference the correct entities — date ranges, named groups, categories, segments?
- **correctionPersistence**: Did the re-run respect explicit user corrections made in prior turns?
- **analyticalThread**: Does the re-run understand *what is being investigated* — the trend, comparison, or root cause established in the conversation?

### Failure Categories (include all that apply, or use ["none"] if no failures)
- \`filter_drift\` — an established filter was omitted or wrong
- \`entity_confusion\` — wrong entity, date range, or category referenced
- \`baseline_loss\` — a prior baseline value or analytical reference was not retained
- \`correction_ignored\` — an explicit user correction from an earlier turn was not applied

Respond ONLY with valid JSON matching this exact shape:
{
  "dimensions": {
    "filterPersistence":      { "score": <0-5>, "reasoning": "<one sentence>" },
    "entityContinuity":       { "score": <0-5>, "reasoning": "<one sentence>" },
    "correctionPersistence":  { "score": <0-5>, "reasoning": "<one sentence>" },
    "analyticalThread":       { "score": <0-5>, "reasoning": "<one sentence>" }
  },
  "failureCategories": ["<category>" | "none"]
}`;

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    let text = (response.text ?? '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

    const raw = JSON.parse(text) as {
      dimensions: {
        filterPersistence: { score: number; reasoning: string };
        entityContinuity: { score: number; reasoning: string };
        correctionPersistence: { score: number; reasoning: string };
        analyticalThread: { score: number; reasoning: string };
      };
      failureCategories: string[];
    };

    const dims = raw.dimensions;
    if (!dims?.filterPersistence || !dims?.entityContinuity || !dims?.correctionPersistence || !dims?.analyticalThread) {
      throw new Error('Unexpected response shape — missing dimensions');
    }

    const overall =
      Math.round(
        ((dims.filterPersistence.score +
          dims.entityContinuity.score +
          dims.correctionPersistence.score +
          dims.analyticalThread.score) /
          4) *
          2 *
          100,
      ) / 100;

    return {
      dimensions: {
        filterPersistence: dims.filterPersistence,
        entityContinuity: dims.entityContinuity,
        correctionPersistence: dims.correctionPersistence,
        analyticalThread: dims.analyticalThread,
      },
      failureCategories: (raw.failureCategories ?? ['none']) as GeminiJudgeResult['failureCategories'],
      overall,
    };
  } catch (err) {
    console.warn(`Gemini judge error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── agent re-execution ────────────────────────────────────────────────────

async function rerunTurnWithSummary(args: {
  compressionSummary: string;
  userMessage: string;
  model: string;
  repositories: Awaited<ReturnType<typeof createBenchmarkRepositories>>;
  datasourceId: string;
}): Promise<TurnResult | null> {
  const conversationId = uuidv4();
  const conversationSlug = `verify-${Date.now()}`;

  const syntheticMessages: UIMessage[] = [
    {
      id: uuidv4(),
      role: 'assistant',
      parts: [{ type: 'text', text: args.compressionSummary }],
    },
    {
      id: uuidv4(),
      role: 'user',
      parts: [{ type: 'text', text: args.userMessage }],
    },
  ];

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
        (m.parts ?? []).filter((p: unknown) => (p as { type?: string }).type === 'text').map((p: unknown) => (p as { text?: string }).text ?? ''),
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

  // Load result JSON
  const result = JSON.parse(await readFile(resultPath, 'utf-8')) as BenchmarkResult;

  // Load original session JSON
  const sessionPath = resolveSessionPath(result);
  let session: BenchmarkSession;
  try {
    session = JSON.parse(await readFile(sessionPath, 'utf-8')) as BenchmarkSession;
  } catch {
    console.error(`Could not load session JSON at: ${sessionPath}`);
    process.exit(1);
  }

  // Find compaction event
  const compactionTurn = result.turns.find((t) => t.compactionEvent?.summaryText);
  if (!compactionTurn) {
    console.log('No compaction event with summaryText found — nothing to test.');
    console.log('(Entity-state strategies use structuredState; support can be added later.)');
    process.exit(0);
  }

  const compressionSummary = compactionTurn.compactionEvent!.summaryText!;
  const compressionBoundaryTurn = compactionTurn.turnNumber;

  // Sample post-compaction turns that have runQuery calls
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

  console.log(`\n=== Consistency Check: ${result.sessionId} (${result.compressionMethod}) ===`);
  console.log(`Compression boundary: turn ${compressionBoundaryTurn}`);
  console.log(`Post-compaction turns with queries: ${postCompactionTurns.length}`);
  console.log(`Sampling ${sampled.length} turns\n`);

  // Set up benchmark infrastructure for agent re-execution
  const storageDir = join(__dirname, '..', 'data', `verify-${Date.now()}.db`);
  const repositories = await createBenchmarkRepositories(storageDir);

  // Parse connection string to get provider config for the agent datasource
  const url = new URL(connectionString);
  const datasourceId = await ensureDatasource(repositories, 'verify-datasource', 'postgresql', {
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.slice(1),
    username: url.username,
    password: url.password,
  });

  // Per-turn stats
  let totalQueries = 0;
  let exactMatches = 0;
  let rowCountMatches = 0;
  const perTurnJudgments: GeminiJudgeResult[] = [];

  try {
  for (const refTurn of sampled) {
    const refSQLCalls = refTurn.toolCalls.filter((tc) => tc.toolName === 'runQuery');
    console.log(`\n── Turn ${refTurn.turnNumber} ──`);
    console.log(`User: ${refTurn.userMessage.slice(0, 120)}${refTurn.userMessage.length > 120 ? '…' : ''}`);

    // Re-run agent with only [summary + this turn]
    const rerun = await rerunTurnWithSummary({
      compressionSummary,
      userMessage: refTurn.userMessage,
      model,
      repositories,
      datasourceId,
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
    });

    if (judgment) {
      perTurnJudgments.push(judgment);
      const { dimensions: d, failureCategories: fc, overall } = judgment;
      console.log(`  Gemini overall: ${overall.toFixed(1)}/10`);
      console.log(`    filter_persistence:     ${d.filterPersistence.score}/5 — ${d.filterPersistence.reasoning}`);
      console.log(`    entity_continuity:      ${d.entityContinuity.score}/5 — ${d.entityContinuity.reasoning}`);
      console.log(`    correction_persistence: ${d.correctionPersistence.score}/5 — ${d.correctionPersistence.reasoning}`);
      console.log(`    analytical_thread:      ${d.analyticalThread.score}/5 — ${d.analyticalThread.reasoning}`);
      const failures = fc.filter((c) => c !== 'none');
      if (failures.length > 0) console.log(`    failures: ${failures.join(', ')}`);
    }
  }

  // Aggregate
  const queryConsistencyRate = totalQueries > 0 ? rowCountMatches / totalQueries : null;
  const exactMatchRate = totalQueries > 0 ? exactMatches / totalQueries : null;

  const avgScore = (key: keyof GeminiJudgeResult['dimensions']) =>
    perTurnJudgments.length > 0
      ? Math.round((perTurnJudgments.reduce((s, j) => s + j.dimensions[key].score, 0) / perTurnJudgments.length) * 100) / 100
      : null;

  const geminiOverall =
    perTurnJudgments.length > 0
      ? Math.round((perTurnJudgments.reduce((s, j) => s + j.overall, 0) / perTurnJudgments.length) * 100) / 100
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
  if (geminiOverall !== null) {
    console.log(`\nGemini context score:         ${geminiOverall.toFixed(2)} / 10`);
    console.log(`  filter_persistence:         ${avgScore('filterPersistence')?.toFixed(2) ?? 'n/a'} / 5`);
    console.log(`  entity_continuity:          ${avgScore('entityContinuity')?.toFixed(2) ?? 'n/a'} / 5`);
    console.log(`  correction_persistence:     ${avgScore('correctionPersistence')?.toFixed(2) ?? 'n/a'} / 5`);
    console.log(`  analytical_thread:          ${avgScore('analyticalThread')?.toFixed(2) ?? 'n/a'} / 5`);
    if (Object.keys(failureCounts).length > 0) {
      console.log(`  failure categories:         ${Object.entries(failureCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }
  }

  if (shouldPatch && (queryConsistencyRate !== null || geminiOverall !== null)) {
    result.metrics.queryConsistencyRate = queryConsistencyRate !== null
      ? Math.round(queryConsistencyRate * 1000) / 1000
      : null;

    if (perTurnJudgments.length > 0) {
      // Build session-level aggregate judge result
      const buildAvgDim = (key: keyof GeminiJudgeResult['dimensions']) => ({
        score: avgScore(key) ?? 0,
        reasoning: `avg of ${perTurnJudgments.length} turns`,
      });
      result.metrics.geminiJudge = {
        dimensions: {
          filterPersistence: buildAvgDim('filterPersistence'),
          entityContinuity: buildAvgDim('entityContinuity'),
          correctionPersistence: buildAvgDim('correctionPersistence'),
          analyticalThread: buildAvgDim('analyticalThread'),
        },
        failureCategories: [...new Set(allFailures)] as GeminiJudgeResult['failureCategories'],
        overall: geminiOverall ?? 0,
      };
      result.metrics.geminiContextScore = geminiOverall;
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
