import { describe, expect, it } from 'vitest';

import {
  buildStandbyMirrorFingerprint,
  compareStandbyFingerprints,
  planStandbyBranchSync,
  percentile,
} from '../../src/services/standby-mirror.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

function fingerprint(input: {
  secret?: string;
  includeSecret?: boolean;
  commit?: string;
  includeBranch?: boolean;
}) {
  const profile = { id: 'api', name: 'API', workDir: '.', containerPort: 8080 } as BuildProfile;
  const branch = {
    id: 'demo-main', branch: 'main', projectId: 'demo', status: 'running', githubCommitSha: input.commit || 'a'.repeat(40), services: {},
  } as unknown as BranchEntry;
  return buildStandbyMirrorFingerprint({
    projectId: 'demo',
    repository: 'owner/repo',
    defaultBranch: 'main',
    profiles: [profile],
    env: input.includeSecret === false ? { PUBLIC_NAME: 'demo' } : { PUBLIC_NAME: 'demo', API_TOKEN: input.secret || 'source-secret' },
    infra: [],
    routingRules: [],
    branches: input.includeBranch === false ? [] : [branch],
    generatedAt: '2026-09-30T00:00:00.000Z',
  });
}

describe('standby mirror fingerprint', () => {
  it('不同站点使用不同密钥值时仍判定配置一致，响应也不含明文', () => {
    const source = fingerprint({ secret: 'source-secret' });
    const target = fingerprint({ secret: 'target-secret' });
    expect(source.configHash).toBe(target.configHash);
    expect(source.secretKeyHash).toBe(target.secretKeyHash);
    expect(compareStandbyFingerprints(source, target).repositoryMatches).toBe(true);
    expect(JSON.stringify(source)).not.toContain('source-secret');
    expect(JSON.stringify(target)).not.toContain('target-secret');
  });

  it('目标漏配密钥项时明确判定不一致', () => {
    const result = compareStandbyFingerprints(
      fingerprint({}),
      fingerprint({ includeSecret: false }),
    );
    expect(result.secretKeysMatch).toBe(false);
    expect(result.configMatches).toBe(false);
  });

  it('主分支提交不一致时阻止切流，并给出差异', () => {
    const result = compareStandbyFingerprints(
      fingerprint({ commit: 'a'.repeat(40) }),
      fingerprint({ commit: 'b'.repeat(40) }),
    );
    expect(result.defaultBranchMatches).toBe(false);
    expect(result.divergentBranches).toEqual([{ name: 'main', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }]);
  });

  it('目标缺少分支时列入缺失清单', () => {
    const result = compareStandbyFingerprints(fingerprint({}), fingerprint({ includeBranch: false }));
    expect(result.defaultBranchMatches).toBe(false);
    expect(result.missingBranches).toEqual(['main']);
  });
});

describe('percentile', () => {
  it('按排序样本计算 p50 与 p95', () => {
    const samples = [10, 40, 20, 30];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBeNull();
  });
});

describe('standby branch sync plan', () => {
  function withBranches(items: Array<{ id: string; name: string; status: string; commit: string }>) {
    const base = fingerprint({ includeBranch: false });
    return {
      ...base,
      branches: items.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        commitSha: item.commit,
      })),
    };
  }

  it('catalog 只补缺失分支，不启动、不停止、不删除目标独有分支', () => {
    const source = withBranches([
      { id: 'source-main', name: 'main', status: 'running', commit: 'a' },
      { id: 'source-feature', name: 'feature/a', status: 'idle', commit: 'b' },
    ]);
    const target = withBranches([
      { id: 'target-main', name: 'main', status: 'running', commit: 'a' },
      { id: 'target-local', name: 'local/debug', status: 'running', commit: 'c' },
    ]);
    expect(planStandbyBranchSync(source, target, 'catalog')).toEqual([expect.objectContaining({
      name: 'feature/a',
      kind: 'create',
    })]);
  });

  it('warm-running 对齐运行状态，但提交分叉只报告不覆盖', () => {
    const source = withBranches([
      { id: 's-main', name: 'main', status: 'running', commit: 'a' },
      { id: 's-idle', name: 'idle', status: 'idle', commit: 'b' },
      { id: 's-new', name: 'new', status: 'running', commit: 'c' },
      { id: 's-diverged', name: 'diverged', status: 'running', commit: 'd1' },
    ]);
    const target = withBranches([
      { id: 't-main', name: 'main', status: 'idle', commit: 'a' },
      { id: 't-idle', name: 'idle', status: 'running', commit: 'b' },
      { id: 't-diverged', name: 'diverged', status: 'idle', commit: 'd2' },
    ]);
    expect(planStandbyBranchSync(source, target, 'warm-running')).toEqual([
      expect.objectContaining({ name: 'main', targetBranchId: 't-main', kind: 'deploy' }),
      expect.objectContaining({ name: 'idle', targetBranchId: 't-idle', kind: 'stop' }),
      expect.objectContaining({ name: 'new', kind: 'create' }),
      expect.objectContaining({ name: 'new', kind: 'deploy' }),
      expect.objectContaining({ name: 'diverged', targetBranchId: 't-diverged', kind: 'divergent' }),
    ]);
  });

  it('audit-only 永远不产生写操作', () => {
    expect(planStandbyBranchSync(
      withBranches([{ id: 's-main', name: 'main', status: 'running', commit: 'a' }]),
      withBranches([]),
      'audit-only',
    )).toEqual([]);
  });
});
