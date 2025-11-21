import type { Datasource } from '@qwery/domain/entities';
import { SqlAgent } from './sql-agent';
import { createDriverForDatasource } from '../extensions/driver-factory';

export interface RunCellOptions {
  datasource: Datasource;
  query: string;
  mode: 'sql' | 'natural';
}

export interface RunCellResult {
  sql: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

export class NotebookRunner {
  private agent: SqlAgent | null = null;

  private getAgent(): SqlAgent {
    if (!this.agent) {
      this.agent = new SqlAgent();
    }
    return this.agent;
  }

  public async testConnection(datasource: Datasource): Promise<void> {
    const driver = await createDriverForDatasource(datasource);
    try {
      await driver.testConnection();
    } finally {
      driver.close();
    }
  }

  public async runCell(options: RunCellOptions): Promise<RunCellResult> {
    const driver = await createDriverForDatasource(options.datasource);
    let sql = options.query;

    try {
      if (options.mode === 'natural') {
        const schema =
          (await driver.getCurrentSchema()) ??
          'Schema unavailable. Generate best-effort SQL.';
        const agent = this.getAgent();
        sql = await agent.generateSql({
          datasourceName: options.datasource.name,
          naturalLanguage: options.query,
          schemaDescription: schema,
        });
      }

      const result = await driver.query(sql);
      const rowCount =
        result.stat.rowsRead ?? result.stat.rowsAffected ?? result.rows.length;
      return { sql, rows: result.rows, rowCount };
    } finally {
      driver.close();
    }
  }
}

