import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import type { ExecutorNode } from '../../src/types.js';

/**
 * Tests for ExecutorRegistry — cluster bootstrap additions focus on:
 *   - role defaulting ('remote' vs 'embedded')
 *   - registerEmbeddedMaster() used by standalone → scheduler upgrade
 *   - getTotalCapacity() feeding GET /api/executors/capacity
 *
 * Strategy: use the real StateService backed by a tmpfile, same pattern
 * as dispatcher.test.ts — it's cheap and exercises the persistence path.
 */

describe('ExecutorRegistry', () => {
  let tmpDir: string;
  let stateFile: string;
  let stateService: StateService;
  let registry: ExecutorRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-registry-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    registry = new ExecutorRegistry(stateService);
  });

  afterEach(() => {
    registry.stopHealthChecks();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  // ── register() ──

  describe('register()', () => {
    it('creates a new executor with role="remote" by default', () => {
      const node = registry.register({
        id: 'exec-a',
        host: 'exec-a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 2 },
      });

      expect(node.id).toBe('exec-a');
      expect(node.role).toBe('remote');
      expect(node.status).toBe('online');
      expect(node.labels).toEqual([]);
      expect(node.branches).toEqual([]);
      // Persisted to state
      expect(stateService.getExecutor('exec-a')?.role).toBe('remote');
    });

    it('honors an explicit role="embedded"', () => {
      const node = registry.register({
        id: 'embedded-self',
        host: '127.0.0.1',
        port: 9000,
        capacity: { maxBranches: 8, memoryMB: 16384, cpuCores: 8 },
        role: 'embedded',
      });

      expect(node.role).toBe('embedded');
    });

    it('preserves existing load, branches, registeredAt, and role on re-register', () => {
      // Seed an existing executor via StateService so we simulate a "restart"
      const original: ExecutorNode = {
        id: 'exec-a',
        host: 'old.local',
        port: 9900,
        status: 'online',
        capacity: { maxBranches: 2, memoryMB: 2048, cpuCores: 2 },
        load: { memoryUsedMB: 512, cpuPercent: 42 },
        labels: ['prev'],
        branches: ['branch-1', 'branch-2'],
        lastHeartbeat: '2026-01-01T00:00:00Z',
        registeredAt: '2025-12-01T00:00:00Z',
        role: 'embedded',
      };
      stateService.setExecutor(original);

      const updated = registry.register({
        id: 'exec-a',
        host: 'new.local',
        port: 9901,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });

      expect(updated.load).toEqual({ memoryUsedMB: 512, cpuPercent: 42 });
      expect(updated.branches).toEqual(['branch-1', 'branch-2']);
      expect(updated.registeredAt).toBe('2025-12-01T00:00:00Z');
      // No explicit role on re-register → keep prior 'embedded'
      expect(updated.role).toBe('embedded');
      // But new host/port/capacity must have been applied
      expect(updated.host).toBe('new.local');
      expect(updated.port).toBe(9901);
      expect(updated.capacity.maxBranches).toBe(4);
    });

    it('refuses to downgrade an embedded node to remote, even with explicit role (regression: #10)', () => {
      // Master self-registered as embedded
      registry.registerEmbeddedMaster(9000, 'master-host');
      expect(stateService.getExecutor('master-master-host')?.role).toBe('embedded');

      // A subsequent register call with the SAME id but role='remote' must
      // not be able to downgrade the embedded entry. This protects the
      // embedded deploy path from being silently disabled by a buggy or
      // malicious remote that claims the master's id.
      const result = registry.register({
        id: 'master-master-host',
        host: 'attacker.local',
        port: 9999,
        capacity: { maxBranches: 0, memoryMB: 0, cpuCores: 0 },
        role: 'remote',
      });

      expect(result.role).toBe('embedded');
      expect(stateService.getExecutor('master-master-host')?.role).toBe('embedded');
    });
  });

  // ── registerEmbeddedMaster() ──

  describe('registerEmbeddedMaster()', () => {
    it('creates a node with role="embedded" and labels ["embedded", "master"]', () => {
      const node = registry.registerEmbeddedMaster(9000, 'test-host');

      expect(node.role).toBe('embedded');
      expect(node.labels).toEqual(['embedded', 'master']);
      expect(node.id).toBe('master-test-host');
      // Always loopback inside the master itself
      expect(node.host).toBe('127.0.0.1');
      expect(node.port).toBe(9000);
      // Capacity heuristic uses real os.* values → just assert sanity
      expect(node.capacity.maxBranches).toBeGreaterThanOrEqual(2);
      expect(node.capacity.memoryMB).toBeGreaterThan(0);
      expect(node.capacity.cpuCores).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent — calling twice leaves a single master node', () => {
      registry.registerEmbeddedMaster(9000, 'test-host');
      registry.registerEmbeddedMaster(9000, 'test-host');

      const all = registry.getAll();
      const masters = all.filter(n => n.id === 'master-test-host');
      expect(masters).toHaveLength(1);
      expect(masters[0].role).toBe('embedded');
    });
  });

  // ── getTotalCapacity() ──

  describe('getTotalCapacity()', () => {
    it('returns zeros cleanly when no executors exist', () => {
      const cap = registry.getTotalCapacity();

      expect(cap.online).toBe(0);
      expect(cap.offline).toBe(0);
      expect(cap.total).toEqual({ maxBranches: 0, memoryMB: 0, cpuCores: 0 });
      expect(cap.used).toEqual({ branches: 0, memoryMB: 0, cpuPercent: 0 });
      expect(cap.freePercent).toBe(0);
      expect(cap.nodes).toEqual([]);
    });

    it('sums maxBranches, memoryMB, and cpuCores across online executors', () => {
      registry.register({
        id: 'a',
        host: 'a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      registry.register({
        id: 'b',
        host: 'b.local',
        port: 9900,
        capacity: { maxBranches: 8, memoryMB: 8192, cpuCores: 8 },
      });

      const cap = registry.getTotalCapacity();

      expect(cap.online).toBe(2);
      expect(cap.offline).toBe(0);
      expect(cap.total).toEqual({ maxBranches: 12, memoryMB: 12288, cpuCores: 12 });
      expect(cap.nodes).toHaveLength(2);
    });

    it('excludes offline executors from totals (but still reports them under offline count)', () => {
      // Register two, then force one offline through the state layer.
      registry.register({
        id: 'online-1',
        host: 'a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      registry.register({
        id: 'offline-1',
        host: 'b.local',
        port: 9900,
        capacity: { maxBranches: 8, memoryMB: 8192, cpuCores: 8 },
      });
      const offlineNode = stateService.getExecutor('offline-1')!;
      offlineNode.status = 'offline';
      stateService.setExecutor(offlineNode);

      const cap = registry.getTotalCapacity();

      expect(cap.online).toBe(1);
      expect(cap.offline).toBe(1);
      // Only the online node's capacity is summed into total
      expect(cap.total).toEqual({ maxBranches: 4, memoryMB: 4096, cpuCores: 4 });
      // Both appear in the nodes list (so dashboard can render offline state)
      expect(cap.nodes).toHaveLength(2);
    });

    it('computes freePercent from memory-free and cpu-free averaged', () => {
      // One executor at 50% mem, 50% cpu → freePercent should be ≈50
      registry.register({
        id: 'a',
        host: 'a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 1000, cpuCores: 4 },
      });
      registry.heartbeat('a', {
        load: { memoryUsedMB: 500, cpuPercent: 50 },
        branches: {},
      });

      const cap = registry.getTotalCapacity();

      // memFree = 100 - 50 = 50 ; cpuFree = 100 - 50 = 50 ; avg = 50
      expect(cap.freePercent).toBe(50);
      expect(cap.used.memoryMB).toBe(500);
      expect(cap.used.cpuPercent).toBe(50);
    });

    it('counts branches across online executors into used.branches', () => {
      registry.register({
        id: 'a',
        host: 'a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      registry.heartbeat('a', {
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        branches: { 'branch-1': { status: 'running', services: {} }, 'branch-2': { status: 'running', services: {} } },
      });

      const cap = registry.getTotalCapacity();
      expect(cap.used.branches).toBe(2);
    });
  });

  // ── heartbeat() ──

  describe('heartbeat()', () => {
    it('updates load, branches, and marks executor online', () => {
      registry.register({
        id: 'a',
        host: 'a.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });

      // Force offline to prove heartbeat flips it back
      const n = stateService.getExecutor('a')!;
      n.status = 'offline';
      stateService.setExecutor(n);

      const ok = registry.heartbeat('a', {
        load: { memoryUsedMB: 1024, cpuPercent: 30 },
        branches: { 'branch-x': { status: 'running', services: {} } },
      });

      expect(ok).toBe(true);
      const after = stateService.getExecutor('a')!;
      expect(after.status).toBe('online');
      expect(after.load).toEqual({ memoryUsedMB: 1024, cpuPercent: 30 });
      expect(after.branches).toEqual(['branch-x']);
    });

    it('returns false when the executor does not exist', () => {
      const ok = registry.heartbeat('does-not-exist', {
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        branches: {},
      });
      expect(ok).toBe(false);
    });
  });

  // ── checkHealth() — offline GC (regression: #8) ──
  //
  // checkHealth is private; we invoke it via the (registry as any) cast
  // rather than starting the real interval timer (which would make tests slow
  // and flaky). This is acceptable: registry has a small surface area and
  // we own both sides of the test.

  describe('checkHealth() offline GC', () => {
    /** Helper: poke checkHealth without exposing it on the public API. */
    function runHealthCheck(): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (registry as any).checkHealth();
    }

    function setLastHeartbeat(id: string, msAgo: number): void {
      const node = stateService.getExecutor(id)!;
      node.lastHeartbeat = new Date(Date.now() - msAgo).toISOString();
      stateService.setExecutor(node);
    }

    it('marks online node offline after heartbeat timeout (45s)', () => {
      registry.register({
        id: 'stale',
        host: 'stale.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      // Push lastHeartbeat 60 seconds into the past (> 45s timeout)
      setLastHeartbeat('stale', 60_000);

      runHealthCheck();

      expect(stateService.getExecutor('stale')?.status).toBe('offline');
    });

    it('garbage-collects remote nodes offline > 24h', () => {
      registry.register({
        id: 'ghost',
        host: 'ghost.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      // Force offline + 25 hour-old heartbeat
      const node = stateService.getExecutor('ghost')!;
      node.status = 'offline';
      node.lastHeartbeat = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      stateService.setExecutor(node);

      runHealthCheck();

      // GC removes the entry entirely
      expect(stateService.getExecutor('ghost')).toBeUndefined();
    });

    it('does NOT GC remote nodes offline < 24h', () => {
      registry.register({
        id: 'recent',
        host: 'recent.local',
        port: 9900,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });
      // 23 hours ago — under the GC threshold
      const node = stateService.getExecutor('recent')!;
      node.status = 'offline';
      node.lastHeartbeat = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      stateService.setExecutor(node);

      runHealthCheck();

      // Still present, still offline
      expect(stateService.getExecutor('recent')?.status).toBe('offline');
    });

    it('NEVER GCs embedded master nodes regardless of age', () => {
      registry.registerEmbeddedMaster(9000, 'survivor');
      // Force offline + ancient heartbeat (1 year ago)
      const node = stateService.getExecutor('master-survivor')!;
      node.status = 'offline';
      node.lastHeartbeat = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      stateService.setExecutor(node);

      runHealthCheck();

      // Embedded survives even at 1 year offline — it'll re-register on next boot
      expect(stateService.getExecutor('master-survivor')).toBeDefined();
      expect(stateService.getExecutor('master-survivor')?.role).toBe('embedded');
    });

    it('NEVER flips embedded master to offline even if heartbeat is stale (regression)', () => {
      // Embedded master doesn't send heartbeats — it IS the master process.
      // Bug: the old checkHealth() blindly compared lastHeartbeat to now and
      // flipped embedded nodes to offline after 45s, cascading into a
      // "total capacity = 0" dashboard state (seen on both cds.miduo.org
      // and the B server with online:0 / memoryMB:0 in /api/cluster/status).
      registry.registerEmbeddedMaster(9000, 'alive');
      const before = stateService.getExecutor('master-alive')!;
      expect(before.status).toBe('online');

      // Force lastHeartbeat way into the past so the old bug would trigger.
      before.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      stateService.setExecutor(before);

      runHealthCheck();

      // Post-fix: embedded stays online no matter what the clock says.
      const after = stateService.getExecutor('master-alive')!;
      expect(after.status).toBe('online');
    });

    it('capacity totals remain non-zero after a stale health tick (regression)', () => {
      registry.registerEmbeddedMaster(9000, 'totals-check');
      // Simulate embedded master lastHeartbeat going stale (time passes,
      // no-one touches it). Before the fix this would break getTotalCapacity.
      const node = stateService.getExecutor('master-totals-check')!;
      node.lastHeartbeat = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      stateService.setExecutor(node);

      runHealthCheck();

      const cap = registry.getTotalCapacity();
      expect(cap.online).toBeGreaterThanOrEqual(1);
      expect(cap.total.memoryMB).toBeGreaterThan(0);
      expect(cap.total.cpuCores).toBeGreaterThan(0);
    });
  });
});
