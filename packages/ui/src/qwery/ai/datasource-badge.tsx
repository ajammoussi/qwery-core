'use client';

import { useState } from 'react';
import { Database, ChevronLeft, ChevronRight } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../shadcn/hover-card';
import { Button } from '../../shadcn/button';
import { cn } from '../../lib/utils';
import type { DatasourceItem } from './datasource-selector';

export type { DatasourceItem };

const ITEMS_PER_PAGE = 5;

export interface DatasourceBadgeProps {
    datasource: DatasourceItem;
    iconUrl?: string;
    className?: string;
}

export function DatasourceBadge({
    datasource,
    iconUrl,
    className,
}: DatasourceBadgeProps) {
    return (
        <HoverCard>
            <HoverCardTrigger asChild>
                <div
                    className={cn(
                        'group flex h-6 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 text-xs transition-colors hover:bg-muted cursor-default',
                        className,
                    )}
                >
                    {iconUrl ? (
                        <img
                            src={iconUrl}
                            alt={datasource.name}
                            className="h-3.5 w-3.5 shrink-0 object-contain"
                        />
                    ) : (
                        <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-xs font-medium">{datasource.name}</span>
                </div>
            </HoverCardTrigger>
            <HoverCardContent className="w-72 p-4" side="top">
                <div className="flex gap-4">
                    {/* Header with icon and name */}
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                            {iconUrl ? (
                                <img
                                    src={iconUrl}
                                    alt={datasource.name}
                                    className="h-6 w-6 object-contain"
                                />
                            ) : (
                                <Database className="h-5 w-5 text-muted-foreground" />
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-semibold leading-tight truncate">
                                {datasource.name}
                            </h4>
                            {datasource.slug && (
                                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                    {datasource.slug}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Details */}
                    {datasource.datasource_provider && (
                        <div>
                            <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/50 border border-border">
                                <span className="text-xs font-medium capitalize">
                                    {datasource.datasource_provider.replace(/_/g, ' ')}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}

export interface DatasourceBadgesProps {
    datasources: DatasourceItem[];
    pluginLogoMap?: Map<string, string>;
    className?: string;
}

export function DatasourceBadges({
    datasources,
    pluginLogoMap,
    className,
}: DatasourceBadgesProps) {
    if (!datasources || datasources.length === 0) {
        return null;
    }

    // If single datasource, show it normally
    if (datasources.length === 1) {
        const datasource = datasources[0];
        if (!datasource) {
            return null;
        }
        const iconUrl = pluginLogoMap?.get(datasource.datasource_provider);
        return (
            <div className={cn('mb-2', className)}>
                <DatasourceBadge
                    datasource={datasource}
                    iconUrl={iconUrl}
                />
            </div>
        );
    }

    // If multiple datasources, show placeholder badge with hover to see all
    return (
        <div className={cn('mb-2', className)}>
            <DatasourceBadgesHover datasources={datasources} pluginLogoMap={pluginLogoMap} />
        </div>
    );
}

function DatasourceBadgesHover({
    datasources,
    pluginLogoMap,
}: {
    datasources: DatasourceItem[];
    pluginLogoMap?: Map<string, string>;
}) {
    const [currentPage, setCurrentPage] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const totalPages = Math.ceil(datasources.length / ITEMS_PER_PAGE);
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const currentItems = datasources.slice(startIndex, endIndex);

    // Reset to first page when hover card closes
    const handleOpenChange = (open: boolean) => {
        setIsOpen(open);
        if (!open) {
            setCurrentPage(0);
        }
    };

    const handlePrevious = (e: React.MouseEvent) => {
        e.stopPropagation();
        setCurrentPage((prev) => Math.max(0, prev - 1));
    };

    const handleNext = (e: React.MouseEvent) => {
        e.stopPropagation();
        setCurrentPage((prev) => Math.min(totalPages - 1, prev + 1));
    };

    return (
        <HoverCard open={isOpen} onOpenChange={handleOpenChange}>
            <HoverCardTrigger asChild>
                <div className="group flex h-6 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 text-xs transition-colors hover:bg-muted cursor-default">
                    <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">
                        {datasources.length} datasources
                    </span>
                </div>
            </HoverCardTrigger>
            <HoverCardContent className="w-72 p-4" side="top">
                <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-semibold">Selected Datasources</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {datasources.length} {datasources.length === 1 ? 'datasource' : 'datasources'}
                            </p>
                        </div>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {currentPage + 1}/{totalPages}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="h-px bg-border" />

                    {/* Datasources List */}
                    <div className="space-y-1.5">
                        {currentItems.map((datasource) => {
                            const iconUrl = pluginLogoMap?.get(datasource.datasource_provider);
                            return (
                                <div
                                    key={datasource.id}
                                    className="flex items-center gap-2 p-2 rounded-md bg-muted/50 border border-border hover:bg-muted transition-colors"
                                >
                                    <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                                        {iconUrl ? (
                                            <img
                                                src={iconUrl}
                                                alt={datasource.name}
                                                className="h-5 w-5 object-contain"
                                            />
                                        ) : (
                                            <Database className="h-4 w-4 text-muted-foreground" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0 flex items-center justify-between gap-1.5 flex-wrap">
                                        <p className="text-xs font-medium truncate">
                                            {datasource.name}
                                        </p>
                                        {datasource.datasource_provider && (
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground capitalize">
                                                {datasource.datasource_provider.replace(/_/g, ' ')}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between gap-2 pt-2 border-t">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={handlePrevious}
                                disabled={currentPage === 0}
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </Button>
                            <span className="text-xs text-muted-foreground flex-1 text-center">
                                {startIndex + 1}-{Math.min(endIndex, datasources.length)} of{' '}
                                {datasources.length}
                            </span>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={handleNext}
                                disabled={currentPage >= totalPages - 1}
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}

