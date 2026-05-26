import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import type { BenchmarkResult, CompressionMethod, ContextMode } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMPRESSION_METHODS: CompressionMethod[] = [
  'baseline-no-compression',
  'llmlingua-2',
  'longllmlingua',
  'sliding-window',
  'qwery-default',
  'entity-state',
];

const CONTEXT_MODES: ContextMode[] = ['plain', '4zone'];

async function generateReport(compressionMethod?: CompressionMethod, contextMode?: ContextMode) {
  const resultsBaseDir = join(__dirname, '..', 'data', 'results');
  const reportDir = join(__dirname, '..', 'data', 'reports');

  await mkdir(reportDir, { recursive: true });
  // Note: Results structure updated to store messages and usage per-turn only
  // (removed redundant arrays to reduce file size and simplify structure)

  const databases = ['tpch', 'saas'];
  const types = ['rci', 'irc', 'pta', 'dcs', 'sncj'];

  const methodsToProcess = compressionMethod
    ? [compressionMethod]
    : COMPRESSION_METHODS;

  const contextModesToProcess = contextMode
    ? [contextMode]
    : CONTEXT_MODES;

  for (const method of methodsToProcess) {
    for (const mode of contextModesToProcess) {
      const methodDir = join(resultsBaseDir, method, mode);

    const report: {
      compressionMethod: CompressionMethod;
      contextMode: ContextMode;
      summary: {
        totalSessions: number;
        totalTurns: number;
        totalToolCalls: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        totalCachedInputTokens: number;
        totalCost: number;
        avgResponseTimeMs: number;
        successRate: number;
        avgFilterPersistenceRate: number | null;
        avgReferenceResolutionRate: number | null;
        avgToolSuccessRate: number | null;
      };
      byDatabase: Record<
        string,
        {
          sessions: number;
          turns: number;
          toolCalls: number;
          inputTokens: number;
          outputTokens: number;
          reasoningTokens: number;
          cachedInputTokens: number;
          cost: number;
          avgResponseTimeMs: number;
        }
      >;
      byType: Record<
        string,
        {
          sessions: number;
          turns: number;
          toolCalls: number;
          inputTokens: number;
          outputTokens: number;
          reasoningTokens: number;
          cachedInputTokens: number;
          cost: number;
          avgResponseTimeMs: number;
        }
      >;
      sessions: BenchmarkResult[];
    } = {
      compressionMethod: method,
      contextMode: mode,
      summary: {
        totalSessions: 0,
        totalTurns: 0,
        totalToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        totalCachedInputTokens: 0,
        totalCost: 0,
        avgResponseTimeMs: 0,
        successRate: 0,
        avgFilterPersistenceRate: null,
        avgReferenceResolutionRate: null,
        avgToolSuccessRate: null,
      },
      byDatabase: {},
      byType: {},
      sessions: [],
    };

    for (const db of databases) {
      report.byDatabase[db] = {
        sessions: 0,
        turns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cost: 0,
        avgResponseTimeMs: 0,
      };

      for (const type of types) {
        const typeDir = join(methodDir, db, type);
        try {
          const files = await readdir(typeDir);
          for (const file of files.filter((f: string) => f.endsWith('.json'))) {
            const content = await readFile(join(typeDir, file), 'utf-8');
            const result = JSON.parse(content) as BenchmarkResult;

            report.sessions.push(result);
            report.summary.totalSessions++;
            report.summary.totalTurns += result.metrics.totalTurns;
            report.summary.totalToolCalls += result.metrics.totalToolCalls;
            report.summary.totalInputTokens += result.metrics.totalInputTokens;
            report.summary.totalOutputTokens +=
              result.metrics.totalOutputTokens;
            report.summary.totalReasoningTokens +=
              result.metrics.totalReasoningTokens ?? 0;
            report.summary.totalCachedInputTokens +=
              result.metrics.totalCachedInputTokens ?? 0;
            report.summary.totalCost += result.metrics.totalCost ?? 0;

            report.byDatabase[db].sessions++;
            report.byDatabase[db].turns += result.metrics.totalTurns;
            report.byDatabase[db].toolCalls += result.metrics.totalToolCalls;
            report.byDatabase[db].inputTokens +=
              result.metrics.totalInputTokens;
            report.byDatabase[db].outputTokens +=
              result.metrics.totalOutputTokens;
            report.byDatabase[db].reasoningTokens +=
              result.metrics.totalReasoningTokens ?? 0;
            report.byDatabase[db].cachedInputTokens +=
              result.metrics.totalCachedInputTokens ?? 0;
            report.byDatabase[db].cost += result.metrics.totalCost ?? 0;

            if (!report.byType[type]) {
              report.byType[type] = {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cachedInputTokens: 0,
                cost: 0,
                avgResponseTimeMs: 0,
              };
            }
            report.byType[type].sessions++;
            report.byType[type].turns += result.metrics.totalTurns;
            report.byType[type].toolCalls += result.metrics.totalToolCalls;
            report.byType[type].inputTokens += result.metrics.totalInputTokens;
            report.byType[type].outputTokens +=
              result.metrics.totalOutputTokens;
            report.byType[type].reasoningTokens +=
              result.metrics.totalReasoningTokens ?? 0;
            report.byType[type].cachedInputTokens +=
              result.metrics.totalCachedInputTokens ?? 0;
            report.byType[type].cost += result.metrics.totalCost ?? 0;
          }
        } catch {
          // Directory doesn't exist
        }
      }
    }

    if (report.summary.totalSessions > 0) {
      report.summary.avgResponseTimeMs = Math.round(
        report.sessions.reduce(
          (sum, s) => sum + s.metrics.avgResponseTimeMs,
          0,
        ) / report.summary.totalSessions,
      );
      report.summary.successRate =
        report.sessions.filter((s) => s.errors.length === 0).length /
        report.summary.totalSessions;

      for (const db of Object.keys(report.byDatabase)) {
        const dbEntry = report.byDatabase[db];
        if (dbEntry && dbEntry.sessions > 0) {
          dbEntry.avgResponseTimeMs = Math.round(
            report.sessions
              .filter((s) => s.database === db)
              .reduce((sum, s) => sum + s.metrics.avgResponseTimeMs, 0) /
              dbEntry.sessions,
          );
        }
      }

      for (const type of Object.keys(report.byType)) {
        const typeEntry = report.byType[type];
        if (typeEntry && typeEntry.sessions > 0) {
          typeEntry.avgResponseTimeMs = Math.round(
            report.sessions
              .filter((s) => s.conversationType.toLowerCase() === type)
              .reduce((sum, s) => sum + s.metrics.avgResponseTimeMs, 0) /
              typeEntry.sessions,
          );
        }
      }

      // Quality metric averages (null-aware: only average sessions that have data)
      const fprValues = report.sessions
        .map((s) => s.metrics.filterPersistenceRate)
        .filter((v): v is number => v !== null);
      report.summary.avgFilterPersistenceRate =
        fprValues.length > 0
          ? Math.round((fprValues.reduce((a, b) => a + b, 0) / fprValues.length) * 1000) / 1000
          : null;

      const rrrValues = report.sessions
        .map((s) => s.metrics.referenceResolutionAccuracy)
        .filter((v): v is number => v !== null);
      report.summary.avgReferenceResolutionRate =
        rrrValues.length > 0
          ? Math.round((rrrValues.reduce((a, b) => a + b, 0) / rrrValues.length) * 1000) / 1000
          : null;

      const tsrValues = report.sessions
        .map((s) => s.metrics.toolSuccessRate)
        .filter((v): v is number => v !== null);
      report.summary.avgToolSuccessRate =
        tsrValues.length > 0
          ? Math.round((tsrValues.reduce((a, b) => a + b, 0) / tsrValues.length) * 1000) / 1000
          : null;
    }

    const reportPath = join(
      reportDir,
      `benchmark-report-${method}-${mode}-${new Date().toISOString().split('T')[0]}.json`,
    );
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`\n=== Benchmark Report: ${method} (${mode}) ===`);
    console.log(`Total Sessions: ${report.summary.totalSessions}`);
    console.log(`Total Turns: ${report.summary.totalTurns}`);
    console.log(`Total Tool Calls: ${report.summary.totalToolCalls}`);
    console.log(`Total Input Tokens: ${report.summary.totalInputTokens}`);
    console.log(`Total Output Tokens: ${report.summary.totalOutputTokens}`);
    console.log(
      `Total Reasoning Tokens: ${report.summary.totalReasoningTokens}`,
    );
    console.log(
      `Total Cached Input Tokens: ${report.summary.totalCachedInputTokens}`,
    );
    console.log(`Total Cost: $${report.summary.totalCost.toFixed(4)}`);
    console.log(`Avg Response Time: ${report.summary.avgResponseTimeMs}ms`);
    console.log(
      `Success Rate: ${(report.summary.successRate * 100).toFixed(1)}%`,
    );

    if (report.summary.avgFilterPersistenceRate !== null) {
      console.log(
        `Filter Persistence Rate: ${(report.summary.avgFilterPersistenceRate * 100).toFixed(1)}%`,
      );
    }
    if (report.summary.avgReferenceResolutionRate !== null) {
      console.log(
        `Reference Resolution Rate: ${(report.summary.avgReferenceResolutionRate * 100).toFixed(1)}%`,
      );
    }
    if (report.summary.avgToolSuccessRate !== null) {
      console.log(
        `Tool Success Rate: ${(report.summary.avgToolSuccessRate * 100).toFixed(1)}%`,
      );
    }

    console.log('\nBy Database:');
    for (const [db, stats] of Object.entries(report.byDatabase)) {
      const dbStats = stats as {
        sessions: number;
        turns: number;
        toolCalls: number;
      };
      if (dbStats.sessions > 0) {
        console.log(
          ` ${db}: ${dbStats.sessions} sessions, ${dbStats.turns} turns, ${dbStats.toolCalls} tools`,
        );
      }
    }

    console.log('\nBy Type:');
    for (const [type, stats] of Object.entries(report.byType)) {
      const typeStats = stats as { sessions: number; turns: number };
      if (typeStats.sessions > 0) {
        console.log(
          ` ${type.toUpperCase()}: ${typeStats.sessions} sessions, ${typeStats.turns} turns`,
        );
      }
    }

    console.log(`\nReport saved to: ${reportPath}`);
    }
  }
}

const methodArg = process.argv[2] as CompressionMethod | undefined;
const modeArg = process.argv[3] as ContextMode | undefined;
generateReport(methodArg, modeArg).catch(console.error);
