import { describe, expect, it } from 'vitest';

import {
  buildStandbyMirrorFingerprint,
  buildStandbyBranchConfiguration,
  compareStandbyFingerprints,
  planStandbyBranchSync,
  percentile,
  limitStandbySyncActions,
  assertStandbyFingerprint,
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
    id: 'demo-main', branch: 'main', projectId: 'demo', status: 'running', githubCommitSha: input.commit || 'a'.repeat(40),
    services: { api: { profileId: 'api', status: 'running', sourceCommitSha: input.commit || 'a'.repeat(40) } },
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
  it('validates full peer shapes and the requested project before comparison', () => {
    const valid = fingerprint({}); expect(() => assertStandbyFingerprint(valid, 'demo')).not.toThrow();
    for (const invalid of [{ protocolVersion: 1 }, { ...valid, projectId: 'another' }, { ...valid, branches: null },
      { ...valid, branches: [{ ...valid.branches[0], commitSha: 'short' }] }, { ...valid, configHash: null }]) {
      expect(() => assertStandbyFingerprint(invalid, 'demo')).toThrow('指纹');
    }
  });
  it('requires the declared default branch identity and stable running state as well as equal commits', () => {
    const source = fingerprint({}), target = fingerprint({});
    expect(compareStandbyFingerprints(source, target).defaultBranchMatches).toBe(true);
    expect(compareStandbyFingerprints(source, { ...target, defaultBranch: 'develop' }).defaultBranchMatches).toBe(false);
    expect(compareStandbyFingerprints(source, { ...target, branches: target.branches.map(branch => ({ ...branch, status: 'error' })) }).defaultBranchMatches).toBe(false);
  });
  it('normalizes GitHub transport forms without treating another host as the same repository', () => {
    const source = fingerprint({});
    for (const repository of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git']) {
      expect(compareStandbyFingerprints(source, { ...fingerprint({}), repository }).repositoryMatches).toBe(true);
    }
    expect(compareStandbyFingerprints(source, { ...fingerprint({}), repository: 'https://another.invalid/owner/repo.git' }).repositoryMatches).toBe(false);
  });
  it('does not expose repository URL credentials in a peer fingerprint', () => {
    const result = buildStandbyMirrorFingerprint({ projectId: 'demo', repository: 'https://synthetic-user:synthetic-pass@github.com/owner/repo.git',
      defaultBranch: 'main', profiles: [], env: {}, infra: [], routingRules: [], branches: [] });
    expect(result.repository).toBe('github.com/owner/repo');
    expect(JSON.stringify(result)).not.toContain('synthetic-user'); expect(JSON.stringify(result)).not.toContain('synthetic-pass');
  });
  it('fingerprints the immutable running revision and rejects a contradictory webhook head', () => {
    const result = buildStandbyMirrorFingerprint({ projectId: 'demo', repository: 'owner/repo', defaultBranch: 'main', profiles: [], env: {}, infra: [], routingRules: [],
      branches: [{ id: 'main', branch: 'main', status: 'running', githubCommitSha: 'a'.repeat(40), services: {
        api: { profileId: 'api', status: 'running', deployedImage: `ghcr.io/fixture/api:sha-${'b'.repeat(40)}@sha256:${'c'.repeat(64)}` },
      } } as any] });
    expect(result.branches[0].commitSha).toBe('b'.repeat(40));
    expect(result.branches[0].commitIdentityConfirmed).toBe(false);
  });
  it('hashes portable infrastructure rather than allocated runtime ports and status', () => {
    const input = { projectId: 'demo', repository: 'owner/repo', defaultBranch: 'main', profiles: [], env: {}, routingRules: [], branches: [] };
    const service = { id: 'cache', name: 'Cache', dockerImage: 'redis:7', containerPort: 6379, env: {}, volumes: [] };
    const source = buildStandbyMirrorFingerprint({ ...input, infra: [{ ...service, hostPort: 12345, containerName: 'source-cache', status: 'running', createdAt: '2026-01-01' } as any] });
    const target = buildStandbyMirrorFingerprint({ ...input, infra: [{ ...service, hostPort: 23456, containerName: 'target-cache', status: 'idle', errorMessage: 'historical error', createdAt: '2026-01-02' } as any] });
    expect(source.configHash).toBe(target.configHash);
  });
  it('includes effective database isolation in both portable identity and local condition', () => {
    const branch = { id: 'feature', branch: 'feature', status: 'idle', githubCommitSha: 'a'.repeat(40) } as BranchEntry;
    const input = { profiles: [{ id: 'api', name: 'API', workDir: '.', dockerImage: 'node', containerPort: 8080,
      dbScope: 'shared' } as BuildProfile], branch, env: { MONGODB_URL: 'mongodb://synthetic.invalid/app' }, infra: [], routingRules: [] };
    const shared = buildStandbyBranchConfiguration(input);
    const isolated = buildStandbyBranchConfiguration({ ...input, branch: { ...branch, profileOverrides: { api: { dbScope: 'per-branch' } } } });
    const clone = buildStandbyBranchConfiguration({ ...input, branch: { ...branch, profileOverrides: { api: { dbScope: 'per-branch', dbInit: 'clone' } } } });
    expect(shared.configHash).not.toBe(isolated.configHash); expect(shared.configurationRevision).not.toBe(isolated.configurationRevision);
    expect(isolated.configHash).not.toBe(clone.configHash); expect(isolated.configurationRevision).not.toBe(clone.configurationRevision);
  });
  it('keeps declared image templates portable across different branch runtime identities', () => {
    const profiles = [{ id: 'api', name: 'API', workDir: '.', containerPort: 8080, prebuiltImage: true,
      dockerImage: 'ghcr.io/fixture/api:sha-${CDS_COMMIT_SHA}', fallbackImage: ['ghcr.io/fixture/api:branch-${CDS_BRANCH_SLUG}'] } as BuildProfile];
    const input = { projectId: 'demo', defaultBranch: 'main', profiles, env: {}, infra: [], routingRules: [] };
    const branch = { id: 'main', branch: 'main', status: 'idle', githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40) } as BranchEntry;
    const source = buildStandbyMirrorFingerprint({ ...input, branches: [branch] });
    const target = buildStandbyMirrorFingerprint({ ...input, branches: [{ ...branch, githubCommitSha: 'b'.repeat(40), ciTargetSha: 'b'.repeat(40) }] });
    const empty = buildStandbyMirrorFingerprint({ ...input, branches: [] });
    expect(source.configHash).toBe(target.configHash); expect(source.configHash).toBe(empty.configHash);
    expect(source.branches[0].configHash).toBe(target.branches[0].configHash);
    expect(source.branches[0].commitSha).not.toBe(target.branches[0].commitSha);
  });
  it('compares logical storage across sites while the local condition detects owner and secret changes without disclosure', () => {
    const configured = (instanceId: string, secret: string) => ({ profiles: [{ id: 'api', name: 'API', dockerImage: 'node', containerPort: 8080,
      cacheMounts: [{ kind: 'volume', hostPath: `${instanceId}-volume`, containerPath: '/data', storage: { version: 1, purpose: 'persistent', instanceId,
        projectId: `${instanceId}-project`, scope: 'branch-private', branchId: `${instanceId}-branch`, serviceId: 'api', mountKey: 'data' } }] } as BuildProfile],
      env: { API_TOKEN: secret }, infra: [], routingRules: [] });
    const input = configured('source', 'synthetic-source-secret'); const before = structuredClone(input);
    const source = buildStandbyBranchConfiguration(input), repeated = buildStandbyBranchConfiguration(input);
    const target = buildStandbyBranchConfiguration(configured('target', 'synthetic-target-secret'));
    expect(source.configHash).toBe(target.configHash); expect(source.secretKeyHash).toBe(target.secretKeyHash);
    expect(source.configurationRevision).toBe(repeated.configurationRevision);
    expect(source.configurationRevision).not.toBe(target.configurationRevision);
    expect(source.configurationRevision).not.toBe(buildStandbyBranchConfiguration(configured('source', 'synthetic-changed-secret')).configurationRevision);
    expect(input).toEqual(before); expect(JSON.stringify(source)).not.toContain('synthetic-source-secret');
  });
  it('different secret values also remain portable inside the generated source fallback profile', () => {
    const build = (secret: string) => buildStandbyMirrorFingerprint({ projectId: 'demo', defaultBranch: 'main', env: {}, infra: [], routingRules: [], branches: [],
      profiles: [{ id: 'api', name: 'API', dockerImage: 'node', command: 'node app.js', containerPort: 8080, activeDeployMode: 'express', env: { API_TOKEN: secret },
        deployModes: { express: { prebuilt: true, dockerImage: 'ghcr.io/fixture/api:sha-a' }, source: { prebuilt: false, dockerImage: 'node:22' } } } as BuildProfile] });
    expect(build('synthetic-source-secret').configHash).toBe(build('synthetic-target-secret').configHash);
  });
  it.each(['override', 'extra', 'branch-env'])('includes effective default branch %s configuration in its fingerprint', change => {
    const branch = { id: 'main', branch: 'main', status: 'idle', githubCommitSha: 'a'.repeat(40), services: {} } as any;
    const input = { projectId: 'demo', repository: 'owner/repo', defaultBranch: 'main', profiles: [{ id: 'api', name: 'API', dockerImage: 'node', command: 'node original.js', containerPort: 8080 } as BuildProfile], env: {}, infra: [], routingRules: [] };
    const source = buildStandbyMirrorFingerprint({ ...input, branches: [branch] });
    const target = buildStandbyMirrorFingerprint({ ...input, branches: [{ ...branch,
      ...(change === 'override' ? { profileOverrides: { api: { command: 'node changed.js' } } }
        : change === 'extra' ? { extraProfiles: [{ id: 'extra', name: 'Extra', dockerImage: 'nginx', containerPort: 80 }] } : {}) }],
      ...(change === 'branch-env' ? { env: { BRANCH_PUBLIC_SETTING: 'changed' } } : {}) });
    expect(source.configHash).not.toBe(target.configHash);
  });
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
  it('the action budget keeps every create/deploy pair whole', () => {
    const actions = Array.from({ length: 51 }, (_, index) => [
      { kind: 'create' as const, name: `branch-${index}`, sourceStatus: 'running', sourceCommit: 'a'.repeat(40), reason: 'fixture' },
      { kind: 'deploy' as const, name: `branch-${index}`, sourceStatus: 'running', sourceCommit: 'a'.repeat(40), reason: 'fixture' },
    ]).flat();
    const limited = limitStandbySyncActions(actions, 99);
    expect(limited).toHaveLength(98);
    for (const name of new Set(limited.map(action => action.name))) expect(limited.filter(action => action.name === name).map(action => action.kind)).toEqual(['create', 'deploy']);
  });
  function withBranches(items: Array<{ id: string; name: string; status: string; commit: string }>) {
    const base = fingerprint({ includeBranch: false });
    return {
      ...base,
      branches: items.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        commitSha: item.commit,
        configHash: base.configHash,
        secretKeyHash: base.secretKeyHash,
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
