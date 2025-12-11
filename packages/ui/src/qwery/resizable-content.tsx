import React, { useEffect, useState } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../shadcn/resizable';
import { cn } from '../lib/utils';

interface ResizableContentProps {
  Content: React.ReactElement | null;
  AgentSidebar: React.ReactElement | null;
  open?: boolean;
}

export function ResizableContent(props: ResizableContentProps) {
  const { Content, AgentSidebar, open: controlledOpen } = props;
  const [isOpen, setIsOpen] = useState(controlledOpen ?? false);

  // Sync with controlled prop
  useEffect(() => {
    if (controlledOpen !== undefined && controlledOpen !== isOpen) {
      setIsOpen(controlledOpen);
    }
  }, [controlledOpen, isOpen]);

  // Always render panels but control their size for smooth animations
  const sidebarSize = isOpen ? 50 : 0;
  const contentSize = isOpen ? 50 : 100;

  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="h-full w-full overflow-hidden"
    >
      <ResizablePanel
        defaultSize={contentSize}
        minSize={isOpen ? 50 : 100}
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        <div className="h-full min-h-0 w-full max-w-full min-w-0 overflow-hidden">
          {Content}
        </div>
      </ResizablePanel>
      <ResizableHandle
        withHandle
        className={cn(
          'transition-opacity duration-300 ease-in-out',
          !isOpen && 'opacity-0 pointer-events-none',
        )}
      />
      <ResizablePanel
        defaultSize={sidebarSize}
        minSize={0}
        maxSize={80}
        collapsible
        collapsed={!isOpen}
        className={cn(
          'flex h-full min-h-0 min-w-0 flex-col overflow-hidden',
          'bg-sidebar border-l border-border',
        )}
        style={{
          minWidth: isOpen ? '400px' : '0px',
        }}
      >
        <div
          className={cn(
            'h-full min-h-0 w-full max-w-full min-w-0 overflow-hidden transition-opacity duration-300 ease-in-out',
            !isOpen && 'opacity-0 pointer-events-none',
          )}
        >
          {AgentSidebar}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
