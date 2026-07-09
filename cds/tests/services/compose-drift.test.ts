/**
 * 波4 漂移巡检 —— classifyEnvSeed(seed 级权威) + computeComposeDrift(纯函数大脑)。
 */
import { describe, it, expect } from 'vitest';
import { classifyEnvSeed } from '../../src/services/config-authority.js';
import { computeComposeDrift, type LiveComposeSnapshot } from '../../src/services/compose-drift.js';
import type { CdsComposeConfig } from '../../src/services/compose-parser.js';

function emptyLive(over: Partial<LiveComposeSnapshot> = {}): LiveComposeSnapshot {
  return {
    buildProfileIds: [],
    profileCommands: {},
    infraServiceIds: [],
    routingRuleIds: [],
    envKeys: [],
    ...over,
  };
}

function mkRepo(over: Partial<CdsComposeConfig> = {}): CdsComposeConfig {
  return {
    buildProfiles: [],
    envVars: {},
    envMeta: {},
    infraServices: [],
    routingRules: [],
    ...over,
  } as CdsComposeConfig;
}

describe('classifyEnvSeed (seed 级权威)', () => {
  it('占位符值一律归 CDS env scope(D1 元凶)', () => {
    const r = classifyEnvSeed('TENCENT_COS_BUCKET', 'TODO: 请填写实际值');
    expect(r.belonging).toBe('cds-env-scope');
    expect(r.isPlaceholder).toBe(true);
    expect(r.isSecret).toBe(false); // BUCKET 不含密钥关键词
  });

  it('密钥类即便携带真实值也归 CDS env scope(禁泄密/穿透)', () => {
    const r = classifyEnvSeed('JWT_SECRET', 'a-real-value');
    expect(r.belonging).toBe('cds-env-scope');
    expect(r.isSecret).toBe(true);
    expect(r.isPlaceholder).toBe(false);
  });

  it('密钥类 + 占位符(双重命中)归 CDS env scope', () => {
    const r = classifyEnvSeed('AI_ACCESS_KEY', 'TODO: 请填写实际值');
    expect(r.belonging).toBe('cds-env-scope');
    expect(r.isSecret).toBe(true);
    expect(r.isPlaceholder).toBe(true);
  });

  it('非密钥结构默认值归 repo 权威(种子)', () => {
    expect(classifyEnvSeed('ASSETS_PROVIDER', 'tencentCos').belonging).toBe('repo-structural');
    expect(classifyEnvSeed('TENCENT_COS_PREFIX', 'data').belonging).toBe('repo-structural');
  });
});

describe('computeComposeDrift', () => {
  it('无 repo compose → hasRepoCompose=false, 不建议同步', () => {
    const report = computeComposeDrift(null, emptyLive());
    expect(report.hasRepoCompose).toBe(false);
    expect(report.syncRecommended).toBe(false);
    expect(report.secretsInRepo).toEqual([]);
  });

  it('repo 携带密钥/占位符键 → 报应剥离违规(secretsInRepo)', () => {
    const repo = mkRepo({
      envVars: {
        ASSETS_PROVIDER: 'tencentCos',
        JWT_SECRET: 'TODO: 请填写实际值',
        AI_ACCESS_KEY: 'TODO: 请填写实际值',
      },
    });
    const report = computeComposeDrift(repo, emptyLive({ envKeys: ['ASSETS_PROVIDER'] }));
    const keys = report.secretsInRepo.map((s) => s.key).sort();
    expect(keys).toEqual(['AI_ACCESS_KEY', 'JWT_SECRET']);
    // 结构默认键 ASSETS_PROVIDER 已存在于 live,不算漂移
    expect(report.structuralDrift.addedStructuralEnvKeys).toEqual([]);
  });

  it('repo 新增 profile/infra/route/结构env → 结构漂移 + 建议同步', () => {
    const repo = mkRepo({
      buildProfiles: [
        { id: 'api', name: 'api', dockerImage: 'node:20', workDir: '/app', containerPort: 3000, command: 'npm start' },
      ],
      infraServices: [{ id: 'mongodb' } as any],
      routingRules: [{ id: 'r1', name: 'r1', type: 'domain', match: 'x', branch: 'main', priority: 1, enabled: true }],
      envVars: { NEW_STRUCT_KEY: 'hello' },
    });
    const report = computeComposeDrift(repo, emptyLive());
    expect(report.structuralDrift.addedProfiles).toEqual(['api']);
    expect(report.structuralDrift.addedInfra).toEqual(['mongodb']);
    expect(report.structuralDrift.addedRoutes).toEqual(['r1']);
    expect(report.structuralDrift.addedStructuralEnvKeys).toEqual(['NEW_STRUCT_KEY']);
    expect(report.syncRecommended).toBe(true);
  });

  it('两侧同 profile 但命令不同 → changedProfileCommands', () => {
    const repo = mkRepo({
      buildProfiles: [
        { id: 'api', name: 'api', dockerImage: 'node:20', workDir: '/app', containerPort: 3000, command: 'npm run start:v2' },
      ],
    });
    const live = emptyLive({ buildProfileIds: ['api'], profileCommands: { api: 'npm start' } });
    const report = computeComposeDrift(repo, live);
    expect(report.structuralDrift.changedProfileCommands).toEqual(['api']);
    expect(report.structuralDrift.addedProfiles).toEqual([]);
    expect(report.syncRecommended).toBe(true);
  });

  it('CDS 独占的 env 键 → cdsOwnedOnly,绝不回写 repo,且不触发同步', () => {
    const repo = mkRepo({ envVars: { ASSETS_PROVIDER: 'tencentCos' } });
    const live = emptyLive({ envKeys: ['ASSETS_PROVIDER', 'RUNTIME_ONLY_KEY'] });
    const report = computeComposeDrift(repo, live);
    expect(report.cdsOwnedOnly.envKeysOnlyInLive).toEqual(['RUNTIME_ONLY_KEY']);
    expect(report.syncRecommended).toBe(false);
  });

  it('repo 不再声明 CDS 现存 profile → removedProfiles(仅报告,不自动删)', () => {
    const repo = mkRepo({ buildProfiles: [] });
    const live = emptyLive({ buildProfileIds: ['legacy-api'] });
    const report = computeComposeDrift(repo, live);
    expect(report.structuralDrift.removedProfiles).toEqual(['legacy-api']);
    // 删除破坏性,不计入「建议同步」自动开单
    expect(report.syncRecommended).toBe(false);
  });
});
