export interface BenchmarkSession {
  id: string;
  metadata: {
    database: 'tpch' | 'saas';
    conversationType: 'RCI' | 'IRC' | 'PTA' | 'DCS' | 'SNCJ';
    expectedTurns: number;
    compressionBoundaryTurn: number;
    userPersona: string;
    tablesExplored: string[];
    description: string;
  };
  turns: BenchmarkTurn[];
  persistedCorrections: PersistedCorrection[];
  anaphoricReferences: AnaphoricReference[];
  callbacks: BenchmarkCallback[];
}

export interface BenchmarkTurn {
  turnNumber: number;
  role: 'user';
  content: string;
  annotations?: TurnAnnotations;
}

export interface TurnAnnotations {
  type?: string;
  establishesFilter?: string;
  isCorrection?: boolean;
  correctionType?: 'explicit' | 'implicit';
  isAnaphoricReference?: boolean;
  anaphoricTargetTurn?: number;
  anaphoricPhrase?: string;
  isCallback?: boolean;
  callbackTargetTurn?: number;
  crossesCompressionBoundary?: boolean;
  chartRequested?: boolean;
  threadContext?: string;
  expectedBehavior?: string;
}

export interface PersistedCorrection {
  turnEstablished: number;
  correctionText: string;
  type: string;
  description?: string;
}

export interface AnaphoricReference {
  sourceTurn: number;
  targetTurn: number;
  phrase: string;
  crossesCompressionBoundary: boolean;
  expectedResolution: string;
  distance: number;
}

export interface BenchmarkCallback {
  sourceTurn: number;
  targetTurn: number;
  callbackType: string;
  expectedEntity: string;
  crossesCompressionBoundary: boolean;
  distance: number;
}

export type CompressionMethod =
  | 'baseline-no-compression'
  | 'llmlingua'
  | 'longllmlingua'
  | 'sliding-window'
  | 'summary-prose'
  | 'entity-state';

export type MessagePartDetail =
  | { type: 'text'; text: string; state?: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
  | {
      type: `tool-${string}`;
      toolCallId?: string;
      toolName?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      state?: string;
      errorText?: string;
      isError?: boolean;
    }
  | { type: 'step-start' }
  | {
      type: 'step-finish';
      reason?: string;
      tokens?: {
        input: number;
        output: number;
        reasoning?: number;
        cache?: { read: number; write: number };
      };
      cost?: number;
    }
  | { type: 'file'; url: string; mediaType?: string; filename?: string }
  | { type: string; [key: string]: unknown };

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: {
    id?: string;
    role?: string;
    parts?: MessagePartDetail[];
  };
  metadata: {
    modelId?: string;
    providerId?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning?: number;
      cache?: { read: number; write: number };
    };
    agent?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface StoredUsage {
  id: string;
  conversationId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cost: number;
  contextSize: number;
  timestamp: string;
}

export interface AssistantMessageDetail {
  messageId: string;
  startedAt?: string;
  completedAt?: string;
  parts: MessagePartDetail[];
  metadata?: Record<string, unknown>;
}

export interface TurnResult {
  turnNumber: number;
  userMessage: string;
  assistantMessages: AssistantMessageDetail[];
  agentResponse: string;
  toolCalls: ToolCallResult[];
  responseTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cost: number;
  // Annotations from session schema
  annotations?: TurnAnnotations;
}

export interface ToolCallResult {
  toolName: string;
  toolCallId?: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  executionTimeMs: number;
  success: boolean;
  error?: string;
}

export interface SessionMetrics {
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCachedInputTokens: number;
  totalCost: number;
  totalResponseTimeMs: number;
  totalToolCalls: number;
  failedToolCalls: number;
  avgResponseTimeMs: number;
  avgToolCallsPerTurn: number;
  filterPersistenceRate: number | null;
  entityRecallAccuracy: number | null;
  referenceResolutionAccuracy: number | null;
}

export interface BenchmarkResult {
  sessionId: string;
  database: string;
  conversationType: string;
  compressionMethod: CompressionMethod;
  conversationId: string;
  conversationSlug: string;
  startedAt: string;
  completedAt: string;
  turns: TurnResult[];
  metrics: SessionMetrics;
  errors: string[];
  // Legacy fields removed: messages and usages arrays (redundant with per-turn data)
}
