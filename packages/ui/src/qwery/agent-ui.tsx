'use client';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from '../ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '../ai-elements/message';
import {
  type PromptInputMessage,
  usePromptInputAttachments,
  PromptInputProvider,
  usePromptInputController,
} from '../ai-elements/prompt-input';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { useAgentStatus } from './agent-status-context';
import {
  CopyIcon,
  RefreshCcwIcon,
  CheckIcon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { Button } from '../shadcn/button';
import { Textarea } from '../shadcn/textarea';
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '../ai-elements/sources';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '../ai-elements/reasoning';
import { Tool, ToolHeader, ToolContent, ToolInput } from '../ai-elements/tool';
import { Loader } from '../ai-elements/loader';
import { ChatTransport, UIMessage, ToolUIPart } from 'ai';
import { toast } from 'sonner';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Sparkles } from 'lucide-react';
import { QweryPromptInput, type DatasourceItem, ToolPart } from './ai';
import { QweryContextProps } from './ai/context';

export interface QweryAgentUIProps {
  initialMessages?: UIMessage[];
  transport: (model: string) => ChatTransport<UIMessage>;
  models: { name: string; value: string }[];
  onOpen?: () => void;
  usage?: QweryContextProps;
  emitFinish?: () => void;
  // Datasource selector props
  datasources?: DatasourceItem[];
  selectedDatasources?: string[];
  onDatasourceSelectionChange?: (datasourceIds: string[]) => void;
  pluginLogoMap?: Map<string, string>;
  datasourcesLoading?: boolean;
  // Message persistence
  onMessageUpdate?: (messageId: string, content: string) => Promise<void>;
}

export default function QweryAgentUI(props: QweryAgentUIProps) {
  const {
    initialMessages,
    transport,
    models,
    onOpen,
    usage,
    emitFinish,
    datasources,
    selectedDatasources,
    onDatasourceSelectionChange,
    pluginLogoMap,
    datasourcesLoading,
    onMessageUpdate,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    if (!hasFocusedRef.current && containerRef.current) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (
              entry.isIntersecting &&
              entry.intersectionRatio > 0.3 &&
              !hasFocusedRef.current
            ) {
              hasFocusedRef.current = true;
              setTimeout(() => {
                textareaRef.current?.focus();
                onOpen?.();
              }, 300);
            }
          });
        },
        { threshold: 0.3 },
      );

      observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
      };
    }
  }, [onOpen]);

  const [state, setState] = useState({
    input: '',
    model: models[0]?.value ?? '',
    webSearch: false,
  });

  const transportInstance = useMemo(
    () => transport(state.model),
    [transport, state.model],
  );

  const { messages, sendMessage, status, regenerate, stop, setMessages } =
    useChat({
      messages: initialMessages,
      experimental_throttle: 100,
      transport: transportInstance,
    });

  const { setIsProcessing } = useAgentStatus();

  useEffect(() => {
    setIsProcessing(status === 'streaming' || status === 'submitted');
  }, [status, setIsProcessing]);

  // Update messages when initialMessages changes (e.g., when conversation loads)
  // This is important for notebook chat integration where messages load asynchronously
  const previousInitialMessagesRef = useRef<UIMessage[] | undefined>(undefined);
  useEffect(() => {
    // Only update if initialMessages actually changed
    if (initialMessages !== previousInitialMessagesRef.current) {
      previousInitialMessagesRef.current = initialMessages;
      
      if (initialMessages && initialMessages.length > 0) {
        // Check if messages are actually different
        const currentMessageIds = new Set(messages.map((m) => m.id));
        const initialMessageIds = new Set(initialMessages.map((m) => m.id));
        const idsMatch =
          currentMessageIds.size === initialMessageIds.size &&
          Array.from(currentMessageIds).every((id) => initialMessageIds.has(id));

        if (!idsMatch) {
          setMessages(initialMessages);
        }
      } else if (initialMessages && initialMessages.length === 0 && messages.length > 0) {
        // If initialMessages is empty array, clear messages (conversation was cleared)
        setMessages([]);
      } else if (!initialMessages && messages.length === 0) {
        // If initialMessages is undefined and we have no messages, that's fine
        // Don't update
      }
    }
  }, [initialMessages, setMessages, messages]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const regenCountRef = useRef<Map<string, number>>(new Map());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [copiedMessagePartId, setCopiedMessagePartId] = useState<string | null>(
    null,
  );

  // Message version management: store multiple versions of assistant responses grouped by user message
  // Map<userMessageId, UIMessage[]> - all assistant versions responding to each user message
  const [messageVersions, setMessageVersions] = useState<
    Map<string, UIMessage[]>
  >(new Map());
  // Map<userMessageId, number> - current version index for each user message
  const [currentVersionIndices, setCurrentVersionIndices] = useState<
    Map<string, number>
  >(new Map());
  // Map<userMessageId, assistantVersionId> - tracks which version of assistant message each user message responds to
  // This creates conversation branches: different user messages can respond to different versions
  const [userMessageToVersion, setUserMessageToVersion] = useState<
    Map<string, string>
  >(new Map());

  // Handle edit message
  const _handleEditStart = useCallback((messageId: string, text: string) => {
    setEditingMessageId(messageId);
    setEditText(text);
  }, []);

  const handleEditCancel = useCallback(() => {
    setEditingMessageId(null);
    setEditText('');
  }, []);

  const handleEditSubmit = useCallback(async () => {
    if (!editingMessageId || !editText.trim()) return;

    const updatedText = editText.trim();

    // Update UI state immediately
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id === editingMessageId) {
          return {
            ...msg,
            parts: msg.parts.map((p) =>
              p.type === 'text' ? { ...p, text: updatedText } : p,
            ),
          };
        }
        return msg;
      }),
    );

    setEditingMessageId(null);
    setEditText('');

    // Persist to database if callback provided
    if (onMessageUpdate) {
      try {
        await onMessageUpdate(editingMessageId, updatedText);
      } catch (error) {
        console.error('Failed to persist message edit:', error);
        // Optionally show error toast here
      }
    }
  }, [editingMessageId, editText, setMessages, onMessageUpdate]);

  const handleRegenerate = useCallback(async () => {
    const lastAssistantMessage = messages
      .filter((m) => m.role === 'assistant')
      .at(-1);
    if (lastAssistantMessage) {
      const current = regenCountRef.current.get(lastAssistantMessage.id) ?? 0;
      regenCountRef.current.set(lastAssistantMessage.id, current + 1);

      // Find the user message this assistant response is tied to
      const lastUserMessage = messages
        .filter((m) => m.role === 'user')
        .at(-1);

      if (lastUserMessage) {
        // Save current assistant version before regeneration
        setMessageVersions((prev) => {
          const newVersions = new Map(prev);
          const existingVersions = newVersions.get(lastUserMessage.id) ?? [];
          
          // Check if this version is already stored
          const isAlreadyStored = existingVersions.some(
            (v) => v.id === lastAssistantMessage.id,
          );
          
          if (!isAlreadyStored) {
            // Add current version to the versions array
            newVersions.set(lastUserMessage.id, [
              ...existingVersions,
              lastAssistantMessage,
            ]);
          }
          
          return newVersions;
        });
      }
    }

    regenerate();
  }, [messages, regenerate]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement !== textareaRef.current &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const lastAssistantMessage = useMemo(
    () => messages.filter((m) => m.role === 'assistant').at(-1),
    [messages],
  );

  // Helper to get the displayed version of an assistant message
  // Follows the version chain: if there's a next user message tied to a specific version, show that version
  // Otherwise, show the currently selected version (for the last assistant message)
  const getDisplayedMessage = useCallback(
    (message: UIMessage): UIMessage => {
      if (message.role !== 'assistant') {
        return message;
      }

      // Find the user message this assistant response is tied to
      const messageIndex = messages.findIndex((m) => m.id === message.id);
      if (messageIndex === -1) return message;

      // Find the last user message before this assistant message
      let userMessageId: string | null = null;
      for (let i = messageIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && msg.role === 'user') {
          userMessageId = msg.id;
          break;
        }
      }

      if (!userMessageId) return message;

      // Check if there are multiple versions for this user message
      const versions = messageVersions.get(userMessageId);
      if (!versions || versions.length <= 1) return message;

      // Check if there's a next user message that responds to this assistant message
      // If so, use the version that user message is tied to (follow the branch)
      let useVersion: UIMessage | null = null;
      let foundNextUser = false;
      
      for (let j = messageIndex + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg && nextMsg.role === 'user') {
          foundNextUser = true;
          // Check if this user message is tied to a specific version of this assistant message
          const tiedVersionId = userMessageToVersion.get(nextMsg.id);
          if (tiedVersionId) {
            // Find this version in the versions array
            const tiedVersion = versions.find((v) => v.id === tiedVersionId);
            if (tiedVersion) {
              useVersion = tiedVersion;
              break;
            }
          }
          // If this user message doesn't have a tied version, it means it responds to the latest
          // So we should use the latest version
          useVersion = versions[versions.length - 1];
          break;
        }
      }

      // If no next user message found, this is the last assistant message
      // Use the currently selected version (for navigation)
      if (!foundNextUser) {
        const currentIndex = currentVersionIndices.get(userMessageId) ?? versions.length - 1;
        useVersion = versions[currentIndex] ?? null;
      }

      // Return the version if it exists, otherwise return original message
      return useVersion ?? message;
    },
    [messages, messageVersions, currentVersionIndices, userMessageToVersion],
  );

  // Filter messages to only show those in the active branch based on selected versions
  // When user changes version of an older message, subsequent messages from different branches are hidden
  const getFilteredMessages = useCallback((): UIMessage[] => {
    const filtered: UIMessage[] = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      
      if (msg.role === 'assistant') {
        // Find the user message this assistant response is tied to
        let userMessageId: string | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg && prevMsg.role === 'user') {
            userMessageId = prevMsg.id;
            break;
          }
        }

        if (userMessageId) {
          const versions = messageVersions.get(userMessageId);
          if (versions && versions.length > 1) {
            // Get the currently displayed version (from currentVersionIndices)
            const currentIndex = currentVersionIndices.get(userMessageId) ?? versions.length - 1;
            const displayedVersion = versions[currentIndex];
            
            if (displayedVersion) {
              // Check if there's a next user message that responds to this assistant message
              let shouldIncludeNext = true;
              for (let j = i + 1; j < messages.length; j++) {
                const nextMsg = messages[j];
                if (nextMsg && nextMsg.role === 'user') {
                  // Check if this user message is tied to a version of this assistant message
                  const tiedVersionId = userMessageToVersion.get(nextMsg.id);
                  if (tiedVersionId) {
                    // If the user message is tied to a different version than currently displayed,
                    // don't include it and everything after (it's a different branch)
                    if (tiedVersionId !== displayedVersion.id) {
                      shouldIncludeNext = false;
                    }
                  } else {
                    // If user message doesn't have a tied version, it means it responds to the latest version
                    // Only include if we're showing the latest version
                    const latestVersion = versions[versions.length - 1];
                    if (latestVersion && displayedVersion.id !== latestVersion.id) {
                      shouldIncludeNext = false;
                    }
                  }
                  break;
                }
              }
              
              // Always include the assistant message with the selected version
              filtered.push(displayedVersion);
              
              // If we shouldn't include next messages, stop here
              if (!shouldIncludeNext) {
                break;
              }
            } else {
              filtered.push(msg);
            }
          } else {
            filtered.push(msg);
          }
        } else {
          filtered.push(msg);
        }
      } else {
        // For user messages, include them if we haven't stopped filtering yet
        filtered.push(msg);
      }
    }
    
    return filtered;
  }, [messages, messageVersions, currentVersionIndices, userMessageToVersion]);

  // Navigation handlers
  const goToPreviousVersion = useCallback(
    (userMessageId: string) => {
      const versions = messageVersions.get(userMessageId);
      if (!versions || versions.length <= 1) return;

      setCurrentVersionIndices((prev) => {
        const newIndices = new Map(prev);
        const currentIndex = newIndices.get(userMessageId) ?? versions.length - 1;
        const newIndex = currentIndex > 0 ? currentIndex - 1 : versions.length - 1;
        newIndices.set(userMessageId, newIndex);
        return newIndices;
      });
    },
    [messageVersions],
  );

  const goToNextVersion = useCallback(
    (userMessageId: string) => {
      const versions = messageVersions.get(userMessageId);
      if (!versions || versions.length <= 1) return;

      setCurrentVersionIndices((prev) => {
        const newIndices = new Map(prev);
        const currentIndex = newIndices.get(userMessageId) ?? versions.length - 1;
        const newIndex =
          currentIndex < versions.length - 1 ? currentIndex + 1 : 0;
        newIndices.set(userMessageId, newIndex);
        return newIndices;
      });
    },
    [messageVersions],
  );

  // Compute regen counts for all messages to avoid ref access during render
  const [regenCountsMap, setRegenCountsMap] = useState<Map<string, number>>(
    new Map(),
  );

  useEffect(() => {
    if (status === 'ready') {
      emitFinish?.();
    }
  }, [status, emitFinish]);

  useEffect(() => {
    const counts = new Map<string, number>();
    messages.forEach((msg) => {
      counts.set(msg.id, regenCountRef.current.get(msg.id) ?? 0);
    });
    // Use setTimeout to avoid synchronous setState in effect
    setTimeout(() => setRegenCountsMap(counts), 0);
  }, [messages]);

  return (
    <PromptInputProvider initialInput={state.input}>
      <div
        ref={containerRef}
        className="relative mx-auto flex h-full w-full max-w-4xl min-w-0 flex-col p-6"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Conversation className="min-h-0 min-w-0 flex-1">
            <ConversationContent className="min-w-0">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  title="Start a conversation"
                  description="Ask me anything and I'll help you out. You can ask questions or get explanations."
                  icon={<Sparkles className="text-muted-foreground size-12" />}
                />
              ) : (
                getFilteredMessages().map((message) => {
                  // Get the displayed version of the message (if it has multiple versions)
                  // Filtered messages are original messages (for ID preservation), but we display the selected version
                  const displayMessage = getDisplayedMessage(message);
                  
                  const sourceParts = displayMessage.parts.filter(
                    (part: { type: string }) => part.type === 'source-url',
                  );

                  const textParts = displayMessage.parts.filter(
                    (p) => p.type === 'text',
                  );
                  const isLastAssistantMessage =
                    message.id === lastAssistantMessage?.id;
                  const regenCount = regenCountsMap.get(message.id) ?? 0;

                  const lastTextPartIndex =
                    textParts.length > 0
                      ? displayMessage.parts.findLastIndex((p) => p.type === 'text')
                      : -1;

                  // Find the user message this assistant response is tied to (for navigation)
                  const messageIndex = messages.findIndex((m) => m.id === message.id);
                  let userMessageId: string | null = null;
                  if (message.role === 'assistant' && messageIndex !== -1) {
                    for (let i = messageIndex - 1; i >= 0; i--) {
                      const msg = messages[i];
                      if (msg && msg.role === 'user') {
                        userMessageId = msg.id;
                        break;
                      }
                    }
                  }
                  const versions = userMessageId
                    ? messageVersions.get(userMessageId) ?? []
                    : [];
                  const currentVersionIndex = userMessageId
                    ? currentVersionIndices.get(userMessageId) ?? versions.length - 1
                    : 0;
                  const hasMultipleVersions = versions.length > 1;

                  return (
                    <div key={message.id}>
                      {displayMessage.role === 'assistant' &&
                        sourceParts.length > 0 && (
                          <Sources>
                            <SourcesTrigger count={sourceParts.length} />
                            {sourceParts.map((part, i: number) => {
                              const sourcePart = part as {
                                type: 'source-url';
                                url?: string;
                              };
                              return (
                                <SourcesContent key={`${displayMessage.id}-${i}`}>
                                  <Source
                                    key={`${displayMessage.id}-${i}`}
                                    href={sourcePart.url}
                                    title={sourcePart.url}
                                  />
                                </SourcesContent>
                              );
                            })}
                          </Sources>
                        )}
                      {displayMessage.parts.map((part, i: number) => {
                        const isLastTextPart =
                          part.type === 'text' && i === lastTextPartIndex;
                        const isStreaming =
                          status === 'streaming' &&
                          isLastAssistantMessage &&
                          isLastTextPart;
                        const isResponseComplete =
                          !isStreaming &&
                          isLastAssistantMessage &&
                          isLastTextPart;
                        switch (part.type) {
                          case 'text': {
                            const isEditing = editingMessageId === displayMessage.id;
                            return (
                              <div
                                key={`${message.id}-${i}`}
                                className={cn(
                                  'flex items-start gap-3',
                                  message.role === 'user' && 'justify-end',
                                  message.role === 'assistant' &&
                                    'animate-in fade-in slide-in-from-bottom-4 duration-300',
                                  message.role === 'user' &&
                                    'animate-in fade-in slide-in-from-bottom-4 duration-300',
                                )}
                              >
                                {displayMessage.role === 'assistant' && (
                                  <div className="mt-1 shrink-0">
                                    <BotAvatar
                                      size={6}
                                      isLoading={isStreaming}
                                    />
                                  </div>
                                )}
                                <div className="flex-end flex w-full max-w-[80%] min-w-0 flex-col justify-start gap-2">
                                  {isEditing && displayMessage.role === 'user' ? (
                                    <>
                                      <Textarea
                                        value={editText}
                                        onChange={(e) =>
                                          setEditText(e.target.value)
                                        }
                                        className="min-h-[60px] resize-none"
                                        onKeyDown={(e) => {
                                          if (
                                            e.key === 'Enter' &&
                                            (e.metaKey || e.ctrlKey)
                                          ) {
                                            e.preventDefault();
                                            handleEditSubmit();
                                          } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            handleEditCancel();
                                          }
                                        }}
                                        autoFocus
                                      />
                                      <div className="mt-1 flex items-center justify-end gap-2">
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={handleEditSubmit}
                                          className="h-7 w-7"
                                          title="Save"
                                        >
                                          <CheckIcon className="size-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={handleEditCancel}
                                          className="h-7 w-7"
                                          title="Cancel"
                                        >
                                          <XIcon className="size-3" />
                                        </Button>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      {!isStreaming && (
                                        <Message
                                          from={message.role}
                                          className="w-full"
                                        >
                                          <MessageContent>
                                            <div className="inline-flex items-baseline gap-0.5">
                                              <MessageResponse>
                                                {part.text}
                                              </MessageResponse>
                                            </div>
                                          </MessageContent>
                                        </Message>
                                      )}
                                      {isStreaming && (
                                        <Message
                                          from={message.role}
                                          className="w-full"
                                        >
                                          <MessageContent>
                                            <div className="inline-flex items-baseline gap-0.5">
                                              <MessageResponse>
                                                {part.text}
                                              </MessageResponse>
                                            </div>
                                          </MessageContent>
                                        </Message>
                                      )}
                                      {/* Actions below the bubble */}
                                      {/* Show actions for completed responses, or for assistant messages with versions (on last text part), or for user messages */}
                                      {((isResponseComplete ||
                                        (displayMessage.role === 'user' &&
                                          isLastTextPart)) ||
                                        (displayMessage.role === 'assistant' &&
                                          hasMultipleVersions &&
                                          isLastTextPart)) && (
                                        <div
                                          className={cn(
                                            'mt-1 flex items-center gap-2',
                                            displayMessage.role === 'user' &&
                                              'justify-end',
                                          )}
                                        >
                                          {displayMessage.role === 'assistant' && (
                                            <>
                                              {/* Version navigation arrows - show even during streaming if versions exist */}
                                              {hasMultipleVersions && (
                                                <>
                                                  <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => {
                                                      if (userMessageId && !isStreaming) {
                                                        goToPreviousVersion(userMessageId);
                                                      }
                                                    }}
                                                    disabled={isStreaming}
                                                    className="h-7 w-7"
                                                    title="Previous version"
                                                  >
                                                    <ChevronLeftIcon className="size-3" />
                                                  </Button>
                                                  <span className="text-muted-foreground text-xs">
                                                    {currentVersionIndex + 1} / {versions.length}
                                                  </span>
                                                  <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => {
                                                      if (userMessageId && !isStreaming) {
                                                        goToNextVersion(userMessageId);
                                                      }
                                                    }}
                                                    disabled={isStreaming}
                                                    className="h-7 w-7"
                                                    title="Next version"
                                                  >
                                                    <ChevronRightIcon className="size-3" />
                                                  </Button>
                                                </>
                                              )}
                                              {/* Only show regenerate button for last assistant message when not streaming */}
                                              {isResponseComplete && (
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  onClick={handleRegenerate}
                                                  className="h-7 w-7"
                                                  title="Retry"
                                                >
                                                  <RefreshCcwIcon className="size-3" />
                                                </Button>
                                              )}
                                            </>
                                          )}
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={async () => {
                                              const partId = `${displayMessage.id}-${i}`;
                                              try {
                                                await navigator.clipboard.writeText(
                                                  part.text,
                                                );
                                                setCopiedMessagePartId(partId);
                                                setTimeout(() => {
                                                  setCopiedMessagePartId(null);
                                                }, 2000);
                                              } catch (error) {
                                                console.error(
                                                  'Failed to copy:',
                                                  error,
                                                );
                                              }
                                            }}
                                            className="h-7 w-7"
                                            title={
                                              copiedMessagePartId ===
                                              `${displayMessage.id}-${i}`
                                                ? 'Copied!'
                                                : 'Copy'
                                            }
                                          >
                                            {copiedMessagePartId ===
                                            `${displayMessage.id}-${i}` ? (
                                              <CheckIcon className="size-3 text-green-600" />
                                            ) : (
                                              <CopyIcon className="size-3" />
                                            )}
                                          </Button>
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                                {displayMessage.role === 'user' && (
                                  <div className="mt-1 size-6 shrink-0" />
                                )}
                              </div>
                            );
                          }
                          case 'reasoning':
                            return (
                              <Reasoning
                                key={`${displayMessage.id}-${i}`}
                                className="w-full"
                                isStreaming={
                                  status === 'streaming' &&
                                  i === displayMessage.parts.length - 1 &&
                                  displayMessage.id === messages.at(-1)?.id
                                }
                              >
                                <ReasoningTrigger />
                                <ReasoningContent>{part.text}</ReasoningContent>
                              </Reasoning>
                            );
                          default:
                            if (part.type.startsWith('tool-')) {
                              const toolPart = part as ToolUIPart;
                              const inProgressStates = new Set([
                                'input-streaming',
                                'input-available',
                                'approval-requested',
                              ]);
                              const isToolInProgress = inProgressStates.has(
                                toolPart.state as string,
                              );

                              // Show loader while tool is in progress
                              if (isToolInProgress) {
                                const toolName =
                                  'toolName' in toolPart &&
                                  typeof toolPart.toolName === 'string'
                                    ? toolPart.toolName
                                    : toolPart.type.replace('tool-', '');
                                return (
                                  <Tool
                                    key={`${message.id}-${i}`}
                                    defaultOpen={false}
                                  >
                                    <ToolHeader
                                      title={toolName}
                                      type={toolPart.type}
                                      state={toolPart.state}
                                    />
                                    <ToolContent>
                                      {toolPart.input != null ? (
                                        <ToolInput input={toolPart.input} />
                                      ) : null}
                                      <div className="flex items-center justify-center py-8">
                                        <Loader size={20} />
                                      </div>
                                    </ToolContent>
                                  </Tool>
                                );
                              }

                              // Use ToolPart component for completed tools (includes visualizers)
                              return (
                                <ToolPart
                                  key={`${message.id}-${i}`}
                                  part={toolPart}
                                  messageId={message.id}
                                  index={i}
                                />
                              );
                            }
                            return null;
                        }
                      })}
                    </div>
                  );
                })
              )}
              {status === 'submitted' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 flex items-start gap-3 duration-300">
                  <BotAvatar
                    size={6}
                    isLoading={true}
                    className="mt-1 shrink-0"
                  />
                  <div className="flex-end flex w-full max-w-[80%] min-w-0 flex-col justify-start gap-2">
                    <Message from="assistant" className="w-full">
                      <MessageContent>
                        <div className="inline-flex items-baseline gap-0.5">
                          <MessageResponse></MessageResponse>
                        </div>
                      </MessageContent>
                    </Message>
                  </div>
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        <div className="shrink-0">
          <PromptInputInner
            sendMessage={sendMessageWithVersions}
            state={state}
            setState={setState}
            textareaRef={textareaRef}
            status={status}
            stop={stop}
            setMessages={setMessages}
            messages={messages}
            models={models}
            usage={usage}
            datasources={datasources}
            selectedDatasources={selectedDatasources}
            onDatasourceSelectionChange={onDatasourceSelectionChange}
            pluginLogoMap={pluginLogoMap}
            datasourcesLoading={datasourcesLoading}
          />
        </div>
      </div>
    </PromptInputProvider>
  );
}

function PromptInputInner({
  sendMessage,
  state,
  setState,
  textareaRef,
  status,
  stop,
  setMessages: _setMessages,
  messages: _messages,
  models,
  usage,
  datasources,
  selectedDatasources,
  onDatasourceSelectionChange,
  pluginLogoMap,
  datasourcesLoading,
}: {
  sendMessage: ReturnType<typeof useChat>['sendMessage'];
  state: { input: string; model: string; webSearch: boolean };
  setState: React.Dispatch<
    React.SetStateAction<{ input: string; model: string; webSearch: boolean }>
  >;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  status: ReturnType<typeof useChat>['status'];
  stop: ReturnType<typeof useChat>['stop'];
  setMessages: ReturnType<typeof useChat>['setMessages'];
  messages: ReturnType<typeof useChat>['messages'];
  models: { name: string; value: string }[];
  usage?: QweryContextProps;
  datasources?: DatasourceItem[];
  selectedDatasources?: string[];
  onDatasourceSelectionChange?: (datasourceIds: string[]) => void;
  pluginLogoMap?: Map<string, string>;
  datasourcesLoading?: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const controller = usePromptInputController();

  const handleSubmit = async (message: PromptInputMessage) => {
    if (status === 'streaming' || status === 'submitted') {
      return;
    }

    const hasText = Boolean(message.text?.trim());
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    // Clear input immediately on submit (button click or Enter press)
    controller.textInput.clear();
    setState((prev) => ({ ...prev, input: '' }));

    try {
      await sendMessage(
        {
          text: message.text || 'Sent with attachments',
          files: message.files,
        },
        {
          body: {
            model: state.model,
            webSearch: state.webSearch,
          },
        },
      );
      attachments.clear();
      // Don't clear input here - it's already cleared on submit
      // The input should only be cleared on explicit user action (submit button or Enter)
    } catch {
      toast.error('Failed to send message. Please try again.');
      // On error, restore the input so user can retry
      if (message.text) {
        setState((prev) => ({ ...prev, input: message.text }));
      }
    }
  };

  const handleStop = async () => {
    // Don't remove the message - keep whatever was generated so far
    stop();
  };

  return (
    <QweryPromptInput
      onSubmit={handleSubmit}
      input={state.input}
      setInput={(input) => setState((prev) => ({ ...prev, input }))}
      model={state.model}
      setModel={(model) => setState((prev) => ({ ...prev, model }))}
      models={models}
      status={status}
      textareaRef={textareaRef}
      onStop={handleStop}
      stopDisabled={false}
      attachmentsCount={attachments.files.length}
      usage={usage}
      datasources={datasources}
      selectedDatasources={selectedDatasources}
      onDatasourceSelectionChange={onDatasourceSelectionChange}
      pluginLogoMap={pluginLogoMap}
      datasourcesLoading={datasourcesLoading}
    />
  );
}
