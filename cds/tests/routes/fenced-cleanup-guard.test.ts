import { describe, expect, it } from 'vitest';
import {
  findFencedCleanupRuntimeOwner,
  FENCED_CLEANUP_RUNTIME_PRODUCING_KINDS,
} from '../../src/routes/branches.js';
import type { BranchOperationKind } from '../../src/services/branch-operation-coordinator.js';

/**
 * R2 竞态根治守卫（2026-06-24）。
 * 被抢占的部署做 fenced cleanup 删容器前，若分支上有更新的「会接管容器」操作在跑，
 * 必须跳过删除 —— 否则删掉那个操作正用/即将重建的容器，紧随其后的 restart/auto-wake
 * 对已删容器 docker restart 就报 `No such container`（服务 0/N，反复同错）。
 */
function op(operationId: string, kind: BranchOperationKind, source = 'api.test') {
  return { operationId, request: { kind, source } };
}

describe('findFencedCleanupRuntimeOwner', () => {
  it('有更新的部署在跑 → 返回该 owner（应跳过删除）', () => {
    const owner = findFencedCleanupRuntimeOwner(
      [op('op_self', 'deploy'), op('op_newer', 'deploy', 'api.deploy')],
      'op_self',
    );
    expect(owner).not.toBeNull();
    expect(owner?.operationId).toBe('op_newer');
    expect(owner?.kind).toBe('deploy');
    expect(owner?.source).toBe('api.deploy');
  });

  it('抢占者是 restart / auto-restart / force-rebuild 等也算 runtime-producing', () => {
    for (const kind of ['restart', 'auto-restart', 'force-rebuild', 'deploy-profile', 'auto-lifecycle-redeploy'] as BranchOperationKind[]) {
      const owner = findFencedCleanupRuntimeOwner([op('op_other', kind)], 'op_self');
      expect(owner?.kind).toBe(kind);
    }
  });

  it('只有己方操作 → null（不阻止自己清理）', () => {
    expect(findFencedCleanupRuntimeOwner([op('op_self', 'deploy')], 'op_self')).toBeNull();
  });

  it('已取消的 runtime-producing 操作不算 owner（Codex P2）', () => {
    // 被取代但未收尾的旧部署 cancelled=true 仍挂在 active 列表；它不会接管容器，
    // 不能因它而跳过清理，否则失败容器被留下。
    const owner = findFencedCleanupRuntimeOwner(
      [{ operationId: 'op_old_cancelled', cancelled: true, request: { kind: 'deploy', source: 'api.old' } }],
      'op_self',
    );
    expect(owner).toBeNull();
  });

  it('混入已取消旧操作时，仍能找到未取消的新 owner', () => {
    const owner = findFencedCleanupRuntimeOwner(
      [
        { operationId: 'op_old_cancelled', cancelled: true, request: { kind: 'deploy', source: 'api.old' } },
        { operationId: 'op_newer', cancelled: false, request: { kind: 'restart', source: 'api.new' } },
      ],
      'op_self',
    );
    expect(owner?.operationId).toBe('op_newer');
  });

  it('抢占者是终止类操作（delete/stop/reset）→ 不算 runtime-producing，走原 terminal 判定', () => {
    for (const kind of ['delete', 'stop', 'reset', 'janitor-remove'] as BranchOperationKind[]) {
      expect(findFencedCleanupRuntimeOwner([op('op_term', kind)], 'op_self')).toBeNull();
    }
  });

  it('无活跃操作 / 空数组 → null', () => {
    expect(findFencedCleanupRuntimeOwner([], 'op_self')).toBeNull();
    expect(findFencedCleanupRuntimeOwner([], null)).toBeNull();
  });

  it('selfOperationId 为 null/undefined 时，任一 runtime-producing 操作都算 owner', () => {
    const owner = findFencedCleanupRuntimeOwner([op('op_x', 'deploy')], undefined);
    expect(owner?.operationId).toBe('op_x');
  });

  it('runtime-producing 集合恰好是这 6 类（防误扩/误缩）', () => {
    expect([...FENCED_CLEANUP_RUNTIME_PRODUCING_KINDS].sort()).toEqual(
      ['auto-lifecycle-redeploy', 'auto-restart', 'deploy', 'deploy-profile', 'force-rebuild', 'restart'].sort(),
    );
  });
});
