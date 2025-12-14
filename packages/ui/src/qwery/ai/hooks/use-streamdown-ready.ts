import { useEffect, useRef, useState } from 'react';

const STREAMDOWN_READY_TIMEOUT = 2000;

export function useStreamdownReady<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
): boolean {
  const [isReady, setIsReady] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Initialize ready state based on container content
    // Use requestAnimationFrame to defer state updates outside of effect
    requestAnimationFrame(() => {
      const hasContent = container.children.length > 0;
      const hasTextContent =
        container.textContent && container.textContent.trim().length > 0;
      const initialReady = hasContent && hasTextContent;
      if (initialReady) {
        const allElements = container.querySelectorAll('li, p, div, span');
        if (allElements.length > 0) {
          setIsReady(true);
          return;
        }
      }
      setIsReady(false);
    });

    const checkReady = () => {
      const hasContent = container.children.length > 0;
      const hasTextContent =
        container.textContent && container.textContent.trim().length > 0;

      if (hasContent && hasTextContent) {
        const allElements = container.querySelectorAll('li, p, div, span');
        if (allElements.length > 0) {
          setIsReady(true);
          return true;
        }
      }
      return false;
    };

    if (checkReady()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (checkReady()) {
        if (observerRef.current) {
          observerRef.current.disconnect();
          observerRef.current = null;
        }
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    observerRef.current = observer;

    timeoutRef.current = setTimeout(() => {
      setIsReady(true);
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    }, STREAMDOWN_READY_TIMEOUT);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [containerRef]);

  return isReady;
}
