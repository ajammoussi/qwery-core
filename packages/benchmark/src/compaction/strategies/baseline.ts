import type { CompactionStrategy } from '../strategy.js';

export const baselineStrategy: CompactionStrategy = {
  name: 'baseline-no-compression',
  factory: () => ({
    isOverflow: async () => false,
    process: async () => 'continue',
  }),
};
