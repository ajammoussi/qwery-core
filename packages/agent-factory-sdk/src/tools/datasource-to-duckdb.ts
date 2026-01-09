import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { attachDatasource } from './datasource-attachment-service';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

export interface DatasourceToDuckDbOptions {
  connection: Connection; // Changed from dbPath
  datasource: Datasource;
  conversationId?: string; // For persistent DB files
  workspace?: string; // For persistent DB files
}

export interface CreateViewResult {
  viewName: string;
  displayName: string;
  schema: SimpleSchema;
}

/**
 * Create DuckDB views from a datasource
 * Delegates to unified datasource attachment service
 */
export async function datasourceToDuckdb(
  opts: DatasourceToDuckDbOptions,
): Promise<CreateViewResult> {
  // Delegate to unified attachment service
  return await attachDatasource({
    connection: opts.connection,
    datasource: opts.datasource,
    conversationId: opts.conversationId,
    workspace: opts.workspace,
  });
}
