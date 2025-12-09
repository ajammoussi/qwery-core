import {
  Experimental_Agent,
  stepCountIs,
  tool,
  convertToModelMessages,
  validateUIMessages,
} from 'ai';
import type { UIMessage } from 'ai';
import { z } from 'zod';
import { fromPromise } from 'xstate/actors';
import { resolveModel } from '../../services';
import { testConnection } from '../../tools/test-connection';
import { gsheetToDuckdb } from '../../tools/gsheet-to-duckdb';
import { extractSchema } from '../../tools/extract-schema';
import type { SimpleSchema } from '@qwery/domain/entities';
import { runQuery } from '../../tools/run-query';
import { viewSheet } from '../../tools/view-sheet';
import { READ_DATA_AGENT_PROMPT } from '../prompts/read-data-agent.prompt';
import { buildBusinessContext } from '../../tools/build-business-context';
import { enhanceBusinessContextInBackground } from './enhance-business-context.actor';
import { generateChart, selectChartType } from '../tools/generate-chart';
import { ChartTypeSchema } from '../types/chart.types';
import { getSupportedChartTypes } from '../config/supported-charts';
import { renameSheet } from '../../tools/rename-sheet';
import { deleteSheet } from '../../tools/delete-sheet';
import {
  registerSheetView,
  registerDatasourceView,
  loadViewRegistry,
  updateViewUsage,
  generateSemanticViewName,
  updateViewName,
  validateTableExists,
  cleanupOrphanedTempTables,
  deleteViewFromRegistry,
  getViewByName,
  renameView,
  type RegistryContext,
} from '../../tools/view-registry';
import {
  loadBusinessContext,
  mergeBusinessContexts,
} from '../../tools/utils/business-context.storage';
import type { BusinessContext } from '../../tools/types/business-context.types';
import { getConfig } from '../../tools/utils/business-context.config';
import type { Repositories } from '@qwery/domain/repositories';
import { initializeDatasources } from '../../tools/datasource-initializer';
import { GetConversationBySlugService } from '@qwery/domain/services';
import {
  loadDatasources,
  groupDatasourcesByType,
} from '../../tools/datasource-loader';
import { datasourceToDuckdb } from '../../tools/datasource-to-duckdb';
import { attachAllForeignDatasourcesToConnection } from '../../tools/foreign-datasource-attach';

/**
 * Initializes datasources at the start, then creates and streams from the agent
 */
export const readDataAgent = async (
  conversationId: string,
  messages: UIMessage[],
  model: string,
  repositories?: Repositories,
) => {
  if (repositories) {
    const workspace = getWorkspace();
    if (workspace) {
      try {
        // Get conversation to find datasources
        const getConversationService = new GetConversationBySlugService(
          repositories.conversation,
        );
        const conversation =
          await getConversationService.execute(conversationId);

        if (conversation?.datasources && conversation.datasources.length > 0) {
          // Initialize all datasources
          const initResults = await initializeDatasources({
            conversationId,
            datasourceIds: conversation.datasources,
            datasourceRepository: repositories.datasource,
            workspace,
          });

          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          const successful = initResults.filter((r) => r.success);
          const failed = initResults.filter((r) => !r.success);

          const dbPath = join(fileDir, 'database.db');

          const existingRegistry = await loadViewRegistry(context);
          const existingViewNames = new Set(
            existingRegistry.map((r) => r.viewName),
          );

          for (const result of successful) {
            try {
              const datasource = await repositories.datasource.findById(
                result.datasourceId,
              );
              if (!datasource) continue;

              // Check if it's a DuckDB-native datasource
              const loaded = await loadDatasources(
                [result.datasourceId],
                repositories.datasource,
              );
              const { duckdbNative } = groupDatasourcesByType(loaded);

              if (duckdbNative.length > 0) {
                const { datasource: ds } = duckdbNative[0]!;

                const viewResult = await datasourceToDuckdb({
                  dbPath,
                  datasource: ds,
                });

                const viewName = viewResult.viewName;

                // Skip if already registered
                if (existingViewNames.has(viewName)) {
                  continue;
                }

                const schema = viewResult.schema;

                // Register in view registry (critical for getSchema/listViews to find it)
                await registerDatasourceView(
                  context,
                  result.datasourceId,
                  viewName,
                  viewResult.displayName || viewName,
                  schema,
                  {
                    datasourceId: result.datasourceId,
                    datasourceProvider: ds.datasource_provider,
                    datasourceType: 'duckdb-native',
                    connectionConfig: ds.config as Record<string, unknown>,
                    sharedLink:
                      (ds.config as { sharedLink?: string })?.sharedLink ||
                      (ds.config as { url?: string })?.url,
                  },
                );

                // Build business context
                try {
                  await buildBusinessContext({
                    conversationDir: fileDir,
                    viewName,
                    schema,
                  });
                  // Trigger background enhancement
                  try {
                    enhanceBusinessContextInBackground({
                      conversationDir: fileDir,
                      viewName,
                      schema,
                      dbPath,
                    });
                  } catch (bgError) {
                    console.warn(
                      '[ReadDataAgent] Background context enhancement failed',
                      {
                        conversationId: conversationId.substring(0, 50),
                        error: bgError,
                      },
                    );
                  }
                } catch (contextError) {
                  console.warn(
                    '[ReadDataAgent] Failed to build business context',
                    {
                      conversationId: conversationId.substring(0, 50),
                      error: contextError,
                    },
                  );
                }
              }
            } catch (error) {
              console.warn(
                `[ReadDataAgent] Failed to register datasource ${result.datasourceId} in view registry:`,
                error,
              );
            }
          }

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

  // Helper function for sanitizing log values
  const sanitizeForLog = (value: string): string => {
    // Remove control characters and limit length to prevent log injection
    // eslint-disable-next-line no-control-regex -- Intentional: removing control chars for security
    return value.replace(/[\x00-\x1F\x7F-\x9F]/g, '').substring(0, 200);
  };

  const result = new Experimental_Agent({
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
          const result = await testConnection({
            dbPath: dbPath,
          });
          return result.toString();
        },
      }),
      createDbViewFromSheet: tool({
        description:
          'Create View(s) from Google Sheet(s). Supports single or multiple sheets. If multiple links are provided (separated by |), process them all. Each sheet gets a unique semantic name automatically based on its content.',
        inputSchema: z.object({
          sharedLink: z
            .union([
              z
                .string()
                .describe(
                  'Single Google Sheet URL, or multiple URLs separated by | (pipe character)',
                ),
              z
                .array(z.string())
                .describe('Array of Google Sheet URLs for batch creation'),
            ])
            .describe(
              'Google Sheet shared link/URL(s). Can be a single URL, multiple URLs separated by |, or an array of URLs.',
            ),
          sheetName: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe(
              'Optional meaningful name(s) for the sheet(s). If not provided, semantic names will be generated automatically based on sheet content. For multiple sheets, provide array of names or omit for auto-naming.',
            ),
        }),
        execute: async ({ sharedLink, sheetName }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const { mkdir } = await import('node:fs/promises');
          await mkdir(workspace, { recursive: true });
          const fileDir = join(workspace, conversationId);
          await mkdir(fileDir, { recursive: true });
          const dbPath = join(fileDir, 'database.db');

          // Cleanup orphaned temp tables on startup
          await cleanupOrphanedTempTables(dbPath);

          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          // Parse links: handle string with | separator or array
          let links: string[];
          if (Array.isArray(sharedLink)) {
            links = sharedLink;
          } else if (
            typeof sharedLink === 'string' &&
            sharedLink.includes('|')
          ) {
            links = sharedLink
              .split('|')
              .map((link) => link.trim())
              .filter(Boolean);
          } else {
            links = [sharedLink];
          }

          // Deduplicate links before processing (remove duplicates)
          const originalLinkCount = links.length;
          const uniqueLinks = [...new Set(links)];
          const duplicateCount = originalLinkCount - uniqueLinks.length;
          if (duplicateCount > 0) {
            console.debug('[ReadDataAgent] Removed duplicate link(s)', {
              conversationId: sanitizeForLog(conversationId),
              duplicateCount,
              uniqueLinksCount: uniqueLinks.length,
              originalLinkCount,
            });
          }
          links = uniqueLinks;

          // Parse sheet names: handle array or single string
          const names = Array.isArray(sheetName)
            ? sheetName
            : sheetName
              ? [sheetName]
              : [];

          const results: Array<{
            success: boolean;
            viewName?: string;
            displayName?: string;
            error?: string;
            link: string;
            schema?: SimpleSchema;
            errorDetails?: {
              stack?: string;
              type?: string;
            };
          }> = [];

          const existing = await loadViewRegistry(context);
          const existingNamesSet = new Set(existing.map((r) => r.viewName));

          // Sequential processing
          console.debug('[ReadDataAgent] Processing links sequentially', {
            conversationId: sanitizeForLog(conversationId),
            linkCount: links.length,
          });

          const existingNames = Array.from(existingNamesSet);

          for (let i = 0; i < links.length; i++) {
            const link = links[i];
            if (!link) continue;
            const providedName = names[i];

            try {
              // Extract sourceId from link
              const sourceId = link.match(
                /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
              )?.[1];
              const existingRecord = sourceId
                ? existing.find((rec) => rec.sourceId === sourceId)
                : null;

              if (existingRecord) {
                // View exists in registry, validate it exists in DB
                try {
                  const exists = await validateTableExists(
                    dbPath,
                    existingRecord.viewName,
                  );
                  if (exists) {
                    // Update usage and continue
                    await updateViewUsage(context, existingRecord.viewName);
                    results.push({
                      success: true,
                      viewName: existingRecord.viewName,
                      displayName: existingRecord.displayName,
                      link,
                    });
                    existingNames.push(existingRecord.viewName);
                    continue;
                  }
                } catch (validateError) {
                  console.warn(
                    '[ReadDataAgent] Error validating existing view',
                    {
                      conversationId: sanitizeForLog(conversationId),
                      error: validateError,
                    },
                  );
                }
                // View in registry but not in DB - recreate it
                console.debug(
                  '[ReadDataAgent] View in registry but missing in DB, recreating',
                  {
                    conversationId: sanitizeForLog(conversationId),
                    viewName: sanitizeForLog(existingRecord.viewName),
                  },
                );
                try {
                  await gsheetToDuckdb({
                    dbPath,
                    sharedLink: link,
                    viewName: existingRecord.viewName,
                  });
                  await updateViewUsage(context, existingRecord.viewName);
                  results.push({
                    success: true,
                    viewName: existingRecord.viewName,
                    displayName: existingRecord.displayName,
                    link,
                  });
                  continue;
                } catch (recreateError) {
                  const errorMsg =
                    recreateError instanceof Error
                      ? recreateError.message
                      : String(recreateError);
                  throw new Error(
                    `Failed to recreate existing view: ${errorMsg}`,
                  );
                }
              }

              // Generate temp name first
              const tempViewName = `temp_${Date.now()}_${Math.random()
                .toString(36)
                .substring(2, 8)}`;

              console.debug('[ReadDataAgent] Creating DuckDB view from sheet', {
                conversationId: sanitizeForLog(conversationId),
                link: sanitizeForLog(link),
              });

              let schema;
              let finalViewName: string;

              try {
                // Step 1: Create view in database
                await gsheetToDuckdb({
                  dbPath,
                  sharedLink: link,
                  viewName: tempViewName,
                });
              } catch (createError) {
                const errorMsg =
                  createError instanceof Error
                    ? createError.message
                    : String(createError);
                throw new Error(`Failed to create database view: ${errorMsg}`);
              }

              try {
                // Step 2: Extract schema from temp table
                schema = await extractSchema({
                  dbPath,
                  viewName: tempViewName,
                  allowTempTables: true,
                });
              } catch (schemaError) {
                const errorMsg =
                  schemaError instanceof Error
                    ? schemaError.message
                    : String(schemaError);
                throw new Error(`Failed to extract schema: ${errorMsg}`);
              }

              try {
                // Step 3: Determine final view name
                if (providedName) {
                  // Sanitize provided name
                  finalViewName = providedName
                    .replace(/[^a-zA-Z0-9_]/g, '_')
                    .replace(/^([^a-zA-Z])/, 'v_$1')
                    .toLowerCase();
                } else {
                  // Generate semantic name
                  finalViewName = generateSemanticViewName(
                    schema,
                    existingNames,
                  );
                }

                // Step 4: Rename in DB if different from temp name
                if (finalViewName !== tempViewName) {
                  // Check if final name already exists
                  const finalNameExists = await validateTableExists(
                    dbPath,
                    finalViewName,
                  );
                  if (finalNameExists) {
                    // If it exists, append a suffix to make it unique
                    let uniqueName = finalViewName;
                    let counter = 1;
                    while (await validateTableExists(dbPath, uniqueName)) {
                      uniqueName = `${finalViewName}_${counter}`;
                      counter++;
                    }
                    finalViewName = uniqueName;
                  }

                  await renameView(dbPath, tempViewName, finalViewName);
                }
              } catch (nameError) {
                const errorMsg =
                  nameError instanceof Error
                    ? nameError.message
                    : String(nameError);
                throw new Error(
                  `Failed to determine or rename view: ${errorMsg}`,
                );
              }

              // Update existing names list for next iteration
              existingNames.push(finalViewName);

              try {
                // Step 5: Register in view registry
                await registerSheetView(
                  context,
                  link,
                  finalViewName,
                  finalViewName, // displayName same as viewName for now
                  schema,
                );
              } catch (registryError) {
                const errorMsg =
                  registryError instanceof Error
                    ? registryError.message
                    : String(registryError);
                throw new Error(
                  `Failed to register view in registry: ${errorMsg}`,
                );
              }

              // Step 6: Build fast business context immediately
              try {
                await buildBusinessContext({
                  conversationDir: fileDir,
                  viewName: finalViewName,
                  schema,
                });
                // Trigger background enhancement
                try {
                  enhanceBusinessContextInBackground({
                    conversationDir: fileDir,
                    viewName: finalViewName,
                    schema,
                    dbPath,
                  });
                } catch (bgError) {
                  console.warn(
                    '[ReadDataAgent] Background context enhancement failed',
                    {
                      conversationId: sanitizeForLog(conversationId),
                      error: bgError,
                    },
                  );
                }
              } catch (contextError) {
                // Non-critical - log but don't fail
                console.warn(
                  '[ReadDataAgent] Failed to build business context',
                  {
                    conversationId: sanitizeForLog(conversationId),
                    error: contextError,
                  },
                );
              }

              results.push({
                success: true,
                viewName: finalViewName,
                displayName: finalViewName,
                link,
              });
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              const errorStack =
                error instanceof Error ? error.stack : undefined;
              console.error(
                '[ReadDataAgent] Failed to create view from sheet',
                {
                  conversationId: sanitizeForLog(conversationId),
                  link: sanitizeForLog(link),
                  error,
                },
              );
              results.push({
                success: false,
                error: errorMsg,
                link,
                errorDetails: errorStack
                  ? {
                      stack: errorStack,
                      type:
                        error instanceof Error
                          ? error.constructor.name
                          : typeof error,
                    }
                  : undefined,
              });
            }
          }

          // Build summary
          const successful = results.filter((r) => r.success);
          const failed = results.filter((r) => !r.success);

          const overallStatus =
            successful.length === 0
              ? 'failed'
              : failed.length > 0
                ? 'partial'
                : 'success';

          const detailedResults = results.map((r) => ({
            link: r.link,
            status: r.success ? 'success' : 'error',
            viewName: r.viewName,
            displayName: r.displayName,
            error: r.error,
            errorDetails: r.errorDetails,
          }));

          let message = '';
          const deduplicationInfo =
            duplicateCount > 0
              ? ` Found ${originalLinkCount} link(s), processed ${links.length} unique link(s) (${duplicateCount} duplicate(s) removed), and created ${successful.length} sheet(s).`
              : '';

          if (overallStatus === 'failed') {
            message = `Failed to create views from all provided Google Sheets.${deduplicationInfo} Errors: ${failed.map((f) => f.error).join('; ')}`;
          } else if (successful.length === 1) {
            const first = successful[0];
            if (!first?.viewName) {
              message = `Successfully created view from Google Sheet.${deduplicationInfo}`;
            } else {
              message = `Successfully created view "${first.viewName}" from Google Sheet.${deduplicationInfo} Use this viewName in your queries.`;
            }
          } else {
            const viewList = successful
              .map((r) => {
                if (!r.viewName || !r.link) return '';
                return `${r.link} → ${r.viewName}${r.viewName !== r.displayName ? ` (${r.displayName})` : ''}`;
              })
              .filter(Boolean)
              .join('\n');

            message = `Successfully created ${successful.length} view(s) from Google Sheets.${deduplicationInfo}\n\n${viewList}`;
            if (failed.length > 0) {
              message += `\n\nFailed to create ${failed.length} view(s). Errors: ${failed.map((f) => f.error).join('; ')}`;
            }
            message +=
              '\n\nAll views are now available - you can ask questions about their data.';
          }

          return {
            content: message,
            status: overallStatus,
            results: detailedResults,
            summary: {
              total: results.length,
              successful: successful.length,
              failed: failed.length,
              viewNames: successful
                .map((r) => r.viewName)
                .filter((name): name is string => !!name),
            },
          };
        },
      }),
      listViews: tool({
        description:
          'List all available views (sheets) in the database. Returns views with their semantic names, display names, and metadata. CACHED: Results are cached for 1 minute. Only call when starting a new conversation or when user explicitly asks to refresh.',
        inputSchema: z.object({
          forceRefresh: z
            .boolean()
            .optional()
            .describe('Force refresh cache (defaults to false)'),
        }),
        execute: async ({ forceRefresh: _forceRefresh }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          const registry = await loadViewRegistry(context);
          return {
            views: registry.map((record) => ({
              viewName: record.viewName,
              displayName: record.displayName,
              sharedLink: record.sharedLink,
              sourceId: record.sourceId,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              lastUsedAt: record.lastUsedAt,
            })),
            message:
              registry.length === 0
                ? 'No views are currently registered. Use createDbViewFromSheet to register a Google Sheet.'
                : `Found ${registry.length} view(s). Use the viewName in SQL queries.`,
          };
        },
      }),
      renameSheet: tool({
        description:
          'Rename a sheet/view to a more meaningful name. Use this when you want to give a sheet a better name based on its content, schema, or user context. Updates both database and registry.',
        inputSchema: z.object({
          oldSheetName: z
            .string()
            .describe('Current name of the sheet/view to rename'),
          newSheetName: z
            .string()
            .describe(
              'New meaningful name for the sheet (use lowercase, numbers, underscores only)',
            ),
        }),
        execute: async ({ oldSheetName, newSheetName }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');
          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          const viewRecord = await getViewByName(context, oldSheetName);
          if (!viewRecord) {
            throw new Error(
              `View "${oldSheetName}" not found in registry. Use listViews to see available views.`,
            );
          }

          // Rename in database
          const result = await renameSheet({
            dbPath,
            oldSheetName,
            newSheetName,
          });

          // Update registry
          await updateViewName(
            context,
            viewRecord.sourceId,
            newSheetName,
            newSheetName, // displayName
          );

          return result;
        },
      }),
      deleteSheet: tool({
        description:
          'Delete one or more sheets/views from the database. This permanently removes the views and all their data. Supports batch deletion of multiple sheets. Updates both database and registry. Only use this when the user explicitly requests to delete sheet(s).',
        inputSchema: z.object({
          sheetNames: z
            .array(z.string())
            .describe(
              'Array of sheet/view names to delete. Can delete one or more sheets at once. Use listViews to see available sheets.',
            ),
        }),
        execute: async ({ sheetNames }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');
          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          // Delete from database
          const result = await deleteSheet({
            dbPath,
            sheetNames,
          });

          for (const sheetName of result.deletedSheets) {
            await deleteViewFromRegistry(context, sheetName);
          }

          return result;
        },
      }),
      viewSheet: tool({
        description:
          'View/display the contents of a sheet. This is a convenient way to quickly see what data is in a sheet without writing a SQL query. Shows the first 50 rows by default.',
        inputSchema: z.object({
          sheetName: z
            .string()
            .describe(
              'Name of the sheet to view. You MUST specify this. If unsure, call listViews first.',
            ),
          limit: z
            .number()
            .optional()
            .describe('Maximum number of rows to display (defaults to 50)'),
        }),
        execute: async ({ sheetName, limit }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const dbPath = join(workspace, conversationId, 'database.db');

          // Get conversation datasources for foreign datasource attachment
          let datasourceIds: string[] | undefined;
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              datasourceIds = conversation?.datasources;
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to get conversation datasources for viewSheet:',
                error,
              );
            }
          }

          const result = await viewSheet({
            dbPath,
            sheetName,
            limit,
            datasourceIds,
            datasourceRepository: repositories?.datasource,
          });
          return {
            sheetName: result.sheetName,
            totalRows: result.totalRows,
            displayedRows: result.displayedRows,
            columns: result.columns,
            rows: result.rows,
            message: result.message,
          };
        },
      }),
      getSchema: tool({
        description:
          'Discover available data structures directly from DuckDB (views + attached databases). If viewName is provided, returns schema for that specific view/table (accepts fully qualified paths like "ds_x.public.users" or simple view names). If not provided, returns schemas for everything discovered in DuckDB. This updates the business context automatically. Supports both Google Sheets (via view registry) and foreign databases (PostgreSQL, MySQL, SQLite).',
        inputSchema: z.object({
          viewName: z
            .string()
            .optional()
            .describe(
              'Name of the view/table to get schema for. Can be a simple view name (e.g., "customers") or fully qualified path (e.g., "ds_x.public.users"). If not provided, returns all available schemas. Use listViews first if unsure about view names.',
            ),
        }),
        execute: async ({ viewName }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');

          // Helper to describe a single table/view
          const describeObject = async (
            conn: Awaited<
              ReturnType<
                Awaited<
                  ReturnType<
                    typeof import('@duckdb/node-api').DuckDBInstance.create
                  >
                >['connect']
              >
            >,
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

          // Enumerate all databases/schemas/tables/views from DuckDB
          const { DuckDBInstance } = await import('@duckdb/node-api');
          const instance = await DuckDBInstance.create(dbPath);
          const conn = await instance.connect();

          const collectedSchemas: Map<string, SimpleSchema> = new Map();

          try {
            // Re-attach foreign datasources for this connection
            if (repositories) {
              try {
                const getConversationService = new GetConversationBySlugService(
                  repositories.conversation,
                );
                const conversation =
                  await getConversationService.execute(conversationId);
                if (conversation?.datasources?.length) {
                  await attachAllForeignDatasourcesToConnection({
                    conn,
                    datasourceIds: conversation.datasources,
                    datasourceRepository: repositories.datasource,
                  });
                }
              } catch (error) {
                console.warn(
                  '[ReadDataAgent] Failed to attach foreign datasources:',
                  error,
                );
              }
            }

            const dbReader = await conn.runAndReadAll(
              'SELECT name FROM pragma_database_list;',
            );
            await dbReader.readAll();
            const dbRows = dbReader.getRowObjectsJS() as Array<{
              name: string;
            }>;
            const databases = dbRows.map((r) => r.name);

            const targets: Array<{
              db: string;
              schema: string;
              table: string;
            }> = [];

            for (const db of databases) {
              const escapedDb = db.replace(/"/g, '""');
              const tablesReader = await conn.runAndReadAll(`
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_catalog = '${escapedDb}'
                  AND table_type IN ('BASE TABLE', 'VIEW')
              `);
              await tablesReader.readAll();
              const tableRows = tablesReader.getRowObjectsJS() as Array<{
                table_schema: string;
                table_name: string;
                table_type: string;
              }>;
              for (const row of tableRows) {
                targets.push({
                  db,
                  schema: row.table_schema || 'main',
                  table: row.table_name,
                });
              }
            }

            if (viewName) {
              // Describe only the requested object
              const viewId = viewName as string;
              let db = 'main';
              let schemaName = 'main';
              let tableName = viewId;
              if (viewId.includes('.')) {
                const parts = viewId.split('.').filter(Boolean);
                if (parts.length === 3) {
                  db = parts[0] ?? db;
                  schemaName = parts[1] ?? schemaName;
                  tableName = parts[2] ?? tableName;
                } else if (parts.length === 2) {
                  schemaName = parts[0] ?? schemaName;
                  tableName = parts[1] ?? tableName;
                } else if (parts.length === 1) {
                  tableName = parts[0] ?? tableName;
                }
              }
              const schema = await describeObject(
                conn,
                db,
                schemaName,
                tableName,
              );
              if (!schema) {
                throw new Error(`Object "${viewId}" not found in DuckDB`);
              }
              collectedSchemas.set(viewId, schema);
            } else {
              // Describe everything discovered
              for (const target of targets) {
                const fullName = `${target.db}.${target.schema}.${target.table}`;
                const schema = await describeObject(
                  conn,
                  target.db,
                  target.schema,
                  target.table,
                );
                if (schema) {
                  collectedSchemas.set(fullName, schema);
                }
              }
            }
          } finally {
            conn.closeSync();
            instance.closeSync();
          }

          // Get performance configuration
          const perfConfig = await getConfig(fileDir);

          // Build schemasMap and primary schema
          const schemasMap = collectedSchemas;
          const schema = (viewName && collectedSchemas.get(viewName)) ||
            collectedSchemas.values().next().value || {
              databaseName: 'main',
              schemaName: 'main',
              tables: [],
            };

          // Build fast context
          let fastContext: BusinessContext;
          const context: RegistryContext = {
            conversationDir: fileDir,
          };

          if (viewName) {
            // Single view - build fast context
            fastContext = await buildBusinessContext({
              conversationDir: fileDir,
              viewName,
              schema,
            });

            // Start enhancement in background
            enhanceBusinessContextInBackground({
              conversationDir: fileDir,
              viewName,
              schema,
              dbPath,
            });

            // Update view usage if it's in the registry
            try {
              const registry = await loadViewRegistry(context);
              const viewRecord = registry.find((r) => r.viewName === viewName);
              if (viewRecord) {
                await updateViewUsage(context, viewName);
              }
            } catch {
              // Ignore if not in registry
            }
          } else {
            // Multiple views - build fast context for each
            const fastContexts: BusinessContext[] = [];
            for (const [vName, vSchema] of schemasMap.entries()) {
              const ctx = await buildBusinessContext({
                conversationDir: fileDir,
                viewName: vName,
                schema: vSchema,
              });
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
            fastContext = mergeBusinessContexts(fastContexts);
          }

          const entities = Array.from(fastContext.entities.values()).slice(
            0,
            perfConfig.expectedViewCount * 2,
          );
          const relationships = fastContext.relationships.slice(
            0,
            perfConfig.expectedViewCount * 3,
          );

          // Return schema and data insights
          return {
            schema: schema,
            businessContext: {
              domain: fastContext.domain.domain,
              entities: entities.map((e) => ({
                name: e.name,
                columns: e.columns,
                views: e.views,
              })),
              relationships: relationships.map((r) => ({
                fromView: r.fromView,
                toView: r.toView,
                fromColumn: r.fromColumn,
                toColumn: r.toColumn,
                type: r.type,
                join: r.joinCondition,
              })),
              vocabulary: Object.fromEntries(
                Array.from(fastContext.vocabulary.entries()).map(
                  ([key, value]) => [
                    key,
                    {
                      businessTerm: value.businessTerm,
                      technicalTerms: value.technicalTerms,
                      synonyms: value.synonyms,
                    },
                  ],
                ),
              ),
            },
          };
        },
      }),
      runQuery: tool({
        description:
          'Run a SQL query against the DuckDB instance (views from file-based datasources or attached database tables). Query views by name (e.g., "customers") or attached tables by full path (e.g., ds_x.public.users). DuckDB enables federated queries across PostgreSQL, MySQL, Google Sheets, and other datasources. Business context is automatically used to improve query understanding. View usage is tracked automatically for registered views.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');

          // Load business context for query understanding
          const businessContext = await loadBusinessContext(fileDir);

          // Get conversation datasources for foreign datasource attachment
          let datasourceIds: string[] | undefined;
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              datasourceIds = conversation?.datasources;
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to get conversation datasources:',
                error,
              );
            }
          }

          const result = await runQuery({
            dbPath,
            query,
            datasourceIds,
            datasourceRepository: repositories?.datasource,
          });

          // Extract view names from query and update usage
          const context: RegistryContext = {
            conversationDir: fileDir,
          };
          try {
            const registry = await loadViewRegistry(context);
            // Simple extraction: look for view names in FROM/JOIN clauses
            const viewNameRegex = /(?:FROM|JOIN)\s+["']?(\w+)["']?/gi;
            const matches = query.matchAll(viewNameRegex);
            const viewNames = new Set<string>();
            for (const match of matches) {
              const viewName = match[1];
              if (viewName && registry.some((r) => r.viewName === viewName)) {
                viewNames.add(viewName);
              }
            }
            // Update usage for all views used in query
            for (const viewName of viewNames) {
              await updateViewUsage(context, viewName);
            }
          } catch {
            // Ignore if registry doesn't exist
          }

          return {
            result: result,
            businessContext: businessContext
              ? {
                  domain: businessContext.domain.domain,
                  entities: Array.from(businessContext.entities.values()).map(
                    (e) => ({
                      name: e.name,
                      columns: e.columns,
                    }),
                  ),
                  relationships: businessContext.relationships.map((r) => ({
                    from: r.fromView,
                    to: r.toView,
                    join: `${r.fromColumn} = ${r.toColumn}`,
                  })),
                  vocabulary: Object.fromEntries(
                    Array.from(businessContext.vocabulary.entries()).map(
                      ([key, value]) => [
                        key,
                        {
                          businessTerm: value.businessTerm,
                          technicalTerms: value.technicalTerms,
                          synonyms: value.synonyms,
                        },
                      ],
                    ),
                  ),
                }
              : null,
          };
        },
      }),
      selectChartType: tool({
        description: `Select the best chart type (${getSupportedChartTypes().join(', ')}) for visualizing the query results. Uses business context to understand data semantics for better chart selection. This should be called before generateChart. IMPORTANT: Parameters must be at the top level: { queryResults: { columns: string[], rows: Array<Record> }, sqlQuery: string, userInput: string }`,
        inputSchema: z.object({
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())).optional(),
            columns: z.array(z.string()).optional(),
            sqlQuery: z.string().optional(),
            userInput: z.string().optional(),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async (input) => {
          // Normalize input
          let queryResults = input.queryResults;
          let sqlQuery = input.sqlQuery;
          let userInput = input.userInput;

          if (
            queryResults &&
            typeof queryResults === 'object' &&
            !Array.isArray(queryResults)
          ) {
            const qr = queryResults as Record<string, unknown>;

            if (
              !sqlQuery &&
              'sqlQuery' in qr &&
              typeof qr.sqlQuery === 'string'
            ) {
              sqlQuery = qr.sqlQuery;
            }

            if (
              !userInput &&
              'userInput' in qr &&
              typeof qr.userInput === 'string'
            ) {
              userInput = qr.userInput;
            }

            if (
              (sqlQuery && 'sqlQuery' in qr) ||
              (userInput && 'userInput' in qr)
            ) {
              const { sqlQuery: _, userInput: __, ...rest } = qr;
              if ('rows' in rest && 'columns' in rest) {
                queryResults = rest as {
                  rows: Record<string, unknown>[];
                  columns: string[];
                };
              } else if (
                'queryResults' in rest &&
                typeof rest.queryResults === 'object'
              ) {
                const nestedQr = rest.queryResults as Record<string, unknown>;
                if ('rows' in nestedQr && 'columns' in nestedQr) {
                  queryResults = {
                    rows: nestedQr.rows as Record<string, unknown>[],
                    columns: nestedQr.columns as string[],
                  };
                }
              }
            }
          }

          // Validate required parameters
          if (!queryResults) {
            throw new Error(
              'queryResults is required. Got: ' + JSON.stringify(input),
            );
          }
          if (!queryResults.columns || !Array.isArray(queryResults.columns)) {
            throw new Error(
              'queryResults.columns must be an array. Got: ' +
                JSON.stringify(queryResults),
            );
          }
          if (!queryResults.rows || !Array.isArray(queryResults.rows)) {
            throw new Error(
              'queryResults.rows must be an array. Got: ' +
                JSON.stringify(queryResults),
            );
          }
          if (!sqlQuery || typeof sqlQuery !== 'string') {
            throw new Error(
              'sqlQuery is required and must be a string. Got: ' +
                typeof sqlQuery,
            );
          }
          if (!userInput || typeof userInput !== 'string') {
            throw new Error(
              'userInput is required and must be a string. Got: ' +
                typeof userInput,
            );
          }

          const normalizedQueryResults: {
            rows: Array<Record<string, unknown>>;
            columns: string[];
          } = {
            rows: queryResults.rows,
            columns: queryResults.columns,
          };

          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const businessContext = await loadBusinessContext(fileDir);

          const selection = await selectChartType(
            normalizedQueryResults,
            sqlQuery,
            userInput,
            businessContext,
          );
          return selection;
        },
      }),
      generateChart: tool({
        description:
          'Generate chart configuration JSON for the selected chart type. Uses business context to create better labels and understand data semantics. Call selectChartType first to determine the chart type. IMPORTANT: Parameters must be at the top level: { chartType: string, queryResults: { columns: string[], rows: Array<Record> }, sqlQuery: string, userInput: string }',
        inputSchema: z.object({
          chartType: ChartTypeSchema,
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())).optional(),
            columns: z.array(z.string()).optional(),
            sqlQuery: z.string().optional(),
            userInput: z.string().optional(),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async (input) => {
          let chartType = input.chartType;
          let queryResults = input.queryResults;
          let sqlQuery = input.sqlQuery;
          let userInput = input.userInput;

          if (
            queryResults &&
            typeof queryResults === 'object' &&
            !Array.isArray(queryResults)
          ) {
            const qr = queryResults as Record<string, unknown>;

            if (
              !chartType &&
              'chartType' in qr &&
              typeof qr.chartType === 'string'
            ) {
              const ct = qr.chartType;
              const supportedTypes = getSupportedChartTypes();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (supportedTypes.includes(ct as any)) {
                chartType = ct as typeof chartType;
              }
            }

            if (
              !sqlQuery &&
              'sqlQuery' in qr &&
              typeof qr.sqlQuery === 'string'
            ) {
              sqlQuery = qr.sqlQuery;
            }

            if (
              !userInput &&
              'userInput' in qr &&
              typeof qr.userInput === 'string'
            ) {
              userInput = qr.userInput;
            }

            if (
              (chartType && 'chartType' in qr) ||
              (sqlQuery && 'sqlQuery' in qr) ||
              (userInput && 'userInput' in qr)
            ) {
              const {
                chartType: _,
                sqlQuery: __,
                userInput: ___,
                ...rest
              } = qr;
              queryResults = rest as {
                rows: Record<string, unknown>[];
                columns: string[];
              };
            }
          }

          // Validate required parameters
          const supportedTypes = getSupportedChartTypes();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (!chartType || !supportedTypes.includes(chartType as any)) {
            throw new Error(
              `chartType is required and must be one of: ${supportedTypes.join(', ')}. Got: ${chartType}`,
            );
          }
          if (!queryResults) {
            throw new Error(
              'queryResults is required. Got: ' + JSON.stringify(input),
            );
          }
          if (!queryResults.columns || !Array.isArray(queryResults.columns)) {
            throw new Error(
              'queryResults.columns must be an array. Got: ' +
                JSON.stringify(queryResults),
            );
          }
          if (!queryResults.rows || !Array.isArray(queryResults.rows)) {
            throw new Error(
              'queryResults.rows must be an array. Got: ' +
                JSON.stringify(queryResults),
            );
          }
          if (!sqlQuery || typeof sqlQuery !== 'string') {
            throw new Error(
              'sqlQuery is required and must be a string. Got: ' +
                typeof sqlQuery,
            );
          }
          if (!userInput || typeof userInput !== 'string') {
            throw new Error(
              'userInput is required and must be a string. Got: ' +
                typeof userInput,
            );
          }

          const normalizedQueryResults: {
            rows: Array<Record<string, unknown>>;
            columns: string[];
          } = {
            rows: queryResults.rows,
            columns: queryResults.columns,
          };

          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const businessContext = await loadBusinessContext(fileDir);

          const chartConfig = await generateChart({
            queryResults: normalizedQueryResults,
            sqlQuery,
            userInput,
            chartType,
            businessContext,
          });
          return chartConfig;
        },
      }),
    },
    stopWhen: stepCountIs(20),
  });

  // Stream with messages (matches main branch behavior)
  return result.stream({
    messages: convertToModelMessages(await validateUIMessages({ messages })),
    providerOptions: {
      openai: {
        reasoningSummary: 'auto',
        reasoningEffort: 'medium',
        reasoningDetailedSummary: true,
        reasoningDetailedSummaryLength: 'long',
      },
    },
  });
};

/**
 * Actor wrapper for readDataAgent function (matches main branch signature)
 */
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
