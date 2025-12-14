/**
 * Notebook cell type for agent context.
 * Used to distinguish between code cells (query) and prompt cells when handling inline prompts.
 *
 * - 'query': Code cell (Ctrl+K popup) - SQL should be pasted directly into the cell
 * - 'prompt': Prompt cell - SQL should be pasted into a new code cell below
 */
export const NOTEBOOK_CELL_TYPE = {
  QUERY: 'query',
  PROMPT: 'prompt',
} as const;

export type NotebookCellType =
  (typeof NOTEBOOK_CELL_TYPE)[keyof typeof NOTEBOOK_CELL_TYPE];
