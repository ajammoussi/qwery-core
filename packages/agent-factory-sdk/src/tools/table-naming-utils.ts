/**
 * Table Naming Utilities
 *
 * Centralizes table naming logic to prevent hardcoding across multiple files.
 * Handles special cases for providers that don't follow the default naming pattern.
 */

export type TableNamingFormat = 'two-part' | 'three-part';

/**
 * Get the table naming format for a specific provider
 *
 * Special cases:
 * - gsheet-csv: two-part (datasource.table) despite being foreign-database
 * - clickhouse-node, clickhouse-web: three-part (datasource.schema.table) despite being duckdb-native
 *
 * Default:
 * - duckdb-native: two-part
 * - foreign-database: three-part
 */
export function getTableNamingFormat(provider: string): TableNamingFormat {
  // Special case: gsheet-csv uses two-part naming
  if (provider === 'gsheet-csv') {
    return 'two-part';
  }

  // Special case: ClickHouse uses three-part naming
  if (provider === 'clickhouse-node' || provider === 'clickhouse-web') {
    return 'three-part';
  }

  // Default: determine based on datasource type
  // This is a fallback - in practice, the caller should know the datasource type
  // But we provide a reasonable default
  return 'three-part'; // Default to three-part for safety
}

/**
 * Format a table path based on provider's naming format
 *
 * @param databaseName - The datasource database name
 * @param schemaName - The schema name (e.g., 'main', 'default', 'public')
 * @param tableName - The table name
 * @param provider - The datasource provider
 * @returns Formatted table path
 */
export function formatTablePath(
  databaseName: string,
  schemaName: string,
  tableName: string,
  provider: string,
): string {
  const format = getTableNamingFormat(provider);

  if (format === 'two-part') {
    // Two-part format: datasource.table
    return `${databaseName}.${tableName}`;
  } else {
    // Three-part format: datasource.schema.table
    return `${databaseName}.${schemaName}.${tableName}`;
  }
}
