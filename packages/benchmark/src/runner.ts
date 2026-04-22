import { v4 as uuidv4 } from 'uuid';
import type { Repositories } from '@qwery/domain/repositories';
import { DatasourceKind } from '@qwery/domain/entities';
import { runAgentToCompletion } from '@qwery/agent-factory-sdk/agents/run-agent-to-completion';
import type { UIMessage } from '@qwery/agent-factory-sdk';
import type {
  BenchmarkSession,
  BenchmarkResult,
  TurnResult,
  ToolCallResult,
  CompressionMethod,
  StoredMessage,
  StoredUsage,
  AssistantMessageDetail,
  MessagePartDetail,
} from './types.js';
import {
  createEmptyResult,
  calculateMetrics,
  saveResult,
  enrichTurnsWithAnnotations,
} from './session-loader.js';
import { Roles } from '@qwery/domain/common/roles';

export type BenchmarkConfig = {
  model?: string;
  maxSteps?: number;
  datasourceId: string;
  storageDir?: string;
  compressionMethod?: CompressionMethod;
  repositories?: Repositories;
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

function extractToolCallsFromParts(
  parts: MessagePartDetail[],
): ToolCallResult[] {
  const toolCalls: ToolCallResult[] = [];

  for (const part of parts) {
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolPart = part as {
        type: string;
        toolCallId?: string;
        toolName?: string;
        input?: Record<string, unknown>;
        output?: unknown;
        errorText?: string;
        state?: string;
        isError?: boolean;
      };

      const existingCall = toolCalls.find(
        (tc) => tc.toolCallId === toolPart.toolCallId,
      );

      if (existingCall) {
        if (toolPart.output !== undefined) {
          existingCall.toolOutput = toolPart.output;
          existingCall.success = !toolPart.isError;
        }
        if (toolPart.errorText) {
          existingCall.error = toolPart.errorText;
          existingCall.success = false;
        }
      } else if (toolPart.toolName) {
        toolCalls.push({
          toolName: toolPart.toolName,
          toolCallId: toolPart.toolCallId,
          toolInput: toolPart.input ?? {},
          toolOutput: toolPart.output,
          executionTimeMs: 0,
          success:
            toolPart.state === 'output-available' ||
            (toolPart.output !== undefined && !toolPart.isError),
          error: toolPart.errorText,
        });
      }
    }
  }

  return toolCalls;
}

function extractTextFromParts(parts: MessagePartDetail[]): string {
  const textParts: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      textParts.push((part as { text: string }).text);
    }
  }

  return textParts.join('\n');
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
  const result = createEmptyResult(session, compressionMethod);

  const repositories =
    config.repositories ??
    (await createBenchmarkRepositories(config.storageDir || 'qwery.db'));

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

  const savedConversation = await repositories.conversation.create(conversation);
  const conversationSlug = savedConversation.slug;
  result.conversationId = conversationId;
  result.conversationSlug = conversationSlug;

  const conversationMessages: UIMessage[] = [];
  let previousTurnMessageCount = 0;

  for (const turn of session.turns) {
    const turnStart = performance.now();

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

          assistantMessages.push({
            messageId: msg.id,
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
result.metrics = calculateMetrics(result.turns);

  await saveResult(result, compressionMethod);

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
      JSON.stringify(foundDatasource.config) !== JSON.stringify(normalizedConfig);
    const hasProviderChanged =
      foundDatasource.datasource_provider !== provider ||
      foundDatasource.datasource_driver !== provider;

    if (hasConfigChanged || hasProviderChanged) {
      await repositories.datasource.update({
        ...(found as unknown as Parameters<typeof repositories.datasource.update>[0]),
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
