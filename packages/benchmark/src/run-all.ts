import { parseArgs } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, cp } from 'fs/promises';
import { loadAllSessions } from './session-loader.js';
import {
  runSession,
  ensureDatasource,
  createBenchmarkRepositories,
} from './runner.js';
import type { BenchmarkConfig } from './runner.js';
import type { CompressionMethod } from './types.js';

type DatasourceConfig = {
  provider: string;
  config: Record<string, unknown>;
};

type SessionRunResult = {
  sessionId: string;
  status: 'success' | 'error';
  error?: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

async function copyTestCasesToData() {
  const sessionsDir = join(__dirname, '..', 'data', 'sessions');
  const testcasesDir = join(__dirname, '..', 'tpch');
  const testcasesSaasDir = join(__dirname, '..', 'saas');

  await mkdir(sessionsDir, { recursive: true });

  try {
    await cp(testcasesDir, join(sessionsDir, 'tpch'), { recursive: true });
    console.log('Copied TPCH test cases to data/sessions/tpch');
  } catch {
    console.log('TPCH test cases already in place or not found');
  }

  try {
    await cp(testcasesSaasDir, join(sessionsDir, 'saas'), { recursive: true });
    console.log('Copied SaaS test cases to data/sessions/saas');
  } catch {
    console.log('SaaS test cases already in place or not found');
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: {
        type: 'string',
        short: 'd',
      },
      type: {
        type: 'string',
        short: 't',
      },
      model: {
        type: 'string',
        short: 'm',
        default: 'minimax/m2.7',
      },
      'storage-dir': {
        type: 'string',
        short: 's',
        default: join(__dirname, '..', 'data', 'benchmark.db'),
      },
      'compression-method': {
        type: 'string',
        short: 'c',
        default: 'baseline-no-compression',
      },
      'copy-testcases': {
        type: 'boolean',
        default: true,
      },
      limit: {
        type: 'string',
        short: 'l',
      },
    },
    allowPositional: true,
  });

  if (values['copy-testcases']) {
    await copyTestCasesToData();
  }

  const database = values.db as 'tpch' | 'saas' | undefined;
  const type = values.type as string | undefined;
  const model = values.model;
  const storageDir = values['storage-dir'];
  const compressionMethod = values['compression-method'] as CompressionMethod;
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;

  console.log('Loading sessions...');
  const sessions = await loadAllSessions(database, type);
  const sessionsToRun = limit ? sessions.slice(0, limit) : sessions;

  console.log(
    `Found ${sessions.length} sessions, running ${sessionsToRun.length}`,
  );
  console.log(`Model: ${model}`);
  console.log(`Storage: ${storageDir}`);
  console.log(`Compression Method: ${compressionMethod}`);

  const repositories = await createBenchmarkRepositories(storageDir!);

  const datasourceConfigs: Record<'tpch' | 'saas', DatasourceConfig> = {
    tpch: {
      provider: 'postgresql',
      config: {
        host: 'localhost',
        port: 55432,
        database: 'tpch',
        user: 'postgres',
        password: 'postgres',
      },
    },
    saas: {
      provider: 'postgresql',
      config: {
        host: 'localhost',
        port: 55433,
        database: 'saas_analytics',
        user: 'postgres',
        password: 'postgres',
      },
    },
  };

  const datasourceIds: Partial<Record<'tpch' | 'saas', string>> = {};

  for (const [db, dsConfig] of Object.entries(datasourceConfigs)) {
    datasourceIds[db] = await ensureDatasource(
      repositories,
      `${db}_benchmark`,
      dsConfig.provider,
      dsConfig.config,
    );
    console.log(`Datasource ${db}: ${datasourceIds[db]}`);
  }

  const results: SessionRunResult[] = [];

  for (let i = 0; i < sessionsToRun.length; i++) {
    const session = sessionsToRun[i];
    console.log(
      `\n[${i + 1}/${sessionsToRun.length}] Running ${session.id}...`,
    );

    const config: BenchmarkConfig = {
      model,
      maxSteps: 10,
      datasourceId: datasourceIds[session.metadata.database] ?? '',
      storageDir,
      compressionMethod,
    };

    try {
      const result = await runSession(session, config);
      console.log(
        `  Completed: ${result.turns.length} turns, ${result.metrics.totalToolCalls} tool calls`,
      );
      results.push({ sessionId: session.id, status: 'success' });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`  Error: ${errorMessage}`);
      results.push({
        sessionId: session.id,
        status: 'error',
        error: errorMessage,
      });
    }
  }

  console.log('\n=== Summary ===');
  const successful = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'error').length;
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Compression: ${compressionMethod}`);
  console.log(`Results saved to: data/results/${compressionMethod}/`);

  if (failed > 0) {
    console.log('\nFailed sessions:');
    results
      .filter((r) => r.status === 'error')
      .forEach((r) => {
        console.log(`  ${r.sessionId}: ${r.error}`);
      });
  }
}

main().catch(console.error);
