import type { CompactionStrategy } from '../strategy.js';
import { makeBoundaryIsOverflow } from '../strategy.js';

/**
 * Delegates `process` to the production implementation captured at install
 * time. The boundary-triggered `isOverflow` ensures compaction fires
 * deterministically at the session's compressionBoundaryTurn instead of relying
 * on the model's natural context-window overflow.
 */
export const summaryProseStrategy: CompactionStrategy = {
  name: 'summary-prose',
  factory: (ctx, originals) => ({
    isOverflow: makeBoundaryIsOverflow(ctx),
    process: (input) => originals.process(input),
  }),
};
