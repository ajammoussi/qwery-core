'use client';

import * as React from 'react';
import { cn } from '../../../lib/utils';
import { BarChart3, TrendingUp, PieChart as PieChartIcon, Sparkles, Check } from 'lucide-react';

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartTypeSelection {
  chartType: ChartType;
  reasoning: string;
}

export interface ChartTypeCard {
  type: ChartType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
}

const CHART_TYPE_CARDS: ChartTypeCard[] = [
  {
    type: 'bar',
    label: 'Bar Chart',
    description: 'Best for comparing categories',
    icon: BarChart3,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  {
    type: 'line',
    label: 'Line Chart',
    description: 'Best for trends over time',
    icon: TrendingUp,
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
  },
  {
    type: 'pie',
    label: 'Pie Chart',
    description: 'Best for part-to-whole',
    icon: PieChartIcon,
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
  },
];

export interface ChartTypeSelectorProps {
  selection: ChartTypeSelection;
  className?: string;
}

/**
 * Displays chart type selection with cards showing all supported types
 * Highlights the selected chart type with a premium UI
 */
export function ChartTypeSelector({
  selection,
  className,
}: ChartTypeSelectorProps) {
  const selectedType = selection.chartType;

  return (
    <div className={cn('space-y-4', className)}>
      {/* AI Reasoning Section */}
      <div className="relative overflow-hidden rounded-xl border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <div className="bg-background flex size-8 shrink-0 items-center justify-center rounded-lg border shadow-sm">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-medium text-foreground">
              AI Recommendation
            </h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {selection.reasoning}
            </p>
          </div>
        </div>
      </div>

      {/* Chart Type Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {CHART_TYPE_CARDS.map((card) => {
          const isSelected = card.type === selectedType;
          const Icon = card.icon;

          return (
            <div
              key={card.type}
              className={cn(
                'group relative flex flex-col rounded-xl border p-4 transition-all duration-200',
                isSelected
                  ? 'border-primary bg-background ring-1 ring-primary'
                  : 'border-border bg-card/50 hover:border-sidebar-accent hover:bg-sidebar-accent/50',
              )}
            >
              {/* Card Header & Icon */}
              <div className="flex items-start justify-between mb-3">
                <div
                  className={cn(
                    'flex size-10 items-center justify-center rounded-lg transition-colors duration-200',
                    isSelected ? card.bgColor : 'bg-muted',
                  )}
                >
                  <Icon className={cn('h-5 w-5', isSelected ? card.color : 'text-muted-foreground')} />
                </div>
                {isSelected && (
                  <div className="flex items-center justify-center size-5 bg-primary rounded-full shadow-sm animate-in fade-in zoom-in duration-300">
                    <Check className="size-3 text-primary-foreground stroke-[3]" />
                  </div>
                )}
              </div>

              {/* Card Content */}
              <div className="space-y-1">
                <h5
                  className={cn(
                    'text-sm font-medium tracking-tight transition-colors',
                    isSelected ? 'text-foreground' : 'text-foreground/80'
                  )}
                >
                  {card.label}
                </h5>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {card.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
