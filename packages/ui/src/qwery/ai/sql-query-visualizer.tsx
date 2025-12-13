'use client';

import * as React from 'react';
import { Database, Play, Table2 } from 'lucide-react';
import { CodeBlock, CodeBlockCopyButton } from '../../ai-elements/code-block';
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
}

/**
 * Specialized component for visualizing SQL queries and their results in the chat interface
 */
export function SQLQueryVisualizer({
  query,
  result,
  className,
}: SQLQueryVisualizerProps) {
  return (
    <div className={cn('flex flex-col rounded-md border text-sm overflow-hidden', className)}>
      {/* SQL Query Section */}
      {query && (
        <div className="bg-muted/10">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Database className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">SQL</span>
            </div>
          </div>
          <div className="relative">
            <CodeBlock
              code={query}
              language="sql"
              className="border-0 rounded-none bg-transparent"
            >
              <CodeBlockCopyButton className="text-muted-foreground hover:text-foreground" />
            </CodeBlock>
          </div>
        </div>
      )}

      {/* Query Results Section - Only show if we have columns (implies execution success) */}
      {result && result.result && (
        <div className="flex flex-col border-t mt-[-1px]">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Table2 className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">Result</span>
            </div>
            <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm">
              {result.result.rows.length} rows
            </span>
          </div>
          <div className="p-0">
            <DataGrid
              columns={result.result.columns}
              rows={result.result.rows}
              pageSize={10}
              className="border-0 rounded-none shadow-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
