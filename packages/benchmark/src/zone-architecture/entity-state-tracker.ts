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

    // --- Open-thread extraction (runs unconditionally — natural language patterns) ---
    // Detect conversation threads / topics introduced by the user or assistant.
    // Patterns limit to 1-2 words to avoid capturing too much and to improve deduplication
    const threadPatterns = [
      /\b(?:let[''']s|lets)\s+(?:discuss|talk about|explore)\s+([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,1})\b/gi,
      /\b(?:show me|tell me about|what about)\s+(?:the\s+)?([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,1})\b/gi,
      /\b(?:regarding)\s+(?:the\s+)?([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,1})\b/gi,
      /\b(?:starting with|focused on|looking at)\s+([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,1})\b/gi,
    ];
    for (const pattern of threadPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const rawTopic = match[1]?.trim();
        if (rawTopic && rawTopic.length > 2 && rawTopic.length < 40) {
          const topic = rawTopic.toLowerCase().replace(/\s+/g, ' ');
          this.addOpenThread(topic);
        }
      }
    }

    // Guard: skip SQL entity extraction when text has no SQL context.
    // This prevents conversational prose ("from our analysis", "join me") from
    // polluting activeTables and activeColumns with common English words.
    const hasSQLContext =
      /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN)\b/i.test(text);
    if (!hasSQLContext) {
      if (isUserCorrection) {
        this.addUserCorrection(text);
      }
      return extraction;
    }

    // Table extraction — supports both simple (orders) and dotted (dbo.orders) and escaped ([orders])
    const tablePatterns = [
      /\b(?:FROM|JOIN)\s+(?:"?[^\s"]+"?\.)?\[?([a-z_][a-z0-9_]*)\]?/gi,
      /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:"?[^\s"]+"?\.)?\[?([a-z_][a-z0-9_]*)\]?/gi,
    ];

    for (const pattern of tablePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const tableName = match[1];
        if (tableName) {
          if (!extraction.tables.includes(tableName)) {
            extraction.tables.push(tableName);
            this.addTable(tableName);
          }
        }
      }
    }

    // Column extraction — supports dotted columns like db.schema.table.col
    const columnInConditionPatterns = [
      // a) simple or multi-part column on LHS:  col = ... or t.col = ... or db.sch.t.col = ...
      /\b([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s*(?:=|!=|<>|>|<|>=|<=|\bLIKE\b|\bIN\b)/gi,
    ];

    const columnListPatterns = [
      /\b(?:SELECT|GROUP\sBY|ORDER\sBY)\s+(.+?)(?=\s+(?:FROM|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INTERSECT|EXCEPT|$))/gi,
    ];

    for (const pattern of columnInConditionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const rawCol = match[1];
        if (rawCol) {
          const parts = rawCol.split('.');
          const column = parts[parts.length - 1]!;
          if (column && !extraction.columns.includes(column)) {
            extraction.columns.push(column);
            this.addColumn(column);
          }
        }
      }
    }

    for (const pattern of columnListPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const rawList = match[1];
        if (rawList) {
          const columns = rawList.split(',').map((c) => {
            const trimmed = c.trim();
            // Handle potentially complex expressions/aliases in SELECT list
            const parts = trimmed.split(/\s+AS\s+/i)[0]!.trim().split('.');
            return parts[parts.length - 1]!;
          });
          for (const column of columns) {
            // Further clean up to ensure it's a valid column name identifier
            const cleaned = column.match(/([a-z_][a-z0-9_]*)/i)?.[1];
            if (cleaned && !extraction.columns.includes(cleaned)) {
              extraction.columns.push(cleaned);
              this.addColumn(cleaned);
            }
          }
        }
      }
    }

    // Filter extraction
    const filterPatterns = [
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s*(=|!=|<>|>=|<=|>|<)\s*(?:'[^']*'|"[^"]*"|\d+(?:\.\d+)?)/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+\bIS\s+(?:NOT\s+)?NULL\b/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+\b(?:NOT\s+)?\bLIKE\b\s+(?:'[^']*'|"[^"]*")/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+\b(?:NOT\s+)?\bIN\b\s*\(/gi,
    ];

    for (const pattern of filterPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const column = match[1] ?? '';
        let op: EntityFilter['op'] = '=';
        let value: string | string[] | number | null = null;

        const fullMatch = match[0];
        const upperMatch = fullMatch.toUpperCase();

        if (upperMatch.includes('IS NULL')) {
          op = 'IS NULL';
          value = null;
        } else if (upperMatch.includes('IS NOT NULL')) {
          op = 'IS NOT NULL';
          value = null;
        } else if (upperMatch.includes('LIKE')) {
          op = upperMatch.includes('NOT LIKE') ? 'NOT LIKE' as EntityFilter['op'] : 'LIKE';
          const valMatch = fullMatch.match(/'([^']*)'|"([^"]*)"/);
          value = valMatch ? (valMatch[1] ?? valMatch[2] ?? '').replace(/^['"]|['"]$/g, '') : null;
        } else if (upperMatch.includes('IN')) {
          op = upperMatch.includes('NOT IN') ? 'NOT IN' as EntityFilter['op'] : 'IN';
          value = null; // complex IN list — tracked as present
        } else {
          const opMatch = fullMatch.match(/\s*(=|!=|<>|>=|<=|>|<)\s*/);
          if (opMatch) {
            op = opMatch[1] as EntityFilter['op'];
          }
            const valMatch = fullMatch.match(/(?:=|!=|<>|>=|<=|>|<)\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/);
            if (valMatch) {
              value = (valMatch[1] ?? valMatch[2] ?? valMatch[3] ?? '').replace(/^['"]|['"]$/g, '');
            }
        }

        const filter: EntityFilter = { column, op, value };
        extraction.filters.push(filter);
        this.addFilter(filter);
      }
    }

    // Aggregation extraction — supports balanced parentheses for complex expressions
    const aggFuncs = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];
    for (const func of aggFuncs) {
      const regex = new RegExp(`\\b${func}\\s*\\(`, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        const startPos = match.index + match[0].length;
        let parenCount = 1;
        let endPos = startPos;
        let inQuotes: string | null = null;

        while (parenCount > 0 && endPos < text.length) {
          const char = text[endPos];
          if (inQuotes) {
            if (char === inQuotes) inQuotes = null;
          } else if (char === "'" || char === '"') {
            inQuotes = char;
          } else if (char === '(') {
            parenCount++;
          } else if (char === ')') {
            parenCount--;
          }
          endPos++;
        }

        if (parenCount === 0) {
          const arg = text.substring(startPos, endPos - 1).trim();
          const expression = `${func}(${arg})`;
          if (!extraction.aggregations.find((a) => a.expression === expression)) {
            extraction.aggregations.push({ expression });
            this.addAggregation({ expression });
          }
        }
      }
    }

    if (isUserCorrection) {
      this.addUserCorrection(text);
    }

    return extraction;
  }

  /**
   * Extract filter conditions and table names from actual SQL queries in tool calls.
   * This gives Zone B ground-truth filter conditions with correct operators — unlike
   * extractFromText(), which reads prose and misreads exclusion semantics (e.g. seeing
   * "exclude orders with op = '5-LOW'" and storing op='=' instead of op='!=').
   */
  extractFromToolCalls(
    toolCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }>,
  ): void {
    for (const tc of toolCalls) {
      if (tc.toolName !== 'runQuery') continue;
      const sql = String(tc.toolInput['query'] ?? '');
      if (!sql) continue;
      this.extractFiltersFromSQL(sql);
      this.extractTablesFromSQL(sql);
    }
  }

  private extractFiltersFromSQL(sql: string): void {
    // WHERE-clause filter extraction — the SQL is always real SQL so no keyword guard needed
    const filterPatterns = [
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s*(=|!=|<>|>=|<=|>|<)\s*(?:'[^']*'|"[^"]*"|\d+(?:\.\d+)?)/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+\bIS\s+(NOT\s+)?NULL\b/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+(NOT\s+)?\bLIKE\b\s+(?:'[^']*'|"[^"]*")/gi,
      /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s+(NOT\s+)?\bIN\b\s*\(/gi,
    ];

    for (const pattern of filterPatterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        const rawCol = match[1] ?? '';
        const parts = rawCol.split('.');
        const column = parts[parts.length - 1]!;
        if (!column) continue;

        const fullMatch = match[0];
        const upperMatch = fullMatch.toUpperCase();
        let op: EntityFilter['op'] = '=';
        let value: string | string[] | number | null = null;

        if (upperMatch.includes('IS NOT NULL')) {
          op = 'IS NOT NULL';
        } else if (upperMatch.includes('IS NULL')) {
          op = 'IS NULL';
        } else if (upperMatch.includes('NOT LIKE')) {
          op = 'NOT LIKE' as EntityFilter['op'];
          const valMatch = fullMatch.match(/'([^']*)'|"([^"]*)"/);
          value = valMatch ? (valMatch[1] ?? valMatch[2] ?? '') : null;
        } else if (upperMatch.includes('LIKE')) {
          op = 'LIKE';
          const valMatch = fullMatch.match(/'([^']*)'|"([^"]*)"/);
          value = valMatch ? (valMatch[1] ?? valMatch[2] ?? '') : null;
        } else if (upperMatch.includes('NOT IN')) {
          op = 'NOT IN' as EntityFilter['op'];
        } else if (upperMatch.includes(' IN ') || upperMatch.includes(' IN(')) {
          op = 'IN';
        } else {
          const opMatch = fullMatch.match(/\s*(!=|<>|>=|<=|>|<|=)\s*/);
          if (opMatch) op = opMatch[1] as EntityFilter['op'];
          const valMatch = fullMatch.match(/(?:!=|<>|>=|<=|>|<|=)\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/);
          if (valMatch) value = valMatch[1] ?? valMatch[2] ?? valMatch[3] ?? '';
        }

        this.addFilter({ column, op, value });
      }
    }
  }

  private extractTablesFromSQL(sql: string): void {
    const tablePatterns = [
      /\b(?:FROM|JOIN)\s+(?:"?[^\s"]+"?\.)?\[?([a-z_][a-z0-9_]*)\]?/gi,
    ];
    for (const pattern of tablePatterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        const tableName = match[1];
        if (tableName) this.addTable(tableName);
      }
    }
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
