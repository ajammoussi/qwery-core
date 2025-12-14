'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

type AgentSidebarContextValue = {
  isOpen: boolean;
  conversationSlug: string | null;
  toggleSidebar: () => void;
  openSidebar: (slug: string) => void;
  closeSidebar: () => void;
};

const AgentSidebarContext = createContext<AgentSidebarContextValue | null>(
  null,
);

export function AgentSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [conversationSlug, setConversationSlug] = useState<string | null>(null);

  const toggleSidebar = () => {
    setIsOpen((prev) => !prev);
  };

  const openSidebar = (slug: string) => {
    setConversationSlug(slug);
    setIsOpen(true);
  };

  const closeSidebar = () => {
    setIsOpen(false);
  };

  return (
    <AgentSidebarContext.Provider
      value={{
        isOpen,
        conversationSlug,
        toggleSidebar,
        openSidebar,
        closeSidebar,
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
