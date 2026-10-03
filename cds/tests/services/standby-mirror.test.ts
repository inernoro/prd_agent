import { describe, expect, it } from 'vitest';

import {
  buildStandbyMirrorFingerprint,
  compareStandbyFingerprints,
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
