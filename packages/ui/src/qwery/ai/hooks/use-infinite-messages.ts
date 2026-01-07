import { useState, useCallback, useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import type { MessageOutput } from '@qwery/domain/usecases';
import { MessageRole } from '@qwery/domain/entities';

/**
 * Default number of messages to load per page
 */
export const DEFAULT_MESSAGES_PER_PAGE = 10;

interface UseInfiniteMessagesOptions {
    conversationSlug: string;
    initialMessages: UIMessage[];
    messagesPerPage?: number;
}

interface UseInfiniteMessagesReturn {
    messages: UIMessage[];
    firstItemIndex: number;
    isLoadingOlder: boolean;
    hasMoreOlder: boolean;
    loadError: Error | null;
    loadOlderMessages: () => Promise<void>;
    retryLoadOlder: () => void;
    addNewMessage: (message: UIMessage) => void;
    updateMessage: (id: string, updates: Partial<UIMessage>) => void;
    mergeMessages: (newMessages: UIMessage[]) => void;
}

/**
 * Converts MessageOutput[] to UIMessage[]
 * This is a simplified version of the conversion logic
 */
function convertMessageOutputToUIMessage(
    message: MessageOutput,
): UIMessage {
    // Extract createdAt from MessageOutput for cursor-based pagination
    const createdAt =
        message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : new Date(message.createdAt).toISOString();

    // Check if content already contains a UIMessage structure (with parts and role)
    if (
        typeof message.content === 'object' &&
        message.content !== null &&
        'parts' in message.content &&
        Array.isArray(message.content.parts) &&
        'role' in message.content
    ) {
        // Content already contains full UIMessage structure - restore all fields
        const existingMetadata =
            'metadata' in message.content
                ? (message.content.metadata as Record<string, unknown>)
                : {};

        return {
            id: message.id,
            role: message.content.role as 'user' | 'assistant' | 'system',
            metadata: {
                ...existingMetadata,
                createdAt, // Store createdAt in metadata for cursor extraction
            },
            parts: message.content.parts as UIMessage['parts'],
        };
    }

    // Fallback: Legacy format - reconstruct from MessageRole and content
    let role: 'user' | 'assistant' | 'system';
    if (message.role === MessageRole.USER) {
        role = 'user';
    } else if (message.role === MessageRole.ASSISTANT) {
        role = 'assistant';
    } else if (message.role === MessageRole.SYSTEM) {
        role = 'system';
    } else {
        role = 'assistant';
    }

    // Extract text from content object (legacy format)
    const text =
        typeof message.content === 'object' &&
            message.content !== null &&
            'text' in message.content
            ? String(message.content.text)
            : typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content);

    return {
        id: message.id,
        role,
        metadata: {
            createdAt, // Store createdAt in metadata for cursor extraction
        },
        parts: [{ type: 'text', text }],
    };
}

function extractTimestamp(message: UIMessage): string | null {
    if (message.metadata && typeof message.metadata === 'object') {
        const meta = message.metadata as Record<string, unknown>;
        if (meta.createdAt) {
            if (typeof meta.createdAt === 'string') {
                return meta.createdAt;
            }
            if (meta.createdAt instanceof Date) {
                return meta.createdAt.toISOString();
            }
        }
    }
    console.error('Cannot extract timestamp from message', message);
    return null;
}

export function useInfiniteMessages(
    options: UseInfiniteMessagesOptions,
): UseInfiniteMessagesReturn {
    const { conversationSlug, initialMessages, messagesPerPage = DEFAULT_MESSAGES_PER_PAGE } = options;

    // Start with high index for firstItemIndex pattern
    const [firstItemIndex, setFirstItemIndex] = useState(100000);
    const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [hasMoreOlder, setHasMoreOlder] = useState(true);
    const [loadError, setLoadError] = useState<Error | null>(null);
    const [olderCursor, setOlderCursor] = useState<string | null>(() => {
        if (initialMessages.length > 0 && initialMessages[0]) {
            const oldest = initialMessages[0];
            return extractTimestamp(oldest);
        }
        return null;
    });

    // Track last synced message count to avoid unnecessary full merges
    const lastSyncedLengthRef = useRef(0);

    // Sync with initialMessages changes (when conversation changes)
    useEffect(() => {
        if (!Array.isArray(initialMessages)) {
            console.warn('initialMessages is not an array, resetting to empty array');
            setMessages([]);
            setFirstItemIndex(100000);
            setHasMoreOlder(false);
            setOlderCursor(null);
            setLoadError(null);
            lastSyncedLengthRef.current = 0;
            return;
        }

        setMessages(initialMessages);
        setFirstItemIndex(100000);
        
        if (initialMessages.length > 0 && initialMessages[0]) {
            const cursor = extractTimestamp(initialMessages[0]);
            if (cursor) {
                setOlderCursor(cursor);
                setHasMoreOlder(initialMessages.length >= messagesPerPage);
            } else {
                console.warn('Could not extract cursor from oldest message, assuming no more messages');
                setHasMoreOlder(false);
                setOlderCursor(null);
            }
        } else {
            // Empty conversation
            setHasMoreOlder(false);
            setOlderCursor(null);
        }
        setLoadError(null);
        lastSyncedLengthRef.current = initialMessages.length;
    }, [initialMessages, messagesPerPage]);

    const loadOlderMessages = useCallback(async () => {
        // Prevent concurrent loads and invalid states
        if (isLoadingOlder || !hasMoreOlder) return;
        
        if (!olderCursor) {
            setHasMoreOlder(false);
            return;
        }

        if (!conversationSlug || conversationSlug.trim() === '') {
            setLoadError(new Error('Invalid conversation slug'));
            return;
        }

        setIsLoadingOlder(true);
        setLoadError(null);
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch(
                `/api/messages?conversationSlug=${encodeURIComponent(conversationSlug)}&cursor=${encodeURIComponent(olderCursor)}&limit=${messagesPerPage}`,
                { signal: controller.signal },
            );

            clearTimeout(timeoutId);

            if (!response.ok) {
                // Handle specific error codes
                if (response.status === 404) {
                    throw new Error('Conversation not found');
                } else if (response.status === 400) {
                    throw new Error('Invalid request parameters');
                } else if (response.status >= 500) {
                    throw new Error('Server error. Please try again later.');
                } else {
                    throw new Error(
                        `Failed to load messages: ${response.statusText} (${response.status})`,
                    );
                }
            }

            const result = await response.json();
            
            // Validate response structure
            if (!result || typeof result !== 'object') {
                throw new Error('Invalid response format from server');
            }

            const { messages: olderMessages, nextCursor, hasMore } = result;

            // Validate messages array
            if (!Array.isArray(olderMessages)) {
                throw new Error('Invalid messages format in response');
            }

            if (olderMessages.length === 0) {
                setHasMoreOlder(false);
            } else {
                // Convert and validate messages
                const messageOutputs = olderMessages as MessageOutput[];
                const convertedMessages = messageOutputs
                    .map((output) => {
                        try {
                            return convertMessageOutputToUIMessage(output);
                        } catch (error) {
                            console.warn('Failed to convert message:', output, error);
                            return null;
                        }
                    })
                    .filter((msg): msg is UIMessage => msg !== null);

                // Only update if we have valid messages
                if (convertedMessages.length > 0) {
                    setFirstItemIndex((prev) => prev - convertedMessages.length);
                    setMessages((prev) => [...convertedMessages, ...prev]);
                    
                    // Update cursor - validate it exists
                    if (nextCursor && typeof nextCursor === 'string') {
                        setOlderCursor(nextCursor);
                    } else {
                        // If no valid cursor, check if we got fewer messages than requested
                        setHasMoreOlder(convertedMessages.length >= messagesPerPage);
                    }
                    
                    // Update hasMore based on API response
                    setHasMoreOlder(hasMore === true);
                } else {
                    // No valid messages after conversion - likely no more exist
                    setHasMoreOlder(false);
                }
            }
        } catch (error) {
            // Handle abort (timeout)
            if (error instanceof Error && error.name === 'AbortError') {
                setLoadError(new Error('Request timed out. Please try again.'));
            } else if (error instanceof TypeError && error.message.includes('fetch')) {
                // Network error
                setLoadError(new Error('Network error. Please check your connection and try again.'));
            } else {
                console.error('Failed to load older messages:', error);
                setLoadError(
                    error instanceof Error ? error : new Error('Failed to load messages'),
                );
            }
        } finally {
            setIsLoadingOlder(false);
        }
    }, [conversationSlug, olderCursor, isLoadingOlder, hasMoreOlder, messagesPerPage]);

    const retryLoadOlder = useCallback(() => {
        setLoadError(null);
        loadOlderMessages();
    }, [loadOlderMessages]);

    const addNewMessage = useCallback((message: UIMessage) => {
        // Validate message
        if (!message || !message.id) {
            console.warn('addNewMessage received invalid message, ignoring');
            return;
        }

        setMessages((prev) => {
            // Deduplicate by ID
            if (prev.some((m) => m.id === message.id)) {
                return prev;
            }
            return [...prev, message];
        });
    }, []);

    const updateMessage = useCallback(
        (id: string, updates: Partial<UIMessage>) => {
            // Validate inputs
            if (!id || typeof id !== 'string') {
                console.warn('updateMessage received invalid id, ignoring');
                return;
            }
            if (!updates || typeof updates !== 'object') {
                console.warn('updateMessage received invalid updates, ignoring');
                return;
            }

            setMessages((prev) =>
                prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
            );
        },
        [],
    );

    const mergeMessages = useCallback((newMessages: UIMessage[]) => {
        // Validate input
        if (!Array.isArray(newMessages)) {
            console.warn('mergeMessages received non-array input, ignoring');
            return;
        }

        setMessages((prev) => {
            // If conversation switched (length decreased), do full reset
            if (newMessages.length < lastSyncedLengthRef.current) {
                lastSyncedLengthRef.current = newMessages.length;
                setFirstItemIndex(100000);
                return newMessages;
            }

            // Only merge new messages (optimization: avoid full array scan)
            if (newMessages.length > lastSyncedLengthRef.current) {
                const newMessagesToAdd = newMessages.slice(
                    lastSyncedLengthRef.current,
                );
                const existingIds = new Set(prev.map((m) => m.id));
                const toAdd = newMessagesToAdd.filter((m) => !existingIds.has(m.id));
                const toUpdate = newMessagesToAdd.filter((m) => existingIds.has(m.id));

                // Update existing messages (for streaming updates)
                let updated = prev.map((m) => {
                    const update = toUpdate.find((u) => u.id === m.id);
                    return update ? { ...m, ...update } : m;
                });

                lastSyncedLengthRef.current = newMessages.length;
                return [...updated, ...toAdd];
            }

            // No new messages, just update existing ones (streaming updates)
            const existingIds = new Set(prev.map((m) => m.id));
            const toUpdate = newMessages.filter((m) => existingIds.has(m.id));

            if (toUpdate.length === 0) {
                return prev;
            }

            // Update existing messages (e.g., streaming content updates)
            return prev.map((m) => {
                const update = toUpdate.find((u) => u.id === m.id);
                return update ? { ...m, ...update } : m;
            });
        });
    }, []);

    return {
        messages,
        firstItemIndex,
        isLoadingOlder,
        hasMoreOlder,
        loadError,
        loadOlderMessages,
        retryLoadOlder,
        addNewMessage,
        updateMessage,
        mergeMessages,
    };
}
