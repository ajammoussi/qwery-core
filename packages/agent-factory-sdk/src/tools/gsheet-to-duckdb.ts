import type { Datasource, SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { GSheetAttachmentStrategy } from './datasource-attachment/strategies/gsheet-attachment-strategy';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

// Legacy interface - kept for backward compatibility
export interface GSheetToDuckDbOptions {
  connection: Connection;
  sharedLink: string;
  viewName: string;
}

// New interface for attaching as database
export interface GSheetAttachOptions {
  connection: Connection;
  datasource: Datasource;
  extractSchema?: boolean; // Default: true for backward compatibility
  conversationId: string; // Required for persistent database file path
  workspace: string; // Required for persistent database file path
}

export interface GSheetTab {
  gid: number;
  csvUrl: string;
  name?: string;
}

export interface GSheetAttachResult {
  attachedDatabaseName: string;
  tables: Array<{
    schema: string;
    table: string;
    csvUrl: string;
    schemaDefinition?: SimpleSchema;
  }>;
}

/**
 * Legacy function - creates a single view from Google Sheet
 * @deprecated This function has been removed. Use attachGSheetDatasource instead for multi-tab support.
 * This function is kept as a stub for backward compatibility but will throw an error.
 */
export const gsheetToDuckdb = async (
  _opts: GSheetToDuckDbOptions,
): Promise<string> => {
  throw new Error(
    'gsheetToDuckdb is deprecated. Use attachGSheetDatasource instead for multi-tab support.',
  );
};

/**
 * Attach Google Sheets as a persistent database with tables for each tab
 * Similar to attachForeignDatasource but for Google Sheets
 *
 * Creates a persistent SQLite database file at:
 * {workspace}/{conversationId}/{datasource_name}.db
 *
 * This ensures tables persist across connections, unlike in-memory databases.
 * Each tab in the Google Sheet becomes a separate table in the attached database.
 *
 * @deprecated This function is kept for backward compatibility.
 * It delegates to the unified datasource attachment service.
 */
export async function attachGSheetDatasource(
  opts: GSheetAttachOptions,
): Promise<GSheetAttachResult> {
  // Use GSheetAttachmentStrategy directly to get full GSheetAttachResult
  const strategy = new GSheetAttachmentStrategy();
  const result = await strategy.attach({
    connection: opts.connection,
    datasource: opts.datasource,
    conversationId: opts.conversationId,
    workspace: opts.workspace,
    extractSchema: opts.extractSchema,
  });

  // Convert AttachmentResult to GSheetAttachResult format
  if (result.attachedDatabaseName && result.tables) {
    return {
      attachedDatabaseName: result.attachedDatabaseName,
      tables: result.tables.map(
        (t: {
          schema: string;
          table: string;
          csvUrl?: string;
          schemaDefinition?: SimpleSchema;
        }) => ({
          schema: t.schema,
          table: t.table,
          csvUrl: t.csvUrl || '',
          schemaDefinition: t.schemaDefinition,
        }),
      ),
    };
  }

  throw new Error(
    'attachGSheetDatasource: Unexpected result format from attachment strategy',
  );
}
