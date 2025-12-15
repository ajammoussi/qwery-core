import { useMemo } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../shadcn/select';
import type { SchemaGraphMetadata } from './types';

export interface SchemaSelectorProps {
  metadata: SchemaGraphMetadata | null | undefined;
  selectedSchemas: string[];
  onChange: (schemas: string[]) => void;
}

export const SchemaSelector = ({
  metadata,
  selectedSchemas,
  onChange,
}: SchemaSelectorProps) => {
  const schemas = useMemo(() => {
    if (!metadata?.schemas) return [];
    return Array.from(
      new Set(metadata.schemas.map((s: { name: string }) => s.name)),
    ).sort();
  }, [metadata]);

  if (schemas.length === 0) {
    return null;
  }

  const value =
    selectedSchemas.length === 0 || selectedSchemas.length === schemas.length
      ? 'all'
      : selectedSchemas[0];

  const handleChange = (next: string) => {
    if (next === 'all') {
      onChange(schemas as string[]);
      return;
    }
    onChange([next]);
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Filter by schema" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All schemas</SelectItem>
        {schemas.map((schema: string) => (
          <SelectItem key={schema} value={schema}>
            {schema}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
