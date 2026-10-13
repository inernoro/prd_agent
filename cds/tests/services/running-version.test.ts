import { describe, it, expect } from 'vitest';
import { runningCommitSha, branchVersionFacts } from '../../src/services/running-version.js';
import type { BranchEntry, DeploymentVersion } from '../../src/types.js';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const branch = (extra = {}) => ({ id: 'lab-main', projectId: 'lab', status: 'running', githubCommitSha: B, ciTargetSha: B, ciImageStatus: 'failed', currentVersionId: 'vA', services: { web: { profileId: 'web', status: 'running', deployedImage: `ghcr.io/test/lab:sha-${A}` } }, ...extra }) as unknown as BranchEntry;
const version = { id: 'vA', projectId: 'lab', branchId: 'lab-main', commitSha: A, profiles: [{ profileId: 'web', artifactImage: 'managed:immutable-A' }] } as DeploymentVersion;
describe('运行版本只由真实产物证明', () => {
  it('失败推送 B 不会冒充运行 A，API 同时给出目标 B', () => {
    expect(branchVersionFacts(branch())).toEqual({ runningCommitSha: A, targetCommitSha: B });
  });
  it('回滚到 A 后即使仓库仍 B 也只显示 A', () => {
    expect(runningCommitSha(branch({ ciImageStatus: 'ready' }), version)).toBe(A);
  });
  it('源码产物使用匹配的不可变版本，未知产物不回退到目标', () => {
    const b = branch({ services: { web: { profileId: 'web', status: 'running', deployedImage: 'managed:immutable-A' } } });
    expect(runningCommitSha(b, version)).toBe(A);
    expect(runningCommitSha(b)).toBeUndefined();
    expect(runningCommitSha(b, { ...version, branchId: 'other' })).toBeUndefined();
  });
  it('服务分别运行 A/B 时分支不谎报统一版本，服务角标各取自身', () => {
    const b = branch();
    b.services.api = { ...b.services.web, profileId: 'api', deployedImage: `ghcr.io/test/lab:sha-${B}` };
    expect(runningCommitSha(b)).toBeUndefined();
    expect(runningCommitSha(b, undefined, 'web')).toBe(A);
    expect(runningCommitSha(b, undefined, 'api')).toBe(B);
  });
  it('停止后保留历史镜像不代表还在运行，缺证据保持未知', () => {
    const b = branch(); b.services.web.status = 'stopped';
    expect(runningCommitSha(b, version)).toBeUndefined();
    b.services.web.status = 'running'; b.services.web.deployedImage = 'latest';
    expect(runningCommitSha(b, version)).toBeUndefined();
  });
});
