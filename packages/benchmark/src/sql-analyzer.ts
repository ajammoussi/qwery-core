import type { TurnResult } from './types.js';

// Only call extractTableRefs on actual SQL strings (toolInput.query), never on free text.
export function extractTableRefs(sql: string): string[] {
  const refs = new Set<string>();
  // Matches table names after FROM/JOIN/INTO/UPDATE/TABLE, handles schema.table and quoted names
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:[\w"]+\.)?["']?([\w]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) refs.add(m[1].toLowerCase());
  }
  return Array.from(refs);
}

export function extractKnownTables(turns: TurnResult[]): Set<string> {
  const tables = new Set<string>();
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (tc.toolName !== 'getSchema') continue;
      const raw = tc.toolOutput;
      if (!raw) continue;
      try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // Actual format: { datasources: [{ schema: [{ tables: [{ tableName }] }] }] }
        const datasources = (parsed as Record<string, unknown>)?.['datasources'];
        if (Array.isArray(datasources)) {
          for (const ds of datasources) {
            const schema = (ds as Record<string, unknown>)?.['schema'];
            if (Array.isArray(schema)) {
              for (const s of schema) {
                const tbl = (s as Record<string, unknown>)?.['tables'];
                if (Array.isArray(tbl)) {
                  for (const t of tbl) {
                    const name = (t as Record<string, unknown>)?.['tableName'];
                    if (typeof name === 'string') tables.add(name.toLowerCase());
                  }
                }
              }
            }
          }
        }
      } catch {
        // Fallback: grab quoted or uppercase table-like words from raw text
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        const re = /["']tableName["']\s*:\s*["']([^"']+)["']/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[1]) tables.add(m[1].toLowerCase());
        }
      }
    }
  }
  return tables;
}

export function classifySQLError(error: string): 'syntax' | 'semantic' | 'runtime' {
  if (/syntax error|parse error|invalid input syntax/i.test(error)) return 'syntax';
  if (/does not exist|no such table|column .+ of relation|undefined column/i.test(error))
    return 'semantic';
  return 'runtime';
}

export function computeSQLValidityRate(turns: TurnResult[]): number | null {
  const runQueryCalls = turns.flatMap((t) =>
    t.toolCalls.filter((tc) => tc.toolName === 'runQuery'),
  );
  if (runQueryCalls.length === 0) return null;

  const valid = runQueryCalls.filter((tc) => {
    if (tc.success) return true;
    const errClass = classifySQLError(tc.error ?? '');
    return errClass === 'runtime'; // syntax + semantic count as invalid SQL
  });

  return Math.round((valid.length / runQueryCalls.length) * 1000) / 1000;
}

export function computeSchemaGroundingRate(
  turns: TurnResult[],
  knownTables: Set<string>,
): number | null {
  if (knownTables.size === 0) return null;

  const runQueryCalls = turns.flatMap((t) =>
    t.toolCalls.filter((tc) => tc.toolName === 'runQuery'),
  );
  if (runQueryCalls.length === 0) return null;

  let grounded = 0;
  let evaluated = 0;

  for (const tc of runQueryCalls) {
    const sql = tc.toolInput['query'];
    if (typeof sql !== 'string' || sql.trim().length === 0) continue;
    evaluated++;
    const refs = extractTableRefs(sql);
    if (refs.length === 0 || refs.every((r) => knownTables.has(r))) {
      grounded++;
    }
  }

  if (evaluated === 0) return null;
  return Math.round((grounded / evaluated) * 1000) / 1000;
}
