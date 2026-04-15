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
}

export interface TurnResult {
  turnNumber: number;
  userMessage: string;
  agentResponse: string;
  toolCalls: ToolCallResult[];
  responseTimeMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCallResult {
  toolName: string;
  toolInput: Record;
  toolOutput: unknown;
  executionTimeMs: number;
  success: boolean;
  error?: string;
}

export interface SessionMetrics {
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalResponseTimeMs: number;
  totalToolCalls: number;
  failedToolCalls: number;
  avgResponseTimeMs: number;
  avgToolCallsPerTurn: number;
  filterPersistenceRate: number | null;
  entityRecallAccuracy: number | null;
  referenceResolutionAccuracy: number | null;
}
