const STREAMDOWN_RENDER_DELAY = 100;
const HOVER_HIDE_DELAY = 50;
const SCROLL_DELAY = 100;

export function generateSuggestionId(suggestionText: string): string {
  const cleanText = suggestionText.trim().replace(/^[•\-*\d+.)]\s*/, '');
  const textHash = cleanText.split('').reduce((acc: number, char: string) => {
    const hash = (acc << 5) - acc + char.charCodeAt(0);
    return hash & hash;
  }, 0);
  const hashString = Math.abs(textHash).toString(36);
  const slug = cleanText
    .substring(0, 20)
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return `suggestion-${hashString}-${slug}`;
}

export function cleanSuggestionPatterns(container: HTMLElement): void {
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
      const cleaned = text.replace(
        /\{\{suggestion:\s*((?:(?!\}\}).)+)\}\}/g,
        '$1',
      );
      textNode.textContent = cleaned;
    }
  });
}

export interface SuggestionButtonHandlers {
  onClick: (
    suggestionText: string,
    sourceSuggestionId: string | undefined,
  ) => void;
}

export interface SuggestionButtonConfig {
  suggestionText: string;
  suggestionId: string;
  handlers: SuggestionButtonHandlers;
}

export function createSuggestionButton(
  element: Element,
  config: SuggestionButtonConfig,
): { cleanup: () => void } {
  const { suggestionText, suggestionId, handlers } = config;

  if (element.querySelector('[data-suggestion-button]')) {
    return { cleanup: () => {} };
  }

  element.setAttribute('data-suggestion-id', suggestionId);

  const buttonContainer = document.createElement('span');
  buttonContainer.setAttribute('data-suggestion-button', 'true');
  buttonContainer.style.cssText =
    'display: inline-flex; align-items: center; margin-left: 8px; vertical-align: middle;';

  const button = document.createElement('button');
  button.setAttribute('data-suggestion-btn', 'true');
  button.setAttribute('type', 'button');
  button.setAttribute(
    'aria-label',
    `Send suggestion: ${suggestionText.substring(0, 50)}${suggestionText.length > 50 ? '...' : ''}`,
  );
  button.setAttribute('title', 'Send this suggestion');
  button.style.cssText =
    'opacity: 0; transition: opacity 0.2s ease-in-out; height: 18px; width: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: transparent; border: none; cursor: pointer; padding: 0; flex-shrink: 0;';

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
    hoverTimeout = setTimeout(() => {
      button.style.opacity = '0';
      button.style.backgroundColor = 'transparent';
      hoverTimeout = null;
    }, HOVER_HIDE_DELAY);
  };

  const cancelHide = () => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  };

  element.addEventListener('mouseenter', showButton);
  element.addEventListener('mouseleave', hideButton);
  button.addEventListener('mouseenter', cancelHide);
  button.addEventListener('mouseenter', showButton);
  button.addEventListener('mouseleave', hideButton);
  buttonContainer.addEventListener('mouseenter', cancelHide);
  buttonContainer.addEventListener('mouseenter', showButton);
  buttonContainer.addEventListener('mouseleave', hideButton);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('class', 'text-muted-foreground');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z');
  icon.appendChild(path);
  button.appendChild(icon);

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    let cleanSuggestionText = suggestionText.trim();
    cleanSuggestionText = cleanSuggestionText.replace(/^[•\-*\d+.)]\s*/, '');

    const suggestionElement = (e.target as HTMLElement).closest(
      '[data-suggestion-id]',
    );
    const sourceSuggestionId =
      suggestionElement?.getAttribute('data-suggestion-id') || undefined;

    handlers.onClick(cleanSuggestionText, sourceSuggestionId);
  });

  buttonContainer.appendChild(button);
  element.appendChild(buttonContainer);

  return {
    cleanup: () => {
      element.removeEventListener('mouseenter', showButton);
      element.removeEventListener('mouseleave', hideButton);
      button.removeEventListener('mouseenter', cancelHide);
      button.removeEventListener('mouseenter', showButton);
      button.removeEventListener('mouseleave', hideButton);
      buttonContainer.removeEventListener('mouseenter', cancelHide);
      buttonContainer.removeEventListener('mouseenter', showButton);
      buttonContainer.removeEventListener('mouseleave', hideButton);
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
    },
  };
}

export function scrollToConversationBottom(): void {
  setTimeout(() => {
    const conversationElement = document.querySelector('[role="log"]');
    if (conversationElement) {
      conversationElement.scrollTo({
        top: conversationElement.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, SCROLL_DELAY);
}

export { STREAMDOWN_RENDER_DELAY };
