import { setup, assign } from 'xstate';
import { fromPromise } from 'xstate/actors';
import type { UIMessage } from 'ai';
import { AgentContext, AgentEvents } from './types';
import { detectIntent } from './actors/detect-intent.actor';
import { summarizeIntent } from './actors/summarize-intent.actor';
import { greeting } from './actors/greeting.actor';
import { readDataAgent } from './actors/read-data-agent.actor';
import { loadContext } from './actors/load-context.actor';
import { systemInfoActor } from './actors';
import { MessagePersistenceService } from '../services/message-persistence.service';
import { Repositories } from '@qwery/domain/repositories';
import { createCachedActor } from './utils/actor-cache';
import { AbstractQueryEngine } from '@qwery/domain/ports';
import type { PromptSource } from '../domain';
import type { TelemetryManager } from '@qwery/telemetry/opentelemetry';
import { AGENT_EVENTS } from '@qwery/telemetry/opentelemetry/events/agent.events';
import { context as otelContext, trace } from '@opentelemetry/api';

export const createStateMachine = (
  conversationId: string,
  conversationSlug: string,
  model: string,
  repositories: Repositories,
  queryEngine: AbstractQueryEngine,
  telemetry?: TelemetryManager,
) => {
  // Create telemetry-wrapped actors
  const detectIntentActor = fromPromise(
    async ({
      input,
    }: {
      input: {
        inputMessage: string;
        model: string;
      };
    }): Promise<AgentContext['intent']> => {
      if (!telemetry) {
        const result = await detectIntent(input.inputMessage, input.model);
        return result.object;
      }

      const startTime = Date.now();
      // Get the active context (should have parent spans from conversation/message)
      const parentContext = otelContext.active();
      // Create span within the parent context to ensure proper nesting
      const tracer = trace.getTracer('qwery-telemetry');
      const span = tracer.startSpan(
        'agent.actor.detectIntent',
        {
          attributes: {
            'agent.actor.id': 'detectIntent',
            'agent.actor.type': 'detectIntent',
            'agent.actor.input': JSON.stringify({
              inputMessage: input.inputMessage,
            }),
            'agent.conversation.id': conversationId,
          },
        },
        parentContext,
      );

      telemetry.captureEvent({
        name: AGENT_EVENTS.ACTOR_INVOKED,
        attributes: {
          'agent.actor.id': 'detectIntent',
          'agent.actor.type': 'detectIntent',
          'agent.conversation.id': conversationId,
        },
      });

      // Run within the span's context to ensure proper nesting
      return otelContext.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await detectIntent(input.inputMessage, input.model);
          const duration = Date.now() - startTime;

          // Record token usage if available
          if (result.usage) {
            // LanguageModelV2Usage structure varies by provider
            // Try to extract tokens safely
            const usage = result.usage as {
              promptTokens?: number;
              prompt_tokens?: number;
              completionTokens?: number;
              completion_tokens?: number;
            };
            const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? 0;
            const completionTokens =
              usage.completionTokens ?? usage.completion_tokens ?? 0;

            if (promptTokens > 0 || completionTokens > 0) {
              telemetry.recordTokenUsage(promptTokens, completionTokens, {
                'agent.llm.model.name': 'gpt-5-mini',
                'agent.llm.provider.id': 'azure',
                'agent.actor.id': 'detectIntent',
                'agent.conversation.id': conversationId,
              });
            }
          }

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_COMPLETED,
            attributes: {
              'agent.actor.id': 'detectIntent',
              'agent.actor.type': 'detectIntent',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'success',
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, true);
          return result.object;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_FAILED,
            attributes: {
              'agent.actor.id': 'detectIntent',
              'agent.actor.type': 'detectIntent',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'error',
              'error.type':
                error instanceof Error ? error.name : 'UnknownError',
              'error.message': errorMessage,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, false);
          throw error;
        }
      });
    },
  );

  const summarizeIntentActor = fromPromise(
    async ({
      input,
    }: {
      input: {
        inputMessage: string;
        intent: AgentContext['intent'];
        previousMessages: UIMessage[];
        model: string;
      };
    }) => {
      if (!telemetry) {
        return summarizeIntent(input.inputMessage, input.intent);
      }

      const startTime = Date.now();
      // Get the active context (should have parent spans from conversation/message)
      const parentContext = otelContext.active();
      // Create span within the parent context to ensure proper nesting
      const tracer = trace.getTracer('qwery-telemetry');
      const span = tracer.startSpan(
        'agent.actor.summarizeIntent',
        {
          attributes: {
            'agent.actor.id': 'summarizeIntent',
            'agent.actor.type': 'summarizeIntent',
            'agent.conversation.id': conversationId,
          },
        },
        parentContext,
      );

      telemetry.captureEvent({
        name: AGENT_EVENTS.ACTOR_INVOKED,
        attributes: {
          'agent.actor.id': 'summarizeIntent',
          'agent.actor.type': 'summarizeIntent',
          'agent.conversation.id': conversationId,
        },
      });

      // Run within the span's context to ensure proper nesting
      return otelContext.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await summarizeIntent(
            input.inputMessage,
            input.intent,
          );
          const duration = Date.now() - startTime;

          // Capture token usage from streamText result (usage is a promise)
          // For Azure/Ollama providers, usage will be available when stream completes
          if (result.usage) {
            result.usage
              .then((usage) => {
                if (usage && telemetry) {
                  const usageObj = usage as {
                    promptTokens?: number;
                    prompt_tokens?: number;
                    completionTokens?: number;
                    completion_tokens?: number;
                  };
                  const promptTokens =
                    usageObj.promptTokens ?? usageObj.prompt_tokens ?? 0;
                  const completionTokens =
                    usageObj.completionTokens ??
                    usageObj.completion_tokens ??
                    0;

                  if (promptTokens > 0 || completionTokens > 0) {
                    telemetry.recordTokenUsage(promptTokens, completionTokens, {
                      'agent.llm.model.name': 'gpt-5-mini',
                      'agent.llm.provider.id': 'azure',
                      'agent.actor.id': 'summarizeIntent',
                      'agent.conversation.id': conversationId,
                    });
                  }
                }
              })
              .catch(() => {
                // Ignore errors in usage capture
              });
          }

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_COMPLETED,
            attributes: {
              'agent.actor.id': 'summarizeIntent',
              'agent.actor.type': 'summarizeIntent',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'success',
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, true);
          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_FAILED,
            attributes: {
              'agent.actor.id': 'summarizeIntent',
              'agent.actor.type': 'summarizeIntent',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'error',
              'error.type':
                error instanceof Error ? error.name : 'UnknownError',
              'error.message': errorMessage,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, false);
          throw error;
        }
      });
    },
  );

  const greetingActor = fromPromise(
    async ({
      input,
    }: {
      input: {
        inputMessage: string;
        model: string;
      };
    }) => {
      if (!telemetry) {
        return greeting(input.inputMessage, input.model);
      }

      const startTime = Date.now();
      // Get the active context (should have parent spans from conversation/message)
      const parentContext = otelContext.active();
      // Create span within the parent context to ensure proper nesting
      const tracer = trace.getTracer('qwery-telemetry');
      const span = tracer.startSpan(
        'agent.actor.greeting',
        {
          attributes: {
            'agent.actor.id': 'greeting',
            'agent.actor.type': 'greeting',
            'agent.conversation.id': conversationId,
          },
        },
        parentContext,
      );

      telemetry.captureEvent({
        name: AGENT_EVENTS.ACTOR_INVOKED,
        attributes: {
          'agent.actor.id': 'greeting',
          'agent.actor.type': 'greeting',
          'agent.conversation.id': conversationId,
        },
      });

      // Run within the span's context to ensure proper nesting
      return otelContext.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await greeting(input.inputMessage, input.model);
          const duration = Date.now() - startTime;

          // Capture token usage from streamText result (usage is a promise)
          // For Azure/Ollama providers, usage will be available when stream completes
          if (result.usage) {
            result.usage
              .then((usage) => {
                if (usage && telemetry) {
                  const usageObj = usage as {
                    promptTokens?: number;
                    prompt_tokens?: number;
                    completionTokens?: number;
                    completion_tokens?: number;
                  };
                  const promptTokens =
                    usageObj.promptTokens ?? usageObj.prompt_tokens ?? 0;
                  const completionTokens =
                    usageObj.completionTokens ??
                    usageObj.completion_tokens ??
                    0;

                  if (promptTokens > 0 || completionTokens > 0) {
                    telemetry.recordTokenUsage(promptTokens, completionTokens, {
                      'agent.llm.model.name': 'gpt-5-mini',
                      'agent.llm.provider.id': 'azure',
                      'agent.actor.id': 'greeting',
                      'agent.conversation.id': conversationId,
                    });
                  }
                }
              })
              .catch(() => {
                // Ignore errors in usage capture
              });
          }

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_COMPLETED,
            attributes: {
              'agent.actor.id': 'greeting',
              'agent.actor.type': 'greeting',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'success',
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, true);
          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_FAILED,
            attributes: {
              'agent.actor.id': 'greeting',
              'agent.actor.type': 'greeting',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'error',
              'error.type':
                error instanceof Error ? error.name : 'UnknownError',
              'error.message': errorMessage,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, false);
          throw error;
        }
      });
    },
  );

  const readDataAgentActor = fromPromise(
    async ({
      input,
    }: {
      input: {
        inputMessage: string;
        conversationId: string;
        previousMessages: UIMessage[];
        model: string;
        repositories: Repositories;
        queryEngine: AbstractQueryEngine;
      };
    }) => {
      if (!telemetry) {
        return readDataAgent(
          input.conversationId,
          input.previousMessages,
          input.model,
          input.queryEngine,
          input.repositories,
        );
      }

      const startTime = Date.now();
      // Get the active context (should have parent spans from conversation/message)
      const parentContext = otelContext.active();
      // Create span within the parent context to ensure proper nesting
      const tracer = trace.getTracer('qwery-telemetry');
      const span = tracer.startSpan(
        'agent.actor.readData',
        {
          attributes: {
            'agent.actor.id': 'readData',
            'agent.actor.type': 'readData',
            'agent.conversation.id': conversationId,
          },
        },
        parentContext,
      );

      telemetry.captureEvent({
        name: AGENT_EVENTS.ACTOR_INVOKED,
        attributes: {
          'agent.actor.id': 'readData',
          'agent.actor.type': 'readData',
          'agent.conversation.id': conversationId,
        },
      });

      // Run within the span's context to ensure proper nesting
      return otelContext.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await readDataAgent(
            input.conversationId,
            input.previousMessages,
            input.model,
            input.queryEngine,
            input.repositories,
          );
          const duration = Date.now() - startTime;

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_COMPLETED,
            attributes: {
              'agent.actor.id': 'readData',
              'agent.actor.type': 'readData',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'success',
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, true);
          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_FAILED,
            attributes: {
              'agent.actor.id': 'readData',
              'agent.actor.type': 'readData',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'error',
              'error.type':
                error instanceof Error ? error.name : 'UnknownError',
              'error.message': errorMessage,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, false);
          throw error;
        }
      });
    },
  );

  const loadContextActor = fromPromise(
    async ({
      input,
    }: {
      input: {
        repositories: Repositories;
        conversationId: string;
      };
    }) => {
      if (!telemetry) {
        const result = await loadContext(
          input.repositories,
          input.conversationId,
        );
        return MessagePersistenceService.convertToUIMessages(result);
      }

      const startTime = Date.now();
      // Get the active context (should have parent spans from conversation/message)
      const parentContext = otelContext.active();
      // Create span within the parent context to ensure proper nesting
      const tracer = trace.getTracer('qwery-telemetry');
      const span = tracer.startSpan(
        'agent.actor.loadContext',
        {
          attributes: {
            'agent.actor.id': 'loadContext',
            'agent.actor.type': 'loadContext',
            'agent.conversation.id': conversationId,
          },
        },
        parentContext,
      );

      telemetry.captureEvent({
        name: AGENT_EVENTS.ACTOR_INVOKED,
        attributes: {
          'agent.actor.id': 'loadContext',
          'agent.actor.type': 'loadContext',
          'agent.conversation.id': conversationId,
        },
      });

      // Run within the span's context to ensure proper nesting
      return otelContext.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await loadContext(
            input.repositories,
            input.conversationId,
          );
          const messages =
            MessagePersistenceService.convertToUIMessages(result);
          const duration = Date.now() - startTime;

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_COMPLETED,
            attributes: {
              'agent.actor.id': 'loadContext',
              'agent.actor.type': 'loadContext',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'success',
              'agent.context.message_count': messages.length,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, true);
          return messages;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          telemetry.captureEvent({
            name: AGENT_EVENTS.ACTOR_FAILED,
            attributes: {
              'agent.actor.id': 'loadContext',
              'agent.actor.type': 'loadContext',
              'agent.actor.duration_ms': String(duration),
              'agent.actor.status': 'error',
              'error.type':
                error instanceof Error ? error.name : 'UnknownError',
              'error.message': errorMessage,
              'agent.conversation.id': conversationId,
            },
          });

          telemetry.endSpan(span, false);
          throw error;
        }
      });
    },
  );

  const defaultSetup = setup({
    types: {
      context: {} as AgentContext,
      events: {} as AgentEvents,
    },
    actors: {
      detectIntentActor,
      detectIntentActorCached: createCachedActor(
        detectIntentActor,
        (input: { inputMessage: string; previousMessages?: unknown[] }) => {
          // Include last message from context in cache key for follow-up questions
          const lastContextMessage = input.previousMessages?.length
            ? input.previousMessages[input.previousMessages.length - 1]
            : null;
          const contextKey = lastContextMessage
            ? JSON.stringify(lastContextMessage).slice(0, 100)
            : '';
          return `${input.inputMessage}::${contextKey}`; // Cache key includes message + context
        },
        30000, // 30 second TTL (shorter for better context awareness)
      ),
      summarizeIntentActor,
      greetingActor,
      readDataAgentActor,
      loadContextActor,
      systemInfoActor,
    },
    guards: {
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
      isGreeting: ({ event }: { event: any }) =>
        event.output?.intent === 'greeting',

      isOther: ({ event }) => event.output?.intent === 'other',

      isReadData: ({ event }) => event.output?.intent === 'read-data',

      isSystem: ({ event }) => event.output?.intent === 'system',

      // NEW: Check if should retry
      shouldRetry: ({ context }) => {
        const retryCount = context.retryCount || 0;
        return retryCount < 3;
      },

      retryLimitExceeded: ({ context }) => {
        const retryCount = context.retryCount || 0;
        return retryCount >= 3;
      },
    },
    delays: {
      retryDelay: ({ context }) => {
        const retryCount = context.retryCount || 0;
        return Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      },
    },
  });
  return defaultSetup.createMachine({
    id: 'factory-agent',
    context: {
      model: model,
      inputMessage: '',
      conversationId: conversationId,
      conversationSlug: conversationSlug,
      response: '',
      previousMessages: [],
      streamResult: undefined,
      intent: {
        intent: 'other',
        complexity: 'simple',
        needsChart: false,
        needsSQL: false,
      },
      promptSource: undefined,
      error: undefined,
      retryCount: 0,
      lastError: undefined,
      enhancementActors: [],
    },
    initial: 'loadContext',
    states: {
      loadContext: {
        invoke: {
          src: 'loadContextActor',
          id: 'LOAD_CONTEXT',
          input: ({ context }: { context: AgentContext }) => ({
            repositories: repositories,
            conversationId: context.conversationId,
          }),
          onDone: {
            target: 'idle',
            actions: assign({
              previousMessages: ({ event }) => event.output,
              model: ({ context }) => context.model,
            }),
          },
          onError: {
            target: 'idle',
          },
        },
      },
      idle: {
        on: {
          USER_INPUT: {
            target: 'running',
            actions: assign({
              previousMessages: ({ event }) => event.messages,
              model: ({ context }) => context.model,
              inputMessage: ({ event }) =>
                event.messages[event.messages.length - 1]?.parts[0]?.text ?? '',
              streamResult: () => undefined, // Clear previous result when starting new request
              error: () => undefined,
              promptSource: ({ event }) => {
                const lastUserMessage = event.messages
                  .filter((m: UIMessage) => m.role === 'user')
                  .pop();
                const source = (
                  lastUserMessage?.metadata as { promptSource?: PromptSource }
                )?.promptSource;
                console.log(
                  '[StateMachine] Extracted promptSource from metadata:',
                  source,
                );
                return source;
              },
            }),
          },
          STOP: 'stopped',
        },
      },
      running: {
        initial: 'detectIntent',
        on: {
          USER_INPUT: {
            target: 'running',
            actions: assign({
              previousMessages: ({ event }) => event.messages,
              model: ({ context }) => context.model,
              inputMessage: ({ event }) =>
                event.messages[event.messages.length - 1]?.parts[0]?.text ?? '',
              streamResult: undefined,
              promptSource: ({ event }) => {
                const lastUserMessage = event.messages
                  .filter((m: UIMessage) => m.role === 'user')
                  .pop();
                return (
                  lastUserMessage?.metadata as { promptSource?: PromptSource }
                )?.promptSource;
              },
            }),
          },
          STOP: 'idle',
        },
        states: {
          detectIntent: {
            initial: 'attempting',
            states: {
              attempting: {
                invoke: {
                  src: 'detectIntentActorCached',
                  id: 'GET_INTENT',
                  input: ({ context }: { context: AgentContext }) => ({
                    inputMessage: context.inputMessage,
                    model: context.model,
                    previousMessages: context.previousMessages,
                  }),
                  onDone: [
                    {
                      guard: 'isOther',
                      target: '#factory-agent.running.summarizeIntent',
                      actions: assign({
                        intent: ({ event }) => {
                          const intent = event.output;
                          console.log(
                            '[StateMachine] Set intent from detection:',
                            {
                              intent: intent.intent,
                              needsChart: intent.needsChart,
                              needsSQL: intent.needsSQL,
                            },
                          );
                          return intent;
                        },
                        retryCount: () => 0, // Reset on success
                        model: ({ context }) => context.model,
                      }),
                    },
                    {
                      guard: 'isGreeting',
                      target: '#factory-agent.running.greeting',
                      actions: assign({
                        intent: ({ event }) => {
                          const intent = event.output;
                          console.log(
                            '[StateMachine] Set intent from detection (greeting):',
                            {
                              intent: intent.intent,
                              needsChart: intent.needsChart,
                              needsSQL: intent.needsSQL,
                            },
                          );
                          return intent;
                        },
                        retryCount: () => 0,
                        model: ({ context }) => context.model,
                      }),
                    },
                    {
                      guard: 'isReadData',
                      target: '#factory-agent.running.readData',
                      actions: assign({
                        intent: ({ event }) => {
                          const intent = event.output;
                          console.log(
                            '[StateMachine] Set intent from detection (readData):',
                            {
                              intent: intent.intent,
                              needsChart: intent.needsChart,
                              needsSQL: intent.needsSQL,
                            },
                          );
                          return intent;
                        },
                        retryCount: () => 0,
                        model: ({ context }) => context.model,
                      }),
                    },
                    {
                      guard: 'isSystem',
                      target: '#factory-agent.running.systemInfo',
                      actions: assign({
                        intent: ({ event }) => {
                          const intent = event.output;
                          console.log(
                            '[StateMachine] Set intent from detection (system):',
                            {
                              intent: intent.intent,
                              needsChart: intent.needsChart,
                              needsSQL: intent.needsSQL,
                            },
                          );
                          return intent;
                        },
                        retryCount: () => 0,
                        model: ({ context }) => context.model,
                      }),
                    },
                  ],
                  onError: [
                    {
                      guard: 'shouldRetry',
                      target: 'retrying',
                      actions: assign({
                        retryCount: ({ context }) =>
                          (context.retryCount || 0) + 1,
                        lastError: ({ event }) => event.error as Error,
                        model: ({ context }) => context.model,
                      }),
                    },
                    {
                      guard: 'retryLimitExceeded',
                      target: '#factory-agent.idle',
                      actions: assign({
                        error: ({ context }) =>
                          `Intent detection failed after 3 retries: ${context.lastError?.message}`,
                        model: ({ context }) => context.model,
                      }),
                    },
                  ],
                },
                after: {
                  30000: {
                    target: 'retrying',
                    guard: 'shouldRetry',
                    actions: assign({
                      retryCount: ({ context }) =>
                        (context.retryCount || 0) + 1,
                      error: () => 'Intent detection timeout',
                      model: ({ context }) => context.model,
                    }),
                  },
                },
              },
              retrying: {
                after: {
                  retryDelay: {
                    target: 'attempting',
                  },
                },
              },
            },
          },
          summarizeIntent: {
            invoke: {
              src: 'summarizeIntentActor',
              id: 'SUMMARIZE_INTENT',
              input: ({ context }: { context: AgentContext }) => ({
                inputMessage: context.inputMessage,
                intent: context.intent,
                previousMessages: context.previousMessages,
                model: context.model,
              }),
              onDone: {
                target: 'streaming',
                actions: assign({
                  streamResult: ({ event }) => event.output,
                  model: ({ context }) => context.model,
                }),
              },
              onError: {
                target: '#factory-agent.idle',
                actions: assign({
                  error: ({ event }) => {
                    const errorMsg =
                      event.error instanceof Error
                        ? event.error.message
                        : String(event.error);
                    console.error(
                      'summarizeIntent error:',
                      errorMsg,
                      event.error,
                    );
                    return errorMsg;
                  },
                  streamResult: undefined,
                  model: ({ context }) => context.model,
                }),
              },
            },
          },
          greeting: {
            invoke: {
              src: 'greetingActor',
              id: 'SALUE',
              input: ({ context }: { context: AgentContext }) => ({
                inputMessage: context.inputMessage,
                model: context.model,
              }),
              onDone: {
                target: 'streaming',
                actions: assign({
                  streamResult: ({ event }) => event.output,
                  model: ({ context }) => context.model,
                }),
              },
              onError: {
                target: '#factory-agent.idle',
                actions: assign({
                  error: ({ event }) => {
                    const errorMsg =
                      event.error instanceof Error
                        ? event.error.message
                        : String(event.error);
                    console.error('greeting error:', errorMsg, event.error);
                    return errorMsg;
                  },
                  streamResult: undefined,
                  model: ({ context }) => context.model,
                }),
              },
            },
          },
          readData: {
            type: 'parallel',
            states: {
              processRequest: {
                initial: 'invoking',
                states: {
                  invoking: {
                    invoke: {
                      src: 'readDataAgentActor',
                      id: 'READ_DATA',
                      input: ({ context }: { context: AgentContext }) => {
                        console.log(
                          '[StateMachine] Passing to readDataAgentActor:',
                          {
                            promptSource: context.promptSource,
                            intentNeedsSQL: context.intent.needsSQL,
                          },
                        );
                        return {
                          conversationId: context.conversationSlug, // Use slug for conversation lookups
                          previousMessages: context.previousMessages,
                          model: context.model,
                          repositories: repositories,
                          queryEngine: queryEngine,
                          promptSource: context.promptSource,
                          intent: context.intent,
                        };
                      },
                      onDone: {
                        target: 'completed',
                        actions: assign({
                          streamResult: ({ event }) => event.output,
                          retryCount: () => 0, // Reset on success
                          model: ({ context }) => context.model,
                        }),
                      },
                      onError: [
                        {
                          guard: 'shouldRetry',
                          target: 'retrying',
                          actions: assign({
                            retryCount: ({ context }) =>
                              (context.retryCount || 0) + 1,
                            lastError: ({ event }) => event.error as Error,
                            model: ({ context }) => context.model,
                          }),
                        },
                        {
                          target: 'failed',
                          actions: assign({
                            error: ({ event }) => {
                              const errorMsg =
                                event.error instanceof Error
                                  ? event.error.message
                                  : String(event.error);
                              console.error(
                                'readData error:',
                                errorMsg,
                                event.error,
                              );
                              return errorMsg;
                            },
                            streamResult: undefined,
                            model: ({ context }) => context.model,
                          }),
                        },
                      ],
                    },
                    after: {
                      120000: {
                        target: 'failed',
                        actions: assign({
                          error: () => 'ReadData timeout after 120 seconds',
                          model: ({ context }) => context.model,
                        }),
                      },
                    },
                  },
                  retrying: {
                    after: {
                      retryDelay: {
                        target: 'invoking',
                      },
                    },
                  },
                  completed: {
                    type: 'final',
                  },
                  failed: {
                    type: 'final',
                  },
                },
              },
              // Background enhancement (runs in parallel)
              backgroundEnhancement: {
                initial: 'idle',
                states: {
                  idle: {
                    type: 'final',
                  },
                },
              },
            },
            onDone: {
              target: 'streaming',
            },
          },
          systemInfo: {
            invoke: {
              src: 'systemInfoActor',
              id: 'SYSTEM_INFO',
              input: ({ context }: { context: AgentContext }) => ({
                inputMessage: context.inputMessage,
              }),
              onDone: {
                target: 'streaming',
                actions: assign({
                  streamResult: ({ event }) => event.output,
                  model: ({ context }) => context.model,
                }),
              },
              onError: {
                target: '#factory-agent.idle',
                actions: assign({
                  error: ({ event }) => {
                    const errorMsg =
                      event.error instanceof Error
                        ? event.error.message
                        : String(event.error);
                    console.error('systemInfo error:', errorMsg, event.error);
                    return errorMsg;
                  },
                  streamResult: undefined,
                  model: ({ context }) => context.model,
                }),
              },
            },
          },
          streaming: {
            on: {
              FINISH_STREAM: {
                target: '#factory-agent.idle',
              },
            },
          },
        },
      },
      stopped: {
        type: 'final',
      },
    },
  });
};
