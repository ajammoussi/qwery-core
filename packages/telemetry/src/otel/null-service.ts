import type { Span } from '@opentelemetry/api';
import { OtelClientService } from './client-service';
import { createNoOpSpan } from './span-utils';

export class OtelNullTelemetryService {
  private sessionId: string = 'null-session';

  clientService: OtelClientService;

  constructor() {
    this.clientService = new OtelClientService(undefined);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async init(): Promise<void> {}

  async shutdown(): Promise<void> {}

  startSpan(_name: string, _attributes?: Record<string, unknown>): Span {
    return createNoOpSpan();
  }

  endSpan(_span: Span, _success: boolean): void {}

  captureEvent(_options: {
    name: string;
    attributes?: Record<string, unknown>;
  }): void {}

  recordCommandDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordCommandCount(
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordCommandError(
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordCommandSuccess(
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordTokenUsage(
    _promptTokens: number,
    _completionTokens: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordQueryDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordQueryCount(
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordQueryRowsReturned(
    _rowCount: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordMessageDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  recordAgentTokenUsage(
    _promptTokens: number,
    _completionTokens: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  startSpanWithLinks(
    _name: string,
    _attributes?: Record<string, unknown>,
    _parentSpanContexts?: Array<{
      context: import('@opentelemetry/api').SpanContext;
      attributes?: Record<string, string | number | boolean>;
    }>,
  ): Span {
    return createNoOpSpan();
  }
}

export function createOtelNullTelemetryService(): OtelNullTelemetryService {
  return new OtelNullTelemetryService();
}
