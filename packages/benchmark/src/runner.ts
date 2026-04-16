import { v4 as uuidv4 } from 'uuid';
import type { Repositories } from '@qwery/domain/repositories';
import { DatasourceKind } from '@qwery/domain/entities';
import { runAgentToCompletion } from '@qwery/agent-factory-sdk/agents/run-agent-to-completion';
import type {
  BenchmarkSession,
  BenchmarkResult,
  TurnResult,
  ToolCallResult,
  CompressionMethod,
} from './types.js';
import {
  createEmptyResult,
  calculateMetrics,
  saveResult,
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

type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type ToolMetadataEvent = {
  type?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  error?: string;
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

  const existingProject = await repositories.project.findById(BENCHMARK_PROJECT_ID);
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
  } = await import('@qwery/repository-in-memory');

  void storageDir;

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
  const conversationSlug = `${session.id}-${Date.now()}`;
  result.conversationId = conversationId;
  result.conversationSlug = conversationSlug;

  const conversation = {
    id: conversationId,
    title: session.metadata.description,
    slug: conversationSlug,
    projectId: BENCHMARK_PROJECT_ID,
    taskId: '00000000-0000-0000-0000-000000000001',
    datasources: [config.datasourceId],
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: BENCHMARK_USER_ID,
    updatedBy: BENCHMARK_USER_ID,
    isPublic: false,
  };

  await repositories.conversation.create(conversation);

  const conversationMessages: ConversationMessage[] = [];

  for (const turn of session.turns) {
    const turnStart = performance.now();

    conversationMessages.push({
      id: uuidv4(),
      role: 'user',
      content: turn.content,
    });

    const accumulatedToolCalls: ToolCallResult[] = [];

    const abortController = new AbortController();

    try {
      const agentResult = await runAgentToCompletion({
        conversationId,
        conversationSlug,
        messages: conversationMessages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: [{ type: 'text', text: m.content }],
        })),
        agentId: 'query',
        model: config.model,
        repositories,
        abortSignal: abortController.signal,
        maxSteps: config.maxSteps ?? 10,
        datasources: [config.datasourceId],
        onToolMetadata: (meta: unknown) => {
          const event = meta as unknown as ToolMetadataEvent;

          if (event.type === 'tool-input-available') {
            accumulatedToolCalls.push({
              toolName: event.toolName ?? 'unknown',
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
            }
          } else if (event.type === 'tool-output-error') {
            const call = accumulatedToolCalls.find(
              (c) => c.toolName === event.toolName && !c.success,
            );
            if (call) {
              call.error = event.error;
              call.success = false;
            }
          }
        },
      });

      const turnEnd = performance.now();
      const responseTimeMs = Math.round(turnEnd - turnStart);

      const agentResponse = agentResult.text || '';
      conversationMessages.push({
        id: uuidv4(),
        role: 'assistant',
        content: agentResponse,
      });

      const turnResult: TurnResult = {
        turnNumber: turn.turnNumber,
        userMessage: turn.content,
        agentResponse,
        toolCalls: accumulatedToolCalls,
        responseTimeMs,
        inputTokens: agentResult.usage?.promptTokens ?? 0,
        outputTokens: agentResult.usage?.completionTokens ?? 0,
      };

      result.turns.push(turnResult);
    } catch (error) {
      const turnEnd = performance.now();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push(`Turn ${turn.turnNumber}: ${errorMessage}`);

      const turnResult: TurnResult = {
        turnNumber: turn.turnNumber,
        userMessage: turn.content,
        agentResponse: '',
        toolCalls: accumulatedToolCalls,
        responseTimeMs: Math.round(turnEnd - turnStart),
        inputTokens: 0,
        outputTokens: 0,
      };

      result.turns.push(turnResult);
    }
  }

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
  const existing = await repositories.datasource.findAll();
  const found = existing.find(
    (d: { id: string; name: string }) => d.name === name,
  );
  if (found) {
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
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: BENCHMARK_USER_ID,
    updatedBy: BENCHMARK_USER_ID,
    isPublic: false,
  };

  await repositories.datasource.create(datasource);
  return datasource.id;
}
