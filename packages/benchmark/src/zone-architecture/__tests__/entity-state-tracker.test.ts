import { describe, it, expect, beforeEach } from 'vitest';
import { EntityStateTracker } from '../entity-state-tracker.js';

describe('EntityStateTracker', () => {
  let tracker: EntityStateTracker;

  beforeEach(() => {
    tracker = new EntityStateTracker();
  });

  describe('extractFromText', () => {
    it('should extract simple tables', () => {
      const sql = 'SELECT * FROM orders JOIN customer ON o_custkey = c_custkey';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.tables).toContain('orders');
      expect(extraction.tables).toContain('customer');
    });

    it('should extract dotted columns', () => {
      const sql = 'SELECT l.l_extendedprice FROM lineitem l WHERE l.l_orderkey = 1';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.columns).toContain('l_extendedprice');
      expect(extraction.columns).toContain('l_orderkey');
    });

    it('should handle SAAS style lowercase identifiers', () => {
      const sql = 'SELECT email FROM accounts WHERE created_at > "2023-01-01"';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.tables).toContain('accounts');
      expect(extraction.columns).toContain('email');
      expect(extraction.columns).toContain('created_at');
    });

    it('should extract multi-part identifiers', () => {
      const sql = 'SELECT db.schema.table.column FROM db.schema.table WHERE db.schema.table.id = 1';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.columns).toContain('column');
      expect(extraction.columns).toContain('id');
      expect(extraction.tables).toContain('table');
    });

    it('should extract complex aggregations with nested parentheses', () => {
      const sql = 'SELECT SUM(l.l_extendedprice * (1 - l.l_discount)) as revenue FROM lineitem l';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.aggregations[0]?.expression).toBe('SUM(l.l_extendedprice * (1 - l.l_discount))');
    });

    it('should extract filters with various operators', () => {
      const sql = 'SELECT * FROM orders WHERE o_totalprice > 1000 AND o_orderstatus = "O" AND o_comment LIKE "%priority%"';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.filters).toContainEqual({ column: 'o_totalprice', op: '>', value: '1000' });
      expect(extraction.filters).toContainEqual({ column: 'o_orderstatus', op: '=', value: 'O' });
      expect(extraction.filters).toContainEqual({ column: 'o_comment', op: 'LIKE', value: '%priority%' });
    });

    it('should handle SELECT lists with aliases', () => {
      const sql = 'SELECT o_orderkey AS id, o_totalprice FROM orders';
      const extraction = tracker.extractFromText(sql);
      expect(extraction.columns).toContain('o_orderkey');
      expect(extraction.columns).toContain('o_totalprice');
    });

    it('should extract open threads from conversation phrases', () => {
      tracker.extractFromText("Let's discuss the revenue trends for this quarter");
      const state = tracker.getState();
      expect(state.openThreads.length).toBe(1);
      expect(state.openThreads[0]).toContain('revenue');
    });

    it('should extract open threads from "show me" phrases', () => {
      tracker.extractFromText("Show me the top customers by sales");
      const state = tracker.getState();
      expect(state.openThreads.length).toBe(1);
      expect(state.openThreads[0]).toContain('top');
    });

    it('should extract open threads from "regarding" phrases', () => {
      tracker.extractFromText("Regarding the monthly report, what changed?");
      const state = tracker.getState();
      expect(state.openThreads.length).toBe(1);
      expect(state.openThreads[0]).toContain('monthly');
    });

    it('should not duplicate open threads', () => {
      tracker.extractFromText("Let's discuss revenue trends");
      tracker.extractFromText("Let's discuss revenue trends again");
      const state = tracker.getState();
      expect(state.openThreads.filter((t) => t.includes('revenue'))).toHaveLength(1);
    });
  });
});
