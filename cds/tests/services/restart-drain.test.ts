import { afterEach, describe, expect, it } from 'vitest';
import type { ActiveOperation } from '../../src/services/branch-operation-coordinator.js';
import {
  waitForRestartSafeBranchOperations,
  resolveRestartDrainTimeoutMs,
  DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
} from '../../src/services/restart-drain.js';

function activeOperation(kind: ActiveOperation['request']['kind'] = 'deploy'): ActiveOperation {
  return {
    operationId: 'op_active',
    branchId: 'prd-agent-main',
    generation: 1,
    startedAt: '2026-05-27T00:00:00.000Z',
    cancelled: false,
    request: {
      branchId: 'prd-agent-main',
      projectId: 'prd-agent',
      kind,
      trigger: 'webhook',
      actor: 'system:webhook',
      requestId: 'req_1',
      commitSha: 'abc123',
      source: 'api.deploy-branch',
    },
  };
}

// 2026-05-29 Cursor Bugbot(PR #684, High):默认排空上限必须是 deploy-safe 的 180s,
// 不再是会打断 deploy 的 5s;env 覆盖仍生效(0 = 不等)。
describe('resolveRestartDrainTimeoutMs', () => {
  const original = process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
    else process.env.CDS_RESTART_DRAIN_TIMEOUT_MS = original;
  });

  it('默认 180s(deploy-safe,不是被改坏的 5s)', () => {
    delete process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
    expect(DEFAULT_RESTART_DRAIN_TIMEOUT_MS).toBe(180_000);
    expect(resolveRestartDrainTimeoutMs()).toBe(180_000);
  });

  it('env 覆盖生效(含 0 = 立即重启不等)', () => {
    process.env.CDS_RESTART_DRAIN_TIMEOUT_MS = '0';
    expect(resolveRestartDrainTimeoutMs()).toBe(0);
    process.env.CDS_RESTART_DRAIN_TIMEOUT_MS = '30000';
    expect(resolveRestartDrainTimeoutMs()).toBe(30_000);
  });

  it('非法 env 回落默认', () => {
    process.env.CDS_RESTART_DRAIN_TIMEOUT_MS = 'abc';
    expect(resolveRestartDrainTimeoutMs()).toBe(180_000);
    process.env.CDS_RESTART_DRAIN_TIMEOUT_MS = '-5';
    expect(resolveRestartDrainTimeoutMs()).toBe(180_000);
  });
});

describe('waitForRestartSafeBranchOperations', () => {
  it('returns immediately when no branch write operation is active', async () => {
    const records: Array<{ action: string }> = [];
    const result = await waitForRestartSafeBranchOperations({
      source: 'api.self-update',
      getActiveOperations: () => [],
      serverEventLogStore: { record: (record) => records.push({ action: record.action }) },
      sleep: async () => { throw new Error('sleep should not be called'); },
      now: () => 0,
    });

    expect(result).toEqual({ ok: true, active: [] });
    expect(records).toEqual([]);
  });

  it('waits for an active deploy to drain before allowing restart', async () => {
    const records: Array<{ action: string; details?: Record<string, unknown> }> = [];
    let now = 0;
    let calls = 0;
    const result = await waitForRestartSafeBranchOperations({
      source: 'api.self-update',
      getActiveOperations: () => {
        calls += 1;
        return calls < 3 ? [activeOperation('deploy')] : [];
      },
      serverEventLogStore: {
        record: (record) => records.push({ action: record.action, details: record.details }),
      },
      timeoutMs: 5_000,
      intervalMs: 1_000,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    expect(result).toEqual({ ok: true, active: [] });
    expect(records.map((record) => record.action)).toEqual([
      'self-update.restart.waiting',
      'self-update.restart.wait-completed',
    ]);
    expect(records[0].details?.activeOperations).toEqual([
      {
        operationId: 'op_active',
        branchId: 'prd-agent-main',
        kind: 'deploy',
        source: 'api.deploy-branch',
        requestId: 'req_1',
      },
    ]);
  });

  it('defers restart when active branch operations do not drain before timeout', async () => {
    const records: Array<{ action: string; details?: Record<string, unknown> }> = [];
    let now = 0;
    const result = await waitForRestartSafeBranchOperations({
      source: 'api.self-update',
      getActiveOperations: () => [activeOperation('delete')],
      serverEventLogStore: {
        record: (record) => records.push({ action: record.action, details: record.details }),
      },
      timeoutMs: 2_000,
      intervalMs: 1_000,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    expect(result.ok).toBe(false);
    expect(result.active).toEqual([
      {
        operationId: 'op_active',
        branchId: 'prd-agent-main',
        kind: 'delete',
        source: 'api.deploy-branch',
        requestId: 'req_1',
      },
    ]);
    expect(records.map((record) => record.action)).toEqual([
      'self-update.restart.waiting',
      'self-update.restart.deferred',
    ]);
  });
});
