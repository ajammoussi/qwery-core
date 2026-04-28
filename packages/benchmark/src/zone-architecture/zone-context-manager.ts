import type {
  ZoneType,
  ZoneSegment,
  ZoneConfiguration,
  ZoneContext,
  ZoneAssemblyResult,
  ZoneRetrievalResult,
} from './types.js';
import { EntityStateTracker } from './entity-state-tracker.js';

export class ZoneContextManager {
  private context: ZoneContext;
  private entityStateTracker: EntityStateTracker;
  private turnCounter: number = 0;

  constructor(config: Partial<ZoneConfiguration> = {}) {
    this.entityStateTracker = new EntityStateTracker();
    this.context = this.createInitialContext(config);
  }

  private createInitialContext(config: Partial<ZoneConfiguration>): ZoneContext {
    const defaultConfig: ZoneConfiguration = {
      frozenPrefix: {
        enabled: true,
        schema: '',
        globalConstraints: [],
      },
      entityState: {
        enabled: true,
        maxTokens: 400,
      },
      activeWindow: {
        enabled: true,
        maxTurns: 6,
      },
      compressedArchive: {
        enabled: true,
        maxSegments: 50,
        retrievalTopK: 3,
      },
    };

    return {
      zoneA: [],
      zoneB: [],
      zoneC: [],
      zoneD: [],
      entityState: this.entityStateTracker.getState(),
      config: { ...defaultConfig, ...config },
      currentQuery: undefined,
    };
  }

  getContext(): ZoneContext {
    return {
      zoneA: [...this.context.zoneA],
      zoneB: [...this.context.zoneB],
      zoneC: [...this.context.zoneC],
      zoneD: [...this.context.zoneD],
      entityState: this.entityStateTracker.getState(),
      config: { ...this.context.config },
      currentQuery: this.context.currentQuery,
    };
  }

  getEntityStateTracker(): EntityStateTracker {
    return this.entityStateTracker;
  }

  getTurnCounter(): number {
    return this.turnCounter;
  }

  incrementTurnCounter(): number {
    return ++this.turnCounter;
  }

  populateZoneA(schema: string, globalConstraints: string[] = []): void {
    if (!this.context.config.frozenPrefix.enabled) {
      return;
    }

    this.context.zoneA = [];

    if (schema) {
      const schemaSegment: ZoneSegment = {
        zone: 'frozen-prefix',
        content: schema,
        tokens: Math.ceil(schema.length / 4),
        metadata: { segmentType: 'schema' },
      };
      this.context.zoneA.push(schemaSegment);
    }

    for (const constraint of globalConstraints) {
      const constraintSegment: ZoneSegment = {
        zone: 'frozen-prefix',
        content: constraint,
        tokens: Math.ceil(constraint.length / 4),
        metadata: { segmentType: 'global_constraint' },
      };
      this.context.zoneA.push(constraintSegment);
    }
  }

  addToZoneA(segment: ZoneSegment): void {
    if (this.context.config.frozenPrefix.enabled) {
      this.context.zoneA.push(segment);
    }
  }

  addToZoneB(segment: ZoneSegment): void {
    if (this.context.config.entityState.enabled) {
      this.context.zoneB.push(segment);
    }
  }

  addToZoneC(segment: ZoneSegment): void {
    if (this.context.config.activeWindow.enabled) {
      this.context.zoneC.push(segment);
      this.enforceActiveWindowLimit();
    }
  }

  addToZoneD(segment: ZoneSegment): void {
    if (this.context.config.compressedArchive.enabled) {
      this.context.zoneD.push(segment);
      this.enforceArchiveLimit();
    }
  }

  private enforceActiveWindowLimit(): void {
    const maxTurns = this.context.config.activeWindow.maxTurns;
    if (this.context.zoneC.length > maxTurns) {
      const evicted = this.context.zoneC.splice(0, this.context.zoneC.length - maxTurns);
      for (const segment of evicted) {
        this.addToZoneD(segment);
      }
    }
  }

  private enforceArchiveLimit(): void {
    const maxSegments = this.context.config.compressedArchive.maxSegments;
    if (this.context.zoneD.length > maxSegments) {
      this.context.zoneD = this.context.zoneD.slice(-maxSegments);
    }
  }

  evictFromZoneC(): ZoneSegment | null {
    if (this.context.zoneC.length === 0) {
      return null;
    }
    const evicted = this.context.zoneC.shift();
    if (evicted) {
      this.addToZoneD(evicted);
    }
    return evicted ?? null;
  }

  retrieveFromZoneD(query: string, topK?: number): ZoneRetrievalResult {
    if (!this.context.config.compressedArchive.enabled || this.context.zoneD.length === 0) {
      return { retrievedSegments: [], relevanceScores: [] };
    }

    const k = topK ?? this.context.config.compressedArchive.retrievalTopK;
    const scoredSegments = this.context.zoneD.map((segment) => ({
      segment,
      score: this.calculateRelevanceScore(segment, query),
    }));

    scoredSegments.sort((a, b) => b.score - a.score);

    const topSegments = scoredSegments.slice(0, k);
    return {
      retrievedSegments: topSegments.map((s) => s.segment),
      relevanceScores: topSegments.map((s) => s.score),
    };
  }

  private calculateRelevanceScore(segment: ZoneSegment, query: string): number {
    const segmentLower = segment.content.toLowerCase();
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

    let score = 0;
    for (const word of queryWords) {
      if (segmentLower.includes(word)) {
        score += 1;
      }
    }

    const segmentMetadata = segment.metadata;
    if (segmentMetadata?.segmentType === 'user_correction') {
      score *= 2;
    }

    if (segmentMetadata?.segmentType === 'filter') {
      score *= 1.5;
    }

    if (segmentMetadata?.embedding && this.context.currentQuery) {
      const queryEmbedding = this.generateEmbedding(this.context.currentQuery);
      const cosineSimilarity = this.cosineSimilarity(segmentMetadata.embedding, queryEmbedding);
      score += cosineSimilarity * 10;
    }

    return score;
  }

  private generateEmbedding(text: string): number[] {
    const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const embedding = new Array(128).fill(0);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      let hash = 0;
      for (let j = 0; j < word.length; j++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(j);
        hash = hash & hash;
      }
      const index = Math.abs(hash) % embedding.length;
      embedding[index] += 1;
    }

    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dotProduct += ai * bi;
      magnitudeA += ai * ai;
      magnitudeB += bi * bi;
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;

    return dotProduct / (magnitudeA * magnitudeB);
  }

  assembleContext(query: string): ZoneAssemblyResult {
    this.context.currentQuery = query;

    const zoneA = this.context.zoneA;
    const zoneB = this.context.zoneB;
    const zoneC = this.context.zoneC;

    const { retrievedSegments } = this.retrieveFromZoneD(query);

    const reorderedSegments = this.reorderSegmentsByRelevance(retrievedSegments);

    const allSegments = [...zoneA, ...zoneB, ...reorderedSegments, ...zoneC];

    if (query) {
      const querySegment: ZoneSegment = {
        zone: 'active-window',
        content: query,
        tokens: Math.ceil(query.length / 4),
        metadata: { segmentType: 'current_query' },
      };
      allSegments.push(querySegment);
    }

    const assembledContext = allSegments.map((s) => s.content).join('\n\n');

    const zoneBreakdown = {
      'frozen-prefix': {
        tokens: zoneA.reduce((sum, s) => sum + s.tokens, 0),
        segments: zoneA.length,
      },
      'entity-state': {
        tokens: zoneB.reduce((sum, s) => sum + s.tokens, 0),
        segments: zoneB.length,
      },
      'active-window': {
        tokens: zoneC.reduce((sum, s) => sum + s.tokens, 0),
        segments: zoneC.length,
      },
      'compressed-archive': {
        tokens: reorderedSegments.reduce((sum, s) => sum + s.tokens, 0),
        segments: reorderedSegments.length,
      },
    };

    const totalTokens = Object.values(zoneBreakdown).reduce((sum, z) => sum + z.tokens, 0);

    return {
      assembledContext,
      zoneBreakdown,
      totalTokens,
      currentQueryIncluded: !!query,
    };
  }

  private reorderSegmentsByRelevance(segments: ZoneSegment[]): ZoneSegment[] {
    if (segments.length <= 1) {
      return segments;
    }

    const query = this.context.currentQuery ?? '';
    const scoredSegments = segments.map((segment) => ({
      segment,
      score: this.calculateRelevanceScore(segment, query),
    }));

    scoredSegments.sort((a, b) => b.score - a.score);

    return scoredSegments.map((s) => s.segment);
  }

  validateResponse(response: string): {
    groundedEntities: string[];
    ungroundedEntities: string[];
    isValid: boolean;
  } {
    const groundedEntities: string[] = [];
    const ungroundedEntities: string[] = [];

    const entityPatterns = [
      /\b([A-Z_][A-Z0-9_]*)\b/g,
    ];

    const currentQuery = this.context.currentQuery ?? '';
    const contextText = this.assembleContext(currentQuery).assembledContext;

    for (const pattern of entityPatterns) {
      let match;
      while ((match = pattern.exec(response)) !== null) {
        const entity = match[1];
        if (entity) {
          if (contextText.includes(entity)) {
            if (!groundedEntities.includes(entity)) {
              groundedEntities.push(entity);
            }
          } else {
            if (!ungroundedEntities.includes(entity)) {
              ungroundedEntities.push(entity);
            }
          }
        }
      }
    }

    return {
      groundedEntities,
      ungroundedEntities,
      isValid: ungroundedEntities.length === 0,
    };
  }

  getZoneTokens(zone: ZoneType): number {
    switch (zone) {
      case 'frozen-prefix':
        return this.context.zoneA.reduce((sum, s) => sum + s.tokens, 0);
      case 'entity-state':
        return this.context.zoneB.reduce((sum, s) => sum + s.tokens, 0);
      case 'active-window':
        return this.context.zoneC.reduce((sum, s) => sum + s.tokens, 0);
      case 'compressed-archive':
        return this.context.zoneD.reduce((sum, s) => sum + s.tokens, 0);
    }
  }

  getTotalTokens(): number {
    return (
      this.getZoneTokens('frozen-prefix') +
      this.getZoneTokens('entity-state') +
      this.getZoneTokens('active-window') +
      this.getZoneTokens('compressed-archive')
    );
  }

  updateEntityState(updates: Parameters<EntityStateTracker['updateState']>[0]): void {
    this.entityStateTracker.updateState(updates);
    this.context.entityState = this.entityStateTracker.getState();
  }

  syncEntityStateToZoneB(): void {
    if (!this.context.config.entityState.enabled) {
      return;
    }

    const stateJson = this.entityStateTracker.toJSON();
    const tokens = this.entityStateTracker.estimateTokens();

    this.context.zoneB = [
      {
        zone: 'entity-state',
        content: stateJson,
        tokens,
        metadata: { segmentType: 'entity_state' },
      },
    ];
  }

  reset(): void {
    this.turnCounter = 0;
    this.entityStateTracker.reset();
    this.context = this.createInitialContext(this.context.config);
  }
}
