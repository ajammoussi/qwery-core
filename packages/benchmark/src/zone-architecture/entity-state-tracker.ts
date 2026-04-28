import type { EntityState, EntityFilter, EntityAggregation, SQLExtraction } from './types.js';

export class EntityStateTracker {
  private state: EntityState;

  constructor() {
    this.state = this.createInitialState();
  }

  private createInitialState(): EntityState {
    return {
      activeTables: [],
      activeColumns: [],
      activeFilters: [],
      activeAggregations: [],
      openThreads: [],
      userCorrections: [],
      lastUpdated: Date.now(),
    };
  }

  getState(): EntityState {
    return { ...this.state };
  }

  updateState(updates: Partial<EntityState>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdated: Date.now(),
    };
  }

  addTable(tableName: string): void {
    if (!this.state.activeTables.includes(tableName)) {
      this.state.activeTables.push(tableName);
      this.state.lastUpdated = Date.now();
    }
  }

  addColumn(columnName: string): void {
    if (!this.state.activeColumns.includes(columnName)) {
      this.state.activeColumns.push(columnName);
      this.state.lastUpdated = Date.now();
    }
  }

  addFilter(filter: EntityFilter): void {
    const existingIndex = this.state.activeFilters.findIndex(
      (f) => f.column === filter.column && f.op === filter.op,
    );
    if (existingIndex >= 0) {
      this.state.activeFilters[existingIndex] = filter;
    } else {
      this.state.activeFilters.push(filter);
    }
    this.state.lastUpdated = Date.now();
  }

  removeFilter(column: string, op?: string): void {
    this.state.activeFilters = this.state.activeFilters.filter(
      (f) => f.column !== column || (op !== undefined && f.op !== op),
    );
    this.state.lastUpdated = Date.now();
  }

  addAggregation(aggregation: EntityAggregation): void {
    const existingIndex = this.state.activeAggregations.findIndex(
      (a) => a.expression === aggregation.expression,
    );
    if (existingIndex < 0) {
      this.state.activeAggregations.push(aggregation);
      this.state.lastUpdated = Date.now();
    }
  }

  addOpenThread(thread: string): void {
    if (!this.state.openThreads.includes(thread)) {
      this.state.openThreads.push(thread);
      this.state.lastUpdated = Date.now();
    }
  }

  removeOpenThread(thread: string): void {
    this.state.openThreads = this.state.openThreads.filter((t) => t !== thread);
    this.state.lastUpdated = Date.now();
  }

  addUserCorrection(correction: string): void {
    if (!this.state.userCorrections.includes(correction)) {
      this.state.userCorrections.push(correction);
      this.state.lastUpdated = Date.now();
    }
  }

  hasFilter(column: string, op?: string): boolean {
    return this.state.activeFilters.some(
      (f) => f.column === column && (op === undefined || f.op === op),
    );
  }

  getFilter(column: string, op?: string): EntityFilter | undefined {
    return this.state.activeFilters.find(
      (f) => f.column === column && (op === undefined || f.op === op),
    );
  }

  hasTable(tableName: string): boolean {
    return this.state.activeTables.includes(tableName);
  }

  hasColumn(columnName: string): boolean {
    return this.state.activeColumns.includes(columnName);
  }

  extractFromText(text: string, isUserCorrection: boolean = false): SQLExtraction {
    const extraction: SQLExtraction = {
      tables: [],
      columns: [],
      filters: [],
      aggregations: [],
    };

    const lowerText = text.toLowerCase();

    const tablePatterns = [
      /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi,
      /\b(?:table|tables?)\s+([a-z_][a-z0-9_]*)/gi,
    ];

    for (const pattern of tablePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const tableName = match[1];
        if (tableName) {
          const upperTableName = tableName.toUpperCase();
          if (!extraction.tables.includes(upperTableName)) {
            extraction.tables.push(upperTableName);
            this.addTable(upperTableName);
          }
        }
      }
    }

    const columnPatterns = [
      /\b([a-z_][a-z0-9_]*)\s*(?:=|!=|>|<|>=|<=|like|in)/gi,
      /\b(?:select|group by|order by)\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/gi,
    ];

    for (const pattern of columnPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const columns = match[1]?.split(',').map((c) => c.trim().toUpperCase()) ?? [];
        for (const column of columns) {
          if (column && !extraction.columns.includes(column)) {
            extraction.columns.push(column);
            this.addColumn(column);
          }
        }
      }
    }

    const filterPatterns = [
      /([a-z_][a-z0-9_]*)\s*(=|!=|>|<|>=|<=|like|in)\s*(['"]?[^'"]*['"]?)/gi,
      /([a-z_][a-z0-9_]*)\s+(?:is\s+)?(null|not null)/gi,
    ];

    for (const pattern of filterPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const column = match[1]?.toUpperCase() ?? '';
        const op = match[2]?.toUpperCase() as EntityFilter['op'];
        let value: string | string[] | number | null = match[3] ?? null;

        if (op === 'IS NULL' || op === 'IS NOT NULL') {
          value = null;
        } else if (value && typeof value === 'string') {
          const cleanedValue = value.replace(/['"]/g, '');
          if (op === 'IN') {
            value = cleanedValue.split(',').map((v) => v.trim());
          } else {
            value = cleanedValue;
          }
        } else {
          value = null;
        }

        const filter: EntityFilter = { column, op, value };
        extraction.filters.push(filter);
        this.addFilter(filter);
      }
    }

    const aggregationPatterns = [
      /\b(?:sum|avg|count|min|max)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/gi,
    ];

    for (const pattern of aggregationPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const expression = match[0].toUpperCase();
        if (!extraction.aggregations.find((a) => a.expression === expression)) {
          extraction.aggregations.push({ expression });
          this.addAggregation({ expression });
        }
      }
    }

    if (isUserCorrection) {
      this.addUserCorrection(text);
    }

    return extraction;
  }

  toJSON(): string {
    return JSON.stringify(this.state, null, 2);
  }

  fromJSON(json: string): void {
    try {
      const parsed = JSON.parse(json) as EntityState;
      this.state = {
        ...parsed,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      throw new Error(`Failed to parse entity state JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  estimateTokens(): number {
    const json = this.toJSON();
    return Math.ceil(json.length / 4);
  }

  reset(): void {
    this.state = this.createInitialState();
  }
}
