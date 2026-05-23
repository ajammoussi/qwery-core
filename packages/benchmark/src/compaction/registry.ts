import type { CompressionMethod, ContextMode } from '../types.js';
import type { CompactionStrategy } from './strategy.js';
import { baselineStrategy } from './strategies/baseline.js';
import { qweryDefaultStrategy } from './strategies/qwery-default.js';
import { with4Zone } from './wrappers/with-4zone.js';

const CORE_STRATEGIES: Partial<Record<CompressionMethod, CompactionStrategy>> = {
  'baseline-no-compression': baselineStrategy,
  'qwery-default': qweryDefaultStrategy,
};

export function getStrategy(
  method: CompressionMethod,
  contextMode: ContextMode = 'plain',
): CompactionStrategy {
  const baseStrategy = CORE_STRATEGIES[method];
  if (!baseStrategy) {
    throw new Error(
      `Compaction strategy '${method}' is not implemented. Available: ${Object.keys(CORE_STRATEGIES).join(', ')}`,
    );
  }

  if (contextMode === '4zone') {
    return with4Zone(baseStrategy);
  }

  return baseStrategy;
}

export function listImplementedMethods(): CompressionMethod[] {
  return Object.keys(CORE_STRATEGIES) as CompressionMethod[];
}

export function listContextModes(): ContextMode[] {
  return ['plain', '4zone'];
}
