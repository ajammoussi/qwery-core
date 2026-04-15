// Benchmark runtime shim for @qwery/domain/entities.
// Only MessageRole is required at runtime by SDK imports used in benchmark execution.
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}
