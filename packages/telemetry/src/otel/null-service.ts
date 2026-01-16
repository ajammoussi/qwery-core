/**
 * Null OpenTelemetry Telemetry Service
 *
 * No-op implementation of OpenTelemetry manager interface for testing or opt-out scenarios.
 * All methods exist but perform no operations.
 *
 * Note: This is different from `NullTelemetryService` in `null-telemetry-service.ts`,
 * which implements the generic `TelemetryService` interface.
 */

import type { Span } from '@opentelemetry/api';
import { OtelClientService } from './client-service';
import { createNoOpSpan } from './span-utils';

export class OtelNullTelemetryService {
  private sessionId: string = 'null-session';
  /**
   * Client service (no-op implementation)
   */
  clientService: OtelClientService;

  constructor() {
    // Initialize clientService without a telemetry manager (it will use no-op behavior)
    // Passing undefined ensures it doesn't try to use any telemetry methods
    this.clientService = new OtelClientService(undefined);
  }

  /**
   * Get session ID (returns a dummy value)
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Initialize (no-op)
   */
  async init(): Promise<void> {
    // No-op
  }

  /**
   * Shutdown (no-op)
   */
  async shutdown(): Promise<void> {
    // No-op
  }

  /**
   * Start span (returns a no-op span)
   */
  startSpan(_name: string, _attributes?: Record<string, unknown>): Span {
    return createNoOpSpan();
  }

  /**
   * End span (no-op)
   */
  endSpan(_span: Span, _success: boolean): void {
    // No-op
  }

  /**
   * Capture event (no-op)
   */
  captureEvent(_options: {
    name: string;
    attributes?: Record<string, unknown>;
  }): void {
    // No-op
  }

  /**
   * Record command duration (no-op)
   */
  recordCommandDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record command count (no-op)
   */
  recordCommandCount(
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record command error (no-op)
   */
  recordCommandError(
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record command success (no-op)
   */
  recordCommandSuccess(
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record token usage (no-op)
   */
  recordTokenUsage(
    _promptTokens: number,
    _completionTokens: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record query duration (no-op)
   */
  recordQueryDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record query count (no-op)
   */
  recordQueryCount(
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record query rows returned (no-op)
   */
  recordQueryRowsReturned(
    _rowCount: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record message duration (no-op)
   */
  recordMessageDuration(
    _durationMs: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Record agent token usage (no-op)
   */
  recordAgentTokenUsage(
    _promptTokens: number,
    _completionTokens: number,
    _attributes?: Record<string, string | number | boolean>,
  ): void {
    // No-op
  }

  /**
   * Start span with links (returns a no-op span)
   */
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

/**
 * Create a null OpenTelemetry telemetry service instance
 */
export function createOtelNullTelemetryService(): OtelNullTelemetryService {
  return new OtelNullTelemetryService();
}

// Note: We do NOT export an alias as "NullTelemetryService" to avoid confusion
// with the generic NullTelemetryService from null-telemetry-service.ts
// Use OtelNullTelemetryService or createOtelNullTelemetryService() instead
