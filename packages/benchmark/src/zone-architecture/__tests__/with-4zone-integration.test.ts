import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionCompaction } from '@qwery/agent-factory-sdk';
import type { IsOverflowInput, ProcessInput } from '@qwery/agent-factory-sdk';

import { with4Zone } from '../../compaction/wrappers/with-4zone.js';
import { qweryDefaultStrategy } from '../../compaction/strategies/qwery-default.js';
import { baselineStrategy } from '../../compaction/strategies/baseline.js';
import { installStrategy } from '../../compaction/strategy.js';

// Mock the ai module
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({
      text: 'Mocked summary response',
      usage: { totalTokens: 100 }
    }),
    jsonSchema: vi.fn().mockImplementation((schema) => schema),
    tool: vi.fn().mockImplementation((config) => config),
  };
});

describe('with4Zone integration tests', () => {
  let restoreFns: Array<() => void> = [];
  let originalIsOverflow: typeof SessionCompaction.isOverflow;
  let originalProcess: typeof SessionCompaction.process;

  // Mock repositories
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

  beforeEach(() => {
    // Store original methods
    originalIsOverflow = SessionCompaction.isOverflow;
    originalProcess = SessionCompaction.process;
    
    // Reset mocks
    vi.clearAllMocks();
    
    // Reset mock implementations
    mockConversationRepo.findBySlug.mockResolvedValue({ id: 'conv-123', slug: 'test-conversation' });
    mockMessageRepo.findByConversationId.mockResolvedValue([]);
    mockMessageRepo.create.mockResolvedValue({ id: 'msg-123' });
  });

  afterEach(() => {
    // Restore original methods
    SessionCompaction.isOverflow = originalIsOverflow;
    SessionCompaction.process = originalProcess;
    
    // Restore any installed strategies
    for (const restore of restoreFns) {
      restore();
    }
    restoreFns = [];
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function createMockMessages(count = 2): ProcessInput['messages'] {
    const msgs: ProcessInput['messages'] = [];
    for (let i = 0; i < count; i++) {
      msgs.push({
        id: `msg-u-${i}`,
        role: 'user',
        conversationId: 'test-conv',
        content: { parts: [{ type: 'text' as const, text: `User turn ${i}` }] },
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'test',
        updatedBy: 'test',
      } as any);
      msgs.push({
        id: `msg-a-${i}`,
        role: 'assistant',
        conversationId: 'test-conv',
        content: { parts: [{ type: 'text' as const, text: `Assistant response ${i}` }] },
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'test',
        updatedBy: 'test',
      } as any);
    }
    return msgs;
  }

  function createMockInput(overrides: Partial<ProcessInput> = {}): ProcessInput {
    return {
      parentID: 'test-parent-id',
      messages: createMockMessages(2),
      conversationSlug: 'test-conversation',
      abort: new AbortController().signal,
      auto: true,
      repositories: mockRepositories as any,
      model: { providerID: 'test', modelID: 'test-model', limit: { context: 8000 } },
      ...overrides,
    } as ProcessInput;
  }

  function createMockOverflowInput(overrides: Partial<IsOverflowInput> = {}): IsOverflowInput {
    return {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { providerID: 'test', id: 'test-model', limit: { context: 8000 } },
      ...overrides,
    } as IsOverflowInput;
  }

  // ------------------------------------------------------------------
  // Phase A: Zone management – runs on every turn
  // ------------------------------------------------------------------
  describe('zone management (every turn)', () => {
    it('should assemble context and replace input.messages with 4-zone context', async () => {
      const turnRef = { value: 3 };
      const strategy = with4Zone(baselineStrategy);
      
      const { restore } = installStrategy(strategy, {
        boundaryTurn: 10,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      const input = createMockInput();
      
      // Capture the processed input
      let processedMessages: any = null;
      const originalProcessFn = SessionCompaction.process;
      SessionCompaction.process = async (input: any) => {
        const result = await originalProcessFn(input);
        processedMessages = input.messages;
        return result;
      };
      
      await SessionCompaction.process(input);
      
      // Verify messages were processed
      expect(processedMessages).toBeDefined();
      if (processedMessages) {
        expect(processedMessages.length).toBeGreaterThan(0);
        // Check that the messages include system prompts (4-zone context)
        const systemMessages = processedMessages.filter((m: any) => m.role === 'system');
        expect(systemMessages.length).toBeGreaterThan(0);
      }
    });

    it('should not trigger overflow for normal token counts', async () => {
      const turnRef = { value: 3 };
      const strategy = with4Zone(baselineStrategy);
      
      const { restore } = installStrategy(strategy, {
        boundaryTurn: 10,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      const overflowInput = createMockOverflowInput({
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      
      const overflow = await SessionCompaction.isOverflow(overflowInput);
      expect(overflow).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Phase B: Compaction – only when overflow fires
  // ------------------------------------------------------------------
  describe('compaction (only when overflow fires)', () => {
    it('should invoke compaction at boundary turn', async () => {
      const turnRef = { value: 0 };
      const strategy = with4Zone(qweryDefaultStrategy);
      
      const { restore, lastCompactionRef } = installStrategy(strategy, {
        boundaryTurn: 3,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      // Simulate turns until boundary
      for (let i = 1; i <= 3; i++) {
        turnRef.value = i;
        const overflowInput = createMockOverflowInput({
          tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        
        const overflow = await SessionCompaction.isOverflow(overflowInput);
        
        if (overflow) {
          const input = createMockInput({ messages: createMockMessages(i) });
          await SessionCompaction.process(input);
        }
      }

      // Wait a bit for any async operations to complete
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(lastCompactionRef.value).not.toBeNull();
      if (lastCompactionRef.value) {
        expect(lastCompactionRef.value.turnNumber).toBe(3);
      }
    });

    it('should handle overflow when token count exceeds threshold', async () => {
      const turnRef = { value: 3 };
      const strategy = with4Zone(baselineStrategy);
      
      const { restore } = installStrategy(strategy, {
        boundaryTurn: 10,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      const overflowInput = createMockOverflowInput({
        tokens: { input: 10000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      
      const overflow = await SessionCompaction.isOverflow(overflowInput);
      // With baselineStrategy, isOverflow always returns false
      expect(overflow).toBe(false);
    });

    it('should handle overflow and process compaction', async () => {
      const turnRef = { value: 0 };
      const strategy = with4Zone(qweryDefaultStrategy);
      
      const { restore, lastCompactionRef } = installStrategy(strategy, {
        boundaryTurn: 1,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      const overflowInput = createMockOverflowInput({
        tokens: { input: 5000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      
      turnRef.value = 1;
      const overflow = await SessionCompaction.isOverflow(overflowInput);
      // With qweryDefaultStrategy, overflow is true because turnRef >= boundaryTurn
      expect(overflow).toBe(true);

      const input = createMockInput({ messages: createMockMessages(5) });
      await SessionCompaction.process(input);
      
      // Wait a bit for any async operations to complete
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(lastCompactionRef.value).not.toBeNull();
      if (lastCompactionRef.value) {
        expect(lastCompactionRef.value.turnNumber).toBe(1);
      }
    });
  });

  // ------------------------------------------------------------------
  // Base strategy delegation
  // ------------------------------------------------------------------
  describe('base strategy delegation', () => {
    it('should invoke base isOverflow when boundary is hit', async () => {
      const turnRef = { value: 0 };
      const strategy = with4Zone(qweryDefaultStrategy);
      
      const { restore } = installStrategy(strategy, {
        boundaryTurn: 5,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      turnRef.value = 5;
      const overflowInput = createMockOverflowInput({
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      
      const overflow = await SessionCompaction.isOverflow(overflowInput);
      expect(overflow).toBe(true);
    });

    it('should NOT invoke base isOverflow before boundary', async () => {
      const turnRef = { value: 0 };
      const strategy = with4Zone(qweryDefaultStrategy);
      
      const { restore } = installStrategy(strategy, {
        boundaryTurn: 5,
        currentTurnRef: turnRef,
      });
      restoreFns.push(restore);

      turnRef.value = 3;
      const overflowInput = createMockOverflowInput({
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      
      const overflow = await SessionCompaction.isOverflow(overflowInput);
      expect(overflow).toBe(false);
    });
  });
});
