import { describe, it, expect } from 'vitest';
import {
  resolveProfileRuntimeEnvWithProvenance,
  missingEnvTemplates,
  type EnvLayer,
} from '../../src/services/env-provenance.js';

/*
 * env-provenance 单测(波2 配置检查器核心)。
 *
 * 两个目标:
 *  1. 溯源语义:last-writer-wins + shadowed 链 + platform-injected/per-branch-db 打标 + templated
 *  2. 行为等价:单层调用(部署路径的包装方式)输出与旧 container.ts#resolveProfileRuntimeEnv
 *     行为一致 —— 步骤顺序/条件/异常消息逐条钉死
 */

const BRANCH = {
  branch: 'claude/feat-x',
  githubCommitSha: 'abc123def4567890',
  lastPushAt: '2026-07-06T08:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const OPTS = { jwtIssuer: 'cds-issuer' };

function envOf(layers: EnvLayer[], profileLayers: EnvLayer[] = [], profile: { dockerImage: string; dbScope?: 'shared' | 'per-branch' } = { dockerImage: 'img' }) {
  return resolveProfileRuntimeEnvWithProvenance(BRANCH, profile, layers, profileLayers, OPTS);
}

function prov(result: ReturnType<typeof envOf>, key: string) {
  return result.provenance.find((p) => p.key === key);
}

describe('resolveProfileRuntimeEnvWithProvenance — 溯源语义', () => {
  it('last-writer-wins:靠后层覆盖靠前层,shadowed 记录被覆盖来源链', () => {
    const r = envOf([
      { source: 'global', env: { FOO: 'from-global', ONLY_GLOBAL: 'g' } },
      { source: 'project', env: { FOO: 'from-project' } },
      { source: 'branch', env: { FOO: 'from-branch' } },
    ]);
    expect(r.env.FOO).toBe('from-branch');
    expect(prov(r, 'FOO')).toMatchObject({ source: 'branch', shadowed: ['global', 'project'] });
    expect(prov(r, 'ONLY_GLOBAL')).toMatchObject({ source: 'global' });
    expect(prov(r, 'ONLY_GLOBAL')?.shadowed).toBeUndefined();
  });

  it('JWT 兜底:JWT_SECRET 存在且无 Jwt__Secret 时映射,打 platform-injected/jwt-fallback', () => {
    const r = envOf([{ source: 'project', env: { JWT_SECRET: 's3cret' } }]);
    expect(r.env['Jwt__Secret']).toBe('s3cret');
    expect(prov(r, 'Jwt__Secret')).toMatchObject({ source: 'platform-injected', detail: 'jwt-fallback' });
    expect(r.env['Jwt__Issuer']).toBe('cds-issuer');
    expect(prov(r, 'Jwt__Issuer')).toMatchObject({ source: 'platform-injected', detail: 'jwt-fallback' });
  });

  it('JWT 兜底只看段A:profile.env 的 Jwt__Secret 在兜底之后合并,最终覆盖兜底值', () => {
    const r = envOf(
      [{ source: 'project', env: { JWT_SECRET: 'custom-secret' } }],
      [{ source: 'profile', env: { Jwt__Secret: 'profile-wins' } }],
    );
    expect(r.env['Jwt__Secret']).toBe('profile-wins');
    expect(prov(r, 'Jwt__Secret')).toMatchObject({ source: 'profile', shadowed: ['platform-injected'] });
  });

  it('node 容器注入 PNPM_HOME / PATH,非 node 镜像不注入', () => {
    const node = envOf([], [], { dockerImage: 'node:20-slim' });
    expect(node.env['PNPM_HOME']).toBe('/pnpm');
    expect(node.env['PATH']).toContain('/pnpm:');
    expect(prov(node, 'PNPM_HOME')).toMatchObject({ source: 'platform-injected', detail: 'node-runtime' });
    const plain = envOf([], [], { dockerImage: 'nginx:alpine' });
    expect(plain.env['PNPM_HOME']).toBeUndefined();
  });

  it('profile 层拆分:baseline → branch-override → deploy-mode,靠后覆盖并记 shadow', () => {
    const r = envOf(
      [],
      [
        { source: 'extra-service', env: { MODE: 'standalone', KEEP: 'x' } },
        { source: 'branch-override', env: { MODE: 'cluster' } },
        { source: 'deploy-mode', env: { MODE: 'prod' } },
      ],
    );
    expect(r.env.MODE).toBe('prod');
    expect(prov(r, 'MODE')).toMatchObject({
      source: 'deploy-mode',
      shadowed: ['extra-service', 'branch-override'],
    });
    expect(prov(r, 'KEEP')).toMatchObject({ source: 'extra-service' });
  });

  it('版本元数据强制覆盖 profile env,打 version-metadata', () => {
    const r = envOf([], [{ source: 'profile', env: { GIT_COMMIT: 'user-set' } }]);
    expect(r.env['GIT_COMMIT']).toBe('abc123def4567890');
    expect(prov(r, 'GIT_COMMIT')).toMatchObject({
      source: 'platform-injected',
      detail: 'version-metadata',
      shadowed: ['profile'],
    });
    expect(r.env['VITE_BUILD_ID']).toBe('abc123def456');
    expect(r.env['VITE_GIT_BRANCH']).toBe('claude/feat-x');
    expect(r.env['CDS_BUILD_TIME']).toBe('2026-07-06T08:00:00.000Z');
  });

  it('per-branch DB 改写:dbScope=per-branch 的库名 key 打 per-branch-db,原来源进 shadowed', () => {
    const r = envOf(
      [{ source: 'project', env: { MYSQL_DATABASE: 'app' } }],
      [],
      { dockerImage: 'img', dbScope: 'per-branch' },
    );
    expect(r.env['MYSQL_DATABASE']).toBe('app_claude_feat_x');
    expect(prov(r, 'MYSQL_DATABASE')).toMatchObject({
      source: 'per-branch-db',
      detail: 'per-branch-db-suffix',
      shadowed: ['project'],
    });
  });

  it('dbScope=shared 不改写库名', () => {
    const r = envOf(
      [{ source: 'project', env: { MYSQL_DATABASE: 'app' } }],
      [],
      { dockerImage: 'img', dbScope: 'shared' },
    );
    expect(r.env['MYSQL_DATABASE']).toBe('app');
    expect(prov(r, 'MYSQL_DATABASE')).toMatchObject({ source: 'project' });
  });

  it('${VAR} 模板展开后打 templated,值来自展开结果', () => {
    const r = envOf([
      { source: 'project', env: { CDS_MYSQL_PORT: '13306', DB_URL: 'mysql://host:${CDS_MYSQL_PORT}/app' } },
    ]);
    expect(r.env['DB_URL']).toBe('mysql://host:13306/app');
    expect(prov(r, 'DB_URL')).toMatchObject({ source: 'project', templated: true });
    expect(prov(r, 'CDS_MYSQL_PORT')?.templated).toBeUndefined();
  });

  it('缺失模板值抛错,消息与旧实现一字不差', () => {
    expect(() => envOf([
      { source: 'project', env: { DB_URL: 'mysql://host:${NOT_DEFINED_ANYWHERE_XYZ}/app' } },
    ])).toThrow('环境变量模板缺少值: NOT_DEFINED_ANYWHERE_XYZ。请在项目环境变量中填写，或先启动对应基础设施服务后再部署。');
  });
});

describe('resolveProfileRuntimeEnvWithProvenance — 与旧部署路径行为等价(单层包装)', () => {
  it('复合场景:customEnv + profile.env + JWT + node + per-branch + 模板,env 输出与旧实现手算一致', () => {
    // 旧实现语义手算:
    //   merged = {...customEnv}                                 → JWT_SECRET/MYSQL_DATABASE/CDS_MYSQL_PORT/DB_URL
    //   Jwt__Secret = JWT_SECRET(无 Jwt__Secret)                → 's'
    //   Jwt__Issuer = issuer                                    → 'cds-issuer'
    //   node: PNPM_HOME=/pnpm, npm_config_store_dir, PATH 前缀   → 注入
    //   profile.env 合并                                         → EXTRA=1 且覆盖 CDS_MYSQL_PORT=23306
    //   版本元数据                                                → GIT_COMMIT 等
    //   per-branch: MYSQL_DATABASE=app_claude_feat_x
    //   模板展开: DB_URL 用 23306(profile 覆盖后的值)
    const customEnv = {
      JWT_SECRET: 's',
      MYSQL_DATABASE: 'app',
      CDS_MYSQL_PORT: '13306',
      DB_URL: 'mysql://h:${CDS_MYSQL_PORT}/${MYSQL_DATABASE}',
    };
    const r = resolveProfileRuntimeEnvWithProvenance(
      BRANCH,
      { dockerImage: 'node:20', dbScope: 'per-branch' },
      [{ source: 'project', env: customEnv }],
      [{ source: 'profile', env: { EXTRA: '1', CDS_MYSQL_PORT: '23306' } }],
      OPTS,
    );
    expect(r.env).toMatchObject({
      JWT_SECRET: 's',
      Jwt__Secret: 's',
      Jwt__Issuer: 'cds-issuer',
      PNPM_HOME: '/pnpm',
      npm_config_store_dir: '/pnpm/store',
      EXTRA: '1',
      CDS_MYSQL_PORT: '23306',
      MYSQL_DATABASE: 'app_claude_feat_x',
      DB_URL: 'mysql://h:23306/app_claude_feat_x',
      GIT_COMMIT: 'abc123def4567890',
      VITE_BUILD_ID: 'abc123def456',
    });
    expect(r.env['PATH']).toMatch(/^\/pnpm:/);
  });

  it('自引用模板保留 customEnv 真值(resolveVars 兼容语义)', () => {
    // 旧实现:isolatedEnv 里 v === '${K}' 且 customEnv 有 K → resolveVars 用 customEnv 值。
    // profile.env 把 K 覆盖成字面模板 '${K}' 时,展开结果应回落到 customEnv 的真值。
    const r = resolveProfileRuntimeEnvWithProvenance(
      BRANCH,
      { dockerImage: 'img' },
      [{ source: 'project', env: { TOKEN: 'real-token' } }],
      [{ source: 'profile', env: { TOKEN: '${TOKEN}' } }],
      OPTS,
    );
    expect(r.env['TOKEN']).toBe('real-token');
  });

  it('空输入:无 customEnv 无 profile.env 时只有平台注入项', () => {
    const r = envOf([]);
    expect(Object.keys(r.env).sort()).toEqual([
      'CDS_BUILD_TIME', 'COMMIT_SHA', 'GITHUB_SHA', 'GIT_COMMIT', 'Jwt__Issuer',
      'SOURCE_VERSION', 'VITE_BUILD_ID', 'VITE_GIT_BRANCH',
    ].sort().concat(['CDS_COMMIT_SHA']).sort());
  });
});

describe('missingEnvTemplates(从 container.ts 迁来的 SSOT)', () => {
  it('识别缺失模板、忽略有默认值/env 内可解析/process.env 存在的', () => {
    expect(missingEnvTemplates({ A: '${MISSING_XYZ_123}' })).toEqual(['MISSING_XYZ_123']);
    expect(missingEnvTemplates({ A: '${B}', B: 'x' })).toEqual([]);
    expect(missingEnvTemplates({ A: '${MISSING_XYZ_123:-default}' })).toEqual([]);
    expect(missingEnvTemplates({ A: 'no-template' })).toEqual([]);
  });
});
