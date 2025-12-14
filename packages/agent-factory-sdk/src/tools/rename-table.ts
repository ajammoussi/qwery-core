import type { AbstractQueryEngine } from '@qwery/domain/ports';

export interface RenameTableOptions {
  oldTableName: string;
  newTableName: string;
  queryEngine: AbstractQueryEngine;
}

export interface RenameTableResult {
  oldTableName: string;
  newTableName: string;
  message: string;
}

export const renameTable = async (
  opts: RenameTableOptions,
): Promise<RenameTableResult> => {
  const { oldTableName, newTableName, queryEngine } = opts;

  // Validate inputs
  if (!oldTableName || !newTableName) {
    throw new Error('Both oldTableName and newTableName are required');
  }

  if (oldTableName === newTableName) {
    throw new Error('Old and new table names cannot be the same');
  }

  if (!queryEngine) {
    throw new Error('Query engine is required');
  }

  const escapedOldName = oldTableName.replace(/"/g, '""');
  const escapedNewName = newTableName.replace(/"/g, '""');

  // Check if old view exists
  try {
    await queryEngine.query(`SELECT 1 FROM "${escapedOldName}" LIMIT 1`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      errorMsg.includes('does not exist') ||
      errorMsg.includes('not found') ||
      errorMsg.includes('Catalog Error')
    ) {
      throw new Error(
        `Table/view "${oldTableName}" does not exist. Cannot rename.`,
      );
    }
    throw error;
  }

  // Check if new name already exists
  try {
    await queryEngine.query(`SELECT 1 FROM "${escapedNewName}" LIMIT 1`);
    throw new Error(
      `Table/view "${newTableName}" already exists. Cannot rename to an existing name.`,
    );
  } catch (error) {
    // If error is about table not found, that's good - name is available
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      !errorMsg.includes('does not exist') &&
      !errorMsg.includes('not found') &&
      !errorMsg.includes('Catalog Error') &&
      !errorMsg.includes('already exists')
    ) {
      // Some other error occurred, rethrow
      throw error;
    }
    // If it's "already exists", rethrow that specific error
    if (errorMsg.includes('already exists')) {
      throw error;
    }
  }

  // Rename the view using ALTER VIEW
  await queryEngine.query(
    `ALTER VIEW "${escapedOldName}" RENAME TO "${escapedNewName}"`,
  );

  return {
    oldTableName,
    newTableName,
    message: `Successfully renamed table/view "${oldTableName}" to "${newTableName}"`,
  };
};
