import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { extractSchema } from './extract-schema';
import { gsheetToDuckdb } from './gsheet-to-duckdb';
import { generateSemanticViewName } from './view-registry';
import { getDatasourceDatabaseName } from './datasource-name-utils';
import { extractConnectionUrl } from './connection-string-utils';
import {
  setClickHouseSchemaMappings,
} from './clickhouse-schema-mapping';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

const sanitizeName = (value: string): string => {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `v_${cleaned}`;
};

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
 * Create DuckDB views from a DuckDB-native datasource
 * This handles datasources like gsheet-csv, duckdb, json-online, etc.
 */
export async function datasourceToDuckdb(
  opts: DatasourceToDuckDbOptions,
): Promise<CreateViewResult> {
  const { connection: conn, datasource } = opts;

  const provider = datasource.datasource_provider;
  const config = datasource.config as Record<string, unknown>;

  // For DuckDB-native providers (gsheet-csv, csv, json-online, parquet-online),
  // we use DuckDB functions directly and don't need driver loading
  // Note: ClickHouse (clickhouse-node, clickhouse-web) goes through driver loading path
  // to create attached database tables, not views
  const duckdbNativeProviders = [
    'gsheet-csv',
    'csv',
    'json-online',
    'parquet-online',
    'youtube-data-api-v3',
  ];

  // Generate a temporary name for initial creation to allow semantic renaming later
  const baseName =
    datasource.name?.trim() || datasource.datasource_provider?.trim() || 'data';
  const tempViewName = sanitizeName(
    `tmp_${datasource.id}_${baseName}`.toLowerCase(),
  );
  const escapedTempViewName = tempViewName.replace(/"/g, '""');

  // Handle DuckDB-native providers that don't need driver loading
  if (duckdbNativeProviders.includes(provider)) {
    // Create view directly from source
    switch (provider) {
      case 'gsheet-csv': {
        const sharedLink =
          (config.sharedLink as string) || (config.url as string);
        if (!sharedLink) {
          throw new Error(
            'gsheet-csv datasource requires sharedLink or url in config',
          );
        }
        await gsheetToDuckdb({
          connection: conn,
          sharedLink,
          viewName: tempViewName,
        });
        break;
      }
      case 'csv': {
        const path =
          (config.path as string) ||
          (config.url as string) ||
          (config.connectionUrl as string);
        if (!path) {
          throw new Error('csv datasource requires path or url in config');
        }
        await conn.run(`
        CREATE OR REPLACE VIEW "${escapedTempViewName}" AS
        SELECT * FROM read_csv_auto('${path.replace(/'/g, "''")}')
      `);
        break;
      }
      case 'json-online': {
        const url =
          (config.url as string) ||
          (config.path as string) ||
          (config.connectionUrl as string);
        if (!url) {
          throw new Error(
            'json-online datasource requires url or path in config',
          );
        }
        await conn.run(`
        CREATE OR REPLACE VIEW "${escapedTempViewName}" AS
        SELECT * FROM read_json_auto('${url.replace(/'/g, "''")}')
      `);
        break;
      }
      case 'parquet-online': {
        const url =
          (config.url as string) ||
          (config.path as string) ||
          (config.connectionUrl as string);
        if (!url) {
          throw new Error(
            'parquet-online datasource requires url or path in config',
          );
        }
        await conn.run(`
        CREATE OR REPLACE VIEW "${escapedTempViewName}" AS
        SELECT * FROM read_parquet('${url.replace(/'/g, "''")}')
      `);
        break;
      }
      default:
        break;
    }

    // Verify the view was created successfully
    try {
      const verifyReader = await conn.runAndReadAll(
        `SELECT 1 FROM "${escapedTempViewName}" LIMIT 1`,
      );
      await verifyReader.readAll();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create or verify view "${tempViewName}": ${errorMsg}`,
      );
    }

    // Extract schema from the created view
    const schema = await extractSchema({
      connection: conn,
      viewName: tempViewName,
    });

    // Generate semantic name from schema
    const semanticName = generateSemanticViewName(schema);
    const finalViewName = sanitizeName(
      `${datasource.id}_${semanticName}`.toLowerCase(),
    );
    const escapedFinalViewName = finalViewName.replace(/"/g, '""');

    // Rename view to semantic name
    if (finalViewName !== tempViewName) {
      await conn.run(
        `ALTER VIEW "${escapedTempViewName}" RENAME TO "${escapedFinalViewName}"`,
      );
    }

    return {
      viewName: finalViewName,
      displayName: finalViewName,
      schema,
    };
  }

  // For other providers, we need to load the driver and get metadata
  // Dynamically import extensions-sdk and extensions-loader to avoid build-time dependency issues
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - Dynamic import, module will be available at runtime
  const extensionsSdk = await import('@qwery/extensions-sdk');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - Dynamic import, module will be available at runtime
  const extensionsLoader = await import('@qwery/extensions-loader');
  const { getDiscoveredDatasource } = extensionsSdk;
  const { getDriverInstance } = extensionsLoader;

  // Get extension metadata to find the driver
  const dsMeta = await getDiscoveredDatasource(datasource.datasource_provider);
  if (!dsMeta) {
    throw new Error(
      `Extension metadata not found for provider: ${datasource.datasource_provider}`,
    );
  }

  // Find the appropriate driver (prefer DuckDB driver if available)
  // If datasource_driver is set, use it; otherwise find the best match
  let driverId: string | undefined = datasource.datasource_driver;

  // If driverId is set but doesn't match any driver, try to find a match
  if (driverId) {
    const foundDriver = dsMeta.drivers.find(
      (d: { id: string }) => d.id === driverId,
    );
    if (!foundDriver) {
      // Driver ID might be just the provider name, try to find matching driver
      const matchingDriver = dsMeta.drivers.find(
        (d: { id: string }) =>
          d.id.includes(driverId!) ||
          d.id.includes(datasource.datasource_provider),
      );
      if (matchingDriver) {
        driverId = matchingDriver.id;
      } else {
        // Reset to undefined to use fallback logic
        driverId = undefined;
      }
    }
  }

  if (!driverId) {
    // Try to find a DuckDB driver first
    const duckdbDriver = dsMeta.drivers.find(
      (d: { id: string }) =>
        d.id.includes('duckdb') ||
        d.id.includes(datasource.datasource_provider),
    );
    if (duckdbDriver) {
      driverId = duckdbDriver.id;
    } else if (dsMeta.drivers.length > 0) {
      // Fallback to first available driver
      driverId = dsMeta.drivers[0]?.id;
    }
  }

  if (!driverId) {
    throw new Error(
      `No driver found for datasource provider: ${datasource.datasource_provider}. Available drivers: ${dsMeta.drivers.map((d: { id: string }) => d.id).join(', ')}`,
    );
  }

  // Load and instantiate the driver
  // Find the driver metadata
  const driverMeta = dsMeta.drivers.find(
    (d: { id: string }) => d.id === driverId,
  );
  if (!driverMeta) {
    throw new Error(
      `Driver ${driverId} not found in extension metadata. Available drivers: ${dsMeta.drivers.map((d: { id: string }) => d.id).join(', ')}`,
    );
  }

  const driver = await getDriverInstance({
    id: driverId,
    packageDir: dsMeta.packageDir,
    entry: driverMeta.entry,
    runtime: (driverMeta.runtime as 'node' | 'browser') || 'node',
    name: driverMeta.name || driverId,
  });

  try {
    // Test connection
    await driver.testConnection(datasource.config);

    // Get metadata to understand the schema
    const metadata = await driver.metadata(datasource.config);

    // Special handling for ClickHouse: create attached database with all tables
    if (provider === 'clickhouse-node' || provider === 'clickhouse-web') {
      if (!opts.conversationId || !opts.workspace) {
        throw new Error(
          'ClickHouse datasource requires conversationId and workspace for persistent database attachment',
        );
      }

      // Get connection URL for ClickHouse HTTP interface
      const connectionUrl = extractConnectionUrl(
        datasource.config as Record<string, unknown>,
        provider,
      );

      // Parse connection URL to extract host and port
      let clickhouseHost = 'localhost';
      let clickhousePort = 8123;
      try {
        const url = new URL(connectionUrl);
        clickhouseHost = url.hostname;
        clickhousePort = url.port ? parseInt(url.port, 10) : 8123;
      } catch {
        // If URL parsing fails, try to extract from connectionUrl string
        const match = connectionUrl.match(/http:\/\/([^:]+):(\d+)/);
        if (match) {
          clickhouseHost = match[1]!;
          clickhousePort = parseInt(match[2]!, 10);
        }
      }

      // Use datasource name directly as database name (sanitized)
      const attachedDatabaseName = getDatasourceDatabaseName(datasource);
      const escapedDbName = attachedDatabaseName.replace(/"/g, '""');

      // Create persistent attached database using SQLite file
      // Store in conversation directory: workspace/conversationId/datasource_name.db
      try {
        // Check if database is already attached
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
          const conversationDir = join(opts.workspace, opts.conversationId);
          await mkdir(conversationDir, { recursive: true });
          const dbFilePath = join(conversationDir, `${attachedDatabaseName}.db`);

          // Escape single quotes in file path for SQL injection protection
          const escapedPath = dbFilePath.replace(/'/g, "''");

          // Attach persistent SQLite database file
          await conn.run(`ATTACH '${escapedPath}' AS "${escapedDbName}"`);

          console.log(
            `[ClickHouseAttach] Attached persistent database: ${attachedDatabaseName} at ${dbFilePath}`,
          );
        }
      } catch (error) {
        // If attach fails, try to continue (might already be attached)
        console.warn(
          `[ClickHouseAttach] Could not attach database ${attachedDatabaseName}, continuing:`,
          error,
        );
      }

      // Store schema mapping: table_name -> original_schema_name
      const schemaMapping = new Map<string, string>();

      // Get unique schemas from metadata
      const uniqueSchemas = new Set(
        metadata.tables.map((t) => t.schema || 'default'),
      );

      // Loop through ALL schemas
      for (const schemaName of uniqueSchemas) {
        // Filter tables for this schema
        const schemaTables = metadata.tables.filter(
          (t) => (t.schema || 'default') === schemaName,
        );

        // Loop through ALL tables in this schema
        for (const table of schemaTables) {
          try {
            const tableName = table.name;
            const originalSchema = table.schema || 'default';

            // Store schema mapping
            schemaMapping.set(tableName, originalSchema);

            // Build HTTP URL for ClickHouse JSONEachRow format
            const query = `SELECT * FROM ${originalSchema}.${tableName} LIMIT 1000 FORMAT JSONEachRow`;
            const encodedQuery = encodeURIComponent(query);
            const httpUrl = `http://${clickhouseHost}:${clickhousePort}/?query=${encodedQuery}`;

            // Escape table name for SQL
            const escapedTableName = tableName.replace(/"/g, '""');

            // Create table in attached database using HTTP JSONEachRow format
            // SQLite only supports "main" schema, so we create in main
            const escapedHttpUrl = httpUrl.replace(/'/g, "''");
            await conn.run(`
              CREATE TABLE IF NOT EXISTS "${escapedDbName}"."main"."${escapedTableName}" AS
              SELECT * FROM read_json_auto('${escapedHttpUrl}')
            `);

            console.log(
              `[ClickHouseAttach] Created table ${attachedDatabaseName}.main.${tableName} from schema ${originalSchema}`,
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(
              `[ClickHouseAttach] Failed to create table ${table.name} from schema ${schemaName}:`,
              errorMsg,
            );
            // Continue with other tables even if one fails
          }
        }
      }

      if (schemaMapping.size === 0) {
        throw new Error('No tables were successfully created from ClickHouse metadata');
      }

      // Store schema mapping for later use in transform service
      setClickHouseSchemaMappings(datasource.id, schemaMapping);

      // Get the first table for return value (agent will discover all via metadata)
      const firstTable = metadata.tables[0];
      if (!firstTable) {
        throw new Error('No tables found in datasource metadata');
      }

      // Extract schema from the first table
      const firstTableName = firstTable.name;
      const escapedFirstTableName = firstTableName.replace(/"/g, '""');
      const schema = await extractSchema({
        connection: conn,
        viewName: `${attachedDatabaseName}.main.${firstTableName}`,
      });

      // Return first table info (agent will discover all via metadata)
      return {
        viewName: `${attachedDatabaseName}.main.${firstTableName}`,
        displayName: firstTableName,
        schema,
      };
    }

    // For other providers, use the original logic
    // Get the first table from metadata
    const firstTable = metadata.tables[0];
    if (!firstTable) {
      throw new Error('No tables found in datasource metadata');
    }

    // Generate deterministic temporary name
    const tablePart = firstTable.name || 'table';
    const tempViewNameWithTable = sanitizeName(
      `tmp_${datasource.id}_${baseName}_${tablePart}`.toLowerCase(),
    );

    const escapedTempViewNameWithTable = tempViewNameWithTable.replace(
      /"/g,
      '""',
    );

    // Fallback: select from driver-accessible table directly
    const tableQuery = `SELECT * FROM ${firstTable.schema}.${firstTable.name}`;
    await conn.run(`
      CREATE OR REPLACE VIEW "${escapedTempViewNameWithTable}" AS
      ${tableQuery}
    `);

    // Verify the view was created successfully
    try {
      const verifyReader = await conn.runAndReadAll(
        `SELECT 1 FROM "${escapedTempViewNameWithTable}" LIMIT 1`,
      );
      await verifyReader.readAll();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create or verify view "${tempViewNameWithTable}": ${errorMsg}`,
      );
    }

    // Extract schema from the created view
    const schema = await extractSchema({
      connection: conn,
      viewName: tempViewNameWithTable,
    });

    // Generate semantic name from schema
    const semanticName = generateSemanticViewName(schema);
    const finalViewName = sanitizeName(
      `${datasource.id}_${semanticName}`.toLowerCase(),
    );
    const escapedFinalViewName = finalViewName.replace(/"/g, '""');

    // Rename view to semantic name
    if (finalViewName !== tempViewNameWithTable) {
      await conn.run(
        `ALTER VIEW "${escapedTempViewNameWithTable}" RENAME TO "${escapedFinalViewName}"`,
      );
    }

    return {
      viewName: finalViewName,
      displayName: finalViewName,
      schema,
    };
  } finally {
    // Close driver if it has a close method
    if (driver.close) {
      await driver.close();
    }
  }
}
