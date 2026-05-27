import type {
  BenchmarkSession,
  BenchmarkResult,
  TurnResult,
  ToolCallResult,
  SessionMetrics,
  CompressionMethod,
  ContextMode,
  StoredMessage,
  StoredUsage,
  MessagePartDetail,
  AssistantMessageDetail,
  AnaphoricReference,
  BenchmarkCallback,
} from './types.js';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Message, Usage } from '@qwery/domain/entities';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadSession(filePath: string): Promise<BenchmarkSession> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as BenchmarkSession;
}

export async function loadAllSessions(
  database?: string,
  type?: string,
): Promise<BenchmarkSession[]> {
  const sessions: BenchmarkSession[] = [];
  const baseDir = join(__dirname, '..', 'data', 'sessions');

  const dbs = database ? [database] : ['tpch', 'saas'];

  for (const db of dbs) {
    const dbDir = join(baseDir, db);
    try {
      const types = type ? [type.toLowerCase()] : await readdir(dbDir);

      for (const convType of types) {
        const typeDir = join(dbDir, convType);
        try {
          const files = await readdir(typeDir);
          for (const file of files.filter((f: string) => f.endsWith('.json'))) {
            const session = await loadSession(join(typeDir, file));
            sessions.push(session);
          }
        } catch {
          // Directory doesn't exist
        }
      }
    } catch {
      // Database directory doesn't exist
    }
  }

  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveResult(
  result: BenchmarkResult,
  compressionMethod: CompressionMethod = 'baseline-no-compression',
  contextMode: ContextMode = 'plain',
): Promise<string> {
  const baseDir = join(__dirname, '..', 'data', 'results', compressionMethod, contextMode);
  const resultDir = join(
    baseDir,
    result.database,
    result.conversationType.toLowerCase(),
  );

  await mkdir(resultDir, { recursive: true });

  const filePath = join(resultDir, `${result.sessionId}.json`);
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');

  return filePath;
}

export function calculateMetrics(
  turns: TurnResult[],
  session?: BenchmarkSession,
): SessionMetrics {
  const totalTurns = turns.length;
  const totalInputTokens = turns.reduce((sum, t) => sum + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((sum, t) => sum + t.outputTokens, 0);
  const totalReasoningTokens = turns.reduce(
    (sum, t) => sum + t.reasoningTokens,
    0,
  );
  const totalCachedInputTokens = turns.reduce(
    (sum, t) => sum + t.cachedInputTokens,
    0,
  );
  const totalCost = turns.reduce((sum, t) => sum + t.cost, 0);
  const totalResponseTimeMs = turns.reduce(
    (sum, t) => sum + t.responseTimeMs,
    0,
  );
  const totalToolCalls = turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
  const failedToolCalls = turns.reduce(
    (sum, t) => sum + t.toolCalls.filter((tc) => !tc.success).length,
    0,
  );

  // Collect all compaction events across the session
  const allCompactionEvents = turns
    .filter((t) => t.compactionEvent)
    .map((t) => t.compactionEvent);

  const firstCompactionTurn = turns.find((t) => t.compactionEvent);
  const compactionLatencyMs = firstCompactionTurn?.compactionEvent?.latencyMs ?? null;

  // Calculate average compression ratio across all compaction events.
  // Prefer a strategy-reported ratio (e.g. in-place compactors like llmlingua-2)
  // and fall back to the summaryTokens/preCompactionTokens heuristic.
  const validEvents = allCompactionEvents.filter(
    (e): e is NonNullable<typeof e> =>
      !!e &&
      (typeof e.reportedRatio === 'number' ||
        (typeof e.preCompactionTokens === 'number' &&
          typeof e.summaryTokens === 'number')),
  );

  const compressionRatio =
    validEvents.length > 0
      ? Math.round(
          (validEvents.reduce(
            (sum, e) =>
              sum +
              (typeof e.reportedRatio === 'number'
                ? e.reportedRatio
                : e.summaryTokens! / e.preCompactionTokens!),
            0,
          ) /
            validEvents.length) *
            1000,
        ) / 1000
      : null;

  // --- Quality metrics (require session annotations) ---

  // Metric 1: Filter Persistence Rate
  // For each persistedCorrection, check whether post-boundary turns honor it.
  // "Honored" = correction keywords appear in agentResponse or SQL tool inputs.
  let filterPersistenceRate: number | null = null;
  if (session && session.persistedCorrections.length > 0) {
    const boundary = session.metadata.compressionBoundaryTurn;
    const postTurns = turns.filter((t) => t.turnNumber > boundary);
    if (postTurns.length > 0) {
      let honored = 0;
      let total = 0;
      for (const correction of session.persistedCorrections) {
        const keywords = correction.correctionText
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        for (const turn of postTurns) {
          total++;
          const text = (
            turn.agentResponse +
            ' ' +
            turn.toolCalls.map((tc) => JSON.stringify(tc.toolInput)).join(' ')
          ).toLowerCase();
          if (keywords.some((kw) => text.includes(kw))) honored++;
        }
      }
      filterPersistenceRate = total > 0 ? Math.round((honored / total) * 1000) / 1000 : null;
    }
  }

  // Metric 2: Reference Resolution Rate
  // For callbacks and anaphoric references that cross the compression boundary,
  // check if the expected entity/resolution keywords appear in the response.
  let referenceResolutionAccuracy: number | null = null;
  if (session) {
    const crossBoundaryRefs = [
      ...session.callbacks.filter((c) => c.crossesCompressionBoundary),
      ...(session.anaphoricReferences ?? []).filter((a) => a.crossesCompressionBoundary),
    ];
    if (crossBoundaryRefs.length > 0) {
      let resolved = 0;
      for (const ref of crossBoundaryRefs) {
        const turn = turns.find((t) => t.turnNumber === ref.sourceTurn);
        if (!turn) continue;
        const expected =
          'expectedEntity' in ref
            ? (ref as BenchmarkCallback).expectedEntity
            : (ref as AnaphoricReference).expectedResolution;
        const keywords = expected
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        if (keywords.some((kw) => turn.agentResponse.toLowerCase().includes(kw))) {
          resolved++;
        }
      }
      referenceResolutionAccuracy =
        Math.round((resolved / crossBoundaryRefs.length) * 1000) / 1000;
    }
  }

  // Metric 3: Tool Success Rate
  // % of turns where all runQuery calls succeeded. Requires Fix 1 (toolName inference).
  let toolSuccessRate: number | null = null;
  const turnsWithTools = turns.filter((t) => t.toolCalls.length > 0);
  if (turnsWithTools.length > 0) {
    const successTurns = turnsWithTools.filter((t) => {
      const queryTools = t.toolCalls.filter((tc) => tc.toolName === 'runQuery');
      return queryTools.length === 0 || queryTools.every((tc) => tc.success);
    }).length;
    toolSuccessRate = Math.round((successTurns / turnsWithTools.length) * 1000) / 1000;
  }

  return {
    totalTurns,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalCachedInputTokens,
    totalCost,
    totalResponseTimeMs,
    totalToolCalls,
    failedToolCalls,
    avgResponseTimeMs:
      totalTurns > 0 ? Math.round(totalResponseTimeMs / totalTurns) : 0,
    avgToolCallsPerTurn:
      totalTurns > 0
        ? Math.round((totalToolCalls / totalTurns) * 100) / 100
        : 0,
    filterPersistenceRate,
    entityRecallAccuracy: null,
    referenceResolutionAccuracy,
    toolSuccessRate,
    compressionRatio,
    compactionLatencyMs,
  };
}

export function convertMessageToStored(message: Message): StoredMessage {
  const parts = (message.content?.parts ?? []).map(
    (part): MessagePartDetail => {
      if (part.type === 'text') {
        return {
          type: 'text',
          text: (part as { text: string }).text,
          state: (part as { state?: 'streaming' | 'done' }).state,
        };
      }
      if (part.type === 'reasoning') {
        return {
          type: 'reasoning',
          text: (part as { text: string }).text,
          state: (part as { state?: 'streaming' | 'done' }).state,
        };
      }
      if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
        return {
          type: part.type as `tool-${string}`,
          toolCallId: (part as { toolCallId?: string }).toolCallId,
          toolName: (part as { toolName?: string }).toolName,
          input: (part as { input?: Record<string, unknown> }).input,
          output: (part as { output?: unknown }).output,
          state: (part as { state?: string }).state,
          errorText: (part as { errorText?: string }).errorText,
          isError: (part as { isError?: boolean }).isError,
        };
      }
      if (part.type === 'step-start') {
        return { type: 'step-start' };
      }
      if (part.type === 'step-finish') {
        const stepFinishPart = part as {
          reason?: string;
          tokens?: {
            input: number;
            output: number;
            reasoning?: number;
            cache?: { read: number; write: number };
          };
          cost?: number;
        };
        return {
          type: 'step-finish',
          reason: stepFinishPart.reason,
          tokens: stepFinishPart.tokens,
          cost: stepFinishPart.cost,
        };
      }
      if (part.type === 'file') {
        return {
          type: 'file',
          url: (part as { url: string }).url,
          mediaType: (part as { mediaType?: string }).mediaType,
          filename: (part as { filename?: string }).filename,
        };
      }
      return part as MessagePartDetail;
    },
  );

  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: {
      id: message.content?.id,
      role: message.content?.role,
      parts,
    },
    metadata: {
      modelId: message.metadata?.modelId,
      providerId: message.metadata?.providerId,
      cost: message.metadata?.cost,
      tokens: message.metadata?.tokens,
      agent: message.metadata?.agent,
      ...message.metadata,
    },
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    createdBy: message.createdBy,
    updatedBy: message.updatedBy,
  };
}

export function convertUsageToStored(usage: Usage): StoredUsage {
  return {
    id: String(usage.id),
    conversationId: usage.conversationId,
    projectId: usage.projectId,
    organizationId: usage.organizationId,
    userId: usage.userId,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cost: usage.cost,
    contextSize: usage.contextSize,
    timestamp: usage.timestamp.toISOString(),
  };
}

export function extractAssistantMessagesFromTurn(
  messages: StoredMessage[],
  turnNumber: number,
  previousTurnMessageCount: number,
): AssistantMessageDetail[] {
  const turnMessages = messages.slice(previousTurnMessageCount);
  const assistantMessages: AssistantMessageDetail[] = [];

  for (const msg of turnMessages) {
    if (msg.role === 'assistant') {
      assistantMessages.push({
        messageId: msg.id,
        startedAt: msg.createdAt,
        completedAt: msg.updatedAt,
        parts: msg.content?.parts ?? [],
        metadata: msg.metadata,
      });
    }
  }

  return assistantMessages;
}

export function createEmptyResult(
  session: BenchmarkSession,
  compressionMethod: CompressionMethod = 'baseline-no-compression',
  contextMode: ContextMode = 'plain',
): BenchmarkResult {
  return {
    sessionId: session.id,
    database: session.metadata.database,
    conversationType: session.metadata.conversationType,
    compressionMethod,
    contextMode,
    conversationId: '',
    conversationSlug: '',
    startedAt: new Date().toISOString(),
    completedAt: '',
    turns: [],
    metrics: {
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalCachedInputTokens: 0,
      totalCost: 0,
      totalResponseTimeMs: 0,
      totalToolCalls: 0,
      failedToolCalls: 0,
      avgResponseTimeMs: 0,
      avgToolCallsPerTurn: 0,
      filterPersistenceRate: null,
      entityRecallAccuracy: null,
      referenceResolutionAccuracy: null,
      toolSuccessRate: null,
      compressionRatio: null,
      compactionLatencyMs: null,
    },
    errors: [],
  };
}

export function enrichTurnsWithAnnotations(
  turns: TurnResult[],
  session: BenchmarkSession,
): TurnResult[] {
  return turns.map((turn) => {
    const sessionTurn = session.turns.find(
      (t) => t.turnNumber === turn.turnNumber,
    );
    return {
      ...turn,
      annotations: sessionTurn?.annotations,
    };
  });
}
