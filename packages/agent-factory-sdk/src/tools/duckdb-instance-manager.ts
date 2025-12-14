import type { DuckDBInstance } from '@duckdb/node-api';
import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { loadDatasources, groupDatasourcesByType } from './datasource-loader';
import { attachForeignDatasource } from './foreign-datasource-attach';
import { attachGSheetDatasource } from './gsheet-to-duckdb';
import { datasourceToDuckdb } from './datasource-to-duckdb';
import { getDatasourceDatabaseName } from './datasource-name-utils';
import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

export interface DuckDBInstanceWrapper {
  instance: DuckDBInstance;
  connectionPool: Connection[];
  attachedDatasources: Set<string>; // datasource IDs
  viewRegistry: Map<string, string>; // datasourceId -> viewName
  dbPath: string;
  maxConnections: number;
  activeConnections: number;
  // Schema caching (OPTIMIZATION: Phase 4.2)
  schemaCache: Map<string, SimpleSchema>; // viewName -> schema
  schemaCacheTimestamp: Map<string, number>; // viewName -> timestamp
  lastSyncTimestamp: number;
  lastSyncedDatasourceIds: string[];
}

export interface GetInstanceOptions {
  conversationId: string;
  workspace: string;
  createIfNotExists?: boolean;
}

/**
 * Central DuckDB instance manager
 * Maintains a single persistent DuckDB instance per conversation
 * with connection pooling to avoid race conditions
 */
class DuckDBInstanceManager {
  private instances: Map<string, DuckDBInstanceWrapper> = new Map();
  private readonly maxConnectionsPerInstance = 2; // Start with 2, scale if needed

  /**
   * Get or create a DuckDB instance for a conversation
   */
  async getInstance(opts: GetInstanceOptions): Promise<DuckDBInstanceWrapper> {
    const { conversationId, workspace, createIfNotExists = true } = opts;

    const key = `${workspace}:${conversationId}`;

    // Return existing instance if available
    if (this.instances.has(key)) {
      return this.instances.get(key)!;
    }

    if (!createIfNotExists) {
      throw new Error(
        `DuckDB instance not found for conversation ${conversationId}`,
      );
    }

    // Create new instance
    const { join } = await import('node:path');
    const { mkdir } = await import('node:fs/promises');

    const fileDir = join(workspace, conversationId);
    await mkdir(fileDir, { recursive: true });
    const dbPath = join(fileDir, 'database.db');

    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(dbPath);

    const wrapper: DuckDBInstanceWrapper = {
      instance,
      connectionPool: [],
      attachedDatasources: new Set(),
      viewRegistry: new Map(),
      dbPath,
      maxConnections: this.maxConnectionsPerInstance,
      activeConnections: 0,
      schemaCache: new Map(),
      schemaCacheTimestamp: new Map(),
      lastSyncTimestamp: 0,
      lastSyncedDatasourceIds: [],
    };

    this.instances.set(key, wrapper);
    console.log(
      `[DuckDBInstanceManager] Created instance for conversation ${conversationId}`,
    );

    return wrapper;
  }

  /**
   * Get the wrapper for a conversation (for accessing viewRegistry, etc.)
   * Returns null if instance doesn't exist
   */
  getWrapper(
    conversationId: string,
    workspace: string,
  ): DuckDBInstanceWrapper | null {
    const key = `${workspace}:${conversationId}`;
    return this.instances.get(key) || null;
  }

  /**
   * Reset sync cache for a conversation to force re-sync on next syncDatasources call
   * This is useful when datasources change and we need to ensure a fresh sync
   */
  resetSyncCache(conversationId: string, workspace: string): void {
    const wrapper = this.getWrapper(conversationId, workspace);
    if (wrapper) {
      wrapper.lastSyncTimestamp = 0;
      wrapper.lastSyncedDatasourceIds = [];
      console.log(
        `[DuckDBInstanceManager] Reset sync cache for conversation ${conversationId}`,
      );
    }
  }

  /**
   * Get a connection from the pool (or create one if pool is empty)
   */
  async getConnection(
    conversationId: string,
    workspace: string,
  ): Promise<Connection> {
    const wrapper = await this.getInstance({
      conversationId,
      workspace,
      createIfNotExists: true,
    });

    // Return connection from pool if available
    if (wrapper.connectionPool.length > 0) {
      const conn = wrapper.connectionPool.pop()!;
      wrapper.activeConnections++;
      return conn;
    }

    // Create new connection if pool is empty and under limit
    if (wrapper.activeConnections < wrapper.maxConnections) {
      const conn = await wrapper.instance.connect();
      wrapper.activeConnections++;
      return conn;
    }

    // Wait for a connection to become available (simple retry)
    // In production, you might want a proper queue here
    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.getConnection(conversationId, workspace);
  }

  /**
   * Return a connection to the pool
   */
  returnConnection(
    conversationId: string,
    workspace: string,
    connection: Connection,
  ): void {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);

    if (!wrapper) {
      // If instance doesn't exist, just close the connection
      connection.closeSync();
      return;
    }

    // Return to pool
    wrapper.connectionPool.push(connection);
    wrapper.activeConnections--;

    if (wrapper.activeConnections < 0) {
      wrapper.activeConnections = 0;
    }
  }

  /**
   * Get cached schema for a view (OPTIMIZATION: Phase 4.2)
   */
  getCachedSchema(
    conversationId: string,
    workspace: string,
    viewName: string,
    maxAge: number = 60000, // 60 seconds default
  ): SimpleSchema | null {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);
    if (!wrapper) return null;

    const timestamp = wrapper.schemaCacheTimestamp.get(viewName);
    if (!timestamp) return null;

    if (Date.now() - timestamp > maxAge) {
      // Cache expired
      wrapper.schemaCache.delete(viewName);
      wrapper.schemaCacheTimestamp.delete(viewName);
      return null;
    }

    return wrapper.schemaCache.get(viewName) || null;
  }

  /**
   * Cache schema for a view (OPTIMIZATION: Phase 4.2)
   */
  cacheSchema(
    conversationId: string,
    workspace: string,
    viewName: string,
    schema: SimpleSchema,
  ): void {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);
    if (!wrapper) return;

    wrapper.schemaCache.set(viewName, schema);
    wrapper.schemaCacheTimestamp.set(viewName, Date.now());
  }

  /**
   * Sync datasources based on checked state from UI
   * Attaches/detaches foreign DBs and creates/drops views
   * (OPTIMIZATION: Phase 5.1 - Smart sync detection)
   */
  async syncDatasources(
    conversationId: string,
    workspace: string,
    checkedDatasourceIds: string[],
    datasourceRepository: IDatasourceRepository,
    detachUnchecked: boolean = true, // OPTIMIZATION: Phase 5.2
  ): Promise<void> {
    const startTime = performance.now();
    console.log(
      `[DuckDBInstanceManager] Syncing ${checkedDatasourceIds.length} datasource(s) for conversation ${conversationId}`,
    );

    const wrapper = await this.getInstance({
      conversationId,
      workspace,
      createIfNotExists: true,
    });

    // Smart sync detection (OPTIMIZATION: Phase 5.1)
    const datasourceIdsMatch =
      wrapper.lastSyncedDatasourceIds.length === checkedDatasourceIds.length &&
      wrapper.lastSyncedDatasourceIds.every((id) =>
        checkedDatasourceIds.includes(id),
      ) &&
      checkedDatasourceIds.every((id) =>
        wrapper.lastSyncedDatasourceIds.includes(id),
      );

    const recentlySynced = Date.now() - wrapper.lastSyncTimestamp < 5000; // 5 second cache

    if (datasourceIdsMatch && recentlySynced) {
      console.log(
        `[DuckDBInstanceManager] [PERF] Skipping sync - no changes detected (last sync ${((Date.now() - wrapper.lastSyncTimestamp) / 1000).toFixed(2)}s ago)`,
      );
      return; // No sync needed
    }

    const conn = await this.getConnection(conversationId, workspace);

    // Declare timing variables outside try block for use in finally
    let loadTime = 0;
    let detachTime = 0;
    let attachTime = 0;
    let viewTime = 0;

    try {
      const checkedSet = new Set(checkedDatasourceIds);
      const currentAttached = wrapper.attachedDatasources;
      const currentViews = wrapper.viewRegistry;

      // REMOVE: Verbose state logging - only log if needed for debugging

      // Load all datasources to get their types
      const allDatasourceIds = Array.from(
        new Set([
          ...checkedDatasourceIds,
          ...currentAttached,
          ...currentViews.keys(),
        ]),
      );
      const loadStartTime = performance.now();
      const loaded = await loadDatasources(
        allDatasourceIds,
        datasourceRepository,
      );
      loadTime = performance.now() - loadStartTime;
      console.log(
        `[DuckDBInstanceManager] [PERF] loadDatasources took ${loadTime.toFixed(2)}ms (${allDatasourceIds.length} datasources)`,
      );
      const { duckdbNative, foreignDatabases } = groupDatasourcesByType(loaded);

      // Separate Google Sheets from other foreign databases
      const gsheetDatasources = foreignDatabases.filter(
        (ds) => ds.datasource.datasource_provider === 'gsheet-csv',
      );
      const otherForeignDatabases = foreignDatabases.filter(
        (ds) => ds.datasource.datasource_provider !== 'gsheet-csv',
      );

      // Detach unchecked foreign databases (OPTIMIZATION: Phase 5.2 - only if detachUnchecked is true)
      const detachStartTime = performance.now();
      let detachCount = 0;
      if (detachUnchecked) {
        // Detach Google Sheets
        for (const { datasource } of gsheetDatasources) {
          const dsId = datasource.id;
          if (currentAttached.has(dsId) && !checkedSet.has(dsId)) {
            const detachItemStartTime = performance.now();
            console.log(
              `[DuckDBInstanceManager] Detaching Google Sheets datasource: ${dsId}`,
            );
            await this.detachForeignDB(conn, datasource);
            currentAttached.delete(dsId);
            const detachItemTime = performance.now() - detachItemStartTime;
            console.log(
              `[DuckDBInstanceManager] [PERF] Detached ${dsId} in ${detachItemTime.toFixed(2)}ms`,
            );
            detachCount++;
          }
        }
        // Detach other foreign databases
        for (const { datasource } of otherForeignDatabases) {
          const dsId = datasource.id;
          if (currentAttached.has(dsId) && !checkedSet.has(dsId)) {
            const detachItemStartTime = performance.now();
            console.log(
              `[DuckDBInstanceManager] Detaching datasource: ${dsId}`,
            );
            await this.detachForeignDB(conn, datasource);
            currentAttached.delete(dsId);
            const detachItemTime = performance.now() - detachItemStartTime;
            console.log(
              `[DuckDBInstanceManager] [PERF] Detached ${dsId} in ${detachItemTime.toFixed(2)}ms`,
            );
            detachCount++;
          }
        }
      }
      detachTime = performance.now() - detachStartTime;
      if (detachCount > 0) {
        console.log(
          `[DuckDBInstanceManager] [PERF] Detached ${detachCount} datasource(s) in ${detachTime.toFixed(2)}ms`,
        );
      } else if (detachUnchecked) {
        console.log(
          `[DuckDBInstanceManager] [PERF] No datasources to detach (took ${detachTime.toFixed(2)}ms)`,
        );
      }

      // Drop views for unchecked DuckDB-native datasources
      for (const [dsId, viewName] of currentViews.entries()) {
        if (!checkedSet.has(dsId)) {
          try {
            const escapedViewName = viewName.replace(/"/g, '""');
            await conn.run(`DROP VIEW IF EXISTS "${escapedViewName}"`);
            currentViews.delete(dsId);
            console.log(
              `[DuckDBInstanceManager] Dropped view: ${viewName} (datasource: ${dsId})`,
            );
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.warn(
              `[DuckDBInstanceManager] Failed to drop view ${viewName}: ${errorMsg}`,
            );
          }
        }
      }

      // Attach newly checked foreign databases
      const attachStartTime = performance.now();
      let attachCount = 0;
      // Attach Google Sheets
      for (const { datasource } of gsheetDatasources) {
        const dsId = datasource.id;
        if (!currentAttached.has(dsId) && checkedSet.has(dsId)) {
          try {
            const attachItemStartTime = performance.now();
            console.log(
              `[DuckDBInstanceManager] Attaching Google Sheets datasource: ${dsId}`,
            );
            await attachGSheetDatasource({
              connection: conn,
              datasource,
              extractSchema: true, // Need schema to generate semantic table names
              conversationId,
              workspace,
            });
            currentAttached.add(dsId);
            const attachItemTime = performance.now() - attachItemStartTime;
            console.log(
              `[DuckDBInstanceManager] [PERF] Attached ${dsId} in ${attachItemTime.toFixed(2)}ms`,
            );
            attachCount++;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[DuckDBInstanceManager] Failed to attach Google Sheets datasource ${dsId}: ${errorMsg}`,
            );
          }
        }
      }
      // Attach other foreign databases
      for (const { datasource } of otherForeignDatabases) {
        const dsId = datasource.id;
        if (!currentAttached.has(dsId) && checkedSet.has(dsId)) {
          try {
            const attachItemStartTime = performance.now();
            console.log(
              `[DuckDBInstanceManager] Attaching datasource: ${dsId}`,
            );
            await attachForeignDatasource({
              connection: conn,
              datasource,
            });
            currentAttached.add(dsId);
            const attachItemTime = performance.now() - attachItemStartTime;
            console.log(
              `[DuckDBInstanceManager] [PERF] Attached ${dsId} in ${attachItemTime.toFixed(2)}ms`,
            );
            attachCount++;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[DuckDBInstanceManager] Failed to attach datasource ${dsId}: ${errorMsg}`,
            );
          }
        }
      }
      attachTime = performance.now() - attachStartTime;
      if (attachCount > 0) {
        console.log(
          `[DuckDBInstanceManager] [PERF] Attached ${attachCount} datasource(s) in ${attachTime.toFixed(2)}ms`,
        );
      }

      // Create views for newly checked DuckDB-native datasources
      const viewStartTime = performance.now();
      let viewCount = 0;
      for (const { datasource } of duckdbNative) {
        const dsId = datasource.id;
        if (!currentViews.has(dsId) && checkedSet.has(dsId)) {
          try {
            const viewItemStartTime = performance.now();
            const result = await datasourceToDuckdb({
              connection: conn,
              datasource,
            });
            currentViews.set(dsId, result.viewName);
            const viewItemTime = performance.now() - viewItemStartTime;
            console.log(
              `[DuckDBInstanceManager] [PERF] Created view ${result.viewName} (${dsId}) in ${viewItemTime.toFixed(2)}ms`,
            );
            viewCount++;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[DuckDBInstanceManager] Failed to create view for datasource ${dsId}: ${errorMsg}`,
            );
          }
        }
      }
      viewTime = performance.now() - viewStartTime;
      if (viewCount > 0) {
        console.log(
          `[DuckDBInstanceManager] [PERF] Created ${viewCount} view(s) in ${viewTime.toFixed(2)}ms`,
        );
      }

      // Update state after sync (OPTIMIZATION: Phase 5.1)
      wrapper.lastSyncTimestamp = Date.now();
      wrapper.lastSyncedDatasourceIds = [...checkedDatasourceIds];
    } finally {
      this.returnConnection(conversationId, workspace, conn);
    }
    const totalTime = performance.now() - startTime;
    console.log(
      `[DuckDBInstanceManager] [PERF] syncDatasources TOTAL took ${totalTime.toFixed(2)}ms (load: ${loadTime.toFixed(2)}ms, detach: ${detachTime.toFixed(2)}ms, attach: ${attachTime.toFixed(2)}ms, views: ${viewTime.toFixed(2)}ms)`,
    );
  }

  /**
   * Detach a foreign database
   * Note: DuckDB doesn't support IF EXISTS with DETACH, so we catch errors
   */
  private async detachForeignDB(
    conn: Connection,
    datasource: Datasource,
  ): Promise<void> {
    const attachedDatabaseName = getDatasourceDatabaseName(datasource);
    const escapedDbName = attachedDatabaseName.replace(/"/g, '""');

    try {
      // DuckDB doesn't support DETACH IF EXISTS, so we just try to detach
      // and catch errors if it doesn't exist
      await conn.run(`DETACH "${escapedDbName}"`);
      console.log(
        `[DuckDBInstanceManager] Successfully detached ${attachedDatabaseName}`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // If already detached or doesn't exist, that's fine - just log
      if (
        errorMsg.includes('not found') ||
        errorMsg.includes('does not exist') ||
        errorMsg.includes('not attached')
      ) {
        console.debug(
          `[DuckDBInstanceManager] ${attachedDatabaseName} already detached or doesn't exist`,
        );
      } else {
        // Log other errors as warnings
        console.warn(
          `[DuckDBInstanceManager] Failed to detach ${attachedDatabaseName}: ${errorMsg}`,
        );
      }
    }
  }

  /**
   * Close a specific instance
   */
  async closeInstance(
    conversationId: string,
    workspace: string,
  ): Promise<void> {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);

    if (!wrapper) {
      return;
    }

    // Close all connections in pool
    for (const conn of wrapper.connectionPool) {
      try {
        conn.closeSync();
      } catch (error) {
        console.warn(
          `[DuckDBInstanceManager] Error closing connection: ${error}`,
        );
      }
    }

    // Close instance
    try {
      wrapper.instance.closeSync();
    } catch (error) {
      console.warn(`[DuckDBInstanceManager] Error closing instance: ${error}`);
    }

    this.instances.delete(key);
    console.log(
      `[DuckDBInstanceManager] Closed instance for conversation ${conversationId}`,
    );
  }

  /**
   * Close all instances
   */
  async closeAll(): Promise<void> {
    const keys = Array.from(this.instances.keys());

    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const workspace = parts[0];
        const conversationId = parts.slice(1).join(':'); // Handle workspace paths with colons
        if (workspace && conversationId) {
          await this.closeInstance(conversationId, workspace);
        }
      }
    }

    console.log('[DuckDBInstanceManager] Closed all instances');
  }
}

// Singleton instance
const instanceManager = new DuckDBInstanceManager();
export { instanceManager as DuckDBInstanceManager };
