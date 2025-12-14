'use client';

import * as React from 'react';
import { Database, Table2, FileText, BarChart3 } from 'lucide-react';
import { CodeBlock, CodeBlockCopyButton } from '../../ai-elements/code-block';
import { Button } from '../../shadcn/button';
import { cn } from '../../lib/utils';
import { DataGrid } from './data-grid';

export interface SQLQueryResult {
  result: {
    columns: string[];
    rows: Array<Record<string, unknown>>;
  };
}

export interface SQLQueryVisualizerProps {
  query?: string;
  result?: SQLQueryResult;
  className?: string;
  onPasteToNotebook?: () => void;
  showPasteButton?: boolean;
  chartExecutionOverride?: boolean;
}

/**
 * Specialized component for visualizing SQL queries and their results in the chat interface
 */
export function SQLQueryVisualizer({
  query,
  result,
  className,
  onPasteToNotebook,
  showPasteButton = false,
  chartExecutionOverride = false,
}: SQLQueryVisualizerProps) {
  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-md border text-sm',
        className,
      )}
    >
      {/* SQL Query Section */}
      {query && (
        <div className="bg-muted/10">
          <div className="bg-muted/20 flex items-center justify-between border-b px-3 py-2">
            <div className="flex items-center gap-2">
              <Database className="text-muted-foreground h-3.5 w-3.5" />
              <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                SQL
              </span>
              {chartExecutionOverride && (
                <div className="ml-2 flex items-center gap-1.5 rounded-sm border border-blue-500/20 bg-blue-500/10 px-2 py-0.5">
                  <BarChart3 className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                  <span className="text-[10px] font-medium tracking-wide text-blue-600 uppercase dark:text-blue-400">
                    Chart Mode
                  </span>
                </div>
              )}
            </div>
            {showPasteButton && onPasteToNotebook && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPasteToNotebook}
                className="h-7 gap-1.5 text-xs"
              >
                <FileText className="h-3.5 w-3.5" />
                Paste to Notebook
              </Button>
            )}
          </div>
          <div className="relative min-w-0 overflow-hidden">
            <CodeBlock
              code={query}
              language="sql"
              className="[&_pre]:overflow-wrap-anywhere [&_code]:overflow-wrap-anywhere rounded-none border-0 bg-transparent [&_code]:break-words [&_code]:whitespace-pre-wrap [&_pre]:overflow-x-hidden [&_pre]:break-words [&_pre]:whitespace-pre-wrap [&>div]:min-w-0 [&>div]:overflow-x-hidden"
            >
              <CodeBlockCopyButton className="text-muted-foreground hover:text-foreground" />
            </CodeBlock>
          </div>
        </div>
      )}

      {/* Query Results Section - Only show if we have columns (implies execution success) */}
      {result && result.result && (
        <div className="mt-[-1px] flex flex-col border-t">
          <div className="bg-muted/20 flex items-center justify-between border-b px-3 py-2">
            <div className="text-muted-foreground flex items-center gap-2">
              <Table2 className="h-3.5 w-3.5" />
              <span className="text-xs font-medium tracking-wider uppercase">
                Result
              </span>
            </div>
            <span className="text-muted-foreground bg-muted/50 rounded-sm px-1.5 py-0.5 text-[10px]">
              {result.result.rows.length} rows
            </span>
          </div>
          <div className="p-0">
            <DataGrid
              columns={result.result.columns}
              rows={result.result.rows}
              pageSize={10}
              className="rounded-none border-0 shadow-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
