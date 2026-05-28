import type { ZoneSegment, ZoneCompressionResult } from './types.js';
import type { ProcessInput } from '@qwery/agent-factory-sdk';

export type ZoneCompressionBackend = {
  name: string;
  compress: (segment: ZoneSegment, query: string, context: ZoneSegment[]) => Promise<ZoneCompressionResult>;
  supportsQueryAware: () => boolean;
  supportsReordering: () => boolean;
};

export type ZoneStrategyContext = {
  boundaryTurn: number;
  currentTurnRef: { value: number };
  zoneManager: import('../zone-architecture/zone-context-manager.js').ZoneContextManager;
};

export type ZoneStrategyConfig = {
  compressionBackend: ZoneCompressionBackend;
  enableEntityState: boolean;
  enableActiveWindow: boolean;
  enableArchive: boolean;
  activeWindowMaxTurns: number;
  archiveMaxSegments: number;
  archiveRetrievalTopK: number;
};

export function createZoneStrategyConfig(overrides: Partial<ZoneStrategyConfig> = {}): ZoneStrategyConfig {
  return {
    compressionBackend: overrides.compressionBackend ?? {
      name: 'baseline',
      compress: async (segment) => ({
        compressedSegments: [segment],
        originalTokens: segment.tokens,
        compressedTokens: segment.tokens,
        compressionRatio: 1.0,
        latencyMs: 0,
      }),
      supportsQueryAware: () => false,
      supportsReordering: () => false,
    },
    enableEntityState: overrides.enableEntityState ?? true,
    enableActiveWindow: overrides.enableActiveWindow ?? true,
    enableArchive: overrides.enableArchive ?? true,
    activeWindowMaxTurns: overrides.activeWindowMaxTurns ?? 6,
    archiveMaxSegments: overrides.archiveMaxSegments ?? 50,
    archiveRetrievalTopK: overrides.archiveRetrievalTopK ?? 3,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createZoneSegment(
  content: string,
  zone: ZoneSegment['zone'],
  metadata?: ZoneSegment['metadata'],
): ZoneSegment {
  return {
    zone,
    content,
    tokens: estimateTokens(content),
    metadata,
  };
}

export async function compressZoneSegment(
  segment: ZoneSegment,
  query: string,
  context: ZoneSegment[],
  backend: ZoneCompressionBackend,
): Promise<ZoneSegment> {
  const result = await backend.compress(segment, query, context);

  if (result.compressedSegments.length === 0) {
    return segment;
  }

  const compressedSegment = result.compressedSegments[0];
  if (!compressedSegment) {
    return segment;
  }

  return {
    ...compressedSegment,
    zone: segment.zone,
    metadata: {
      ...segment.metadata,
      ...compressedSegment.metadata,
      compressionRatio: result.compressionRatio,
    },
  };
}

export function extractQueryFromMessages(messages: ProcessInput['messages']): string {
  const lastUserMessage = messages
    .filter((m) => m.role === 'user')
    .pop();

  if (lastUserMessage) {
    const parts = lastUserMessage.content?.parts ?? (lastUserMessage as unknown as { parts?: Array<{ type: string; text: string }> }).parts ?? [];
    const textParts = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
    return textParts.join(' ');
  }

  // Benchmark does not persist user messages — fall back to the last
  // assistant message whose reasoning part typically paraphrases the query.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant) {
    const text = extractTextFromMessage(lastAssistant);
    return text.slice(0, 200);
  }

  return '';
}

export function extractTurnNumberFromMessages(messages: ProcessInput['messages']): number {
  return messages.filter((m) => m.role === 'user').length;
}

export function extractTextFromMessage(message: ProcessInput['messages'][number]): string {
  const parts = message.content?.parts ?? (message as unknown as { parts?: Array<{ type: string; text: string }> }).parts ?? [];
  const textParts = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
  return textParts.join(' ');
}

export function isUserCorrection(message: ProcessInput['messages'][number]): boolean {
  const text = extractTextFromMessage(message).toLowerCase();
  const correctionIndicators = [
    'no, i meant',
    'that\'s wrong',
    'actually',
    'correction',
    'let me clarify',
    'i meant',
    'not that',
    'wrong',
  ];
  return correctionIndicators.some((indicator) => text.includes(indicator));
}

export function createBaselineCompressionBackend(): ZoneCompressionBackend {
  return {
    name: 'baseline',
    compress: async (segment) => ({
      compressedSegments: [segment],
      originalTokens: segment.tokens,
      compressedTokens: segment.tokens,
      compressionRatio: 1.0,
      latencyMs: 0,
    }),
    supportsQueryAware: () => false,
    supportsReordering: () => false,
  };
}

export function createSimpleCompressionBackend(compressionRatio: number = 0.5): ZoneCompressionBackend {
  return {
    name: 'simple',
    compress: async (segment) => {
      const startTime = performance.now();
      const compressedTokens = Math.floor(segment.tokens * compressionRatio);
      const compressedContent = segment.content.substring(0, Math.floor(segment.content.length * compressionRatio));
      const latencyMs = performance.now() - startTime;

      return {
        compressedSegments: [
          {
            ...segment,
            content: compressedContent,
            tokens: compressedTokens,
          },
        ],
        originalTokens: segment.tokens,
        compressedTokens,
        compressionRatio,
        latencyMs,
      };
    },
    supportsQueryAware: () => false,
    supportsReordering: () => false,
  };
}
