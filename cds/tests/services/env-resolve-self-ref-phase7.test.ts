/**
 * Bugbot regression(PR #521)— env 解析三场景同时 work:
 *   1. B16 自引用:profile.env.X="${X}" 时,resolve 应拿 customEnv.X 真值
 *   2. profile-local:URL=${HOST}:${PORT},HOST/PORT 在 isolatedEnv 应可查
 *   3. per-branch isolation:isolatedEnv.CDS_POSTGRES_DB="app_feat_login"
 *      (Phase 5 修改的)不应被 customEnv 的 'app' 覆盖回去
 *
 * 第三场景是 Bugbot 第三轮抓到的 — 之前 fix 用 `{...isolatedEnv, ...customEnv}`
 * 满足 1+2 但破坏 3(per-branch 隔离失效)。正解:isolatedEnv 是真值源,
 * 仅当 isolatedEnv[k] 是字面量 "${k}" 自引用时,才回退到 customEnv。
 */
import { describe, it, expect } from 'vitest';
import { resolveEnvTemplates } from '../../src/services/compose-parser.js';

/**
 * 重现 container.ts 的 vars 源构建逻辑,跟生产代码同步演进。
 * 提取成 helper,让测试和实现在同一份逻辑上,避免 drift。
 */
function buildResolveVars(
  isolatedEnv: Record<string, string>,
  customEnv: Record<string, string> | undefined,
): Record<string, string> {
  const resolveVars: Record<string, string> = { ...isolatedEnv };
  if (customEnv) {
    for (const [k, v] of Object.entries(isolatedEnv)) {
      if (v === `\${${k}}` && customEnv[k] !== undefined) {
        resolveVars[k] = customEnv[k];
      }
    }
  }
  return resolveVars;
}

describe('Bugbot regression — env resolve 三场景同时 work', () => {
  it('场景 1 — B16 自引用:profile.env.X="${X}" 应拿 customEnv.X 真值', () => {
    const customEnv = {
      PG_DATABASE_URL: 'postgresql://user:pass@db:5432/app',
    };
    // profile.env 显式写 ${PG_DATABASE_URL} 自引用 → 进 isolatedEnv 后是字面量
    const isolatedEnv = {
      PG_DATABASE_URL: '${PG_DATABASE_URL}',
      OTHER_KEY: 'static',
    };
    const resolveVars = buildResolveVars(isolatedEnv, customEnv);
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.PG_DATABASE_URL).toBe('postgresql://user:pass@db:5432/app');
    expect(out.OTHER_KEY).toBe('static');
  });

  it('场景 2 — profile-local:URL=${HOST}:${PORT}, HOST/PORT 只在 isolatedEnv', () => {
    const customEnv = { SMTP_USER: 'mailer' };
    const isolatedEnv = {
      HOST: 'redis',
      PORT: '6379',
      URL: '${HOST}:${PORT}',
    };
    const resolveVars = buildResolveVars(isolatedEnv, customEnv);
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.URL).toBe('redis:6379');
  });

  it('场景 3 — per-branch isolation 不被 customEnv 覆盖回去(Bugbot 第三轮)', () => {
    // 模拟 Phase 8.8 + Phase 5 联动:cdscli 注入 customEnv.CDS_POSTGRES_DB='app',
    // 然后 dbScope=per-branch 把 isolatedEnv.CDS_POSTGRES_DB 改成 app_feat_login
    const customEnv = {
      CDS_POSTGRES_USER: 'postgres',
      CDS_POSTGRES_PASSWORD: 'secret',
      CDS_POSTGRES_DB: 'app',  // 原始值
      CDS_DATABASE_URL: 'postgresql://${CDS_POSTGRES_USER}:${CDS_POSTGRES_PASSWORD}@postgres:5432/${CDS_POSTGRES_DB}',
    };
    const isolatedEnv = {
      ...customEnv,
      CDS_POSTGRES_DB: 'app_feat_login',  // ← Phase 5 isolation 改的
    };
    const resolveVars = buildResolveVars(isolatedEnv, customEnv);
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    // 关键断言:URL 必须解析到 isolated 的 app_feat_login,不是 customEnv 的 app
    expect(out.CDS_DATABASE_URL).toContain('/app_feat_login');
    expect(out.CDS_DATABASE_URL).not.toContain('/app?'); // 没退回 'app'
    expect(out.CDS_DATABASE_URL).not.toMatch(/\/app$/);  // 没退回 'app'
    // 真实期待值
    expect(out.CDS_DATABASE_URL).toBe('postgresql://postgres:secret@postgres:5432/app_feat_login');
    expect(out.CDS_POSTGRES_DB).toBe('app_feat_login');
  });

  it('混合:三场景同时存在,各自正确解析', () => {
    const customEnv = {
      PG_DATABASE_URL: 'postgresql://real:pass@db:5432/app',
      CDS_POSTGRES_DB: 'app',
    };
    const isolatedEnv = {
      // 场景 1:自引用 customEnv
      PG_DATABASE_URL: '${PG_DATABASE_URL}',
      // 场景 2:profile-local
      HOST: 'redis',
      PORT: '6379',
      REDIS_URL: '${HOST}:${PORT}',
      // 场景 3:per-branch isolation 修改的
      CDS_POSTGRES_DB: 'app_feat',
      CDS_DATABASE_URL: 'postgresql://x:y@db:5432/${CDS_POSTGRES_DB}',
    };
    const resolveVars = buildResolveVars(isolatedEnv, customEnv);
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.PG_DATABASE_URL).toBe('postgresql://real:pass@db:5432/app');
    expect(out.REDIS_URL).toBe('redis:6379');
    expect(out.CDS_DATABASE_URL).toBe('postgresql://x:y@db:5432/app_feat');
    expect(out.CDS_POSTGRES_DB).toBe('app_feat');
  });

  it('customEnv 为空时退化(纯 isolatedEnv 行为)', () => {
    const isolatedEnv = { HOST: 'redis', URL: '${HOST}' };
    const resolveVars = buildResolveVars(isolatedEnv, undefined);
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.URL).toBe('redis');
  });
});
