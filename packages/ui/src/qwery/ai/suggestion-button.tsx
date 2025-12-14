import { Send } from 'lucide-react';
import { Button } from '../../shadcn/button';
import { cn } from '../../lib/utils';

export interface SuggestionButtonProps {
  onClick: () => void;
  className?: string;
}

export function SuggestionButton({
  onClick,
  className,
}: SuggestionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'absolute right-0 top-0 h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100',
        className,
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      title="Send this suggestion"
    >
      <Send className="text-muted-foreground size-3" />
    </Button>
  );
}


