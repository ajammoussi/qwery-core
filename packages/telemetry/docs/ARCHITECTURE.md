# Telemetry Package Architecture

## Overview

The `@qwery/telemetry` package provides a unified telemetry system supporting multiple backends:
- **OpenTelemetry (OTel)** - Observability (spans, metrics, traces)
- **PostHog** - Product analytics (events, user tracking)
- **Sentry** - Error tracking (errors, exceptions)

## Architecture Diagram

```mermaid
graph TB
    subgraph "Application Layer"
        APP[Application Code]
        CLI[CLI App]
        WEB[Web App]
        DESKTOP[Desktop App]
    end

    subgraph "@qwery/telemetry Package"
        subgraph "Unified Manager"
            TM[TelemetryManager<br/>createTelemetryManager]
            TS[TelemetryService Interface]
        end

        subgraph "Providers"
            PH[PostHog Provider<br/>createPostHogProvider]
            OT[OTel Provider<br/>createOtelProvider]
            SN[Sentry Provider<br/>createSentryProvider]
        end

        subgraph "OpenTelemetry Implementation"
            OTM[OtelTelemetryManager]
            OCS[OtelClientService]
            OTE[OTLP Exporter]
            FSE[FilteringSpanExporter]
            ATH[Agent Telemetry Helpers]
            OTU[OTel Utils]
        end

        subgraph "PostHog Implementation"
            PHS[ClientTelemetryService]
            PHI[PostHog SDK]
        end

        subgraph "Events"
            EVT[Event Schemas<br/>agent/cli/web/desktop]
        end
    end

    subgraph "Backends"
        OTLP[OTLP Collector<br/>Jaeger/Tempo]
        PHB[PostHog Cloud]
        SNB[Sentry Cloud]
    end

    APP --> TM
    CLI --> TM
    WEB --> TM
    DESKTOP --> TM

    TM --> PH
    TM --> OT
    TM --> SN

    PH --> PHS
    PHS --> PHI
    PHI --> PHB

    OT --> OTM
    OTM --> OCS
    OTM --> FSE
    FSE --> OTE
    OTE --> OTLP

    SN --> SNB

    OTM --> ATH
    ATH --> EVT
    OTM --> OTU
    OTU --> EVT

    style TM fill:#e1f5ff
    style OTM fill:#fff4e1
    style PHS fill:#ffe1f5
    style PH fill:#ffe1f5
    style OT fill:#fff4e1
    style SN fill:#f5ffe1
```

## Provider Pattern

```mermaid
graph LR
    subgraph "Provider Factory Pattern"
        PF[Provider Factory<br/>createXProvider]
        CF[Config]
        SF[Service Factory Function]
        SI[Service Instance]
    end

    subgraph "TelemetryManager"
        PM[Provider Map]
        AS[Active Services]
        DM[Delegate Methods]
    end

    CF --> PF
    PF --> SF
    SF --> SI
    SI --> PM
    PM --> AS
    AS --> DM

    DM -->|trackEvent| SI1[PostHog Service]
    DM -->|trackEvent| SI2[OTel Service]
    DM -->|trackEvent| SI3[Sentry Service]

    style PF fill:#e1f5ff
    style DM fill:#ffe1f5
```

## Data Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant TM as TelemetryManager
    participant PH as PostHog Provider
    participant OT as OTel Provider
    participant SN as Sentry Provider
    participant OTM as OtelTelemetryManager
    participant Backend as Backends

    App->>TM: trackEvent('user.clicked', {...})
    
    par Parallel Execution
        TM->>PH: trackEvent(...)
        PH->>Backend: PostHog Cloud
    and
        TM->>OT: trackEvent(...)
        OT->>OTM: captureEvent(...)
        OTM->>Backend: OTLP Collector
    and
        TM->>SN: trackEvent(...)
        SN->>Backend: Sentry Cloud
    end
```

## Component Relationships

```mermaid
classDiagram
    class TelemetryManager {
        +trackEvent()
        +trackPageView()
        +identify()
        +addProvider()
        +removeProvider()
    }

    class TelemetryService {
        <<interface>>
        +initialize()
        +trackEvent()
        +trackPageView()
        +identify()
    }

    class ClientTelemetryService {
        +initialize()
        +trackEvent()
    }

    class OtelTelemetryManager {
        +startSpan()
        +endSpan()
        +captureEvent()
        +recordTokenUsage()
        +recordQueryMetrics()
    }

    class OtelClientService {
        +startSpan()
        +endSpan()
        +trackEvent()
    }

    class FilteringSpanExporter {
        +export()
        +shutdown()
    }

    TelemetryManager --> TelemetryService : uses
    ClientTelemetryService ..|> TelemetryService : implements
    OtelTelemetryManager --> OtelClientService : contains
    OtelTelemetryManager --> FilteringSpanExporter : uses
```

## OpenTelemetry Architecture

```mermaid
graph TB
    subgraph "OTel Components"
        OTM[OtelTelemetryManager]
        
        subgraph "Span Management"
            ST[Span Tracer]
            SC[Span Context]
            SL[Span Links]
        end

        subgraph "Metrics"
            CT[Counters]
            HT[Histograms]
            MT[Meter]
        end

        subgraph "Export Pipeline"
            FSE[FilteringSpanExporter]
            SOE[SafeOTLPExporter]
            CSE[ConsoleSpanExporter]
        end

        subgraph "Helpers"
            ATH[Agent Helpers]
            OTU[OTel Utils]
            WASP[withActionSpan]
            RQM[recordQueryMetrics]
            RTU[recordTokenUsage]
        end
    end

    subgraph "Backend"
        OTLP[OTLP Collector]
        CON[Console]
    end

    OTM --> ST
    OTM --> CT
    OTM --> HT
    OTM --> MT

    ST --> FSE
    FSE --> SOE
    FSE --> CSE

    SOE --> OTLP
    CSE --> CON

    OTM --> ATH
    OTM --> OTU
    OTU --> WASP
    OTU --> RQM
    OTU --> RTU

    style OTM fill:#fff4e1
    style FSE fill:#ffe1f5
```

## Span Filtering Logic

```mermaid
graph LR
    SPAN[Span Export Request]
    FSE[FilteringSpanExporter]
    
    subgraph "Filter Rules"
        GP[General Patterns<br/>agent.*<br/>agent.actor.*<br/>agent.llm.*]
        AP[App Patterns<br/>cli.*<br/>web.*<br/>desktop.*]
        EXP[Export App Telemetry<br/>Config Flag]
    end

    EXPORT[Export to Backend]
    SKIP[Skip Export]

    SPAN --> FSE
    FSE --> GP
    FSE --> AP
    FSE --> EXP

    GP -->|Always| EXPORT
    AP -->|If EXP=true| EXPORT
    AP -->|If EXP=false| SKIP

    style GP fill:#90EE90
    style AP fill:#FFE4B5
```

## Event Schema Organization

```mermaid
graph TB
    subgraph "Event Schemas"
        AGENT[Agent Events<br/>conversation/message/actor/llm]
        CLI[CLI Events<br/>command/query/error]
        WEB[Web Events<br/>page/ui/api]
        DESKTOP[Desktop Events<br/>window/menu/command]
        NOTEBOOK[Notebook Events<br/>create/run/export]
        PROJECT[Project Events<br/>create/update/delete]
    end

    subgraph "Usage"
        OTM[OTel Telemetry]
        PH[PostHog]
        APP[Applications]
    end

    AGENT --> OTM
    CLI --> OTM
    WEB --> OTM
    DESKTOP --> OTM

    NOTEBOOK --> PH
    PROJECT --> PH

    APP --> AGENT
    APP --> CLI
    APP --> WEB
    APP --> DESKTOP
    APP --> NOTEBOOK
    APP --> PROJECT

    style AGENT fill:#e1f5ff
    style CLI fill:#fff4e1
    style WEB fill:#ffe1f5
    style DESKTOP fill:#f5ffe1
```

## Initialization Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant TM as createTelemetryManager
    participant PH as PostHog Provider
    participant OT as OTel Provider
    participant OTM as OtelTelemetryManager
    participant SDK as OTel Node SDK

    App->>TM: createTelemetryManager({providers: {...}})
    
    TM->>PH: createPostHogProvider()()
    PH->>PH: new ClientTelemetryService()
    PH->>PH: initialize()
    
    TM->>OT: createOtelProvider(config)()
    OT->>OTM: new OtelTelemetryManager(...)
    OTM->>OTM: initializeMetrics()
    OTM->>SDK: loadNodeModules()
    OTM->>SDK: new NodeSDK(...)
    OTM->>SDK: start()
    
    TM-->>App: TelemetryManager instance
```

## Usage Examples

### Basic Setup (PostHog only)
```typescript
import { createTelemetryManager } from '@qwery/telemetry';
import { createPostHogProvider } from '@qwery/telemetry/providers';

const telemetry = createTelemetryManager({
  providers: {
    posthog: createPostHogProvider(),
  },
});
```

### Multi-Provider Setup
```typescript
import { createTelemetryManager } from '@qwery/telemetry';
import { 
  createPostHogProvider,
  createOtelProvider,
  createSentryProvider 
} from '@qwery/telemetry/providers';

const telemetry = createTelemetryManager({
  providers: {
    posthog: createPostHogProvider(),
    otel: createOtelProvider({
      serviceName: 'qwery-app',
      options: { exportAppTelemetry: true }
    }),
    sentry: createSentryProvider({
      dsn: process.env.SENTRY_DSN
    }),
  },
});
```

### Direct OTel Usage (for spans/metrics)
```typescript
import { TelemetryManager } from '@qwery/telemetry/otel';

const otel = new TelemetryManager('qwery-app');
await otel.init();

const span = otel.startSpan('operation.name', { key: 'value' });
// ... do work ...
otel.endSpan(span, true);
```

## Key Design Decisions

1. **Provider Pattern**: Allows multiple backends to coexist and receive the same events
2. **Unified Interface**: All providers implement `TelemetryService` for consistency
3. **Lazy Loading**: Node.js-only OTel modules are loaded dynamically to avoid browser bundling
4. **Span Filtering**: Selective export of app-specific telemetry while always exporting general spans
5. **Dual Tracking**: OTel for observability, PostHog for product analytics
6. **Type Safety**: Strong TypeScript types for all events and attributes

## File Structure

```
packages/telemetry/src/
├── otel/                    # OpenTelemetry implementation
│   ├── manager.ts          # OtelTelemetryManager
│   ├── utils.ts            # Generic utilities
│   ├── client-service.ts   # OTel client wrapper
│   ├── null-service.ts     # No-op service
│   ├── filtering-exporter.ts
│   ├── agent-helpers.ts    # Agent-specific helpers
│   ├── context.tsx         # React context
│   └── index.ts
├── providers/               # Provider factories
│   ├── posthog.ts
│   ├── otel.ts
│   ├── sentry.ts
│   └── index.ts
├── events/                  # Event schemas
│   ├── agent.events.ts
│   ├── cli.events.ts
│   ├── web.events.ts
│   ├── desktop.events.ts
│   ├── notebook.events.ts
│   ├── project.events.ts
│   └── index.ts
├── telemetry-manager.ts     # Unified manager
├── client.telemetry.service.ts  # PostHog service
├── types.ts                 # Type definitions
└── index.ts                 # Main exports
```

