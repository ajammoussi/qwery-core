import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import type { BenchmarkResult, CompressionMethod } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMPRESSION_METHODS: CompressionMethod[] = [
  'baseline-no-compression',
  'llmlingua',
  'longllmlingua',
  'sliding-window',
  'summary-prose',
  'entity-state',
];

async function generateReport(compressionMethod?: CompressionMethod) {
  const resultsBaseDir = join(__dirname, '..', 'data', 'results');
  const reportDir = join(__dirname, '..', 'data', 'reports');

  await mkdir(reportDir, { recursive: true });

  const databases = ['tpch', 'saas'];
  const types = ['rci', 'irc', 'pta', 'dcs', 'sncj'];

  const methodsToProcess = compressionMethod
    ? [compressionMethod]
    : COMPRESSION_METHODS;

  for (const method of methodsToProcess) {
    const methodDir = join(resultsBaseDir, method);

    const report: {
      compressionMethod: CompressionMethod;
      summary: {
        totalSessions: number;
        totalTurns: number;
        totalToolCalls: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        avgResponseTimeMs: number;
        successRate: number;
      };
      byDatabase: Record;
      byType: Record;
      sessions: BenchmarkResult[];
    } = {
      compressionMethod: method,
      summary: {
        totalSessions: 0,
        totalTurns: 0,
        totalToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        avgResponseTimeMs: 0,
        successRate: 0,
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
        avgResponseTimeMs: 0,
      };

      for (const type of types) {
        const typeDir = join(methodDir, db, type);
        try {
          const files = await readdir(typeDir);
          for (const file of files.filter((f) => f.endsWith('.json'))) {
            const content = await readFile(join(typeDir, file), 'utf-8');
            const result = JSON.parse(content) as BenchmarkResult;

            report.sessions.push(result);
            report.summary.totalSessions++;
            report.summary.totalTurns += result.metrics.totalTurns;
            report.summary.totalToolCalls += result.metrics.totalToolCalls;
            report.summary.totalInputTokens += result.metrics.totalInputTokens;
            report.summary.totalOutputTokens +=
              result.metrics.totalOutputTokens;

            report.byDatabase[db].sessions++;
            report.byDatabase[db].turns += result.metrics.totalTurns;
            report.byDatabase[db].toolCalls += result.metrics.totalToolCalls;
            report.byDatabase[db].inputTokens +=
              result.metrics.totalInputTokens;
            report.byDatabase[db].outputTokens +=
              result.metrics.totalOutputTokens;

            if (!report.byType[type]) {
              report.byType[type] = {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                avgResponseTimeMs: 0,
              };
            }
            report.byType[type].sessions++;
            report.byType[type].turns += result.metrics.totalTurns;
            report.byType[type].toolCalls += result.metrics.totalToolCalls;
            report.byType[type].inputTokens += result.metrics.totalInputTokens;
            report.byType[type].outputTokens +=
              result.metrics.totalOutputTokens;
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
        if (report.byDatabase[db].sessions > 0) {
          report.byDatabase[db].avgResponseTimeMs = Math.round(
            report.sessions
              .filter((s) => s.database === db)
              .reduce((sum, s) => sum + s.metrics.avgResponseTimeMs, 0) /
              report.byDatabase[db].sessions,
          );
        }
      }

      for (const type of Object.keys(report.byType)) {
        if (report.byType[type].sessions > 0) {
          report.byType[type].avgResponseTimeMs = Math.round(
            report.sessions
              .filter((s) => s.conversationType.toLowerCase() === type)
              .reduce((sum, s) => sum + s.metrics.avgResponseTimeMs, 0) /
              report.byType[type].sessions,
          );
        }
      }
    }

    const reportPath = join(
      reportDir,
      `benchmark-report-${method}-${new Date().toISOString().split('T')[0]}.json`,
    );
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`\n=== Benchmark Report: ${method} ===`);
    console.log(`Total Sessions: ${report.summary.totalSessions}`);
    console.log(`Total Turns: ${report.summary.totalTurns}`);
    console.log(`Total Tool Calls: ${report.summary.totalToolCalls}`);
    console.log(`Total Input Tokens: ${report.summary.totalInputTokens}`);
    console.log(`Total Output Tokens: ${report.summary.totalOutputTokens}`);
    console.log(`Avg Response Time: ${report.summary.avgResponseTimeMs}ms`);
    console.log(
      `Success Rate: ${(report.summary.successRate * 100).toFixed(1)}%`,
    );

    console.log('\nBy Database:');
    for (const [db, stats] of Object.entries(report.byDatabase)) {
      if (stats.sessions > 0) {
        console.log(
          `  ${db}: ${stats.sessions} sessions, ${stats.turns} turns, ${stats.toolCalls} tools`,
        );
      }
    }

    console.log('\nBy Type:');
    for (const [type, stats] of Object.entries(report.byType)) {
      if (stats.sessions > 0) {
        console.log(
          `  ${type.toUpperCase()}: ${stats.sessions} sessions, ${stats.turns} turns`,
        );
      }
    }

    console.log(`\nReport saved to: ${reportPath}`);
  }
}

const methodArg = process.argv[2] as CompressionMethod | undefined;
generateReport(methodArg).catch(console.error);
