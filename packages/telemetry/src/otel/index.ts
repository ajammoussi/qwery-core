// Main exports for @qwery/telemetry/otel

// Core services
// Only export TelemetryManager as the public API
// OtelTelemetryManager is internal and should not be used directly
export { TelemetryManager, type TelemetryManagerOptions } from './manager';
// Export OtelTelemetryManagerOptions as type-only for internal use
export type { OtelTelemetryManagerOptions } from './manager';
export { OtelClientService } from './client-service';
// Export alias for backward compatibility
export { OtelClientService as ClientTelemetryService } from './client-service';
export {
  FilteringSpanExporter,
  type FilteringSpanExporterOptions,
} from './filtering-exporter';
export {
  OtelNullTelemetryService,
  createOtelNullTelemetryService,
} from './null-service';

// Telemetry utilities (generic, works for CLI, web, desktop)
export {
  withActionSpan,
  createActionAttributes,
  parseActionName,
  recordQueryMetrics,
  recordTokenUsage,
  type ActionContext,
  type WorkspaceContext,
} from './utils';

// React context for web/desktop apps
export {
  OtelTelemetryProvider,
  TelemetryProvider,
  useOtelTelemetry,
  useTelemetry,
  withOtelTelemetryContext,
  withTelemetryContext,
  type OtelTelemetryContextValue,
  type TelemetryContextValue,
  type OtelTelemetryProviderProps,
  type TelemetryProviderProps,
} from './context';

// Agent telemetry helpers
export {
  createConversationAttributes,
  createMessageAttributes,
  createActorAttributes,
  endMessageSpanWithEvent,
  endConversationSpanWithEvent,
  endActorSpanWithEvent,
  withActorTelemetry,
} from './agent-helpers';
