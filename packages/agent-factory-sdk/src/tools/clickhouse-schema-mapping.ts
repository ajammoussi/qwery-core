/**
 * ClickHouse Schema Mapping
 *
 * Stores mapping of table names to original ClickHouse schema names.
 * This is needed because SQLite attached databases only support "main" schema,
 * but we want to preserve the original ClickHouse schema names (e.g., "default", "test_schema").
 *
 * Map structure: datasourceId -> tableName -> originalSchemaName
 */
const schemaMapping = new Map<string, Map<string, string>>();

/**
 * Store schema mapping for a ClickHouse datasource
 */
export function setClickHouseSchemaMapping(
  datasourceId: string,
  tableName: string,
  originalSchemaName: string,
): void {
  if (!schemaMapping.has(datasourceId)) {
    schemaMapping.set(datasourceId, new Map());
  }
  schemaMapping.get(datasourceId)!.set(tableName, originalSchemaName);
}

/**
 * Store multiple schema mappings for a ClickHouse datasource
 */
export function setClickHouseSchemaMappings(
  datasourceId: string,
  mappings: Map<string, string>,
): void {
  schemaMapping.set(datasourceId, mappings);
}

/**
 * Get original schema name for a ClickHouse table
 */
export function getClickHouseOriginalSchema(
  datasourceId: string,
  tableName: string,
): string | undefined {
  return schemaMapping.get(datasourceId)?.get(tableName);
}

/**
 * Get all schema mappings for a ClickHouse datasource
 */
export function getClickHouseSchemaMappings(
  datasourceId: string,
): Map<string, string> | undefined {
  return schemaMapping.get(datasourceId);
}

/**
 * Clear schema mappings for a datasource (useful for cleanup)
 */
export function clearClickHouseSchemaMapping(datasourceId: string): void {
  schemaMapping.delete(datasourceId);
}
