import type { Datasource, SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';

// Connection type from DuckDB instance
export type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

/**
 * Base options for all attachment strategies
 */
export interface BaseAttachmentOptions {
  connection: Connection;
  datasource: Datasource;
  conversationId?: string;
  workspace?: string;
}

/**
 * Result from attaching a datasource
 * Different strategies may return different result structures
 */
export interface AttachmentResult {
  viewName?: string; // For DuckDB-native views
  displayName?: string;
  schema?: SimpleSchema;
  attachedDatabaseName?: string; // For attached databases
  tables?: Array<{
    schema: string;
    table: string;
    path: string;
    schemaDefinition?: SimpleSchema;
    csvUrl?: string; // For GSheet
  }>;
}

/**
 * Strategy interface for attaching datasources
 */
export interface AttachmentStrategy {
  /**
   * Check if this strategy can handle the given provider
   */
  canHandle(provider: string): boolean;

  /**
   * Attach the datasource using this strategy
   */
  attach(options: BaseAttachmentOptions): Promise<AttachmentResult>;
}

/**
 * Options specific to DuckDB-native attachment (creates views)
 */
export type DuckDBNativeAttachmentOptions = BaseAttachmentOptions;

/**
 * Options specific to foreign database attachment
 */
export interface ForeignDatabaseAttachmentOptions
  extends BaseAttachmentOptions {
  extractSchema?: boolean; // Default: true
}

/**
 * Options specific to ClickHouse attachment
 */
export interface ClickHouseAttachmentOptions extends BaseAttachmentOptions {
  conversationId: string; // Required
  workspace: string; // Required
}

/**
 * Options specific to GSheet attachment
 */
export interface GSheetAttachmentOptions extends BaseAttachmentOptions {
  extractSchema?: boolean; // Default: true
  conversationId: string; // Required
  workspace: string; // Required
}
