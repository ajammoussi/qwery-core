import { v4 as uuidv4 } from 'uuid';
import type { Repositories } from '@qwery/domain/repositories';
import { DatasourceKind } from '@qwery/domain/entities';
import { runAgentToCompletion } from '@qwery/agent-factory-sdk/agents/run-agent-to-completion';
import type { UIMessage } from '@qwery/agent-factory-sdk';
import { SessionCompaction } from '@qwery/agent-factory-sdk';
import type {
  BenchmarkSession,
  BenchmarkResult,
  TurnResult,
  ToolCallResult,
  CompressionMethod,
  ContextMode,
  StoredMessage,
  StoredUsage,
  AssistantMessageDetail,
  MessagePartDetail,
  CompactionEvent,
  SchemaAndConstraintsState,
  ActiveWindowSummary,
  CompressedArchiveSummary,
  EntityStateSnapshot,
  ZoneOverallSummary,
  ZoneSnapshot,
} from './types.js';
import {
  convertMessageToStored,
  createEmptyResult,
  calculateMetrics,
  extractAssistantMessagesFromTurn,
  saveResult,
  enrichTurnsWithAnnotations,
} from './session-loader.js';
import { Roles } from '@qwery/domain/common/roles';
import { installStrategy } from './compaction/strategy.js';
import type { LastCompaction } from './compaction/strategy.js';
import { getStrategy } from './compaction/registry.js';
import { startHeadroomProxy } from './compaction/proxy-manager.js';
import type { HeadroomProxy } from './compaction/proxy-manager.js';
import { extractToolCallsFromParts } from './utils/extract-tool-calls.js';

export type BenchmarkConfig = {
  model?: string;
  maxSteps?: number;
  datasourceId: string;
  storageDir?: string;
  compressionMethod?: CompressionMethod;
  contextMode?: ContextMode;
  repositories?: Repositories;
};

type ZoneSnapshotData = {
  schemaAndConstraints: SchemaAndConstraintsState;
  entityState: EntityStateSnapshot;
  activeWindow: ActiveWindowSummary;
  compressedArchive: CompressedArchiveSummary;
  summary: ZoneOverallSummary;
};

type ToolMetadataEvent = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  error?: string;
  executionTimeMs?: number;
};

const BENCHMARK_USER_ID = '11111111-1111-4111-8111-111111111111';
const BENCHMARK_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const BENCHMARK_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

async function seedBenchmarkContext(repositories: Repositories): Promise<void> {
  const now = new Date();

  const existingUser = await repositories.user.findById(BENCHMARK_USER_ID);
  if (!existingUser) {
    await repositories.user.create({
      id: BENCHMARK_USER_ID,
      username: 'benchmark-runner',
      role: Roles.USER,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingOrganization = await repositories.organization.findById(
    BENCHMARK_ORGANIZATION_ID,
  );
  if (!existingOrganization) {
    await repositories.organization.create({
      id: BENCHMARK_ORGANIZATION_ID,
      name: 'Benchmark Organization',
      slug: 'benchmark-organization',
      userId: BENCHMARK_USER_ID,
      createdAt: now,
      updatedAt: now,
      createdBy: BENCHMARK_USER_ID,
      updatedBy: BENCHMARK_USER_ID,
    });
  }

  const existingProject =
    await repositories.project.findById(BENCHMARK_PROJECT_ID);
  if (!existingProject) {
    await repositories.project.create({
      id: BENCHMARK_PROJECT_ID,
      organizationId: BENCHMARK_ORGANIZATION_ID,
      name: 'Benchmark Project',
      slug: 'benchmark-project',
      description: 'Synthetic project used for benchmark persistence',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: BENCHMARK_USER_ID,
      updatedBy: BENCHMARK_USER_ID,
    });
  }
}

export async function createBenchmarkRepositories(
  storageDir: string,
): Promise<Repositories> {
  const path = await import('path');

  const repositoryPackage = '@qwery/repository-file';
  const {
    UserRepository,
    ConversationRepository,
    DatasourceRepository,
    NotebookRepository,
    OrganizationRepository,
    ProjectRepository,
    MessageRepository,
    UsageRepository,
    TodoRepository,
    setStorageDir,
  } = await import(repositoryPackage);

  const absoluteStorageDir =
    storageDir.startsWith('/') || storageDir.match(/^[A-Za-z]:/)
      ? storageDir
      : path.resolve(process.cwd(), storageDir);

  // Keep all repository-file consumers aligned on the same storage root.
  process.env.QWERY_STORAGE_DIR = absoluteStorageDir;
  setStorageDir(absoluteStorageDir);

  const repositories: Repositories = {
    user: new UserRepository(),
    organization: new OrganizationRepository(),
    project: new ProjectRepository(),
    datasource: new DatasourceRepository(),
    notebook: new NotebookRepository(),
    conversation: new ConversationRepository(),
    message: new MessageRepository(),
    usage: new UsageRepository(),
    todo: new TodoRepository(),
  };

  await seedBenchmarkContext(repositories);

  return repositories;
}

// extractToolCallsFromParts is imported from ./utils/extract-tool-calls.js

function extractTextFromParts(parts: MessagePartDetail[]): string {
  const textParts: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      textParts.push((part as { text: string }).text);
    }
  }

  return textParts.join('\n');
}

function detectCompactionEvent(args: {
  storedMessages: StoredMessage[];
  scanFromIndex: number;
  lastCompaction: LastCompaction;
  preTokens: number | null;
  turnNumber: number;
  method: CompressionMethod;
  contextMode: ContextMode;
}): CompactionEvent | undefined {
  const {
    storedMessages,
    scanFromIndex,
    lastCompaction,
    preTokens,
    turnNumber,
    method,
    contextMode,
  } = args;

  let newSummary: StoredMessage | undefined;
  for (let i = scanFromIndex; i < storedMessages.length; i++) {
    const msg = storedMessages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const meta = msg.metadata as
      | { summary?: boolean; type?: string }
      | undefined;
    if (!meta?.summary) continue;
    if (meta?.type === 'compaction') {
      newSummary = msg;
      break;
    }
    newSummary = msg;
  }

  // If process ran (lastCompaction exists) but no summary was found with
  // the exact metadata, fall back to the last new assistant message.
  // Require latency > 50ms: a real LLM call takes hundreds of ms; anything
  // shorter means process() returned early without generating a summary.
  if (!newSummary && lastCompaction && lastCompaction.latencyMs > 50) {
    for (let i = storedMessages.length - 1; i >= scanFromIndex; i--) {
      const msg = storedMessages[i];
      if (msg && msg.role === 'assistant') {
        newSummary = msg;
        break;
      }
    }
  }

  // Strategies that don't persist a summary message (e.g. baseline) won't have
  // newSummary; if neither signal is present, no compaction happened this turn.
  if (!newSummary && !lastCompaction) {
    return undefined;
  }

  const summaryText = newSummary
    ? extractTextFromParts(
        (newSummary.content?.parts ?? []) as MessagePartDetail[],
      )
    : undefined;

  const summaryTokens =
    newSummary?.metadata?.tokens?.output ??
    (summaryText ? Math.ceil(summaryText.length / 3.6) : undefined);

  const tokensSaved =
    typeof newSummary?.metadata?.compactionTokensSaved === 'number'
      ? (newSummary.metadata.compactionTokensSaved as number)
      : undefined;

  return {
    method,
    contextMode,
    triggeredAt: 'turn-boundary',
    summaryText,
    summaryTokens,
    preCompactionTokens:
      preTokens ?? lastCompaction?.preCompactionTokens ?? undefined,
    latencyMs:
      lastCompaction && lastCompaction.turnNumber === turnNumber
        ? Math.round(lastCompaction.latencyMs)
        : 0,
    tokensSaved,
  };
}

function extractMetricsFromParts(parts: MessagePartDetail[]): {
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cached: number };
} {
  let cost = 0;
  let tokens = { input: 0, output: 0, reasoning: 0, cached: 0 };

  for (const part of parts) {
    if (part.type === 'step-finish') {
      const stepFinish = part as {
        type: 'step-finish';
        cost?: number;
        tokens?: {
          input: number;
          output: number;
          reasoning?: number;
          cache?: { read: number; write: number };
        };
      };
      if (stepFinish.cost !== undefined) {
        cost += stepFinish.cost;
      }
      if (stepFinish.tokens) {
        tokens.input += stepFinish.tokens.input;
        tokens.output += stepFinish.tokens.output;
        tokens.reasoning += stepFinish.tokens.reasoning ?? 0;
        tokens.cached += stepFinish.tokens.cache?.read ?? 0;
      }
    }
  }

  return { cost, tokens };
}

export async function runSession(
  session: BenchmarkSession,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const compressionMethod =
    config.compressionMethod || 'baseline-no-compression';
  const contextMode = config.contextMode || 'plain';
  const result = createEmptyResult(session, compressionMethod, contextMode);

  const repositories =
    config.repositories ??
    (await createBenchmarkRepositories(config.storageDir || 'qwery.db'));

  const strategy = getStrategy(compressionMethod, contextMode);
  const currentTurnRef = { value: 0 };
  const { restore, lastCompactionRef, preTokensRef, getState } =
    installStrategy(strategy, {
      boundaryTurn: session.metadata.compressionBoundaryTurn,
      currentTurnRef,
    });

  let headroomProxy: HeadroomProxy | undefined;
  const previousHeadroomBaseUrl = process.env.HEADROOM_BASE_URL;
  const previousHeadroomUrl = process.env.HEADROOM_URL;
  if (compressionMethod === 'headroom') {
    headroomProxy = await startHeadroomProxy();
    process.env.HEADROOM_BASE_URL = headroomProxy.url;
    process.env.HEADROOM_URL = headroomProxy.url;
    console.log(`Headroom proxy started at ${headroomProxy.url}`);
  }

  try {
    const finalResult = await runSessionWithStrategy({
      session,
      config,
      compressionMethod,
      contextMode,
      result,
      repositories,
      currentTurnRef,
      lastCompactionRef,
      preTokensRef,
      getState,
    });

    if (getState) {
      finalResult.finalZoneSnapshot = getState({
        excludeRaw: true,
      }) as ZoneSnapshotData;
    }

    // Reorder finalZoneSnapshot to appear after turns and before metrics in JSON output
    const { metrics, errors, ...rest } = finalResult;
    const ordered = rest as BenchmarkResult;
    ordered.metrics = metrics;
    ordered.errors = errors;

    await saveResult(ordered, compressionMethod, contextMode);

    return ordered;
  } finally {
    restore();
    if (headroomProxy) {
      headroomProxy.kill();
      console.log('Headroom proxy stopped');
    }
    if (previousHeadroomBaseUrl === undefined) {
      delete process.env.HEADROOM_BASE_URL;
    } else {
      process.env.HEADROOM_BASE_URL = previousHeadroomBaseUrl;
    }
    if (previousHeadroomUrl === undefined) {
      delete process.env.HEADROOM_URL;
    } else {
      process.env.HEADROOM_URL = previousHeadroomUrl;
    }
  }
}

async function runSessionWithStrategy(args: {
  session: BenchmarkSession;
  config: BenchmarkConfig;
  compressionMethod: CompressionMethod;
  contextMode: ContextMode;
  result: BenchmarkResult;
  repositories: Repositories;
  currentTurnRef: { value: number };
  lastCompactionRef: { value: LastCompaction };
  preTokensRef: { value: number | null };
  getState?: (options?: {
    prune?: boolean;
    excludeRaw?: boolean;
  }) => Record<string, unknown>;
}): Promise<BenchmarkResult> {
  const {
    session,
    config,
    compressionMethod,
    contextMode,
    result,
    repositories,
    currentTurnRef,
    lastCompactionRef,
    preTokensRef,
    getState,
  } = args;

  const conversationId = uuidv4();

  const conversation = {
    id: conversationId,
    title: session.metadata.description,
    slug: `${session.id}-${Date.now()}`,
    projectId: BENCHMARK_PROJECT_ID,
    taskId: '00000000-0000-0000-0000-000000000001',
    datasources: [config.datasourceId],
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: BENCHMARK_USER_ID,
    updatedBy: BENCHMARK_USER_ID,
    isPublic: false,
  };

  const savedConversation =
    await repositories.conversation.create(conversation);
  const conversationSlug = savedConversation.slug;
  result.conversationId = conversationId;
  result.conversationSlug = conversationSlug;

  const conversationMessages: UIMessage[] = [];
  let previousTurnMessageCount = 0;

  for (const turn of session.turns) {
    const turnStart = performance.now();
    currentTurnRef.value = turn.turnNumber;

    const userMessageId = uuidv4();
    conversationMessages.push({
      id: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: turn.content }],
    });

    const toolCallMap = new Map<
      string,
      { input?: Record<string, unknown>; startTime: number }
    >();
    const accumulatedToolCalls: ToolCallResult[] = [];

    const abortController = new AbortController();

    try {
      const agentResult = await runAgentToCompletion({
        conversationId,
        conversationSlug,
        messages: conversationMessages,
        agentId: 'query',
        model: config.model,
        repositories,
        abortSignal: abortController.signal,
        maxSteps: config.maxSteps ?? 10,
        datasources: [config.datasourceId],
        onToolMetadata: (meta: unknown) => {
          const event = meta as unknown as ToolMetadataEvent;

          if (event.type === 'tool-input-available') {
            const callId = event.toolCallId ?? uuidv4();
            toolCallMap.set(callId, {
              input: event.toolInput,
              startTime: performance.now(),
            });
            accumulatedToolCalls.push({
              toolName: event.toolName ?? 'unknown',
              toolCallId: callId,
              toolInput: event.toolInput ?? {},
              toolOutput: null,
              executionTimeMs: 0,
              success: false,
            });
          } else if (event.type === 'tool-output-available') {
            const call = accumulatedToolCalls.find(
              (c) => c.toolName === event.toolName && !c.success,
            );
            if (call) {
              call.toolOutput = event.toolOutput;
              call.success = true;
              const toolInfo = Array.from(toolCallMap.entries()).find(
                ([, v]) => call.toolInput === v.input,
              );
              if (toolInfo) {
                call.executionTimeMs = Math.round(
                  performance.now() - toolInfo[1].startTime,
                );
              }
            }
          } else if (event.type === 'tool-output-error') {
            const call = accumulatedToolCalls.find(
              (c) => c.toolName === event.toolName && !c.success,
            );
            if (call) {
              call.error = event.error;
              call.success = false;
              const toolInfo = Array.from(toolCallMap.entries()).find(
                ([, v]) => call.toolInput === v.input,
              );
              if (toolInfo) {
                call.executionTimeMs = Math.round(
                  performance.now() - toolInfo[1].startTime,
                );
              }
            }
          }
        },
      });

      const turnEnd = performance.now();
      const responseTimeMs = Math.round(turnEnd - turnStart);

      const finishedMessages = agentResult.messages;
      const assistantMessageTimestamps = new Map<
        string,
        { startedAt?: string; completedAt?: string }
      >();

      let compactionEvent: CompactionEvent | undefined;

      if (agentResult.usage) {
        const rawTokens = {
          input: agentResult.usage.promptTokens,
          output: agentResult.usage.completionTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        };
        const isOverflow = await (SessionCompaction.isOverflow as any)({
          tokens: rawTokens,
          model: config.model,
          messages: [...conversationMessages, ...finishedMessages],
        });

        if (isOverflow) {
          const preCompactionMessages =
            await repositories.message.findByConversationId(conversationId);
          const lastPersistedId = preCompactionMessages.at(-1)?.id ?? userMessageId;
          await SessionCompaction.process({
            parentID: lastPersistedId,
            messages: preCompactionMessages,
            conversationSlug,
            abort: abortController.signal,
            auto: true,
            repositories,
          });
        }
      } else {
        // Fallback: always check overflow for boundary-based strategies even when usage is missing
        const rawTokens = {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        };
        const isOverflow = await (SessionCompaction.isOverflow as any)({
          tokens: rawTokens,
          model: config.model,
          messages: [...conversationMessages, ...finishedMessages],
        });

        if (isOverflow) {
          const preCompactionMessages =
            await repositories.message.findByConversationId(conversationId);
          const lastPersistedId = preCompactionMessages.at(-1)?.id ?? userMessageId;
          await SessionCompaction.process({
            parentID: lastPersistedId,
            messages: preCompactionMessages,
            conversationSlug,
            abort: abortController.signal,
            auto: true,
            repositories,
          });
        }
      }

      try {
        const persistedMessages =
          await repositories.message.findByConversationId(conversationId);
        const storedMessages = persistedMessages.map(convertMessageToStored);
        const assistantMessagesFromStore = extractAssistantMessagesFromTurn(
          storedMessages,
          turn.turnNumber,
          previousTurnMessageCount,
        );

        for (const assistantMessage of assistantMessagesFromStore) {
          assistantMessageTimestamps.set(assistantMessage.messageId, {
            startedAt: assistantMessage.startedAt,
            completedAt: assistantMessage.completedAt,
          });
        }

        compactionEvent = detectCompactionEvent({
          storedMessages,
          scanFromIndex: previousTurnMessageCount,
          lastCompaction: lastCompactionRef.value,
          preTokens: preTokensRef.value,
          turnNumber: turn.turnNumber,
          method: compressionMethod,
          contextMode,
        });
        // Reset for the next turn so a stale latency doesn't leak forward.
        lastCompactionRef.value = null;
        preTokensRef.value = null;

        previousTurnMessageCount = persistedMessages.length;
      } catch (error) {
        result.errors.push(
          `Turn ${turn.turnNumber}: failed to retrieve persisted message timestamps: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const assistantMessages: AssistantMessageDetail[] = [];
      let agentResponse = '';
      let totalCost = 0;
      let inputTokens = agentResult.usage?.promptTokens ?? 0;
      let outputTokens = agentResult.usage?.completionTokens ?? 0;
      let reasoningTokens = 0;
      let cachedInputTokens = 0;

      for (const msg of finishedMessages) {
        if (msg.role === 'assistant') {
          const parts = (msg.parts ?? []) as MessagePartDetail[];
          const metrics = extractMetricsFromParts(parts);
          totalCost += metrics.cost;
          inputTokens += metrics.tokens.input;
          outputTokens += metrics.tokens.output;
          reasoningTokens += metrics.tokens.reasoning;
          cachedInputTokens += metrics.tokens.cached;

          const toolCallsFromParts = extractToolCallsFromParts(parts);
          for (const tc of toolCallsFromParts) {
            const existingIdx = accumulatedToolCalls.findIndex(
              (atc) =>
                atc.toolName === tc.toolName &&
                atc.toolCallId === tc.toolCallId,
            );
            if (existingIdx === -1) {
              accumulatedToolCalls.push(tc);
            } else {
              accumulatedToolCalls[existingIdx] = tc;
            }
          }

          const msgMetadata = (msg.metadata as Record<string, unknown>) ?? {};
          const persistedTimestamps = assistantMessageTimestamps.get(msg.id);

          const metadataStartedAt =
            typeof msgMetadata.createdAt === 'string'
              ? msgMetadata.createdAt
              : undefined;
          const metadataCompletedAt =
            typeof msgMetadata.updatedAt === 'string'
              ? msgMetadata.updatedAt
              : undefined;

          assistantMessages.push({
            messageId: msg.id,
            startedAt: persistedTimestamps?.startedAt ?? metadataStartedAt,
            completedAt:
              persistedTimestamps?.completedAt ?? metadataCompletedAt,
            parts,
            metadata: msgMetadata,
          });

          const textContent = extractTextFromParts(parts);
          if (textContent) {
            agentResponse = agentResponse
              ? `${agentResponse}\n${textContent}`
              : textContent;
          }
        }
      }

      // Capture per-turn zone snapshot if getState is available (4zone mode)
      let zonesSnapshot: ZoneSnapshot | undefined;
      if (getState) {
        const state = getState({ prune: true }) as ZoneSnapshotData;
        zonesSnapshot = {
          schemaAndConstraints: state.schemaAndConstraints,
          entityState: state.entityState,
          activeWindow: state.activeWindow,
          compressedArchive: state.compressedArchive,
          summary: state.summary,
        };
      }

      const turnResult: TurnResult = {
        turnNumber: turn.turnNumber,
        userMessage: turn.content,
        assistantMessages,
        agentResponse,
        toolCalls: accumulatedToolCalls,
        responseTimeMs,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedInputTokens,
        cost: totalCost,
        compactionEvent,
        zonesSnapshot,
      };

      result.turns.push(turnResult);

      conversationMessages.length = 0;
      for (const msg of finishedMessages) {
        conversationMessages.push({
          id: msg.id,
          role: msg.role as 'user' | 'assistant',
          parts: msg.parts,
          metadata: msg.metadata,
        });
      }
    } catch (error) {
      const turnEnd = performance.now();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push(`Turn ${turn.turnNumber}: ${errorMessage}`);

      const turnResult: TurnResult = {
        turnNumber: turn.turnNumber,
        userMessage: turn.content,
        assistantMessages: [],
        agentResponse: '',
        toolCalls: accumulatedToolCalls,
        responseTimeMs: Math.round(turnEnd - turnStart),
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cost: 0,
      };

      result.turns.push(turnResult);
    }
  }
  //
  //   try {
  //     const dbMessages =
  //       await repositories.message.findByConversationId(conversationId);
  //     result.messages = dbMessages.map(convertMessageToStored);
  //   } catch (error) {
  //     result.errors.push(
  //       `Failed to retrieve messages: ${error instanceof Error ? error.message : String(error)}`,
  //     );
  //   }
  //
  //   try {
  //     const dbUsages =
  //       await repositories.usage.findByConversationId(conversationId);
  //     result.usages = dbUsages.map(convertUsageToStored);
  //   } catch (error) {
  //     result.errors.push(
  //       `Failed to retrieve usages: ${error instanceof Error ? error.message : String(error)}`,
  // );
  // }
  //
  // Enrich turns with session annotations
  result.turns = enrichTurnsWithAnnotations(result.turns, session);

  result.completedAt = new Date().toISOString();
  result.metrics = calculateMetrics(result.turns, session);

  return result;
}

export async function ensureDatasource(
  repositories: Repositories,
  name: string,
  provider: string,
  config: Record<string, unknown>,
): Promise<string> {
  const normalizedConfig: Record<string, unknown> = { ...config };
  if (
    typeof normalizedConfig.username !== 'string' &&
    typeof normalizedConfig.user === 'string'
  ) {
    normalizedConfig.username = normalizedConfig.user;
  }

  const existing = await repositories.datasource.findAll();
  const found = existing.find(
    (d: { id: string; name: string }) => d.name === name,
  );
  if (found) {
    const foundDatasource = found as {
      id: string;
      datasource_provider: string;
      datasource_driver: string;
      config: Record<string, unknown>;
      updatedAt: Date;
      updatedBy: string;
    };

    const hasConfigChanged =
      JSON.stringify(foundDatasource.config) !==
      JSON.stringify(normalizedConfig);
    const hasProviderChanged =
      foundDatasource.datasource_provider !== provider ||
      foundDatasource.datasource_driver !== provider;

    if (hasConfigChanged || hasProviderChanged) {
      await repositories.datasource.update({
        ...(found as unknown as Parameters<
          typeof repositories.datasource.update
        >[0]),
        datasource_provider: provider,
        datasource_driver: provider,
        config: normalizedConfig,
        updatedAt: new Date(),
        updatedBy: BENCHMARK_USER_ID,
      });
    }

    return found.id;
  }

  const datasource = {
    id: uuidv4(),
    projectId: BENCHMARK_PROJECT_ID,
    name,
    description: '',
    slug: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    datasource_provider: provider,
    datasource_driver: provider,
    datasource_kind: DatasourceKind.REMOTE,
    config: normalizedConfig,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: BENCHMARK_USER_ID,
    updatedBy: BENCHMARK_USER_ID,
    isPublic: false,
  };

  await repositories.datasource.create(datasource);
  return datasource.id;
}
