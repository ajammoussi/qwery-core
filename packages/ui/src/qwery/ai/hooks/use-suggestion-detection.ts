import { useMemo, RefObject, useState, useEffect } from 'react';
import {
  isSuggestionPattern,
  extractSuggestionText,
  validateSuggestionElement,
} from '../utils/suggestion-pattern';

export interface DetectedSuggestion {
  element: Element;
  suggestionText: string;
}

export function useSuggestionDetection(
  containerRef: RefObject<HTMLElement | null>,
  isReady: boolean,
): DetectedSuggestion[] {
  const [containerElement, setContainerElement] = useState<HTMLElement | null>(
    null,
  );

  useEffect(() => {
    setContainerElement(containerRef.current);
  }, [containerRef]);

  return useMemo(() => {
    if (!containerElement || !isReady) {
      return [];
    }

    try {
      const allElements = Array.from(
        containerElement.querySelectorAll('li, p'),
      );
      const detected: DetectedSuggestion[] = [];

      allElements.forEach((element) => {
        if (element.querySelector('[data-suggestion-button]')) {
          return;
        }

        const elementText = element.textContent || '';

        if (isSuggestionPattern(elementText)) {
          const suggestionText = extractSuggestionText(elementText);
          if (
            suggestionText &&
            suggestionText.length > 0 &&
            validateSuggestionElement(element, elementText)
          ) {
            detected.push({ element, suggestionText });
          }
        }
      });

      return detected;
    } catch (error) {
      console.error(
        '[useSuggestionDetection] Error detecting suggestions:',
        error,
      );
      return [];
    }
  }, [containerElement, isReady]);
}
