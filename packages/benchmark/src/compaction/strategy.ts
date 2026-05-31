import { SessionCompaction } from '@qwery/agent-factory-sdk';
import type { CompressionMethod } from '../types.js';

export type CurrentTurnRef = { value: number };

export type StrategyOriginals = {
  isOverflow: typeof SessionCompaction.isOverflow;
  process: typeof SessionCompaction.process;
  prune: typeof SessionCompaction.prune;
};

export type StrategyContext = {
  boundaryTurn: number;
  currentTurnRef: CurrentTurnRef;
};

export type StrategyHooks = {
  isOverflow?: typeof SessionCompaction.isOverflow;
  process: typeof SessionCompaction.process;
  prune?: typeof SessionCompaction.prune;
  getState?: (options?: { prune?: boolean; excludeRaw?: boolean }) => Record<string, unknown>;
};

export type CompactionStrategyFactory = (
  ctx: StrategyContext,
  originals: StrategyOriginals,
) => StrategyHooks;

export type CompactionStrategy = {
  name: CompressionMethod;
  factory: CompactionStrategyFactory;
};

export type LastCompaction = {
  startedAtMs: number;
  latencyMs: number;
  turnNumber: number;
  preCompactionTokens: number | null;
} | null;

export type InstallResult = {
  restore: () => void;
  /**
   * Mutable slot updated whenever `process` is invoked. The runner reads this
   * after each turn to attach a CompactionEvent to the corresponding TurnResult.
   */
  lastCompactionRef: { value: LastCompaction };
  /**
   * Mutable slot updated whenever the strategy's `isOverflow` returns true.
   * Captures the input-token count at the moment overflow was declared, used
   * as `preCompactionTokens` in the resulting CompactionEvent.
   */
  preTokensRef: { value: number | null };
  getState?: (options?: { prune?: boolean; excludeRaw?: boolean }) => Record<string, unknown>;
};

/**
 * Swap SessionCompaction methods for a strategy's implementations and return a
 * restore function that puts the original references back. The strategy's
 * `process` is wrapped so the runner can observe latency without the strategy
 * itself having to know about result capture.
 */
export function installStrategy(
  strategy: CompactionStrategy,
  ctx: StrategyContext,
): InstallResult {
  const originals: StrategyOriginals = {
    isOverflow: SessionCompaction.isOverflow,
    process: SessionCompaction.process,
    prune: SessionCompaction.prune,
  };

  const hooks = strategy.factory(ctx, originals);
  const lastCompactionRef: { value: LastCompaction } = { value: null };
  const preTokensRef: { value: number | null } = { value: null };

  const wrappedProcess: typeof SessionCompaction.process = async (input) => {
    const startedAtMs = performance.now();
    const preTokens = preTokensRef.value;
    try {
      return await hooks.process(input);
    } finally {
      lastCompactionRef.value = {
        startedAtMs,
        latencyMs: performance.now() - startedAtMs,
        turnNumber: ctx.currentTurnRef.value,
        preCompactionTokens: preTokens,
      };
    }
  };

  if (hooks.isOverflow) {
    const inner = hooks.isOverflow;
    SessionCompaction.isOverflow = async (input) => {
      const fired = await inner(input);
      if (fired) {
        preTokensRef.value =
          input.tokens.input + (input.tokens.cache?.read ?? 0);
      }
      return fired;
    };
  }
  SessionCompaction.process = wrappedProcess;
  if (hooks.prune) {
    SessionCompaction.prune = hooks.prune;
  }

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    SessionCompaction.isOverflow = originals.isOverflow;
    SessionCompaction.process = originals.process;
    SessionCompaction.prune = originals.prune;
  };

  return {
    restore,
    lastCompactionRef,
    preTokensRef,
    getState: hooks.getState,
  };
}

/**
 * Returns an `isOverflow` that fires `true` exactly once after the boundary
 * turn has been reached. Used by every strategy except `baseline-no-compression`
 * to make compaction triggering deterministic across methods.
 */
export function makeBoundaryIsOverflow(
  ctx: StrategyContext,
): typeof SessionCompaction.isOverflow {
  let triggered = false;
  return async () => {
    if (triggered) return false;
    if (ctx.currentTurnRef.value >= ctx.boundaryTurn) {
      triggered = true;
      return true;
    }
    return false;
  };
}
