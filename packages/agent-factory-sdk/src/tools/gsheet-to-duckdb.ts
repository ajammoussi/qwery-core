import type { Datasource, SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { getDatasourceDatabaseName } from './datasource-name-utils';
import { generateSemanticViewName } from './view-registry';

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
 * Extract spreadsheet ID from Google Sheets URL
 */
function extractSpreadsheetId(url: string): string | null {
  const match = url.match(
    /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
  );
  return match?.[1] ?? null;
}

/**
 * Generate CSV export URL for a specific tab (gid)
 */
function getCsvUrlForTab(spreadsheetId: string, gid: number): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

/**
 * Convert Google Sheets URL to CSV export URL (legacy function)
 */
const convertToCsvLink = (message: string) => {
  const match = message.match(
    /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
  );
  if (!match) return message;
  const spreadsheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
};

/**
 * Legacy function - creates a single view from Google Sheet
 * @deprecated Use attachGSheetDatasource instead for multi-tab support
 */
export const gsheetToDuckdb = async (
  opts: GSheetToDuckDbOptions,
): Promise<string> => {
  const csvLink = convertToCsvLink(opts.sharedLink);
  const conn = opts.connection;

  const escapedUrl = csvLink.replace(/'/g, "''");
  const escapedViewName = opts.viewName.replace(/"/g, '""');

  // Create or replace view directly from the CSV URL
  await conn.run(`
    CREATE OR REPLACE VIEW "${escapedViewName}" AS
    SELECT * FROM read_csv_auto('${escapedUrl}')
  `);

  return `Successfully created view '${opts.viewName}' from Google Sheet`;
};

/**
 * Extract gid values from Google Sheets URL
 * URLs can have gid in query params (?gid=XXX) or hash (#gid=XXX)
 */
function extractGidsFromUrl(url: string): number[] {
  const gids: number[] = [];

  // Extract from query params: ?gid=XXX
  const queryMatch = url.match(/[?&]gid=(\d+)/);
  if (queryMatch && queryMatch[1]) {
    const gid = parseInt(queryMatch[1], 10);
    if (!isNaN(gid)) {
      gids.push(gid);
    }
  }

  // Extract from hash: #gid=XXX
  const hashMatch = url.match(/#gid=(\d+)/);
  if (hashMatch && hashMatch[1]) {
    const gid = parseInt(hashMatch[1], 10);
    if (!isNaN(gid) && !gids.includes(gid)) {
      gids.push(gid);
    }
  }

  return gids;
}

/**
 * Discover tabs by extracting gids from the URL
 * User provides links with gid parameters, we extract and use those
 * Always tries gid=0 (first/default tab) as well
 */
async function discoverTabs(
  conn: Connection,
  spreadsheetId: string,
  originalUrl?: string,
): Promise<Array<{ gid: number; csvUrl: string }>> {
  const tabs: Array<{ gid: number; csvUrl: string }> = [];
  const triedGids = new Set<number>();

  // Helper to try a specific gid
  const tryGid = async (gid: number): Promise<boolean> => {
    if (triedGids.has(gid)) {
      return false; // Already tried
    }
    triedGids.add(gid);

    const csvUrl = getCsvUrlForTab(spreadsheetId, gid);
    try {
      const testReader = await conn.runAndReadAll(
        `SELECT * FROM read_csv_auto('${csvUrl.replace(/'/g, "''")}') LIMIT 1`,
      );
      await testReader.readAll();
      // If successful, tab exists
      tabs.push({ gid, csvUrl });
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // If 400/404, tab doesn't exist
      if (
        errorMsg.includes('400') ||
        errorMsg.includes('404') ||
        errorMsg.includes('Bad Request') ||
        errorMsg.includes('Not Found')
      ) {
        return false; // Tab doesn't exist
      }
      // For other errors, log and return false (might be network issue)
      console.warn(`[GSheetAttach] Error checking tab gid=${gid}:`, errorMsg);
      return false;
    }
  };

  // 1. Always try gid=0 (first/default tab)
  await tryGid(0);

  // 2. Try gids extracted from URL (user provides links with gid parameters)
  if (originalUrl) {
    const urlGids = extractGidsFromUrl(originalUrl);
    for (const gid of urlGids) {
      if (gid !== 0) {
        // Already tried 0
        await tryGid(gid);
      }
    }
  }

  console.log(
    `[GSheetAttach] Tab discovery complete: found ${tabs.length} tab(s)`,
  );

  return tabs;
}

/**
 * Attach Google Sheets as a persistent database with tables for each tab
 * Similar to attachForeignDatasource but for Google Sheets
 *
 * Creates a persistent SQLite database file at:
 * {workspace}/{conversationId}/{datasource_name}.db
 *
 * This ensures tables persist across connections, unlike in-memory databases.
 * Each tab in the Google Sheet becomes a separate table in the attached database.
 */
export async function attachGSheetDatasource(
  opts: GSheetAttachOptions,
): Promise<GSheetAttachResult> {
  const {
    connection: conn,
    datasource,
    extractSchema: shouldExtractSchema = true,
    conversationId,
    workspace,
  } = opts;

  const config = datasource.config as Record<string, unknown>;
  const sharedLink = (config.sharedLink as string) || (config.url as string);

  if (!sharedLink) {
    throw new Error(
      'gsheet-csv datasource requires sharedLink or url in config',
    );
  }

  // Extract spreadsheet ID
  const spreadsheetId = extractSpreadsheetId(sharedLink);
  if (!spreadsheetId) {
    throw new Error(
      `Invalid Google Sheets URL format: ${sharedLink}. Expected format: https://docs.google.com/spreadsheets/d/{id}/...`,
    );
  }

  // Use datasource name directly as database name (sanitized)
  const attachedDatabaseName = getDatasourceDatabaseName(datasource);
  const escapedDbName = attachedDatabaseName.replace(/"/g, '""');

  // Create persistent attached database using SQLite file
  // Store in conversation directory: workspace/conversationId/datasource_name.db
  // This ensures tables persist across connections, unlike :memory: databases
  try {
    // Check if database is already attached
    // Escape single quotes in database name for SQL injection protection
    const escapedDbNameForQuery = attachedDatabaseName.replace(/'/g, "''");
    const dbListReader = await conn.runAndReadAll(
      `SELECT name FROM pragma_database_list WHERE name = '${escapedDbNameForQuery}'`,
    );
    await dbListReader.readAll();
    const existingDbs = dbListReader.getRowObjectsJS() as Array<{
      name: string;
    }>;

    if (existingDbs.length === 0) {
      // Construct persistent database file path
      const { join } = await import('node:path');
      const { mkdir } = await import('node:fs/promises');
      const conversationDir = join(workspace, conversationId);
      await mkdir(conversationDir, { recursive: true });
      const dbFilePath = join(conversationDir, `${attachedDatabaseName}.db`);

      // Escape single quotes in file path for SQL injection protection
      const escapedPath = dbFilePath.replace(/'/g, "''");

      // Attach persistent SQLite database file
      // DuckDB will create the file if it doesn't exist, or use existing file if it does
      await conn.run(`ATTACH '${escapedPath}' AS "${escapedDbName}"`);

      console.log(
        `[GSheetAttach] Attached persistent database: ${attachedDatabaseName} at ${dbFilePath}`,
      );
    }
  } catch (error) {
    // If attach fails, try to continue (might already be attached)
    console.warn(
      `[GSheetAttach] Could not attach database ${attachedDatabaseName}, continuing:`,
      error,
    );
  }

  // Discover tabs
  console.log(
    `[GSheetAttach] Discovering tabs for spreadsheet ${spreadsheetId}...`,
  );
  const tabs = await discoverTabs(conn, spreadsheetId, sharedLink);

  if (tabs.length === 0) {
    throw new Error(
      `No tabs found in Google Sheet: ${sharedLink}. Make sure the sheet is publicly accessible.`,
    );
  }

  console.log(
    `[GSheetAttach] Found ${tabs.length} tab(s) in spreadsheet ${spreadsheetId}`,
  );

  // Create tables for each tab
  const tables: GSheetAttachResult['tables'] = [];
  const existingTableNames: string[] = []; // For uniqueness in semantic naming

  for (const { gid, csvUrl } of tabs) {
    try {
      // Create a temporary table first to extract schema
      const tempTableName = `temp_tab_${gid}`;
      const escapedTempTableName = tempTableName.replace(/"/g, '""');

      // Drop temp table if it exists (from previous failed attempt)
      try {
        await conn.run(
          `DROP TABLE IF EXISTS "${escapedDbName}"."${escapedTempTableName}"`,
        );
      } catch {
        // Ignore errors
      }

      // Create temp table to get schema
      await conn.run(`
        CREATE TABLE "${escapedDbName}"."${escapedTempTableName}" AS 
        SELECT * FROM read_csv_auto('${csvUrl.replace(/'/g, "''")}')
      `);

      // Extract schema to generate semantic name
      // Query the table directly to get column info
      let schema: SimpleSchema | undefined;
      if (shouldExtractSchema) {
        try {
          const describeReader = await conn.runAndReadAll(
            `DESCRIBE "${escapedDbName}"."${escapedTempTableName}"`,
          );
          await describeReader.readAll();
          const describeRows = describeReader.getRowObjectsJS() as Array<{
            column_name: string;
            column_type: string;
          }>;

          const columns = describeRows.map((row) => ({
            columnName: row.column_name,
            columnType: row.column_type,
          }));

          schema = {
            databaseName: attachedDatabaseName,
            schemaName: attachedDatabaseName,
            tables: [
              {
                tableName: tempTableName,
                columns,
              },
            ],
          };
        } catch (error) {
          console.warn(
            `[GSheetAttach] Failed to extract schema for tab gid=${gid}:`,
            error,
          );
        }
      }

      // Generate semantic table name
      let tableName: string;
      if (schema) {
        tableName = generateSemanticViewName(schema, existingTableNames);
      } else {
        // Fallback to generic name
        tableName = `tab_${gid}`;
        let counter = 1;
        while (existingTableNames.includes(tableName)) {
          tableName = `tab_${gid}_${counter}`;
          counter++;
        }
      }

      existingTableNames.push(tableName);

      // Rename temp table to final name
      // First, drop the final table if it exists (from previous attempt)
      const escapedTableName = tableName.replace(/"/g, '""');
      try {
        await conn.run(
          `DROP TABLE IF EXISTS "${escapedDbName}"."${escapedTableName}"`,
        );
      } catch {
        // Ignore errors
      }

      // Now rename temp table to final name
      await conn.run(`
        ALTER TABLE "${escapedDbName}"."${escapedTempTableName}" 
        RENAME TO "${escapedTableName}"
      `);

      tables.push({
        schema: attachedDatabaseName,
        table: tableName,
        csvUrl,
        schemaDefinition: schema,
      });

      console.log(
        `[GSheetAttach] Created table ${attachedDatabaseName}.${tableName} from tab gid=${gid}`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[GSheetAttach] Failed to create table for tab gid=${gid}:`,
        errorMsg,
      );
      // Continue with other tabs even if one fails
    }
  }

  if (tables.length === 0) {
    throw new Error(
      `Failed to create any tables from Google Sheet: ${sharedLink}`,
    );
  }

  return {
    attachedDatabaseName,
    tables,
  };
}
