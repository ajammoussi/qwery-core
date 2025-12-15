import { BadgeCheck, Brackets, Dot, KeyRound, Split } from 'lucide-react';

export const SchemaGraphLegend = () => {
  return (
    <div className="bg-background absolute bottom-0 left-0 z-10 flex w-full justify-start border-t px-4 py-2 shadow-md">
      <ul className="text-muted-foreground flex flex-wrap items-center justify-start gap-4 font-mono text-xs">
        <li className="flex items-center gap-1.5">
          <KeyRound
            size={14}
            strokeWidth={2}
            className="flex-shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          <span>Primary key</span>
        </li>
        <li className="flex items-center gap-1.5">
          <Split
            size={14}
            strokeWidth={2}
            className="flex-shrink-0 text-sky-600 dark:text-sky-400"
          />
          <span>Foreign key</span>
        </li>
        <li className="flex items-center gap-1.5">
          <BadgeCheck
            size={14}
            strokeWidth={2}
            className="flex-shrink-0 text-indigo-600 dark:text-indigo-400"
          />
          <span>Unique</span>
        </li>
        <li className="flex items-center gap-1.5">
          <Dot
            size={14}
            strokeWidth={2}
            className="flex-shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span>Nullable</span>
        </li>
        <li className="flex items-center gap-1.5">
          <Brackets
            size={14}
            strokeWidth={2}
            className="text-muted-foreground flex-shrink-0"
          />
          <span>Column type</span>
        </li>
      </ul>
    </div>
  );
};
