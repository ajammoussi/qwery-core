'use client';

import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/utils';
import { agentMarkdownComponents, HeadingContext } from './markdown-components';
import { MarkdownProvider } from './message-parts';
import type { UIMessage } from 'ai';
import type { useChat } from '@ai-sdk/react';

export interface EnhancedMessageResponseProps {
  children: string;
  className?: string;
  sendMessage?: ReturnType<typeof useChat>['sendMessage'];
  messages?: UIMessage[];
  currentMessageId?: string;
}

export const EnhancedMessageResponse = memo(
  ({
    className,
    children,
    sendMessage,
    messages,
    currentMessageId,
  }: EnhancedMessageResponseProps) => {
    const [currentHeading, setCurrentHeading] = useState('');

    const headingContextValue = useMemo(
      () => ({
        currentHeading,
        setCurrentHeading,
      }),
      [currentHeading],
    );

    return (
      <MarkdownProvider
        value={{ sendMessage, messages, currentMessageId }}
      >
        <HeadingContext.Provider value={headingContextValue}>
          <div
            className={cn(
              'size-full break-words [&_a]:break-all [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
              className,
            )}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={agentMarkdownComponents}
            >
              {children}
            </ReactMarkdown>
          </div>
        </HeadingContext.Provider>
      </MarkdownProvider>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

EnhancedMessageResponse.displayName = 'EnhancedMessageResponse';

