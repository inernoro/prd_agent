import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import { BranchDispatcher, type ExecutorSchedulerSnapshot, type SnapshotFetcher } from '../../src/scheduler/dispatcher.js';
import type { ExecutorNode } from '../../src/types.js';

/**
 * Tests for BranchDispatcher — Phase 3 capacity-aware executor selection.
 *
 * Strategy:
 * - Real StateService + ExecutorRegistry (cheap and exercises persistence)
 * - Mock SnapshotFetcher so we control each executor's scheduler snapshot
 *   without actually running HTTP servers
 */

class MockFetcher implements SnapshotFetcher {
  constructor(public responses: Map<string, ExecutorSchedulerSnapshot | null>) {}
  async fetch(executor: ExecutorNode): Promise<ExecutorSchedulerSnapshot | null> {
    return this.responses.get(executor.id) ?? null;
  }
}

function makeExecutor(id: string, extras: Partial<ExecutorNode> = {}): ExecutorNode {
  return {
    id,
    host: `${id}.local`,
    port: 9900,
    status: 'online',
    capacity: { maxBranches: 10, memoryMB: 8192, cpuCores: 4 },
    load: { memoryUsedMB: 0, cpuPercent: 0 },
    labels: [],
    branches: [],
    lastHeartbeat: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    ...extras,
  };
}

function makeSnapshot(current: number, max: number, enabled = true): ExecutorSchedulerSnapshot {
  return {
    enabled,
    capacityUsage: { current, max },
    hot: Array(current).fill(0).map((_, i) => ({ slug: `b${i}`, pinned: false })),
    cold: [],
  };
}

describe('BranchDispatcher', () => {
  let stateFile: string;
  let stateService: StateService;
  let registry: ExecutorRegistry;
  let dispatcher: BranchDispatcher;
  let fetcher: MockFetcher;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatcher-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    registry = new ExecutorRegistry(stateService);
    fetcher = new MockFetcher(new Map());
    dispatcher = new BranchDispatcher(registry, fetcher);
  });

  afterEach(() => {
    registry.stopHealthChecks();
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  // ── Idempotency: existing mapping ──

  describe('existing mapping', () => {
    it('returns the current host when branch is already deployed somewhere', async () => {
      stateService.setExecutor(makeExecutor('exec-a', { branches: ['feature-x'] }));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', makeSnapshot(5, 10));
      fetcher.responses.set('exec-b', makeSnapshot(1, 10));

      const result = await dispatcher.selectExecutorForBranch('feature-x');

      expect(result.executor?.id).toBe('exec-a');
      expect(result.reason).toContain('already deployed');
    });
  });

  // ── capacity-aware selection ──

  describe('capacity-aware strategy', () => {
    it('picks the executor with the lowest hot/max ratio', async () => {
      // exec-a: 9/10 = 90%
      // exec-b: 3/10 = 30%  ← should win
      // exec-c: 5/10 = 50%
      stateService.setExecutor(makeExecutor('exec-a'));
      stateService.setExecutor(makeExecutor('exec-b'));
      stateService.setExecutor(makeExecutor('exec-c'));
      fetcher.responses.set('exec-a', makeSnapshot(9, 10));
      fetcher.responses.set('exec-b', makeSnapshot(3, 10));
      fetcher.responses.set('exec-c', makeSnapshot(5, 10));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
      expect(result.reason).toContain('30%');
      expect(result.snapshots).toHaveLength(3);
    });

    it('handles different max capacities correctly (ratios not raw counts)', async () => {
      // exec-a: 2/4 = 50%
      // exec-b: 5/20 = 25%  ← should win (lower ratio even though higher raw count)
      stateService.setExecutor(makeExecutor('exec-a'));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', makeSnapshot(2, 4));
      fetcher.responses.set('exec-b', makeSnapshot(5, 20));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
    });

    it('breaks ties by branch count', async () => {
      // Both at 50% but exec-b has fewer branches overall
      stateService.setExecutor(makeExecutor('exec-a', { branches: ['x1', 'x2', 'x3'] }));
      stateService.setExecutor(makeExecutor('exec-b', { branches: ['y1'] }));
      fetcher.responses.set('exec-a', makeSnapshot(5, 10));
      fetcher.responses.set('exec-b', makeSnapshot(5, 10));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
    });

    it('ignores executors with disabled scheduler', async () => {
      // exec-a: disabled → must fall back to others
      // exec-b: enabled at 80% ← should win by default
      stateService.setExecutor(makeExecutor('exec-a'));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', makeSnapshot(1, 10, false));
      fetcher.responses.set('exec-b', makeSnapshot(8, 10, true));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
    });

    it('ignores executors whose snapshot fetch failed', async () => {
      stateService.setExecutor(makeExecutor('exec-a'));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', null); // fetch fail
      fetcher.responses.set('exec-b', makeSnapshot(5, 10));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
    });
  });

  // ── Fallback ──

  describe('fallback behavior', () => {
    it('falls back to least-branches when no usable snapshot available', async () => {
      stateService.setExecutor(makeExecutor('exec-a', { branches: ['a', 'b', 'c'] }));
      stateService.setExecutor(makeExecutor('exec-b', { branches: ['x'] }));
      // All snapshots unavailable
      fetcher.responses.set('exec-a', null);
      fetcher.responses.set('exec-b', null);

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
      expect(result.reason).toContain('fallback');
    });

    it('returns null when no executors are registered', async () => {
      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor).toBeNull();
      expect(result.reason).toContain('no online');
    });

    it('excludes offline executors from consideration', async () => {
      stateService.setExecutor(makeExecutor('exec-a', { status: 'offline' }));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', makeSnapshot(1, 10));
      fetcher.responses.set('exec-b', makeSnapshot(9, 10));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      // exec-a offline → exec-b wins even though it's at 90%
      expect(result.executor?.id).toBe('exec-b');
    });

    it('excludes draining executors from consideration', async () => {
      stateService.setExecutor(makeExecutor('exec-a', { status: 'draining' }));
      stateService.setExecutor(makeExecutor('exec-b'));
      fetcher.responses.set('exec-a', makeSnapshot(1, 10));
      fetcher.responses.set('exec-b', makeSnapshot(5, 10));

      const result = await dispatcher.selectExecutorForBranch('new-branch');

      expect(result.executor?.id).toBe('exec-b');
    });
  });

  // ── least-branches strategy ──

  describe('least-branches strategy', () => {
    it('uses the registry branch count, not snapshots', async () => {
      stateService.setExecutor(makeExecutor('exec-a', { branches: ['a', 'b'] }));
      stateService.setExecutor(makeExecutor('exec-b', { branches: ['c'] }));
      // Snapshots suggest exec-a has more room, but least-branches ignores them
      fetcher.responses.set('exec-a', makeSnapshot(1, 10));
      fetcher.responses.set('exec-b', makeSnapshot(9, 10));

      const result = await dispatcher.selectExecutorForBranch('new', 'least-branches');

      expect(result.executor?.id).toBe('exec-b');
      expect(result.reason).toContain('least-branches');
    });
  });

  // ── fetchAllSnapshots helper ──

  describe('fetchAllSnapshots', () => {
    it('fetches all online+non-draining executors in parallel', async () => {
      stateService.setExecutor(makeExecutor('exec-a'));
      stateService.setExecutor(makeExecutor('exec-b'));
      stateService.setExecutor(makeExecutor('exec-c', { status: 'offline' }));
      stateService.setExecutor(makeExecutor('exec-d', { status: 'draining' }));
      fetcher.responses.set('exec-a', makeSnapshot(1, 10));
      fetcher.responses.set('exec-b', makeSnapshot(2, 10));

      const pairs = await dispatcher.fetchAllSnapshots();

      expect(pairs).toHaveLength(2);
      expect(pairs.map(p => p.executor.id).sort()).toEqual(['exec-a', 'exec-b']);
    });
  });
});
