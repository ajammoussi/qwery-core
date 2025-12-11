'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';

interface AgentSidebarContextValue {
  isOpen: boolean;
  conversationSlug: string | null;
  openSidebar: (conversationSlug: string) => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
}

const AgentSidebarContext = createContext<AgentSidebarContextValue | null>(null);

export function AgentSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [conversationSlug, setConversationSlug] = useState<string | null>(null);

  const openSidebar = useCallback((slug: string) => {
    setConversationSlug(slug);
    setIsOpen(true);
  }, []);

  const closeSidebar = useCallback(() => {
    setIsOpen(false);
    // Keep conversationSlug so messages persist if user reopens
  }, []);

  const toggleSidebar = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // Global keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isModKeyPressed = isMac ? event.metaKey : event.ctrlKey;

      if (isModKeyPressed && event.key === 'l') {
        const target = event.target as HTMLElement;
        const isInputFocused =
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable;

        if (!isInputFocused) {
          event.preventDefault();
          toggleSidebar();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  return (
    <AgentSidebarContext.Provider
      value={{
        isOpen,
        conversationSlug,
        openSidebar,
        closeSidebar,
        toggleSidebar,
      }}
    >
      {children}
    </AgentSidebarContext.Provider>
  );
}

export function useAgentSidebar() {
  const context = useContext(AgentSidebarContext);
  if (!context) {
    throw new Error('useAgentSidebar must be used within AgentSidebarProvider');
  }
  return context;
}

