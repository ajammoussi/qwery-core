import type { Message } from '@qwery/domain/entities';

export type ZoneType = 'frozen-prefix' | 'entity-state' | 'active-window' | 'compressed-archive';

export type ZoneSegment = {
  zone: ZoneType;
  content: string;
  tokens: number;
  metadata?: {
    messageId?: string;
    turnNumber?: number;
    segmentType?: string;
    compressionRatio?: number;
    relevanceScore?: number;
    embedding?: number[];
  };
};

export type ZoneConfiguration = {
  frozenPrefix: {
    enabled: boolean;
    schema: string;
    globalConstraints: string[];
  };
  entityState: {
    enabled: boolean;
    maxTokens: number;
  };
  activeWindow: {
    enabled: boolean;
    maxTurns: number;
  };
  compressedArchive: {
    enabled: boolean;
    maxSegments: number;
    retrievalTopK: number;
  };
};

export type EntityFilter = {
  column: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT IN' | 'LIKE' | 'IS NULL' | 'IS NOT NULL';
  value: string | string[] | number | number[] | null;
};

export type EntityAggregation = {
  expression: string;
  alias?: string;
};

export type EntityState = {
  activeTables: string[];
  activeColumns: string[];
  activeFilters: EntityFilter[];
  activeAggregations: EntityAggregation[];
  openThreads: string[];
  userCorrections: string[];
  lastUpdated: number;
};

export type ZoneContext = {
  zoneA: ZoneSegment[];
  zoneB: ZoneSegment[];
  zoneC: ZoneSegment[];
  zoneD: ZoneSegment[];
  entityState: EntityState;
  config: ZoneConfiguration;
  currentQuery?: string;
};

export type ZoneCompressionResult = {
  compressedSegments: ZoneSegment[];
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  latencyMs: number;
};

export type ZoneRetrievalResult = {
  retrievedSegments: ZoneSegment[];
  relevanceScores: number[];
};

export type ZoneAssemblyResult = {
  assembledContext: string;
  zoneBreakdown: {
    [K in ZoneType]: { tokens: number; segments: number };
  };
  totalTokens: number;
  currentQueryIncluded: boolean;
};

export type SQLExtraction = {
  tables: string[];
  columns: string[];
  filters: EntityFilter[];
  aggregations: EntityAggregation[];
};
