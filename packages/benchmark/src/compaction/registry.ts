import type { CompressionMethod } from '../types.js';
import type { CompactionStrategy } from './strategy.js';
import { baselineStrategy } from './strategies/baseline.js';
import { qweryDefaultStrategy } from './strategies/qwery-default.js';
import { entityStateStrategy } from './strategies/entity-state.js';

const STRATEGIES: Partial<Record<CompressionMethod, CompactionStrategy>> = {
  'baseline-no-compression': baselineStrategy,
  'qwery-default': qweryDefaultStrategy,
  'entity-state': entityStateStrategy,
};

export function getStrategy(method: CompressionMethod): CompactionStrategy {
  const strategy = STRATEGIES[method];
  if (!strategy) {
    throw new Error(
      `Compaction strategy '${method}' is not implemented in phase 1. Available: ${Object.keys(STRATEGIES).join(', ')}`,
    );
  }
  return strategy;
}

export function listImplementedMethods(): CompressionMethod[] {
  return Object.keys(STRATEGIES) as CompressionMethod[];
}
