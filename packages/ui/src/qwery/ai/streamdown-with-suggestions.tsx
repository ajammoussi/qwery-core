'use client';

import { useEffect, useRef, memo } from 'react';
import { MessageResponse } from '../../ai-elements/message';
import { SuggestionButton } from './suggestion-button';
import type { UIMessage, ToolUIPart } from 'ai';
import type { useChat } from '@ai-sdk/react';
import { createPortal } from 'react-dom';
import { parseMessageWithContext } from './user-message-bubble';

export interface StreamdownWithSuggestionsProps {
  children: string;
  className?: string;
  sendMessage?: ReturnType<typeof useChat>['sendMessage'];
  messages?: UIMessage[];
  currentMessageId?: string;
}

// Detect agent-injected suggestion pattern: {{suggestion: text}}
const isSuggestionPattern = (text: string): boolean => {
  // Match custom pattern {{suggestion: text}} - this won't be interpreted as a markdown link
  return /\{\{suggestion:\s*([^}]+)\}\}/.test(text);
};

// Extract suggestion text from pattern {{suggestion: text}}
const extractSuggestionText = (text: string): string | null => {
  const match = text.match(/\{\{suggestion:\s*([^}]+)\}\}/);
  return match && match[1] ? match[1].trim() : null;
};

/**
 * Gets status label for tool state
 */
function getToolStatusLabel(state: string | undefined): string {
  const statusMap: Record<string, string> = {
    'input-streaming': 'Pending',
    'input-available': 'Processing',
    'approval-requested': 'Awaiting Approval',
    'approval-responded': 'Responded',
    'output-available': 'Completed',
    'output-error': 'Error',
    'output-denied': 'Denied',
  };
  return statusMap[state ?? ''] ?? state ?? 'Unknown';
}

/**
 * Formats tool calls as markdown text
 * Returns formatted string with tool calls listed and text response after
 */
function formatToolCalls(parts: UIMessage['parts']): string {
  const toolCalls: string[] = [];
  const textParts: string[] = [];

  // Process parts in order
  for (const part of parts) {
    if (part.type === 'text' && 'text' in part && part.text.trim()) {
      textParts.push(part.text.trim());
    } else if (part.type.startsWith('tool-')) {
      const toolName = part.type.replace('tool-', '');
      // Format tool name nicely (camelCase/snake_case to Title Case)
      const formattedName = toolName
        .replace(/([A-Z])/g, ' $1') // Add space before capitals
        .replace(/_/g, ' ') // Replace underscores with spaces
        .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
      
      // Get status if available
      const toolPart = part as ToolUIPart;
      const status = toolPart.state ? getToolStatusLabel(toolPart.state) : null;
      
      // Format with status if available
      if (status) {
        toolCalls.push(`**${formattedName}** called (${status})`);
      } else {
        toolCalls.push(`**${formattedName}** called`);
      }
    }
  }

  // Build result: tool calls first, then text response
  const result: string[] = [];
  if (toolCalls.length > 0) {
    // Format as a list if multiple tools, or inline if single
    if (toolCalls.length === 1 && toolCalls[0]) {
      result.push(toolCalls[0]);
    } else {
      result.push(toolCalls.map((tc) => `- ${tc}`).join('\n'));
    }
  }
  
  // Add text response after tool calls
  if (textParts.length > 0) {
    const textContent = textParts.join('\n\n').trim();
    if (textContent) {
      result.push(textContent);
    }
  }

  return result.join('\n\n');
}

const getContextMessages = (
  messages: UIMessage[] | undefined,
  currentMessageId: string | undefined,
): { lastUserQuestion?: string; lastAssistantResponse?: string } => {
  if (!messages || !currentMessageId) {
    return {};
  }

  const currentIndex = messages.findIndex((m) => m.id === currentMessageId);
  if (currentIndex === -1) {
    return {};
  }

  // Helper to clean context markers and suggestion guidance markers from text
  const cleanContextMarkers = (text: string): string => {
    const contextMarker = '__QWERY_CONTEXT__';
    const contextEndMarker = '__QWERY_CONTEXT_END__';
    let cleaned = text;
    // Remove all context marker pairs
    cleaned = cleaned.replace(
      new RegExp(
        contextMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '.*?' +
          contextEndMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gs',
      ),
      '',
    );
    // Remove suggestion guidance markers
    cleaned = cleaned.replace(/__QWERY_SUGGESTION_GUIDANCE__/g, '');
    cleaned = cleaned.replace(/__QWERY_SUGGESTION_GUIDANCE_END__/g, '');
    return cleaned;
  };

  // Get the current assistant message (the one containing the suggestions)
  // This is the message that the suggestions belong to
  const currentMessage = messages[currentIndex];
  
  // Find last user message before current assistant message
  // Handle nested structures where previous question might be a suggestion
  let lastUserQuestion: string | undefined;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      const textPart = msg.parts.find((p) => p.type === 'text');
      if (textPart && 'text' in textPart && textPart.text) {
        // Parse and extract clean text if it has context markers
        const parsed = parseMessageWithContext(textPart.text);
        lastUserQuestion = parsed.text || cleanContextMarkers(textPart.text);
        break;
      }
    }
  }

  // Get the assistant response with tool calls formatted
  // This is the message containing the suggestions (current message)
  let lastAssistantResponse: string | undefined;
  if (currentMessage?.role === 'assistant') {
    // Format tool calls and extract text response
    const formatted = formatToolCalls(currentMessage.parts);
    if (formatted.trim()) {
      // Clean any context markers that might be in the response
      lastAssistantResponse = cleanContextMarkers(formatted);
    }
  }

  return { lastUserQuestion, lastAssistantResponse };
};

export const StreamdownWithSuggestions = memo(
  ({
    className,
    children,
    sendMessage,
    messages,
    currentMessageId,
  }: StreamdownWithSuggestionsProps) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!containerRef.current || !sendMessage) return;

      // Wait for Streamdown to finish rendering
      const timeoutId = setTimeout(() => {
        const container = containerRef.current;
        if (!container) return;

        // Find all elements that might contain the suggestion pattern
        // Only check list items and paragraphs - avoid div/span which are too generic and cause false positives
        const allElements = Array.from(container.querySelectorAll('li, p'));
        
        // Store cleanup functions for event listeners
        const cleanupFunctions: Array<() => void> = [];
        
        // Map to store elements that contain suggestions (before we clean them)
        const elementsWithSuggestions = new Map<Element, string>();

        // First pass: Find elements with suggestion patterns and extract the text
        allElements.forEach((element) => {
          // Check if this element already has a button
          if (element.querySelector('[data-suggestion-button]')) {
            return;
          }

          const elementText = element.textContent || '';
          
          // Check if this element contains the suggestion pattern
          if (isSuggestionPattern(elementText)) {
            const suggestionText = extractSuggestionText(elementText);
            if (suggestionText && suggestionText.length > 0) {
              // Additional validation: ensure the pattern is the main content, not just a fragment
              // Check that the element text is primarily the suggestion (with some tolerance for formatting)
              const patternMatch = elementText.match(/\{\{suggestion:\s*([^}]+)\}\}/);
              if (patternMatch) {
                const beforePattern = elementText.substring(0, patternMatch.index || 0).trim();
                const afterPattern = elementText.substring((patternMatch.index || 0) + patternMatch[0].length).trim();
                
                // Allow some text before (like bullets, numbers) but minimal text after
                // This prevents matching parent containers that happen to contain the pattern
                const hasMinimalPrefix = beforePattern.length === 0 || /^[•\-\*\d+\.\)]\s*$/.test(beforePattern);
                const hasMinimalSuffix = afterPattern.length === 0 || afterPattern.length < 5;
                
                if (hasMinimalSuffix) {
                  elementsWithSuggestions.set(element, suggestionText);
                  console.log('[SuggestionButton] Found suggestion:', suggestionText.substring(0, 50));
                }
              }
            }
          }
        });

        // Second pass: Clean up pattern markers from text nodes (after we've detected them)
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_TEXT,
          null,
        );
        const textNodes: Text[] = [];
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            textNodes.push(node as Text);
          }
          node = walker.nextNode();
        }
        
        textNodes.forEach((textNode) => {
          const text = textNode.textContent || '';
          if (text.includes('{{suggestion:')) {
            // Replace the pattern with just the suggestion text
            const cleaned = text.replace(/\{\{suggestion:\s*([^}]+)\}\}/g, '$1');
            textNode.textContent = cleaned;
          }
        });

        // Third pass: Add buttons to elements that had suggestions
        elementsWithSuggestions.forEach((suggestionText, element) => {
          // Double-check element still exists and doesn't have a button
          if (element.querySelector('[data-suggestion-button]')) {
            return;
          }

          // Generate a stable ID based on suggestion text content (persists across page refreshes)
          // Use a simple hash of the text to create a consistent ID
          const cleanText = suggestionText.trim().replace(/^[•\-\*\d+\.\)]\s*/, '');
          const textHash = cleanText
            .split('')
            .reduce((acc: number, char: string) => {
              const hash = ((acc << 5) - acc) + char.charCodeAt(0);
              return hash & hash; // Convert to 32-bit integer
            }, 0);
          const hashString = Math.abs(textHash).toString(36);
          const slug = cleanText.substring(0, 20).replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '');
          const suggestionId = `suggestion-${hashString}-${slug}`;
          element.setAttribute('data-suggestion-id', suggestionId);

          console.log('[SuggestionButton] Adding button for:', suggestionText.substring(0, 50));
          
          // Create inline button container (span) to insert after the list item content
          const buttonContainer = document.createElement('span');
          buttonContainer.setAttribute('data-suggestion-button', 'true');
          buttonContainer.style.cssText =
            'display: inline-flex; align-items: center; margin-left: 8px; vertical-align: middle;';

          // Create button element
          const button = document.createElement('button');
          button.setAttribute('data-suggestion-btn', 'true');
          button.style.cssText =
            'opacity: 0; transition: opacity 0.2s ease-in-out; height: 18px; width: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: transparent; border: none; cursor: pointer; padding: 0; flex-shrink: 0;';
          button.title = 'Send this suggestion';
          
          // Add hover effect using event listeners on the li element
          // This ensures the button shows when hovering over THIS specific list item only
          let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
          
          const showButton = () => {
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
              hoverTimeout = null;
            }
            button.style.opacity = '1';
            button.style.backgroundColor = 'hsl(var(--muted))';
          };
          
          const hideButton = () => {
            // Small delay to prevent flickering when moving between li and button
            hoverTimeout = setTimeout(() => {
              button.style.opacity = '0';
              button.style.backgroundColor = 'transparent';
              hoverTimeout = null;
            }, 50);
          };
          
          const cancelHide = () => {
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
              hoverTimeout = null;
            }
          };
          
          // Add event listeners to the specific element only
          // This ensures each button only shows when hovering its own element
          element.addEventListener('mouseenter', showButton);
          element.addEventListener('mouseleave', hideButton);
          
          // Also add hover on button itself to keep it visible when hovering the button
          button.addEventListener('mouseenter', cancelHide);
          button.addEventListener('mouseenter', showButton);
          button.addEventListener('mouseleave', hideButton);
          
          // Add hover to button container as well
          buttonContainer.addEventListener('mouseenter', cancelHide);
          buttonContainer.addEventListener('mouseenter', showButton);
          buttonContainer.addEventListener('mouseleave', hideButton);
          
          // Store cleanup function
          cleanupFunctions.push(() => {
            element.removeEventListener('mouseenter', showButton);
            element.removeEventListener('mouseleave', hideButton);
            button.removeEventListener('mouseenter', cancelHide);
            button.removeEventListener('mouseenter', showButton);
            button.removeEventListener('mouseleave', hideButton);
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
            }
          });

          // Create icon (using SVG)
          const icon = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg',
          );
          icon.setAttribute('width', '12');
          icon.setAttribute('height', '12');
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('stroke-width', '2');
          icon.setAttribute('stroke-linecap', 'round');
          icon.setAttribute('stroke-linejoin', 'round');
          // Use setAttribute for SVG className, not direct property assignment
          icon.setAttribute('class', 'text-muted-foreground');

          const path = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path',
          );
          path.setAttribute(
            'd',
            'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
          );
          icon.appendChild(path);
          button.appendChild(icon);

          // Add click handler - send the extracted suggestion text
          button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Use the extracted suggestion text (already clean from the pattern)
            let cleanSuggestionText = suggestionText.trim();
            
            // Remove any leading bullets or numbers that might be in the list item
            cleanSuggestionText = cleanSuggestionText.replace(/^[•\-\*\d+\.\)]\s*/, '');
            
            const { lastUserQuestion, lastAssistantResponse } = getContextMessages(
              messages,
              currentMessageId,
            );

            // Get the suggestion element ID for scroll-back functionality
            const suggestionElement = (e.target as HTMLElement).closest('[data-suggestion-id]');
            const sourceSuggestionId = suggestionElement?.getAttribute('data-suggestion-id') || undefined;

            // Store context in message text using a special marker that we can parse later
            // Format: __QWERY_CONTEXT__{...}__QWERY_CONTEXT_END__<actual message>
            let messageText = cleanSuggestionText;
            if (lastUserQuestion || lastAssistantResponse || sourceSuggestionId) {
              const contextData = JSON.stringify({
                lastUserQuestion,
                lastAssistantResponse,
                sourceSuggestionId,
              });
              messageText = `__QWERY_CONTEXT__${contextData}__QWERY_CONTEXT_END__${cleanSuggestionText}`;
            }
            
            sendMessage(
              {
                text: messageText,
              },
              {},
            );

            // Auto-scroll to bottom after a short delay to allow message to be added
            setTimeout(() => {
              const conversationElement = document.querySelector('[role="log"]');
              if (conversationElement) {
                conversationElement.scrollTo({
                  top: conversationElement.scrollHeight,
                  behavior: 'smooth',
                });
              }
            }, 100);
          });

          buttonContainer.appendChild(button);
          
          // Append button container inline at the end of the element
          // Since it's a span with inline-flex, it will appear inline naturally
          element.appendChild(buttonContainer);
        });

        // Return cleanup function for this timeout
        return () => {
          cleanupFunctions.forEach((cleanup) => cleanup());
        };
      }, 100); // Small delay to ensure Streamdown has rendered

      // Cleanup timeout on unmount
      return () => {
        clearTimeout(timeoutId);
      };
    }, [children, sendMessage, messages, currentMessageId]);

    return (
      <div ref={containerRef} className={className}>
        <MessageResponse>{children}</MessageResponse>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

StreamdownWithSuggestions.displayName = 'StreamdownWithSuggestions';

