// Benchmark runtime shim for @qwery/domain/entities.
// Only MessageRole and DatasourceKind are required at runtime by benchmark execution.
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum DatasourceKind {
  EMBEDDED = 'embedded',
  REMOTE = 'remote',
}
