export type RepositoryFindOptions = {
  limit?: number;
  offset?: number;
  order?: string;
};

export interface PaginationOptions {
  cursor: string | null; // ISO timestamp string
  limit: number; // Default: 20
  direction: 'before'; // Only 'before' needed (unidirectional)
}

export interface PaginatedResult<T> {
  messages: T[];
  nextCursor: string | null; // ISO timestamp of oldest message in result
  hasMore: boolean;
}
