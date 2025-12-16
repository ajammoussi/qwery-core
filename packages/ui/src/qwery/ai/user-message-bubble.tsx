'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Minimize2, ArrowUpLeft } from 'lucide-react';
import { Button } from '../../shadcn/button';
import { cn } from '../../lib/utils';
import { Message, MessageContent } from '../../ai-elements/message';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { agentMarkdownComponents } from './markdown-components';
import { scrollToElementBySelector } from './scroll-utils';
import { DatasourceBadges, type DatasourceItem } from './datasource-badge';
import { cleanContextMarkers } from './utils/message-context';

export interface UserMessageBubbleProps {
  text: string;
  context?: {
    lastUserQuestion?: string;
    lastAssistantResponse?: string;
    sourceSuggestionId?: string; // ID of the original suggestion element
  };
  messageId: string;
  className?: string;
  datasources?: DatasourceItem[];
  pluginLogoMap?: Map<string, string>;
}

/**
 * Parses context from message text if it contains the special marker
 * Returns { text: clean text, context: parsed context or undefined }
 * Handles nested context markers by finding the outermost pair
 */
export function parseMessageWithContext(messageText: string): {
  text: string;
  context?: UserMessageBubbleProps['context'];
} {
  const contextMarker = '__QWERY_CONTEXT__';
  const contextEndMarker = '__QWERY_CONTEXT_END__';

  if (!messageText.includes(contextMarker)) {
    return { text: messageText };
  }

  const removeAllContextMarkers = (str: string): string => {
    return cleanContextMarkers(str, { removeWorkflowGuidance: true });
  };

  const lastStartIndex = messageText.lastIndexOf(contextMarker);
  if (lastStartIndex === -1) {
    return { text: removeAllContextMarkers(messageText).trim() || messageText };
  }

  const endIndex = messageText.indexOf(contextEndMarker, lastStartIndex);
  if (endIndex === -1) {
    return { text: removeAllContextMarkers(messageText).trim() || messageText };
  }

  try {
    // Extract the JSON part
    let contextJson = messageText.substring(
      lastStartIndex + contextMarker.length,
      endIndex,
    );

    // First, try to clean nested context markers from the JSON string itself
    // This is tricky because we need to preserve the JSON structure
    contextJson = removeAllContextMarkers(contextJson);

    // Try to parse the JSON
    const parsedContext: UserMessageBubbleProps['context'] = {};
    try {
      const parsed = JSON.parse(contextJson);
      if (parsed && typeof parsed === 'object') {
        if (
          parsed.lastUserQuestion &&
          typeof parsed.lastUserQuestion === 'string'
        ) {
          parsedContext.lastUserQuestion = parsed.lastUserQuestion;
        }
        if (
          parsed.lastAssistantResponse &&
          typeof parsed.lastAssistantResponse === 'string'
        ) {
          parsedContext.lastAssistantResponse = parsed.lastAssistantResponse;
        }
        if (
          parsed.sourceSuggestionId &&
          typeof parsed.sourceSuggestionId === 'string'
        ) {
          parsedContext.sourceSuggestionId = parsed.sourceSuggestionId;
        }
      }
    } catch {
      // If JSON parsing fails, try to extract fields using a more robust regex
      // Use a safer regex pattern that avoids exponential backtracking
      // Match quoted strings by finding the key, then capturing until the closing quote
      // This pattern uses a non-capturing group with a limited repetition to prevent backtracking
      const lastUserQuestionRegex =
        /"lastUserQuestion"\s*:\s*"((?:[^"\\]|\\(?:[\\"nrt]|u[0-9a-fA-F]{4}))*?)"/;
      const lastAssistantResponseRegex =
        /"lastAssistantResponse"\s*:\s*"((?:[^"\\]|\\(?:[\\"nrt]|u[0-9a-fA-F]{4}))*?)"/;
      const sourceSuggestionIdRegex = /"sourceSuggestionId"\s*:\s*"([^"]+)"/;

      const lastUserQuestionMatch = contextJson.match(lastUserQuestionRegex);
      const lastAssistantResponseMatch = contextJson.match(
        lastAssistantResponseRegex,
      );
      const sourceSuggestionIdMatch = contextJson.match(
        sourceSuggestionIdRegex,
      );

      if (lastUserQuestionMatch && lastUserQuestionMatch[1]) {
        let value = lastUserQuestionMatch[1];
        // Remove nested context markers and suggestion guidance markers
        value = removeAllContextMarkers(value);
        // Unescape JSON string - order matters: handle \\ first to avoid double unescaping
        // Use a single pass with a function to handle all escape sequences correctly
        value = value.replace(/\\(.)/g, (match, char) => {
          switch (char) {
            case 'n':
              return '\n';
            case 't':
              return '\t';
            case 'r':
              return '\r';
            case '"':
              return '"';
            case '\\':
              return '\\';
            default:
              return match; // Preserve unknown escape sequences
          }
        });
        parsedContext.lastUserQuestion = value.trim();
      }
      if (lastAssistantResponseMatch && lastAssistantResponseMatch[1]) {
        let value = lastAssistantResponseMatch[1];
        // Remove nested context markers and suggestion guidance markers
        value = removeAllContextMarkers(value);
        // Unescape JSON string - order matters: handle \\ first to avoid double unescaping
        // Use a single pass with a function to handle all escape sequences correctly
        value = value.replace(/\\(.)/g, (match, char) => {
          switch (char) {
            case 'n':
              return '\n';
            case 't':
              return '\t';
            case 'r':
              return '\r';
            case '"':
              return '"';
            case '\\':
              return '\\';
            default:
              return match;
          }
        });
        parsedContext.lastAssistantResponse = value.trim();
      }
      if (sourceSuggestionIdMatch && sourceSuggestionIdMatch[1]) {
        parsedContext.sourceSuggestionId = sourceSuggestionIdMatch[1];
      }
    }

    // Extract clean text (everything after the last context marker pair)
    let cleanText = messageText
      .substring(endIndex + contextEndMarker.length)
      .trim();

    // Remove suggestion workflow guidance from clean text if present
    cleanText = cleanText
      .replace(/\[SUGGESTION WORKFLOW GUIDANCE\][\s\S]*?(?=\n\n|$)/g, '')
      .trim();

    // Clean nested markers from context values (final cleanup)
    if (parsedContext.lastUserQuestion) {
      parsedContext.lastUserQuestion = removeAllContextMarkers(
        parsedContext.lastUserQuestion,
      ).trim();
    }
    if (parsedContext.lastAssistantResponse) {
      parsedContext.lastAssistantResponse = removeAllContextMarkers(
        parsedContext.lastAssistantResponse,
      ).trim();
    }

    // Only return context if it has at least one field
    if (parsedContext.lastUserQuestion || parsedContext.lastAssistantResponse) {
      return { text: cleanText, context: parsedContext };
    }

    return { text: cleanText };
  } catch {
    // If all parsing fails, return cleaned text without markers
    const cleaned = removeAllContextMarkers(messageText).trim();
    return { text: cleaned || messageText };
  }
}

export function UserMessageBubble({
  text,
  context,
  className,
  datasources,
  pluginLogoMap,
}: UserMessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showContext, setShowContext] = useState({
    previousQuestion: false, // Closed by default
    previousResponse: false, // Closed by default
  });

  const hasContext =
    context && (context.lastUserQuestion || context.lastAssistantResponse);
  const hasSourceSuggestion = context?.sourceSuggestionId;

  const scrollToSourceSuggestion = () => {
    if (!context?.sourceSuggestionId) return;

    // Use the utility function to scroll to the suggestion
    scrollToElementBySelector(
      `[data-suggestion-id="${context.sourceSuggestionId}"]`,
      {
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
        offset: -20, // Small offset to account for padding
      },
    );
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Datasources displayed above the message bubble */}
      {datasources && datasources.length > 0 && (
        <div className="flex w-full max-w-[80%] min-w-0 justify-end overflow-x-hidden">
          <DatasourceBadges
            datasources={datasources}
            pluginLogoMap={pluginLogoMap}
          />
        </div>
      )}
      <div className="flex max-w-full min-w-0 items-start gap-0.5 overflow-x-hidden">
        {/* Scroll back button - outside the message bubble, on the left */}
        <Message
          from="user"
          className={cn(
            'flex !w-auto !max-w-[80%] min-w-0 flex-row items-center gap-2',
            className,
          )}
        >
          {hasSourceSuggestion && (
            <Button
              variant="ghost"
              size="icon"
              className="mt-1 -ml-1 h-4 w-4 shrink-0 opacity-60 hover:opacity-100"
              onClick={scrollToSourceSuggestion}
              title="Scroll to original suggestion"
            >
              <ArrowUpLeft className="size-3" />
            </Button>
          )}
          <MessageContent
            className="overflow-wrap-anywhere relative max-w-full min-w-0 overflow-hidden break-words"
            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
          >
            {!isExpanded ? (
              // Compact mode - just show the suggestion text
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 text-sm font-semibold break-words">
                  {text}
                </span>
                {hasContext && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 opacity-60 hover:opacity-100"
                    onClick={() => setIsExpanded(true)}
                    title="Expand to see context"
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                )}
              </div>
            ) : (
              // Expanded mode - show formatted content with context
              <>
                {/* Collapse button */}
                <div className="absolute top-0 right-0 z-10 p-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 p-1.5 opacity-60 hover:opacity-100"
                    onClick={() => setIsExpanded(false)}
                    title="Collapse"
                  >
                    <Minimize2 className="size-3" />
                  </Button>
                </div>

                <div className="min-w-0 space-y-3 pr-16">
                  {/* Main suggestion text - bold, no bottom margin */}
                  <div className="mb-0 min-w-0">
                    <strong className="text-sm font-semibold break-words">
                      {text}
                    </strong>
                  </div>

                  {/* Context sections */}
                  {hasContext && (
                    <div className="space-y-2 border-t pt-3">
                      {context.lastUserQuestion && (
                        <div className="space-y-1">
                          <button
                            onClick={() =>
                              setShowContext((prev) => ({
                                ...prev,
                                previousQuestion: !prev.previousQuestion,
                              }))
                            }
                            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-xs font-semibold transition-colors"
                          >
                            {showContext.previousQuestion ? (
                              <ChevronUp className="size-3" />
                            ) : (
                              <ChevronDown className="size-3" />
                            )}
                            Previous Question
                          </button>
                          {showContext.previousQuestion && (
                            <div className="w-full min-w-0 overflow-hidden overflow-x-hidden">
                              <div className="prose prose-sm dark:prose-invert overflow-wrap-anywhere max-w-none min-w-0 overflow-x-hidden break-words [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&>*]:max-w-full [&>*]:min-w-0">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={agentMarkdownComponents}
                                >
                                  {context.lastUserQuestion}
                                </ReactMarkdown>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {context.lastAssistantResponse && (
                        <div className="space-y-1">
                          <button
                            onClick={() =>
                              setShowContext((prev) => ({
                                ...prev,
                                previousResponse: !prev.previousResponse,
                              }))
                            }
                            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-xs font-semibold transition-colors"
                          >
                            {showContext.previousResponse ? (
                              <ChevronUp className="size-3" />
                            ) : (
                              <ChevronDown className="size-3" />
                            )}
                            Previous Response
                          </button>
                          {showContext.previousResponse && (
                            <div className="w-full min-w-0 overflow-hidden">
                              <div className="prose prose-sm dark:prose-invert overflow-wrap-anywhere max-w-none break-words">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={agentMarkdownComponents}
                                >
                                  {context.lastAssistantResponse}
                                </ReactMarkdown>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </MessageContent>
        </Message>
      </div>
    </div>
  );
}
