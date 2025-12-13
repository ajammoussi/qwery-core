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
export function parseMessageWithContext(
  messageText: string,
): { text: string; context?: UserMessageBubbleProps['context'] } {
  const contextMarker = '__QWERY_CONTEXT__';
  const contextEndMarker = '__QWERY_CONTEXT_END__';

  if (!messageText.includes(contextMarker)) {
    return { text: messageText };
  }

  // Helper to remove all context markers and suggestion guidance markers from a string
  const removeAllContextMarkers = (str: string): string => {
    let cleaned = str;
    let previousCleaned = '';
    while (cleaned !== previousCleaned) {
      previousCleaned = cleaned;
      // Remove context markers
      cleaned = cleaned.replace(
        new RegExp(
          contextMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '.*?' +
          contextEndMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'gs',
        ),
        '',
      );
    }
    // Remove suggestion guidance markers
    cleaned = cleaned.replace(/__QWERY_SUGGESTION_GUIDANCE__/g, '');
    cleaned = cleaned.replace(/__QWERY_SUGGESTION_GUIDANCE_END__/g, '');
    // Remove suggestion workflow guidance text block
    cleaned = cleaned.replace(/\[SUGGESTION WORKFLOW GUIDANCE\][\s\S]*?(?=\n\n|$)/g, '');
    return cleaned;
  };

  // Find the outermost (last) context marker pair
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
        if (parsed.lastUserQuestion && typeof parsed.lastUserQuestion === 'string') {
          parsedContext.lastUserQuestion = parsed.lastUserQuestion;
        }
        if (parsed.lastAssistantResponse && typeof parsed.lastAssistantResponse === 'string') {
          parsedContext.lastAssistantResponse = parsed.lastAssistantResponse;
        }
        if (parsed.sourceSuggestionId && typeof parsed.sourceSuggestionId === 'string') {
          parsedContext.sourceSuggestionId = parsed.sourceSuggestionId;
        }
      }
    } catch {
      // If JSON parsing fails, try to extract fields using a more robust regex
      // Match quoted strings that may contain escaped quotes and various markers
      // Use a more permissive pattern that captures until the closing quote
      const lastUserQuestionRegex = /"lastUserQuestion"\s*:\s*"((?:[^"\\]|\\.|__QWERY[^"]*)*)"/s;
      const lastAssistantResponseRegex = /"lastAssistantResponse"\s*:\s*"((?:[^"\\]|\\.|__QWERY[^"]*)*)"/s;
      const sourceSuggestionIdRegex = /"sourceSuggestionId"\s*:\s*"([^"]+)"/s;

      const lastUserQuestionMatch = contextJson.match(lastUserQuestionRegex);
      const lastAssistantResponseMatch = contextJson.match(lastAssistantResponseRegex);
      const sourceSuggestionIdMatch = contextJson.match(sourceSuggestionIdRegex);

      if (lastUserQuestionMatch && lastUserQuestionMatch[1]) {
        let value = lastUserQuestionMatch[1];
        // Remove nested context markers and suggestion guidance markers
        value = removeAllContextMarkers(value);
        // Unescape JSON string
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r');
        parsedContext.lastUserQuestion = value.trim();
      }
      if (lastAssistantResponseMatch && lastAssistantResponseMatch[1]) {
        let value = lastAssistantResponseMatch[1];
        // Remove nested context markers and suggestion guidance markers
        value = removeAllContextMarkers(value);
        // Unescape JSON string
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r');
        parsedContext.lastAssistantResponse = value.trim();
      }
      if (sourceSuggestionIdMatch && sourceSuggestionIdMatch[1]) {
        parsedContext.sourceSuggestionId = sourceSuggestionIdMatch[1];
      }
    }

    // Extract clean text (everything after the last context marker pair)
    let cleanText = messageText.substring(endIndex + contextEndMarker.length).trim();

    // Remove suggestion workflow guidance from clean text if present
    cleanText = cleanText.replace(/\[SUGGESTION WORKFLOW GUIDANCE\][\s\S]*?(?=\n\n|$)/g, '').trim();

    // Clean nested markers from context values (final cleanup)
    if (parsedContext.lastUserQuestion) {
      parsedContext.lastUserQuestion = removeAllContextMarkers(parsedContext.lastUserQuestion).trim();
    }
    if (parsedContext.lastAssistantResponse) {
      parsedContext.lastAssistantResponse = removeAllContextMarkers(parsedContext.lastAssistantResponse).trim();
    }

    // Only return context if it has at least one field
    if (parsedContext.lastUserQuestion || parsedContext.lastAssistantResponse) {
      return { text: cleanText, context: parsedContext };
    }

    return { text: cleanText };
  } catch (error) {
    // If all parsing fails, return cleaned text without markers
    const cleaned = removeAllContextMarkers(messageText).trim();
    return { text: cleaned || messageText };
  }
}

export function UserMessageBubble({
  text,
  context,
  messageId,
  className,
  datasources,
  pluginLogoMap,
}: UserMessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showContext, setShowContext] = useState({
    previousQuestion: false, // Closed by default
    previousResponse: false, // Closed by default
  });

  const hasContext = context && (context.lastUserQuestion || context.lastAssistantResponse);
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
        <div className="flex w-full max-w-[80%] justify-end">
          <DatasourceBadges
            datasources={datasources}
            pluginLogoMap={pluginLogoMap}
          />
        </div>
      )}
      <div className="flex items-start gap-0.5">
        {/* Scroll back button - outside the message bubble, on the left */}
        <Message from="user" className={cn('!w-auto !max-w-[80%] flex flex-row items-center gap-2', className)}>
        {hasSourceSuggestion && (
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 opacity-60 hover:opacity-100 shrink-0 mt-1 -ml-1"
            onClick={scrollToSourceSuggestion}
            title="Scroll to original suggestion"
          >
            <ArrowUpLeft className="size-3" />
          </Button>
        )}
        <MessageContent className="relative overflow-hidden min-w-0 max-w-full">
          {!isExpanded ? (
            // Compact mode - just show the suggestion text
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-sm font-semibold break-words min-w-0">{text}</span>
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
              <div className="absolute top-0 right-0 p-2 z-10">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-60 hover:opacity-100 p-1.5"
                  onClick={() => setIsExpanded(false)}
                  title="Collapse"
                >
                  <Minimize2 className="size-3" />
                </Button>
              </div>

              <div className="space-y-3 pr-16 min-w-0">
                {/* Main suggestion text - bold, no bottom margin */}
                <div className="mb-0 min-w-0">
                  <strong className="text-sm font-semibold break-words">{text}</strong>
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
                          className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
                        >
                          {showContext.previousQuestion ? (
                            <ChevronUp className="size-3" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )}
                          Previous Question
                        </button>
                        {showContext.previousQuestion && (
                          <div className="w-full min-w-0 overflow-hidden">
                            <div className="prose prose-sm dark:prose-invert max-w-none break-words overflow-wrap-anywhere">
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
                          className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
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
                            <div className="prose prose-sm dark:prose-invert max-w-none break-words overflow-wrap-anywhere">
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

