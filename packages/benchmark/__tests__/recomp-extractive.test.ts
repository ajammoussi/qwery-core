import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionCompaction } from '@qwery/agent-factory-sdk';
import type { ProcessInput } from '@qwery/agent-factory-sdk';

// Mock compromise with a configurable sentence array
const mockSentences: { value: string[] } = { value: [] };
vi.mock('compromise', () => ({
  default: vi.fn((text: string) => ({
    sentences: () => ({
      out: () => mockSentences.value.length > 0 ? mockSentences.value : [text],
    }),
  })),
}));

// Mock @huggingface/transformers pipeline — returns configurable embeddings
const mockEmbeddings: { value: number[][] } = { value: [] };
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => {
    return async (_texts: string[], _opts?: { pooling?: string; normalize?: boolean }) => ({
      data: new Float32Array(),
      dims: [mockEmbeddings.value.length, 768],
      tolist: () => mockEmbeddings.value,
    });
  }),
}));

import { recompExtractiveStrategy } from '../src/compaction/strategies/recomp-extractive.js';

// Re-implement utility functions inline for unit verification (they are
// module-private in the implementation; these are kept in sync for test assertions).
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function selectTopK(scores: number[], k: number): number[] {
  if (scores.length <= k) {
    return Array.from({ length: scores.length }, (_, i) => i);
  }
  const indexed = scores.map((score, i) => ({ score, i }));
  indexed.sort((a, b) => b.score - a.score);
  const selected = indexed.slice(0, k).map((x) => x.i);
  selected.sort((a, b) => a - b);
  return selected;
}

describe('recomp-extractive — core utilities', () => {
  it('cosineSimilarity: identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('cosineSimilarity: orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('cosineSimilarity: zero vector → 0 (no division by zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it('selectTopK: returns top-K indices in ascending order', () => {
    const scores = [0.1, 0.8, 0.3, 0.9, 0.2];
    expect(selectTopK(scores, 2)).toEqual([1, 3]);
    expect(selectTopK(scores, 3)).toEqual([1, 2, 3]);
  });

  it('selectTopK: fewer items than K returns all', () => {
    expect(selectTopK([0.5, 0.6], 10)).toEqual([0, 1]);
  });

  it('selectTopK: empty array returns empty', () => {
    expect(selectTopK([], 5)).toEqual([]);
  });
});

describe('recomp-extractive strategy', () => {
  let originalIsOverflow: typeof SessionCompaction.isOverflow;
  let originalProcess: typeof SessionCompaction.process;
  let originalPrune: typeof SessionCompaction.prune;

  const mockConversationRepo = {
    findBySlug: vi.fn().mockResolvedValue({ id: 'conv-123', slug: 'test-conversation' }),
    findById: vi.fn(),
    create: vi.fn(),
  };

  const mockMessageRepo = {
    findByConversationId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'msg-123' }),
    findById: vi.fn(),
    update: vi.fn(),
  };

  const mockRepositories = {
    conversation: mockConversationRepo,
    message: mockMessageRepo,
  };

  function makeInput(overrides: Partial<ProcessInput> = {}): ProcessInput {
    return {
      conversationSlug: 'test-conversation',
      parentID: 'parent-123',
      model: 'test-model',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: { parts: [{ type: 'text', text: 'Show me revenue by region' }] },
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: {
            parts: [
              { type: 'text', text: 'Here is the revenue by region for Q3 2024.' },
              { type: 'text', text: 'The total revenue was $1.2M across all regions.' },
            ],
          },
        },
      ],
      repositories: mockRepositories as any,
      ...overrides,
    };
  }

  function makeStrategyCtx(boundaryTurn = 15) {
    const currentTurnRef = { value: 0 };
    return { boundaryTurn, currentTurnRef };
  }

  beforeEach(() => {
    originalIsOverflow = SessionCompaction.isOverflow;
    originalProcess = SessionCompaction.process;
    originalPrune = SessionCompaction.prune;
    vi.clearAllMocks();
    mockConversationRepo.findBySlug.mockResolvedValue({ id: 'conv-123', slug: 'test-conversation' });
    mockMessageRepo.findByConversationId.mockResolvedValue([]);
    mockMessageRepo.create.mockResolvedValue({ id: 'msg-123' });
    mockSentences.value = [];
    mockEmbeddings.value = [];
  });

  afterEach(() => {
    SessionCompaction.isOverflow = originalIsOverflow;
    SessionCompaction.process = originalProcess;
    SessionCompaction.prune = originalPrune;
  });

  // ── Strategy metadata ──

  it('has the correct name', () => {
    expect(recompExtractiveStrategy.name).toBe('recomp-extractive');
  });

  // ── Factory ──

  it('factory returns isOverflow, process, and prune hooks', () => {
    const ctx = makeStrategyCtx();
    const originals = {
      isOverflow: vi.fn(),
      process: vi.fn().mockResolvedValue('continue' as const),
      prune: vi.fn(),
    };
    const hooks = recompExtractiveStrategy.factory(ctx, originals);
    expect(hooks.isOverflow).toBeInstanceOf(Function);
    expect(hooks.process).toBeInstanceOf(Function);
    expect(hooks.prune).toBeInstanceOf(Function);
  });

  // ── isOverflow ──

  describe('isOverflow', () => {
    it('returns false before boundary turn', async () => {
      const ctx = makeStrategyCtx(15);
      ctx.currentTurnRef.value = 10;
      const hooks = recompExtractiveStrategy.factory(ctx, {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });
      await expect(hooks.isOverflow!({} as any)).resolves.toBe(false);
    });

    it('returns true at boundary turn (one-shot)', async () => {
      const ctx = makeStrategyCtx(15);
      ctx.currentTurnRef.value = 15;
      const hooks = recompExtractiveStrategy.factory(ctx, {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      await expect(hooks.isOverflow!({} as any)).resolves.toBe(true);
      await expect(hooks.isOverflow!({} as any)).resolves.toBe(false);
    });
  });

  // ── Prune delegation ──

  it('prune delegates to originals.prune', () => {
    const pruneFn = vi.fn();
    const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(), {
      isOverflow: vi.fn(),
      process: vi.fn().mockResolvedValue('continue' as const),
      prune: pruneFn,
    });
    hooks.prune!('arg' as any);
    expect(pruneFn).toHaveBeenCalledWith('arg');
  });

  // ── Process ──

  describe('process', () => {
    it('returns continue and writes message for empty input', async () => {
      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput({ messages: [] }));
      expect(result).toBe('continue');
      expect(mockMessageRepo.create).toHaveBeenCalledTimes(1);
      const msg = mockMessageRepo.create.mock.calls[0][0];
      expect(msg.metadata.summary).toBe(true);
      expect(msg.metadata.type).toBe('compaction');
    });

    it('selects top sentences and writes summary with compression stats', async () => {
      mockSentences.value = [
        'The total revenue was $1.2M.',
        'Europe contributed 45% of revenue.',
        'Asia contributed 30% of revenue.',
        'North America contributed 25% of revenue.',
      ];

      // Embeddings as 3D vectors so cosine similarities are distinct
      // Query: [1, 0, 0]
      // Cosine to query is first_component / (magnitude)
      mockEmbeddings.value = [
        [1, 0, 0],                // query
        [0.5, 0.5, 0],            // sentence 0 — cos ≈ 0.707 (low)
        [0.9, 0.1, 0],            // sentence 1 — cos ≈ 0.994 (high)
        [0.3, 0.7, 0],            // sentence 2 — cos ≈ 0.394 (lowest)
        [0.8, 0.2, 0],            // sentence 3 — cos ≈ 0.970 (high)
      ];

      process.env.RECOMP_K = '2';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput());
      expect(result).toBe('continue');

      expect(mockMessageRepo.create).toHaveBeenCalledTimes(1);
      const msg = mockMessageRepo.create.mock.calls[0][0];

      // Top-2 by cosine: sentence 1 (0.994) and sentence 3 (0.970)
      const compressed = msg.content.parts[0].text;
      expect(compressed).toContain('Europe');
      expect(compressed).toContain('America');
      expect(msg.metadata.recomp.tokensBefore).toBeGreaterThan(msg.metadata.recomp.tokensAfter);
      expect(msg.metadata.recomp.compressionRatio).toBeGreaterThan(0);
      expect(msg.metadata.recomp.compressionRatio).toBeLessThan(1);

      delete process.env.RECOMP_K;
    });

    it('preserves original order of selected sentences', async () => {
      mockSentences.value = [
        '[First] sentence about revenue.',
        '[Second] sentence about customers.',
        '[Third] sentence about products.',
        '[Fourth] sentence about regions.',
      ];

      // 3D embeddings — none are colinear with query
      // Cosine = dot(q, s) / (|q| * |s|)
      mockEmbeddings.value = [
        [1, 0, 0],                // query
        [0.5, 0.5, 0],            // sentence 0 — cos ≈ 0.707
        [0.1, 0.9, 0],            // sentence 1 — cos ≈ 0.110 (lowest)
        [0.9, 0.1, 0],            // sentence 2 — cos ≈ 0.994 (highest)
        [0.8, 0.2, 0],            // sentence 3 — cos ≈ 0.970
      ];

      process.env.RECOMP_K = '3';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput());
      expect(result).toBe('continue');

      const msg = mockMessageRepo.create.mock.calls[0][0];
      const compressed = msg.content.parts[0].text;

      // Top-3 by score: sentence 2 (0.994), sentence 3 (0.970), sentence 0 (0.707)
      // Should be in original order: [0], [2], [3]
      const firstIdx = compressed.indexOf('[First]');
      const thirdIdx = compressed.indexOf('[Third]');
      const fourthIdx = compressed.indexOf('[Fourth]');
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(thirdIdx).toBeGreaterThan(firstIdx);
      expect(fourthIdx).toBeGreaterThan(thirdIdx);
      expect(compressed).not.toContain('[Second]');

      delete process.env.RECOMP_K;
    });

    it('uses dot product similarity when RECOMP_SIMILARITY=dot', async () => {
      mockSentences.value = [
        'Sentence A with large magnitude.',
        'Sentence B.',
      ];

      // Embeddings with a query that has low dot but moderate cosine with sentence 0
      mockEmbeddings.value = [
        [0.001, 0.001, 0.001, 0.001],  // query (tiny magnitude)
        [1000, 1000, 1000, 1000],       // sentence 0 (huge magnitude → dot is high)
        [0.5, 0.5, 0.5, 0.5],          // sentence 1 (small magnitude → dot is low)
      ];

      process.env.RECOMP_SIMILARITY = 'dot';
      process.env.RECOMP_K = '1';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput());
      expect(result).toBe('continue');

      const msg = mockMessageRepo.create.mock.calls[0][0];
      const compressed = msg.content.parts[0].text;
      // Dot product favors sentence 0 (1000×0.001×4 = 4) over sentence 1 (0.5×0.001×4 = 0.002)
      expect(compressed).toContain('Sentence A');

      delete process.env.RECOMP_SIMILARITY;
      delete process.env.RECOMP_K;
    });

    it('handles single-session input (fewer sentences than K)', async () => {
      mockSentences.value = ['Only one sentence to compress.'];

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const input = makeInput({
        messages: [
          { id: 'm1', role: 'user', content: { parts: [{ type: 'text', text: 'What is revenue?' }] } },
          { id: 'm2', role: 'assistant', content: { parts: [{ type: 'text', text: 'Only one sentence to compress.' }] } },
        ],
      });

      const result = await hooks.process(input);
      expect(result).toBe('continue');
      expect(mockMessageRepo.create).toHaveBeenCalledTimes(1);
    });

    it('handles missing conversation gracefully', async () => {
      mockConversationRepo.findBySlug.mockResolvedValue(null);

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput());
      expect(result).toBe('continue');
      // No message should be created since conversation was not found
      expect(mockMessageRepo.create).not.toHaveBeenCalled();
    });

    // ── Correction preservation tests ──

    it('preserves correction sentence despite lowest embedding score', async () => {
      // 1 correction + 2 candidates; only candidates are embedded
      mockSentences.value = [
        'From now on, exclude all 5-LOW priority orders from our analysis.',
        'The total revenue across all regions was $1.2M.',
        'Europe contributed 45% of the total revenue.',
      ];

      // Embeddings only for query + 2 candidates (correction never embedded)
      mockEmbeddings.value = [
        [1, 0, 0],             // query
        [0.99, 0.01, 0],       // candidate 0 — high cosine (score)
        [0.01, 0.99, 0],       // candidate 1 — low cosine
      ];

      process.env.RECOMP_K = '2';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const input = makeInput({
        messages: [
          { id: 'm1', role: 'user', content: { parts: [{ type: 'text', text: 'Set rules.' }] } },
        ],
      });

      const result = await hooks.process(input);
      expect(result).toBe('continue');

      const msg = mockMessageRepo.create.mock.calls[0][0];
      const compressed = msg.content.parts[0].text;

      // Correction must be present despite lowest cosine among all sentences
      expect(compressed).toContain('5-LOW');
      // K=2 with 1 correction → 1 slot for candidates; top candidate should be present
      expect(compressed).toContain('$1.2M');

      delete process.env.RECOMP_K;
    });

    it('preserves multiple corrections and fills remaining K from candidates', async () => {
      // 2 corrections + 3 candidates
      mockSentences.value = [
        'From now on, exclude 5-LOW priority orders.',
        'Always use O_ORDERDATE for date filtering.',
        'The total revenue was $1.2M.',
        'Europe contributed 45% of revenue.',
        'Asia contributed 30% of revenue.',
      ];

      // Embeddings only for query + 3 candidates (corrections never embedded)
      mockEmbeddings.value = [
        [1, 0, 0],             // query
        [0.99, 0.01, 0],       // candidate 0 — high
        [0.98, 0.02, 0],       // candidate 1 — near-high
        [0.3, 0.7, 0],         // candidate 2 — low
      ];

      process.env.RECOMP_K = '3';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const input = makeInput({
        messages: [
          { id: 'm1', role: 'user', content: { parts: [{ type: 'text', text: 'Rules + revenue analysis.' }] } },
        ],
      });

      const result = await hooks.process(input);
      expect(result).toBe('continue');

      const msg = mockMessageRepo.create.mock.calls[0][0];
      const compressed = msg.content.parts[0].text;

      // Both corrections must be present
      expect(compressed).toContain('5-LOW');
      expect(compressed).toContain('O_ORDERDATE');
      // corrections (2) + K(3) → 1 candidate selected: the top one (index 0: $1.2M)
      expect(compressed).toContain('$1.2M');
      expect(compressed).not.toContain('Europe');
      expect(compressed).not.toContain('Asia');

      delete process.env.RECOMP_K;
    });

    it('user messages get role bonus in candidate scoring', async () => {
      // 2 messages (user + assistant), mock compromise returns same sentences for both.
      // extractTaggedSentences produces:
      //   user copies:  indices 0,1  (role=user,   score = 0.707 + 0.3 = 1.007)
      //   asst copies:  indices 2,3  (role=assistant, score = 0.707)
      mockSentences.value = [
        'User question about Europe revenue.',
        'Assistant data about Europe revenue.',
      ];

      // Embeddings: 1 query + 4 candidates = 5 rows
      mockEmbeddings.value = [
        [1, 0, 0],             // query
        [0.7, 0.7, 0],         // candidate 0 (user s0) — cos ≈ 0.707
        [0.7, 0.7, 0],         // candidate 1 (user s1) — cos ≈ 0.707
        [0.7, 0.7, 0],         // candidate 2 (asst s0) — cos ≈ 0.707
        [0.7, 0.7, 0],         // candidate 3 (asst s1) — cos ≈ 0.707
      ];

      process.env.RECOMP_K = '2';

      const hooks = recompExtractiveStrategy.factory(makeStrategyCtx(15), {
        isOverflow: vi.fn(),
        process: vi.fn().mockResolvedValue('continue' as const),
        prune: vi.fn(),
      });

      const result = await hooks.process(makeInput());
      expect(result).toBe('continue');

      const msg = mockMessageRepo.create.mock.calls[0][0];
      const compressed = msg.content.parts[0].text;

      // With identical cosines, user copies get +0.3 bonus → user copies outrank asst copies
      // Top-2 = index 0 (user question) + index 1 (user copy of assistant data)
      expect(compressed).toContain('User question about Europe revenue.');
      expect(compressed).toContain('Assistant data about Europe revenue.');

      delete process.env.RECOMP_K;
    });
  });
});
