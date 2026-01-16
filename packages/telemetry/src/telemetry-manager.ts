import { NullTelemetryService } from './null-telemetry-service';
import type {
  TelemetryManager,
  TelemetryService,
  CreateTelemetryManagerOptions,
} from './types';

export function createTelemetryManager<T extends string, Config extends object>(
  options: CreateTelemetryManagerOptions<T, Config>,
): TelemetryManager {
  const activeServices = new Map<T, TelemetryService>();

  const getActiveServices = (): TelemetryService[] => {
    if (activeServices.size === 0) {
      console.debug(
        'No active telemetry services. Using NullTelemetryService.',
      );

      return [NullTelemetryService];
    }

    return Array.from(activeServices.values());
  };

  const registerActiveServices = (
    options: CreateTelemetryManagerOptions<T, Config>,
  ) => {
    Object.keys(options.providers).forEach((provider) => {
      const providerKey = provider as keyof typeof options.providers;
      const factory = options.providers[providerKey];

      if (!factory) {
        console.warn(
          `Analytics provider '${provider}' not registered. Skipping initialization.`,
        );

        return;
      }

      const service = factory();
      activeServices.set(provider as T, service);

      console.log('Initializing telemetry service', provider);
      void service.initialize();
    });
  };

  registerActiveServices(options);

  return {
    addProvider: (provider: T, config: Config) => {
      const factory = options.providers[provider];

      if (!factory) {
        console.warn(
          `Analytics provider '${provider}' not registered. Skipping initialization.`,
        );

        return Promise.resolve();
      }

      const service = factory(config);
      activeServices.set(provider, service);

      return service.initialize();
    },

    removeProvider: (provider: T) => {
      activeServices.delete(provider);
    },

    identify: (userId: string, traits?: Record<string, string>) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.identify(userId, traits).catch((error) => {
            console.warn('[Telemetry] identify failed for a provider:', error);
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackPageView: (path: string) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackPageView(path).catch((error) => {
            console.warn(
              '[Telemetry] trackPageView failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackError: (error: Error) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackError(error).catch((telemetryError) => {
            console.warn(
              '[Telemetry] trackError failed for a provider:',
              telemetryError,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackUsage: (usage: string) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackUsage(usage).catch((error) => {
            console.warn(
              '[Telemetry] trackUsage failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackPerformance: (performance: string) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackPerformance(performance).catch((error) => {
            console.warn(
              '[Telemetry] trackPerformance failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackFeatureUsage: (feature: string) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackFeatureUsage(feature).catch((error) => {
            console.warn(
              '[Telemetry] trackFeatureUsage failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackAgent: (agent: string) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackAgent(agent).catch((error) => {
            console.warn(
              '[Telemetry] trackAgent failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },

    trackEvent: (
      eventName: string,
      eventProperties?: Record<string, string | string[]>,
    ) => {
      // Fire-and-forget: don't block core logic on telemetry
      Promise.allSettled(
        getActiveServices().map((service) =>
          service.trackEvent(eventName, eventProperties).catch((error) => {
            console.warn(
              '[Telemetry] trackEvent failed for a provider:',
              error,
            );
          }),
        ),
      ).catch(() => {
        // Silently ignore - telemetry should never block core logic
      });
      return Promise.resolve();
    },
  };
}
