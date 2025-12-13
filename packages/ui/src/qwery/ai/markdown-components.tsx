import * as React from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { cn } from '../../lib/utils';
import { createContext, useContext } from 'react';
import { MarkdownContext } from './message-parts';
import { SuggestionButton } from './suggestion-button';
import { UIMessage } from 'ai';
import { Sparkles } from 'lucide-react';

type MarkdownCodeProps = HTMLAttributes<HTMLElement> & {
  inline?: boolean;
  node?: unknown;
};

// Context to track current heading
export const HeadingContext = createContext<{
  currentHeading: string;
  setCurrentHeading: (heading: string) => void;
}>({
  currentHeading: '',
  setCurrentHeading: () => { },
});

// Create a factory function that returns components with context access
export const createAgentMarkdownComponents = (): Components => {
  const isSuggestionHeading = (heading: string): boolean => {
    const lowerHeading = heading.toLowerCase();
    return (
      lowerHeading.includes('suggested next steps') ||
      lowerHeading.includes('example queries') ||
      lowerHeading.includes('suggestions') ||
      lowerHeading.includes('you can ask')
    );
  };

  const isQuestion = (text: string): boolean => {
    return text.trim().endsWith('?');
  };

  const extractTextFromChildren = (children: ReactNode): string => {
    if (typeof children === 'string') {
      return children;
    }
    if (Array.isArray(children)) {
      return children.map(extractTextFromChildren).join('');
    }
    if (React.isValidElement(children)) {
      const props = children.props as { children?: ReactNode };
      if (props.children) {
        return extractTextFromChildren(props.children);
      }
    }
    return '';
  };

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

    // Find last user message before current
    let lastUserQuestion: string | undefined;
    for (let i = currentIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'user') {
        const textPart = msg.parts.find((p) => p.type === 'text');
        if (textPart && 'text' in textPart) {
          lastUserQuestion = textPart.text;
          break;
        }
      }
    }

    // Find last assistant message before current
    let lastAssistantResponse: string | undefined;
    for (let i = currentIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'assistant') {
        const textPart = msg.parts.find((p) => p.type === 'text');
        if (textPart && 'text' in textPart) {
          lastAssistantResponse = textPart.text;
          break;
        }
      }
    }

    return { lastUserQuestion, lastAssistantResponse };
  };

  return {
    h1: ({ className, ...props }) => (
      <h1
        {...props}
        className={cn('text-2xl leading-tight font-semibold mt-4 mb-2', className)}
      />
    ),
    h2: ({ className, children, ...props }) => {
      const { setCurrentHeading } = useContext(HeadingContext);
      const headingText = extractTextFromChildren(children);
      if (isSuggestionHeading(headingText)) {
        setCurrentHeading(headingText);
      }
      return (
        <h2
          {...props}
          className={cn('text-xl leading-tight font-semibold mt-3 mb-2', className)}
        >
          {children}
        </h2>
      );
    },
    h3: ({ className, children, ...props }) => {
      const { setCurrentHeading } = useContext(HeadingContext);
      const headingText = extractTextFromChildren(children);
      if (isSuggestionHeading(headingText)) {
        setCurrentHeading(headingText);
      }
      return (
        <h3
          {...props}
          className={cn('text-lg leading-tight font-semibold mt-3 mb-2', className)}
        >
          {children}
        </h3>
      );
    },
    p: ({ className, ...props }) => (
      <p {...props} className={cn('my-2 text-sm leading-6', className)} />
    ),
    a: ({ className, href, children, ...props }) => (
      <a
        {...props}
        href={href}
        className={cn(
          'text-primary decoration-primary/50 hover:decoration-primary underline underline-offset-2 transition',
          className,
        )}
        target="_blank"
        rel="noreferrer"
      />
    ),
    ul: ({ className, ...props }) => (
      <ul
        {...props}
        className={cn('my-2 list-disc pl-6 text-sm leading-6', className)}
      />
    ),
    ol: ({ className, ...props }) => (
      <ol
        {...props}
        className={cn('my-2 list-decimal pl-6 text-sm leading-6', className)}
      />
    ),
    li: ({ className, children, ...props }) => {
      const markdownContext = useContext(MarkdownContext);
      const { currentHeading } = useContext(HeadingContext);
      const itemText = extractTextFromChildren(children);
      const isUnderSuggestionHeading = isSuggestionHeading(currentHeading);
      const isQuestionItem = isQuestion(itemText);
      const isSuggestion = isUnderSuggestionHeading || isQuestionItem;

      if (isSuggestion && markdownContext.sendMessage) {
        const handleClick = () => {
          const { lastUserQuestion, lastAssistantResponse } = getContextMessages(
            markdownContext.messages,
            markdownContext.currentMessageId,
          );

          let messageText = itemText;

          // Build context template if we have previous messages
          if (lastUserQuestion || lastAssistantResponse) {
            const contextParts: string[] = [];
            if (lastUserQuestion) {
              contextParts.push(`Previous question: ${lastUserQuestion}`);
            }
            if (lastAssistantResponse) {
              contextParts.push(`Previous response: ${lastAssistantResponse}`);
            }
            if (contextParts.length > 0) {
              messageText = `${contextParts.join('\n\n')}\n\n${itemText}`;
            }
          }

          if (markdownContext.sendMessage) {
            markdownContext.sendMessage(
              {
                text: messageText,
              },
              {},
            );
          }
        };

        return (
          <li
            {...props}
            className={cn(
              'marker:text-muted-foreground group relative my-1 pr-6 text-sm leading-6',
              className,
            )}
          >
            {children}
            <SuggestionButton onClick={handleClick} />
          </li>
        );
      }

      return (
        <li
          {...props}
          className={cn(
            'marker:text-muted-foreground my-1 text-sm leading-6',
            className,
          )}
        >
          {children}
        </li>
      );
    },
    blockquote: ({ className, ...props }) => (
      <blockquote
        {...props}
        className={cn(
          'border-border/60 text-muted-foreground my-4 border-l-2 pl-4 text-sm italic',
          className,
        )}
      />
    ),
    code: ({ inline, className, children, ...props }: MarkdownCodeProps) => {
      if (inline) {
        return (
          <code
            {...props}
            className={cn(
              'bg-muted/60 rounded px-1.5 py-0.5 font-mono text-xs',
              className,
            )}
          >
            {children}
          </code>
        );
      }
      return (
        <pre
          className={cn(
            'bg-muted/50 text-muted-foreground/90 relative my-3 overflow-x-auto rounded-md p-4 text-xs',
            className,
          )}
        >
          <code {...props} className="font-mono leading-5">
            {children}
          </code>
        </pre>
      );
    },
    table: ({ className, ...props }) => (
      <div className="my-4 w-full overflow-x-auto">
        <table
          {...props}
          className={cn(
            '[&_tr:nth-child(even)]:bg-muted/30 w-full border-collapse text-left text-sm [&_td]:py-2 [&_td]:align-top [&_th]:border-b [&_th]:pb-2 [&_th]:text-xs',
            className,
          )}
        />
      </div>
    ),
    hr: ({ className, ...props }) => (
      <hr
        {...props}
        className={cn('border-border my-4 border-t', className)}
      />
    ),
    strong: ({ className, children, ...props }) => {
      const { currentHeading } = useContext(HeadingContext);
      const isUnderSuggestionHeading = isSuggestionHeading(currentHeading);
      const itemText = extractTextFromChildren(children);
      const isQuestionItem = isQuestion(itemText);
      const isSuggestion = isUnderSuggestionHeading || isQuestionItem;

      if (isSuggestion) {
        return (
          <strong
            {...props}
            className={cn('font-semibold inline-flex items-center gap-1.5', className)}
          >
            <Sparkles className="inline-block h-3 w-3 text-primary/70 shrink-0" />
            {children}
          </strong>
        );
      }

      return <strong {...props} className={cn('font-semibold', className)} />;
    },
    em: ({ className, ...props }) => (
      <em {...props} className={cn('italic', className)} />
    ),
  };
};

// Export the default components (will be created fresh for each render)
export const agentMarkdownComponents: Components = createAgentMarkdownComponents();
