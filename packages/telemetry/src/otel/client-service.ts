// packages/telemetry/src/otel/client-service.ts

import type { OtelTelemetryManager } from './manager';
import type { Span } from '@opentelemetry/api';
import { createNoOpSpan } from './span-utils';

/**
 * Client-side wrapper for OpenTelemetry telemetry operations.
 * Provides a simplified API for capturing events and managing spans.
 */
export class OtelClientService {
  private telemetry: OtelTelemetryManager | null = null;

  constructor(telemetry?: OtelTelemetryManager) {
    if (telemetry) {
      this.telemetry = telemetry;
    }
  }

  setTelemetryManager(telemetry: OtelTelemetryManager): void {
    this.telemetry = telemetry;
  }

  getSessionId(): string {
    return this.telemetry?.getSessionId() || 'client-session';
  }

  trackCommand(
    command: string,
    args?: Record<string, unknown>,
    success?: boolean,
    durationMs?: number,
  ): void {
    if (this.telemetry) {
      const attributes: Record<string, unknown> = {
        'client.command': command,
      };
      if (args) {
        attributes['client.command.args'] = JSON.stringify(args);
      }
      if (durationMs !== undefined) {
        attributes['client.command.duration_ms'] = String(durationMs);
      }

      this.telemetry.captureEvent({
        name: success ? 'client.command.success' : 'client.command.error',
        attributes,
      });
    }
    // No-op if no telemetry manager (telemetry is disabled)
  }

  trackEvent(event: string, properties?: Record<string, unknown>): void {
    if (this.telemetry) {
      this.telemetry.captureEvent({
        name: event,
        attributes: properties,
      });
    }
    // No-op if no telemetry manager (telemetry is disabled)
  }

  trackMetric(
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    if (this.telemetry) {
      this.telemetry.captureEvent({
        name: 'client.metric',
        attributes: {
          'metric.name': name,
          'metric.value': String(value),
          ...attributes,
        },
      });
    }
    // No-op if no telemetry manager (telemetry is disabled)
  }

  captureEvent(event: { name: string; attributes?: Record<string, unknown> }) {
    if (this.telemetry) {
      this.telemetry.captureEvent({
        name: event.name,
        attributes: event.attributes,
      });
    }
    // No-op if no telemetry manager (telemetry is disabled)
  }

  /**
   * Start a span (delegates to telemetry manager)
   */
  startSpan(name: string, attributes?: Record<string, unknown>): Span {
    if (this.telemetry) {
      return this.telemetry.startSpan(name, attributes);
    }
    // Return a no-op span if no telemetry manager
    return createNoOpSpan();
  }

  /**
   * End a span (delegates to telemetry manager)
   */
  endSpan(span: Span, success = true): void {
    if (this.telemetry) {
      this.telemetry.endSpan(span, success);
    } else {
      span.end();
    }
  }
}
