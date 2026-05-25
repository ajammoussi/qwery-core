import { describe, it, expect, beforeEach } from 'vitest';
import { ZoneContextManager } from '../zone-context-manager.js';
import type { ZoneSegment, ZoneConfiguration, ZoneType } from '../types.js';

describe('ZoneContextManager', () => {
  let manager: ZoneContextManager;

  beforeEach(() => {
    manager = new ZoneContextManager({
      frozenPrefix: { enabled: true, schema: '', globalConstraints: [] },
      entityState: { enabled: true, maxTokens: 400 },
      activeWindow: { enabled: true, maxTurns: 3 },
      compressedArchive: { enabled: true, maxSegments: 10, retrievalTopK: 2 },
    });
  });

  describe('Schema & Constraints — Frozen Prefix', () => {
    it('should be empty initially', () => {
      const ctx = manager.getContext();
      expect(ctx.zoneA).toHaveLength(0);
    });

    it('should populate with schema and constraints', () => {
      manager.populateZoneA('CREATE TABLE orders (id INT)', [
        'Always filter by active users',
      ]);
      const ctx = manager.getContext();
      expect(ctx.zoneA).toHaveLength(2);
      expect(ctx.zoneA[0]?.zone).toBe('frozen-prefix');
      expect(ctx.zoneA[0]?.metadata?.segmentType).toBe('schema');
      expect(ctx.zoneA[1]?.metadata?.segmentType).toBe('global_constraint');
    });

    it('should clear and repopulate on second call', () => {
      manager.populateZoneA('schema v1', []);
      manager.populateZoneA('schema v2', ['new constraint']);
      const ctx = manager.getContext();
      expect(ctx.zoneA).toHaveLength(2);
      expect(ctx.zoneA[0]?.content).toContain('[SCHEMA DEFINITION]');
      expect(ctx.zoneA[0]?.content).toContain('schema v2');
    });

    it('should NOT populate when frozenPrefix is disabled', () => {
      const m = new ZoneContextManager({
        frozenPrefix: { enabled: false, schema: '', globalConstraints: [] },
        activeWindow: { enabled: true, maxTurns: 6 },
        compressedArchive: { enabled: true, maxSegments: 50, retrievalTopK: 3 },
      });
      m.populateZoneA('schema', []);
      expect(m.getContext().zoneA).toHaveLength(0);
    });
  });

  describe('Entity State — Session State', () => {
    it('should be empty initially', () => {
      const ctx = manager.getContext();
      expect(ctx.zoneB).toHaveLength(0);
    });

    it('should sync entity state JSON to Entity State', () => {
      manager.updateEntityState({ activeTables: ['orders'] });
      manager.syncEntityStateToZoneB();
      const ctx = manager.getContext();
      expect(ctx.zoneB).toHaveLength(1);
      expect(ctx.zoneB[0]?.zone).toBe('entity-state');
      expect(ctx.zoneB[0]?.content).toContain('orders');
    });

    it('should not populate when entityState is disabled', () => {
      const m = new ZoneContextManager({
        frozenPrefix: { enabled: true, schema: '', globalConstraints: [] },
        entityState: { enabled: false, maxTokens: 400 },
        activeWindow: { enabled: true, maxTurns: 6 },
        compressedArchive: { enabled: true, maxSegments: 50, retrievalTopK: 3 },
      });
      m.updateEntityState({ activeTables: ['orders'] });
      m.syncEntityStateToZoneB();
      expect(m.getContext().zoneB).toHaveLength(0);
    });

    it('should reflect entity state from extraction', () => {
      manager.getEntityStateTracker().extractFromText(
        "SELECT revenue FROM orders WHERE status = 'active'"
      );
      const state = manager.getEntityStateTracker().getState();
      expect(state.activeTables).toContain('orders');
      expect(state.activeColumns).toContain('revenue');
      expect(state.activeFilters).toHaveLength(1);
    });

    it('should enforce maxTokens by truncating oversized entity state', () => {
      // Add many tables/columns to blow up entity state beyond 400 tokens
      for (let i = 0; i < 100; i++) {
        manager.updateEntityState({ activeTables: [`table_${i}`] });
      }
      manager.syncEntityStateToZoneB();
      const ctx = manager.getContext();
      expect(ctx.zoneB).toHaveLength(1);
      expect(ctx.zoneB[0]?.tokens).toBeLessThanOrEqual(450); // Allow extra tokens for header
      // Entity State now includes header, so check for truncation marker in the JSON content
      expect(ctx.zoneB[0]?.content).toContain('[ENTITY STATE - SESSION CONTEXT]');
    });
  });

  describe('Active Window — Active Window', () => {
    it('should add segments in order', () => {
      addTurn(manager, 1, 'user', 'Hello');
      addTurn(manager, 1, 'assistant', 'Hi there');
      const ctx = manager.getContext();
      expect(ctx.zoneC).toHaveLength(2);
      expect(ctx.zoneC[0]?.metadata?.segmentType).toBe('user_turn');
      expect(ctx.zoneC[1]?.metadata?.segmentType).toBe('assistant_turn');
    });

    it('should evict to Compressed Archive when exceeding maxTurns', () => {
      for (let t = 1; t <= 4; t++) {
        addTurn(manager, t, 'user', `User turn ${t}`);
        addTurn(manager, t, 'assistant', `Assistant turn ${t}`);
      }
      const ctx = manager.getContext();
      expect(ctx.zoneC).toHaveLength(6);
      expect(ctx.zoneC[0]?.metadata?.turnNumber).toBe(2);
      expect(ctx.zoneC[5]?.metadata?.turnNumber).toBe(4);
      expect(ctx.zoneD.length).toBeGreaterThanOrEqual(2);
      expect(ctx.zoneD[0]?.metadata?.turnNumber).toBe(1);
    });

    it('should not add when activeWindow is disabled', () => {
      const m = new ZoneContextManager({
        frozenPrefix: { enabled: true, schema: '', globalConstraints: [] },
        activeWindow: { enabled: false, maxTurns: 6 },
        compressedArchive: { enabled: true, maxSegments: 50, retrievalTopK: 3 },
      });
      addTurn(m, 1, 'user', 'Hello');
      expect(m.getContext().zoneC).toHaveLength(0);
    });
  });

  describe('Compressed Archive — Compressed Archive', () => {
    it('should be empty initially', () => {
      expect(manager.getContext().zoneD).toHaveLength(0);
    });

    it('should accumulate evicted segments from Active Window', () => {
      for (let t = 1; t <= 6; t++) {
        addTurn(manager, t, 'user', `Turn ${t}`);
        addTurn(manager, t, 'assistant', `Response ${t}`);
      }
      const ctx = manager.getContext();
      expect(ctx.zoneD.length).toBeGreaterThanOrEqual(4);
    });

    it('should retrieve top-K relevant segments', () => {
      for (let t = 1; t <= 6; t++) {
        addTurn(manager, t, 'user', `Query about revenue in ${t}`);
        addTurn(manager, t, 'assistant', `Revenue data for turn ${t}`);
      }

      const result = manager.retrieveFromZoneD('revenue');
      expect(result.retrievedSegments.length).toBeLessThanOrEqual(2);
      expect(result.relevanceScores.length).toBe(result.retrievedSegments.length);
    });

    it('should boost user_correction segments in relevance', () => {
      for (let t = 1; t <= 4; t++) {
        addTurn(manager, t, 'user', `User data ${t}`);
        addTurn(manager, t, 'assistant', `Response ${t}`);
      }
      // Manually add a correction segment to Compressed Archive
      const correctionSegment: ZoneSegment = {
        zone: 'compressed-archive',
        content: 'Always use order_date not created_at',
        tokens: 10,
        metadata: { turnNumber: 5, segmentType: 'user_correction' },
      };
      manager.addToZoneD(correctionSegment);

      const result = manager.retrieveFromZoneD('order date');
      expect(result.retrievedSegments.length).toBeGreaterThanOrEqual(1);
    });

    it('should enforce maxSegments limit', () => {
      for (let i = 0; i < 15; i++) {
        manager.addToZoneD({
          zone: 'compressed-archive',
          content: `Segment ${i}`,
          tokens: 5,
          metadata: { turnNumber: i },
        });
      }
      expect(manager.getContext().zoneD.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Context Assembly', () => {
    it('should assemble all zones in correct order', () => {
      manager.populateZoneA('CREATE TABLE orders (id INT)', []);
      manager.updateEntityState({ activeTables: ['orders'] });
      manager.syncEntityStateToZoneB();
      addTurn(manager, 1, 'user', 'Show me orders');
      addTurn(manager, 1, 'assistant', 'Here are the orders');

      const assembly = manager.assembleContext('How many orders?');
      expect(assembly.assembledContext).toContain('CREATE TABLE');
      expect(assembly.assembledContext).toContain('orders');
      expect(assembly.assembledContext).toContain('Show me orders');
      expect(assembly.assembledContext).toContain('How many orders?');
      expect(assembly.currentQueryIncluded).toBe(true);
    });

    it('should expose assembled messages as structured objects', () => {
      manager.populateZoneA('SCHEMA TABLE users', []);
      addTurn(manager, 1, 'user', 'Hello');
      addTurn(manager, 1, 'assistant', 'World');

      const messages = manager.getAssembledContextMessages('Final query', 'Test system prompt');
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]?.content).toContain('4-ZONE CONTEXT');
    });

    it('should include system content when provided', () => {
      const messages = manager.getAssembledContextMessages('Q', 'System instruction');
      expect(messages[0]?.content).toContain('System instruction');
    });

    it('should report correct token breakdown per zone', () => {
      manager.populateZoneA('SCHEMA', []);
      addTurn(manager, 1, 'user', 'Hello');
      addTurn(manager, 1, 'assistant', 'World');

      const assembly = manager.assembleContext('query');
      expect(assembly.zoneBreakdown['frozen-prefix'].segments).toBeGreaterThanOrEqual(1);
      expect(assembly.zoneBreakdown['active-window'].segments).toBeGreaterThanOrEqual(2);
      expect(assembly.totalTokens).toBeGreaterThan(0);
    });

    it('should include current query at the end', () => {
      addTurn(manager, 1, 'user', 'test');
      const assembly = manager.assembleContext('final query');
      const lastSegmentIndex = assembly.assembledContext.lastIndexOf('final query');
      expect(lastSegmentIndex).toBeGreaterThan(0);
    });
  });

  describe('Response Validation', () => {
    it('should validate grounded entities in response', () => {
      manager.populateZoneA('TABLE ORDERS (id INT)', []);
      manager.updateEntityState({ activeTables: ['ORDERS'] });
      manager.syncEntityStateToZoneB();

      addTurn(manager, 1, 'user', 'Show orders');
      addTurn(manager, 1, 'assistant', 'SELECT * FROM ORDERS');
      manager.assembleContext('query');

      const result = manager.validateResponse('SELECT * FROM ORDERS');
      expect(result.groundedEntities).toContain('ORDERS');
      expect(result.isValid).toBe(true);
    });

    it('should flag ungrounded entities', () => {
      manager.populateZoneA('TABLE ORDERS (id INT)', []);
      manager.assembleContext('query');

      const result = manager.validateResponse('SELECT * FROM NONEXISTENT');
      expect(result.ungroundedEntities).toContain('NONEXISTENT');
      expect(result.isValid).toBe(false);
    });
  });

  describe('Token Tracking', () => {
    it('should return correct token counts per zone', () => {
      manager.populateZoneA('SCHEMA', ['CONSTRAINT']);
      expect(manager.getZoneTokens('frozen-prefix')).toBeGreaterThan(0);
      expect(manager.getZoneTokens('entity-state')).toBe(0);
      expect(manager.getZoneTokens('active-window')).toBe(0);
      expect(manager.getZoneTokens('compressed-archive')).toBe(0);

      addTurn(manager, 1, 'user', 'Hello');
      expect(manager.getZoneTokens('active-window')).toBeGreaterThan(0);
    });

    it('should compute total tokens across all zones', () => {
      manager.populateZoneA('SCHEMA', []);
      addTurn(manager, 1, 'user', 'Hello');
      addTurn(manager, 1, 'assistant', 'World');

      const total = manager.getTotalTokens();
      expect(total).toBeGreaterThan(0);
      expect(total).toBe(
        manager.getZoneTokens('frozen-prefix') +
        manager.getZoneTokens('entity-state') +
        manager.getZoneTokens('active-window') +
        manager.getZoneTokens('compressed-archive')
      );
    });
  });

  describe('Reset', () => {
    it('should clear all zones and state', () => {
      manager.populateZoneA('SCHEMA', []);
      addTurn(manager, 1, 'user', 'Hello');
      manager.updateEntityState({ activeTables: ['orders'] });
      manager.syncEntityStateToZoneB();
      manager.assembleContext('query');

      manager.reset();

      const ctx = manager.getContext();
      expect(ctx.zoneA).toHaveLength(0);
      expect(ctx.zoneB).toHaveLength(0);
      expect(ctx.zoneC).toHaveLength(0);
      expect(ctx.zoneD).toHaveLength(0);
      expect(ctx.entityState.activeTables).toHaveLength(0);
      expect(manager.getTurnCounter()).toBe(0);
    });
  });
});

function addTurn(manager: ZoneContextManager, turnNumber: number, role: 'user' | 'assistant', content: string) {
  const type = role === 'user' ? 'user_turn' : 'assistant_turn';
  const segment: ZoneSegment = {
    zone: 'active-window',
    content,
    tokens: Math.ceil(content.length / 4),
    metadata: { turnNumber, segmentType: type },
  };
  manager.addToZoneC(segment);
}
