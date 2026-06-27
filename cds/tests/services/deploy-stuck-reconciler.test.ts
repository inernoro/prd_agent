import { describe, expect, it } from 'vitest';
import { reconcileStuckDeployStates } from '../../src/services/deploy-stuck-reconciler.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

function makeBranch(over: Partial<BranchEntry>): BranchEntry {
  return {
    id: 'b1',
    projectId: 'p1',
    branch: 'feature',
    worktreePath: '/tmp/wt',
    services: {},
    status: 'running',
    createdAt: '2026-06-27T00:00:00.000Z',
    ...over,
  } as BranchEntry;
}

function collectEvents() {
  const events: Array<{ action: string; message: string; details?: Record<string, unknown> }> = [];
  const sink: ServerEventLogSink = {
    record(r) {
      events.push({ action: r.action, message: r.message, details: r.details });
    },
  };
  return { events, sink };
}

// 极速版（CI 预构建）profile，使 branchUsesPrebuiltMode 返回 true。
const PREBUILT_PROFILES: BuildProfile[] = [
  {
    id: 'web',
    activeDeployMode: 'express',
    deployModes: { express: { prebuilt: true } },
  } as unknown as BuildProfile,
];

describe('reconcileStuckDeployStates — TYPE 2 卡死非终结态收敛', () => {
  it('stale starting with ready-after-start => corrected to running', () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      status: 'starting',
      lastDeployStartedAt: '2026-06-27T00:18:00.000Z',
      lastReadyAt: '2026-06-27T01:01:00.000Z', // ready 晚于 start ⇒ 实际已就绪
    });
    const { events, sink } = collectEvents();
    const updated: string[] = [];

    const results = reconcileStuckDeployStates([branch], {
      now,
      source: 'unit',
      serverEventLogStore: sink,
      emitBranchUpdated: (b) => updated.push(b.id),
    });

    expect(branch.status).toBe('running');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'branch-status-finalized',
      previousStatus: 'starting',
      nextStatus: 'running',
      via: 'timestamp-evidence',
    });
    expect(updated).toEqual(['b1']);
    expect(events[0]?.action).toBe('branch.stuck-state.finalized');
  });

  it('stale starting that was ready then stopped => corrected to idle', () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      status: 'starting',
      lastDeployStartedAt: '2026-06-27T00:18:00.000Z',
      lastReadyAt: '2026-06-27T01:01:00.000Z',
      lastStoppedAt: '2026-06-27T02:00:00.000Z', // 就绪后又被停 ⇒ idle
      lastStopReason: '自动降温',
    });

    const results = reconcileStuckDeployStates([branch], { now });

    expect(branch.status).toBe('idle');
    expect(results[0]).toMatchObject({ nextStatus: 'idle', via: 'timestamp-evidence' });
  });

  it("service 'stopping' finalized to 'stopped' once lastStoppedAt is stamped", () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      status: 'idle',
      lastDeployStartedAt: '2026-06-27T00:00:00.000Z',
      lastStoppedAt: '2026-06-27T03:00:00.000Z',
      services: {
        web: { profileId: 'web', containerName: 'c', hostPort: 1, status: 'stopping' },
      },
    });

    const results = reconcileStuckDeployStates([branch], { now });

    expect(branch.services.web.status).toBe('stopped');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'service-status-finalized',
      profileId: 'web',
      previousStatus: 'stopping',
      nextStatus: 'stopped',
      via: 'timestamp-evidence',
    });
  });

  it('conservative hard timeout NOT tripped for a young in-progress build', () => {
    const now = new Date('2026-06-27T00:10:00.000Z'); // 仅开始 10 分钟
    const branch = makeBranch({
      status: 'building',
      lastDeployStartedAt: '2026-06-27T00:00:00.000Z',
      // 无 lastReadyAt ⇒ 无时间戳证据，只能靠硬超时；但 10 分钟 << 45 分钟阈值
    });

    const results = reconcileStuckDeployStates([branch], { now });

    expect(branch.status).toBe('building'); // 未被触碰
    expect(results).toHaveLength(0);
  });

  it('hard timeout trips a long-stuck non-terminal state without timestamp evidence', () => {
    const now = new Date('2026-06-27T01:00:00.000Z'); // 开始 60 分钟前
    const branch = makeBranch({
      status: 'building',
      lastDeployStartedAt: '2026-06-27T00:00:00.000Z',
    });

    const results = reconcileStuckDeployStates([branch], { now });

    expect(branch.status).toBe('error');
    expect(results[0]).toMatchObject({ nextStatus: 'error', via: 'hard-timeout' });
  });
});

describe('reconcileStuckDeployStates — TYPE 1 极速版镜像落后 HEAD 告警', () => {
  it('express divergence with runtime diff => alarm (ciImageError set, no deploy)', () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      ciImageStatus: 'ready',
      ciTargetSha: 'aaaaaaa1111111',
      githubCommitSha: 'bbbbbbb2222222',
    });
    const { events, sink } = collectEvents();

    const results = reconcileStuckDeployStates([branch], {
      now,
      serverEventLogStore: sink,
      getBuildProfiles: () => PREBUILT_PROFILES,
      diffRuntimePaths: () => true, // 含运行时改动
    });

    expect(branch.ciImageStatus).toBe('ready'); // 未被改动（不自动部署）
    expect(branch.ciTargetSha).toBe('aaaaaaa1111111'); // ciTargetSha 不变
    expect(branch.ciImageError).toContain('极速版镜像落后 HEAD');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'express-head-divergence', via: 'alarm' });
    expect(events[0]?.action).toBe('branch.express-image.head-divergence');
  });

  it('express divergence with docs-only diff => no alarm', () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      ciImageStatus: 'ready',
      ciTargetSha: 'aaaaaaa1111111',
      githubCommitSha: 'bbbbbbb2222222',
    });

    const results = reconcileStuckDeployStates([branch], {
      now,
      getBuildProfiles: () => PREBUILT_PROFILES,
      diffRuntimePaths: () => false, // 纯文档
    });

    expect(branch.ciImageError).toBeUndefined();
    expect(results).toHaveLength(0);
  });

  it('no alarm when ciTargetSha equals HEAD (in sync)', () => {
    const now = new Date('2026-06-27T10:00:00.000Z');
    const branch = makeBranch({
      ciImageStatus: 'ready',
      ciTargetSha: 'samesha0000000',
      githubCommitSha: 'samesha0000000',
    });

    const results = reconcileStuckDeployStates([branch], {
      now,
      getBuildProfiles: () => PREBUILT_PROFILES,
      diffRuntimePaths: () => true,
    });

    expect(results).toHaveLength(0);
    expect(branch.ciImageError).toBeUndefined();
  });
});
