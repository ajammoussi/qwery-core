import type {
  BenchmarkSession,
  BenchmarkResult,
  TurnResult,
  ToolCallResult,
  SessionMetrics,
  CompressionMethod,
} from './types.js';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadSession(filePath: string): Promise {
export async function loadSession(
  filePath: string,
): Promise<BenchmarkSession> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as BenchmarkSession;
}

export async function loadAllSessions(
  database?: string,
  type?: string,
): Promise<BenchmarkSession[]> {
  const sessions: BenchmarkSession[] = [];
  const baseDir = join(__dirname, '..', 'data', 'sessions');

  const dbs = database ? [database] : ['tpch', 'saas'];

  for (const db of dbs) {
    const dbDir = join(baseDir, db);
    try {
      const types = type ? [type.toLowerCase()] : await readdir(dbDir);

      for (const convType of types) {
        const typeDir = join(dbDir, convType);
        try {
          const files = await readdir(typeDir);
          for (const file of files.filter((f) => f.endsWith('.json'))) {
            const session = await loadSession(join(typeDir, file));
            sessions.push(session);
          }
        } catch {
          // Directory doesn't exist
        }
      }
    } catch {
      // Database directory doesn't exist
    }
  }

  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveResult(
  result: BenchmarkResult,
  compressionMethod: CompressionMethod = 'baseline-no-compression',
): Promise<string> {
  const baseDir = join(__dirname, '..', 'data', 'results', compressionMethod);
  const resultDir = join(
    baseDir,
    result.database,
    result.conversationType.toLowerCase(),
  );

  await mkdir(resultDir, { recursive: true });

  const filePath = join(resultDir, `${result.sessionId}.json`);
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');

  return filePath;
}

export function calculateMetrics(turns: TurnResult[]): SessionMetrics {
  const totalTurns = turns.length;
  const totalInputTokens = turns.reduce((sum, t) => sum + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((sum, t) => sum + t.outputTokens, 0);
  const totalResponseTimeMs = turns.reduce(
    (sum, t) => sum + t.responseTimeMs,
    0,
  );
  const totalToolCalls = turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
  const failedToolCalls = turns.reduce(
    (sum, t) => sum + t.toolCalls.filter((tc) => !tc.success).length,
    0,
  );

  return {
    totalTurns,
    totalInputTokens,
    totalOutputTokens,
    totalResponseTimeMs,
    totalToolCalls,
    failedToolCalls,
    avgResponseTimeMs:
      totalTurns > 0 ? Math.round(totalResponseTimeMs / totalTurns) : 0,
    avgToolCallsPerTurn:
      totalTurns > 0
        ? Math.round((totalToolCalls / totalTurns) * 100) / 100
        : 0,
    filterPersistenceRate: null,
    entityRecallAccuracy: null,
    referenceResolutionAccuracy: null,
  };
}

export function createEmptyResult(
  session: BenchmarkSession,
  compressionMethod: CompressionMethod = 'baseline-no-compression',
): BenchmarkResult {
  return {
    sessionId: session.id,
    database: session.metadata.database,
    conversationType: session.metadata.conversationType,
    compressionMethod,
    conversationId: '',
    conversationSlug: '',
    startedAt: new Date().toISOString(),
    completedAt: '',
    turns: [],
    metrics: {
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalResponseTimeMs: 0,
      totalToolCalls: 0,
      failedToolCalls: 0,
      avgResponseTimeMs: 0,
      avgToolCallsPerTurn: 0,
      filterPersistenceRate: null,
      entityRecallAccuracy: null,
      referenceResolutionAccuracy: null,
    },
    errors: [],
  };
}
