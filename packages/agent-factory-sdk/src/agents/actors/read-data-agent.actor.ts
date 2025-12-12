import { z } from 'zod';
import {
  Experimental_Agent as Agent,
  convertToModelMessages,
  UIMessage,
  tool,
  validateUIMessages,
  stepCountIs,
} from 'ai';
import { fromPromise } from 'xstate/actors';
import { resolveModel } from '../../services';
import { testConnection } from '../../tools/test-connection';
import type { SimpleSchema, SimpleTable } from '@qwery/domain/entities';
import { runQuery } from '../../tools/run-query';
import { renameSheet } from '../../tools/rename-sheet';
import { deleteSheet } from '../../tools/delete-sheet';
import { selectChartType, generateChart } from '../tools/generate-chart';
import { loadBusinessContext } from '../../tools/utils/business-context.storage';
import { READ_DATA_AGENT_PROMPT } from '../prompts/read-data-agent.prompt';
import type { BusinessContext } from '../../tools/types/business-context.types';
import { mergeBusinessContexts } from '../../tools/utils/business-context.storage';
import { getConfig } from '../../tools/utils/business-context.config';
import { buildBusinessContext } from '../../tools/build-business-context';
import { enhanceBusinessContextInBackground } from './enhance-business-context.actor';
import type { Repositories } from '@qwery/domain/repositories';
import { initializeDatasources } from '../../tools/datasource-initializer';
import { GetConversationBySlugService } from '@qwery/domain/services';
import { DuckDBInstanceManager } from '../../tools/duckdb-instance-manager';

// Lazy workspace resolution - only resolve when actually needed, not at module load time
// This prevents side effects when the module is imported in browser/SSR contexts
let WORKSPACE_CACHE: string | undefined;

function resolveWorkspaceDir(): string | undefined {
  const globalProcess =
    typeof globalThis !== 'undefined'
      ? (globalThis as { process?: NodeJS.Process }).process
      : undefined;
  const envValue =
    globalProcess?.env?.WORKSPACE ??
    globalProcess?.env?.VITE_WORKING_DIR ??
    globalProcess?.env?.WORKING_DIR;
  if (envValue) {
    return envValue;
  }

  try {
    return (import.meta as { env?: Record<string, string> })?.env
      ?.VITE_WORKING_DIR;
  } catch {
    return undefined;
  }
}

function getWorkspace(): string | undefined {
  if (WORKSPACE_CACHE === undefined) {
    WORKSPACE_CACHE = resolveWorkspaceDir();
  }
  return WORKSPACE_CACHE;
}

export const readDataAgent = async (
  conversationId: string,
  messages: UIMessage[],
  model: string,
  repositories?: Repositories,
) => {
  // Initialize datasources if repositories are provided
  const agentInitStartTime = performance.now();
  if (repositories) {
    const workspace = getWorkspace();
    if (workspace) {
      try {
        // Get conversation to find datasources
        // Note: conversationId is actually a slug in this context
        const getConvStartTime = performance.now();
        const getConversationService = new GetConversationBySlugService(
          repositories.conversation,
        );
        const conversation =
          await getConversationService.execute(conversationId);
        const getConvTime = performance.now() - getConvStartTime;
        console.log(
          `[ReadDataAgent] [PERF] Agent init getConversation took ${getConvTime.toFixed(2)}ms`,
        );

        if (conversation?.datasources && conversation.datasources.length > 0) {
          // Initialize all datasources with checked state
          const initStartTime = performance.now();
          const initResults = await initializeDatasources({
            conversationId,
            datasourceIds: conversation.datasources,
            datasourceRepository: repositories.datasource,
            workspace,
            checkedDatasourceIds: conversation.datasources, // All are checked initially
          });
          const initTime = performance.now() - initStartTime;
          console.log(
            `[ReadDataAgent] [PERF] initializeDatasources took ${initTime.toFixed(2)}ms (${conversation.datasources.length} datasources)`,
          );

          // Log initialization results for debugging
          const successful = initResults.filter((r) => r.success);
          const failed = initResults.filter((r) => !r.success);

          if (successful.length > 0) {
            console.log(
              `[ReadDataAgent] Initialized ${successful.length} datasource(s) with ${successful.reduce((sum, r) => sum + r.viewsCreated, 0)} view(s)`,
            );
          }

          if (failed.length > 0) {
            console.warn(
              `[ReadDataAgent] Failed to initialize ${failed.length} datasource(s):`,
              failed.map((f) => `${f.datasourceName} (${f.error})`).join(', '),
            );
            // Log detailed error for debugging
            for (const fail of failed) {
              console.warn(
                `[ReadDataAgent] Datasource ${fail.datasourceName} (${fail.datasourceId}) error: ${fail.error}`,
              );
            }
          }
        } else {
          console.log(
            `[ReadDataAgent] No datasources found in conversation ${conversationId}`,
          );
        }
      } catch (error) {
        // Log but don't fail - datasources might not be available yet
        console.warn(
          `[ReadDataAgent] Failed to initialize datasources:`,
          error,
        );
      }
    }
  }
  const agentInitTime = performance.now() - agentInitStartTime;
  if (agentInitTime > 50) {
    console.log(
      `[ReadDataAgent] [PERF] Agent initialization took ${agentInitTime.toFixed(2)}ms`,
    );
  }

  const result = new Agent({
    model: await resolveModel(model),
    system: READ_DATA_AGENT_PROMPT,
    tools: {
      testConnection: tool({
        description:
          'Test the connection to the database to check if the database is accessible',
        inputSchema: z.object({}),
        execute: async () => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const dbPath = join(workspace, conversationId, 'database.db');
          // testConnection still uses dbPath directly, which is fine for testing
          const result = await testConnection({
            dbPath: dbPath,
          });
          return result.toString();
        },
      }),
      getSchema: tool({
        description:
          'Discover available data structures directly from DuckDB (views + attached databases). If viewName is provided, returns schema for that specific view/table. If viewNames (array) is provided, returns schemas for only those specific tables/views (more efficient than loading all). If neither is provided, returns schemas for everything discovered in DuckDB. This updates the business context automatically.',
        inputSchema: z.object({
          viewName: z.string().optional(),
          viewNames: z.array(z.string()).optional(),
        }),
        execute: async ({ viewName, viewNames }) => {
          const startTime = performance.now();
          // If both viewName and viewNames provided, prefer viewNames (array)
          const requestedViews = viewNames?.length
            ? viewNames
            : viewName
              ? [viewName]
              : undefined;

          console.log(
            `[ReadDataAgent] getSchema called${
              requestedViews
                ? ` for ${requestedViews.length} view(s): ${requestedViews.join(', ')}`
                : ' (all views)'
            }`,
          );

          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');

          console.log(
            `[ReadDataAgent] Workspace: ${workspace}, ConversationId: ${conversationId}, dbPath: ${dbPath}`,
          );

          // Get connection from manager
          const connStartTime = performance.now();
          const conn = await DuckDBInstanceManager.getConnection(
            conversationId,
            workspace,
          );
          const connTime = performance.now() - connStartTime;
          console.log(
            `[ReadDataAgent] [PERF] getConnection took ${connTime.toFixed(2)}ms`,
          );

          // Sync datasources before querying schema
          // If specific views requested, only sync datasources needed for those views
          const syncStartTime = performance.now();
          let syncTime = 0;
          if (repositories) {
            try {
              const getConvStartTime = performance.now();
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              const getConvTime = performance.now() - getConvStartTime;
              console.log(
                `[ReadDataAgent] [PERF] getConversation took ${getConvTime.toFixed(2)}ms`,
              );
              if (conversation?.datasources?.length) {
                let datasourcesToSync = conversation.datasources;

                // If specific views requested, determine which datasources are needed
                if (requestedViews && requestedViews.length > 0) {
                  const { getDatasourceDatabaseName } = await import(
                    '../../tools/datasource-name-utils'
                  );
                  const { loadDatasources } = await import(
                    '../../tools/datasource-loader'
                  );

                  // Load all datasources to map names to IDs
                  const allDatasources = await loadDatasources(
                    conversation.datasources,
                    repositories.datasource,
                  );

                  // Extract datasource names from requested views
                  const neededDatasourceNames = new Set<string>();
                  const neededViewNames = new Set<string>();

                  for (const view of requestedViews) {
                    if (view.includes('.')) {
                      // Format: "datasourcename.tablename" or "datasourcename.schema.tablename"
                      const parts = view.split('.');
                      const datasourceName = parts[0];
                      if (datasourceName) {
                        neededDatasourceNames.add(datasourceName);
                      }
                    } else {
                      // Simple view name - check if it's from a DuckDB-native datasource
                      neededViewNames.add(view);
                    }
                  }

                  // Find datasource IDs that match the needed names
                  const neededDatasourceIds = new Set<string>();
                  for (const { datasource } of allDatasources) {
                    const dbName = getDatasourceDatabaseName(datasource);
                    if (neededDatasourceNames.has(dbName)) {
                      neededDatasourceIds.add(datasource.id);
                    }
                  }

                  // For simple view names, we need to check viewRegistry to find their datasources
                  // But for now, if we have simple view names, we'll sync all DuckDB-native datasources
                  // This is a limitation - we'd need viewRegistry lookup to optimize further
                  if (neededViewNames.size > 0) {
                    // Include all datasources for now (could be optimized with viewRegistry lookup)
                    datasourcesToSync = conversation.datasources;
                  } else if (neededDatasourceIds.size > 0) {
                    // Only sync the needed datasources
                    datasourcesToSync = Array.from(neededDatasourceIds);
                    console.log(
                      `[ReadDataAgent] Selective sync: Only syncing ${datasourcesToSync.length} datasource(s) for requested views`,
                    );
                  }
                }

                await DuckDBInstanceManager.syncDatasources(
                  conversationId,
                  workspace,
                  datasourcesToSync,
                  repositories.datasource,
                  false, // OPTIMIZATION: Phase 5.2 - Don't detach in getSchema, just attach needed ones
                );
              }
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to sync datasources:',
                error,
              );
            }
          }
          syncTime = performance.now() - syncStartTime;
          console.log(
            `[ReadDataAgent] [PERF] syncDatasources took ${syncTime.toFixed(2)}ms`,
          );

          // Helper to describe a single table/view
          const describeObject = async (
            db: string,
            schemaName: string,
            tableName: string,
          ): Promise<SimpleSchema | null> => {
            try {
              const escapedDb = db.replace(/"/g, '""');
              const escapedSchema = schemaName.replace(/"/g, '""');
              const escapedTable = tableName.replace(/"/g, '""');
              const describeQuery = `DESCRIBE "${escapedDb}"."${escapedSchema}"."${escapedTable}"`;
              const reader = await conn.runAndReadAll(describeQuery);
              await reader.readAll();
              const rows = reader.getRowObjectsJS() as Array<{
                column_name: string;
                column_type: string;
              }>;
              return {
                databaseName: db,
                schemaName,
                tables: [
                  {
                    tableName,
                    columns: rows.map((row) => ({
                      columnName: row.column_name,
                      columnType: row.column_type,
                    })),
                  },
                ],
              };
            } catch {
              return null;
            }
          };

          const collectedSchemas: Map<string, SimpleSchema> = new Map();

          // Check cache for single view requests (OPTIMIZATION: Phase 4.2)
          if (requestedViews && requestedViews.length === 1) {
            const singleView = requestedViews[0] ?? '';
            if (singleView) {
              const cachedSchema = DuckDBInstanceManager.getCachedSchema(
                conversationId,
                workspace,
                singleView,
              );
              if (cachedSchema) {
                console.log(
                  `[ReadDataAgent] [PERF] Using cached schema for ${singleView}`,
                );
                return cachedSchema;
              }
            }
          }

          const schemaDiscoveryStartTime = performance.now();
          let schemaDiscoveryTime = 0;
          try {
            const dbListStartTime = performance.now();
            const dbReader = await conn.runAndReadAll(
              'SELECT name FROM pragma_database_list;',
            );
            await dbReader.readAll();
            const dbRows = dbReader.getRowObjectsJS() as Array<{
              name: string;
            }>;
            const allDatabases = dbRows.map((r) => r.name);
            const dbListTime = performance.now() - dbListStartTime;
            console.log(
              `[ReadDataAgent] [PERF] pragma_database_list took ${dbListTime.toFixed(2)}ms (found ${allDatabases.length} databases)`,
            );

            // Filter databases to only include those from conversation datasources
            let allowedDatabases = new Set<string>(allDatabases);
            if (repositories) {
              try {
                const getConversationService = new GetConversationBySlugService(
                  repositories.conversation,
                );
                const conversation =
                  await getConversationService.execute(conversationId);
                if (conversation?.datasources?.length) {
                  const { getDatasourceDatabaseName } = await import(
                    '../../tools/datasource-name-utils'
                  );
                  const { loadDatasources } = await import(
                    '../../tools/datasource-loader'
                  );

                  const allDatasources = await loadDatasources(
                    conversation.datasources,
                    repositories.datasource,
                  );

                  // Build set of allowed database names from conversation datasources
                  const allowedDbNames = new Set<string>();
                  for (const { datasource } of allDatasources) {
                    const dbName = getDatasourceDatabaseName(datasource);
                    allowedDbNames.add(dbName);
                  }

                  // Filter: only include 'main' and databases that match conversation datasources
                  allowedDatabases = new Set<string>();
                  allowedDatabases.add('main'); // Always include main database
                  for (const db of allDatabases) {
                    if (allowedDbNames.has(db)) {
                      allowedDatabases.add(db);
                    }
                  }

                  console.log(
                    `[ReadDataAgent] Filtered databases: ${allDatabases.length} total, ${allowedDatabases.size} from conversation datasources`,
                  );
                }
              } catch (error) {
                console.warn(
                  '[ReadDataAgent] Failed to filter databases by conversation datasources:',
                  error,
                );
                // Continue with all databases if filtering fails
              }
            }

            const databases = Array.from(allowedDatabases);

            const targets: Array<{
              db: string;
              schema: string;
              table: string;
            }> = [];

            // Get system schemas using extension abstraction
            const { getAllSystemSchemas, isSystemTableName } = await import(
              '../../tools/system-schema-filter'
            );
            const systemSchemas = getAllSystemSchemas();

            const tableQueryStartTime = performance.now();
            let totalTablesFound = 0;
            for (const db of databases) {
              // Skip "database" - it's the DuckDB file name, not an attached database (FIX: Phase 4.3)
              if (db === 'database') {
                continue;
              }

              const dbQueryStartTime = performance.now();
              const escapedDb = db.replace(/"/g, '""');

              // For attached foreign databases, query their information_schema directly
              // For main database, query the default information_schema
              // Attached databases are any database that's not 'main' (the default DuckDB database)
              const isAttachedDb = db !== 'main';

              let tableRows: Array<{
                table_schema: string;
                table_name: string;
                table_type: string;
              }> = [];
              let viewRows: Array<{
                table_schema: string;
                table_name: string;
                table_type: string;
              }> = [];

              if (isAttachedDb) {
                // For attached databases, try information_schema first (works for real DBs like PostgreSQL)
                // If that fails, fall back to SHOW TABLES (works for in-memory databases like Google Sheets)
                try {
                  const tablesReader = await conn.runAndReadAll(`
                    SELECT table_schema, table_name, table_type
                    FROM "${escapedDb}".information_schema.tables
                    WHERE table_type IN ('BASE TABLE', 'VIEW')
                  `);
                  await tablesReader.readAll();
                  tableRows = tablesReader.getRowObjectsJS() as Array<{
                    table_schema: string;
                    table_name: string;
                    table_type: string;
                  }>;
                  viewRows = [];
                } catch (error) {
                  // Fallback: Use duckdb_tables() for in-memory databases (like Google Sheets)
                  // This gives us the actual schema name, not hardcoded 'main'
                  try {
                    const duckdbTablesReader = await conn.runAndReadAll(
                      `SELECT database_name, schema_name, table_name, table_type
                       FROM duckdb_tables()
                       WHERE database_name = '${escapedDb.replace(/'/g, "''")}'
                       ORDER BY schema_name, table_name`,
                    );
                    await duckdbTablesReader.readAll();
                    const duckdbTablesRows =
                      duckdbTablesReader.getRowObjectsJS() as Array<{
                        database_name: string;
                        schema_name: string;
                        table_name: string;
                        table_type: string;
                      }>;
                    // Use actual schema from duckdb_tables()
                    tableRows = duckdbTablesRows.map((row) => ({
                      table_schema: row.schema_name || 'main',
                      table_name: row.table_name,
                      table_type: row.table_type || 'BASE TABLE',
                    }));
                    viewRows = [];
                  } catch (fallbackError) {
                    // Last resort: Use SHOW TABLES (but try to get schema from duckdb_tables for each table)
                    try {
                      const showTablesReader = await conn.runAndReadAll(
                        `SHOW TABLES FROM "${escapedDb}"`,
                      );
                      await showTablesReader.readAll();
                      const showTablesRows =
                        showTablesReader.getRowObjectsJS() as Array<{
                          name: string;
                        }>;
                      // Try to get schema for each table from duckdb_tables
                      const tableNames = showTablesRows.map((r) => r.name);
                      const schemaMap = new Map<string, string>();
                      try {
                        for (const tableName of tableNames) {
                          const schemaReader = await conn.runAndReadAll(
                            `SELECT schema_name FROM duckdb_tables() 
                             WHERE database_name = '${escapedDb.replace(/'/g, "''")}' 
                             AND table_name = '${tableName.replace(/'/g, "''")}' 
                             LIMIT 1`,
                          );
                          await schemaReader.readAll();
                          const schemaRows =
                            schemaReader.getRowObjectsJS() as Array<{
                              schema_name: string;
                            }>;
                          if (schemaRows.length > 0 && schemaRows[0]) {
                            schemaMap.set(tableName, schemaRows[0].schema_name);
                          }
                        }
                      } catch {
                        // If schema lookup fails, use 'main' as fallback
                      }
                      // Convert to same format as information_schema, using actual schema or 'main' as fallback
                      tableRows = showTablesRows.map((row) => ({
                        table_schema: schemaMap.get(row.name) || 'main',
                        table_name: row.name,
                        table_type: 'BASE TABLE',
                      }));
                      viewRows = [];
                    } catch (showTablesError) {
                      console.warn(
                        `[ReadDataAgent] Failed to query tables from attached database ${db} (information_schema, duckdb_tables, and SHOW TABLES all failed):`,
                        error,
                        fallbackError,
                        showTablesError,
                      );
                      continue;
                    }
                  }
                }
              } else {
                // For main database, query the default information_schema
                try {
                  // Include both tables AND views in single query
                  const tablesReader = await conn.runAndReadAll(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_catalog = '${escapedDb}'
                      AND table_type IN ('BASE TABLE', 'VIEW')
                  `);
                  await tablesReader.readAll();
                  tableRows = tablesReader.getRowObjectsJS() as Array<{
                    table_schema: string;
                    table_name: string;
                    table_type: string;
                  }>;
                  // No separate views query needed - already included above
                  viewRows = [];
                } catch (error) {
                  console.warn(
                    `[ReadDataAgent] Failed to query tables from database ${db}: ${error}`,
                  );
                  continue;
                }
              }

              // Combine tables and views
              const allRows = [...tableRows, ...viewRows];

              let skippedSystemSchemas = 0;
              let skippedSystemTables = 0;

              for (const row of allRows) {
                // Use actual schema from database query, don't hardcode 'main'
                // For PostgreSQL: 'public', 'auth', etc.
                // For MySQL: database name or 'public'
                // For SQLite/in-memory: 'main' (from duckdb_tables or information_schema)
                const actualSchema = row.table_schema || 'main';
                const schemaName = actualSchema.toLowerCase();

                // Skip system schemas (NO LOGGING - just count)
                if (systemSchemas.has(schemaName)) {
                  skippedSystemSchemas++;
                  continue;
                }

                // Skip system tables (NO LOGGING - just count)
                if (isSystemTableName(row.table_name)) {
                  skippedSystemTables++;
                  continue;
                }

                // Use actual schema from database, not hardcoded 'main'
                targets.push({
                  db,
                  schema: actualSchema,
                  table: row.table_name,
                });
                totalTablesFound++;
              }

              // Log summary only if there were skips
              if (skippedSystemSchemas > 0 || skippedSystemTables > 0) {
                console.debug(
                  `[ReadDataAgent] Filtered ${skippedSystemSchemas} system schemas and ${skippedSystemTables} system tables from ${db}`,
                );
              }
              const dbQueryTime = performance.now() - dbQueryStartTime;
              console.log(
                `[ReadDataAgent] [PERF] Querying ${db} took ${dbQueryTime.toFixed(2)}ms (found ${targets.filter((t) => t.db === db).length} tables)`,
              );
            }
            const tableQueryTime = performance.now() - tableQueryStartTime;
            console.log(
              `[ReadDataAgent] [PERF] Total table discovery took ${tableQueryTime.toFixed(2)}ms (found ${totalTablesFound} total tables)`,
            );

            if (requestedViews && requestedViews.length > 0) {
              // Describe only the requested objects
              for (const viewId of requestedViews) {
                let db = 'main';
                let schemaName = 'main';
                let tableName = viewId;
                if (viewId.includes('.')) {
                  const parts = viewId.split('.').filter(Boolean);
                  if (parts.length === 3) {
                    // Format: datasourcename.schema.tablename
                    db = parts[0] ?? db;
                    schemaName = parts[1] ?? schemaName;
                    tableName = parts[2] ?? tableName;
                  } else if (parts.length === 2) {
                    // Format: datasourcename.tablename
                    // Try to find the actual schema from targets we discovered
                    db = parts[0] ?? db;
                    tableName = parts[1] ?? tableName;
                    // Look up actual schema from discovered targets
                    const foundTarget = targets.find(
                      (t) => t.db === db && t.table === tableName,
                    );
                    schemaName = foundTarget?.schema || 'main'; // Use actual schema or fallback to 'main'
                  } else if (parts.length === 1) {
                    tableName = parts[0] ?? tableName;
                  }
                }
                // Check if this is a system table before describing
                // Only check the table name itself, not the full path, since datasource names can be anything
                const { isSystemOrTempTable } = await import(
                  '../../tools/utils/business-context.utils'
                );

                // For attached databases, only check the table name, not the full path
                // The datasource name is user-defined and shouldn't be checked as a system schema
                if (db !== 'main') {
                  // This is an attached database - only check table name
                  if (isSystemOrTempTable(tableName)) {
                    throw new Error(
                      `Cannot access system table: ${viewId}. Please query user tables only.`,
                    );
                  }
                } else {
                  // Main database - check full name
                  const fullName = `${db}.${schemaName}.${tableName}`;
                  if (isSystemOrTempTable(fullName)) {
                    throw new Error(
                      `Cannot access system table: ${viewId}. Please query user tables only.`,
                    );
                  }
                }

                const schema = await describeObject(db, schemaName, tableName);
                if (!schema) {
                  console.warn(
                    `[ReadDataAgent] Object "${viewId}" not found in DuckDB, skipping`,
                  );
                  continue;
                }
                collectedSchemas.set(viewId, schema);
              }
            } else {
              // Describe everything discovered (OPTIMIZATION: Phase 4.1 - Batch queries)
              const describeStartTime = performance.now();
              let describedCount = 0;

              // Group targets by database for batch processing
              const targetsByDb = new Map<
                string,
                Array<{ db: string; schema: string; table: string }>
              >();
              for (const target of targets) {
                if (!targetsByDb.has(target.db)) {
                  targetsByDb.set(target.db, []);
                }
                targetsByDb.get(target.db)!.push(target);
              }

              // Process each database
              for (const [db, dbTargets] of targetsByDb.entries()) {
                if (db === 'main') {
                  // For main database, describe individually (DuckDB views)
                  for (const target of dbTargets) {
                    const fullName = `${target.db}.${target.schema}.${target.table}`;
                    const schema = await describeObject(
                      target.db,
                      target.schema,
                      target.table,
                    );
                    if (schema) {
                      collectedSchemas.set(fullName, schema);
                      describedCount++;
                    }
                  }
                } else {
                  // For attached databases, batch query information_schema.columns
                  const escapedDb = db.replace(/"/g, '""');
                  try {
                    // Build list of (schema, table) pairs for the query
                    const tableFilters = dbTargets
                      .map((t) => {
                        const schema = t.schema.replace(/'/g, "''");
                        const table = t.table.replace(/'/g, "''");
                        return `('${schema}', '${table}')`;
                      })
                      .join(', ');

                    if (tableFilters.length > 0) {
                      const columnsQuery = `
                        SELECT 
                          table_schema,
                          table_name,
                          column_name,
                          data_type
                        FROM "${escapedDb}".information_schema.columns
                        WHERE (table_schema, table_name) IN (${tableFilters})
                        ORDER BY table_schema, table_name, ordinal_position
                      `;

                      const batchStartTime = performance.now();
                      const columnsReader =
                        await conn.runAndReadAll(columnsQuery);
                      await columnsReader.readAll();
                      const allColumns =
                        columnsReader.getRowObjectsJS() as Array<{
                          table_schema: string;
                          table_name: string;
                          column_name: string;
                          data_type: string;
                        }>;
                      const batchTime = performance.now() - batchStartTime;
                      console.log(
                        `[ReadDataAgent] [PERF] Batch column query for ${db} took ${batchTime.toFixed(2)}ms (${allColumns.length} columns for ${dbTargets.length} tables)`,
                      );

                      // Group columns by table
                      const columnsByTable = new Map<
                        string,
                        Array<{ columnName: string; columnType: string }>
                      >();
                      for (const col of allColumns) {
                        const key = `${col.table_schema || 'main'}.${col.table_name}`;
                        if (!columnsByTable.has(key)) {
                          columnsByTable.set(key, []);
                        }
                        columnsByTable.get(key)!.push({
                          columnName: col.column_name,
                          columnType: col.data_type,
                        });
                      }

                      // Create schemas for each target
                      for (const target of dbTargets) {
                        const tableKey = `${target.schema}.${target.table}`;
                        const columns = columnsByTable.get(tableKey) || [];
                        const fullName = `${target.db}.${target.schema}.${target.table}`;

                        if (columns.length > 0) {
                          collectedSchemas.set(fullName, {
                            databaseName: target.db,
                            schemaName: target.schema,
                            tables: [
                              {
                                tableName: target.table,
                                columns,
                              },
                            ],
                          });
                          describedCount++;
                        }
                      }
                    }
                  } catch (error) {
                    // Fallback to individual describes if batch fails
                    console.warn(
                      `[ReadDataAgent] Batch describe failed for ${db}, falling back to individual:`,
                      error,
                    );
                    for (const target of dbTargets) {
                      const fullName = `${target.db}.${target.schema}.${target.table}`;
                      const schema = await describeObject(
                        target.db,
                        target.schema,
                        target.table,
                      );
                      if (schema) {
                        collectedSchemas.set(fullName, schema);
                        describedCount++;
                      }
                    }
                  }
                }
              }

              const describeTime = performance.now() - describeStartTime;
              console.log(
                `[ReadDataAgent] [PERF] Describing ${describedCount} tables took ${describeTime.toFixed(2)}ms (avg ${(describeTime / Math.max(describedCount, 1)).toFixed(2)}ms per table)`,
              );
            }
            schemaDiscoveryTime = performance.now() - schemaDiscoveryStartTime;
            console.log(
              `[ReadDataAgent] [PERF] Total schema discovery took ${schemaDiscoveryTime.toFixed(2)}ms`,
            );
          } finally {
            // Return connection to pool
            DuckDBInstanceManager.returnConnection(
              conversationId,
              workspace,
              conn,
            );
          }

          // Get performance configuration
          const perfConfigStartTime = performance.now();
          const perfConfig = await getConfig(fileDir);
          const perfConfigTime = performance.now() - perfConfigStartTime;
          console.log(
            `[ReadDataAgent] [PERF] getConfig took ${perfConfigTime.toFixed(2)}ms`,
          );

          // Build schemasMap with all collected schemas
          const schemasMap = collectedSchemas;

          // If specific views requested, return those schemas
          // Otherwise, return ALL schemas combined
          let schema: SimpleSchema;
          if (
            requestedViews &&
            requestedViews.length > 0 &&
            requestedViews.length === 1
          ) {
            const singleView = requestedViews[0] ?? '';
            if (!singleView) {
              schema = {
                databaseName: 'main',
                schemaName: 'main',
                tables: [],
              };
            } else {
              // Try exact match first
              let foundSchema = collectedSchemas.get(singleView);

              // If not found and it's a 2-part name (datasourcename.tablename), try with main schema
              if (
                !foundSchema &&
                singleView.includes('.') &&
                singleView.split('.').length === 2
              ) {
                const parts = singleView.split('.');
                const withMainSchema = `${parts[0]}.main.${parts[1]}`;
                foundSchema = collectedSchemas.get(withMainSchema);
              }

              if (foundSchema) {
                // Single view requested - format table name to include schema
                const schemaKey = Array.from(collectedSchemas.entries()).find(
                  ([_, s]) => s === foundSchema,
                )?.[0];
                if (schemaKey && schemaKey.includes('.')) {
                  const parts = schemaKey.split('.');
                  if (parts.length >= 3) {
                    // Format table name as datasourcename.schema.tablename
                    foundSchema = {
                      ...foundSchema,
                      tables: foundSchema.tables.map((t) => ({
                        ...t,
                        tableName: `${parts[0]}.${parts[1]}.${t.tableName}`,
                      })),
                    };
                  }
                }
                schema = foundSchema;
              } else {
                // View not found, return empty schema
                schema = {
                  databaseName: 'main',
                  schemaName: 'main',
                  tables: [],
                };
              }
            }
          } else {
            // All views - combine all schemas into one
            const allTables: SimpleTable[] = [];
            for (const [schemaKey, schemaData] of collectedSchemas.entries()) {
              // Add tables from each schema
              for (const table of schemaData.tables) {
                // Format table name: for attached databases, show as datasourcename.schema.tablename
                // schemaKey format: "datasourcename.schema.tablename" or "tablename" for main
                let formattedTableName = table.tableName;
                if (schemaKey.includes('.')) {
                  // This is an attached database table
                  // schemaKey is like "mydatasource.main.companies" or "mydatasource.public.companies"
                  // We need to preserve the full path: datasourcename.schema.tablename
                  const parts = schemaKey.split('.');
                  if (parts.length >= 3) {
                    // Format: datasourcename.schema.tablename (preserve schema)
                    formattedTableName = `${parts[0]}.${parts[1]}.${parts[parts.length - 1]}`;
                  } else if (parts.length === 2) {
                    // Format: datasourcename.tablename (assume main schema)
                    formattedTableName = `${parts[0]}.main.${parts[1]}`;
                  }
                }

                allTables.push({
                  ...table,
                  tableName: formattedTableName,
                });
              }
            }

            // Determine primary database/schema from first entry or use defaults
            const firstSchema = collectedSchemas.values().next().value;
            schema = {
              databaseName: firstSchema?.databaseName || 'main',
              schemaName: firstSchema?.schemaName || 'main',
              tables: allTables,
            };
          }

          // Build fast context (synchronous, < 100ms)
          const contextStartTime = performance.now();
          let fastContext: BusinessContext;
          if (
            requestedViews &&
            requestedViews.length > 0 &&
            requestedViews.length === 1
          ) {
            // Single view - build fast context
            const singleViewName = requestedViews[0];
            if (singleViewName) {
              const buildContextStartTime = performance.now();
              fastContext = await buildBusinessContext({
                conversationDir: fileDir,
                viewName: singleViewName,
                schema,
              });
              const buildContextTime =
                performance.now() - buildContextStartTime;
              console.log(
                `[ReadDataAgent] [PERF] buildBusinessContext (single) took ${buildContextTime.toFixed(2)}ms`,
              );

              // Start enhancement in background (don't await)
              enhanceBusinessContextInBackground({
                conversationDir: fileDir,
                viewName: singleViewName,
                schema,
                dbPath,
              });
            } else {
              // Fallback to empty context
              const { createEmptyContext } = await import(
                '../../tools/utils/business-context.storage'
              );
              fastContext = createEmptyContext();
            }
          } else {
            // Multiple views - build fast context for each
            // Filter out system tables before processing
            const { isSystemOrTempTable } = await import(
              '../../tools/utils/business-context.utils'
            );

            const fastContexts: BusinessContext[] = [];
            for (const [vName, vSchema] of schemasMap.entries()) {
              // Skip system tables
              if (isSystemOrTempTable(vName)) {
                console.debug(
                  `[ReadDataAgent] Skipping system table in context building: ${vName}`,
                );
                continue;
              }

              // Also check if schema has any valid tables
              const hasValidTables = vSchema.tables.some(
                (t) => !isSystemOrTempTable(t.tableName),
              );
              if (!hasValidTables) {
                console.debug(
                  `[ReadDataAgent] Skipping schema with no valid tables: ${vName}`,
                );
                continue;
              }

              const buildContextStartTime = performance.now();
              const ctx = await buildBusinessContext({
                conversationDir: fileDir,
                viewName: vName,
                schema: vSchema,
              });
              const buildContextTime =
                performance.now() - buildContextStartTime;
              console.log(
                `[ReadDataAgent] [PERF] buildBusinessContext for ${vName} took ${buildContextTime.toFixed(2)}ms`,
              );
              fastContexts.push(ctx);

              // Start enhancement in background for each view
              enhanceBusinessContextInBackground({
                conversationDir: fileDir,
                viewName: vName,
                schema: vSchema,
                dbPath,
              });
            }
            // Merge all fast contexts into one
            const mergeStartTime = performance.now();
            fastContext = mergeBusinessContexts(fastContexts);
            const mergeTime = performance.now() - mergeStartTime;
            console.log(
              `[ReadDataAgent] [PERF] mergeBusinessContexts (${fastContexts.length} contexts) took ${mergeTime.toFixed(2)}ms`,
            );
          }
          const contextTime = performance.now() - contextStartTime;
          console.log(
            `[ReadDataAgent] [PERF] Total business context building took ${contextTime.toFixed(2)}ms`,
          );

          // Use fast context for immediate response
          const entities = Array.from(fastContext.entities.values()).slice(
            0,
            perfConfig.expectedViewCount * 2,
          );
          const relationships = fastContext.relationships.slice(
            0,
            perfConfig.expectedViewCount * 3,
          );
          const vocabulary = Object.fromEntries(
            Array.from(fastContext.vocabulary.entries())
              .slice(0, perfConfig.expectedViewCount * 10)
              .map(([key, entry]) => [key, entry]),
          );

          // Include information about all discovered tables in the response
          // Format table names: datasourcename.schema.tablename for attached databases
          const allTableNames = Array.from(collectedSchemas.keys()).map(
            (key) => {
              // Format: datasourcename.schema.tablename (preserve schema)
              if (key.includes('.')) {
                const parts = key.split('.');
                if (parts.length >= 3) {
                  // "mydatasource.main.companies" -> "mydatasource.main.companies" (preserve schema)
                  return `${parts[0]}.${parts[1]}.${parts[parts.length - 1]}`;
                } else if (parts.length === 2) {
                  // "mydatasource.companies" -> "mydatasource.main.companies" (assume main schema)
                  return `${parts[0]}.main.${parts[1]}`;
                }
              }
              return key;
            },
          );
          const tableCount = allTableNames.length;

          // Cache schema for single view requests (OPTIMIZATION: Phase 4.2)
          if (requestedViews && requestedViews.length === 1) {
            const singleView = requestedViews[0];
            if (singleView) {
              DuckDBInstanceManager.cacheSchema(
                conversationId,
                workspace,
                singleView,
                schema,
              );
            }
          }

          const totalTime = performance.now() - startTime;
          console.log(
            `[ReadDataAgent] [PERF] getSchema TOTAL took ${totalTime.toFixed(2)}ms (sync: ${syncTime.toFixed(2)}ms, discovery: ${schemaDiscoveryTime.toFixed(2)}ms, context: ${contextTime.toFixed(2)}ms)`,
          );

          // Return schema and data insights (hide technical jargon)
          return {
            schema: schema,
            allTables: allTableNames, // Add this - list of all table/view names
            tableCount: tableCount, // Add this - total count
            businessContext: {
              domain: fastContext.domain.domain, // Just the domain name string
              entities: entities.map((e) => ({
                name: e.name,
                columns: e.columns,
              })), // Simplified - just name and columns
              relationships: relationships.map((r) => ({
                from: r.fromView,
                to: r.toView,
                join: r.joinCondition,
              })), // Simplified - just connection info
              vocabulary: vocabulary, // Keep for internal use but don't expose structure
            },
          };
        },
      }),
      runQuery: tool({
        description:
          'Run a SQL query against the DuckDB instance (views from file-based datasources or attached database tables). Query views by name (e.g., "customers") or attached tables by datasource path (e.g., "datasourcename.tablename" or "datasourcename.schema.tablename"). DuckDB enables federated queries across PostgreSQL, MySQL, Google Sheets, and other datasources.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          const startTime = performance.now();
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }

          // Sync datasources before querying if repositories available
          const syncStartTime = performance.now();
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              if (conversation?.datasources?.length) {
                await DuckDBInstanceManager.syncDatasources(
                  conversationId,
                  workspace,
                  conversation.datasources,
                  repositories.datasource,
                  true, // OPTIMIZATION: Phase 5.2 - Detach unchecked in runQuery
                );
              }
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to sync datasources before query:',
                error,
              );
            }
          }
          const syncTime = performance.now() - syncStartTime;
          if (syncTime > 10) {
            console.log(
              `[ReadDataAgent] [PERF] runQuery syncDatasources took ${syncTime.toFixed(2)}ms`,
            );
          }

          const queryStartTime = performance.now();
          const result = await runQuery({
            conversationId,
            workspace,
            query,
          });
          const queryTime = performance.now() - queryStartTime;
          const totalTime = performance.now() - startTime;
          console.log(
            `[ReadDataAgent] [PERF] runQuery TOTAL took ${totalTime.toFixed(2)}ms (sync: ${syncTime.toFixed(2)}ms, query: ${queryTime.toFixed(2)}ms, rows: ${result.rows.length})`,
          );

          return {
            result: result,
          };
        },
      }),
      renameSheet: tool({
        description:
          'Rename a sheet/view to give it a more meaningful name. Both oldSheetName and newSheetName are required.',
        inputSchema: z.object({
          oldSheetName: z.string(),
          newSheetName: z.string(),
        }),
        execute: async ({ oldSheetName, newSheetName }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const result = await renameSheet({
            conversationId,
            workspace,
            oldSheetName,
            newSheetName,
          });
          return result;
        },
      }),
      deleteSheet: tool({
        description:
          'Delete one or more sheets/views from the database. Takes an array of sheet names to delete.',
        inputSchema: z.object({
          sheetNames: z.array(z.string()),
        }),
        execute: async ({ sheetNames }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const result = await deleteSheet({
            conversationId,
            workspace,
            sheetNames,
          });
          return result;
        },
      }),
      selectChartType: tool({
        description:
          'Analyzes query results to determine the best chart type (bar, line, or pie) based on the data structure and user intent. Use this before generating a chart to select the most appropriate visualization type.',
        inputSchema: z.object({
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())),
            columns: z.array(z.string()),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async ({ queryResults, sqlQuery = '', userInput = '' }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);

          // Load business context if available
          let businessContext: BusinessContext | null = null;
          try {
            businessContext = await loadBusinessContext(fileDir);
          } catch {
            // Business context not available, continue without it
          }

          const result = await selectChartType(
            queryResults,
            sqlQuery,
            userInput,
            businessContext,
          );
          return result;
        },
      }),
      generateChart: tool({
        description:
          'Generates a chart configuration JSON for visualization. Takes query results and creates a chart (bar, line, or pie) with proper data transformation, colors, and labels. Use this after selecting a chart type or when the user requests a specific chart type.',
        inputSchema: z.object({
          chartType: z.enum(['bar', 'line', 'pie']).optional(),
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())),
            columns: z.array(z.string()),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async ({
          chartType,
          queryResults,
          sqlQuery = '',
          userInput = '',
        }) => {
          const startTime = performance.now();
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);

          // Load business context if available
          const contextStartTime = performance.now();
          let businessContext: BusinessContext | null = null;
          try {
            businessContext = await loadBusinessContext(fileDir);
          } catch {
            // Business context not available, continue without it
          }
          const contextTime = performance.now() - contextStartTime;
          if (contextTime > 10) {
            console.log(
              `[ReadDataAgent] [PERF] generateChart loadBusinessContext took ${contextTime.toFixed(2)}ms`,
            );
          }

          const generateStartTime = performance.now();
          const result = await generateChart({
            chartType,
            queryResults,
            sqlQuery,
            userInput,
            businessContext,
          });
          const generateTime = performance.now() - generateStartTime;
          const totalTime = performance.now() - startTime;
          console.log(
            `[ReadDataAgent] [PERF] generateChart TOTAL took ${totalTime.toFixed(2)}ms (context: ${contextTime.toFixed(2)}ms, generate: ${generateTime.toFixed(2)}ms)`,
          );
          return result;
        },
      }),
    },
    stopWhen: stepCountIs(20),
  });

  return result.stream({
    messages: convertToModelMessages(await validateUIMessages({ messages })),
    providerOptions: {
      openai: {
        reasoningSummary: 'auto', // 'auto' for condensed or 'detailed' for comprehensive
        reasoningEffort: 'medium',
        reasoningDetailedSummary: true,
        reasoningDetailedSummaryLength: 'long',
      },
    },
  });
};

export const readDataAgentActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      conversationId: string;
      previousMessages: UIMessage[];
      model: string;
      repositories?: Repositories;
    };
  }) => {
    return readDataAgent(
      input.conversationId,
      input.previousMessages,
      input.model,
      input.repositories,
    );
  },
);
