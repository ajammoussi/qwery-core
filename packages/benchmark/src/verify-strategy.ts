import { SessionCompaction } from '@qwery/agent-factory-sdk';
import type { ProcessInput } from '@qwery/agent-factory-sdk';
import { installStrategy } from './compaction/strategy.js';
import { getStrategy } from './compaction/registry.js';

type Check = { name: string; ok: boolean; detail?: string };

const results: Check[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const icon = ok ? 'OK ' : 'FAIL';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`[${icon}] ${name}${suffix}`);
}

async function main() {
  const originalProcess = SessionCompaction.process;
  const originalIsOverflow = SessionCompaction.isOverflow;
  const originalPrune = SessionCompaction.prune;

  // 1. baseline strategy: process should NOT delegate to original; isOverflow always false
  {
    const baseline = getStrategy('baseline-no-compression');
    const turnRef = { value: 0 };
    const { restore } = installStrategy(baseline, {
      boundaryTurn: 5,
      currentTurnRef: turnRef,
    });

    record(
      'baseline: SessionCompaction.process is swapped',
      SessionCompaction.process !== originalProcess,
    );

    const overflowAt10 = await SessionCompaction.isOverflow({
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { providerID: 'p', id: 'm', limit: { context: 100, output: 10 } },
    });
    record(
      'baseline: isOverflow is forced to false even at huge token counts',
      overflowAt10 === false,
    );

    const procResult = await SessionCompaction.process({
      parentID: 'p',
      messages: [],
      conversationSlug: 's',
      abort: new AbortController().signal,
      auto: true,
      repositories: {} as ProcessInput['repositories'],
    });
    record('baseline: process returns "continue" without invoking production', procResult === 'continue');

    restore();
    record(
      'baseline: restore() reinstalls original process',
      SessionCompaction.process === originalProcess,
    );
    record(
      'baseline: restore() reinstalls original isOverflow',
      SessionCompaction.isOverflow === originalIsOverflow,
    );
    record(
      'baseline: restore() reinstalls original prune',
      SessionCompaction.prune === originalPrune,
    );
  }

  // 2. qwery-default: isOverflow fires once at boundary; preTokens captured; latency recorded
  {
    let processCalls = 0;
    const fakeProcess: typeof SessionCompaction.process = async () => {
      processCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return 'continue';
    };
    SessionCompaction.process = fakeProcess;

    const summary = getStrategy('qwery-default');
    const turnRef = { value: 0 };
    const { restore, lastCompactionRef, preTokensRef } = installStrategy(
      summary,
      { boundaryTurn: 5, currentTurnRef: turnRef },
    );

    // Before the boundary: should not fire
    turnRef.value = 3;
    const before = await SessionCompaction.isOverflow({
      tokens: { input: 200, output: 0, reasoning: 0, cache: { read: 50, write: 0 } },
      model: { providerID: 'p', id: 'm', limit: { context: 1000, output: 100 } },
    });
    record('qwery-default: isOverflow is false before boundaryTurn', before === false);
    record('qwery-default: preTokensRef remains null before boundary', preTokensRef.value === null);

    // At/after boundary: fires exactly once
    turnRef.value = 5;
    const atBoundary = await SessionCompaction.isOverflow({
      tokens: { input: 200, output: 0, reasoning: 0, cache: { read: 50, write: 0 } },
      model: { providerID: 'p', id: 'm', limit: { context: 1000, output: 100 } },
    });
    record('qwery-default: isOverflow fires true at boundaryTurn', atBoundary === true);
    record(
      'qwery-default: preTokensRef captures input + cache.read',
      preTokensRef.value === 250,
    );

    const second = await SessionCompaction.isOverflow({
      tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { providerID: 'p', id: 'm', limit: { context: 1000, output: 100 } },
    });
    record('qwery-default: isOverflow does NOT fire twice', second === false);

    // Now invoke process — should delegate to fakeProcess (the captured "production"), not return 'continue' from baseline
    await SessionCompaction.process({
      parentID: 'p',
      messages: [],
      conversationSlug: 's',
      abort: new AbortController().signal,
      auto: true,
      repositories: {} as ProcessInput['repositories'],
    });
    record(
      'qwery-default: process delegates to original (fake) production process',
      processCalls === 1,
    );
    record(
      'qwery-default: lastCompactionRef populated after process',
      lastCompactionRef.value !== null,
    );
    record(
      'qwery-default: latency was measured',
      (lastCompactionRef.value?.latencyMs ?? 0) >= 5,
    );
    record(
      'qwery-default: lastCompaction.preCompactionTokens carries the captured value',
      lastCompactionRef.value?.preCompactionTokens === 250,
    );
    record(
      'qwery-default: lastCompaction.turnNumber matches currentTurnRef at process time',
      lastCompactionRef.value?.turnNumber === 5,
    );

    restore();
    SessionCompaction.process = originalProcess;
    record(
      'qwery-default: restore() reinstalls original isOverflow',
      SessionCompaction.isOverflow === originalIsOverflow,
    );
  }

  // 3. unimplemented strategy throws
  {
    let threw = false;
    try {
      getStrategy('llmlingua-2');
    } catch {
      threw = true;
    }
    record('registry: llmlingua-2 throws (not implemented in phase 1)', threw);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
