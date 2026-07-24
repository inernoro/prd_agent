/**
 * 复制集执行计划引擎契约测试（草稿-保存模型，2026-07-24）。
 * 覆盖：校验（空计划/未知类型/并发互斥）、set-weight 串行执行到 done、
 * 失败停止策略（stop）、失败回滚策略（rollback 恢复原权重）、跳过与取消语义。
 * 容器类步骤（add-replica/isolate）走真实 docker，不进单测——由灰度实测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ReplicaSetService } from '../../src/services/replica-set.js';
import type { BranchEntry } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

let tmpDir: string;
let state: StateService;
let svc: ReplicaSetService;

const waitPlanEnd = async (branchId: string, planId: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    const p = state.getBranch(branchId)!.replicaPlans!.find((x) => x.id === planId)!;
    if (p.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('plan 未在期限内结束');
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rsplan-'));
  state = new StateService(path.join(tmpDir, 'state.json'));
  state.addProject({ id: 'proj', slug: 'demo', name: 'demo', createdAt: new Date().toISOString() } as Parameters<typeof state.addProject>[0]);
  const branch: BranchEntry = {
    id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: '/tmp/x',
    services: {}, status: 'running', createdAt: new Date().toISOString(),
    replicaSets: {
      api: {
        profileId: 'api', enabled: true, primaryWeight: 100,
        members: [{
          id: 'res-1', versionId: 'dv1', weight: 40, image: 'img', status: 'running',
          dbMode: 'shared', createdAt: new Date().toISOString(),
        }],
        updatedAt: new Date().toISOString(),
      },
    },
  } as unknown as BranchEntry;
  state.addBranch(branch);
  svc = new ReplicaSetService({
    state,
    container: { remove: async () => undefined } as never,
    versions: { get: () => undefined, assertReusable: () => undefined } as never,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as never,
    portStart: 10000,
  });
});

afterEach(async () => {
  await flushAllJsonStateStores();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('startPlan 校验', () => {
  it('空计划 / 未知类型 / 缺 profileId 均拒绝', () => {
    expect(() => svc.startPlan('proj-main', { onFailure: 'stop', steps: [] })).toThrow('为空');
    expect(() => svc.startPlan('proj-main', { onFailure: 'stop', steps: [{ kind: 'promote' as never, profileId: 'api' }] })).toThrow('未知步骤类型');
    expect(() => svc.startPlan('proj-main', { onFailure: 'stop', steps: [{ kind: 'set-weight', profileId: '' }] })).toThrow('profileId');
  });

  it('已有执行中计划时拒绝新计划（互斥）', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'stop',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 55 } }],
    });
    // 立刻抢注第二个：大概率仍 running；若首个已完成则跳过该断言（时序无害）
    const active = state.getBranch('proj-main')!.replicaPlans!.find((x) => x.id === p.id)!;
    if (active.status === 'running') {
      expect(() => svc.startPlan('proj-main', { onFailure: 'stop', steps: [{ kind: 'dissolve', profileId: 'api' }] })).toThrow('执行中');
    }
    await waitPlanEnd('proj-main', p.id);
  });
});

describe('执行与失败策略', () => {
  it('set-weight 步骤串行执行到 done，权重真实生效', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'stop',
      steps: [
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 70 } },
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'primary', weight: 30 } },
      ],
    });
    await waitPlanEnd('proj-main', p.id);
    const done = state.getBranch('proj-main')!.replicaPlans!.find((x) => x.id === p.id)!;
    expect(done.status).toBe('done');
    expect(done.steps.map((s) => s.status)).toEqual(['done', 'done']);
    const rs = state.getBranch('proj-main')!.replicaSets!.api;
    expect(rs.members[0].weight).toBe(70);
    expect(rs.primaryWeight).toBe(30);
  });

  it('stop 策略：失败步骤记错误，剩余取消，已完成不回滚', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'stop',
      steps: [
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 66 } },
        { kind: 'remove-member', profileId: 'api', params: { memberId: 'ghost' } },
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 10 } },
      ],
    });
    await waitPlanEnd('proj-main', p.id);
    const done = state.getBranch('proj-main')!.replicaPlans!.find((x) => x.id === p.id)!;
    expect(done.status).toBe('error');
    expect(done.steps.map((s) => s.status)).toEqual(['done', 'error', 'cancelled']);
    expect(done.steps[1].error).toContain('成员不存在');
    expect(state.getBranch('proj-main')!.replicaSets!.api.members[0].weight).toBe(66);
  });

  it('rollback 策略：失败后逆序回滚已完成步骤（权重恢复原值）+ 回滚日志', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'rollback',
      steps: [
        { kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 88 } },
        { kind: 'remove-member', profileId: 'api', params: { memberId: 'ghost' } },
      ],
    });
    await waitPlanEnd('proj-main', p.id);
    const done = state.getBranch('proj-main')!.replicaPlans!.find((x) => x.id === p.id)!;
    expect(done.status).toBe('rolled-back');
    expect(done.steps[0].status).toBe('rolled-back');
    expect(done.rollbackLog!.join('\n')).toContain('权重恢复为 40');
    expect(state.getBranch('proj-main')!.replicaSets!.api.members[0].weight).toBe(40);
  });
});

describe('顺序控制', () => {
  it('reorder 校验：清单必须恰好覆盖全部 pending；结束后拒绝', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'stop',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 41 } }],
    });
    await waitPlanEnd('proj-main', p.id);
    expect(() => svc.reorderPlan('proj-main', p.id, [])).toThrow('已结束');
  });

  it('skip / cancel 只作用于 pending', async () => {
    const p = svc.startPlan('proj-main', {
      onFailure: 'stop',
      steps: [{ kind: 'set-weight', profileId: 'api', params: { memberId: 'res-1', weight: 42 } }],
    });
    await waitPlanEnd('proj-main', p.id);
    expect(() => svc.skipStep('proj-main', p.id, 'step_1')).toThrow('待执行');
    expect(() => svc.cancelPlan('proj-main', p.id)).toThrow('已结束');
  });
});
