/**
 * promote 影响面计算契约测试（Codex 第十五轮 P1）：DeploymentVersion 是整分支
 * 快照，「提升成员」= 整分支回滚——多服务分支上必须显式列出会被连带改动的
 * 其他 profile，由路由层拒绝静默执行（要求 confirmWholeBranch: true）。
 */
import { describe, expect, it } from 'vitest';
import { promoteAffectedProfiles } from '../../src/routes/replica-sets.js';
import type { DeploymentVersion, DeploymentVersionProfile } from '../../src/types.js';

function ver(id: string, profiles: Array<Partial<DeploymentVersionProfile> & { profileId: string; artifactImage: string }>): DeploymentVersion {
  return {
    id, projectId: 'proj', branchId: 'proj-main', commitSha: 'c0ffee1', configHash: 'h',
    profiles: profiles.map((p) => ({
      name: p.profileId, artifactKind: 'prebuilt-image' as const, reusable: true, containerPort: 3000, ...p,
    })) as DeploymentVersionProfile[],
    migrations: [], capabilities: [], createdByRunId: 'run', createdAt: new Date().toISOString(),
  };
}

describe('promoteAffectedProfiles', () => {
  it('其他服务在两个版本里完全一致 → 无连带影响，promote 可直接放行', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'api@sha256:old' }, { profileId: 'web', artifactImage: 'web@sha256:same' }]);
    const current = ver('dv_new', [{ profileId: 'api', artifactImage: 'api@sha256:new' }, { profileId: 'web', artifactImage: 'web@sha256:same' }]);
    expect(promoteAffectedProfiles(target, current, 'api')).toEqual([]);
  });

  it('其他服务镜像不同 → 列入影响面（整分支回滚会把 web 也拉回历史版本）', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'api@sha256:old' }, { profileId: 'web', artifactImage: 'web@sha256:old' }]);
    const current = ver('dv_new', [{ profileId: 'api', artifactImage: 'api@sha256:new' }, { profileId: 'web', artifactImage: 'web@sha256:new' }]);
    expect(promoteAffectedProfiles(target, current, 'api')).toEqual(['web']);
  });

  it('目标版本里没有的服务 → 列入影响面（回滚会把它移除）', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'api@sha256:old' }]);
    const current = ver('dv_new', [{ profileId: 'api', artifactImage: 'api@sha256:new' }, { profileId: 'worker', artifactImage: 'w@sha256:x' }]);
    expect(promoteAffectedProfiles(target, current, 'api')).toEqual(['worker']);
  });

  it('runtimeCommand / containerPort 任一不同也算改动', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'a@sha256:1' }, { profileId: 'web', artifactImage: 'w@sha256:1', runtimeCommand: 'node old.js' }]);
    const current = ver('dv_new', [{ profileId: 'api', artifactImage: 'a@sha256:2' }, { profileId: 'web', artifactImage: 'w@sha256:1', runtimeCommand: 'node new.js' }]);
    expect(promoteAffectedProfiles(target, current, 'api')).toEqual(['web']);
    const target2 = ver('dv_old', [{ profileId: 'api', artifactImage: 'a@sha256:1' }, { profileId: 'web', artifactImage: 'w@sha256:1', containerPort: 3000 }]);
    const current2 = ver('dv_new', [{ profileId: 'api', artifactImage: 'a@sha256:2' }, { profileId: 'web', artifactImage: 'w@sha256:1', containerPort: 8080 }]);
    expect(promoteAffectedProfiles(target2, current2, 'api')).toEqual(['web']);
  });

  it('当前版本不可得（无 currentVersionId）→ 目标版本里所有其他服务都算影响面（fail-closed）', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'a@sha256:1' }, { profileId: 'web', artifactImage: 'w@sha256:1' }]);
    expect(promoteAffectedProfiles(target, undefined, 'api')).toEqual(['web']);
  });

  it('单服务分支 → 无影响面，promote 语义与旧行为一致', () => {
    const target = ver('dv_old', [{ profileId: 'api', artifactImage: 'a@sha256:1' }]);
    const current = ver('dv_new', [{ profileId: 'api', artifactImage: 'a@sha256:2' }]);
    expect(promoteAffectedProfiles(target, current, 'api')).toEqual([]);
  });
});
