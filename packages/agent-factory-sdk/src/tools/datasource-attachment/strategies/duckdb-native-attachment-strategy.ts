import type {
  AttachmentStrategy,
  AttachmentResult,
  DuckDBNativeAttachmentOptions,
} from '../types';
import { extractSchema } from '../../extract-schema';
import { generateSemanticViewName } from '../../view-registry';

const sanitizeName = (value: string): string => {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `v_${cleaned}`;
};

/**
 * DuckDB-native providers that create views directly
 * Note: gsheet-csv is handled by GSheetAttachmentStrategy
 */
const DUCKDB_NATIVE_PROVIDERS = [
  'csv',
  'json-online',
  'parquet-online',
  'youtube-data-api-v3',
] as const;

export class DuckDBNativeAttachmentStrategy implements AttachmentStrategy {
  canHandle(provider: string): boolean {
    return DUCKDB_NATIVE_PROVIDERS.includes(
      provider as (typeof DUCKDB_NATIVE_PROVIDERS)[number],
    );
  }

  async attach(
    options: DuckDBNativeAttachmentOptions,
  ): Promise<AttachmentResult> {
    const { connection: conn, datasource } = options;
    const provider = datasource.datasource_provider;
    const config = datasource.config as Record<string, unknown>;

    // Generate a temporary name for initial creation to allow semantic renaming later
    const baseName =
      datasource.name?.trim() || datasource.datasource_provider?.trim() || 'data';
    const tempViewName = sanitizeName(
      `tmp_${datasource.id}_${baseName}`.toLowerCase(),
    );
    const escapedTempViewName = tempViewName.replace(/"/g, '""');

    // Create view directly from source based on provider type
    switch (provider) {
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
        throw new Error(`Unsupported DuckDB-native provider: ${provider}`);
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
}
