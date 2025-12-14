import { getDatasourceDatabaseName } from '@qwery/agent-factory-sdk/tools/datasource-name-utils';
import type { ActionFunctionArgs } from 'react-router';
import { createRepositories } from '~/lib/repositories/repositories-factory';
import { handleDomainException } from '~/lib/utils/error-handler';

const repositories = await createRepositories();

function getWorkspace(): string {
  const globalProcess =
    typeof globalThis !== 'undefined'
      ? (globalThis as { process?: NodeJS.Process }).process
      : undefined;
  const envValue =
    globalProcess?.env?.WORKSPACE ??
    globalProcess?.env?.VITE_WORKING_DIR ??
    globalProcess?.env?.WORKING_DIR;
  if (!envValue) {
    throw new Error('WORKSPACE environment variable is not set');
  }
  return envValue;
}

/**
 * Recursively converts BigInt values to numbers for JSON serialization
 */
const convertBigInt = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    if (value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER) {
      return Number(value);
    }
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(convertBigInt);
  }
  if (value && typeof value === 'object') {
    const converted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      converted[key] = convertBigInt(val);
    }
    return converted;
  }
  return value;
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { conversationId, query, datasourceId } = body;

    if (!conversationId || !query || !datasourceId) {
      return Response.json(
        {
          error: 'Missing required fields: conversationId, query, datasourceId',
        },
        { status: 400 },
      );
    }

    const workspace = getWorkspace();

    // Load datasource to get its name and verify it exists
    const datasource = await repositories.datasource.findById(datasourceId);
    if (!datasource) {
      return Response.json(
        { error: `Datasource ${datasourceId} not found` },
        { status: 404 },
      );
    }

    // Get expected database name (what the agent uses in queries)
    const expectedDbName = getDatasourceDatabaseName(datasource);
    console.log('[Notebook Query API] Datasource info:', {
      id: datasourceId,
      name: datasource.name,
      expectedDbName,
      provider: datasource.datasource_provider,
    });

    // Dynamically import DuckDBInstanceManager (like run-query.ts does)
    const { DuckDBInstanceManager } = await import(
      '@qwery/agent-factory-sdk/tools/duckdb-instance-manager'
    );

    // Reset sync cache to force a fresh sync (bypasses optimization check)
    // This ensures the datasource is always attached, even if it was recently synced
    DuckDBInstanceManager.resetSyncCache(conversationId, workspace);

    // Sync datasources BEFORE getting connection (ensures Google Sheets are attached)
    // This must happen first so the connection has access to attached databases
    console.log(
      '[Notebook Query API] Syncing datasources before query:',
      datasourceId,
    );
    try {
      await DuckDBInstanceManager.syncDatasources(
        conversationId,
        workspace,
        [datasourceId],
        repositories.datasource,
        true, // detachUnchecked - allow detaching to ensure clean state
      );
      console.log(
        '[Notebook Query API] Datasource sync completed successfully',
      );
    } catch (syncError) {
      console.error('[Notebook Query API] Datasource sync failed:', syncError);
      // Continue anyway - the datasource might already be attached
      // But log the error for debugging
    }

    // Get DuckDB connection AFTER sync (connection will have access to attached databases)
    const conn = await DuckDBInstanceManager.getConnection(
      conversationId,
      workspace,
    );
    console.log('[Notebook Query API] Got DuckDB connection, executing query');

    // Transform query for Google Sheets: remove .main. schema references
    // Google Sheets tables are created in the database's own schema, not in 'main'
    // Agent generates: "dbname.main.tablename" but actual structure is: "dbname.tablename"
    let transformedQuery = query;
    if (datasource.datasource_provider === 'gsheet-csv') {
      // Replace "dbname.main.tablename" with "dbname.tablename"
      // Handle both quoted and unquoted database names
      const dbNamePattern = expectedDbName.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );

      // Pattern 1: "dbname.main.tablename" -> "dbname"."tablename"
      // This handles the case where the agent generates: "happy_moon_2l7piw.main.drivers"
      transformedQuery = transformedQuery.replace(
        new RegExp(`"${dbNamePattern}"\\.main\\.`, 'gi'),
        `"${expectedDbName}".`,
      );

      // Pattern 3: dbname.main.tablename -> dbname.tablename (unquoted)
      transformedQuery = transformedQuery.replace(
        new RegExp(`\\b${dbNamePattern}\\.main\\.`, 'gi'),
        `${expectedDbName}.`,
      );

      if (transformedQuery !== query) {
        console.log(
          '[Notebook Query API] Transformed query for Google Sheets:',
          {
            original: query,
            transformed: transformedQuery,
          },
        );
      }
    }

    try {
      // Verify attached databases for debugging
      let attachedDatabases: string[] = [];
      try {
        const dbListReader = await conn.runAndReadAll(
          'SELECT name FROM pragma_database_list',
        );
        await dbListReader.readAll();
        const databases = dbListReader.getRowObjectsJS() as Array<{
          name: string;
        }>;
        attachedDatabases = databases.map((d) => d.name);
        console.log(
          '[Notebook Query API] Attached databases:',
          attachedDatabases,
        );
        console.log(
          '[Notebook Query API] Expected database name:',
          expectedDbName,
        );

        if (!attachedDatabases.includes(expectedDbName)) {
          console.warn(
            `[Notebook Query API] WARNING: Expected database "${expectedDbName}" not found in attached databases. ` +
              `Query may fail if it references this database name.`,
          );
        } else {
          // Database is attached, check what tables exist in it
          try {
            const tablesReader = await conn.runAndReadAll(
              `SHOW TABLES FROM "${expectedDbName}"`,
            );
            await tablesReader.readAll();
            const tables = tablesReader.getRowObjectsJS() as Array<{
              name: string;
            }>;
            const tableNames = tables.map((t) => t.name);
            console.log(
              `[Notebook Query API] Tables in database "${expectedDbName}":`,
              tableNames,
            );
          } catch (tablesError) {
            console.warn(
              '[Notebook Query API] Could not list tables:',
              tablesError,
            );
          }
        }
      } catch (dbListError) {
        console.warn(
          '[Notebook Query API] Could not list databases:',
          dbListError,
        );
      }

      // Execute the query
      let resultReader;
      try {
        resultReader = await conn.runAndReadAll(transformedQuery);
        await resultReader.readAll();
      } catch (queryError) {
        // If query fails with database not found error, provide helpful message
        const errorMessage =
          queryError instanceof Error ? queryError.message : String(queryError);
        if (
          errorMessage.includes('does not exist') ||
          errorMessage.includes('Catalog Error')
        ) {
          // Try to get table list for better error message
          let availableTables: string[] = [];
          try {
            const tablesReader = await conn.runAndReadAll(
              `SHOW TABLES FROM "${expectedDbName}"`,
            );
            await tablesReader.readAll();
            const tables = tablesReader.getRowObjectsJS() as Array<{
              name: string;
            }>;
            availableTables = tables.map((t) => t.name);
          } catch {
            // Ignore errors when trying to list tables
          }

          const helpfulError =
            `Query failed: ${errorMessage}\n\n` +
            `Expected database name: "${expectedDbName}"\n` +
            `Attached databases: ${attachedDatabases.length > 0 ? attachedDatabases.join(', ') : 'none'}\n` +
            `Datasource name: "${datasource.name}"\n` +
            (availableTables.length > 0
              ? `Available tables in "${expectedDbName}": ${availableTables.join(', ')}\n`
              : '') +
            `If the query uses a different database or table name, it may need to be updated to match the actual names.`;
          console.error(
            '[Notebook Query API] Query execution failed:',
            helpfulError,
          );
          return Response.json({ error: helpfulError }, { status: 400 });
        }
        throw queryError;
      }
      const rows = resultReader.getRowObjectsJS() as Array<
        Record<string, unknown>
      >;
      const columnNames = resultReader.columnNames();

      // Ensure rows and columnNames are arrays (handle edge cases)
      const safeRows = Array.isArray(rows) ? rows : [];
      const safeColumnNames = Array.isArray(columnNames) ? columnNames : [];

      // Convert BigInt values to numbers/strings for JSON serialization
      const convertedRows = safeRows.map(
        (row) => convertBigInt(row) as Record<string, unknown>,
      );

      // Transform to DatasourceResultSet format
      const headers = safeColumnNames.map((name) => ({
        name: String(name),
        displayName: String(name),
        originalType: null,
      }));

      return Response.json({
        success: true,
        data: {
          rows: convertedRows,
          headers,
          stat: {
            rowsAffected: 0,
            rowsRead: convertedRows.length,
            rowsWritten: 0,
            queryDurationMs: null,
          },
        },
      });
    } finally {
      // Return connection to pool
      DuckDBInstanceManager.returnConnection(conversationId, workspace, conn);
    }
  } catch (error) {
    return handleDomainException(error);
  }
}
